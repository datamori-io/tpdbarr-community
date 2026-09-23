/*
 * ThePornDB catalogue, via the Whisparr v2 metadata service.
 *
 * api.whisparr.com/v3 mirrors TPDB and needs no credentials, so the portal can
 * browse the whole catalogue without a TPDB account or any scraping. Sites come
 * back with a poster; scenes come back with performers, genres and dates but no
 * artwork of their own.
 */

const META = 'https://api.whisparr.com/v3';
const CATALOGUE_TTL = 6 * 60 * 60 * 1000; // 6h
const SEARCH_TTL = 60 * 60 * 1000; // 1h

const cache = new Map(); // key -> {at, value} | {at, promise}

async function fetchJson(path) {
  const res = await fetch(META + path, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`metadata ${path} -> ${res.status}`);
  return res.json();
}

function cached(key, ttl, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;

  const promise = produce().catch((err) => {
    cache.delete(key); // never cache a failure
    throw err;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

export function searchSites(query) {
  const q = String(query || '').trim();
  if (!q) return Promise.resolve([]);

  return cached('search:' + q.toLowerCase(), SEARCH_TTL, async () => {
    const results = await fetchJson('/site/search?q=' + encodeURIComponent(q));
    return results.map(mapSite);
  });
}

export function getSite(siteId) {
  return cached('site:' + siteId, CATALOGUE_TTL, async () => {
    const raw = await fetchJson('/site/' + encodeURIComponent(siteId));
    return {
      ...mapSite(raw),
      scenes: (raw.Episodes || []).map(mapScene).sort(byDateDesc),
    };
  });
}

export function forget(siteId) {
  cache.delete('site:' + siteId);
}

function mapSite(raw) {
  const images = raw.Images || [];
  const pick = (type) => (images.find((i) => i.CoverType === type) || {}).Url || null;
  return {
    id: raw.ForeignId,
    slug: raw.Slug,
    title: raw.Title,
    overview: raw.Overview || '',
    network: raw.Network || '',
    homepage: raw.Homepage || '',
    types: raw.Types || [],
    // Two facts nothing needed until the studio page wanted them: how long a
    // scene from here usually runs, and whether the site is still going.
    runtime: raw.Runtime || 0,
    status: raw.Status || null,
    poster: pick('Poster'),
    logo: pick('Logo'),
  };
}

function mapScene(raw) {
  return {
    id: raw.ForeignId,
    guid: raw.ForeignGuid || null,
    slug: raw.Slug,
    title: raw.Title || '(untitled)',
    date: raw.ReleaseDate || '',
    year: raw.Year || 0,
    duration: raw.Duration || 0,
    overview: raw.Overview || '',
    genres: raw.Genres || [],
    performers: (raw.Credits || []).map((c) => ({ name: c.Name, gender: c.Gender || null })),
    url: raw.Slug ? 'https://theporndb.net/scenes/' + raw.Slug : null,
  };
}

function byDateDesc(a, b) {
  return String(b.date).localeCompare(String(a.date));
}
