/*
 * Where the pictures come from.
 *
 * Three sources, one shape out: a list of candidates with a full-size URL and
 * something to show in the picker. Nothing here downloads anything — finding
 * is separate from fetching on purpose, because every one of these lists gets
 * looked at and cut down before a single file is written. gallerybuild.mjs
 * does the writing.
 *
 * Two of the three are ThePornDB, which the portal already has a token for.
 * The third is an ordinary web page: fetched once, read for images, and never
 * crawled — this follows no links and visits no page but the one it is given.
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

/*
 * What the picker is allowed to show and the builder to fetch. Same device as
 * the movie gap-filler's artwork proxy: only URLs this module has already
 * offered can be asked for, so neither the thumbnail proxy nor the build can
 * be pointed at something on the network by hand.
 */
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

/*
 * Page furniture, by the only signal available before anything is downloaded.
 * Deliberately short: a false positive here silently drops a picture, and the
 * size check after the download catches the rest of the chrome anyway.
 */
const CHROME = /(logo|favicon|sprite|avatar|banner|button|placeholder|spacer|header|footer|1x1|pixel|\/ads?\/|doubleclick)/i;

const absolute = (href, base) => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

/*
 * The biggest entry in a srcset, by reading the descriptors rather than taking
 * the last one. Ascending order is the convention and it is not a rule —
 * elitebabes writes "…_w800.jpg 800w, …_w600.jpg 600w", so "last" there is the
 * smallest picture on the page, which is how this shipped grabbing thumbnails.
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
 * Following a thumbnail to its own page.
 *
 * The second shape of photo-set page, and the one that made this look
 * site-specific: girlsofdesire wraps each thumbnail in a link to a page *about*
 * that photo rather than to the photo. Nothing on the gallery page is the
 * full-size picture at all, so there is no reading it harder — the link has to
 * be followed.
 *
 * Only ever one level, only pages under the gallery's own URL, and capped. A
 * set is tens of pictures; anything that wants hundreds of fetches is not a
 * gallery and should not be treated as one.
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
   * The set's own directory is the strongest signal by a mile: the thumbnail
   * came from it, and the picture this page exists to show is the other file
   * sitting beside it. og:image and "the first one left" are the fallbacks for
   * pages that keep their pictures somewhere else.
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
 * One page, read for pictures.
 *
 * The useful structure on a photo-set page is an <a> pointing at the full-size
 * image wrapped around an <img> of the thumbnail, which is how most galleries
 * of this shape are built. So anchors are read first and keep their thumbnail;
 * bare <img>s are picked up after, for pages that have no such link — along
 * with the lazy-loading attributes, since plenty of galleries never put a real
 * src on the page until you scroll.
 */
/* ------------------------------------------------------- listing pages
 *
 * The step before fromPage: a performer's page on one of these sites is not a
 * gallery, it is a list of them. Pointing the picture scraper at one gets you
 * the site's chrome and twenty thumbnails with nothing behind them, which is
 * exactly what it looked like when the Images page appeared to do nothing.
 *
 * Deliberately generic, the same way fromPage is. No per-site paths, because
 * the shape is the same everywhere and the paths are not: a gallery link is an
 * anchor on the same host that wraps a thumbnail. Measured against a real
 * performer page — pornpics gives twenty under /galleries/, girlsofdesire the
 * same under its own — and a site that hides its list behind JavaScript gives
 * none, which the page then says rather than showing an empty grid.
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

  /*
   * Remembered like any other find, so the thumbnail proxy will serve these
   * and the reader will accept them. Same rule as everywhere else here: only a
   * URL this module offered can be fetched.
   */
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
    /*
     * A link straight to a .jpg is a gallery of one, and worth allowing. It
     * still has to be remembered like any other find — everything downstream
     * refuses a URL this module has not offered, including the results of this
     * branch.
     */
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
   * 1. Anchors pointing straight at an image. This is the full-size picture on
   *    a photo-set page, and the whole reason to prefer a link over the <img>
   *    beside it.
   *
   *    The link is taken on its own rather than out of a captured <a>…</a>
   *    body: a single <img> with a long srcset runs to hundreds of characters,
   *    so any cap on that capture quietly loses the link and leaves the
   *    thumbnail behind. The thumbnail is then looked for separately, and only
   *    so the picker has something to show.
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

    /*
     * A thumbnail linking at something that is not an image: a page about that
     * one picture. Kept as a lead rather than followed here — most pages carry
     * dozens of links like this and only some of them are the set.
     */
    if (thumb && new URL(href).origin === new URL(base).origin) {
      leads.push({ href, thumb, from: base, at: order++ });
    }
  }

  // 2. og:image — what the page says its picture is.
  for (const [, tag] of html.matchAll(/<meta\b([^>]*property\s*=\s*["']og:image["'][^>]*)>/gi)) {
    keep(absolute(attr(tag, 'content'), base), null, 'og:image');
  }

  // 3. Everything left in an <img>, for pages that link to nothing. Already
  //    covered pictures fall out here, since a linked one is keyed on the
  //    full-size URL and keep() drops a repeat.
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = fromImg(tag, base);
    if (!src || /^data:/i.test(src) || /\.svg(\?|#|$)/i.test(src)) continue;
    keep(src, src, 'on the page');
  }

  /*
   * Nothing on the page was a full-size picture, but plenty of thumbnails each
   * pointed at a page. Follow those — see follow() above for why a site built
   * that way cannot be read any harder.
   *
   * Leads under the gallery's own URL are the set. Everything else that links
   * a thumbnail is a different gallery being advertised down the side, and
   * following those would fill this one with somebody else's pictures.
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
   * What starts ticked.
   *
   * A photo-set page is normally all of it, so everything is ticked and you
   * untick the odd one — unless the page linked its full-size pictures, in
   * which case those *are* the set and everything else is furniture. That page
   * of Melody Marks links 20 and carries another 92 thumbnails for other
   * galleries down the side; ticking all 112 is not what anyone meant.
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

/*
 * The two ThePornDB sources. Same shape out, and both already have somewhere
 * to be tied to — the scene or the performer they came from — so the caller
 * gets that back rather than having to ask for it again.
 */
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

  /*
   * Nothing ticked to start with. A scene's images are several versions of the
   * same picture — the still, the uncropped background, then the watermarked
   * crops TPDB generates from it — so this is a list to choose from rather
   * than a set to take.
   */
  return { title: found.title, date: found.date || null, source, candidates };
}
