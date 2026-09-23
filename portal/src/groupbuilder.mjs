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

/*
 * A studio's back catalogue does not change quickly and a scan of one is
 * hundreds of requests, so what a pass learned is kept on disk and only redone
 * when asked. This is the same reasoning groupurl.mjs writes down: holding an
 * expensive crawl in memory alone means every container rebuild spends somebody
 * else's budget again.
 */
const TTL = 7 * 24 * 60 * 60 * 1000;

// The whole pass gets this long, then publishes what it has and says it did.
const DEADLINE = 20 * 60 * 1000;

/*
 * How many films are asked about at once.
 *
 * Three, not six, and the number is measured. A pass at six collected 313 rate
 * limits from ThePornDB in a single run — every one of them a film dropped from
 * the scan — and tpdb.mjs now backs the whole app off when that happens. Six
 * workers each waiting out the same limit is slower than three that never hit
 * it, so the smaller pool is the faster one as well as the politer one.
 *
 * IAFD is somebody's web server and is asked one page at a time by iafd.mjs
 * itself, which is why there is no second number here.
 */
const TPDB_AT_A_TIME = 3;

/*
 * How many films one pass will ask IAFD about.
 *
 * Two pages each at 1.2 seconds is about three minutes for forty, which is a
 * length of time somebody will sit through once. New Sensations has 289 films
 * that get this far, so a studio like that takes several runs — and that is the
 * honest shape of it rather than one pass that grinds for a quarter of an hour
 * and gets closed halfway through.
 */
const IAFD_PER_PASS = 40;

/*
 * A film of one scene is not a group, whichever source said so.
 *
 * Both sources hold records nobody finished filling in, and a stub lists
 * exactly one scene. Believed, it proposes building a group around a scene that
 * already *is* the whole release — measured here first time out, on a Pure
 * Taboo record whose IAFD breakdown had a single row.
 *
 * A genuine one-scene release loses nothing by this. It is one file, it is
 * already in the library, and wrapping it in a group of one says nothing the
 * scene did not already say.
 */
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
      // Missing or corrupt: an empty store is the right recovery either way,
      // and a scan rebuilds the proposals. The decisions are the loss that
      // would matter, which is why the write below is atomic.
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

/*
 * Every scene in no group, with the three things a match needs: who is in it,
 * which studio filed it, and whichever catalogue ids it carries.
 *
 * One query for the lot. At 2,387 scenes that is a single response and every
 * comparison afterwards is in memory — the alternative is a round trip per
 * candidate film, which for one studio would be three hundred of them.
 */
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

/*
 * The shelf the page opens on: which studios have loose scenes, how many, and
 * what a scan of each has found so far.
 *
 * Ordered by how many scenes are loose, because that is the same order as how
 * much a scan of one is worth — and a studio with two loose scenes is not where
 * anybody should spend three hundred requests.
 */
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
 * Kicks a studio's scan off and hands back progress. It does not wait: one
 * studio is a few hundred TPDB calls and, for the films TPDB cannot answer for,
 * an IAFD page every 1.2 seconds — Pure Taboo is a quarter of an hour. The page
 * polls this the same way the coverage and gaps builds are polled.
 *
 * One at a time on purpose. Two scans would be two crawlers on IAFD wearing one
 * politeness delay between them, which is not politeness.
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

