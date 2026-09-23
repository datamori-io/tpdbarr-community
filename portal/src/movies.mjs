/*
 * TPDB movies — the acquisition side.
 *
 * Not to be confused with moviefiles.mjs, which is the films you already have
 * sitting on the share. This is the catalogue: what ThePornDB says exists,
 * checked against what Stash holds, so you can send the scenes you are missing
 * to Whisparr.
 *
 * A movie here is a container, not a thing you download. TPDB movies are made
 * of scenes, and scenes are what Whisparr v2 takes — so the movie page lists
 * its scenes and adds those. Nothing in this file ever adds "a movie".
 *
 * Matching is the weak point and the UI says so out loud: a Stash group carries
 * no TPDB id and no fingerprints, so a movie can only be matched to one on its
 * link, or failing that its name. That is good enough to say "you probably have
 * this" and not good enough to say how much of it — which is why the counts
 * that matter are computed per scene on the detail page.
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

/*
 * -> {match, via, name, id} or null.
 *
 * `name` and `via` are both shown: the point is to let you judge the match
 * yourself, since "title" alone is a guess and the UI should not pretend
 * otherwise.
 */
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

/*
 * How a list of movies is ordered.
 *
 * Studio is the one worth having and the reason this exists: ThePornDB's movie
 * feed is a river of unrelated labels, and "everything Adam & Eve put out" is a
 * shelf. Date breaks the tie inside a studio, because a studio's releases are
 * still a sequence.
 */
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

  /*
   * Movies are only reachable with a TPDB token, and the portal borrows that
   * from Stash rather than asking for it twice. No Stash, no movies — said
   * plainly by the client rather than surfaced as an error.
   */
  if (!(await tpdb.available(config))) {
    return {
      tpdb: { available: false },
      stash: { enabled },
      movies: [],
      counts: { had: 0, total: 0 },
    };
  }

  // Only the feed is cached. A search is a question about the catalogue rather
  // than a page that happens to be here, and caching it would mean the next
  // search served the last one's answer.
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

/*
 * One movie, with its scenes annotated the same way every other scene list in
 * the app is — Whisparr state and Stash state per scene. That per-scene tally
 * is the honest version of the name match on the card: it is the difference
 * between "you probably have this" and "you have four of its six scenes".
 */
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
