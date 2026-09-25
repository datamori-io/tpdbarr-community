/* The reel's live session and teardown. No sibling imports. */

import { FULL, RATIO_DEFAULT } from './config.js';
import { keep } from './keeps.js';

export const view = document.getElementById('view');

/* The reel on screen, or null. app.js calls leave() on navigation. */
export let live = null;

/* Set from show(); imported bindings are read-only. */
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

/* Drop the src, not just pause: a paused video keeps its buffer and connection. */
export function unload(slide) {
  const video = slide.querySelector('video');
  if (!video || !video.getAttribute('src')) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

/*
 * Start playback: play() is retried once data arrives and once the seek
 * lands, if this is still the slide on screen and not paused by hand.
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
 * Seek to the marker and loop its window. Listeners live with the slide,
 * since it reloads when scrolled back into range.
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
  /* Feed is always written: absent means "last used", a third state. */
  if (feed) params.set('feed', feed);
  if (source !== 'markers') params.set('source', source);
  if (tag) params.set('tag', tag);
  if (exclude?.length) params.set('ex', exclude.join(','));
  if (crop && crop !== 'auto') params.set('crop', crop);
  if (ratio && ratio.join(',') !== RATIO_DEFAULT.join(',')) params.set('ratio', ratio.join(','));
  if (roll) params.set('roll', '1');
  if (info === false) params.set('info', '0');
  if (play === 'source') params.set('play', 'source');
  /* Only when Shuffle put it there; other buttons mustn't pin the reel. */
  if (pin && seed) params.set('seed', seed);
  const query = params.toString();
  return '#/binge' + (query ? '?' + query : '');
}

// Changing what the reel is made of means a different reel, so this navigates.
export function go(session) {
  keep(session);
  location.hash = addressFor(session);
}
