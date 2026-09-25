/*
 * StashDB: what the library should contain. Its ids are what v3 indexes
 * and Stash stores. The token is borrowed from Stash.
 *
 * Schema, from introspection:
 *   queryScenes(input: SceneQueryInput) -> { count, scenes }
 *   findScene(id: ID!) -> Scene
 *   findScenesBySceneFingerprints(fingerprints: [[FingerprintQueryInput!]!]!)
 */

import { stashdbEndpoint, stashdbToken } from './stash.mjs';
import { stashConfigured } from './config.mjs';

export class StashdbError extends Error {}

let credentials = null; // Promise<{endpoint, token}|null>

export function forgetCredentials() {
  credentials = null;
}

/* Don't cache a null (see tpdb.mjs). */
async function auth(config) {
  if (!stashConfigured(config)) return null;

  if (!credentials) {
    credentials = Promise.all([stashdbEndpoint(config), stashdbToken(config)])
      .catch((err) => {
        console.warn('[tpdbarr] could not read the StashDB token from Stash:', err.message);
        return [null, null];
      })
      .then(([endpoint, token]) => {
        if (!endpoint || !token) {
          credentials = null;
          return null;
        }
        return { endpoint, token };
      });
  }

  return credentials;
}

// Is StashDB usable at all? Drives whether the search page offers it.
export async function available(config) {
  return Boolean(await auth(config));
}

// The endpoint alone, for matching stash_ids. Needs no token.
export const endpointFor = async (config) =>
  (await auth(config))?.endpoint || (stashConfigured(config) ? await stashdbEndpoint(config).catch(() => null) : null);

/* Compare endpoints ignoring a trailing slash. */
const sameBox = (a, b) =>
  String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();

export const idAt = (stashIds, endpoint) =>
  (endpoint && (stashIds || []).find((s) => sameBox(s.endpoint, endpoint))?.stash_id) || null;

async function gql(config, query, variables = {}) {
  const creds = await auth(config);
  if (!creds) {
    throw new StashdbError(
      'StashDB is not available — Stash has no StashDB stash-box with an API key, and that is where the token is borrowed from.'
    );
  }

  const res = await fetch(creds.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ApiKey: creds.token,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });

  if (res.status === 401 || res.status === 403) {
    // The token came from Stash, so the fix is in Stash and not here.
    forgetCredentials();
    throw new StashdbError('StashDB rejected the token stored in Stash -> Settings -> Metadata Providers.');
  }
  if (!res.ok) throw new StashdbError(`stashdb -> ${res.status}`);

  const payload = await res.json();
  if (payload.errors?.length) throw new StashdbError(payload.errors[0].message);
  return payload.data;
}

/* ----------------------------------------------------------------- shapes */

const SCENE = `
  id
  title
  release_date
  duration
  code
  details
  director
  urls { url site { name } }
  studio { id name parent { id name } }
  performers { as performer { id name disambiguation gender } }
  tags { id name }
  images { url width height }
`;

/* The widest image is the landscape still. */
function art(images = []) {
  const usable = images.filter((i) => i.url);
  if (!usable.length) return null;
  const widest = usable.reduce((best, i) => ((i.width || 0) > (best.width || 0) ? i : best), usable[0]);
  return widest.url;
}

/* A StashDB scene as this app carries it. `id` is v3's stashId and Stash's stash_id. */
export function toCard(raw) {
  const performers = (raw.performers || [])
    .map((p) => ({
      id: p.performer?.id || null,
      name: p.as || p.performer?.name || '',
      gender: p.performer?.gender || null,
    }))
    .filter((p) => p.name);

  return {
    id: raw.id,
    title: raw.title || '(untitled)',
    date: raw.release_date || '',
    studio: raw.studio ? { id: raw.studio.id, name: raw.studio.name } : null,
    studioName: raw.studio?.name || '',
    network: raw.studio?.parent?.name || '',
    performers,
    duration: raw.duration ? Math.round(raw.duration / 60) : null,
    code: raw.code || null,
    details: raw.details || '',
    director: raw.director || null,
    tags: (raw.tags || []).map((t) => t.name).slice(0, 12),
    image: art(raw.images),
    url: `https://stashdb.org/scenes/${raw.id}`,
  };
}

/* ---------------------------------------------------------------- reading */

export async function searchScenes(config, term, { page = 1, perPage = 24 } = {}) {
  const data = await gql(
    config,
    `query($input: SceneQueryInput!) { queryScenes(input: $input) { count scenes { ${SCENE} } } }`,
    { input: { text: term, page, per_page: perPage, sort: 'DATE', direction: 'DESC' } }
  );

  return {
    count: data.queryScenes?.count || 0,
    scenes: (data.queryScenes?.scenes || []).map(toCard),
  };
}

