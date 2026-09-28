// Add commercials or clips from YouTube (or any site yt-dlp supports): download into
// the commercials/clips folder, then sync so they're in rotation at the next break.
// Playlists are expanded into their videos.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { join } from "node:path";
import { config, ROOT, DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { syncLocal } from "./index.js";
import { probe } from "./localScan.js";

const run = promisify(execFile);
const MAX_MINUTES = 10; // anything longer is probably a compilation, not one ad
const MAX_SHORT_MINUTES = 15; // local.shorts: "short (2-15 min) shows"
// Where each kind goes, and its longest single video (seconds).
const FOLDER_OF = { commercial: "commercials", clip: "clips", eyecatch: "eyecatches", short: "shorts" };
const folderFor = (kind) => config.local[FOLDER_OF[kind] || "commercials"];
const maxSeconds = (kind) => (kind === "eyecatch" ? 60 : kind === "short" ? MAX_SHORT_MINUTES * 60 : MAX_MINUTES * 60);
const tooLong = (kind, secs) => (kind === "eyecatch"
  ? `${Math.round(secs)} seconds long; an eyecatch is a few seconds (a minute at most)`
  : kind === "short" ? `${Math.round(secs / 60)} minutes long; a short is ${MAX_SHORT_MINUTES} minutes at most`
  : `${Math.round(secs / 60)} minutes long; looks like a compilation, not a single ${kind}`);
const slug = (s) => s.replace(/[<>:"/\\|?*]+/g, "_").trim().slice(0, 80) || "Untitled";
const ytdlp = () => join(ROOT, "tools", "yt-dlp.exe");
// yt-dlp needs a JavaScript runtime for YouTube's player challenge; without one it falls
// back to clients that can't play some videos ("made for kids" ones say "not available").
// It only looks for Deno by itself, so point it at the Node running us (tools\node).
const JS = ["--js-runtimes", `node:${process.execPath}`];
// Age-restricted videos need a signed-in YouTube account: cookies exported from a browser
// logged in to one (ideally a throwaway), saved as data\youtube-cookies.txt. Used when there.
const COOKIES = join(DATA_DIR, "youtube-cookies.txt");
const auth = () => (existsSync(COOKIES) ? ["--cookies", COOKIES] : []);
// yt-dlp's error, as a reason a person can act on.
function why(e) {
  const line = e.message.split("\n").find((l) => l.startsWith("ERROR")) || "yt-dlp couldn't read it";
  if (/sign in|confirm you.re not a bot|age[- ]restrict|inappropriate for some users/i.test(line)) {
    return existsSync(COOKIES)
      ? "YouTube wants a signed-in account for this one and the saved sign-in didn't work (it may have expired)"
      : "YouTube only shows this one to signed-in accounts (probably age-restricted); the TV isn't signed in to YouTube yet";
  }
  return line.replace(/^ERROR:\s*(\[[^\]]*\]\s*)?([\w-]+:\s*)?/, "");
}

// ---------- timestamps: pieces of a video ----------
// "0:05", "1:02:03", "75s", "12.5s" -> seconds.
function seconds(t) {
  if (/s$/i.test(t)) return Number(t.slice(0, -1));
  return t.split(":").reduce((n, x) => n * 60 + Number(x), 0);
}
const TIME = String.raw`\d{1,2}(?::\d{2}){1,2}(?:\.\d+)?|\d+(?:\.\d+)?s`;
// The timestamps written with a link or file: ranges ("1:20-1:35") keep those parts; lone
// times are cut points ("0:05" -> 0:00-0:05 and 0:05-end). [] = the whole video.
export function parseCuts(text) {
  const ranges = [...text.matchAll(new RegExp(`(${TIME})\\s*[-–]\\s*(${TIME})`, "gi"))];
  if (ranges.length) return ranges.map((m) => ({ from: seconds(m[1]), to: seconds(m[2]) })).filter((c) => c.to > c.from);
  const points = [...new Set([...text.matchAll(new RegExp(`(?<![\\w:.])(${TIME})(?![\\w:])`, "gi"))].map((m) => seconds(m[1])))].filter((s) => s > 0).sort((a, b) => a - b);
  if (!points.length) return [];
  return [0, ...points].map((from, k, all) => ({ from, to: all[k + 1] ?? null }));
}
const CUT_LONGEST = 60 * 60; // a video to cut pieces from can be up to an hour
const TMP = join(DATA_DIR, "tmp-downloads"); // outside the scanned folders
const ffmpeg = () => process.env.FFMPEG_PATH || join(ROOT, "tools", "ffmpeg", "bin", "ffmpeg.exe");
const clock = (s) => { const m = Math.floor(s / 60), r = Math.round((s % 60) * 10) / 10; return `${m}:${String(r).padStart(r < 10 ? 2 : 0, "0")}`; };
const fileClock = (s) => clock(s).replace(":", "m").replace(/$/, "s");

// Cut `cuts` out of the video file `src` (duration `total` seconds) into `destDir`, each
// re-encoded so it starts exactly on its timestamp. Returns added/skipped entries.
async function cutPieces(src, total, cuts, destDir, stem, title, kind) {
  mkdirSync(destDir, { recursive: true });
  const out = [];
  for (const c of cuts) {
    const to = Math.min(c.to ?? total, total);
    const label = `${title} (${clock(c.from)}-${clock(to)})`;
    if (c.from >= total) { out.push({ title: label, skipped: `starts after the end (the video is ${clock(total)} long)` }); continue; }
    const dur = to - c.from;
    if (dur < 0.5) { out.push({ title: label, skipped: "too short (under half a second)" }); continue; }
    if (dur > maxSeconds(kind)) { out.push({ title: label, skipped: tooLong(kind, dur) }); continue; }
    const file = join(destDir, `${stem.slice(0, 70)} (${fileClock(c.from)}-${fileClock(to)}).mp4`);
    try {
      await run(ffmpeg(), ["-v", "error", "-y", "-ss", String(c.from), "-i", src, "-t", String(dur), "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", file],
        { maxBuffer: 16 << 20, timeout: 10 * 60000 });
      log.info(`add: cut ${kind} "${label}"`);
      out.push({ title: label, seconds: Math.round(dur) });
    } catch (e) {
      rmSync(file, { force: true });
      out.push({ title: label, skipped: `couldn't cut it (${e.message.split("\n").find((l) => l.trim() && !l.startsWith("Command failed")) || "ffmpeg failed"})` });
    }
  }
  return out;
}

// Every video behind a link: one for a video link, all of them for a playlist.
// A "watch?v=" link means that one video, even if it came from a playlist; a
// "playlist?list=" link means the whole playlist, which goes in its own subfolder (so
// it counts as one group when breaks are filled).
async function expand(url) {
  const single = /[?&]v=/.test(url) && !/\/playlist\?/.test(url);
  const { stdout } = await run(ytdlp(), ["--no-warnings", ...JS, ...auth(), "--flat-playlist", ...(single ? ["--no-playlist"] : []),
    "--print", "%(id)s\t%(duration)s\t%(playlist_title)s\t%(title)s", url], { maxBuffer: 16 << 20 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [id, secs, playlist, ...title] = line.split("\t");
    // Folder named after the playlist (Windows doesn't allow a trailing dot).
    const folder = !single && playlist && playlist !== "NA" ? playlist.replace(/[<>:"/\\|?*]+/g, "").trim().replace(/[. ]+$/, "").slice(0, 60) : null;
    return { id, url: `https://www.youtube.com/watch?v=${id}`, seconds: Number(secs), title: title.join("\t"), folder };
  });
}

// links: URLs, or { url, cuts } with cuts from parseCuts (pieces of a single video).
export async function addFromUrls(kind, links) {
  const folder = folderFor(kind);
  if (!folder) throw new Error(`no ${kind}s folder set in config.yaml`);
  const dest = join(folder, "youtube");
  mkdirSync(dest, { recursive: true });
  const added = [];
  for (const l of links) {
    const link = typeof l === "string" ? l : l.url;
    const cuts = (typeof l === "string" ? null : l.cuts) || [];
    let videos;
    try {
      videos = await expand(link);
    } catch (e) {
      // A bad link (removed, private, region-blocked) shouldn't sink the others: say why.
      added.push({ title: link, skipped: why(e) });
      continue;
    }
    if (cuts.length) {
      // Pieces: download the whole video somewhere unscanned, cut, throw the whole away.
      const v = videos[0];
      if (videos.length !== 1) { added.push({ title: link, skipped: "timestamps work on a single video, not a playlist" }); continue; }
      if (!(v.seconds > 0)) { added.push({ ...v, skipped: "unavailable (private, deleted or no length)" }); continue; }
      if (v.seconds > CUT_LONGEST) { added.push({ ...v, skipped: `${Math.round(v.seconds / 60)} minutes long; pieces can be cut from videos up to an hour` }); continue; }
      mkdirSync(TMP, { recursive: true });
      const whole = join(TMP, `${v.id}.mp4`);
      try {
        await run(ytdlp(), ["--no-warnings", ...JS, ...auth(), "--force-overwrites", "--ffmpeg-location", join(ROOT, "tools", "ffmpeg", "bin"),
          "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "-o", whole, v.url], { maxBuffer: 16 << 20 });
        const stem = `${v.title.replace(/[<>:"/\\|?*]+/g, "_").trim()} [${v.id}]`;
        added.push(...await cutPieces(whole, v.seconds, cuts, v.folder ? join(dest, v.folder) : dest, stem, v.title, kind));
      } catch (e) {
        added.push({ ...v, skipped: `download failed: ${why(e)}` });
      } finally {
        rmSync(whole, { force: true });
      }
      continue;
    }
    for (const [k, v] of videos.entries()) {
      if (!(v.seconds > 0)) { added.push({ ...v, skipped: "unavailable (private, deleted or no length)" }); continue; }
      if (v.seconds > maxSeconds(kind)) {
        added.push({ ...v, skipped: tooLong(kind, v.seconds) });
        continue;
      }
      // Shorts are episodic (localScan.js's parsePath wants <show folder>\file), unlike the
      // flat single-file model the other kinds use: a playlist becomes one show, its videos
      // episodes in order (this call's own index, not yt-dlp's - it downloads one URL at a
      // time here, outside playlist context); a lone link becomes its own one-episode show.
      const showDir = kind === "short" ? join(dest, v.folder || slug(v.title)) : v.folder ? join(dest, v.folder) : dest;
      const name = kind === "short" ? `S01E${String(k + 1).padStart(2, "0")} - %(title).60s [%(id)s].%(ext)s` : "%(title).80s [%(id)s].%(ext)s";
      try {
        await run(ytdlp(), ["--no-warnings", ...JS, ...auth(), "--no-overwrites", "--ffmpeg-location", join(ROOT, "tools", "ffmpeg", "bin"),
          "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "--restrict-filenames",
          "-o", join(showDir, name), v.url], { maxBuffer: 16 << 20 });
        log.info(`add: downloaded ${kind} "${v.title}"`);
        added.push(v);
      } catch (e) {
        added.push({ ...v, skipped: `download failed: ${why(e)}` });
      }
    }
  }
  if (added.some((a) => !a.skipped)) {
    // Only the local folders: a full sync (Plex, Real-Debrid) takes minutes, longer than
    // Discord waits for the /tvadmin add reply.
    await syncLocal(); // adds blank rows to tags.csv for the new files
    if (prefillTags(folder)) await syncLocal();
  }
  return added;
}

// Video files posted in a drop thread: [{ id, name, url }] (Discord attachments). Saved in
// <folder>\uploads (each file counts on its own when breaks are filled), after checking
// they're a playable video of at most MAX_MINUTES. With cuts (one file), pieces of it.
export async function addFromFiles(kind, files, cuts = []) {
  const folder = folderFor(kind);
  if (!folder) throw new Error(`no ${kind}s folder set in config.yaml`);
  const dest = join(folder, "uploads");
  mkdirSync(dest, { recursive: true });
  // Shorts are episodic (localScan.js's parsePath wants <show folder>\file): files dropped
  // together in one message are one show's episodes in order; the show is named after the
  // first file. A lone file is its own one-episode show.
  const showDir = kind === "short" && files.length ? join(folder, slug(files[0].name.replace(/\.[^.]+$/, ""))) : null;
  if (showDir) mkdirSync(showDir, { recursive: true });
  const added = [];
  for (const [k, f] of files.entries()) {
    const title = f.name.replace(/\.[^.]+$/, "");
    const stem = showDir ? `S01E${String(k + 1).padStart(2, "0")} - ${title.replace(/[<>:"/\\|?*]+/g, "_").trim().slice(0, 70)} [${f.id}]`
      : `${title.replace(/[<>:"/\\|?*]+/g, "_").trim().slice(0, 80)} [${f.id}]`;
    if (cuts.length) {
      mkdirSync(TMP, { recursive: true });
      const whole = join(TMP, `${f.id}${f.name.match(/\.[^.]+$/)?.[0] || ".mp4"}`);
      try {
        const res = await fetch(f.url);
        if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
        writeFileSync(whole, Buffer.from(await res.arrayBuffer()));
        const p = await probe(whole).catch(() => null);
        const secs = Number(p?.format?.duration);
        if (!p?.streams?.some((s) => s.codec_type === "video") || !(secs > 0)) throw new Error("not a playable video");
        added.push(...await cutPieces(whole, secs, cuts, dest, stem, title, kind));
      } catch (e) {
        added.push({ title: f.name, skipped: e.message });
      } finally {
        rmSync(whole, { force: true });
      }
      continue;
    }
    const path = join(showDir || dest, `${stem}${f.name.match(/\.[^.]+$/)?.[0] || ".mp4"}`);
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      const p = await probe(path).catch(() => null);
      const secs = Number(p?.format?.duration);
      if (!p?.streams?.some((s) => s.codec_type === "video") || !(secs > 0)) throw new Error("not a playable video");
      if (secs > maxSeconds(kind)) throw new Error(tooLong(kind, secs));
      log.info(`add: saved uploaded ${kind} "${f.name}"`);
      added.push({ title, seconds: Math.round(secs) });
    } catch (e) {
      rmSync(path, { force: true });
      added.push({ title: f.name, skipped: e.message });
    }
  }
  if (added.some((a) => !a.skipped)) {
    await syncLocal();
    if (prefillTags(folder)) await syncLocal();
  }
  return added;
}

// Fill in blank tags.csv cells from the file names: the decade from a year in the
// title, and "christmas" for obvious holiday ads. Anything already filled is kept.
const XMAS = /christmas|xmas|holiday|santa|snowman|carol|north pole|12 days|reindeer|sleigh/i;
function prefillTags(folder) {
  const file = join(folder, "tags.csv");
  if (!existsSync(file)) return false;
  const rows = parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""), { columns: true, skip_empty_lines: true });
  let changed = 0;
  for (const r of rows) {
    const name = String(r.filename || "");
    const year = name.match(/(?:^|[^0-9])(19[5-9][0-9]|20[0-3][0-9])(?:[^0-9]|$)/)?.[1];
    if (!r.decade && year) { r.decade = `${year.slice(0, 3)}0s`; changed++; }
    if (!r.holiday && XMAS.test(name)) { r.holiday = "christmas"; changed++; }
  }
  if (!changed) return false;
  try {
    writeFileSync(file, "\uFEFF" + stringify(rows, { header: true, columns: ["filename", "decade", "holiday", "notes"] }));
    log.info(`add: filled in ${changed} tag(s) in ${file} from file names`);
    return true;
  } catch (e) {
    log.warn(`add: couldn't update ${file} (${e.code}); is it open in Excel?`);
    return false;
  }
}
