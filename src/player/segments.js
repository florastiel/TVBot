// Turning catalog rows into playable segments, and picking commercial breaks.
import { existsSync } from "node:fs";
import { join, relative, sep, basename } from "node:path";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { SUBS_DIR } from "../catalog/plexSync.js";
import { spooledPath } from "./spool.js";
import { takeWeather } from "../weather/report.js";

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
    // The copy matching the chosen track's format (a stale one in the other format may
    // still be there from an earlier pick).
    const f = join(SUBS_DIR, `${row.id}.${subs.codec === "ass" || subs.codec === "ssa" ? "ass" : "srt"}`);
    subsFile = existsSync(f) ? f : null;
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

const RECENT_MAX = 100;
const recent = []; // item ids of the last commercials/clips/eyecatches played, oldest first

// broadcast.ordered_folders: a clip/commercial folder (e.g. a numbered saga) that plays
// its files in filename order and loops, instead of a random pick each time. Resets to the
// start on a player restart (the order itself, like `recent`, isn't saved to disk).
const orderState = new Map(); // group key -> source_key of the last one played
const leadingNumber = (r) => { const m = basename(r.source_key).replace(/\.[^.]+$/, "").match(/\d+/); return m ? Number(m[0]) : null; };
function orderedNext(key, group) {
  const sorted = [...group].sort((a, b) => {
    const na = leadingNumber(a), nb = leadingNumber(b);
    return na != null && nb != null ? na - nb : basename(a.source_key).localeCompare(basename(b.source_key));
  });
  const i = sorted.findIndex((r) => r.source_key === orderState.get(key));
  const next = sorted[(i + 1) % sorted.length];
  orderState.set(key, next.source_key);
  return next;
}

// Everything of this kind that fits in maxMs and isn't already in this break, preferring
// the block's holiday theme (and non-holiday ones otherwise, so no Christmas ads in July).
function candidates(kind, theme, exclude, maxMs) {
  const notIn = exclude.length ? `AND i.id NOT IN (${exclude.map(() => "?").join(",")})` : "";
  const cap = Number.isFinite(maxMs) ? maxMs : 1e12;
  const rows = getDb().prepare(`SELECT i.*, COALESCE(t.holiday, 'none') holiday FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = ? AND i.present = 1 AND i.playable = 1 AND NOT i.excluded AND i.duplicate_of IS NULL AND i.duration_ms <= ? ${notIn}`).all(kind, cap, ...exclude);
  let themed = theme && theme !== "none" ? rows.filter((r) => r.holiday === theme) : [];
  const plain = rows.filter((r) => r.holiday === "none");
  // A handful of themed ads mustn't be the only thing on air for the whole season: the
  // fewer there are, the more rarely they're chosen (about one piece in 20 per themed file, up to half).
  if (themed.length && Math.random() >= Math.min(0.5, themed.length / 20) && plain.length) themed = [];
  return themed.length ? themed : plain.length ? plain : rows;
}

// Prefer files not played in the last RECENT_MAX pieces, whatever group they're in (a
// one-file group would otherwise come up as often as a 100-file folder).
function notRecent(rows) {
  const fresh = rows.filter((r) => !recent.includes(r.id));
  return fresh.length ? fresh : rows;
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
  return !dir || ["youtube", "uploads"].includes(dir.toLowerCase()) ? row.source_key : dir;
}

