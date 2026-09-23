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
   * What a marker plays. The rendered clips are what Stash generated for each
   * marker — 640x360 whatever the scene is, because that is the size Stash
   * makes them — and they start instantly. The source is the scene file at its
   * own resolution, seeked to the moment, which looks better and costs a range
   * request into a file that may be gigabytes.
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
   * Both halves of the tag question in one control.
   *
   * They were two dropdowns sitting side by side, both listing every tag, and
   * telling them apart meant reading their first option. They are the same
   * question asked twice — which tags is this reel about — so they are one
   * list with two groups, and which group you pick from says which you meant.
   *
   * Narrowing to one tag is a mood, so it replaces whatever was narrowed
   * before. Keeping tags out is a standing preference, so those accumulate and
   * show as chips you can take off individually.
   */
  const picker = el('select', { className: 'reelpick tags', title: 'Only one tag, or keep tags out' },
    /*
     * Blank, so that what shows in the closed control is the tag icon sitting
     * over it rather than a word. The options still read normally once it is
     * open, which is the only place words are needed.
     */
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

  /*
   * What the reel is narrowed to, when it is. The picker cannot show it — it
   * has gone back to offering — so the chip does, and taking it off is how you
   * widen again.
   */
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
   * Three zones on one row, at every width: the tags left, the feed window dead
   * centre, whatever is not a moment-to-moment control on the right.
   *
   * A grid rather than a flex row with spacers, because the centre has to be
   * centred against the *screen* and not against whatever the sides happen to
   * weigh — and the left side changes weight every time a tag chip appears.
   */
  return el('div', { className: 'reelbar' },
    el('div', { className: 'reelleft' }, tagged, only, excluded),
    feedStrip(session),
    el('div', { className: 'reelright' },
      /*
       * One way in to everything that is not a moment-to-moment control: where
       * the two off-library sources are managed, and how much of the reel they
       * are allowed to be.
       */
      gear,
      closer()
    )
  );
}

/* ------------------------------------------------------------ the feeds
 *
 * Four of them, and moving between them is sideways — but only on the dial.
 * The whole screen used to take the gesture, which put it in competition with
 * the two things a sideways drag on a clip already means: scrubbing through
 * it, and nothing at all. A swipe meant for the middle of a video changed the
 * feed under it, which is the page fighting the hand.
 *
 * Changing feed is a navigation rather than a filter: a different feed is a
 * different set of slides, so the reel is rebuilt rather than re-sorted. The
 * seed is deliberately left behind — arriving on RedGIFs should not deal you
 * the RedGIFs that happened to be woven into the mix you just left.
 */
export function feedTo(session, step) {
  const at = FEEDS.indexOf(session.feed);
  const next = FEEDS[(at + step + FEEDS.length) % FEEDS.length];
  if (next === session.feed) return;

  switchTo(session, next);
}

/*
 * Moving to a feed. Its source comes with it — Scenes and Markers are feeds
 * now, so choosing one is choosing what a slide is made of.
 *
 * The seed is deliberately left behind: arriving on RedGIFs should not deal you
 * the RedGIFs that happened to be woven into the mix you just left.
 */
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

/*
 * The strip that says which feed you are on, and lets a mouse do what a thumb
 * does. It sits with the other things drawn over the clip rather than in the
 * bar, because on a phone the bar is off the top of the screen the moment you
 * scroll and this is the control you most want while scrolling.
 */
function feedStrip(session) {
  /*
   * The mark stays put and the labels move behind it.
   *
   * The obvious build is a row of pills with the accent moving between them,
   * and it has a flaw you only see once it is on screen: "All three" and
   * "Reddit" are different widths, so the highlight jumps about and the whole
   * strip changes size as you move through the feeds. The fix, and it is the
   * better one — pin the mark in the middle, give every label the same slot,
   * and slide the labels underneath. The strip is then a fixed size whatever it
   * is showing, which is what lets it sit in a bar next to other things.
   *
   * The neighbours either side stay visible, so it reads as a position in a
   * list rather than a label that changed.
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

/*
 * The two controls that live over the reel rather than in the bar.
 *
 * On a phone the bar is off the top of the screen the moment you scroll, and
 * reaching the crop button meant scrolling back up to it. These sit on the
 * clip, thumb-high, and neither of them navigates: the reel you are watching
 * survives both.
 */
/*
 * The way out.
 *
 * Hiding the header takes the navigation with it, so the reel has to offer its
 * own. Top right, where a full-screen thing has closed since the first window
 * manager — and it goes back rather than to a fixed page, so it returns you to
 * whatever you were doing before the reel.
 */
function closer() {
  const x = el('button', { className: 'reelclose', type: 'button', title: 'Close the reel' }, '×');

  /*
   * Straight to the library, not history.back().
   *
   * Back was the obvious build and it does not work here: every feed you move
   * through pushes a history entry, so going back from a reel lands you on the
   * reel you were on a moment ago, and closing takes as many presses as you
   * made swipes. Closing means leaving, so it leaves.
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

    /*
     * Turning it on mid-clip should not strand you: whatever is playing now
     * gets the same treatment as everything after it.
     */
    armRoll(session, session.slides[session.current]);
  };

  /*
   * Shuffle and sound came down from the bar to sit with these. The bar
   * scrolls away on a phone and these do not, and a control you cannot reach
   * while watching is a control you do not use.
   */
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

  /*
   * The captions on or off. Like the framing button it never navigates: the
   * clip you are watching survives it, and the address is rewritten in place.
   */
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

/*
 * Moving on by itself.
 *
 * A clip loops for as long as you leave it, which is the right behaviour when
 * you are choosing. Rolling turns that into one time round: a video that has
 * played its window once, or a still that has been up four seconds, hands over
 * to the next slide. Turning it off puts the loop back.
 */
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
