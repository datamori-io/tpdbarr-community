/*
 * The import side's spine: what the app knows about itself, which render owns
 * the screen, and the chrome every page here wears.
 *
 * Nothing in here imports from a sibling. A page needing something from another
 * page means the something belongs in this file instead.
 */

import { api, el } from '../util.js';
import { loadTileScale } from '../tilesize.js';

export const view = document.getElementById('view');
const statusbar = document.getElementById('statusbar');
export let state = null;
/*
 * Painting the view, and the rule that stops a slow page winning.
 *
 * Open Movies, get bored of the ThePornDB pull, click Performers — and when the
 * movie feed finally lands it replaces the whole view with itself, dragging you
 * back to a page you had already left. Which page you got dragged to depended
 * only on which request happened to be slowest.
 *
 * So a render is bound to the navigation it began under, not to the address at
 * the moment it finishes: `painterFor()` is called before the first await and
 * closes over the generation it saw. Comparing addresses instead does not work
 * — by the time the stale render paints, the address has already been updated
 * to the page it is about to trample.
 */
let generation = 0;

/*
 * The router bumps this on every navigation, and the router is not in this
 * file any more. An imported binding is read-only, so it cannot be assigned
 * from over there — it is moved on through here instead.
 */
export const newGeneration = () => { generation += 1; };

// Unguarded, for the synchronous renders that cannot arrive late.
export const paint = (...nodes) => view.replaceChildren(...nodes);

export function painterFor() {
  const mine = generation;
  return (...nodes) => {
    if (mine !== generation) return;
    view.replaceChildren(...nodes);
  };
}

// Scenes are landscape on TPDB, movies are portrait posters.
export const artFor = (scene) => scene.image || scene.still || scene.poster || null;
export const artShape = (scene) => (scene.isMovie ? 'portrait' : 'landscape');

// ------------------------------------------------------------------ status

export async function refreshState() {
  state = await api('/api/state');
  loadTileScale(state.config);
  statusbar.replaceChildren(...statusLine());
  return state;
}

function statusLine() {
  const bits = [];
  const w = state.whisparr;

  if (!state.configured) {
    bits.push(el('span', { className: 'bad' }, 'Not configured yet — open Settings'));
  } else if (w.ok) {
    bits.push(el('span', { className: 'good' }, `Whisparr ${w.version}`));
    if (!w.isV2) bits.push(el('span', { className: 'bad' }, 'this is not a v2 instance'));
  } else if (w.enabled) {
    // Pointed at one and it did not answer. That is a fault worth the red.
    bits.push(el('span', { className: 'bad' }, `Whisparr: ${w.error || 'not answering'}`));
  } else {
    /*
     * No Whisparr at all, which since the library became the thing that decides
     * "configured" is a shape this portal runs in perfectly well. Said plainly,
     * in the statusbar's own colour, the same way v3 stays quiet until pointed
     * at something.
     */
    bits.push(el('span', {}, 'No Whisparr — browsing only, nothing to add with'));
  }

  // v3 is optional, so it is only mentioned once you have pointed at one.
  const v3 = state.whisparr3;
  if (v3?.enabled && v3.ok) {
    bits.push(el('span', { className: 'good' }, `Whisparr v3 ${v3.version}`));
    if (!v3.isV3) bits.push(el('span', { className: 'bad' }, 'the v3 fields point at something that is not v3'));
    else if (!v3.configured) bits.push(el('span', { className: 'bad' }, 'v3 needs a profile and root folder before it can add'));
  } else if (v3?.enabled) {
    bits.push(el('span', { className: 'bad' }, `Whisparr v3: ${v3.error}`));
  }

  const s = state.stash;
  if (s.enabled && s.ok) {
    bits.push(el('span', { className: 'good' },
      `Stash ${s.version}${s.endpoint ? '' : ' — no TPDB stash-box, matching on title + date'}`));
  } else if (s.enabled) {
    bits.push(el('span', { className: 'bad' }, `Stash: ${s.error}`));
  }

  // Be explicit that artwork is using a credential borrowed from Stash.
  if (state.tpdb?.available) {
    bits.push(el('span', { className: 'good', title: "Read from Stash's stash-box settings; never stored here" },
      'Artwork via TPDB token from Stash'));
  }

  /*
   * The status bar is already the strip that says what this is standing on —
   * which Whisparr, whose token — so the page that says it properly belongs at
   * the end of it rather than taking a slot in the top nav.
   */
  bits.push(el('a', { className: 'thankslink', href: '#/thanks', title: 'The catalogues and software this is built on' }, 'Thanks'));

  return bits;
}

