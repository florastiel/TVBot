// Turning catalog rows into playable segments, and picking commercial breaks.
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { SUBS_DIR } from "../catalog/plexSync.js";
import { spooledPath } from "./spool.js";

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
  let input = row.source === "plex" ? plex.fileUrl(row.media_path) : row.source_key;
  if (subs.mode === "sidecar") {
    subsFile = [join(SUBS_DIR, `${row.id}.ass`), join(SUBS_DIR, `${row.id}.srt`)].find(existsSync) || null;
  } else if (subs.mode === "embedded_text") {
    // Subtitles inside the file: only from a local copy (a local file, or downloaded ahead).
    const local = row.source === "plex" ? spooledPath(row) : row.source_key;
    if (local) { input = local; subsFile = local; }
  }
  return {
    itemId: row.id,
    kind: row.kind,
    ...describe(row),
    input,
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

const recent = []; // item ids of the last commercials/clips played, oldest first
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Everything of this kind that fits in maxMs and isn't already in this break, preferring
// the block's holiday theme (and non-holiday ones otherwise, so no Christmas ads in July).
function candidates(kind, theme, exclude, maxMs) {
  const notIn = exclude.length ? `AND i.id NOT IN (${exclude.map(() => "?").join(",")})` : "";
  const cap = Number.isFinite(maxMs) ? maxMs : 1e12;
  const rows = getDb().prepare(`SELECT i.*, COALESCE(t.holiday, 'none') holiday FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = ? AND i.present = 1 AND i.playable = 1 AND NOT i.excluded AND i.duration_ms <= ? ${notIn}`).all(kind, cap, ...exclude);
  const themed = theme && theme !== "none" ? rows.filter((r) => r.holiday === theme) : [];
  const plain = rows.filter((r) => r.holiday === "none");
  return themed.length ? themed : plain.length ? plain : rows;
}

// A big batch (a playlist of 88 Pop-Tarts ads) shouldn't take over every break. Files
// in the same subfolder form one group; loose files (and files straight in "youtube")
// are each their own group. First a group is picked (bigger groups a bit more often:
// weight = size, capped at GROUP_WEIGHT_CAP), avoiding groups already in this break;
// then, within the group, something not played recently (or the least recent one).
const GROUP_WEIGHT_CAP = 3;
function groupOf(row, kind) {
  const root = kind === "clip" ? config.local.clips : config.local.commercials;
  const dir = relative(root || "", row.source_key).split(sep).slice(0, -1).join("/");
  return !dir || dir.toLowerCase() === "youtube" ? row.source_key : dir;
}

// noRepeat: return nothing rather than a second pick from a group already used.
function pick(kind, theme, exclude, maxMs = Infinity, usedGroups = null, noRepeat = false) {
  const rows = candidates(kind, theme, exclude, maxMs);
  if (!rows.length) return null;
  let groups = [...Map.groupBy(rows, (r) => groupOf(r, kind))];
  const unused = usedGroups ? groups.filter(([k]) => !usedGroups.has(k)) : groups;
  if (unused.length) groups = unused;
  else if (noRepeat) return null;
  const weight = ([, g]) => Math.min(g.length, GROUP_WEIGHT_CAP);
  let n = Math.random() * groups.reduce((t, g) => t + weight(g), 0);
  const [key, group] = groups.find((g) => (n -= weight(g)) < 0) || groups.at(-1);
  const age = (r) => recent.lastIndexOf(r.id); // -1: not played recently
  const fresh = group.filter((r) => age(r) === -1);
  const r = fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : group.reduce((a, b) => (age(a) <= age(b) ? a : b));
  usedGroups?.add(key);
  return r;
}

function remember(rows) {
  for (const r of rows) {
    recent.push(r.id);
    if (recent.length > 60) recent.shift();
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
  const budget = Math.min(budgetMs ?? (config.broadcast.max_ad_minutes_per_hour * 60000 * 22) / 60 / 2,
    config.broadcast.max_break_minutes * 60000);
  const rows = [];
  const groups = new Set(); // spread a break over different groups
  let left = budget;
  if (Math.random() < config.broadcast.clip_chance) {
    const c = pick("clip", theme, [], left + OVERRUN_MS, groups);
    if (c) { rows.push(c); left -= c.duration_ms; }
  }
  while (left > 5000) {
    // Once there's a minute of ads, end the break rather than repeat a group (the
    // time left over goes to the next break).
    const filled = budget - left;
    const r = pick("commercial", theme, rows.map((x) => x.id), left + OVERRUN_MS, groups, filled >= 60000)
      || (rows.length ? null : pick("clip", theme, [], left + OVERRUN_MS, groups)); // no commercials yet: a clip instead
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
  const groups = new Set();
  let left = ms;
  for (;;) {
    const kind = rows.length % 4 === 3 ? "clip" : "commercial";
    const avoid = rows.slice(-2).map((x) => x.id); // small libraries may repeat, never back-to-back
    const r = pick(kind, theme, avoid, left, groups) || pick(kind === "clip" ? "commercial" : "clip", theme, avoid, left, groups);
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
