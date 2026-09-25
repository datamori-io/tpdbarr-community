/*
 * The library spine, keyed on the Stash scene id. Stash is the library of
 * record; TPDB and StashDB ids hang off a scene.
 */

import { gql } from './stash.mjs';
import * as stashdb from './stashdb.mjs';
import { rememberPaths } from './media.mjs';
import { iafdUrlOf, lookup as iafdLookup, proposal as iafdProposal } from './iafd.mjs';
import * as studiofacts from './studiofacts.mjs';
import { targetOf, warm as warmTargets } from './resolution.mjs';

const CARD = `
  id title details date organized rating100 o_counter play_count resume_time created_at
  studio { id name }
  performers { id name favorite }
  files { duration width height path }
`;

const DETAIL = `
  id title details date organized rating100 o_counter play_count play_duration
  resume_time last_played_at created_at urls
  paths { screenshot preview stream sprite vtt }
  studio { id name }
  performers { id name favorite gender birthdate country image_path }
  tags { id name }
  stash_ids { endpoint stash_id }
  scene_markers { id title seconds primary_tag { id name } }
  files { id path size duration width height video_codec audio_codec frame_rate bit_rate }
`;

const RAIL_TTL = 5 * 60 * 1000;
const RAIL_SIZE = 24;

let railCache = null;
export const forgetRails = () => { railCache = null; indexCache = null; shelfCache = null; };

// ------------------------------------------------------------------ shaping

const today = () => new Date().toISOString().slice(0, 10);

// An unidentified scene has no title at all, so the filename is what is left.
function basename(path) {
  if (!path) return null;
  const name = String(path).split(/[\\/]/).pop() || '';
  return name.replace(/\.[a-z0-9]{2,4}$/i, '') || null;
}

function resolution(height) {
  if (!height) return null;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  return height + 'p';
}

/* Headset (VR) footage, which the browser loads but can't play. */
/*
 * Mostly by studio name (every VR studio here says VR). Shape is only a
 * backstop: 4K at 4096x2160 (1.9) is too close to VR's 4096x2048 (2.0).
 */
const IMMERSIVE_WIDTH = 3000;
const IMMERSIVE_MIN = 1.98;
const IMMERSIVE_MAX = 2.1;

export function immersive(file, studio) {
  if (/vr/i.test(String(studio || ''))) return true;

  const width = file?.width || 0;
  const height = file?.height || 0;
  if (!width || !height) return false;

  /* A band, not a floor: 2.35:1 scope films must not be caught. */
  const aspect = width / height;
  return width >= IMMERSIVE_WIDTH && aspect >= IMMERSIVE_MIN && aspect <= IMMERSIVE_MAX;
}

