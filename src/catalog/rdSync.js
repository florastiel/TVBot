// Real-Debrid as a catalog source: every finished torrent on the account, one item per
// video file. There's no metadata server behind it, so show / season / episode (or movie
// title / year) come from the release names, and tracks are read with ffprobe over a
// freshly unrestricted URL, the same way as local files.
import { extname } from "node:path";
import { config } from "../config.js";
import { getDb, tx } from "../db.js";
import { log } from "../log.js";
import { RealDebrid } from "../realdebrid.js";
import { probe } from "./localScan.js";
import { chooseTracks, fromFfprobeStreams, hdrFromFfprobeStreams } from "./tracks.js";
import { dedupeCatalog } from "./dedupe.js";

export const RD_LIBRARY = "Real-Debrid";
const VIDEO = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".mpg", ".mpeg", ".ts", ".webm"]);
import { parseRelease } from "./release.js";
export { parseRelease };

// quick: only files never read before are probed (not the ones that failed in an earlier
// sync, which a full sync retries: that can be thousands over the network).
export async function syncRealDebrid(client = new RealDebrid(), { quick = false } = {}) {
  const db = getDb();
  const skip = (config.realdebrid.skip_torrents || []).map((s) => String(s).toLowerCase());
  const all = await client.torrents();
  const done = all.filter((t) => t.status === "downloaded" && !skip.some((s) => t.filename.toLowerCase().includes(s)));
  const ids = new Set(done.map((t) => t.id));
  const known = new Set(db.prepare("SELECT id FROM rd_torrents").all().map((r) => r.id));

  const upsert = db.prepare(`
    INSERT INTO items (source, source_key, kind, library, show_title, season, episode, title, year, match, media_path, source_updated, present)
    VALUES ('realdebrid', :source_key, :kind, :library, :show_title, :season, :episode, :title, :year, :match, :media_path, :source_updated, 1)
    ON CONFLICT (source, source_key) DO UPDATE SET
      kind = excluded.kind, show_title = excluded.show_title, season = excluded.season, episode = excluded.episode,
      title = excluded.title, year = excluded.year, match = excluded.match, media_path = excluded.media_path,
      source_updated = excluded.source_updated, present = 1`);
  const remember = db.prepare("INSERT OR REPLACE INTO rd_torrents (id, filename, read_at, added_at) VALUES (?, ?, ?, ?)");

  const minBytes = config.realdebrid.min_file_mb * 1024 * 1024;
  let added = 0;
  const fresh = done.filter((t) => !known.has(t.id));
  for (const t of fresh) {
    let info;
    try {
      info = await client.torrentInfo(t.id);
    } catch (e) {
      log.warn(`realdebrid: couldn't read torrent "${t.filename}": ${e.message}`);
      continue; // tried again next sync
    }
    // links[] lines up with the selected files, in order.
    const files = (info.files || []).filter((f) => f.selected);
    tx(() => {
      files.forEach((f, i) => {
        const link = info.links?.[i];
        if (!link || !VIDEO.has(extname(f.path).toLowerCase()) || f.bytes < minBytes) return;
        const p = parseRelease(f.path, info.filename || t.filename);
        if (!p) return;
        upsert.run({
          source_key: `${t.id}:${f.id}`, library: RD_LIBRARY, show_title: null, season: null, episode: null, year: null,
          ...p, media_path: link, source_updated: f.bytes,
        });
        added++;
      });
      remember.run(t.id, t.filename, new Date().toISOString(), t.added || null);
    });
  }
  if (fresh.length) log.info(`realdebrid: read ${fresh.length} new torrents (${added} video files)`);
  // When each torrent was added to the account (Real-Debrid's own date): the change log's dates.
  const stamp = db.prepare("UPDATE rd_torrents SET added_at = ? WHERE id = ? AND added_at IS NULL");
  tx(() => { for (const t of done) if (t.added) stamp.run(t.added, t.id); });

  // Torrents removed from the account: their items stay in history, off the schedule.
  tx((d) => {
    const mark = d.prepare("UPDATE items SET present = ? WHERE id = ?");
    for (const r of d.prepare("SELECT id, source_key, present FROM items WHERE source = 'realdebrid'").all()) {
      const here = ids.has(r.source_key.split(":")[0]) ? 1 : 0;
      if (here !== r.present) mark.run(here, r.id);
    }
    const forget = d.prepare("DELETE FROM rd_torrents WHERE id = ?");
    for (const id of known) if (!ids.has(id)) forget.run(id);
    d.exec(`INSERT OR IGNORE INTO shows (title) SELECT DISTINCT show_title FROM items
      WHERE source = 'realdebrid' AND kind = 'episode' AND show_title IS NOT NULL`);
  });
  log.info(`realdebrid: ${done.length} torrents on the account`);

  // Only the copy of each episode/movie that dedupe keeps is read. When a read fails, the
  // next dedupe picks another copy (if there is one), so go round a few times.
  const seen = { tried: new Set(), dead: new Set() };
  for (let round = 0; round < 4; round++) {
    dedupeCatalog();
    if (!(await probeNew(client, seen, quick))) break;
  }
}

