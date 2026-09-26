import { setTimeout as sleep } from "node:timers/promises";
import { secrets } from "./config.js";

const API = "https://api.real-debrid.com/rest/1.0";
// Real-Debrid allows 250 requests a minute; stay well under it.
const MIN_GAP_MS = 300;

// Talks to Real-Debrid with the account's API token (real-debrid.com/apitoken).
// Torrent links (real-debrid.com/d/...) are permanent; the direct download URL made
// from one ("unrestricting") is what ffmpeg reads, and is made fresh each time.
export class RealDebrid {
  constructor(token = secrets.rdToken) {
    if (!token) throw new Error("RD_TOKEN is not set in .env");
    this.token = token;
    this.last = 0;
  }

  async call(path, { method = "GET", form, timeoutMs = 30000 } = {}) {
    for (let attempt = 1; ; attempt++) {
      const wait = this.last + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}` },
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 && attempt < 5) {
        await sleep(5000 * attempt);
        continue;
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`real-debrid ${path.split("?")[0]}: ${data?.error || `HTTP ${res.status}`}`);
      return data;
    }
  }

  // Every torrent on the account, newest first.
  async torrents() {
    const out = [];
    for (let page = 1; ; page++) {
      const batch = await this.call(`/torrents?page=${page}&limit=100`);
      if (!batch?.length) break;
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  // files: [{id, path, bytes, selected}], links: one per selected file, in file order.
  async torrentInfo(id) {
    return this.call(`/torrents/info/${id}`);
  }

  // Direct URL for a torrent link. Never log it: anyone with it can download the file.
  async unrestrict(link) {
    return (await this.call("/unrestrict/link", { method: "POST", form: { link } })).download;
  }
}

let shared;
// For playback and download-ahead: one client, so they share the rate limit.
export function rd() {
  return (shared ??= new RealDebrid());
}