export function card(scene) {
  const file = scene.files?.[0] || null;
  const duration = file?.duration ? Math.round(file.duration) : null;
  const resume = Math.round(scene.resume_time || 0);

  return {
    id: scene.id,
    title: scene.title || basename(file?.path) || `Scene ${scene.id}`,
    // Worth showing: an untitled scene is one Stash never identified.
    untitled: !scene.title,
    date: scene.date || null,
    /* Trimmed here: the shelf read is the whole library, and tiles show two lines. */
    details: String(scene.details || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    studio: scene.studio ? { id: scene.studio.id, name: scene.studio.name } : null,
    performers: (scene.performers || []).map((p) => ({ id: p.id, name: p.name, favorite: !!p.favorite })),
    duration,
    resolution: resolution(file?.height),
    // The height it is and the height it is meant to end up at, for the colour
    // on the tile. See targetOf in resolution.mjs.
    height: file?.height || 0,
    // Which folder it is in, drawn under the tile's studio and date.
    path: file?.path || null,
    target: targetOf(scene.id, file?.height || 0, file?.path),
    organized: !!scene.organized,
    // Where it is in the pipeline, read off the path rather than the
    // `organized` flag — the folder is what FileFlows actually moves. See STAGES.
    stage: stageOf((scene.files || []).map((f) => f.path)),
    // Shot for a headset. The reel leaves these alone; the rest of the app
    // still lists them, because a page you choose to open is not a reel.
    immersive: immersive(file, scene.studio?.name),
    /* When Stash first saw it, not the release date. For "what's new to me". */
    addedAt: scene.created_at || null,
    rating: scene.rating100 ?? null,
    oCount: scene.o_counter || 0,
    plays: scene.play_count || 0,
    resume,
    // The bar across the bottom of the card.
    progress: duration && resume ? Math.min(1, resume / duration) : 0,
  };
}

// -------------------------------------------------------------------- reads

export async function findScenes(config, { filter = {}, sort = 'date', direction = 'DESC', page = 1, limit = RAIL_SIZE, q = null, scoped = true } = {}) {
  const data = await gql(
    config,
    `query($f: SceneFilterType, $p: FindFilterType) {
       findScenes(scene_filter: $f, filter: $p) { count scenes { ${CARD} } }
     }`,
    // Browsing never leaves the library folder; the pending list opts out.
    { f: scoped ? { ...filter, ...inLibrary } : filter, p: { per_page: limit, page, sort, direction, ...(q ? { q } : {}) } }
  );
  return { count: data.findScenes.count, scenes: data.findScenes.scenes.map(card) };
}

/*
 * Your scenes Stash credits to a director (its own `director` field).
 * Seeds a filmography crawl, since StashDB can't search by director.
 * See crawlDirector in categories.mjs.
 */
export async function scenesDirectedBy(config, name) {
  const data = await gql(
    config,
    `query($d: String!) { findScenes(
       scene_filter: { director: { value: $d, modifier: INCLUDES } },
       filter: { per_page: -1 }) {
       scenes { id stash_ids { endpoint stash_id } }
     } }`,
    { d: name }
  );
  return data.findScenes.scenes || [];
}

/*
 * Tracked StashDB ids -> Stash ids, via `stash_ids`. Falls back to the name,
 * because many performers were only identified against TPDB.
 */
async function trackedStashIds(config, kind) {
  const entries = (kind === 'performer' ? config.tracked?.performers : config.tracked?.studios) || [];
  if (!entries.length) return [];

  const wantIds = new Set(entries.map((e) => String(e.id || '').toLowerCase()).filter(Boolean));
  const wantNames = new Set(entries.map((e) => String(e.name || '').trim().toLowerCase()).filter(Boolean));

  const [data, endpoint] = await Promise.all([
    kind === 'performer'
      ? gql(config, '{ findPerformers(filter: {per_page: -1}) { performers { id name stash_ids { endpoint stash_id } } } }')
      : gql(config, '{ findStudios(filter: {per_page: -1}) { studios { id name stash_ids { endpoint stash_id } } } }'),
    stashdb.endpointFor(config).catch(() => null),
  ]);

  const rows = (kind === 'performer' ? data.findPerformers?.performers : data.findStudios?.studios) || [];

  return rows
    .filter((row) => {
      const id = stashdb.idAt(row.stash_ids, endpoint);
      if (id && wantIds.has(String(id).toLowerCase())) return true;
      return wantNames.has(String(row.name || '').trim().toLowerCase());
    })
    .map((row) => row.id);
}

export async function rails(config, { force = false } = {}) {
  if (!force && railCache && Date.now() - railCache.at < RAIL_TTL) return railCache.rails;

  /* Only what you track, and only what you hold. */
  const [trackedPerformers, trackedStudios] = await Promise.all([
    trackedStashIds(config, 'performer').catch(() => []),
    trackedStashIds(config, 'studio').catch(() => []),
  ]);

  const wanted = [
    {
      key: 'continue',
      title: 'Continue watching',
      note: 'where you stopped',
      href: '#/library/list/continue',
      query: { filter: { resume_time: { value: 1, modifier: 'GREATER_THAN' } }, sort: 'last_played_at' },
    },
    {
      key: 'recent',
      title: 'New scenes added',
      note: 'newest into the library',
      href: '#/library/list/recent',
      query: { sort: 'created_at' },
    },
    {
      key: 'released',
      title: 'Recently released',
      note: 'by the date on the scene, not the date it landed',
      href: '#/library/list/released',
      // Scenes dated in the future are announcements, not files you can play.
      query: { filter: { date: { value: today(), modifier: 'LESS_THAN' } }, sort: 'date' },
    },
    /* INCLUDES, not INCLUDES_ALL: any one tracked performer qualifies. */
    trackedPerformers.length ? {
      key: 'tracked-performers',
      title: 'New from your performers',
      note: `imported, from the ${trackedPerformers.length} you track`,
      href: '#/library/performers',
      query: {
        filter: { performers: { value: trackedPerformers, modifier: 'INCLUDES' } },
        sort: 'created_at',
      },
    } : null,
    trackedStudios.length ? {
      key: 'tracked-studios',
      title: 'New from your studios',
      note: `imported, from the ${trackedStudios.length} you track`,
      href: '#/library/studios',
      query: {
        filter: { studios: { value: trackedStudios, modifier: 'INCLUDES' } },
        sort: 'created_at',
      },
    } : null,
  ].filter(Boolean);

  const built = await Promise.all(
    wanted.map(async (rail) => {
      try {
        const { count, scenes } = await findScenes(config, rail.query);
        return { key: rail.key, title: rail.title, note: rail.note || null, href: rail.href || null, count, scenes };
      } catch (err) {
        return { key: rail.key, title: rail.title, error: err.message, scenes: [] };
      }
    })
  );

  const kept = built.filter((r) => r.scenes.length);

  /* Don't cache a total miss: it means Stash wasn't up yet. */
  if (kept.length) railCache = { rails: kept, at: Date.now() };
  return kept;
}

/*
 * ------------------------------------------------------------ the stages
 *
 * The folder is a status, not ownership. Everything in Stash is yours:
 *
 *   Whisparr /data/scenes  grabbed, not encoded — Stash can't see it
 *   /pc-import             being edited by hand
 *   /Import Folder         waiting on the encoder
 *   /organized_scenes      filed
 *   /movies                feature films, via Emby
 *
 * A scene with files under two roots counts at the furthest along.
 * The first stage is counted on the Whisparr side, in tidy.mjs.
 */

export const STAGES = [
  { key: 'library', path: '/organized_scenes/', label: 'Filed' },
  { key: 'film', path: '/movies/', label: 'Film' },
  { key: 'encoding', path: '/Import Folder/', label: 'Encoding' },
  { key: 'editing', path: '/pc-import/', label: 'Editing' },
];

// Furthest-along wins, so a scene with a copy in two folders reads as the
// later one — it has already moved, the old copy just has not been swept.
export function stageOf(paths) {
  for (const stage of STAGES) {
    if (paths.some((p) => String(p || '').includes(stage.path))) return stage.key;
  }
  return null;
}

/*
 * "In my library" is everything. Kept as a constant for a future scope.
 *
 * If a scope returns, nest it under one `AND`: Stash ORs a top-level `OR`
 * against everything beside it.
 */
const inLibrary = {};

// Scenes that have not reached /organized_scenes or /movies yet — still being
// edited or still queued for the encoder. A status rail, not an exclusion.
const stillMoving = {
  path: { value: '/organized_scenes/', modifier: 'EXCLUDES' },
  AND: { path: { value: '/movies/', modifier: 'EXCLUDES' } },
};

/*
 * Scenes whose furthest-along file is in this stage.
 *
 * Not a path filter: Stash matches `path` per file, so a scene with a second
 * copy elsewhere slips through. The folder narrows, `stageOf` decides —
 * the same function the bar counts with.
 */
async function stageScenes(config, key) {
  const stage = STAGES.find((s) => s.key === key);
  if (!stage) throw new Error(`No such stage: ${key}`);

  const data = await gql(
    config,
    `query($f: SceneFilterType) {
       findScenes(scene_filter: $f, filter: {per_page: -1, sort: "created_at", direction: DESC}) {
         scenes { ${CARD} }
       }
     }`,
    { f: { path: { value: stage.path, modifier: 'INCLUDES' } } }
  );

  const scenes = (data.findScenes.scenes || [])
    .filter((scene) => stageOf((scene.files || []).map((f) => f.path)) === key)
    .map(card);

  return { stage, scenes };
}

/*
 * One pass over the library, tallied several ways. Stash's own scene_count
 * includes every file it has seen; these count scenes you hold. Also
 * tallies the pipeline stages.
 */
const INDEX_TTL = 5 * 60 * 1000;
let indexCache = null;

/* The last N months, empty ones included. */
function lastMonths(counts, n) {
  const out = [];
  const cursor = new Date();
  cursor.setUTCDate(1);

  for (let i = 0; i < n; i++) {
    const key = cursor.toISOString().slice(0, 7);
    out.unshift({ month: key, n: counts.get(key) || 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }

  /* Trim months before the library existed; keep quiet months inside it. */
  const first = out.findIndex((m) => m.n > 0);
  return first > 0 ? out.slice(first) : out;
}

export async function libraryIndex(config, { force = false } = {}) {
  if (!force && indexCache && Date.now() - indexCache.at < INDEX_TTL) return indexCache.index;

  const data = await gql(
    config,
    `query($f: SceneFilterType) {
       findScenes(scene_filter: $f, filter: {per_page: -1}) {
         count
         scenes {
           id created_at date play_count
           performers { id } studio { id } groups { group { id } }
           files { path height }
           stash_ids { endpoint }
         }
       }
     }`,
    { f: inLibrary }
  );

  const performers = new Map();
  const studios = new Map();
  const groups = new Map();
  const bump = (map, id) => map.set(id, (map.get(id) || 0) + 1);

  // Seeded with every stage so a stage that empties reads 0 rather than
  // disappearing off the row — an absent tile looks like a bug, a zero does not.
  const stages = Object.fromEntries(STAGES.map((stage) => [stage.key, 0]));
  let unplaced = 0;

  /* The Overview's charts, tallied in the same pass. */
  const quality = { uhd: 0, hd: 0, sd: 0, unknown: 0 };
  const watched = { played: 0, untouched: 0 };
  const identity = { stashdb: 0, tpdb: 0, none: 0 };
  const added = new Map();     // 'YYYY-MM' -> n, by when Stash first saw it
  const decades = new Map();   // release year bucket -> n

  for (const scene of data.findScenes.scenes || []) {
    for (const p of scene.performers || []) bump(performers, p.id);
    if (scene.studio) bump(studios, scene.studio.id);
    for (const g of scene.groups || []) if (g.group) bump(groups, g.group.id);

    const stage = stageOf((scene.files || []).map((f) => f.path));
    if (stage) stages[stage]++;
    else unplaced++;

    // Tallest file wins: a scene with a 4K master and a 720p proxy is a 4K scene.
    const height = Math.max(0, ...(scene.files || []).map((f) => Number(f.height) || 0));
    if (!height) quality.unknown++;
    else if (height >= 2000) quality.uhd++;
    else if (height >= 900) quality.hd++;
    else quality.sd++;

    if (scene.play_count > 0) watched.played++;
    else watched.untouched++;

    const endpoints = (scene.stash_ids || []).map((s) => String(s.endpoint || ''));
    if (endpoints.some((e) => e.includes('stashdb'))) identity.stashdb++;
    else if (endpoints.some((e) => e.includes('theporndb'))) identity.tpdb++;
    else identity.none++;

    const month = String(scene.created_at || '').slice(0, 7);
    if (month.length === 7) added.set(month, (added.get(month) || 0) + 1);

    const year = Number(String(scene.date || '').slice(0, 4));
    if (year >= 1970 && year <= 2100) decades.set(year, (decades.get(year) || 0) + 1);
  }

  const index = {
    total: data.findScenes.count,
    performers, studios, groups,
    stages, unplaced,
    charts: {
      quality,
      watched,
      identity,
      added: lastMonths(added, 12),
      years: [...decades.entries()].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, n })),
    },
  };
  indexCache = { index, at: Date.now() };
  return index;
}

