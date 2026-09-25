import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import YAML from "yaml";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// TV_CONFIG / TV_DATA let tests run against a scratch config and database.
export const DATA_DIR = process.env.TV_DATA || join(ROOT, "data");
export const ENTRANCE_DIR = join(DATA_DIR, "entrances");

const DEFAULTS = {
  discord: { guild_id: "", now_playing_channel_id: "", admin_user_id: "" },
  broadcast: {
    timezone: "America/New_York",
    hours: "00:00-24:00",
    grid_minutes: 15,
    min_ad_minutes_per_hour: 2,
    max_show_block_minutes: 75,
    max_break_minutes: 5,
    split_without_chapters: true,
    max_ad_minutes_per_hour: 9,
    clip_chance: 0.3,
    no_repeat_days: 14,
    plan_days: 1,
    specials_per_week: 1,
    idle_leave_minutes: 5,
  },
  plex: { server_name: "", libraries: [], include_unmatched: false, include_show_only_matches: true },
  shows: { in_order: [], never: [] },
  language: { audio: "eng", subtitles: "eng", hardsubbed_shows: [] },
  local: { shows: "", movies: "", clips: "", commercials: "" },
  encode: { height: 720, frame_rate: 30, bitrate_kbps: 2500, max_bitrate_kbps: 4000, encoder: "software" },
  entrance: { max_seconds: 8, loudness_lufs: -32 },
  player: { port: 7651 },
  claude: { model: "claude-sonnet-5" },
};

function merge(base, over) {
  if (over === null || over === undefined) return base;
  if (typeof base !== "object" || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

const file = process.env.TV_CONFIG || join(ROOT, "config.yaml");
export const config = merge(DEFAULTS, existsSync(file) ? YAML.parse(readFileSync(file, "utf8")) : {});

export const secrets = {
  streamerToken: process.env.STREAMER_TOKEN,
  botToken: process.env.BOT_TOKEN,
  plexToken: process.env.PLEX_TOKEN,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
};
