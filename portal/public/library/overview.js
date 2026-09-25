/*
 * The library's front page, and the Stats tab.
 *
 * The Overview is laid out like a video hub: a header with MORE, one big
 * item, the rest small. The Feed, then news (five feeds merged into one
 * stream by date), then the library rails. The pipeline, charts and tidy-up
 * are on #/stats.
 */

import { api, el } from '../util.js';
import { claim, failedIn, failed, heading, holds, loading, loadingIn, page, pct, shell, svg } from './core.js';
import { grid, missingRail, tile } from './tiles.js';

/* --------------------------------------------------------------- overview */

export async function showOverview() {
  const mine = claim();
  loadingIn('#/library');
  try {
    const { rails: rows } = await api('/api/library/overview');
    if (!holds(mine)) return;

    /* Rails in this order; unknown ones are appended. */
    const ORDER = ['continue', 'recent', 'released', 'tracked-performers', 'tracked-studios'];
    const ordered = [
      ...ORDER.map((key) => rows.find((r) => r.key === key)).filter(Boolean),
      ...rows.filter((r) => !ORDER.includes(r.key)),
    ];

    shell('#/library',
      feedHero(),
      newsBand(),
      ordered.map(sceneSection)
    );
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library', err);
  }
}

/*
 * ------------------------------------------------------------- the feed
 *
 * A muted live preview of marker clips from the reel's endpoint, a few
 * seconds each. Ours, then Stash's; unplayable clips are skipped. Stops
 * itself once the video leaves the page.
 */
const TEASE_MS = 6000;

function feedHero() {
  const video = el('video', { className: 'fhvideo', muted: true, playsInline: true, loop: true, autoplay: true });
  video.muted = true;
  const caption = el('div', { className: 'fhcaption' });
  const count = el('span', {}, 'Your markers');
  const chips = el('div', { className: 'fhchips' });

  const go = (query = '') => { location.hash = '#/binge?feed=library' + query; };
  const start = el('button', { className: 'primary fhstart', type: 'button' }, 'Start the feed ', el('span', {}, '→'));
  start.onclick = () => go();

  const screen = el('div', { className: 'fhscreen', title: 'Open the Feed' }, video, caption);
  screen.onclick = () => go();

  const hero = el('section', { className: 'feedhero' },
    screen,
    el('div', { className: 'fhtext' },
      el('div', { className: 'fhkicker' }, 'A new way in'),
      el('h2', { className: 'fhtitle' }, 'The Feed'),
      el('p', { className: 'fhlede' },
        count, ' from your library, one after another. Swipe up for the next, sideways to change feed. ',
        el('b', {}, 'Made for one hand.')),
      chips,
      start)
  );

  const seed = String(Math.floor(Math.random() * 1e9));
  Promise.all([
    api(`/api/library/reel?feed=library&seed=${seed}&page=1`),
    api('/api/library/reel/tags').catch(() => ({ tags: [] })),
  ]).then(([reel, { tags }]) => {
    const items = (reel.items || []).filter((i) => i.kind === 'marker');
    if (reel.count) count.textContent = `${reel.count.toLocaleString()} moments`;
    if (!items.length) { screen.remove(); return; }

    // The tags this page of the shuffle is actually made of, most common first.
    const ids = new Map(tags.map((t) => [t.name, t.id]));
    const tally = new Map();
    for (const i of items) if (ids.has(i.tag)) tally.set(i.tag, (tally.get(i.tag) || 0) + 1);
    [...tally].sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([name]) => {
      const chip = el('button', { className: 'fhchip', type: 'button' }, name);
      chip.onclick = () => go('&tag=' + ids.get(name));
      chips.append(chip);
    });

    let at = -1;
    let timer = null;
    const next = () => {
      clearTimeout(timer);
      if (!video.isConnected) return;
      at = (at + 1) % items.length;
      const item = items[at];
      const fallback = `/media/scene/${item.sceneId}/marker/${item.id}/stream`;
      video.onerror = () => {
        if (video.getAttribute('src') !== fallback) video.src = fallback;
        else next();
      };
      video.poster = `/media/scene/${item.sceneId}/marker/${item.id}/screenshot`;
      video.src = `/media/marker/${item.id}/clip`;
      video.play().catch(() => {});
      caption.replaceChildren(
        item.tag ? el('span', { className: 'fhtag' }, item.tag) : null,
        el('span', { className: 'fhscene' }, item.scene?.title || ''),
        el('span', { className: 'fhwho' }, (item.scene?.performers || []).map((p) => p.name).join(', '))
      );
      timer = setTimeout(next, TEASE_MS);
    };
    next();
  }).catch(() => screen.remove());

  return hero;
}

