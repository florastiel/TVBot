import { readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, relative, sep, extname, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { SUBS_DIR } from "./plexSync.js"; // where the player looks for sidecar subtitles
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { chooseTracks, fromFfprobeStreams } from "./tracks.js";
import { parseRelease, showName, tidy as tidyName } from "./release.js";

const run = promisify(execFile);
const VIDEO = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".mpg", ".mpeg", ".ts", ".webm", ".flv"]);
const FOLDERS = { shows: "episode", movies: "movie", clips: "clip", commercials: "commercial", shorts: "short", eyecatches: "eyecatch" };

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (VIDEO.has(extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

const tidy = (s) => s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();

// Pull show / season / episode / title / year out of a path.
export function parsePath(kind, root, file) {
  const rel = relative(root, file);
  const name = basename(file, extname(file));
  if (kind === "episode" || kind === "short") {
    const show = rel.split(sep).length > 1 ? rel.split(sep)[0] : null;
    const m = name.match(/[Ss](\d{1,2})[ ._-]*[Ee](\d{1,3})|(\d{1,2})x(\d{2,3})/);
    // Anime: "[Group] Show Name - 05v2 [ABCD1234]"
    const a = !m && name.match(/^(?:\[[^\]]*\][ _]*)?(.+?)[ _]+-[ _]+(\d{1,4})(?:v\d)?(?:[ _]|$)/);
    if (a) {
      const episode = Number(a[2]);
      return { show_title: show ? tidy(show) : tidy(a[1]), season: 1, episode, title: `Episode ${episode}` };
    }
    const season = m ? Number(m[1] ?? m[3]) : null;
    const episode = m ? Number(m[2] ?? m[4]) : null;
    let title = m ? name.slice(m.index + m[0].length) : name;
    title = tidy(title.replace(/\[[^\]]*\]/g, "").replace(/^[\s._-]+/, "")) || (m ? `Episode ${episode}` : tidy(name));
    return { show_title: show ? tidy(show) : tidy(name.slice(0, m?.index ?? name.length)) || null, season, episode, title };
  }
  const y = name.match(/^(.*?)[ ._(\[]+((?:19|20)\d{2})[)\]]?/);
  return y && kind === "movie" ? { title: tidy(y[1]), year: Number(y[2]) } : { title: tidy(name) };
}

// Loose libraries (local.library: a plugged-in drive's "Movies", "TV Shows"...): there's no
// folder layout to go by, so each file is identified from its release name like a
// Real-Debrid file. Download-host and "Untitled" folder names are ignored. Numbered files
// in a named folder ("Gurren Lagann\01. Title.mkv", "How to Succeed\H2$-3.mp4") are that
// folder's show, in order. Anything else becomes a movie, with or without a year.
const JUNK_DIR = /\.(com|net|org|fun|io|to)\b|^untitled\b|^new folder\b/i;
export function parseLibraryFile(root, file) {
  const rel = relative(root, file).split(sep);
  const dirs = rel.slice(0, -1).filter((d) => !JUNK_DIR.test(d));
  const p = parseRelease([...dirs, rel.at(-1)].join("/"));
  if (!p) return null;
  if (p.match === "full") return p;
  const name = basename(file, extname(file));
  const folder = dirs.length ? showName(dirs[0]) : null; // the top one: "How to Succeed\H2$\H2$-1.mp4"
  if (folder) {
    // "Frasier\Season 1\S01E05 - Title.mkv": the episode is known, only the show name
    // wasn't in the file name.
    if (p.kind === "episode" && p.season != null && p.episode != null) return { ...p, show_title: folder, match: "full" };
    const lead = name.match(/^(\d{1,3})[ ._)-]+(.*)$/);
    if (lead) return { kind: "episode", show_title: folder, season: 1, episode: Number(lead[1]), title: tidyName(lead[2]) || `Episode ${Number(lead[1])}`, match: "full" };
    const part = name.match(/[ ._-](?:part[ ._-]?)?(\d{1,2})$/i);
    if (part) return { kind: "episode", show_title: folder, season: 1, episode: Number(part[1]), title: `Part ${Number(part[1])}`, match: "full" };
  }
  return { ...p, kind: "movie", title: p.title || tidyName(name), match: "full" };
}

// Subtitle files next to a local video ("Show S01E01.srt", "Show S01E01.en.ass"), as
// streams for chooseTracks: "en"/"eng"/"english" after the name means English, nothing
// means unlabeled (used as a last resort). id is the file's path.
const SUB_EXT = { ".srt": "subrip", ".ass": "ass", ".ssa": "ass" };
function sidecarStreams(file) {
  const base = basename(file, extname(file)).toLowerCase();
  let names;
  try { names = readdirSync(dirname(file)); } catch { return []; }
  return names.filter((n) => SUB_EXT[extname(n).toLowerCase()] && n.toLowerCase().startsWith(base)).map((n) => {
    const tag = n.slice(base.length, n.length - extname(n).length).replace(/^[\s._-]+/, "").toLowerCase();
    const lang = !tag ? null : /^(en|eng|english)\b/.test(tag) ? "eng" : tag.slice(0, 3);
    return { type: "subtitle", lang, codec: SUB_EXT[extname(n).toLowerCase()], title: n, forced: /forced/.test(tag), external: true, id: join(dirname(file), n) };
  });
}

// file: a path, or a URL (Real-Debrid items).
export async function probe(file) {
  const { stdout } = await run(process.env.FFPROBE_PATH || "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", file],
    { maxBuffer: 16 << 20, timeout: 120000 });
  return JSON.parse(stdout);
}

