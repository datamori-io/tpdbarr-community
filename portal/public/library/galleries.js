/*
 * The still half of the library: galleries, the pictures in them, and the
 * builder that makes one from a scrape or an upload.
 */

import { api, el } from '../util.js';
import { chips, claim, failed, failedIn, filedAndStars, head, heading, holds, loading, loadingIn, plural, preview, shell } from './core.js';
import { entityTile, grid, missingRail, shelfPage, tile } from './tiles.js';

/*
 * `onChanged` is what turns the card into an editable one: pages that can
 * redraw themselves pass it and get the pencil, the rails that borrow this
 * tile elsewhere do not.
 */
function galleryTile(gallery, onChanged) {
  const node = entityTile({
    name: gallery.title,
    shape: 'square',
    image: gallery.cover ? `/media/imagethumb/${gallery.cover}` : null,
    focus: gallery.focus,
    meta: [
      gallery.organized ? '✓' : null,
      gallery.images ? plural(gallery.images, 'image') : 'no files',
      gallery.date,
      gallery.studio?.name,
    ].filter(Boolean).join(' · '),
    href: `#/library/gallery/${gallery.id}`,
    // A gallery record with no pictures behind it is the same shape of thing
    // as a performer with no files: real, and not what you came for.
    faded: !gallery.images,
  });

  if (onChanged) {
    const edit = el('button', {
      className: 'facetedit',
      type: 'button',
      title: 'Rename, recrop or delete',
      ariaLabel: `Edit ${gallery.title}`,
    }, '✎');

    // The card itself opens the gallery, so the pencil has to keep its click.
    edit.onclick = (event) => {
      event.stopPropagation();
      editGallery(gallery, onChanged);
    };

    node.querySelector('.facetart').append(edit);
  }

  return node;
}

/*
 * The row that appears on a scene, a performer or a movie. Asked for after the
 * page has drawn and rendered only if there is something in it, so a library
 * with no galleries at all — which is every library until the day it isn't —
 * looks exactly as it did before.
 */
/*
 * The same galleries, in the rail instead of in a row of their own. A scene
 * has a handful rather than a wall, so one to a view with a pair of arrows is
 * the whole shelf — and it keeps the column under the player for the things
 * you do rather than the things you have.
 */
export async function sideGalleries(query) {
  const data = await api('/api/library/galleries?' + query).catch(() => null);
  if (!data?.galleries?.length) return null;

  const track = el('div', { className: 'sidetrack' }, data.galleries.map((g) => galleryTile(g)));

  // One card at a time; the snap points do the arriving, this only pushes.
  const nudge = (direction) =>
    track.scrollBy({ left: direction * track.clientWidth, behavior: 'smooth' });

  const back = el('button', { className: 'sidestep', type: 'button', ariaLabel: 'Previous gallery' }, '‹');
  const on = el('button', { className: 'sidestep', type: 'button', ariaLabel: 'Next gallery' }, '›');
  back.onclick = () => nudge(-1);
  on.onclick = () => nudge(1);

  // Disabled rather than hidden: two buttons that come and go move the heading
  // about, and this row is read as often as it is used.
  const ends = () => {
    back.disabled = track.scrollLeft < 8;
    on.disabled = track.scrollLeft + track.clientWidth > track.scrollWidth - 8;
  };
  track.addEventListener('scroll', ends, { passive: true });
  // After the caller has put the card on the page, so there is a width to
  // measure; a frame callback here is too early to be sure of one.
  setTimeout(ends, 0);

  return el('section', { className: 'sidecard' },
    el('div', { className: 'sidetop' },
      el('h2', { className: 'sidehead' }, 'Galleries'),
      el('span', { className: 'sidecount' }, String(data.count)),
      el('div', { className: 'sidesteps' }, back, on)
    ),
    track
  );
}

export async function attachedGalleries(query, note) {
  const data = await api('/api/library/galleries?' + query).catch(() => null);
  if (!data?.galleries?.length) return null;

  return missingRail({
    title: 'Galleries',
    note,
    count: String(data.count),
    items: data.galleries.map(galleryTile),
  });
}

/* ------------------------------------------------------------- the pencil
 *
 * The small things you decide about a gallery while looking at the wall of
 * them: what it is called, which picture fronts it, how that picture is
 * cropped into the square, and getting rid of it.
 *
 * The crop is a focal point stored on the gallery, not a cropped copy of the
 * file — the pictures are the thing you kept, and an editor that quietly
 * rewrites one is not what "change the thumbnail" should mean. Everything
 * else here is Stash's own: the cover is its cover, the delete is its delete.
 */
/*
 * One row of "what is this tied to": the chips you have, and a box that asks
 * Stash for the rest.
 *
 * Stash does the matching rather than the browser, because the alternative is
 * reading 1264 performers into a page to filter three of them. `chosen` is the
 * live array the dialog reads back on save — the picker mutates it in place
 * rather than reporting changes upward, which keeps this to one argument.
 */
