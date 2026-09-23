/*
 * The gap-filler.
 *
 * Emby wrote a .nfo and artwork beside almost every film on the share. Almost:
 * a handful it never matched, and those folders hold a video file and nothing
 * else. This finds them on ThePornDB and writes the missing pieces in, in the
 * shape Emby already uses, so Emby picks them up on its next scan.
 *
 * This is the only code in the portal that writes to the media share, and it is
 * deliberately timid about it:
 *
 *   - it never overwrites. A file that exists is left exactly as it is, so a
 *     bad guess here cannot destroy something Emby got right.
 *   - it never picks. Matching is on a title someone typed into a folder name
 *     years ago; the candidates go to the UI and a person chooses.
 *   - it stays inside the film's own folder, checked against the resolved path
 *     rather than trusted.
 *
 * If the share is mounted read-only the writes fail at the kernel and the error
 * says so, which is the correct outcome rather than something to work around.
 */

import { writeFile, access } from 'node:fs/promises';
import { join, resolve, extname, basename } from 'node:path';

import * as tpdb from './tpdb.mjs';
import * as tmdb from './tmdb.mjs';
import { findMovie, moviesRoot, forgetMovies } from './moviefiles.mjs';

// Artwork is a poster or a backdrop; anything much bigger is not one.
const MAX_IMAGE = 25 * 1024 * 1024;

/*
 * Candidate posters live on the studios' own hosts — members areas, DVD shops,
 * hotlink-protected CDNs — so the browser cannot load them directly and they go
 * through the portal instead.
 *
 * That proxy is an obvious way to turn this app into an open relay into the
 * LAN, so it is not one: only URLs this module has actually handed out as
 * candidate artwork can be fetched. An allowlist of things we already chose to
 * show, rather than a filter trying to guess what is safe.
 */
const knownArt = new Set();
const MAX_KNOWN = 2000;

function rememberArt(candidates) {
  for (const c of candidates) {
    for (const url of [c.poster, c.background]) {
      if (!url) continue;
      // Bounded: this is a cache of what is on screen, not a growing leak.
      if (knownArt.size >= MAX_KNOWN) knownArt.clear();
      knownArt.add(url);
    }
  }
}

export const isKnownArt = (url) => knownArt.has(url);

// ------------------------------------------------------------------ finding

const strip = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/*
 * How much of the folder's title the candidate accounts for, word by word.
 * Crude on purpose — it only has to sort eight results, and the person looking
 * at the posters makes the actual decision.
 */
