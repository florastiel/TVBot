// A browsable page of the buckets (buckets.html next to config.yaml): one card per
// bucket with its format, when it airs, its season, and every title in it. Search
// works both ways: bucket names, and titles ("which buckets is Barbie in?").
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";
import { getDb } from "../db.js";
import { listBuckets } from "./buckets.js";

export const BUCKET_PAGE = join(ROOT, "buckets.html");

function data() {
  const item = getDb().prepare("SELECT kind, title, year, show_title, season, episode FROM items WHERE id = ?");
  return listBuckets().map((b) => ({
    name: b.name,
    about: b.about || "",
    format: b.format,
    dayparts: b.dayparts,
    from: b.active_from,
    to: b.active_to,
    source: b.source,
    members: [
      ...b.shows.map((t) => ({ t, k: "show" })),
      ...b.items.map((id) => {
        const r = item.get(id);
        if (!r) return null;
        return r.kind === "episode" ? { t: `${r.show_title} S${r.season}E${r.episode}`, k: "episode" } : { t: `${r.title}${r.year ? ` (${r.year})` : ""}`, k: r.kind };
      }).filter(Boolean),
    ],
  }));
}

// The page body (the artifact viewer adds its own <html>/<head>); full: a standalone file.
export function bucketPage({ full = false } = {}) {
  const json = JSON.stringify(data()).replaceAll("</", "<\\/");
  const stamp = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  // Function replacers: a "$&" or "$'" in a title must not be read as a replacement pattern.
  const body = PAGE.replace("__DATA__", () => json).replace("__STAMP__", () => stamp);
  return full ? `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${body}</body></html>\n` : body;
}

export function writeBucketPage() {
  writeFileSync(BUCKET_PAGE, bucketPage({ full: true }));
  return BUCKET_PAGE;
}

