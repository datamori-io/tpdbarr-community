/* One scene, several sources, assembled by hand. */

import { api, el } from '../util.js';
import { SECTION_OF, painterFor, show, state } from '../import/core.js';
import { compareSheet } from './compare.js';
import { generateBit, liveArt } from './liveart.js';

/*
 * ================================================================ wild card
 *
 * For files no fingerprint recognises (DVD rips and the like). Give it URLs
 * and search sources; each answer is a **contribution**, and the record is
 * built one field at a time with you choosing which one wins. Nothing is
 * merged or ranked. "Fill the blanks" only fills empty fields.
 */

const hashFor = (params) => {
  const qs = params.toString();
  return '#/catalogue/wildcard' + (qs ? '?' + qs : '');
};

const go = (params) => {
  const hash = hashFor(params);
  if (location.hash === hash) showWildcard(params.toString());
  else location.hash = hash;
};

/*
 * Record fields, in deciding order. `list` fields can take a union;
 * `image` is drawn as a picture.
 */
const FIELDS = [
  ['title', 'Title', 'text'],
  ['date', 'Date', 'text'],
  ['studioName', 'Studio', 'text'],
  ['performers', 'Performers', 'list'],
  ['tags', 'Tags', 'list'],
  ['image', 'Cover', 'image'],
  ['details', 'Description', 'long'],
  ['code', 'Code', 'text'],
  ['director', 'Director', 'text'],
  ['urls', 'Links', 'list'],
];

/*
 * Name-search sources shown as chips: the ones that know films. Uninstalled
 * ones are hidden.
 */
const FAVOURITES = [
  'AdultEmpire',
  // The AdultEmpire catalogue, scraped by Stash on this machine.
  'GameLink',
  'AdultDvdMarketPlace',
  'Hotmovies',
  'AdultFilmIndex',
  'TheClassicPorn',
];

let sourceMemo = null;
const knownSources = async () => {
  if (!sourceMemo) sourceMemo = api('/api/import/wildcard/sources').catch(() => ({ ask: [], urls: 0 }));
  return sourceMemo;
};

