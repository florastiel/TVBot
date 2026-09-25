// What's on. A "program" yields segments in order; the player just plays them.
// Step 3 uses a test playlist; step 5 replaces it with the weekly wall-clock schedule
// (same interface: the first segment may start partway in via seekMs).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { getItem, toSegment, makeBreak } from "./segments.js";

export const PLAYLIST_FILE = join(DATA_DIR, "playlist.json");

export function savePlaylist(ids) {
  writeFileSync(PLAYLIST_FILE, JSON.stringify({ ids }, null, 2));
}

// Loops the item ids in data/playlist.json with a commercial break after each show.
export class PlaylistProgram {
  constructor(plex) {
    this.plex = plex;
    if (!existsSync(PLAYLIST_FILE)) throw new Error("no test playlist yet: run  tv.cmd playlist \"<show name>\"");
    this.ids = JSON.parse(readFileSync(PLAYLIST_FILE, "utf8")).ids;
    this.pos = 0;
  }

  *segments() {
    for (;;) {
      const row = getItem(this.ids[this.pos++ % this.ids.length]);
      if (!row) continue;
      const show = toSegment(row, this.plex);
      const next = getItem(this.ids[this.pos % this.ids.length]);
      yield { ...show, upNext: next ? toSegment(next, this.plex) : null };
      yield* makeBreak(this.plex);
    }
  }
}
