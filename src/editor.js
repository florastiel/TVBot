// tv.cmd editor: a small local web page for fixing buckets by hand (add/remove titles, reorder a
// movie series, change a bucket's season/dayparts/about/name, make or retire one). It only listens
// on this PC (127.0.0.1) and every request needs the page's random token. Writes go straight to
// the database with the same rules as scripts/program/tv.mjs apply; a backup is taken first.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, DATA_DIR } from "./config.js";
import { getDb, tx, setMeta } from "./db.js";
import { schedulableSql } from "./catalog/schedulable.js";
import { FORMATS, DAYPARTS, isMovieFormat, listBuckets } from "./schedule/buckets.js";
import { loadTemplate } from "./schedule/templategrid.js";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "editor.html");
const MIN = { one_show: 1, variety: 4, movie: 3, movie_series: 2 };
const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const NAME = /^[\p{L}\p{N} &'-]{1,32}$/u;
const S = schedulableSql("i");

class Bad extends Error {}
const bad = (m) => { throw new Bad(m); };

let backedUp = false;
function backup() {
  if (backedUp) return;
  const d = new Date();
  const p = join(DATA_DIR, `tv-before-editor-${d.toISOString().slice(0, 16).replace(/[-:T]/g, "")}.db`);
  getDb().exec(`VACUUM INTO '${p.replaceAll("'", "''")}'`);
  backedUp = true;
  console.log(`backup: ${p}`);
}
const touched = () => setMeta("buckets_refreshed", ""); // the catch-all sort re-runs at the next top-up

const bucket = (id) => {
  const b = getDb().prepare("SELECT * FROM buckets WHERE id = ? AND NOT retired").get(id);
  if (!b) bad("No such bucket.");
  b.dayparts = JSON.parse(b.dayparts);
  return b;
};
const editable = (b) => { if (b.source !== "claude") bad(`"${b.name}" is built by code (${b.source}); it can't be edited here.`); return b; };

function checkMeta(m, { id = null, format = null } = {}) {
  const name = String(m.name ?? "").trim();
  if (!NAME.test(name) || name.split(/\s+/).length > 4) bad("Name: 1-4 plain words (letters, numbers, & ' -), up to 32 characters.");
  if (getDb().prepare("SELECT 1 FROM buckets WHERE name = ? AND NOT retired AND id != ?").get(name, id ?? -1)) bad("A bucket with that name exists.");
  if (format !== null && !FORMATS.includes(format)) bad(`Format must be one of ${FORMATS.join(", ")}.`);
  const dayparts = DAYPARTS.filter((d) => (m.dayparts || []).includes(d));
  if (!dayparts.length) bad("Pick at least one daypart.");
  const from = m.active_from || null, to = m.active_to || null;
  if (!!from !== !!to || [from, to].some((s) => s && !MMDD.test(s))) bad("Season: both dates as MM-DD, or neither.");
  return { name, about: String(m.about ?? "").trim() || null, dayparts, from, to };
}

function info() {
  const pools = {};
  try { for (const [p, list] of Object.entries(loadTemplate().pools || {})) for (const n of list) (pools[n] ??= []).push(p); } catch { /* no template */ }
  for (const r of config.broadcast.standing_slots || []) if (r?.bucket) (pools[r.bucket] ??= []).push(`standing ${r.day} ${r.from}`);
  return { pools, formats: FORMATS, dayparts: DAYPARTS, min: MIN };
}

function list() {
  const db = getDb();
  const liveItems = new Set(db.prepare(`SELECT i.id FROM items i WHERE ${S}`).all().map((r) => r.id));
  const liveShows = new Set(db.prepare(`SELECT DISTINCT i.show_title t FROM items i WHERE i.kind = 'episode' AND ${S}`).all().map((r) => r.t));
  return listBuckets().map((b) => ({
    id: b.id, name: b.name, source: b.source, format: b.format, dayparts: b.dayparts, active_from: b.active_from, active_to: b.active_to, about: b.about,
    shows: b.shows.length, items: b.items.length,
    live: b.shows.filter((s) => liveShows.has(s)).length + b.items.filter((i) => liveItems.has(i)).length,
  }));
}

function detail(id) {
  const db = getDb();
  const b = bucket(id);
  const rows = db.prepare("SELECT show_title, item_id FROM bucket_members WHERE bucket_id = ? ORDER BY position, rowid").all(id);
  const members = rows.map((r, n) => {
    if (r.show_title) {
      const c = db.prepare(`SELECT COUNT(*) n FROM items i WHERE i.show_title = ? AND i.kind = 'episode' AND ${S}`).get(r.show_title).n;
      return { key: `s:${r.show_title}`, type: "show", title: r.show_title, live: c > 0, eps: c, n };
    }
    const it = db.prepare(`SELECT i.id, i.title, i.year, i.kind, i.duration_ms, i.source, i.show_title, i.season, i.episode, (${S}) ok FROM items i WHERE i.id = ?`).get(r.item_id);
    return { key: `i:${r.item_id}`, type: "item", id: r.item_id, title: it?.title ?? `(missing item ${r.item_id})`, year: it?.year ?? null, minutes: it?.duration_ms ? Math.round(it.duration_ms / 60000) : null,
      source: it?.source ?? null, ep: it?.kind === "episode" ? `${it.show_title} S${it.season}E${it.episode}` : null, live: !!it?.ok, n };
  });
  return { ...b, members, editable: b.source === "claude" };
}

function search(q, kind) {
  const db = getDb();
  const like = `%${String(q).replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const homes = (sql, ...a) => db.prepare(sql).all(...a).map((r) => r.name);
  if (kind === "show") {
    return db.prepare(`SELECT i.show_title t, COUNT(*) n FROM items i WHERE i.kind = 'episode' AND ${S} AND i.show_title LIKE ? ESCAPE '\\' GROUP BY i.show_title ORDER BY i.show_title LIMIT 40`).all(like)
      .map((r) => ({ type: "show", title: r.t, eps: r.n, in: homes("SELECT b.name FROM bucket_members m JOIN buckets b ON b.id = m.bucket_id WHERE m.show_title = ? AND NOT b.retired AND b.source = 'claude' ORDER BY b.name", r.t) }));
  }
  return db.prepare(`SELECT i.id, i.title, i.year, i.duration_ms d FROM items i WHERE i.kind = 'movie' AND ${S} AND i.title LIKE ? ESCAPE '\\' ORDER BY i.title LIMIT 40`).all(like)
    .map((r) => ({ type: "item", id: r.id, title: r.title, year: r.year, minutes: r.d ? Math.round(r.d / 60000) : null,
      in: homes("SELECT b.name FROM bucket_members m JOIN buckets b ON b.id = m.bucket_id WHERE m.item_id = ? AND NOT b.retired AND b.source = 'claude' ORDER BY b.name", r.id) }));
}

function addMembers(id, body) {
  const b = editable(bucket(id));
  const shows = (body.shows || []).map(String), items = (body.items || []).map(Number);
  if (shows.length && isMovieFormat(b.format)) bad(`Shows can't go in a ${b.format} bucket.`);
  if (items.length && !isMovieFormat(b.format)) bad(`Movies can't go in a ${b.format} bucket.`);
  const db = getDb();
  for (const t of shows) if (!db.prepare(`SELECT 1 FROM items i WHERE i.show_title = ? AND i.kind = 'episode' AND ${S} LIMIT 1`).get(t)) bad(`No schedulable show "${t}".`);
  for (const n of items) if (!db.prepare(`SELECT 1 FROM items i WHERE i.id = ? AND i.kind = 'movie' AND ${S}`).get(n)) bad(`${n} isn't a schedulable movie.`);
  backup();
  tx(() => {
    let p = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 p FROM bucket_members WHERE bucket_id = ?").get(id).p;
    const has = db.prepare("SELECT 1 FROM bucket_members WHERE bucket_id = ? AND (show_title = ? OR item_id = ?)");
    const put = db.prepare("INSERT INTO bucket_members (bucket_id, show_title, item_id, position) VALUES (?, ?, ?, ?)");
    for (const t of shows) if (!has.get(id, t, -1)) put.run(id, t, null, p++);
    for (const n of items) if (!has.get(id, "", n)) put.run(id, null, n, p++);
    touched();
  });
}

function removeMembers(id, keys) {
  editable(bucket(id));
  backup();
  const db = getDb();
  tx(() => {
    for (const k of keys || []) {
      if (k.startsWith("s:")) db.prepare("DELETE FROM bucket_members WHERE bucket_id = ? AND show_title = ?").run(id, k.slice(2));
      else if (k.startsWith("i:")) db.prepare("DELETE FROM bucket_members WHERE bucket_id = ? AND item_id = ?").run(id, Number(k.slice(2)));
    }
    touched();
  });
}

function reorder(id, keys) {
  editable(bucket(id));
  const db = getDb();
  const rows = db.prepare("SELECT rowid r, show_title, item_id FROM bucket_members WHERE bucket_id = ?").all(id);
  const byKey = new Map(rows.map((r) => [r.show_title ? `s:${r.show_title}` : `i:${r.item_id}`, r.r]));
  if ((keys || []).length !== rows.length || keys.some((k) => !byKey.has(k))) bad("The order doesn't match the bucket's members; reload and try again.");
  backup();
  tx(() => { keys.forEach((k, n) => db.prepare("UPDATE bucket_members SET position = ? WHERE rowid = ?").run(n, byKey.get(k))); touched(); });
}

function saveMeta(id, body) {
  const b = editable(bucket(id));
  const m = checkMeta(body, { id });
  backup();
  getDb().prepare("UPDATE buckets SET name = ?, about = ?, dayparts = ?, active_from = ?, active_to = ? WHERE id = ?")
    .run(m.name, m.about, JSON.stringify(m.dayparts), m.from, m.to, id);
  touched();
  return m.name !== b.name ? `Renamed. programming.yaml and config.yaml refer to buckets by name: update "${b.name}" there if it's in a pool or standing slot.` : null;
}

function create(body) {
  const m = checkMeta(body, { format: body.format });
  backup();
  const id = getDb().prepare("INSERT INTO buckets (name, about, format, dayparts, active_from, active_to, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'claude', ?)")
    .run(m.name, m.about, body.format, JSON.stringify(m.dayparts), m.from, m.to, new Date().toISOString()).lastInsertRowid;
  touched();
  return { id: Number(id) };
}

function retire(id) {
  editable(bucket(id));
  backup();
  getDb().prepare("UPDATE buckets SET retired = 1 WHERE id = ?").run(id);
  touched();
}

async function refill() {
  const { generateSchedule } = await import("./schedule/generate.js");
  await generateSchedule({ days: 7, replace: true });
}

export function startEditor({ port = 5174 } = {}) {
  const token = randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    try {
      if (req.method === "GET" && url.pathname === "/") return send(200, readFileSync(PAGE, "utf8").replace("__TOKEN__", token), "text/html");
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });
      if (req.headers["x-token"] !== token) return send(403, { error: "bad token (reload the page)" });
      let body = {};
      if (req.method !== "GET") { let s = ""; for await (const c of req) s += c; body = s ? JSON.parse(s) : {}; }
      const seg = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
      const id = Number(seg[1]);
      if (req.method === "GET" && seg[0] === "buckets") return send(200, list());
      if (req.method === "GET" && seg[0] === "info") return send(200, info());
      if (req.method === "GET" && seg[0] === "bucket") return send(200, detail(id));
      if (req.method === "GET" && seg[0] === "search") return send(200, search(url.searchParams.get("q") || "", url.searchParams.get("kind")));
      if (req.method === "POST" && seg[0] === "bucket" && !seg[1]) return send(200, create(body));
      if (req.method === "POST" && seg[0] === "bucket") {
        if (seg[2] === "add") addMembers(id, body);
        else if (seg[2] === "remove") removeMembers(id, body.keys);
        else if (seg[2] === "order") reorder(id, body.keys);
        else if (seg[2] === "meta") return send(200, { note: saveMeta(id, body) });
        else if (seg[2] === "retire") retire(id);
        else return send(404, { error: "not found" });
        return send(200, { ok: true });
      }
      if (req.method === "POST" && seg[0] === "refill") { await refill(); return send(200, { ok: true }); }
      return send(404, { error: "not found" });
    } catch (e) {
      send(e instanceof Bad ? 400 : 500, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${port}/` }));
  });
}
