/*
 * Reddit, for performers whose Stash URLs include a Reddit address.
 *
 * Only the Atom feeds work (`/r/x/new.rss`, `/user/x/submitted.rss`); the
 * JSON API returns 403 and old.reddit a block page. The feeds allow a few
 * requests a minute, then far fewer. i.redd.it and preview.redd.it aren't
 * limited. So this is a slow poller with a cache: the page reads the cache
 * and never waits on Reddit. Unauthenticated, so no credential to leak.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { gql } from './stash.mjs';
import * as redgifs from './redgifs.mjs';
import { page as pageOf } from './shuffle.mjs';

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'reddit.json');

// A browser's User-Agent gets no further than a bare one on the feeds, so this
// says what it is. The media hosts do not care either way.
const UA = 'tpdbarr/0.1 (+https://github.com/; personal media library)';

// One feed at a time, this far apart, when Reddit is answering. The backoff
// below is what handles it when Reddit is not.
const PACE = 25000;

// How long a walk of every source stays fresh before the page offers another.
const STALE_MS = 6 * 60 * 60 * 1000;

/* On a 429, wait and retry the same source, doubling up to the cap. */
const BACKOFF_MS = 5 * 60 * 1000;
const BACKOFF_MAX = 60 * 60 * 1000;

// Posts kept per source. The feeds themselves only carry 25.
const KEEP = 25;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------- store

let state = null;

const empty = () => ({ at: 0, cursor: 0, blockedUntil: 0, posts: [], walked: {}, extra: [] });

async function load() {
  if (state) return state;

  try {
    const parsed = JSON.parse(await readFile(PATH, 'utf8'));
    state = {
      at: Number(parsed.at) || 0,
      cursor: Number(parsed.cursor) || 0,
      blockedUntil: Number(parsed.blockedUntil) || 0,
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      walked: parsed.walked && typeof parsed.walked === 'object' ? parsed.walked : {},
      // Followed by hand rather than found on a performer. A walk never
      // rewrites this, so a bad pass cannot lose them.
      extra: Array.isArray(parsed.extra) ? parsed.extra : [],
    };
  } catch {
    state = empty();
  }

  return state;
}

async function save() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(PATH, JSON.stringify(state, null, 2), 'utf8');
}

export const forget = () => { state = null; };

// ----------------------------------------------------------------- sources

/* User or subreddit feed for a Reddit URL; anything else is skipped. */
function feedFor(url) {
  const clean = String(url || '').split('?')[0].replace(/\/+$/, '');

  const user = clean.match(/reddit\.com\/(?:user|u)\/([A-Za-z0-9_\-]{2,40})$/i);
  if (user) {
    return { kind: 'user', handle: user[1], feed: `https://www.reddit.com/user/${user[1]}/submitted.rss?limit=${KEEP}` };
  }

  const sub = clean.match(/reddit\.com\/r\/([A-Za-z0-9_]{2,40})$/i);
  if (sub) {
    return { kind: 'sub', handle: sub[1], feed: `https://www.reddit.com/r/${sub[1]}/new.rss?limit=${KEEP}` };
  }

  return null;
}

let sourceCache = null;

/* Sources from the library. The same address on two performers is followed once. */
export async function sources(config, { force = false } = {}) {
  if (!force && sourceCache && Date.now() - sourceCache.at < 60 * 60 * 1000) return sourceCache.list;

  const store = await load();
  const data = await gql(config, '{ findPerformers(filter: {per_page: -1}) { performers { id name urls } } }');

  const seen = new Set();
  const list = [];

  const add = (parsed, performerId, performerName, byHand) => {
    const key = parsed.kind + ':' + parsed.handle.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ ...parsed, key, performerId, performerName, byHand: Boolean(byHand) });
  };

  for (const performer of data.findPerformers?.performers || []) {
    for (const url of performer.urls || []) {
      const parsed = feedFor(url);
      if (parsed) add(parsed, performer.id, performer.name, false);
    }
  }

  /* Hand-followed sources after the performers, so performer names win. */
  for (const raw of store.extra) {
    const parsed = feedFor(raw);
    if (parsed) add(parsed, null, (parsed.kind === 'sub' ? 'r/' : 'u/') + parsed.handle, true);
  }

  list.sort((a, b) => a.performerName.localeCompare(b.performerName));
  sourceCache = { at: Date.now(), list };
  return list;
}