// ------------------------------------------------------------------- views

export const UUID = '([0-9a-fA-F-]{36})';

// First run has nothing to show, so show the way in rather than an empty page.
export function renderSetup() {
  const open = el('button', { className: 'primary', type: 'button' }, 'Open Settings');
  open.onclick = () => { location.hash = '#/parameters'; };

  paint(el('div', { className: 'setup' },
    el('img', { className: 'setupmark', src: '/brand/datamori-full.jpg', alt: 'Datamori' }),
    el('h1', {}, 'Point tpdbarr at your stack'),
    el('ol', {},
      el('li', {}, 'Stash URL. This is the library — everything you watch comes from here.'),
      el('li', {}, 'Whisparr v2 URL and API key, plus a quality profile and root folder. This is where TPDB scenes get added.'),
      el('li', {}, 'Whisparr v3 — optional. StashDB scenes go here. Give it its own root folder.')
    ),
    open
  ));
}

/* -------------------------------------------------------------- sections
 *
 * The acquisition side, in three. Not three more entries in the top nav:
 * Library and Queue are other places, whereas these are three views of the
 * same question — what is out there, and what of it do I not have.
 */

const SECTIONS = [
  ['#/import', 'Overview'],
  ['#/import/video', 'Video'],
  ['#/import/images', 'Images'],
  ['#/import/tracked', 'Tracked'],
  ['#/import/integrations', 'Integrations'],
];

/*
 * The other half of the work, and the reason it is a section of its own.
 *
 * Find is about scenes you have not got: searching catalogues, tracking
 * studios, watching things arrive. Catalogue is about the ones you have and
 * cannot yet use — a file with no id, no cover, no title, no markers is on the
 * disk and absent from every shelf in here.
 *
 * They were one tab for a long time and it stopped being true. Match, Wild
 * Card and Marker Builder never once got used in the same sitting as the
 * StashDB search above them; they are what you do on a Sunday with a folder
 * full of things that arrived during the week.
 */
const CATALOGUE_SECTIONS = [
  ['#/catalogue', 'Overview'],
  ['#/catalogue/match', 'Match'],
  ['#/catalogue/wildcard', 'Wild Card'],
  ['#/catalogue/groups', 'Group Builder'],
  ['#/catalogue/markers', 'Marker Builder'],
];

/*
 * Where an old address goes now. The Queue was a top-nav entry of its own and
 * is now one band of Integrations, because "what is Whisparr doing" was never a
 * different question from "what is the pipeline doing" — it was the first step
 * of it, shown on its own.
 */
const MOVED = {
  '#/acquire': '#/import/video',
  '#/acquire/scenes': '#/import/video',
  '#/acquire/movies': '#/import/video',
  '#/acquire/performers': '#/import/performers',
  '#/acquire/creators': '#/import/performers',
  '#/acquire/console': '#/import/console',
  '#/queue': '#/import/integrations',

  /*
   * Cataloguing became its own section. These three were under Find because
   * that is where they were written, not because that is what they are — a
   * rename is not a reason to break a bookmark, so the old addresses still
   * answer and are rewritten rather than served in place.
   */
  '#/import/match': '#/catalogue/match',
  '#/import/wildcard': '#/catalogue/wildcard',
  '#/import/markers': '#/catalogue/markers',
  '#/import/groups': '#/catalogue/groups',
};

