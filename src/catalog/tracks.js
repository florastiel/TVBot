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

  // Audio we understand, or untagged (most untagged files are English): no subtitles needed.
  if (pick.lang === want || UNKNOWN.has(pick.lang)) return { ...result, playable: true };

  // Foreign audio: need subtitles in our language. Full (non-forced) tracks first.
  const subs = streams
    .filter((s) => s.type === "subtitle" && (s.lang === subLang || (s.external && UNKNOWN.has(s.lang))))
    .sort((a, b) => a.forced - b.forced || (a.lang === subLang ? -1 : 1));
  const labeled = subs.filter((s) => s.lang === subLang);
  const unlabeled = subs.filter((s) => s.lang !== subLang);
  const find = (list, ext, codecs) => list.find((s) => s.external === ext && codecs.has(s.codec));
  // Sidecar files are tiny downloads and image tracks overlay live, so both are ready
  // now. An unlabeled sidecar is only a last resort: it's often another language.
  const sidecar = find(labeled, true, TEXT_SUBS);
  const image = find(labeled, false, IMAGE_SUBS);
  const embeddedText = find(labeled, false, TEXT_SUBS);
  const unlabeledSidecar = find(unlabeled, true, TEXT_SUBS);

  if (sidecar) return { ...result, playable: true, subs: { mode: "sidecar", id: sidecar.id, codec: sidecar.codec } };
  if (image) return { ...result, playable: true, subs: { mode: "image", index: image.index, codec: image.codec } };
  if (embeddedText) {
    return {
      ...result,
      playable: false,
      reason: "subtitles are an embedded text track (not supported yet)",
      subs: { mode: "embedded_text", index: embeddedText.index, codec: embeddedText.codec },
    };
  }
  if (unlabeledSidecar) {
    return { ...result, playable: true, subs: { mode: "sidecar", id: unlabeledSidecar.id, codec: unlabeledSidecar.codec, unlabeled: true } };
  }
  // No subtitle track at all. Could be burned into the picture; only trust that if
  // the show is listed in config as hardsubbed.
  if (showTitle && (config.language.hardsubbed_shows || []).includes(showTitle)) {
    return { ...result, playable: true, subs: { mode: "burned_in" } };
  }
  return { ...result, playable: false, reason: `${pick.lang} audio and no ${subLang} subtitles` };
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
