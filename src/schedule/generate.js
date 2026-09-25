// Weekly schedule: Claude programs each day from a menu of candidates; code checks
// the result (ids, fit, repeats, labels) and sends problems back, a few times at most,
// then falls back to a simple schedule built in code.
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";
import { localDay, daySlots, localTime, season } from "./time.js";
import { saveBlocks, deleteBlocksFrom, usedIds, blocksBetween } from "./store.js";

const DAY = 86400000;
const EPISODES_PER_SHOW = 4;
const MAX_ATTEMPTS = 3;
const blockMs = () => config.broadcast.block_minutes * 60000;

const SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          slots: { type: "integer" },
          ids: { type: "array", items: { type: "integer" } },
        },
        required: ["label", "slots", "ids"],
        additionalProperties: false,
      },
    },
  },
  required: ["blocks"],
  additionalProperties: false,
};

const SYSTEM = `You program one day of a retro cable-TV style channel for a group of friends. You get the day's time slots and a menu of shows, movies and episodes; you return the day as a list of blocks.

Rules:
- Blocks fill the day in order, with no gaps. Each block covers a whole number of slots; the slot counts must add up to exactly the number of slots in the day.
- A block holds items that go together (same show, or shows with a similar feel), in a sensible order. Mix it up over the day; don't run the same show all day.
- A movie always gets a block to itself, with enough slots for its length plus breaks.
- Fill each block well: the items' running time plus the commercial breaks between them must fit inside the block, and should use most of it. The leftover time at the end of a block gets filled with short commercials automatically.
- Use a show's episodes in the order the menu lists them. Only use ids from the menu, and each id at most once.
- label: a short plain description of the block in 1 to 3 words, like "Sitcoms", "Saturday Cartoons", "Halloween Specials", "Movie", "Late Night Anime". No puns, no punctuation, no emoji.
- Kids and family shows fit mornings and afternoons; adult shows fit late evening and night. Put the strongest material in the evening.`;

// ---------- the menu ----------

const genres = (j) => (j ? JSON.parse(j) : []);
const vibes = (j) => (j ? JSON.parse(j).join("/") : "");
const mins = (ms) => Math.round((ms || 0) / 60000);

function describeShow(s) {
  if (!s?.tagged_at) return "untagged";
  return [s.audience, s.anime ? "anime" : s.animated ? "animated" : "live action", s.origin, s.decade ? `${s.decade}s` : null, vibes(s.vibes)]
    .filter(Boolean).join(", ");
}

// Everything the scheduler may use on a day, plus the text of the menu.
export function buildMenu(day, used) {
  const db = getDb();
  const theme = season(day);
  const allowed = new Map();
  const lines = [];

  // Shows: the next few episodes after whatever aired last, in order.
  const episodes = db.prepare(`SELECT * FROM items i WHERE i.kind = 'episode' AND ${schedulableSql("i")}
    ORDER BY i.show_title, i.season IS NULL, i.season, i.episode IS NULL, i.episode, i.id`).all();
  const byShow = Map.groupBy(episodes, (e) => e.show_title);
  const shows = new Map(db.prepare("SELECT * FROM shows").all().map((s) => [s.title, s]));
  const lastAired = db.prepare(`SELECT i.id FROM block_items bi JOIN blocks b ON b.id = bi.block_id JOIN items i ON i.id = bi.item_id
    WHERE i.show_title = ? AND b.start_at < ? ORDER BY b.start_at DESC, bi.position DESC LIMIT 1`);

  lines.push("SHOWS (episode ids in airing order; typical episode length in minutes)");
  for (const [title, eps] of byShow) {
    const last = lastAired.get(title, day.startMs)?.id;
    const start = last ? eps.findIndex((e) => e.id === last) + 1 : 0;
    const next = [];
    for (let k = 0; k < eps.length && next.length < EPISODES_PER_SHOW; k++) {
      const e = eps[(start + k) % eps.length]; // wrap around to the start of the series
      if (!used.has(e.id)) next.push(e);
    }
    if (!next.length) continue;
    next.forEach((e) => allowed.set(e.id, e));
    const typical = mins(next[0].duration_ms);
    lines.push(`- ${title} | ${describeShow(shows.get(title))} | ${typical}m | ids ${next.map((e) => e.id).join(", ")}`);
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
        lines.push(`- ${e.id} ${e.show_title} S${e.season ?? "?"}E${e.episode ?? "?"} "${e.title}" | ${mins(e.duration_ms)}m | ${describeShow(shows.get(e.show_title))}`);
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
      lines.push(`- ${m.id} ${m.title} (${m.year ?? "?"}) | ${mins(m.duration_ms)}m | ${tags}`);
    }
  }
  return { allowed, text: lines.join("\n"), theme };
}

