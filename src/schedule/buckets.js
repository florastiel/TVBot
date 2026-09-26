// Buckets: kinds of programming blocks ("Saturday Morning Cartoons", "Westerns",
// "Tearjerkers"). Claude sorts the catalog into them, many-to-many, judging titles by
// what they are rather than how famous they are, and invents a few new ones each week
// (seasonal ones especially). Code fills blocks with random picks from a bucket.
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb, tx, getMeta, setMeta } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";
import { localDay } from "./time.js";

export const FORMATS = ["one_show", "variety", "movie", "movie_series"];
export const DAYPARTS = ["morning", "afternoon", "evening", "late"];
export const isMovieFormat = (f) => f === "movie" || f === "movie_series";
const MIN_MEMBERS = { one_show: 3, variety: 4, movie: 3, movie_series: 2 };
const MAX_ATTEMPTS = 3;
const DAY = 86400000;

// morning 6-12, afternoon 12-17, evening 17-22, late 22-6 (channel time).
export function daypart(hour) {
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "late";
}

// In season on this local day? Seasonal buckets have an MM-DD window (may wrap New Year).
export function inSeason(b, day) {
  if (!b.active_from || !b.active_to) return true;
  const md = `${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
  return b.active_from <= b.active_to ? md >= b.active_from && md <= b.active_to : md >= b.active_from || md <= b.active_to;
}

export function listBuckets({ all = false } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM buckets ${all ? "" : "WHERE NOT retired"} ORDER BY name`).all();
  const mem = db.prepare("SELECT show_title, item_id FROM bucket_members WHERE bucket_id = ? ORDER BY position, rowid");
  for (const b of rows) {
    b.dayparts = JSON.parse(b.dayparts);
    const m = mem.all(b.id);
    b.shows = m.filter((x) => x.show_title).map((x) => x.show_title);
    b.items = m.filter((x) => x.item_id).map((x) => x.item_id);
    b.premiere = b.source === "auto" && b.name === PREMIERE;
  }
  return rows;
}

