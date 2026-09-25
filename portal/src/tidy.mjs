/*
 * Tidying Whisparr behind the pipeline.
 *
 * Once Stash has filed a scene, Whisparr monitoring it is leftover. Two
 * buttons, never automatic:
 *
 *   1. Unmonitor what Stash has filed. Reversible.
 *   2. Remove what's been unmonitored for 15 days. Only if Stash has a copy.
 *
 * v3 has autoUnmonitorPreviouslyDownloadedMovies on and unmonitors on its
 * own when FileFlows moves a file; v2's equivalent is off. So step 1 is
 * mostly for v2, and step 2 is the value on v3.
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

/*
 * ------------------------------------------------------------ the watermark
 *
 * Whisparr doesn't record when something was unmonitored, so the 15 days
 * are timed here, from when a survey first sees it unmonitored. A lost file
 * only makes the wait longer.
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

/*
 * ------------------------------------------------------------- what is filed
 *
 * Only /organized_scenes counts as landed. /movies came through Emby, not Whisparr.
 */

const FILED = { path: { value: '/organized_scenes/', modifier: 'INCLUDES' } };

const normalise = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '');

const INDEX_TTL = 5 * 60 * 1000;
let filedCache = null;

export const forgetFiled = () => { filedCache = null; };

/*
 * Filed scenes, indexed for joining to Whisparr. v3 joins exactly on the
 * StashDB UUID; the rest fall back to title + date. v2 has no exact join:
 * its tvdbId is TPDB's numeric id, Stash stores TPDB's UUID.
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

/* What there is to tidy. Reads only. Each Whisparr is optional. */
let surveying = null;

export async function survey(config, { force = false } = {}) {
  /*
   * One survey at a time; concurrent ones overloaded and came back empty.
   * A forced pass (from the writes) never shares.
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

      /* Removal needs Stash to hold it: otherwise the file may be the only copy. */
      if (!hit) continue;

      const row = {
        id: movie.id, title: movie.title, date: isoDate(movie.releaseDate),
        studio: movie.studioTitle || null, hasFile: !!movie.hasFile,
        sceneId: hit.scene.id, matchedBy: hit.by,
        since: book[key], days,
      };

      (days >= HOLD_DAYS ? v3.due : v3.waiting).push(row);
    }

    /* Grabbed but not in Stash yet: the front of the pipeline, for the Overview. */
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

/* Only v2's monitored episodes are carried. */
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

/* Unmonitor everything filed. Re-surveys rather than trusting posted ids. */
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
 * Remove what's been unmonitored 15 days. v3 only: v2 can't delete one
 * episode, only a whole series. Deletes files and adds an import exclusion.
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