function tiePicker(spec) {
  const chips = el('div', { className: 'tiechips' });
  const box = el('input', {
    type: 'search',
    placeholder: spec.placeholder,
    autocomplete: 'off',
    spellcheck: false,
  });
  const results = el('div', { className: 'tieresults', hidden: true });

  const draw = () => {
    chips.replaceChildren(...spec.chosen.map((item) => {
      const drop = el('button', { className: 'chipx', type: 'button', ariaLabel: `Remove ${item.name}` }, '×');
      drop.onclick = () => {
        spec.chosen.splice(spec.chosen.indexOf(item), 1);
        draw();
      };
      return el('span', { className: 'tagchip flat' }, item.name, drop);
    }));

    if (!spec.chosen.length) chips.append(el('span', { className: 'muted small' }, spec.empty));
  };

  const look = async () => {
    try {
      const { results: found } = await api(
        `/api/library/lookup?kind=${spec.kind}&q=${encodeURIComponent(box.value.trim())}`
      );

      // Something already on the gallery is not a thing to offer again.
      const fresh = found.filter((r) => !spec.chosen.some((c) => String(c.id) === String(r.id)));

      results.replaceChildren(...fresh.slice(0, 12).map((r) => {
        const hit = el('button', { className: 'tiehit', type: 'button' },
          el('span', {}, r.name),
          r.note ? el('span', { className: 'muted small' }, r.note) : null);

        hit.onclick = () => {
          const one = { id: r.id, name: r.name };
          // A studio is one thing; the other two are lists.
          if (spec.multiple) spec.chosen.push(one);
          else spec.chosen.splice(0, spec.chosen.length, one);
          box.value = '';
          results.hidden = true;
          draw();
        };
        return hit;
      }));

      results.hidden = !fresh.length;
    } catch (err) {
      results.replaceChildren(el('span', { className: 'muted small' }, err.message));
      results.hidden = false;
    }
  };

  // Typed at, not on every keystroke — this is a query against the library.
  let timer = null;
  box.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(look, 250);
  };
  box.onfocus = () => {
    if (results.childElementCount) results.hidden = false;
    else look();
  };
  box.onblur = () => setTimeout(() => { results.hidden = true; }, 150);

  draw();

  return el('div', { className: 'tierow' },
    el('span', { className: 'tielabel' }, spec.label),
    el('div', { className: 'tiebody' }, chips, box, results)
  );
}

