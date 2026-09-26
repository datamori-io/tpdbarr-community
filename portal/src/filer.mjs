/*
 * Filing a scene: marking it organized moves the file to
 *
 *   /organized_scenes/<Studio>/<YYYY>/<Studio>.<date>.<Title>/<Studio>.<date>.<Title>.<ext>
 *
 * (renamer.mjs's stem as both folder and file). The Manage page's "rename
 * all in organized" moves older layouts.
 *
 * /Import Folder, /movies and /organized_scenes are one SMB share, so most
 * moves are a rename on the file server (see share.mjs). /pc-import is local,
 * so leaving it is a real copy. The result says which and how long.
 *
 * Nothing is overwritten: a taken destination stops the move.
 */

import { copyFile, mkdir, rename as renameFile, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';

import { gql } from './stash.mjs';
import * as share from './share.mjs';

/* The one destination. */
const HOME = '/organized_scenes';

/*
 * Where files may be moved from. Not the Whisparr folders (Whisparr moves
 * those itself) and not /movies (Emby's; moving the video would strand its
 * .nfo and artwork).
 */
const SOURCES = ['/Import Folder', '/pc-import'];

const inside = (path, root) => {
  const full = resolvePath(String(path || ''));
  return full === root || full.startsWith(root + '/');
};

/* Safe for both the Windows bind and SMB. Same rules as renamer.mjs. */
const clean = (text) => String(text || '')
  // Colon becomes a hyphen, as Whisparr writes it.
  .replace(/:/g, '-')
  .replace(/[\\/*?"<>|]/g, ' ')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/^[.\s]+|[.\s]+$/g, '')
  .trim();

/*
 * Fit a name into one path component: 255 bytes (not characters). 180
 * leaves room for studio and date. Cut on a word; no ellipsis added.
 */
const fit = (text, bytes = 180) => {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= bytes) return text;

  let cut = text;
  while (enc.encode(cut).length > bytes) cut = cut.slice(0, -1);

  const space = cut.lastIndexOf(' ');
  if (space > bytes * 0.6) cut = cut.slice(0, space);
  return cut.replace(/^[.\s]+|[.\s]+$/g, '').trim();
};

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
 * -> { dir, to }, or { why } when studio, date or title is missing.
 * Shared with "rename all in organized".
 */
export function shelfFor(scene, from) {
  const title = clean(scene.title);
  if (!title) return { why: 'No title, and the folder is named out of one — so there is nothing to file it as yet.' };

  const studio = clean(scene.studio?.name);
  if (!studio) return { why: 'No studio, and filed scenes are grouped by studio — so there is nowhere to put it yet.' };

  const date = /^\d{4}-\d{2}-\d{2}$/.test(scene.date || '') ? scene.date : '';
  if (!date) return { why: 'No date, and both the folder and the filename start with one.' };

  /*
   * The whole stem is fitted, since it's one path component. The year level
   * keeps big studios' folders manageable.
   */
  const shelf = fit(studio, 120);
  const stem = fit(`${shelf}.${date}.${title}`, 240);
  const dir = join(HOME, shelf, date.slice(0, 4), stem);
  const to = join(dir, `${stem}${extname(from) || '.mp4'}`);
  return { dir, to };
}

/*
 * -> { can, why, from, to, dir, sameDevice, already }
 *
 * Never writes. `already` is normal. A scene that can't be filed doesn't
 * block the flag: the caller sets it anyway and reports why.
 */
export async function plan(config, sceneId) {
  const scene = await read(config, sceneId);
  const from = scene.files?.[0]?.path || null;

  const no = (why, extra = {}) => ({ can: false, why, from, to: null, dir: null, sameDevice: false, already: false, ...extra });

  if (!from) return no('Stash has no file for that scene.');
  if (inside(from, HOME)) return no('Already filed — the file is in ' + HOME + '.', { already: true });
  // A film in /movies is filed where it is — Emby's library, see SOURCES —
  // so organised is just the flag, and nobody is told it could not move.
  if (inside(from, '/movies')) return no('Already filed — films live in /movies.', { already: true });

  const source = SOURCES.find((root) => inside(from, root));
  if (!source) {
    return no('That file is in a folder the portal does not file out of. '
      + SOURCES.join(', ') + ' are the ones it will move from.');
  }

  const shelf = shelfFor(scene, from);
  if (shelf.why) return no(shelf.why);
  const { dir, to } = shelf;

  const taken = await stat(to).catch(() => null);
  if (taken) return no(`There is already a file at ${to}.`, { taken: to });

  const { sameDevice } = await share.route(from, to);

  return { can: true, why: '', from, to, dir, sameDevice, already: false };
}

/* Move it, then tell Stash. Re-plans here; only the scene id comes from outside. */
export async function file(config, sceneId, { beforeMove = null } = {}) {
  const ready = await plan(config, sceneId);
  if (!ready.can) throw new Error(ready.why);

  /* Both ends on the one mount where possible, so it's a rename. */
  const routed = await share.route(ready.from, ready.to);

  await mkdir(dirname(routed.to), { recursive: true });

  // Anything that must be in the folder before the file is — FileFlows
  // watches /organized_scenes and would otherwise see the file first.
  if (beforeMove) await beforeMove(dirname(routed.to));

  const began = Date.now();
  let how = 'rename';

  try {
    await renameFile(routed.from, routed.to);
  } catch (err) {
    /*
     * EXDEV (out of /pc-import): copy, check the size, then delete the original.
     * Other errors are real.
     */
    if (err.code !== 'EXDEV') throw err;

    how = 'copy';
    await copyFile(routed.from, routed.to);

    const [before, after] = await Promise.all([stat(routed.from), stat(routed.to)]);
    if (before.size !== after.size) {
      await rm(routed.to, { force: true });
      throw new Error(`The copy came out ${after.size} bytes against the original's ${before.size}. Nothing was deleted.`);
    }
    await rm(routed.from, { force: true });
  }

  const took = Date.now() - began;

  /*
   * Scan both folders; Stash matches the moved file by fingerprint. A scan
   * that won't start is reported, not a failure — the file has moved.
   */
  let scanned = true;
  await gql(
    config,
    'mutation($p: [String!]) { metadataScan(input: {paths: $p}) }',
    { p: [dirname(ready.from), ready.dir] }
  ).catch((err) => {
    scanned = false;
    console.warn('[tpdbarr] filed but Stash would not rescan -', err.message);
  });

  return { from: ready.from, to: ready.to, how, ms: took, scanned };
}
