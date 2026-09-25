// Play a short sound through the streamer account's "microphone" (its voice
// connection), so everyone in the channel hears it, not just stream viewers.
// Used for the TV-time jingle and entrance sounds.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { demux } from "@dank074/discord-video-stream";
import { log } from "../log.js";

const prepared = new WeakSet();

export async function playMic(streamer, file, maxSeconds = 8) {
  const conn = streamer.voiceConnection?.webRtcConn;
  if (!conn?.ready) return false;
  // The library only builds the voice connection's audio sender when a camera stream
  // starts; build it ourselves (the video half stays unused).
  if (!prepared.has(conn)) {
    conn.setPacketizer("H264");
    prepared.add(conn);
  }

  const ff = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-t", String(maxSeconds), "-vn",
    "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2", "-frame_duration", "20", "-f", "nut", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  ff.stderr.on("data", (d) => log.warn(`mic: ${String(d).trim()}`));

  const { audio } = await demux(ff.stdout, { format: "nut" });
  if (!audio) return false;
  conn.mediaConnection.setSpeaking(true);
  const start = performance.now();
  try {
    for await (const pkt of audio.stream) {
      if (pkt.data) {
        const tb = pkt.timeBase;
        const frametime = (Number(pkt.duration) * tb.num * 1000) / tb.den;
        const pts = (Number(pkt.pts) * tb.num * 1000) / tb.den;
        conn.sendAudioFrame(Buffer.from(pkt.data), frametime);
        // Real-time pacing: don't send faster than it plays.
        const ahead = pts - (performance.now() - start);
        if (ahead > 0) await sleep(ahead);
      }
      pkt.free?.();
    }
  } finally {
    conn.mediaConnection.setSpeaking(false);
    ff.kill();
  }
  return true;
}
