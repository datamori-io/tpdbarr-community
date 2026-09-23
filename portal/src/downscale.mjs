/*
 * Making a file smaller, on purpose.
 *
 * Most of this library is 1080p and a fifth of the bulk is 4K — 446 scenes and
 * 1.6TB of it, against 172 scenes at 480p that come to forty gigabytes between
 * them. Some of those big files are things worth keeping and not things worth
 * keeping at that size, and there was no way to say so short of re-encoding
 * them by hand and re-importing.
 *
 * So: a button per scene, and what it does is exactly what it says. It
 * re-encodes the file at the height you asked for, checks the result, and then
 * **replaces the original** — which is the point, because a copy alongside
 * reclaims nothing. Everything below exists to make that last step safe enough
 * to do on a press.
 *
 * **Why the portal and not FileFlows.** FileFlows is the encoder in this
 * pipeline and it owns what happens to a file on the way in. This is a
 * different moment — a file that arrived, was filed, was watched, and is now
 * being cut down on a judgement made while looking at it — and routing that
 * back through the thing that files new arrivals would mean a flow, a watched
 * folder, and a round trip out of the library and back into it. One button and
 * one ffmpeg is the smaller arrangement.
 *
 * **What it will not touch**, each for its own reason:
 *
 *   - anything outside /organized_scenes. That folder is the filed library and
 *     the only one this container can write to. Everything else — the import
 *     folder, either Whisparr's, the PC import share — is somebody else's and
 *     is mounted read-only.
 *   - anything that is not .mp4. The output is mp4, and replacing a .mkv with
 *     mp4 bytes under the same name would leave a file lying about what it is;
 *     writing it beside instead would change the path, and a changed path is a
 *     scene Stash has to be re-tied to by hand.
 *   - anything already at or below the height asked for. There is nothing to
 *     win and an encode always loses a little.
 *
 * **The house format is H.264 at 720p**, changed on 2026-09-18 from HEVC for
 * ease rather than for size: h264 plays on everything without a codec argument,
 * and the hvc1/hev1 tagging trap that once made the whole library unplayable on
 * the phone simply does not exist here. The file is bigger for the same picture
 * and that is the trade being made on purpose.
 *
 * Still faststart, so it begins without reading to the end of the file first,
 * and still yuv420p at High profile — the combination every player in the house
 * agrees about.
 *
 * **This changes what the button makes, and nothing else.** FileFlows is still
 * the encoder for arrivals and still writes HEVC; a library-wide conversion is
 * its job and not this button's.
 */

import { spawn } from 'node:child_process';
import { rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import { gql } from './stash.mjs';

// 720 is what FileFlows makes of everything filed; 480 is for the ones worth
// keeping and not worth the space; 1080 is for a 4K file worth more than 720.
export const SIZES = [480, 720, 1080];

/*
 * Quality first, with a ceiling.
 *
 * The house figures are bitrates — 5.0-7.5 Mbps at 720p, 2.5-3.5 at 480p — but
 * encoding *to* a bitrate spends the whole budget on every scene, including the
 * still ones that did not need it, and runs out on the ones that did. CRF
 * spends what the picture actually costs. So the quality number leads and the
 * top of the house range is a cap: a busy scene is allowed up to it, a quiet
 * one comes in well under, and nothing goes over.
 *
 * The CRF values are chosen to land inside that range on this library's
 * material. x264's scale is not linear in the way people expect — the same CRF
 * looks worse the smaller the picture gets, because there are fewer pixels to
 * hide the loss in — so the smaller target gets the tighter number.
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

// How far the new file's duration may drift from the old one before the
// replacement is refused. A re-encode is frame-accurate; a second of slack is
// for a container rounding the last frame, not for a truncated file.
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
 * -> what a downscale of this scene would mean, or why it cannot happen.
 *
 * Asked by the page before it draws the buttons, so a scene that cannot be
 * shrunk says so in a sentence rather than offering a control that fails when
 * it is pressed.
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

/*
 * The encode itself, reporting as it goes.
 *
 * `-progress pipe:1` is ffmpeg saying where it has got to in the *source*
 * timeline, which against a duration we already know is the only honest
 * percentage available — counting written bytes would say nothing, since the
 * output size is what is being decided.
 */
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

      /*
       * The ceiling, not the target. `maxrate` alone does nothing — x264 needs
       * a buffer to rate-control against — so bufsize goes with it, at twice
       * the rate, which is the usual two-second window.
       */
      '-maxrate', qualityFor(height).maxrate,
      '-bufsize', qualityFor(height).bufsize,

      /*
       * What everything in the house agrees about. High profile is the ordinary
       * choice at this resolution, and yuv420p is stated rather than inherited
       * because a 10-bit or 4:2:2 source would otherwise produce a file that
       * only this machine can play.
       */
      '-profile:v', 'high',
      '-level', qualityFor(height).level,
      '-pix_fmt', 'yuv420p',

      // Re-encoded rather than copied: the source may be anything, and 128k
      // stereo aac is both universally playable and small enough not to matter
      // beside the picture.
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
 * Everything that has to be true before the original is allowed to go.
 *
 * This is the whole safety of the feature. A re-encode that produced a
 * truncated file, or a file that is somehow bigger, or one that is not the
 * height that was asked for, is a re-encode that gets thrown away — and the
 * original is untouched because nothing has been done to it yet.
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

/*
 * Tell Stash the file changed.
 *
 * The path is the same, so this is not an import — it is Stash re-reading a
 * file it already has a record of, and picking up the new size, height and
 * hash. Without it every page in here would go on quoting 4K and 3.6GB about
 * a file that is neither.
 */
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

/*
 * One at a time, and the same reasoning as the sprite strips and the marker
 * clips: this is a full decode and encode, it will take every core it is
 * given, and two at once only makes both slower and the machine unusable while
 * you are trying to watch something.
 */
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
