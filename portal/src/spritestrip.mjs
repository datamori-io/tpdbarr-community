/*
 * A sharper filmstrip, cut on demand.
 *
 * Stash generates one sprite sheet per scene and it is always about 81 tiles,
 * whatever the scene's length — on a 23-minute scene that is a picture every
 * 17.4 seconds, on a two-hour film one every 89. That is right for the scrub
 * bar it was made for, where a tile is a hover preview, and wrong for a
 * timeline, where the tiles *are* the ruler: at the bench's default zoom a
 * tile is 7.1 seconds wide, so every frame gets drawn two and a half times and
 * the strip smears rather than showing you the cut you are aiming at.
 *
 * So this cuts its own, a picture a second, from the source file.
 *
 * Measured on this library, on the scene the bench was built against — 23m33s,
 * 720p HEVC, 1.2 Mbps: **49 seconds** to produce 1,413 tiles across 15 sheets
 * totalling 4.2 MB. That is about 2% of realtime, which is what makes it worth
 * doing per scene on demand rather than never.
 *
 * Why not keyframes, which would be nearly free? Because this library's files
 * are x265 with scene-cut detection: the keyframes on that scene average eight
 * seconds apart and run to twenty-one at the worst gap. Cheap, irregular, and
 * barely better than what Stash already gives you. Decoding the whole file is
 * the only way to get an even second.
 *
 * Ten by ten at 160x90, so every sheet is exactly 1600x900 — the `tile` filter
 * pads the last one out to a full grid, which means the client needs one size
 * for all of them rather than probing each. A sheet is about 280 KB and only
 * the ones under the window are ever decoded.
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

/*
 * A picture a second, until that would be silly.
 *
 * The cap is on tiles rather than on minutes because what costs is the count:
 * 4,000 is about 40 sheets and 12 MB, which a two-hour film reaches at two
 * seconds and a six-hour compilation at six. Everything ordinary lands on 1.
 */
const MAX_TILES = 4000;

/*
 * Said out loud, both of them, because ffmpeg's own defaults leave most of
 * this machine idle. Measured on the same scene, from local disk:
 *
 *   default                       42.3s
 *   -threads N                    37.0s
 *   -threads N -filter_threads N  28.3s
 *
 * A third off for two flags. The decoder's default is not the problem — the
 * filter graph's is: `fps` and `tile` run on one thread unless told, and once
 * the decode is spread out they become the queue everything waits in.
 *
 * It still only reaches about four cores of twelve, and that is the real
 * ceiling: `tile` has to gather a hundred frames before it can emit a sheet,
 * which is a serial dependency no amount of threads removes.
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
 * -> the manifest, or null. Written last and into a directory that is moved
 * into place whole, so its presence is the only thing that has to be checked:
 * a killed build leaves a `.building` directory that nothing reads.
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

/*
 * Every strip held, with what it cost. The bench does not need this; the
 * question "what is this eating" does, and the answer lives nowhere else.
 */
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

/*
 * One scene's worth.
 *
 * `-progress` is not parsed for a percentage: ffmpeg reports frames written,
 * which for a `tile` filter is sheets, and counting the sheets on disk says
 * the same thing without a second format to keep in step with. The total is
 * arithmetic — duration over interval over a hundred.
 */
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
      /*
       * Scaled to fill and then cropped rather than letterboxed. A strip of
       * 2.35:1 scope frames with black bars top and bottom wastes a third of
       * the only 64 pixels of height the timeline has; cropping to 16:9 keeps
       * the middle, which is where the picture is.
       */
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

/*
 * One at a time, and the same reasoning as the marker clips: this is a full
 * decode and it will take every core it is given, so two at once only makes
 * both slower and the machine unusable while you are trying to work on it.
 */
export function build(config, sceneId) {
  if (running) return running;

  /*
   * Claimed here rather than inside cut(), which does not reach its own first
   * line until Stash has answered where the file is. The status route is
   * called in the same tick as this one — a page that starts a cut and is told
   * nothing is running would never begin polling.
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
 * What the bench asks on open, and again while a cut is running.
 *
 * `building` is only true for *this* scene — another scene's cut is somebody
 * else's business, and a page that showed a progress bar for it would be
 * lying about what it was waiting for. It is reported separately so the
 * button can say why it is refusing rather than just being dead.
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
