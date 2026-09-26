// Turns the week's grid (plan_slots) into blocks, in code: each slot is filled back to
// back with blocks of random picks from its bucket. Picks favor what hasn't aired
// lately, so the whole catalog gets turns (no popularity bias); episodes stay in order
// for in-order shows; nothing repeats within no_repeat_days; one show at most once a day.
import { config } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";
import { localDay, gridMs, season } from "./time.js";
import { saveBlocks, usedIds, blockAt, nextBlockAfter } from "./store.js";
import { listBuckets, inSeason, daypart, isMovieFormat } from "./buckets.js";
import { blockLength, inOrder, nextInOrder } from "./generate.js";

const DAY = 86400000;
const TRIES = 12;
const hourOf = (ms) => Number(new Intl.DateTimeFormat("en-US", { timeZone: config.broadcast.timezone, hourCycle: "h23", hour: "2-digit" }).format(new Date(ms)));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Shared state for one fill run.
function makeCtx(fromMs) {
  const db = getDb();
  const N = config.broadcast.no_repeat_days * DAY;
  const ctx = {
    used: usedIds(fromMs - N, fromMs + 60 * DAY),
    showLast: new Map(db.prepare(`SELECT i.show_title t, MAX(b.start_at) at FROM block_items bi JOIN blocks b ON b.id = bi.block_id
      JOIN items i ON i.id = bi.item_id WHERE i.show_title IS NOT NULL GROUP BY i.show_title`).all().map((r) => [r.t, r.at])),
    itemLast: new Map(db.prepare(`SELECT bi.item_id i, MAX(b.start_at) at FROM block_items bi JOIN blocks b ON b.id = bi.block_id
      JOIN items it ON it.id = bi.item_id WHERE it.kind = 'movie' GROUP BY bi.item_id`).all().map((r) => [r.i, r.at])),
    showsOnDay: new Map(), // "YYYY-MM-DD" -> Set of show titles
    tagOf: db.prepare("SELECT holiday FROM tags WHERE item_id = ?"),
    item: db.prepare(`SELECT * FROM items i WHERE i.id = ? AND ${schedulableSql("i")}`),
    randomEps: db.prepare(`SELECT i.* FROM items i LEFT JOIN tags t ON t.item_id = i.id WHERE i.kind = 'episode' AND i.show_title = ?
      AND ${schedulableSql("i")} AND COALESCE(t.holiday, 'none') = 'none' ORDER BY random() LIMIT 30`),
  };
  ctx.dayShows = (ms) => {
    const day = localDay(ms);
    if (!ctx.showsOnDay.has(day.date)) {
      ctx.showsOnDay.set(day.date, new Set(db.prepare(`SELECT DISTINCT i.show_title t FROM blocks b JOIN block_items bi ON bi.block_id = b.id
        JOIN items i ON i.id = bi.item_id WHERE b.start_at >= ? AND b.start_at < ? AND i.show_title IS NOT NULL`).all(day.startMs, day.endMs).map((r) => r.t)));
    }
    return ctx.showsOnDay.get(day.date);
  };
  // Holiday-tagged items only in their own season.
  ctx.seasonOk = (row, at) => {
    const h = ctx.tagOf.get(row.id)?.holiday;
    return !h || h === "none" || h === season(localDay(at)).theme;
  };
  return ctx;
}

// Least recently aired first (never aired first of all), ties at random; then a random
// pick from the stalest third, so it isn't strictly a rotation either.
function stalest(list, lastOf) {
  const sorted = shuffle([...list]).sort((a, b) => (lastOf(a) || 0) - (lastOf(b) || 0));
  return shuffle(sorted.slice(0, Math.max(3, Math.ceil(sorted.length / 3))));
}

// In order or shuffled: a show's own setting in config.yaml (shows.random / in_order)
// comes first, then the bucket's (buckets.shuffle / in_order), then whether Claude
// called the show serialized.
function orderedIn(show, bucket) {
  const has = (list, x) => (list || []).includes(x);
  if (has(config.shows?.random, show)) return false;
  if (has(config.shows?.in_order, show)) return true;
  if (bucket && has(config.buckets?.shuffle, bucket.name)) return false;
  if (bucket && has(config.buckets?.in_order, bucket.name)) return true;
  return inOrder(show);
}

