// Who reads the weather. No more RVC voice conversion (the character-voice models):
// each place just gets a different real TTS voice/service, picked at random by weight.
// config.weather.voices: [{ name, voice, weight, pool? }]. voice is "edge:<name>" (Microsoft/
// Azure neural, via edge-tts), "google:<lang>" (Google Translate TTS, any language code), or
// the special values "edge:random" / "google:random", which pick a random entry from `pool`
// (edge) or from RANDOM_LANGS (google) each time that tier is chosen.
import { config } from "../config.js";

// A grab-bag of Google Translate TTS language codes, excluding whatever's already its own
// named tier (English, Filipino/"Tita", Bengali) so "a mystery voice" doesn't just repeat them.
const RANDOM_LANGS = [
  "ja", "ko", "zh-CN", "ar", "ru", "de", "fr", "es", "it", "pt", "nl", "sv", "no", "da", "fi",
  "pl", "tr", "vi", "th", "id", "ms", "hi", "ta", "te", "uk", "cs", "ro", "el", "he", "sw",
];

const DEFAULT_VOICES = [
  { name: "Tita", voice: "google:fil", weight: 50 },
  { name: "the Bengali voice", voice: "google:bn", weight: 15 },
  { name: "the English voice", voice: "google:en", weight: 12 },
  { name: "a Microsoft voice", voice: "edge:random", weight: 15, pool: ["en-US-SteffanNeural", "en-US-GuyNeural", "en-US-DavisNeural", "en-US-TonyNeural", "en-US-JasonNeural"] },
  { name: "a mystery voice", voice: "google:random", weight: 8 },
];

// Friendly names for the Microsoft pool, for captions/logs ("with Steve" reads better than
// "with en-US-SteffanNeural"). Falls back to the raw id for anything not listed here.
const MS_NICKNAMES = { SteffanNeural: "Steve", GuyNeural: "Guy", DavisNeural: "Davis", TonyNeural: "Tony", JasonNeural: "Jason" };
const msNickname = (edgeVoice) => MS_NICKNAMES[edgeVoice.replace(/^[a-z]{2}-[A-Z]{2}-/, "")] || edgeVoice;

function resolve(spec) {
  if (spec.voice === "edge:random") {
    const pick = spec.pool[Math.floor(Math.random() * spec.pool.length)];
    return { name: msNickname(pick), speak: `edge:${pick}` };
  }
  if (spec.voice === "google:random") {
    const lang = RANDOM_LANGS[Math.floor(Math.random() * RANDOM_LANGS.length)];
    return { name: spec.name, speak: `google:${lang}` };
  }
  return { name: spec.name, speak: spec.voice };
}

// One voice per place, weighted-random (reused if there are more places than picks needed -
// there's no shortage here, every tier can repeat freely, unlike the old RVC model pool).
export function choosePresenters(count) {
  const pool = (config.weather?.voices?.length ? config.weather.voices : DEFAULT_VOICES).filter((v) => v?.voice && v.weight > 0);
  if (!pool.length) return Array.from({ length: count }, () => null);
  const total = pool.reduce((t, v) => t + v.weight, 0);
  const pickOne = () => {
    let r = Math.random() * total;
    for (const v of pool) { r -= v.weight; if (r <= 0) return resolve(v); }
    return resolve(pool.at(-1));
  };
  return Array.from({ length: count }, pickOne);
}
