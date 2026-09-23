/*
 * Match and sort — the two jobs a library this size always has waiting.
 *
 * Measured on 2026-09-03: 2400 scenes, of which **152 carry no stash-box id at
 * all**. Both piles here are fixable, both are dull, and both currently mean
 * leaving this portal for Stash's own interface. That is the whole reason this
 * page exists.
 *
 *   match — a scene with no stash id. Find it, attach the ids, and take the
 *           metadata that comes with them.
 *   sort  — a scene Stash has not been told is finished, or has no cover for.
 *
 * **Ids, plural.** The first cut of this only ever wrote StashDB, because that
 * is the box the tracking side counts against. But a scene is on ThePornDB as
 * well, the two boxes disagree about which scenes exist, and a scene carrying
 * both ids is recognised by everything downstream instead of half of it. So a
 * find asks every source at once and an apply writes every id that was picked
 * — StashDB and TPDB in the same press where both had an answer.
 *
 * **Sources, plural.** Stash's own Identify already knows how to ask a
 * stash-box or a scene scraper about a scene it holds, fingerprints included,
 * and re-implementing that per box would be re-implementing it badly. So the
 * boxes and the scrapers are both reached through `scrapeSingleScene`, which is
 * the same call Identify makes, and the only hand-rolled source left is the
 * direct StashDB one that predates this and still labels its own confidence.
 *
 * **What a match writes, and what it deliberately does not.** Attaching an id
 * is safe: it is a fact about which scene this is, and everything downstream —
 * coverage, the disposition, the whole import side — gets more accurate the
 * moment it lands. Rewriting a title you have already corrected by hand is not
 * safe, so every field beyond the ids is opt-in and empty fields are filled in
 * preference to occupied ones.
 *
 * Performers and studios are attached **only when Stash already has one of that
 * name**. Creating them would mean inventing records off the back of a guess,
 * and a wrong guess then has a performer page of its own. What could not be
 * attached is reported rather than silently dropped.
 */

import * as stashdb from './stashdb.mjs';
import { gql } from './stash.mjs';
import * as renamer from './renamer.mjs';
import * as filer from './filer.mjs';
import * as scenethumb from './scenethumb.mjs';

const PAGE = 24;

// How many guesses a box may volunteer when nobody asked it to guess. See the
// fallback in askStash() for why this is not the eight a typed search gets.
const FALLBACK = 4;

/* ------------------------------------------------------------- the queues */

const SCENE = `
  id
  title
  date
  details
  organized
  rating100
  code
  director
  studio { id name }
  performers { id name }
  tags { id name }
  files { path size fingerprints { type value } }
  paths { screenshot }
  stash_ids { endpoint stash_id }
  urls
`;

/*
 * The three piles of work.
 *
 * `unmatched` is the smallest and the most valuable: an id is what lets every
 * other page in here recognise the scene later.
 *
 * **The zero ids.** Some scenes carry a stash_id of "0" — written by a scraper
 * for a site that is not a stash-box at all, so there is no endpoint behind it
 * and nothing downstream can ever look it up. Stash counts those as matched and
 * they vanish out of this pile, which is exactly backwards. So they are pulled
 * back in — unless the scene is already marked organised, which is you saying
 * you have looked at it and it is finished. Organised is the off switch for the
 * nagging, not a claim that the id is real.
 *
 * `nocover` replaced the old no-tags pile. Tags were dull but harmless; a scene
 * with no cover is invisible on every shelf in the portal, and the fix for it
 * is the same find-and-apply as the pile above rather than a batch write.
 */
const FILTERS = {
  nocover: { is_missing: 'cover' },
  unorganized: { organized: false },
};

export const MODES = ['unmatched', 'nocover', 'unorganized'];

/*
 * How the pile is ordered. Stash does all of these itself, so none of it is
 * paged into memory here and sorted after the fact.
 *
 * `path` is the one worth naming: sorting on the full path sorts by folder
 * first and filename second, which is what "grouped by folders" means when the
 * folders are the only grouping a loose scene has.
 */
const SORTS = {
  date: 'date',
  added: 'created_at',
  updated: 'updated_at',
  title: 'title',
  path: 'path',
  size: 'filesize',
  duration: 'duration',
  random: 'random',
};

export const SORT_KEYS = Object.keys(SORTS);

/*
 * Newest in the library first.
 *
 * Not the scene's own date, which was the default and is a different fact: a
 * 2019 scene added this morning is the one you want to see, and sorting by
 * when it was *made* buries it several hundred rows down. These piles are
 * worked from the top as things arrive, so the useful order is the order they
 * arrived in.
 *
 * Named rather than repeated, because the page has to agree with this end
 * about it — the address only carries `sort` when it is *not* the default, so
 * two ends disagreeing would mean a clean address that sorted two ways.
 */
export const SORT_DEFAULT = 'added';

/*
 * The keyword box. It reads the path, which is the filename and every folder
 * above it, because on the scenes in these piles the path is usually the only
 * description there is — a title would have meant somebody had already been
 * here.
 */
const pathTerm = (q) => (q ? { path: { value: String(q), modifier: 'INCLUDES' } } : null);

/*
 * One box, rather than all of them.
 *
 * "No stash id" means no id from anywhere, and that is a smaller and different
 * question from the one that actually gets asked about this library — *what
 * has no ThePornDB id*. On the day this was written those were 302 scenes and
 * 1,615: a scene with a StashDB id and no TPDB id is matched as far as the
 * pile is concerned and invisible in it, while being exactly what somebody
 * filling in TPDB coverage is looking for.
 *
 * Stash answers this itself, keyed on the endpoint string. Verified against
 * the live library: NOT_NULL and IS_NULL for one endpoint sum to the whole
 * library, so it is a clean split rather than a filter that quietly drops the
 * scenes it cannot decide about.
 */
const endpointTerm = (endpoint, have) => (endpoint
  ? { stash_id_endpoint: { endpoint: String(endpoint), stash_id: '', modifier: have ? 'NOT_NULL' : 'IS_NULL' } }
  : null);

/*
 * The other half of the same question, for the sources that have no endpoint.
 *
 * A stash-box files an id under an endpoint; a scraper files the *URL* it
 * scraped from onto the scene, and that is the whole of the trace it leaves —
 * there is no id, so "which scenes has this scraper never touched" cannot be
 * asked of stash_ids at all. It can be asked of the link: 2,921 of this
 * library's scenes carry one and 318 carry none, and the hosts in them are the
 * sites the scrapers came from.
 *
 * `none` is the case worth naming separately: no link of any kind, which is a
 * scene nothing has ever been scraped onto rather than one a particular site
 * is missing from.
 *
 * EXCLUDES rather than a negated INCLUDES, because Stash has it and it is
 * exact — verified against the live library, INCLUDES and EXCLUDES for one
 * host sum to the whole.
 */
const siteTerm = (site, has) => {
  if (!site) return null;
  if (site === 'none') return { url: { value: '', modifier: has ? 'NOT_NULL' : 'IS_NULL' } };
  return { url: { value: String(site), modifier: has ? 'INCLUDES' : 'EXCLUDES' } };
};

/*
 * Scenes set aside, kept out of every pile unless asked for.
 *
 * Excluded rather than deleted, and excluded from all three piles rather than
 * only the one it was pressed on: "no stash-box has it" is a fact about the
 * scene, and it is just as true when you are looking at the no-cover pile.
 */
const asideTerm = (tagId, show) => {
  if (!tagId) return null;
  return { tags: { value: [String(tagId)], modifier: show ? 'INCLUDES' : 'EXCLUDES', depth: 0 } };
};

/*
 * Hiding the ones that are already described.
 *
 * A scene with a title, a studio and a date is a scene somebody has already
 * been to. It may still be missing an id or a cover and so still be in a pile,
 * but it is not where the work is — and on a library this size the described
 * ones are most of what you page past looking for the ones that are not.
 *
 * So this keeps a scene when *any* of the three is missing, which is the
 * negation of having all three. Three branches, and they have to be branches
 * rather than three fields: three fields on one filter is AND, and would ask
 * for scenes missing all three at once.
 */
/*
 * The other side of the same question: everything present.
 *
 * Not a branch, unlike THIN — "has all three" is three conditions ANDed, which
 * is what a Stash filter does with its fields by default, so it merges into
 * whatever else is being asked rather than multiplying it.
 *
 * This is what makes the unorganised pile bulk-clearable. 285 of the 513
 * scenes Stash has not been told are finished already carry a title, a studio
 * and a date — they are finished, nobody has said so, and going through them
 * one at a time to say it is the kind of job this portal exists to stop.
 */
const DESCRIBED = {
  title: { value: '', modifier: 'NOT_NULL' },
  studios: { value: [], modifier: 'NOT_NULL' },
  date: { value: '', modifier: 'NOT_NULL' },
};

const THIN = [
  { title: { value: '', modifier: 'IS_NULL' } },
  { studios: { value: [], modifier: 'IS_NULL' } },
  { date: { value: '', modifier: 'IS_NULL' } },
];

/*
 * A list of alternatives -> one Stash filter.
 *
 * **Stash ORs its `OR` sub-filter against the whole of the filter it sits on,
 * not against a sibling clause.** So `{A, OR: B}` reads as `A OR B`, and there
 * is no way to write `A AND (B OR C)` directly — it has to be distributed into
 * `(A AND B) OR (A AND C)`, with the shared half repeated into every branch.
 *
 * That was already being done by hand for the keyword and the link, in one
 * place, with a comment apologising for it. Two more optional filters that
 * each want their own branches made it a cross product, and a cross product
 * written out by hand is where the wrong scene starts showing up in a pile. So
 * the branches are built as a list and folded here, once.
 */
const anyOf = (branches) => {
  const [first, ...rest] = branches;
  return rest.length ? { ...first, OR: anyOf(rest) } : { ...first };
};

/*
 * Every combination of the alternatives, with the always-true half merged into
 * each. `[[a, b], [c, d]]` and a shared `s` gives four branches: a+c+s, a+d+s,
 * b+c+s, b+d+s.
 */
