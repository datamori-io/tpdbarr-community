/*
 * Per-page thumbnail size.
 *
 * The stylesheet keeps one scale (--tile-sm/md/lg) that every artwork grid and
 * rail draws from, built from a base size times --tile-mult. So a size control
 * only has to move that one multiplier and the whole page follows — grids,
 * rails and posters together, which is the point: the complaint this answers
 * was thumbnails that did not agree with each other.
 *
 * The choice is per page because the pages are not asking the same question. A
 * wall of 654 performers wants to be small enough to scan; the scene you are
 * about to watch wants to be big enough to recognise.
 */

import { api, el } from './util.js';

export const STEPS = [
  { key: 's', label: 'S', mult: 0.78 },
  { key: 'm', label: 'M', mult: 1 },
  { key: 'l', label: 'L', mult: 1.28 },
  { key: 'xl', label: 'XL', mult: 1.6 },
];

const DEFAULT_STEP = 'm';

/*
 * Anything that sizes itself off the scale. If a page has none of these, it has
 * no thumbnails and gets no control.
 *
 * `.scenes` is a list of rows rather than a grid, and it belongs here for the
 * same reason the grids do: its stills are drawn off the same scale, so the
 * control moves them and a list without one was the only place in the app
 * where the size on screen was not yours to set.
 */
const GRIDS = '.tiles, .cards, .facets, .creators, .shots, .candidates, .railtrack, .scenes';

// Filled from /api/state on boot, then kept current as choices are made.
let stored = {};

export function loadTileScale(config) {
  stored = { ...(config?.tileScale || {}) };
}

/*
 * The route hash is the key, minus its query string: two different filters of
 * the same page are still the same page to look at.
 */
export function pageKey(hash) {
  const clean = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  return clean.replace(/\/+$/, '') || 'home';
}

export function stepFor(key) {
  const step = stored[key];
  return STEPS.some((s) => s.key === step) ? step : DEFAULT_STEP;
}

function multFor(step) {
  return (STEPS.find((s) => s.key === step) || STEPS[1]).mult;
}

export function applyStep(step) {
  document.documentElement.style.setProperty('--tile-mult', String(multFor(step)));
}

/*
 * Called after a route has rendered. Applies the page's stored size, and drops
 * the control into the page's toolbar when there is something to resize.
 */
export function mountTileSize(view, hash) {
  const key = pageKey(hash);
  let current = stepFor(key);
  applyStep(current);

  const grid = view.querySelector(GRIDS);
  if (!grid) return;
  if (view.querySelector('.sizepick')) return;

  /*
   * Where the control goes, in order of preference: a toolbar the page already
   * has, then its heading row, and failing both a row of its own above the
   * grid. Pages here are built three different ways and none of them was
   * written with this control in mind.
   *
   * `.edhead` is the Overview's section rule. It is asked for last of the
   * three because it is the only one that already has something on its right —
   * the MORE — and the two sit together there rather than competing for it.
   */
  let host = view.querySelector('.toolbar')
    || view.querySelector('.feedhead')
    || view.querySelector('.editorial:has(.railtrack) .edhead');
  if (!host) {
    host = el('div', { className: 'toolbar' }, el('span', { className: 'spacer' }));
    grid.parentElement.insertBefore(host, grid);
  }

  const pick = el('div', { className: 'sizepick', title: 'Thumbnail size on this page' });

  const buttons = STEPS.map((s) => {
    const b = el('button', { type: 'button' }, s.label);
    b.setAttribute('aria-pressed', String(s.key === current));
    b.setAttribute('aria-label', `Thumbnails ${s.label}`);
    b.onclick = () => choose(s.key);
    return b;
  });

  const paint = () => {
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(STEPS[i].key === current)));
  };

  const choose = (step) => {
    if (step === current) return;
    current = step;
    stored[key] = step;
    if (step === DEFAULT_STEP) delete stored[key];
    applyStep(step);
    paint();
    // Remembering is a convenience; a failed write should not interrupt looking
    // at the page, so this is deliberately not surfaced.
    api('/api/tilescale', { method: 'POST', body: JSON.stringify({ page: key, step }) }).catch(() => {});
  };

  pick.append(...buttons);
  host.append(pick);
}