/* Follow by hand: a URL, `r/name`, `u/name`, or a bare name (read as a subreddit). */
export async function follow(config, input) {
  const text = String(input || '').trim();
  if (!text) throw Object.assign(new Error('Nothing to follow.'), { status: 400 });

  const path = /^(r|u|user)\//i.test(text) ? text.replace(/^u\//i, 'user/') : 'r/' + text;
  const url = /reddit\.com\//i.test(text) ? text : 'https://www.reddit.com/' + path;

  const parsed = feedFor(url);
  if (!parsed) throw Object.assign(new Error('Not a subreddit or a user: ' + text), { status: 400 });

  const store = await load();
  const already = store.extra.some((raw) => {
    const other = feedFor(raw);
    return other && other.kind === parsed.kind && other.handle.toLowerCase() === parsed.handle.toLowerCase();
  });

  if (already) return { followed: parsed.handle, kind: parsed.kind, already: true };

  store.extra.push(url);
  sourceCache = null;
  await save();

  /* Rewind the cursor to the new source so it's read next. */
  const list = await sources(config, { force: true });
  const at = list.findIndex((source) => source.key === parsed.key);
  if (at >= 0 && at < store.cursor) store.cursor = at;
  await save();

  return { followed: parsed.handle, kind: parsed.kind, already: false };
}

export async function unfollow(handle) {
  const wanted = String(handle || '').toLowerCase();
  const store = await load();
  const before = store.extra.length;

  store.extra = store.extra.filter((raw) => {
    const parsed = feedFor(raw);
    return !parsed || parsed.handle.toLowerCase() !== wanted;
  });

  if (store.extra.length !== before) {
    // Its posts go with it, otherwise unfollowing changes nothing you can see.
    store.posts = store.posts.filter((post) => post.handle.toLowerCase() !== wanted);
    sourceCache = null;
    await save();
  }

  return { removed: before - store.extra.length };
}

// ------------------------------------------------------------------- atom

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

function decode(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => ENTITIES[name]);
}

