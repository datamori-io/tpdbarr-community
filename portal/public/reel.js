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

  /*
   * What was left set last time, fetched before the session is built so that
   * every default below can consult it. The address still wins wherever it
   * says anything — see remembered().
   */
  await loadKept();

  const params = new URLSearchParams(query);
  const session = {
    /*
     * Kept because older links carry it and the request still sends it, but it
     * is no longer something you set: the feed decides. See SOURCE_OF.
     */
    source: params.get('source') === 'scenes' ? 'scenes' : 'markers',
    tag: params.get('tag') || null,
    // Tags kept out of the reel. A list, unlike the include picker, because
    // there is usually one thing you want and several you never do.
    exclude: (params.get('ex') || '').split(',').filter(Boolean),
    /*
     * How every slide is framed. `auto` lets each take the shape of what it
     * holds — the band for a 16:9 scene, the phone for a portrait clip. The
     * other two impose one shape on everything, and the button cycles the
     * three round without ever leaving the clip you are watching.
     */
    crop: CROPS.includes(params.get('crop')) ? params.get('crop') : remembered('crop', 'auto'),

    // Advance by itself when a clip has been round once, or a still has been
    // up long enough to look at.
    roll: params.has('roll') ? params.get('roll') === '1' : remembered('roll', false),

    // Whether the captions are shown. Off gives the picture their room back.
    info: params.has('info') ? params.get('info') !== '0' : remembered('info', true),

    /*
     * What a marker plays. The rendered clip is small and instant — 640x360,
     * a megabyte, no seeking — and the source is the scene itself at full
     * resolution, seeked to the moment, which costs a range request into a
     * file of a couple of gigabytes.
     */
    play: params.has('play') ? (params.get('play') === 'source' ? 'source' : 'clip') : remembered('play', 'clip'),
    /*
     * What the reel is made of, as percentages — library, RedGIFs, Reddit.
     * Both off-library sources ride along by default now: RedGIFs is all
     * video, and Reddit brings the performers you already follow.
     */
    ratio: params.has('ratio') ? readRatio(params.get('ratio')) : readRatio((remembered('ratio', RATIO_DEFAULT) || []).join(',')),

    /*
     * Which feed. Swiping sideways moves between them, and the ratio only
     * means anything on the mixed one — the other three are a single source.
     */
    /*
     * Markers by default, not the mix. The reel is a library thing first — the
     * two off-library feeds are for when you want them, and starting on a mix
     * of everything meant the page opened on somebody else's clip as often as
     * your own.
     */
    feed: FEEDS.includes(params.get('feed')) ? params.get('feed') : remembered('feed', 'library'),
    // A fresh shuffle each visit, so the reel is not the same one twice —
    // unless the address carries one, which is what Shuffle writes.
    seed: (params.get('seed') || '').replace(/\D/g, '').slice(0, 9) || String(Math.floor(Math.random() * 1e9)),

    /*
     * Whether the seed stays in the address. It does if it was there when you
     * arrived — Shuffle put it there, or you kept the link — and the buttons
     * that rewrite the address in place must not quietly drop it, or a refresh
     * after hiding the captions deals you a different reel.
     */
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

  /*
   * Shape is a class on the track rather than on every slide, so a slide built
   * an hour ago follows a choice made a moment ago. Without it each slide takes
   * the shape of what it holds — the band for the library, the phone for
   * Reddit — which is the default and usually right.
   */
  session.track = el('div', { className: 'reel crop-' + session.crop + (session.info ? '' : ' noinfo') });

  /*
   * The slide that owns the screen is the one most of the screen is showing.
   * A single threshold is enough with snap scrolling — two slides are only
   * both past 0.6 in the moment between snaps, and the last one to cross wins,
   * which is the one being scrolled towards.
   */
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

    /*
     * Left and right change feed, the same as a sideways swipe. A keyboard has
     * no gesture, and reaching for the mouse to move between four feeds is the
     * thing the swipe exists to avoid.
     */
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

  /*
   * The browser pauses video in a hidden tab and does not start it again when
   * you come back, which for a reel reads as it having died while you were
   * away. Unless you paused it yourself, in which case it stays paused.
   */
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

  /*
   * The band below the bar is measured, not guessed: the bar wraps to two rows
   * on a narrow screen and the picture has to start under it either way.
   */
  const measureBar = () => {
    const height = Math.round(strip.getBoundingClientRect().height);
    if (height) session.track.style.setProperty('--reel-bar', height + 'px');

    /*
     * And the caption, for the same reason: in the band the picture stops
     * above it, and how tall it is depends on whether there is a cast row and
     * how far the title wraps. Taken from the slide on screen.
     */
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
