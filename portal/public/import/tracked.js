/* The catalogues you measure yourself against, and the want list. */

import { api, el } from '../util.js';
import { coverageBar, stashdbCard } from '../catalogue.js';
import { SECTION_OF, paint, painterFor, recall, remember, show, state } from './core.js';
import { initial } from '../library/core.js';
import { acquireRun, goAcquire, nextAcquireRun } from './search.js';
import { rulesPanel } from './rules.js';

/*
 * ================================================================= tracked
 *
 * The catalogues being measured, as their own page.
 */

export async function showTracked() {
  const paint = painterFor();
  const body = el('div', {});
  const mine = nextAcquireRun();

  show(paint, SECTION_OF.tracked,
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Tracked'),
      el('span', { className: 'muted' },
        'the catalogues you measure yourself against — search a studio or performer to add one')
    ),
    body);

  if (!state?.stash?.enabled) {
    body.replaceChildren(el('div', { className: 'empty' }, 'Tracking is counted in Stash. Connect it in Settings.'));
    return;
  }

  renderTracked(body, mine);
}

/* A grid per kind (performers, studios, tags), three rows per tab, then Show more. */

const TRACK_ROWS = 3;

/* The three kinds. `kind` is what the record carries and the untrack route takes. */
const TRACK_KINDS = [
  ['performer', 'Performers', 'the people you follow'],
  ['studio', 'Studios', 'the catalogues you measure yourself against'],
  ['tag', 'Tags', 'subjects you dip into — a percentage of one means little'],
];

/* The five tabs. `open` is each tab's own count; Rules has none. */
const TABS = [
  ['performer', 'Performers'],
  ['studio', 'Studios'],
  ['scenes', 'Scenes'],
  ['tag', 'Tags'],
  ['rules', 'Rules'],
];

const TAB_KEY = 'tracked.tab';

/* Tabs are built once and hidden, not rebuilt, so they come back as you left them. */
async function renderTracked(body, mine) {
  body.replaceChildren(el('div', { className: 'empty' }, 'Loading what you track…'));

  let snapshot;
  try {
    snapshot = await api('/api/acquire/tracked');
  } catch (err) {
    if (mine !== acquireRun) return;
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
    return;
  }
  if (mine !== acquireRun) return;

  const { rows, measuring } = snapshot;

  const band = workBand();
  band.update(rows, measuring);

  /* Catalogue tabs are handed new numbers, not rebuilt (see refresh()). */
  const kinds = new Map(TRACK_KINDS.map(([kind, title, note]) => [kind, trackedSection(kind, title, note)]));
  for (const [kind, section] of kinds) section.update(rows.filter((row) => row.kind === kind));

  /* The rules panel is built once; saving a rule only re-reads the numbers. */
  const rules = rulesPanel(() => refresh());

  const panels = new Map([
    ['scenes', wantedBand(mine)],
    ['rules', rules],
    ...[...kinds].map(([kind, section]) => [kind, section.node]),
  ]);

  const openOf = (key) => (key === 'rules'
    ? null
    : key === 'scenes'
      ? null
      : rows.filter((row) => row.kind === key).reduce((sum, row) => sum + (row.undecided || 0), 0));

  const strip = el('nav', { className: 'sections subtabs' });
  const links = new Map();

  let current = null;

  const pick = (key) => {
    if (!panels.has(key)) key = TABS[0][0];
    current = key;
    remember(TAB_KEY, key);
    for (const [k, node] of panels) node.hidden = k !== key;
    for (const [k, link] of links) link.classList.toggle('on', k === key);
  };

  /* A tab's label: name and count. One place, used by the refresh too. */
  const labelFor = (key, label, count) => [
    label,
    count ? el('span', { className: 'muted small' }, ' ' + count.toLocaleString()) : null,
  ].filter(Boolean);

  for (const [key, label] of TABS) {
    const link = el('a', { className: 'section', href: '#' + key },
      ...labelFor(key, label, openOf(key)));
    /* A link-looking button; a real link would make the router redraw the page. */
    link.onclick = (e) => { e.preventDefault(); pick(key); };
    links.set(key, link);
    strip.append(link);
  }

  /*
   * Re-read the numbers without touching the page: tabs, open sections and
   * the rules panel stay put.
   */
  let polling = null;
  const refresh = async () => {
    let next;
    try {
      next = await api('/api/acquire/tracked');
    } catch {
      return;
    }
    if (mine !== acquireRun || !body.isConnected) return;

    band.update(next.rows, next.measuring);
    for (const [kind, section] of kinds) section.update(next.rows.filter((row) => row.kind === kind));
    for (const [key, label] of TABS) {
      const count = key === 'rules' || key === 'scenes'
        ? null
        : next.rows.filter((row) => row.kind === key).reduce((sum, row) => sum + (row.undecided || 0), 0);
      links.get(key).replaceChildren(...labelFor(key, label, count));
      links.get(key).classList.toggle('on', key === current);
    }

    // A measurement in flight fills itself in rather than waiting for a reload.
    clearTimeout(polling);
    if (next.measuring) polling = setTimeout(() => { if (body.isConnected) refresh(); }, 4000);
  };

  const anyTracked = TRACK_KINDS.some(([kind]) => rows.some((row) => row.kind === kind));

  body.replaceChildren(...[
    band.node,
    el('div', { className: 'feedhead' },
      el('h2', {}, 'What you track'),
      el('span', { className: 'muted' },
        measuring
          ? 'measuring against StashDB, counted in Stash…'
          : 'how much of each catalogue you hold, counted in Stash')
    ),
    strip,
    anyTracked
      ? null
      : el('div', { className: 'empty small' },
        'Nothing tracked yet. Search for a performer, studio or tag above, then Track this.'),
    ...panels.values(),
  ].filter(Boolean));

  pick(recall(TAB_KEY, TABS[0][0]));

  if (measuring) polling = setTimeout(() => { if (body.isConnected) refresh(); }, 4000);
}

