// The full browsable catalog (catalog.html next to config.yaml): every show and movie
// in the library, laid out Netflix-style - rows of cards (one row per programming
// bucket, reusing the same curation as the schedule) plus a search that flattens
// everything into one grid. No streaming, no artwork (the catalog has none) - cards are
// color-tagged by genre instead of a poster.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";
import { getDb } from "../db.js";
import { listBuckets } from "./buckets.js";

export const CATALOG_PAGE = join(ROOT, "catalog.html");

const parseArr = (j) => (j ? JSON.parse(j) : []);

function titles() {
  const db = getDb();
  const showAgg = db.prepare(`
    SELECT show_title AS title, COUNT(*) episodes, COUNT(DISTINCT COALESCE(season, 0)) seasons,
           SUM(duration_ms) total_ms, MIN(year) first_year
    FROM items WHERE kind = 'episode' AND present = 1 AND NOT excluded AND duplicate_of IS NULL AND NOT oddball
    GROUP BY show_title HAVING show_title IS NOT NULL
  `).all();
  const showMeta = new Map(db.prepare("SELECT * FROM shows").all().map((s) => [s.title, s]));
  const shows = showAgg.map((a) => {
    const m = showMeta.get(a.title) || {};
    return {
      k: "show", key: `show:${a.title}`, title: a.title, year: m.year || a.first_year || null,
      genres: parseArr(m.genres), summary: m.summary || "", audience: m.audience || null,
      anime: !!m.anime, animated: !!m.animated, origin: m.origin || null, decade: m.decade || null,
      vibes: parseArr(m.vibes), holiday: m.holiday && m.holiday !== "none" ? m.holiday : null,
      episodes: a.episodes, seasons: Math.max(1, a.seasons), ms: a.total_ms || 0,
    };
  });
  const movies = db.prepare(`
    SELECT id, title, year, summary, genres, duration_ms FROM items
    WHERE kind = 'movie' AND present = 1 AND NOT excluded AND duplicate_of IS NULL AND NOT oddball
  `).all().map((r) => ({
    k: "movie", key: `movie:${r.id}`, title: r.title, year: r.year || null,
    genres: parseArr(r.genres), summary: r.summary || "", ms: r.duration_ms || 0,
  }));
  return [...shows, ...movies];
}

// A bucket's stored members can be a show title, or an item id that's either a movie
// or one episode of a show (a single-episode pick) - fold all three to a title key.
function bucketKeys(b, byKey, episodeShow) {
  const keys = [];
  for (const t of b.shows) if (byKey.has(`show:${t}`)) keys.push(`show:${t}`);
  for (const id of b.items) {
    const mk = `movie:${id}`;
    if (byKey.has(mk)) { keys.push(mk); continue; }
    const show = episodeShow.get(id);
    if (show && byKey.has(`show:${show}`)) keys.push(`show:${show}`);
  }
  return [...new Set(keys)];
}

function data() {
  const db = getDb();
  const all = titles();
  const byKey = new Map(all.map((t) => [t.key, t]));
  const episodeShow = new Map(db.prepare("SELECT id, show_title FROM items WHERE kind = 'episode'").all().map((r) => [r.id, r.show_title]));

  const memberOf = new Map(); // key -> bucket names
  const rows = listBuckets().map((b) => {
    const keys = bucketKeys(b, byKey, episodeShow);
    for (const k of keys) (memberOf.get(k) || memberOf.set(k, []).get(k)).push(b.name);
    return { name: b.name, about: b.about || "", keys };
  }).filter((r) => r.keys.length >= 3);

  const genreCount = new Map();
  for (const t of all) for (const g of t.genres) genreCount.set(g, (genreCount.get(g) || 0) + 1);
  const topGenres = [...genreCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g]) => g);

  const titleMap = {};
  for (const t of all) titleMap[t.key] = { ...t, blocks: memberOf.get(t.key) || [] };
  return { titles: titleMap, rows, genres: topGenres, counts: { shows: all.filter((t) => t.k === "show").length, movies: all.filter((t) => t.k === "movie").length } };
}

export function catalogPage({ full = false } = {}) {
  const json = JSON.stringify(data()).replaceAll("</", "<\\/");
  const stamp = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const body = PAGE.replace("__DATA__", () => json).replace("__STAMP__", () => stamp);
  return full ? `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${body}</body></html>\n` : body;
}

