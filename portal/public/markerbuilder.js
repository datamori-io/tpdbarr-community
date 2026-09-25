/*
 * Marker Builder, modelled on LosslessCut: the picture on top, a filmstrip
 * timeline under it, and the keyboard. `t` drops a point, `i`/`o` bracket a
 * span, arrows move the playhead; each ends by asking for a tag, and nothing
 * is written until it's answered.
 *
 * The strip is Stash's sprite sheet laid along time (one image request), so
 * it scrolls without asking the video. The playhead stays still; the strip
 * moves under it.
 */

import { api, el } from './util.js';
import { thumbnailCues } from './player.js';
import { askTag, palette, remember, stamp } from './markertag.js';
import { timestamps } from './markerfetch.js';
import { SCENE_FACETS, SCENE_SORTS, orderScenes, shelfScenes } from './library/shelves.js';
import { shelfPage, tile } from './library/tiles.js';

/*
 * Cleanup for the video and window keydown listener. app.js calls this on
 * every address change, as it does for the reel.
 */
let teardown = null;

export function leave() {
  if (!teardown) return;
  const stop = teardown;
  teardown = null;
  stop();
}

/*
 * ------------------------------------------------------------------- times
 *
 * `stamp` lives in markertag.js.
 */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/*
 * ------------------------------------------------------------------- steps
 *
 * Arrow step: bare for placing, shift for finding, alt for fine nudges.
 */
const STEP = 1;
const STEP_BIG = 10;
/* No touch equivalent needed: a pixel of drag at the closest zoom is finer. */
const STEP_FINE = 0.1;

/* Zoom levels, in pixels per second. */
const ZOOMS = [2, 4, 8, 16, 32, 60, 120];
const ZOOM_START = 3;

// How tall the filmstrip is. Tiles are scaled to it and keep their own shape.
const STRIP_H = 64;

/*
 * ---------------------------------------------------------------- the queue
 *
 * Which scene to work on: the library's own shelf (same filters, facets,
 * sorts and tiles), plus a Marked-or-not facet, unmarked by default. One
 * small request adds which scenes the bench accepts and which are marked.
 * See queued() in markerbuilder.mjs.
 */

/*
 * The shelf's filters when a scene was picked, handed back on the way out
 * (the bench's `scene=` replaces them in the address).
 */
let shelfWas = '';

const MARKS_NONE = 'Nothing marked';
const MARKS_SOME = 'Has markers';

/* The library's facets, plus Marked-or-not first. */
const MARKER_FACETS = [
  { key: 'marks', any: 'Marked or not', of: (s) => [s.marks] },
  ...SCENE_FACETS,
];

export async function picker(body, { params, go }) {
  const head = el('div', { className: 'mbtoolbar' });
  const list = el('div', {}, el('div', { className: 'empty' }, 'Reading the library…'));
  body.replaceChildren(head, list);

  let scenes;
  let queue;
  try {
    [scenes, queue] = await Promise.all([
      shelfScenes(),
      api('/api/import/markers/queue'),
    ]);
  } catch (err) {
    list.replaceChildren(el('div', { className: 'empty' }, err.message));
    return;
  }

  /* Filed only (see markerbuilder.mjs); the rest of the shelf is dropped here. */
  const filed = new Set(queue.filed || []);
  const counted = new Map((queue.marked || []).map(([id, n]) => [id, n]));

  const items = scenes
    .filter((scene) => filed.has(String(scene.id)))
    .map((scene) => {
      const markers = counted.get(String(scene.id)) || 0;
      return { ...scene, markers, marks: markers ? MARKS_SOME : MARKS_NONE };
    });

  if (!items.length) {
    list.replaceChildren(el('div', { className: 'empty' },
      'Nothing filed yet — the bench only marks scenes that have stopped moving.'));
    return;
  }

  /* The library's tile, re-pointed at the bench. */
  const benchTile = (scene) => {
    const node = tile(scene);
    node.onclick = () => {
      // Read off the address rather than off shelfPage's state: the address is
      // what it writes, and it is already exactly what would restore this.
      shelfWas = location.hash.split('?')[1] || '';
      go(new URLSearchParams({ scene: scene.id }));
    };

    /* Marker count on the art; nothing when there are none. */
    if (scene.markers) {
      const marks = node.querySelector('.tilemarks');
      const pill = el('span', {
        className: 'pill done',
        title: `${scene.markers} marker${scene.markers === 1 ? '' : 's'} on this scene`,
      }, `${scene.markers} ✓`);
      if (marks) marks.append(pill);
      else node.querySelector('.tileart').append(el('div', { className: 'tilemarks' }, pill));
    }

    return node;
  };

  /*
   * The address is the state. Seed the backlog only when it says nothing;
   * an explicit `marks` (even empty) is kept.
   */
  const query = params.toString() || shelfWas;
  const seeded = query || new URLSearchParams({ marks: MARKS_NONE }).toString();

  const page = shelfPage({
    section: '#/catalogue/markers',
    title: 'Marker Builder',
    note: 'filed and markable',
    placeholder: 'Find a scene by title, performer or studio…',
    items,
    facets: MARKER_FACETS,
    sorts: SCENE_SORTS,
    order: orderScenes,
    card: benchTile,
    query: seeded,
  });

  /* Drop shelfPage's own heading; keep its count line. */
  const [feedhead, ...rest] = page;
  const note = feedhead.querySelector('.muted');

  /* Link to the marker management page. */
  const manage = el('button', { className: 'chip', type: 'button' }, 'Manage markers');
  manage.onclick = () => {
    shelfWas = location.hash.split('?')[1] || '';
    go(new URLSearchParams({ manage: '1' }));
  };

  head.replaceChildren(note || feedhead, el('div', { className: 'vgap' }), manage);
  list.replaceChildren(...rest);
}

// Where the picker was when it was left. The management page hands it back the
// same way the bench does.
export const lastShelf = () => shelfWas;

