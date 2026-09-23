/*
 * Galleries — the still half of the library.
 *
 * Same spine as stashlib.mjs: keyed on Stash ids, because a gallery has no
 * TPDB identity and never will. TPDB carries no photo sets at all, so nothing
 * here has an acquisition side — a gallery is something you already have, or
 * it does not exist.
 *
 * Three ties matter, and Stash only gives two of them directly. A gallery
 * carries its own `scenes` and `performers`, so those are read off the record.
 * A movie is a Stash **group**, and the Gallery type has no group field in
 * 0.31.1 — so the movie tie is made through the gallery's scenes instead, the
 * same way the acquisition side answers a movie scene by scene rather than
 * pretending the group knows.
 *
 * Scenes are deliberately *not* scoped to /organized_scenes here. That folder
 * is where FileFlows puts a file it has encoded, and nothing in that pipeline
 * touches images — a photo set is imported once and stays where it landed. So
 * scoping galleries to the video library folder would hide all of them.
 */

import { gql } from './stash.mjs';
import { card as sceneCard, performersView } from './stashlib.mjs';

const CARD = `
  id title date photographer organized rating100 image_count created_at custom_fields
  cover { id }
  studio { id name }
  performers { id name favorite }
  scenes { id title }
  folder { path }
  files { path }
`;

const IMAGE = `
  id title date rating100 o_counter organized
  visual_files { ... on ImageFile { width height } }
`;

// ------------------------------------------------------------------ shaping

// An unnamed gallery is the common case — a scan names it after nothing at
// all — so the folder or the zip it came from is what is left to call it.
function basename(path) {
  if (!path) return null;
  const name = String(path).split(/[\\/]/).filter(Boolean).pop() || '';
  return name.replace(/\.(zip|cbz)$/i, '') || null;
}

export function card(gallery) {
  const source = gallery.folder?.path || gallery.files?.[0]?.path || null;
  const title = gallery.title || basename(source) || `Gallery ${gallery.id}`;

  return {
    id: gallery.id,
    title,
    untitled: !gallery.title,
    date: gallery.date || null,
    photographer: gallery.photographer || null,
    images: gallery.image_count || 0,
    organized: !!gallery.organized,
    rating: gallery.rating100 ?? null,
    studio: gallery.studio ? { id: gallery.studio.id, name: gallery.studio.name } : null,
    performers: (gallery.performers || []).map((p) => ({ id: p.id, name: p.name, favorite: !!p.favorite })),
    // Enough to draw the tie without a second request; the gallery page reads
    // the scenes properly.
    scenes: (gallery.scenes || []).map((s) => ({ id: s.id, title: s.title })),
    // The cover is an ordinary image, so it is served by the image proxy like
    // every other one rather than needing a route of its own.
    cover: gallery.cover?.id || null,
    // How that cover sits in the square the card crops it to. See setFocus().
    focus: readFocus(gallery.custom_fields),
    path: source,
    addedAt: gallery.created_at || null,
  };
}

/*
 * The focal point, as "x y" in percentages on a custom field.
 *
 * A card crops its cover to a square and a portrait cover loses a head to
 * that, so this says which part to keep. It is display-only — the picture on
 * disk is never touched — which is the whole reason it lives here rather than
 * in a cropped copy of the file.
 */
const FOCUS_FIELD = 'tpdbarr_focus';

function readFocus(fields) {
  const raw = fields?.[FOCUS_FIELD];
  if (!raw) return null;

  const [x, y] = String(raw).split(/\s+/).map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp(x), y: clamp(y) };
}

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

function image(img) {
  const file = img.visual_files?.[0] || null;
  return {
    id: img.id,
    title: img.title || null,
    date: img.date || null,
    rating: img.rating100 ?? null,
    oCount: img.o_counter || 0,
    organized: !!img.organized,
    width: file?.width || null,
    height: file?.height || null,
  };
}

// -------------------------------------------------------------------- reads

const PAGE = 120;

