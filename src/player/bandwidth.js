// A mod-triggered pause on pulling anything from the Plex server (its owner's bandwidth,
// not ours): a timestamp in the shared DB so both the bot (sets it) and the player (reads
// it) see the same value. 0 minutes / a past timestamp means not paused.
import { getMeta, setMeta } from "../db.js";

export function plexPausedUntil() {
  return Date.parse(getMeta("plex_paused_until") || 0) || 0;
}

export function isPlexPaused() {
  return Date.now() < plexPausedUntil();
}

// minutes <= 0 cancels an active pause right away.
export function pausePlex(minutes) {
  const until = minutes > 0 ? Date.now() + minutes * 60000 : 0;
  setMeta("plex_paused_until", until ? new Date(until).toISOString() : "");
  return until;
}