function episodesOf(show, count, at, ctx, bucket) {
  const eps = orderedIn(show, bucket) ? nextInOrder(show, count, ctx.used, at) : ctx.randomEps.all(show).filter((e) => !ctx.used.has(e.id)).slice(0, count);
  return eps.filter((e) => e.duration_ms);
}

const run = (rows) => rows.reduce((n, r) => n + r.duration_ms, 0);
const maxShow = () => config.broadcast.max_show_block_minutes * 60000;
const fits = (rows, room) => {
  const l = blockLength(run(rows), rows.length);
  return l.lengthMs <= room ? l : null;
};

// One block from this bucket in at most `room` ms, or null. Returns { rows, lengthMs }.
function pickBlock(bucket, at, room, ctx) {
  const today = ctx.dayShows(at);
  if (bucket.format === "one_show") {
    let shows = stalest(bucket.shows.filter((s) => !today.has(s)), (s) => ctx.showLast.get(s));
    // The premiere bucket: only serialized shows that would start from episode one.
    if (bucket.premiere) shows = shows.filter((s) => inOrder(s) && !(ctx.showLast.get(s) > at - 30 * DAY));
    for (const show of shows.slice(0, TRIES)) {
      const eps = episodesOf(show, 6, at, ctx, bucket);
      for (let k = eps.length; k >= 1; k--) {
        const l = fits(eps.slice(0, k), Math.min(room, maxShow()));
        if (l) return { rows: eps.slice(0, k), lengthMs: l.lengthMs };
      }
    }
    return null;
  }
  if (bucket.format === "variety") {
    // Single episodes of different shows (or the bucket's own episodes); the best of a
    // few random combinations (the one that fills the block best).
    const pool = [];
    for (const show of stalest(bucket.shows.filter((s) => !today.has(s)), (s) => ctx.showLast.get(s)).slice(0, 16)) {
      const e = episodesOf(show, 1, at, ctx, bucket)[0];
      if (e) pool.push(e);
    }
    for (const id of shuffle([...bucket.items]).slice(0, 40)) {
      const e = ctx.item.get(id);
      if (e?.duration_ms && !ctx.used.has(e.id) && ctx.seasonOk(e, at)) pool.push(e);
    }
    let best = null;
    for (let t = 0; t < TRIES; t++) {
      const rows = [];
      for (const e of shuffle([...pool])) {
        if (rows.some((r) => r.show_title && r.show_title === e.show_title)) continue;
        if (fits([...rows, e], Math.min(room, maxShow()))) rows.push(e);
      }
      const l = rows.length && fits(rows, Math.min(room, maxShow()));
      if (l && (!best || run(rows) > run(best.rows))) best = { rows, l };
    }
    return best && { rows: best.rows, lengthMs: best.l.lengthMs };
  }
  if (bucket.format === "movie") {
    const movies = bucket.items.map((id) => ctx.item.get(id)).filter((m) => m?.duration_ms && !ctx.used.has(m.id) && ctx.seasonOk(m, at) && fits([m], room));
    const m = stalest(movies, (x) => ctx.itemLast.get(x.id))[0];
    return m ? { rows: [m], lengthMs: fits([m], room).lengthMs } : null;
  }
  if (bucket.format === "movie_series") {
    // The next one in order after the series' most recently aired member; from the top
    // after the finale (or if nothing aired yet).
    const members = bucket.items.map((id) => ctx.item.get(id)).filter((m) => m?.duration_ms);
    const last = members.reduce((best, m, i) => ((ctx.itemLast.get(m.id) || 0) > (best.at || 0) ? { i, at: ctx.itemLast.get(m.id) } : best), {});
    const next = last.at && last.i < members.length - 1 ? members[last.i + 1] : members[0];
    // A series only restarts after the no-repeat window.
    if (!next || ctx.used.has(next.id)) return null;
    const l = fits([next], room);
    return l ? { rows: [next], lengthMs: l.lengthMs } : null;
  }
  return null;
}

// A serialized show starting from its very first episode gets billed as a premiere.
const isPremiere = (rows) => rows[0]?.kind === "episode" && inOrder(rows[0].show_title) && rows[0].season === 1 && rows[0].episode === 1;

