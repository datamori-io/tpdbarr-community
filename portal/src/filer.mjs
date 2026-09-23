/*
 * Filing a scene: the move that "Mark filed" always implied.
 *
 * Marking a scene organized in Stash sets a flag and nothing else. The file
 * stays wherever it landed — in /Import Folder waiting on FileFlows, in
 * /pc-import where it was dropped by hand — and the library on disk drifts
 * further from the library Stash describes. The filing was done in a plugin
 * afterwards, one folder at a time, and it was slow enough to be put off.
 *
 * So the flag does the move. Mark it filed and the file goes to where filed
 * scenes live, under the shape the rest of the library already uses:
 *
 *   /organized_scenes/<Studio>/<YYYY-MM-DD>.<Title>/<Studio>.<date>.<Title>.<ext>
 *
 * which is renamer.mjs's stem twice over — once as the folder and once as the
 * file. Read off the library as it stands on 2026-09-20: 471 studio folders
 * built exactly this way.
 *
 * **Most of it does not cross the network.** /Import Folder, /movies and
 * /organized_scenes are three subfolders of one SMB share on the file server, so
 * the move is a rename the Mac does internally — see share.mjs. /pc-import is
 * the exception: it is a folder on the Windows machine, and a file leaving it
 * is a real transfer whatever anybody does. The answer says which it was and
 * how long it took, because forty seconds and no seconds are different enough
 * to want telling apart.
 *
 * **Nothing is overwritten, ever.** A destination that already exists stops the
 * move; it does not get a "(2)" and it does not win. Two files that think they
 * are the same scene is a thing to look at, not a thing to resolve by guessing.
 */