/*
 * A studio's TPDB site id, which is the only way into its movie catalogue.
 *
 * There is no name lookup for a site, so this comes off a scene the studio
 * actually holds — one extra call, cached with the studio. A studio whose
 * scenes all came from StashDB alone has no TPDB id anywhere and therefore no
 * catalogue to scan, which the page reports rather than swallowing.
 */
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

  /*
   * How far back the catalogue is worth reading.
   *
   * A film released before you held anything of this studio cannot contain a
   * scene you hold, and the feed is newest first — so the oldest loose scene,
   * less a year of slack for a re-release dated after the scenes on it, is a
   * floor rather than a guess. Without it New Sensations is 3,629 movies over
   * thirty-seven pages at eight seconds each, to find one film.
   */
  const dates = mine.map((s) => s.date).filter(Boolean).sort();
  const since = dates.length ? String(Number(dates[0].slice(0, 4)) - 1) + dates[0].slice(4) : null;

  progress.phase = 'reading the catalogue';
  const { movies, total, capped, read } = await tpdb.moviesForSite(config, siteId, {
    since,
    // A studio with three thousand releases spends a minute here before there
    // is anything to count, and a page that says nothing for a minute reads as
    // stuck. Pages are the only honest unit until the roster is in.
    onPage: (done, of) => { progress.looked = done; progress.total = of; },
  });

  /*
   * Indexes built once for the whole scan. `byTpdb` is the exact tier;
   * `byCast` is the probable one, and it is a multimap because two scenes with
   * the same three people in them are not the same scene — an ambiguous row is
   * shown as ambiguous rather than resolved by picking the first.
   */
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

  /*
   * The title index, which is the Bang tier's whole basis.
   *
   * Same reasoning as the cast index above and for the same measured reason —
   * built from every loose scene rather than this studio's, because a DVD
   * gathers scenes from sibling labels and a studio-scoped index throws the
   * real match away.
   *
   * A multimap for a duller reason than the cast one: two different scenes
   * genuinely can carry the same title in a library this size, usually because
   * a scraper gave both the film's name. An ambiguous title is shown as
   * ambiguous rather than resolved by taking the first.
   */
  const byTitle = new Map();
  for (const scene of all) {
    const key = bang.flatten(scene.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(scene);
  }

  /*
   * The filter that makes the rest of this affordable, and it costs nothing:
   * the roster row already carries the film's cast.
   *
   * For a film to contain a scene you hold, everyone in that scene has to be on
   * that film. So a film no loose scene fits inside cannot produce a match at
   * either tier, and asking TPDB for its scene list or IAFD for its breakdown
   * is a request that was always going to come back no. On New Sensations that
   * is 552 films worth asking about out of 1,300 read.
   *
   * A film TPDB lists no cast for is skipped rather than kept. It is the same
   * judgement this file makes at the top about a one-scene record — an unfilled
   * record is not evidence, and keeping them would put the thirteen hundred
   * back.
   *
   * `fits` is carried through because it is the only ranking available later:
   * a film two of your scenes fit inside is a better use of somebody else's
   * crawl budget than one where a single cast happens to line up.
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
   * What ThePornDB has already been asked about, so a pass that ran out of time
   * carries on rather than starting again.
   *
   * This matters more than it looks. Girlsway's performer pool is small and
   * densely shared, so 893 of its 1,000 films get this far — three passes' worth
   * of asking. Without a record of what was asked, every pass would work through
   * the same first six hundred in the same order and the rest would never be
   * reached at all. The IAFD queue below has always had this; phase one did not,
   * and that was the bug rather than the slowness.
   *
   * A film whose answer was "no scene list" still goes to IAFD, from the roster
   * row rather than a second call — the row carries everything that tier needs.
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

  /*
   * Phase one gets most of the clock but not all of it.
   *
   * The two phases are not equally valuable and the cheap one is the greedy
   * one: five hundred ThePornDB calls will happily eat the whole budget and
   * leave the IAFD leg — the only tier that answers for studios TPDB has no
   * scene lists for — never run at all. So the exact tier stops with a share
   * left, and what it did not reach is picked up by the next pass the same way
   * the IAFD queue is.
   */
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
          // The roster row already carries the IAFD link and everything else
          // the probable tier needs, so the one from the detail call is merged
          // over it rather than replacing what the list knew.
          else if (!movie.scenes.length) unresolved.push({ ...toAsk[i], ...movie });
        } catch (err) {
          // Not recorded as seen: a call that failed is one to make again.
          console.warn(`[tpdbarr] group builder: ${toAsk[i].title} -`, err.message);
        }
      }
    })
  );

  /*
   * Phase two, only over the films TPDB could not answer for — and only a
   * bounded number of those.
   *
   * This is the slow half: two IAFD pages per film at 1.2 seconds apiece, and
   * on New Sensations there are 289 films to ask about. Asking all of them in
   * one pass is a quarter of an hour of somebody else's server, and a pass that
   * long is one that gets interrupted and learns nothing.
   *
   * So each pass takes the best few and remembers which films it has asked
   * about. Best means most loose scenes fitting inside the film, because that
   * is the only evidence available before the page is read. Run the scan again
   * and it carries on with the ones it has not reached.
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
       * Bang first, IAFD second, and only when Bang had nothing.
       *
       * Both cost two pages at 1.2 seconds, so asking Bang first is free on the
       * films it answers for and costs one extra round trip on the films it
       * does not. That trade is worth making in this direction: a title match
       * needs no judgement from you and a cast match usually does, so the
       * cheaper question is also the one that produces the better proposal.
       *
       * Bang carries current and catalogue DVD releases and has nothing at all
       * for a studio like Pure Taboo, which is web-only — so on those studios
       * this leg finds nothing every time and the IAFD leg is still the whole
       * answer. Which is why it is a first ask rather than a replacement.
       */
      let proposal = await fromBang(movie, byTitle, studioId, studioName);
      if (proposal) viaBang++;

      /*
       * Then the two cast tiers, cheapest first. GameLink is one page and a
       * Stash-side search; IAFD is two pages. Neither is a better answer than
       * the other — they are the same rule over different catalogues — so the
       * order is decided by what they cost and by which has more films.
       */
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
    // Both numbers, because they say different things: how much of the
    // catalogue was read, and how much of it could possibly have held anything
    // of yours. One film asked about out of a thousand read is the pass working
    // rather than the pass giving up.
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

  /*
   * One line per pass, because a pass that finds nothing and a pass that never
   * finished look identical from outside — which is exactly the confusion that
   * cost an afternoon here. Every other long pass in this app says what it did;
   * this one was the exception and should not have been.
   */
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

