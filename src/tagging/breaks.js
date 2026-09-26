// Would this have aired with network-TV-style commercial breaks? Sitcoms, cartoons,
// network procedurals and medical dramas, rom-coms and TV-friendly movies: yes (their
// breaks inside get eyecatches, broadcast.eyecatches "tv"). Prestige premium-cable
// shows, arthouse and experimental films: no. Claude decides per show and per movie,
// once (shows.tv_breaks, items.tv_breaks).
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";

const CHUNK = 80;
const SCHEMA = {
  type: "object",
  properties: {
    titles: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, tv_breaks: { type: "boolean" } },
        required: ["id", "tv_breaks"],
        additionalProperties: false,
      },
    },
  },
  required: ["titles"],
  additionalProperties: false,
};
const SYSTEM = `A retro cable-TV channel plays a short "we'll be right back" bumper going into and out of the commercial break in the middle of a show or movie, the way broadcast and basic-cable TV did. For each title, say whether that fits it: would it have aired (or feel like it would air) on broadcast or basic-cable TV, cut for commercial breaks?

true: sitcoms (American ones especially), cartoons and kids' shows, anime, network dramas and procedurals (medical, legal, cop shows), game/reality/cooking shows, soaps, rom-coms, family films, comedies, blockbusters and the kind of movie that ran on network or basic-cable movie nights.
false: prestige premium-cable series made to run without breaks (HBO-style: The Sopranos, Game of Thrones), arthouse, experimental and festival films, slow foreign art cinema, very long epics, and hard-R/NC-17 material that TV wouldn't have run.

Base it on what you know about the title; if you don't know it, judge from the title and tags.`;

async function ask(client, lines) {
  const msg = await client.messages.create({
    model: config.claude.model,
    max_tokens: 8000,
    thinking: { type: "disabled" },
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: `id | kind | title | tags | genres\n${lines.join("\n")}` }],
  });
  const text = msg.content.find((b) => b.type === "text")?.text;
  if (msg.stop_reason !== "end_turn" || !text) throw new Error(`Claude stopped: ${msg.stop_reason}`);
  return JSON.parse(text).titles;
}

export async function tagBreaks({ redo = false } = {}) {
  const db = getDb();
  const shows = db.prepare(`SELECT 'show' kind, s.title, s.year, s.audience, s.anime, s.animated, s.origin, s.vibes, s.genres FROM shows s
    WHERE ${redo ? "1" : "s.tv_breaks IS NULL"} AND EXISTS (SELECT 1 FROM items i WHERE i.show_title = s.title AND i.kind = 'episode' AND ${schedulableSql("i")})
    ORDER BY s.title`).all();
  const movies = db.prepare(`SELECT 'movie' kind, i.id, i.title, i.year, t.audience, t.anime, t.animated, t.origin, t.mood vibes, i.genres FROM items i
    LEFT JOIN tags t ON t.item_id = i.id
    WHERE i.kind = 'movie' AND ${redo ? "1" : "i.tv_breaks IS NULL"} AND ${schedulableSql("i")} ORDER BY i.title`).all();
  const all = [...shows, ...movies];
  if (!all.length) return 0;
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  const putShow = db.prepare("UPDATE shows SET tv_breaks = ? WHERE title = ?");
  const putMovie = db.prepare("UPDATE items SET tv_breaks = ? WHERE id = ?");
  let n = 0, yes = 0;
  for (let k = 0; k < all.length; k += CHUNK) {
    const chunk = all.slice(k, k + CHUNK);
    const lines = chunk.map((s, i) => {
      const tags = [s.audience, s.anime ? "anime" : s.animated ? "animated" : "live action", s.origin, ...JSON.parse(s.vibes || "[]")].filter(Boolean).join(", ");
      return `${i + 1} | ${s.kind} | ${s.title}${s.year ? ` (${s.year})` : ""} | ${tags} | ${s.genres ? JSON.parse(s.genres).slice(0, 3).join("/") : ""}`;
    });
    const out = await ask(client, lines);
    tx(() => {
      for (const r of out) {
        const s = chunk[r.id - 1];
        if (!s) continue;
        if (s.kind === "show") putShow.run(r.tv_breaks ? 1 : 0, s.title);
        else putMovie.run(r.tv_breaks ? 1 : 0, s.id);
        n++;
        if (r.tv_breaks) yes++;
      }
    });
  }
  log.info(`tag: TV-style breaks: ${yes} of ${n} shows/movies`);
  return n;
}
