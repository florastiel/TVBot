// TMDB (themoviedb.org; free API key, TMDB_API_KEY in .env) knows each show's and movie's
// genres and keywords ("based on video game", "heist", "time travel", "christmas"...), for
// the programming pass (tv.mjs review). Only names that clearly match are taken: a show or
// movie TMDB can't pin down is left untagged rather than tagged as something else.
import { setTimeout as sleep } from "node:timers/promises";
import { secrets } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";

const API = "https://api.themoviedb.org/3";
const GAP_MS = 250; // TMDB allows ~50 requests a second; stay far below
const norm = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");

// "DK3 The Dark Knight Rises", "[Judas] JoJo", "Next to Normal (2025) (1080p AMZN...)",
// "The Jinx ... (2015)" -> the name to search for, plus a year found in it.
function clean(title) {
  let t = String(title ?? "").replace(/^\[[^\]]*\]\s*/, "").replace(/^[A-Z]{1,3}\d{1,2}\s+/, "").replace(/[\s-]+(?:4K|UHD)$/i, "");
  const year = t.match(/\((19|20)\d{2}\)/)?.[0].slice(1, 5);
  t = t.replace(/\s*\((?:(?:19|20)\d{2}|US|UK)\).*$/i, "").replace(/\s*\(\d{3,4}p.*$/i, "").trim();
  return { q: t, year: year ? Number(year) : null };
}

