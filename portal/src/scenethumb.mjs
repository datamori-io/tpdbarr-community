/*
 * A picture for a scene with no cover.
 *
 * Stash answers a missing cover with a 200 and an SVG placeholder, so the
 * browser can't tell. This decides instead:
 *
 *   a real cover    -> redirect to the media proxy
 *   the placeholder -> one frame cut with ffmpeg, a quarter of the way in
 *
 * Frames are never written to Stash; this folder is disposable.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import { gql } from './stash.mjs';

const OUT = process.env.SCENE_THUMB_DIR || '/markerclips/thumbs';

// Wide enough for the row at two-times, small enough that a hundred of them is
// a couple of megabytes. The row draws it at 176.
const WIDTH = 384;

/* Search frames are cut larger: reverse image search needs detail. */
const SEARCH_WIDTH = 960;
const QUALITY = 4;

/* Only open paths inside our mounts (same guard as media.mjs). */
const MEDIA_ROOTS = [
  '/organized_scenes',
  '/Import Folder',
  '/Whisparr-v3',
  '/Whisparr-v2',
  '/pc-import',
  '/movies',
  '/markerclips',
];

const insideRoots = (path) => {
  const full = resolvePath(path);
  return MEDIA_ROOTS.some((root) => full === root || full.startsWith(root + '/'));
};

const fileFor = (sceneId) => join(OUT, `${sceneId}.jpg`);

/* A frame you asked for (double-click), kept across restarts by a marker file. */
const chosenFor = (sceneId) => join(OUT, `${sceneId}.chosen`);

/*
 * ------------------------------------------------------------- the decision
 *
 * Whether a scene has a cover, cached five minutes.
 */
const TTL = 5 * 60 * 1000;
const decided = new Map(); // sceneId -> { has, at }

export const forget = () => decided.clear();

/* A recent yes skips Stash entirely. Only yes is short-circuited. */
const coverKnown = (id) => {
  const hit = decided.get(id);
  return Boolean(hit && hit.has && Date.now() - hit.at < TTL);
};

async function hasCover(config, sceneId, screenshot) {
  const hit = decided.get(sceneId);
  if (hit && Date.now() - hit.at < TTL) return hit.has;

  try {
    const headers = config.stashApiKey ? { ApiKey: config.stashApiKey } : {};
    const res = await fetch(screenshot, { headers });
    /* The placeholder is SVG; real covers are jpeg or png. */
    const has = res.ok && !/svg/i.test(res.headers.get('content-type') || '');
    // The body is not wanted, only the type. Left unread, the socket stays open.
    res.body?.cancel().catch(() => {});
    decided.set(sceneId, { has, at: Date.now() });
    return has;
  } catch {
    /* Stash unreachable: not cached, and cut a frame this time. */
    return false;
  }
}

async function sceneFile(config, sceneId) {
  const data = await gql(
    config,
    'query($id: ID!) { findScene(id: $id) { paths { screenshot } files { path duration } } }',
    { id: String(sceneId) }
  );

  const scene = data.findScene;
  if (!scene) throw new Error('Stash has no scene with that id.');

  const file = scene.files?.[0] || null;
  return {
    screenshot: scene.paths?.screenshot || null,
    path: file?.path || null,
    duration: Math.round(file?.duration || 0),
  };
}

/*
 * ------------------------------------------------------------- the cutting
 *
 * Three cuts at a time, so a page of rows doesn't swamp the share.
 */
const LANES = 3;
let running = 0;
const waiting = [];

const lane = () =>
  running < LANES
    ? (running += 1, Promise.resolve())
    : new Promise((go) => waiting.push(go)).then(() => { running += 1; });

const release = () => {
  running -= 1;
  waiting.shift()?.();
};

/* Duplicate requests share one cut. */
const inflight = new Map();

function grab(path, seconds, out, width = WIDTH) {
  return new Promise((done, fail) => {
    const child = spawn('ffmpeg', [
      '-nostdin',
      '-y',
      // Before -i, so ffmpeg seeks the container rather than decoding up to it.
      // On a two-hour file that is the difference between a second and a minute.
      '-ss', String(seconds),
      '-i', path,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', String(QUALITY),
      out,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let noise = '';
    child.stderr.on('data', (chunk) => { noise = (noise + chunk).slice(-2000); });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(noise.split('\n').slice(-2).join(' ')))));
  });
}

/*
 * -> path of a cached frame, or null.
 * Written to a scratch name and renamed, so a reader never gets half a jpeg.
 */
