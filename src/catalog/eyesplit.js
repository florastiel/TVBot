// Eyecatches that are really several: a video of two eyecatches back to back (a "both
// eyecatches" upload, a compilation of a few). An eyecatch is a few seconds, so any longer than
// brand_sort.split_min_seconds is checked:
//   1. ffmpeg finds candidate boundaries: a gap of silence, a black frame, a hard picture cut.
//   2. Claude looks at frames just before and after each candidate (plus a few across the video)
//      and says which are real boundaries between separate eyecatches. Without Claude, only a
//      cut that has BOTH a picture cut and a silence/black frame at the same moment is trusted.
//   3. The video is cut into pieces (dead air at the cut is dropped), saved next to the
//      original as "<name> - part N [id].mp4", and the original is moved to
//      data\eyecatch-originals. A file isn't looked at twice (data\eyesplit-checked.json).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, dirname, basename, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { claudeClient, underCeiling } from "../claude.js";
import { config, secrets, DATA_DIR } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";

const run = promisify(execFile);
const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const settings = () => config.brand_sort;
const CHECKED = () => join(DATA_DIR, "eyesplit-checked.json");
const ORIGINALS = () => join(DATA_DIR, "eyecatch-originals");
const MIN_PIECE = 2; // seconds: nothing shorter is an eyecatch
const EDGE = 1.2; // a boundary this close to either end is just a fade in/out

const readChecked = () => { try { return JSON.parse(readFileSync(CHECKED(), "utf8")); } catch { return {}; } };
// Already cut by hand (timestamps in the name) or by this module.
const alreadyCut = (file) => /\(\d+m\d+s-\d+m\d+s\)|\s-\sparts?\s\d/i.test(basename(file));

// ---------- 1. candidates ----------
export async function findCandidates(file, dur) {
  let err = "";
  try {
    // blackdetect passes every frame on, so the scene select after it still sees them all.
    const r = await run(FFMPEG(), ["-hide_banner", "-nostats", "-threads", "2", "-i", file,
      "-vf", "blackdetect=d=0.04:pix_th=0.12,select='gt(scene,0.3)',showinfo",
      "-af", "silencedetect=noise=-35dB:d=0.2", "-f", "null", "-"], { maxBuffer: 32 << 20, timeout: 120000 });
    err = r.stderr;
  } catch (e) { err = e.stderr || ""; }
  const num = (s) => Number(s);
  const cuts = [...err.matchAll(/pts_time:([\d.]+)/g)].map((m) => num(m[1]));
  const black = [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [num(m[1]), num(m[2])]);
  const silence = [];
  let open = null;
  for (const m of err.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    if (m[1] === "start") open = num(m[2]);
    else if (open !== null) { silence.push([open, num(m[2])]); open = null; }
  }
  if (open !== null) silence.push([open, dur]);
  const inside = ([a, b]) => b > EDGE && a < dur - EDGE;
  // One candidate per event: [from, to] is the span the cut can sit in.
  const cand = [
    ...silence.filter(inside).map(([a, b]) => ({ kind: "silence", from: Math.max(a, EDGE), to: Math.min(b, dur - EDGE), a, b })),
    ...black.filter(inside).map(([a, b]) => ({ kind: "black", from: a, to: b, a, b })),
    ...cuts.filter((t) => t > EDGE && t < dur - EDGE).map((t) => ({ kind: "cut", from: t, to: t, a: t, b: t })),
  ].sort((x, y) => x.from - y.from);
  // Candidates within half a second of each other are the same moment.
  const merged = [];
  for (const c of cand) {
    const last = merged.at(-1);
    if (last && c.from - last.to < 0.5) {
      last.kinds.push(c.kind); last.to = Math.max(last.to, c.to);
      if (c.kind === "cut") last.cutAt = c.from;
      if (c.kind === "silence") { last.gap = [c.a, c.b]; }
    } else {
      merged.push({ from: c.from, to: c.to, kinds: [c.kind], cutAt: c.kind === "cut" ? c.from : null, gap: c.kind === "silence" ? [c.a, c.b] : null });
    }
  }
  return merged.map((m) => ({ ...m, at: m.cutAt ?? (m.from + m.to) / 2 }));
}