export function writeCatalogPage() {
  writeFileSync(CATALOG_PAGE, catalogPage({ full: true }));
  return CATALOG_PAGE;
}

const PAGE = String.raw`<title>Catalog</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,500..900&family=Atkinson+Hyperlegible:wght@400;700&family=JetBrains+Mono:wght@500&display=swap">
<style>
:root {
  color-scheme: dark;
  --bg: #0a0a0c; --panel: #17171b; --panel2: #202026; --ink: #f2f1ee; --muted: #9a98a3; --line: #2c2b32;
  --accent: #e8483a; --accent-ink: #ffffff; --hit: #6b5a12;
  --display: "Archivo", "Arial Narrow", system-ui, sans-serif;
  --body: "Atkinson Hyperlegible", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
    --bg: #f3f2ef; --panel: #ffffff; --panel2: #ececec; --ink: #17171b; --muted: #5c5a63; --line: #d9d7dd;
    --hit: #ffe27a;
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f3f2ef; --panel: #ffffff; --panel2: #ececec; --ink: #17171b; --muted: #5c5a63; --line: #d9d7dd;
  --hit: #ffe27a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 var(--body); }
.wrap { max-width: 1400px; margin: 0 auto; padding-inline: 20px; }
header.top { position: sticky; top: 0; z-index: 3; background: linear-gradient(var(--bg), var(--bg) 70%, transparent); padding-block: 18px 10px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 24px; }
h1 { font: 900 clamp(24px, 4vw, 34px)/1 var(--display); font-stretch: 68%; letter-spacing: 0.01em; text-transform: uppercase; margin: 0; color: var(--accent); }
.tag { font: 600 11px/1.4 var(--mono); letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; margin-left: 10px; }
.top nav { display: flex; align-items: center; gap: 14px; }
.top nav a { color: var(--muted); text-decoration: none; font: 600 13px var(--body); border-bottom: 1px dotted transparent; }
.top nav a:hover { color: var(--ink); border-color: var(--muted); }
.searchbar { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1.5px solid var(--line); border-radius: 8px; padding: 8px 12px; min-width: 220px; flex: 1 1 260px; max-width: 420px; }
.searchbar input { border: 0; background: none; color: var(--ink); font: 15px var(--body); outline: none; width: 100%; }
.searchbar input:focus-visible { outline: none; }
.searchbar svg { flex: none; opacity: 0.6; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-block: 4px 14px; }
.chips .lbl { font: 500 11px var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-right: 4px; }
.chip { font: 700 12px var(--body); border: 1.5px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 999px; padding: 3px 12px; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.chip:focus-visible, .searchbar input:focus-visible, .card:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.count { font: 500 12px var(--mono); color: var(--muted); padding-block: 0 6px; }
.hero { display: grid; gap: 6px; padding-block: 8px 22px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
.hero .kicker { font: 700 11px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); }
.hero h2 { margin: 2px 0 4px; font: 800 clamp(22px, 3.4vw, 34px)/1.05 var(--display); font-stretch: 75%; }
.hero p { margin: 0; color: var(--muted); max-width: 720px; }
.hero .metaline { font: 500 12px var(--mono); color: var(--muted); margin-top: 4px; }
.hero button { justify-self: start; margin-top: 8px; font: 700 12px var(--mono); background: none; border: 1px solid var(--line); border-radius: 6px; padding: 5px 12px; color: var(--ink); cursor: pointer; }
.rows { display: grid; gap: 26px; padding-bottom: 60px; }
.row h3 { margin: 0 0 8px; font: 800 15px/1.2 var(--display); font-stretch: 80%; text-transform: uppercase; letter-spacing: 0.02em; }
.row .about { margin: -4px 0 8px; color: var(--muted); font-size: 13px; }
.strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; scrollbar-width: thin; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding-bottom: 60px; }
.card { flex: none; width: 150px; scroll-snap-align: start; border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: grid; gap: 6px; align-content: start; cursor: pointer; background: var(--panel); min-height: 118px; text-align: left; }
.grid .card { width: 100%; }
.card:hover, .card:focus-visible { transform: translateY(-2px); border-color: var(--accent); }
@media (prefers-reduced-motion: no-preference) { .card { transition: transform .12s, border-color .12s; } }
.card .swatch { height: 6px; border-radius: 3px; margin: -10px -10px 2px; }
.card .k { font: 600 10px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.card h4 { margin: 0; font: 700 14px/1.25 var(--display); font-stretch: 85%; }
.card .yr { font: 500 11px var(--mono); color: var(--muted); }
.strip .card { scroll-snap-align: start; }
.strip { scroll-snap-type: x proximate; }
.empty { padding: 40px 0; color: var(--muted); }
dialog#detail { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); padding: 0; max-width: min(560px, 92vw); width: 100%; }
dialog#detail::backdrop { background: rgba(0,0,0,.6); }
dialog#detail .in { padding: 22px 24px 26px; display: grid; gap: 10px; }
dialog#detail .swatch { height: 8px; border-radius: 4px; margin: -22px -24px 6px; }
dialog#detail h3 { margin: 0; font: 800 24px/1.1 var(--display); font-stretch: 78%; }
dialog#detail .metaline { font: 600 12px var(--mono); color: var(--muted); }
dialog#detail p.summary { margin: 4px 0 0; color: var(--ink); }
dialog#detail ul.tags { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
dialog#detail ul.tags li { font: 600 11px var(--body); background: var(--panel2); border-radius: 999px; padding: 3px 10px; color: var(--muted); }
dialog#detail .blocks { font-size: 13px; color: var(--muted); margin-top: 4px; }
dialog#detail .blocks b { color: var(--ink); }
dialog#detail button.close { position: absolute; top: 14px; right: 16px; background: none; border: 0; color: var(--muted); font: 700 20px var(--body); cursor: pointer; line-height: 1; }
</style>
<div class="wrap">
  <header class="top">
    <div><h1>Catalog<span class="tag">every show &amp; movie on the air</span></h1></div>
    <nav><a href="buckets.html">Programming blocks</a></nav>
    <label class="searchbar">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="q" type="search" placeholder="Search the catalog" autocomplete="off">
    </label>
  </header>
  <div class="chips" id="kinds"><span class="lbl">Show</span></div>
  <div class="chips" id="genres"><span class="lbl">Genre</span></div>
  <div class="count" id="count"></div>
  <div id="hero" class="hero"></div>
  <div class="rows" id="rows"></div>
  <div class="grid" id="results" hidden></div>
</div>
<dialog id="detail"><div class="in"><button class="close" type="button" aria-label="Close">&times;</button><div id="detailBody"></div></div></dialog>
<script>
const DATA = __DATA__;
const TITLES = DATA.titles;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const HUES = { Action: 8, Adventure: 28, Animation: 300, Anime: 265, Comedy: 48, Crime: 355, Documentary: 175, Drama: 210, Family: 140, Fantasy: 275, Horror: 0, Kids: 45, Music: 320, Musical: 320, Mystery: 250, Romance: 335, "Sci-Fi": 190, "Science Fiction": 190, Thriller: 15, War: 20, Western: 32 };
function hue(t) { for (const g of t.genres) if (g in HUES) return HUES[g]; let h = 0; for (const c of t.title) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function swatch(t) { const h = hue(t); return "background:linear-gradient(135deg,hsl(" + h + " 70% 32%),hsl(" + ((h + 40) % 360) + " 70% 20%))"; }
function mins(ms) { return ms ? Math.round(ms / 60000) + " min" : ""; }
function metaline(t) {
  const bits = [t.year || ""];
  if (t.k === "show") bits.push(t.seasons > 1 ? t.seasons + " seasons" : t.episodes + " episodes");
  else bits.push(mins(t.ms));
  return bits.filter(Boolean).join(" · ");
}
function cardHtml(t) {
  return '<button class="card" type="button" data-key="' + esc(t.key) + '"><span class="swatch" style="' + swatch(t) + '"></span>' +
    '<span class="k">' + (t.k === "show" ? "series" : "movie") + '</span><h4>' + esc(t.title) + '</h4>' +
    '<span class="yr">' + esc(metaline(t)) + '</span></button>';
}

const state = { q: "", kind: null, genre: null };
function chip(parent, label, key, value) {
  const b = document.createElement("button");
  b.className = "chip"; b.type = "button"; b.textContent = label; b.setAttribute("aria-pressed", "false");
  b.dataset.key = key; b.dataset.value = value;
  b.addEventListener("click", () => { state[key] = state[key] === value ? null : value; render(); });
  parent.appendChild(b);
}
chip($("kinds"), "Series", "kind", "show");
chip($("kinds"), "Movies", "kind", "movie");
DATA.genres.forEach((g) => chip($("genres"), g, "genre", g));
$("q").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });

function matches(t) {
  if (state.kind && t.k !== state.kind) return false;
  if (state.genre && !t.genres.includes(state.genre)) return false;
  if (state.q && !t.title.toLowerCase().includes(state.q)) return false;
  return true;
}

function renderHero() {
  const all = Object.values(TITLES);
  const pick = all[Math.floor(Math.random() * all.length)];
  $("hero").dataset.key = pick.key;
  $("hero").innerHTML = '<div class="kicker">Featured</div><h2>' + esc(pick.title) + '</h2>' +
    '<p>' + esc(pick.summary || "No synopsis on file.") + '</p>' +
    '<div class="metaline">' + esc(metaline(pick)) + (pick.genres.length ? " · " + esc(pick.genres.join(", ")) : "") + '</div>' +
    '<button type="button" id="heroDetail">Details</button>';
  $("heroDetail").addEventListener("click", () => openDetail(pick.key));
}

function render() {
  document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(state[c.dataset.key] === c.dataset.value)));
  const searching = !!(state.q || state.kind || state.genre);
  $("rows").hidden = searching;
  $("hero").hidden = searching;
  $("results").hidden = !searching;
  if (!searching) { $("count").textContent = DATA.counts.shows + " series · " + DATA.counts.movies + " movies"; return; }
  const all = Object.values(TITLES).filter(matches).sort((a, b) => a.title.localeCompare(b.title));
  $("results").innerHTML = all.length ? all.map(cardHtml).join("") : "";
  $("count").textContent = all.length + " match" + (all.length === 1 ? "" : "es");
  if (!all.length) $("results").innerHTML = '<p class="empty">Nothing matches that. Try part of a title or a genre.</p>';
}

function renderRows() {
  $("rows").innerHTML = DATA.rows.map((r) => {
    const cards = r.keys.map((k) => TITLES[k]).filter(Boolean);
    if (!cards.length) return "";
    return '<section class="row"><h3>' + esc(r.name) + '</h3>' + (r.about ? '<p class="about">' + esc(r.about) + '</p>' : "") +
      '<div class="strip">' + cards.map(cardHtml).join("") + '</div></section>';
  }).join("");
}

function openDetail(key) {
  const t = TITLES[key];
  if (!t) return;
  const tags = [];
  if (t.audience) tags.push(t.audience);
  if (t.anime) tags.push("anime"); else if (t.animated) tags.push("animated");
  if (t.origin) tags.push(t.origin);
  if (t.holiday) tags.push(t.holiday);
  (t.vibes || []).forEach((v) => tags.push(v));
  $("detailBody").innerHTML = '<span class="swatch" style="' + swatch(t) + '"></span>' +
    '<h3>' + esc(t.title) + '</h3>' +
    '<div class="metaline">' + esc(metaline(t)) + (t.genres.length ? " · " + esc(t.genres.join(", ")) : "") + '</div>' +
    '<p class="summary">' + esc(t.summary || "No synopsis on file.") + '</p>' +
    (tags.length ? '<ul class="tags">' + tags.map((x) => "<li>" + esc(x) + "</li>").join("") + '</ul>' : "") +
    (t.blocks.length ? '<div class="blocks">Airs in: <b>' + t.blocks.map(esc).join("</b>, <b>") + '</b></div>' : "");
  $("detail").showModal();
}
document.addEventListener("click", (e) => {
  const c = e.target.closest(".card");
  if (c) openDetail(c.dataset.key);
});
$("detail").addEventListener("click", (e) => { if (e.target.closest("button.close") || e.target === $("detail")) $("detail").close(); });

renderHero();
renderRows();
render();
</script>
`;
