/*
 * Manage (was Settings): the section strip and the shared form. No sibling
 * imports.
 */

import { el } from '../util.js';

const SECTIONS = [
  ['#/parameters', 'Connections'],
  ['#/parameters/catchup', 'Catch up'],
  ['#/parameters/feed', 'Feed'],
  ['#/parameters/galleries', 'Galleries'],
  ['#/parameters/catalog', 'Catalog'],
  ['#/parameters/sending', 'Sending'],
];

/* The lit entry comes from the address. Stash is its own Manage item: no strip. */
function sections(active) {
  if (!SECTIONS.some(([href]) => href === active)) return null;
  return el('nav', { className: 'sections' },
    SECTIONS.map(([href, label]) =>
      el('a', { className: 'section' + (href === active ? ' on' : ''), href }, label))
  );
}

// Every settings page renders through here, so the strip is never the thing a
// new one forgets. `paint` is the caller's — taken before its first await.
export function shell(paint, section, title, note, ...nodes) {
  paint(
    el('div', { className: 'params' },
      sections(section),
      el('div', { className: 'feedhead' },
        el('h2', {}, title),
        note ? el('span', { className: 'muted' }, note) : null),
      ...nodes.flat().filter((node) => node != null && node !== false)
    )
  );
}

export const loadingIn = (paint, section, title) =>
  shell(paint, section, title, null, el('div', { className: 'empty' }, 'Loading…'));