function place(bucket, at, pick, ctx) {
  const theme = bucket.source === "auto" ? season(localDay(at)).theme : null;
  const label = bucket.format === "one_show" && isPremiere(pick.rows) ? "Series Premiere" : bucket.name;
  saveBlocks([{ start: at, end: at + pick.lengthMs, label, ids: pick.rows.map((r) => r.id), theme: theme && theme !== "none" ? theme : null, bucketId: bucket.id }], "bucket");
  for (const r of pick.rows) {
    ctx.used.add(r.id);
    if (r.show_title) { ctx.showLast.set(r.show_title, at); ctx.dayShows(at).add(r.show_title); }
    if (r.kind === "movie") ctx.itemLast.set(r.id, at);
  }
  return at + pick.lengthMs;
}

// Fill [at, to) from this bucket; other buckets that fit the time of day take over if it
// runs dry. Returns where it stopped (a quarter hour or so short of `to` at most,
// unless nothing at all fits).
function fillWindow(bucket, at, to, ctx, buckets) {
  let dry = 0;
  while (to - at >= gridMs()) {
    let b = bucket;
    let pick = dry ? null : pickBlock(b, at, to - at, ctx);
    if (!pick) {
      // This bucket is out of things that fit: another in-season bucket for this time of
      // day, shows first (they fit any length).
      dry++;
      const day = localDay(at);
      const others = shuffle(buckets.filter((x) => x.id !== bucket.id && inSeason(x, day) && x.dayparts.includes(daypart(hourOf(at)))))
        .sort((x, y) => isMovieFormat(x.format) - isMovieFormat(y.format));
      for (const o of others) if ((pick = pickBlock(o, at, to - at, ctx))) { b = o; break; }
      if (!pick) break;
    }
    at = place(b, at, pick, ctx);
  }
  return at;
}

// Fill blocks from fromMs until at least toMs, following the grid. Existing blocks
// (specials, what's already planned) are kept and worked around. Returns
// { until, needPlan } — needPlan when the grid runs out before toMs.
export function fillSchedule(fromMs, toMs) {
  const db = getDb();
  const buckets = listBuckets();
  const byId = new Map(listBuckets({ all: true }).map((b) => [b.id, b]));
  const ctx = makeCtx(fromMs);
  const slotAt = db.prepare("SELECT * FROM plan_slots WHERE start_at <= ? ORDER BY start_at DESC LIMIT 1");
  const slotAfter = db.prepare("SELECT * FROM plan_slots WHERE start_at > ? ORDER BY start_at LIMIT 1");
  let t = fromMs;
  let carry = null; // a slot that starts early because the one before it couldn't fill its time exactly
  let blocks = 0;
  while (t < toMs) {
    const covering = blockAt(t);
    if (covering) { t = covering.end_at; carry = null; continue; }
    const slot = carry || slotAt.get(t);
    const next = slot && slotAfter.get(slot.start_at);
    if (!slot || !next) return { until: t, needPlan: true, blocks };
    carry = null;
    let to = next.start_at;
    let hard = false;
    const fixed = nextBlockAfter(t);
    if (fixed && fixed.start_at < to) { to = fixed.start_at; hard = true; }
    if (to <= t) { carry = hard ? null : next; if (hard) t = to; continue; }
    const before = t;
    t = fillWindow(byId.get(slot.bucket_id), t, to, ctx, buckets);
    blocks += db.prepare("SELECT COUNT(*) n FROM blocks WHERE start_at >= ? AND start_at < ?").get(before, t).n;
    if (t < to) {
      if (hard) {
        // Up against a special: the last block runs a little longer (more commercials)
        // rather than leave dead air; a bigger hole stays empty (off-air card).
        const prev = db.prepare("SELECT id FROM blocks WHERE end_at = ? AND source = 'bucket'").get(t);
        if (prev && to - t <= 30 * 60000) db.prepare("UPDATE blocks SET end_at = ? WHERE id = ?").run(to, prev.id);
        else log.warn(`fill: nothing fits ${Math.round((to - t) / 60000)} min before a special at ${new Date(to).toISOString()}`);
        t = to;
      } else {
        carry = next; // the next slot starts early
      }
    }
  }
  return { until: t, needPlan: false, blocks };
}