export async function getScene(config, id) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id });
  return data.findScene ? toCard(data.findScene) : null;
}

/*
 * Batch lookups by id via GraphQL aliases (thirty `findScene`s per
 * document); StashDB has no find-by-ids. Merged-away ids come back null.
 */
const BATCH = 30;

export async function scenesByIds(config, ids) {
  const found = new Map();

  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const query = `query {
      ${chunk.map((id, n) => `s${n}: findScene(id: "${id}") { ${SCENE} }`).join(' ')}
    }`;

    const data = await gql(config, query);
    chunk.forEach((id, n) => {
      const raw = data[`s${n}`];
      if (raw) found.set(id, toCard(raw));
    });
  }

  return found;
}

/*
 * ------------------------------------------------------------- the bridge
 *
 * TPDB scene -> StashDB scene, for the v3 route (v3's records carry no
 * tpdbId). Fingerprints first; title and date only as `probable`.
 */
export async function findByFingerprints(config, { phashes = [], oshashes = [] }) {
  const prints = [
    ...oshashes.map((hash) => ({ hash, algorithm: 'OSHASH' })),
    ...phashes.map((hash) => ({ hash, algorithm: 'PHASH' })),
  ].filter((p) => p.hash);

  if (!prints.length) return null;

  const data = await gql(
    config,
    `query($fp: [[FingerprintQueryInput!]!]!) {
       findScenesBySceneFingerprints(fingerprints: $fp) { ${SCENE} }
     }`,
    { fp: [prints] }
  );

  // The query is asked about one scene, so the outer list has one entry.
  const [group] = data.findScenesBySceneFingerprints || [];
  const [hit] = group || [];
  return hit ? toCard(hit) : null;
}

const normalise = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export async function findByTitle(config, { title, date = null, studio = null }) {
  if (!title) return [];

  /*
   * Title only: StashDB ANDs terms and the studio name isn't in the scene
   * text. The studio ranks results instead.
   */
  const { scenes } = await searchScenes(config, title, { perPage: 20 });

  const wanted = normalise(title);
  const named = scenes.filter((s) => normalise(s.title) === wanted);
  if (named.length < 2) return named;

  // Same date first, then same studio: both are corroboration, and a date is
  // the harder of the two to agree on by accident.
  const score = (s) =>
    (date && s.date === date ? 2 : 0) + (studio && normalise(s.studioName) === normalise(studio) ? 1 : 0);

  return [...named].sort((a, b) => score(b) - score(a));
}

/*
 * -> {match: 'exact'|'probable', scene, via, others} or null.
 * A probable isn't acted on here.
 */
export async function bridge(config, tpdbScene) {
  const exact = await findByFingerprints(config, {
    phashes: tpdbScene.phashes || [],
    oshashes: tpdbScene.oshashes || [],
  });
  if (exact) return { match: 'exact', scene: exact, via: 'fingerprint', others: [] };

  const candidates = await findByTitle(config, {
    title: tpdbScene.title,
    date: tpdbScene.date || null,
    studio: tpdbScene.siteName || null,
  });

  if (!candidates.length) return null;

  const [best] = candidates;
  const agrees = [
    best.date && best.date === tpdbScene.date ? 'date' : null,
    best.studioName && tpdbScene.siteName && normalise(best.studioName) === normalise(tpdbScene.siteName) ? 'studio' : null,
  ].filter(Boolean);

  return {
    match: 'probable',
    scene: best,
    via: ['title', ...agrees].join(' + '),
    others: candidates.slice(1, 5),
  };
}

/*
 * --------------------------------------------------------------- searching
 *
 * The acquisition search. Every filter goes to StashDB, so counts are real.
 * Dates take one bound only: DateCriterionInput has no BETWEEN.
 */

export const SORTS = ['DATE', 'TITLE', 'DURATION', 'TRENDING', 'POPULARITY', 'CREATED_AT', 'UPDATED_AT'];
const DATE_MODIFIERS = ['GREATER_THAN', 'LESS_THAN', 'EQUALS'];

const ids = (value) => (Array.isArray(value) ? value : [value]).filter(Boolean);

