/* The bar, the corners, the feed strip and the settings sheet. */

import { el } from '../util.js';
import { CROPS, CROP_LABEL, FEEDS, FEED_LABEL, RATIO_MAX_AWAY, SOURCE_OF, STILL_MS, icon } from './config.js';
import { addressFor, go } from './core.js';
import { keep } from './keeps.js';
import { clipStatus } from './media.js';

function openSettings(session) {
  const [, startGif, startRed] = session.ratio;

  const box = el('dialog', { className: 'reelsettings' });

  const library = el('b', {}, '');
  const gifOut = el('b', {}, '');
  const redOut = el('b', {}, '');

  const gif = el('input', { type: 'range', min: '0', max: String(RATIO_MAX_AWAY), step: '5', value: String(startGif) });
  const red = el('input', { type: 'range', min: '0', max: String(RATIO_MAX_AWAY), step: '5', value: String(startRed) });

  const show = () => {
    let g = Number(gif.value);
    let r = Number(red.value);

    // The two of them together may not eat more than the cap.
    if (g + r > RATIO_MAX_AWAY) {
      r = RATIO_MAX_AWAY - g;
      red.value = String(Math.max(0, r));
    }

    library.textContent = `${100 - g - r}%`;
    gifOut.textContent = `${g}%`;
    redOut.textContent = `${r}%`;
  };

  gif.oninput = show;
  red.oninput = show;
  show();

  const row = (glyph, label, href, control, out) =>
    el('div', { className: 'reelset' },
      el('a', { className: 'reelseticon', href, title: `Manage ${label}` }, icon(glyph)),
      el('div', { className: 'reelsetname' },
        el('a', { href }, label),
        el('span', { className: 'muted' }, ' — manage')
      ),
      control,
      out
    );

  const apply = el('button', { className: 'reelmute', type: 'button' }, 'Apply');
  apply.onclick = () => {
    const g = Number(gif.value);
    const r = Number(red.value);
    box.close();
    box.remove();
    go({ ...session, ratio: [100 - g - r, g, r], play: fromSource.checked ? 'source' : 'clip' });
  };

  const shut = el('button', { className: 'reelmute', type: 'button' }, 'Close');
  shut.onclick = () => { box.close(); box.remove(); };

  /*
   * What a marker plays: the rendered clip (instant, lower resolution) or the
   * source file seeked to the moment (better, heavier).
   */
  const fromSource = el('input', { type: 'checkbox', checked: session.play === 'source' });

  const playRow = el('label', { className: 'reelset reelsetplay' },
    el('div', { className: 'reelseticon' }, ''),
    el('div', { className: 'reelsetname' },
      'Play markers from source',
      el('span', { className: 'muted' }, ' — full resolution, slower to start')
    ),
    el('div', {}, ''),
    fromSource
  );

  box.append(
    el('h2', {}, 'Reel settings'),
    el('p', { className: 'muted' }, 'How much of the reel comes from where. The library takes whatever the other two leave.'),

    el('div', { className: 'reelset reelsetlib' },
      el('div', { className: 'reelseticon' }, ''),
      el('div', { className: 'reelsetname' }, 'Your library'),
      el('div', {}, ''),
      library
    ),

    row('redgifs', 'RedGIFs', '#/binge/redgifs', gif, gifOut),
    row('reddit', 'Reddit', '#/binge/reddit', red, redOut),

    playRow,
    clipStatus(box),

    el('menu', {}, apply, shut)
  );

  document.body.append(box);
  box.addEventListener('close', () => box.remove());
  box.showModal();
}

// --------------------------------------------------------------------- bar

