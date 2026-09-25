// Weekly schedule: Claude programs each day from a menu of candidates; code checks
// the result (ids, fit, repeats, labels) and sends problems back, a few times at most,
// then falls back to a simple schedule built in code.
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";
import { localDay, localTime, season, gridMs, gridCeil, gridFloor, nextWindow } from "./time.js";
import { saveBlocks, deleteBlocksFrom, usedIds, blocksBetween, nextBlockAfter } from "./store.js";
import { withScheduleLock } from "./lock.js";

const DAY = 86400000;
const EPISODES_PER_SHOW = 5;
const MAX_ATTEMPTS = 3;

// How long a block runs: its shows plus at least min_ad_minutes_per_hour of ads,
// rounded up to the grid. Returns { lengthMs, adMs, adPerHour }.
export function blockLength(contentMs) {
  const rate = config.broadcast.min_ad_minutes_per_hour / 60;
  const lengthMs = Math.ceil(contentMs / (1 - rate) / gridMs()) * gridMs();
  const adMs = lengthMs - contentMs;
  return { lengthMs, adMs, adPerHour: (adMs / lengthMs) * 60 };
}

const SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          ids: { type: "array", items: { type: "integer" } },
        },
        required: ["label", "ids"],
        additionalProperties: false,
      },
    },
  },
  required: ["blocks"],
  additionalProperties: false,
};

const SYSTEM = `You program a stretch of a retro cable-TV style channel for a group of friends. You get the start time, roughly how long to fill, and a menu of shows, movies and episodes; you return a list of blocks that play back to back.

How block lengths work (done by code, not you): each block runs its items plus at least ${config.broadcast.min_ad_minutes_per_hour} minutes of commercials per hour, rounded UP to the next quarter hour (:00, :15, :30, :45). So pick items whose total length lands a few minutes under a quarter-hour mark, or the rounding leaves too many commercials. Example: three 22.5-minute episodes (67.5 min) make a 75-minute block with 7.5 minutes of ads; two of them (45 min) would need a 60-minute block with 15 minutes of ads, which is too much.

Rules:
- A block holds items that go together (same show, or shows with a similar feel), in a sensible order. Mix it up; don't run the same show all day.
- A movie always gets a block to itself. Blocks of episodes run at most ${config.broadcast.max_show_block_minutes} minutes (commercials included), so about three half-hour episodes or one or two hour-long ones.
- Regular blocks are not marathons: don't use "Marathon" in labels (marathons are separate specials).
- Only use ids from the menu, and each id at most once. Use a show's episodes in the order listed, unless the show is marked "any order".
- label: a short plain description of the block in 1 to 3 words, like "Sitcoms", "Cartoons", "Halloween Specials", "Movie", "Late Night Anime". No puns, no punctuation, no emoji, no day names.
- Kids and family shows fit mornings and afternoons; adult shows fit late evening and night. Put the strongest material in the evening.`;

// ---------- the menu ----------

const genres = (j) => (j ? JSON.parse(j) : []);
const vibes = (j) => (j ? JSON.parse(j).join("/") : "");
const mins = (ms) => Math.round((ms || 0) / 60000);
const min1 = (ms) => ((ms || 0) / 60000).toFixed(1);

function describeShow(s) {
  if (!s?.tagged_at) return "untagged";
  return [s.audience, s.anime ? "anime" : s.animated ? "animated" : "live action", s.origin, s.decade ? `${s.decade}s` : null, vibes(s.vibes)]
    .filter(Boolean).join(", ");
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
  const start = last ? eps.findIndex((e) => e.id === last) + 1 : 0;
  const out = [];
  for (let k = 0; k < eps.length && out.length < count; k++) {
    const e = eps[(start + k) % eps.length];
    if (!used.has(e.id)) out.push(e);
  }
  return out;
}

