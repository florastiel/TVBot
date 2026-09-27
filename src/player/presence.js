// Rich presence on the streamer account: what's on, shown in its profile and the
// member list ("Watching The Good Doctor / S3E3 "Claire" / Up next: ... / progress bar").
// Text comes from real metadata only. Tied to the TV bot's application id (saved by
// the bot at startup) so Discord shows the extra lines.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";

const WATCHING = 3;

export class RichPresence {
  constructor(client) {
    this.client = client;
  }

  appId() {
    const f = join(DATA_DIR, "app-id.txt");
    return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
  }

  set(activity) {
    try {
      this.client.user.setPresence({ activities: activity ? [{ type: WATCHING, name: "TV", application_id: this.appId(), ...activity }] : [] });
    } catch (e) {
      log.warn(`presence: ${e.message}`);
    }
  }

  // A show or movie: its title is the big "Watching ..." header (instead of "TV"), then the
  // episode line, then what's next; timestamps make Discord draw a progress bar for the
  // whole episode or movie (start = when it would have begun, so the bar is right after a
  // commercial break inside it, too).
  show(seg) {
    const into = seg.seekMs || 0;
    const start = Date.now() - into;
    const total = seg.fullDurationMs || seg.durationMs;
    const next = seg.upNext?.title;
    this.set({
      name: seg.title.slice(0, 128),
      details: (seg.subtitle || (seg.kind === "movie" ? "Movie" : " ")).slice(0, 128),
      state: next ? `Up next: ${next}`.slice(0, 128) : " ",
      timestamps: { start, end: start + total },
    });
  }

  // Counts down to the next show.
  commercials({ endsAt, nextTitle } = {}) {
    this.set({
      details: "Commercial break",
      state: nextTitle ? `Up next: ${nextTitle}`.slice(0, 128) : " ",
      ...(endsAt > Date.now() ? { timestamps: { end: Math.round(endsAt) } } : {}),
    });
  }

  paused() {
    this.set({ details: "Paused", state: " " });
  }

  clear() {
    this.set(null);
  }
}
