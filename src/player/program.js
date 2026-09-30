// What's on. A "program" yields segments in order; the player just plays them.
//
// ScheduleProgram follows the saved schedule on the wall clock, like real TV: joining
// mid-block starts whatever is on right now at the right point. PlaylistProgram is a
// test override (tv.cmd playlist): it loops a few episodes, ignoring the clock.
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, config } from "../config.js";
import { getItem, toSegment, makeBreak, fillBreak, card } from "./segments.js";
import { wantSpool } from "./spool.js";
import { blockAt, nextBlockAfter, blocksBetween, usedIds, appendToBlock, shiftBlocks } from "../schedule/store.js";
import { inOrder, nextInOrder } from "../schedule/generate.js";
import { getDb } from "../db.js";
import { schedulableSql } from "../catalog/schedulable.js";
import { localTime } from "../schedule/time.js";
import { LONG_MS, breakTargetMs } from "../adload.js";

export const PLAYLIST_FILE = join(DATA_DIR, "playlist.json");

export function savePlaylist(ids) {
  writeFileSync(PLAYLIST_FILE, JSON.stringify({ ids }, null, 2));
}
export function clearPlaylist() {
  rmSync(PLAYLIST_FILE, { force: true });
}

// resume: { blockId, itemId, seekMs } from before a restart (see Player.restartNow).
export function makeProgram(plex, clock, resume = null) {
  return existsSync(PLAYLIST_FILE) ? new PlaylistProgram(plex) : new ScheduleProgram(plex, clock, resume);
}

// Loops the item ids in data/playlist.json with a commercial break after each show.
export class PlaylistProgram {
  constructor(plex) {
    this.plex = plex;
    this.ids = JSON.parse(readFileSync(PLAYLIST_FILE, "utf8")).ids;
    this.pos = 0;
  }

  *segments() {
    for (;;) {
      const row = getItem(this.ids[this.pos++ % this.ids.length]);
      if (!row) continue;
      const next = getItem(this.ids[this.pos % this.ids.length]);
      wantSpool([next], this.plex);
      yield { ...toSegment(row, this.plex), upNext: next ? toSegment(next, this.plex) : null };
      yield* makeBreak(this.plex);
    }
  }
}

const LOOKAHEAD_MS = 3 * 3600000; // how far ahead to download files that need it for subtitles
const MIN_LEFT = 20000; // don't join the last 20 seconds of a show; go to the next thing
const EDGE = 5 * 60000;  // never break within 5 minutes of the start/end of a show
const pieceMs = () => (Number(config.broadcast.piece_minutes) || 12) * 60000; // long shows and movies get a break about this often

// A movie's found break points can leave a long stretch with no break (a film with two
// fade-outs): split any stretch over 1.6 pieces into even pieces, at the chapter mark
// nearest each split (within a third of a piece) or right at it.
function subdivide(found, durationMs, cues) {
  const P = pieceMs(), gap = 4 * 60000;
  const edges = [0, ...found, durationMs], out = [...found];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1];
    if (b - a <= P * 1.6) continue;
    const k = Math.round((b - a) / P);
    for (let j = 1; j < k; j++) {
      const target = a + ((b - a) * j) / k;
      const near = cues.filter((c) => c > a + gap && c < b - gap && Math.abs(c - target) <= P / 3)
        .sort((x, y) => Math.abs(x - target) - Math.abs(y - target))[0];
      if (near != null) out.push(near);
      else if (config.broadcast.split_without_chapters) out.push(Math.round(target));
    }
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