const pick = (entry, tag) => decode((entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '');

/*
 * The full-size picture is in the escaped HTML table, as the `[link]`
 * href. Galleries keep their thumbnail (each picture would cost a request).
 */
function entries(xml, source) {
  const out = [];

  for (const block of xml.split('<entry>').slice(1)) {
    const id = pick(block, 'id').replace(/^t3_/, '');
    if (!id) continue;

    const html = pick(block, 'content');
    const link = (html.match(/href="([^"]+)"[^>]*>\s*\[link\]/) || [])[1] || '';
    const thumb = decode((block.match(/<media:thumbnail\s+url="([^"]+)"/) || [])[1] || '');

    const direct = /^https:\/\/i\.redd\.it\//i.test(link);
    const gallery = /^https:\/\/(www\.)?reddit\.com\/gallery\//i.test(link);

    out.push({
      id,
      source: source.key,
      performerId: source.performerId,
      performerName: source.performerName,
      handle: source.handle,
      kind: source.kind,
      title: pick(block, 'title'),
      author: pick(block, 'name'),
      at: Date.parse(pick(block, 'published')) || 0,
      // Where the post lives, for the one case this cannot show inline.
      permalink: decode((block.match(/<link\s+href="([^"]+)"\s*\/>/) || [])[1] || ''),
      thumb: thumb || null,
      full: direct ? link : null,
      gallery,
      // Linked elsewhere or text: say so rather than show an empty tile.
      external: !direct && !gallery && /^https?:/i.test(link) ? link : null,
    });
  }

  return out;
}

// ---------------------------------------------------------------- redgifs

/*
 * RedGIFs links, where most of the video is. Anonymous token (about a
 * day); media needs no token or Referer.
 */

const REDGIFS_ID = /(?:redgifs\.com)\/(?:watch|ifr|i)\/([A-Za-z0-9]+)/i;

/* Resolve a batch, one at a time, failing quietly. */
async function resolveRedgifs(posts) {
  for (const post of posts) {
    const id = (String(post.external || '').match(REDGIFS_ID) || [])[1];
    if (!id) continue;

    try {
      const gif = await redgifs.gif(id);
      if (!gif?.video) continue;

      post.video = gif.video;
      post.poster = gif.poster;
      post.seconds = gif.seconds;
      // It has a picture now, so the tile stops apologising for the link.
      if (!post.thumb) post.thumb = gif.poster;
    } catch {
      // A gif that will not resolve stays a link. Not worth a retry here.
    }
  }
}

// --------------------------------------------------------------- allowlist

/* Only URLs this module offered can go through the proxy. */
const MAX_KNOWN = 6000;
const offered = new Set();

function remember(posts) {
  if (offered.size >= MAX_KNOWN) offered.clear();
  for (const post of posts) {
    if (post.thumb) offered.add(post.thumb);
    if (post.full) offered.add(post.full);
    if (post.video) offered.add(post.video);
    if (post.poster) offered.add(post.poster);
  }
}

export const isKnown = (url) => offered.has(url);

export const headers = () => ({
  'User-Agent': UA,
  Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8',
});

// ------------------------------------------------------------------- walk

let walking = null;

export const running = () => Boolean(walking);

async function fetchFeed(source) {
  const res = await fetch(source.feed, {
    headers: { 'User-Agent': UA, Accept: 'application/atom+xml, application/xml' },
    signal: AbortSignal.timeout(25000),
  });

  if (res.status === 429) return { limited: true };
  if (!res.ok) return { failed: res.status };

  const body = await res.text();
  // A 200 with nothing in it is what the limiter does before it starts saying
  // 429, so it is treated as the same answer.
  if (body.length < 200) return { limited: true };

  return { posts: entries(body, source) };
}

/*
 * One pass over the sources from where the last stopped. Hours on a cold
 * start; the page reads the cache meanwhile.
 */
async function walk(config) {
  const store = await load();
  const list = await sources(config);
  if (!list.length) return;

  if (store.cursor >= list.length) store.cursor = 0;

  let backoff = BACKOFF_MS;

  while (store.cursor < list.length) {
    const source = list[store.cursor];
    let result;

    try {
      result = await fetchFeed(source);
    } catch (err) {
      result = { failed: err.message };
    }

    if (result.limited) {
      /* Wait on the same source; the cursor doesn't move. */
      store.blockedUntil = Date.now() + backoff;
      await save();
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
      store.blockedUntil = 0;
      continue;
    }

    // A source that answered means the budget is back; the next refusal starts
    // its own climb rather than inheriting this one's.
    backoff = BACKOFF_MS;

    store.cursor += 1;
    store.walked[source.key] = Date.now();

    if (result.posts?.length) {
      await resolveRedgifs(result.posts);
      remember(result.posts);
      const fresh = new Set(result.posts.map((p) => p.id));
      store.posts = [
        ...result.posts,
        ...store.posts.filter((p) => p.source !== source.key || !fresh.has(p.id)),
      ];
      // Keep the file from growing without end: newest first, capped.
      store.posts.sort((a, b) => b.at - a.at);
      store.posts = store.posts.slice(0, KEEP * 80);
    }

    if (store.cursor >= list.length) store.at = Date.now();
    await save();

    if (store.cursor < list.length) await sleep(PACE);
  }
}

/* Resolve RedGIFs links already in the cache without waiting for a full pass. */
let catching = null;

export function catchUp() {
  if (catching) return catching;

  catching = (async () => {
    const store = await load();
    const waiting = store.posts.filter((post) => !post.video && REDGIFS_ID.test(String(post.external || '')));
    if (!waiting.length) return 0;

    let done = 0;
    for (const post of waiting) {
      await resolveRedgifs([post]);
      if (post.video) done += 1;
      await sleep(300);
    }

    remember(store.posts);
    await save();
    return done;
  })()
    .catch((err) => { console.error('[tpdbarr] redgifs catch-up', err); return 0; })
    .finally(() => { catching = null; });

  return catching;
}

export function refresh(config) {
  if (walking) return walking;
  walking = walk(config)
    .catch((err) => { console.error('[tpdbarr] reddit walk', err); })
    .finally(() => { walking = null; });
  return walking;
}

// ------------------------------------------------------------------- reads

/*
 * Reddit in the reel: one post per MIX_EVERY library clips, chosen by page
 * so scrolling back is stable. Only posts with something to show.
 */
const MIX_EVERY = 4;

export async function mixInto(base, { page = 1, take: want = 0, offset = 0, seed = '1' } = {}) {
  const store = await load();

  const usable = store.posts.filter((post) => post.video || post.full || post.thumb);
  if (!usable.length) return base;

  /* Per-page count, shared out when several sources ride along. */
  const take = want || Math.max(1, Math.round(base.items.length / MIX_EVERY));

  /* Dealt from the visit's seed (see shuffle.mjs). */
  const slice = pageOf(usable, seed, page, take);
  if (!slice.length) return base;

  remember(slice);

  const items = [...base.items];

  slice.forEach((post, i) => {
    const at = Math.min(items.length, (i + 1) * MIX_EVERY + i + offset);
    items.splice(at, 0, toItem(post));
  });

  return { ...base, items };
}

/* One post as the reel draws it, shared by the mix and the feed. */
function toItem(post) {
  return {
    kind: 'reddit',
    id: post.id,
    title: post.title,
    // The handle reads as the reel's tag chip does, which is what it is: where
    // this came from.
    tag: (post.kind === 'sub' ? 'r/' : 'u/') + post.handle,
    handle: post.handle,
    performerId: post.performerId,
    performerName: post.performerName,
    permalink: post.permalink,
    gallery: Boolean(post.gallery),
    at: post.at,
    video: post.video || null,
    poster: post.poster || null,
    art: post.full || post.thumb || null,
    seconds: post.seconds || 0,
  };
}

/* The Reddit-only feed. */
export async function feed({ page = 1, take = 12, seed = '1' } = {}) {
  const store = await load();
  const usable = store.posts.filter((post) => post.video || post.full || post.thumb);
  const slice = pageOf(usable, seed, page, take);

  remember(slice);

  return {
    items: slice.map(toItem),
    count: usable.length,
    page,
    done: !usable.length,
  };
}

export async function view(config, { performerId = null, limit = 120 } = {}) {
  const store = await load();
  const list = await sources(config).catch(() => []);

  // Everything on the page can be fetched through the proxy, including on a
  // cold start where nothing has been walked this run.
  remember(store.posts);

  const posts = (performerId ? store.posts.filter((p) => p.performerId === performerId) : store.posts).slice(0, limit);

  return {
    posts,
    at: store.at,
    stale: !store.at || Date.now() - store.at > STALE_MS,
    running: running(),
    // What a walk has left to do, so the page can say so rather than looking
    // stuck for half an hour.
    walked: Math.min(store.cursor, list.length),
    total: list.length,
    blockedUntil: store.blockedUntil > Date.now() ? store.blockedUntil : 0,
    performers: list.map((s) => ({ id: s.performerId, name: s.performerName, handle: s.handle, kind: s.kind, byHand: s.byHand })),
  };
}
