// The change log: what was added to the server, by day. Real-Debrid things (added by watching in
// Stremio and the like) come with Real-Debrid's own "added" date, so this reaches back as far as the
// account does; Plex and local files are dated from when the catalog first saw them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, DATA_DIR } from "./config.js";
import { getDb } from "./db.js";
import { localDay } from "./schedule/time.js";

const gb = (b) => (b >= 1e11 ? `${Math.round(b / 1e9)} GB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// A Real-Debrid torrent as a line: "The Wire: 13 episodes (S1), 4.2 GB", flagged if it can't be played.
function torrentLine(db, t) {
  const rows = db.prepare(`SELECT kind, show_title, title, year, season, playable, unplayable_reason, source_updated FROM items
    WHERE source = 'realdebrid' AND source_key LIKE ? || ':%' AND present = 1`).all(t.id);
  if (!rows.length) return { text: `${t.filename} (no video files it can use)`, sort: t.filename };
  const bytes = rows.reduce((n, r) => n + (r.source_updated || 0), 0);
  const eps = rows.filter((r) => r.kind === "episode");
  const movies = rows.filter((r) => r.kind !== "episode");
  const parts = [];
  if (eps.length) {
    const byShow = new Map();
    for (const r of eps) (byShow.get(r.show_title || t.filename) || byShow.set(r.show_title || t.filename, []).get(r.show_title || t.filename)).push(r);
    for (const [show, list] of byShow) {
      const seasons = [...new Set(list.map((r) => r.season).filter((s) => s != null))].sort((a, b) => a - b);
      parts.push(`${show}: ${plural(list.length, "episode")}${seasons.length ? ` (${seasons.length > 2 ? `S${seasons[0]}-S${seasons.at(-1)}` : seasons.map((s) => `S${s}`).join(", ")})` : ""}`);
    }
  }
  if (movies.length > 3) {
    // Many loose files (a batch the catalog couldn't split into a show): just the torrent's name.
    parts.push(`${t.filename.replace(/\.(mkv|mp4|avi)$/i, "")}: ${plural(movies.length + eps.length, "file")}`);
  } else {
    for (const m of movies) parts.push(`${m.title}${m.year ? ` (${m.year})` : ""}`);
  }
  const bad = rows.filter((r) => !r.playable);
  const why = bad.length === rows.length
    ? (bad.some((r) => /infringing/.test(r.unplayable_reason || "")) ? " ⚠ blocked by Real-Debrid" : bad.some((r) => /hoster_unavailable/.test(r.unplayable_reason || "")) ? " ⚠ not available on Real-Debrid" : " ⚠ can't be played")
    : bad.length ? ` (${bad.length} of ${rows.length} can't be played)` : "";
  return { text: `${parts.join("; ")}, ${gb(bytes)}${why}`, sort: parts[0] || t.filename };
}

// days: how many days back (1 = today only). Returns [{ date, label, rd: [line], plex: [line], local: [line] }], newest first.
export function changelog(days = 1, now = Date.now()) {
  const db = getDb();
  const today = localDay(now);
  const out = [];
  for (let k = 0; k < days; k++) {
    const day = localDay(today.startMs - k * 86400000 + 3600000);
    const entry = { date: day.date, label: new Date(day.startMs + 43200000).toLocaleDateString("en-US", { timeZone: config.broadcast.timezone, weekday: "long", month: "long", day: "numeric" }), rd: [], plex: [], local: [] };
    // Real-Debrid: torrents added that day (RD dates are UTC; match on the local day).
    const torrents = db.prepare("SELECT id, filename, added_at FROM rd_torrents WHERE added_at IS NOT NULL").all()
      .filter((t) => { const ms = Date.parse(t.added_at); return ms >= day.startMs && ms < day.endMs; });
    // The same line twice (the same release added more than once) is one line with a count.
    const counts = new Map();
    for (const l of torrents.map((t) => torrentLine(db, t)).sort((a, b) => a.sort.localeCompare(b.sort))) counts.set(l.text, (counts.get(l.text) || 0) + 1);
    entry.rd = [...counts].map(([text, n]) => (n > 1 ? `${text} (×${n})` : text));
    // Plex: shows (episode counts) and movies first seen that day.
    const plex = db.prepare(`SELECT kind, show_title, title, year, COUNT(*) n FROM items WHERE source = 'plex' AND added_at >= ? AND added_at < ? AND present = 1
      GROUP BY kind, COALESCE(show_title, title) ORDER BY show_title, title`).all(day.startMs, day.endMs);
    entry.plex = plex.map((r) => (r.kind === "episode" ? `${r.show_title}: ${plural(r.n, "episode")}` : `${r.title}${r.year ? ` (${r.year})` : ""}`));
    // Local: the drive's library files, and spots (commercials, clips, eyecatches, shorts) by kind.
    const local = db.prepare(`SELECT kind, show_title, title, COUNT(*) n FROM items WHERE source = 'local' AND added_at >= ? AND added_at < ? AND present = 1
      GROUP BY kind, CASE WHEN kind IN ('episode', 'movie') THEN COALESCE(show_title, title) ELSE '' END`).all(day.startMs, day.endMs);
    entry.local = local.map((r) => (r.kind === "episode" ? `${r.show_title}: ${plural(r.n, "episode")}` : r.kind === "movie" ? r.title : `${plural(r.n, r.kind)}`));
    out.push(entry);
  }
  return out;
}

export function formatChangelog(days = 1, now = Date.now()) {
  const lines = [];
  for (const d of changelog(days, now)) {
    const total = d.rd.length + d.plex.length + d.local.length;
    lines.push(`**${d.label}**${total ? "" : " — nothing new"}`);
    if (d.rd.length) lines.push(`Real-Debrid (${plural(d.rd.length, "torrent")}):`, ...d.rd.map((x) => `• ${x}`));
    if (d.plex.length) lines.push(`Plex (${d.plex.length}):`, ...d.plex.map((x) => `• ${x}`));
    if (d.local.length) lines.push("Local drive and folders:", ...d.local.map((x) => `• ${x}`));
    lines.push("");
  }
  return lines.join("\n").trim();
}

// data\changelog.md: the last 30 days, rewritten after every sync.
export function writeChangelogFile() {
  const md = `# What was added to the server\n\n(Real-Debrid entries are dated by Real-Debrid; Plex and local ones by when the catalog first saw them.)\n\n${formatChangelog(30).replace(/\*\*/g, "##").replace(/^##(.*)##/gm, "## $1")}\n`;
  writeFileSync(join(DATA_DIR, "changelog.md"), md);
}
