// Add commercials or clips from YouTube (or any site yt-dlp supports): download into
// the commercials/clips folder, then sync so they're in rotation at the next break.
// Playlists are expanded into their videos.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { join } from "node:path";
import { config, ROOT } from "../config.js";
import { log } from "../log.js";
import { syncLocal } from "./index.js";
import { probe } from "./localScan.js";

const run = promisify(execFile);
const MAX_MINUTES = 10; // anything longer is probably a compilation, not one ad
const ytdlp = () => join(ROOT, "tools", "yt-dlp.exe");
// yt-dlp needs a JavaScript runtime for YouTube's player challenge; without one it falls
// back to clients that can't play some videos ("made for kids" ones say "not available").
// It only looks for Deno by itself, so point it at the Node running us (tools\node).
const JS = ["--js-runtimes", `node:${process.execPath}`];

// Every video behind a link: one for a video link, all of them for a playlist.
// A "watch?v=" link means that one video, even if it came from a playlist; a
// "playlist?list=" link means the whole playlist, which goes in its own subfolder (so
// it counts as one group when breaks are filled).
async function expand(url) {
  const single = /[?&]v=/.test(url) && !/\/playlist\?/.test(url);
  const { stdout } = await run(ytdlp(), ["--no-warnings", ...JS, "--flat-playlist", ...(single ? ["--no-playlist"] : []),
    "--print", "%(id)s\t%(duration)s\t%(playlist_title)s\t%(title)s", url], { maxBuffer: 16 << 20 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [id, secs, playlist, ...title] = line.split("\t");
    // Folder named after the playlist (Windows doesn't allow a trailing dot).
    const folder = !single && playlist && playlist !== "NA" ? playlist.replace(/[<>:"/\\|?*]+/g, "").trim().replace(/[. ]+$/, "").slice(0, 60) : null;
    return { id, url: `https://www.youtube.com/watch?v=${id}`, seconds: Number(secs), title: title.join("\t"), folder };
  });
}

export async function addFromUrls(kind, urls) {
  const folder = kind === "clip" ? config.local.clips : config.local.commercials;
  if (!folder) throw new Error(`no ${kind}s folder set in config.yaml`);
  const dest = join(folder, "youtube");
  mkdirSync(dest, { recursive: true });
  const added = [];
  for (const link of urls) {
    let videos;
    try {
      videos = await expand(link);
    } catch (e) {
      // A bad link (removed, private, region-blocked) shouldn't sink the others: say why.
      const why = e.message.split("\n").find((l) => l.startsWith("ERROR")) || "yt-dlp couldn't read it";
      added.push({ title: link, skipped: why.replace(/^ERROR:\s*(\[[^\]]*\]\s*)?([\w-]+:\s*)?/, "") });
      continue;
    }
    for (const v of videos) {
      if (!(v.seconds > 0)) { added.push({ ...v, skipped: "unavailable (private, deleted or no length)" }); continue; }
      if (v.seconds > MAX_MINUTES * 60) {
        added.push({ ...v, skipped: `${Math.round(v.seconds / 60)} minutes long; looks like a compilation, not a single ${kind}` });
        continue;
      }
      try {
        await run(ytdlp(), ["--no-warnings", ...JS, "--no-overwrites", "--ffmpeg-location", join(ROOT, "tools", "ffmpeg", "bin"),
          "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "--restrict-filenames",
          "-o", join(v.folder ? join(dest, v.folder) : dest, "%(title).80s [%(id)s].%(ext)s"), v.url], { maxBuffer: 16 << 20 });
        log.info(`add: downloaded ${kind} "${v.title}"`);
        added.push(v);
      } catch (e) {
        added.push({ ...v, skipped: `download failed (${e.message.split("\n").find((l) => l.includes("ERROR")) || "unknown error"})` });
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
// they're a playable video of at most MAX_MINUTES.
export async function addFromFiles(kind, files) {
  const folder = kind === "clip" ? config.local.clips : config.local.commercials;
  if (!folder) throw new Error(`no ${kind}s folder set in config.yaml`);
  const dest = join(folder, "uploads");
  mkdirSync(dest, { recursive: true });
  const added = [];
  for (const f of files) {
    const title = f.name.replace(/\.[^.]+$/, "");
    const path = join(dest, `${title.replace(/[<>:"/\\|?*]+/g, "_").trim().slice(0, 80)} [${f.id}]${f.name.match(/\.[^.]+$/)?.[0] || ".mp4"}`);
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      const p = await probe(path).catch(() => null);
      const secs = Number(p?.format?.duration);
      if (!p?.streams?.some((s) => s.codec_type === "video") || !(secs > 0)) throw new Error("not a playable video");
      if (secs > MAX_MINUTES * 60) throw new Error(`${Math.round(secs / 60)} minutes long; looks like a compilation, not a single ${kind}`);
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
