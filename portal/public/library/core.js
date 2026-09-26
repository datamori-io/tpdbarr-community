/*
 * The library's core: which view owns the screen, teardown, and shared
 * chrome. Pages import from here; nothing here imports back.
 */

import { api, clock, el } from '../util.js';
// The sprite sheet's cues, read by the tile scrub below and by the player bar.
import { thumbnailCues } from '../player.js';

export const view = document.getElementById('view');

/* Each view registers its cleanup; the next render calls it. */
let teardown = null;
let pending = null;

/*
 * A token per render, so a slow view that finishes late doesn't draw over
 * the current one. leave() takes a token for the acquisition side.
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

/* Called by the acquisition side, which renders into #view without render(). */
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
 * Cleanup registered while building lands in `pending` and becomes active
 * only once the view is on screen; otherwise render() would tear down the
 * new player.
 */
export function onTeardown(fn) {
  pending = fn;
}

export const loading = () => render(el('div', { className: 'empty' }, 'Loading…'));
export const failed = (err) => render(el('div', { className: 'empty' }, err.message));

/* A page outside the five sections, with no section strip (e.g. Stats). */
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

/*
 * ------------------------------------------------------- scrubbing a tile
 *
 * The bottom 15% of a tile is a timeline over Stash's sprite sheet; the
 * rest shows the frame for that point. One image request, no video.
 * Sheet size is worked out from the cues, not by loading the image.
 */

// How much of the tile is the timeline. The same number is in the CSS.
const SCRUB_BAND = 0.15;

/* Cues per scene, with the pending promise. No sheet -> null, never re-asked. */
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

  /* Built on first hover, not with the tile. */
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

    /* Scaled so one frame covers the whole tile (both 16:9). */
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

  /* Mouse only: touch has no hover. */
  art.addEventListener('pointermove', (e) => {
    if (REDUCED.matches || e.pointerType === 'touch') return;

    const box = art.getBoundingClientRect();
    if (!box.width || !box.height) return;

    const down = (e.clientY - box.top) / box.height;
    if (down < 1 - SCRUB_BAND) { stopScrub(); return; }

    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));

    build();
    scrubbing = true;

    /* Stop the preview loop while scrubbing. */
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

/* Show more, appended. Counted in pages, since views drop held scenes per page. */
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

/*
 * ================================================================ sections
 *
 * The library's five tabs. Each page is what you hold, then a thin row of
 * what you don't: records Stash has without files, or what TPDB knows.
 */

const LIBRARY_SECTIONS = [
  ['#/library', 'Overview'],
  ['#/library/scenes', 'Scenes'],
  ['#/library/categories', 'Categories'],
  ['#/library/movies', 'Movies'],
  ['#/library/galleries', 'Galleries'],
  ['#/library/tv', 'TV'],
];

// Performers and studios live under the Manage menu, so their pages get no strip.
function sections(active) {
  if (!LIBRARY_SECTIONS.some(([href]) => href === active)) return null;
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

/*
 * ------------------------------------------------------------------ tiles
 *
 * One tile shape for people, studios and movies.
 */

// The initial stands in where Stash has no artwork. A letter is a worse
// picture than a photograph and a much better one than a broken image icon.
export const initial = (name) => String(name || '?').trim().charAt(0).toUpperCase() || '?';

/*
 * ------------------------------------------------------------- the metrics
 *
 * Overview charts, tallied server-side (libraryIndex). Plain SVG in the
 * app's palette, no chart library. Grey is upstream, text colour is yours,
 * coral is the card's subject.
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

// "Not said" is a real filter value for blank fields.
export const UNSAID = 'Not said';

/*
 * ------------------------------------------------------------------ movies
 *
 * The film wall reads /api/library/films (Stash groups and features).
 * #/library/movie/<id> still reads the share (/api/moviefiles), for bookmarks only.
 */

export const runtime = (seconds) => (seconds ? clock(seconds) : null);

// FEMALE -> Female, NON_BINARY -> Non-binary. Stash's enum, said out loud.
export const spoken = (value) =>
  (value ? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, '-') : UNSAID);

const stars = (rating) => Math.round((rating || 0) / 20);

/* Filed and a star rating, shared by scenes and galleries. */
export function filedAndStars(item, base, redraw) {
  const filed = el('button', {
    className: 'act' + (item.organized ? ' on' : ''),
    type: 'button',
  }, item.organized ? '✓ Filed' : 'Mark filed');

  filed.onclick = async () => {
    filed.disabled = true;
    /* Filing moves the file, so show it's working. See filer.mjs. */
    if (!item.organized) filed.textContent = 'Filing…';
    try {
      const next = await api(`${base}/organized`, {
        method: 'POST',
        body: JSON.stringify({ organized: !item.organized }),
      });
      item.organized = next.organized;

      /* Show why a file couldn't be moved on the button; silent if already filed. */
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

/* A chip is a link only when there's somewhere to go. */
export function chips(className, items, href) {
  if (!items.length) return null;
  return el('div', { className },
    items.map((item) => (href
      ? el('a', { className: 'tagchip', href: href(item) }, item.name)
      : el('span', { className: 'tagchip flat' }, item.name))));
}

/*
 * ------------------------------------------------------------- the side rail
 *
 * The scene page's reading column.
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

/*
 * =============================================================== galleries
 *
 * Stash galleries. Movies are tied through the gallery's scenes (no group field).
 */

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
