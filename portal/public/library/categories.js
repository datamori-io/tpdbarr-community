/*
 * Categories — the index, one category's page, and the editor behind both.
 *
 * A category is portal-owned (see src/categories.mjs): a name, a blurb, a
 * cover, the scenes you put in by hand and a rule that keeps finding more. So
 * everything on these two pages is a write to the portal's own store and
 * nothing here touches Stash.
 *
 * The editor lives on the category's own page rather than in a modal. Editing
 * a grouping is looking at it and changing your mind about it, and a dialog
 * over the top of the wall hides the very thing you are deciding about.
 */

import { api, el } from '../util.js';
import { claim, failedIn, holds, loadingIn, onTeardown, plural, shell } from './core.js';
import { entityTile, shelfPage, tile } from './tiles.js';
import { SCENE_FACETS, SCENE_SORTS, orderScenes, shapeScene, shelfScenes } from './shelves.js';

const SECTION = '#/library/categories';

const href = (slug) => `#/library/category/${slug}`;

// A category's picture is one of its own scenes, through the portal's
// thumbnail like every other tile — so the setting that fills a missing cover
// reaches a category whose lead scene has none.
const art = (id) => (id ? `/media/scene/${id}/thumb` : null);

/*
 * Which picture a category actually shows, asked in one place so the tile, the
 * banner and the picker can never disagree about it.
 *
 * Artwork you uploaded wins. It is the only one of the three that somebody
 * chose on purpose and could not be reconstructed — a scene cover is a frame
 * of something still in the library, and the stand-in is whatever sorted
 * first. Nothing falls back to nothing: a category with neither has no picture
 * and says so by not drawing one.
 *
 * A filmography category's `cover` is not a Stash scene id — it may be a
 * StashDB picture you hold nothing of yet — so the server already hands back a
 * usable address in `coverImage` rather than something this needs to resolve.
 */
const coverOf = (cat) => cat.art || (cat.kind === 'filmography' ? cat.coverImage : art(cat.cover));

/* ================================================================== index */

function categoryTile(cat) {
  return entityTile({
    name: cat.name,
    image: coverOf(cat),
    shape: 'wide',
    href: href(cat.slug),
    // Two facts, and the second one only when it is true: a category that
    // fills itself behaves differently from one you keep by hand, and that is
    // worth knowing before you open it. A filmography category answers the
    // same question with how much of it you actually hold.
    meta: cat.kind === 'filmography'
      ? `${cat.held} of ${plural(cat.count, 'scene')} · directed by ${cat.director}`
      : [plural(cat.count, 'scene'), cat.ruled ? 'self-filling' : null].filter(Boolean).join(' · '),
  });
}

export async function showCategories() {
  const mine = claim();
  loadingIn(SECTION);

  try {
    const data = await api('/api/library/categories');
    if (!holds(mine)) return;

    shell(SECTION,
      el('div', { className: 'feedhead' },
        el('h2', {}, 'Categories'),
        el('span', { className: 'muted' },
          `${data.count} categor${data.count === 1 ? 'y' : 'ies'}`),
        // Making one is a Settings question now, but this is where you stand
        // when you notice you want another — so the way there is on the page.
        el('a', { className: 'link', href: '#/parameters/catalog' }, 'New category ›')
      ),
      data.categories.length
        ? el('div', { className: 'facets' }, data.categories.map(categoryTile))
        : el('div', { className: 'empty' },
            'No categories yet. Make one in ',
            el('a', { className: 'link', href: '#/parameters/catalog' }, 'Settings › Catalog'),
            ', then put scenes in it.')
    );
  } catch (err) {
    if (!holds(mine)) return;
    failedIn(SECTION, err);
  }
}

/* ============================================================ one category */

/*
 * The head of a category's page: its cover as a band, its name, what is in it
 * and why. The blurb is shown as written — it is a sentence you typed about
 * your own shelf, not scraped copy, so there is nothing to cut or clean up.
 */
function banner(cat, edit) {
  const cover = coverOf(cat);

  return el('header', { className: 'catbanner' + (cover ? '' : ' bare') },
    cover ? el('img', { className: 'catcover', src: cover, alt: '' }) : null,
    el('div', { className: 'catbannerbody' },
      el('h1', {}, cat.name),
      el('p', { className: 'muted' },
        [plural(cat.count, 'scene'),
         cat.ruled ? `${cat.picks} chosen by hand, the rest by rule` : 'all chosen by hand']
          .join(' · ')),
      cat.blurb ? el('p', { className: 'catblurb' }, cat.blurb) : null
    ),
    edit
  );
}

export async function showCategory(slug, query = '') {
  const mine = claim();
  loadingIn(SECTION);

  try {
    // The whole category in one answer rather than a page of it: the bar below
    // counts what it is offering, and it can only count what it holds.
    const data = await api(`/api/library/categories/${slug}?all=1`);
    if (!holds(mine)) return;
    draw(data, query);
  } catch (err) {
    if (!holds(mine)) return;
    failedIn(SECTION, err);
  }
}

// The filters live in the address, so a redraw after a write puts them back.
const filtersNow = () => location.hash.split('?')[1] || '';

