// Airing limits. Two kinds, both checked while the filler lays blocks out (fill.js), so a
// bucket that is at a limit simply sits that slot out and another bucket takes the time:
//
//  - Per bucket (the bucket editor; NULL = no limit): blocked_days (weekdays it never airs),
//    max_per_day (separate airings on one day), min_gap_days (whole days between days it
//    airs), max_hours_week (airtime in a Monday-Sunday week), max_run_minutes (longest stretch
//    back to back).
//  - For everyone (config.yaml, broadcast.*): a "run" is blocks of one bucket (or one special)
//    back to back. A run of marathon_minutes or more is a marathon, and max_marathons_per_day
//    of those fit on a day; a run is never longer than max_marathon_minutes (a bucket's own
//    max_run_minutes replaces that); and no more than max_marathon_movies movies play back to
//    back, which is why a double feature is fine and a six-movie night isn't.
import { config } from "../config.js";
import { getDb } from "../db.js";
import { localDay } from "./time.js";
import { isMovieFormat } from "./buckets.js";

const DAY = 86400000;
const MIN = 60000;
const ADJACENT = 60000; // blocks this close to touching count as back to back
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const dayNum = (ms) => { const d = localDay(ms); return Math.round(Date.UTC(d.y, d.m - 1, d.d) / DAY); };
const weekNum = (ms) => Math.floor((dayNum(ms) + 3) / 7); // weeks run Monday-Sunday (1970-01-01 was a Thursday)
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export function blockedDays(b) {
  try { return JSON.parse(b.blocked_days || "[]").filter((d) => WEEKDAYS.includes(d)); } catch { return []; }
}
export const blockedOn = (b, weekday) => blockedDays(b).includes(weekday);

// Every block from three weeks back to two months ahead (what a limit has to look at), oldest
// first. key: the bucket's id, or the label for a special.
export function loadHistory(fromMs) {
  return getDb().prepare(`SELECT b.start_at, b.end_at, b.bucket_id, COALESCE(b.bucket_id, 'S:' || b.label) key,
      (SELECT COUNT(*) FROM block_items bi JOIN items i ON i.id = bi.item_id WHERE bi.block_id = b.id AND i.kind = 'movie') movies
    FROM blocks b WHERE b.end_at > ? AND b.start_at < ? ORDER BY b.start_at`)
    .all(fromMs - 21 * DAY, fromMs + 60 * DAY)
    .map((r) => ({ start: r.start_at, end: r.end_at, key: String(r.key), bucketId: r.bucket_id, movies: r.movies }));
}

export function addToHistory(hist, block) {
  hist.push({ key: String(block.bucketId ?? `S:${block.label}`), ...block });
  hist.sort((a, b) => a.start - b.start);
}

// Blocks back to back with the same key, as { key, start, end, movies }.
function runsOf(hist) {
  const runs = [];
  const open = new Map(); // key -> the run still growing
  for (const h of [...hist].sort((a, b) => a.start - b.start)) {
    const r = open.get(h.key);
    if (r && Math.abs(h.start - r.end) < ADJACENT) { r.end = Math.max(r.end, h.end); r.movies += h.movies; }
    else { const n = { key: h.key, start: h.start, end: h.end, movies: h.movies }; open.set(h.key, n); runs.push(n); }
  }
  return runs;
}

const maxMovies = () => Number(config.broadcast.max_marathon_movies) || 2;
const marathonMs = () => (Number(config.broadcast.marathon_minutes) || 180) * MIN;
// A few movies back to back (a double feature) isn't a marathon, however long it runs.
const isMarathon = (run) => run.end - run.start >= marathonMs() && !(run.movies > 0 && run.movies <= maxMovies());

// Why `bucket` may not air a block of lengthMs (holding `movies` movies) at `at`, or null.
export function violation(bucket, at, lengthMs, movies, hist) {
  const day = localDay(at);
  if (blockedDays(bucket).includes(day.weekday)) return `never on ${day.weekday}s`;

  const mine = hist.filter((h) => h.bucketId === bucket.id);
  // The run this block would join: blocks of the bucket ending right where it starts.
  let start = at, runMovies = 0;
  for (let prev; (prev = mine.find((h) => Math.abs(h.end - start) < ADJACENT && h.start < start));) { start = prev.start; runMovies += prev.movies; }
  const extending = start < at;
  const runMs = at - start + lengthMs;
  runMovies += movies;

  if (runMovies > maxMovies()) return `at most ${maxMovies()} movies back to back`;
  const own = num(bucket.max_run_minutes);
  const cap = own ?? (isMovieFormat(bucket.format) ? null : Number(config.broadcast.max_marathon_minutes) || null);
  if (extending && cap != null && runMs > cap * MIN) return `a run is at most ${cap} minutes`;

  if (!extending) {
    const today = dayNum(at);
    const perDay = num(bucket.max_per_day);
    if (perDay != null && runsOf(mine).filter((r) => dayNum(r.start) === today).length >= perDay) return `already on ${perDay} time${perDay === 1 ? "" : "s"} today`;
    const gap = num(bucket.min_gap_days);
    if (gap != null && mine.some((h) => dayNum(h.start) !== today && Math.abs(dayNum(h.start) - today) <= gap)) return `needs ${gap} day${gap === 1 ? "" : "s"} between airings`;
  }

  const weekly = num(bucket.max_hours_week);
  if (weekly != null) {
    const wk = weekNum(at);
    const used = mine.filter((h) => weekNum(h.start) === wk).reduce((n, h) => n + (h.end - h.start), 0);
    if (used + lengthMs > weekly * 3600000) return `${weekly} hours a week is used up`;
  }

  // A run that has become a marathon: only so many of them on a day (specials count).
  const asRun = { start, end: at + lengthMs, movies: runMovies };
  if (isMarathon(asRun)) {
    const limit = Number(config.broadcast.max_marathons_per_day) || 1;
    const others = runsOf(hist).filter((r) => isMarathon(r) && dayNum(r.start) === dayNum(start) && !(r.key === String(bucket.id) && r.start === start));
    if (others.length >= limit) return "a marathon already airs that day";
  }
  return null;
}
