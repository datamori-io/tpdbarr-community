/*
 * How much of a catalogue you hold, wherever that gets asked — the badge on a
 * shelf tile, the bar on a studio or performer, and the three views of one
 * shelf that a tracked subject gets. See discover.mjs for the measurement.
 */

import { api, el } from '../util.js';
import { stashdbCard } from '../catalogue.js';
import { head, showMore, view } from './core.js';
import { entityTile, grid, tile, trackedRail } from './tiles.js';

/* --------------------------------------------------- studio and performer
 *
 * The two library pages with a catalogue on them.
 *
 * Every other page here answers "what do I have". A studio and a performer are
 * where the other half is worth asking on the same screen — what did they put
 * out, and what of it is missing — so both carry three views of one shelf:
 * what you hold, counted in Stash; what you do not, from StashDB; and both
 * together. On a studio the cast rail filters all three, because "what did she
 * film for them" is the same question asked of each; a performer has no such
 * rail, because there the cast is the subject.
 *
 * The percentage needs tracking turned on. It is the same measurement the
 * Acquire page shows and it costs a catalogue read, which is not something to
 * do on every page load — so the button is the switch. See discover.mjs.
 *
 * Nothing here is in the address. The view and the cast filter are how you are
 * reading this page rather than which page it is, and re-reading the studio
 * every time you change your mind would cost a pass over its whole shelf.
 */

const CATALOGUE_VIEWS = [
  ['have', 'In your library'],
  ['missing', 'Missing'],
  ['both', 'Everything'],
];

/*
 * The two things in this library that have a catalogue behind them.
 *
 * A studio and a performer are the same page asked about a different subject:
 * what do I hold, what did I say I wanted and have not got, what is there at
 * all. Everything the three views do differently for the two is in here rather
 * than in them — which shelf to page, which StashDB filter, and the word for
 * "of this one" in an empty state. Two copies of those views would be two
 * answers waiting to disagree, the same reason the scene card is shared.
 */
export const SUBJECTS = {
  studio: {
    kind: 'studio',
    noun: 'studio',
    of: (data) => data.studio,
    held: (data) => data.held,
    shelf: (id, params) => `/api/library/studios/${id}?${params}`,
    // Reads after "Nothing", "Everything you tracked" and "StashDB lists
    // nothing", so it has to work in all three.
    from: 'from this studio',
  },
  performer: {
    kind: 'performer',
    noun: 'performer',
    of: (data) => data.performer,
    held: (data) => data.count,
    shelf: (id, params) => `/api/library/performers/${id}?${params}`,
    from: 'of theirs',
  },
};

export function trackButton({ stashdbId, tracked, noun }, track) {
  const button = el('button', { className: 'add' + (tracked ? ' on' : ''), type: 'button' },
    tracked ? 'Tracked' : `Track this ${noun}`);

  if (!stashdbId) {
    button.disabled = true;
    button.title = `No StashDB id on this ${noun} — there is nothing to measure it against.`;
    return button;
  }

  button.title = tracked ? 'Stop measuring this' : 'Measure how much of that catalogue you hold';
  button.onclick = async () => {
    button.disabled = true;
    try {
      await track();
    } catch (err) {
      button.disabled = false;
      alert(err.message);
    }
  };

  return button;
}

/*
 * The three views, with the numbers on them.
 *
 * What you hold is always countable. What is missing is not, until the studio
 * is tracked and measured — so those two carry a number once there is one, and
 * none rather than a wrong one until then.
 */
export function viewBar({ subject, data, view, performer }, pick, filterBy) {
  const subjectData = subject.of(data);
  const catalogue = Boolean(subjectData.stashdbId && data.stashdb?.available);
  const measured = data.coverage && !data.coverage.pending ? data.coverage : null;
  const counts = {
    have: subject.held(data),
    missing: data.wanted?.missing ?? null,
    both: measured?.counted ?? null,
  };

  const buttons = CATALOGUE_VIEWS.map(([key, label]) => {
    const count = counts[key];
    const chip = el('button', { type: 'button', className: 'chip' + (key === view ? ' on' : '') },
      count == null ? label : `${label} ${count.toLocaleString()}`);

    if (key !== 'have' && !catalogue) {
      chip.disabled = true;
      chip.title = subjectData.stashdbId
        ? 'StashDB is not available — its token is borrowed from Stash.'
        : `Stash has not identified this ${subject.noun} against StashDB.`;
    } else {
      chip.onclick = () => pick(key);
    }

    return chip;
  });

  const nodes = [el('div', { className: 'viewswitch' }, buttons)];

  if (performer) {
    const clear = el('button', { className: 'chip quiet', type: 'button', title: 'Show the whole studio again' },
      `Only ${performer.name} ✕`);
    clear.onclick = () => filterBy(null);
    nodes.push(clear);
  }

  return nodes;
}

