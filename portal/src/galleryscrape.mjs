/*
 * Where gallery pictures come from: a web page, a TPDB scene, a TPDB
 * performer. Returns candidates only; gallerybuild.mjs writes. A web page is
 * fetched once and never crawled.
 */

import * as tpdb from './tpdb.mjs';

// A browser's headers. Plenty of image hosts hand a bare fetch a 403 and a
// real user agent the picture, and there is nothing clever going on here.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const headers = (referer) => ({
  'User-Agent': UA,
  Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8',
  ...(referer ? { Referer: referer } : {}),
});

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;

/* Only URLs this module offered can be proxied or fetched. */
const MAX_KNOWN = 3000;
const offered = new Map(); // url -> the page it came from, for the Referer

function remember(candidates, referer) {
  if (offered.size >= MAX_KNOWN) offered.clear();
  for (const c of candidates) {
    offered.set(c.url, referer || null);
    if (c.thumb && c.thumb !== c.url) offered.set(c.thumb, referer || null);
  }
}

export const isOffered = (url) => offered.has(url);
export const refererFor = (url) => offered.get(url) || null;

/* Page furniture by URL. Kept short; the size check catches the rest. */
const CHROME = /(logo|favicon|sprite|avatar|banner|button|placeholder|spacer|header|footer|1x1|pixel|\/ads?\/|doubleclick)/i;

const absolute = (href, base) => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

/*
 * The biggest srcset entry by descriptor. Order isn't guaranteed
 * (elitebabes lists widest first).
 */
function fromSrcset(value, base) {
  let best = null;
  let biggest = -1;

  for (const part of String(value || '').split(',')) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;

    // "800w" is a width, "2x" a density, and a bare entry is the 1x default.
    const hit = /^(\d+(?:\.\d+)?)([wx])$/i.exec(descriptor || '');
    const size = hit ? (hit[2].toLowerCase() === 'w' ? Number(hit[1]) : Number(hit[1]) * 1000) : 1;

    if (size > biggest) {
      biggest = size;
      best = url;
    }
  }

  return best ? absolute(best, base) : null;
}

const attr = (tag, name) => {
  const hit = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag);
  return hit ? hit[1] : null;
};

// The best picture one <img> tag offers, lazy attributes included — plenty of
// galleries never put a real src on the page until you scroll.
function fromImg(tag, base) {
  return (
    fromSrcset(attr(tag, 'srcset') || attr(tag, 'data-srcset'), base) ||
    absolute(
      attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy-src') || attr(tag, 'src'),
      base
    )
  );
}

/*
 * Follow thumbnails that link to a per-photo page (girlsofdesire). One
 * level, same gallery URL only, capped.
 */
const FOLLOW_MAX = 60;
const FOLLOW_AT_ONCE = 6;

// The directory a thumbnail lives in, which is the directory its full-size
// version almost always lives in too.
function directory(url) {
  try {
    const path = new URL(url).pathname;
    return path.slice(0, path.lastIndexOf('/') + 1);
  } catch {
    return null;
  }
}

