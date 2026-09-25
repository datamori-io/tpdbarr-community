/*
 * TPDB movies, the acquisition side (moviefiles.mjs is films you have).
 * A movie is a container: its page lists its scenes and adds those.
 * Matching to a Stash group is by link or name only, so per-scene counts
 * on the detail page are the real answer.
 */

import * as tpdb from './tpdb.mjs';
import * as stash from './stash.mjs';
import { annotateScenes, tally } from './library.mjs';
import { stashConfigured } from './config.mjs';

// The TPDB movie feed moves about as fast as the scene feed, so it is cached
// for as long as the home page is. The UI has a Refresh that forces past it.
const TTL = 30 * 60 * 1000;
const PAGES = 4;
const LIMIT = 48;

let cache = null;
export const forgetMovies = () => { cache = null; };

/* -> {match, via, name, id} or null. Both shown so you can judge. */
function heldInStash(index, movie) {
  if (!index) return null;
  const hit = stash.matchGroup(index, movie);
  if (!hit) return null;

  return {
    match: hit.match,
    via: hit.via,
    name: hit.group?.name || null,
    id: hit.group?.id ?? null,
  };
}

async function groupsOrNull(config, { force = false } = {}) {
  if (!stashConfigured(config)) return null;
  // Stash being down loses the "do I have it" column, not the page.
  return stash.groupIndex(config, { force }).catch(() => null);
}

/* Movie list orderings. By studio, then date. */
const ORDERS = {
  date: (a, b) => String(b.date).localeCompare(String(a.date)),
  title: (a, b) => a.title.localeCompare(b.title),
  studio: (a, b) =>
    (a.siteName || '~').localeCompare(b.siteName || '~') || String(b.date).localeCompare(String(a.date)),
};

export async function moviesView(config, { force = false, q = '', sort = 'date' } = {}) {
  const enabled = stashConfigured(config);
  const term = String(q || '').trim();
  const order = ORDERS[sort] ? sort : 'date';

  /* Movies need a TPDB token, borrowed from Stash. */
  if (!(await tpdb.available(config))) {
    return {
      tpdb: { available: false },
      stash: { enabled },
      movies: [],
      counts: { had: 0, total: 0 },
    };
  }

  // Only the feed is cached, not searches.
  if (!term && !force && cache && Date.now() - cache.at < TTL && cache.sort === order) return cache.view;

  const [found, index] = await Promise.all([
    term
      ? tpdb.searchMovieCatalogue(config, term)
      : tpdb.recentMovies(config, { pages: PAGES, limit: LIMIT }).then((movies) => ({
          movies,
          total: movies.length,
          capped: false,
        })),
    groupsOrNull(config, { force }),
  ]);

  const movies = [...found.movies].sort(ORDERS[order]);

  let had = 0;
  for (const movie of movies) {
    movie.stash = heldInStash(index, movie);
    if (movie.stash) had++;
  }

  const view = {
    tpdb: { available: true },
    stash: { enabled },
    movies,
    query: term,
    sort: order,
    counts: { had, total: movies.length, onTpdb: found.total, capped: found.capped },
  };

  if (!term) cache = { view, at: Date.now(), sort: order };
  return view;
}

/* One movie with its scenes annotated for Whisparr and Stash state. */
export async function movieView(config, guid) {
  const movie = await tpdb.getMovie(config, guid);
  if (!movie) throw new Error('ThePornDB has no movie with that id.');

  movie.scenes = movie.scenes || [];

  const [, index] = await Promise.all([
    annotateScenes(config, movie.scenes),
    groupsOrNull(config),
  ]);

  movie.stash = heldInStash(index, movie);

  return { movie, counts: tally(movie.scenes) };
}
