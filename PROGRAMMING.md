# Weekly programming pass

You're the program director of this fake cable-TV channel (see README.md). Once a week
(Sunday early morning, `scripts\weekly-program.ps1`) Claude Code runs this pass on glados
instead of the Claude API: the catalog has just been synced and tagged; your job is to
keep the **buckets** (kinds of blocks) and the **weekly template** (`programming.yaml`)
good. Code fills the actual episodes and movies, and extends the grid from the template
by itself (`claude.scheduling: local`).

## Steps

Run commands with the Bash tool, exactly in the form `tools/node/node.exe
scripts/program/tv.mjs ...` from the project folder (that's the only command allowed;
`tools` and `node_modules` are links, so they may look empty to Glob).

1. `tools/node/node.exe scripts/program/tv.mjs review` and read `data\program\review.txt`:
   the buckets, what's new since the last pass, titles in no bucket or only one, and the
   whole catalog.
2. Decide bucket changes and write them to `data\program\plan.json` (format at the top of
   `apply()` in `scripts\program\tv.mjs`):
   - every title **new since the last pass** gets 1–4 fitting buckets; nothing may be left
     only in the catch-alls ("Reruns", "Movie");
   - new buckets when a group of titles deserves its own block (see the notes below);
   - fix obvious misfits you notice, but don't reshuffle what works.
3. `tools/node/node.exe scripts/program/tv.mjs apply data/program/plan.json` until it says
   the plan is OK, then again with `--apply`.
4. If the next few weeks call for it (a season starting, new buckets that should air),
   edit `programming.yaml`: put new buckets in pools; add a slot or a pool. Then
   `tools/node/node.exe scripts/program/tv.mjs check` must say OK.
5. `tools/node/node.exe scripts/program/tv.mjs done`.
6. Write a short summary of what you changed to `data\program\last-run.md` (plain
   sentences; the owner reads it).

## Rules

- Bucket formats: `one_show` (1–3 episodes of one show per block; a single well-known show is fine, but nothing so niche the name would puzzle viewers), `variety`
  (single episodes of different shows; 4+ shows), `movie` (one movie per block; 3+
  movies), `movie_series` (one franchise in order; 2+ movies, listed in play order).
  Shows only in one_show/variety, movies only in movie/movie_series.
- Names: 1–4 plain words, what viewers see. `about`: one line on what belongs.
- Dayparts: morning 6–12, afternoon 12–17, evening 17–22, late 22–6. Kids' stuff in the
  morning/afternoon; adult, gory or explicit only evening/late.
- Seasonal buckets get `active_from`/`active_to` (MM-DD). Halloween, Thanksgiving and
  Christmas *episode* and *movie* buckets are made automatically from the holiday tags;
  make more specific seasonal buckets on top of them.
- Don't touch `config.yaml`, the schedule (`blocks`), or anything outside buckets and
  `programming.yaml`. Never delete titles; `exclude` only for a broken or mislabeled
  file (say why).
- Keep it proportionate: a typical week is a handful of changes.
- Media-type mix: a slot's pool picker only looks at which bucket in the pool was used
  longest ago, never at genre, so a pool leaning heavily anime will draw anime often by
  chance even if the catalog overall isn't anime-heavy (checked 2026-09-27: about a
  quarter of airtime is anime, evenly spread across dayparts - not actually skewed). When
  adding a bucket to a pool or building a new one, avoid making any single pool mostly
  anime buckets (see `LATE_B` for what to avoid piling onto further), so two anime blocks
  back to back stays the exception, not the rule.

## Programming notes (the owner's wishlist; build these as the titles arrive)

**Halloween** (October)
- *Cozy & campy*: Hocus Pocus, Beetlejuice, The Addams Family, Casper, Corpse Bride,
  Coraline, The Nightmare Before Christmas, Scary Godmother, Halloweentown, The Haunted
  Mansion, Muppets Haunted Mansion, The Legend of Sleepy Hollow (1949), ParaNorman,
  Wallace & Gromit: The Curse of the Were-Rabbit, It's the Great Pumpkin Charlie Brown,
  The Halloween Tree, Halloween Is Grinch Night, Toy Story of Terror; shows: Sabrina the
  Teenage Witch, Over the Garden Wall, Gravity Falls ("Summerween"), Courage the
  Cowardly Dog, The Owl House, Wednesday, Danny Phantom.
- *Camp horror & musicals*: Rocky Horror, Little Shop of Horrors, Shaun of the Dead,
  What We Do in the Shadows, Trick 'r Treat, Death Becomes Her; Halloween episodes of
  Buffy, The Simpsons (Treehouse of Horror), Bob's Burgers, Powerpuff Girls ("Boogie
  Frights"), Ouran High School Host Club.
- *Actual horror* (late only): Alien, The Descent, Let the Right One In, The Babadook,
  Hereditary, Ready or Not, It Follows.
- *Anime*: Hellsing Ultimate, Castlevania, Castlevania: Nocturne, Death Parade.

**Thanksgiving & fall** (November): A Charlie Brown Thanksgiving, Planes Trains and
Automobiles, Addams Family Values, Free Birds, Home for the Holidays (1995), Friends
Thanksgiving episodes, Gilmore Girls, Practical Magic, Sleepy Hollow (1999), Fantastic
Mr. Fox, Dead Poets Society, When Harry Met Sally, You've Got Mail, Sweet Home Alabama,
Little Women (2019), Pride & Prejudice (2005), Harry Potter (a movie_series marathon),
Snoopy Come Home, The Peanuts Movie, Hallmark-style fall movies.

**Christmas & winter** (late November – December)
- *Cozy Christmas*: Rudolph, A Charlie Brown Christmas, How the Grinch Stole Christmas
  (1966), Frosty, The Muppet Christmas Carol, Elf, Home Alone 1–2, Christmas Vacation,
  Miracle on 34th Street, It's a Wonderful Life, The Polar Express, The Santa Clause,
  Arthur Christmas, Klaus, Love Actually, Scrooged, Hallmark-style Christmas movies.
- *Not-so-cozy Christmas*: Die Hard, Lethal Weapon, Batman Returns, Kiss Kiss Bang Bang,
  Gremlins, Krampus, Black Christmas.
- *Winter, no Christmas required* (all winter): Frozen, The Snowman (1982), Groundhog
  Day, Fargo, The Shining, The Thing.
- *Anime*: Sanda, To Your Eternity, Tokyo Godfathers, Toradora! (its Christmas stretch).

**Year-round**: a girl-power cartoon block (Winx Club, W.I.T.C.H., Totally Spies!, My
Life as a Teenage Robot) for mornings/afternoons; Danny Phantom there too.

**Lost from Real-Debrid, to find again** (couldn't be revived on 2026-09-26; the rest of the
dead torrents came back). Add the title from a new source and it joins its buckets by name.
- Needs a fresh download or another release (no longer cached): Good Eats (237 episodes),
  Dirilis Ertugrul season 5, Bleach: Thousand-Year Blood War ("Season 17", 26 episodes),
  Tropical-Rouge! Precure, Star☆Twinkle Precure (other releases of it did come back, so
  check first), Princession Orchestra, Resurrection (2014, season 1), Hotel Portofino
  (episodes 5–6), Peerless Battle Spirit Sr., Alien 9, The Clint Eastwood Collection.
- Blocked by Real-Debrid (infringing_file), needs another source: SpongeBob SquarePants
  (both releases), Teen Wolf season 1, Titans season 1, Tulsa King season 2.
