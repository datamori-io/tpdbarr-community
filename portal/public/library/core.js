/*
 * The library's spine: which view owns the screen, how one stands down, and the
 * chrome every page here wears.
 *
 * Everything else in this folder imports from this and nothing here imports
 * back — the one rule that keeps the split honest. A page that needs something
 * from another page means the something belongs here instead.
 */

import { api, clock, el } from '../util.js';
// The sprite sheet's cues, read by the tile scrub below and by the player bar.
import { thumbnailCues } from '../player.js';

export const view = document.getElementById('view');

/*
 * Views own timers and listeners that outlive their DOM, so each one registers
 * how to shut itself down and the next render calls it. Without this the
 * player keeps reporting progress for a scene you navigated away from.
 */
let teardown = null;
let pending = null;

/*
 * Which view owns the screen.
 *
 * The studios page takes a second to draw two hundred logos. Click away to a
 * faster one while it is still fetching and the slow request lands last,
 * rendering over the page you are now looking at. So every view claims the
 * screen when it starts and stands down if that claim has since passed to
 * someone else — including to the acquisition side, which claims it on the way
 * past in leave().
 */
let viewToken = 0;
export const claim = () => ++viewToken;
export const holds = (token) => token === viewToken;

function render(...nodes) {
  const mine = viewToken;
  // Captured before leave(), which clears it along with the outgoing view's.
  const next = pending;
  leave();
  viewToken = mine;
  // The view being rendered is now the one on screen, so its cleanup goes live.
  teardown = next;
  view.replaceChildren(...nodes.flat().filter(Boolean));
  // A new view starts at the top; scrollIntoView would land under the topbar.
  window.scrollTo(0, 0);
}

/*
 * The acquisition side renders straight into #view without going through
 * render(), so it calls this on the way past. Otherwise the player carries on
 * reporting progress for a scene you left ten minutes ago.
 */
export function leave() {
  viewToken++;
  if (teardown) teardown();
  teardown = null;
  pending = null;
  stopPreview();
  // A page dimmed around a player it no longer has would stay dimmed.
  document.body.classList.remove('videowide');
}

/*
 * A view registers its cleanup while it is being built — which is before
 * render() runs, because the nodes are render()'s arguments. So it lands in
 * `pending` and only becomes the active teardown once the view is actually on
 * screen. Assigning `teardown` directly would mean render() tearing the new
 * player down a moment after building it, taking its src with it.
 */
export function onTeardown(fn) {
  pending = fn;
}

export const loading = () => render(el('div', { className: 'empty' }, 'Loading…'));
export const failed = (err) => render(el('div', { className: 'empty' }, err.message));

/*
 * A page that is not one of the library's five sections and so wears none of
 * their chrome. Stats is its own tab in the topbar — putting the section strip
 * on it would highlight nothing and offer five places it is not.
 */
export const page = (...nodes) => render(...nodes);

let stashUrl = null;
export async function stashOrigin() {
  if (stashUrl === null) {
    stashUrl = await api('/api/state').then((s) => s.config?.stashUrl || '').catch(() => '');
  }
  return stashUrl;
}

// ------------------------------------------------------------------- tiles

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
const HOVER_DELAY = 450;

// One preview at a time. A rail of clips all playing at once is unreadable,
// and it asks Stash for a dozen video files it will throw away.
export let preview = null;

function stopPreview() {
  if (!preview) return;
  preview.video.pause();
  preview.video.removeAttribute('src');
  preview.video.remove();
  preview = null;
}

/* ------------------------------------------------------- scrubbing a tile
 *
 * The bottom of the artwork is a timeline; the rest of it is the frame you are
 * pointing at.
 *
 * The preview below plays a scene's own generated loop, which is somebody
 * else's choice of which twenty seconds matter. This is the other question —
 * *what happens in this one* — and it is answered by the sprite sheet Stash
 * already cuts for the scrub bar: eighty-one frames across the whole runtime,
 * one image request, no video decoded at all.
 *
 * **Only the bottom band scrubs.** A tile that changed its picture whenever the
 * cursor crossed it would flicker all the way across a wall of them, and the
 * top of a tile is where the badges are read. So the bottom 15% is the strip,
 * drawn as a bar rather than as frames — there is no room for a picture down
 * there and a bar is what a timeline looks like anyway — and the rest of the
 * tile shows the frame for wherever along it you are.
 *
 * The sheet's own size is worked out from the cues rather than by loading the
 * image and measuring it: every crop is the same size and they tile a grid, so
 * the widest right edge and the lowest bottom edge *are* the sheet. One less
 * request, and no window where the frames are known but not yet scalable.
 */

