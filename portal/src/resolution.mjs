/*
 * Target resolution per scene, and keeping FileFlows off it.
 *
 * FileFlows' Organized Scenes flow scales anything wider than 1280 to 720p.
 * Any other choice survives only with a blank `.fileflows-ignore` in the
 * scene's folder. Whenever the portal decides a file, it writes the flag.
 *
 *   not filed yet  remembered here; filing writes the flag before the file
 *                  arrives, then any encode starts
 *   already filed  flag now, then encode if asked
 *
 * Encoding only in /organized_scenes (see downscale.mjs).
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import { gql } from './stash.mjs';
import * as downscale from './downscale.mjs';

export const IGNORE = '.fileflows-ignore';

const FILED = '/organized_scenes/';
const FILMS = '/movies/';
const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'resolution.json');

const CHOICES = ['keep', 480, 720, 1080];

const refuse = (message) => Object.assign(new Error(message), { status: 400 });

/*
 * ------------------------------------------------------------ the store
 *
 * Choices for unfiled scenes only. Once filed, the flag is the record.
 */

let cache = null;

async function load() {
  if (cache) return cache;
  cache = await readFile(PATH, 'utf8').then(JSON.parse).catch(() => ({}));
  if (!cache.scenes || typeof cache.scenes !== 'object') cache = { scenes: {} };
  return cache;
}

async function save() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(PATH + '.tmp', JSON.stringify(cache, null, 2), 'utf8');
  await rename(PATH + '.tmp', PATH);
}

/* --------------------------------------------------------------- the flag */

export async function flag(dir) {
  await writeFile(join(dir, IGNORE), '');
  flags.dirs.add(dir);
}

/*
 * ------------------------------------------------------------- the target
 *
 * The target for a tile's colour:
 *
 *   not filed, a choice made   that choice ('keep' is the file as it is)
 *   filed and flagged          the file as it is
 *   a film, in /movies         the file as it is
 *   anything else              720
 *
 * Flags are swept into memory with the shelf read (one stat per folder)
 * and kept ten minutes; writes here update the set.
 */
export const DEFAULT_TARGET = 720;
const FLAG_TTL = 10 * 60 * 1000;
const flags = { dirs: new Set(), at: 0, busy: null };

export async function warm(paths) {
  await load();
  if (flags.busy) return flags.busy;
  if (Date.now() - flags.at < FLAG_TTL) return null;

  const dirs = [...new Set(paths.filter((p) => String(p || '').includes(FILED)).map((p) => dirname(p)))];
  flags.busy = (async () => {
    const found = new Set();
    for (let i = 0; i < dirs.length; i += 48) {
      const batch = dirs.slice(i, i + 48);
      const hits = await Promise.all(batch.map(flagged));
      batch.forEach((dir, n) => { if (hits[n]) found.add(dir); });
    }
    flags.dirs = found;
    flags.at = Date.now();
  })().finally(() => { flags.busy = null; });
  return flags.busy;
}

export function targetOf(sceneId, height, path) {
  const pending = cache?.scenes?.[sceneId]?.choice;
  if (pending) return pending === 'keep' ? height : pending;
  if (path && String(path).includes(FILED) && flags.dirs.has(dirname(path))) return height;
  if (path && String(path).includes(FILMS)) return height;
  return DEFAULT_TARGET;
}

const flagged = (dir) => stat(join(dir, IGNORE)).then(() => true, () => false);

/* --------------------------------------------------------------- the file */

async function fileOf(config, sceneId) {
  const data = await gql(
    config,
    'query($id: ID!) { findScene(id: $id) { id files { path size height } } }',
    { id: String(sceneId) }
  );
  const file = data.findScene?.files?.[0];
  if (!file?.path) throw refuse('Stash does not say where that scene\'s file is.');
  return file;
}

/* Options for a file this tall: Keep only above 720p, 1080p only above 1080p. */
function offered(height) {
  const out = [];
  if (height > 720) out.push('keep');
  if (height > 1080) out.push(1080);
  if (height > 720) out.push(720);
  if (height > 480) out.push(480);
  return out;
}