/* What you hold. Stash's own answer, filtered by the cast rail where there is
   one — a performer page has no cast to filter by and never sets it. */
export async function heldView(id, state) {
  const { subject } = state;
  const params = new URLSearchParams({ only: 'scenes' });
  if (state.performer) params.set('performer', state.performer.id);

  // Page one of the unfiltered shelf came with the page; only a filter re-asks.
  const first = state.performer ? await api(subject.shelf(id, params)) : state.data;

  if (!first.scenes.length) {
    return [el('div', { className: 'empty small' }, state.performer
      ? `Nothing of ${state.performer.name}'s from this studio is in your library.`
      : `Nothing ${subject.from} is in your library.`)];
  }

  const shelf = grid(first.scenes);

  return [
    head(`${first.count.toLocaleString()} ${first.count === 1 ? 'scene' : 'scenes'}`, 'in your library, newest first'),
    shelf,
    showMore(first, async (page) => {
      params.set('page', String(page));
      const next = await api(subject.shelf(id, params));
      shelf.append(...next.scenes.map(tile));
    }),
  ];
}

/*
 * What you are missing: the scenes you marked from this subject that are not on
 * the shelf yet.
 *
 * This is your list, not StashDB's arithmetic. A catalogue gap is a fact about
 * StashDB — six hundred scenes you never asked for — and it is on the header as
 * a percentage, which is where a fact like that belongs. This view answers the
 * other question: of the ones I said I wanted, what has not arrived.
 *
 * Nothing is fetched to draw it. The marks carry enough of each scene to redraw
 * the card, and whether it has arrived was asked once when the page loaded.
 */
export function wantedView(state, onChange, redraw) {
  const list = (state.data.wanted?.scenes || []).filter((s) => !s.stash);

  const blind = Boolean(state.performer && !state.performer.stashdbId);
  const shown = state.performer?.stashdbId
    ? list.filter((s) => (s.performers || []).some((p) => p.id === state.performer.stashdbId))
    : list;

  if (!shown.length) {
    return [el('div', { className: 'empty small' },
      state.data.wanted?.count
        ? `Everything you tracked ${state.subject.from} has arrived.`
        : `Nothing tracked ${state.subject.from} yet. Open Everything and mark what you want.`)];
  }

  const cards = el('div', { className: 'cards' });
  for (const scene of shown) {
    const card = stashdbCard(scene, {
      // Untracked from in here, a card is answering a question it is no longer
      // part of, so it goes rather than sitting there relabelled.
      onTrackChange: (_scene, tracked) => {
        if (tracked) return onChange();
        card.remove();
        // The last one out takes the heading with it, or the page is left
        // saying "1 missing" over nothing.
        return cards.childElementCount ? onChange() : Promise.resolve(onChange()).then(redraw);
      },
    });
    cards.append(card);
  }

  return [
    blind
      ? el('p', { className: 'muted small' },
        `Stash has no StashDB id for ${state.performer.name}, so this is everything tracked from the studio.`)
      : null,
    head(`${shown.length.toLocaleString()} missing`, 'tracked, not in your library yet'),
    cards,
  ];
}

/*
 * Everything StashDB has for this subject, with what you hold marked on it and
 * a Track button on every card.
 *
 * Not the union of the two catalogues: a scene you own that StashDB has never
 * listed is on the shelf in the first view and cannot be on this one.
 */
