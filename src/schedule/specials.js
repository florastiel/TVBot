// Specials: marathons and themed stretches (a movie series, a director night, a show
// marathon) that override the regular schedule. Planned by a separate Claude call,
// either automatically each week or on request (/tvadmin special "..."). Code checks
// the answer, removes the regular blocks it overlaps, saves it, and has the regular
// planner re-fill any gaps around it.
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";
import { blockLength, generateSchedule, nextInOrder, inOrder } from "./generate.js";
import { localDay, localTime, localToUtc, gridMs } from "./time.js";
import { saveBlocks, usedIds, scheduledUntil } from "./store.js";
import { withScheduleLock } from "./lock.js";

const DAY = 86400000;
const MAX_ATTEMPTS = 3;
const MAX_HOURS = 12;

const SCHEMA = {
  type: "object",
  properties: {
    specials: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          date: { type: "string" },  // YYYY-MM-DD, channel time zone
          start: { type: "string" }, // HH:MM on a quarter hour
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                movie_id: { type: "integer" }, // a movie, or 0
                show: { type: "string" },       // a show title, or ""
                episodes: { type: "integer" },  // how many episodes of that show, or 0
              },
              required: ["movie_id", "show", "episodes"],
              additionalProperties: false,
            },
          },
        },
        required: ["label", "date", "start", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["specials"],
  additionalProperties: false,
};

const SYSTEM = `You plan specials for a retro cable-TV style channel run for a group of friends: marathons and themed stretches that take over the regular schedule for a few hours, like real TV event programming. Examples: a movie series in order ("Scream Marathon"), a director night ("David Lynch Night"), a studio or genre run ("Ghibli Sunday"), or a big run of one show ("Spider-Man Marathon").

Rules:
- Only use movies and shows from the catalog. Movie series go in release order.
- Each item is either a movie (movie_id, with show "" and episodes 0) or a run of random episodes of one show (show title exactly as listed and how many episodes, with movie_id 0).
- A special runs 2 to ${MAX_HOURS} hours including a few minutes of commercials per hour, starts on a quarter hour (HH:00, :15, :30 or :45) in the channel's time zone, and has to fit in the dates you're given.
- Put specials where people are likely watching: evenings, and weekend afternoons. Match the audience to the time of day.
- label: a plain name for the special in 1 to 4 words, like "Scream Marathon" or "Ghibli Sunday". No puns, no punctuation other than & and apostrophes, no emoji.
- Don't repeat a recent special.`;

const vibes = (j) => (j ? JSON.parse(j).join("/") : "");
const min0 = (ms) => Math.round((ms || 0) / 60000);

function catalog(used) {
  const db = getDb();
  const lines = ["MOVIES (id | title (year) | minutes | tags)"];
  const movies = db.prepare(`SELECT i.*, t.audience, t.animated, t.anime, t.origin, t.mood, t.holiday FROM items i
    LEFT JOIN tags t ON t.item_id = i.id WHERE i.kind = 'movie' AND ${schedulableSql("i")} ORDER BY i.title`).all()
    .filter((m) => !used.has(m.id));
  for (const m of movies) {
    const tags = [m.audience, m.anime ? "anime" : m.animated ? "animated" : "live action", m.origin, vibes(m.mood), m.holiday && m.holiday !== "none" ? m.holiday : null].filter(Boolean).join(", ");
    lines.push(`${m.id} | ${m.title} (${m.year ?? "?"}) | ${min0(m.duration_ms)} | ${tags}`);
  }
  lines.push("\nSHOWS (title | episodes available | typical minutes | tags)");
  const shows = db.prepare(`SELECT s.*, COUNT(i.id) n, AVG(i.duration_ms) avg FROM shows s
    JOIN items i ON i.show_title = s.title AND i.kind = 'episode' AND ${schedulableSql("i")}
    GROUP BY s.title HAVING n >= 3 ORDER BY s.title`).all();
  for (const s of shows) {
    const tags = [s.audience, s.anime ? "anime" : s.animated ? "animated" : "live action", s.origin, s.decade ? `${s.decade}s` : null, vibes(s.vibes)].filter(Boolean).join(", ");
    lines.push(`${s.title} | ${s.n} | ${min0(s.avg)} | ${tags}`);
  }
  return { text: lines.join("\n"), movies: new Map(movies.map((m) => [m.id, m])), shows: new Set(shows.map((s) => s.title)) };
}