export function bar(session, tags) {
  const gear = el('button', { className: 'reelicon', type: 'button', title: 'Settings' }, icon('gear'));
  gear.onclick = () => openSettings(session);

  /*
   * One tag control, two groups: "only this tag" replaces; "keep out"
   * accumulates as removable chips.
   */
  const picker = el('select', { className: 'reelpick tags', title: 'Only one tag, or keep tags out' },
    /* Blank, so the closed control shows the icon. */
    el('option', { value: '' }, ''),
    el('optgroup', { label: 'Only' },
      tags.map((t) => el('option', { value: 'only:' + t.id }, t.name))),
    el('optgroup', { label: 'Without' },
      tags.filter((t) => !session.exclude.includes(t.id)).map((t) => el('option', { value: 'not:' + t.id }, t.name)))
  );

  // Whatever is picked, the control goes back to saying what it is for — the
  // include is shown by the reel itself and the excludes by their chips.
  picker.value = '';

  // Only a marker reel has marker tags. Scenes and the two feeds have none.
  picker.disabled = session.source !== 'markers' || !tags.length;

  const tagged = el('span', { className: 'reeltags' }, icon('tag'), picker);

  picker.onchange = () => {
    const [what, id] = picker.value.split(':');
    picker.value = '';

    if (!id) return go({ ...session, tag: null });
    if (what === 'only') return go({ ...session, tag: id });
    if (!session.exclude.includes(id)) go({ ...session, exclude: [...session.exclude, id] });
  };

  const byId = new Map(tags.map((t) => [t.id, t.name]));

  const excluded = session.exclude.map((id) => {
    const chip = el('span', { className: 'reelex', title: 'Excluded from the reel' }, byId.get(id) || id);
    const off = el('button', { className: 'redditdrop', type: 'button', title: 'Put it back' }, '×');
    off.onclick = () => go({ ...session, exclude: session.exclude.filter((other) => other !== id) });
    chip.append(off);
    return chip;
  });

  /* A chip for the tag the reel is narrowed to; removing it widens again. */
  const only = session.tag
    ? [(() => {
      const chip = el('span', { className: 'reelex only', title: 'The reel is only this tag' },
        byId.get(session.tag) || session.tag);
      const off = el('button', { className: 'redditdrop', type: 'button', title: 'Every tag again' }, '×');
      off.onclick = () => go({ ...session, tag: null });
      chip.append(off);
      return chip;
    })()]
    : [];

  /*
   * Three zones on one row: tags left, feed window centred on the screen,
   * the rest right. A grid, so tag chips don't shift the centre.
   */
  return el('div', { className: 'reelbar' },
    el('div', { className: 'reelleft' }, tagged, only, excluded),
    feedStrip(session),
    el('div', { className: 'reelright' },
      /* The gear: off-library sources and the mix. */
      gear,
      closer()
    )
  );
}

/*
 * ------------------------------------------------------------ the feeds
 *
 * Switched on the dial only (a whole-screen swipe fought with scrubbing).
 * Changing feed rebuilds the reel, with a fresh seed.
 */
export function feedTo(session, step) {
  const at = FEEDS.indexOf(session.feed);
  const next = FEEDS[(at + step + FEEDS.length) % FEEDS.length];
  if (next === session.feed) return;

  switchTo(session, next);
}

/* Move to a feed; its source comes with it. The seed resets. */
function switchTo(session, next) {
  const moved = {
    ...session,
    feed: next,
    source: SOURCE_OF[next] || session.source,
    // A marker tag means nothing to a reel of whole scenes or of clips.
    tag: next === 'library' ? session.tag : null,
    seed: String(Math.floor(Math.random() * 1e9)),
    pin: false,
  };

  keep(moved);
  go(moved);
}

/* The feed strip, over the clip so it's reachable while scrolling on a phone. */
function feedStrip(session) {
  /*
   * The mark stays centred and the labels slide under it, all the same width,
   * so the strip keeps its size. Neighbours stay visible.
   */
  const at = Math.max(0, FEEDS.indexOf(session.feed));

  const track = el('div', { className: 'reelfeedtrack' });
  track.style.setProperty('--at', String(at));

  for (const key of FEEDS) {
    const on = key === session.feed;
    const dot = el('button', {
      className: 'reelfeed' + (on ? ' on' : ''),
      type: 'button',
      title: key === 'mixed' ? 'All three, in the proportions the slider sets' : FEED_LABEL[key] + ' on its own',
    }, FEED_LABEL[key]);

    dot.onclick = () => {
      if (!on) switchTo(session, key);
    };

    track.append(dot);
  }

  return el('nav', { className: 'reelfeeds', title: 'Swipe this sideways, click a name, or use the left and right arrows' },
    // The mark, drawn once and never moved. Everything else slides past it.
    el('span', { className: 'reelfeedmark' }),
    track
  );
}

