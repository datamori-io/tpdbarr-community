/*
 * GameLink, for the films IAFD has never heard of.
 *
 * This is the AdultEmpire catalogue — same company, same box art, same scene
 * indexes, 150,000-odd films — reached at the one address of theirs that is
 * open. That is the whole reason it exists as a separate module from the two
 * either side of it.
 *
 * **What it can say, and what it cannot.** A GameLink movie page lists its
 * scenes with the cast of each and a set of attributes, and it does **not**
 * name them. So this is the same class of evidence IAFD gives — a scene is
 * matched when its cast is exactly a row's cast — and it lands in the same
 * *probable* tier, with the same ambiguity when two rows share a cast. It is
 * not a better answer than IAFD. It is the same answer about far more films,
 * and it costs one page instead of two.
 *
 * ------------------------------------------------------------------ manners
 *
 * **Checked, not assumed, and the checks came out differently from
 * AdultEmpire's.** Two things kept AdultEmpire out of this builder: every one
 * of its search paths is disallowed in robots.txt, and every page redirects to
 * an age wall. GameLink shares the second and not the first.
 *
 *   robots.txt — `/account/`, `/cart/`, `/buy/`, `/AllSearch/Search` and the
 *   error paths are disallowed. `/adult-movies/` is not; they publish
 *   `/adult-movies/sitemap` inviting exactly this. The one page this module
 *   fetches is an `/adult-movies/` page, and nothing here touches a disallowed
 *   path — the site's own search is `/AllSearch/Search`, which is why the
 *   searching is not done here at all (see below).
 *
 *   the age gate — answered, and by the person it asks about. Stash's GameLink
 *   scraper already carries the same `ageConfirmed` cookie and runs on this
 *   machine for this user; this is the same consent from the same person on
 *   the same machine, and the gate asks one question to which the answer here
 *   is genuinely yes. That is different from AdultEmpire only in that nothing
 *   else about AdultEmpire was permitted either.
 *
 * **The search is Stash's, not ours.** Finding which film this is happens
 * through Stash's own GameLink scraper — a NAME scrape that already exists,
 * already carries the cookie, and returns movie addresses. So this module does
 * not crawl a search at all: it is handed an address and fetches one page.
 * That is a better arrangement than a searching crawler on every count, and it
 * keeps this module to a single request per film.
 *
 * One request at a time, 1.2 seconds apart, the figure iafd.mjs and bang.mjs
 * both use. Nothing here writes to Stash and nothing follows a link it found.
 */

import { gql } from './stash.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

export const CRAWL_DELAY = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextAllowed = 0;

async function polite() {
  const wait = nextAllowed - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowed = Date.now() + CRAWL_DELAY;
}

/*
 * The only shape of address this will fetch: a film page, on either host.
 * Checked here rather than at the call site, so "it only ever reads a movie
 * page" is a fact about the module and not a hope about its callers. Every
 * path robots.txt disallows fails this by construction.
 */
const MOVIE = /^https:\/\/(?:www|gay)\.gamelink\.com\/adult-movies\/[^/]+\/\d+\/[^/?#]+$/;

async function page(url) {
  if (!MOVIE.test(url)) throw new Error(`gamelink.mjs will not fetch ${url}`);
  await polite();

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: ACCEPT,
        'Accept-Language': 'en-US,en;q=0.9',
        // The same cookie Stash's own GameLink scraper sends, for the same
        // reason and on behalf of the same person.
        Cookie: 'ageConfirmed=true',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // A timeout or a refusal is "GameLink had nothing", which is an ordinary
    // answer here — the tier after this one still runs.
    return null;
  }
}

const unescapeHtml = (text) => String(text || '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;|&rsquo;/g, '’')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ')
  .trim();

/*
 * Two titles are the same title. Same rule bang.mjs uses, and for the same
 * reason — DVD numbering is written four ways for one film and the punctuation
 * is never the disagreement.
 */
