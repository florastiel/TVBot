// Decide which audio track to play and how subtitles will be shown, from a list of
// streams normalized to: {index, type: audio|subtitle, lang, codec, title, default,
// forced, external, id}. `index` is the absolute ffmpeg stream index (0:N).
import { config } from "../config.js";

const IMAGE_SUBS = new Set(["pgs", "hdmv_pgs_subtitle", "vobsub", "dvd_subtitle", "dvdsub"]);
const TEXT_SUBS = new Set(["srt", "subrip", "ass", "ssa", "webvtt", "vtt", "mov_text", "text"]);
const UNKNOWN = new Set([undefined, null, "", "und", "unk", "?"]);

const isCommentary = (s) => /commentary/i.test(s.title || "");

export function chooseTracks(streams, { showTitle } = {}) {
  const want = config.language.audio;
  const subLang = config.language.subtitles;
  const audios = streams.filter((s) => s.type === "audio");
  if (!audios.length) return { playable: false, reason: "no audio track" };

  const pick =
    audios.find((s) => s.lang === want && !isCommentary(s)) ||
    audios.find((s) => s.lang === want) ||
    audios.find((s) => s.default && !isCommentary(s)) ||
    audios[0];
  const result = { audioStream: pick.index, audioLang: pick.lang || null, subs: { mode: "none" } };

  const understood = pick.lang === want || UNKNOWN.has(pick.lang); // untagged audio is almost always English
  const subs = chooseSubs(streams, subLang);

  // Audio we understand: always playable; subtitles on when there are any (the
  // "I can't hear without my subtitles" setting), unless turned off in config.
  if (understood) {
    return { ...result, playable: true, subs: config.language.always_subtitles && subs ? subs : { mode: "none" } };
  }

  // Foreign audio: needs subtitles in our language that we can show.
  // (Subtitles inside the file are shown when it was downloaded ahead; see player/spool.js.)
  if (subs) return { ...result, playable: true, subs };
  // No subtitle track at all. Could be burned into the picture; only trust that if
  // the show is listed in config as hardsubbed.
  if (showTitle && (config.language.hardsubbed_shows || []).includes(showTitle)) {
    return { ...result, playable: true, subs: { mode: "burned_in" } };
  }
  return { ...result, playable: false, reason: `${pick.lang} audio and no ${subLang} subtitles` };
}

// The best subtitle track in our language, or null. Full tracks before SDH before
// "forced" (foreign-lines-only); separate files and picture tracks (which we can show
// right away) before text tracks inside the file.
function chooseSubs(streams, subLang) {
  const isSdh = (s) => /sdh|\bcc\b|hearing/i.test(s.title || "");
  const rank = (s) => (s.forced ? 2 : isSdh(s) ? 1 : 0);
  const subs = streams
    .filter((s) => s.type === "subtitle" && (s.lang === subLang || (s.external && UNKNOWN.has(s.lang))))
    .sort((a, b) => rank(a) - rank(b));
  const labeled = subs.filter((s) => s.lang === subLang);
  const unlabeled = subs.filter((s) => s.lang !== subLang);
  const find = (list, ext, codecs) => list.find((s) => s.external === ext && codecs.has(s.codec));
  const sidecar = find(labeled, true, TEXT_SUBS);
  const image = find(labeled, false, IMAGE_SUBS);
  const embeddedText = find(labeled, false, TEXT_SUBS);
  // An unlabeled sidecar is only a last resort: it's often another language.
  const unlabeledSidecar = find(unlabeled, true, TEXT_SUBS);
  // Position among the file's own subtitle tracks (ffmpeg's subtitles filter wants it).
  const inFile = streams.filter((s) => s.type === "subtitle" && !s.external).sort((a, b) => a.index - b.index);

  if (sidecar) return { mode: "sidecar", id: sidecar.id, codec: sidecar.codec };
  if (image) return { mode: "image", index: image.index, codec: image.codec };
  if (embeddedText) return { mode: "embedded_text", index: embeddedText.index, pos: inFile.indexOf(embeddedText), codec: embeddedText.codec };
  if (unlabeledSidecar) return { mode: "sidecar", id: unlabeledSidecar.id, codec: unlabeledSidecar.codec, unlabeled: true };
  return null;
}

// Plex Stream objects -> normalized streams.
export function fromPlexStreams(plexStreams = []) {
  return plexStreams
    .filter((s) => s.streamType === 2 || s.streamType === 3)
    .map((s) => ({
      index: s.index,
      type: s.streamType === 2 ? "audio" : "subtitle",
      lang: s.languageCode,
      codec: s.codec,
      title: s.title || s.displayTitle,
      default: !!s.default,
      forced: !!s.forced,
      external: !!s.key, // sidecar file next to the video
      id: s.id,
    }));
}

// ffprobe -show_streams JSON -> normalized streams.
export function fromFfprobeStreams(ffStreams = []) {
  return ffStreams
    .filter((s) => s.codec_type === "audio" || s.codec_type === "subtitle")
    .map((s) => ({
      index: s.index,
      type: s.codec_type,
      lang: s.tags?.language,
      codec: s.codec_name,
      title: s.tags?.title,
      default: !!s.disposition?.default,
      forced: !!s.disposition?.forced,
      external: false,
    }));
}

// PQ (HDR10, HDR10+) or HLG: the encode pipeline (player/encode.js) has to tone-map these
// down to SDR itself, or they come out washed out - Discord's stream has no HDR metadata
// path, so a viewer's player renders the raw values as if they were SDR gamma.
const HDR_TRANSFER = /^(smpte2084|arib-std-b67)$/;
export function hdrFromFfprobeStreams(ffStreams = []) {
  const v = ffStreams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  return v ? (HDR_TRANSFER.test(v.color_transfer || "") ? 1 : 0) : null;
}
export function hdrFromPlexStreams(plexStreams = []) {
  const v = (plexStreams || []).find((s) => s.streamType === 1);
  return v ? (HDR_TRANSFER.test(v.colorTrc || "") ? 1 : 0) : null;
}
