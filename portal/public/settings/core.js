/*
 * Manage (was Settings) — the strip its pages wear, and the one form they share.
 *
 * Everything under #/parameters was a single scroll: connections, the catch-up
 * runner and the feed's defaults stacked in one column, with the gallery
 * builder and the category maker living on the pages they made things for. A
 * page you scroll past to reach the thing you came for is a page you stop
 * reading, so this is the same split the library already uses — a thin strip
 * of sections and one question per page.
 *
 * Nothing here imports from a sibling. Same rule as the other two halves: a
 * page needing something from another page means it belongs in this file.
 */

import { el } from '../util.js';

const SECTIONS = [
  ['#/parameters', 'Connections'],
  ['#/parameters/catchup', 'Catch up'],
  ['#/parameters/feed', 'Feed'],
  ['#/parameters/galleries', 'Galleries'],
  ['#/parameters/catalog', 'Catalog'],
  ['#/parameters/sending', 'Sending'],
  ['#/parameters/stash', 'Stash'],
];

/*
 * Which strip entry lights is worked out from the page's own address rather
 * than passed in, for the same reason the acquisition side does it: a page
 * that can name its own section is a page that can name the wrong one.
 */
function sections(active) {
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