export async function showWildcard(qs) {
  const paint = painterFor();
  const params = new URLSearchParams(qs || '');
  const sceneId = (params.get('scene') || '').trim();

  const body = el('div', {});
  show(paint, SECTION_OF.wildcard, body);

  if (!state?.stash?.enabled) {
    body.replaceChildren(el('div', { className: 'empty' }, 'This works on your Stash library. Connect it in Settings.'));
    return;
  }

  if (!sceneId) return pickScene(body, params);

  body.replaceChildren(el('div', { className: 'empty' }, 'Reading the scene…'));

  try {
    const [{ scene }, sources] = await Promise.all([
      api('/api/import/wildcard/scene/' + encodeURIComponent(sceneId)),
      knownSources(),
    ]);
    drawBench(body, params, scene, sources);
  } catch (err) {
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

/*
 * ------------------------------------------------------------ which scene
 *
 * The match page's piles, keyword and ordering, from the match queue itself.
 * **Anything** is a free search over the whole library and needs a keyword.
 */

const PILES = [
  ['unmatched', 'No stash id'],
  ['nocover', 'No cover'],
  ['unorganized', 'Not organised'],
  ['any', 'Anything'],
];

const SORTS = [
  ['added', 'Date added'],
  ['date', 'Scene date'],
  ['updated', 'Last changed'],
  ['title', 'Title'],
  ['path', 'Folder, then filename'],
  ['size', 'File size'],
  ['duration', 'Runtime'],
  ['random', 'Shuffled'],
];

/* Must match match.js: the address omits the default sort. */
const SORT_DEFAULT = 'added';

function pickScene(body, params) {
  const mode = PILES.some(([m]) => m === params.get('mode')) ? params.get('mode') : 'unmatched';

  const panel = el('section', { className: 'searchpanel' });
  const found = el('div', {});
  body.replaceChildren(panel, found);

  /*
   * Every control goes through the address; writing a record returns you to
   * the page of the list you were on.
   */
  const move = (fn) => {
    const next = new URLSearchParams(params);
    fn(next);
    next.delete('page');
    go(next);
  };

  const set = (key, value, fallback) => move((next) => {
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
  });

  const pile = (key, label) => {
    const chip = el('button', { type: 'button', className: 'chip' + (key === mode ? ' on' : '') }, label);
    chip.onclick = () => set('mode', key, 'unmatched');
    return chip;
  };

  const words = el('input', {
    type: 'search',
    className: 'facetinput',
    placeholder: mode === 'any'
      ? 'A word in the title, the filename or the folder…'
      : 'A word in the path or filename…',
    value: params.get('q') || '',
    autocomplete: 'off',
  });
  words.onchange = () => set('q', words.value.trim(), '');
  words.onkeydown = (e) => { if (e.key === 'Enter') set('q', words.value.trim(), ''); };

  const sort = el('select', { className: 'facetinput' },
    SORTS.map(([key, label]) =>
      el('option', { value: key, selected: key === (params.get('sort') || SORT_DEFAULT) }, label)));
  sort.onchange = () => set('sort', sort.value, SORT_DEFAULT);

  const descending = (params.get('dir') || 'desc') !== 'asc';
  const flip = el('button', { type: 'button', className: 'chip' }, descending ? 'Newest first' : 'Oldest first');
  flip.onclick = () => set('dir', descending ? 'asc' : 'desc', 'desc');

  /* No ordering for the free search: Stash's `q` ranks by relevance. */
  const said = el('span', { className: 'muted small' }, mode === 'any'
    ? 'Any scene in the library, by keyword — for building up something that is already matched.'
    : 'The same pile the match page works down. Pick one and build its record out of several sources at once.');

  panel.replaceChildren(
    el('div', { className: 'controls' },
      el('div', { className: 'viewswitch' }, PILES.map(([key, label]) => pile(key, label)))),
    el('div', { className: 'controls sortline' },
      words,
      mode === 'any' ? null : sort,
      mode === 'any' ? null : flip),
    el('div', { className: 'controls' }, said)
  );

  loadPicks(found, params, mode);
}

async function loadPicks(found, params, mode) {
  const q = (params.get('q') || '').trim();

  if (mode === 'any' && !q) {
    found.replaceChildren(el('div', { className: 'empty small' }, 'Type something to search the library for.'));
    return;
  }

  found.replaceChildren(el('div', { className: 'empty' }, 'Reading the library…'));

  try {
    if (mode === 'any') {
      const { scenes } = await api('/api/import/wildcard/find?q=' + encodeURIComponent(q));
      found.replaceChildren(scenes.length
        ? el('div', { className: 'tracked' }, scenes.map(sceneChoice))
        : el('div', { className: 'empty small' }, 'Nothing in Stash matches that.'));
      return;
    }

    const queue = await api('/api/import/match?' + new URLSearchParams({
      mode,
      page: params.get('page') || '1',
      sort: params.get('sort') || SORT_DEFAULT,
      dir: params.get('dir') || 'desc',
      q,
    }));

    if (!queue.scenes.length) {
      found.replaceChildren(el('div', { className: 'empty small' }, 'Nothing left in this pile.'));
      return;
    }

    found.replaceChildren(
      el('div', { className: 'feedhead' },
        el('h2', {}, `${queue.count.toLocaleString()} to go`),
        el('span', { className: 'muted' }, `showing ${queue.scenes.length}`)),
      el('div', { className: 'tracked' }, queue.scenes.map((s) => sceneChoice(fromQueue(s)))),
      pager(params, queue)
    );
  } catch (err) {
    found.replaceChildren(el('div', { className: 'empty small' }, err.message));
  }
}

/* A match-queue row in this page's shape. */
const fromQueue = (s) => ({
  id: s.id,
  title: s.title || '',
  date: s.date || '',
  studioName: s.studio?.name || '',
  performers: (s.performers || []).map((p) => p.name).filter(Boolean),
  stashIds: s.stashIds || [],
  organized: !!s.organized,
  path: s.path || null,
});

function pager(params, { page, perPage, count }) {
  const pages = Math.max(1, Math.ceil(count / perPage));
  if (pages < 2) return null;

  const to = (n) => () => {
    const next = new URLSearchParams(params);
    next.set('page', String(n));
    go(next);
    window.scrollTo({ top: 0 });
  };

  const back = el('button', { className: 'chip', type: 'button', disabled: page <= 1 }, 'Previous');
  const on = el('button', { className: 'chip', type: 'button', disabled: page >= pages }, 'Next');
  back.onclick = to(page - 1);
  on.onclick = to(page + 1);

  return el('div', { className: 'toolbar' }, back, el('span', { className: 'muted' }, `Page ${page} of ${pages}`), on);
}

function sceneChoice(scene) {
  /* Carry the pile and page, so writing a record returns you there. */
  const open = () => {
    const next = new URLSearchParams(location.hash.split('?')[1] || '');
    next.set('scene', scene.id);
    go(next);
  };

  const meta = [
    scene.date || 'no date',
    scene.studioName || null,
    scene.performers.length ? scene.performers.join(', ') : null,
    scene.stashIds.length ? `${scene.stashIds.length} stash id` : 'no stash id',
    scene.organized ? 'organised' : null,
  ].filter(Boolean);

  // Hover plays the preview; the bottom edge scrubs.
  const art = el('img', { className: 'art', src: `/media/scene/${scene.id}/thumb`, loading: 'lazy', alt: '' });

  const row = el('div', { className: 'crow matchrow wcpick' },
    liveArt(scene.id, art),
    el('div', {},
      el('div', { className: 'title' }, scene.title || '(untitled)'),
      el('div', { className: 'meta' }, meta.map((m) => el('span', {}, m))),
      scene.path ? el('div', { className: 'muted small path' }, scene.path) : null),
    el('div', { className: 'trackedactions' }, generateBit(scene.id, art), (() => {
      const b = el('button', { className: 'add', type: 'button' }, 'Build this one');
      b.onclick = open;
      return b;
    })())
  );

  return row;
}

/*
 * ------------------------------------------------------------- the bench
 *
 * The scene, the ways of asking, the answers and the record, on one screen.
 */
function drawBench(body, params, scene, sources) {
  /* Every answer this visit, in arrival order, shared by the panels and the table. */
  const contributions = [];

  const answers = el('div', { className: 'wccontribs' });
  const table = el('div', { className: 'wcfields' });

  // What has been decided, field -> { label, value }. Absent means "leave
  // whatever Stash already has", which is why an untouched page writes nothing.
  const chosen = new Map();

  /* Numbered on arrival, answers only, so cards and table agree. */
  let numbered = 0;

  /*
   * The first description to arrive is ticked automatically, only into an
   * empty field and only once a visit.
   */
  let offeredDetails = false;
  const offerDetails = () => {
    if (offeredDetails) return;
    if (String(scene.details || '').trim()) return;
    const hit = contributions.find((c) => c.ok && String(c.fields?.details || '').trim());
    if (!hit) return;
    chosen.set('details', { label: `${hit.at}. ${hit.label}`, value: hit.fields.details });
    offeredDetails = true;
  };

  const arrived = (list) => {
    for (const c of list) if (c.ok) c.at = (numbered += 1);
    contributions.push(...list);
    offerDetails();
    redraw();
  };

  // Reading the page behind a search hit. Same call the URL panel makes, so a
  // page found for you and a page you found yourself land identically.
  const reread = async (url) => {
    const { contributions: more } = await api('/api/import/wildcard/urls', {
      method: 'POST',
      body: JSON.stringify({ urls: [url] }),
    });
    arrived(more);
  };

  /* Frames already on disk, for the Cover row. Handed over by the frame panel. */
  let frames = [];

  const redraw = () => {
    drawContributions(answers, contributions, reread, scene.id);
    drawFields(table, scene, contributions, chosen, redraw, frames);
    saving.refresh();
  };

  /* The frame panel hands its list over here; no second fetch. */
  const moreFrames = (list) => { frames = list || []; redraw(); };

  const saving = savePanel(scene, chosen, params);

  body.replaceChildren(
    sceneHead(scene),
    urlPanel(arrived, sources),
    askPanel(arrived, sources, scene),
    // Last of the three ways of asking, because it is the one you reach for
    // when the other two came back with nothing.
    framePanel(scene, moreFrames),
    answers,
    table,
    saving.node
  );

  redraw();
}

function sceneHead(scene) {
  const back = el('button', { className: 'chip', type: 'button' }, 'Pick another scene');
  back.onclick = () => go(new URLSearchParams());

  const meta = [
    scene.date || 'no date',
    scene.studioName || 'no studio',
    scene.performers.length ? scene.performers.join(', ') : 'no cast',
    scene.stashIds.length ? `${scene.stashIds.length} stash id` : 'no stash id',
  ];

  const art = el('img', { className: 'art', src: `/media/scene/${scene.id}/thumb`, loading: 'lazy', alt: '' });

  return el('section', { className: 'searchpanel wchead' },
    el('div', { className: 'crow' },
      liveArt(scene.id, art),
      el('div', {},
        el('div', { className: 'title' }, scene.title || '(untitled)'),
        el('div', { className: 'meta' }, meta.map((m) => el('span', {}, m))),
        scene.path ? el('div', { className: 'muted small path' }, scene.path) : null),
      el('div', { className: 'trackedactions' }, generateBit(scene.id, art), back))
  );
}

/*
 * --------------------------------------------------- searching by the picture
 *
 * Frames cut across the file, for reverse image search. The portal can't
 * search for you (engines can't reach the LAN), so it copies a frame to the
 * clipboard and opens the engine's paste screen.
 */

/* Where each engine takes a pasted image. Plain links. */
const LENSES = [
  ['Google Lens', 'https://lens.google.com/upload'],
  ['Yandex', 'https://yandex.com/images/search?rpt=imageview'],
  ['TinEye', 'https://tineye.com/'],
  ['Bing', 'https://www.bing.com/images/search?view=detailv2&iss=sbiupload'],
];

function framePanel(scene, onFrames = null) {
  const strip = el('div', { className: 'wcframes' });
  const said = el('span', { className: 'muted small' }, 'Reading what has been cut…');
  const more = el('button', { className: 'chip', type: 'button', hidden: true }, 'Cut a few more');
  const start = el('button', { className: 'add', type: 'button', hidden: true }, 'Cut some frames');

  let left = 0;

  const draw = (list) => {
    strip.replaceChildren(...list.map((f) => frameTile(f, said)));
    more.hidden = !list.length || !left;
    start.hidden = Boolean(list.length);
    more.textContent = `Cut a few more (${left} left)`;
    // The Cover row offers these too, and a frame you just cut should be on
    // offer without the page having to be reopened.
    onFrames?.(list);
  };

  const cut = async (button) => {
    const was = button.textContent;
    button.disabled = true;
    button.textContent = 'Cutting…';
    said.textContent = 'ffmpeg is seeking into the file — a few seconds each.';

    try {
      const out = await api('/api/import/wildcard/frames/' + scene.id, {
        method: 'POST',
        body: JSON.stringify({ count: 6 }),
      });
      left = out.more;
      draw(out.frames);
      said.textContent = out.why
        || `${out.frames.length} frame${out.frames.length === 1 ? '' : 's'} — copy one, then open a lens and paste.`;
    } catch (err) {
      said.textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = was;
    }
  };

  start.onclick = () => cut(start);
  more.onclick = () => cut(more);

  api('/api/import/wildcard/frames/' + scene.id).then((out) => {
    left = out.more;
    draw(out.frames);
    said.textContent = out.frames.length
      ? `${out.frames.length} already cut.`
      : 'Nothing cut yet. Frames are for when no source knows the title and you want to search by the picture instead.';
  }).catch((err) => { said.textContent = err.message; });

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('strong', {}, 'Search by the picture'),
      el('span', { className: 'muted small' },
        'the portal cannot search an engine for you — it puts the frame on your clipboard and opens the paste screen')),
    strip,
    el('div', { className: 'controls' }, start, more, said),
    el('div', { className: 'controls sourceline' },
      el('span', { className: 'muted small' }, 'Open'),
      ...LENSES.map(([name, href]) =>
        el('a', { className: 'chip', href, target: '_blank', rel: 'noreferrer' }, name)))
  );
}

