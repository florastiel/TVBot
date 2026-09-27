// Turns forecasts into a weather video: one clean static board (every place, its next few
// hours side by side - see board.js) under a voice-over that hands each place to a different
// TTS voice (see voices.js). No RVC character-voice conversion, no radar map, no per-place
// news-style scenes - just the board, read over, once.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, DATA_DIR, ROOT } from "../config.js";
import { log } from "../log.js";
import { spoken } from "./forecast.js";
import { choosePresenters } from "./voices.js";
import { closeBrowser, renderBoard } from "./board.js";

const FFMPEG = () => process.env.FFMPEG_PATH || join(ROOT, "tools", "ffmpeg", "bin", "ffmpeg.exe");
const FFPROBE = () => FFMPEG().replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
export const WEATHER_DIR = join(DATA_DIR, "weather");

// "edge:<voice>" (Microsoft/Azure neural, via edge-tts), "google:<lang>" (Google Translate TTS),
// or a bare Windows SAPI voice name. Falls back down this same chain on failure.
async function speak(dir, id, script, voiceSpec) {
  const v = String(voiceSpec || "edge:en-US-AriaNeural");
  if (/^edge:/i.test(v)) {
    try { return edgeSpeak(dir, id, script, v.slice(5).trim() || "en-US-AriaNeural"); }
    catch (e) { log.warn(`weather: Edge voice failed (${e.message}); using Google`); }
    try { return await googleSpeak(dir, id, script, "en"); }
    catch (e) { log.warn(`weather: Google voice failed (${e.message}); using the Windows voice`); }
  } else if (/^google:/i.test(v)) {
    try { return await googleSpeak(dir, id, script, v.slice(7).trim() || "en"); }
    catch (e) { log.warn(`weather: Google voice failed (${e.message}); using the Windows voice`); }
  }
  return sapiSpeak(dir, id, script, /^edge:|^google:/i.test(v) ? "Microsoft Zira Desktop" : v);
}

// Sentences packed into pieces of at most `max` characters (Google's limit is about 200).
function pieces(script, max = 180) {
  const out = [];
  for (const s of script.split(/(?<=[.!?])\s+/)) {
    let rest = s;
    while (rest.length > max) {
      const cut = Math.max(rest.lastIndexOf(",", max), rest.lastIndexOf(" ", max));
      out.push(rest.slice(0, cut > 40 ? cut : max));
      rest = rest.slice(cut > 40 ? cut + 1 : max).trim();
    }
    if (out.length && rest && (out.at(-1) + " " + rest).length <= max) out[out.length - 1] += " " + rest;
    else if (rest) out.push(rest);
  }
  return out;
}

