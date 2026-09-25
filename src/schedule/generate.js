// The schedule: Claude sorts the catalog into buckets (kinds of blocks; buckets.js) and
// lays out each week as a grid of bucket slots (weekplan.js); code fills the slots with
// random picks from each bucket (fill.js). Claude never picks individual titles.
import { config } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";
import { localDay, gridMs } from "./time.js";
import { deleteBlocksFrom, blocksBetween } from "./store.js";
import { withScheduleLock } from "./lock.js";
import { ensureBuckets } from "./buckets.js";
import { planWeek, lastPlannedSlot } from "./weekplan.js";
import { fillSchedule } from "./fill.js";

const DAY = 86400000;

// How long a block runs: its shows plus at least min_ad_minutes_per_hour of ads,
// rounded up to the grid. Returns { lengthMs, adMs, adPerHour }.
export function blockLength(contentMs) {
  const rate = config.broadcast.min_ad_minutes_per_hour / 60;
  const lengthMs = Math.ceil(contentMs / (1 - rate) / gridMs()) * gridMs();
  const adMs = lengthMs - contentMs;
  return { lengthMs, adMs, adPerHour: (adMs / lengthMs) * 60 };
}

// Shows play their episodes in order unless listed under shows.random.
export const inOrder = (title) => !(config.shows?.random || []).includes(title);

// For shows set to air in order: the next `count` episodes after the last one that
// aired before `beforeMs` (holiday episodes aired out of order don't count), wrapping
// around at the end of the series.
export function nextInOrder(title, count, used, beforeMs) {
  const db = getDb();
  const eps = db.prepare(`SELECT i.* FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = 'episode' AND i.show_title = ? AND ${schedulableSql("i")} AND COALESCE(t.holiday, 'none') = 'none'
    ORDER BY i.season IS NULL OR i.season = 0, i.season, i.episode IS NULL, i.episode, i.id`).all(title);
  const last = db.prepare(`SELECT i.id FROM block_items bi JOIN blocks b ON b.id = bi.block_id JOIN items i ON i.id = bi.item_id
    LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.show_title = ? AND b.start_at < ? AND COALESCE(t.holiday, 'none') = 'none'
    ORDER BY b.start_at DESC, bi.position DESC LIMIT 1`).get(title, beforeMs)?.id;
  // Never aired before: jump in anywhere; from then on it continues in order.
  const start = last ? eps.findIndex((e) => e.id === last) + 1 : Math.floor(Math.random() * eps.length);
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
    // The grid has to reach past toMs (a slot ends where the next one starts).
    const last = lastPlannedSlot();
    if (!last || last <= toMs) await planWeek({ fromMs: last && last > fromMs ? localDay(last).endMs : fromMs, count: 7 });
    const r = fillSchedule(fromMs, toMs);
    log.info(`schedule: filled ${r.blocks} blocks up to ${new Date(r.until).toISOString()}`);
    if (!r.needPlan) return;
    fromMs = r.until;
  }
}
