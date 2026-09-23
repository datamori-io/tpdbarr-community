/*
 * The library spine.
 *
 * Every other module in this portal is keyed on a TPDB UUID. This one is keyed
 * on the Stash scene id, because most of the library has no TPDB identity and
 * never will — over half of it was identified against StashDB, and a chunk of
 * it against nothing at all. Stash is the library of record, so browsing,
 * playing and filing all read from here. TPDB and StashDB are identities that
 * hang off a scene, not the spine.
 */

import { gql } from './stash.mjs';
import * as stashdb from './stashdb.mjs';
import { rememberPaths } from './media.mjs';
import { iafdUrlOf, lookup as iafdLookup, proposal as iafdProposal } from './iafd.mjs';
import * as studiofacts from './studiofacts.mjs';

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

/*
 * A file shot for a headset rather than a screen.
 *
 * Equirectangular VR is 2:1 and very wide — the one that sent the reel black
 * was 4096x2048 h264, which the browser fetched happily and then never got a
 * frame out of. The width test is what keeps this off ordinary cinematic
 * scenes: /organized_scenes has a shelf of 1920x816 films at 2.35:1 that are
 * perfectly playable and must not be caught by an aspect rule alone.
 *
 * Two scenes in the library are VR today. The rule is written on the shape
 * rather than on their studio names so the next one is caught too.
 */
/*
 * Named first, measured second.
 *
 * Shape alone is too fine a judgement to hang this on. Measured across the
 * filed library: twenty-odd ordinary 4K scenes are 4096x2160, which is 1.896,
 * and the equirectangular VR one is 4096x2048, which is 2.000. A rule cutting
 * between those two sits on a knife edge — one re-encode either way and it
 * starts throwing out scenes that play perfectly well.
 *
 * So the studio's name carries it, and the shape is only a backstop for
 * headset footage filed under a studio that does not say so. Every VR studio
 * in this library wears it in the name: ChinChinVR, VRHush, WankzVR,
 * VRCosplayX, POVR Premium.
 */
const IMMERSIVE_WIDTH = 3000;
const IMMERSIVE_MIN = 1.98;
const IMMERSIVE_MAX = 2.1;