async function googleSpeak(dir, id, script, lang) {
  const files = [];
  for (const [i, chunk] of pieces(script).entries()) {
    let buf;
    for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
      try {
        const res = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(chunk)}`,
          { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, signal: AbortSignal.timeout(20000) });
        if (res.ok) buf = Buffer.from(await res.arrayBuffer());
      } catch { /* try again */ }
      if (!buf) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    if (!buf?.length) throw new Error(`no audio for "${chunk.slice(0, 30)}..."`);
    const f = join(dir, `${id}_${i}.mp3`);
    writeFileSync(f, buf);
    files.push(f);
  }
  const list = join(dir, `${id}_list.txt`);
  writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
  const wav = join(dir, `${id}.wav`);
  const r = spawnSync(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-ar", "48000", "-ac", "2", wav], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (r.status !== 0) throw new Error(`joining the voice pieces: ${String(r.stderr).trim().split("\n").pop()}`);
  const d = execFileSync(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], { encoding: "utf8" });
  return { wav, seconds: Number(d.trim()) };
}

// Microsoft Edge's online neural voices via the edge-tts in the RVC venv (still used just for
// this - not for voice conversion anymore). weather.rate (-10..10) maps to a +-% speed change.
function edgeSpeak(dir, id, script, voice) {
  const exe = join(ROOT, "tools", "rvc", "venv312", "Scripts", "edge-tts.exe");
  if (!existsSync(exe)) throw new Error("edge-tts is not installed");
  const mp3 = join(dir, `${id}_edge.mp3`);
  const wav = join(dir, `${id}.wav`);
  const pct = (config.weather?.rate ?? 0) * 3 + 8;
  const args = ["--voice", voice, `--rate=${pct >= 0 ? "+" : ""}${pct}%`, "--text", script, "--write-media", mp3];
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: 120000, windowsHide: true });
  if (r.status !== 0 || !existsSync(mp3)) throw new Error(String(r.stderr || r.error || "no audio").trim().split("\n").pop());
  const c = spawnSync(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-i", mp3, "-ar", "48000", "-ac", "2", wav], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (c.status !== 0) throw new Error(`converting the voice: ${String(c.stderr).trim().split("\n").pop()}`);
  const d = execFileSync(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], { encoding: "utf8" });
  return { wav, seconds: Number(d.trim()) };
}

function sapiSpeak(dir, id, script, voice) {
  const textFile = join(dir, `${id}.txt`);
  const wav = join(dir, `${id}.wav`);
  writeFileSync(textFile, script, "utf8");
  const ps = join(ROOT, "scripts", "weather-tts.ps1");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, "-TextFile", textFile, "-Out", wav,
    "-Voice", voice || "Microsoft Zira Desktop", "-Rate", String(config.weather?.rate ?? 0)], { timeout: 120000, windowsHide: true });
  const d = execFileSync(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], { encoding: "utf8" });
  return { wav, seconds: Number(d.trim()) };
}

function silenceWav(dir, seconds) {
  const wav = join(dir, `sil_${Math.random().toString(36).slice(2)}.wav`);
  spawnSync(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(seconds), "-ar", "48000", "-ac", "2", wav],
    { encoding: "utf8", timeout: 20000, windowsHide: true });
  return wav;
}

const SIGNOFF = ["That's your weather. Back to the show.", "That's the forecast. Enjoy the rest of your day."];
const stamp = () => new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

// places: fetchPlace() results. Returns { file, durationMs, places, presenters }.
export async function renderReport(places, greeting, slotKey) {
  mkdirSync(WEATHER_DIR, { recursive: true });
  const work = join(WEATHER_DIR, "work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const presenters = choosePresenters(places.length);
  const clips = [];
  for (const [i, place] of places.entries()) {
    const me = presenters[i];
    let script = "";
    if (i === 0) script += `${greeting}, everybody. Here's your weather. `;
    script += spoken(place);
    if (i === places.length - 1) script += ` ${SIGNOFF[Math.floor(Math.random() * SIGNOFF.length)]}`;
    try {
      const { wav, seconds } = await speak(work, `s${i}`, script, me?.speak);
      clips.push({ wav, seconds });
    } catch (e) {
      log.warn(`weather: couldn't voice ${place.name} (${e.message}); skipping its line`);
    }
  }
  if (!clips.length) throw new Error("no voice-over could be generated");

  // One continuous track: each place's clip, a short beat of silence between.
  const list = join(work, "audio_list.txt");
  const lines = [];
  clips.forEach((c, i) => {
    lines.push(`file '${c.wav.replace(/\\/g, "/")}'`);
    if (i < clips.length - 1) lines.push(`file '${silenceWav(work, 0.5).replace(/\\/g, "/")}'`);
  });
  writeFileSync(list, lines.join("\n"));
  const audio = join(work, "audio.wav");
  const j = spawnSync(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-ar", "48000", "-ac", "2", audio], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (j.status !== 0) throw new Error(`joining the voice-over: ${String(j.stderr).trim().split("\n").pop()}`);
  const totalSeconds = Number(execFileSync(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio], { encoding: "utf8" }).trim());

  const board = await renderBoard(places, stamp(), work);
  const file = join(WEATHER_DIR, `report-${slotKey.replace(/[^0-9]/g, "")}.mp4`);
  const dur = (totalSeconds + 0.8).toFixed(2);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", board, "-i", audio,
    "-t", dur, "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-shortest", file];
  const r = spawnSync(FFMPEG(), args, { encoding: "utf8", timeout: 120000, windowsHide: true });
  if (r.status !== 0) throw new Error(`weather render: ${String(r.stderr).trim().split("\n").slice(-4).join(" / ")}`);

  for (const f of readdirSync(WEATHER_DIR).filter((x) => /^report-.*\.mp4$/.test(x)).sort((a, b) => statSync(join(WEATHER_DIR, b)).mtimeMs - statSync(join(WEATHER_DIR, a)).mtimeMs).slice(4)) rmSync(join(WEATHER_DIR, f), { force: true });
  const durationMs = Math.round((totalSeconds + 0.8) * 1000);
  log.info(`weather: made ${file.replace(/^.*[\\/]/, "")}, ${(durationMs / 1000).toFixed(0)} s, ${places.length} places`);
  return { file, durationMs, places: places.map((p) => p.name), presenters: presenters.map((p) => p?.name).filter(Boolean) };
}

export { closeBrowser };
