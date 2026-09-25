// Command line: tv.cmd <command>
import { getDb, getMeta } from "./db.js";
import { runSync } from "./catalog/index.js";
import { schedulableSql } from "./catalog/schedulable.js";

const commands = {
  async sync() {
    await runSync();
    await commands.stats();
  },

  async stats() {
    const db = getDb();
    console.log(`\nCatalog (last sync ${getMeta("last_sync") || "never"})\n`);
    console.table(db.prepare(`
      SELECT library, kind, COUNT(*) total,
        SUM(match = 'full') full_match, SUM(match = 'show') show_only, SUM(match = 'none') unmatched,
        SUM(${schedulableSql()}) schedulable
      FROM items WHERE present = 1 GROUP BY library, kind ORDER BY library, kind`).all());

    console.log("\nWhy identified items can't be scheduled:");
    console.table(db.prepare(`SELECT COALESCE(unplayable_reason, 'not checked yet') reason, COUNT(*) n
      FROM items WHERE present = 1 AND match != 'none' AND playable = 0 GROUP BY reason ORDER BY n DESC`).all());

    console.log("\nSubtitle handling for schedulable items:");
    console.table(db.prepare(`SELECT json_extract(subs, '$.mode') mode, COUNT(*) n FROM items
      WHERE ${schedulableSql()} GROUP BY mode ORDER BY n DESC`).all());
  },
};

const [cmd = "help", ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log("commands:\n  sync    pull the catalog from Plex + local folders, import tags.csv files\n  stats   show what's in the catalog");
  process.exit(cmd === "help" ? 0 : 1);
}
await commands[cmd](...args);
