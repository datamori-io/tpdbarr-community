/*
 * StashDB — what the library *should* contain.
 *
 * The other two sources answer different questions. Stash is what you have;
 * ThePornDB is a catalogue that happens to be reachable. StashDB is the one
 * Whisparr v3 indexes on, which makes it the only source whose ids survive the
 * whole trip: search here, add there, and the scene arrives in Stash carrying
 * the same UUID it was found under. So this is the front door, and TPDB is
 * where you go when StashDB has never heard of it.
 *
 * Credentials are borrowed from Stash, which already stores a token for the
 * StashDB stash-box — the same trick tpdb.mjs plays. Nothing to paste, and the
 * token never leaves this machine except back to StashDB.
 *
 * The schema here was read off StashDB's own introspection rather than guessed:
 *   queryScenes(input: SceneQueryInput) -> { count, scenes }
 *   findScene(id: ID!) -> Scene
 *   findScenesBySceneFingerprints(fingerprints: [[FingerprintQueryInput!]!]!)
 * Worth re-reading if any of it ever stops matching.
 */

import { stashdbEndpoint, stashdbToken } from './stash.mjs';
import { stashConfigured } from './config.mjs';

export class StashdbError extends Error {}

let credentials = null; // Promise<{endpoint, token}|null>

export function forgetCredentials() {
  credentials = null;
}

/*
 * Same shape and same reasoning as the TPDB token: a null is never cached, so
 * one slow moment from Stash does not take StashDB out until a restart.
 */
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

// The endpoint on its own, for matching stash_ids in Stash against StashDB.
// Matching needs no token, so a stash-box saved without one still matches —
// it used to answer null, and every "do I have this" silently lost its exact
// pass and fell back to title + date or to nothing.
export const endpointFor = async (config) =>
  (await auth(config))?.endpoint || (stashConfigured(config) ? await stashdbEndpoint(config).catch(() => null) : null);

/*
 * Which of a Stash record's stash_ids is StashDB's. Stash keeps the endpoint as
 * it was typed and a trailing slash is not a different stash-box.
 */
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

/*
 * StashDB serves several images per scene at different sizes and the widest is
 * the landscape still — the same one the acquisition cards already show for a
 * TPDB scene, so the two sets of tiles look like one page.
 */
function art(images = []) {
  const usable = images.filter((i) => i.url);
  if (!usable.length) return null;
  const widest = usable.reduce((best, i) => ((i.width || 0) > (best.width || 0) ? i : best), usable[0]);
  return widest.url;
}

/*
 * A StashDB scene as this app carries it. `id` is the UUID Whisparr v3 knows as
 * stashId and Stash stores as a stash_id, which is the whole reason this source
 * is worth having: one id, three systems.
 */
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
 * The same read, asked for a list of ids at once.
 *
 * StashDB has no findScenes(ids:) — queryScenes filters by studio, performer
 * and text and not by id — so the batch is made with GraphQL aliases: thirty
 * `findScene` fields in one document rather than thirty round trips. Thirty
 * because a want list of a couple of thousand is seventy-odd requests at that
 * size, and a document large enough to be refused would fail the whole batch.
 *
 * An id StashDB no longer has comes back null and is simply absent from the
 * Map, which is the honest answer for a scene that has been merged away.
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

/* ------------------------------------------------------------- the bridge
 *
 * TPDB scene -> the same scene on StashDB, so something found on the TPDB side
 * can still go the v3 route. Whisparr v3 cannot do this itself: its scene
 * records come back with tpdbId null (checked against a live instance), so the
 * two catalogues only meet on content.
 *
 * Fingerprints first, because they are the one answer that cannot be a
 * coincidence — TPDB publishes PHASH and OSHASH per scene and StashDB indexes
 * the same kinds. Title and date only ever come back as `probable`, and what
 * happens to a probable is decided upstairs, not here.
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
   * The title and nothing else. StashDB's `text` search ANDs its terms against
   * the scene text, and the studio name is not part of that text — adding it
   * takes a search that finds the scene and turns it into one that finds
   * nothing (checked: "PlushiesVR <title>" -> 0, "<title>" -> 1). So the studio
   * is used to rank what comes back, never to fetch it.
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
 *
 * A `probable` is deliberately not acted on here. The caller shows it and asks.
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

/* --------------------------------------------------------------- searching
 *
 * The acquisition search runs on this rather than on searchScenes above.
 * StashDB's own query input takes every filter the page offers — text, title,
 * studio, performer, tag, a date bound, and the sort — so a filter is never
 * faked by discarding rows out of a page that has already come back. A count
 * shown next to a filtered search is StashDB's count of the whole match, not
 * of the twenty-four things on screen.
 *
 * One thing it will not do: DateCriterionInput carries a single `value` and no
 * `value2`, and its modifiers are EQUALS / GREATER_THAN / LESS_THAN — there is
 * no BETWEEN. So the page offers one date bound, on purpose. Two bounds would
 * have to be half a filter and half a lie about the count.
 */

