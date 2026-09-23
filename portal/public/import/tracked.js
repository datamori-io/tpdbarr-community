/* The catalogues you measure yourself against, and the want list. */

import { api, el } from '../util.js';
import { coverageBar, stashdbCard } from '../catalogue.js';
import { SECTION_OF, paint, painterFor, recall, remember, show, state } from './core.js';
import { initial } from '../library/core.js';
import { acquireRun, goAcquire, nextAcquireRun } from './search.js';
import { rulesPanel } from './rules.js';

/* ================================================================= tracked
 *
 * The catalogues being measured. This used to be the bottom of the search page,
 * which meant the thing you check on had to be reached through the thing you
 * do. It is the other way round now.
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

/*
 * What you are measuring yourself against.
 *
 * **Three kinds, three tabs, in the order you acquire by.** It was one list
 * sorted by how complete each was, which put a performer between two studios
 * and made "how am I doing on studios" a question you answered by reading.
 * Performers, studios and tags are different kinds of catalogue and the eye
 * wants them apart.
 *
 * A grid rather than rows. A row is the right shape for something with four
 * controls on it and the wrong one for thirty-six of them — this is a wall you
 * scan for the big numbers, and the artwork is how you find the one you meant.
 * Three rows a tab, then Show more: past that it stops being a glance.
 */

const TRACK_ROWS = 3;

/*
 * The three catalogue kinds, and the words on them. `kind` is what the record
 * carries and what the untrack route takes, so it is not a display choice.
 */
const TRACK_KINDS = [
  ['performer', 'Performers', 'the people you follow'],
  ['studio', 'Studios', 'the catalogues you measure yourself against'],
  ['tag', 'Tags', 'subjects you dip into — a percentage of one means little'],
];

/*
 * The five tabs, and the order they are in.
 *
 * This page was one column and it outgrew it: thirty-three performers, fifteen
 * studios, the tags, the standing answers and a want list of two and a half
 * thousand, all stacked, so every question below the first was reached by
 * scrolling past the answer to one you were not asking. Five tabs is the same
 * split the rest of the portal already uses — one question per view.
 *
 * `open` is what the tab counts in its own strip. Rules has none: a rule is
 * not a thing you have a backlog of.
 */
const TABS = [
  ['performer', 'Performers'],
  ['studio', 'Studios'],
  ['scenes', 'Scenes'],
  ['tag', 'Tags'],
  ['rules', 'Rules'],
];

const TAB_KEY = 'tracked.tab';

/*
 * Built once, kept, and swapped by hiding rather than redrawing.
 *
 * The alternative — build the tab you are on and throw it away when you leave
 * — would re-ask the server for the want list every time you glanced at the
 * rules and back. Nothing on this page is big enough to be worth that, and a
 * tab that comes back exactly as you left it, scroll position and open
 * sections and all, is the whole reason to have tabs.
 */
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

  /*
   * The catalogue tabs. Each keeps its own grid and is handed new numbers
   * rather than rebuilt — see refresh() below for why that matters.
   */
  const kinds = new Map(TRACK_KINDS.map(([kind, title, note]) => [kind, trackedSection(kind, title, note)]));
  for (const [kind, section] of kinds) section.update(rows.filter((row) => row.kind === kind));

  /*
   * The rules panel is built once and never replaced. Saving a rule used to
   * redraw this whole page, which meant the panel you were typing in was torn
   * out from under you and put back as a fresh one — the redraw you could see
   * happening. It stays; only the numbers it moves are re-read.
   */
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

  /*
   * What one tab says: its name, and how much of the page's job is behind it.
   * Written in one place because the refresh below says it again, and a label
   * built twice is a label that goes out of step once.
   */
  const labelFor = (key, label, count) => [
    label,
    count ? el('span', { className: 'muted small' }, ' ' + count.toLocaleString()) : null,
  ].filter(Boolean);

  for (const [key, label] of TABS) {
    const link = el('a', { className: 'section', href: '#' + key },
      ...labelFor(key, label, openOf(key)));
    /*
     * A button in a link's clothing. A real address would go through the
     * router, and the router's answer to #/import/tracked is to draw this page
     * again from nothing — the exact redraw the tabs exist to avoid.
     */
    link.onclick = (e) => { e.preventDefault(); pick(key); };
    links.set(key, link);
    strip.append(link);
  }

  /*
   * Re-read the numbers without touching the page.
   *
   * Called when a rule is saved and while a measurement is in flight. It asks
   * for the snapshot again and hands it to the band and the three grids; the
   * rules panel, the want list, the tab you are on and everything you have
   * expanded stay exactly as they are. This is the difference between "the
   * numbers moved" and "the page reloaded".
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
        'Nothing tracked yet. Search for a performer, a studio or a tag above, then Track this — only what you track gets a percentage.'),
    ...panels.values(),
  ].filter(Boolean));

  pick(recall(TAB_KEY, TABS[0][0]));

  if (measuring) polling = setTimeout(() => { if (body.isConnected) refresh(); }, 4000);
}

/*
 * What there is to do, above what you are measuring.
 *
 * This page was a wall you read percentages off, and the way to actually do
 * something was small grey text on one card at a time. The job is the sum of
 * those numbers, and it belongs at the top in the size it actually is, with
 * the button that starts it.
 *
 * One queue over everything rather than a catalogue you first have to choose:
 * choosing which studio to work on is not part of the work, and it was the
 * part that stopped it happening.
 */
