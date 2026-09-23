/* Photo sets for a performer, and the places worth looking. */

import { api, el } from '../util.js';
import { SECTION_OF, paint, painterFor, show } from './core.js';

/* ================================================================== images
 *
 * Photo sets for a performer.
 *
 * The gallery builder already knows how to read one of these pages; what it
 * never had was a way to find them. This is that — a performer picked from
 * StashDB, then the places to look, with the build that already existed picking
 * up from there.
 */

export async function showImages(qs) {
  const paint = painterFor();
  const params = new URLSearchParams(qs || '');
  const name = params.get('name') || '';

  const body = el('div', {});
  show(paint, SECTION_OF.images, imagePanel(params), body);

  if (!name) {
    body.replaceChildren(el('div', { className: 'empty' },
      'Pick a performer above. Their name becomes a set of gallery pages to look through.'));
    return;
  }

  body.replaceChildren(el('div', { className: 'empty' }, 'Working out where to look…'));

  try {
    renderPlaces(body, await api('/api/import/images/places?name=' + encodeURIComponent(name)), params);
  } catch (err) {
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

function imagePanel(params) {
  const input = el('input', {
    type: 'text',
    className: 'bigsearch',
    placeholder: 'A performer — picked from StashDB, so the name is spelled their way',
    value: params.get('name') || '',
    autocomplete: 'off',
    spellcheck: false,
  });

  const menu = el('div', { className: 'facetmenu' });
  const wrap = el('div', { className: 'facet grow' }, input, menu);

  let timer = null;
  let run = 0;

  const close = () => { menu.replaceChildren(); wrap.classList.remove('open'); };

  const choose = (hit) => {
    close();
    const next = new URLSearchParams();
    next.set('name', hit.name);
    if (hit.id) next.set('performer', hit.id);
    location.hash = '#/import/images?' + next.toString();
  };

  const look = async () => {
    const term = input.value.trim();
    if (term.length < 2) return close();

    const mine = ++run;
    try {
      const { results } = await api('/api/import/images/performers?q=' + encodeURIComponent(term));
      if (mine !== run) return;

      menu.replaceChildren(...(results.length
        ? results.map((hit) => {
          const row = el('button', { type: 'button', className: 'facetrow' },
            hit.image ? el('img', { src: hit.image, loading: 'lazy', alt: '' }) : el('span', { className: 'facedot' }),
            el('span', { className: 'facename' }, hit.name),
            hit.detail ? el('span', { className: 'muted small' }, hit.detail) : null
          );
          row.onclick = () => choose(hit);
          return row;
        })
        : [el('div', { className: 'facetnone' }, 'Nobody on StashDB by that name.')]));
      wrap.classList.add('open');
    } catch (err) {
      menu.replaceChildren(el('div', { className: 'facetnone' }, err.message));
      wrap.classList.add('open');
    }
  };

  input.oninput = () => { clearTimeout(timer); timer = setTimeout(look, 250); };
  input.onblur = () => setTimeout(close, 150);
  input.onkeydown = (e) => { if (e.key === 'Escape') close(); };

  return el('section', { className: 'searchpanel' }, el('div', { className: 'searchline' }, wrap));
}

/*
 * Where to look, and then what is there.
 *
 * Three steps, in this order, because skipping the middle one is what made this
 * page appear to do nothing: a performer's page on these sites is a *list* of
 * galleries, and handing that straight to the picture scraper gets you site
 * chrome. So: the sites, then the galleries on one of them, then the pictures
 * in one of those.
 *
 * Nothing is fetched until you ask for it, which is also what keeps the rule
 * the gallery builder has always kept — only a URL the portal itself offered is
 * ever fetched, and every address here is one it offered.
 */
function renderPlaces(body, places, params) {
  const uuid = params.get('performer');
  const stage = el('div', {});

  const cards = places.sites.map((site) => {
    const target = site.performer || site.search;

    const open = el('a', { className: 'chip', href: target, target: '_blank', rel: 'noreferrer' }, 'Open');

    const look = el('button', { className: 'add', type: 'button' }, 'Find galleries');
    look.title = 'Read this page for the galleries on it.';
    look.onclick = async () => {
      look.disabled = true;
      look.textContent = 'Reading…';
      stage.replaceChildren(el('div', { className: 'empty' }, `Reading ${site.name}…`));

      try {
        const found = await api('/api/import/images/galleries?url=' + encodeURIComponent(target));
        renderGalleryList(stage, site, found, places.name, uuid);
      } catch (err) {
        stage.replaceChildren(el('div', { className: 'empty' }, `${site.name}: ${err.message}`));
      } finally {
        look.disabled = false;
        look.textContent = 'Find galleries';
      }
    };

    return el('div', { className: 'crow' },
      el('div', { className: 'noposter studio' }),
      el('div', {},
        el('div', { className: 'title' }, site.name),
        el('div', { className: 'meta' }, el('span', {}, site.note)),
        el('div', { className: 'muted small path' }, target)
      ),
      el('div', { className: 'trackedactions' }, look, open)
    );
  });

  body.replaceChildren(
    el('section', { className: 'feed' },
      el('div', { className: 'feedhead' },
        el('h2', {}, places.name),
        el('span', { className: 'muted' },
          places.slug ? `looked for as “${places.slug}” on each site` : 'no usable name')
      ),
      el('div', { className: 'tracked' }, cards)
    ),
    // replaceChildren has no opinion about null and renders it as the word, so
    // the optional band is filtered out rather than passed through.
    ...(uuid ? [tpdbBand(uuid)] : []),
    stage
  );
}

/*
 * The galleries on one site's listing page. A site that hides its list behind
 * JavaScript comes back with none, and says so — an empty grid with no
 * explanation is exactly what "it does nothing" looked like.
 */
function renderGalleryList(stage, site, found, name, uuid) {
  if (!found.galleries.length) {
    stage.replaceChildren(el('div', { className: 'empty small' },
      `${site.name} listed no galleries on that page. Some of these sites build their lists in the browser, ` +
      'so there is nothing in the page itself to read — open it and paste a gallery address instead.'));
    return;
  }

  const shots = el('div', {});

  const tiles = found.galleries.map((gallery) => {
    const art = el('div', { className: 'cardart landscape' },
      el('img', { src: '/media/scrape?url=' + encodeURIComponent(gallery.thumb), loading: 'lazy', alt: '' }));

    const card = el('article', { className: 'card' },
      art,
      el('div', { className: 'cardbody' }, el('div', { className: 'title' }, gallery.title))
    );

    card.onclick = () => readGallery(shots, gallery, name, uuid);
    return card;
  });

  stage.replaceChildren(
    el('section', { className: 'feed' },
      el('div', { className: 'feedhead' },
        el('h2', {}, `${found.galleries.length} on ${site.name}`),
        el('span', { className: 'muted' }, 'pick one to see the pictures in it')
      ),
      el('div', { className: 'cards' }, tiles)
    ),
    shots
  );
}

/*
 * The pictures in one gallery, read by the scraper that already existed. From
 * here the build is the gallery builder's own, in the Library — this page found
 * the page, which is the part that was missing.
 */
async function readGallery(shots, gallery, name, uuid) {
  shots.replaceChildren(el('div', { className: 'empty' }, `Reading “${gallery.title}”…`));
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });

  try {
    const found = await api('/api/galleries/find', {
      method: 'POST',
      body: JSON.stringify({ url: gallery.url }),
    });

    if (!found.candidates.length) {
      shots.replaceChildren(el('div', { className: 'empty small' }, 'Nothing on that page looked like a picture.'));
      return;
    }

    const grid = el('div', { className: 'shots' }, found.candidates.map((pic) =>
      el('a', { className: 'shot', href: pic.url, target: '_blank', rel: 'noreferrer' },
        el('img', { src: '/media/scrape?url=' + encodeURIComponent(pic.thumb || pic.url), loading: 'lazy', alt: '' }))));

    const build = el('a', {
      className: 'add',
      href: '#/library/galleries',
    }, 'Build this in Stash');
    build.title = 'The builder lives in the Library, where the gallery will end up.';

    shots.replaceChildren(
      el('section', { className: 'feed' },
        el('div', { className: 'feedhead' },
          el('h2', {}, found.title || gallery.title),
          el('span', { className: 'muted' },
            `${found.candidates.length} pictures — ${gallery.url}`),
          el('span', { className: 'spacer' }),
          build
        ),
        grid
      )
    );
  } catch (err) {
    shots.replaceChildren(el('div', { className: 'empty small' }, err.message));
  }
}

/*
 * ThePornDB is different in kind from the three sites above: keyed on an id
 * rather than a name, so its pictures are certainly of the right person. That
 * is worth its own band and its own sentence.
 */
function tpdbBand(uuid) {
  const go = el('button', { className: 'chip', type: 'button' }, 'Open their page');
  go.onclick = () => { location.hash = `#/performer/${uuid}`; };

  return el('section', { className: 'feed' },
    el('div', { className: 'feedhead' },
      el('h2', {}, 'ThePornDB'),
      el('span', { className: 'muted' },
        'keyed on their id rather than their name, so it cannot be about the wrong person')
    ),
    el('div', { className: 'toolbar' }, go)
  );
}
