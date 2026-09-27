import { Plex } from "../plex.js";
import { config, secrets } from "../config.js";
import { getMeta, setMeta } from "../db.js";
import { log } from "../log.js";
import { syncPlex } from "./plexSync.js";
import { scanLocal } from "./localScan.js";
import { syncRealDebrid } from "./rdSync.js";
import { importCsvTags } from "./csvTags.js";
import { dedupeCatalog } from "./dedupe.js";

// The full catalog sync: Plex, local folders, Real-Debrid, then the commercial/clip tag sheets.
// quick: just what's new since the last sync (Plex items added lately, the local folders, Real-Debrid
// torrents it hasn't read, and only their files); nothing is marked removed and the files that
// failed before aren't retried. It leaves last_sync alone, so the weekly full sync still comes.
export async function runSync({ plex = new Plex(), quick = false } = {}) {
  const t0 = Date.now();
  log.info(`sync: starting${quick ? " (quick: new things only)" : ""}`);
  const lastAny = Math.max(Date.parse(getMeta("last_sync") || 0) || 0, Date.parse(getMeta("last_quick_sync") || 0) || 0);
  const sinceMs = quick ? (lastAny ? lastAny - 2 * 86400000 : Date.now() - 14 * 86400000) : 0; // two days of overlap
  try {
    await syncPlex(plex, { sinceMs });
  } catch (e) {
    // Keep going: a Plex outage shouldn't stop local files from being picked up.
    log.error("sync: Plex part failed:", e.message);
  }
  await scanLocal();
  if (secrets.rdToken && config.realdebrid.enabled) {
    try {
      await syncRealDebrid(undefined, { quick });
    } catch (e) {
      log.error("sync: Real-Debrid part failed:", e.message);
    }
  }
  dedupeCatalog(); // Real-Debrid also runs it between its reads; this covers syncs without it
  importCsvTags();
  setMeta(quick ? "last_quick_sync" : "last_sync", new Date().toISOString());
  log.info(`sync${quick ? " (quick)" : ""}: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// Just the local folders (seconds, not minutes): after adding files there.
export async function syncLocal() {
  const t0 = Date.now();
  await scanLocal();
  dedupeCatalog();
  importCsvTags();
  log.info(`sync (local folders): done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
