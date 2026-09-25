/* Tiles, facets, rails, and the shared filter bar. */

import { clock, el, folderLine } from '../util.js';
import { blurb } from '../catalogue.js';
import { heading, hoverPreview, initial, loading, onTeardown } from './core.js';

export function tile(scene) {
  /*
   * Through the portal's thumbnail route, so missing covers get a cut frame.
   * A scene with a cover is a remembered redirect.
   */
  const art = el('div', { className: 'tileart' },
    el('img', { src: `/media/scene/${scene.id}/thumb`, loading: 'lazy', alt: '' })
  );

  const marks = el('div', { className: 'tilemarks' });

  /*
   * Bottom left: resolution and status, one colour against the target
   * (720 unless the scene page chose otherwise):
   *
   *   red     bigger than the target, so an encode is still owed
   *   yellow  at or under it, but not finished
   *   green   at or under it, filed in /organized_scenes and organised
   *
   *   Waiting to import  still in /Import Folder or /pc-import
   *   Needs organizing   filed, but not ticked organised in Stash
   *   Filed              filed and organised
   *
   * Films (/movies) are always at target: resolution, no status word.
   */
  const filed = scene.stage === 'library' || scene.stage === 'film';
  const tone = !scene.height || !scene.target ? ''
    : scene.height > scene.target ? 'res-over'
    : filed && scene.organized ? 'res-done'
    : 'res-under';
  const targetNote = scene.target ? ` — target ${scene.target}p` : '';

  if (scene.resolution) {
    marks.append(el('span', { className: `pill ${tone}`, title: `${scene.height}p${targetNote}` }, scene.resolution));
  }

  const status = scene.stage === 'library'
    ? (scene.organized
      ? ['Filed', 'In /organized_scenes and organised in Stash']
      : ['Needs organizing', 'In /organized_scenes, not yet ticked organised in Stash'])
    : scene.stage === 'film' ? null
    : ['Waiting to import', scene.stage === 'editing'
      ? 'In /pc-import — yours to cut and match first'
      : 'In /Import Folder — waiting on FileFlows'];
  if (status) marks.append(el('span', { className: `pill ${tone}`, title: status[1] }, status[0]));
  if (marks.childElementCount) art.append(marks);

  if (scene.duration) art.append(el('div', { className: 'tiletime' }, clock(scene.duration)));

  // How far in you got, the way every player in the world draws it.
  if (scene.progress > 0.01) {
    art.append(el('div', { className: 'tileprogress' },
      el('div', { className: 'tileprogressbar', style: `width:${Math.round(scene.progress * 100)}%` })));
  }

  /* The blurb, cut like the StashDB card's. The hover title stays the cast. */
  const about = blurb(scene.details, scene.title, 140);

  const node = el('article', { className: 'tile' },
    art,
    el('div', { className: 'tilebody' },
      el('div', { className: 'title' + (scene.untitled ? ' untitled' : '') }, scene.title),
      el('div', { className: 'meta' },
        scene.studio ? el('span', {}, scene.studio.name) : null,
        scene.date ? el('span', {}, scene.date) : null
      ),
      folderLine(scene.path, 'tilefolder'),
      about ? el('div', { className: 'tiledesc' }, about) : null
    )
  );

  node.title = scene.performers.map((p) => p.name).join(', ') || '';
  node.onclick = () => { location.hash = `#/library/scene/${scene.id}`; };
  hoverPreview(node, art, scene.id);
  return node;
}

// ------------------------------------------------------------------- rails

export function rail(spec) {
  const track = el('div', { className: 'railtrack' }, spec.scenes.map(tile));

  const heading = spec.href
    ? el('a', { className: 'railtitle', href: spec.href }, spec.title, el('span', { className: 'chevron' }, '›'))
    : el('h2', { className: 'railtitle' }, spec.title);

  const nudge = (direction) =>
    track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: 'smooth' });

  const left = el('button', { className: 'railnav left', type: 'button', ariaLabel: 'Scroll left' }, '‹');
  const right = el('button', { className: 'railnav right', type: 'button', ariaLabel: 'Scroll right' }, '›');
  left.onclick = () => nudge(-1);
  right.onclick = () => nudge(1);

  const ends = () => {
    left.hidden = track.scrollLeft < 8;
    right.hidden = track.scrollLeft + track.clientWidth > track.scrollWidth - 8;
  };
  track.addEventListener('scroll', ends, { passive: true });
  requestAnimationFrame(ends);

  return el('section', { className: 'rail' },
    el('div', { className: 'railhead' },
      heading,
      spec.note ? el('span', { className: 'muted' }, spec.note) : null,
      spec.count ? el('span', { className: 'railcount' }, spec.count) : null
    ),
    el('div', { className: 'railbody' }, left, track, right)
  );
}

