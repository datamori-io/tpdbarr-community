/*
 * A picture for a scene that has not got one.
 *
 * Stash never returns a 404 for a missing cover. It returns a 733-byte SVG
 * placeholder with a 200, which means the browser renders it happily and an
 * `onerror` handler on the <img> never fires — there is no way to tell from the
 * front end that a row has no picture. That is the whole reason this module
 * exists rather than a line of CSS.
 *
 * So the row asks here instead, and this decides:
 *
 *   a real cover  -> redirected to the media proxy, which already caches it
 *   the placeholder -> one frame cut out of the file with ffmpeg
 *
 * **Temporary on purpose.** Nothing here is written back to Stash. A generated
 * frame is a picture to work by while you are looking at the pile — the actual
 * cover is what arrives when you match the scene, from the box that knows what
 * the scene is. Deleting this whole directory costs nothing but the second it
 * takes to cut them again.
 *
 * The frame is cut at a quarter in. Not the first frame, which on this library
 * is a studio card or black; not the middle, which on a compilation is the
 * seam between two scenes as often as not. A quarter is far enough in to be
 * the scene and early enough to still be the scene that was named.
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

/*
 * Search frames are cut bigger, and it is the one place in here where file size
 * is the wrong thing to optimise for.
 *
 * A reverse image search is matching against the engine's index of the real
 * page's artwork, and 384 across is below what Lens and Yandex want — faces go
 * soft and the thing you are searching *on* is the detail. There are only ever
 * a handful of these per scene and they are pruned with everything else.
 */
const SEARCH_WIDTH = 960;
const QUALITY = 4;

/*
 * The same guard media.mjs keeps, and for the same reason: a path from Stash is
 * data from another service, not a licence to read the disk. A path that does
 * not resolve inside a mount we were given is not opened — it falls back to the
 * placeholder rather than being argued with.
 */
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

/*
 * A frame you asked for, rather than one cut to fill a gap.
 *
 * The double-click exists because some scenes *do* have a cover and it is a
 * black frame or a studio card — you looked at it and asked for something
 * better. That choice has to outlive the request, or the next page load puts
 * the cover you rejected straight back. A marker beside the frame rather than a
 * flag in memory, because a container restart is not you changing your mind.
 */
const chosenFor = (sceneId) => join(OUT, `${sceneId}.chosen`);

/* ------------------------------------------------------------- the decision
 *
 * Whether a scene has a cover is asked of Stash once and kept, because a page
 * of two dozen rows asks it two dozen times and the answer only changes when
 * somebody generates covers — which is not something that happens halfway down
 * a queue. Same five minutes everything else here is cached for.
 */
const TTL = 5 * 60 * 1000;
const decided = new Map(); // sceneId -> { has, at }

export const forget = () => decided.clear();