export async function catalogueView(state, onChange) {
  const { subject } = state;

  const params = new URLSearchParams({
    [subject.kind]: subject.of(state.data).stashdbId,
    sort: 'DATE',
    have: 'all',
  });
  const blind = Boolean(state.performer && !state.performer.stashdbId);
  if (state.performer?.stashdbId) params.set('performer', state.performer.stashdbId);

  const first = await api(`/api/acquire/search?${params}`);
  if (!first.available) {
    return [el('div', { className: 'empty small' },
      'StashDB is not available — its token is borrowed from a stash-box in Stash.')];
  }

  const draw = (scenes) => scenes.map((sc) => stashdbCard(sc, { onTrackChange: onChange }));
  const cards = el('div', { className: 'cards' }, draw(first.scenes));

  return [
    blind
      ? el('p', { className: 'muted small' },
        `Stash has no StashDB id for ${state.performer.name}, so the catalogue below is the whole studio.`)
      : null,
    head(`${first.count.toLocaleString()} ${first.count === 1 ? 'scene' : 'scenes'}`, 'on StashDB · yours marked'),
    first.scenes.length
      ? cards
      : el('div', { className: 'empty small' }, `StashDB lists nothing ${subject.from}.`),
    showMore(first, async (page) => {
      params.set('page', String(page));
      const next = await api(`/api/acquire/search?${params}`);
      cards.append(...draw(next.scenes));
    }),
  ];
}

/* ------------------------------------------------------------ what you track
 *
 * A shelf of 1300 people cannot ask about each one: the coverage rows are read
 * once and looked up by StashDB id, which is the only id the two halves share.
 * Not being able to read them at all — no stash-box, StashDB down — leaves
 * every tile untracked, which is the honest answer rather than an error.
 */
const TRACKED = 'Tracked';
const UNTRACKED = 'Not tracked';

export async function trackedRows() {
  const { rows } = await api('/api/acquire/tracked').catch(() => ({ rows: [] }));
  const list = rows || [];

  // Both shapes, because the page asks two things of the one read: is *this*
  // tile tracked, and what is everything I track.
  return { rows: list, byId: new Map(list.map((row) => [`${row.kind}:${row.id}`, row])) };
}

export const trackedOn = (rows, kind, stashdbId) => {
  const row = (stashdbId && rows.get(`${kind}:${stashdbId}`)) || null;
  return { coverage: row, trackedAs: row ? TRACKED : UNTRACKED };
};

/*
 * How much of what you decided you want is on the shelf, as a badge.
 *
 * Only on the ones you track, because the number does not exist for anything
 * else — a badge on every tile is a badge on none of them. A tracked thing
 * with nothing decided yet says so rather than saying 0%, for the same reason
 * the bar does: nought per cent reads as "you have none of this" when you may
 * have all of it.
 */
export function coverageBadge(row) {
  if (!row) return null;
  if (row.pending) return { text: '…', match: 'probable', title: 'Tracked. Measuring against StashDB…' };

  if (!row.counted) {
    return {
      text: '—',
      match: 'probable',
      title: `Tracked. ${(row.undecided || 0).toLocaleString()} scenes, none decided yet.`,
    };
  }

  return {
    text: `${row.pct}%`,
    match: 'coverage',
    title: [
      `${row.have.toLocaleString()} of the ${row.counted.toLocaleString()} you want`,
      row.undecided ? `${row.undecided.toLocaleString()} still to decide` : null,
    ].filter(Boolean).join('\n'),
  };
}

/*
 * What you monitor, at the top of the shelf it is about.
 *
 * The grid below already badges a tracked tile, but a tracked thing is a
 * handful among several hundred, and finding one by scrolling is not finding
 * it. So the same tiles lead the page as a row of their own, in the order the
 * snapshot already puts them in — least complete first, because what the number
 * is for is what is missing.
 *
 * Something you track and hold nothing of still belongs here, and it is the one
 * tile that cannot go to a library page: there is no page for a performer with
 * no files. It goes to the Registry instead, which is where the catalogue is.
 */
export function trackedEntityRail(rows, kind, held) {
  const mine = rows.filter((row) => row.kind === kind);
  if (!mine.length) return null;

  const local = new Map(held.filter((h) => h.stashdbId).map((h) => [h.stashdbId, h]));

  return trackedRail({
    title: 'Monitored',
    note: `the ${kind === 'performer' ? 'performers' : 'studios'} you measure yourself against`,
    count: String(mine.length),
    items: mine.map((row) => {
      const hit = local.get(row.id) || null;
      return entityTile({
        name: row.name,
        shape: kind === 'studio' ? 'logo' : 'portrait',
        image: hit?.art ? `/media/${kind}/${hit.id}` : row.image || null,
        meta: hit ? `${hit.held} in your library` : 'nothing held yet',
        href: hit ? `#/library/${kind}/${hit.id}` : `#/import/video?${kind}=${row.id}`,
        favorite: hit?.favorite,
        badge: coverageBadge(row),
      });
    }),
  });
}