export const flatten = (text) => String(text || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\bvol(?:ume)?\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/* ------------------------------------------------------------- which film
 *
 * Asked of Stash, which already has the scraper and the cookie.
 *
 * GameLink answers a search it has no answer for with whatever was closest, so
 * the result is never taken on its position — only one whose title flattens to
 * the title asked for is used.
 */
async function addressFor(config, title) {
  const wanted = flatten(title);
  if (!wanted) return null;

  const data = await gql(
    config,
    `query($s: ScraperSourceInput!, $i: ScrapeSingleSceneInput!) {
       scrapeSingleScene(source: $s, input: $i) { title urls }
     }`,
    { s: { scraper_id: 'GameLink' }, i: { query: title } }
  ).catch(() => null);

  for (const hit of data?.scrapeSingleScene || []) {
    if (flatten(hit.title) !== wanted) continue;
    const url = (hit.urls || []).find((u) => MOVIE.test(String(u || '')));
    if (url) return url;
  }
  return null;
}

/* --------------------------------------------------------- one film's scenes
 *
 * The page draws each scene as a `movie__scenes__scene__*` block carrying a
 * `scene_id`, a `Starring:` run of performer links, and an `Attributes:` run of
 * category links. There is no title anywhere on it — which is the single fact
 * that decides where this tier sits.
 */
function readScenes(html) {
  /*
   * Cut at the scene ids rather than at a wrapper class. The blocks are built
   * out of several sibling divs that share no single container, and the id is
   * the one thing every scene has exactly once.
   */
  const marks = [...html.matchAll(/scene_id='(\d+)'/g)];

  const order = [];
  const byId = new Map();
  for (const m of marks) {
    if (!byId.has(m[1])) { byId.set(m[1], m.index); order.push(m[1]); }
  }

  return order.map((id, at) => {
    const from = byId.get(id);
    const to = at + 1 < order.length ? byId.get(order[at + 1]) : html.length;
    const block = html.slice(from, to);

    const performers = [...new Set(
      [...block.matchAll(/href="\/porn-stars\/[^"]+"[^>]*>(?:<b>)?([^<]{2,60})</g)]
        .map((m) => unescapeHtml(m[1]))
        .filter(Boolean)
    )];

    const attributes = [...new Set(
      [...block.matchAll(/href="\/adult-clips\/list\?scene_attribute=\d+"[^>]*>([^<]{2,60})</g)]
        .map((m) => unescapeHtml(m[1]).replace(/,$/, '').trim())
        .filter(Boolean)
    )];

    return { no: at + 1, id, performers, attributes };
  }).filter((s) => s.performers.length);
}

/*
 * -> { url, title, studio, date, scenes: [{ no, id, performers, attributes }] }
 *
 * The film's own facts come off the same `<li><strong>Label:</strong> value`
 * list the Stash scraper reads, and they are read the careful way: anchored on
 * the `li`, never on "anything containing the word", which is the mistake that
 * had the scraper returning the whole page as a release date.
 */
export async function film(config, title, { year = null } = {}) {
  const url = await addressFor(config, title);
  if (!url) return null;

  const html = await page(url);
  if (!html) return null;

  const li = (label) => {
    const m = html.match(new RegExp(`<strong>\\s*${label}\\s*:?\\s*</strong>([\\s\\S]{0,200}?)</li>`, 'i'));
    return m ? unescapeHtml(m[1].replace(/<[^>]+>/g, ' ')) : '';
  };

  const scenes = readScenes(html);
  if (!scenes.length) return null;

  const when = li('Released');
  const date = Date.parse(when) ? new Date(Date.parse(when)).toISOString().slice(0, 10) : '';

  /*
   * A year that disagrees is a different film with the same name, which DVD
   * series produce constantly. Only checked when both ends have one.
   */
  if (year && date && Math.abs(Number(date.slice(0, 4)) - Number(year)) > 1) return null;

  return { url, title, studio: li('Studio'), date, scenes };
}
