/*
 * The one mount a file is moved through.
 *
 * Three of the folders this portal can see — /Import Folder, /organized_scenes
 * and /movies — are three subfolders of a single SMB share on the file server,
 * `//fileserver/media`. Docker mounts them separately, at the paths Stash
 * reports, which is right for reading: a path that comes out of Stash resolves
 * here without anybody having to translate it.
 *
 * It is wrong for moving. Three mounts are three devices as far as the kernel
 * is concerned, so `rename()` between them fails with EXDEV and Node's fallback
 * is to read the whole file and write it back — four gigabytes down off the
 * share and four gigabytes back up, to move a file that never needed to leave
 * the Mac. Measured on 2026-09-20: st_dev 90 for /organized_scenes and 101 for
 * /movies, rename between them EXDEV.
 *
 * So the share is *also* mounted whole, at /media4, and anything about to move
 * a file asks here for the same path on that mount. Then it is one rename
 * inside one mount, which SMB does server-side with nothing on the wire.
 *
 * **pc-import is not on it, and cannot be.** That mount is a local folder
 * on the machine this container runs on — a different computer from the
 * one holding the share. A file leaving it has to cross the network however it
 * is moved, and `moved()` says so rather than pretending otherwise.
 */

import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

const SHARE = '/media4';

/*
 * Stash's path for a folder, and the same folder on the whole-share mount.
 *
 * Longest first, so a lookup cannot match a shorter prefix of a longer name.
 * The keys are what Stash reports and the compose file mounts; the values are
 * the folder names on the share itself, which are not always the same word —
 * /organized_scenes is `Scenes` on the Mac.
 */
const FOLDERS = [
  ['/organized_scenes', SHARE + '/Scenes'],
  ['/Import Folder', SHARE + '/Import Folder'],
  ['/movies', SHARE + '/Movie (adult)'],
];

/*
 * -> the same file on the one mount, or null if it is not on the share.
 *
 * Null is a real answer and the caller has to handle it: /pc-import and both
 * Whisparr folders are genuinely elsewhere, and a move out of one of them is a
 * copy across the network whatever this returns.
 */
export function onShare(path) {
  const full = resolvePath(String(path || ''));
  for (const [mount, there] of FOLDERS) {
    if (full === mount) return there;
    if (full.startsWith(mount + '/')) return there + full.slice(mount.length);
  }
  return null;
}

/*
 * Is the whole-share mount actually there?
 *
 * Asked rather than assumed, because the compose file can be out of date with
 * the container that is running and the failure is otherwise silent — the move
 * would quietly fall back to copying and nobody would know why filing got slow
 * again. Cached: the answer cannot change without a restart.
 */
let mounted = null;

export async function ready() {
  if (mounted !== null) return mounted;
  mounted = await stat(SHARE).then((s) => s.isDirectory()).catch(() => false);
  if (!mounted) {
    console.warn('[tpdbarr] ' + SHARE + ' is not mounted — moves between share folders will copy rather than rename.');
  }
  return mounted;
}

/*
 * -> { from, to, sameDevice } for a move, with both paths put on the one mount
 * where that is possible.
 *
 * `sameDevice` is the honest answer to "is this going to take a moment or take
 * a minute", and it is what the page says before you press. Both ends have to
 * be on the share for it to be true: a file coming from /pc-import crosses the
 * network no matter which path is used for the destination.
 */
export async function route(from, to) {
  const here = onShare(from);
  const there = onShare(to);

  if (here && there && await ready()) return { from: here, to: there, sameDevice: true };
  return { from, to, sameDevice: false };
}