/*
 * The same bar the Scenes shelf wears, asked of one category. A category is a
 * shelf — often a few hundred scenes — and the questions you ask of it are the
 * shelf's questions: whose is it, who is in it, what is it about, when, and
 * what order. So it is the same piece of furniture rather than a second one
 * that drifts, and its state lives in the address like the shelf's does.
 *
 * The category's own order leads the sort list, because that is what the page
 * is *for*: what you put there by hand first, in the order you put it, then
 * what the rule found. It has to be a sort of its own or opening the page
 * would quietly reorder it.
 */
function categoryShelf(cat, scenes, query) {
  const arranged = new Map(scenes.map((scene, i) => [scene, i]));

  const order = (items, sort) => (sort === 'arranged'
    ? [...items].sort((a, b) => arranged.get(a) - arranged.get(b))
    : orderScenes(items, sort));

  return shelfPage({
    section: href(cat.slug),
    title: cat.name,
    note: 'in this category',
    items: scenes,
    facets: SCENE_FACETS,
    sorts: [['arranged', 'As arranged'], ...SCENE_SORTS],
    order,
    card: tile,
    query,
  });
}

function draw(data, query = '') {
  const cat = data.category;

  if (cat.kind === 'filmography') { drawFilmography(data, query); return; }

  // Kind and the search haystack are worked out in the browser on the shelf
  // page too — the bar needs both and Stash has neither.
  const scenes = data.scenes.map(shapeScene);

  const [feedhead, bar, wall, more] = scenes.length
    ? categoryShelf(cat, scenes, query)
    : [];

  /*
   * The bar brings its own heading, and the banner above it is already the
   * category's name in letters three times the size. What is worth keeping is
   * the count beside it, which is the one thing that changes as you filter.
   */
  if (feedhead) feedhead.querySelector('h2')?.remove();

  const panel = el('div', { className: 'catedit', hidden: true });
  let built = false;

  const toggle = el('button', { className: 'act', type: 'button' }, 'Edit');
  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.classList.toggle('on', !panel.hidden);
    // Built on first open. The editor reads the whole shelf and the term
    // counts, and almost every visit to a category page is just looking.
    if (!panel.hidden && !built) {
      built = true;
      editor(panel, data);
    }
  };

  shell(SECTION,
    banner(cat, toggle),
    panel,
    feedhead || null,
    bar || null,
    wall || el('div', { className: 'empty' },
      'Nothing in this category yet. Open Edit and add some scenes, or give it a rule.'),
    more || null
  );
}

/* ==================================================== one filmography
 *
 * The other kind of category: a director's scenes, whether or not you hold
 * them. Not a scene, so not `tile()` — an entry here has no resolution, no
 * play state, sometimes no Stash id at all — but the same "picture with a
 * name under it" shape the studios and performers shelves already draw. See
 * categories.mjs's `kind: 'filmography'` for where the list comes from.
 */

const shapeFilm = (entry) => ({
  ...entry,
  haystack: [entry.title, entry.studioName, ...(entry.performers || []).map((p) => p.name)]
    .filter(Boolean).join(' ').toLowerCase(),
});

// Three states, not two: owned, seen and skipped on purpose (config.tracked's
// ignore list, the same "Skip" every decide queue writes to — see
// categories.mjs's decorateFilm), and never looked at. The middle one is not
// "missing" the way the third is; it is a decision you already made.
// "On its way" leads "Skipped": sending one to v3 is the later decision.
const onItsWay = (e) => e.v3 === 'monitored' || e.v3 === 'downloaded';
const heldState = (e) => (e.owned ? (e.probable ? 'In your library (title + date)' : 'In your library')
  : onItsWay(e) ? 'On its way (v3)'
  : e.skipped ? 'Skipped already'
  : 'Not in your library');

const FILM_FACETS = [
  { key: 'studio', any: 'Any studio', of: (e) => (e.studioName ? [e.studioName] : []) },
  { key: 'performer', any: 'Anyone', of: (e) => (e.performers || []).map((p) => p.name) },
  { key: 'year', any: 'Any year', of: (e) => (e.date ? [e.date.slice(0, 4)] : []) },
  { key: 'held', any: 'Owned, skipped or neither', of: (e) => [heldState(e)] },
];

const FILM_SORTS = [
  ['newest', 'Newest'],
  ['title', 'Title'],
  ['owned', 'In your library first'],
];

function orderFilms(items, sort) {
  const by = [...items];
  if (sort === 'title') return by.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'owned') {
    return by.sort((a, b) => Number(b.owned) - Number(a.owned) || String(b.date || '').localeCompare(String(a.date || '')));
  }
  return by.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

// Full colour for what is on the shelf, translucent for what is not — the
// same `faded` the missing rows of performers and studios already wear. An
// owned entry opens its scene page; an unowned one has none to open, so it
// goes to StashDB instead.
function filmTile(entry, v3on) {
  const node = entityTile({
    name: entry.title,
    image: entry.owned ? art(entry.sceneId) : entry.image,
    shape: 'wide',
    faded: !entry.owned,
    href: entry.owned ? `#/library/scene/${entry.sceneId}` : null,
    onPick: entry.owned ? null : () => window.open(entry.url, '_blank', 'noopener'),
    meta: [entry.studioName, entry.date, entry.owned ? null : heldState(entry)]
      .filter(Boolean).join(' · '),
  });

  node.classList.add('filmtile');
  if (!entry.owned && v3on) node.querySelector('.facetbody').append(sendButton(entry));
  return node;
}

