/* The library's own cast, and one performer as TPDB has them. */

import { api, el } from '../util.js';
import { sceneCard } from './cards.js';
import { SECTION_OF, countChip, externalLink, paint, painterFor, sections, show } from './core.js';

/* -------------------------------------------------------- performer page */

export async function showPerformer(uuid) {
  const paint = painterFor();
  show(paint, SECTION_OF.performer, el('div', { className: 'empty' }, 'Loading performer…'));
  try {
    renderPerformer(paint, await api('/api/performers/' + uuid));
  } catch (err) {
    show(paint, SECTION_OF.performer, el('div', { className: 'empty' }, err.message));
  }
}

function renderPerformer(paint, { performer, scenes, counts }) {
  // "Do not have" means neither system has it — being in Stash counts as having it.
  const notHad = scenes.filter((s) => s.status === 'absent' && !s.stash).length;

  const facts = performer.facts?.length
    ? el('dl', { className: 'facts' },
        performer.facts.flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, String(value))]))
    : null;

  const head = el('div', { className: 'detail' },
    performer.image ? el('div', { className: 'detailart portrait' }, el('img', { src: performer.image, alt: '' })) : null,
    el('div', {},
      el('h1', {}, performer.name),
      performer.disambiguation ? el('p', { className: 'muted' }, performer.disambiguation) : null,
      el('div', { className: 'counts' },
        countChip('scenes on TPDB', counts.total),
        countChip('in Stash', counts.inStash),
        countChip('in Whisparr', counts.downloaded + counts.monitored),
        countChip('you do not have', notHad)
      ),
      performer.aliases?.length
        ? el('p', { className: 'muted small' }, 'Also known as ' + performer.aliases.join(', '))
        : null,
      performer.bio ? el('p', { className: 'overview' }, performer.bio) : null,
      facts,
      externalLink(performer.url, 'View on ThePornDB')
    )
  );

  show(paint, SECTION_OF.performer, head,
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Scenes'),
      el('span', { className: 'muted' }, 'newest first, straight from ThePornDB')
    ),
    scenes.length
      ? el('div', { className: 'cards' }, scenes.map((s) => sceneCard(s, false)))
      : el('div', { className: 'empty small' }, 'ThePornDB lists no scenes for them.')
  );
}

/*
 * ------------------------------------------------------------- performers
 *
 * Your library's cast. Clicking opens the performer page.
 */

export async function showPerformers() {
  const paint = painterFor();
  paint(sections('#/import/performers'), el('div', { className: 'empty' }, 'Loading performers…'));
  try {
    renderPerformers(paint, await api('/api/creators'));
  } catch (err) {
    paint(sections('#/import/performers'), el('div', { className: 'empty' }, err.message));
  }
}

function renderPerformers(paint, { creators, counts, stash }) {
  if (!stash.enabled) {
    paint(sections('#/import/performers'), el('div', { className: 'empty' },
      'Performers are read from Stash. Connect it in Settings.'));
    return;
  }

  if (!creators.length) {
    paint(sections('#/import/performers'), el('div', { className: 'empty' },
      'No performers in Stash carry a stash-box id yet.'));
    return;
  }

  const grid = el('div', { className: 'creators' }, creators.map(creatorCard));

  /* A name filter that hides tiles rather than rebuilding them. */
  const find = el('input', {
    type: 'search',
    className: 'filter',
    placeholder: 'Filter by name…',
    autocomplete: 'off',
    spellcheck: false,
  });

  const shown = el('span', { className: 'muted small' }, '');

  find.oninput = () => {
    const q = find.value.trim().toLowerCase();
    let visible = 0;
    for (const node of grid.children) {
      const hit = !q || node.dataset.name.includes(q);
      node.hidden = !hit;
      if (hit) visible++;
    }
    shown.textContent = q ? `${visible} of ${creators.length}` : '';
  };

  paint(
    sections('#/import/performers'),
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Performers'),
      el('span', { className: 'muted' },
        `${counts.total} performers in your library that a stash-box knows` +
        (counts.shown < counts.total ? `, the top ${counts.shown} shown` : '') +
        (counts.favourites ? `, ${counts.favourites} favourited` : ''))
    ),
    el('div', { className: 'toolbar' }, find, shown),
    grid
  );
}

function creatorCard(creator) {
  const art = el('div', { className: 'creatorart' },
    el('img', { src: `/media/performer/${creator.id}`, loading: 'lazy', alt: '' })
  );
  if (creator.favorite) art.append(el('span', { className: 'fav', title: 'Favourite in Stash' }, '★'));

  const card = el('article', { className: 'creator' },
    art,
    el('div', { className: 'creatorbody' },
      el('div', { className: 'title' }, creator.name),
      el('div', { className: 'meta' }, `${creator.count} in your library`)
    )
  );

  card.dataset.name = creator.name.toLowerCase();

  /* TPDB uuid opens their page here; StashDB-only goes to the filtered search. */
  card.onclick = () => {
    if (creator.uuid) location.hash = `#/performer/${creator.uuid}`;
    else if (creator.stashdbId) location.hash = `#/import/video?performer=${creator.stashdbId}`;
  };
  return card;
}
