/* Scene cards and rows, and the view switch, pager and subject header. */

import { api, el, gigabytes, minutes } from '../util.js';
import { blurb, coverageBar, stashdbCard, stashdbState } from '../catalogue.js';
import { acquireHash, artFor, artShape, isGrid, remember, statusLabel } from './core.js';
import { addOne } from './send.js';

/* ------------------------------------------------------------------ cards */

export function sceneCard(scene, showBecause = true) {
  const src = artFor(scene);
  const art = el('div', { className: 'cardart ' + artShape(scene) },
    src ? el('img', { src, loading: 'lazy', alt: '' }) : null
  );

  if (scene.date && scene.date > new Date().toISOString().slice(0, 10)) {
    art.append(el('div', { className: 'cardmarks' },
      el('span', { className: 'badge upcoming' }, 'Upcoming')));
  }

  const card = el('article', { className: 'card' },
    art,
    el('div', { className: 'cardbody' },
      el('div', { className: 'title' }, scene.title),
      el('div', { className: 'meta' },
        el('span', {}, scene.siteName || ''),
        el('span', {}, scene.date || ''),
        scene.duration ? el('span', {}, scene.duration + ' min') : null
      ),
      showBecause && scene.because ? el('div', { className: 'because' }, scene.because) : null,
      cardState(scene)
    )
  );

  // The scene is the thing you clicked; the site is one hop further on.
  card.onclick = () => {
    if (scene.guid) location.hash = `#/scene/${scene.guid}`;
    else if (scene.siteId) location.hash = `#/site/${scene.siteId}`;
  };
  card.title = scene.performers?.map((p) => p.name).join(', ') || '';
  return card;
}

/*
 * State in the card body at full size; Add always visible. Clicking the
 * card opens the site, never adds.
 */
function cardState(scene) {
  const status = scene.status || 'absent';
  const foot = el('div', { className: 'cardstate' });

  /* In Stash beats the Whisparr chip. Add stays. */
  if (status !== 'absent' || !scene.stash) {
    foot.append(el('span', { className: 'badge ' + status },
      status === 'absent' ? 'Do not have' : statusLabel(status)));
  }

  if (scene.stash) {
    foot.append(el('span', {
      className: 'badge stash-' + scene.stash.match,
      title: [scene.stash.via && `matched on ${scene.stash.via}`, scene.stash.path].filter(Boolean).join('\n'),
    }, scene.stash.match === 'exact' ? 'In Stash' : 'Probably'));
  }

  if (status === 'absent' && scene.siteId) {
    const add = el('button', { className: 'add', type: 'button' }, 'Add');
    add.onclick = (e) => {
      e.stopPropagation();
      addOne(scene, add, () => foot.replaceChildren(...cardState(scene).childNodes));
    };
    foot.append(add);
  }

  return foot;
}

/*
 * A StashDB scene as a row. Badges: do I have it, is something getting it.
 * Owned scenes keep the button (for a better copy).
 */
export function stashdbRow(scene, options) {
  const thumb = el('div', { className: 'thumb landscape' });
  if (scene.image) thumb.append(el('img', { src: scene.image, loading: 'lazy', alt: '' }));

  const badges = stashdbState(scene, 'right', options);

  /* Studio and cast link to filtered searches; names without ids stay plain. */
  const meta = el('div', { className: 'meta' },
    scene.date ? el('span', {}, scene.date) : null,
    scene.duration ? el('span', {}, minutes(scene.duration)) : null,
    scene.studio?.id ? filterLink('studio', scene.studio.id, scene.studio.name) : (scene.studioName ? el('span', {}, scene.studioName) : null),
    scene.performers.map((p) => (p.id ? filterLink('performer', p.id, p.name) : el('span', {}, p.name)))
  );

  /* The blurb, one line in a row. */
  const about = blurb(scene.details, scene.title, 220);

  return el('div', { className: 'scene' },
    el('span', { className: 'pick' }),
    thumb,
    el('div', { className: 'scenebody' },
      el('a', { className: 'title', href: scene.url, target: '_blank', rel: 'noreferrer' }, scene.title),
      meta,
      about ? el('div', { className: 'rowdesc', title: scene.details }, about) : null
    ),
    badges
  );
}

function filterLink(kind, id, name) {
  const params = new URLSearchParams();
  params.append(kind, id);
  return el('a', { className: 'metalink', href: acquireHash(params) }, name);
}

