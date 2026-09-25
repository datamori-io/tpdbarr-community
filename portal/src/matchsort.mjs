/*
 * Match and sort: the two piles of library work.
 *
 *   match — a scene with no stash id. Find it, attach the ids and metadata.
 *   sort  — a scene not marked organised, or with no cover.
 *
 * A find asks every stash-box and scraper at once, through `scrapeSingleScene`
 * (the call Stash's Identify makes), and an apply writes every id picked.
 * Only ids are written by default; every other field is opt-in and fills
 * blanks before overwriting.
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
 * The three piles.
 *
 * Stash counts a stash_id of "0" (left by a non-stash-box scraper) as matched,
 * so those are pulled back in unless the scene is organised.
 */
const FILTERS = {
  nocover: { is_missing: 'cover' },
  unorganized: { organized: false },
};

export const MODES = ['unmatched', 'nocover', 'unorganized'];

/* Stash sorts all of these. `path` sorts by folder, then filename. */
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
 * Newest in the library first, not newest by release date. The address only
 * carries `sort` when it isn't the default, so both ends must agree on this.
 */
export const SORT_DEFAULT = 'added';

/* The keyword box searches the path: on these scenes it's often the only description. */
const pathTerm = (q) => (q ? { path: { value: String(q), modifier: 'INCLUDES' } } : null);

/*
 * One box instead of all: "no TPDB id" rather than "no id at all".
 * Stash's NOT_NULL and IS_NULL for one endpoint split the library cleanly.
 */
const endpointTerm = (endpoint, have) => (endpoint
  ? { stash_id_endpoint: { endpoint: String(endpoint), stash_id: '', modifier: have ? 'NOT_NULL' : 'IS_NULL' } }
  : null);

/*
 * The same question for scrapers, which leave a URL rather than an id.
 * `none` means no link at all. EXCLUDES is exact; it and INCLUDES sum to the library.
 */
const siteTerm = (site, has) => {
  if (!site) return null;
  if (site === 'none') return { url: { value: '', modifier: has ? 'NOT_NULL' : 'IS_NULL' } };
  return { url: { value: String(site), modifier: has ? 'INCLUDES' : 'EXCLUDES' } };
};

/* Scenes set aside are kept out of every pile unless asked for. */
const asideTerm = (tagId, show) => {
  if (!tagId) return null;
  return { tags: { value: [String(tagId)], modifier: show ? 'INCLUDES' : 'EXCLUDES', depth: 0 } };
};

/*
 * Scenes missing any of title, studio or date. Has to be OR branches:
 * three fields on one filter would AND them.
 */
/*
 * Scenes with all three. Plain fields AND, so this merges into the filter.
 * Makes the unorganised pile bulk-clearable.
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
 * Stash ORs `OR` against the whole filter, not a sibling clause, so
 * `A AND (B OR C)` must be written as `(A AND B) OR (A AND C)`.
 */
const anyOf = (branches) => {
  const [first, ...rest] = branches;
  return rest.length ? { ...first, OR: anyOf(rest) } : { ...first };
};

/*
 * Every combination of the alternatives, with `shared` merged into each.
 * `[[a, b], [c, d]]` + `s` -> a+c+s, a+d+s, b+c+s, b+d+s.
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
   * The pile is itself a stash_id_endpoint criterion, so naming a box replaces
   * it: "no id from that box", asked of the whole library. The zero-id branch
   * goes too — a "0" belongs to no box.
   */
  if (box) return pile([box]);

  const noId = { stash_id_endpoint: { modifier: 'IS_NULL', endpoint: '' } };
  if (!zeros) return pile([noId]);

  /* Zero-id branch: a "0" id on a scene not yet organised. */
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

  /* An older Stash may refuse the zero-id branch. Fall back to the plain pile. */
  let data;
  // Naming a box takes the zero-id branch out of the query entirely, so there
  // is nothing left for Stash to refuse and nothing to report about it.
  let zeros = which === 'unmatched' && !box;

  /* Not memoised: the tag may be created by the first set-aside. */
  /* On a per-box pile, only that box's set-aside tag applies. */
  const asideId = await findTag(config, asideTagName(endpoint));
  const showAside = Boolean(aside);

  /* Opposites. Asked for together they'd return nothing, which looks like a bug. */
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
    /* Sent so the front end doesn't need to know the naming rule. */
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

/* Which scenes in the current pile are missing a phash. */
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

