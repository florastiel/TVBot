// What's on. A "program" yields segments in order; the player just plays them.
//
// ScheduleProgram follows the saved schedule on the wall clock, like real TV: joining
// mid-block starts whatever is on right now at the right point. PlaylistProgram is a
// test override (tv.cmd playlist): it loops a few episodes, ignoring the clock.
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { getItem, toSegment, makeBreak, fillBreak, card } from "./segments.js";
import { blockAt, nextBlockAfter } from "../schedule/store.js";
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
      yield { ...toSegment(row, this.plex), upNext: next ? toSegment(next, this.plex) : null };
      yield* makeBreak(this.plex);
    }
  }
}

const MIN_LEFT = 20000; // don't join the last 20 seconds of a show; go to the next thing

export class ScheduleProgram {
  // clock(): wall-clock ms at which the next segment will start playing.
  constructor(plex, clock) {
    this.plex = plex;
    this.clock = clock;
  }

  *segments() {
    for (;;) {
      const now = this.clock();
      const block = blockAt(now);
      if (!block) {
        // Off the air (or nothing scheduled): a card until the next block, a minute at a time.
        const next = nextBlockAfter(now);
        const wait = Math.max(5000, Math.min(60000, next ? next.start_at - now : 60000));
        yield card(next ? `Off the air\nBack at ${localTime(next.start_at)}` : "Off the air", wait);
        continue;
      }
      yield* this.playBlock(block, now);
    }
  }

  *playBlock(block, now) {
    const items = block.items.filter((r) => r.present && r.playable);
    const nextBlock = nextBlockAfter(block.end_at);
    const upNextOf = (i) => items[i + 1] || nextBlock?.items[0] || null;

    // Where "now" falls on the block's ideal timeline: shows spread evenly, with equal
    // breaks after each (the last one is the end-of-block filler).
    const total = items.reduce((n, r) => n + r.duration_ms, 0);
    const gap = items.length ? Math.max(0, (block.end_at - block.start_at - total) / items.length) : 0;
    let t = block.start_at;
    let start = items.length;
    let seekMs = 0;
    let breakFirstMs = 0;
    for (let i = 0; i < items.length; i++) {
      const dur = items[i].duration_ms;
      if (now < t + dur) {
        start = i;
        seekMs = Math.max(0, now - t);
        if (dur - seekMs < MIN_LEFT) { start = i + 1; seekMs = 0; breakFirstMs = t + dur + gap - now; }
        break;
      }
      t += dur;
      if (now < t + gap) { start = i + 1; breakFirstMs = t + gap - now; break; }
      t += gap;
    }

    if (breakFirstMs > 3000 && start < items.length) yield* makeBreak(this.plex, { theme: block.theme, budgetMs: breakFirstMs });

    for (let i = start; i < items.length; i++) {
      const up = upNextOf(i);
      yield { ...toSegment(items[i], this.plex, { seekMs: i === start ? seekMs : 0 }), upNext: up ? toSegment(up, this.plex) : null };
      if (i < items.length - 1) {
        // Share whatever time is left over equally between the remaining breaks, so the
        // next block still starts on time even if a break was skipped or ran long.
        const rest = items.slice(i + 1).reduce((n, r) => n + r.duration_ms, 0);
        const budgetMs = (block.end_at - this.clock() - rest) / (items.length - 1 - i + 1);
        if (budgetMs > 3000) yield* makeBreak(this.plex, { theme: block.theme, budgetMs });
      }
    }

    const left = block.end_at - this.clock();
    if (left > 1000) {
      const nextTitle = nextBlock?.items[0] ? toSegment(nextBlock.items[0], this.plex).title : null;
      yield* fillBreak(this.plex, left, { theme: block.theme, upNextTitle: nextTitle });
    }
  }
}
