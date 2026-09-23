/*
 * Whisparr v3 (Eros) client.
 *
 * The other half of the acquisition story. v2 is a Sonarr fork that takes TPDB;
 * v3 is a Radarr fork that takes StashDB and will not accept anything else
 * (Whisparr#515). They run side by side because each is the only way in for its
 * own stash-box, and most of this library arrived through v3.
 *
 * Both speak /api/v3 — that is the API version, not the app version, and it is
 * the same string on both. The instances are told apart by their own URL and
 * key, never by the path.
 *
 * Being a Radarr fork, v3 has no series/episode split: a scene IS a movie, and
 * `itemType` says which kind of movie it is. So the shapes are:
 *
 *   StashDB scene  ->  movie (movie.stashId = movie.foreignId = scene UUID)
 *   StashDB studio ->  studio (studio.foreignId)
 *   performer      ->  performer (performer.foreignId)
 *
 * None of that maps onto the v2 site->series / scene->episode mapping, which is
 * why this is a separate client rather than whisparr.mjs with a different URL.
 *
 * Shapes here come from the instance's own OpenAPI document, which it serves
 * unauthenticated at /docs/v3/openapi.json — worth re-reading rather than
 * guessing if any of this ever stops matching.
 */

export class Whisparr3Error extends Error {}

