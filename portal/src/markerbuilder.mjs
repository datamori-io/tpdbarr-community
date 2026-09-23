/*
 * Marker Builder — cutting markers by hand.
 *
 * Everything else that puts markers in this library is a plugin run by hand
 * and left to its own judgement: timestampTrade first, TPDBMarkers second and
 * only into scenes that have none. Both import within fifteen seconds of an
 * existing marker and *rewrite it in place* rather than skipping it, which is
 * how 156 timestamp.trade markers were retimed and retitled in one pass. So a
 * marker made here is a marker a plugin can still overwrite — the order rule
 * does not stop applying because a human made this one. Mark first, run the
 * plugins after, or not at all.
 *
 * What this module owns is small: the queue of scenes worth marking, the tags
 * a marker can wear, and the three writes. The judgement is all on the page —
 * this end never guesses a tag or a time.
 *
 * A new marker gets a rendered clip on the next markerclips pass, which is
 * already an idle job (see server.mjs) — nothing here has to ask for one.
 */

import { gql } from './stash.mjs';
import { findScenes } from './stashlib.mjs';
import { remove as dropClips } from './markerclips.mjs';

/*
 * The tags offered first, before anything the library can tell us.
 *
 * They are the author's three, and they are pinned rather than ranked because a
 * ranking is only useful once there is something to rank — on a scene-by-scene
 * workbench the same handful is wanted every time, and hunting for them in a
 * list sorted by a count that changes underneath you is the thing that makes a
 * keyboard workflow stop being one. Anything else the library actually uses
 * follows them, most-used first.
 *
 * A seed that does not exist as a Stash tag yet still shows. It is created the
 * first time it is used, and not before — see `resolveTag`.
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

/*
 * Stash keeps times as floats and the page works in tenths — a marker placed
 * on a frame is not usefully more precise than that, and a raw float in the
 * list reads as noise. Rounded on the way in, so what is stored is what was
 * shown when it was placed.
 */
const tenths = (n) => Math.max(0, Math.round((Number(n) || 0) * 10) / 10);

// -------------------------------------------------------------------- queue

/*
 * Only what is filed.
 *
 * Marking is work you do once and keep, so it is only worth doing on a scene
 * that has stopped moving. Everything upstream of /organized_scenes is still
 * going through FileFlows — it gets re-encoded and moved, and the file the
 * marks were placed against is not the file that comes out the other end.
 *
 * Narrower than stashlib's own FILED, which is organized_scenes *or* /movies.
 * Films are Emby's, not Stash's, and are not what this bench is for.
 *
 * Written as a single INCLUDES rather than as a criterion joined to the marker
 * one by OR: Stash reads a top-level OR as OR-ing against everything beside
 * it, which would quietly undo the has_markers half.
 */
const ORGANIZED = { path: { value: '/organized_scenes/', modifier: 'INCLUDES' } };

// The same folder as a plain string, for the check the bench makes on one
// scene rather than the filter the queue makes on all of them.
const ORGANIZED_PATH = '/organized_scenes/';

const filed = (scene) => (scene.files || []).some((f) => String(f?.path || '').includes(ORGANIZED_PATH));

/*
 * A refusal the server means, rather than a crash. Anything without a status
 * gets logged as a fault and answered 500; these are neither.
 */
