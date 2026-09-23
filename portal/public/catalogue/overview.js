/* What is left to catalogue, and which tool to open. */

import { api, el } from '../util.js';
import { SECTION_OF, painterFor, show, state } from '../import/core.js';

/* ============================================================== catalogue
 *
 * The landing page for the work on scenes you already hold.
 *
 * Each of the three tools under this tab answers one question well, and none
 * of them can tell you whether it is today's question. Match shows you a pile
 * and cannot say the pile is nearly done. Wild Card is one scene at a time by
 * design. Marker Builder does not know that two thousand scenes have never had
 * a marker on them. So this is the page that says which one to open.
 *
 * **Everything here is counted, not estimated.** It matters more than it
 * sounds. The phash gap was called a pc-import problem all morning on the
 * strength of one page of results, and counting it properly put the larger
 * share in /organized_scenes. A landing page whose numbers are indicative is a
 * landing page that sends you to the wrong tool.
 *
 * It is deliberately not a dashboard. There are no charts, nothing updates on
 * a timer, and every number is a link to the thing that fixes it — the Stats
 * tab is where the library is admired, and this is where it is worked on.
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
  /*
   * "Done" is the four things that make a scene usable everywhere else in the
   * portal: it knows what it is, it can be seen, somebody has said it is
   * finished, and its frames are known. Markers are deliberately not in it —
   * a scene without markers is complete, just not indexed, and counting two
   * thousand of those as unfinished would make the number say nothing.
   */
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

/*
 * The piles, as the tool that clears them names them.
 *
 * Each is a link rather than a number with a link beside it: the count *is*
 * the button, because there is exactly one thing you would want to do having
 * read it.
 */
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

/*
 * Records that exist but say almost nothing. These are Wild Card's, not
 * Match's — a scene with an id and no title is not unidentified, it is
 * undescribed, and no amount of matching will fill it in.
 */
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

/*
 * Where the work actually is.
 *
 * The table that changes what you do. "Unmatched scenes" is a number you act
 * on the same way wherever they are; "261 of pc-import's 551 have no id, and
 * only 60 of organized_scenes' 2,917 do" tells you which folder is the job and
 * which is background noise.
 */
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
