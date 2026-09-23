/*
 * Tidying Whisparr up behind the pipeline.
 *
 * Whisparr is a downloader, not a library — see the stage note in stashlib.mjs.
 * A scene is grabbed, encoded, moved and imported into Stash, and from that
 * moment Whisparr holding it monitored is pure residue: it will never be
 * searched for again, but it still sits in the list, still counts against every
 * "wanted" number, and still has a file on the disk it grabbed to.
 *
 * Measured 2026-09-01, which is why this exists: v3 held 539 movies and **all
 * 539 were monitored**, 236 of them with a file. Nothing had ever been
 * unmonitored. v2 was near-clean by comparison — 117 monitored out of 31,974
 * episodes.
 *
 * Two steps, both a button, neither automatic:
 *
 *   1. **Unmonitor** what Stash has filed. Reversible, so it needs no ceremony.
 *   2. **Remove** what has been unmonitored for 15 days. Destructive, so it
 *      waits, and it only ever touches something Stash is holding a copy of.
 *
 * The gap between them is the point. Unmonitoring is a claim that the file
 * landed; the fortnight is the time for that claim to be wrong out loud — a bad
 * encode, a re-scan, a file moved back — before the original is dropped.
 *
 * **The two instances are not in the same state, and it is a settings
 * difference, not a bug.** Read off their own media-management config:
 *
 *   v3  autoUnmonitorPreviouslyDownloadedMovies   = true
 *   v2  autoUnmonitorPreviouslyDownloadedEpisodes = false
 *
 * So when FileFlows moves a file out from under v3, v3 notices the file has
 * gone and unmonitors the movie on its own — watched happening here on
 * 2026-09-01, movie 340: grabbed 13:16, imported 19:01, unmonitored by v3, and
 * the survey found it that way with no write from this portal. v2 never does
 * this. Which splits the work cleanly: step 1 is mostly for v2 and for the ones
 * v3 misses, and step 2 is the whole of the value on v3, because nothing in
 * either app ever removes anything.
 *
 * It is also why the watermark below times from **first sight** rather than
 * from our own write. Most of what ages here will have been unmonitored by
 * Whisparr, not by us.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { gql } from './stash.mjs';
import * as whisparr from './whisparr.mjs';
import * as whisparr3 from './whisparr3.mjs';

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'unmonitored.json');

// How long a scene sits unmonitored before it can be removed.
export const HOLD_DAYS = 15;

const DAY = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------ the watermark
 *
 * Neither Whisparr records *when* something was unmonitored — there is no such
 * field on a movie or an episode — so the fortnight has to be timed here.
 *
 * The clock starts on **first sight**, not on our own write: every survey
 * stamps any monitored=false movie it has not seen before. That way something
 * unmonitored by hand in Whisparr's own UI still ages, and a lost file only
 * ever makes the wait longer, never shorter. Erring long is the right direction
 * for the one operation here that deletes.
 */

let cache = null;   // { "v3:123": "2026-09-01T10:00:00.000Z" }
let loading = null;

export const forgetTidy = () => { cache = null; };

async function seen() {
  if (cache) return cache;
  if (loading) return loading;

  loading = (async () => {
    try {
      const parsed = JSON.parse(await readFile(PATH, 'utf8'));
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // Missing or corrupt. An empty book restarts every clock, which delays a
      // removal by a fortnight and loses nothing.
      cache = {};
    } finally {
      loading = null;
    }
    return cache;
  })();

  return loading;
}

// Temp file then rename: a crash mid-write must not leave something that parses
// as an empty book, because that silently resets every clock.
async function save() {
  if (!cache) return;
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    const temp = PATH + '.tmp';
    await writeFile(temp, JSON.stringify(cache, null, 2), 'utf8');
    await rename(temp, PATH);
  } catch (err) {
    console.warn('[tpdbarr] could not save the unmonitored watermark -', err.message);
  }
}

/* ------------------------------------------------------------- what is filed
 *
 * Only /organized_scenes counts as landed. That is the end of the pipeline and
 * the thing that was asked for: "once it is registered in the organized folder". A
 * scene still in /pc-import or /Import Folder is yours — the whole app counts
 * it now — but it has not finished moving, and unmonitoring on the strength of
 * a file that is still being encoded is how you lose the only copy.
 *
 * /movies is left out on purpose: those 52 features came in through Emby, not
 * through Whisparr, so there is nothing there to tidy.
 */

const FILED = { path: { value: '/organized_scenes/', modifier: 'INCLUDES' } };

const normalise = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '');

const INDEX_TTL = 5 * 60 * 1000;
let filedCache = null;

export const forgetFiled = () => { filedCache = null; };