/*
 * ------------------------------------------------------------------ news
 *
 * The three newest stories as big cards; MORE expands in place.
 */
const LEAD = 3;
const MORE_STEP = 8;

function newsBand() {
  const holder = el('section', { className: 'editorial' });

  api('/api/library/feeds').then((data) => {
    // One stream. Everything the five gave, newest first; an item with no date
    // at all sorts to the bottom rather than to 1970.
    const items = data.feeds
      .flatMap((feed) => feed.items)
      .sort((a, b) => (b.at || 0) - (a.at || 0));

    if (!items.length) {
      holder.replaceChildren(sectionHead('News', 'nothing pulled yet'));
      return;
    }

    const rest = el('div', { className: 'ednews more' });
    let shown = 0;

    const more = el('button', { className: 'edmore', type: 'button' }, 'MORE ', el('span', {}, '→'));
    more.onclick = () => {
      const next = items.slice(LEAD + shown, LEAD + shown + MORE_STEP);
      rest.append(...next.map(newsCard));
      shown += next.length;
      if (LEAD + shown >= items.length) more.remove();
    };

    const sources = new Set(items.map((i) => i.sourceName)).size;

    holder.replaceChildren(
      sectionHead('News', `${sources} publishers, newest first`, more),
      el('div', { className: 'ednews lead' }, ...items.slice(0, LEAD).map(newsCard)),
      rest
    );
  }).catch((err) => {
    holder.replaceChildren(sectionHead('News', err.message));
  });

  return holder;
}

function newsCard(item) {
  const art = el('div', { className: 'edart wide' },
    item.image ? el('img', { src: item.image, loading: 'lazy', alt: '' }) : null
  );

  const card = el('article', { className: 'edcard' },
    art,
    el('div', { className: 'edtext' },
      el('div', { className: 'edtitle' }, item.title),
      el('div', { className: 'edmeta' },
        el('span', {}, item.sourceName),
        item.at ? el('span', {}, new Date(item.at).toLocaleDateString()) : null),
      item.excerpt ? el('p', { className: 'edsummary' }, item.excerpt) : null
    )
  );

  card.onclick = () => window.open(item.link, '_blank', 'noreferrer');
  card.title = item.title;
  return card;
}

/*
 * -------------------------------------------------------- scene sections
 *
 * One scrolling row per shelf; MORE goes to the shelf page.
 */
function sceneSection(row) {
  const scenes = row.scenes || [];
  if (!scenes.length) return null;

  const more = row.href
    ? el('a', { className: 'edmore', href: row.href }, 'MORE ', el('span', {}, '→'))
    : null;

  return el('section', { className: 'editorial' },
    sectionHead(row.title, row.note || countNote(row), more),
    scroller(scenes.map(tile))
  );
}

const countNote = (row) =>
  row.count ? `${row.count.toLocaleString()} in all` : null;

/* Scroller arrows, like `rail()` in tiles.js without its heading. */
function scroller(items) {
  const track = el('div', { className: 'railtrack' }, items);

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

  return el('div', { className: 'railbody' }, left, track, right);
}

/* Small grey uppercase section labels. */
function sectionHead(title, note, action = null) {
  return el('div', { className: 'edhead' },
    el('h2', { className: 'edname' }, title),
    note ? el('span', { className: 'ednote' }, note) : null,
    action
  );
}

/*
 * ----------------------------------------------------------------- stats
 *
 * Its own tab.
 */
