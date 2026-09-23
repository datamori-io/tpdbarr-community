/*
 * Prowlarr — the indexers themselves, asked by hand.
 *
 * Everything else in this portal reaches the indexers through a Whisparr: a
 * scene is added, Whisparr searches, Whisparr grabs, Whisparr imports. That
 * only works for a scene one of the two catalogues knows. For the one neither
 * has heard of, the only thing left is to search the indexers by name and pick
 * a release by eye — which is what this is.
 *
 * The same Prowlarr Whisparr v3's indexers are synced from, so the same
 * accounts and the same limits. That is why nothing here runs unasked.
 *
 *   GET  /api/v1/search?query=&type=search&categories=6000
 *     [{guid, indexerId, indexer, title, size, publishDate, age, protocol,
 *       seeders, leechers, grabs, infoUrl, categories: [{id, name}]}]
 *
 *   POST /api/v1/search  {guid, indexerId}
 *     hands that release to Prowlarr's own download client
 *
 * **A grab here is not an import.** Whisparr never hears about it. A usenet
 * release goes to the NZBGet on this machine (nzbget.mjs) when one is set up,
 * anything else to Prowlarr's own download client, and nothing renames it or
 * files it. Getting it into Stash is the manual half — the Registry's wild
 * card builds a scene Stash has no match for.
 */

// A search fans out to every indexer and waits on the slowest.
const SEARCH_TIMEOUT = 90_000;
const TIMEOUT = 20_000;

// Newznab's XXX parent. Prowlarr expands a parent to its children.
const XXX = 6000;

/*
 * guid -> {downloadUrl, title, protocol} from recent searches. The download
 * link carries Prowlarr's API key, so it stays on this side and a grab names
 * the release by guid instead. Capped so a long session does not grow it
 * without end.
 */
const seen = new Map();
const SEEN_MAX = 2000;
const remember = (r) => {
  if (!r.guid || !r.downloadUrl) return;
  seen.delete(r.guid);
  seen.set(r.guid, { downloadUrl: r.downloadUrl, title: r.title || r.fileName || '', protocol: r.protocol || '' });
  while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
};

import * as nzbget from './nzbget.mjs';

export class ProwlarrError extends Error {}

export const configured = (config) => Boolean(config.prowlarrUrl && config.prowlarrApiKey);

const base = (config) => String(config.prowlarrUrl || '').replace(/\/+$/, '');

async function call(config, path, { method = 'GET', body = null, timeout = TIMEOUT } = {}) {
  if (!configured(config)) throw new ProwlarrError('Prowlarr is not set up — add its URL and API key under Parameters.');

  let res;
  try {
    res = await fetch(base(config) + '/api/v1' + path, {
      method,
      headers: {
        'X-Api-Key': config.prowlarrApiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new ProwlarrError(err.name === 'TimeoutError' ? `Prowlarr took longer than ${timeout / 1000}s` : `Prowlarr unreachable: ${err.message}`);
  }

  if (res.status === 401) throw new ProwlarrError('Prowlarr refused the API key.');
  if (!res.ok) {
    // Prowlarr's errors are JSON with a message, or a list of validation failures.
    const text = await res.text().catch(() => '');
    let why = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      why = j.message || (Array.isArray(j) ? j.map((e) => e.errorMessage).join('; ') : why);
    } catch { /* not JSON */ }
    throw new ProwlarrError(`Prowlarr ${res.status}: ${why || res.statusText}`);
  }

  const type = res.headers.get('content-type') || '';
  if (!/json/i.test(type)) throw new ProwlarrError(`Prowlarr answered with ${type.split(';')[0] || 'no content type'}, not JSON — check the URL.`);
  return res.json();
}

export const systemStatus = (config) => call(config, '/system/status');

/*
 * -> {releases} for a phrase, newest-grabbed first.
 *
 * `any` drops the XXX category, for the indexer that files things under
 * something else — sukebei has its own tree.
 */
export async function search(config, term, { any = false } = {}) {
  const q = String(term || '').trim();
  if (!q) return { releases: [] };

  const params = new URLSearchParams({ query: q, type: 'search', limit: '100', offset: '0' });
  if (!any) params.append('categories', String(XXX));

  const rows = await call(config, '/search?' + params, { timeout: SEARCH_TIMEOUT });
  for (const r of rows || []) remember(r);

  // Only what the page draws — never downloadUrl, which carries the API key.
  const releases = (rows || []).map((r) => ({
    guid: r.guid,
    indexerId: r.indexerId,
    indexer: r.indexer || '',
    title: r.title || r.fileName || '',
    size: r.size || 0,
    publishDate: r.publishDate || null,
    protocol: r.protocol || '',
    seeders: r.seeders ?? null,
    leechers: r.leechers ?? null,
    grabs: r.grabs ?? null,
    infoUrl: /^https?:\/\//i.test(r.infoUrl || '') ? r.infoUrl : null,
    categories: (r.categories || []).map((c) => c.name).filter(Boolean),
  }));

  // Popularity is the best stand-in for "the real one" that every indexer
  // reports: seeders for a torrent, grabs for usenet.
  const weight = (r) => (r.protocol === 'torrent' ? r.seeders : r.grabs) ?? -1;
  releases.sort((a, b) => weight(b) - weight(a) || (b.size - a.size));

  return { releases };
}

/*
 * Hand one release to Prowlarr's download client. The guid and indexer are the
 * pair Prowlarr identifies a result by; it keeps the search cached, so this
 * only works on something it returned recently.
 */
export async function grab(config, { guid, indexerId }) {
  if (!guid || !indexerId) throw new ProwlarrError('A grab needs the release guid and its indexer.');
  const known = seen.get(guid);
  if (known?.protocol === 'usenet' && nzbget.configured(config)) return grabToNzbget(config, known);
  const out = await call(config, '/search', { method: 'POST', body: { guid, indexerId: Number(indexerId) } });
  return { ok: true, title: out?.title || '', to: 'Prowlarr' };
}

/*
 * A usenet release, fetched through Prowlarr and handed to the NZBGet on this
 * machine. Fetching the link is itself the grab as far as Prowlarr and the
 * indexer are concerned, so it counts against the same limits.
 */
async function grabToNzbget(config, { downloadUrl, title }) {
  let res;
  try {
    res = await fetch(downloadUrl, { headers: { 'X-Api-Key': config.prowlarrApiKey }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw new ProwlarrError(`Fetching the NZB failed: ${err.message}`);
  }
  if (!res.ok) throw new ProwlarrError(`Fetching the NZB failed: Prowlarr ${res.status}`);
  const nzb = Buffer.from(await res.arrayBuffer());
  if (!/<nzb[\s>]/i.test(nzb.subarray(0, 4096).toString('utf8'))) {
    throw new ProwlarrError('The indexer sent something that is not an NZB — likely a grab limit.');
  }

  const { id, category } = await nzbget.append(config, { name: title, nzb });
  return { ok: true, title, to: `NZBGet · ${category}`, id };
}
