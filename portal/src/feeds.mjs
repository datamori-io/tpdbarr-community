/* News for the landing page: five RSS/Atom feeds, cache-and-refresh. */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'feeds.json');

const UA = 'tpdbarr/0.1 (+https://github.com/; personal media reader)';

// How long a pull stays fresh before the page is offered another.
const STALE_MS = 30 * 60 * 1000;

// Headlines kept per source. The feeds themselves carry more; the landing
// page wants a shelf, not the whole archive.
const KEEP = 14;

const SOURCES = [
  { key: 'sugarbabes', name: 'Sugarbabes', url: 'https://sugarbabes.com/feed' },
  { key: 'xbiz', name: 'XBIZ', url: 'https://xbiz.com/rss/all.xml' },
  { key: 'avn', name: 'AVN', url: 'https://avn.com/feed/articles.rss' },
  { key: 'trpwl', name: 'TRPWL', url: 'https://therealpornwikileaks.com/feed' },
  { key: 'adultfyi', name: 'AdultFYI', url: 'https://adultfyi.com/feed' },
];

// ------------------------------------------------------------------- store

let state = null;

const empty = () => ({ at: 0, feeds: {} });

async function load() {
  if (state) return state;

  try {
    const parsed = JSON.parse(await readFile(PATH, 'utf8'));
    state = {
      at: Number(parsed.at) || 0,
      feeds: parsed.feeds && typeof parsed.feeds === 'object' ? parsed.feeds : {},
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

// -------------------------------------------------------------------- xml

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

function decode(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => ENTITIES[name]);
}

const pick = (block, tag) => decode((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')) || [])[1] || '');

const stripTags = (html) => decode(String(html || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/*
 * An item's picture: enclosure, media:content, media:thumbnail, XBIZ's
 * bare `<image>` (non-standard, only place its art appears), else the
 * first `<img>` in the description.
 */
function firstImage(block) {
  const found =
    block.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image[^"]*"/i) ||
    block.match(/<enclosure[^>]*type="image[^"]*"[^>]*url="([^"]+)"/i) ||
    block.match(/<media:content[^>]*url="([^"]+)"[^>]*medium="image"/i) ||
    block.match(/<media:content[^>]*medium="image"[^>]*url="([^"]+)"/i) ||
    block.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
  if (found) return decode(found[1]);

  const bare = pick(block, 'image');
  if (/^https?:\/\//i.test(bare)) return bare;

  const body = pick(block, 'content:encoded') || pick(block, 'description') || pick(block, 'summary');
  const img = body.match(/<img[^>]+src="([^"]+)"/i);
  return img ? decode(img[1]) : null;
}

/* RSS 2.0 items or Atom entries, detected. */
function entries(xml, source) {
  const atom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const tag = atom ? 'entry' : 'item';
  const blocks = xml.split(new RegExp(`<${tag}[\\s>]`, 'i')).slice(1);

  const out = [];
  for (const rest of blocks) {
    const block = `<${tag} ` + rest;

    const title = stripTags(pick(block, 'title'));
    const link = decode((block.match(/<link[^>]*\shref="([^"]+)"/i) || [])[1] || pick(block, 'link'));
    if (!title || !link) continue;

    const when = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated') || pick(block, 'dc:date');
    const at = Date.parse(when) || 0;
    const excerpt = stripTags(pick(block, 'description') || pick(block, 'summary') || pick(block, 'content')).slice(0, 200);

    out.push({
      id: link,
      source: source.key,
      sourceName: source.name,
      title,
      link,
      at,
      excerpt,
      image: firstImage(block),
    });
  }

  out.sort((a, b) => b.at - a.at);
  return out.slice(0, KEEP);
}

// ------------------------------------------------------------------- pull

async function pullOne(source) {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.text();
  return entries(body, source);
}

let pulling = null;

/* One pass. A failing source keeps what it had. */
async function pullAll() {
  const store = await load();

  await Promise.all(SOURCES.map(async (source) => {
    try {
      const items = await pullOne(source);
      if (items.length) store.feeds[source.key] = { at: Date.now(), items, ok: true };
      else if (store.feeds[source.key]) store.feeds[source.key].ok = true;
    } catch (err) {
      const prior = store.feeds[source.key];
      store.feeds[source.key] = { at: prior?.at || 0, items: prior?.items || [], ok: false, error: err.message };
    }
  }));

  store.at = Date.now();
  await save();
}

export function refresh() {
  if (pulling) return pulling;
  pulling = pullAll()
    .catch((err) => { console.error('[tpdbarr] feeds refresh', err); })
    .finally(() => { pulling = null; });
  return pulling;
}

// ------------------------------------------------------------------- read

/* Serve the cache; refresh in the background when stale. */
export async function view() {
  const store = await load();
  const stale = !store.at || Date.now() - store.at > STALE_MS;
  if (stale) refresh();

  return {
    at: store.at,
    stale,
    running: Boolean(pulling),
    feeds: SOURCES.map((source) => ({
      key: source.key,
      name: source.name,
      url: source.url,
      at: store.feeds[source.key]?.at || 0,
      ok: store.feeds[source.key]?.ok !== false,
      items: store.feeds[source.key]?.items || [],
    })),
  };
}