export function immersive(file, studio) {
  if (/vr/i.test(String(studio || ''))) return true;

  const width = file?.width || 0;
  const height = file?.height || 0;
  if (!width || !height) return false;

  /*
   * A band, not a floor. Equirectangular is 2:1; a 2.35 scope film is not
   * headset footage and there is a 3840x1632 one here that a bare floor
   * caught on the way past.
   */
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
    /*
     * What it is about, cut here rather than in the browser.
     *
     * The shelf read is the whole library in one go — a couple of megabytes
     * already — and a Stash description runs to several paragraphs. The tile
     * shows two clamped lines and nothing else here shows more, so carrying the
     * rest across the wire would be a third of a megabyte nobody reads.
     */
    details: String(scene.details || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    studio: scene.studio ? { id: scene.studio.id, name: scene.studio.name } : null,
    performers: (scene.performers || []).map((p) => ({ id: p.id, name: p.name, favorite: !!p.favorite })),
    duration,
    resolution: resolution(file?.height),
    organized: !!scene.organized,
    // Where it is in the pipeline, read off the path rather than the
    // `organized` flag — the folder is what FileFlows actually moves. See STAGES.
    stage: stageOf((scene.files || []).map((f) => f.path)),
    // Shot for a headset. The reel leaves these alone; the rest of the app
    // still lists them, because a page you choose to open is not a reel.
    immersive: immersive(file, scene.studio?.name),
    /*
   * When Stash first saw it, which is not the same question as `date`. `date`
   * is when the scene was released and is the shelf's default order; this is
   * when it landed here, and it is the only way to ask "what is new to me"
   * about a back catalogue you have just imported.
   */
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
 * Which of your own scenes Stash itself already credits to a director —
 * Stash's own `director` field on a scene, separate from StashDB's, filled in
 * by hand or by whichever scraper populates it (a GameLink scrape does).
 *
 * This is the one thing a filmography category can ask that StashDB cannot
 * answer about itself: StashDB has no way to find "everything this person
 * directed", but the scenes you have already identified as his are a seed —
 * their StashDB studio, and that studio's network, is where the rest of his
 * work most likely also lives. See categories.mjs's crawlDirector.
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
 * The tracked studios and performers, as Stash ids.
 *
 * A tracked entry is a StashDB uuid — that is what the acquisition side
 * measures coverage against — and the library is keyed on Stash's own ids, so
 * the two have to be joined before anything can be filtered by one. The join
 * is the `stash_ids` Stash keeps against the StashDB endpoint.
 *
 * Falling back to the name is deliberate. A performer identified against
 * ThePornDB and never against StashDB carries no StashDB id at all, and there
 * are a lot of those here; without the fallback they would silently drop out
 * of a rail whose whole point is "the people I follow". A name collision costs
 * one wrong scene in a rail. Missing the id costs the person entirely.
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

  /*
   * Only what you track, and only what has actually landed. These two answer
   * "what have the people and the labels I follow put out that I now own" —
   * which is a different question from the acquisition side's suggestions,
   * where the whole point is the scenes you do *not* have.
   */
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
    /*
     * INCLUDES and not INCLUDES_ALL: a scene qualifies if it has any one of
     * the tracked people on it. INCLUDES_ALL would ask for a scene starring
     * every performer you follow, which is nothing.
     */
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

  /*
   * Every rail failing at once means Stash was not up, which happens on the
   * first request after a restart. Caching that for five minutes turns a blip
   * into an empty library, so a total miss is simply not kept.
   */
  if (kept.length) railCache = { rails: kept, at: Date.now() };
  return kept;
}

/* ------------------------------------------------------------ the stages
 *
 * The folder a file sits in is a **status, not ownership**. Everything Stash
 * holds is available; the path only says how far along the pipeline it is:
 *
 *   Whisparr /data/scenes  grabbed, not encoded — Stash cannot see it at all
 *   /pc-import             yours, being edited by hand before it moves on
 *   /Import Folder         yours, waiting on the encoder
 *   /organized_scenes      yours, filed
 *   /movies                yours, a feature film that came in through Emby
 *
 * This replaces a scope that treated the first two as *not yours* and hid
 * 1080 scenes from every count in the app. A correction, 2026-09-01:
 * "Everything in Stash should be considered as available. These are more
 * statuses." So `inLibrary` is now empty and the browse is the whole of Stash.
 *
 * Measured 2026-09-01: 2106 scenes — 984 organized, 808 Import Folder,
 * 272 pc-import, 52 movies. Those add to 2116 because ten scenes have files
 * under two roots at once, which is why `stageOf` takes the furthest-along
 * path rather than the first one.
 *
 * The one stage Stash cannot report is the first: 236 files sat in Whisparr
 * v3's own root on the day this was written, with no Stash record of any kind.
 * That is counted on the Whisparr side, in tidy.mjs, not here.
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
 * What counts as "in my library": all of it.
 *
 * Kept as a named constant that is spread into every browse rather than
 * deleted, because the scoping question comes back — a "filed only" toggle is
 * the obvious next ask — and this is the one place it would go.
 *
 * **If a scope ever returns here, nest it under one `AND`.** Stash reads a
 * top-level `OR` as OR-ing against *everything* beside it, so a flat
 * `{studios: X, path: A, OR: {path: B}}` means "(that studio AND A) OR
 * anything at all under B", which put all 52 films on every studio page in the
 * house the first time it was written flat.
 */
const inLibrary = {};

// Scenes that have not reached /organized_scenes or /movies yet — still being
// edited or still queued for the encoder. A status rail, not an exclusion.
const stillMoving = {
  path: { value: '/organized_scenes/', modifier: 'EXCLUDES' },
  AND: { path: { value: '/movies/', modifier: 'EXCLUDES' } },
};

/*
 * The scenes whose *furthest-along* file is in this stage.
 *
 * This cannot be done as a path filter, and the attempt is worth recording.
 * Stash evaluates `path` per file and a scene can have several, so on a scene
 * with a copy in /pc-import and another in /organized_scenes, `EXCLUDES
 * /organized_scenes/` is still satisfied — by the other file. Ten scenes here
 * are in exactly that state, and a filter written that way had the bar saying
 * 226 editing and the page it opened showing 236.
 *
 * So the folder does the narrowing and `stageOf` does the deciding, which is
 * the same function the bar counts with. One source of truth, and the number
 * you click is the number you get.
 *
 * That means reading the whole stage rather than a page of it. The largest is
 * under a thousand scenes and the shelf already reads all 2105 in one go for
 * the filter bar, so this is the cheaper of the two reads on the page.
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
 * One pass over the library, tallied three ways.
 *
 * Stash's own scene_count on a performer, a studio or a group counts every
 * file it has ever seen, including the ones still queued for import — which is
 * the exact number this half of the app is not supposed to show — or was,
 * until the folders became statuses on 2026-09-01. It still does not match
 * Stash's own totals, because Stash counts a performer once per record and
 * this counts them once per scene you hold, so the maps below are also what
 * every "N in your library" line reads from.
 *
 * The same pass tallies the pipeline stage, since it already has every path.
 */
const INDEX_TTL = 5 * 60 * 1000;
let indexCache = null;

/*
 * The last N months, including the empty ones.
 *
 * A bar chart built only from the months that have data draws a flat wall and
 * hides the two months nothing arrived — which, on a chart about how fast the
 * library is growing, is the most informative bar on it.
 */
function lastMonths(counts, n) {
  const out = [];
  const cursor = new Date();
  cursor.setUTCDate(1);

  for (let i = 0; i < n; i++) {
    const key = cursor.toISOString().slice(0, 7);
    out.unshift({ month: key, n: counts.get(key) || 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }

  /*
   * Trim the months before the library existed. This one is seven months old,
   * so a fixed twelve draws five empty bars in front of it — which reads as
   * five months of collecting nothing rather than as a Stash that had not been
   * set up yet. Gaps *inside* the run are kept: those are real quiet months.
   */
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

  /*
   * The rest of this loop is the Overview's charts.
   *
   * All of it is tallied here rather than in four more queries because the one
   * pass already has every scene in its hands. Reading 2106 scenes costs about
   * two megabytes and five seconds of Stash's time; doing it five times over to
   * draw five small charts would be the expensive way to be pretty.
   */
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

/*
 * Stash answers every image request, even when it has no image: what comes back
 * is a Font Awesome placeholder with a viewBox and no intrinsic size, which an
 * <img> renders as a shrug. It flags those with default=true on the path, so
 * that is read here and the tile draws its own empty state instead.
 */
const hasArt = (path) => Boolean(path) && !/[?&]default=true/i.test(path);

/*
 * Everything Stash knows about but you hold nothing of — the other half of
 * each page. These are not failures: a performer arrives with a scene's cast
 * list and a group arrives with an identify run, so Stash accumulates records
 * for things you have never had. That is a want list you did not have to
 * write.
 */

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

/*
 * Yours, but still moving: being edited by hand or waiting on the encoder.
 * Newest first, because the question this answers is "what have I got that has
 * not settled yet" — not "what am I missing", which it used to be read as.
 */
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

/*
 * The overview. The rails you actually open the app for, what is still moving
 * through the pipeline, and one line of arithmetic per page so the tabs are
 * not a guess.
 */
export async function overview(config) {
  const [rail, moving, counts] = await Promise.all([
    rails(config).catch(() => []),
    inFlight(config, { limit: 20 }).catch(() => ({ count: 0, scenes: [] })),
    libraryCounts(config).catch(() => null),
  ]);

  return { rails: rail, inFlight: moving, counts };
}

/*
 * How many scenes sit at each stage of the pipeline. The library overview shows
 * these as folders; Integrations shows them as a queue. Same index, same
 * numbers — a second count computed a second way is two numbers waiting to
 * disagree in front of you.
 */
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

  // held = has at least one scene you actually hold; known = what Stash has a
  // record for at all, which is the bigger and less useful number. Since
  // 2026-09-01 "hold" means anywhere in Stash, so held has grown by the 1080
  // scenes the old folder scope was hiding.
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
 * The whole shelf in one read, for the Scenes page's filters.
 *
 * A filter bar whose dropdowns are built from the first sixty scenes would
 * offer you the wrong studios and lie about the counts, so this reads every
 * scene in the library at once and the browser does the filtering. That is
 * affordable exactly once — 1767 scenes is a couple of megabytes — so it is
 * cached here for the same five minutes as the rails.
 *
 * Tags come as bare names: the page filters on them and shows them, and
 * nothing on this side of the app links to a tag.
 *
 * `stash_ids` rides along too, for the one caller that needs to know which
 * StashDB uuid a shelf scene answers to — a filmography category, joining an
 * external want-list against what you actually hold. See categories.mjs.
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
 * The reel.
 *
 * Two sources for one feed. Markers are the better unit and the default: they
 * are already short, already tagged, and Stash has generated a clip for each
 * one, so a reel of them is a reel rather than a half-hour scene reduced to a
 * thirty-second trailer. Scenes are the fallback for a library with few
 * markers, and play the scene preview instead.
 *
 * Both shuffle, and the shuffle has to survive paging: Stash reads a seed off
 * the sort value, so `random_4821` gives the same order on page 4 as it did on
 * page 1. A bare `random` reshuffles per query, which would show the same clip
 * twice and skip others as you scrolled.
 */

/*
 * What the reel is allowed to draw on.
 *
 * The two roots that are the library proper — /organized_scenes and /movies —
 * and not the encoder's queue or the editing folder, which hold work in
 * progress rather than things to watch. Measured 2026-09-02: 1400 of 1429
 * markers and 1037 of 2107 scenes.
 *
 * One regex rather than two criteria joined by OR, because Stash reads a
 * top-level OR as OR-ing against everything beside it — see the note on
 * inLibrary above, which is the scar from learning that.
 */
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
      /*
       * One tag criterion carries both halves: `value` is what to keep,
       * `excludes` is what to drop. They cannot be two criteria — a marker
       * filter has no AND to join them with — but they do not need to be,
       * because the criterion has an excludes field of its own.
       */
      f: {
        ...(tag || exclude.length
          ? { tags: { value: tag ? [tag] : [], excludes: exclude, modifier: 'INCLUDES' } }
          : {}),
        scene_filter: FILED,
      },
      p: { per_page: limit, page, sort: `random_${seed}` },
    }
  );

  /*
   * Headset footage is dropped here rather than filtered in the query: Stash
   * has no criterion for the shape of a file, and at two scenes in the library
   * the count being a couple out is not worth a second round trip to correct.
   */
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

/*
 * What the reel can be narrowed to. Only primary tags, and only ones with
 * enough behind them to be worth a whole reel — a tag on two markers is a
 * dead end you have to scroll back out of.
 */
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

/*
 * One performer: their vitals, and their scenes.
 *
 * The vitals are read here rather than left to the card query because this is
 * the only screen that wants them — a shelf of two hundred faces has no room
 * for a hair colour, and asking for one on every rail would pay for it two
 * hundred times over.
 *
 * Everything is nullable. Stash fills a performer in from whatever scraper
 * found them, so a page that assumed a birthdate would be a page with holes in
 * it; the header drops what is missing instead of printing blanks.
 */
/*
 * Everything the performer page reads. custom_fields is in here because the
 * IAFD fill treats one that is already set as an answer, the same as a column.
 */
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
  // Whether there is a photograph to lose, which is what decides whether
  // replacing it is asked about twice. hasArt() because Stash answers with a
  // generated placeholder rather than nothing.
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

/*
 * Age, counted to the death date when there is one — otherwise a performer who
 * died in 2009 goes on having birthdays.
 */
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
 * The same performer, read off IAFD.
 *
 * Its own request rather than part of performerView, because it leaves the
 * house: the page should draw from Stash straight away and let this arrive
 * late or not at all. A performer with no iafd.com address in their Stash
 * record has nothing to ask for, and that is the common case — this only
 * knows where to look because a scraper put the link there.
 *
 * `fill` is what the button offers: the gaps in Stash that this record could
 * close, worked out here rather than in the browser so that the list the page
 * shows and the list the write uses are the same list.
 */
export async function performerIafd(config, id) {
  const found = await findOne(config, id);
  const url = iafdUrlOf(found.urls || []);
  const iafd = url ? await iafdLookup(url) : null;

  return { url, iafd, fill: iafdProposal(found, iafd).rows };
}

/*
 * Those gaps, written.
 *
 * The proposal is rebuilt here from a fresh read rather than taken from the
 * browser: the page may have been sitting open since before something else
 * filled half of this in, and a button that writes what it was told to write
 * would undo that. Nothing is overwritten either way — see proposal() — so
 * the worst a stale click can do is nothing at all.
 */
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

/* ------------------------------------------------------------- their picture
 *
 * Replacing a performer's photograph or a studio's logo with one you uploaded.
 *
 * Into Stash, not into a folder here. Everywhere else the portal draws these
 * it draws Stash's copy, and a picture kept on this side would be a second
 * answer to a question the library of record already answers - visible in the
 * portal, missing in Stash, and wrong in whichever one you were not looking
 * at. See media.mjs, which proxies both straight through.
 *
 * **Stash keeps no copy of the one it replaces**, so this is the one write in
 * the app that cannot be undone from the app. Every other one is gaps-only by
 * design - see fillPerformerFromIafd - and this deliberately is not, because
 * replacing a picture you do not like is the entire point. The page asks twice
 * where there is already a picture to lose, which is the only guard that
 * honestly applies.
 *
 * A data URI because that is how Stash takes an image; there is no endpoint to
 * post bytes at. See artwork.mjs for what that costs.
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

/* ------------------------------------------------------------------ studios
 *
 * The same two calls the performer page has, against a different source.
 * ThePornDB's mirror rather than IAFD, for the reason in studiofacts.mjs, and
 * with the same rule: gaps only, so nothing here can argue with Stash.
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
 * Those gaps, written. The proposal is rebuilt from a fresh read at the moment
 * of the click rather than taken from the open page — see the performer one.
 *
 * `urls` is replaced wholesale by studioUpdate, so the homepage is appended to
 * what is already there. Losing six database links to gain a front door would
 * be a poor trade. Same reasoning as setGroupUrl below.
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
 * Attach an address to a group, so Stash can scrape it.
 *
 * Additive: `urls` is replaced wholesale by groupUpdate, so whatever the group
 * already pointed at is read first and kept. A timestamp.trade link is still
 * the only thing that can size some of these films — losing it to gain a
 * scrapeable one would trade a real number for a cover picture.
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

/*
 * What Stash's own scrapers can read off an address, without writing anything.
 *
 * Handed straight to the page so the covers and the synopsis can be looked at
 * before they land on the group — a scraper matching the wrong cut of a film
 * is a thing you want to catch by eye, and the images come back as data URLs
 * that an <img> renders as-is.
 */
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

/*
 * Apply it. `fields` is what the page ticked, so a scrape that got the covers
 * right and the title wrong can be taken in part — the dialog decides, not
 * this.
 *
 * Duration comes back as "1:26:00" or "138:00" depending on the scraper, and
 * Stash wants seconds.
 */
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

  /*
   * These scrapers hand back whatever the page printed, and the older catalogue
   * entries print a bare year — "1999" for Panty World 8. Stash wants
   * YYYY-MM-DD and there is no honest way to invent the other two thirds of it,
   * so a partial date is refused by name rather than posted and guessed at.
   */
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
 * The order Stash itself keeps for a group, when it keeps one.
 *
 * `scene_index` is a field on the join rather than on the scene, so it cannot
 * come back with the cards — and in this library it is almost always null,
 * which is why the movie page has a naming rule to fall back on. It is asked
 * for anyway because when it *is* set it is the one answer nobody guessed.
 *
 * -> Map of scene id to index. An older Stash with no such field on the join
 * makes the whole query fail, and that is a missing ordering hint rather than
 * a missing group, so the caller swallows it.
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
 * One studio, and the cast you hold it through.
 *
 * `performer` narrows the scenes without narrowing the header: "what did she
 * film for them" is a question about the shelf, and the shelf is still the
 * whole studio while you ask it. So the count beside the name comes from the
 * library index rather than from the filtered query.
 *
 * `cast` is skipped when only the scenes are wanted — paging and the cast
 * filter both come back here, and neither is a reason to read every scene in
 * the studio again.
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

/*
 * Who is in this studio, counted in the library rather than in Stash.
 *
 * Read off the scenes themselves for the same reason libraryIndex is: a
 * performer's own scene_count includes files still sitting in the import
 * folder, and "12 here" has to mean twelve you can play. Their stash ids come
 * along raw — which of them is StashDB's is not a question this module knows
 * how to answer.
 */
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

/*
 * Type-ahead for the things a gallery can be tied to.
 *
 * Deliberately not the section views: those read every performer and every
 * studio in Stash to work out what you hold, which is the right answer for a
 * page and far too much for a search box. This asks Stash to do the matching
 * and takes twenty.
 */
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

/* ------------------------------------------------------------ scene detail
 *
 * The landing page. Alongside the scene it carries which stash-box identified
 * it, because that is the hook the acquisition side hangs on: TPDB means
 * Whisparr v2, StashDB means v3, neither means there is nothing to search for.
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

  /*
   * More like this: same studio, and the same cast. Deliberately two small
   * rails rather than one merged list — the reason you would pick one is the
   * reason it is there.
   */
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

/* ----------------------------------------------------------------- writes
 *
 * The light-touch half of a catalogue manager: the things you decide while
 * watching. Metadata surgery and identify runs stay in Stash, where the undo
 * lives — the same call as leaving retry and delete in Whisparr.
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