/*
 * Filed scenes, indexed the two ways Whisparr can be joined to them.
 *
 * v3 indexes on the StashDB scene UUID and so does Stash, so that join is
 * exact — 884 of 984 filed scenes carry one. The other hundred were identified
 * against TPDB's stash-box instead and have no StashDB id at all, so they fall
 * through to title + date, the same fallback the coverage percentage uses.
 *
 * **v2 has no exact join at all.** Its `episode.tvdbId` is TPDB's *numeric*
 * scene id (11315917) while Stash stores TPDB's *UUID*
 * (c4783ab5-95be-4b86-9c5e-76e282ad67af), and those are different keys for the
 * same scene with nothing in either system to translate between them. So the
 * v2 side is title + date only — which is one more reason v2 never gets past
 * unmonitoring here.
 */
async function filedIndex(config, { force = false } = {}) {
  if (!force && filedCache && Date.now() - filedCache.at < INDEX_TTL) return filedCache.index;

  const data = await gql(
    config,
    `query($f: SceneFilterType) {
       findScenes(scene_filter: $f, filter: {per_page: -1}) {
         count
         scenes { id title date stash_ids { endpoint stash_id } }
       }
     }`,
    { f: FILED }
  );

  const byStashId = new Map();
  const byTitleDate = new Map();

  for (const scene of data.findScenes.scenes || []) {
    for (const sid of scene.stash_ids || []) {
      if (sid?.stash_id) byStashId.set(String(sid.stash_id).toLowerCase(), scene);
    }
    if (scene.title && scene.date) {
      const key = normalise(scene.title) + '|' + scene.date;
      if (!byTitleDate.has(key)) byTitleDate.set(key, scene);
    }
  }

  const index = { count: data.findScenes.count, byStashId, byTitleDate };
  filedCache = { index, at: Date.now() };
  return index;
}

// A Whisparr item against that index -> the Stash scene, or null.
function filedAs(index, { stashId, title, date }) {
  if (stashId) {
    const hit = index.byStashId.get(String(stashId).toLowerCase());
    if (hit) return { scene: hit, by: 'stash id' };
  }
  if (title && date) {
    const hit = index.byTitleDate.get(normalise(title) + '|' + String(date).slice(0, 10));
    if (hit) return { scene: hit, by: 'title and date' };
  }
  return null;
}

/* -------------------------------------------------------------- the survey */

const isoDate = (value) => (value ? String(value).slice(0, 10) : null);

/*
 * What there is to tidy. Reads only.
 *
 * Both Whisparrs are optional: one that is not configured or not answering
 * leaves its half empty and says why, rather than failing the page. They are
 * independent instances and one being down is no reason to hide the other's
 * work.
 */
let surveying = null;

export async function survey(config, { force = false } = {}) {
  /*
   * One pass at a time. A survey reads the whole filed shelf out of Stash and
   * every monitored episode out of v2 — fifteen requests on their own — and the
   * Overview can easily ask for it two or three times over while a render
   * settles. Running those concurrently is the same answer computed three times
   * and, measured here, enough load to make one of them come back empty.
   *
   * A forced pass is the two write paths making sure of their ground, so it
   * never shares and never becomes the promise anyone else waits on.
   */
  if (!force) {
    if (surveying) return surveying;
    surveying = runSurvey(config, { force }).finally(() => { surveying = null; });
    return surveying;
  }

  return runSurvey(config, { force });
}

async function runSurvey(config, { force = false } = {}) {
  const [index, v3, v2] = await Promise.all([
    filedIndex(config, { force }),
    surveyV3(config).catch((err) => ({ error: err.message })),
    surveyV2(config).catch((err) => ({ error: err.message })),
  ]);

  const book = await seen();
  const now = Date.now();
  let touched = false;

  // ---- v3, the side that can be removed as well as unmonitored.
  if (v3.movies) {
    v3.unmonitor = [];
    v3.due = [];
    v3.waiting = [];

    for (const movie of v3.movies) {
      const hit = filedAs(index, {
        stashId: movie.stashId,
        title: movie.title,
        date: isoDate(movie.releaseDate),
      });

      if (movie.monitored) {
        if (hit) {
          v3.unmonitor.push({
            id: movie.id, title: movie.title, date: isoDate(movie.releaseDate),
            studio: movie.studioTitle || null, hasFile: !!movie.hasFile,
            sceneId: hit.scene.id, matchedBy: hit.by,
          });
        }
        continue;
      }

      // Unmonitored. Start its clock if this is the first sight of it that way,
      // whoever did the unmonitoring.
      const key = 'v3:' + movie.id;
      if (!book[key]) { book[key] = new Date(now).toISOString(); touched = true; }

      const days = Math.floor((now - Date.parse(book[key])) / DAY);

      /*
       * Removal is gated on Stash holding it, not on the clock alone. An
       * unmonitored movie Stash has no record of is one that was cancelled or
       * given up on, and deleting its file would throw away the only copy.
       */
      if (!hit) continue;

      const row = {
        id: movie.id, title: movie.title, date: isoDate(movie.releaseDate),
        studio: movie.studioTitle || null, hasFile: !!movie.hasFile,
        sceneId: hit.scene.id, matchedBy: hit.by,
        since: book[key], days,
      };

      (days >= HOLD_DAYS ? v3.due : v3.waiting).push(row);
    }

    /*
     * The stage Stash cannot see: grabbed, on the disk, and no Stash record of
     * any kind. Nothing to tidy — it is the *front* of the pipeline — but it is
     * the one stage the Overview could not otherwise show, since every other
     * one is a Stash path.
     */
    v3.unseen = v3.movies.filter(
      (m) => m.hasFile && !filedAs(index, { stashId: m.stashId, title: m.title, date: isoDate(m.releaseDate) })
    ).length;

    v3.due.sort((a, b) => b.days - a.days);
    v3.waiting.sort((a, b) => b.days - a.days);
    delete v3.movies;
  }

  // ---- v2, unmonitor only. It cannot delete one episode; see remove() below.
  if (v2.episodes) {
    v2.unmonitor = [];
    for (const episode of v2.episodes) {
      const hit = filedAs(index, { title: episode.title, date: isoDate(episode.releaseDate) });
      if (!hit) continue;
      v2.unmonitor.push({
        id: episode.id, seriesId: episode.seriesId, series: episode.series,
        title: episode.title, date: isoDate(episode.releaseDate),
        hasFile: !!episode.hasFile, sceneId: hit.scene.id, matchedBy: hit.by,
      });
    }
    delete v2.episodes;
  }

  if (touched) await save();

  return { filed: index.count, holdDays: HOLD_DAYS, v3, v2 };
}

