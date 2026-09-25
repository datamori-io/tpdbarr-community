/*
 * The search and the decide queue, on one address. StashDB only; ThePornDB
 * is the separate wild card.
 */

import * as shelf from '../shelf.js';
import { api, el } from '../util.js';
import { stashdbCard } from '../catalogue.js';
import { kindSwitch, resultBody, stashdbRow, subjectCard, viewSwitch, wildcardBand } from './cards.js';
import { SECTION_OF, acquireHash, isGrid, isGrouped, paint, painterFor, remember, show, state } from './core.js';
import { showMovies } from './movies.js';
import { showMonitored } from './monitored.js';
import { chip, siteRow } from './site.js';

/*
 * One box, three sources, each block drawn when its source answers: your
 * library, StashDB, then ThePornDB (which can take twenty seconds).
 */
export async function showSearch(query) {
  const paint = painterFor();
  const q = encodeURIComponent(query);

  const library = el('div', {});
  const stashdb = el('div', {});
  const sites = el('div', {});
  const waiting = el('div', { className: 'empty' }, 'Searching…');
  paint(waiting, library, stashdb, sites);

  const head = (title, subtitle) =>
    el('div', { className: 'listhead' }, el('h1', {}, title), el('p', { className: 'muted' }, subtitle));

  let outstanding = 3;
  let found = false;
  let firstError = null;

  // The last one out turns the light off: an empty page only gets to say so
  // once every source has had its say.
  const settled = (filled, error = null) => {
    found = found || filled;
    if (error && !firstError) firstError = error;
    if (--outstanding) return;
    if (found) waiting.remove();
    else waiting.textContent = firstError || `Nothing matching “${query}”.`;
  };

  (state.stash?.enabled ? api('/api/library/search?q=' + q) : Promise.resolve(null))
    .then((mine) => {
      if (!mine?.scenes?.length) return settled(false);
      library.replaceChildren(
        head('In your library', `${mine.count} match${mine.count === 1 ? '' : 'es'} for “${query}”`),
        shelf.tiles(mine.scenes)
      );
      settled(true);
    })
    .catch((err) => settled(false, err.message));

  api('/api/stashdb/search?q=' + q)
    .then((hits) => {
      if (!hits?.available || !hits.scenes.length) return settled(false);

      const shown = hits.scenes.length;
      const more = hits.count > shown ? `, showing the ${shown} newest` : '';

      stashdb.replaceChildren(
        head('On StashDB', `${hits.count} scene${hits.count === 1 ? '' : 's'}${more} — these go to Whisparr v3`),
        el('div', { className: 'scenes' }, hits.scenes.map(stashdbRow))
      );
      settled(true);
    })
    .catch((err) => settled(false, err.message));

  api('/api/sites?q=' + q)
    .then((catalogue) => {
      if (!catalogue.sites.length) return settled(false);
      sites.replaceChildren(
        head('Sites on ThePornDB', 'for scenes StashDB does not have'),
        el('div', { className: 'sitelist' }, catalogue.sites.map(siteRow))
      );
      settled(true);
    })
    .catch((err) => settled(false, err.message));
}

/*
 * ================================================================= the search
 *
 * Every filter goes to StashDB, so counts and paging are real. Filters live
 * in the address. Scenes you already have are hidden by default, with the
 * count and a switch to show them. One date bound: StashDB has no BETWEEN.
 */

const SORT_CHOICES = [
  ['DATE', 'Release date'],
  ['TITLE', 'Title'],
  ['DURATION', 'Length'],
  ['TRENDING', 'Trending'],
  ['POPULARITY', 'Popularity'],
  ['CREATED_AT', 'Newest on StashDB'],
];

const DATE_CHOICES = [
  ['GREATER_THAN', 'released after'],
  ['LESS_THAN', 'released before'],
  ['EQUALS', 'released on'],
];

/* Page size, passed to StashDB (60 is its max). Also the decide batch size. */
const PER_CHOICES = ['24', '36', '48', '60'];
const PER_DEFAULT = '24';