/* Controls over the reel, in thumb reach. Neither navigates. */
/* The close button, top right (the header is hidden). */
function closer() {
  const x = el('button', { className: 'reelclose', type: 'button', title: 'Close the reel' }, '×');

  /*
   * Straight to the library: every feed change adds a history entry, so back()
   * would just step through feeds.
   */
  x.onclick = () => { location.hash = '#/library'; };

  return x;
}

export function corners(session) {
  const shape = el('button', {
    className: 'reelcorner slot1 right',
    type: 'button',
    title: 'How every slide is framed',
  }, CROP_LABEL[session.crop]);

  shape.onclick = () => {
    session.crop = CROPS[(CROPS.indexOf(session.crop) + 1) % CROPS.length];
    session.track.className = 'reel crop-' + session.crop;
    shape.textContent = CROP_LABEL[session.crop];
    keep(session);
    history.replaceState(null, '', addressFor(session));
    // The band's height depends on the framing, so it is measured again.
    session.measure?.();
  };

  const roll = el('button', {
    className: 'reelcorner slot1 left' + (session.roll ? ' on' : ''),
    type: 'button',
    title: 'Move on by itself once a clip has been round once',
  }, session.roll ? '▶▶' : '❚❚');

  roll.onclick = () => {
    session.roll = !session.roll;
    roll.classList.toggle('on', session.roll);
    roll.textContent = session.roll ? '▶▶' : '❚❚';
    keep(session);
    history.replaceState(null, '', addressFor(session));

    /* Turning roll on applies to the clip playing now. */
    armRoll(session, session.slides[session.current]);
  };

  /* Shuffle and sound live with these, reachable on a phone. */
  const shuffle = el('button', {
    className: 'reelcorner slot2 left',
    type: 'button',
    title: 'Deal a different reel',
  }, icon('shuffle'));
  shuffle.onclick = () => go({ ...session, seed: String(Math.floor(Math.random() * 1e9)), pin: true });

  const sound = el('button', {
    className: 'reelcorner slot2 right',
    type: 'button',
    title: 'Sound',
  }, icon(session.muted ? 'mute' : 'sound'));

  sound.onclick = () => {
    session.muted = !session.muted;
    sound.replaceChildren(icon(session.muted ? 'mute' : 'sound'));
    for (const slide of session.slides) {
      const video = slide.querySelector('video');
      if (video) video.muted = session.muted;
    }
  };

  /* Captions on or off. Rewrites the address in place. */
  const info = el('button', {
    className: 'reelcorner slot4 right' + (session.info ? '' : ' on'),
    type: 'button',
    title: 'Show or hide the details',
  }, icon(session.info ? 'info' : 'noinfo'));

  info.onclick = () => {
    session.info = !session.info;
    session.track.classList.toggle('noinfo', !session.info);
    info.classList.toggle('on', !session.info);
    info.replaceChildren(icon(session.info ? 'info' : 'noinfo'));
    keep(session);
    history.replaceState(null, '', addressFor(session));
    session.measure?.();
  };

  return [roll, shuffle, sound, shape, info];
}

/* Roll: play once (or four seconds for a still), then move on. Off loops. */
export function armRoll(session, slide) {
  clearTimeout(session.rollTimer);
  if (!slide) return;

  const video = slide.querySelector('video');

  if (!video) {
    // A still. Nothing to finish, so it is timed.
    if (session.roll) {
      session.rollTimer = setTimeout(() => advance(session), STILL_MS);
    }
    return;
  }

  // A windowed marker loops itself in windowed(); everything else uses the
  // element's own loop. Rolling switches whichever one applies off.
  video.loop = !session.roll && !slide.dataset.end;
  slide.dataset.roll = session.roll ? '1' : '';
}

export function advance(session) {
  if (session.dead || !session.roll) return;
  const next = session.slides[session.current + 1];
  if (next) next.scrollIntoView({ behavior: 'smooth' });
}