// How much of the tile is the timeline. The same number is in the CSS.
const SCRUB_BAND = 0.15;

/*
 * Cues per scene, and the promise while they are arriving — keyed so that
 * sweeping back and forth across a tile asks once. A scene with no sheet
 * resolves to null and is never asked again.
 */
const sheets = new Map();

function sheetFor(id) {
  if (!sheets.has(id)) {
    sheets.set(id, thumbnailCues(`/media/scene/${id}/vtt`).then((cues) => {
      if (!cues || !cues.length || !cues[0].crop) return null;

      // The grid, from the crops themselves. Row zero is always full, so the
      // widest right edge is the true width; the last row gives the height.
      let w = 0;
      let h = 0;
      for (const cue of cues) {
        w = Math.max(w, cue.crop.x + cue.crop.w);
        h = Math.max(h, cue.crop.y + cue.crop.h);
      }
      return { cues, sheet: { w, h } };
    }).catch(() => null));
  }
  return sheets.get(id);
}

export function hoverPreview(node, art, id) {
  let timer = null;
  let strip = null;
  let frame = null;
  let fill = null;
  let loaded = null;
  let scrubbing = false;

  /*
   * Built on the first hover rather than with the tile. A shelf is six hundred
   * of these and almost none will ever be pointed at; three spare nodes each is
   * eighteen hundred nodes nobody asked for.
   */
  const build = () => {
    if (strip) return;
    frame = el('div', { className: 'tileframe' });
    fill = el('div', { className: 'tilescrubfill' });
    strip = el('div', { className: 'tilescrub' }, fill);
    art.append(frame, strip);
  };

  const showFrame = (ratio, found) => {
    const { cues, sheet } = found;
    const at = Math.min(cues.length - 1, Math.max(0, Math.round(ratio * (cues.length - 1))));
    const cue = cues[at];
    if (!cue || !cue.crop) return;

    /*
     * Scaled so one frame covers the artwork. The crops are 16:9 and so is the
     * tile, so matching the width matches the height too. It covers the whole
     * tile rather than the top 85%: the strip lies over the bottom of the
     * picture rather than taking a slice out of it, so the frame keeps its
     * shape.
     */
    const scale = art.clientWidth / cue.crop.w;
    frame.style.backgroundImage = `url("${cue.src}")`;
    frame.style.backgroundSize = `${sheet.w * scale}px ${sheet.h * scale}px`;
    frame.style.backgroundPosition = `-${cue.crop.x * scale}px -${cue.crop.y * scale}px`;
    frame.classList.add('on');
    fill.style.width = `${Math.round(ratio * 100)}%`;
  };

  const stopScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (frame) frame.classList.remove('on');
  };

  node.addEventListener('pointerenter', () => {
    if (REDUCED.matches || node.dataset.noPreview) return;
    build();
    timer = setTimeout(() => {
      stopPreview();
      const video = el('video', {
        className: 'tilepreview',
        src: `/media/scene/${id}/preview`,
        muted: true,
        loop: true,
        playsInline: true,
        preload: 'none',
      });
      video.addEventListener('playing', () => video.classList.add('on'), { once: true });
      // A scene with no generated preview 404s; the poster just stays up.
      video.addEventListener('error', () => { if (preview && preview.video === video) stopPreview(); }, { once: true });
      art.append(video);
      preview = { node, video };
      video.play().catch(() => {});
    }, HOVER_DELAY);
  });

  /*
   * Which band the cursor is in decides which answer it gets. A mouse is the
   * only thing that can be in one: a finger has no hover, and pointerenter on
   * a touch device fires once on tap and never moves.
   */
  art.addEventListener('pointermove', (e) => {
    if (REDUCED.matches || e.pointerType === 'touch') return;

    const box = art.getBoundingClientRect();
    if (!box.width || !box.height) return;

    const down = (e.clientY - box.top) / box.height;
    if (down < 1 - SCRUB_BAND) { stopScrub(); return; }

    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));

    build();
    scrubbing = true;

    /*
     * The preview and the scrub are two answers to the same question, so the
     * loop stops while the other one is being asked — otherwise the frame you
     * are pointing at sits on top of a video still running underneath it.
     */
    if (preview && preview.node === node) stopPreview();
    clearTimeout(timer);

    if (loaded) { showFrame(ratio, loaded); return; }

    sheetFor(id).then((found) => {
      if (!found) return;
      loaded = found;
      // Still down there when the sheet arrived, or it is a picture nobody is
      // looking at any more.
      if (scrubbing) showFrame(ratio, found);
    });
  });

  node.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    stopScrub();
    if (preview && preview.node === node) stopPreview();
  });
}

