/* ThePornDB's movies: the poster wall, and one movie's scenes. */

import { api, el } from '../util.js';
import { kindSwitch, sceneCard } from './cards.js';
import { SECTION_OF, countChip, externalLink, link, paint, painterFor, sections, show, state, text } from './core.js';
import { addMissing } from './send.js';

/*
 * ----------------------------------------------------------------- movies
 *
 * TPDB's newest releases as posters. No Add: Whisparr v2 has no movies.
 * Open one to add its scenes.
 */

// Like the scene search, the movie search lives in the address — a shelf you
// found is a place you can go back to.
const moviesHash = (params) => {
  const qs = params.toString();
  return '#/import/video' + (qs ? '?' + qs : '');
};

function goMovies(params) {
  const hash = moviesHash(params);
  if (location.hash === hash) showMovies(params.toString());
  else location.hash = hash;
}

export async function showMovies(qs) {
  const paint = painterFor();
  const params = new URLSearchParams(qs || '');

  paint(sections('#/import/video'), kindSwitch(params, 'movie'), moviePanel(params),
    el('div', { className: 'empty' }, params.get('q') ? 'Searching ThePornDB…' : 'Loading movies…'));

  try {
    renderMovies(paint, params, await api('/api/movies?' + params.toString()));
  } catch (err) {
    paint(sections('#/import/video'), kindSwitch(params, 'movie'), moviePanel(params), el('div', { className: 'empty' }, err.message));
  }
}

/* A search term and an order turn the feed into a shelf. */
const MOVIE_ORDERS = [
  ['date', 'Release date'],
  ['studio', 'Studio'],
  ['title', 'Title'],
];

function moviePanel(params) {
  const box = el('input', {
    type: 'search',
    className: 'bigsearch',
    placeholder: 'Search ThePornDB movies — a title, a studio, a series…',
    value: params.get('q') || '',
    autocomplete: 'off',
    spellcheck: false,
  });

  const form = el('form', { className: 'searchline' }, box, el('button', { className: 'primary', type: 'submit' }, 'Search'));
  form.onsubmit = (e) => {
    e.preventDefault();
    const next = new URLSearchParams(params);
    const term = box.value.trim();
    if (term) next.set('q', term);
    else next.delete('q');
    goMovies(next);
  };

  const sort = el('select', { className: 'control' },
    MOVIE_ORDERS.map(([value, label]) => el('option', { value, selected: params.get('sort') === value }, label))
  );
  if (!params.get('sort')) sort.value = 'date';
  sort.onchange = () => {
    const next = new URLSearchParams(params);
    if (sort.value === 'date') next.delete('sort');
    else next.set('sort', sort.value);
    goMovies(next);
  };

  return el('section', { className: 'searchpanel' },
    form,
    el('div', { className: 'controls' }, el('label', { className: 'control' }, 'Sort by ', sort))
  );
}

function renderMovies(paint, params, data) {
  const { movies, counts, stash } = data;

  if (!data.tpdb?.available) {
    paint(sections('#/import/video'), kindSwitch(params, 'movie'), el('div', { className: 'empty' },
      'Movies come from ThePornDB, and the portal borrows that token from Stash. Connect Stash in Settings.'));
    return;
  }

  const refresh = el('button', { className: 'chip', type: 'button' }, 'Refresh');
  refresh.onclick = async () => {
    refresh.disabled = true;
    refresh.textContent = 'refreshing…';
    try {
      const next = new URLSearchParams(params);
      next.set('refresh', '1');
      renderMovies(paint, params, await api('/api/movies?' + next.toString()));
    } catch (err) {
      refresh.disabled = false;
      refresh.textContent = 'Refresh';
      alert(err.message);
    }
  };

  /* A Stash group can only be matched by name; the real count is inside. */
  const note = [
    stash.enabled
      ? `${counts.had} of ${counts.total} matched a group in Stash — on name alone, so open one for the scene-by-scene answer`
      : 'connect Stash to see which of these you already hold',
    // A sort over a capped read is a sort over part of the answer, so say so.
    counts.capped ? `read the first ${counts.total} of ${counts.onTpdb.toLocaleString()} on ThePornDB` : null,
  ].filter(Boolean).join(' · ');

  const term = data.query;

  paint(
    sections('#/import/video'),
    kindSwitch(params, 'movie'),
    moviePanel(params),
    el('div', { className: 'feedhead' },
      el('h2', {}, term ? `${counts.total.toLocaleString()} for “${term}”` : 'New movies'),
      el('span', { className: 'muted' }, note),
      el('span', { className: 'spacer' }),
      refresh
    ),
    movies.length
      ? el('div', { className: 'cards' }, movies.map(movieCard))
      : el('div', { className: 'empty small' },
        term ? `ThePornDB has no movies for “${term}”.` : 'ThePornDB returned no movies on this pass.')
  );
}

