/*
 * Marker Builder — the workbench.
 *
 * Modelled on LosslessCut, which is a common tool for cutting video, so the
 * shape is deliberately borrowed: a picture on top, a filmstrip under it that
 * *is* the timeline, and a keyboard that does the work. `t` drops a point,
 * `i` and `o` bracket a span, arrows walk the playhead, and every one of them
 * ends in the same question — what is this. Nothing is written until that is
 * answered, and answering it is one keystroke on a preset or a name typed out.
 *
 * The filmstrip is the sprite sheet Stash already generated for the scrub bar,
 * cut into tiles and laid along time. That is why the timeline can be scrolled
 * fast and far without asking the video for anything: the pictures are one
 * image request made once, and the video only ever has to catch up to where
 * the strip was let go of.
 *
 * The playhead does not move. The strip moves under it — the same way the
 * cutting apps do it, and the reason is not taste: a playhead that travels
 * means the thing you are aiming at is somewhere different every time, and
 * placing an out point accurately is aiming.
 */

import { api, el } from './util.js';
import { thumbnailCues } from './player.js';
import { askTag, palette, remember, stamp } from './markertag.js';
import { timestamps } from './markerfetch.js';
import { SCENE_FACETS, SCENE_SORTS, orderScenes, shelfScenes } from './library/shelves.js';
import { shelfPage, tile } from './library/tiles.js';

/*
 * Standing down.
 *
 * The bench holds a playing video and a keydown listener on the window, and
 * neither of them belongs to the node the router replaces — a page left behind
 * would carry on streaming, and `t` on some other page would still be trying
 * to write a marker into a scene nobody is looking at. So it registers its
 * cleanup here and app.js calls this on the way past every address change, the
 * same way the reel is stood down.
 */
let teardown = null;

export function leave() {
  if (!teardown) return;
  const stop = teardown;
  teardown = null;
  stop();
}

/* ------------------------------------------------------------------- times
 *
 * `stamp` lives in markertag.js with the prompt it is mostly read beside — the
 * player bars ask the same question and want the same clock.
 */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ------------------------------------------------------------------- steps
 *
 * What the arrow keys move by. Three sizes rather than one because finding a
 * moment and placing a mark on it are different jobs at different scales — a
 * bare arrow is for placing, shift is for finding, and alt is for the frame
 * you are one nudge away from.
 */
const STEP = 1;
const STEP_BIG = 10;
/*
 * The fine step has no touch equivalent and does not need one: dragging the
 * strip at the closest zoom is about eight milliseconds a pixel, which is
 * finer than alt and an arrow key ever gets you.
 */
const STEP_FINE = 0.1;

/*
 * Pixels per second. The strip is drawn at whichever of these is current, and
 * the range is the honest one: at 2 a two-hour scene is four screens wide and
 * you can find anything; at 120 a tile is about a third of a second and you
 * can see a cut land. Anything outside that is either a scene you cannot see
 * or a strip made of one picture repeated.
 */
const ZOOMS = [2, 4, 8, 16, 32, 60, 120];
const ZOOM_START = 3;

// How tall the filmstrip is. Tiles are scaled to it and keep their own shape.
const STRIP_H = 64;

/* ---------------------------------------------------------------- the queue
 *
 * Which scene to work on.
 *
 * This was a list of rows with a search box and three chips over it, and every
 * one of those asked the server again. That is the right shape for a backlog
 * you work top-down and the wrong one for the question that actually gets
 * asked here — *which scenes of this studio, or this performer, or this tag,
 * have nothing marked* — because a server that answers sixty rows at a time
 * cannot count what is behind a dropdown or reorder anything but the page you
 * are looking at.
 *
 * So it is the library's own shelf now: the same filter bar, the same facets
 * counting themselves as you narrow, the same sorts, the same wall of tiles,
 * the same Show more. Whatever the Library > Scenes page learns, this learns.
 *
 * It costs one small request. The scenes are already in the page — the shelf
 * memo the library filled, or fills on the way in — and all this needs on top
 * is which of them the bench will accept and which are done, which is two
 * lists of ids. See queued() in markerbuilder.mjs.
 *
 * Unmarked is still the default, because a backlog is what this page is for.
 * It is a facet now rather than a mode, which is the only real change in
 * meaning: you can hold a studio and swap between its marked and unmarked
 * scenes without the page going back to the server for either.
 */

