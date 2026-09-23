/*
 * Our own marker clips.
 *
 * Stash renders one per marker already, and they are 640x360 — for a 1080p
 * scene, for a 4K one, for everything. That number is not a setting: it is not
 * in the config file, it is not in `configureGeneral`, and `GenerateMetadata`
 * takes no size argument at all. `maxTranscodeSize` looks like the answer and
 * is not — it governs live streaming transcodes, not generated files, which is
 * why scene previews come out 640x360 too.
 *
 * So this cuts its own, at 720, from the source file.
 *
 *   - Scaled by height with the width following (`-2:720`), not forced to
 *     1280x720. This library has 2.35:1 scope films and 4096x2160 material,
 *     and forcing a shape either distorts them or encodes black bars.
 *   - CRF 23 and preset slow. Measured on this library: crf 20 gave 11MB and
 *     35s a clip, crf 23 gives 7MB and 26s, and at 720 in a phone-shaped frame
 *     the difference is not what you would spend nine hours and 6GB on.
 *   - Faststart, because these are new files and there is no reason to repeat
 *     the mistake that cost an afternoon of scrubbing.
 *
 * MP4, not animated WebP. WebP is an image: it cannot go in a <video>, and the
 * reel's scrubbing, sound, play/pause and roll-on-first-loop all go with it.
 * WebP is the right output for Stash's own grid hovers, not for this.
 *
 * On the GPU: it cannot help here in the way it looks like it should. NVENC
 * encodes H.264, HEVC and AV1 — there is no WebP encoder on a GPU at all — and
 * this container has no device passed to it in any case. It is CPU work.
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
 * How much of the scene a clip covers.
 *
 * A marker with only an entry point is a moment someone dropped a pin on, and
 * the interesting part is mostly after it — so the clip opens a little before
 * and runs well past. A marker with an in and an out is already a decided
 * span, so it only gets a breath either side.
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
   * The span is the marker's own point either side, and the length is measured
   * from wherever the clip actually starts — a marker four seconds into a
   * scene cannot have five seconds of lead-in, and computing the length from
   * the nominal window rather than the real one made those clips longer than
   * asked for instead of shorter.
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

/*
 * Clips whose marker has gone. Called when a scene is deleted: the markers go
 * with it, so nothing else knows these files exist. Missing is success — the
 * clip may never have been rendered.
 */
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

/*
 * One clip. Written to a temporary name and moved into place only once ffmpeg
 * has exited happily, so a killed pass never leaves a half-written file that
 * later looks like a finished one.
 */
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
     * Said out loud, because the output is written to a .part name and ffmpeg
     * picks its muxer off the extension. Without this every render died on
     * "Error opening output file ... Invalid argument", which reads like a
     * permissions problem and is not one.
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
     * Said out loud, because the output is written to a .part name and ffmpeg
     * picks its muxer off the extension. Without this every render died on
     * "Error opening output file ... Invalid argument", which reads like a
     * permissions problem and is not one.
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

/*
 * Every marker that has no clip yet. One at a time: this is x264 at preset
 * slow and it will take every core it is given, so running several at once
 * only makes each of them slower and the machine unusable.
 */
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
