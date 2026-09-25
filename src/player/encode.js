// ffmpeg arguments for one item (show, commercial, clip). Every item is encoded to the
// exact same format (fixed frame size, frame rate, audio layout) as MPEG-TS with its
// timestamps shifted to continue where the previous item ended, so the items can be
// concatenated into one unbroken stream and Go Live never has to restart.
import { relative, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { config, ROOT, DATA_DIR } from "../config.js";

export function frameSize() {
  const h = config.encode.height;
  return { w: Math.round((h * 16) / 9 / 2) * 2, h };
}

// Set by the feed if Quick Sync fails; from then on this process encodes on the CPU.
export const encoderState = { qsvBroken: false };
export const usingQsv = () => config.encode.encoder === "qsv" && !encoderState.qsvBroken;
const pixFmt = () => (usingQsv() ? "nv12" : "yuv420p");

function videoCodecArgs() {
  const { bitrate_kbps: b, max_bitrate_kbps: max } = config.encode;
  const rate = ["-b:v", `${b}k`, "-maxrate:v", `${max}k`, "-bufsize:v", `${Math.round(b / 2)}k`];
  // Keyframe every second and no B-frames: what Discord's receiver expects.
  const common = ["-bf", "0", "-force_key_frames", "expr:gte(t,n_forced*1)"];
  if (usingQsv()) return ["-c:v", "h264_qsv", "-preset", "veryfast", "-look_ahead", "0", ...rate, ...common];
  return ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", ...rate, ...common];
}

// Paths inside an ffmpeg filter need ':' and '\' escaped; a path relative to the
// project avoids the drive letter entirely.
const filterPath = (p) => relative(ROOT, p).replaceAll("\\", "/").replace(/([:'\[\],;])/g, "\\$1");

/**
 * seg: { input, seekMs, durationMs, audioStream, subs, subsFile }
 * offsetSec: where this item's timestamps start in the continuous stream
 */
export function itemArgs(seg, offsetSec) {
  const { w, h } = frameSize();
  const fps = config.encode.frame_rate;
  const seek = (seg.seekMs || 0) / 1000;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats"];

  if (seg.kind === "card" || typeof seg.card === "string") return cardArgs(seg, offsetSec); // even a blank card
  if (/^https?:/i.test(seg.input)) {
    // Retry on network hiccups, but NOT at end of file (-reconnect_at_eof makes ffmpeg
    // hang for ~17 minutes after every Plex file; see README).
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1",
      "-reconnect_delay_max", "10", "-rw_timeout", "20000000");
  }
  if (config.encode.hw_decode) args.push("-hwaccel", "auto");
  if (seek) args.push("-ss", seek.toFixed(3));
  args.push("-i", seg.input);
  const silent = seg.audioStream === null || seg.audioStream === undefined;
  if (silent) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");

  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=${pixFmt()}`;
  let graph;
  if (seg.subs?.mode === "image") {
    // Picture subtitles are drawn at the source resolution, bottom-centered, then scaled with the video.
    graph = `[0:V:0][0:${seg.subs.index}]overlay=(W-w)/2:H-h[s];[s]${fit}[v]`;
  } else if ((seg.subs?.mode === "sidecar" || seg.subs?.mode === "embedded_text") && seg.subsFile) {
    // After an input seek the video restarts at 0 but the subtitle file doesn't, so
    // shift the clock forward for the subtitle renderer and back again afterwards.
    const si = seg.subs.mode === "embedded_text" ? `:si=${seg.subs.pos ?? 0}` : "";
    const sub = `subtitles=filename='${filterPath(seg.subsFile)}'${si}:fontsdir='C\\:/Windows/Fonts'`;
    graph = seek
      ? `[0:V:0]setpts=PTS+${seek.toFixed(3)}/TB,${sub},setpts=PTS-STARTPTS,${fit}[v]`
      : `[0:V:0]${sub},${fit}[v]`;
  } else {
    graph = `[0:V:0]${fit}[v]`;
  }
  args.push("-filter_complex", graph, "-map", "[v]", "-map", silent ? "1:a:0" : `0:${seg.audioStream}`);

  const remaining = seg.durationMs ? seg.durationMs / 1000 - seek : null;
  if (remaining) args.push("-t", Math.max(0.5, remaining).toFixed(3));
  else if (silent) args.push("-shortest");

  args.push(...videoCodecArgs(),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "-output_ts_offset", offsetSec.toFixed(3),
    "pipe:1");
  return args;
}

// A plain text card: dark background, white text, silence.
function cardArgs(seg, offsetSec) {
  const { w, h } = frameSize();
  const dir = join(DATA_DIR, "cards");
  mkdirSync(dir, { recursive: true });
  // Text goes in a file so no escaping of titles is needed.
  const file = join(dir, `${createHash("sha1").update(seg.card).digest("hex").slice(0, 12)}.txt`);
  writeFileSync(file, seg.card || " ");
  const font = "C\\:/Windows/Fonts/arialbd.ttf";
  const text = `drawtext=fontfile='${font}':textfile='${filterPath(file)}':fontsize=${Math.round(h / 12)}:fontcolor=white:line_spacing=${Math.round(h / 30)}:text_align=C:x=(w-text_w)/2:y=(h-text_h)/2`;
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats",
    "-f", "lavfi", "-i", `color=c=0x14142a:s=${w}x${h}:r=${config.encode.frame_rate},${text},format=${pixFmt()}`,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-map", "0:v", "-map", "1:a", "-t", (seg.durationMs / 1000).toFixed(3),
    ...videoCodecArgs(), "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "-output_ts_offset", offsetSec.toFixed(3), "pipe:1"];
}

// Joins the per-item MPEG-TS chunks into the single stream handed to Discord.
// Video is passed through untouched; audio becomes Opus, which is what Discord carries.
export function outerArgs() {
  return ["-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "mpegts", "-analyzeduration", "2000000", "-i", "pipe:0",
    "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy", "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-f", "nut", "pipe:1"];
}