// noRepeat: return nothing rather than a second pick from a group already used.
// minPool: return nothing when fewer files than that fit (a break's last seconds: only
// the same few short bumpers fit, over and over).
function pick(kind, theme, exclude, maxMs = Infinity, usedGroups = null, noRepeat = false, minPool = 1) {
  const all = candidates(kind, theme, exclude, maxMs);
  if (all.length < minPool) return null;
  const rows = notRecent(all);
  if (!rows.length) return null;
  let groups = [...Map.groupBy(rows, (r) => groupOf(r, kind))];
  const unused = usedGroups ? groups.filter(([k]) => !usedGroups.has(k)) : groups;
  if (unused.length) groups = unused;
  else if (noRepeat) return null;
  const weight = ([, g]) => Math.min(g.length, GROUP_WEIGHT_CAP);
  let n = Math.random() * groups.reduce((t, g) => t + weight(g), 0);
  const [key, group] = groups.find((g) => (n -= weight(g)) < 0) || groups.at(-1);
  usedGroups?.add(key);
  const ordered = (config.broadcast.ordered_folders || []).map((f) => String(f).toLowerCase());
  if (ordered.includes(String(key).split("/").at(-1).toLowerCase())) {
    // The full folder, not just its not-recently-played members: order and looping matter
    // more than avoiding a repeat for these, and recent play history shouldn't skip a file.
    return orderedNext(key, all.filter((x) => groupOf(x, kind) === key));
  }
  const age = (r) => recent.lastIndexOf(r.id); // -1: not played recently
  const fresh = group.filter((r) => age(r) === -1);
  return fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : group.reduce((a, b) => (age(a) <= age(b) ? a : b));
}

function remember(rows) {
  for (const r of rows) {
    recent.push(r.id);
    if (recent.length > RECENT_MAX) recent.shift();
  }
}

let breakCounter = 0;
const newBreakId = () => `b${++breakCounter}-${Date.now()}`;

// Does a break inside this show/movie get eyecatches? broadcast.eyecatches: "tv"
// (whatever Claude judged would have aired with network-TV-style breaks:
// tagging/breaks.js), "all", or "none". Anime counts like anything else; pickEyecatch
// just never uses the show's own eyecatches (they'd double up). Per show for episodes,
// per item for movies.
function wantsEyecatches(row, mode) {
  if (!row || (mode !== "tv" && mode !== "all")) return false;
  const db = getDb();
  const r = row.kind === "episode" && row.show_title
    ? db.prepare("SELECT tv_breaks FROM shows WHERE title = ?").get(row.show_title)
    : db.prepare("SELECT tv_breaks FROM items WHERE id = ?").get(row.id);
  return mode === "all" || !!r?.tv_breaks;
}

const normTitle = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// An eyecatch for a break inside `show`: any file in eyecatches\ except ones from the
// show's own folder. A folder named after a show (eyecatches\Fullmetal Alchemist
// Brotherhood\) holds that show's own eyecatches, saved for other shows to use; on the
// show itself they'd double up. Like commercials, a folder counts as one source so a
// folder of 128 doesn't take over: a source is picked first (bigger ones a bit more
// often, capped), then a file in it not played recently; loose files and the thread
// folders (uploads, youtube) are each their own source. Prefers not to repeat one in
// `avoid` (the other end of this break).
const SHARED_DIRS = new Set(["", "uploads", "youtube"]);
function pickEyecatch(show, avoid) {
  const root = config.local.eyecatches || "";
  const dirOf = (r) => { const parts = relative(root, r.source_key).split(sep); return parts.length > 1 ? parts[0] : ""; };
  const name = normTitle(String(show?.show_title || show?.title || "").replace(/\s*\((?:(?:19|20)\d{2}|US|UK)\)\s*$/i, ""));
  // "Tengen Toppa Gurren Lagann" is the folder of the show catalogued as "Gurren Lagann".
  // A loose file (no folder) is the show's own when its title names the show, or one of
  // its longer words ("Trigun Eyecatch" for "Trigun Stampede").
  const words = String(show?.show_title || show?.title || "").split(/[^\p{L}\p{N}]+/u).map(normTitle).filter((w) => w.length >= 5 && !["season", "series", "movie"].includes(w));
  const isOwn = (r) => {
    if (name.length < 5) return false;
    const f = normTitle(dirOf(r));
    if (!f || SHARED_DIRS.has(dirOf(r).toLowerCase())) { const t = normTitle(r.title); return t.includes(name) || words.some((w) => t.includes(w)); }
    return f === name || f.includes(name) || (f.length >= 5 && name.includes(f));
  };
  const all = candidates("eyecatch", null, [], 60000).filter((r) => !isOwn(r));
  if (!all.length) return null;
  const notHere = all.filter((r) => !avoid.includes(r.id));
  const pool = notRecent(notHere.length ? notHere : all);
  const sources = [...Map.groupBy(pool, (r) => (SHARED_DIRS.has(dirOf(r).toLowerCase()) ? r.source_key : dirOf(r)))];
  const weight = ([, g]) => Math.min(g.length, GROUP_WEIGHT_CAP);
  let n = Math.random() * sources.reduce((t, s) => t + weight(s), 0);
  const [, group] = sources.find((s) => (n -= weight(s)) < 0) || sources.at(-1);
  const age = (r) => recent.lastIndexOf(r.id);
  const fresh = group.filter((r) => age(r) === -1);
  return fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : group.reduce((a, b) => (age(a) <= age(b) ? a : b));
}

