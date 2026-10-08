// The week's grid from a template instead of Claude (claude.scheduling: local):
// programming.yaml lists pools of buckets and, for each weekday, the slot times and
// which pool each draws from. Each slot takes the least recently used bucket of its pool
// that may air then (daypart, season window, at most twice a day), so the weeks rotate
// by themselves. The weekly Claude Code job (PROGRAMMING.md) edits the template when the
// season or the catalog calls for it.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { config, ROOT } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { localToUtc } from "./time.js";
import { inSeason, daypart } from "./buckets.js";

export const TEMPLATE_FILE = join(ROOT, "programming.yaml");
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function loadTemplate() {
  if (!existsSync(TEMPLATE_FILE)) throw new Error(`${TEMPLATE_FILE} is missing`);
  const t = YAML.parse(readFileSync(TEMPLATE_FILE, "utf8"));
  for (const d of WEEKDAYS) if (!Array.isArray(t.days?.[d])) throw new Error(`programming.yaml: no slots for ${d}`);
  return t;
}

// Problems with the template against the current buckets (for the weekly job's check).
export function checkTemplate(t, buckets) {
  const names = new Set(buckets.map((b) => b.name));
  const problems = [];
  for (const [pool, list] of Object.entries(t.pools || {})) for (const n of list) if (!names.has(n)) problems.push(`pool ${pool}: no bucket "${n}"`);
  for (const d of WEEKDAYS) {
    let prev = -1;
    for (const [hhmm, pool] of t.days[d]) {
      const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
      if (!m || +m[1] > 23 || +m[2] % 15) problems.push(`${d} ${hhmm}: not a quarter-hour time`);
      const mins = m ? +m[1] * 60 + +m[2] : 0;
      if (mins <= prev) problems.push(`${d} ${hhmm}: times must go up`);
      if (prev >= 0 && mins - prev < 60) problems.push(`${d} ${hhmm}: under an hour after the slot before`);
      prev = mins;
      if (pool !== "STANDING" && !t.pools?.[pool]) problems.push(`${d} ${hhmm}: no pool "${pool}"`);
    }
    if (t.days[d][0]?.[0] !== "00:00") problems.push(`${d}: the first slot must be 00:00`);
  }
  return problems;
}

// How far into its window a seasonal bucket is on this day: 0 on active_from, 1 on active_to
// (windows may wrap New Year). Year-round buckets: 1.
function seasonProgress(b, day) {
  if (!b.active_from || !b.active_to) return 1;
  const [fm, fd] = b.active_from.split("-").map(Number);
  const [tm, td] = b.active_to.split("-").map(Number);
  const wraps = b.active_from > b.active_to;
  const startYear = wraps && `${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}` <= b.active_to ? day.y - 1 : day.y;
  const start = Date.UTC(startYear, fm - 1, fd), end = Date.UTC(startYear + (wraps ? 1 : 0), tm - 1, td);
  return end > start ? Math.min(1, Math.max(0, (Date.UTC(day.y, day.m - 1, day.d) - start) / (end - start))) : 1;
}

// Stable 0..1 roll for a bucket in a slot, so replanning a day doesn't reshuffle it.
function roll(...parts) {
  let h = 2166136261;
  for (const c of parts.join("|")) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

// Buckets that are mostly anime (60%+ of their shows/movies are tagged anime), by name. Catch-alls don't count.
function animeBuckets(buckets) {
  const db = getDb();
  const show = db.prepare("SELECT anime FROM shows WHERE title = ?");
  const movie = db.prepare("SELECT anime FROM tags WHERE item_id = ?");
  const out = new Set();
  for (const b of buckets) {
    const n = b.shows.length + b.items.length;
    if (b.source === "fallback" || !n) continue;
    const anime = b.shows.filter((t) => show.get(t)?.anime).length + b.items.filter((i) => movie.get(i)?.anime).length;
    if (anime / n >= 0.6) out.add(b.name);
  }
  return out;
}

// Slots for `days` ([{ weekday, y, m, d, ... }]). Recent grid history seeds the rotation so
// one week doesn't repeat the last.
export function templateSlots(days, buckets) {
  const t = loadTemplate();
  const byName = new Map(buckets.map((b) => [b.name, b]));
  const lastUsed = new Map();
  let tick = 0;
  for (const r of getDb().prepare(`SELECT b.name FROM plan_slots p JOIN buckets b ON b.id = p.bucket_id WHERE p.start_at >= ? AND p.start_at < ? ORDER BY p.start_at`)
    .all(days[0].startMs - 21 * 86400000, days[0].startMs)) lastUsed.set(r.name, tick++);
  const standing = config.broadcast.standing_slots || [];
  // mix.anime_max_share (programming.yaml): once anime holds this share of the slots laid out so far,
  // anime buckets sit out while any other bucket in the pool can air.
  const maxAnime = Number(t.mix?.anime_max_share) || 0;
  const anime = maxAnime ? animeBuckets(buckets) : new Set();
  let animeSlots = 0;
  const rampMin = Math.min(1, Math.max(0, Number(t.mix?.season_ramp_min ?? 0.15)));
  const slots = [];
  for (const day of days) {
    const used = new Map();
    for (const [hhmm, pool] of t.days[day.weekday]) {
      const [h, m] = String(hhmm).split(":").map(Number);
      const at = localToUtc(day.y, day.m, day.d, h, m);
      let b;
      if (pool === "STANDING") {
        // Filled in by applyStandingSlots; use its bucket here so the slot isn't empty.
        const rule = standing.find((r) => day.weekday.toLowerCase().startsWith(String(r.day).toLowerCase().slice(0, 3)) && r.from === hhmm);
        b = rule && byName.get(rule.bucket);
      } else {
        const ok = (t.pools[pool] || []).map((n) => byName.get(n)).filter((x) => x && inSeason(x, day) && x.dayparts.includes(daypart(h)) && (used.get(x.name) || 0) < 2);
        // Seasonal buckets ramp up: a slot's chance of taking one is season_ramp_min on its first day,
        // rising to 1 by the end of its window (skipped if that would leave nothing to air).
        const ramped = ok.filter((x) => !x.active_from || roll(day.date, hhmm, x.name) < rampMin + (1 - rampMin) * seasonProgress(x, day));
        if (ramped.length) ok.splice(0, ok.length, ...ramped);
        ok.sort((x, y) => (lastUsed.get(x.name) ?? -1) - (lastUsed.get(y.name) ?? -1));
        const capped = maxAnime && slots.length >= 4 && animeSlots / slots.length >= maxAnime;
        b = (capped && ok.find((x) => !anime.has(x.name))) || ok[0];
      }
      if (!b) { log.warn(`plan: template: nothing can air ${day.weekday} ${day.date} ${hhmm} (pool ${pool}); the slot before runs on`); continue; }
      lastUsed.set(b.name, tick++);
      used.set(b.name, (used.get(b.name) || 0) + 1);
      if (anime.has(b.name)) animeSlots++;
      slots.push({ at, bucket: b });
    }
  }
  return slots;
}
