// The same episode or movie can come in more than once: Plex, a local folder, and several
// Real-Debrid torrents (a season pack plus single episodes, two releases of one show).
// After every sync:
//  1. Show names from local folders and Real-Debrid are lined up with Plex's (and each
//     other's): shows.aliases in config.yaml first, then the same name ignoring case and
//     punctuation, then ignoring a "(2005)" / "(US)" tag. "Show 2nd Season" / "Show S2"
//     become season 2 of "Show".
//  2. One copy of each episode (show + season + episode) and movie (title + year) is kept;
//     the others get items.duplicate_of = the kept one, and are left out of the schedule
//     and never read over the network.
//  3. Local commercials/clips/shorts: the same file in several formats (archive.org
//     downloads come as .mpg plus .mp4/.ogv copies) counts once; the biggest file, usually
//     the original, is kept.
import { statSync } from "node:fs";
import { dirname, basename, extname } from "node:path";
import { config } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";

const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// shows.prefer_source in config.yaml: a show whose episodes should come from one source
// only (plex | local | realdebrid): its other sources' copies are left out entirely,
// even for episodes the preferred one lacks (e.g. Plex's copy is broken).
const preferred = (show) => {
  const m = config.shows?.prefer_source || {};
  const key = Object.keys(m).find((k) => norm(k) === norm(show));
  return key ? String(m[key]).toLowerCase() : null;
};
const wrongSource = (r) => r.kind === "episode" && r.show_title && (preferred(r.show_title) ?? r.source) !== r.source;
const TAG = /\s*\((?:(?:19|20)\d{2}|US|UK|AU|NZ|CA)\)\s*$/i;
const loose = (s) => norm(String(s ?? "").replace(TAG, ""));
// Movie titles as packs name them: "DK3 The Dark Knight Rises", "X01 X Men", "No Way Home 4K".
const PACK_PREFIX = /^[A-Z]{1,3}\d{1,2}\s+/;
const movieKey = (t) => norm(String(t ?? "").replace(PACK_PREFIX, "").replace(/[\s-]+(?:4K|UHD)$/i, "").replace(TAG, ""));
// What makes two catalog rows the same movie/episode whatever their ids (null: can't tell).
export function titleKey(r) {
  if (r.kind === "movie") return r.year ? `m|${movieKey(r.title)}|${r.year}` : null;
  if (r.kind === "episode") return r.show_title && r.season != null && r.episode != null ? `e|${norm(r.show_title)}|${r.season}|${r.episode}` : null;
  return null;
}
const ORDINAL = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
// "Haikyuu!! S2", "Bungou Stray Dogs 2nd Season", "Haikyuu!! Second Season", "Show Season 3"
const SEASON_IN_NAME = /[\s._-]+(?:S(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)[\s._-]*Season|(Second|Third|Fourth|Fifth|Sixth)[\s._-]*Season|Season[\s._-]*(\d{1,2}))$/i;

function splitSeason(title) {
  const m = title.match(SEASON_IN_NAME);
  if (!m) return { base: title, season: null };
  const season = Number(m[1] ?? m[2] ?? m[4]) || ORDINAL[m[3]?.toLowerCase()];
  return { base: title.slice(0, m.index).trim(), season };
}

// shows.rename in config.yaml: a show whose files are really another show (Plex has the
// Mr. Bean episodes filed as "Zero-one"). Unlike aliases this covers Plex too, and runs
// after every sync, which brings Plex's wrong name back each time. The old show's row and
// bucket memberships go; the new name is tagged and bucketed as a new show.
// Returns how many names changed.
function renameShows(db) {
  let changed = 0;
  for (const [from, to] of Object.entries(config.shows?.rename || {})) {
    const names = db.prepare("SELECT DISTINCT show_title t FROM items WHERE kind = 'episode' AND show_title IS NOT NULL").all()
      .map((r) => r.t).filter((t) => norm(t) === norm(from) && t !== to);
    for (const t of names) {
      const n = db.prepare("UPDATE items SET show_title = ? WHERE kind = 'episode' AND show_title = ?").run(String(to), t).changes;
      db.prepare("DELETE FROM shows WHERE title = ?").run(t);
      db.prepare("DELETE FROM bucket_members WHERE show_title = ?").run(t);
      log.info(`dedupe: show "${t}" is really "${to}" (${n} episodes)`);
      changed++;
    }
  }
  if (changed) db.exec(`INSERT OR IGNORE INTO shows (title) SELECT DISTINCT show_title FROM items
    WHERE kind = 'episode' AND show_title IS NOT NULL`);
  return changed;
}