function saveBucket(db, b, source) {
  const id = db.prepare(`INSERT INTO buckets (name, about, format, dayparts, active_from, active_to, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(b.name, b.about || null, b.format, JSON.stringify(b.dayparts),
    b.active_from || null, b.active_to || null, source, new Date().toISOString()).lastInsertRowid;
  addMembers(db, id, b.shows || [], b.items || []);
  return id;
}

function addMembers(db, id, shows, items) {
  const have = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM bucket_members WHERE bucket_id = ?").get(id).p;
  const put = db.prepare("INSERT INTO bucket_members (bucket_id, show_title, item_id, position) VALUES (?, ?, ?, ?)");
  let p = have;
  for (const s of shows) put.run(id, s, null, p++);
  for (const i of items) put.run(id, null, i, p++);
}

// ---------- automatic holiday buckets (from the holiday tags) ----------

const HOLIDAYS = [
  { theme: "halloween", name: "Halloween", from: "10-01", to: "10-31" },
  { theme: "thanksgiving", name: "Thanksgiving", from: "11-01", to: "11-28" },
  { theme: "christmas", name: "Christmas", from: "11-24", to: "12-25" },
];

// Code-made buckets (auto, fallback) are updated in place, since the week's grid points
// at them: same name and source = same bucket. Ones no longer wanted are retired.
function syncBuckets(db, source, list) {
  const find = db.prepare("SELECT id FROM buckets WHERE source = ? AND name = ?");
  const upd = db.prepare(`UPDATE buckets SET about = ?, format = ?, dayparts = ?, active_from = ?, active_to = ?, retired = 0 WHERE id = ?`);
  for (const b of list) {
    const have = find.get(source, b.name);
    if (!have) { saveBucket(db, b, source); continue; }
    upd.run(b.about || null, b.format, JSON.stringify(b.dayparts), b.active_from || null, b.active_to || null, have.id);
    db.prepare("DELETE FROM bucket_members WHERE bucket_id = ?").run(have.id);
    addMembers(db, have.id, b.shows || [], b.items || []);
  }
  const keep = list.map((b) => b.name);
  db.prepare(`UPDATE buckets SET retired = 1 WHERE source = ? ${keep.length ? `AND name NOT IN (${keep.map(() => "?").join(",")})` : ""}`).run(source, ...keep);
}

export const PREMIERE = "Series Premiere";

export function refreshHolidayBuckets() {
  tx((db) => {
    const want = [];
    // Serialized shows from episode one (fill.js only takes ones not aired lately).
    const serial = db.prepare(`SELECT s.title FROM shows s WHERE s.serialized = 1 AND COALESCE(s.audience, '') != 'kids'
      AND EXISTS (SELECT 1 FROM items i WHERE i.show_title = s.title AND i.kind = 'episode' AND ${schedulableSql("i")})`).all().map((r) => r.title);
    if (serial.length >= MIN_MEMBERS.one_show) {
      want.push({ name: PREMIERE, about: "a serialized show from its first episode", format: "one_show", dayparts: ["afternoon", "evening", "late"], shows: serial });
    }
    // Special episodes found from their titles (tagging/episodes.js).
    for (const [theme, name, from, to] of [["musical", "Musical Episodes", null, null], ["beach", "Beach Episodes", "05-15", "09-15"]]) {
      const eps = db.prepare(`SELECT i.id FROM item_themes t JOIN items i ON i.id = t.item_id WHERE t.theme = ? AND ${schedulableSql("i")}`).all(theme).map((r) => r.id);
      if (eps.length >= MIN_MEMBERS.variety) {
        want.push({ name, about: `${theme} episodes of regular shows`, format: "variety", dayparts: ["afternoon", "evening", "late"], items: eps, active_from: from, active_to: to });
      }
    }
    // Everything in the shorts folder.
    const shorts = db.prepare(`SELECT i.id FROM items i WHERE i.kind = 'short' AND ${schedulableSql("i")}`).all().map((r) => r.id);
    if (shorts.length >= MIN_MEMBERS.variety) {
      want.push({ name: "Shorts", about: "short shows back to back", format: "variety", dayparts: ["morning", "afternoon", "evening", "late"], items: shorts });
    }
    for (const h of HOLIDAYS) {
      const eps = db.prepare(`SELECT i.id FROM items i JOIN tags t ON t.item_id = i.id
        WHERE t.holiday = ? AND i.kind = 'episode' AND ${schedulableSql("i")}`).all(h.theme).map((r) => r.id);
      const movies = db.prepare(`SELECT i.id FROM items i JOIN tags t ON t.item_id = i.id
        WHERE t.holiday = ? AND i.kind = 'movie' AND ${schedulableSql("i")}`).all(h.theme).map((r) => r.id);
      const base = { active_from: h.from, active_to: h.to };
      if (eps.length >= MIN_MEMBERS.variety) {
        want.push({ ...base, name: `${h.name} Episodes`, about: `${h.theme} episodes of regular shows`, format: "variety",
          dayparts: ["morning", "afternoon", "evening", "late"], items: eps });
      }
      if (movies.length >= MIN_MEMBERS.movie) {
        want.push({ ...base, name: `${h.name} Movies`, about: `${h.theme} movies`, format: "movie",
          dayparts: ["afternoon", "evening", "late"], items: movies });
      }
    }
    syncBuckets(db, "auto", want);
  });
}

// ---------- the catalog, as Claude sees it ----------

const vibes = (j) => (j ? JSON.parse(j).join("/") : "");
const genreList = (j) => (j ? JSON.parse(j).slice(0, 3).join("/") : "");
const mins = (ms) => Math.round((ms || 0) / 60000);

// Titles get short ids: s12 for shows, m4567 for movies (the item id).
function catalog() {
  const db = getDb();
  const shows = db.prepare(`SELECT s.*, COUNT(i.id) n, AVG(i.duration_ms) avg, MIN(i.year) y FROM shows s
    JOIN items i ON i.show_title = s.title AND i.kind = 'episode' AND ${schedulableSql("i")}
    GROUP BY s.title ORDER BY s.title`).all();
  const movies = db.prepare(`SELECT i.*, t.audience, t.animated, t.anime, t.origin, t.mood, t.holiday FROM items i
    LEFT JOIN tags t ON t.item_id = i.id WHERE i.kind = 'movie' AND ${schedulableSql("i")} ORDER BY i.title`).all();
  const ids = new Map(); // "s12" / "m4567" -> { kind: "show", title } | { kind: "movie", id, title }
  const lines = ["SHOWS (id | title (year) | episodes x minutes | audience, look, origin, decade, vibes | genres)"];
  shows.forEach((s, k) => {
    const id = `s${k + 1}`;
    ids.set(id, { kind: "show", title: s.title });
    const tags = [s.audience, s.anime ? "anime" : s.animated ? "animated" : "live action", s.origin, s.decade ? `${s.decade}s` : null, vibes(s.vibes)].filter(Boolean).join(", ");
    lines.push(`${id} | ${s.title}${s.year || s.y ? ` (${s.year || s.y})` : ""} | ${s.n} x ${mins(s.avg)} | ${tags} | ${genreList(s.genres)}`);
  });
  lines.push("\nMOVIES (id | title (year) | minutes | audience, look, origin, vibes, holiday | genres)");
  for (const m of movies) {
    const id = `m${m.id}`;
    ids.set(id, { kind: "movie", id: m.id, title: m.title });
    const tags = [m.audience, m.anime ? "anime" : m.animated ? "animated" : "live action", m.origin, vibes(m.mood), m.holiday && m.holiday !== "none" ? m.holiday : null].filter(Boolean).join(", ");
    lines.push(`${id} | ${m.title} (${m.year ?? "?"}) | ${mins(m.duration_ms)} | ${tags} | ${genreList(m.genres)}`);
  }
  return { text: lines.join("\n"), ids };
}

// ---------- Claude ----------
// Two steps, so every title gets looked at on its own: (1) define buckets (names and
// rules, no members), (2) go through the catalog in chunks, listing for each title every
// bucket it fits.

const DEFINE_SCHEMA = {
  type: "object",
  properties: {
    buckets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          about: { type: "string" },
          format: { type: "string", enum: FORMATS },
          dayparts: { type: "array", items: { type: "string", enum: DAYPARTS } },
          active_from: { type: "string" },
          active_to: { type: "string" },
        },
        required: ["name", "about", "format", "dayparts", "active_from", "active_to"],
        additionalProperties: false,
      },
    },
  },
  required: ["buckets"],
  additionalProperties: false,
};

const ASSIGN_SCHEMA = {
  type: "object",
  properties: {
    titles: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, buckets: { type: "array", items: { type: "string" } } },
        required: ["id", "buckets"],
        additionalProperties: false,
      },
    },
  },
  required: ["titles"],
  additionalProperties: false,
};

const RULES = `Buckets are kinds of programming blocks for a retro cable-TV style channel run for a group of friends, like Saturday Morning Cartoons, Shonen Anime, Rom-Coms, Tearjerkers, Westerns, Samurai, Sentai, Tarantino, a Harry Potter series run, So Bad It's Good. Code fills each block with random picks from its bucket, so everything in a bucket should be interchangeable for that block.

Each bucket has:
- name: what viewers see as the block's title. 1 to 4 plain words (letters, numbers, spaces, & ' -). No emoji. Fun is fine, puns sparingly.
- about: one line on exactly what belongs in it.
- format: one_show = each block is 1 to 3 episodes of one show (needs ${MIN_MEMBERS.one_show}+ shows); variety = each block mixes single episodes of different shows (needs ${MIN_MEMBERS.variety}+ shows; good for cartoons and sitcoms); movie = one movie per block (needs ${MIN_MEMBERS.movie}+ movies); movie_series = one franchise or series played in order across back-to-back blocks (${MIN_MEMBERS.movie_series}+ movies of that series).
- dayparts: when it may air: morning (6-12), afternoon (12-17), evening (17-22), late (22-6). Kids material fits mornings and afternoons; adult, scary, gory or explicit material only evening and late.
- active_from / active_to: an MM-DD window for seasonal buckets (Halloween, Christmas, summer, Shark Week style events); both "" for all year.
Shows only go in one_show or variety buckets; movies only in movie or movie_series buckets.`;

const DEFINE_SYSTEM = `You're the program director of the channel. ${RULES}

You define buckets that suit the catalog you're shown: specific, flavorful ones beat generic ones, but together they must give every show and movie a home. Base them on what the titles actually are (genre, tone, era, reputation, including bad reputation), and cover the obscure corners of the catalog as well as the famous parts.`;

const ASSIGN_SYSTEM = `You sort a TV channel's catalog into its buckets. ${RULES}

For each title you're given, list the name of every bucket it fits (exact names from the list). Judge each title by what it actually is (genre, tone, era, reputation, including bad reputation), never by how famous it is: an obscure title goes in every bucket it fits, the same as a famous one. Most titles fit 2 to 4 buckets. A movie_series bucket takes only the movies of that one series.`;

const nameOk = (n) => n.trim() && n.trim().split(/\s+/).length <= 4 && n.length <= 32 && /^[\p{L}\p{N} &'-]+$/u.test(n.trim());
const mmdd = (s) => /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s);

// One structured Claude call with a few retries on problems. check(out) -> problems[].
// No extended thinking: this is classification, and the answer itself is the reasoning
// (with thinking on, it spent the whole token budget deliberating over the catalog).
async function askClaude(client, { system, schema, prompt, check, maxTokens = 32000, tag }) {
  const messages = [{ role: "user", content: prompt }];
  let out;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Streamed: a big answer can take a few minutes.
    const msg = await client.messages.stream({
      model: config.claude.model,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema } },
      system,
      messages,
    }).finalMessage();
    const text = msg.content.find((b) => b.type === "text")?.text;
    if (msg.stop_reason !== "end_turn" || !text) throw new Error(`Claude stopped: ${msg.stop_reason} (${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out tokens)`);
    messages.push({ role: "assistant", content: msg.content });
    out = JSON.parse(text);
    const problems = check(out);
    log.info(`buckets: ${tag} attempt ${attempt}: ${problems.length} problem(s) (${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out tokens)`);
    if (!problems.length) break;
    if (attempt < MAX_ATTEMPTS) messages.push({ role: "user", content: `That has problems. Fix them and send the whole answer again:\n- ${problems.slice(0, 40).join("\n- ")}` });
  }
  return out;
}

