/*
 * The import side's core: app state, which render owns the screen, shared
 * chrome. Nothing here imports from a sibling.
 */

import { api, el } from '../util.js';
import { loadTileScale } from '../tilesize.js';

export const view = document.getElementById('view');
const statusbar = document.getElementById('statusbar');
export let state = null;
/*
 * A render is bound to the navigation it started under: `painterFor()` is
 * called before the first await and keeps that generation, so a slow page
 * can't paint over the one you moved to. (Comparing addresses doesn't work.)
 */
let generation = 0;

/* The router bumps this; imported bindings are read-only, hence a function. */
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
    /* No Whisparr: browsing only. */
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

  /* Link to the thanks page at the end of the status bar. */
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

/*
 * -------------------------------------------------------------- sections
 *
 * The acquisition side's section strip.
 */

const SECTIONS = [
  ['#/import', 'Overview'],
  ['#/import/video', 'Video'],
  ['#/import/images', 'Images'],
  ['#/import/tracked', 'Tracked'],
  ['#/import/integrations', 'Integrations'],
];

/* Catalogue sections: work on scenes you have but can't use yet. */
const CATALOGUE_SECTIONS = [
  ['#/catalogue', 'Overview'],
  ['#/catalogue/match', 'Match'],
  ['#/catalogue/wildcard', 'Wild Card'],
  ['#/catalogue/groups', 'Group Builder'],
  ['#/catalogue/markers', 'Marker Builder'],
];

/* Old addresses and where they go now (the Queue is part of Integrations). */
const MOVED = {
  '#/acquire': '#/import/video',
  '#/acquire/scenes': '#/import/video',
  '#/acquire/movies': '#/import/video',
  '#/acquire/performers': '#/import/performers',
  '#/acquire/creators': '#/import/performers',
  '#/acquire/console': '#/import/console',
  '#/queue': '#/import/integrations',

  /* Match, Wild Card and Marker Builder moved to Catalogue; old addresses redirect. */
  '#/import/match': '#/catalogue/match',
  '#/import/wildcard': '#/catalogue/wildcard',
  '#/import/markers': '#/catalogue/markers',
  '#/import/groups': '#/catalogue/groups',
};

export const MOVED_FROM_ACQUIRE = (hash) => MOVED[hash] || null;

/* A page's strip is decided by which list it's in, not by the page. */
export function sections(active) {
  const strip = CATALOGUE_SECTIONS.some(([href]) => href === active) ? CATALOGUE_SECTIONS : SECTIONS;

  return el('nav', { className: 'sections' },
    strip.map(([href, label]) =>
      el('a', { className: 'section' + (href === active ? ' on' : ''), href }, label))
  );
}

/* Detail pages light the section that lists them. */
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

/*
 * ------------------------------------------------------ list or grid
 *
 * Not in the address. Size is saved on the server (`tileScale`); list or
 * grid is kept per browser.
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

/* Whether the decide queue groups into blocks. On by default. */
export const isGrouped = () => recall('acquire.group', 'on') === 'on';

export function countChip(label, n) {
  return el('span', { className: 'count' }, el('b', {}, String(n)), ' ' + label);
}

export const statusLabel = (status) =>
  ({ downloaded: 'Downloaded', monitored: 'Monitored', absent: 'Not wanted' })[status] || status;
