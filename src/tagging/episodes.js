// Episode themes: holiday, musical, beach, time-loop... episodes. Claude reads episode
// titles show by show (its own knowledge does the rest: "Once More, with Feeling" is
// Buffy's musical), with TMDB's episode name when ours is just "Episode 5" and a short
// synopsis when one mentions something a theme is about (tagging/tmdb.js). Each episode is
// checked once per THEMES_VERSION. The flagged episodes become automatic buckets
// (buckets.js); holiday ones also stay out of regular blocks off-season (fill.js).
import Anthropic from "@anthropic-ai/sdk";
import { config, secrets } from "../config.js";
import { getDb, tx, setMeta } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";

export const THEMES = {
  musical: "a musical episode: characters break into song as the plot (not just an episode with a band or a concert)",
  beach: "a beach, pool or water-park episode (swimsuits, summer vacation at the sea)",
  halloween: "a Halloween episode: centrally about Halloween (costumes, trick-or-treating, a haunted house, Treehouse of Horror-style specials)",
  thanksgiving: "a Thanksgiving episode: centrally about Thanksgiving dinner or the holiday",
  christmas: "a Christmas / winter-holiday episode: centrally about Christmas, Hanukkah or the holidays (Santa, gifts, a holiday party)",
  valentines: "a Valentine's Day episode: centrally about Valentine's Day",
  newyear: "a New Year's Eve episode: centrally about New Year's Eve / the countdown",
  timeloop: "a time-loop episode: a character relives the same stretch of time over and over (Groundhog Day style)",
  bodyswap: "a body-swap episode: characters switch bodies (or minds)",
  wedding: "a wedding episode: a main character's wedding is the centre of the episode",
  au: "an alternate-universe / \"what if\" episode: the same characters in a different reality, timeline or setting from the show's own premise (a dream, a hypothetical, a parallel timeline) - not a flashback, a clip show, or the show's own normal premise",
};
// Words that make an episode's synopsis worth showing Claude (everything else goes by title).
const CUE = /hallowe|trick.or.treat|costume|haunted|pumpkin|christmas|xmas|santa|hanukkah|holiday|mistletoe|thanksgiving|turkey|pilgrim|beach|pool|swim|seaside|water.?park|summer vacation|musical|sing|song|broadway|valentine|cupid|new year|countdown|time loop|same day|groundhog|relive|body swap|switch(?:es|ed)? bodies|swap bodies|wedding|marr(?:y|ies|iage)|bride|groom|alternate (?:universe|reality|timeline)|what if|parallel (?:universe|world|timeline)|imagin(?:e|es|ed|ary)|dream(?:s|ed)?|hypothetical/i;
// Themes checked version: bump when THEMES grows, so every episode is looked at again.
const THEMES_VERSION = 3;
const LINES_PER_CALL = 300;
const generic = (t) => !t || /^(episode|ep\.?|e)\s*\d+$/i.test(t.trim()) || /\.(mkv|mp4|avi)$/i.test(t);

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
Use what you know about each show and episode, plus the titles and the synopses given for some. Be strict: the theme has to be what the episode is centrally about, not a scene, a passing mention, or a loose association. A scene at a pool doesn't make it a "beach episode" unless the trip itself is the plot; a character's dream for one scene doesn't make it "au"; a fight at a wedding reception a season is building to doesn't make every episode near it a "wedding" episode. Only list an episode when the synopsis plainly confirms it, or you are genuinely confident from the title and your own knowledge of that specific episode - a vague guess is worse than leaving it out. Most episodes are none of these, and an empty list is a fine answer. If a synopsis clearly belongs to a different episode than the title, go by the title.`;

// One line per episode: its title (or TMDB's when ours is just "Episode 5"), and a short
// synopsis only when it mentions something a theme is about.
function line(e) {
  let tmdb = null;
  try { tmdb = e.tmdb_ep ? JSON.parse(e.tmdb_ep) : null; } catch { /* no TMDB info */ }
  const title = generic(e.title) && tmdb?.name ? tmdb.name : e.title;
  const also = tmdb?.name && !generic(tmdb.name) && tmdb.name !== title ? ` (aka "${tmdb.name}")` : "";
  const text = [e.summary, tmdb?.overview].find((s) => s && CUE.test(s));
  return `  ${e.id} S${e.season ?? "?"}E${e.episode ?? "?"} ${title ?? "?"}${also}${text ? ` - ${text.replace(/\s+/g, " ").slice(0, 220)}` : ""}`;
}

export async function tagEpisodeThemes({ redo = false } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT i.id, i.show_title, i.season, i.episode, i.title, i.summary, i.tmdb_ep FROM items i
    WHERE i.kind = 'episode' AND i.show_title IS NOT NULL AND ${schedulableSql("i")}
      ${redo ? "" : `AND COALESCE(i.themes_checked, 0) < ${THEMES_VERSION}`}
      AND (i.match = 'full' OR i.tmdb_ep IS NOT NULL OR (i.title IS NOT NULL AND i.title NOT LIKE 'Episode %'))
    ORDER BY i.show_title, i.season, i.episode`).all();
  if (!rows.length) return 0;
  const client = new Anthropic({ apiKey: secrets.anthropicKey });
  const byShow = [...Map.groupBy(rows, (r) => r.show_title)];
  const mark = db.prepare(`UPDATE items SET themes_checked = ${THEMES_VERSION} WHERE id = ?`);
  const put = db.prepare("INSERT OR IGNORE INTO item_themes (item_id, theme) VALUES (?, ?)");
  let found = 0, batch = [], lines = 0;
  const send = async () => {
    if (!batch.length) return;
    const text = batch.map(([show, eps]) => `${show}\n${eps.map(line).join("\n")}`).join("\n");
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
