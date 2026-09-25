// Tags shows, movies and episodes with Claude, once. Results are stored in the DB and
// never redone unless asked (tv.cmd tag --redo). Uses the Message Batches API: half
// price, and nothing here is in a hurry.
//
//   shows:    vibe, audience, animated, anime, origin, decade (per show, not per episode)
//   movies:   same, plus holiday
//   episodes: holiday only, and only for episodes with real metadata (title + summary)
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config, secrets, DATA_DIR } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";

export const VIBES = ["goofy", "witty", "cozy", "wholesome", "nostalgic", "chill", "weird", "edgy", "dark",
  "spooky", "action-packed", "epic", "dramatic", "romantic", "heartfelt", "suspenseful", "smart", "gross-out"];
const AUDIENCES = ["kids", "family", "teen", "adult"];
const ORIGINS = ["us", "uk", "canada", "japan", "korea", "other"];
const HOLIDAYS = ["none", "halloween", "thanksgiving", "christmas"];

const PENDING = join(DATA_DIR, "tagging-batch.json");
// USD per million tokens at batch (half) price, for the cost report.
const BATCH_PRICE = { "claude-sonnet-5": [1, 5], "claude-haiku-4-5": [0.5, 2.5], "claude-opus-5": [2.5, 12.5] };

const SYSTEM = `You tag entries in a TV catalog. The tags drive an automatic scheduler for a retro cable-TV style channel that groups shows into themed blocks, so they need to be accurate and consistent. Base every answer on what you know about the title plus the metadata given. If you don't recognize a title, infer conservatively from the metadata.

Field meanings:
- vibes: 1 to 3 words from the allowed list that best describe how watching it feels.
- audience: "kids" = made for children; "family" = fine for all ages; "teen" = teen/young-adult; "adult" = made for adults (crude, violent or mature).
- animated: true for any animation (cartoons, anime, CGI series).
- anime: true only for Japanese animation.
- origin: country where it was made.
- decade: decade it first aired or was released, like 1990.
- holiday: set only when the whole thing is centrally about Halloween, Thanksgiving or Christmas (a Christmas special, a Halloween episode). A passing mention is "none".`;

const tagFields = {
  vibes: { type: "array", items: { type: "string", enum: VIBES } },
  audience: { type: "string", enum: AUDIENCES },
  animated: { type: "boolean" },
  anime: { type: "boolean" },
  origin: { type: "string", enum: ORIGINS },
  decade: { type: "integer" },
  holiday: { type: "string", enum: HOLIDAYS },
};
const listSchema = (key, props) => ({
  type: "object",
  properties: {
    [key]: {
      type: "array",
      items: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false },
    },
  },
  required: [key],
  additionalProperties: false,
});
const SCHEMAS = {
  shows: listSchema("items", { id: { type: "integer" }, ...tagFields }),
  movies: listSchema("items", { id: { type: "integer" }, ...tagFields }),
  // Only the holiday episodes come back; everything not listed is "none".
  episodes: listSchema("holidays", {
    id: { type: "integer" },
    holiday: { type: "string", enum: HOLIDAYS.filter((h) => h !== "none") },
  }),
};

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || "");
const genres = (g) => (g ? JSON.parse(g).join(", ") : "");

// What still needs tagging, as request-sized chunks.
function collect(redo) {
  const db = getDb();
  const sched = schedulableSql("i");
  const shows = db.prepare(`
    SELECT s.title, s.summary, s.year, s.genres, MIN(i.year) first_year, COUNT(*) episodes
    FROM shows s JOIN items i ON i.show_title = s.title AND i.kind = 'episode' AND ${sched}
    ${redo ? "" : "WHERE s.tagged_at IS NULL"} GROUP BY s.title`).all();
  const movies = db.prepare(`SELECT i.* FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = 'movie' AND ${sched} ${redo ? "" : "AND t.item_id IS NULL"}`).all();
  const episodes = db.prepare(`SELECT i.* FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = 'episode' AND i.match = 'full' AND ${sched} ${redo ? "" : "AND t.item_id IS NULL"}
    ORDER BY i.show_title, i.season, i.episode`).all();
  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, k) => arr.slice(k * n, k * n + n));
  return { shows: chunk(shows, 25), movies: chunk(movies, 25), episodes: chunk(episodes, 100) };
}

