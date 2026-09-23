/*
 * The acquisition search.
 *
 * One question, asked with filters instead of by scrolling: what exists, and
 * what of it do I not have. StashDB is the catalogue it runs on — not because
 * it is the biggest, but because its ids survive the whole trip. A scene found
 * here goes to Whisparr v3 under a UUID, arrives in Stash carrying the same
 * UUID, and can be recognised again next time. ThePornDB is the wild card at
 * the bottom of the page: same standard of data, different coverage, a
 * different route out, and no id that means anything to Stash until the file
 * lands.
 *
 * Two things this module is careful about.
 *
 * **What "have" means.** Whisparr is a downloader here — a scene sits in it for
 * the hours between grabbing and importing, then Stash imports it and Whisparr
 * is told to delete it. So a Whisparr holding nothing is the expected end
 * state, and every count of what you own is counted in Stash. Whisparr is still
 * asked, so a scene already monitored is not reported back as a gap.
 *
 * **Which stash id.** Roughly a third of this library was identified against
 * ThePornDB's stash-box rather than StashDB's, so matching on StashDB ids alone
 * reports scenes as missing that are on the disk. Title and date is the second
 * pass, and everything that uses it is labelled `probable` rather than being
 * quietly counted as certain.
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

/* ------------------------------------------------------- do I have this
 *
 * Both passes at once, for a page of scenes. Exact first: a StashDB id in
 * Stash is the same scene and there is nothing to argue about. Then title and
 * date for whatever is left, which is where the TPDB-identified half of the
 * library gets recognised.
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
 * `count` is StashDB's count of the whole match, not of what is on screen —
 * every filter goes into the query, so it is a real total. `hidden` is how many
 * of *this page* were dropped for being in the library already, which is the
 * only honest way to report a filter applied after the count: the toggle that
 * brings them back says the same number.
 */
/*
 * How many StashDB pages one decide request will read through before answering.
 *
 * A catalogue you have nearly finished is mostly decided, so the undecided ones
 * are sparse and a single page of twenty-four can hold none at all. Without a
 * bound a request could walk six hundred scenes; without *any* walking, the
 * browser would ask twenty times for one card. Eight is the compromise, and the
 * cursor means an empty answer is still progress rather than a dead end.
 */
const DECIDE_PAGES = 8;

/*
 * The decide queue.
 *
 * Deciding is not browsing, and it cannot be paged. StashDB counts the whole
 * catalogue; what reaches the screen is what is left after the ignored, the
 * held and the already-wanted are dropped — so page four of six hundred can
 * legitimately hold nothing, and every answer given reshuffles which survivors
 * land on which page. Numbering that is a promise the data cannot keep.
 *
 * So this walks StashDB from a cursor until it has a batch worth showing and
 * says where it got to. The browser asks again when the batch on screen runs
 * out, and a null cursor is the end of the catalogue rather than an empty page.
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

/* ------------------------------------------------------ everything at once
 *
 * The same queue, over every catalogue you follow.
 *
 * Deciding was always per-catalogue: open a studio, work down it, come back
 * tomorrow for the next one. That is the right shape for a catalogue and the
 * wrong one for a backlog — the question "what is there to do" had no page
 * that answered it, only forty-eight cards each holding a bit of the answer.
 *
 * **The cursor carries two numbers now.** One catalogue's queue remembers how
 * far down StashDB it has read; this one has to remember which catalogue as
 * well, so the mark is `<which>:<page>`. Run off the end of a catalogue and it
 * steps to the next and starts at page one. A null cursor still means the same
 * thing it always did: there is no more, anywhere.
 *
 * Walked in the order the list is kept rather than worst-first. A queue that
 * always opened on the same enormous studio would be the same studio every
 * day, and the point of pooling them is that you stop choosing.
 *
 * **Scenes are deduplicated within a batch.** A performer you follow shooting
 * for a studio you follow is one scene under two catalogues, and two cards
 * asking the same question is the queue wasting your time twice.
 */