async function editGallery(gallery, onChanged) {
  const dialog = el('dialog', { className: 'galleryedit' });
  const close = () => { dialog.close(); dialog.remove(); };

  let cover = gallery.cover;
  let focus = gallery.focus ? { ...gallery.focus } : null;

  const name = el('input', { type: 'text', value: gallery.title, spellcheck: false });
  const note = el('p', { className: 'note' });

  // The dialog's form would otherwise take Enter as "close", which is the one
  // thing you do not mean while typing a new name.
  name.onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    save.click();
  };

  /*
   * The crop, shown the size the card shows it. Clicking says "keep this
   * part": the point you click is the point held in the middle of the square,
   * which is what object-position means and the only crop control a square
   * needs.
   */
  const preview = el('div', { className: 'cropbox' });
  const shot = el('img', { alt: '' });
  preview.append(shot);

  const drawCrop = () => {
    shot.src = cover ? `/media/imagethumb/${cover}` : '';
    shot.style.objectPosition = focus ? `${focus.x}% ${focus.y}%` : '50% 50%';
    centre.disabled = !focus;
  };

  preview.onclick = (event) => {
    const box = preview.getBoundingClientRect();
    focus = {
      x: Math.round(((event.clientX - box.left) / box.width) * 100),
      y: Math.round(((event.clientY - box.top) / box.height) * 100),
    };
    drawCrop();
  };

  const centre = el('button', { className: 'act', type: 'button' }, 'Centre it');
  centre.onclick = () => { focus = null; drawCrop(); };

  // Which picture fronts it. Applied on the spot, because the crop preview is
  // the thing that has to show the answer.
  const strip = el('div', { className: 'coverpick' }, el('span', { className: 'muted small' }, 'Loading pictures…'));

  api(`/api/library/galleries/${gallery.id}`)
    .then(({ images }) => {
      strip.replaceChildren(...images.map((img) => {
        const pick = el('button', { className: 'shot' + (img.id === cover ? ' on' : ''), type: 'button' },
          el('img', { src: `/media/imagethumb/${img.id}`, loading: 'lazy', alt: '' }));

        pick.onclick = async () => {
          try {
            await api(`/api/library/galleries/${gallery.id}/cover`, {
              method: 'POST',
              body: JSON.stringify({ imageId: img.id }),
            });
            cover = img.id;
            for (const other of strip.children) other.classList.remove('on');
            pick.classList.add('on');
            drawCrop();
          } catch (err) {
            note.textContent = err.message;
          }
        };
        return pick;
      }));
    })
    .catch((err) => { strip.replaceChildren(el('span', { className: 'muted small' }, err.message)); });

  /*
   * What it belongs to. The build fills these in when you start from a scene
   * or a performer page; everything else arrives tied to nothing, and this is
   * where that gets fixed.
   */
  const scenes = gallery.scenes.map((s) => ({ id: s.id, name: s.title }));
  const performers = gallery.performers.map((p) => ({ id: p.id, name: p.name }));
  const studio = gallery.studio ? [{ id: gallery.studio.id, name: gallery.studio.name }] : [];

  const ties = el('div', { className: 'ties' },
    tiePicker({ kind: 'performer', label: 'Performers', chosen: performers, multiple: true,
      placeholder: 'Find a performer…', empty: 'nobody yet' }),
    tiePicker({ kind: 'scene', label: 'Scenes', chosen: scenes, multiple: true,
      placeholder: 'Find a scene…', empty: 'no scenes yet' }),
    tiePicker({ kind: 'studio', label: 'Studio', chosen: studio, multiple: false,
      placeholder: 'Find a studio…', empty: 'none yet' })
  );

  /* Delete asks once, and says what it will take with it. */
  const remove = el('button', { className: 'act danger', type: 'button' }, 'Delete');
  const confirm = el('span', { className: 'confirmrow', hidden: true });

  remove.onclick = () => {
    remove.hidden = true;
    confirm.hidden = false;
  };

  const yes = el('button', { className: 'act danger', type: 'button' }, 'Delete it');
  const no = el('button', { className: 'act', type: 'button' }, 'Keep it');

  yes.onclick = async () => {
    yes.disabled = true;
    yes.textContent = 'Deleting…';
    try {
      await api(`/api/library/galleries/${gallery.id}/delete`, {
        method: 'POST',
        // The folder goes too: leave it and Stash rebuilds the gallery on its
        // next scan, so a record-only delete would undo itself.
        body: JSON.stringify({ files: true }),
      });
      close();
      onChanged();
    } catch (err) {
      yes.disabled = false;
      yes.textContent = 'Delete it';
      note.textContent = err.message;
    }
  };

  no.onclick = () => { confirm.hidden = true; remove.hidden = false; };

  confirm.append(
    el('span', { className: 'muted small' },
      `${plural(gallery.images, 'picture')} and the folder. There is no undo.`),
    yes,
    no
  );

  const save = el('button', { className: 'act primary', type: 'button' }, 'Save');

  save.onclick = async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const wanted = name.value.trim();
      if (wanted && wanted !== gallery.title) {
        await api(`/api/library/galleries/${gallery.id}/title`, {
          method: 'POST',
          body: JSON.stringify({ title: wanted }),
        });
      }

      const was = gallery.focus ? `${gallery.focus.x} ${gallery.focus.y}` : '';
      const now = focus ? `${focus.x} ${focus.y}` : '';
      if (now !== was) {
        await api(`/api/library/galleries/${gallery.id}/focus`, {
          method: 'POST',
          body: JSON.stringify({ focus }),
        });
      }

      // One call for all three ties, and only if one of them moved.
      const ids = (list) => list.map((i) => String(i.id)).sort().join(',');
      const tiesMoved =
        ids(scenes) !== ids(gallery.scenes.map((s) => ({ id: s.id }))) ||
        ids(performers) !== ids(gallery.performers.map((p) => ({ id: p.id }))) ||
        (studio[0]?.id ?? null) !== (gallery.studio?.id ?? null);

      if (tiesMoved) {
        await api(`/api/library/galleries/${gallery.id}/ties`, {
          method: 'POST',
          body: JSON.stringify({
            sceneIds: scenes.map((s) => s.id),
            performerIds: performers.map((p) => p.id),
            studioId: studio[0]?.id ?? null,
          }),
        });
      }

      close();
      onChanged();
    } catch (err) {
      save.disabled = false;
      save.textContent = 'Save';
      note.textContent = err.message;
    }
  };

  dialog.append(
    el('form', { method: 'dialog' },
      el('h2', {}, 'Edit gallery'),
      el('label', {}, 'Name', name),
      el('div', { className: 'croprow' },
        el('div', {},
          preview,
          el('p', { className: 'muted small' }, 'Click the picture to say which part the card keeps.')
        ),
        el('div', { className: 'coverside' },
          el('span', { className: 'muted small' }, 'Front it with'),
          strip
        )
      ),
      ties,
      note,
      el('menu', {}, remove, confirm, el('span', { className: 'spacer' }), save,
        (() => { const shut = el('button', { className: 'act', type: 'button' }, 'Close'); shut.onclick = close; return shut; })())
    )
  );

  drawCrop();
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  name.focus();
}

/*
 * Galleries take the same bar, narrowed by the three things a picture set
 * actually has on it. There are no tags on a gallery and no runtime, so there
 * is no kind and no longest — what there is instead is how many pictures are
 * in it.
 */
const GALLERY_FACETS = [
  { key: 'filed', any: 'Filed or not', of: (g) => [g.organized ? 'Filed' : 'Not filed'] },
  { key: 'studio', any: 'Any studio', of: (g) => (g.studio ? [g.studio.name] : []) },
  { key: 'performer', any: 'Anyone', of: (g) => g.performers.map((p) => p.name) },
  { key: 'year', any: 'Any year', of: (g) => (g.date ? [g.date.slice(0, 4)] : []) },
];

const GALLERY_SORTS = [
  ['newest', 'Newest'],
  ['title', 'Title'],
  ['pictures', 'Most pictures'],
];

