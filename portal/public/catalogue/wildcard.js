/* One scene, several sources, assembled by hand. */

import { api, el } from '../util.js';
import { SECTION_OF, painterFor, show, state } from '../import/core.js';
import { compareSheet } from './compare.js';
import { generateBit, liveArt } from './liveart.js';

/* ================================================================ wild card
 *
 * The page for when nothing recognises the file.
 *
 * Match asks "which scene is this" of sources that can answer from a
 * fingerprint, and when one of them can, that is the end of it. This page is
 * the other case — the DVD rip nobody has ever fingerprinted, the file whose
 * name is a film and a scene number — where the honest position is that no
 * single source knows what this is and several of them each know a bit.
 *
 * What you were doing instead was opening three tabs. The film on AdultEmpire,
 * its scene list on HotMovies, the credits somewhere else, and then copying a
 * field at a time into Stash. So this keeps the copying and takes away the
 * tabs: you hand it addresses and you hand it search sources, every answer
 * lands as a **contribution**, and the record is built one field at a time
 * with you saying which contribution wins each one.
 *
 * **Nothing is merged for you and nothing is ranked.** Two sources disagreeing
 * about a date is the thing you came here to settle, and a page that quietly
 * picked one would be hiding the only interesting part of the answer. The one
 * concession is "fill the blanks", which only ever touches fields Stash has
 * nothing in — it cannot overrule anything, so it cannot be wrong in a way you
 * would not see.
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
 * The fields a record is made of, in the order they are worth deciding.
 *
 * `list` fields are the two where a contribution offers a set rather than a
 * value, and where "all of them at once" is a sensible thing to want. `image`
 * is a value like any other and is drawn as a picture, because comparing four
 * covers as URLs is not comparing them at all.
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
 * The sources worth having one press away.
 *
 * There are 193 that can search by name and a picker for all of them, but
 * these five are the ones that know a *film* — which is the question this page
 * exists to answer, and the question StashDB structurally cannot be asked. Any
 * that are not installed simply do not appear.
 */