// Cut items into pieces at their original commercial-break points (black + silence,
// found in download-ahead). Items without any: long ones (40+ minutes) in pieces of about
// broadcast.piece_minutes, at the chapter point nearest each cut (within a third of a
// piece), or right at it if the file has no chapters and split_without_chapters is on.
// Episodes get at most broadcast.episode_breaks breaks inside them (movies aren't limited,
// and get long stretches between their found break points cut up too).
export function planPieces(items) {
  const out = [];
  const cap = config.broadcast.episode_breaks;
  for (const r of items) {
    const limit = r.kind === "episode" ? cap : Infinity;
    if (limit <= 0) { out.push({ row: r, from: 0, to: r.duration_ms }); continue; }
    const cues = r.cues ? JSON.parse(r.cues) : [];
    let found = [];
    for (const c of (r.ad_cues ? JSON.parse(r.ad_cues) : []).filter((c) => c > 3 * 60000 && c < r.duration_ms - 3 * 60000)) {
      if (c - (found.at(-1) ?? 0) >= 3 * 60000) found.push(c);
    }
    if (found.length > limit) {
      // Keep the ones nearest evenly spaced points (one break: the one nearest the middle).
      const keep = new Set();
      for (let k = 1; k <= limit; k++) {
        const target = (r.duration_ms * k) / (limit + 1);
        keep.add(found.filter((c) => !keep.has(c)).reduce((x, c) => (Math.abs(c - target) < Math.abs(x - target) ? c : x)));
      }
      found = found.filter((c) => keep.has(c));
    }
    if (found.length) {
      if (r.kind !== "episode" && r.duration_ms >= LONG_MS) found = subdivide(found, r.duration_ms, cues);
      let from = 0;
      for (const c of found) { out.push({ row: r, from, to: c }); from = c; }
      out.push({ row: r, from, to: r.duration_ms });
      continue;
    }
    // A regular-length episode with a chapter mark near its middle (anime's Part A/B
    // eyecatch, which doesn't fade to black): one break there.
    if (r.duration_ms >= 18 * 60000 && r.duration_ms < 40 * 60000) {
      const mid = cues.filter((c) => c > r.duration_ms * 0.35 && c < r.duration_ms * 0.65)
        .sort((x, y) => Math.abs(x - r.duration_ms / 2) - Math.abs(y - r.duration_ms / 2))[0];
      if (mid) { out.push({ row: r, from: 0, to: mid }, { row: r, from: mid, to: r.duration_ms }); continue; }
    }
    const n = r.duration_ms >= LONG_MS ? Math.min(limit + 1, Math.max(1, Math.round(r.duration_ms / pieceMs()))) : 1;
    let from = 0;
    for (let k = 1; k < n; k++) {
      const target = (r.duration_ms * k) / n;
      const ok = cues.filter((c) => c > from + EDGE && c < r.duration_ms - EDGE && Math.abs(c - target) <= Math.min(10 * 60000, pieceMs() / 3));
      let cut = ok.length ? ok.reduce((x, c) => (Math.abs(c - target) < Math.abs(x - target) ? c : x)) : null;
      if (cut === null && config.broadcast.split_without_chapters && target > from + EDGE) cut = Math.round(target);
      if (cut === null) continue;
      out.push({ row: r, from, to: cut });
      from = cut;
    }
    out.push({ row: r, from, to: r.duration_ms });
  }
  return out;
}

export class ScheduleProgram {
  // clock(): wall-clock ms at which the next segment will start playing.
  constructor(plex, clock, resume = null) {
    this.plex = plex;
    this.clock = clock;
    this.resume = resume; // used once, for the first block, if it is still on
    this.skipped = new Set(); // item ids skipped for good (their remaining pieces are dropped)
  }

  // Drop the rest of this show/movie; the time it leaves gets other episodes.
  skipItem(itemId) {
    this.skipped.add(itemId);
  }

  // Drop everything still to come in the current block; the next block starts right
  // away. Returns what was dropped, for taking it off the schedule.
  skipBlock() {
    if (!this.block) return null;
    for (const id of this.blockRest) this.skipped.add(id);
    this.blockSkipped = this.block.id;
    return { blockId: this.block.id, ids: [...this.blockRest] };
  }

  // Drop any delay: the next segment is whatever the schedule says is on now.
  goLive() {
    this.live = true;
  }

  *segments() {
    let caughtUpFrom = null; // running late: the block to play next, from its start
    for (;;) {
      if (this.live) { this.live = false; caughtUpFrom = null; }
      const now = this.clock();
      // Behind schedule (after a pause): don't skip ahead; play the next block from
      // the top and let its commercial breaks shrink until the channel is on time.
      if (caughtUpFrom) {
        const block = caughtUpFrom;
        caughtUpFrom = null;
        const late = yield* this.playBlock(block, now, { fromStart: true });
        if (late) caughtUpFrom = late;
        continue;
      }
      const block = blockAt(now);
      if (!block) {
        // Off the air (or nothing scheduled): a card until the next block, a minute at a time.
        const next = nextBlockAfter(now);
        const wait = Math.max(5000, Math.min(60000, next ? next.start_at - now : 60000));
        yield card(next ? `Off the air\nBack at ${localTime(next.start_at)}` : "Off the air", wait);
        continue;
      }
      const before = this.clock();
      const resume = this.resume?.blockId === block.id ? this.resume : null;
      this.resume = null;
      const late = yield* this.playBlock(block, now, { resume });
      if (late) caughtUpFrom = late;
      // Safety net: a block that played nothing must still move the clock forward,
      // or this loop would spin forever.
      if (this.clock() === before && !this.live) yield card("", Math.max(1000, block.end_at - before));
    }
  }