export async function showStats() {
  const mine = claim();
  loading();
  try {
    const { inFlight, counts } = await api('/api/library/overview');
    if (!holds(mine)) return;

    // The tidy panel loads separately and is appended; it takes several seconds.
    const tidy = el('div', {});
    const top = counts ? countRow(counts) : null;

    page(
      heading('Stats', 'the pipeline, what the files are, and what Whisparr is still holding'),
      top,
      inFlight.count ? inFlightRail(inFlight) : null,
      tidy
    );

    loadTidy(tidy, mine, top);
  } catch (err) {
    if (!holds(mine)) return;
    failed(err);
  }
}

/*
 * The pipeline bar, left to right as files move; segments proportional.
 * The first (in Whisparr, invisible to Stash) arrives later.
 */
const PIPELINE = [
  { key: 'downloaded', label: 'Downloaded', note: 'in Whisparr, no Stash record yet', href: null },
  { key: 'editing', label: 'Editing', note: 'yours to cut first — /pc-import', href: '#/library/stage/editing' },
  { key: 'encoding', label: 'Encoding', note: 'waiting on FileFlows — /Import Folder', href: '#/library/stage/encoding' },
  { key: 'library', label: 'Filed', note: 'done — /organized_scenes', href: '#/library/stage/library' },
  { key: 'film', label: 'Films', note: 'never through Whisparr — /movies', href: '#/library/stage/film' },
];

function pipeline(stages, downloaded) {
  const counts = { ...stages };
  if (downloaded != null) counts.downloaded = downloaded;

  const shown = PIPELINE.filter((stage) => counts[stage.key] != null);
  const total = shown.reduce((sum, stage) => sum + counts[stage.key], 0) || 1;

  const bar = el('div', { className: 'flow' },
    shown.map((stage) => {
      const n = counts[stage.key];
      const seg = el(stage.href ? 'a' : 'div', {
        className: 'flowseg flow-' + stage.key,
        style: `flex:${Math.max(n, 0)} 0 0`,
        title: `${n} ${stage.label.toLowerCase()} — ${stage.note}`,
        ...(stage.href ? { href: stage.href } : {}),
      });
      // A stage at nought keeps its figure in the key below but takes no width:
      // a visible segment for something that is not there is a lie about shape.
      seg.hidden = n <= 0;
      return seg;
    })
  );

  const keys = el('div', { className: 'flowkeys' },
    shown.map((stage) => {
      const n = counts[stage.key];
      return el(stage.href ? 'a' : 'div', {
        className: 'flowkey flow-' + stage.key + (n > 0 ? '' : ' spent'),
        title: stage.note,
        ...(stage.href ? { href: stage.href } : {}),
      },
        el('span', { className: 'flowdot' }),
        el('b', {}, n.toLocaleString()),
        el('span', { className: 'flowname' }, stage.label)
      );
    })
  );

  return el('section', { className: 'flowpanel' },
    el('div', { className: 'flowhead' },
      el('h2', {}, 'The pipeline'),
      el('span', { className: 'muted small' },
        `${total.toLocaleString()} files, left to right in the order they move`)
    ),
    bar,
    keys
  );
}

/*
 * ------------------------------------------------------------------- cards
 *
 * Small charts, each with the sentence it supports.
 */

const metricCard = (title, headline, sub, chart, href) =>
  el(href ? 'a' : 'section', { className: 'metric', ...(href ? { href } : {}) },
    el('h3', {}, title),
    el('div', { className: 'metricbig' }, headline),
    el('div', { className: 'metricsub' }, sub),
    el('div', { className: 'metricchart' }, chart)
  );

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (key) => MONTHS[Number(key.slice(5, 7)) - 1] || key;