/*
 * The exact tier. TPDB's scene list, matched on the id every other page in this
 * portal matches on — so a hit here is the same scene and not a scene with the
 * same name.
 *
 * A film you hold nothing of is not a proposal. This page is about what your
 * scenes add up to; a catalogue of everything a studio ever released is the
 * acquisition side's job and it already does it.
 */
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
 * The likely tier. Bang's DVD page lists a film's scenes **with their titles**,
 * so this matches a scene to a row when the two titles are the same title.
 *
 * Why this sits above the cast tier. IAFD says who is in scene three and
 * nothing else, and two scenes on one DVD sharing a cast is ordinary — a
 * two-hander shot over two days is two rows with identical casts, and the
 * probable tier has to call both ambiguous. Titles do not collide that way.
 * They are also the thing your files already carry, so a match here needs
 * nothing IAFD needs and agrees with what you can see on the shelf.
 *
 * Why it sits below the exact tier all the same. A title is a string two people
 * typed, not an id — Bang's "Elsa Jean's pedicure with French tips gets covered
 * in cum" and your scraper's spelling of the same scene agree after `flatten`
 * and would not agree before it. That is a good guess and it is still a guess.
 *
 * Cast is used as a tie-break and never as the match. Where two of your scenes
 * flatten to one title, the row's cast picks between them when Bang printed one
 * — it prints a cast beside most scenes and not all — and where it cannot, both
 * are named and neither is filed.
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

    /*
     * The tie-break, and only ever a tie-break: it narrows two scenes that
     * already agreed on the title, and can never introduce one that did not.
     */
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
      // Bang named this one, which IAFD's rows never do — so a missing scene
      // here is something you can go and look for rather than a gap with a
      // cast list attached.
      title: row.title,
      date: null,
      image: null,
      tpdbGuid: null,
      tpdbId: null,
      siteId: movie.siteId ?? null,
      performers: row.performers,
      /*
       * A title is not an id. Whisparr fetches by id, so the button that would
       * add this cannot work and the page says so rather than offering it —
       * the same honesty the IAFD tier's rows get, for the same reason.
       */
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
 * The probable tier again, by a different route.
 *
 * GameLink's movie page lists a film's scenes with the cast of each — and does
 * not name them, which is the single fact that puts this here rather than up
 * beside Bang. Same evidence as IAFD, same set-equality rule, same ambiguity
 * when two rows share a cast.
 *
 * It is worth having anyway, for coverage. GameLink fronts the AdultEmpire
 * catalogue — 150,000-odd films — and answers for studios the other two legs
 * do not: measured while this was written, Pure Taboo's "The Family Tradition"
 * comes back with its scenes here and with nothing at all from Bang. It is also
 * the cheaper ask, one page against IAFD's two, which is why it goes first of
 * the two cast tiers.
 *
 * The attributes each row carries are kept but not matched on. They are a
 * genuine extra — IAFD gives nothing like them — and a scene's attributes are
 * not distinctive enough to identify it, so they ride along as evidence for a
 * person reading the proposal rather than as part of the guess.
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
      // A cast and a set of attributes, and no id — so there is nothing for
      // Whisparr to fetch and the page says so rather than offering a button
      // that cannot work. Same honesty the IAFD rows get.
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
 * The probable tier. IAFD lists a film's scenes as casts and nothing else, so
 * this matches a scene to a row when the two casts are the same set and the
 * scene is filed under this studio.
 *
 * Set equality rather than overlap, deliberately. A row of three people that
 * merely *includes* your scene's two is a different scene, and treating it as a
 * match is how a film ends up with somebody else's work filed inside it.
 *
 * Two owned scenes with identical casts make the row ambiguous. Both are named
 * and neither is filed — you pick, or you do not, and the group is built either
 * way with whatever was unambiguous.
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
      /*
       * IAFD named the cast and nothing else, so there is no id to track this
       * by and nothing for Whisparr to fetch. The page offers to go and find it
       * rather than pretending the button would work.
       */
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
 * Which IAFD record is this film.
 *
 * The link TPDB already holds is taken without asking anything, because it is
 * somebody's answer rather than ours. Failing that the title is searched, and
 * the result is only believed when the title matches outright and the year is
 * within one of TPDB's — "Under the Bed" returns seventeen films and sixteen of
 * them are not this one, which is the whole reason this check exists.
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

