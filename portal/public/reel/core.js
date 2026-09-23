/*
 * What the reel has on screen, and how it lets go of it.
 *
 * Nothing in here imports from a sibling. The reel holds video elements and
 * timers that outlive a render, so standing down properly is the one thing
 * every other file in this folder depends on being able to call.
 */

import { FULL, RATIO_DEFAULT } from './config.js';
import { keep } from './keeps.js';

export const view = document.getElementById('view');

/*
 * The reel on screen, or null. Its observer and key handler outlive its DOM,
 * so leaving has to be explicit — app.js calls this on the way past, the same
 * way it does for the library.
 */
export let live = null;

/*
 * show() starts a session and show() is not in this file any more. An imported
 * binding is read-only, so the new session is handed over rather than assigned
 * from there. leave() still clears it directly, because leave() lives here.
 */
export const setLive = (session) => { live = session; };

export function leave() {
  document.body.classList.remove(FULL);
  if (!live) return;
  live.dead = true;
  clearTimeout(live.rollTimer);
  live.observer?.disconnect();
  live.unswipe?.();
  document.removeEventListener('keydown', live.keys);
  document.removeEventListener('visibilitychange', live.wake);
  for (const slide of live.slides) unload(slide);
  live = null;
}

// ------------------------------------------------------------------- media

/*
 * Dropping the src rather than only pausing: a paused video still holds its
 * buffer and its connection, and a reel scrolled through for a few minutes
 * would otherwise be holding all of them.
 */
export function unload(slide) {
  const video = slide.querySelector('video');
  if (!video || !video.getAttribute('src')) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

/*
 * Starting playback, which is not simply calling play().
 *
 * A slide is asked to play the moment its src is set, before it has loaded
 * anything, and a marker then seeks a long way into the file — either can
 * leave the element paused with the play promise quietly rejected. So the ask
 * is repeated once there is data and once the seek has landed, and each of
 * those checks that this is still the slide on screen and that nobody has
 * paused it by hand in the meantime.
 */
export function begin(session, index, video) {
  const go = () => {
    if (session.dead || session.current !== index || session.paused) return;
    video.play().catch(() => {});
  };

  go();
  video.addEventListener('canplay', go, { once: true });
  video.addEventListener('seeked', go, { once: true });
}

/*
 * Seeking to the marker and staying there. Both listeners live for as long as
 * the slide does rather than being added when it loads, because a slide that
 * scrolled out of range had its src taken away and will fire loadedmetadata
 * again the next time it comes back.
 */
export function windowed(video, start, end) {
  video.addEventListener('loadedmetadata', () => {
    if (video.currentTime < start || video.currentTime > end) video.currentTime = start;
  });

  video.addEventListener('timeupdate', () => {
    if (video.currentTime >= end || video.currentTime < start - 1) video.currentTime = start;
  });
}

// ------------------------------------------------------------------ slides

export function addressFor({ source, tag, crop, ratio, roll, seed, pin, exclude, info, play, feed }) {
  const params = new URLSearchParams();
  /*
   * Always written, including the default.
   *
   * Every other setting here can be left out when it is the default, because
   * absence and default mean the same thing for them. The feed is different:
   * what a missing feed means is "use whatever was left set last time", which
   * is a third state. Encoding mixed as absence made walking round the feeds
   * stick — right from Reddit produced an address with no feed in it, which the
   * next render read as "remembered", which was Reddit.
   */
  if (feed) params.set('feed', feed);
  if (source !== 'markers') params.set('source', source);
  if (tag) params.set('tag', tag);
  if (exclude?.length) params.set('ex', exclude.join(','));
  if (crop && crop !== 'auto') params.set('crop', crop);
  if (ratio && ratio.join(',') !== RATIO_DEFAULT.join(',')) params.set('ratio', ratio.join(','));
  if (roll) params.set('roll', '1');
  if (info === false) params.set('info', '0');
  if (play === 'source') params.set('play', 'source');
  /*
   * Only when Shuffle put it there. A seed in the address pins the reel across
   * a refresh, which is what Shuffle is for — but the framing and rolling
   * buttons also rewrite the address, and they have no business quietly
   * turning a fresh-every-visit reel into a fixed one.
   */
  if (pin && seed) params.set('seed', seed);
  const query = params.toString();
  return '#/binge' + (query ? '?' + query : '');
}

// Changing what the reel is made of means a different reel, so this navigates.
export function go(session) {
  keep(session);
  location.hash = addressFor(session);
}
