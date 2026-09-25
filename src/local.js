// The bot and the player talk over HTTP on 127.0.0.1 only, with a shared secret so
// nothing else on the machine can drive the TV.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config, DATA_DIR } from "./config.js";

export const PLAYER_PORT = config.player?.port || 7651;
export const PLAYER_URL = `http://127.0.0.1:${PLAYER_PORT}`;

export function localSecret() {
  mkdirSync(DATA_DIR, { recursive: true });
  const f = join(DATA_DIR, "local-secret.txt");
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString("hex"));
  return readFileSync(f, "utf8").trim();
}

// For the bot: call the player.
export async function callPlayer(path, body) {
  const res = await fetch(`${PLAYER_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-tv-secret": localSecret(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `player said HTTP ${res.status}`);
  return data;
}