/* -------------------------------------------------- what the titles say
 *
 * The third tier, and the only one that asks nobody anything.
 *
 * Some scenes carry their film's name already:
 *
 *   Michelle Wild in Barely Legal #29
 *   Britney in Barely Legal #14
 *   Plants vs Cunts Vol. 6
 *
 * That is not a guess about what a film contains — it is what the file says it
 * is. Across this library it finds 33 films covering 120 loose scenes, with no
 * ThePornDB call and no IAFD page, and it lands hardest exactly where the other
 * two tiers are weakest: the 955 loose scenes carrying no ThePornDB id at all,
 * which the exact tier cannot see.
 *
 * **A number is required.** "Barely Legal" is a series and "Barely Legal #14"
 * is a film; without the number this would gather a decade of unrelated scenes
 * under one name. So a title only implies a film if it names a numbered one.
 *
 * **How big the film is comes from IAFD**, asked once per film and kept. The
 * titles say which scenes belong; the breakdown says how many there were, and
 * the rows nothing of yours sits in are the ones you are missing.
 *
 * Scenes are placed against those rows **by the name in the title, not by the
 * cast Stash holds** — because four of the five Barely Legal 126 scenes here
 * have no performers tagged at all. "Abbie Anderson in Barely Legal #126"
 * against a row reading "Abbie Anderson, Eric John" is the match; the tagged
 * cast is the fallback for scenes that are billed to nobody.
 *
 * A film IAFD cannot be found for keeps no denominator at all rather than
 * borrowing the count of what you hold. An invented denominator is worse than
 * none: it reads as a fact about the film when it is only a fact about you.
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
 * -> {name, index} or null.
 *
 * Read right to left, because that is where the film's name sits: a trailing
 * "Scene 3" is the part number, and everything after the last " in " is the
 * release. A title with neither shape is taken whole, which is how
 * "Plants vs Cunts Vol. 6" works.
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

  /*
   * Who the title says is in it, which turns out to matter more than the cast
   * Stash holds. Four of the five scenes of Barely Legal 126 in this library
   * have **no performers tagged at all** — the name only exists in the title,
   * "Abbie Anderson in Barely Legal #126", and IAFD's row for that scene reads
   * "Abbie Anderson, Eric John". So the billing is what places a scene against
   * a breakdown; the tagged cast is the fallback, not the other way round.
   */
  const billed = after ? String(title).slice(0, String(title).lastIndexOf(after[1])).replace(/\bin\s*$/i, '').trim() : null;

  return { name, index, billed: billed || null };
}