export function grid(scenes) {
  return el('div', { className: 'tiles' }, scenes.map(tile));
}

// For the shared search page, which shows library hits above TPDB sites.
export const tiles = grid;

export function entityTile(spec) {
  const picture = spec.image ? el('img', { src: spec.image, loading: 'lazy', alt: '' }) : null;

  // Which part of the picture survives the crop. Only galleries set this; the
  // rest centre, which is what object-fit does on its own.
  if (picture && spec.focus) {
    picture.style.objectPosition = `${spec.focus.x}% ${spec.focus.y}%`;
  }

  const art = el('div', { className: 'facetart ' + (spec.shape || 'portrait') },
    picture || el('span', { className: 'facetblank' }, initial(spec.name))
  );
  if (spec.favorite) art.append(el('span', { className: 'fav', title: 'Favourite in Stash' }, '★'));

  /* How much of a film you hold; the class says how sure the count is. */
  if (spec.badge) {
    art.append(el('span',
      { className: 'holdbadge ' + (spec.badge.match || 'probable'), title: spec.badge.title || '' },
      spec.badge.text));
  }

  // How far in you got, drawn the way every player draws it.
  if (spec.progress > 0.01) {
    art.append(el('div', { className: 'tileprogress' },
      el('div', { className: 'tileprogressbar', style: `width:${Math.round(spec.progress * 100)}%` })));
  }

  const node = el('article', { className: 'facet' + (spec.faded ? ' faded' : '') },
    art,
    el('div', { className: 'facetbody' },
      el('div', { className: 'title' }, spec.name),
      el('div', { className: 'meta' }, spec.meta)
    )
  );

  /* A tile links, acts, or neither (then it doesn't look clickable). */
  if (spec.href) {
    node.onclick = () => { location.hash = spec.href; };
  } else if (spec.onPick) {
    node.onclick = spec.onPick;
  } else {
    node.classList.add('inert');
  }
  node.dataset.name = String(spec.name).toLowerCase();
  return node;
}

/* The "missing" row, as a rail so it doesn't bury what you hold. */
function sideRail(spec) {
  const track = el('div', { className: 'railtrack' }, spec.items);

  const nudge = (direction) =>
    track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: 'smooth' });

  const left = el('button', { className: 'railnav left', type: 'button', ariaLabel: 'Scroll left' }, '‹');
  const right = el('button', { className: 'railnav right', type: 'button', ariaLabel: 'Scroll right' }, '›');
  left.onclick = () => nudge(-1);
  right.onclick = () => nudge(1);

  const ends = () => {
    left.hidden = track.scrollLeft < 8;
    right.hidden = track.scrollLeft + track.clientWidth > track.scrollWidth - 8;
  };
  track.addEventListener('scroll', ends, { passive: true });
  requestAnimationFrame(ends);

  return el('section', { className: 'rail ' + (spec.className || 'missing') },
    el('div', { className: 'railhead' },
      el('h3', { className: 'railtitle' }, spec.title),
      el('span', { className: 'muted' }, spec.note),
      spec.count ? el('span', { className: 'railcount' }, spec.count) : null
    ),
    el('div', { className: 'railbody' }, left, track, right)
  );
}

export const missingRail = (spec) => sideRail({ ...spec, className: 'missing' });

/* The same rail, as a panel that opens a page. */
export const trackedRail = (spec) => sideRail({ ...spec, className: 'monitored' });

