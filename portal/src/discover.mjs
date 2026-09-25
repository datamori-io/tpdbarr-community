/*
 * The acquisition search, on StashDB: its ids follow a scene into Whisparr v3
 * and Stash. ThePornDB is the separate wild card.
 *
 * "Have" is counted in Stash; Whisparr empties as files import, but is still
 * asked so monitored scenes aren't reported as gaps. About a third of the
 * library was identified against TPDB, so title and date is a second pass,
 * labelled `probable`.
 */

import * as stashdb from './stashdb.mjs';
import * as tpdb from './tpdb.mjs';
import * as stash from './stash.mjs';
import * as whisparr3 from './whisparr3.mjs';
import { loadConfig, stashConfigured, whisparr3Reachable, saveConfig } from './config.mjs';
import * as rules from './rules.mjs';
import { score as tasteOf, taste } from './taste.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PER_PAGE = 24;
const COVERAGE_TTL = 6 * 60 * 60 * 1000; // a catalogue does not move hourly
const COVERAGE_CAP = 3000; // scenes measured per tracked entity
const LANES = 3; // tracked entities measured at once

export const available = (config) => stashdb.available(config);

/*
 * ------------------------------------------------------- do I have this
 *
 * Exact first (a StashDB id in Stash), then title and date for the rest.
 */
export async function annotate(config, scenes) {
  if (!scenes.length) return [];

  const [owned, titles, inV3] = await Promise.all([
    stashConfigured(config)
      ? stashdb
          .endpointFor(config)
          .then((endpoint) => stash.ownedByStashIds(config, endpoint, scenes.map((s) => s.id)))
          .catch(() => new Map())
      : Promise.resolve(new Map()),
    stashConfigured(config) ? stash.titleDateIndex(config).catch(() => null) : Promise.resolve(null),
    whisparr3Reachable(config) ? whisparr3.allByStashId(config).catch(() => new Map()) : Promise.resolve(new Map()),
  ]);

  const marked = new Set(sceneList(config).map((s) => s.id));
  const dropped = new Set(ignoreList(config).map((s) => s.id));

  return scenes.map((scene) => {
    const id = String(scene.id).toLowerCase();
    const exact = owned.get(id);
    const probable = exact ? null : stash.matchByTitleDate(titles, scene);
    const held = Boolean(exact || probable);

    return {
      ...scene,
      tracked: marked.has(id) || held,
      disposition: dispositionOf({ ignored: dropped.has(id), wanted: marked.has(id), held }),
      stash: exact
        ? { ...exact, match: 'exact', via: 'StashDB id' }
        : probable
          ? { ...probable, match: 'probable', via: 'title + date' }
          : null,
      whisparr3: whisparr3.statusOf(inV3.get(id) || null),
    };
  });
}

/* ------------------------------------------------------------- searching */

/*
 * -> {available, count, hidden, scenes, page, perPage}
 *
 * `count` is StashDB's total for the query. `hidden` is how many on this page
 * were dropped as already held.
 */
/* StashDB pages one decide request may read. The cursor makes an empty answer progress. */
const DECIDE_PAGES = 8;

/*
 * The decide queue. Can't be paged: dropped scenes make page numbers
 * meaningless. Walks StashDB from a cursor until it has a batch; a null
 * cursor is the end.
 */
async function decideBatch(config, params, perPage) {
  const from = Math.max(1, Number(params.cursor) || 1);
  const standing = decideRules(config);
  const mine = params.ranked ? await taste(config).catch(() => null) : null;

  const out = [];
  let page = from;
  let count = 0;
  let last = 1;
  // What the rules took on the way past, so the queue can say so rather than
  // quietly handing you a shorter batch than it read.
  let ruled = 0;

  for (let read = 0; read < DECIDE_PAGES; read++) {
    const input = stashdb.sceneQuery({ ...params, page, perPage: PER_PAGE });
    const { count: total, scenes } = await stashdb.queryScenes(config, input);

    count = total;
    last = Math.max(1, Math.ceil(total / PER_PAGE));

    const annotated = await annotate(config, scenes);

    for (const scene of annotated) {
      if (scene.disposition !== 'undecided') continue;
      if (standing.length && rules.caughtBy(scene, standing)) { ruled += 1; continue; }
      if (mine) scene.taste = tasteOf(scene, mine);
      out.push(scene);
    }

    page += 1;
    if (page > last || out.length >= perPage) break;
  }

  rank(out, mine);

  return {
    available: true,
    count,
    hidden: 0,
    ignored: 0,
    ruled,
    scenes: out,
    show: 'undecided',
    perPage,
    // Where to pick this up. Null means the catalogue is exhausted, which is
    // the only honest way to say "nothing left" — an empty batch is not.
    cursor: page > last ? null : page,
  };
}