// ---------- 2. who decides ----------
async function frameAt(file, t) {
  try {
    const { stdout } = await run(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-ss", Math.max(0, t).toFixed(2), "-i", file, "-frames:v", "1",
      "-vf", "scale=640:-2", "-q:v", "4", "-c:v", "mjpeg", "-f", "image2", "pipe:1"], { encoding: "buffer", maxBuffer: 8 << 20, timeout: 60000 });
    return stdout.length ? stdout.toString("base64") : null;
  } catch { return null; }
}

const claudeRun = { n: 0 };
export const claudeOn = () => !!(settings().claude_vision && secrets.anthropicKey && underCeiling());

async function askClaude(file, dur, cands, what = "eyecatch") {
  const max = claudeRun.max || Number(settings().max_claude_per_run) || 30;
  if (claudeRun.n >= max) throw Object.assign(new Error(`stopping after ${max} Claude calls this pass`), { infra: true });
  const commercial = what === "commercial";
  const content = [{ type: "text", text: commercial
    ? `This is a ${dur.toFixed(1)} second video that is probably several different TV commercials joined back to back (a compilation or reel). Below are frames from across the video and from just before and just after each candidate cut point.`
    : `This is a ${dur.toFixed(1)} second video that is supposed to be ONE eyecatch (a few-second bumper shown between segments of a TV show), but it may be several eyecatches joined back to back (for example the same show's two different eyecatches, or a compilation). Below are frames from across the video and from just before and just after each candidate cut point.` }];
  for (const t of [0.4, dur / 2, dur - 0.4]) {
    const img = await frameAt(file, t);
    if (img) content.push({ type: "text", text: `Frame at ${t.toFixed(1)}s:` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } });
  }
  for (const [i, c] of cands.entries()) {
    const [b, a] = [await frameAt(file, c.at - 0.35), await frameAt(file, c.at + 0.35)];
    content.push({ type: "text", text: `Candidate ${i + 1} at ${c.at.toFixed(2)}s (can sit anywhere in ${c.from.toFixed(2)}-${c.to.toFixed(2)}s; evidence: ${c.kinds.join(" + ")}). Just before, then just after:` });
    for (const img of [b, a]) if (img) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } });
  }
  content.push({ type: "text", text: (commercial ? 'Which candidates are real boundaries between two SEPARATE commercials (a different ad starts: new scene, product or brand), and which are just a pause inside one commercial (a fade before its end card or tagline)? ' : 'Which candidates are real boundaries between two SEPARATE eyecatches (a different animation or title card starts; the jingle restarts), and which are just a moment inside one eyecatch (a scene change, a fade, a quiet beat)? ') + 'Reply with JSON only: {"cuts": [<seconds of each real boundary, inside its candidate\'s range>], "confidence": "high" | "medium" | "low", "why": <a few words>}. Use an empty list if it is one ' + what + '.' });
  if (!underCeiling()) throw Object.assign(new Error("this month's Claude ceiling for filing is used up"), { infra: true });
  claudeRun.n++;
  let text;
  try {
    const msg = await claudeClient("eyesplit").messages.create({
      model: settings().claude_model || config.claude.model, max_tokens: 300, messages: [{ role: "user", content }],
    });
    text = msg.content.map((c) => c.text || "").join("");
  } catch (e) {
    throw Object.assign(new Error(`Claude: ${e.message}`), { infra: true });
  }
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch { return {}; }
}

// -> { cuts: [seconds], via, why } ; cuts [] = one eyecatch ; null = couldn't tell (look again later)
async function decide(file, dur, cands, what = "eyecatch") {
  if (!cands.length) return { cuts: [], via: "no candidate boundary", sure: true };
  if (claudeOn()) {
    const r = await askClaude(file, dur, cands, what);
    const cuts = (Array.isArray(r.cuts) ? r.cuts : []).map(Number).filter((t) => Number.isFinite(t))
      .map((t) => { const c = cands.find((c) => t >= c.from - 0.6 && t <= c.to + 0.6); return c ? { t: Math.min(Math.max(t, c.from), c.to), c } : null; }).filter(Boolean);
    if (!cuts.length) return { cuts: [], via: `Claude: one ${what}`, why: r.why, sure: r.confidence !== "low" };
    if (r.confidence === "low") return { cuts: [], via: "Claude unsure: left as is", why: r.why, sure: true };
    return { cuts: cuts.map((x) => x.t), gaps: cuts.map((x) => x.c.gap), via: "Claude", why: r.why, sure: true };
  }
  // No Claude: trust only a picture cut that lands on silence or black.
  const strong = cands.filter((c) => c.kinds.includes("cut") && (c.kinds.includes("silence") || c.kinds.includes("black")));
  return { cuts: strong.map((c) => c.cutAt), gaps: strong.map((c) => c.gap), via: "cut + silence/black", sure: true };
}

