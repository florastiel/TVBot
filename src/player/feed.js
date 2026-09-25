// One continuous video feed for a whole TV session. Items are encoded one after
// another by short-lived ffmpeg processes and spliced into a single long-lived
// "outer" ffmpeg, whose output is what Go Live streams.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { itemArgs, outerArgs } from "./encode.js";
import { log } from "../log.js";

const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const TS_PACKET = 188;

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
  play(seg) {
    if (this.closed) return Promise.resolve({ result: "error", playedSec: 0 });
    const startOffset = this.offsetSec;
    const proc = spawn(FFMPEG(), itemArgs(seg, startOffset), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const cur = { proc, skipped: false, lastPts: -1 };
    this.current = cur;

    let errText = "";
    proc.stderr.on("data", (d) => {
      errText = (errText + String(d)).slice(-4000);
    });

    // Only forward whole 188-byte TS packets, so killing an item mid-write (skip)
    // never hands the outer ffmpeg half a packet.
    let carry = Buffer.alloc(0);
    proc.stdout.on("data", (chunk) => {
      if (cur.skipped || this.closed) return;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % TS_PACKET);
      carry = buf.subarray(whole);
      if (!whole) return;
      const out = buf.subarray(0, whole);
      cur.lastPts = Math.max(cur.lastPts, maxPts(out));
      if (!this.outer.stdin.write(out)) {
        proc.stdout.pause();
        this.outer.stdin.once("drain", () => proc.stdout.resume());
      }
    });

    return new Promise((resolve) => {
      proc.on("exit", (code) => {
        if (this.current === cur) this.current = null;
        // Continue the next item's clock just after the last frame actually forwarded.
        // A tiny gap is invisible; an overlap would make the joiner drop frames.
        const playedSec = Math.max(0, cur.lastPts - startOffset);
        if (cur.lastPts >= 0) this.offsetSec = cur.lastPts + 0.1;
        if (cur.skipped) return resolve({ result: "skipped", playedSec });
        if (code !== 0) {
          log.warn(`feed: item failed (exit ${code}) after ${playedSec.toFixed(1)}s: ${errText.trim().split("\n").slice(-3).join(" | ")}`);
          return resolve({ result: "error", playedSec });
        }
        resolve({ result: "done", playedSec });
      });
    });
  }

  skip() {
    if (!this.current) return false;
    this.current.skipped = true;
    this.current.proc.kill("SIGKILL");
    return true;
  }

  close() {
    this.closed = true;
    this.current?.proc.kill("SIGKILL");
    this.outer.stdin.end();
    setTimeout(() => this.outer.kill("SIGKILL"), 2000).unref();
  }
}
