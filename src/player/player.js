// The streamer: a throwaway user account that sits in voice and Go Live streams the
// channel. Controlled by the bot over local HTTP (see src/local.js).
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@lng2004/discord.js-selfbot-v13";
import { Streamer, playStream } from "@dank074/discord-video-stream";
import { config, secrets, DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { Plex } from "../plex.js";
import { PLAYER_PORT, localSecret } from "../local.js";
import { Feed } from "./feed.js";
import { playMic, prepareSound } from "./mic.js";
import { PlaylistProgram } from "./program.js";

export const ENTRANCE_DIR = join(DATA_DIR, "entrances");
const guildId = () => config.discord.guild_id || process.env.GUILD_ID;

// What the bot is allowed to see about a segment (never the input URL: it has a token).
const publicSeg = (s) => s && { itemId: s.itemId, kind: s.kind, title: s.title, subtitle: s.subtitle, breakId: s.breakId };

export class Player extends EventEmitter {
  constructor() {
    super();
    this.state = "off"; // off | starting | on
    this.channelId = null;
    this.now = null;
    this.session = null; // { feed, abort, skippedBreaks }
    this.micQueue = Promise.resolve();
    this.idleSince = null;
  }

  async start() {
    this.plex = new Plex();
    await this.plex.connect().catch((e) => log.warn(`player: Plex not reachable yet (${e.message}); will retry when needed`));
    this.streamer = new Streamer(new Client());
    await this.streamer.client.login(secrets.streamerToken);
    log.info(`player: logged in as ${this.streamer.client.user.tag}`);
    this.streamer.client.on("voiceStateUpdate", (before, after) => this.onVoiceState(before, after));
    setInterval(() => this.checkIdle(), 30000).unref();
    if (this.jingle()) await prepareSound(this.jingle()).catch((e) => log.warn(`player: jingle not usable: ${e.message}`));
    this.serve();
  }

  status() {
    return { state: this.state, channelId: this.channelId, now: publicSeg(this.now) };
  }

  emitEvent(type, data = {}) {
    this.emit("event", { type, ...data, status: this.status() });
  }

  async join(channelId) {
    if (this.state !== "off" && this.channelId === channelId) return this.status();
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

    // The first show starts encoding right away (it just buffers), while the jingle
    // plays; then a short pause so Discord's own "went live" sound doesn't step on it.
    const feed = new Feed();
    const abort = new AbortController();
    const session = { feed, abort, skippedBreaks: new Set() };
    this.session = session;
    this.state = "on";
    feed.on("closed", () => session === this.session && this.leave("stream stopped"));
    this.run(session).catch((e) => {
      log.error("player: playback loop crashed:", e);
      if (session === this.session) this.leave("error");
    });
    this.emitEvent("on");

    (async () => {
      if (this.jingle()) {
        await this.mic(this.jingle());
        await sleep(config.entrance.tv_join_pause_seconds * 1000);
      }
      if (session !== this.session) return;
      await playStream(feed.output, this.streamer, { type: "go-live" }, abort.signal);
    })()
      .catch((e) => !abort.signal.aborted && log.warn(`player: stream ended: ${e.message}`))
      .finally(() => session === this.session && this.leave("stream stopped"));
    return this.status();
  }

  jingle() {
    const f = config.entrance.tv_join_sound;
    return f && existsSync(f) ? f : null;
  }

  async run(session) {
    const program = new PlaylistProgram(this.plex);
    let inBreak = null;
    let failures = 0;
    for (const seg of program.segments()) {
      if (session !== this.session) return;
      if (seg.breakId && session.skippedBreaks.has(seg.breakId)) continue;
      if (inBreak && seg.breakId !== inBreak) {
        this.emitEvent("break-end", { breakId: inBreak });
        inBreak = null;
      }
      if (seg.breakId && !inBreak) {
        inBreak = seg.breakId;
        this.emitEvent("break-start", { breakId: inBreak });
      }
      this.now = seg;
      if (!seg.breakId) this.emitEvent("show", { show: publicSeg(seg), upNext: publicSeg(seg.upNext) });
      log.info(`player: ${seg.breakId ? "break" : "now"}: ${seg.title} ${seg.subtitle || ""}`.trim());

      const r = await session.feed.play(seg);
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
    const s = this.session;
    this.session = null;
    this.state = "off";
    const channelId = this.channelId;
    this.channelId = null;
    this.now = null;
    s?.abort.abort();
    s?.feed.close();
    try { this.streamer.stopStream(); } catch { /* already stopped */ }
    try { this.streamer.leaveVoice(); } catch { /* already gone */ }
    log.info(`player: left voice (${reason})`);
    this.emitEvent("off", { reason, channelId });
    return this.status();
  }

  // Sounds over the mic, one at a time. Resolves when this one has finished.
  mic(file) {
    this.micQueue = this.micQueue
      .then(() => playMic(this.streamer, file))
      .catch((e) => log.warn(`player: mic sound failed: ${e.message}`));
    return this.micQueue;
  }

  onVoiceState(before, after) {
    const me = this.streamer.client.user.id;
    if (this.state === "off") return;
    // Kicked, disconnected, or dragged to another channel: stop cleanly.
    if (after.id === me) {
      if (after.channelId !== this.channelId && this.state === "on") this.leave(after.channelId ? "moved by someone" : "disconnected");
      return;
    }
    // Someone arrived: play their entrance sound if they have one.
    if (after.channelId === this.channelId && before.channelId !== this.channelId && this.state === "on") {
      const f = existsSync(ENTRANCE_DIR) && readdirSync(ENTRANCE_DIR).find((n) => n.startsWith(`${after.id}.`));
      if (f) this.mic(join(ENTRANCE_DIR, f));
    }
  }

  checkIdle() {
    if (this.state !== "on") return;
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
      "POST /skip-break": (b) => ({ skipped: this.skipBreak(b.breakId) }),
      "POST /skip-item": () => ({ skipped: this.skipItem() }),
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
