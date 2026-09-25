// Hand-tagging for commercials and clips: a tags.csv in each folder, editable in Excel.
// Sync adds a blank row for every new file, then imports whatever you've filled in.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { config } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";

const COLUMNS = ["filename", "decade", "holiday", "notes"];
export const HOLIDAYS = ["halloween", "thanksgiving", "christmas", "none"];

// "90s", "1990s", "'90s", "1994" -> 1990. Blank -> null.
export function parseDecade(s) {
  const m = String(s || "").match(/(\d{2,4})/);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[1].length === 2) n += n >= 30 ? 1900 : 2000;
  return Math.floor(n / 10) * 10;
}

function importFolder(kind, root) {
  const file = join(root, "tags.csv");
  const db = getDb();
  const items = db.prepare("SELECT id, source_key FROM items WHERE source = 'local' AND kind = ? AND present = 1").all(kind);

  const rows = existsSync(file)
    ? parse(readFileSync(file, "utf8").replace(/^﻿/, ""), { columns: (h) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, relax_column_count: true })
    : [];
  const byName = new Map(rows.map((r) => [String(r.filename || "").trim().toLowerCase(), r]));

  let added = 0, tagged = 0;
  const put = db.prepare(`INSERT INTO tags (item_id, holiday, decade, notes, source, tagged_at) VALUES (?, ?, ?, ?, 'csv', ?)
    ON CONFLICT (item_id) DO UPDATE SET holiday = excluded.holiday, decade = excluded.decade, notes = excluded.notes,
    source = 'csv', tagged_at = excluded.tagged_at`);
  const now = new Date().toISOString();
  tx(() => {
    for (const it of items) {
      const name = relative(root, it.source_key);
      const row = byName.get(name.toLowerCase());
      if (!row) {
        rows.push({ filename: name, decade: "", holiday: "", notes: "" });
        added++;
        continue;
      }
      let holiday = String(row.holiday || "").trim().toLowerCase() || "none";
      if (!HOLIDAYS.includes(holiday)) {
        log.warn(`tags: ${kind} "${name}": unknown holiday "${row.holiday}" (use ${HOLIDAYS.join("/")}); treating as none`);
        holiday = "none";
      }
      put.run(it.id, holiday, parseDecade(row.decade), String(row.notes || "").trim() || null, now);
      if (row.decade || holiday !== "none") tagged++;
    }
  });

  // Rows for files that are gone (the folder itself is here, so they were deleted).
  const present = new Set(items.map((it) => relative(root, it.source_key).toLowerCase()));
  const kept = rows.filter((r) => present.has(String(r.filename || "").trim().toLowerCase()));
  const dropped = rows.length - kept.length;
  rows.length = 0;
  rows.push(...kept);

  if (added || dropped) {
    rows.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
    try {
      // BOM so Excel reads accented filenames correctly.
      writeFileSync(file, "﻿" + stringify(rows, { header: true, columns: COLUMNS }));
      log.info(`tags: ${file}: ${added} new file(s) added, ${dropped} deleted file(s) removed`);
    } catch (e) {
      log.warn(`tags: couldn't update ${file} (${e.code}). Is it open in Excel? Close it and sync again.`);
    }
  }
  log.info(`tags: ${kind}s: ${tagged} of ${items.length} have tags`);
}

export function importCsvTags() {
  if (config.local.commercials && existsSync(config.local.commercials)) importFolder("commercial", config.local.commercials);
  if (config.local.clips && existsSync(config.local.clips)) importFolder("clip", config.local.clips);
}
