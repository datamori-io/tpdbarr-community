/*
 * Stash client — "do I already have this?"
 *
 * ThePornDB runs a stash-box endpoint, so a scene identified against TPDB in
 * Stash carries the TPDB scene UUID as a stash_id. That is the same UUID the
 * metadata service reports as ForeignGuid, which makes for an exact match.
 * Failing that, title + release date gives a probable one.
 */

const SCENE_FIELDS = 'id title date studio { name } stash_ids { endpoint stash_id } files { path }';
const CHUNK = 250;

export class StashError extends Error {}

/*
 * Stash keeps its library in SQLite, and a write holds the whole file — so
 * while a scan is running a perfectly good read comes back "database is
 * locked". It is over in a moment, and the alternative is a page that dies at
 * exactly the time you are most likely to be looking at it: just after a
 * gallery build, with the scan still finishing.
 *
 * Only this one message is retried. Everything else is a real answer.
 */
const LOCKED = /database is locked/i;
const RETRIES = 2;

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

  /*
   * TPDB is commonly configured twice, as ?type=Scene and ?type=Movie. The
   * endpoint string is stored verbatim on each stash_id, so we have to pick the
   * scene one — matching against the movie endpoint would find nothing.
   */
  const scenes =
    tpdb.find((b) => /type=scene/i.test(b.endpoint)) ||
    tpdb.find((b) => !/[?&]type=/i.test(b.endpoint)) ||
    tpdb[0];

  return scenes ? scenes.endpoint : null;
}

/*
 * Stash stores the API token for each stash-box it is configured with, and TPDB
 * uses one token for both its stash-box and its REST API. So if Stash is
 * connected we can borrow that rather than asking for the same token twice.
 * Never log or return this beyond the TPDB client.
 */
export async function tpdbToken(config) {
  const data = await gql(config, '{ configuration { general { stashBoxes { endpoint api_key } } } }');
  const boxes = data.configuration?.general?.stashBoxes || [];
  const hit = boxes.find((b) => /theporndb|metadataapi/i.test(b.endpoint || '') && b.api_key);
  return hit ? hit.api_key : null;
}

/*
 * The same pair again for StashDB, which is the other stash-box this library
 * was built against — and the one that decides what *should* be in it. Same
 * reasoning as the TPDB pair above: Stash already holds both the endpoint and
 * the token, so neither is asked for twice. Never log or return the token
 * beyond the StashDB client.
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
 * Which of these stash-box ids are already in the library.
 * -> Map<id (lowercased), stash scene>.
 *
 * matchScenes below answers the same question for a whole TPDB site and falls
 * back to title + date when it has to. This one is the exact half on its own,
 * for any endpoint: a StashDB search asking "do I have this" wants a yes it can
 * trust, and a probable is not that.
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
 * Given the scenes of one site, work out which are already in Stash.
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

/*
 * Performers worth following: the ones marked favourite, else the ones with the
 * most scenes in the library. Only those carrying a TPDB id are usable, since
 * that is what TPDB's performer endpoint is keyed on.
 */
/*
 * The library's cast, with whichever stash-box ids Stash has for each.
 *
 * Both are kept, and neither is required, because the two halves of this app
 * ask for different ones: ThePornDB's feed is keyed on its uuid, and the
 * acquisition search is keyed on StashDB's. Filtering to one of them here is
 * how a performer with twenty-five scenes on the shelf goes missing from a page
 * whose whole job is to list the people you collect.
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

/*
 * Everyone, for the Creators page — where the point is to browse the whole
 * cast of your library rather than to pick a handful worth polling. Favourites
 * lead, then whoever you have most of.
 */
/*
 * -> {performers, total}. Both, because the page shows a wall and a wall has a
 * limit: reporting the length of what came back as though it were the length of
 * the list is how a page quietly loses people off the end.
 */
export async function libraryPerformers(config, { limit = 500 } = {}) {
  const usable = await libraryCast(config);

  const ranked = usable
    // Stash keeps performer records with nothing attached — an identify run
    // that matched a name and no file. "0 in your library" is not someone in
    // your library, so they are left out rather than shown contradicting.
    .filter((p) => p.count > 0)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.count - a.count || a.name.localeCompare(b.name));

  return { performers: ranked.slice(0, limit), total: ranked.length };
}

/* ------------------------------------------------------------------ groups
 *
 * Stash calls a movie a group, and a group carries no stash_ids at all — the
 * field does not exist on the type (checked against 0.31.1). So unlike a
 * scene, a movie cannot be matched on a TPDB id, and there are no fingerprints
 * either: a group is a record about files, not a file.
 *
 * What is left is the name, the date and whatever URL identified it. That is
 * weak, and deliberately reported as such — the trustworthy answer to "do I
 * have this movie?" is scene by scene, on the movie page.
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
 * -> {match, group, via} or null.
 *
 * A TPDB movie URL on the group is the only exact claim available. After that
 * it is the title, which is why nothing below the URL comes back as anything
 * better than probable — a re-cut and a re-release share a name.
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

/* ------------------------------------------------------------ fingerprints
 *
 * The strongest match available. TPDB publishes PHASH and OSHASH per scene and
 * Stash stores the same kinds for every file, so the two can be compared
 * directly — regardless of how the scene is named or which stash-box it was
 * identified against.
 *
 * The whole library's fingerprints come back in one query (~0.5s for 1700
 * scenes), so matching happens in memory rather than one query per scene.
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
 *
 * oshash equality means the same file. phash equality means the same frames.
 * A small phash distance means the same scene at a different size or bitrate,
 * which is strong but not certain, so it lands as probable with the distance
 * recorded.
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

/* ------------------------------------------------------- title and date
 *
 * The other half of "do I have this". A stash id is the trustworthy answer,
 * but roughly a third of this library was identified against ThePornDB's
 * stash-box rather than StashDB's — so asking StashDB's ids alone reports
 * scenes as missing that are sitting on the disk under a TPDB id.
 *
 * Title and date together is weak evidence for one scene and decent evidence
 * across a catalogue, which is what coverage is. It lands as `probable` and is
 * counted as held, and every count that uses it says which of the two it was.
 *
 * The whole library comes back in one query and is indexed in memory, because
 * coverage asks this about several thousand scenes at once.
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