/* Scenes added per month, as bars (discrete totals). */
function growthCard(added) {
  if (!added || !added.length) return null;

  const peak = Math.max(...added.map((m) => m.n), 1);
  const last = added[added.length - 1];
  const total = added.reduce((sum, m) => sum + m.n, 0);
  const width = 100 / added.length;

  const chart = svg('svg', { viewBox: '0 0 100 34', preserveAspectRatio: 'none', class: 'spark' },
    added.map((month, i) => {
      const h = (month.n / peak) * 28;
      return svg('rect', {
        x: (i * width + width * 0.15).toFixed(2),
        y: (30 - h).toFixed(2),
        width: (width * 0.7).toFixed(2),
        height: Math.max(h, month.n ? 0.6 : 0).toFixed(2),
        rx: 0.6,
        // Namespaced: `.bar` is taken, and in SVG2 CSS height beats the attribute.
        class: i === added.length - 1 ? 'sparkbar now' : 'sparkbar',
      });
    }),
    // A baseline, so an empty month reads as nought rather than as missing.
    svg('line', { x1: 0, y1: 30.4, x2: 100, y2: 30.4, class: 'sparkbase' })
  );

  return metricCard(
    'Growing',
    '+' + last.n.toLocaleString(),
    `in ${monthName(last.month)} · ${total.toLocaleString()} over ${added.length} month${added.length === 1 ? '' : 's'}`,
    el('div', {}, chart,
      el('div', { className: 'sparkaxis' },
        el('span', {}, monthName(added[0].month)),
        el('span', {}, monthName(last.month)))),
    '#/library/list/recent'
  );
}

/* A stacked bar, with percentages on segments that have room. */
function stackChart(parts, total) {
  const kept = parts.filter((part) => part.n > 0);

  const bar = el('div', { className: 'stack' },
    kept.map((part) =>
      el('div', {
        className: 'stackseg ' + part.tone,
        style: `flex:${part.n} 0 0`,
        title: `${part.label}: ${part.n.toLocaleString()}`,
      }, pct(part.n, total) >= 12 ? el('span', {}, pct(part.n, total) + '%') : null))
  );

  const keys = el('div', { className: 'stackkeys' },
    kept.map((part) =>
      el('span', { className: 'stackkey ' + part.tone },
        el('i', {}), `${part.label} ${part.n.toLocaleString()}`))
  );

  return el('div', {}, bar, keys);
}

/* Best copy held per scene (tallest file). */
function qualityCard(q) {
  const total = q.uhd + q.hd + q.sd + q.unknown;
  if (!total) return null;

  return metricCard(
    'Quality',
    pct(q.hd + q.uhd, total) + '%',
    'is 1080p or better',
    stackChart([
      { label: '4K', n: q.uhd, tone: 'good' },
      { label: 'HD', n: q.hd, tone: 'mid' },
      { label: 'SD', n: q.sd, tone: 'low' },
      { label: 'No file read', n: q.unknown, tone: 'nil' },
    ], total),
    '#/library/scenes'
  );
}

/* Share ever played, as a ring. */
function watchedCard(w) {
  const total = w.played + w.untouched;
  if (!total) return null;

  const share = (w.played / total) * 100;
  // r chosen so the circumference is 100 and the dash array is a percentage.
  const r = 15.9155;

  const ring = svg('svg', { viewBox: '0 0 40 40', class: 'ring' },
    svg('circle', { cx: 20, cy: 20, r, class: 'ringtrack' }),
    svg('circle', {
      cx: 20, cy: 20, r,
      class: 'ringfill',
      'stroke-dasharray': `${share.toFixed(2)} ${(100 - share).toFixed(2)}`,
      // Start at twelve o'clock rather than three, the way every dial does.
      transform: 'rotate(-90 20 20)',
    })
  );

  return metricCard(
    'Watched',
    pct(w.played, total) + '%',
    `${w.played.toLocaleString()} played · ${w.untouched.toLocaleString()} never opened`,
    el('div', { className: 'ringwrap' }, ring),
    '#/library/list/again'
  );
}

/*
 * Which stash-box each scene is identified against. Unidentified scenes
 * are what coverage, movie match and tidy can't reach.
 */
function identityCard(id) {
  const total = id.stashdb + id.tpdb + id.none;
  if (!total) return null;

  return metricCard(
    'Identified',
    id.none.toLocaleString(),
    `know nothing about themselves · ${pct(id.stashdb + id.tpdb, total)}% matched`,
    stackChart([
      { label: 'StashDB', n: id.stashdb, tone: 'good' },
      { label: 'ThePornDB', n: id.tpdb, tone: 'mid' },
      { label: 'Nothing', n: id.none, tone: 'nil' },
    ], total),
    '#/library/scenes'
  );
}

