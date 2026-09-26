// What a video file is, from its release name ("Show.S01E02.Title.1080p.WEB-DL",
// "[Group] Show - 05", "Movie.Title.1994.1080p"): for Real-Debrid torrents and loose
// local libraries, where there's no metadata server or folder layout to go by.
import { extname } from "node:path";

const EXTRAS = /\b(sample|trailers?|featurettes?|extras|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|bonus)\b/i;
// Where the useful part of a release name ends: "Show.S01E02.The.Title.1080p.WEB-DL.x264".
const JUNK = /[ ._\[(-](?:2160p|1080p|720p|576p|480p|4k|uhd|web[ ._-]?(?:dl|rip)?|bluray|blu-ray|b[dr]rip|hdtv|dvdrip|remux|x26[45]|h[ ._]?26[45]|hevc|avc|aac|ac3|e?ac-?3|dts|ddp?[ ._]?[257][ ._]?[01]|10bit|hdr|proper|repack|internal|amzn|nf|dsnp|hmax|hulu|atvp|multi|dual[ ._-]audio|dubbed|subbed|complete)(?=$|[ ._\])-])/i;

export const tidy = (s) => s.replace(/[._]+/g, " ").replace(/\s+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim();
const cut = (s) => { const m = s.match(JUNK); return m ? s.slice(0, m.index) : s; };

// "The.Office.US" -> "The Office (US)", "Doctor.Who.2005" -> "Doctor Who (2005)" (how Plex names them).
export function showName(raw) {
  let s = tidy(cut(raw)).replace(/\[[^\]]*\]/g, "").trim();
  s = s.replace(/[ (]+((?:19|20)\d{2})\)?$/, " ($1)").replace(/ (US|UK|AU|NZ|CA)$/, " ($1)");
  return tidy(s) || null;
}

// What a video file is, from its name (and its folder / the torrent's name when the file
// name alone doesn't say). path uses "/" between folders. null for extras and samples.
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
