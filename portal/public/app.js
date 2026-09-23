import * as shelf from './shelf.js';
import * as reel from './reel.js';
import * as social from './social.js';
import * as gifs from './gifs.js';
import * as markerbuilder from './markerbuilder.js';
import { el, fitFills } from './util.js';
import { applyStep, mountTileSize, pageKey, stepFor } from './tilesize.js';
import { homeTimer, showHome } from './import/console.js';
import { MOVED_FROM_ACQUIRE, UUID, newGeneration, paint, painterFor, refreshState, renderSetup, state, view } from './import/core.js';
import { showGroupBuilder } from './catalogue/groups.js';
import { showImages } from './import/images.js';
import { integrationsTimer, showIntegrations } from './import/integrations.js';
import { showCatalogue } from './catalogue/overview.js';
import { showMarkerBuilder } from './catalogue/markers.js';
import { showMatch } from './catalogue/match.js';
import { showWildcard } from './catalogue/wildcard.js';
import { showMovie } from './import/movies.js';
import { overviewTimer, showOverview } from './import/overview.js';
import { showPerformer, showPerformers } from './import/performers.js';
import { showScene } from './import/scene.js';
import { showAcquire, showSearch } from './import/search.js';
import { artTimer, showSite } from './import/site.js';
import { showThanks } from './import/thanks.js';
import { showTracked } from './import/tracked.js';
import { showCatalogSettings } from './settings/catalog.js';
import { showSending } from './settings/sending.js';
import { showCatchUp } from './settings/catchup.js';
import { showConnections } from './settings/connections.js';
import { showFeed } from './settings/feed.js';
import { showGallerySettings } from './settings/galleries.js';
import { showStash } from './settings/stash.js';