/* Years covered, as an area. */
function yearsCard(years) {
  if (!years || years.length < 3) return null;

  const peak = Math.max(...years.map((y) => y.n), 1);
  const first = years[0].year;
  const last = years[years.length - 1].year;
  const span = Math.max(last - first, 1);

  const across = (y) => ((y.year - first) / span) * 100;
  const up = (y) => 30 - (y.n / peak) * 27;

  const line = years.map((y, i) => `${i ? 'L' : 'M'}${across(y).toFixed(2)},${up(y).toFixed(2)}`).join(' ');
  const area = `${line} L100,30 L0,30 Z`;
  const busiest = years.reduce((best, y) => (y.n > best.n ? y : best), years[0]);

  return metricCard(
    'Years covered',
    `${first}–${last}`,
    `busiest is ${busiest.year}, with ${busiest.n.toLocaleString()}`,
    el('div', {},
      svg('svg', { viewBox: '0 0 100 32', preserveAspectRatio: 'none', class: 'spark area' },
        svg('path', { d: area, class: 'areafill' }),
        svg('path', { d: line, class: 'arealine' })),
      el('div', { className: 'sparkaxis' }, el('span', {}, first), el('span', {}, last))),
    '#/library/scenes'
  );
}

/* Links to the four sections, smaller than the charts. */
function navRow(counts) {
  const one = (label, held, known, href) =>
    el('a', { className: 'tally', href },
      el('b', {}, String(held)),
      el('span', { className: 'tallylabel' }, label),
      known != null && known > held
        ? el('span', { className: 'tallyrest' }, `${known - held} more known`)
        : null
    );

  return el('div', { className: 'tallies' },
    one('scenes', counts.scenes, null, '#/library/scenes'),
    one('movies', counts.movies.held, counts.movies.known, '#/library/movies'),
    // No second number: a gallery is files or it is nothing.
    one('galleries', counts.galleries ?? 0, null, '#/library/galleries'),
    one('performers', counts.performers.held, counts.performers.known, '#/library/performers'),
    one('studios', counts.studios.held, counts.studios.known, '#/library/studios')
  );
}

/* The top block. Held means everything in Stash. */
function countRow(counts) {
  const charts = counts.charts || {};

  const cards = el('div', { className: 'metrics' },
    growthCard(charts.added),
    charts.quality ? qualityCard(charts.quality) : null,
    charts.watched ? watchedCard(charts.watched) : null,
    charts.identity ? identityCard(charts.identity) : null,
    yearsCard(charts.years)
  );

  const block = el('div', { className: 'overviewtop' },
    counts.stages ? pipeline(counts.stages) : null,
    cards.childElementCount ? cards : null,
    navRow(counts)
  );

  /* Redraw the bar when the Whisparr survey lands. */
  block.redraw = (downloaded) => {
    if (!counts.stages || downloaded == null) return;
    const current = block.querySelector('.flowpanel');
    if (current) current.replaceWith(pipeline(counts.stages, downloaded));
  };

  return block;
}

/* Scenes still in the pipeline, as a rail. */
function inFlightRail(moving) {
  return missingRail({
    title: 'Still moving',
    note: 'yours, not yet filed in /organized_scenes',
    count: moving.count > moving.scenes.length ? `${moving.scenes.length} of ${moving.count}` : null,
    items: moving.scenes.map(tile),
  });
}

export async function showStage(key) {
  const mine = claim();
  loadingIn('#/library');
  try {
    const data = await api(`/api/library/stage/${key}`);
    if (!holds(mine)) return;
    shell('#/library',
      heading(data.label, `${data.count} scene${data.count === 1 ? '' : 's'} in ${data.path}`),
      grid(data.scenes)
    );
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library', err);
  }
}

/*
 * ------------------------------------------------------------------ tidying
 *
 * What Whisparr still holds that Stash has filed. Two buttons: Unmonitor
 * (reversible) and Remove (deletes, after 15 days). A failure draws nothing.
 */
