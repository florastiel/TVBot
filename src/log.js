// Timestamped logger. The long-running parts (player, bot) also write a daily file:
// logs\player-2026-09-25.log, logs\bot-2026-09-25.log; files older than 14 days are
// deleted. Tokens must never reach it; redact() is a backstop.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");
const KEEP_DAYS = 14;
const name = ["player", "bot"].includes(process.argv[2]) ? process.argv[2] : null;
let pruned = "";

const redact = (s) => String(s).replace(/X-Plex-Token=[A-Za-z0-9_-]+/g, "X-Plex-Token=***");
const stamp = () => new Date().toLocaleString("sv-SE", { hour12: false }); // local "2026-09-25 14:05:01"

function toFile(line) {
  if (!name) return;
  const day = stamp().slice(0, 10);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${name}-${day}.log`), line + "\n");
    if (pruned !== day) {
      pruned = day;
      for (const f of readdirSync(LOG_DIR)) {
        const p = join(LOG_DIR, f);
        if (Date.now() - statSync(p).mtimeMs > KEEP_DAYS * 86400000) rmSync(p, { force: true });
      }
    }
  } catch { /* logging must never crash the TV */ }
}

const out = (level, args) => {
  const line = `${stamp()} ${level} ${args.map((a) => redact(a instanceof Error ? a.stack : typeof a === "object" ? JSON.stringify(a) : a)).join(" ")}`;
  (level === "ERROR" || level === "WARN " ? console.error : console.log)(line);
  toFile(line);
};
export const log = {
  info: (...a) => out("INFO ", a),
  warn: (...a) => out("WARN ", a),
  error: (...a) => out("ERROR", a),
};