const FACETS = [
  ['performer', 'Performer'],
  ['studio', 'Studio'],
  ['tag', 'Tag'],
];

// Re-running an identical search leaves the hash unchanged and nothing would
// fire, so that one case goes straight to the render.
export function goAcquire(params) {
  const hash = acquireHash(params);
  if (location.hash === hash) showAcquire(params.toString());
  else location.hash = hash;
}

const acquireFiltered = (p) =>
  Boolean(
    // The pooled queue is the one search with no filters in it. It is not an
    // empty box — it is "everything I follow", which is a subject of its own.
    p.get('pool') === '1' ||
      p.get('q') ||
      p.getAll('studio').length ||
      p.getAll('performer').length ||
      p.getAll('tag').length ||
      p.get('date')
  );

// A filter change is a new search, so it always goes back to page one.
function withFilter(params, mutate) {
  const next = new URLSearchParams(params);
  mutate(next);
  next.delete('page');
  return next;
}

export let acquireRun = 0; // the search a returning response has to still belong to

// Bumped from the Tracked page as well, which is no longer the same module.
export const nextAcquireRun = () => (acquireRun += 1);

export async function showAcquire(qs) {
  const params = new URLSearchParams(qs || '');

  /* Scenes (StashDB, to v3) and movies (ThePornDB, scenes to v2) share the page. */
  if (params.get('kind') === 'movie') return showMovies(qs);
  if (params.get('kind') === 'monitored') return showMonitored(qs);

  const paint = painterFor();
  const mine = ++acquireRun;

  const body = el('div', {});
  show(paint, SECTION_OF.search, kindSwitch(params, 'scene'), acquirePanel(params), body);

  if (!state?.stash?.enabled) {
    body.replaceChildren(el('div', { className: 'empty' },
      'The search runs on StashDB, and the portal borrows that token from Stash. Connect Stash in Settings.'));
    return;
  }

  // The tracked catalogues have their own page now, so an empty search is an
  // empty search and says where the other thing went.
  if (!acquireFiltered(params)) {
    const go = el('a', { className: 'link', href: '#/import/tracked' }, 'Tracked');
    body.replaceChildren(el('div', { className: 'empty' },
      'Search StashDB above — or open ', go, ' to work through a catalogue you follow.'));
    return;
  }

  body.replaceChildren(el('div', { className: 'empty' }, 'Searching StashDB…'));

  try {
    const results = await api('/api/acquire/search?' + params.toString());
    if (mine !== acquireRun) return;
    if (!results.available) {
      body.replaceChildren(el('div', { className: 'empty' },
        'StashDB is not available — add a StashDB stash-box with an API key in Stash.'));
      return;
    }
    renderResults(body, params, results);
  } catch (err) {
    if (mine !== acquireRun) return;
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

/* ---------------------------------------------------------------- the panel */

function acquirePanel(params) {
  const box = el('input', {
    type: 'search',
    className: 'bigsearch',
    placeholder: 'Search StashDB — a title, a phrase, a name…',
    value: params.get('q') || '',
    autocomplete: 'off',
    spellcheck: false,
  });

  const form = el('form', { className: 'searchline' },
    box,
    el('button', { className: 'primary', type: 'submit' }, 'Search')
  );

  form.onsubmit = (e) => {
    e.preventDefault();
    goAcquire(withFilter(params, (p) => {
      const term = box.value.trim();
      if (term) p.set('q', term);
      else p.delete('q');
    }));
  };

  return el('section', { className: 'searchpanel' },
    form,
    facetLine(params),
    chipLine(params),
    controlLine(params)
  );
}

/* Filter type-aheads, asked of StashDB so aliases match. */
function facetLine(params) {
  return el('div', { className: 'facetsearch' }, FACETS.map(([kind, label]) => facet(params, kind, label)));
}

function facet(params, kind, label) {
  const input = el('input', {
    type: 'text',
    className: 'facetinput',
    placeholder: label,
    autocomplete: 'off',
    spellcheck: false,
  });

  const menu = el('div', { className: 'facetmenu' });
  const wrap = el('div', { className: 'facetfield' }, input, menu);

  let timer = null;
  let run = 0;

  const close = () => {
    menu.replaceChildren();
    wrap.classList.remove('open');
  };

  const pick = (hit) => {
    input.value = '';
    close();
    goAcquire(withFilter(params, (p) => p.append(kind, hit.id)));
  };

  const look = async () => {
    const term = input.value.trim();
    if (term.length < 2) return close();

    const mine = ++run;
    try {
      const { results } = await api(`/api/acquire/lookup?kind=${kind}&q=` + encodeURIComponent(term));
      if (mine !== run) return;

      if (!results.length) {
        menu.replaceChildren(el('div', { className: 'facetnone' }, 'Nothing on StashDB by that name.'));
        wrap.classList.add('open');
        return;
      }

      menu.replaceChildren(...results.map((hit) => {
        const row = el('button', { type: 'button', className: 'facetrow' },
          hit.image ? el('img', { src: hit.image, loading: 'lazy', alt: '' }) : el('span', { className: 'facedot' }),
          el('span', { className: 'facename' }, hit.name),
          hit.detail ? el('span', { className: 'muted small' }, hit.detail) : null
        );
        row.onclick = () => pick(hit);
        return row;
      }));
      wrap.classList.add('open');
    } catch (err) {
      menu.replaceChildren(el('div', { className: 'facetnone' }, err.message));
      wrap.classList.add('open');
    }
  };

  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(look, 250);
  };
  input.onblur = () => setTimeout(close, 150); // let a click on the row land first
  input.onkeydown = (e) => {
    if (e.key === 'Escape') close();
  };

  return wrap;
}

/* Active filters as removable chips; names fill in from StashDB after drawing. */
function chipLine(params) {
  const row = el('div', { className: 'chips filterchips' });
  const ids = {
    studio: params.getAll('studio'),
    performer: params.getAll('performer'),
    tag: params.getAll('tag'),
  };

  const total = ids.studio.length + ids.performer.length + ids.tag.length;
  if (!total && !params.get('date') && !params.get('q')) return row;

  if (params.get('q')) row.append(filterChip(params, 'q', params.get('q'), `“${params.get('q')}”`));

  for (const [kind, list] of Object.entries(ids)) {
    for (const id of list) row.append(filterChip(params, kind, id, kind + '…'));
  }

  if (params.get('date')) {
    const label = (DATE_CHOICES.find(([op]) => op === (params.get('dateop') || 'GREATER_THAN')) || [])[1];
    row.append(filterChip(params, 'date', params.get('date'), `${label} ${params.get('date')}`));
  }

  if (total) {
    api('/api/acquire/chips?' + new URLSearchParams(
      Object.entries(ids).flatMap(([kind, list]) => list.map((id) => [kind, id]))
    ).toString())
      .then((named) => {
        const names = new Map();
        for (const hit of [...named.studios, ...named.performers, ...named.tags]) names.set(hit.id, hit);
        for (const chip of row.querySelectorAll('[data-id]')) {
          const hit = names.get(chip.dataset.id);
          if (hit) chip.firstChild.textContent = hit.name;
        }
      })
      .catch(() => {});
  }

  const clear = el('button', { type: 'button', className: 'chip quiet' }, 'Clear all');
  clear.onclick = () => goAcquire(new URLSearchParams());
  row.append(clear);

  return row;
}

function filterChip(params, kind, value, label) {
  const chip = el('span', { className: 'chip ' + kind }, el('span', {}, label));
  chip.dataset.id = value;

  const drop = el('button', { type: 'button', className: 'chipx', title: 'Remove this filter' }, '×');
  drop.onclick = () => goAcquire(withFilter(params, (p) => {
    if (kind === 'q' || kind === 'date') {
      p.delete(kind);
      if (kind === 'date') p.delete('dateop');
      return;
    }
    const kept = p.getAll(kind).filter((id) => id !== value);
    p.delete(kind);
    for (const id of kept) p.append(kind, id);
  }));

  chip.append(drop);
  return chip;
}

// Sort, date bound, and the switch that brings owned scenes back.
function controlLine(params) {
  const sort = el('select', { className: 'control' },
    SORT_CHOICES.map(([value, label]) => el('option', { value, selected: params.get('sort') === value }, label))
  );
  if (!params.get('sort')) sort.value = 'DATE';
  sort.onchange = () => goAcquire(withFilter(params, (p) => p.set('sort', sort.value)));

  const dir = el('button', { type: 'button', className: 'chip' },
    params.get('dir') === 'ASC' ? 'Oldest first' : 'Newest first');
  dir.onclick = () => goAcquire(withFilter(params, (p) =>
    p.set('dir', params.get('dir') === 'ASC' ? 'DESC' : 'ASC')));

  const op = el('select', { className: 'control' },
    DATE_CHOICES.map(([value, label]) => el('option', { value, selected: params.get('dateop') === value }, label))
  );
  const when = el('input', { type: 'date', className: 'control', value: params.get('date') || '' });

  const applyDate = () => goAcquire(withFilter(params, (p) => {
    if (when.value) {
      p.set('date', when.value);
      p.set('dateop', op.value);
    } else {
      p.delete('date');
      p.delete('dateop');
    }
  }));
  op.onchange = applyDate;
  when.onchange = applyDate;

  const per = el('select', { className: 'control' },
    PER_CHOICES.map((value) => el('option', { value, selected: (params.get('per') || PER_DEFAULT) === value }, value))
  );
  per.title = 'How many at a time — a page of results, or a batch of the queue.';
  per.onchange = () => goAcquire(withFilter(params, (p) => {
    if (per.value === PER_DEFAULT) p.delete('per');
    else p.set('per', per.value);
  }));

  const owned = el('input', { type: 'checkbox', checked: params.get('have') === 'all' });
  owned.onchange = () => goAcquire(withFilter(params, (p) => {
    if (owned.checked) p.set('have', 'all');
    else p.delete('have');
  }));

  /* Still to decide, or Ignored (the way back to what you skipped). */
  const showing = params.get('show') || 'open';

  const pass = (mode, label, tip) => {
    const chip = el('button', { type: 'button', className: 'chip' + (showing === mode ? ' on' : ''), title: tip }, label);
    chip.onclick = () => goAcquire(withFilter(params, (p) => {
      if (mode === 'open') p.delete('show');
      else p.set('show', mode);
    }));
    return chip;
  };

  return el('div', { className: 'controls' },
    el('label', { className: 'control' }, 'Sort by ', sort),
    dir,
    el('label', { className: 'control' }, op, when),
    el('label', { className: 'control' }, per, ' at a time'),
    el('label', { className: 'check' }, owned, ' Include what I already have'),
    el('span', { className: 'spacer' }),
    el('div', { className: 'viewswitch' },
      pass('open', 'Open', 'Everything except what you have skipped'),
      pass('undecided', 'Still to decide', 'Only the scenes you have not got, wanted or skipped — one at a time, no pages'),
      pass('all', 'Skipped too', 'Show the ones you said no to, so you can undo')
    )
  );
}

/* -------------------------------------------------------------- the results */

function renderResults(body, params, results) {
  if (results.show === 'undecided') return renderDecide(body, params, results);

  const { count, hidden, ignored, scenes } = results;

  const note = el('span', { className: 'muted' });
  let onScreen = scenes.length;

  /*
   * The heading is StashDB's count; the line under it is what's on this page
   * after skipped and held are removed.
   */
  const paintNote = () => {
    note.textContent = [
      `${onScreen} here`,
      hidden ? `${hidden} already in your library, hidden` : null,
      ignored ? `${ignored} skipped, hidden` : null,
    ].filter(Boolean).join(' · ');
  };
  paintNote();

  const head = el('div', { className: 'feedhead' },
    el('h2', {}, count === 1 ? '1 scene on StashDB' : `${count.toLocaleString()} scenes on StashDB`),
    note,
    el('span', { className: 'spacer' }),
    viewSwitch(() => renderResults(body, params, results))
  );

  const kids = [subjectCard(params), head];

  if (scenes.length) {
    kids.push(resultBody(scenes, () => { onScreen -= 1; paintNote(); }));
    kids.push(pager(params, results));
  } else if (hidden) {
    kids.push(el('div', { className: 'empty small' },
      'Every scene on this page is already in your library. Turn on "Include what I already have" to see them.'));
  } else {
    kids.push(el('div', { className: 'empty small' }, 'StashDB has nothing matching those filters.'));
  }

  kids.push(wildcardBand(params));
  body.replaceChildren(...kids.filter(Boolean));
}

/*
 * ------------------------------------------------------------- the queue
 *
 * No pages: filtered-out scenes make page numbers meaningless. Answer a
 * card and it goes; the next batch loads itself. Cards by default, rows
 * available, using the results' remembered view switch.
 */
function renderDecide(body, params, first) {
  const cards = el('div', {});
  const headline = el('h2', {});
  const note = el('span', { className: 'muted' });
  const footer = el('div', {});

  let cursor = first.cursor ?? null;
  let outstanding = first.outstanding ?? null;
  let answered = 0;
  let filling = false;
  /* Scenes the standing rules took out, counted and shown. */
  let ruled = first.ruled || 0;
  // The pooled queue arrives with its total.
  const pooled = Boolean(first.pooled);
  /* Whether this queue is still the page, so a sweep's timer stops writing when you leave. */
  const mineDecide = acquireRun;
  let sweeping = false;

  // What is actually in front of you. Read off the cards rather than off the
  // container, which is a stack of blocks as often as it is a row of cards.
  const onScreen = () => cards.querySelectorAll('[data-scene]').length;

  const paintHead = () => {
    const here = onScreen();
    // The catalogue's own count where known, never less than what's on screen.
    const left = outstanding == null ? here : Math.max(here, outstanding - answered);

    headline.textContent = left === 1 ? '1 still to decide' : `${left.toLocaleString()} still to decide`;
    note.textContent = [
      here ? `${here} on screen` : null,
      answered ? `${answered} answered just now` : null,
      ruled ? `${ruled.toLocaleString()} held back by your rules` : null,
    ].filter(Boolean).join(' · ');
  };

  /*
   * Skip everything on screen, or everything remaining. Both mean the same
   * as a card's Skip, bounded by the current filters.
   */
  const skipAll = el('button', { className: 'chip quiet', type: 'button' });
  const skipRest = el('button', { className: 'chip quiet', type: 'button' });
  const swept = el('span', { className: 'muted small' });

  const bulk = el('div', { className: 'decidebulk' }, skipAll, skipRest, swept);

  const paintBulk = () => {
    const here = onScreen();

    skipAll.textContent = here === 1 ? 'Skip the one on screen' : `Skip all ${here} on screen`;
    skipAll.disabled = !here || sweeping;
    skipAll.title = 'Say “not for me” to every card in front of you. The filters above decide what that is.';

    skipRest.textContent = 'Skip all remaining';
    skipRest.disabled = sweeping;
    skipRest.title = 'Say “not for me” to everything these filters still have to offer, to the end of the catalogue.';
    /* Not on the pooled queue: too broad. */
    skipRest.hidden = pooled;

    bulk.hidden = !here && !sweeping;
  };

  const paintFoot = () => {
    paintBulk();

    if (onScreen()) {
      footer.replaceChildren(bulk);
      return;
    }

    footer.replaceChildren(
      el('div', { className: 'empty small' },
        answered
          ? `That is the lot — ${answered} answered.`
          : 'Nothing left to decide in this catalogue.'),
      bulk
    );
  };

  /* Skip on screen: one request, one write. Cards go after the answer lands. */
  skipAll.onclick = async () => {
    const here = [...cards.querySelectorAll('[data-scene]')];
    const ids = here.map((card) => card.dataset.scene).filter(Boolean);
    if (!ids.length) return;

    skipAll.disabled = true;
    skipAll.textContent = 'Skipping…';

    try {
      await api('/api/acquire/ignored/batch', { method: 'POST', body: JSON.stringify({ ids }) });
      for (const card of here) card.remove();
      held = held.filter((scene) => !ids.includes(scene.id));
      answered += ids.length;
      groups.clear();
      cards.replaceChildren();
      paintHead();
      // Straight on to the next batch, which is what the scroll-and-skip
      // rhythm this exists for actually wants.
      if (!onScreen()) fill();
      paintFoot();
    } catch (err) {
      paintBulk();
      alert(err.message);
    }
  };

  /* Skip the rest runs as a server job; this starts it and polls. */
  let sweepTimer = null;

  const watchSweep = () => {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(async () => {
      if (mineDecide !== acquireRun) return;
      try {
        const found = await api('/api/acquire/skiprest');
        sweeping = Boolean(found.running);
        swept.textContent = found.running
          ? `Skipping the rest — ${found.skipped.toLocaleString()} so far${found.count ? ` of ${found.count.toLocaleString()} read` : ''}…`
          : found.error
            ? found.error
            : found.skipped
              ? `Skipped ${found.skipped.toLocaleString()}.`
              : '';

        if (found.running) { paintBulk(); watchSweep(); return; }

        /* Finished: clear the screen and ask again. */
        answered += onScreen();
        held = [];
        groups.clear();
        cards.replaceChildren();
        cursor = null;
        outstanding = 0;
        paintHead();
        paintFoot();
      } catch {
        sweeping = false;
        paintBulk();
      }
    }, 1500);
  };

  skipRest.onclick = async () => {
    const subject = params.get('studio') || params.get('performer');
    const size = outstanding == null ? 'everything' : `${outstanding.toLocaleString()} scenes`;

    const sure = window.confirm(
      `Skip ${size} — everything these filters still have to offer${subject ? ' in this catalogue' : ''}?

` +
      'They come off the results and out of the percentage. Undo is one at a time, under “Skipped too”.'
    );
    if (!sure) return;

    sweeping = true;
    paintBulk();
    swept.textContent = 'Starting…';

    try {
      await api('/api/acquire/skiprest', {
        method: 'POST',
        // The filters as the address has them, so the sweep reads exactly what
        // this screen was drawn from.
        body: JSON.stringify({ query: params.toString() }),
      });
      watchSweep();
    } catch (err) {
      sweeping = false;
      paintBulk();
      alert(err.message);
    }
  };

  // Wanted, skipped or added: none of those is undecided any more, so the card
  // leaves. A queue that kept what you had answered would be a list.
  const retire = (card) => {
    held = held.filter((scene) => scene.id !== card.dataset.scene);
    // Read before the card leaves, because afterwards there is nothing to ask.
    const block = card.closest('.decideblock');
    card.remove();
    if (block) {
      const mine = [...groups.values()].find((one) => one.section === block);
      if (mine) paintBlock(mine);
    }
    answered += 1;
    paintHead();
    // The bulk button counts what is in front of you, so it moves with this.
    paintFoot();
    if (!cards.childElementCount) fill();
  };

  /* What's on screen as scenes, so switching rows/cards can redraw without refetching. */
  let held = [];

  /*
   * ------------------------------------------------------------- blocks
   *
   * Group cards so one press answers a group. The grouping is whatever still
   * varies: years on a studio's queue, studios on a performer's or a search.
   * Blocks keep arrival order.
   */
  const groups = new Map();
  const byYear = params.getAll('studio').length > 0;

  const blockKey = (scene) => {
    if (byYear) return String(scene.date || '').slice(0, 4) || 'No date';
    return scene.studioName || scene.studio?.name || 'No studio';
  };

  const gridClass = () => (isGrid() ? 'cards resultgrid' : 'scenes');

  // The flat queue's one grid, made on demand so that grouping never leaves an
  // empty container sitting above the blocks.
  let flat = null;

  const makeBlock = (key) => {
    const grid = el('div', { className: gridClass() });
    const count = el('span', { className: 'muted small' });
    const skip = el('button', { className: 'chip quiet', type: 'button' });

    const block = { key, grid, count, skip, section: null };

    skip.onclick = async () => {
      const here = [...grid.querySelectorAll('[data-scene]')];
      const ids = here.map((card) => card.dataset.scene).filter(Boolean);
      if (!ids.length) return;

      skip.disabled = true;
      skip.textContent = 'Skipping…';
      try {
        await api('/api/acquire/ignored/batch', { method: 'POST', body: JSON.stringify({ ids }) });
        held = held.filter((scene) => !ids.includes(scene.id));
        answered += ids.length;
        block.section.remove();
        groups.delete(key);
        paintHead();
        if (!onScreen()) fill();
        paintFoot();
      } catch (err) {
        skip.disabled = false;
        paintBlock(block);
        alert(err.message);
      }
    };

    block.section = el('section', { className: 'decideblock' },
      el('div', { className: 'decideblockhead' },
        el('h3', {}, key),
        count,
        el('span', { className: 'spacer' }),
        skip),
      grid);

    groups.set(key, block);
    cards.append(block.section);
    return block;
  };

  const paintBlock = (block) => {
    const here = block.grid.querySelectorAll('[data-scene]').length;

    // A block nobody is left in is not a block. It goes rather than sitting
    // there as a heading over nothing.
    if (!here) {
      block.section.remove();
      groups.delete(block.key);
      return;
    }

    block.count.textContent = here === 1 ? '1 scene' : `${here} scenes`;
    block.skip.disabled = false;
    block.skip.textContent = here === 1 ? 'Skip it' : `Skip these ${here}`;
    block.skip.title = 'Say “not for me” to every scene in this block.';
  };

  /* Where the next card goes: its block, or the one flat grid. */
  const landing = (scene) => {
    if (!isGrouped()) {
      if (!flat) {
        flat = el('div', { className: gridClass() });
        cards.append(flat);
      }
      return flat;
    }
    return (groups.get(blockKey(scene)) || makeBlock(blockKey(scene))).grid;
  };

  /* Order blocks by their best card. */
  const reorderBlocks = () => {
    if (params.get('rank') !== '1') return;

    const best = (block) => Math.max(0, ...[...block.grid.children]
      .map((card) => Number(card.dataset.score) || 0));

    [...groups.values()]
      .sort((a, b) => best(b) - best(a))
      .forEach((block) => cards.append(block.section));
  };

  const add = (scenes) => {
    for (const scene of scenes) {
      const answers = {
        onTrackChange: (_scene, on) => { if (on) retire(card); },
        onDispose: () => retire(card),
      };
      const card = isGrid() ? stashdbCard(scene, answers) : stashdbRow(scene, answers);
      /* Why this card ranked where it is, in the server's words. */
      if (scene.taste?.why?.length) {
        card.title = scene.taste.why.join('\n');
        if (scene.taste.score >= 25) card.classList.add('likely');
      }
      // Read by "skip all on screen" from the nodes.
      card.dataset.scene = scene.id;
      if (scene.taste) card.dataset.score = String(scene.taste.score);
      held.push(scene);
      landing(scene).append(card);
    }
    for (const block of groups.values()) paintBlock(block);
    reorderBlocks();
    paintHead();
    paintFoot();
  };

  /* Redraw the other shape from what's held. */
  const reshape = () => {
    const again = held;
    held = [];
    groups.clear();
    flat = null;
    cards.replaceChildren();
    add(again);
    // The switches are built knowing which way round they are, so they have to
    // be built again too — left alone they would still be sure.
    paintHeadRow();
  };

  const headRow = el('div', { className: 'feedhead' });

  /* Blocks on or off; redraws what's held. */
  /* Likeliest yes first (taste.mjs). Reloads the queue. */
  function rankSwitch() {
    const on = params.get('rank') === '1';
    const chip = el('button', { type: 'button', className: 'chip' + (on ? ' on' : '') }, 'Best first');
    chip.title = on
      ? 'Ordered by how much of these performers and studios you already own.'
      : 'Put the ones you are likeliest to want at the top of each batch.';
    chip.onclick = () => goAcquire(withFilter(params, (p) => {
      if (on) p.delete('rank');
      else p.set('rank', '1');
    }));
    return chip;
  }

  function blockSwitch() {
    const on = isGrouped();
    const chip = el('button', { type: 'button', className: 'chip' + (on ? ' on' : '') }, 'Blocks');
    chip.title = on
      ? 'Grouped by studio and year, with one Skip for each block.'
      : 'One long queue. Turn this on to answer a studio’s whole year at once.';
    chip.onclick = () => {
      remember('acquire.group', on ? 'off' : 'on');
      reshape();
    };
    return chip;
  }

  function paintHeadRow() {
    headRow.replaceChildren(headline, note, el('span', { className: 'spacer' }),
      el('div', { className: 'viewtools' }, rankSwitch(), blockSwitch()),
      viewSwitch(reshape));
  }

  async function fill(rounds = 0) {
    if (filling) return;
    if (cursor == null || rounds > 20) {
      paintFoot();
      return;
    }

    filling = true;
    if (!cards.childElementCount) {
      footer.replaceChildren(el('div', { className: 'empty small' }, 'Finding the next few…'));
    }

    try {
      const next = new URLSearchParams(params);
      next.set('cursor', String(cursor));
      const res = await api('/api/acquire/search?' + next.toString());

      cursor = res.cursor ?? null;
      filling = false;
      ruled += res.ruled || 0;
      add(res.scenes || []);

      /* An empty batch is progress; ask again. */
      if (!cards.childElementCount && cursor != null) return fill(rounds + 1);
      paintFoot();
    } catch (err) {
      filling = false;
      footer.replaceChildren(el('div', { className: 'empty small' }, err.message));
    }
  }

  add(first.scenes || []);
  paintFoot();
  if (!cards.childElementCount) fill();

  /*
   * The coverage's outstanding count, allowed to fail. Pending (e.g. just
   * after a restart) is retried a few times.
   */
  const subject = params.get('studio') || params.get('performer');

  const readOutstanding = (tries = 0) => {
    if (!subject || tries > 5) return;
    api('/api/acquire/tracked')
      .then(({ rows }) => {
        const row = (rows || []).find((r) => r.id === subject);
        if (!row) return;
        if (row.pending) {
          setTimeout(() => readOutstanding(tries + 1), 4000);
          return;
        }
        outstanding = row.undecided || 0;
        paintHead();
      })
      .catch(() => {});
  };

  readOutstanding();

  paintHeadRow();

  body.replaceChildren(
    pooled
      ? el('section', { className: 'subject pooled' },
        el('div', { className: 'subjectbody' },
          el('div', { className: 'muted small' }, 'Everything you track'),
          el('h2', {}, `${first.catalogues || 0} catalogue${first.catalogues === 1 ? '' : 's'}`),
          el('p', { className: 'muted' },
            'One queue over every studio, performer and tag you follow. Answer a card and it goes; '
            + 'the next batch loads itself.'),
          el('a', { className: 'link', href: '#/import/tracked' }, 'The catalogues, and your rules')))
      : subjectCard(params),
    headRow,
    cards,
    footer
  );
}

function pager(params, { page, perPage, count }) {
  const pages = Math.max(1, Math.ceil(count / perPage));
  if (pages < 2) return null;

  const go = (n) => () => {
    const next = new URLSearchParams(params);
    next.set('page', String(n));
    goAcquire(next);
    window.scrollTo({ top: 0 });
  };

  const back = el('button', { className: 'chip', type: 'button', disabled: page <= 1 }, 'Previous');
  const on = el('button', { className: 'chip', type: 'button', disabled: page >= pages }, 'Next');
  back.onclick = go(page - 1);
  on.onclick = go(page + 1);

  return el('div', { className: 'toolbar' },
    back,
    el('span', { className: 'muted' }, `Page ${page} of ${pages.toLocaleString()}`),
    on
  );
}
