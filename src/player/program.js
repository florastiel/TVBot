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
import { blockAt, nextBlockAfter, blocksBetween } from "../schedule/store.js";
import { localTime } from "../schedule/time.js";

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
        upNext: up ? toSegment(up, this.plex) : null,
      };
      if (this.live) return null;
      if (i < pieces.length - 1) {
        // Share whatever time is left over equally between the remaining breaks, so the
        // next block still starts on time even if a break was skipped or ran long.
        const rest = pieces.slice(i + 1).reduce((n, q) => n + len(q), 0);
        const budgetMs = (block.end_at - this.clock() - rest) / (pieces.length - 1 - i + 1);
        if (budgetMs > 3000) yield* before(makeBreak(this.plex, { theme: block.theme, budgetMs }), pieces[i + 1].row);
        if (this.live) return null;
      }
    }

    const left = block.end_at - this.clock();
    if (left > 1000) {
      const nextTitle = nextBlock?.items[0] ? toSegment(nextBlock.items[0], this.plex).title : null;
      yield* before(fillBreak(this.plex, left, { theme: block.theme, upNextTitle: nextTitle }), nextBlock?.items[0]);
    }
    // Finished late (more than half a minute): the next block starts from its top.
    return this.clock() > block.end_at + 30000 && nextBlock?.start_at === block.end_at ? nextBlock : null;
  }
}
