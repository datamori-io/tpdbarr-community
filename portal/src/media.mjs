/*
 * Media proxy: video, previews, posters and sprites from Stash, through one
 * origin with no key in the browser. Range requests pass through.
 */

import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve as resolvePath } from 'node:path';

import { gql } from './stash.mjs';

/*
 * ------------------------------------------------- straight off the mount
 *
 * Stream files straight off the mount when this container can see them, so
 * playback works without Stash. Everything else (metadata, generated
 * artefacts, unmounted folders) still comes from Stash.
 *
 * A path from Stash is only opened if it resolves inside a media root.
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

/* Scene file paths, cached five minutes (a file can move through the pipeline). */
const PATH_TTL = 5 * 60 * 1000; // the same five minutes the shelf is cached for
const pathCache = new Map();

export const forgetPaths = () => pathCache.clear();

/*
 * The shelf hands over every path it read, so a filed scene can play with
 * Stash unreachable.
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
    /* Only answers are cached: caching a miss demoted scenes to the proxy on a Stash hiccup. */
    if (path) pathCache.set(id, { path, at: Date.now() });
    return path;
  } catch {
    // No path: fall through to the proxy.
    return null;
  }
}

const insideRoots = (path) => {
  const full = resolvePath(path);
  return MEDIA_ROOTS.some((root) => full === root || full.startsWith(root + '/'));
};

/*
 * -> true if served, false to fall back to Stash.
 * Range is the job: Safari refuses a 200 with the whole file, so a bad
 * range is 416 and every other range a 206.
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

/* Sprite and vtt paths use the file hash, so they're looked up once and kept. */
const spriteCache = new Map();

async function spritePaths(config, id) {
  if (spriteCache.has(id)) return spriteCache.get(id);

  const data = await gql(config, 'query($id: ID!) { findScene(id: $id) { paths { sprite vtt } } }', { id });
  const paths = { sprite: data.findScene?.paths?.sprite || null, vtt: data.findScene?.paths?.vtt || null };
  spriteCache.set(id, paths);
  return paths;
}

export const forgetSprites = () => spriteCache.clear();

/* -> the Stash URL to fetch, or null. Only the sprite pair needs a lookup. */
async function resolve(config, kind, id, extra) {
  const base = stashBase(config);

  switch (kind) {
    case 'stream':
      return `${base}/scene/${id}/stream`;
    /* Marker clips: named by scene and marker id, built like the scene paths. */
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
    /* Gallery covers are ordinary Images. */
    case 'image':
      return `${base}/image/${id}/image`;
    case 'imagethumb':
      return `${base}/image/${id}/thumbnail`;
    default:
      return null;
  }
}

/* Built image paths are a guess; a 404 asks Stash for the real path and remembers it. */
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
 * Point the vtt's sprite references back here. They're either absolute
 * Stash URLs or bare filenames (which would resolve against the portal
 * root), so the prefix is optional. The `#xywh` fragment is kept.
 */
function rewriteVtt(body, id) {
  return body.replace(/(?:https?:\/\/)?[^\s#]*_sprite\.(?:jpe?g|png|webp)/gi, `/media/scene/${id}/sprite`);
}

export async function proxy(config, req, res, kind, id, extra) {
  if (!config.stashUrl) {
    res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Stash is not configured');
    return;
  }

  /* Serve the stream from disk when visible. Generated artefacts aren't mounted. */
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
     * Don't forward conditional headers for the vtt: we rewrite it, and a 304
     * would keep an old rewrite in the browser forever.
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
  /* Cache previews and posters for a day, the stream not at all, the vtt five minutes. */
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