async function cut(sceneId, path, duration) {
  const out = fileFor(sceneId);
  const working = join(OUT, `.${sceneId}.building.jpg`);

  await mkdir(OUT, { recursive: true });

  // A quarter in, and never past the end of a file whose duration Stash guessed.
  const at = duration > 4 ? Math.min(Math.floor(duration * 0.25), duration - 2) : 1;

  await lane();
  try {
    try {
      await grab(path, at, working);
    } catch {
      // A seek past the end, a container that will not seek, a truncated file
      // still being written by Whisparr. The first frame is always there.
      await grab(path, 0, working);
    }
    await rename(working, out);
    return out;
  } catch (err) {
    await unlink(working).catch(() => {});
    console.warn('[tpdbarr] no frame for scene', sceneId, '-', err.message);
    return null;
  } finally {
    release();
    prune().catch(() => {});
  }
}

/* Keep at most 600 frames. */
const KEEP = 600;
let pruning = false;

async function prune() {
  if (pruning) return;
  pruning = true;

  try {
    const names = (await readdir(OUT)).filter((n) => n.endsWith('.jpg') && !n.startsWith('.'));
    if (names.length <= KEEP) return;

    const dated = await Promise.all(names.map(async (name) => {
      const info = await stat(join(OUT, name)).catch(() => null);
      return info ? { name, at: info.mtimeMs } : null;
    }));

    const oldest = dated.filter(Boolean).sort((a, b) => a.at - b.at).slice(0, names.length - KEEP);
    for (const { name } of oldest) {
      await rm(join(OUT, name), { force: true });
      // Remove its marker with it.
      await rm(join(OUT, name.replace(/\.jpg$/, '.chosen')), { force: true });
    }
  } finally {
    pruning = false;
  }
}

/* ------------------------------------------------------------------ serving */

const cached = async (sceneId) => {
  const file = fileFor(sceneId);
  const info = await stat(file).catch(() => null);
  return info?.isFile() && info.size > 0 ? file : null;
};

/*
 * -> { redirect } to the real cover, { file } to serve a cut frame, or { none }.
 * `force` cuts regardless (for covers that are a black frame or studio card).
 */
/*
 * `cut` is the setting: off means never cut new frames (existing ones are
 * still served). `force` (the double-click) overrides it.
 */
export async function thumbFor(config, sceneId, { force = false, cut: allowed = true } = {}) {
  const id = String(sceneId);

  const ready = await cached(id);

  /*
   * Check the cover before serving a cut frame, or a frame cut before the
   * scene was matched is served forever.
   */
  /* A frame you picked beats the cover. */
  if (!force && ready && (await stat(chosenFor(id)).catch(() => null))) {
    return { file: ready };
  }

  if (!force && coverKnown(id)) return { redirect: `/media/scene/${id}/screenshot` };

  /* Recently told no and a frame exists: serve it. Re-asks after five minutes. */
  const settled = decided.get(id);
  if (!force && ready && settled && !settled.has && Date.now() - settled.at < TTL) {
    return { file: ready };
  }

  const { screenshot, path, duration } = await sceneFile(config, id);

  if (!force && screenshot && (await hasCover(config, id, screenshot))) {
    return { redirect: `/media/scene/${id}/screenshot` };
  }

  if (ready) return { file: ready };

  // The setting says no, and this is the gap it is about.
  if (!allowed && !force) {
    return screenshot ? { redirect: `/media/scene/${id}/screenshot` } : { none: true };
  }

  /* Can't be cut: redirect to the placeholder so the row keeps its shape. */
  if (!path || !insideRoots(path)) {
    return screenshot ? { redirect: `/media/scene/${id}/screenshot` } : { none: true };
  }

  if (!inflight.has(id)) {
    inflight.set(id, cut(id, path, duration).finally(() => inflight.delete(id)));
  }

  const made = await inflight.get(id);
  if (made) {
    // Only a forced cut is a choice. One cut to fill a gap stays a stand-in and
    // steps aside the moment a real cover turns up.
    if (force) await writeFile(chosenFor(id), '').catch(() => {});
    return { file: made };
  }
  return screenshot ? { redirect: `/media/scene/${id}/screenshot` } : { none: true };
}

/* The route. */
export async function serve(config, req, res, sceneId, { force = false, cut = true } = {}) {
  let answer;
  try {
    answer = await thumbFor(config, sceneId, { force, cut });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end(err.message);
    return;
  }

  if (answer.redirect) {
    res.writeHead(302, { Location: answer.redirect, 'Cache-Control': 'no-store' }).end();
    return;
  }

  if (!answer.file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no picture for that scene');
    return;
  }

  const info = await stat(answer.file).catch(() => null);
  if (!info) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no picture for that scene');
    return;
  }

  /* An hour, not a day: a real cover may arrive soon. */
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': info.size,
    'Cache-Control': 'public, max-age=3600',
    'X-Served-From': 'ffmpeg',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const source = createReadStream(answer.file);
  res.on('close', () => source.destroy());
  source.on('error', () => res.destroyed || res.destroy());
  source.pipe(res);
}