/* Starts Stash's generate job and returns the job id; the page polls. */
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
 * Cover, preview, sprites and phash for one scene. `overwrite: false`, so it
 * only fills gaps. Returns the job id; the row polls.
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

/* Stash will queue a second generate and decode everything twice, so check first. */
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

/* An id of "0" or blank is not an id. Left on the record, never counted. */
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
    /* URLs a scrape already put on the scene. */
    urls: (scene.urls || []).filter(Boolean),
    term: scene.title || name.title,
    /* Parsed filename, kept apart: the performer is a filter, not search text. */
    name,
    phashes: prints.filter((f) => /phash/i.test(f.type)).map((f) => f.value),
    oshashes: prints.filter((f) => /oshash/i.test(f.type)).map((f) => f.value),
  };
}

/*
 * ------------------------------------------------------------- the sources
 *
 * What there is to ask, read from Stash: its stash-boxes and installed scrapers.
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
   * Scrapers that support FRAGMENT or NAME. A NAME-only scraper (e.g. Bang) is
   * asked the keyword and its answer is labelled a guess.
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
   * The direct StashDB client is kept because it says whether a hit came off a
   * fingerprint or a title; `scrapeSingleScene` doesn't.
   */
  const direct = (await stashdb.available(config).catch(() => false))
    ? [{ key: 'stashdb', kind: 'direct', label: 'StashDB (fingerprint first)' }]
    : [];

  /*
   * ------------------------------------------------- the links it already has
   *
   * Reads the URLs the scene already carries. Reaches URL-only scrapers like
   * data18. Always offered, even when the scene has none.
   */
  // Short, because it sits in a line of chips. The band header says the rest —
  // it reports how many links it read.
  const links = [{ key: 'links', kind: 'links', label: 'Its own links' }];

  return { sources: [...links, ...direct, ...boxes, ...scrapers] };
}

const host = (url) => {
  try { return new URL(url).host; } catch { return String(url); }
};

/*
 * ------------------------------------------------------------- the sites
 *
 * Hosts the library's scene links point at, for the site filter. `www.` is
 * folded away. Cached a few minutes.
 */
const SITES_TTL = 5 * 60 * 1000;
let siteCache = { at: 0, sites: [] };

// Hosts with only one scene aren't listed.
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

/*
 * ---------------------------------------------------------- the candidates
 *
 * Every chosen source, asked at once. Answers are kept apart, not merged,
 * so you can tick StashDB's and TPDB's side by side.
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

/* One source. A failure comes back as a note on its band, never a throw. */
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
 * A stash-box or scraper, via Identify's call. With a scene id it matches
 * fingerprints; with a typed keyword it's a name search.
 */
/*
 * Read every URL on the scene. `scrapeSceneURL` routes by host.
 * Hits are exact: the URL was filed against this scene. Duplicate answers
 * from the same host are dropped.
 */
async function askLinks(config, scene) {
  const urls = (scene.urls || []).filter((u) => /^https?:\/\//i.test(String(u || '')));
  if (!urls.length) return { via: null, matches: [], note: 'this scene has no links' };

  /* In parallel: a few URLs at different hosts, so no rate-limit risk. */
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

    /* Host is part of the key: two sites agreeing is worth showing. */
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
      /* The URL was filed against this scene, so it isn't a guess. */
      confidence: 'exact',
    });
  }

  return {
    via: `${urls.length} link${urls.length === 1 ? '' : 's'} on the scene`,
    matches,
    note: matches.length ? (quiet.join(' · ') || '') : (quiet.join(' · ') || 'nothing could be read'),
  };
}

