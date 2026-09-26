// Saved schedule. Past blocks are kept as history (the no-repeat rule reads them);
// regenerating only replaces blocks from a given time onward.
import { getDb, tx } from "../db.js";

export function saveBlocks(blocks, source) {
  const now = new Date().toISOString();
  tx((db) => {
    const addBlock = db.prepare("INSERT INTO blocks (start_at, end_at, label, theme, source, created_at, bucket_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const addItem = db.prepare("INSERT INTO block_items (block_id, position, item_id) VALUES (?, ?, ?)");
    for (const b of blocks) {
      const id = addBlock.run(b.start, b.end, b.label, b.theme || null, source, now, b.bucketId ?? null).lastInsertRowid;
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

// Take one item out of a block (a skipped show), so it doesn't come back.
export function removeFromBlock(blockId, itemId) {
  return getDb().prepare("DELETE FROM block_items WHERE block_id = ? AND item_id = ?").run(blockId, itemId).changes;
}

// Add an item to the end of a block (a show that filled a gap), so the guide, the
// no-repeat rule and in-order shows know it aired.
export function appendToBlock(blockId, itemId) {
  const db = getDb();
  const pos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM block_items WHERE block_id = ?").get(blockId).p;
  db.prepare("INSERT INTO block_items (block_id, position, item_id) VALUES (?, ?, ?)").run(blockId, pos, itemId);
}

// Block `blockId` (ending at oldEnd) now ends at newEnd, and the blocks after it move by
// the same amount, earlier or later. The move stops at a gap or at a special, which keeps
// its announced time: moving earlier, the block just before it keeps its end (the spare
// time gets filled); moving later into a special isn't possible. Returns false if
// nothing could move.
export function shiftBlocks(blockId, oldEnd, newEnd) {
  const delta = newEnd - oldEnd;
  return tx((db) => {
    const at = db.prepare("SELECT * FROM blocks WHERE start_at = ? ORDER BY id LIMIT 1");
    const run = [];
    for (let t = oldEnd, b; (b = at.get(t)) && b.source !== "special"; t = b.end_at) run.push(b);
    const special = at.get(run.length ? run.at(-1).end_at : oldEnd)?.source === "special";
    if (special && (delta > 0 || !run.length)) return false;
    db.prepare("UPDATE blocks SET end_at = ? WHERE id = ?").run(newEnd, blockId);
    const set = db.prepare("UPDATE blocks SET start_at = ?, end_at = ? WHERE id = ?");
    run.forEach((b, i) => set.run(b.start_at + delta, special && i === run.length - 1 ? b.end_at : b.end_at + delta, b.id));
    return true;
  });
}

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
