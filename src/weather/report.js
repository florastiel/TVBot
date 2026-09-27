// The weather report's schedule: config.weather.times (say ["07:00", "18:00"]). The bot
// makes each one a little before its time (makeReport); the player puts it into the first
// commercial break after that time (takeWeather in onair.js), once.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "../config.js";
import { getMeta, setMeta } from "../db.js";
import { log } from "../log.js";
import { localDay, localToUtc } from "../schedule/time.js";
import { fetchPlace, locations } from "./forecast.js";
import { renderReport } from "./render.js";

const LEAD_MS = 45 * 60000; // made this long before its time (with character voices it takes about 7 minutes)

// The report slot we're in (or about to be in): { key: "2026-09-27 07:00", start }.
export function currentSlot(now = Date.now()) {
  const w = config.weather;
  if (!w || w.enabled === false || !locations().length) return null;
  const day = localDay(now);
  const window = (w.window_hours ?? 3) * 3600000;
  for (const t of w.times || []) {
    const [h, m] = String(t).split(":").map(Number);
    const start = localToUtc(day.y, day.m, day.d, h, m || 0);
    if (now >= start - LEAD_MS && now < start + window) return { key: `${day.date} ${t}`, start };
  }
  return null;
}

const greeting = (ms) => { const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: config.broadcast.timezone, hourCycle: "h23", hour: "2-digit" }).format(new Date(ms))); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

// A different presenter for each place, at random from config weather.voices (the pool is
// only the ones whose model files are installed in tools\rvc\models); reused if there are more places than voices.
function choosePresenters(count) {
  const pool = (config.weather?.voices || []).filter((v) => v?.name && v.model && existsSync(join(ROOT, "tools", "rvc", "models", String(v.model), "model.pth")));
  if (!pool.length) return [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return Array.from({ length: count }, (_, i) => shuffled[i % shuffled.length]);
}

// Fetch every place and render the video for this slot. Returns what takeWeather() needs.
// fast: skip the character voices (about a minute instead of several) for on-demand reports.
export async function makeReport(slot, { fast = false } = {}) {
  const results = await Promise.allSettled(locations().map(fetchPlace));
  const places = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  for (const r of results) if (r.status === "rejected") log.warn(`weather: ${r.reason.message}`);
  if (!places.length) throw new Error("no forecast could be fetched");
  const out = await renderReport(places, greeting(slot.start), slot.key, fast ? [] : choosePresenters(places.length));
  const ready = { slot: slot.key, at: Date.now(), ...out };
  setMeta("weather_ready", JSON.stringify(ready));
  return ready;
}

let busy = false;
let lastTry = 0;
// Called every minute by the bot: make the report for the current slot if it isn't made.
export async function weatherTick(now = Date.now()) {
  const slot = currentSlot(now);
  if (!slot || busy) return;
  const ready = JSON.parse(getMeta("weather_ready") || "null");
  if (ready?.slot === slot.key && existsSync(ready.file)) return;
  if (now - lastTry < 10 * 60000) return; // a failed try waits a while
  busy = true;
  lastTry = now;
  try { await makeReport(slot); } catch (e) { log.warn(`weather: couldn't make the report: ${e.message}`); } finally { busy = false; }
}

const segmentOf = (ready) => ({
  rdLink: null, itemId: null, kind: "weather", title: "Weather", subtitle: ready.places.join(", "), input: ready.file, seekMs: 0,
  durationMs: ready.durationMs, audioStream: 1, subs: { mode: "none" }, subsFile: null, breakId: null,
});
const readyReport = () => { const r = JSON.parse(getMeta("weather_ready") || "null"); return r && existsSync(r.file) ? r : null; };

// /weather: have the next commercial break (any, even inside a show) carry the weather.
// Uses the report made for the current time slot, or one made in the last 90 minutes;
// otherwise makes a fresh one first (about 40 seconds). Returns { queued, already, seconds }.
export async function requestWeather() {
  if (getMeta("weather_force")) return { queued: true, already: true };
  let ready = readyReport();
  if (!ready || Date.now() - ready.at > 90 * 60000) {
    while (busy) await new Promise((r) => setTimeout(r, 2000)); // one is being made already
    ready = readyReport();
    if (!ready || Date.now() - ready.at > 90 * 60000) {
      busy = true;
      try { ready = await makeReport({ key: `request ${new Date().toISOString()}`, start: Date.now() }, { fast: true }); } finally { busy = false; }
    }
  }
  setMeta("weather_force", "1");
  return { queued: true, seconds: Math.round(ready.durationMs / 1000) };
}

// For the player, at each commercial break: the report that is due (once), or the one
// /weather asked for; null otherwise. Scheduled reports go only in breaks between shows.
export function takeWeather(now = Date.now(), { inside = false } = {}) {
  const slot = currentSlot(now);
  if (getMeta("weather_force")) {
    const ready = readyReport();
    setMeta("weather_force", "");
    if (ready) {
      if (slot && ready.slot === slot.key) setMeta("weather_aired", slot.key); // don't air the same one again right after
      return segmentOf(ready);
    }
  }
  if (inside || !slot || now < slot.start) return null;
  if (getMeta("weather_aired") === slot.key) return null;
  const ready = readyReport();
  if (!ready || ready.slot !== slot.key) return null;
  setMeta("weather_aired", slot.key);
  return segmentOf(ready);
}
