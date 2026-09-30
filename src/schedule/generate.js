// The schedule: Claude sorts the catalog into buckets (kinds of blocks; buckets.js) and
// lays out each week as a grid of bucket slots (weekplan.js); code fills the slots with
// random picks from each bucket (fill.js). Claude never picks individual titles.
import { config } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { schedulableSql, themeHolidaySql } from "../catalog/schedulable.js";
import { localDay, gridMs } from "./time.js";
import { deleteBlocksFrom, blocksBetween } from "./store.js";
import { withScheduleLock } from "./lock.js";
import { ensureBuckets } from "./buckets.js";
import { planWeek, lastPlannedSlot } from "./weekplan.js";
import { fillSchedule } from "./fill.js";
import { LONG_MS, adAfter } from "../adload.js";

const DAY = 86400000;

// How long a block is planned to run: its shows plus the commercials expected with them
// (between_spots per show, and one or two about every 10 minutes inside shows, at the
// library's average length), to the nearest grid step but never less than the shows
// plus half a minute. Only a plan: while the TV is on, the schedule moves to match what
// actually played. Returns { lengthMs, adMs }.
let avgSpot = null;
export function blockLength(contentMs, items = 1) {
  if (avgSpot === null) {
    const r = getDb().prepare(`SELECT AVG(duration_ms) a FROM items WHERE kind IN ('commercial', 'clip') AND present = 1 AND playable = 1
      AND duplicate_of IS NULL AND duration_ms <= ?`).get(config.broadcast.max_spot_minutes * 60000);
    avgSpot = r?.a || 30000;
  }
  // Movies and hour-long shows (items averaging 40+ minutes) are planned at
  // broadcast.ad_minutes_per_hour, the same figure their breaks are sized to; anything
  // shorter gets between_spots per item plus a spot or so per 8 minutes.
  const ads = contentMs / items >= LONG_MS
    ? adAfter(contentMs)
    : (items * config.broadcast.between_spots + (contentMs / 600000) * 1.3) * avgSpot;
  const g = gridMs();
  const lengthMs = Math.max(Math.round((contentMs + ads) / g) * g, Math.ceil((contentMs + 30000) / g) * g);
  return { lengthMs, adMs: lengthMs - contentMs };
}

// Serialized shows air in order, episodic ones in any order (Claude decides per show;
// shows.random / shows.in_order in config.yaml override it). Undecided: in order.
export const inOrder = (title) => {
  if ((config.shows?.random || []).includes(title)) return false;
  if ((config.shows?.in_order || []).includes(title)) return true;
  return getDb().prepare("SELECT serialized FROM shows WHERE title = ?").get(title)?.serialized !== 0;
};

const RESTART_MS = 30 * DAY;

// For in-order shows: the next `count` episodes after the last one that aired before
// `beforeMs` (holiday episodes aired out of order don't count), wrapping around after
// the finale. A show that hasn't aired in RESTART_MS (or ever) starts over from its
// first episode, a series premiere.
export function nextInOrder(title, count, used, beforeMs) {
  const db = getDb();
  const eps = db.prepare(`SELECT i.* FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = 'episode' AND i.show_title = ? AND ${schedulableSql("i")} AND COALESCE(t.holiday, 'none') = 'none' AND ${themeHolidaySql("i")} IS NULL
    ORDER BY i.season IS NULL OR i.season = 0, i.season, i.episode IS NULL, i.episode, i.id`).all(title);
  const last = db.prepare(`SELECT i.id, i.season, i.episode, b.start_at FROM block_items bi JOIN blocks b ON b.id = bi.block_id JOIN items i ON i.id = bi.item_id
    LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.show_title = ? AND b.start_at < ? AND COALESCE(t.holiday, 'none') = 'none' AND ${themeHolidaySql("i")} IS NULL
    ORDER BY b.start_at DESC, bi.position DESC LIMIT 1`).get(title, beforeMs);
  let start = 0;
  if (last && beforeMs - last.start_at < RESTART_MS) {
    const at = eps.findIndex((e) => e.id === last.id);
    // The copy that aired may not be schedulable any more (dedupe now keeps another copy,
    // its drive is unplugged): carry on after the same season/episode, not from the top.
    const key = (e) => [e.season == null || e.season === 0 ? 1 : 0, e.season ?? 0, e.episode == null ? 1 : 0, e.episode ?? 0];
    const later = (e) => { const a = key(e), b = key(last); const i = a.findIndex((x, k) => x !== b[k]); return i >= 0 && a[i] > b[i]; };
    start = at >= 0 ? at + 1 : Math.max(0, eps.findIndex(later));
  }
  const out = [];
  for (let k = 0; k < eps.length && out.length < count; k++) {
    const e = eps[(start + k) % eps.length];
    if (!used.has(e.id)) out.push(e);
  }
  return out;
}

// Fill `days` days of air time from fromMs. Buckets are made (first run) or topped up
// (weekly) first; the grid is planned a week at a time as needed; then code fills it.
// replace: throw away everything after the current block and fill again (free: same
// grid, new random picks). replan: also ask Claude for a new grid.
export async function generateSchedule(opts = {}, { locked = false } = {}) {
  return locked ? generateUnlocked(opts) : withScheduleLock(() => generateUnlocked(opts));
}

async function generateUnlocked({ fromMs = Date.now(), days = config.broadcast.plan_days, replace = false, replan = false } = {}) {
  if (replace || replan) {
    const current = blocksBetween(fromMs, fromMs + 1)[0];
    const cut = current ? current.end_at : fromMs;
    log.info(`schedule: replacing ${deleteBlocksFrom(cut)} future blocks`);
    fromMs = cut;
  }
  await ensureBuckets();
  const toMs = fromMs + days * DAY;
  if (replan) await planWeek({ fromMs, count: Math.max(7, Math.ceil(days) + 1) });
  for (let round = 0; round < 4; round++) {
    // Keep the grid grid_weeks_ahead weeks out (a buffer: if a planning call fails, the
    // days keep filling from the grid already there); a week is added whenever less than
    // grid_weeks_ahead - 1 weeks are left past toMs.
    const buffer = Math.max(0, (config.broadcast.grid_weeks_ahead ?? 2) - 1) * 7 * DAY;
    for (let k = 0; k < 4; k++) {
      const last = lastPlannedSlot();
      if (last && last > toMs + buffer) break;
      await planWeek({ fromMs: last && last > fromMs ? localDay(last).endMs : fromMs, count: 7 });
    }
    const r = fillSchedule(fromMs, toMs);
    log.info(`schedule: filled ${r.blocks} blocks up to ${new Date(r.until).toISOString()}`);
    if (!r.needPlan) return;
    fromMs = r.until;
  }
}
