/*
 * Image search: photo sets for a performer. Each site is a URL template
 * with the name substituted; galleryscrape.mjs does the reading. ThePornDB
 * comes first because it's keyed on an id, not a name.
 */

import * as galleryscrape from './galleryscrape.mjs';
import * as stashdb from './stashdb.mjs';
import { stashConfigured } from './config.mjs';

/* The sites, and how a name becomes a URL on each. */
export const SITES = [
  {
    key: 'pornpics',
    name: 'PornPics',
    search: (name) => `https://www.pornpics.com/?q=${encodeURIComponent(name)}`,
    performer: (slug) => `https://www.pornpics.com/pornstars/${slug}/`,
    note: 'the performer page lists their galleries — twenty for a well-covered name',
  },
  {
    key: 'elitebabes',
    name: 'EliteBabes',
    search: (name) => `https://www.elitebabes.com/?s=${encodeURIComponent(name)}`,
    performer: (slug) => `https://www.elitebabes.com/model/${slug}/`,
    note: 'the model page lists their galleries; thumbnails link straight to full size',
  },
  {
    key: 'girlsofdesire',
    /* /models/<name>/ returns an empty 200 here; /search/<slug>/ works. */
    name: 'Girls of Desire',
    search: (name) => `https://www.girlsofdesire.org/search/${slugify(name)}/`,
    performer: () => null,
    note: 'searched rather than browsed — this site has no per-performer page',
  },
];

/* Lowercase and hyphenated, as all three sites spell it. */
export const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/* -> {name, slug, sources, sites}. Fetches nothing; these become the offered URLs. */
export function placesToLook(name) {
  const slug = slugify(name);

  return {
    name,
    slug,
    sites: SITES.map((site) => ({
      key: site.key,
      name: site.name,
      note: site.note,
      search: site.search(name),
      performer: slug ? site.performer(slug) : null,
    })),
  };
}

/* Performers from StashDB, so the name is picked rather than typed. */
export async function lookup(config, term, { limit = 10 } = {}) {
  if (!term || !stashConfigured(config)) return [];
  if (!(await stashdb.available(config))) return [];
  return stashdb.searchPerformers(config, term, { limit });
}

/* ThePornDB's pictures of a performer, by uuid. */
export async function fromTpdb(config, uuid) {
  return galleryscrape.fromPerformer(config, uuid);
}

// One page, read. The whole of the work is galleryscrape's; this is the door.
export async function fromPage(url) {
  return galleryscrape.fromPage(url);
}

/*
 * A performer page lists galleries; read it for gallery links first, then
 * scrape the one you pick. JavaScript-built lists give none, and that's reported.
 */
export async function galleriesFor(url) {
  return galleryscrape.linksOn(url);
}