const spread = (shared, groups) => {
  let out = [{}];
  for (const group of groups) {
    if (!group || !group.length) continue;
    out = out.flatMap((so_far) => group.map((one) => ({ ...so_far, ...one })));
  }
  return out.map((branch) => ({ ...shared, ...branch }));
};

function filterFor(mode, q, {
  zeros = true, endpoint = '', have = false, site = '', hasSite = false,
  asideId = null, aside = false, thin = false, described = false,
} = {}) {
  const path = pathTerm(q);
  const box = endpointTerm(endpoint, have);
  const link = siteTerm(site, hasSite);
  const set = asideTerm(asideId, aside);

  // True of every branch whatever the pile is. `described` belongs here rather
  // than in the groups below because it narrows without branching.
  const shared = { ...(path || {}), ...(link || {}), ...(set || {}), ...(described ? DESCRIBED : {}) };

  // The alternatives each optional filter contributes. An empty list means
  // that filter is not in play and contributes no branching at all.
  const groups = [];
  if (thin) groups.push(THIN);

  const pile = (branches) => anyOf(spread(shared, [branches, ...groups]));

  const base = FILTERS[mode] ? { ...FILTERS[mode] } : null;
  if (base) return pile([{ ...base, ...(box || {}) }]);

  /*
   * On this pile the two cannot both be applied: the pile *is* a
   * stash_id_endpoint criterion, and there is only one of that field to set.
   * So naming a box replaces it, and the meaning goes with it — from "no id
   * at all" to "no id from that box", asked of the whole library rather than
   * of the pile, which would have excluded the answer.
   *
   * The zero-id branch goes too, and has to: a "0" is filed against an empty
   * endpoint, so it is not an id from any box and there is nothing for a
   * per-box question to say about it.
   */
  if (box) return pile([box]);

  const noId = { stash_id_endpoint: { modifier: 'IS_NULL', endpoint: '' } };
  if (!zeros) return pile([noId]);

  /*
   * The zero-id branch: a scraper filed "0" against no endpoint, which is not
   * an id, and nobody has since marked the scene organised. An alternative to
   * having no id at all rather than a narrowing of it.
   */
  const zeroId = {
    stash_id_endpoint: { stash_id: '0', modifier: 'EQUALS', endpoint: '' },
    organized: false,
  };

  return pile([noId, zeroId]);
}

export async function queue(config, { mode = 'unmatched', page = 1, perPage = PAGE, sort = SORT_DEFAULT, dir = 'desc', q = '', endpoint = '', have = false, site = '', hasSite = false, aside = false, thin = false, described = false } = {}) {
  const which = MODES.includes(mode) ? mode : 'unmatched';
  const box = String(endpoint || '');
  const wants = Boolean(have);
  const link = String(site || '');
  const wantsLink = Boolean(hasSite);
  const by = SORTS[sort] ? sort : SORT_DEFAULT;
  const direction = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const p = Math.max(1, Number(page) || 1);
  const n = Math.min(60, Math.max(1, Number(perPage) || PAGE));

  const query = `query($f: SceneFilterType, $p: Int!, $n: Int!) {
       findScenes(scene_filter: $f, filter: {per_page: $n, page: $p, sort: "${SORTS[by]}", direction: ${direction}}) {
         count
         scenes { ${SCENE} }
       }
     }`;

  /*
   * The zero-id branch is the one thing here that asks Stash for something an
   * older schema might not answer. It is worth having and it is not worth the
   * page going blank over, so a refusal falls back to the plain pile and says
   * so rather than throwing.
   */
  let data;
  // Naming a box takes the zero-id branch out of the query entirely, so there
  // is nothing left for Stash to refuse and nothing to report about it.
  let zeros = which === 'unmatched' && !box;

  /*
   * Looked up once per read rather than held: the tag may not exist yet, and
   * the first time somebody sets a scene aside it starts existing. A memo here
   * would mean the first page after that still showing them.
   */
  /*
   * Which set-aside applies here depends on which question the pile is asking.
   * On a per-box pile it is that box's tag: a scene you gave up on for TPDB is
   * still work on the StashDB pile, and hiding it from both would lose it.
   */
  const asideId = await findTag(config, asideTagName(endpoint));
  const showAside = Boolean(aside);

  /*
   * The two are opposites and cannot both be on. Asked for together, the
   * filter would be "missing something and missing nothing" and Stash would
   * correctly answer with an empty list — which reads as a bug rather than as
   * a contradiction, so it is resolved here instead.
   */
  const onlyThin = Boolean(thin) && !described;
  const onlyDescribed = Boolean(described);

  const options = {
    zeros, endpoint: box, have: wants, site: link, hasSite: wantsLink,
    asideId, aside: showAside, thin: onlyThin, described: onlyDescribed,
  };

  try {
    data = await gql(config, query, { f: filterFor(which, q, options), p, n });
  } catch (err) {
    if (!zeros) throw err;
    console.warn('[tpdbarr] Stash would not take the zero-id filter -', err.message);
    zeros = false;
    data = await gql(config, query, { f: filterFor(which, q, { ...options, zeros: false }), p, n });
  }

  return {
    mode: which,
    sort: by,
    dir: direction === 'ASC' ? 'asc' : 'desc',
    q: String(q || ''),
    endpoint: box,
    have: wants,
    site: link,
    hasSite: wantsLink,
    zeros,
    aside: showAside,
    thin: onlyThin,
    described: onlyDescribed,
    // How many are waiting behind the toggle. Zero when nothing has ever been
    // set aside, which is also when the toggle should not appear at all.
    asideCount: asideId ? await asideCount(config, endpoint) : 0,
    /*
     * What "set aside" is called on this pile, so a row can tell whether it is
     * already one without reconstructing the name. The front end knowing the
     * spelling rule is the front end being wrong the first time the rule
     * changes — and scenes carry their tags, so the check is free.
     */
    asideTag: asideTagName(endpoint),
    count: data.findScenes.count,
    page: p,
    perPage: n,
    scenes: (data.findScenes.scenes || []).map(brief),
  };
}

/* ------------------------------------------------------- the missing phash
 *
 * The one number that explains why this page was so hard to use.
 *
 * **Measured 2026-09-12.** Of the 291 scenes with no stash-box id, 232 have no
 * phash — only an oshash. Broken down by folder it is not a scatter, it is a
 * line:
 *
 *   /pc-import        226 scenes    0 with a phash
 *   /organized_scenes  60 scenes   59 with a phash
 *   /Whisparr-v3        5 scenes    0 with a phash
 *
 * An oshash is a hash of the file's bytes, so it only matches somebody holding
 * the byte-identical file. That is not nothing — plenty of pc-import arrived
 * as an untouched download and its oshash is known to StashDB, which is why
 * some of these rows do answer on a fingerprint today. But it is brittle in
 * exactly the way this library breaks it: anything re-encoded through FileFlows,
 * or trimmed, or remuxed, has a different oshash and nothing else to offer.
 *
 * A phash is the frames, and it survives all of that. Every scene without one
 * has a single brittle chance at a certainty and then falls to a keyword
 * guess, and generation has simply never been run over the folder the work
 * lives in.
 *
 * Stash does the generating; this only asks, and only ever for scenes that are
 * missing one. `overwrite` is deliberately not offered — re-hashing files that
 * already have one is hours of somebody's CPU for no new information.
 */

// Just enough to know whether a scene needs one. The full SCENE shape over a
// whole pile is megabytes of description nobody is going to read.
const PRINTS = 'id files { fingerprints { type value } }';

const hasPhash = (scene) =>
  (scene.files?.[0]?.fingerprints || []).some((f) => /phash/i.test(f.type));

/*
 * Which scenes in a pile are missing a phash. Takes the same filters the queue
 * takes, because the question is always asked about the pile you are looking
 * at rather than about the library.
 */
async function needPhash(config, opts = {}) {
  const which = MODES.includes(opts.mode) ? opts.mode : 'unmatched';
  const box = String(opts.endpoint || '');
  const options = {
    zeros: which === 'unmatched' && !box,
    endpoint: box,
    have: Boolean(opts.have),
    site: String(opts.site || ''),
    hasSite: Boolean(opts.hasSite),
    asideId: await findTag(config, asideTagName(opts.endpoint || '')),
    aside: Boolean(opts.aside),
    thin: Boolean(opts.thin) && !opts.described,
    described: Boolean(opts.described),
  };

  const query = `query($f: SceneFilterType) {
       findScenes(scene_filter: $f, filter: {per_page: -1}) { scenes { ${PRINTS} } }
     }`;

  let data;
  try {
    data = await gql(config, query, { f: filterFor(which, opts.q || '', options) });
  } catch (err) {
    if (!options.zeros) throw err;
    data = await gql(config, query, { f: filterFor(which, opts.q || '', { ...options, zeros: false }) });
  }

  const all = data.findScenes?.scenes || [];
  return { all: all.length, ids: all.filter((s) => !hasPhash(s)).map((s) => String(s.id)) };
}

export async function phashPlan(config, opts = {}) {
  const { all, ids } = await needPhash(config, opts);
  return { scenes: all, missing: ids.length, running: await phashRunning(config) };
}

/*
 * Ask Stash to generate them, and hand back the job id so the page can watch.
 *
 * Nothing is waited on here. A few hundred files is minutes of decoding and
 * the browser must not be holding a request open across it — the job id is the
 * whole answer, and the page polls.
 */
export async function generatePhashes(config, opts = {}) {
  const { ids } = await needPhash(config, opts);
  if (!ids.length) return { started: false, scenes: 0, job: null, why: 'Every scene in this pile already has a phash.' };

  const data = await gql(
    config,
    'mutation($i: GenerateMetadataInput!) { metadataGenerate(input: $i) }',
    { i: { phashes: true, sceneIDs: ids, overwrite: false } }
  );

  return { started: true, scenes: ids.length, job: data.metadataGenerate || null, why: '' };
}