/* Stash returns a placeholder for a missing image and marks it default=true. */
const hasArt = (path) => Boolean(path) && !/[?&]default=true/i.test(path);

/* What Stash has records for but you hold nothing of. */

export async function performersView(config) {
  const [index, data, endpoint] = await Promise.all([
    libraryIndex(config),
    gql(config, '{ findPerformers(filter: {per_page: -1}) { performers { id name favorite gender country scene_count image_path stash_ids { endpoint stash_id } } } }'),
    // Asked once for the whole shelf. Not being able to answer is ordinary:
    // without a stash-box nothing here is tracked and the wall says so.
    stashdb.endpointFor(config).catch(() => null),
  ]);

  const all = (data.findPerformers.performers || []).map((p) => ({
    id: p.id,
    name: p.name,
    favorite: !!p.favorite,
    gender: p.gender || null,
    country: p.country || null,
    held: index.performers.get(p.id) || 0,
    known: p.scene_count || 0,
    art: hasArt(p.image_path),
    stashdbId: stashdb.idAt(p.stash_ids, endpoint),
  }));

  return {
    held: all.sort(byHeld).filter((p) => p.held > 0),
    missing: all.filter((p) => !p.held).sort((a, b) => b.known - a.known || a.name.localeCompare(b.name)),
  };
}