async function pooledBatch(config, params, perPage) {
  // This can be the first page asked for after a restart, and it reads the
  // measurements twice over — to step past finished catalogues, and for the
  // total. Both are wrong if the file has not been read back yet.
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

  /*
   * Catalogues already answered for are stepped over rather than read.
   *
   * Without this the walk spends its whole allowance of StashDB pages inside
   * the first catalogue on the list, which on a finished one means eight reads
   * for nothing and a queue that looks empty until the browser has asked
   * twenty times. The measurements say which are finished, so this uses them —
   * and a catalogue not yet measured is read rather than assumed either way.
   */
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

  /*
   * The size of the job, taken from the measurements the tracked page already
   * holds rather than counted again here. Null while anything is still being
   * measured: a total that is missing a catalogue is worse than no total,
   * because it looks like one.
   */
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
 * Best first, within the batch that was read.
 *
 * **Within the batch and said so.** A true ranking of the whole backlog would
 * mean reading every one of six thousand scenes before drawing the first card,
 * and StashDB hands over a page at a time. So this orders what this request
 * walked — a couple of hundred scenes — and the next batch orders itself when
 * it arrives. What that buys is real: the performer you own forty of is at the
 * top of each screenful instead of wherever the release date left her.
 *
 * Ties keep the order they came in, which is the sort you chose. A scene
 * nothing in your library speaks for scores zero and sits at the bottom rather
 * than being dropped — ranking is an order, never a filter.
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

  /*
   * A decision you already made is dropped unless you asked to see the
   * decisions — "not for me" that keeps reappearing is not a decision, it is a
   * nag. The other end of that idea, only the ones still to answer, is the
   * queue above and never reaches here.
   */
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

/*
 * The wild card. Only ever asked on purpose — it is a different catalogue with
 * a different route out, so blending it into the results above would hide which
 * Whisparr a card is about to talk to.
 */
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

/* --------------------------------------------------------- the filter chips
 *
 * Asked of StashDB rather than filtered in the browser, because its search
 * matches aliases: "Vixen" finds the studio, and a performer's old name finds
 * them under the new one.
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

/*
 * A search arriving as a bookmarked URL has ids and no names. Rather than
 * render chips reading "01a03a3d-…", the ids are turned back into names once,
 * on the way in.
 */
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

/* ------------------------------------------------------------- what I track
 *
 * The percentage on a studio or a performer only means something against a
 * catalogue somebody chose. Measured automatically against everything, it would
 * be a number about how complete StashDB is rather than about this library —
 * and it would cost a full catalogue read per studio on every page load.
 *
 * So it is a list you keep. Track a studio and it gets measured; untrack it and
 * the measuring stops.
 */

const trackedList = (config) => ({
  studios: config.tracked?.studios || [],
  performers: config.tracked?.performers || [],
  /*
   * Tags are tracked the same way, and they are not the same thing. A studio
   * or a performer is a catalogue you can be complete against; a tag is a
   * subject you dip into, and nobody wants every scene that has ever been
   * filed under Blowjob. What they share is the useful half — a list of scenes
   * to decide about — so they share the machinery and the page says which of
   * them a percentage means anything for. See coverageSnapshot.
   */
  tags: config.tracked?.tags || [],
  // Carried through every save so that marking a studio does not drop the
  // want list, and marking a scene does not drop the studios.
  scenes: config.tracked?.scenes || [],
  ignored: config.tracked?.ignored || [],
});

/* ------------------------------------------------------------- the rules
 *
 * The standing noes, read in one place. Cleaned on the way out rather than
 * trusted from the file: a rule with a blank phrase or a length of zero would
 * match everything or nothing, and both are worse than not being there.
 */
export const decideRules = (config) => rules.cleanAll(config.decideRules);

/*
 * Changing them changes every count on the tracked page, because a scene a
 * rule hides is no longer one you have to answer for. Counted again rather
 * than measured again — the catalogues have not changed, only which of their
 * scenes you would say no to. See recount().
 */
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

/* ------------------------------------------------------------ tracked scenes
 *
 * A want list, and the reason it is kept here rather than in Whisparr.
 *
 * Whisparr fetches files. It does not remember what you meant to get: it is
 * emptied as scenes import, things get added to it by hand, and deleting one
 * out of it is routine housekeeping. A list of what you are after cannot live
 * in a place that is designed to be emptied.
 *
 * So a mark is made against the StashDB scene id — the same id the file carries
 * into Stash once it lands, which is what lets a tracked scene be recognised as
 * arrived without asking the downloader anything at all.
 */

const sceneList = (config) => config.tracked?.scenes || [];

export function trackedScenes(config, { studio = null, performer = null } = {}) {
  const all = sceneList(config);
  const here = studio ? all.filter((s) => s.studioId === studio) : all;

  // The cast is kept on the record for exactly this: a want list read by
  // performer costs no more than one read by studio does.
  return performer ? here.filter((s) => (s.performers || []).some((p) => p.id === performer)) : here;
}

/*
 * Enough of the scene to draw it again. Kept rather than fetched because a want
 * list is read far more often than it is written, and a page of it should not
 * cost one StashDB read per card.
 */
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
 * Fill in fields the want list did not used to keep.
 *
 * A mark stores enough of the scene to draw the card again without going back
 * to StashDB, so what a card shows and what a record holds have to agree — and
 * when the card grew a description, two thousand older marks did not have one.
 * Rather than reading StashDB on every page load for a field that never
 * changes, the gap is filled once and stays filled.
 *
 * Only the records actually missing something are asked about, so running this
 * a second time costs one config read and no StashDB at all. Written a chunk at
 * a time against a freshly read config: a backfill of seventy requests is long
 * enough that marking a scene halfway through is a real possibility, and a
 * single save at the end would throw that mark away.
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

/* ------------------------------------------------------------ dispositions
 *
 * A tracked studio or performer is a catalogue, and a catalogue is a pile of
 * decisions waiting to be made. Every scene in one is in exactly one of three
 * states:
 *
 *   ignored    — not for me. Out of the results, and out of the numbers.
 *   tracked    — I want this, or I already have it.
 *   undecided  — new since the last time you looked at this catalogue.
 *
 * **Owning a scene counts as tracked**, without anyone pressing anything. The
 * alternative is that a studio you have collected for years reads 0 of 0 until
 * you have clicked through six hundred scenes to say you meant to own the ones
 * you own. The decision a scene needs is only ever about a scene you do not
 * have.
 *
 * Undecided is what keeps the percentage honest. It is not a state you set —
 * it is what is left, and it is why a catalogue that has released something new
 * says so rather than quietly diluting a number you thought you understood.
 *
 * The ignore list is ids and nothing else. It grows fastest of the three, it is
 * never drawn as cards, and every question asked of it is "is this id in here".
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
 * Many at once, and one write.
 *
 * ignoreScene() above saves the config per scene, which is right for a button
 * on a card and wrong for a screenful: twenty answers would be twenty rewrites
 * of a file that already holds a thousand ignored ids, and any one of them
 * failing halfway would leave the browser and the disk disagreeing about what
 * had been decided. This is one pass and one save.
 *
 * -> how many were actually added, which is not the same as how many were
 * asked for: a scene already on the list is not skipped twice.
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

/* ------------------------------------------------------- the rest of it
 *
 * Skipping everything a filter still has to say.
 *
 * The queue is one card at a time on purpose, and for most catalogues that is
 * the right shape. It stops being the right shape on a studio with two
 * thousand scenes and nothing in it you want: there the answer is the same for
 * all of them and giving it two thousand times is not a decision, it is a
 * chore.
 *
 * It cannot be done in the request that asks for it. Every id has to come off
 * StashDB, a page at a time, and each page has to be annotated against Stash
 * before anything is written — a scene you already hold or already asked for
 * is not one to skip. On a large catalogue that is a minute or more of
 * somebody else's API, sequentially, because parallel is how you get rate
 * limited off StashDB for the afternoon.
 *
 * So it is a job, with a progress the page can watch, and one at a time.
 */
let sweeping = null;
let sweep = { running: false, done: 0, skipped: 0, count: 0, error: null, subject: '', at: 0 };

export const sweepStatus = () => ({ ...sweep, running: Boolean(sweeping) });

/*
 * Every page from here to the end of the catalogue, ignoring what is still
 * undecided as it goes.
 *
 * Written in batches rather than once at the end, and the reason is what
 * happens when this is stopped or dies halfway: the work done so far is on
 * disk and the queue you come back to is genuinely shorter. A single write at
 * the end would make an interrupted sweep worth nothing.
 */
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

/*
 * The want list, asked the same questions a search result is: is it in Stash
 * yet, and is the downloader doing anything about it. `missing` is the count
 * that matters — a tracked scene that has arrived is not a gap any more.
 */
/*
 * Scenes you want that nothing you track would have found for you.
 *
 * The want list and the tracked catalogues overlap heavily by design — most of
 * what is on it was marked while working through a studio or a performer, and
 * those scenes are already counted, measured and queued somewhere else. What
 * is left over is the interesting part: the ones marked off a search, off the
 * feed, off somebody's recommendation, and which no catalogue on this page
 * will ever remind you about again.
 *
 * Matched on the studio and the performers, because those are what a want
 * record actually carries. **Tracked tags are not part of it** — a want record
 * has never stored a scene's tags, so there is nothing here to match them
 * against, and a scene wanted for its tag alone will still show as its own.
 * Said out loud rather than quietly approximated.
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
 * Do I have this, file-wise?
 *
 * Stash is the library of record, but it is the *end* of the flow: a scene
 * that v3 has already downloaded and not yet handed over sits in neither
 * "arrived" nor anywhere else, and a want list that calls it missing is
 * telling you to go and get something that is already on the disk. Having a
 * file, wherever it is in the process, means having it.
 *
 * Monitored is not having it. v3 wanting a scene is a statement about the
 * future, and the future is exactly what this list is for — so the line is
 * the file itself, not the record.
 */
export const haveFile = (scene) => Boolean(scene.stash || scene.whisparr3?.hasFile);

export async function trackedSceneView(config, { studio = null, performer = null, loose = false } = {}) {
  /*
   * Asked about one studio or one performer, the filter is meaningless and
   * actively wrong: the studio page asks this for *its own* wanted scenes, and
   * dropping everything a tracked catalogue covers would empty it precisely
   * when that studio is one you track. The toggle belongs to the whole list.
   */
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

/* -------------------------------------------------- measurements on disk
 *
 * A measurement is a full read of a catalogue off StashDB and a match of it
 * against Stash, six hours' worth of cache and about two minutes for the forty
 * eight of them. Keeping that only in memory meant every restart threw it
 * away: the tracked page opened on dashes, the pooled queue had no idea which
 * catalogues were finished, and the whole thing was bought again from StashDB
 * for no reason other than the process having stopped.
 *
 * So it is written down. It is derived data and it is treated as such — the
 * file is a cache, every row keeps the time it was taken, and anything past
 * the six hours is re-measured exactly as it would have been.
 *
 * **Thrown away when the rules change**, because the rules decide what counts
 * as undecided. The file carries the rules it was measured under; if they do
 * not match what the config now says, it is a file about a different question
 * and is dropped rather than shown.
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
       * Rows past their life are loaded too, and it used to be the opposite.
       * The thinking was that a stale row on screen is the one thing a cache
       * must not do — but the alternative was every card reading "Measuring…"
       * for two minutes after every restart and every six hours, which is what
       * made the page slow to paint. ensureCoverage() still sees them as past
       * their life and re-reads them straight away; they are what is shown
       * until it has.
       *
       * The rules check above still throws the whole file away. A row counted
       * under different rules is not a slightly old answer, it is the answer
       * to a different question.
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

/*
 * Written after a pass rather than after each catalogue: a pass is when the
 * numbers are worth keeping, and forty eight writes to say the same thing is
 * forty eight writes.
 */
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
 * What each catalogue was last measured *from* — the scenes StashDB listed and
 * which of them you held — kept beside the counts, so a decision can be
 * counted without asking anybody anything. Memory only: it is rebuilt by the
 * next pass after a restart, and until then the counts on disk stand in.
 */
const inputs = new Map(); // keyOf(entry) -> gather() result

/*
 * A decision was made. Count again; do not measure again.
 *
 * This used to be forgetCoverage(), and every skip, every unskip and every
 * rule saved called it: the whole cache cleared, the file on disk emptied,
 * and the next look at the Tracked page put all forty-eight cards back to
 * "Measuring…" while StashDB was read from the top. Working down the decide
 * queue meant doing that once a card. It was the slowness, and it was most of
 * the inconsistency too — the page showed a different mix of measured and
 * unmeasured rows every time it was opened, and the totals climbed as they
 * filled in.
 *
 * A decision does not change what a catalogue holds, only which pile each of
 * its scenes goes in, and that is classify() over a list already in memory.
 * So the counts move the moment the decision is saved, by exactly the amount
 * it deserves, and the page never goes blank to get there.
 *
 * Wanting a scene calls this too, which it never did: skipping wiped the
 * cache and wanting left it alone, so the counts were wrong in one direction
 * for up to six hours and then jumped.
 *
 * **Two things still need a real measurement**, and those catalogues are
 * marked stale — kept on screen and re-read in the background, never
 * blanked:
 *  - nothing in memory to count from, which is the first decision after a
 *    restart, when the rows came off disk and the scenes they were counted
 *    from did not;
 *  - a rule that needs a field this copy was fetched without — a tag or a
 *    length rule added to a set that had neither, which means StashDB has to
 *    be asked for the bigger record.
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

  // Start the re-read now rather than on the next page load, so the numbers
  // that could not be counted in place are on their way by the time anybody
  // looks.
  if (stale) ensureCoverage(config).catch(() => {});
}

/*
 * What the page renders. Anything not measured yet comes back marked pending
 * rather than absent, so a tracked studio appears the moment it is tracked and
 * fills in its number when it has one.
 */
/*
 * How big a catalogue can be before a percentage of it is a lie.
 *
 * Coverage is measured over the first COVERAGE_CAP scenes StashDB returns, so
 * anything larger is a fraction of a sample rather than of the thing. On a
 * studio that almost never happens. On a tag it is the normal case — and even
 * where it does fit, "8% of Blowjob" is a number about StashDB rather than
 * about this library. So the page is told, and hides the bar for those.
 */
const HONEST_PCT = COVERAGE_CAP;

export function coverageSnapshot(config) {
  const rows = tracked(config).map((entry) => {
    const hit = measured.get(keyOf(entry));
    const row = hit
      ? { ...hit.row, measuredAt: hit.at, pending: false }
      : { ...entry, total: null, have: null, pct: null, pending: true };

    /*
     * Whether the percentage on this row is worth drawing. Not a property of
     * the kind: a narrow tag measured whole is as honest as a studio, and it
     * is the size that decides, not the word.
     */
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
   * Also anything with a count but nothing in memory to count it from, which
   * is every catalogue straight after a restart: the rows come off disk and
   * the scenes they were counted from do not. Left like that, the first skip
   * after a restart could not be counted in place — recount() had to mark the
   * lot stale and wait on a re-read, and every rebuild put the page back into
   * that state for up to six hours. So the first look after a restart reads
   * the scenes back in, in the background, behind the counts already on
   * screen.
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
    // Stamped with the config as it is now. measure() counts against the
    // current config too, so a decision or a rule saved during the pass is
    // already in these rows rather than in conflict with them.
    await keepCoverage(await loadConfig());
  })();

  return coverageSnapshot(config);
}

/*
 * One tracked thing, measured. A studio and a performer go through exactly this
 * — the only difference between them is one line of filter, further down.
 *
 * Two halves, kept apart on purpose: gather() is the network and is slow,
 * classify() is the counting and is instant. See recount() for why.
 */
async function measure(config, entry) {
  const got = await gather(config, entry);
  inputs.set(keyOf(entry), got);

  /*
   * Counted against the config as it is *now*, not the one the pass was
   * started with. A pass is two minutes and you are usually working through
   * the queue while it runs; a skip made while this catalogue was being read
   * belongs in its count, and counting it against the config from before
   * the skip is how two loads a minute apart gave two different numbers.
   */
  return classify(await loadConfig(), entry, got);
}

/*
 * The expensive half: what the catalogue *is*, and which of it you hold.
 *
 * Everything here is a fact about StashDB and about the library on disk, and
 * none of it moves when you make a decision — a skip does not change what a
 * studio has released or what Stash has imported. That is the whole reason it
 * is split off from the counting: it is fetched on the six-hour schedule and
 * kept, and a decision is counted against the copy in hand.
 *
 * **A lookup that fails fails the measurement.** These used to fall back to an
 * empty answer — Stash too busy to reply, say, in the middle of a scan — and
 * an empty answer to "which of these do you own" is "none of them". That row
 * went on the wall at 0%, was written to disk and stayed for six hours. Now it
 * throws, the pass logs it, and the row it would have replaced stays where it
 * was. A number that is a few hours old is a number; one built on a timeout
 * is a lie.
 *
 * Whisparr is the exception, and deliberately: it only decides `onTheWay`,
 * which is a footnote on a card rather than part of the percentage.
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
 * The cheap half: sorting a catalogue into piles against what you have
 * decided. Pure — no network, nothing awaited — so it can be run again the
 * moment a decision is made, and gives the same answer every time it is given
 * the same decisions.
 *
 * **The denominator is what you decided you want, not what StashDB has.** A
 * studio's catalogue is a fact about StashDB; the share of it you have is a
 * number you cannot act on and never reaches 100. Against the scenes you own
 * plus the ones you marked, the percentage means "am I up to date", which is a
 * question with an answer and a thing to do about it.
 *
 * So the scenes of the catalogue sort into four piles: ignored (gone from both
 * halves of the fraction), held, wanted-but-missing, and undecided. Undecided
 * is the one that keeps it honest — a catalogue that has released six new
 * scenes says six need a decision rather than silently moving the number.
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
  // Held back by a standing rule. Counted apart from undecided rather than
  // inside it: a card you will never be shown is not one you have to answer
  // for, and a heading that counted them would be the page overstating the job
  // by the exact amount the rules just saved you.
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

/*
 * A network is its parent studio: tracking "Vixen Media Group" as a network
 * measures every site under it, which is the question a network-level card is
 * actually asking. StashDB takes the parent's UUID here, not its name.
 */
function filterFor(entry) {
  if (entry.kind === 'performer') return stashdb.sceneQuery({ performers: [entry.id] });
  if (entry.kind === 'tag') return stashdb.sceneQuery({ tags: [entry.id] });
  if (entry.scope === 'network') return stashdb.sceneQuery({ parentStudio: entry.id });
  return stashdb.sceneQuery({ studios: [entry.id] });
}
