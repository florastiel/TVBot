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
export const encoderState = { qsvBroken: false, hwDecodeBroken: false };
export const usingHwDecode = () => config.encode.hw_decode && !encoderState.hwDecodeBroken;
export const usingQsv = () => config.encode.encoder === "qsv" && !encoderState.qsvBroken;
const pixFmt = () => (usingQsv() ? "nv12" : "yuv420p");

function videoCodecArgs() {
  const { bitrate_kbps: b, max_bitrate_kbps: max } = config.encode;
  const rate = ["-b:v", `${b}k`, "-maxrate:v", `${max}k`, "-bufsize:v", `${Math.round(b / 2)}k`];
  // A real keyframe (IDR) every second and no B-frames: what Discord's receiver expects. A
  // viewer who joins, or whose player lost a packet, can only pick the picture up at the next
  // keyframe, so the interval is how long they see black / a buffering circle. -g sets it;
  // -force_key_frames alone is ignored by Quick Sync (it was 8.5 s, measured 2026-09-26).
  const common = ["-bf", "0", "-g", String(config.encode.frame_rate)];
  if (usingQsv()) return ["-c:v", "h264_qsv", "-preset", "veryfast", "-look_ahead", "0", ...rate, ...common];
  // (x264: a fixed 1 s GOP, no extra scene-cut keyframes.)
  return ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", ...rate, ...common, "-keyint_min", String(config.encode.frame_rate), "-sc_threshold", "0"];
}

// Paths inside an ffmpeg filter (always inside '...') need ':' and '\' escaped; a path
// relative to the project avoids the drive letter entirely. An apostrophe ("Bob's
// Burgers") can't be escaped inside quotes: end the quote, add an escaped one, reopen.
const filterPath = (p) => relative(ROOT, p).replaceAll("\\", "/").replace(/([:\[\],;])/g, "\\$1").replaceAll("'", "\\'\\''");

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
  if (usingHwDecode()) args.push("-hwaccel", "auto");
  if (seek) args.push("-ss", seek.toFixed(3));
  args.push("-i", seg.input);
  const silent = seg.audioStream === null || seg.audioStream === undefined;
  if (silent) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");

  // HDR (PQ/HLG) source: Discord's stream carries no HDR metadata, so without this a
  // viewer's player renders the raw PQ values as SDR gamma and it comes out washed out.
  // Tone-map to SDR/bt709 before the usual scale/pad chain.
  // Downscale BEFORE tone-mapping: the float zscale/tonemap chain is brutal at 4K/8K
  // (an 8K "AI upscale" used to eat 6+ GB and run far slower than realtime) but cheap at 720p.
  const hdrToSdr = seg.hdr ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv," : "";
  // force_divisible_by: a wide HDR movie (2.39:1) scales to an odd height, and zscale
  // refuses "image dimensions must be divisible by subsampling factor" - the item then
  // fails instantly and the player skips it (Alien, 2026-10-09).
  const shrink = `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,`;
  const fit = `${seg.hdr ? shrink + hdrToSdr : ""}${seg.hdr ? "" : shrink}pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=${pixFmt()}`;
  let graph;
  if (seg.subs?.mode === "image") {
    // Picture subtitles are drawn at the source resolution, bottom-centered, then scaled with the video.
    // Shrink the video first and scale the bitmap by the same factor (assumes its canvas matches
    // the video), so the overlay happens at output size instead of 4K/8K.
    graph = `[0:V:0]${shrink}setsar=1[vs];[0:${seg.subs.index}]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bilinear,format=rgba[ss];` +
      `[vs][ss]overlay=(W-w)/2:H-h[s];[s]${fit}[v]`;
  } else if ((seg.subs?.mode === "sidecar" || seg.subs?.mode === "embedded_text") && seg.subsFile) {
    // After an input seek the video restarts at 0 but the subtitle file doesn't, so
    // shift the clock forward for the subtitle renderer and back again afterwards.
    const si = seg.subs.mode === "embedded_text" ? `:si=${seg.subs.pos ?? 0}` : "";
    // MP4 (mov_text) subtitles carry a pixel font size meant for the video's own height,
    // but ffmpeg reads it against a ~288-line reference: 54 comes out ~19% of the frame.
    const style = seg.subs.codec === "mov_text" ? ":force_style='Fontsize=18'" : "";
    const sub = `subtitles=filename='${filterPath(seg.subsFile)}'${si}${style}:fontsdir='C\\:/Windows/Fonts'`;
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

  // A measured gain (commercials, clips, eyecatches): stereo first so a mono file is
  // boosted by the same amount it was measured at, and a limiter so a boost can't clip.
  if (!silent && Number.isFinite(seg.gainDb) && seg.gainDb !== 0) {
    args.push("-filter:a", `aformat=channel_layouts=stereo,volume=${seg.gainDb.toFixed(1)}dB,alimiter=limit=0.89:level=false`);
  }

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