/*
 * Send a missing one to Whisparr v3 — the same route as the Add button on
 * StashDB cards, keyed on the StashDB id every entry here already carries.
 * Like that button, sending also puts it on the want list: a scene fetched on
 * purpose should not still count as undecided under its studio.
 */
function sendButton(entry) {
  const sent = onItsWay(entry);
  const button = el('button', {
    className: 'add filmsend',
    type: 'button',
    disabled: sent,
  }, entry.v3 === 'downloaded' ? 'Downloaded in v3' : sent ? 'Monitored in v3' : 'Send to v3');
  button.title = sent ? 'Whisparr v3 already has this one.' : 'Send to Whisparr v3 and monitor it.';

  button.onclick = async (e) => {
    // The tile itself opens StashDB; the button is about v3, not that.
    e.stopPropagation();
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const result = await api(`/api/whisparr3/scenes/${entry.id}`, { method: 'POST' });
      entry.v3 = 'monitored';
      button.textContent = result.searched ? 'Sent, searching' : 'Monitored in v3';
      await api('/api/acquire/tracked/scenes', {
        method: 'POST',
        body: JSON.stringify({
          id: entry.id,
          title: entry.title,
          date: entry.date,
          image: entry.image,
          url: entry.url,
          studio: null,
          studioName: entry.studioName,
          performers: entry.performers,
          details: '',
        }),
      }).catch(() => {});
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Send to v3';
      button.title = err.message;
      alert(err.message);
    }
  };
  return button;
}

function filmographyShelf(cat, entries, query, v3on) {
  return shelfPage({
    section: href(cat.slug),
    title: cat.name,
    note: 'in this filmography',
    placeholder: 'Find a scene…',
    items: entries.map(shapeFilm),
    facets: FILM_FACETS,
    sorts: FILM_SORTS,
    order: orderFilms,
    card: (entry) => filmTile(entry, v3on),
    // entityTile draws a `.facet`, the same wide picture-with-a-name-under-it
    // the category index and the studio/performer shelves use — not `.tile`,
    // which is shaped around a scene's own duration and progress bar.
    wall: 'facets',
    query,
  });
}

function filmBanner(cat, edit) {
  const cover = coverOf(cat);

  return el('header', { className: 'catbanner' + (cover ? '' : ' bare') },
    cover ? el('img', { className: 'catcover', src: cover, alt: '' }) : null,
    el('div', { className: 'catbannerbody' },
      el('h1', {}, cat.name),
      el('p', { className: 'muted' }, `${cat.held} of ${plural(cat.count, 'scene')} · directed by ${cat.director}`),
      cat.blurb ? el('p', { className: 'catblurb' }, cat.blurb) : null
    ),
    edit
  );
}

function drawFilmography(data, query = '') {
  const cat = data.category;
  const entries = data.entries || [];

  const [feedhead, bar, wall, more] = entries.length
    ? filmographyShelf(cat, entries, query, Boolean(data.v3))
    : [];

  if (feedhead) feedhead.querySelector('h2')?.remove();

  const panel = el('div', { className: 'catedit', hidden: true });
  let built = false;

  const toggle = el('button', { className: 'act', type: 'button' }, 'Edit');
  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    toggle.classList.toggle('on', !panel.hidden);
    if (!panel.hidden && !built) {
      built = true;
      panel.replaceChildren(details(cat), filmArt(cat), filmSource(cat), filmPatch(cat, entries), danger(cat));
    }
  };

  shell(SECTION,
    filmBanner(cat, toggle),
    panel,
    feedhead || null,
    bar || null,
    wall || el('div', { className: 'empty' },
      'Nothing found yet. Open Edit and refresh from StashDB, or add one by hand.'),
    more || null
  );
}

/* ------------------------------------------------------- filmography editor
 *
 * Two boxes rather than the rule-based editor's four: there is no rule to
 * write and no hand order to keep, because a filmography sorts itself by
 * date. What is left is where the list comes from, and patching the two ways
 * an automated search gets it wrong — misses something, or finds the wrong
 * thing entirely.
 */

/*
 * The one banner picture, uploaded rather than chosen from a strip — the
 * rule-based cover box offers a strip of the category's own scenes because
 * those are yours to pick from; a filmography's entries are mostly not, so
 * there is nothing of its own worth offering and this is upload-or-nothing.
 * The route underneath (setArt/clearArt) is the same one the rule-based
 * cover uses, kind-agnostic on the server.
 */
function filmArt(cat) {
  const note = el('span', { className: 'muted' });
  const upload = el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif',
  });
  const send = el('button', { className: 'act', type: 'button' }, 'Use this picture');
  const drop = el('button', { className: 'act', type: 'button', hidden: !cat.art }, 'Remove the picture');

  send.onclick = async () => {
    const file = upload.files[0];
    if (!file) { note.textContent = 'Choose a picture first.'; return; }

    note.textContent = `Sending ${file.name}…`;
    send.disabled = true;
    drop.disabled = true;
    try {
      const res = await fetch(`/api/library/categories/${cat.slug}/art`, { method: 'POST', body: file });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || res.statusText);
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      send.disabled = false;
      drop.disabled = false;
    }
  };

  drop.onclick = async () => {
    note.textContent = 'Removing…';
    send.disabled = true;
    drop.disabled = true;
    try {
      await api(`/api/library/categories/${cat.slug}/art`, { method: 'DELETE' });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      send.disabled = false;
      drop.disabled = false;
    }
  };

  const shown = cat.art
    ? el('div', { className: 'catart' },
        el('img', { src: cat.art, alt: '' }),
        el('span', { className: 'muted small' },
          'Your own artwork, which leads the page and the tile. Remove it to lead with the newest scene you hold instead.'))
    : null;

  return box('Cover',
    'The picture at the top of this page and on its tile. Without one, it leads with the newest scene you hold, '
    + 'or StashDB’s own picture if you hold none of it yet.',
    shown,
    el('div', { className: 'toolbar' }, upload, send, drop, note));
}

