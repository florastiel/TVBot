// The week's grid: Claude lays out bucket slots ("Saturday 06:00 Saturday Morning
// Cartoons, 10:00 Shonen Anime, ...") from the bucket list alone. It never picks titles;
// code fills each slot with random picks from its bucket (fill.js).
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { localDay, localToUtc, localTime, gridMs, season } from "./time.js";
import { listBuckets, inSeason, daypart, isMovieFormat } from "./buckets.js";
import { blockLength } from "./generate.js";

const DAY = 86400000;
const MAX_ATTEMPTS = 3;
const MIN_SLOT = 60 * 60000;

const SCHEMA = {
  type: "object",
  properties: {
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          slots: {
            type: "array",
            items: {
              type: "object",
              properties: { start: { type: "string" }, bucket: { type: "string" } },
              required: ["start", "bucket"],
              additionalProperties: false,
            },
          },
        },
        required: ["date", "slots"],
        additionalProperties: false,
      },
    },
  },
  required: ["days"],
  additionalProperties: false,
};

const SYSTEM = `You lay out the weekly grid of a retro cable-TV style channel run for a group of friends, from its list of buckets (kinds of programming blocks). For each date you give the slots: a start time and a bucket. Code fills each slot with random shows or movies from that bucket, block after block, until the next slot starts. You never pick titles.

Rules:
- Every date starts with a slot at 00:00. Slots start on a quarter hour (HH:00, :15, :30, :45), in order, and each runs until the next slot (the day's last slot runs until midnight).
- A slot lasts at least 1 hour. Movie buckets need room for their movies (movie lengths are listed; 2 to 3 hours is typical); a movie_series slot plays the series in order for as long as the slot lasts.
- Only use a bucket in the dayparts it allows, judged by the slot's start time (morning 6-12, afternoon 12-17, evening 17-22, late 22-6), and seasonal buckets only on dates in their window.
- Use a wide spread of buckets over the week: no bucket more than twice a day, and give buckets that haven't aired lately their turn (recent use is listed). Don't lean on the same few.
- Think like real TV: cartoons on weekend mornings, strongest material in prime time, weird and adult stuff late at night, movie nights, a weekend marathon or two. If a holiday or notable date falls in the week, lean into it.
- Specials already on the schedule (listed, if any) take over their time; slots overlapping them are cut short automatically.`;

const dateOf = (day) => day.date;

function bucketLines(buckets, days) {
  const db = getDb();
  const movieLen = db.prepare("SELECT duration_ms FROM items WHERE id = ?");
  const recent = new Map(db.prepare(`SELECT bucket_id, COUNT(*) n FROM blocks WHERE bucket_id IS NOT NULL AND start_at > ? GROUP BY bucket_id`)
    .all(Date.now() - 14 * DAY).map((r) => [r.bucket_id, r.n]));
  return buckets.filter((b) => days.some((d) => inSeason(b, d))).map((b) => {
    let size;
    if (isMovieFormat(b.format)) {
      const lens = b.items.map((id) => movieLen.get(id)?.duration_ms || 0).filter(Boolean).map((ms) => Math.round(blockLength(ms).lengthMs / 60000));
      size = b.format === "movie_series"
        ? `${lens.length} movies in order, ${(lens.reduce((a, x) => a + x, 0) / 60).toFixed(1)} hours in all`
        : `${lens.length} movies, blocks of ${Math.min(...lens)}-${Math.max(...lens)} min`;
    } else {
      size = `${b.shows.length || b.items.length} ${b.shows.length ? "shows" : "episodes"}`;
    }
    const when = b.active_from ? `${b.active_from} to ${b.active_to}` : "all year";
    return `${b.name} | ${b.format} | ${b.dayparts.join("/")} | ${when} | ${size} | aired ${recent.get(b.id) || 0} blocks in the last 2 weeks | ${b.about || ""}`;
  });
}

function parseSlots(out, days, buckets) {
  const problems = [];
  const byName = new Map(buckets.map((b) => [b.name.toLowerCase(), b]));
  const slots = [];
  for (const day of days) {
    const d = out.days.find((x) => x.date === dateOf(day));
    if (!d) { problems.push(`${day.weekday} ${day.date} is missing.`); continue; }
    const where = `${day.weekday} ${day.date}`;
    const list = [];
    for (const s of d.slots) {
      const m = s.start.match(/^(\d{1,2}):(\d{2})$/);
      if (!m || +m[1] > 23 || +m[2] % 15) { problems.push(`${where}: "${s.start}" isn't a quarter-hour time (HH:MM).`); continue; }
      const b = byName.get(s.bucket.trim().toLowerCase());
      if (!b) { problems.push(`${where} ${s.start}: there's no bucket called "${s.bucket}".`); continue; }
      if (!inSeason(b, day)) problems.push(`${where} ${s.start}: "${b.name}" is out of season on this date.`);
      if (!b.dayparts.includes(daypart(+m[1]))) problems.push(`${where} ${s.start}: "${b.name}" can't air in the ${daypart(+m[1])} (allowed: ${b.dayparts.join(", ")}).`);
      list.push({ at: localToUtc(day.y, day.m, day.d, +m[1], +m[2]), bucket: b, label: `${where} ${s.start}` });
    }
    list.sort((a, b) => a.at - b.at);
    if (!list.length || list[0].at !== day.startMs) problems.push(`${where}: the first slot must start at 00:00.`);
    list.forEach((s, i) => {
      const end = list[i + 1]?.at ?? day.endMs;
      if (end - s.at < MIN_SLOT) problems.push(`${s.label}: "${s.bucket.name}" runs only ${Math.round((end - s.at) / 60000)} minutes; slots last at least an hour.`);
    });
    const count = Map.groupBy(list, (s) => s.bucket.name);
    for (const [name, xs] of count) if (xs.length > 2) problems.push(`${where}: "${name}" is used ${xs.length} times; at most twice a day.`);
    slots.push(...list);
  }
  return { problems, slots };
}

