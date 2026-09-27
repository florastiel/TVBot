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

// What the weatherman says for one place: templates filled with the real numbers.
export function spoken(place) {
  const [a, b] = place.periods;
  const say = [`${place.name}.`];
  if (place.alerts.length) say.push(`A ${place.alerts.join(" and a ")} ${place.alerts.length > 1 ? "are" : "is"} in effect.`);
  if (a) {
    say.push(`${a.name}: ${a.short.toLowerCase()}, ${a.day ? "with a high near" : "with a low around"} ${a.temp} degrees.`);
    if (a.pop >= 20) say.push(`${a.pop} percent chance of precipitation.`);
    if (a.dir && a.wind) say.push(`Winds ${DIRS[a.dir] ? `out of the ${DIRS[a.dir]}` : a.dir} at ${a.wind.replace(/mph/i, "miles per hour")}.`);
  }
  if (b) say.push(`${b.name}: ${b.short.toLowerCase()}, ${b.day ? "high" : "low"} of ${b.temp}${b.pop >= 20 ? `, with a ${b.pop} percent chance of precipitation` : ""}.`);
  return say.join(" ");
}
