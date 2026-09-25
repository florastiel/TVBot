// One continuous video feed for a whole TV session. Items are encoded one after
// another by short-lived ffmpeg processes and spliced into a single long-lived
// "outer" ffmpeg, whose output is what Go Live streams.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { itemArgs, outerArgs, usingQsv, encoderState } from "./encode.js";
import { log } from "../log.js";

const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const TS_PACKET = 188;
const CUSHION = 16 * 1024 * 1024; // ~40 s of 720p video held ahead of what's playing

// Highest PES timestamp (seconds) in a run of whole TS packets, or -1. Lets the feed
// know exactly where the stream's clock is, instead of trusting ffmpeg's progress
// report, which lags behind what it has actually written.
function maxPts(buf) {
  let max = -1;
  for (let i = 0; i + TS_PACKET <= buf.length; i += TS_PACKET) {
    if (buf[i] !== 0x47 || !(buf[i + 1] & 0x40)) continue; // not a payload start
    const afc = (buf[i + 3] >> 4) & 3;
    let p = i + 4 + (afc & 2 ? 1 + buf[i + 4] : 0);
    if (!(afc & 1) || p + 14 > i + TS_PACKET) continue;
    if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1 || !(buf[p + 7] & 0x80)) continue;
    p += 9;
    const pts = (buf[p] >> 1 & 7) * 2 ** 30 + (buf[p + 1] << 22 | (buf[p + 2] >> 1) << 15 | buf[p + 3] << 7 | buf[p + 4] >> 1);
    max = Math.max(max, pts / 90000);
  }
  return max;
}

export class Feed extends EventEmitter {
  constructor() {
    super();
    this.offsetSec = 0;
    this.current = null;
    this.closed = false;
    this.outer = spawn(FFMPEG(), outerArgs(), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.outer.stderr.on("data", (d) => log.warn(`feed(outer): ${String(d).trim()}`));
    this.outer.stdin.on("error", () => {}); // EPIPE when it dies; reported via "exit"
    this.outer.on("exit", (code) => {
      this.closed = true;
      this.current?.proc.kill("SIGKILL");
      this.emit("closed", code);
    });
    this.output = this.outer.stdout;
  }

  // Encode one segment into the feed. Resolves when it finishes, is skipped, or fails:
  // { result: "done" | "skipped" | "error", playedSec }
  //
  // The encoder runs faster than real time; up to CUSHION bytes of its output are held
  // here and written to the stream as it plays. That rides out the Plex server dropping
  // the connection every ~100 MB (ffmpeg reconnects, which takes a second or two).
  play(seg) {
    if (this.closed) return Promise.resolve({ result: "error", playedSec: 0 });
    const startOffset = this.offsetSec;
    const proc = spawn(FFMPEG(), itemArgs(seg, startOffset), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const cur = { proc, skipped: false, lastPts: -1, queue: [], queued: 0, waiting: false, exited: false, code: 0, finish: null };
    this.current = cur;

    let errText = "";
    proc.stderr.on("data", (d) => {
      errText = (errText + String(d)).slice(-4000);
    });

    const done = new Promise((resolve) => { cur.finish = resolve; });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (this.current === cur) this.current = null;
      // Continue the next item's clock just after the last frame actually written.
      // A tiny gap is invisible; an overlap would make the joiner drop frames.
      const playedSec = Math.max(0, cur.lastPts - startOffset);
      if (cur.lastPts >= 0) this.offsetSec = cur.lastPts + 0.1;
      if (cur.skipped || this.closed) return cur.finish({ result: "skipped", playedSec });
      if (cur.code !== 0 && cur.lastPts < 0 && usingQsv() && /qsv|mfx|encoder/i.test(errText)) { // only when the GPU encoder itself failed
        // Nothing came out and we're on Quick Sync: assume the GPU encoder is the
        // problem, switch this process to CPU encoding, and try the item again.
        log.warn(`feed: Quick Sync failed (${errText.trim().split("\n").slice(-1)[0]}); switching to CPU encoding`);
        encoderState.qsvBroken = true;
        return cur.finish(this.play(seg));
      }
      if (cur.code !== 0) {
        log.warn(`feed: item failed (exit ${cur.code}) after ${playedSec.toFixed(1)}s: ${errText.trim().split("\n").slice(-3).join(" | ")}`);
        return cur.finish({ result: "error", playedSec });
      }
      cur.finish({ result: "done", playedSec });
    };
    cur.finishNow = finish;

    // Write queued output to the stream at the pace it plays (outer's backpressure).
    const pump = () => {
      if (cur.waiting) return;
      while (cur.queue.length && !cur.skipped && !this.closed) {
        const c = cur.queue.shift();
        cur.queued -= c.buf.length;
        if (c.pts > cur.lastPts) cur.lastPts = c.pts;
        if (cur.queued < CUSHION / 2 && proc.stdout.isPaused()) proc.stdout.resume();
        if (!this.outer.stdin.write(c.buf)) {
          cur.waiting = true;
          this.outer.stdin.once("drain", () => { cur.waiting = false; pump(); });
          return;
        }
      }
      if (cur.exited && !cur.queue.length) finish();
    };

    // Only queue whole 188-byte TS packets, so killing an item mid-write (skip)
    // never hands the outer ffmpeg half a packet.
    let carry = Buffer.alloc(0);
    proc.stdout.on("data", (chunk) => {
      if (cur.skipped || this.closed) return;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % TS_PACKET);
      carry = buf.subarray(whole);
      if (!whole) return;
      const out = Buffer.from(buf.subarray(0, whole));
      cur.queue.push({ buf: out, pts: maxPts(out) });
      cur.queued += out.length;
      if (cur.queued > CUSHION) proc.stdout.pause();
      pump();
    });

    proc.on("exit", (code) => {
      cur.exited = true;
      cur.code = code ?? 0;
      if (cur.skipped || this.closed) return finish();
      pump(); // finishes once the queue has been written
    });
    return done;
  }

  skip() {
    const cur = this.current;
    if (!cur) return false;
    cur.skipped = true;
    cur.queue = []; // drop whatever of it hasn't been shown yet
    cur.proc.kill("SIGKILL");
    if (cur.exited) cur.finishNow();
    return true;
  }

  close() {
    this.closed = true;
    this.current?.proc.kill("SIGKILL");
    this.outer.stdin.end();
    setTimeout(() => this.outer.kill("SIGKILL"), 2000).unref();
  }
}
