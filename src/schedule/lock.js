// Only one schedule planner at a time, across processes (the bot's weekly upkeep, a
// manual tv.cmd schedule/special, an admin command). Two at once would both fill the
// same free time and leave overlapping blocks.
import { openSync, closeSync, writeSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";

const LOCK = join(DATA_DIR, "schedule.lock");
const STALE_MS = 30 * 60000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

async function acquire() {
  for (let waited = 0; ; waited += 5000) {
    try {
      const fd = openSync(LOCK, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    // Someone else holds it. Clear it if its owner is gone or it's ancient.
    let pid = 0, age = 0;
    try { pid = Number(readFileSync(LOCK, "utf8")); age = Date.now() - statSync(LOCK).mtimeMs; } catch { continue; }
    if (!alive(pid) || age > STALE_MS) { rmSync(LOCK, { force: true }); continue; }
    if (waited === 0) log.info(`schedule: another planner (pid ${pid}) is running; waiting for it`);
    await sleep(5000);
  }
}

export async function withScheduleLock(fn) {
  await acquire();
  try {
    return await fn();
  } finally {
    rmSync(LOCK, { force: true });
  }
}