function recentSpecials() {
  return getDb().prepare(`SELECT DISTINCT label FROM blocks WHERE source = 'special' AND start_at > ? ORDER BY start_at DESC LIMIT 20`)
    .all(Date.now() - 60 * DAY).map((r) => r.label);
}

// Turn a special into blocks: each movie alone, show episodes in blocks of up to
// about 90 minutes. Returns { blocks, problems }.
function expand(sp, cat, used, { fromMs, toMs }) {
  const problems = [];
  const name = `Special "${sp.label}"`;
  const words = sp.label.trim().split(/\s+/);
  if (!sp.label.trim() || words.length > 4 || sp.label.length > 40 || !/^[\p{L}\p{N} &'-]+$/u.test(sp.label)) {
    problems.push(`${name}: the label must be 1 to 4 plain words.`);
  }
  const d = sp.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = sp.start.match(/^(\d{1,2}):(\d{2})$/);
  if (!d || !t) return { blocks: [], problems: [...problems, `${name}: date must be YYYY-MM-DD and start HH:MM.`] };
  const start = localToUtc(+d[1], +d[2], +d[3], +t[1], +t[2]);
  if ((start - localDay(start).startMs) % gridMs() !== 0) problems.push(`${name}: start on a quarter hour (:00, :15, :30, :45).`);
  const onAir = getDb().prepare("SELECT end_at FROM blocks WHERE start_at <= ? AND end_at > ?").get(Date.now(), Date.now());
  if (onAir && start < onAir.end_at) problems.push(`${name}: it would start before the block on air now ends (${localTime(onAir.end_at)}).`);
  if (start < fromMs || start > toMs) problems.push(`${name}: it has to start between ${new Date(fromMs).toISOString()} and ${new Date(toMs).toISOString()} (UTC), i.e. within the dates given.`);

  const db = getDb();
  const blocks = [];
  let at = start;
  let episodes = [];
  const flushEpisodes = () => {
    while (episodes.length) {
      // As many episodes as fit in ~90 minutes, at least one.
      let k = 1;
      while (k < episodes.length && episodes.slice(0, k + 1).reduce((n, r) => n + r.duration_ms, 0) <= 90 * 60000) k++;
      const rows = episodes.splice(0, k);
      const { lengthMs } = blockLength(rows.reduce((n, r) => n + r.duration_ms, 0));
      blocks.push({ start: at, end: at + lengthMs, label: sp.label.trim(), ids: rows.map((r) => r.id) });
      at += lengthMs;
    }
  };
  for (const it of sp.items) {
    if (it.movie_id) {
      const m = cat.movies.get(it.movie_id);
      if (!m) { problems.push(`${name}: movie id ${it.movie_id} isn't in the catalog (or aired recently).`); continue; }
      flushEpisodes();
      const { lengthMs } = blockLength(m.duration_ms);
      blocks.push({ start: at, end: at + lengthMs, label: sp.label.trim(), ids: [m.id], theme: m.holiday && m.holiday !== "none" ? m.holiday : null });
      at += lengthMs;
    } else if (it.show) {
      if (!cat.shows.has(it.show)) { problems.push(`${name}: there's no show called "${it.show}" in the catalog.`); continue; }
      const want = Math.max(1, it.episodes);
      const eps = inOrder(it.show)
        ? nextInOrder(it.show, want, used, Date.now())
        : db.prepare(`SELECT * FROM items i WHERE i.kind = 'episode' AND i.show_title = ? AND ${schedulableSql("i")} ORDER BY random()`)
          .all(it.show).filter((e) => !used.has(e.id)).slice(0, want);
      if (eps.length < it.episodes) problems.push(`${name}: "${it.show}" only has ${eps.length} episodes available right now.`);
      eps.forEach((e) => used.add(e.id));
      episodes.push(...eps);
    } else {
      problems.push(`${name}: each item needs a movie_id or a show.`);
    }
  }
  flushEpisodes();
  const hours = (at - start) / 3600000;
  if (!blocks.length) problems.push(`${name}: it has nothing in it.`);
  else if (hours > MAX_HOURS) problems.push(`${name}: it runs ${hours.toFixed(1)} hours; keep it under ${MAX_HOURS}.`);
  else if (hours < 1.5) problems.push(`${name}: it runs only ${hours.toFixed(1)} hours; make it at least 2.`);
  return { blocks, problems, start, end: at };
}

// Plan specials with Claude and put them on the schedule. request: what to plan, in
// plain words (from the admin command), or null for the automatic weekly pick.
export async function planSpecials(opts = {}) {
  return withScheduleLock(() => planUnlocked(opts));
}

async function planUnlocked({ request = null, fromMs = Date.now() + 3600000, days = 7, count = 1 } = {}) {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  fromMs = Math.ceil(fromMs / gridMs()) * gridMs();
  const toMs = fromMs + days * DAY;
  const N = config.broadcast.no_repeat_days * DAY;
  const used = usedIds(fromMs - N, fromMs); // aired recently: off the menu
  const cat = catalog(used);
  const first = localDay(fromMs), last = localDay(toMs - 1);
  const dates = [];
  for (let d = first; d.startMs < toMs; d = localDay(d.endMs + 1)) dates.push(`${d.weekday} ${d.date}`);
  const recent = recentSpecials();
  const prompt = `${request ? `Plan this special: "${request}". Pick the best matching movies/shows from the catalog; if the request names a day or time, use it.` : `Plan ${count} special${count > 1 ? "s" : ""} for this week.`}

Dates you can use (channel time zone): ${dates.join(", ")}. Earliest start: ${first.date} ${localTime(fromMs)}; everything must start by ${last.date} ${localTime(toMs - 1)}.
${recent.length ? `Recent specials (don't repeat): ${recent.join(", ")}` : ""}

${cat.text}`;

  const messages = [{ role: "user", content: prompt }];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const msg = await client.messages.create({
      model: config.claude.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages,
    });
    const text = msg.content.find((b) => b.type === "text")?.text;
    if (msg.stop_reason !== "end_turn" || !text) throw new Error(`Claude stopped: ${msg.stop_reason}`);
    messages.push({ role: "assistant", content: msg.content });
    const specials = JSON.parse(text).specials;

    const planned = [];
    const problems = [];
    const taken = new Set(used);
    for (const sp of specials) {
      const r = expand(sp, cat, taken, { fromMs, toMs });
      problems.push(...r.problems);
      if (!r.problems.length) planned.push({ sp, ...r });
    }
    // No overlaps with each other or with specials already on the schedule.
    for (const p of planned) {
      const clash = getDb().prepare("SELECT label FROM blocks WHERE source = 'special' AND start_at < ? AND end_at > ?").get(p.end, p.start);
      if (clash) problems.push(`Special "${p.sp.label}" overlaps the special "${clash.label}" that's already scheduled; pick another time.`);
      if (planned.some((q) => q !== p && q.start < p.end && q.end > p.start)) problems.push(`Special "${p.sp.label}" overlaps another special in your list.`);
    }
    if (!specials.length) problems.push("No specials were returned.");
    if (!problems.length) {
      const plannedUntil = scheduledUntil();
      for (const p of planned) placeSpecial(p);
      // Re-fill only holes inside what was already planned; later days get planned
      // by the regular daily upkeep, which works around the special.
      const from = Math.max(Date.now(), Math.min(...planned.map((p) => p.start)) - 3 * 3600000);
      if (plannedUntil > from) await generateSchedule({ fromMs: from, days: (plannedUntil - from) / DAY }, { locked: true });
      log.info(`specials: ${planned.map((p) => `"${p.sp.label}" ${localDay(p.start).date} ${localTime(p.start)}-${localTime(p.end)}`).join("; ")}`);
      return planned.map((p) => ({ label: p.sp.label, start: p.start, end: p.end, blocks: p.blocks.length }));
    }
    log.info(`specials: attempt ${attempt}: ${problems.length} problem(s), e.g. ${problems[0]}`);
    messages.push({ role: "user", content: `That has problems. Fix them and send the whole list again:\n- ${problems.join("\n- ")}` });
  }
  throw new Error("couldn't plan a valid special after a few tries");
}

// Take over the time slot: regular blocks it overlaps are removed (never one that's
// already on air), then the special's blocks are saved.
function placeSpecial({ blocks, start, end }) {
  tx((db) => {
    const onAir = db.prepare("SELECT id FROM blocks WHERE start_at <= ? AND end_at > ?").get(Date.now(), Date.now());
    db.prepare(`DELETE FROM blocks WHERE source != 'special' AND start_at < ? AND end_at > ? AND id != ?`).run(end, start, onAir?.id ?? -1);
  });
  saveBlocks(blocks, "special");
}
