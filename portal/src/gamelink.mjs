/*
 * GameLink (the AdultEmpire catalogue), for films IAFD doesn't have.
 *
 * Movie pages list each scene's cast and attributes, no titles, so this is
 * the *probable* tier like IAFD — same evidence, more films, one page.
 *
 * ------------------------------------------------------------------ manners
 *
 * robots.txt allows `/adult-movies/`; this fetches only those pages.
 * The age gate is answered with the same cookie Stash's GameLink scraper
 * uses on this machine. Searching is done by Stash's scraper, so this
 * module fetches one page per film. 1.2s apart, one at a time.
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

/* The only address shape this will fetch: a film page on either host. */
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

/* Same title? Same rule as bang.mjs. */
export const flatten = (text) => String(text || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\bvol(?:ume)?\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/*
 * ------------------------------------------------------------- which film
 *
 * Asked of Stash's GameLink scraper. Only a result whose title matches is used.
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

/*
 * --------------------------------------------------------- one film's scenes
 *
 * Scene blocks carry `scene_id`, a `Starring:` run and an `Attributes:` run. No titles.
 */
function readScenes(html) {
  /* Cut at the scene ids; the blocks share no container. */
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
 * Facts read from the `<li><strong>Label:</strong>` list, anchored on the li.
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

  /* A different year is a different film. Checked only when both have one. */
  if (year && date && Math.abs(Number(date.slice(0, 4)) - Number(year)) > 1) return null;

  return { url, title, studio: li('Studio'), date, scenes };
}
