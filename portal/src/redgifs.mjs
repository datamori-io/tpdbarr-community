/*
 * RedGIFs.
 *
 * This started as a way to read the RedGIFs links inside Reddit posts, and
 * then the numbers made the case for going straight to the source instead.
 * Summer Hart's Reddit feed carries 25 posts, a handful of them video; her
 * RedGIFs feed carries 485, all of it video. Of fourteen Reddit handles taken
 * off the library, eight were also RedGIFs creators.
 *
 * So this pulls creators and tags directly, and it is the better source in
 * every way that matters here:
 *
 *   - It is all video, which is what a reel wants.
 *   - There is no account and no credential. The API hands a temporary token
 *     to anyone who asks, and that token reaches creator feeds, tag search,
 *     trending and niches. An account would only add your own likes and
 *     follows, which is not worth a stored password.
 *   - It rate limits far more generously than Reddit. Fourteen calls at 400ms
 *     apart drew no complaint; a few hundred in a burst does earn a 429. So a
 *     pass takes minutes rather than Reddit's afternoon, but 429 is a real
 *     answer here and everything below is careful to tell it apart from
 *     "there is nothing there" — they look identical if you only count rows.
 *
 * Creators are seeded from the Reddit handles already on the library's
 * performers, each one verified before it is adopted. Tags are assigned by
 * hand: a tag is a search, and what it pulls is whatever is newest under it.
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

/*
 * Pages per source per pass, twenty to a page. Twelve is two hundred and forty
 * of the newest from each — deep enough that a pass finds something new rather
 * than re-fetching the same shallow slice. At two, every creator sat at exactly
 * forty and a second pass added nothing at all, because it kept asking for the
 * same forty.
 */
const PAGES = 12;

/*
 * What being turned away costs. ask() already retries twice within seconds,
 * which covers a blip; this is for the budget being properly spent, and it
 * waits on the source rather than skipping it — a skipped source is a source
 * that silently contributes nothing to a pass that then calls itself done.
 */
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

/*
 * Temporary, anonymous, and good for about a day. Kept until something answers
 * 401 and then asked for again — which is the whole of the authentication
 * story here, and the reason there is no credential in this file.
 */
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

/*
 * Being turned away, as a value rather than an empty list.
 *
 * A rate-limited search and a search for something that does not exist both
 * come back with no rows. Treating them the same is how a valid tag gets
 * rejected as a typo, and how a pass quietly decides every creator has gone
 * away. So a refusal says so.
 */
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

/*
 * One gif by id. reddit.mjs uses this to turn a RedGIFs link inside a post
 * into something playable, so the token lives here and there is only one of it.
 */
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

/*
 * The same rule as everywhere else here: only a URL this module has already
 * put in front of you can be fetched through the proxy, so it is not an open
 * proxy onto the internet.
 */
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

/*
 * A page, and a wait if RedGIFs would rather we did not have it. Returns null
 * only once the waiting has been given up on, so a caller can tell "there is
 * no more" from "we were not allowed".
 */
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
 * A tag is pulled by `tags=`, not by `search_text=`.
 *
 * They look interchangeable and are not: search_text is a text search over
 * whatever RedGIFs indexes, and searching it for "redhead" returned nineteen
 * clips of which none carried the Redhead tag — Amateur, Big Tits, Teen. The
 * `tags=` parameter returned twenty of twenty carrying it. So this pulls a
 * tag, not a phrase that resembles one.
 *
 * `latest` rather than `trending`, which returns almost nothing — the ordering
 * exists but the results behind it do not.
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

/*
 * What RedGIFs would call the thing you typed. Their suggest endpoint answers
 * "redhead" with Redhead, Pale, Freckles — so it both proves a tag is real and
 * gives it the capitalisation the tag index actually uses.
 */
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