export function heading(title, note) {
  return el('div', { className: 'listhead' },
    el('h1', {}, title),
    note ? el('p', { className: 'muted' }, note) : null
  );
}

/*
 * More of the same list, appended.
 *
 * Counted in pages rather than in cards, because the missing view drops what
 * you already have out of each page — so how many are on screen says nothing
 * about how many are left.
 */
export function showMore({ page = 1, perPage = 60, count = 0 }, load) {
  const pages = Math.max(1, Math.ceil(count / (perPage || 60)));
  if (page >= pages) return null;

  let at = page;
  const button = el('button', { className: 'chip', type: 'button' }, 'Show more');
  const holder = el('div', { className: 'toolbar' }, button);

  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      await load(++at);
      if (at >= pages) holder.remove();
      else {
        button.disabled = false;
        button.textContent = 'Show more';
      }
    } catch (err) {
      button.disabled = false;
      button.textContent = err.message;
    }
  };

  return holder;
}

/* ================================================================ sections
 *
 * The library in five tabs. Same device as the acquisition side, and for the
 * same reason: Library, Acquire and Queue are places you go, whereas these are
 * five views of one shelf.
 *
 * Every page below is the same shape — what you hold, then a thin row of what
 * you do not. The missing row comes in two flavours, because the two sources
 * know different things. Stash knows about records it holds no file for: a
 * group from an identify run, a performer who arrived in someone else's cast
 * list. TPDB knows what exists at all. The first is a want list you never had
 * to write; the second is everything else.
 */

const LIBRARY_SECTIONS = [
  ['#/library', 'Overview'],
  ['#/library/scenes', 'Scenes'],
  ['#/library/categories', 'Categories'],
  ['#/library/movies', 'Movies'],
  ['#/library/galleries', 'Galleries'],
  ['#/library/performers', 'Performers'],
  ['#/library/studios', 'Studios'],
];

function sections(active) {
  return el('nav', { className: 'sections' },
    LIBRARY_SECTIONS.map(([href, label]) =>
      el('a', { className: 'section' + (href === active ? ' on' : ''), href }, label))
  );
}

// Same as render(), with the strip on top and the section remembered.
export function shell(section, ...nodes) {
  render(sections(section), ...nodes);
}

export function head(title, note) {
  return el('div', { className: 'feedhead' },
    el('h2', {}, title),
    note ? el('span', { className: 'muted' }, note) : null
  );
}

export const loadingIn = (section) => shell(section, el('div', { className: 'empty' }, 'Loading…'));
export const failedIn = (section, err) => shell(section, el('div', { className: 'empty' }, err.message));

/* ------------------------------------------------------------------ tiles
 *
 * One tile shape for a person, a studio and a movie. They differ only in the
 * artwork's aspect and where a click goes, and a page of three slightly
 * different cards reads worse than a page of one.
 */

// The initial stands in where Stash has no artwork. A letter is a worse
// picture than a photograph and a much better one than a broken image icon.
export const initial = (name) => String(name || '?').trim().charAt(0).toUpperCase() || '?';

/* ------------------------------------------------------------- the metrics
 *
 * The top of the Overview is one idea drawn several ways: this library is a
 * pipeline, not a pile.
 *
 * All of it comes from one read of the shelf, tallied server-side in the pass
 * that was already happening — see libraryIndex. There is no chart library:
 * the image has no npm dependencies and is not about to grow one to draw a
 * bar. Every mark is an <svg> built from the palette the rest of the app uses,
 * and colour always means something — grey is upstream and not yours yet,
 * text-colour is yours, coral is whatever the card is actually about.
 */

const SVGNS = 'http://www.w3.org/2000/svg';

// el() for shapes. createElement would make a <rect> that never renders.
export const svg = (tag, props = {}, ...children) => {
  const node = document.createElementNS(SVGNS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
};

export const pct = (n, total) => (total > 0 ? Math.round((n / total) * 100) : 0);

// Stash leaves plenty of fields blank. A blank is a real answer about the
// shelf — over half of it, in the case of a scene's kind — so it is one of the
// choices rather than a silent gap.
export const UNSAID = 'Not said';

/* ------------------------------------------------------------------ movies
 *
 * Stash's, like every other section here. The film wall reads
 * /api/library/films, where a group is a release made of several scene files
 * and a feature is one long file that is the whole release — both of them Stash
 * records, both edited back into Stash.
 *
 * What is left of the share reader is one page: #/library/movie/<id>, off
 * /api/moviefiles, which still walks the mount and believes the .nfo Emby wrote
 * beside each folder. Nothing on the wall links to it — a feature's card opens
 * the scene page and a group's opens its scene list — so it answers a bookmark
 * and nothing else.
 */

export const runtime = (seconds) => (seconds ? clock(seconds) : null);

// FEMALE -> Female, NON_BINARY -> Non-binary. Stash's enum, said out loud.
export const spoken = (value) =>
  (value ? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, '-') : UNSAID);

