/*
 * The one mount files move through.
 *
 * /Import Folder, /organized_scenes and /movies are subfolders of one SMB
 * share, mounted separately at Stash's paths. Separate mounts are separate
 * devices, so rename() between them fails with EXDEV and falls back to a
 * full copy. So the share is also mounted whole at /media4, and moves go
 * through that: one server-side rename.
 *
 * /pc-import is on the Windows host, not the share; leaving it is always a copy.
 */

import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

const SHARE = '/media4';

/*
 * Stash's path -> the same folder on the whole-share mount. Longest first.
 * The share's own folder names can differ (/organized_scenes is `Scenes`).
 */
const FOLDERS = [
  ['/organized_scenes', SHARE + '/Scenes'],
  ['/Import Folder', SHARE + '/Import Folder'],
  ['/movies', SHARE + '/Movie (adult)'],
];

/* -> the same file on the whole-share mount, or null if it's not on the share. */
export function onShare(path) {
  const full = resolvePath(String(path || ''));
  for (const [mount, there] of FOLDERS) {
    if (full === mount) return there;
    if (full.startsWith(mount + '/')) return there + full.slice(mount.length);
  }
  return null;
}

/*
 * Is the whole-share mount there? Checked, since otherwise moves silently
 * fall back to copying. Cached.
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
 * -> { from, to, sameDevice }, both on the one mount where possible.
 * `sameDevice` is true only when both ends are on the share.
 */
export async function route(from, to) {
  const here = onShare(from);
  const there = onShare(to);

  if (here && there && await ready()) return { from: here, to: there, sameDevice: true };
  return { from, to, sameDevice: false };
}
