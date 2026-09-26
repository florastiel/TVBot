# tvchannel

A fake cable TV channel for the Discord server. A throwaway Discord account
("the streamer account") Go Live streams a schedule of shows, movies and commercials into a voice
channel, on the wall clock like real TV; a normal bot (TVbot, coupbot's old token) is
the remote control. Claude sorts the catalog into kinds of blocks and lays out a weekly
grid of them; code fills the grid with random picks.

**Status: running.** Both parts are Windows services on glados that start with the
machine and restart if they crash (see *Running it*).

## How it fits together

```
  TVbot (bot)    --HTTP on 127.0.0.1-->  player (the streamer account)  -->  Go Live in voice
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

**If the player log says "invalid token"**: the streamer account's token was reset (logging out
of that browser session does it). Log in to the streamer account in an incognito window, F12 →
Network → click a channel → copy the `authorization` header into `STREAMER_TOKEN`,
then close the window *without* logging out.

## Running it

Two NSSM services, `tvchannel-player` and `tvchannel-bot` (run as LocalSystem, start
with Windows, restart on a crash; `scripts\install-services.ps1` sets them up). Logs:
`logs\player-YYYY-MM-DD.log` and `logs\bot-YYYY-MM-DD.log`. For a test by hand, stop
the services and run `tv.cmd player` / `tv.cmd bot` in two terminals.

To load new code or settings: `tv.cmd restart`. The bot restarts right away; the
player restarts at the next commercial break (in place of the ads) and comes back to
the same channel by itself after about 20 seconds; viewers click Watch again (with the
TV off it restarts at once). If the player ever freezes,
the bot notices after 2 minutes and kills it, and the service starts a fresh one.

## Discord commands

| Command | Who | What |
|---|---|---|
| `/tv` | anyone in a voice channel | TV joins your voice channel and starts whatever is on now |
| `/tvoff` | anyone | TV leaves |
| `/tvpause`, Pause button | people in the TV's voice channel | emergency pause: the show cuts to a silent "Paused" card at once |
| `/tvresume`, Resume button | people in the TV's voice channel | picks up at the second it was paused; the channel then catches up by cutting ads |
| `/tvlive` | people in the TV's voice channel | forget the delay, jump to what the schedule says is on now |
| `/schedule` | anyone | today's TV guide (only you see it); `week: True` shows the week (real shows where picked, block types after), a card per day |
| `/entrance set` + file | anyone | your join sound (first 8 s, volume evened out) |
| `/entrance clear` | anyone (admin: anyone's) | remove a join sound |
| Skip commercials button (on the break message in the posting channel) | people in the TV's voice channel | ends the current break |
| `/tvadmin skip` | admin | skip this episode or movie (also off the schedule); the block goes on with its next one, and the day moves up (see *Skipping*) |
| `/tvadmin skipblock` | admin | skip the rest of this block; the next block starts right away |
| `/tvadmin sync` | admin | re-read the catalog now |
| `/tvadmin regen` | admin | throw away the upcoming schedule and program a new week (specials stay) |
| `/tvadmin add` + kind + links | admin | download commercials/clips from YouTube (etc.) straight into rotation |
| `/tvadmin special` + request | admin | plan a marathon or themed special, e.g. "Scream marathon Saturday 8pm" |

The bot keeps one TV message in the posting channel: "Now playing / Up next" with a
Pause button while a show is on; during a break it becomes "Commercial break / Up next /
Back in 2 minutes" with Skip and Pause buttons. Just after midnight it also posts the
whole day's programming (`discord.daily_guide`; `discord.guide_channel_id` for another
channel). The streamer account's Discord status
(rich presence) shows the same: the show with a time-left bar, or a countdown to the next
show during ads.

## Command line

```
tv.cmd sync                          pull the catalog from Plex + local folders + Real-Debrid (~30 s)
tv.cmd stats                         what's in the catalog, why things can't be scheduled
tv.cmd tag                           tag anything untagged with Claude (batch, half price)
tv.cmd tag --dry                     estimate what tagging would cost, no API calls
tv.cmd tag --redo                    retag everything
tv.cmd schedule [days] [--replace]   program the schedule (default 7 days; keeps existing days)
tv.cmd guide                         print today's guide
tv.cmd add commercial <links...>     download commercials (or: add clip) from YouTube etc. and sync
tv.cmd playlist "<show>" [count]     test override: loop a few episodes instead of the schedule
tv.cmd playlist --clear              back to the schedule
```

## Settings

Everything you'd want to change is in **`config.yaml`** (comments explain each line):
planned-time rounding (5 min), commercials per break, clip chance, longest commercial,
no-repeat window, idle timeout, which shows always/never play in order, encode
size/bitrate, Plex server + libraries, local folders, entrance sound length and volume,
encoder (qsv = Intel Quick Sync, falls back to CPU by itself), how often the Go Live
thumbnail updates (`player.stream_preview_minutes`, 5; 0 = none), Claude model.
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
- Text tracks *inside* the file (most common) need a local copy: while one show plays,
  the next ones that need it are **downloaded ahead** into `data\spool` (in 32 MB chunks;
  the Plex server drops single long downloads), then played from there with subtitles
  burned in. Same total transfer from the Plex server, just earlier. Copies are deleted
  after 12 hours unused; the folder is capped at `player.spool_max_gb` and files over
  `player.spool_max_file_gb` are skipped. The first show after `/tv`, or one joined
  midway, hasn't been downloaded yet and plays without subtitles.
- Foreign-audio files with no subtitle track are skipped unless the show is listed
  under `language.hardsubbed_shows`.

**Local files** go in the folders under `local:` in config.yaml:
- shows: `shows\<Show Name>\...\Show.Name.S01E02.Episode.Title.mkv`
- movies: `movies\Movie Title (1994).mkv`
- commercials / clips: anything, subfolders fine
- shorts: `shorts\<Series>\Series S01E02.mkv`. Short shows (2–15 min, e.g. short anime)
  that are never scheduled on their own; they fill the odd minutes after a skip (below).
  Run `tv.cmd sync` (or wait for the weekly one) after adding files.

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
`tv.cmd stats` counts them.

**Drop threads.** Anyone can post YouTube (etc.) links or video files in the TV
channel's threads: Commercials, Clips, Eyecatchers (`discord.drop_thread_id`,
`clip_thread_id`, `eyecatch_thread_id`). The bot reacts ⏳, downloads, checks each
(a playable video; 10 minutes at most, eyecatches 1 minute), replies with what went in,
and they air from the next break.

**Eyecatches** (`D:\data\tv\eyecatches`): a break inside an anime episode gets one before
and one after the commercial (`broadcast.eyecatches`: anime, all, or none). Files in
`eyecatches\<Show Name>\` belong to that show only, and a show with its own uses only
those; loose files (and thread uploads) are for any show.

**Tagging commercials and clips** is by hand: each of those folders gets a
`tags.csv`. Sync adds a blank row for new files; fill in `decade` (90s, 1990s, 1994
all work), `holiday` (halloween / thanksgiving / christmas / none) and `notes` in
Excel, save, and the next sync imports it. Close Excel before syncing.
`D:\data\tv\commercials\_TEST` and `clips\_TEST` hold fake test files; delete them
once real ones are in.

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
2. **The grid.** Claude lays out the days as bucket slots, a week at a time, staying
   `grid_weeks_ahead` (2) weeks ahead so there's always a buffer ("Sat 06:00 Saturday Morning
   Cartoons, 10:00 Shonen Slop, ..."), from the bucket list alone. Code
   checks it (times of day, seasons, every day covered from 00:00, slots at least an
   hour, a bucket at most twice a day) and sends problems back (3 tries), then falls back
   to a simple code-made grid. `tv.cmd plan` prints it.
3. **Filling**, in code, `plan_days` ahead (the bot tops it up when less than 12 hours
   are left): each slot gets blocks of random picks from its bucket, back to back until
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
instead gets a break at a chapter mark near its middle; long movies without either get
one about every 30 minutes. Inside a show a break is one commercial (a minute at most),
or two if both are `short_spot_seconds` or shorter. Between shows: `between_spots`
videos (the first is a clip `clip_chance` of the time). Nothing longer than
`max_spot_minutes` airs. `D:\data\tv\ad-lengths.csv` lists every commercial and clip
with its length.

**Skipping**: `/tvadmin skip` drops the rest of the show or movie and takes it off the
schedule; `/tvadmin skipblock` does that for everything left in the block. The next
block starts right away and the rest of the day moves up with it (the guide times
change too). Specials keep their announced time: the move stops there, and the time
before one gets, in order: an episode of a show with nothing scheduled later if one
fits (in-order shows continue where they left off), then shorts from the shorts folder
(each series in order, no repeats within 2 days), then commercials. Whatever fills in
is saved into the schedule, so it counts as aired.

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

## Heads up

Streaming from a user account ("selfbot") is against Discord's Terms of Service.
That's why a throwaway account does it: the worst case is that account gets banned,
not yours. The controller bot is a normal, allowed bot.