/* --------------------------------------------------------------- the bench */

export async function editor(body, { sceneId, go }) {
  // Belt and braces: the router stands the last one down on its way here, but
  // two benches sharing a window keydown listener is not a state worth risking.
  leave();

  body.replaceChildren(el('div', { className: 'empty' }, 'Opening the scene…'));

  let loaded;

  try {
    // Warm the tag palette alongside the scene.
    palette();
    loaded = await api(`/api/import/markers/scene/${sceneId}`);
  } catch (err) {
    /* Refusals land here too, so show the way back with the reason. */
    const again = el('button', { className: 'link', type: 'button' }, '← pick another scene');
    again.onclick = () => go(new URLSearchParams(shelfWas));

    body.replaceChildren(el('div', { className: 'empty' }, err.message, el('div', {}, again)));
    return;
  }

  const scene = loaded.scene;
  let markers = loaded.markers.slice();

  /* ------------------------------------------------------------- the parts */

  const video = el('video', {
    className: 'mbvideo',
    src: `/media/scene/${scene.id}/stream`,
    preload: 'metadata',
    playsInline: true,
  });
  video.setAttribute('playsinline', '');

  const readout = el('div', { className: 'mbclock' }, '0:00.0');
  const lengthOut = el('span', { className: 'muted' }, '');
  /* The pending in point, as a button that drops it (Esc on a phone). */
  const pending = el('button', { className: 'mbpending', type: 'button', hidden: true });
  pending.onclick = () => clearIn();

  const ruler = el('div', { className: 'mbruler' });
  const tiles = el('div', { className: 'mbtiles' });
  const bands = el('div', { className: 'mbbands' });
  const track = el('div', { className: 'mbtrack' }, tiles, bands);
  const head = el('div', { className: 'mbhead' });
  const strip = el('div', { className: 'mbstrip', tabIndex: 0 }, ruler, track, head);
  strip.setAttribute('role', 'slider');
  strip.setAttribute('aria-label', 'Timeline');

  const listing = el('div', { className: 'mblist' });
  const said = el('div', { className: 'mbsaid', hidden: true });

  /*
   * -------------------------------------------------------------- the clock
   *
   * `at` is the truth and the video follows it, so the timeline can be nudged
   * by tenths and doesn't wait for seeks.
   */
  // Set false when this bench is stood down, so the timers and promises it
  // started stop writing into a page that is no longer on screen.
  let alive = true;

  let at = 0;
  let duration = scene.duration || 0;
  let zoom = ZOOMS[ZOOM_START];
  let cues = null;
  let sheetSize = null;

  // The seek that has not been asked for yet. See applySeek.
  let wanted = null;
  let drawing = false;

  const runtime = () =>
    (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration || 0);

  /* One seek in flight at a time; the newest wanted time waits for it. */
  let seekWatch = null;

  function applySeek() {
    if (wanted == null) return;

    /*
     * A seek that never lands (`seeking` stays true) is retried after half a
     * second, or every later seek would be dropped.
     */
    if (video.seeking) {
      if (!seekWatch) seekWatch = setTimeout(() => { seekWatch = null; applySeek(); }, 500);
      return;
    }

    if (seekWatch) { clearTimeout(seekWatch); seekWatch = null; }

    const target = wanted;
    wanted = null;
    if (Math.abs(video.currentTime - target) > 0.02) video.currentTime = target;
  }

  video.addEventListener('seeked', applySeek);

  /*
   * `settle: false` moves the strip without seeking — used during a drag,
   * seeked once at the end. Seeks are slow on x265 (keyframes up to 21s apart).
   */
  function goTo(seconds, { fromVideo = false, settle = true } = {}) {
    const total = runtime();
    at = total ? clamp(seconds, 0, total) : Math.max(0, seconds);
    if (!fromVideo && settle) {
      wanted = at;
      applySeek();
    }
    draw();
  }

  // Where the video should be once whatever is moving stops moving.
  const settle = () => {
    wanted = at;
    applySeek();
  };

  const nudge = (by) => goTo(at + by);

  /* ------------------------------------------------------------- the strip */

  /* Tiles are pooled: only visible slots are drawn, re-pointed as time passes. */
  const pool = [];

  const cueAt = (seconds) => {
    if (!cues || !cues.length) return null;
    let lo = 0;
    let hi = cues.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cues[mid].start <= seconds) lo = mid;
      else hi = mid - 1;
    }
    return cues[lo];
  };

  /* A tile's on-screen width at its own shape; tiles repeat rather than stretch. */
  const tileWidth = () => {
    const crop = cues?.[0]?.crop;
    if (!crop || !crop.h) return STRIP_H * (16 / 9);
    return Math.max(8, Math.round((crop.w / crop.h) * STRIP_H));
  };

  function drawTiles(originX, width) {
    if (!cues || !cues.length) {
      tiles.replaceChildren();
      return;
    }

    const tw = tileWidth();
    const first = Math.floor(originX / tw);
    const count = Math.ceil(width / tw) + 2;

    while (pool.length < count) {
      const node = el('div', { className: 'mbtile' });
      pool.push(node);
      tiles.append(node);
    }

    for (let i = 0; i < pool.length; i++) {
      const node = pool[i];
      if (i >= count) { node.hidden = true; continue; }

      // Slots are anchored to absolute pixel space, not to the window, so a
      // tile does not shuffle sideways under the playhead as time passes.
      const px = (first + i) * tw;
      const seconds = px / zoom;

      // Nothing before the start or after the end (the search would return cue 0).
      const cue = seconds >= 0 && seconds <= runtime() ? cueAt(seconds) : null;

      if (!cue) { node.hidden = true; continue; }

      node.hidden = false;
      node.style.width = tw + 'px';
      node.style.transform = `translateX(${px - originX}px)`;

      if (cue.crop && sheetSize) {
        const scale = STRIP_H / cue.crop.h;
        node.style.backgroundImage = `url("${cue.src}")`;
        node.style.backgroundSize = `${sheetSize.w * scale}px ${sheetSize.h * scale}px`;
        node.style.backgroundPosition = `-${cue.crop.x * scale}px -${cue.crop.y * scale}px`;
      } else {
        node.style.backgroundImage = `url("${cue.src}")`;
        node.style.backgroundSize = 'cover';
        node.style.backgroundPosition = 'center';
      }
    }
  }

  /* Tick spacing: the smallest round interval at least 80px apart. */
  const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

  function drawRuler(originX, width) {
    const every = TICKS.find((n) => n * zoom >= 80) || TICKS[TICKS.length - 1];
    const from = Math.floor(originX / zoom / every) * every;
    const total = runtime();

    const marks = [];
    for (let t = from; t * zoom < originX + width + every * zoom; t += every) {
      if (t < 0 || (total && t > total)) continue;
      marks.push(el('span', {
        className: 'mbtick',
        style: `transform: translateX(${t * zoom - originX}px)`,
      }, stamp(t, { tenths: false })));
    }

    ruler.replaceChildren(...marks);
  }

  function drawBands(originX) {
    const nodes = markers.map((m) => {
      const left = m.seconds * zoom - originX;
      const width = m.end ? Math.max(2, (m.end - m.seconds) * zoom) : 0;

      const node = el('div', {
        className: 'mbband' + (m.end ? ' span' : ' point'),
        style: `transform: translateX(${left}px)` + (m.end ? `; width: ${width}px` : ''),
        title: `${m.tag?.name || m.title || 'Marker'} — ${stamp(m.seconds)}${m.end ? ' → ' + stamp(m.end) : ''}`,
      }, el('span', { className: 'mbbandname' }, m.tag?.name || m.title || 'Marker'));

      node.onclick = (e) => { e.stopPropagation(); goTo(m.seconds); };
      return node;
    });

    // The in point waiting for its out. Drawn with the markers because it is
    // one — it just has no name and no end yet.
    if (inPoint != null) {
      const left = inPoint * zoom - originX;
      const width = Math.max(2, (at - inPoint) * zoom);
      nodes.push(el('div', {
        className: 'mbband open',
        style: `transform: translateX(${left}px); width: ${Math.max(2, width)}px`,
      }, el('span', { className: 'mbbandname' }, 'in…')));
    }

    bands.replaceChildren(...nodes);
  }

  function draw() {
    if (drawing) return;
    drawing = true;

    requestAnimationFrame(() => {
      drawing = false;

      const width = strip.clientWidth;
      if (!width) return;

      // The playhead is fixed mid-window.
      const originX = at * zoom - width / 2;

      drawRuler(originX, width);
      drawTiles(originX, width);
      drawBands(originX);

      readout.textContent = stamp(at);
      const total = runtime();
      lengthOut.textContent = total ? ` / ${stamp(total, { tenths: false })}` : '';

      pending.hidden = inPoint == null;
      // Says what closes it and, because it is the button that does it, what
      // pressing this drops.
      if (inPoint != null) pending.textContent = `in at ${stamp(inPoint)} — Out closes it · drop`;

      // The ladder does not move with the clock — only the frame the clock is
      // standing in does, so this is a class swap rather than a redraw.
      litNow();
    });
  }


  /*
   * ------------------------------------------------------------ the ladder
   *
   * Frames (`g`): the whole scene as frames, coarse at the top; click one to
   * open that stretch at ten times the detail. Clicking also seeks. Nothing
   * is fetched; it uses the strip's cues.
   *
   * Every rung is centred on the playhead, under the strip's own line, and
   * can be widened around where you are.
   */

  // Where the top rung stands, and how much finer each one below it is.
  const LADDER_TOP = 30;
  const LADDER_STEP = 10;
  /* Max top-row length; long films start with a coarser top rung. */
  const LADDER_MAX = 240;
  /* The finest rung: ten seconds. Below that, use the strip. */
  const LADDER_FLOOR = 10;

  // Frames are a fixed height for the same reason strip tiles are: the crop
  // has to be scaled by a number known before layout, not measured after it.
  const FRAME_H = 72;

  const grid = el('div', { className: 'mbgrid' });

  /*
   * The line rungs are read against, at 50% like the strip's playhead.
   * Outside the scroller so it doesn't scroll with it.
   */
  const guide = el('div', { className: 'mbgridhead' });
  const ladder = el('div', { className: 'mbladder', hidden: true }, grid, guide);

  // Open rungs, coarsest first. Each is the window a click in the rung above
  // opened; the first is always the whole scene.
  let rungs = [];
  /* Frames per rung, kept for the playhead highlight. */
  let rungFrames = [];
  let litFrames = [];
  // The scrolling row each rung was drawn into, for the centring below.
  let rungRows = [];
  let ladderOpen = false;
  /*
   * Set once the sheet request has answered, so an empty panel doesn't say
   * "loading" forever.
   */
  let sheetSettled = false;

  /* A row scrolled by hand is left alone for a few seconds. */
  const heldUntil = new WeakMap();
  const HELD_FOR = 2500;
  const held = (row) => (heldUntil.get(row) || 0) > Date.now();

  const floorStep = () => {
    const sheet = cues && cues.length > 1 ? cues[1].start - cues[0].start : 0;
    return Math.max(LADDER_FLOOR, sheet);
  };

  const topStep = () => {
    const total = runtime() || duration || 0;
    let step = Math.max(LADDER_TOP, floorStep());
    while (total && total / step > LADDER_MAX) step *= 2;
    return step;
  };

  // null once a rung is as fine as the ladder goes — those frames stop being
  // clickable rather than opening a row of the same stretch again.
  const nextStep = (step) => {
    const floor = floorStep();
    if (step <= floor * 1.5) return null;
    return Math.max(floor, step / LADDER_STEP);
  };

  const frameWidth = () => {
    const crop = cues?.[0]?.crop;
    if (!crop || !crop.h) return Math.round(FRAME_H * (16 / 9));
    return Math.max(16, Math.round((crop.w / crop.h) * FRAME_H));
  };

  function paintFrame(node, seconds) {
    const cue = cueAt(seconds);
    if (!cue) return;

    if (cue.crop && sheetSize) {
      const scale = FRAME_H / cue.crop.h;
      node.style.backgroundImage = `url("${cue.src}")`;
      node.style.backgroundSize = `${sheetSize.w * scale}px ${sheetSize.h * scale}px`;
      node.style.backgroundPosition = `-${cue.crop.x * scale}px -${cue.crop.y * scale}px`;
    } else {
      node.style.backgroundImage = `url("${cue.src}")`;
      node.style.backgroundSize = 'cover';
      node.style.backgroundPosition = 'center';
    }
  }

  /*
   * Clicking a frame drops the rungs below and opens a new one; the clicked
   * frame stays lit.
   */
  function openFrame(depth, start, step) {
    const finer = nextStep(step);
    rungs = rungs.slice(0, depth + 1);
    if (finer) rungs.push({ from: start, to: start + step, step: finer });
    goTo(start);
    renderLadder();
    /* Scroll the panel, not the page, to the new rung. */
    grid.scrollTop = grid.scrollHeight;
  }

  /*
   * Widen or narrow a rung around the playhead. Clamped to the scene and to
   * at least three frames. Rungs below go only if they no longer fit.
   */
  function widen(depth, by) {
    const rung = rungs[depth];
    if (!rung) return;

    const total = runtime() || duration || 0;
    const most = total || rung.to - rung.from;
    const span = clamp((rung.to - rung.from) * by, rung.step * 3, most);

    const middle = at >= rung.from && at <= rung.to ? at : (rung.from + rung.to) / 2;
    let from = Math.max(0, middle - span / 2);
    if (total && from + span > total) from = Math.max(0, total - span);

    rungs[depth] = { ...rung, from, to: from + span };

    const child = rungs[depth + 1];
    if (child && (child.from < from || child.to > from + span)) rungs = rungs.slice(0, depth + 1);

    renderLadder();
  }

  /* Put the playhead's frame under the line in a rung. `smooth` only while playing. */
  function centreRow(i, { smooth = false } = {}) {
    const row = rungRows[i];
    const node = litFrames[i];
    if (!row || !node || held(row)) return;

    /*
     * Measure against the line itself, not the row's middle: a scrollbar or
     * offsetLeft's positioned ancestor would put frames ~11px off.
     */
    const box = node.getBoundingClientRect();
    const line = guide.getBoundingClientRect();
    const want = row.scrollLeft + (box.left + box.width / 2) - (line.left + line.width / 2);
    if (Math.abs(row.scrollLeft - want) < 1) return;

    // Not every browser here honours the object form, and a row that fails to
    // scroll is worse than one that jumps.
    try {
      row.scrollTo({ left: want, behavior: smooth ? 'smooth' : 'auto' });
    } catch {
      row.scrollLeft = want;
    }
  }

  const centreAll = (opts) => {
    for (let i = 0; i < rungRows.length; i++) centreRow(i, opts);
  };

  function renderLadder() {
    if (!ladderOpen) return;

    const total = runtime() || duration || 0;
    if (!rungs.length && total) rungs = [{ from: 0, to: total, step: topStep() }];

    if (!cues || !cues.length || !total) {
      grid.replaceChildren(el('div', { className: 'empty' }, sheetSettled
        ? 'No sheet for this scene — Sharpen strip cuts one.'
        : 'No frames yet — the sheet is still loading.'));
      rungFrames = [];
      litFrames = [];
      rungRows = [];
      return;
    }

    const fw = frameWidth();
    rungFrames = [];
    litFrames = [];
    rungRows = [];

    const rows = rungs.map((rung, depth) => {
      const finer = nextStep(rung.step);
      const frames = [];
      const kept = [];

      for (let t = rung.from; t < rung.to - 0.001 && t < total; t += rung.step) {
        const node = el('div', {
          className: 'mbframe' + (finer ? '' : ' leaf'),
          style: `width: ${fw}px; height: ${FRAME_H}px`,
          title: stamp(t),
        }, el('span', { className: 'mbframetime' }, stamp(t, { tenths: rung.step < 1 })));

        paintFrame(node, t);

        const start = t;
        node.onclick = () => openFrame(depth, start, rung.step);

        // Lit when the rung under it is the one on screen, so the row above
        // always says which of its frames you drilled into.
        if (rungs[depth + 1] && Math.abs(rungs[depth + 1].from - start) < 0.001) node.classList.add('opened');

        frames.push(node);
        kept.push({ node, start, end: start + rung.step });
      }

      rungFrames.push(kept);

      const row = el('div', { className: 'mbframes' }, frames);

      // How wide its frames are, for the padding pass below — which cannot ask
      // the frames themselves, because a row with none still needs padding.
      row.dataset.frame = String(fw);

      // Hold the row after a wheel or pointer scroll.
      const hold = () => heldUntil.set(row, Date.now() + HELD_FOR);
      row.addEventListener('pointerdown', hold);
      row.addEventListener('wheel', hold, { passive: true });

      rungRows.push(row);

      const span = `${stamp(rung.from, { tenths: false })} → ${stamp(Math.min(rung.to, total), { tenths: false })}`;
      const whole = rung.from <= 0 && rung.to >= total;

      const wider = el('button', { className: 'mbspan', type: 'button', title: 'Show twice as much, around the playhead' }, '＋');
      const tighter = el('button', { className: 'mbspan', type: 'button', title: 'Show half as much, around the playhead' }, '－');
      wider.onclick = () => widen(depth, 2);
      tighter.onclick = () => widen(depth, 0.5);
      wider.disabled = whole;
      tighter.disabled = rung.to - rung.from <= rung.step * 3;

      return el('div', { className: 'mbrung' },
        el('div', { className: 'mbrunghead muted small' },
          el('strong', {}, `every ${rung.step < 1 ? rung.step.toFixed(1) : Math.round(rung.step)}s`),
          ' · ', whole ? 'whole scene' : span,
          finer ? '' : ' · as fine as the ladder goes',
          el('span', { className: 'vgap' }),
          el('span', { className: 'mbspans' }, tighter, wider)),
        row);
    });

    grid.replaceChildren(...rows);
    litNow();
    layoutRows();
  }

  /*
   * Pad and centre rows once they can be measured. Synchronous, not rAF:
   * rAF doesn't fire in a background tab, leaving rows off-centre. Padding
   * lets the first and last frames reach the middle.
   */
  function layoutRows() {
    for (let i = 0; i < rungRows.length; i++) {
      const row = rungRows[i];
      const fw = Number(row.dataset.frame) || 0;
      const pad = Math.max(0, Math.round((row.clientWidth - fw) / 2));
      row.style.paddingLeft = `${pad}px`;
      row.style.paddingRight = `${pad}px`;
      centreRow(i);
    }
  }

  /* The playhead's frame per rung, by class swap. */
  function litNow() {
    for (let i = 0; i < rungFrames.length; i++) {
      const found = rungFrames[i].find((f) => at >= f.start && at < f.end);
      const node = found?.node || null;
      if (node === litFrames[i]) continue;
      if (litFrames[i]) litFrames[i].classList.remove('now');
      if (node) node.classList.add('now');
      litFrames[i] = node;
      // Only when it changes: centring on every frame of a playing video is a
      // scroll animation restarted sixty times a second.
      centreRow(i, { smooth: true });
    }
  }

  /* The sheet changed: back to the top rung. */
  function resetLadder({ settled = true } = {}) {
    if (settled) sheetSettled = true;
    rungs = [];
    renderLadder();
  }

  function toggleLadder() {
    ladderOpen = !ladderOpen;
    ladder.hidden = !ladderOpen;
    gridBtn.classList.toggle('on', ladderOpen);
    if (ladderOpen) renderLadder();
    else grid.replaceChildren();
  }
  /*
   * --------------------------------------------------------------- the tags
   *
   * The prompt is markertag.js. Appended to the bench so the router removes
   * it; the strip gets the keyboard back after.
   */

  const ask = async ({ seconds, end = null }) => {
    const chosen = await askTag({ seconds, end, host: body });
    strip.focus();
    return chosen;
  };


  /* ------------------------------------------------------------- the writes */

  const note = (text, bad = false) => {
    said.textContent = text;
    said.hidden = !text;
    said.className = 'mbsaid' + (bad ? ' bad' : '');
  };

  async function place({ seconds, end = null }) {
    const chosen = await ask({ seconds, end });
    if (!chosen) { note('Thrown away.'); return; }

    note('Writing…');

    try {
      const { marker } = await api(`/api/import/markers/scene/${scene.id}`, {
        method: 'POST',
        body: JSON.stringify({ seconds, end, ...chosen }),
      });

      markers = [...markers, marker].sort((a, b) => a.seconds - b.seconds);

      /* A new tag joins the palette immediately. */
      remember(marker.tag);

      note(`${marker.tag?.name || 'Marker'} at ${stamp(marker.seconds)}${marker.end ? ' → ' + stamp(marker.end) : ''}.`);
      renderList();
      draw();
    } catch (err) {
      note(err.message, true);
    }
  }

  async function remove(marker) {
    note('Removing…');
    try {
      await api(`/api/import/markers/marker/${marker.id}`, { method: 'DELETE' });
      markers = markers.filter((m) => m.id !== marker.id);
      note('Removed.');
      renderList();
      draw();
    } catch (err) {
      note(err.message, true);
    }
  }

  async function retag(marker) {
    const chosen = await ask({ seconds: marker.seconds, end: marker.end });
    if (!chosen) return;

    note('Writing…');
    try {
      const { marker: saved } = await api(`/api/import/markers/marker/${marker.id}`, {
        method: 'POST',
        body: JSON.stringify(chosen),
      });
      markers = markers.map((m) => (m.id === saved.id ? saved : m));
      note(`Now ${saved.tag?.name || 'untagged'}.`);
      renderList();
      draw();
    } catch (err) {
      note(err.message, true);
    }
  }

  /* --------------------------------------------------------------- the list */

  function renderList() {
    if (!markers.length) {
      listing.replaceChildren(el('div', { className: 'empty small' },
        'No markers on this scene yet. Find a moment and press t.'));
      return;
    }

    listing.replaceChildren(
      el('div', { className: 'feedhead' },
        el('h3', {}, `${markers.length} marker${markers.length === 1 ? '' : 's'}`),
        el('span', { className: 'muted' }, 'click a time to jump to it')),
      el('div', { className: 'mbmarkers' }, markers.map((m) => {
        const jump = el('button', { className: 'link mbtime', type: 'button' },
          stamp(m.seconds) + (m.end ? ` → ${stamp(m.end)}` : ''));
        jump.onclick = () => goTo(m.seconds);

        const name = el('button', { className: 'chip', type: 'button' }, m.tag?.name || m.title || 'Marker');
        name.title = 'Change the tag';
        name.onclick = () => retag(m);

        const drop = el('button', { className: 'mbdrop', type: 'button', title: 'Remove this marker' }, '×');
        drop.onclick = () => remove(m);

        return el('div', { className: 'mbmarker' + (m.end ? ' span' : '') },
          jump,
          name,
          /*
           * The plugins sign their titles ([Timestamp], [TsTrade], [TPDBMarker]);
           * hand-cut markers have none. Shown only when it differs from the tag.
           */
          m.title && m.title !== (m.tag?.name || '')
            ? el('span', { className: 'muted small' }, m.title)
            : null,
          drop);
      }))
    );
  }

  /*
   * ----------------------------------------------------------- the actions
   *
   * Keys and transport buttons call the same functions.
   */

  let inPoint = null;
  let asking = false;

  function setIn() {
    inPoint = at;
    note(`In at ${stamp(at)} — Out closes it.`);
    draw();
  }

  function clearIn() {
    if (inPoint == null) return;
    inPoint = null;
    note('In point dropped.');
    draw();
  }

  function playPause() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  /* `kind` is 'point' or 'out'. Out with no in point just says so. */
  async function cut(kind) {
    // The guard lives here rather than only in the key handler, because a
    // button is just as able to fire while the prompt is open.
    if (asking) return;

    if (kind === 'out' && inPoint == null) { note('No in point yet — set In first.', true); return; }

    const seconds = kind === 'point' ? at : Math.min(inPoint, at);
    const end = kind === 'point' ? null : Math.max(inPoint, at);
    inPoint = null;
    draw();

    // Held while the panel is open so the keys underneath do not also fire,
    // and cleared however the prompt ends — including when it is thrown away.
    asking = true;
    try {
      await place({ seconds, end: end != null && end > seconds ? end : null });
    } finally {
      asking = false;
    }
  }

  /* ----------------------------------------------------------- the keyboard */

  const KEYS = new Set(['t', 'i', 'o', 'g', 'ArrowLeft', 'ArrowRight', ' ', 'Escape', '+', '=', '-', '_']);

  async function onKey(e) {
    // A prompt has the keyboard while it is open, and so does anything the
    // user is typing into. Otherwise `t` in the search box would drop markers.
    if (asking) return;

    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (!KEYS.has(e.key)) return;
    if (e.ctrlKey || e.metaKey) return;

    e.preventDefault();

    const step = e.altKey ? STEP_FINE : e.shiftKey ? STEP_BIG : STEP;

    if (e.key === 'ArrowLeft') return nudge(-step);
    if (e.key === 'ArrowRight') return nudge(step);

    if (e.key === ' ') return playPause();

    if (e.key === '+' || e.key === '=') return setZoom(1);
    if (e.key === '-' || e.key === '_') return setZoom(-1);

    if (e.key === 'g') return toggleLadder();

    if (e.key === 'Escape') return clearIn();
    if (e.key === 'i') return setIn();
    if (e.key === 't') return cut('point');
    if (e.key === 'o') return cut('out');
  }

  /* ------------------------------------------------------------- the mouse */

  function setZoom(by) {
    const i = clamp(ZOOMS.indexOf(zoom) + by, 0, ZOOMS.length - 1);
    zoom = ZOOMS[i];
    draw();
  }

  /* The wheel scrubs. Not passive, so the page doesn't scroll. */
  strip.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) { setZoom(e.deltaY > 0 ? -1 : 1); return; }
    const by = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / zoom;
    goTo(at + by);
  }, { passive: false });

  let dragging = false;
  let dragFrom = 0;
  let dragAt = 0;

  /*
   * Pinch zoom, handled here because `touch-action: none` disables the
   * browser's. A pinch must change the finger span by a quarter to move one
   * zoom step.
   */
  const touching = new Map();
  const PINCH_STEP = 1.25;
  let pinchFrom = 0;

  const spread = () => {
    const [a, b] = [...touching.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  strip.addEventListener('pointerdown', (e) => {
    // A click on a band is that band's business — it seeks to its own start.
    if (e.target.closest('.mbband')) return;

    /*
     * Only touch pointers count toward a pinch; a stray mouse pointer left a
     * phantom second finger.
     */
    if (e.pointerType === 'touch') touching.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touching.size === 2) {
      // A second finger ends the drag the first one started: you have stopped
      // aiming at a time and started changing the scale.
      dragging = false;
      pinchFrom = spread();
      return;
    }

    dragging = true;
    dragFrom = e.clientX;
    dragAt = at;
    // Guarded because a pointer that is already gone — or a synthetic one —
    // throws here, and that would take the rest of this handler with it.
    try { strip.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    /* preventScroll, or a tablet scrolls the video away. */
    try { strip.focus({ preventScroll: true }); } catch { strip.focus(); }
  });

  strip.addEventListener('pointermove', (e) => {
    if (touching.has(e.pointerId)) touching.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (touching.size === 2) {
      const now = spread();
      if (!pinchFrom || !now) return;

      if (now / pinchFrom > PINCH_STEP) { setZoom(1); pinchFrom = now; }
      else if (pinchFrom / now > PINCH_STEP) { setZoom(-1); pinchFrom = now; }
      return;
    }

    if (!dragging) return;
    goTo(dragAt - (e.clientX - dragFrom) / zoom, { settle: false });
  });

  const endDrag = (e) => {
    touching.delete(e.pointerId);
    if (touching.size < 2) pinchFrom = 0;

    if (!dragging) return;
    dragging = false;
    try { strip.releasePointerCapture(e.pointerId); } catch { /* already gone */ }

    // The one seek the whole drag was worth. See goTo.
    settle();
  };

  strip.addEventListener('pointerup', endDrag);
  strip.addEventListener('pointercancel', endDrag);

  /* --------------------------------------------------------- the video side */

  video.addEventListener('loadedmetadata', () => {
    if (!duration && Number.isFinite(video.duration)) duration = Math.round(video.duration);
    draw();
  });

  /*
   * Playing: the video leads, drawn off a frame loop (`timeupdate` is too
   * coarse). Paused: the strip leads.
   */
  let following = null;

  const follow = () => {
    if (video.paused) { following = null; return; }
    /* Not while dragging, or the strip and video fight over the clock. */
    if (!dragging) goTo(video.currentTime, { fromVideo: true });
    following = requestAnimationFrame(follow);
  };

  video.addEventListener('play', () => { if (!following) following = requestAnimationFrame(follow); });
  video.addEventListener('pause', () => { if (following) cancelAnimationFrame(following); following = null; });

  /* ----------------------------------------------------------------- paint */

  const back = el('button', { className: 'link', type: 'button' }, '← another scene');
  back.onclick = () => go(new URLSearchParams(shelfWas));

  /* The frame ladder toggle. Off by default. */
  const gridBtn = el('button', { className: 'chip', type: 'button', title: 'Frame ladder (g)' }, 'Frames');
  gridBtn.onclick = () => toggleLadder();

  /*
   * What timestamp.trade and ThePornDB have (see markerfetch.js). Opens a
   * panel; nothing is imported.
   */
  const fetchBtn = el('button', {
    className: 'chip mffetch',
    type: 'button',
    title: 'What timestamp.trade and ThePornDB have for this scene',
  }, 'Timestamps');

  fetchBtn.onclick = () => {
    // One panel. Pressing it again with one open is somebody asking to start
    // over, so the old one goes rather than a second appearing beneath it.
    body.querySelector('.mfpanel')?.remove();

    timestamps(body, {
      sceneId: scene.id,
      markers,
      goTo: (seconds) => goTo(seconds),
      note,
      done: ({ added = [], changed = [] }) => {
        const swapped = new Map(changed.map((m) => [String(m.id), m]));
        markers = [...markers.map((m) => swapped.get(String(m.id)) || m), ...added]
          .sort((a, b) => a.seconds - b.seconds);
        renderList();
        draw();
      },
    });
  };

  const zoomOut = el('button', { className: 'chip', type: 'button', title: 'Zoom out (−)' }, '−');
  const zoomIn = el('button', { className: 'chip', type: 'button', title: 'Zoom in (+)' }, '+');
  zoomOut.onclick = () => setZoom(-1);
  zoomIn.onclick = () => setZoom(1);

  /*
   * ------------------------------------------------------- sharpening it
   *
   * One control, three states: no sharp strip, cutting, have one.
   */

  const stripBtn = el('button', { className: 'chip mbsharpen', type: 'button' }, 'Sharpen strip');

  /* Re-cut in one press. Overwrites; the old strip works until the new one lands. */
  const regenBtn = el('button', {
    className: 'chip mbregen',
    type: 'button',
    title: 'Generate sprites — replaces any strip this scene already has',
  }, '⟳');
  regenBtn.setAttribute('aria-label', 'Generate sprites, replacing any existing strip');

  let stripPoll = null;

  const stopStripPoll = () => {
    if (stripPoll) clearTimeout(stripPoll);
    stripPoll = null;
  };

  function renderStripBtn(found) {
    // Nothing to press while the encoder is busy, whoever has it: one cut at a
    // time is the server's rule and the button should not offer to break it.
    regenBtn.disabled = Boolean(found.building || found.busyWith);
    regenBtn.classList.toggle('working', Boolean(found.building));

    if (found.building) {
      const { done = 0, total = 0 } = found.progress || {};
      stripBtn.textContent = total ? `Cutting… ${done}/${total}` : 'Cutting…';
      stripBtn.className = 'chip mbsharpen working';
      stripBtn.disabled = true;
      stripBtn.title = 'Decoding the whole file at about 2% of realtime.';
      return;
    }

    stripBtn.disabled = false;

    if (found.strip) {
      stripBtn.textContent = `${found.strip.interval}s strip`;
      stripBtn.className = 'chip mbsharpen have';
      stripBtn.title = `${found.strip.tiles.toLocaleString()} frames across ${found.strip.sheets} sheets, cut from the source. Click to throw it away.`;
      return;
    }

    stripBtn.textContent = 'Sharpen strip';
    stripBtn.className = 'chip mbsharpen';
    stripBtn.title = found.busyWith
      ? `Busy cutting scene ${found.busyWith} — one at a time.`
      : "Cut a picture a second from the source. Stash's own is one every 17 seconds or so.";
  }

  /* The button shows progress while a cut runs; polled every three seconds. */
  function pollStrip() {
    stopStripPoll();

    stripPoll = setTimeout(async () => {
      // The bench this poll belongs to may be long gone; the timer outlives
      // the page it was started from.
      if (!alive) return;

      try {
        const found = await api(`/api/import/markers/scene/${scene.id}/strip`);
        await stripState(found);
        if (found.building) pollStrip();
        else if (found.error) note(found.error, true);
        else if (found.strip) note(`Strip sharpened — a frame every ${found.strip.interval}s.`);
      } catch {
        // A poll that fails is not worth a message; the next open will say.
      }
    }, 3000);
  }

  /* Cut. Confirms only when there's a strip to lose. */
  const cutStrip = async ({ replacing = false } = {}) => {
    const warning = 'Cut this scene’s sprite strip again? The one it has now is replaced when the new one lands.';
    if (replacing && !window.confirm(warning)) return;

    note('Cutting a frame a second from the source — about a minute for half an hour of video.');

    try {
      const started = await api(`/api/import/markers/scene/${scene.id}/strip`, { method: 'POST' });
      renderStripBtn(started);
      pollStrip();
    } catch (err) {
      note(err.message, true);
    }
  };

  regenBtn.onclick = async () => {
    const found = await api(`/api/import/markers/scene/${scene.id}/strip`).catch(() => null);
    await cutStrip({ replacing: Boolean(found?.strip) });
  };

  stripBtn.onclick = async () => {
    const found = await api(`/api/import/markers/scene/${scene.id}/strip`).catch(() => null);

    if (found?.strip) {
      if (!window.confirm('Throw away this scene\'s sharpened strip? It takes about a minute to cut again.')) return;
      const gone = await api(`/api/import/markers/scene/${scene.id}/strip`, { method: 'DELETE' }).catch(() => null);
      if (!gone) return;
      sharper = false;
      cues = null;
      sheetSize = null;
      renderStripBtn(gone);
      loadStash();
      note('Back to Stash\'s own strip.');
      return;
    }

    await cutStrip();
  };

  /*
   * The transport: a button for every key (the letter shown as a badge,
   * hidden on touch). Nudges are fixed amounts.
   */
  const badge = (letter) => el('kbd', { className: 'mbbadge' }, letter);

  const action = (label, letter, run) => {
    const node = el('button', { className: 'mbact', type: 'button' }, label, badge(letter));
    node.onclick = run;
    return node;
  };

  const nudger = (by, label) => {
    const node = el('button', { className: 'mbnudge', type: 'button' }, label);
    node.setAttribute('aria-label', `${by > 0 ? 'Forward' : 'Back'} ${Math.abs(by)} seconds`);
    node.onclick = () => nudge(by);
    return node;
  };

  const playBtn = el('button', { className: 'mbnudge mbplay', type: 'button' }, '▶');
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.onclick = playPause;

  const showPlaying = () => {
    playBtn.textContent = video.paused ? '▶' : '❚❚';
    playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
  };

  video.addEventListener('play', showPlaying);
  video.addEventListener('pause', showPlaying);

  // Tapping the picture is what everybody tries first, and on a phone the
  // transport is below the fold as often as not.
  video.addEventListener('click', playPause);

  const transport = el('div', { className: 'mbtransport' },
    el('div', { className: 'mbnudges' },
      nudger(-STEP_BIG, '−10s'),
      nudger(-STEP, '−1s'),
      playBtn,
      nudger(STEP, '+1s'),
      nudger(STEP_BIG, '+10s')),
    el('div', { className: 'mbacts' },
      action('Point', 't', () => cut('point')),
      action('In', 'i', setIn),
      action('Out', 'o', () => cut('out')))
  );

  // What the buttons cannot say: the modifiers, which have no touch equivalent
  // and are hidden along with the rest of this row on a phone.
  const keyhint = el('div', { className: 'mbkeys muted small' },
    el('kbd', {}, '←'), el('kbd', {}, '→'), ' 1s, shift 10s, alt 0.1s · ',
    el('kbd', {}, 'space'), ' play · ',
    el('kbd', {}, 'g'), ' frames'
  );

  body.replaceChildren(
    el('div', { className: 'mbtop' },
      el('div', {},
        el('h3', { className: 'mbtitle' }, scene.title),
        el('div', { className: 'muted small' },
          [scene.studio?.name, scene.date].filter(Boolean).join(' · '))),
      back),
    el('div', { className: 'mbstage' }, video),
    el('div', { className: 'mbbar' },
      readout, lengthOut,
      pending,
      el('div', { className: 'vgap' }),
      keyhint,
      gridBtn,
      fetchBtn,
      stripBtn,
      regenBtn,
      zoomOut, zoomIn),
    strip,
    ladder,
    transport,
    said,
    listing
  );

  renderList();
  draw();

  /*
   * ------------------------------------------------------------- the sheet
   *
   * Our own one-a-second strip when it exists, else Stash's (~81 tiles). See
   * spritestrip.mjs.
   */

  /* Cues by arithmetic: evenly spaced tiles in a fixed grid. Sheets numbered from 001. */
  const cuesFromStrip = (made) => {
    const out = [];
    for (let i = 0; i < made.tiles; i++) {
      const within = i % made.perSheet;
      out.push({
        start: i * made.interval,
        src: `/media/scene/${scene.id}/strip/${Math.floor(i / made.perSheet) + 1}`,
        crop: {
          x: (within % made.cols) * made.tile.w,
          y: Math.floor(within / made.cols) * made.tile.h,
          w: made.tile.w,
          h: made.tile.h,
        },
      });
    }
    return out;
  };

  const useStrip = (made) => {
    cues = cuesFromStrip(made);
    // Every sheet is the same size — the tile filter pads the last one out to
    // a full grid — so one number does for all of them and nothing is probed.
    sheetSize = made.sheet;
    draw();
    resetLadder();
  };

  // Stash's, loaded straight away so the strip has pictures on it while our
  // own is being cut, or if it never is.
  const loadStash = () => {
    // No sheet at all: tell the ladder.
    if (!scene.vtt) { resetLadder(); return; }

    thumbnailCues(`/media/scene/${scene.id}/vtt`).then((found) => {
      // A sharper one landed while this was in flight. Do not undo it.
      if (!found || sharper) { resetLadder(); return; }
      cues = found;

      /*
       * Probe the sheet's pixel size (the vtt doesn't carry it). Draw without
       * pictures meanwhile.
       */
      const probe = new Image();
      probe.onload = () => {
        if (sharper) return;
        sheetSize = { w: probe.naturalWidth, h: probe.naturalHeight };
        draw();
        resetLadder();
      };
      probe.onerror = () => { draw(); resetLadder(); };
      probe.src = found[0].src;
    }).catch(() => resetLadder());
  };

  let sharper = false;

  const stripState = async (found) => {
    if (found.strip) {
      sharper = true;
      useStrip(found.strip);
    }
    renderStripBtn(found);
    return found;
  };

  api(`/api/import/markers/scene/${scene.id}/strip`)
    .then((found) => {
      stripState(found);
      if (!found.strip) loadStash();
      if (found.building) pollStrip();
    })
    .catch(() => loadStash());

  /* ----------------------------------------------------------- going away */

  window.addEventListener('keydown', onKey);
  /* One observer redraws the strip and re-pads the rungs. */
  const resize = new ResizeObserver(() => { draw(); layoutRows(); });
  resize.observe(strip);

  teardown = () => {
    alive = false;
    stopStripPoll();
    if (seekWatch) clearTimeout(seekWatch);
    window.removeEventListener('keydown', onKey);
    resize.disconnect();
    if (following) cancelAnimationFrame(following);
    video.pause();
    /* Both, in this order: remove src, then load(), or the stream keeps downloading. */
    video.removeAttribute('src');
    video.load();
  };

  strip.focus();
}