function movieCard(movie) {
  const src = movie.poster || movie.background;
  const art = el('div', { className: 'cardart portrait' },
    src ? el('img', { src, loading: 'lazy', alt: '' }) : null
  );

  if (movie.date && movie.date > new Date().toISOString().slice(0, 10)) {
    art.append(el('div', { className: 'cardmarks' }, el('span', { className: 'badge upcoming' }, 'Upcoming')));
  }

  const card = el('article', { className: 'card' },
    art,
    el('div', { className: 'cardbody' },
      el('div', { className: 'title' }, movie.title),
      el('div', { className: 'meta' },
        el('span', {}, movie.siteName || ''),
        el('span', {}, movie.date || ''),
        movie.duration ? el('span', {}, movie.duration + ' min') : null
      ),
      /* Only when there's a match; unmatched isn't "Not had". */
      movie.stash
        ? el('div', { className: 'cardstate' },
            el('span', {
              className: 'badge stash-' + movie.stash.match,
              title: `matched on ${movie.stash.via} — ${movie.stash.name}`,
            }, movie.stash.match === 'exact' ? 'In Stash' : 'Probably'))
        : null
    )
  );

  card.onclick = () => { if (movie.guid) location.hash = `#/movie/${movie.guid}`; };
  card.title = movie.performers?.map((p) => p.name).join(', ') || '';
  return card;
}

/* ------------------------------------------------------------ movie page */

export async function showMovie(guid) {
  const paint = painterFor();
  show(paint, SECTION_OF.movie, el('div', { className: 'empty' }, 'Loading movie…'));
  try {
    renderMovie(paint, await api('/api/movies/' + guid));
  } catch (err) {
    show(paint, SECTION_OF.movie, el('div', { className: 'empty' }, err.message));
  }
}

function renderMovie(paint, data) {
  const { movie, counts } = data;
  const src = movie.poster || movie.background;
  const scenes = movie.scenes || [];
  const notHad = scenes.filter((s) => s.status === 'absent' && !s.stash).length;
  const redraw = () => renderMovie(paint, data);

  const meta = [
    movie.siteId ? link(movie.siteName || 'site', `#/site/${movie.siteId}`) : text(movie.siteName),
    movie.network && movie.network !== movie.siteName ? text(movie.network) : null,
    text(movie.date),
    movie.duration ? text(movie.duration + ' min') : null,
    movie.directors?.length ? text('dir. ' + movie.directors.join(', ')) : null,
  ].filter(Boolean);

  const state = el('div', { className: 'detailstate' });
  if (movie.stash) {
    state.append(el('span', { className: 'badge stash-' + movie.stash.match },
      movie.stash.match === 'exact' ? 'In Stash' : 'Probably in Stash'));
    state.append(el('span', { className: 'muted' }, `matched on ${movie.stash.via} — ${movie.stash.name}`));
  }

  const performers = movie.performers?.length
    ? el('div', { className: 'chips' }, movie.performers.map((p) =>
        p.uuid
          ? el('a', { className: 'chip person', href: `#/performer/${p.uuid}` }, p.name)
          : el('span', { className: 'chip person' }, p.name)
      ))
    : null;

  const tags = movie.tags?.length
    ? el('div', { className: 'chips' }, movie.tags.map((t) => el('span', { className: 'chip quiet' }, t)))
    : null;

  const head = el('div', { className: 'detail' },
    src ? el('div', { className: 'detailart portrait' }, el('img', { src, alt: '' })) : null,
    el('div', {},
      el('h1', {}, movie.title),
      el('div', { className: 'detailmeta' }, meta),
      state.childElementCount ? state : null,
      el('div', { className: 'counts' },
        countChip('scenes', counts.total),
        countChip('in Stash', counts.inStash),
        countChip('in Whisparr', counts.downloaded + counts.monitored),
        countChip('you do not have', notHad)
      ),
      performers,
      movie.overview ? el('p', { className: 'overview' }, movie.overview) : null,
      tags,
      externalLink(movie.url, 'View on ThePornDB')
    )
  );

  /* Add the movie's scenes that neither system holds. */
  const toolbar = el('div', { className: 'toolbar' }, el('span', { className: 'spacer' }));
  if (notHad) {
    const add = el('button', { className: 'primary', type: 'button' }, `Add the ${notHad} you do not have`);
    add.onclick = () => addMissing(scenes, add, redraw);
    toolbar.append(add);
  }

  show(paint, SECTION_OF.movie, head,
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Scenes in this movie'),
      el('span', { className: 'muted' }, 'each one adds to Whisparr on its own')
    ),
    toolbar,
    scenes.length
      ? el('div', { className: 'cards' }, scenes.map((s) => sceneCard(s, false)))
      : el('div', { className: 'empty small' }, 'ThePornDB lists no scenes inside this movie.')
  );
}
