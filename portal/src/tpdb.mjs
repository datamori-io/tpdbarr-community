/*
 * ThePornDB's own API — the only source of scene artwork.
 *
 * The free Whisparr metadata mirror carries no per-scene images (verified: the
 * /site and /scene endpoints both return Images: null), so posters, stills and
 * fingerprints have to come from TPDB directly, which needs a token.
 *
 * The token is borrowed from Stash, which already stores one for TPDB's
 * stash-box. Nothing to paste, and it never leaves this machine except back to
 * TPDB itself.
 *
 * Fetching is slow — 100 scenes per page, several seconds each — so a whole
 * site is pulled once in the background and cached. Callers get whatever has
 * arrived so far and ask again.
 */

import { tpdbToken, fingerprintIndex, matchByFingerprints } from './stash.mjs';
import { stashConfigured } from './config.mjs';

const API = 'https://api.theporndb.net';
const PER_PAGE = 100; // 200 is rejected with a 422
const TTL = 24 * 60 * 60 * 1000;

const jobs = new Map(); // siteId -> {art: Map, fetched, total, done, error, at}
let tokenPromise = null;

export function forgetToken() {
  tokenPromise = null;
}

async function token(config) {
  if (!stashConfigured(config)) return null;

  if (!tokenPromise) {
    tokenPromise = tpdbToken(config)
      .catch((err) => {
        console.warn('[tpdbarr] could not read the TPDB token from Stash:', err.message);
        return null;
      })
      .then((value) => {
        /*
         * Only a token worth having is remembered. Caching the failure instead
         * meant that one slow moment from Stash — a restart, a busy scan — took
         * ThePornDB out until this process was restarted, long after Stash was
         * fine again. Forgetting a null costs one extra request; keeping one
         * costs the whole feature.
         */
        if (!value) tokenPromise = null;
        return value;
      });
  }

  return tokenPromise;
}

export async function available(config) {
  return Boolean(await token(config));
}

/*
 * Scenes and movies are shaped differently on TPDB, and it matters for layout:
 *
 *   scene  background.large  1500x1085   landscape
 *   scene  image             16:9        the studio's own still
 *   scene  poster            800x1200    a portrait crop TPDB generates
 *   movie  every field       ~0.71:1     a normal movie poster
 *
 * So `image` is the one to show for a scene, and `poster` for a movie. Both are
 * carried so either can be rendered without another round trip.
 */
function mapScene(raw) {
  const hashes = (raw.hashes || []).filter((h) => h.hash);
  const isMovie = /movie/i.test(raw.type || '');

  const landscape =
    raw.background?.large || raw.background?.full || raw.image || raw.back_image || null;

  return {
    title: raw.title || '',
    isMovie,
    // What to actually render: landscape for scenes, the poster for movies.
    image: isMovie ? raw.poster || raw.image || landscape : landscape || raw.poster,
    poster: raw.poster || null,
    still: raw.image || raw.back_image || null,
    background: raw.background?.medium || raw.background?.large || raw.background?.full || null,
    duration: raw.duration || null, // seconds, exact
    description: raw.description || '',
    tags: (raw.tags || []).map((t) => t.name).filter(Boolean).slice(0, 12),
    url: raw.url || null,
    phashes: hashes.filter((h) => h.type === 'PHASH').map((h) => h.hash),
    oshashes: hashes.filter((h) => h.type === 'OSHASH').map((h) => h.hash),
  };
}