/*
 * Best-effort dressing for a film the titles named.
 *
 * ThePornDB is asked once per film and only believed when the title matches
 * outright, because the search returns near-misses for anything it cannot
 * place, and a near-miss here puts another film's cover and date on this one.
 * What it adds is a poster, a real release date and an address; what it cannot
 * add is a scene count, because these records carry no scene list.
 *
 * A film it has never heard of is still a proposal. The evidence for it came
 * from the files, not from TPDB.
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
 * How big is a film the titles named, and what of it is missing?
 *
 * The titles say which scenes belong to a release; they cannot say how many the
 * release had. IAFD can — its Scene Breakdowns list one row per scene — so this
 * asks it for a denominator and for the rows nothing of yours sits in.
 *
 * Held scenes are placed against those rows by cast, the same way the probable
 * tier does it. And there is a guard on the result: if a scene you hold could
 * not be placed on any row, then the rows and the files disagree about who is
 * in this film, and the leftovers are not evidence of anything. In that case
 * the size is still taken — it is IAFD's own count — and no claim is made about
 * what is missing. Half an answer, said as half an answer.
 */
async function sizeFromIafd(name) {
  const page = await findOnIafd({ title: name, date: null, links: {} }).catch(() => null);
  if (!page || page.scenes.length < CREDIBLE) return null;

  // The rows are kept, not just counted. Placement is free once you have them,
  // so a later pass can redo it against a changed shelf without asking again.
  return { url: page.url, compilation: page.compilation, rows: page.scenes };
}

/*
 * Which of a film's scenes you have, and which rows nothing sits in.
 *
 * Offline — it works on rows already fetched, which is what lets this be redone
 * on every pass as scenes arrive without costing IAFD a page.
 */
