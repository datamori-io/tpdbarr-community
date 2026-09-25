/* A slide, and the page of them a feed comes back as. */

import { api, clock, el } from '../util.js';
import { NEAR, RUNWAY } from './config.js';
import { advance, armRoll } from './controls.js';
import { begin, live, unload, windowed } from './core.js';
import { scrubbable } from './gestures.js';
import { loadInto, mediaFor } from './media.js';

function slideFor(item) {
  if (item.kind === 'reddit' || item.kind === 'redgifs') return socialSlide(item);

  const { src, then, instead, poster, start, end } = mediaFor(item);

  /*
   * Fallback order: our clip, Stash's, then the scene file (the only one
   * that's a window into a longer file).
   */
  const chain = [then, instead].filter(Boolean);
  const scene = item.scene;
  const href = `#/library/scene/${item.sceneId}`;

  const video = el('video', {
    className: 'reelvid',
    poster,
    /* Clips and previews loop themselves; only a seek into the full file needs windowed(). */
    loop: true,
    muted: true,
    playsInline: true,
    preload: 'none',
  });

  /* A slide already on the file windows now; one trying a clip only if that fails. */
  /*
   * Noted here, set on the slide later: `slide` is declared below, and
   * touching it here is a temporal-dead-zone error.
   */
  const windowing = Boolean(end && !chain.length);

  if (windowing) {
    video.loop = false;
    windowed(video, start, end);
  }

  if (chain.length) {
    let step = 0;

    video.addEventListener('error', () => {
      /* Emptying src fires an error too; only a failure of the current source counts. */
      const now = video.getAttribute('src');
      const asked = step === 0 ? src : chain[step - 1];
      if (!now || now !== asked || step >= chain.length) return;

      const next = chain[step];
      step += 1;
      if (live) live.clipless = (live.clipless || 0) + 1;

      /* The seek and manual loop start only on the scene-file fallback. */
      if (next === instead) {
        video.loop = false;
        windowed(video, start, end);
        slide.dataset.end = String(end);
      }

      slide.dataset.src = next;
      video.src = next;
      video.load();

      // Only carry on playing if this is still the slide being looked at.
      if (live && live.slides[live.current] === slide && !live.paused) {
        begin(live, live.current, video);
      }
    });
  }

  const sub = [
    scene.studio?.name,
    scene.date,
    scene.resolution,
    // A marker is a moment inside the scene, so where it sits is worth more
    // than how long the whole thing runs.
    item.kind === 'marker' ? `at ${clock(item.seconds)}` : clock(scene.duration),
  ].filter(Boolean);

  const cast = (scene.performers || []).slice(0, 4).map((p) =>
    el('a', { className: 'chip person', href: `#/library/performer/${p.id}` }, p.name)
  );

  const o = el('button', { className: 'reelcorner slot3 left', type: 'button', title: 'Add an O' },
    el('span', { className: 'reelactmark' }, 'O'),
    el('b', {}, String(scene.oCount || 0))
  );


  o.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    o.disabled = true;
    try {
      const { oCount } = await api(`/api/library/scenes/${item.sceneId}/o`, { method: 'POST', body: '{}' });
      o.querySelector('b').textContent = String(oCount);
      scene.oCount = oCount;
    } catch {
      // A reel is not the place for an error panel; the count simply does not move.
    }
    o.disabled = false;
  };

  const slide = el('article', { className: 'reelslide wide' },
    el('div', { className: 'reelframe' }, video),
    el('div', { className: 'reelover' },
      el('div', { className: 'reelmeta' },
        el('a', { className: 'reeltitle', href }, scene.title),
        el('div', { className: 'reelsub' }, sub.join(' · ')),
        cast.length ? el('div', { className: 'reelcast' }, cast) : null
      ),
      /* The tag sits in the gap in the button row. */
      item.tag ? el('div', { className: 'reeltagline' }, el('span', { className: 'reeltag' }, item.tag)) : null,
      o,
      el('a', { className: 'reelcorner slot3 right', href, title: 'Open the scene' },
        el('span', { className: 'reelactmark' }, '▶')
      )
    )
  );

  slide.dataset.src = src;
  /*
   * Set only once the slide has fallen back to the scene file; armRoll()
   * reads it. Set earlier, it turned off looping on real clips.
   */

  // What armRoll() reads to know this is a window into something longer.
  if (windowing) slide.dataset.end = String(end);

  slide.append(scrubbable(slide, video, start, end));

  /* Advance after one play when rolling. Windowed markers never fire `ended`. */
  video.addEventListener('ended', () => { if (slide.dataset.roll) advance(live); });

  if (end) {
    video.addEventListener('timeupdate', () => {
      if (slide.dataset.roll && video.currentTime >= end) advance(live);
    });
  }

  /* Clicking the picture pauses. */
  video.onclick = () => {
    if (video.paused) {
      if (live) live.paused = false;
      video.play().catch(() => {});
    } else {
      if (live) live.paused = true;
      video.pause();
    }
  };

  return slide;
}