/*
 * ------------------------------------------------------ everything at once
 *
 * The same queue over every tracked catalogue. The cursor is
 * `<which>:<page>`. Walked in list order. Scenes are deduplicated within a batch.
 */
async function pooledBatch(config, params, perPage) {
  // May be the first request after a restart; load the measurements first.
  await warmCoverage(config);

  const entries = tracked(config);
  const standing = decideRules(config);
  const mine = params.ranked ? await taste(config).catch(() => null) : null;

  const [fromAt, fromPage] = String(params.cursor || '0:1').split(':');
  let at = Math.max(0, Number(fromAt) || 0);
  let page = Math.max(1, Number(fromPage) || 1);

  const out = [];
  const seen = new Set();
  let ruled = 0;

  /* Skip catalogues already finished, per the measurements. Unmeasured ones are read. */
  const done = new Map();
  for (const row of coverageSnapshot(config).rows) {
    if (!row.pending) done.set(keyOf(row), row.undecided || 0);
  }
  const step = (i) => {
    let next = i;
    while (next < entries.length && done.get(keyOf(entries[next])) === 0) next += 1;
    return next;
  };

  at = step(at);

  for (let read = 0; read < DECIDE_PAGES && at < entries.length && out.length < perPage; read++) {
    const input = {
      ...filterFor(entries[at]),
      page,
      per_page: PER_PAGE,
      sort: ['DATE', 'TITLE', 'DURATION', 'TRENDING', 'POPULARITY', 'CREATED_AT'].includes(params.sort)
        ? params.sort
        : 'DATE',
      direction: params.direction === 'ASC' ? 'ASC' : 'DESC',
    };

    const { count, scenes } = await stashdb.queryScenes(config, input);
    const last = Math.max(1, Math.ceil(count / PER_PAGE));
    const annotated = await annotate(config, scenes);

    for (const scene of annotated) {
      if (scene.disposition !== 'undecided') continue;
      if (seen.has(scene.id)) continue;
      seen.add(scene.id);
      if (standing.length && rules.caughtBy(scene, standing)) { ruled += 1; continue; }
      if (mine) scene.taste = tasteOf(scene, mine);
      out.push(scene);
    }

    page += 1;
    if (page > last) { at = step(at + 1); page = 1; }
  }

  rank(out, mine);

  /* Total from the tracked page's measurements. Null while any is still measuring. */
  const { rows } = coverageSnapshot(config);
  const outstanding = rows.some((row) => row.pending)
    ? null
    : rows.reduce((sum, row) => sum + (row.undecided || 0), 0);

  return {
    available: true,
    count: outstanding ?? 0,
    hidden: 0,
    ignored: 0,
    ruled,
    outstanding,
    catalogues: entries.length,
    scenes: out,
    show: 'undecided',
    pooled: true,
    perPage,
    cursor: at >= entries.length ? null : `${at}:${page}`,
  };
}

/*
 * Rank within the batch read (a full ranking would mean reading everything).
 * Ties keep their order; zero scores sink but aren't dropped.
 */
function rank(scenes, mine) {
  if (!mine) return scenes;
  return scenes.sort((a, b) => (b.taste?.score || 0) - (a.taste?.score || 0));
}

