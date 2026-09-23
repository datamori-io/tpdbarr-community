/*
 * Backing up the portal's own state.
 *
 * The code is in git. This is the other half, and the more urgent one: the
 * files in /config are decisions nobody can regenerate. Measured the day this
 * was written — 789 scenes on the want list, 640 ignored, 10 tracked
 * catalogues, plus the RedGIFs and Reddit crawl state. Lose config.json and
 * every percentage in the Import tab goes back to zero with no way to rebuild
 * it, because the thing it was built from was somebody's judgement.
 *
 * The choice was to have the portal do this itself rather than a scheduled task on
 * Windows. **The known cost of that, stated rather than buried:** a portal that
 * is down or broken cannot take a backup, so the newest copy is only ever as
 * fresh as the last time this was running. That is exactly the moment you would
 * want one. It is mitigated by taking a copy on startup — so a crash-and-
 * restart still produces one — and by keeping thirty of them.
 *
 * Two destinations, for two different failures:
 *
 *   /backups      on this machine. A bad write is recoverable in seconds.
 *   the NAS       a dead drive is too. Copied best-effort: the local set is
 *                 written first and is never held up by a share being down.
 *
 * Gzipped, because these are JSON and compress about ten to one — thirty sets
 * of a 3.8 MB config is 114 MB raw and closer to 12 MB like this.
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
 * Everything in the config directory, minus the media.
 *
 * The rule: nothing that can be fetched again goes in a backup, and that
 * includes everything the reel page shows. Almost all the weight here is
 * exactly that — 3727 cached gifs and 1193 cached posts, which is 3.1 MB of
 * the 3.8.
 *
 * But those two files are not *only* cache. redgifs.json also holds the
 * creators, two of which were followed by hand, and reddit.json holds the
 * subreddits added the same way. Dropping the files whole would throw those
 * away with the clips. So the bulk lists come out and the rest stays, which
 * takes a 3.8 MB backup to about 700 KB and loses nothing that was a decision.
 *
 * A field listed here is one that can be fetched again. Anything not listed is
 * kept, which is the safe direction for a rule about what to throw away.
 */
const DROP = {
  'redgifs.json': ['gifs'],
  'reddit.json': ['posts'],
};

/*
 * Every .json at the top of config/, plus the uploaded category artwork one
 * level down.
 *
 * The artwork is here because it is the clearest case there has ever been of
 * The rule: a picture somebody chose and uploaded cannot be fetched again
 * by anything, from anywhere. Everything else in a backup is a list you typed;
 * this is a file you made.
 *
 * It costs more than the rest put together, and that is known rather than
 * discovered later: a cover is capped at 8MB, these do not compress, and there
 * are thirty sets. Bounded by how many categories you have and how big the
 * pictures are, which is a knob you can see — and thirty copies of a picture
 * that changes twice a year is still cheaper than the picture being gone.
 */
/*
 * What is in config/ and is not worth keeping thirty copies of.
 *
 * coverage.json is a cache of what StashDB says about the catalogues you
 * track. Every other file here is something you typed and nothing can work out
 * again; this one rebuilds itself in about two minutes from the source of
 * truth, and it is big enough to be most of a backup set on its own.
 */
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

/*
 * -> the bytes to store for one file.
 *
 * A file with nothing to drop is passed through untouched rather than
 * re-serialised: a backup that reformats what it copies is a backup you cannot
 * diff against the original.
 */
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

/*
 * Oldest sets removed once there are more than KEEP. Done per destination, so
 * the NAS keeps its own thirty even if the local disk was cleared out.
 */
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
 *
 * The local copy is the one that must succeed; the NAS is best-effort and its
 * failure is reported rather than thrown. A share that is down is a thing to
 * tell somebody about, not a reason to have no backup at all.
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

/*
 * What the rest of the app calls. Config saves come in bursts — a click per
 * ignored scene — so this only marks that something changed and lets the gap
 * above decide whether it is worth a copy.
 */
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

/*
 * One on startup, so a portal that crashed and came back has a copy from after
 * the crash rather than from whenever it was last healthy. Delayed a little:
 * the first seconds of a start are the busiest and this is not urgent.
 */
export function onStart() {
  setTimeout(() => run({ force: true, why: 'portal started' }).catch(() => {}), 20000).unref?.();
}