  // Plays one block. Returns the next block if this one finished late and the schedule
  // couldn't move (a special comes next), so it can be played from its start.
  *playBlock(block, now, { fromStart = false, resume = null } = {}) {
    const items = block.items.filter((r) => r.present && r.playable);
    const nextBlock = nextBlockAfter(block.end_at);
    const pieces = planPieces(items);
    const upNextOf = (i) => pieces.slice(i + 1).find((p) => p.row.id !== pieces[i].row.id)?.row || nextBlock?.items[0] || null;
    const len = (p) => p.to - p.from;

    // Where "now" falls on the block's planned timeline: pieces with the planned
    // commercial time spread evenly after each.
    const total = pieces.reduce((n, p) => n + len(p), 0);
    const gap = pieces.length ? Math.max(0, (block.end_at - block.start_at - total) / pieces.length) : 0;
    let t = block.start_at;
    let start = fromStart ? 0 : pieces.length;
    let offsetMs = 0;
    for (let i = 0; !fromStart && i < pieces.length; i++) {
      const dur = len(pieces[i]);
      if (now < t + dur) {
        start = i;
        offsetMs = Math.max(0, now - t);
        if (dur - offsetMs < MIN_LEFT) { start = i + 1; offsetMs = 0; }
        break;
      }
      t += dur;
      if (now < t + gap) { start = i + 1; break; } // between pieces: straight to the next one
      t += gap;
    }

    // Back from a restart: the exact spot the old copy stopped at (a little before it, see
    // Player.restartNow), not where the wall clock says, which can differ by minutes.
    if (resume) {
      const at = pieces.findIndex((p) => p.row.id === resume.itemId && p.from <= resume.seekMs && resume.seekMs < p.to);
      if (at >= 0) { start = at; offsetMs = resume.seekMs - pieces[at].from; }
    }

    this.block = block;
    this.blockRest = new Set(pieces.slice(start).map((p) => p.row.id)); // not aired yet (incl. what's on)
    const titleOf = (row) => (row ? toSegment(row, this.plex).title : null);
    const before = (segs, row) => segs.map((s) => ({ ...s, nextTitle: titleOf(row) }));
    const breakEvery = config.broadcast.break_every_minutes * 60000;
    // Joined or restarted partway into a show: only the rest of it counts here, so a
    // break is due after it (otherwise the next show starts with no commercials at all).
    let sinceBreak = offsetMs > 0 || resume ? breakEvery : 0;

    for (let i = start; i < pieces.length; i++) {
      const p = pieces[i];
      if (this.skipped.has(p.row.id)) continue;
      this.blockRest = new Set(pieces.slice(i).map((q) => q.row.id));
      // Download ahead (in airing order) whatever airs in the next few hours and needs
      // it for subtitles, so even big movies are ready well before they start.
      const ahead = [...new Set(pieces.slice(i + 1).map((q) => q.row))];
      for (const b of blocksBetween(block.end_at, block.end_at + LOOKAHEAD_MS)) ahead.push(...b.items);
      wantSpool(ahead, this.plex);
      const up = upNextOf(i);
      const seekMs = p.from + (i === start ? offsetMs : 0);
      const startedAt = this.clock();
      yield {
        ...toSegment(p.row, this.plex, { seekMs }),
        durationMs: p.to, // play up to the end of this piece
        fullDurationMs: p.row.duration_ms, // for the rich presence progress bar
        continuation: p.from > 0 && i !== start, // back from a break inside the same show: no new "now playing"
        blockId: block.id,
        upNext: up ? toSegment(up, this.plex) : null,
      };
      if (this.live) return null;
      sinceBreak += this.clock() - startedAt;
      const remaining = pieces.slice(i + 1).filter((q) => !this.skipped.has(q.row.id));
      if (!remaining.length) break;
      // Inside a show (at its break points): one or two short commercials. Between shows:
      // between_spots videos, unless the shows are very short.
      const inside = remaining[0].row.id === p.row.id;
      if (inside || sinceBreak >= breakEvery) {
        // In a movie or an hour-long show the break is as long as the ads that go with the
        // piece just aired (broadcast.ad_minutes_per_hour), not a spot or two.
        const targetMs = inside && p.row.duration_ms >= LONG_MS ? breakTargetMs(p.to - p.from, p.row.duration_ms) : null;
        yield* before(makeBreak(this.plex, { theme: block.theme, inside, show: p.row, targetMs }), remaining[0].row);
        sinceBreak = 0;
        if (this.live) return null;
      }
    }
    this.blockRest = new Set();
    // The break between blocks.
    if (sinceBreak >= breakEvery) {
      yield* before(makeBreak(this.plex, { theme: block.theme }), nextBlock?.items[0]);
      if (this.live) return null;
    }

    // The block ends now: the rest of the day moves to match (earlier if it ran short or
    // something was skipped, later if it ran long or was paused).
    if (this.retime(block)) return null;
    // A special comes next and keeps its announced time. Early: shows, then commercials,
    // until it starts. Late: it plays from its start.
    yield* this.fillWithShows(block);
    if (this.live) return null;
    const left = block.end_at - this.clock();
    if (left > 1000) {
      const nextTitle = nextBlock?.items[0] ? toSegment(nextBlock.items[0], this.plex).title : null;
      yield* before(fillBreak(this.plex, left, { theme: block.theme, upNextTitle: nextTitle }), nextBlock?.items[0]);
    }
    return this.clock() > block.end_at + 30000 && nextBlock?.start_at === block.end_at ? nextBlock : null;
  }