function prompt(kind, rows) {
  if (kind === "shows") {
    return "Tag each TV show.\n\n" + rows.map((r, i) =>
      `id ${i}: ${r.title} (first aired ${r.first_year || r.year || "?"}; ${r.episodes} episodes)` +
      `\ngenres: ${genres(r.genres)}\nsummary: ${clip(r.summary, 500)}`).join("\n\n");
  }
  if (kind === "movies") {
    return "Tag each movie.\n\n" + rows.map((r, i) =>
      `id ${i}: ${r.title} (${r.year || "?"})\ngenres: ${genres(r.genres)}\nsummary: ${clip(r.summary, 500)}`).join("\n\n");
  }
  return "Which of these TV episodes are Halloween, Thanksgiving or Christmas episodes? List only those; leave the rest out. An empty list is a fine answer.\n\n" +
    rows.map((r, i) => `id ${i}: ${r.show_title} S${r.season ?? "?"}E${r.episode ?? "?"} "${r.title}"` +
      `${r.air_date ? ` (aired ${r.air_date})` : ""}\n${clip(r.summary, 400)}`).join("\n\n");
}

function request(customId, kind, rows) {
  return {
    custom_id: customId,
    params: {
      model: config.claude.model,
      max_tokens: 8000,
      thinking: { type: "disabled" }, // plain classification; thinking would only add cost
      system: SYSTEM,
      messages: [{ role: "user", content: prompt(kind, rows) }],
      output_config: { format: { type: "json_schema", schema: SCHEMAS[kind] } },
    },
  };
}

const bool = (b) => (b ? 1 : 0);
const decadeOf = (d, year) => (year ? Math.floor(year / 10) * 10 : Number.isInteger(d) ? Math.floor(d / 10) * 10 : null);

function save(kind, rows, out) {
  const db = getDb();
  const now = new Date().toISOString();
  if (kind === "shows") {
    const upd = db.prepare(`UPDATE shows SET vibes = ?, audience = ?, kids = ?, animated = ?, anime = ?, origin = ?,
      decade = ?, holiday = ?, tag_source = 'ai', tagged_at = ? WHERE title = ?`);
    for (const t of out.items) {
      const r = rows[t.id];
      if (!r) continue;
      upd.run(JSON.stringify(t.vibes.slice(0, 3)), t.audience, bool(t.audience === "kids"), bool(t.animated),
        bool(t.anime), t.origin, decadeOf(t.decade, r.first_year || r.year), t.holiday, now, r.title);
    }
    return;
  }
  const put = db.prepare(`INSERT INTO tags (item_id, holiday, mood, decade, kids, animated, audience, anime, origin, source, tagged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?)
    ON CONFLICT (item_id) DO UPDATE SET holiday = excluded.holiday, mood = excluded.mood, decade = excluded.decade,
      kids = excluded.kids, animated = excluded.animated, audience = excluded.audience, anime = excluded.anime,
      origin = excluded.origin, source = 'ai', tagged_at = excluded.tagged_at`);
  if (kind === "movies") {
    for (const t of out.items) {
      const r = rows[t.id];
      if (!r) continue;
      put.run(r.id, t.holiday, JSON.stringify(t.vibes.slice(0, 3)), decadeOf(t.decade, r.year), bool(t.audience === "kids"),
        bool(t.animated), t.audience, bool(t.anime), t.origin, now);
    }
    return;
  }
  // Episodes: holiday only; everything else comes from the show.
  const holidays = new Map(out.holidays.map((h) => [h.id, h.holiday]));
  rows.forEach((r, i) => put.run(r.id, holidays.get(i) || "none", null, null, null, null, null, null, null, now));
}

// Episodes Plex couldn't pin down have no title or summary to judge by: holiday "none",
// no API call needed.
function tagShowOnlyEpisodes(redo) {
  const n = getDb().prepare(`INSERT INTO tags (item_id, holiday, source, tagged_at)
    SELECT i.id, 'none', 'auto', ? FROM items i LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = 'episode' AND i.match != 'full' AND ${schedulableSql("i")} ${redo ? "" : "AND t.item_id IS NULL"}
    ON CONFLICT (item_id) DO NOTHING`).run(new Date().toISOString()).changes;
  if (n) log.info(`tag: ${n} episodes without episode info marked holiday=none (no API call)`);
}

// No API calls: what would be sent, and roughly what it costs (~4 characters per token).
export function dryRun({ redo = false } = {}) {
  const work = collect(redo);
  let chars = 0, requests = 0;
  for (const [kind, list] of Object.entries(work)) {
    for (const rows of list) {
      chars += SYSTEM.length + prompt(kind, rows).length + JSON.stringify(SCHEMAS[kind]).length;
      requests++;
    }
    log.info(`tag (dry): ${list.flat().length} ${kind} in ${list.length} requests`);
  }
  const inTok = chars / 4;
  const outTok = work.shows.flat().length * 60 + work.movies.flat().length * 60 + work.episodes.length * 40;
  const price = BATCH_PRICE[config.claude.model];
  log.info(`tag (dry): ~${Math.round(inTok).toLocaleString()} input + ~${outTok.toLocaleString()} output tokens` +
    (price ? ` ≈ $${((inTok * price[0] + outTok * price[1]) / 1e6).toFixed(2)} with ${config.claude.model} (batch price)` : ""));
}