// A plain grid if Claude can't make one: 3-hour slots of random buckets that fit.
function fallbackSlots(days, buckets) {
  const slots = [];
  for (const day of days) {
    const used = new Set();
    for (let h = 0; h < 24; h += 3) {
      const fits = buckets.filter((b) => inSeason(b, day) && b.dayparts.includes(daypart(h)) && !used.has(b.id));
      const b = fits[Math.floor(Math.random() * fits.length)] || buckets[0];
      used.add(b.id);
      slots.push({ at: localToUtc(day.y, day.m, day.d, h, 0), bucket: b });
    }
  }
  return slots;
}

// Plan `count` days starting with the local day containing fromMs. Replaces any slots
// already planned for those days.
export async function planWeek({ fromMs = Date.now(), count = 7 } = {}) {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  const buckets = listBuckets();
  if (!buckets.length) throw new Error("no buckets yet (tv.cmd buckets --build)");
  const days = [];
  for (let d = localDay(fromMs), k = 0; k < count; k++, d = localDay(d.endMs + 1)) days.push(d);
  const specials = getDb().prepare("SELECT label, MIN(start_at) a, MAX(end_at) z FROM blocks WHERE source = 'special' AND end_at > ? AND start_at < ? GROUP BY label")
    .all(days[0].startMs, days.at(-1).endMs);
  const seasons = [...new Set(days.map((d) => season(d)).filter((s) => s.theme !== "none").map((s) => `${s.theme} season (the day itself is ${s.holidayDate})`))];
  const prompt = `Lay out the grid for ${days.map((d) => `${d.weekday} ${d.date}`).join(", ")} (dates as YYYY-MM-DD in your answer).
${seasons.length ? `It's ${seasons.join("; ")}.` : ""}
${specials.length ? `Specials already scheduled: ${specials.map((s) => `"${s.label}" ${localDay(s.a).date} ${localTime(s.a)}-${localTime(s.z)}`).join("; ")}` : ""}

BUCKETS (name | format | dayparts | season | size | recent use | about)
${bucketLines(buckets, days).join("\n")}`;

  const messages = [{ role: "user", content: prompt }];
  let slots = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !slots; attempt++) {
    try {
      const msg = await client.messages.create({
        model: config.claude.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages,
      });
      const text = msg.content.find((b) => b.type === "text")?.text;
      if (msg.stop_reason !== "end_turn" || !text) throw new Error(`stopped: ${msg.stop_reason}`);
      messages.push({ role: "assistant", content: msg.content });
      const r = parseSlots(JSON.parse(text), days, buckets);
      log.info(`plan: attempt ${attempt}: ${r.slots.length} slots, ${r.problems.length} problem(s) (${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out tokens)`);
      if (!r.problems.length) slots = r.slots;
      else messages.push({ role: "user", content: `That grid has problems. Fix them and send the whole week again:\n- ${r.problems.slice(0, 40).join("\n- ")}` });
    } catch (e) {
      log.warn(`plan: attempt ${attempt} failed: ${e.message}`);
      break;
    }
  }
  if (!slots) {
    log.warn("plan: using a simple code-made grid");
    slots = fallbackSlots(days, buckets);
  }
  const now = new Date().toISOString();
  tx((db) => {
    db.prepare("DELETE FROM plan_slots WHERE start_at >= ? AND start_at < ?").run(days[0].startMs, days.at(-1).endMs);
    const put = db.prepare("INSERT INTO plan_slots (start_at, bucket_id, created_at) VALUES (?, ?, ?)");
    for (const s of slots) put.run(s.at, s.bucket.id, now);
  });
  return slots;
}

// The saved grid, for printing: [{ at, name }]
export function slotsBetween(from, to) {
  return getDb().prepare(`SELECT p.start_at at, b.name FROM plan_slots p JOIN buckets b ON b.id = p.bucket_id
    WHERE p.start_at >= ? AND p.start_at < ? ORDER BY p.start_at`).all(from, to);
}

export const lastPlannedSlot = () => getDb().prepare("SELECT MAX(start_at) m FROM plan_slots").get().m;
