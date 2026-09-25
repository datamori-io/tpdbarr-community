/* Catalog: make a category. A name is enough; the rest is set on its page. */

import { api, el } from '../util.js';
import { shell } from './core.js';

export const SECTION = '#/parameters/catalog';

const href = (slug) => `#/library/category/${slug}`;

export async function showCatalogSettings(paint) {
  shell(paint, SECTION, 'Catalog', 'the shelf as you would arrange it', maker(), el('div', { className: 'empty' }, 'Loading…'));

  let data = { categories: [], count: 0 };
  try {
    data = await api('/api/library/categories');
  } catch (err) {
    shell(paint, SECTION, 'Catalog', 'the shelf as you would arrange it', maker(),
      el('div', { className: 'empty' }, err.message));
    return;
  }

  shell(paint, SECTION, 'Catalog', 'the shelf as you would arrange it', maker(), existing(data));
}

function maker() {
  const name = el('input', {
    className: 'filter',
    type: 'text',
    placeholder: 'New category…',
    autocomplete: 'off',
    spellcheck: false,
    ariaLabel: 'Name for a new category',
  });

  // Filled in, this makes a different kind of category entirely — see the
  // note below. Left blank, it is exactly the form this always was.
  const director = el('input', {
    className: 'filter',
    type: 'text',
    placeholder: 'Director (optional)…',
    autocomplete: 'off',
    spellcheck: false,
    ariaLabel: 'Director, for a StashDB filmography category instead',
  });

  const note = el('span', { className: 'muted' });
  const make = el('button', { className: 'act', type: 'button' }, 'Create');

  const send = async () => {
    if (!name.value.trim() && !director.value.trim()) { name.focus(); return; }
    make.disabled = true;
    note.textContent = '';
    try {
      const body = director.value.trim()
        ? { kind: 'filmography', name: name.value, director: director.value }
        : { name: name.value };
      const made = await api('/api/library/categories', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Straight into the new one: the next thing you want is always to put
      // something in it.
      location.hash = href(made.category.slug);
    } catch (err) {
      note.textContent = err.message;
      make.disabled = false;
    }
  };

  make.onclick = send;
  name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
  director.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };

  return el('fieldset', {},
    el('legend', {}, 'New category ', el('span', { className: 'muted' }, 'a name is all it takes')),
    el('p', { className: 'note' },
      'A category is portal-owned — a name, a blurb, a cover, the scenes you put in by hand and a rule that keeps '
      + 'finding more. Nothing here is ever written into Stash.'),
    el('p', { className: 'note' },
      'Name a director instead and you get a different kind: everything StashDB says they directed, in colour '
      + 'where you hold it and faded where you do not, rather than a rule over your own shelf.'),
    el('div', { className: 'shelfbar' }, name, director, make, note)
  );
}

// What there already is, as a way in rather than a second shelf — the wall of
// them is Library › Categories, and that is one click away in the strip.
function existing({ categories, count }) {
  return el('fieldset', {},
    el('legend', {}, 'What there is ',
      el('span', { className: 'muted' }, `${count} categor${count === 1 ? 'y' : 'ies'}`)),
    count
      ? el('div', { className: 'catpicker' },
          categories.map((cat) => el('a', { className: 'chip', href: href(cat.slug) },
            cat.name,
            el('span', { className: 'muted' }, ` ${cat.count}`))))
      : el('p', { className: 'note' }, 'None yet. Name one above and it opens on its own page.'),
    el('p', { className: 'note' },
      el('a', { className: 'link', href: '#/library/categories' }, 'The wall of them →'))
  );
}