// A name filter over a grid that is already rendered. Hides rather than
// rebuilds, so six hundred portraits are not re-fetched on a keystroke.
function nameFilter(grid, total) {
  const box = el('input', {
    type: 'search',
    className: 'filter',
    placeholder: 'Filter by name…',
    autocomplete: 'off',
    spellcheck: false,
  });
  const shown = el('span', { className: 'muted small' }, '');

  box.oninput = () => {
    const q = box.value.trim().toLowerCase();
    let visible = 0;
    for (const node of grid.children) {
      const hit = !q || node.dataset.name.includes(q);
      node.hidden = !hit;
      if (hit) visible++;
    }
    shown.textContent = q ? `${visible} of ${total}` : '';
  };

  return el('div', { className: 'toolbar' }, box, shown);
}

/*
 * =============================================================== the shelf bar
 *
 * One bar for scenes, performers and studios: search, dropdowns, sort, the
 * address and paging. Each page supplies its items, facets, sorts and card.
 *
 * Each dropdown counts against every other filter, and lists only values
 * on the shelf.
 */

const WALL = 120;

const matchesFacet = (facet, item, value) => !value || facet.of(item).includes(value);

function sifted(items, facets, state, skip = null) {
  const needle = state.q.trim().toLowerCase();
  return items.filter((item) =>
    (!needle || item.haystack.includes(needle)) &&
    facets.every((f) => f === skip || matchesFacet(f, item, state[f.key])));
}

/*
 * Filters live in the address, rewritten in place (a hashchange would
 * rebuild the page on every keystroke).
 */
function readFilters(facets, query, fallback) {
  const from = new URLSearchParams(query || '');
  const state = { q: from.get('q') || '', sort: from.get('sort') || fallback };
  for (const f of facets) state[f.key] = from.get(f.key) || '';
  return state;
}

function writeFilters(section, facets, state, fallback) {
  const out = new URLSearchParams();
  if (state.q.trim()) out.set('q', state.q.trim());
  for (const f of facets) if (state[f.key]) out.set(f.key, state[f.key]);
  if (state.sort !== fallback) out.set('sort', state.sort);

  const query = out.toString();
  history.replaceState(null, '', section + (query ? '?' + query : ''));
}

const isFiltered = (facets, state, fallback) =>
  Boolean(state.q.trim()) || facets.some((f) => state[f.key]) || state.sort !== fallback;

/* Refill dropdowns in place. A chosen value squeezed to nothing keeps its place. */
function fillFacet(select, facet, items, state) {
  const counts = new Map();
  for (const item of items) {
    for (const value of facet.of(item)) counts.set(value, (counts.get(value) || 0) + 1);
  }

  const chosen = state[facet.key];
  if (chosen && !counts.has(chosen)) counts.set(chosen, 0);

  const options = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));

  select.replaceChildren(
    el('option', { value: '' }, `${facet.any} (${items.length})`),
    ...options.map(([value, n]) => el('option', { value }, `${value} (${n})`))
  );
  select.value = chosen;
}

/*
 * -> the page's nodes: heading, bar, wall, Show more. Extra rows are the
 * page's own. The first sort is the default, left out of the address.
 */
