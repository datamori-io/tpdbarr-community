/*
 * Stash client: "do I already have this?"
 *
 * A scene identified against TPDB's stash-box carries the TPDB UUID, which
 * the metadata service calls ForeignGuid: an exact match. Otherwise title +
 * date gives a probable one.
 */

const SCENE_FIELDS = 'id title date studio { name } stash_ids { endpoint stash_id } files { path }';
const CHUNK = 250;

export class StashError extends Error {}

/* Stash's SQLite reports "database is locked" during scans. Retry that message only. */
const LOCKED = /database is locked/i;
const RETRIES = 2;

/*
 * Every portal write to Stash goes through gql(), so caches built from
 * Stash are invalidated here (these indexes plus whatever registers).
 * Play position, count and O writes are skipped. Scans and generates are
 * jobs, so they clear again a little later.
 */
const listeners = new Set();
export const onStashChange = (fn) => { listeners.add(fn); };

const QUIET = /^\s*mutation\b[^{]*\{\s*scene(SaveActivity|AddPlay|AddO)\b/;
const JOB = /\bmetadata(Scan|Generate|Identify|AutoTag|Clean)\b/;
const JOB_SETTLE = [30_000, 120_000];

export function stashChanged() {
  titleCache = null;
  fingerprintCache = null;
  groupCache = null;
  for (const fn of listeners) {
    try { fn(); } catch { /* a listener failing must not fail the write */ }
  }
}

function afterWrite(query) {
  if (!/^\s*mutation\b/.test(query) || QUIET.test(query)) return;
  stashChanged();
  if (JOB.test(query)) {
    for (const ms of JOB_SETTLE) setTimeout(stashChanged, ms).unref?.();
  }
}

export async function gql(config, query, variables = {}) {
  const base = config.stashUrl.replace(/\/+$/, '');

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + '/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Stash only requires this if an API key has been set in its settings.
        ...(config.stashApiKey ? { ApiKey: config.stashApiKey } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) throw new StashError(`stash -> ${res.status}`);
    const payload = await res.json();

    if (payload.errors?.length) {
      const message = payload.errors[0].message;
      if (LOCKED.test(message) && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw new StashError(message);
    }

    afterWrite(query);
    return payload.data;
  }
}

export const version = (config) => gql(config, '{ version { version } }');

// Which configured stash-box endpoint is TPDB? Read it from Stash rather than
// making the user tell us twice.
export async function tpdbEndpoint(config) {
  const data = await gql(config, '{ configuration { general { stashBoxes { endpoint name } } } }');
  const boxes = data.configuration?.general?.stashBoxes || [];
  const tpdb = boxes.filter((b) => /theporndb|metadataapi/i.test(b.endpoint || ''));

  /* TPDB is often configured twice (?type=Scene and ?type=Movie). Use the Scene one. */
  const scenes =
    tpdb.find((b) => /type=scene/i.test(b.endpoint)) ||
    tpdb.find((b) => !/[?&]type=/i.test(b.endpoint)) ||
    tpdb[0];

  return scenes ? scenes.endpoint : null;
}

/*
 * Borrow TPDB's token from Stash (one token covers stash-box and REST).
 * Never log or return it beyond the TPDB client.
 */
export async function tpdbToken(config) {
  const data = await gql(config, '{ configuration { general { stashBoxes { endpoint api_key } } } }');
  const boxes = data.configuration?.general?.stashBoxes || [];
  const hit = boxes.find((b) => /theporndb|metadataapi/i.test(b.endpoint || '') && b.api_key);
  return hit ? hit.api_key : null;
}

/*
 * StashDB's endpoint and token, borrowed from Stash. Never log or return
 * the token beyond the StashDB client.
 */
export async function stashdbEndpoint(config) {
  const data = await gql(config, '{ configuration { general { stashBoxes { endpoint } } } }');
  const boxes = data.configuration?.general?.stashBoxes || [];
  const hit = boxes.find((b) => /stashdb\.org/i.test(b.endpoint || ''));
  return hit ? hit.endpoint : null;
}

export async function stashdbToken(config) {
  const data = await gql(config, '{ configuration { general { stashBoxes { endpoint api_key } } } }');
  const boxes = data.configuration?.general?.stashBoxes || [];
  const hit = boxes.find((b) => /stashdb\.org/i.test(b.endpoint || '') && b.api_key);
  return hit ? hit.api_key : null;
}

/*
 * Which of these stash-box ids are in the library, exact only.
 * -> Map<id (lowercased), stash scene>.
 */
export async function ownedByStashIds(config, endpoint, ids) {
  const owned = new Map();
  if (!endpoint || !ids.length) return owned;

  const wanted = new Set(ids.map((id) => String(id).toLowerCase()));

  for (let i = 0; i < ids.length; i += CHUNK) {
    const hits = await byStashIds(config, endpoint, ids.slice(i, i + CHUNK));
    for (const hit of hits) {
      for (const sid of hit.stash_ids || []) {
        const key = String(sid.stash_id).toLowerCase();
        if (wanted.has(key) && !owned.has(key)) {
          owned.set(key, { id: hit.id, title: hit.title, date: hit.date, path: hit.files?.[0]?.path || null });
        }
      }
    }
  }

  return owned;
}

async function findScenes(config, filter) {
  const query =
    `query($f: SceneFilterType) { findScenes(scene_filter: $f, filter: {per_page: -1}) { count scenes { ${SCENE_FIELDS} } } }`;
  const data = await gql(config, query, { f: filter });
  return data.findScenes.scenes;
}

async function byStashIds(config, endpoint, guids) {
  try {
    // EQUALS with a list ORs the ids together, which is the batch lookup we
    // want. INCLUDES is rejected outright by this criterion.
    return await findScenes(config, {
      stash_ids_endpoint: { endpoint, stash_ids: guids, modifier: 'EQUALS' },
    });
  } catch (err) {
    // Older Stash only has the singular filter; fall back to one call per id.
    if (guids.length === 1) {
      return findScenes(config, {
        stash_id_endpoint: { endpoint, stash_id: guids[0], modifier: 'EQUALS' },
      });
    }
    throw err;
  }
}

/*
 * Which scenes of one site are in Stash.
 * Returns Map<tpdbSceneId, {match: 'exact'|'probable', scene}>.
 */
export async function matchScenes(config, scenes) {
  const found = new Map();
  const endpoint = await tpdbEndpoint(config);

  if (endpoint) {
    const guids = scenes.map((s) => s.guid).filter(Boolean);
    const byGuid = new Map(scenes.filter((s) => s.guid).map((s) => [s.guid.toLowerCase(), s.id]));

    for (let i = 0; i < guids.length; i += CHUNK) {
      const hits = await byStashIds(config, endpoint, guids.slice(i, i + CHUNK));
      for (const hit of hits) {
        for (const sid of hit.stash_ids || []) {
          const sceneId = byGuid.get(String(sid.stash_id).toLowerCase());
          if (sceneId !== undefined && !found.has(sceneId)) {
            found.set(sceneId, { match: 'exact', scene: hit, via: 'TPDB stash id' });
          }
        }
      }
    }
  }

  // Anything still unaccounted for: try title + date in one pass over the
  // library's scenes for these dates.
  const remaining = scenes.filter((s) => !found.has(s.id) && s.title && s.date);
  if (remaining.length) {
    const dates = [...new Set(remaining.map((s) => s.date))].sort();
    const candidates = await findScenes(config, {
      date: { value: dates[0], value2: dates[dates.length - 1], modifier: 'BETWEEN' },
    });

    const index = new Map();
    for (const c of candidates) {
      if (!c.title || !c.date) continue;
      index.set(normalise(c.title) + '|' + c.date, c);
    }

    for (const scene of remaining) {
      const hit = index.get(normalise(scene.title) + '|' + scene.date);
      if (hit) found.set(scene.id, { match: 'probable', scene: hit, via: 'title + date' });
    }
  }

  return { endpoint, found };
}

function normalise(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* Performers worth following: favourites, else most scenes. TPDB id required. */
/*
 * The library's cast with every stash-box id they have. Neither is
 * required: TPDB features use one, the StashDB search the other.
 */
async function libraryCast(config) {
  const data = await gql(
    config,
    `{ findPerformers(filter: {per_page: -1}) { performers { id name favorite scene_count stash_ids { endpoint stash_id } } } }`
  );

  const usable = [];
  for (const p of data.findPerformers.performers || []) {
    const boxes = p.stash_ids || [];
    const tpdb = boxes.find((s) => /theporndb|metadataapi/i.test(s.endpoint));
    const stashdb = boxes.find((s) => /stashdb\.org/i.test(s.endpoint));
    if (!tpdb && !stashdb) continue;

    usable.push({
      id: p.id,
      name: p.name,
      favorite: p.favorite,
      count: p.scene_count || 0,
      uuid: tpdb?.stash_id || null,
      stashdbId: stashdb?.stash_id || null,
    });
  }
  return usable;
}

// The TPDB feed can only ask about performers TPDB has a uuid for.
const tpdbPerformers = async (config) => (await libraryCast(config)).filter((p) => p.uuid);

export async function followedPerformers(config, { limit = 25 } = {}) {
  const usable = await tpdbPerformers(config);

  const favourites = usable.filter((p) => p.favorite);
  const pool = favourites.length ? favourites : usable;

  return pool.sort((a, b) => b.count - a.count).slice(0, limit);
}

/* Everyone, for the Creators page. Favourites first, then most held. */
/* -> {performers, total}. */
export async function libraryPerformers(config, { limit = 500 } = {}) {
  const usable = await libraryCast(config);

  const ranked = usable
    // Skip performers with no scenes.
    .filter((p) => p.count > 0)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.count - a.count || a.name.localeCompare(b.name));

  return { performers: ranked.slice(0, limit), total: ranked.length };
}

/*
 * ------------------------------------------------------------------ groups
 *
 * A Stash group (movie) has no stash_ids and no fingerprints. Only name,
 * date and URL remain, so matches are weak. The movie page answers scene by scene.
 */

const GROUP_TTL = 5 * 60 * 1000;
let groupCache = null;

export function forgetGroups() {
  groupCache = null;
}

export async function groupIndex(config, { force = false } = {}) {
  if (!force && groupCache && Date.now() - groupCache.at < GROUP_TTL) return groupCache.index;

  const data = await gql(
    config,
    '{ findGroups(filter: {per_page: -1}) { groups { id name date urls scene_count } } }'
  );

  const bySlug = new Map();
  const byTitleDate = new Map();
  const byTitle = new Map();

  for (const group of data.findGroups.groups || []) {
    if (!group.name) continue;
    const brief = { id: group.id, name: group.name, date: group.date || null, scenes: group.scene_count || 0 };

    for (const url of group.urls || []) {
      const slug = String(url).match(/theporndb\.net\/movies\/([^/?#]+)/i);
      if (slug) bySlug.set(slug[1].toLowerCase(), brief);
    }

    const key = normalise(group.name);
    if (!byTitle.has(key)) byTitle.set(key, brief);
    if (group.date && !byTitleDate.has(key + '|' + group.date)) byTitleDate.set(key + '|' + group.date, brief);
  }

  const index = { bySlug, byTitleDate, byTitle };
  groupCache = { index, at: Date.now() };
  return index;
}

/*
 * -> {match, group, via} or null. A TPDB movie URL is exact; a title is at
 * best probable.
 */
export function matchGroup(index, movie) {
  const slug = movie.url ? String(movie.url).match(/\/movies\/([^/?#]+)/) : null;
  const exact = slug ? index.bySlug.get(slug[1].toLowerCase()) : null;
  if (exact) return { match: 'exact', group: exact, via: 'TPDB movie link' };

  if (!movie.title) return null;
  const key = normalise(movie.title);

  const dated = movie.date ? index.byTitleDate.get(key + '|' + movie.date) : null;
  if (dated) return { match: 'probable', group: dated, via: 'title + date' };

  const named = index.byTitle.get(key);
  return named ? { match: 'probable', group: named, via: 'title' } : null;
}

/*
 * ------------------------------------------------------------ fingerprints
 *
 * TPDB's PHASH and OSHASH against Stash's, independent of naming. The whole
 * library's fingerprints in one query, matched in memory.
 */

const FINGERPRINT_TTL = 5 * 60 * 1000;
const MAX_DISTANCE = 8; // beyond this, phashes stop meaning much

let fingerprintCache = null;

export async function fingerprintIndex(config, { force = false } = {}) {
  if (!force && fingerprintCache && Date.now() - fingerprintCache.at < FINGERPRINT_TTL) {
    return fingerprintCache.index;
  }

  const data = await gql(
    config,
    '{ findScenes(filter: {per_page: -1}) { scenes { id title date files { path fingerprints { type value } } } } }'
  );

  const byOshash = new Map();
  const byPhash = new Map();
  const phashes = []; // for distance comparison

  for (const scene of data.findScenes.scenes) {
    const brief = { id: scene.id, title: scene.title, date: scene.date, path: scene.files?.[0]?.path || null };

    for (const file of scene.files || []) {
      for (const { type, value } of file.fingerprints || []) {
        if (!value) continue;
        const kind = String(type).toLowerCase();

        if (kind === 'oshash') {
          if (!byOshash.has(value)) byOshash.set(value, brief);
        } else if (kind === 'phash') {
          if (!byPhash.has(value)) byPhash.set(value, brief);
          const bits = splitHash(value);
          if (bits) phashes.push({ hi: bits.hi, lo: bits.lo, scene: brief });
        }
      }
    }
  }

  const index = { byOshash, byPhash, phashes };
  fingerprintCache = { index, at: Date.now() };
  return index;
}

export function forgetFingerprints() {
  fingerprintCache = null;
}

function splitHash(hex) {
  const clean = String(hex).trim();
  if (!/^[0-9a-f]{16}$/i.test(clean)) return null;
  return { hi: parseInt(clean.slice(0, 8), 16), lo: parseInt(clean.slice(8), 16) };
}

function popcount(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/*
 * -> {match: 'exact'|'probable', scene, via} or null.
 * oshash = same file; phash = same frames; a small phash distance is
 * probable, with the distance recorded.
 */
export function matchByFingerprints(index, { phashes = [], oshashes = [] }) {
  for (const hash of oshashes) {
    const hit = index.byOshash.get(hash);
    if (hit) return { match: 'exact', scene: hit, via: 'oshash' };
  }

  for (const hash of phashes) {
    const hit = index.byPhash.get(hash);
    if (hit) return { match: 'exact', scene: hit, via: 'phash' };
  }

  let best = null;
  for (const hash of phashes) {
    const bits = splitHash(hash);
    if (!bits) continue;

    for (const candidate of index.phashes) {
      const distance = popcount(bits.hi ^ candidate.hi) + popcount(bits.lo ^ candidate.lo);
      if (distance <= MAX_DISTANCE && (!best || distance < best.distance)) {
        best = { distance, scene: candidate.scene };
        if (distance === 0) break;
      }
    }
  }

  return best ? { match: 'probable', scene: best.scene, via: `phash distance ${best.distance}` } : null;
}

/*
 * ------------------------------------------------------- title and date
 *
 * For scenes identified against TPDB instead of StashDB. Counts as held,
 * labelled `probable`. One query, indexed in memory.
 */

const TITLE_TTL = 5 * 60 * 1000;
let titleCache = null;

export function forgetTitles() {
  titleCache = null;
}

export async function titleDateIndex(config, { force = false } = {}) {
  if (!force && titleCache && Date.now() - titleCache.at < TITLE_TTL) return titleCache.index;

  const data = await gql(
    config,
    '{ findScenes(filter: {per_page: -1}) { scenes { id title date files { path } } } }'
  );

  const index = new Map();
  for (const scene of data.findScenes.scenes) {
    if (!scene.title || !scene.date) continue;
    const key = normalise(scene.title) + '|' + scene.date;
    if (!index.has(key)) {
      index.set(key, { id: scene.id, title: scene.title, date: scene.date, path: scene.files?.[0]?.path || null });
    }
  }

  titleCache = { index, at: Date.now() };
  return index;
}

// One scene against that index. Titles differ in punctuation between catalogues
// far more often than in words, so both sides are normalised the same way.
export function matchByTitleDate(index, { title, date }) {
  if (!index || !title || !date) return null;
  return index.get(normalise(title) + '|' + date) || null;
}
