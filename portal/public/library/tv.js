import { api, clock, el } from '../util.js';
import { claim, holds, loadingIn, onTeardown, shell } from './core.js';

/*
 * TV: pick a channel and filed scenes play back to back, live.
 *
 * The server hands over the day's lineup and when it started (see tv.mjs);
 * what is on is worked out from the clock, so tuning in joins a scene
 * part-way and every device agrees. No scrubbing: it is live.
 *
 * Sound starts off and the first tap or key anywhere turns it on for the
 * rest of the visit. Plays and resume points are not recorded.
 */

const SECTION = '#/library/tv';
const OVERLAY_MS = 5000;
// How far behind live the picture may fall (buffering) before it jumps back.
const DRIFT = 20;
const LAST = 'tv.channel';

let sound = false;

const remember = (key) => { try { localStorage.setItem(LAST, key); } catch {} };
const recall = () => { try { return localStorage.getItem(LAST); } catch { return null; } };

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

  // One flat order for channel up/down, grouped the same way as the picker.
  const groups = [
    ['Categories', list.categories],
    ['Studios', list.studios],
    ['Performers', list.performers],
    ['Tags', list.tags],
  ];
  const order = [list.random, ...groups.flatMap(([, g]) => g)];
  const labelOf = new Map(order.map((c) => [c.key, c.label]));

  const asked = new URLSearchParams(query).get('ch');
  let key = [asked, recall()].find((k) => k && labelOf.has(k)) || 'random';

  // ---------------------------------------------------------------- the page

  const videos = [0, 1].map(() => el('video', { className: 'tvvideo', playsInline: true, muted: true, preload: 'auto' }));
  const overlay = el('div', { className: 'tvoverlay', hidden: true });
  const hint = el('div', { className: 'tvhint', hidden: sound }, 'Tap for sound');
  const stage = el('div', { className: 'tvstage' }, ...videos, overlay, hint);

  const picker = el('select', { className: 'tvpick', title: 'Channel' },
    el('option', { value: list.random.key }, `${list.random.label} (${list.random.count})`),
    ...groups.filter(([, g]) => g.length).map(([name, g]) =>
      el('optgroup', { label: name },
        ...g.map((c) => el('option', { value: c.key }, `${c.label} (${c.count})`))))
  );

  const down = el('button', { className: 'chip', type: 'button', title: 'Previous channel (↓)' }, '▼');
  const up = el('button', { className: 'chip', type: 'button', title: 'Next channel (↑)' }, '▲');
  const full = el('button', { className: 'chip', type: 'button', title: 'Fullscreen (f)' }, 'Fullscreen');
  const bar = el('div', { className: 'tvbar' }, down, picker, up, el('span', { className: 'spacer' }), full);

  // ---------------------------------------------------------------- playback

  let lineup = null;
  let skew = 0;          // server clock minus ours
  let at = -1;           // index in the lineup of what is on
  let active = 0;        // which of the two videos is showing
  let alive = true;
  let overlayTimer = null;
  const now = () => Date.now() + skew;

  // Where the lineup is at this moment: which scene, and how far into it.
  const live = () => {
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

  const showOverlay = () => {
    if (!lineup || at < 0) return;
    const scene = lineup.scenes[at];
    const next = lineup.scenes[(at + 1) % lineup.scenes.length];
    const left = Math.max(0, scene.duration - (videos[active].currentTime || 0));
    overlay.replaceChildren(
      el('div', { className: 'tvchannel' }, lineup.label),
      el('div', { className: 'tvnow' }, scene.title),
      el('div', { className: 'muted small' },
        [scene.studio, scene.performers.slice(0, 3).join(', ')].filter(Boolean).join(' · ')),
      el('div', { className: 'muted small' }, `${clock(Math.round(left))} left · Next: ${next.title}`)
    );
    overlay.hidden = false;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => { overlay.hidden = true; }, OVERLAY_MS);
  };

  // Put scene `i` on at `offset` seconds, in whichever video is free.
  const play = (i, offset) => {
    const scene = lineup.scenes[i];
    const next = videos[1 - active];
    const was = videos[active];

    const start = () => {
      if (offset > 1) next.currentTime = offset;
      next.muted = !sound;
      next.play().catch(() => {});
    };
    const url = `/media/scene/${scene.id}/stream`;
    next.onerror = () => { if (alive && at === i) setTimeout(() => alive && advance(), 2000); };
    // Already loading from the preload below: start it rather than reload.
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
    showOverlay();
  };

  // The scene ended (or failed): go to what is on now, or the next one if
  // the clock still says this one.
  const advance = () => {
    const spot = live();
    if (spot.i === at) play((at + 1) % lineup.scenes.length, 0);
    else play(spot.i, spot.offset);
  };

  // Near the end, load the next scene into the spare video so the change is quick.
  const PRELOAD = 20;
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

  const tune = async (next) => {
    key = next;
    picker.value = key;
    remember(key);
    history.replaceState(null, '', `${SECTION}?ch=${encodeURIComponent(key)}`);
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
    const spot = live();
    play(spot.i, spot.offset);
  };

  const step = (by) => {
    const i = order.findIndex((c) => c.key === key);
    tune(order[(i + by + order.length) % order.length].key).catch(() => {});
  };

  // Back to live when the page returns, when the day rolls over, or when
  // buffering has left it well behind.
  const resync = () => {
    if (!lineup) return;
    if (Math.floor(now() / 86400000) !== lineup.day) { tune(key).catch(() => {}); return; }
    const spot = live();
    const video = videos[active];
    if (spot.i !== at) { play(spot.i, spot.offset); return; }
    if (Math.abs((video.currentTime || 0) - spot.offset) > DRIFT) video.currentTime = spot.offset;
    // A hidden tab pauses video; live TV carries on when you come back.
    if (video.paused && video.getAttribute('src')) video.play().catch(() => {});
  };
  const checker = setInterval(resync, 30000);
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
    if (e.target.closest?.('input, select, textarea')) { enableSound(); return; }
    enableSound();
    if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
    else if (e.key === 'f') fullscreen();
    else if (e.key === 'i' || e.key === ' ') { e.preventDefault(); showOverlay(); }
  };
  const onPointer = () => enableSound();

  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer);
  stage.onclick = showOverlay;
  picker.onchange = () => tune(picker.value).catch(() => {});
  up.onclick = () => step(1);
  down.onclick = () => step(-1);
  full.onclick = fullscreen;

  onTeardown(() => {
    alive = false;
    clearInterval(checker);
    clearTimeout(overlayTimer);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onPointer);
    videos.forEach(unload);
  });

  shell(SECTION, el('div', { className: 'tv' }, stage, bar));
  tune(key).catch((err) => {
    overlay.replaceChildren(el('div', {}, err.message));
    overlay.hidden = false;
  });
}
