/*
 * Chores over /organized_scenes (Manage › Stash): re-shelve files whose
 * names drifted, write .nfo files, write thumbnails.
 *
 * Run by the portal one at a time; the page polls. A move never overwrites
 * (same rule as filer.mjs); only the sidecar "overwrite all" presses overwrite.
 */

import { mkdir, readdir, rename as renameFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path';

import { gql } from './stash.mjs';
import { shelfFor } from './filer.mjs';
import * as share from './share.mjs';

const HOME = '/organized_scenes';

const inside = (path) => {
  const full = resolvePath(String(path || ''));
  return full.startsWith(HOME + '/');
};

const SCENE = `
  id title date details rating100 organized
  studio { name }
  performers { name }
  tags { name }
  stash_ids { endpoint stash_id }
  files { path duration size width height video_codec bit_rate }
  paths { screenshot }
`;

async function filed(config) {
  const data = await gql(
    config,
    `{ findScenes(scene_filter: {path: {value: "${HOME}/", modifier: INCLUDES}}, filter: {per_page: -1}) { scenes { ${SCENE} } } }`
  );
  return (data.findScenes?.scenes || []).filter((s) => inside(s.files?.[0]?.path));
}

const stemOf = (path) => basename(path, extname(path));

// ------------------------------------------------------------------ the run

let run = null;

const snapshot = () => (run ? {
  kind: run.kind,
  label: run.label,
  total: run.total,
  done: run.done,
  changed: run.changed,
  skipped: run.skipped,
  failed: run.failed.slice(-20),
  failedCount: run.failed.length,
  over: run.over,
  stopping: run.stopping,
  note: run.note,
} : null);

export const state = () => ({ run: snapshot() });

export function stop() {
  if (run && !run.over) run.stopping = true;
  return state();
}

/* Run `work` over `scenes` in the background; return the first snapshot. */
function start(kind, label, scenes, work, after = null) {
  if (run && !run.over) throw Object.assign(new Error(`Already running: ${run.label}.`), { status: 409 });

  run = { kind, label, total: scenes.length, done: 0, changed: 0, skipped: 0, failed: [], over: false, stopping: false, note: '' };
  const mine = run;

  (async () => {
    for (const scene of scenes) {
      if (mine.stopping) break;
      try {
        if (await work(scene)) mine.changed++;
        else mine.skipped++;
      } catch (err) {
        mine.failed.push({ id: scene.id, title: scene.title || '', why: err.message });
      }
      mine.done++;
    }
    if (after) {
      try { mine.note = await after(mine); } catch (err) { mine.note = err.message; }
    }
    mine.over = true;
  })();

  return state();
}

// ------------------------------------------------------------ re-shelving

/* -> { from, to, dir } or { why }, or null when already in place. */
function place(scene) {
  if ((scene.files || []).length > 1) return { why: 'Two files on one scene — look at it rather than move half of it.' };
  const from = scene.files[0].path;
  const shelf = shelfFor(scene, from);
  if (shelf.why) return { why: shelf.why };
  // The share ignores case, so a case-only rename is churn.
  if (shelf.to.toLowerCase() === from.toLowerCase()) return null;
  return { from, to: shelf.to, dir: shelf.dir };
}

/*
 * The rename plan, never writes: moves, already right, can't, and copies.
 * Copies (destination taken) are listed in full for you to decide.
 */
async function sort(scenes) {
  const holder = new Map();
  for (const s of scenes) for (const f of s.files || []) holder.set(f.path.toLowerCase(), s);

  const moves = [];
  const copies = [];
  const cannot = [];
  let right = 0;
  let waiting = 0;
  const gone = [];

  for (const scene of scenes) {
    const p = place(scene);
    if (!p) { right++; continue; }
    if (p.why) { cannot.push({ id: scene.id, path: scene.files[0].path, why: p.why }); continue; }

    const [here, there] = await Promise.all([stat(p.from).catch(() => null), stat(p.to).catch(() => null)]);

    if (!here) {
      // Not at the old path: either moved (Stash not rescanned) or gone. Not a move.
      if (there) waiting++;
      else gone.push({ id: scene.id, path: p.from });
      continue;
    }

    if (!there) { moves.push({ scene, id: scene.id, from: p.from, to: p.to }); continue; }

    const other = holder.get(p.to.toLowerCase());
    const mine = scene.files[0];
    const theirs = other?.files?.find((f) => f.path.toLowerCase() === p.to.toLowerCase()) || null;
    const alike = theirs ? sameLength(mine, theirs) : false;
    const verdict = alike ? better(mine, theirs) : 0;
    copies.push({
      quality: quality(mine),
      filedQuality: theirs ? quality(theirs) : '',
      keep: !theirs ? 'unknown' : !alike ? 'length' : verdict > 0 ? 'loose' : verdict < 0 ? 'filed' : 'tie',
      duration: mine.duration || 0,
      filedDuration: theirs?.duration || 0,
      id: scene.id,
      path: p.from,
      size: scene.files[0].size || 0,
      filedId: other?.id || null,
      filedPath: p.to,
      filedSize: there.size,
    });
  }

  return { moves, copies, cannot, right, waiting, gone };
}

export async function reshelvePlan(config) {
  const scenes = await filed(config);
  const { moves, copies, cannot, right, waiting, gone } = await sort(scenes);

  return {
    scenes: scenes.length,
    right,
    waiting,
    gone,
    moves: moves.length,
    copies,
    cannot: cannot.length,
    sampleMoves: moves.slice(0, 25).map(({ id, from, to }) => ({ id, from, to })),
    sampleCannot: cannot.slice(0, 25),
  };
}

/*
 * The sidecars that travel with a video: anything in its folder named after
 * it — `<stem>.nfo`, `<stem>-thumb.jpg`, `<stem>.en.srt`. Other files in the
 * folder belong to the folder, not to the video, and stay.
 */
async function sidecars(from) {
  const dir = dirname(from);
  const stem = stemOf(from);
  const names = await readdir(dir).catch(() => []);
  return names.filter((name) => name !== basename(from)
    && (name.startsWith(stem + '.') || name.startsWith(stem + '-')));
}

async function moveOne(config, scene) {
  const p = place(scene);
  if (!p) return false;
  if (p.why) throw new Error(p.why);

  // Re-read from disk at the moment of the move: the plan the page showed may
  // be minutes old, and a second scene may have claimed the name since.
  if (await stat(p.to).catch(() => null)) throw new Error(`There is already a file at ${p.to}.`);

  const routed = await share.route(p.from, p.to);
  const extras = await sidecars(p.from);

  await mkdir(dirname(routed.to), { recursive: true });
  await renameFile(routed.from, routed.to);

  const oldStem = stemOf(p.from);
  const newStem = stemOf(p.to);
  for (const name of extras) {
    const src = join(dirname(routed.from), name);
    const dst = join(dirname(routed.to), newStem + name.slice(oldStem.length));
    if (await stat(dst).catch(() => null)) continue;
    await renameFile(src, dst).catch(() => {});
  }

  // Only a folder that is now truly empty goes. rmdir refuses anything else,
  // which is the point — a .DS_Store or a stray file keeps it.
  if (dirname(p.from) !== HOME) await rmdir(dirname(routed.from)).catch(() => {});

  return true;
}

export async function reshelve(config) {
  // Only the ones that can actually move. Copies and the can't-place pile are
  // in the plan for you to look at; attempting them only fills the run with
  // failures that were known before it started.
  const { moves } = await sort(await filed(config));
  const scenes = moves.map((m) => m.scene);

  return start('reshelve', 'Renaming in organized', scenes, (scene) => moveOne(config, scene), async (mine) => {
    if (!mine.changed) return '';
    /* One scan fixes every moved record (Stash follows fingerprints). */
    await gql(config, 'mutation($p: [String!]) { metadataScan(input: {paths: $p}) }', { p: [HOME] });
    return 'Asked Stash to rescan /organized_scenes so it follows the moves.';
  });
}

// ------------------------------------------------------------ second copies

/*
 * Keep the better of each copy pair, delete the other.
 *
 * Better is quality, not size:
 *   1. more pixels
 *   2. same resolution: newer codec (AV1/HEVC over H.264 over older)
 *   3. same codec: higher bitrate
 *
 * The filed scene's record is kept. The loose scene is merged into it
 * (sceneMerge, history included), the losing file deleted through Stash
 * (deleteFiles), and a loose winner moved into the filed slot. A failure
 * between delete and move leaves the winner attached; the next re-shelve
 * files it.
 */
const FILES = 'files { id path size width height video_codec bit_rate duration }';

const CODEC = (codec) => {
  const c = String(codec || '').toLowerCase();
  if (/av1|av01/.test(c)) return 3;
  if (/hevc|h265|hvc1|hev1/.test(c)) return 3;
  if (/h264|avc/.test(c)) return 2;
  return 1;
};

/*
 * Two files of different lengths are not two copies of one thing — one is cut
 * short, or it is a different scene that happens to share a title and a date.
 * Seen on the first plan: 0.19 GB against 0.46 GB at the same bitrate. Those
 * are left alone; ten seconds or 2% either way is the same scene with a
 * different intro card.
 */
export const sameLength = (a, b) => {
  if (!a.duration || !b.duration) return false;
  const gap = Math.abs(a.duration - b.duration);
  return gap <= Math.max(10, 0.02 * Math.max(a.duration, b.duration));
};

// -> positive when a is better than b, negative when worse, 0 for a tie.
export function better(a, b) {
  const pixels = (a.width || 0) * (a.height || 0) - (b.width || 0) * (b.height || 0);
  if (pixels) return pixels;
  const codec = CODEC(a.video_codec) - CODEC(b.video_codec);
  if (codec) return codec;
  // Within a few percent is the same encode as far as anyone can see.
  const rate = (a.bit_rate || 0) - (b.bit_rate || 0);
  return Math.abs(rate) > 0.05 * Math.max(a.bit_rate || 0, b.bit_rate || 0) ? rate : 0;
}

export const quality = (f) =>
  [f.height ? `${f.height}p` : '', String(f.video_codec || '').toUpperCase(),
    f.bit_rate ? `${(f.bit_rate / 1e6).toFixed(1)} Mbps` : ''].filter(Boolean).join(' ');

async function sceneFiles(config, id) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { id ${FILES} } }`, { id: String(id) });
  if (!data.findScene) throw new Error(`Stash has no scene ${id} any more.`);
  return data.findScene.files || [];
}

async function keepOne(config, copy) {
  if (!copy.filedId) throw new Error('Stash has not caught up with the filed copy yet — scan organized, then try again.');

  const [looseFiles, filedFiles] = await Promise.all([sceneFiles(config, copy.id), sceneFiles(config, copy.filedId)]);
  const loose = looseFiles.find((f) => f.path === copy.path);
  const filed = filedFiles.find((f) => f.path.toLowerCase() === copy.filedPath.toLowerCase());
  if (looseFiles.length !== 1 || !loose) throw new Error('The loose scene is not the one file it was when the plan was made.');
  if (!filed) throw new Error('The filed scene no longer holds the file at that path.');

  const [a, b] = await Promise.all([stat(loose.path).catch(() => null), stat(filed.path).catch(() => null)]);
  if (!a || !b) throw new Error('One of the two files is not on the disk any more.');

  if (!sameLength(loose, filed)) return false;
  const verdict = better(loose, filed);
  if (!verdict) return false;

  await gql(
    config,
    'mutation($i: SceneMergeInput!) { sceneMerge(input: $i) { id } }',
    { i: { source: [String(copy.id)], destination: String(copy.filedId), play_history: true, o_history: true } }
  );

  const looseWins = verdict > 0;
  await gql(config, 'mutation($ids: [ID!]!) { deleteFiles(ids: $ids) }', { ids: [looseWins ? filed.id : loose.id] });

  if (looseWins) {
    await gql(
      config,
      'mutation($i: MoveFilesInput!) { moveFiles(input: $i) }',
      { i: { ids: [loose.id], destination_folder: dirname(filed.path), destination_basename: basename(filed.path) } }
    );
  }

  return true;
}

export async function keepBetter(config) {
  const { copies } = await sort(await filed(config));
  return start('copies', 'Keeping the better copy', copies, (copy) => keepOne(config, copy));
}

// ------------------------------------------------------------------- nfo

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const element = (name, value) =>
  value === null || value === undefined || value === '' ? null : `  <${name}>${escape(value)}</${name}>`;

// "stashdb.org" out of "https://stashdb.org/graphql" — what the uniqueid is from.
const sourceOf = (endpoint) => {
  try { return new URL(endpoint).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'stash'; }
};

/* Kodi/Emby movie.nfo, same shape as gapfill.mjs writes. */
function buildNfo(scene) {
  const year = scene.date ? String(scene.date).slice(0, 4) : null;
  const minutes = scene.files?.[0]?.duration ? Math.round(scene.files[0].duration / 60) : null;

  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    '<movie>',
    scene.details ? `  <plot><![CDATA[${String(scene.details).replace(/]]>/g, ']]]]><![CDATA[>')}]]></plot>` : null,
    element('title', scene.title),
    element('originaltitle', scene.title),
    element('sorttitle', scene.title),
    element('year', year),
    element('premiered', scene.date || null),
    element('releasedate', scene.date || null),
    element('studio', scene.studio?.name || null),
    minutes ? element('runtime', minutes) : null,
    typeof scene.rating100 === 'number' ? element('userrating', Math.round(scene.rating100 / 10)) : null,
    ...(scene.performers || []).map((p) =>
      ['  <actor>', `    <name>${escape(p.name)}</name>`, '    <type>Actor</type>', '  </actor>'].join('\n')),
    ...(scene.tags || []).map((tag) => element('genre', tag.name)),
    `  <uniqueid type="stash" default="true">${escape(scene.id)}</uniqueid>`,
    ...(scene.stash_ids || []).map((s) =>
      `  <uniqueid type="${escape(sourceOf(s.endpoint))}">${escape(s.stash_id)}</uniqueid>`),
    '</movie>',
    '',
  ];

  return lines.filter((line) => line !== null).join('\n');
}

const nfoPath = (video) => join(dirname(video), stemOf(video) + '.nfo');

async function nfoOne(scene, overwrite) {
  const video = scene.files[0].path;
  const path = nfoPath(video);
  if (!overwrite && await stat(path).catch(() => null)) return false;
  if (!scene.title) throw new Error('No title — nothing to write an nfo about yet.');
  await writeFile(path, buildNfo(scene), 'utf8');
  return true;
}

export async function nfos(config, overwrite) {
  const scenes = await filed(config);
  return start(overwrite ? 'nfo-all' : 'nfo-missing',
    overwrite ? 'Overwriting every nfo' : 'Writing missing nfos',
    scenes, (scene) => nfoOne(scene, overwrite));
}

// ------------------------------------------------------------ thumbnails

/*
 * `<stem>-thumb.jpg` beside the video, from Stash's cover. A placeholder
 * (SVG, see scenethumb.mjs) is skipped as a failure.
 */
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const thumbBase = (video) => join(dirname(video), stemOf(video) + '-thumb');

async function thumbOne(config, scene, overwrite) {
  const video = scene.files[0].path;
  const base = thumbBase(video);

  if (!overwrite) {
    for (const ext of Object.values(EXT)) {
      if (await stat(base + ext).catch(() => null)) return false;
    }
  }

  const url = scene.paths?.screenshot;
  if (!url) throw new Error('Stash has no cover address for this scene.');

  const res = await fetch(url, {
    headers: config.stashApiKey ? { ApiKey: config.stashApiKey } : {},
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`cover -> ${res.status}`);

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = EXT[type];
  if (!ext) throw new Error('Stash has no cover for this scene yet.');

  await writeFile(base + ext, Buffer.from(await res.arrayBuffer()));
  return true;
}

export async function thumbs(config, overwrite) {
  const scenes = await filed(config);
  return start(overwrite ? 'thumbs-all' : 'thumbs-missing',
    overwrite ? 'Overwriting every thumbnail' : 'Writing missing thumbnails',
    scenes, (scene) => thumbOne(config, scene, overwrite));
}

// ------------------------------------------------------------ duplicates

/*
 * Stash's phash duplicate finder. A list only; delete from the scene page.
 * `distance`: 0 exact, 4 high, 8 medium.
 */
export async function duplicates(config, distance = 0) {
  const d = Math.max(0, Math.min(10, Number(distance) || 0));
  const data = await gql(
    config,
    `query($d: Int) { findDuplicateScenes(distance: $d, duration_diff: 1) {
      id title date studio { name } paths { screenshot }
      files { path size width height duration }
    } }`,
    { d }
  );

  const groups = (data.findDuplicateScenes || []).map((group) => group.map((s) => ({
    id: s.id,
    title: s.title || '',
    date: s.date || '',
    studio: s.studio?.name || '',
    path: s.files?.[0]?.path || '',
    size: s.files?.[0]?.size || 0,
    width: s.files?.[0]?.width || 0,
    height: s.files?.[0]?.height || 0,
    duration: s.files?.[0]?.duration || 0,
  })));

  return { distance: d, groups };
}