export const MOVED_FROM_ACQUIRE = (hash) => MOVED[hash] || null;

/*
 * The strip a page wears is decided by which strip it is listed in, not by an
 * argument the page passes. A page that could name its own strip is a page
 * that can name the wrong one, and the two sections now have three tabs that
 * read almost the same.
 */
export function sections(active) {
  const strip = CATALOGUE_SECTIONS.some(([href]) => href === active) ? CATALOGUE_SECTIONS : SECTIONS;

  return el('nav', { className: 'sections' },
    strip.map(([href, label]) =>
      el('a', { className: 'section' + (href === active ? ' on' : ''), href }, label))
  );
}

/*
 * A detail page belongs to the section that lists it, and the strip says which
 * — not how you got here. So a performer lights Performers whether you arrived
 * from there, from a scene's cast, or from the band on the console. Where you
 * came from is the back button's job; this is the page's address.
 */
export const SECTION_OF = {
  search: '#/import/video',
  site: '#/import/video',
  scene: '#/import/video',
  performer: '#/import/performers',
  movie: '#/import/video',
  images: '#/import/images',
  match: '#/catalogue/match',
  wildcard: '#/catalogue/wildcard',
  groups: '#/catalogue/groups',
  markers: '#/catalogue/markers',
  catalogue: '#/catalogue',
  tracked: '#/import/tracked',
  integrations: '#/import/integrations',
  overview: '#/import',
};

// Every acquisition page renders through here, so the strip is never the thing
// a new page forgets.
export function show(paint, section, ...nodes) {
  paint(sections(section), ...nodes.flat().filter((node) => node != null && node !== false));
}

/* ------------------------------------------------------------- small bits */

export const text = (value) => (value ? el('span', {}, value) : null);
export const link = (label, href) => el('a', { className: 'link', href }, label);

export const externalLink = (href, label) =>
  href ? el('p', {}, el('a', { className: 'link', href, target: '_blank', rel: 'noreferrer' }, label + ' ↗')) : null;

export const acquireHash = (params) => {
  const qs = params.toString();
  return '#/import/video' + (qs ? '?' + qs : '');
};

/* ------------------------------------------------------ list or grid
 *
 * Two ways to look at the same results. A row is for reading — cast, studio and
 * date all legible at once. A grid is for looking.
 *
 * Neither is part of the search, so neither goes in the address: a search you
 * send to yourself should arrive looking the way you like to read, and should
 * not carry a setting the other end never chose.
 *
 * They are kept in two different places on purpose. **Size** goes to the
 * server, in `tileScale` under this page's key, because how big you want
 * thumbnails is a taste and this portal gets used from more than one machine.
 * **List or grid** stays in the browser, because that one really is about the
 * screen in front of you — a phone wants the rows, a desk wants the wall.
 */

// A browser with site data blocked is not a reason for the page to fall over.
export const remember = (key, value) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private window, or site data blocked */
  }
};

export const recall = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

export const isGrid = () => recall('acquire.view', 'list') === 'grid';

/*
 * Whether the decide queue stacks itself into blocks.
 *
 * On by default, because the queue's own reason for existing is a backlog too
 * big to answer one card at a time, and a block is the grain most of those
 * answers actually come at — a studio's whole 2011, a guest appearance you
 * have no interest in. Off is the old flat queue, one long run of cards.
 */
export const isGrouped = () => recall('acquire.group', 'on') === 'on';

export function countChip(label, n) {
  return el('span', { className: 'count' }, el('b', {}, String(n)), ' ' + label);
}

export const statusLabel = (status) =>
  ({ downloaded: 'Downloaded', monitored: 'Monitored', absent: 'Not wanted' })[status] || status;