export async function studiosView(config) {
  const [index, data, endpoint] = await Promise.all([
    libraryIndex(config),
    gql(config, '{ findStudios(filter: {per_page: -1}) { studios { id name scene_count image_path stash_ids { endpoint stash_id } } } }'),
    stashdb.endpointFor(config).catch(() => null),
  ]);

  const all = (data.findStudios.studios || []).map((s) => ({
    id: s.id,
    name: s.name,
    held: index.studios.get(s.id) || 0,
    known: s.scene_count || 0,
    art: hasArt(s.image_path),
    stashdbId: stashdb.idAt(s.stash_ids, endpoint),
  }));

  return {
    held: all.sort(byHeld).filter((s) => s.held > 0),
    missing: all.filter((s) => !s.held).sort((a, b) => b.known - a.known || a.name.localeCompare(b.name)),
  };
}

const byHeld = (a, b) => b.held - a.held || Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name);

/* In the pipeline: being edited or waiting on the encoder. Newest first. */
export async function inFlight(config, { limit = 24, page = 1 } = {}) {
  return findScenes(config, {
    filter: stillMoving,
    sort: 'created_at',
    limit,
    page,
    scoped: false,
  });
}

// One stage as a browsable list, for the segment that opens it.
export async function stageList(config, key, { limit = 60, page = 1 } = {}) {
  const { stage, scenes } = await stageScenes(config, key);
  const from = (Math.max(1, page) - 1) * limit;

  return {
    key,
    label: stage.label,
    path: stage.path,
    count: scenes.length,
    scenes: scenes.slice(from, from + limit),
  };
}

/* The overview: rails, what's in the pipeline, and counts per page. */
export async function overview(config) {
  const [rail, moving, counts] = await Promise.all([
    rails(config).catch(() => []),
    inFlight(config, { limit: 20 }).catch(() => ({ count: 0, scenes: [] })),
    libraryCounts(config).catch(() => null),
  ]);

  return { rails: rail, inFlight: moving, counts };
}

/* Scenes per stage. Library and Integrations share this index. */
export async function stageCounts(config, { force = false } = {}) {
  const index = await libraryIndex(config, { force });
  return { ...index.stages, unplaced: index.unplaced, total: index.total };
}

async function libraryCounts(config) {
  const [index, data] = await Promise.all([
    libraryIndex(config),
    gql(config, `{
      findGroups(filter: {per_page: 1}) { count }
      findPerformers(filter: {per_page: 1}) { count }
      findStudios(filter: {per_page: 1}) { count }
      findGalleries(filter: {per_page: 1}) { count }
    }`),
  ]);

  // held = has a scene you hold; known = any record in Stash.
  return {
    scenes: index.total,
    stages: index.stages,
    charts: index.charts,
    movies: { held: index.groups.size, known: data.findGroups.count },
    performers: { held: index.performers.size, known: data.findPerformers.count },
    studios: { held: index.studios.size, known: data.findStudios.count },
    // Galleries have no held/known split: a gallery is files or it is nothing,
    // and nothing in the import pipeline moves pictures around.
    galleries: data.findGalleries.count,
  };
}

// The named lists a rail's title opens.
const LISTS = {
  recent: { title: 'Recently added', sort: 'created_at' },
  released: { title: 'New releases', sort: 'date', filter: () => ({ date: { value: today(), modifier: 'LESS_THAN' } }) },
  continue: { title: 'Continue watching', sort: 'last_played_at', filter: () => ({ resume_time: { value: 1, modifier: 'GREATER_THAN' } }) },
  again: { title: 'Watch again', sort: 'play_count', filter: () => ({ play_count: { value: 0, modifier: 'GREATER_THAN' } }) },
  all: { title: 'Everything', sort: 'date' },
};


/*
 * The whole shelf in one read; the browser filters it. Cached five minutes.
 * Tags as bare names. `stash_ids` is for filmography categories.
 */
const SHELF = CARD + '\n  tags { name }\n  stash_ids { endpoint stash_id }';

let shelfCache = null;

export async function shelf(config, { force = false } = {}) {
  if (!force && shelfCache && Date.now() - shelfCache.at < RAIL_TTL) return shelfCache.data;

  const query = await gql(
    config,
    `query($f: SceneFilterType, $p: FindFilterType) {
       findScenes(scene_filter: $f, filter: $p) { count scenes { ${SHELF} } }
     }`,
    { f: { ...inLibrary }, p: { per_page: -1, sort: 'date', direction: 'DESC' } }
  );

  // Sweep the resolution flags first, but don't wait more than four seconds.
  const paths = query.findScenes.scenes.flatMap((s) => (s.files || []).map((f) => f.path));
  await Promise.race([warmTargets(paths), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});

  const data = {
    count: query.findScenes.count,
    scenes: query.findScenes.scenes.map((scene) => ({
      ...card(scene),
      tags: (scene.tags || []).map((t) => t.name),
      stash_ids: scene.stash_ids || [],
    })),
  };

  // Every path, handed to the media layer while we have them: it is the same
  // question it would otherwise ask one scene at a time on the first play.
  rememberPaths(query.findScenes.scenes.map((s) => [s.id, s.files?.[0]?.path || null]));

  shelfCache = { data, at: Date.now() };
  return data;
}

export async function list(config, key, { page = 1, limit = 60 } = {}) {
  const spec = LISTS[key];
  if (!spec) throw new Error(`No such list: ${key}`);

  const { count, scenes } = await findScenes(config, {
    filter: spec.filter ? spec.filter() : {},
    sort: spec.sort,
    page,
    limit,
  });

  return { key, title: spec.title, page, count, scenes };
}

/*
 * The reel. Markers by default (short, tagged, clipped); scenes play their
 * preview. The shuffle uses a seeded sort (`random_4821`) so paging holds
 * together; bare `random` reshuffles per query.
 */

/* Only /organized_scenes and /movies. One regex, not OR (see inLibrary). */
const FILED = { path: { value: '(/organized_scenes/|/movies/)', modifier: 'MATCHES_REGEX' } };

const MARKER = `
  id title seconds end_seconds
  primary_tag { id name }
  scene { ${CARD} }
`;

