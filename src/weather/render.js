// Turns forecasts into a weather video: for each place a scene (its NWS radar loop, the
// next few periods as cards, an alert banner if there is one) read by a built-in Windows
// voice, joined into one mp4.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, DATA_DIR, ROOT } from "../config.js";
import { log } from "../log.js";
import { spoken } from "./forecast.js";

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

function sceneGraph(place, dir, hasRadar) {
  const f = [];
  f.push(hasRadar ? "[1:v]fps=30,scale=-2:680,format=rgb24[radar];[0:v][radar]overlay=x=W-w-20:y=20[b]" : "[0:v]null[b]");
  const chain = [];
  chain.push("drawbox=x=40:y=34:w=196:h=46:color=0xd62828@1:t=fill");
  chain.push(text(dir, "WEATHER", { size: 30, x: 56, y: 42 }));
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

function speak(dir, id, script) {
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

// places: fetchPlace() results. Returns { file, durationMs, places }.
export async function renderReport(places, greeting, slotKey) {
  mkdirSync(WEATHER_DIR, { recursive: true });
  const work = join(WEATHER_DIR, "work");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const scenes = [];
  for (const [i, place] of places.entries()) {
    const lead = i === 0 ? `${greeting}. Here's your weather. ` : "";
    const tail = i === places.length - 1 ? " That's your weather." : "";
    const { wav, seconds } = speak(work, `s${i}`, lead + spoken(place) + tail);
    const gif = await radarGif(place.radar, work);
    const out = join(work, `scene${i}.mp4`);
    const dur = (seconds + 1.2).toFixed(2);
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x0b1d33:s=1280x720:r=30"];
    args.push(...(gif ? ["-ignore_loop", "0", "-i", gif] : ["-f", "lavfi", "-i", "color=c=black:s=16x16:r=30"]));
    args.push("-i", wav, "-filter_complex", sceneGraph(place, work, !!gif), "-map", "[v]", "-map", "[a]", "-t", dur,
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
  return { file, durationMs, places: places.map((p) => p.name) };
}
