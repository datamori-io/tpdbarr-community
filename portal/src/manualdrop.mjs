/*
 * Carry finished NZBGet "Manual" downloads (hand grabs) to the Import
 * Folder, one folder per release, and ask Stash to scan. Only SUCCESS
 * entries. Copy, check size, then delete (a real network transfer). Written
 * via /media4 because /Import Folder is mounted read-only (see share.mjs).
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { loadConfig } from './config.mjs';
import * as nzbget from './nzbget.mjs';
import { gql } from './stash.mjs';

// NZBGet's completed/Manual, as the portal container mounts it.
const FROM = '/nzbget-manual';
// The Import Folder, on the whole-share mount so it is writable.
const TO = '/media4/Import Folder';
// And as Stash knows it, for the scan.
const STASH_TO = '/Import Folder';

const VIDEO = new Set(['.mp4', '.mkv', '.avi', '.wmv', '.mov', '.m4v', '.mpg', '.mpeg', '.ts', '.webm']);
const EVERY = 2 * 60 * 1000;

const exists = (path) => stat(path).then(() => true, () => false);

async function videosIn(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await videosIn(path));
    else if (VIDEO.has(extname(entry.name).toLowerCase())) out.push(path);
  }
  // A sample beside the real thing is not a scene. Alone, it is all there is.
  const real = out.filter((p) => !/\bsample\b/i.test(basename(p)));
  return real.length ? real : out;
}

let running = false;
let last = { at: 0, moved: [], failed: [] };

export const lastSweep = () => ({ ...last, running });

/*
 * -> {moved: [{name, files}], failed: [{name, why}]}
 * Idempotent: a release whose folder is gone was already carried.
 */
export async function sweep(config) {
  if (running) return last;
  if (!nzbget.configured(config) || !(await exists(FROM)) || !(await exists(TO))) return last;
  running = true;

  const category = config.nzbgetCategory || 'Manual';
  const moved = [];
  const failed = [];

  try {
    const history = await nzbget.history(config);
    const done = history.filter((h) => h.Category === category && String(h.Status).startsWith('SUCCESS'));

    for (const h of done) {
      const name = basename(String(h.FinalDir || h.DestDir || '').replace(/\/+$/, ''));
      if (!name) continue;
      const src = join(FROM, name);
      if (!(await exists(src))) continue;

      try {
        const files = await videosIn(src);
        if (!files.length) throw new Error('no video in the download');

        const dir = join(TO, name);
        await mkdir(dir, { recursive: true });

        for (const from of files) {
          const to = join(dir, basename(from));
          await copyFile(from, to);
          const [a, b] = await Promise.all([stat(from), stat(to)]);
          if (a.size !== b.size) {
            await rm(to, { force: true });
            throw new Error(`copy of ${basename(from)} came out ${b.size} bytes against ${a.size}; original kept`);
          }
        }

        // Every video is safely across; what is left is par files and nfo.
        await rm(src, { recursive: true, force: true });

        await gql(config, 'mutation($p: [String!]) { metadataScan(input: {paths: $p}) }', { p: [`${STASH_TO}/${name}`] })
          .catch((err) => console.warn('[tpdbarr] manual drop moved but Stash would not scan -', err.message));

        moved.push({ name, files: files.map((f) => basename(f)) });
        console.log(`[tpdbarr] manual drop: ${name} -> Import Folder`);
      } catch (err) {
        failed.push({ name, why: err.message });
        console.warn(`[tpdbarr] manual drop: ${name} -`, err.message);
      }
    }
  } catch (err) {
    failed.push({ name: '', why: err.message });
  } finally {
    running = false;
  }

  last = { at: Date.now(), moved, failed };
  return last;
}

export function schedule() {
  const tick = async () => {
    try {
      await sweep(await loadConfig());
    } catch (err) {
      console.warn('[tpdbarr] manual drop -', err.message);
    }
  };
  setTimeout(tick, 30_000);
  setInterval(tick, EVERY);
}
