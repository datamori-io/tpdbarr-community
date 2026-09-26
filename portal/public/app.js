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
   * Stand the reel down first: the library returns early below, and a reel
   * link into it would leave the reel playing.
   */
  reel.leave();
  social.leave();
  gifs.leave();
  // The marker bench holds a video and a window-wide keydown listener; both
  // outlive the node the router is about to replace. See markerbuilder.js.
  markerbuilder.leave();

  /*
   * Bump the generation before the library handles the address, or pages
   * redrawing on timers keep painting over the new page.
   */
  newGeneration();
  clearTimeout(homeTimer);
  clearTimeout(overviewTimer);
  clearTimeout(integrationsTimer);
  clearTimeout(artTimer);

  // The library owns everything under #/library and tears its own player down.
  if (shelf.route(fullHash)) return;
  shelf.leave();

  /* Split off the query string before matching. */
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
   * Binge is the reel. The Stash plugin frame is its own app; its inner
   * routes aren't ours.
   */
  if (hash.startsWith('#/parameters')) return showSettings(hash);
  if (hash === '#/binge/redgifs') return gifs.show();
  if (hash === '#/binge/reddit') return social.show();
  if (hash === '#/binge/plugin') return showBingePlugin();
  if (hash === '#/binge') return reel.show(query);

  /*
   * Import, five pages:
   *
   *   Overview      what am I collecting, and what is worth a look
   *   Video         the scene and movie search
   *   Images        photo sets for a performer
   *   Tracked       the catalogues being measured
   *   Integrations  is everything up, and what is in flight
   *
   * Old #/acquire addresses are rewritten to the new ones.
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
   * Catalogue: work on scenes you already hold.
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

  /* The library is the front door, except on a fresh install (setup). */
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

/* Manage (was Settings): seven pages, in public/settings/. */
function showSettings(hash) {
  const paint = painterFor();
  if (hash === '#/parameters/catchup') return showCatchUp(paint);
  if (hash === '#/parameters/feed') return showFeed(paint);
  if (hash === '#/parameters/galleries') return showGallerySettings(paint);
  if (hash === '#/parameters/catalog') return showCatalogSettings(paint);
  if (hash === '#/parameters/sending') return showSending(paint);
  if (hash === '#/parameters/stash') return showStash(paint);
  if (hash === '#/parameters') return showConnections(paint);

  // Unknown subpage: back to the landing.
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

/*
 * ------------------------------------------------------- where you are
 *
 * Light the top-nav entry for the current section, worked out from the
 * address. The StashDB detail pages (`#/scene/<uuid>`, `#/performer/`,
 * `#/movie/`, `#/site/`, `#/search/`) belong to Find; anchored, so
 * `#/library/scene/12` isn't caught.
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

  // Manage lights when you're on any page inside it, and closes after a pick.
  const menu = document.getElementById('nav-manage');
  menu.classList.toggle('on', Boolean(menu.querySelector('a.on')));
  menu.open = false;
}

window.addEventListener('hashchange', markNav);
markNav();

// Close the Manage menu on a click outside it or on Esc.
document.addEventListener('click', (e) => {
  const menu = document.getElementById('nav-manage');
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('nav-manage').open = false;
});

window.addEventListener('hashchange', () => routeTo(location.hash));

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    document.getElementById('search-input').focus();
  }
});

/*
 * The size control mounts itself by watching the view (idempotent); the
 * multiplier is applied on the address change.
 */
const applyForHash = () => applyStep(stepFor(pageKey(location.hash)));
window.addEventListener('hashchange', applyForHash);

/*
 * A timer, not rAF: rAF doesn't fire in a hidden tab, which left
 * `mountQueued` stuck and the control never mounted again.
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
