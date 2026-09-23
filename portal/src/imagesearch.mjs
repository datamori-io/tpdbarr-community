/*
 * Image search — photo sets for a performer.
 *
 * The gallery builder already knows how to read a photo-set page: it handles
 * the two shapes those sites come in (thumbnails linking straight to the
 * full-size picture, and thumbnails linking to a page about the picture), it
 * reads srcset descriptors rather than trusting their order, and it only ever
 * fetches a URL the portal itself offered. All of that is in galleryscrape.mjs
 * and none of it is repeated here.
 *
 * What was missing was the step before: finding the pages. Until now a build
 * started from a URL you had already found in a browser. This turns a performer
 * into a list of candidate galleries across the sites already proven to work.
 *
 * **Search URLs, not scraped search engines.** Each site gets a template and the
 * name goes into it. That keeps this honest about what it is — a set of
 * bookmarks with a name substituted — and it keeps the fetching to pages the
 * user asked for. ThePornDB stays first because it is the one source here with
 * an id rather than a name, so its answer cannot be about the wrong person.
 */

import * as galleryscrape from './galleryscrape.mjs';
import * as stashdb from './stashdb.mjs';
import { stashConfigured } from './config.mjs';

/*
 * The sites, and how a name becomes a URL on each.
 *
 * These are the ones this library has actually built galleries from — elitebabes
 * and girlsofdesire were the two shapes the scraper was written against, and
 * pornpics was the first one asked for. A site is listed with the shape its gallery
 * pages take, because that is what decides whether a build will work and it is
 * better said here than discovered halfway through one.
 */
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
    /*
     * No per-performer page: /models/<name>/ answers 200 with an empty body,
     * which is this site's way of saying a path does not exist. /search/<slug>/
     * is the one that returns anything, so that is what a name becomes here.
     */
    name: 'Girls of Desire',
    search: (name) => `https://www.girlsofdesire.org/search/${slugify(name)}/`,
    performer: () => null,
    note: 'searched rather than browsed — this site has no per-performer page',
  },
];

/*
 * A name as these sites spell it in a URL. Every one of them uses the same
 * lowercase hyphenated form, which is the only reason a single slug works for
 * all three.
 */
export const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/*
 * -> {name, slug, sources, sites}
 *
 * Nothing is fetched. This hands back where to look, and the fetching happens
 * when you pick one — which is also what keeps the "only a URL the portal
 * offered" rule intact, since these are the URLs it offered.
 */
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

/*
 * The performers this page offers, from StashDB, so a name is picked rather
 * than typed. A typed name is a slug that is wrong by one hyphen and a page
 * that comes back empty for no visible reason.
 */
export async function lookup(config, term, { limit = 10 } = {}) {
  if (!term || !stashConfigured(config)) return [];
  if (!(await stashdb.available(config))) return [];
  return stashdb.searchPerformers(config, term, { limit });
}

/*
 * ThePornDB's own pictures of a performer. Different in kind from the three
 * sites above: it is keyed on a uuid, so the pictures are certainly of the
 * right person, and it is the only source here that can say that.
 */
export async function fromTpdb(config, uuid) {
  return galleryscrape.fromPerformer(config, uuid);
}

// One page, read. The whole of the work is galleryscrape's; this is the door.
export async function fromPage(url) {
  return galleryscrape.fromPage(url);
}

/*
 * The step that was missing, and the reason this page appeared to do nothing.
 *
 * A performer's page on one of these sites is a *list* of galleries, not a
 * gallery. Handing that straight to the picture scraper gets you site chrome
 * and thumbnails with nothing behind them. So the listing is read for its
 * gallery links first, and only the one you pick gets scraped for pictures.
 *
 * Measured against real pages: pornpics' performer page gives twenty galleries;
 * elitebabes and girlsofdesire answer on some names and not others, and a site
 * that hides its list behind JavaScript gives none — which is reported rather
 * than shown as an empty grid.
 */
export async function galleriesFor(url) {
  return galleryscrape.linksOn(url);
}
