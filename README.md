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

## Screenshots

Pictures are blurred on purpose — this is an adult library.

### Library

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

### Stats

**The pipeline and the library in numbers**

![Stats — The pipeline and the library in numbers](docs/screenshots/stats.jpg)

### Find

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

### Catalogue

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

### Manage

**Connections**

![Manage — Connections](docs/screenshots/manage-connections.jpg)

**Stash jobs**

![Manage — Stash jobs](docs/screenshots/manage-stash.jpg)


The rest of this file documents the userscript; the portal has its
[own README](portal/README.md).

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