/*
 * ------------------------------------------------------------ the kinds
 *
 * Scenes or movies.
 */
export function kindSwitch(params, active) {
  const go = (kind) => () => {
    if (kind === active) return;
    const next = new URLSearchParams(params);
    if (kind === 'scene') next.delete('kind');
    else next.set('kind', kind);
    // The two searches do not share filters — a studio id means nothing to
    // ThePornDB — so only the words carry across.
    for (const key of ['studio', 'performer', 'tag', 'date', 'dateop', 'show', 'have', 'page']) next.delete(key);
    location.hash = '#/import/video' + (next.toString() ? '?' + next.toString() : '');
  };

  const button = (kind, label) => {
    const node = el('button', { type: 'button', className: 'chip' + (kind === active ? ' on' : '') }, label);
    node.onclick = go(kind);
    return node;
  };

  return el('div', { className: 'toolbar kindline' },
    el('div', { className: 'viewswitch' }, button('scene', 'Scenes'), button('movie', 'Movies'), button('monitored', 'Monitored')),
    el('span', { className: 'muted small' },
      active === 'movie'
        ? 'ThePornDB movies — a container, whose scenes go to Whisparr v2'
        : active === 'monitored'
          ? 'What either Whisparr is still looking for — search the indexers by hand'
          : 'StashDB scenes — these go to Whisparr v3')
  );
}

/* `onGone` keeps the heading count right when a card leaves. */
export function resultBody(scenes, onGone) {
  const options = {
    onDispose: (_scene, node) => {
      node?.remove();
      onGone?.();
    },
  };

  if (!isGrid()) return el('div', { className: 'scenes' }, scenes.map((sc) => stashdbRow(sc, options)));
  return el('div', { className: 'cards resultgrid' }, scenes.map((sc) => stashdbCard(sc, options)));
}

export function viewSwitch(redraw) {
  const grid = isGrid();

  const list = el('button', { type: 'button', className: 'chip' + (grid ? '' : ' on') }, 'List');
  const tiles = el('button', { type: 'button', className: 'chip' + (grid ? ' on' : '') }, 'Grid');

  const pick = (mode) => () => {
    if ((mode === 'grid') === grid) return;
    remember('acquire.view', mode);
    redraw();
  };
  list.onclick = pick('list');
  tiles.onclick = pick('grid');

  /* List or grid only; thumbnail size is tilesize.js. */
  return el('div', { className: 'viewtools' }, el('div', { className: 'viewswitch' }, list, tiles));
}

/* The wild card: ThePornDB, separate and on request, text searches only. */
export function wildcardBand(params) {
  const term = params.get('q');
  if (!term) return null;

  const body = el('div', {});
  const run = el('button', { className: 'chip', type: 'button' }, 'Look on ThePornDB');

  run.onclick = async () => {
    run.disabled = true;
    run.textContent = 'Looking…';
    try {
      const { available, scenes } = await api('/api/acquire/wildcard?q=' + encodeURIComponent(term));
      run.remove();
      if (!available) {
        body.replaceChildren(el('div', { className: 'empty small' },
          'ThePornDB needs a token, and the portal borrows that from Stash.'));
        return;
      }
      body.replaceChildren(scenes.length
        ? el('div', { className: 'cards' }, scenes.map((s) => sceneCard(s, false)))
        : el('div', { className: 'empty small' }, `ThePornDB has nothing for “${term}” either.`));
    } catch (err) {
      run.disabled = false;
      run.textContent = 'Look on ThePornDB';
      body.replaceChildren(el('div', { className: 'empty small' }, err.message));
    }
  };

  return el('section', { className: 'feed wildcard' },
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Wild card'),
      el('span', { className: 'muted' },
        'ThePornDB, for what StashDB has never heard of — these go to Whisparr v2')
    ),
    el('div', { className: 'toolbar' }, run),
    body,
    indexerBand(term)
  );
}

/*
 * Last resort: Prowlarr search for a scene neither catalogue has. Grabs go
 * to Prowlarr's client; build the scene afterwards in Wild Card.
 */
