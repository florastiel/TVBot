// Tools for the weekly programming pass (PROGRAMMING.md), run by Claude Code or by hand:
//   node scripts/program/tv.mjs review            catalog report -> data/program/review.txt
//   node scripts/program/tv.mjs apply plan.json   check a bucket plan (nothing written)
//   node scripts/program/tv.mjs apply plan.json --apply   check, then apply it
//   node scripts/program/tv.mjs check             check programming.yaml against the buckets
//   node scripts/program/tv.mjs done              mark everything in the catalog as reviewed
// Run with tools\node\node.exe from the project folder (tv.cmd sets up the same paths).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../src/config.js";
import { getDb, tx, getMeta, setMeta } from "../../src/db.js";
import { schedulableSql } from "../../src/catalog/schedulable.js";
import { listBuckets, FORMATS, DAYPARTS, isMovieFormat } from "../../src/schedule/buckets.js";
import { loadTemplate, checkTemplate } from "../../src/schedule/templategrid.js";
import { localDay } from "../../src/schedule/time.js";
import { anilistSummary } from "../../src/tagging/anilist.js";

const OUT = join(DATA_DIR, "program");
mkdirSync(OUT, { recursive: true });
const db = getDb();
const S = schedulableSql("i");
const MIN = { one_show: 1, variety: 4, movie: 3, movie_series: 2 };
const vibes = (j) => { try { return JSON.parse(j || "[]").join("/"); } catch { return ""; } };
const [cmd, ...args] = process.argv.slice(2);

// ---------- review ----------
function review() {
  const out = [];
  const today = localDay(Date.now());
  out.push(`Today: ${today.weekday} ${today.date}. Holiday windows: Halloween 10-01..10-31, Thanksgiving 11-01..11-28, Christmas 11-24..12-25.`);
  const buckets = listBuckets();
  const homes = new Map(); // show title / item id -> bucket names (not catch-alls)
  for (const b of buckets) if (b.source !== "fallback") for (const k of [...b.shows, ...b.items]) homes.set(k, [...(homes.get(k) || []), b.name]);
  out.push(`\nBUCKETS (${buckets.length}): name | source | format | dayparts | season | size | about`);
  for (const b of buckets) out.push(`${b.name} | ${b.source} | ${b.format} | ${b.dayparts.join("/")} | ${b.active_from ? `${b.active_from}..${b.active_to}` : "-"} | ${b.shows.length + b.items.length} | ${b.about || ""}`);

  const lastId = Number(getMeta("program_reviewed_id") || 0);
  const shows = db.prepare(`SELECT s.title, s.year, s.audience, s.animated, s.anime, s.origin, s.decade, s.vibes, s.genres, s.anilist_tags, COUNT(i.id) n, MAX(i.id) newest
    FROM shows s JOIN items i ON i.show_title = s.title AND i.kind = 'episode' AND ${S} GROUP BY s.title ORDER BY s.title`).all();
  const movies = db.prepare(`SELECT i.id, i.title, i.year, i.duration_ms, t.audience, t.animated, t.anime, t.origin, t.mood, t.holiday, i.genres
    FROM items i LEFT JOIN tags t ON t.item_id = i.id WHERE i.kind = 'movie' AND ${S} ORDER BY i.title`).all();
  const showLine = (s) => `show "${s.title}"${s.year ? ` (${s.year})` : ""} | ${s.n} eps | ${[s.audience, s.anime ? "anime" : s.animated ? "animated" : "live", s.origin, s.decade ? `${s.decade}s` : null, vibes(s.vibes)].filter(Boolean).join(", ")} | ${vibes(s.genres)}${s.anilist_tags ? ` | AniList: ${anilistSummary(s.anilist_tags)}` : ""} | in: ${(homes.get(s.title) || ["-"]).join(", ")}`;
  const movieLine = (m) => `movie ${m.id} "${m.title}" (${m.year ?? "?"}) ${Math.round((m.duration_ms || 0) / 60000)}m | ${[m.audience, m.anime ? "anime" : m.animated ? "animated" : "live", m.origin, vibes(m.mood), m.holiday && m.holiday !== "none" ? m.holiday : null].filter(Boolean).join(", ")} | ${vibes(m.genres)} | in: ${(homes.get(m.id) || ["-"]).join(", ")}`;

  out.push(`\nNEW SINCE THE LAST PASS (catalog ids > ${lastId}):`);
  for (const s of shows) if (s.newest > lastId && !homes.has(s.title)) out.push("  " + showLine(s));
  for (const s of shows) if (s.newest > lastId && homes.has(s.title)) out.push("  (new episodes) " + showLine(s));
  for (const m of movies) if (m.id > lastId) out.push("  " + movieLine(m));
  out.push(`\nIN NO BUCKET (only the catch-alls):`);
  for (const s of shows) if (!homes.has(s.title)) out.push("  " + showLine(s));
  for (const m of movies) if (!homes.has(m.id)) out.push("  " + movieLine(m));
  out.push(`\nIN ONE BUCKET:`);
  for (const s of shows) if ((homes.get(s.title) || []).length === 1) out.push("  " + showLine(s));
  for (const m of movies) if ((homes.get(m.id) || []).length === 1) out.push("  " + movieLine(m));
  const holiday = db.prepare(`SELECT t.holiday, COUNT(*) n FROM tags t JOIN items i ON i.id = t.item_id WHERE ${S} AND t.holiday != 'none' GROUP BY t.holiday`).all();
  out.push(`\nHOLIDAY-TAGGED TITLES: ${holiday.map((h) => `${h.holiday} ${h.n}`).join(", ") || "none"}`);
  const problems = checkTemplate(loadTemplate(), buckets);
  out.push(`\nprogramming.yaml: ${problems.length ? problems.join("; ") : "OK"}`);
  out.push(`\nALL SHOWS (${shows.length}):`);
  for (const s of shows) out.push("  " + showLine(s));
  out.push(`\nALL MOVIES (${movies.length}):`);
  for (const m of movies) out.push("  " + movieLine(m));
  writeFileSync(join(OUT, "review.txt"), out.join("\n"));
  console.log(`wrote ${join(OUT, "review.txt")} (${out.length} lines; new since last pass: ids > ${lastId})`);
}

