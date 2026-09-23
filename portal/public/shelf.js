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

/* ------------------------------------------------------------------ routing
 *
 * -> true if this hash belonged to the library, so app.js knows to stop.
 */
export function route(hash) {
  /*
   * Stats is a tab of its own in the topbar rather than a section of the
   * library, but it is drawn from the same library reads and torn down by the
   * same claim — so it is claimed here, where that machinery lives.
   */
  if (hash === '#/stats') { showStats(); return true; }

  const scene = hash.match(/^#\/library\/scene\/(\d+)$/);
  if (scene) { showScene(scene[1]); return true; }

  // A film on the share. Its id is 12 hex characters, which is what keeps it
  // apart from a Stash group's plain number below.
  const movie = hash.match(/^#\/library\/movie\/([0-9a-f]{12})$/);
  if (movie) { showMovie(movie[1]); return true; }

  // A group is a release cut into scene files, and its page plays them as one
  // film — see library/group.js. Its id is a plain number, which is what keeps
  // it apart from the 12-hex id of a feature on the share above.
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

  // A category. Its slug is made once at creation and never follows a rename,
  // so this address outlives whatever the category ends up being called. It
  // carries a filter bar now, so it carries its state on the end like the four
  // sections below do.
  const category = hash.match(/^#\/library\/category\/([a-z0-9-]+)(?:\?(.*))?$/);
  if (category) { showCategory(category[1], category[2] || ''); return true; }
  if (hash === '#/library/categories') { showCategories(); return true; }


  // The five sections. Overview is the landing, so #/library keeps its meaning.
  // The four that carry a filter bar carry its state in the address too, so
  // they are matched with a query string on the end.
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
