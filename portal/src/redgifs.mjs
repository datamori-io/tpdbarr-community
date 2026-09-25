/*
 * RedGIFs: creators and tags, pulled directly. All video, no account (the
 * API hands out a temporary token), and more generous limits than Reddit —
 * but a 429 is still a real answer and is told apart from "nothing there".
 *
 * Creators are seeded from Reddit handles on the library's performers,
 * each verified first. Tags are added by hand.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { page as pageOf } from './shuffle.mjs';

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'redgifs.json');

const API = 'https://api.redgifs.com/v2';
const UA = 'tpdbarr/0.1';

// Twenty is what the API returns per page whatever you ask for.
const PER_PAGE = 20;

/* Pages per source per pass (twenty each), deep enough that passes find new clips. */
const PAGES = 12;

/* On a rate limit, wait on the source rather than skip it. */
const LIMIT_WAIT = 45000;
const LIMIT_TRIES = 3;

// Politeness, not necessity. Nothing here has complained at this pace.
const PACE = 400;

// How long a pass stays fresh before the page offers another.
const STALE_MS = 6 * 60 * 60 * 1000;

// The most gifs kept. Well past what anyone scrolls in a sitting.
const KEEP = 4000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------- token

/* Anonymous token, good for about a day. Refreshed on 401. */
let token = null;

