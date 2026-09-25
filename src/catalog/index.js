import { Plex } from "../plex.js";
import { setMeta } from "../db.js";
import { log } from "../log.js";
import { syncPlex } from "./plexSync.js";
import { scanLocal } from "./localScan.js";
import { importCsvTags } from "./csvTags.js";

// The full catalog sync: Plex, local folders, then the commercial/clip tag sheets.
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
  importCsvTags();
  setMeta("last_sync", new Date().toISOString());
  log.info(`sync: done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