export async function search(config, params = {}) {
  if (!(await available(config))) {
    return { available: false, count: 0, hidden: 0, ignored: 0, scenes: [], page: 1, perPage: PER_PAGE };
  }

  if (params.show === 'undecided') {
    const perPage = Math.min(60, Math.max(1, Number(params.perPage) || PER_PAGE));
    return params.pooled
      ? pooledBatch(config, params, perPage)
      : decideBatch(config, params, perPage);
  }

  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(60, Math.max(1, Number(params.perPage) || PER_PAGE));

  const input = stashdb.sceneQuery({ ...params, page, perPage });
  const { count, scenes } = await stashdb.queryScenes(config, input);
  const annotated = await annotate(config, scenes);

  /* Decided scenes are dropped unless you asked to see them. */
  const show = params.show === 'all' ? 'all' : 'open';

  let shown = annotated;
  if (show === 'open') shown = shown.filter((s) => s.disposition !== 'ignored');

  const ignored = annotated.filter((s) => s.disposition === 'ignored').length;

  // Owned scenes are hidden separately.
  const held = shown.filter((s) => s.stash).length;
  if (params.have !== 'all') shown = shown.filter((s) => !s.stash);

  return {
    available: true,
    count,
    hidden: params.have === 'all' ? 0 : held,
    ignored: show === 'open' ? ignored : 0,
    scenes: shown,
    page,
    perPage,
    show,
  };
}

/* The wild card, only on request, never blended in. */
export async function wildcard(config, term, { limit = 24 } = {}) {
  if (!term) return { available: false, scenes: [] };
  if (!(await tpdb.available(config))) return { available: false, scenes: [] };

  const scenes = await tpdb.searchScenes(config, term, { limit });

  // TPDB cards carry fingerprints for the bridge; the browser never needs them.
  for (const scene of scenes) {
    delete scene.phashes;
    delete scene.oshashes;
  }

  return { available: true, scenes };
}

/*
 * --------------------------------------------------------- the filter chips
 *
 * Asked of StashDB so aliases match.
 */
export async function lookup(config, kind, term, { limit = 10 } = {}) {
  if (!term || !(await available(config))) return [];

  if (kind === 'studio') return stashdb.searchStudios(config, term, { limit });
  if (kind === 'performer') return stashdb.searchPerformers(config, term, { limit });
  if (kind === 'tag') return stashdb.searchTags(config, term, { limit });

  const [studios, performers, tags] = await Promise.all([
    stashdb.searchStudios(config, term, { limit: 5 }).catch(() => []),
    stashdb.searchPerformers(config, term, { limit: 5 }).catch(() => []),
    stashdb.searchTags(config, term, { limit: 5 }).catch(() => []),
  ]);

  return [...performers, ...studios, ...tags];
}

/* Turn ids from a bookmarked URL back into names. */
export async function resolveChips(config, { studios = [], performers = [], tags = [] } = {}) {
  if (!(await available(config))) return { studios: [], performers: [], tags: [] };

  const many = (list, get) => Promise.all(list.map((id) => get(config, id).catch(() => null)));

  const [s, p, t] = await Promise.all([
    many(studios, stashdb.getStudio),
    many(performers, stashdb.getPerformer),
    many(tags, stashdb.getTag),
  ]);

  return { studios: s.filter(Boolean), performers: p.filter(Boolean), tags: t.filter(Boolean) };
}

/*
 * ------------------------------------------------------------- what I track
 *
 * Only tracked catalogues get a percentage.
 */

const trackedList = (config) => ({
  studios: config.tracked?.studios || [],
  performers: config.tracked?.performers || [],
  /*
   * Tags share the machinery, but a percentage rarely means much for a tag.
   * See coverageSnapshot.
   */
  tags: config.tracked?.tags || [],
  // Carried through every save so that marking a studio does not drop the
  // want list, and marking a scene does not drop the studios.
  scenes: config.tracked?.scenes || [],
  ignored: config.tracked?.ignored || [],
});

/*
 * ------------------------------------------------------------- the rules
 *
 * The standing noes. Cleaned on read: a blank rule would match everything or nothing.
 */
export const decideRules = (config) => rules.cleanAll(config.decideRules);

/* Changing rules recounts (no re-measure). See recount(). */
export async function setDecideRules(config, list) {
  const clean = rules.cleanAll(list);
  await saveConfig({ decideRules: clean });
  await recount(await loadConfig());
  return { rules: clean };
}

