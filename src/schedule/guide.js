// TV Guide text for /schedule: fixed template + real titles, Discord timestamps so
// everyone sees their own time zone, under Discord's 2000-character limit.
import { blocksBetween } from "./store.js";
import { localDay } from "./time.js";
import { slotsBetween } from "./weekplan.js";

function titles(items) {
  // Consecutive episodes of one show collapse: "South Park (S1E1, S1E2)".
  const out = [];
  for (const r of items) {
    const last = out.at(-1);
    if (r.kind === "movie") out.push({ text: `${r.title}${r.year ? ` (${r.year})` : ""}` });
    else if (r.season == null || r.episode == null) out.push({ text: r.show_title && r.show_title !== r.title ? `${r.show_title}: ${r.title}` : r.title });
    else if (last?.show === r.show_title) last.eps.push(`S${r.season}E${r.episode}`);
    else out.push({ show: r.show_title, eps: [`S${r.season}E${r.episode}`] });
  }
  return out.map((t) => t.text ?? `${t.show} (${t.eps.join(", ")})`).join(", ");
}

export function guideText(now = Date.now(), minBlocks = 6) {
  const endOfToday = localDay(now).endMs;
  const blocks = blocksBetween(now, now + 2 * 86400000);
  const lines = [];
  let len = 0;
  for (const [i, b] of blocks.entries()) {
    if (i >= minBlocks && b.start_at >= endOfToday) break;
    const line = `<t:${Math.floor(b.start_at / 1000)}:t> **${b.label}**: ${titles(b.items)}`;
    if (len + line.length + 1 > 1850) break;
    lines.push(line);
    len += line.length + 1;
  }
  if (!lines.length) return "Nothing is scheduled yet.";
  return `**TV Guide**\n${lines.join("\n")}`;
}

// The week, a day at a time: [{ title: "Saturday, Sep 26", lines: [...] }]. Blocks
// already filled show their shows; after that, the grid's block kinds (shows get picked
// about a day ahead). Discord timestamps, so everyone sees their own time zone.
const clip = (t, n) => (t.length > n ? `…` : t);

export function weekGrid(now = Date.now(), days = 7) {
  const today = localDay(now);
  const end = today.startMs + days * 86400000;
  const blocks = blocksBetween(now, end);
  const filledUntil = blocks.reduce((t, b) => (b.start_at <= t + 60000 ? Math.max(t, b.end_at) : t), now);
  const rows = blocks.filter((b) => b.start_at < filledUntil)
    .map((b) => ({ at: b.start_at, text: `**${b.label}**: ${clip(titles(b.items), 60)}` }));
  const slots = slotsBetween(today.startMs, end);
  const current = slots.filter((s) => s.at <= filledUntil).at(-1);
  if (current && current.at < filledUntil && slots.some((s) => s.at > filledUntil)) rows.push({ at: filledUntil, text: current.name });
  for (const s of slots) if (s.at >= filledUntil) rows.push({ at: s.at, text: s.name });
  const out = [];
  for (const r of rows) {
    const day = localDay(r.at);
    const title = new Date(r.at).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" });
    if (out.at(-1)?.date !== day.date) out.push({ date: day.date, title, lines: [] });
    out.at(-1).lines.push(`<t:${Math.floor(r.at / 1000)}:t>  ${r.text}`);
  }
  return out;
}