export function markerCard(marker) {
  const scene = card(marker.scene);
  const tag = marker.primary_tag?.name || null;

  return {
    kind: 'marker',
    id: marker.id,
    sceneId: scene.id,
    // A marker's own title is usually empty and its tag is the useful name —
    // which is also what Stash shows on the scene's own marker strip.
    title: marker.title || tag || 'Marker',
    tag,
    seconds: Math.round(marker.seconds || 0),
    end: marker.end_seconds ? Math.round(marker.end_seconds) : null,
    scene,
  };
}

export async function markerReel(config, { seed = '1', page = 1, limit = 12, tag = null, exclude = [] } = {}) {
  const data = await gql(
    config,
    `query($f: SceneMarkerFilterType, $p: FindFilterType) {
       findSceneMarkers(scene_marker_filter: $f, filter: $p) { count scene_markers { ${MARKER} } }
     }`,
    {
      /* One tag criterion: `value` keeps, `excludes` drops. Marker filters have no AND. */
      f: {
        ...(tag || exclude.length
          ? { tags: { value: tag ? [tag] : [], excludes: exclude, modifier: 'INCLUDES' } }
          : {}),
        scene_filter: FILED,
      },
      p: { per_page: limit, page, sort: `random_${seed}` },
    }
  );

  /* Headset footage dropped here: Stash has no criterion for file shape. */
  const items = data.findSceneMarkers.scene_markers.map(markerCard).filter((item) => !item.scene.immersive);

  return {
    source: 'markers',
    seed,
    page,
    count: data.findSceneMarkers.count,
    items,
  };
}

export async function sceneReel(config, { seed = '1', page = 1, limit = 12 } = {}) {
  const { count, scenes } = await findScenes(config, { filter: FILED, sort: `random_${seed}`, page, limit });

  return {
    source: 'scenes',
    seed,
    page,
    count,
    items: scenes.filter((scene) => !scene.immersive).map((scene) => ({
      kind: 'scene',
      id: scene.id,
      sceneId: scene.id,
      title: scene.title,
      tag: null,
      seconds: 0,
      end: null,
      scene,
    })),
  };
}

/* Primary tags with enough markers to fill a reel. */
export async function reelTags(config, { min = 8 } = {}) {
  const data = await gql(
    config,
    `{ findSceneMarkerTags: findTags(
         filter: {per_page: -1, sort: "name", direction: ASC}
         tag_filter: {marker_count: {value: ${min}, modifier: GREATER_THAN}}
       ) { tags { id name } } }`
  );

  return { tags: (data.findSceneMarkerTags?.tags || []).map((t) => ({ id: t.id, name: t.name })) };
}

/* One performer: vitals and scenes. Every field is nullable. */
/* custom_fields is read because the IAFD fill counts a set one as an answer. */
const PERFORMER = `
  id name disambiguation gender birthdate death_date country ethnicity
  eye_color hair_color height_cm weight measurements fake_tits
  career_length career_start career_end tattoos piercings alias_list urls
  details favorite rating100 scene_count custom_fields image_path
  stash_ids { endpoint stash_id }
`;

const findOne = async (config, id) => {
  const data = await gql(config, `query($id: ID!) { findPerformer(id: $id) { ${PERFORMER} } }`, { id });
  if (!data.findPerformer) throw new Error('Stash has no performer with that id.');
  return data.findPerformer;
};

const shapePerformer = (found) => ({
  id: found.id,
  name: found.name,
  disambiguation: found.disambiguation || null,
  gender: found.gender || null,
  country: found.country || null,
  birthdate: found.birthdate || null,
  deathDate: found.death_date || null,
  age: ageOf(found.birthdate, found.death_date),
  ethnicity: found.ethnicity || null,
  eyeColor: found.eye_color || null,
  hairColor: found.hair_color || null,
  heightCm: found.height_cm || null,
  weightKg: found.weight || null,
  measurements: found.measurements || null,
  fakeTits: found.fake_tits || null,
  careerLength: found.career_length || null,
  careerEnd: found.career_end || null,
  tattoos: found.tattoos || null,
  piercings: found.piercings || null,
  aliases: found.alias_list || [],
  custom: found.custom_fields || {},
  urls: found.urls || [],
  details: found.details || null,
  favorite: !!found.favorite,
  rating: found.rating100 ?? null,
  knownScenes: found.scene_count || 0,
  // Whether there's a real photo, so replacing it asks twice.
  art: hasArt(found.image_path),
  stash_ids: found.stash_ids || [],
});

export async function performerView(config, id, { page = 1, limit = 60 } = {}) {
  const performer = shapePerformer(await findOne(config, id));

  const { count, scenes } = await findScenes(config, {
    filter: { performers: { value: [id], modifier: 'INCLUDES' } },
    sort: 'date',
    page,
    limit,
  });

  // perPage so the Show more under the shelf counts pages rather than guessing.
  return { performer, page, perPage: limit, count, scenes };
}

