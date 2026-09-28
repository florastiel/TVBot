import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

// Each entry upgrades the schema by one version; never edit an old one, append.
const MIGRATIONS = [
  `
  CREATE TABLE items (
    id               INTEGER PRIMARY KEY,
    source           TEXT NOT NULL,      -- plex | local
    source_key       TEXT NOT NULL,      -- plex ratingKey, or absolute file path
    kind             TEXT NOT NULL,      -- episode | movie | commercial | clip
    library          TEXT,
    show_title       TEXT,
    season           INTEGER,
    episode          INTEGER,
    title            TEXT NOT NULL,
    year             INTEGER,
    summary          TEXT,
    genres           TEXT,               -- JSON array
    duration_ms      INTEGER,
    air_date         TEXT,               -- YYYY-MM-DD
    match            TEXT NOT NULL,      -- full | show (show known, episode not) | none (raw filename)
    media_path       TEXT,               -- Plex part key (/library/parts/...); null for local
    video_height     INTEGER,
    audio_stream     INTEGER,            -- absolute ffmpeg stream index to play (0:N)
    audio_lang       TEXT,
    subs             TEXT,               -- JSON: {mode: none|image|sidecar|embedded_text, ...}
    playable         INTEGER NOT NULL DEFAULT 0,
    unplayable_reason TEXT,
    excluded         INTEGER NOT NULL DEFAULT 0,  -- manual veto
    present          INTEGER NOT NULL DEFAULT 1,  -- seen in the latest sync
    source_updated   INTEGER,            -- Plex updatedAt, or local file mtime+size
    streams_checked  INTEGER,            -- source_updated value when tracks were last read
    UNIQUE (source, source_key)
  );
  CREATE INDEX items_show ON items (show_title, season, episode);

  CREATE TABLE tags (
    item_id   INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    holiday   TEXT,        -- halloween | thanksgiving | christmas | none
    mood      TEXT,
    decade    INTEGER,     -- 1990 for "90s"
    kids      INTEGER,
    animated  INTEGER,
    notes     TEXT,
    source    TEXT NOT NULL,   -- ai | csv
    tagged_at TEXT NOT NULL
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `,
  `
  -- Show-level facts and tags (mood, audience... are per show, not per episode).
  CREATE TABLE shows (
    title      TEXT PRIMARY KEY,
    summary    TEXT,
    year       INTEGER,
    genres     TEXT,               -- JSON array
    vibes      TEXT,               -- JSON array, e.g. ["goofy","cozy"]
    audience   TEXT,               -- kids | family | teen | adult
    kids       INTEGER,
    animated   INTEGER,
    anime      INTEGER,
    origin     TEXT,               -- us | uk | canada | japan | korea | other
    decade     INTEGER,
    holiday    TEXT,               -- the whole show is a holiday special
    tag_source TEXT,
    tagged_at  TEXT
  );
  ALTER TABLE tags ADD COLUMN audience TEXT;
  ALTER TABLE tags ADD COLUMN anime INTEGER;
  ALTER TABLE tags ADD COLUMN origin TEXT;
  `,
  `
  -- The schedule. Kept forever as history: the no-repeat rule reads past blocks.
  CREATE TABLE blocks (
    id         INTEGER PRIMARY KEY,
    start_at   INTEGER NOT NULL,   -- unix ms
    end_at     INTEGER NOT NULL,
    label      TEXT NOT NULL,      -- a couple of plain words, e.g. "Sitcoms"
    theme      TEXT,               -- halloween | thanksgiving | christmas | null
    source     TEXT NOT NULL,      -- claude | fallback
    created_at TEXT NOT NULL
  );
  CREATE INDEX blocks_start ON blocks (start_at);
  CREATE TABLE block_items (
    block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    item_id  INTEGER NOT NULL REFERENCES items(id),
    PRIMARY KEY (block_id, position)
  );
  `,
  `
  -- Chapter start times (ms, JSON array): natural spots for commercial breaks inside
  -- a show or movie. Clearing streams_checked makes the next sync read them for everything.
  ALTER TABLE items ADD COLUMN cues TEXT;
  UPDATE items SET streams_checked = NULL;
  `,
  `
  -- Buckets: kinds of programming blocks ("Saturday Morning Cartoons", "Westerns").
  -- Claude sorts the catalog into them (many-to-many) and plans the week as a grid of
  -- bucket slots; code fills each slot with random picks from its bucket.
  CREATE TABLE buckets (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,       -- the block label viewers see
    about       TEXT,                -- what belongs in it
    format      TEXT NOT NULL,       -- one_show | variety | movie | movie_series
    dayparts    TEXT NOT NULL,       -- JSON array of morning | afternoon | evening | late
    active_from TEXT,                -- MM-DD, for seasonal buckets (null = all year)
    active_to   TEXT,
    source      TEXT NOT NULL,       -- claude | auto (holiday tags) | fallback
    retired     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE bucket_members (
    bucket_id  INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    show_title TEXT,                 -- a whole show...
    item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE, -- ...or one movie or episode
    position   INTEGER NOT NULL DEFAULT 0  -- order, for movie series
  );
  CREATE INDEX bucket_members_bucket ON bucket_members (bucket_id);
  -- The week's grid: from start_at until the next slot, blocks come from this bucket.
  CREATE TABLE plan_slots (
    start_at   INTEGER PRIMARY KEY,
    bucket_id  INTEGER NOT NULL REFERENCES buckets(id),
    created_at TEXT NOT NULL
  );
  ALTER TABLE blocks ADD COLUMN bucket_id INTEGER;
  `,
  `
  -- Original commercial-break points (black + silence), in ms (JSON array; [] = none
  -- found, NULL = not checked yet), and which version of the file was checked.
  ALTER TABLE items ADD COLUMN ad_cues TEXT;
  ALTER TABLE items ADD COLUMN ad_cues_checked INTEGER;
  `,
  `
  -- 1 = serialized (air in order), 0 = episodic (any order); NULL = not decided yet.
  ALTER TABLE shows ADD COLUMN serialized INTEGER;
  `,
  `
  -- Special episodes (musical, beach, ...), found from episode titles.
  CREATE TABLE item_themes (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    theme   TEXT NOT NULL,
    PRIMARY KEY (item_id, theme)
  );
  ALTER TABLE items ADD COLUMN themes_checked INTEGER;
  `,
  `
  -- Real-Debrid torrents already read (their file list never changes once downloaded),
  -- so a sync only asks Real-Debrid about new ones. items.source = 'realdebrid',
  -- source_key = '<torrent id>:<file id>', media_path = the real-debrid.com/d/... link.
  CREATE TABLE rd_torrents (
    id       TEXT PRIMARY KEY,
    filename TEXT,
    read_at  TEXT NOT NULL
  );
  `,
  `
  -- Another copy of the same episode/movie is used instead (catalog/dedupe.js).
  ALTER TABLE items ADD COLUMN duplicate_of INTEGER;
  `,
  `
  -- Would it have aired with network-TV-style breaks (eyecatches)? tagging/breaks.js.
  ALTER TABLE shows ADD COLUMN tv_breaks INTEGER;
  ALTER TABLE items ADD COLUMN tv_breaks INTEGER;
  `,
  `
  -- An episode far shorter than the rest of its show (a clip or promo listed as an episode),
  -- left out of the schedule; recomputed at every sync (catalog/dedupe.js).
  ALTER TABLE items ADD COLUMN oddball INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Short shows (anime shorts and the like), found through AniList (tagging/anilist.js).
  ALTER TABLE shows ADD COLUMN short INTEGER;
  ALTER TABLE shows ADD COLUMN anilist_id INTEGER;
  ALTER TABLE shows ADD COLUMN anilist_format TEXT;
  ALTER TABLE shows ADD COLUMN anilist_checked_at TEXT;
  `,
  `
  -- The change log (changelog.js): when a Real-Debrid torrent was added to the account (its
  -- own date), and when the catalog first saw any other item.
  ALTER TABLE rd_torrents ADD COLUMN added_at TEXT;
  ALTER TABLE items ADD COLUMN added_at INTEGER;
  CREATE TRIGGER items_added AFTER INSERT ON items
  BEGIN
    UPDATE items SET added_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE id = NEW.id;
  END;
  `,
  `
  -- AniList's genres and tags for an anime show (tagging/anilist.js), JSON
  -- {"genres": [...], "tags": [[name, rank], ...]}: demographic (Shounen, Seinen...) and
  -- themes (Isekai, Iyashikei, Mecha...), for the programming pass.
  ALTER TABLE shows ADD COLUMN anilist_tags TEXT;
  `,
  `
  -- TMDB's genres and keywords (tagging/tmdb.js), JSON {"genres": [...], "keywords": [...]}:
  -- "based on video game", "heist", "time travel"... for shows and movies.
  ALTER TABLE shows ADD COLUMN tmdb_id INTEGER;
  ALTER TABLE shows ADD COLUMN tmdb_tags TEXT;
  ALTER TABLE shows ADD COLUMN tmdb_checked_at TEXT;
  ALTER TABLE items ADD COLUMN tmdb_id INTEGER;
  ALTER TABLE items ADD COLUMN tmdb_tags TEXT;
  ALTER TABLE items ADD COLUMN tmdb_checked_at TEXT;
  `,
  `
  -- TMDB's name and synopsis for an episode, JSON {"name", "overview"}, by show + season +
  -- episode number (tagging/tmdb.js); shows.tmdb_eps_at: when its seasons were last read.
  ALTER TABLE items ADD COLUMN tmdb_ep TEXT;
  ALTER TABLE shows ADD COLUMN tmdb_eps_at TEXT;
  `,
  `
  -- Whether the file is HDR (PQ/HLG transfer characteristics): player/encode.js needs to
  -- know to tone-map it down to SDR, or it plays back washed out. Clearing streams_checked
  -- makes the next sync read it for everything already in the catalog.
  ALTER TABLE items ADD COLUMN hdr INTEGER;
  UPDATE items SET streams_checked = NULL;
  `,
  `
  -- How often a commercial/clip/eyecatch has actually aired, and when last: player/segments.js
  -- picks the least-played of a group instead of a random one, so a big folder's rarely-seen
  -- files (and everything else) actually get a turn - persisted so a player restart doesn't
  -- forget. tv.cmd spots reads these.
  ALTER TABLE items ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN last_played_at INTEGER;
  `,
];

let db;
export function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(join(DATA_DIR, "tv.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const { user_version: v } = db.prepare("PRAGMA user_version").get();
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec("COMMIT");
  }
  return db;
}

export function tx(fn) {
  const d = getDb();
  d.exec("BEGIN");
  try {
    const r = fn(d);
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function setMeta(key, value) {
  getDb().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}
export function getMeta(key) {
  return getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
}
