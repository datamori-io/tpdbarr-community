/* One studio: the record, the tracked bar, the cast, and their shelf. */

import { api, el } from '../util.js';
import { coverageBar } from '../catalogue.js';
import { claim, failedIn, holds, loading, loadingIn, shell, view } from './core.js';
import { keepButton, studioFacts } from './facts.js';
import { entityTile, grid, missingRail } from './tiles.js';
import { pictureBox } from './picture.js';
import { SUBJECTS, catalogueView, heldView, trackButton, viewBar, wantedView } from './tracked.js';

export async function showStudio(id) {
  const mine = claim();
  loadingIn('#/library/studios');
  try {
    const data = await api(`/api/library/studios/${id}`);
    if (!holds(mine)) return;
    studioPage(id, data, mine);
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/studios', err);
  }
}

function studioPage(id, data, mine) {
  /*
   * The facts box goes on the state rather than being rebuilt with the header,
   * which repaints whenever a coverage number lands. Redrawing it there would
   * throw away what ThePornDB had already filled in.
   */
  const factsBox = el('div', {}, studioFacts(data.studio, null));
  const state = { subject: SUBJECTS.studio, data: { ...data, factsBox }, view: 'have', performer: null };

  const header = el('header', { className: 'listhead with-portrait' });
  const bar = el('div', { className: 'toolbar studiobar' });
  const cast = el('div', {});
  const results = el('div', {});

  // The shelf is re-read on a filter and the header is not, so a slow answer
  // landing after you have changed your mind is dropped rather than drawn.
  let drawing = 0;

  const paintHead = () => header.replaceChildren(...studioHead(state, track));
  const paintBar = () => bar.replaceChildren(...viewBar(state, pick, filterBy));
  const paintCast = () => cast.replaceChildren(...studioCast(state, filterBy));

  const draw = async () => {
    const run = ++drawing;
    const alive = () => holds(mine) && run === drawing;
    results.replaceChildren(el('div', { className: 'empty small' }, 'Loading…'));
    try {
      const nodes = state.view === 'have'
        ? await heldView(id, state)
        : state.view === 'missing'
          ? wantedView(state, refreshWanted, draw)
          : await catalogueView(state, refreshWanted);
      if (!alive()) return;
      results.replaceChildren(...nodes.filter(Boolean));
    } catch (err) {
      if (!alive()) return;
      results.replaceChildren(el('div', { className: 'empty small' }, err.message));
    }
  };

  const pick = (view) => {
    if (view === state.view) return;
    state.view = view;
    paintBar();
    draw();
  };

  // Clicking the one already picked clears it, which is what a second click on
  // a filter means everywhere else.
  const filterBy = (performer) => {
    state.performer = performer && performer.id === state.performer?.id ? null : performer;
    paintBar();
    paintCast();
    draw();
  };

  const track = async () => {
    const { studio, tracked } = state.data;
    if (tracked) {
      await api(`/api/acquire/tracked/studio/${studio.stashdbId}`, { method: 'DELETE' });
    } else {
      await api('/api/acquire/tracked', {
        method: 'POST',
        body: JSON.stringify({ kind: 'studio', id: studio.stashdbId, name: studio.name, image: studio.image }),
      });
    }
    await readCoverage();
  };

  /*
   * Only the number is re-read. The shelf and the cast have not changed because
   * a percentage arrived, and a measurement in flight fills itself in rather
   * than waiting for a reload — tracking something and watching nothing happen
   * reads as a button that did not work.
   */
  const readCoverage = async () => {
    const { rows } = await api('/api/acquire/tracked');
    if (!holds(mine)) return;
    const row = rows.find((r) => r.kind === 'studio' && r.id === state.data.studio.stashdbId) || null;
    state.data = { ...state.data, coverage: row, tracked: Boolean(row) };
    paintHead();
    paintBar();
    if (row?.pending) laterCoverage();
  };

  const laterCoverage = () =>
    setTimeout(() => { if (holds(mine)) readCoverage().catch(() => {}); }, 4000);

  /*
   * The want list changed under a card. Only the list and the number on the
   * button are re-read — the card that did it has already relabelled itself.
   */
  const refreshWanted = async () => {
    const { stashdbId } = state.data.studio;
    if (!stashdbId) return;
    const list = await api(`/api/acquire/tracked/scenes?studio=${stashdbId}`);
    if (!holds(mine)) return;
    state.data = { ...state.data, wanted: list };
    paintBar();
  };

  shell('#/library/studios', header, bar, cast, results);
  paintHead();
  paintBar();
  paintCast();
  draw();
  if (data.coverage?.pending) laterCoverage();

  /*
   * ThePornDB after the fact, the same as IAFD on a performer. This page is
   * already the slowest in the library — a catalogue, a cast and a shelf — and
   * a fifth request is no reason for any of it to wait. A studio the mirror
   * cannot place, or places ambiguously, simply never fills these in.
   */
  api(`/api/library/studios/${id}/facts`)
    .then(({ site, fill }) => {
      if (!site || !holds(mine)) return;
      const redraw = (rest) => {
        const grid = studioFacts(state.data.studio, site);
        factsBox.replaceChildren(...[grid, rest].filter(Boolean));
      };
      redraw(fill.length ? keepButton(id, state, fill, redraw) : null);
    })
    .catch(() => {});
}

function studioHead({ data }, track) {
  const { studio, held, coverage } = data;

  const art = studio.art
    ? el('img', { className: 'portrait logo', src: `/media/studio/${studio.id}`, alt: '', loading: 'lazy' })
    : el('div', { className: 'portrait logo noposter' });

  /*
   * How much of them you hold, and nothing else. The network used to sit here
   * too and now has a row of its own in the grid below — saying it twice, once
   * plain and once marked as ThePornDB's, reads as two different networks.
   */
  const line = `${held.toLocaleString()} in your library`;

  return [
    art,
    el('div', { className: 'who' },
      el('h1', {}, studio.name),
      el('p', { className: 'muted' }, line),
      data.factsBox,
      studio.details ? el('p', { className: 'bio' }, studio.details) : null,
      pictureBox({
        kind: 'studios',
        id: studio.id,
        // A studio with no logo has nothing to lose, so it is not asked twice.
        has: Boolean(studio.art),
        name: studio.name,
        onDone: () => showStudio(studio.id),
      }),
      coverage
        ? coverageBar(coverage)
        : el('p', { className: 'muted small' }, studio.stashdbId
          ? 'Track this studio to measure how much of its catalogue you hold.'
          : 'Stash has not identified this studio against StashDB, so there is no catalogue to measure it against.')
    ),
    trackButton({ stashdbId: studio.stashdbId, tracked: data.tracked, noun: 'studio' }, track),
  ];
}

/*
 * Who you hold this studio through. Counted in the library rather than in
 * Stash, so "12 here" is twelve you can play, and clicking one asks the same
 * question of whichever view is open.
 */
function studioCast({ data, performer }, filterBy) {
  const cast = data.cast || [];
  if (!cast.length) return [];

  const items = cast.map((p) => {
    const node = entityTile({
      name: p.name,
      image: p.art ? `/media/performer/${p.id}` : null,
      meta: `${p.count} here`,
      onPick: () => filterBy(p),
    });
    if (performer?.id === p.id) node.classList.add('on');
    return node;
  });

  return [missingRail({
    className: 'cast',
    title: 'Cast at this studio',
    note: 'click one for only their scenes here',
    count: String(cast.length),
    items,
  })];
}
