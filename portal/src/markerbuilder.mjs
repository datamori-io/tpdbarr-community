/*
 * Marker Builder: cutting markers by hand.
 *
 * The timestampTrade and TPDBMarkers plugins rewrite any marker within 15
 * seconds of one they import, including hand-cut ones. Mark first, run the
 * plugins after, or not at all.
 *
 * This module owns the queue, the tag list and the three writes. New markers
 * get a clip on the next markerclips pass.
 */

import { gql } from './stash.mjs';
import { findScenes } from './stashlib.mjs';
import { remove as dropClips } from './markerclips.mjs';

/*
 * Pinned first; then the library's marker tags, most used. A seed Stash
 * doesn't have yet is created on first use (see `resolveTag`).
 */
export const SEEDS = ['Kissing', 'Orgasm', 'Undressing'];

// ------------------------------------------------------------------- shapes

const MARKER = `
  id title seconds end_seconds
  primary_tag { id name }
`;

const marker = (m) => ({
  id: m.id,
  // A marker's own title is usually empty and its tag is the useful name —
  // the same rule the reel and the scene page read them by.
  title: m.title || '',
  tag: m.primary_tag ? { id: m.primary_tag.id, name: m.primary_tag.name } : null,
  seconds: Number(m.seconds) || 0,
  // Stash stores 0 for "no end", which is a real time and would draw a span
  // from the start of the scene to the marker. Null is the honest answer.
  end: Number(m.end_seconds) > Number(m.seconds) ? Number(m.end_seconds) : null,
});

const byTime = (a, b) => a.seconds - b.seconds || (a.end || 0) - (b.end || 0);

/* Times rounded to tenths on the way in. */
const tenths = (n) => Math.max(0, Math.round((Number(n) || 0) * 10) / 10);

// -------------------------------------------------------------------- queue

/*
 * Only /organized_scenes: earlier files are re-encoded and moved by FileFlows.
 * Narrower than stashlib's FILED (no /movies). One INCLUDES, not an OR: a
 * top-level OR would undo the has_markers half.
 */
const ORGANIZED = { path: { value: '/organized_scenes/', modifier: 'INCLUDES' } };

// The same folder as a plain string, for the check the bench makes on one
// scene rather than the filter the queue makes on all of them.
const ORGANIZED_PATH = '/organized_scenes/';

const filed = (scene) => (scene.files || []).some((f) => String(f?.path || '').includes(ORGANIZED_PATH));