const FAVOURITES = [
  'AdultEmpire',
  // The AdultEmpire catalogue reached through a door that opens. Same stock,
  // same box art, same scene indexes — and where AdultEmpire is the one this
  // portal will not crawl itself, GameLink is scraped by Stash, from this
  // machine, which is the arrangement that was always fine.
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

/* ------------------------------------------------------------ which scene
 *
 * The same piles, keyword and ordering the match page browses by.
 *
 * They are the same question — "which of these does nothing recognise" — and
 * having to remember a filename to get here was the difference between using
 * this page and not. The three piles come off the match queue itself rather
 * than a second implementation of the same filters, so a pile cannot mean one
 * thing on that page and something else on this one.
 *
 * **Anything** is the fourth and it is not a pile: it is a free search across
 * the whole library, for building up a scene that is already matched. It needs
 * a keyword, because "every scene in the library, newest first" is not a thing
 * anybody came here to page through.
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

/*
 * Named here as well as in match.js, and it has to be the same word. The
 * address only carries `sort` when it differs from the default, so a
 * disagreement between the two pages would be an address that sorted one way
 * on one of them and another way on the other.
 */
const SORT_DEFAULT = 'added';

function pickScene(body, params) {
  const mode = PILES.some(([m]) => m === params.get('mode')) ? params.get('mode') : 'unmatched';

  const panel = el('section', { className: 'searchpanel' });
  const found = el('div', {});
  body.replaceChildren(panel, found);

  /*
   * Every control goes through the address, so a pile you were working down is
   * a pile you can come back to — and writing a record sends you back to the
   * page of the list you were on rather than to the top of it.
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

  /*
   * Ordering is the queue's, and the free search has none to offer — Stash's
   * own `q` ranks by relevance and there is no honest way to promise "by scene
   * date" on top of that. A live control that changes nothing is worse than
   * one that is not there.
   */
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

/*
 * A match-queue row in the shape this page's rows read.
 *
 * The two endpoints describe a scene slightly differently — the queue carries
 * fingerprints and dead ids this page has no use for, and names the studio as
 * an object where this page wants the name. Converted here, once, rather than
 * teaching the row to read two shapes.
 */
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
  /*
   * The pile travels with the choice. Writing a record sends you back to the
   * list you were working down, on the page you were on — the alternative is
   * page one of the default pile after every single scene.
   */
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

  // Same picture as a shelf tile now: hover it for the preview loop, run along
  // the bottom for the scrub. A pile you are picking a scene out of is exactly
  // where one still frame was never enough.
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

/* ------------------------------------------------------------- the bench
 *
 * The scene, the ways of asking, the answers, and the record being built. All
 * on one screen on purpose: the whole complaint this page answers is that the
 * information was spread across three tabs.
 */
function drawBench(body, params, scene, sources) {
  /*
   * Every answer that has arrived this visit, in arrival order. Kept here
   * rather than inside the panels because the field table reads across all of
   * them and the panels only add to them — a URL read and a keyword search are
   * two ways of filling the same list.
   */
  const contributions = [];

  const answers = el('div', { className: 'wccontribs' });
  const table = el('div', { className: 'wcfields' });

  // What has been decided, field -> { label, value }. Absent means "leave
  // whatever Stash already has", which is why an untouched page writes nothing.
  const chosen = new Map();

  /*
   * Answers are numbered once, on arrival, and only the ones that answered.
   * The cards and the field table below both refer to a contribution by its
   * number, so the two must count the same things — numbering each list where
   * it is drawn had the cards calling HotMovies 7 and the table calling it 6,
   * because one counted the failures and the other did not.
   */
  let numbered = 0;

  /*
   * The description, offered once, the first time anybody has one.
   *
   * Every other field stays on "Stash has" until you press it, and that is
   * right for the fields you came here to argue about — two sources disagreeing
   * about a date is the thing you are here to settle. A description is not that
   * argument. It is a paragraph of blurb that Stash almost never has and that
   * you were going to take from whoever offered it, so the page takes it and
   * shows you which source it came from, ticked, with everything else on the
   * row still one press away.
   *
   * Only into an empty field, and only once a visit — it cannot overrule a
   * description Stash already holds, and "Undo my choices" stays undone rather
   * than being re-decided under you by the next contribution.
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

  /*
   * The frames already on disk for this scene, so the Cover row can offer them.
   *
   * Held here rather than read by the field table, which is redrawn on every
   * chip press — a fetch per press would be a fetch per press. Nothing here
   * cuts anything: the panel above is where cutting is asked for, and it hands
   * its list over through `moreFrames` on load and after every cut.
   */
  let frames = [];

  const redraw = () => {
    drawContributions(answers, contributions, reread, scene.id);
    drawFields(table, scene, contributions, chosen, redraw, frames);
    saving.refresh();
  };

  /*
   * The frame panel is the only thing that asks for these — it already does,
   * on load and again after every cut — and it hands the list over here. A
   * second fetch from this side would be the same request twice on every visit
   * for a list one of them already has.
   */
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

/* --------------------------------------------------- searching by the picture
 *
 * The tool this page was still missing.
 *
 * When the filename is a slug and no source knows the title, the thing you
 * actually do is take a frame to Google Lens or Yandex and find the page that
 * way — and then you are back here pasting the URL into the box above, which
 * is exactly the loop this page is for. So the frames belong on it.
 *
 * **One frame is a coin toss.** The row thumbnail is cut at a quarter in and
 * that is right for filling a row, but a reverse search wants a face, a room,
 * a title card — something an engine has seen on the page you are looking for.
 * So this cuts several across the file and lets you look, and cuts more when
 * none of them are any good.
 *
 * **The portal cannot do the search itself, and does not pretend to.** The
 * engines want either an upload or a publicly reachable URL, and this runs on
 * your LAN — there is no address to hand Yandex that Yandex can fetch. What it
 * can do is put the frame on your clipboard and open the engine on the paste
 * screen, which turns "save the file, find the file, upload the file" into two
 * presses. Same rule the rest of the portal keeps: it offers the place to
 * look, and the fetching is yours.
 */

/*
 * Where each engine takes a pasted or dropped image.
 *
 * Plain links with nothing substituted into them, because there is nothing to
 * substitute — this is a set of bookmarks, and saying so is more honest than
 * dressing it up as an integration.
 */
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
 * One frame, and the two things you do with it.
 *
 * **Copy** puts the actual image bytes on the clipboard, not its address — an
 * address on this LAN means nothing to Yandex. Written as a PNG because that
 * is the one image type `navigator.clipboard.write` is required to accept, so
 * the JPEG goes through a canvas on the way.
 *
 * **Save** is the fallback for a browser that refuses the clipboard, and for
 * the engines that only take a file.
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

/* ------------------------------------------------------------ asking by URL
 *
 * The half that replaces the copying. You already have the page open; this
 * reads it. Stash picks the scraper off the host, so there is nothing to
 * choose and nothing to configure.
 */
function urlPanel(arrived, sources) {
  const box = el('textarea', {
    className: 'facetinput wcurls',
    rows: 3,
    placeholder: 'Paste the pages you found — scene pages or film pages, one address per line',
    spellcheck: false,
  });

  const read = el('button', { className: 'add', type: 'button' }, 'Read these pages');
  /*
   * Both counts, because they are different sets and the difference is the
   * point. A film page on AdultEmpire or AdultFilmIndex is read by the second
   * list and not the first — AdultFilmIndex cannot read a scene at all any
   * more — and this is the only way to reach those sites, since not one of the
   * 118 can be searched by name.
   */
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

/* -------------------------------------------------------- asking by keyword
 *
 * The half that finds the page for you. These are sites that can search
 * themselves — a NAME scrape, which the match page has never used — and the
 * five favourites are there because they are the ones that know a film rather
 * than a scene.
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

/* ------------------------------------------------------- what they all said
 *
 * Every answer, the empty ones included. A source that failed stays on screen
 * saying why — "AdultEmpire had nothing" and "AdultEmpire returned a 403" are
 * different facts and only one of them means stop asking it.
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
      // Said first and said plainly. A film answer's title is the film's name,
      // and taking it as the scene title gives you four scenes all called
      // "Oil Overload #15" — everything else on it is exactly what you came
      // for, which is what makes the distinction worth drawing rather than
      // hiding the answer.
      c.kind === 'group' ? 'describes the film, not the scene' : null,
      f.date || null,
      f.studioName || null,
      f.director ? `dir. ${f.director}` : null,
      f.performers.length ? `${f.performers.length} performer${f.performers.length === 1 ? '' : 's'}` : null,
      f.tags.length ? `${f.tags.length} tag${f.tags.length === 1 ? '' : 's'}` : null,
      f.image ? 'has a cover' : null,
    ].filter(Boolean);

    /*
     * Reading the page a search hit points at.
     *
     * A search result is thin by nature — AdultEmpire's returns a title and a
     * link and nothing else — while the page behind that link has the date,
     * the cast and the cover on it. Measured on this library: the same
     * HotMovies scene is a title from the keyword search and a title, a date,
     * a studio, a cast and a cover from its own address.
     *
     * So the loop closes here: search to find the page, then read the page.
     * It is a press rather than automatic because a keyword search that
     * returned five hits would otherwise fetch five pages nobody asked for.
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

  /*
   * The index sheet. Here the question is not "which of these is it" — you
   * already decided that by pasting the address — it is "is this the same
   * scene at all", and a film's box art against a frame from the middle of it
   * is exactly the comparison that needs the size.
   */
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

/* -------------------------------------------------- filling one in yourself
 *
 * The page's oldest rule is that it will not invent a performer, a studio or a
 * tag: a scraped name Stash does not hold is reported and dropped, because
 * creating records off the back of a guess gives the guess a page of its own.
 *
 * The cost of that rule was a field nobody scraped being a field you could not
 * fill — you knew the studio, Stash was holding the studio, and the row said
 * "nobody offered one". So this is the other half of the rule rather than an
 * exception to it: you may add anything **Stash already has**, chosen from
 * Stash's own list. Still nothing new created, still nothing invented.
 *
 * A list rather than a text box for exactly that reason. A typed name that
 * Stash does not have is a field that silently stays empty at write time, and
 * the one thing worse than a row you cannot fill is a row you think you filled.
 */
/*
 * Which roster a field is picked from, and nothing for the fields that are not
 * picked from one. Title and Description are prose and a list of them would be
 * meaningless; Date is a date; Cover is a picture and has the frames instead.
 */
const ROSTER_OF = { studioName: 'studio', performers: 'performer', tags: 'tag' };

let rosterSeq = 0;

const askNames = (kind, q) =>
  api('/api/import/wildcard/names?kind=' + kind + '&q=' + encodeURIComponent(q))
    .then((r) => r.names || [])
    .catch(() => []);

/*
 * What you are allowed to make one of, which is now all three.
 *
 * A studio nobody has imported before is not in Stash for the ordinary reason
 * that nothing has ever carried it, and a performer credited on one DVD is the
 * same. Tags were held back a version longer, on the grounds that a tag you
 * cannot find is usually one that exists under another spelling. True — and
 * already answered by the box: it searches the roster as you type, so by the
 * time the button appears you have looked and it is not there.
 */
const CAN_MAKE = new Set(['studio', 'performer', 'tag']);

const makeName = (kind, name) =>
  api('/api/import/wildcard/names', {
    method: 'POST',
    body: JSON.stringify({ kind, name }),
  });

/*
 * -> a control that adds to this row, or null.
 *
 * **A box that suggests, not a list that truncates.** The first cut of this was
 * a `<select>` of the roster, and it was wrong in the way that matters: the
 * server returns the forty most-used, so it quietly offered 40 of 1,537
 * performers and 40 of 1,174 tags. A list you cannot find your answer in is the
 * same failure as a box that accepts a wrong one, just further from where you
 * would notice it.
 *
 * So it asks the server as you type, and what comes back fills a datalist —
 * which the browser then offers as you keep typing. Empty, it shows the
 * most-used, which is the useful default on a library this size.
 *
 * **It still refuses a name Stash does not have** — silently, at least. The
 * write attaches these by name and only where Stash holds one, so a typed name
 * that does not exist would be a field you think you filled and did not. What
 * you type is checked against what came back, and anything else is said out
 * loud rather than swallowed.
 *
 * Said out loud *and offered*: the refusal comes with a button that creates the
 * record, because a name you typed while looking at the file is not the guess
 * the no-inventing rule was written against. Nothing is created by typing it
 * and nothing by the write — only by that press.
 *
 * `onAdd(name)` gets one name at a time, spelled the way Stash spells it —
 * never the way you typed it. Case and spacing come from the record.
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
   * The blank half of the box: a name Stash does not have yet.
   *
   * It appears only after the box has refused the name, it says the name it
   * would create, and it takes a press of its own. Typing creates nothing and
   * the write creates nothing — this button is the only thing on the page that
   * makes a record, which is what keeps "it will not invent one" true while
   * still letting you add the studio you are looking at.
   *
   * The server hands back the name as Stash spells it, and hands back the
   * existing one rather than a second if somebody made it in between.
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

/* ------------------------------------------------------- a cover of your own
 *
 * The Cover row could offer Stash's, every scraper's, and any frame cut out of
 * the file — and not the one you actually have. A scanned DVD sleeve, or a
 * still on a page no scraper here reads, was the one answer on the page you
 * could see and not give.
 *
 * Two ways in and one outcome: the picture is held server-side under an
 * address of its own and becomes an option on the row like any other. Nothing
 * is written by choosing it. It reaches Stash when the row is the one ticked
 * and Write is pressed, and not before — so a picture you picked and thought
 * better of is undone by ticking something else, the same as everything here.
 *
 * The address is fetched by the server rather than handed to Stash as a link,
 * which is what makes a paste from a hotlink-protected site work: the bytes
 * are checked here and travel to Stash as bytes.
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
 * The two fields that are not picked from anything.
 *
 * Studio, performers and tags are attached by name and only where Stash holds
 * one, which is why they get a box that refuses what Stash does not have. A
 * title is prose and a date is a date: there is no roster to check them
 * against, nothing is created by writing one, and the rule that guards the
 * other three has nothing to say about these.
 *
 * Which left them as the one gap on the page. A scene whose sources all missed
 * it, or named it wrongly, could be read off the file name in front of you and
 * still not typed in — the row said "nobody offered one" and meant it.
 *
 * A date input rather than a text box for the date, because the write refuses
 * anything Stash cannot read as one and the browser already knows how to ask.
 * The server still checks it: this is the convenient shape, not the guard.
 *
 * Typing back exactly what Stash already holds clears the choice rather than
 * setting it. A field you have not changed is a field this page does not
 * write, and going the long way round to the value that was there is not a
 * change — it would otherwise show as one, and count in "fields changed".
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
   * **A year is four keystrokes and the box only gets one.**
   *
   * A date input fires `change` the moment all three of its segments hold
   * something, so typing 1 9 9 8 into the year fires it at "0001" — and this
   * page redraws the whole table on a change, which threw the input away with
   * the caret still in it. You got one digit of a year in before the field
   * under your hands was replaced by a new one.
   *
   * So a year outside living memory is read as a year you are halfway through
   * typing rather than as your answer. Nothing is set, nothing is redrawn, and
   * the next keystroke lands in the same box it left.
   *
   * The cost is that a genuine 0999 cannot be typed here, which is a trade
   * worth making for a library of video.
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

  /*
   * Half a year left in the box would read as a date that is set and is not,
   * which is the one failure this page is built to avoid. Leaving takes it
   * back to whatever is actually chosen.
   */
  box.onblur = () => {
    if (ready(box.value.trim())) return;
    box.value = now ? String(now.value || '') : held;
  };

  return el('span', { className: 'wcaddwrap' }, box);
}

/* --------------------------------------------------------- the record
 *
 * One row per field, and along each row every answer anybody gave for it.
 *
 * This is the whole page. Reading across a row is the comparison you were
 * doing between browser tabs, and pressing one of the options is the copy you
 * were doing by hand. What Stash already holds is the first option on every
 * row and it is the one selected until you say otherwise — so a field you do
 * not touch is a field this page will not write.
 */
function drawFields(into, scene, contributions, chosen, redraw, frames = []) {
  const answered = contributions.filter((c) => c.ok);

  const value = (v) => (Array.isArray(v) ? v : v == null ? '' : String(v));
  const isEmpty = (v) => (Array.isArray(v) ? !v.length : !String(v || '').trim());

  /*
   * Take every field Stash has nothing in from the first answer that has one.
   *
   * The one automatic thing on the page, and it is safe by construction: it
   * cannot overrule a value, only fill an absence, so the worst it can do is
   * offer you something you then change. Anything cleverer — preferring a
   * source, scoring the answers — would be the page making the judgement you
   * came here to make.
   */
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

    /*
     * A set built out of every answer at once. Only where it says something
     * the individual options do not — two sources naming four performers
     * between them is the case this exists for, and two sources naming the
     * same one is not.
     */
    if (kind === 'list') {
      const all = [...new Set(answered.flatMap((c) => c.fields[key] || []))];
      if (all.length && !options.some((o) => Array.isArray(o.value) && o.value.length === all.length)) {
        options.push({ label: 'Everything above', value: all, every: true });
      }
    }

    /*
     * The frames this scene has already had cut, as covers.
     *
     * They are on the page anyway — the panel above cuts them so you can search
     * by the picture — and a frame from the middle of the file is a better
     * cover than no cover at all, which is what these scenes otherwise have.
     * Offered rather than cut: this adds whatever exists and never starts
     * ffmpeg, because that panel is where cutting is asked for.
     */
    if (key === 'image') {
      for (const frame of frames) {
        options.push({ label: `Frame at ${frame.pct}%`, value: frame.url, frame: true });
      }
    }

    /*
     * What you chose yourself, as an option like any other.
     *
     * Without this the pick is invisible: the chips are built out of the
     * answers that arrived, a name you picked from Stash is in none of them,
     * and the row would show "Stash has" unticked with nothing ticked instead —
     * a field that is set and looks unset. Pressing it again clears it, which
     * is what every other chip on the row does.
     */
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

    /*
     * The pick-your-own control, for the three fields that are attached by name
     * and only where Stash has one. `now` is read here rather than from the
     * roster: adding to a list means adding to whatever is currently chosen,
     * not starting again from what Stash holds.
     */
    const from = ROSTER_OF[key];
    const typed = !from && TYPED_OF[key]
      ? typer(key, now, scene, (value) => {
        if (value == null) chosen.delete(key);
        else chosen.set(key, { label: 'Yours', value });
        redraw();
      })
      : null;

    /*
     * The Cover row's own control: a file off your machine, or an address to
     * go and get. Set rather than added — a cover is one picture, so this
     * replaces whatever was ticked, the same as pressing another chip does.
     */
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

    /*
     * Taking one back off a list you built. Only offered on a list you have
     * actually changed — the row's other options are whole answers and are
     * swapped rather than edited, so there is nothing to remove from them.
     */
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

/*
 * Enough of a value to choose by, and no more. A description runs to a
 * paragraph and a cover is a URL nobody can read — both are shown as what they
 * are rather than as their text.
 */
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
 * The write, and the rename that finishes it.
 *
 * **The file is renamed after the record is written, never before.** The name
 * is made of the title and studio and date you just chose, so asking for it
 * ahead of the write would name the file after the guess you arrived with. The
 * preview line is the exception — that one is planned against your unsaved
 * choices on purpose, so the name is in front of you before you tick anything.
 *
 * It is ticked by default, and that is a smaller thing than it sounds: the
 * name is on screen next to the tick, it is one file, and you are pressing a
 * button you came to this page to press. The rule the 2026-09-12 plugin broke
 * was renaming files nobody was looking at — 456 of them, unattended. This is
 * one file with its new name written above the button.
 *
 * Only offered on /pc-import, which is the only mount the server will rename
 * inside anyway. The check here just keeps the tick off a row that would be
 * refused.
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

  /*
   * Re-planned as the choices change, and late rather than often: every chip
   * press redraws the table, and a request per press would be a request per
   * press. The name only matters at the moment you read it.
   */
  let timer = null;
  let asked = 0;
  // Ticked for you until you say otherwise. A refusal forces it off — there is
  // nothing to rename to yet — and picking a title turns it back on, which it
  // must not do if turning it off was your decision rather than the plan's.
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

/*
 * A refused rename is a sentence, not a failure. The record was written either
 * way, and the write is the thing that was worth the trip.
 */
function renameSaid(out) {
  if (!out) return '';
  if (!out.ok) return ` The file was left alone: ${out.why}`;
  return ` Renamed to ${out.to.split('/').pop()}.`
    + (out.scanned ? '' : ' Stash would not rescan, so its path is stale until it does.');
}