/*
 * The work band: the total to do and one button to start, over every
 * catalogue at once.
 */
function workBand() {
  /* Built once and refilled, so the top of the page doesn't jump. */
  const num = el('div', { className: 'worknum' });
  const numNote = el('div', { className: 'muted small' });
  const across = el('div', {});
  const under = el('div', { className: 'muted small' });
  const tail = el('span', {});

  const node = el('section', { className: 'workband' },
    el('div', { className: 'workcount' }, num, numNote),
    el('div', { className: 'workwords' }, across, under),
    el('span', { className: 'spacer' }),
    tail
  );

  const update = (rows, measuring) => {
    const left = rows.reduce((sum, row) => sum + (row.undecided || 0), 0);
    const ruled = rows.reduce((sum, row) => sum + (row.ruled || 0), 0);
    const waiting = rows.filter((row) => row.pending).length;

    // A zero that is only zero because nothing has been counted yet is the
    // one number this band must not show: it says the job is done.
    num.textContent = waiting && !left ? '—' : left.toLocaleString();
    numNote.textContent = waiting ? 'still to decide so far' : 'still to decide';

    across.textContent = `across ${rows.length.toLocaleString()} catalogue${rows.length === 1 ? '' : 's'} you follow`;
    under.textContent = [
      ruled ? `${ruled.toLocaleString()} held back by your rules` : null,
      // Say how many are still being measured, so the total isn't silently short.
      waiting ? `${waiting} still being measured` : null,
    ].filter(Boolean).join(' · ') || 'one queue, every catalogue, one card at a time';

    tail.replaceChildren(left || measuring
      ? el('a', { className: 'add', href: '#/import/video?show=undecided&pool=1' }, 'Start deciding')
      : el('span', { className: 'muted small' }, 'Nothing waiting on you.'));
  };

  return { node, update };
}

/*
 * One kind, capped at three rows. The row size is read from the laid-out
 * grid (auto-fill).
 */
