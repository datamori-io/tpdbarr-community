/*
 * Whisparr v3 (Eros) client. A Radarr fork that takes StashDB only
 * (Whisparr#515); runs alongside v2 (TPDB). Both use /api/v3 — told apart by
 * URL and key.
 *
 * A scene is a movie; `itemType` says which kind:
 *
 *   StashDB scene  ->  movie (movie.stashId = movie.foreignId = scene UUID)
 *   StashDB studio ->  studio (studio.foreignId)
 *   performer      ->  performer (performer.foreignId)
 *
 * Shapes from the instance's OpenAPI at /docs/v3/openapi.json (no auth).
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

/* Is this really v3? Pointing it at v2 is the easy mistake. */
export async function identify(config) {
  const status = await systemStatus(config);
  const major = parseInt(String(status.version || '0').split('.')[0], 10);
  return { version: status.version, isV3: major === 3, appName: status.appName || null };
}

// ------------------------------------------------------------------- reading

/* -> the movie v3 holds for this StashDB scene, or null. One call. */
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
 * One scene's v3 state, flat, for a badge. "absent" is normal: files are
 * removed from Whisparr once Stash has them.
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

/* Everything v3 holds, keyed on lowercased StashDB id. One call, short list. */
const HELD_TTL = 30 * 1000;
let held = null;

export function forgetHeld() {
  held = null;
}

export async function allByStashId(config, { force = false } = {}) {
  const { byStashId } = await allHeld(config, { force });
  return byStashId;
}

/* Every movie, including the few without a stash id, for tidy. Same cache. */
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
 * Bulk monitor and removal via `/movie/editor`. Only changed fields are
 * sent; a full resource would move profiles and folders. `addImportExclusion`
 * stops a filed scene being grabbed again.
 */
export const setMonitored = (config, movieIds, monitored) =>
  call(config, '/movie/editor', { method: 'PUT', body: { movieIds, monitored } });

export const removeMovies = (config, movieIds, { deleteFiles = true, addImportExclusion = true } = {}) =>
  call(config, '/movie/editor', { method: 'DELETE', body: { movieIds, deleteFiles, addImportExclusion } });

/*
 * The scene's v3 movie, monitored, added first if needed.
 * addOptions.monitor is "none" so the studio's catalogue isn't pulled in.
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

/* Remove a scene from v3 on untrack. Record only: no file deletion, no exclusion. */
export async function removeScene(config, stashId) {
  const movie = await findByStashId(config, stashId);
  if (!movie) return { removed: false };

  await call(config, `/movie/${movie.id}?deleteFiles=false&addImportExclusion=false`, { method: 'DELETE' });
  forgetHeld();

  return { removed: true, movieId: movie.id, title: movie.title };
}

/* Ask for another file: monitor and force a search. Deletes nothing. */
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
