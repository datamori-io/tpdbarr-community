/*
 * Backing up /config: decisions nobody can regenerate (want list, ignores,
 * tracked catalogues, crawl state).
 *
 * Run by the portal itself, so a portal that's down takes no backups. One is
 * taken on startup, and thirty are kept.
 *
 *   /backups      on this machine
 *   the NAS       best effort; the local copy is never held up by it
 *
 * Gzipped JSON.
 */

import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const LOCAL_DIR = process.env.BACKUP_DIR || '/backups';
const NAS_DIR = process.env.BACKUP_NAS_DIR || '/nas-backup';

const KEEP = 30;
// A backup per ignored scene would be six hundred backups. State changes in
// bursts; this is the shortest gap worth taking a new copy across.
const MIN_GAP = 30 * 60 * 1000;

let last = 0;
let running = null;
let history = []; // newest first, for the page

export const snapshot = () => ({ backups: history, running: Boolean(running), last });

const stamp = () =>
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/*
 * Fields that can be fetched again, dropped from the backup (the cached
 * gifs and posts). Hand-followed creators and subreddits in the same files
 * are kept. Anything not listed is kept.
 */
const DROP = {
  'redgifs.json': ['gifs'],
  'reddit.json': ['posts'],
};

/*
 * Every top-level .json in config/, plus uploaded category artwork (it
 * can't be fetched again). Artwork doesn't compress; covers are capped at 8MB.
 */
/* coverage.json is a cache that rebuilds itself; not kept. */
const DERIVED = new Set(['coverage.json']);

async function sources() {
  const names = await readdir(CONFIG_DIR).catch(() => []);
  const art = await readdir(join(CONFIG_DIR, 'covers')).catch(() => []);

  return [
    ...names.filter((name) => name.endsWith('.json') && !DERIVED.has(name)),
    // Kept as a path so the set on disk mirrors config/ rather than flattening
    // a picture called covers/wedding.png into the top of the folder.
    ...art.map((name) => join('covers', name)),
  ];
}

/* -> the bytes to store. Files with nothing to drop are copied unchanged. */
function trim(file, body) {
  const drop = DROP[file];
  if (!drop) return { body, dropped: [] };

  try {
    const data = JSON.parse(body.toString('utf8'));
    const dropped = [];

    for (const key of drop) {
      if (Array.isArray(data[key]) && data[key].length) {
        dropped.push(`${key} (${data[key].length})`);
        data[key] = [];
      }
    }

    if (!dropped.length) return { body, dropped: [] };
    return { body: Buffer.from(JSON.stringify(data), 'utf8'), dropped };
  } catch {
    // Unparseable is still worth keeping whole — better a big backup than none.
    return { body, dropped: [] };
  }
}

async function writeSet(root, name, files) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });

  let bytes = 0;
  for (const [file, packed] of files) {
    const at = join(dir, file + '.gz');
    // A file one level down needs its folder made first. Everything else is
    // already at the top of the set and this is a no-op for it.
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, packed);
    bytes += packed.length;
  }
  return { dir, bytes };
}

/* Remove the oldest sets beyond KEEP, per destination. */
async function prune(root) {
  const names = (await readdir(root).catch(() => []))
    .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
    .sort();

  for (const old of names.slice(0, Math.max(0, names.length - KEEP))) {
    await rm(join(root, old), { recursive: true, force: true }).catch(() => {});
  }

  return names.length;
}

/*
 * -> {name, files, bytes, local, nas}
 * The local copy must succeed; a NAS failure is reported, not thrown.
 */
export async function run({ force = false, why = 'asked for' } = {}) {
  if (running) return running;
  if (!force && Date.now() - last < MIN_GAP) {
    return { skipped: true, why: 'one was taken less than half an hour ago' };
  }

  running = (async () => {
    const name = stamp();

    const files = [];
    const dropped = [];
    let raw = 0;

    for (const file of await sources()) {
      const body = await readFile(join(CONFIG_DIR, file)).catch(() => null);
      if (!body) continue;

      const kept = trim(file, body);
      for (const what of kept.dropped) dropped.push(`${file}: ${what}`);

      raw += kept.body.length;
      files.push([file, await compress(kept.body)]);
    }

    if (!files.length) throw new Error('nothing in the config directory to back up');

    const local = await writeSet(LOCAL_DIR, name, files);
    await prune(LOCAL_DIR);

    // Best effort, and named honestly when it fails.
    let nas = { ok: false, error: 'not mounted' };
    try {
      await stat(NAS_DIR);
      const there = await writeSet(NAS_DIR, name, files);
      await prune(NAS_DIR);
      nas = { ok: true, dir: there.dir };
    } catch (err) {
      nas = { ok: false, error: err.message };
    }

    last = Date.now();
    const record = {
      name,
      why,
      at: new Date().toISOString(),
      files: files.length,
      raw,
      bytes: local.bytes,
      dropped,
      nas: nas.ok,
      nasError: nas.ok ? null : nas.error,
    };

    history = [record, ...history].slice(0, KEEP);
    console.log(
      `[tpdbarr] backup ${name} — ${files.length} files, ${Math.round(local.bytes / 1024)} KB` +
      (nas.ok ? ', copied to the NAS' : `, NAS: ${nas.error}`)
    );

    return record;
  })().finally(() => { running = null; });

  return running;
}

/* Mark a change; the minimum gap decides whether a copy is taken. */
export function changed(why = 'config changed') {
  run({ why }).catch((err) => console.warn('[tpdbarr] backup failed -', err.message));
}

// What is already on disk, so the page shows the real thing rather than only
// what this process happens to have taken since it started.
export async function existing() {
  const names = (await readdir(LOCAL_DIR).catch(() => []))
    .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
    .sort()
    .reverse();

  const out = [];
  for (const name of names.slice(0, KEEP)) {
    const dir = join(LOCAL_DIR, name);
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.gz'));

    let bytes = 0;
    for (const file of files) {
      const info = await stat(join(dir, file)).catch(() => null);
      if (info) bytes += info.size;
    }

    out.push({ name, files: files.length, bytes, at: name.replace(/-/g, (m, i) => (i > 9 ? ':' : '-')) });
  }

  return out;
}

/* One on startup, after a short delay. */
export function onStart() {
  setTimeout(() => run({ force: true, why: 'portal started' }).catch(() => {}), 20000).unref?.();
}
