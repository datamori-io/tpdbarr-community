/*
 * Wild Card: build one scene's record from several sources at once.
 *
 * For scenes no fingerprint knows (often DVD rips). You give it URLs and
 * keywords; each answer is a *contribution*, and you choose which one wins
 * each field. Nothing is merged or ranked. Everything goes through Stash's
 * own installed scrapers. Nothing is written until `apply`, and only the
 * fields handed to it.
 */

import { gql } from './stash.mjs';
import { readFile } from 'node:fs/promises';

import { asDate, readName } from './matchsort.mjs';
import * as scenethumb from './scenethumb.mjs';
import * as artwork from './artwork.mjs';
import * as renamer from './renamer.mjs';

const SCENE = `
  id
  title
  date
  details
  organized
  code
  director
  urls
  studio { id name }
  performers { id name }
  tags { id name }
  files { path }
  paths { screenshot }
  stash_ids { endpoint stash_id }
`;

/* Match's fields plus director and code. */
const SCRAPED = `
  title code details director urls date image remote_site_id
  studio { stored_id name remote_site_id }
  tags { stored_id name }
  performers { stored_id name gender remote_site_id }
`;

/* What a group (film) scraper returns: film-level fields, no cast or scene title. */
const SCRAPED_GROUP = `
  name date director synopsis urls front_image
  studio { stored_id name }
  tags { stored_id name }
`;

/*
 * ------------------------------------------------------------ the sources
 *
 * Scrapers that can search by NAME (the DVD sites among them).
 */
export async function sources(config) {
  const data = await gql(
    config,
    '{ listScrapers(types: [SCENE]) { id name scene { supported_scrapes } } }'
  ).catch(() => null);

  const all = data?.listScrapers || [];
  const can = (s, what) => (s.scene?.supported_scrapes || []).includes(what);

  const films = await groupCount(config);

  return {
    films,
    /* Sorted by name. */
    ask: all
      .filter((s) => can(s, 'NAME'))
      .map((s) => ({ key: s.id, label: s.name || s.id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    /* Just a count: Stash picks the URL scraper by host. */
    urls: all.filter((s) => can(s, 'URL')).length,
  };
}

/*
 * How many sites can be read as a film. Abilities are per type, so a group
 * scraper may not be a scene one. None search by name; all are URL-only.
 */
async function groupCount(config) {
  const data = await gql(
    config,
    '{ listScrapers(types: [GROUP]) { id group { supported_scrapes } } }'
  ).catch(() => null);

  return (data?.listScrapers || [])
    .filter((s) => (s.group?.supported_scrapes || []).includes('URL')).length;
}

/*
 * -------------------------------------------------------------- the scene
 *
 * The record being built. Current values are the baseline.
 */

const briefScene = (raw) => ({
  id: String(raw.id),
  title: raw.title || '',
  date: raw.date || '',
  details: raw.details || '',
  code: raw.code || '',
  director: raw.director || '',
  organized: !!raw.organized,
  studioName: raw.studio?.name || '',
  performers: (raw.performers || []).map((p) => p.name).filter(Boolean),
  tags: (raw.tags || []).map((t) => t.name).filter(Boolean),
  urls: raw.urls || [],
  path: raw.files?.[0]?.path || null,
  image: raw.paths?.screenshot || null,
  stashIds: raw.stash_ids || [],
  /* The filename's title, via match's parser. The keyword box starts with it. */
  term: raw.title || readName(raw.files?.[0]?.path).title,
});

export async function scene(config, id) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id: String(id) });
  if (!data.findScene) throw new Error('Stash has no scene with that id.');
  return { scene: briefScene(data.findScene) };
}

/* Find the scene to work on. Stash's `q` also searches the path. */
export async function find(config, term, { limit = 20 } = {}) {
  const q = String(term || '').trim();
  if (!q) return { scenes: [] };

  const data = await gql(
    config,
    `query($q: String!, $n: Int!) {
       findScenes(filter: {q: $q, per_page: $n, sort: "updated_at", direction: DESC}) {
         scenes { ${SCENE} }
       }
     }`,
    { q, n: Math.min(50, Math.max(1, Number(limit) || 20)) }
  );

  return { scenes: (data.findScenes?.scenes || []).map(briefScene) };
}

/*
 * ------------------------------------------------------- the contributions
 *
 * One shape for every source. Failures report with `ok` and `note` and stay on screen.
 */
const shape = (raw, from, label, { url = '' } = {}) => ({
  from,
  label,
  url: url || (raw.urls || [])[0] || '',
  remoteId: raw.remote_site_id || null,
  ok: true,
  note: '',
  fields: {
    title: raw.title || '',
    // Scrapers print the date the way the site did. Stash takes one shape and
    // refuses the whole write over any other, so it is read here or dropped.
    date: asDate(raw.date),
    details: raw.details || '',
    code: raw.code || '',
    director: raw.director || '',
    studioName: raw.studio?.name || '',
    performers: (raw.performers || []).map((p) => p.name).filter(Boolean),
    tags: (raw.tags || []).map((t) => t.name).filter(Boolean),
    image: raw.image || '',
    urls: (raw.urls || []).filter(Boolean),
  },
});

