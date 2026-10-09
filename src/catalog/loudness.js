// Measures how loud a commercial, clip or eyecatch is (integrated loudness, LUFS) so the
// player can bring every one to the same level (broadcast.ad_loudness_lufs). One audio-only
// ffmpeg pass over the local file, at low priority so the live stream always wins the CPU.
// Saved on the item as loudness_lufs; the gain itself is worked out at play time (adGainDb),
// so changing the target never needs a re-measure.
import { spawn } from "node:child_process";
import { setPriority, constants } from "node:os";
import { getDb } from "../db.js";
import { config } from "../config.js";
import { log } from "../log.js";

const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const MAX_BOOST_DB = 15; // a very quiet file isn't worth hissing up further than this
const MAX_CUT_DB = 20;

// Integrated loudness of the file's audio, or null when there's nothing to measure
// (no audio, silence, or shorter than the 400 ms the measurement needs).
export function measureLoudness(file, { audioStream = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostats", "-threads", "1", "-i", file, "-vn",
      "-map", audioStream != null ? `0:${audioStream}` : "0:a:0",
      // Stereo first: a mono file measures ~3 dB quieter than it plays once it's stereo.
      "-af", "aformat=channel_layouts=stereo,ebur128", "-f", "null", "-"];
    const p = spawn(FFMPEG(), args, { windowsHide: true });
    try { setPriority(p.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine */ }
    let err = "";
    p.stderr.on("data", (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.split("\n").filter(Boolean).slice(-1)[0] || ""}`));
      // The summary at the very end ("Integrated loudness:\n    I:         -23.4 LUFS").
      const m = [...err.matchAll(/Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS/g)].at(-1);
      const lufs = m ? Number(m[1]) : NaN;
      resolve(Number.isFinite(lufs) && lufs > -70 ? lufs : null);
    });
  });
}

// Measure and save, unless this version of the file was already measured.
export async function measureAndSave(row) {
  if (row.loudness_checked != null && row.loudness_checked === row.source_updated) return;
  const lufs = await measureLoudness(row.source_key, { audioStream: row.audio_stream });
  getDb().prepare("UPDATE items SET loudness_lufs = ?, loudness_checked = ? WHERE id = ?").run(lufs, row.source_updated ?? 0, row.id);
  row.loudness_lufs = lufs;
  row.loudness_checked = row.source_updated ?? 0;
}

// Measure every present local spot (commercial/clip/eyecatch) that hasn't been yet.
export async function measureSpots() {
  if (!adTarget()) return;
  const todo = getDb().prepare(`SELECT id, source_key, source_updated, audio_stream, title, loudness_checked FROM items
    WHERE source = 'local' AND present = 1 AND playable = 1 AND kind IN ('commercial', 'clip', 'eyecatch')
      AND (loudness_checked IS NULL OR loudness_checked != source_updated)`).all();
  if (!todo.length) return;
  const t0 = Date.now();
  let done = 0;
  const worker = async () => {
    for (let r; (r = todo.shift()); ) {
      try {
        await measureAndSave(r);
        done++;
      } catch (e) {
        if (e.code === "ENOENT") { log.warn(`loudness: ffmpeg isn't runnable (${e.message.split("\n")[0]}); will retry next sync`); return; }
        // A file we can't read: mark it measured (no loudness) so it isn't retried every sync.
        getDb().prepare("UPDATE items SET loudness_lufs = NULL, loudness_checked = ? WHERE id = ?").run(r.source_updated ?? 0, r.id);
        log.warn(`loudness: couldn't measure ${r.source_key}: ${e.message.split("\n")[0]}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  log.info(`loudness: measured ${done} spots (${Math.round((Date.now() - t0) / 1000)} s)`);
}

// broadcast.ad_loudness_lufs as a number, or null when it's off (blank / "off" / 0).
export function adTarget() {
  const t = Number(config.broadcast.ad_loudness_lufs);
  return Number.isFinite(t) && t < 0 ? t : null;
}

// dB to apply to a spot so it airs at the target; 0 when unmeasured or normalizing is off.
export function adGainDb(row) {
  const target = adTarget();
  if (target === null || row.loudness_lufs == null) return 0;
  const gain = Math.min(MAX_BOOST_DB, Math.max(-MAX_CUT_DB, target - row.loudness_lufs));
  return Math.abs(gain) < 0.3 ? 0 : gain;
}
