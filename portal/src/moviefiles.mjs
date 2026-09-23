/*
 * Movies.
 *
 * The third spine, and the one with a different library of record. Scenes live
 * in Stash and are keyed on a Stash id; movies are not in Stash at all. They sit
 * on a share as one folder per film, with Emby's .nfo and artwork already beside
 * them, and *that folder is the truth*. Emby stays the thing that owns the
 * metadata; this module never writes any.
 *
 * So this module is a reader. It walks the folders, believes the .nfo where
 * there is one, falls back to the folder name where there is not, and serves
 * the files straight off the mount. The one exception in the whole app lives
 * next door in gapfill.mjs, which fills in a folder Emby never matched — and
 * only ever creates files that are not there.
 *
 * Zero dependencies, like the rest of the app — which is why the .nfo is read
 * with targeted extraction rather than a real XML parser. These files are
 * machine-written by Emby to a known shape; if that ever stops being true this
 * is the thing that breaks.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname, basename } from 'node:path';

import { decorate, watchFor } from './watch.mjs';

const ROOT = process.env.MOVIES_DIR || '/movies';
const TTL = 10 * 60 * 1000;

const VIDEO = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.webm']);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp']);

let cache = null;
let scanning = null;
export const forgetMovies = () => { cache = null; };

export const moviesRoot = () => ROOT;

// ----------------------------------------------------------------- the .nfo

const unwrap = (value) => {
  const text = String(value).trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
};

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? unwrap(match[1]) || null : null;
}

function tags(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'gi');
  let match;
  while ((match = re.exec(xml))) {
    const value = unwrap(match[1]);
    if (value) out.push(value);
  }
  return out;
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function parseNfo(xml) {
  // Actors carry a role and a tmdb id; the <thumb> is an absolute path on the
  // Emby host and means nothing here, so it is dropped.
  const cast = [];
  const actorRe = /<actor>([\s\S]*?)<\/actor>/gi;
  let actor;
  while ((actor = actorRe.exec(xml))) {
    const name = tag(actor[1], 'name');
    if (name) cast.push({ name, role: tag(actor[1], 'role') });
  }

  const video = xml.match(/<video>([\s\S]*?)<\/video>/i)?.[1] || '';
  // A film routinely carries more than one — Emby writes tmdb, and the ones we
  // fill in write tmdb and imdb — and the imdb one is what the gap-filler's
  // last resort looks the film up by, so all of them are kept.
  const ids = {};
  const idRe = /<uniqueid\s+type="([a-z]+)"[^>]*>([^<]+)<\/uniqueid>/gi;
  let unique;
  while ((unique = idRe.exec(xml))) ids[unique[1].toLowerCase()] = unique[2].trim();

  return {
    title: tag(xml, 'title') || tag(xml, 'originaltitle'),
    sortTitle: tag(xml, 'sorttitle'),
    year: number(tag(xml, 'year')),
    premiered: tag(xml, 'premiered') || tag(xml, 'releasedate'),
    plot: tag(xml, 'plot') || tag(xml, 'outline'),
    studio: tag(xml, 'studio'),
    director: tag(xml, 'director'),
    certification: tag(xml, 'mpaa'),
    rating: number(tag(xml, 'rating')),
    genres: tags(xml, 'genre'),
    cast,
    ids,
    // Emby records what it probed, so the runtime and the resolution are here
    // and there is no need to open the file to find them.
    duration: number(tag(video, 'durationinseconds')) || (number(tag(xml, 'runtime')) || 0) * 60 || null,
    width: number(tag(video, 'width')),
    height: number(tag(video, 'height')),
    videoCodec: tag(video, 'codec'),
  };
}

// ------------------------------------------------------------------ scanning

// "Title (2017)" and the occasional "Title 2017" with the year left bare.
function fromFolderName(folder) {
  const parenthesised = folder.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (parenthesised) return { title: parenthesised[1].trim(), year: Number(parenthesised[2]) };

  const trailing = folder.match(/^(.*?)\s+(\d{4})\s*$/);
  if (trailing) return { title: trailing[1].trim(), year: Number(trailing[2]) };

  return { title: folder, year: null };
}

const id = (folder) => createHash('sha1').update(folder).digest('hex').slice(0, 12);

function resolution(height) {
  if (!height) return null;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  return height + 'p';
}

/*
 * Artwork, in the order Emby and Kodi agree on. The .nfo does name its art, but
 * as absolute paths on the machine that wrote it ("/Volumes/Media2Stash/..."),
 * so those are useless here and the folder is looked at instead.
 */