/* A film answer. `kind` stops its title being taken as the scene title. */
const shapeGroup = (raw, label, url) => ({
  from: 'url',
  kind: 'group',
  label: `${label} (the film)`,
  url: url || (raw.urls || [])[0] || '',
  remoteId: null,
  ok: true,
  note: '',
  fields: {
    title: raw.name || '',
    date: asDate(raw.date),
    details: raw.synopsis || '',
    code: '',
    director: raw.director || '',
    studioName: raw.studio?.name || '',
    // A film has a cast between all its scenes and none that belongs to any
    // one of them, so this is deliberately empty rather than wrong.
    performers: [],
    tags: (raw.tags || []).map((t) => t.name).filter(Boolean),
    image: raw.front_image || '',
    urls: (raw.urls || []).filter(Boolean),
  },
});

const nothing = (from, label, note, extra = {}) =>
  ({ from, label, note, ok: false, url: '', remoteId: null, fields: null, ...extra });

const urlOf = (value) => { try { return new URL(String(value)); } catch { return null; } };
const hostOf = (value) => urlOf(value)?.host || String(value).slice(0, 60);
const protocolOf = (value) => urlOf(value)?.protocol || '';

/*
 * Read URLs you pasted. Stash picks the scraper by host. Only URLs you
 * typed; links found in answers are never followed.
 */
const MOST_URLS = 12;

export async function fromUrls(config, urls = []) {
  const list = [...new Set(
    (Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim()).filter(Boolean)
  )].slice(0, MOST_URLS);

  if (!list.length) return { contributions: [] };

  /* In parallel: a few URLs at different hosts. */
  const contributions = await Promise.all(list.map(async (url) => {
    const host = hostOf(url);
    if (!/^https?:$/.test(protocolOf(url))) return nothing('url', host, 'Not an http address.', { url });

    /*
     * Swallow a scene-scrape failure so the group scraper still gets its turn
     * (AdultFilmIndex errors on a scene scrape instead of returning empty).
     */
    try {
      const data = await gql(
        config,
        `query($u: String!) { scrapeSceneURL(url: $u) { ${SCRAPED} } }`,
        { u: url }
      ).catch(() => null);

      if (data?.scrapeSceneURL) return shape(data.scrapeSceneURL, 'url', host, { url });

      /* Not a scene, so try it as a film. Scene answers win where both exist. */
      const film = await gql(
        config,
        `query($u: String!) { scrapeGroupURL(url: $u) { ${SCRAPED_GROUP} } }`,
        { u: url }
      ).catch(() => null);

      if (film?.scrapeGroupURL) return shapeGroup(film.scrapeGroupURL, host, url);

      return nothing('url', host, 'No scraper here reads that site, as a scene or as a film.', { url });
    } catch (err) {
      return nothing('url', host, err.message, { url });
    }
  }));

  return { contributions };
}

/*
 * Keyword search of sites that can search themselves. One source may return
 * several scenes, capped per source.
 */
const PER_SOURCE = 5;
const MOST_SOURCES = 8;

export async function ask(config, query, keys = []) {
  const term = String(query || '').trim();
  if (!term) throw new Error('Nothing to search for.');

  const wanted = [...new Set(
    (Array.isArray(keys) ? keys : []).map(String).filter(Boolean)
  )].slice(0, MOST_SOURCES);
  if (!wanted.length) throw new Error('Pick at least one source to ask.');

  const { ask: available } = await sources(config);
  const known = new Map(available.map((s) => [s.key, s.label]));

  const answers = await Promise.all(wanted.map(async (key) => {
    const label = known.get(key);
    /* Not in the list means no NAME scrape; asking anyway is a GraphQL error. */
    if (!label) return [nothing('ask', key, 'That scraper cannot search by name.')];

    try {
      const data = await gql(
        config,
        `query($s: ScraperSourceInput!, $i: ScrapeSingleSceneInput!) {
           scrapeSingleScene(source: $s, input: $i) { ${SCRAPED} }
         }`,
        { s: { scraper_id: key }, i: { query: term } }
      );

      const found = data.scrapeSingleScene || [];
      if (!found.length) return [nothing('ask', label, `nothing for “${term}”`)];

      const shown = Math.min(found.length, PER_SOURCE);
      return found.slice(0, PER_SOURCE).map((raw, at) =>
        shape(raw, 'ask', shown > 1 ? `${label} (${at + 1} of ${shown})` : label));
    } catch (err) {
      return [nothing('ask', label, err.message)];
    }
  }));

  return { term, contributions: answers.flat() };
}

