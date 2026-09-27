// Command line: tv.cmd <command>
import { getDb, getMeta } from "./db.js";
import { runSync } from "./catalog/index.js";
import { schedulableSql } from "./catalog/schedulable.js";
import { savePlaylist, clearPlaylist } from "./player/program.js";
import { describe } from "./player/segments.js";

const commands = {
  // tv.cmd sync            everything (the weekly one)
  // tv.cmd sync --quick    only what's new since the last sync (minutes at most)
  async sync(...flags) {
    await runSync({ quick: flags.includes("--quick") });
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
      FROM items WHERE present = 1 AND match != 'none' AND playable = 0 AND duplicate_of IS NULL GROUP BY reason ORDER BY n DESC`).all());
    const dup = db.prepare(`SELECT COUNT(*) n FROM items WHERE present = 1 AND duplicate_of IS NOT NULL`).get().n;
    if (dup) console.log(`(plus ${dup} duplicate copies of episodes/movies that play from another copy)`);

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

  // Claude tagging. --dry: estimate only. --sample: tiny direct test, not saved. --redo: retag everything.
  async tag(...flags) {
    const t = await import("./tagging/tagger.js");
    if (flags.includes("--dry")) return t.dryRun({ redo: flags.includes("--redo") });
    if (flags.includes("--sample")) return t.sample();
    const { tagOrder } = await import("./tagging/order.js");
    const { tagEpisodeThemes } = await import("./tagging/episodes.js");
    const { tagBreaks } = await import("./tagging/breaks.js");
    if (flags.includes("--order")) return tagOrder({ redo: flags.includes("--redo") });
    if (flags.includes("--episodes")) return tagEpisodeThemes({ redo: flags.includes("--redo") });
    if (flags.includes("--breaks")) return tagBreaks({ redo: flags.includes("--redo") });
    await t.runTagging({ redo: flags.includes("--redo") });
    await tagOrder({ redo: flags.includes("--redo") });
    await tagEpisodeThemes({ redo: flags.includes("--redo") });
    await tagBreaks({ redo: flags.includes("--redo") });
    const { detectShorts } = await import("./tagging/anilist.js");
    await detectShorts().catch((e) => console.error("AniList short check failed:", e.message));
  },

  // Which anime are shorts (AniList), then the Shorts block takes them in. --redo: check them all again.
  async shorts(...flags) {
    const { detectShorts } = await import("./tagging/anilist.js");
    const { refreshHolidayBuckets } = await import("./schedule/buckets.js");
    const n = await detectShorts({ redo: flags.includes("--redo") });
    refreshHolidayBuckets();
    console.log(`${n} short shows found this time; the Shorts block is updated.`);
  },

  // What was added, by day: tv.cmd changelog [days]
  async changelog(...args) {
    const { formatChangelog, writeChangelogFile } = await import("./changelog.js");
    console.log(formatChangelog(Number(args.find((a) => /^\d+$/.test(a))) || 7).replace(/\*\*/g, ""));
    writeChangelogFile();
  },

  // Make a weather report right now (config weather.locations) and print where it is;
  // it doesn't go on air (that happens at weather.times).
  async weather() {
    const { makeReport } = await import("./weather/report.js");
    const r = await makeReport({ key: `manual ${new Date().toISOString()}`, start: Date.now() });
    console.log(`${r.file}\n${(r.durationMs / 1000).toFixed(0)} seconds: ${r.places.join(", ")}${r.presenters?.length ? `\nvoices: ${r.presenters.join(", ")}` : ""}`);
  },

  // Fill the schedule from the week's grid (free). --replace: new random picks after
  // the current block. --replan: Claude lays out a new grid first.
  async schedule(...args) {
    const { generateSchedule } = await import("./schedule/generate.js");
    const { config } = await import("./config.js");
    const days = Number(args.find((a) => /^\d+$/.test(a)) || config.broadcast.plan_days);
    await generateSchedule({ days, replace: args.includes("--replace"), replan: args.includes("--replan") });
    await commands.guide();
  },

  // tv.cmd buckets             list the buckets
  // tv.cmd buckets --build     Claude sorts the whole catalog into buckets (first time)
  // tv.cmd buckets --new       Claude adds a handful of new ones (the weekly pass)
  async buckets(...args) {
    const b = await import("./schedule/buckets.js");
    if (args.includes("--build")) await b.buildBuckets();
    const request = args.filter((a) => !a.startsWith("--")).join(" ") || null;
    if (args.includes("--new")) await b.newBuckets({ request });
    if (args.includes("--thin")) await b.newBuckets({ thin: args.includes("movies") ? "movie" : args.includes("shows") ? "show" : true, count: 10 });
    // Movies and single episodes by name; --all lists every member instead of the first 8.
    const { getDb } = await import("./db.js");
    const item = getDb().prepare("SELECT kind, title, year, show_title, season, episode FROM items WHERE id = ?");
    const name = (id) => {
      const r = item.get(id);
      if (!r) return `#${id}`;
      return r.kind === "episode" ? `${r.show_title} S${r.season}E${r.episode}` : `${r.title}${r.year ? ` (${r.year})` : ""}`;
    };
    if (args.includes("--html")) {
      const { writeBucketPage } = await import("./schedule/bucketpage.js");
      return console.log(`wrote ${writeBucketPage()} (open it in a browser)`);
    }
    const max = args.includes("--all") ? Infinity : 8;
    for (const x of b.listBuckets()) {
      const members = [...x.shows, ...x.items.map(name)];
      console.log(`${x.name} [${x.format}; ${x.dayparts.join("/")}${x.active_from ? `; ${x.active_from}..${x.active_to}` : ""}] ${members.length}: ${members.slice(0, max).join(", ")}${members.length > max ? ", ..." : ""}`);
    }
  },

  // tv.cmd catalog --html   write catalog.html: every show/movie, Netflix-style rows + search
  async catalog() {
    const { writeCatalogPage } = await import("./schedule/catalogpage.js");
    return console.log(`wrote ${writeCatalogPage()} (open it in a browser)`);
  },

  // tv.cmd plan [days]   print the grid (bucket slots) for the next days
  async plan(days = "2") {
    const { slotsBetween } = await import("./schedule/weekplan.js");
    let date = "";
    for (const s of slotsBetween(Date.now() - 86400000, Date.now() + Number(days) * 86400000)) {
      const d = new Date(s.at);
      const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      if (day !== date) console.log(`\n${(date = day)}`);
      console.log(`  ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}  ${s.name}`);
    }
  },

  // tv.cmd special "Scream marathon Saturday 8pm"   (or no text: Claude picks one)
  async special(...words) {
    const { planSpecials } = await import("./schedule/specials.js");
    const done = await planSpecials({ request: words.join(" ") || null, days: 8 });
    for (const s of done) console.log(`${s.label}: ${new Date(s.start).toLocaleString("en-US")} - ${new Date(s.end).toLocaleTimeString("en-US")} (${s.blocks} blocks)`);
  },

  // tv.cmd add commercial <url> [url...]   or   tv.cmd add clip <url>
  async add(kind, ...urls) {
    if (!["commercial", "clip"].includes(kind) || !urls.length) throw new Error("usage: tv.cmd add commercial|clip <url> [url...]");
    const { addFromUrls } = await import("./catalog/download.js");
    for (const a of await addFromUrls(kind, urls)) console.log(a.skipped ? `skipped "${a.title}": ${a.skipped}` : `added "${a.title}" (${a.seconds}s)`);
  },

  async guide() {
    const { guideText } = await import("./schedule/guide.js");
    // Discord timestamps shown as local times for the terminal.
    console.log(guideText().replace(/<t:(\d+):t>/g, (_, s) => new Date(s * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })));
  },

  // Load new code/settings into the running services. The player waits until the TV is off.
  async restart(which = "all") {
    if (which === "all" || which === "bot") {
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { DATA_DIR } = await import("./config.js");
      writeFileSync(join(DATA_DIR, "restart-bot"), "");
      console.log("bot: restarts within ~10 s (after any schedule/tagging job in progress)");
    }
    if (which === "all" || which === "player") {
      const { callPlayer } = await import("./local.js");
      const r = await callPlayer("/restart", {});
      console.log(`player: restarts ${r.restarting}${r.restarting === "now" ? "" : " (the TV comes back to the same channel by itself)"}`);
    }
  },

  // Test playlist: overrides the schedule until cleared (tv.cmd playlist --clear).
  async playlist(show, count = "3") {
    if (show === "--clear") {
      clearPlaylist();
      return console.log("Test playlist removed; the TV follows the schedule again.");
    }
    if (!show) throw new Error('usage: tv.cmd playlist "<show name>" [episodes]   or   tv.cmd playlist --clear');
    const rows = getDb().prepare(`SELECT * FROM items WHERE show_title = ? COLLATE NOCASE AND ${schedulableSql()}
      ORDER BY season IS NULL OR season = 0, season, episode`).all(show);
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

// The long-running parts: log anything that escapes, then exit so the service
// manager restarts a clean process instead of limping along.
if (cmd === "player" || cmd === "bot") {
  const { log } = await import("./log.js");
  const die = (kind) => (e) => {
    log.error(`${cmd}: ${kind}:`, e);
    setTimeout(() => process.exit(1), 500);
  };
  process.on("uncaughtException", die("crashed"));
  process.on("unhandledRejection", die("unhandled error"));
}
if (!commands[cmd]) {
  console.log(`commands:
  sync                         pull the catalog from Plex + local folders + Real-Debrid, import tags.csv files
  stats                        show what's in the catalog
  player                       run the streamer (the throwaway account)
  bot                          run the remote-control bot
  playlist "<show>" [count]    set the test playlist to a few episodes of a show
  tag [--dry|--sample|--redo|--order|--episodes]  tag the catalog with Claude (only untagged items unless --redo; --order: serialized/episodic; --episodes: musical/beach episodes)
  schedule [days] [--replace|--replan]  fill the schedule from the week's grid (--replace: new picks, free; --replan: new grid from Claude)
  buckets [--html|--all|--build|--new ["ideas"]|--thin]  list the buckets (--build: Claude sorts the catalog; --new: a few new ones, or the ones asked for; --thin: new homes for titles with only one bucket)
  catalog --html               write catalog.html: every show/movie, Netflix-style rows + search
  plan [days]                  print the grid of bucket slots
  guide                        print what's on today
  playlist --clear             drop the test playlist; the TV follows the schedule
  add commercial|clip <url...> download from YouTube etc. into rotation
  special ["request"]          plan a marathon/themed special (no text: Claude picks)
  restart [player|bot]         load new code/settings (player: at the next commercial break)`);
  process.exit(cmd === "help" ? 0 : 1);
}
await commands[cmd](...args);
