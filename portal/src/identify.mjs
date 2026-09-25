/*
 * Fill the feature films in Stash from their Emby .nfo files. Stash
 * doesn't read .nfo; moviefiles.mjs does.
 *
 * Joined by folder: both containers mount the share at /movies.
 *
 * Nothing is created (unknown cast and studios are reported) and nothing
 * is overwritten (only empty fields are filled).
 */

import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

import * as moviefiles from './moviefiles.mjs';
import { gql } from './stash.mjs';

const MOVIE_ROOT = '/movies/';

const normalise = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// ------------------------------------------------------------------ reading

async function stashSideScenes(config) {
  const data = await gql(
    config,
    `query($f: SceneFilterType) {
       findScenes(scene_filter: $f, filter: {per_page: -1}) {
         scenes {
           id title date details director
           studio { id name }
           performers { id name }
           files { path }
         }
       }
     }`,
    { f: { path: { value: MOVIE_ROOT, modifier: 'INCLUDES' } } }
  );

  return data.findScenes.scenes || [];
}

/* Name -> id for all performers and studios, in one request each. */
async function directories(config) {
  const data = await gql(
    config,
    `{
       findPerformers(filter: {per_page: -1}) { performers { id name alias_list } }
       findStudios(filter: {per_page: -1}) { studios { id name aliases } }
     }`
  );

  /*
   * Performers have `alias_list`, studios `aliases`, both lists. A real name
   * beats someone else's alias.
   */
  const index = (records, aliasKey) => {
    const map = new Map();
    for (const r of records || []) map.set(normalise(r.name), r);
    for (const r of records || []) {
      for (const a of r[aliasKey] || []) {
        const key = normalise(a);
        if (key && !map.has(key)) map.set(key, r);
      }
    }
    return map;
  };

  const performers = index(data.findPerformers.performers, 'alias_list');
  const studios = index(data.findStudios.studios, 'aliases');

  return { performers, studios };
}

// The folder a Stash file sits in, which is the film.
function folderOf(scene) {
  const path = scene.files?.[0]?.path || '';
  const at = path.indexOf(MOVIE_ROOT);
  if (at < 0) return null;
  return path.slice(at + MOVIE_ROOT.length).split('/')[0] || null;
}

/* <premiered> is a full date, <year> a bare year; Stash accepts both. */
function dateFrom(movie) {
  const premiered = String(movie.premiered || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(premiered)) return premiered;
  return movie.year ? String(movie.year) : null;
}

// ----------------------------------------------------------------- matching

export async function preview(config) {
  const [films, scenes, dirs] = await Promise.all([
    moviefiles.scan(),
    stashSideScenes(config),
    directories(config),
  ]);

  const byFolder = new Map(films.map((f) => [f.folder, f]));
  const rows = [];

  for (const scene of scenes) {
    const folder = folderOf(scene);
    const film = folder ? byFolder.get(folder) : null;

    if (!film) {
      rows.push({ id: scene.id, folder, skip: 'no .nfo folder matches this file' });
      continue;
    }
    if (!film.hasNfo) {
      rows.push({ id: scene.id, folder, title: film.title, skip: 'that folder has no .nfo' });
      continue;
    }

    // Only what Stash is missing. Filling a field twice is how a hand
    // correction gets quietly undone on the second run.
    const set = {};
    if (!scene.title && film.title) set.title = film.title;
    if (!scene.date) { const d = dateFrom(film); if (d) set.date = d; }
    if (!scene.details && film.plot) set.details = film.plot;
    if (!scene.director && film.director) set.director = film.director;

    if (!scene.studio && film.studio) {
      const hit = dirs.studios.get(normalise(film.studio));
      if (hit) set.studio_id = hit.id;
    }

    const matched = [];
    const unmatched = [];
    if (!scene.performers.length) {
      for (const actor of film.cast || []) {
        const hit = dirs.performers.get(normalise(actor.name));
        if (hit) matched.push(hit);
        else unmatched.push(actor.name);
      }
      if (matched.length) set.performer_ids = matched.map((p) => p.id);
    }

    rows.push({
      id: scene.id,
      folder,
      title: film.title,
      set,
      changes: Object.keys(set),
      performers: matched.map((p) => p.name),
      unmatchedCast: unmatched,
      studioWanted: film.studio || null,
      studioFound: Boolean(set.studio_id),
    });
  }

  return {
    total: rows.length,
    willChange: rows.filter((r) => r.changes?.length).length,
    rows,
  };
}

// ------------------------------------------------------------------ writing

export async function apply(config, { only = null } = {}) {
  const { rows } = await preview(config);

  const wanted = rows.filter((r) => r.changes?.length && (!only || only.includes(r.id)));
  const done = [];
  const failed = [];

  // One at a time. Fifty-one writes against a local Stash is not worth the
  // concurrency, and a failure halfway is easier to read in order.
  for (const row of wanted) {
    try {
      await gql(
        config,
        'mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }',
        { input: { id: row.id, ...row.set } }
      );
      done.push({ id: row.id, title: row.title, changed: row.changes });
    } catch (err) {
      failed.push({ id: row.id, title: row.title, error: err.message });
    }
  }

  return { attempted: wanted.length, updated: done.length, done, failed };
}

/*
 * ------------------------------------------------------------- the posters
 *
 * Emby's poster.jpg as the Stash scene cover. This overwrites (Stash always
 * has a generated cover); undo by regenerating covers in Stash. Posters are
 * portrait and will crop in 16:9; `which` switches to fanart.jpg.
 */

const IMAGE_TYPE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// Stash takes the image inline, so this rides in a GraphQL body. Big artwork
// is rare here; anything absurd is skipped rather than posted.
const MAX_BYTES = 8 * 1024 * 1024;

export async function pushCovers(config, { which = 'poster', dryRun = true, only = null } = {}) {
  const [films, scenes] = await Promise.all([moviefiles.scan(), stashSideScenes(config)]);
  const byFolder = new Map(films.map((f) => [f.folder, f]));

  const done = [];
  const skipped = [];
  const failed = [];

  for (const scene of scenes) {
    if (only && !only.includes(scene.id)) continue;

    const folder = folderOf(scene);
    const film = folder ? byFolder.get(folder) : null;
    const name = film && (which === 'fanart' ? film.fanart : film.poster);

    if (!name) {
      skipped.push({ id: scene.id, folder, why: `no ${which} in that folder` });
      continue;
    }

    const type = IMAGE_TYPE[extname(name).toLowerCase()];
    if (!type) {
      skipped.push({ id: scene.id, folder, why: `${name} is not an image type Stash takes` });
      continue;
    }

    try {
      const bytes = await readFile(join(moviefiles.moviesRoot(), film.folder, name));
      if (bytes.length > MAX_BYTES) {
        skipped.push({ id: scene.id, folder, why: `${Math.round(bytes.length / 1024)}KB is too big` });
        continue;
      }

      if (dryRun) {
        done.push({ id: scene.id, title: film.title, file: name, kb: Math.round(bytes.length / 1024) });
        continue;
      }

      await gql(
        config,
        'mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }',
        { input: { id: scene.id, cover_image: `data:${type};base64,${bytes.toString('base64')}` } }
      );

      done.push({ id: scene.id, title: film.title, file: name, kb: Math.round(bytes.length / 1024) });
    } catch (err) {
      failed.push({ id: scene.id, folder, error: err.message });
    }
  }

  return { which, dryRun, pushed: done.length, skipped: skipped.length, done, skippedRows: skipped, failed };
}
