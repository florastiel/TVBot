// What the scheduler can't use, and why: tv.cmd unschedulable. The reasons are the same
// conditions as schedulableSql() (catalog/schedulable.js), checked in this order, so each
// item is listed once under the first one that applies.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, DATA_DIR } from "./config.js";
import { getDb } from "./db.js";
import { schedulableSql } from "./catalog/schedulable.js";

// Order matters: the first matching reason wins.
const REASONS = [
  ["gone", "Removed from its source (torrent deleted, file gone): kept only as history"],
  ["excluded", "Excluded by hand (broken or mislabeled file)"],
  ["duplicate", "Duplicate copy: the same episode/movie plays from another copy"],
  ["oddball", "Oddball: far shorter than the rest of its show (a promo or clip listed as an episode)"],
  ["never", "Show is in shows.never in config.yaml"],
  ["rd_hoster", "Real-Debrid can't serve the file (hoster unavailable: torrent dead or not cached)"],
  ["rd_infringing", "Real-Debrid blocked the file as infringing"],
  ["rd_read", "Real-Debrid file couldn't be read (network, handshake or ffprobe error): retried on a full sync"],
  ["lang", "Foreign audio and no English subtitles"],
  ["tracks", "No video or audio track (or a split/broken file)"],
  ["unplayable_other", "Unplayable for another reason (see the reason text)"],
  ["unmatched", "Not identified: Plex/the release name couldn't tell what it is (include_unmatched is off)"],
  ["show_only", "Known show but no episode identified (include_show_only_matches is off)"],
];
const LABEL = Object.fromEntries(REASONS);

// SQL that names the first reason an item is unschedulable, or NULL when it's schedulable.
function reasonSql(a = "i") {
  const never = (config.shows?.never || []).map((t) => `'${String(t).replaceAll("'", "''")}'`);
  const neverCond = never.length ? `${a}.show_title IN (${never.join(",")})` : "0";
  const r = `${a}.unplayable_reason`;
  return `CASE
    WHEN ${a}.present = 0 THEN 'gone'
    WHEN ${a}.excluded THEN 'excluded'
    WHEN ${a}.duplicate_of IS NOT NULL THEN 'duplicate'
    WHEN ${a}.oddball THEN 'oddball'
    WHEN ${neverCond} THEN 'never'
    WHEN ${a}.playable = 0 AND ${r} LIKE '%hoster_unavailable%' THEN 'rd_hoster'
    WHEN ${a}.playable = 0 AND ${r} LIKE '%infringing%' THEN 'rd_infringing'
    WHEN ${a}.playable = 0 AND ${r} LIKE '%Real-Debrid%' THEN 'rd_read'
    WHEN ${a}.playable = 0 AND ${r} LIKE '%audio and no eng%' THEN 'lang'
    WHEN ${a}.playable = 0 AND (${r} LIKE 'no video%' OR ${r} LIKE 'no audio%' OR ${r} LIKE '%split into multiple%') THEN 'tracks'
    WHEN ${a}.playable = 0 THEN 'unplayable_other'
    WHEN ${a}.match = 'none' THEN 'unmatched'
    WHEN ${a}.match = 'show' THEN 'show_only'
    ELSE NULL END`;
}

// A show/movie label for grouping: the show for episodes, the title for the rest.
const labelOf = (r) => r.show_title || r.title;

export function unschedulableReport({ all = false } = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM (SELECT i.id, i.kind, i.source, i.show_title, i.title, i.year, i.unplayable_reason,
      ${reasonSql("i")} why, ${schedulableSql("i")} ok FROM items i) WHERE why IS NOT NULL AND NOT ok`).all();
  const total = db.prepare("SELECT COUNT(*) n FROM items").get().n;
  const schedulable = db.prepare(`SELECT COUNT(*) n FROM items i WHERE ${schedulableSql("i")}`).get().n;

  const byReason = new Map(REASONS.map(([k]) => [k, []]));
  for (const r of rows) byReason.get(r.why)?.push(r);

  const summary = REASONS.map(([k]) => {
    const list = byReason.get(k);
    const kinds = {};
    for (const r of list) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    return { reason: k, why: LABEL[k], items: list.length, ...kinds };
  }).filter((s) => s.items);

  const lines = [`# Not schedulable (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`, "",
    `${schedulable} of ${total} catalog rows are schedulable; ${total - schedulable} aren't.`, "",
    "| Reason | Items | Kinds |", "|---|---:|---|"];
  for (const s of summary) {
    const { reason, why, items, ...kinds } = s;
    lines.push(`| ${why} | ${items} | ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")} |`);
  }
  for (const [k] of REASONS) {
    const list = byReason.get(k);
    if (!list.length) continue;
    lines.push("", `## ${LABEL[k]} (${list.length})`, "");
    // Episodes grouped by show; movies/spots one per line. Removed/duplicate rows are numerous,
    // so those only list the biggest groups unless --all.
    const noisy = k === "gone" || k === "duplicate";
    const groups = new Map();
    for (const r of list) {
      const key = r.kind === "episode" ? `${labelOf(r)} [episodes]` : `${r.kind}: ${r.title}${r.year ? ` (${r.year})` : ""}`;
      const g = groups.get(key) || { n: 0, id: r.id, src: r.source, why: r.unplayable_reason };
      g.n++;
      groups.set(key, g);
    }
    const sorted = [...groups].sort((a, b) => b[1].n - a[1].n);
    const cap = all ? Infinity : noisy ? 25 : 150;
    for (const [key, g] of sorted.slice(0, cap)) {
      const note = !noisy && g.why && k === "unplayable_other" ? ` - ${g.why}` : "";
      lines.push(`- ${key}${g.n > 1 ? `: ${g.n}` : ` (id ${g.id}, ${g.src})`}${note}`);
    }
    if (sorted.length > cap) lines.push(`- ...and ${sorted.length - cap} more (run with --all for every one)`);
  }
  const file = join(DATA_DIR, "unschedulable.md");
  writeFileSync(file, lines.join("\n") + "\n");
  return { summary, total, schedulable, file };
}
