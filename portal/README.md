# tpdbarr portal

A self-hosted console for browsing ThePornDB, sending scenes to Whisparr v2, and
checking what you already have in Stash. Same idea as
[stasharr-portal](https://github.com/enymawse/stasharr-portal), pointed at the
other half of the stack: TPDB instead of StashDB, Whisparr v2 instead of v3.

No browser extension, no userscript, no TPDB account.

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

## Run it

```bash
cp .env.example .env    # then set your NAS, SMB login and host paths
docker compose up -d
```

Then open <http://localhost:6980> and fill in Settings.

The compose file mounts the folders Stash and Whisparr use, at the paths Stash
reports for them — every host path comes from `.env`. Drop any mount for a
feature you don't use. A Whisparr v2 service is included, commented out, if you
don't already run one. Nothing else is needed: no database, no external
services, and the image has **zero npm dependencies** (it's Node stdlib only, so
it builds in about a second and there's no lockfile to keep fresh).

### Configuration

Everything is set in the UI and stored in `/config/config.json`. Nothing is
passed as an environment variable except:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `6980` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `CONFIG_DIR` | `/config` | where `config.json` lives |

Hit **Test connections** in Settings and it reports what it found — Whisparr
version (warning you if it isn't a v2), Stash version, and whether Stash has a
TPDB stash-box endpoint configured.

## Screenshots

Pictures are blurred on purpose — this is an adult library.

### Library

**Overview — the Feed up top, then news and continue watching**

![Library — Overview — news, continue watching](../docs/screenshots/library-overview.jpg)

**Scenes shelf**

![Library — Scenes shelf](../docs/screenshots/library-scenes.jpg)

**Performers**

![Library — Performers](../docs/screenshots/library-performers.jpg)

**Studios**

![Library — Studios](../docs/screenshots/library-studios.jpg)

**Movies**

![Library — Movies](../docs/screenshots/library-movies.jpg)

**Galleries**

![Library — Galleries](../docs/screenshots/library-galleries.jpg)

**Categories**

![Library — Categories](../docs/screenshots/library-categories.jpg)

### Stats

**The pipeline and the library in numbers**

![Stats — The pipeline and the library in numbers](../docs/screenshots/stats.jpg)

### Find

**What you are collecting**

![Find — What you are collecting](../docs/screenshots/find-overview.jpg)

**StashDB search**

![Find — StashDB search](../docs/screenshots/find-video.jpg)

**Tracked catalogues**

![Find — Tracked catalogues](../docs/screenshots/find-tracked.jpg)

**Image search**

![Find — Image search](../docs/screenshots/find-images.jpg)

**Integrations and backups**

![Find — Integrations and backups](../docs/screenshots/find-integrations.jpg)

### Catalogue

**The piles**

![Catalogue — The piles](../docs/screenshots/catalogue-overview.jpg)

**Match**

![Catalogue — Match](../docs/screenshots/catalogue-match.jpg)

**Wild Card**

![Catalogue — Wild Card](../docs/screenshots/catalogue-wildcard.jpg)

**Group Builder**

![Catalogue — Group Builder](../docs/screenshots/catalogue-groups.jpg)

**Marker Builder**

![Catalogue — Marker Builder](../docs/screenshots/catalogue-markers.jpg)

### Manage

**Connections**

![Manage — Connections](../docs/screenshots/manage-connections.jpg)

**Stash jobs**

![Manage — Stash jobs](../docs/screenshots/manage-stash.jpg)


## The three sections

The acquisition side is a strip of three, not three more entries in the top
nav — Library and Queue are other places you go, whereas these are three views
of one question.

| Section | What it is |
|---|---|
| **Scenes** | the five-band console below. `#/acquire` |
| **Movies** | ThePornDB's newest movie releases, poster side out. `#/acquire/movies` |
| **Creators** | the cast of your own library, from Stash. `#/acquire/creators` |

### Movies

There is no Add on the movies grid, and that is not an oversight: Whisparr v2
is Sonarr with sites as series, and has no movie to add one to. Opening a movie
lists the scenes inside it — those are ordinary TPDB scenes and add exactly
like any other, one at a time or all the ones you do not have.

"Do I already have this?" is answered twice, at different strengths. On the
grid it is a Stash **group**, and a group carries no stash id and no
fingerprints — the field does not exist on the type — so the only thing left to
match on is the name, and the badge says *Probably* because that is all it
knows. On the movie page it is scene by scene, matched on stash id and then on
fingerprint like everything else, and that is the number worth trusting.

A movie's only portrait art is the studio's own box art. TPDB's `poster` and
`posters` fields both hand back the landscape background again — byte for byte
the same URLs — so a release with no box art gets that landscape cropped into
the poster frame.

### Creators

Everyone in your library that ThePornDB also knows, which is Stash performers
carrying a TPDB id — the rest are left out because a click would have nowhere
to go, as are performers with nothing attached, since "0 in your library" is
not a creator in your library. Clicking one lands on the existing performer
page, where what they have been in and what you are missing of it already
lives. Filtering hides rather than rebuilds, so the portraits are not
re-fetched on every keystroke.

## The scenes console

Five bands, in the order the questions actually get asked.

| Band | What's in it |
|---|---|
| **Needs you** | the queue, anything stalled, scenes wanted for over 30 days with still no file, and what lands next |
| **Since your last visit** | releases from your sites and your performers dated after the last time the page was built |
| **Site coverage** | how much of each catalogue you already hold, counted in Stash |
| **Your performers** | newest scenes, grouped under the performer who caused them |
| **New from studios** | the global TPDB feed, clip sites removed |

Cards show *Monitored* / *Downloaded* when Whisparr has the scene, *In Stash* /
*Probably* when you already own it, and *Upcoming* for scenes dated in the
future — TPDB lists scheduled releases, which is useful and would otherwise look
like a bug. Every card carries **Add**; clicking the card itself still opens the
site, because a whole-card click that quietly fires a search is a click nobody
meant to make.

Built in the background and cached for 30 minutes; **Refresh** forces a rebuild.
The queue is read live on every load instead, because a queue half an hour out
of date is worse than no queue at all.

### "Since your last visit" needs a watermark

An absolute date sort is the same three rows you already scrolled past this
morning, so the page keeps a `lastSeenAt` in `config.json`. It is compared
against the value from *before* the build and advanced afterwards, which means a
second rebuild on the same day finds nothing new — so the band falls back to
**Latest from your sites** and says which date it was comparing against, rather
than rendering an empty row.

### Site coverage counts Stash, not Whisparr

Whisparr is a downloader. In a normal setup a scene is grabbed, encoded and
moved by something like FileFlows, imported into Stash, and Whisparr is then
told to delete it and never fetch it again. So `hasFile` is true only for the
hours a scene is in flight, and a Whisparr that holds nothing is the *expected*
end state, not an empty one.

Coverage therefore counts what **Stash** holds: the catalogue comes from the
metadata mirror (one request, cached 6h) and is matched against Stash in
batches of 250. Whisparr is still consulted so that scenes in flight and scenes
already monitored are not reported back to you as a gap.

The one-click **Add the N** only appears when 20 or fewer scenes are missing.
Anything larger says *open to pick* and takes you to the site, where the **Not
had** filter does the same job deliberately — six hundred scenes behind a single
button is not a shortcut.

Cost grows with the number of sites you track, not the size of your library, and
is capped at 12 sites per build.

Fingerprint hits are folded in too, but only from the artwork cache — coverage
never starts a pull of its own. So a site you have never opened reports the
stash-id and title+date matches alone, and the number rises to agree with the
site page once you have been there.

## The Overview is a pipeline, not a pile

Every file here is somewhere in a queue, and until 2026-09-01 the app pretended
otherwise: "in your library" meant `/organized_scenes` and nothing else, which
hid 1080 scenes from every count in the app and reported a file that was simply
mid-encode as something you did not own.

**Everything Stash holds is yours.** The folder is a *status*:

| Stage | Where | What it means |
|---|---|---|
| **Downloaded** | Whisparr's own root | grabbed, and Stash has no record of it at all |
| **Editing** | `/pc-import` | yours, being cut by hand before it goes on |
| **Encoding** | `/Import Folder` | yours, waiting on FileFlows |
| **Filed** | `/organized_scenes` | done |
| **Films** | `/movies` | full-length features — never grabbed by Whisparr, scanned off the share like every other root |

The bar at the top of the Overview is those five, proportional and in the order
a file actually moves, so its shape is the state of the pipeline: a fat middle
is a backlog at the encoder, a fat left end is a big grab that has not been
through yet. Each segment opens that stage.

The first stage is the only one Stash cannot see — there is no library path
covering Whisparr's download folder — so it is counted on the Whisparr side and
arrives a moment after the rest of the page.

A scene appearing under two roots is counted once, at the **furthest along** of
them: it has already moved, the old copy just has not been swept up.

### What a tile says

Bottom left of every scene tile: the resolution, then where the scene stands.

| Status | When |
|---|---|
| **Waiting to import** | the file is in `/Import Folder` (waiting on FileFlows) or `/pc-import` (yours to cut and match first) |
| **Needs organizing** | filed in `/organized_scenes`, not yet ticked organised in Stash |
| **Filed** | filed in `/organized_scenes` and organised |

Films in `/movies` show the resolution and no status.

Both badges share one colour, which compares the file against its **target
resolution**:

| Colour | Means |
|---|---|
| **Red** | bigger than the target, so an encode is still owed |
| **Yellow** | at or under the target, but not finished |
| **Green** | at or under the target, filed and organised (an organised film counts) |

The target is **720p**, which is what FileFlows turns a filed scene into, unless
the scene page chose otherwise:
- **1080p or 480p** is the target when that was chosen.
- **Keep** makes the file as it is the target.
- **Films** always count as at target, because FileFlows never touches `/movies`.

A filed scene's choice is its `.fileflows-ignore` flag. The portal checks for
those flags when it reads the shelf, which takes about a second and a half for
four thousand folders, then keeps the result for ten minutes.

### The cards are charts, not scoreboards

Five small charts, each with the sentence it is evidence for, all tallied in a
single pass over the shelf that the counts were already making — the image has
no npm dependencies and is not about to grow one to draw a bar.

- **Growing** — scenes added per month. Bars rather than a line, because these
  are discrete monthly totals and a line between them would draw a rate through
  the middle of a month that nobody measured. Months before the library existed
  are trimmed; quiet months *inside* the run are kept, because they are real.
- **Quality** — 4K / HD / SD. The tallest file wins on a scene holding both a
  master and a proxy, so this is the best copy held, not the average.
- **Watched** — the one metric about you rather than about the files.
- **Identified** — which stash-box each scene is matched against. Not trivia:
  identity is the join every other feature runs on, and the unidentified slice
  is exactly the set none of them can reach.
- **Years covered** — an area, because unlike the monthly chart this is a
  continuous run and the long thin tail is the point.

## Tidying Whisparr up behind the pipeline

Whisparr is a downloader. Once a scene is encoded, filed and in Stash, Whisparr
holding it is residue: it will never be searched for again, it still counts
against every "wanted" number, and it still has a file on the disk it grabbed
to. Measured on 2026-09-01, v3 held 539 movies with **all 539 monitored** and
nothing ever unmonitored.

The panel at the foot of the Overview is two buttons, never one, because they
are different promises.

**Unmonitor** everything Stash has filed. Reversible in Whisparr's own UI, so it
asks nothing first.

**Remove** what has been unmonitored for fifteen days — deletes the files
Whisparr grabbed and writes an import exclusion so it is not fetched again. It
asks first, and it only ever touches something Stash is holding a copy of; an
unmonitored movie Stash has no record of was cancelled or given up on, and
deleting its file would throw away the only copy.

The gap between the two is the point. Unmonitoring is a claim that the file
landed; the fortnight is time for that claim to be wrong out loud — a bad
encode, a re-scan, a file moved back — before the original goes.

### Neither Whisparr records *when* it unmonitored something

There is no such field on a movie or an episode, so the fortnight is timed here,
in `config/unmonitored.json`. The clock starts on **first sight**: every survey
stamps anything it finds unmonitored and has not seen that way before.

That is not a detail. v3 is set to
`autoUnmonitorPreviouslyDownloadedMovies = true`, so when FileFlows moves a file
out from under it, v3 notices the file has gone and unmonitors the movie itself
— most of what ages here will have been unmonitored by Whisparr rather than by
this portal. v2 has the same setting turned off and never does it.

Timing from first sight also means a lost watermark file only ever makes the
wait longer, never shorter, which is the right direction for the one operation
here that deletes.

### v2 stops at unmonitored, and that is a constraint

v2 is a Sonarr fork: an episode cannot be deleted, only a whole series or an
episode's file. Deleting the series would take its entire catalogue with it —
15,836 episodes for Playboy Plus alone — and mean re-pulling all of it to add
one scene from that site again. So removal is v3 only.

v2 also has **no exact join to Stash**. Its `episode.tvdbId` is TPDB's *numeric*
scene id while Stash stores TPDB's *UUID*, and nothing in either system
translates between them, so the v2 side is matched on title and date. v3 indexes
on the StashDB scene UUID and so does Stash — 884 of 984 filed scenes carry one
— with title and date as the fallback for the rest.

## Filtering the library shelf

**One bar, four shelves** — Scenes, Performers, Studios and Galleries. They
all ask the same kind of question of what you hold, so they ask it with one
piece of furniture rather than four that drift apart: search, a few
dropdowns, a sort, **Clear** and **Random**. The Movies page has its own,
older and film-shaped; this is the same bar wearing the same clothes.

**Every dropdown is built from what is on the shelf and says how much**, e.g.
`Pure Taboo (165)`. Nothing Stash knows about but you hold no file for is
offered, so no choice comes back empty. Each one counts against every filter
*but its own*, so its numbers say what picking it would give you: choose a
studio and the kind list narrows to that studio's kinds while the studio list
stays whole, ready to be changed.

| | narrowed by | ordered by |
| --- | --- | --- |
| **Scenes** | kind, studio, performer, tag, year | recently added, newest, title, longest, most in that studio |
| **Performers** | gender, country, studio, kind, year, tracked | most scenes, name, newest |
| **Studios** | performer, kind, year, tracked | most scenes, name, newest |
| **Galleries** | filed, studio, performer, year | newest, title, most pictures |

**Scenes opens on Recently Added**, which is the shelf's own order: nine times
in ten what you want off that page is what landed since you last looked, not
what a studio happened to release first. *Newest* is still there for release
date — a back catalogue imported last night is old by date and the newest thing
you own by when it arrived.

**Scenes is two shelves, switched under its heading.** *In your library* is the
page. *Monitored, not here* is the same question turned round: everything you
marked **Want** that has not arrived, drawn as cards with **Skip** / **Wanted** /
**Add** on them, paged 120 at a time like the shelf beside it. It used to lead
the page as a rail, which put a handful of cards above the whole library every
time you opened it; as a second view it is out of the way until you ask for it
and gets the whole page rather than a row you scroll sideways. The held shelf's
bar, wall and *Show more* are hidden rather than rebuilt when you switch, so a
filter you set survives a look at the want list.

**A tile carries what it is about**, two clamped lines under the studio and the
date, in the same words and cut by the same rule as the StashDB card — 140
characters rather than 160, because a tile is narrower. The hover title stays
the cast: a tile you are pointing at is one you are trying to recognise. Where
there is a description the title holds two lines whether it needs them or not,
so a row of tiles starts its blurb on the same line; rails without one keep the
height they had.

**Cut on the server, not in the browser.** The shelf read is the whole library
in one go and a Stash description runs to paragraphs, so `card()` in
`stashlib.mjs` trims to 200 characters on the way out. 2,749 of 3,236 scenes
have one; the read is 2.1 MB.

**The film wall carries it too** — `filmCard`, off `/api/library/films`, where a
group's is Stash's `synopsis` and a feature's is the scene's own `details`. Cut
at the same 140 characters, because the posters sit in the same size grid. No
trim on the way out of the server there: 127 films is not 3,236 scenes. On a
poster this narrow the meta line wraps to two — year, studio, runtime and a
scene count do not fit on one — so where a blurb follows it the meta holds both
lines whether it needs them or not, and a row starts its prose together. 112 of
the 127 have something to say.

On Scenes, **resolution and watched-state are deliberately not there**: at this
size they are noise, and the tile already shows both. What a *person* or a
studio can be narrowed by comes from the scenes you hold rather than from their
Stash record — the studios they actually turn up on, the years, the kinds —
for the same reason the rest of this half counts Stash rather than Whisparr.

### Four words, everywhere

The three answers a scene can be given, and the one state it can be in, are the
same words on every page in the portal:

| Word | Means |
|---|---|
| **Want** | I want this. Marks it; fetches nothing — **Add** is the sentence that fetches. |
| **Skip** | Not for me. Leaves the results and leaves the percentage, in neither half of the fraction. |
| **Have** | It is in Stash. Counts as decided without anyone pressing anything. |
| **Still to decide** | What is left. Not a state you set — what nobody has answered for yet. |

"Not had" is gone; it meant "in neither Whisparr nor Stash" and said so to
nobody. It is **Do not have** now. **Monitored** and **Downloaded** stay as they
are, because those are Whisparr's words about Whisparr's own state rather than
anything you decided.

### Deciding is a queue, not pages

Working through a catalogue has no page numbers, and could not have them
honestly. StashDB counts the whole catalogue; what reaches the screen is what
survives once the skipped, the held and the already-wanted come out. So a page
number pointed at a list that did not exist: page four of six hundred could hold
nothing at all, emptying a page left the empty page behind, the heading counted
something other than the cards under it, and every answer reshuffled which
survivors landed on which page — so a scene you were looking at moved, and
coming back after a few decisions could not find it.

**Still to decide** is one queue instead. Answer a card and it goes; the count
above it comes down; when the batch on screen runs out the next one loads
itself. The server walks StashDB from a cursor rather than a page number, up to
eight pages a request, and hands back where it got to — so an empty batch is
progress through a stretch you had already answered for, and only a null cursor
means the end of the catalogue. Measured on MissaX, which had 2 undecided out of
588: both found in the first request, the end reached four requests later.

The heading carries two numbers because they are two different numbers — *106
still to decide* is the job, *17 on screen* is the batch. On an ordinary search
the same rule holds: the heading is StashDB's count for the search, and the line
under it is what is actually on the page after the skipped and the held come
out, which moves when you move it.

**Tracked or not** is the one lens that is not about what you hold. It is on
Performers and Studios and not on Scenes, because tracking is a thing you do to
a catalogue and a scene is not one. The tiles say it too: a tracked performer
or studio carries an amber **percentage** in the corner of its picture and
everything else carries nothing — a badge on every tile is a badge on none of
them. The number is the same one the bar on their own page shows, read once for
the whole wall from `/api/acquire/tracked` rather than per tile, and matched on
the StashDB id, which is the only id the library and the catalogue share. A
tracked thing with nothing decided yet shows **—** rather than 0%, for the
reason the bar gives: nought per cent reads as "you have none of this" when you
may have all of it.

Three of those needed a definition:

- **Kind** is not a field Stash has. It is read off the tags, first match wins,
  in the order Solo, Lesbian, Group, Threesome, Couple. Well over half the
  library matches none of them, so **Not said** is one of the choices rather
  than a silent gap — 584 of 1036 the day this was built.
- **Most in that studio** sorts by how much of that studio is on the shelf, so
  the sites you have collected most of come first and their scenes arrive
  together. Counted over what is showing, not the whole library.
- **Random** is a sort like the others: it survives narrowing the shelf, and it
  is in the address so coming back keeps you in a shuffle — but not the same
  shuffle. The order is thrown, not stored, and pressing the button again
  throws again.

The filters live in the address (`#/library/scenes?kind=Lesbian&studio=…`), so
opening a scene and coming back lands on the shelf you had. Changing one
rewrites the address without navigating — a hashchange would rebuild the page
on every keystroke. Clicking the section in the strip is what clears it, the
same as the button — which is always on screen and greyed when there is
nothing to clear, since a button that comes and goes moves everything
beside it.

All three run off one read of the whole library — `/api/library/shelf`, every
scene with its tags, cached five minutes on the server and five in the page —
because a bar built from the first sixty scenes would offer the wrong studios
and lie about the counts. The filtering itself never leaves the browser. A gallery has no tags and no runtime, so it has no kind and no longest —
what it has instead is how many pictures are in it. Each
wall draws 120 at a time with a **Show more** underneath, and the row of names
Stash knows about but you hold nothing of stays below, unfiltered: it is a
different question.

## Marker Builder

Markers are moments inside a scene, and until now nothing in the portal made
one. They arrived from two Stash plugins run by hand — timestampTrade first,
TPDBMarkers second and only into scenes that have none — which is fine for a
scene a scraper has heard of and no use at all for one it has not.

`#/import/markers` is a bench for cutting them by hand, and it is shaped like
LosslessCut on purpose, because that is what the video already gets cut with.

**Two states behind one address.** No `scene` in the query and it is the
queue; pick a scene and the same address becomes the bench.

### The queue is the library's own shelf

It used to be a list of rows with a search box and three chips over it, and
every one of those went back to the server. That is the right shape for a
backlog you work top-down and the wrong one for the question this page is
actually asked — *which scenes of this studio, or this performer, or this tag,
have nothing marked* — because a server answering sixty rows at a time cannot
count what is behind a dropdown or reorder anything but the page in front of
you.

So it is `shelfPage` now, the same one Library > Scenes is built from: the same
filter bar, the same facets counting themselves as you narrow, the same sorts,
the same wall of tiles, the same *Show more*, the same tile-size control.
Whatever that page learns, this learns. The three chips became a sixth facet —
**Marked or not** — which is the one real change in meaning: you can hold a
studio and swap between its marked and unmarked scenes without either going
back to the server.

Unmarked is still what you land on, seeded into the address when it says
nothing, because a backlog is what the page is for.

**It costs one small request.** The scenes are already in the page — the shelf
memo the library filled, or fills on the way in — so all `/api/import/markers/queue`
sends is which of them the bench will accept and which are done: two lists of
ids, 24 KB for 2,811 filed and 451 marked, answered in about a second. The
marked half carries a count as well as an id, because *has markers* and *has
eleven markers* are different answers to whether a scene still needs work; it
shows on the tile as a green `11 ✓` beside the resolution. Only the marked
scenes are asked for their markers — asking all 2,811 for a list most of them
have none of is the same query an order of magnitude more expensive.

**The shelf you narrowed survives the bench.** The filters live in the address,
which the bench then replaces with its own `scene=`, so the way out remembers
what was there and hands it back. Marking one scene of a studio's backlog
should not throw the backlog away.

**Only `/organized_scenes`.** Marking is work you do once and keep, and it is
only worth doing on a file that has stopped moving — everything upstream is
still going through FileFlows, which re-encodes it and moves it, so the file
the marks were placed against is not the file that comes out. That is narrower
than the shared `FILED` scope, which is organized_scenes *or* `/movies`: films
are Emby's and are not what this bench is for. It measured 996 filed scenes on
2026-09-05, 764 of them with nothing marked — against 2,061 unmarked when the
page was briefly pointed at the whole of Stash. *Everything* means every filed
scene, not every scene in Stash.

The scope is written out in full in `markerbuilder.mjs` rather than inherited
from `inLibrary`, which is empty today: inheriting it would silently widen this
page back out the day somebody fills it in.

**The bench applies the same rule to the one scene an address asks for**, so it
is not only what the queue offers. Open `?scene=` on something still in
`/pc-import`, `/Import Folder` or `/movies` and it refuses with a 400 saying
why, and a way back to the queue — because a page that opened anyway would let
you mark a file FileFlows is about to replace. A scene id Stash has never heard
of is a 404. Neither is logged as a fault; both are answers.

**The keys are the interface.**

| | |
| --- | --- |
| `t` | drop a point marker where the playhead is |
| `i` / `o` | open a span and close it |
| `←` `→` | 1 second, `shift` 10, `alt` a tenth |
| `space` | play and pause |
| `+` `−` | zoom the timeline; `ctrl` and the wheel does it too |
| `Esc` | drop the in point you have not closed yet |

Every one of `t` and `o` ends in the same question — what is this — and nothing
is written to Stash until it is answered. The answer is a keystroke on a preset
or a name typed out: **Kissing, Orgasm and Undressing are pinned first**, then
whatever the library actually puts on markers, most-used first. Type and the
list filters; type something that is not in it and the last option offers to
create it. Creating is never the highlighted one, because the whole point of
the palette is that the answer is usually already in it.

That is the opposite rule to the batch tagger on Match & Sort, which refuses to
create tags at all — a page that lets you type into a *batch* write is a page
that grows a second tag called "Anal " with a trailing space. This page was
asked for the other thing, so it creates, and pays for it with the two guards
that make the refusal unnecessary: the name is squeezed to single spaces and
trimmed, and an existing tag is matched case-insensitively first, so "kissing"
typed in a hurry finds Kissing.

### The playhead does not move

The strip moves under it. That is how the cutting apps do it and the reason is
not taste: a playhead that travels means the thing you are aiming at is
somewhere different every time, and placing an out point accurately is aiming.

The filmstrip is the sprite sheet Stash already generated for the scrub bar,
cut into tiles and laid along time — one image request, made once, however long
the scene is. So the timeline can be dragged fast and far without asking the
video for anything, and the video only has to catch up to where it was let go
of. Tiles are drawn at their own shape scaled to the strip rather than
stretched to the zoom, so a strip zoomed in past the sheet's density repeats a
frame rather than smearing it; Stash cuts about 81 tiles per scene whatever its
length, which here is one every 17 seconds.

Only the slots the window can see are drawn. At the closest zoom a two-hour
scene is a strip nine hundred thousand pixels wide, and the same dozen nodes
are moved and re-cropped as time passes under them.

**One seek is in flight at a time.** Holding an arrow key down produces sixty
seek requests a second against a proxied stream, and a browser given those
serves none of them — it queues, and the picture stops answering. So the newest
wanted time is remembered and asked for when the last one lands, which is why
the timeline stays responsive while the video lags behind it.

### Driving down instead of scrubbing

The strip is a ruler. It is very good at *put the mark exactly here* and poor
at *where in this scene does the thing happen* — that second question is a
search, and searching two hours of timeline is a lot of dragging.

**Frames** (`g`) is the other half of the bench. It lays the whole scene out as
frames every 30 seconds, and clicking one opens the stretch of time under it at
ten times the detail: 30 seconds, then 3, then 1. Three clicks takes you from a
whole scene to a particular second, and the eye does the work instead of the
hand. Every click also seeks, so the bottom rung is the end of the job rather
than a separate step — find the frame, then `t`.

Rungs stack, coarsest at the top, and each one is a row that scrolls sideways
rather than wrapping: a rung is a stretch of time laid left to right, and
wrapping it would put the second half of a minute underneath the first. The
frame you drilled into stays outlined in the row above, so the panel always
says where in the scene you are; the frame the playhead is standing in is
outlined in every rung at once.

Nothing is fetched. These are the same cues the strip draws from, which means
**how far down the ladder goes is however finely the sheet was cut** — on
Stash's own sheet that is a picture every 17 seconds and it bottoms out after
one rung, which is what *Sharpen strip* below is for. On a sharpened strip the
floor is one second. A rung that can go no finer says so.

On a film long enough that 30 seconds would make a top row of more than 240
frames, the top rung stands further back instead — a row nobody can scroll is
not a contact sheet.

### Sharpening the strip

Stash generates one sprite sheet per scene and it is always about 81 tiles,
whatever the length. On a 23-minute scene that is a picture every 17.4 seconds;
on a two-hour film, one every 89. That is right for the scrub bar it was made
for, where a tile is a hover preview, and wrong for a timeline, where the tiles
*are* the ruler — at the bench's default zoom a tile is 7.1 seconds wide, so
every frame gets drawn two and a half times and the strip smears instead of
showing you the cut you are aiming at.

**Sharpen strip** cuts the scene its own, a picture a second, from the source
file. Measured on the scene the bench was built against — 23m33s, 720p HEVC,
1.2 Mbps — **1,414 tiles across 15 sheets totalling 4.2 MB, in 47-48 seconds
read off the NAS, or 28 from local disk**. Around 2% of realtime either way,
which is what makes it worth doing per scene on demand rather than never.

At the closest zoom the difference is the whole point: an eight-second window
that used to be one tile repeated thirteen times is now thirteen tiles, twelve
of them distinct.

**Why not keyframes, which would be nearly free?** Because these files are x265
with scene-cut detection. Measured on the same scene, keyframes average eight
seconds apart and reach twenty-one at the worst gap — cheap, irregular, and
barely better than what Stash already gives you. Decoding the whole file is the
only way to get an even second.

Ten by ten at 160x90, so every sheet is exactly 1600x900 — the `tile` filter
pads the last one out to a full grid, which means the page needs one size for
all of them rather than probing each. Frames are scaled to fill and cropped
rather than letterboxed: a strip of 2.35:1 scope frames with black bars top and
bottom wastes a third of the only 64 pixels of height the timeline has.

The cue list is arithmetic rather than a vtt. Tiles are evenly spaced in a
fixed grid, so a cue's sheet and crop follow from its index and there is
nothing to parse.

One cut at a time, and a second scene is **refused rather than queued** — this
takes every core it is given, and a queue would let a page you have left tie
the machine up. Cached on disk under `/markerclips/strips/<scene>`, because you
come back to a scene and 49 seconds of CPU is worse than 4 MB of disk; the same
button throws one away. **Check the free space on the disk behind `/markerclips`** before sharpening
the whole library — it is thousands of strips' worth.

A picture a second is the cap, not the rule: the interval is
`ceil(duration / 4000)`, so anything ordinary lands on 1, a two-hour film on 2
and a six-hour compilation on 6. What costs is the tile count, not the minutes.

### Two flags, and why the GPU is not the answer

ffmpeg's own defaults leave most of this machine idle. Measured on the same
scene, from local disk so the network could not muddy it:

| | |
| --- | --- |
| default | 42.3s |
| `-threads 12` | 37.0s |
| `-threads 12 -filter_threads 12` | **28.3s** |

A third off for two flags. The decoder's default was not the problem — the
filter graph's was: `fps` and `tile` run on one thread unless told, and once
the decode is spread out they become the queue everything waits in. The count
is read at runtime rather than hardcoded.

It still only reaches about four cores of twelve, and that is the real ceiling:
`tile` has to gather a hundred frames before it can emit a sheet, which is a
serial dependency no number of threads removes.

**Passing the RTX 4060 through would not help, for three reasons in increasing
order of how much they settle it.**

1. **This image's ffmpeg cannot address an NVIDIA GPU at all.** Its hwaccels
   are vdpau, vaapi, qsv, drm and vulkan — there is no `cuda`, and no
   `hevc_cuvid` among the decoders. It is Alpine's build, compiled without
   NVIDIA support, so `--gpus all` would change nothing on its own. It would
   mean replacing ffmpeg in the image, which is the same class of work that
   ruled out the AI tagger.
2. **The decode is no longer the bottleneck; the NAS is.** The same cut is 28s
   from local disk and 47-48s from an SMB share on the NAS, and a raw
   read of the 211 MB file on its own measured 65s, 68s and 113s on three
   attempts — about 2-3 MB/s. No GPU makes an SMB share faster.
3. **It has nothing to do with the picture lagging while you scrub.** That is
   the browser decoding HEVC on the machine you are sitting at, which already
   uses its GPU, and the lag is keyframe distance rather than decode
   throughput. See below.

The lever worth pulling, if this ever needs to be faster, is that share: 2-3
MB/s off a gigabit LAN is roughly thirty times slower than it should be, and
fixing it would speed up everything that touches a scene rather than this one
job.

### Why the picture lags, and what was done about it

The files are HEVC, but Stash is **not** transcoding them — `/stream` answers
206 with `Accept-Ranges: bytes` and the whole file length, so the browser is
seeking a plain mp4. The lag is the codec: with keyframes eight seconds apart
and up to twenty-one, an exact seek has to decode everything from the keyframe
before it.

So a drag no longer asks the video to follow. The strip is the preview — that
is what it is for — and the picture only has to be right where you stop, so the
whole drag costs **one** seek instead of one every few pixels. Measured: twenty
pointer moves across a drag produce zero seeks, and releasing produces one.
Arrow keys, the wheel and clicking a marker band still seek live, because those
are single small moves rather than a stream of them.

### On a phone

The bench was built keyboard-first, and keyboard-first on a phone means
readable and inert: you could scrub the strip with a finger and then had no way
to mark anything you found. `t`, `i`, `o`, space, the arrows and Esc were all
unreachable, and the only controls that survived were the two zoom chips —
because they were the only ones that had ever been buttons.

So every key has a button, in a transport row under the strip: `−10s −1s ▶ +1s
+10s`, then **Point**, **In**, **Out**. Both paths call the same four functions,
so there is one description of what `t` means rather than two that drift.

The letter rides on the button as a small badge rather than in a separate
legend. On a desktop that teaches the shortcut; on a phone the badge is hidden,
so nothing is left telling somebody to press a key they do not have. What the
buttons cannot say is the modifiers — shift for 10 seconds, alt for a tenth —
and that legend is hidden on touch for the same reason.

**The fine step needs no touch equivalent.** Dragging the strip at the closest
zoom is about eight milliseconds a pixel, which is finer than alt and an arrow
key ever gets you.

Three things were not cosmetic:

- **Esc had no equivalent, and Esc is the only way out of the tag prompt.** The
  marker is not written until a tag is picked, so on a phone the only exit was
  to pick a wrong tag and delete it afterwards. The prompt has a **Cancel**
  button now, and the in-point indicator is itself the button that drops it.
- **Focusing the tag box summons the software keyboard**, which covers a panel
  pinned to the bottom of the screen — and what it covers is the list of
  presets, which is the answer nine times in ten. So the box is focused only
  where there is a real keyboard; tapping the field is how you say you would
  rather type. On a narrow screen the panel becomes a bottom sheet with a safe
  area inset, rather than a floating box the keyboard shunts around.
- **Pinch had to be written.** The strip sets `touch-action: none` so a
  horizontal drag scrubs instead of scrolling the page, and that switches the
  browser's own pinch off with it. Zoom is a ladder of fixed steps, so a pinch
  climbs it: the span between the fingers has to change by a quarter before it
  moves a rung, which stops two fingers resting on the glass from ratcheting
  through the whole range. A second finger also ends the drag the first one
  started — you have stopped aiming at a time and started changing the scale.

Tapping the picture plays and pauses it, because that is what everybody tries
first and on a phone the transport is below the fold as often as not.

The media query is `(hover: none) and (pointer: coarse)`, not a width. They are
not the same question: a tablet in landscape is wide and still has no keyboard,
and a narrow desktop window has one. Only the things that are genuinely about
*room* — the transport stacking, the bottom sheet — key off `max-width`.

Drag-to-scrub, incidentally, already worked on touch and needed nothing: the
pointer events the mouse drag was written against are the same ones a finger
sends.

### It does not change the plugin rule

A marker cut here is a marker the plugins can still overwrite. Both of them
import within fifteen seconds of an existing marker and **rewrite it in place**
rather than skipping it — that is how 156 timestamp.trade markers were retimed
and retitled in one pass — and a human having made this one does not exempt it.
Mark first and run the plugins after, or not at all.

What does tell them apart is the title. The plugins sign their work there
(`[Timestamp]`, `[TsTrade]`, `[TPDBMarker]`), and a marker cut here is written
with an empty one, because Stash shows the primary tag wherever a marker has no
title of its own. The marker list only prints a title where it says something
the tag does not — TPDBMarkers mostly writes the tag's own name into it, and
printing both gave every row it made a stutter.

A new marker gets a rendered 720p clip on the next marker-clips pass, which is
already an idle job. Nothing here has to ask for one.

### One name that is two names

The tag query cost a rebuild to find: the **filter** field is `marker_count`
and the **output** field on a Tag is `scene_marker_count`. Getting it the wrong
way round is a 422 from Stash with nothing in it that says which half is wrong.

## Galleries

The still half of the library, at `#/library/galleries`. A gallery is a Stash
gallery — the portal keeps none of its own, for the same reason everything else
on this side counts Stash rather than Whisparr.

A gallery ties to three things, and Stash gives two of them directly:

| Tie | How |
|---|---|
| **Scene** | `Gallery.scenes`, both ways — the scene page carries them as a card in its rail |
| **Performer** | `Gallery.performers`, likewise on the performer page |
| **Movie** | through the gallery's *scenes*, because there is no group field |

That last one is not a shortcut. The `Gallery` type in Stash 0.31.1 has no
group, so "galleries in this movie" can only mean "galleries on the scenes in
this movie" — the same answer the acquisition side gives for movies, and for
the same reason: the honest join is the one the data has.

Clicking a picture opens a viewer — arrow keys, Escape, click the backdrop to
leave. Long sets page in 120 at a time and the viewer arrows through whatever
has been loaded.

### Filed, and a rating

Stash keeps **organised** and a **rating** for a gallery exactly as it does for
a scene, and until now nothing in this portal ever set either — the write
endpoints existed and no button called them. The gallery page carries the same
pair the scene page does, from the same control: **Mark filed** and five stars,
with a second click on the star you are already on clearing it.

Both are the light-touch half of a catalogue manager, which is the line this
portal draws everywhere: what you decide while looking at something lives here,
and metadata surgery stays in Stash, where the undo lives.

A filed gallery is ticked on the wall, and **Filed / Not filed** is the first
dropdown on the Galleries bar — so "what have I not been through yet" is one
click, and the count says how many that is.

### No pictures yet

Every other page in the library half ends with a thin row of what you do not
have. This is that row for pictures: **everyone you hold films of whose name is
on no gallery**, ordered by how much of them you hold, because the person you
have twenty scenes of is the one worth a photo set. It reads 930 of 939 today,
with nine people covered by thirteen galleries.

The tile goes to *their* page rather than starting a build from the rail, since
that page already carries **Add a gallery for them** with the tie filled in.

`/api/library/galleries/gaps` subtracts every gallery's cast from the
performers you hold files of. Counted from the galleries themselves rather than
from a performer's `gallery_count`, for the same reason the rest of this half
counts what is in the library rather than what Stash holds a record of. It is
asked for beside the galleries and caught, so a failure costs the rail and
never the page.

### The pencil on a card

Hovering a gallery card shows an edit button, which opens what is worth
deciding while looking at the wall: **rename**, **which picture fronts it**,
**how that picture is cropped** into the card's square, **who and what it is
of**, and **delete**.

The performer, scene and studio boxes are type-aheads answered by Stash rather
than by reading the library into the browser — 1264 performers is not a list to
filter client-side. A build already sets these when you start from a scene or a
performer page; this is for galleries that arrived any other way, and for
changing your mind. Each list replaces rather than appends, so what the dialog
shows is what the gallery ends up with.

The crop is a focal point — an `x y` percentage kept on the gallery's
`custom_fields` and applied as `object-position` — *not* a cropped copy of the
file. Click the preview to say which part to keep, "Centre it" to clear it. The
pictures are the thing you kept; an editor that quietly rewrites one is not
what "change the thumbnail" should mean. The cover itself is Stash's own
`setGalleryCover`, so no second file is written either.

Delete asks once, says what it will take, and takes the folder with it —
leaving the files behind would just mean Stash rebuilding the gallery on its
next scan.

### Building one

**Find, choose, write**, and it stays three steps: nothing is downloaded until
someone has looked at the pictures and cut the list down. Three sources:

- **a web page** — fetched and read for images. Anchors pointing straight at an
  image are read first, since on a photo-set page that link *is* the full-size
  picture, then `og:image`, then every `<img>` including the lazy-loading
  attributes and the biggest entry in a `srcset`.

  Photo-set pages come in two shapes and the second one needs more than
  reading. Where a page links its full-size pictures (elitebabes), that is the
  set. Where each thumbnail links to a **page about that one photo**
  (girlsofdesire), nothing on the gallery page is a full-size picture at all,
  so those links are followed — one level only, only pages under the gallery's
  own URL, six at a time, capped at 60. On the photo page the picture taken is
  the one sitting in the same directory the thumbnail came from, falling back
  to `og:image`. Fifteen photos costs about four seconds.

  Two things that are easy to get wrong here, both of which shipped broken
  once: a `srcset` is **not** reliably in ascending order — elitebabes writes
  the widest first — so the descriptors have to be read rather than the last
  entry taken; and the full-size link cannot be pulled out of a captured
  `<a>…</a>` body, because one `<img>` with a long `srcset` overruns any cap on
  that capture and the thumbnail is what is left behind.
- **a scene on ThePornDB** — its still, its uncropped background and the poster
  crops, offered where Stash identified the scene against TPDB.
- **a performer on ThePornDB** — every photo TPDB holds for them, which for a
  well-covered performer is over a hundred.
- **your own files** — pictures, or a zip of them. The zip is unpacked by the
  portal, which reads it with `zlib` rather than a dependency: stored and
  deflated entries, in filename order, with folders, `__MACOSX` junk and
  anything that is not a picture reported rather than silently dropped.

Uploads go one file per request, so a picture that fails is a picture rather
than a set, and the server needs no multipart parser — the body is the file and
the name is in the query.

What arrives ticked is the finder's call. If the page linked full-size
pictures, **those are the set** and everything else is furniture — that gallery
of Melody Marks links 20 and carries another 92 thumbnails for other galleries
down the side. A page that links none has everything ticked, since then the
`<img>`s are the set. ThePornDB starts with nothing ticked, because its list is
several versions of one picture.

Only a URL the portal has already offered can be fetched — by the thumbnail
proxy or by the build — so neither can be pointed at an arbitrary address by
hand. It is the same rule the movie gap-filler's artwork proxy uses.

### Where the files go, and why Stash has to be told

A Stash gallery is files on a disk, so building one writes them and then asks
Stash to import them:

1. write the chosen pictures to `<galleryPath>/<name>/`
2. `metadataScan` on `<galleryStashPath>/<name>`, then wait for that job to
   **finish** — a folder gallery takes its title from the folder and Stash
   re-saves it as each picture lands, so tying it mid-scan gets the title wiped
   a second later. The first gallery built here came out untitled for exactly
   that reason.
3. find the gallery Stash just made, matched on that path
4. `galleryUpdate` to title it and tie it to the scene, cast and studio

If step 4 is the one that fails, the build still says so: the pictures are in
either way, and a gallery tied to nothing is the thing worth mentioning.

Hence **two paths for one folder** in Settings: the portal writes at its path,
Stash scans at its own, and neither can use the other's. The compose file
mounts `<stash media bind>/galleries` — which is inside the bind
Stash already has at `/data` — so nothing about the Stash container changes.

What *does* have to change is Stash's library paths. All of them set
`excludeImage`, because a video-only library is the usual setup, so a scan
would import nothing and no gallery would ever appear. The Galleries page
checks this before a byte is written and offers one button to add the folder
with images turned on. That is a settings write on Stash, so it happens on a
button and never on the way past.

Downloads are capped at 40MB a picture, anything under 15KB is dropped as
chrome, and the build appends to a folder it has already filled rather than
renumbering it. An upload is capped at 512MB a request. No file is ever written
over: the numbering carries on from what the folder already holds.

### Changing a gallery's pictures

The gallery page has a small toolbar over the grid:

- **Add pictures** uploads into that gallery's own folder and asks Stash to
  scan it again, which is where they become images in the gallery. Only
  folders this portal manages can be added to — a set Stash scanned from
  somewhere else is not this app's to change, and it says so.
- **Select** turns a click from "open the viewer" into "tick this picture".
  With one picked you can make it the cover; with any number you can delete
  them, and that takes the files too — a picture left in the folder is one the
  next scan puts straight back.

One thing Stash decides rather than the portal: a file whose bytes match a
picture already in the library is not imported a second time, so uploading a
duplicate adds nothing and says nothing.

## Scene and performer pages

Both come from TPDB directly, keyed on the UUID rather than the numeric id the
catalogue uses.

**A scene** (`#/scene/<uuid>`) shows the artwork, the site and network, runtime,
description and tags, its Whisparr and Stash state — including which method
matched and the path of the file you already hold — and an **Add to Whisparr**
button. Its performers are links.

**A performer** (`#/performer/<uuid>`) shows their photo, aliases, bio and the
facts TPDB actually filled in, then every scene TPDB lists for them, newest
first, each annotated and addable. The header counts how many of those you
already hold:

> 60 scenes on TPDB · 7 in Stash · 0 in Whisparr · 53 you do not have

Their scene list is deliberately **not** run through the straight/lesbian/solo
filter. That filter exists to make a discovery feed usable; you are on this page
because you asked for this person.

**The library performer page is the studio page asked about a person**
(`src/performerpage.mjs`, the studio's twin). **Track this performer** turns the
measurement on, the bar under the record says how much of what you decided you
want is on the shelf, and the same three views sit over the same shelf: *In your
library*, *Missing* — what you marked and have not got — and *Everything*,
StashDB's catalogue for them with what you hold marked on it. There is no cast
rail, because on this page the cast is the subject.

**One set of views serves both pages.** What a studio and a performer do
differently is a table of four things — which shelf to page, which StashDB
filter, where the held count lives, and the word for "of this one" in an empty
state — and not three more copies of the views themselves. Two copies would be
two answers waiting to disagree, the same reason the scene card is shared with
the acquisition side.

Nothing is fetched to draw *Missing*: the want list keeps enough of each scene
to redraw the card, filtered by the performer's StashDB id off the cast the
mark already carries. A performer Stash never identified against StashDB gets
the whole library half, the other two views greyed, and a line saying why.

**A mark keeps what the card shows, so the two have to move together.** When
the card grew a cast line and a description, 2,678 older marks had a cast and
no description — and reading StashDB on every page load for a field that never
changes is the wrong fix. `POST /api/acquire/tracked/scenes/backfill` fills the
gap once instead: it asks only about the records missing something, thirty
`findScene` aliases to a GraphQL document because StashDB has no *find these
ids* query, and writes a chunk at a time against a freshly read config so a
mark made halfway through a ninety-request run is not thrown away. Run on
2026-09-09 it filled all 2,678, none merged away, 349 of them empty because
that is what StashDB holds. A second run asks nothing. Safe to call again
whenever the card grows another field.

**Both views show it.** A card gets two clamped lines at 160 characters; a list
row is wider, so it gets one line at 220 with an ellipsis on the end. Either
way the whole of it is on the hover title, and the row's text column carries
`min-width: 0` — without it a one-line blurb widens its `1fr` track until the
Skip / Want / Add buttons fall off the end of the row.

Forty-three scenes on StashDB have their own title again as the description.
Both drop a blurb that is the title, because that is one line twice.

### Deleting a scene

The one thing in this half that cannot be undone, so it is the one that says
what it is about to take before it offers to take it. **Delete scene…** sits
last in the rail, on its own, away from the buttons you press without looking.

It asks Stash first — `/api/library/scenes/<id>/removal` — and reads back what
is actually there: the file and its size, the galleries filed against the
scene, and how many reel clips were cut from its markers. Nothing in that
warning is guessed in the browser.

Then it asks twice. The first press picks what goes; the second names it —
*"Taking the Stash record, the file, 1 gallery. There is no undo."* — and is
the one that does it.

Three things go, each asked for separately because they are three different
losses:

- **The file**, ticked to start with. A scene deleted from Stash with its file
  still under a library path comes back on the next scan, so a record-only
  delete mostly undoes itself — the same argument the gallery pencil makes
  about its folder.
- **Galleries**, not ticked, listed by name and picture count. A photo set is
  its own thing that happens to be tied to this scene.
- **Reel clips**, ticked. Ours rather than Stash's — `/markerclips/<marker>.mp4`,
  cut from the file that is going, and unplayable once it has.

Order matters in [`sceneremove.mjs`](src/sceneremove.mjs): the markers are read
*before* the scene is destroyed, since they go with it and their ids are how
the clips are named; clips and galleries go next; the scene goes last, so a
failure part-way leaves the record that says what happened rather than an
orphan.

**Whisparr is not told.** The pipeline's own delete runs the other way round,
from Stash outward, and a portal that quietly unmonitored things on your behalf
would be a second opinion nobody asked for.

### The library scene page is two columns

`#/library/scene/<id>` — the Stash side, not to be confused with the TPDB one
above. The player and everything you *do* run down the left: title, studio,
date, runtime, resolution, then filed / rating / O, markers and the
description. Everything you *read* sits in a rail to its right — the links out
(Whisparr v3, ThePornDB, Edit in Stash), the galleries filed against the scene,
the tags, and the file as a spec list with its path.

The split is what it is because those are different acts. It also stops the
page being nine stacked rows in a 980px column on a 1560px screen, which is
what it was.

The cast is the exception to the split, and sits under the video rather than in
the rail: it is the first thing anyone looks for under a scene. It is
right-justified against the title block and never taller than it — the faces
are a fixed size, the row has a floor taller than one of them, and a
twelve-hander scrolls sideways rather than pushing the page down.

Four details:

- **Tags are capped at 16** with a `+N more` that unfolds the rest. An
  identified scene carries forty or fifty and the rail is 340px wide.
- **The player is built once and never redrawn.** Rating a scene rebuilds the
  column around it, so what a redraw touches is kept apart from the video —
  otherwise filing a scene would restart what you are watching.
- **The whole picture is a seek bar.** A drag anywhere across the video moves
  the playhead with the same reach the bar has — the full width is the full
  runtime — with the same sprite thumbnail card, and the file is only seeked
  when you let go. It is relative rather than absolute, and it takes 8px of
  travel to start, because the same surface still has to answer a tap; a
  mostly-vertical swipe stays a page scroll.
- **The bar's ↔ gives the picture the width.** The rail folds away and the
  player takes the frame. It is the page's switch rather than the player's —
  `withControls` only draws it and reports which way it is — and it is not
  drawn under 1080px, where there is no second column to give back.

Galleries are a card in the rail rather than a row under the page: a scene has
a handful rather than a wall, so it shows one at a time with a pair of arrows
in its heading. The row under the page is still what the performer and movie
pages use, where the count is larger.

### Needs you is a summary, not a workbench

It tells you what is stuck and links to the queue. Retrying, unmonitoring and
deleting stay in Whisparr, where the undo lives.

### Why it filters the way it does

TPDB's raw "recently added" feed is not usable as a home page: **82 of the
newest 100 scenes come from ManyVids alone**, and clip-site performers are
rarely linked to a parent record, so their gender is unknown. Two rules clean
it up:

1. **Clip sites are dropped** — a network blocklist, plus a rule for the
   `Network: Someone` naming pattern that per-performer storefronts use
   (`ManyVids: Latika Jha`, `HobbyPorn: Miniblondie`).
2. **Only straight, lesbian and solo female scenes are kept**, worked out from
   performer gender (`performer.parent.extras.gender`). Scenes with any
   unknown-gender performer are dropped rather than guessed at.

Even after filtering it has to read deep — about 2000 scenes for 24 cards — which
is why it runs in the background.

**Your own sites aren't filtered.** You chose those, so everything they release
shows up.

### There is no "trending"

TPDB has no trending endpoint, and unknown query parameters are silently
ignored, so `order=trending` looks like it works but just returns the default
order. The only popularity signal in the data is fingerprint submission counts,
and it's too thin to chart: 5 of 100 scenes from June had any, 14 of 100 from
March, and new releases are all zero. Rather than ship something labelled
trending that is really noise, it's left out.

## What it does

**Search** hits three sources at once and draws each block the moment that
source answers, because they are nowhere near equally fast:

- **In your library** — what Stash already holds
- **On StashDB** — scenes, with the "In Stash" badge and a button that sends
  them to Whisparr v3
- **Sites on ThePornDB** — for scenes StashDB does not have

StashDB comes first of the two catalogues because it is the one that decides
what the library should contain: its ids are what v3 indexes on and what Stash
stores back on the scene, so a scene found there arrives home under the id it
was found under. TPDB is the fallback, not the front door.

Adding one scene follows the same rule. A TPDB scene is checked against StashDB
before it goes anywhere: a **fingerprint** match is sent to v3 without asking,
because it cannot be a coincidence, and a **title and date** match is put to you
with both options — v3 or the TPDB/v2 route — because the cost of being wrong is
a download of something you did not want. Only a scene StashDB has never heard
of goes to v2 unasked. Bulk **Add all shown** on a site page still goes straight
to v2; the StashDB-first routing is on single adds.

On a library scene identified against StashDB, **Ask for another file** monitors
it in v3 and forces a search. It deletes nothing — not the file on the share,
not the Stash record — so the copy you have stays where it is until something
better has actually landed and you have chosen between them.

**Open** a TPDB site and you get its full scene list, newest first, with
performers, dates and runtimes.

Each scene shows two things:

- **Whisparr state** — Not added / Monitored / Downloaded
- **Stash state** — In Stash (green) or Probably in Stash (amber), when Stash is
  connected

Filter chips narrow the list to **Do not have** (not in Whisparr *and* not in
Stash), **In Whisparr**, or **In Stash**. **Add all shown** does the whole filtered set
in one go — so "show me everything from this site I don't have, add it" is two
clicks.

The **Queue** view shows what Whisparr is currently downloading.

## How it works

No credentials are needed to browse, because the catalogue comes from Whisparr's
own metadata service (`api.whisparr.com/v3`), which mirrors TPDB and is open.
That's also what Whisparr v2 itself uses, so what you see is exactly what
Whisparr will accept.

v2 is a Sonarr fork, so the mapping is:

| TPDB | Whisparr v2 |
|---|---|
| site | series (`series.tvdbId` = TPDB site id) |
| scene | episode (`episode.tvdbId` = TPDB scene id) |

Adding a scene: look up or create the site with `addOptions.monitor = none`,
find the episode by TPDB scene id, monitor it, then fire `EpisodeSearch`. Sites
are always added unmonitored, so **adding a site never pulls its back
catalogue** — only the scenes you pick.

The Stash check matches on TPDB stash ids first (TPDB runs a stash-box endpoint,
so scenes identified against it carry the TPDB UUID — the same UUID the metadata
service calls `ForeignGuid`), falling back to title + release date. Matching is
batched: one GraphQL query per 250 scenes, not one per scene.

Two details that are easy to get wrong:

- The Stash **API key is optional** — a Stash with no key set serves GraphQL
  openly, so the portal only sends the header when you've given it one.
- TPDB is usually configured in Stash twice, as `?type=Scene` and `?type=Movie`.
  The endpoint string is stored verbatim on every stash id, so the portal picks
  the **Scene** one deliberately; matching against the movie endpoint finds
  nothing.
- The `stash_ids_endpoint` filter takes modifier `EQUALS` with a list of ids,
  which ORs them. `INCLUDES` is rejected by Stash outright.

You do not need to identify your library against TPDB for this to work well —
fingerprints cover libraries tagged against StashDB or not tagged at all.

## Layout

```
src/
  server.mjs     http server, routes, static files
  config.mjs     config.json load/save, secret redaction
  metadata.mjs   TPDB catalogue via api.whisparr.com, cached 6h
  whisparr.mjs   Whisparr v2 client (series/episode)
  stash.mjs      Stash GraphQL client and scene matching
  library.mjs    merges TPDB + Whisparr + Stash into one view
  movies.mjs     the movies section: TPDB movies vs Stash groups
  stashlib.mjs   the library spine — browsing and playing what you hold
  studiopage.mjs   one studio: the shelf, the cast, the catalogue it is measured against
  performerpage.mjs  the same two halves, asked of a person
  galleries.mjs  galleries, and what they are tied to
  galleryscrape.mjs  where the pictures come from: a page, or ThePornDB
  gallerybuild.mjs   writing them, and getting Stash to import them
  galleryupload.mjs  your own files, and a zip reader built on zlib
public/          vanilla JS front end, no build step
```

## Artwork

Scene stills, tags and exact runtimes come from ThePornDB's own API, because
the free metadata service carries no per-scene images at all (its `/site` and
`/scene` endpoints both return `Images: null`).

Aspect ratios follow TPDB's own shapes, measured from the files rather than
assumed:

| Field | Size | Shape |
|---|---|---|
| scene `background.large` | 1500×1085 | landscape — **what scenes render as** |
| scene `image` | up to 5760×3240 | the studio's own still, 16:9 |
| scene `poster` | 800×1200 | a portrait crop TPDB generates |
| movie (every field) | 500×709, 1058×1500 | poster portrait |

So scene art renders 16:9 and movie art renders 2:3. Both URLs are carried on
every card, so switching between them costs no extra request.

That needs a TPDB token, and **you almost certainly already have one**: Stash
stores a token for each stash-box it is configured with, TPDB uses the same
token for its stash-box and its REST API, and Stash exposes it through its own
GraphQL. So if Stash is connected, artwork works with nothing to set up. The
status bar says *"Artwork via TPDB token from Stash"* so this isn't invisible.
No token is written to `config.json`.

Fetching is slow — 100 scenes per page, several seconds each, ~30–60s for a big
site — so it runs in the background. Opening a site is instant and thumbnails
fade in as they arrive, with a progress note in the toolbar. Results are cached
for 24 hours.

TPDB also returns **PHASH and OSHASH fingerprints** per scene, which is what the
Stash check uses — see below.

## How the Stash check decides

Four methods, strongest first. The badge tooltip always says which one fired.

| Via | Badge | Means |
|---|---|---|
| TPDB stash id | green | the scene was identified against TPDB's stash-box |
| `oshash` | green | byte-identical file |
| `phash` | green | identical frames |
| `phash distance n` | amber | same scene, different encode or size (n ≤ 8) |
| title + date | amber | a guess, and labelled as one |

Fingerprints are the workhorse, because they don't care how a file is named or
which stash-box it was identified against — which matters, since a library
tagged mainly against StashDB carries no TPDB ids at all.

Stash returns every fingerprint in the library in one query (~0.5s for 1700
scenes), so matching happens in memory rather than one query per scene.

**Collisions are dropped deliberately.** TPDB occasionally carries the same
fingerprint against two different scenes, from a mis-submitted hash. Left alone,
both would report as held. Only the scene whose title actually resembles the
file is kept, because wrongly saying "you already have this" means quietly never
fetching it — a worse failure than fetching a duplicate.

Fingerprint matching runs after the artwork pull, so badges start on stash ids
and title+date, then upgrade in place a few seconds later.

## Known limits
- **First load of a big site is slow-ish.** Vixen's catalogue is 637 scenes /
  1.6MB from the metadata service. Cached for 6 hours after that.
- **TPDB has duplicate scene entries** for some sites; they show up as duplicate
  rows because that's genuinely what the catalogue contains.
- **The title + date fallback doesn't check studio.** Two studios releasing a
  scene with the same title on the same day would collide. It's now only used
  for scenes TPDB has no fingerprint for, and the badge says "probably".
- **Fingerprint matching needs the artwork pull to finish**, since that's what
  carries the hashes. On a big site that's 30–60s after opening it.
- Single user, no auth. Put it behind your existing reverse proxy if it needs to
  be reachable from outside the house.
- **A movie can only be matched on its name.** Stash groups have no stash id
  and no fingerprints, so the grid's badge is a guess and says so. The movie
  page answers it properly, scene by scene.
- No monitoring of a whole site, and no network or tag browsing.
- **A gallery cannot be tied straight to a movie.** Stash's `Gallery` type has
  no group field, so that tie goes through the gallery's scenes.
- **Building a gallery needs Stash pointed at the folder**, with images not
  excluded. The Galleries page says so and offers the one button that fixes it;
  until then a build refuses rather than writing files nothing will import.
