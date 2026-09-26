// Turning catalog rows into playable segments, and picking commercial breaks.
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { SUBS_DIR } from "../catalog/plexSync.js";
import { spooledPath } from "./spool.js";

export function describe(row) {
  if (row.kind === "episode" || row.kind === "short") {
    const se = row.season != null && row.episode != null ? ` S${row.season}E${row.episode}` : "";
    return { title: row.show_title || row.title, subtitle: `${se.trim()}${row.title && row.title !== row.show_title ? ` "${row.title}"` : ""}`.trim() };
  }
  return { title: row.title, subtitle: row.year ? String(row.year) : "" };
}

// plex: the Plex client, for building file URLs.
export function toSegment(row, plex, { seekMs = 0, breakId = null } = {}) {
  const subs = row.subs ? JSON.parse(row.subs) : { mode: "none" };
  let subsFile = null;
  // A downloaded-ahead copy plays instead of the Plex stream whenever there is one.
  // Real-Debrid: without a copy, input stays null and the player unrestricts rdLink
  // right before playing (that takes an API call, and the URL shouldn't sit around).
  const local = row.source === "local" ? row.source_key : spooledPath(row);
  let input = local || (row.source === "plex" ? plex.fileUrl(row.media_path) : null);
  if (subs.mode === "sidecar") {
    subsFile = [join(SUBS_DIR, `${row.id}.ass`), join(SUBS_DIR, `${row.id}.srt`)].find(existsSync) || null;
  } else if (subs.mode === "embedded_text" && local) {
    // Subtitles inside the file: only from a local copy (a local file, or downloaded ahead).
    subsFile = local;
  }
  return {
    rdLink: row.source === "realdebrid" && !local ? row.media_path : null,
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

// Everything of this kind that fits in maxMs and isn't already in this break, preferring
// the block's holiday theme (and non-holiday ones otherwise, so no Christmas ads in July).
function candidates(kind, theme, exclude, maxMs) {
  const notIn = exclude.length ? `AND i.id NOT IN (${exclude.map(() => "?").join(",")})` : "";
  const cap = Number.isFinite(maxMs) ? maxMs : 1e12;
  const rows = getDb().prepare(`SELECT i.*, COALESCE(t.holiday, 'none') holiday FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = ? AND i.present = 1 AND i.playable = 1 AND NOT i.excluded AND i.duplicate_of IS NULL AND i.duration_ms <= ? ${notIn}`).all(kind, cap, ...exclude);
  const themed = theme && theme !== "none" ? rows.filter((r) => r.holiday === theme) : [];
  const plain = rows.filter((r) => r.holiday === "none");
  return themed.length ? themed : plain.length ? plain : rows;
}

// A big batch (a playlist of 88 Pop-Tarts ads) shouldn't take over every break. Files
// in the same subfolder form one group; loose files (and files straight in "youtube")
// are each their own group, and so are files in a broadcast.variety_folders folder (a
// pack of many different ads, like an archive.org collection). First a group is picked
// (bigger groups a bit more often: weight = size, capped at GROUP_WEIGHT_CAP), avoiding
// groups already in this break; then, within the group, something not played recently
// (or the least recent one).
const GROUP_WEIGHT_CAP = 3;
function groupOf(row, kind) {
  const root = kind === "clip" ? config.local.clips : config.local.commercials;
  const dir = relative(root || "", row.source_key).split(sep).slice(0, -1).join("/");
  const variety = (config.broadcast.variety_folders || []).map((f) => String(f).toLowerCase());
  if (dir && variety.includes(dir.split("/").at(-1).toLowerCase())) return row.source_key;
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

// A commercial break. Between shows (inside: false): between_spots videos, the first
// sometimes a clip. Inside a show: one commercial (with inside_spots 2, a second one when
// both are short_spot_seconds or less). Each at most max_spot_minutes, from different groups.
export function makeBreak(plex, { theme = null, inside = false } = {}) {
  const b = config.broadcast;
  const maxMs = b.max_spot_minutes * 60000;
  const shortMs = b.short_spot_seconds * 1000;
  const rows = [];
  const groups = new Set(); // spread a break over different groups
  const add = (kind, max) => {
    const other = kind === "clip" ? "commercial" : "clip";
    const avoid = rows.map((x) => x.id);
    const r = pick(kind, theme, avoid, max, groups) || (inside ? null : pick(other, theme, avoid, max, groups));
    if (r) rows.push(r);
    return r;
  };
  if (inside) {
    const first = add("commercial", Math.min(maxMs, 60000)); // mid-show: a minute at most
    if (b.inside_spots > 1 && first && first.duration_ms <= shortMs) add("commercial", shortMs);
  } else {
    for (let k = 0; k < b.between_spots; k++) add(k === 0 && Math.random() < b.clip_chance ? "clip" : "commercial", maxMs);
  }
  remember(rows);
  const breakId = newBreakId();
  return timed(rows.map((r) => toSegment(r, plex, { breakId })));
}

// Each piece of a break knows how long the whole break runs and how far into it it
// starts (for the "next show in 2:14" countdown).
function timed(segs) {
  const total = segs.reduce((n, s) => n + s.durationMs, 0);
  let at = 0;
  return segs.map((s) => { const out = { ...s, breakTotalMs: total, breakAtMs: at }; at += s.durationMs; return out; });
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
  return timed(segs);
}

// A plain text card (template text + real titles only). No sound.
export function card(text, durationMs, extra = {}) {
  return { kind: "card", title: text.split("\n").pop(), subtitle: "", card: text, durationMs, audioStream: null, subs: { mode: "none" }, ...extra };
}
