/*
 * Group Builder — the films your loose scenes already add up to.
 *
 * Two thousand three hundred and eighty-seven scenes in this library sit in no
 * group at all, and six groups exist. Some of those scenes are not loose at
 * all: they are two, three, four parts of a release somebody sold as one thing,
 * filed separately because that is how they arrived. This finds those, shows
 * you the case for each, and builds the group only once you have said yes.
 *
 * **Nothing here writes to Stash without a decision.** A pass produces
 * proposals and stops. That is not caution for its own sake — every proposal
 * below the exact tier is a guess, and a group built on a wrong guess is a
 * wrong fact about your library that then has to be found and undone.
 *
 * ------------------------------------------------------------------ sources
 *
 * Asked in this order, and the proposal says which one answered.
 *
 * 1. **ThePornDB's own scene list.** A movie record can carry the scenes it is
 *    made of, each with the id the rest of this portal already matches on. When
 *    it does, membership is a fact rather than a guess and the proposal says
 *    *exact*. Measured on 2026-09-03: of four hundred ungrouped scenes sampled,
 *    three were in a TPDB movie, and all 291 Pure Taboo movies TPDB knows about
 *    come back with an empty scene list. So this tier is right and rare.
 *
 * 2. **Bang's DVD pages.** One row per scene *with its title*, which is the
 *    thing neither source either side of this one has. A scene is matched when
 *    its title and the row's title are the same title once the punctuation is
 *    out of the way, and the proposal says *likely*. Cast is a tie-break for
 *    two of your scenes sharing a title and is never the match itself.
 *
 *    Bang carries DVD releases and nothing web-only, so it answers for the
 *    catalogue studios and has nothing whatever for Pure Taboo. It is asked
 *    first because it is the same two pages IAFD costs and the better answer
 *    when it lands — see bang.mjs, which also carries why reading it is fine
 *    where reading AdultEmpire is not.
 *
 * 3. **GameLink's movie pages.** The AdultEmpire catalogue reached at the one
 *    address of theirs that is open. One row per scene with its cast and a set
 *    of attributes, and **no titles** — so it is the same class of evidence as
 *    IAFD below, matched the same way and labelled *probable* the same way.
 *
 *    It is here for reach rather than for strength: 150,000-odd films, and it
 *    answers for studios the other legs do not — Pure Taboo's "The Family
 *    Tradition" comes back with its scenes from GameLink and with nothing at
 *    all from Bang. Asked before IAFD only because it costs one page instead
 *    of two. Its search is not crawled at all; Stash's own GameLink scraper is
 *    asked which film this is, and this module then fetches that one page. See
 *    gamelink.mjs for why reading it is fine where AdultEmpire is not.
 *
 * 4. **IAFD's Scene Breakdowns.** One row per scene, listing its performers and
 *    nothing else — no titles, no ids. A scene is matched to a row when its
 *    cast is exactly that row's cast. That is how a person would do it and it
 *    is still a guess, so the proposal says *probable* and shows the cast it
 *    matched on.
 *
 *    Deliberately **not** restricted to scenes filed under the studio being
 *    scanned. A DVD gathers scenes from sibling labels — the one New Sensations
 *    release this library holds a piece of has that piece filed under FamilyXXX —
 *    so a studio-scoped match finds nothing and looks like an empty catalogue.
 *    Where a matched scene is filed somewhere else, the row says so.
 *
 * **AdultEmpire and data18 are absent, and it is not an oversight.** Both say
 * this better than either source above. Every AdultEmpire page redirects to
 * /AgeConfirmation and every one of its search paths is disallowed in
 * robots.txt; data18 answers a plain fetch with a 403. Reading either means
 * forging a consent that was not given or getting around a wall that was put
 * there on purpose — the same line groupurl.mjs drew when it chose
 * adultfilmdatabase over both. What AdultEmpire *is* used for is its address:
 * TPDB hands one over on the movie record, and a built group carries it so that
 * Stash's own scraper — which does walk through that gate, with your consent,
 * from your machine — can fill the group in afterwards.
 *
 * timestamp.trade is absent for a duller reason: its robots.txt disallows
 * /scene/ and /movie/ outright.
 *
 * -------------------------------------------------------------- the answers
 *
 * A proposal ends in one of two places and both are remembered.
 *
 *   approved — the group is created, the scenes you hold are filed into it, and
 *              what the film is missing becomes a short list of decisions.
 *   declined — not a film, or not one worth having. It goes quiet.
 *
 * A decline is not forever, and the rule is narrow on purpose: the proposal
 * comes back **only if you later hold a scene of that film you did not hold
 * when you declined it**. Not when the scan reruns, not when TPDB changes its
 * mind about the cover. The thing that made you say no was the shape of the
 * evidence, and the only event that genuinely changes it is new evidence.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import * as tpdb from './tpdb.mjs';
import * as iafd from './iafd.mjs';
import * as bang from './bang.mjs';
import * as gamelink from './gamelink.mjs';
import * as stashdb from './stashdb.mjs';
import * as whisparr from './whisparr.mjs';
import * as whisparr3 from './whisparr3.mjs';
import * as discover from './discover.mjs';
import { gql, forgetGroups } from './stash.mjs';
import { stashConfigured, whisparr2Configured, whisparr3Reachable } from './config.mjs';
import { heldForV2, heldForV3, refusal } from './heldguard.mjs';

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'groupbuilder.json');

/* Scans are expensive and slow to change, so they're kept on disk. */
const TTL = 7 * 24 * 60 * 60 * 1000;

// The whole pass gets this long, then publishes what it has and says it did.
const DEADLINE = 20 * 60 * 1000;

/*
 * Three at a time: six hit TPDB's rate limit hundreds of times per pass.
 * IAFD is paced one page at a time by iafd.mjs.
 */
const TPDB_AT_A_TIME = 3;

/* IAFD films per pass: ~3 minutes at two pages each. Big studios take several runs. */
const IAFD_PER_PASS = 40;

/* A one-scene film isn't a group. Stub records list a single scene. */
const CREDIBLE = 2;

let cache = null;
let loading = null;
let running = null;
let progress = { studio: null, looked: 0, total: 0, phase: null };

export const forgetGroupBuilder = () => { cache = null; };

const EMPTY = { studios: {}, proposals: {}, decisions: {}, scenes: {}, iafd: {}, movies: {} };

async function store() {
  if (cache) return cache;
  if (loading) return loading;

  loading = (async () => {
    try {
      const parsed = JSON.parse(await readFile(PATH, 'utf8'));
      cache = { ...EMPTY, ...parsed };
      for (const key of Object.keys(EMPTY)) {
        if (!cache[key] || typeof cache[key] !== 'object') cache[key] = {};
      }
    } catch {
      // Missing or corrupt: start empty. Decisions matter most, hence the atomic write.
      cache = { studios: {}, proposals: {}, decisions: {}, scenes: {}, iafd: {}, movies: {} };
    } finally {
      loading = null;
    }
    return cache;
  })();

  return loading;
}