async function find(config, { filter = {}, sort = 'date', direction = 'DESC', page = 1, limit = -1 } = {}) {
  const data = await gql(
    config,
    `query($f: GalleryFilterType, $p: FindFilterType) {
       findGalleries(gallery_filter: $f, filter: $p) { count galleries { ${CARD} } }
     }`,
    { f: filter, p: { per_page: limit, page, sort, direction } }
  );
  return { count: data.findGalleries.count, galleries: data.findGalleries.galleries.map(card) };
}

/*
 * The section. Everything Stash holds, newest first, plus the one number the
 * empty state needs: a Stash with images but no galleries has been scanned
 * with the wrong folder rules, which is a different problem from an empty one.
 */
export async function galleriesView(config) {
  const [{ count, galleries }, totals] = await Promise.all([
    find(config, { sort: 'date' }),
    gql(config, '{ findImages(filter: {per_page: 1}) { count } }').catch(() => null),
  ]);

  return {
    count,
    galleries,
    images: totals?.findImages?.count ?? null,
    // A gallery Stash has no files for is a record, not a photo set.
    empty: galleries.filter((g) => !g.images).length,
  };
}

export async function images(config, galleryId, { page = 1, limit = PAGE } = {}) {
  const data = await gql(
    config,
    `query($f: ImageFilterType, $p: FindFilterType) {
       findImages(image_filter: $f, filter: $p) { count images { ${IMAGE} } }
     }`,
    {
      f: { galleries: { value: [galleryId], modifier: 'INCLUDES' } },
      // Shot order, which is filename order. Date and rating are both mostly
      // empty on images and would scatter a set that has an order already.
      p: { per_page: limit, page, sort: 'path', direction: 'ASC' },
    }
  );

  return { page, count: data.findImages.count, images: data.findImages.images.map(image) };
}

/*
 * One gallery: the record, its images, and the three things it is tied to.
 *
 * The scenes are re-read as full cards rather than used as the {id, title}
 * pairs the gallery record carries, so they draw as the same tile as anywhere
 * else. The groups fall out of those scenes — see the note at the top.
 */
export async function galleryView(config, id, { page = 1 } = {}) {
  const data = await gql(
    config,
    `query($id: ID!) { findGallery(id: $id) {
       ${CARD} details urls
       tags { id name }
       chapters { id title image_index }
     } }`,
    { id }
  );

  const gallery = data.findGallery;
  if (!gallery) throw new Error('Stash has no gallery with that id.');

  const sceneIds = (gallery.scenes || []).map((s) => s.id);

  const [shots, scenes] = await Promise.all([
    images(config, id, { page }),
    sceneIds.length ? sceneCards(config, sceneIds) : Promise.resolve([]),
  ]);

  const groups = new Map();
  for (const scene of scenes) {
    for (const g of scene.groups || []) groups.set(g.id, g);
  }

  return {
    gallery: {
      ...card(gallery),
      details: gallery.details || null,
      urls: gallery.urls || [],
      tags: gallery.tags || [],
      chapters: (gallery.chapters || [])
        .map((c) => ({ id: c.id, title: c.title || 'Chapter', index: c.image_index }))
        .sort((a, b) => a.index - b.index),
    },
    // The three ties, in the order the questions get asked.
    scenes: scenes.map((s) => s.card),
    movies: [...groups.values()],
    page: shots.page,
    count: shots.count,
    images: shots.images,
  };
}

/*
 * The gallery's scenes as library tiles, carrying the groups they belong to.
 *
 * By `ids` and not a filter: SceneFilterType.id is an IntCriterionInput and
 * takes one number, so a handful of specific scenes is the argument's job.
 */
async function sceneCards(config, ids) {
  const data = await gql(
    config,
    `query($ids: [ID!]) {
       findScenes(ids: $ids, filter: {per_page: -1, sort: "date", direction: DESC}) {
         scenes {
           id title date organized rating100 o_counter play_count resume_time
           studio { id name }
           performers { id name favorite }
           files { duration width height path }
           groups { group { id name } }
         }
       }
     }`,
    { ids }
  );

  return (data.findScenes.scenes || []).map((scene) => ({
    card: sceneCard(scene),
    groups: (scene.groups || []).filter((g) => g.group).map((g) => ({ id: g.group.id, name: g.group.name })),
  }));
}