/*
 * Seeding the creator list off the library.
 *
 * No performer in Stash carries a RedGIFs address, but sixty-seven carry a
 * Reddit one — and the same person usually uses the same name in both places.
 * So every Reddit handle is tried once, and the ones that turn out to be
 * creators are adopted. Tried once and remembered: a handle that is not a
 * creator today will not be one next week either.
 */
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
      // Rate limited part-way through. Stop rather than writing off every
      // remaining handle as "not a creator" — seeded stays false, so the next
      // pass picks the list up again.
      if (err.status === 503) return found;
      hit = null;
    }

    if (hit) {
      store.creators.push({ name: hit.name, gifs: hit.gifs, from: source.performerName, byHand: false });
      found += 1;
    }

    await sleep(PACE);
  }

  /*
   * Only claim to be seeded if it actually found somebody. Finding nobody
   * across sixty-seven handles is not a library with no RedGIFs creators in
   * it — it is RedGIFs refusing to answer, which it does after a busy day. So
   * that case stays unseeded and the next pass tries again.
   */
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
   * Seed when there is nothing to seed *from*, not merely when it has never
   * been done. The `seeded` flag on its own was enough to lose every creator:
   * a pass kicked off with no handles — which is what following a creator or
   * adding a tag used to do — set the flag with an empty list, and after that
   * nothing would ever fill it again. The pool fell from 1278 clips to 489,
   * all of them tag-sourced, and the creator list read as empty.
   */
  if (handles.length && !store.creators.length) store.seeded = false;
  if (!store.seeded) await seed(handles);

  const before = store.gifs.length;
  let read = 0;
  let limited = 0;

  /*
   * Folded in and written after every source, not once at the end.
   *
   * A pass over twelve pages of twenty-two sources runs for a quarter of an
   * hour, and anything that stops the process in that time — a rebuild, most
   * often — used to throw away every clip it had gathered, because the only
   * save was the last line. Three passes were lost that way before this was
   * written. Now an interrupted pass keeps whatever it reached.
   */
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

  /*
   * What the pass actually managed, so the page can say so. A pass that was
   * turned away at every door used to record itself as a completed pass and
   * leave you looking at "last pass just now" with nothing new in the pool.
   */
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

  /*
   * Asked of RedGIFs rather than guessed at, so a typo is caught here instead
   * of sitting in the list pulling nothing every pass — and so the tag is
   * stored the way their index spells it.
   */
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

/*
 * RedGIFs in the reel. Same shape as the Reddit mix it replaces — one every
 * MIX_EVERY library clips, chosen by page so scrolling back finds the same
 * ones — except that every one of these is video.
 */
const MIX_EVERY = 4;

// How many followed creators get a turn before the wider site does.
const CREATORS_PER_TAG = 3;

/*
 * Three creators to one tag.
 *
 * A creator is someone in the library — their clip is here because you have
 * their scenes. A tag is a search of all of RedGIFs, and what floats to the top
 * of one is largely promotion: three tag-sourced slides on one page were the
 * same "GET MY VIP ONLYFANS is FREE" from three different accounts.
 *
 * Spending every creator first would have buried the tags something like a
 * hundred and forty pages down, which is the same as not having them. So the
 * two are woven instead, and the weave is what decides how often the wider site
 * gets a turn. Shared by the mix and the dedicated feed, so both get the same
 * balance.
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

  /*
   * How many of these a page gets. Given explicitly when more than one source
   * is riding along, so that turning a second one on shares the space out
   * rather than doubling how much of the page is not the library.
   */
  const take = want || Math.max(1, Math.round(base.items.length / MIX_EVERY));

  /*
   * Dealt from the visit's seed rather than sliced off the front of the list.
   *
   * This used to be `usable.slice((at - 1) * take, at * take)`, which is not a
   * weak shuffle — it is no shuffle. The weave above is stable, so page one of
   * every session was the same clips in the same order, for every session. The
   * library half had reshuffled on a fresh seed the whole time; these two never
   * saw it. See shuffle.mjs.
   */
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

/*
 * One stored gif as the reel draws it. Pulled out of mixInto so that a feed of
 * nothing but these can use the same shape — two copies would be two slides
 * that drift apart, and the reel would start rendering RedGIFs differently
 * depending on which page it came from.
 */
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

/*
 * A reel of nothing but RedGIFs, for the dedicated feed.
 *
 * Same pool, same weave, same seeded deal as the mix — only without a library
 * page to thread through. `count` is the whole pool rather than a page, so the
 * client knows how far it can scroll before the deck is dealt again.
 */
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
