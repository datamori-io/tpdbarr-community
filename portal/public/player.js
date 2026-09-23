/*
 * The player chrome.
 *
 * The browser's own controls are one bar with a hairline seek track, and on a
 * phone that track is three pixels of tap target you are meant to hit with a
 * thumb. Everything here exists to fix that: a scrub row tall enough to grab,
 * a handle that stays under your finger, the sprite thumbnails Stash already
 * generated shown while you drag, and the scene's markers drawn on the track
 * so you can see what you are dragging past.
 *
 * The <video> stays the caller's. This wraps it and takes its native controls
 * away; resume, progress reporting and teardown are none of its business and
 * stay where they were.
 */

import { el } from './util.js';

// Player time, not runtime — util's clock() says "1h 04m", which is the right
// answer on a tile and the wrong one under a seek bar.
export function stamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/* ------------------------------------------------------------- thumbnails */

const parseTime = (text) => {
  const parts = text.trim().replace(',', '.').split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts.length === 1 ? parts[0] : null;
};

/*
 * Stash writes one vtt per scene whose every cue points at a rectangle of a
 * single sprite sheet — sheet.jpg#xywh=160,90,160,90. So the whole strip is
 * one image request and one text request, however long the scene is.
 *
 * -> every cue, in time order, or null if this scene never had its sprite
 * generated. Not having thumbnails is ordinary rather than an error: the rest
 * of the bar works without them.
 *
 * The list and the lookup below it are separate because they are wanted for
 * different things. A scrub bar asks "what was on screen at this second" and
 * wants the lookup; the marker builder's timeline lays every tile out along a
 * strip and wants them all. Parsing a vtt twice to answer both would be the
 * only other way.
 */
export async function thumbnailCues(url) {
  if (!url) return null;

  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null;
  }

  const lines = text.replace(/\r/g, '').split('\n');
  const cues = [];

  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].indexOf('-->');
    if (arrow < 0) continue;

    const start = parseTime(lines[i].slice(0, arrow));
    const payload = (lines[i + 1] || '').trim();
    if (start === null || !payload) continue;

    const [src, fragment] = payload.split('#');
    const box = /xywh=(-?\d+),(-?\d+),(\d+),(\d+)/.exec(fragment || '');
    cues.push({
      start,
      src,
      // No fragment means the cue is a whole image rather than a tile of a
      // sheet. Stash does not do that, but other vtt writers do.
      crop: box ? { x: +box[1], y: +box[2], w: +box[3], h: +box[4] } : null,
    });
  }

  if (!cues.length) return null;
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/*
 * -> a lookup taking seconds to a cue, or null if there are none.
 */
export async function thumbnailStrip(url) {
  const cues = await thumbnailCues(url);
  if (!cues) return null;

  // A two-hour scene is a few hundred cues and this runs on every pointermove,
  // so it is worth not walking the list each time.
  return (seconds) => {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cues[mid].start <= seconds) lo = mid;
      else hi = mid - 1;
    }
    return cues[lo];
  };
}

/* ------------------------------------------------------------------ icons */

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  full: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  unfull: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  wide: 'M2 12l4-4v3h5v2H6v3zm20 0l-4 4v-3h-5v-2h5V8z',
  narrow: 'M11 12 7 8v3H2v2h5v3zm2 0 4-4v3h5v2h-5v3z',
  pip: 'M19 11h-8v6h8v-6zm2-8H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16.02H3V4.97h18v14.05z',
  loud: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z',
  // A bookmark with a plus on it: mark this moment.
  mark: 'M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2zm-4 8v3h-2v-3H8V9h3V6h2v3h3v2h-3z',
  muted: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM5.5 5 4 6.5 8.5 11H3v6h4l5 5v-6.5l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.5 21 21 19.5 5.5 5z',
};

const glyph = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${ICONS[name]}"/></svg>`;

function button(className, label, iconName) {
  const node = el('button', { className: `vbtn ${className}`, type: 'button', title: label });
  node.setAttribute('aria-label', label);
  if (iconName) node.innerHTML = glyph(iconName);
  return node;
}

const SPEEDS = [1, 1.25, 1.5, 2, 0.5, 0.75];

/* ----------------------------------------------------------------- chrome */