/*
 * ------------------------------------------------------ reading one page
 *
 * A search result is thin; the page behind it often has cast and tags.
 * Only fetched on a press, never automatically. The row merges the result,
 * so earlier ticks survive.
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

  /* A non-FRAGMENT scraper errors if asked about a scene id, so it gets the keyword. */
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
   * A box asked by scene id matches on fingerprints only. If that finds
   * nothing, ask the title as a keyword and label it a guess.
   */
  if ((box || source.name) && !raw.length && search) {
    const second = await ask({ query: search }).catch(() => []);
    if (second.length) {
      return {
        via: 'keyword, after no fingerprint',
        // Four, not eight: past the fourth, keyword fallbacks are mostly wrong.
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
 * Whatever a source returns, in the one shape the page draws and apply reads.
 * Everything is a string or list of strings.
 */
/*
 * ------------------------------------------------------------------- dates
 *
 * Scrapers write dates however the site printed them. Stash rejects the
 * whole write on a bad one, so everything is read into YYYY-MM-DD here.
 * Ambiguous forms (04/02/2005) are dropped, not guessed.
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
 * Confidence shown on the row. Stash won't say whether an id lookup matched
 * on fingerprint or title, so the date is the tie-break; keyword hits are
 * never better than "possible".
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
 * The keyword search, narrowest first; first rung that answers wins:
 *
 *   1. the title, filtered to the performer the filename named
 *   2. the title on its own
 *   3. the performer's scenes, ranked against the title
 *
 * StashDB ANDs words, so "Performer - Title" as text returns nothing.
 * The hit count is always returned.
 */
const TOO_MANY = 40;

async function ladder(config, scene, search, typed) {
  /*
   * Keep the performer filter even on a typed search: retyping the title
   * doesn't mean the performer was wrong.
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

  /* No title hits usually means a DVD name. Try the performer's scenes. */
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
 * Filename name -> StashDB performer. Exact match only: a fuzzy match used as a
 * filter would hide the right answer. Memoised for the process.
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

/*
 * ------------------------------------------------------ reading the name
 *
 * Splits a filename into title, performer, studio, date and scene number.
 * Only the title goes to text search; StashDB ANDs words, so a performer
 * name in the text returns nothing. Many pc-import names are DVD
 * "Movie 15" forms, which StashDB can't answer but TPDB movies can.
 */

// About the file, not about the scene.
const NOISE = /\b(?:2160p|1080p|720p|480p|360p|4k|uhd|xxx|hevc|x26[45]|h ?26[45]|web-?dl|webrip|hdrip|dvdrip|bdrip|bluray|aac|hd|sd|mp4|mkv|avi|wmv|(?:mega|full|complete)?pack|site-?rip)\b/gi;

// Somebody's search-engine bait, carried along by whatever ripped it.
const JUNK = /\b(?:watch\s+(?:porn\s+)?(?:movie\s+)?online|full\s+(?:movie|video)|free\s+(?:porn|download))\b/gi;

/*
 * One field, in words. Bare hyphens become spaces here; spaced hyphens are
 * the field separator.
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

// A trailing number is a series entry ("Barely Legal 63"). Never stripped.
const SERIES_TAIL = /\s\d{1,3}$/;

/*
 * -> { whole, title, performer, studio, date, sceneNo, shape }
 * Only `title` should reach a text search.
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

  /* Strip a leading track number ("01. "). */
  const indexed = stem.replace(/^\s*\d{1,3}\s*[.)_-]\s+/, '');
  const whole = words(indexed);

  /* Whisparr's Studio.YYYY-MM-DD.Title. */
  const dated = indexed.match(/^(.+?)\.(\d{4}-\d{2}-\d{2})\.(.+)$/);
  if (dated) {
    const [title, sceneNo] = splitSceneNo(words(dated[3]));
    return { whole, title, performer: '', studio: words(dated[1]), date: dated[2], sceneNo, shape: 'studio-date-title' };
  }

  /* Date.Title with no studio, as RenameRelocate writes it. */
  const leadDate = indexed.match(/^(\d{4}-\d{2}-\d{2})[.\s]+(.+)$/);
  if (leadDate) {
    const [title, sceneNo] = splitSceneNo(words(leadDate[2]));
    return { whole, title, performer: '', studio: '', date: leadDate[1], sceneNo, shape: 'date-title' };
  }

  /*
   * "PACK_" is a field boundary. Only after a pack word; elsewhere an
   * underscore is a space.
   */
  const marked = indexed.replace(/\s*\b(?:mega|full|complete)?pack\s*_\s*/gi, ' - ');

  /* Spaced " - " separates fields. A bare hyphen doesn't ("Anne-Marie"). */
  const fields = marked.split(/\s+[-–—]\s+/).map(words).filter(Boolean);
  if (!fields.length) return { ...blank, whole };

  // The scene number rides on the last field, whichever field that is.
  const [lastTitle, sceneNo] = splitSceneNo(fields[fields.length - 1]);
  const kept = [...fields.slice(0, -1), lastTitle].filter(Boolean);

  if (kept.length > 1) {
    const [performer, ...rest] = kept;

    /* Three or more fields with a one-word middle: that's the site. */
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

/*
 * ------------------------------------------------------ setting one aside
 *
 * Some scenes are on no stash-box and never will be. Setting one aside tags
 * it so it stops being offered as work. A tag, not `organized` — those mean
 * different things. Never a delete; a toggle brings them back.
 */

/* Named as a sentence, because it shows in Stash with no explanation. */
export const ASIDE_TAG = 'Not on any stash-box';

/* Per-box version: a scene TPDB lacks may still be on StashDB. */
export const asideTagName = (endpoint) => {
  const where = String(endpoint || '').trim();
  return where ? `Not on ${host(where)}` : ASIDE_TAG;
};

/*
 * Get or create the tag. The one place here that creates a tag; the name is
 * this portal's own.
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
 * Toggle for one scene. sceneUpdate replaces the tag list, so the existing
 * tags are read and written back.
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
 * A studio or performer the match names that Stash doesn't have: created,
 * with the source's stash id where there is one. Performers: women only.
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
 * Plainly female only. Anything else, including blank, is left for a person —
 * merging two performers is harder than making one.
 */
const isFemale = (gender) =>
  String(gender || '').trim().toUpperCase().replace(/[\s-]+/g, '_') === 'FEMALE';

const genderSaid = (gender) => {
  const text = String(gender || '').trim().toLowerCase().replace(/_/g, ' ');
  return text ? `is ${text}` : 'has no gender on the source';
};

/*
 * Attach the ticked picks to a Stash scene.
 *
 * Every pick with an endpoint adds an id. Fields fill from the picks in
 * order, first non-empty wins, and only fields named in `fields`. An occupied
 * field is kept unless `overwrite`. Picks come from the browser (scrapers have
 * nothing to re-fetch by), and every value is cleaned.
 */
/*
 * The field rule, shared with the preview: take a ticked field the pick has,
 * unless Stash already has one and `overwrite` is off.
 */
const resolveField = (value, held, wanted, overwrite) => {
  if (!wanted || !value) return held || '';
  if (held && !overwrite) return held;
  return value;
};

/*
 * Studio, date and title as they'll read after the write, via `resolveField`.
 * Shows a new studio even if the write will skip it; the rename re-plans afterwards.
 */
export function nameFieldsAfter(scene, chosen, wants, overwrite = false) {
  const first = (key) => chosen.map((p) => p[key]).find((v) => v && String(v).trim()) || '';

  return {
    title: resolveField(first('title'), scene.title, wants.has('title'), overwrite),
    date: resolveField(first('date'), scene.date, wants.has('date'), overwrite),
    studioName: resolveField(first('studioName'), scene.studio?.name || '', wants.has('studio'), overwrite),
  };
}

/* The filename these picks would give. Never writes. */
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

  /* Replace ids for endpoints being written; keep every other stash_id, "0"s included. */
  const writing = new Set(chosen.map((p) => p.endpoint).filter(Boolean));
  const keep = (current.findScene.stash_ids || []).filter((s) => !writing.has(s.endpoint));
  const fresh = [];

  for (const pick of chosen) {
    if (!pick.endpoint) {
      /* Links never file an id, so only other sources are reported. */
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

  /* Say when a date couldn't be read, rather than dropping it silently. */
  if (wants.has('date') && !first('date')) {
    const printed = chosen.map((p) => p.rawDate).find(Boolean);
    if (printed) skipped.push(`date “${printed}” is not a date Stash can read`);
  }

  take('details', first('details'), scene.details);
  take('code', first('code'), current.findScene.code);
  take('director', first('director'), current.findScene.director);

  /* Stash fetches the cover URL itself. */
  if (wants.has('cover')) {
    const image = first('image');
    if (image) input.cover_image = image;
    else skipped.push('none of the picks had a cover');
  }

  if (wants.has('studio')) {
    // Keep the pick, not just the name: a new studio needs that source's id and endpoint.
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
    /* One row per name, keeping the pick for its gender and id. First pick wins. */
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
        /* Only women are created; everyone else is reported. */
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

  /* Organised is opt-in: it means a person looked. */
  if (wants.has('organized')) input.organized = true;

  const saved = await gql(
    config,
    `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id title date organized stash_ids { endpoint stash_id } } }`,
    { input }
  );

  /*
   * Marking organised moves the file, like Mark filed (see filer.mjs).
   * After the metadata, since the path is built from it.
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
   * Rename after the ids and metadata, re-planned from Stash. A refusal is
   * reported, not thrown. Skipped when just filed — filing already names it.
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

/*
 * ------------------------------------------------------------------ tagging
 *
 * Existing tags only. A batch write that creates tags grows "Anal " with a trailing space.
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
 * Add tags to scenes and optionally mark them organised. Additive: never
 * replaces a scene's tags.
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