function filmSource(cat) {
  const director = el('input', { className: 'filter', type: 'text', value: cat.director, ariaLabel: 'Director' });
  const note = el('span', { className: 'muted' },
    cat.manifestAt
      ? `Last asked StashDB ${new Date(cat.manifestAt).toLocaleString()}.`
      : 'Never asked StashDB yet.');
  const save = el('button', { className: 'act', type: 'button' }, 'Save name');
  const pull = el('button', { className: 'act', type: 'button' }, 'Refresh from StashDB');

  save.onclick = async () => {
    save.disabled = true;
    try {
      await api(`/api/library/categories/${cat.slug}`, {
        method: 'POST',
        body: JSON.stringify({ director: director.value }),
      });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      save.disabled = false;
    }
  };

  pull.onclick = async () => {
    pull.disabled = true;
    note.textContent = 'Asking StashDB…';
    try {
      await api(`/api/library/categories/${cat.slug}/refresh`, { method: 'POST' });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      pull.disabled = false;
    }
  };

  return box('Director',
    'StashDB has no search for who directed something, so this asks for the name as ordinary text and keeps only '
    + 'the scenes whose own director credit matches it exactly. A scene the search never surfaces has to be added '
    + 'below by hand.',
    director,
    el('div', { className: 'toolbar' }, save, pull, note));
}

function filmPatch(cat, entries) {
  const link = el('input', {
    className: 'filter',
    type: 'text',
    placeholder: 'A StashDB scene link, when the search above misses one…',
    autocomplete: 'off',
    spellcheck: false,
    ariaLabel: 'A StashDB scene link to add by hand',
  });
  const add = el('button', { className: 'act', type: 'button' }, 'Add');
  const note = el('span', { className: 'muted' });

  const send = async () => {
    if (!link.value.trim()) { link.focus(); return; }
    add.disabled = true;
    note.textContent = '';
    try {
      await api(`/api/library/categories/${cat.slug}/scenes`, {
        method: 'POST',
        body: JSON.stringify({ add: [link.value.trim()] }),
      });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      add.disabled = false;
    }
  };
  add.onclick = send;
  link.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };

  const list = el('div', { className: 'catfinds' },
    entries.map((entry) => {
      const drop = el('button', { className: 'act', type: 'button' }, 'Drop');
      drop.onclick = async () => {
        drop.disabled = true;
        try {
          await api(`/api/library/categories/${cat.slug}/scenes`, {
            method: 'POST',
            body: JSON.stringify({ remove: [entry.id] }),
          });
          await refresh(cat.slug);
        } catch (err) {
          note.textContent = err.message;
          drop.disabled = false;
        }
      };

      return el('div', { className: 'catfind' },
        el('img', { src: entry.owned ? art(entry.sceneId) : entry.image, loading: 'lazy', alt: '' }),
        el('div', { className: 'catfindbody' },
          el('div', { className: 'title' }, entry.title),
          el('div', { className: 'meta' },
            [entry.studioName, entry.date, heldState(entry)].filter(Boolean).join(' · '))
        ),
        drop
      );
    })
  );

  return box('Add or drop a scene',
    'Dropping one here is remembered, so the next refresh from StashDB cannot bring it straight back.',
    el('div', { className: 'toolbar' }, link, add, note),
    entries.length ? list : el('p', { className: 'note' }, 'Nothing in this filmography yet.'));
}

// Redrawing after a write. The server hands back the whole category, so there
// is nothing to reconcile in the browser — the page is rebuilt from the answer
// and the editor reopens where it was.
async function refresh(slug) {
  const mine = claim();
  try {
    const data = await api(`/api/library/categories/${slug}?all=1`);
    if (!holds(mine)) return;
    draw(data, filtersNow());
    const toggle = document.querySelector('.catbanner .act');
    if (toggle) toggle.click();
  } catch (err) {
    if (holds(mine)) failedIn(SECTION, err);
  }
}

/* ================================================================= editor */

const box = (title, note, ...body) =>
  el('section', { className: 'catbox' },
    el('h3', {}, title),
    note ? el('p', { className: 'muted small' }, note) : null,
    ...body
  );

async function editor(panel, data) {
  const cat = data.category;
  panel.replaceChildren(el('div', { className: 'empty' }, 'Loading…'));

  let terms = { tags: [], studios: [], performers: [] };
  let shelf = [];
  try {
    [terms, shelf] = await Promise.all([api('/api/library/categories/terms'), shelfScenes()]);
  } catch {
    // The editor still works without them; only the suggestions and the
    // scene picker go quiet, and both say so where they would have been.
  }

  panel.replaceChildren(
    details(cat),
    coverBox(cat, data),
    ruleBox(cat, terms),
    picker(cat, shelf),
    order(cat, data),
    danger(cat)
  );
}