// ---------- 3. cutting ----------
// Pieces [start, end] from the cut times; dead air in a long silence at a cut is dropped.
export function piecesFor(dur, cuts, gaps = [], minLen = MIN_PIECE) {
  const bounds = [];
  let from = 0;
  const sorted = cuts.map((t, i) => ({ t, gap: gaps[i] })).sort((a, b) => a.t - b.t);
  for (const { t, gap } of sorted) {
    const long = gap && gap[1] - gap[0] > 0.5;
    bounds.push([from, long ? Math.min(t, gap[0] + 0.2) : t]);
    from = long ? Math.max(t, gap[1] - 0.2) : t;
  }
  bounds.push([from, dur]);
  return bounds.filter(([a, b]) => b - a >= minLen);
}

async function writePiece(file, out, start, end) {
  await run(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-ss", start.toFixed(3), "-i", file, "-t", (end - start).toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", out],
  { maxBuffer: 16 << 20, timeout: 5 * 60000 });
}

// Cut one file into pieces next to it and move the original to data\eyecatch-originals.
async function splitFile(file, pieces, root, originals = ORIGINALS()) {
  const ext = extname(file), base = basename(file, ext), tag = base.match(/\s*(\[[^\]]*\])$/);
  const stem = tag ? base.slice(0, tag.index) : base;
  const outs = pieces.map((_, i) => join(dirname(file), `${stem} - part ${i + 1}${tag ? " " + tag[1] : ""}.mp4`));
  if (outs.some((o) => existsSync(o))) throw new Error("a part file with that name already exists");
  const parts = outs.map((o) => o + ".part"); // not a video extension: the folder scan ignores it
  try {
    for (const [i, [a, b]] of pieces.entries()) await writePiece(file, parts[i], a, b);
    const keep = join(originals, relative(root, file));
    mkdirSync(dirname(keep), { recursive: true });
    renameSync(file, keep); // throws if it's playing right now: then nothing is changed
    parts.forEach((p, i) => renameSync(p, outs[i]));
  } catch (e) {
    for (const p of parts) rmSync(p, { force: true });
    throw e;
  }
  return outs;
}

// ---------- the pass ----------
// Look at every eyecatch longer than split_min_seconds that hasn't been looked at. -> report rows.
export async function splitEyecatches({ dryRun = false, minSeconds, maxClaude } = {}) {
  const s = settings(), root = config.local.eyecatches;
  if (!root || !existsSync(root) || (!s.split_eyecatches && !dryRun)) return [];
  const min = Number(minSeconds ?? s.split_min_seconds ?? 10.5);
  const checked = readChecked();
  const rows = getDb().prepare(`SELECT id, source_key, duration_ms, source_updated FROM items
    WHERE source = 'local' AND kind = 'eyecatch' AND present = 1 AND duration_ms > ? ORDER BY duration_ms DESC`).all(min * 1000)
    .filter((r) => !alreadyCut(r.source_key) && (dryRun || checked[r.source_key] !== r.source_updated) && existsSync(r.source_key));
  claudeRun.n = 0;
  claudeRun.max = maxClaude || 0;
  const report = [];
  for (const r of rows) {
    const dur = r.duration_ms / 1000;
    let d;
    try {
      let cands = await findCandidates(r.source_key, dur);
      // A short eyecatch is full of ordinary animation cuts: only silence or black at the
      // boundary makes one worth asking Claude about. (Long ones: every candidate.)
      if (dur <= 10.5) cands = cands.filter((c) => c.kinds.some((k) => k !== "cut"));
      d = await decide(r.source_key, dur, cands);
    } catch (e) {
      log.warn(`eyesplit: ${basename(r.source_key)}: ${e.message}`);
      if (e.infra) break;
      continue;
    }
    const pieces = d.cuts.length ? piecesFor(dur, d.cuts, d.gaps) : [];
    const row = { file: r.source_key, seconds: Math.round(dur * 10) / 10, cuts: d.cuts.map((t) => Math.round(t * 100) / 100), pieces: pieces.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`), via: d.via, why: d.why || "" };
    report.push(row);
    if (dryRun) continue;
    if (pieces.length > 1) {
      try {
        await splitFile(r.source_key, pieces, root);
        row.done = true;
        log.info(`eyesplit: ${basename(r.source_key)} (${dur.toFixed(1)} s) -> ${pieces.length} eyecatches [${row.pieces.join(", ")}] (${d.via}${d.why ? ": " + d.why : ""}); original in data\\eyecatch-originals`);
      } catch (e) {
        log.warn(`eyesplit: couldn't split ${basename(r.source_key)}: ${e.message}`);
        continue; // try again next sync
      }
    } else {
      log.info(`eyesplit: ${basename(r.source_key)} (${dur.toFixed(1)} s) left as one eyecatch (${d.via}${d.why ? ": " + d.why : ""})`);
    }
    if (d.sure) checked[r.source_key] = r.source_updated;
  }
  if (!dryRun) { try { writeFileSync(CHECKED(), JSON.stringify(checked)); } catch { /* fine */ } }
  return report;
}
// ---------- commercials: compilations of several ads ----------
// A long commercial with black + silence at regular intervals is a reel of several ads. Only the
// clear cases are cut: at least `minPieces` pieces, every boundary a black frame AND silence at
// least 8 s from either end (a black lead-in or lead-out is one ad), each piece at least 5 s.
// Originals go to data\commercial-originals; each part inherits its original's tags.csv row.
const COMMERCIAL_ORIGINALS = () => join(DATA_DIR, "commercial-originals");