/*
 * One frame: Copy puts the image bytes on the clipboard (as PNG, the one
 * type `navigator.clipboard.write` must accept); Save is the fallback.
 */
function frameTile(frame, said) {
  // Not lazy: it is a strip of six that were cut a second ago because somebody
  // pressed a button asking for them. All six are wanted.
  const img = el('img', { className: 'wcframe', src: frame.url, alt: `${frame.pct}% in` });

  const copy = el('button', { className: 'chip small', type: 'button' }, 'Copy');
  const save = el('a', { className: 'chip small', href: frame.url, download: `frame-${frame.pct}.jpg` }, 'Save');

  copy.onclick = async () => {
    copy.disabled = true;
    try {
      const blob = await asPng(frame.url);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      said.textContent = `Frame at ${frame.pct}% copied. Open a lens below and paste.`;
    } catch (err) {
      // Firefox has no clipboard.write for images, and every browser refuses
      // it outside a secure context. Said plainly, with the way that does work.
      said.textContent = 'This browser would not take an image on the clipboard — use Save and upload the file. '
        + (err.message || '');
    } finally {
      copy.disabled = false;
    }
  };

  return el('div', { className: 'wcframetile' },
    img,
    el('div', { className: 'controls' },
      el('span', { className: 'muted small' }, `${frame.pct}%`),
      copy,
      save)
  );
}