// Durations and tracks for new files, read over the network (ffprobe only fetches the
// start of the file). Returns how many files it tried.
async function probeNew(client, { tried, dead }, quick = false) {
  const db = getDb();
  const todo = db.prepare(`SELECT id, source_key, media_path, show_title, source_updated FROM items
    WHERE source = 'realdebrid' AND present = 1 AND duplicate_of IS NULL
      AND (streams_checked IS NULL OR streams_checked != source_updated)
      ${quick ? "AND unplayable_reason IS NULL" : ""}`).all().filter((r) => !tried.has(r.id));
  if (!todo.length) return 0;
  todo.forEach((r) => tried.add(r.id));
  log.info(`realdebrid: reading durations/tracks for ${todo.length} files`);
  const save = db.prepare(`UPDATE items SET duration_ms = ?, video_height = ?, audio_stream = ?, audio_lang = ?, subs = ?,
    playable = ?, unplayable_reason = ?, streams_checked = ?, cues = ?, hdr = ? WHERE id = ?`);
  let n = 0;
  const worker = async () => {
    for (let r; (r = todo.shift()); ) {
      const torrent = r.source_key.split(":")[0];
      if (dead.has(torrent)) {
        // Real-Debrid lost this torrent's files (they're gone from its cache); every other
        // file in it would fail the same way. Re-adding the torrent on Real-Debrid fixes it.
        save.run(null, null, null, null, null, 0, "couldn't read from Real-Debrid: hoster_unavailable (whole torrent)", null, null, null, r.id);
        continue;
      }
      try {
        const p = await probeWithRetry(client, r.media_path);
        const video = p.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
        const t = video ? chooseTracks(fromFfprobeStreams(p.streams), { showTitle: r.show_title }) : { playable: false, reason: "no video track" };
        const cues = (p.chapters || []).map((c) => Math.round(Number(c.start_time) * 1000)).filter((ms) => ms > 0);
        save.run(Math.round(Number(p.format.duration) * 1000) || null, video?.height ?? null, t.audioStream ?? null,
          t.audioLang ?? null, JSON.stringify(t.subs || { mode: "none" }), t.playable ? 1 : 0, t.reason || null, r.source_updated,
          cues.length ? JSON.stringify(cues) : null, hdrFromFfprobeStreams(p.streams), r.id);
      } catch (e) {
        // Not marked as checked: Real-Debrid hiccups are usually temporary, so the next sync tries again.
        const why = errorText(e);
        if (why.includes("hoster_unavailable")) dead.add(torrent);
        save.run(null, null, null, null, null, 0, `couldn't read from Real-Debrid: ${why}`, null, null, null, r.id);
        log.warn(`realdebrid: couldn't read item ${r.id}: ${why}`);
      }
      if (++n % 100 === 0) log.info(`realdebrid: tracks ${n} done`);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  if (dead.size) log.warn(`realdebrid: ${dead.size} torrents have lost their files on Real-Debrid (hoster_unavailable); re-add them there to get them back`);
  return n;
}

// ffprobe's first stderr line (e.g. "Failed to read handshake response") rather than the
// command line, without any URL (an unrestricted link works for anyone who has it).
function errorText(e) {
  const stderr = String(e.stderr || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  const text = e.killed ? "ffprobe timed out" : stderr ? `ffprobe: ${stderr}` : e.message.split("\n")[0];
  return text.replace(/https?:\/\/\S+/g, "<url>").replace(/\[\w+ @ [0-9a-fA-Fx]+\]\s*/g, "");
}

// Real-Debrid's download servers sometimes drop a connection mid-handshake (a second
// later the same file reads fine), so try a couple more times with a fresh link.
async function probeWithRetry(client, link) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await probe(await client.unrestrict(link));
    } catch (e) {
      const ffprobeFailed = e.stderr !== undefined || e.killed;
      if (!ffprobeFailed || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
