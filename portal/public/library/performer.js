/* One performer: the record, the tracked bar, and their shelf. */

import { api, el } from '../util.js';
import { pictureBox } from './picture.js';
import { coverageBar } from '../catalogue.js';
import { claim, failedIn, holds, loading, loadingIn, shell, spoken, view } from './core.js';
import { vitals } from './facts.js';
import { attachedGalleries, buildPanel, tpdbIdOf } from './galleries.js';
import { SUBJECTS, catalogueView, heldView, trackButton, viewBar, wantedView } from './tracked.js';

export async function showPerformer(id) {
  const mine = claim();
  loadingIn('#/library/performers');
  try {
    const [data, galleryRow] = await Promise.all([
      api(`/api/library/performers/${id}`),
      attachedGalleries(`performer=${id}`, 'pictures filed against them'),
    ]);
    if (!holds(mine)) return;
    performerPage(id, data, galleryRow, mine);
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/performers', err);
  }
}

/*
 * A performer: the studio page's three views, asked of a person. No cast
 * rail. The view isn't in the address.
 */
function performerPage(id, data, galleryRow, mine) {
  const state = { subject: SUBJECTS.performer, data, view: 'have', performer: null };

  // Redrawn in place when IAFD answers, which is why the grid has a box, and
  // why the box is made once out here rather than with the header.
  const box = el('div', {}, vitals(data.performer, null));

  const header = el('div', { className: 'listhead with-portrait person' });
  const bar = el('div', { className: 'toolbar studiobar' });
  const results = el('div', {});

  // The shelf is re-read on a view change and the header is not, so a slow
  // answer landing after you have moved on is dropped rather than drawn.
  let drawing = 0;

  const paintHead = () => header.replaceChildren(...performerHead(id, state, box, track));
  const paintBar = () => bar.replaceChildren(...viewBar(state, pick, () => {}));

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

  const track = async () => {
    const { performer, tracked } = state.data;
    if (tracked) {
      await api(`/api/acquire/tracked/performer/${performer.stashdbId}`, { method: 'DELETE' });
    } else {
      await api('/api/acquire/tracked', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'performer',
          id: performer.stashdbId,
          name: performer.name,
          image: performer.image,
        }),
      });
    }
    await readCoverage();
  };

  /* Re-read only the number; a pending measurement fills itself in. */
  const readCoverage = async () => {
    const { rows } = await api('/api/acquire/tracked');
    if (!holds(mine)) return;
    const row = rows.find((r) => r.kind === 'performer' && r.id === state.data.performer.stashdbId) || null;
    state.data = { ...state.data, coverage: row, tracked: Boolean(row) };
    paintHead();
    paintBar();
    if (row?.pending) laterCoverage();
  };

  const laterCoverage = () =>
    setTimeout(() => { if (holds(mine)) readCoverage().catch(() => {}); }, 4000);

  /* The want list changed: re-read the list and the chip count. */
  const refreshWanted = async () => {
    const { stashdbId } = state.data.performer;
    if (!stashdbId) return;
    const wanted = await api(`/api/acquire/tracked/scenes?performer=${stashdbId}`);
    if (!holds(mine)) return;
    state.data = { ...state.data, wanted };
    paintBar();
  };

  /* The bar goes directly under the record; galleries after the scenes. */
  shell('#/library/performers',
    header,
    bar,
    results,
    // Their photos on ThePornDB are only on offer if Stash identified them
    // there — a performer with no TPDB id has nothing to fetch.
    buildPanel({
      label: 'Add a gallery for them',
      tpdbPerformer: tpdbIdOf(state.data.performer.stash_ids),
      tie: { performerIds: [id] },
    }),
    galleryRow
  );

  paintHead();
  paintBar();
  draw();
  if (state.data.coverage?.pending) laterCoverage();

  /* IAFD after the page draws; failures are silent. */
  api(`/api/library/performers/${id}/iafd`)
    .then(({ iafd, fill }) => {
      if (!iafd || !holds(mine)) return;
      draw(box, id, state.data.performer, iafd, fill || []);
    })
    .catch(() => {});
}

/*
 * Header and tracked bar, repainted when the number lands. The IAFD box is
 * passed in so it isn't rebuilt.
 */
function performerHead(id, state, box, track) {
  const { performer, count, coverage, tracked } = state.data;

  /* How many you hold; the second number is Stash's own count. See STAGES in stashlib. */
  const held = performer.knownScenes > count
    ? `${count} of ${performer.knownScenes} in your library`
    : `${count} in your library`;

  return [
    // .person on the wrapper, because the photograph is bigger here than on
    // the pages that show a poster: this one is the record, not a thumbnail.
    el('img', { className: 'portrait', src: `/media/performer/${id}`, alt: '', loading: 'lazy' }),
    el('div', { className: 'who' },
      el('h1', {}, performer.name,
        performer.favorite ? el('span', { className: 'fave', title: 'A favourite in Stash' }, '★') : null),
      el('p', { className: 'muted' },
        // spoken(), or the line reads FEMALE at somebody.
        [performer.disambiguation, performer.gender && spoken(performer.gender), held]
          .filter(Boolean).join(' · ')),
      box,
      performer.details ? el('p', { className: 'bio' }, performer.details) : null,
      // Under the record rather than over the photograph: this is something
      // you do occasionally, not something you look at.
      pictureBox({
        kind: 'performers',
        id,
        has: Boolean(performer.art),
        name: performer.name,
        onDone: () => showPerformer(id),
      }),
      coverage
        ? coverageBar(coverage)
        : el('p', { className: 'muted small' }, performer.stashdbId
          ? 'Track this performer to measure how much of their catalogue you hold.'
          : 'Stash has not identified this performer against StashDB, so there is no catalogue to measure them against.')
    ),
    trackButton({ stashdbId: performer.stashdbId, tracked, noun: 'performer' }, track),
  ];
}
