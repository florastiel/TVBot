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

// { name, radar, periods: [{ name, day, temp, short, pop, wind, dir }], alerts: ["Flood Watch"] }
export async function fetchPlace(loc) {
  const point = await getJson(`https://api.weather.gov/points/${loc.lat},${loc.lon}`);
  const forecast = await getJson(point.properties.forecast);
  const alerts = await getJson(`https://api.weather.gov/alerts/active?point=${loc.lat},${loc.lon}`)
    .then((a) => [...new Set((a.features || []).map((f) => f.properties.event))].filter((e) => e && !/Special Weather Statement/i.test(e)).slice(0, 2))
    .catch(() => []);
  const periods = forecast.properties.periods.slice(0, 3).map((x) => ({
    name: x.name, day: x.isDaytime, temp: x.temperature, short: x.shortForecast,
    pop: x.probabilityOfPrecipitation?.value ?? 0, wind: x.windSpeed, dir: x.windDirection,
  }));
  return { name: loc.name, radar: loc.radar || point.properties.radarStation, periods, alerts };
}

const DIRS = { N: "north", NNE: "north northeast", NE: "northeast", ENE: "east northeast", E: "east", ESE: "east southeast", SE: "southeast", SSE: "south southeast",
  S: "south", SSW: "south southwest", SW: "southwest", WSW: "west southwest", W: "west", WNW: "west northwest", NW: "northwest", NNW: "north northwest" };

const pick = (...options) => options[Math.floor(Math.random() * options.length)];
const WET = /rain|shower|storm|drizzle|snow|sleet|flurr|ice/i;
const lower = (s) => String(s).toLowerCase();
// 54 -> "mid 50s", 51 -> "low 50s", 58 -> "upper 50s"
const band = (t) => { const n = Math.round(t); if (n < 10) return `around ${n}`; const o = n % 10; return `${o <= 2 ? "low" : o <= 6 ? "mid" : "upper"} ${Math.trunc(n / 10) * 10}s`; };

// What the weathercaster says at the map for one place: sentences filled in from the real
// forecast (the wording is only varied at random; every claim comes from the numbers).
export function spoken(place) {
  const [a, b] = place.periods;
  const n = place.name;
  const wet = a && (WET.test(a.short) || a.pop >= 50);
  const say = [];
  say.push(wet
    ? pick(`Taking a look at the radar behind me, ${n} is going to want the umbrella.`,
      `The radar behind me tells the story for ${n}: it's going to be a wet one.`,
      `If you're in ${n}, keep an eye on the radar behind me, because there's rain in the forecast.`)
    : pick(`Looking at the radar behind me, ${n} is nice and quiet.`,
      `Over in ${n}, the map behind me is looking pretty calm.`,
      `Good news for ${n}: nothing on the radar behind me to worry about.`));
  if (place.alerts.length) {
    say.push(`We do have ${place.alerts.map((x) => `a ${x}`).join(" and ")} in effect, so ${pick("stay weather aware.", "keep an eye on that.", "be careful out there.")}`);
  }
  if (a) {
    say.push(`${a.name}: ${lower(a.short)}. ${a.day ? "Highs" : "Lows"} in the ${band(a.temp)}, right around ${a.temp} degrees.`);
    if (a.pop >= 20) say.push(`${pick("We're looking at a", "There's a")} ${a.pop} percent chance of precipitation${a.pop >= 70 ? pick(", so grab the umbrella.", ", so don't leave home without the rain gear.") : "."}`);
    if (a.temp <= 40) say.push(pick("Bundle up out there.", "You'll want a warm coat."));
    else if (a.temp >= 85) say.push(pick("It's going to feel hot out there.", "Stay cool and drink plenty of water."));
    if (a.dir && a.wind) say.push(`Winds will be ${DIRS[a.dir] ? `out of the ${DIRS[a.dir]}` : a.dir} at ${a.wind.replace(/mph/i, "miles per hour")}.`);
  }
  if (b) say.push(`${pick("Now, looking ahead to", "Heading into", "And then for")} ${b.name}: ${lower(b.short)}, ${b.day ? "high" : "low"} of ${b.temp}${b.pop >= 20 ? `, with a ${b.pop} percent chance of precipitation` : ""}.`);
  return say.join(" ");
}

// One presenter passing to the next.
export const handoff = (nextName, placeName) => pick(
  `I'll hand it off now to ${nextName} for ${placeName}.`,
  `Let's go to ${nextName} for ${placeName}.`,
  `Over to you, ${nextName}, for ${placeName}.`,
  `${nextName}, what's it looking like in ${placeName}?`,
  `I'll pass it along to ${nextName} for ${placeName}.`);
export const thanks = (prevName) => pick(`Thanks, ${prevName}.`, `Thank you, ${prevName}.`, `Appreciate it, ${prevName}.`);
