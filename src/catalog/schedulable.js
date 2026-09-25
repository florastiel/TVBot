import { config } from "../config.js";

// SQL condition for "the scheduler may use this item". One definition, used everywhere.
export function schedulableSql(alias = "items") {
  const levels = ["'full'"];
  if (config.plex.include_show_only_matches) levels.push("'show'");
  if (config.plex.include_unmatched) levels.push("'none'");
  const never = (config.shows?.never || []).map((t) => `'${String(t).replaceAll("'", "''")}'`);
  const notNever = never.length ? ` AND (${alias}.show_title IS NULL OR ${alias}.show_title NOT IN (${never.join(",")}))` : "";
  return `(${alias}.present = 1 AND ${alias}.playable = 1 AND NOT ${alias}.excluded AND ${alias}.match IN (${levels.join(",")})${notNever})`;
}
