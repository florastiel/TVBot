// Wall-clock helpers in the channel's time zone (config.broadcast.timezone).
import { config } from "../config.js";

const tz = () => config.broadcast.timezone;

function parts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "long",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, weekday: p.weekday };
}

// UTC ms for a local wall-clock time in the channel's zone (handles DST).
export function localToUtc(y, m, d, hh = 0, mm = 0) {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(t);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    t += want - seen;
  }
  return t;
}

// A calendar day in the channel's zone: { date: "YYYY-MM-DD", y, m, d, weekday, startMs, endMs }
export function localDay(ms) {
  const p = parts(ms);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return {
    date: `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`,
    y: p.y, m: p.m, d: p.d, weekday: p.weekday,
    startMs: localToUtc(p.y, p.m, p.d),
    endMs: localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

export const localTime = (ms) => {
  const p = parts(ms);
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
};

export const gridMs = () => config.broadcast.grid_minutes * 60000;
// Round a time up / down to the grid (:00 :15 :30 :45 with a 15-minute grid), in local time.
export function gridCeil(ms) {
  const day = localDay(ms);
  return day.startMs + Math.ceil((ms - day.startMs) / gridMs()) * gridMs();
}
export function gridFloor(ms) {
  const day = localDay(ms);
  return day.startMs + Math.floor((ms - day.startMs) / gridMs()) * gridMs();
}

// On-air hours of a local day, e.g. "18:00-02:00" (wraps past midnight). 24/7 = the whole day.
function onAir(day) {
  const [from, to] = config.broadcast.hours.split("-").map((x) => x.split(":").map(Number));
  const on = localToUtc(day.y, day.m, day.d, from[0], from[1]);
  let off = to[0] === 24 ? day.endMs : localToUtc(day.y, day.m, day.d, to[0], to[1]);
  if (off <= on) off += day.endMs - day.startMs;
  return { on, off, allDay: on === day.startMs && off === day.endMs };
}

// The stretch of air time to program next, starting at `from`: the rest of that
// day's on-air hours. For 24/7, a short remainder of a day is merged into the next day.
export function nextWindow(from) {
  let day = localDay(from);
  for (let i = 0; i < 3; i++, day = localDay(day.endMs + 1)) {
    const { on, off, allDay } = onAir(day);
    if (from >= off) continue;
    const start = Math.max(from, on);
    if (allDay && off - start < 3 * 3600000) return { start, end: localDay(off + 1).endMs, day: localDay(start) };
    return { start, end: off, day: localDay(start), fixedEnd: !allDay };
  }
  throw new Error("couldn't find on-air hours; check broadcast.hours in config.yaml");
}

// Holiday season for a date: Halloween in October, Thanksgiving through Thanksgiving
// Day, then Christmas until the 25th. Plus how close to the day itself (0..1).
export function season(day) {
  const { y, m, d } = day;
  const thanksgiving = 22 + ((11 - new Date(Date.UTC(y, 10, 1)).getUTCDay()) % 7); // 4th Thursday of November
  if (m === 10) return { theme: "halloween", intensity: d / 31, holidayDate: `${y}-10-31` };
  if (m === 11 && d <= thanksgiving) return { theme: "thanksgiving", intensity: d / thanksgiving, holidayDate: `${y}-11-${thanksgiving}` };
  if ((m === 11 && d > thanksgiving) || (m === 12 && d <= 25)) {
    const daysLeft = m === 12 ? 25 - d : 30 - d + 25;
    return { theme: "christmas", intensity: 1 - daysLeft / 32, holidayDate: `${y}-12-25` };
  }
  return { theme: "none", intensity: 0, holidayDate: null };
}
