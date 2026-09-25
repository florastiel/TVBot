# tvchannel

A fake cable TV channel for the Discord server. A throwaway Discord account Go Live
streams a schedule of shows, movies and commercials into a voice channel; a normal
bot is the remote control.

**Status: step 2 of 6 done (catalog).** Next: the controller bot + player.

## Why it runs natively (not Docker)

Docker Desktop on Windows runs containers inside WSL2, which can't reach the Intel
iGPU's Quick Sync encoder (only NVIDIA GPUs get passed through). So this runs
directly on glados with a portable Node + ffmpeg kept in `tools\`, with nothing
installed system-wide.

Quick Sync isn't required. CPU encoding (libx264) turns 1080p into 720p at about
8x real time on the i5-8500T, so one stream uses roughly 1/8 of the CPU.

## Setup (one time)

Already done on glados: `tools\node` (Node 24 LTS), `tools\ffmpeg` (BtbN build),
`npm install`. If you ever rebuild from scratch:

1. Download the Node 24 Windows x64 zip from nodejs.org and unzip it to `tools\node`.
2. Download `ffmpeg-master-latest-win64-gpl.zip` from github.com/BtbN/FFmpeg-Builds
   and unzip it to `tools\ffmpeg`.
3. `tools\node\npm install`, then `tools\node\npm install-scripts approve node-av zeromq`
   and `tools\node\npm rebuild node-av zeromq`.

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored; never commit it.

## Running things

Everything goes through `tv.cmd`, which points Node at the portable tools:

```
tv.cmd poc\stream.js data\testclip.mp4          stream the test clip
tv.cmd poc\stream.js data\testclip.mp4 60       same, starting 60s in (seek test)
tv.cmd poc\plex.js                              list Plex servers + connections
tv.cmd poc\plex.js pick                         print a direct URL for one episode
tv.cmd poc\stream.js "<that URL>"               stream it
```

Press Ctrl+C to stop; the account leaves the voice channel.

`data\testclip.mp4` is a generated 2-minute color-bar clip with a 440 Hz beep and
an on-screen timestamp, so you can check picture, audio and seeking at a glance.

## Settings

Everything you'd want to change is in **`config.yaml`** (comments explain each
line). Secrets live in `.env`. After editing either, restart the TV (step 6 adds
the service; until then just re-run the command).

## The catalog

```
tv.cmd sync      pull everything from Plex + local folders, import tags.csv files (~30s)
tv.cmd stats     what's in the catalog and why things can't be scheduled
```

The catalog lives in `data	v.db` (SQLite). Sync is safe to run any time; it only
re-reads audio/subtitle details for items Plex says changed.

**What gets scheduled.** Plex items come in three flavors:
- *fully identified*: title, summary, air date, all there.
- *show-only*: Plex knows the show but not the episode (King of the Hill "Episode
  101"). Included by default; set `plex.include_show_only_matches: false` to drop them.
- *unidentified*: raw filenames (all of "Other Media"). Excluded unless you set
  `plex.include_unmatched: true`.

**Language.** English audio is picked when the file has it. Foreign-audio items need
English subtitles: picture-based subtitle tracks are drawn on live, and separate
`.srt` files are downloaded to `data\subs`. Items whose subtitles are a text track
*inside* the video file are skipped for now (planned). Foreign-audio files with no
subtitle track at all are skipped, unless you list the show under
`language.hardsubbed_shows` because its subtitles are burned into the picture.

**Local files** go in the folders under `local:` in config.yaml:
- shows: `shows\<Show Name>\...\Show.Name.S01E02.Episode.Title.mkv`
- movies: `movies\Movie Title (1994).mkv`
- commercials / clips: anything, subfolders are fine

**Tagging commercials and clips.** Each of those folders gets a `tags.csv`. Every
sync adds a blank row for new files; fill in `decade` (90s, 1990s, 1994 all work),
`holiday` (halloween / thanksgiving / christmas / none) and `notes` in Excel, save,
and the next sync imports it. Close Excel before syncing, or sync can't add new rows.

## Optional: turning on Quick Sync

glados's Intel UHD 630 has no driver (Device Manager shows "Microsoft Basic Display
Adapter" with an error). To enable it:

1. Download **Intel Graphics – Windows DCH Drivers** for 7th–10th gen (v31.0.101.2145
   or newer) from Intel's
   [UHD Graphics 630 support page](https://www.intel.com/content/www/us/en/support/products/126790/graphics/processor-graphics/intel-uhd-graphics-family/intel-uhd-graphics-630.html).
   Get the **.zip** if offered, otherwise the .exe.
2. Run the installer. On Windows Server it often refuses ("system does not meet
   minimum requirements"). If so, unzip the download (7-Zip opens the .exe too),
   then Device Manager → right-click **Microsoft Basic Display Adapter** → Update
   driver → Browse my computer → Let me pick → Have Disk → select
   `Graphics\iigd_dch.inf`.
3. Reboot if asked. The screen/RDP session may flicker once.
4. Test: `tools\ffmpeg\bin\ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -t 5 -c:v h264_qsv -f null -`.
   If there's no "Invalid argument" error, it works. Then set `ENCODER=qsv` in `.env`.
   Some older drivers only enable Quick Sync with a display attached; an HDMI dummy
   plug (~$8) fixes that if the test fails headless.

## Planned extras (not built yet)

- **Entrance sounds.** `/entrance` + an uploaded audio/video file; the bot keeps the
  first 8 seconds (configurable), evens out the volume, and saves it per user.
  `/entrance clear` removes yours; the admin can clear anyone's. When that person
  joins the voice channel while the TV is on, the streamer account plays it over
  its "microphone" so everyone in the channel hears it, not just stream viewers.
  Needs a feasibility test (mic audio alongside Go Live) during step 3.
- **English subtitles** burned into the picture when a file has them (nice-to-have).
- **Mid-show commercial breaks** at the original ad-break points (blackdetect /
  silencedetect), per the original plan's "later" list.

## Heads up

Streaming from a user account ("selfbot") is against Discord's Terms of Service.
That's why a throwaway account does it: the worst case is that account gets banned,
not yours. The controller bot (step 3) is a normal, allowed bot.