/*
 * ------------------------------------------------------------- the writing
 *
 * Every value in `values` was chosen by a person, so it overwrites. Fields
 * not in `values` are left alone. Performers, studios and tags attach only
 * if Stash has them; the rest are reported.
 */
const NAMED = {
  performer: `query($n: String!) {
    findPerformers(performer_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { performers { id name } }
  }`,
  studio: `query($n: String!) {
    findStudios(studio_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { studios { id name } }
  }`,
  tag: `query($n: String!) {
    findTags(tag_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { tags { id name } }
  }`,
};

async function idFor(config, kind, name) {
  const data = await gql(config, NAMED[kind], { n: name }).catch(() => null);
  const list = data?.findPerformers?.performers || data?.findStudios?.studios || data?.findTags?.tags || [];
  return list[0]?.id || null;
}

/*
 * ------------------------------------------------------- what Stash already has
 *
 * Names you can pick from Stash's own lists, most used first. Nothing is created.
 */
const ROSTER = {
  performer: [`query($f: PerformerFilterType) {
    findPerformers(performer_filter: $f, filter: {per_page: 40, sort: "scenes_count", direction: DESC}) {
      count performers { id name scene_count }
    }
  }`, 'findPerformers', 'performers'],
  studio: [`query($f: StudioFilterType) {
    findStudios(studio_filter: $f, filter: {per_page: 40, sort: "scenes_count", direction: DESC}) {
      count studios { id name scene_count }
    }
  }`, 'findStudios', 'studios'],
  tag: [`query($f: TagFilterType) {
    findTags(tag_filter: $f, filter: {per_page: 40, sort: "scenes_count", direction: DESC}) {
      count tags { id name scene_count }
    }
  }`, 'findTags', 'tags'],
};

export async function names(config, kind, term = '') {
  const found = ROSTER[kind];
  if (!found) throw new Error(`There is no list of ${kind} to pick from.`);

  const [query, root, list] = found;
  const q = String(term || '').trim();

  const data = await gql(config, query, {
    f: q ? { name: { value: q, modifier: 'INCLUDES' } } : null,
  });

  return {
    kind,
    count: data[root]?.count ?? 0,
    names: (data[root]?.[list] || []).map((row) => ({
      id: row.id,
      name: row.name,
      scenes: row.scene_count ?? 0,
    })),
  };
}

/*
 * ------------------------------------------------------- making a new one
 *
 * Create a performer, studio or tag you typed, on its own button, once the
 * box has shown Stash has none by that name. Never on the write.
 */
const MAKE = {
  performer: [`mutation($n: String!) { performerCreate(input: {name: $n}) { id name } }`, 'performerCreate'],
  studio: [`mutation($n: String!) { studioCreate(input: {name: $n}) { id name } }`, 'studioCreate'],
  tag: [`mutation($n: String!) { tagCreate(input: {name: $n}) { id name } }`, 'tagCreate'],
};

export async function create(config, kind, name) {
  const made = MAKE[kind];
  if (!made) throw new Error(`A ${kind} cannot be created from this page.`);

  const n = String(name || '').trim();
  if (!n) throw new Error('A name is needed.');

  // Somebody else's tab, or a name that differs only in case: Stash would take
  // the second one and you would have two. Hand back the one that exists.
  const already = await idFor(config, kind, n);
  if (already) return { kind, id: already, name: n, made: false };

  const [query, root] = made;
  const data = await gql(config, query, { n });
  const row = data?.[root];
  if (!row?.id) throw new Error(`Stash would not create the ${kind} “${n}”.`);

  return { kind, id: row.id, name: row.name, made: true };
}

/*
 * ------------------------------------------------------------ your own cover
 *
 * A picture uploaded or fetched from a pasted URL. Held in memory (twelve,
 * an hour each) and only reaches Stash if chosen on Write. Fetched here so
 * the page can show it past hotlink protection, and checked to be a picture.
 */
const ART_KEEP = 60 * 60 * 1000;
const ART_MOST = 12;

const artHold = new Map();
let artSeq = 0;

const sweepArt = () => {
  const dead = Date.now() - ART_KEEP;
  for (const [id, held] of artHold) if (held.at < dead) artHold.delete(id);
  while (artHold.size > ART_MOST) artHold.delete(artHold.keys().next().value);
};

export const artUrl = (id) => `/api/import/wildcard/art/${id}`;

export function holdArt(buffer) {
  const kind = artwork.checked(buffer);
  const id = `${Date.now().toString(36)}${(++artSeq).toString(36)}`;

  artHold.set(id, { bytes: buffer, kind, at: Date.now() });
  sweepArt();

  return { id, url: artUrl(id), type: kind.type, bytes: buffer.length };
}

