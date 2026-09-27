// The forecast, from the National Weather Service (api.weather.gov: free, no key, US only).
// Everything on screen and in the voice-over comes from these numbers; nothing is invented.
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../config.js";

const UA = { "User-Agent": "tvchannel-weather (personal Discord TV project)", Accept: "application/geo+json" };

async function getJson(url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (e) { last = e; }
    await sleep(2000 * attempt);
  }
  throw new Error(`${url.replace(/\?.*/, "")}: ${last.message}`);
}

// weather.locations in config.yaml: [{ name, lat, lon, radar? }]
export const locations = () => (config.weather?.locations || []).filter((l) => l?.name && l.lat != null && l.lon != null);

const HOURS_SHOWN = 8;

// { name, periods: [{ name, day, temp, short, pop, wind, dir }], hours: [{ time, temp, short, pop }], alerts: [...] }
export async function fetchPlace(loc) {
  const point = await getJson(`https://api.weather.gov/points/${loc.lat},${loc.lon}`);
  const forecast = await getJson(point.properties.forecast);
  const hourly = await getJson(point.properties.forecastHourly).catch(() => null);
  const alerts = await getJson(`https://api.weather.gov/alerts/active?point=${loc.lat},${loc.lon}`)
    .then((a) => [...new Set((a.features || []).map((f) => f.properties.event))].filter((e) => e && !/Special Weather Statement/i.test(e)).slice(0, 2))
    .catch(() => []);
  const periods = forecast.properties.periods.slice(0, 3).map((x) => ({
    name: x.name, day: x.isDaytime, temp: x.temperature, short: x.shortForecast,
    pop: x.probabilityOfPrecipitation?.value ?? 0, wind: x.windSpeed, dir: x.windDirection,
  }));
  const hours = (hourly?.properties?.periods || []).slice(0, HOURS_SHOWN).map((x) => ({
    time: x.startTime, temp: x.temperature, short: x.shortForecast, pop: x.probabilityOfPrecipitation?.value ?? 0,
  }));
  return { name: loc.name, periods, hours, alerts };
}

const pick = (...options) => options[Math.floor(Math.random() * options.length)];
const WET = /rain|shower|storm|drizzle|snow|sleet|flurr|ice/i;
const lower = (s) => String(s).toLowerCase();

// Spells out numbers as words ("89" -> "eighty-nine"): a non-English voice reading a plain
// digit tends to switch into its own language's number words, which defeats the point of
// putting it in the rotation at all - spelled-out English words get read (badly) as English.
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export function numWord(n) {
  n = Math.round(n);
  const neg = n < 0;
  n = Math.abs(n);
  let s;
  if (n < 20) s = ONES[n];
  else if (n < 100) s = TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  else if (n < 1000) s = `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numWord(n % 100)}` : ""}`;
  else s = String(n); // out of range for anything weather actually produces
  return neg ? `minus ${s}` : s;
}
// Every bare integer in a string, spelled out (leaves decimals like "0.5" alone - rare in practice).
export const numbersToWords = (s) => String(s).replace(/-?\d+\b(?!\.\d)/g, (m) => numWord(Number(m)));

// What gets spoken for one place: at most a sentence or two, unless there's something worth
// mentioning (real rain/snow chance, an alert, or an extreme temp) - not a full local-news segment.
export function spoken(place) {
  const [a] = place.periods;
  const n = place.name;
  if (!a) return `${n}: no forecast available right now.`;
  const wet = WET.test(a.short) || a.pop >= 40;
  const say = [`In ${n}, ${lower(a.short)}, ${numWord(a.temp)} degrees.`];
  if (place.alerts.length) {
    say.push(`There's ${place.alerts.map((x) => `a ${x}`).join(" and ")} in effect.`);
  } else if (wet && a.pop >= 40) {
    say.push(`${pick("Looks like", "That's")} a ${numWord(a.pop)} percent chance of precipitation${a.pop >= 70 ? ", so grab an umbrella." : "."}`);
  } else if (a.temp <= 32) {
    say.push(pick("Bundle up out there.", "It'll be a cold one."));
  } else if (a.temp >= 90) {
    say.push(pick("Stay cool out there.", "It's going to feel hot."));
  }
  return numbersToWords(say.join(" "));
}
