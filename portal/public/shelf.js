import { showCategories, showCategory } from './library/categories.js';
import { showGalleries, showGallery } from './library/galleries.js';
import { showGroup } from './library/group.js';
import { showMovie, showMovies } from './library/movies.js';
import { showOverview, showStage, showStats } from './library/overview.js';
import { showPerformer } from './library/performer.js';
import { showScene } from './library/scene.js';
import { showList, showPerformers, showScenes, showStudios } from './library/shelves.js';
import { showStudio } from './library/studio.js';

export { leave } from './library/core.js';
export { tiles } from './library/tiles.js';

// The front door is the overview now; app.js still asks for it by this name.
export const showLibrary = () => showOverview();

// --------------------------------------------------------------- flat grids

/*
 * ------------------------------------------------------------------ routing
 *
 * -> true if the hash belonged to the library.
 */
export function route(hash) {
  /* Stats is its own tab but uses the library's machinery. */
  if (hash === '#/stats') { showStats(); return true; }

  const scene = hash.match(/^#\/library\/scene\/(\d+)$/);
  if (scene) { showScene(scene[1]); return true; }

  // A film on the share. Its id is 12 hex characters, which is what keeps it
  // apart from a Stash group's plain number below.
  const movie = hash.match(/^#\/library\/movie\/([0-9a-f]{12})$/);
  if (movie) { showMovie(movie[1]); return true; }

  // A group: a numeric id, unlike a share feature's 12-hex id.
  const group = hash.match(/^#\/library\/group\/(\d+)$/);
  if (group) { showGroup(group[1]); return true; }

  const performer = hash.match(/^#\/library\/performer\/(\d+)$/);
  if (performer) { showPerformer(performer[1]); return true; }

  const studio = hash.match(/^#\/library\/studio\/(\d+)$/);
  if (studio) { showStudio(studio[1]); return true; }

  const gallery = hash.match(/^#\/library\/gallery\/(\d+)$/);
  if (gallery) { showGallery(gallery[1]); return true; }

  const list = hash.match(/^#\/library\/list\/([a-z]+)$/);
  if (list) { showList(list[1]); return true; }

  // A category, by slug, with filter state in the query.
  const category = hash.match(/^#\/library\/category\/([a-z0-9-]+)(?:\?(.*))?$/);
  if (category) { showCategory(category[1], category[2] || ''); return true; }
  if (hash === '#/library/categories') { showCategories(); return true; }


  // The five sections; the four with filter bars carry a query string.
  const shelves = hash.match(/^#\/library\/(scenes|performers|studios|galleries)(?:\?(.*))?$/);
  if (shelves) {
    const query = shelves[2] || '';
    if (shelves[1] === 'scenes') showScenes(query);
    else if (shelves[1] === 'performers') showPerformers(query);
    else if (shelves[1] === 'galleries') showGalleries(query);
    else showStudios(query);
    return true;
  }

  // Movies wears the shelf bar too, so it carries its state on the end.
  const movies = hash.match(/^#\/library\/movies(?:\?(.*))?$/);
  if (movies) { showMovies(movies[1] || ''); return true; }
  const stage = hash.match(/^#\/library\/stage\/([a-z]+)$/);
  if (stage) { showStage(stage[1]); return true; }

  if (hash === '#/library') { showOverview(); return true; }
  return false;
}
