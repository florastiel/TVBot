// Try to bring back the dead Real-Debrid torrents (the catalog's "hoster_unavailable
// (whole torrent)" ones) by adding each one's magnet again, like Debrid Media Manager's
// "reinsert": if Real-Debrid still has it cached it finishes within seconds; if not, the
// attempt is deleted again so nothing sits in the queue. Old (dead) torrents are NEVER
// touched here.
//
//   tools\node\node.exe scripts\rd-reinsert.mjs                 dry run: what would be tried
//   tools\node\node.exe scripts\rd-reinsert.mjs --go [--limit N] [--parallel 4]
//
// Progress is kept in data\rd-reinsert.json (a hash that already came back, or was given
// up on this week, is skipped when you run it again; --retry-failed tries those too).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_DIR } from "../src/config.js";
import { getDb } from "../src/db.js";
import { RealDebrid } from "../src/realdebrid.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const go = args.includes("--go");
const retryFailed = args.includes("--retry-failed");
const limit = opt("--limit", Infinity);
const parallel = Math.max(1, Math.min(6, opt("--parallel", 4)));
const STATE = join(DATA_DIR, "rd-reinsert.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));

const rd = new RealDebrid();
const db = getDb();
const deadIds = new Set(db.prepare("SELECT DISTINCT substr(source_key, 1, instr(source_key, ':') - 1) id FROM items WHERE source='realdebrid' AND unplayable_reason LIKE '%whole torrent%'").all().map((r) => r.id));
const all = await rd.torrents();
const dead = all.filter((t) => deadIds.has(t.id));
// One try per unique release (the same hash can be on the account several times).
const byHash = new Map();
for (const t of dead) if (!byHash.has(t.hash)) byHash.set(t.hash, t);
const todo = [...byHash.values()].filter((t) => {
  const s = state[t.hash];
  return !s || (retryFailed && s.result !== "revived");
}).slice(0, limit);
console.log(`${dead.length} dead torrents on the account, ${byHash.size} unique releases; ${Object.values(state).filter((s) => s.result === "revived").length} already revived; ${todo.length} to try now.`);
if (!go) {
  for (const t of todo) console.log(`  would try: ${t.filename} (${(t.bytes / 1e9).toFixed(1)} GB)`);
  console.log("Dry run only. Add --go to try them.");
  process.exit(0);
}

const magnet = (t) => `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.filename)}`;
async function until(id, wanted, secs) {
  const end = Date.now() + secs * 1000;
  let info;
  while (Date.now() < end) {
    info = await rd.torrentInfo(id);
    if (wanted.includes(info.status) || ["error", "dead", "virus", "magnet_error"].includes(info.status)) return info;
    await sleep(2000);
  }
  return info;
}

async function attempt(t) {
  let id;
  try {
    id = (await rd.call("/torrents/addMagnet", { method: "POST", form: { magnet: magnet(t) } })).id;
    let info = await until(id, ["waiting_files_selection", "downloaded"], 30);
    if (info.status === "waiting_files_selection") {
      await rd.call(`/torrents/selectFiles/${id}`, { method: "POST", form: { files: "all" } });
      info = await until(id, ["downloaded"], 30);
    }
    if (info.status === "downloaded") {
      // "downloaded" isn't enough (the dead ones say that too): the first link must unlock.
      try {
        await rd.call("/unrestrict/link", { method: "POST", form: { link: info.links[0] } });
        return { result: "revived", newId: id, files: info.links.length };
      } catch (e) {
        await rd.call(`/torrents/delete/${id}`, { method: "DELETE" }).catch(() => {});
        return { result: "gave-up", why: `downloaded but ${e.message.replace(/^real-debrid [^:]*: /, "")}` };
      }
    }
    await rd.call(`/torrents/delete/${id}`, { method: "DELETE" }).catch(() => {});
    return { result: "gave-up", why: info.status };
  } catch (e) {
    if (id) await rd.call(`/torrents/delete/${id}`, { method: "DELETE" }).catch(() => {});
    return { result: "error", why: e.message };
  }
}

let done = 0;
const queue = [...todo];
await Promise.all(Array.from({ length: parallel }, async () => {
  while (queue.length) {
    const t = queue.shift();
    const r = await attempt(t);
    state[t.hash] = { name: t.filename, oldId: t.id, at: new Date().toISOString(), ...r };
    save();
    console.log(`[${++done}/${todo.length}] ${r.result.toUpperCase().padEnd(8)} ${t.filename.slice(0, 70)}${r.why ? `  (${r.why})` : ""}`);
  }
}));
const c = {}; for (const s of Object.values(state)) c[s.result] = (c[s.result] || 0) + 1;
console.log("totals:", JSON.stringify(c));
