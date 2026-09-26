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
import { chooseTracks, fromFfprobeStreams } from "./tracks.js";
import { dedupeCatalog } from "./dedupe.js";

export const RD_LIBRARY = "Real-Debrid";
const VIDEO = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".mpg", ".mpeg", ".ts", ".webm"]);
const EXTRAS = /\b(sample|trailers?|featurettes?|extras|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|bonus)\b/i;
// Where the useful part of a release name ends: "Show.S01E02.The.Title.1080p.WEB-DL.x264".
const JUNK = /[ ._\[(-](?:2160p|1080p|720p|576p|480p|4k|uhd|web[ ._-]?(?:dl|rip)?|bluray|blu-ray|b[dr]rip|hdtv|dvdrip|remux|x26[45]|h[ ._]?26[45]|hevc|avc|aac|ac3|e?ac-?3|dts|ddp?[ ._]?[257][ ._]?[01]|10bit|hdr|proper|repack|internal|amzn|nf|dsnp|hmax|hulu|atvp|multi|dual[ ._-]audio|dubbed|subbed|complete)(?=$|[ ._\])-])/i;

const tidy = (s) => s.replace(/[._]+/g, " ").replace(/\s+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim();
const cut = (s) => { const m = s.match(JUNK); return m ? s.slice(0, m.index) : s; };

// "The.Office.US" -> "The Office (US)", "Doctor.Who.2005" -> "Doctor Who (2005)" (how Plex names them).
function showName(raw) {
  let s = tidy(cut(raw)).replace(/\[[^\]]*\]/g, "").trim();
  s = s.replace(/[ (]+((?:19|20)\d{2})\)?$/, " ($1)").replace(/ (US|UK|AU|NZ|CA)$/, " ($1)");
  return tidy(s) || null;
}

// What a video file in a torrent is, from its name (and its folder / the torrent's name
// when the file name alone doesn't say). null for extras and samples.
export function parseRelease(path, torrentName = "") {
  const parts = path.split("/").filter(Boolean);
  const file = parts.at(-1);
  const name = file.slice(0, file.length - extname(file).length);
  if (EXTRAS.test(path)) return null;
  const fallbackShow = () => {
    for (const s of [...parts.slice(0, -1).reverse(), torrentName]) {
      const m = s.match(/^(.*?)[ ._-]*(?:S\d{1,2}|Season[ ._]?\d)/i);
      const show = m ? showName(m[1]) : null;
      if (show) return show;
    }
    return null;
  };

  // Show.S01E02.Title / Show.1x02.Title
  let m = name.match(/[Ss](\d{1,2})[ ._-]*[Ee](\d{1,3})|\b(\d{1,2})x(\d{2,3})\b/);
  if (m) {
    const title = tidy(cut(name.slice(m.index + m[0].length)).replace(/^[\s._-]*(?:[Ee]\d{1,3}[\s._-]*)*/, ""));
    const episode = Number(m[2] ?? m[4]);
    const show = showName(name.slice(0, m.index)) || fallbackShow();
    return { kind: "episode", show_title: show, season: Number(m[1] ?? m[3]), episode, title: title || `Episode ${episode}`, match: show ? "full" : "none" };
  }
  // Anime: "[Group] Show Name - 05 (1080p) [ABCD1234]"
  m = name.match(/^(?:\[[^\]]*\][ _]*)?(.+?)[ _]+-[ _]+(\d{1,4})(?:v\d)?(?:[ _]|$)/);
  if (m) {
    const show = showName(m[1]);
    return { kind: "episode", show_title: show, season: 1, episode: Number(m[2]), title: `Episode ${Number(m[2])}`, match: show ? "full" : "none" };
  }
  // Movie.Title.1994.1080p... The last year-like number is the year: "Blade Runner 2049 (2017)".
  const years = [...name.matchAll(/[ ._(\[]((?:19|20)\d{2})(?=[)\]]|[ ._]|$)/g)].filter((y) => tidy(name.slice(0, y.index)));
  const y = years.at(-1);
  if (y) return { kind: "movie", title: tidy(name.slice(0, y.index)), year: Number(y[1]), match: "full" };
  return { kind: "movie", title: tidy(cut(name)) || name, year: null, match: "none" };
}

export async function syncRealDebrid(client = new RealDebrid()) {
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
  const remember = db.prepare("INSERT OR REPLACE INTO rd_torrents (id, filename, read_at) VALUES (?, ?, ?)");

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
      remember.run(t.id, t.filename, new Date().toISOString());
    });
  }
  if (fresh.length) log.info(`realdebrid: read ${fresh.length} new torrents (${added} video files)`);

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
    if (!(await probeNew(client, seen))) break;
  }
}

// Durations and tracks for new files, read over the network (ffprobe only fetches the
// start of the file). Returns how many files it tried.
async function probeNew(client, { tried, dead }) {
  const db = getDb();
  const todo = db.prepare(`SELECT id, source_key, media_path, show_title, source_updated FROM items
    WHERE source = 'realdebrid' AND present = 1 AND duplicate_of IS NULL
      AND (streams_checked IS NULL OR streams_checked != source_updated)`).all().filter((r) => !tried.has(r.id));
  if (!todo.length) return 0;
  todo.forEach((r) => tried.add(r.id));
  log.info(`realdebrid: reading durations/tracks for ${todo.length} files`);
  const save = db.prepare(`UPDATE items SET duration_ms = ?, video_height = ?, audio_stream = ?, audio_lang = ?, subs = ?,
    playable = ?, unplayable_reason = ?, streams_checked = ?, cues = ? WHERE id = ?`);
  let n = 0;
  const worker = async () => {
    for (let r; (r = todo.shift()); ) {
      const torrent = r.source_key.split(":")[0];
      if (dead.has(torrent)) {
        // Real-Debrid lost this torrent's files (they're gone from its cache); every other
        // file in it would fail the same way. Re-adding the torrent on Real-Debrid fixes it.
        save.run(null, null, null, null, null, 0, "couldn't read from Real-Debrid: hoster_unavailable (whole torrent)", null, null, r.id);
        continue;
      }
      try {
        const p = await probe(await client.unrestrict(r.media_path));
        const video = p.streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
        const t = video ? chooseTracks(fromFfprobeStreams(p.streams), { showTitle: r.show_title }) : { playable: false, reason: "no video track" };
        const cues = (p.chapters || []).map((c) => Math.round(Number(c.start_time) * 1000)).filter((ms) => ms > 0);
        save.run(Math.round(Number(p.format.duration) * 1000) || null, video?.height ?? null, t.audioStream ?? null,
          t.audioLang ?? null, JSON.stringify(t.subs || { mode: "none" }), t.playable ? 1 : 0, t.reason || null, r.source_updated,
          cues.length ? JSON.stringify(cues) : null, r.id);
      } catch (e) {
        // Error text can contain the unrestricted URL: keep only the first line, without it.
        // Not marked as checked: Real-Debrid hiccups are usually temporary, so the next sync tries again.
        const why = e.message.split("\n")[0].replace(/https?:\/\/\S+/g, "<url>");
        if (why.includes("hoster_unavailable")) dead.add(torrent);
        save.run(null, null, null, null, null, 0, `couldn't read from Real-Debrid: ${why}`, null, null, r.id);
        log.warn(`realdebrid: couldn't read item ${r.id}: ${why}`);
      }
      if (++n % 100 === 0) log.info(`realdebrid: tracks ${n} done`);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  if (dead.size) log.warn(`realdebrid: ${dead.size} torrents have lost their files on Real-Debrid (hoster_unavailable); re-add them there to get them back`);
  return n;
}
