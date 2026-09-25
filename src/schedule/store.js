// Saved schedule. Past blocks are kept as history (the no-repeat rule reads them);
// regenerating only replaces blocks from a given time onward.
import { getDb, tx } from "../db.js";

export function saveBlocks(blocks, source) {
  const now = new Date().toISOString();
  tx((db) => {
    const addBlock = db.prepare("INSERT INTO blocks (start_at, end_at, label, theme, source, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const addItem = db.prepare("INSERT INTO block_items (block_id, position, item_id) VALUES (?, ?, ?)");
    for (const b of blocks) {
      const id = addBlock.run(b.start, b.end, b.label, b.theme || null, source, now).lastInsertRowid;
      b.ids.forEach((itemId, i) => addItem.run(id, i, itemId));
    }
  });
}

// Regular blocks only: specials stay put until they air.
export function deleteBlocksFrom(ms) {
  return getDb().prepare("DELETE FROM blocks WHERE start_at >= ? AND source != 'special'").run(ms).changes;
}

function withItems(block) {
  if (!block) return null;
  block.items = getDb().prepare(`SELECT i.* FROM block_items bi JOIN items i ON i.id = bi.item_id
    WHERE bi.block_id = ? ORDER BY bi.position`).all(block.id);
  return block;
}

export const blockAt = (ms) =>
  withItems(getDb().prepare("SELECT * FROM blocks WHERE start_at <= ? AND end_at > ? ORDER BY start_at DESC LIMIT 1").get(ms, ms));

export const nextBlockAfter = (ms) =>
  withItems(getDb().prepare("SELECT * FROM blocks WHERE start_at >= ? ORDER BY start_at LIMIT 1").get(ms));

export const blocksBetween = (from, to) =>
  getDb().prepare("SELECT * FROM blocks WHERE end_at > ? AND start_at < ? ORDER BY start_at").all(from, to).map(withItems);

// How far the schedule runs without a gap, starting now. (A special planned for next
// week doesn't count as "the schedule is planned until next week".)
export function scheduledUntil(fromMs = Date.now()) {
  let t = fromMs;
  for (const b of getDb().prepare("SELECT start_at, end_at FROM blocks WHERE end_at > ? ORDER BY start_at").all(fromMs)) {
    if (b.start_at > t) break;
    t = Math.max(t, b.end_at);
  }
  return t;
}

// Item ids aired or scheduled in [from, to).
export function usedIds(from, to) {
  return new Set(getDb().prepare(`SELECT bi.item_id FROM block_items bi JOIN blocks b ON b.id = bi.block_id
    WHERE b.start_at >= ? AND b.start_at < ?`).all(from, to).map((r) => r.item_id));
}