// Average commercial break, from what's actually in the commercials/clips folders.
export function estimatedBreakMs() {
  const db = getDb();
  const avg = (kind) => db.prepare(`SELECT AVG(duration_ms) a FROM items WHERE kind = ? AND present = 1 AND playable = 1`).get(kind).a;
  const [lo, hi] = config.broadcast.commercials_per_break;
  const commercial = avg("commercial") ?? 30000;
  const clip = avg("clip") ?? 60000;
  return Math.round(((lo + hi) / 2) * commercial + config.broadcast.clip_chance * clip);
}

// ---------- checking Claude's answer ----------

export function validate(blocks, { slotCount, allowed, breakMs }) {
  const problems = [];
  const seen = new Set();
  const total = blocks.reduce((n, b) => n + b.slots, 0);
  if (total !== slotCount) problems.push(`The blocks cover ${total} slots, but the day has exactly ${slotCount}.`);
  blocks.forEach((b, i) => {
    const name = `Block ${i + 1} ("${b.label}")`;
    const words = b.label.trim().split(/\s+/);
    if (!b.label.trim() || words.length > 3 || b.label.length > 30 || !/^[\p{L}\p{N} &'-]+$/u.test(b.label)) {
      problems.push(`${name}: the label must be 1 to 3 plain words (letters, numbers, spaces, & ' -).`);
    }
    if (!Number.isInteger(b.slots) || b.slots < 1) problems.push(`${name}: slots must be a whole number, at least 1.`);
    if (!b.ids.length) problems.push(`${name}: it has no items.`);
    const rows = [];
    for (const id of b.ids) {
      if (!allowed.has(id)) problems.push(`${name}: id ${id} is not on the menu.`);
      else if (seen.has(id)) problems.push(`${name}: id ${id} is used more than once.`);
      else rows.push(allowed.get(id));
      seen.add(id);
    }
    if (rows.some((r) => r.kind === "movie") && b.ids.length > 1) problems.push(`${name}: a movie must be alone in its block.`);
    const lengthMs = b.slots * blockMs();
    const runMs = rows.reduce((n, r) => n + (r.duration_ms || 0), 0) + Math.max(0, rows.length - 1) * breakMs;
    if (runMs > lengthMs) {
      problems.push(`${name}: its items run ${mins(runMs)} minutes with breaks, but ${b.slots} slot(s) is only ${mins(lengthMs)} minutes. Use more slots or fewer items.`);
    } else if (rows.length && runMs < lengthMs * 0.5) {
      problems.push(`${name}: its items fill only ${mins(runMs)} of ${mins(lengthMs)} minutes. Add items or use fewer slots.`);
    }
  });
  return problems;
}

// Keep each show's episodes in series order across the day, even if Claude
// shuffled them between blocks.
function keepSeriesOrder(blocks, allowed) {
  const byShow = new Map();
  blocks.forEach((b) => b.ids.forEach((id, pos) => {
    const r = allowed.get(id);
    if (r.kind !== "episode") return;
    if (!byShow.has(r.show_title)) byShow.set(r.show_title, []);
    byShow.get(r.show_title).push({ b, pos, r });
  }));
  const order = (r) => [r.season ?? 1e9, r.episode ?? 1e9, r.id];
  const cmp = (x, y) => { const a = order(x), c = order(y); for (let i = 0; i < 3; i++) if (a[i] !== c[i]) return a[i] - c[i]; return 0; };
  for (const spots of byShow.values()) {
    const sorted = spots.map((s) => s.r).sort(cmp);
    spots.forEach((s, i) => { s.b.ids[s.pos] = sorted[i].id; });
  }
}

// ---------- the simple fallback ----------

function fallbackDay(slots, allowed, breakMs) {
  const byShow = Map.groupBy([...allowed.values()].filter((r) => r.kind === "episode"), (r) => r.show_title);
  const shows = [...byShow.keys()].sort(() => Math.random() - 0.5);
  const blocks = [];
  let k = 0;
  for (let s = 0; s < slots.length; s++) {
    let placed = null;
    for (let tries = 0; tries < shows.length && !placed; tries++) {
      const title = shows[k++ % shows.length];
      const eps = byShow.get(title);
      const ids = [];
      let run = 0;
      while (eps.length && run + eps[0].duration_ms + (ids.length ? breakMs : 0) <= blockMs()) {
        const e = eps.shift();
        run += e.duration_ms + (ids.length ? breakMs : 0);
        ids.push(e.id);
      }
      if (ids.length) placed = { label: title.slice(0, 40), slots: 1, ids };
    }
    if (!placed) break;
    blocks.push(placed);
  }
  return blocks;
}

// ---------- one day ----------

async function planDay(client, day, slots) {
  const used = usedIds(day.startMs - config.broadcast.no_repeat_days * DAY, day.startMs + config.broadcast.no_repeat_days * DAY);
  const menu = buildMenu(day, used);
  const breakMs = estimatedBreakMs();
  const ctx = { slotCount: slots.length, allowed: menu.allowed, breakMs };
  const s = menu.theme;
  const seasonNote = s.theme === "none" ? "No holiday season today."
    : `It's ${s.theme} season (the holiday is ${s.holidayDate}). Work in ${s.intensity > 0.7 ? "plenty of" : "some"} ${s.theme} material, from the holiday episodes and movies on the menu; not every block has to be themed.`;
  const prompt = `Program ${day.weekday}, ${day.date}.

${slots.length} slots of ${config.broadcast.block_minutes} minutes, starting at ${slots.map(localTime).join(", ")}.
Each commercial break between two items in a block takes about ${Math.round(breakMs / 1000)} seconds.
${seasonNote}

${menu.text}`;

  const messages = [{ role: "user", content: prompt }];
  let usage = { input: 0, output: 0 };
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
      log.warn(`schedule: ${day.date} attempt ${attempt} failed: ${e.message}`);
      break;
    }
    const problems = validate(blocks, ctx);
    if (!problems.length) {
      keepSeriesOrder(blocks, menu.allowed);
      log.info(`schedule: ${day.date}: ${blocks.length} blocks from Claude (attempt ${attempt}; ${usage.input} in / ${usage.output} out tokens)`);
      return { blocks, source: "claude", theme: s.theme, allowed: menu.allowed };
    }
    log.info(`schedule: ${day.date} attempt ${attempt}: ${problems.length} problem(s), e.g. ${problems[0]}`);
    messages.push({ role: "user", content: `That schedule has problems. Fix them and send the whole day again:\n- ${problems.join("\n- ")}` });
  }
  log.warn(`schedule: ${day.date}: using the simple fallback schedule`);
  return { blocks: fallbackDay(slots, menu.allowed, breakMs), source: "fallback", theme: s.theme, allowed: menu.allowed };
}

// Program `days` days starting at fromMs. With replace, anything already scheduled from
// the next slot onward is thrown away first; otherwise days that already have blocks
// are skipped.
export async function generateSchedule({ fromMs = Date.now(), days = 7, replace = false } = {}) {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  if (replace) {
    const current = blocksBetween(fromMs, fromMs + 1)[0];
    const cut = current ? current.end_at : fromMs;
    log.info(`schedule: replacing ${deleteBlocksFrom(cut)} future blocks`);
    fromMs = cut;
  }
  let day = localDay(fromMs);
  for (let n = 0; n < days; n++, day = localDay(day.endMs + 1)) {
    const slots = daySlots(day).filter((t) => t >= fromMs);
    if (!slots.length) continue;
    if (blocksBetween(slots[0], slots[0] + 1).length) continue; // already programmed
    const plan = await planDay(client, day, slots);
    let t = slots[0];
    const out = [];
    for (const b of plan.blocks) {
      const end = t + b.slots * blockMs();
      const theme = b.ids.some((id) => plan.allowed.get(id)?.holiday === plan.theme) ? plan.theme : null;
      out.push({ start: t, end, label: b.label.trim(), ids: b.ids, theme });
      t = end;
    }
    saveBlocks(out, plan.source);
  }
}
