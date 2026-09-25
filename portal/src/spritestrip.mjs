/*
 * A sharper filmstrip, cut on demand.
 *
 * Stash's sprite sheet is ~81 tiles whatever the length, too coarse for a
 * timeline. This cuts one picture a second from the source file (about 2%
 * of realtime). Keyframes would be cheaper but are irregular on x265.
 *
 * Ten by ten at 160x90, so every sheet is 1600x900 (`tile` pads the last).
 */

import { mkdir, readdir, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

import { gql } from './stash.mjs';

const OUT = process.env.MARKER_STRIP_DIR || '/markerclips/strips';

const TILE_W = 160;
const TILE_H = 90;
const COLS = 10;
const ROWS = 10;
const PER_SHEET = COLS * ROWS;

// JPEG quality. 5 is visibly clean at 160 wide and a third the size of 2.
const QUALITY = 5;

/* One tile a second, capped at 4,000 tiles (the interval grows for long files). */
const MAX_TILES = 4000;

/*
 * Set threads for decode and the filter graph: `fps` and `tile` are
 * single-threaded by default and become the bottleneck.
 */
const THREADS = String(Math.max(1, availableParallelism()));

export const intervalFor = (duration) =>
  Math.max(1, Math.ceil((Number(duration) || 0) / MAX_TILES));

// ------------------------------------------------------------------- files

const dirFor = (sceneId) => join(OUT, String(sceneId));
const workingFor = (sceneId) => join(OUT, `.${sceneId}.building`);
const indexPath = (sceneId) => join(dirFor(sceneId), 'index.json');

export const sheetName = (n) => `s_${String(n).padStart(3, '0')}.jpg`;
export const sheetPath = (sceneId, n) => join(dirFor(sceneId), sheetName(n));

/*
 * -> the manifest, or null. Written last in a directory moved into place
 * whole, so a killed build leaves only an unread `.building` dir.
 */
export async function indexOf(sceneId) {
  try {
    return JSON.parse(await readFile(indexPath(sceneId), 'utf8'));
  } catch {
    return null;
  }
}

export async function remove(sceneId) {
  await rm(dirFor(sceneId), { recursive: true, force: true });
  await rm(workingFor(sceneId), { recursive: true, force: true });
  return { removed: String(sceneId) };
}

/* Every strip held, with its size. */
export async function held() {
  let names;
  try {
    names = await readdir(OUT, { withFileTypes: true });
  } catch {
    return { scenes: 0, sheets: 0 };
  }

  let scenes = 0;
  let sheets = 0;

  for (const entry of names) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const found = await indexOf(entry.name);
    if (!found) continue;
    scenes += 1;
    sheets += found.sheets || 0;
  }

  return { scenes, sheets };
}

// -------------------------------------------------------------------- work

function run(args, onNoise) {
  return new Promise((done, fail) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let noise = '';
    child.stderr.on('data', (chunk) => {
      noise = (noise + chunk).slice(-2000);
      if (onNoise) onNoise(String(chunk));
    });

    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(noise.split('\n').slice(-3).join(' ')))));
  });
}

async function sceneFile(config, sceneId) {
  const data = await gql(
    config,
    `query($id: ID!) { findScene(id: $id) { id files { path duration } } }`,
    { id: String(sceneId) }
  );

  const file = data.findScene?.files?.[0];
  if (!file?.path) throw new Error('Stash does not say where that scene\'s file is.');
  return { path: file.path, duration: Math.round(file.duration || 0) };
}

let running = null;
let progress = { sceneId: null, done: 0, total: 0, at: 0 };

export const busy = () => Boolean(running);
export const runningFor = () => progress.sceneId;

/* One scene. Progress counts sheets on disk; the total is arithmetic. */
async function cut(config, sceneId) {
  const { path, duration } = await sceneFile(config, sceneId);
  if (!duration) throw new Error('That file has no duration, so there is nothing to lay a strip against.');

  const interval = intervalFor(duration);
  const tiles = Math.ceil(duration / interval);
  const sheets = Math.ceil(tiles / PER_SHEET);

  const working = workingFor(sceneId);
  await rm(working, { recursive: true, force: true });
  await mkdir(working, { recursive: true });

  progress = { sceneId: String(sceneId), done: 0, total: sheets, at: Date.now() };

  const watch = setInterval(async () => {
    try {
      const names = await readdir(working);
      progress.done = names.filter((n) => n.endsWith('.jpg')).length;
    } catch { /* gone */ }
  }, 1500);

  try {
    await run([
      '-nostdin',
      '-y',
      '-threads', THREADS,
      '-filter_threads', THREADS,
      '-i', path,
      /* Fill and crop to 16:9, not letterbox: the strip is only 64px tall. */
      '-vf', `fps=1/${interval},scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=increase,crop=${TILE_W}:${TILE_H},tile=${COLS}x${ROWS}`,
      '-q:v', String(QUALITY),
      join(working, 's_%03d.jpg'),
    ]);
  } finally {
    clearInterval(watch);
  }

  const written = (await readdir(working)).filter((n) => n.endsWith('.jpg')).length;
  if (!written) throw new Error('ffmpeg produced no sheets.');

  await writeFile(join(working, 'index.json'), JSON.stringify({
    sceneId: String(sceneId),
    interval,
    tiles,
    sheets: written,
    cols: COLS,
    rows: ROWS,
    tile: { w: TILE_W, h: TILE_H },
    sheet: { w: COLS * TILE_W, h: ROWS * TILE_H },
    duration,
    at: Date.now(),
  }, null, 2));

  // Into place whole. Until this line there is nothing for a reader to find.
  await rm(dirFor(sceneId), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await rename(working, dirFor(sceneId));

  progress.done = written;
  progress.at = Date.now();

  return indexOf(sceneId);
}

/* One at a time: a full decode uses every core. */
export function build(config, sceneId) {
  if (running) return running;

  /*
   * Claimed here, before cut() awaits Stash, so a status check in the same
   * tick sees it running.
   */
  progress = { sceneId: String(sceneId), done: 0, total: 0, at: Date.now() };

  running = cut(config, sceneId)
    .catch((err) => {
      console.error('[tpdbarr] sprite strip', sceneId, err.message);
      progress = { ...progress, error: err.message, at: Date.now() };
    })
    .finally(() => { running = null; });

  return running;
}

/*
 * The bench's status call. `building` is true only for this scene;
 * another scene's cut is reported separately.
 */
export async function view(sceneId) {
  const id = String(sceneId);
  const index = await indexOf(id);
  const mine = busy() && progress.sceneId === id;

  return {
    strip: index
      ? {
          interval: index.interval,
          tiles: index.tiles,
          sheets: index.sheets,
          cols: index.cols,
          perSheet: index.cols * index.rows,
          tile: index.tile,
          sheet: index.sheet,
        }
      : null,
    building: mine,
    // Somebody else has the encoder. Named, so the page can say which.
    busyWith: !mine && busy() ? progress.sceneId : null,
    progress: mine ? { done: progress.done, total: progress.total } : null,
    error: mine ? null : progress.error && progress.sceneId === id ? progress.error : null,
  };
}
