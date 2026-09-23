/*
 * Media proxy.
 *
 * Everything the player needs — the video, the hover preview, the poster, the
 * scrub thumbnails — comes from Stash. The browser could fetch those straight
 * from Stash, but then the portal would have to hand it the Stash URL and API
 * key, and the page would break the moment either changed. So it goes through
 * here instead: one origin, no key in the browser, and Range requests passed
 * along untouched so seeking still works.
 */

import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve as resolvePath } from 'node:path';

import { gql } from './stash.mjs';

/* ------------------------------------------------- straight off the mount
 *
 * The portal mounts the same volume Stash files scenes into, so for most of
 * the library it is holding the actual file and does not need to ask Stash for
 * it. Serving it here takes Stash out of the playback path: one less hop, and
 * a scene still plays while Stash is unreachable — which on this machine it
 * periodically is, see the WinNAT note.
 *
 * It is a fallback, not a replacement. Stash still answers for everything the
 * folder does not know (all of the metadata), for every generated artefact
 * (posters, sprites, previews live in /generated, which is not mounted here),
 * and for any scene sitting in a folder this container cannot see — Import
 * Folder and the two Whisparrs are Stash's alone unless they get mounted too.
 *
 * **A path from Stash is not a licence to read the disk.** Stash is another
 * service and its answer is data, so a path is only served when it resolves
 * inside one of the media roots below; anything else falls back to the proxy
 * rather than being opened.
 */
const MEDIA_ROOTS = [
  '/organized_scenes',
  '/Import Folder',
  '/Whisparr-v3',
  '/Whisparr-v2',
  '/pc-import',
  '/movies',
  '/galleries',
  '/markerclips',
];

const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
};

/*
 * Where Stash says a scene's file is. Cached, because this is asked on every
 * seek and the answer only changes when a file moves through the pipeline —
 * hence a TTL rather than a permanent memo, so a scene that finishes encoding
 * starts being served locally without a restart.
 */
const PATH_TTL = 5 * 60 * 1000; // the same five minutes the shelf is cached for
const pathCache = new Map();

export const forgetPaths = () => pathCache.clear();

/*
 * The shelf already asks Stash for every scene's path, so it hands them over
 * rather than letting this ask again one at a time. It is also what makes the
 * fallback worth having: with the cache warm, a filed scene plays with Stash
 * unreachable, because nothing in the path from click to bytes touches it.
 */
export function rememberPaths(pairs) {
  const at = Date.now();
  for (const [id, path] of pairs) {
    if (path) pathCache.set(String(id), { path, at });
  }
}

async function scenePath(config, id) {
  const hit = pathCache.get(id);
  if (hit && Date.now() - hit.at < PATH_TTL) return hit.path;

  try {
    const data = await gql(config, 'query($id: ID!) { findScene(id: $id) { files { path } } }', { id });
    const path = data.findScene?.files?.[0]?.path || null;
    /*
     * Only an answer is kept. Caching the absence of one for five minutes was
     * a bug worth naming: a single Stash hiccup during a burst of requests
     * demoted that scene to the proxy for the whole window, and it looked for
     * all the world like the file was not on the mount. A failure here is
     * almost always transient, so the next request asks again.
     */
    if (path) pathCache.set(id, { path, at: Date.now() });
    return path;
  } catch {
    // Stash unreachable is exactly when the local file matters most — but
    // without a path there is nothing to open, so this falls through to the
    // proxy, which will fail the same way and say so.
    return null;
  }
}

const insideRoots = (path) => {
  const full = resolvePath(path);
  return MEDIA_ROOTS.some((root) => full === root || full.startsWith(root + '/'));
};

/*
 * -> true if it served the file, false to let the caller fall back to Stash.
 *
 * Range is the whole job. A browser asks for two bytes to find the duration
 * and then seeks by asking for the middle; answering 200 with the lot makes
 * Safari refuse to play at all, so an unsatisfiable range gets a 416 and every
 * other range gets a 206 with the three headers that describe it.
 */
