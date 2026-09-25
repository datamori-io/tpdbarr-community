/* What a thumb does: swipe between slides, drag along one. */

import { el } from '../util.js';
import { SWIPE_BIAS, SWIPE_MIN } from './config.js';
import { bar, feedTo } from './controls.js';

export function swipeable(session, dial) {
  let x = 0;
  let y = 0;
  let tracking = false;

  const start = (e) => {
    if (e.touches.length !== 1) return;
    x = e.touches[0].clientX;
    y = e.touches[0].clientY;
    tracking = true;
  };

  const end = (e) => {
    if (!tracking) return;
    tracking = false;

    const touch = e.changedTouches?.[0];
    if (!touch) return;

    const dx = touch.clientX - x;
    const dy = touch.clientY - y;

    if (Math.abs(dx) < SWIPE_MIN) return;
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_BIAS) return;

    // Swiping left moves forward, the way pages do everywhere else.
    feedTo(session, dx < 0 ? 1 : -1);
  };

  dial.addEventListener('touchstart', start, { passive: true });
  dial.addEventListener('touchend', end, { passive: true });

  return () => {
    dial.removeEventListener('touchstart', start);
    dial.removeEventListener('touchend', end);
  };
}

/*
 * Drag across the picture to scrub. Horizontal only; claims the gesture
 * from the scroller.
 */
export function scrubbable(slide, video, start, end) {
  const bar = el('div', { className: 'reelscrub' }, el('i', {}));
  const fill = bar.firstElementChild;

  let dragging = false;
  let wasPlaying = false;
  let width = 1;

  const span = () => {
    const from = start || 0;
    const to = end || video.duration || 0;
    return { from, to: to > from ? to : from + 1 };
  };

  const paint = () => {
    const { from, to } = span();
    const at = Math.min(1, Math.max(0, (video.currentTime - from) / (to - from)));
    fill.style.width = (at * 100).toFixed(2) + '%';
  };

  video.addEventListener('timeupdate', () => { if (!dragging) paint(); });

  /*
   * Seeks the video itself (no sprites). fastSeek where available, so a drag
   * feels live.
   */
  const seekTo = (clientX) => {
    const box = slide.getBoundingClientRect();
    const at = Math.min(1, Math.max(0, (clientX - box.left) / (width || box.width)));
    const { from, to } = span();
    const target = from + at * (to - from);

    if (typeof video.fastSeek === 'function') video.fastSeek(target);
    else video.currentTime = target;

    paint();
  };

  slide.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Not on the overlay: those are links and buttons.
    if (e.target.closest('.reelover, .reelcorner')) return;
    dragging = true;
    width = slide.getBoundingClientRect().width;
    /* Paused while the thumb is down, restored after. */
    wasPlaying = !video.paused;
    video.pause();
    slide.classList.add('scrubbing');
    slide.setPointerCapture?.(e.pointerId);
    seekTo(e.clientX);
  });

  slide.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    seekTo(e.clientX);
  });

  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    slide.classList.remove('scrubbing');
    slide.releasePointerCapture?.(e.pointerId);
    if (wasPlaying) video.play().catch(() => {});
  };

  slide.addEventListener('pointerup', stop);
  slide.addEventListener('pointercancel', stop);

  return bar;
}

// -------------------------------------------------------------------- view