/* ---------------------------------------------------------------- details */

function details(cat) {
  const name = el('input', { className: 'filter', type: 'text', value: cat.name, ariaLabel: 'Name' });
  const blurb = el('textarea', {
    className: 'filter',
    rows: 3,
    value: cat.blurb,
    placeholder: 'What this category is, in a sentence.',
    ariaLabel: 'Description',
  });

  const note = el('span', { className: 'muted' });
  const save = el('button', { className: 'act', type: 'button' }, 'Save');

  save.onclick = async () => {
    save.disabled = true;
    note.textContent = '';
    try {
      await api(`/api/library/categories/${cat.slug}`, {
        method: 'POST',
        body: JSON.stringify({ name: name.value, blurb: blurb.value }),
      });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      save.disabled = false;
    }
  };

  return box('Name and description',
    `The address stays /${cat.slug} whatever you rename it to, so a link you already sent yourself keeps working.`,
    name, blurb, el('div', { className: 'toolbar' }, save, note));
}

/* ----------------------------------------------------------------- cover
 *
 * What a category leads with.
 *
 * The field has been in the store since the beginning and the server has
 * always accepted it; nothing ever wrote it. So every category showed the
 * frame of whichever scene happened to sort first, which on a self-filling one
 * changes the day a new scene lands — the picture at the top of the page moved
 * on its own and there was no way to hold it still.
 *
 * Either your own picture or one of its scenes, and yours wins where there is
 * one. A category is an argument about a set of scenes and usually the picture
 * that makes the argument is one of them — but not always, and the ones where
 * it is not are exactly the ones worth hanging something of your own on.
 *
 * Clearing is safe either way. Remove the artwork and the chosen scene comes
 * back; unchoose the scene and the first member stands in. A category always
 * shows something, so nothing here can leave it blank.
 *
 * **Only what is on this page.** The category page is paged at sixty and the
 * editor is handed that page, not the whole membership. Reading the rest to
 * offer them as covers would be a second pass over the shelf for a picture,
 * and page one is picks first then newest — which is where the cover you want
 * almost always is. It says how many it is showing rather than pretending the
 * grid is everything.
 */
function coverBox(cat, data) {
  const scenes = data.scenes || [];
  const note = el('span', { className: 'muted' });

  const strip = el('div', { className: 'catshots' });
  const upload = el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif',
  });

  const send = el('button', { className: 'act', type: 'button' }, 'Use this picture');
  const drop = el('button', { className: 'act', type: 'button', hidden: !cat.art }, 'Remove the picture');

  const busy = (on) => {
    send.disabled = on;
    drop.disabled = on;
    for (const shot of strip.children) shot.disabled = on;
  };

  const write = async (id) => {
    note.textContent = 'Saving…';
    busy(true);
    try {
      await api(`/api/library/categories/${cat.slug}`, {
        method: 'POST',
        body: JSON.stringify({ cover: id }),
      });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      busy(false);
    }
  };

  /*
   * The upload, which is the one request on this page that is not JSON: the
   * body is the picture. Not api() for that reason — that stamps a JSON
   * content type on anything with a body. Same shape as the gallery uploader.
   */
  send.onclick = async () => {
    const file = upload.files[0];
    if (!file) { note.textContent = 'Choose a picture first.'; return; }

    note.textContent = `Sending ${file.name}…`;
    busy(true);
    try {
      const res = await fetch(`/api/library/categories/${cat.slug}/art`, { method: 'POST', body: file });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || res.statusText);
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      busy(false);
    }
  };

  drop.onclick = async () => {
    note.textContent = 'Removing…';
    busy(true);
    try {
      await api(`/api/library/categories/${cat.slug}/art`, { method: 'DELETE' });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      busy(false);
    }
  };

  /*
   * The scenes, as a strip. Disabled while there is artwork rather than hidden:
   * a control that vanishes teaches you nothing about why, and the sentence
   * under the box says what to press to get them back.
   *
   * `cat.cover` is what the server resolved rather than what is stored — a
   * cover naming a scene that has since left the category comes back as the
   * stand-in — so the tick is always on a picture you can see.
   */
  const chosen = String(cat.cover || '');

  strip.append(...scenes.map((scene) => {
    const on = !cat.art && String(scene.id) === chosen;
    const shot = el('button', {
      className: 'catshot' + (on ? ' on' : ''),
      type: 'button',
      disabled: Boolean(cat.art),
      title: on ? `${scene.title} — leading the page` : `Lead with ${scene.title}`,
      ariaPressed: String(on),
    },
      el('img', { src: art(scene.id), loading: 'lazy', alt: '' }),
      el('span', { className: 'catshotname' }, scene.title)
    );

    shot.onclick = () => { if (!on) write(scene.id); };
    return shot;
  }));

  // Back to the stand-in. Not "no cover" — a category always shows something,
  // and this is the difference between a picture you chose and one you did not.
  const auto = el('button', {
    className: 'act',
    type: 'button',
    hidden: Boolean(cat.art) || !scenes.length,
  }, 'Let it choose');
  auto.onclick = () => write(null);

  const shown = cat.art
    ? el('div', { className: 'catart' },
        el('img', { src: cat.art, alt: '' }),
        el('span', { className: 'muted small' },
          'Your own artwork, which leads the page and the tile. Remove it to lead with one of its scenes instead.'))
    : null;

  return box('Cover',
    'The picture at the top of this page and on its tile. Upload your own, or lead with one of its scenes.',
    shown,
    scenes.length
      ? strip
      : el('p', { className: 'note' }, 'No scenes in this category yet, so there is nothing of its own to lead with.'),
    el('div', { className: 'toolbar' }, upload, send, drop, auto, note,
      !cat.art && scenes.length && scenes.length < data.count
        ? el('span', { className: 'muted small' },
            `Showing the first ${scenes.length} of ${data.count} in it.`)
        : null)
  );
}