// The frame as PNG bytes. Same-origin, so the canvas is never tainted.
async function asPng(src) {
  const img = new Image();
  img.src = src;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);

  return new Promise((done, fail) =>
    canvas.toBlob((blob) => (blob ? done(blob) : fail(new Error('the frame could not be re-encoded'))), 'image/png'));
}

/*
 * ------------------------------------------------------------ asking by URL
 *
 * Read pages you already have open. Stash picks the scraper by host.
 */
function urlPanel(arrived, sources) {
  const box = el('textarea', {
    className: 'facetinput wcurls',
    rows: 3,
    placeholder: 'Paste the pages you found — scene pages or film pages, one address per line',
    spellcheck: false,
  });

  const read = el('button', { className: 'add', type: 'button' }, 'Read these pages');
  /* Scene and film scraper counts; some sites (AdultFilmIndex) only read as films. */
  const said = el('span', { className: 'muted small' },
    `${sources.urls.toLocaleString()} sites can be read as a scene, ${(sources.films || 0).toLocaleString()} as a film.`);

  read.onclick = async () => {
    const urls = box.value.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) {
      said.textContent = 'Paste an address first.';
      return;
    }

    read.disabled = true;
    read.textContent = 'Reading…';
    said.textContent = `Asking ${urls.length} page${urls.length === 1 ? '' : 's'}…`;

    try {
      const { contributions } = await api('/api/import/wildcard/urls', {
        method: 'POST',
        body: JSON.stringify({ urls }),
      });
      arrived(contributions);
      const good = contributions.filter((c) => c.ok).length;
      said.textContent = `${good} of ${contributions.length} answered.`;
      // Cleared only on success, so a typo is still there to correct.
      if (good) box.value = '';
    } catch (err) {
      said.textContent = err.message;
    } finally {
      read.disabled = false;
      read.textContent = 'Read these pages';
    }
  };

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' }, el('strong', {}, 'Pages you found'), said),
    el('div', { className: 'controls' }, box),
    el('div', { className: 'controls' }, read)
  );
}

/*
 * -------------------------------------------------------- asking by keyword
 *
 * Sites that search themselves (NAME scrapes). The favourites know films.
 */
function askPanel(arrived, sources, scene) {
  const picked = new Set();

  const term = el('input', {
    type: 'text',
    className: 'facetinput grow',
    // The filename read down to its title is the best first guess there is,
    // and on these scenes it is the only description that exists.
    value: scene.term || scene.title || '',
    placeholder: 'A film or scene title…',
    autocomplete: 'off',
  });

  const said = el('span', { className: 'muted small' }, '');
  const chips = el('div', { className: 'controls sourceline' });
  const ask = el('button', { className: 'add', type: 'button' }, 'Ask these');

  const byKey = new Map(sources.ask.map((s) => [s.key, s]));
  const favourites = FAVOURITES.map((k) => byKey.get(k)).filter(Boolean);
  const extras = () => sources.ask.filter((s) => picked.has(s.key) && !favourites.some((f) => f.key === s.key));

  const picker = el('select', { className: 'facetinput' });

  const drawChips = () => {
    const chipFor = (source) => {
      const on = picked.has(source.key);
      const chip = el('button', { type: 'button', className: 'chip' + (on ? ' on' : '') }, source.label);
      chip.onclick = () => {
        if (on) picked.delete(source.key);
        else picked.add(source.key);
        drawChips();
      };
      return chip;
    };

    picker.replaceChildren(
      el('option', { value: '' }, `Add a source (${sources.ask.length})…`),
      ...sources.ask.filter((s) => !picked.has(s.key)).map((s) => el('option', { value: s.key }, s.label))
    );

    chips.replaceChildren(
      el('span', { className: 'muted small' }, 'Ask'),
      ...favourites.map(chipFor),
      ...extras().map(chipFor),
      picker,
      el('span', { className: 'muted small' }, picked.size ? 'all at once' : '— nothing picked yet')
    );

    ask.disabled = !picked.size;
  };

  picker.onchange = () => {
    if (!picker.value) return;
    picked.add(picker.value);
    drawChips();
  };

  const run = async () => {
    const query = term.value.trim();
    if (!query) {
      said.textContent = 'Type something to search for.';
      return;
    }

    ask.disabled = true;
    ask.textContent = 'Asking…';
    said.textContent = `Asking ${picked.size} source${picked.size === 1 ? '' : 's'}…`;

    try {
      const { contributions } = await api('/api/import/wildcard/ask', {
        method: 'POST',
        body: JSON.stringify({ query, sources: [...picked] }),
      });
      arrived(contributions);
      const good = contributions.filter((c) => c.ok).length;
      said.textContent = `${good} answer${good === 1 ? '' : 's'} from ${picked.size} source${picked.size === 1 ? '' : 's'}.`;
    } catch (err) {
      said.textContent = err.message;
    } finally {
      ask.textContent = 'Ask these';
      drawChips();
    }
  };

  ask.onclick = run;
  term.onkeydown = (e) => { if (e.key === 'Enter' && picked.size) run(); };

  // The film sites are what this page is for, so they start on.
  for (const f of favourites) picked.add(f.key);
  drawChips();

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('strong', {}, 'Sites that will search for you'),
      el('span', { className: 'muted small' }, 'these know films, which is what StashDB cannot be asked about')),
    el('div', { className: 'searchline' }, term, ask),
    chips,
    el('div', { className: 'controls' }, said)
  );
}