function orderGalleries(galleries, sort) {
  const by = [...galleries];
  if (sort === 'title') return by.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'pictures') return by.sort((a, b) => (b.images || 0) - (a.images || 0));
  return by.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

export async function showGalleries(query = '') {
  const mine = claim();
  loadingIn('#/library/galleries');
  try {
    // The row of people with nothing to look at is asked for beside the
    // galleries and costs a rail if it fails, never the page.
    const [data, bare] = await Promise.all([
      api('/api/library/galleries'),
      api('/api/library/galleries/gaps').catch(() => null),
    ]);
    if (!holds(mine)) return;

    // Editing anything redraws the wall, which is cheap and means the card
    // always shows what Stash now holds rather than what it held a moment ago.
    // The address is read back rather than closed over, so a rename lands on
    // the shelf you had filtered rather than on all of them.
    const again = () => showGalleries(location.hash.split('?')[1] || '');

    const galleries = data.galleries.map((gallery) => ({
      ...gallery,
      haystack: [gallery.title, gallery.studio?.name, ...gallery.performers.map((p) => p.name)]
        .filter(Boolean).join(' ').toLowerCase(),
    }));

    const [heading, ...rest] = data.count
      ? shelfPage({
          section: '#/library/galleries',
          title: 'Galleries',
          note: 'in Stash',
          placeholder: 'Search by name…',
          items: galleries,
          facets: GALLERY_FACETS,
          sorts: GALLERY_SORTS,
          order: orderGalleries,
          wall: 'facets',
          card: (gallery) => galleryTile(gallery, again),
          query,
        })
      : [
          head('Galleries', 'none in Stash yet'),
          el('div', { className: 'empty small' },
            'Stash has no galleries. Point it at a folder of pictures, or build one in ',
            el('a', { className: 'link', href: '#/parameters/galleries' }, 'Settings › Galleries'),
            ' — from a web page, or from the art ThePornDB already holds for a scene or a performer.'),
        ];

    /*
     * No builder here any more. Making a gallery from nothing is a setup
     * question and lives in Settings › Galleries; the builders that stay are
     * the tied ones, on the scene or the performer they are for.
     */
    shell('#/library/galleries', heading, rest,
      /*
       * The same thin row of what you do not have that every other page in
       * this half ends with. Their own page carries the button that builds it,
       * so the tile goes there rather than trying to start a build from here.
       */
      bare?.performers?.length
        ? missingRail({
            title: 'No pictures yet',
            note: 'people you hold films of, with no gallery on their name',
            count: String(bare.count),
            items: bare.performers.map((p) => entityTile({
              name: p.name,
              image: p.art ? `/media/performer/${p.id}` : null,
              meta: `${p.held} in your library`,
              href: `#/library/performer/${p.id}`,
              favorite: p.favorite,
            })),
          })
        : null
    );
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/galleries', err);
  }
}

/* ------------------------------------------------------------- one gallery */

export async function showGallery(id) {
  const mine = claim();
  loadingIn('#/library/galleries');
  try {
    const data = await api(`/api/library/galleries/${id}`);
    if (!holds(mine)) return;

    const { gallery, scenes, movies, count, images } = data;
    const shots = shotGrid(gallery, images);

    shell('#/library/galleries',
      el('div', { className: 'listhead with-portrait' },
        gallery.cover
          ? el('img', { className: 'portrait square', src: `/media/imagethumb/${gallery.cover}`, alt: '', loading: 'lazy' })
          : null,
        el('div', {},
          el('h1', { className: gallery.untitled ? 'untitled' : '' }, gallery.title),
          el('p', { className: 'muted' },
            [plural(count, 'image'), gallery.date, gallery.photographer && `by ${gallery.photographer}`,
              gallery.studio?.name].filter(Boolean).join(' · ')),
          gallery.details ? el('p', {}, gallery.details) : null,
          /*
           * The same pair the scene page carries, and for the same reason:
           * Stash keeps filed and a rating for a gallery too, and until now
           * nothing in this portal ever set either.
           */
          el('div', { className: 'sceneactions' },
            filedAndStars(gallery, `/api/library/galleries/${gallery.id}`, () => showGallery(id))),
          chips('castrow', gallery.performers, (p) => `#/library/performer/${p.id}`),
          chips('tagrow', gallery.tags, null)
        )
      ),
      shotTools(gallery, shots, () => showGallery(id)),
      shots.node,
      count > images.length ? moreButton(gallery, shots, count) : null,
      /*
       * The ties, under the pictures rather than over them: you opened a
       * gallery to look at it, and what it belongs to is the second question.
       */
      scenes.length
        ? [head('In these scenes', plural(scenes.length, 'scene')), grid(scenes)]
        : null,
      movies.length
        ? missingRail({
            title: 'From these movies',
            note: 'through the scenes above — a gallery carries no group of its own',
            items: movies.map((m) => entityTile({
              name: m.name,
              image: `/media/group/${m.id}`,
              meta: 'movie',
              href: `#/library/group/${m.id}`,
            })),
          })
        : null
    );
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/galleries', err);
  }
}

/*
 * The pictures. A grid of thumbnails that opens a viewer, and the viewer works
 * off this same list — so paging in more pictures lengthens what you can arrow
 * through without rebuilding anything.
 */