// One small chunk of each kind, sent directly (not batched), printed and NOT saved.
export async function sample() {
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  const work = collect(false);
  for (const kind of ["shows", "movies", "episodes"]) {
    const rows = work[kind][0]?.slice(0, kind === "episodes" ? 100 : 6);
    if (!rows?.length) continue;
    const msg = await client.messages.create(request("sample", kind, rows).params);
    const out = JSON.parse(msg.content.find((b) => b.type === "text").text);
    console.log(`
== ${kind} (${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out tokens, ${msg.stop_reason})`);
    if (kind === "episodes") {
      console.log(`${rows.length} episodes from ${[...new Set(rows.map((r) => r.show_title))].join(", ")}; holiday ones:`);
      for (const h of out.holidays) console.log(`  ${h.holiday}: ${rows[h.id].show_title} S${rows[h.id].season}E${rows[h.id].episode} "${rows[h.id].title}"`);
    } else {
      for (const t of out.items) console.log(`  ${rows[t.id].title}: ${t.vibes.join("/")}, ${t.audience}, ${t.animated ? "animated" : "live"}${t.anime ? " anime" : ""}, ${t.origin}, ${t.decade}s, holiday=${t.holiday}`);
    }
  }
}

export async function runTagging({ redo = false } = {}) {
  if (!secrets.anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  const client = new Anthropic({ apiKey: secrets.anthropicKey });

  // Resume a batch from an earlier run instead of paying for it twice.
  let pending = existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, "utf8")) : null;
  if (!pending) {
    tagShowOnlyEpisodes(redo);
    const work = collect(redo);
    const requests = [];
    const chunks = {};
    for (const [kind, list] of Object.entries(work)) {
      list.forEach((rows, n) => {
        const id = `${kind}-${n}`;
        requests.push(request(id, kind, rows));
        chunks[id] = { kind, rows };
      });
    }
    const counts = Object.entries(work).map(([k, l]) => `${l.flat().length} ${k}`).join(", ");
    if (!requests.length) {
      log.info("tag: everything is already tagged");
      return;
    }
    log.info(`tag: sending ${requests.length} requests to ${config.claude.model} (${counts})`);
    const batch = await client.messages.batches.create({ requests });
    pending = { batchId: batch.id, model: config.claude.model, chunks };
    writeFileSync(PENDING, JSON.stringify(pending));
  } else {
    log.info(`tag: resuming batch ${pending.batchId}`);
  }

  let batch;
  for (;;) {
    batch = await client.messages.batches.retrieve(pending.batchId);
    const c = batch.request_counts;
    log.info(`tag: batch ${batch.processing_status}: ${c.succeeded} done, ${c.processing} working, ${c.errored} errors`);
    if (batch.processing_status === "ended") break;
    await sleep(30000);
  }

  let inTok = 0, outTok = 0, failed = 0;
  for await (const res of await client.messages.batches.results(pending.batchId)) {
    const chunk = pending.chunks[res.custom_id];
    if (!chunk) continue;
    if (res.result.type !== "succeeded") {
      failed++;
      log.warn(`tag: ${res.custom_id} ${res.result.type}; those items stay untagged and are retried next run`);
      continue;
    }
    const msg = res.result.message;
    inTok += msg.usage.input_tokens;
    outTok += msg.usage.output_tokens;
    const text = msg.content.find((b) => b.type === "text")?.text;
    if (msg.stop_reason !== "end_turn" || !text) {
      failed++;
      log.warn(`tag: ${res.custom_id} stopped (${msg.stop_reason}); retried next run`);
      continue;
    }
    try {
      tx(() => save(chunk.kind, chunk.rows, JSON.parse(text)));
    } catch (e) {
      failed++;
      log.warn(`tag: ${res.custom_id} couldn't be saved (${e.message}); retried next run`);
    }
  }
  rmSync(PENDING, { force: true });

  const price = BATCH_PRICE[pending.model];
  const cost = price ? ` ≈ $${((inTok * price[0] + outTok * price[1]) / 1e6).toFixed(2)}` : "";
  log.info(`tag: done. ${inTok.toLocaleString()} input + ${outTok.toLocaleString()} output tokens${cost}` +
    (failed ? `; ${failed} requests failed (run again to retry them)` : ""));
}