/*
 * ------------------------------------------------------- what they all said
 *
 * Every answer, failures included, with why.
 */
function drawContributions(into, contributions, reread, sceneId) {
  if (!contributions.length) {
    into.replaceChildren();
    return;
  }

  const cards = contributions.map((c) => {
    if (!c.ok) {
      return el('div', { className: 'wccontrib bad' },
        el('div', { className: 'wcfrom' }, c.label),
        el('div', { className: 'muted small' }, c.note || 'nothing'));
    }

    const f = c.fields;
    const bits = [
      // A film answer's title is the film's name, not the scene's.
      c.kind === 'group' ? 'describes the film, not the scene' : null,
      f.date || null,
      f.studioName || null,
      f.director ? `dir. ${f.director}` : null,
      f.performers.length ? `${f.performers.length} performer${f.performers.length === 1 ? '' : 's'}` : null,
      f.tags.length ? `${f.tags.length} tag${f.tags.length === 1 ? '' : 's'}` : null,
      f.image ? 'has a cover' : null,
    ].filter(Boolean);

    /*
     * Read the page a search hit points at: it has the date, cast and cover
     * the result lacks. On a press, not automatically.
     */
    const read = c.url
      ? el('button', { className: 'chip', type: 'button' }, 'Read its page')
      : null;

    if (read) {
      read.onclick = async () => {
        read.disabled = true;
        read.textContent = 'Reading…';
        try {
          await reread(c.url);
        } finally {
          read.disabled = false;
          read.textContent = 'Read its page';
        }
      };
    }

    return el('div', { className: 'wccontrib' + (c.kind === 'group' ? ' film' : '') },
      el('div', { className: 'wcfrom' }, `${c.at}. ${c.label}`),
      f.image ? el('img', { className: 'wcart', src: f.image, loading: 'lazy', alt: '' }) : null,
      el('div', {},
        c.url
          ? el('a', { className: 'title', href: c.url, target: '_blank', rel: 'noreferrer' }, f.title || '(no title)')
          : el('div', { className: 'title' }, f.title || '(no title)'),
        el('div', { className: 'meta' }, bits.map((b) => el('span', {}, b)))),
      read ? el('div', { className: 'trackedactions' }, read) : null
    );
  });

  /* The compare sheet for contributions with art. */
  const withArt = contributions.filter((c) => c.ok && c.fields.image);
  const sheet = el('div', {});
  const look = el('button', { className: 'chip', type: 'button', hidden: !withArt.length }, 'Compare pictures');

  look.onclick = () => {
    if (sheet.firstChild) {
      sheet.replaceChildren();
      look.textContent = 'Compare pictures';
      return;
    }
    look.textContent = 'Hide the comparison';
    sheet.replaceChildren(compareSheet(sceneId, withArt.map((c) => ({
      key: c.label,
      label: `${c.at}. ${c.label}`,
      src: c.fields.image,
    })), {
      onClose: () => { sheet.replaceChildren(); look.textContent = 'Compare pictures'; },
    }));
  };

  into.replaceChildren(
    el('div', { className: 'feedhead' },
      el('h2', {}, `${contributions.length} answer${contributions.length === 1 ? '' : 's'}`),
      el('span', { className: 'muted' }, 'numbered as they arrived — the table below refers to them by number'),
      el('span', { className: 'spacer' }),
      look),
    el('div', { className: 'wccontriblist' }, ...cards),
    sheet
  );
}

/*
 * -------------------------------------------------- filling one in yourself
 *
 * Pick a studio, performer or tag Stash already has, from Stash's list.
 * A typed name Stash lacks would be silently dropped at write time.
 */
/* Which roster each field picks from. Title, description, date and cover have none. */
const ROSTER_OF = { studioName: 'studio', performers: 'performer', tags: 'tag' };

let rosterSeq = 0;

const askNames = (kind, q) =>
  api('/api/import/wildcard/names?kind=' + kind + '&q=' + encodeURIComponent(q))
    .then((r) => r.names || [])
    .catch(() => []);

/* All three kinds can be created (on their own button). */
const CAN_MAKE = new Set(['studio', 'performer', 'tag']);

const makeName = (kind, name) =>
  api('/api/import/wildcard/names', {
    method: 'POST',
    body: JSON.stringify({ kind, name }),
  });