/*
 * -> the node to put on the page, with `video` inside it.
 *
 * `thumbnails` is a url to a sprite vtt; `markers` is [{ seconds, title }];
 * `duration` is what the caller already knows, used until the file itself
 * says otherwise — a stream reports NaN for its duration for a moment and the
 * bar should not collapse every time it does.
 *
 * `onWide` is the page saying it has room to give: pass one and the bar grows
 * a switch that calls it with true or false. What that means is the page's
 * business — this only draws the switch and remembers which way it is.
 *
 * `onMark` is the same arrangement for marking a moment. Pass one and the bar
 * grows a button that pauses, hands it the current second, and puts whatever
 * comes back on the track — so a marker made while watching appears under the
 * scrub bar without the page redrawing. Writing it is the page's business;
 * what this owns is that the moment marked is the frame on screen, which
 * means pausing before asking.
 */
export function withControls(video, { thumbnails = null, markers: given = [], duration = 0, onWide = null, onMark = null } = {}) {
  // Reassigned when a marker is made from the bar below, so it is a binding of
  // this function's own rather than the caller's array.
  let markers = given;
  video.controls = false;

  const wrap = el('div', { className: 'vplayer', tabIndex: 0 });

  const buffered = el('div', { className: 'vbuffered' });
  const played = el('div', { className: 'vplayed' });
  const handle = el('div', { className: 'vhandle' });
  const marks = el('div', { className: 'vmarks' });
  const track = el('div', { className: 'vtrack' }, buffered, played, marks, handle);

  /*
   * Two nodes, because a sprite tile has to be cropped at its natural size and
   * shown at a bigger one. A percentage background-size would scale the sheet
   * to the card rather than to itself, so the tile is cut at 1:1 and the whole
   * thing is scaled by transform inside a window that clips it.
   */
  const tile = el('div', { className: 'vshottile' });
  const shot = el('div', { className: 'vshot' }, tile);
  const shotLabel = el('div', { className: 'vshotlabel', hidden: true });
  const shotTime = el('div', { className: 'vshottime' });
  const preview = el('div', { className: 'vpreview', hidden: true }, shot, shotLabel, shotTime);

  const scrub = el('div', { className: 'vscrub' }, track, preview);
  scrub.setAttribute('role', 'slider');
  scrub.setAttribute('aria-label', 'Seek');

  const playPause = button('vplay', 'Play', 'play');
  const mute = button('vmute', 'Mute', 'loud');
  const volume = el('input', {
    className: 'vvolume', type: 'range', min: '0', max: '1', step: '0.05', value: '1',
  });
  volume.setAttribute('aria-label', 'Volume');
  const readout = el('span', { className: 'vtime' }, '0:00 / 0:00');
  const speed = el('button', { className: 'vbtn vspeed', type: 'button', title: 'Playback speed' }, '1×');
  // Not `vmark` — that class is the marker drawn on the track below.
  const markBtn = onMark ? button('vmarkbtn', 'Mark this moment', 'mark') : null;
  const wide = onWide ? button('vwide', 'Fill the width', 'wide') : null;
  const pip = button('vpip', 'Picture in picture', 'pip');
  const full = button('vfull', 'Fullscreen', 'full');

  const bar = el('div', { className: 'vbar' },
    scrub,
    el('div', { className: 'vbuttons' },
      playPause,
      el('div', { className: 'vsound' }, mute, volume),
      readout,
      el('div', { className: 'vgap' }),
      markBtn,
      speed,
      wide,
      pip,
      full
    )
  );

  const centre = button('vbig', 'Play', 'play');
  const spinner = el('div', { className: 'vspinner', hidden: true });
  const flash = el('div', { className: 'vflash', hidden: true });

  /*
   * The layer that makes the whole picture a seek bar. It is a node over the
   * video rather than handlers on the video itself because the taps below are
   * its business too, and a video that is sometimes covered and sometimes not
   * would answer a tap differently depending on what else was drawn that day.
   */
  const surface = el('div', { className: 'vsurface' });

  wrap.append(video, surface, spinner, flash, centre, bar);

  /* --------------------------------------------------------- what it knows */

  const runtime = () =>
    (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration || 0);

  let lookup = null;
  if (thumbnails) thumbnailStrip(thumbnails).then((found) => { lookup = found; });

  /*
   * Markers can only be placed once there is a duration to place them against,
   * which on a fresh load arrives with the metadata. Drawing and placing are
   * separate because a resize moves them without rebuilding them.
   */
  const inRange = () => markers.filter((m) => m.seconds > 0 && m.seconds < runtime());

  function drawMarks() {
    if (marks.children.length || !runtime() || !markers.length) return;
    marks.replaceChildren(...inRange().map((m) =>
      el('div', { className: 'vmark', title: `${stamp(m.seconds)} · ${m.title}` })));
    placeMarks();
  }

  function placeMarks() {
    const total = runtime();
    if (!total || !marks.children.length) return;
    const shown = inRange();
    [...marks.children].forEach((node, i) => {
      if (shown[i]) node.style.left = `${(shown[i].seconds / total) * 100}%`;
    });
  }

  const nearestMarker = (seconds) => {
    // Within one percent of the bar — the same distance on screen whatever the
    // runtime, so a long film does not swallow every marker into one label.
    const reach = Math.max(4, runtime() / 100);
    let best = null;
    for (const m of markers) {
      const gap = Math.abs(m.seconds - seconds);
      if (gap <= reach && (!best || gap < Math.abs(best.seconds - seconds))) best = m;
    }
    return best;
  };

  /* ------------------------------------------------------------- the scrub */

  let dragging = false;
  let dragTime = 0;

  const ratioAt = (clientX) => {
    const box = track.getBoundingClientRect();
    if (!box.width) return 0;
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  };

  function paint() {
    const total = runtime();
    const at = dragging ? dragTime : video.currentTime;
    const pct = total ? Math.min(100, (at / total) * 100) : 0;
    played.style.width = `${pct}%`;
    handle.style.left = `${pct}%`;
    readout.textContent = `${stamp(at)} / ${stamp(total)}`;
    scrub.setAttribute('aria-valuetext', `${stamp(at)} of ${stamp(total)}`);
  }

  /*
   * The preview is what a thumb is actually steering by, so it does the work a
   * live seek would otherwise do: dragging moves this and nothing else, and
   * the file is only asked for a new position when the finger lifts. Seeking a
   * 3GB file on every pointermove would spend the whole drag buffering.
   */
  function showPreview(seconds) {
    const total = runtime();
    if (!total) return;

    preview.hidden = false;
    shotTime.textContent = stamp(seconds);

    const marker = nearestMarker(seconds);
    shotLabel.textContent = marker ? marker.title : '';
    shotLabel.hidden = !marker;

    const cue = lookup ? lookup(seconds) : null;
    shot.hidden = !cue;

    if (cue) {
      // The sheet's tiles are small — 160 wide on a default Stash — so the card
      // shows one blown up rather than a stamp.
      const { x, y, w, h } = cue.crop || { x: 0, y: 0, w: 190, h: 107 };
      const scale = Math.min(2, Math.max(1, (window.innerWidth < 700 ? 148 : 190) / w));

      shot.style.width = `${Math.round(w * scale)}px`;
      shot.style.height = `${Math.round(h * scale)}px`;

      tile.style.width = `${w}px`;
      tile.style.height = `${h}px`;
      tile.style.transform = `scale(${scale})`;
      tile.style.backgroundImage = `url("${cue.src}")`;
      tile.style.backgroundPosition = cue.crop ? `-${x}px -${y}px` : 'center';
      tile.style.backgroundSize = cue.crop ? 'auto' : 'cover';
    }

    // Measured after the card has its contents, and clamped to the track so it
    // never hangs off the side of the stage.
    const box = track.getBoundingClientRect();
    const half = preview.offsetWidth / 2;
    const x = Math.min(box.width - half, Math.max(half, (seconds / total) * box.width));
    preview.style.left = `${x}px`;
  }

  const hidePreview = () => { preview.hidden = true; };

  scrub.addEventListener('pointerdown', (e) => {
    if (!runtime()) return;
    dragging = true;
    dragTime = ratioAt(e.clientX) * runtime();
    // Capture is what keeps the drag alive once the finger leaves the bar,
    // which on a 40px row it does constantly. Not every pointer can be
    // captured, and a drag that works only over the bar beats no drag at all.
    try { scrub.setPointerCapture(e.pointerId); } catch {}
    wrap.classList.add('scrubbing');
    showPreview(dragTime);
    paint();
    e.preventDefault();
  });

  scrub.addEventListener('pointermove', (e) => {
    if (!runtime()) return;
    const seconds = ratioAt(e.clientX) * runtime();
    if (dragging) {
      dragTime = seconds;
      paint();
    }
    // Hovering shows the same card without moving the handle, which is the
    // desktop half of the same idea.
    if (dragging || e.pointerType === 'mouse') showPreview(seconds);
  });

  scrub.addEventListener('pointerleave', (e) => {
    if (!dragging && e.pointerType === 'mouse') hidePreview();
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('scrubbing');
    video.currentTime = dragTime;
    if (e.pointerType !== 'mouse') hidePreview();
    paint();
    wake();
  };

  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', endDrag);

  /* -------------------------------------------------------------- the rest */

  const toggle = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  playPause.onclick = toggle;
  centre.onclick = toggle;

  // The one bit of feedback a jump needs: on a phone the bar is usually hidden
  // when you double-tap, so something has to say the tap landed.
  let flashTimer = null;
  function say(text) {
    flash.textContent = text;
    flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash.hidden = true; }, 650);
  }

  const nudge = (by) => {
    const total = runtime();
    const to = Math.max(0, video.currentTime + by);
    video.currentTime = total ? Math.min(total - 0.5, to) : to;
    say(by > 0 ? `+${by}s` : `${by}s`);
    paint();
  };

  video.addEventListener('play', () => {
    playPause.innerHTML = glyph('pause');
    playPause.title = 'Pause';
    centre.innerHTML = glyph('pause');
    wrap.classList.add('playing');
    wake();
  });

  video.addEventListener('pause', () => {
    playPause.innerHTML = glyph('play');
    playPause.title = 'Play';
    centre.innerHTML = glyph('play');
    wrap.classList.remove('playing', 'idle');
  });

  video.addEventListener('timeupdate', () => { if (!dragging) paint(); });
  video.addEventListener('loadedmetadata', () => { drawMarks(); paint(); });
  video.addEventListener('durationchange', () => { drawMarks(); placeMarks(); paint(); });
  video.addEventListener('waiting', () => { spinner.hidden = false; });
  video.addEventListener('playing', () => { spinner.hidden = true; });
  video.addEventListener('canplay', () => { spinner.hidden = true; });
  video.addEventListener('error', () => { spinner.hidden = true; });

  video.addEventListener('progress', () => {
    const total = runtime();
    if (!total || !video.buffered.length) return;
    /*
     * Only the range the playhead is sitting in. The others are places you
     * seeked past, and drawing them makes the bar claim to have loaded far
     * more of the file than it has.
     */
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
        buffered.style.width = `${(video.buffered.end(i) / total) * 100}%`;
        return;
      }
    }
  });

  mute.onclick = () => { video.muted = !video.muted; };
  volume.oninput = () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
  };
  video.addEventListener('volumechange', () => {
    const off = video.muted || video.volume === 0;
    mute.innerHTML = glyph(off ? 'muted' : 'loud');
    mute.title = off ? 'Unmute' : 'Mute';
    volume.value = String(off ? 0 : video.volume);
  });

  speed.onclick = () => {
    const at = SPEEDS.indexOf(video.playbackRate);
    video.playbackRate = SPEEDS[(at + 1) % SPEEDS.length];
  };
  video.addEventListener('ratechange', () => {
    speed.textContent = `${video.playbackRate}×`;
    speed.classList.toggle('on', video.playbackRate !== 1);
  });

  /*
   * Two APIs for the same button. Everywhere but Safari it is
   * requestPictureInPicture(); WebKit has never shipped that one and puts the
   * video into a presentation mode instead — which is why an iPad had a
   * pop-out button that did nothing. The webkit path is tried first, because
   * where both are claimed it is the one Safari actually honours.
   *
   * Whether it is offered can change once the file is open: Safari answers
   * webkitSupportsPresentationMode against a video it has metadata for, and
   * this bar is built before there is any. So it is asked again on load
   * rather than once, when the honest answer is still "no idea".
   */
  const webkitPip = () =>
    typeof video.webkitSetPresentationMode === 'function' &&
    video.webkitSupportsPresentationMode?.('picture-in-picture') === true;

  const canPip = () => webkitPip() || !!document.pictureInPictureEnabled;

  const offerPip = () => { pip.hidden = !canPip(); };
  offerPip();
  video.addEventListener('loadedmetadata', offerPip);

  pip.onclick = () => {
    if (webkitPip()) {
      const on = video.webkitPresentationMode === 'picture-in-picture';
      video.webkitSetPresentationMode(on ? 'inline' : 'picture-in-picture');
      return;
    }
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else video.requestPictureInPicture().catch(() => {});
  };

  /*
   * An iPhone will not put an arbitrary element into fullscreen — only the
   * video itself, and once it is there the controls are Apple's rather than
   * these. That is the worse player — no markers, no thumbnails, and none of
   * the buttons on this bar, the pop-out included — so it is the fallback and
   * not the route. An iPad will take the wrapper, but only under the
   * webkit-prefixed name, which is why that is asked for before giving up.
   */
  const fullscreenNode = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  full.onclick = () => {
    if (fullscreenNode()) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else document.webkitExitFullscreen?.();
    } else if (wrap.requestFullscreen) {
      wrap.requestFullscreen().catch(() => {});
    } else if (wrap.webkitRequestFullscreen) {
      wrap.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  };

  const fullscreenChanged = () => {
    const on = fullscreenNode() === wrap;
    wrap.classList.toggle('fullscreen', on);
    full.innerHTML = glyph(on ? 'unfull' : 'full');
    full.title = on ? 'Leave fullscreen' : 'Fullscreen';
    placeMarks();
  };

  wrap.addEventListener('fullscreenchange', fullscreenChanged);
  wrap.addEventListener('webkitfullscreenchange', fullscreenChanged);

  if (wide) {
    let on = false;
    wide.onclick = () => {
      on = !on;
      wide.innerHTML = glyph(on ? 'narrow' : 'wide');
      wide.title = on ? 'Give the column back' : 'Fill the width';
      wide.setAttribute('aria-label', wide.title);
      wide.classList.toggle('on', on);
      onWide(on);
    };
  }

  /*
   * Marking a moment while watching it.
   *
   * Paused first, and deliberately: the moment being marked is the frame on
   * screen, and a video that carries on playing while the tag is being chosen
   * marks a second that has already gone past. The time is read once, before
   * anything is asked, for the same reason.
   *
   * What comes back goes straight onto the track. The marks are drawn once and
   * then only moved, so a new one means clearing them and letting drawMarks
   * build the row again — which is cheap: it is a handful of empty divs.
   */
  if (markBtn) {
    markBtn.onclick = async () => {
      const seconds = video.currentTime;
      video.pause();

      markBtn.disabled = true;
      try {
        const made = await onMark(seconds);
        if (!made) return;
        markers = [...markers, made].sort((a, b) => a.seconds - b.seconds);
        marks.replaceChildren();
        drawMarks();
      } finally {
        markBtn.disabled = false;
      }
    };
  }

  /* --------------------------------------------------- showing and hiding */

  let idleTimer = null;

  function wake() {
    wrap.classList.remove('idle');
    clearTimeout(idleTimer);
    if (video.paused) return;
    idleTimer = setTimeout(() => {
      if (!video.paused && !dragging) wrap.classList.add('idle');
    }, 2600);
  }

  wrap.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wake(); });
  bar.addEventListener('pointerdown', wake);

  /*
   * Tapping the video means two different things on the two kinds of screen.
   * With a mouse it plays and pauses, because that is what clicking a video
   * has always done. With a thumb it shows the bar, because the bar is what
   * you were reaching for — and a second tap on the same side inside the
   * double-tap window jumps ten seconds, the way every phone player does it.
   */
  let lastTap = 0;
  let lastSide = null;

  function tapped(e) {
    if (e.pointerType === 'mouse') { toggle(); return; }

    const box = wrap.getBoundingClientRect();
    const side = e.clientX < box.left + box.width / 3 ? 'left'
      : e.clientX > box.right - box.width / 3 ? 'right'
      : 'middle';
    const now = Date.now();

    if (side !== 'middle' && side === lastSide && now - lastTap < 400) {
      nudge(side === 'left' ? -10 : 10);
      lastTap = 0;
      return;
    }

    lastTap = now;
    lastSide = side;

    if (wrap.classList.contains('idle') || video.paused) wake();
    else wrap.classList.add('idle');
  }

  /* ------------------------------------------------ the picture as a bar
   *
   * A drag anywhere across the video moves the playhead, with the same reach
   * the bar has: the full width is the full runtime. It is relative rather
   * than absolute — where you started is where you were, not where you
   * pressed — because the same surface still has to answer a tap, and a tap
   * that jumped you somewhere would be the worse trade.
   *
   * Like the bar, it moves the preview and nothing else until you let go. A
   * 3GB file seeked on every pointermove spends the whole drag buffering.
   */

  // Far enough that an unsteady thumb is still a tap, and read against the
  // vertical distance so a page scroll that begins over the video stays one.
  const DRAG_STARTS = 8;

  let gesture = null;

  surface.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, from: video.currentTime, on: false };
  });

  surface.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const total = runtime();
    if (!total) return;

    const dx = e.clientX - gesture.x;
    if (!gesture.on) {
      if (Math.abs(dx) < DRAG_STARTS || Math.abs(dx) <= Math.abs(e.clientY - gesture.y)) return;
      gesture.on = true;
      dragging = true;
      wrap.classList.add('scrubbing');
      // The bar is what the drag draws on, so it comes back for the drag.
      wake();
      try { surface.setPointerCapture(e.pointerId); } catch {}
    }

    dragTime = Math.min(total - 0.5, Math.max(0, gesture.from + (dx / (wrap.clientWidth || 1)) * total));
    showPreview(dragTime);
    paint();
    e.preventDefault();
  });

  surface.addEventListener('pointerup', (e) => {
    const drag = gesture;
    gesture = null;

    // A press that never travelled is the tap it always was.
    if (!drag?.on) { tapped(e); return; }

    dragging = false;
    wrap.classList.remove('scrubbing');
    video.currentTime = dragTime;
    hidePreview();
    paint();
    wake();
  });

  surface.addEventListener('pointercancel', () => {
    if (gesture?.on) {
      dragging = false;
      wrap.classList.remove('scrubbing');
      hidePreview();
      paint();
    }
    gesture = null;
  });

  /* ---------------------------------------------------------------- keys */

  const KEYS = {
    ' ': () => toggle(),
    k: () => toggle(),
    ArrowLeft: () => nudge(-5),
    ArrowRight: () => nudge(5),
    j: () => nudge(-10),
    l: () => nudge(10),
    f: () => full.click(),
    w: () => wide?.click(),
    m: () => { video.muted = !video.muted; },
    ArrowUp: () => { video.muted = false; video.volume = Math.min(1, video.volume + 0.1); },
    ArrowDown: () => { video.volume = Math.max(0, video.volume - 0.1); },
  };

  wrap.addEventListener('keydown', (e) => {
    // The volume slider is a real range input and its own arrow keys are the
    // ones you want while it has focus.
    if (e.target === volume) return;
    const act = KEYS[e.key];
    if (!act) return;
    e.preventDefault();
    wake();
    act();
  });

  window.addEventListener('resize', placeMarks);

  /* ------------------------------------------------- the next file along
   *
   * The movie page plays a group's scenes back to back through one bar, so
   * the chrome cannot be rebuilt between them: fullscreen, the volume, the
   * speed and the wide switch all belong to this node, and a new one drops
   * every one of them on the floor mid-film.
   *
   * So what is per-file is handed back in — that scene's markers, its sprite
   * sheet, and the runtime to draw against until the file itself reports one.
   * Setting the video's src stays the caller's business, the same way the
   * first one was.
   */
  wrap.reload = ({ thumbnails: sheet = null, markers: next = [], duration: runs = 0 } = {}) => {
    markers = next;
    duration = runs;
    lookup = null;
    marks.replaceChildren();
    buffered.style.width = '0%';
    if (sheet) thumbnailStrip(sheet).then((found) => { lookup = found; });
    drawMarks();
    paint();
  };

  paint();
  return wrap;
}
