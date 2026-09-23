/*
 * A scene as a card and as a row, and the furniture around a list of them —
 * the view switch, the pager, the subject header the filters put at the top.
 */

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
 * State is the point of this tool, so it sits in the body at full size rather
 * than as a translucent mark over the artwork, and Add is always visible.
 *
 * The card itself still opens the site: a whole-card click that quietly
 * monitors a scene and fires a search is a click nobody meant to make.
 */
function cardState(scene) {
  const status = scene.status || 'absent';
  const foot = el('div', { className: 'cardstate' });

  /*
   * "Do not have" next to "In Stash" is a contradiction on the same card. Stash is
   * the stronger claim — it is about the file, not about Whisparr — so it wins
   * and the Whisparr chip is dropped. Add stays, in case a better copy is
   * wanted.
   */
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
 * One StashDB scene, in the same row as a TPDB one so a search reads as a
 * single page rather than two catalogues stapled together.
 *
 * The two badges are the two questions worth asking of a search result: do I
 * already have this, and is anything already trying to get it. A scene you own
 * still gets the button — wanting a second, better file for something already
 * on the shelf is exactly what the v3 side is for.
 */
export function stashdbRow(scene, options) {
  const thumb = el('div', { className: 'thumb landscape' });
  if (scene.image) thumb.append(el('img', { src: scene.image, loading: 'lazy', alt: '' }));

  const badges = stashdbState(scene, 'right', options);

  /*
   * The studio and the cast are filters, not decoration — clicking a name is
   * the fastest way to ask the only question this page exists to answer, which
   * is "what else of theirs am I missing". A name StashDB gave no id for stays
   * plain text rather than becoming a link that searches for nothing.
   */
  const meta = el('div', { className: 'meta' },
    scene.date ? el('span', {}, scene.date) : null,
    scene.duration ? el('span', {}, minutes(scene.duration)) : null,
    scene.studio?.id ? filterLink('studio', scene.studio.id, scene.studio.name) : (scene.studioName ? el('span', {}, scene.studioName) : null),
    scene.performers.map((p) => (p.id ? filterLink('performer', p.id, p.name) : el('span', {}, p.name)))
  );

  /*
   * What it is about, on one line. A row is wider than a card so it carries
   * more of the blurb, and one line rather than two because a list is for
   * running your eye down — the whole of it is on the hover title either way.
   */
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

/* ------------------------------------------------------------ the kinds
 *
 * Scenes and movies are two catalogues and one act. The switch says which you
 * are looking at rather than making them two tabs that forget each other.
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

/*
 * `onGone` is what makes the heading tell the truth. Skipping a scene takes its
 * card off the page, and a count above it that carried on saying eleven was the
 * page disagreeing with itself — so the removal is reported upward rather than
 * done quietly where nothing can hear it.
 */
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

  /*
   * List or grid, and nothing else. Thumbnail size is the app-wide control in
   * tilesize.js, which mounts itself into this page's toolbar — a second one
   * here drove a different mechanism, so the two disagreed and whichever you
   * pressed the other one was still right about something.
   */
  return el('div', { className: 'viewtools' }, el('div', { className: 'viewswitch' }, list, tiles));
}

/*
 * The wild card.
 *
 * Not merged into the results above and not run unasked. It is a different
 * catalogue with a different route out — a TPDB card talks to Whisparr v2, a
 * StashDB card to v3 — and a page that blends the two hides which Whisparr a
 * button is about to speak to. It only makes sense for a text search, since
 * none of the filters above mean anything to ThePornDB.
 */
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
 * The last resort: the indexers themselves, through Prowlarr, for a scene
 * neither catalogue has. No catalogue means no Whisparr — a grab goes to
 * Prowlarr's download client and the file arrives unnamed and unfiled, to be
 * built into a scene by hand from the Registry's wild card.
 */
export function indexerBand(initial, { heading = true, auto = false, forRow = null } = {}) {
  const input = el('input', { type: 'search', value: initial, placeholder: 'release name, studio, performer…' });
  const any = el('input', { type: 'checkbox' });
  const run = el('button', { className: 'chip', type: 'button' }, 'Search indexers');
  const body = el('div', {});

  /*
   * Narrowing what came back, not a new search: "1080 kendra" keeps the
   * releases whose names contain both, anywhere and in any case, and "-720"
   * drops the ones that contain that. Commas work as well as spaces. It stays
   * set across searches, so the same "1080" applies to the next query too.
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
        'Prowlarr, by hand — usenet grabs go to NZBGet here, torrents to Prowlarr’s client; never to Whisparr, so the scene is built afterwards')
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

/* ------------------------------------------------------------ the percentage
 *
 * A percentage is only worth anything against a catalogue somebody chose, so it
 * is attached to the studio or performer it is about and to nothing else.
 * Tracking one is what turns it on; untracking stops the measuring.
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

// The other two, whichever one you are. A subject card is only drawn when the
// search is about exactly one thing, so each kind has to know what would make
// that untrue.
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

  /*
   * Tracking, and stopping, as two different things.
   *
   * They used to be one button: press Track this to start, press the same
   * button again to stop. That is the right shape for a toggle and the wrong
   * one for this — starting costs a measurement and stopping costs the
   * catalogue's whole queue and the percentage it was driving, and one press
   * in the wrong place did the second while looking like the first.
   *
   * So while it is tracked the state is a label rather than a button, and
   * stopping is its own quiet control underneath, behind a question. The × on
   * the Tracked page went for the same reason: on a wall you scan and click
   * through, an untrack in the corner of every card is an untrack waiting to
   * happen.
   */
  // A measurement in flight fills its own number in rather than waiting for a
  // reload — tracking something and then watching nothing happen reads as a
  // button that did not work.
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
     * What it costs, in the sentence. Untracking takes the catalogue out of
     * the wall, the queue and the percentage — and takes nothing away from the
     * decisions already made, which live per scene and are waiting if it is
     * ever tracked again. Worth saying, because "did I just lose 148 skips?"
     * is the question this button otherwise leaves behind.
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

  /*
   * A performer photo is a portrait and cropping it to fit is right. A studio
   * image is a logo, usually wide, and cropping one takes the name off it — so
   * the kind rides on the element and the stylesheet fits each accordingly.
   */
  return el('div', { className: 'subjectbody' },
    hit.image
      ? el('img', { className: 'art ' + kind, src: hit.image, loading: 'lazy', alt: '' })
      : el('div', { className: 'noposter ' + kind }),
    el('div', {},
      el('h2', {}, hit.name),
      el('div', { className: 'muted' }, hit.detail || SUBJECT_IS[kind]),
      /*
       * A tag is not a catalogue you complete — nobody wants every scene ever
       * filed under one — so tracking it buys the queue rather than the
       * percentage, and the bar is hidden where the number would be a fraction
       * of a sample. `honest` is decided at the other end, on size rather than
       * on kind: a narrow tag measured whole gets its bar like anything else.
       * See coverageSnapshot in discover.mjs.
       */
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
