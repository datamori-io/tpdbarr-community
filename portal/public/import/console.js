/* The console: what needs you, what you are collecting, what landed. */

import { api, el } from '../util.js';
import { sceneCard } from './cards.js';
import { paint, painterFor, renderSetup, sections, state } from './core.js';
import { postAdd } from './send.js';

export let homeTimer = null;

export async function showHome() {
  const paint = painterFor();
  clearTimeout(homeTimer);

  if (!state?.configured) return renderSetup();

  try {
    const { home, building, queue } = await api('/api/home');

    // The strip comes along even while there is nothing to put under it — the
    // first build takes a minute, and the other two sections work throughout.
    if (!home) {
      paint(sections('#/import/console'), el('div', { className: 'empty' },
        building ? 'Building your home page… this takes a minute the first time.' : 'Nothing to show yet.'));
      homeTimer = setTimeout(showHome, 4000);
      return;
    }

    renderHome(paint, home, building, queue);
    if (building) homeTimer = setTimeout(showHome, 5000);
  } catch (err) {
    paint(sections('#/import/console'), el('div', { className: 'empty' }, err.message));
  }
}

/*
 * Bands in the order the questions actually get asked: what is new to me, what
 * is stuck, what am I nearly done with, who have I been following, what else is
 * out there.
 */
function renderHome(paint, home, building, queue) {
  const refresh = el('button', { className: 'chip', type: 'button' }, building ? 'refreshing…' : 'Refresh');
  refresh.disabled = building;
  refresh.onclick = async () => {
    refresh.disabled = true;
    refresh.textContent = 'refreshing…';
    await api('/api/home?refresh=1');
    showHome();
  };

  paint(
    sections('#/import/console'),
    el('div', { className: 'toolbar' }, el('span', { className: 'spacer' }), refresh),
    attentionBand(home.attention, queue),
    band(home.since.title, home.since.note, home.since.scenes,
      'No sites in Whisparr yet — search for one above and add a scene.'),
    coverageBand(home.coverage),
    performerBand(home.performers),
    band('New from studios', 'the global TPDB feed, clip sites removed', home.discovery.scenes,
      'Nothing matched the filters on this pass.')
  );
}

function band(title, note, scenes, empty) {
  const body = scenes.length
    ? el('div', { className: 'cards' }, scenes.map((s) => sceneCard(s)))
    : el('div', { className: 'empty small' }, empty);

  return el('section', { className: 'feed' },
    el('div', { className: 'feedhead' },
      el('h2', {}, title),
      el('span', { className: 'muted' }, note)
    ),
    body
  );
}

/* ------------------------------------------------------------- needs you
 *
 * The "is anything stuck?" answer, which nothing else in the app gives —
 * Whisparr will search for a scene forever without ever mentioning it.
 *
 * Deliberately a summary and not a workbench: retrying, unmonitoring and
 * deleting belong in Whisparr, where the undo lives.
 */

const ATTENTION_LABEL = { busy: 'Queue', failed: 'Stuck', upcoming: 'Upcoming' };

function attentionBand(attention, queue) {
  const rows = [];

  if (queue?.total) {
    rows.push(attentionRow('busy', `${queue.total} in the queue`, 'Whisparr is working through these', '#/queue'));
  }

  for (const record of queue?.stalled || []) {
    rows.push(attentionRow('failed', record.title, [record.site, record.why].filter(Boolean).join(' — '), '#/queue'));
  }

  const stale = attention.stale;
  if (stale?.total) {
    rows.push(attentionRow('failed',
      `${stale.total} wanted, still nothing after ${stale.days} days`,
      stale.records.slice(0, 3).map((r) => r.title).join(' · '),
      '#/import/video?kind=monitored&from=v2'));
  }

  for (const scene of attention.upcoming) {
    rows.push(attentionRow('upcoming', scene.title, [scene.siteName, scene.date].filter(Boolean).join(' — ')));
  }

  for (const problem of [attention.whisparrError, queue?.error].filter(Boolean)) {
    rows.push(attentionRow('failed', 'Whisparr', problem));
  }

  if (!rows.length) return null;

  return el('section', { className: 'feed' },
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Needs you'),
      el('span', { className: 'muted' }, 'the queue, scenes that have waited too long, and what lands next')
    ),
    el('div', { className: 'attention' }, rows)
  );
}