export function indexerBand(initial, { heading = true, auto = false, forRow = null } = {}) {
  const input = el('input', { type: 'search', value: initial, placeholder: 'release name, studio, performer…' });
  const any = el('input', { type: 'checkbox' });
  const run = el('button', { className: 'chip', type: 'button' }, 'Search indexers');
  const body = el('div', {});

  /*
   * Narrow what came back: "1080 kendra" keeps both, "-720" drops. Commas or
   * spaces. Persists across searches.
   */
  const keep = el('input', {
    type: 'search',
    className: 'releasefilter',
    placeholder: 'Filter results: 1080 kendra -720',
    autocomplete: 'off',
    spellcheck: false,
  });
  const tally = el('span', { className: 'muted small' });
  const narrow = el('div', { className: 'toolbar', hidden: true }, keep, tally);
  let rows = [];

  const applyFilter = () => {
    const words = keep.value.toLowerCase().split(/[\s,]+/).filter((w) => w && w !== '-');
    const need = words.filter((w) => !w.startsWith('-'));
    const drop = words.filter((w) => w.startsWith('-')).map((w) => w.slice(1));
    let shown = 0;
    for (const { node, name } of rows) {
      const hit = need.every((w) => name.includes(w)) && !drop.some((w) => name.includes(w));
      node.hidden = !hit;
      if (hit) shown += 1;
    }
    tally.textContent = words.length ? `${shown} of ${rows.length}` : `${rows.length} results`;
  };
  keep.oninput = applyFilter;

  const look = async () => {
    const term = input.value.trim();
    if (!term) return;
    run.disabled = true;
    run.textContent = 'Searching…';
    body.replaceChildren(el('div', { className: 'empty small' }, 'Asking every indexer — the slowest one sets the pace.'));
    try {
      const { available, releases } = await api('/api/acquire/prowlarr?q=' + encodeURIComponent(term) + (any.checked ? '&any=1' : ''));
      if (!available) {
        body.replaceChildren(el('div', { className: 'empty small' },
          'Prowlarr is not set up — add its URL and API key under Parameters.'));
        return;
      }
      rows = releases.map((r) => ({ node: releaseRow(r, forRow), name: String(r.title || '').toLowerCase() }));
      narrow.hidden = !rows.length;
      body.replaceChildren(rows.length
        ? el('div', { className: 'releases' }, rows.map((r) => r.node))
        : el('div', { className: 'empty small' }, `No indexer has anything for “${term}”.`));
      applyFilter();
    } catch (err) {
      body.replaceChildren(el('div', { className: 'empty small' }, err.message));
    } finally {
      run.disabled = false;
      run.textContent = 'Search indexers';
    }
  };

  run.onclick = look;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); look(); } };

  if (auto) queueMicrotask(look);

  return el('div', { className: 'indexers' + (heading ? '' : ' bare') },
    heading && el('div', { className: 'feedhead' },
      el('h2', {}, 'Indexers'),
      el('span', { className: 'muted' },
        'Prowlarr, by hand — usenet to NZBGet, torrents to Prowlarr’s client, never to Whisparr')
    ),
    el('div', { className: 'toolbar' }, input, run,
      el('label', { className: 'check muted' }, any, ' any category')),
    narrow,
    body
  );
}

const ago = (iso) => {
  if (!iso) return '';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
};

function releaseRow(r, forRow = null) {
  const grab = el('button', { className: 'chip', type: 'button' }, 'Grab');
  grab.onclick = async () => {
    grab.disabled = true;
    grab.textContent = 'Sending…';
    try {
      const out = await api('/api/acquire/prowlarr/grab', { method: 'POST', body: JSON.stringify({ guid: r.guid, indexerId: r.indexerId, for: forRow }) });
      grab.textContent = 'Sent';
      grab.title = 'Sent to ' + (out.to || 'Prowlarr');
    } catch (err) {
      grab.disabled = false;
      grab.textContent = 'Grab';
      grab.title = err.message;
      alert(err.message);
    }
  };

  const heat = r.protocol === 'torrent'
    ? (r.seeders != null ? `${r.seeders} seeders` : '')
    : (r.grabs != null ? `${r.grabs} grabs` : '');

  return el('div', { className: 'release' },
    el('div', { className: 'releasename' },
      r.infoUrl ? el('a', { href: r.infoUrl, target: '_blank', rel: 'noopener noreferrer' }, r.title) : r.title),
    el('div', { className: 'releasemeta muted' },
      [r.indexer, r.protocol, gigabytes(r.size), ago(r.publishDate), heat, r.categories[0]]
        .filter(Boolean).map((t) => el('span', {}, t))),
    grab
  );
}

/*
 * ------------------------------------------------------------ the percentage
 *
 * Shown on a studio or performer only when tracked.
 */

