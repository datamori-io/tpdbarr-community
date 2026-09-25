import { spawn } from 'node:child_process';

/*
 * IAFD, for facts Stash doesn't carry (birthplace, weight, career end).
 *
 * Only fetches the iafd.com URL already on the performer's Stash record,
 * never follows links. Nothing here writes to Stash.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* Cached a week. The cap bounds memory. */
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHED = 500;
const cache = new Map(); // url -> { at, record }

export const iafdUrlOf = (urls = []) =>
  urls.find((u) => /^https?:\/\/(www\.)?iafd\.com\//i.test(u)) || null;

/*
 * ------------------------------------------------------------------ reading
 *
 * Label/value pairs; values are <p>, or <div> for aliases.
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

/* IAFD's ways of saying "unknown". */
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

/* Metric is in the brackets. Literal patterns, not built ones. */
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

/*
 * ------------------------------------------------------------------ fetching
 *
 * Failures are silent: Stash's facts are already on screen.
 */
/*
 * Cloudflare challenges intermittently, so up to three tries. A challenge is
 * treated as no answer, never solved.
 */
const ATTEMPTS = 3;
const PAUSE = 4000;
const CHALLENGED = /Just a moment|cf-browser-verification|Checking your browser/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const LANGUAGE = 'en-US,en;q=0.9';

async function viaFetch(url) {
  const res = await fetch(url, {
    /* Requests without Accept-Language are usually turned away. */
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
 * The same request via wget. Cloudflare rejects Node's fetch (by its TLS
 * handshake) while wget from the same machine gets through. Nothing is
 * bypassed: no challenge solved, no cookie taken.
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

/* Which transport works, settled by the first success. */
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

  /* Misses are cached for an hour only. */
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(url, { at: record ? Date.now() : Date.now() - TTL + 60 * 60 * 1000, record });
  return record;
}

/*
 * ----------------------------------------------------------------- filling
 *
 * What IAFD has that Stash doesn't. Gaps only; never overwrites.
 * `career_end` counts as a gap. The last four fields go into
 * custom_fields, which is merged.
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

/* No nationality: Stash's country is a code, IAFD's a word. */
const CUSTOM = [
  ['Birthplace', (i) => i.birthplace],
  ['Star sign', (i) => i.astrology],
  ['Shoe size', (i) => i.shoeSize],
];

/* `stash` is the performer as Stash returns it, custom_fields included. */
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

/*
 * ----------------------------------------------------- titles and scenes
 *
 * A DVD page's Scene Breakdowns table: one row per scene, performers only.
 * Used by the Group Builder when TPDB has no scene list. Cast matches are guesses.
 */

const HOST = 'https://www.iafd.com';
const SEARCH = HOST + '/results.asp?searchtype=comprehensive&searchstring=';

/* 1.2s between requests, one at a time. A courtesy; robots.txt sets none. */
export const CRAWL_DELAY = 1200;

let nextAllowed = 0;

async function polite() {
  const wait = nextAllowed - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowed = Date.now() + CRAWL_DELAY;
}

/* The retry loop, shared with the title side. */
async function fetchWithRetries(url) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    /* Wait before every attempt, not just the first. */
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
 * The caller picks.
 */
const ROW = /<tr[^>]*>\s*<td>\s*<a href="([^"]*title\.rme\/id=([0-9a-f-]{36}))"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/gi;

/* Strip "#" and volume words: IAFD's search finds "Barely Legal 153" but not "#153". */
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
 * A film's scene breakdown. -> {url, title, studio, distributor,
 * releaseDate, compilation, webscene, scenes: [{index, performers}]} or null.
 * No breakdown table gives empty `scenes`, not null.
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