// Step 1. Returns how many show names changed.
function lineUpShowNames(db) {
  const renamed = renameShows(db);
  const aliases = new Map(Object.entries(config.shows?.aliases || {}).map(([k, v]) => [norm(k), String(v)]));
  const plex = db.prepare(`SELECT DISTINCT show_title t FROM items WHERE source = 'plex' AND kind = 'episode' AND show_title IS NOT NULL`).all().map((r) => r.t);
  const plexExact = new Map(plex.map((t) => [norm(t), t]));
  const plexLoose = new Map();
  for (const t of plex) plexLoose.set(loose(t), plexLoose.has(loose(t)) && plexLoose.get(loose(t)) !== t ? null : t); // null = ambiguous
  const others = db.prepare(`SELECT show_title t, COUNT(*) n FROM items WHERE source != 'plex' AND kind = 'episode' AND show_title IS NOT NULL
    GROUP BY show_title`).all();

  // Per original name: the name it should have, and the season its "season 1" episodes really are.
  const plan = new Map();
  for (const { t } of others) {
    const aliased = aliases.get(norm(t));
    if (aliased !== undefined) { plan.set(t, { title: aliased, season: null, pinned: norm(aliased) === norm(t) }); continue; }
    const { base, season } = splitSeason(t);
    const a = aliases.get(norm(base));
    plan.set(t, { title: a ?? base, season, pinned: a !== undefined && norm(a) === norm(base) });
  }
  for (const p of plan.values()) {
    if (p.pinned) continue; // an alias to itself: keep the name exactly as is
    p.title = plexExact.get(norm(p.title)) ?? plexLoose.get(loose(p.title)) ?? p.title;
  }
  // Names that match no Plex show: variants of one name become the most common spelling.
  const counts = new Map();
  for (const { t, n } of others) { const k = plan.get(t).title; counts.set(k, (counts.get(k) || 0) + n); }
  const best = new Map();
  for (const [title, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (plexExact.has(norm(title)) || plan.get(title)?.pinned) continue;
    if (!best.has(loose(title))) best.set(loose(title), title);
  }
  for (const p of plan.values()) {
    if (!p.pinned && !plexExact.has(norm(p.title))) p.title = best.get(loose(p.title)) ?? p.title;
  }

  const rename = db.prepare(`UPDATE items SET show_title = :to, season = CASE WHEN :season IS NOT NULL AND season = 1 THEN :season ELSE season END
    WHERE source != 'plex' AND kind = 'episode' AND show_title = :from`);
  let changed = 0;
  for (const [from, p] of plan) {
    if (p.title === from && !p.season) continue;
    rename.run({ from, to: p.title, season: p.season ?? null });
    log.info(`dedupe: show "${from}" -> "${p.title}"${p.season ? ` season ${p.season}` : ""}`);
    changed++;
  }
  if (changed) db.exec(`INSERT OR IGNORE INTO shows (title) SELECT DISTINCT show_title FROM items
    WHERE kind = 'episode' AND show_title IS NOT NULL`);
  return changed + renamed;
}

// Which copy to keep, best first: a manual veto wins (so it keeps covering the episode),
// then known playable, then not tried yet, then a failed network read (worth retrying),
// then known unplayable; Plex over local over Real-Debrid; a copy Plex could actually
// identify over one it only guessed at from the filename (same show/season/episode, but
// "Episode 7" instead of the real title); 1080p or less, the sharper the better; the one
// already kept; the oldest.
const SOURCE_RANK = { plex: 0, local: 1, realdebrid: 2 };
const MATCH_RANK = { full: 0, show: 1, none: 2 };
function rank(r) {
  const state = r.playable ? 0
    : r.streams_checked == null && r.unplayable_reason == null ? 1
    : r.streams_checked == null ? 2 : 3;
  const h = r.video_height ?? 0;
  return [r.excluded ? 0 : 1, state, SOURCE_RANK[r.source] ?? 3, MATCH_RANK[r.match] ?? 3, h > 1080 ? h : 1080 - h, r.duplicate_of == null ? 0 : 1, r.id];
}
const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// Step 2. Returns { groups, duplicates, changed }.
function markDuplicates(db) {
  const rows = db.prepare(`SELECT id, source, kind, show_title, season, episode, title, year, playable, excluded,
      streams_checked, unplayable_reason, video_height, duplicate_of, match
    FROM items WHERE present = 1 AND kind IN ('episode', 'movie')`).all();
  const groups = new Map();
  for (const r of rows) {
    if (wrongSource(r)) continue; // left out by step 4, and not a candidate to be the kept copy
    const key = r.kind === "episode"
      ? (r.show_title && r.season != null && r.episode != null ? `e|${norm(r.show_title)}|${r.season}|${r.episode}` : null)
      : (r.year ? `m|${movieKey(r.title)}|${r.year}` : null);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const want = new Map(); // id -> duplicate_of
  let dupGroups = 0, duplicates = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort(better);
    dupGroups++;
    for (const r of g.slice(1)) { want.set(r.id, g[0].id); duplicates++; }
  }

  // Step 3: one local file in several formats (same folder, same name).
  const files = db.prepare(`SELECT id, source_key, playable, excluded FROM items
    WHERE source = 'local' AND present = 1 AND kind IN ('commercial', 'clip', 'short', 'eyecatch')`).all();
  const same = new Map();
  for (const r of files) {
    const key = `${dirname(r.source_key).toLowerCase()}|${basename(r.source_key, extname(r.source_key)).toLowerCase()}`;
    if (!same.has(key)) same.set(key, []);
    same.get(key).push(r);
  }
  const size = (r) => { try { return statSync(r.source_key).size; } catch { return 0; } };
  for (const g of same.values()) {
    if (g.length < 2) continue;
    for (const r of g) r.size = size(r);
    g.sort((a, b) => b.excluded - a.excluded || b.playable - a.playable || b.size - a.size || a.id - b.id);
    dupGroups++;
    for (const r of g.slice(1)) { want.set(r.id, g[0].id); duplicates++; }
  }
  const current = db.prepare("SELECT id, duplicate_of FROM items WHERE duplicate_of IS NOT NULL").all();
  const set = db.prepare("UPDATE items SET duplicate_of = ? WHERE id = ?");
  let changed = 0;
  for (const r of current) if (!want.has(r.id)) { set.run(null, r.id); changed++; }
  const had = new Map(current.map((r) => [r.id, r.duplicate_of]));
  for (const [id, of] of want) if (had.get(id) !== of) { set.run(of, id); changed++; }
  return { groups: dupGroups, duplicates, changed };
}

export function dedupeCatalog() {
  const db = getDb();
  return tx(() => {
    const renamed = lineUpShowNames(db);
    const r = markDuplicates(db);
    const odd = markOddballs(db);
    const relinked = relinkMembers(db);
    log.info(`dedupe: ${r.duplicates} duplicate copies of ${r.groups} episodes/movies/spots left out (${r.changed} changed${renamed ? `, ${renamed} show names lined up` : ""}); ${odd} episodes left out (much shorter than the rest of their show, or from a source turned off for that show)${relinked ? `; ${relinked} bucket picks moved to a live copy` : ""}`);
    return { renamed, oddballs: odd, relinked, ...r };
  });
}

// Step 5: buckets hold single movies/episodes by item id, so a title that comes back under a
// new id (a torrent re-added, a pack replaced, a local copy winning dedupe) would silently
// drop out of its buckets. A member whose copy is gone or a duplicate moves to the live copy
// of the same movie (title ignoring pack prefixes like "DK3 " / "X01 ", year within 1) or
// episode (show + season + episode). Members with no live copy are left alone to wait.
// Returns how many members moved.
function relinkMembers(db) {
  const members = db.prepare(`SELECT m.rowid rid, m.bucket_id, m.item_id, i.kind, i.title, i.year, i.show_title, i.season, i.episode,
      i.present, i.duplicate_of
    FROM bucket_members m JOIN items i ON i.id = m.item_id WHERE m.item_id IS NOT NULL`).all();
  const stale = members.filter((m) => !m.present || m.duplicate_of != null);
  if (!stale.length) return 0;
  const live = db.prepare(`SELECT id, source, kind, title, year, show_title, season, episode, playable, excluded, streams_checked,
      unplayable_reason, video_height, duplicate_of, match
    FROM items WHERE present = 1 AND duplicate_of IS NULL AND NOT excluded AND kind IN ('movie', 'episode')`).all();
  const movies = new Map(), episodes = new Map();
  const push = (map, k, r) => (map.get(k) || map.set(k, []).get(k)).push(r);
  for (const r of live) {
    if (r.kind === "movie") { const k = movieKey(r.title); if (k) push(movies, k, r); }
    else if (r.show_title && r.season != null && r.episode != null) push(episodes, `${norm(r.show_title)}|${r.season}|${r.episode}`, r);
  }
  const byId = new Map(live.map((r) => [r.id, r]));
  const has = db.prepare("SELECT 1 FROM bucket_members WHERE bucket_id = ? AND item_id = ?");
  const move = db.prepare("UPDATE bucket_members SET item_id = ? WHERE rowid = ?");
  const drop = db.prepare("DELETE FROM bucket_members WHERE rowid = ?");
  let moved = 0;
  for (const m of stale) {
    let to = m.present ? byId.get(m.duplicate_of) : null;
    if (!to) {
      const cands = m.kind === "movie"
        ? (movies.get(movieKey(m.title)) || []).filter((c) => !m.year || !c.year || Math.abs(c.year - m.year) <= 1)
        : m.show_title ? (episodes.get(`${norm(m.show_title)}|${m.season}|${m.episode}`) || []) : [];
      to = [...cands].sort(better)[0];
    }
    if (!to || to.id === m.item_id) continue;
    if (has.get(m.bucket_id, to.id)) drop.run(m.rid); else move.run(to.id, m.rid);
    moved++;
  }
  return moved;
}

// Step 4: an episode under ODD_MAX_MIN minutes and under ODD_RATIO of its show's usual
// length (Steins;Gate's 4-minute clips listed as S1E1-E4 of 24-minute episodes, recaps,
// promos) would get a 5-minute block of its own, so it's marked `oddball` and left out.
// Recomputed each time: a show whose episodes are mostly short is left alone (the median
// is short too). Returns how many episodes are marked.
// Also here: episodes from a source the show isn't preferred to use (shows.prefer_source).
const ODD_MAX_MIN = 10;
const ODD_RATIO = 0.4;
function markOddballs(db) {
  const rows = db.prepare(`SELECT id, source, kind, show_title, duration_ms, oddball FROM items
    WHERE kind = 'episode' AND present = 1 AND duplicate_of IS NULL AND show_title IS NOT NULL`).all();
  const want = new Set(rows.filter(wrongSource).map((r) => r.id));
  const byShow = new Map();
  for (const r of rows) if (r.duration_ms > 0 && !want.has(r.id)) (byShow.get(r.show_title) || byShow.set(r.show_title, []).get(r.show_title)).push(r);
  for (const eps of byShow.values()) {
    if (eps.length < 5) continue;
    const median = eps.map((e) => e.duration_ms).sort((a, b) => a - b)[Math.floor(eps.length / 2)];
    for (const e of eps) if (e.duration_ms < ODD_MAX_MIN * 60000 && e.duration_ms < ODD_RATIO * median) want.add(e.id);
  }
  const set = db.prepare("UPDATE items SET oddball = ? WHERE id = ?");
  for (const r of rows) if ((want.has(r.id) ? 1 : 0) !== r.oddball) set.run(want.has(r.id) ? 1 : 0, r.id);
  return want.size;
}