// Step 1: new bucket definitions (no members). Returns the valid ones.
async function defineBuckets(client, prompt, existing) {
  const taken = new Set(existing.map((b) => b.name.toLowerCase()));
  const problemsOf = (out) => {
    const problems = [];
    const seen = new Set();
    for (const b of out.buckets) {
      const where = `Bucket "${b.name}"`;
      const key = b.name.trim().toLowerCase();
      if (!nameOk(b.name)) problems.push(`${where}: the name must be 1 to 4 plain words.`);
      if (taken.has(key) || seen.has(key)) problems.push(`${where}: that name is already taken.`);
      seen.add(key);
      if (!b.dayparts.length) problems.push(`${where}: give it at least one daypart.`);
      if ((b.active_from || b.active_to) && !(mmdd(b.active_from) && mmdd(b.active_to))) problems.push(`${where}: active_from/active_to must both be MM-DD, or both "".`);
    }
    return problems;
  };
  const out = await askClaude(client, { system: DEFINE_SYSTEM, schema: DEFINE_SCHEMA, prompt, check: problemsOf, tag: "define" });
  const seen = new Set(taken);
  return out.buckets.filter((b) => {
    const key = b.name.trim().toLowerCase();
    const ok = nameOk(b.name) && b.dayparts.length && !seen.has(key) && (!(b.active_from || b.active_to) || (mmdd(b.active_from) && mmdd(b.active_to)));
    seen.add(key);
    return ok;
  }).map((b) => ({ ...b, name: b.name.trim(), dayparts: [...new Set(b.dayparts)], active_from: b.active_from || null, active_to: b.active_to || null }));
}

