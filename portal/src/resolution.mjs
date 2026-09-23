/*
 * What resolution a scene should end up at, and keeping FileFlows off it.
 *
 * FileFlows' "Organized Scenes" library watches the filed library and runs
 * "H264 Encoding (Fast)" on everything in it, which scales anything wider than
 * 1280 down to 720p and replaces the original. So 720p is the default without
 * anybody pressing anything. Every other outcome — keeping a 4K file as it is,
 * taking it to 1080p, taking something to 480p — only survives if FileFlows is
 * told to leave the file alone afterwards.
 *
 * That is a blank `.fileflows-ignore` in the scene's folder. The flow's first
 * step after "Video File" checks for it and ends there if it exists. A filed
 * scene is one folder per scene (see filer.mjs), so the flag covers exactly one
 * scene. **The rule: whenever the portal decides a file, it writes the flag.**
 *
 * Two moments:
 *
 *   not filed yet  the choice is remembered here, and filing writes the flag
 *                  into the destination folder *before* the file arrives, so
 *                  FileFlows never sees the file unflagged. An encode choice
 *                  starts once the file is in place.
 *   already filed  the choice acts at once: flag, then encode if asked.
 *
 * Encoding only ever happens in /organized_scenes — see downscale.mjs for why.
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

/* ------------------------------------------------------------ the store
 *
 * Only choices for scenes not filed yet. Once a scene is filed its choice is
 * the flag on disk, and a second record of it here would be one that drifts.
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

/* ------------------------------------------------------------- the target
 *
 * What a scene is meant to end up at, for the colour on its tile. Red is a
 * file still bigger than that, yellow is at or under it but not finished, and
 * green is filed, organised and at it.
 *
 *   not filed, a choice made   that choice ('keep' is the file as it is)
 *   filed and flagged          the file as it is — the flag means "leave it"
 *   a film, in /movies         the file as it is — FileFlows never goes there
 *   anything else              720, what FileFlows turns a filed scene into
 *
 * The tile has to be drawn from one synchronous read, and a filed scene's
 * choice lives only on disk as the flag. So the flags are swept into memory
 * alongside the shelf read — one stat per filed folder, about a second and a
 * half for four thousand of them — and kept for ten minutes. A flag this
 * module writes or removes updates the set at once.
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

/*
 * What is on offer for a file this tall. Keep only means something above
 * 720p, since that is where FileFlows would otherwise step in; 1080p only
 * means something above 1080p.
 */
function offered(height) {
  const out = [];
  if (height > 720) out.push('keep');
  if (height > 1080) out.push(1080);
  if (height > 720) out.push(720);
  if (height > 480) out.push(480);
  return out;
}

/*
 * -> everything the File card needs to draw itself. Asked before it draws, so
 * a control that cannot do anything says why instead of failing when pressed.
 */
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

/*
 * Handing a filed file back to FileFlows. The one undo on this card: it
 * removes the flag, and FileFlows treats the file as it would any other.
 */
export async function release(config, sceneId) {
  const now = await plan(config, sceneId);
  if (!now.filed) throw refuse('Only a filed scene has a flag to take off.');
  await rm(join(dirname(now.path), IGNORE), { force: true });
  flags.dirs.delete(dirname(now.path));
  return plan(config, sceneId);
}

/* ------------------------------------------------------------- at filing
 *
 * Called by filer.mjs with the destination folder, after it exists and before
 * the file is moved into it. Anything but the default puts the flag there
 * first.
 */
export async function beforeFiling(sceneId, dir) {
  const choice = (await load()).scenes[sceneId]?.choice;
  if (choice && choice !== 720) await flag(dir);
}

/*
 * And once the file has arrived: start the encode it was waiting for, and let
 * the remembered choice go — from here on the flag is the record. An encode
 * that will not start (another is running, or it is not an .mp4) is reported
 * rather than retried; the flag is already down, so FileFlows will not touch
 * it, and the card offers the encode again.
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
 * The encoder reads the path from Stash, and Stash only learns the new one
 * from the rescan filing asked for — which runs as a job and takes a few
 * seconds. Started before then, the encoder sees the old folder and refuses.
 * So: wait until Stash says the file is filed, for two minutes at most.
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
