// Sorting loose commercials and eyecatches into folders. A video dropped in a drop thread (or
// added with /tvadmin add) lands loose in <folder>\youtube or <folder>\uploads, and a loose file
// is its own "group" when breaks are filled (player/segments.js groupOf), so it comes up far more
// often than a file inside a brand folder. Each sync, before the folders are scanned:
//   commercials: a title that names an existing brand folder ("Kellogg's Pop Tarts" -> Pop-Tarts)
//                goes there at once; everything else goes to the staging folder (brand_sort.
//                staging_folder), which is ONE brand to the picker, so it stays in rotation without
//                crowding out the rest. In the background, a local Ollama model then reads each
//                staged title (an existing brand, or a new brand the title itself names) and, if
//                that fails, looks at a few frames (existing brands only), and files it.
//   eyecatches:  the series is the title minus "eyecatch", "widescreen", "HD", numbers...
//                ("Azumanga Daioh Eye Catch" -> the Azumanga Daioh folder, made if it's new).
// Moving a file keeps its catalog row (play count, tags) and its tags.csv row.
import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, basename, extname, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { claudeClient, underCeiling } from "../claude.js";
import { config, secrets, DATA_DIR } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";

const run = promisify(execFile);
const VIDEO = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".mpg", ".mpeg", ".ts", ".webm", ".flv"]);
const TRANSIT = ["youtube", "uploads"]; // where drops land
const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const settings = () => config.brand_sort;
const KINDS = {
  commercial: { root: () => config.local.commercials, csv: true },
  eyecatch: { root: () => config.local.eyecatches, csv: false },
  clip: { root: () => config.local.clips, csv: true }, // folders are games
};
const rootOf = (kind) => KINDS[kind].root();
const stagingName = () => settings().staging_folder || "_staging";
const stagingDir = (kind) => join(rootOf(kind), stagingName());

// localScan.js sets this while it walks the folders: a file moved in the middle of a walk would
// be marked "gone" when the walk ends, so the background pass waits for the walk to finish.
export const scanState = { running: false };

// ---------- matching ----------
const tokens = (s) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/&/g, " and ").replace(/['\u2019]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
// "Kellogg_s Pop Tarts - Printed Fun 2007 USA [ssi hCU37pM].mp4" -> the part a person wrote.
const titleOf = (file) => basename(file, extname(file)).replace(/\s*\[[^\]]*\]\s*$/, "").replace(/_/g, " ").trim();
const folderName = (s) => String(s).replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 40);

// The brand/series folders: every folder in the kind's root and in its youtube\ except the drop
// and staging folders, packs of many different ads (variety_folders) and hidden ones.
export function brandFolders(kind = "commercial") {
  const r = rootOf(kind), found = new Map();
  if (!r || !existsSync(r)) return [];
  // Packs of different ads and ordered sagas (which play one file at a time, in order) aren't places to file things.
  const variety = new Set([...(config.broadcast.variety_folders || []), ...(config.broadcast.ordered_folders || [])].map((f) => String(f).toLowerCase()));
  const reserved = new Set([...TRANSIT, stagingName().toLowerCase()]);
  for (const base of [r, join(r, "youtube")]) {
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      const n = e.name.toLowerCase();
      if (!e.isDirectory() || n.startsWith(".") || n.startsWith("_") || variety.has(n) || (base === r && reserved.has(n))) continue;
      if (!found.has(n)) found.set(n, { name: e.name, dir: join(base, e.name) });
    }
  }
  return [...found.values()];
}

// The longest folder whose words appear, in order, in the title (or, for names of six letters
// or more, whose letters run together in it: "poptarts" in "kelloggspoptarts").
export function matchBrand(title, brands) {
  const t = tokens(title), joined = t.join("");
  let best = null;
  for (const b of brands) {
    const bt = tokens(b.name);
    if (!bt.length) continue;
    const squashed = bt.join("");
    let hit = false;
    for (let i = 0; i + bt.length <= t.length && !hit; i++) hit = bt.every((w, j) => t[i + j] === w);
    if (!hit && squashed.length >= 6) hit = joined.includes(squashed);
    if (hit && (!best || squashed.length > best.len)) best = { brand: b, len: squashed.length };
  }
  return best?.brand ?? null;
}

