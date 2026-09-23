/* The ones you kept, and the debounce that saves them. */

import { api } from '../util.js';

/* ---------------------------------------------------- what was left set
 *
 * The reel's settings are a sitting rather than a place: the framing, whether
 * it rolls, the mix, which feed. Setting them again on every visit is the kind
 * of small friction that makes a page feel like it is not listening.
 *
 * Kept on the server rather than in the browser, for the same reason the tile
 * sizes are — this portal gets used from more than one machine, and "how I like
 * the reel" does not change between them.
 *
 * **The address still wins.** A link with settings in it is somebody being
 * specific, and what was left last time must not overwrite it. So this is only
 * ever consulted where the address said nothing.
 *
 * Read once into a plain object before the session is built, because building a
 * session cannot wait on a request — the reel has to appear.
 */
let kept = {};

export async function loadKept() {
  try {
    const { reel } = await api('/api/library/reel/settings');
    kept = reel && typeof reel === 'object' ? reel : {};
  } catch {
    kept = {};
  }
  return kept;
}

export const remembered = (key, fallback) => (key in kept ? kept[key] : fallback);

/*
 * Saved on a delay, because these change in flurries — cycling the framing
 * button is three writes in two seconds, and each one is a config write that
 * the backup then considers itself invited to think about.
 */
let keepTimer = null;

export function keep(session) {
  const settings = {
    feed: session.feed,
    crop: session.crop,
    ratio: session.ratio,
    roll: session.roll,
    info: session.info,
    play: session.play,
    source: session.source,
  };

  kept = { ...kept, ...settings };

  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => {
    api('/api/library/reel/settings', { method: 'POST', body: JSON.stringify(settings) })
      .catch(() => { /* a setting that did not save is not worth interrupting a reel for */ });
  }, 1200);
}