async function serveFromDisk(req, res, path) {
  if (!path || !insideRoots(path)) return false;

  let info;
  try {
    info = await stat(path);
    if (!info.isFile()) return false;
  } catch {
    return false; // Not mounted here, or gone. Stash may still have it.
  }

  const type = VIDEO_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Last-Modified': info.mtime.toUTCString(),
    // Which half of this module answered, for when a file plays from one and
    // not the other.
    'X-Served-From': 'disk',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');

  if (!range) {
    res.writeHead(200, { ...base, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end(), true;
    pipe(createReadStream(path), res);
    return true;
  }

  // `bytes=-500` is the last 500, `bytes=500-` is from 500 to the end.
  const [, rawStart, rawEnd] = range;
  let start = rawStart === '' ? info.size - Number(rawEnd) : Number(rawStart);
  let end = rawStart === '' || rawEnd === '' ? info.size - 1 : Number(rawEnd);

  start = Math.max(0, start);
  end = Math.min(info.size - 1, end);

  if (!info.size || start > end || Number.isNaN(start) || Number.isNaN(end)) {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
    return true;
  }

  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${info.size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end(), true;

  pipe(createReadStream(path, { start, end }), res);
  return true;
}

// Seeking makes browsers hang up mid-file constantly; that is normal and not
// worth logging, but the read has to be destroyed or the handle leaks.
function pipe(source, res) {
  res.on('close', () => source.destroy());
  source.on('error', () => res.destroyed || res.destroy());
  source.pipe(res);
}

// Headers worth carrying in each direction. Range is the important one: without
// it the browser downloads a 3GB file to jump to the middle.
const FORWARD = ['range', 'if-none-match', 'if-modified-since'];
const RETURN = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
];

const stashBase = (config) => String(config.stashUrl || '').replace(/\/+$/, '');

/*
 * Sprite sheets and their vtt are named after the file hash rather than the
 * scene id, so the path can only be got from Stash. Scenes do not get rehashed,
 * so once looked up it is worth keeping.
 */
const spriteCache = new Map();

async function spritePaths(config, id) {
  if (spriteCache.has(id)) return spriteCache.get(id);

  const data = await gql(config, 'query($id: ID!) { findScene(id: $id) { paths { sprite vtt } } }', { id });
  const paths = { sprite: data.findScene?.paths?.sprite || null, vtt: data.findScene?.paths?.vtt || null };
  spriteCache.set(id, paths);
  return paths;
}

export const forgetSprites = () => spriteCache.clear();

/*
 * -> the Stash URL to fetch, or null if this is not a media path.
 *
 * Stream and preview are id-keyed and stable, so they are built here rather
 * than looked up; only the sprite pair needs a round trip.
 */
async function resolve(config, kind, id, extra) {
  const base = stashBase(config);

  switch (kind) {
    case 'stream':
      return `${base}/scene/${id}/stream`;
    /*
     * A marker is a clip inside a scene, so it is the only thing here named by
     * two ids. Stash generates the clip when the marker is made, so these are
     * built like the scene paths above rather than looked up.
     */
    case 'markerstream':
      return `${base}/scene/${id}/scene_marker/${extra}/stream`;
    case 'markerpreview':
      return `${base}/scene/${id}/scene_marker/${extra}/preview`;
    case 'markerscreenshot':
      return `${base}/scene/${id}/scene_marker/${extra}/screenshot`;
    case 'preview':
      return `${base}/scene/${id}/preview`;
    case 'screenshot':
      return `${base}/scene/${id}/screenshot`;
    case 'sprite':
      return (await spritePaths(config, id)).sprite;
    case 'vtt':
      return (await spritePaths(config, id)).vtt;
    case 'performer':
      return `${base}/performer/${id}/image`;
    case 'studio':
      return `${base}/studio/${id}/image`;
    // Stash serves a placeholder SVG here for a group with no cover, which is
    // the right answer — the tile stays the right shape either way.
    case 'group':
      return `${base}/group/${id}/frontimage`;
    /*
     * Gallery covers come through here too: Gallery.cover is an ordinary Image,
     * so it needs no route of its own.
     */
    case 'image':
      return `${base}/image/${id}/image`;
    case 'imagethumb':
      return `${base}/image/${id}/thumbnail`;
    default:
      return null;
  }
}

/*
 * The one pair of paths built rather than read that this file is not certain
 * of. Every image Stash knows carries its own `paths`, so a 404 from the built
 * URL asks Stash what it should have been and remembers the answer — which
 * costs one round trip on a Stash whose image routes differ, and nothing at
 * all on one whose do not.
 */
const imageCache = new Map();

async function imagePath(config, kind, id) {
  const key = kind + ':' + id;
  if (imageCache.has(key)) return imageCache.get(key);

  const data = await gql(config, 'query($id: ID!) { findImage(id: $id) { paths { image thumbnail } } }', { id })
    .catch(() => null);

  const paths = data?.findImage?.paths || null;
  const url = (kind === 'imagethumb' ? paths?.thumbnail : paths?.image) || null;
  imageCache.set(key, url);
  return url;
}

export const forgetImages = () => imageCache.clear();

/*
 * The vtt names its sprite sheet, and it names it two different ways.
 *
 * Sometimes that is an absolute Stash URL, which left alone would send the
 * browser straight to Stash — the one thing this proxy exists to avoid.
 * Sometimes, and in this library usually, it is a **bare filename**
 * (`c9f993644270c408_sprite.jpg#xywh=0,0,160,90`), which the browser resolves
 * against the page it is on: the portal's own root, where there is no such
 * file. Both are rewritten to point back here, which is why the prefix is
 * optional rather than required — matching only the absolute form left every
 * scrub preview with an empty box where the picture goes.
 *
 * The fragment is left alone: `[^\s#]*` stops at the `#`, and the crop after
 * it is what tells the player which tile of the sheet to show.
 */
function rewriteVtt(body, id) {
  return body.replace(/(?:https?:\/\/)?[^\s#]*_sprite\.(?:jpe?g|png|webp)/gi, `/media/scene/${id}/sprite`);
}

export async function proxy(config, req, res, kind, id, extra) {
  if (!config.stashUrl) {
    res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Stash is not configured');
    return;
  }

  /*
   * The file first, when this container can see it. Only the stream: the
   * poster, the preview and the sprites are generated by Stash and live
   * somewhere this container does not mount.
   */
  if (kind === 'stream') {
    const path = await scenePath(config, id);
    if (await serveFromDisk(req, res, path)) return;
  }

  let target;
  try {
    target = await resolve(config, kind, id, extra);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end(err.message);
    return;
  }

  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such media');
    return;
  }

  const headers = {};
  for (const name of FORWARD) {
    /*
     * A vtt is the one thing here whose body this proxy writes rather than
     * relays, so the copy in the browser is ours and not Stash's. Ask Stash
     * conditionally and it answers 304 about a file that genuinely has not
     * changed — and the browser reuses a body an older version of rewriteVtt
     * produced, forever, because the file it is keyed on never will change.
     */
    if (kind === 'vtt' && name !== 'range') continue;
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  if (config.stashApiKey) headers.ApiKey = config.stashApiKey;

  // Seeking makes the browser abandon requests mid-flight all the time; that is
  // normal, not an error, so the upstream fetch is cancelled with the response.
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let upstream;
  try {
    upstream = await fetch(target, { headers, signal: abort.signal });

    // See imagePath(): the image routes are the built ones, so a miss asks.
    if (upstream.status === 404 && (kind === 'image' || kind === 'imagethumb')) {
      const actual = await imagePath(config, kind, id);
      if (actual && actual !== target) upstream = await fetch(actual, { headers, signal: abort.signal });
    }
  } catch (err) {
    if (abort.signal.aborted) return;
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`stash -> ${err.message}`);
    return;
  }

  const out = {};
  for (const name of RETURN) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  /*
   * Preview clips and posters are worth holding on to; the stream is not. The
   * vtt is the odd one: it is the only thing here this proxy rewrites on the
   * way through, so a day-long copy in the browser is a day of whatever that
   * rewriting got wrong. Five minutes, and it is a few kilobytes of text.
   */
  if (!out['cache-control']) {
    out['cache-control'] =
      kind === 'stream' ? 'no-store' : kind === 'vtt' ? 'public, max-age=300' : 'public, max-age=86400';
  }

  out['x-served-from'] = 'stash';

  if (kind === 'vtt') {
    const body = rewriteVtt(await upstream.text(), id);
    delete out['content-length'];
    // And it goes back without validators, for the same reason: they belong to
    // Stash's file, not to the text sent from here.
    delete out.etag;
    delete out['last-modified'];
    res.writeHead(upstream.status, { ...out, 'Content-Type': 'text/vtt' });
    res.end(body);
    return;
  }

  res.writeHead(upstream.status, out);

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      const source = Readable.fromWeb(upstream.body);
      source.on('error', reject);
      source.pipe(res).on('finish', resolve).on('error', reject);
    });
  } catch {
    // Almost always the browser hanging up on a seek. Nothing to report.
    res.destroy();
  }
}