/*
 * The shelf you were on when you picked a scene.
 *
 * The filters live in the address, which the bench then replaces with its own
 * `scene=`, so by the time you press the way out they are gone. Held here
 * instead, and handed back — a shelf you narrowed to one studio's unmarked
 * scenes is a place you are working, and marking one of them should not throw
 * it away. Empty until the picker has been used, so a bench opened from a link
 * goes back to the default backlog rather than to nothing.
 */
let shelfWas = '';

const MARKS_NONE = 'Nothing marked';
const MARKS_SOME = 'Has markers';

/*
 * The library's five, plus the one this page exists for. First in the row
 * because it is the one you set on the way in, and the only one whose default
 * is not "any".
 */
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

  /*
   * Filed only, and the reason is in markerbuilder.mjs: everything upstream of
   * /organized_scenes is still going through FileFlows, and the file a mark was
   * placed against is not the file that comes out the other end. The shelf
   * holds the whole of Stash, so most of what it hands over is dropped here.
   */
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

  /*
   * A tile that opens the bench rather than the library's scene page. Built by
   * the library's own tile so the two walls stay the same wall, then re-pointed
   * — a copy of thirty lines of tile drawing would drift within a month.
   */
  const benchTile = (scene) => {
    const node = tile(scene);
    node.onclick = () => {
      // Read off the address rather than off shelfPage's state: the address is
      // what it writes, and it is already exactly what would restore this.
      shelfWas = location.hash.split('?')[1] || '';
      go(new URLSearchParams({ scene: scene.id }));
    };

    /*
     * How much is on it, on the artwork with the resolution and the stage. A
     * scene with nothing says nothing: that is the ordinary case on this page
     * and a badge on everything is a badge on nothing — the same rule the tile
     * already follows for filed scenes.
     */
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
   * The address is the state, the same way the library's shelves work — so a
   * shelf you narrowed is a place you can come back to, and the bench's back
   * button lands on it rather than on the top of the backlog.
   *
   * Seeded with the backlog when the address says nothing, and only then: a
   * `marks` already in the query is an answer, including an empty one meaning
   * "both", and overwriting it would make Clear impossible to press.
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

  /*
   * shelfPage leads with a heading of its own, and this page already has one
   * above the body — the section header the import half draws. So the heading
   * is dropped and its count line is kept, which is the half that says how big
   * the backlog is.
   */
  const [feedhead, ...rest] = page;
  const note = feedhead.querySelector('.muted');

  /*
   * The other half of the page. This one is "which scene should I mark"; the
   * management page is "what have I marked" — a different question asked of
   * the markers themselves rather than of the scenes holding them, which is
   * why it is a place rather than a filter on this wall.
   */
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
    // The palette is warmed alongside the scene rather than waited on: it is
    // wanted at the first `t`, not at the first frame, and markertag.js holds
    // it for the rest of the page's life once it lands.
    palette();
    loaded = await api(`/api/import/markers/scene/${sceneId}`);
  } catch (err) {
    /*
     * Refusals land here as well as faults — a scene still in FileFlows is one
     * the bench will not open. So the way out is on screen with the reason,
     * rather than leaving the only route back through the nav.
     */
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
  /*
   * A button, not a label. Esc drops an in point you have thought better of,
   * and Esc is a key — on a phone the only way out of a half-open span was to
   * close it and delete the marker afterwards. So the thing that tells you the
   * in point exists is also the thing that gets rid of it.
   */
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

  /* -------------------------------------------------------------- the clock
   *
   * `at` is the truth and the video follows it, not the other way round. A
   * timeline driven by `timeupdate` moves in quarter-second hops and cannot be
   * nudged a tenth, and one that waits for a seek to land before drawing the
   * next frame is a timeline that fights the arrow key you are holding down.
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

  /*
   * One seek in flight at a time. Holding an arrow key down can produce sixty
   * seek requests a second against a proxied stream, and a browser given those
   * serves none of them — it queues, and the picture stops answering. So the
   * newest wanted time is remembered instead, and asked for as soon as the
   * previous one has landed.
   */
  let seekWatch = null;

  function applySeek() {
    if (wanted == null) return;

    /*
     * A seek that never lands.
     *
     * The chain here is a proxied stream over a mount, and a seek into a part
     * of it the server is slow to answer can leave `seeking` true with no
     * `seeked` ever arriving — after which every later seek is dropped by the
     * guard above and the picture simply stops following the timeline. It is
     * the tablet's ordinary case rather than an exotic one, because a drag
     * ends in a seek across a much bigger distance than an arrow key does.
     *
     * So a pending seek is retried rather than waited on. Half a second is
     * longer than any seek that is going to succeed on its own.
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
   * `settle: false` moves the playhead and the strip without asking the video
   * to follow — used while a drag is in flight, and landed once when it ends.
   *
   * The reason is what the file is. These are x265 with scene-cut detection,
   * so the keyframes on the scene this was built against average eight seconds
   * apart and reach twenty-one at the worst gap; an exact seek has to decode
   * everything from the keyframe before it, and a drag that asks for one every
   * few pixels asks for that over and over. The strip is the preview — that is
   * what it is for — and the picture only has to be right where you stop.
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

  /*
   * Tiles are pooled and re-pointed rather than rebuilt. A two-hour scene at
   * the closest zoom is a strip nine hundred thousand pixels wide, so what is
   * drawn is only ever the slots the window can see — the same handful of
   * nodes, moved and re-cropped as time passes under them.
   */
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

  /*
   * How wide one tile is on screen: its own shape, scaled to the strip height.
   * Slots are laid on that width rather than on a division of the zoom, so a
   * tile is never stretched — a squashed thumbnail is worse than a repeated
   * one, because a repeated one is honestly saying the strip is closer in than
   * the sprite sheet was ever cut for.
   */
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

      // Both ends. Before the scene starts and after it ends are the same
      // answer — nothing — and without the lower guard the binary search
      // happily returns the first cue for a negative time, which draws the
      // opening frame repeated off the left of the strip.
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

  /*
   * A label every so often, where "so often" is whichever round number of
   * seconds is at least eighty pixels apart at this zoom. Ticks that crowd are
   * ticks nobody reads.
   */
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

      // The playhead is fixed at the middle, so the strip's left edge is half
      // a window behind the current time. Everything below is drawn against
      // that one number.
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


  /* ------------------------------------------------------------ the ladder
   *
   * Driving down through frames rather than scrubbing for them.
   *
   * The strip is a ruler, and it is very good at "put the mark exactly here".
   * It is a poor way to answer "where in this scene does the thing happen" —
   * that question is a search, and a search across two hours of timeline is a
   * lot of dragging. So this is the other half of the bench: the whole scene
   * laid out as frames, coarse at the top, and clicking one opens the stretch
   * of time under it at ten times the detail.
   *
   * Every rung is a slice of the rung above it. Nothing is fetched — these are
   * the same cues the strip draws from.
   *
   * A click also seeks. Landing on the frame you just looked at costs nothing,
   * and it is what makes the bottom rung the end of the job rather than a
   * separate step — find it here, then `t`.
   *
   * Two things about how it is laid out, and both are the same idea.
   *
   * Every rung is *centred on the playhead*, in the same place across the page
   * as the strip's own playhead — one line down the middle of the bench, and
   * every row saying what is at that line at its own scale. A row that scrolls
   * from the left instead means the frame you are looking at is somewhere
   * different in every rung, and the eye has to find it again each time.
   *
   * And every rung can be *widened*. A rung opened from the row above covers
   * exactly the stretch of the frame that was clicked, which is the right
   * place to start and the wrong place to stay: the thing you are looking for
   * is regularly just outside it. Wider doubles the window around where you
   * are standing rather than making you climb back up a rung to reach it.
   */

  // Where the top rung stands, and how much finer each one below it is.
  const LADDER_TOP = 30;
  const LADDER_STEP = 10;
  /*
   * A top row longer than this is a scroll nobody reads, so on a long film the
   * top rung stands further back rather than growing without limit. 240 at
   * thirty seconds is two hours, which covers everything but the compilations.
   */
  const LADDER_MAX = 240;
  /*
   * The finest rung there is.
   *
   * It used to be however finely the sheet was cut, which on a sharpened strip
   * is a frame a second — a rung of ten near-identical pictures that took a
   * row of the panel to say what one of them said. Ten seconds is the last
   * step that is still answering the question the ladder is for; below that
   * you are placing rather than looking, and the strip and the arrow keys do
   * placing far better than a row of thumbnails ever will.
   */
  const LADDER_FLOOR = 10;

  // Frames are a fixed height for the same reason strip tiles are: the crop
  // has to be scaled by a number known before layout, not measured after it.
  const FRAME_H = 72;

  const grid = el('div', { className: 'mbgrid' });

  /*
   * The line the rungs are read against, and it is the strip's line: both are
   * the middle of a full-width block, so drawing it here at 50% puts it under
   * the playhead above without either having to measure the other.
   *
   * Outside the scrolling panel rather than inside it — an absolutely placed
   * child of a scroller travels with its content, which would leave the line
   * halfway up a rung as soon as the panel was scrolled.
   */
  const guide = el('div', { className: 'mbgridhead' });
  const ladder = el('div', { className: 'mbladder', hidden: true }, grid, guide);

  // Open rungs, coarsest first. Each is the window a click in the rung above
  // opened; the first is always the whole scene.
  let rungs = [];
  /*
   * Per rung, the frames drawn in it — kept so the playhead highlight can move
   * without rebuilding several hundred nodes on every animation frame.
   */
  let rungFrames = [];
  let litFrames = [];
  // The scrolling row each rung was drawn into, for the centring below.
  let rungRows = [];
  let ladderOpen = false;
  /*
   * Set once the sheet has been asked for and answered, however it answered.
   * Without it an empty panel says "still loading" forever on a scene Stash
   * never generated a sprite for, which is a lie about a fixable thing.
   */
  let sheetSettled = false;

  /*
   * A row somebody is scrolling by hand is a row that has been taken off the
   * playhead on purpose, so the centring leaves it alone for a few seconds
   * afterwards. Without this, nudging the clock while reading along a rung
   * snatches it back to the middle mid-drag.
   */
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
   * Everything below the rung a frame was clicked in is thrown away, because
   * it described a different stretch of time. The clicked frame stays lit as
   * the parent of what replaced it, which is the only thing telling you where
   * in the row above you currently are.
   */
  function openFrame(depth, start, step) {
    const finer = nextStep(step);
    rungs = rungs.slice(0, depth + 1);
    if (finer) rungs.push({ from: start, to: start + step, step: finer });
    goTo(start);
    renderLadder();
    /*
     * The rung that just opened is the one you asked for, and on a long ladder
     * it is below the fold of the panel. Scrolled inside the panel rather than
     * the page, so the video does not slide away underneath you.
     */
    grid.scrollTop = grid.scrollHeight;
  }

  /*
   * Wider, or back in again.
   *
   * The window grows around where you are standing rather than around its own
   * middle — you widen a rung because what you want is off one of its ends,
   * and the playhead is the honest guess at which end that is. Clamped to the
   * scene at the far side and to three frames at the near one; a rung of two
   * pictures is a rung that has stopped saying anything.
   *
   * Rungs below are dropped only when they no longer fit inside what is left,
   * because narrowing is the only one of the two that can orphan them.
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

  /*
   * The frame the playhead is standing in, put under the line — the same place
   * on screen as the strip's playhead, in every rung at once.
   *
   * `smooth` only when the clock moved on its own. A frame clicked or a rung
   * widened should land immediately; a video playing through the end of a row
   * should slide.
   */
  function centreRow(i, { smooth = false } = {}) {
    const row = rungRows[i];
    const node = litFrames[i];
    if (!row || !node || held(row)) return;

    /*
     * Measured against the line itself rather than against the middle of the
     * row. They are the same number while the panel is symmetric, and they
     * stop being the same the moment it is not — a vertical scrollbar on the
     * panel narrows the row without moving the line, and offsetLeft is
     * relative to whatever happens to be the nearest positioned ancestor,
     * which is the panel and not the row. Either of those puts every frame
     * eleven pixels off the playhead it is supposed to be under.
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

      // Hands off for a few seconds once it has been scrolled by hand — see
      // heldUntil. Both events, because a wheel and a finger arrive as
      // different ones and only the pointer version fires before the scroll.
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
   * Padding and centring, after the rows are in the document and can be
   * measured.
   *
   * Synchronous rather than on an animation frame, and the reason is a real
   * one rather than tidiness: a frame callback does not fire while the tab is
   * in the background, so a ladder opened on a page that was not on screen at
   * that moment stayed unpadded and every rung sat a third of a row left of
   * the playhead until something else redrew it. One forced reflow per render
   * is a fair price for a panel that is right whenever it is looked at.
   *
   * Each row is padded by half its own width less half a frame, so the first
   * and last frames can reach the middle. Without it a mark in the opening
   * seconds of a scene can never sit under the line, and the whole rung reads
   * as though it is offset.
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

  /*
   * Which frame the playhead is standing in, one per rung. A class swap rather
   * than a redraw — the top rung of a long film is a few hundred nodes and
   * this runs every time the clock moves.
   */
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

  /*
   * The sheet changed under it — a sharper strip landed, or Stash's own
   * finally answered. The rungs described a spacing that no longer exists, so
   * they go back to the top rather than being redrawn at the wrong detail.
   */
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
  /* --------------------------------------------------------------- the tags
   *
   * The prompt is markertag.js now, shared with the player bars. What is left
   * here is where it goes and what happens after: the panel is appended to the
   * bench so a router that replaces this page takes it with it, and the strip
   * gets the keyboard back whichever way the prompt ended.
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

      /*
       * A tag created here joins the palette immediately. Re-reading the whole
       * list from Stash to learn one name is a round trip to be told what we
       * just said, and the next marker in the same session is usually the same
       * tag again.
       */
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
           * Whose marker it is. The plugins sign their work in the title —
           * [Timestamp], [TsTrade], [TPDBMarker] — and a hand-cut one has no
           * title at all, which is the only record of where a marker came
           * from once it is in Stash.
           *
           * Shown only where it says something the chip does not. TPDBMarkers
           * mostly writes the tag's own name into the title, and printing both
           * gives every row it made a stutter — "Titty Fuck Titty Fuck" — that
           * buries the rows where the title is genuinely a different fact.
           */
          m.title && m.title !== (m.tag?.name || '')
            ? el('span', { className: 'muted small' }, m.title)
            : null,
          drop);
      }))
    );
  }

  /* ----------------------------------------------------------- the actions
   *
   * Named once and reached two ways. The bench was built keyboard-first and on
   * a phone that left it readable and inert — you could scrub the strip with a
   * finger and then had no way to mark anything you found. The buttons in the
   * transport row and the keys now call the same four functions, so there is
   * one description of what `t` means rather than two that drift.
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

  /*
   * `kind` is 'point' or 'out'. Out with no in point is not an error worth a
   * dialog: the useful thing to do with an out point that has no start is
   * nothing, and saying so is enough. A point never has that problem, which is
   * why it is the one that gets used most.
   */
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

  /*
   * The wheel scrubs rather than scrolls, because the strip is a timeline and
   * a timeline that scrolls independently of the playhead is two positions to
   * keep track of. Deliberately not passive: the page moving underneath while
   * you scrub is the thing this is replacing.
   */
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
   * Pinch.
   *
   * The strip sets `touch-action: none` so a horizontal drag scrubs instead of
   * scrolling the page, and that switches the browser's own pinch off with it.
   * On a timeline pinch is the first gesture anybody reaches for, so it is
   * answered here or not at all — and without it the two zoom chips are the
   * only way in, which on a phone is a 28px target for the control you use
   * most.
   *
   * Zoom is a ladder of fixed steps, not a continuous scale, so a pinch climbs
   * it: the span between the fingers has to change by a quarter before it
   * moves a rung. That is what stops two fingers resting on the glass from
   * ratcheting through the whole range.
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
     * Only fingers are counted towards a pinch. A mouse and a pen cannot
     * pinch, and counting them meant a pointerup the strip never saw — a
     * button pressed over it, a drag that ended off the edge of the window —
     * left a phantom in the map that made the *next* touch look like a second
     * finger. The symptom was a timeline that had stopped scrubbing and
     * started zooming, and it stayed that way until the page was reloaded.
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
    /*
     * Without preventScroll, a tablet answers this by scrolling the strip to
     * the top of the window — which drags the video out of sight at the exact
     * moment a finger has gone down on the timeline.
     */
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
   * While it plays the video leads and the strip follows; while it is paused
   * the strip leads. `timeupdate` is coarse, so playing is drawn off a frame
   * loop instead — a filmstrip that hops in quarter-seconds looks broken in a
   * way a scrub bar does not.
   */
  let following = null;

  const follow = () => {
    if (video.paused) { following = null; return; }
    /*
     * Not while a finger is on the strip. Both of these write the clock, and
     * scrubbing a playing scene had them writing it alternately — the strip
     * followed the finger for one frame and was yanked back to the video on
     * the next, which on a tablet reads as a timeline that will not be moved.
     * The drag wins while it lasts and settle() hands the video the answer at
     * the end of it.
     */
    if (!dragging) goTo(video.currentTime, { fromVideo: true });
    following = requestAnimationFrame(follow);
  };

  video.addEventListener('play', () => { if (!following) following = requestAnimationFrame(follow); });
  video.addEventListener('pause', () => { if (following) cancelAnimationFrame(following); following = null; });

  /* ----------------------------------------------------------------- paint */

  const back = el('button', { className: 'link', type: 'button' }, '← another scene');
  back.onclick = () => go(new URLSearchParams(shelfWas));

  /*
   * The other way of finding a moment. Off by default because the bench is a
   * timeline first, and a second panel below the fold would be in the way of
   * everyone who came here to nudge an out point by a tenth.
   */
  const gridBtn = el('button', { className: 'chip', type: 'button', title: 'Frame ladder (g)' }, 'Frames');
  gridBtn.onclick = () => toggleLadder();

  /*
   * What the two outside sources have for this scene.
   *
   * The bench is for the moment nobody else knows about; this is for the ones
   * somebody already wrote down. It opens a panel rather than importing,
   * because what comes back is regularly right about the scene and wrong about
   * the file — see markerfetch.js.
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

  /* ------------------------------------------------------- sharpening it
   *
   * One control with three states, because they are three answers to the same
   * question — how good is the strip I am looking at.
   */

  const stripBtn = el('button', { className: 'chip mbsharpen', type: 'button' }, 'Sharpen strip');

  /*
   * The same cut, asked for outright.
   *
   * The chip above is a toggle — nothing, or the strip you have, and pressing
   * it when you have one throws it away. That is two presses and a confirm to
   * say the thing you actually mean when a strip is wrong: cut it again. This
   * is that in one press, and what it does is not conditional on the state it
   * finds — it overwrites. spritestrip.mjs cuts into a working directory and
   * renames it into place whole, so the strip on screen goes on working right
   * up to the moment the new one lands.
   */
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

  /*
   * While a cut runs the button is the progress bar. Three seconds, because a
   * sheet is a hundred frames and they do not land faster than that — a
   * tighter poll would mostly be asking to be told the same number.
   */
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

  /*
   * Cut, whatever is there. The confirm is only asked when there is something
   * to lose — a minute of every core, and a strip that was fine until you
   * pressed this.
   */
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
   * The transport.
   *
   * Every key has a button now, because a phone has none of the keys. The
   * letter rides on the button as a badge rather than in a separate legend —
   * that way the same row teaches the shortcut on a desktop and is simply the
   * control on a phone, where the badges are hidden and nothing is left saying
   * "press t" to somebody who cannot.
   *
   * The nudges are fixed amounts for the same reason: shift and alt are
   * modifiers, and a finger has none.
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

  /* ------------------------------------------------------------- the sheet
   *
   * Two sources, and the sharper one wins.
   *
   * Stash's sheet is about 81 tiles whatever the scene's length — every 17.4
   * seconds on this one — which at the default zoom means each frame is drawn
   * two and a half times. Our own is a picture a second, cut from the source
   * on demand, and where one exists it is used instead. See spritestrip.mjs
   * for what that costs.
   */

  /*
   * The manifest is arithmetic rather than a vtt: tiles are evenly spaced and
   * laid in a fixed grid, so every cue's sheet and crop follow from its index
   * and there is nothing to parse. Sheets are numbered from 001 because that
   * is how ffmpeg writes them.
   */
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
    // Nothing to load, and nothing further coming. The ladder is told, because
    // an empty panel that says "still loading" about a sheet that will never
    // arrive is a lie about a thing Sharpen strip can fix.
    if (!scene.vtt) { resetLadder(); return; }

    thumbnailCues(`/media/scene/${scene.id}/vtt`).then((found) => {
      // A sharper one landed while this was in flight. Do not undo it.
      if (!found || sharper) { resetLadder(); return; }
      cues = found;

      /*
       * The sheet's own size, which the vtt does not carry — the crops are in
       * its pixels and scaling them needs the whole. The strip draws without
       * pictures until this answers rather than waiting on it.
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
  /*
   * The strip is redrawn against its new width, and the rungs are re-padded
   * against theirs — they are the same width and change together, so one
   * observer answers for both.
   */
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
    /*
     * Both, in this order. Dropping the attribute alone leaves the browser
     * holding the connection it already opened — a proxied stream that carries
     * on downloading a scene nobody is watching — and load() on an empty src
     * is what actually lets it go.
     */
    video.removeAttribute('src');
    video.load();
  };

  strip.focus();
}