/*
 * Yes, recently, and we can act on it without asking Stash anything.
 *
 * This matters now that the whole library draws its pictures through here
 * rather than only the two working pages. A shelf is sixty tiles and almost all
 * of them have covers; without this every one of them costs a GraphQL query to
 * learn a filename we only ever use to redirect to an address we already know.
 * With it, a scene that has been seen once is a map lookup and a 302.
 *
 * Only the yes is short-circuited. A no has to go the long way, because the
 * long way is where the frame gets cut.
 */
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
    /*
     * The placeholder is an SVG and a real cover never is — Stash writes
     * generated covers as jpeg or png. Checking the type rather than the size
     * because the placeholder's size is not a promise anybody made.
     */
    const has = res.ok && !/svg/i.test(res.headers.get('content-type') || '');
    // The body is not wanted, only the type. Left unread, the socket stays open.
    res.body?.cancel().catch(() => {});
    decided.set(sceneId, { has, at: Date.now() });
    return has;
  } catch {
    /*
     * Stash unreachable is not evidence that the scene has no cover, and it is
     * not cached as if it were — but there is nothing to redirect to right now,
     * so this attempt cuts a frame. Which is the better answer anyway: the file
     * is on the mount and Stash is not in the way of it.
     */
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

/* ------------------------------------------------------------- the cutting
 *
 * Three at a time. A single frame with an input seek is cheap — a second or so
 * even on the share — but a page is two dozen rows arriving at once, and two
 * dozen ffmpegs reading over SMB is how you make a fast thing slow. Three keeps
 * the mount busy without queueing behind itself.
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

/*
 * The same cut, asked for twice, is one cut. Two rows for the same scene — or a
 * page reloaded while the first is still going — would otherwise both spawn an
 * ffmpeg and both write the same file, and the loser writes over the winner
 * mid-read.
 */
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
 * -> the path of a cached frame, or null if one could not be made.
 *
 * Written to a scratch name and renamed into place, so a reader either finds a
 * whole jpeg or finds nothing. A half-written one served at speed is a broken
 * image icon that survives in the browser cache long after the cut succeeded.
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

/*
 * A cap rather than an age. These are disposable and the only thing worth
 * defending against is the directory growing without anybody noticing, which
 * a count says better than a date does — you look at a pile of a few hundred
 * scenes, not at a rolling week of them.
 */
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
      // The marker goes with the frame it was about. Left behind it is a
      // zero-byte file that outlives its picture and says nothing about
      // anything — harmless, but it would accumulate for ever.
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
 * -> { redirect } to send the row at the real cover, or { file } to serve one
 * we cut, or { none } when there is no picture to be had.
 *
 * `force` skips the cover check and cuts regardless, which is what the row's
 * "cut one anyway" is for: some of these scenes do have a cover and it is a
 * black frame or a studio card, and the point of this page is that you are
 * looking at them to decide.
 */
/*
 * `cut` is the setting, off the config. When it is false this still answers —
 * with Stash's own picture, cover or placeholder — it just never reaches for
 * ffmpeg to fill a gap. A frame already cut is still served: it costs nothing,
 * it is already on the disk, and turning the setting off is a decision about
 * what to do next rather than an instruction to start showing blanks.
 *
 * `force` is the double-click, and it outranks the setting. That press is
 * somebody looking straight at a useless cover and asking for another one.
 */
export async function thumbFor(config, sceneId, { force = false, cut: allowed = true } = {}) {
  const id = String(sceneId);

  const ready = await cached(id);

  /*
   * A frame we cut is the fallback, and it has to stay the fallback.
   *
   * This used to return `ready` here, before the cover was considered at all —
   * which meant a frame cut while the scene was still unidentified was served
   * for ever, including long after the match landed and Stash had a real cover.
   * The scene page reads `/screenshot` directly and showed the artwork; every
   * tile on every shelf reads this route and went on showing a stale frame, and
   * the two never agreed again. SexArt's "Belle" was the one that turned it up:
   * 158KB of cover on the scene page, a 14KB frame on the tiles.
   *
   * The fallback further down (`if (ready)`) was always the right place for it.
   * So the cover question is asked first, and the two cheap answers below keep
   * that from costing a round trip per tile.
   */
  /*
   * A frame you picked beats the cover, every time and without asking Stash.
   * This is the one case where our picture is not a stand-in.
   */
  if (!force && ready && (await stat(chosenFor(id)).catch(() => null))) {
    return { file: ready };
  }

  if (!force && coverKnown(id)) return { redirect: `/media/scene/${id}/screenshot` };

  /*
   * Asked recently, told no, and there is already a frame on disk: that is last
   * answer repeated, and it costs nothing. Five minutes later it asks again,
   * which is how a cover that arrives after the cut gets noticed at all.
   */
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

  /*
   * Nothing here can be cut. Said as a redirect to the placeholder rather than
   * a 404, so a row whose file lives on a mount this container was not given
   * still draws the same shape as its neighbours.
   */
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

/*
 * The route. Kept here rather than in the server because the decision and the
 * three ways of answering it belong together.
 */
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

  /*
   * Cached in the browser for an hour, not a day. A generated frame is a
   * stand-in: the moment you match the scene the real cover lands, and an
   * hour is short enough that the row stops showing our guess on its own.
   */
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

/* ------------------------------------------------------- frames to search by
 *
 * The one frame above is a picture to *work* by — it fills a row so the scene
 * is not invisible. These are pictures to *search* by, which is a different
 * job with different rules.
 *
 * A reverse image search wants a frame that shows a face, a room, a title
 * card: something a search engine has seen before on the page you are trying
 * to find. One frame at 25% is a coin toss on that, and the honest fix is not
 * a cleverer heuristic — it is more frames, spread out, and your eye.
 *
 * **Named by where they are in the file, not by when they were cut.** A frame
 * is `<scene>.p25.jpg` — twenty-five per cent in — so asking for more is a
 * matter of taking the next offsets off the ladder that are not on disk yet,
 * and the same percentage always means the same picture. A counter would have
 * given you a different frame every time you reloaded.
 *
 * They are as disposable as the row thumbnails beside them and are pruned by
 * the same cap.
 */

/*
 * The order offsets are handed out in.
 *
 * Not evenly spaced and not in order: the first few need to be spread across
 * the whole file, because the thing that makes a frame searchable is that it
 * is different from the last one. Six frames at 10/20/30/40/50/60 are six
 * pictures of the same sofa. Later entries fill the gaps for when the first
 * pass showed nothing worth searching on.
 *
 * Nothing before 5% or after 92%: studio cards, black, and end credits.
 */
const LADDER = [25, 60, 10, 80, 40, 70, 15, 90, 33, 50, 5, 75, 20, 65, 45, 85, 30, 55];

const frameFile = (sceneId, pct) => join(OUT, `${sceneId}.p${pct}.jpg`);
const frameUrl = (sceneId, pct) => `/media/scene/${sceneId}/frame/${pct}`;

export const framePath = frameFile;

/*
 * Which offsets are already cut, in ladder order rather than numeric order —
 * the strip should read in the order you asked for them, so pressing "cut a
 * few more" appends rather than shuffling everything you were looking at.
 */
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
    /*
     * The mtime rides on the address. The offset alone is a stable name — 25%
     * is always the same picture — so the file is cached hard, and a frame
     * that has actually been recut would otherwise go on showing the old one
     * for a day. This is the only thing that can change about it, so this is
     * the only thing the address needs to carry.
     */
    frames: have.map(({ pct, at }) => ({ pct, url: `${frameUrl(id, pct)}?v=${at}` })),
    more: LADDER.length - have.length,
  };
}

/*
 * Cut the next few offsets that are not on disk.
 *
 * Sequential rather than parallel even though `lane` would allow three: these
 * are several seeks into *the same file* over SMB, and the share serves one
 * reader of one file better than it serves three. Measured as the difference
 * between "a moment" and "long enough to wonder".
 */
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
      // Renamed into place so a reader finds a whole jpeg or finds nothing —
      // a half-written one served at speed is a broken-image icon that lives
      // in the browser cache long after the cut succeeded.
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

/*
 * One frame off the disk. Only ever a file this module named, so the id and
 * the percentage are the whole of the input and neither reaches a path.
 */
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