/* Query string -> SceneQueryInput. Unknown values fall back to defaults. */
export function sceneQuery({
  text = '',
  title = '',
  studios = [],
  parentStudio = '',
  performers = [],
  tags = [],
  date = '',
  dateModifier = 'GREATER_THAN',
  // StashDB's own favourite marks, which is where this library's taste already
  // lives — 107 studios and 72 performers, marked there rather than here.
  favorites = '',
  sort = 'DATE',
  direction = 'DESC',
  page = 1,
  perPage = 24,
} = {}) {
  const input = {
    page: Math.max(1, Number(page) || 1),
    per_page: Math.min(1000, Math.max(1, Number(perPage) || 24)),
    sort: SORTS.includes(sort) ? sort : 'DATE',
    direction: direction === 'ASC' ? 'ASC' : 'DESC',
  };

  if (text) input.text = text;
  if (title) input.title = title;
  if (['PERFORMER', 'STUDIO', 'ALL'].includes(favorites)) input.favorites = favorites;
  if (parentStudio) input.parentStudio = parentStudio;
  if (ids(studios).length) input.studios = { value: ids(studios), modifier: 'INCLUDES' };
  if (ids(performers).length) input.performers = { value: ids(performers), modifier: 'INCLUDES' };
  // INCLUDES_ALL, not INCLUDES: picking two tags means both, or the second tag
  // widens the search instead of narrowing it.
  if (ids(tags).length) input.tags = { value: ids(tags), modifier: 'INCLUDES_ALL' };
  if (date) {
    input.date = { value: date, modifier: DATE_MODIFIERS.includes(dateModifier) ? dateModifier : 'GREATER_THAN' };
  }

  return input;
}

export async function queryScenes(config, input) {
  const data = await gql(
    config,
    `query($input: SceneQueryInput!) { queryScenes(input: $input) { count scenes { ${SCENE} } } }`,
    { input }
  );

  return {
    count: data.queryScenes?.count || 0,
    scenes: (data.queryScenes?.scenes || []).map(toCard),
  };
}

/*
 * Every scene a filter matches, trimmed to id, title and date, for coverage.
 * Capped at the newest `cap`, and the cap is reported.
 */
const ID_PAGE = 500;

/* `rich` adds duration and tags, only when a rule needs them. */
export async function sceneBriefs(config, input, { cap = 3000, rich = false, cast = false } = {}) {
  const out = [];
  let total = 0;

  // Cast only when needed. See rules.needsCast.
  const fields = [
    'id title release_date',
    rich || cast ? 'duration studio { name parent { name } } tags { name }' : '',
    cast ? 'performers { performer { id name } }' : '',
  ].filter(Boolean).join(' ');

  for (let page = 1; out.length < cap; page++) {
    const data = await gql(
      config,
      `query($input: SceneQueryInput!) {
         queryScenes(input: $input) { count scenes { ${fields} } }
       }`,
      { input: { ...input, page, per_page: ID_PAGE } }
    );

    total = data.queryScenes?.count || 0;
    const batch = data.queryScenes?.scenes || [];
    for (const scene of batch) {
      out.push({
        id: scene.id,
        title: scene.title || '',
        date: scene.release_date || '',
        // Minutes, the same unit the full scene record uses, so a rule reads
        // the same number whichever shape reaches it.
        duration: scene.duration ? Math.round(scene.duration / 60) : null,
        studioName: scene.studio?.name || '',
        network: scene.studio?.parent?.name || '',
        tags: (scene.tags || []).map((t) => t.name),
        performers: (scene.performers || [])
          .map((p) => ({ id: p.performer?.id, name: p.performer?.name || '' })),
      });
    }
    if (batch.length < ID_PAGE || out.length >= total) break;
  }

  return { scenes: out.slice(0, cap), total, capped: total > cap };
}

/*
 * ------------------------------------------------------------ by director
 *
 * A director's filmography (see categories.mjs). StashDB can't query by
 * director, so: text-search the name, keep scenes whose `director` matches.
 * Best effort; missed scenes can be added by hand. Capped at twenty pages.
 */
const foldName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Substring, since bylines carry extras ("… for Pure Taboo").
const directorMatches = (raw, wantedFolded) => foldName(raw.director).includes(wantedFolded);

