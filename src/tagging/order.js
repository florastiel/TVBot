// Serialized or episodic? Serialized shows (a story that continues: Loki, Interview
// With The Vampire) air in order and now and then start over from episode one;
// episodic ones (sitcoms, anthologies: Fresh Prince, George Lopez, Black Mirror) air in
// random order. Claude decides per show, once; shows.random / shows.in_order in
// config.yaml override it.
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";

const CHUNK = 80;
const SCHEMA = {
  type: "object",
  properties: {
    shows: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, serialized: { type: "boolean" } },
        required: ["id", "serialized"],
        additionalProperties: false,
      },
    },
  },
  required: ["shows"],
  additionalProperties: false,
};
const SYSTEM = `For each TV show, say whether it's serialized: true if episodes build on each other so they're best watched in order (an ongoing story or arc, like Loki, Breaking Bad, most anime), false if episodes stand alone and can be watched in any order (sitcoms, sketch shows, anthologies, procedurals, most cartoons: Fresh Prince, George Lopez, Black Mirror, SpongeBob). Base it on what you know about the show; if you don't know it, judge from the title and tags.`;

export async function tagOrder({ redo = false } = {}) {
  const db = getDb();
  const shows = db.prepare(`SELECT s.title, s.year, s.audience, s.anime, s.animated, s.genres FROM shows s
    WHERE ${redo ? "1" : "s.serialized IS NULL"} AND EXISTS (SELECT 1 FROM items i WHERE i.show_title = s.title AND i.kind = 'episode' AND ${schedulableSql("i")})
    ORDER BY s.title`).all();
  if (!shows.length) return 0;
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  const put = db.prepare("UPDATE shows SET serialized = ? WHERE title = ?");
  let n = 0;
  for (let k = 0; k < shows.length; k += CHUNK) {
    const chunk = shows.slice(k, k + CHUNK);
    const lines = chunk.map((s, i) => `${i + 1} | ${s.title}${s.year ? ` (${s.year})` : ""} | ${[s.audience, s.anime ? "anime" : s.animated ? "animated" : "live action"].filter(Boolean).join(", ")} | ${s.genres ? JSON.parse(s.genres).slice(0, 3).join("/") : ""}`);
    const msg = await client.messages.create({
      model: config.claude.model,
      max_tokens: 8000,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `id | title | tags | genres\n${lines.join("\n")}` }],
    });
    const text = msg.content.find((b) => b.type === "text")?.text;
    if (msg.stop_reason !== "end_turn" || !text) throw new Error(`Claude stopped: ${msg.stop_reason}`);
    tx(() => {
      for (const r of JSON.parse(text).shows) {
        const s = chunk[r.id - 1];
        if (s) { put.run(r.serialized ? 1 : 0, s.title); n++; }
      }
    });
  }
  log.info(`tag: serialized/episodic set for ${n} shows`);
  return n;
}