function refuse(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/*
 * Which scenes to work on.
 *
 * `unmarked` is the default because it is the only one of the three that is a
 * queue rather than a browse — a scene with no markers is work outstanding,
 * and the count of them is the honest size of the backlog. `marked` is for
 * going back to something, and exists because half of what is in this library
 * was marked by a plugin and some of that is worth correcting by hand.
 *
 * All three are inside the filed folder. "Everything" means every filed scene,
 * not every scene in Stash.
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
    // The scope this page wants is its own and is above, in full. The shared
    // one is empty today, so inheriting it would silently widen this back out
    // to the whole of Stash the day somebody fills it in.
    scoped: false,
  });

  return { mode: wanted, q: term, page, count, scenes };
}

/*
 * The same queue, whole and lean.
 *
 * queue() above answers a page at a time, which is what a list of rows wants.
 * The picker is a shelf now — dropdowns that count what is behind them, a
 * search that narrows as you type, a sort that reorders everything rather than
 * the sixty rows on screen — and none of that can be done a page at a time.
 *
 * It does not send the scenes. The page already holds every scene in the
 * library, memoised, because the library's own shelf fetched them; all it is
 * missing is which of them this bench will accept and which have been marked
 * already. So this sends two lists of ids and the page joins them to what it
 * has, which is 3,000 short strings rather than a second copy of the library.
 *
 * `marked` carries a count as well as an id, because "has markers" and "has
 * eleven markers" are different answers to whether a scene still needs work.
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

  /*
   * Only the marked ones carry their markers, and there are 451 of those
   * against 2,800 filed. Asking every scene for a list it mostly has none of
   * is the same query an order of magnitude more expensive.
   */
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
 * Every marker in the library, asked of the markers rather than of the scenes.
 *
 * The queue above answers "which scene should I mark", which is the question
 * you ask before doing the work. This is the one you ask afterwards — what did
 * I mark, what did the plugins mark, where is the one I got wrong. Neither can
 * be answered from the other: a scene-shaped list can tell you a scene has
 * eleven markers and cannot tell you that three of them say Orgasm at the same
 * second, and there is no page in Stash's own UI that will either.
 *
 * Scope is deliberately everything rather than the filed folder the bench
 * works in. Half of what is in this library was written by timestampTrade and
 * TPDBMarkers, some of it into scenes that never reached /organized_scenes,
 * and a marker you cannot see is a marker you cannot delete. Each row says
 * whether the bench will open its scene, which is the honest version of the
 * same rule — see `filed` above.
 *
 * `q` is Stash's own marker search, which reads the marker's title and its
 * scene's title. It does not read tag names, and that is not worth working
 * around here: a hand-cut marker has no title at all and is found by its tag,
 * which is what the tag filter beside the box is for.
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
            // Whether the bench will open it. Anything else can still be
            // retagged, retimed and deleted from the list — it is only the
            // timeline that insists on a file that has stopped moving.
            filed: filed(m.scene),
          }
        : null,
    })),
  };
}

// --------------------------------------------------------------------- tags

/*
 * The tags a marker can wear.
 *
 * Only ones already used on a marker somewhere, because the whole list is 985
 * tags and almost none of them describe a moment — "1080p" and "Blonde" are
 * scene tags and would bury the dozen that are not. The seeds are merged in
 * whether or not the library has reached for them yet, and carry `id: null`
 * when Stash has never heard of them.
 */