function copyCsvRow(root, original, parts) {
  const file = join(root, "tags.csv");
  if (!existsSync(file)) return;
  const rows = parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""), { columns: (h) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, relax_column_count: true });
  const src = rows.find((r) => String(r.filename || "").trim().toLowerCase() === relative(root, original).toLowerCase());
  if (!src) return;
  for (const part of parts) rows.push({ filename: relative(root, part), decade: src.decade || "", holiday: src.holiday || "", notes: src.notes || "" });
  rows.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
  try { writeFileSync(file, "\uFEFF" + stringify(rows, { header: true, columns: ["filename", "decade", "holiday", "notes"] })); } catch (e) { log.warn(`eyesplit: couldn't update ${file} (${e.code})`); }
}

export async function splitCommercials({ dryRun = false, minPieces = 3, minSeconds = 75, only = [], force = false } = {}) {
  const root = config.local.commercials;
  if (!root || !existsSync(root)) return [];
  const rows = getDb().prepare(`SELECT id, source_key, duration_ms FROM items WHERE source = 'local' AND kind = 'commercial'
    AND present = 1 AND playable = 1 AND duplicate_of IS NULL AND duration_ms > ? ORDER BY duration_ms DESC`).all(minSeconds * 1000)
    .filter((r) => !alreadyCut(r.source_key) && existsSync(r.source_key))
    .filter((r) => !only.length || only.some((o) => r.source_key.toLowerCase().includes(o.toLowerCase())));
  claudeRun.n = 0;
  claudeRun.max = 60;
  const report = [];
  for (const r of rows) {
    const dur = r.duration_ms / 1000;
    let cands;
    try {
      cands = (await findCandidates(r.source_key, dur)).filter((c) => c.kinds.includes("black") && c.kinds.includes("silence") && c.at >= 8 && c.at <= dur - 8);
    } catch (e) { log.warn(`eyesplit: ${basename(r.source_key)}: ${e.message}`); continue; }
    if (cands.length < minPieces - 1) continue; // not clearly a reel
    let d;
    try {
      // force: cut at every black + silence moment without asking Claude (serials that Claude saw as one story).
      d = !force && claudeOn() ? await decide(r.source_key, dur, cands, "commercial") : { cuts: cands.map((c) => c.at), gaps: cands.map((c) => c.gap), via: force ? "forced" : "black + silence" };
    } catch (e) {
      log.warn(`eyesplit: ${basename(r.source_key)}: ${e.message}`);
      if (e.infra) break;
      continue;
    }
    const pieces = d.cuts.length ? piecesFor(dur, d.cuts, d.gaps, 5) : [];
    const row = { file: r.source_key, seconds: Math.round(dur), pieces: pieces.length, lengths: pieces.map(([a, b]) => Math.round(b - a)).join(" "), via: d.via, why: d.why || "" };
    if (pieces.length < minPieces) { row.skipped = `Claude found ${pieces.length} piece(s), under ${minPieces}`; report.push(row); continue; }
    report.push(row);
    if (dryRun) continue;
    try {
      const outs = await splitFile(r.source_key, pieces, root, COMMERCIAL_ORIGINALS());
      copyCsvRow(root, r.source_key, outs);
      row.done = true;
      log.info(`eyesplit: commercial ${basename(r.source_key)} (${Math.round(dur)} s) -> ${pieces.length} commercials; original in data\\commercial-originals`);
    } catch (e) {
      row.skipped = e.message;
      log.warn(`eyesplit: couldn't split ${basename(r.source_key)}: ${e.message}`);
    }
  }
  return report;
}
// ---------- by hand: the eyecatch clipper page (editor.js serves it) ----------
// You watch an eyecatch in the browser, press Space where one ends and the next begins, and the
// pieces are cut here with the same machinery as the automatic splitter (original kept in
// data\eyecatch-originals). data\eyecatch-reviewed.json remembers what you've looked at.
const REVIEWED = () => join(DATA_DIR, "eyecatch-reviewed.json");
const readReviewed = () => { try { return JSON.parse(readFileSync(REVIEWED(), "utf8")); } catch { return {}; } };
const saveReviewed = (o) => { try { writeFileSync(REVIEWED(), JSON.stringify(o)); } catch { /* fine */ } };
const eyecatchRow = (id) => getDb().prepare("SELECT id, source_key, duration_ms FROM items WHERE id = ? AND source = 'local' AND kind = 'eyecatch' AND present = 1").get(Number(id));