/* Age stops at the death date. */
function ageOf(birthdate, deathDate) {
  if (!birthdate) return null;
  const born = new Date(birthdate);
  const until = deathDate ? new Date(deathDate) : new Date();
  if (Number.isNaN(born.getTime()) || Number.isNaN(until.getTime())) return null;

  let age = until.getFullYear() - born.getFullYear();
  const month = until.getMonth() - born.getMonth();
  if (month < 0 || (month === 0 && until.getDate() < born.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/*
 * The performer's IAFD record, if Stash has an iafd.com URL for them.
 * Separate request so the page doesn't wait. `fill` lists Stash's gaps it could close.
 */
export async function performerIafd(config, id) {
  const found = await findOne(config, id);
  const url = iafdUrlOf(found.urls || []);
  const iafd = url ? await iafdLookup(url) : null;

  return { url, iafd, fill: iafdProposal(found, iafd).rows };
}

/* Write those gaps, rebuilt from a fresh read. Never overwrites. */
export async function fillPerformerFromIafd(config, id) {
  const found = await findOne(config, id);
  const url = iafdUrlOf(found.urls || []);
  if (!url) throw new Error('Stash has no IAFD address for this performer.');

  const record = await iafdLookup(url);
  if (!record) throw new Error('IAFD did not answer. Try again in a minute.');

  const { fields, custom, rows } = iafdProposal(found, record);
  if (!rows.length) return { performer: shapePerformer(found), written: [] };

  await gql(
    config,
    'mutation($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }',
    {
      input: {
        id,
        ...fields,
        // Merged, not replaced: custom fields put here by anything else stay.
        ...(Object.keys(custom).length ? { custom_fields: { partial: custom } } : {}),
      },
    }
  );

  return { performer: shapePerformer(await findOne(config, id)), written: rows };
}

/*
 * ------------------------------------------------------------- their picture
 *
 * Replace a performer's photo or a studio's logo, in Stash. Stash keeps no
 * copy of the old one, so this can't be undone; the page asks twice when
 * there's one to lose. Sent as a data URI.
 */
export async function setPerformerImage(config, id, image) {
  await gql(
    config,
    'mutation($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }',
    { input: { id, image } }
  );

  return { performer: shapePerformer(await findOne(config, id)) };
}

export async function setStudioImage(config, id, image) {
  await gql(
    config,
    'mutation($input: StudioUpdateInput!) { studioUpdate(input: $input) { id } }',
    { input: { id, image } }
  );

  return { id };
}

/*
 * ------------------------------------------------------------------ studios
 *
 * Studio facts from the TPDB mirror (see studiofacts.mjs). Gaps only.
 */

const findStudioRecord = async (config, id) => {
  const data = await gql(
    config,
    `query($id: ID!) { findStudio(id: $id) { id name urls custom_fields parent_studio { id } } }`,
    { id }
  );
  if (!data.findStudio) throw new Error('Stash has no studio with that id.');
  return data.findStudio;
};

export async function studioFacts(config, id) {
  const found = await findStudioRecord(config, id);
  const site = await studiofacts.lookup({ urls: found.urls || [], name: found.name });

  return { site, fill: studiofacts.proposal(found, site).rows };
}

/*
 * Write those gaps, from a fresh read. studioUpdate replaces `urls` whole,
 * so the homepage is appended.
 */
export async function fillStudioFromSite(config, id) {
  const found = await findStudioRecord(config, id);
  const site = await studiofacts.lookup({ urls: found.urls || [], name: found.name });
  if (!site) throw new Error('ThePornDB has no site this studio resolves to.');

  const { urls, custom, rows } = studiofacts.proposal(found, site);
  if (!rows.length) return { written: [] };

  await gql(
    config,
    'mutation($input: StudioUpdateInput!) { studioUpdate(input: $input) { id } }',
    {
      input: {
        id,
        ...(urls ? { urls } : {}),
        ...(Object.keys(custom).length ? { custom_fields: { partial: custom } } : {}),
      },
    }
  );

  // Handed back so the page can redraw against what Stash now holds rather
  // than against a promise that the write went in.
  const after = await findStudioRecord(config, id);
  return {
    written: rows,
    studio: {
      urls: after.urls || [],
      homepage: studiofacts.homepageOf(after.urls || []),
      custom: after.custom_fields || {},
    },
  };
}

/*
 * Add a URL to a group so Stash can scrape it. groupUpdate replaces `urls`
 * whole, so existing ones are kept.
 */
export async function setGroupUrl(config, id, url) {
  const current = await gql(config, 'query($id: ID!) { findGroup(id: $id) { id urls } }', { id });
  if (!current.findGroup) throw new Error('Stash has no group with that id.');

  const urls = current.findGroup.urls || [];
  if (urls.includes(url)) return { id, urls };

  const data = await gql(
    config,
    'mutation($input: GroupUpdateInput!) { groupUpdate(input: $input) { id urls } }',
    { input: { id, urls: [...urls, url] } }
  );

  return data.groupUpdate;
}

/* What Stash's scrapers read off a URL, unwritten, so the page can check it. */
export async function scrapeGroup(config, url) {
  const data = await gql(
    config,
    `query($u: String!) {
       scrapeGroupURL(url: $u) {
         name aliases date duration director synopsis urls
         front_image back_image
         studio { stored_id name }
       }
     }`,
    { u: url }
  );

  if (!data.scrapeGroupURL) throw new Error('No scraper here could read that address.');
  return data.scrapeGroupURL;
}

/* Apply the ticked fields. Duration arrives as "1:26:00" or "138:00"; Stash wants seconds. */
const DURATION = (value) => {
  if (!value) return null;
  const parts = String(value).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  // "h:m:s" or "m:s" — a bare number is already minutes on these sites.
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 60;
};

export async function applyScrape(config, id, fields) {
  const input = { id };

  for (const key of ['name', 'aliases', 'director', 'synopsis', 'front_image', 'back_image']) {
    if (fields[key]) input[key] = fields[key];
  }

  /* A bare year can't be a date; refuse it by name. */
  if (fields.date) {
    if (!/^\d{4}(-\d{2}-\d{2})?$/.test(fields.date)) {
      throw new Error(`"${fields.date}" is not a date Stash will take.`);
    }
    input.date = fields.date;
  }
  if (fields.duration) {
    const seconds = DURATION(fields.duration);
    if (seconds) input.duration = seconds;
  }
  if (Array.isArray(fields.urls) && fields.urls.length) input.urls = fields.urls;

  const data = await gql(
    config,
    'mutation($input: GroupUpdateInput!) { groupUpdate(input: $input) { id name date duration director synopsis urls front_image_path } }',
    { input }
  );

  return data.groupUpdate;
}

/*
 * Stash's own scene order for a group, usually null. Lives on the join, so
 * it needs its own query. An older Stash fails this query; the caller swallows it.
 */
async function sceneIndexes(config, id) {
  const data = await gql(
    config,
    'query($id: ID!) { findGroup(id: $id) { scenes { id groups { scene_index group { id } } } } }',
    { id }
  );

  const out = new Map();
  for (const scene of data.findGroup?.scenes || []) {
    const mine = (scene.groups || []).find((g) => String(g.group?.id) === String(id));
    if (mine && mine.scene_index !== null && mine.scene_index !== undefined) {
      out.set(scene.id, mine.scene_index);
    }
  }
  return out;
}

export async function groupView(config, id, { page = 1, limit = 60 } = {}) {
  const data = await gql(
    config,
    `query($id: ID!) {
       findGroup(id: $id) {
         id name date duration synopsis director scene_count
         studio { id name }
       }
     }`,
    { id }
  );
  const group = data.findGroup;
  if (!group) throw new Error('Stash has no group with that id.');

  const [{ count, scenes }, order] = await Promise.all([
    findScenes(config, {
      filter: { groups: { value: [id], modifier: 'INCLUDES' } },
      sort: 'date',
      page,
      limit,
    }),
    sceneIndexes(config, id).catch(() => new Map()),
  ]);

  return {
    group: {
      id: group.id,
      name: group.name,
      date: group.date || null,
      duration: group.duration || null,
      synopsis: group.synopsis || null,
      director: group.director || null,
      sceneCount: group.scene_count || 0,
      studio: group.studio ? { id: group.studio.id, name: group.studio.name } : null,
    },
    page,
    count,
    // The place in the film, where Stash has been told one. Everything else
    // about ordering these is a reading of their names and belongs in the page.
    scenes: scenes.map((s) => ({ ...s, index: order.has(s.id) ? order.get(s.id) : null })),
  };
}

/*
 * One studio and its cast. `performer` narrows the scenes, not the header
 * count. `cast` is skipped when only scenes are wanted.
 */
export async function studioView(config, id, { page = 1, limit = 60, performer = null, cast = true } = {}) {
  const data = await gql(
    config,
    `query($id: ID!) {
       findStudio(id: $id) {
         id name details image_path urls aliases rating100 custom_fields
         parent_studio { id name }
         stash_ids { endpoint stash_id }
       }
     }`,
    { id }
  );
  const studio = data.findStudio;
  if (!studio) throw new Error('Stash has no studio with that id.');

  const mine = { studios: { value: [id], modifier: 'INCLUDES' } };
  const filter = performer
    ? { ...mine, performers: { value: [performer], modifier: 'INCLUDES' } }
    : mine;

  const [found, roster, held] = await Promise.all([
    findScenes(config, { filter, sort: 'date', page, limit }),
    cast ? studioCast(config, id) : null,
    performer ? libraryIndex(config).then((index) => index.studios.get(id) || 0) : null,
  ]);

  return {
    studio: {
      id: studio.id,
      name: studio.name,
      details: studio.details || null,
      art: hasArt(studio.image_path),
      parent: studio.parent_studio ? { id: studio.parent_studio.id, name: studio.parent_studio.name } : null,
      urls: studio.urls || [],
      // Which of those is the studio's own front door rather than a database
      // or a social account. See studiofacts.mjs.
      homepage: studiofacts.homepageOf(studio.urls || []),
      aliases: studio.aliases || [],
      rating: studio.rating100 ?? null,
      custom: studio.custom_fields || {},
      stashIds: studio.stash_ids || [],
    },
    held: performer ? held : found.count,
    page,
    perPage: limit,
    count: found.count,
    scenes: found.scenes,
    cast: roster,
  };
}

/* The studio's cast, counted from scenes you hold. */
async function studioCast(config, id) {
  const data = await gql(
    config,
    `query($f: SceneFilterType) {
       findScenes(scene_filter: $f, filter: {per_page: -1}) {
         scenes { performers { id name gender image_path stash_ids { endpoint stash_id } } }
       }
     }`,
    { f: { studios: { value: [id], modifier: 'INCLUDES' }, ...inLibrary } }
  );

  const seen = new Map();
  for (const scene of data.findScenes.scenes || []) {
    for (const p of scene.performers || []) {
      const hit = seen.get(p.id);
      if (hit) {
        hit.count++;
        continue;
      }
      seen.set(p.id, {
        id: p.id,
        name: p.name,
        gender: p.gender || null,
        art: hasArt(p.image_path),
        stashIds: p.stash_ids || [],
        count: 1,
      });
    }
  }

  // Most of this studio first: the rail is read left to right and the people
  // you hold ten of theirs from are the ones worth filtering by.
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/* Type-ahead for gallery ties. Stash matches; twenty results. */
const LOOKUPS = {
  performer: {
    query: `query($p: FindFilterType) {
      findPerformers(filter: $p) { performers { id name scene_count gender } }
    }`,
    sort: 'name',
    direction: 'ASC',
    read: (d) => d.findPerformers.performers.map((p) => ({
      id: p.id,
      name: p.name,
      note: [p.gender?.toLowerCase(), p.scene_count ? `${p.scene_count} scenes` : null].filter(Boolean).join(' · '),
    })),
  },
  studio: {
    query: `query($p: FindFilterType) {
      findStudios(filter: $p) { studios { id name scene_count } }
    }`,
    sort: 'name',
    direction: 'ASC',
    read: (d) => d.findStudios.studios.map((s) => ({
      id: s.id,
      name: s.name,
      note: s.scene_count ? `${s.scene_count} scenes` : '',
    })),
  },
  scene: {
    query: `query($p: FindFilterType) {
      findScenes(filter: $p) { scenes { id title date studio { name } files { path } } }
    }`,
    sort: 'date',
    direction: 'DESC',
    read: (d) => d.findScenes.scenes.map((s) => ({
      id: s.id,
      // An unidentified scene has no title, and the filename is what is left —
      // the same fallback the tiles use.
      name: s.title || basename(s.files?.[0]?.path) || `Scene ${s.id}`,
      note: [s.studio?.name, s.date].filter(Boolean).join(' · '),
    })),
  },
};

export async function lookup(config, kind, q, { limit = 20 } = {}) {
  const spec = LOOKUPS[kind];
  if (!spec) throw new Error(`No such thing to look up: ${kind}`);

  const term = String(q || '').trim();
  const data = await gql(config, spec.query, {
    p: { per_page: limit, sort: spec.sort, direction: spec.direction, ...(term ? { q: term } : {}) },
  });

  return { kind, q: term, results: spec.read(data) };
}

export async function search(config, q, { limit = 60 } = {}) {
  const { count, scenes } = await findScenes(config, { q, sort: 'date', limit });
  return { q, count, scenes };
}

/*
 * ------------------------------------------------------------ scene detail
 *
 * Carries which stash-box identified it: TPDB means v2, StashDB v3.
 */

const STASHDB = /stashdb\.org/i;
const TPDB = /theporndb|metadataapi/i;

function identity(stashIds = []) {
  const out = { tpdb: null, stashdb: null, other: [] };
  for (const { endpoint, stash_id } of stashIds) {
    if (TPDB.test(endpoint) && !/[?&]type=movie/i.test(endpoint)) out.tpdb = stash_id;
    else if (STASHDB.test(endpoint)) out.stashdb = stash_id;
    else out.other.push({ endpoint, id: stash_id });
  }
  return out;
}

export async function sceneView(config, id) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${DETAIL} } }`, { id });
  const scene = data.findScene;
  if (!scene) throw new Error('Stash has no scene with that id.');

  const file = scene.files?.[0] || null;
  const performerIds = (scene.performers || []).map((p) => p.id);

  /* More like this: same studio, and same cast, as two rails. */
  const [fromStudio, withCast] = await Promise.all([
    scene.studio
      ? findScenes(config, {
          filter: { studios: { value: [scene.studio.id], modifier: 'INCLUDES' } },
          sort: 'date',
          limit: 20,
        }).catch(() => ({ scenes: [] }))
      : Promise.resolve({ scenes: [] }),
    performerIds.length
      ? findScenes(config, {
          filter: { performers: { value: performerIds, modifier: 'INCLUDES' } },
          sort: 'date',
          limit: 20,
        }).catch(() => ({ scenes: [] }))
      : Promise.resolve({ scenes: [] }),
  ]);

  const without = (list) => list.filter((s) => s.id !== scene.id).slice(0, 18);

  return {
    scene: {
      ...card(scene),
      // The detail query asks for the photograph the card query has no use for,
      // so the cast can be faces on the scene page rather than names.
      performers: (scene.performers || []).map((p) => ({
        id: p.id,
        name: p.name,
        favorite: !!p.favorite,
        art: hasArt(p.image_path),
      })),
      details: scene.details || null,
      urls: scene.urls || [],
      tags: scene.tags || [],
      markers: (scene.scene_markers || [])
        .map((m) => ({ id: m.id, title: m.title || m.primary_tag?.name || 'Marker', seconds: m.seconds }))
        .sort((a, b) => a.seconds - b.seconds),
      lastPlayed: scene.last_played_at || null,
      addedAt: scene.created_at || null,
      identity: identity(scene.stash_ids),
      // Sprite and vtt are keyed on the file hash rather than the scene id, so
      // they have to come from Stash rather than be constructed from the id.
      sprite: scene.paths?.sprite || null,
      vtt: scene.paths?.vtt || null,
      file: file
        ? {
            path: file.path,
            size: file.size,
            duration: file.duration,
            width: file.width,
            height: file.height,
            videoCodec: file.video_codec,
            audioCodec: file.audio_codec,
            frameRate: file.frame_rate,
            bitRate: file.bit_rate,
          }
        : null,
    },
    related: [
      scene.studio && without(fromStudio.scenes).length
        ? { key: 'studio', title: `More from ${scene.studio.name}`, href: `#/library/studio/${scene.studio.id}`, scenes: without(fromStudio.scenes) }
        : null,
      without(withCast.scenes).length
        ? { key: 'cast', title: 'With the same cast', scenes: without(withCast.scenes) }
        : null,
    ].filter(Boolean),
  };
}