/*
 * -> a control that adds to this row, or null.
 *
 * A type-ahead against the server (the roster is thousands long), shown in
 * a datalist; empty shows the most used. A name Stash lacks is refused out
 * loud, with a button to create it. `onAdd(name)` gets Stash's spelling.
 */
function adder(kind, listy, onAdd) {
  const id = `wcnames-${kind}-${++rosterSeq}`;

  const list = el('datalist', { id });
  const box = el('input', {
    type: 'text',
    className: 'facetinput wcadd',
    placeholder: CAN_MAKE.has(kind)
      ? (listy ? 'Add one — yours, or a new name…' : 'Pick one — or type a new name…')
      : (listy ? 'Add one of yours…' : 'Pick one of yours…'),
    autocomplete: 'off',
  });
  box.setAttribute('list', id);

  const said = el('span', { className: 'muted small' }, '');

  // What the last ask came back with, which is what a typed name is checked
  // against. Never the roster in general — only what this box has seen.
  let seen = [];
  let timer = null;
  let asked = 0;

  const suggest = (q) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++asked;
      const names = await askNames(kind, q);
      // A slower answer to an older keystroke must not replace a newer one.
      if (mine !== asked) return;
      seen = names;
      list.replaceChildren(...names.map((row) => el('option', { value: row.name })));
    }, 220);
  };

  /*
   * Create the typed name. Only appears after a refusal; the only thing on
   * the page that creates a record. Returns an existing one if made meanwhile.
   */
  const make = el('button', { className: 'chip wcmake', type: 'button' }, '');
  make.hidden = true;

  const offerToMake = (typed) => {
    if (!CAN_MAKE.has(kind)) return;
    make.textContent = `Create the ${kind} “${typed}”`;
    make.hidden = false;
    make.onclick = async () => {
      make.disabled = true;
      make.textContent = 'Creating…';
      try {
        const made = await makeName(kind, typed);
        make.hidden = true;
        said.textContent = made.made
          ? `Created the ${kind} “${made.name}”.`
          : `Stash already had “${made.name}” — used that.`;
        box.value = '';
        seen = [...seen, { name: made.name }];
        onAdd(made.name);
      } catch (err) {
        said.textContent = err.message;
        make.textContent = `Create the ${kind} “${typed}”`;
      } finally {
        make.disabled = false;
      }
    };
  };

  const commit = () => {
    const typed = box.value.trim();
    if (!typed) return;

    const hit = seen.find((row) => row.name.toLowerCase() === typed.toLowerCase());
    if (!hit) {
      said.textContent = CAN_MAKE.has(kind)
        ? `Stash has no ${kind} called “${typed}” yet.`
        : `Stash has no ${kind} called “${typed}”.`;
      offerToMake(typed);
      return;
    }

    said.textContent = '';
    box.value = '';
    make.hidden = true;
    // Stash's spelling, not yours — the write matches on the name exactly.
    onAdd(hit.name);
  };

  box.oninput = () => { said.textContent = ''; make.hidden = true; suggest(box.value.trim()); };
  box.onchange = commit;
  box.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };

  // The most-used up front, so the box is useful before a key is pressed.
  suggest('');

  return el('span', { className: 'wcaddwrap' }, box, list, make, said);
}

/*
 * ------------------------------------------------------- a cover of your own
 *
 * A file or an address, held server-side as another option on the Cover
 * row. Reaches Stash only if ticked when Write is pressed.
 */
function artbox(onSet) {
  const said = el('span', { className: 'muted small' }, '');

  const chooser = el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif',
  });
  const up = el('button', { className: 'chip', type: 'button' }, 'Use this picture');

  const address = el('input', {
    type: 'url',
    className: 'facetinput wcadd',
    placeholder: 'or paste a picture address…',
    autocomplete: 'off',
  });
  const grab = el('button', { className: 'chip', type: 'button' }, 'Fetch it');

  const busy = (on, word) => {
    up.disabled = on;
    grab.disabled = on;
    if (word) said.textContent = word;
  };

  const took = (art, word) => {
    said.textContent = word;
    chooser.value = '';
    address.value = '';
    onSet(art.url);
  };

  up.onclick = async () => {
    const file = chooser.files[0];
    if (!file) { said.textContent = 'Choose a picture first.'; return; }

    busy(true, `Sending ${file.name}…`);
    try {
      // Not api(): that stamps a JSON content type on anything with a body,
      // and this body is a picture.
      const res = await fetch('/api/import/wildcard/art', { method: 'POST', body: file });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || res.statusText);
      took(payload, `${file.name} is on the row — tick it to use it.`);
    } catch (err) {
      said.textContent = err.message;
    } finally {
      busy(false);
    }
  };

  const fetchIt = async () => {
    const typed = address.value.trim();
    if (!typed) { said.textContent = 'Paste the address of a picture.'; return; }

    busy(true, 'Fetching…');
    try {
      const art = await api('/api/import/wildcard/art', {
        method: 'POST',
        body: JSON.stringify({ url: typed }),
      });
      took(art, 'Fetched — tick it to use it.');
    } catch (err) {
      said.textContent = err.message;
    } finally {
      busy(false);
    }
  };

  grab.onclick = fetchIt;
  address.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); fetchIt(); } };

  return el('span', { className: 'wcaddwrap wcartbox' },
    chooser, up, address, grab, said);
}

/*
 * Title and date can be typed. Date uses a date input; the server still
 * checks it. Typing back Stash's value clears the choice.
 */
const TYPED_OF = { title: 'text', date: 'date' };

