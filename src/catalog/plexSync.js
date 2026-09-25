import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, DATA_DIR } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { chooseTracks, fromPlexStreams } from "./tracks.js";

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

function baseRow(item, section, show) {
  const media = chooseMedia(item);
  const isEpisode = item.type === "episode";
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

export async function syncPlex(plex) {
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

  const seen = new Set();
  for (const section of sections) {
    const t0 = Date.now();
    let items;
    let shows = new Map();
    if (section.type === "show") {
      shows = new Map((await plex.listAll(section.key, 2)).map((s) => [String(s.ratingKey), s]));
      items = await plex.listAll(section.key, 4);
    } else if (section.type === "movie") {
      items = await plex.listAll(section.key, 1);
    } else {
      log.warn(`plex: skipping library "${section.title}" (type ${section.type})`);
      continue;
    }
    tx(() => {
      for (const s of shows.values()) {
        upsertShow.run(s.title, s.summary || null, s.year ?? null, JSON.stringify((s.Genre || []).map((g) => g.tag)));
      }
      for (const it of items) {
        const row = baseRow(it, section, shows.get(String(it.grandparentRatingKey)));
        upsert.run(row);
        seen.add(row.source_key);
      }
    });
    log.info(`plex: ${section.title}: ${items.length} items listed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Anything from these libraries that wasn't listed has been removed from Plex.
  const libs = sections.map((s) => s.title);
  const gone = tx((d) => {
    const rows = d.prepare(`SELECT id, source_key FROM items WHERE source = 'plex' AND present = 1 AND library IN (${libs.map(() => "?").join(",")})`).all(...libs);
    const mark = d.prepare("UPDATE items SET present = 0 WHERE id = ?");
    let n = 0;
    for (const r of rows) if (!seen.has(r.source_key)) { mark.run(r.id); n++; }
    return n;
  });
  if (gone) log.info(`plex: ${gone} items no longer on the server (kept in history, not schedulable)`);

  await refreshTracks(plex);
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
                           unplayable_reason = ?, streams_checked = ?, cues = ? WHERE id = ?`);
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
          const t = row.media_path
            ? chooseTracks(fromPlexStreams(media?.Part?.[0]?.Stream), { showTitle: row.show_title })
            : { playable: false, reason: "file is split into multiple parts" };
          const cues = (m.Chapter || []).map((c) => c.startTimeOffset).filter((ms) => ms > 0);
          save.run(t.audioStream ?? null, t.audioLang ?? null, JSON.stringify(t.subs || { mode: "none" }),
            t.playable ? 1 : 0, t.reason || null, row.source_updated, cues.length ? JSON.stringify(cues) : null, row.id);
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