const keyOf = (entry) => `${entry.kind}:${entry.id}:${entry.scope || 'self'}`;

export function tracked(config) {
  const { studios, performers, tags } = trackedList(config);
  return [...performers, ...studios, ...tags];
}

const BUCKET = { performer: 'performers', studio: 'studios', tag: 'tags' };

export async function track(config, entry) {
  const kind = BUCKET[entry.kind] ? entry.kind : 'studio';
  const scope = kind === 'studio' && entry.scope === 'network' ? 'network' : 'self';

  const record = {
    kind,
    id: String(entry.id || ''),
    name: String(entry.name || '').slice(0, 200),
    image: entry.image || null,
    scope,
  };
  if (!record.id || !record.name) throw new Error('A tracked catalogue needs an id and a name.');

  const list = trackedList(config);
  const bucket = BUCKET[kind];
  const without = list[bucket].filter((e) => keyOf(e) !== keyOf(record));

  await saveConfig({ tracked: { ...list, [bucket]: [...without, record] } });
  return record;
}

export async function untrack(config, kind, id) {
  const list = trackedList(config);
  const bucket = BUCKET[kind] || 'studios';

  await saveConfig({ tracked: { ...list, [bucket]: list[bucket].filter((e) => e.id !== id) } });

  for (const cacheKey of [...measured.keys()]) {
    if (cacheKey.startsWith(`${kind}:${id}:`)) measured.delete(cacheKey);
  }
}

export function isTracked(config, kind, id) {
  return tracked(config).some((e) => e.kind === kind && e.id === id);
}

/*
 * ------------------------------------------------------------ tracked scenes
 *
 * The want list, kept here because Whisparr is emptied as scenes import.
 * Keyed on the StashDB scene id, which the file carries into Stash.
 */

const sceneList = (config) => config.tracked?.scenes || [];

export function trackedScenes(config, { studio = null, performer = null } = {}) {
  const all = sceneList(config);
  const here = studio ? all.filter((s) => s.studioId === studio) : all;

  // The cast is kept on the record for exactly this: a want list read by
  // performer costs no more than one read by studio does.
  return performer ? here.filter((s) => (s.performers || []).some((p) => p.id === performer)) : here;
}

/* Enough of the scene to redraw its card without a StashDB read. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function trackScene(config, scene) {
  const id = String(scene.id || '').toLowerCase();
  if (!UUID.test(id)) throw new Error('A tracked scene needs its StashDB id.');

  const record = {
    id,
    title: String(scene.title || '').slice(0, 300) || '(untitled)',
    date: scene.date || '',
    image: scene.image || null,
    url: scene.url || `https://stashdb.org/scenes/${id}`,
    duration: scene.duration || null,
    // Cut here rather than on the card: the card's own trim is about the row it
    // sits in, this one is about not carrying paragraphs around in the config.
    details: String(scene.details || '').slice(0, 600),
    studioId: scene.studio?.id || null,
    studioName: scene.studio?.name || scene.studioName || '',
    performers: (scene.performers || []).slice(0, 12).map((p) => ({ id: p.id || null, name: p.name })),
    at: new Date().toISOString(),
  };

  const list = trackedList(config);
  await saveConfig({ tracked: { ...list, scenes: [...list.scenes.filter((s) => s.id !== id), record] } });

  // A want moves the counts exactly as a skip does — undecided down by one,
  // missing up by one — and it used to move nothing. See recount().
  await recount(await loadConfig());
  return record;
}

/*
 * Fill fields older marks lack. Only records missing something are asked
 * about. Saved a chunk at a time against a fresh config so marks made
 * meanwhile survive.
 */
const BACKFILL_CHUNK = 120;