/*
 * ------------------------------------------------------- frames to search by
 *
 * More frames, spread through the file, for reverse image search.
 * Named by position (`<scene>.p25.jpg`) so each one is stable. Pruned with the rest.
 */

/*
 * Offsets in the order they're cut: spread out first, gaps filled later.
 * Nothing before 5% or after 92%.
 */
const LADDER = [25, 60, 10, 80, 40, 70, 15, 90, 33, 50, 5, 75, 20, 65, 45, 85, 30, 55];

const frameFile = (sceneId, pct) => join(OUT, `${sceneId}.p${pct}.jpg`);
const frameUrl = (sceneId, pct) => `/media/scene/${sceneId}/frame/${pct}`;

export const framePath = frameFile;

/* Cut offsets, in ladder order, so new ones append. */
async function onDisk(sceneId) {
  const names = await readdir(OUT).catch(() => []);
  const mine = new Map();

  for (const name of names) {
    const hit = name.match(/^(\d+)\.p(\d+)\.jpg$/);
    if (!hit || hit[1] !== String(sceneId)) continue;
    const info = await stat(join(OUT, name)).catch(() => null);
    if (info?.isFile() && info.size) mine.set(Number(hit[2]), Math.round(info.mtimeMs));
  }

  return LADDER.filter((pct) => mine.has(pct)).map((pct) => ({ pct, at: mine.get(pct) }));
}

export async function frames(config, sceneId) {
  const id = String(sceneId);
  const have = await onDisk(id);
  return {
    scene: id,
    /* The mtime busts the cache if a frame is recut. */
    frames: have.map(({ pct, at }) => ({ pct, url: `${frameUrl(id, pct)}?v=${at}` })),
    more: LADDER.length - have.length,
  };
}

/* Cut the next few missing offsets. One at a time: several seeks into one file over SMB. */
const MOST_AT_ONCE = 6;

export async function cutFrames(config, sceneId, { count = MOST_AT_ONCE } = {}) {
  const id = String(sceneId);
  const { path, duration } = await sceneFile(config, id);

  if (!path || !insideRoots(path)) {
    throw new Error('That scene’s file is not on a mount this portal was given.');
  }
  if (!duration || duration < 4) {
    throw new Error('Stash reports no usable duration for that file, so there is nowhere to seek to.');
  }

  const have = new Set((await onDisk(id)).map((f) => f.pct));
  const wanted = LADDER
    .filter((pct) => !have.has(pct))
    .slice(0, Math.min(MOST_AT_ONCE, Math.max(1, Number(count) || MOST_AT_ONCE)));

  if (!wanted.length) {
    return { ...(await frames(config, id)), cut: 0, why: 'Every offset has already been cut.' };
  }

  await mkdir(OUT, { recursive: true });

  let cut = 0;
  const failed = [];

  for (const pct of wanted) {
    const at = Math.min(Math.floor((duration * pct) / 100), duration - 2);
    const out = frameFile(id, pct);
    const working = join(OUT, `.${id}.p${pct}.building.jpg`);

    await lane();
    try {
      await grab(path, at, working, SEARCH_WIDTH);
      // Renamed into place so a reader never gets half a jpeg.
      await rename(working, out);
      cut += 1;
    } catch (err) {
      await unlink(working).catch(() => {});
      failed.push(`${pct}%: ${err.message}`);
    } finally {
      release();
    }
  }

  prune().catch(() => {});

  return {
    ...(await frames(config, id)),
    cut,
    why: failed.length ? `Could not cut ${failed.length} of them.` : '',
  };
}

/* One frame off the disk. Only files this module named. */
export async function serveFrame(req, res, sceneId, pct) {
  const n = Number(pct);
  if (!LADDER.includes(n)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No frame at that offset.');
    return;
  }

  const file = frameFile(String(sceneId), n);
  const info = await stat(file).catch(() => null);

  if (!info?.isFile() || !info.size) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('That frame has not been cut.');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': String(info.size),
    // Named by offset, so the same URL is always the same picture and the
    // browser may keep it for as long as it likes.
    'Cache-Control': 'public, max-age=86400',
  });

  if (req.method === 'HEAD') return res.end();

  const source = createReadStream(file);
  source.on('error', () => res.destroy());
  res.on('close', () => source.destroy());
  source.pipe(res);
}
