// The weather board: one clean, static 1280x720 image for the whole report (every place,
// vertically stacked, each with its next few hours side by side). Rendered as real HTML/CSS
// via a headless browser (Puppeteer) and screenshotted to a PNG, rather than hand-placed
// ffmpeg drawtext/drawbox - much easier to make look modern, and easier to redesign later.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";

const WIDTH = 1280;
const HEIGHT = 720;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hour = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric" }).replace(" ", "");

// A tiny hand-drawn icon set (sun/cloud/rain/snow/storm/fog) instead of any downloaded asset -
// picked from the NWS short-forecast text, good enough to tell conditions apart at a glance.
function iconFor(short) {
  const s = (short || "").toLowerCase();
  if (/thunder|storm/.test(s)) return "storm";
  if (/snow|flurr|sleet/.test(s)) return "snow";
  if (/rain|shower|drizzle/.test(s)) return "rain";
  if (/fog|haze|smoke/.test(s)) return "fog";
  if (/cloud|overcast/.test(s)) return /partly|mostly sunny|mostly clear/.test(s) ? "partly" : "cloud";
  return "sun";
}
const ICONS = {
  sun: `<circle cx="12" cy="12" r="4.5"/><g stroke-linecap="round"><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/><line x1="4.2" y1="4.2" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.8" y2="19.8"/><line x1="4.2" y1="19.8" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.8" y2="4.2"/></g>`,
  partly: `<circle cx="8" cy="9" r="4" fill="currentColor" stroke="none"/><path d="M6 20a5 5 0 0 1-1-9.9A6 6 0 0 1 17 9a4.5 4.5 0 0 1 1 11H6z" fill="none"/>`,
  cloud: `<path d="M6.5 19a5 5 0 0 1-.9-9.9A6.5 6.5 0 0 1 18 9.5a4.5 4.5 0 0 1 .8 9H6.5z"/>`,
  rain: `<path d="M6.5 14.5a5 5 0 0 1-.9-9.9A6.5 6.5 0 0 1 18 5a4.5 4.5 0 0 1 .8 9H6.5z"/><g stroke-linecap="round"><line x1="8" y1="18" x2="6.5" y2="22"/><line x1="13" y1="18" x2="11.5" y2="22"/><line x1="18" y1="18" x2="16.5" y2="22"/></g>`,
  snow: `<path d="M6.5 14.5a5 5 0 0 1-.9-9.9A6.5 6.5 0 0 1 18 5a4.5 4.5 0 0 1 .8 9H6.5z"/><g stroke-linecap="round"><line x1="8" y1="18" x2="8" y2="22"/><line x1="13" y1="18" x2="13" y2="22"/><line x1="18" y1="18" x2="18" y2="22"/></g>`,
  storm: `<path d="M6.5 13.5a5 5 0 0 1-.9-9.9A6.5 6.5 0 0 1 18 4a4.5 4.5 0 0 1 .8 9H6.5z"/><path d="M13 15l-3 5h3l-2 4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  fog: `<g stroke-linecap="round"><line x1="4" y1="8" x2="20" y2="8"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="4" y1="16" x2="20" y2="16"/><line x1="6" y1="20" x2="18" y2="20"/></g>`,
};
const icon = (kind, size = 22) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6">${ICONS[kind] || ICONS.sun}</svg>`;

function hourChip(h) {
  return `<div class="hour">
    <div class="h-time">${esc(hour(h.time))}</div>
    <div class="h-icon">${icon(iconFor(h.short))}</div>
    <div class="h-temp">${Math.round(h.temp)}°</div>
    ${h.pop >= 20 ? `<div class="h-pop">${Math.round(h.pop)}%</div>` : ""}
  </div>`;
}

function placeRow(place) {
  const [now] = place.periods;
  const kind = now ? iconFor(now.short) : "sun";
  return `<section class="row">
    <div class="now">
      <div class="now-icon">${icon(kind, 32)}</div>
      <div class="now-text">
        <div class="place">${esc(place.name)}</div>
        <div class="cond">${now ? esc(now.short) : "—"}${place.alerts.length ? `<span class="alert">${esc(place.alerts.join(" · "))}</span>` : ""}</div>
      </div>
      <div class="temp">${now ? Math.round(now.temp) : "—"}°</div>
    </div>
    <div class="hours">${place.hours.map(hourChip).join("")}</div>
  </section>`;
}

function html(places, stamp) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: #0b0f14; color: #f2f4f7;
  font-family: "Segoe UI", system-ui, sans-serif; overflow: hidden; }
.wrap { padding: 20px 36px 12px; height: 100%; display: flex; flex-direction: column; }
header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #7dd3fc; }
header .stamp { font-size: 13px; color: #6b7684; }
.rows { flex: 1; display: flex; flex-direction: column; justify-content: space-between; gap: 6px; }
.row { border-top: 1px solid #1c232c; padding-top: 10px; }
.now { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
.now-icon { color: #7dd3fc; flex: none; }
.now-text { flex: 1; min-width: 0; }
.place { font-size: 19px; font-weight: 600; }
.cond { font-size: 13px; color: #9aa5b1; margin-top: 1px; display: flex; align-items: center; gap: 8px; }
.temp { font-size: 38px; font-weight: 300; font-variant-numeric: tabular-nums; }
.hours { display: flex; gap: 8px; }
.hour { flex: 1; background: #12181f; border-radius: 10px; padding: 6px 4px 7px; text-align: center; }
.h-time { font-size: 12px; color: #8b96a3; }
.h-icon { color: #cbd5e1; margin: 3px auto; width: 20px; }
.h-temp { font-size: 15px; font-weight: 600; }
.h-pop { font-size: 11px; color: #60a5fa; margin-top: 1px; }
.alert { background: #7f1d1d; color: #fecaca; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
footer { text-align: right; font-size: 11px; color: #4b5563; margin-top: 6px; }
</style></head><body><div class="wrap">
  <header><h1>Weather</h1><div class="stamp">${esc(stamp)}</div></header>
  <div class="rows">${places.map(placeRow).join("")}</div>
  <footer>Data: National Weather Service</footer>
</div></body></html>`;
}

let browser;
async function getBrowser() {
  if (!browser) browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  return browser;
}
export async function closeBrowser() {
  if (browser) { await browser.close(); browser = undefined; }
}

// Renders the board to a PNG in `dir`, returns its path.
export async function renderBoard(places, stamp, dir) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    await page.setContent(html(places, stamp), { waitUntil: "load" });
    const file = join(dir, "board.png");
    const buf = await page.screenshot({ type: "png" });
    writeFileSync(file, buf);
    return file;
  } finally {
    await page.close();
  }
}
