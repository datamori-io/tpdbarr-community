import { api, clock, el } from '../util.js';
import { claim, holds, loadingIn, onTeardown, shell } from './core.js';
import { castStrip } from './scene.js';

/*
 * TV: pick a channel and filed scenes (or films) play back to back, live.
 *
 * The server hands over the day's lineup and when it started (see tv.mjs);
 * what is on is worked out from the clock, so tuning in joins a scene
 * part-way and every device agrees. Skip moves your own clock forward to the
 * next scene; changing channel rejoins live.
 *
 * Sound starts off and the first tap or key anywhere turns it on for the
 * rest of the visit. Plays and resume points are not recorded.
 */

const SECTION = '#/library/tv';
const OVERLAY_MS = 5000;
// How far behind live the picture may fall (buffering) before it jumps back.
const DRIFT = 20;
// Load the next scene into the spare video this many seconds before the end.
const PRELOAD = 20;
const UP_NEXT = 5;
const LAST = 'tv.channel';
const LAST_GROUP = 'tv.group';

let sound = false;

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export async function showTv(query = '') {
  const mine = claim();
  loadingIn(SECTION);

  let list;
  try {
    list = await api('/api/library/tv/channels');
  } catch (err) {
    if (holds(mine)) shell(SECTION, el('div', { className: 'empty' }, err.message));
    return;
  }
  if (!holds(mine)) return;

  const GROUPS = [
    ['categories', 'Categories', list.categories],
    ['studios', 'Studios', list.studios],
    ['performers', 'Performers', list.performers],
    ['tags', 'Tags', list.tags],
  ].filter(([, , g]) => g.length);
  const tops = [list.random, list.movies].filter((c) => c && c.count);

  // One flat order for channel up/down, in guide order.
  const order = [...tops, ...GROUPS.flatMap(([, , g]) => g)];
  const labelOf = new Map(order.map((c) => [c.key, c.label]));

  const asked = new URLSearchParams(query).get('ch');
  let key = [asked, store.get(LAST)].find((k) => k && labelOf.has(k)) || 'random';

  // ---------------------------------------------------------------- the page

  const videos = [0, 1].map(() => el('video', { className: 'tvvideo', playsInline: true, muted: true, preload: 'auto' }));
  const overlay = el('div', { className: 'tvoverlay', hidden: true });
  const hint = el('div', { className: 'tvhint', hidden: sound }, 'Tap for sound');
  const stage = el('div', { className: 'tvstage' }, ...videos, overlay, hint);

  const channelName = el('span', { className: 'tvchanname' });
  const down = el('button', { className: 'chip', type: 'button', title: 'Previous channel (↓)' }, '▼');
  const up = el('button', { className: 'chip', type: 'button', title: 'Next channel (↑)' }, '▲');
  const skip = el('button', { className: 'chip', type: 'button', title: 'Skip to the next scene (→)' }, 'Skip ⏭');
  const backLive = el('button', { className: 'chip', type: 'button', title: 'Back to what is live', hidden: true }, '● Live');
  const full = el('button', { className: 'chip', type: 'button', title: 'Fullscreen (f)' }, 'Fullscreen');
  const bar = el('div', { className: 'tvbar' }, down, channelName, up, el('span', { className: 'spacer' }), backLive, skip, full);

  const info = el('div', { className: 'tvinfo' });
  const upNext = el('div', { className: 'tvnext' });
  const guide = el('div', { className: 'tvguide' });

  // ---------------------------------------------------------------- playback

  let lineup = null;
  let skew = 0;          // server clock minus ours
  let shift = 0;         // seconds skipped ahead of live on this channel
  let at = -1;           // index in the lineup of what is on
  let active = 0;        // which of the two videos is showing
  let alive = true;
  let overlayTimer = null;
  const now = () => Date.now() + skew + shift * 1000;

  // Where the lineup is at this moment: which scene, and how far into it.
  const spot = () => {
    let t = ((now() - lineup.epoch) / 1000) % lineup.total;
    for (let i = 0; i < lineup.scenes.length; i += 1) {
      const d = lineup.scenes[i].duration;
      if (t < d) return { i, offset: t };
      t -= d;
    }
    return { i: 0, offset: 0 };
  };

  const unload = (video) => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };

  const left = () => Math.max(0, lineup.scenes[at].duration - (videos[active].currentTime || 0));

  const showOverlay = () => {
    if (!lineup || at < 0) return;
    const scene = lineup.scenes[at];
    const next = lineup.scenes[(at + 1) % lineup.scenes.length];
    overlay.replaceChildren(
      el('div', { className: 'tvchannel' }, lineup.label),
      el('div', { className: 'tvnow' }, scene.title),
      el('div', { className: 'muted small' }, `${clock(Math.round(left()))} left · Next: ${next.title}`)
    );
    overlay.hidden = false;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => { overlay.hidden = true; }, OVERLAY_MS);
  };

  // ------------------------------------------------ what is on, under the player

  const details = new Map();
  const drawInfo = async (i) => {
    const brief = lineup.scenes[i];
    const head = (scene) => el('div', { className: 'tvinfohead' },
      el('div', { className: 'tvinfotext' },
        el('a', { className: 'tvinfotitle', href: `#/library/scene/${brief.id}` }, brief.title),
        el('div', { className: 'muted' },
          [brief.studio, brief.date, clock(brief.duration)].filter(Boolean).join(' · '))),
      scene ? castStrip(scene.performers || []) : null
    );
    info.replaceChildren(head(null));
    let scene = details.get(brief.id);
    if (!scene) {
      scene = await api(`/api/library/scenes/${brief.id}`).then((d) => d.scene).catch(() => null);
      if (scene) details.set(brief.id, scene);
    }
    if (!alive || at !== i || !scene) return;
    info.replaceChildren(
      head(scene),
      scene.details ? el('p', { className: 'tvdetails' }, scene.details) : null
    );
  };

  // The next few scenes and when each starts, on this (possibly skipped) clock.
  const drawUpNext = () => {
    if (!lineup || at < 0) return;
    let starts = Date.now() + left() * 1000;
    const cards = [];
    for (let n = 1; n <= Math.min(UP_NEXT, lineup.scenes.length - 1); n += 1) {
      const scene = lineup.scenes[(at + n) % lineup.scenes.length];
      const card = el('button', { className: 'tvnextcard', type: 'button', title: 'Watch this now' },
        el('img', { src: `/media/scene/${scene.id}/thumb`, loading: 'lazy', alt: '' }),
        el('div', { className: 'tvnexttime' }, hhmm(starts)),
        el('div', { className: 'tvnexttitle' }, scene.title),
        el('div', { className: 'muted small' }, scene.studio || ''));
      card.onclick = () => jumpTo(n);
      cards.push(card);
      starts += scene.duration * 1000;
    }
    upNext.replaceChildren(el('h3', {}, 'Up next'), el('div', { className: 'tvnextrow' }, cards));
  };

  // Put scene `i` on at `offset` seconds, in whichever video is free.
  const play = (i, offset) => {
    const scene = lineup.scenes[i];
    const next = videos[1 - active];
    const was = videos[active];
    const url = `/media/scene/${scene.id}/stream`;

    const start = () => {
      if (offset > 1) next.currentTime = offset;
      next.muted = !sound;
      next.play().catch(() => {});
    };
    next.onerror = () => { if (alive && at === i) setTimeout(() => alive && advance(), 2000); };
    // Already loading from the preload: start it rather than reload.
    if (next.getAttribute('src') === url && next.readyState >= 1) start();
    else {
      next.onloadedmetadata = start;
      next.src = url;
    }

    next.classList.add('on');
    was.classList.remove('on');
    unload(was);
    active = 1 - active;
    at = i;
    backLive.hidden = shift === 0;
    showOverlay();
    drawInfo(i);
    drawUpNext();
  };

  // The scene ended (or failed): go to what is on now, or the next one if
  // the clock still says this one.
  const advance = () => {
    const here = spot();
    if (here.i === at) play((at + 1) % lineup.scenes.length, 0);
    else play(here.i, here.offset);
  };

  // Skip ahead `n` scenes: move this channel's clock to the start of it.
  const jumpTo = (n) => {
    if (!lineup || at < 0) return;
    let ahead = left();
    for (let k = 1; k < n; k += 1) ahead += lineup.scenes[(at + k) % lineup.scenes.length].duration;
    shift += ahead;
    play((at + n) % lineup.scenes.length, 0);
  };

  const preload = (video) => {
    if (!lineup || at < 0 || video !== videos[active]) return;
    // The lineup's runtime, not video.duration, which is NaN until metadata.
    if (lineup.scenes[at].duration - (video.currentTime || 0) > PRELOAD) return;
    const spare = videos[1 - active];
    const url = `/media/scene/${lineup.scenes[(at + 1) % lineup.scenes.length].id}/stream`;
    if (spare.getAttribute('src') === url) return;
    spare.onloadedmetadata = null;
    spare.muted = true;
    spare.src = url;
  };

  for (const video of videos) {
    video.addEventListener('ended', () => { if (alive && video === videos[active]) advance(); });
    video.addEventListener('timeupdate', () => preload(video));
  }

  // --------------------------------------------------------------- the guide

  let group = store.get(LAST_GROUP);
  if (!GROUPS.some(([k]) => k === group)) group = GROUPS[0]?.[0];
  const filter = el('input', { className: 'tvfilter', type: 'search', placeholder: 'Filter channels…' });
  const tabs = el('div', { className: 'viewswitch tvtabs' });
  const chips = el('div', { className: 'tvchips' });
  const topRow = el('div', { className: 'tvchips tvtop' });

  const chip = (c) => {
    const b = el('button', { className: 'chip tvchip', type: 'button' },
      c.label, el('span', { className: 'muted small' }, ` ${c.count}`));
    b.dataset.key = c.key;
    b.onclick = () => tune(c.key).catch(() => {});
    return b;
  };

  const markGuide = () => {
    for (const b of guide.querySelectorAll('.tvchip')) b.classList.toggle('on', b.dataset.key === key);
  };

  const drawChips = () => {
    const items = (GROUPS.find(([k]) => k === group) || [, , []])[2];
    const q = filter.value.trim().toLowerCase();
    const shown = items.filter((c) => !q || c.label.toLowerCase().includes(q));
    chips.replaceChildren(...(shown.length ? shown.map(chip) : [el('span', { className: 'muted' }, 'No channels match.')]));
    markGuide();
  };

  const drawTabs = () => {
    tabs.replaceChildren(...GROUPS.map(([k, name, items]) => {
      const b = el('button', { className: 'chip' + (k === group ? ' on' : ''), type: 'button' }, `${name} ${items.length}`);
      b.onclick = () => { group = k; store.set(LAST_GROUP, k); drawTabs(); drawChips(); };
      return b;
    }));
  };

  topRow.replaceChildren(...tops.map(chip));
  filter.oninput = drawChips;
  guide.replaceChildren(
    el('h3', {}, 'Channels'),
    topRow,
    el('div', { className: 'controls tvguidebar' }, tabs, filter),
    chips
  );
  drawTabs();
  drawChips();

  // ---------------------------------------------------------------- tuning

  const tune = async (next) => {
    key = next;
    shift = 0;
    store.set(LAST, key);
    history.replaceState(null, '', `${SECTION}?ch=${encodeURIComponent(key)}`);
    channelName.textContent = labelOf.get(key) || key;
    markGuide();
    const got = await api(`/api/library/tv?ch=${encodeURIComponent(key)}`);
    if (!alive || key !== next) return;
    if (!got.scenes.length) {
      overlay.replaceChildren(el('div', { className: 'tvchannel' }, got.label), el('div', {}, 'Nothing to play.'));
      overlay.hidden = false;
      return;
    }
    lineup = got;
    skew = got.now - Date.now();
    at = -1;
    const here = spot();
    play(here.i, here.offset);
  };

  const step = (by) => {
    const i = order.findIndex((c) => c.key === key);
    tune(order[(i + by + order.length) % order.length].key).catch(() => {});
  };

  // Back on schedule when the page returns, when the day rolls over, or when
  // buffering has left it well behind.
  const resync = () => {
    if (!lineup) return;
    if (Math.floor((Date.now() + skew) / 86400000) !== lineup.day) { tune(key).catch(() => {}); return; }
    const here = spot();
    const video = videos[active];
    if (here.i !== at) { play(here.i, here.offset); return; }
    if (Math.abs((video.currentTime || 0) - here.offset) > DRIFT) video.currentTime = here.offset;
    // A hidden tab pauses video; live TV carries on when you come back.
    if (video.paused && video.getAttribute('src')) video.play().catch(() => {});
  };
  const checker = setInterval(resync, 30000);
  const ticker = setInterval(() => { if (!document.hidden) drawUpNext(); }, 60000);
  const onVisible = () => { if (!document.hidden) resync(); };
  document.addEventListener('visibilitychange', onVisible);

  // ------------------------------------------------------------------ input

  const enableSound = () => {
    if (sound) return;
    sound = true;
    hint.hidden = true;
    videos[active].muted = false;
  };

  const fullscreen = () => {
    const on = document.fullscreenElement || document.webkitFullscreenElement;
    if (on) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    else videos[active].webkitEnterFullscreen?.();
  };

  const onKey = (e) => {
    enableSound();
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight' || e.key === 'n') { e.preventDefault(); jumpTo(1); }
    else if (e.key === 'f') fullscreen();
    else if (e.key === 'i' || e.key === ' ') { e.preventDefault(); showOverlay(); }
  };
  const onPointer = () => enableSound();

  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer);
  stage.onclick = showOverlay;
  up.onclick = () => step(1);
  down.onclick = () => step(-1);
  skip.onclick = () => jumpTo(1);
  backLive.onclick = () => tune(key).catch(() => {});
  full.onclick = fullscreen;

  onTeardown(() => {
    alive = false;
    clearInterval(checker);
    clearInterval(ticker);
    clearTimeout(overlayTimer);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onPointer);
    videos.forEach(unload);
  });

  shell(SECTION, el('div', { className: 'tv' }, stage, bar, info, upNext, guide));
  tune(key).catch((err) => {
    overlay.replaceChildren(el('div', {}, err.message));
    overlay.hidden = false;
  });
}