function similarity(a, b) {
  const left = new Set(strip(a).split(' ').filter(Boolean));
  const right = new Set(strip(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.max(left.size, right.size);
}

function score(movie, candidate) {
  let value = similarity(movie.title, candidate.title);

  // A matching year is strong evidence; a year two apart is nearly none.
  const year = candidate.date ? Number(String(candidate.date).slice(0, 4)) : null;
  if (movie.year && year) {
    const apart = Math.abs(movie.year - year);
    if (apart === 0) value += 0.5;
    else if (apart === 1) value += 0.15;
    else value -= 0.1 * Math.min(apart, 5);
  }

  return value;
}

/*
 * What to ask TPDB, in the order worth asking.
 *
 * TPDB's search wants something close to its own title and gives up entirely
 * rather than degrading: "The Submission of Emma Marx 2 - Boundaries" returns
 * nothing, while the same words without the sequence number return the film
 * and its three sequels. So the exact folder title is tried first — it is right
 * often enough and gives the tightest results — and only then the loosened
 * versions.
 */
/*
 * The folder's year is deliberately NOT passed to either search as a filter.
 * These folder names carry the year someone filed the film under, which is
 * routinely a year out from the source's release date — TMDB dates Emma Marx
 * "Boundaries" to 2015 where the folder says 2016, and filtering on that hides
 * the right answer entirely. The year is far better used the way score() uses
 * it: to rank, not to exclude.
 */
function queries(title) {
  const attempts = [title];

  const loosened = String(title)
    .replace(/^the\s+/i, '')
    .replace(/[-:–—#]+/g, ' ')
    .replace(/\b\d{1,3}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (loosened && loosened.toLowerCase() !== title.toLowerCase()) attempts.push(loosened);

  // Last resort: enough words to be a title, few enough to still match one.
  const words = loosened.split(' ').filter(Boolean);
  if (words.length > 3) attempts.push(words.slice(0, 3).join(' '));

  return attempts;
}

/*
 * `only` names one source and skips the hierarchy.
 *
 * Worth having because "TPDB answered" is not the same as "TPDB was right": for
 * a film catalogued as normal cinema, TPDB often returns a near-miss and TMDB
 * has the real record with a better poster. Falling back only on silence would
 * mean the TMDB key never gets used for anything. So the hierarchy stays the
 * default and this is the override.
 */
export async function candidates(config, movieId, { only = null } = {}) {
  const movie = await findMovie(movieId);
  if (!movie) throw new Error('No movie with that id.');

  if (only === 'tmdb' || only === 'imdb') {
    if (!tmdb.configured(config)) throw new Error('TMDB is not configured — add a TMDB key in Settings.');
  }

  if (only === 'imdb') {
    if (!movie.ids?.imdb) throw new Error('This film has no IMDB id in its .nfo to look up.');
    const byId = await tmdb.findByImdb(config, movie.ids.imdb);
    return shapeResult(movie, byId, 'imdb', movie.ids.imdb, config);
  }

  if (only === 'tmdb') {
    let hits = [];
    let query = null;
    for (const attempt of queries(movie.title)) {
      query = attempt;
      hits = await tmdb.searchMovies(config, attempt, { limit: 10 });
      if (hits.length) break;
    }
    return shapeResult(movie, hits, 'tmdb', query, config);
  }

  if (only === 'tpdb') {
    let hits = [];
    let query = null;
    for (const attempt of queries(movie.title)) {
      query = attempt;
      hits = (await tpdb.searchMovies(config, attempt, { limit: 10 })).map((c) => ({ ...c, source: 'tpdb', id: c.guid }));
      if (hits.length) break;
    }
    return shapeResult(movie, hits, 'tpdb', query, config);
  }

  /*
   * TPDB, then TMDB, then IMDB — in that order, stopping at the first source
   * that answers.
   *
   * TPDB first because this is an adult library and TPDB is the one that knows
   * the studios, the performers and the release dates for it. TMDB second
   * because the films TPDB misses are the ones catalogued as normal cinema — a
   * 1976 feature, a parody with a mainstream cast — and TMDB has those. IMDB
   * last and differently: it has no search API anyone can use, so what it
   * contributes is an *id*, taken from the .nfo Emby already wrote, and
   * resolved through TMDB. That makes it exact rather than a guess, which is
   * why it is worth having even at the bottom of the list.
   */
  let found = [];
  let asked = null;
  let source = 'tpdb';

  for (const query of queries(movie.title)) {
    asked = query;
    found = (await tpdb.searchMovies(config, query, { limit: 10 })).map((c) => ({ ...c, source: 'tpdb', id: c.guid }));
    if (found.length) break;
  }

  if (!found.length && tmdb.configured(config)) {
    source = 'tmdb';
    for (const query of queries(movie.title)) {
      asked = query;
      found = await tmdb.searchMovies(config, query, { limit: 10 }).catch(() => []);
      if (found.length) break;
    }

    // The film already carries an IMDB id from Emby's own match. Exact, and the
    // only thing left when both title searches have come up empty.
    if (!found.length && movie.ids?.imdb) {
      source = 'imdb';
      asked = movie.ids.imdb;
      found = await tmdb.findByImdb(config, movie.ids.imdb).catch(() => []);
    }
  }

  return shapeResult(movie, found, source, asked, config);
}

/*
 * Which source answered, and what it was asked. A result set that looks
 * surprising is then explainable — "TPDB had nothing, so this is TMDB on a
 * shortened title" — instead of just looking wrong.
 */
function shapeResult(movie, found, source, asked, config) {
  const seen = new Set();
  const unique = found.filter((c) => c.id && !seen.has(c.id) && seen.add(c.id));

  rememberArt(unique);

  return {
    movie: {
      id: movie.id,
      folder: movie.folder,
      title: movie.title,
      year: movie.year,
      hasNfo: movie.hasNfo,
      hasPoster: movie.hasPoster,
      hasFanart: Boolean(movie.fanart),
      hasImdbId: Boolean(movie.ids?.imdb),
    },
    source,
    asked,
    sources: { tpdb: true, tmdb: tmdb.configured(config) },
    candidates: unique
      .map((candidate) => ({ ...candidate, score: Number(score(movie, candidate).toFixed(3)) }))
      .sort((a, b) => b.score - a.score),
  };
}

// ------------------------------------------------------------------- the nfo

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const element = (name, value) =>
  value === null || value === undefined || value === '' ? null : `  <${name}>${escape(value)}</${name}>`;

/*
 * Kodi/Emby movie.nfo. Matches the shape of the ones already in this library
 * closely enough for Emby to read it, minus two things it writes and we should
 * not: <lockdata>, which would stop Emby correcting us, and <art>, whose paths
 * in the existing files are absolute paths on a machine that is not this one.
 * Emby finds poster.jpg and fanart.jpg by convention anyway.
 */
function buildNfo(movie, film) {
  const year = movie.date ? String(movie.date).slice(0, 4) : film.year || null;

  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    '<movie>',
    movie.overview ? `  <plot><![CDATA[${movie.overview}]]></plot>` : null,
    element('title', movie.title),
    element('originaltitle', movie.title),
    element('sorttitle', movie.title),
    element('year', year),
    element('premiered', movie.date || null),
    element('releasedate', movie.date || null),
    element('studio', movie.siteName || null),
    movie.duration ? element('runtime', movie.duration) : null,
    ...(movie.directors || []).map((name) => element('director', name)),
    ...(movie.performers || []).map((p) =>
      ['  <actor>', `    <name>${escape(p.name)}</name>`, '    <type>Actor</type>', '  </actor>'].join('\n')
    ),
    ...(movie.tags || []).map((tag) => element('genre', tag)),
    // Every id the source gave us, so a later identify run has something exact
    // to work from — and so Emby's own tmdb match is not contradicted.
    ...Object.entries(movie.ids || {}).map(([kind, value]) =>
      `  <uniqueid type="${escape(kind)}">${escape(value)}</uniqueid>`),
    element('dateadded', new Date().toISOString().slice(0, 19).replace('T', ' ')),
    '</movie>',
    '',
  ];

  return lines.filter((line) => line !== null).join('\n');
}

// ------------------------------------------------------------------ writing

const exists = (path) => access(path).then(() => true, () => false);

/*
 * Every path this module writes goes through here. The folder name comes from
 * the scan rather than the request, but the check is on the resolved path
 * regardless — a filename is not something to take on trust just because the
 * id that produced it looked reasonable.
 */
function inside(root, folder, name) {
  const base = resolve(join(root, folder));
  const target = resolve(join(base, name));
  if (target !== join(base, basename(name)) || !target.startsWith(base)) {
    throw new Error('Refusing to write outside the film’s own folder.');
  }
  return target;
}

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`artwork -> ${res.status}`);

  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) throw new Error(`artwork was ${type || 'not an image'}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE) throw new Error('artwork is implausibly large');
  return buffer;
}

async function writeNew(path, data, what, wrote, skipped) {
  if (await exists(path)) {
    skipped.push(`${what} already there`);
    return;
  }
  await writeFile(path, data);
  wrote.push(what);
}

/*
 * Write the chosen match into the folder. Returns what it did and what it left
 * alone, which the UI repeats back — "wrote poster.jpg, left the .nfo alone" is
 * the sentence that makes this safe to use twice.
 */
/*
 * The two sources describe a film differently — TPDB has a site and performer
 * uuids, TMDB has production companies and character names — so both are folded
 * into one shape before anything is written. The .nfo writer never learns which
 * one it came from, beyond the id it stamps.
 */
function normalise(source, raw) {
  if (source === 'tpdb') {
    return {
      title: raw.title,
      date: raw.date || null,
      overview: raw.overview || '',
      siteName: raw.siteName || null,
      duration: raw.duration || null,
      directors: raw.directors || [],
      performers: (raw.performers || []).map((p) => ({ name: p.name, role: null })),
      tags: raw.tags || [],
      poster: raw.poster || null,
      background: raw.background || null,
      ids: raw.guid ? { tpdb: raw.guid } : {},
    };
  }

  return {
    title: raw.title,
    date: raw.date || null,
    overview: raw.overview || '',
    siteName: raw.siteName || null,
    duration: raw.duration || null,
    directors: raw.directors || [],
    performers: raw.performers || [],
    tags: raw.tags || [],
    poster: raw.poster || null,
    background: raw.background || null,
    ids: raw.ids || {},
  };
}

export async function apply(config, movieId, { source = 'tpdb', id }, { nfo = true, poster = true, fanart = true } = {}) {
  const film = await findMovie(movieId);
  if (!film) throw new Error('No movie with that id.');
  if (!id) throw new Error('A source id is required.');

  // imdb is a way in, not a place to fetch from — it resolves through TMDB.
  const from = source === 'imdb' ? 'tmdb' : source;

  const raw = from === 'tmdb' ? await tmdb.getMovie(config, id) : await tpdb.getMovie(config, id);
  if (!raw) throw new Error(`${from === 'tmdb' ? 'TMDB' : 'ThePornDB'} has no movie with that id.`);

  const movie = normalise(from, raw);

  const root = moviesRoot();
  const wrote = [];
  const skipped = [];
  const failed = [];

  /*
   * Artwork lives on the studios' own hosts and a good share of them refuse a
   * hotlink — HTML instead of an image, or a 470. That must not take the whole
   * operation down with it: the .nfo is the valuable half and it has already
   * been written by this point. So a dead image is recorded and the call still
   * succeeds, and the UI can offer the other source for the picture alone.
   */
  const tryArt = async (url, name) => {
    try {
      await writeNew(inside(root, film.folder, name), await fetchImage(url), name, wrote, skipped);
    } catch (err) {
      failed.push(`${name} (${err.message})`);
    }
  };

  if (nfo) {
    // Beside the video file and named after it, which is where Emby looks.
    const base = basename(film.file, extname(film.file));
    const path = inside(root, film.folder, `${base}.nfo`);
    await writeNew(path, buildNfo(movie, film), `${base}.nfo`, wrote, skipped);
  }

  /*
   * Artwork is skipped when the folder already has some, under whatever name it
   * happens to use — Emby writes folder.jpg and a title.jpg as often as
   * poster.jpg, and writing a second poster beside a perfectly good one is not
   * filling a gap, it is just adding a file. The scan already worked out which
   * names count, so that answer is reused rather than guessed at again.
   */
  if (poster && movie.poster) {
    if (film.poster) skipped.push(`poster already there (${film.poster})`);
    else await tryArt(movie.poster, 'poster.jpg');
  }

  if (fanart && movie.background) {
    if (film.fanart) skipped.push(`fanart already there (${film.fanart})`);
    else await tryArt(movie.background, 'fanart.jpg');
  }

  // The folder changed, so the next scan must actually look at it again.
  forgetMovies();

  return { folder: film.folder, matched: movie.title, source: from, wrote, skipped, failed };
}
