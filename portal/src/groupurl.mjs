/*
 * Find a scrapeable URL for a group Stash can't fill in.
 *
 * Looks titles up on adultfilmdatabase.com: robots.txt allows it, no age
 * gate, and Stash has a scraper for it. Results are candidates only; a
 * person confirms before a URL is attached.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { gql } from './stash.mjs';

const HOST = 'https://www.adultfilmdatabase.com';
const LOOKUP = HOST + '/lookup.cfm';

/* Their robots.txt asks for 30s between requests; one at a time, in the background. */
const CRAWL_DELAY = 30 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT = 30 * 1000;
const TTL = 24 * 60 * 60 * 1000;

/* Results kept on disk so a restart doesn't repeat the crawl. */
const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'groupurls.json');

let cache = null;   // { at, candidates: {groupId: [...]} }
let running = null;
let loading = null;
let progress = { looked: 0, total: 0 };

export const forgetGroupUrls = () => { cache = null; };

async function loaded() {
  if (cache) return cache;
  if (loading) return loading;

  loading = (async () => {
    try {
      const parsed = JSON.parse(await readFile(PATH, 'utf8'));
      if (parsed?.candidates && typeof parsed.candidates === 'object') {
        cache = { at: Number(parsed.at) || 0, candidates: parsed.candidates };
      }
    } catch {
      // Missing or corrupt: an empty list is the right recovery either way, and
      // the pass rebuilds it.
    } finally {
      loading = null;
    }
    return cache;
  })();

  return loading;
}

// Temp file then rename, so a crash mid-write cannot leave something that
// parses as an empty list and throws the whole pass away.
async function save() {
  if (!cache) return;
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    const temp = PATH + '.tmp';
    await writeFile(temp, JSON.stringify(cache, null, 2), 'utf8');
    await rename(temp, PATH);
  } catch (err) {
    console.warn('[tpdbarr] could not save group URL candidates -', err.message);
  }
}

export function groupUrlSnapshot() {
  return {
    candidates: cache?.candidates || {},
    searching: Boolean(running),
    looked: progress.looked,
    total: progress.total,
    builtAt: cache?.at || null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalise = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '');

/* "#132", "no. 132" and "132" are the same film. */
const looseKey = (title) =>
  normalise(String(title).replace(/\b(?:no\.?|#|vol\.?|volume|part|pt\.?)\s*(\d+)/gi, ' $1 '));

/* Look up one title now (a single request), for the features dialog. */
export async function lookUp(title, date = null) {
  if (!title || !title.trim()) return [];
  return rank({ name: title, date }, await search(title));
}

// ------------------------------------------------------------------ the pass

export async function ensureGroupUrls(config, { force = false } = {}) {
  await loaded();
  if (!force && cache && Date.now() - cache.at < TTL) return groupUrlSnapshot();
  if (running) return groupUrlSnapshot();

  running = (async () => {
    try {
      await lookUpAll(config);
    } catch (err) {
      console.warn('[tpdbarr] group URL pass failed -', err.message);
    } finally {
      running = null;
    }
  })();

  return groupUrlSnapshot();
}

async function lookUpAll(config) {
  const wanted = await needing(config);
  const candidates = { ...(cache?.candidates || {}) };

  progress = { looked: 0, total: wanted.length };
  cache = { at: Date.now(), candidates };

  for (const group of wanted) {
    try {
      const hits = await search(group.name);
      // An empty answer is still an answer — it stops the next pass re-asking.
      candidates[group.id] = rank(group, hits);
    } catch (err) {
      console.warn(`[tpdbarr] lookup failed for "${group.name}" -`, err.message);
    }

    progress.looked++;
    cache = { at: Date.now(), candidates: { ...candidates } };

    // Saved as it goes, so a restart halfway through keeps what was paid for.
    await save();

    // Their rate, not ours. Skipped after the last one.
    if (progress.looked < wanted.length) await sleep(CRAWL_DELAY);
  }
}

/* URL patterns Stash's installed group scrapers can read, asked of Stash. */
async function scrapeablePatterns(config) {
  const data = await gql(config, '{ listScrapers(types: [GROUP]) { group { urls } } }');

  return (data.listScrapers || [])
    .flatMap((s) => s.group?.urls || [])
    .map((u) => String(u).toLowerCase().replace(/^https?:\/\//, ''))
    .filter(Boolean);
}

/* Groups with no URL a scraper can read. */
async function needing(config) {
  const [data, patterns] = await Promise.all([
    gql(config, '{ findGroups(filter: {per_page: -1, sort: "name", direction: ASC}) { groups { id name urls } } }'),
    scrapeablePatterns(config).catch((err) => {
      console.warn('[tpdbarr] could not read the scraper list -', err.message);
      return [];
    }),
  ]);

  /* No patterns, no pass: otherwise every group would be crawled. */
  if (!patterns.length) {
    console.warn('[tpdbarr] no group scrapers known; skipping the URL pass');
    return [];
  }

  const readable = (url) => {
    const u = String(url).toLowerCase();
    return patterns.some((p) => u.includes(p));
  };

  return (data.findGroups.groups || [])
    .filter((g) => g.name)
    .filter((g) => !(g.urls || []).some(readable));
}

// --------------------------------------------------------------- the lookup

async function search(name) {
  const body = new URLSearchParams({ find: name, exact: '0', searchType: 'All' });

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT);

  let html;
  try {
    const res = await fetch(LOOKUP, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
      },
      body,
      redirect: 'follow',
      signal: control.signal,
    });
    if (!res.ok) throw new Error(`adultfilmdatabase -> ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  return parse(html);
}

/* Results are anchors to /video/<id>/<slug>/; the title comes from the anchor text. */
function parse(html) {
  const out = [];
  const seen = new Set();
  const re = /href="(\/video\/(\d+)\/[^"]*)"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,90})/gi;

  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);

    const title = m[3].replace(/\s+/g, ' ').trim();
    if (title) out.push({ title, url: HOST + m[1] });
  }

  return out;
}

/* Best first, each with how it matched. Nothing filtered on score. */
function rank(group, hits) {
  const exact = normalise(group.name);
  const loose = looseKey(group.name);

  return hits
    .map((hit) => {
      const how =
        normalise(hit.title) === exact ? 'exact title'
        : looseKey(hit.title) === loose ? 'same title, numbered differently'
        : looseKey(hit.title).startsWith(loose) || loose.startsWith(looseKey(hit.title)) ? 'similar title'
        : 'same search';

      const score = { 'exact title': 0, 'same title, numbered differently': 1, 'similar title': 2, 'same search': 3 }[how];
      return { ...hit, how, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 8)
    .map(({ score, ...rest }) => rest);
}