/* ------------------------------------------------------------------- rule
 *
 * A rule is a stack of lines, and each line is one condition.
 *
 * It used to be three comma-separated boxes and a word — tags, studios,
 * performers, all OR-ed, with an "any / all" that quietly applied to the tags
 * only. Everything it could express, it expressed in one shape, and the one
 * joining word on screen did not join the things either side of it. So you
 * could not say "these tags but not that studio", and you could not tell what
 * the word you could see was doing.
 *
 * Now: add a line, choose what it looks at, choose how, type the words. Every
 * line after the first carries the word that joins it to everything above it,
 * and any line can be thrown away without touching the rest.
 *
 * **Read top to bottom, with no precedence.** Each line joins to the result of
 * the lines above it rather than to the one directly above, which is what the
 * stack of rows looks like and is said on the page in as many words. See
 * categories.mjs for why.
 *
 * Comma-separated values rather than a tag-picker widget because you already
 * know what you mean and typing it is faster than hunting a dropdown of four
 * hundred — the datalist on each field offers the ones you actually hold, with
 * counts, for when you do not.
 */

const split = (value) => value.split(',').map((v) => v.trim()).filter(Boolean);
const joined = (list) => (list || []).join(', ');

function suggestions(id, items) {
  return el('datalist', { id },
    items.slice(0, 400).map((t) => el('option', { value: t.name }, `${t.count}`)));
}

const FIELDS = [
  ['tags', 'Tags'],
  ['studios', 'Studios'],
  ['performers', 'Performers'],
  ['title', 'Title'],
];

// Three fields have a list of what you actually hold to offer. Title does not
// — there is no shortlist of titles worth putting in a dropdown, and the whole
// point of searching one is that you are typing a word rather than picking a
// name.
const SUGGESTED = new Set(['tags', 'studios', 'performers']);

// "none of" is the reason a second line is worth having: the commonest thing
// you want to say about a shelf is "this, except that".
const OPS = [['any', 'any of'], ['all', 'all of'], ['none', 'none of']];

const suggest = (input, field) => {
  if (SUGGESTED.has(field)) input.setAttribute('list', `cat-${field}`);
  else input.removeAttribute('list');
};

const picked = (options, value) => {
  const select = el('select', { className: 'shelfpick' },
    options.map(([v, label]) => el('option', { value: v }, label)));
  select.value = value;
  return select;
};

