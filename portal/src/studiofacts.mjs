/*
 * The studio page's second source.
 *
 * The performer page borrows from IAFD. A studio cannot: IAFD's studio pages
 * carry no biography block at all — they are a list of releases and nothing
 * else — so there is no version of this that reads the same site. What a
 * studio has instead is the ThePornDB mirror the acquisition half of this
 * portal already runs on, which needs no credentials and is not behind
 * anything. See metadata.mjs.
 *
 * It knows four things Stash does not: the network a site belongs to, its
 * homepage, how long its scenes usually run, and whether it is still putting
 * anything out. Stash has a column for none of them except the address.
 *
 * What it does NOT know is a description. The mirror's Overview is generated —
 * "3rd Degree Films is a part of the Zero Tolerance network." — and every one
 * of this library's 386 studios has an empty `details`. Writing that sentence
 * into all of them would fill a real gap with filler, so `details` is left
 * alone and the Overview is never offered.
 */

import * as metadata from './metadata.mjs';

const TTL = 24 * 60 * 60 * 1000;
const MAX_CACHED = 500;
const cache = new Map(); // key -> { at, record }

/*
 * The sites this library keeps on a studio that are not the studio's own front
 * door. A studio carrying six database and social links still has no website
 * as far as this page is concerned, which is what makes the homepage a gap
 * worth filling rather than a seventh link.
 */
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
 * Which site this studio is, and the house rule about guessing.
 *
 * A slug off the studio's own theporndb.net link is an answer somebody already
 * gave. A name is a guess, and this library has studios whose names collide
 * with a dozen clip-store fronts — searching "Babes" returns thirty. So a name
 * only resolves when exactly one result matches it outright; two matches means
 * no answer rather than the first one. Same rule as the group URLs.
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
     * Both, because the mirror searches titles and a slug is not one. Some
     * slugs read like a title and find their site — "3rddegreefilms" does —
     * and some do not: "allherluvallherluv" returns nothing at all. Asking
     * under both and letting the slug pick the winner costs one extra search
     * on a studio that has a link, and finds the ones a title alone misses.
     *
     * searchSites hands back mapSite's shape, not the mirror's raw one.
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

  /*
   * A hit keeps for the day; a miss only for an hour. The mirror has slow
   * moments, and a studio that happened to be looked up during one should not
   * spend the rest of the day with no facts.
   */
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, { at: record ? Date.now() : Date.now() - TTL + 60 * 60 * 1000, record });
  return record;
}

/* ----------------------------------------------------------------- filling
 *
 * Gaps only, the same rule as the performer page: a studio Stash has an answer
 * for is left exactly as it is. The homepage goes into `urls` and is appended
 * rather than replacing them, so the database and social links a scraper put
 * there all survive. The other three have no Stash column and go to
 * custom_fields, which is merged rather than replaced.
 */

const blank = (value) =>
  value === null || value === undefined || value === '' ||
  (Array.isArray(value) && value.length === 0);

const CUSTOM = [
  ['Network', (s) => s.network],
  ['Typical scene', (s) => (s.runtime ? `${s.runtime} min` : null)],
  ['Status', (s) => (s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : null)],
];

/*
 * `stash` is the studio as Stash returns it — urls, parent_studio and
 * custom_fields included, because a parent Stash already knows is as much of
 * an answer about the network as a custom field would be.
 */
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