/*
 * Everything Stash can make for one scene, in one press.
 *
 * The phash bar above does a pile at a time and only phashes, because that is
 * the thing the match page needs before it can ask a box anything. This is the
 * other shape of the same need: one scene in front of you that has nothing —
 * no cover, no preview to hover, no sprites to scrub — and no reason to make
 * four separate decisions about it.
 *
 * Covers, previews, sprites and the phash, which is the whole set these two
 * pages draw from. `overwrite: false`, so it fills gaps and leaves alone
 * anything Stash already made: pressing this on a scene that only wants a
 * phash costs a phash, not a re-encode of a preview that was already fine.
 *
 * Unlike the frame the portal cuts for itself, this is real: Stash generates
 * it, Stash keeps it, and it shows up on the scene page and the shelves too.
 *
 * Not waited on. Generating a preview is ffmpeg over the whole file and the
 * browser must not hold a request open across it — the job id is the answer and
 * the row polls, the same way the phash bar does.
 */
export async function generateFor(config, sceneId) {
  const id = String(sceneId);

  const running = await phashRunning(config);
  if (running) return { started: false, job: running, why: 'Stash is already generating — this would queue behind it.' };

  const data = await gql(
    config,
    'mutation($i: GenerateMetadataInput!) { metadataGenerate(input: $i) }',
    { i: { covers: true, previews: true, sprites: true, phashes: true, sceneIDs: [id], overwrite: false } }
  );

  // The cut frame was a stand-in for a missing cover. Stash is about to make a
  // real one, and the stand-in must not outlive it.
  scenethumb.forget();

  return { started: true, job: data.metadataGenerate || null, why: '' };
}

export const generateStatus = (config, id) => phashStatus(config, id);

const JOB_OVER = new Set(['FINISHED', 'CANCELLED', 'FAILED']);

/*
 * A generate already in flight, whoever started it. Stash will happily queue a
 * second one behind the first and then decode everything twice, so the page
 * needs to be able to say "it is already running" rather than offering the
 * button again.
 */
async function phashRunning(config) {
  const data = await gql(config, '{ jobQueue { id status description } }').catch(() => null);
  const job = (data?.jobQueue || []).find((j) => /generat/i.test(j.description || '') && !JOB_OVER.has(j.status));
  return job ? { id: String(job.id), status: job.status, description: job.description || '' } : null;
}

export async function phashStatus(config, id) {
  if (!id) return { job: null, running: await phashRunning(config) };

  const data = await gql(
    config,
    'query($id: ID!) { findJob(input: {id: $id}) { id status progress description error } }',
    { id: String(id) }
  ).catch(() => null);

  const job = data?.findJob || null;
  // A job Stash has already forgotten is a job that finished; it only forgets
  // them once they are over.
  if (!job) return { job: { id: String(id), status: 'FINISHED', progress: 1 }, running: null };

  return {
    job: {
      id: String(job.id),
      status: job.status,
      progress: typeof job.progress === 'number' ? job.progress : null,
      description: job.description || '',
      error: job.error || '',
      over: JOB_OVER.has(job.status),
    },
    running: null,
  };
}

/*
 * An id of "0", or an empty one, is not an id. It is left on the record — it is
 * not ours to delete — but it is not counted as a match anywhere in here.
 */
const realId = (s) => s?.stash_id && String(s.stash_id) !== '0';

function brief(scene) {
  const file = scene.files?.[0] || null;
  const prints = file?.fingerprints || [];
  const ids = scene.stash_ids || [];
  const name = readName(file?.path);

  return {
    id: scene.id,
    title: scene.title || '',
    date: scene.date || '',
    details: scene.details || '',
    organized: !!scene.organized,
    studio: scene.studio || null,
    performers: scene.performers || [],
    tags: scene.tags || [],
    path: file?.path || null,
    screenshot: scene.paths?.screenshot || null,
    stashIds: ids.filter(realId),
    deadIds: ids.filter((s) => !realId(s)),
    /*
     * The addresses the scene already carries. A scrape somewhere put them
     * there, and every one of them is a page that knows more about this scene
     * than any search is going to work out.
     */
    urls: (scene.urls || []).filter(Boolean),
    term: scene.title || name.title,
    /*
     * What the filename turned out to be, kept beside the term rather than
     * folded into it. The search needs the parts separately — the performer
     * is a filter and never text — and the row wants to show which shape it
     * read, because a name it read as a DVD is a name StashDB cannot answer.
     */
    name,
    phashes: prints.filter((f) => /phash/i.test(f.type)).map((f) => f.value),
    oshashes: prints.filter((f) => /oshash/i.test(f.type)).map((f) => f.value),
  };
}

/* ------------------------------------------------------------- the sources
 *
 * What there is to ask. Stash already holds both halves of this — the
 * stash-boxes it is configured against and the scene scrapers it has installed
 * — so neither is listed here and neither can drift when the box list changes.
 *
 * Only scrapers that support a FRAGMENT scrape are offered. The others want a
 * URL or a name typed at them, and the whole point of this page is that you are
 * pointing at a scene Stash already holds.
 */
export async function sources(config) {
  const data = await gql(
    config,
    `{
       configuration { general { stashBoxes { endpoint name } } }
       listScrapers(types: [SCENE]) { id name scene { supported_scrapes } }
     }`
  ).catch(() => null);

  const boxes = (data?.configuration?.general?.stashBoxes || [])
    .filter((b) => b.endpoint)
    .map((b) => ({
      key: 'box:' + b.endpoint,
      kind: 'box',
      label: b.name || host(b.endpoint),
      endpoint: b.endpoint,
    }));

  /*
   * Scrapers that can answer *either* question.
   *
   * This used to be FRAGMENT only, on the reasoning that the whole point of
   * this page is that you are pointing at a scene Stash already holds. That
   * quietly excluded 64 sites — Bang among them, which is NAME and URL and no
   * FRAGMENT — and they were invisible here while BangBros, which does support
   * FRAGMENT, sat in the list right next to where Bang should have been.
   *
   * A NAME scraper cannot be asked about a scene id, so it is asked the
   * keyword instead, and what it answers is labelled a guess. That is a worse
   * answer than a fingerprint and a better one than nothing, which is what
   * those 64 were contributing before.
   */
  const scrapers = (data?.listScrapers || [])
    .map((s) => ({ raw: s, can: s.scene?.supported_scrapes || [] }))
    .filter(({ can }) => can.includes('FRAGMENT') || can.includes('NAME'))
    .map(({ raw, can }) => ({
      key: 'scraper:' + raw.id,
      kind: 'scraper',
      label: raw.name || raw.id,
      fragment: can.includes('FRAGMENT'),
      name: can.includes('NAME'),
    }));

  /*
   * The direct StashDB client predates all of this and is kept because it is
   * the only source that labels its own confidence — it knows whether a hit
   * came off a fingerprint or off a title, which `scrapeSingleScene` will not
   * tell you.
   */
  const direct = (await stashdb.available(config).catch(() => false))
    ? [{ key: 'stashdb', kind: 'direct', label: 'StashDB (fingerprint first)' }]
    : [];

  /* ------------------------------------------------- the links it already has
   *
   * Not a search at all, which is why it is first.
   *
   * Every other source here is asked "which scene is this" and answers with a
   * guess or a fingerprint. This one is asked nothing: the scene is already
   * carrying addresses that some earlier scrape put there, and each of them is
   * a page that knows more about this scene than any search is going to work
   * out. Reading them is the cheapest correct answer on the page.
   *
   * It also reaches sites nothing else here can. data18 is the clear case —
   * 228 scenes in this library carry a data18 link, and its scraper is URL-only
   * because data18's robots.txt disallows /search/ and *search=, so it can
   * never appear among the scrapers above. Handed an address it already has, it
   * answers with studio, cast, tags and a cover.
   *
   * Offered whether or not the scene has any. A source that appears and
   * disappears depending on the row is a source you stop looking for, and a
   * scene with no links says so on its band like every other empty answer.
   */
  // Short, because it sits in a line of chips. The band header says the rest —
  // it reports how many links it read.
  const links = [{ key: 'links', kind: 'links', label: 'Its own links' }];

  return { sources: [...links, ...direct, ...boxes, ...scrapers] };
}

const host = (url) => {
  try { return new URL(url).host; } catch { return String(url); }
};

/* ------------------------------------------------------------- the sites
 *
 * Which hosts the library's scene links actually point at.
 *
 * Built from the scenes rather than from the installed scrapers, and the
 * difference matters: there are a hundred and ninety scrapers installed here
 * and a couple of dozen sites in the data. A dropdown of the scrapers would be
 * a wall of names that have never touched anything in this library, and it
 * would still be missing the sites whose links arrived some other way.
 *
 * `www.` is folded away, because a filter is a substring match and
 * "clips4sale.com" catches both spellings — which is what somebody picking
 * "clips4sale.com" means. It is why the counts here can be higher than any one
 * spelling of the host.
 *
 * Cached for a few minutes. It is one query for every scene's urls, it is only
 * a dropdown, and the answer changes about as often as a scrape runs.
 */
const SITES_TTL = 5 * 60 * 1000;
let siteCache = { at: 0, sites: [] };

// A host with one scene behind it is a filter nobody will pick out of a list
// of sixty. Two is the smallest count that describes a pattern rather than an
// accident.
const SITE_FLOOR = 2;
const SITE_MOST = 60;

export async function sites(config) {
  if (siteCache.sites.length && Date.now() - siteCache.at < SITES_TTL) return { sites: siteCache.sites };

  const data = await gql(
    config,
    `{ findScenes(filter: {per_page: -1}) { scenes { urls } } }`
  ).catch(() => null);

  const counts = new Map();
  for (const scene of data?.findScenes?.scenes || []) {
    // One scene counts once per host however many links it has to it.
    const hosts = new Set((scene.urls || []).map((u) => host(u).replace(/^www\./i, '')).filter(Boolean));
    for (const h of hosts) counts.set(h, (counts.get(h) || 0) + 1);
  }

  const found = [...counts.entries()]
    .filter(([, n]) => n >= SITE_FLOOR)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SITE_MOST)
    .map(([value, count]) => ({ value, count }));

  siteCache = { at: Date.now(), sites: found };
  return { sites: found };
}