export async function backfillSceneDetails(config) {
  const stale = sceneList(config).filter((s) => s.details === undefined).map((s) => s.id);
  if (!stale.length) return { asked: 0, filled: 0, gone: 0, remaining: 0 };

  let filled = 0;
  let gone = 0;

  for (let i = 0; i < stale.length; i += BACKFILL_CHUNK) {
    const chunk = stale.slice(i, i + BACKFILL_CHUNK);
    const found = await stashdb.scenesByIds(config, chunk);

    const fresh = await loadConfig();
    const list = trackedList(fresh);
    const scenes = list.scenes.map((scene) => {
      if (!chunk.includes(scene.id) || scene.details !== undefined) return scene;

      const card = found.get(scene.id);
      // A scene StashDB no longer has still gets the field, as an empty string.
      // Left undefined it would be asked about again on every run for ever.
      if (card) filled++; else gone++;
      return { ...scene, details: String(card?.details || '').slice(0, 600) };
    });

    await saveConfig({ tracked: { ...list, scenes } });
  }

  const left = sceneList(await loadConfig()).filter((s) => s.details === undefined).length;
  return { asked: stale.length, filled, gone, remaining: left };
}

export async function untrackScene(config, id) {
  const wanted = String(id).toLowerCase();
  const list = trackedList(config);
  await saveConfig({ tracked: { ...list, scenes: list.scenes.filter((s) => s.id !== wanted) } });
  await recount(await loadConfig());
}

/*
 * ------------------------------------------------------------ dispositions
 *
 * Every scene in a tracked catalogue is one of:
 *
 *   ignored    — not for me; out of results and numbers
 *   tracked    — wanted, or already held (owning counts, no press needed)
 *   undecided  — what's left
 *
 * The ignore list is ids only.
 */

const ignoreList = (config) => config.tracked?.ignored || [];

function dispositionOf({ ignored, wanted, held }) {
  if (ignored) return 'ignored';
  if (held || wanted) return 'tracked';
  return 'undecided';
}

export async function ignoreScene(config, id) {
  const wanted = String(id || '').toLowerCase();
  if (!UUID.test(wanted)) throw new Error('An ignored scene needs its StashDB id.');

  const list = trackedList(config);

  // Ignoring is also the way to take something off the want list — otherwise
  // "not for me" would leave the thing sitting in what you asked for.
  await saveConfig({
    tracked: {
      ...list,
      scenes: list.scenes.filter((s) => s.id !== wanted),
      ignored: [...list.ignored.filter((s) => s.id !== wanted), { id: wanted, at: new Date().toISOString() }],
    },
  });

  await recount(await loadConfig());
}

/*
 * Ignore many in one write.
 * -> how many were newly added.
 */
export async function ignoreScenes(config, ids = []) {
  const wanted = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').toLowerCase())
      .filter((id) => UUID.test(id))
  )];

  if (!wanted.length) return { skipped: 0 };

  const list = trackedList(config);
  const already = new Set(list.ignored.map((s) => s.id));
  const fresh = wanted.filter((id) => !already.has(id));
  const at = new Date().toISOString();

  await saveConfig({
    tracked: {
      ...list,
      // Skipping is also how something comes off the want list — the same rule
      // ignoreScene() follows, applied to the whole batch at once.
      scenes: list.scenes.filter((s) => !wanted.includes(s.id)),
      ignored: [...list.ignored.filter((s) => !wanted.includes(s.id)), ...wanted.map((id) => ({ id, at }))],
    },
  });

  await recount(await loadConfig());
  return { skipped: fresh.length, asked: wanted.length };
}

/*
 * ------------------------------------------------------- the rest of it
 *
 * Skip everything a filter still returns. A background job, one at a time,
 * because it reads StashDB page by page and checks each against Stash.
 */
let sweeping = null;
let sweep = { running: false, done: 0, skipped: 0, count: 0, error: null, subject: '', at: 0 };

export const sweepStatus = () => ({ ...sweep, running: Boolean(sweeping) });

/* Written every 200, so an interrupted sweep keeps its progress. */
const SWEEP_WRITE_EVERY = 200;

