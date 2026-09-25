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
