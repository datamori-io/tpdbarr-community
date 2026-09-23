/*
 * TMDB — the second source for films.
 *
 * ThePornDB knows the adult catalogue; it does not reliably know a 1976 feature
 * that happens to be X-rated, or a parody catalogued as a normal film. TMDB
 * does, and the .nfo files Emby already wrote to this share carry
 * <uniqueid type="tmdb">, so the library is half-indexed against it already.
 *
 * IMDB has no free API of its own, so an IMDB id is used the way everyone uses
 * it: handed to TMDB's /find to resolve into a TMDB record.
 *
 * Needs a key of its own — unlike the TPDB token, there is nothing on this
 * machine to borrow one from. Both key formats TMDB issues are accepted: the v4
 * read token goes in a header, the older v3 key in the query string.
 */

const API = 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p';

export class TmdbError extends Error {}

export const configured = (config) => Boolean(config.tmdbApiKey);

/*
 * v4 read tokens are JWTs and go in the Authorization header; v3 keys are 32
 * hex characters and go in the query string. Guessing wrong gives a 401 that
 * says nothing useful, so it is decided on the shape of the key.
 */
function request(config, path, params = {}) {
  const key = String(config.tmdbApiKey || '');
  const isJwt = key.startsWith('eyJ');

  const url = new URL(API + path);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }
  if (!isJwt) url.searchParams.set('api_key', key);

  return fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(isJwt ? { Authorization: `Bearer ${key}` } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
}

async function get(config, path, params) {
  if (!configured(config)) throw new TmdbError('TMDB is not configured — add a TMDB key in Settings.');

  const res = await request(config, path, params);
  if (res.status === 401) throw new TmdbError('TMDB rejected the key. Check it in Settings.');
  if (!res.ok) throw new TmdbError(`TMDB ${path} -> ${res.status}`);
  return res.json();
}

export async function check(config) {
  const data = await get(config, '/configuration');
  return { ok: true, images: Boolean(data.images) };
}

const image = (path, size) => (path ? `${IMAGES}/${size}${path}` : null);

/*
 * Shaped to match tpdb.toMovie() so the gap-filler can rank and render both
 * kinds side by side without caring which came from where.
 */
function toMovie(raw) {
  return {
    source: 'tmdb',
    id: String(raw.id),
    guid: null, // TPDB's word for its id; TMDB has none
    title: raw.title || raw.original_title || '(untitled)',
    date: raw.release_date || '',
    siteName: null,
    network: null,
    poster: image(raw.poster_path, 'w500'),
    background: image(raw.backdrop_path, 'original'),
    duration: raw.runtime || null,
    performers: [],
    url: `https://www.themoviedb.org/movie/${raw.id}`,
    overview: raw.overview || '',
    adult: Boolean(raw.adult),
  };
}

/*
 * include_adult matters here more than anywhere: without it TMDB hides most of
 * what this library is, and the search comes back empty for films it holds.
 */
export async function searchMovies(config, query, { year = null, limit = 10 } = {}) {
  if (!query || !query.trim()) return [];

  const data = await get(config, '/search/movie', {
    query: query.trim(),
    include_adult: 'true',
    ...(year ? { year } : {}),
  });

  return (data.results || []).slice(0, limit).map(toMovie);
}

// An IMDB id from an existing .nfo, resolved into a TMDB record.
export async function findByImdb(config, imdbId) {
  const clean = String(imdbId).trim();
  const id = /^tt\d+$/.test(clean) ? clean : `tt${clean.replace(/\D/g, '')}`;

  const data = await get(config, `/find/${encodeURIComponent(id)}`, { external_source: 'imdb_id' });
  return (data.movie_results || []).map(toMovie);
}

/*
 * The full record, with the cast and crew the .nfo wants. Genres arrive as
 * objects and directors are buried in the crew, so both are flattened here
 * rather than in the writer.
 */
export async function getMovie(config, id) {
  const raw = await get(config, `/movie/${encodeURIComponent(id)}`, { append_to_response: 'credits' });
  if (!raw || !raw.id) return null;

  const credits = raw.credits || {};

  return {
    ...toMovie(raw),
    duration: raw.runtime || null,
    siteName: raw.production_companies?.[0]?.name || null,
    directors: (credits.crew || []).filter((p) => p.job === 'Director').map((p) => p.name),
    tags: (raw.genres || []).map((g) => g.name).filter(Boolean),
    performers: (credits.cast || []).slice(0, 20).map((p) => ({ name: p.name, role: p.character || null })),
    ids: {
      tmdb: String(raw.id),
      ...(raw.imdb_id ? { imdb: raw.imdb_id } : {}),
    },
  };
}