/* ---------------------------------------------------------- the candidates
 *
 * Every chosen source, asked at once, answers kept apart.
 *
 * They are not merged. Two boxes describing the same scene disagree about the
 * title often enough that a blended row would be a row nobody wrote, and the
 * ids are the reason you are here — you want to see StashDB's answer and
 * TPDB's answer side by side and tick both, not a single row that has quietly
 * chosen one of them for you.
 *
 * Fingerprints are still first within a source: they are the one answer that
 * cannot be a coincidence. A title hit is a guess, comes back labelled one, and
 * a person decides.
 */
export async function candidates(config, sceneId, { sources: wanted = [], term = '' } = {}) {
  const data = await gql(
    config,
    `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`,
    { id: String(sceneId) }
  );
  if (!data.findScene) throw new Error('Stash has no scene with that id.');

  const scene = brief(data.findScene);
  const search = String(term || '').trim() || scene.term;

  const available = (await sources(config)).sources;
  const asked = wanted.length
    ? available.filter((s) => wanted.includes(s.key))
    : available.filter((s) => s.kind !== 'scraper');

  if (!asked.length) return { scene, term: search, results: [] };

  const results = await Promise.all(asked.map((source) => ask(config, source, scene, search, term)));
  return { scene, term: search, results };
}

/*
 * One source, and never a thrown one. A scraper that is broken today is a
 * normal Tuesday and it must not take the other three answers down with it, so
 * a failure comes back as a note on its own band.
 */
async function ask(config, source, scene, search, typed) {
  const shell = { source: source.key, label: source.label, kind: source.kind, endpoint: source.endpoint || null };

  try {
    if (source.kind === 'links') return { ...shell, ...(await askLinks(config, scene)) };
    if (source.kind === 'direct') return { ...shell, ...(await askStashdb(config, scene, search, typed)) };
    return { ...shell, ...(await askStash(config, source, scene, search, typed)) };
  } catch (err) {
    return { ...shell, via: null, matches: [], note: err.message };
  }
}

const SCRAPED = `
  title code details director urls date image remote_site_id
  studio { stored_id name remote_site_id }
  tags { stored_id name }
  performers { stored_id name gender remote_site_id }
`;

/*
 * A stash-box or a scraper, through the same call Stash's own Identify makes.
 *
 * With a scene id the source gets the fingerprints and does the matching; with
 * a typed keyword it is a name search instead, which is the escape hatch for
 * the scenes whose fingerprints nobody has ever seen. A scraper only ever gets
 * the scene — none of them search by name off a fragment.
 */
/*
 * Read every address this scene already carries.
 *
 * `scrapeSceneURL` routes by host, so this needs no source list and no
 * matching: whichever scraper claims the address answers, and one that nothing
 * claims comes back empty rather than throwing.
 *
 * **Every hit is exact by construction.** The other bands are confident about
 * a scene they found; this one is confident about a scene it was told. Nobody
 * guessed — the address was filed against this record before you got here — so
 * the confidence is not a judgement this module is making.
 *
 * Two links at two different sites are two answers worth reading and both are
 * kept. Two links that answer with the *same* record are not — a scene
 * carrying two timestamp.trade addresses produced the identical row twice, and
 * a duplicate you have to read to discover is a duplicate is worse than no
 * second opinion at all.
 */