// Eyecatch title -> series name: "Azumanga Daioh Eye Catch", "FMAB Eyecatch 019", "Dragon Ball
// Eyecatcher Widescreen" -> "Azumanga Daioh", "FMAB", "Dragon Ball". "" when nothing is left.
export function seriesOf(title) {
  const first = String(title).split(/\s+[\/|]\s+|\s+-\s+(?=.*eye ?catch)/i)[0];
  const s = first.replace(/\b(eye ?catch(?:er|es|ers)?|bumpers?|widescreen|remaster(?:ed)?|upscaled?|hd|4k|1080p|720p|uhd|part|ep(?:isode)?|compilation)\b/gi, " ")
    .replace(/[#(\[]?\b\d{1,3}\b[)\]]?/g, " ").replace(/[-:_]+/g, " ");
  const name = folderName(s);
  return /[a-z]{3,}/i.test(name) ? name : "";
}

// ---------- Ollama ----------
const ollamaState = { downUntil: 0 };
async function chat(model, messages, timeoutMs) {
  if (Date.now() < ollamaState.downUntil) throw Object.assign(new Error("Ollama isn't answering (skipped for a few minutes)"), { infra: true });
  let res;
  try {
    res = await fetch(`${settings().ollama_url.replace(/\/$/, "")}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, messages, stream: false, format: "json", options: { temperature: 0 } }),
    });
  } catch (e) {
    ollamaState.downUntil = Date.now() + 10 * 60000;
    throw Object.assign(new Error(`Ollama isn't answering at ${settings().ollama_url} (${e.cause?.code || e.name})`), { infra: true });
  }
  if (!res.ok) throw Object.assign(new Error(`Ollama ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`), { infra: true });
  try { return JSON.parse((await res.json()).message?.content || "{}"); } catch { return {}; }
}

const listText = (brands) => brands.map((b) => `- ${b.name}`).join("\n");
const byName = (brands, name) => brands.find((b) => b.name.toLowerCase() === String(name ?? "").trim().toLowerCase()) ?? null;

// Title -> an existing brand folder, or a new brand the title itself names, or neither.
async function askText(title, brands) {
  const out = await chat(settings().model, [
    { role: "system", content: "You file TV commercials into brand folders, going by the video's title." },
    { role: "user", content: `Brand folders:\n${listText(brands)}\n\nVideo title: "${title}"\n\n` +
      'Reply with JSON: {"brand": <the exact name of the folder this ad belongs in, or null>, ' +
      '"new_brand": <the advertised brand\'s name if the title clearly names it and no folder fits, else null>}. ' +
      "If the title neither says nor clearly implies the brand, use null for both." },
  ], 240000);
  const brand = byName(brands, out.brand);
  if (brand) return { brand };
  // A new brand must be in the title's own words (a small model will make things up otherwise).
  const nb = folderName(out.new_brand || "");
  const t = tokens(title).join(" "), n = tokens(nb);
  if (nb.length >= 3 && n.length && ` ${t} `.includes(` ${n.join(" ")} `) && !byName(brands, nb)) return { newBrand: nb };
  return {};
}

// A few frames -> an existing brand folder, or nothing.
async function askVision(file, brands) {
  const images = [];
  for (const at of [1, 4, 9]) {
    try {
      const { stdout } = await run(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", file, "-frames:v", "1",
        "-vf", "scale=640:-2", "-c:v", "mjpeg", "-f", "image2", "pipe:1"], { encoding: "buffer", maxBuffer: 8 << 20, timeout: 60000 });
      if (stdout.length) images.push(stdout.toString("base64"));
    } catch { /* shorter than that: fine */ }
  }
  if (!images.length) return null;
  const out = await chat(settings().vision_model, [{
    role: "user", images,
    content: `These are frames from a TV commercial. Which brand's folder does it belong in?\n${listText(brands)}\n\n` +
      'Reply with JSON: {"brand": <the exact folder name, only if a logo, product or packaging makes it clear, else null>}.',
  }], 480000);
  return byName(brands, out.brand);
}

// ---------- Claude, looking at a few frames ----------
const FFPROBE = () => process.env.FFPROBE_PATH || "ffprobe";
const claudeRun = { n: 0 }; // calls in this pass, against brand_sort.max_claude_per_run
const claudeOn = () => !!(settings().claude_vision && secrets.anthropicKey && underCeiling());

async function frames(file, count = 5) {
  let dur = 0;
  try { dur = Number((await run(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 30000 })).stdout) || 0; } catch { /* guess */ }
  if (!(dur > 0.5)) dur = 3;
  const out = [];
  for (let i = 0; i < count; i++) {
    try {
      const { stdout } = await run(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-ss", ((dur * (i + 0.5)) / count).toFixed(2), "-i", file, "-frames:v", "1",
        "-vf", "scale=768:-2", "-q:v", "4", "-c:v", "mjpeg", "-f", "image2", "pipe:1"], { encoding: "buffer", maxBuffer: 8 << 20, timeout: 60000 });
      if (stdout.length) out.push(stdout.toString("base64"));
    } catch { /* skip this frame */ }
  }
  return out;
}

