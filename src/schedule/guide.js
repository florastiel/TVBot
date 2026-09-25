// TV Guide text for /schedule: fixed template + real titles, Discord timestamps so
// everyone sees their own time zone, under Discord's 2000-character limit.
import { blocksBetween } from "./store.js";
import { localDay } from "./time.js";

function titles(items) {
  // Consecutive episodes of one show collapse: "South Park (S1E1, S1E2)".
  const out = [];
  for (const r of items) {
    const last = out.at(-1);
    if (r.kind === "movie") out.push({ text: `${r.title}${r.year ? ` (${r.year})` : ""}` });
    else if (last?.show === r.show_title) last.eps.push(`S${r.season ?? "?"}E${r.episode ?? "?"}`);
    else out.push({ show: r.show_title, eps: [`S${r.season ?? "?"}E${r.episode ?? "?"}`] });
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
