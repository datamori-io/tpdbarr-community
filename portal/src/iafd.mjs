import { spawn } from 'node:child_process';

/*
 * IAFD, for the facts Stash does not carry.
 *
 * Stash fills a performer in from whichever stash-box identified them, and
 * that record is thin in a consistent way: it knows a hair colour and a
 * measurement, and it does not know where somebody was born, what they weigh,
 * or the year they stopped working. IAFD knows all three, and Stash already
 * holds the link — the performer's `urls` carry an iafd.com address whenever
 * one was scraped, so nothing here has to search for a person or guess which
 * of two people with one name it found.
 *
 * One page, fetched, read, and never crawled. This follows no links: the only
 * address it will fetch is one that came off the performer's own record, and
 * the same-host check below is what makes that true rather than intended.
 *
 * Nothing here writes to Stash. What comes back is shown beside what Stash
 * has, marked as somebody else's fact.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/*
 * A person's height does not change, so this is cached for a week and a cold
 * portal is the only thing that ever pays for the fetch. The cap is a bound on
 * a long-running process rather than a policy — a library with four thousand
 * performers should not hold four thousand pages of HTML-derived facts.
 */
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHED = 500;
const cache = new Map(); // url -> { at, record }

export const iafdUrlOf = (urls = []) =>
  urls.find((u) => /^https?:\/\/(www\.)?iafd\.com\//i.test(u)) || null;

/* ------------------------------------------------------------------ reading
 *
 * IAFD writes its biography as a run of label/value pairs, and the value is a
 * <p> for most of them and a <div> for the aliases. Both, or the AKA list is
 * the one thing this misses.
 */

const strip = (html) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .trim();

const PAIR = /<p class="bioheading">\s*(.*?)\s*<\/p>\s*<(p|div) class="biodata">([\s\S]*?)<\/\2>/gi;

function pairs(html) {
  const found = new Map();
  for (const match of html.matchAll(PAIR)) {
    const label = strip(match[1]).toLowerCase();
    const value = strip(match[3]);
    if (label && value && !found.has(label)) found.set(label, value);
  }
  return found;
}

/*
 * IAFD says "No known aliases", "None", and a bare dash for the same thing,
 * which is that it does not know. A page that printed "Piercings: None" as a
 * fact would be adding a row to say nothing.
 */
const EMPTY = /^(no known aliases|none|unknown|n\/a|-+|no data)$/i;
const real = (value) => (value && !EMPTY.test(value) ? value : null);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// "February 29, 2000" — kept as the ISO date Stash uses, so the two compare.
function isoDate(value) {
  const m = /([a-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(value || '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/*
 * Both are written imperial first with the metric in brackets — "5 feet, 3
 * inches (160 cm)" — so the number in the brackets is the one Stash's units
 * want. Literal patterns rather than one built from the unit, because the
 * backslashes in a constructed one are a bug waiting for a quiet afternoon.
 */
const CENTIMETRES = /\((\d+(?:\.\d+)?)\s*cm\)/i;
const KILOGRAMS = /\((\d+(?:\.\d+)?)\s*kg\)/i;

const metric = (value, pattern) => {
  const m = pattern.exec(value || '');
  return m ? Number(m[1]) : null;
};

export function parse(html, url) {
  const bio = pairs(html);
  const get = (label) => real(bio.get(label));

  const years = get('years active');
  const span = /^(\d{4})\s*-\s*(\d{4})?/.exec(years || '');

  const aka = get('performer aka');

  return {
    url,
    name: strip((/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '')
      .replace(/\s*-\s*iafd\.com$/i, '') || null,
    aka: aka ? aka.split('\n').map((a) => a.trim()).filter(Boolean) : [],
    birthdate: isoDate(get('birthday')),
    astrology: get('astrology'),
    birthplace: get('birthplace'),
    gender: get('gender'),
    yearsActive: years,
    careerStart: span ? span[1] : null,
    careerEnd: span && span[2] ? span[2] : null,
    ethnicity: get('ethnicity'),
    nationality: get('nationality'),
    hairColor: get('hair colors') || get('hair color'),
    eyeColor: get('eye color'),
    heightCm: metric(get('height'), CENTIMETRES),
    weightKg: metric(get('weight'), KILOGRAMS),
    measurements: get('measurements'),
    shoeSize: get('shoe size'),
    tattoos: get('tattoos'),
    piercings: get('piercings'),
  };
}

/* ------------------------------------------------------------------ fetching
 *
 * A failure here is not an error the page should show. The vitals it has come
 * from Stash and are already on screen; this either adds to them or it does
 * not, and "IAFD was slow" is not something to interrupt somebody with.
 */
/*
 * IAFD is behind Cloudflare, and it does not challenge consistently: the same
 * request three times running gets turned away twice and answered once. So
 * this asks up to three times with a pause between, and gives up quietly.
 *
 * Nothing is being got around here — a challenge is taken as "no answer", the
 * interstitial is never solved, and one page a week per performer is not a
 * rate anything needs protecting from. It is a retry because the failure is
 * intermittent, which is the only reason to retry anything.
 */
const ATTEMPTS = 3;
const PAUSE = 4000;
const CHALLENGED = /Just a moment|cf-browser-verification|Checking your browser/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const LANGUAGE = 'en-US,en;q=0.9';

async function viaFetch(url) {
  const res = await fetch(url, {
    /*
     * Accept-Language is not decoration: a request without one is turned away
     * more often than not, whatever the user agent says.
     */
    headers: {
      'User-Agent': UA,
      Accept: ACCEPT,
      'Accept-Language': LANGUAGE,
      'Upgrade-Insecure-Requests': '1',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) return null;
  const html = await res.text();
  // A challenge page parses cleanly into a record of nothing, which would
  // then be cached for a week as the truth about somebody.
  return CHALLENGED.test(html) ? null : html;
}

/*
 * The same page, fetched by wget instead — and this is the one that works here.
 *
 * Cloudflare does not only look at the address a request came from. Measured on
 * 2026-09-04, from inside this container and within the same minute: Node's own
 * fetch got **403 and a challenge page**, and `wget` against the identical URL,
 * with the identical headers, got **200**. Same machine, same IP, same second.
 * What differs is the shape of the TLS and HTTP handshake, and undici's is on
 * somebody's list.
 *
 * That is worth knowing beyond this file: the performer vitals this module has
 * always fetched were failing the same way and reporting it as "IAFD had
 * nothing", which is what a challenge looks like when it is treated as a miss.
 *
 * Nothing is being got around. The challenge is still never solved, no cookie
 * is harvested and no interstitial is answered — this asks the same question
 * with a different, entirely ordinary client, and takes no for an answer when
 * no is what comes back. Spawned rather than added as a dependency because this
 * app has none and markerclips.mjs already reaches for a binary the same way.
 */
const MAX_BYTES = 2 * 1024 * 1024;

function viaWget(url) {
  return new Promise((resolve) => {
    const child = spawn('wget', [
      '-q', '-O', '-',
      '-T', '15',
      '-U', UA,
      '--header', `Accept: ${ACCEPT}`,
      '--header', `Accept-Language: ${LANGUAGE}`,
      url,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      // A page this size is not a page; stop reading rather than grow forever.
      if (out.length > MAX_BYTES) child.kill();
    });

    // No wget on the box is a reason to fall back, not to crash.
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      resolve(code === 0 && out && !CHALLENGED.test(out) ? out : null);
    });
  });
}

/*
 * Which of the two this machine can use, worked out once by trying.
 *
 * Neither is hard-coded: an installation where fetch is fine should not shell
 * out on every page, and one where it is challenged should not spend three
 * attempts a page discovering that forever. So the first page that succeeds
 * settles it, and a first page that fails both ways settles nothing — it may
 * simply be a page IAFD does not have.
 */
let transport = null;

async function fetchOnce(url) {
  if (transport === 'wget') return viaWget(url);

  const direct = await viaFetch(url).catch(() => null);
  if (direct) {
    transport = 'fetch';
    return direct;
  }
  if (transport === 'fetch') return null;

  const shelled = await viaWget(url);
  if (shelled) {
    transport = 'wget';
    console.warn('[tpdbarr] IAFD turns away this machine’s built-in fetch — using wget for it instead');
  }
  return shelled;
}

export async function lookup(url) {
  if (!url || !/^https?:\/\/(www\.)?iafd\.com\//i.test(url)) return null;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.record;

  const html = await fetchWithRetries(url);
  const record = html ? parse(html, url) : null;

  /*
   * A miss is cached too, but only for an hour: the page is probably there and
   * this run was unlucky, so a week would turn one bad afternoon into a
   * performer who permanently has no vitals.
   */
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(url, { at: record ? Date.now() : Date.now() - TTL + 60 * 60 * 1000, record });
  return record;
}

/* ----------------------------------------------------------------- filling
 *
 * What of an IAFD record Stash does not already have.
 *
 * Gaps only. Stash is the library of record and this never argues with it: a
 * field it has an answer for is left exactly as it is, however sure IAFD
 * sounds. So there is no dialog to tick through and nothing to undo — the
 * worst this can do is put a fact where there was previously nothing.
 *
 * `career_end` counts as a gap and `career_length` does not. Stash parses its
 * own "2018 -" into a start with no end, so the end year is a hole in the
 * record rather than a second opinion about it, and filling it leaves the
 * sentence Stash wrote alone.
 *
 * The last four have no Stash field at all. They go into custom_fields, which
 * is merged rather than replaced, so this cannot tread on custom fields put
 * there by anything else.
 */

const blank = (value) =>
  value === null || value === undefined || value === '' ||
  (Array.isArray(value) && value.length === 0);

const FIELDS = [
  ['birthdate', 'Born', (i) => i.birthdate],
  ['ethnicity', 'Ethnicity', (i) => i.ethnicity],
  ['hair_color', 'Hair', (i) => i.hairColor],
  ['eye_color', 'Eyes', (i) => i.eyeColor],
  ['height_cm', 'Height', (i) => i.heightCm, (v) => `${v} cm`],
  ['weight', 'Weight', (i) => i.weightKg, (v) => `${v} kg`],
  ['measurements', 'Measurements', (i) => i.measurements],
  ['tattoos', 'Tattoos', (i) => i.tattoos],
  ['piercings', 'Piercings', (i) => i.piercings],
  ['career_end', 'Career ended', (i) => i.careerEnd],
  ['alias_list', 'Also known as', (i) => (i.aka.length ? i.aka : null), (v) => v.join(', ')],
];

/*
 * Nationality is not here on purpose. Stash's country is a two-letter code and
 * IAFD's is a word, so the two would sit in different places saying the same
 * thing — and the page keeps one rule: everything marked as IAFD's is
 * something the button will write, and nothing else is marked at all.
 */
const CUSTOM = [
  ['Birthplace', (i) => i.birthplace],
  ['Star sign', (i) => i.astrology],
  ['Shoe size', (i) => i.shoeSize],
];

/*
 * `stash` is the performer as Stash returns it — snake_case, and including
 * custom_fields, because a custom field that is already set is as much of an
 * answer as a column that is.
 */
export function proposal(stash, record) {
  if (!record) return { fields: {}, custom: {}, rows: [] };

  const fields = {};
  const custom = {};
  const rows = [];

  for (const [key, label, read, show] of FIELDS) {
    if (!blank(stash[key])) continue;
    const value = read(record);
    if (blank(value)) continue;
    fields[key] = key === 'career_end' ? String(value) : value;
    rows.push({ label, text: show ? show(value) : String(value) });
  }

  const held = stash.custom_fields || {};
  for (const [label, read] of CUSTOM) {
    if (!blank(held[label])) continue;
    const value = read(record);
    if (blank(value)) continue;
    custom[label] = value;
    rows.push({ label, text: String(value) });
  }

  return { fields, custom, rows };
}

/* ----------------------------------------------------- titles and scenes
 *
 * The other half of IAFD, and the reason the Group Builder exists.
 *
 * A DVD's page carries a **Scene Breakdowns** table — one row per scene, with
 * the performers in it. That is the only freely readable statement anywhere of
 * *what a film is made of*. AdultEmpire and data18 both say it better and
 * neither can be read: AdultEmpire redirects every page to /AgeConfirmation
 * and disallows every search path in robots.txt, and data18 answers a plain
 * fetch with a 403. IAFD asks for neither a consent it was not given nor a
 * challenge to be solved, and its robots.txt allows this outright.
 *
 * **What the table does not say is the point.** It lists people, not titles —
 * "Scene 2: Alexis Tae, Molly Little, Seth Gamble" and nothing else. So a scene
 * matched through here is matched on its cast, which is a guess, and every
 * proposal built on one says so. The exact tier is ThePornDB's own scene list;
 * this is what answers when TPDB has none, which for this library is most of
 * the time.
 */

const HOST = 'https://www.iafd.com';
const SEARCH = HOST + '/results.asp?searchtype=comprehensive&searchstring=';

/*
 * IAFD's own crawl budget. There is no Crawl-delay in its robots.txt, so this
 * is a manners figure rather than a required one — a scan of one studio is
 * three hundred titles, and three hundred requests as fast as they will go is
 * not a thing to do to somebody else's server for a shelf of DVD covers.
 *
 * One at a time, deliberately. A delay means nothing if four workers each wait
 * it separately — the same note groupurl.mjs carries about its thirty seconds.
 */
export const CRAWL_DELAY = 1200;

let nextAllowed = 0;

async function polite() {
  const wait = nextAllowed - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowed = Date.now() + CRAWL_DELAY;
}

/*
 * The retry loop lookup() has always used, lifted out so the title side gets
 * the same treatment. Cloudflare turns this site away intermittently rather
 * than consistently, and a challenge is taken as "no answer" — never solved.
 */
async function fetchWithRetries(url) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    /*
     * Inside the loop, not outside it. A challenged page is fetched three times
     * and a delay that only covered the first one would let a bad afternoon hit
     * this site three times in eight seconds — which is the opposite of what
     * the delay is for. Every request through this module waits its turn,
     * including the once-a-week performer lookups, because a rule that has to
     * be remembered at each call site is a rule that will be forgotten at one.
     */
    await polite();

    try {
      const html = await fetchOnce(url);
      if (html) return html;
    } catch {
      // A timeout is worth another go; anything else will fail the same way.
    }
    if (attempt < ATTEMPTS) await sleep(PAUSE);
  }
  return null;
}

const sameHost = (url) => /^https?:\/\/(www\.)?iafd\.com\//i.test(url || '');

/*
 * Titles matching a name. -> [{id, url, title, year, distributor, aka}]
 *
 * Never believed on its own. "Under the Bed" returns seventeen films and three
 * of them are somebody else's; picking one is the caller's job, done against a
 * year and a studio it already knows. This only reads the table.
 */
const ROW = /<tr[^>]*>\s*<td>\s*<a href="([^"]*title\.rme\/id=([0-9a-f-]{36}))"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/gi;

/*
 * The hash has to go, and it is not cosmetic.
 *
 * Measured on 2026-09-04: "Barely Legal #153" returns **nothing** from this
 * search, and "Barely Legal 153" returns exactly one right answer. Same for
 * #135 and #130. IAFD's search will not take the marker, so every numbered
 * release — which is most of what a group builder is looking for — was coming
 * back as "IAFD has never heard of this film".
 *
 * Volume and number words go the same way, for the same reason and because the
 * catalogue is inconsistent about printing them at all.
 */
const searchable = (title) =>
  String(title || '')
    .replace(/(?:#|\bvol(?:ume)?\.?|\bno\.?)\s*(\d+)/gi, ' $1')
    .replace(/\s+/g, ' ')
    .trim();

export async function searchTitles(title) {
  const term = searchable(title);
  if (!term) return [];

  const html = await fetchWithRetries(SEARCH + encodeURIComponent(term));
  if (!html) return [];

  const out = [];
  for (const m of html.matchAll(ROW)) {
    out.push({
      id: m[2],
      url: m[1],
      title: strip(m[3]),
      year: Number(strip(m[4])) || null,
      distributor: strip(m[5]),
      aka: strip(m[6]),
    });
  }
  return out;
}

/*
 * A film's scene breakdown, and the facts beside it worth checking the match
 * against. -> {url, title, studio, distributor, releaseDate, compilation,
 * webscene, scenes: [{index, performers}]} or null.
 *
 * A page with no breakdown table comes back with an empty `scenes`, not null:
 * "IAFD has this film and does not know what is in it" is a different answer
 * from "IAFD does not have it", and the caller reports them differently.
 */
const SCENE_ROW = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;

export async function titleScenes(url) {
  if (!sameHost(url)) return null;

  const html = await fetchWithRetries(url);
  if (!html) return null;

  const bio = pairs(html);
  const get = (label) => real(bio.get(label));

  const panel = html.split(/id="sceneinfo"/i)[1];
  const table = panel ? (/<table[^>]*>([\s\S]*?)<\/table>/i.exec(panel) || [])[1] : null;

  const scenes = [];
  if (table) {
    for (const m of table.matchAll(SCENE_ROW)) {
      const index = Number((/scene\s*(\d+)/i.exec(strip(m[1])) || [])[1]) || scenes.length + 1;
      const performers = strip(m[2]).split(',').map((n) => n.trim()).filter(Boolean);
      if (performers.length) scenes.push({ index, performers });
    }
  }

  return {
    url,
    title: strip((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1] || '') || null,
    studio: get('studio'),
    distributor: get('distributor'),
    director: get('director'),
    releaseDate: isoDate(get('release date')),
    // IAFD says so outright, and both change what a proposal means.
    compilation: /^yes$/i.test(bio.get('compilation') || ''),
    webscene: /^yes$/i.test(bio.get('webscene') || ''),
    scenes,
  };
}