const PAGE = String.raw`<title>Bucket Book</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,500..900&family=Atkinson+Hyperlegible:wght@400;700&family=JetBrains+Mono:wght@500&display=swap">
<style>
:root {
  color-scheme: light;
  --bg: #e9edf1;
  --panel: #f7f9fb;
  --ink: #141c26;
  --muted: #5b6776;
  --line: #cfd6de;
  --accent: #2f45b8;
  --accent-ink: #ffffff;
  --hit: #ffe27a;
  --morning: #e7a51c;
  --afternoon: #2f93c9;
  --evening: #4b3fb5;
  --late: #8a2f7a;
  --off: #d8dee5;
  --display: "Archivo", "Arial Narrow", system-ui, sans-serif;
  --body: "Atkinson Hyperlegible", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0f141b; --panel: #171e27; --ink: #e6ebf1; --muted: #93a0b0; --line: #2a3441;
    --accent: #8d9cff; --accent-ink: #0f141b; --hit: #6b5a12;
    --morning: #f0b43a; --afternoon: #4fb0e3; --evening: #8a7ff0; --late: #d06bbd; --off: #2a3441;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f141b; --panel: #171e27; --ink: #e6ebf1; --muted: #93a0b0; --line: #2a3441;
  --accent: #8d9cff; --accent-ink: #0f141b; --hit: #6b5a12;
  --morning: #f0b43a; --afternoon: #4fb0e3; --evening: #8a7ff0; --late: #d06bbd; --off: #2a3441;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 var(--body); padding-inline: 16px; padding-block: 0 48px; }
.wrap { max-width: 1240px; margin: 0 auto; }
header.top { padding-block: 28px 12px; display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 8px 24px; }
h1 { font: 900 clamp(34px, 6vw, 56px)/0.95 var(--display); font-stretch: 68%; letter-spacing: 0.01em; text-transform: uppercase; margin: 0; }
h1 small { display: block; font: 600 13px/1.4 var(--mono); letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; margin-top: 8px; font-stretch: 100%; }
h1 small a.catalink { color: var(--accent); text-decoration: none; }
h1 small a.catalink:hover { text-decoration: underline; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font: 500 12px var(--mono); color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 14px; height: 6px; border-radius: 2px; display: inline-block; }
.bar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 2; background: var(--bg); padding-block: 10px; border-bottom: 2px solid var(--ink); display: grid; gap: 10px; }
.bar input[type=search] { width: 100%; font: 16px var(--body); padding: 10px 14px; border: 1.5px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink); }
.bar input[type=search]:focus-visible, .chip:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chips .lbl { font: 500 11px var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-right: 4px; }
.chip { font: 700 13px var(--body); border: 1.5px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.count { font: 500 13px var(--mono); color: var(--muted); padding-block: 14px 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 330px), 1fr)); gap: 14px; align-items: start; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px 12px; display: grid; gap: 8px; }
.card h2 { margin: 0; font: 800 22px/1.05 var(--display); font-stretch: 75%; text-wrap: balance; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font: 500 12px var(--mono); color: var(--muted); }
.fmt { border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; color: var(--ink); }
.season { color: var(--ink); }
.auto { font-style: italic; }
.day { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; }
.day i { height: 6px; border-radius: 2px; background: var(--off); }
.day i.on.morning { background: var(--morning); } .day i.on.afternoon { background: var(--afternoon); }
.day i.on.evening { background: var(--evening); } .day i.on.late { background: var(--late); }
.about { margin: 0; color: var(--muted); font-size: 14px; }
ul.m { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
ul.m li { font-size: 13px; background: var(--bg); border-radius: 4px; padding: 1px 7px; }
ul.m li.hit { background: var(--hit); }
ul.m li[data-k="movie"]::before { content: "\25B6\FE0E "; font-size: 9px; color: var(--muted); }
button.more { justify-self: start; font: 700 12px var(--mono); background: none; border: 0; padding: 2px 0; color: var(--accent); cursor: pointer; }
.empty { padding: 40px 0; color: var(--muted); }
@media (prefers-reduced-motion: no-preference) { .card { transition: border-color .15s; } .card:hover { border-color: var(--muted); } }
</style>
<div class="wrap">
  <header class="top">
    <h1>Bucket Book<small>Every kind of block the TV can air · updated __STAMP__<br><a class="catalink" href="catalog.html">Browse the full catalog &rarr;</a></small></h1>
    <div class="legend" aria-label="When a bucket can air">
      <span><i style="background:var(--morning)"></i>morning 6–12</span>
      <span><i style="background:var(--afternoon)"></i>afternoon 12–5</span>
      <span><i style="background:var(--evening)"></i>evening 5–10</span>
      <span><i style="background:var(--late)"></i>late 10–6</span>
    </div>
  </header>
  <div class="bar">
    <input id="q" type="search" placeholder="Search buckets or titles (try a show or movie name)" autocomplete="off">
    <div class="chips" id="formats"><span class="lbl">Format</span></div>
    <div class="chips" id="parts"><span class="lbl">Airs</span></div>
  </div>
  <div class="count" id="count"></div>
  <div class="grid" id="grid"></div>
</div>
<script>
const BUCKETS = __DATA__;
const FORMATS = { one_show: "one show", variety: "variety", movie: "movie", movie_series: "movie series" };
const PARTS = ["morning", "afternoon", "evening", "late"];
const state = { q: "", format: null, part: null, open: new Set() };
const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (s) => { const [m, d] = s.split("-").map(Number); return new Date(2000, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };

function chip(parent, label, key, value) {
  const b = document.createElement("button");
  b.className = "chip"; b.type = "button"; b.textContent = label; b.setAttribute("aria-pressed", "false");
  b.addEventListener("click", () => { state[key] = state[key] === value ? null : value; render(); });
  b.dataset.key = key; b.dataset.value = value;
  parent.appendChild(b);
}
Object.entries(FORMATS).forEach(([v, l]) => chip($("formats"), l, "format", v));
PARTS.forEach((p) => chip($("parts"), p, "part", p));
$("q").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });

function render() {
  document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(state[c.dataset.key] === c.dataset.value)));
  const q = state.q;
  let titleHits = 0;
  const shown = BUCKETS.filter((b) => (!state.format || b.format === state.format) && (!state.part || b.dayparts.includes(state.part)))
    .map((b) => {
      const hits = q ? b.members.filter((m) => m.t.toLowerCase().includes(q)) : [];
      const nameHit = q && (b.name.toLowerCase().includes(q) || b.about.toLowerCase().includes(q));
      return { b, hits, keep: !q || nameHit || hits.length };
    }).filter((x) => x.keep);
  const html = shown.map(({ b, hits }) => {
    titleHits += hits.length;
    const hitSet = new Set(hits.map((h) => h.t));
    const open = state.open.has(b.name) || hits.length > 0;
    const members = open ? b.members : b.members.slice(0, 10);
    const season = b.from ? '<span class="season">' + md(b.from) + " – " + md(b.to) + "</span>" : "";
    const auto = b.source === "auto" ? '<span class="auto">automatic</span>' : b.source === "fallback" ? '<span class="auto">catch-all</span>' : "";
    return '<article class="card">' +
      "<h2>" + esc(b.name) + "</h2>" +
      '<div class="day" title="Airs: ' + b.dayparts.join(", ") + '">' + PARTS.map((p) => '<i class="' + p + (b.dayparts.includes(p) ? " on" : "") + '"></i>').join("") + "</div>" +
      '<div class="meta"><span class="fmt">' + FORMATS[b.format] + "</span><span>" + b.members.length + " titles</span>" + season + auto + "</div>" +
      (b.about ? '<p class="about">' + esc(b.about) + "</p>" : "") +
      '<ul class="m">' + members.map((m) => '<li data-k="' + m.k + '"' + (hitSet.has(m.t) ? ' class="hit"' : "") + ">" + esc(m.t) + "</li>").join("") + "</ul>" +
      (b.members.length > 10 && !hits.length ? '<button class="more" type="button" data-name="' + esc(b.name) + '">' + (open ? "show fewer" : "show all " + b.members.length) + "</button>" : "") +
      "</article>";
  }).join("");
  $("grid").innerHTML = html || '<p class="empty">No bucket matches that. Try part of a title, like "sentai" or "Ghibli".</p>';
  $("count").textContent = shown.length + " of " + BUCKETS.length + " buckets" + (q && titleHits ? " · " + titleHits + " matching titles highlighted" : "");
}
$("grid").addEventListener("click", (e) => {
  const b = e.target.closest("button.more");
  if (!b) return;
  const n = b.dataset.name;
  state.open.has(n) ? state.open.delete(n) : state.open.add(n);
  render();
});
render();
</script>
`;
