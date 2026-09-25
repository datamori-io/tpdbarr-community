/*
 * Studio facts from the ThePornDB mirror (IAFD studio pages have no facts):
 * network, homepage, typical scene length, and whether it's still active.
 *
 * Its Overview is generated filler, so `details` is never offered.
 */

import * as metadata from './metadata.mjs';

const TTL = 24 * 60 * 60 * 1000;
const MAX_CACHED = 500;
const cache = new Map(); // key -> { at, record }

/* Database and social sites, which don't count as the studio's homepage. */
const DIRECTORY = /(iafd|indexxx|theporndb|stashdb|data18|wikidata|boobpedia|freeones|thenude|adultfilmdatabase|twitter|x|instagram|facebook|reddit|youtube|tiktok|manyvids|onlyfans|clips4sale|pornhub)[.]/i;

export const homepageOf = (urls = []) => urls.find((u) => !DIRECTORY.test(u)) || null;

// theporndb.net/sites/<slug> — the one link that names a site outright.
export function slugOf(urls = []) {
  for (const url of urls) {
    const m = /theporndb[.]net\/sites\/([a-z0-9-]+)/i.exec(url);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

const shape = (raw) => ({
  id: raw.id,
  title: raw.title,
  slug: raw.slug,
  network: raw.network || null,
  homepage: raw.homepage || null,
  // The mirror gives minutes already; zero means it has not worked one out.
  runtime: raw.runtime || null,
  status: raw.status || null,
  types: raw.types || [],
});

// Punctuation is the difference between "Adam & Eve" and "Adam and Eve", and
// neither spelling is more correct than the other.
const plain = (name) =>
  String(name || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

/*
 * Which mirror site this studio is. A slug from the studio's own TPDB link
 * is trusted; a name only resolves on exactly one exact match.
 */
function choose(sites, { slug, name }) {
  if (slug) {
    const exact = sites.find((s) => String(s.slug).toLowerCase() === slug);
    if (exact) return shape(exact);
  }

  const wanted = plain(name);
  const named = sites.filter((s) => plain(s.title) === wanted);
  return named.length === 1 ? shape(named[0]) : null;
}

export async function lookup({ urls = [], name = '' } = {}) {
  const slug = slugOf(urls);
  if (!slug && !name) return null;

  const key = slug ? `slug:${slug}` : `name:${plain(name)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.record;

  let record = null;
  try {
    /*
     * Search by both slug and name; the slug picks the winner.
     * searchSites returns mapSite's shape.
     */
    const found = [];
    if (slug) found.push(...(await metadata.searchSites(slug)));
    if (name) found.push(...(await metadata.searchSites(name)));

    const seen = new Set();
    const sites = found.filter((site) => !seen.has(site.id) && seen.add(site.id));
    record = choose(sites, { slug, name });
  } catch {
    // The mirror being slow is not something to interrupt a page with.
  }

  /* Hits cached a day, misses an hour. */
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, { at: record ? Date.now() : Date.now() - TTL + 60 * 60 * 1000, record });
  return record;
}

/*
 * ----------------------------------------------------------------- filling
 *
 * Gaps only. The homepage is appended to `urls`; the other three go to
 * custom_fields, which is merged.
 */

const blank = (value) =>
  value === null || value === undefined || value === '' ||
  (Array.isArray(value) && value.length === 0);

const CUSTOM = [
  ['Network', (s) => s.network],
  ['Typical scene', (s) => (s.runtime ? `${s.runtime} min` : null)],
  ['Status', (s) => (s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : null)],
];

/* `stash` is the studio as Stash returns it, with urls, parent_studio and custom_fields. */
export function proposal(stash, record) {
  if (!record) return { urls: null, custom: {}, rows: [] };

  const custom = {};
  const rows = [];
  const held = stash.custom_fields || {};

  if (blank(homepageOf(stash.urls || [])) && record.homepage) {
    rows.push({ label: 'Website', text: record.homepage });
  }

  for (const [label, read] of CUSTOM) {
    // A parent studio in Stash is the network, said properly. Nothing to add.
    if (label === 'Network' && stash.parent_studio) continue;
    if (!blank(held[label])) continue;

    const value = read(record);
    if (blank(value)) continue;
    custom[label] = value;
    rows.push({ label, text: value });
  }

  const homepage = rows.some((r) => r.label === 'Website') ? record.homepage : null;
  return { urls: homepage ? [...(stash.urls || []), homepage] : null, custom, rows };
}