async function askLinks(config, scene) {
  const urls = (scene.urls || []).filter((u) => /^https?:\/\//i.test(String(u || '')));
  if (!urls.length) return { via: null, matches: [], note: 'this scene has no links' };

  /*
   * In parallel: these are a handful of addresses at a handful of different
   * hosts, which is the opposite of the match page's Search All — that one is a
   * hundred and forty calls at one endpoint and gets you rate-limited.
   */
  const read = await Promise.all(urls.map(async (url) => {
    try {
      const data = await gql(
        config,
        `query($u: String!) { scrapeSceneURL(url: $u) { ${SCRAPED} } }`,
        { u: url }
      );
      return { url, raw: data.scrapeSceneURL || null, why: null };
    } catch (err) {
      return { url, raw: null, why: err.message };
    }
  }));

  const matches = [];
  const quiet = [];
  // What each answer actually said, so the second copy of it can be dropped.
  const already = new Set();

  for (const { url, raw, why } of read) {
    if (!raw) { quiet.push(`${host(url)}: ${why || 'nothing came back'}`); continue; }

    const shaped = shape(raw, { key: 'links', label: host(url) }, scene, false);

    /*
     * The host is part of the signature on purpose. Two sites agreeing is worth
     * seeing — it is the closest thing to corroboration this page offers — and
     * only the same site saying the same thing twice is noise.
     */
    const said = [
      host(url),
      shaped.title,
      shaped.date,
      shaped.studioName,
      shaped.performers.map((p) => p.name).sort().join(','),
    ].join('|');

    if (already.has(said)) continue;
    already.add(said);
    matches.push({
      ...shaped,
      // Keyed by the address rather than by a remote id, because two of these
      // can be the same site with no id at all and one key would hide one.
      key: `links|${url}`,
      sourceLabel: host(url),
      url,
      /*
       * Not a guess. Whoever filed this address said it was this scene, and
       * reading it does not make that more or less true.
       */
      confidence: 'exact',
    });
  }

  return {
    via: `${urls.length} link${urls.length === 1 ? '' : 's'} on the scene`,
    matches,
    note: matches.length ? (quiet.join(' · ') || '') : (quiet.join(' · ') || 'nothing could be read'),
  };
}

/* ------------------------------------------------------ reading one page
 *
 * A search result is thin; the page behind it is not.
 *
 * Measured on this library: Bang's NAME search returns a title, a date and a
 * cover, and `studio: null`, no performers, no tags. Its *page*, at the address
 * that same result handed over, has two performers and nine tags. So every Bang
 * candidate filed from this page was dropping a cast and nine tags that were
 * one fetch away — and Bang is only the clearest case, because the same is true
 * of every NAME scraper here.
 *
 * **A press, not a step in the find.** Reading every candidate's page would be
 * eight fetches for a band you are going to glance at and discard, and it would
 * be this portal following links it found inside somebody else's answer, which
 * is the thing wildcard.mjs refuses to do on its own. Wild Card's own "Read its
 * page" is the same shape and the same reasoning: the rule is about following
 * links automatically, and a press is a person deciding.
 *
 * Returns the shaped candidate, with the key it already had — the row merges
 * this over what it is holding rather than replacing the row, so a tick made
 * before the read survives it.
 */
export async function readPage(config, sceneId, url, key = null) {
  const address = String(url || '').trim();
  if (!/^https?:\/\//i.test(address)) throw new Error('That is not an http address.');

  const data = await gql(
    config,
    `query($u: String!) { scrapeSceneURL(url: $u) { ${SCRAPED} } }`,
    { u: address }
  );

  if (!data.scrapeSceneURL) throw new Error('Nothing could be read from that page.');

  const current = await gql(
    config,
    `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`,
    { id: String(sceneId) }
  );
  if (!current.findScene) throw new Error('Stash has no scene with that id.');

  const shaped = shape(
    data.scrapeSceneURL,
    { key: 'page', label: host(address) },
    brief(current.findScene),
    false
  );

  return {
    match: {
      ...shaped,
      // The row's identity is not up for renegotiation by a page read.
      key: key || shaped.key,
      url: address,
    },
  };
}

async function askStash(config, source, scene, search, typed) {
  const box = source.kind === 'box';
  const spec = box
    ? { stash_box_endpoint: source.endpoint }
    : { scraper_id: source.key.slice('scraper:'.length) };

  const ask = async (input) => {
    const data = await gql(
      config,
      `query($s: ScraperSourceInput!, $i: ScrapeSingleSceneInput!) {
         scrapeSingleScene(source: $s, input: $i) { ${SCRAPED} }
       }`,
      { s: spec, i: input }
    );
    return data.scrapeSingleScene || [];
  };

  // A typed keyword means you have already decided the fingerprints are no use.
  if (String(typed || '').trim() && (box || source.name)) {
    const raw = await ask({ query: search });
    return { via: 'keyword', matches: raw.slice(0, 8).map((m) => shape(m, source, scene, true)) };
  }

  /*
   * A scraper that cannot do a FRAGMENT scrape has no way to be asked about a
   * scene id — asking anyway is a GraphQL error rather than an empty answer,
   * and an error here would take the row's other five sources down with it. So
   * it gets the keyword, and says so.
   */
  if (!box && !source.fragment) {
    if (!search) return { via: null, matches: [], note: 'searches by name, and there is no name to search on' };
    const named = await ask({ query: search });
    return {
      via: 'keyword — this one cannot be asked about fingerprints',
      matches: named.slice(0, FALLBACK).map((m) => shape(m, source, scene, true)),
    };
  }

  const raw = await ask({ scene_id: String(scene.id) });

  /*
   * **A box asked with a scene id matches on fingerprints and nothing else.**
   * Measured 2026-09-10 and worth writing down, because the label here used to
   * claim "fingerprint or title" and that was simply false: scene 3227 asked by
   * id returned nothing, and the *identical* generated title passed as a query
   * returned eight. A whole Search All over this pile came back 24 empty rows
   * for that reason alone.
   *
   * So a box that knows nothing about these frames is asked the other question
   * before we give up on it. It is a guess and it is labelled one — the same
   * standard the direct StashDB source has always held itself to, which is why
   * that one was the only source ever finding anything here.
   */
  if ((box || source.name) && !raw.length && search) {
    const second = await ask({ query: search }).catch(() => []);
    if (second.length) {
      return {
        via: 'keyword, after no fingerprint',
        // Four, not the eight a typed search gets. StashDB's keyword search
        // matches the words separately, so a fallback on "Panty World #9 -
        // Scene 1" offers Panty Fucking #1, Freeuse World and Gunner World —
        // ranked, so the real one is at the top if it is there at all, and
        // everything past about the fourth is the search running out of ideas.
        // Nobody asked for these; a row that volunteers eight wrong answers is
        // worse than one that volunteers two.
        matches: second.slice(0, FALLBACK).map((m) => shape(m, source, scene, true)),
      };
    }
  }

  return {
    via: box ? 'fingerprint' : 'scraper',
    matches: raw.slice(0, 8).map((m) => shape(m, source, scene, false)),
  };
}

/*
 * Whatever a source hands back, in the one shape the page draws and the one
 * shape apply reads. Everything is a string or a list of strings by the time it
 * leaves here, because the next thing that touches it is a POST body coming
 * back from a browser.
 */
/* ------------------------------------------------------------------- dates
 *
 * Stash takes one date format and scrapers write whatever the site printed.
 *
 * Bang's scraper hands back "Feb 4, 2005", Stash's Go parser tries it as a
 * year and refuses the whole write — which means the ids and the cast and the
 * cover are all lost to a date nobody looked at. So every date is read into
 * YYYY-MM-DD here, at the edge where the answer arrives, and one that cannot
 * be read is dropped rather than posted for Stash to choke on.
 *
 * The shapes are the ones that actually turn up. Nothing ambiguous is guessed
 * at: `04/02/2005` is February in half the world and April in the other half,
 * and a scene filed under the wrong date is worse than one filed under none —
 * a missing date is visible and a plausible wrong one is not.
 */
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const ymd = (y, m, d) => {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!(year >= 1900 && year <= 2100)) return '';
  if (!(month >= 1 && month <= 12)) return '';
  if (!(day >= 1 && day <= 31)) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export function asDate(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';

  // 2005-02-04, and the same with a time or a slash in it.
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/);
  if (iso) return ymd(iso[1], iso[2], iso[3]);

  // 20050204, which a couple of sites still use as an id and a date at once.
  const packed = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (packed) return ymd(packed[1], packed[2], packed[3]);

  const month = (word) => MONTHS[String(word).slice(0, 3).toLowerCase()] || 0;

  // Feb 4, 2005 / February 4 2005 / Feb. 4th, 2005
  const named = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (named) return ymd(named[3], month(named[1]), named[2]);

  // 4 February 2005, which is the same answer written the other way round.
  const leading = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (leading) return ymd(leading[3], month(leading[2]), leading[1]);

  return '';
}

function shape(raw, source, scene, guessed) {
  const remoteId = raw.remote_site_id || null;

  return {
    key: `${source.key}|${remoteId || raw.title || Math.random().toString(36).slice(2)}`,
    source: source.key,
    sourceLabel: source.label,
    endpoint: source.kind === 'box' ? source.endpoint : null,
    remoteId,
    title: raw.title || '',
    date: asDate(raw.date),
    // What the source said, kept so a date this could not read can be shown as
    // the thing it was rather than as an absence.
    rawDate: String(raw.date || '').trim(),
    details: raw.details || '',
    director: raw.director || '',
    code: raw.code || '',
    studioName: raw.studio?.name || '',
    // The source's own ids and genders, carried through the pick so a studio or
    // a performer Stash has never had can be made with its id already on it.
    studioRemoteId: raw.studio?.remote_site_id || null,
    performers: (raw.performers || [])
      .map((p) => ({ name: p.name, gender: p.gender || null, remoteId: p.remote_site_id || null }))
      .filter((p) => p.name),
    tags: (raw.tags || []).map((t) => t.name).filter(Boolean),
    image: raw.image || null,
    url: (raw.urls || [])[0] || null,
    confidence: confidence(raw, scene, guessed),
  };
}

/*
 * How much to trust it, said out loud on the row.
 *
 * A box asked with a scene id matched on fingerprints or it matched on the
 * title, and Stash will not say which — so the date stays the tie-break it
 * always was, and a keyword search is never called anything better than
 * possible.
 */
function confidence(raw, scene, guessed) {
  if (guessed) return 'possible';
  if (raw.date && scene.date && raw.date === scene.date) return 'probable';
  return raw.remote_site_id ? 'likely' : 'possible';
}

// The direct client, kept for the one thing the scrape call cannot say: whether
// this came off a fingerprint.
async function askStashdb(config, scene, search, typed) {
  if (!(await stashdb.available(config))) return { via: null, matches: [], note: 'StashDB is not connected.' };
  const endpoint = await stashdb.endpointFor(config);

  const as = (m, conf) => ({
    key: 'stashdb|' + m.id,
    source: 'stashdb',
    sourceLabel: 'StashDB',
    endpoint,
    remoteId: m.id,
    title: m.title || '',
    date: asDate(m.date),
    rawDate: String(m.date || '').trim(),
    details: m.details || '',
    studioName: m.studio?.name || m.studioName || '',
    studioRemoteId: m.studio?.id || null,
    performers: (m.performers || [])
      .map((p) => ({ name: p.name, gender: p.gender || null, remoteId: p.id || null }))
      .filter((p) => p.name),
    tags: (m.tags || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean),
    image: m.image || null,
    url: m.url || null,
    confidence: conf,
  });

  if (!typed) {
    const exact = await stashdb
      .findByFingerprints(config, { phashes: scene.phashes, oshashes: scene.oshashes })
      .catch(() => null);
    if (exact) return { via: 'fingerprint', matches: [as(exact, 'exact')] };
  }

  // Nothing to search on. Said plainly rather than returning an empty list that
  // looks like "StashDB has never heard of this".
  if (!search) return { via: null, matches: [], note: 'no title and no usable filename to search on' };

  const found = typed
    ? []
    : await stashdb.findByTitle(config, { title: search, date: scene.date || null }).catch(() => []);

  if (found.length) {
    return {
      via: 'title + date',
      matches: found.slice(0, 8).map((m) => as(m, m.date && scene.date && m.date === scene.date ? 'probable' : 'possible')),
    };
  }

  const { via, count, scenes } = await ladder(config, scene, search, typed);

  return {
    via,
    count,
    matches: scenes.slice(0, 8).map((m) => as(m, m.date && scene.date && m.date === scene.date ? 'probable' : 'possible')),
    note: scenes.length ? '' : `nothing for “${search}”`,
  };
}

/*
 * The keyword search, in the order the answers are worth having.
 *
 * There are two ways this used to fail and they look nothing alike from the
 * outside. A `Performer - Title` name searched whole returns **nought**, every
 * time, because StashDB ANDs the words and the performer is not in the scene
 * text. A name that is just a performer, or just a common phrase, returns
 * **everything** — "Blair Williams" is 65 scenes, "Tell Her" is 106 — and eight
 * arbitrary ones off the top of that is not an answer, it is a shrug.
 *
 * So the rungs go from the narrowest question to the widest, and the first one
 * that answers wins:
 *
 *   1. the title, filtered to the performer the filename named
 *   2. the title on its own
 *   3. the performer's scenes, ranked against the title
 *
 * Rung 1 is the one worth having and it is the one that was missing: the
 * performer goes in as a *filter*, which narrows, rather than as words, which
 * annihilates. Rung 3 only runs when the title found nothing, which on this
 * library means the title is a DVD name StashDB has never indexed as a scene.
 *
 * The count is carried back whatever happens, because "1,200 hits" is a useful
 * thing for a row to say and eight of them are not.
 */
const TOO_MANY = 40;

async function ladder(config, scene, search, typed) {
  /*
   * Whenever the filename named one, typed keyword or not. Retyping the title
   * is a correction to *what* is being searched for; it is not a statement
   * that the performer on the front of the filename was wrong, and dropping
   * the filter on a typed search would quietly widen the very search you had
   * just narrowed by hand.
   */
  const named = scene.name?.performer || '';
  const who = named ? await performerId(config, named) : null;

  if (who) {
    const { count, scenes } = await stashdb
      .queryScenes(config, stashdb.sceneQuery({ text: search, performers: [who.id], perPage: 8 }))
      .catch(() => ({ count: 0, scenes: [] }));
    if (scenes.length) return { via: `title, filtered to ${who.name}`, count, scenes };
  }

  const plain = await stashdb.searchScenes(config, search, { perPage: 8 }).catch(() => ({ count: 0, scenes: [] }));
  if (plain.scenes.length) {
    const vague = plain.count > TOO_MANY;
    return {
      via: vague ? `title — ${plain.count.toLocaleString()} hits, too vague to trust` : 'title',
      count: plain.count,
      scenes: plain.scenes,
    };
  }

  /*
   * Nothing for the title at all, which on pc-import usually means the title
   * is a film rather than a scene. If the name gave us a performer, their
   * catalogue is a short enough list to look through by eye — and the picture
   * pass upstairs is rather good at picking one out of eight.
   */
  if (who) {
    const { count, scenes } = await stashdb
      .queryScenes(config, stashdb.sceneQuery({ performers: [who.id], perPage: 8, sort: 'DATE' }))
      .catch(() => ({ count: 0, scenes: [] }));
    if (scenes.length) {
      return { via: `the performer only — nothing matched the title, so these are ${who.name}’s scenes`, count, scenes };
    }
  }

  return { via: 'title', count: 0, scenes: [] };
}

/*
 * A name off a filename -> a StashDB performer, or nothing.
 *
 * Only an exact name match counts. `searchPerformers` is a fuzzy search and
 * will happily offer somebody with a similar name, which as a *filter* would
 * quietly hide the right answer rather than showing a wrong one — the worst
 * failure this page has, because it looks like the scene is simply not there.
 *
 * Held for the life of the process. A performer's id does not change and a
 * Search All over a folder asks about the same two or three names all the way
 * down it.
 */
const performerMemo = new Map();
const flatten = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function performerId(config, name) {
  const key = flatten(name);
  if (!key) return null;
  if (performerMemo.has(key)) return performerMemo.get(key);

  const found = await stashdb.searchPerformers(config, name, { limit: 5 }).catch(() => []);
  const hit = found.find((p) => flatten(p.name) === key) || null;
  performerMemo.set(key, hit);
  return hit;
}

/* ------------------------------------------------------ reading the name
 *
 * A filename is often the only description a stray scene has, and the *shape*
 * it arrives in decides what can usefully be asked of it. Feeding the whole
 * basename to a text search — which is what this did until 2026-09-12 — was
 * costing us an entire folder.
 *
 * **Measured against StashDB on 2026-09-12:**
 *
 *   "Blair Williams Turn The Page"                     0 hits
 *   "Turn The Page"                                    6
 *   "Blair Williams The Masseuse 11 Private Sessions"  0
 *   "The Masseuse 11"                                  1
 *   "Blair Williams"                                  65
 *
 * StashDB ANDs every word against the scene text and a performer's name is not
 * reliably part of that text, so a `Performer - Title` name searches for a
 * string that cannot exist. Nought hits, every time, on all fifty-two of them.
 * The performer has to come out of the text and go back in as a filter, and
 * that is what the split is for.
 *
 * **And most of pc-import is not a scene name at all.** Of 226 files: 76 end
 * in a scene number, 52 use the ` - ` separator, and the rest are titles like
 * "Barely Legal 117". These are DVD rips — the name is the *movie* and the
 * number is which scene of it. StashDB indexes scenes, so it answers 0 for
 * "Oil Overload 15" no matter how the words are arranged; the TPDB movies box
 * and the DVD scrapers answer it immediately. Saying which shape a name is in
 * is how the right source gets asked.
 */

// About the file, not about the scene.
const NOISE = /\b(?:2160p|1080p|720p|480p|360p|4k|uhd|xxx|hevc|x26[45]|h ?26[45]|web-?dl|webrip|hdrip|dvdrip|bdrip|bluray|aac|hd|sd|mp4|mkv|avi|wmv|(?:mega|full|complete)?pack|site-?rip)\b/gi;

// Somebody's search-engine bait, carried along by whatever ripped it.
const JUNK = /\b(?:watch\s+(?:porn\s+)?(?:movie\s+)?online|full\s+(?:movie|video)|free\s+(?:porn|download))\b/gi;

/*
 * One field of a name, in words. Hyphens become spaces *here* rather than up
 * front, because a spaced hyphen is the field separator and a bare one is how
 * half this folder spells its spaces ("nineteen-video-magazine-15").
 */
const words = (text) => String(text || '')
  .replace(/[._-]+/g, ' ')
  .replace(NOISE, ' ')
  .replace(JUNK, ' ')
  // A bracket group with nothing left in it once the file words have gone —
  // "[WEBDL-2160p]" becomes "[ ]" — is punctuation pretending to be content.
  .replace(/[[(<{][^A-Za-z0-9]*[\])>}]/g, ' ')
  .replace(/[[\]()<>{}]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// "Scene 4", "sc.4", "part 2", "cd1" — which scene of the film, not its name.
const SCENE_TAIL = /\s*\b(?:scenes?|sc|parts?|pt|discs?|cd)\s*[.#]?\s*(\d{1,2})(?:\s+(?:19|20)\d{2})?\s*$/i;

// A title ending in a bare number is a series entry: "Barely Legal 63",
// "Oil Overload 15". The number is not noise and is never stripped — it is the
// only thing telling the fifteenth from the fifth.
const SERIES_TAIL = /\s\d{1,3}$/;

/*
 * -> { whole, title, performer, studio, date, sceneNo, shape }
 *
 * `title` is the only part that should ever reach a text search. Everything
 * else is a filter, a corroboration, or a note for the person reading the row.
 */
export function readName(path) {
  const blank = { whole: '', title: '', performer: '', studio: '', date: '', sceneNo: null, shape: 'none' };
  if (!path) return blank;

  const base = String(path).split(/[\/]/).pop() || '';
  const stem = base
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    // A resolution left sitting where an extension used to be, which is how
    // "…-scene-1.480p.mp4" arrives once the real extension has gone.
    .replace(/\.(?:4k|\d{3,4}p)$/i, '');

  if (!stem.trim()) return blank;

  /*
   * A leading track number is an index, not part of the name. "01. Abigaile
   * Johnson - …" is one of a numbered set and the number belongs to the set;
   * left on, it becomes the first word of the performer and no exact-name
   * lookup will ever match it.
   */
  const indexed = stem.replace(/^\s*\d{1,3}\s*[.)_-]\s+/, '');
  const whole = words(indexed);

  /*
   * Whisparr writes Studio.YYYY-MM-DD.Title and all three parts earn their
   * keep: the studio narrows, the date corroborates, and only the title should
   * be searched on.
   */
  const dated = indexed.match(/^(.+?)\.(\d{4}-\d{2}-\d{2})\.(.+)$/);
  if (dated) {
    const [title, sceneNo] = splitSceneNo(words(dated[3]));
    return { whole, title, performer: '', studio: words(dated[1]), date: dated[2], sceneNo, shape: 'studio-date-title' };
  }

  /*
   * The same shape with the studio missing: "2011-05-17.Abigaile.mkv".
   *
   * This is RenameRelocate's output when it matched a scene but could not name
   * a studio for it, and there are a lot of them — it went through pc-import on
   * 2026-09-12 and turned "25. Abigaile Johnson - Wet And Puffy" into this.
   * Read as a plain title it searches for "2011 05 17 Abigaile", where the date
   * is three words of noise ANDed against the scene text and the answer is
   * always nought. The date is worth having and it is worth having *as a date*.
   */
  const leadDate = indexed.match(/^(\d{4}-\d{2}-\d{2})[.\s]+(.+)$/);
  if (leadDate) {
    const [title, sceneNo] = splitSceneNo(words(leadDate[2]));
    return { whole, title, performer: '', studio: '', date: leadDate[1], sceneNo, shape: 'date-title' };
  }

  /*
   * A pack marker with an underscore after it is a field boundary, not a word.
   * "Dolly Leigh h265 MegaPACK_Throated - Sloppy Dolly" is three things — who,
   * which site, which scene — and read as one string it is another guaranteed
   * nought. Only after a pack word, though: an underscore anywhere else is how
   * plenty of files spell a space, and promoting all of them to separators
   * would start truncating ordinary titles.
   */
  const marked = indexed.replace(/\s*\b(?:mega|full|complete)?pack\s*_\s*/gi, ' - ');

  /*
   * " - " with spaces around it. A bare hyphen will not do — "web-dl" and
   * "Anne-Marie" are each one word — and the spaced form is what pc-import
   * uses on all fifty-two of the files that have a performer in the name.
   */
  const fields = marked.split(/\s+[-–—]\s+/).map(words).filter(Boolean);
  if (!fields.length) return { ...blank, whole };

  // The scene number rides on the last field, whichever field that is.
  const [lastTitle, sceneNo] = splitSceneNo(fields[fields.length - 1]);
  const kept = [...fields.slice(0, -1), lastTitle].filter(Boolean);

  if (kept.length > 1) {
    const [performer, ...rest] = kept;

    /*
     * Three fields or more, and the middle one a single word: that is a site
     * name — "Throated", "TouchMyWife", "TeensLoveHugeCocks" — and it belongs
     * with the studio rather than glued onto the front of the title, where it
     * would AND itself against the scene text and take the count to nought
     * exactly the way the performer used to.
     */
    const site = rest.length > 1 && !/\s/.test(rest[0]) ? rest.shift() : '';
    return { whole, title: rest.join(' '), performer, studio: site, date: '', sceneNo, shape: 'performer-title' };
  }

  const title = kept[0] || '';
  const shape = sceneNo || SERIES_TAIL.test(title) ? 'movie-scene' : 'title';
  return { whole, title, performer: '', studio: '', date: '', sceneNo, shape };
}

const splitSceneNo = (text) => {
  const hit = String(text || '').match(SCENE_TAIL);
  if (!hit) return [String(text || '').trim(), null];
  const rest = text.slice(0, hit.index).trim();
  // "Scene 4" and nothing else is not a scene number, it is the whole name.
  return rest ? [rest, Number(hit[1])] : [String(text).trim(), null];
};

/* ------------------------------------------------------ setting one aside
 *
 * The pile that could never reach zero.
 *
 * "No stash id" is a pile of work on the assumption that every scene has an
 * answer waiting somewhere. Plenty do not. An obscure DVD rip, a scene from a
 * site that folded, something amateur — StashDB has never heard of it and
 * never will, and no amount of matching is going to change that. Those sat in
 * the pile permanently, and a pile with a permanent floor is one you stop
 * reading, which costs you the scenes underneath that *do* have an answer.
 *
 * So a scene can be set aside: you have looked, it is not on any box, and it
 * should stop being offered as work.
 *
 * **A tag, not `organized`.** Organised is you saying a scene is finished, and
 * these two are genuinely different facts — a scene can be catalogued to your
 * satisfaction and still want an id, and one that will never have an id may be
 * nowhere near finished. Overloading organised would have made both of them
 * unreadable. A tag also lives in Stash rather than in here, is visible on the
 * scene, and comes off with one press.
 *
 * **And it is never deletion.** The scenes are excluded from the pile, counted
 * where the pile is counted, and one toggle on the panel brings them back.
 * A completionist needs to be able to re-read the ones they gave up on; that
 * is rather the point of having given up on them explicitly.
 */

/*
 * The tag's name is the sentence it stands for. It appears on the scene in
 * Stash, where nothing explains it, so it has to explain itself.
 */
export const ASIDE_TAG = 'Not on any stash-box';

/*
 * The same statement, scoped to one box.
 *
 * "Not on any stash-box" is the right sentence on the "No stash id" pile, where
 * the question really was whether *anything* has it. It claims too much on the
 * per-box piles: on "No TPDB id" you have established that TPDB does not have
 * this scene and nothing whatever about StashDB, so filing it under the global
 * tag would hide it from the pile where it still has an answer waiting.
 *
 * So each box pile gets its own tag, named the same way and for the same
 * reason — it shows on the scene in Stash, where nothing explains it, so it has
 * to explain itself.
 */
export const asideTagName = (endpoint) => {
  const where = String(endpoint || '').trim();
  return where ? `Not on ${host(where)}` : ASIDE_TAG;
};

/*
 * Get it, or make it.
 *
 * This is the one place in here that creates a tag, and the exception is
 * narrow enough to be worth stating: everywhere else a name comes from a
 * scraper and creating it would mean inventing a record off a guess. This name
 * is not a guess and is not from anywhere — it is this portal's own
 * bookkeeping, spelled the same way every time, and the alternative was making
 * you create it by hand before the button would work.
 */
const asideMemo = new Map(); // tag name -> id

export async function asideTag(config, endpoint = '') {
  const name = asideTagName(endpoint);
  if (asideMemo.has(name)) return asideMemo.get(name);

  const found = await findTag(config, name);
  if (found) {
    asideMemo.set(name, found);
    return found;
  }

  // The description says which question was actually asked, because the tag
  // outlives the pile it was pressed on.
  const because = endpoint
    ? `Set aside from the portal's match pile: looked for, and ${host(endpoint)} does not have it.`
    : "Set aside from the portal's match pile: looked for, and no stash-box has it.";

  const made = await gql(
    config,
    'mutation($n: String!, $d: String!) { tagCreate(input: {name: $n, description: $d}) { id } }',
    { n: name, d: because }
  );

  const id = made.tagCreate?.id || null;
  if (!id) throw new Error('Stash would not create the set-aside tag.');
  asideMemo.set(name, id);
  return id;
}

/*
 * On or off for one scene.
 *
 * The other tags on the scene are read and written back untouched. Stash's
 * sceneUpdate replaces the tag list rather than adding to it, so anything not
 * carried over here would be silently dropped — which on a scene somebody has
 * spent time tagging is the worst thing this could do.
 */
export async function setAside(config, sceneId, on = true, endpoint = '') {
  const tagId = await asideTag(config, endpoint);

  const data = await gql(
    config,
    'query($id: ID!) { findScene(id: $id) { id tags { id } } }',
    { id: String(sceneId) }
  );
  if (!data.findScene) throw new Error('Stash has no scene with that id.');

  const now = new Set((data.findScene.tags || []).map((t) => String(t.id)));
  if (on) now.add(String(tagId));
  else now.delete(String(tagId));

  await gql(
    config,
    'mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }',
    { input: { id: String(sceneId), tag_ids: [...now] } }
  );

  return { scene: String(sceneId), aside: on, tag: asideTagName(endpoint) };
}

// How many are set aside, for the panel that offers to show them.
export async function asideCount(config, endpoint = '') {
  const tagId = await findTag(config, asideTagName(endpoint));
  if (!tagId) return 0;

  const data = await gql(
    config,
    'query($t: ID!) { findScenes(scene_filter: {tags: {value: [$t], modifier: INCLUDES}}, filter: {per_page: 1}) { count } }',
    { t: tagId }
  ).catch(() => null);

  return data?.findScenes?.count || 0;
}

/* ------------------------------------------------------------- the writing */

const byName = async (config, kind, names) => {
  if (!names.length) return { found: new Map(), missing: [] };

  const query = kind === 'performer'
    ? `query($n: String!) { findPerformers(performer_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { performers { id name } } }`
    : `query($n: String!) { findStudios(studio_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { studios { id name } } }`;

  const found = new Map();
  const missing = [];

  for (const name of names) {
    const data = await gql(config, query, { n: name }).catch(() => null);
    const hit = (kind === 'performer' ? data?.findPerformers?.performers : data?.findStudios?.studios)?.[0];
    if (hit) found.set(name, hit.id);
    else missing.push(name);
  }

  return { found, missing };
};

/*
 * A studio or a performer the match knows about and Stash has never had.
 *
 * Made rather than skipped: a scene filed against a source that plainly names
 * its studio, and then left with no studio because nobody had typed that name
 * into Stash yet, is the match half-done. Made *with the source's own id on
 * it* wherever there is one, so the next thing that asks a stash-box about
 * this studio finds this record instead of making a second one beside it.
 *
 * Performers are the exception, and only the women are made — see the write.
 */
const stashIdFor = (endpoint, remoteId) =>
  (endpoint && remoteId ? [{ endpoint, stash_id: String(remoteId) }] : []);

const make = async (config, kind, input) => {
  const mutation = kind === 'performer'
    ? `mutation($input: PerformerCreateInput!) { performerCreate(input: $input) { id } }`
    : `mutation($input: StudioCreateInput!) { studioCreate(input: $input) { id } }`;

  try {
    const data = await gql(config, mutation, { input });
    const id = (kind === 'performer' ? data?.performerCreate : data?.studioCreate)?.id || null;
    return id ? { id, why: '' } : { id: null, why: 'Stash returned nothing' };
  } catch (err) {
    return { id: null, why: err.message };
  }
};

/*
 * Female, and nothing that needs a judgement call.
 *
 * The sources disagree about how they write it — FEMALE off a stash-box, the
 * odd scraper saying "Female" — so the comparison is normalised. Everything
 * that is not plainly female, including a blank, is left for a person: making
 * a performer record is easy and merging two of them is not.
 */
const isFemale = (gender) =>
  String(gender || '').trim().toUpperCase().replace(/[\s-]+/g, '_') === 'FEMALE';

const genderSaid = (gender) => {
  const text = String(gender || '').trim().toLowerCase().replace(/_/g, ' ');
  return text ? `is ${text}` : 'has no gender on the source';
};

/*
 * Attach what was picked to a Stash scene.
 *
 * `picks` is the candidates that were ticked, in the order they were ticked,
 * and there is deliberately no limit of one. A scene that StashDB and TPDB both
 * recognise should carry both ids, and the press that says "these two are it"
 * is one press — asking twice would mean the second write had to know not to
 * clobber the first one's title.
 *
 * So: every pick with an endpoint contributes an id, and the fields are filled
 * from the picks in order, first non-empty answer winning. Everything beyond
 * the ids is asked for by name in `fields`, and even then an occupied field is
 * left alone unless `overwrite` says otherwise — the most likely reason a title
 * is already there is that somebody typed it.
 *
 * The picks come back from the browser rather than being re-fetched, because a
 * scraper has no id to re-fetch by. Every value is read as a string off a shape
 * this module defined, and nothing is passed through untouched.
 */
/*
 * The one rule the metadata write follows, on its own so the preview can
 * follow it too.
 *
 * A field is taken when it was ticked and the pick has one — and a value Stash
 * already holds wins over it unless you asked to overwrite. That last clause is
 * the whole reason the preview cannot just show the candidate's title: on a
 * scene that already has one, filing does not change it, and a preview that
 * said otherwise would be offering you a rename that is not going to happen.
 */
const resolveField = (value, held, wanted, overwrite) => {
  if (!wanted || !value) return held || '';
  if (held && !overwrite) return held;
  return value;
};

/*
 * The three fields a filename is made of, as they will read once the write has
 * happened. Built out of `resolveField`, which is the same call the write makes
 * for each of them, so the two cannot disagree about the answer.
 *
 * Optimistic about the studio in one place, on purpose: a studio Stash does
 * not have is skipped by the write, so the file would keep the old one. The
 * preview says the new one. It is a preview — the rename itself re-plans from
 * Stash afterwards, and the write reports the name it actually used.
 */
export function nameFieldsAfter(scene, chosen, wants, overwrite = false) {
  const first = (key) => chosen.map((p) => p[key]).find((v) => v && String(v).trim()) || '';

  return {
    title: resolveField(first('title'), scene.title, wants.has('title'), overwrite),
    date: resolveField(first('date'), scene.date, wants.has('date'), overwrite),
    studioName: resolveField(first('studioName'), scene.studio?.name || '', wants.has('studio'), overwrite),
  };
}

/*
 * What the file would be called if these picks were filed.
 *
 * Never writes, and never trusts the browser with a path — the only things
 * that cross are picks and field names, both of which go through `clean` and
 * the same merge rule the write uses.
 */
export async function renamePlan(config, sceneId, { picks = [], fields = [], overwrite = false } = {}) {
  const chosen = (Array.isArray(picks) ? picks : []).map(clean).filter(Boolean);
  const current = await gql(config, `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id: String(sceneId) });
  if (!current.findScene) throw new Error('Stash has no scene with that id.');

  const scene = brief(current.findScene);
  const over = nameFieldsAfter(scene, chosen, new Set(fields), overwrite);
  return renamer.plan(config, sceneId, over);
}

export async function applyMatch(config, sceneId, { picks = [], fields = [], overwrite = false, rename = false } = {}) {
  const chosen = (Array.isArray(picks) ? picks : []).map(clean).filter(Boolean);
  if (!chosen.length) throw new Error('Nothing was picked.');

  // The direct StashDB source names itself rather than an address, so the
  // address is looked up here instead of being trusted from the browser.
  if (chosen.some((p) => p.source === 'stashdb' && !p.endpoint)) {
    const endpoint = await stashdb.endpointFor(config);
    if (!endpoint) throw new Error('StashDB is not available, so there is no endpoint to file the id under.');
    for (const pick of chosen) if (pick.source === 'stashdb' && !pick.endpoint) pick.endpoint = endpoint;
  }

  const current = await gql(config, `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id: String(sceneId) });
  if (!current.findScene) throw new Error('Stash has no scene with that id.');
  const scene = brief(current.findScene);

  const wants = new Set(fields);
  const input = { id: String(sceneId) };
  const skipped = [];
  // Studios and performers this write had to make, said out loud on the row:
  // a write that quietly grows the library is a write you cannot check.
  const created = [];

  /*
   * The ids. Any endpoint being written is replaced; every other stash_id the
   * scene already had is kept, including the dead "0" ones — they are somebody
   * else's record and this page's job is to add the real id beside them, not to
   * tidy up after a scraper.
   */
  const writing = new Set(chosen.map((p) => p.endpoint).filter(Boolean));
  const keep = (current.findScene.stash_ids || []).filter((s) => !writing.has(s.endpoint));
  const fresh = [];

  for (const pick of chosen) {
    if (!pick.endpoint) {
      /*
       * A link the scene already had was never going to file an id — it is a
       * page, not a stash-box — so saying so on every press would be reporting
       * the design as a shortfall. Every other source without an endpoint is
       * worth a word, because there you asked for an id and did not get one.
       */
      if (pick.source !== 'links') {
        skipped.push(`${pick.sourceLabel} has no endpoint, so its id was not filed`);
      }
      continue;
    }
    if (!pick.remoteId) {
      skipped.push(`${pick.sourceLabel} returned no id`);
      continue;
    }
    if (fresh.some((f) => f.endpoint === pick.endpoint)) continue;
    fresh.push({ endpoint: pick.endpoint, stash_id: pick.remoteId });
  }

  input.stash_ids = [
    ...keep.map((s) => ({ endpoint: s.endpoint, stash_id: s.stash_id })),
    ...fresh,
  ];

  // First pick that actually has the thing, which is why the tick order on the
  // page is the order they arrive in.
  const first = (key) => chosen.map((p) => p[key]).find((v) => v && String(v).trim()) || '';

  const take = (key, value, held) => {
    if (!wants.has(key) || !value) return;
    const out = resolveField(value, held, true, overwrite);
    if (out === held) return skipped.push(key);
    input[key] = out;
  };

  take('title', first('title'), scene.title);
  take('date', first('date'), scene.date);

  /*
   * A date the source printed in a shape Stash will not read. Said out loud
   * rather than dropped quietly — "Left alone: date" on a row whose candidate
   * plainly showed one would read as a bug in this page.
   */
  if (wants.has('date') && !first('date')) {
    const printed = chosen.map((p) => p.rawDate).find(Boolean);
    if (printed) skipped.push(`date “${printed}” is not a date Stash can read`);
  }

  take('details', first('details'), scene.details);
  take('code', first('code'), current.findScene.code);
  take('director', first('director'), current.findScene.director);

  /*
   * The cover. This is the whole reason the no-cover pile is on this page: a
   * scene with no image is invisible on every shelf in the portal, and the fix
   * is the picture the match already came with. Stash takes a URL here and
   * fetches it itself.
   */
  if (wants.has('cover')) {
    const image = first('image');
    if (image) input.cover_image = image;
    else skipped.push('none of the picks had a cover');
  }

  if (wants.has('studio')) {
    // The pick the name came from, not just the name: a studio that has to be
    // made is made with that source's id, and the id only means anything
    // alongside that source's endpoint.
    const carrier = chosen.find((p) => p.studioName);
    const name = carrier?.studioName || '';
    if (name) {
      if (scene.studio && !overwrite) skipped.push('studio');
      else {
        const { found } = await byName(config, 'studio', [name]);
        if (found.size) input.studio_id = [...found.values()][0];
        else {
          const born = await make(config, 'studio', {
            name,
            stash_ids: stashIdFor(carrier.endpoint, carrier.studioRemoteId),
          });
          if (born.id) {
            input.studio_id = born.id;
            created.push(`studio “${name}”`);
          } else {
            skipped.push(`studio “${name}” is not in Stash and could not be made: ${born.why}`);
          }
        }
      }
    }
  }

  if (wants.has('performers')) {
    /*
     * One row per name, holding the pick it came from, because a performer
     * that has to be made needs that source's gender and that source's id.
     * First pick to name someone wins, the same rule the fields follow.
     */
    const wanted = new Map();
    for (const pick of chosen) {
      for (const who of pick.performers) {
        if (!wanted.has(who.name)) wanted.set(who.name, { ...who, endpoint: pick.endpoint });
      }
    }

    if (wanted.size) {
      const { found, missing } = await byName(config, 'performer', [...wanted.keys()]);
      const ids = new Set([...scene.performers.map((p) => p.id), ...found.values()]);

      for (const name of missing) {
        const who = wanted.get(name);
        /*
         * Women are made; everyone else is reported and left alone. Not a
         * judgement about the library — it is that a name with no gender on it
         * is the one case where guessing wrong makes a record somebody has to
         * find and merge later, and the source is the only thing that knows.
         */
        if (!isFemale(who.gender)) {
          skipped.push(`performer “${name}” is not in Stash and ${genderSaid(who.gender)}, so none was made`);
          continue;
        }

        const born = await make(config, 'performer', {
          name,
          gender: 'FEMALE',
          stash_ids: stashIdFor(who.endpoint, who.remoteId),
        });

        if (born.id) {
          ids.add(born.id);
          created.push(`performer “${name}”`);
        } else {
          skipped.push(`performer “${name}” is not in Stash and could not be made: ${born.why}`);
        }
      }

      if (ids.size) input.performer_ids = [...ids];
    }
  }

  if (wants.has('tags')) {
    const names = [...new Set(chosen.flatMap((p) => p.tags))];
    if (names.length) {
      const ids = new Set(scene.tags.map((t) => t.id));
      for (const name of names) {
        const hit = await findTag(config, name);
        if (hit) ids.add(hit);
      }
      if (ids.size) input.tag_ids = [...ids];
    }
  }

  /*
   * Marking it organised is opt-in for the same reason everything else here is:
   * organised is you saying you have looked at it, and a page that ticks it on
   * your behalf has taken the one honest signal in the library and made it mean
   * "a robot has been here".
   */
  if (wants.has('organized')) input.organized = true;

  const saved = await gql(
    config,
    `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id title date organized stash_ids { endpoint stash_id } } }`,
    { input }
  );

  /*
   * Marking it organised here moves the file, the same as pressing Mark filed
   * on the library page does. This page is where it is *usually* marked —
   * Match with mode=unorganized is the queue for exactly this — so filing
   * that only happened on the other button was filing that mostly did not
   * happen. See filer.mjs.
   *
   * After the metadata and never before it: the folder and the filename are
   * built out of the studio, date and title that were just written, so filing
   * first would file it under whatever the record said before.
   */
  let filed = null;
  if (wants.has('organized')) {
    filed = await filer.file(config, sceneId)
      .then((out) => ({ ok: true, to: out.to, how: out.how, ms: out.ms, scanned: out.scanned }))
      .catch(async (err) => {
        const plan = await filer.plan(config, sceneId).catch(() => null);
        const why = plan?.why || err.message;
        if (!plan?.already) console.warn(`[tpdbarr] scene ${sceneId} marked organised but not moved - ${why}`);
        return { ok: false, already: Boolean(plan?.already), why };
      });
  }

  /*
   * The rename, after the ids and the metadata and never before them. It
   * re-plans from Stash rather than being handed a name, so the file is named
   * off the record that was just filed. A refusal is reported — the filing
   * happened, and losing that behind an error about a filename would be the
   * worst of both.
   *
   * Skipped when the file has just been filed: filing writes it out as
   * `Studio.date.Title.ext`, which is the name the renamer would have given
   * it, and a second pass would be re-planning against a path Stash has not
   * caught up with yet.
   */
  let renamed = null;
  if (rename && !filed?.ok) {
    renamed = await renamer.rename(config, sceneId)
      .then((out) => ({ ok: true, to: out.to, scanned: out.scanned }))
      .catch((err) => ({ ok: false, why: err.message }));
  }

  return { scene: saved.sceneUpdate, ids: fresh, skipped, created, renamed, filed };
}

// One pick, read as strings off the shape this module defined. Anything else a
// browser might have sent is dropped rather than argued with.
function clean(pick) {
  if (!pick || typeof pick !== 'object') return null;
  const text = (v) => (v == null ? '' : String(v).trim());

  return {
    source: text(pick.source),
    sourceLabel: text(pick.sourceLabel) || text(pick.source) || 'that source',
    endpoint: text(pick.endpoint) || null,
    remoteId: text(pick.remoteId) || null,
    title: text(pick.title),
    // Normalised again here rather than trusted: the browser is handing back
    // a value it was given, but this is the last point before Stash sees it.
    date: asDate(pick.date),
    rawDate: text(pick.rawDate),
    details: text(pick.details),
    code: text(pick.code),
    director: text(pick.director),
    studioName: text(pick.studioName),
    studioRemoteId: text(pick.studioRemoteId) || null,
    image: text(pick.image) || null,
    performers: (Array.isArray(pick.performers) ? pick.performers : [])
      .map((p) => ({ name: text(p?.name), gender: text(p?.gender) || null, remoteId: text(p?.remoteId) || null }))
      .filter((p) => p.name),
    tags: (Array.isArray(pick.tags) ? pick.tags : []).map(text).filter(Boolean),
  };
}

async function findTag(config, name) {
  const data = await gql(
    config,
    `query($n: String!) { findTags(tag_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { tags { id } } }`,
    { n: name }
  ).catch(() => null);
  return data?.findTags?.tags?.[0]?.id || null;
}

/* ------------------------------------------------------------------ tagging
 *
 * Tags Stash already has, never new ones. 985 of them here, and a page that
 * lets you type a new tag into a batch write is a page that grows a second tag
 * called "Anal " with a trailing space.
 */
export async function tags(config, term = '') {
  const data = await gql(
    config,
    `query($f: TagFilterType) {
       findTags(tag_filter: $f, filter: {per_page: 40, sort: "scenes_count", direction: DESC}) {
         count
         tags { id name scene_count }
       }
     }`,
    { f: term ? { name: { value: term, modifier: 'INCLUDES' } } : null }
  );

  return { count: data.findTags.count, tags: data.findTags.tags || [] };
}

/*
 * Add tags to scenes, one or many, and mark them organised. Additive on
 * purpose: the pile this serves is scenes Stash has not been told are
 * finished, and the failure worth designing against is a batch that quietly
 * replaces whatever a scene already had.
 *
 * Organised travels with the tags rather than having a call of its own,
 * because on that pile they are the same press — you tick the scenes that are
 * done, say what they are, and say they are done.
 */
export async function addTags(config, sceneIds, tagIds, { organized = null } = {}) {
  const ids = (Array.isArray(sceneIds) ? sceneIds : []).map(String).filter(Boolean);
  const wanted = (Array.isArray(tagIds) ? tagIds : []).map(String).filter(Boolean);
  if (!ids.length) throw new Error('No scenes given.');
  if (!wanted.length && organized === null) throw new Error('Nothing to save — no tags, and organised was not asked for.');

  let changed = 0;

  for (const id of ids) {
    const data = await gql(config, `query($id: ID!) { findScene(id: $id) { id tags { id } organized } }`, { id });
    const scene = data.findScene;
    if (!scene) continue;

    const input = { id };
    if (wanted.length) input.tag_ids = [...new Set([...scene.tags.map((t) => t.id), ...wanted])];
    if (organized !== null) input.organized = Boolean(organized);

    await gql(config, `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`, { input });
    changed++;
  }

  return { changed };
}
