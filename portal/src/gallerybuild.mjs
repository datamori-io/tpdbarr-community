/*
 * Building a gallery: the one thing in this portal that puts files on a disk
 * Stash owns.
 *
 * The chain is four steps and each can fail on its own, so the job carries
 * which one it is on rather than a spinner:
 *
 *   1. write   — the chosen pictures into <galleryPath>/<name>/
 *   2. scan    — metadataScan on <galleryStashPath>/<name>, so Stash imports them
 *   3. find    — the gallery Stash just made, matched on that path
 *   4. tie     — galleryUpdate with the scene, performer or movie it belongs to
 *
 * Stash is the library of record here as everywhere else: the portal does not
 * keep a gallery of its own, and if step 2 never finds the folder then there is
 * no gallery — which is why setupState() is checked before a byte is written
 * rather than after. The usual cause is the one thing the portal cannot do for
 * you: Stash's library paths all have excludeImage set, because until now this
 * house only ever scanned video.
 */

import { mkdir, writeFile, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { gql } from './stash.mjs';
import { headers } from './galleryscrape.mjs';

// Anything smaller is a spacer, a logo or a broken download, whatever the URL
// looked like. Cheaper to check here than to guess before fetching.
const MIN_BYTES = 15000;
const MAX_BYTES = 40 * 1024 * 1024;
const AT_ONCE = 4;

const TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
};

const jobs = new Map();
let nextId = 1;

/* --------------------------------------------------------------- the folder */