function shotGrid(gallery, images) {
  const node = el('div', { className: 'shots' });

  /*
   * The same grid does both jobs. Ordinarily a click opens the viewer; in
   * select mode it ticks the picture instead, because the two things you want
   * to do to a picture you are looking at — front the gallery with it, get rid
   * of it — are both about picking pictures rather than viewing them.
   */
  const state = { images: [], nodes: [], node, selecting: false, selected: new Set(), onPick: null };

  state.add = (more) => {
    const from = state.images.length;
    state.images.push(...more);

    for (const [i, img] of more.entries()) {
      const tile = shot(state, from + i, img);
      state.nodes.push(tile);
      node.append(tile);
    }
  };

  state.setSelecting = (on) => {
    state.selecting = on;
    node.classList.toggle('selecting', on);
    if (!on) {
      state.selected.clear();
      for (const tile of state.nodes) tile.classList.remove('on');
    }
    state.onPick?.();
  };

  state.add(images);
  return state;
}

export function shot(state, index, img) {
  const node = el('button', { className: 'shot', type: 'button', ariaLabel: img.title || `Image ${index + 1}` },
    el('img', { src: `/media/imagethumb/${img.id}`, loading: 'lazy', alt: '' })
  );

  node.onclick = () => {
    if (!state.selecting) {
      openViewer(state, index);
      return;
    }

    if (state.selected.has(img.id)) state.selected.delete(img.id);
    else state.selected.add(img.id);

    node.classList.toggle('on', state.selected.has(img.id));
    state.onPick?.();
  };

  return node;
}

/*
 * What you can do to the pictures: add more, or pick some and act on them.
 *
 * Delete says what it will take and takes the files with it — a picture left
 * in the folder is one the next scan puts straight back, so a record-only
 * delete would quietly undo itself.
 */
function shotTools(gallery, shots, reload) {
  const status = el('span', { className: 'muted small' });

  const chooser = el('input', {
    type: 'file',
    multiple: true,
    accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif,.zip,.cbz',
    hidden: true,
  });

  const add = el('button', { className: 'act', type: 'button' }, 'Add pictures');
  add.onclick = () => chooser.click();

  chooser.onchange = async () => {
    const files = [...chooser.files];
    if (!files.length) return;

    add.disabled = true;
    try {
      const sent = await uploadFiles(files, { gallery: gallery.id }, (line) => { status.textContent = line; });
      if (!sent.written) {
        status.textContent = sent.failed[0]?.why || 'Nothing in that was a picture.';
        return;
      }

      status.textContent = `${sent.written} uploaded. Asking Stash to look again…`;
      await api(`/api/library/galleries/${gallery.id}/rescan`, { method: 'POST' });
      reload();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      add.disabled = false;
      chooser.value = '';
    }
  };

  const select = el('button', { className: 'act', type: 'button' }, 'Select');
  const cover = el('button', { className: 'act', type: 'button', hidden: true }, 'Make it the cover');
  const remove = el('button', { className: 'act danger', type: 'button', hidden: true }, 'Delete');
  const confirm = el('span', { className: 'confirmrow', hidden: true });

  select.onclick = () => {
    shots.setSelecting(!shots.selecting);
    select.textContent = shots.selecting ? 'Done' : 'Select';
    select.className = shots.selecting ? 'act on' : 'act';
    confirm.hidden = true;
    remove.hidden = !shots.selecting;
  };

  shots.onPick = () => {
    const n = shots.selected.size;
    // One picture can front the gallery; any number can go.
    cover.hidden = n !== 1;
    remove.hidden = !shots.selecting;
    remove.disabled = n === 0;
    remove.textContent = n ? `Delete ${n}` : 'Delete';
    confirm.hidden = true;
    status.textContent = shots.selecting ? `${n} picked` : '';
  };

  cover.onclick = async () => {
    const [only] = [...shots.selected];
    cover.disabled = true;
    try {
      await api(`/api/library/galleries/${gallery.id}/cover`, {
        method: 'POST',
        body: JSON.stringify({ imageId: only }),
      });
      status.textContent = 'That is the cover now.';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      cover.disabled = false;
    }
  };

  remove.onclick = () => {
    confirm.replaceChildren(
      el('span', { className: 'muted small' },
        `${plural(shots.selected.size, 'picture')} and the files. There is no undo.`),
      yes,
      no
    );
    confirm.hidden = false;
  };

  const yes = el('button', { className: 'act danger', type: 'button' }, 'Delete them');
  const no = el('button', { className: 'act', type: 'button' }, 'Keep them');

  yes.onclick = async () => {
    yes.disabled = true;
    yes.textContent = 'Deleting…';
    try {
      await api(`/api/library/galleries/${gallery.id}/images/delete`, {
        method: 'POST',
        body: JSON.stringify({ ids: [...shots.selected], files: true }),
      });
      reload();
    } catch (err) {
      yes.disabled = false;
      yes.textContent = 'Delete them';
      status.textContent = err.message;
    }
  };

  no.onclick = () => { confirm.hidden = true; };

  return el('div', { className: 'toolbar shottools' }, add, chooser, select, cover, remove, confirm, status);
}