/*
 * The other direction: what a scene, a performer or a movie has hanging off
 * it. Asked for by the page that is already drawn, so a Stash with no
 * galleries costs a row that never appears rather than the page.
 */
export async function attached(config, { scene = null, performer = null, group = null } = {}) {
  if (scene) return find(config, { filter: { scenes: { value: [scene], modifier: 'INCLUDES' } }, sort: 'date' });
  if (performer) return find(config, { filter: { performers: { value: [performer], modifier: 'INCLUDES' } }, sort: 'date' });

  // No group field on a gallery, so this asks the question through the scenes:
  // galleries whose scenes are in this group.
  if (group) {
    return find(config, {
      filter: { scenes_filter: { groups: { value: [group], modifier: 'INCLUDES' } } },
      sort: 'date',
    });
  }

  return { count: 0, galleries: [] };
}

/* ----------------------------------------------------------------- writes
 *
 * The same light touch as the scene page: the things you decide while looking
 * at it, and nothing else. Metadata surgery stays in Stash.
 */

export async function setOrganized(config, id, organized) {
  const data = await gql(
    config,
    'mutation($id: ID!, $o: Boolean!) { galleryUpdate(input: {id: $id, organized: $o}) { id organized } }',
    { id, o: !!organized }
  );
  return data.galleryUpdate;
}

export async function rename(config, id, title) {
  const clean = String(title || '').trim();
  if (!clean) throw new Error('A gallery needs a name.');

  const data = await gql(
    config,
    'mutation($id: ID!, $t: String) { galleryUpdate(input: {id: $id, title: $t}) { id title } }',
    { id, t: clean }
  );
  return data.galleryUpdate;
}

/*
 * Which picture fronts the gallery. Stash owns this properly — an ordinary
 * cover, the same one its own UI shows — so no copy of the image is made and
 * nothing is written into the folder.
 */
export async function setCover(config, id, imageId) {
  if (!imageId) {
    const reset = await gql(
      config,
      'mutation($id: ID!) { resetGalleryCover(input: {gallery_id: $id}) }',
      { id }
    );
    return { reset: Boolean(reset.resetGalleryCover) };
  }

  await gql(
    config,
    'mutation($g: ID!, $i: ID!) { setGalleryCover(input: {gallery_id: $g, cover_image_id: $i}) }',
    { g: id, i: String(imageId) }
  );
  return { cover: String(imageId) };
}

/*
 * Where to crop that cover from, kept as a custom field on the gallery rather
 * than as a second, cropped file. Passing null clears it and the card goes
 * back to centring.
 */
export async function setFocus(config, id, focus) {
  const custom_fields = focus
    ? { partial: { [FOCUS_FIELD]: `${clamp(focus.x)} ${clamp(focus.y)}` } }
    : { remove: [FOCUS_FIELD] };

  const data = await gql(
    config,
    'mutation($id: ID!, $c: CustomFieldsInput) { galleryUpdate(input: {id: $id, custom_fields: $c}) { id custom_fields } }',
    { id, c: custom_fields }
  );

  return { focus: readFocus(data.galleryUpdate.custom_fields) };
}

/*
 * What it belongs to, changed after the fact.
 *
 * A build sets these from the page you built on — the scene page knows its own
 * scene — but a gallery that arrived any other way has nobody to ask, and a
 * tie is the whole point of having galleries in here. Each list replaces
 * rather than appends, because the dialog sends the state it is showing.
 */
