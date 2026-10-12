# tvchannel

A fake cable TV channel for the Discord server. A throwaway Discord account
(the "streamer" account) Go Live streams a schedule of shows, movies and commercials into a voice
channel, on the wall clock like real TV; a normal bot (TVbot, coupbot's old token) is
the remote control. Claude sorts the catalog into kinds of blocks and lays out a weekly
grid of them; code fills the grid with random picks.

**Status: running.** The player, the bot and the bucket editor are Windows services on
glados that start with the machine and restart if they crash (see *Running it*).

## How it fits together

```
  TVbot (bot)    --HTTP on 127.0.0.1-->  player (streamer)  -->  Go Live in voice
  /tv /tvoff /tvpause /schedule          ffmpeg per item -> one continuous stream
  /entrance /tvadmin                     entrance sounds over its mic
       |                                        |
       +---------- data\tv.db (SQLite) ---------+
                 catalog, tags, schedule
```

- **Player** (`tv.cmd player`): the throwaway account. Joins voice, streams, notices
  kicks and an empty channel, plays entrance sounds. Every show and commercial is encoded
  to the same 720p format and spliced into one unbroken stream, so viewers never get
  kicked out of the stream between items.
- **Bot** (`tv.cmd bot`): slash commands, the Skip button, now-playing posts. Also
  does the upkeep: weekly catalog sync + tagging new items, and keeps at least 2 days
  scheduled.
- **Editor** (`tv.cmd editor`): a small web page, published behind the login proxy, for
  fixing buckets by hand. It also hosts the **eyecatch clipper** at `/clip`, where you watch
  an eyecatch and press Space where one ends and the next begins (see *Eyecatches that are
  really several*). It reads and writes the same database.

## Why it runs natively (not Docker)

Docker Desktop on Windows runs containers inside WSL2, which can't reach the Intel
iGPU's Quick Sync encoder (only NVIDIA GPUs get passed through). So this runs
directly on glados with a portable Node + ffmpeg in `tools\`, nothing installed
system-wide. CPU encoding is plenty anyway: 1080p to 720p runs ~8x real time.

## Setup (one time)

Already done on glados: `tools\node` (Node 24 LTS), `tools\ffmpeg` (BtbN build),
`npm install`. If you ever rebuild from scratch:

1. Unzip the Node 24 Windows x64 zip (nodejs.org) to `tools\node`.
2. Unzip `ffmpeg-master-latest-win64-gpl.zip` (github.com/BtbN/FFmpeg-Builds) to `tools\ffmpeg`.
3. Download `yt-dlp.exe` (github.com/yt-dlp/yt-dlp/releases) into `tools\` (used by `tv.cmd add`).
4. `tools\node\npm install`, then `tools\node\npm install-scripts approve node-av zeromq`
   and `tools\node\npm rebuild node-av zeromq`.

Copy `.env.example` to `.env` and fill it in: `STREAMER_TOKEN` (the streamer account),
`BOT_TOKEN` (coupbot), `PLEX_TOKEN`, `ANTHROPIC_API_KEY`, `GUILD_ID`, and optionally
`RD_TOKEN` (real-debrid.com/apitoken). `.env` is
gitignored; never commit it.

**YouTube sign-in (for age-restricted videos in the drop threads)**: yt-dlp uses browser
cookies, not OAuth. In a private/incognito window, sign in to YouTube (an adult,
age-verified account; a spare one is safest), then open youtube.com/robots.txt in that
same window and export its cookies in Netscape format (e.g. the "Get cookies.txt
LOCALLY" extension, allowed in incognito). Save as `data\youtube-cookies.txt` and close
the window without signing out (signing out kills those cookies). Used automatically when
the file is there; if the drop threads start saying the saved sign-in didn't work,
export a fresh one.

**If the player log says "invalid token"**: the streamer account's token was reset (logging out
of that browser session does it). Log in to the streamer account in an incognito window, F12 →
Network → click a channel → copy the `authorization` header into `STREAMER_TOKEN`,
then close the window *without* logging out.

## Running it

Three NSSM services: `tvchannel-player` and `tvchannel-bot` (run as LocalSystem, start
with Windows, restart on a crash; `scripts\install-services.ps1` sets them up) and
`tvchannel-editor` (the bucket editor and eyecatch clipper, added by hand with nssm:
`editor 5174 --host 10.99.0.2 --require-user --no-open`, so only the login proxy can reach
it). Logs: `logs\player-YYYY-MM-DD.log` and `logs\bot-YYYY-MM-DD.log` (and the
`*-console.log` files, which hold whatever the process printed). For a test by hand, stop
the services and run `tv.cmd player` / `tv.cmd bot` in two terminals.

To load new code or settings: `tv.cmd restart`. The bot restarts right away; the
player restarts at the next commercial break (in place of the ads) and comes back to
the same channel by itself after about 20 seconds; viewers click Watch again (with the
TV off it restarts at once). If the player ever freezes,
the bot notices after 2 minutes and kills it, and the service starts a fresh one.
`tv.cmd restart` covers the bot and the player; the editor loads new code with
`Restart-Service tvchannel-editor` (an administrator PowerShell).

A file that won't start doesn't loop the channel: a show or movie is played in pieces, and
when the second piece of one dies on the spot the player drops the rest of that item for now
(it stays on the schedule; `/tvadmin skip` takes it off) and goes on with the next thing.

## Discord commands

| Command | Who | What |
|---|---|---|
| `/tv` | anyone in a voice channel | TV joins your voice channel and starts whatever is on now |
| `/tvoff` | anyone | TV leaves |
| `/tvpause`, Pause button | people in the TV's voice channel | emergency pause: the show cuts to a silent "Paused" card at once |
| `/tvresume`, Resume button | people in the TV's voice channel | picks up at the second it was paused; the channel then catches up by cutting ads |
| `/rewind [minutes]` | people in the TV's voice channel | go back 1-60 minutes (default 5) in the show that's on; the channel then catches up by cutting ads |
| `/tvlive` | people in the TV's voice channel | forget the delay, jump to what the schedule says is on now |
| `/tvhelp` | anyone | posts how to use the TV in the channel (for everyone; replaces the previous help post) |
| `/schedule` | anyone | refreshes today's TV guide post in the TV channel by editing it (no new copy, no notifications) and tells only you, with a link (a private reply you can dismiss); `week: True` shows you the week instead (only you see it) |
| `/entrance set` + file | anyone | your join sound (first 8 s, volume evened out) |
| `/entrance clear` | anyone (admin: anyone's) | remove a join sound |
| Skip commercials button (on the break message in the posting channel) | people in the TV's voice channel | ends the current break |
| `/tvadmin skip` | admin | skip this episode or movie (also off the schedule); the block goes on with its next one, and the day moves up (see *Skipping*) |
| `/tvadmin skipblock` | admin | skip the rest of this block; the next block starts right away |
| `/tvadmin sync` | admin | re-read the catalog now |
| `/tvadmin regen` | admin | throw away the upcoming schedule and program a new week (specials stay) |
| `/tvadmin add` + kind + links | admin | download commercials/clips from YouTube (etc.) straight into rotation |
| `/tvadmin special` + request | admin | plan a marathon or themed special, e.g. "Scream marathon Saturday 8pm" |

The bot keeps one TV message in the posting channel: "Now playing / Ends in 20 minutes /
Up next" with a Pause button while a show is on; during a break it becomes "Commercial
break / Up next / Back in 2 minutes" with Skip and Pause buttons. Just after midnight it
also posts the whole day's programming (`discord.daily_guide`; `discord.guide_channel_id` for another
channel). The streamer account's Discord status
(rich presence) shows the same: the show with a time-left bar, or a countdown to the next
show during ads.

## Command line

```
tv.cmd sync [--quick]                pull the catalog from Plex + local folders + Real-Debrid; --quick = only what's new
tv.cmd stats                         what's in the catalog, why things can't be scheduled
tv.cmd unschedulable [--all]         what the scheduler can't use and why (the full list is data\unschedulable.md)
tv.cmd changelog [days]              what was added, by day
tv.cmd tag                           tag anything untagged with Claude (batch, half price)
tv.cmd tag --dry                     estimate what tagging would cost, no API calls
tv.cmd tag --redo                    retag everything (--breaks, --order, --episodes redo just one kind of call)
tv.cmd tmdb [--redo]                 TMDB genres and keywords for shows and movies not looked up yet
tv.cmd shorts [--redo]               which anime are shorts (AniList)
tv.cmd buckets [--build|--new|--thin|--html]   list the buckets, or have Claude build or extend them
tv.cmd catalog --html                write catalog.html, a browsable page of the whole library
tv.cmd plan [days]                   print the grid (bucket slots) for the next days
tv.cmd schedule [days] [--replace|--replan]    program the schedule (default 7 days; keeps existing days)
tv.cmd special "Scream marathon Saturday 8pm"  plan a special (or no text: Claude picks one)
tv.cmd guide                         print today's guide
tv.cmd spots [commercial|clip|eyecatch] [--desc]   how often each spot has aired
tv.cmd add commercial|clip <links...>   download from YouTube etc. and sync
tv.cmd brands [eyecatch|clip]        show where each loose file would be filed (--apply files them, --deep asks the models now)
tv.cmd brands migrate [--apply]      move brand folders out of commercials\youtube (undo <list.json> puts them back)
tv.cmd eyecatches [--all] [--apply]  find eyecatches that are really several and cut them
tv.cmd commercials [--apply]         find long reels of several ads and cut them (--force --only=a,b skips Claude's check)
tv.cmd weather                       make a weather report now (doesn't air it)
tv.cmd editor [port]                 the bucket editor and eyecatch clipper
tv.cmd restart [bot|player]          load new code and settings
tv.cmd playlist "<show>" [count]     test override: loop a few episodes instead of the schedule
tv.cmd playlist --clear              back to the schedule
```

## Settings

Everything you'd want to change is in **`config.yaml`** (comments explain each line):
planned-time rounding (5 min), commercials per break, clip chance, longest commercial,
no-repeat window, idle timeout, which shows always/never play in order, encode
size/bitrate, Plex server + libraries, local folders, entrance sound length and volume,
encoder (qsv = Intel Quick Sync, falls back to CPU by itself), how often the Go Live
thumbnail updates (`player.stream_preview_minutes`, 5; 0 = none), Claude model, the volume
spots are brought to (`broadcast.ad_loudness_lufs`), how new drops are filed and cut
(`brand_sort:`), where Claude calls are logged (`claude.usage_log`), OpenSubtitles
(`opensubtitles:`) and the tallest video that is scheduled (`player.max_source_height`, 2160).
After changing settings: `tv.cmd restart`.

## The catalog

Lives in `data\tv.db`. Plex items come in three flavors:
- *fully identified*: title, summary, air date, all there.
- *show-only*: Plex knows the show but not the episode (King of the Hill "Episode
  101"). Scheduled by default; `plex.include_show_only_matches: false` drops them.
- *unidentified*: raw filenames (all of "Other Media"). Off the schedule unless
  `plex.include_unmatched: true`.

**Language and subtitles.** English audio is picked when the file has it. English
subtitles are shown whenever a file has them (`language.always_subtitles`), and
foreign-audio items need them to be scheduled at all.
- Picture-based subtitle tracks are drawn on live.
- Separate `.srt` files are downloaded to `data\subs` at sync (tiny).
- Items with no English subtitles at all (mostly Real-Debrid) get one from OpenSubtitles.com
  at sync (`opensubtitles:` in config.yaml; `OPENSUBTITLES_*` in `.env`), saved to
  `data\subs` the same way. Foreign-audio files that were skipped for lacking English
  subtitles become playable. Matched by title/season/episode, so timing can be off on a
  different release. Misses are retried after `retry_days`.
- Text tracks *inside* the file (most common) need a local copy: while one show plays,
  the next ones that need it are **downloaded ahead** into `data\spool` (in 32 MB chunks;
  the Plex server drops single long downloads), then played from there with subtitles
  burned in. Same total transfer from the Plex server, just earlier. Copies are deleted
  after 12 hours unused; the folder is capped at `player.spool_max_gb` and files over
  `player.spool_max_file_gb` (a big movie; the default is 8) aren't downloaded and stream
  instead, with no subtitles inside the file and no detected break points. Whatever airs
  next goes to the front of the download queue, but the first show after `/tv`, or one
  joined midway, hasn't been downloaded yet and plays without subtitles. The player log
  says why an item aired without a local copy (`spool: playing X without a local copy`).
- Foreign-audio files with no subtitle track are skipped unless the show is listed
  under `language.hardsubbed_shows`.

**Local files** go in the folders under `local:` in config.yaml:
- shows: `shows\<Show Name>\...\Show.Name.S01E02.Episode.Title.mkv`
- movies: `movies\Movie Title (1994).mkv`
- commercials: one folder per brand (`commercials\Pop-Tarts\...`). New drops land loose in
  `youtube\` or `uploads\` and are filed into a brand folder for you (see *Filing new drops*).
- clips: one folder per game (`clips\Fortnite\...`), filed the same way.
- eyecatches: one folder per series (`eyecatches\Azumanga Daioh\...`), filed the same way.
- shorts: `shorts\<Series>\Series S01E02.mkv`. Short shows (2–15 min, e.g. short anime)
  that are never scheduled on their own; they fill the odd minutes after a skip (below).
  Run `tv.cmd sync` (or wait for the weekly one) after adding files.

**Moving files by hand.** A file's path is its key in the catalog, so a moved file used to look
brand new, with its play count and tags reset. A spot whose name ends in `[id]` (a YouTube id or
a Discord attachment id) is now recognised at the next sync as the moved copy of a vanished
row and keeps that row's play count, last-played time, tags and `tags.csv` decade, holiday and
notes (`src/catalog/history.js`). The parts of a split file never inherit. Video taller than
`player.max_source_height` (2160) is never scheduled, and isn't the copy kept when a file
comes in twice.

**Real-Debrid**: with `RD_TOKEN` in `.env`, every finished torrent on the account joins
the catalog (library "Real-Debrid"), one item per video file. There's no metadata server
behind it, so what a file is comes from its release name: `Show.Name.S01E02.Title...`,
`1x02`, anime-style `[Group] Show - 05`, or `Movie.Title.1994...`; files named with none
of those count as unidentified. Show titles are tidied the way Plex names them
(`The Office (US)`, `Doctor Who (2005)`).
Tracks are read with ffprobe over the network at sync (new torrents only; a failed read
is retried next sync). A torrent whose files Real-Debrid has lost (`hoster_unavailable`)
is given up on for that sync after its first failure; re-add it on Real-Debrid. Shows and movies are downloaded
ahead like Plex ones (subtitles inside the file, break detection); anything not
downloaded yet streams straight from Real-Debrid, with a fresh link made right before
it plays. Removing a torrent from Real-Debrid takes its items off the schedule at the
next sync. Settings under `realdebrid:` in config.yaml.

**Duplicates.** The same episode or movie often comes in more than once (Plex plus a
torrent, a season pack plus single episodes, two releases). After every sync, show names
from Real-Debrid and local folders are lined up with Plex's: same name ignoring case and
punctuation, ignoring a `(2019)`/`(US)` tag (when Plex has only one show by that name),
`Show S2` / `Show 2nd Season` become season 2 of `Show`, and `shows.aliases` in
config.yaml covers the rest (`Boku no Hero Academia: My Hero Academia`; a name mapped to
itself is never merged). Then one copy of each episode (show + season + episode) and
movie (title + year) is kept: a playable one, Plex over local over Real-Debrid, 1080p or
less. The rest are marked `duplicate_of` the kept one, never scheduled and never read
over the network; if the kept Real-Debrid copy can't be read, the next copy is tried.
`tv.cmd stats` counts them. For a show whose copy in one place is broken, `shows.prefer_source`
(`Steins; Gate: realdebrid`) uses that source only: the show's episodes from the other
sources are left out completely, even ones the chosen source lacks. Episodes far shorter
than the rest of their show (clips or promos listed as episodes) are left out too.

**Drop threads.** Anyone can post YouTube (etc.) links or video files in the TV
channel's threads: Commercials, Clips, Eyecatchers, Shorts (`discord.drop_thread_id`,
`clip_thread_id`, `eyecatch_thread_id`, `shorts_thread_id`). The bot reacts ⏳, downloads,
checks each (a playable video; 10 minutes at most, eyecatches 1 minute, shorts 15
minutes), replies with what went in, and they air from the next break (no sync needed:
each post is downloaded and scanned into the local folders within seconds). Spots play in
any language; the "foreign audio needs English subtitles" rule is only for shows and
movies. Shorts are episodic, not a flat spot: a YouTube playlist becomes one show, its
videos numbered episodes in order; a lone link, or files dropped together in one message,
become their own one- (or few-) episode show, named after the video/first file. Spots and
eyecatches land loose in the folder's `youtube\` or `uploads\`, and the next scan files each
into a brand, series or game folder (see *Filing new drops*).

**Timestamps** cut a video into pieces. After a link (or in the message with one
uploaded file): cut points split it (`https://youtu.be/... 0:05` -> 0:00-0:05 and 0:05 to
the end), ranges keep just those parts (`... 1:20-1:35 4:02-4:30`, each its own item).
Times are `0:05`, `1:02:03` or `75s`. The whole video is downloaded to
`data\tmp-downloads` (deleted after), each piece re-encoded to start exactly on its
timestamp and checked against the usual length limit; a video to cut from can be up to
an hour.

**YouTube sign-in**: see the setup section (browser cookies in
`data\youtube-cookies.txt`, not OAuth). **`/tvhelp`** posts (and edits) the help post in
the TV channel; its text is `helpEmbeds()` in `src/bot/bot.js`.

**Filing new drops.** A loose file plays far more often than one inside a folder (a folder
counts as one brand when breaks are filled, a loose file as its own), so every sync, before
the folders are scanned (`src/catalog/brandsort.js`), each loose commercial, eyecatch and clip
is filed into a folder: commercials into a brand folder, eyecatches into a series folder, clips
into a game folder.
- A title that names an existing folder goes there at once ("Kellogg's Pop Tarts" goes in
  Pop-Tarts). An eyecatch's series is its title minus words like "eyecatch" and "widescreen"
  ("Azumanga Daioh Eye Catch 3" goes in the Azumanga Daioh folder, made if it's new).
- Anything else waits in `_staging` (`brand_sort.staging_folder`), which the picker treats as
  one brand, so it stays in rotation without crowding anything out. In the background after the
  sync a model then looks: Claude at five frames (about a cent or two a file, at most 30 calls a
  pass, `brand_sort.claude_vision`), or without an API key a local Ollama model on the title
  (`brand_sort.model`) and then on frames (`brand_sort.vision_model`). A new folder is only made
  when the title or Claude is sure; otherwise the file stays in staging until you move it into
  a folder by hand (its play count and tags follow it).
- Moves keep the catalog row and the `tags.csv` row. `tv.cmd brands [eyecatch|clip]` shows what
  it would do, `--apply` does it now and `--deep` asks the models now. `tv.cmd brands migrate
  --apply` moves existing brand folders out of `commercials\youtube\` (with an undo list in
  `data\`); that was done once.
- Claude's part stops for the rest of the month at `brand_sort.monthly_ceiling_usd` (see
  *Claude usage*); the name match and Ollama carry on.

**Eyecatches** (`D:\data\tv\eyecatches`): a break inside a show or movie gets one before
and one after the commercial if it's the kind of thing that aired with TV breaks:
sitcoms, cartoons, network dramas, rom-coms, TV-friendly movies; not HBO-style prestige
or arthouse. Anime counts too, but a show never gets its own eyecatches (a folder or file named after it). Claude makes that call once per
show and movie (`tv.cmd tag --breaks`, and with the weekly tagging for new titles;
`shows.tv_breaks` / `items.tv_breaks` in the database). `broadcast.eyecatches`: tv, all,
or none. Every file in `eyecatches\` is for any eligible show, except that a folder named
after a show (`eyecatches\Fullmetal Alchemist Brotherhood\`) holds *that show's own*
eyecatches, saved for other shows, and isn't used on the show itself (it'd double up). A
folder counts as one source, like commercials, so a folder of 128 doesn't dominate: a
source is picked first, then a file in it. A file dropped loose is filed into its series
folder first (see *Filing new drops*), so a series is one source.

**Eyecatches that are really several.** Some uploads hold two or three eyecatches back to
back. Any eyecatch longer than `brand_sort.split_min_seconds` (10.5) is checked at sync
(`src/catalog/eyesplit.js`): ffmpeg looks for a gap of silence, a black frame or a hard
picture cut, and Claude looks at frames either side of each candidate and says which are
real boundaries between separate eyecatches. If any are, the video is cut into
`<name> - part N [id]` files (dead air at the cut is dropped) and the original goes to
`data\eyecatch-originals`. A short eyecatch is only asked about when silence or black is
there too, and every file is looked at once (`data\eyesplit-checked.json`).
`tv.cmd eyecatches` shows what it would do (`--all` checks every eyecatch of 4 s or more,
`--apply` cuts). A join that shows as none of those (a dissolve, one continuous music bed)
can't be found this way, so there is also a manual tool:

**The eyecatch clipper** is the editor's `/clip` page (same login as the editor; it's linked
from the editor's header). Pick an eyecatch and it plays in your browser, with sound. Press
`Space` the moment one eyecatch ends and the next begins (it drops a cut marker and keeps
playing), then `Enter` to cut. `K` plays and pauses, the arrow keys jump 1 s (`Shift` 0.1 s),
`,` and `.` step a frame, `Backspace` undoes the last cut, `N` says it's one eyecatch and `S`
skips. Untick a piece to drop it (the dead air between two eyecatches). Cutting keeps the
original in `data\eyecatch-originals` and the catalog follows within seconds; what you've
looked at is remembered in `data\eyecatch-reviewed.json`.

**Commercial reels.** A long commercial that is really a reel of several ads is found the same
way. `tv.cmd commercials` looks at commercials over 75 s for black picture and silence together,
at least 8 s from either end, and asks Claude whether each is a boundary between separate ads
(a black lead-in or an end tag isn't). Only a file that comes out as 3 or more pieces is
touched, and it is never automatic: run it with `--apply`. A serial that Claude sees as one
story is left alone unless you force it (`--force --only=name,name` cuts at every black and
silence moment). Originals go to `data\commercial-originals`, and each part gets its original's
`tags.csv` row.

**Tagging commercials and clips** is by hand: each of those folders gets a
`tags.csv`. Sync adds a blank row for new files; fill in `decade` (90s, 1990s, 1994
all work), `holiday` (halloween / thanksgiving / christmas / none) and `notes` in
Excel, save, and the next sync imports it. Close Excel before syncing. A file that is moved
or filed keeps its row.

**Tagging shows and movies** is by Claude, once (`tv.cmd tag`; cached forever):
vibe, audience (kids/family/teen/adult), animated, anime, country, decade, and which
episodes are Halloween/Thanksgiving/Christmas episodes. The first full pass cost $1.17.

## The schedule

Three layers; Claude never picks individual episodes or movies.

1. **Buckets** are kinds of blocks: "Saturday Morning Cartoons", "Westerns", "So Bad
   It's Good", a movie series in order. Each has a format (1–3 episodes of one show /
   single episodes of different shows / one movie / a movie series in order), the times
   of day it may air (morning 6–12, afternoon 12–17, evening 17–22, late 22–6) and an
   optional seasonal date window. Titles can be in many buckets. Claude defines them,
   then goes through the catalog 80 titles at a time listing every bucket each title fits,
   judging titles by what they are, not how famous they are. Every title gets at least
   one bucket; anything left over lands in plain "Reruns"/"Movie" buckets. Halloween,
   Thanksgiving and Christmas buckets are made automatically from the holiday tags.
   Once a week Claude adds a handful of new buckets for the coming two weeks (seasonal
   and event ideas especially) and sorts in titles new to the catalog.
   `tv.cmd buckets --html` writes `buckets.html`, a searchable page of them all (search
   a title to see every bucket it's in; bucket passes refresh it). `tv.cmd buckets` lists them; `--build` redoes the first pass, `--new` the weekly one
   (`--new "ideas"` for specific requests), `--thin [shows|movies]` makes new buckets for
   titles that only have one (often a loose fit).
   `tv.cmd catalog --html` writes `catalog.html`, a Netflix-style browse of the whole
   library (every show and movie, no streaming) - a row per bucket plus a search that
   flattens everything into one grid; no artwork, so cards are color-tagged by genre
   instead of a poster. The two pages link to each other.
2. **The grid.** Claude lays out the days as bucket slots, a week at a time, staying
   `grid_weeks_ahead` (2) weeks ahead so there's always a buffer ("Sat 06:00 Saturday Morning
   Cartoons, 10:00 Shonen Slop, ..."), from the bucket list alone. Code
   checks it (times of day, seasons, every day covered from 00:00, slots at least an
   hour, a bucket at most twice a day) and sends problems back (3 tries), then falls back
   to a simple code-made grid. `tv.cmd plan` prints it.
3. **Filling**, in code, kept `plan_buffer_days` (7) ahead at all times (the bot tops it
   up, in one shot to `plan_buffer_days + plan_days` out, once less than the buffer is
   left): each slot gets blocks of random picks from its bucket, back to back until
   the next slot. Picks favor what hasn't aired in the longest time (never-aired first),
   so the whole catalog gets turns. Rules: nothing repeats within `no_repeat_days`, a
   show at most once a day, episode blocks at most `max_show_block_minutes`, a movie
   gets its own block, holiday episodes/movies only in their season. A block is planned
   as its shows plus the commercials expected with them, rounded to 5 minutes (while the
   TV is on, times then follow what actually played). When a bucket runs out of things
   that fit, another bucket for that time of day covers the rest of the slot.

Cost: the first bucket pass is about $1; after that roughly $0.20 a week (new buckets
plus the grid). `/tvadmin regen` (or `tv.cmd schedule --replace`) re-fills the upcoming
blocks with new random picks for free; add `new_grid` (`--replan`) to have Claude lay
out a new grid too.

**Scheduling without the API** (`claude.scheduling: local`, the current setting). The
grid comes from `programming.yaml`: pools of buckets and, for each weekday, the slot
times and which pool each draws from (least recently used bucket that may air then, so
the weeks rotate and seasonal buckets drop in while in season). No Claude involved; it
extends two weeks ahead by itself. Buckets are curated once a week by Claude Code
running headless on glados on your subscription: `scripts\weekly-program.ps1`, a
scheduled task (Sundays 04:00, `scripts\install-weekly-program.ps1`), follows
`PROGRAMMING.md` (the procedure, the rules, and the owner's seasonal wishlist) using
`scripts\program\tv.mjs` (review the catalog, check and apply a bucket plan, check the
template). It syncs and tags first (tagging still uses the API, pennies). Between passes,
titles new to the catalog air from the catch-all "Reruns"/"Movie" buckets. Summary:
`data\program\last-run.md`; log: `logs\weekly-program-*.log`. If Claude Code is logged
out the pass fails and the TV carries on from the template. It commits its `programming.yaml`
change only when the checkout is on `main`; on another branch it leaves the file modified and
says so in its log.

**Episode order.** Claude marks each show serialized (a continuing story: Loki,
Interview With The Vampire, most anime) or episodic (sitcoms, anthologies: Fresh Prince,
Black Mirror). Episodic shows play random episodes, like reruns. Serialized ones play in
order, picking up where they left off; one that hasn't aired in 30 days (or ever) starts
over from its first episode, and that block is billed "Series Premiere" (there's also an
automatic Series Premiere bucket of serialized shows). Override per show in config.yaml:
`shows.random` (always random), `shows.in_order` (always in order); or per kind of block:
`buckets.shuffle` / `buckets.in_order` (a show's own setting wins). Shows under
`shows.never` are never scheduled. `tv.cmd tag --order` redoes the serialized/episodic
call for new shows (the weekly upkeep does it too).

**Special episodes.** Claude reads episode titles and flags musical episodes and beach
episodes (`tv.cmd tag --episodes`; weekly for new ones). They become automatic "Musical
Episodes" and "Beach Episodes" (mid-May to mid-September) buckets. Files in the shorts
folder make an automatic "Shorts" bucket.

**Specials** (a marathon or themed night on request) take over the schedule for a few
hours: `/tvadmin special` or `tv.cmd special "..."`. A separate Claude call sees the
whole catalog and picks the titles, so it can spot movie series or themes (Ghibli,
David Lynch). Code checks it, removes the regular blocks it overlaps, and re-fills any
gaps around it. `specials_per_week` has Claude add some by itself (0 by default; the
weekly grid already has marathons).

**Standing slots** are the same block at the same time every week, whatever Claude's
grid says: `broadcast.standing_slots` in config.yaml (Saturday 05:30-12:15 is Saturday
Morning Cartoons). Claude is told about them, and they're stamped onto every new grid;
the grid's block at the end time carries on after (or the next one starts early).

Seasons: Halloween material through October, Thanksgiving until Thanksgiving Day,
then Christmas until the 25th.

**Playback follows the wall clock, and the clock follows playback.** `/tv` works out
where the current block should be and starts that show at the right point. While the TV
is on, each block ends when its shows (and breaks) are actually done, and the rest of
the day moves to match, earlier or later; planned times are only rounded to 5 minutes.
Specials keep their announced times.

**Commercials.** Breaks go where the show had them originally: download-ahead fetches
every Plex show and movie airing in the next 3 hours (same total transfer from the Plex
server, just earlier; played from the local copy) and scans it for moments where the
picture goes black and the sound goes silent together; local files are scanned in place
(about 1-5 minutes per episode, at low priority). Anime that uses a mid-episode eyecatch
instead gets a break at a chapter mark near its middle. Movies and hour-long shows (40+
minutes) get a break about every `piece_minutes` (12), at a chapter mark or right at the
point when there aren't any, and a movie's found break points are subdivided to that pace
too. Inside a short show a break is one commercial (a minute at most), or two if both are
`short_spot_seconds` or shorter; inside a movie or hour-long show it's as many as it
takes to hit `ad_minutes_per_hour` (12) over the whole item, and its block is planned
to match. Between shows: `between_spots` videos; `clip_chance` of the breaks (not of each spot) have exactly one clip among them.
Nothing longer than `max_spot_minutes` airs, except that a between-shows break runs long
rather than repeat a spot that has aired more than a longer one. Every break, inside or
between shows, is bookended by an eyecatch. Commercial picks: files in a `variety_folders`
folder or loose ones are the mixed pool, every other folder is a brand, and all brand folders
together get `brand_share` (0.25) of the picks; within a group the least-played file goes first. Folders named under `ad_families` (every cereal
folder, say) count as ONE brand, so a break carries at most one of them and having dozens of
folders doesn't win the family the break; `ad_family_weight` (2) is how often it comes up
against a single folder, as a multiple of what its combined size would give.
Clips are picked per file instead: every clip gets an equal turn, so a folder's chance is its
share of all the clips (a saga in `ordered_folders`, played one file at a time in order, counts
as the square root of its size). A fixed share used to send three quarters of the clip airtime
to the few loose clips, which then aired about eight times as often as a clip in a folder;
`broadcast.clip_brand_share` (0 to 1) sets a fixed share again if you want one.

**Airing limits and marathons**: nobody wants hours of one thing, so the schedule filler keeps
runs short. A run is blocks of one bucket (or one special) back to back: one of
`marathon_minutes` (180) or more is a marathon, `max_marathons_per_day` (1) fit on a day, a
run stops at `max_marathon_minutes` (240), at most `max_marathon_movies` (2) movies play in a
row, and a planned special runs at most `max_special_hours` (5) hours and there is one
special a day. Each bucket can also have its own limits, set in the bucket editor
(`tv.cmd editor`, the "Airing limits" panel): weekdays it never airs on, times a day, days
between airings, hours a week, and its own longest run. A bucket at a limit sits that slot
out and another bucket covers it (`fill: ... sits out` in the log); limits apply whenever
the schedule is filled, and the editor's Refill button refills the week.

**Skipping**: `/tvadmin skip` drops the rest of the show or movie and takes it off the
schedule; `/tvadmin skipblock` does that for everything left in the block. The next
block starts right away and the rest of the day moves up with it (the guide times
change too). Specials keep their announced time: the move stops there, and the time
before one gets, in order: an episode of a show with nothing scheduled later if one
fits (in-order shows continue where they left off), then shorts from the shorts folder
(each series in order, no repeats within 2 days), then commercials. Whatever fills in
is saved into the schedule, so it counts as aired.

## Volume

Spots come from everywhere (a 2005 cereal ad, a 2025 stream clip), so their loudness differed
by about 10 dB. At sync each commercial, clip and eyecatch is measured once (integrated
loudness, `items.loudness_lufs`, by `src/catalog/loudness.js`), and when it airs a fixed gain
brings it to `broadcast.ad_loudness_lufs` (-24; 0 or `off` leaves them alone), capped at +15 and
-20 dB with a limiter so a boost can't clip. Changing the target needs no re-measuring. Shows
and movies aren't touched; entrance sounds have their own level (`entrance.loudness_lufs`).

## Claude usage

Every call goes through `claudeClient()` (`src/claude.js`), which appends one line (time,
project, purpose, model, input and output tokens - never prompts or answers) to a shared log,
`claude.usage_log` (here `D:\docker-data\claude-usage.jsonl`, the file the money dashboard reads
for its weekly spend note; blank means `data\claude-usage.jsonl`). The batch tagging is logged
with `batch: true` (it bills at half price). The automatic filing and splitting - not the weekly
tagging and planning - also stop using Claude for the rest of the calendar month once they have
used about `brand_sort.monthly_ceiling_usd` ($2), counted from that log at list prices.

## Optional: turning on Quick Sync

glados's Intel UHD 630 has no driver (Device Manager shows "Microsoft Basic Display
Adapter" with an error). To enable it:

1. Download **Intel Graphics – Windows DCH Drivers** for 7th–10th gen (v31.0.101.2145
   or newer) from Intel's
   [UHD Graphics 630 support page](https://www.intel.com/content/www/us/en/support/products/126790/graphics/processor-graphics/intel-uhd-graphics-family/intel-uhd-graphics-630.html).
2. Run the installer. On Windows Server it often refuses. If so, unzip the download
   (7-Zip opens the .exe too), then Device Manager → right-click **Microsoft Basic
   Display Adapter** → Update driver → Browse my computer → Let me pick → Have Disk →
   select `Graphics\iigd_dch.inf`.
3. Reboot if asked.
4. Test: `tools\ffmpeg\bin\ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -t 5 -c:v h264_qsv -f null -`.
   No "Invalid argument" error means it works; then set `encode.encoder: qsv` in
   config.yaml. If it fails with no monitor attached, an HDMI dummy plug fixes that.

## Not built yet

- Jellyfin as a second source (waiting on the server's address and a login).
- Several voice channels at once (one Discord account can only be in one call; it would
  take a second throwaway account and player).
- Bringing shows and movies to one volume too (only spots are leveled).
- Finding the join in an eyecatch that shows as no silence, black or cut, by sampling frames
  across the video and asking Claude (the clipper covers it by hand meanwhile).

## Heads up

Streaming from a user account ("selfbot") is against Discord's Terms of Service.
That's why a throwaway account does it: the worst case is that account gets banned,
not yours. The controller bot is a normal, allowed bot.

## Weather

A weather report airs once or twice a day (`weather.times` in `config.yaml`, default 7:00 and 18:00), in the first
commercial break between shows after that time. It is made about 15 minutes before by the bot: for each place in
`weather.locations` it reads the National Weather Service forecast, hourly forecast, and alerts (US only, no key),
and builds one clean static board - every place, stacked vertically, its next 8 hours side by side (`src/weather/board.js`,
rendered as real HTML/CSS via a headless Puppeteer browser and screenshotted to a PNG, not hand-placed ffmpeg text).
A short voice-over (a sentence or two per place, more only for real rain/snow/an alert/an extreme temp) plays under
it start to finish. Nothing is written by an AI. If no break comes within `weather.window_hours` (3) of the time,
that report is skipped. `tv.cmd weather` makes one right now and prints where the mp4 is, without airing it.
Places: `{ name, lat, lon }`.

Voices: `weather.voices` is a weighted pool - one is picked per place (they repeat freely; there's no per-voice setup
cost like the old character-voice models had). Each entry is `"edge:<voice>"` (a Microsoft/Azure neural voice via
edge-tts) or `"google:<lang>"` (the Google Translate TTS voice for that language code); `"edge:random"` /
`"google:random"` pick randomly from that entry's `pool` (edge) or a built-in language grab-bag (google) each time
that tier comes up. Numbers in the script are spelled out as words ("eighty-nine degrees," not "89") before any of
this, because a non-English voice reading a bare digit tends to read it in its own language instead of English.