async function sweepRun(config, params) {
  const from = Math.max(1, Number(params.cursor) || 1);
  let page = from;
  let held = [];

  const flush = async () => {
    if (!held.length) return;
    // Re-read: the file has been written since this job started, by this job.
    const { skipped } = await ignoreScenes(await loadConfig(), held);
    sweep.skipped += skipped;
    held = [];
  };

  for (;;) {
    const input = stashdb.sceneQuery({ ...params, page, perPage: PER_PAGE });
    const { count, scenes } = await stashdb.queryScenes(config, input);

    sweep.count = count;
    const last = Math.max(1, Math.ceil(count / PER_PAGE));

    const annotated = await annotate(await loadConfig(), scenes);
    held.push(...annotated.filter((s) => s.disposition === 'undecided').map((s) => s.id));

    sweep.done += scenes.length;
    sweep.at = Date.now();

    if (held.length >= SWEEP_WRITE_EVERY) await flush();

    page += 1;
    if (page > last) break;
  }

  await flush();
  return sweep.skipped;
}

export function skipRest(config, params = {}) {
  if (sweeping) return sweepStatus();

  sweep = {
    running: true,
    done: 0,
    skipped: 0,
    count: 0,
    error: null,
    subject: String(params.studios?.[0] || params.performers?.[0] || ''),
    at: Date.now(),
  };

  sweeping = sweepRun(config, params)
    .catch((err) => {
      console.error('[tpdbarr] skip the rest', err.message);
      sweep.error = err.message;
    })
    .finally(() => {
      sweeping = null;
      sweep.running = false;
      sweep.at = Date.now();
    });

  return sweepStatus();
}

export async function unignoreScene(config, id) {
  const wanted = String(id || '').toLowerCase();
  const list = trackedList(config);
  await saveConfig({ tracked: { ...list, ignored: list.ignored.filter((s) => s.id !== wanted) } });
  await recount(await loadConfig());
}

/* The want list, annotated like search results. `missing` is the count that matters. */
/*
 * Wanted scenes no tracked catalogue covers. Matched on studio and cast;
 * tags can't be matched (want records don't store them).
 */
function orphaned(config, scenes) {
  const { studios, performers } = trackedList(config);
  const studioIds = new Set(studios.map((e) => String(e.id)));
  const performerIds = new Set(performers.map((e) => String(e.id)));
  if (!studioIds.size && !performerIds.size) return scenes;

  return scenes.filter((scene) => {
    if (scene.studioId && studioIds.has(String(scene.studioId))) return false;
    return !(scene.performers || []).some((p) => p.id && performerIds.has(String(p.id)));
  });
}

/*
 * Having a file anywhere in the pipeline counts, including v3's download.
 * Monitored doesn't.
 */
export const haveFile = (scene) => Boolean(scene.stash || scene.whisparr3?.hasFile);

export async function trackedSceneView(config, { studio = null, performer = null, loose = false } = {}) {
  /* On a studio or performer page, don't drop what that catalogue covers. */
  const narrowed = Boolean(studio || performer);
  const all = trackedScenes(config, { studio, performer });
  const wanted = loose && !narrowed ? orphaned(config, all) : all;
  const scenes = await annotate(config, wanted.map(({ at, studioId, ...card }) => ({ ...card, studioId })));

  // Newest first, the way every other list of scenes in here is ordered.
  scenes.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return {
    scenes,
    count: scenes.length,
    missing: scenes.filter((s) => !haveFile(s)).length,
    loose: Boolean(loose) && !narrowed,
    // What the toggle is hiding, so the page can say how many that is without
    // asking for the whole list a second time.
    all: all.length,
  };
}

/* --------------------------------------------------------------- coverage */

const measured = new Map(); // keyOf(entry) -> {at, row}
let measuring = null;

/*
 * -------------------------------------------------- measurements on disk
 *
 * Coverage is cached to disk so a restart doesn't re-read StashDB. Each row
 * keeps its time; past six hours it's re-measured. The file is dropped if
 * the rules it was measured under have changed.
 */
const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const COVERAGE_PATH = join(CONFIG_DIR, 'coverage.json');

const rulesStamp = (config) => JSON.stringify(decideRules(config));

let warmed = null;

