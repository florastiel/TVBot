// Proof of concept: find the friend's Plex server over a DIRECT connection (never
// Plex Relay) and print the original-file URL of one episode for poc/stream.js.
//   tv.cmd poc\plex.js            list servers you can see
//   tv.cmd poc\plex.js pick       print a stream URL from PLEX_SERVER_NAME
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const { PLEX_TOKEN, PLEX_SERVER_NAME } = process.env;
if (!PLEX_TOKEN) { console.error("missing PLEX_TOKEN in .env"); process.exit(1); }

// Plex wants a stable per-app identifier; keep one in data/.
mkdirSync("data", { recursive: true });
const idFile = "data/plex-client-id.txt";
if (!existsSync(idFile)) writeFileSync(idFile, randomUUID());
const clientId = readFileSync(idFile, "utf8").trim();

const headers = (token) => ({
  Accept: "application/json",
  "X-Plex-Token": token,
  "X-Plex-Client-Identifier": clientId,
  "X-Plex-Product": "tvchannel",
});

const res = await fetch("https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", {
  headers: headers(PLEX_TOKEN),
});
if (!res.ok) { console.error(`plex.tv said ${res.status}`); process.exit(1); }
const servers = (await res.json()).filter((r) => r.provides.includes("server"));

if (process.argv[2] !== "pick") {
  for (const s of servers) {
    console.log(`\n${s.name}  (${s.owned ? "yours" : "shared with you"})`);
    for (const c of s.connections) {
      console.log(`  ${c.relay ? "RELAY " : c.local ? "local " : "direct"}  ${c.uri}`);
    }
  }
  console.log("\nPut the server's name in PLEX_SERVER_NAME, then run: tv.cmd poc\\plex.js pick");
  process.exit(0);
}

const server = servers.find((s) => s.name === PLEX_SERVER_NAME);
if (!server) { console.error(`no server named "${PLEX_SERVER_NAME}"`); process.exit(1); }
// A shared server has its own access token for you; use it rather than the account token.
const token = server.accessToken || PLEX_TOKEN;

// Try every non-relay address; keep the first one that answers.
let base;
for (const c of server.connections.filter((c) => !c.relay)) {
  try {
    const r = await fetch(`${c.uri}/identity`, { headers: headers(token), signal: AbortSignal.timeout(5000) });
    if (r.ok) { base = c.uri; break; }
  } catch { /* try the next one */ }
}
if (!base) {
  console.error("no direct connection answered. Only Relay would work, which we don't use.");
  console.error("Your friend may need Remote Access enabled / a port forwarded on their end.");
  process.exit(1);
}
console.log(`direct connection: ${base}`);

const get = async (path) => {
  const r = await fetch(`${base}${path}`, { headers: headers(token) });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return (await r.json()).MediaContainer;
};

const sections = (await get("/library/sections")).Directory;
console.log("libraries:", sections.map((s) => `${s.title} (${s.type})`).join(", "));
const shows = sections.find((s) => s.type === "show") || sections.find((s) => s.type === "movie");
// type=4 is "episode"; a show library returns episodes, a movie library returns movies.
const typeParam = shows.type === "show" ? "&type=4" : "";
const items = (await get(`/library/sections/${shows.key}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=50${typeParam}`)).Metadata;
const item = items[Math.floor(Math.random() * items.length)];
const part = item.Media[0].Part[0];
const label = item.grandparentTitle ? `${item.grandparentTitle} - ${item.title}` : item.title;
console.log(`picked: ${label} (${Math.round(item.duration / 60000)} min, ${item.Media[0].videoResolution}, ${part.container})`);
// Part key = the original file, no Plex transcoding.
console.log(`\nstream URL (contains your token, don't paste it anywhere):\n${base}${part.key}?X-Plex-Token=${token}`);
