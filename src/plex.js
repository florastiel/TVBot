import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config, secrets, DATA_DIR } from "./config.js";
import { log } from "./log.js";

function clientId() {
  mkdirSync(DATA_DIR, { recursive: true });
  const f = join(DATA_DIR, "plex-client-id.txt");
  if (!existsSync(f)) writeFileSync(f, randomUUID());
  return readFileSync(f, "utf8").trim();
}

// Talks to the friend's Plex server as a normal (non-admin) user, over a direct
// connection only. Plex Relay is never used: it's bandwidth-capped and slow.
export class Plex {
  constructor() {
    this.clientId = clientId();
    this.base = null;
    this.token = null;
  }

  headers(token = this.token) {
    return {
      Accept: "application/json",
      "X-Plex-Token": token,
      "X-Plex-Client-Identifier": this.clientId,
      "X-Plex-Product": "tvchannel",
    };
  }

  async connect() {
    const res = await fetch("https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", {
      headers: this.headers(secrets.plexToken),
    });
    if (!res.ok) throw new Error(`plex.tv resources: HTTP ${res.status}`);
    const server = (await res.json()).find((r) => r.provides.includes("server") && r.name === config.plex.server_name);
    if (!server) throw new Error(`no Plex server named "${config.plex.server_name}" on this account`);
    // A shared server hands us its own access token; the account token won't work there.
    this.token = server.accessToken || secrets.plexToken;
    // Prefer a LAN address if one works (it won't, unless glados is on his network), then public.
    const candidates = server.connections.filter((c) => !c.relay).sort((a, b) => b.local - a.local);
    for (const c of candidates) {
      try {
        const r = await fetch(`${c.uri}/identity`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          this.base = c.uri;
          log.info(`plex: connected to ${server.name} at ${c.uri}`);
          return this;
        }
      } catch { /* next */ }
    }
    throw new Error(`no direct connection to ${server.name} answered (relay-only is not supported)`);
  }

  async get(path, { timeoutMs = 30000 } = {}) {
    if (!this.base) await this.connect();
    const res = await fetch(`${this.base}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`plex ${path}: HTTP ${res.status}`);
    return (await res.json()).MediaContainer;
  }

  async sections() {
    return (await this.get("/library/sections")).Directory;
  }

  // Every item of a type in a library, paged. type: 1 movie, 2 show, 4 episode.
  async listAll(sectionKey, type, pageSize = 500) {
    const out = [];
    for (let start = 0; ; start += pageSize) {
      const page = await this.get(
        `/library/sections/${sectionKey}/all?type=${type}&includeGuids=1` +
          `&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`,
      );
      out.push(...(page.Metadata || []));
      if (!page.Metadata || out.length >= page.totalSize) break;
    }
    return out;
  }

  // Items of a type added since sinceSec (epoch seconds), newest first; stops at the first older one.
  async listRecent(sectionKey, type, sinceSec, pageSize = 200) {
    const out = [];
    for (let start = 0; ; start += pageSize) {
      const page = await this.get(
        `/library/sections/${sectionKey}/all?type=${type}&includeGuids=1&sort=addedAt:desc` +
          `&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`,
      );
      const items = page.Metadata || [];
      for (const it of items) {
        if ((it.addedAt || 0) < sinceSec) return out;
        out.push(it);
      }
      if (items.length < pageSize) break;
    }
    return out;
  }

  // Full details (incl. audio/subtitle streams) for many items in one request.
  async metadataBatch(ratingKeys) {
    return (await this.get(`/library/metadata/${ratingKeys.join(",")}?includeChapters=1`, { timeoutMs: 60000 })).Metadata || [];
  }

  // Direct URL to the original file (no Plex transcoding). Contains the token: never log it.
  fileUrl(mediaPath) {
    return `${this.base}${mediaPath}?X-Plex-Token=${this.token}`;
  }
}
