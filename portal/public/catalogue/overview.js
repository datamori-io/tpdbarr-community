/* What is left to catalogue, and which tool to open. */

import { api, el } from '../util.js';
import { SECTION_OF, painterFor, show, state } from '../import/core.js';

/*
 * ============================================================== catalogue
 *
 * The landing page for work on scenes you hold: which tool to open. Every
 * number is counted and links to what clears it. No charts, no timers.
 */

export async function showCatalogue() {
  const paint = painterFor();
  const body = el('div', {});
  show(paint, SECTION_OF.catalogue, body);

  if (!state?.stash?.enabled) {
    body.replaceChildren(el('div', { className: 'empty' }, 'This works on your Stash library. Connect it in Manage.'));
    return;
  }

  body.replaceChildren(el('div', { className: 'empty' }, 'Counting the library…'));

  try {
    draw(body, await api('/api/catalogue/overview'));
  } catch (err) {
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

const n = (v) => (typeof v === 'number' ? v.toLocaleString() : '—');

function draw(body, { totals, folders }) {
  /* "Done": has an id, a cover, is organised, has a phash. Markers don't count. */
  const short = totals.noId + (totals.noCover || 0) + totals.unorganised + totals.noPhash;

  const head = el('div', { className: 'feedhead' },
    el('h2', {}, `${n(totals.scenes)} scenes`),
    el('span', { className: 'muted' }, short
      ? `${n(short)} outstanding jobs across them — a scene can be in more than one`
      : 'nothing outstanding')
  );

  // The three job cards that sat above the piles (scan, fingerprints,
  // previews) live under Manage › Stash now. See settings/stash.js.
  body.replaceChildren(
    head,
    jobs(totals),
    thin(totals),
    where(folders)
  );
}

/* The piles; each count is the link. */
function jobs(totals) {
  const JOBS = [
    ['No stash id', totals.noId, '#/catalogue/match?mode=unmatched',
      'Nothing knows what these are. Everything else downstream is guessing until they do.'],
    ['No cover', totals.noCover, '#/catalogue/match?mode=nocover',
      'Invisible on every shelf in the portal. A match brings the picture with it.'],
    ['Not organised', totals.unorganised, '#/catalogue/match?mode=unorganized',
      'Nobody has said these are finished. The one honest signal in the library.'],
    ['No markers', totals.noMarkers, '#/catalogue/markers',
      'Complete, but not indexed — nothing to jump to inside them.'],
  ];

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' }, el('strong', {}, 'The piles')),
    el('div', { className: 'catjobs' }, JOBS.map(([label, count, href, why]) =>
      el('a', { className: 'catjob' + (count ? '' : ' clear'), href },
        el('div', { className: 'catcount' }, n(count)),
        el('div', { className: 'catlabel' }, label),
        el('div', { className: 'muted small' }, count ? why : 'Nothing left.'))))
  );
}

/* Records with an id but almost no description: Wild Card's job. */
function thin(totals) {
  const BITS = [
    ['no title', totals.noTitle],
    ['no studio', totals.noStudio],
    ['no date', totals.noDate],
  ].filter(([, count]) => count);

  if (!BITS.length) return null;

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('strong', {}, 'Thin records'),
      el('span', { className: 'muted small' }, 'identified, maybe — but not described')),
    el('div', { className: 'controls' },
      ...BITS.map(([label, count]) => el('span', { className: 'chip quiet' }, `${n(count)} ${label}`)),
      el('a', { className: 'chip', href: '#/catalogue/wildcard' }, 'Build one up →'))
  );
}

/* Where the work is, by folder. */
function where(folders) {
  const rows = folders.filter((f) => f.scenes);
  if (!rows.length) return null;

  const cell = (value, of) => el('td', { className: value ? '' : 'muted' },
    value ? n(value) : '—',
    value && of ? el('span', { className: 'muted small' }, ` of ${n(of)}`) : null);

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('strong', {}, 'Where it is'),
      el('span', { className: 'muted small' }, 'the same job is a different size in each folder')),
    el('div', { className: 'cattablewrap' },
      el('table', { className: 'cattable' },
        el('thead', {},
          el('tr', {},
            el('th', {}, 'Folder'),
            el('th', {}, 'Scenes'),
            el('th', {}, 'No id'),
            el('th', {}, 'No phash'),
            el('th', {}, 'Not organised'),
            el('th', {}, 'No markers'))),
        el('tbody', {}, rows.map((f) =>
          el('tr', {},
            el('td', {}, el('code', {}, f.folder)),
            el('td', {}, n(f.scenes)),
            cell(f.noId),
            cell(f.noPhash),
            cell(f.unorganised),
            cell(f.noMarkers))))))
  );
}