function typer(key, now, scene, onSet) {
  const held = String(scene[key] || '').trim();
  const dated = TYPED_OF[key] === 'date';

  const box = el('input', {
    type: dated ? 'date' : 'text',
    className: 'facetinput wcadd',
    placeholder: dated ? '' : 'Type one…',
    autocomplete: 'off',
  });
  box.value = now ? String(now.value || '') : held;

  /*
   * A date input fires `change` once all segments are filled, so typing a year
   * fires at "0001" and the redraw kills the box. Years outside living memory
   * are treated as unfinished typing.
   */
  const ready = (typed) => {
    if (!dated || !typed) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(typed)) return false;
    const year = Number(typed.slice(0, 4));
    return year >= 1900 && year <= 2100;
  };

  const commit = () => {
    const typed = box.value.trim();
    if (!ready(typed)) return;
    onSet(!typed || typed === held ? null : typed);
  };

  box.onchange = commit;
  box.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };

  /* On leaving, drop a half-typed year back to the chosen value. */
  box.onblur = () => {
    if (ready(box.value.trim())) return;
    box.value = now ? String(now.value || '') : held;
  };

  return el('span', { className: 'wcaddwrap' }, box);
}

/*
 * --------------------------------------------------------- the record
 *
 * One row per field with every answer along it. Stash's value is first and
 * selected; untouched fields aren't written.
 */
function drawFields(into, scene, contributions, chosen, redraw, frames = []) {
  const answered = contributions.filter((c) => c.ok);

  const value = (v) => (Array.isArray(v) ? v : v == null ? '' : String(v));
  const isEmpty = (v) => (Array.isArray(v) ? !v.length : !String(v || '').trim());

  /* Fill empty fields from the first answer that has one. Never overrules. */
  const fillBlanks = () => {
    let filled = 0;
    for (const [key] of FIELDS) {
      if (chosen.has(key)) continue;
      if (!isEmpty(scene[key])) continue;
      const hit = answered.find((c) => !isEmpty(c.fields[key]));
      if (!hit) continue;
      chosen.set(key, { label: hit.label, value: hit.fields[key] });
      filled += 1;
    }
    redraw();
    return filled;
  };

  const fill = el('button', { className: 'chip', type: 'button', disabled: !answered.length }, 'Fill the blanks');
  const clear = el('button', { className: 'chip', type: 'button', disabled: !chosen.size }, 'Undo my choices');
  fill.onclick = () => fillBlanks();
  clear.onclick = () => { chosen.clear(); redraw(); };

  const rows = FIELDS.map(([key, label, kind]) => {
    const now = chosen.get(key);
    const options = [
      { label: 'Stash has', value: scene[key], mine: true },
      ...answered
        .map((c) => ({ label: `${c.at}. ${c.label}`, value: c.fields[key] }))
        .filter((o) => !isEmpty(o.value)),
    ];

    /* A union of every answer, only when it differs from each single option. */
    if (kind === 'list') {
      const all = [...new Set(answered.flatMap((c) => c.fields[key] || []))];
      if (all.length && !options.some((o) => Array.isArray(o.value) && o.value.length === all.length)) {
        options.push({ label: 'Everything above', value: all, every: true });
      }
    }

    /* Frames already cut, offered as covers. Never starts ffmpeg. */
    if (key === 'image') {
      for (const frame of frames) {
        options.push({ label: `Frame at ${frame.pct}%`, value: frame.url, frame: true });
      }
    }

    /* Your own pick as an option on the row, so it shows as selected. */
    if (now && !options.some((o) => !o.mine && sameValue(o.value, now.value))) {
      options.push({ label: now.label || 'Yours', value: now.value, own: true });
    }

    const picks = options.map((option) => {
      const on = option.mine ? !now : now && sameValue(now.value, option.value);
      const chip = el('button', { type: 'button', className: 'chip wcopt' + (on ? ' on' : '') },
        el('span', { className: 'wcoptfrom' }, option.label),
        el('span', { className: 'wcoptval' }, preview(option.value, kind)));

      chip.onclick = () => {
        if (option.mine) chosen.delete(key);
        else chosen.set(key, { label: option.label, value: option.value });
        redraw();
      };
      return chip;
    });

    /* The picker for fields attached by name. Adds to what's currently chosen. */
    const from = ROSTER_OF[key];
    const typed = !from && TYPED_OF[key]
      ? typer(key, now, scene, (value) => {
        if (value == null) chosen.delete(key);
        else chosen.set(key, { label: 'Yours', value });
        redraw();
      })
      : null;

    /* The Cover row's upload/URL control. Replaces the choice. */
    const arty = key === 'image'
      ? artbox((url) => { chosen.set(key, { label: 'Yours', value: url }); redraw(); })
      : null;

    const own = from
      ? adder(from, kind === 'list', (name) => {
        if (kind === 'list') {
          const held = Array.isArray(now?.value) ? now.value : (scene[key] || []);
          if (held.includes(name)) return;
          chosen.set(key, { label: 'Yours', value: [...held, name] });
        } else {
          chosen.set(key, { label: 'Yours', value: name });
        }
        redraw();
      })
      : null;

    /* Remove one entry from a list you changed. */
    const drop = kind === 'list' && Array.isArray(now?.value) && now.value.length
      ? now.value.map((name) => {
        const chip = el('button', { type: 'button', className: 'chip wcdrop' }, `${name} ✕`);
        chip.title = `Take ${name} back off`;
        chip.onclick = () => {
          const left = now.value.filter((n) => n !== name);
          if (left.length) chosen.set(key, { label: 'Yours', value: left });
          else chosen.delete(key);
          redraw();
        };
        return chip;
      })
      : [];

    const only = options.length === 1 && !own && !typed && !arty;

    return el('div', { className: 'wcrow' + (now ? ' picked' : '') },
      el('div', { className: 'wclabel' },
        label,
        only ? el('div', { className: 'muted small' }, 'nobody offered one') : null),
      el('div', { className: 'wcopts' },
        ...picks,
        own || typed || arty
          ? el('div', { className: 'controls wcownline' }, own || typed || arty, ...drop)
          : null)
    );
  });

  into.replaceChildren(
    el('div', { className: 'feedhead' },
      el('h2', {}, 'The record'),
      el('span', { className: 'muted' },
        chosen.size ? `${chosen.size} field${chosen.size === 1 ? '' : 's'} changed` : 'nothing changed yet'),
      el('span', { className: 'spacer' }),
      el('div', { className: 'viewtools' }, fill, clear)),
    el('div', { className: 'wcfieldlist' }, ...rows)
  );
}