async function followLead(lead) {
  const res = await fetch(lead.href, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', Referer: lead.from },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) return null;
  if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) return null;

  const html = await res.text();
  const base = res.url || lead.href;

  const pictures = [];
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = fromImg(tag, base);
    if (!src || /^data:/i.test(src) || /\.svg(\?|#|$)/i.test(src)) continue;
    if (CHROME.test(new URL(src).pathname)) continue;
    pictures.push(src);
  }

  /*
   * Prefer the file in the thumbnail's own directory; og:image and the first
   * remaining image are fallbacks.
   */
  const home = directory(lead.thumb);
  const sameFolder = pictures.find((u) => directory(u) === home && u !== lead.thumb);
  if (sameFolder) return sameFolder;

  const og = /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i.exec(html);
  const declared = og ? absolute(attr(og[0], 'content'), base) : null;
  if (declared) return declared;

  return pictures.find((u) => u !== lead.thumb) || null;
}

async function follow(leads) {
  const queue = [...leads].slice(0, FOLLOW_MAX);
  const out = [];

  const worker = async () => {
    for (;;) {
      const lead = queue.shift();
      if (!lead) return;
      const full = await followLead(lead).catch(() => null);
      // The thumbnail is kept as the thumbnail: the picker then has something
      // to show without fetching every full-size picture to look at them.
      if (full) out.push({ full, thumb: lead.thumb, at: lead.at });
    }
  };

  await Promise.all(Array.from({ length: Math.min(FOLLOW_AT_ONCE, queue.length) }, worker));

  // Back into the order they appeared on the page, which is the order of the
  // set — the workers finish in whatever order the site answers.
  return out.sort((a, b) => a.at - b.at);
}

/*
 * One page, read for pictures. Anchors wrapping a thumbnail first (the link
 * is the full-size image), then bare <img>s including lazy-load attributes.
 */
/*
 * ------------------------------------------------------- listing pages
 *
 * A performer page on these sites lists galleries. Generic: a gallery link
 * is a same-host anchor wrapping a thumbnail. JavaScript-built lists give
 * none, and the page says so.
 */
export async function linksOn(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`${new URL(url).hostname} -> ${res.status}`);
  if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) {
    throw new Error('That address is not a web page.');
  }

  const html = await res.text();
  if (!html.length) {
    throw new Error(`${new URL(url).hostname} returned an empty page — that address probably does not exist there.`);
  }

  const base = res.url || url;
  const here = new URL(base);
  const found = new Map();

  for (const open of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = absolute(open[1], base);
    if (!href) continue;

    let link;
    try {
      link = new URL(href);
    } catch {
      continue;
    }

    // Same site, a real page, and not the page you are already on.
    if (link.hostname !== here.hostname) continue;
    if (IMAGE_EXT.test(link.pathname)) continue;
    if (link.pathname === here.pathname) continue;
    if (found.has(link.href)) continue;

    const from = open.index + open[0].length;
    const after = html.slice(from, from + 4000);
    const closes = after.search(/<\/a>/i);
    const inside = closes === -1 ? after : after.slice(0, closes);

    // A thumbnail inside the link is what makes it a gallery rather than a menu
    // item. Every one of these sites builds its listing that way.
    const img = /<img\b[^>]*>/i.exec(inside);
    if (!img) continue;

    const thumb = fromImg(img[0], base);
    if (!thumb || CHROME.test(new URL(thumb).pathname)) continue;

    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(img[0]);
    const text = clean(inside.replace(/<[^>]*>/g, ' '));

    found.set(link.href, {
      url: link.href,
      thumb,
      title: clean(alt?.[1] || '') || text || nameFromUrl(link.href),
    });
  }

  const galleries = [...found.values()];

  /* Remembered, so the proxy and the reader accept them. */
  remember(galleries.map((g) => ({ url: g.url, thumb: g.thumb })), base);

  return { source: base, galleries };
}