// ---------- apply ----------
// plan.json: { "new": [{ name, format, dayparts, about, active_from?, active_to?, shows?, items? }],
//   "add": { bucket: { shows?, items? } }, "remove": { bucket: { shows?, items? } },
//   "retire": [bucket], "rename": [[from, to, about?]], "exclude": [{ id, why }] }
// items are catalog ids of movies; shows are exact show titles. movie_series items go in play order.
function apply(file, write) {
  const plan = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  const live = new Map(listBuckets().map((b) => [b.name, b]));
  const renamed = new Map((plan.rename || []).map(([f, t]) => [t, f]));
  const exists = (name) => live.has(name) || (renamed.has(name) && live.has(renamed.get(name))) || (plan.new || []).some((b) => b.name === name);
  const fmtOf = (name) => live.get(name)?.format ?? live.get(renamed.get(name))?.format ?? (plan.new || []).find((b) => b.name === name)?.format;
  const show = (t, where) => { if (!db.prepare(`SELECT 1 FROM items i WHERE i.show_title = ? AND i.kind = 'episode' AND ${S} LIMIT 1`).get(t)) problems.push(`${where}: no schedulable show "${t}"`); };
  const movie = (id, where) => { if (!db.prepare(`SELECT 1 FROM items i WHERE i.id = ? AND i.kind = 'movie' AND ${S}`).get(id)) problems.push(`${where}: ${id} isn't a schedulable movie`); };
  const members = (where, fmt, m) => {
    if (m.shows?.length && isMovieFormat(fmt)) problems.push(`${where}: shows can't go in a ${fmt} bucket`);
    if (m.items?.length && fmt && !isMovieFormat(fmt)) problems.push(`${where}: movies can't go in a ${fmt} bucket`);
    (m.shows || []).forEach((t) => show(t, where)); (m.items || []).forEach((id) => movie(id, where));
  };
  for (const b of plan.new || []) {
    const w = `new "${b.name}"`;
    if (live.has(b.name)) problems.push(`${w}: a bucket with that name exists`);
    if (!/^[\p{L}\p{N} &'-]{1,32}$/u.test(b.name || "") || b.name.trim().split(/\s+/).length > 4) problems.push(`${w}: name must be 1-4 plain words`);
    if (!FORMATS.includes(b.format)) problems.push(`${w}: format must be one of ${FORMATS.join(", ")}`);
    if (!Array.isArray(b.dayparts) || !b.dayparts.length || b.dayparts.some((d) => !DAYPARTS.includes(d))) problems.push(`${w}: dayparts from ${DAYPARTS.join(", ")}`);
    if (!!b.active_from !== !!b.active_to || [b.active_from, b.active_to].some((s) => s && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s))) problems.push(`${w}: active_from/active_to both MM-DD or both absent`);
    const n = (b.shows || []).length + (b.items || []).length;
    if (n < (MIN[b.format] || 1)) problems.push(`${w}: needs at least ${MIN[b.format]} members for ${b.format}, has ${n}`);
    members(w, b.format, b);
  }
  for (const n of plan.retire || []) if (!live.has(n)) problems.push(`retire: no bucket "${n}"`);
  for (const [f] of plan.rename || []) if (!live.has(f)) problems.push(`rename: no bucket "${f}"`);
  for (const [n, m] of Object.entries(plan.add || {})) { if (!exists(n)) problems.push(`add: no bucket "${n}"`); else members(`add to "${n}"`, fmtOf(n), m); }
  for (const n of Object.keys(plan.remove || {})) if (!exists(n)) problems.push(`remove: no bucket "${n}"`);
  for (const e of plan.exclude || []) if (!db.prepare("SELECT 1 FROM items WHERE id = ?").get(e.id)) problems.push(`exclude: no item ${e.id}`);
  if (problems.length) { console.log(`PLAN HAS PROBLEMS (nothing applied):\n- ${problems.join("\n- ")}`); process.exitCode = 1; return; }
  if (!write) { console.log("plan OK (checked only; add --apply to write it)"); return; }

  const now = new Date().toISOString();
  tx(() => {
    const idOf = (n) => db.prepare("SELECT id FROM buckets WHERE name = ? AND NOT retired").get(n).id;
    const put = db.prepare("INSERT INTO bucket_members (bucket_id, show_title, item_id, position) VALUES (?, ?, ?, ?)");
    const addTo = (bid, m) => {
      let p = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 p FROM bucket_members WHERE bucket_id = ?").get(bid).p;
      const has = db.prepare("SELECT 1 FROM bucket_members WHERE bucket_id = ? AND (show_title = ? OR item_id = ?)");
      for (const s of m.shows || []) if (!has.get(bid, s, -1)) put.run(bid, s, null, p++);
      for (const i of m.items || []) if (!has.get(bid, "", i)) put.run(bid, null, i, p++);
    };
    for (const [f, t, about] of plan.rename || []) db.prepare("UPDATE buckets SET name = ?, about = COALESCE(?, about) WHERE name = ? AND NOT retired").run(t, about ?? null, f);
    for (const n of plan.retire || []) db.prepare("UPDATE buckets SET retired = 1 WHERE name = ? AND NOT retired").run(n);
    for (const b of plan.new || []) {
      const id = db.prepare(`INSERT INTO buckets (name, about, format, dayparts, active_from, active_to, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'claude', ?)`)
        .run(b.name, b.about || null, b.format, JSON.stringify(b.dayparts), b.active_from || null, b.active_to || null, now).lastInsertRowid;
      addTo(id, b);
    }
    for (const [n, m] of Object.entries(plan.add || {})) addTo(idOf(n), m);
    for (const [n, m] of Object.entries(plan.remove || {})) {
      const bid = idOf(n);
      for (const s of m.shows || []) db.prepare("DELETE FROM bucket_members WHERE bucket_id = ? AND show_title = ?").run(bid, s);
      for (const i of m.items || []) db.prepare("DELETE FROM bucket_members WHERE bucket_id = ? AND item_id = ?").run(bid, i);
    }
    for (const e of plan.exclude || []) db.prepare("UPDATE items SET excluded = 1, unplayable_reason = ? WHERE id = ?").run(`excluded: ${e.why || "weekly programming pass"}`, e.id);
    setMeta("buckets_refreshed", ""); // re-run the catch-all sort at the next top-up
  });
  writeFileSync(join(OUT, `applied-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(plan, null, 1));
  console.log(`applied: ${(plan.new || []).length} new, ${(plan.retire || []).length} retired, ${(plan.rename || []).length} renamed, ${Object.keys(plan.add || {}).length} added to, ${Object.keys(plan.remove || {}).length} trimmed, ${(plan.exclude || []).length} excluded`);
}

if (cmd === "review") review();
else if (cmd === "apply" && args[0]) apply(args[0], args.includes("--apply"));
else if (cmd === "check") { const p = checkTemplate(loadTemplate(), listBuckets()); console.log(p.length ? `programming.yaml problems:\n- ${p.join("\n- ")}` : "programming.yaml OK"); if (p.length) process.exitCode = 1; }
else if (cmd === "done") { const m = db.prepare("SELECT MAX(id) m FROM items").get().m; setMeta("program_reviewed_id", String(m)); console.log(`marked reviewed up to id ${m}`); }
else { console.log("usage: node scripts/program/tv.mjs review | apply <plan.json> [--apply] | check | done"); process.exitCode = 2; }