const bucketLine = (b) => `${b.name} | ${b.format} | ${b.dayparts.join("/")} | ${b.active_from ? `${b.active_from} to ${b.active_to}` : "all year"} | ${b.about || ""}`;

// Step 2: for each title (ids), the buckets it fits, in chunks. mustPlace: every title
// needs at least one. Returns Map id -> [bucket].
async function assign(client, buckets, ids, cat, { mustPlace }) {
  const byName = new Map(buckets.map((b) => [b.name.toLowerCase(), b]));
  const lineOf = new Map(cat.text.split("\n").map((l) => [l.split(" | ")[0], l]));
  const result = new Map();
  const CHUNK = 80;
  for (let k = 0; k < ids.length; k += CHUNK) {
    const chunk = ids.slice(k, k + CHUNK);
    const want = new Set(chunk);
    const fitOf = (id, name) => {
      const b = byName.get(name.trim().toLowerCase());
      return b && isMovieFormat(b.format) === (cat.ids.get(id).kind === "movie") ? b : null;
    };
    const problemsOf = (out) => {
      const problems = [];
      const got = new Set();
      for (const t of out.titles) {
        if (!want.has(t.id)) { problems.push(`"${t.id}" isn't one of the titles in this list.`); continue; }
        got.add(t.id);
        for (const n of t.buckets) {
          if (!byName.has(n.trim().toLowerCase())) problems.push(`${t.id}: there's no bucket called "${n}".`);
          else if (!fitOf(t.id, n)) problems.push(`${t.id} (${cat.ids.get(t.id).title}) is a ${cat.ids.get(t.id).kind}; "${n}" is for ${cat.ids.get(t.id).kind === "movie" ? "shows" : "movies"}.`);
        }
        if (mustPlace && !t.buckets.some((n) => fitOf(t.id, n))) problems.push(`${t.id} (${cat.ids.get(t.id).title}) needs at least one bucket.`);
      }
      const missing = chunk.filter((id) => !got.has(id));
      if (missing.length) problems.push(`These titles are missing from your answer: ${missing.join(", ")}.`);
      return problems;
    };
    const prompt = `BUCKETS (name | format | dayparts | season | about)
${buckets.map(bucketLine).join("\n")}

For each of these titles, list every bucket it fits${mustPlace ? " (at least one each)" : " (an empty list if none fits)"}:
${chunk.map((id) => lineOf.get(id)).join("\n")}`;
    const out = await askClaude(client, { system: ASSIGN_SYSTEM, schema: ASSIGN_SCHEMA, prompt, check: problemsOf, tag: `assign ${k / CHUNK + 1}/${Math.ceil(ids.length / CHUNK)}` });
    for (const t of out.titles) {
      if (!want.has(t.id)) continue;
      result.set(t.id, [...new Set(t.buckets.map((n) => fitOf(t.id, n)).filter(Boolean))]);
    }
  }
  return result;
}

