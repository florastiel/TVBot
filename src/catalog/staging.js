// Commercials from the drop thread (and `tv.cmd add commercial`) wait in
// local.commercials_staging, outside the scanned folders, until they're filed under a brand:
// `tv.cmd file` guesses the brand from the file name (brands.js) and moves them into
// <commercials>\youtube\<Brand>; `tv.cmd file "Brand" <text in the name>|all` does the rest by hand.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { config } from "../config.js";
import { log } from "../log.js";
import { brandOf } from "./brands.js";
import { syncLocal } from "./index.js";

const VIDEO = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".mpg", ".mpeg", ".ts", ".webm", ".flv"]);

export const stagingDir = () => String(config.local.commercials_staging || "").trim();

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (VIDEO.has(extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

// The video id in a YouTube download's name: "Ad [oxopPDMq7rs].mp4".
const idOf = (name) => name.match(/\[([A-Za-z0-9_-]{11})\]\.[^.]+$/)?.[1] ?? null;
export const stagedHas = (id) => !!id && walk(stagingDir()).some((p) => idOf(basename(p)) === id);

function moveFile(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    copyFileSync(from, to); // a different drive
    rmSync(from);
  }
}

// Files waiting in staging: [{ path, name, brand }] (brand null = couldn't place).
export function listStaged() {
  return walk(stagingDir()).map((path) => ({ path, name: basename(path), brand: brandOf(basename(path)) }));
}

const norm = (s) => s.toLowerCase().replace(/[._\s]+/g, " ");

// Move staged files into brand folders. With `brand`, the files whose names contain `match`
// ("all" = every staged file) go there; otherwise each goes where brandOf() puts it and the
// rest stay. dry: only say what would happen.
export async function fileStaged({ brand = null, match = null, dry = false } = {}) {
  const root = config.local.commercials;
  if (!stagingDir()) throw new Error("no commercials_staging folder set in config.yaml");
  if (!root) throw new Error("no commercials folder set in config.yaml");
  const base = join(root, "youtube");
  const existing = new Map(existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => [d.name.toLowerCase(), d.name]) : []);

  const moved = [], dupes = [], left = [], clashes = [];
  for (const f of listStaged()) {
    if (brand && match && match !== "all" && !norm(f.name).includes(norm(match))) { left.push(f); continue; }
    const b = brand || f.brand;
    if (!b) { left.push(f); continue; }
    const dirName = existing.get(b.toLowerCase()) ?? b.replace(/[<>:"/\\|?*]+/g, "").trim();
    const to = join(base, dirName, f.name);
    if (existsSync(to)) {
      // Same name = same video id. Same size: it's the same file, so the staged copy goes.
      if (statSync(to).size === statSync(f.path).size) { dupes.push({ ...f, brand: dirName }); if (!dry) rmSync(f.path); }
      else { clashes.push({ ...f, brand: dirName }); }
      continue;
    }
    moved.push({ ...f, brand: dirName });
    if (dry) continue;
    mkdirSync(join(base, dirName), { recursive: true });
    existing.set(dirName.toLowerCase(), dirName);
    moveFile(f.path, to);
  }
  if (!dry) {
    // Tidy emptied playlist subfolders.
    for (const e of readdirSync(stagingDir(), { withFileTypes: true })) {
      if (e.isDirectory() && !readdirSync(join(stagingDir(), e.name)).length) rmdirSync(join(stagingDir(), e.name));
    }
    if (moved.length) {
      log.info(`staging: filed ${moved.length} commercial(s) under brand folders`);
      await syncLocal(); // adds blank rows to tags.csv for the new files
      const { prefillTags } = await import("./download.js");
      if (prefillTags(root)) await syncLocal();
    }
  }
  return { moved, dupes, left, clashes };
}