/*
 * A RedGIFs or Reddit slide, in the library slide's shape. A Reddit post
 * may be a picture.
 */
function socialSlide(item) {
  const { src, poster } = mediaFor(item);

  const picture = src
    ? el('video', { className: 'reelvid', poster, loop: true, muted: true, playsInline: true, preload: 'none' })
    : el('img', { className: 'reelvid reelstill', src: poster, loading: 'lazy', alt: '' });

  const when = item.at ? new Date(item.at).toISOString().slice(0, 10) : null;

  const site = item.kind === 'redgifs' ? 'RedGIFs' : 'Reddit';

  /* Phone-shaped, unless a RedGIFs clip says it's landscape. */
  const shape = item.kind === 'redgifs' && item.tall === false ? 'wide' : 'tall';

  const slide = el('article', { className: 'reelslide feed ' + shape },
    el('div', { className: 'reelframe' }, picture),
    el('div', { className: 'reelover' },
        el('div', { className: 'reelmeta' },
          el('a', {
            className: 'reeltitle',
            href: item.permalink,
            target: '_blank',
            rel: 'noreferrer noopener',
          }, item.title || item.tag),
          el('div', { className: 'reelsub' },
            [
              item.gallery ? 'Gallery' : null,
              item.kind === 'redgifs' && item.seconds ? `${item.seconds}s` : null,
              item.kind === 'redgifs' && item.sound === false ? 'silent' : null,
              (item.tags || []).slice(0, 3).join(', ') || null,
              when,
            ].filter(Boolean).join(' · ')),
          item.performerId
            ? el('div', { className: 'reelcast' },
                el('a', { className: 'chip person', href: `#/library/performer/${item.performerId}` }, item.performerName))
            : null
        ),
      el('div', { className: 'reeltagline' }, el('span', { className: 'reeltag reelfrom' }, item.tag)),
      el('a', {
        className: 'reelcorner slot3 right',
        href: item.permalink,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: 'Open it on ' + site,
      },
        el('span', { className: 'reelactmark' }, '↗')
      )
    )
  );

  if (src) {
    slide.dataset.src = src;
    slide.append(scrubbable(slide, picture, 0, 0));
    picture.addEventListener('ended', () => { if (slide.dataset.roll) advance(live); });

    picture.onclick = () => {
      if (picture.paused) {
        if (live) live.paused = false;
        picture.play().catch(() => {});
      } else {
        if (live) live.paused = true;
        picture.pause();
      }
    };
  }

  return slide;
}

// ------------------------------------------------------------------ loading

export async function loadPage(session) {
  if (session.loading || session.done) return 0;
  session.loading = true;

  const params = new URLSearchParams({
    source: session.source,
    seed: session.seed,
    page: String(session.page + 1),
    feed: session.feed,
  });
  if (session.tag) params.set('tag', session.tag);
  if (session.exclude.length) params.set('ex', session.exclude.join(','));
  if (session.play === 'source') params.set('play', 'source');
  params.set('ratio', session.ratio.join(','));

  try {
    const data = await api('/api/library/reel?' + params);
    if (session.dead) return 0;

    session.page = data.page;
    session.count = data.count;

    /* Progress counted on library items only. */
    session.pulled += data.items.filter((item) => item.kind === 'marker' || item.kind === 'scene').length;
    if (!data.items.length || session.pulled >= data.count) session.done = true;

    for (const item of data.items) {
      session.items.push(item);
      const slide = slideFor(item);
      session.slides.push(slide);
      session.track.append(slide);
      /* Observe only once mounted: before layout every slide looks fully visible. */
      if (session.mounted) session.observer.observe(slide);
    }

    return data.items.length;
  } finally {
    session.loading = false;
  }
}

/* One slide plays; neighbours are loaded and paused; the rest release their buffers. */
export function activate(session, index) {
  if (index === session.current) return;
  session.current = index;
  // Pausing is about the clip you paused, not the reel.
  session.paused = false;

  session.slides.forEach((slide, i) => {
    const distance = Math.abs(i - index);

    if (distance > NEAR) {
      unload(slide);
      return;
    }

    const video = loadInto(slide, session.muted);
    if (!video) return;

    if (i === index) begin(session, index, video);
    else video.pause();
  });

  armRoll(session, session.slides[index]);
  session.measure?.();

  if (!session.done && index >= session.slides.length - RUNWAY) loadPage(session);
}