export function shelfPage(spec) {
  const { section, title, items, facets, sorts, order, card, wall: wallClass = 'tiles' } = spec;
  const fallback = sorts[0][0];
  const state = readFilters(facets, spec.query, fallback);
  let shown = WALL;

  const note = el('span', { className: 'muted' });
  const wall = el('div', { className: wallClass });
  const more = el('button', { className: 'act showmore', type: 'button' });

  const search = el('input', {
    className: 'filter',
    type: 'search',
    placeholder: spec.placeholder || 'Search this shelf…',
    autocomplete: 'off',
    spellcheck: false,
    value: state.q,
    ariaLabel: spec.placeholder || 'Search this shelf',
  });

  const sort = el('select', { className: 'shelfpick', ariaLabel: 'Sort' },
    sorts.map(([value, label]) => el('option', { value }, label)));
  sort.value = state.sort;

  const clear = el('button', { className: 'act', type: 'button' }, 'Clear');

  /*
   * Random is a sort: kept when narrowing and in the address, but reshuffled
   * each time.
   */
  const dice = new Map();
  const roll = (item) => {
    if (!dice.has(item)) dice.set(item, Math.random());
    return dice.get(item);
  };

  const thrown = el('option', { value: 'random' }, 'Random');

  const shuffle = el('button', {
    className: 'act',
    type: 'button',
    title: 'Shuffle the shelf',
  }, 'Random');

  shuffle.onclick = () => {
    dice.clear();
    state.sort = 'random';
    shown = WALL;
    draw();
  };

  const picks = facets.map((facet) => {
    const select = el('select', { className: 'shelfpick', ariaLabel: facet.any });
    select.onchange = () => { state[facet.key] = select.value; shown = WALL; draw(); };
    return { facet, select };
  });

  const draw = () => {
    writeFilters(section, facets, state, fallback);

    const chosen = sifted(items, facets, state);
    const showing = state.sort === 'random'
      ? chosen.sort((a, b) => roll(a) - roll(b))
      : order(chosen, state.sort);

    for (const { facet, select } of picks) {
      fillFacet(select, facet, sifted(items, facets, state, facet), state);
    }

    note.textContent = showing.length === items.length
      ? `${items.length} ${spec.note}`
      : `${showing.length} of ${items.length}`;

    // Clear is always shown, greyed when there's nothing to clear.
    clear.disabled = !isFiltered(facets, state, fallback);
    shuffle.classList.toggle('on', state.sort === 'random');
    // The sort dropdown grows a Random entry while the shelf is shuffled, so it
    // says what order you are in and picking any other one gets you out of it.
    if (state.sort === 'random') sort.append(thrown); else thrown.remove();
    sort.value = state.sort;

    wall.replaceChildren(...showing.slice(0, shown).map(card));
    more.hidden = showing.length <= shown;
    more.textContent = `Show ${Math.min(WALL, showing.length - shown)} more`;
  };

  let typing = null;
  search.oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(() => { state.q = search.value; shown = WALL; draw(); }, 150);
  };
  onTeardown(() => clearTimeout(typing));

  sort.onchange = () => { state.sort = sort.value; draw(); };
  more.onclick = () => { shown += WALL; draw(); };

  clear.onclick = () => {
    state.q = '';
    state.sort = fallback;
    for (const f of facets) state[f.key] = '';
    search.value = '';
    sort.value = fallback;
    shown = WALL;
    draw();
  };

  draw();

  return [
    el('div', { className: 'feedhead' }, el('h2', {}, title), note),
    el('div', { className: 'shelfbar' }, search, picks.map(({ select }) => select), sort, clear, shuffle),
    wall,
    more,
  ];
}

/*
 * ------------------------------------------------------- people and studios
 *
 * Facets come from the scenes you hold, not Stash's records (whose
 * scene_count includes queued imports). The "nothing held" row stays below,
 * unfiltered.
 */

const NOTHING = { held: 0, studios: new Set(), performers: new Set(), years: new Set(), kinds: new Set(), latest: '' };

export function shelfIndex(scenes, pick) {
  const index = new Map();

  for (const scene of scenes) {
    for (const { id } of pick(scene)) {
      let entry = index.get(id);
      if (!entry) {
        entry = { held: 0, studios: new Set(), performers: new Set(), years: new Set(), kinds: new Set(), latest: '' };
        index.set(id, entry);
      }
      entry.held++;
      entry.kinds.add(scene.kind);
      if (scene.studio) entry.studios.add(scene.studio.name);
      for (const p of scene.performers) entry.performers.add(p.name);
      if (scene.date) {
        entry.years.add(scene.date.slice(0, 4));
        if (scene.date > entry.latest) entry.latest = scene.date;
      }
    }
  }

  return index;
}

export function shaped(item, index) {
  const facts = index.get(item.id) || NOTHING;
  return {
    ...item,
    haystack: item.name.toLowerCase(),
    studios: [...facts.studios],
    performers: [...facts.performers],
    years: [...facts.years],
    kinds: [...facts.kinds],
    latest: facts.latest,
  };
}

/* Most scenes, name, or newest. */
export const PEOPLE_SORTS = [
  ['held', 'Most scenes'],
  ['name', 'Name'],
  ['newest', 'Newest'],
];

export function orderPeople(items, sort) {
  const by = [...items];
  if (sort === 'name') return by.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'newest') {
    return by.sort((a, b) => (b.latest || '').localeCompare(a.latest || '') || b.held - a.held);
  }
  return by.sort((a, b) => b.held - a.held || a.name.localeCompare(b.name));
}
