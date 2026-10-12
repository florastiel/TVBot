// A file you move by hand looks like a brand new file to the catalog (the path is its key), so its
// play count and tags used to reset. The [id] in the file name (a YouTube id, or a Discord
// attachment id) survives a move, so a new file whose [id] matches a vanished row inherits that row's
// play count, last-played time, excluded flag and tags (and its tags.csv decade/holiday/notes).
// Nothing is touched for a file that has already aired, and the parts of a split file never inherit.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { config } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";

const KINDS = ["commercial", "clip", "eyecatch"];
const ROOTS = { commercial: () => config.local.commercials, clip: () => config.local.clips, eyecatch: () => null }; // tags.csv exists for the first two
const idOf = (path) => path.match(/\[([^\[\]]{6,})\]\.[^.\\/]+$/)?.[1] ?? null;
const isPart = (path) => /\s-\spart\s\d/i.test(path);

export function inheritPlayHistory() {
  const db = getDb();
  const marks = KINDS.map(() => "?").join(",");
  const gone = db.prepare(`SELECT id, kind, source_key, play_count, last_played_at, excluded FROM items
    WHERE source = 'local' AND present = 0 AND kind IN (${marks}) AND play_count > 0`).all(...KINDS);
  if (!gone.length) return 0;
  const best = new Map(); // "kind|id" -> the vanished row with the most plays
  for (const g of gone) {
    const id = idOf(g.source_key);
    if (!id || isPart(g.source_key)) continue;
    const k = `${g.kind}|${id}`;
    if (!best.has(k) || g.play_count > best.get(k).play_count) best.set(k, g);
  }
  if (!best.size) return 0;
  const fresh = db.prepare(`SELECT id, kind, source_key FROM items
    WHERE source = 'local' AND present = 1 AND kind IN (${marks}) AND play_count = 0 AND last_played_at IS NULL`).all(...KINDS);

  const tagCols = db.prepare("PRAGMA table_info(tags)").all().map((c) => c.name).filter((c) => c !== "item_id");
  const copyTags = db.prepare(`INSERT OR IGNORE INTO tags (item_id, ${tagCols.join(", ")}) SELECT ?, ${tagCols.join(", ")} FROM tags WHERE item_id = ?`);
  const oldTags = db.prepare("SELECT decade, holiday, notes FROM tags WHERE item_id = ?");
  const bump = db.prepare("UPDATE items SET play_count = ?, last_played_at = ?, excluded = ? WHERE id = ?");
  const csv = { commercial: [], clip: [] }; // rows to put back into each tags.csv
  let n = 0;
  tx(() => {
    for (const f of fresh) {
      const id = idOf(f.source_key);
      const old = id && !isPart(f.source_key) ? best.get(`${f.kind}|${id}`) : null;
      if (!old || old.id === f.id) continue;
      bump.run(old.play_count, old.last_played_at, old.excluded ? 1 : 0, f.id);
      copyTags.run(f.id, old.id);
      const t = oldTags.get(old.id);
      if (t && csv[f.kind] && (t.decade || (t.holiday && t.holiday !== "none") || t.notes)) csv[f.kind].push({ path: f.source_key, ...t });
      best.delete(`${f.kind}|${id}`); // only one new file takes over a vanished row
      n++;
      log.info(`history: ${f.source_key.split(/[\\/]/).slice(-2).join("\\")} is the moved copy of an earlier file - keeps its ${old.play_count} play(s) and tags`);
    }
  });
  for (const kind of Object.keys(csv)) putBackCsvRows(kind, csv[kind]);
  return n;
}

// The hand-entered cells of a moved file go under its new name in the folder's tags.csv.
function putBackCsvRows(kind, items) {
  const root = ROOTS[kind]();
  if (!items.length || !root) return;
  const file = join(root, "tags.csv");
  if (!existsSync(file)) return;
  const rows = parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""), { columns: (h) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, relax_column_count: true });
  const byName = new Map(rows.map((r) => [String(r.filename || "").trim().toLowerCase(), r]));
  for (const it of items) {
    const name = relative(root, it.path);
    const row = byName.get(name.toLowerCase()) ?? (rows.push({ filename: name, decade: "", holiday: "", notes: "" }), rows.at(-1));
    if (!row.decade && it.decade) row.decade = `${it.decade}s`;
    if (!row.holiday && it.holiday && it.holiday !== "none") row.holiday = it.holiday;
    if (!row.notes && it.notes) row.notes = it.notes;
  }
  rows.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
  try { writeFileSync(file, "\uFEFF" + stringify(rows, { header: true, columns: ["filename", "decade", "holiday", "notes"] })); } catch (e) { log.warn(`history: couldn't update ${file} (${e.code}); is it open in Excel?`); }
}