const stars = (rating) => Math.round((rating || 0) / 20);

/*
 * Filed, and a rating out of five. The two things you decide while looking at
 * something rather than while cataloguing it, and the two Stash keeps for a
 * gallery as well as for a scene — so both wear the same control, pointed at
 * whichever half of the API owns the thing.
 */
export function filedAndStars(item, base, redraw) {
  const filed = el('button', {
    className: 'act' + (item.organized ? ' on' : ''),
    type: 'button',
  }, item.organized ? '✓ Filed' : 'Mark filed');

  filed.onclick = async () => {
    filed.disabled = true;
    /*
     * Marking a scene filed moves its file into /organized_scenes now, which
     * is usually a rename the Mac does to itself and occasionally a real
     * transfer off this machine — so the button says it is working rather
     * than sitting there looking pressed. See filer.mjs.
     */
    if (!item.organized) filed.textContent = 'Filing…';
    try {
      const next = await api(`${base}/organized`, {
        method: 'POST',
        body: JSON.stringify({ organized: !item.organized }),
      });
      item.organized = next.organized;

      /*
       * The flag is set either way; the file is the part that can fail. A
       * reason it could not be moved belongs on screen rather than in a log,
       * because it is nearly always something you can fix — no date on the
       * record, no studio, a file already sitting at that name. Said on the
       * button, which is where you are looking, and cleared by the redraw a
       * few seconds later. A file that was already filed is not a failure and
       * says nothing.
       */
      const trouble = next.filed && !next.filed.moved && !next.filed.already
        ? next.filed.why
        : null;

      if (trouble) {
        filed.textContent = trouble;
        filed.title = trouble;
        setTimeout(() => { if (filed.isConnected) redraw(); }, 6000);
        return;
      }
      redraw();
    } catch (err) {
      filed.textContent = err.message;
    }
  };

  const rating = el('div', { className: 'stars', title: 'Rating' });
  for (let i = 1; i <= 5; i++) {
    const star = el('button', {
      className: 'star' + (i <= stars(item.rating) ? ' on' : ''),
      type: 'button',
      ariaLabel: `${i} star${i === 1 ? '' : 's'}`,
    }, '★');
    star.onclick = async () => {
      // Clicking the star you are already on clears it.
      const value = stars(item.rating) === i ? null : i * 20;
      const next = await api(`${base}/rating`, {
        method: 'POST',
        body: JSON.stringify({ rating: value }),
      }).catch(() => null);
      if (next) { item.rating = next.rating100; redraw(); }
    };
    rating.append(star);
  }

  return [filed, rating];
}

/*
 * A chip is a link when there is somewhere to go and plain text when there is
 * not. Tags have no page of their own, and a chip that looks clickable and
 * quietly does nothing is worse than one that never offered.
 */
export function chips(className, items, href) {
  if (!items.length) return null;
  return el('div', { className },
    items.map((item) => (href
      ? el('a', { className: 'tagchip', href: href(item) }, item.name)
      : el('span', { className: 'tagchip flat' }, item.name))));
}

/* ------------------------------------------------------------- the side rail
 *
 * Everything on a scene page is either something you do or something you read.
 * The doing stays under the player; the reading — who is in it, what it is
 * tagged, what the file is — moves into a rail beside it, so the column runs
 * four things deep instead of nine.
 */
export function sidecard(title, ...body) {
  const kids = body.flat().filter(Boolean);
  if (!kids.length) return null;
  return el('section', { className: 'sidecard' },
    el('h2', { className: 'sidehead' }, title),
    kids
  );
}

export const mbps = (bits) => (bits ? (bits / 1e6).toFixed(1) + ' Mbps' : null);
export const day = (stamp) => (stamp ? String(stamp).slice(0, 10) : null);

/* =============================================================== galleries
 *
 * The still half of the library. Everything here is a Stash gallery — the
 * portal keeps none of its own, for the same reason the rest of this half
 * counts Stash rather than Whisparr.
 *
 * A gallery ties to a scene and to a performer because Stash carries both
 * fields. It ties to a *movie* through its scenes, because the Gallery type
 * has no group field — the same answer the acquisition side gives for movies,
 * and for the same reason: the honest join is the one the data actually has.
 */

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