/*
 * ----------------------------------------------------------------- writes
 *
 * What you decide while watching. Metadata surgery stays in Stash.
 */

export async function saveActivity(config, id, { resume = null, played = null }) {
  await gql(
    config,
    'mutation($id: ID!, $r: Float, $p: Float) { sceneSaveActivity(id: $id, resume_time: $r, playDuration: $p) }',
    { id, r: resume, p: played }
  );
  forgetRails(); // continue-watching just moved
  return { ok: true };
}

export async function addPlay(config, id) {
  await gql(config, 'mutation($id: ID!) { sceneAddPlay(id: $id) { count } }', { id });
  forgetRails();
  return { ok: true };
}

export async function setOrganized(config, id, organized) {
  const data = await gql(
    config,
    'mutation($id: ID!, $o: Boolean!) { sceneUpdate(input: {id: $id, organized: $o}) { id organized } }',
    { id, o: !!organized }
  );
  forgetRails();
  return data.sceneUpdate;
}

export async function setRating(config, id, rating) {
  const data = await gql(
    config,
    'mutation($id: ID!, $r: Int) { sceneUpdate(input: {id: $id, rating100: $r}) { id rating100 } }',
    { id, r: rating === null ? null : Math.max(0, Math.min(100, Number(rating))) }
  );
  return data.sceneUpdate;
}

export async function addO(config, id) {
  const data = await gql(config, 'mutation($id: ID!) { sceneAddO(id: $id) { count } }', { id });
  return { oCount: data.sceneAddO.count };
}