// Saves buckets and their members (from assign's map). Buckets too small to fill blocks
// are dropped. Series are ordered by release year.
function saveAssigned(fresh, placed, cat) {
  const members = new Map(fresh.map((b) => [b, { shows: [], items: [] }]));
  const existingAdds = new Map();
  for (const [id, list] of placed) {
    const t = cat.ids.get(id);
    for (const b of list) {
      const m = members.get(b) ?? existingAdds.get(b) ?? existingAdds.set(b, { shows: [], items: [] }).get(b);
      if (t.kind === "show") m.shows.push(t.title); else m.items.push(t.id);
    }
  }
  const year = getDb().prepare("SELECT year FROM items WHERE id = ?");
  let saved = 0;
  tx((db) => {
    for (const [b, m] of members) {
      if (m.shows.length + m.items.length < MIN_MEMBERS[b.format]) { log.info(`buckets: dropped "${b.name}" (only ${m.shows.length + m.items.length} titles)`); continue; }
      if (b.format === "movie_series") m.items.sort((x, y) => (year.get(x)?.year || 0) - (year.get(y)?.year || 0));
      saveBucket(db, { ...b, ...m }, "claude");
      saved++;
    }
    for (const [b, m] of existingAdds) {
      const have = new Set(db.prepare("SELECT COALESCE(show_title, item_id) k FROM bucket_members WHERE bucket_id = ?").all(b.id).map((x) => x.k));
      addMembers(db, b.id, m.shows.filter((s) => !have.has(s)), m.items.filter((i) => !have.has(i)));
    }
  });
  return saved;
}