async function call(config, path, { method = 'GET', body = null } = {}) {
  if (!config.whisparr3Url || !config.whisparr3ApiKey) {
    throw new Whisparr3Error('Whisparr v3 is not configured');
  }

  const base = config.whisparr3Url.replace(/\/+$/, '');
  const res = await fetch(base + '/api/v3' + path, {
    method,
    headers: {
      Accept: 'application/json',
      'X-Api-Key': config.whisparr3ApiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      throw new Whisparr3Error(
        'Whisparr v3 rejected the API key. Copy it from Whisparr → Settings → General → API Key (32 hex characters).'
      );
    }
    throw new Whisparr3Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

export const systemStatus = (config) => call(config, '/system/status');
export const qualityProfiles = (config) => call(config, '/qualityprofile');
export const rootFolders = (config) => call(config, '/rootfolder');

/*
 * Is this actually a v3? Pointing the v3 fields at the v2 instance is the easy
 * mistake, and it fails much later and much less clearly than it should.
 */
export async function identify(config) {
  const status = await systemStatus(config);
  const major = parseInt(String(status.version || '0').split('.')[0], 10);
  return { version: status.version, isV3: major === 3, appName: status.appName || null };
}

// ------------------------------------------------------------------- reading

/*
 * -> the movie v3 holds for this StashDB scene, or null.
 *
 * v3 indexes on the stash id directly, so this is one call and no scanning.
 */
export async function findByStashId(config, stashId) {
  const found = await call(config, '/movie?stashId=' + encodeURIComponent(stashId));
  return Array.isArray(found) && found.length ? found[0] : null;
}

// What v3's metadata service knows about a scene, whether or not it is added.
export async function lookupScene(config, term) {
  const found = await call(
    config,
    '/movie/lookup?itemType=scene&term=' + encodeURIComponent(term)
  );
  return Array.isArray(found) ? found : [];
}

export const performerWorks = (config, foreignId) =>
  call(config, '/movie/listbyperformerforeignid?performerForeignId=' + encodeURIComponent(foreignId));

export const studioWorks = (config, foreignId) =>
  call(config, '/movie/listbystudioforeignid?studioForeignId=' + encodeURIComponent(foreignId));

export const queue = (config) => call(config, '/queue?pageSize=200&includeMovie=true');

/*
 * The state of one scene as far as v3 is concerned. Deliberately flat, because
 * this is what the scene page shows as a badge.
 *
 * "absent" is a real answer, not a failure: most of the library was downloaded
 * and then deleted from Whisparr on purpose, so v3 holding nothing for a scene
 * you own is the expected end state.
 */
export function statusOf(movie) {
  if (!movie) return { status: 'absent', movie: null };

  return {
    status: movie.hasFile ? 'downloaded' : movie.monitored ? 'monitored' : 'known',
    movieId: movie.id,
    title: movie.title,
    monitored: !!movie.monitored,
    hasFile: !!movie.hasFile,
    sizeOnDisk: movie.sizeOnDisk || 0,
    path: movie.path || null,
  };
}

export async function sceneStatus(config, stashId) {
  return statusOf(await findByStashId(config, stashId));
}

/*
 * Everything v3 is holding, keyed on the StashDB id (lowercased — v3 and Stash
 * do not always agree on case).
 *
 * One call rather than one per result, because a search page asks about twenty
 * scenes at once. Whisparr is transient here: the library is deleted back out
 * of it once Stash has imported, so this list is short by design and often
 * empty — which is exactly what makes indexing the whole of it the cheap
 * option rather than the expensive one.
 */
const HELD_TTL = 30 * 1000;
let held = null;

export function forgetHeld() {
  held = null;
}

export async function allByStashId(config, { force = false } = {}) {
  const { byStashId } = await allHeld(config, { force });
  return byStashId;
}

/*
 * Every movie, in the order v3 gave them.
 *
 * The index above is the usual way in, but it silently drops anything without
 * a stash id — two of 539 on 2026-09-01, both added by hand — and the tidy pass
 * has to account for the whole list rather than the joinable part of it. Same
 * fetch, same cache, so asking for both costs one request.
 */
export async function allMovies(config, { force = false } = {}) {
  const { movies } = await allHeld(config, { force });
  return movies;
}

async function allHeld(config, { force = false } = {}) {
  if (!force && held && Date.now() - held.at < HELD_TTL) return held;

  const all = await call(config, '/movie');
  const movies = Array.isArray(all) ? all : [];
  const byStashId = new Map();
  for (const movie of movies) {
    if (movie.stashId) byStashId.set(String(movie.stashId).toLowerCase(), movie);
  }

  held = { movies, byStashId, at: Date.now() };
  return held;
}

// ------------------------------------------------------------------- writing

export const search = (config, movieIds) =>
  call(config, '/command', { method: 'POST', body: { name: 'MoviesSearch', movieIds } });

/*
 * Bulk monitor state, and bulk removal.
 *
 * Both are `/movie/editor` taking a MovieEditorResource, read off this
 * instance's own OpenAPI at /docs/v3/openapi.json: {movieIds, monitored,
 * qualityProfileId, rootFolderPath, tags, applyTags, moveFiles, deleteFiles,
 * addImportExclusion}. Only the fields being changed are sent — a full
 * resource would move quality profiles and root folders as a side effect of
 * flipping one flag.
 *
 * `addImportExclusion` is the "and never fetch it again" half of the pipeline:
 * once a scene has been encoded and filed in Stash, a second grab is a
 * duplicate, not a better copy.
 */
export const setMonitored = (config, movieIds, monitored) =>
  call(config, '/movie/editor', { method: 'PUT', body: { movieIds, monitored } });

export const removeMovies = (config, movieIds, { deleteFiles = true, addImportExclusion = true } = {}) =>
  call(config, '/movie/editor', { method: 'DELETE', body: { movieIds, deleteFiles, addImportExclusion } });

/*
 * The movie v3 holds for this scene, monitored, added first if v3 has never
 * heard of it.
 *
 * Both "add" and "ask again" want exactly this and then differ only in how they
 * search, so the shape of an add lives in one place. Same rule as the v2 side:
 * nothing is grabbed except the scene actually asked for. addOptions.monitor is
 * "none" so adding a scene never drags its studio's whole catalogue in behind
 * it, and the scene itself carries monitored: true.
 */
async function ensureMovie(config, stashId, { searchOnAdd = false } = {}) {
  if (!config.whisparr3RootFolderPath || !config.whisparr3QualityProfileId) {
    throw new Whisparr3Error('Whisparr v3 needs a root folder and quality profile before it can add anything.');
  }

  const existing = await findByStashId(config, stashId);

  if (existing) {
    // Already known. Monitoring it is the whole of what "add" means here.
    const movie = existing.monitored
      ? existing
      : await call(config, '/movie/' + existing.id, { method: 'PUT', body: { ...existing, monitored: true } });
    return { movie, added: false };
  }

  const [candidate] = await lookupScene(config, stashId);
  if (!candidate) throw new Whisparr3Error(`Whisparr v3 could not look up StashDB scene ${stashId}.`);

  const movie = await call(config, '/movie', {
    method: 'POST',
    body: {
      ...candidate,
      qualityProfileId: Number(config.whisparr3QualityProfileId),
      rootFolderPath: config.whisparr3RootFolderPath,
      monitored: true,
      addOptions: {
        monitor: 'none',
        searchForMovie: Boolean(searchOnAdd),
        addMethod: 'manual',
      },
    },
  });

  return { movie, added: true };
}

// Add one StashDB scene and monitor it.
export async function addScene(config, stashId) {
  const wanted = Boolean(config.searchOnAdd);
  const { movie, added } = await ensureMovie(config, stashId, { searchOnAdd: wanted });

  // A new movie is searched by addOptions on the way in; one v3 already had is
  // not, so it has to be asked for.
  if (wanted && !added) await search(config, [movie.id]);
  forgetHeld();

  return { movieId: movie.id, title: movie.title, added, monitored: true, searched: wanted };
}

/*
 * Take a scene back out of v3.
 *
 * Untracking is "I do not want this", and a monitored record left behind is a
 * downloader still looking for it. Only Whisparr's own record goes: deleteFiles
 * is false, so anything already fetched stays where it is for Stash to import,
 * and no import exclusion is added — untracking is not a blocklist.
 */
export async function removeScene(config, stashId) {
  const movie = await findByStashId(config, stashId);
  if (!movie) return { removed: false };

  await call(config, `/movie/${movie.id}?deleteFiles=false&addImportExclusion=false`, { method: 'DELETE' });
  forgetHeld();

  return { removed: true, movieId: movie.id, title: movie.title };
}

/*
 * Ask for another file for a scene you already have.
 *
 * Nothing is deleted — not the file on the share, not the Stash record, not
 * whatever v3 is holding. This monitors the scene and forces a search, so a
 * better release can arrive alongside the one you have; which of the two you
 * keep is a decision made once it has landed, not before.
 *
 * The search is forced regardless of searchOnAdd, because asking again *is* the
 * ask — there is nothing else this could mean.
 */
export async function askAgain(config, stashId) {
  const { movie, added } = await ensureMovie(config, stashId, { searchOnAdd: false });
  await search(config, [movie.id]);
  forgetHeld();

  return {
    movieId: movie.id,
    title: movie.title,
    added,
    monitored: true,
    searched: true,
    // What v3 was holding before the ask, which is not what Stash holds.
    hasFile: !!movie.hasFile,
    path: movie.path || null,
  };
}
