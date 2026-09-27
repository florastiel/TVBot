// Which anime are shorts? AniList (graphql.anilist.co: free, no key, about 90 requests a
// minute) knows each series' format (TV_SHORT) and episode length, so a short added to Plex or
// Real-Debrid is recognized without anyone putting it in the shorts folder. The Shorts block
// (schedule/buckets.js) then includes it.
import { setTimeout as sleep } from "node:timers/promises";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { schedulableSql } from "../catalog/schedulable.js";

const URL = "https://graphql.anilist.co";
const QUERY = `query ($q: String) { Page(perPage: 6) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
  id format episodes duration seasonYear title { romaji english } synonyms } } }`;

const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s*\((?:(?:19|20)\d{2}|US|UK)\)\s*$/i, "").replace(/[^\p{L}\p{N}]/gu, "");

async function search(title) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(URL, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { q: title.replace(/\s*\((?:(?:19|20)\d{2}|US|UK)\)\s*$/i, "") } }), signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) { await sleep((Number(res.headers.get("retry-after")) || 30) * 1000); continue; }
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    return (await res.json())?.data?.Page?.media || [];
  }
  throw new Error("AniList kept saying too many requests");
}

// The result that really is this show (same name, or one contains the other), or null.
function pick(media, title) {
  const want = norm(title);
  if (!want) return null;
  const names = (m) => [m.title?.romaji, m.title?.english, ...(m.synonyms || [])].map(norm).filter(Boolean);
  const exact = media.find((m) => names(m).includes(want));
  if (exact) return exact;
  // Otherwise the longest-running series whose name starts with this one ("Demon Slayer" is
  // "Demon Slayer: Kimetsu no Yaiba", not one of its 4-minute spin-off shorts).
  return media.filter((m) => names(m).some((n) => n.length >= 8 && want.length >= 8 && (n.startsWith(want) || want.startsWith(n))))
    .sort((a, b) => (b.episodes || 0) - (a.episodes || 0))[0] || null;
}

// A short: AniList's TV_SHORT format, or episodes of 10 minutes or less.
export const isShort = (m) => m.format === "TV_SHORT" || (["TV", "ONA", "OVA"].includes(m.format) && m.duration > 0 && m.duration <= 10 && (m.episodes || 0) >= 3);

// Anime shows not looked up yet (all of them with redo). Returns how many are shorts now.
export async function detectShorts({ redo = false } = {}) {
  const db = getDb();
  const todo = db.prepare(`SELECT s.title FROM shows s WHERE s.anime = 1 ${redo ? "" : "AND s.anilist_checked_at IS NULL"}
    AND EXISTS (SELECT 1 FROM items i WHERE i.show_title = s.title AND i.kind = 'episode' AND ${schedulableSql("i")}) ORDER BY s.title`).all().map((r) => r.title);
  if (!todo.length) { log.info("anilist: every anime show is already checked"); return 0; }
  log.info(`anilist: checking ${todo.length} anime shows`);
  const save = db.prepare("UPDATE shows SET short = ?, anilist_id = ?, anilist_format = ?, anilist_checked_at = ? WHERE title = ?");
  let shorts = 0, unmatched = 0;
  for (const title of todo) {
    let m = null;
    try { m = pick(await search(title), title); } catch (e) { log.warn(`anilist: ${title}: ${e.message}`); await sleep(5000); continue; } // tried again next time
    if (!m) unmatched++;
    // AniList must agree with the files themselves (episodes of 15 minutes or less), so a
    // wrong match can never turn a real series into a short.
    const avg = db.prepare(`SELECT AVG(i.duration_ms) a FROM items i WHERE i.show_title = ? AND i.kind = 'episode' AND ${schedulableSql("i")}`).get(title).a;
    const short = m ? (isShort(m) && avg && avg <= 15 * 60000 ? 1 : 0) : null;
    if (short) { shorts++; log.info(`anilist: "${title}" is a short (${m.format}, ${m.duration ?? "?"} min episodes)`); }
    save.run(short, m?.id ?? null, m?.format ?? null, new Date().toISOString(), title);
    await sleep(1200); // stay well under the rate limit
  }
  log.info(`anilist: ${todo.length} checked, ${shorts} shorts, ${unmatched} not matched`);
  return shorts;
}
