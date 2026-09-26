// Finds a show's original commercial-break points: a moment where the picture goes black
// and the sound goes silent together (how TV episodes fade out to ads). One ffmpeg pass
// over a local file (a local show, or a Plex file downloaded ahead), at low priority so
// the live stream always wins the CPU. Results are saved on the item as ad_cues (ms).
import { spawn } from "node:child_process";
import { setPriority, constants } from "node:os";
import { getDb } from "../db.js";
import { log } from "../log.js";

const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const EDGE_MS = 60000;  // ignore the first/last minute (cold open fade-ins, credits)
const MERGE_MS = 60000; // black+silence moments closer than this are one break

// ms positions of black+silence moments in the file.
export function detectBreaks(file, { audioStream = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostats", "-threads", "2", "-i", file,
      "-map", "0:v:0", "-map", audioStream != null ? `0:${audioStream}` : "0:a:0",
      "-vf", "scale=160:-2,blackdetect=d=0.25:pix_th=0.10",
      "-af", "silencedetect=noise=-45dB:d=0.25",
      "-f", "null", "-"];
    const p = spawn(FFMPEG(), args, { windowsHide: true });
    try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine */ }
    let err = "";
    p.stderr.on("data", (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.split("\n").filter(Boolean).slice(-1)[0] || ""}`));
      const black = [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [+m[1] * 1000, +m[2] * 1000]);
      const silence = [];
      let open = null;
      for (const m of err.matchAll(/silence_(start|end): ([\d.]+)/g)) {
        if (m[1] === "start") open = +m[2] * 1000;
        else if (open !== null) { silence.push([open, +m[2] * 1000]); open = null; }
      }
      const dur = +(err.match(/Duration: (\d+):(\d+):([\d.]+)/)?.slice(1).reduce((t, x) => t * 60 + +x, 0) || 0) * 1000;
      const cues = [];
      for (const [b0, b1] of black) {
        if (!silence.some(([s0, s1]) => s0 < b1 && s1 > b0)) continue;
        const at = Math.round((b0 + b1) / 2);
        if (at < EDGE_MS || (dur && at > dur - EDGE_MS)) continue;
        if (cues.length && at - cues.at(-1) < MERGE_MS) continue;
        cues.push(at);
      }
      resolve(cues);
    });
  });
}

// Detect and save, unless this version of the file was already checked.
export async function detectAndSave(row, file) {
  if (row.ad_cues_checked != null && row.ad_cues_checked === row.source_updated) return;
  const t0 = Date.now();
  const cues = await detectBreaks(file, { audioStream: row.audio_stream });
  getDb().prepare("UPDATE items SET ad_cues = ?, ad_cues_checked = ? WHERE id = ?").run(JSON.stringify(cues), row.source_updated ?? 0, row.id);
  row.ad_cues = JSON.stringify(cues);
  row.ad_cues_checked = row.source_updated ?? 0;
  const name = row.show_title ? `${row.show_title} S${row.season}E${row.episode}` : row.title;
  log.info(`breaks: ${name}: ${cues.length ? cues.map((c) => `${Math.floor(c / 60000)}:${String(Math.round(c / 1000) % 60).padStart(2, "0")}`).join(", ") : "none found"} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