function ruleBox(cat, terms) {
  const rows = el('div', { className: 'catrules' });
  const add = el('button', { className: 'act', type: 'button' }, 'Add a line');

  const count = el('span', { className: 'muted' });
  const note = el('span', { className: 'muted' });
  const save = el('button', { className: 'act', type: 'button' }, 'Save rule');
  const clear = el('button', { className: 'act', type: 'button' }, 'No rule');

  const current = () => ({ clauses: [...rows.children].map((row) => row.read()) });

  /*
   * What the rule would catch, shown as you type. A rule you cannot see the
   * result of is a rule you will get wrong — and it costs nothing, because the
   * server answers it off the same cached shelf read the page came from.
   */
  let typing = null;
  const look = async () => {
    const rule = current();
    if (!rule.clauses.some((c) => c.values.length)) {
      count.textContent = 'No rule — this category holds only what you put in it.';
      return;
    }
    count.textContent = 'Counting…';
    try {
      const seen = await api('/api/library/categories/preview', {
        method: 'POST',
        body: JSON.stringify({ rule }),
      });
      count.textContent = `Catches ${plural(seen.count, 'scene')} on the shelf right now.`;
    } catch (err) {
      count.textContent = err.message;
    }
  };

  const settle = () => {
    clearTimeout(typing);
    typing = setTimeout(look, 250);
  };
  onTeardown(() => clearTimeout(typing));

  /*
   * The first line has nothing to join to, so it says "Where" instead of
   * offering a word that would do nothing. Which line is first can change
   * under you — delete the top one and the second becomes it — so the whole
   * stack is re-labelled after every add and every removal rather than each
   * row deciding once at birth.
   */
  const relabel = () => {
    for (const [i, row] of [...rows.children].entries()) row.lead(i === 0);
  };

  function line(clause) {
    const join = picked([['and', 'and'], ['or', 'or']], clause.join || 'and');
    const first = el('span', { className: 'catlead' }, 'Where');
    const field = picked(FIELDS, clause.field || 'tags');
    const op = picked(OPS, clause.op || 'any');

    const values = el('input', {
      className: 'filter',
      type: 'text',
      value: joined(clause.values),
      autocomplete: 'off',
      spellcheck: false,
      ariaLabel: 'Words to match, separated by commas',
      placeholder: 'comma, separated, words',
    });
    suggest(values, field.value);

    const drop = el('button', {
      className: 'act',
      type: 'button',
      title: 'Take this line out',
      ariaLabel: 'Take this line out',
    }, '×');

    // The word and the "Where" label share one slot, so hiding either does not
    // move the columns the rest of the stack lines up against.
    const lead = el('div', { className: 'catjoin' }, join, first);
    const row = el('div', { className: 'catruleline' }, lead, field, op, values, drop);

    // The suggestions follow the field, so switching a line from tags to
    // performers offers performers rather than the tags you were halfway
    // through typing.
    field.onchange = () => { suggest(values, field.value); look(); };
    op.onchange = look;
    join.onchange = look;
    values.oninput = settle;

    drop.onclick = () => {
      row.remove();
      // A rule with no lines at all is a box you cannot type in, so the last
      // one leaves an empty line behind rather than nothing.
      if (!rows.children.length) rows.append(line({}));
      relabel();
      look();
    };

    row.read = () => ({
      field: field.value,
      op: op.value,
      values: split(values.value),
      join: join.value,
    });

    // Whether this row is the top one, which is the only row with no word in
    // front of it.
    row.lead = (isFirst) => {
      join.hidden = isFirst;
      first.hidden = !isFirst;
    };

    return row;
  }

  const append = (clause) => {
    rows.append(line(clause));
    relabel();
  };

  for (const clause of cat.rule.clauses.length ? cat.rule.clauses : [{}]) append(clause);

  add.onclick = () => {
    append({});
    // Straight into the box you are about to type in.
    rows.lastElementChild.querySelector('input').focus();
  };

  look();

  const write = async (rule) => {
    save.disabled = true;
    clear.disabled = true;
    note.textContent = '';
    try {
      await api(`/api/library/categories/${cat.slug}`, {
        method: 'POST',
        body: JSON.stringify({ rule }),
      });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
      save.disabled = false;
      clear.disabled = false;
    }
  };

  save.onclick = () => write(current());
  clear.onclick = () => write({ clauses: [] });

  return box('Rule',
    'Scenes that match land in this category on their own, and keep landing as new ones arrive. '
    + 'Lines are read top to bottom — each one joins to the result of the ones above it, so "a or b and c" '
    + 'means "(a or b) and c". Anything you throw out below stays out; the rule cannot put it back.',
    rows,
    el('div', { className: 'toolbar' }, add),
    suggestions('cat-tags', terms.tags),
    suggestions('cat-studios', terms.studios),
    suggestions('cat-performers', terms.performers),
    el('div', { className: 'toolbar' }, save, clear, count, note));
}


/* ----------------------------------------------------------------- picker
 *
 * Adding scenes by hand. Searches the same one read of the shelf the Scenes
 * page filters, so it offers the whole library and not a page of it, and shows
 * ten at a time — this is "find the one I mean", not a second shelf.
 */

function picker(cat, shelf) {
  const search = el('input', {
    className: 'filter',
    type: 'search',
    placeholder: shelf.length ? 'Find a scene to add…' : 'The shelf could not be read',
    autocomplete: 'off',
    spellcheck: false,
    disabled: !shelf.length,
    ariaLabel: 'Find a scene to add',
  });

  const results = el('div', { className: 'catfinds' });
  const note = el('span', { className: 'muted' });

  const add = async (id) => {
    note.textContent = '';
    try {
      await api(`/api/library/categories/${cat.slug}/scenes`, {
        method: 'POST',
        body: JSON.stringify({ add: [id] }),
      });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
    }
  };

  const row = (scene) => {
    const button = el('button', { className: 'act', type: 'button' }, 'Add');
    button.onclick = () => { button.disabled = true; add(String(scene.id)); };

    return el('div', { className: 'catfind' },
      el('img', { src: art(scene.id), loading: 'lazy', alt: '' }),
      el('div', { className: 'catfindbody' },
        el('div', { className: 'title' }, scene.title),
        el('div', { className: 'meta' },
          [scene.studio?.name, scene.date].filter(Boolean).join(' · '))
      ),
      button
    );
  };

  let typing = null;
  search.oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      const term = search.value.trim().toLowerCase();
      if (term.length < 2) { results.replaceChildren(); return; }
      const hits = shelf.filter((s) => s.haystack.includes(term)).slice(0, 10);
      results.replaceChildren(...(hits.length
        ? hits.map(row)
        : [el('div', { className: 'empty' }, 'Nothing on the shelf by that name.')]));
    }, 150);
  };
  onTeardown(() => clearTimeout(typing));

  return box('Add scenes',
    'Anything you add here stays put whatever the rule does.',
    search, results, note);
}

/* ------------------------------------------------------------ hand order
 *
 * The scenes you chose, in the order they lead the page — and the cover. Only
 * these are movable: the rule's haul is ordered by when it arrived, and a
 * manual position for a scene that may stop matching tomorrow has nowhere to
 * live.
 *
 * Up and down rather than dragging. The same list is used on the iPad, where a
 * drag inside a scrolling page is a fight.
 */