async function get(path, params = {}) {
  const qs = new URLSearchParams({ api_key: secrets.tmdbKey, ...params });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await sleep(GAP_MS);
    const res = await fetch(`${API}${path}?${qs}`, { signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await sleep(5000 * attempt); continue; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
    return res.json();
  }
  throw new Error("TMDB kept saying too many requests");
}

// The search result that really is this title: same name (or original name), year within
// one when both are known; else a name that starts with ours or ours with it (8+ letters).
function pick(results, q, year, kind) {
  const want = norm(q);
  if (!want) return null;
  const yearOf = (r) => Number((kind === "tv" ? r.first_air_date : r.release_date)?.slice(0, 4)) || null;
  const names = (r) => [r.name, r.original_name, r.title, r.original_title].map(norm).filter(Boolean);
  const yearOk = (r) => !year || !yearOf(r) || Math.abs(yearOf(r) - year) <= 1;
  return results.find((r) => names(r).includes(want) && yearOk(r))
    ?? results.find((r) => yearOk(r) && names(r).some((n) => n.length >= 8 && want.length >= 8 && (n.startsWith(want) || want.startsWith(n))))
    ?? null;
}

async function lookup(kind, title, year) {
  const { q, year: inTitle } = clean(title);
  const y = year ?? inTitle;
  const search = kind === "tv" ? "/search/tv" : "/search/movie";
  const yearParam = kind === "tv" ? "first_air_date_year" : "year";
  let hit = null;
  if (y) hit = pick((await get(search, { query: q, [yearParam]: y }))?.results || [], q, y, kind);
  if (!hit) hit = pick((await get(search, { query: q }))?.results || [], q, y, kind);
  if (!hit) return null;
  const d = await get(`/${kind}/${hit.id}`, { append_to_response: "keywords" });
  if (!d) return null;
  const keywords = (kind === "tv" ? d.keywords?.results : d.keywords?.keywords) || [];
  return { id: hit.id, tags: { genres: (d.genres || []).map((g) => g.name), keywords: keywords.map((k) => k.name) } };
}

// Shows and movies not looked up yet (all of them with redo). Returns how many were tagged.
export async function fetchTmdb({ redo = false } = {}) {
  if (!secrets.tmdbKey) { log.info("tmdb: no TMDB_API_KEY in .env; skipping"); return 0; }
  const db = getDb();
  const S = schedulableSql("i");
  const shows = db.prepare(`SELECT s.title, s.year FROM shows s WHERE ${redo ? "1" : "s.tmdb_checked_at IS NULL"}
    AND EXISTS (SELECT 1 FROM items i WHERE i.show_title = s.title AND i.kind = 'episode' AND ${S}) ORDER BY s.title`).all();
  const movies = db.prepare(`SELECT i.id, i.title, i.year FROM items i WHERE i.kind = 'movie' AND ${S} ${redo ? "" : "AND i.tmdb_checked_at IS NULL"} ORDER BY i.title`).all();
  if (!shows.length && !movies.length) { await fetchEpisodeInfo({ redo }); return 0; }
  log.info(`tmdb: looking up ${shows.length} shows and ${movies.length} movies`);
  const now = () => new Date().toISOString();
  const saveShow = db.prepare("UPDATE shows SET tmdb_id = ?, tmdb_tags = ?, tmdb_checked_at = ? WHERE title = ?");
  const saveMovie = db.prepare("UPDATE items SET tmdb_id = ?, tmdb_tags = ?, tmdb_checked_at = ? WHERE id = ?");
  let tagged = 0, missed = 0;
  for (const s of shows) {
    try {
      const r = await lookup("tv", s.title, s.year);
      saveShow.run(r?.id ?? null, r ? JSON.stringify(r.tags) : null, now(), s.title);
      if (r) tagged++; else missed++;
    } catch (e) { log.warn(`tmdb: ${s.title}: ${e.message}`); } // tried again next time
  }
  for (const m of movies) {
    try {
      const r = await lookup("movie", m.title, m.year);
      saveMovie.run(r?.id ?? null, r ? JSON.stringify(r.tags) : null, now(), m.id);
      if (r) tagged++; else missed++;
    } catch (e) { log.warn(`tmdb: ${m.title}: ${e.message}`); }
  }
  log.info(`tmdb: ${tagged} tagged, ${missed} not matched`);
  await fetchEpisodeInfo({ redo });
  return tagged;
}

// Every episode's TMDB name and synopsis, one request per season of each matched show
// (shows not read yet; all with redo), matched by season + episode number. Anime numbered
// differently from TMDB just gets nothing (or a wrong synopsis the theme pass is told to
// distrust when it disagrees with the title).
export async function fetchEpisodeInfo({ redo = false } = {}) {
  if (!secrets.tmdbKey) return 0;
  const db = getDb();
  const S = schedulableSql("i");
  const shows = db.prepare(`SELECT s.title, s.tmdb_id FROM shows s WHERE s.tmdb_id IS NOT NULL ${redo ? "" : "AND s.tmdb_eps_at IS NULL"}
    AND EXISTS (SELECT 1 FROM items i WHERE i.show_title = s.title AND i.kind = 'episode' AND ${S}) ORDER BY s.title`).all();
  if (!shows.length) return 0;
  const seasons = db.prepare(`SELECT DISTINCT i.season FROM items i WHERE i.show_title = ? AND i.kind = 'episode' AND i.season IS NOT NULL AND ${S}`);
  const save = db.prepare("UPDATE items SET tmdb_ep = ? WHERE show_title = ? AND kind = 'episode' AND season = ? AND episode = ?");
  const done = db.prepare("UPDATE shows SET tmdb_eps_at = ? WHERE title = ?");
  log.info(`tmdb: reading episode names/synopses for ${shows.length} shows`);
  let n = 0;
  for (const s of shows) {
    try {
      for (const { season } of seasons.all(s.title)) {
        const d = await get(`/tv/${s.tmdb_id}/season/${season}`);
        for (const e of d?.episodes || []) {
          if (!e.name && !e.overview) continue;
          n += Number(save.run(JSON.stringify({ name: e.name || null, overview: e.overview || null }), s.title, season, e.episode_number).changes);
        }
      }
      done.run(new Date().toISOString(), s.title);
    } catch (e) { log.warn(`tmdb: ${s.title} episodes: ${e.message}`); } // tried again next time
  }
  log.info(`tmdb: names/synopses for ${n} episodes`);
  return n;
}

// "based on video game, heist, time travel" (first keywords) for a tmdb_tags value, or "".
export function tmdbSummary(json, max = 8) {
  try { return (JSON.parse(json || "{}").keywords || []).slice(0, max).join(", "); } catch { return ""; }
}