async function routeTo(fullHash) {
  /*
   * The reel goes first: the library owns everything under #/library and
   * returns before the rest of this runs, and a performer chip on a slide
   * links straight into it — which would leave the reel playing behind the
   * page you just opened.
   */
  reel.leave();
  social.leave();
  gifs.leave();
  // The marker bench holds a video and a window-wide keydown listener; both
  // outlive the node the router is about to replace. See markerbuilder.js.
  markerbuilder.leave();

  /*
   * Whatever the last page left running stops here: the address has changed, so
   * anything still polling for the old one has nothing left to say. The paint
   * guard would swallow their output anyway; this stops them asking.
   *
   * It happens **before** the library gets its turn at the address, and that
   * ordering is the whole point. Four pages on this side redraw themselves on a
   * timer, and the guard that stops a late render is a generation counter — so
   * handing off to the library without bumping it left those timers both armed
   * and unguarded. Twenty seconds after opening a film you were looking at
   * Import › Integrations instead, at the film's own address.
   */
  newGeneration();
  clearTimeout(homeTimer);
  clearTimeout(overviewTimer);
  clearTimeout(integrationsTimer);
  clearTimeout(artTimer);

  // The library owns everything under #/library and tears its own player down.
  if (shelf.route(fullHash)) return;
  shelf.leave();

  /*
   * The search carries its filters in a query string, so the address is split
   * before anything is matched on it. Every other page ignores the second half.
   */
  const [hash, query = ''] = fullHash.split('?');

  const site = hash.match(/^#\/site\/(\d+)$/);
  if (site) return showSite(Number(site[1]));

  const scene = hash.match(new RegExp('^#/scene/' + UUID + '$'));
  if (scene) return showScene(scene[1]);

  const performer = hash.match(new RegExp('^#/performer/' + UUID + '$'));
  if (performer) return showPerformer(performer[1]);

  const movie = hash.match(new RegExp('^#/movie/' + UUID + '$'));
  if (movie) return showMovie(movie[1]);

  // Search has an address, so it survives a refresh and the back button
  // returns to it rather than dumping you on the front door.
  const search = hash.match(/^#\/search\/(.+)$/);
  if (search) return showSearch(decodeURIComponent(search[1]));

  /*
   * Binge is the reel, which is ours. The plugin it was named after is still
   * reachable one level down: a single-file app that Stash serves and that
   * talks to its GraphQL directly, so everything inside that frame — its own
   * #/home, #/foryou — is its business and not this router's.
   */
  if (hash.startsWith('#/parameters')) return showSettings(hash);
  if (hash === '#/binge/redgifs') return gifs.show();
  if (hash === '#/binge/reddit') return social.show();
  if (hash === '#/binge/plugin') return showBingePlugin();
  if (hash === '#/binge') return reel.show(query);

  /*
   * Import: five pages, in the order the work actually goes.
   *
   *   Overview      what am I collecting, and what is worth a look
   *   Video         the scene and movie search
   *   Images        photo sets for a performer
   *   Tracked       the catalogues being measured
   *   Integrations  is everything up, and what is in flight
   *
   * The tab was called Acquire and every address under it began #/acquire.
   * Those still answer — a rename is not a reason to break a bookmark — but
   * they are rewritten to the new address rather than served in place, so the
   * URL bar and the back button agree about where you are.
   */
  const moved = MOVED_FROM_ACQUIRE(hash);
  if (moved) {
    // Movies were a tab of their own and are a kind of search now, so the old
    // address arrives carrying the kind it meant.
    const carried = new URLSearchParams(query || '');
    if (hash === '#/acquire/movies') carried.set('kind', 'movie');
    const qs = carried.toString();
    location.replace(moved + (qs ? '?' + qs : ''));
    return;
  }

  if (hash === '#/import/video') return showAcquire(query);
  if (hash === '#/import/images') return showImages(query);
  /*
   * Catalogue: the work on scenes you already hold. Ahead of the Find pages
   * below only because it reads better beside its own comment — the router is
   * a list of exact matches and the order between them means nothing.
   *
   *   Overview      what is left to do, and where it is
   *   Match         which scene is this, and file the ids
   *   Wild Card     build the record out of several sources at once
   *   Marker Builder  the moments inside it
   */
  if (hash === '#/catalogue/groups') return showGroupBuilder(query);
  if (hash === '#/catalogue/match') return showMatch(query);
  if (hash === '#/catalogue/wildcard') return showWildcard(query);
  if (hash === '#/catalogue/markers') return showMarkerBuilder(query);
  if (hash === '#/catalogue') return showCatalogue();
  if (hash === '#/import/tracked') return showTracked();
  if (hash === '#/import/integrations') return showIntegrations();
  if (hash === '#/import/console') return showHome();
  if (hash === '#/import/performers') return showPerformers();
  if (hash === '#/import') return showOverview();
  if (hash === '#/thanks') return showThanks();

  /*
   * The front door is the library — this is a thing you watch far more often
   * than a thing you shop in. Acquisition keeps its whole console, one nav
   * click away at #/acquire.
   *
   * Except on a fresh install, where there is no library to show and the way
   * in is the only useful thing on the page.
   */
  if (!state?.stash?.enabled) return renderSetup();
  return shelf.showLibrary();
}

const BINGE_PATH = '/plugin/binge/assets/index.html';

function showBingePlugin() {
  const url = (state?.config?.stashUrl || '').replace(/\/+$/, '');
  if (!url) {
    paint(el('div', { className: 'empty' }, 'Set the Stash URL in Settings to use Binge.'));
    return;
  }

  window.scrollTo(0, 0);
  paint(el('iframe', {
    className: 'bingeframe fillview',
    src: url + BINGE_PATH,
    // It plays scenes out of Stash, and its own reel goes fullscreen.
    allow: 'autoplay; fullscreen; picture-in-picture',
  }));
  fitFills();
}

// ---------------------------------------------------------------- settings

/*
 * Manage (was Settings) — seven pages behind one strip. Everything about them, including the
 * connections form the document holds, is under public/settings/.
 */
function showSettings(hash) {
  const paint = painterFor();
  if (hash === '#/parameters/catchup') return showCatchUp(paint);
  if (hash === '#/parameters/feed') return showFeed(paint);
  if (hash === '#/parameters/galleries') return showGallerySettings(paint);
  if (hash === '#/parameters/catalog') return showCatalogSettings(paint);
  if (hash === '#/parameters/sending') return showSending(paint);
  if (hash === '#/parameters/stash') return showStash(paint);
  if (hash === '#/parameters') return showConnections(paint);

  // Anything else under here is a page that does not exist. Sent back to the
  // landing rather than drawn in place, so the address bar and the strip agree
  // about where you are.
  location.hash = '#/parameters';
  return undefined;
}


// ------------------------------------------------------------------ wiring

document.getElementById('search-form').onsubmit = (e) => {
  e.preventDefault();
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  // Re-running the same query leaves the hash unchanged, so nothing would
  // fire; that one case goes straight to the render.
  const hash = '#/search/' + encodeURIComponent(query);
  if (location.hash === hash) showSearch(query);
  else location.hash = hash;
};

/* ------------------------------------------------------- where you are
 *
 * Lighting the top-nav entry for the half of the app you are standing in.
 *
 * There was no active state at all before this: all four sat grey wherever you
 * were, so the only thing that ever lit one was the cursor being on it. A nav
 * that cannot say where you are is four links rather than a nav.
 *
 * It is worked out from the address rather than set by each page, because the
 * pages that draw are not the pages you can be on — the router hands
 * `#/library/...` straight to shelf.js and returns, and a dozen renderers on
 * this side paint from their own timers. One reading of `location.hash` is the
 * only version of this that cannot fall out of step.
 *
 * **The StashDB pages belong to Find even though their addresses do not say
 * so.** `#/scene/<uuid>`, `#/performer/`, `#/movie/`, `#/site/` and `#/search/`
 * are all somebody looking at what they have *not* got — the same half as
 * `#/import`, which is where every one of them is reached from. Note these are
 * anchored: `#/library/scene/12` is the library's own scene page and lands in
 * the default, where it should.
 */
function navFor(hash) {
  const at = String(hash || '').split('?')[0];

  if (at.startsWith('#/stats')) return 'nav-stats';
  if (at.startsWith('#/parameters')) return 'nav-settings';
  if (at.startsWith('#/catalogue')) return 'nav-catalogue';
  if (at.startsWith('#/import')) return 'nav-import';
  if (/^#\/(scene|performer|movie|site|search|thanks)(\/|$)/.test(at)) return 'nav-import';

  // The Feed is the brand pill's, not the nav's — nothing lights for it.
  if (at.startsWith('#/binge')) return null;

  return 'nav-library';
}

function markNav() {
  const here = navFor(location.hash);

  for (const link of document.querySelectorAll('.topnav a')) {
    const mine = link.id === here;
    link.classList.toggle('on', mine);
    // For anything reading the page rather than looking at it. `page` rather
    // than `true`: this is the section the current page is in.
    if (mine) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', markNav);
markNav();

window.addEventListener('hashchange', () => routeTo(location.hash));

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    document.getElementById('search-input').focus();
  }
});

/*
 * The size control attaches itself rather than being threaded through every
 * render function: pages paint from a dozen places here and in shelf.js, some
 * of them asynchronously and long after the route resolved. Watching the view
 * catches all of them, and mounting is idempotent.
 *
 * The multiplier is applied on the address change instead, so the page paints
 * at the right size rather than being resized a frame later.
 */
const applyForHash = () => applyStep(stepFor(pageKey(location.hash)));
window.addEventListener('hashchange', applyForHash);

/*
 * A timer rather than a frame. requestAnimationFrame does not fire while the
 * tab is hidden, so a render that happened in the background left `mountQueued`
 * stuck at true and the size control never mounted again for the rest of the
 * session — on any page, not just the one that was hidden.
 */
let mountQueued = false;
new MutationObserver(() => {
  if (mountQueued) return;
  mountQueued = true;
  setTimeout(() => {
    mountQueued = false;
    mountTileSize(view, location.hash);
  }, 0);
}).observe(view, { childList: true, subtree: true });

await refreshState();
applyForHash();
await routeTo(location.hash);
if (!state.configured) location.hash = '#/parameters';