async function warmCoverage(config) {
  if (warmed) return warmed;

  warmed = (async () => {
    const raw = await readFile(COVERAGE_PATH, 'utf8').catch(() => null);
    if (!raw) return;

    try {
      const saved = JSON.parse(raw);
      if (saved?.rules !== rulesStamp(config)) return;

      /*
       * Stale rows are loaded and shown while ensureCoverage() re-reads them.
       * A rules mismatch still drops the whole file.
       */
      for (const [key, hit] of Object.entries(saved.rows || {})) {
        if (!hit?.row) continue;
        measured.set(key, { at: hit.at || 0, row: hit.row });
      }
    } catch {
      // A half-written or hand-edited file is not worth a stack trace. The
      // measurements simply start empty, which is where they were before.
    }
  })();

  return warmed;
}

/* Written once per pass. */
async function keepCoverage(config) {
  const rows = {};
  for (const [key, hit] of measured) rows[key] = hit;

  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(COVERAGE_PATH, JSON.stringify({ rules: rulesStamp(config), rows }, null, 2), 'utf8');
  } catch (err) {
    // A cache that cannot be written is still a cache that works, in memory,
    // until the next restart. Said once rather than thrown.
    console.warn('[tpdbarr] coverage could not be saved -', err.message);
  }
}

/*
 * What each catalogue was measured from, kept in memory so decisions can be
 * counted without a fetch. Rebuilt by the next pass after a restart.
 */
const inputs = new Map(); // keyOf(entry) -> gather() result

/*
 * A decision was made: recount, don't re-measure.
 *
 * classify() over the list in memory, so counts move at once and the page
 * never blanks. A real measurement is still needed (row kept, marked stale)
 * when nothing is in memory after a restart, or a new rule needs a field
 * this copy lacks.
 */
export async function recount(config) {
  const standing = decideRules(config);
  const needRich = rules.needsRich(standing);
  const needCast = rules.needsCast(standing);

  let stale = 0;

  for (const entry of tracked(config)) {
    const key = keyOf(entry);
    const got = inputs.get(key);
    const hit = measured.get(key);

    if (!got || (needRich && !got.rich) || (needCast && !got.cast)) {
      // Past its life as far as ensureCoverage is concerned, so it is the
      // first thing the next pass re-reads — and still on screen until then.
      if (hit) hit.at = 0;
      stale++;
      continue;
    }

    measured.set(key, { at: hit?.at || Date.now(), row: classify(config, entry, got) });
  }

  await keepCoverage(config);

  // Start the re-read now.
  if (stale) ensureCoverage(config).catch(() => {});
}

/* What the page renders. Unmeasured rows come back pending. */
/* Above COVERAGE_CAP the percentage is of a sample, so the bar is hidden. */
const HONEST_PCT = COVERAGE_CAP;

export function coverageSnapshot(config) {
  const rows = tracked(config).map((entry) => {
    const hit = measured.get(keyOf(entry));
    const row = hit
      ? { ...hit.row, measuredAt: hit.at, pending: false }
      : { ...entry, total: null, have: null, pct: null, pending: true };

    /* Size decides, not kind. */
    row.honest = row.pending || (!row.capped && (row.total || 0) <= HONEST_PCT);
    return row;
  });

  // Least complete first: the whole point of the number is what is missing.
  rows.sort((a, b) => (a.pct ?? 999) - (b.pct ?? 999));
  return { rows, measuring: Boolean(measuring) };
}

export async function ensureCoverage(config, { force = false } = {}) {
  await warmCoverage(config);
  if (measuring) return coverageSnapshot(config);

  /*
   * Also re-read catalogues with counts but nothing in memory (after a
   * restart), so the first skip can be counted in place.
   */
  const stale = tracked(config).filter((entry) => {
    const key = keyOf(entry);
    const hit = measured.get(key);
    return force || !hit || !inputs.has(key) || Date.now() - hit.at > COVERAGE_TTL;
  });

  if (!stale.length) return coverageSnapshot(config);

  measuring = (async () => {
    const queue = [...stale];
    try {
      await Promise.all(
        Array.from({ length: Math.min(LANES, queue.length) }, async () => {
          while (queue.length) {
            const entry = queue.shift();
            try {
              measured.set(keyOf(entry), { at: Date.now(), row: await measure(config, entry) });
            } catch (err) {
              // The row this would have replaced stays. See gather().
              console.warn('[tpdbarr] coverage failed for', entry.name, '-', err.message);
            }
          }
        })
      );
    } finally {
      measuring = null;
    }
    // Stamped with the current config.
    await keepCoverage(await loadConfig());
  })();

  return coverageSnapshot(config);
}