  // Make the block end now and move the rest of the day with it. False if it can't.
  retime(block) {
    const now = this.clock();
    if (Math.abs(now - block.end_at) < 5000) return true;
    if (!shiftBlocks(block.id, block.end_at, now)) return false;
    block.end_at = now;
    return true;
  }

  // Fills the rest of the block: episodes while a whole one fits (only shows with
  // nothing scheduled later, so nothing airs twice; in-order shows continue where they
  // left off; this block's shows first), then shorts (the shorts folder), leaving a
  // couple of minutes for ads. Each one is saved into the block as it starts.
  *fillWithShows(block) {
    const minute = 60000;
    const maxBreak = 5 * minute;
    const adsAtEnd = 3 * minute;
    for (;;) {
      // The block was skipped (maybe while this filler played): stop filling.
      if (this.blockSkipped === block.id) return;
      const left = block.end_at - this.clock();
      const row = (left > maxBreak + minute && this.fillerEpisode(block, left - minute))
        || (left > adsAtEnd && this.fillerShort(left - minute));
      if (!row) return;
      appendToBlock(block.id, row.id);
      this.blockRest = new Set([row.id]);
      yield { ...toSegment(row, this.plex), blockId: block.id, upNext: null };
      if (this.live) return;
      if (block.end_at - this.clock() - adsAtEnd > minute) yield* makeBreak(this.plex, { theme: block.theme });
      if (this.live) return;
    }
  }

  // A short that fits: each series continues from its last aired one; nothing that
  // aired in the last 2 days.
  fillerShort(maxMs) {
    const db = getDb();
    const now = this.clock();
    const recent = usedIds(now - 2 * 86400000, now + 86400000);
    const all = db.prepare(`SELECT * FROM items i WHERE i.kind = 'short' AND ${schedulableSql("i")}
      ORDER BY i.show_title, i.season IS NULL, i.season, i.episode IS NULL, i.episode, i.title`).all();
    const series = (r) => r.show_title ?? r.title;
    const last = new Map(db.prepare(`SELECT i.id, i.show_title, i.title FROM block_items bi JOIN blocks b ON b.id = bi.block_id
      JOIN items i ON i.id = bi.item_id WHERE i.kind = 'short' ORDER BY b.start_at, bi.position`).all().map((r) => [series(r), r.id]));
    const picks = [];
    for (const [name, eps] of Map.groupBy(all, series)) {
      const k = eps.findIndex((e) => e.id === last.get(name));
      for (let j = 1; j <= eps.length; j++) {
        const e = eps[(k + j) % eps.length];
        if (recent.has(e.id) || this.skipped.has(e.id)) continue;
        if (e.duration_ms && e.duration_ms <= maxMs) picks.push(e);
        break;
      }
    }
    return picks[Math.floor(Math.random() * picks.length)] || null;
  }

  fillerEpisode(block, maxMs) {
    const db = getDb();
    const now = this.clock();
    const used = usedIds(now - config.broadcast.no_repeat_days * 86400000, now + 30 * 86400000);
    const later = new Set(db.prepare(`SELECT DISTINCT i.show_title FROM block_items bi JOIN blocks b ON b.id = bi.block_id
      JOIN items i ON i.id = bi.item_id WHERE b.start_at >= ? AND i.show_title IS NOT NULL`).all(block.end_at).map((r) => r.show_title));
    const shows = db.prepare(`SELECT DISTINCT i.show_title FROM items i WHERE i.kind = 'episode' AND ${schedulableSql("i")}
      AND i.duration_ms <= ?`).all(maxMs).map((r) => r.show_title).filter((t) => t && !later.has(t));
    const mine = new Set(block.items.map((r) => r.show_title));
    shows.sort(() => Math.random() - 0.5).sort((x, y) => mine.has(y) - mine.has(x));
    for (const title of shows.slice(0, 40)) {
      const eps = inOrder(title)
        ? nextInOrder(title, 1, used, Number.MAX_SAFE_INTEGER)
        : db.prepare(`SELECT * FROM items i WHERE i.kind = 'episode' AND i.show_title = ? AND ${schedulableSql("i")}
            ORDER BY random() LIMIT 20`).all(title).filter((r) => !used.has(r.id));
      const row = eps.find((r) => r.duration_ms <= maxMs && !this.skipped.has(r.id));
      if (row) return row;
    }
    return null;
  }
}
