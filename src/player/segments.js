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
// leaving the break empty. Never repeat within the same break. maxMs: must fit in this.
function pick(kind, theme, exclude, maxMs = Infinity) {
  return pickFrom(kind, theme, [...exclude, ...recent], maxMs) || pickFrom(kind, theme, exclude, maxMs);
}

function pickFrom(kind, theme, ex, maxMs) {
  const db = getDb();
  const notIn = ex.length ? `AND i.id NOT IN (${ex.map(() => "?").join(",")})` : "";
  const base = `SELECT i.* FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = ? AND i.present = 1 AND i.playable = 1 AND NOT i.excluded AND i.duration_ms <= ? ${notIn}`;
  const cap = Number.isFinite(maxMs) ? maxMs : 1e12;
  // Themed block: prefer matching commercials. Otherwise: prefer non-holiday ones,
  // so Christmas ads don't show up in July.
  const themed = theme && theme !== "none"
    ? db.prepare(`${base} AND t.holiday = ? ORDER BY random() LIMIT 1`).get(kind, cap, ...ex, theme)
    : null;
  return themed
    || db.prepare(`${base} AND COALESCE(t.holiday, 'none') = 'none' ORDER BY random() LIMIT 1`).get(kind, cap, ...ex)
    || db.prepare(`${base} ORDER BY random() LIMIT 1`).get(kind, cap, ...ex);
}

function remember(rows) {
  for (const r of rows) {
    recent.push(r.id);
    if (recent.length > 30) recent.shift();
  }
}

let breakCounter = 0;
const newBreakId = () => `b${++breakCounter}-${Date.now()}`;

// A commercial break of about budgetMs: whole commercial files until the budget is used
// up (the last one may run a few seconds over; the end of the block makes up for it),
// sometimes a clip. Empty if nothing fits, in which case the next show just starts.
// Without a budget (test playlist): about half the max ad time of an hour, per episode.
const OVERRUN_MS = 20000;
export function makeBreak(plex, { theme = null, budgetMs = null } = {}) {
  const budget = budgetMs ?? (config.broadcast.max_ad_minutes_per_hour * 60000 * 22) / 60 / 2;
  const rows = [];
  let left = budget;
  if (Math.random() < config.broadcast.clip_chance) {
    const c = pick("clip", theme, [], left + OVERRUN_MS);
    if (c) { rows.push(c); left -= c.duration_ms; }
  }
  while (left > 5000) {
    const r = pick("commercial", theme, rows.map((x) => x.id), left + OVERRUN_MS)
      || (rows.length ? null : pick("clip", theme, [], left + OVERRUN_MS)); // no commercials yet: a clip instead
    if (!r) break;
    rows.splice(rand(0, rows.length), 0, r);
    left -= r.duration_ms;
  }
  remember(rows);
  const breakId = newBreakId();
  return rows.map((r) => toSegment(r, plex, { breakId }));
}

// Fill the rest of a block exactly: commercials and clips while they fit, then a plain
// "Up next" card for the last few seconds. Counts as a (skippable) break.
export function fillBreak(plex, ms, { theme = null, upNextTitle = null } = {}) {
  const rows = [];
  let left = ms;
  for (;;) {
    const kind = rows.length % 4 === 3 ? "clip" : "commercial";
    const avoid = rows.slice(-2).map((x) => x.id); // small libraries may repeat, never back-to-back
    const r = pick(kind, theme, avoid, left) || pick(kind === "clip" ? "commercial" : "clip", theme, avoid, left);
    if (!r) break;
    rows.push(r);
    left -= r.duration_ms;
  }
  remember(rows);
  const breakId = newBreakId();
  const segs = rows.map((r) => toSegment(r, plex, { breakId }));
  // Whatever is left, even a second, so the block always runs right up to its end.
  if (left >= 500) segs.push(card(upNextTitle ? `Up next\n${upNextTitle}` : "Stay tuned", left, { breakId }));
  return segs;
}

// A plain text card (template text + real titles only). No sound.
export function card(text, durationMs, extra = {}) {
  return { kind: "card", title: text.split("\n").pop(), subtitle: "", card: text, durationMs, audioStream: null, subs: { mode: "none" }, ...extra };
}
