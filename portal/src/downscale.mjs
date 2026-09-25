/*
 * Re-encode a filed scene smaller and replace the original.
 *
 * Refuses:
 *   - anything outside /organized_scenes (the only rw mount)
 *   - anything not .mp4 (the output is mp4, and a new path would unlink Stash)
 *   - anything already at or below the target height
 *
 * Output is H.264 High, yuv420p, faststart — plays everywhere. FileFlows
 * still encodes arrivals as HEVC; this button doesn't change that.
 */

import { spawn } from 'node:child_process';
import { rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import { gql } from './stash.mjs';

// 720 is what FileFlows makes of everything filed; 480 is for the ones worth
// keeping and not worth the space; 1080 is for a 4K file worth more than 720.
export const SIZES = [480, 720, 1080];

/*
 * CRF with a maxrate ceiling (5.0-7.5 Mbps at 720p, 2.5-3.5 at 480p), so
 * quiet scenes come in under. Smaller targets get a tighter CRF.
 */
// 1080's ceiling is FileFlows' own (MaxBitrate 10000 in "H264 Encoding
// (Fast)"), and its level is 4.2 because 4.0 stops at 1080p30.
const QUALITY = {
  480: { crf: 20, maxrate: '3.5M', bufsize: '7M', level: '4.0' },
  720: { crf: 19, maxrate: '7.5M', bufsize: '15M', level: '4.0' },
  1080: { crf: 19, maxrate: '10M', bufsize: '20M', level: '4.2' },
};

const qualityFor = (height) => QUALITY[height] || QUALITY[480];

// The only folder this can write to, and the only one it should.
const FILED = '/organized_scenes/';

// Allowed duration drift, in seconds.
const DRIFT = 1;

/* -------------------------------------------------------------- the state */

let running = null;
let job = {
  running: false,
  sceneId: null,
  height: 0,
  step: '',
  percent: 0,
  was: 0,
  now: 0,
  error: null,
  at: 0,
};

export const busy = () => Boolean(running);
export const status = () => ({ ...job, running: busy() });

const refuse = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

/* --------------------------------------------------------------- the file */

const FILE = `id title files { id path size duration width height video_codec }`;

async function fileOf(config, sceneId) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${FILE} } }`, { id: String(sceneId) });
  const scene = data.findScene;
  if (!scene) throw refuse('Stash has no scene with that id.');

  const file = scene.files?.[0];
  if (!file?.path) throw refuse('Stash does not say where that scene\'s file is.');

  return { scene, file };
}

/*
 * -> what a downscale would mean, or why it can't happen. Asked before
 * drawing the buttons.
 */
export async function plan(config, sceneId) {
  const { file } = await fileOf(config, sceneId);

  const why = (reason) => ({ can: false, reason, path: file.path, height: file.height || 0, size: file.size || 0 });

  if (!String(file.path).includes(FILED)) {
    return why('Only filed scenes can be re-encoded — this one is not in /organized_scenes.');
  }
  if (extname(file.path).toLowerCase() !== '.mp4') {
    return why('Only .mp4 files can be re-encoded in place; this one would have to change its name to change container.');
  }
  if (!file.height) {
    return why('Stash does not know how tall this file is.');
  }

  const sizes = SIZES.filter((h) => h < file.height);
  if (!sizes.length) return why(`Already ${file.height}p — there is nothing smaller on offer.`);

  return { can: true, reason: '', path: file.path, height: file.height, size: file.size || 0, sizes };
}

/* -------------------------------------------------------------- the encode */

const ffprobe = (path, fields) => new Promise((done, fail) => {
  const child = spawn('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', fields,
    '-of', 'default=noprint_wrappers=1:nokey=0',
    path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.on('error', fail);
  child.on('close', (code) => {
    if (code !== 0) return fail(new Error('ffprobe could not read the file it just wrote.'));
    const found = {};
    for (const line of out.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) found[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    done(found);
  });
});

/* The encode. Progress comes from `-progress pipe:1` against the known duration. */
function encode(from, to, height, duration) {
  return new Promise((done, fail) => {
    const child = spawn('ffmpeg', [
      '-nostdin',
      '-y',
      '-i', from,

      // -2 keeps the width even and the aspect what it was. An odd width is a
      // file half the players in the house will refuse.
      '-vf', `scale=-2:${height}`,

      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(qualityFor(height).crf),

      /* maxrate needs a bufsize; twice the rate. */
      '-maxrate', qualityFor(height).maxrate,
      '-bufsize', qualityFor(height).bufsize,

      /* High profile, yuv420p stated so 10-bit or 4:2:2 sources stay playable. */
      '-profile:v', 'high',
      '-level', qualityFor(height).level,
      '-pix_fmt', 'yuv420p',

      // Audio re-encoded to 128k stereo AAC.
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',

      '-map_metadata', '0',
      '-movflags', '+faststart',

      '-progress', 'pipe:1',
      '-v', 'error',
      to,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let noise = '';
    child.stderr.on('data', (chunk) => { noise = (noise + chunk).slice(-2000); });

    child.stdout.on('data', (chunk) => {
      const found = /out_time_ms=(\d+)/.exec(String(chunk));
      if (!found || !duration) return;
      const seconds = Number(found[1]) / 1e6;
      job.percent = Math.min(99, Math.round((seconds / duration) * 100));
      job.at = Date.now();
    });

    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(noise.split('\n').slice(-3).join(' ') || 'ffmpeg failed.'))));
  });
}

/*
 * Checks before the original goes: right height, same duration, smaller.
 * Otherwise the new file is discarded.
 */
async function vet(from, to, height, duration) {
  const made = await stat(to).catch(() => null);
  if (!made || !made.size) throw new Error('The encode produced nothing.');

  const probe = await ffprobe(to, 'stream=height:format=duration');

  const tall = Number(probe.height) || 0;
  if (tall !== height) throw new Error(`The new file is ${tall || 'an unknown number of'} pixels tall, not ${height}.`);

  const ran = Number(probe.duration) || 0;
  if (duration && Math.abs(ran - duration) > DRIFT) {
    throw new Error(`The new file runs ${Math.round(ran)}s against the original's ${Math.round(duration)}s.`);
  }

  const before = await stat(from);
  if (made.size >= before.size) {
    throw new Error('The new file is no smaller than the original, so there is nothing to gain by keeping it.');
  }

  return { was: before.size, now: made.size };
}

