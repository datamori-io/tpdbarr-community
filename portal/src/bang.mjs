/*
 * Bang's DVD pages, for the Group Builder: scene number, scene title and
 * usually cast. Matching on title beats IAFD's cast-only rows.
 *
 * ------------------------------------------------------------------ manners
 *
 * bang.com's robots.txt allows `/dvd/` and `/movies?term=` and there's no
 * age wall. It disallows faceted query strings, `/trailer` and `/embed`,
 * which this never fetches. 1.2s between requests, one at a time. Nothing
 * here writes to Stash or follows links.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const LANGUAGE = 'en-US,en;q=0.9';

export const CRAWL_DELAY = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* One gate for the module, so the delay holds across callers. */
let nextAllowed = 0;

async function polite() {
  const wait = nextAllowed - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowed = Date.now() + CRAWL_DELAY;
}

/* The only two address shapes this will fetch, enforced here. */
const ALLOWED = [
  /^https:\/\/www\.bang\.com\/movies\?term=[^&]*$/,
  /^https:\/\/www\.bang\.com\/dvd\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/,
];

const permitted = (url) => ALLOWED.some((re) => re.test(url));

async function get(url) {
  if (!permitted(url)) throw new Error(`bang.mjs will not fetch ${url}`);
  await polite();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: ACCEPT,
        'Accept-Language': LANGUAGE,
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // A timeout or a refusal is "Bang had nothing", which is a normal answer
    // here — the tier below it still runs.
    return null;
  }
}

/*
 * --------------------------------------------------------------- unpicking
 *
 * Regex, not a parser: no dependencies.
 */

const unescapeHtml = (text) => String(text || '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;|&rsquo;/g, '’')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .trim();

const ldBlocks = (html) => {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1]);
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // A block that will not parse is a block with nothing in it.
    }
  }
  return out;
};

/* Same title? Strips punctuation and "#"/"Vol." so numbering styles agree. */
export const flatten = (text) => String(text || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\bvol(?:ume)?\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/*
 * The film name from the URL slug: the search listing has no names.
 * Always confirmed against the film page's JSON-LD name.
 */
const slugTitle = (url) => {
  const slug = String(url || '').split('/').filter(Boolean).pop() || '';
  return slug.replace(/[-_]+/g, ' ').trim();
};

/*
 * ------------------------------------------------------------------ search
 *
 * -> [{ url, title }], best first. Bang always returns something, so
 * findFilm checks the title.
 */
export async function search(title) {
  const term = String(title || '').trim();
  if (!term) return [];

  const html = await get('https://www.bang.com/movies?term=' + encodeURIComponent(term));
  if (!html) return [];

  const seen = new Map();
  for (const item of ldBlocks(html)) {
    const list = item['@type'] === 'ItemList' ? item.itemListElement || [] : [];
    for (const entry of list) {
      const node = entry?.item || entry;
      const url = String(node?.url || '');
      if (!/^https:\/\/www\.bang\.com\/dvd\//.test(url)) continue;
      if (!seen.has(url)) seen.set(url, { url, title: unescapeHtml(node?.name || '') || slugTitle(url) });
    }
  }

  /* Fall back to listing markup if ItemList JSON-LD disappears. */
  if (!seen.size) {
    for (const m of html.matchAll(/"url":"(https:\/\/www\.bang\.com\/dvd\/[^"]+)"/g)) {
      if (!seen.has(m[1])) seen.set(m[1], { url: m[1], title: slugTitle(m[1]) });
    }
  }

  return [...seen.values()];
}

/*
 * --------------------------------------------------------------- one film
 *
 * -> { url, title, studio, date, cast, scenes: [{ no, id, url, title, performers }] }
 *
 * Film facts from JSON-LD; scenes by cutting the page at "Scene N" headings.
 */
export async function film(url) {
  const address = String(url || '').split('?')[0].replace(/\/+$/, '');
  if (!permitted(address)) return null;

  const html = await get(address);
  if (!html) return null;

  const movie = ldBlocks(html).find((b) => b['@type'] === 'Movie') || {};

  const cast = (Array.isArray(movie.actor) ? movie.actor : [])
    .map((p) => unescapeHtml(p?.name))
    .filter(Boolean);

  const heads = [...html.matchAll(/<h2[^>]*>\s*Scene\s+(\d+)\s*<\/h2>/gi)]
    .map((m) => ({ at: m.index, no: Number(m[1]) }));

  const scenes = [];
  for (let i = 0; i < heads.length; i++) {
    const block = html.slice(heads[i].at, i + 1 < heads.length ? heads[i + 1].at : undefined);

    const link = block.match(/href="(\/video\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+))"/);
    if (!link) continue;

    /* Scene title from the still's alt text; the URL slug is the fallback. */
    const alt = block.match(/\salt="([^"]{4,160})"/);
    const fromAlt = alt ? unescapeHtml(alt[1]).replace(/\s*-\s*movie\s*\d+\s*-\s*\d+\s*$/i, '').trim() : '';
    const fromSlug = link[3].replace(/[-_]+/g, ' ').trim();

    const performers = [...new Set(
      [...block.matchAll(/href="\/pornstar\/[^"]+"[^>]*>([^<]{2,60})</g)]
        .map((m) => unescapeHtml(m[1]))
        .filter(Boolean)
    )];

    scenes.push({
      no: heads[i].no,
      id: link[2],
      url: 'https://www.bang.com' + link[1],
      title: fromAlt || fromSlug,
      // Often empty; don't depend on it.
      performers,
    });
  }

  const when = String(movie.datePublished || movie.dateCreated || '').slice(0, 10);

  return {
    url: address,
    title: unescapeHtml(movie.name || ''),
    studio: unescapeHtml(movie.productionCompany?.name || ''),
    date: /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : '',
    cast,
    scenes,
  };
}

/*
 * ---------------------------------------------------------- search + read
 *
 * Search, confirm the title, read. Null when Bang doesn't carry the film.
 */
export async function findFilm(title, { year = null } = {}) {
  const wanted = flatten(title);
  if (!wanted) return null;

  const hits = await search(title);
  const match = hits.find((h) => h.title && flatten(h.title) === wanted);
  if (!match) return null;

  const record = await film(match.url);
  if (!record || !record.scenes.length) return null;

  /* Check the page's own name, not the slug: two films can share a slug form. */
  if (record.title && flatten(record.title) !== wanted) return null;

  /* A different year is a different film. Checked only when both have one. */
  if (year && record.date) {
    const theirs = Number(record.date.slice(0, 4));
    if (Number.isFinite(theirs) && Math.abs(theirs - Number(year)) > 1) return null;
  }

  return record;
}