/*
 * Measure one tracked catalogue: gather() is the slow network half,
 * classify() the instant count.
 */
async function measure(config, entry) {
  const got = await gather(config, entry);
  inputs.set(keyOf(entry), got);

  /* Counted against the current config, so decisions made during the pass count. */
  return classify(await loadConfig(), entry, got);
}

/*
 * The slow half: what the catalogue is and which of it you hold. Doesn't
 * change with decisions. A failed lookup fails the measurement rather than
 * recording 0%. Whisparr failures are tolerated (only `onTheWay` depends on it).
 */
async function gather(config, entry) {
  const standing = decideRules(config);
  const rich = rules.needsRich(standing);
  const cast = rules.needsCast(standing);

  const { scenes, total, capped } = await stashdb.sceneBriefs(config, filterFor(entry), {
    cap: COVERAGE_CAP,
    rich,
    cast,
  });

  const owned = new Set();
  const probable = new Set();
  const coming = new Set();

  if (scenes.length) {
    const [have, titles, inV3] = await Promise.all([
      stashConfigured(config)
        ? stashdb
            .endpointFor(config)
            .then((endpoint) => stash.ownedByStashIds(config, endpoint, scenes.map((s) => s.id)))
        : Promise.resolve(new Map()),
      stashConfigured(config) ? stash.titleDateIndex(config) : Promise.resolve(null),
      whisparr3Reachable(config) ? whisparr3.allByStashId(config).catch(() => new Map()) : Promise.resolve(new Map()),
    ]);

    for (const scene of scenes) {
      const id = String(scene.id).toLowerCase();
      if (have.has(id)) owned.add(id);
      else if (stash.matchByTitleDate(titles, scene)) probable.add(id);
      if (inV3.get(id)?.monitored) coming.add(id);
    }
  }

  // `rich` and `cast` travel with the scenes, because a rule added later may
  // need a field this copy was fetched without — see recount().
  return { scenes, total, capped, owned, probable, coming, rich, cast };
}

/*
 * The instant half: sort into ignored, held, wanted-but-missing, undecided.
 * Pure. The denominator is what you want, not all of StashDB.
 */
function classify(config, entry, got) {
  const standing = decideRules(config);
  const wanted = new Set(sceneList(config).map((s) => s.id));
  const dropped = new Set(ignoreList(config).map((s) => s.id));

  let have = 0;
  let probable = 0;
  let onTheWay = 0;
  let missing = 0;
  let undecided = 0;
  let ignored = 0;
  // Rule-hidden scenes counted apart from undecided.
  let ruled = 0;

  for (const scene of got.scenes) {
    const id = String(scene.id).toLowerCase();

    if (dropped.has(id)) {
      ignored++;
      continue;
    }

    if (got.owned.has(id)) {
      have++;
    } else if (got.probable.has(id)) {
      have++;
      probable++;
    } else if (wanted.has(id)) {
      missing++;
      if (got.coming.has(id)) onTheWay++;
    } else if (standing.length && rules.caughtBy(scene, standing)) {
      ruled++;
    } else {
      undecided++;
    }
  }

  // Everything a decision has been made about, one way or the other, minus the
  // ones the decision was "no".
  const counted = have + missing;

  return {
    ...entry,
    total: got.total,
    counted,
    capped: got.capped,
    have,
    probable,
    onTheWay,
    undecided,
    ignored,
    ruled,
    missing,
    pct: counted ? Math.round((have / counted) * 100) : 0,
  };
}

/* A network is filtered by its parent studio's UUID. */
function filterFor(entry) {
  if (entry.kind === 'performer') return stashdb.sceneQuery({ performers: [entry.id] });
  if (entry.kind === 'tag') return stashdb.sceneQuery({ tags: [entry.id] });
  if (entry.scope === 'network') return stashdb.sceneQuery({ parentStudio: entry.id });
  return stashdb.sceneQuery({ studios: [entry.id] });
}