export async function findByDirector(config, name, { maxPages = 20, perPage = 25 } = {}) {
  const wanted = foldName(name);
  if (!wanted) return [];

  const found = new Map();

  for (let page = 1; page <= maxPages; page++) {
    const data = await gql(
      config,
      `query($input: SceneQueryInput!) { queryScenes(input: $input) { count scenes { ${SCENE} } } }`,
      { input: { text: name, page, per_page: perPage, sort: 'DATE', direction: 'DESC' } }
    );

    const batch = data.queryScenes?.scenes || [];
    for (const raw of batch) {
      if (directorMatches(raw, wanted)) found.set(raw.id, toCard(raw));
    }

    const total = data.queryScenes?.count || 0;
    if (batch.length < perPage || page * perPage >= total) break;
  }

  return [...found.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/* A scene's network: its studio's parent, or itself. */
export async function sceneStudioNetwork(config, id) {
  const data = await gql(
    config,
    `query($id: ID!) { findScene(id: $id) { studio { id name parent { id name } } } }`,
    { id }
  );
  const studio = data.findScene?.studio;
  if (!studio) return null;
  return studio.parent ? { id: studio.parent.id, name: studio.parent.name } : { id: studio.id, name: studio.name };
}

/*
 * Every scene in a network, kept where the director matches. Two passes
 * (`studios`, then `parentStudio`) since no filter covers both. Page-capped.
 */
export async function crawlNetworkForDirector(config, networkId, director, { maxPages = 80, perPage = 100 } = {}) {
  const wanted = foldName(director);
  if (!wanted) return [];

  const found = new Map();
  const filters = [
    { studios: { value: [networkId], modifier: 'INCLUDES' } },
    { parentStudio: networkId },
  ];

  for (const filt of filters) {
    for (let page = 1; page <= maxPages; page++) {
      const data = await gql(
        config,
        `query($input: SceneQueryInput!) { queryScenes(input: $input) { count scenes { ${SCENE} } } }`,
        { input: { ...filt, page, per_page: perPage, sort: 'DATE', direction: 'DESC' } }
      );

      const batch = data.queryScenes?.scenes || [];
      for (const raw of batch) {
        if (directorMatches(raw, wanted)) found.set(raw.id, toCard(raw));
      }

      const total = data.queryScenes?.count || 0;
      if (!batch.length || page * perPage >= total) break;
    }
  }

  return [...found.values()];
}

/*
 * ----------------------------------------------------------- the entities
 *
 * Filter-chip type-ahead. StashDB's search* queries match aliases.
 */

// Studio artwork comes back with width -1 when StashDB has not measured it, so
// "the widest" is not a question that can be asked here. The first is the one.
const firstImage = (images = []) => images.find((i) => i.url)?.url || null;

export async function searchStudios(config, term, { limit = 10 } = {}) {
  const data = await gql(
    config,
    `query($t: String!, $l: Int!) { searchStudio(term: $t, limit: $l) { id name images { url } parent { id name } } }`,
    { t: term, l: limit }
  );

  return (data.searchStudio || []).map((s) => ({
    kind: 'studio',
    id: s.id,
    name: s.name,
    detail: s.parent?.name || '',
    parentId: s.parent?.id || null,
    image: firstImage(s.images),
  }));
}

export async function searchPerformers(config, term, { limit = 10 } = {}) {
  const data = await gql(
    config,
    `query($t: String!, $l: Int!) {
       searchPerformers(term: $t, limit: $l) {
         performers { id name disambiguation gender scene_count images { url width height } }
       }
     }`,
    { t: term, l: limit }
  );

  return (data.searchPerformers?.performers || []).map((p) => ({
    kind: 'performer',
    id: p.id,
    name: p.name,
    detail: [p.disambiguation, p.gender?.toLowerCase()].filter(Boolean).join(' · '),
    sceneCount: p.scene_count || 0,
    image: art(p.images),
  }));
}

export async function searchTags(config, term, { limit = 10 } = {}) {
  const data = await gql(config, `query($t: String!, $l: Int!) { searchTag(term: $t, limit: $l) { id name } }`, {
    t: term,
    l: limit,
  });

  return (data.searchTag || []).map((t) => ({ kind: 'tag', id: t.id, name: t.name, detail: '' }));
}

/* One entity by id, for chips from a bookmarked URL. */
export async function getStudio(config, id) {
  const data = await gql(
    config,
    `query($id: ID!) { findStudio(id: $id) { id name images { url } parent { id name } } }`,
    { id }
  );
  const s = data.findStudio;
  if (!s) return null;
  return {
    kind: 'studio',
    id: s.id,
    name: s.name,
    detail: s.parent?.name || '',
    parentId: s.parent?.id || null,
    image: firstImage(s.images),
  };
}

export async function getPerformer(config, id) {
  const data = await gql(
    config,
    `query($id: ID!) {
       findPerformer(id: $id) { id name disambiguation gender scene_count images { url width height } }
     }`,
    { id }
  );
  const p = data.findPerformer;
  if (!p) return null;
  return {
    kind: 'performer',
    id: p.id,
    name: p.name,
    detail: [p.disambiguation, p.gender?.toLowerCase()].filter(Boolean).join(' · '),
    sceneCount: p.scene_count || 0,
    image: art(p.images),
  };
}

export async function getTag(config, id) {
  const data = await gql(config, `query($id: ID!) { findTag(id: $id) { id name } }`, { id });
  const t = data.findTag;
  return t ? { kind: 'tag', id: t.id, name: t.name, detail: '' } : null;
}