async function surveyV3(config) {
  const all = await whisparr3.allMovies(config);
  return {
    total: all.length,
    monitored: all.filter((m) => m.monitored).length,
    withFile: all.filter((m) => m.hasFile).length,
    movies: all,
  };
}

/*
 * v2's catalogue is enormous and almost entirely irrelevant: 31,974 episodes
 * across 15 sites, of which 117 are monitored. Only the monitored ones can ever
 * be candidates, so only those are carried out of here — the rest is megabytes
 * of nothing.
 */
async function surveyV2(config) {
  const series = await whisparr.listSeries(config);
  const wanted = [];

  for (const show of series) {
    const eps = await whisparr.episodes(config, show.id).catch(() => []);
    for (const episode of eps || []) {
      if (episode.monitored) wanted.push({ ...episode, series: show.title });
    }
  }

  return {
    series: series.length,
    monitored: wanted.length,
    withFile: wanted.filter((e) => e.hasFile).length,
    episodes: wanted,
  };
}

/* --------------------------------------------------------------- the writes */

/*
 * Unmonitor everything the survey found filed. Reversible on both sides: v3
 * takes one bulk edit, v2 one bulk monitor call, and either can be flipped back
 * in Whisparr's own UI.
 *
 * The survey is re-run here rather than trusting ids posted from the browser. A
 * page left open for an hour would otherwise act on whatever those ids happen
 * to mean now.
 */
export async function unmonitor(config) {
  const found = await survey(config, { force: true });
  const result = { v3: { count: 0 }, v2: { count: 0 } };

  const v3ids = (found.v3?.unmonitor || []).map((m) => m.id);
  if (v3ids.length) {
    await whisparr3.setMonitored(config, v3ids, false);
    result.v3 = { count: v3ids.length, ids: v3ids };

    // Start their clocks now rather than waiting for the next survey to notice.
    const book = await seen();
    const stamp = new Date().toISOString();
    for (const id of v3ids) book['v3:' + id] = stamp;
    await save();

    whisparr3.forgetHeld();
  }

  const v2ids = (found.v2?.unmonitor || []).map((e) => e.id);
  if (v2ids.length) {
    await whisparr.monitor(config, v2ids, false);
    result.v2 = { count: v2ids.length, ids: v2ids };
  }

  forgetFiled();
  return result;
}

/*
 * Remove what has been unmonitored for the full fortnight.
 *
 * **v3 only, and that is a constraint rather than a choice.** v2 is a Sonarr
 * fork: an episode cannot be deleted, only a whole series or an episode's file.
 * Deleting the series would take its entire catalogue with it — 15,836 episodes
 * for Playboy Plus alone — and mean re-pulling all of it to add one scene from
 * that site again. So the v2 half stops at unmonitored and stays there.
 *
 * Files go with it, and so does an import exclusion: a scene that has been
 * encoded and filed does not want fetching a second time.
 */
export async function remove(config) {
  const found = await survey(config, { force: true });
  const due = found.v3?.due || [];
  if (!due.length) return { count: 0, removed: [] };

  const ids = due.map((m) => m.id);
  await whisparr3.removeMovies(config, ids, { deleteFiles: true, addImportExclusion: true });

  const book = await seen();
  for (const id of ids) delete book['v3:' + id];
  await save();

  whisparr3.forgetHeld();
  forgetFiled();

  return { count: ids.length, removed: due.map((m) => ({ id: m.id, title: m.title, days: m.days })) };
}