function moreButton(gallery, shots, count) {
  const button = el('button', { className: 'act', type: 'button' }, `Show more — ${count - shots.images.length} left`);
  let page = 1;

  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      page++;
      const next = await api(`/api/library/galleries/${gallery.id}?page=${page}`);
      shots.add(next.images);
      const left = count - shots.images.length;
      if (left <= 0) button.remove();
      else {
        button.disabled = false;
        button.textContent = `Show more — ${left} left`;
      }
    } catch (err) {
      button.disabled = false;
      button.textContent = err.message;
    }
  };

  return el('div', { className: 'sceneactions' }, button);
}

/*
 * The viewer. Full-size, arrow keys, click the backdrop to leave — and it
 * takes itself down on a hash change, because it lives on <body> rather than
 * inside the view and would otherwise outlast the page that opened it.
 */
function openViewer(state, start) {
  let at = start;

  const picture = el('img', { className: 'viewerimg', alt: '' });
  const caption = el('div', { className: 'viewercount' });

  const show = () => {
    const img = state.images[at];
    picture.src = `/media/image/${img.id}`;
    caption.textContent = `${at + 1} / ${state.images.length}${img.title ? ' · ' + img.title : ''}`;
  };

  const step = (by) => {
    at = (at + by + state.images.length) % state.images.length;
    show();
  };

  const prev = el('button', { className: 'viewernav left', type: 'button', ariaLabel: 'Previous' }, '‹');
  const next = el('button', { className: 'viewernav right', type: 'button', ariaLabel: 'Next' }, '›');
  const shut = el('button', { className: 'viewerclose', type: 'button', ariaLabel: 'Close' }, '×');

  const viewer = el('div', { className: 'viewer' }, picture, prev, next, shut, caption);

  const close = () => {
    viewer.remove();
    document.removeEventListener('keydown', keys);
    window.removeEventListener('hashchange', close);
  };

  const keys = (event) => {
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key === 'ArrowLeft') step(-1);
    else return;
    event.preventDefault();
  };

  prev.onclick = (e) => { e.stopPropagation(); step(-1); };
  next.onclick = (e) => { e.stopPropagation(); step(1); };
  shut.onclick = close;
  // Only the backdrop closes; a click on the picture itself is not a request
  // to put it away.
  viewer.onclick = (event) => { if (event.target === viewer) close(); };

  document.addEventListener('keydown', keys);
  window.addEventListener('hashchange', close);

  show();
  document.body.append(viewer);
}

/*
 * Sending files up, one request each.
 *
 * One at a time on purpose: a failed picture is then a failed picture rather
 * than a failed set, the progress line means something, and the server needs
 * no multipart parser — the body is the file and the name is in the query.
 */
async function uploadFiles(files, params, onProgress) {
  const query = new URLSearchParams(params);
  const done = [];
  const failed = [];

  for (const [i, file] of [...files].entries()) {
    onProgress?.(`Sending ${i + 1} of ${files.length} — ${file.name}`);
    query.set('file', file.name);

    try {
      // Not api(): that stamps a JSON content type on anything with a body,
      // and this body is a picture.
      const res = await fetch(`/api/galleries/upload?${query}`, { method: 'POST', body: file });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || res.statusText);
      done.push(payload);
    } catch (err) {
      failed.push({ name: file.name, why: err.message });
    }
  }

  const written = done.reduce((n, r) => n + r.written, 0);
  const skipped = done.flatMap((r) => r.skipped || []);
  return { written, skipped, failed };
}

/* ------------------------------------------------------------ building one
 *
 * Find, choose, write. Three steps and they stay three: the find says nothing
 * about what will be kept, and nothing is downloaded until someone has looked
 * at the pictures and cut the list down. Same argument as the movie
 * gap-filler — this is the only other thing in the portal that writes files.
 *
 * `spec.tie` is what the page already knows: the scene page ties to its own
 * scene, cast and studio, the performer page to that performer. Nothing here
 * matches or guesses.
 */