function pickArt(names, base) {
  const has = (name) => names.find((n) => n.toLowerCase() === name.toLowerCase());

  const poster =
    has('poster.jpg') || has('poster.png') ||
    has('folder.jpg') || has('folder.png') ||
    has(base + '.jpg') || has(base + '.png') ||
    has('cover.jpg') || null;

  const fanart =
    has('fanart.jpg') || has('fanart.png') ||
    has('backdrop.jpg') ||
    names.find((n) => /^fanart\d*\.(jpg|png)$/i.test(n)) || null;

  return { poster, fanart };
}

async function readFolder(folder) {
  const dir = join(ROOT, folder);

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null; // vanished mid-scan, or not readable
  }

  const videos = names.filter((n) => VIDEO.has(extname(n).toLowerCase()));
  if (!videos.length) return null; // a folder with no film in it is not a film

  // Biggest file wins: trailers and samples sit beside the feature.
  let file = videos[0];
  let size = 0;
  for (const name of videos) {
    try {
      const info = await stat(join(dir, name));
      if (info.size > size) { size = info.size; file = name; }
    } catch { /* skip */ }
  }

  const base = basename(file, extname(file));
  const nfoName = names.find((n) => n.toLowerCase() === (base + '.nfo').toLowerCase())
    || names.find((n) => extname(n).toLowerCase() === '.nfo');

  let nfo = null;
  if (nfoName) {
    try {
      nfo = parseNfo(await readFile(join(dir, nfoName), 'utf8'));
    } catch { /* unreadable or not XML; treat as missing */ }
  }

  const guess = fromFolderName(folder);
  const art = pickArt(names, base);

  return {
    id: id(folder),
    folder,
    title: nfo?.title || guess.title,
    year: nfo?.year || guess.year,
    sortTitle: (nfo?.sortTitle || nfo?.title || guess.title || '').toLowerCase(),
    studio: nfo?.studio || null,
    director: nfo?.director || null,
    plot: nfo?.plot || null,
    genres: nfo?.genres || [],
    cast: nfo?.cast || [],
    ids: nfo?.ids || {},
    certification: nfo?.certification || null,
    rating: nfo?.rating ?? null,
    premiered: nfo?.premiered || null,
    duration: nfo?.duration || null,
    resolution: resolution(nfo?.height),
    videoCodec: nfo?.videoCodec || null,
    size,
    file,
    poster: art.poster,
    fanart: art.fanart,
    /*
     * What the folder is missing. This is the whole point of the section: the
     * ones with no .nfo are the ones worth going and finding metadata for.
     */
    hasNfo: Boolean(nfo),
    hasPoster: Boolean(art.poster),
    // Emby's trick-play thumbnails. Not read yet, but worth knowing they exist.
    hasTrickplay: names.some((n) => extname(n).toLowerCase() === '.bif'),
    images: names.filter((n) => IMAGE.has(extname(n).toLowerCase())).length,
  };
}

/*
 * One walk is a readdir per folder plus a stat on every video inside it to find
 * the feature — a few hundred round trips, and the folders live on a CIFS mount
 * across the network.
 *
 * Do not bound this. It looks like it wants a worker pool and it does not: the
 * mount is latency-bound, not bandwidth-bound, so every request in flight is
 * one more round trip already on the wire. Measured over the 51 films, widths
 * of 8/16/32/51 all landed between 9.8s and 15.1s; unbounded came in at 6.3s.
 * Firing them all at once *is* the fast path.
 *
 * The seconds are dealt with below instead, by never making anyone wait them.
 */