// Anything schedulable that's in no Claude bucket: plain "Reruns" / "Movie" buckets, so
// everything can still air. Titles placed elsewhere later leave them.
function catchAll(cat) {
  const db = getDb();
  const real = "SELECT DISTINCT {col} v FROM bucket_members m JOIN buckets b ON b.id = m.bucket_id WHERE b.source = 'claude' AND NOT b.retired AND m.{col} IS NOT NULL";
  const inShows = new Set(db.prepare(real.replaceAll("{col}", "show_title")).all().map((r) => r.v));
  const inItems = new Set(db.prepare(real.replaceAll("{col}", "item_id")).all().map((r) => r.v));
  const shows = [...cat.ids.values()].filter((t) => t.kind === "show" && !inShows.has(t.title)).map((t) => t.title);
  const movies = [...cat.ids.values()].filter((t) => t.kind === "movie" && !inItems.has(t.id)).map((t) => t.id);
  tx((d) => {
    const want = [];
    if (shows.length) want.push({ name: "Reruns", about: "titles no other bucket took", format: "one_show", dayparts: ["afternoon", "evening", "late"], shows });
    if (movies.length) want.push({ name: "Movie", about: "movies no other bucket took", format: "movie", dayparts: ["afternoon", "evening", "late"], items: movies });
    syncBuckets(d, "fallback", want);
  });
  return shows.length + movies.length;
}

function upcomingDates(days) {
  const out = [];
  for (let d = localDay(Date.now()), k = 0; k < days; k++, d = localDay(d.endMs + 1)) out.push(`${d.weekday} ${d.date}`);
  return out;
}

// The first pass: 30-60 buckets, then the whole catalog sorted into them.
export async function buildBuckets() {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  refreshHolidayBuckets();
  const cat = catalog();
  const fresh = await defineBuckets(client, `Define this channel's buckets: 30 to 60 of them that together give every show and movie below a home. Today is ${upcomingDates(1)[0]}; include seasonal buckets for the coming months too, with their active window. Halloween, Thanksgiving and Christmas episode and movie buckets already exist (made from holiday tags), but more specific seasonal ones are welcome.

CATALOG
${cat.text}`, listBuckets());
  const placed = await assign(client, fresh, [...cat.ids.keys()], cat, { mustPlace: true });
  const saved = saveAssigned(fresh, placed, cat);
  const leftover = catchAll(cat);
  setMeta("buckets_updated", new Date().toISOString());
  await import("./bucketpage.js").then((m) => m.writeBucketPage()).catch(() => {}); // buckets.html
  log.info(`buckets: built ${saved} buckets${leftover ? `; ${leftover} titles went to catch-all buckets` : ""}`);
}