// Everything the scheduler may use on a day, plus the text of the menu.
export function buildMenu(day, used) {
  const db = getDb();
  const theme = season(day);
  const allowed = new Map();
  const order = new Map(); // in-order shows: their next episode ids, in airing order
  const lines = [];

  // Shows: a few random episodes each that haven't aired recently (reruns, like real
  // TV); shows set to air in order get their next episodes instead.
  const episodes = db.prepare(`SELECT i.* FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = 'episode' AND ${schedulableSql("i")} AND COALESCE(t.holiday, 'none') = 'none'
    ORDER BY random()`).all();
  const byShow = Map.groupBy(episodes.filter((e) => !used.has(e.id)), (e) => e.show_title);
  const shows = new Map(db.prepare("SELECT * FROM shows").all().map((s) => [s.title, s]));

  lines.push("SHOWS (episode ids with their length in minutes; listed in airing order unless marked any order)");
  for (const [title, eps] of [...byShow].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ordered = inOrder(title);
    const pick = ordered ? nextInOrder(title, EPISODES_PER_SHOW, used, day.startMs) : eps.slice(0, EPISODES_PER_SHOW);
    if (!pick.length) continue;
    pick.forEach((e) => allowed.set(e.id, e));
    if (ordered) order.set(title, pick.map((e) => e.id));
    lines.push(`- ${title}${ordered ? "" : " (any order)"} | ${describeShow(shows.get(title))} | ${pick.map((e) => `${e.id} (${min1(e.duration_ms)})`).join(", ")}`);
  }

  // Holiday material for the season: all of it is on the menu.
  if (theme.theme !== "none") {
    const hol = db.prepare(`SELECT i.*, t.holiday FROM items i JOIN tags t ON t.item_id = i.id
      WHERE t.holiday = ? AND i.kind = 'episode' AND ${schedulableSql("i")} ORDER BY random() LIMIT 40`).all(theme.theme)
      .filter((e) => !used.has(e.id));
    if (hol.length) {
      lines.push(`\n${theme.theme.toUpperCase()} EPISODES (can air outside their show's usual order)`);
      for (const e of hol) {
        allowed.set(e.id, e);
        lines.push(`- ${e.id} ${e.show_title} S${e.season ?? "?"}E${e.episode ?? "?"} "${e.title}" | ${min1(e.duration_ms)}m | ${describeShow(shows.get(e.show_title))}`);
      }
    }
  }

  // Movies: a sample of the ones that haven't aired recently, plus every in-season holiday movie.
  const movies = db.prepare(`SELECT i.*, t.holiday, t.audience, t.animated, t.anime, t.origin, t.mood FROM items i
    LEFT JOIN tags t ON t.item_id = i.id WHERE i.kind = 'movie' AND ${schedulableSql("i")} ORDER BY random()`).all()
    .filter((m) => !used.has(m.id));
  const pick = [...movies.filter((m) => m.holiday && m.holiday === theme.theme), ...movies.filter((m) => m.holiday === "none" || !m.holiday).slice(0, 25)];
  if (pick.length) {
    lines.push("\nMOVIES (each gets its own block)");
    for (const m of pick) {
      allowed.set(m.id, m);
      const tags = [m.audience, m.anime ? "anime" : m.animated ? "animated" : "live action", m.origin, vibes(m.mood), m.holiday !== "none" ? m.holiday : null].filter(Boolean).join(", ");
      lines.push(`- ${m.id} ${m.title} (${m.year ?? "?"}) | ${min1(m.duration_ms)}m | ${tags}`);
    }
  }
  return { allowed, order, text: lines.join("\n"), theme };
}

// ---------- checking Claude's answer ----------

const runOf = (rows) => rows.reduce((n, r) => n + (r.duration_ms || 0), 0);
const hours = (ms) => (ms / 3600000).toFixed(1);