export async function setTies(config, id, { sceneIds, performerIds, studioId } = {}) {
  const input = { id };
  if (Array.isArray(sceneIds)) input.scene_ids = sceneIds.map(String);
  if (Array.isArray(performerIds)) input.performer_ids = performerIds.map(String);
  // Undefined leaves the studio alone; null clears it.
  if (studioId !== undefined) input.studio_id = studioId === null ? null : String(studioId);

  const data = await gql(
    config,
    `mutation($i: GalleryUpdateInput!) {
       galleryUpdate(input: $i) {
         id
         studio { id name }
         performers { id name }
         scenes { id title }
       }
     }`,
    { i: input }
  );

  return data.galleryUpdate;
}

/*
 * Where one gallery's pictures live, as Stash sees it. Asked for on its own
 * because adding a picture needs the folder and nothing else about the
 * gallery, and galleryView() reads its images and scenes to answer.
 */
export async function folderOf(config, id) {
  const data = await gql(
    config,
    'query($id: ID!) { findGallery(id: $id) { id title folder { path } files { path } } }',
    { id }
  );

  const gallery = data.findGallery;
  if (!gallery) throw new Error('Stash has no gallery with that id.');

  // A gallery made from a folder has one; a gallery made from a zip has files
  // instead, and there is nowhere to put a new picture inside a zip.
  const folder = gallery.folder?.path || null;
  return { id: gallery.id, title: gallery.title || null, folder, zipped: !folder && Boolean(gallery.files?.length) };
}

/*
 * Taking pictures out of a gallery.
 *
 * The files go with them, and that is the only honest option: leave a picture
 * on disk and the next scan of that folder puts it straight back, so a
 * record-only delete would undo itself the way a record-only gallery delete
 * would. The caller asks for it by name all the same.
 */
export async function removeImages(config, ids, { files = false } = {}) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!list.length) throw new Error('Pick at least one picture.');

  const data = await gql(
    config,
    'mutation($ids: [ID!]!, $f: Boolean) { imagesDestroy(input: {ids: $ids, delete_file: $f, delete_generated: true}) }',
    { ids: list, f: Boolean(files) }
  );

  return { deleted: Boolean(data.imagesDestroy), count: list.length, files: Boolean(files) };
}

/*
 * Deleting one.
 *
 * The files go with it unless told otherwise, and that is not overcaution the
 * other way: leaving the folder behind means Stash makes the gallery again on
 * its next scan, so a record-only delete quietly undoes itself. The caller
 * still has to ask for the files by name.
 */
export async function destroy(config, id, { files = false } = {}) {
  const data = await gql(
    config,
    `mutation($ids: [ID!]!, $f: Boolean) {
       galleryDestroy(input: {ids: $ids, delete_file: $f, delete_generated: true})
     }`,
    { ids: [String(id)], f: Boolean(files) }
  );

  return { deleted: Boolean(data.galleryDestroy), files: Boolean(files) };
}

export async function setRating(config, id, rating) {
  const data = await gql(
    config,
    'mutation($id: ID!, $r: Int) { galleryUpdate(input: {id: $id, rating100: $r}) { id rating100 } }',
    { id, r: rating === null ? null : Math.max(0, Math.min(100, Number(rating))) }
  );
  return data.galleryUpdate;
}

/*
 * Who has nothing to look at.
 *
 * Every other page in this half ends with a thin row of what you do not have;
 * this is that row for pictures. Everyone you hold films of whose name is on
 * no gallery, ordered by how much of them you hold — the person you have
 * twenty scenes of is the one worth a photo set, and their own page already
 * carries the button that builds it.
 *
 * Counted from the galleries themselves rather than from a performer's
 * gallery_count, for the same reason the rest of this half counts what is in
 * the library rather than what Stash has a record of.
 */
export async function withoutPictures(config, { limit = 60 } = {}) {
  const [people, mine] = await Promise.all([performersView(config), find(config, {})]);

  const covered = new Set();
  for (const gallery of mine.galleries) {
    for (const person of gallery.performers) covered.add(person.id);
  }

  const bare = people.held.filter((person) => !covered.has(person.id));

  return { count: bare.length, covered: covered.size, performers: bare.slice(0, limit) };
}