function trackedSection(kind, title, note) {
  const grid = el('div', { className: 'trackgrid' });
  const more = el('button', { className: 'chip', type: 'button' });
  const count = el('span', { className: 'muted' });
  const empty = el('div', { className: 'empty small', hidden: true },
    `Nothing tracked here yet. Search for ${kind === 'performer' ? 'a performer' : kind === 'studio' ? 'a studio' : 'a tag'}, then Track this.`);

  let rows = [];
  let showing = 0;

  const perRow = () => {
    const style = window.getComputedStyle(grid);
    const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, columns);
  };

  // Set once Show more has been pressed, so a resize does not fold the section
  // back up underneath somebody who has just opened it.
  let opened = false;

  const draw = (want) => {
    showing = Math.min(rows.length, want);
    grid.replaceChildren(...rows.slice(0, showing).map((row) => trackedCard(row)));

    const left = rows.length - showing;
    more.hidden = left <= 0;
    more.textContent = `Show ${left.toLocaleString()} more`;
  };

  more.onclick = () => { opened = true; draw(rows.length); };

  /* New numbers, same section; how far it's open survives. */
  const update = (next) => {
    /* Most still-to-decide first. Still-measuring catalogues go last. */
    rows = [...next].sort((a, b) =>
      (a.pending ? 1 : 0) - (b.pending ? 1 : 0)
      || (b.undecided || 0) - (a.undecided || 0));

    count.textContent = `${rows.length.toLocaleString()} · ${note}`;

    // A kind you follow nothing of still has a tab, so it has to say so
    // rather than showing an empty grid and leaving you wondering.
    if (!rows.length) {
      grid.replaceChildren();
      more.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    draw(opened ? rows.length : Math.max(showing, TRACK_ROWS * 6));
  };

  /*
   * Correct the row count once the grid has a width. A ResizeObserver, not
   * rAF (rAF doesn't fire in a background tab).
   */
  const watch = new ResizeObserver(() => {
    if (opened) return;
    /* A hidden tab has no width; skip rather than fold to three cards. */
    if (!grid.clientWidth) return;
    const want = TRACK_ROWS * perRow();
    if (want !== showing && !(showing === rows.length && want > rows.length)) draw(want);
  });
  /* No explicit teardown: the observer goes with its target. */
  watch.observe(grid);

  const node = el('div', { className: 'tracksection' },
    el('div', { className: 'feedhead sub' },
      el('h3', {}, title),
      count
    ),
    grid,
    empty,
    more
  );

  return { node, update };
}

/*
 * One catalogue as a card; the card opens its decide queue. No untrack
 * here — that's on the catalogue's own page, behind a question (see
 * subjectBody in cards.js).
 */
function trackedCard(row) {
  const go = (show) => {
    const params = new URLSearchParams();
    params.append(row.kind, row.id);
    if (show) params.set('show', show);
    goAcquire(params);
  };

  const art = row.image
    ? el('img', { className: 'trackart ' + row.kind, src: row.image, loading: 'lazy', alt: '' })
    : el('div', { className: 'trackart noart ' + row.kind }, initial(row.name));

  /*
   * A percentage where it's meaningful (coverageSnapshot in discover.mjs),
   * otherwise how many are left to answer.
   */
  const line = row.pending
    ? el('div', { className: 'muted small' }, 'Measuring…')
    : row.honest
      ? coverageBar(row)
      : el('div', { className: 'trackloose muted small' },
        `${(row.undecided || 0).toLocaleString()} still to decide`,
        el('span', { className: 'trackwhy', title: `${(row.total || 0).toLocaleString()} scenes on StashDB — too many for a percentage, so this counts what is left to answer.` }, ' ?')
      );

  /* What the rules are holding back, on both kinds of card. */
  const ruled = row.ruled
    ? el('div', { className: 'trackruled muted small' }, `${row.ruled.toLocaleString()} held back by your rules`)
    : null;

  const card = el('article', { className: 'trackcard ' + row.kind },
    art,
    el('div', { className: 'trackbody' },
      el('div', { className: 'title' }, row.name),
      line,
      ruled
    )
  );

  card.title = row.pending
    ? row.name
    : `${row.name} — ${(row.undecided || 0).toLocaleString()} still to decide`
      + (row.ruled ? `, and ${row.ruled.toLocaleString()} your rules are holding back` : '');

  // Deciding is the job; the gap list is one press further in, from there.
  card.onclick = () => go(row.undecided ? 'undecided' : null);

  return card;
}

/* Every scene you've marked, loaded after the page draws. */
/*
 * The want list; by default only scenes no tracked catalogue covers (see
 * orphaned() in discover.mjs). A toggle shows all.
 */
