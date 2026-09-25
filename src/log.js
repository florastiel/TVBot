// Minimal timestamped logger. Tokens must never reach it; redact() is a backstop.
const redact = (s) => String(s).replace(/X-Plex-Token=[A-Za-z0-9_-]+/g, "X-Plex-Token=***");
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const out = (level, args) => {
  const line = `${stamp()} ${level} ${args.map((a) => redact(a instanceof Error ? a.stack : typeof a === "object" ? JSON.stringify(a) : a)).join(" ")}`;
  (level === "ERROR" || level === "WARN " ? console.error : console.log)(line);
};
export const log = {
  info: (...a) => out("INFO ", a),
  warn: (...a) => out("WARN ", a),
  error: (...a) => out("ERROR", a),
};
