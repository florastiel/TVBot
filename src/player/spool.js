// Download-ahead for subtitles. Text subtitles stored inside a video file can only be
// drawn onto the picture from a local copy (ffmpeg's subtitle renderer reads the whole
// file first). So while one show plays, the next ones that need it are downloaded
// here, then played from the local copy with subtitles burned in. Each file is still
// read from the Plex server once, just earlier. Copies are deleted a while after use,
// and the folder never grows past player.spool_max_gb.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join, extname } from "node:path";
import { config, DATA_DIR } from "../config.js";
import { log } from "../log.js";

const DIR = join(DATA_DIR, "spool");
const KEEP_MS = 12 * 3600000; // unused copies older than this are deleted
const queue = [];
const failed = new Set();
let busy = null;

const gb = (n) => n * 1024 ** 3;
const fileFor = (row) => join(DIR, `${row.id}${extname(row.media_path || "") || ".mkv"}`);
const needsSpool = (row) => row?.source === "plex" && row.media_path && row.subs && JSON.parse(row.subs).mode === "embedded_text";

// Local copy of an item if it's fully downloaded, else null.
export function spooledPath(row) {
  if (!needsSpool(row)) return null;
  const f = fileFor(row);
  if (!existsSync(f)) return null;
  const now = new Date();
  try { utimesSync(f, now, now); } catch { /* in use: fine */ }
  return f;
}

// Ask for these items to be downloaded (in order), if they need it.
export function wantSpool(rows, plex) {
  for (const row of rows) {
    if (!needsSpool(row) || failed.has(row.id) || existsSync(fileFor(row))) continue;
    if (busy?.id === row.id || queue.some((q) => q.row.id === row.id)) continue;
    queue.push({ row, plex });
  }
  if (!busy) work();
}

async function work() {
  while (queue.length) {
    const { row, plex } = queue.shift();
    busy = row;
    try {
      await download(row, plex);
    } catch (e) {
      failed.add(row.id);
      log.warn(`spool: ${row.show_title || row.title} (${row.id}) not downloaded: ${e.message}`);
    }
  }
  busy = null;
}

// The Plex server hangs up on long single downloads (after ~100 MB), so fetch the file
// in chunks, each its own request picking up where the last one ended, with retries.
const CHUNK = 32 * 1024 * 1024;

async function download(row, plex) {
  mkdirSync(DIR, { recursive: true });
  if (!plex.base) await plex.connect();
  const url = plex.fileUrl(row.media_path);
  const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30000) });
  if (!head.ok) throw new Error(`HTTP ${head.status}`);
  const size = Number(head.headers.get("content-length")) || 0;
  if (!size) throw new Error("the server didn't say how big the file is");
  if (size > gb(config.player.spool_max_file_gb)) {
    throw new Error(`${(size / gb(1)).toFixed(1)} GB is over spool_max_file_gb; it plays without subtitles`);
  }
  prune(size);
  const f = fileFor(row);
  const part = `${f}.part`;
  const out = openSync(part, "w");
  const t0 = Date.now();
  try {
    for (let pos = 0; pos < size; ) {
      const end = Math.min(size, pos + CHUNK) - 1;
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await fetch(url, { headers: { Range: `bytes=${pos}-${end}` }, signal: AbortSignal.timeout(120000) });
          if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length !== end - pos + 1) throw new Error(`short read (${buf.length} bytes)`);
          writeSync(out, buf, 0, buf.length, pos);
          pos += buf.length;
          // Stay under spool_max_mbps so the live stream (read from the same server)
          // keeps enough of the Plex server's upload.
          const due = ((pos * 8) / (config.player.spool_max_mbps * 1e6)) * 1000 - (Date.now() - t0);
          if (due > 0) await sleep(due);
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          await sleep(2000 * attempt);
        }
      }
    }
  } finally {
    closeSync(out);
  }
  renameSync(part, f);
  const secs = (Date.now() - t0) / 1000;
  log.info(`spool: downloaded ${row.show_title ? `${row.show_title} S${row.season}E${row.episode}` : row.title} ` +
    `(${(size / gb(1)).toFixed(2)} GB in ${Math.round(secs)} s, ${((size * 8) / secs / 1e6).toFixed(0)} Mbps) for subtitles`);
}

// Make room: drop copies not used for a while, then the least recently used ones until
// `incoming` more bytes fit under the cap.
function prune(incoming = 0) {
  const files = readdirSync(DIR).filter((n) => !n.endsWith(".part")).map((n) => {
    const p = join(DIR, n);
    const st = statSync(p);
    return { p, size: st.size, used: st.mtimeMs };
  }).sort((a, b) => a.used - b.used);
  let total = files.reduce((n, f) => n + f.size, 0);
  const cap = gb(config.player.spool_max_gb);
  for (const f of files) {
    if (Date.now() - f.used < KEEP_MS && total + incoming <= cap) break;
    try {
      rmSync(f.p);
      total -= f.size;
    } catch { /* being played right now: keep it */ }
  }
}

// On startup: throw away half-finished downloads and anything stale.
export function cleanSpool() {
  if (!existsSync(DIR)) return;
  for (const n of readdirSync(DIR)) if (n.endsWith(".part")) rmSync(join(DIR, n), { force: true });
  prune();
}
