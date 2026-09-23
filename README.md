# tpdbarr

ThePornDB scenes into Whisparr v2, checked against Stash. The v2/TPDB
counterpart to [stasharr](https://github.com/enymawse/stasharr), which does the
same job for StashDB and Whisparr v3.

Two editions, same integration logic:

- **[portal/](portal/)** — a self-hosted container with its own UI. Browse and
  search TPDB, add scenes, see what you already have. No extension, no TPDB
  account. This is the one to use.
- **[tpdbarr.user.js](tpdbarr.user.js)** — a userscript that adds the button to
  theporndb.net pages themselves, for when you're already browsing there.
- **[fileflows/](fileflows/)** — the FileFlows flows that encode scenes
  before Stash files them. Optional.

## An overlay on Stash, not a replacement

Stash stays your library. The portal sits on top of it and adds a different
way to browse, find and tidy what is already there.

- **It reads Stash live**, over Stash's own GraphQL API. There is no second
  copy of your library and nothing to sync.
- **What it changes goes back into Stash**: markers, galleries, metadata,
  covers. Open Stash afterwards and it's all there.
- **It plays files from the folders Stash already uses**, at the same paths.
  Nothing gets moved into a library of its own.
- **Its own state is small**: settings, the want and ignore lists, and the
  catalogues you track, in one `config.json`.
- **Stash keeps doing its job.** Scanning, identifying, scrapers and plugins all
  stay in Stash. Stop the portal and Stash carries on exactly as before.

## The Feed — your markers, like TikTok

<img src="docs/screenshots/feed-phone.jpg" alt="The Feed on a phone: one marker clip, its tag, scene, studio and cast, with the control bar below" width="300" align="right" />

A vertical, swipe-through feed of the **moments** in your library rather than
whole scenes. Every Stash scene marker becomes a clip, and the portal plays
them one after another, full screen, like a short-video app.

- **Swipe up for the next clip** (or ↓ / `j`). Swipe the feed strip sideways
  (or ← / →) to change feed, drag along a clip to scrub, and Space pauses.
- **Your own clips, at 720p.** Stash renders marker clips at 640x360 whatever
  the source. The portal cuts its own from the original file at 720p and
  falls back to Stash's clip, then to the scene itself, if one isn't there.
- **Five feeds.** *Markers*, *Scenes*, *RedGIFs*, *Reddit*, or *All three*,
  which mixes your library with RedGIFs and Reddit posts from the performers
  you already have (75/15/10 by default, set with a slider).
- **Filter by tag**, shuffle (a new order every visit, stable while you page),
  auto-advance to the next clip after one loop, and switch the framing between
  Fit and 4:3.
- **It remembers how you left it** — feed, framing, mix — on the server, so
  your phone and your desktop agree.

Open it from **Feed** next to the name in the top bar, or go to `#/binge`.

<br clear="right" />

## What's in it

Five tabs across the top: **Library**, **Stats**, **Find**, **Catalogue** and
**Manage**. Pictures in the screenshots are blurred on purpose. It's an adult
library.

### Library — browsing what you have

![Library overview](docs/screenshots/library-overview.jpg)

- **Overview** opens with the Feed, then industry news from five publishers
  merged into one stream, then Continue watching, New scenes, Recently released,
  and new from your performers and studios.
- **Every shelf uses one filter bar**: Scenes, Performers, Studios and Galleries
  share the same search, dropdowns, sort, Clear and Random. The dropdown counts
  update as you narrow.
- **Every tile says where the scene stands**, bottom left: *Waiting to import*,
  *Needs organizing* or *Filed*, beside the resolution.
  - **Red** means bigger than its target resolution (720p unless you chose
    otherwise).
  - **Yellow** means at or under the target but not finished.
  - **Green** means filed, organised and at target.
- **Hover a tile to preview it.** The scene's preview loop plays, and running
  the mouse along the bottom scrubs the whole runtime off Stash's sprite sheet
  without loading the video.
- **The scene page is two columns.** On the left are the player and everything
  you *do*: filed, rating, markers, description. On the right is everything you
  *read*: links out, galleries, tags, file spec.
  - Drag anywhere across the picture to scrub.
  - A wide switch folds the right column away and dims the rest of the page.
  - Picture-in-picture and fullscreen work on iPad too.
- **Scale a file down** from the scene page: Keep, 1080p, 720p or 480p.
  - It re-encodes and replaces the file, and only deletes the original once the
    new one is checked: right height, same runtime, smaller.
  - It can drop a `.fileflows-ignore` flag so FileFlows leaves your choice
    alone.
- **Performer and studio pages** show a facts grid beside the portrait or logo.
  - Stash wins every field it has. Blanks are filled from IAFD for performers
    and the ThePornDB mirror for studios, each marked with a small chip.
  - One button writes only the gaps back to Stash.
  - You can swap the photo or logo for your own.
- **Categories** are shelves you arrange yourself. Each has a cover, a blurb,
  scenes you hand-pick, and a rule that keeps adding new scenes as they arrive.
  A **filmography** category tracks a director's work across whole studio
  networks, owned or missing, with a *Send to Whisparr* on each missing tile.
- **Movies** covers full-length features on your share, read from Emby's .nfo
  files. A gap-filler finds the films Emby never matched and writes their .nfo
  and poster, never overwriting.
- **Galleries** are Stash galleries.
  - Build one from pictures found on the web: find, choose, write.
  - Crop the cover, tie the gallery to its scene, performer and studio, and
    rate it.
  - A *No pictures yet* row lists the people you have films of but no photos of.

### Stats — how the collection is doing

![Stats](docs/screenshots/stats.jpg)

- **The pipeline** as one bar, left to right in the order files move:
  downloaded, editing, encoding, filed, films.
- **Small charts that each answer one question**: how much you added this
  month, how much is 1080p or better, how much you've actually watched, how much
  is identified and against which box, and which years you cover.
- **Tidying Whisparr up** behind the pipeline. Once a scene is filed in Stash,
  Whisparr holding it is leftover. Stats finds those and unmonitors them. In
  Whisparr v3 it can also delete them after a fortnight.

### Find — what you're missing

![Find overview](docs/screenshots/find-overview.jpg)

- **Overview**: what you collect, as one percentage across every catalogue you
  track, followed by suggestions drawn from your own favourites on StashDB.
- **Video**: search StashDB for scenes and send them to Whisparr v3. It also
  covers ThePornDB for Whisparr v2.
  - An **Indexers** band hand-searches Prowlarr for scenes neither catalogue
    knows. Usenet grabs go to NZBGet and are dropped into your import folder
    automatically.
  - A **Monitored** tab lists everything either Whisparr still wants with no
    file.
- **Tracked**: follow a studio, performer or tag and see how much of it you
  hold.
  - Deciding is a queue, not pages. Each card gets **Want**, **Skip** or
    **Have**, and the next batch loads itself.
  - Rules skip the obvious no's, and your own library puts the likely yeses
    first.
- **Images**: pick a performer (the name is taken from StashDB) and get gallery
  pages to look through.
- **Integrations**: every service the portal talks to, whether it answered, and
  the dated backups of the portal's own state.

### Catalogue — fixing the records

![Match](docs/screenshots/catalogue-match.jpg)

- **Overview**: the piles of work. That's scenes with no stash id, no cover, not
  organised or no markers, broken down by folder.
- **Match** works through the piles.
  - One find asks **every** stash-box and scene scraper at once, through the
    same call Stash's own Identify makes. Each source keeps its own band and
    nothing is merged.
  - Tick several at once to file a StashDB id and a ThePornDB id together.
  - Fingerprint-exact hits arrive pre-ticked. The picture pass also ticks
    candidates whose artwork matches the scene's frames.
  - An inline index sheet lays the scene's own frames above every candidate at
    one size, with a similarity score. You can cut more frames if the first
    ones show nothing useful.
  - Scenes with no cover get a frame cut for them so you can recognise them,
    and it's never written back to Stash.
- **Wild Card** is for scenes no fingerprint knows, like DVD rips.
  - Hand it URLs and keywords, and Stash's own installed scrapers read each one.
  - Every answer comes back as a *contribution*. You build the record field by
    field, choosing which source wins each field.
- **Group Builder** finds films your loose scenes already add up to, using
  ThePornDB's scene lists, DVD pages and IAFD breakdowns. It shows the evidence
  for each and builds the group only when you say yes.
- **Marker Builder** is a bench for cutting markers by hand, shaped like
  LosslessCut.
  - **The playhead stays still and the strip moves under it.** The strip is
    Stash's sprite sheet laid along time: one image request, dragged as fast as
    you like, and the video only seeks where you let go.
  - **Drill down instead of scrubbing.** *Frames* (`g`) lays the whole scene out
    a frame every 30 seconds. Click one and that stretch opens at ten times the
    detail: 30s, then 3s, then 1s. Three clicks take you from the whole scene to
    the exact second.
  - **Sharpen strip adds detail to the sprite.** Stash cuts about 81 sprite
    tiles per scene whatever its length, which is one every 17 seconds on a
    23-minute scene. Sharpen cuts the scene its own sheet at one picture a
    second, straight from the source file, so the strip is a real ruler and the
    drill-down goes all the way to one second.
  - **Keys are the interface**: `t` point, `i`/`o` in and out, arrows to step
    (`shift` ×10, `alt` a tenth), `+`/`−` zoom. Tagging is a palette with your
    most-used tags first.
  - **Phone-friendly too**: every key has a button, pinch zooms the strip, and
    the tag prompt becomes a bottom sheet.
  - A **fetch panel** pulls markers from timestamp.trade and ThePornDB for you
    to check before anything lands.
  - New markers get their own **720p clip** for the Feed, cut from the source.

### Manage — settings and long jobs

![Manage › Stash](docs/screenshots/manage-stash.jpg)

- **Connections** for Stash, both Whisparrs, Prowlarr, NZBGet and FileFlows.
  StashDB and ThePornDB tokens are borrowed from Stash, never stored twice.
- **Stash jobs**, each with its plan shown before anything runs:
  - scan for new files
  - walk the organised folder
  - generate the missing fingerprints, previews and sprites
  - rename and reorganise to `Studio/date.Title`
  - write `.nfo` files and thumbnails beside each video for Emby and Kodi
- **Catch up** fills blanks on scenes that already have a stash id: facts from
  StashDB, then ThePornDB; markers from timestamp.trade, then ThePornDB. It
  reads by id, never guesses by title, and never overwrites.
- **Feed**, **Galleries**, **Catalog** and **Sending** hold each section's own
  settings.

<details>
<summary><b>Every screenshot</b></summary>

Pictures are blurred on purpose — this is an adult library.

#### Library

**Overview — the Feed up top, then news and continue watching**

![Library — Overview — news, continue watching](docs/screenshots/library-overview.jpg)

**Scenes shelf**

![Library — Scenes shelf](docs/screenshots/library-scenes.jpg)

**Performers**

![Library — Performers](docs/screenshots/library-performers.jpg)

**Studios**

![Library — Studios](docs/screenshots/library-studios.jpg)

**Movies**

![Library — Movies](docs/screenshots/library-movies.jpg)

**Galleries**

![Library — Galleries](docs/screenshots/library-galleries.jpg)

**Categories**

![Library — Categories](docs/screenshots/library-categories.jpg)

#### Stats

**The pipeline and the library in numbers**

![Stats — The pipeline and the library in numbers](docs/screenshots/stats.jpg)

#### Find

**What you are collecting**

![Find — What you are collecting](docs/screenshots/find-overview.jpg)

**StashDB search**

![Find — StashDB search](docs/screenshots/find-video.jpg)

**Tracked catalogues**

![Find — Tracked catalogues](docs/screenshots/find-tracked.jpg)

**Image search**

![Find — Image search](docs/screenshots/find-images.jpg)

**Integrations and backups**

![Find — Integrations and backups](docs/screenshots/find-integrations.jpg)

#### Catalogue

**The piles**

![Catalogue — The piles](docs/screenshots/catalogue-overview.jpg)

**Match**

![Catalogue — Match](docs/screenshots/catalogue-match.jpg)

**Wild Card**

![Catalogue — Wild Card](docs/screenshots/catalogue-wildcard.jpg)

**Group Builder**

![Catalogue — Group Builder](docs/screenshots/catalogue-groups.jpg)

**Marker Builder**

![Catalogue — Marker Builder](docs/screenshots/catalogue-markers.jpg)

#### Manage

**Connections**

![Manage — Connections](docs/screenshots/manage-connections.jpg)

**Stash jobs**

![Manage — Stash jobs](docs/screenshots/manage-stash.jpg)


The rest of this file documents the userscript; the portal has its
[own README](portal/README.md).

</details>

## Why this exists

Whisparr v3 (Eros) gets its **scene** metadata from StashDB and will not accept
anything else — the foreign id is the primary key and a bypass was asked for and
declined in [Whisparr#515](https://github.com/Whisparr/Whisparr/issues/515). v3
*does* use ThePornDB, but only for its Movies section
([#805](https://github.com/Whisparr/Whisparr/issues/805), landed Dec 2025).

So TPDB scenes mean Whisparr **v2**, run alongside v3. v2 is alive — the
`v2-develop` branch is still getting .NET bumps and Sonarr upstream syncs.

## How it works

v2 is a Sonarr fork, so the shapes are:

| TPDB | Whisparr v2 |
|---|---|
| site | series (`series.tvdbId` = TPDB site id) |
| scene | episode (`episode.tvdbId` = TPDB scene id) |

On a scene page the script:

1. reads the scene slug from the URL and the site slug from the page's links
2. `api.whisparr.com/v3/site/search?q=<site>` → TPDB site id
3. `GET /api/v3/series?tvdbId=<siteId>` → is the site already added?
   `GET /api/v3/series/lookup?term=tpdb:<siteId>` → `POST /api/v3/series` if not
4. `api.whisparr.com/v3/site/<siteId>` → scene slug → TPDB scene id
5. `GET /api/v3/episode?seriesId=<id>` → match on `tvdbId`
6. `PUT /api/v3/episode/monitor` → `POST /api/v3/command {name:"EpisodeSearch"}`

Sites are added with `addOptions.monitor = none` and `monitorNewItems = none`,
so **nothing is grabbed except the scenes you click**. Adding a site does not
start a 600-scene download. The script never writes to TPDB.

## Stash: "do I already have this?"

Optional. Give the script your Stash URL and API key and each scene page also
shows whether the scene is already in your library, before you add it to
Whisparr.

Two ways it matches, in order:

1. **Exact — TPDB stash id.** ThePornDB runs a stash-box endpoint
   (`https://theporndb.net/graphql`). Any scene you have identified against it
   carries the TPDB scene UUID as a `stash_id`, and that UUID is the same
   `ForeignGuid` the Whisparr metadata service returns. So the script asks Stash
   for a scene with that exact stash id. Green pill: **In Stash**.
2. **Probable — title + release date.** If there's no TPDB stash-box endpoint
   configured in Stash, or the scene was never identified against it, the script
   falls back to an exact title + date match. Orange pill: **Probably in Stash**,
   with the matched file path in the tooltip so you can eyeball it.

Click the pill to open the scene in Stash.

The script finds your TPDB endpoint by reading Stash's own stash-box config — it
doesn't need to be told which one it is. Hit **Connect** in settings and it says
which of the two modes you're in.

To get exact matching: Stash → Settings → Metadata Providers → Stash-Box
Endpoints, add `https://theporndb.net/graphql` with a token from
theporndb.net/user/api-tokens, then identify your library against it.

## Install

1. Tampermonkey or Violentmonkey.
2. Open `tpdbarr.user.js` from the extension's dashboard (Utilities → import, or
   drag the file onto the browser).
3. Load any theporndb.net scene page. Click **Set up tpdbarr** bottom-right, or
   use the Tampermonkey menu → *tpdbarr settings*.
4. Enter your Whisparr **v2** URL and API key (Settings → General → API Key),
   and optionally your Stash URL and API key. Hit **Connect** — it fills in
   quality profiles and root folders from your instance and reports what it
   found — then **Save**.

The settings panel warns you if the URL points at a v3 instance.

## The button

| Colour | Meaning |
|---|---|
| purple | not in Whisparr — click to add |
| blue | monitored, searching or waiting |
| green | downloaded |
| red | failed — hover for the reason, click to retry |

And the Stash pill above it, if Stash is configured:

| Colour | Meaning |
|---|---|
| green | in Stash (matched on TPDB stash id) |
| orange | probably in Stash (matched on title + date) |
| grey | not in Stash |
| dark red | Stash unreachable — hover for why |

## Running v2 alongside v3

Different ports and, importantly, different root folders so the two instances
never fight over the same file.

```yaml
services:
  whisparr-v3:            # StashDB scenes + TPDB movies
    image: ghcr.io/hotio/whisparr:v3
    container_name: whisparr-v3
    ports: ["6969:6969"]
    volumes:
      - ./config/whisparr-v3:/config
      - /data/adult/stashdb:/data
    restart: unless-stopped

  whisparr-v2:            # TPDB scenes
    image: ghcr.io/hotio/whisparr:v2
    container_name: whisparr-v2
    ports: ["6970:6969"]
    volumes:
      - ./config/whisparr-v2:/config
      - /data/adult/tpdb:/data
    restart: unless-stopped
```

Point both at the same Prowlarr and the same download client; give each its own
category so the queues stay separate. Then tpdbarr talks to `:6970` and stasharr
talks to `:6969`.

## Known rough edges

- **Site detection is the fragile part.** The script reads `/sites/<slug>` links
  off the scene page and tries each until one has the scene in its catalogue, so
  a stray nav link is handled — but a TPDB redesign that drops the site link
  entirely would break it. That logic is all in `candidateSiteSlugs()`.
- **First add on a new site is slow.** Whisparr pulls the whole catalogue before
  the episode exists; the script polls for up to ~24s.
- **Scene catalogues are cached for 6h** per site in script storage.
- Scene pages only. No bulk "add all on this page" yet, and no site pages.
- The Stash check assumes TPDB's stash-box ids are the same UUIDs the Whisparr
  metadata service reports as `ForeignGuid`. If exact matching never fires but
  title+date consistently does, that assumption is wrong — say so and it can
  match on phash instead (needs a TPDB API token).
