// Episode themes: which episodes are musical episodes, beach episodes, ... Claude reads
// episode titles show by show (its own knowledge does the rest: "Once More, with
// Feeling" is Buffy's musical) and flags the ones that fit. Only fully identified
// episodes (real titles), each checked once. The flagged episodes become automatic
// buckets (buckets.js).
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb, tx, setMeta } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";

export const THEMES = {
  musical: "a musical episode: characters break into song as the plot (not just an episode with a band or a concert)",
  beach: "a beach, pool or water-park episode (swimsuits, summer vacation at the sea)",
};
const LINES_PER_CALL = 400;

const SCHEMA = {
  type: "object",
  properties: {
    episodes: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, theme: { type: "string", enum: Object.keys(THEMES) } },
        required: ["id", "theme"],
        additionalProperties: false,
      },
    },
  },
  required: ["episodes"],
  additionalProperties: false,
};
const SYSTEM = `You find special episodes in a TV catalog. You get shows with their episode titles; list the episodes that are one of these kinds:
${Object.entries(THEMES).map(([k, v]) => `- ${k}: ${v}`).join("\n")}
Use what you know about each show and episode, plus the titles. Only list episodes you're fairly sure about; most episodes are none of these, and an empty list is a fine answer.`;

export async function tagEpisodeThemes({ redo = false } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT i.id, i.show_title, i.season, i.episode, i.title FROM items i
    WHERE i.kind = 'episode' AND i.match = 'full' AND ${schedulableSql("i")} ${redo ? "" : "AND i.themes_checked IS NULL"}
    ORDER BY i.show_title, i.season, i.episode`).all();
  if (!rows.length) return 0;
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  const byShow = [...Map.groupBy(rows, (r) => r.show_title)];
  const mark = db.prepare("UPDATE items SET themes_checked = 1 WHERE id = ?");
  const put = db.prepare("INSERT OR IGNORE INTO item_themes (item_id, theme) VALUES (?, ?)");
  let found = 0, batch = [], lines = 0;
  const send = async () => {
    if (!batch.length) return;
    const text = batch.map(([show, eps]) => `${show}\n${eps.map((e) => `  ${e.id} S${e.season ?? "?"}E${e.episode ?? "?"} ${e.title}`).join("\n")}`).join("\n");
    const msg = await client.messages.create({
      model: config.claude.model,
      max_tokens: 8000,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: text }],
    });
    const out = msg.content.find((b) => b.type === "text")?.text;
    if (msg.stop_reason !== "end_turn" || !out) throw new Error(`Claude stopped: ${msg.stop_reason}`);
    const ids = new Set(batch.flatMap(([, eps]) => eps.map((e) => e.id)));
    tx(() => {
      for (const e of JSON.parse(out).episodes) if (ids.has(e.id)) { put.run(e.id, e.theme); found++; }
      for (const id of ids) mark.run(id);
    });
    batch = [];
    lines = 0;
  };
  for (const [show, eps] of byShow) {
    if (lines + eps.length > LINES_PER_CALL) await send();
    batch.push([show, eps]);
    lines += eps.length + 1;
  }
  await send();
  setMeta("episode_themes_updated", new Date().toISOString());
  log.info(`tag: episode themes: ${found} found in ${rows.length} episodes`);
  return found;
}