function wantedBand(mine) {
  const holder = el('section', { className: 'feed' });
  let loose = true;

  const load = async () => {
    const list = await api('/api/acquire/tracked/scenes' + (loose ? '' : '?loose=0'));
    if (mine !== acquireRun) return;
    holder.replaceChildren(...wantedBody(list, load, {
      loose,
      onToggle: (on) => { loose = on; load().catch(() => {}); },
    }));
  };

  load().catch(() => {});
  return holder;
}

/* Missing first, then arrived. Arrived ones can still be untracked here. */
function wantedBody(list, reload, { loose = true, onToggle = null } = {}) {
  if (!list.count && !list.all) return [];

  /* Having a file anywhere counts (same as haveFile() in discover.mjs). */
  const have = (s) => Boolean(s.stash || s.whisparr3?.hasFile);

  const missing = list.scenes.filter((s) => !have(s));
  const arrived = list.scenes.filter((s) => have(s));

  const card = (scene) => stashdbCard(scene, { onTrackChange: () => reload().catch(() => {}) });

  const tick = el('input', { type: 'checkbox', checked: loose });
  tick.onchange = () => onToggle?.(tick.checked);

  const hidden = Math.max(0, (list.all || 0) - list.count);

  const only = el('label', { className: 'check wantonly', title: 'Scenes whose studio and cast are not tracked above. Tags are not matched.' },
    tick,
    ' Only the ones nothing above covers',
    hidden ? el('span', { className: 'muted small' }, ` · ${hidden.toLocaleString()} hidden`) : null
  );

  const head = el('div', { className: 'feedhead' },
    el('h2', {}, 'Scenes you are after'),
    el('span', { className: 'muted' },
      [
        `${missing.length.toLocaleString()} still missing`,
        arrived.length ? `${arrived.length.toLocaleString()} arrived` : null,
      ].filter(Boolean).join(' · ')),
    el('div', { className: 'vgap' }),
    only
  );

  return [
    head,
    releaseBar(),
    !list.count
      ? el('div', { className: 'empty small' }, 'Everything you have marked belongs to something you track.')
      : null,
    missing.length
      ? el('div', { className: 'cards' }, missing.map(card))
      : el('div', { className: 'empty small' }, 'Everything you marked has arrived.'),
    arrived.length
      ? el('div', { className: 'feedhead sub' },
        el('h3', {}, 'Arrived since you marked them'),
        el('span', { className: 'muted' }, 'untrack one to take it off this list'))
      : null,
    arrived.length ? el('div', { className: 'cards' }, arrived.map(card)) : null,
  ].filter(Boolean);
}

/*
 * Send a batch now. The schedule lives in Settings › Sending; the count
 * comes from it.
 */
function releaseBar() {
  const bar = el('div', { className: 'releasebar' });

  const draw = (state) => {
    if (!state.ready) {
      bar.replaceChildren(el('span', { className: 'muted small' },
        'Whisparr v3 needs a root folder and quality profile before anything can be sent.'));
      return;
    }

    const tonight = el('span', { className: 'muted small' },
      state.sending ? 'Sending now…' : state.doneToday ? "Tonight's has gone." : '');

    const now = el('button', { className: 'chip quiet', type: 'button' }, `Send ${state.perDay} now`);
    now.disabled = state.sending || !state.waiting;
    now.title = 'Send a batch straight away. This is on top of tonight’s, not instead of it.';
    now.onclick = async () => {
      now.disabled = true;
      now.textContent = 'Sending…';
      try {
        const out = await api('/api/acquire/release/now', { method: 'POST', body: '{}' });
        bar.replaceChildren(el('span', { className: 'muted small' },
          `Sent ${out.sent.length}${out.failed.length ? `, ${out.failed.length} refused` : ''}. ${out.waiting.toLocaleString()} still waiting.`));
      } catch (err) {
        bar.replaceChildren(el('span', { className: 'muted small' }, err.message));
      }
    };

    bar.replaceChildren(
      now,
      el('span', { className: 'vgap' }),
      tonight,
      // Where the rate lives now, said once rather than explained twice.
      el('a', { className: 'muted small', href: '#/parameters/sending' }, 'Nightly sending')
    );
  };

  api('/api/acquire/release').then(draw).catch(() => {});
  return bar;
}