// A commercial break, always bookended by an eyecatch at each end. Between shows (inside:
// false): between_spots videos, each with clip_chance of being a clip instead of a
// commercial, sharing a length budget (max_spot_minutes x between_spots) - a spot much
// longer than usual still plays, it just leaves less room for the rest of the pod rather
// than being excluded. Inside a show: one commercial (with inside_spots 2, a second one
// when both are short_spot_seconds or less) - here the bookends only happen where
// wantsEyecatches says so (broadcast.eyecatches). From different groups. show: the row of
// the show the break is inside.
export function makeBreak(plex, { theme = null, inside = false, show = null } = {}) {
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
    const mode = String(b.eyecatches || "none").toLowerCase();
    if (rows.length && wantsEyecatches(show, mode)) {
      const into = pickEyecatch(show, rows.map((x) => x.id));
      const outOf = pickEyecatch(show, [...rows, into].filter(Boolean).map((x) => x.id)) || into;
      if (into) rows.unshift(into);
      if (outOf) rows.push(outOf);
    }
  } else {
    // Always bookended, same as inside: an eyecatch to lead in and one to close, different
    // ones where the pool allows it.
    const into = pickEyecatch(null, []);
    if (into) rows.push(into);
    // A length budget for the pod as a whole (between_spots normal-length spots' worth).
    // Only the last spot may reach into whatever's left of it - pick() doesn't favor
    // shorter picks, so letting every spot see the full budget made a much-longer-than-
    // usual pick the common case instead of the occasional one. The last spot going long
    // still isn't piled onto by anything after it.
    let budget = maxMs * b.between_spots;
    for (let k = 0; k < b.between_spots && budget > 0; k++) {
      const cap = k === b.between_spots - 1 ? budget : Math.min(maxMs, budget);
      const r = add(Math.random() < b.clip_chance ? "clip" : "commercial", cap);
      if (r) budget -= r.duration_ms;
    }
    const outOf = pickEyecatch(null, [...rows, into].filter(Boolean).map((x) => x.id)) || into;
    if (outOf) rows.push(outOf);
  }
  remember(rows);
  const breakId = newBreakId();
  const segs = rows.map((r) => toSegment(r, plex, { breakId }));
  // The weather report leads the first break between shows after a scheduled time
  // (config weather.times), or the next break of any kind after /weather.
  const wx = takeWeather(Date.now(), { inside });
  return timed(wx ? [{ ...wx, breakId }, ...segs] : segs);
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
const FILL_MIN_POOL = 4; // fewer fitting files than this: leave the rest to the "Up next" card
export function fillBreak(plex, ms, { theme = null, upNextTitle = null } = {}) {
  const rows = [];
  const groups = new Set();
  let left = ms;
  for (;;) {
    const kind = rows.length % 4 === 3 ? "clip" : "commercial";
    const avoid = rows.slice(-2).map((x) => x.id); // small libraries may repeat, never back-to-back
    const r = pick(kind, theme, avoid, left, groups, false, FILL_MIN_POOL) || pick(kind === "clip" ? "commercial" : "clip", theme, avoid, left, groups, false, FILL_MIN_POOL);
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
