/*
 * Bang, for the one thing TPDB and IAFD between them will not say.
 *
 * The group builder's whole question is "what scenes is this film made of",
 * and its two existing answers are thin in opposite ways. TPDB knows the
 * membership as a fact and almost never has it — of four hundred ungrouped
 * scenes sampled on 2026-09-03, three were in a TPDB movie. IAFD has a scene
 * breakdown for nearly everything and it is **cast and nothing else**: no
 * titles, no ids, so a scene is matched by its performers being exactly that
 * row's performers, which is a guess and is labelled one.
 *
 * Bang's DVD pages carry both. One page gives the scene number, the scene's
 * own title, and usually its cast — verified on Barefoot Confidential #91,
 * which lists four scenes with titles in their image alt text. A film's scenes
 * matched on **title** is a better guess than the same film's scenes matched on
 * cast, because two scenes on a DVD routinely share a cast and essentially
 * never share a title.
 *
 * ------------------------------------------------------------------ manners
 *
 * **This is allowed, and it was checked rather than assumed.** bang.com's
 * robots.txt has no blanket disallow under `User-agent: *` — what it forbids is
 * the faceted query strings (`/movies?with=`, `?by=`, `?hd=`), `/trailer` and
 * `/embed`. `/dvd/` pages and `/movies?term=` are not disallowed, and neither
 * is behind an age wall: a plain fetch with an ordinary user agent gets 200 and
 * the full page. That is the whole difference between this and AdultEmpire,
 * which disallows every search path and redirects every page to an age gate —
 * reading that one would mean forging a consent nobody gave, and it stays out.
 *
 * Two things this deliberately does not touch, both disallowed above: the
 * faceted browse URLs, and the trailer and embed paths. The only two addresses
 * this module will ever fetch are the plain title search and a `/dvd/` page.
 *
 * One request at a time with 1.2 seconds between them, which is the figure
 * iafd.mjs uses and for the same reason — there is no Crawl-delay in the file,
 * so it is manners rather than a rule, and a studio scan is hundreds of titles.
 *
 * Nothing here writes to Stash and nothing here follows a link off the page.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const LANGUAGE = 'en-US,en;q=0.9';

export const CRAWL_DELAY = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * One gate for the whole module, so the delay means what it says. A pause each
 * caller waits separately is four callers hitting the site at once.
 */
let nextAllowed = 0;

async function polite() {
  const wait = nextAllowed - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowed = Date.now() + CRAWL_DELAY;
}

/*
 * The only two shapes of address this will fetch. Checked here rather than at
 * the call sites, so "it never crawls" is true of the module and not merely
 * intended by whoever wrote the caller.
 */
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

/* --------------------------------------------------------------- unpicking
 *
 * Regex rather than a parser, which is what every other reader in this portal
 * does and for the same reason: there are no dependencies in this project and
 * a DVD page is not worth becoming the first.
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

/*
 * Two titles are the same title.
 *
 * DVD numbering is written four ways for the same film — "Barefoot
 * Confidential #91", "Barefoot Confidential 91", "Barefoot Confidential Vol.
 * 91" — and the punctuation is never the disagreement. What is left after this
 * is words and digits, which is the part that actually has to match.
 */
export const flatten = (text) => String(text || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\bvol(?:ume)?\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/*
 * The film's name as the address spells it.
 *
 * Bang's search listing emits an ItemList of addresses and **no names** — the
 * `name` on each entry is absent, which was only discovered by asking for a
 * film that is definitely there and matching nothing. So the slug is what the
 * search has to be narrowed on. It is the title lower-cased with the
 * punctuation replaced by hyphens, which survives `flatten` intact, and it is
 * never trusted on its own: findFilm confirms against the film page's own
 * JSON-LD name before the record is used for anything.
 */
const slugTitle = (url) => {
  const slug = String(url || '').split('/').filter(Boolean).pop() || '';
  return slug.replace(/[-_]+/g, ' ').trim();
};

/* ------------------------------------------------------------------ search
 *
 * -> [{ url, title }], best first, and usually noise after the first one.
 *
 * Bang answers a search it has no answer for with whatever was closest, so a
 * result is never taken on its position — findFilm below only accepts one whose
 * title flattens to the title asked for. Measured while this was written: "the
 * family tradition" (a Pure Taboo release Bang does not carry) comes back with
 * four unrelated films and no disclaimer.
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

  /*
   * The listing markup is the fallback, not the first choice. JSON-LD is the
   * site telling you what it means; scraped hrefs are you guessing from what it
   * drew. The fallback exists because a page that stops emitting ItemList
   * should degrade rather than go silent.
   */
  if (!seen.size) {
    for (const m of html.matchAll(/"url":"(https:\/\/www\.bang\.com\/dvd\/[^"]+)"/g)) {
      if (!seen.has(m[1])) seen.set(m[1], { url: m[1], title: slugTitle(m[1]) });
    }
  }

  return [...seen.values()];
}

/* --------------------------------------------------------------- one film
 *
 * -> { url, title, studio, date, cast, scenes: [{ no, id, url, title, performers }] }
 *
 * The film's own facts come off its JSON-LD, which is the site's own statement
 * about itself. The scene list does not — it is drawn as a run of `Scene N`
 * headings, each followed by a grid of stills that all link to the same video —
 * so the page is cut at the headings and each slice read on its own.
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

    /*
     * The title lives in the still's alt text and nowhere else on this page —
     * "Red head Anny Aurora likes kinky foot play - movie 4 - 2", where the
     * tail is which film and which still. The slug in the address says the same
     * thing in lower case with the apostrophes filed off, so it is the fallback
     * rather than the answer.
     */
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
      // Often empty. The page prints a scene's cast beside three of four scenes
      // and not the fourth, with no pattern to it, so this is a bonus the
      // caller may use and must not depend on.
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

/* ---------------------------------------------------------- search + read
 *
 * The two calls the group builder actually makes, as one, with the check that
 * makes the search result safe to use in between.
 *
 * A film Bang does not carry comes back null rather than coming back wrong.
 * That is the entire reason the title is compared after the search instead of
 * the first result being taken: Bang always answers.
 */
export async function findFilm(title, { year = null } = {}) {
  const wanted = flatten(title);
  if (!wanted) return null;

  const hits = await search(title);
  const match = hits.find((h) => h.title && flatten(h.title) === wanted);
  if (!match) return null;

  const record = await film(match.url);
  if (!record || !record.scenes.length) return null;

  /*
   * The slug got us to the page; the page's own name is what is actually
   * checked. A slug is a lossy spelling of a title and two different films can
   * flatten to the same one — "Barefoot Confidential 84" is on Bang twice under
   * two addresses — so the confirmation happens against what the site says the
   * film is called, not against its URL.
   */
  if (record.title && flatten(record.title) !== wanted) return null;

  /*
   * A year that disagrees is a different film with the same name, which DVD
   * series produce constantly. Only checked when both ends have one, and only
   * to a year — Bang dates a release by when it went up on Bang.
   */
  if (year && record.date) {
    const theirs = Number(record.date.slice(0, 4));
    if (Number.isFinite(theirs) && Math.abs(theirs - Number(year)) > 1) return null;
  }

  return record;
}