function order(cat, data) {
  /*
   * Only what is on the first page can be listed, because that is where the
   * titles and the stills came from. Picks lead the page, so this is all of
   * them right up to sixty — and past that the back of the list is not
   * reachable here. Saving a short list is still safe: the server keeps
   * anything it was not told about at the back, which is where it already was.
   */
  const byId = new Map(data.scenes.map((s) => [String(s.id), s]));
  const picked = data.picked.filter((id) => byId.has(id));

  const note = el('span', { className: 'muted' });
  const list = el('div', { className: 'catpicks' });

  // The order lives here until you save it, so a run of nudges is one write
  // rather than one per press.
  let ids = [...picked];

  const write = async (path, body) => {
    note.textContent = '';
    try {
      await api(`/api/library/categories/${cat.slug}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await refresh(cat.slug);
    } catch (err) {
      note.textContent = err.message;
    }
  };

  const paint = () => {
    list.replaceChildren(...ids.map((id, at) => {
      const scene = byId.get(id);

      const up = el('button', { className: 'act', type: 'button', title: 'Move up', disabled: at === 0 }, '↑');
      const down = el('button', { className: 'act', type: 'button', title: 'Move down', disabled: at === ids.length - 1 }, '↓');
      const drop = el('button', { className: 'act', type: 'button', title: 'Take out of this category' }, 'Remove');
      const lead = el('button', {
        className: 'act' + (String(cat.cover) === id ? ' on' : ''),
        type: 'button',
        title: 'Use as the cover',
      }, 'Cover');

      const swap = (a, b) => { [ids[a], ids[b]] = [ids[b], ids[a]]; paint(); };
      up.onclick = () => swap(at, at - 1);
      down.onclick = () => swap(at, at + 1);
      drop.onclick = () => write('scenes', { remove: [id] });
      lead.onclick = async () => {
        try {
          await api(`/api/library/categories/${cat.slug}`, {
            method: 'POST',
            body: JSON.stringify({ cover: id }),
          });
          await refresh(cat.slug);
        } catch (err) {
          note.textContent = err.message;
        }
      };

      return el('div', { className: 'catfind' },
        el('img', { src: art(id), loading: 'lazy', alt: '' }),
        el('div', { className: 'catfindbody' },
          el('div', { className: 'title' }, scene.title),
          el('div', { className: 'meta' },
            [scene.studio?.name, scene.date].filter(Boolean).join(' · '))
        ),
        el('div', { className: 'catacts' }, up, down, lead, drop)
      );
    }));
  };

  const save = el('button', { className: 'act', type: 'button' }, 'Save order');
  save.onclick = () => write('order', { ids });

  paint();

  if (!picked.length) {
    return box('Chosen by hand',
      'Nothing yet — everything here came in by rule. Add a scene above and it will lead the page.',
      note);
  }

  return box('Chosen by hand',
    'These lead the page, in this order. Everything the rule found follows, newest first.',
    list, el('div', { className: 'toolbar' }, save, note));
}

/* ---------------------------------------------------------------- deleting
 *
 * Two presses, because there is nothing to undo it with: the store is the only
 * record a category ever had. The scenes themselves are untouched — a category
 * is a list, and deleting the list is not deleting anything in it.
 */

function danger(cat) {
  const note = el('span', { className: 'muted' });
  const button = el('button', { className: 'act', type: 'button' }, 'Delete this category');
  let armed = false;

  button.onclick = async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Delete — press again';
      button.classList.add('on');
      setTimeout(() => {
        if (!armed) return;
        armed = false;
        button.textContent = 'Delete this category';
        button.classList.remove('on');
      }, 4000);
      return;
    }

    button.disabled = true;
    try {
      await api(`/api/library/categories/${cat.slug}`, { method: 'DELETE' });
      location.hash = SECTION;
    } catch (err) {
      note.textContent = err.message;
      button.disabled = false;
    }
  };

  return box('Delete',
    'Only the grouping goes. Every scene in it stays exactly where it is.',
    el('div', { className: 'toolbar' }, button, note));
}

/* ============================================= the picker on a scene page
 *
 * The other half of assigning. The moment you are most likely to notice a
 * scene belongs somewhere is while you are watching it, and walking back to
 * the category to add it by name is how that thought gets lost.
 */

export function scenePicker(sceneId) {
  const holder = el('div', { className: 'catpicker' });

  api(`/api/library/scenes/${sceneId}/categories`).then((data) => {
    // Nothing to offer yet. Said out loud rather than left blank, because an
    // empty card reads as a thing that is broken.
    if (!data.categories.length) {
      const link = el('a', { className: 'chip', href: '#/library/categories' }, 'Make one');
      holder.replaceChildren(el('span', { className: 'muted small' }, 'No categories yet.'), link);
      return;
    }

    const inside = new Set(data.in);

    holder.replaceChildren(
      el('span', { className: 'muted small' }, 'Categories'),
      ...data.categories.map((cat) => {
        const on = inside.has(cat.slug);
        const chip = el('button', {
          className: 'chip' + (on ? ' on' : ''),
          type: 'button',
          title: on ? 'Take out of this category' : 'Put in this category',
        }, cat.name);

        chip.onclick = async () => {
          chip.disabled = true;
          const going = chip.classList.contains('on');
          try {
            await api(`/api/library/categories/${cat.slug}/scenes`, {
              method: 'POST',
              body: JSON.stringify(going ? { remove: [sceneId] } : { add: [sceneId] }),
            });
            chip.classList.toggle('on', !going);
          } catch {
            // Left as it was: a chip that flipped and then did not write is a
            // worse lie than one that did nothing.
          }
          chip.disabled = false;
        };

        return chip;
      })
    );
  }).catch(() => {});

  return holder;
}
