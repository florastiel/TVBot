// Turning catalog rows into playable segments, and picking commercial breaks.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { SUBS_DIR } from "../catalog/plexSync.js";

export function describe(row) {
  if (row.kind === "episode") {
    const se = row.season != null && row.episode != null ? ` S${row.season}E${row.episode}` : "";
    return { title: row.show_title || row.title, subtitle: `${se.trim()}${row.title && row.title !== row.show_title ? ` "${row.title}"` : ""}`.trim() };
  }
  return { title: row.title, subtitle: row.year ? String(row.year) : "" };
}

// plex: the Plex client, for building file URLs.
export function toSegment(row, plex, { seekMs = 0, breakId = null } = {}) {
  const subs = row.subs ? JSON.parse(row.subs) : { mode: "none" };
  let subsFile = null;
  if (subs.mode === "sidecar") {
    subsFile = [join(SUBS_DIR, `${row.id}.ass`), join(SUBS_DIR, `${row.id}.srt`)].find(existsSync) || null;
  }
  return {
    itemId: row.id,
    kind: row.kind,
    ...describe(row),
    input: row.source === "plex" ? plex.fileUrl(row.media_path) : row.source_key,
    seekMs,
    durationMs: row.duration_ms,
    audioStream: row.audio_stream,
    subs,
    subsFile,
    breakId,
  };
}

export function getItem(id) {
  return getDb().prepare("SELECT * FROM items WHERE id = ?").get(id);
}

const recent = []; // item ids of the last commercials/clips played, to avoid repeats
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Prefer something not played recently; with a small pool, allow repeats rather than
// leaving the break empty. Never repeat within the same break.
function pick(kind, theme, exclude) {
  return pickFrom(kind, theme, [...exclude, ...recent]) || pickFrom(kind, theme, exclude);
}

function pickFrom(kind, theme, ex) {
  const db = getDb();
  const notIn = ex.length ? `AND i.id NOT IN (${ex.map(() => "?").join(",")})` : "";
  const base = `SELECT i.* FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = ? AND i.present = 1 AND i.playable = 1 AND NOT i.excluded ${notIn}`;
  // Themed block: prefer matching commercials. Otherwise: prefer non-holiday ones,
  // so Christmas ads don't show up in July.
  const themed = theme && theme !== "none"
    ? db.prepare(`${base} AND t.holiday = ? ORDER BY random() LIMIT 1`).get(kind, ...ex, theme)
    : null;
  return themed
    || db.prepare(`${base} AND COALESCE(t.holiday, 'none') = 'none' ORDER BY random() LIMIT 1`).get(kind, ...ex)
    || db.prepare(`${base} ORDER BY random() LIMIT 1`).get(kind, ...ex);
}

let breakCounter = 0;
// A commercial break: 1-2 commercials (config), sometimes a clip. Empty if there's
// nothing to show, in which case the next show just starts.
export function makeBreak(plex, { theme = null } = {}) {
  const [min, max] = config.broadcast.commercials_per_break;
  const breakId = `b${++breakCounter}-${Date.now()}`;
  const rows = [];
  for (let n = rand(min, max); n > 0; n--) {
    const r = pick("commercial", theme, rows.map((x) => x.id));
    if (r) rows.push(r);
  }
  if (Math.random() < config.broadcast.clip_chance) {
    const c = pick("clip", theme, []);
    if (c) rows.splice(rand(0, rows.length), 0, c);
  }
  for (const r of rows) {
    recent.push(r.id);
    if (recent.length > 30) recent.shift();
  }
  return rows.map((r) => toSegment(r, plex, { breakId }));
}
