// The streamer: a throwaway user account that sits in voice and Go Live streams the
// channel. Controlled by the bot over local HTTP (see src/local.js).
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@lng2004/discord.js-selfbot-v13";
import { Streamer, playStream } from "@dank074/discord-video-stream";
import { config, secrets, ENTRANCE_DIR, DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { Plex } from "../plex.js";
import { PLAYER_PORT, localSecret } from "../local.js";
import { Feed } from "./feed.js";
import { playMic } from "./mic.js";
import { makeProgram } from "./program.js";
import { card } from "./segments.js";

const guildId = () => config.discord.guild_id || process.env.GUILD_ID;
// Written just before a restart so the fresh copy goes back to the same channel.
const RESUME_FILE = join(DATA_DIR, "resume.json");

// What the bot is allowed to see about a segment (never the input URL: it has a token).
const publicSeg = (s) => s && { itemId: s.itemId, kind: s.kind, title: s.title, subtitle: s.subtitle, breakId: s.breakId };

export class Player extends EventEmitter {
  constructor() {
    super();
    this.state = "off"; // off | starting | on | paused
    this.channelId = null;
    this.now = null;
    this.session = null; // the running stream: { feed, abort, skippedBreaks, t0 }
    this.micQueue = Promise.resolve();
    this.idleSince = null;
    this.restartPending = false;
  }

  async start() {
    this.plex = new Plex();
    await this.plex.connect().catch((e) => log.warn(`player: Plex not reachable yet (${e.message}); will retry when needed`));
    this.streamer = new Streamer(new Client());
    await this.streamer.client.login(secrets.streamerToken);
    log.info(`player: logged in as ${this.streamer.client.user.tag}`);
    this.streamer.client.on("voiceStateUpdate", (before, after) => this.onVoiceState(before, after));
    setInterval(() => this.checkIdle(), 30000).unref();
    this.serve();
    await this.resumeAfterRestart();
  }

  status() {
    return { state: this.state, channelId: this.channelId, now: publicSeg(this.now), pid: process.pid };
  }

  emitEvent(type, data = {}) {
    this.emit("event", { type, ...data, status: this.status() });
  }

  async join(channelId, { paused = false } = {}) {
    if (this.state !== "off" && this.channelId === channelId) {
      if (this.state === "paused") return this.resume();
      return this.status();
    }
    if (this.state !== "off") await this.leave("moved");
    this.state = "starting";
    this.channelId = channelId;
    this.idleSince = null;
    try {
      if (!this.plex.base) await this.plex.connect();
      await this.streamer.joinVoice(guildId(), channelId);
    } catch (e) {
      this.state = "off";
      this.channelId = null;
      throw e;
    }
    log.info(`player: joined voice ${channelId}`);
    this.startStream();
    if (paused) {
      this.state = "paused";
      this.session.paused = true;
      this.emitEvent("paused");
      return this.status();
    }
    this.emitEvent("on");
    return this.status();
  }

  // Start Go Live with whatever is on right now.
  startStream() {
    const feed = new Feed();
    const abort = new AbortController();
    // t0: the wall-clock time the stream's first frame plays (Go Live takes a moment to
    // set up); corrected when the stream really starts.
    const session = { feed, abort, skippedBreaks: new Set(), t0: Date.now() + 2000, paused: false, replay: null };
    this.session = session;
    this.state = "on";
    feed.on("closed", () => session === this.session && this.leave("stream stopped"));
    this.run(session).catch((e) => {
      log.error("player: playback loop crashed:", e);
      if (session === this.session) this.leave("error");
    });
    session.t0 = Date.now() + 1000;
    playStream(feed.output, this.streamer, { type: "go-live" }, abort.signal)
      .catch((e) => !abort.signal.aborted && log.warn(`player: stream ended: ${e.message}`))
      .finally(() => session === this.session && this.leave("stream stopped"));
  }

  // Stop Go Live but stay in the voice channel.
  stopStream() {
    const s = this.session;
    this.session = null;
    this.now = null;
    s?.abort.abort();
    s?.feed.close();
    try { this.streamer.stopStream(); } catch { /* already stopped */ }
  }

  // Emergency pause: the show is cut off at once and a silent "Paused" card runs
  // instead; the Go Live stays up, so nobody has to click Watch again.
  pause() {
    const s = this.session;
    if (this.state !== "on" || !s) return this.status();
    this.state = "paused";
    s.paused = true;
    s.pausing = true;
    s.feed.skip();
    log.info("player: paused");
    this.emitEvent("paused");
    if (this.restartPending) this.restartNow(); // nothing to interrupt while paused
    return this.status();
  }

  // Picks up exactly where it was paused. The channel is now running late; the
  // schedule catches up by cutting commercial breaks (see ScheduleProgram).
  resume() {
    if (this.state !== "paused" || !this.session) return this.status();
    this.state = "on";
    this.session.paused = false;
    log.info("player: resumed");
    this.emitEvent("on");
    return this.status();
  }

  // Forget any delay and jump to what the schedule says is on right now.
  goLive() {
    const s = this.session;
    if (!s) return this.status();
    s.replay = null;
    s.program?.goLive?.();
    if (this.state === "paused") this.resume();
    s.feed.skip();
    log.info("player: back to the schedule");
    return this.status();
  }

  async run(session) {
    // Wall-clock time at which the next segment will start playing.
    const clock = () => session.t0 + session.feed.offsetSec * 1000;
    const program = makeProgram(this.plex, clock);
    session.program = program;
    const segments = program.segments();
    let inBreak = null;
    let failures = 0;
    for (;;) {
      if (session !== this.session) return;
      if (session.paused) {
        await session.feed.play(card("Paused", 3000));
        continue;
      }
      let seg = session.replay;
      session.replay = null;
      if (!seg) {
        const next = segments.next();
        if (next.done) return;
        seg = next.value;
      }
      if (seg.breakId && session.skippedBreaks.has(seg.breakId)) continue;
      if (inBreak && seg.breakId !== inBreak) {
        this.emitEvent("break-end", { breakId: inBreak });
        inBreak = null;
      }
      if (seg.breakId && !inBreak) {
        // A restart was asked for: use this commercial break for it instead of ads.
        if (this.restartPending) return this.restartNow();
        inBreak = seg.breakId;
        this.emitEvent("break-start", { breakId: inBreak });
      }
      this.now = seg;
      const isShow = seg.kind === "episode" || seg.kind === "movie";
      if (isShow) this.emitEvent("show", { show: publicSeg(seg), upNext: publicSeg(seg.upNext) });
      log.info(`player: ${seg.breakId ? "break" : "now"}: ${seg.title} ${seg.subtitle || ""}`.trim());

      const startedAt = clock();
      const r = await session.feed.play(seg);
      if (session.pausing) {
        // Cut off by a pause: a show is picked up again at the same second on resume.
        session.pausing = false;
        if (isShow) session.replay = { ...seg, seekMs: (seg.seekMs || 0) + Math.max(0, Date.now() - startedAt) };
        continue;
      }
      if (r.result === "error" && r.playedSec < 1) {
        // Broken file or server down: don't spin. Back off a little more each time.
        failures++;
        await sleep(Math.min(30000, 1000 * failures));
      } else {
        failures = 0;
      }
    }
  }

  skipBreak(breakId) {
    const s = this.session;
    if (!s || !this.now?.breakId || (breakId && this.now.breakId !== breakId)) return false;
    s.skippedBreaks.add(this.now.breakId);
    return s.feed.skip();
  }

  skipItem() {
    return this.session?.feed.skip() ?? false;
  }

  async leave(reason) {
    if (this.state === "off") return this.status();
    this.stopStream();
    this.state = "off";
    const channelId = this.channelId;
    this.channelId = null;
    try { this.streamer.leaveVoice(); } catch { /* already gone */ }
    log.info(`player: left voice (${reason})`);
    this.emitEvent("off", { reason, channelId });
    if (this.restartPending) this.restartNow();
    return this.status();
  }

  // Exit; the service manager starts a fresh copy about 10 seconds later, which goes
  // back into the same channel (see resumeAfterRestart).
  restartNow() {
    if (this.state !== "off" && this.channelId) {
      writeFileSync(RESUME_FILE, JSON.stringify({ channelId: this.channelId, paused: this.state === "paused", at: Date.now() }));
      this.emitEvent("restarting");
    }
    log.info("player: restarting to load new code/settings");
    setTimeout(() => process.exit(0), 500);
  }

  async resumeAfterRestart() {
    if (!existsSync(RESUME_FILE)) return;
    let r;
    try { r = JSON.parse(readFileSync(RESUME_FILE, "utf8")); } catch { /* unreadable: ignore */ }
    rmSync(RESUME_FILE, { force: true });
    if (!r?.channelId || Date.now() - r.at > 3 * 60000) return;
    log.info(`player: back after a restart; rejoining ${r.channelId}`);
    await this.join(r.channelId, { paused: r.paused }).catch((e) => log.warn(`player: couldn't rejoin: ${e.message}`));
  }

  // Sounds over the mic (entrance sounds), one at a time.
  mic(file) {
    this.micQueue = this.micQueue
      .then(() => playMic(this.streamer, file))
      .catch((e) => log.warn(`player: mic sound failed: ${e.message}`));
    return this.micQueue;
  }

  onVoiceState(before, after) {
    const me = this.streamer.client.user.id;
    const inVoice = this.state === "on" || this.state === "paused";
    if (!inVoice) return;
    // Kicked, disconnected, or dragged to another channel: stop cleanly.
    if (after.id === me) {
      if (after.channelId !== this.channelId) this.leave(after.channelId ? "moved by someone" : "disconnected");
      return;
    }
    // Someone arrived: play their entrance sound if they have one.
    if (after.channelId === this.channelId && before.channelId !== this.channelId) {
      const f = existsSync(ENTRANCE_DIR) && readdirSync(ENTRANCE_DIR).find((n) => n.startsWith(`${after.id}.`) && !n.endsWith(".tmp"));
      if (f) this.mic(join(ENTRANCE_DIR, f));
    }
  }

  checkIdle() {
    if (this.state !== "on" && this.state !== "paused") return;
    const ch = this.streamer.client.channels.cache.get(this.channelId);
    const me = this.streamer.client.user.id;
    const people = ch?.members?.filter((m) => m.id !== me && !m.user.bot).size ?? 1;
    if (people > 0) {
      this.idleSince = null;
    } else {
      this.idleSince ??= Date.now();
      if (Date.now() - this.idleSince >= config.broadcast.idle_leave_minutes * 60000) this.leave("nobody watching");
    }
  }

  serve() {
    const secret = localSecret();
    const clients = new Set();
    this.on("event", (e) => {
      for (const res of clients) res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 20000).unref();

    const routes = {
      "GET /status": () => this.status(),
      "POST /join": (b) => this.join(String(b.channelId)),
      "POST /leave": () => this.leave("turned off"),
      "POST /pause": () => this.pause(),
      "POST /resume": () => this.resume(),
      "POST /live": () => this.goLive(),
      "POST /skip-break": (b) => ({ skipped: this.skipBreak(b.breakId) }),
      "POST /skip-item": () => ({ skipped: this.skipItem() }),
      // Load new code/settings: right away if off or paused, otherwise at the next
      // commercial break (the TV comes back to the same channel by itself).
      "POST /restart": () => {
        this.restartPending = true;
        if (this.state === "off" || this.state === "paused") this.restartNow();
        return { restarting: this.state === "on" ? "at the next commercial break" : "now" };
      },
    };

    http.createServer(async (req, res) => {
      if (req.headers["x-tv-secret"] !== secret) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === "GET" && req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ type: "hello", status: this.status() })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const route = routes[`${req.method} ${req.url}`];
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const out = await route(body ? JSON.parse(body) : {});
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        log.warn(`player: ${req.url} failed: ${e.message}`);
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
      }
    }).listen(PLAYER_PORT, "127.0.0.1", () => log.info(`player: listening on 127.0.0.1:${PLAYER_PORT}`));
  }
}