import { copyFile, mkdir, rename as renameFile, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';

import { gql } from './stash.mjs';
import * as share from './share.mjs';

/*
 * Where filed scenes live. The one destination, not a list and not
 * configurable — this is what /organized_scenes means.
 */
const HOME = '/organized_scenes';

/*
 * Where a file may be moved *from*. Two folders, and the list is short on
 * purpose — everything left out is left out because somebody else owns it.
 *
 * **Not the Whisparr folders.** Those are Whisparr's, it moves files out of
 * them on its own schedule, and a scene taken out from underneath it comes
 * back as an import failure. A scene there gets filed the way it always has,
 * by FileFlows handing it on.
 *
 * **Not /movies**, which is the one that would have done damage. Stash knows
 * about those files, so they answer a query for unfiled scenes and every one
 * of them planned cleanly — but /movies is Emby's library of record, not
 * Stash's, and a film there is a folder with .nfo and artwork sitting beside
 * the video. Moving the video into /organized_scenes would leave Emby holding
 * a folder with everything in it but the film. Checked on 2026-09-20: 51 of
 * them, all unfiled as far as Stash is concerned.
 */
const SOURCES = ['/Import Folder', '/pc-import'];

const inside = (path, root) => {
  const full = resolvePath(String(path || ''));
  return full === root || full.startsWith(root + '/');
};

/*
 * What a filesystem will take. Same rules as renamer.mjs and for the same
 * reason — one end of this is a Windows bind and the other is SMB, and both
 * are stricter than the container is.
 */
const clean = (text) => String(text || '')
  // A colon becomes a hyphen, the way Whisparr writes it — "Title: Part" is
  // "Title- Part" across three thousand folders already, and a space instead
  // made "rename all in organized" want to move hundreds of them for it.
  .replace(/:/g, '-')
  .replace(/[\\/*?"<>|]/g, ' ')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/^[.\s]+|[.\s]+$/g, '')
  .trim();

/*
 * Trim a name to what a filesystem will hold in one path component.
 *
 * 255 *bytes* is the limit on every filesystem in this stack, and it is bytes
 * rather than characters — a JAV title full of multi-byte punctuation runs out
 * sooner than its length suggests. 180 leaves room for the studio and the date
 * that get prefixed to it in the filename, which is the longer of the two
 * components built here.
 *
 * Cut on a word where there is one nearby, because a name chopped mid-word
 * reads like a corrupted one. No ellipsis added: several of these titles end
 * in a real "..." already and a second one would be a lie about where the cut
 * happened.
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
 * -> { dir, to } where a scene belongs in /organized_scenes, or { why } when
 * it has not got the three things the path is built out of.
 *
 * Exported because the Manage page's "rename all in organized" re-shelves
 * scenes that are already filed, against the same shape — two copies of this
 * would be two shapes by the end of the year.
 */
export function shelfFor(scene, from) {
  const title = clean(scene.title);
  if (!title) return { why: 'No title, and the folder is named out of one — so there is nothing to file it as yet.' };

  const studio = clean(scene.studio?.name);
  if (!studio) return { why: 'No studio, and filed scenes are grouped by studio — so there is nowhere to put it yet.' };

  const date = /^\d{4}-\d{2}-\d{2}$/.test(scene.date || '') ? scene.date : '';
  if (!date) return { why: 'No date, and both the folder and the filename start with one.' };

  /*
   * The shape, twice: `<date>.<Title>` names the folder and
   * `<Studio>.<date>.<Title>` names the file inside it. That is not a
   * redundancy to tidy up — a scene folder carries artwork and sidecars
   * beside the video, and the studio in the filename is what lets one of
   * those files be identified on its own, away from its folder.
   */
  const stem = `${date}.${fit(title)}`;
  const dir = join(HOME, fit(studio, 120), stem);
  const to = join(dir, `${fit(studio, 120)}.${stem}${extname(from) || '.mp4'}`);
  return { dir, to };
}

/*
 * -> { can, why, from, to, dir, sameDevice, already }
 *
 * Never writes. `already` is the ordinary case rather than a failure: a scene
 * filed from the library page is usually one that is already in
 * /organized_scenes, and there is nothing to do but set the flag.
 *
 * A scene that cannot be filed does not block the flag either. Marking
 * something organized is a statement about the scene, and refusing it because
 * the title has a colon in it would be the tail wagging the dog — `can` is
 * false, `why` says so, and the caller sets the flag anyway and reports it.
 */
export async function plan(config, sceneId) {
  const scene = await read(config, sceneId);
  const from = scene.files?.[0]?.path || null;

  const no = (why, extra = {}) => ({ can: false, why, from, to: null, dir: null, sameDevice: false, already: false, ...extra });

  if (!from) return no('Stash has no file for that scene.');
  if (inside(from, HOME)) return no('Already filed — the file is in ' + HOME + '.', { already: true });

  const source = SOURCES.find((root) => inside(from, root));
  if (!source) {
    return no('That file is in a folder the portal does not file out of. '
      + SOURCES.join(', ') + ' are the ones it will move from.');
  }

  const shelf = shelfFor(scene, from);
  if (shelf.why) return no(shelf.why);
  const { dir, to } = shelf;

  const taken = await stat(to).catch(() => null);
  if (taken) return no(`There is already a file at ${to}.`);

  const { sameDevice } = await share.route(from, to);

  return { can: true, why: '', from, to, dir, sameDevice, already: false };
}

/*
 * Do it, then tell Stash where it went.
 *
 * The plan is made again here rather than trusting anything the browser sends
 * back — a scene id is the only thing that arrives from outside, so there is
 * no path to have to validate. If something moved between the preview and the
 * press, the second plan refuses and nothing happens.
 */
export async function file(config, sceneId, { beforeMove = null } = {}) {
  const ready = await plan(config, sceneId);
  if (!ready.can) throw new Error(ready.why);

  /*
   * Both ends on the one mount where that is possible, so the move is a
   * rename the Mac does to itself. Where it is not — anything out of
   * /pc-import — these come back as the paths they already were and the copy
   * below is the only way across.
   */
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
     * EXDEV is the two-computers case and the expected one out of /pc-import.
     * Copy, verify the size, and only then delete the original — a move that
     * loses the file when the network drops halfway is worse than no move.
     * Anything else is a real error and is not swallowed.
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
   * Stash matches a moved file by its fingerprint and updates the path on the
   * scene it already has rather than importing a second one, so this is a scan
   * of the one new folder. Both folders are scanned: the old one so the record
   * stops pointing at a file that is not there, the new one so it points at
   * the one that is.
   *
   * A scan that will not start is worth saying and is not a failure of the
   * move — the file has already arrived by then.
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
