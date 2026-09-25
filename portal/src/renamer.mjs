/*
 * Rename a matched file to `Studio.YYYY-MM-DD.Title.ext`.
 *
 * Only in /pc-import (checked on the resolved path, server-side); every
 * other folder belongs to Whisparr, FileFlows or the library. Only a scene
 * with a title; one scene per press, after the preview.
 */

import { rename as renameFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';

import { gql } from './stash.mjs';

/* The one mount this may write to. */
const HOME = '/pc-import';

const inside = (path) => {
  const full = resolvePath(String(path || ''));
  return full === HOME || full.startsWith(HOME + '/');
};

/*
 * Safe for Windows (this volume is a Windows bind): reserved characters
 * and trailing dots or spaces removed.
 */
const clean = (text) => String(text || '')
  .replace(/[\\/:*?"<>|]/g, ' ')
  // Control characters, which arrive from scraped descriptions more often
  // than anyone would like.
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/^[.\s]+|[.\s]+$/g, '')
  .trim();

const SCENE = `
  id
  title
  date
  organized
  studio { name }
  files { path }
`;

async function read(config, sceneId) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id: String(sceneId) });
  if (!data.findScene) throw new Error('Stash has no scene with that id.');
  return data.findScene;
}

/*
 * -> { can, why, from, to, dir }. Never writes.
 * `over` lets Wild Card preview unsaved studio, date and title.
 */
export async function plan(config, sceneId, over = null) {
  const scene = await read(config, sceneId);
  if (over) {
    for (const key of ['title', 'date']) {
      if (typeof over[key] === 'string' && over[key].trim()) scene[key] = over[key].trim();
    }
    if (typeof over.studioName === 'string' && over.studioName.trim()) {
      scene.studio = { name: over.studioName.trim() };
    }
  }
  const from = scene.files?.[0]?.path || null;

  const no = (why) => ({ can: false, why, from, to: null, dir: null });

  if (!from) return no('Stash has no file for that scene.');
  if (!inside(from)) return no(`Only files in ${HOME} are renamed here — this one is somewhere else.`);

  const title = clean(scene.title);
  // The name needs a title.
  if (!title) return no('No title to rename it to — the name is built out of one, so there has to be one first.');

  const studio = clean(scene.studio?.name);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(scene.date || '') ? scene.date : '';

  /* Missing parts are left out, never "Unknown". */
  const stem = [studio, date, title].filter(Boolean).join('.');
  const to = stem + (extname(from) || '.mp4');
  const dir = dirname(from);

  if (join(dir, to) === from) return no('The file is already called that.');

  const taken = await stat(join(dir, to)).catch(() => null);
  if (taken) return no(`There is already a file called ${to} in that folder.`);

  return { can: true, why: '', from, to, dir };
}

/* Rename, then tell Stash. Re-plans; only a scene id comes from outside. */
export async function rename(config, sceneId) {
  const ready = await plan(config, sceneId);
  if (!ready.can) throw new Error(ready.why);

  const to = join(ready.dir, ready.to);
  await renameFile(ready.from, to);

  /*
   * Scan the folder; Stash follows by fingerprint. A scan that won't start
   * is reported, not a failure.
   */
  let scanned = true;
  await gql(
    config,
    'mutation($p: [String!]) { metadataScan(input: {paths: $p}) }',
    { p: [ready.dir] }
  ).catch((err) => {
    scanned = false;
    console.warn('[tpdbarr] renamed but Stash would not rescan -', err.message);
  });

  return { from: ready.from, to, scanned };
}
