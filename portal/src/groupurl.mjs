/*
 * Finding a scrapeable address for a film you own.
 *
 * Stash can fill a group in completely — name, date, director, synopsis, studio
 * and both covers — but only from a URL, and only from a site it has a scraper
 * for. Fifty-three of the fifty-nine groups in this library have no such address:
 * forty carry no URL at all, and the rest point at timestamp.trade and friends,
 * which no installed scraper reads.
 *
 * So this module does the one thing Stash cannot: it looks a title up.
 *
 * **adultfilmdatabase.com**, for three reasons and not because it is the
 * biggest. Its robots.txt allows the lookup this uses (it disallows exactly one
 * unrelated path); it is not behind an age gate, so nothing here has to forge a
 * consent it was not given; and `AdultFilmDatabase` is already installed as a
 * Stash group scraper, so a URL found here is one Stash can immediately read.
 * AdultEmpire and data18 both scrape beautifully *given* a URL, and neither can
 * be searched without going through a gate or a disallowed endpoint.
 *
 * **Nothing found here is ever attached on its own.** A title match is a guess —
 * this library has five groups called "Forbidden Desires" — so the pass produces
 * candidates and stops. Writing one onto a group is a separate, confirmed act.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { gql } from './stash.mjs';

const HOST = 'https://www.adultfilmdatabase.com';
const LOOKUP = HOST + '/lookup.cfm';

/*
 * Their robots.txt asks for thirty seconds between requests and this obeys it,
 * which is the whole reason the pass runs in the background and reports
 * progress rather than answering a page load. Fifty-three titles is about
 * twenty-seven minutes. One at a time, deliberately: a crawl delay means
 * nothing if four workers each wait it separately.
 */
const CRAWL_DELAY = 30 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT = 30 * 1000;
const TTL = 24 * 60 * 60 * 1000;

/*
 * Kept on disk, next to the config.
 *
 * Not an optimisation. A pass costs twenty-eight minutes of somebody else's
 * crawl budget, and holding the result only in memory means every restart
 * spends it again — which is both rude to the source and a guarantee that the
 * dialog says "still looking" every time this container is rebuilt.
 */
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

/*
 * "#132", "no. 132" and a bare "132" are the same film, and this library names
 * groups all three ways — `panty world #8` sits next to `university coeds 18`.
 * Folding the marker out lets those match a catalogue that picks one style.
 */
const looseKey = (title) =>
  normalise(String(title).replace(/\b(?:no\.?|#|vol\.?|volume|part|pt\.?)\s*(\d+)/gi, ' $1 '));

/*
 * One title, looked up now rather than as part of the slow pass.
 *
 * The features need this more than the groups ever did: they arrived from .nfo
 * files carrying tmdb and imdb ids, so not one of them has a film-catalogue
 * address, and a rescan with nowhere to scrape from is a button that cannot
 * work. This is a single request rather than a crawl, so it answers a dialog
 * without making anyone wait out the thirty-second courtesy delay.
 */
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

/*
 * Which addresses Stash can already read — asked of Stash, not listed here.
 *
 * This was a hardcoded regex built from the handful of scrapers I had seen
 * match, and it drifted the moment the data changed: Bang is one of two dozen
 * installed group scrapers, it was not in the list, and a group already
 * pointing at bang.com would have been sent off for a thirty-second crawl
 * looking for an address it already had. Asking Stash cannot drift.
 */
async function scrapeablePatterns(config) {
  const data = await gql(config, '{ listScrapers(types: [GROUP]) { group { urls } } }');

  return (data.listScrapers || [])
    .flatMap((s) => s.group?.urls || [])
    .map((u) => String(u).toLowerCase().replace(/^https?:\/\//, ''))
    .filter(Boolean);
}

/*
 * The groups worth looking up: the ones with no address a scraper can read.
 * A group already pointing at data18, Bang or AdultEmpire is finished — it just
 * needs scraping, which is the other half of this feature.
 */
async function needing(config) {
  const [data, patterns] = await Promise.all([
    gql(config, '{ findGroups(filter: {per_page: -1, sort: "name", direction: ASC}) { groups { id name urls } } }'),
    scrapeablePatterns(config).catch((err) => {
      console.warn('[tpdbarr] could not read the scraper list -', err.message);
      return [];
    }),
  ]);

  /*
   * No list means no pass. The other failure — treating every group as
   * unreadable — would crawl somebody else's server for films that never
   * needed looking up, and that is the expensive way to be wrong.
   */
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

/*
 * A result is an anchor to /video/<id>/<slug>/ with the title inside it. The
 * title is read from the anchor rather than rebuilt from the slug, because the
 * slug has already lost the punctuation the match wants back.
 */
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

/*
 * Ordered best-first, and every one carries how it matched so the confirming
 * eye has something to go on. Nothing is filtered out on score: a wrong-looking
 * list is itself the answer that this group is not on the site.
 */
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
