/*
 * Our own marker clips at 720p. Stash always renders them at 640x360 and
 * has no setting for it (`maxTranscodeSize` only affects live streaming).
 *
 *   - `-2:720`: height fixed, width follows, so odd aspect ratios survive.
 *   - CRF 23, preset slow: much smaller than CRF 20 for no visible loss here.
 *   - Faststart.
 *
 * MP4, not animated WebP: the reel needs a <video>. CPU only; no GPU in
 * this container.
 */

import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { gql } from './stash.mjs';

const OUT = process.env.MARKER_CLIP_DIR || '/markerclips';

// The height everything is scaled to. Width follows the source's own shape.
const HEIGHT = 720;

// Lower is crisper, and every step down costs disk and time — see the note at
// the top for what the alternatives measured at.
const CRF = 23;
const PRESET = 'slow';

/*
 * How much of the scene a clip covers: a point marker gets a little before
 * and more after; a span gets a breath either side.
 */
const LEAD_IN = 5;
const RUN_ON = 35;
const EDGE = 2;

export function windowFor(marker) {
  const at = Math.max(0, Number(marker.seconds) || 0);
  const end = Number(marker.end_seconds) || 0;

  if (end > at) {
    const from = Math.max(0, at - EDGE);
    return { from, length: end + EDGE - from };
  }

  /*
   * Length is measured from where the clip actually starts (near the start
   * of a scene there's less lead-in).
   */
  const from = Math.max(0, at - LEAD_IN);
  return { from, length: at + RUN_ON - from };
}

// ------------------------------------------------------------------- files

export const clipName = (markerId) => `${markerId}.mp4`;
export const clipPath = (markerId) => join(OUT, clipName(markerId));

export async function has(markerId) {
  try {
    const info = await stat(clipPath(markerId));
    return info.size > 10000;
  } catch {
    return false;
  }
}

export async function held() {
  try {
    const names = await readdir(OUT);
    return names.filter((name) => name.endsWith('.mp4')).length;
  } catch {
    return 0;
  }
}

/* Delete clips whose markers are gone (on scene delete). Missing is fine. */
export async function remove(markerIds) {
  let gone = 0;

  for (const markerId of markerIds) {
    try {
      await unlink(clipPath(markerId));
      gone++;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  return gone;
}

// -------------------------------------------------------------------- work

function run(args) {
  return new Promise((done, fail) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let noise = '';
    child.stderr.on('data', (chunk) => { noise = (noise + chunk).slice(-2000); });

    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(noise.split('\n').slice(-3).join(' ')))));
  });
}

/* One clip, written to a temp name and moved into place on success. */
export async function render(marker) {
  const path = marker.scene?.files?.[0]?.path;
  if (!path) throw new Error(`marker ${marker.id} has no file`);

  const { from, length } = windowFor(marker);
  const target = clipPath(marker.id);
  const working = target + '.part';

  await mkdir(OUT, { recursive: true });

  await run([
    '-nostdin',
    '-y',
    /*
     * Force the muxer: the output is a .part file, and without `-f mp4` ffmpeg
     * fails with "Invalid argument".
     */
    // Before -i, so ffmpeg seeks to the point rather than decoding up to it.
    '-ss', String(from),
    '-i', path,
    '-t', String(length),
    '-vf', `scale=-2:${HEIGHT}`,
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', String(CRF),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    /*
     * Force the muxer: the output is a .part file, and without `-f mp4` ffmpeg
     * fails with "Invalid argument".
     */
    '-f', 'mp4',
    working,
  ]);

  await rename(working, target);
  return target;
}

// -------------------------------------------------------------------- pass

const MARKER = `
  id seconds end_seconds
  scene { id files { path } }
`;

async function markers(config) {
  const data = await gql(config, `{ findSceneMarkers(filter: {per_page: -1}) { scene_markers { ${MARKER} } } }`);
  return data.findSceneMarkers?.scene_markers || [];
}

let running = null;
let progress = { done: 0, total: 0, failed: 0, at: 0 };

export const busy = () => Boolean(running);
export const status = () => ({ ...progress, running: busy() });

/* Every marker without a clip, one at a time (x264 uses every core). */
async function pass(config, { force = false } = {}) {
  const list = await markers(config);
  progress = { done: 0, total: list.length, failed: 0, at: Date.now() };

  for (const marker of list) {
    if (!force && (await has(marker.id))) {
      progress.done += 1;
      continue;
    }

    try {
      await render(marker);
      progress.done += 1;
    } catch (err) {
      progress.failed += 1;
      console.error('[tpdbarr] marker clip', marker.id, err.message);
    }
  }

  progress.at = Date.now();
  return progress;
}

export function generate(config, options) {
  if (running) return running;
  running = pass(config, options)
    .catch((err) => { console.error('[tpdbarr] marker clips', err); })
    .finally(() => { running = null; });
  return running;
}

export async function view(config) {
  const list = await markers(config).catch(() => []);
  return {
    ...status(),
    markers: list.length,
    clips: await held(),
    height: HEIGHT,
    crf: CRF,
    preset: PRESET,
  };
}