export function validate(blocks, { allowed, windowMs, fixedEnd }) {
  const problems = [];
  const seen = new Set();
  const maxAds = config.broadcast.max_ad_minutes_per_hour;
  let total = 0;
  blocks.forEach((b, i) => {
    const name = `Block ${i + 1} ("${b.label}")`;
    const words = b.label.trim().split(/\s+/);
    if (!b.label.trim() || words.length > 3 || b.label.length > 30 || !/^[\p{L}\p{N} &'-]+$/u.test(b.label)) {
      problems.push(`${name}: the label must be 1 to 3 plain words (letters, numbers, spaces, & ' -).`);
    }
    if (!b.ids.length) problems.push(`${name}: it has no items.`);
    const rows = [];
    for (const id of b.ids) {
      if (!allowed.has(id)) problems.push(`${name}: id ${id} is not on the menu.`);
      else if (seen.has(id)) problems.push(`${name}: id ${id} is used more than once.`);
      else rows.push(allowed.get(id));
      seen.add(id);
    }
    if (rows.some((r) => r.kind === "movie") && b.ids.length > 1) problems.push(`${name}: a movie must be alone in its block.`);
    if (!rows.length) return;
    const run = runOf(rows);
    const { lengthMs, adMs, adPerHour } = blockLength(run);
    total += lengthMs;
    const maxShow = config.broadcast.max_show_block_minutes * 60000;
    if (!rows.some((r) => r.kind === "movie") && lengthMs > maxShow) {
      problems.push(`${name}: it runs ${mins(lengthMs)} minutes; blocks of episodes can be at most ${config.broadcast.max_show_block_minutes}. Use fewer episodes (split it into two blocks if you like).`);
    }
    if (/marathon/i.test(b.label)) problems.push(`${name}: don't call regular blocks marathons.`);
    if (adPerHour > maxAds + 0.01) {
      problems.push(`${name}: its items run ${min1(run)} minutes, so the block rounds up to ${mins(lengthMs)} minutes with ${min1(adMs)} minutes of commercials (${adPerHour.toFixed(1)} per hour; the limit is ${maxAds}). Add or swap an item so the total lands just under a quarter-hour mark.`);
    }
  });
  if (fixedEnd) {
    if (total > windowMs) problems.push(`The blocks run ${hours(total)} hours, but only ${hours(windowMs)} hours are available. Remove something.`);
    else if (total < windowMs - 45 * 60000) problems.push(`The blocks run ${hours(total)} hours; fill closer to ${hours(windowMs)} hours.`);
  } else if (total < windowMs) {
    problems.push(`The blocks run ${hours(total)} hours; they need to cover at least ${hours(windowMs)} hours. Add blocks at the end.`);
  } else if (total > windowMs + 3 * 3600000) {
    problems.push(`The blocks run ${hours(total)} hours; that's more than needed (${hours(windowMs)} hours, a little over is fine). Remove blocks at the end.`);
  }
  return problems;
}

// In-order shows: whatever ids Claude picked, their spots get the show's next
// episodes in airing order, with no gaps.
function keepInOrder(blocks, allowed, order) {
  const spots = new Map();
  blocks.forEach((b) => b.ids.forEach((id, pos) => {
    const r = allowed.get(id);
    if (r?.kind === "episode" && order.has(r.show_title) && !(r.holiday && r.holiday !== "none")) {
      if (!spots.has(r.show_title)) spots.set(r.show_title, []);
      spots.get(r.show_title).push({ b, pos });
    }
  }));
  for (const [title, list] of spots) {
    const next = order.get(title);
    list.forEach((spot, i) => { if (next[i] !== undefined) spot.b.ids[spot.pos] = next[i]; });
  }
}

// ---------- the simple fallback ----------

// Runs of each show's episodes, sized so the ad share is as low as possible.
function fallbackBlocks(allowed, windowMs) {
  const regular = [...allowed.values()].filter((r) => r.kind === "episode" && !(r.holiday && r.holiday !== "none"));
  const byShow = Map.groupBy(regular, (r) => r.show_title);
  const shows = [...byShow.keys()].sort(() => Math.random() - 0.5);
  const blocks = [];
  let total = 0;
  for (const title of shows) {
    if (total >= windowMs) break;
    const eps = byShow.get(title);
    let best = null;
    for (let k = 1; k <= eps.length; k++) {
      const { lengthMs, adPerHour } = blockLength(runOf(eps.slice(0, k)));
      if (k > 1 && lengthMs > config.broadcast.max_show_block_minutes * 60000) break;
      if (!best || adPerHour < best.adPerHour) best = { k, lengthMs, adPerHour };
    }
    blocks.push({ label: title.slice(0, 40), ids: eps.slice(0, best.k).map((e) => e.id) });
    total += best.lengthMs;
  }
  return blocks;
}

// ---------- one stretch of air time ----------

async function planWindow(client, win, avoid) {
  const N = config.broadcast.no_repeat_days * DAY;
  const used = usedIds(win.start - N, win.start + N);
  for (const id of avoid) used.add(id);
  const menu = buildMenu({ ...win.day, startMs: win.start }, used);
  const windowMs = win.end - win.start;
  const ctx = { allowed: menu.allowed, windowMs, fixedEnd: win.fixedEnd };
  const s = menu.theme;
  const tag = `${win.day.date} ${localTime(win.start)}`;
  const seasonNote = s.theme === "none" ? "No holiday season right now."
    : `It's ${s.theme} season (the holiday is ${s.holidayDate}). Work in ${s.intensity > 0.7 ? "plenty of" : "some"} ${s.theme} material, from the holiday episodes and movies on the menu; not every block has to be themed.`;
  const endNote = win.fixedEnd
    ? `The channel signs off at ${localTime(win.end)}: the blocks must not run past it.`
    : `That's until about ${localTime(win.end)}; running up to an hour or two past it is fine.`;
  const prompt = `Program ${win.day.weekday}, ${win.day.date}, starting at ${localTime(win.start)}: about ${hours(windowMs)} hours. ${endNote}
Commercials (${config.broadcast.min_ad_minutes_per_hour} to ${config.broadcast.max_ad_minutes_per_hour} minutes per hour) get added between items automatically.
${seasonNote}

${menu.text}`;

  const messages = [{ role: "user", content: prompt }];
  const usage = { input: 0, output: 0 };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let blocks;
    try {
      const msg = await client.messages.create({
        model: config.claude.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages,
      });
      usage.input += msg.usage.input_tokens;
      usage.output += msg.usage.output_tokens;
      const text = msg.content.find((b) => b.type === "text")?.text;
      if (msg.stop_reason !== "end_turn" || !text) throw new Error(`stopped: ${msg.stop_reason}`);
      blocks = JSON.parse(text).blocks;
      messages.push({ role: "assistant", content: msg.content });
    } catch (e) {
      log.warn(`schedule: ${tag} attempt ${attempt} failed: ${e.message}`);
      break;
    }
    const problems = validate(blocks, ctx);
    if (!problems.length) {
      keepInOrder(blocks, menu.allowed, menu.order);
      log.info(`schedule: ${tag}: ${blocks.length} blocks from Claude (attempt ${attempt}; ${usage.input} in / ${usage.output} out tokens)`);
      return { blocks, source: "claude", theme: s.theme, allowed: menu.allowed };
    }
    log.info(`schedule: ${tag} attempt ${attempt}: ${problems.length} problem(s), e.g. ${problems[0]}`);
    messages.push({ role: "user", content: `That schedule has problems. Fix them and send the whole list again:\n- ${problems.join("\n- ")}` });
  }
  log.warn(`schedule: ${tag}: using the simple fallback schedule`);
  return { blocks: fallbackBlocks(menu.allowed, windowMs), source: "fallback", theme: s.theme, allowed: menu.allowed };
}

