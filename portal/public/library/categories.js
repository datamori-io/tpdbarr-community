/*
 * Categories: the index, one category's page, and its editor. Portal-owned
 * (see src/categories.mjs); nothing here touches Stash. The editor sits on
 * the category's page, not in a modal.
 */

import { api, el } from '../util.js';
import { claim, failedIn, holds, loadingIn, onTeardown, plural, shell } from './core.js';
import { entityTile, shelfPage, tile } from './tiles.js';
import { SCENE_FACETS, SCENE_SORTS, orderScenes, shapeScene, shelfScenes } from './shelves.js';

const SECTION = '#/library/categories';

const href = (slug) => `#/library/category/${slug}`;

// A scene's picture through the portal's thumbnail route.
const art = (id) => (id ? `/media/scene/${id}/thumb` : null);

/*
 * The picture a category shows, in one place. Uploaded art wins, then the
 * chosen scene, then the first. Filmography categories get `coverImage`
 * from the server.
 */
const coverOf = (cat) => cat.art || (cat.kind === 'filmography' ? cat.coverImage : art(cat.cover));

/* ================================================================== index */

function categoryTile(cat) {
  return entityTile({
    name: cat.name,
    image: coverOf(cat),
    shape: 'wide',
    href: href(cat.slug),
    // Whether it fills itself; for filmography, how much you hold.
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

/* The category's banner: cover, name, count and blurb as written. */
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
 * The Scenes shelf's filter bar over one category, state in the address.
 * The category's own order leads the sort list.
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

  /* Drop the bar's heading (the banner has the name); keep the count. */
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

/*
 * ==================================================== one filmography
 *
 * A director's scenes, owned or not, drawn as picture-and-name tiles.
 * See categories.mjs `kind: 'filmography'`.
 */

const shapeFilm = (entry) => ({
  ...entry,
  haystack: [entry.title, entry.studioName, ...(entry.performers || []).map((p) => p.name)]
    .filter(Boolean).join(' ').toLowerCase(),
});

// Owned, skipped (the decide queue's ignore list), or never looked at.
// "On its way" beats "Skipped".
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

// Owned in full colour and opens the scene; missing is faded and opens StashDB.
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

/* Send to Whisparr v3, like StashDB cards' Add; also adds it to the want list. */
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
    // entityTile draws a `.facet`, not a scene `.tile`.
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

/*
 * ------------------------------------------------------- filmography editor
 *
 * Where the list comes from, plus hand fixes for what the search missed or
 * got wrong.
 */

/* Upload-only banner picture, using the same setArt/clearArt route. */
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

// Rebuild from the server's answer after a write; reopen the editor.
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

/*
 * ----------------------------------------------------------------- cover
 *
 * Your own picture, or one of the category's scenes; yours wins. Clearing
 * either falls back, never to blank. Only scenes on this page (the first
 * sixty) are offered.
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

  /* The upload sends the picture as the body, so not api() (which sets a JSON type). */
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
   * Scene strip, disabled while there's artwork. `cat.cover` is the
   * server-resolved cover.
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

/*
 * ------------------------------------------------------------------- rule
 *
 * A stack of lines, one condition each; lines after the first say how they
 * join. Read top to bottom, no precedence (see categories.mjs). Values are
 * comma-separated; datalists offer what you hold.
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

// Suggestions for tags, studios and performers; none for title.
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

  /* Live preview of what the rule catches, off the cached shelf. */
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

  /* The first line says "Where". Relabelled after every add or removal. */
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

    // Suggestions follow the field.
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


/*
 * ----------------------------------------------------------------- picker
 *
 * Add scenes by hand, searching the whole shelf, ten at a time.
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

/*
 * ------------------------------------------------------------ hand order
 *
 * Reorder picks with up/down (drag is awkward on the iPad). Rule matches
 * keep arrival order.
 */

function order(cat, data) {
  /* Only first-page picks can be listed. The server keeps unlisted ones at the back. */
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

/*
 * ---------------------------------------------------------------- deleting
 *
 * Two presses: there's no undo. The scenes are untouched.
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

/*
 * ============================================= the picker on a scene page
 *
 * Add the scene you're watching to a category.
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
