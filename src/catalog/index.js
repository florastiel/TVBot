import { Plex } from "../plex.js";
import { config, secrets } from "../config.js";
import { setMeta } from "../db.js";
import { log } from "../log.js";
import { syncPlex } from "./plexSync.js";
import { scanLocal } from "./localScan.js";
import { syncRealDebrid } from "./rdSync.js";
import { importCsvTags } from "./csvTags.js";
import { dedupeCatalog } from "./dedupe.js";

// The full catalog sync: Plex, local folders, Real-Debrid, then the commercial/clip tag sheets.
export async function runSync({ plex = new Plex() } = {}) {
  const t0 = Date.now();
  log.info("sync: starting");
  try {
    await syncPlex(plex);
  } catch (e) {
    // Keep going: a Plex outage shouldn't stop local files from being picked up.
    log.error("sync: Plex part failed:", e.message);
  }
  await scanLocal();
  if (secrets.rdToken && config.realdebrid.enabled) {
    try {
      await syncRealDebrid();
    } catch (e) {
      log.error("sync: Real-Debrid part failed:", e.message);
    }
  }
  dedupeCatalog(); // Real-Debrid also runs it between its reads; this covers syncs without it
  importCsvTags();
  setMeta("last_sync", new Date().toISOString());
  log.info(`sync: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// Just the local folders (seconds, not minutes): after adding files there.
export async function syncLocal() {
  const t0 = Date.now();
  await scanLocal();
  dedupeCatalog();
  importCsvTags();
  log.info(`sync (local folders): done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