function workBand() {
  /*
   * The band is made once and refilled. A rule saved on the Rules tab moves
   * every number on it, and swapping the node for a new one made the top of
   * the page jump — which read as the whole page reloading even when only two
   * numbers had changed.
   */
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
      // A total missing a catalogue looks like a total, so it says which
      // part of itself is still being worked out rather than quietly
      // being short by it.
      waiting ? `${waiting} still being measured` : null,
    ].filter(Boolean).join(' · ') || 'one queue, every catalogue, one card at a time';

    tail.replaceChildren(left || measuring
      ? el('a', { className: 'add', href: '#/import/video?show=undecided&pool=1' }, 'Start deciding')
      : el('span', { className: 'muted small' }, 'Nothing waiting on you.'));
  };

  return { node, update };
}

/*
 * One kind's worth, capped at three rows until you ask for the rest.
 *
 * How many fit on a row is a CSS answer, not a JS one — the grid is
 * auto-filling and the column count changes with the window — so "three rows"
 * is read back off the laid-out grid rather than assumed. On a narrow screen
 * that is six cards; on a wide one, twenty-one.
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

  /*
   * New numbers, same section. Redrawing the cards is unavoidable — the
   * percentages are on them — but how far the section is open, and which tab
   * you are on, are not the server's business and survive.
   */
  const update = (next) => {
    /*
     * Most open first. This was least-complete-percent, which sorts by the
     * wrong thing: 2% of a catalogue with one scene left in it is finished
     * work, and 34% of one with four hundred to answer for is the job. The
     * page is a queue, so it is ordered by how much queue each one is.
     *
     * A catalogue still being measured has no count yet and goes last rather
     * than being called zero.
     */
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
   * Drawn with a guess, then corrected once the grid has a width — and by an
   * observer rather than an animation frame, because a frame never fires while
   * the tab is in the background and the section would stay at the guess for
   * the rest of the session. The observer also answers the window changing,
   * which is the same question asked again.
   */
  const watch = new ResizeObserver(() => {
    if (opened) return;
    /*
     * A hidden tab has no layout: the grid reports no columns, perRow() falls
     * back to one, and the section would fold itself to three cards while
     * nobody was looking at it. Measuring something with no width answers a
     * question about CSS, not about this page.
     */
    if (!grid.clientWidth) return;
    const want = TRACK_ROWS * perRow();
    if (want !== showing && !(showing === rows.length && want > rows.length)) draw(want);
  });
  /*
   * Not torn down explicitly. The library's onTeardown belongs to the library's
   * router and would fire on a schedule this page does not keep; an observer
   * whose only target has left the document stops firing and is collected with
   * it, which is the whole of the cleanup needed here.
   */
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
 * One tracked catalogue as a card.
 *
 * The whole card is the way in to deciding, because that is what this page is
 * for — a wall of cards with three buttons each is three buttons you have to
 * aim at thirty-six times.
 *
 * **Nothing here untracks.** There used to be a × in the corner of every card,
 * and on a wall you scan and click through, one press in the wrong corner took
 * a studio out of the measurements along with the percentage it was driving.
 * Untracking now lives on the catalogue's own page, one press further in and
 * behind a question — you have to be looking at the thing you are about to
 * stop measuring. See subjectBody in cards.js.
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
   * What the card says under the name. A percentage where one is honest — see
   * coverageSnapshot in discover.mjs — and otherwise the only number that is
   * true of a catalogue too big to measure: how many of it you have not
   * answered for.
   */
  const line = row.pending
    ? el('div', { className: 'muted small' }, 'Measuring…')
    : row.honest
      ? coverageBar(row)
      : el('div', { className: 'trackloose muted small' },
        `${(row.undecided || 0).toLocaleString()} still to decide`,
        el('span', { className: 'trackwhy', title: `StashDB has ${(row.total || 0).toLocaleString()} scenes here — too many to measure a percentage against, so this counts what is left to answer instead.` }, ' ?')
      );

  /*
   * What the rules are holding back, under whichever line this card got. On
   * both kinds of card, because the question it answers — is that number small
   * because I am nearly done, or because a rule is doing the work — is the same
   * question either way.
   */
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

/*
 * Everything you have marked, wherever you marked it.
 *
 * The tracked studios above are a question about catalogues — how much of one
 * do I hold. This is the other list: the individual scenes you said you wanted,
 * gathered from every studio page that made a mark. It fills itself in after
 * the page has drawn, because a want list is not what the page is for and a
 * slow one should not hold up the numbers above it.
 */
/*
 * The want list, and by default only the part of it this page does not already
 * account for.
 *
 * Most of what is on it was marked while working through a studio or a
 * performer above, and those scenes are already counted, measured and queued
 * up there. What is left over is the interesting part — marked off a search,
 * off the feed, off somebody's say-so — and nothing on this page will ever
 * remind you about them again. So that is the default, and the toggle is how
 * you get the whole list back. See orphaned() in discover.mjs, including what
 * it cannot match on.
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

/*
 * Missing first, because that is the list you act on. What has arrived since
 * follows it, marked and still untrackable from here — a want list you cannot
 * cross things off is one that only grows.
 */
function wantedBody(list, reload, { loose = true, onToggle = null } = {}) {
  if (!list.count && !list.all) return [];

  /*
   * Have it, file-wise. Stash is the end of the flow, not the whole of it: a
   * scene v3 has already downloaded and not yet handed over is one you own,
   * and calling it missing sends you looking for something on the disk.
   * Monitored with no file is still missing — the line is the file.
   * Matches haveFile() in discover.mjs, which counts the same thing.
   */
  const have = (s) => Boolean(s.stash || s.whisparr3?.hasFile);

  const missing = list.scenes.filter((s) => !have(s));
  const arrived = list.scenes.filter((s) => have(s));

  const card = (scene) => stashdbCard(scene, { onTrackChange: () => reload().catch(() => {}) });

  const tick = el('input', { type: 'checkbox', checked: loose });
  tick.onchange = () => onToggle?.(tick.checked);

  const hidden = Math.max(0, (list.all || 0) - list.count);

  const only = el('label', { className: 'check wantonly', title: 'Scenes whose studio and cast are not among the catalogues above. Tracked tags are not matched — a want record has never stored a scene’s tags.' },
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
 * Sending a batch out, on the list it comes off.
 *
 * The schedule that used to sit here — send N a night, from N o'clock — moved
 * to Settings > Sending when this page grew tabs: a control you touch twice a
 * year stopped earning a line halfway down one of them. What is left is the
 * thing you press *while looking at the list*, which is not a schedule and
 * does not belong in Settings.
 *
 * The count still has to be fetched, because the button says how many it is
 * about to send and that number is the schedule's, not this page's.
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
