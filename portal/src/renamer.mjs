/*
 * Renaming a file to what the match said it was.
 *
 * The natural end of the match page. You find the scene, file the ids, take
 * the title and the studio and the date across — and the file on disk is still
 * called "Blair Williams - Oil Overload 15.mp4", which is the guess you started
 * from rather than the answer you finished with.
 *
 * **Scoped to /pc-import and nowhere else.** Everything else this portal can
 * see belongs to somebody: Whisparr and FileFlows move files in and out of
 * their folders constantly, /organized_scenes is the library proper, and a
 * renamer loose in either of those is a way to lose things. pc-import is the
 * staging folder you drop things into yourself. The check is here, on the
 * server, against the resolved path — not in the page that calls it.
 *
 * **Only a matched scene.** The name is built out of what Stash holds, so a
 * scene with nothing in it has nothing to be renamed to and is refused rather
 * than being turned into "untitled.mp4". That is the whole difference between
 * this and the plugin that went through the folder on 2026-09-12: this runs
 * because you pressed it, on one scene, after you have seen what it will say.
 *
 * The shape is `Studio.YYYY-MM-DD.Title.ext`, which is what Whisparr already
 * writes everywhere else in the library and what the filename parser in
 * matchsort.mjs reads best — so a file renamed here comes back through the
 * match page cleaner than it left.
 */

import { rename as renameFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';

import { gql } from './stash.mjs';

/*
 * The one mount this may write to. Not a list and not configurable: a second
 * entry here is a decision worth making in a diff rather than in a config
 * file, and there is currently no second folder that wants it.
 */
const HOME = '/pc-import';

const inside = (path) => {
  const full = resolvePath(String(path || ''));
  return full === HOME || full.startsWith(HOME + '/');
};

/*
 * What a filesystem will take.
 *
 * Windows is the strict one here — this volume is a bind off a Windows host —
 * so its reserved characters go even though the container would accept them.
 * Trailing dots and spaces go for the same reason: Windows silently drops
 * them, and a name that comes back different from the one you asked for is a
 * rename you cannot verify.
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
 * -> { can, why, from, to, dir }
 *
 * Never writes. The page shows `to` and only then offers the press, because a
 * rename you did not read first is a rename you cannot disagree with.
 *
 * `over` is for the caller who has not written yet. Wild Card builds a record
 * out of contributions and only then saves it, so a plan made against what
 * Stash currently holds would show the name the file already has — the point
 * of the preview there is the name it is *about* to deserve. Only the three
 * fields the name is made of are read, and only where the caller gave one, so
 * an override cannot smuggle a path in or blank a field out.
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
  // Neutral about how the title was meant to get there: Match files it off a
  // stash id, Wild Card has you pick one off a contribution, and both pages
  // reach this line the same way.
  if (!title) return no('No title to rename it to — the name is built out of one, so there has to be one first.');

  const studio = clean(scene.studio?.name);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(scene.date || '') ? scene.date : '';

  /*
   * Studio, then date, then title — and any of the three may be missing. What
   * it will not do is invent a placeholder for the missing one: "Unknown" in a
   * filename is worse than a shorter filename, and it would come straight back
   * through the parser as a studio called Unknown.
   */
  const stem = [studio, date, title].filter(Boolean).join('.');
  const to = stem + (extname(from) || '.mp4');
  const dir = dirname(from);

  if (join(dir, to) === from) return no('The file is already called that.');

  const taken = await stat(join(dir, to)).catch(() => null);
  if (taken) return no(`There is already a file called ${to} in that folder.`);

  return { can: true, why: '', from, to, dir };
}

/*
 * Do it, then tell Stash.
 *
 * The plan is re-made here rather than trusting the name the browser sends
 * back: the only thing that arrives from outside is a scene id, so there is no
 * path and no filename to have to validate. If something changed between the
 * preview and the press, the second plan refuses and nothing moves.
 */
export async function rename(config, sceneId) {
  const ready = await plan(config, sceneId);
  if (!ready.can) throw new Error(ready.why);

  const to = join(ready.dir, ready.to);
  await renameFile(ready.from, to);

  /*
   * Stash matches a moved file by its fingerprint and updates the path on the
   * scene it already has, rather than importing a second one — so this is a
   * scan of one folder and not a re-import. A scan that will not start leaves
   * a stale path on the record and is worth saying, but the file has already
   * moved by then and it is not a failure of the rename.
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
