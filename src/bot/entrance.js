// Entrance sounds: one per user, stored as data/entrances/<userId>.<ext>. The player
// plays it over the mic when that person joins the TV's voice channel.
import { mkdirSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { extname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ENTRANCE_DIR } from "../config.js";
import { prepareSound } from "../player/mic.js";

const run = promisify(execFile);
const MAX_UPLOAD = 25 * 1024 * 1024;

function existing(userId) {
  mkdirSync(ENTRANCE_DIR, { recursive: true });
  return readdirSync(ENTRANCE_DIR).filter((n) => n.startsWith(`${userId}.`) && !n.endsWith(".tmp"));
}

// Returns the length that will actually play, in seconds. Throws a user-facing
// message if the file isn't usable.
export async function setEntrance(userId, attachment) {
  if (attachment.size > MAX_UPLOAD) throw new Error("That file is too big (25 MB max).");
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error("Couldn't download that file from Discord.");
  const ext = (extname(new URL(attachment.url).pathname) || ".bin").toLowerCase().slice(0, 6);
  const tmp = join(ENTRANCE_DIR, `${userId}${ext}.tmp`);
  mkdirSync(ENTRANCE_DIR, { recursive: true });
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));

  let prepared;
  try {
    // Also warms the cache, so the first time it plays there's no delay.
    prepared = await prepareSound(tmp);
  } catch {
    rmSync(tmp, { force: true });
    throw new Error("That file doesn't have any sound I can play. Try an mp3, wav, ogg or a video clip.");
  }
  const { stdout } = await run(process.env.FFPROBE_PATH || "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", prepared]);

  for (const old of existing(userId)) rmSync(join(ENTRANCE_DIR, old), { force: true });
  const final = join(ENTRANCE_DIR, `${userId}${ext}`);
  renameSync(tmp, final);
  await prepareSound(final); // cache key includes the path
  return Number(stdout) || 0;
}

export function clearEntrance(userId) {
  const files = existing(userId);
  for (const f of files) rmSync(join(ENTRANCE_DIR, f), { force: true });
  return files.length > 0;
}
