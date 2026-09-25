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

export function refreshHolidayBuckets() {
  tx((db) => {
    db.prepare("DELETE FROM buckets WHERE source = 'auto'").run();
    for (const h of HOLIDAYS) {
      const eps = db.prepare(`SELECT i.id FROM items i JOIN tags t ON t.item_id = i.id
        WHERE t.holiday = ? AND i.kind = 'episode' AND ${schedulableSql("i")}`).all(h.theme).map((r) => r.id);
      const movies = db.prepare(`SELECT i.id FROM items i JOIN tags t ON t.item_id = i.id
        WHERE t.holiday = ? AND i.kind = 'movie' AND ${schedulableSql("i")}`).all(h.theme).map((r) => r.id);
      const base = { active_from: h.from, active_to: h.to };
      if (eps.length >= MIN_MEMBERS.variety) {
        saveBucket(db, { ...base, name: `${h.name} Episodes`, about: `${h.theme} episodes of regular shows`, format: "variety",
          dayparts: ["morning", "afternoon", "evening", "late"], items: eps }, "auto");
      }
      if (movies.length >= MIN_MEMBERS.movie) {
        saveBucket(db, { ...base, name: `${h.name} Movies`, about: `${h.theme} movies`, format: "movie",
          dayparts: ["afternoon", "evening", "late"], items: movies }, "auto");
      }
    }
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

const BUCKET = {
  type: "object",
  properties: {
    name: { type: "string" },
    about: { type: "string" },
    format: { type: "string", enum: FORMATS },
    dayparts: { type: "array", items: { type: "string", enum: DAYPARTS } },
    active_from: { type: "string" },
    active_to: { type: "string" },
    members: { type: "array", items: { type: "string" } },
  },
  required: ["name", "about", "format", "dayparts", "active_from", "active_to", "members"],
  additionalProperties: false,
};
const SCHEMA = {
  type: "object",
  properties: {
    buckets: { type: "array", items: BUCKET },
    additions: {
      type: "array",
      items: {
        type: "object",
        properties: { bucket: { type: "string" }, members: { type: "array", items: { type: "string" } } },
        required: ["bucket", "members"],
        additionalProperties: false,
      },
    },
  },
  required: ["buckets", "additions"],
  additionalProperties: false,
};

const SYSTEM = `You're the program director of a retro cable-TV style channel run for a group of friends. You sort its catalog into buckets: kinds of programming blocks, like Saturday Morning Cartoons, Shonen Anime, Rom-Coms, Tearjerkers, Westerns, Samurai, Sentai, Tarantino, a Harry Potter series run, So Bad It's Good. Code later fills each block with random picks from its bucket, so everything in a bucket should be interchangeable for that block.

Each bucket:
- name: what viewers see as the block's title. 1 to 4 plain words (letters, numbers, spaces, & ' -). No emoji. Fun is fine, puns sparingly.
- about: one line on what belongs in it (only the admin sees this).
- format: one_show = each block is 1 to 3 episodes of one show (needs ${MIN_MEMBERS.one_show}+ shows); variety = each block mixes single episodes of different shows (needs ${MIN_MEMBERS.variety}+ shows; good for cartoons and sitcoms); movie = one movie per block (needs ${MIN_MEMBERS.movie}+ movies); movie_series = a franchise or series played in order across back-to-back blocks, members in watching order (${MIN_MEMBERS.movie_series}+ movies).
- dayparts: when it may air: morning (6-12), afternoon (12-17), evening (17-22), late (22-6). Kids material fits mornings and afternoons; adult, scary, gory or explicit material only evening and late.
- active_from / active_to: an MM-DD window for seasonal buckets (Halloween, Christmas, summer, Shark Week style events); both "" for all year.
- members: ids from the catalog (s... for shows, m... for movies). Shows only in one_show or variety buckets, movies only in movie or movie_series buckets.

Judge each title by what it actually is (genre, tone, era, reputation, including bad reputation), never by how famous it is: an obscure show belongs in every bucket it fits, the same as a famous one. Titles can be in many buckets; most should be in 2 to 4. Specific, flavorful buckets beat generic ones, but every title needs a home.`;

const bucketName = (n) => n.trim();
const nameOk = (n) => n.trim() && n.trim().split(/\s+/).length <= 4 && n.length <= 32 && /^[\p{L}\p{N} &'-]+$/u.test(n.trim());
const mmdd = (s) => /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s);

// Check Claude's answer. Returns { problems, fresh: [bucket rows to add], additions: [{id|name, shows, items}] }.
function check(out, cat, existing, mustPlace) {
  const problems = [];
  const names = new Set(existing.map((b) => b.name.toLowerCase()));
  const fresh = [];
  const placed = new Set();
  const members = (list, where, format) => {
    const shows = [], items = [];
    for (const raw of list) {
      const id = raw.trim();
      const t = cat.ids.get(id);
      if (!t) { problems.push(`${where}: "${id}" isn't a catalog id.`); continue; }
      if (isMovieFormat(format) !== (t.kind === "movie")) {
        problems.push(`${where}: ${id} (${t.title}) is a ${t.kind}, which doesn't fit a ${format} bucket.`);
        continue;
      }
      placed.add(id);
      if (t.kind === "show") { if (!shows.includes(t.title)) shows.push(t.title); } else if (!items.includes(t.id)) items.push(t.id);
    }
    return { shows, items };
  };
  for (const b of out.buckets) {
    const where = `Bucket "${b.name}"`;
    if (!nameOk(b.name)) problems.push(`${where}: the name must be 1 to 4 plain words.`);
    if (names.has(bucketName(b.name).toLowerCase())) problems.push(`${where}: that name is already taken.`);
    names.add(bucketName(b.name).toLowerCase());
    if (!b.dayparts.length) problems.push(`${where}: give it at least one daypart.`);
    if ((b.active_from || b.active_to) && !(mmdd(b.active_from) && mmdd(b.active_to))) problems.push(`${where}: active_from/active_to must both be MM-DD, or both "".`);
    const m = members(b.members, where, b.format);
    const n = m.shows.length + m.items.length;
    if (n < MIN_MEMBERS[b.format]) problems.push(`${where}: a ${b.format} bucket needs at least ${MIN_MEMBERS[b.format]} members; it has ${n}.`);
    fresh.push({ name: bucketName(b.name), about: b.about, format: b.format, dayparts: [...new Set(b.dayparts)],
      active_from: b.active_from || null, active_to: b.active_to || null, ...m });
  }
  const additions = [];
  for (const a of out.additions) {
    const target = existing.find((b) => b.name.toLowerCase() === a.bucket.trim().toLowerCase())
      || fresh.find((b) => b.name.toLowerCase() === a.bucket.trim().toLowerCase());
    if (!target) { problems.push(`Addition to "${a.bucket}": there's no bucket by that name.`); continue; }
    additions.push({ target, ...members(a.members, `Addition to "${a.bucket}"`, target.format) });
  }
  const missing = [...mustPlace].filter((id) => !placed.has(id));
  if (missing.length) {
    problems.push(`These titles aren't in any bucket yet; put each into at least one (new buckets or additions): ${missing.map((id) => `${id} ${cat.ids.get(id).title}`).join("; ")}`);
  }
  return { problems, fresh, additions };
}

async function ask(client, prompt, mustPlace, cat, existing) {
  const messages = [{ role: "user", content: prompt }];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const msg = await client.messages.create({
      model: config.claude.model,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages,
    });
    const text = msg.content.find((b) => b.type === "text")?.text;
    if (msg.stop_reason !== "end_turn" || !text) throw new Error(`Claude stopped: ${msg.stop_reason}`);
    messages.push({ role: "assistant", content: msg.content });
    const r = check(JSON.parse(text), cat, existing, mustPlace);
    log.info(`buckets: attempt ${attempt}: ${r.fresh.length} new, ${r.additions.length} additions, ${r.problems.length} problem(s) (${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out tokens)`);
    if (!r.problems.length || attempt === MAX_ATTEMPTS) return r;
    messages.push({ role: "user", content: `That has problems. Fix them and send the whole answer again:\n- ${r.problems.slice(0, 40).join("\n- ")}` });
  }
}

// Saves what's valid even after the last attempt: bad buckets are left out, and titles
// still without a bucket go into plain catch-all ones so everything can air.
function save(r, cat) {
  const placed = new Set();
  tx((db) => {
    for (const b of r.fresh) {
      if (!nameOk(b.name) || !b.dayparts.length || b.shows.length + b.items.length < MIN_MEMBERS[b.format]) continue;
      if (db.prepare("SELECT 1 FROM buckets WHERE lower(name) = lower(?) AND NOT retired").get(b.name)) continue;
      b.id = saveBucket(db, b, "claude");
      b.shows.forEach((s) => placed.add(s)); b.items.forEach((i) => placed.add(i));
    }
    for (const a of r.additions) {
      if (!a.target.id) continue;
      const have = new Set(db.prepare("SELECT COALESCE(show_title, item_id) k FROM bucket_members WHERE bucket_id = ?").all(a.target.id).map((x) => x.k));
      addMembers(db, a.target.id, a.shows.filter((s) => !have.has(s)), a.items.filter((i) => !have.has(i)));
    }
  });
  return catchAll(cat);
}

// Anything schedulable that's in no bucket at all: a plain "Reruns" / "Movie" bucket.
function catchAll(cat) {
  const db = getDb();
  const inShows = new Set(db.prepare("SELECT DISTINCT m.show_title t FROM bucket_members m JOIN buckets b ON b.id = m.bucket_id WHERE NOT b.retired AND m.show_title IS NOT NULL").all().map((r) => r.t));
  const inItems = new Set(db.prepare("SELECT DISTINCT m.item_id i FROM bucket_members m JOIN buckets b ON b.id = m.bucket_id WHERE NOT b.retired AND m.item_id IS NOT NULL").all().map((r) => r.i));
  const shows = [...cat.ids.values()].filter((t) => t.kind === "show" && !inShows.has(t.title)).map((t) => t.title);
  const movies = [...cat.ids.values()].filter((t) => t.kind === "movie" && !inItems.has(t.id)).map((t) => t.id);
  tx((d) => {
    for (const [name, format, shows_, items] of [["Reruns", "one_show", shows, []], ["Movie", "movie", [], movies]]) {
      if (!shows_.length && !items.length) continue;
      const have = d.prepare("SELECT id FROM buckets WHERE name = ? AND source = 'fallback'").get(name);
      if (have) addMembers(d, have.id, shows_, items);
      else saveBucket(d, { name, about: "titles no other bucket took", format, dayparts: ["afternoon", "evening", "late"], shows: shows_, items }, "fallback");
    }
  });
  return shows.length + movies.length;
}

function upcomingDates(days) {
  const out = [];
  for (let d = localDay(Date.now()), k = 0; k < days; k++, d = localDay(d.endMs + 1)) out.push(`${d.weekday} ${d.date}`);
  return out;
}

// The first pass: the whole catalog into 30-60 buckets.
export async function buildBuckets() {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  refreshHolidayBuckets();
  const cat = catalog();
  const existing = listBuckets();
  const prompt = `Create this channel's buckets: 30 to 60 of them, covering the whole catalog (every show and movie in at least one bucket). Today is ${upcomingDates(1)[0]}. Include seasonal buckets for the coming months too, with their active window. Halloween, Thanksgiving and Christmas episode/movie buckets already exist (made from holiday tags); you can still make more specific seasonal ones. additions: [].

CATALOG
${cat.text}`;
  const r = await ask(client, prompt, new Set(cat.ids.keys()), cat, existing);
  const leftover = save(r, cat);
  setMeta("buckets_updated", new Date().toISOString());
  log.info(`buckets: built ${r.fresh.length} buckets${leftover ? `; ${leftover} titles went to catch-all buckets` : ""}`);
}

// The weekly pass: a handful of new buckets for the next two weeks (seasonal and event
// ideas especially), and titles new to the catalog sorted into buckets.
export async function newBuckets({ count = 5 } = {}) {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  refreshHolidayBuckets();
  const cat = catalog();
  const existing = listBuckets();
  const inShows = new Set(existing.filter((b) => b.source !== "fallback").flatMap((b) => b.shows));
  const inItems = new Set(existing.filter((b) => b.source !== "fallback").flatMap((b) => b.items));
  const unplaced = [...cat.ids].filter(([, t]) => (t.kind === "show" ? !inShows.has(t.title) : !inItems.has(t.id))).map(([id]) => id);
  const list = existing.filter((b) => b.source !== "auto").map((b) =>
    `${b.name} | ${b.format} | ${b.dayparts.join("/")} | ${b.active_from ? `${b.active_from} to ${b.active_to}` : "all year"} | ${b.shows.length + b.items.length} titles | ${b.about || ""}`);
  const prompt = `The channel's existing buckets (name | format | dayparts | season | size | about):
${list.join("\n")}

The next two weeks: ${upcomingDates(14).join(", ")}.
Invent up to ${count} new buckets that would make these weeks fun: seasonal or event ideas especially (holidays, notable dates, "Shark Week" style themes), or fresh angles on the catalog nobody has used yet. Don't duplicate existing buckets. You can also add members to existing buckets (additions), e.g. titles that fit them better.
${unplaced.length ? `\nThese titles aren't in any bucket yet (new to the catalog, or left in the catch-all); place each one (additions or new buckets): ${unplaced.map((id) => `${id} ${cat.ids.get(id).title}`).join("; ")}\n` : ""}
CATALOG
${cat.text}`;
  const r = await ask(client, prompt, new Set(unplaced), cat, existing);
  // Titles placed now leave the catch-all buckets.
  save(r, cat);
  tx((db) => {
    db.prepare(`DELETE FROM bucket_members WHERE bucket_id IN (SELECT id FROM buckets WHERE source = 'fallback') AND (
      show_title IN (SELECT m.show_title FROM bucket_members m JOIN buckets b ON b.id = m.bucket_id WHERE b.source != 'fallback' AND NOT b.retired)
      OR item_id IN (SELECT m.item_id FROM bucket_members m JOIN buckets b ON b.id = m.bucket_id WHERE b.source != 'fallback' AND NOT b.retired))`).run();
  });
  setMeta("buckets_updated", new Date().toISOString());
  log.info(`buckets: ${r.fresh.map((b) => b.name).join(", ") || "no new buckets"}`);
}

// Called before planning: the first pass if there are no buckets, else the weekly pass
// once a week.
export async function ensureBuckets() {
  const n = getDb().prepare("SELECT COUNT(*) n FROM buckets WHERE source = 'claude' AND NOT retired").get().n;
  if (!n) return buildBuckets();
  const last = Date.parse(getMeta("buckets_updated") || 0) || 0;
  if (Date.now() - last > 6.5 * DAY) await newBuckets();
}
