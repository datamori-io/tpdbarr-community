/*
 * New Sensations' DVD pages, which link each disc's scenes:
 *
 *   <div class="dvdScene"><h2><a href=".../updates/<slug>.html">Scene title</a></h2>
 *
 * A loose scene whose URL has the same slug is on that disc. Slugs are
 * shared across the network (FamilyXXX etc.). The disc list is read once
 * and kept a week; disc pages are fetched only when needed. robots.txt
 * allows this; 1.2s apart, and only two address shapes.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { flatten } from './bang.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const BASE = 'https://www.newsensations.com/dvds/';
const CRAWL_DELAY = 1200;
const TTL = 7 * 24 * 60 * 60 * 1000;

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'newsensations.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextAllowed = 0;
async function polite() {
  const wait = nextAllowed - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowed = Date.now() + CRAWL_DELAY;
}

const ALLOWED = [
  /^https:\/\/www\.newsensations\.com\/dvds\/dvds(?:_page_\d+)?\.html$/,
  /^https:\/\/www\.newsensations\.com\/dvds\/[A-Za-z0-9._-]+\.html$/,
];

async function get(url) {
  if (!ALLOWED.some((re) => re.test(url))) throw new Error(`newsensations.mjs will not fetch ${url}`);
  await polite();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(20000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    // A timeout is "New Sensations had nothing this time" — the tiers after
    // this one still run.
    return null;
  }
}

const unescapeHtml = (text) => String(text || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;|&rsquo;/g, '’')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ')
  .trim();

/* A scene URL's slug: the last segment without `.html`, lowercased. */
export function slugOf(url) {
  const m = /\/updates\/([^/?#]+?)(?:\.html)?(?:[?#].*)?$/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}

// ------------------------------------------------------------ the catalogue

let catalogue = null;

async function load() {
  if (catalogue) return catalogue;
  try {
    catalogue = JSON.parse(await readFile(PATH, 'utf8'));
  } catch {
    catalogue = { at: null, dvds: [], pages: {} };
  }
  catalogue.pages ||= {};
  return catalogue;
}

async function keep() {
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(catalogue));
  await rename(tmp, PATH);
}

/* -> [{ title, url }] every disc. The first index page names the last. */
async function discs() {
  const held = await load();
  if (held.at && Date.now() - Date.parse(held.at) < TTL && held.dvds.length) return held.dvds;

  const first = await get(BASE + 'dvds.html');
  if (!first) return held.dvds;

  const last = Math.max(1, ...[...first.matchAll(/dvds_page_(\d+)\.html/g)].map((m) => Number(m[1])));
  const found = new Map();
  const read = (html) => {
    for (const m of html.matchAll(/href="(https:\/\/www\.newsensations\.com\/dvds\/(?!dvds)[A-Za-z0-9._-]+\.html)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const title = unescapeHtml(m[2]);
      if (!found.has(m[1]) || (title && !found.get(m[1]))) found.set(m[1], title);
    }
  };
  read(first);
  for (let n = 2; n <= last; n++) {
    const html = await get(`${BASE}dvds_page_${n}.html`);
    if (html) read(html);
  }

  held.dvds = [...found].map(([url, title]) => ({ url, title }));
  held.at = new Date().toISOString();
  await keep();
  return held.dvds;
}

/* -> { url, title, date, scenes: [{ no, title, url, slug }] } or null. Cached. */
export async function disc(url) {
  const held = await load();
  if (held.pages[url]) return held.pages[url];

  const html = await get(url);
  if (!html) return null;

  const titles = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => unescapeHtml(m[1]))
    .filter((t) => t && !/adults only/i.test(t));
  const date = /RELEASED:\s*(?:<[^>]+>\s*)*([0-9/.-]{8,10})/i.exec(html)?.[1] || null;

  const scenes = [];
  for (const m of html.matchAll(/class="dvdScene"[\s\S]*?<h2>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const slug = slugOf(m[1]);
    if (!slug || scenes.some((s) => s.slug === slug)) continue;
    scenes.push({ no: scenes.length + 1, title: unescapeHtml(m[2]), url: m[1], slug });
  }

  const page = { url, title: titles[0] || '', date, scenes };
  held.pages[url] = page;
  await keep();
  return page;
}

/* The disc with this title, or null. Flattened like bang.mjs; ties refused. */
export async function findDisc(title) {
  // Spaces removed too: some slugs run words together.
  const squash = (text) => flatten(text).replace(/ /g, '');
  const key = squash(title);
  if (!key) return null;
  const hits = (await discs()).filter((d) =>
    squash(d.title) === key
    || squash(d.url.split('/').pop().replace(/\.html$/, '').replace(/[-_]+/g, ' ')) === key);
  if (hits.length !== 1) return null;
  return disc(hits[0].url);
}