export function heldArt(id) {
  const held = artHold.get(String(id));
  if (!held) return null;
  // Read is use: a cover you are still looking at should not expire under you.
  held.at = Date.now();
  return held;
}

/* Fetch into the same hold. http(s) only; magic bytes must say picture. */
export async function fetchArt(address) {
  let url;
  try { url = new URL(String(address).trim()); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) {
    throw Object.assign(new Error('That is not a web address this can fetch.'), { status: 400 });
  }

  const res = await fetch(url, { redirect: 'follow' }).catch((err) => {
    throw Object.assign(new Error(`That address could not be reached: ${err.message}`), { status: 502 });
  });
  if (!res.ok) {
    throw Object.assign(new Error(`That address answered ${res.status}.`), { status: 502 });
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  return { ...holdArt(bytes), from: url.href };
}

/*
 * Our frame URLs are relative to the browser, so Stash can't fetch them.
 * Read off disk and sent as bytes. Other URLs pass through.
 */
const FRAME = /^\/media\/scene\/(\d+)\/frame\/(\d+)(?:\?|$)/;

// Held uploads: same problem, same answer.
const HELD = /^\/api\/import\/wildcard\/art\/([a-z0-9]+)(?:\?|$)/;

async function coverFrom(value) {
  const mine = String(value).match(HELD);
  if (mine) {
    const held = heldArt(mine[1]);
    return held ? artwork.dataUrl(held.bytes, held.kind) : null;
  }

  const local = String(value).match(FRAME);
  if (!local) return value;

  const path = scenethumb.framePath(local[1], local[2]);
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return null;

  return 'data:image/jpeg;base64,' + bytes.toString('base64');
}

const TEXT_FIELDS = ['title', 'date', 'details', 'code', 'director'];

export async function apply(config, sceneId, values = {}, opts = {}) {
  const current = await gql(config, `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id: String(sceneId) });
  if (!current.findScene) throw new Error('Stash has no scene with that id.');

  const input = { id: String(sceneId) };
  const wrote = [];
  const skipped = [];

  for (const key of TEXT_FIELDS) {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    /* A bad date fails the whole Stash write, so check it again here. */
    if (key === 'date') {
      const when = asDate(value);
      if (!when) { skipped.push(`date “${value.trim()}” is not a date Stash can read`); continue; }
      input.date = when;
      wrote.push('date');
      continue;
    }
    input[key] = value.trim();
    wrote.push(key);
  }

  // Stash fetches the cover itself, given somewhere to fetch it from.
  if (typeof values.image === 'string' && values.image.trim()) {
    const cover = await coverFrom(values.image.trim());
    if (cover) { input.cover_image = cover; wrote.push('cover'); }
    else skipped.push('the picture chosen for the cover is no longer to hand, so the cover was left alone');
  }

  if (typeof values.studioName === 'string' && values.studioName.trim()) {
    const name = values.studioName.trim();
    const id = await idFor(config, 'studio', name);
    if (id) { input.studio_id = id; wrote.push('studio'); }
    else skipped.push(`studio “${name}” is not in Stash`);
  }

  /* Lists replace what's there: you assembled the cast deliberately. */
  for (const [key, kind, field] of [
    ['performers', 'performer', 'performer_ids'],
    ['tags', 'tag', 'tag_ids'],
  ]) {
    const names = Array.isArray(values[key])
      ? [...new Set(values[key].map((n) => String(n).trim()).filter(Boolean))]
      : null;
    if (!names || !names.length) continue;

    const ids = [];
    for (const name of names) {
      const id = await idFor(config, kind, name);
      if (id) ids.push(id);
      else skipped.push(`${kind} “${name}” is not in Stash`);
    }
    if (ids.length) { input[field] = [...new Set(ids)]; wrote.push(key); }
  }

  /* URLs are added to, not replaced. */
  if (Array.isArray(values.urls) && values.urls.length) {
    const now = new Set(current.findScene.urls || []);
    for (const u of values.urls) if (String(u || '').trim()) now.add(String(u).trim());
    input.urls = [...now];
    wrote.push('links');
  }

  if (values.organized === true) { input.organized = true; wrote.push('organised'); }

  if (!wrote.length) throw new Error('Nothing was chosen, so nothing was written.');

  const saved = await gql(
    config,
    `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { ${SCENE} } }`,
    { input }
  );

  /* Rename after the write; renamer re-plans from Stash. A refusal is reported, not thrown. */
  let renamed = null;
  if (opts.rename) {
    renamed = await renamer.rename(config, sceneId)
      .then((out) => ({ ok: true, to: out.to, scanned: out.scanned }))
      .catch((err) => ({ ok: false, why: err.message }));
  }

  return { scene: briefScene(saved.sceneUpdate), wrote, skipped, renamed };
}
