// English subtitles from OpenSubtitles.com for items whose file has none (mostly Real-Debrid
// ones): the .srt is downloaded ahead into data\subs\<id>.srt, the same place Plex and local
// sidecar subtitles go, and the item switches to subs mode "sidecar". It then plays with
// subtitles even when streamed live, and foreign-audio files that were skipped for having no
// English track become playable. Needs OPENSUBTITLES_API_KEY (+ USERNAME/PASSWORD for
// downloads) in .env; settings under `opensubtitles:` in config.yaml.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config, secrets } from "../config.js";
import { getDb } from "../db.js";
import { log } from "../log.js";
import { SUBS_DIR } from "./plexSync.js";

const API = "https://api.opensubtitles.com/api/v1";
const UA = "tvchannel v1.0";
const MIN_GAP_MS = 1100; // their search limit is about 1 request a second

class QuotaError extends Error {}
class AuthError extends Error {}

class OpenSubtitles {
  constructor() {
    this.key = secrets.osKey;
    this.base = API;
    this.token = null;
    this.last = 0;
  }

  headers(extra = {}) {
    const h = { "Api-Key": this.key, "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async call(path, { method = "GET", body } = {}) {
    for (let attempt = 1; ; attempt++) {
      const wait = this.last + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      const res = await fetch(`${this.base}${path}`, {
        method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 && attempt < 4) {
        await sleep(5000 * attempt);
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.message || `HTTP ${res.status}`;
        if (res.status === 406 || /quota|limit/i.test(msg)) throw new QuotaError(msg);
        if (res.status === 401 || res.status === 403) throw new AuthError(msg);
        throw new Error(`opensubtitles ${path.split("?")[0]}: ${msg}`);
      }
      return data;
    }
  }

  async login() {
    if (!secrets.osUser || !secrets.osPass) return;
    const d = await this.call("/login", { method: "POST", body: { username: secrets.osUser, password: secrets.osPass } });
    this.token = d.token;
    if (d.base_url) this.base = `https://${d.base_url}/api/v1`;
  }

  search(item) {
    const q = new URLSearchParams({ languages: "en", query: (item.kind === "episode" ? item.show_title : item.title).toLowerCase() }); // lowercase: the API redirects to its normalized form otherwise
    if (item.kind === "episode") {
      q.set("type", "episode");
      q.set("season_number", item.season);
      q.set("episode_number", item.episode);
    } else {
      q.set("type", "movie");
      if (item.year) q.set("year", item.year);
    }
    q.sort(); // the API wants the parameters in alphabetical order
    return this.call(`/subtitles?${q}`).then((d) => d.data || []);
  }

  async download(fileId) {
    const d = await this.call("/download", { method: "POST", body: { file_id: fileId, sub_format: "srt" } });
    const res = await fetch(d.link, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`subtitle file: HTTP ${res.status}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), remaining: d.remaining };
  }
}

const norm = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/\(\d{4}\)|\(us\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// The best match among search results, or null. Wrong episodes / titles are dropped;
// then trusted uploaders, human translations, full (non-SDH) subs and popularity win.
function pickBest(item, results) {
  const wantTitle = norm(item.kind === "episode" ? item.show_title : item.title);
  const ok = results.filter((r) => {
    const a = r.attributes;
    const f = a.feature_details || {};
    if (!a.files?.[0]?.file_id) return false;
    if (item.kind === "episode") {
      if (f.season_number != null && f.season_number !== item.season) return false;
      if (f.episode_number != null && f.episode_number !== item.episode) return false;
      const t = norm(f.parent_title || f.title);
      return !t || t === wantTitle || t.includes(wantTitle) || wantTitle.includes(t);
    }
    if (item.year && f.year && Math.abs(f.year - item.year) > 1) return false;
    return norm(f.title) === wantTitle;
  });
  const score = (r) => {
    const a = r.attributes;
    return (a.from_trusted ? 100 : 0) + (a.ai_translated || a.machine_translated ? -200 : 0) + (a.hearing_impaired ? -20 : 0)
      + Math.log10(1 + (a.download_count || 0)) * 10 + (a.ratings || 0);
  };
  return ok.sort((x, y) => score(y) - score(x))[0] || null;
}

const SIDECAR = { mode: "sidecar", codec: "srt", id: null, opensubtitles: true };

function apply(id) {
  getDb().prepare("UPDATE items SET subs = ?, playable = 1, unplayable_reason = NULL WHERE id = ?").run(JSON.stringify(SIDECAR), id);
}

export async function fetchMissingSubs() {
  const cfg = config.opensubtitles;
  if (!cfg.enabled || !secrets.osKey) return;
  const db = getDb();
  const sources = cfg.sources?.length ? cfg.sources : ["realdebrid"];
  mkdirSync(SUBS_DIR, { recursive: true });

  // Items with no English subtitles, foreign-audio ones (skipped without them) first.
  const rows = db.prepare(`
    SELECT i.id, i.kind, i.show_title, i.season, i.episode, i.title, i.year, i.playable
    FROM items i LEFT JOIN subtitle_lookups l ON l.item_id = i.id
    WHERE i.source IN (${sources.map(() => "?").join(",")}) AND i.present = 1 AND i.duplicate_of IS NULL
      AND i.streams_checked IS NOT NULL AND i.kind IN ('episode', 'movie')
      AND (i.subs IS NULL OR i.subs LIKE '%"mode":"none"%')
      AND (i.playable = 1 OR i.unplayable_reason LIKE '% audio and no % subtitles')
      AND (i.kind = 'movie' OR (i.show_title IS NOT NULL AND i.season IS NOT NULL AND i.episode IS NOT NULL))
      AND (l.item_id IS NULL OR (l.result = 'miss' AND l.tried_at < ?))
    ORDER BY i.playable, i.id`).all(...sources, new Date(Date.now() - cfg.retry_days * 86400000).toISOString());
  if (!rows.length) return;

  const client = new OpenSubtitles();
  const note = db.prepare("INSERT OR REPLACE INTO subtitle_lookups (item_id, tried_at, result) VALUES (?, ?, ?)");
  let found = 0, missed = 0, reused = 0, calls = 0;
  try {
    for (const r of rows) {
      const file = join(SUBS_DIR, `${r.id}.srt`);
      // Downloaded earlier, but a re-read of the file's tracks reset the item: just point it back.
      if (existsSync(file)) { apply(r.id); reused++; continue; }
      if (calls >= cfg.max_per_sync) break;
      if (calls === 0) await client.login();
      calls++;
      try {
        const best = pickBest(r, await client.search(r));
        if (!best) { note.run(r.id, new Date().toISOString(), "miss"); missed++; continue; }
        const { bytes, remaining } = await client.download(best.attributes.files[0].file_id);
        writeFileSync(file, bytes);
        apply(r.id);
        note.run(r.id, new Date().toISOString(), "found");
        found++;
        if (remaining === 0) throw new QuotaError("daily download limit used up");
      } catch (e) {
        if (e instanceof QuotaError || e instanceof AuthError) throw e;
        log.warn(`opensubtitles: item ${r.id} failed: ${e.message}`); // tried again next sync
      }
    }
  } catch (e) {
    if (e instanceof QuotaError) log.info(`opensubtitles: stopping, ${e.message}; the rest waits for the next sync`);
    else if (e instanceof AuthError) log.warn(`opensubtitles: ${e.message}. Check OPENSUBTITLES_API_KEY / USERNAME / PASSWORD in .env`);
    else throw e;
  }
  if (found || missed || reused) log.info(`opensubtitles: ${found} subtitle files downloaded, ${missed} not found, ${reused} restored (${rows.length} items wanted one)`);
}