const ASK = {
  commercial: (list) => `These are frames from a TV commercial. Which brand does it advertise? Existing brand folders:\n${list}`,
  clip: (list) => `These are frames from a short video clip, most likely gameplay or a stream clip from a video game (it could also be a meme or a TV/movie moment). Existing folders (usually one per game):\n${list}`,
  eyecatch: (list) => `These are frames from an eyecatch: a few-second bumper shown between segments of a TV show, usually anime. Which series is it from? Existing folders (one per series):\n${list}`,
};

// An existing folder, a new one (only when Claude is sure), or nothing.
async function askClaude(kind, file, brands) {
  const max = Number(settings().max_claude_per_run) || 30;
  if (claudeRun.n >= max) throw Object.assign(new Error(`stopping after ${max} Claude calls this pass; the rest wait for the next one`), { infra: true });
  const imgs = await frames(file);
  if (!imgs.length) return {};
  if (!underCeiling()) throw Object.assign(new Error("this month's Claude ceiling for filing is used up"), { infra: true });
  claudeRun.n++;
  let text;
  try {
    const msg = await claudeClient("brandsort").messages.create({
      model: settings().claude_model || config.claude.model, max_tokens: 300,
      messages: [{ role: "user", content: [
        ...imgs.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
        { type: "text", text: `${ASK[kind](listText(brands))}\n\nReply with JSON only: {"folder": <the exact name of an existing folder it belongs in, or null>, "new_folder": <its name, if you can read or recognise it and no existing folder fits, else null>, "confidence": "high" | "medium" | "low", "why": <a few words>}.` },
      ] }],
    });
    text = msg.content.map((c) => c.text || "").join("");
  } catch (e) {
    throw Object.assign(new Error(`Claude: ${e.message}`), { infra: true });
  }
  let out = {};
  try { out = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch { /* unreadable reply: no answer */ }
  const brand = byName(brands, out.folder);
  if (brand && out.confidence !== "low") return { brand };
  let nb = folderName(out.new_folder || "");
  if (nb && nb === nb.toLowerCase()) nb = nb.replace(/\b[a-z]/g, (c) => c.toUpperCase()); // "fortnite" -> "Fortnite"
  if (nb.length >= 2 && out.confidence === "high" && !byName(brands, nb)) return { newBrand: nb };
  return {};
}

// Commercial -> { brand|newBrand, via }, or null. Name match only unless `deep`.
async function classifyCommercial(file, brands, deep) {
  const title = titleOf(file), s = settings();
  const hit = matchBrand(title, brands);
  if (hit) return { brand: hit, via: "name" };
  if (!deep) return null;
  // Claude, looking at frames, is far more reliable than a small local model guessing from a
  // title that may say nothing ("blood_stalk" -> a made-up brand folder), so it goes first;
  // Ollama (title, then frames) is the fallback when there is no API key.
  if (claudeOn()) {
    const r = await askClaude("commercial", file, brands);
    return r.brand || r.newBrand ? { ...r, via: "Claude" } : null;
  }
  if (s.model && tokens(title).some((w) => /^[a-z]{3,}$/.test(w))) {
    const r = await askText(title, brands);
    if (r.brand || r.newBrand) return { ...r, via: s.model };
  }
  if (s.vision_model) {
    const b = await askVision(file, brands);
    if (b) return { brand: b, via: s.vision_model };
  }
  return null;
}
// Clip -> its game folder (made if Claude recognises a new game), or null.
async function classifyClip(file, brands, deep) {
  const hit = matchBrand(titleOf(file), brands);
  if (hit) return { brand: hit, via: "name" };
  if (!deep || !claudeOn()) return null;
  const r = await askClaude("clip", file, brands);
  return r.brand || r.newBrand ? { ...r, via: "Claude" } : null;
}

// Eyecatch -> its series folder (made if new), or null. A title that says nothing ("clip 3") is
// a job for Claude, in the deep pass.
async function classifyEyecatch(file, brands, deep) {
  const title = titleOf(file);
  const hit = matchBrand(title, brands);
  if (hit) return { brand: hit, via: "name" };
  const series = seriesOf(title);
  if (series) return { newBrand: series, via: "title" };
  if (deep && claudeOn()) {
    const r = await askClaude("eyecatch", file, brands);
    if (r.brand || r.newBrand) return { ...r, via: "Claude" };
  }
  return null;
}

// ---------- moving, keeping the catalog and tags.csv in step ----------
function retargetCsv(kind, pairs) {
  const r = rootOf(kind), file = join(r, "tags.csv");
  if (!KINDS[kind].csv || !pairs.length || !existsSync(file)) return;
  const rows = parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""), { columns: (h) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, relax_column_count: true });
  const map = new Map(pairs.map(([a, b]) => [relative(r, a).toLowerCase(), relative(r, b)]));
  let n = 0;
  for (const row of rows) {
    const to = map.get(String(row.filename || "").trim().toLowerCase());
    if (to) { row.filename = to; n++; }
  }
  if (!n) return;
  rows.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
  try {
    writeFileSync(file, "\uFEFF" + stringify(rows, { header: true, columns: ["filename", "decade", "holiday", "notes"] }));
  } catch (e) {
    log.warn(`brands: couldn't update ${file} (${e.code}); is it open in Excel? Its rows for ${n} moved file(s) will come back blank.`);
  }
}

