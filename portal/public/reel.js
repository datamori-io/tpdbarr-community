import { api, el, fitFills } from './util.js';
import { CROPS, FEEDS, FULL, RATIO_DEFAULT, readRatio } from './reel/config.js';
import { bar, corners, feedTo } from './reel/controls.js';
import { leave, setLive, view } from './reel/core.js';
import { swipeable } from './reel/gestures.js';
import { loadKept, remembered } from './reel/keeps.js';
import { activate, loadPage } from './reel/slides.js';

export { leave } from './reel/core.js';

export async function show(query = '') {
  leave();

  /* Load the saved settings first; the address still wins (see remembered()). */
  await loadKept();

  const params = new URLSearchParams(query);
  const session = {
    /* Still read for older links; the feed decides now (see SOURCE_OF). */
    source: params.get('source') === 'scenes' ? 'scenes' : 'markers',
    tag: params.get('tag') || null,
    // Tags kept out of the reel. A list, unlike the include picker, because
    // there is usually one thing you want and several you never do.
    exclude: (params.get('ex') || '').split(',').filter(Boolean),
    /* Framing: `auto` fits each slide to its own shape; the button cycles. */
    crop: CROPS.includes(params.get('crop')) ? params.get('crop') : remembered('crop', 'auto'),

    // Advance by itself when a clip has been round once, or a still has been
    // up long enough to look at.
    roll: params.has('roll') ? params.get('roll') === '1' : remembered('roll', false),

    // Whether the captions are shown. Off gives the picture their room back.
    info: params.has('info') ? params.get('info') !== '0' : remembered('info', true),

    /* What a marker plays: the small rendered clip, or the source seeked to the moment. */
    play: params.has('play') ? (params.get('play') === 'source' ? 'source' : 'clip') : remembered('play', 'clip'),
    /* The mix as percentages: library, RedGIFs, Reddit. */
    ratio: params.has('ratio') ? readRatio(params.get('ratio')) : readRatio((remembered('ratio', RATIO_DEFAULT) || []).join(',')),

    /* Which feed. The ratio only applies to mixed. */
    /* Markers by default. */
    feed: FEEDS.includes(params.get('feed')) ? params.get('feed') : remembered('feed', 'library'),
    // A fresh shuffle each visit, so the reel is not the same one twice —
    // unless the address carries one, which is what Shuffle writes.
    seed: (params.get('seed') || '').replace(/\D/g, '').slice(0, 9) || String(Math.floor(Math.random() * 1e9)),

    /* Keep the seed in the address if it arrived with one. */
    pin: Boolean(params.get('seed')),
    page: 0,
    count: 0,
    pulled: 0,
    items: [],
    slides: [],
    current: -1,
    muted: true,
    // Markers that asked Stash for a clip and did not get one.
    clipless: 0,
    rollTimer: null,
    measure: null,
    // Set when the clip on screen was paused by hand, so that a late canplay
    // or seeked does not start it again.
    paused: false,
    loading: false,
    done: false,
    dead: false,
    observer: null,
    keys: null,
    wake: null,
    track: null,
    mounted: false,
    // Removes the sideways-swipe listeners. Set once the track is on the page.
    unswipe: null,
  };
  setLive(session);

  view.replaceChildren(el('div', { className: 'empty' }, 'Loading the reel…'));

  /* Framing is a class on the track, so existing slides follow it. */
  session.track = el('div', { className: 'reel crop-' + session.crop + (session.info ? '' : ' noinfo') });

  /* The active slide is the one past 0.6 visible; with snapping, the last to cross wins. */
  session.observer = new IntersectionObserver(
    (entries) => {
      if (session.dead) return;

      // The most visible slide in the batch, not the last one to be listed.
      let best = null;
      for (const entry of entries) {
        if (entry.intersectionRatio < 0.6) continue;
        if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
      }

      if (best) activate(session, session.slides.indexOf(best.target));
    },
    { root: session.track, threshold: [0.6] }
  );

  let tags = [];
  try {
    // The tag list is only worth having for markers, and a reel with none is
    // not worth waiting on it either way.
    const [, tagList] = await Promise.all([
      loadPage(session),
      session.source === 'markers' ? api('/api/library/reel/tags').catch(() => ({ tags: [] })) : { tags: [] },
    ]);
    tags = tagList.tags || [];
  } catch (err) {
    if (session.dead) return;
    view.replaceChildren(el('div', { className: 'empty' }, err.message));
    return;
  }

  if (session.dead) return;

  if (!session.items.length) {
    view.replaceChildren(el('div', { className: 'empty' },
      session.source === 'markers'
        ? 'Stash has no markers to make a reel from. Try Scenes instead.'
        : 'Stash has no scenes to make a reel from.'));
    return;
  }

  session.keys = (e) => {
    if (session.dead || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    /* Left/right keys change feed. */
    const sideways = e.key === 'ArrowRight' || e.key === 'l' ? 1 : e.key === 'ArrowLeft' || e.key === 'h' ? -1 : 0;
    if (sideways) {
      e.preventDefault();
      feedTo(session, sideways);
      return;
    }

    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
    if (step) {
      e.preventDefault();
      const next = session.slides[session.current + step];
      if (next) next.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      const video = session.slides[session.current]?.querySelector('video');
      if (!video) return;
      session.paused = !video.paused;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }
  };

  document.addEventListener('keydown', session.keys);

  /* Resume playback when the tab comes back, unless you paused. */
  session.wake = () => {
    if (session.dead || document.hidden || session.paused) return;
    const video = session.slides[session.current]?.querySelector('video');
    if (video) video.play().catch(() => {});
  };

  document.addEventListener('visibilitychange', session.wake);

  const strip = bar(session, tags);
  document.body.classList.add(FULL);

  view.replaceChildren(el('div', { className: 'reelwrap fillview' },
    strip, session.track, ...corners(session)));

  // Sideways on the dial moves between feeds — not sideways anywhere else, so
  // a drag across the clip is only ever a scrub. Torn down with the rest.
  session.unswipe = swipeable(session, strip.querySelector('.reelfeeds'));
  fitFills();

  /* Measure the bar's height (it wraps on narrow screens). */
  const measureBar = () => {
    const height = Math.round(strip.getBoundingClientRect().height);
    if (height) session.track.style.setProperty('--reel-bar', height + 'px');

    /* And the caption's, from the slide on screen. */
    if (!session.info) {
      session.track.style.removeProperty('--reel-cap');
      return;
    }

    const over = session.slides[Math.max(0, session.current)]?.querySelector('.reelover');
    const cap = over && Math.round(over.getBoundingClientRect().height);
    if (cap) session.track.style.setProperty('--reel-cap', cap + 'px');
  };

  session.measure = measureBar;
  measureBar();
  new ResizeObserver(measureBar).observe(strip);

  // Now there is something to measure against.
  session.mounted = true;
  for (const slide of session.slides) session.observer.observe(slide);

  // Nothing has crossed the observer's threshold yet, so the first one is
  // started by hand.
  activate(session, 0);
}
