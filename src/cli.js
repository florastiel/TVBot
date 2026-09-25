// Command line: tv.cmd <command>
import { getDb, getMeta } from "./db.js";
import { runSync } from "./catalog/index.js";
import { schedulableSql } from "./catalog/schedulable.js";
import { savePlaylist } from "./player/program.js";
import { describe } from "./player/segments.js";

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

Object.assign(commands, {
  async player() {
    const { Player } = await import("./player/player.js");
    await new Player().start();
  },

  async bot() {
    const { startBot } = await import("./bot/bot.js");
    await startBot();
  },

  // Test playlist for the player until the real schedule exists (step 5).
  async playlist(show, count = "3") {
    if (!show) throw new Error('usage: tv.cmd playlist "<show name>" [episodes]');
    const rows = getDb().prepare(`SELECT * FROM items WHERE show_title = ? COLLATE NOCASE AND ${schedulableSql()}
      ORDER BY season, episode`).all(show);
    if (!rows.length) {
      const like = getDb().prepare(`SELECT DISTINCT show_title FROM items WHERE show_title LIKE ? AND ${schedulableSql()} LIMIT 10`)
        .all(`%${show}%`).map((r) => r.show_title);
      throw new Error(`no schedulable episodes of "${show}"${like.length ? `. Did you mean: ${like.join(" / ")}` : ""}`);
    }
    const start = Math.floor(Math.random() * Math.max(1, rows.length - Number(count)));
    const pick = rows.slice(start, start + Number(count));
    savePlaylist(pick.map((r) => r.id));
    for (const r of pick) {
      const d = describe(r);
      console.log(`${d.title} ${d.subtitle}  (${Math.round(r.duration_ms / 60000)} min)`);
    }
  },
});

const [cmd = "help", ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log(`commands:
  sync                         pull the catalog from Plex + local folders, import tags.csv files
  stats                        show what's in the catalog
  player                       run the streamer (the throwaway account)
  bot                          run the remote-control bot
  playlist "<show>" [count]    set the test playlist to a few episodes of a show`);
  process.exit(cmd === "help" ? 0 : 1);
}
await commands[cmd](...args);
