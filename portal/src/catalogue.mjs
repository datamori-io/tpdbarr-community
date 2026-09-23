/*
 * The catalogue overview — what is left to do, and where it is.
 *
 * The three tools under this tab each answer one question well and none of
 * them can tell you whether it is the question worth answering today. Match
 * shows you a pile; it cannot say that the pile is small now and the real gap
 * is markers. Wild Card works one scene at a time by design. So this is the
 * page that says which of them to open.
 *
 * **Counted, not estimated.** Every number here is a filter Stash actually
 * ran. That matters more than it sounds: the phash gap was described as a
 * pc-import problem all morning on the strength of one page of results, and
 * counting it properly showed /organized_scenes holding the larger share.
 * A landing page whose numbers are indicative is a landing page that sends you
 * to the wrong tool.
 *
 * It is one pass over the library rather than six filtered counts, because the
 * folder breakdown needs every scene's path anyway and asking Stash six more
 * times for numbers we are already holding would be slower and could disagree
 * with itself between queries.
 */

import { gql } from './stash.mjs';

/*
 * Everything needed to count, and nothing else. No titles, no descriptions, no
 * artwork URLs — this is three and a half thousand scenes and the difference
 * between this shape and the full one is megabytes.
 */
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

// An id of "0" is what a scraper files when it did not find one. Left on the
// record because it is not ours to delete, and counted as no id at all — the
// same rule matchsort.mjs keeps.
const realId = (s) => s?.stash_id && String(s.stash_id) !== '0';

const hasPhash = (file) => (file?.fingerprints || []).some((f) => /phash/i.test(f.type));

// The top-level folder, which is the only part of a path worth grouping on
// here — /pc-import and /organized_scenes are different kinds of work, and
// which subfolder inside them is not.
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
     * The cover is the one thing that cannot be counted from this row.
     * Stash answers a missing cover with a 200 and a placeholder rather than a
     * 404, so `paths.screenshot` is always populated and never means anything
     * — see scenethumb.mjs, which exists entirely because of it. Asked as its
     * own filtered count below instead.
     */
  }

  return {
    totals: { ...totals, noCover: await countNoCover(config) },
    folders: [...folders.values()].sort((a, b) => b.scenes - a.scenes),
  };
}

/*
 * The no-cover pile, asked of Stash rather than counted here.
 *
 * `is_missing` is a filter Stash answers itself against its own idea of what a
 * cover is, which is the only reliable source for it — the screenshot path on
 * a scene tells you nothing.
 */
async function countNoCover(config) {
  const data = await gql(
    config,
    '{ findScenes(scene_filter: {is_missing: "cover"}, filter: {per_page: 1}) { count } }'
  ).catch(() => null);

  return data?.findScenes?.count ?? null;
}

/* ------------------------------------------------------------------ scanning
 *
 * Telling Stash to go and look at the disk.
 *
 * Every number on this page is a count of what Stash knows about, and Stash
 * only knows about a file it has scanned. A folder the downloader filled an
 * hour ago is not a small pile here — it is no pile at all, and the page reads
 * as finished when it is furthest from it. So the one control that belongs
 * beside the counts is the one that makes them true.
 *
 * Covers and phashes are asked for on the way in. They are the two piles this
 * page counts that a scan can simply avoid creating: a new file that arrives
 * already seen and already fingerprinted never turns up in Match at all.
 */

const JOB_OVER = new Set(['FINISHED', 'CANCELLED', 'FAILED']);

/*
 * A job of this kind already in flight, whoever started it. Stash queues a
 * second one behind the first and then does the whole library twice, so a page
 * offering the button has to be able to say "it is already running" instead.
 */
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
 * The three folders a new file can actually land in.
 *
 * This used to pass no paths at all, which means every library path Stash has
 * configured — seven of them, including /organized_scenes with three and a
 * half thousand files already scanned, /Whisparr-v2 and /Whisparr-v3. Walking
 * those to find a file that arrived an hour ago is minutes of work for an
 * answer that was never going to be in them: a scene only ever *enters* the
 * library through one of these three. Everything else is somewhere it has
 * already been counted, or somewhere it is on its way out of.
 *
 * Written down here rather than read off Stash's settings, which is the
 * opposite of the rule this file keeps everywhere else. It has to be: the
 * point is that these three are different from the other four, and Stash's
 * list cannot say which is which. They are matched against that list on the
 * way past, so a folder renamed in Stash stops being asked for rather than
 * being asked for in vain.
 *
 * Nothing is waited on. The job id is the whole answer: the page polls it.
 */
export const SCAN_PATHS = ['/pc-import', '/Import Folder', '/movies'];

/*
 * `wanted` is for Manage › Stash, whose second scan button walks
 * /organized_scenes on its own — after a re-shelve, or after something on the
 * Mac was moved by hand. The arrival folders stay the default.
 */
export async function startScan(config, wanted = SCAN_PATHS) {
  const running = await scanRunning(config);
  if (running) return { started: false, job: running, why: 'Stash is already scanning — this would queue behind it.' };

  /*
   * Only the ones Stash still has. Asking for a path it does not know is an
   * error on some versions and a silent nothing on others, and neither is a
   * useful answer to "why did my scan not find anything".
   */
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

/* ---------------------------------------------------------------- generating
 *
 * The heavy half of what Stash can make: previews, sprites, image previews and
 * clip previews.
 *
 * Deliberately apart from the phash button above it. A phash is a few seconds
 * of decoding and the thing Match cannot work without, so that button is
 * pressed often and scoped to a pile. This is ffmpeg over whole files across
 * the whole library — hours, not minutes — and it buys the hover preview and
 * the scrub strip rather than an answer to a question.
 *
 * `overwrite: false`, so it fills gaps and leaves alone anything Stash already
 * made.
 *
 * **Scoped to /organized_scenes, not the library.** The other three folders
 * are a scene passing through — waiting on FileFlows, freshly grabbed, waiting
 * on a cut by hand — and a preview built over a file that is about to be
 * re-encoded and moved is thrown away with it. Filed scenes are the ones that
 * stay, and they are the ones the shelves hover and scrub. Counted today:
 * 3,319 of 3,548.
 *
 * Phashes are not in the set on purpose — the card above owns them, and asking
 * for them here would mean two buttons that both quietly do the same work.
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