function attentionRow(kind, title, detail, href) {
  const row = el('div', { className: 'arow' },
    el('span', { className: 'badge ' + kind }, ATTENTION_LABEL[kind]),
    el('div', {},
      el('div', { className: 'title' }, title),
      detail ? el('div', { className: 'meta' }, detail) : null
    )
  );

  if (href) {
    row.classList.add('clickable');
    row.onclick = () => { location.hash = href; };
  }
  return row;
}

/* ------------------------------------------------------------ site coverage
 *
 * How much of each catalogue you already hold, counted in Stash rather than in
 * Whisparr — Whisparr is a downloader here, and a scene only sits in it for the
 * hours between grabbing and importing.
 */

function coverageBand(coverage) {
  const basis = coverage?.basis === 'stash' ? 'counted in Stash' : 'counted on files in Whisparr';

  const head = el('div', { className: 'feedhead' },
    el('h2', {}, 'Site coverage'),
    el('span', { className: 'muted' }, 'how much of each catalogue you already have, ' + basis)
  );

  const rows = coverage?.rows || [];
  if (!rows.length) {
    return el('section', { className: 'feed' }, head,
      el('div', { className: 'empty small' },
        'Nothing to measure yet — a site appears here once it is in Whisparr.')
    );
  }

  return el('section', { className: 'feed' }, head,
    el('div', { className: 'completion' }, rows.map((r) => coverageRow(r, coverage.basis)))
  );
}

function coverageRow(row, basis) {
  const fill = el('span');
  fill.style.width = row.pct + '%';

  const meta = [
    `${row.had} of ${row.total} ${basis === 'stash' ? 'in Stash' : 'downloaded'}`,
    row.wanted ? `${row.wanted} already wanted` : null,
    `${row.missing} you do not have`,
  ].filter(Boolean);

  const node = el('div', { className: 'crow' },
    row.poster ? el('img', { src: row.poster, loading: 'lazy', alt: '' }) : el('div', { className: 'noposter' }),
    el('div', {},
      el('div', { className: 'title' }, row.title),
      el('div', { className: 'meta' }, meta.map((m) => el('span', {}, m))),
      el('div', { className: 'bar' }, fill)
    ),
    gapAction(row)
  );

  node.onclick = () => { location.hash = `#/site/${row.siteId}`; };
  return node;
}

/*
 * One click only closes a small gap. Hundreds of scenes behind a single button
 * is not a shortcut — that row opens the site instead, where the "Do not have"
 * filter does the same job deliberately.
 */
function gapAction(row) {
  if (!row.missing) return el('span', { className: 'gapnote' }, 'complete');
  if (!row.missingIds.length) return el('span', { className: 'gapnote' }, 'open to pick');

  const add = el('button', { className: 'add', type: 'button' }, `Add the ${row.missing}`);
  add.onclick = (e) => {
    e.stopPropagation();
    fillGap(row, add);
  };
  return add;
}

async function fillGap(row, trigger) {
  trigger.disabled = true;
  trigger.textContent = `Adding ${row.missing}…`;
  try {
    const result = await postAdd(row.siteId, row.missingIds);
    trigger.textContent = `Added ${result.added.length}`;
  } catch (err) {
    trigger.disabled = false;
    trigger.textContent = `Add the ${row.missing}`;
    alert(err.message);
  }
}

/* ---------------------------------------------------------- your performers
 *
 * Performer-first. Everywhere else in this hobby the performer is the entity
 * you navigate by, and a name above a row explains why these scenes are here
 * far better than a footnote under each card.
 */

function performerBand(groups) {
  if (!groups?.length) {
    if (!state?.stash?.enabled) return null;
    return el('section', { className: 'feed' },
      el('div', { className: 'feedhead' }, el('h2', {}, 'Your performers')),
      el('div', { className: 'empty small' }, 'No performers in Stash carry a TPDB id yet.')
    );
  }

  return el('section', { className: 'feed' },
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Your performers'),
      el('span', { className: 'muted' }, 'newest from performers you have files for in Stash')
    ),
    ...groups.map((group) => el('div', { className: 'pgroup' },
      el('h3', {}, group.uuid
        ? el('a', { href: `#/performer/${group.uuid}` }, group.name)
        : group.name),
      el('div', { className: 'cards' }, group.scenes.map((s) => sceneCard(s, false)))
    ))
  );
}