export async function auth(force = false) {
  if (token && !force) return token;

  const res = await fetch(`${API}/auth/temporary`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error('redgifs auth ' + res.status);

  token = (await res.json()).token || null;
  return token;
}

/* A rate limit as a value, so it isn't mistaken for "no results". */
export const LIMITED = Symbol('redgifs rate limited');

const RETRIES = 2;
const RETRY_MS = 6000;

async function ask(path, { auths = true, tries = RETRIES } = {}) {
  const key = await auth();
  if (!key) return null;

  const res = await fetch(API + path, {
    headers: { 'User-Agent': UA, Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(25000),
  });

  if (res.status === 401 && auths) {
    await auth(true);
    return ask(path, { auths: false, tries });
  }

  if (res.status === 429) {
    if (tries <= 0) return LIMITED;
    await sleep(RETRY_MS);
    return ask(path, { auths, tries: tries - 1 });
  }

  if (!res.ok) return null;
  return res.json();
}

/* One gif by id; reddit.mjs uses it for RedGIFs links in posts. */
export async function gif(id) {
  const body = await ask('/gifs/' + id);
  if (body === LIMITED) return null;
  const found = body?.gif;
  if (!found?.urls) return null;

  return {
    // The mobile cut, not the HD one: this plays in a phone-shaped frame, and
    // the HD file is several times the size for no visible gain.
    video: found.urls.sd || found.urls.hd || null,
    poster: found.urls.poster || found.urls.thumbnail || null,
    seconds: Math.round(found.duration || 0),
  };
}

// ------------------------------------------------------------------- store

let state = null;

const empty = () => ({ at: 0, creators: [], tags: [], gifs: [], seeded: false, last: null });

async function load() {
  if (state) return state;

  try {
    const parsed = JSON.parse(await readFile(PATH, 'utf8'));
    state = {
      at: Number(parsed.at) || 0,
      creators: Array.isArray(parsed.creators) ? parsed.creators : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      gifs: Array.isArray(parsed.gifs) ? parsed.gifs : [],
      seeded: Boolean(parsed.seeded),
      last: parsed.last && typeof parsed.last === 'object' ? parsed.last : null,
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

// --------------------------------------------------------------- allowlist

/* Only URLs this module offered can go through the proxy. */
const MAX_KNOWN = 20000;
const offered = new Set();

function remember(gifs) {
  if (offered.size >= MAX_KNOWN) offered.clear();
  for (const item of gifs) {
    if (item.video) offered.add(item.video);
    if (item.poster) offered.add(item.poster);
  }
}

export const isKnown = (url) => offered.has(url);

export const headers = () => ({
  'User-Agent': UA,
  Accept: 'video/mp4,image/avif,image/webp,image/jpeg,*/*;q=0.8',
});

// ------------------------------------------------------------------ shapes

function card(raw, source) {
  return {
    id: raw.id,
    source,
    creator: raw.userName || null,
    title: raw.description || null,
    tags: (raw.tags || []).slice(0, 8),
    seconds: Math.round(raw.duration || 0),
    sound: Boolean(raw.hasAudio),
    width: raw.width || 0,
    height: raw.height || 0,
    at: (raw.createDate || 0) * 1000,
    link: 'https://www.redgifs.com/watch/' + raw.id,
    video: raw.urls?.sd || raw.urls?.hd || null,
    poster: raw.urls?.poster || raw.urls?.thumbnail || null,
  };
}

// ------------------------------------------------------------------ pulling

// null when we were turned away, an array — possibly empty — when we were not.
async function page(path) {
  const body = await ask(path);
  if (body === LIMITED) return null;
  return Array.isArray(body?.gifs) ? body.gifs : [];
}

/* A page, waiting out rate limits. Null only once waiting is given up. */
async function pageOrWait(path) {
  for (let attempt = 0; attempt <= LIMIT_TRIES; attempt += 1) {
    const gifs = await page(path);
    if (gifs) return gifs;
    if (attempt === LIMIT_TRIES) return null;
    await sleep(LIMIT_WAIT);
  }
  return null;
}

async function pullCreator(name) {
  const out = [];
  for (let p = 1; p <= PAGES; p += 1) {
    const gifs = await pageOrWait(`/users/${encodeURIComponent(name)}/search?order=recent&count=${PER_PAGE}&page=${p}`);
    if (!gifs) return { gifs: out, limited: true };
    out.push(...gifs.map((raw) => card(raw, 'creator:' + name.toLowerCase())));
    if (gifs.length < PER_PAGE) break;
    await sleep(PACE);
  }
  return { gifs: out, limited: false };
}

/*
 * Pull a tag with `tags=`, not `search_text=` (which returns loosely
 * related clips). `latest`, since `trending` returns almost nothing.
 */
async function pullTag(tag) {
  const out = [];
  for (let p = 1; p <= PAGES; p += 1) {
    const gifs = await pageOrWait(`/gifs/search?tags=${encodeURIComponent(tag)}&order=latest&count=${PER_PAGE}&page=${p}`);
    if (!gifs) return { gifs: out, limited: true };
    out.push(...gifs.map((raw) => card(raw, 'tag:' + tag.toLowerCase())));
    if (gifs.length < PER_PAGE) break;
    await sleep(PACE);
  }
  return { gifs: out, limited: false };
}

/* RedGIFs' suggest endpoint confirms a tag and its capitalisation. */
async function suggest(text) {
  const body = await ask(`/search/suggest?query=${encodeURIComponent(text)}`);
  if (body === LIMITED) return LIMITED;

  const raw = Array.isArray(body) ? body : body?.tags || body?.items || [];
  return raw.map((entry) => (typeof entry === 'string' ? entry : entry?.text || entry?.name || '')).filter(Boolean);
}

export async function exists(name) {
  const body = await ask(`/users/${encodeURIComponent(String(name).toLowerCase())}/search?order=recent&count=1`);
  // Turned away is not the same as "no such creator", and adopting that
  // distinction is the difference between seeding eighteen and seeding none.
  if (body === LIMITED) throw Object.assign(new Error('RedGIFs is rate limiting. Try again shortly.'), { status: 503 });

  const total = body?.total ?? (body?.gifs || []).length;
  return total ? { name: String(name).toLowerCase(), gifs: total } : null;
}

/* Seed creators from the library's Reddit handles, each tried once. */
export async function seed(handles = []) {
  const store = await load();

  const known = new Set(store.creators.map((c) => c.name));
  let found = 0;

  for (const source of handles) {
    const name = String(source.handle || '').toLowerCase();
    if (!name) continue;
    if (known.has(name)) continue;
    known.add(name);

    let hit = null;
    try {
      hit = await exists(name);
    } catch (err) {
      // Rate limited: stop, stay unseeded, try again next pass.
      if (err.status === 503) return found;
      hit = null;
    }

    if (hit) {
      store.creators.push({ name: hit.name, gifs: hit.gifs, from: source.performerName, byHand: false });
      found += 1;
    }

    await sleep(PACE);
  }

  /* Only mark seeded if someone was found; zero usually means refused. */
  if (handles.length && found) store.seeded = true;
  await save();
  return found;
}

// -------------------------------------------------------------------- pass

let running = null;

export const busy = () => Boolean(running);

async function pass(handles) {
  const store = await load();

  /*
   * Re-seed when there are handles but no creators; a pass with no handles
   * once set the flag on an empty list.
   */
  if (handles.length && !store.creators.length) store.seeded = false;
  if (!store.seeded) await seed(handles);

  const before = store.gifs.length;
  let read = 0;
  let limited = 0;

  /* Saved after every source, so an interrupted pass keeps its clips. */
  const fold = async (gifs) => {
    if (!gifs.length) return;

    const seen = new Map();
    // Newest first, and a gif reached from both a creator and a tag is one
    // gif, credited to whichever found it first.
    for (const item of [...gifs, ...store.gifs]) {
      if (!item.video) continue;
      if (!seen.has(item.id)) seen.set(item.id, item);
    }

    store.gifs = [...seen.values()].sort((a, b) => b.at - a.at).slice(0, KEEP);
    remember(store.gifs);
    await save();
  };

  const take = async (label, pull) => {
    try {
      const result = await pull();
      await fold(result.gifs);
      if (result.limited) limited += 1;
      else read += 1;
    } catch {
      // One source that has gone away is not a reason to stop the pass.
    }
    await sleep(PACE);
  };

  for (const creator of store.creators) await take(creator.name, () => pullCreator(creator.name));
  for (const tag of store.tags) await take(tag, () => pullTag(tag));

  /* What the pass managed, so the page can say so. */
  store.last = { at: Date.now(), read, limited, added: store.gifs.length - before };
  store.at = Date.now();
  await save();
  return store.gifs.length;
}

export function refresh(handles = []) {
  if (running) return running;
  running = pass(handles)
    .catch((err) => { console.error('[tpdbarr] redgifs pass', err); })
    .finally(() => { running = null; });
  return running;
}

// ------------------------------------------------------------------ lists

export async function follow(name) {
  const wanted = String(name || '').trim().replace(/^.*redgifs\.com\/users\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!wanted) throw Object.assign(new Error('Nothing to follow.'), { status: 400 });

  const store = await load();
  if (store.creators.some((c) => c.name === wanted)) return { followed: wanted, already: true };

  const hit = await exists(wanted);
  if (!hit) throw Object.assign(new Error(`RedGIFs has no creator called ${wanted}.`), { status: 404 });

  store.creators.push({ name: hit.name, gifs: hit.gifs, from: null, byHand: true });
  await save();
  return { followed: hit.name, gifs: hit.gifs, already: false };
}

export async function unfollow(name) {
  const wanted = String(name || '').toLowerCase();
  const store = await load();
  const before = store.creators.length;

  store.creators = store.creators.filter((c) => c.name !== wanted);
  if (store.creators.length !== before) {
    store.gifs = store.gifs.filter((g) => g.source !== 'creator:' + wanted);
    await save();
  }

  return { removed: before - store.creators.length };
}

export async function addTag(tag) {
  const wanted = String(tag || '').trim();
  if (!wanted) throw Object.assign(new Error('Nothing to add.'), { status: 400 });

  const store = await load();
  if (store.tags.some((t) => t.toLowerCase() === wanted.toLowerCase())) return { tag: wanted, already: true };

  /* Check the tag with RedGIFs, catching typos and fixing spelling. */
  const hints = await suggest(wanted);
  if (hints === LIMITED) throw Object.assign(new Error('RedGIFs is rate limiting. Try again shortly.'), { status: 503 });
  if (!hints.length) throw Object.assign(new Error(`RedGIFs has no tag called "${wanted}".`), { status: 404 });

  const lower = wanted.toLowerCase();
  // Their spelling of what you typed if they have one, otherwise their best
  // suggestion — which is how "redhead" becomes "Redhead".
  const canonical = hints.find((hint) => hint.toLowerCase() === lower) || hints[0];

  if (store.tags.some((t) => t.toLowerCase() === canonical.toLowerCase())) {
    return { tag: canonical, already: true };
  }

  store.tags.push(canonical);
  await save();
  return { tag: canonical, already: false, suggested: canonical.toLowerCase() !== lower ? hints : null };
}

export async function removeTag(tag) {
  const wanted = String(tag || '').toLowerCase();
  const store = await load();
  const before = store.tags.length;

  store.tags = store.tags.filter((t) => t.toLowerCase() !== wanted);
  if (store.tags.length !== before) {
    store.gifs = store.gifs.filter((g) => g.source !== 'tag:' + wanted);
    await save();
  }

  return { removed: before - store.tags.length };
}

// ------------------------------------------------------------------- reads

export async function view({ limit = 120 } = {}) {
  const store = await load();
  remember(store.gifs);

  return {
    gifs: store.gifs.slice(0, limit),
    held: store.gifs.length,
    creators: store.creators,
    tags: store.tags,
    at: store.at,
    last: store.last,
    seeded: store.seeded,
    stale: !store.at || Date.now() - store.at > STALE_MS,
    running: busy(),
  };
}

/* RedGIFs in the reel: one per MIX_EVERY library clips. */
const MIX_EVERY = 4;

// How many followed creators get a turn before the wider site does.
const CREATORS_PER_TAG = 3;

/*
 * Three creators to one tag, so tag results (often promotion) get a turn
 * without taking over. Shared by the mix and the dedicated feed.
 */
function weave(store) {
  const withVideo = store.gifs.filter((item) => item.video);
  const fromCreators = withVideo.filter((item) => item.source.startsWith('creator:'));
  const fromTags = withVideo.filter((item) => !item.source.startsWith('creator:'));

  const out = [];
  let c = 0;
  let t = 0;

  while (c < fromCreators.length || t < fromTags.length) {
    for (let n = 0; n < CREATORS_PER_TAG && c < fromCreators.length; n += 1) out.push(fromCreators[c++]);
    if (t < fromTags.length) out.push(fromTags[t++]);
  }

  return out;
}

export async function mixInto(base, { page: at = 1, take: want = 0, offset = 0, seed = '1' } = {}) {
  const store = await load();

  const usable = weave(store);

  if (!usable.length) return base;

  /* Per-page count, shared out when several sources ride along. */
  const take = want || Math.max(1, Math.round(base.items.length / MIX_EVERY));

  /* Dealt from the visit's seed (see shuffle.mjs), not sliced off the front. */
  const slice = pageOf(usable, seed, at, take);
  if (!slice.length) return base;

  remember(slice);

  const items = [...base.items];

  slice.forEach((item, i) => {
    const where = Math.min(items.length, (i + 1) * MIX_EVERY + i + offset);
    items.splice(where, 0, toItem(item));
  });

  return { ...base, items };
}

/* One gif as the reel draws it, shared by the mix and the feed. */
function toItem(item) {
  return {
    kind: 'redgifs',
    id: item.id,
    title: item.title || item.tags.slice(0, 3).join(', ') || item.creator,
    tag: item.creator ? '@' + item.creator : 'RedGIFs',
    creator: item.creator,
    tags: item.tags,
    permalink: item.link,
    at: item.at,
    video: item.video,
    poster: item.poster,
    seconds: item.seconds,
    sound: item.sound,
    // Portrait clips are the norm here, so the reel crops these to a phone the
    // way it does a Reddit post rather than banding them like a scene.
    tall: !item.width || item.height >= item.width,
  };
}

/* The RedGIFs-only feed. `count` is the whole pool. */
export async function feed({ page: at = 1, take = 12, seed = '1' } = {}) {
  const store = await load();
  const usable = weave(store);
  const slice = pageOf(usable, seed, at, take);

  remember(slice);

  return {
    items: slice.map(toItem),
    count: usable.length,
    page: at,
    // Wrapping means it never truly ends, so the reel is told to keep going.
    done: !usable.length,
  };
}
