// Add commercials or clips from YouTube (or any site yt-dlp supports): download into
// the commercials/clips folder, then sync so they're in rotation at the next break.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "../config.js";
import { log } from "../log.js";
import { runSync } from "./index.js";

const run = promisify(execFile);
const MAX_MINUTES = 10; // anything longer is probably a compilation, not one ad

export async function addFromUrls(kind, urls) {
  const folder = kind === "clip" ? config.local.clips : config.local.commercials;
  if (!folder) throw new Error(`no ${kind}s folder set in config.yaml`);
  const dest = join(folder, "youtube");
  mkdirSync(dest, { recursive: true });
  const ytdlp = join(ROOT, "tools", "yt-dlp.exe");
  const added = [];
  for (const url of urls) {
    const { stdout: info } = await run(ytdlp, ["--no-warnings", "--print", "%(duration)s\t%(title)s", "--skip-download", url]);
    const [secs, title] = info.trim().split("\t");
    if (Number(secs) > MAX_MINUTES * 60) {
      added.push({ url, title, skipped: `${Math.round(secs / 60)} minutes long; looks like a compilation, not a single ${kind}` });
      continue;
    }
    await run(ytdlp, ["--no-warnings", "--ffmpeg-location", join(ROOT, "tools", "ffmpeg", "bin"),
      "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "--restrict-filenames",
      "-o", join(dest, "%(title).80s [%(id)s].%(ext)s"), url], { maxBuffer: 16 << 20 });
    log.info(`add: downloaded ${kind} "${title}"`);
    added.push({ url, title, seconds: Number(secs) });
  }
  if (added.some((a) => !a.skipped)) await runSync();
  return added;
}