export function clipperList() {
  const root = config.local.eyecatches, reviewed = readReviewed(), machine = readChecked();
  return getDb().prepare("SELECT id, source_key, duration_ms FROM items WHERE source = 'local' AND kind = 'eyecatch' AND present = 1 AND playable = 1 ORDER BY duration_ms DESC, id").all().map((r) => {
    const dir = dirname(relative(root, r.source_key));
    return { id: r.id, name: basename(r.source_key, extname(r.source_key)), folder: dir === "." ? "" : dir, seconds: Math.round(r.duration_ms / 100) / 10,
      reviewed: reviewed[r.source_key]?.result ?? null, machineChecked: !!machine[r.source_key], part: alreadyCut(r.source_key) };
  });
}

// The file behind an eyecatch id (and only eyecatches: the page can't ask for any other file).
export function eyecatchFile(id) {
  const r = eyecatchRow(id);
  return r && existsSync(r.source_key) ? r.source_key : null;
}

export function markEyecatchSingle(id) {
  const r = eyecatchRow(id);
  if (!r) throw new Error("no such eyecatch");
  const rev = readReviewed();
  rev[r.source_key] = { at: new Date().toISOString(), result: "single" };
  saveReviewed(rev);
}

// pieces: [[start, end], ...] in seconds - only the parts to KEEP. -> the new file names.
export async function cutEyecatchByHand(id, pieces) {
  const r = eyecatchRow(id);
  if (!r || !existsSync(r.source_key)) throw new Error("that file isn't there any more");
  const dur = r.duration_ms / 1000;
  const keep = (Array.isArray(pieces) ? pieces : []).map((p) => [Number(p?.[0]), Number(p?.[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).map(([a, b]) => [Math.max(0, a), Math.min(dur, b)])
    .filter(([a, b]) => b - a >= 0.5).sort((x, y) => x[0] - y[0]);
  if (!keep.length) throw new Error("no piece of at least half a second to keep");
  for (let i = 1; i < keep.length; i++) if (keep[i][0] < keep[i - 1][1] - 0.01) throw new Error("the pieces overlap");
  if (keep.length === 1 && keep[0][0] <= 0.05 && keep[0][1] >= dur - 0.05) throw new Error("that keeps the whole video; use \"It's one eyecatch\" instead");
  const outs = await splitFile(r.source_key, keep, config.local.eyecatches);
  const rev = readReviewed();
  rev[r.source_key] = { at: new Date().toISOString(), result: "split", pieces: keep.length };
  saveReviewed(rev);
  log.info(`eyesplit: by hand, ${basename(r.source_key)} (${dur.toFixed(1)} s) -> ${keep.length} piece(s) [${keep.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(", ")}]; original in data\\eyecatch-originals`);
  return outs.map((o) => basename(o));
}