const sameValue = (a, b) => (Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((x, i) => x === b[i])
  : a === b);

/* A short preview of a value to choose by. */
function preview(value, kind) {
  if (kind === 'image') {
    return value
      ? el('img', { className: 'wcoptart', src: value, loading: 'lazy', alt: '' })
      : el('span', { className: 'muted' }, 'none');
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : el('span', { className: 'muted' }, 'none');
  }
  const text = String(value || '');
  if (!text.trim()) return el('span', { className: 'muted' }, 'none');
  if (kind === 'long' && text.length > 140) return text.slice(0, 140) + '…';
  return text;
}

/* ------------------------------------------------------------- the writing */

/*
 * Write, then rename (after, so the name uses what you chose). The preview
 * plans against unsaved choices. Ticked by default; only on /pc-import.
 */
function savePanel(scene, chosen, params) {
  const done = el('input', { type: 'checkbox' });
  const said = el('span', { className: 'muted small' }, '');
  const save = el('button', { className: 'add', type: 'button' }, 'Write it to Stash');

  const home = scene.path && scene.path.startsWith('/pc-import/');
  const also = el('input', { type: 'checkbox', checked: home });
  const willBe = el('span', { className: 'muted small' }, home ? 'working out the name…' : '');
  const renameRow = home
    ? el('div', { className: 'controls wcrename' },
        el('label', { className: 'check' }, also, ' Rename the file too'),
        willBe)
    : null;

  /* Re-planned on a delay as choices change. */
  let timer = null;
  let asked = 0;
  // Ticked until you untick it. A refusal turns it off; a title turns it back
  // on unless you turned it off.
  let touched = false;
  also.onchange = () => { touched = true; };
  const refresh = () => {
    if (!home) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const values = {};
      for (const [key, pick] of chosen) values[key] = pick.value;
      const mine = ++asked;
      try {
        const plan = await api('/api/import/wildcard/scene/' + encodeURIComponent(scene.id) + '/rename/plan', {
          method: 'POST',
          body: JSON.stringify({ values }),
        });
        // A slower answer to an older question must not overwrite a newer one.
        if (mine !== asked) return;
        willBe.textContent = plan.can ? '→ ' + plan.to : plan.why;
        also.disabled = !plan.can;
        also.checked = plan.can ? (touched ? also.checked : true) : false;
      } catch (err) {
        if (mine === asked) willBe.textContent = err.message;
      }
    }, 350);
  };

  save.onclick = async () => {
    const values = {};
    for (const [key, pick] of chosen) values[key] = pick.value;
    if (done.checked) values.organized = true;

    if (!Object.keys(values).length) {
      said.textContent = 'Nothing has been chosen, so there is nothing to write.';
      return;
    }

    save.disabled = true;
    save.textContent = 'Writing…';

    try {
      const saved = await api('/api/import/wildcard/scene/' + encodeURIComponent(scene.id), {
        method: 'POST',
        body: JSON.stringify({ values, rename: home && also.checked && !also.disabled }),
      });
      said.textContent = `Wrote ${saved.wrote.join(', ')}.`
        + (saved.skipped.length ? ` Left alone: ${saved.skipped.join('; ')}.` : '')
        + renameSaid(saved.renamed);
      save.textContent = 'Written';
      // Re-read rather than trusting what we sent: a performer Stash did not
      // have was skipped, and the row should say so on the next pass.
      setTimeout(() => go(new URLSearchParams(params)), 1400);
    } catch (err) {
      save.disabled = false;
      save.textContent = 'Write it to Stash';
      said.textContent = err.message;
    }
  };

  const node = el('section', { className: 'searchpanel wcsave' },
    el('div', { className: 'controls' },
      save,
      el('label', { className: 'check' }, done, ' Mark organised'),
      said),
    renameRow,
    el('div', { className: 'controls' },
      el('span', { className: 'muted small' },
        'Only the fields you changed are written. Performers, studios and tags are attached '
        + 'only where Stash already has one of that name — anything it does not have is reported, not invented. '
        + 'One Stash is missing can be created from the box on its row, by pressing.'))
  );

  return { node, refresh };
}

/* A refused rename is a note, not a failure: the record was written. */
function renameSaid(out) {
  if (!out) return '';
  if (!out.ok) return ` The file was left alone: ${out.why}`;
  return ` Renamed to ${out.to.split('/').pop()}.`
    + (out.scanned ? '' : ' Stash would not rescan, so its path is stale until it does.');
}