// Program `days` days of air time from fromMs, in stretches of about a day, back to
// back. Existing blocks are kept (and never overlapped); with replace, everything after
// the current block is thrown away first. Block start/end times are worked out here.
export async function generateSchedule(opts = {}, { locked = false } = {}) {
  return locked ? generateUnlocked(opts) : withScheduleLock(() => generateUnlocked(opts));
}

// avoid: item ids to leave off the menu for this run (e.g. "not that show today").
async function generateUnlocked({ fromMs = Date.now(), days = 7, replace = false, avoid = new Set() } = {}) {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  if (replace) {
    const current = blocksBetween(fromMs, fromMs + 1)[0];
    const cut = current ? current.end_at : fromMs;
    log.info(`schedule: replacing ${deleteBlocksFrom(cut)} future blocks`);
    fromMs = cut;
  }
  const horizon = fromMs + days * DAY;
  let t = gridFloor(fromMs);
  while (t < horizon) {
    const covering = blocksBetween(t, t + 1)[0];
    if (covering) { t = covering.end_at; continue; }
    const win = nextWindow(t);
    const existing = nextBlockAfter(win.start);
    if (existing && existing.start_at < win.end) { win.end = existing.start_at; win.fixedEnd = true; }
    if (win.end - win.start < gridMs()) { t = win.end; continue; }

    const plan = await planWindow(client, win, avoid);
    let at = win.start;
    const out = [];
    for (const b of plan.blocks) {
      const rows = b.ids.map((id) => plan.allowed.get(id)).filter(Boolean);
      const { lengthMs } = blockLength(runOf(rows));
      if (win.fixedEnd && at + lengthMs > win.end) break;
      const theme = plan.theme !== "none" && rows.some((r) => r.holiday === plan.theme) ? plan.theme : null;
      out.push({ start: at, end: at + lengthMs, label: b.label.trim(), ids: b.ids, theme });
      at += lengthMs;
    }
    saveBlocks(out, plan.source);
    t = win.fixedEnd ? win.end : Math.max(at, win.start + gridMs());
  }
}
