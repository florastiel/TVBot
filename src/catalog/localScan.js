import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, extname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { chooseTracks, fromFfprobeStreams } from "./tracks.js";

const run = promisify(execFile);
const VIDEO = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".mpg", ".mpeg", ".ts", ".webm", ".flv"]);
const FOLDERS = { shows: "episode", movies: "movie", clips: "clip", commercials: "commercial", shorts: "short" };

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
    VALUES ('local', :source_key, :kind, :library, :show_title, :season, :episode, :title, :year, 'full', :source_updated, 1)
    ON CONFLICT (source, source_key) DO UPDATE SET
      kind = excluded.kind, library = excluded.library, show_title = excluded.show_title, season = excluded.season,
      episode = excluded.episode, title = excluded.title, year = excluded.year,
      source_updated = excluded.source_updated, present = 1`);

  const seen = new Set();
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
        const st = statSync(f);
        upsert.run({
          source_key: f, kind, library: `local:${key}`, show_title: null, season: null, episode: null, year: null,
          ...parsePath(kind, root, f),
          source_updated: Math.floor(st.mtimeMs / 1000) * 1000 + (st.size % 1000),
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

  // ffprobe only new/changed files.
  const todo = db.prepare(`SELECT id, source_key, show_title, source_updated FROM items
    WHERE source = 'local' AND present = 1 AND (streams_checked IS NULL OR streams_checked != source_updated)`).all();
  const save = db.prepare(`UPDATE items SET duration_ms = ?, video_height = ?, audio_stream = ?, audio_lang = ?, subs = ?,
    playable = ?, unplayable_reason = ?, streams_checked = ?, cues = ? WHERE id = ?`);
  const worker = async () => {
    for (let r; (r = todo.shift()); ) {
      try {
        const p = await probe(r.source_key);
        const video = p.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
        const t = video ? chooseTracks(fromFfprobeStreams(p.streams), { showTitle: r.show_title }) : { playable: false, reason: "no video track" };
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
