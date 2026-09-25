/*
 * TMDB, the second source for films (mainstream-catalogued ones). IMDB ids
 * are resolved through TMDB's /find. Needs its own key.
 */

const API = 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p';

export class TmdbError extends Error {}

export const configured = (config) => Boolean(config.tmdbApiKey);

/* v4 tokens (JWTs) go in the header, v3 keys (32 hex) in the query. */
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

/* Same shape as tpdb.toMovie(). */
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

/* include_adult, or TMDB hides most of this library. */
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

/* Full record with cast and crew. Genres and directors flattened here. */
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
