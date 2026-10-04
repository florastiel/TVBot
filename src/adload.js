// How much ad time goes with long-form content (movies, hour-long shows): shared by the
// player (how long a mid-movie break runs) and the schedule (how long a block is planned).
import { config } from "./config.js";

export const LONG_MS = 40 * 60000; // an item this long or longer is cut into pieces and its breaks sized to the ad load

// The ad time that follows `contentMs` of long-form content at broadcast.ad_minutes_per_hour
// of airtime (14 ad minutes an hour = 14 ad minutes per 46 of show).
export function adAfter(contentMs) {
  const ph = Math.min(45, Math.max(0, Number(config.broadcast.ad_minutes_per_hour ?? 12)));
  return (contentMs * ph) / (60 - ph);
}

// How long the break after one piece of a long item should run: the ads that go with that
// piece, less its share of the break between shows that follows the whole item (about
// 45 s a spot), so the item as a whole lands on the target and not above it.
export function breakTargetMs(pieceMs, itemMs) {
  const pod = (Number(config.broadcast.between_spots) || 2) * 45000;
  return Math.max(30000, adAfter(pieceMs) - (pod * pieceMs) / itemMs);
}