/* -> what the File card needs, including why a control can't act. */
export async function plan(config, sceneId) {
  const file = await fileOf(config, sceneId);
  const filed = String(file.path).includes(FILED);
  const height = file.height || 0;
  const mp4 = extname(file.path).toLowerCase() === '.mp4';

  const base = {
    path: file.path,
    height,
    size: file.size || 0,
    filed,
    flagged: filed ? await flagged(dirname(file.path)) : false,
    pending: filed ? null : ((await load()).scenes[sceneId]?.choice ?? null),
  };

  if (!height) return { ...base, options: [], reason: 'Stash does not know how tall this file is.' };

  const options = offered(height).map((value) => ({
    value,
    default: value === 720,
    // An encode only happens to a filed .mp4. Keep never encodes, so it is
    // always open; a choice made before filing is only a note until then.
    can: value === 'keep' || !filed || mp4,
    why: value !== 'keep' && filed && !mp4
      ? 'Only .mp4 files can be re-encoded in place.'
      : '',
  }));

  if (!options.length) {
    return { ...base, options, reason: `Already ${height}p — there is nothing smaller on offer.` };
  }
  return { ...base, options, reason: '' };
}

/* ---------------------------------------------------------- the choosing */

export async function choose(config, sceneId, raw) {
  const choice = raw === 'keep' ? 'keep' : Number(raw);
  if (!CHOICES.includes(choice)) throw refuse('That is not a resolution this offers.');

  const now = await plan(config, sceneId);
  const option = now.options.find((o) => o.value === choice);
  if (!option) throw refuse(now.reason || `A ${now.height}p file has no ${choice}${choice === 'keep' ? '' : 'p'} on offer.`);
  if (!option.can) throw refuse(option.why);

  if (!now.filed) {
    const store = await load();
    // 720 is what filing leads to anyway, so choosing it is choosing nothing.
    if (choice === 720) delete store.scenes[sceneId];
    else store.scenes[sceneId] = { choice, at: new Date().toISOString() };
    await save();
    return plan(config, sceneId);
  }

  // Filed: the flag first, so FileFlows cannot pick the file up while the
  // encode is still being written beside it.
  await flag(dirname(now.path));
  if (choice !== 'keep') downscale.start(config, sceneId, choice);
  return plan(config, sceneId);
}

/* Hand the file back to FileFlows: remove the flag. */
export async function release(config, sceneId) {
  const now = await plan(config, sceneId);
  if (!now.filed) throw refuse('Only a filed scene has a flag to take off.');
  await rm(join(dirname(now.path), IGNORE), { force: true });
  flags.dirs.delete(dirname(now.path));
  return plan(config, sceneId);
}

/*
 * ------------------------------------------------------------- at filing
 *
 * Called by filer.mjs after the destination exists, before the move.
 * Non-default choices write the flag first.
 */
export async function beforeFiling(sceneId, dir) {
  const choice = (await load()).scenes[sceneId]?.choice;
  if (choice && choice !== 720) await flag(dir);
}

/*
 * After the move: start any waiting encode and drop the remembered choice.
 * An encode that won't start is reported; the flag keeps FileFlows off.
 */
export async function afterFiling(config, sceneId) {
  const store = await load();
  const choice = store.scenes[sceneId]?.choice;
  if (!choice) return null;

  delete store.scenes[sceneId];
  await save();

  if (choice === 'keep') return { choice };

  // In the background: the filing answer should not wait on Stash's rescan.
  startWhenFiled(config, sceneId, choice).catch((err) => {
    console.warn(`[tpdbarr] scene ${sceneId} filed, ${choice}p encode not started - ${err.message}`);
  });
  return { choice, encoding: true };
}

/*
 * Wait (up to two minutes) until Stash has the new path, or the encoder
 * refuses the old one.
 */
async function startWhenFiled(config, sceneId, height) {
  for (let waited = 0; waited < 120_000; waited += 3000) {
    const file = await fileOf(config, sceneId).catch(() => null);
    if (file && String(file.path).includes(FILED)) {
      downscale.start(config, sceneId, height);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Stash had not picked up the new path after two minutes.');
}