// The weekly pass: a handful of new buckets for the next two weeks (seasonal and event
// ideas especially), the whole catalog checked against them, and titles that have no
// bucket yet (new to the catalog) sorted into all of them.
// thin: instead, new buckets for the titles that have only one bucket (often a loose fit
// the first pass had to force); "show" or "movie" for only those.
export async function newBuckets({ count = 5, request = null, thin = false } = {}) {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  refreshHolidayBuckets();
  const cat = catalog();
  const existing = listBuckets().filter((b) => b.source === "claude");
  let ask;
  if (thin) {
    const homes = new Map();
    for (const b of existing) for (const k of [...b.shows, ...b.items]) homes.set(k, [...(homes.get(k) || []), b.name]);
    const lonely = [...cat.ids].filter(([, t]) => (thin === true || thin === t.kind) && (homes.get(t.kind === "show" ? t.title : t.id) || []).length === 1)
      .map(([id, t]) => `${id} ${t.title} [now only in: ${homes.get(t.kind === "show" ? t.title : t.id)[0]}]`);
    ask = `These titles are each in only one bucket, and it's often a loose fit (the first pass had to put them somewhere):
${lonely.join("\n")}

Define up to ${count} new buckets that would be better, more natural homes for them: group them by what they really are (genre, tone, era, franchise, audience). Each new bucket needs enough titles to fill it; it can and should also take fitting titles from the rest of the catalog below. Don't duplicate existing buckets.`;
  } else if (request) {
    ask = `The admin asked for these buckets: ${request}. Define each one the catalog below can fill (skip one only if an existing bucket is really the same thing, or the catalog has too little for it).`;
  } else {
    ask = `Define up to ${count} new buckets that would make these weeks fun: seasonal or event ideas especially (holidays, notable dates, "Shark Week" style themes), or fresh angles on the catalog nobody has used yet. Don't duplicate existing buckets, and only define ones the catalog below can fill.`;
  }
  const fresh = await defineBuckets(client, `The channel's existing buckets (name | format | dayparts | season | about):
${existing.map(bucketLine).join("\n")}

The next two weeks: ${upcomingDates(14).join(", ")}.
${ask}

CATALOG
${cat.text}`, listBuckets());
  const placed = fresh.length ? await assign(client, fresh, [...cat.ids.keys()], cat, { mustPlace: false }) : new Map();
  const inShows = new Set(existing.flatMap((b) => b.shows));
  const inItems = new Set(existing.flatMap((b) => b.items));
  const unplaced = [...cat.ids].filter(([, t]) => (t.kind === "show" ? !inShows.has(t.title) : !inItems.has(t.id))).map(([id]) => id);
  if (unplaced.length) {
    const more = await assign(client, [...existing, ...fresh], unplaced, cat, { mustPlace: true });
    for (const [id, list] of more) placed.set(id, [...new Set([...(placed.get(id) || []), ...list])]);
  }
  const saved = saveAssigned(fresh, placed, cat);
  catchAll(cat);
  setMeta("buckets_updated", new Date().toISOString());
  await import("./bucketpage.js").then((m) => m.writeBucketPage()).catch(() => {}); // buckets.html
  log.info(`buckets: ${saved} new (${fresh.map((b) => b.name).join(", ") || "none"}); ${unplaced.length} unsorted titles placed`);
}

// Called before planning: the first pass if there are no buckets, else the weekly pass
// once a week. With claude.scheduling: local, no API: the weekly Claude Code job
// (PROGRAMMING.md) curates the buckets; in between, once a day, the holiday buckets are
// refreshed and titles new to the catalog go to the catch-all buckets so they can air.
export async function ensureBuckets() {
  const n = getDb().prepare("SELECT COUNT(*) n FROM buckets WHERE source = 'claude' AND NOT retired").get().n;
  if (config.claude.scheduling === "local") {
    const last = Date.parse(getMeta("buckets_refreshed") || 0) || 0;
    if (Date.now() - last < DAY) return;
    refreshHolidayBuckets();
    const leftover = catchAll(catalog());
    setMeta("buckets_refreshed", new Date().toISOString());
    if (leftover) log.info(`buckets: ${leftover} titles in no bucket yet went to the catch-all buckets (the weekly programming pass sorts them)`);
    return;
  }
  if (!n) return buildBuckets();
  const last = Date.parse(getMeta("buckets_updated") || 0) || 0;
  if (Date.now() - last > 6.5 * DAY) await newBuckets();
}