// Temp file then rename. A crash mid-write must not be able to leave something
// that parses as "you have never decided anything".
async function save() {
  if (!cache) return;
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    const temp = PATH + '.tmp';
    await writeFile(temp, JSON.stringify(cache, null, 2), 'utf8');
    await rename(temp, PATH);
  } catch (err) {
    console.warn('[tpdbarr] could not save the group builder store -', err.message);
  }
}

/* ------------------------------------------------------------ the library */

const normalise = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const TPDB_ENDPOINT = /theporndb|metadataapi/i;
const STASHDB_ENDPOINT = /stashdb\.org/i;

const idAt = (scene, pattern) =>
  (scene.stash_ids || []).find((s) => pattern.test(s.endpoint || ''))?.stash_id?.toLowerCase() || null;

/* Every ungrouped scene with cast, studio and catalogue ids. One query. */
async function ungrouped(config) {
  const data = await gql(config, `{
    findScenes(scene_filter: {groups: {modifier: IS_NULL, value: []}}, filter: {per_page: -1}) {
      scenes {
        id title date
        studio { id name }
        performers { id name }
        stash_ids { endpoint stash_id }
        paths { screenshot }
      }
    }
  }`);

  return (data.findScenes.scenes || []).map((scene) => ({
    id: scene.id,
    title: scene.title || '',
    date: scene.date || null,
    studioId: scene.studio?.id || null,
    studioName: scene.studio?.name || '',
    performers: (scene.performers || []).map((p) => p.name),
    cast: new Set((scene.performers || []).map((p) => normalise(p.name)).filter(Boolean)),
    tpdbId: idAt(scene, TPDB_ENDPOINT),
    stashdbId: idAt(scene, STASHDB_ENDPOINT),
    screenshot: scene.paths?.screenshot || null,
  }));
}

/* Studios with loose scenes, most first, with what their scans found. */
export async function studios(config) {
  if (!stashConfigured(config)) return { studios: [], scanning: scanSnapshot() };

  const held = await store();
  const scenes = await ungrouped(config);
  const byStudio = new Map();

  for (const scene of scenes) {
    if (!scene.studioId) continue;
    if (!byStudio.has(scene.studioId)) {
      byStudio.set(scene.studioId, { id: scene.studioId, name: scene.studioName, loose: 0, withTpdbId: 0 });
    }
    const row = byStudio.get(scene.studioId);
    row.loose++;
    if (scene.tpdbId) row.withTpdbId++;
  }

  const open = openProposals(held);

  const rows = [...byStudio.values()].map((row) => {
    const known = held.studios[row.id] || null;
    return {
      ...row,
      siteId: known?.siteId ?? null,
      scannedAt: known?.scannedAt || null,
      movies: known?.movies ?? null,
      read: known?.read ?? null,
      catalogue: known?.catalogue ?? null,
      capped: Boolean(known?.capped),
      note: known?.note || null,
      // Only the ones still waiting on you. A studio whose proposals are all
      // answered should read as done, not as a pile.
      waiting: open.filter((p) => p.studioId === row.id).length,
    };
  });

  rows.sort((a, b) => b.waiting - a.waiting || b.loose - a.loose || a.name.localeCompare(b.name));
  return { studios: rows, scanning: scanSnapshot() };
}

/* ---------------------------------------------------------------- the scan */

export function scanSnapshot() {
  return {
    running: Boolean(running),
    studio: progress.studio,
    phase: progress.phase,
    looked: progress.looked,
    total: progress.total,
  };
}

/*
 * Start a studio's scan and return progress. The page polls.
 * One scan at a time so IAFD sees one crawler.
 */
export async function scan(config, studioId, { force = false } = {}) {
  if (!stashConfigured(config)) throw new Error('Stash is not configured — the loose scenes live there.');
  if (running) return scanSnapshot();

  const held = await store();
  const known = held.studios[studioId];
  if (!force && known?.scannedAt && Date.now() - Date.parse(known.scannedAt) < TTL) {
    return { ...scanSnapshot(), skipped: 'scanned recently' };
  }

  running = (async () => {
    try {
      await runScan(config, studioId);
    } catch (err) {
      console.warn(`[tpdbarr] group builder scan of studio ${studioId} failed -`, err.message);
      const held2 = await store();
      held2.studios[studioId] = {
        ...(held2.studios[studioId] || {}),
        scannedAt: new Date().toISOString(),
        note: err.message,
      };
      await save();
    } finally {
      running = null;
      progress = { studio: null, looked: 0, total: 0, phase: null };
    }
  })();

  return scanSnapshot();
}

/* A studio's TPDB site id, taken from one of its scenes. No TPDB id, no catalogue. */
async function siteIdFor(config, studioId, scenes) {
  const held = await store();
  if (held.studios[studioId]?.siteId) return held.studios[studioId].siteId;

  for (const scene of scenes.filter((s) => s.tpdbId).slice(0, 5)) {
    const record = await tpdb.getScene(config, scene.tpdbId).catch(() => null);
    if (record?.siteId) return record.siteId;
  }
  return null;
}

