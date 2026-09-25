# tpdbarr portal

A self-hosted console on top of Stash: browse and tidy your library, find what
you're missing on StashDB and ThePornDB, and send it to Whisparr. Same idea as
[stasharr-portal](https://github.com/enymawse/stasharr-portal), pointed at
TPDB and Whisparr v2 as well as StashDB and v3.

No browser extension, no userscript, no TPDB account.

## An overlay on Stash, not a replacement

- **It reads Stash live** over GraphQL. There is no second copy to sync.
- **Changes go back into Stash**: markers, galleries, metadata, covers.
- **It plays files from the folders Stash already uses.**
- **Its own state is one `config.json`**: settings, want and ignore lists,
  tracked catalogues.
- Stop the portal and Stash carries on as before.

## Run it

```bash
cp .env.example .env    # then set your NAS, SMB login and host paths
docker compose up -d
```

Open <http://localhost:6980> and fill in Manage.

Every host path comes from `.env`. Drop any mount for a feature you don't use.
A Whisparr v2 service is included, commented out. No database, no npm
dependencies (Node stdlib only).

### Configuration

Everything is set in the UI and stored in `/config/config.json`, except:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `6980` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `CONFIG_DIR` | `/config` | where `config.json` lives |

**Test connections** in Manage reports the Whisparr version (and warns if it
isn't v2), the Stash version, and whether Stash has a TPDB stash-box endpoint.

The StashDB and ThePornDB tokens are read from Stash. None are stored here.

Screenshots are in the [main README](../README.md#whats-in-it).

## Library

### Where a scene stands

Everything Stash holds is yours. The folder it's in is its status:

| Stage | Where |
|---|---|
| **Downloaded** | Whisparr's root, not in Stash yet |
| **Editing** | `/pc-import` |
| **Encoding** | `/Import Folder`, waiting on FileFlows |
| **Filed** | `/organized_scenes` |
| **Films** | `/movies` |

Bottom left of every tile: the resolution, then **Waiting to import**, **Needs
organizing** or **Filed**. The colour compares the file to its target
resolution (720p unless the scene page chose 1080p, 480p or Keep):

| Colour | Means |
|---|---|
| **Red** | bigger than the target — an encode is owed |
| **Yellow** | at target, not finished |
| **Green** | at target, filed and organised |

Films always count as at target.

### Shelves

Scenes, Performers, Studios and Galleries share one filter bar: search,
dropdowns, sort, **Clear** and **Random**. Each dropdown shows how many it would
give you. Filters live in the address, so coming back from a scene keeps them.

| | narrowed by | ordered by |
| --- | --- | --- |
| **Scenes** | kind, studio, performer, tag, year | recently added, newest, title, longest, most in that studio |
| **Performers** | gender, country, studio, kind, year, tracked | most scenes, name, newest |
| **Studios** | performer, kind, year, tracked | most scenes, name, newest |
| **Galleries** | filed, studio, performer, year | newest, title, most pictures |

- **Kind** is read off tags: Solo, Lesbian, Group, Threesome, Couple, or *Not said*.
- Scenes has a second view, **Monitored, not here**: what you wanted that
  hasn't arrived.
- A tracked performer or studio shows its percentage on the tile.

### Scene page

`#/library/scene/<id>`. The player and what you *do* are on the left: filed,
rating, markers, description. What you *read* is on the right: links, galleries,
tags, file details. The cast sits under the video.

- Drag anywhere on the picture to scrub. Seeking happens when you let go.
- **↔** folds the right column away (1080px and wider).
- **Ask for another file** monitors the scene in v3 and searches. It deletes
  nothing.
- **Delete scene…** shows what it will take first (file, galleries, marker
  clips), then asks again. Whisparr isn't told.

### Performer and studio pages

**Track** one and a bar shows how much of what you want is on the shelf. Three
views: *In your library*, *Missing*, and *Everything* on StashDB with what you
hold marked.

### Galleries

Stash galleries, tied to scenes and performers. Movies go through their scenes,
because Stash galleries have no group field.

- **Mark filed** and a rating, like a scene.
- **No pictures yet** lists the people you have films of but no gallery for.
- The pencil on a card renames, picks and crops the cover, sets who it's of, or
  deletes it (folder included).
- **Building one**: find pictures from a web page, a ThePornDB scene or
  performer, or your own files or a zip. Choose, then write. Nothing downloads
  until you've chosen.

**Setup:** Manage has two paths for the galleries folder — the portal's and
Stash's. Stash's library path must not exclude images. The Galleries page checks
this and offers one button to fix it.

## Stats

- **The pipeline** as one bar, in the order files move. Each segment opens that
  stage.
- Five charts: added per month, quality, watched, identified by which
  stash-box, years covered.
- **Unmonitor** everything Stash has filed. Reversible.
- **Remove** what's been unmonitored for fifteen days (v3 only). Deletes
  Whisparr's copy and adds an import exclusion. Asks first, and only touches
  scenes Stash has a copy of.

## Find

**Search** asks three places at once: your library, StashDB, and ThePornDB
sites. StashDB comes first because its ids are what v3 and Stash use.

Adding a TPDB scene checks StashDB first:
- **fingerprint match** → sent to v3
- **title and date match** → you choose v3 or v2
- **unknown to StashDB** → sent to v2

**Open** a TPDB site for its scene list, with Whisparr and Stash state on each.
Filter to **Do not have**, **In Whisparr** or **In Stash**, then **Add all
shown**.

**Tracked**: follow a studio, performer or tag and work through it as a queue.

| Word | Means |
|---|---|
| **Want** | marks it; **Add** is what fetches |
| **Skip** | not for me; leaves the percentage |
| **Have** | it's in Stash |
| **Still to decide** | what's left |

Movies from ThePornDB have no Add of their own — Whisparr v2 has no movies.
Open one and add its scenes.

## Catalogue

### Marker Builder

`#/catalogue/markers`. With no scene picked it's the queue: filed scenes, filtered
like the Scenes shelf, unmarked first. Only `/organized_scenes` — anything
earlier is about to be re-encoded.

| Key | |
| --- | --- |
| `t` | point marker at the playhead |
| `i` / `o` | open and close a span |
| `←` `→` | 1 second, `shift` 10, `alt` a tenth |
| `space` | play and pause |
| `+` `−` | zoom (or `ctrl` and the wheel) |
| `g` | Frames: drill from 30s to 3s to 1s |
| `Esc` | drop an open in point |

Each marker asks for a tag. Kissing, Orgasm and Undressing come first, then your
most-used. Typing a new name creates it.

- **Sharpen strip** cuts one picture a second from the file, so the timeline is
  exact. One scene at a time; cached on disk.
- On a phone every key has a button, and pinch zooms.
- The timestamp.trade and TPDBMarkers plugins rewrite any marker within 15
  seconds of theirs. Mark first and run the plugins after, or not at all.

## How the Stash check decides

Strongest first. The badge tooltip says which one matched.

| Via | Badge | Means |
|---|---|---|
| TPDB stash id | green | identified against TPDB's stash-box |
| `oshash` | green | byte-identical file |
| `phash` | green | identical frames |
| `phash distance n` | amber | same scene, different encode (n ≤ 8) |
| title + date | amber | a guess |

Fingerprints arrive with the artwork pull, so badges can upgrade a few seconds
after a site opens. When TPDB has one fingerprint on two scenes, only the one
whose title matches the file counts.

- The Stash API key is optional.
- If TPDB is set up in Stash twice (`?type=Scene` and `?type=Movie`), the portal
  uses the Scene one.

## How it works

The catalogue comes from Whisparr's open metadata service
(`api.whisparr.com/v3`), so browsing needs no credentials. Artwork and
fingerprints come from ThePornDB's API, using the token Stash already holds.

v2 is a Sonarr fork: a TPDB site is a series, a scene is an episode. Sites are
added unmonitored, so **adding a site never pulls its back catalogue**.

```
src/       server, routes, and one module per source or page
public/    vanilla JS front end, no build step
docs/map.md  where everything lives
```

## Known limits

- Single user, no auth. Put it behind a reverse proxy if it's reachable from
  outside.
- The first load of a big site takes a while. Catalogues are cached for 6h,
  artwork for 24h.
- TPDB has duplicate scene entries for some sites; they show as duplicates.
- Title + date matching doesn't check the studio.
- A movie can only be matched to a Stash group by name.
- No monitoring of a whole site.
