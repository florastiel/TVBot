// Turns forecasts into a weather video: for each place a scene (its NWS radar loop, the
// next few periods as cards, an alert banner if there is one) read by a built-in Windows
// voice, joined into one mp4.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants, setPriority as osSetPriority } from "node:os";
import { join } from "node:path";
import { config, DATA_DIR, ROOT } from "../config.js";
import { log } from "../log.js";
import { handoff, spoken, thanks } from "./forecast.js";

const FFMPEG = () => process.env.FFMPEG_PATH || join(ROOT, "tools", "ffmpeg", "bin", "ffmpeg.exe");
const FFPROBE = () => FFMPEG().replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
const FONT = "C\\:/Windows/Fonts/arialbd.ttf";
export const WEATHER_DIR = join(DATA_DIR, "weather");

// A path inside a filter graph: forward slashes, the drive colon escaped.
const fp = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
let n = 0;

function text(dir, s, { size, color = "white", x, y }) {
  const file = join(dir, `t${++n}.txt`);
  writeFileSync(file, s, "utf8");
  return `drawtext=fontfile='${FONT}':textfile='${fp(file)}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`;
}

// extra: { presenter: "Mr. Krabs", caption: "Handing off to Deku", captionAt: seconds }
function sceneGraph(place, dir, hasRadar, extra = {}) {
  const f = [];
  f.push(hasRadar ? "[1:v]fps=30,scale=-2:680,format=rgb24[radar];[0:v][radar]overlay=x=W-w-20:y=20[b]" : "[0:v]null[b]");
  const chain = [];
  chain.push("drawbox=x=40:y=34:w=196:h=46:color=0xd62828@1:t=fill");
  chain.push(text(dir, "WEATHER", { size: 30, x: 56, y: 42 }));
  if (extra.presenter) chain.push(text(dir, `with ${extra.presenter}`, { size: 28, color: "0xffd166", x: 254, y: 44 }));
  if (extra.caption) {
    const on = `enable='gte(t\\,${extra.captionAt.toFixed(2)})'`;
    chain.push(`drawbox=x=540:y=572:w=720:h=62:color=0x000000@0.78:t=fill:${on}`);
    chain.push(text(dir, extra.caption, { size: 34, color: "0xffd166", x: 562, y: 586 }).replace(":expansion=none", `:expansion=none:${on}`));
  }
  chain.push(text(dir, place.name, { size: place.name.length > 22 ? 34 : 42, x: 40, y: 92 }));
  place.periods.slice(0, 3).forEach((p, i) => {
    const y0 = 156 + i * 150;
    chain.push(`drawbox=x=30:y=${y0}:w=490:h=136:color=0x000000@0.4:t=fill`);
    chain.push(text(dir, p.name.toUpperCase(), { size: 24, color: "0x9fc5ff", x: 48, y: y0 + 10 }));
    chain.push(text(dir, `${p.temp}°`, { size: 64, x: 48, y: y0 + 38 }));
    chain.push(text(dir, p.short.slice(0, 34), { size: 24, x: 48, y: y0 + 106 }));
    if (p.pop > 0) chain.push(text(dir, `${p.pop}% precip`, { size: 30, color: "0x7fd0ff", x: 300, y: y0 + 60 }));
  });
  if (place.alerts.length) {
    chain.push("drawbox=x=0:y=648:w=1280:h=72:color=0xc1121f@0.92:t=fill");
    chain.push(text(dir, place.alerts.join("   |   ").toUpperCase(), { size: 36, x: 40, y: 664 }));
  }
  chain.push(text(dir, "Data: National Weather Service", { size: 18, color: "0x8aa0b8", x: 48, y: 612 }));
  f.push(`[b]${chain.join(",")},format=yuv420p[v]`);
  f.push("[2:a]apad[a]");
  return f.join(";");
}

// "google:fil" (the Google Translate voice, any language code) reads it; a Windows voice
// name reads it with SAPI. If Google can't be reached the Windows voice steps in.
async function speak(dir, id, script) {
  const v = String(config.weather?.voice || "");
  if (/^google:/i.test(v)) {
    try { return await googleSpeak(dir, id, script, v.slice(7).trim() || "en"); }
    catch (e) { log.warn(`weather: Google voice failed (${e.message}); using the Windows voice`); }
  }
  return sapiSpeak(dir, id, script);
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

function sapiSpeak(dir, id, script) {
  const textFile = join(dir, `${id}.txt`);
  const wav = join(dir, `${id}.wav`);
  writeFileSync(textFile, script, "utf8");
  const ps = join(ROOT, "scripts", "weather-tts.ps1");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, "-TextFile", textFile, "-Out", wav,
    "-Voice", config.weather?.voice || "Microsoft Zira Desktop", "-Rate", String(config.weather?.rate ?? 0)], { timeout: 120000, windowsHide: true });
  const d = execFileSync(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], { encoding: "utf8" });
  return { wav, seconds: Number(d.trim()) };
}

