/*
 * Per-page thumbnail size. Every grid and rail sizes off --tile-sm/md/lg,
 * which are base sizes times --tile-mult, so this moves one multiplier.
 * Per page, since pages want different sizes.
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
 * Containers that size off the scale. A page with none gets no control.
 * `.scenes` (list rows) included.
 */
const GRIDS = '.tiles, .cards, .facets, .creators, .shots, .candidates, .railtrack, .scenes';

// Filled from /api/state on boot, then kept current as choices are made.
let stored = {};

export function loadTileScale(config) {
  stored = { ...(config?.tileScale || {}) };
}

/* The route hash without its query is the key. */
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

/* After a route renders: apply the stored size and mount the control. */
export function mountTileSize(view, hash) {
  const key = pageKey(hash);
  let current = stepFor(key);
  applyStep(current);

  const grid = view.querySelector(GRIDS);
  if (!grid) return;
  if (view.querySelector('.sizepick')) return;

  /*
   * Where the control goes: the page's toolbar, its heading row, the
   * Overview's `.edhead` (beside MORE), or a row of its own.
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