// A folder name Stash and every filesystem will take, from a page title that
// may contain anything at all.
export function folderName(name) {
  const clean = String(name || '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);

  return clean || `gallery-${Date.now()}`;
}

/*
 * Where things stand before anything is written. Both halves of the path are
 * reported back rather than assumed to agree, because they name one folder
 * through two containers and swapping them is the mistake this makes.
 */
export async function setupState(config) {
  const state = {
    path: config.galleryPath || '',
    stashPath: config.galleryStashPath || '',
    writable: false,
    covered: false,
    excludesImages: false,
    foldersAreGalleries: false,
    stashes: [],
    error: null,
  };

  if (!state.path || !state.stashPath) {
    state.error = 'Set both gallery folders in Settings — one as the portal sees it, one as Stash does.';
    return state;
  }

  try {
    await mkdir(state.path, { recursive: true });
    await access(state.path, constants.W_OK);
    state.writable = true;
  } catch (err) {
    state.error = `The portal cannot write to ${state.path} — is it mounted? (${err.code || err.message})`;
  }

  try {
    const data = await gql(config, '{ configuration { general { createGalleriesFromFolders stashes { path excludeVideo excludeImage } } } }');
    state.stashes = data.configuration?.general?.stashes || [];

    /*
     * The setting the whole feature turns on. Without it a scan of a folder of
     * pictures produces loose images and no gallery at all — which looks like
     * the scan silently doing nothing, because the Galleries page stays empty
     * while the image count climbs.
     */
    state.foldersAreGalleries = Boolean(data.configuration?.general?.createGalleriesFromFolders);

    const under = (root) => state.stashPath === root || state.stashPath.startsWith(root.replace(/\/+$/, '') + '/');
    const covering = state.stashes.filter((s) => under(s.path));

    state.covered = covering.length > 0;
    // Every library path in this Stash excludes images today, which is the
    // whole reason a scan would come back with nothing.
    state.excludesImages = covering.length > 0 && covering.every((s) => s.excludeImage);
  } catch (err) {
    state.error = state.error || `Stash -> ${err.message}`;
  }

  state.ready = Boolean(state.writable && state.covered && !state.excludesImages && state.foldersAreGalleries);
  return state;
}

/*
 * Add the gallery folder to Stash's library paths, images included.
 *
 * A settings write on somebody else's application, so it happens on a button
 * and never on the way past. configureGeneral replaces the whole list, so the
 * existing paths are read and sent back with one appended — losing them would
 * mean a rescan of 1767 scenes.
 */
export async function enableInStash(config) {
  const stashPath = config.galleryStashPath;
  if (!stashPath) throw new Error('Set the Stash-side gallery folder first.');

  const data = await gql(config, '{ configuration { general { stashes { path excludeVideo excludeImage } } } }');
  const stashes = (data.configuration?.general?.stashes || []).map((s) => ({
    path: s.path,
    excludeVideo: !!s.excludeVideo,
    excludeImage: !!s.excludeImage,
  }));

  const existing = stashes.find((s) => s.path === stashPath);
  if (existing) {
    existing.excludeImage = false;
  } else {
    // Video excluded: this folder is pictures, and nothing should ever try to
    // import a film from it.
    stashes.push({ path: stashPath, excludeVideo: true, excludeImage: false });
  }

  /*
   * createGalleriesFromFolders goes on at the same time, because the path alone
   * does nothing: Stash would scan the pictures in and leave them as loose
   * images with no gallery over them.
   *
   * It is a global setting rather than a per-path one, but in this Stash it
   * only reaches this folder — every other library path excludes images, so
   * there are no other folders of pictures for it to group.
   */
  const out = await gql(
    config,
    `mutation($s: [StashConfigInput!]) {
       configureGeneral(input: {stashes: $s, createGalleriesFromFolders: true}) {
         createGalleriesFromFolders
         stashes { path excludeVideo excludeImage }
       }
     }`,
    { s: stashes }
  );

  return {
    stashes: out.configureGeneral.stashes,
    foldersAreGalleries: out.configureGeneral.createGalleriesFromFolders,
  };
}

/*
 * Tell Stash to look at a folder again, and wait until it has.
 *
 * Adding pictures to a gallery that already exists is the same two steps as
 * step 2 and 3 of a build, without the tying: the folder is already a gallery,
 * so what comes back is simply more images in it. Waiting for the scan to
 * finish matters here for the same reason it does there — the page that asked
 * is about to redraw and would otherwise show the old count.
 */
export async function rescan(config, stashPath) {
  const job = { stashPath };
  await scan(config, job);
  await waitForScan(config, job);
  return { scanned: stashPath, job: job.scanJob || null };
}

/* ---------------------------------------------------------------- the job */

export function snapshot(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  const { timer, ...rest } = job;
  return rest;
}

export const forgetJobs = () => jobs.clear();

/*
 * -> the job, straight away. Downloading forty pictures and waiting on a Stash
 * scan is a minute of work, and a request that sits open for a minute is a
 * request that dies to a proxy timeout.
 */
/*
 * Where a gallery of this name would be written, and the same folder as Stash
 * will see it. The upload route needs the first of these before there is a job
 * to ask, because the files arrive one request at a time and the build only
 * starts once they are all in.
 */
export function folderFor(config, name) {
  const folder = folderName(name);
  return {
    folder,
    path: join(config.galleryPath, folder),
    stashPath: `${String(config.galleryStashPath).replace(/\/+$/, '')}/${folder}`,
  };
}

/*
 * The reverse, for a gallery that already exists: Stash reports where its
 * folder is, and adding pictures to it means writing there.
 *
 * -> null for a gallery outside the managed folder. Stash may well be scanning
 * photo sets this app has never touched, and writing into one of those is not
 * this app's business.
 */
export function portalPathFor(config, stashPath) {
  const root = String(config.galleryStashPath || '').replace(/\/+$/, '');
  const here = String(stashPath || '').replace(/\/+$/, '');
  if (!root || !here) return null;
  if (here !== root && !here.startsWith(root + '/')) return null;

  return join(config.galleryPath, here.slice(root.length));
}

export function start(config, { name, items, tie = {} }) {
  const id = String(nextId++);
  const folder = folderName(name);

  const job = {
    id,
    name: name || folder,
    folder,
    path: join(config.galleryPath, folder),
    stashPath: `${String(config.galleryStashPath).replace(/\/+$/, '')}/${folder}`,
    stage: 'writing',
    total: items.length,
    done: 0,
    written: 0,
    skipped: 0,
    failed: [],
    gallery: null,
    error: null,
    at: Date.now(),
  };

  jobs.set(id, job);
  run(config, job, items, tie).catch((err) => {
    job.stage = 'failed';
    job.error = err.message;
  });

  return job;
}

async function run(config, job, items, tie) {
  await mkdir(job.path, { recursive: true });

  // Building into a folder that already has pictures in it appends rather than
  // renumbering, so a second pass on the same set does not shuffle the first.
  const already = await readdir(job.path).catch(() => []);
  let index = already.length;

  /*
   * An upload has already put its files there — the browser sent them one at a
   * time and the build is only the half that comes after. Nothing to fetch, so
   * the count of what is on disk stands in for what was written.
   */
  if (!items.length) {
    job.written = already.length;
    job.total = already.length;
    job.done = already.length;

    if (!job.written) {
      job.stage = 'failed';
      job.error = 'No pictures were uploaded.';
      return;
    }
  }

  const queue = [...items];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const position = ++index;
      try {
        const wrote = await download(job, item, position);
        if (wrote) job.written++;
        else job.skipped++;
      } catch (err) {
        job.failed.push({ url: item.url, why: err.message });
      } finally {
        job.done++;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));

  if (!job.written) {
    job.stage = 'failed';
    job.error = job.failed.length
      ? `Nothing downloaded — ${job.failed[0].why}`
      : 'Nothing downloaded: every picture was too small to be one.';
    return;
  }

  job.stage = 'scanning';
  await scan(config, job);

  /*
   * Wait for the scan to *finish*, not just for the gallery to turn up.
   *
   * A folder gallery takes its title from the folder, and Stash re-saves it as
   * each picture lands — so tying it while the scan is still running gets the
   * title wiped a second later. That is not hypothetical: the first gallery
   * built here came out with an empty title for exactly this reason.
   */
  await waitForScan(config, job);

  job.stage = 'finding';
  const gallery = await waitForGallery(config, job);

  if (!gallery) {
    job.stage = 'failed';
    job.error =
      `The files are in ${job.path}, but Stash has not made a gallery from ${job.stashPath}. ` +
      'Check that path is one of its library paths and that it does not exclude images.';
    return;
  }

  job.stage = 'tying';
  try {
    job.gallery = await describe(config, gallery.id, job, tie);
  } catch (err) {
    /*
     * The pictures are in and the gallery exists; only the title and the ties
     * did not take. Worth saying so rather than swallowing it — a gallery tied
     * to nothing is the thing this feature was asked for.
     */
    job.gallery = { id: gallery.id, title: null, image_count: gallery.image_count };
    job.tieError = err.message;
  }
  job.stage = 'done';
}