export const SORTS = ['DATE', 'TITLE', 'DURATION', 'TRENDING', 'POPULARITY', 'CREATED_AT', 'UPDATED_AT'];
const DATE_MODIFIERS = ['GREATER_THAN', 'LESS_THAN', 'EQUALS'];

const ids = (value) => (Array.isArray(value) ? value : [value]).filter(Boolean);

/*
 * The browser's query string -> StashDB's SceneQueryInput.
 *
 * Everything is checked here rather than trusted: an unknown sort or date
 * modifier becomes the default instead of a GraphQL error the page cannot do
 * anything with.
 */
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
 * Every scene a filter matches, stripped to what coverage needs — the id, and
 * the title and date that let a scene identified against the *other* stash-box
 * still be recognised. A tracked studio's whole catalogue at full scene shape
 * is megabytes of artwork URLs nobody is going to look at.
 *
 * The cap is a real limit and is reported, not hidden: a network with tens of
 * thousands of scenes is measured on the newest `cap` of them and the card says
 * so, rather than the page hanging on forty round trips.
 */
const ID_PAGE = 500;

/*
 * `rich` adds the duration and the tags, and is asked for only when something
 * needs them — today that is a decide rule about a length or a tag. This walks
 * every scene of a tracked catalogue up to the cap, forty-nine catalogues of
 * them, so the difference between three fields and five is paid a hundred
 * thousand times over and is not worth paying unasked.
 */
export async function sceneBriefs(config, input, { cap = 3000, rich = false, cast = false } = {}) {
  const out = [];
  let total = 0;

  // The cast is asked for on its own and only when something needs it: it is
  // a list per scene rather than a field, over every scene of every catalogue
  // you follow. See rules.needsCast.
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

/* ------------------------------------------------------------ by director
 *
 * A director's filmography — for a portal-owned category that wants to show
 * what somebody directed whether or not you hold it. See categories.mjs's
 * `kind: 'filmography'`.
 *
 * StashDB has no query for this. `director` lives on Scene as a free string
 * with nothing that indexes it — SceneQueryInput's own fields were read off
 * introspection and there is no `director` among them, and there is no Group
 * or Movie type on StashDB at all, only Scene. So this is a net rather than a
 * lookup: search the name as text, which is the nearest thing StashDB offers,
 * and keep only what comes back whose own `director` field actually matches.
 * The search finds candidates; the field decides.
 *
 * This is best-effort, not a guarantee. A scene StashDB's text search does not
 * surface for this name — because the search does not weigh the director
 * credit the way it weighs a title — is a scene this can never find, and the
 * category page has its own way to add one by hand for exactly that reason.
 *
 * Bounded at twenty pages so a common name typed by mistake cannot turn a
 * refresh into a crawl of the whole site; a director's own name is a narrow
 * search term in the ordinary case.
 */
const foldName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Substring rather than exact: a studio's own byline sometimes carries more
// than the bare name ("Ricky Greenwood for Pure Taboo"), and this is already
// only ever asked of candidates a text search or a network crawl produced —
// both narrow enough that a substring match is not going to pull in a
// different person of a similar name.
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

/*
 * The network a scene's studio belongs to — its parent, or itself when it has
 * none. A director works for a network's studios as a set, not for one studio
 * in isolation, so this is the unit crawlNetworkForDirector walks.
 */
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
 * Every scene of one network — its own studios, then every child studio's —
 * kept where the director credit matches. This is the actual answer to "what
 * did this person direct", as far as it can be answered at all: StashDB will
 * not search by director, but it will hand over a whole network's catalogue a
 * page at a time, and a network is the unit a director's byline sticks to.
 *
 * Two passes because `studios` and `parentStudio` are different filters — the
 * network's own scenes are filed directly under it, and everything else is
 * filed under one of its children, and StashDB has no single filter that
 * means "this studio or any of its children".
 *
 * Bounded at a page count that is generous for a real network (Adult Time's
 * whole slate is a few thousand scenes across four filters here) rather than
 * unbounded, so a mis-seeded id cannot turn a refresh into an unattended crawl
 * of the site.
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

/* ----------------------------------------------------------- the entities
 *
 * What the filter chips are picked from. StashDB's search* queries are the
 * type-ahead ones — they match aliases as well as names, which is the whole
 * reason to ask the catalogue instead of filtering a list in the browser.
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

/*
 * One of a thing, by id. Used when a filter arrives from a bookmarked URL and
 * the browser has an id but no name to put on the chip.
 */
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