function moveFile(from, to) {
  mkdirSync(join(to, ".."), { recursive: true });
  if (existsSync(to)) throw new Error(`${to} already exists`);
  renameSync(from, to);
  getDb().prepare("UPDATE items SET source_key = ? WHERE source = 'local' AND source_key = ?").run(to, from);
}

// Video files directly in <root>, <root>\youtube and <root>\uploads (and optionally staging).
function looseFiles(kind, includeStaging) {
  const r = rootOf(kind), dirs = [r, ...TRANSIT.map((t) => join(r, t)), ...(includeStaging ? [stagingDir(kind)] : [])];
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && VIDEO.has(extname(e.name).toLowerCase())) out.push(join(dir, e.name));
    }
  }
  return out;
}

function destFor(kind, c) {
  return c?.brand ? c.brand.dir : c?.newBrand ? join(rootOf(kind), c.newBrand) : stagingDir(kind);
}

// The quick pass (every sync): file what can be filed without asking a model; stage the rest.
// dryRun: only report. -> [{ file, to, via }]
export async function sortLoose({ kind = "commercial", dryRun = false, deep = false, includeStaging = false } = {}) {
  const r = rootOf(kind);
  if (!r || !existsSync(r) || (!settings().enabled && !dryRun)) return [];
  const files = looseFiles(kind, includeStaging || deep);
  if (!files.length) return [];
  claudeRun.n = 0;
  const brands = brandFolders(kind);
  const results = [], moved = [];
  for (const file of files) {
    let c = null, failed = false;
    try {
      c = await (kind === "eyecatch" ? classifyEyecatch : kind === "clip" ? classifyClip : classifyCommercial)(file, brands, deep);
    } catch (e) {
      failed = true;
      log.warn(`brands: ${basename(file)}: ${e.message}`);
    }
    const dir = destFor(kind, c), to = join(dir, basename(file));
    if (to.toLowerCase() === file.toLowerCase()) continue; // staged and still unmatched
    results.push({ file, to: dir, via: c ? `${c.newBrand ? "new folder via " : ""}${c.via}` : failed ? "Ollama failed: staged" : "no match: staged" });
    if (dryRun) continue;
    try {
      moveFile(file, to);
      moved.push([file, to]);
      if (c?.newBrand) brands.push({ name: c.newBrand, dir });
      log.info(`brands: ${kind} ${basename(file)} -> ${relative(r, dir)} (${c ? c.via : "staged"})`);
    } catch (e) {
      log.warn(`brands: couldn't move ${basename(file)}: ${e.message}`);
    }
  }
  retargetCsv(kind, moved);
  return results;
}