export async function tags(config) {
  const data = await gql(
    config,
    /*
     * The two names are not the same name, and getting that wrong is a 422
     * with nothing in it that says which half is wrong: the *filter* field is
     * `marker_count` and the *output* field on a Tag is `scene_marker_count`.
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

/*
 * Every tag, for the moment you want one that has never been on a marker
 * before. Separate from the list above on purpose: that one is the palette,
 * this is the search behind it, and mixing them would put 985 scene tags in
 * front of the three you actually reach for.
 */
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
 * A tag id from either an id or a name, creating one only as a last resort.
 *
 * The batch tagger deliberately refuses to create tags at all, because a page
 * that lets you type into a batch write is a page that grows a second tag
 * called "Anal " with a trailing space. This page was asked for the opposite —
 * premade or create my own — so it creates, and pays for that with the two
 * guards that make the refusal unnecessary: the name is squeezed to single
 * spaces and trimmed, and an existing tag is matched case-insensitively before
 * anything is made. "kissing" typed in a hurry finds Kissing.
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

/*
 * One scene, as the workbench needs it — which is much less than the scene
 * page asks for. No related rails, no cast photographs, no identity: this is a
 * video, a length to lay a timeline against, the sprite sheet to draw it with,
 * and what is already marked.
 */
export async function editor(config, id) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${EDIT} } }`, { id: String(id) });
  const scene = data.findScene;
  if (!scene) throw refuse(404, 'Stash has no scene with that id.');

  /*
   * The same rule the queue filters by, applied to the one scene an address
   * asks for. Without it the folder only decided what was *offered* and a link
   * could still open the bench on something still moving through FileFlows —
   * which is the case the scope exists to prevent, since the file those marks
   * were placed against is not the file that comes out the other end.
   */
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
      // The timeline is laid out against this before the video has loaded
      // anything, so a scene whose file has no duration gets a timeline that
      // only appears once the video says how long it is.
      duration: file?.duration ? Math.round(file.duration) : 0,
      width: file?.width || null,
      height: file?.height || null,
      /*
       * Sprite and vtt are named after the file hash rather than the scene id,
       * so they cannot be constructed here — but the page asks the portal for
       * them by scene id anyway, because the vtt Stash serves points at Stash
       * and the proxied one has been pointed back at the portal. This flag is
       * only whether there is a sheet to ask for at all: no sprites means a
       * timeline with no pictures on it, which still works.
       */
      vtt: !!scene.paths?.vtt,
    },
    markers: (scene.scene_markers || []).map(marker).sort(byTime),
  };
}

// ------------------------------------------------------------------- writes

/*
 * One marker.
 *
 * `end` is only sent when it is genuinely after the start. A span whose out
 * point landed before its in point is a mis-press, and the useful reading of
 * it is a point marker at the earlier time rather than an error — but it is
 * not this end's job to decide that, so the page sorts the two before it asks
 * and this only refuses what is still wrong.
 */
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
     * Empty on purpose. Stash shows the primary tag wherever a marker has no
     * title of its own, so a title repeating the tag is a second copy of the
     * same fact that then has to be kept in step with it. The plugins write
     * their provenance in here — [Timestamp], [TsTrade], [TPDBMarker] — and a
     * hand-cut marker having none is what distinguishes it from theirs.
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

/*
 * Change one. Only what is passed is touched, so retagging does not move a
 * marker and nudging a time does not retag it.
 */
export async function update(config, id, { seconds = null, end = undefined, tagId = null, tagName = '', title = null } = {}) {
  if (!id) throw new Error('Which marker?');

  const input = { id: String(id) };

  if (seconds != null) input.seconds = tenths(seconds);

  /*
   * `undefined` means leave it alone; null means clear it. They are different
   * answers and a span being turned back into a point is a real edit, so this
   * is the one field where the difference has to survive the round trip.
   */
  if (end !== undefined) input.end_seconds = end == null ? null : tenths(end);

  if (tagId || tagName) input.primary_tag_id = await resolveTag(config, { tagId, tagName });
  if (title != null) input.title = String(title);

  const data = await gql(
    config,
    `mutation($input: SceneMarkerUpdateInput!) { sceneMarkerUpdate(input: $input) { ${MARKER} } }`,
    { input }
  );

  /*
   * A marker that moved has a rendered clip of the wrong few seconds.
   *
   * The clips pass names its files after the marker id and skips any marker
   * that already has one, so a retimed marker would keep the clip cut for
   * where it used to be — for good, since nothing would ever re-cut it. The
   * file goes, and the next pass makes a new one.
   *
   * Only when the time actually changed. Retagging does not move the window,
   * and throwing away a minute of x264 to change a word would be a poor trade.
   * Best effort: a clip that cannot be deleted is not a reason to fail a write
   * that has already happened.
   */
  if ('seconds' in input || 'end_seconds' in input) {
    await dropClips([String(id)]).catch(() => {});
  }

  return { marker: marker(data.sceneMarkerUpdate) };
}

/*
 * Remove one. The rendered clip that goes with it is left where it is: the
 * markerclips pass names its files after the marker id, and the scene-delete
 * path is what sweeps orphans up. A clip for a marker that no longer exists
 * costs 7MB and nothing else asks for it.
 */
export async function destroy(config, id) {
  if (!id) throw new Error('Which marker?');
  await gql(config, `mutation($id: ID!) { sceneMarkerDestroy(id: $id) }`, { id: String(id) });
  return { removed: String(id) };
}