async function fetchPage(auth, siteId, page) {
  const res = await fetch(`${API}/scenes?site_id=${siteId}&per_page=${PER_PAGE}&page=${page}`, {
    headers: { Authorization: `Bearer ${auth}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`TPDB /scenes page ${page} -> ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------- discovery
 *
 * TPDB's global feed is overwhelmingly clip-site content — 82 of the newest 100
 * scenes came from ManyVids alone — and those performers are rarely linked to a
 * parent record, so their gender is unknown. Both facts drive the filtering
 * below.
 */

const CLIP_NETWORKS =
  /manyvids|fansdb|onlyfans|fansly|justforfans|loyalfans|iwantclips|i want clips|clips4sale|clips 4 sale|chaturbate|myfreecams|stripchat|avn stars|modelhub|pornhub|xvideos|xhamster|anal vids|globe twatters/i;

export function isClipSite(scene) {
  const site = scene.site?.name || '';
  const network = scene.site?.network?.name || scene.site?.parent?.name || '';

  if (CLIP_NETWORKS.test(network) || CLIP_NETWORKS.test(site)) return true;

  /*
   * Per-performer storefronts are named "Network: Someone" — "ManyVids: Latika
   * Jha", "HobbyPorn: Miniblondie", "I Want Clips: Vixenmegan123". One rule
   * catches the whole shape, including networks not on the list above.
   */
  return /^[^:]{2,30}:\s+\S/.test(site);
}

// Gender lives on the linked parent performer; unlinked aliases have none.
const genderOf = (p) => p.parent?.extras?.gender || p.extras?.gender || null;

export function shapeOf(scene) {
  let female = 0;
  let male = 0;
  let other = 0;
  let unknown = 0;

  for (const p of scene.performers || []) {
    const gender = genderOf(p);
    if (!gender) unknown++;
    else if (/^female$/i.test(gender)) female++;
    else if (/^male$/i.test(gender)) male++;
    else other++;
  }

  if (other) return 'other';
  if (unknown) return 'unknown';
  if (female >= 1 && male >= 1) return 'straight';
  if (female >= 2 && male === 0) return 'lesbian';
  if (female === 1 && male === 0) return 'solo';
  if (male >= 1 && female === 0) return 'male';
  return 'unknown';
}

const WANTED_SHAPES = new Set(['straight', 'lesbian', 'solo']);
export const isWantedShape = (scene) => WANTED_SHAPES.has(shapeOf(scene));

/*
 * Rate limiting, and why it is a gate rather than a retry.
 *
 * ThePornDB answers 429 when it has had enough, and it has had enough sooner
 * than anything here assumed: a Group Builder pass asking about 552 films
 * through a pool of six collected **313 of them** in one run, each one a film
 * silently dropped from the scan. A per-call retry would not have helped much —
 * six workers each discovering the limit separately just means six more
 * requests into a server already saying stop.
 *
 * So the cooldown is shared. The first 429 sets a time nobody may fetch before,
 * and every worker waits on it, so the whole app backs off together and comes
 * back once. `Retry-After` is obeyed when the server sends one, because a
 * number it chose is better than a number this file guessed.
 */
const RETRY_AFTER = 5000;
const MAX_COOLDOWN = 60000;
const TRIES = 4;

let cooldownUntil = 0;

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(auth, path) {
  for (let attempt = 1; ; attempt++) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await nap(wait);

    const res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(60000),
    });

    if (res.status !== 429) {
      if (!res.ok) throw new Error(`TPDB ${path} -> ${res.status}`);
      return res.json();
    }

    if (attempt >= TRIES) throw new Error(`TPDB ${path} -> 429 after ${TRIES} tries`);

    // Doubling per attempt, so a limit that is not lifting is not hammered.
    const told = Number(res.headers.get('retry-after')) * 1000;
    const back = Math.min(told > 0 ? told : RETRY_AFTER * attempt, MAX_COOLDOWN);
    const until = Date.now() + back;

    /*
     * Said out loud, once per cooldown rather than once per waiting worker.
     *
     * A gate that backs off silently is a gate that looks like a hang: the
     * first version of this handled 429s perfectly and the only symptom left
     * was a progress counter that stopped moving for minutes with nothing in
     * the log to explain it.
     */
    if (until > cooldownUntil) {
      console.warn(`[tpdbarr] TPDB asked for a pause — backing off ${Math.round(back / 1000)}s`);
      cooldownUntil = until;
    }
  }
}

// A scene as the home page shows it.
export function toCard(raw) {
  const art = mapScene(raw);
  return {
    id: Number(raw._id),
    guid: raw.id || null,
    title: raw.title || '(untitled)',
    date: raw.date || '',
    siteId: raw.site?.id ?? raw.site_id ?? null,
    siteName: raw.site?.name || '',
    network: raw.site?.network?.name || '',
    shape: shapeOf(raw),
    /*
     * The parent is the canonical performer; the bare id is a site-specific
     * alias record, and TPDB's performer endpoints are keyed on the parent.
     */
    performers: (raw.performers || []).map((p) => ({ name: p.name, uuid: p.parent?.id || p.id || null })),
    url: raw.slug ? `https://theporndb.net/scenes/${raw.slug}` : null,
    image: art.image,
    isMovie: art.isMovie,
    poster: art.poster,
    still: art.still,
    duration: art.duration ? Math.round(art.duration / 60) : null,
    tags: art.tags,
    phashes: art.phashes,
    oshashes: art.oshashes,
  };
}

export async function recentGlobal(config, { pages = 6, limit = 24 } = {}) {
  const auth = await token(config);
  if (!auth) return [];

  const out = [];
  for (let page = 1; page <= pages && out.length < limit; page++) {
    const payload = await get(auth, `/scenes?per_page=100&page=${page}`);
    for (const scene of payload.data || []) {
      if (isClipSite(scene) || !isWantedShape(scene)) continue;
      out.push(toCard(scene));
      if (out.length >= limit) break;
    }
    if ((payload.meta?.last_page ?? page) <= page) break;
  }
  return out;
}

export async function recentForSite(config, siteId, { limit = 8 } = {}) {
  const auth = await token(config);
  if (!auth) return [];
  const payload = await get(auth, `/scenes?site_id=${siteId}&per_page=${limit}`);
  return (payload.data || []).map(toCard);
}

export async function recentForPerformer(config, performerUuid, { limit = 8 } = {}) {
  const auth = await token(config);
  if (!auth) return [];
  const payload = await get(auth, `/performers/${performerUuid}/scenes?per_page=${limit}`);
  return (payload.data || []).filter(isWantedShape).map(toCard);
}

/* ------------------------------------------------------- one of a thing
 *
 * The detail pages. Both need a TPDB token, which is borrowed from Stash — so
 * both say so plainly rather than rendering an empty page.
 */

export class NoTokenError extends Error {}

async function requireToken(config) {
  const auth = await token(config);
  if (!auth) {
    throw new NoTokenError(
      'This page needs ThePornDB, and the portal borrows that token from Stash. Connect Stash in Settings.'
    );
  }
  return auth;
}

export async function getScene(config, guid) {
  const auth = await requireToken(config);
  const { data } = await get(auth, `/scenes/${encodeURIComponent(guid)}`);
  if (!data) return null;

  const art = mapScene(data);
  return {
    ...toCard(data),
    overview: art.description,
    background: art.background,
    trailer: data.trailer || null,
    directors: (data.directors || []).map((d) => d.name).filter(Boolean),
  };
}

export async function getPerformer(config, uuid) {
  const auth = await requireToken(config);
  const { data } = await get(auth, `/performers/${encodeURIComponent(uuid)}`);
  if (!data) return null;

  const extras = data.extras || {};
  const career = [extras.career_start_year, extras.career_end_year].filter(Boolean).join(' – ');

  return {
    uuid: data.id,
    name: data.name,
    disambiguation: data.disambiguation || '',
    bio: data.bio || '',
    aliases: data.aliases || [],
    image: data.image || data.thumbnail || data.face || null,
    url: data.slug ? `https://theporndb.net/performers/${data.slug}` : null,
    // Only the fields TPDB actually filled in; the rest would just be blanks.
    facts: [
      ['Gender', extras.gender],
      ['Born', extras.birthday],
      ['Birthplace', extras.birthplace],
      ['Ethnicity', extras.ethnicity],
      ['Nationality', extras.nationality],
      ['Height', extras.height],
      ['Measurements', extras.measurements],
      ['Hair', extras.hair_colour],
      ['Eyes', extras.eye_colour],
      ['Career', career],
    ].filter(([, value]) => value),
  };
}

/*
 * Everything a performer is in, newest first. Deliberately unfiltered — the
 * shape filter exists to clean up a discovery feed, and you are on this page
 * because you asked for this person specifically.
 */
export async function performerScenes(config, uuid, { pages = 3, limit = 60 } = {}) {
  const auth = await requireToken(config);
  const out = [];

  for (let page = 1; page <= pages && out.length < limit; page++) {
    const payload = await get(auth, `/performers/${encodeURIComponent(uuid)}/scenes?per_page=100&page=${page}`);
    for (const raw of payload.data || []) {
      out.push(toCard(raw));
      if (out.length >= limit) break;
    }
    if ((payload.meta?.last_page ?? page) <= page) break;
  }

  return out;
}

/* ------------------------------------------------------- images, in full
 *
 * Everything TPDB carries, for building a gallery rather than drawing a card.
 * mapScene() picks the one image a card should show; these two hand back all
 * of them, biggest and most original first.
 *
 * Order matters, because the first few are the ones worth keeping. A scene's
 * `image` is the studio's own still and `background.full` is the uncropped
 * original; the `poster` fields are crops TPDB generates from that background,
 * upscaled and stamped with the site's logo — real images, but the same
 * picture again with a watermark on it. So they go last and say what they are.
 */

const seen = () => {
  const urls = new Set();
  return (url) => {
    if (!url || urls.has(url)) return false;
    urls.add(url);
    return true;
  };
};

export async function sceneImages(config, guid) {
  const auth = await requireToken(config);
  const { data } = await get(auth, `/scenes/${encodeURIComponent(guid)}`);
  if (!data) return null;

  const fresh = seen();
  const out = [];
  const add = (url, kind) => { if (fresh(url)) out.push({ url, kind }); };

  add(data.image, 'still');
  add(data.back_image, 'back');
  add(data.background?.full, 'background');
  add(data.background?.large, 'background');
  add(data.background_back?.full, 'background back');
  add(data.poster_image, 'poster');
  add(data.poster, 'poster crop');
  add(data.posters?.full, 'poster crop');

  return {
    title: data.title || '',
    date: data.date || '',
    site: data.site?.name || '',
    performers: (data.performers || []).map((p) => p.name).filter(Boolean),
    images: out,
  };
}

export async function performerImages(config, uuid) {
  const auth = await requireToken(config);
  const { data } = await get(auth, `/performers/${encodeURIComponent(uuid)}`);
  if (!data) return null;

  const fresh = seen();
  const out = [];

  // posters is the real set — 133 of them for a performer this size — and it
  // arrives biggest first, which is the order to keep.
  for (const poster of data.posters || []) {
    if (fresh(poster.url)) out.push({ url: poster.url, kind: 'poster', size: poster.size || null });
  }
  if (fresh(data.image)) out.push({ url: data.image, kind: 'poster' });

  return { title: data.name || '', date: '', site: '', performers: [data.name].filter(Boolean), images: out };
}

/* --------------------------------------------------------------- movies
 *
 * A TPDB movie is a bundle of scenes with a poster on the front — a DVD, or a
 * studio's feature release. Whisparr v2 is scene-shaped and cannot add one, so
 * a movie here is a way *into* its scenes rather than a thing you buy: the
 * grid says whether you already hold it, and the movie page adds the scenes
 * you are missing one at a time.
 *
 * The shape filter is deliberately not applied. It exists to make a feed of
 * two thousand clips readable; a feature release has a large unlinked cast and
 * would fail it almost every time.
 */

export function toMovie(raw) {
  return {
    id: Number(raw._id) || null,
    guid: raw.id || null,
    title: raw.title || '(untitled)',
    date: raw.date || '',
    siteId: raw.site?.id ?? raw.site_id ?? null,
    siteName: raw.site?.name || '',
    network: raw.site?.network?.name || '',
    /*
     * A movie's only portrait art is the studio's own box art, in `image`.
     * `poster` and `posters` both hand back the landscape background again —
     * checked, byte-for-byte the same URLs — so a release with no box art gets
     * that landscape cropped into the poster frame instead.
     */
    poster: raw.image || null,
    background: raw.background?.large || raw.background?.full || raw.poster || null,
    duration: raw.duration ? Math.round(raw.duration / 60) : null,
    performers: (raw.performers || []).map((p) => ({ name: p.name, uuid: p.parent?.id || p.id || null })),
    url: raw.slug ? `https://theporndb.net/movies/${raw.slug}` : null,
    sceneCount: Array.isArray(raw.scenes) ? raw.scenes.length : null,
    /*
     * The list endpoint sends these too, and that is worth more than it looks:
     * a caller that can judge a release from the roster row does not have to
     * fetch three thousand movie records to find the forty worth reading. Only
     * `scenes` needs the detail call. An array when TPDB has no links for a
     * record, an object when it does, so it is normalised here.
     */
    links: raw.links && !Array.isArray(raw.links) ? raw.links : {},
    sku: raw.sku || null,
    overview: raw.description || '',
    directors: (raw.directors || []).map((d) => d.name).filter(Boolean),
  };
}

export async function recentMovies(config, { pages = 4, limit = 48 } = {}) {
  const auth = await token(config);
  if (!auth) return [];

  const out = [];
  for (let page = 1; page <= pages && out.length < limit; page++) {
    const payload = await get(auth, `/movies?per_page=100&page=${page}`);
    for (const raw of payload.data || []) {
      if (isClipSite(raw)) continue;
      out.push(toMovie(raw));
      if (out.length >= limit) break;
    }
    if ((payload.meta?.last_page ?? page) <= page) break;
  }
  return out;
}

/*
 * Movies by name. Used by the gap-filler, where the only thing known about a
 * film is the folder it sits in — so the query is a title someone typed years
 * ago and the answer needs looking at before it is believed.
 */
export async function searchMovies(config, query, { limit = 8 } = {}) {
  const auth = await requireToken(config);
  if (!query || !query.trim()) return [];

  const payload = await get(auth, `/movies?q=${encodeURIComponent(query.trim())}&per_page=${limit}`);
  return (payload.data || []).map(toMovie);
}

/*
 * The movie catalogue, searched and read deep enough to be sorted.
 *
 * searchMovies above answers a different question — the gap-filler wants the
 * best few matches for a folder name and stops there. This one is for browsing:
 * ordering six hundred results by studio only means anything if all six hundred
 * were read, so it pages until it has them or hits the cap, and says which
 * happened rather than quietly sorting a slice.
 *
 * "adam and eve" returns 566 across six pages; "adam & eve" returns 2413 across
 * twenty-five, which is why there is a cap at all.
 */
export async function searchMovieCatalogue(config, query, { cap = 600 } = {}) {
  const auth = await requireToken(config);
  const term = String(query || '').trim();
  if (!term) return { movies: [], total: 0, capped: false };

  const out = [];
  let total = 0;

  for (let page = 1; out.length < cap; page++) {
    const payload = await get(auth, `/movies?q=${encodeURIComponent(term)}&per_page=${PER_PAGE}&page=${page}`);
    total = payload.meta?.total ?? out.length;

    for (const raw of payload.data || []) out.push(toMovie(raw));
    if ((payload.meta?.last_page ?? page) <= page) break;
  }

  return { movies: out.slice(0, cap), total, capped: total > cap };
}

/*
 * Every movie a site has put out, rather than the newest slice of everything.
 *
 * The movie feed above is a river and the search is a name; neither can answer
 * "what has this studio released", which is the only question the Group Builder
 * asks. `site_id` is the same id a scene carries in `site.id`, so a studio in
 * Stash gets one only by way of a scene it holds — there is no name lookup for
 * a site, and guessing one from a title would put another studio's back
 * catalogue on the shelf.
 *
 * `since` is the reason this is usable at all. New Sensations has 3,629 movies
 * and the feed comes back newest first, so a caller that only cares about films
 * old enough to contain the scenes it holds can stop paging instead of reading
 * thirty-seven pages at eight seconds each. Paging stops on the first page
 * where nothing is newer than the bound — one page of slack, because a feed
 * ordered by release date still has the odd record out of sequence.
 *
 * -> {movies, total, capped, read}. Pure Taboo alone is 291 and New Sensations
 * is ten times that, which is why the cap exists and why the caller is told
 * both what it bit and how much of the catalogue was actually read.
 */
// Three, for the reason the rate-limit gate above exists: six was enough to be
// told no three hundred times in one pass.
const PAGES_AT_A_TIME = 3;

export async function moviesForSite(config, siteId, { cap = 2000, since = null, onPage = null } = {}) {
  const auth = await requireToken(config);
  const id = Number(siteId);
  if (!id) return { movies: [], total: 0, capped: false, read: 0 };

  const page = (n) => get(auth, `/movies?site_id=${id}&per_page=${PER_PAGE}&page=${n}`);

  const first = await page(1);
  const total = first.meta?.total ?? (first.data || []).length;
  const lastPage = first.meta?.last_page ?? 1;

  const out = (first.data || []).map(toMovie);
  let read = (first.data || []).length;
  onPage?.(1, lastPage);

  /*
   * Six pages at a time, and the reason is measured rather than assumed: a
   * single page takes ThePornDB about eight seconds whatever is on it, so New
   * Sensations' thirty-seven pages is five minutes read one after another and
   * under a minute read six at a time. The site's own scene reader upstairs
   * uses the same width.
   *
   * Batched rather than fully parallel so `since` still stops the read. The
   * feed is newest first, so once a whole batch is older than the bound there
   * is nothing behind it worth having — and a batch is small enough that
   * overshooting costs one round rather than the rest of the catalogue.
   */
  for (let next = 2; next <= lastPage && out.length < cap;) {
    const batch = [];
    for (let n = next; n < next + PAGES_AT_A_TIME && n <= lastPage; n++) batch.push(n);

    const payloads = await Promise.all(batch.map((n) => page(n).catch(() => null)));
    let stop = false;

    for (const payload of payloads) {
      const rows = payload?.data || [];
      read += rows.length;
      for (const raw of rows) out.push(toMovie(raw));
      if (since && rows.length && rows.every((raw) => raw.date && raw.date < since)) stop = true;
    }

    next += batch.length;
    onPage?.(Math.min(next - 1, lastPage), lastPage);
    if (stop) break;
  }

  return { movies: out.slice(0, cap), total, capped: out.length > cap, read };
}

export async function getMovie(config, guid) {
  const auth = await requireToken(config);
  const { data } = await get(auth, `/movies/${encodeURIComponent(guid)}`);
  if (!data) return null;

  return {
    ...toMovie(data),
    overview: data.description || '',
    directors: (data.directors || []).map((d) => d.name).filter(Boolean),
    tags: (data.tags || []).map((t) => t.name).filter(Boolean).slice(0, 12),
    scenes: (data.scenes || []).map(toCard),
    /*
     * Where else this release is written down: AdultEmpire, IAFD, AFDB,
     * Excalibur — whichever TPDB happens to hold. Two things want it. The
     * AdultEmpire address is what a built group carries so Stash's own scraper
     * can fill it in later, and the IAFD one saves a title search that would
     * otherwise be a guess between seventeen films with the same name.
     *
     * An array on a record TPDB has no links for, an object when it does, so
     * it is normalised here rather than at every reader.
     */
    links: data.links && !Array.isArray(data.links) ? data.links : {},
    sku: data.sku || null,
  };
}

/*
 * A performer's whole catalogue, not just the front of it.
 *
 * performerScenes() above deliberately reads a page or two, because the pages
 * that use it want "what have they been in lately". Asking "what am I missing
 * of theirs" is a different question and the newest slice cannot answer it: a
 * library built out of a studio's back catalogue overlaps the newest sixty
 * scenes almost nowhere, so a gap counted against that window comes back as
 * "all of them" every time.
 *
 * -> {scenes, total, complete}. `complete` is false when TPDB has more pages
 * than the budget allowed, so the caller can say so rather than implying it
 * counted everything.
 */
export async function performerCatalogue(config, uuid, { maxPages = 8 } = {}) {
  const auth = await requireToken(config);
  const out = [];
  let total = null;
  let complete = true;

  for (let page = 1; page <= maxPages; page++) {
    const payload = await get(auth, `/performers/${encodeURIComponent(uuid)}/scenes?per_page=100&page=${page}`);
    for (const raw of payload.data || []) out.push(toCard(raw));

    total = payload.meta?.total ?? total;
    const last = payload.meta?.last_page ?? page;
    if (last <= page) break;
    if (page === maxPages) complete = false;
  }

  return { scenes: out, total: total ?? out.length, complete };
}

// Kick off (or resume) the background pull for a site. Returns immediately.
export async function ensureArt(config, siteId) {
  const existing = jobs.get(siteId);
  if (existing && Date.now() - existing.at < TTL) return existing;

  const auth = await token(config);
  if (!auth) return null;

  const job = {
    art: new Map(),
    matches: new Map(), // sceneId -> fingerprint match against Stash
    fetched: 0,
    total: null,
    done: false,
    matching: false,
    error: null,
    at: Date.now(),
  };
  jobs.set(siteId, job);

  (async () => {
    try {
      for (let page = 1; ; page++) {
        const payload = await fetchPage(auth, siteId, page);
        for (const scene of payload.data || []) {
          // TPDB's "id" is the UUID; "_id" is the numeric id the metadata
          // mirror calls ForeignId, which is what the catalogue is keyed on.
          const numericId = Number(scene._id);
          if (Number.isFinite(numericId)) job.art.set(numericId, mapScene(scene));
        }
        job.fetched = job.art.size;
        job.total = payload.meta?.total ?? job.fetched;

        const lastPage = payload.meta?.last_page ?? page;
        if (page >= lastPage) break;
      }
    } catch (err) {
      job.error = err.message;
      console.warn('[tpdbarr] artwork fetch failed for site', siteId, '-', err.message);
    }

    // Fingerprints only arrive with the artwork, so this is the first moment
    // the strong Stash match can be attempted.
    try {
      job.matching = true;
      await matchAgainstStash(config, job);
    } catch (err) {
      console.warn('[tpdbarr] fingerprint matching failed for site', siteId, '-', err.message);
    } finally {
      job.matching = false;
      job.done = true;
    }
  })();

  return job;
}

async function matchAgainstStash(config, job) {
  if (!stashConfigured(config)) return;

  const wanted = [...job.art.entries()].filter(
    ([, art]) => art.phashes.length || art.oshashes.length
  );
  if (!wanted.length) return;

  const index = await fingerprintIndex(config);

  for (const [sceneId, art] of wanted) {
    const hit = matchByFingerprints(index, art);
    if (hit) {
      job.matches.set(sceneId, {
        match: hit.match,
        via: hit.via,
        id: hit.scene.id,
        path: hit.scene.path,
        title: hit.scene.title || '',
      });
    }
  }

  dropCollisions(job);
}

/*
 * One file in Stash can only be one scene. TPDB sometimes carries the same
 * fingerprint against two scenes — a mis-submitted hash — which would otherwise
 * report both as held. Keep whichever scene the file actually looks like and
 * drop the rest, because wrongly saying "you already have this" means quietly
 * never fetching it.
 */
function dropCollisions(job) {
  const claimants = new Map(); // stash scene id -> [tpdb scene ids]

  for (const [sceneId, hit] of job.matches) {
    if (!claimants.has(hit.id)) claimants.set(hit.id, []);
    claimants.get(hit.id).push(sceneId);
  }

  for (const [, ids] of claimants) {
    if (ids.length < 2) continue;

    let best = null;
    for (const id of ids) {
      const hit = job.matches.get(id);
      const score = similarity(job.art.get(id)?.title || '', hit.title, hit.path);
      if (!best || score > best.score) best = { id, score };
    }

    for (const id of ids) {
      if (id !== best.id) job.matches.delete(id);
    }
  }
}

const flatten = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function similarity(tpdbTitle, stashTitle, stashPath) {
  const want = flatten(tpdbTitle);
  if (!want) return 0;

  const candidates = [flatten(stashTitle), flatten((stashPath || '').split(/[\\/]/).pop())];
  let best = 0;

  for (const have of candidates) {
    if (!have) continue;
    if (have === want) return 100;
    if (have.includes(want) || want.includes(have)) best = Math.max(best, 50);

    let common = 0;
    while (common < want.length && common < have.length && want[common] === have[common]) common++;
    best = Math.max(best, Math.round((common / want.length) * 40));
  }

  return best;
}

// Whatever has arrived so far.
export function artSnapshot(siteId) {
  const job = jobs.get(siteId);
  if (!job) return { art: new Map(), matches: new Map(), progress: null };
  return {
    art: job.art,
    matches: job.matches,
    progress: {
      fetched: job.fetched,
      total: job.total,
      done: job.done,
      matching: job.matching,
      matched: job.matches.size,
      error: job.error,
    },
  };
}

/* ------------------------------------------------------------- the wildcard
 *
 * StashDB is the catalogue the search is built on, because its ids survive the
 * whole trip into Stash. ThePornDB is the other question: is this thing on the
 * internet at all.
 *
 * So this is not a second set of results to merge — it is what you reach for
 * when the first search came back empty. Same standard of data, different
 * coverage, and a different route out (v2 rather than v3), which is why it is
 * kept visibly separate rather than blended in.
 */
export async function searchScenes(config, term, { limit = 24 } = {}) {
  const auth = await token(config);
  if (!auth) return [];

  const payload = await get(auth, `/scenes?q=${encodeURIComponent(term)}&per_page=${limit}`);
  return (payload.data || []).map(toCard);
}