/* Rescan the same path so Stash picks up the new size, height and hash. */
async function rescan(config, path) {
  await gql(
    config,
    `mutation($p: [String!]) { metadataScan(input: {paths: $p}) }`,
    { p: [dirname(path)] }
  ).catch((err) => {
    // The file is already replaced by this point; a scan that would not start
    // is a stale record rather than a failure of the job.
    console.warn('[tpdbarr] downscale: Stash would not rescan -', err.message);
  });
}

async function work(config, sceneId, height) {
  const { file } = await fileOf(config, sceneId);
  const ready = await plan(config, sceneId);
  if (!ready.can) throw refuse(ready.reason);
  if (height >= file.height) throw refuse(`That file is already ${file.height}p.`);

  const from = file.path;
  // Beside the original so the rename at the end is a rename and not a copy
  // across mounts, and hidden so a scan that runs mid-encode ignores it.
  const to = join(dirname(from), `.${Date.now()}.downscale.mp4`);

  job = { ...job, step: 'encoding', percent: 0, was: file.size || 0, now: 0, at: Date.now() };

  try {
    await encode(from, to, height, file.duration || 0);

    job.step = 'checking';
    job.percent = 99;
    const sizes = await vet(from, to, height, file.duration || 0);

    job.step = 'replacing';
    await rename(to, from);
    job.was = sizes.was;
    job.now = sizes.now;

    job.step = 'rescanning';
    await rescan(config, from);

    job.step = 'done';
    job.percent = 100;
    return { was: sizes.was, now: sizes.now };
  } catch (err) {
    // Whatever went wrong, the half-written file does not stay on the disk.
    await unlink(to).catch(() => {});
    throw err;
  }
}

/* One at a time: it uses every core. */
export function start(config, sceneId, height) {
  if (running) throw refuse(`Already re-encoding scene ${job.sceneId}. One at a time — it takes every core it can get.`);
  if (!SIZES.includes(Number(height))) throw refuse('That is not a size this offers.');

  job = {
    running: true,
    sceneId: String(sceneId),
    height: Number(height),
    step: 'starting',
    percent: 0,
    was: 0,
    now: 0,
    error: null,
    at: Date.now(),
  };

  running = work(config, sceneId, Number(height))
    .catch((err) => {
      console.error('[tpdbarr] downscale', sceneId, err.message);
      job.error = err.message;
      job.step = 'failed';
    })
    .finally(() => {
      running = null;
      job.running = false;
      job.at = Date.now();
    });

  return status();
}
