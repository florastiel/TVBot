# tvchannel

A fake cable TV channel for the Discord server. A throwaway Discord account
("the streamer account") Go Live streams a schedule of shows, movies and commercials into a voice
channel, on the wall clock like real TV; a normal bot (coupbot) is the remote control.
Claude tags the catalog once and programs the schedule each week.

**Status: steps 1–5 built.** Step 6 (run as an auto-starting Windows service with log
files) is next. Until then the two parts are started by hand (see *Running it*).

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
  scheduled (programs a new week when it runs low).

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
`BOT_TOKEN` (coupbot), `PLEX_TOKEN`, `ANTHROPIC_API_KEY`, `GUILD_ID`. `.env` is
gitignored; never commit it.

**If the player log says "invalid token"**: the streamer account's token was reset (logging out
of that browser session does it). Log in to the streamer account in an incognito window, F12 →
Network → click a channel → copy the `authorization` header into `STREAMER_TOKEN`,
then close the window *without* logging out.

## Running it

Two terminals (until step 6 makes them a service):

```
tv.cmd player
tv.cmd bot
```

To load new code or settings: `tv.cmd restart`. The bot restarts right away; the
player restarts at the next commercial break (in place of the ads) and comes back to
the same channel by itself after about 20 seconds; viewers click Watch again. If the player ever freezes,
the bot notices after 2 minutes and kills it, and the service starts a fresh one.

## Discord commands

| Command | Who | What |
|---|---|---|
| `/tv` | anyone in a voice channel | TV joins your voice channel and starts whatever is on now |
| `/tvoff` | anyone | TV leaves |
| `/tvpause`, Pause button | people in the TV's voice channel | emergency pause: the show cuts to a silent "Paused" card at once |
| `/tvresume`, Resume button | people in the TV's voice channel | picks up at the second it was paused; the channel then catches up by cutting ads |
| `/tvlive` | people in the TV's voice channel | forget the delay, jump to what the schedule says is on now |
| `/schedule` | anyone | today's TV guide (only you see it) |
| `/entrance set` + file | anyone | your join sound (first 8 s, volume evened out) |
| `/entrance clear` | anyone (admin: anyone's) | remove a join sound |
| Skip commercials button (on the break message in the posting channel) | people in the TV's voice channel | ends the current break |
| `/tvadmin skip` | admin | skip whatever is playing (broken file) |
| `/tvadmin sync` | admin | re-read the catalog now |
| `/tvadmin regen` | admin | throw away the upcoming schedule and program a new week (specials stay) |
| `/tvadmin add` + kind + links | admin | download commercials/clips from YouTube (etc.) straight into rotation |
| `/tvadmin special` + request | admin | plan a marathon or themed special, e.g. "Scream marathon Saturday 8pm" |

The bot keeps one TV message in the posting channel: "Now playing / Up next" with a
Pause button while a show is on; during a break it becomes "Commercial break / Up next /
Back in 2 minutes" with Skip and Pause buttons. The streamer account's Discord status
(rich presence) shows the same: the show with a time-left bar, or a countdown to the next
show during ads.

## Command line

```
tv.cmd sync                          pull the catalog from Plex + local folders (~30 s)
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
broadcast hours, the block grid (15 min), min/max ad minutes per hour, clip chance, no-repeat window,
idle timeout, encode size/bitrate, Plex server + libraries, local folders, jingle and
volume, encoder (qsv = Intel Quick Sync, falls back to CPU by itself), Claude model.
After changing settings: `tv.cmd restart` (the player waits until the TV is off).

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

Claude programs `plan_days` ahead (1 by default; the bot tops it up when less than 12
hours are left), one day at a time, from a menu: a few random episodes of each show
(reruns in any order, like real TV), in-season holiday episodes, and a sample of
movies, all skipping anything aired within `no_repeat_days`. It
returns blocks (a 1–3 word label and which items). Code works out each block's length:
its shows plus at least `min_ad_minutes_per_hour` of ads, rounded up to the next quarter hour, so
blocks start and end on :00/:15/:30/:45. Code checks every answer: ids from the menu,
nothing repeats within `no_repeat_days`, a movie gets its own block, labels are plain
words, and no block's rounding leaves more than `max_ad_minutes_per_hour` of ads.
Problems go back to Claude (3 tries), then a simple code-built schedule is used.
Roughly $0.25 per day of schedule with Sonnet 5.

**Episode order.** The first time a show airs it starts at a random episode; after that
it continues in order, picking up where it left off (and wrapping around after the finale). Shows listed under `shows.random` in
config.yaml play random episodes instead, like reruns.
Shows under `shows.never` are never scheduled.

**Specials** (marathons, themed nights) take over the regular schedule for a few hours.
Claude plans `specials_per_week` of them by itself (usually weekend evenings), and
`/tvadmin special` or `tv.cmd special "..."` plans one on request. A separate Claude
call sees the whole catalog, so it can spot movie series (Scream, the Dragon Ball Z
movies, Knives Out...) or themes (Ghibli, David Lynch). Code checks it, removes the
regular blocks it overlaps, and re-fills any gaps around it.

Seasons: Halloween material through October, Thanksgiving until Thanksgiving Day,
then Christmas until the 25th, ramping up as the day gets closer.

**Playback follows the wall clock.** `/tv` works out where the current block "should"
be and starts that show at the right point. A block's ad time is spread evenly across
the breaks after each show (clips count as commercials; whole files, so a break can
run a few seconds long). If a break is skipped, the next show starts early and the
last break makes up the difference; a plain "Up next" card covers any last seconds.

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

- Subtitles that are a text track inside the video file (see *Language*).
- Mid-show commercial breaks at the original ad-break points (blackdetect /
  silencedetect could find them ahead of time).

## Heads up

Streaming from a user account ("selfbot") is against Discord's Terms of Service.
That's why a throwaway account does it: the worst case is that account gets banned,
not yours. The controller bot is a normal, allowed bot.
