/* The ones you kept, and the debounce that saves them. */

import { api } from '../util.js';

/*
 * ---------------------------------------------------- what was left set
 *
 * The reel's settings, saved on the server (used from several machines).
 * The address wins. Read once before the session is built.
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

/* Saved after a short delay; settings change in bursts. */
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
