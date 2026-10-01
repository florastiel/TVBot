#!/usr/bin/env python3
"""Rename loose video files into the layout Plex matches on. Renames only: nothing is ever deleted
or overwritten, a plan is printed first, and --apply writes an undo file.

  Plan (changes nothing):
    python3 resort.py "/mnt/NasDrive2/Media/Unsorted"

  Do it:
    python3 resort.py "/mnt/NasDrive2/Media/Unsorted" --apply \
        --tv-root "/mnt/NasDrive2/Media/TV Shows" --movie-root "/mnt/NasDrive2/Media/Movies"

  One show in one folder whose files only say "EP05 - Title":
    python3 resort.py "/path/to/x-men-folder" --show "X-Men The Animated Series (1992)"

  Put it back:
    python3 resort.py --undo resort-undo-20261001-1200.tsv

Results:   TV      <tv-root>/Show/Season 01/Show - S01E05.mkv
           Movie   <movie-root>/Title (Year)/Title (Year).mkv
Subtitle files next to a video (same name + .en.srt etc.) move with it.
Don't point it at folders Sonarr/Radarr manage: they find files by path.
Files it can't identify with confidence are listed under NEEDS A HUMAN and left alone.
"""
import argparse, os, re, sys, time

VIDEO = {".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".mpg", ".mpeg", ".ts", ".webm"}
SUBS = {".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt"}
A = r"(?<![a-z0-9])"
Z = r"(?![a-z0-9])"
EXTRAS = re.compile(A + r"(?:samples?|trailers?|featurettes?|extras|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|bonus|nc(?:op|ed)\d*|creditless|tokuten|animation[ ._-]material)" + Z, re.I)
JUNK = re.compile(r"[ ._\[(-](?:2160p|1080p|720p|576p|480p|4k|uhd|web[ ._-]?(?:dl|rip)?|bluray|blu-ray|b[dr]rip|hdtv|dvdrip|remux|x26[45]|h[ ._]?26[45]|hevc|avc|aac|ac3|e?ac-?3|dts|ddp?[ ._]?[257][ ._]?[01]|10bit|hdr|proper|repack|internal|amzn|nf|dsnp|hmax|hulu|atvp|multi|dual[ ._-]audio|dubbed|subbed|complete)(?=$|[ ._\])-])", re.I)
BAD_CHARS = re.compile(r'[<>:"/\\|?*]')


def tidy(s):
    return re.sub(r"\s+", " ", re.sub(r"[._]+", " ", s)).strip(" -")


def cut(s):
    m = JUNK.search(s)
    return s[: m.start()] if m else s


def show_name(raw):
    s = re.sub(r"\[[^\]]*\]", "", tidy(cut(raw))).strip()
    s = re.sub(r"[ (]+((?:19|20)\d{2})\)?$", r" (\1)", s)
    s = re.sub(r" (US|UK|AU|NZ|CA)$", r" (\1)", s)
    return tidy(s) or None


def safe(s):
    return re.sub(r"\s+", " ", BAD_CHARS.sub("", s)).strip(" .")


def folder_show(rel_parts):
    """The show a file belongs to, from the nearest folder that isn't just 'Season N'."""
    for p in reversed(rel_parts[:-1]):
        if re.fullmatch(r"(?:season|series|s)[ ._]*\d{1,2}|specials?", p, re.I):
            continue
        m = re.match(r"^(.*?)[ ._-]*(?:S\d{1,2}\b|Season[ ._]?\d)", p, re.I)
        n = show_name(m.group(1)) if m and m.group(1).strip() else show_name(p)
        if n:
            return n
    return None


def folder_season(rel_parts):
    for p in reversed(rel_parts[:-1]):
        m = re.search(r"(?:season|series)[ ._]*(\d{1,2})\b", p, re.I)
        if m:
            return int(m.group(1))
    return None


def identify(rel, show_override=None):
    """-> ('episode', show, season, episode, title) | ('movie', title, year) | ('skip', why)"""
    parts = rel.split("/")
    name = os.path.splitext(parts[-1])[0]
    if EXTRAS.search(rel):
        return ("skip", "extra / sample / creditless")
    fshow = show_override or folder_show(parts)
    fseason = folder_season(parts)

    m = re.search(r"[Ss](\d{1,2})[ ._-]*[Ee](\d{1,3})|\b(\d{1,2})x(\d{2,3})\b", name)
    if m:
        ep = int(m.group(2) or m.group(4))
        show = show_override or show_name(name[: m.start()]) or fshow
        title = tidy(cut(name[m.end():]))
        title = re.sub(r"^(?:[Ee]\d{1,3}[\s._-]*)*", "", title).strip(" -")
        return ("episode", show, int(m.group(1) or m.group(3)), ep, title) if show else ("skip", "no show name")
    m = re.search(r"\bSeason[ ._]*(\d{1,2})[ ._]*Episode[ ._]*(\d{1,3})\b", name, re.I)
    if m:
        show = show_override or show_name(name[: m.start()]) or fshow
        return ("episode", show, int(m.group(1)), int(m.group(2)), "") if show else ("skip", "no show name")
    m = re.match(r"^(?:\[[^\]]*\][ _]*)?(.+?)[ _]+-[ _]+E?(\d{1,4})(?:v\d)?(?:[ _]|$)", name)
    if m and not (1900 <= int(m.group(2)) <= 2099):
        show = show_override or show_name(m.group(1))
        return ("episode", show, fseason or 1, int(m.group(2)), "") if show else ("skip", "no show name")
    m = re.match(r"^(?:ep?|episode)[ ._]*(\d{1,3})(?:v\d)?(?:[ ._-]+(.*))?$", name, re.I)
    if m:
        if not fshow:
            return ("skip", "episode number only, no show name (use --show)")
        return ("episode", fshow, fseason or 1, int(m.group(1)), tidy(m.group(2) or ""))
    years = [y for y in re.finditer(r"[ ._(\[]((?:19|20)\d{2})(?=[)\]]|[ ._]|$)", name) if tidy(name[: y.start()])]
    if years:
        y = years[-1]
        tail = name[y.end(1):]
        if re.match(r"^[)\]\s._-]*(?:e|ep|episode)?\s*\d{1,3}(?:v\d)?(?=[\s._\[(]|$)", tail, re.I):
            return ("skip", "year followed by an episode number")
        title = re.sub(r"^(?:\[[^\]]*\]\s*)+", "", tidy(name[: y.start()])).strip()
        return ("movie", title, int(y.group(1))) if title else ("skip", "no title")
    return ("skip", "can't tell what it is")


def key(s):
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\(\s*(?:19|20)\d{2}\s*\)\s*$", "", s.lower()))


def full_key(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def existing_names(path, keyfn):
    """Folder names already under a library root, so 'D Gray-man' joins 'D.Gray-man'."""
    try:
        return {keyfn(n): n for n in os.listdir(path) if os.path.isdir(os.path.join(path, n))}
    except (TypeError, OSError):
        return {}


def plan_for(root, args):
    rows = []
    tv_have, movie_have = existing_names(args.tv_root, key), existing_names(args.movie_root, full_key)
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for f in sorted(files):
            ext = os.path.splitext(f)[1].lower()
            if ext not in VIDEO:
                continue
            src = os.path.join(dirpath, f)
            rel = os.path.relpath(src, root).replace(os.sep, "/")
            r = identify(rel, args.show)
            if r[0] == "skip":
                rows.append((src, None, r[1]))
                continue
            if r[0] == "episode":
                _, show, season, ep, title = r
                sname = tv_have.get(key(safe(show)), safe(show))
                stem = f"{sname} - S{season:02d}E{ep:02d}" + (f" - {safe(title)}" if title and not re.fullmatch(r"Episode \d+", title) else "")
                dest = os.path.join(args.tv_root or "TV Shows", sname, f"Season {season:02d}", stem + ext)
            else:
                _, title, year = r
                stem = f"{safe(title)} ({year})"
                folder = movie_have.get(full_key(stem), stem)
                dest = os.path.join(args.movie_root or "Movies", folder, stem + ext)
            rows.append((src, dest, ""))
    return rows


def sidecars(src):
    d, f = os.path.split(src)
    stem = os.path.splitext(f)[0]
    out = []
    for g in os.listdir(d):
        if g != f and g.startswith(stem) and os.path.splitext(g)[1].lower() in SUBS:
            out.append((os.path.join(d, g), g[len(stem):]))
    return out


def main():
    ap = argparse.ArgumentParser(description="Rename loose videos into Plex's layout (renames only).")
    ap.add_argument("dir", nargs="?", help="folder to sort")
    ap.add_argument("--apply", action="store_true", help="do it (default: just print the plan)")
    ap.add_argument("--tv-root", help="where TV shows go, e.g. '/mnt/NasDrive2/Media/TV Shows'")
    ap.add_argument("--movie-root", help="where movies go, e.g. '/mnt/NasDrive2/Media/Movies'")
    ap.add_argument("--show", help="the show name for a folder that is all one show")
    ap.add_argument("--undo", metavar="FILE", help="reverse an earlier --apply using its undo file")
    args = ap.parse_args()

    if args.undo:
        n = 0
        for line in reversed(open(args.undo, encoding="utf-8").read().splitlines()):
            dest, src = line.split("\t")
            if os.path.exists(dest) and not os.path.exists(src):
                os.makedirs(os.path.dirname(src), exist_ok=True)
                os.rename(dest, src)
                n += 1
            else:
                print("skipped (already moved back, or the old spot is taken):", dest)
        print(f"put back {n} files")
        return
    if not args.dir or not os.path.isdir(args.dir):
        ap.error("give a folder to sort")
    if args.apply and not (args.tv_root and args.movie_root):
        ap.error("--apply needs --tv-root and --movie-root (where to put things)")

    root = os.path.abspath(args.dir)
    rows = plan_for(root, args)
    todo, human, seen = [], [], {}
    for src, dest, why in rows:
        if dest is None:
            human.append((src, why))
        elif os.path.abspath(src) == os.path.abspath(dest):
            continue
        elif dest in seen:
            human.append((src, f"same result as {os.path.basename(seen[dest])} (a duplicate copy?)"))
        elif os.path.exists(dest):
            human.append((src, "something is already at the new name"))
        else:
            seen[dest] = src
            todo.append((src, dest))

    for src, dest in todo:
        print(f"{os.path.relpath(src, root)}\n    -> {dest}")
    print(f"\n{len(todo)} files would be renamed; {len(human)} need a human.")
    if human:
        print("\nNEEDS A HUMAN (left alone):")
        for src, why in human:
            print(f"  {os.path.relpath(src, root)}   [{why}]")
    if not args.apply:
        print("\nNothing changed. Add --apply (with --tv-root and --movie-root) to do it.")
        return

    undo_path = os.path.join(os.getcwd(), time.strftime("resort-undo-%Y%m%d-%H%M%S.tsv"))
    moved = 0
    with open(undo_path, "a", encoding="utf-8") as undo:
        for src, dest in todo:
            try:
                moves = [(src, dest)]
                for sc, suffix in sidecars(src):
                    moves.append((sc, os.path.splitext(dest)[0] + suffix))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                for a, b in moves:
                    if os.path.exists(b):
                        continue
                    os.rename(a, b)
                    undo.write(f"{b}\t{a}\n")
                    undo.flush()
                moved += 1
            except OSError as e:
                print(f"couldn't move {src}: {e} (a different drive? use mv for that one)")
    print(f"\nrenamed {moved} videos. To put everything back: python3 resort.py --undo {undo_path}")


if __name__ == "__main__":
    main()