async function loadTidy(mount, mine, top = null) {
  let found;
  try {
    found = await api('/api/tidy');
  } catch {
    return;
  }
  if (!holds(mine)) return;

  // The one stage Stash cannot see, now that something has counted it.
  if (top?.redraw && found.v3?.unseen != null) top.redraw(found.v3.unseen);

  mount.replaceChildren(tidyPanel(found, mount, mine, top));
}

function tidyPanel(found, mount, mine, top = null) {
  const v3 = found.v3 || {};
  const v2 = found.v2 || {};

  const ready = (v3.unmonitor?.length || 0) + (v2.unmonitor?.length || 0);
  const due = v3.due?.length || 0;
  const waiting = v3.waiting?.length || 0;

  // Nothing to do and nothing in flight: say so once, quietly, rather than
  // drawing an empty panel with two dead buttons under it.
  if (!ready && !due && !waiting && !v3.unseen) {
    return el('section', { className: 'tidy quiet' },
      el('span', { className: 'muted small' }, 'Whisparr is holding nothing Stash has already filed.'));
  }

  const status = el('span', { className: 'muted small' }, '');

  const lines = el('div', { className: 'tidylines' },
    v3.unseen
      ? line(`${v3.unseen} downloaded`, 'in Whisparr, no Stash record yet — the stage before /pc-import')
      : null,
    ready
      ? line(`${ready} filed but still monitored`, describeReady(v3, v2))
      : null,
    waiting
      ? line(`${waiting} unmonitored, still inside the ${found.holdDays} days`, 'removable once the wait is up')
      : null,
    due
      ? line(`${due} past ${found.holdDays} days`, 'ready to remove from Whisparr for good')
      : null
  );

  const buttons = el('div', { className: 'tidyacts' });

  if (ready) {
    const unmonitor = el('button', { className: 'act', type: 'button' },
      `Unmonitor the ${ready}`);
    unmonitor.onclick = () => run(unmonitor, '/api/tidy/unmonitor', null, (result) => {
      const n = (result.v3?.count || 0) + (result.v2?.count || 0);
      return `Unmonitored ${n}. The ${found.holdDays}-day clock starts now.`;
    });
    buttons.append(unmonitor);
  }

  if (due) {
    const remove = el('button', { className: 'act danger', type: 'button' },
      `Remove the ${due} from Whisparr`);
    /* confirm(): this deletes files and adds import exclusions. */
    remove.onclick = () => run(
      remove,
      '/api/tidy/remove',
      `Remove ${due} scene${due === 1 ? '' : 's'} from Whisparr, delete the files it grabbed, and stop it fetching them again?

Stash keeps its own copies — that is what the ${found.holdDays}-day wait was checking.`,
      (result) => `Removed ${result.count} from Whisparr.`
    );
    buttons.append(remove);
  }

  async function run(button, path, ask, describe) {
    if (ask && !window.confirm(ask)) return;

    const was = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    status.textContent = '';
    try {
      const result = await api(path, { method: 'POST' });
      status.textContent = describe(result);
      // Re-survey rather than patching the numbers in place: unmonitoring moves
      // rows into the waiting list, and a stale panel would offer them again.
      loadTidy(mount, mine, top);
    } catch (err) {
      button.disabled = false;
      button.textContent = was;
      status.textContent = err.message;
    }
  }

  return el('section', { className: 'tidy' },
    el('div', { className: 'railhead' },
      el('h3', { className: 'railtitle' }, 'Whisparr'),
      el('span', { className: 'muted' }, 'a downloader, not a library')
    ),
    lines,
    /* Not `toolbar`: the tile-size control mounts into the first `.toolbar`. */
    el('div', { className: 'tidybar' }, buttons, status)
  );
}

function line(what, why) {
  return el('div', { className: 'tidyline' },
    el('b', {}, what),
    el('span', { className: 'muted small' }, why)
  );
}

/* Which instance and how it matched: v3 exact (StashDB id), v2 title and date. */
function describeReady(v3, v2) {
  const parts = [];
  if (v3.unmonitor?.length) parts.push(`${v3.unmonitor.length} in v3`);
  if (v2.unmonitor?.length) parts.push(`${v2.unmonitor.length} in v2, matched on title and date`);
  return parts.join(' · ');
}