export function buildPanel(spec) {
  const panel = el('div', { className: 'gappanel gallerybuild' });
  const open = el('button', { className: 'act', type: 'button' }, spec.label || 'Build a gallery');
  const body = el('div', { hidden: true });

  open.onclick = () => {
    body.hidden = !body.hidden;
    open.className = body.hidden ? 'act' : 'act on';
    if (!body.hidden && !body.dataset.ready) {
      body.dataset.ready = '1';
      // `setup: false` is for the one caller that already shows the check.
      if (spec.setup !== false) body.prepend(setupCheck());
    }
  };

  const status = el('p', { className: 'note' });
  const sources = el('div', { className: 'sceneactions' });
  const found = el('div', {});

  // Where to look. The URL box is always there; a scene or a performer adds
  // the pictures ThePornDB already holds for it.
  const box = el('input', {
    type: 'url',
    className: 'filter',
    placeholder: 'https://… a page with pictures on it',
    autocomplete: 'off',
    spellcheck: false,
  });

  const find = async (request, button) => {
    for (const b of sources.querySelectorAll('button')) b.disabled = true;
    const was = button.textContent;
    button.textContent = 'Looking…';
    status.textContent = '';

    try {
      const result = await api('/api/galleries/find', { method: 'POST', body: JSON.stringify(request) });
      found.replaceChildren(picker(result, spec, status));
      if (!result.candidates.length) status.textContent = 'Nothing on that page looked like a picture.';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      for (const b of sources.querySelectorAll('button')) b.disabled = false;
      button.textContent = was;
    }
  };

  const fromUrl = el('button', { className: 'act primary', type: 'button' }, 'Find pictures');
  fromUrl.onclick = () => {
    const url = box.value.trim();
    if (!url) { status.textContent = 'Paste the address of the page the pictures are on.'; return; }
    find({ url }, fromUrl);
  };
  sources.append(fromUrl);

  if (spec.tpdbScene) {
    const button = el('button', { className: 'act', type: 'button' }, 'From ThePornDB');
    button.onclick = () => find({ scene: spec.tpdbScene }, button);
    sources.append(button);
  }
  if (spec.tpdbPerformer) {
    const button = el('button', { className: 'act', type: 'button' }, 'Their photos on ThePornDB');
    button.onclick = () => find({ performer: spec.tpdbPerformer }, button);
    sources.append(button);
  }

  /*
   * The third source: pictures you already have. A zip is unpacked on the way
   * in, since that is how a photo set usually arrives; anything else is taken
   * one file at a time.
   *
   * Its own name box rather than the picker's, because nothing was found here
   * to take a title from.
   */
  const chooser = el('input', {
    type: 'file',
    multiple: true,
    accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif,.zip,.cbz',
  });

  const uploadName = el('input', { type: 'text', className: 'filter', placeholder: 'What to call it' });
  const upload = el('button', { className: 'act primary', type: 'button' }, 'Upload and build');

  chooser.onchange = () => {
    // A zip usually carries the set's name; a pile of loose files does not.
    if (uploadName.value.trim() || !chooser.files.length) return;
    const first = chooser.files[0].name;
    uploadName.value = /\.(zip|cbz)$/i.test(first) ? first.replace(/\.(zip|cbz)$/i, '') : '';
  };

  upload.onclick = async () => {
    const files = [...chooser.files];
    const name = uploadName.value.trim();

    if (!files.length) { status.textContent = 'Choose some pictures, or a zip of them.'; return; }
    if (!name) { status.textContent = 'Give it a name — that is the folder it goes in.'; return; }

    upload.disabled = true;
    found.replaceChildren();

    try {
      const sent = await uploadFiles(files, { name }, (line) => { status.textContent = line; });

      if (!sent.written) {
        status.textContent = sent.failed[0]?.why || 'Nothing in that was a picture.';
        return;
      }

      const trouble = [
        sent.failed.length ? `${sent.failed.length} failed` : null,
        sent.skipped.length ? `${sent.skipped.length} skipped` : null,
      ].filter(Boolean).join(', ');

      status.textContent = `${sent.written} uploaded${trouble ? ` — ${trouble}` : ''}. Asking Stash for it…`;

      const job = await api('/api/galleries/build', {
        method: 'POST',
        body: JSON.stringify({ name, uploaded: true, urls: [], tie: spec.tie || {} }),
      });

      found.replaceChildren(progress(job));
    } catch (err) {
      status.textContent = err.message;
    } finally {
      upload.disabled = false;
    }
  };

  body.append(
    el('div', { className: 'toolbar' }, box),
    sources,
    el('div', { className: 'uploadrow' },
      el('span', { className: 'muted small' }, 'or upload your own — pictures, or a zip of them'),
      el('div', { className: 'toolbar' }, chooser, uploadName, upload)
    ),
    status,
    found
  );

  panel.append(el('div', { className: 'sceneactions' }, open), body);
  return panel;
}

/*
 * Where the gallery is going to land, and whether it can. Checked when the
 * panel opens rather than when Build is pressed, because the answer is usually
 * "Stash is not scanning that folder yet" and that is worth knowing before
 * choosing forty pictures. Settings › Galleries shows the same node beside the
 * two folder boxes, where it is the answer to "did I type those right".
 */
export function setupCheck() {
  const note = el('p', { className: 'note' }, 'Checking where a gallery would go…');
  const wrap = el('div', {}, note);

  const draw = (setup) => {
    if (setup.ready) {
      note.textContent = `Pictures go to ${setup.path}, which Stash scans as ${setup.stashPath}.`;
      return;
    }

    note.textContent = setup.error
      || (setup.excludesImages
        ? `Stash scans ${setup.stashPath} but excludes images from it, so a gallery would never appear.`
        : `Stash is not scanning ${setup.stashPath}, so the pictures would sit there unimported.`);

    // Only offered when the folder is the only thing missing — a settings
    // write on somebody else's application belongs behind a button that says
    // what it will do.
    if (setup.writable && (!setup.covered || setup.excludesImages)) {
      const fix = el('button', { className: 'act primary', type: 'button' },
        `Add ${setup.stashPath} to Stash, images included`);
      fix.onclick = async () => {
        fix.disabled = true;
        fix.textContent = 'Telling Stash…';
        try {
          await api('/api/galleries/setup', { method: 'POST' });
          fix.remove();
          draw(await api('/api/galleries/setup'));
        } catch (err) {
          fix.disabled = false;
          fix.textContent = err.message;
        }
      };
      wrap.append(el('div', { className: 'sceneactions' }, fix));
    }
  };

  api('/api/galleries/setup')
    .then(draw)
    .catch((err) => { note.textContent = err.message; });

  return wrap;
}

