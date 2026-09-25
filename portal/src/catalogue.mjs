/*
 * The Catalogue overview: what's left to do and where, so you know which
 * tool to open. Every number is counted by Stash, in one pass over the
 * library (the folder breakdown needs every path anyway).
 */

import { gql } from './stash.mjs';

/* Only the fields needed to count. */
const COUNTING = `
  id
  organized
  date
  title
  studio { id }
  stash_ids { endpoint stash_id }
  files { path fingerprints { type } }
  scene_markers { id }
  paths { screenshot }
`;

// A "0" id counts as none (same rule as matchsort.mjs).
const realId = (s) => s?.stash_id && String(s.stash_id) !== '0';

const hasPhash = (file) => (file?.fingerprints || []).some((f) => /phash/i.test(f.type));

// Top-level folder only.
const folderOf = (path) => {
  if (!path) return '(no file)';
  const parts = String(path).split('/').filter(Boolean);
  return parts.length ? '/' + parts[0] : '(no file)';
};

export async function overview(config) {
  const data = await gql(config, `{ findScenes(filter: {per_page: -1}) { count scenes { ${COUNTING} } } }`);
  const scenes = data.findScenes?.scenes || [];

  const folders = new Map();
  const bump = (folder, key) => {
    if (!folders.has(folder)) {
      folders.set(folder, { folder, scenes: 0, noId: 0, noPhash: 0, noMarkers: 0, unorganised: 0 });
    }
    folders.get(folder)[key] += 1;
  };

  const totals = { scenes: scenes.length, noId: 0, noCover: 0, noPhash: 0, noMarkers: 0, unorganised: 0, noTitle: 0, noStudio: 0, noDate: 0 };

  for (const scene of scenes) {
    const file = scene.files?.[0] || null;
    const folder = folderOf(file?.path);
    bump(folder, 'scenes');

    if (!(scene.stash_ids || []).some(realId)) { totals.noId += 1; bump(folder, 'noId'); }
    if (!hasPhash(file)) { totals.noPhash += 1; bump(folder, 'noPhash'); }
    if (!(scene.scene_markers || []).length) { totals.noMarkers += 1; bump(folder, 'noMarkers'); }
    if (!scene.organized) { totals.unorganised += 1; bump(folder, 'unorganised'); }

    if (!scene.title) totals.noTitle += 1;
    if (!scene.studio?.id) totals.noStudio += 1;
    if (!scene.date) totals.noDate += 1;

    /*
     * Covers can't be counted from this row: Stash always fills
     * `paths.screenshot`. Counted separately below.
     */
  }

  return {
    totals: { ...totals, noCover: await countNoCover(config) },
    folders: [...folders.values()].sort((a, b) => b.scenes - a.scenes),
  };
}

/* The no-cover pile via Stash's `is_missing` filter. */
async function countNoCover(config) {
  const data = await gql(
    config,
    '{ findScenes(scene_filter: {is_missing: "cover"}, filter: {per_page: 1}) { count } }'
  ).catch(() => null);

  return data?.findScenes?.count ?? null;
}

/*
 * ------------------------------------------------------------------ scanning
 *
 * Tell Stash to scan, since it only counts what it has scanned. Covers and
 * phashes are generated on the way in, so new files skip those piles.
 */

const JOB_OVER = new Set(['FINISHED', 'CANCELLED', 'FAILED']);

/* A job of this kind already running. Stash would queue a second and repeat the work. */
async function jobLike(config, what) {
  const data = await gql(config, '{ jobQueue { id status description } }').catch(() => null);
  const job = (data?.jobQueue || []).find((j) => what.test(j.description || '') && !JOB_OVER.has(j.status));
  return job ? { id: String(job.id), status: job.status, description: job.description || '' } : null;
}

export const scanRunning = (config) => jobLike(config, /scan/i);
export const generateRunning = (config) => jobLike(config, /generat/i);

export const scanState = async (config) => ({ running: await scanRunning(config) });
export const generateState = async (config) => ({ running: await generateRunning(config) });

/*
 * The three folders new files arrive in. Scanning all seven library paths
 * wastes minutes. Checked against Stash's list, so a renamed folder is skipped.
 * Returns a job id; the page polls.
 */
export const SCAN_PATHS = ['/pc-import', '/Import Folder', '/movies'];

/* `wanted`: Manage › Stash also scans /organized_scenes on its own. */
export async function startScan(config, wanted = SCAN_PATHS) {
  const running = await scanRunning(config);
  if (running) return { started: false, job: running, why: 'Stash is already scanning — this would queue behind it.' };

  /* Only paths Stash still has. */
  const known = await gql(config, '{ configuration { general { stashes { path } } } }')
    .then((d) => (d?.configuration?.general?.stashes || []).map((s) => String(s.path)))
    .catch(() => null);

  const paths = known ? wanted.filter((path) => known.includes(path)) : wanted;

  if (!paths.length) {
    return {
      started: false,
      job: null,
      paths: [],
      why: 'None of ' + wanted.join(', ') + ' is a library path in Stash any more.',
    };
  }

  const data = await gql(
    config,
    'mutation($i: ScanMetadataInput!) { metadataScan(input: $i) }',
    { i: { paths, scanGenerateCovers: true, scanGeneratePhashes: true } }
  );

  return { started: true, job: data.metadataScan ? String(data.metadataScan) : null, paths, why: '' };
}

export async function jobStatus(config, id, running = scanRunning) {
  if (!id) return { job: null, running: await running(config) };

  const data = await gql(
    config,
    'query($id: ID!) { findJob(input: {id: $id}) { id status progress description error } }',
    { id: String(id) }
  ).catch(() => null);

  const job = data?.findJob || null;
  // Stash forgets a job once it is over, so a job it cannot find is a job that
  // finished — the same reading matchsort.mjs takes of the same silence.
  if (!job) return { job: { id: String(id), status: 'FINISHED', progress: 1, over: true }, running: null };

  return {
    job: {
      id: String(job.id),
      status: job.status,
      progress: typeof job.progress === 'number' ? job.progress : null,
      description: job.description || '',
      error: job.error || '',
      over: JOB_OVER.has(job.status),
    },
    running: null,
  };
}

export const scanStatus = (config, id) => jobStatus(config, id, scanRunning);
export const generateStatus = (config, id) => jobStatus(config, id, generateRunning);

/*
 * ---------------------------------------------------------------- generating
 *
 * Previews, sprites, image and clip previews. Hours of ffmpeg.
 * `overwrite: false`. Only /organized_scenes: files elsewhere are about to be
 * re-encoded. Phashes have their own button.
 */
const FILED = '/organized_scenes/';

export async function generateMedia(config) {
  const running = await generateRunning(config);
  if (running) return { started: false, scenes: 0, job: running, why: 'Stash is already generating — this would queue behind it.' };

  const found = await gql(
    config,
    `{ findScenes(scene_filter: {path: {value: "${FILED}", modifier: INCLUDES}}, filter: {per_page: -1}) { scenes { id } } }`
  );

  const ids = (found.findScenes?.scenes || []).map((s) => String(s.id));
  if (!ids.length) return { started: false, scenes: 0, job: null, why: 'Nothing is filed in ' + FILED + ' yet.' };

  const data = await gql(
    config,
    'mutation($i: GenerateMetadataInput!) { metadataGenerate(input: $i) }',
    { i: { previews: true, imagePreviews: true, sprites: true, clipPreviews: true, sceneIDs: ids, overwrite: false } }
  );

  return { started: true, scenes: ids.length, job: data.metadataGenerate ? String(data.metadataGenerate) : null, why: '' };
}