// The slow pass, in the background after a sync: a model looks at each staged file (commercials:
// Ollama on the title, then Claude on a few frames; clips and untitled eyecatches: Claude).
// Files it couldn't place stay staged and aren't asked about again for a day; a failure to reach
// a model doesn't count (they're tried again next sync).
const TRIED = () => join(DATA_DIR, "brandsort-tried.json");
const readTried = () => { try { return JSON.parse(readFileSync(TRIED(), "utf8")); } catch { return {}; } };
let refining = false;
export async function refineStaging() {
  const s = settings();
  if (refining || !s.enabled) return;
  refining = true;
  try {
    const tried = readTried(), now = Date.now();
    claudeRun.n = 0;
    let stop = false;
    for (const kind of Object.keys(KINDS)) {
      const r = rootOf(kind), stage = stagingDir(kind) + sep;
      if (stop || !r || !existsSync(stagingDir(kind))) continue;
      if (kind === "commercial" ? !(s.model || s.vision_model || claudeOn()) : !claudeOn()) continue;
      const files = looseFiles(kind, true).filter((f) => f.startsWith(stage) && now - (tried[f] || 0) > 86400000);
      if (!files.length) continue;
      log.info(`brands: looking at ${files.length} staged ${kind}(s)`);
      const moved = [];
      for (const file of files) {
        let c = null;
        try {
          c = await (kind === "eyecatch" ? classifyEyecatch : kind === "clip" ? classifyClip : classifyCommercial)(file, brandFolders(kind), true);
        } catch (e) {
          log.warn(`brands: ${basename(file)}: ${e.message}`);
          if (e.infra) { stop = true; break; } // a model isn't answering: try again next sync
          continue;
        }
        tried[file] = Date.now();
        if (!c) continue;
        while (scanState.running) await new Promise((res) => setTimeout(res, 2000)); // never move files mid-walk
        const dir = destFor(kind, c), to = join(dir, basename(file));
        try {
          moveFile(file, to);
          moved.push([file, to]);
          delete tried[file];
          log.info(`brands: ${kind} ${basename(file)} -> ${relative(r, dir)} (${c.via})`);
        } catch (e) { log.warn(`brands: couldn't move ${basename(file)}: ${e.message}`); }
      }
      retargetCsv(kind, moved);
    }
    try { writeFileSync(TRIED(), JSON.stringify(tried)); } catch { /* fine */ }
  } finally {
    refining = false;
  }
}
// ---------- one-time: brand folders out of commercials\youtube ----------
function moveFolder(kind, from, to) {
  const rows = getDb().prepare("SELECT id, source_key FROM items WHERE source = 'local' AND kind = ?").all(kind);
  const prefix = from.toLowerCase() + sep;
  const mine = rows.filter((r) => r.source_key.toLowerCase().startsWith(prefix));
  renameSync(from, to); // throws if a file in it is playing right now: nothing has changed yet
  const pairs = [];
  tx((d) => {
    const set = d.prepare("UPDATE items SET source_key = ? WHERE id = ?");
    for (const r of mine) {
      const next = to + r.source_key.slice(from.length);
      set.run(next, r.id);
      pairs.push([r.source_key, next]);
    }
  });
  retargetCsv(kind, pairs);
  return mine.length;
}

export function migrateYoutubeFolders({ kind = "commercial", dryRun = true } = {}) {
  const r = rootOf(kind), yt = join(r, "youtube");
  if (!existsSync(yt)) return [];
  const reserved = new Set([...TRANSIT, stagingName().toLowerCase()]);
  const plan = [];
  for (const e of readdirSync(yt, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const from = join(yt, e.name), to = join(r, e.name);
    plan.push({ from, to, skip: reserved.has(e.name.toLowerCase()) ? "reserved name" : existsSync(to) ? "a folder with that name is already there" : null });
  }
  if (dryRun) return plan;
  const done = [];
  for (const p of plan) {
    if (p.skip) continue;
    try { p.files = moveFolder(kind, p.from, p.to); done.push({ kind, from: p.from, to: p.to }); } catch (e) { p.skip = `couldn't move it (${e.code || e.message})`; }
  }
  if (done.length) {
    mkdirSync(DATA_DIR, { recursive: true });
    const manifest = join(DATA_DIR, `brand-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(manifest, JSON.stringify(done, null, 1));
    log.info(`brands: moved ${done.length} folders out of youtube\\ (undo list: ${manifest})`);
    plan.manifest = manifest;
  }
  return plan;
}

// Put the folders from a migration manifest back where they were.
export function undoMigration(manifest) {
  const out = [];
  for (const m of JSON.parse(readFileSync(manifest, "utf8"))) {
    try { out.push({ ...m, files: moveFolder(m.kind || "commercial", m.to, m.from) }); } catch (e) { out.push({ ...m, error: e.code || e.message }); }
  }
  return out;
}