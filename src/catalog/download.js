// Add commercials or clips from YouTube (or any site yt-dlp supports): download into
// the commercials/clips folder, then sync so they're in rotation at the next break.
// Playlists are expanded into their videos.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { join } from "node:path";
import { config, ROOT } from "../config.js";
import { log } from "../log.js";
import { runSync } from "./index.js";

const run = promisify(execFile);
const MAX_MINUTES = 10; // anything longer is probably a compilation, not one ad
const ytdlp = () => join(ROOT, "tools", "yt-dlp.exe");

// Every video behind a link: one for a video link, all of them for a playlist.
// A "watch?v=" link means that one video, even if it came from a playlist; a
// "playlist?list=" link means the whole playlist, which goes in its own subfolder (so
// it counts as one group when breaks are filled).
async function expand(url) {
  const single = /[?&]v=/.test(url) && !/\/playlist\?/.test(url);
  const { stdout } = await run(ytdlp(), ["--no-warnings", "--flat-playlist", ...(single ? ["--no-playlist"] : []),
    "--print", "%(id)s\t%(duration)s\t%(playlist_title)s\t%(title)s", url], { maxBuffer: 16 << 20 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [id, secs, playlist, ...title] = line.split("\t");
    const folder = !single && playlist && playlist !== "NA" ? playlist.replace(/[<>:"/\\|?*]+/g, "").trim().slice(0, 60) : null;
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
    for (const v of await expand(link)) {
      if (!(v.seconds > 0)) { added.push({ ...v, skipped: "unavailable (private, deleted or no length)" }); continue; }
      if (v.seconds > MAX_MINUTES * 60) {
        added.push({ ...v, skipped: `${Math.round(v.seconds / 60)} minutes long; looks like a compilation, not a single ${kind}` });
        continue;
      }
      try {
        await run(ytdlp(), ["--no-warnings", "--no-overwrites", "--ffmpeg-location", join(ROOT, "tools", "ffmpeg", "bin"),
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
    await runSync(); // adds blank rows to tags.csv for the new files
    if (prefillTags(folder)) await runSync();
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