/* A deliberate refusal with a status, not a logged 500. */
function refuse(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/*
 * Which scenes to work on. `unmarked` (default) is the backlog; `marked` is
 * for correcting. All within the filed folder.
 */
export async function queue(config, { q = '', mode = 'unmarked', page = 1, limit = 60 } = {}) {
  const wanted = ['unmarked', 'marked', 'all'].includes(mode) ? mode : 'unmarked';

  const filter = {
    ...ORGANIZED,
    ...(wanted === 'all' ? {} : { has_markers: wanted === 'marked' ? 'true' : 'false' }),
  };

  const term = String(q || '').trim();

  const { count, scenes } = await findScenes(config, {
    filter,
    // A search sorts by how well it matched; a browse sorts newest first.
    sort: term ? 'title' : 'date',
    page,
    limit,
    q: term || null,
    // Scope is defined above, not inherited from the shared (empty) one.
    scoped: false,
  });

  return { mode: wanted, q: term, page, count, scenes };
}

/*
 * The whole queue as two id lists; the page joins them to the shelf it
 * already has. `marked` carries a count per scene.
 */
export async function queued(config) {
  const filedIds = async () => {
    const data = await gql(
      config,
      `query($f: SceneFilterType) {
         findScenes(scene_filter: $f, filter: {per_page: -1}) { scenes { id } }
       }`,
      { f: ORGANIZED }
    );
    return (data.findScenes?.scenes || []).map((s) => String(s.id));
  };

  /* Only marked scenes are asked for their markers. */
  const markedIds = async () => {
    const data = await gql(
      config,
      `query($f: SceneFilterType) {
         findScenes(scene_filter: $f, filter: {per_page: -1}) {
           scenes { id scene_markers { id } }
         }
       }`,
      { f: { ...ORGANIZED, has_markers: 'true' } }
    );
    return (data.findScenes?.scenes || [])
      .map((s) => [String(s.id), (s.scene_markers || []).length]);
  };

  const [filed, marked] = await Promise.all([filedIds(), markedIds()]);
  return { filed, marked };
}

// ------------------------------------------------------------- what is cut

/*
 * Every marker in the library, for the management list. Not limited to
 * filed scenes, so plugin markers anywhere can be fixed; each row says
 * whether the bench will open it. `q` searches marker and scene titles, not
 * tag names — use the tag filter.
 */

const LISTED = `
  id title seconds end_seconds
  primary_tag { id name }
  scene {
    id title date
    studio { id name }
    files { path }
  }
`;

const SORTS = ['created_at', 'updated_at', 'title', 'seconds', 'scene_id'];

export async function all(config, { q = '', tag = null, sort = 'created_at', direction = '', page = 1, limit = 60 } = {}) {
  const term = String(q || '').trim();
  const by = SORTS.includes(sort) ? sort : 'created_at';

  // Newest first is the only sort whose useful direction is descending: a list
  // of titles or of timestamps reads forwards.
  const way = direction || (by === 'created_at' || by === 'updated_at' ? 'DESC' : 'ASC');

  const data = await gql(
    config,
    `query($f: SceneMarkerFilterType, $p: FindFilterType) {
       findSceneMarkers(scene_marker_filter: $f, filter: $p) {
         count
         scene_markers { ${LISTED} }
       }
     }`,
    {
      f: tag ? { tags: { value: [String(tag)], modifier: 'INCLUDES' } } : {},
      p: {
        per_page: Math.min(200, Math.max(1, Number(limit) || 60)),
        page: Math.max(1, Number(page) || 1),
        sort: by,
        direction: way,
        ...(term ? { q: term } : {}),
      },
    }
  );

  const found = data.findSceneMarkers || { count: 0, scene_markers: [] };

  return {
    q: term,
    tag: tag ? String(tag) : null,
    sort: by,
    direction: way,
    page: Math.max(1, Number(page) || 1),
    count: found.count || 0,
    markers: (found.scene_markers || []).map((m) => ({
      ...marker(m),
      scene: m.scene
        ? {
            id: m.scene.id,
            title: m.scene.title || (m.scene.files?.[0]?.path || '').split('/').pop() || `Scene ${m.scene.id}`,
            date: m.scene.date || null,
            studio: m.scene.studio ? { id: m.scene.studio.id, name: m.scene.studio.name } : null,
            // Whether the bench will open it. Anything can still be retagged, retimed or deleted.
            filed: filed(m.scene),
          }
        : null,
    })),
  };
}

// --------------------------------------------------------------------- tags

/* Tags already used on a marker, plus the seeds (`id: null` if Stash lacks them). */
export async function tags(config) {
  const data = await gql(
    config,
    /*
     * The filter field is `marker_count`; the output field on a Tag is
     * `scene_marker_count`. Mixing them up is an unhelpful 422.
     */
    `{ findTags(
         filter: {per_page: -1, sort: "name", direction: ASC}
         tag_filter: {marker_count: {value: 0, modifier: GREATER_THAN}}
       ) { tags { id name scene_marker_count } } }`
  );

  const used = (data.findTags?.tags || [])
    .map((t) => ({ id: t.id, name: t.name, count: t.scene_marker_count || 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const seeded = SEEDS.map((name) => {
    const hit = used.find((t) => t.name.toLowerCase() === name.toLowerCase());
    return hit || { id: null, name, count: 0 };
  });

  const rest = used.filter((t) => !SEEDS.some((name) => name.toLowerCase() === t.name.toLowerCase()));

  return { seeds: SEEDS, tags: [...seeded, ...rest] };
}

/* Every tag, for one never used on a marker. Separate from the palette. */
export async function searchTags(config, term = '') {
  const text = String(term || '').trim();
  if (!text) return { tags: [] };

  const data = await gql(
    config,
    `query($f: TagFilterType) {
       findTags(tag_filter: $f, filter: {per_page: 25, sort: "name", direction: ASC}) {
         tags { id name scene_marker_count scene_count }
       }
     }`,
    { f: { name: { value: text, modifier: 'INCLUDES' } } }
  );

  return {
    tags: (data.findTags?.tags || []).map((t) => ({
      id: t.id,
      name: t.name,
      count: t.scene_marker_count || 0,
      scenes: t.scene_count || 0,
    })),
  };
}

/*
 * A tag id from an id or a name, creating one only as a last resort.
 * Names are squeezed to single spaces and trimmed, and matched
 * case-insensitively first, so "kissing" finds Kissing.
 */
async function resolveTag(config, { tagId = null, tagName = '' } = {}) {
  if (tagId) return String(tagId);

  const name = String(tagName || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A marker needs a tag.');

  const found = await gql(
    config,
    `query($n: String!) {
       findTags(tag_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 10}) { tags { id name } }
     }`,
    { n: name }
  ).catch(() => null);

  const hit = (found?.findTags?.tags || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;

  const made = await gql(
    config,
    `mutation($input: TagCreateInput!) { tagCreate(input: $input) { id name } }`,
    { input: { name } }
  );

  return made.tagCreate.id;
}

// ------------------------------------------------------------------- editor

const EDIT = `
  id title date
  files { path duration width height }
  paths { sprite vtt screenshot }
  studio { id name }
  scene_markers { ${MARKER} }
`;

/* One scene as the bench needs it: video, length, sprite sheet, markers. */
export async function editor(config, id) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${EDIT} } }`, { id: String(id) });
  const scene = data.findScene;
  if (!scene) throw refuse(404, 'Stash has no scene with that id.');

  /* Refuse scenes outside the filed folder, even by direct address. */
  if (!filed(scene)) {
    throw refuse(400, 'That scene is not filed yet. The Marker Builder only works on /organized_scenes — mark it once it has come out of FileFlows.');
  }

  const file = scene.files?.[0] || null;

  return {
    scene: {
      id: scene.id,
      title: scene.title || (file?.path ? file.path.split('/').pop() : `Scene ${scene.id}`),
      date: scene.date || null,
      studio: scene.studio ? { id: scene.studio.id, name: scene.studio.name } : null,
      // No duration: the timeline appears once the video reports one.
      duration: file?.duration ? Math.round(file.duration) : 0,
      width: file?.width || null,
      height: file?.height || null,
      /*
       * Sprite and vtt paths use the file hash; the page asks the portal by scene
       * id. This flag only says whether a sheet exists.
       */
      vtt: !!scene.paths?.vtt,
    },
    markers: (scene.scene_markers || []).map(marker).sort(byTime),
  };
}

// ------------------------------------------------------------------- writes

/* One marker. `end` only when after the start; the page sorts in/out first. */
export async function create(config, { sceneId, seconds, end = null, tagId = null, tagName = '', title = '' } = {}) {
  if (!sceneId) throw new Error('A marker needs a scene.');

  const at = tenths(seconds);
  const out = end == null ? null : tenths(end);
  const primary = await resolveTag(config, { tagId, tagName });

  const input = {
    scene_id: String(sceneId),
    seconds: at,
    primary_tag_id: primary,
    /*
     * Empty title: Stash shows the tag. Plugins sign theirs ([Timestamp],
     * [TsTrade], [TPDBMarker]), which is how hand-cut ones differ.
     */
    title: String(title || ''),
  };

  if (out != null && out > at) input.end_seconds = out;

  const data = await gql(
    config,
    `mutation($input: SceneMarkerCreateInput!) { sceneMarkerCreate(input: $input) { ${MARKER} } }`,
    { input }
  );

  return { marker: marker(data.sceneMarkerCreate) };
}

/* Change one. Only what's passed is touched. */
export async function update(config, id, { seconds = null, end = undefined, tagId = null, tagName = '', title = null } = {}) {
  if (!id) throw new Error('Which marker?');

  const input = { id: String(id) };

  if (seconds != null) input.seconds = tenths(seconds);

  /* `undefined` leaves `end` alone; null clears it. */
  if (end !== undefined) input.end_seconds = end == null ? null : tenths(end);

  if (tagId || tagName) input.primary_tag_id = await resolveTag(config, { tagId, tagName });
  if (title != null) input.title = String(title);

  const data = await gql(
    config,
    `mutation($input: SceneMarkerUpdateInput!) { sceneMarkerUpdate(input: $input) { ${MARKER} } }`,
    { input }
  );

  /*
   * Retimed: delete its rendered clip so the next pass re-cuts it (the pass
   * skips markers that have one). Best effort.
   */
  if ('seconds' in input || 'end_seconds' in input) {
    await dropClips([String(id)]).catch(() => {});
  }

  return { marker: marker(data.sceneMarkerUpdate) };
}

/* Remove one. Its clip is left; scene deletion sweeps orphans. */
export async function destroy(config, id) {
  if (!id) throw new Error('Which marker?');
  await gql(config, `mutation($id: ID!) { sceneMarkerDestroy(id: $id) }`, { id: String(id) });
  return { removed: String(id) };
}
