// Read-only: lists local commercials/clips/shorts/eyecatches that are byte-for-byte the same
// file under different names (what dedupe step 3b leaves out at the next sync).
//   node scripts\find-identical-files.mjs
import { getDb } from "../src/db.js";
import { identicalFiles } from "../src/catalog/dedupe.js";

const rows = getDb().prepare(`SELECT id, kind, source_key, duration_ms, play_count, duplicate_of FROM items
  WHERE source = 'local' AND present = 1 AND kind IN ('commercial', 'clip', 'short', 'eyecatch')`).all();
const groups = identicalFiles(rows.map((r) => ({ ...r })));
for (const g of groups) {
  console.log(`${g[0].kind}, ${Math.round(g[0].duration_ms / 1000)} s, ${g[0].size} bytes:`);
  for (const r of g) console.log(`  id ${r.id}  plays ${r.play_count}${r.duplicate_of ? `  (already a duplicate of ${r.duplicate_of})` : ""}  ${r.source_key}`);
}
console.log(`${rows.length} files checked, ${groups.length} identical group${groups.length === 1 ? "" : "s"}.`);