async function radarGif(station, dir) {
  if (!station) return null;
  try {
    const res = await fetch(`https://radar.weather.gov/ridge/standard/${station}_loop.gif`, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": "tvchannel-weather (personal Discord TV project)" } });
    if (!res.ok) return null;
    const file = join(dir, `${station}.gif`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch { return null; }
}

// Turn a spoken wav into a presenter's voice (Applio RVC on the CPU, at low priority so it
// can't get in the stream's way). voice: { model, pitch }. Returns { wav, seconds }.
async function convertVoice(dir, id, wav, voice) {
  const py = join(ROOT, "tools", "rvc", "venv312", "Scripts", "python.exe");
  if (!existsSync(py)) throw new Error("the voice environment isn't installed (tools\\rvc)");
  if (!/^[\w.-]+$/.test(String(voice.model))) throw new Error(`bad voice model name "${voice.model}"`);
  const mono = join(dir, `${id}_in.wav`);
  const m = spawnSync(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-ar", "44100", "-ac", "1", mono], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (m.status !== 0) throw new Error("couldn't prepare the audio for voice conversion");
  const prefix = join(dir, `${id}_rvc`);
  await new Promise((resolve, reject) => {
    const p = spawn(py, [join(ROOT, "scripts", "rvc-convert.py"), "--in", mono, "--out-prefix", prefix, "--voices", `${voice.model}:${Math.round(Number(voice.pitch ?? -12))}`],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    try { osSetPriority(p.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine at normal priority */ }
    let err = "";
    p.stdout.on("data", () => {});
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => { p.kill(); reject(new Error("voice conversion timed out")); }, 15 * 60000);
    p.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`voice conversion failed (${code}): ${err.trim().split("\n").pop()}`)); });
  });
  const out = `${prefix}_${voice.model}.wav`;
  const d = execFileSync(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" });
  return { wav: out, seconds: Number(d.trim()) };
}

const SIGNOFF = ["That's your weather. Now back to your regularly scheduled programming.", "And that's the weather. Enjoy the rest of your night.", "That's your forecast. Now back to the show."];

// places: fetchPlace() results. presenters: one { name, model, pitch } per place (their voices), or
// none for the plain voice. Returns { file, durationMs, places, presenters }.
export async function renderReport(places, greeting, slotKey, presenters = []) {
  mkdirSync(WEATHER_DIR, { recursive: true });
  const work = join(WEATHER_DIR, "work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const scenes = [];
  for (const [i, place] of places.entries()) {
    const me = presenters[i], prev = presenters[i - 1], next = presenters[i + 1];
    let script = "";
    if (i === 0) script += `${greeting}, everybody. ${me ? `I'm ${me.name}, and here's` : "Here's"} your weather. `;
    else if (prev) script += `${thanks(prev.name)} `;
    script += spoken(place) + " ";
    script += next ? handoff(next.name, places[i + 1].name) : SIGNOFF[Math.floor(Math.random() * SIGNOFF.length)];
    let { wav, seconds } = await speak(work, `s${i}`, script);
    let voiced = false;
    if (me) {
      try { ({ wav, seconds } = await convertVoice(work, `s${i}`, wav, me)); voiced = true; }
      catch (e) { log.warn(`weather: ${me.name}'s voice failed (${e.message}); this part uses the plain voice`); }
    }
    const gif = await radarGif(place.radar, work);
    const out = join(work, `scene${i}.mp4`);
    const dur = (seconds + 1.2).toFixed(2);
    const extra = { presenter: voiced ? me.name : null, caption: next ? `Handing off to ${next.name}` : null, captionAt: Math.max(0, seconds - 4.5) };
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x0b1d33:s=1280x720:r=30"];
    args.push(...(gif ? ["-ignore_loop", "0", "-i", gif] : ["-f", "lavfi", "-i", "color=c=black:s=16x16:r=30"]));
    args.push("-i", wav, "-filter_complex", sceneGraph(place, work, !!gif, extra), "-map", "[v]", "-map", "[a]", "-t", dur,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", out);
    const r = spawnSync(FFMPEG(), args, { encoding: "utf8", timeout: 240000, windowsHide: true });
    if (r.status !== 0) writeFileSync(join(work, "failed-args.json"), JSON.stringify(args));
    if (r.status !== 0) throw new Error(`weather scene "${place.name}": ${String(r.stderr).trim().split("\n").slice(-4).join(" / ")}`);
    scenes.push({ out, seconds: seconds + 1.2 });
  }
  const list = join(work, "list.txt");
  writeFileSync(list, scenes.map((s) => `file '${s.out.replace(/\\/g, "/")}'`).join("\n"));
  const file = join(WEATHER_DIR, `report-${slotKey.replace(/[^0-9]/g, "")}.mp4`);
  const c = spawnSync(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", file], { encoding: "utf8", timeout: 120000, windowsHide: true });
  if (c.status !== 0) throw new Error(`weather join: ${String(c.stderr).trim().split("\n").pop()}`);
  // Keep the last few reports only.
  for (const f of readdirSync(WEATHER_DIR).filter((x) => /^report-.*\.mp4$/.test(x)).sort((a, b) => statSync(join(WEATHER_DIR, b)).mtimeMs - statSync(join(WEATHER_DIR, a)).mtimeMs).slice(4)) rmSync(join(WEATHER_DIR, f), { force: true });
  const durationMs = Math.round(scenes.reduce((t, s) => t + s.seconds, 0) * 1000);
  log.info(`weather: made ${file.replace(/^.*[\\/]/, "")}, ${(durationMs / 1000).toFixed(0)} s, ${places.length} places`);
  return { file, durationMs, places: places.map((p) => p.name), presenters: presenters.map((p) => p.name) };
}