/*
 * The pictures found, to be cut down. What arrives ticked is the finder's
 * call — the pictures a page linked at full size, or everything on a page that
 * linked none, or nothing at all on ThePornDB, where the list is a handful of
 * versions of one picture.
 */
function picker(result, spec, status) {
  const chosen = new Set();
  const wrap = el('div', { className: 'picker' });

  const name = el('input', {
    type: 'text',
    className: 'filter',
    value: result.title || '',
    placeholder: 'What to call it',
  });

  const counter = el('span', { className: 'muted small' });
  const build = el('button', { className: 'act primary', type: 'button' }, 'Build it');

  const retally = () => {
    counter.textContent = `${chosen.size} of ${result.candidates.length} chosen`;
    build.disabled = chosen.size === 0;
  };

  const grid = el('div', { className: 'shots picking' },
    result.candidates.map((c) => {
      const node = el('button', { className: 'shot', type: 'button', title: c.why || '' },
        el('img', { src: `/media/scrape?url=${encodeURIComponent(c.thumb)}`, loading: 'lazy', alt: '' })
      );
      // A thumbnail that will not load is a picture that will not download.
      node.querySelector('img').addEventListener('error', () => node.classList.add('broken'), { once: true });

      const pick = (on) => {
        node.classList.toggle('on', on);
        if (on) chosen.add(c.url); else chosen.delete(c.url);
        retally();
      };

      node.onclick = () => pick(!node.classList.contains('on'));
      if (c.pick) pick(true);
      return node;
    })
  );

  const all = el('button', { className: 'act', type: 'button' }, 'All');
  const none = el('button', { className: 'act', type: 'button' }, 'None');
  all.onclick = () => { for (const n of grid.children) if (!n.classList.contains('on')) n.click(); };
  none.onclick = () => { for (const n of grid.children) if (n.classList.contains('on')) n.click(); };

  build.onclick = async () => {
    build.disabled = true;
    build.textContent = 'Starting…';
    try {
      const job = await api('/api/galleries/build', {
        method: 'POST',
        body: JSON.stringify({
          name: name.value.trim() || result.title || 'Gallery',
          urls: [...chosen],
          tie: { ...(spec.tie || {}), url: result.source || null, date: result.date || spec.tie?.date || null },
        }),
      });
      build.remove();
      wrap.append(progress(job));
    } catch (err) {
      build.disabled = false;
      build.textContent = 'Build it';
      status.textContent = err.message;
    }
  };

  retally();

  wrap.append(
    el('div', { className: 'toolbar' }, name, all, none, counter),
    grid,
    el('div', { className: 'sceneactions' }, build)
  );
  return wrap;
}

/*
 * Four steps, and the one it is on. Polled rather than streamed, and the loop
 * stops on its own when the node leaves the page — which is what happens when
 * you navigate away, and is simpler than teaching the view's teardown about a
 * panel that may not exist.
 */
const STAGE = {
  writing: 'Downloading',
  scanning: 'Waiting for Stash to finish scanning the folder',
  finding: 'Looking for the gallery Stash made',
  tying: 'Tying it to the scene',
};

function progress(job) {
  const line = el('p', { className: 'note' }, 'Starting…');
  const node = el('div', {}, line);

  const draw = (state) => {
    if (state.stage === 'done') {
      line.replaceChildren(
        document.createTextNode(
          `Built — ${plural(state.written, 'picture')} in Stash.` +
          // The pictures are in either way; the tie is the part that can fail
          // on its own, and a gallery tied to nothing is worth saying out loud.
          (state.tieError ? ` Could not title or tie it: ${state.tieError}. ` : ' ')
        ),
        el('a', { className: 'link', href: `#/library/gallery/${state.gallery.id}` }, 'Open it')
      );
      return true;
    }

    if (state.stage === 'failed') {
      line.textContent = state.error || 'It did not work.';
      return true;
    }

    const where = STAGE[state.stage] || state.stage;
    line.textContent = state.stage === 'writing'
      ? `${where} — ${state.done} of ${state.total}${state.failed.length ? `, ${state.failed.length} failed` : ''}`
      : `${where}…`;
    return false;
  };

  (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1200));
      if (!node.isConnected) return;
      try {
        if (draw(await api(`/api/galleries/jobs/${job.id}`))) return;
      } catch (err) {
        line.textContent = err.message;
        return;
      }
    }
  })();

  draw(job);
  return node;
}

// Which stash-box a Stash record was identified against — the same question
// the scene page asks, asked of a performer.
export function tpdbIdOf(stashIds = []) {
  const hit = (stashIds || []).find(
    (s) => /theporndb|metadataapi/i.test(s.endpoint || '') && !/[?&]type=movie/i.test(s.endpoint || '')
  );
  return hit ? hit.stash_id : null;
}