// Above the results, when the search is about exactly one studio, performer or
// tag — a tag can be tracked like the other two, with the caveat on its card.
export function subjectCard(params) {
  const one = (kind) => (params.getAll(kind).length === 1
    && others(kind).every((k) => !params.getAll(k).length)
    ? params.getAll(kind)[0]
    : null);

  const kind = KINDS.find((k) => one(k));
  if (!kind) return null;

  const id = one(kind);
  const holder = el('section', { className: 'subject' });

  api(`/api/acquire/chips?${kind}=${id}`)
    .then(async (named) => {
      const hit = [...(named.studios || []), ...(named.performers || []), ...(named.tags || [])][0];
      if (!hit) return;
      const { rows } = await api('/api/acquire/tracked');
      const row = rows.find((r) => r.kind === kind && r.id === id);
      holder.replaceChildren(subjectBody(hit, kind, row, holder));
    })
    .catch(() => {});

  return holder;
}

// The subject card appears only when the search is about exactly one thing.
const KINDS = ['performer', 'studio', 'tag'];
const others = (kind) => KINDS.filter((k) => k !== kind);

const SUBJECT_IS = {
  studio: 'Studio on StashDB',
  performer: 'Performer on StashDB',
  tag: 'Tag on StashDB',
};

const TRACK_IS = {
  studio: 'Track this to measure how much of its catalogue you hold.',
  performer: 'Track this to measure how much of their catalogue you hold.',
  tag: 'Track this to work through its scenes — a percentage of a tag means little.',
};

function subjectBody(hit, kind, row, holder) {
  const redraw = async () => {
    const { rows } = await api('/api/acquire/tracked');
    holder.replaceChildren(subjectBody(hit, kind, rows.find((r) => r.kind === kind && r.id === hit.id), holder));
  };

  /* Tracked is a label; untracking is a separate quiet control behind a question. */
  // Re-check while a measurement is pending.
  if (row?.pending) setTimeout(() => { if (holder.isConnected) redraw().catch(() => {}); }, 4000);

  const start = el('button', { className: 'add', type: 'button' }, 'Track this');
  start.title = 'Measure how much of this catalogue you hold';
  start.onclick = async () => {
    start.disabled = true;
    try {
      await api('/api/acquire/tracked', {
        method: 'POST',
        body: JSON.stringify({ kind, id: hit.id, name: hit.name, image: hit.image }),
      });
      await redraw();
    } catch (err) {
      start.disabled = false;
      alert(err.message);
    }
  };

  const stop = el('button', { className: 'chip quiet trackstop', type: 'button' }, 'Stop tracking');
  stop.title = 'Take this out of the measurements';
  stop.onclick = async () => {
    /*
     * Untracking removes it from the wall, queue and percentage; your per-scene
     * decisions are kept.
     */
    const sure = window.confirm(
      `Stop measuring ${hit.name}?

`
      + 'It comes off the Tracked page and out of the queue. What you have already '
      + 'skipped and wanted is kept, and comes back if you track it again.'
    );
    if (!sure) return;

    stop.disabled = true;
    try {
      await api(`/api/acquire/tracked/${kind}/${hit.id}`, { method: 'DELETE' });
      await redraw();
    } catch (err) {
      stop.disabled = false;
      alert(err.message);
    }
  };

  const action = row
    ? el('div', { className: 'subjecttrack' },
      el('span', { className: 'trackedis' }, 'Tracked'),
      stop)
    : start;

  /* The kind decides how the image fits: portraits crop, logos don't. */
  return el('div', { className: 'subjectbody' },
    hit.image
      ? el('img', { className: 'art ' + kind, src: hit.image, loading: 'lazy', alt: '' })
      : el('div', { className: 'noposter ' + kind }),
    el('div', {},
      el('h2', {}, hit.name),
      el('div', { className: 'muted' }, hit.detail || SUBJECT_IS[kind]),
      /* Hide the bar when `honest` is false (see coverageSnapshot in discover.mjs). */
      row && row.honest !== false
        ? coverageBar(row)
        : row
          ? el('div', { className: 'muted small' },
            `${(row.undecided || 0).toLocaleString()} still to decide — StashDB has ${(row.total || 0).toLocaleString()} here, too many to measure a percentage against.`)
          : el('div', { className: 'muted small' }, TRACK_IS[kind])
    ),
    action
  );
}