async function walk() {
  let entries;
  try {
    entries = await readdir(ROOT, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Cannot read the movie library at ${ROOT} — is the share mounted? (${err.code || err.message})`
    );
  }

  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const read = await Promise.all(folders.map(readFolder));

  return read.filter(Boolean).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
}

// One walk at a time, however many callers are asking.
function refresh() {
  if (!scanning) {
    scanning = walk()
      .then((movies) => { cache = { movies, at: Date.now() }; return movies; })
      .finally(() => { scanning = null; });
  }
  return scanning;
}

export async function scan({ force = false } = {}) {
  if (force) return refresh();
  if (cache && Date.now() - cache.at < TTL) return cache.movies;

  /*
   * Past the TTL but the folder has not moved: a stale shelf now beats the
   * right one in nine seconds, so the walk that replaces it runs behind this
   * answer rather than in front of it. Only the first caller after a restart
   * ever waits.
   */
  if (cache) {
    refresh().catch((err) => console.warn('[tpdbarr] movie rescan failed -', err.message));
    return cache.movies;
  }

  return refresh();
}

// Walked at boot so the first visit is not the one that pays for it.
export function warm() {
  refresh().catch((err) => console.warn('[tpdbarr] movie warm-up failed -', err.message));
}

export async function findMovie(movieId) {
  const movies = await scan();
  return movies.find((m) => m.id === movieId) || null;
}

// The same film with where you got to, for the detail page and its player.
export async function findMovieWatched(movieId) {
  const movie = await findMovie(movieId);
  if (!movie) return null;

  const seen = await watchFor(movieId);
  return {
    ...movie,
    resume: seen ? Math.round(seen.resume || 0) : 0,
    plays: seen?.plays || 0,
    lastPlayed: seen?.lastPlayed || null,
  };
}

/*
 * The section as the UI wants it: the shelf, plus the count of what is not
 * described yet, which is the only thing here that needs a decision.
 */
export async function overview({ force = false } = {}) {
  const found = await scan({ force });
  const incomplete = found.filter((m) => !m.hasNfo || !m.hasPoster);

  // Watch state lives beside the config, not in the scan cache — it changes
  // while you are watching and the folder does not.
  const movies = await decorate(found);

  /*
   * Where you stopped, newest first. The equivalent of the scenes rail, except
   * it has to be built here: Stash is not involved and has nothing to sort by.
   */
  const continueWatching = movies
    .filter((m) => m.progress > 0.01 && !m.finished)
    .sort((a, b) => String(b.lastPlayed || '').localeCompare(String(a.lastPlayed || '')));

  return {
    count: movies.length,
    incomplete: incomplete.length,
    movies,
    continueWatching,
    needsMetadata: incomplete.map((m) => ({ id: m.id, folder: m.folder, title: m.title, year: m.year, hasNfo: m.hasNfo, hasPoster: m.hasPoster })),
  };
}

// ------------------------------------------------------------------- serving

const CONTENT_TYPE = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/*
 * Range matters more here than anywhere else in the app: without it, seeking a
 * 3GB mkv means downloading 3GB. Same contract the Stash proxy honours, except
 * the bytes come off the mount instead of out of another HTTP call.
 */
export async function serve(req, res, movie, which) {
  const name = which === 'poster' ? movie.poster : which === 'fanart' ? movie.fanart : movie.file;
  if (!name) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }

  const path = join(ROOT, movie.folder, name);

  let info;
  try {
    info = await stat(path);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }

  const type = CONTENT_TYPE[extname(name).toLowerCase()] || 'application/octet-stream';
  const cacheFor = which === 'file' ? 'no-store' : 'public, max-age=86400';
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);

  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;

    if (start >= info.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }

    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${info.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheFor,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheFor,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).on('error', () => res.destroy()).pipe(res);
}