async function download(job, item, position) {
  const res = await fetch(item.url, {
    headers: headers(item.referer || null),
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) throw new Error(`${res.status} from ${new URL(item.url).hostname}`);

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type && !type.startsWith('image/')) throw new Error(`${type || 'unknown type'} is not an image`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('over 40MB');

  const body = Buffer.from(await res.arrayBuffer());
  if (body.length < MIN_BYTES) return false;
  if (body.length > MAX_BYTES) throw new Error('over 40MB');

  const ext = TYPES[type] || extFromUrl(item.url) || '.jpg';
  // Numbered, because the order they were found in is the order of the set —
  // and Stash sorts a gallery by filename.
  const file = String(position).padStart(3, '0') + ext;

  await writeFile(join(job.path, file), body, { flag: 'wx' }).catch((err) => {
    if (err.code !== 'EEXIST') throw err;
  });

  return true;
}

function extFromUrl(url) {
  const hit = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i.exec(url);
  if (!hit) return null;
  const ext = hit[1].toLowerCase();
  return ext === 'jpeg' ? '.jpg' : '.' + ext;
}

async function scan(config, job) {
  const data = await gql(
    config,
    `mutation($p: [String!]) {
       metadataScan(input: {paths: $p, scanGenerateCovers: true, scanGenerateThumbnails: true})
     }`,
    { p: [job.stashPath] }
  );
  job.scanJob = data.metadataScan || null;
}

/*
 * Sit on the scan job until Stash says it is done with it. A scan of one small
 * folder is quick, but "quick" is not "instant" and the tie has to come after.
 * A job id Stash has already forgotten reads as finished, which is right — it
 * only forgets a job once it is over.
 */
const OVER = new Set(['FINISHED', 'CANCELLED', 'FAILED']);

async function waitForScan(config, job, { tries = 60, gap = 1000 } = {}) {
  if (!job.scanJob) return;

  for (let i = 0; i < tries; i++) {
    const data = await gql(
      config,
      'query($id: ID!) { findJob(input: {id: $id}) { status error } }',
      { id: String(job.scanJob) }
    ).catch(() => null);

    const status = data?.findJob?.status;
    if (!status || OVER.has(status)) return;
    await new Promise((r) => setTimeout(r, gap));
  }
}

/*
 * Wait for the scan to land. Polling the gallery rather than the scan job is
 * what actually answers the question — a scan that finished and imported
 * nothing is the failure mode here, and the job would report that as success.
 */
async function waitForGallery(config, job, { tries = 40, gap = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const found = await byPath(config, job.stashPath).catch(() => null);
    if (found) return found;
    await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

async function byPath(config, path) {
  const data = await gql(
    config,
    `query($f: GalleryFilterType) {
       findGalleries(gallery_filter: $f, filter: {per_page: 5, sort: "created_at", direction: DESC}) {
         galleries { id title image_count folder { path } files { path } }
       }
     }`,
    { f: { path: { value: path, modifier: 'INCLUDES' } } }
  );

  return (data.findGalleries.galleries || []).find((g) => g.image_count > 0) || null;
}

/*
 * Step four: what it is, and what it belongs to. The ties are ids the caller
 * already had — the scene page knows its own scene, the performer page its own
 * performer — so nothing is matched or guessed here.
 */
async function describe(config, id, job, tie) {
  const input = { id, title: job.name };
  if (tie.date) input.date = tie.date;
  if (tie.sceneIds?.length) input.scene_ids = tie.sceneIds.map(String);
  if (tie.performerIds?.length) input.performer_ids = tie.performerIds.map(String);
  if (tie.studioId) input.studio_id = String(tie.studioId);
  if (tie.url) input.urls = [tie.url];

  const data = await gql(
    config,
    `mutation($i: GalleryUpdateInput!) {
       galleryUpdate(input: $i) { id title image_count }
     }`,
    { i: input }
  );

  return data.galleryUpdate;
}
