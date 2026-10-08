import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, DATA_DIR } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { chooseTracks, fromPlexStreams, hdrFromPlexStreams } from "./tracks.js";
import { parseRelease } from "./release.js";
import { splitSeason } from "./dedupe.js";

export const SUBS_DIR = join(DATA_DIR, "subs");

// Among multiple versions of a file, prefer the biggest one that's at most 1080p:
// 4K would only cost CPU to shrink to 720p anyway.
function chooseMedia(item) {
  const media = item.Media || [];
  const ok = media.filter((m) => (m.height || 0) <= 1080).sort((a, b) => (b.height || 0) - (a.height || 0));
  return ok[0] || [...media].sort((a, b) => (a.height || 0) - (b.height || 0))[0];
}

const identified = (guid) => String(guid || "").startsWith("plex://");

// full: Plex knows exactly what this is. show: it knows the show but couldn't pin the
// episode (usually odd numbering), so no episode title/summary. none: raw filename.
function matchLevel(item, show) {
  if (item.type !== "episode") return identified(item.guid) ? "full" : "none";
  if (!identified(show?.guid ?? item.grandparentGuid)) return "none";
  return identified(item.guid) ? "full" : "show";
}

// A show name compared the way dedupe.js does: case, punctuation and a "(2026)" tag ignored.
const showKey = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\(\s*(?:19|20)\d{2}\s*\)\s*$/, "").replace(/[^\p{L}\p{N}]/gu, "");
// What follows a movie's year when the file is really an episode: "Show (2026) 05".
const EPISODE_TAIL = /^[)\]\s._-]*(?:e|ep|episode)?\s*\d{1,3}(?:v\d)?(?=[\s._\[(]|$)/i;

// Plex couldn't identify this file (a raw release name somewhere on his drives), so read it the
// way Real-Debrid and local files are read: from the file's path. Only when that's confident -
// anything ambiguous stays unidentified (and off the air) rather than guessed.
// known: showKey -> the exact show title Plex already uses, so "D Gray-man" joins "D.Gray-man".
export function identifyFromPath(row, file, known = new Map()) {
  const p = parseRelease(file || row.title);
  if (!p || p.match !== "full") return row;
  if (p.kind === "episode") {
    if (p.season === 1 && p.episode >= 1900 && p.episode <= 2099) return row; // "Movie - 2049", not episode 2049
    // "Fire Force Season 3" / "Show S2" is season N of a show Plex already has; otherwise line the
    // name up with Plex's spelling ("D Gray-man" -> "D.Gray-man").
    const { base, season: n } = splitSeason(p.show_title);
    const seasonOfKnown = n && known.has(showKey(base));
    const show = seasonOfKnown ? known.get(showKey(base)) : known.get(showKey(p.show_title)) ?? p.show_title;
    const season = seasonOfKnown && p.season === 1 ? n : p.season;
    return { ...row, kind: "episode", show_title: show, season, episode: p.episode, title: p.title, match: "full" };
  }
  if (row.kind !== "movie") return row; // Plex says episode, the name says movie: don't guess
  const name = (file || row.title).split("/").pop();
  if (EPISODE_TAIL.test(name.slice(name.lastIndexOf(String(p.year)) + 4))) return row;
  const title = p.title.replace(/^(?:\[[^\]]*\]\s*)+/, "").trim(); // "[AnimeRG] Ponyo" -> "Ponyo"
  return title ? { ...row, title, year: p.year, match: "full" } : row;
}

export function baseRow(item, section, show, known) {
  const media = chooseMedia(item);
  const isEpisode = item.type === "episode";
  const row = rowOf(item, section, show, media, isEpisode);
  return row.match === "none" ? identifyFromPath(row, media?.Part?.[0]?.file, known) : row;
}

function rowOf(item, section, show, media, isEpisode) {
  return {
    source_key: String(item.ratingKey),
    kind: isEpisode ? "episode" : "movie",
    library: section.title,
    show_title: isEpisode ? item.grandparentTitle : null,
    season: isEpisode ? item.parentIndex ?? null : null,
    episode: isEpisode ? item.index ?? null : null,
    title: item.title,
    year: item.year ?? show?.year ?? null,
    summary: item.summary || show?.summary || null,
    genres: JSON.stringify((item.Genre || show?.Genre || []).map((g) => g.tag)),
    duration_ms: media?.duration || item.duration || null,
    air_date: item.originallyAvailableAt || null,
    match: matchLevel(item, show),
    media_path: media?.Part?.length === 1 ? media.Part[0].key : null,
    video_height: media?.height || null,
    source_updated: item.updatedAt || 0,
  };
}

// sinceMs > 0: a quick sync, only what Plex has added since then.
export async function syncPlex(plex, { sinceMs = 0 } = {}) {
  const quick = sinceMs > 0;
  const db = getDb();
  const wanted = new Set(config.plex.libraries);
  const sections = (await plex.sections()).filter((s) => !wanted.size || wanted.has(s.title));
  const missing = [...wanted].filter((t) => !sections.some((s) => s.title === t));
  if (missing.length) log.warn(`plex: libraries not found on server: ${missing.join(", ")}`);

  const upsert = db.prepare(`
    INSERT INTO items (source, source_key, kind, library, show_title, season, episode, title, year, summary,
                       genres, duration_ms, air_date, match, media_path, video_height, source_updated, present)
    VALUES ('plex', :source_key, :kind, :library, :show_title, :season, :episode, :title, :year, :summary,
            :genres, :duration_ms, :air_date, :match, :media_path, :video_height, :source_updated, 1)
    ON CONFLICT (source, source_key) DO UPDATE SET
      kind = excluded.kind, library = excluded.library, show_title = excluded.show_title,
      season = excluded.season, episode = excluded.episode, title = excluded.title, year = excluded.year,
      summary = excluded.summary, genres = excluded.genres, duration_ms = excluded.duration_ms,
      air_date = excluded.air_date, match = excluded.match, media_path = excluded.media_path,
      video_height = excluded.video_height, source_updated = excluded.source_updated, present = 1`);

  // Show-level facts for tagging. Tag columns are never touched here.
  const upsertShow = db.prepare(`INSERT INTO shows (title, summary, year, genres) VALUES (?, ?, ?, ?)
    ON CONFLICT (title) DO UPDATE SET summary = excluded.summary, year = excluded.year, genres = excluded.genres`);

  // The show titles Plex itself identified, for lining up files it didn't (see identifyFromPath).
  const known = new Map();
  for (const r of db.prepare(`SELECT DISTINCT show_title t FROM items WHERE source = 'plex' AND kind = 'episode'
    AND match IN ('full', 'show') AND show_title IS NOT NULL`).all()) known.set(showKey(r.t), r.t);

  const seen = new Set();
  for (const section of sections) {
    const t0 = Date.now();
    let items;
    let shows = new Map();
    const list = (type) => (quick ? plex.listRecent(section.key, type, Math.floor(sinceMs / 1000)) : plex.listAll(section.key, type));
    if (section.type === "show") {
      shows = new Map((await plex.listAll(section.key, 2)).map((s) => [String(s.ratingKey), s])); // shows are few; always all of them
      items = await list(4);
    } else if (section.type === "movie") {
      items = await list(1);
    } else {
      log.warn(`plex: skipping library "${section.title}" (type ${section.type})`);
      continue;
    }
    tx(() => {
      for (const s of shows.values()) {
        upsertShow.run(s.title, s.summary || null, s.year ?? null, JSON.stringify((s.Genre || []).map((g) => g.tag)));
      }
      for (const it of items) {
        const row = baseRow(it, section, shows.get(String(it.grandparentRatingKey)), known);
        upsert.run(row);
        seen.add(row.source_key);
      }
    });
    log.info(`plex: ${section.title}: ${items.length} items listed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Anything from these libraries that wasn't listed has been removed from Plex (only known
  // after a full listing; a quick sync lists just what was added lately).
  const libs = sections.map((s) => s.title);
  const gone = quick ? 0 : tx((d) => {
    const rows = d.prepare(`SELECT id, source_key FROM items WHERE source = 'plex' AND present = 1 AND library IN (${libs.map(() => "?").join(",")})`).all(...libs);
    const mark = d.prepare("UPDATE items SET present = 0 WHERE id = ?");
    let n = 0;
    for (const r of rows) if (!seen.has(r.source_key)) { mark.run(r.id); n++; }
    return n;
  });
  if (gone) log.info(`plex: ${gone} items no longer on the server (kept in history, not schedulable)`);

  await refreshTracks(plex);
  await refreshCredits(plex);
}

// Where Plex says the end credits start (ms), or -1 if it has no credits marker for the item.
const creditsStartOf = (m) => (m.Marker || []).filter((x) => x.type === "credits").map((x) => x.startTimeOffset)[0] ?? -1;

// Credits markers for Plex items that predate credits_start (refreshTracks covers new and changed ones).
async function refreshCredits(plex) {
  const db = getDb();
  const todo = db.prepare("SELECT id, source_key FROM items WHERE source = 'plex' AND present = 1 AND credits_start IS NULL").all();
  if (!todo.length) return;
  log.info(`plex: reading credits markers for ${todo.length} items`);
  const save = db.prepare("UPDATE items SET credits_start = ? WHERE id = ?");
  const byKey = new Map(todo.map((r) => [r.source_key, r.id]));
  for (let i = 0; i < todo.length; i += 100) {
    const meta = await plex.metadataBatch(todo.slice(i, i + 100).map((r) => r.source_key));
    tx(() => { for (const m of meta) { const id = byKey.get(String(m.ratingKey)); if (id) save.run(creditsStartOf(m), id); } });
  }
}

// Read audio/subtitle tracks for items that are new or changed since we last looked.
async function refreshTracks(plex) {
  const db = getDb();
  const todo = db.prepare(`
    SELECT id, source_key, show_title, media_path, source_updated FROM items
    WHERE source = 'plex' AND present = 1 AND (streams_checked IS NULL OR streams_checked != source_updated)`).all();
  if (!todo.length) return;
  log.info(`plex: reading audio/subtitle tracks for ${todo.length} new or changed items`);
  const save = db.prepare(`UPDATE items SET audio_stream = ?, audio_lang = ?, subs = ?, playable = ?,
                           unplayable_reason = ?, streams_checked = ?, cues = ?, hdr = ?, credits_start = ? WHERE id = ?`);
  const byKey = new Map(todo.map((r) => [r.source_key, r]));
  const batches = [];
  for (let i = 0; i < todo.length; i += 100) batches.push(todo.slice(i, i + 100));

  let done = 0;
  const worker = async () => {
    for (let b; (b = batches.shift()); ) {
      const meta = await plex.metadataBatch(b.map((r) => r.source_key));
      tx(() => {
        for (const m of meta) {
          const row = byKey.get(String(m.ratingKey));
          if (!row) continue;
          const media = (m.Media || []).find((x) => x.Part?.some((p) => p.key === row.media_path));
          const streams = media?.Part?.[0]?.Stream;
          const t = row.media_path
            ? chooseTracks(fromPlexStreams(streams), { showTitle: row.show_title })
            : { playable: false, reason: "file is split into multiple parts" };
          const cues = (m.Chapter || []).map((c) => c.startTimeOffset).filter((ms) => ms > 0);
          save.run(t.audioStream ?? null, t.audioLang ?? null, JSON.stringify(t.subs || { mode: "none" }),
            t.playable ? 1 : 0, t.reason || null, row.source_updated, cues.length ? JSON.stringify(cues) : null,
            row.media_path ? hdrFromPlexStreams(streams) : null, creditsStartOf(m), row.id);
        }
      });
      done += b.length;
      if (done % 2000 < 100) log.info(`plex: tracks ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  await fetchSidecarSubs(plex);
}

// Separate .srt/.ass files that sit next to a video on his server: tiny, so keep a
// local copy of every one we need.
async function fetchSidecarSubs(plex) {
  mkdirSync(SUBS_DIR, { recursive: true });
  const rows = getDb().prepare(`SELECT id, subs FROM items WHERE source = 'plex' AND present = 1 AND subs LIKE '%"sidecar"%'`).all();
  let fetched = 0;
  for (const r of rows) {
    const s = JSON.parse(r.subs);
    const file = join(SUBS_DIR, `${r.id}.${s.codec === "ass" || s.codec === "ssa" ? "ass" : "srt"}`);
    if (existsSync(file)) continue;
    try {
      const res = await fetch(`${plex.base}/library/streams/${s.id}`, { headers: plex.headers(), signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      fetched++;
    } catch (e) {
      log.warn(`plex: couldn't download subtitles for item ${r.id}: ${e.message}`);
      getDb().prepare("UPDATE items SET playable = 0, unplayable_reason = ? WHERE id = ?")
        .run(`subtitle file download failed (${e.message})`, r.id);
    }
  }
  if (fetched) log.info(`plex: downloaded ${fetched} subtitle files`);
}
