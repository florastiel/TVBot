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
  catalog: { sync_days: 1 },   // how often the bot syncs Plex/local/Real-Debrid and re-tags by itself
  discord: { guild_id: "", now_playing_channel_id: "", admin_user_id: "", daily_guide: true, guide_channel_id: "", drop_thread_id: "", clip_thread_id: "", eyecatch_thread_id: "", shorts_thread_id: "" },
  broadcast: {
    timezone: "America/New_York",
    grid_minutes: 5,
    between_spots: 2,
    short_spot_seconds: 35,
    inside_spots: 1,
    episode_breaks: 1,
    eyecatches: "tv",
    variety_folders: [],
    ad_families: {},
    ad_family_weight: 2,
    standing_slots: [],
    break_every_minutes: 8,
    max_spot_minutes: 3,
    max_show_block_minutes: 75,
    split_without_chapters: true,
    piece_minutes: 12,
    ad_minutes_per_hour: 12,
    brand_share: 0.25,
    clip_chance: 0.3,
    no_repeat_days: 14,
    plan_days: 1,
    plan_buffer_days: 7,
    grid_weeks_ahead: 2,
    specials_per_week: 0,
    idle_leave_minutes: 5,
    no_premiere_hours: ["02:30", "07:00"],
  },
  weather: { enabled: true, times: [], window_hours: 3, rate: 0, locations: [], voices: [] },
  plex: { server_name: "", libraries: [], include_unmatched: false, include_show_only_matches: true },
  shows: { random: [], in_order: [], never: [], aliases: {}, rename: {}, prefer_source: {} },
  buckets: { shuffle: [], in_order: [] },
  language: { audio: "eng", subtitles: "eng", always_subtitles: true, hardsubbed_shows: [] },
  local: { shows: "", movies: "", clips: "", commercials: "", shorts: "", eyecatches: "", library: [] },
  realdebrid: { enabled: true, min_file_mb: 50, skip_torrents: [] },
  encode: { height: 720, frame_rate: 30, bitrate_kbps: 2500, max_bitrate_kbps: 4000, encoder: "software", hw_decode: false },
  entrance: { max_seconds: 8, loudness_lufs: -32 },
  player: { port: 7651, spool_max_gb: 30, spool_max_mbps: 20, spool_max_file_gb: 8, stream_preview_minutes: 5 },
  claude: { model: "claude-sonnet-5", scheduling: "api" },
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
  rdToken: process.env.RD_TOKEN,
  tmdbKey: process.env.TMDB_API_KEY,
};