function placeOnRows(rows, heldRows) {
  const key = (names) => (names || []).map(normalise).filter(Boolean).sort().join('|');

  const placed = new Set();
  const empty = [];

  for (const row of rows) {
    const on = new Set((row.performers || []).map(normalise).filter(Boolean));

    /*
     * Billing first, tagged cast second. A scene billed to somebody the row
     * lists is that row — one name inside a two-name row is enough, because the
     * film is already established and only the position is in question. Cast
     * equality is the fallback for scenes properly tagged and not billed.
     */
    const mine =
      heldRows.find((r) => !placed.has(r.sceneId) && r.billed && on.has(normalise(r.billed))) ||
      heldRows.find((r) => !placed.has(r.sceneId) && r.cast?.length && key(r.cast) === key(row.performers));

    if (mine) placed.add(mine.sceneId);
    else empty.push(row);
  }

  const unplaced = heldRows.length - placed.size;

  return {
    total: rows.length,
    /*
     * Named only when every scene you hold found a row. A scene that could not
     * be placed might *be* one of the empty rows under a name neither source
     * agrees on, and saying "you are missing scene 3" while holding something
     * that could be scene 3 is worse than saying nothing. The count still
     * stands; only the naming is withheld.
     */
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

/*
 * One pass over the whole library rather than one studio at a time — this tier
 * needs no catalogue, so there is nothing to scope it to.
 *
 * Grouped by film name **and Stash studio**. Studio is a weak key when matching
 * across two catalogues, which is why the other tiers do not gate on it; here
 * both scenes are records in the same library, so it agrees with itself and it
 * stops two studios' "Volume 3" becoming one film.
 */
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

  /*
   * The ones nothing has looked up yet go first, so a pass that runs out of
   * time moves the shelf on rather than re-asking about the same films. Same
   * contract as the roster walk and the IAFD queue, and the same reason: with
   * thirty-odd films and two lookups apiece, one pass does not reach them all.
   */
  const knownRows = (film) => held.proposals[`titles:${film.key}`]?.iafd?.rows;
  worth.sort((a, b) => (knownRows(a) ? 1 : 0) - (knownRows(b) ? 1 : 0));

  progress.total = worth.length;
  progress.phase = 'asking what these films are';

  const until = Date.now() + DRESS_DEADLINE;
  let found = 0;

  for (const film of worth) {
    progress.looked++;

    /*
     * Ordered by the part number where a title gave one, and by date where it
     * did not. Both beat the order Stash happened to return them in, and a
     * wrong order inside a group is a thing you can see and fix — a wrong
     * membership is not.
     */
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

    /*
     * What was already looked up is kept. Both lookups cost somebody else a
     * page, neither answer changes week to week, and the placement below is
     * redone from the stored rows every pass anyway — so an arriving scene
     * still moves the count without a single request.
     */
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
      /*
       * IAFD's row count where it has one; otherwise unknown, and left unknown
       * rather than quietly set to what you happen to hold.
       */
      total: sized?.total ?? null,
      iafd: iafd
        ? { url: iafd.url, compilation: iafd.compilation, rows: iafd.rows, unplaced: sized?.unplaced ?? null }
        : null,
      held: heldRows,
      /*
       * The rows nothing of yours sits in. Cast and a number, because that is
       * all IAFD gives — so these are not addressable and the page offers to go
       * and find them rather than a Track button that could not work.
       */
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
 * The groups you already built, measured again.
 *
 * A scene stops being loose the moment it is filed, so the pass above cannot
 * see a film once its group exists — which left forty-three groups here frozen
 * at whatever was known when they were made, most of them from before there was
 * any way to say how big the film was. "What is this group missing" is the
 * question that outlives the building of it, and this is where it gets asked.
 *
 * Read from the group rather than from the shelf: the group is the statement of
 * what belongs, and its scenes are exactly the ones to place against the
 * breakdown.
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

  /*
   * Every group in one read, then indexed by id.
   *
   * Not filtered to the ones wanted, because GroupFilterType has no `id` field
   * to filter on — checked against the schema after a version of this quietly
   * asked for one and had its error swallowed, which is why the catch below
   * says something now instead of returning nothing.
   */
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

/*
 * A declined proposal comes back only when you hold a scene of that film you
 * did not hold when you declined it. Everything else about it may have changed
 * — the cover, the synopsis, the scan that found it again — and none of that is
 * the thing you said no to.
 */
function reopened(proposal, decision) {
  if (decision.verdict !== 'declined') return false;
  const then = new Set(decision.owned || []);
  return (proposal.held || []).some((row) => row.sceneId && !then.has(row.sceneId));
}

function openProposals(held) {
  return Object.values(held.proposals).filter((proposal) => {
    /*
     * Enforced on the way out as well as on the way in, so a rule tightened
     * later applies to what earlier passes already wrote down rather than only
     * to what the next scan finds.
     *
     * Measured against what you hold when the film's size is unknown — the
     * titles tier has no denominator, and "two scenes say they are this film"
     * is the same evidence as "two of this film's four scenes are here".
     */
    const size = proposal.total || (proposal.held || []).filter((row) => row.sceneId).length;
    if (size < CREDIBLE) return false;

    const decision = held.decisions[proposal.id];
    if (!decision) return true;
    if (decision.verdict === 'approved') return false;
    return reopened(proposal, decision);
  });
}

/*
 * What is waiting on you. The exact tier above the probable one and newest
 * first inside each — the ones that need no judgement should not be buried
 * under the ones that do.
 */
export async function proposals(config, { studio = null } = {}) {
  const held = await store();
  const mine = (p) => !studio || p.studioId === studio;

  const open = openProposals(held).filter(mine);

  /*
   * Strongest evidence first: an id, then a scene list that named the scene and
   * agreed with your title, then what the file says about itself, then a cast
   * that lines up. The ones needing no judgement should not be buried under the
   * ones that do.
   */
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

  /*
   * Groups you have built that still have a question open.
   *
   * Building one and answering what it is missing are two steps, and the second
   * one is where a page reload used to lose you: the proposal left the list the
   * moment the group existed, taking the unanswered scenes with it. So an
   * approved film stays visible until every scene it is missing has been
   * tracked, added or ignored, and then it goes quiet on its own.
   */
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
 * Building the group.
 *
 * The order matters. The group is created first and the scenes are filed into
 * it afterwards, so a failure halfway leaves an empty group you can see and
 * delete rather than scenes pointing at something that does not exist.
 *
 * The addresses go on it because that is what makes the group scrapeable later:
 * Stash's own AdultEmpire scraper walks through the age gate this portal will
 * not, so a group carrying that URL can be filled in from the Movies page
 * without anybody typing anything.
 *
 * Studio is taken from the scenes rather than from TPDB's idea of the site.
 * Stash wants an id and the scenes already carry the right one.
 */
export async function approve(config, id, { sceneIds = null } = {}) {
  if (!stashConfigured(config)) throw new Error('Stash is not configured.');

  const held = await store();
  const proposal = held.proposals[id];
  if (!proposal) throw new Error('That proposal is no longer on the list.');

  /*
   * Every scene this film could be built out of, which is not the same list as
   * the rows on screen: an ambiguous row has no scene of its own and two
   * candidates underneath it. Flattening them in here is what lets a pick made
   * on the page actually be filed — without it the choice is sent, matched
   * against nothing, and quietly dropped.
   */
  const certain = (proposal.held || []).filter((row) => row.sceneId);
  const options = (proposal.held || []).flatMap((row) =>
    (row.ambiguous || []).map((option) => ({ ...option, index: row.index })));

  /*
   * With no list, only the certain rows go in — an ambiguous row that nobody
   * chose between stays out, because filing both candidates is the one mistake
   * the ambiguity was flagged to avoid.
   */
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
   * The cover is the one field that can fail for a reason that has nothing to
   * do with the group. Stash fetches an image URL at mutation time, and some
   * studios sign theirs — New Sensations' posters carry a validfrom/validto and
   * a hash — so a stale roster row can turn "build this group" into an error
   * about a picture. A group without its cover is worth having; the cover
   * without the group is not, and the Movies page can scrape one later from the
   * AdultEmpire address this puts on it.
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
 * One missing scene, answered.
 *
 *   track  — put it on the want list, which is keyed on StashDB ids, so a scene
 *            TPDB named has to be found there first.
 *   add    — hand it to the downloader now.
 *   ignore — not part of this film's gap, as far as you are concerned.
 *
 * **Ignoring here is local to this page and does not touch the want list's own
 * ignore list.** The two look like the same word and are not: that one means
 * "not for me" and quietly removes the scene from the tracked percentage on
 * every other page. Saying "I do not need this to call the film complete"
 * should not silently move a number somebody else is reading.
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

/*
 * TPDB named the scene; StashDB is where the want list lives. bridge() is the
 * same crossing the acquisition side already makes — fingerprints first, then
 * title and date, and it says which one answered.
 */
async function toStashdb(config, scene, proposal) {
  /*
   * A row somebody has already pointed at a StashDB scene needs no bridge —
   * there is no guess left in it, which is why the match reads as named rather
   * than as probable.
   */
  if (scene.stashdbId) {
    const card = await stashdb.getScene(config, scene.stashdbId).catch(() => null);
    if (card) return { match: 'named', scene: card, via: 'you picked it', others: [] };
  }

  if (!scene.tpdbGuid) return null;
  const full = await tpdb.getScene(config, scene.tpdbGuid).catch(() => null);
  if (!full) return null;
  return stashdb.bridge(config, { ...full, siteName: full.siteName || proposal.studioName });
}

/*
 * v2 takes ThePornDB scenes and v3 takes StashDB ones, and which of the two
 * this scene can go to is decided by the id it has rather than by a preference.
 * A scene IAFD named and nothing else has neither, and this says so instead of
 * reporting a success nothing happened for.
 */
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

/*
 * The cast IAFD gave, looked for on StashDB.
 *
 * This is the "Find it" the missing rows offer when IAFD named people and
 * nothing else. It searches rather than asserts: what comes back is candidates
 * for you to look at, exactly as the Match page does with an unmatched scene,
 * and pressing track or add afterwards is a separate sentence.
 */
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
   * Searched by cast as *people*, not as words.
   *
   * The first version of this joined the studio name and the performer names
   * into one string and handed it to StashDB's text search. That search reads
   * titles, so a row of four names matched on whichever of them happened to
   * appear in somebody's title and the results were a list of scenes with one
   * actress in common and nothing else. The row asserts a cast, so the query
   * should be a cast: each name resolved to its StashDB performer, then every
   * scene that has all of them.
   *
   * INCLUDES_ALL rather than INCLUDES, for the same reason fromIafd insists on
   * set equality — a scene with one of the four is a different scene, and
   * offering it as a candidate invites the wrong pick.
   *
   * The studio is deliberately not part of this. A DVD gathers scenes from
   * sibling labels, which is the whole reason the cast match upstream is not
   * studio-scoped either.
   */
  const ids = [];
  const unknown = [];
  const unnamed = [];

  for (const name of cast) {
    /*
     * IAFD writes a stand-in where a film did not credit somebody, and this
     * house's breakdowns carry "guy" three times. StashDB has three performers
     * literally named Guy, so the exact-name rule below happily resolves it,
     * ANDs a stranger into the query and returns nothing — while reporting
     * `by: 'cast'` with an empty `unknown`, which reads as "asked properly,
     * genuinely not there". A confident wrong answer, and worse than the text
     * search this replaced.
     *
     * The list is explicit rather than a shape rule on purpose: "Jowy" and
     * "Eze" are one short word each and are real people, so anything that
     * rejected placeholders by length would throw them away too.
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

  /*
   * Nobody resolved — a cast of names StashDB does not hold under those
   * spellings. Text search is the only thing left and it is worth one try, but
   * the answer says which way it was asked so a thin result is readable rather
   * than mysterious.
   */
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
 * "That one." — naming which StashDB scene a cast-only row actually is.
 *
 * This is what makes Track and Add possible on the probable tier at all. IAFD
 * hands over four people and no title, so until somebody says which scene that
 * is there is nothing to want and nothing to fetch; the row offers Find it, you
 * pick, and the two answers that needed an id turn on.
 *
 * The pick is written onto the proposal rather than acted on. Saying what a
 * scene is and saying what to do about it are two sentences, and this is only
 * the first.
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

/*
 * Undo, for the row you pressed by accident. Only the record goes — a tracked
 * scene stays tracked and a downloaded one stays downloaded, because this page
 * did not put the file there and should not be the thing that takes it away.
 */
export async function undecideScene(config, id, key) {
  const held = await store();
  if (held.scenes[key]) {
    delete held.scenes[key];
    await save();
  }
  return { key, verdict: null };
}

/*
 * Undo, for a whole proposal. A declined film comes back on the list; an
 * approved one does too, and the group it made is left exactly where it is —
 * deleting a group is the film shelf's job and it asks properly.
 */
export async function reconsider(config, id) {
  const held = await store();
  const decision = held.decisions[id];
  if (!decision) return { id, verdict: null };

  delete held.decisions[id];
  await save();
  return { id, verdict: null, wasGroup: decision.groupId || null };
}
