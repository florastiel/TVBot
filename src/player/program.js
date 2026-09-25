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
import { blockAt, nextBlockAfter, blocksBetween, usedIds, appendToBlock, shiftEarlier } from "../schedule/store.js";
import { inOrder, nextInOrder } from "../schedule/generate.js";
import { getDb } from "../db.js";
import { schedulableSql } from "../catalog/schedulable.js";
import { localTime, gridCeil, gridMs } from "../schedule/time.js";

export const PLAYLIST_FILE = join(DATA_DIR, "playlist.json");

export function savePlaylist(ids) {
  writeFileSync(PLAYLIST_FILE, JSON.stringify({ ids }, null, 2));
}
export function clearPlaylist() {
  rmSync(PLAYLIST_FILE, { force: true });
}

export function makeProgram(plex, clock) {
  return existsSync(PLAYLIST_FILE) ? new PlaylistProgram(plex) : new ScheduleProgram(plex, clock);
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
const EDGE = 5 * 60000;  // never break within 5 minutes of the start/end of a show or another break

// Cut a block's items into pieces (at chapter points where the file has them) until
// the block's ad time, spread over one break per piece, fits max_break_minutes each.
export function planPieces(items, blockMs) {
  const maxBreak = config.broadcast.max_break_minutes * 60000;
  const pieces = items.map((r) => ({ row: r, from: 0, to: r.duration_ms }));
  const adMs = blockMs - items.reduce((n, r) => n + r.duration_ms, 0);
  while (pieces.length && adMs / pieces.length > maxBreak) {
    let best = null;
    for (const p of pieces) {
      const size = p.to - p.from;
      if (size < 2 * EDGE) continue;
      const mid = p.from + size / 2;
      const cues = (p.row.cues ? JSON.parse(p.row.cues) : []).filter((c) => c > p.from + EDGE && c < p.to - EDGE);
      const cut = cues.length ? cues.reduce((a, c) => (Math.abs(c - mid) < Math.abs(a - mid) ? c : a))
        : config.broadcast.split_without_chapters ? Math.round(mid) : null;
      if (cut === null) continue;
      // Prefer real chapter points, then the longest piece.
      const score = (cues.length ? 1e9 : 0) + size;
      if (!best || score > best.score) best = { p, cut, score };
    }
    if (!best) break;
    pieces.splice(pieces.indexOf(best.p), 1, { ...best.p, to: best.cut }, { ...best.p, from: best.cut });
  }
  return pieces;
}

export class ScheduleProgram {
  // clock(): wall-clock ms at which the next segment will start playing.
  constructor(plex, clock) {
    this.plex = plex;
    this.clock = clock;
    this.skipped = new Set(); // item ids skipped for good (their remaining pieces are dropped)
  }

  // Drop the rest of this show/movie; the time it leaves gets other episodes.
  skipItem(itemId) {
    this.skipped.add(itemId);
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
      const late = yield* this.playBlock(block, now);
      if (late) caughtUpFrom = late;
      // Safety net: a block that played nothing must still move the clock forward,
      // or this loop would spin forever.
      if (this.clock() === before && !this.live) yield card("", Math.max(1000, block.end_at - before));
    }
  }

  // Plays one block. Returns the next block if this one finished late (so it can be
  // played from its start), otherwise nothing.
  *playBlock(block, now, { fromStart = false } = {}) {
    const items = block.items.filter((r) => r.present && r.playable);
    const nextBlock = nextBlockAfter(block.end_at);
    // Long shows/movies may be cut into pieces at chapter points so no break has to be
    // longer than max_break_minutes.
    const pieces = planPieces(items, block.end_at - block.start_at);
    const upNextOf = (i) => pieces.slice(i + 1).find((p) => p.row.id !== pieces[i].row.id)?.row || nextBlock?.items[0] || null;
    const len = (p) => p.to - p.from;

    // Where "now" falls on the block's ideal timeline: pieces spread evenly, with equal
    // breaks after each (the last one is the end-of-block filler).
    const total = pieces.reduce((n, p) => n + len(p), 0);
    const gap = pieces.length ? Math.max(0, (block.end_at - block.start_at - total) / pieces.length) : 0;
    let t = block.start_at;
    let start = fromStart ? 0 : pieces.length;
    let offsetMs = 0;
    let breakFirstMs = 0;
    for (let i = 0; !fromStart && i < pieces.length; i++) {
      const dur = len(pieces[i]);
      if (now < t + dur) {
        start = i;
        offsetMs = Math.max(0, now - t);
        if (dur - offsetMs < MIN_LEFT) { start = i + 1; offsetMs = 0; breakFirstMs = t + dur + gap - now; }
        break;
      }
      t += dur;
      if (now < t + gap) { start = i + 1; breakFirstMs = t + gap - now; break; }
      t += gap;
    }

    const titleOf = (row) => (row ? toSegment(row, this.plex).title : null);
    const before = (segs, row) => segs.map((s) => ({ ...s, nextTitle: titleOf(row) }));
    if (breakFirstMs > 3000 && start < pieces.length) yield* before(makeBreak(this.plex, { theme: block.theme, budgetMs: breakFirstMs }), pieces[start].row);

    for (let i = start; i < pieces.length; i++) {
      const p = pieces[i];
      if (this.skipped.has(p.row.id)) continue;
      // Download ahead (in airing order) whatever airs in the next few hours and needs
      // it for subtitles, so even big movies are ready well before they start.
      const ahead = [...new Set(pieces.slice(i + 1).map((q) => q.row))];
      for (const b of blocksBetween(block.end_at, block.end_at + LOOKAHEAD_MS)) ahead.push(...b.items);
      wantSpool(ahead, this.plex);
      const up = upNextOf(i);
      const seekMs = p.from + (i === start ? offsetMs : 0);
      yield {
        ...toSegment(p.row, this.plex, { seekMs }),
        durationMs: p.to, // play up to the end of this piece
        fullDurationMs: p.row.duration_ms, // for the rich presence progress bar
        continuation: p.from > 0 && i !== start, // back from a break inside the same show: no new "now playing"
        blockId: block.id,
        upNext: up ? toSegment(up, this.plex) : null,
      };
      if (this.live) return null;
      const remaining = pieces.slice(i + 1).filter((q) => !this.skipped.has(q.row.id));
      const rest = remaining.reduce((n, q) => n + len(q), 0);
      // Just skipped: the rest of the day moves up now, keeping only what the rest of
      // this block needs (its shows plus the minimum ads).
      if (this.skipped.has(p.row.id)) this.pullUp(block, rest / (1 - config.broadcast.min_ad_minutes_per_hour / 60));
      if (remaining.length) {
        // Share whatever time is left over equally between the remaining breaks, so the
        // next block still starts on time even if a break was skipped or ran long.
        const budgetMs = (block.end_at - this.clock() - rest) / (remaining.length + 1);
        if (budgetMs > 3000) yield* before(makeBreak(this.plex, { theme: block.theme, budgetMs }), remaining[0].row);
        if (this.live) return null;
      }
    }

    // Content ran out early (a skip): the rest of the day moves up by whole grid steps,
    // so the next block starts sooner. Whatever can't move gets shows, not ads.
    this.pullUp(block);
    yield* this.fillWithShows(block);
    if (this.live) return null;

    const left = block.end_at - this.clock();
    if (left > 1000) {
      const nextTitle = nextBlock?.items[0] ? toSegment(nextBlock.items[0], this.plex).title : null;
      yield* before(fillBreak(this.plex, left, { theme: block.theme, upNextTitle: nextTitle }), nextBlock?.items[0]);
    }
    // Finished late (more than half a minute): the next block starts from its top.
    return this.clock() > block.end_at + 30000 && nextBlock?.start_at === block.end_at ? nextBlock : null;
  }

  pullUp(block, needMs = 0) {
    const end = gridCeil(this.clock() + needMs + 60000);
    const by = block.end_at - end;
    if (by < gridMs()) return;
    if (shiftEarlier(block.id, block.end_at, by)) block.end_at = end;
  }

  // Fills the rest of the block: episodes while a whole one fits (only shows with
  // nothing scheduled later, so nothing airs twice; in-order shows continue where they
  // left off; this block's shows first), then shorts (the shorts folder), leaving a
  // couple of minutes for ads. Each one is saved into the block as it starts.
  *fillWithShows(block) {
    const maxBreak = config.broadcast.max_break_minutes * 60000;
    const minute = 60000;
    const adsAtEnd = 3 * minute;
    for (;;) {
      const left = block.end_at - this.clock();
      const row = (left > maxBreak + minute && this.fillerEpisode(block, left - minute))
        || (left > adsAtEnd && this.fillerShort(left - minute));
      if (!row) return;
      appendToBlock(block.id, row.id);
      yield { ...toSegment(row, this.plex), blockId: block.id, upNext: null };
      if (this.live) return;
      const after = block.end_at - this.clock() - adsAtEnd;
      const budgetMs = Math.min(row.kind === "short" ? 45000 : 2 * minute, after);
      if (budgetMs > 15000) yield* makeBreak(this.plex, { theme: block.theme, budgetMs });
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
