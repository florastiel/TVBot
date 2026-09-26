// The streamer: a throwaway user account that sits in voice and Go Live streams the
// channel. Controlled by the bot over local HTTP (see src/local.js).
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { RichPresence } from "./presence.js";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@lng2004/discord.js-selfbot-v13";
import { Streamer, playStream } from "@dank074/discord-video-stream";
import { config, secrets, ENTRANCE_DIR, DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { Plex } from "../plex.js";
import { rd } from "../realdebrid.js";
import { PLAYER_PORT, localSecret } from "../local.js";
import { Feed } from "./feed.js";
import { playMic } from "./mic.js";
import { cleanSpool } from "./spool.js";
import { makeProgram } from "./program.js";
import { removeFromBlock } from "../schedule/store.js";
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
    this.viewers = null;
    this.restartPending = false;
  }

  async start() {
    this.plex = new Plex();
    await this.plex.connect().catch((e) => log.warn(`player: Plex not reachable yet (${e.message}); will retry when needed`));
    this.streamer = new Streamer(new Client());
    // The Go Live thumbnail. The library offers a new one at every keyframe (every few
    // seconds); the Discord app itself sends one every few minutes, so only pass those on.
    const setPreview = this.streamer.setStreamPreview.bind(this.streamer);
    this.lastPreview = 0;
    this.streamer.setStreamPreview = async (image) => {
      if (Date.now() - this.lastPreview < config.player.stream_preview_minutes * 60000) return;
      this.lastPreview = Date.now();
      await setPreview(image).catch((e) => log.warn(`player: couldn't update the stream preview: ${e.message}`));
    };
    await this.streamer.client.login(secrets.streamerToken);
    log.info(`player: logged in as ${this.streamer.client.user.tag}`);
    this.streamer.client.on("voiceStateUpdate", (before, after) => this.onVoiceState(before, after));
    // Who is actually watching the Go Live: Discord tells the streamer in STREAM_CREATE /
    // STREAM_UPDATE events (viewer_ids).
    this.streamer.client.on("raw", (p) => {
      if (p?.t !== "STREAM_CREATE" && p?.t !== "STREAM_UPDATE") return;
      const ids = p.d?.viewer_ids;
      if (!Array.isArray(ids)) return;
      const me = this.streamer.client.user.id;
      const n = ids.filter((id) => id !== me).length;
      if (n !== this.viewers) log.info(`player: ${n} watching the stream`);
      this.viewers = n;
    });
    this.presence = new RichPresence(this.streamer.client);
    setInterval(() => this.checkIdle(), 30000).unref();
    cleanSpool();
    this.serve();
    await this.resumeAfterRestart();
  }

  status() {
    return { state: this.state, channelId: this.channelId, now: publicSeg(this.now), pid: process.pid, inChannel: this.people(), viewers: this.viewers ?? null };
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
    this.viewers = null;
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
    this.lastPreview = 0; // a fresh Go Live gets its thumbnail right away
    const streamPreview = config.player.stream_preview_minutes > 0;
    playStream(feed.output, this.streamer, { type: "go-live", streamPreview }, abort.signal)
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
    this.presence.paused();
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
      if (!seg.input && seg.rdLink) {
        // Real-Debrid item that wasn't downloaded ahead: get a direct URL now.
        try {
          seg = { ...seg, input: await rd().unrestrict(seg.rdLink) };
        } catch (e) {
          log.warn(`player: ${seg.title} ${seg.subtitle || ""}: Real-Debrid link failed (${e.message}); skipping it`);
          failures++;
          await sleep(Math.min(30000, 1000 * failures));
          continue;
        }
      }
      if (inBreak && seg.breakId !== inBreak) {
        this.emitEvent("break-end", { breakId: inBreak });
        inBreak = null;
      }
      if (seg.breakId && !inBreak) {
        // A restart was asked for: use this commercial break for it instead of ads.
        if (this.restartPending) return this.restartNow();
        inBreak = seg.breakId;
        const endsAt = Date.now() + (seg.breakTotalMs ?? 0) - (seg.breakAtMs ?? 0);
        this.emitEvent("break-start", { breakId: inBreak, endsAt, nextTitle: seg.nextTitle ?? null });
        this.presence.commercials({ endsAt, nextTitle: seg.nextTitle });
      }
      this.now = seg;
      const isShow = seg.kind === "episode" || seg.kind === "movie" || seg.kind === "short";
      if (isShow) this.emitEvent("show", { show: publicSeg(seg), upNext: publicSeg(seg.upNext) });
      if (isShow) this.presence.show(seg);
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

  // Admin skip: drops the rest of the current show or movie (all its remaining pieces),
  // takes it out of the schedule, and cuts to what's next.
  skipItem() {
    const s = this.session;
    if (!s) return false;
    const seg = this.now;
    if (seg && (seg.kind === "episode" || seg.kind === "movie" || seg.kind === "short")) {
      s.program?.skipItem?.(seg.itemId);
      if (seg.blockId) removeFromBlock(seg.blockId, seg.itemId);
      log.info(`player: skipped ${seg.title} ${seg.subtitle || ""}`.trim());
    }
    return s.feed.skip();
  }

  // Admin skip of the whole block: everything still to come in it is dropped (and taken
  // off the schedule), and the rest of the day moves up to the next quarter hour.
  skipBlock() {
    const s = this.session;
    const r = s?.program?.skipBlock?.();
    if (!r) return false;
    for (const id of r.ids) removeFromBlock(r.blockId, id);
    if (this.now?.breakId) s.skippedBreaks.add(this.now.breakId);
    log.info(`player: skipped the rest of the block (${r.ids.length} item(s))`);
    return s.feed.skip();
  }

  async leave(reason) {
    if (this.state === "off") return this.status();
    this.stopStream();
    this.state = "off";
    const channelId = this.channelId;
    this.channelId = null;
    try { this.streamer.leaveVoice(); } catch { /* already gone */ }
    log.info(`player: left voice (${reason})`);
    this.presence.clear();
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
    // Ended outright: process.exit() once hung for 2 minutes (native video-library
    // teardown) and the channel sat dead until the bot's watchdog killed the process.
    // The resume file is already written; the service manager restarts on any exit.
    setTimeout(() => { try { process.kill(process.pid, "SIGKILL"); } catch { /* fall through */ } process.exit(0); }, 500);
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

  // People (not bots, not the TV itself) in the TV's voice channel, from the server's
  // voice states.
  people() {
    if (!this.channelId) return 0;
    const me = this.streamer.client.user.id;
    const guild = this.streamer.client.channels.cache.get(this.channelId)?.guild
      || this.streamer.client.guilds.cache.get(config.discord.guild_id);
    if (!guild) return 1; // can't tell: assume someone's there
    return guild.voiceStates.cache.filter((v) => v.channelId === this.channelId && v.id !== me && !v.member?.user?.bot).size;
  }

  // Leaves after idle_leave_minutes with nobody in the channel, or nobody watching the
  // stream (when Discord says who's watching).
  checkIdle() {
    if (this.state !== "on" && this.state !== "paused") { this.idleSince = null; return; }
    const people = this.people();
    const watching = this.viewers ?? people;
    if (people > 0 && watching > 0) {
      this.idleSince = null;
    } else {
      this.idleSince ??= Date.now();
      if (Date.now() - this.idleSince >= config.broadcast.idle_leave_minutes * 60000) {
        this.leave(people ? "nobody watching the stream" : "nobody in the channel");
      }
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
      "POST /skip-block": () => ({ skipped: this.skipBlock() }),
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
