// Play a short sound through the streamer account's "microphone" (its voice
// connection), so everyone in the channel hears it, not just stream viewers.
// Used for the TV-time jingle and entrance sounds.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { demux } from "@dank074/discord-video-stream";
import { config, DATA_DIR } from "../config.js";
import { log } from "../log.js";

const run = promisify(execFile);
const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const CACHE = join(DATA_DIR, "sounds");
// Stereo before measuring: a mono file measures ~3 dB quieter than it plays as stereo.
const TRIM = "aformat=channel_layouts=stereo,silenceremove=start_periods=1:start_threshold=-45dB";
const prepared = new WeakSet();

// Turn any audio/video file into a ready-to-send sound: leading silence trimmed, cut
// to max length, and set to one fixed loudness so nobody's sound is ear-splitting.
// Cached, so playing it later starts instantly.
export async function prepareSound(file) {
  const { max_seconds: maxSec, loudness_lufs: target } = config.entrance;
  const st = statSync(file);
  const key = createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}|${maxSec}|${target}`).digest("hex").slice(0, 16);
  mkdirSync(CACHE, { recursive: true });
  const out = join(CACHE, `${key}.nut`);
  if (existsSync(out)) return out;

  // Measure loudness, then apply one fixed gain (keeps the sound's own dynamics).
  const { stderr } = await run(FFMPEG(), ["-hide_banner", "-nostats", "-i", file, "-vn", "-t", String(maxSec),
    "-af", `${TRIM},ebur128`, "-f", "null", "-"]);
  const measured = Number(stderr.match(/Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS/)?.[1]);
  const gain = Number.isFinite(measured) && measured > -70 ? target - measured : 0;
  const tmp = `${out}.tmp`;
  await run(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-t", String(maxSec),
    "-af", `${TRIM},volume=${gain.toFixed(1)}dB,alimiter=limit=0.7:level=false`,
    "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2", "-frame_duration", "20", "-f", "nut", tmp]);
  renameSync(tmp, out);
  log.info(`mic: prepared ${file} (${Number.isFinite(measured) ? measured.toFixed(1) : "?"} LUFS -> ${target}, gain ${gain.toFixed(1)} dB)`);
  return out;
}

async function readyConn(streamer) {
  // Right after joining, the voice connection takes a moment to finish connecting.
  for (let waited = 0; waited < 10000; waited += 100) {
    const conn = streamer.voiceConnection?.webRtcConn;
    if (conn?.ready) return conn;
    await sleep(100);
  }
  return null;
}

export async function playMic(streamer, file) {
  const sound = await prepareSound(file);
  const conn = await readyConn(streamer);
  if (!conn) {
    log.warn("mic: voice connection never became ready; sound skipped");
    return false;
  }
  // The library only builds the voice connection's audio sender when a camera stream
  // starts; build it ourselves (the video half stays unused).
  if (!prepared.has(conn)) {
    conn.setPacketizer("H264");
    prepared.add(conn);
  }

  const { audio } = await demux(createReadStream(sound), { format: "nut" });
  if (!audio) return false;
  conn.mediaConnection.setSpeaking(true);
  const start = performance.now();
  let frames = 0;
  try {
    for await (const pkt of audio.stream) {
      if (pkt.data) {
        const tb = pkt.timeBase;
        const frametime = (Number(pkt.duration) * tb.num * 1000) / tb.den;
        const pts = (Number(pkt.pts) * tb.num * 1000) / tb.den;
        conn.sendAudioFrame(Buffer.from(pkt.data), frametime);
        frames++;
        // Real-time pacing: don't send faster than it plays.
        const ahead = pts - (performance.now() - start);
        if (ahead > 0) await sleep(ahead);
      }
      pkt.free?.();
    }
  } finally {
    conn.mediaConnection.setSpeaking(false);
    log.info(`mic: played ${((performance.now() - start) / 1000).toFixed(1)}s (${frames} frames) of ${file}`);
  }
  return true;
}