async function runScan(config, studioId) {
  const until = Date.now() + DEADLINE;
  const held = await store();

  const all = await ungrouped(config);
  const mine = all.filter((s) => s.studioId === studioId);
  const studioName = mine[0]?.studioName || held.studios[studioId]?.name || 'that studio';

  progress = { studio: studioName, looked: 0, total: 0, phase: 'finding the catalogue' };

  const siteId = await siteIdFor(config, studioId, mine);
  if (!siteId) {
    held.studios[studioId] = {
      name: studioName,
      siteId: null,
      scannedAt: new Date().toISOString(),
      movies: 0,
      capped: false,
      note: 'None of this studio’s loose scenes carry a ThePornDB id, so there is no catalogue to read.',
    };
    await save();
    return;
  }

  /* Skip films older than your oldest loose scene of this studio, less a year. */
  const dates = mine.map((s) => s.date).filter(Boolean).sort();
  const since = dates.length ? String(Number(dates[0].slice(0, 4)) - 1) + dates[0].slice(4) : null;

  progress.phase = 'reading the catalogue';
  const { movies, total, capped, read } = await tpdb.moviesForSite(config, siteId, {
    since,
    // Report pages read, so a long roster read doesn't look stuck.
    onPage: (done, of) => { progress.looked = done; progress.total = of; },
  });

  /* `byTpdb` for the exact tier; `byCast` a multimap, so shared casts show as ambiguous. */
  const byTpdb = new Map();
  for (const scene of all) if (scene.tpdbId) byTpdb.set(scene.tpdbId, scene);

  /*
   * The cast index, and the one place this got badly wrong the first time.
   *
   * It is built from **every** loose scene, not from this studio's — because a
   * DVD gathers scenes from sibling labels by design. "I Want My Stepdad #2" is
   * a New Sensations release and the scene of it this library holds is filed
   * under FamilyXXX, so an index scoped to the studio being scanned threw the
   * one real match away and the pass came back empty. Measured, not imagined.
   */
  const byCast = new Map();
  for (const scene of all) {
    if (!scene.cast.size) continue;
    const key = [...scene.cast].sort().join('|');
    if (!byCast.has(key)) byCast.set(key, []);
    byCast.get(key).push(scene);
  }

  /* Title index for the Bang tier. Every loose scene, multimap, same as the cast index. */
  const byTitle = new Map();
  for (const scene of all) {
    const key = bang.flatten(scene.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(scene);
  }

  /*
   * Skip films no loose scene's cast fits inside, and films with no cast.
   * `fits` ranks what's left.
   */
  const casts = [...byCast.keys()].map((key) => key.split('|'));

  const plausible = [];
  for (const movie of movies) {
    const on = new Set((movie.performers || []).map((p) => normalise(p.name)).filter(Boolean));
    if (!on.size) continue;
    const fits = casts.filter((cast) => cast.every((who) => on.has(who))).length;
    if (fits) plausible.push({ ...movie, fits });
  }

  const found = [];
  const unresolved = [];
  let next = 0;
  let ranOut = false;

  /*
   * Films TPDB has already been asked about, so the next pass carries on.
   * "No scene list" still goes on to IAFD.
   */
  const seen = held.movies || (held.movies = {});
  const fresh = (guid) => seen[guid] && Date.now() - Date.parse(seen[guid].at) < TTL;

  const toAsk = [];
  for (const movie of plausible) {
    if (!fresh(movie.guid)) { toAsk.push(movie); continue; }
    if (seen[movie.guid].scenes === 0) unresolved.push(movie);
  }

  // Phase one, over the films that could hold something of yours.
  progress.phase = 'asking ThePornDB';
  progress.looked = 0;
  progress.total = toAsk.length;

  /* Phase one gets 65% of the time so the IAFD phase always runs. */
  const phaseOneUntil = Date.now() + (until - Date.now()) * 0.65;

  await Promise.all(
    Array.from({ length: Math.min(TPDB_AT_A_TIME, toAsk.length) }, async () => {
      for (let i = next++; i < toAsk.length; i = next++) {
        if (Date.now() > phaseOneUntil) { ranOut = true; return; }
        progress.looked++;

        try {
          const movie = await tpdb.getMovie(config, toAsk[i].guid);
          if (!movie) continue;

          seen[toAsk[i].guid] = { at: new Date().toISOString(), scenes: movie.scenes.length };

          const exact = fromTpdb(movie, byTpdb, studioId, studioName);
          if (exact) found.push(exact);
          // Merge the detail over the roster row; the row has the IAFD link.
          else if (!movie.scenes.length) unresolved.push({ ...toAsk[i], ...movie });
        } catch (err) {
          // Not recorded as seen: a call that failed is one to make again.
          console.warn(`[tpdbarr] group builder: ${toAsk[i].title} -`, err.message);
        }
      }
    })
  );

  /*
   * Phase two: IAFD, for films TPDB couldn't answer, a batch per pass, best
   * fits first. Remembers what it asked.
   */
  const asked = held.iafd || (held.iafd = {});

  const queue = unresolved
    .filter((movie) => !asked[movie.guid])
    .sort((a, b) => (b.fits || 0) - (a.fits || 0));

  const batch = queue.slice(0, IAFD_PER_PASS);

  progress.phase = 'reading Bang, GameLink and IAFD scene lists';
  progress.looked = 0;
  progress.total = batch.length;

  let viaBang = 0;
  let viaGameLink = 0;

  for (const movie of batch) {
    if (Date.now() > until) { ranOut = true; break; }
    progress.looked++;

    try {
      /*
       * Bang first; IAFD only when Bang had nothing. Same cost, and a title match
       * needs no judgement.
       */
      let proposal = await fromBang(movie, byTitle, studioId, studioName);
      if (proposal) viaBang++;

      /* Then the cast tiers, cheapest first: GameLink, then IAFD. */
      if (!proposal) {
        proposal = await fromGameLink(config, movie, byCast, studioId, studioName);
        if (proposal) viaGameLink++;
      }
      if (!proposal) proposal = await fromIafd(movie, byCast, studioId, studioName);

      asked[movie.guid] = { at: new Date().toISOString(), found: Boolean(proposal) };
      if (proposal) found.push(proposal);
    } catch (err) {
      // Not recorded as asked: a failure is a reason to try again next pass,
      // where a genuine "neither site has this" is not.
      console.warn(`[tpdbarr] group builder scene lists: ${movie.title} -`, err.message);
    }
  }

  const leftOver = Math.max(0, queue.length - batch.length);

  // Merged, not replaced: a pass that ran out of time still learned something,
  // and a film answered last week is not worth re-asking about this week.
  for (const proposal of found) held.proposals[proposal.id] = proposal;

  held.studios[studioId] = {
    name: studioName,
    siteId,
    scannedAt: new Date().toISOString(),
    // Films read, and films that could hold anything of yours.
    movies: plausible.length,
    read,
    catalogue: total,
    capped: capped || read < total,
    // How many films IAFD has still to be asked about, so "run it again" is a
    // statement of fact rather than a suggestion.
    pending: leftOver,
    note: ranOut
      ? 'The scan ran out of time. Run it again to carry on where it stopped.'
      : leftOver
        ? `${leftOver} more films still to check against the scene lists. Run it again to carry on.`
        : null,
  };

  await save();

  /* One log line per pass, so "found nothing" and "never finished" differ. */
  console.log(
    `[tpdbarr] group builder: ${studioName} — ${read} films read, ${plausible.length} asked about, ` +
    `${batch.length} checked against Bang, GameLink and IAFD ` +
    `(${viaBang} by Bang, ${viaGameLink} by GameLink), ${found.length} proposals` +
    (leftOver ? `, ${leftOver} still to check` : '') + (ranOut ? ' (ran out of time)' : '')
  );
}

/* ------------------------------------------------------------- the tiers */

const posterOf = (movie) => movie.poster || movie.background || null;

function shell(movie, studioId, studioName) {
  return {
    id: movie.guid,
    studioId,
    studioName,
    title: movie.title,
    date: movie.date || null,
    poster: posterOf(movie),
    overview: movie.overview || '',
    director: (movie.directors || [])[0] || null,
    sku: movie.sku || null,
    duration: movie.duration || null,
    urls: {
      adultEmpire: movie.links?.['Adult DVD Empire'] || null,
      iafd: movie.links?.IAFD || null,
      afdb: movie.links?.AFDB || null,
      tpdb: movie.url || null,
    },
    foundAt: new Date().toISOString(),
  };
}

/* Exact tier: TPDB's scene list, matched on id. Films you hold nothing of aren't proposed. */
function fromTpdb(movie, byTpdb, studioId, studioName) {
  if (movie.scenes.length < CREDIBLE) return null;

  const held = [];
  const missing = [];

  movie.scenes.forEach((scene, index) => {
    const mine = scene.guid ? byTpdb.get(String(scene.guid).toLowerCase()) : null;

    if (mine) {
      held.push({
        sceneId: mine.id,
        title: mine.title,
        date: mine.date,
        index: index + 1,
        screenshot: mine.screenshot,
        cast: mine.performers,
        studio: mine.studioName,
        ambiguous: null,
      });
      return;
    }

    missing.push({
      key: scene.guid || `${movie.guid}:${index + 1}`,
      index: index + 1,
      title: scene.title,
      date: scene.date || null,
      image: scene.image || scene.still || null,
      tpdbGuid: scene.guid || null,
      tpdbId: scene.id || null,
      siteId: scene.siteId ?? movie.siteId ?? null,
      performers: (scene.performers || []).map((p) => p.name),
      // TPDB named it, so it can be tracked and it can be added.
      addressable: true,
    });
  });

  if (!held.length) return null;

  return {
    ...shell(movie, studioId, studioName),
    match: 'exact',
    via: 'ThePornDB scene list',
    total: movie.scenes.length,
    held,
    missing,
  };
}

/*
 * Likely tier: Bang lists scene titles. Matched when the titles agree after
 * `flatten`. Cast only breaks ties; if it can't, both are named and neither filed.
 */
async function fromBang(movie, byTitle, studioId, studioName) {
  const page = await bang.findFilm(movie.title, { year: (movie.date || '').slice(0, 4) || null });
  if (!page || page.scenes.length < CREDIBLE) return null;

  const held = [];
  const missing = [];
  const claimed = new Set();

  for (const row of page.scenes) {
    const key = bang.flatten(row.title);
    let candidates = (byTitle.get(key) || []).filter((s) => !claimed.has(s.id));

    /* Tie-break only: narrows scenes that already matched on title. */
    if (candidates.length > 1 && row.performers.length) {
      const wanted = row.performers.map(normalise).filter(Boolean).sort().join('|');
      const narrowed = candidates.filter((s) => [...s.cast].sort().join('|') === wanted);
      if (narrowed.length === 1) candidates = narrowed;
    }

    if (candidates.length === 1) {
      const mine = candidates[0];
      claimed.add(mine.id);
      held.push({
        sceneId: mine.id,
        title: mine.title,
        date: mine.date,
        index: row.no,
        screenshot: mine.screenshot,
        cast: mine.performers,
        studio: mine.studioName,
        ambiguous: null,
      });
      continue;
    }

    if (candidates.length > 1) {
      held.push({
        sceneId: null,
        title: row.title,
        date: null,
        index: row.no,
        screenshot: null,
        cast: row.performers,
        ambiguous: candidates.map((s) => ({
          sceneId: s.id, title: s.title, date: s.date, screenshot: s.screenshot,
        })),
      });
      continue;
    }

    missing.push({
      key: `${movie.guid}:${row.no}`,
      index: row.no,
      // Bang named it, so the missing scene can be looked for.
      title: row.title,
      date: null,
      image: null,
      tpdbGuid: null,
      tpdbId: null,
      siteId: movie.siteId ?? null,
      performers: row.performers,
      /* No id, so nothing Whisparr can fetch. */
      addressable: false,
    });
  }

  if (!held.some((row) => row.sceneId)) return null;

  return {
    ...shell(movie, studioId, studioName),
    match: 'likely',
    via: 'Bang scene list',
    total: page.scenes.length,
    bang: {
      url: page.url,
      title: page.title,
      studio: page.studio,
      date: page.date,
    },
    held,
    missing,
  };
}

/*
 * Probable tier via GameLink: cast per scene, no titles, same rule as IAFD.
 * Attributes are kept for the reader, not matched on.
 */
async function fromGameLink(config, movie, byCast, studioId, studioName) {
  const page = await gamelink.film(config, movie.title, {
    year: (movie.date || '').slice(0, 4) || null,
  });
  if (!page || page.scenes.length < CREDIBLE) return null;

  const held = [];
  const missing = [];
  const claimed = new Set();

  for (const row of page.scenes) {
    const key = row.performers.map(normalise).filter(Boolean).sort().join('|');
    const candidates = (byCast.get(key) || []).filter((s) => !claimed.has(s.id));

    if (candidates.length === 1) {
      const mine = candidates[0];
      claimed.add(mine.id);
      held.push({
        sceneId: mine.id,
        title: mine.title,
        date: mine.date,
        index: row.no,
        screenshot: mine.screenshot,
        cast: mine.performers,
        studio: mine.studioName,
        ambiguous: null,
      });
      continue;
    }

    if (candidates.length > 1) {
      held.push({
        sceneId: null,
        title: null,
        date: null,
        index: row.no,
        screenshot: null,
        cast: row.performers,
        ambiguous: candidates.map((s) => ({
          sceneId: s.id, title: s.title, date: s.date, screenshot: s.screenshot,
        })),
      });
      continue;
    }

    missing.push({
      key: `${movie.guid}:${row.no}`,
      index: row.no,
      title: null,
      date: null,
      image: null,
      tpdbGuid: null,
      tpdbId: null,
      siteId: movie.siteId ?? null,
      performers: row.performers,
      // No id, so nothing Whisparr can fetch.
      addressable: false,
      attributes: row.attributes,
    });
  }

  if (!held.some((row) => row.sceneId)) return null;

  return {
    ...shell(movie, studioId, studioName),
    match: 'probable',
    via: 'GameLink scene list',
    total: page.scenes.length,
    gamelink: { url: page.url, studio: page.studio, date: page.date },
    held,
    missing,
  };
}

/*
 * Probable tier: a scene matches an IAFD row when the casts are the same set.
 * Not overlap. Two held scenes with the same cast: ambiguous, neither filed.
 */
async function fromIafd(movie, byCast, studioId, studioName) {
  const page = await findOnIafd(movie);
  if (!page || page.scenes.length < CREDIBLE) return null;

  const held = [];
  const missing = [];
  const claimed = new Set();

  for (const row of page.scenes) {
    const key = row.performers.map(normalise).filter(Boolean).sort().join('|');
    const candidates = (byCast.get(key) || []).filter((s) => !claimed.has(s.id));

    if (candidates.length === 1) {
      const mine = candidates[0];
      claimed.add(mine.id);
      held.push({
        sceneId: mine.id,
        title: mine.title,
        date: mine.date,
        index: row.index,
        screenshot: mine.screenshot,
        cast: mine.performers,
        studio: mine.studioName,
        ambiguous: null,
      });
      continue;
    }

    if (candidates.length > 1) {
      held.push({
        sceneId: null,
        title: null,
        date: null,
        index: row.index,
        screenshot: null,
        cast: row.performers,
        // Named, not chosen. The page offers these and the group is built
        // without this row until one is picked.
        ambiguous: candidates.map((s) => ({
          sceneId: s.id, title: s.title, date: s.date, screenshot: s.screenshot,
        })),
      });
      continue;
    }

    missing.push({
      key: `${movie.guid}:${row.index}`,
      index: row.index,
      title: null,
      date: null,
      image: null,
      tpdbGuid: null,
      tpdbId: null,
      siteId: movie.siteId ?? null,
      performers: row.performers,
      /* No id, so nothing Whisparr can fetch. The page offers Find it instead. */
      addressable: false,
    });
  }

  if (!held.some((row) => row.sceneId)) return null;

  return {
    ...shell(movie, studioId, studioName),
    match: 'probable',
    via: 'IAFD scene breakdown',
    total: page.scenes.length,
    iafd: {
      url: page.url,
      compilation: page.compilation,
      webscene: page.webscene,
      releaseDate: page.releaseDate,
    },
    held,
    missing,
  };
}

/*
 * Which IAFD record is this film. TPDB's link if it has one; otherwise a
 * title search, believed only on an exact title and year ±1.
 */
async function findOnIafd(movie) {
  if (movie.links?.IAFD) return iafd.titleScenes(movie.links.IAFD);

  const key = normalise(movie.title);
  if (!key) return null;

  const year = movie.date ? Number(String(movie.date).slice(0, 4)) : null;
  const results = await iafd.searchTitles(movie.title);

  const named = results.filter((r) => normalise(r.title) === key || normalise(r.aka) === key);
  if (!named.length) return null;

  const dated = year ? named.find((r) => r.year && Math.abs(r.year - year) <= 1) : null;
  const best = dated || (named.length === 1 ? named[0] : null);

  // Several films of that name and no year to separate them is not a match.
  return best ? iafd.titleScenes(best.url) : null;
}

/*
 * -------------------------------------------------- what the titles say
 *
 * The offline tier: scenes whose titles name a numbered film
 * ("Britney in Barely Legal #14", "Plants vs Cunts Vol. 6").
 * A number is required, or a whole series becomes one film.
 * IAFD gives the film's size. Scenes are placed on its rows by the name in
 * the title first, tagged cast second. No IAFD record, no size.
 */

// "#132", "no. 132", "vol. 132" and a bare "132" are one film. Lifted from
// groupurl.mjs, which learned it on this same shelf.
const looseKey = (title) =>
  String(title || '')
    .toLowerCase()
    .replace(/\b(?:no\.?|#|vol\.?|volume|part|pt\.?)\s*(\d+)/gi, ' $1 ')
    .replace(/[^a-z0-9]+/g, '');

const NUMBERED = /(?:#|\bvol(?:ume)?\.?|\bno\.?)\s*\d+/i;
const TAIL_INDEX = /[\s,:\-–—]*\b(?:scene|part|pt\.?)\s*(\d+)\s*$/i;
const AFTER_IN = /^.*\bin\s+(.+)$/i;

/*
 * -> {name, index} or null. Read right to left: "Scene 3" is the part,
 * the text after the last " in " is the film.
 */
export function impliedFilm(title) {
  let rest = String(title || '').trim();
  let index = null;

  const tail = TAIL_INDEX.exec(rest);
  if (tail) {
    index = Number(tail[1]);
    rest = rest.slice(0, tail.index).trim();
  }

  const after = AFTER_IN.exec(rest);
  const name = (after ? after[1] : rest).replace(/\s+/g, ' ').trim();
  if (!NUMBERED.test(name)) return null;

  /* The name billed in the title. Often the only cast a scene has. */
  const billed = after ? String(title).slice(0, String(title).lastIndexOf(after[1])).replace(/\bin\s*$/i, '').trim() : null;

  return { name, index, billed: billed || null };
}

/*
 * Poster, date and URL from TPDB, only on an exact title match. Without one
 * the proposal still stands.
 */
async function dressFromTpdb(config, name) {
  const found = await tpdb.searchMovies(config, name, { limit: 6 }).catch(() => []);
  const hit = found.find((m) => looseKey(m.title) === looseKey(name));
  if (!hit) return null;

  return {
    title: hit.title,
    date: hit.date || null,
    poster: hit.poster || hit.background || null,
    overview: hit.overview || '',
    director: (hit.directors || [])[0] || null,
    sku: hit.sku || null,
    duration: hit.duration || null,
    urls: {
      adultEmpire: hit.links?.['Adult DVD Empire'] || null,
      iafd: hit.links?.IAFD || null,
      afdb: hit.links?.AFDB || null,
      tpdb: hit.url || null,
    },
  };
}

/*
 * A named film's size and missing rows, from IAFD. If a held scene can't be
 * placed, the size is kept but nothing is called missing.
 */
async function sizeFromIafd(name) {
  const page = await findOnIafd({ title: name, date: null, links: {} }).catch(() => null);
  if (!page || page.scenes.length < CREDIBLE) return null;

  // The rows are kept, not just counted. Placement is free once you have them,
  // so a later pass can redo it against a changed shelf without asking again.
  return { url: page.url, compilation: page.compilation, rows: page.scenes };
}

/* Which rows you hold and which are empty. Works on stored rows, no fetch. */
function placeOnRows(rows, heldRows) {
  const key = (names) => (names || []).map(normalise).filter(Boolean).sort().join('|');

  const placed = new Set();
  const empty = [];

  for (const row of rows) {
    const on = new Set((row.performers || []).map(normalise).filter(Boolean));

    /* Billing first (one name in the row is enough), then exact cast. */
    const mine =
      heldRows.find((r) => !placed.has(r.sceneId) && r.billed && on.has(normalise(r.billed))) ||
      heldRows.find((r) => !placed.has(r.sceneId) && r.cast?.length && key(r.cast) === key(row.performers));

    if (mine) placed.add(mine.sceneId);
    else empty.push(row);
  }

  const unplaced = heldRows.length - placed.size;

  return {
    total: rows.length,
    /* Missing rows are named only when every held scene was placed. */
    missing: unplaced === 0 ? empty : [],
    placed: placed.size,
    unplaced,
  };
}

// Dressing is a nicety; the pass must not sit on ThePornDB or IAFD for it.
const DRESS_DEADLINE = 8 * 60 * 1000;

export function titlesSnapshot() {
  return {
    running: Boolean(running),
    studio: progress.studio,
    phase: progress.phase,
    looked: progress.looked,
    total: progress.total,
  };
}

/* One pass over the whole library. Grouped by film name and Stash studio. */
export async function scanTitles(config) {
  if (!stashConfigured(config)) throw new Error('Stash is not configured — the loose scenes live there.');
  if (running) return titlesSnapshot();

  running = (async () => {
    try {
      await readTitles(config);
    } catch (err) {
      console.warn('[tpdbarr] group builder: reading the titles failed -', err.message);
    } finally {
      running = null;
      progress = { studio: null, looked: 0, total: 0, phase: null };
    }
  })();

  return titlesSnapshot();
}

async function readTitles(config) {
  const held = await store();
  progress = { studio: 'every studio', looked: 0, total: 0, phase: 'reading the titles' };

  const scenes = await ungrouped(config);
  const films = new Map();

  for (const scene of scenes) {
    const implied = impliedFilm(scene.title);
    if (!implied) continue;

    const key = `${scene.studioId || '-'}|${looseKey(implied.name)}`;
    if (!films.has(key)) {
      films.set(key, { key, name: implied.name, studioId: scene.studioId, studioName: scene.studioName, members: [] });
    }
    films.get(key).members.push({ scene, index: implied.index, billed: implied.billed });
  }

  const worth = [...films.values()].filter((film) => film.members.length >= CREDIBLE);

  /* Unlooked-up films first, so a pass that runs out of time still moves on. */
  const knownRows = (film) => held.proposals[`titles:${film.key}`]?.iafd?.rows;
  worth.sort((a, b) => (knownRows(a) ? 1 : 0) - (knownRows(b) ? 1 : 0));

  progress.total = worth.length;
  progress.phase = 'asking what these films are';

  const until = Date.now() + DRESS_DEADLINE;
  let found = 0;

  for (const film of worth) {
    progress.looked++;

    /* By part number, else by date. */
    film.members.sort((a, b) =>
      (a.index ?? 99) - (b.index ?? 99) ||
      String(a.scene.date || '').localeCompare(String(b.scene.date || '')));

    const id = `titles:${film.key}`;

    const heldRows = film.members.map(({ scene, index, billed }, at) => ({
      sceneId: scene.id,
      title: scene.title,
      date: scene.date,
      index: index ?? at + 1,
      screenshot: scene.screenshot,
      cast: scene.performers,
      billed,
      studio: scene.studioName,
      ambiguous: null,
    }));

    /* Keep earlier lookups; placement is redone from stored rows each pass. */
    const was = held.proposals[id];
    const inTime = () => Date.now() < until;

    const dressed = was?.iafd?.rows ? null : (inTime() ? await dressFromTpdb(config, film.name).catch(() => null) : null);
    const iafd = was?.iafd?.rows
      ? was.iafd
      : (inTime() ? await sizeFromIafd(film.name).catch(() => null) : null);

    const sized = iafd?.rows ? placeOnRows(iafd.rows, heldRows) : null;

    held.proposals[id] = {
      id,
      studioId: film.studioId,
      studioName: film.studioName,
      title: dressed?.title || was?.title || film.name,
      date: dressed?.date ?? was?.date ?? null,
      poster: dressed?.poster ?? was?.poster ?? null,
      overview: dressed?.overview || was?.overview || '',
      director: dressed?.director ?? was?.director ?? null,
      sku: dressed?.sku ?? was?.sku ?? null,
      duration: dressed?.duration ?? was?.duration ?? null,
      urls: dressed?.urls || was?.urls || { adultEmpire: null, iafd: null, afdb: null, tpdb: null },
      foundAt: was?.foundAt || new Date().toISOString(),
      match: 'named',
      via: sized ? 'the scene titles, sized by IAFD' : 'the scene titles',
      /* IAFD's count, or unknown. Never what you happen to hold. */
      total: sized?.total ?? null,
      iafd: iafd
        ? { url: iafd.url, compilation: iafd.compilation, rows: iafd.rows, unplaced: sized?.unplaced ?? null }
        : null,
      held: heldRows,
      /* Empty rows: cast and number only, so not addressable. */
      missing: (sized?.missing || []).map((row) => ({
        key: `${id}:${row.index}`,
        index: row.index,
        title: null,
        date: null,
        image: null,
        tpdbGuid: null,
        tpdbId: null,
        siteId: null,
        performers: row.performers,
        addressable: false,
      })),
    };
    found++;
  }

  const refreshed = await resizeBuilt(config, held, until);
  await save();

  console.log(
    `[tpdbarr] group builder: the titles name ${found} film${found === 1 ? '' : 's'} ` +
    `across ${worth.reduce((n, f) => n + f.members.length, 0)} loose scenes` +
    (refreshed ? `, and ${refreshed} built group${refreshed === 1 ? '' : 's'} re-measured` : '')
  );
}

/*
 * Re-measure groups already built, from the group's own scenes. Built films
 * never show up as loose.
 */
async function resizeBuilt(config, held, until) {
  const wanted = Object.values(held.proposals).filter((proposal) => {
    if (proposal.match !== 'named') return false;
    const decision = held.decisions[proposal.id];
    return decision?.verdict === 'approved' && decision.groupId;
  });

  // The ones nothing has row data for go first, for the usual reason.
  wanted.sort((a, b) => (a.iafd?.rows ? 1 : 0) - (b.iafd?.rows ? 1 : 0));
  if (!wanted.length) return 0;

  progress.phase = 'measuring the groups you built';
  progress.looked = 0;
  progress.total = wanted.length;

  /* Every group in one read: GroupFilterType has no `id` field. The catch says so. */
  const data = await gql(config, `{
    findGroups(filter: {per_page: -1}) {
      groups { id scenes { id title date performers { name } paths { screenshot } } }
    }
  }`).catch((err) => {
    console.warn('[tpdbarr] group builder: could not read the built groups -', err.message);
    return null;
  });

  const scenesOf = new Map();
  for (const group of data?.findGroups?.groups || []) scenesOf.set(group.id, group.scenes || []);
  if (!scenesOf.size) return 0;

  let done = 0;

  for (const proposal of wanted) {
    if (Date.now() > until) break;
    progress.looked++;

    const scenes = scenesOf.get(held.decisions[proposal.id].groupId);
    if (!scenes?.length) continue;

    const heldRows = scenes.map((scene, at) => {
      const implied = impliedFilm(scene.title);
      return {
        sceneId: scene.id,
        title: scene.title || '',
        date: scene.date || null,
        index: implied?.index ?? at + 1,
        screenshot: scene.paths?.screenshot || null,
        cast: (scene.performers || []).map((p) => p.name),
        billed: implied?.billed || null,
        studio: proposal.studioName,
        ambiguous: null,
      };
    });

    const iafd = proposal.iafd?.rows ? proposal.iafd : await sizeFromIafd(proposal.title).catch(() => null);
    if (!iafd?.rows) continue;

    const sized = placeOnRows(iafd.rows, heldRows);

    proposal.held = heldRows;
    proposal.total = sized.total;
    proposal.via = 'the scene titles, sized by IAFD';
    proposal.iafd = { url: iafd.url, compilation: iafd.compilation, rows: iafd.rows, unplaced: sized.unplaced };
    proposal.missing = sized.missing.map((row) => ({
      key: `${proposal.id}:${row.index}`,
      index: row.index,
      title: null,
      date: null,
      image: null,
      tpdbGuid: null,
      tpdbId: null,
      siteId: null,
      performers: row.performers,
      addressable: false,
    }));

    done++;
  }

  return done;
}

/* ------------------------------------------------------------ the review */

/* A declined proposal returns only when you hold a new scene of that film. */
function reopened(proposal, decision) {
  if (decision.verdict !== 'declined') return false;
  const then = new Set(decision.owned || []);
  return (proposal.held || []).some((row) => row.sceneId && !then.has(row.sceneId));
}

function openProposals(held) {
  return Object.values(held.proposals).filter((proposal) => {
    /*
     * Applied on the way out too, so older proposals obey a tightened rule.
     * With no known size, measured against what you hold.
     */
    const size = proposal.total || (proposal.held || []).filter((row) => row.sceneId).length;
    if (size < CREDIBLE) return false;

    const decision = held.decisions[proposal.id];
    if (!decision) return true;
    if (decision.verdict === 'approved') return false;
    return reopened(proposal, decision);
  });
}

/* Waiting proposals: exact before probable, newest first. */
export async function proposals(config, { studio = null } = {}) {
  const held = await store();
  const mine = (p) => !studio || p.studioId === studio;

  const open = openProposals(held).filter(mine);

  /* Strongest evidence first: id, named title, the file's own title, cast. */
  const STRENGTH = { exact: 0, likely: 1, named: 2, probable: 3 };

  open.sort((a, b) =>
    (STRENGTH[a.match] ?? 9) - (STRENGTH[b.match] ?? 9) ||
    String(b.date || '').localeCompare(String(a.date || '')) ||
    a.title.localeCompare(b.title));

  const verdicts = (proposal) =>
    Object.fromEntries(
      (proposal.missing || [])
        .map((m) => [m.key, held.scenes[m.key]?.verdict || null])
        .filter(([, verdict]) => verdict)
    );

  /* Built groups with unanswered missing scenes stay listed until each is answered. */
  const finishing = Object.values(held.proposals)
    .filter(mine)
    .filter((proposal) => {
      const decision = held.decisions[proposal.id];
      if (decision?.verdict !== 'approved') return false;
      return (proposal.missing || []).some((m) => !held.scenes[m.key]);
    })
    .map((proposal) => ({
      ...proposal,
      groupId: held.decisions[proposal.id].groupId,
      scenes: verdicts(proposal),
    }));

  finishing.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const decided = Object.values(held.decisions);

  return {
    proposals: open.map((proposal) => ({
      ...proposal,
      // A film you already said no to and now hold more of. Worth saying so —
      // the answer you gave last time was given about less than this.
      returning: Boolean(held.decisions[proposal.id]),
      scenes: verdicts(proposal),
    })),
    finishing,
    counts: {
      open: open.length,
      finishing: finishing.length,
      approved: decided.filter((d) => d.verdict === 'approved').length,
      declined: decided.filter((d) => d.verdict === 'declined').length,
    },
    scanning: scanSnapshot(),
  };
}

/* ----------------------------------------------------------- the decisions */

export async function decline(config, id) {
  const held = await store();
  const proposal = held.proposals[id];
  if (!proposal) throw new Error('That proposal is no longer on the list.');

  held.decisions[id] = {
    verdict: 'declined',
    at: new Date().toISOString(),
    groupId: null,
    // The evidence as it stood. What brings this back is this set growing.
    owned: (proposal.held || []).map((row) => row.sceneId).filter(Boolean),
  };

  await save();
  return { declined: true, id };
}

/*
 * Build the group. Create it first, then file the scenes, so a failure
 * leaves an empty group rather than dangling scenes. URLs go on it so
 * Stash's scrapers can fill it later. Studio comes from the scenes.
 */
export async function approve(config, id, { sceneIds = null } = {}) {
  if (!stashConfigured(config)) throw new Error('Stash is not configured.');

  const held = await store();
  const proposal = held.proposals[id];
  if (!proposal) throw new Error('That proposal is no longer on the list.');

  /* Include ambiguous rows' candidates so a pick on the page can be filed. */
  const certain = (proposal.held || []).filter((row) => row.sceneId);
  const options = (proposal.held || []).flatMap((row) =>
    (row.ambiguous || []).map((option) => ({ ...option, index: row.index })));

  /* With no list, only certain rows. Ambiguous ones stay out. */
  const picked = sceneIds
    ? [...certain, ...options].filter((row) => sceneIds.includes(row.sceneId))
    : certain;

  const wanted = [...new Map(picked.map((row) => [row.sceneId, row])).values()];
  if (!wanted.length) throw new Error('A group needs at least one scene you actually hold.');

  const urls = [proposal.urls.adultEmpire, proposal.urls.iafd, proposal.urls.tpdb, proposal.urls.afdb]
    .filter(Boolean);

  const input = {
    name: proposal.title,
    date: proposal.date || undefined,
    synopsis: proposal.overview || undefined,
    director: proposal.director || undefined,
    studio_id: proposal.studioId || undefined,
    urls: urls.length ? urls : undefined,
    // Stash fetches an image field given a URL, which saves proxying the poster
    // through here only to hand it straight back.
    front_image: proposal.poster || undefined,
  };

  /*
   * Stash fetches the cover at mutation time and some signed URLs expire.
   * Retry without the cover rather than lose the group.
   */
  const create = (body) => gql(
    config,
    'mutation($input: GroupCreateInput!) { groupCreate(input: $input) { id name } }',
    { input: body }
  );

  let created;
  let coverFailed = null;

  try {
    created = await create(input);
  } catch (err) {
    if (!input.front_image) throw err;
    coverFailed = err.message;
    created = await create({ ...input, front_image: undefined });
  }

  const groupId = created.groupCreate.id;
  const filed = [];
  const failed = [];

  for (const row of wanted) {
    try {
      await gql(
        config,
        'mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }',
        { input: { id: row.sceneId, groups: [{ group_id: groupId, scene_index: row.index || null }] } }
      );
      filed.push(row.sceneId);
    } catch (err) {
      failed.push({ sceneId: row.sceneId, error: err.message });
    }
  }

  held.decisions[id] = {
    verdict: 'approved',
    at: new Date().toISOString(),
    groupId,
    owned: filed,
  };
  await save();

  // The group index and the film shelf both counted this a moment ago.
  forgetGroups();

  return {
    approved: true,
    id,
    groupId,
    filed,
    failed,
    coverFailed,
    // What the film is missing, which is the next question and the only one
    // this page asks unprompted.
    missing: proposal.missing || [],
  };
}

/*
 * One missing scene answered:
 *
 *   track  — want list (StashDB ids, so TPDB scenes are bridged first)
 *   add    — send to the downloader now
 *   ignore — not needed for this film
 *
 * This ignore is local to the page. It doesn't touch the want list's ignore,
 * which changes percentages elsewhere.
 */
const VERDICTS = ['tracked', 'added', 'ignored'];

export async function decideScene(config, id, key, verdict, { force = false } = {}) {
  if (!VERDICTS.includes(verdict)) throw new Error('That is not one of track, add or ignore.');

  const held = await store();
  const proposal = held.proposals[id];
  if (!proposal) throw new Error('That proposal is no longer on the list.');

  const scene = (proposal.missing || []).find((m) => m.key === key);
  if (!scene) throw new Error('That scene is not one of this film’s missing ones.');

  const result = { key, verdict };

  if (verdict === 'tracked') {
    const bridged = await toStashdb(config, scene, proposal);
    if (!bridged) throw new Error('StashDB has nothing this could be tracked as.');
    await discover.trackScene(config, bridged.scene);
    result.stashdbId = bridged.scene.id;
    result.match = bridged.match;
  }

  if (verdict === 'added') {
    result.whisparr = await handToDownloader(config, scene, proposal, { force });
  }

  held.scenes[key] = { verdict, at: new Date().toISOString(), movieId: id };
  await save();

  return result;
}

/* TPDB scene -> StashDB via bridge(): fingerprint, then title and date. */
async function toStashdb(config, scene, proposal) {
  /* Already pointed at a StashDB scene: no bridge needed. */
  if (scene.stashdbId) {
    const card = await stashdb.getScene(config, scene.stashdbId).catch(() => null);
    if (card) return { match: 'named', scene: card, via: 'you picked it', others: [] };
  }

  if (!scene.tpdbGuid) return null;
  const full = await tpdb.getScene(config, scene.tpdbGuid).catch(() => null);
  if (!full) return null;
  return stashdb.bridge(config, { ...full, siteName: full.siteName || proposal.studioName });
}

/* v2 for TPDB ids, v3 for StashDB ids. Neither: say so. */
async function handToDownloader(config, scene, proposal, { force = false } = {}) {
  if (scene.tpdbId && scene.siteId && whisparr2Configured(config)) {
    if (!force) {
      const held = await heldForV2(config, scene.siteId, [scene.tpdbId]);
      if (held.length) throw refusal(held);
    }
    return whisparr.addScenes(config, scene.siteId, [scene.tpdbId]);
  }

  if (whisparr3Reachable(config)) {
    const bridged = await toStashdb(config, scene, proposal);
    if (bridged) {
      if (!force) {
        const held = await heldForV3(config, bridged.scene.id);
        if (held) throw refusal(held);
      }
      return whisparr3.addScene(config, bridged.scene.id);
    }
  }

  throw new Error(
    scene.addressable
      ? 'No downloader here can take that scene — v2 needs its ThePornDB site, v3 needs a StashDB id.'
      : 'IAFD named the cast and nothing else, so there is no scene to fetch yet. Find it first.'
  );
}

/* Find it: look up an IAFD cast on StashDB. Returns candidates only. */
const PLACEHOLDER = new Set([
  'guy', 'guys', 'girl', 'girls', 'man', 'men', 'woman', 'women',
  'male', 'males', 'female', 'females', 'boy', 'boys',
  'unknown', 'unknownmale', 'unknownfemale', 'none', 'na', 'nonsexrole',
].map((n) => normalise(n)));

export async function findMissing(config, id, key) {
  const held = await store();
  const proposal = held.proposals[id];
  if (!proposal) throw new Error('That proposal is no longer on the list.');

  const scene = (proposal.missing || []).find((m) => m.key === key);
  if (!scene) throw new Error('That scene is not one of this film’s missing ones.');

  const cast = (scene.performers || []).filter(Boolean);

  /*
   * Search by cast as performers, not text: resolve each name, then scenes
   * with all of them (INCLUDES_ALL). No studio filter.
   */
  const ids = [];
  const unknown = [];
  const unnamed = [];

  for (const name of cast) {
    /*
     * Skip IAFD placeholders like "guy" — StashDB has real performers called Guy.
     * An explicit list, because short real names like "Jowy" exist.
     */
    if (PLACEHOLDER.has(normalise(name))) { unnamed.push(name); continue; }

    const hits = await stashdb.searchPerformers(config, name, { limit: 5 });
    const exact = hits.filter((p) => normalise(p.name) === normalise(name));
    // Same name, two people: the busier record is the one a released scene is
    // filed under far more often than not.
    const best = [...exact].sort((a, b) => (b.sceneCount || 0) - (a.sceneCount || 0))[0];
    if (best) ids.push(best.id); else unknown.push(name);
  }

  const term = cast.filter((n) => !PLACEHOLDER.has(normalise(n))).join(', ') || cast.join(', ');

  /* No one resolved: try text search once, and say so. */
  if (!ids.length) {
    const real = cast.filter((n) => !PLACEHOLDER.has(normalise(n)));
    const found = await stashdb.searchScenes(config, (real.length ? real : cast).join(' '), { perPage: 12 });
    return { key, term, by: 'text', unknown, unnamed, count: found.count, candidates: found.scenes };
  }

  const found = await stashdb.queryScenes(config, {
    performers: { value: ids, modifier: 'INCLUDES_ALL' },
    page: 1,
    per_page: 12,
    sort: 'DATE',
    direction: 'DESC',
  });

  return { key, term, by: 'cast', unknown, unnamed, count: found.count, candidates: found.scenes };
}

/*
 * Record which StashDB scene a cast-only row is, so Track and Add work.
 * Only records it; doesn't act.
 */
export async function resolveMissing(config, id, key, stashdbId) {
  const wanted = String(stashdbId || '').toLowerCase();
  if (!UUID.test(wanted)) throw new Error('That needs to be a StashDB scene id.');

  const held = await store();
  const proposal = held.proposals[id];
  if (!proposal) throw new Error('That proposal is no longer on the list.');

  const scene = (proposal.missing || []).find((m) => m.key === key);
  if (!scene) throw new Error('That scene is not one of this film’s missing ones.');

  const card = await stashdb.getScene(config, wanted);
  if (!card) throw new Error('StashDB does not have a scene with that id.');

  scene.stashdbId = card.id;
  scene.title = card.title;
  scene.date = card.date || null;
  scene.image = card.image || null;
  scene.performers = (card.performers || []).map((p) => p.name);
  // It has an id now, so the two answers that needed one are back on.
  scene.addressable = true;

  await save();
  return { key, scene };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* Undo one row. Only the record goes; tracked or downloaded stays. */
export async function undecideScene(config, id, key) {
  const held = await store();
  if (held.scenes[key]) {
    delete held.scenes[key];
    await save();
  }
  return { key, verdict: null };
}

/* Undo a whole proposal. An approved one's group is left alone. */
export async function reconsider(config, id) {
  const held = await store();
  const decision = held.decisions[id];
  if (!decision) return { id, verdict: null };

  delete held.decisions[id];
  await save();
  return { id, verdict: null, wasGroup: decision.groupId || null };
}