export async function scanLocal() {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO items (source, source_key, kind, library, show_title, season, episode, title, year, match, source_updated, present)
    VALUES ('local', :source_key, :kind, :library, :show_title, :season, :episode, :title, :year, :match, :source_updated, 1)
    ON CONFLICT (source, source_key) DO UPDATE SET
      kind = excluded.kind, library = excluded.library, show_title = excluded.show_title, season = excluded.season,
      episode = excluded.episode, title = excluded.title, year = excluded.year, match = excluded.match,
      source_updated = excluded.source_updated, present = 1`);
  const stamp = (f) => { const st = statSync(f); return Math.floor(st.mtimeMs / 1000) * 1000 + (st.size % 1000); };

  const seen = new Set();
  // Loose libraries (see parseLibraryFile): shows and movies mixed, named by release name.
  for (const root of [config.local.library || []].flat().filter(Boolean)) {
    if (!existsSync(root)) {
      log.info(`local: library ${root} isn't there (drive unplugged?); its items are off the schedule until it's back`);
      continue;
    }
    const files = walk(root);
    let n = 0;
    tx(() => {
      for (const f of files) {
        const p = parseLibraryFile(root, f);
        if (!p) continue;
        upsert.run({ source_key: f, library: `local:library`, show_title: null, season: null, episode: null, year: null, ...p, source_updated: stamp(f) });
        seen.add(f);
        n++;
      }
    });
    db.exec(`INSERT OR IGNORE INTO shows (title) SELECT DISTINCT show_title FROM items
      WHERE source = 'local' AND kind = 'episode' AND show_title IS NOT NULL`);
    log.info(`local: library ${root}: ${n} files`);
  }
  for (const [key, kind] of Object.entries(FOLDERS)) {
    const root = config.local[key];
    if (!root) continue;
    if (!existsSync(root)) {
      log.info(`local: ${key} folder ${root} doesn't exist yet, skipping`);
      continue;
    }
    const files = walk(root);
    tx(() => {
      for (const f of files) {
        upsert.run({
          source_key: f, kind, library: `local:${key}`, show_title: null, season: null, episode: null, year: null, match: "full",
          ...parsePath(kind, root, f),
          source_updated: stamp(f),
        });
        seen.add(f);
      }
    });
    if (kind === "episode") {
      db.exec(`INSERT OR IGNORE INTO shows (title) SELECT DISTINCT show_title FROM items
        WHERE source = 'local' AND kind = 'episode' AND show_title IS NOT NULL`);
    }
    log.info(`local: ${key}: ${files.length} files`);
  }

  tx((d) => {
    const mark = d.prepare("UPDATE items SET present = 0 WHERE id = ?");
    for (const r of d.prepare("SELECT id, source_key FROM items WHERE source = 'local' AND present = 1").all()) {
      if (!seen.has(r.source_key)) mark.run(r.id);
    }
  });

  // ffprobe only new/changed files, and ones missing subtitles that now have a usable
  // subtitle file next to them (English or unlabeled).
  const usableSidecar = (f) => sidecarStreams(f).some((s) => s.lang == null || s.lang === config.language.subtitles);
  const todo = db.prepare(`SELECT id, source_key, show_title, source_updated, streams_checked FROM items
    WHERE source = 'local' AND present = 1 AND (streams_checked IS NULL OR streams_checked != source_updated
      OR unplayable_reason LIKE '%subtitles%')`).all()
    .filter((r) => r.streams_checked == null || r.streams_checked !== r.source_updated || usableSidecar(r.source_key));
  const save = db.prepare(`UPDATE items SET duration_ms = ?, video_height = ?, audio_stream = ?, audio_lang = ?, subs = ?,
    playable = ?, unplayable_reason = ?, streams_checked = ?, cues = ? WHERE id = ?`);
  const worker = async () => {
    for (let r; (r = todo.shift()); ) {
      try {
        const p = await probe(r.source_key);
        const video = p.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
        const t = video ? chooseTracks([...fromFfprobeStreams(p.streams), ...sidecarStreams(r.source_key)], { showTitle: r.show_title }) : { playable: false, reason: "no video track" };
        if (t.subs?.mode === "sidecar") {
          // Copy it where the player looks: data\subs\<id>.ass or .srt.
          mkdirSync(SUBS_DIR, { recursive: true });
          copyFileSync(t.subs.id, join(SUBS_DIR, `${r.id}${t.subs.codec === "ass" ? ".ass" : ".srt"}`));
        }
        const cues = (p.chapters || []).map((c) => Math.round(Number(c.start_time) * 1000)).filter((ms) => ms > 0);
        save.run(Math.round(Number(p.format.duration) * 1000) || null, video?.height ?? null, t.audioStream ?? null,
          t.audioLang ?? null, JSON.stringify(t.subs || { mode: "none" }), t.playable ? 1 : 0, t.reason || null, r.source_updated,
          cues.length ? JSON.stringify(cues) : null, r.id);
      } catch (e) {
        save.run(null, null, null, null, null, 0, `ffprobe failed: ${e.message.split("\n")[0]}`, r.source_updated, null, r.id);
        log.warn(`local: couldn't read ${r.source_key}`);
      }
    }
  };
  const n = todo.length;
  await Promise.all(Array.from({ length: 4 }, worker));
  if (n) log.info(`local: read durations/tracks for ${n} files`);
}