export async function fromPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`${new URL(url).hostname} -> ${res.status}`);

  const type = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(type)) {
    /* A direct image link is a gallery of one. Still remembered. */
    if (/^image\//i.test(type)) {
      const one = [candidate(res.url || url, res.url || url, 'image')];
      one[0].pick = true;
      remember(one, null);
      return { title: nameFromUrl(url), source: res.url || url, candidates: one };
    }
    throw new Error(`That URL is ${type.split(';')[0] || 'not a web page'}, not a page with images on it.`);
  }

  const html = await res.text();
  const base = res.url || url;

  const found = new Map(); // full-size url -> candidate
  const keep = (full, thumb, why) => {
    if (!full || found.has(full)) return;
    if (!/^https?:/i.test(full)) return;
    if (CHROME.test(new URL(full).pathname)) return;
    found.set(full, candidate(full, thumb, why));
  };

  /*
   * 1. Anchors pointing straight at an image: the full-size picture.
   *    Matched on their own, not inside a captured <a>…</a>: a long srcset
   *    would overrun the capture and lose the link.
   */
  const leads = [];
  let order = 0;

  for (const open of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = absolute(open[1], base);
    if (!href) continue;

    const from = open.index + open[0].length;
    const after = html.slice(from, from + 4000);
    const closes = after.search(/<\/a>/i);
    const inside = closes === -1 ? after : after.slice(0, closes);

    const img = /<img\b[^>]*>/i.exec(inside);
    const thumb = img ? fromImg(img[0], base) : null;

    if (IMAGE_EXT.test(href)) {
      keep(href, thumb, 'linked full size');
      continue;
    }

    /* A same-origin thumbnail linking to a page: kept as a lead, not followed yet. */
    if (thumb && new URL(href).origin === new URL(base).origin) {
      leads.push({ href, thumb, from: base, at: order++ });
    }
  }

  // 2. og:image — what the page says its picture is.
  for (const [, tag] of html.matchAll(/<meta\b([^>]*property\s*=\s*["']og:image["'][^>]*)>/gi)) {
    keep(absolute(attr(tag, 'content'), base), null, 'og:image');
  }

  // 3. Remaining <img>s, for pages that link nothing. keep() drops repeats.
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = fromImg(tag, base);
    if (!src || /^data:/i.test(src) || /\.svg(\?|#|$)/i.test(src)) continue;
    keep(src, src, 'on the page');
  }

  /*
   * No full-size links but many thumbnail pages: follow the ones under the
   * gallery's own URL. Others are ads for other galleries.
   */
  if (![...found.values()].some((c) => c.why === 'linked full size') && leads.length > 1) {
    const here = new URL(base).pathname;
    const mine = leads.filter((l) => l.href !== base && new URL(l.href).pathname.startsWith(here));

    if (mine.length > 1) {
      for (const { full, thumb } of await follow(mine)) keep(full, thumb, 'from its own page');
    }
  }

  const candidates = [...found.values()].slice(0, 300);
  remember(candidates, base);

  /*
   * What starts ticked: everything, unless the page linked full-size
   * pictures — then only those.
   */
  const linked = candidates.filter((c) => c.why === 'linked full size');
  const followed = candidates.filter((c) => c.why === 'from its own page');
  for (const c of linked.length ? linked : followed.length ? followed : candidates) c.pick = true;

  return { title: pageTitle(html) || nameFromUrl(url), source: base, candidates };
}

function candidate(url, thumb, why) {
  return { url, thumb: thumb || url, why, kind: why, size: null, pick: false };
}

function pageTitle(html) {
  const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i.exec(html);
  if (og) {
    const value = attr(og[0], 'content');
    if (value) return clean(value);
  }
  const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return title ? clean(title[1]) : null;
}

const clean = (text) =>
  String(text)
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

function nameFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const last = parts.pop() || new URL(url).hostname;
    return clean(last.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_]+/g, ' '));
  } catch {
    return 'Gallery';
  }
}

/* The TPDB sources. The caller gets back the scene or performer to tie to. */
export async function fromScene(config, guid) {
  const found = await tpdb.sceneImages(config, guid);
  if (!found) throw new Error('ThePornDB has no scene with that id.');
  return shape(found, `https://theporndb.net/scenes/${guid}`);
}

export async function fromPerformer(config, uuid) {
  const found = await tpdb.performerImages(config, uuid);
  if (!found) throw new Error('ThePornDB has no performer with that id.');
  return shape(found, `https://theporndb.net/performers/${uuid}`);
}

function shape(found, source) {
  const candidates = found.images.map((i) => ({
    url: i.url,
    thumb: i.url,
    why: i.kind,
    kind: i.kind,
    size: i.size ?? null,
  }));

  remember(candidates, source);

  /* Nothing ticked: a scene's images are versions of one picture. */
  return { title: found.title, date: found.date || null, source, candidates };
}
