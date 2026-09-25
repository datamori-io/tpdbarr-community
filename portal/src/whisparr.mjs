/*
 * Whisparr v2 client. A Sonarr fork: a TPDB site is a series
 * (series.tvdbId = TPDB site id), a TPDB scene an episode
 * (episode.tvdbId = TPDB scene id).
 */

export class WhisparrError extends Error {}

async function call(config, path, { method = 'GET', body = null } = {}) {
  if (!config.whisparrUrl || !config.apiKey) throw new WhisparrError('Whisparr is not configured');

  const base = config.whisparrUrl.replace(/\/+$/, '');
  const res = await fetch(base + '/api/v3' + path, {
    method,
    headers: {
      Accept: 'application/json',
      'X-Api-Key': config.apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  if (!res.ok) {
    // *arr returns a bare 401 with no body, which explains nothing on its own.
    if (res.status === 401) {
      throw new WhisparrError(
        'Whisparr rejected the API key. Copy it from Whisparr → Settings → General → API Key (32 hex characters).'
      );
    }
    if (res.status === 404) {
      throw new WhisparrError(
        `Whisparr has no ${path} endpoint. Check the URL — a v3 instance or a wrong URL base would do this.`
      );
    }
    throw new WhisparrError(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

export const systemStatus = (config) => call(config, '/system/status');
export const qualityProfiles = (config) => call(config, '/qualityprofile');
export const rootFolders = (config) => call(config, '/rootfolder');

export async function listSeries(config) {
  const all = await call(config, '/series');
  return Array.isArray(all) ? all : [];
}

export async function findSeries(config, siteId) {
  const found = await call(config, '/series?tvdbId=' + siteId);
  return Array.isArray(found) && found.length ? found[0] : null;
}

export async function addSeries(config, siteId) {
  const lookup = await call(config, '/series/lookup?term=' + encodeURIComponent('tpdb:' + siteId));
  if (!lookup.length) throw new WhisparrError(`Whisparr could not look up tpdb:${siteId}`);

  const series = {
    ...lookup[0],
    qualityProfileId: Number(config.qualityProfileId),
    rootFolderPath: config.rootFolderPath,
    seriesType: 'standard',
    monitored: true,
    monitorNewItems: 'none',
    // Nothing is grabbed except the scenes explicitly asked for.
    addOptions: {
      monitor: 'none',
      searchForMissingEpisodes: false,
      searchForCutoffUnmetEpisodes: false,
    },
  };

  return call(config, '/series', { method: 'POST', body: series });
}

export async function ensureSeries(config, siteId) {
  const series = (await findSeries(config, siteId)) || (await addSeries(config, siteId));

  /*
   * Whisparr only auto-grabs when both series and episode are monitored, so
   * monitor the series. Its other episodes stay unmonitored.
   */
  if (series.monitored === false) {
    return call(config, '/series/' + series.id, {
      method: 'PUT',
      body: { ...series, monitored: true },
    });
  }

  return series;
}

export const episodes = (config, seriesId) => call(config, '/episode?seriesId=' + seriesId);

// A freshly added site has no episodes until Whisparr finishes pulling metadata.
export async function episodesWhenReady(config, seriesId, { attempts = 15, waitMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const eps = await episodes(config, seriesId);
    if (eps.length) return eps;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return [];
}

export const monitor = (config, episodeIds, monitored = true) =>
  call(config, '/episode/monitor', { method: 'PUT', body: { episodeIds, monitored } });

export const search = (config, episodeIds) =>
  call(config, '/command', { method: 'POST', body: { name: 'EpisodeSearch', episodeIds } });

export const queue = (config) =>
  call(config, '/queue?pageSize=200&includeEpisode=true&includeSeries=true');

// Monitor (and optionally search) a set of TPDB scene ids under one site.
export async function addScenes(config, siteId, tpdbSceneIds) {
  const series = await ensureSeries(config, siteId);
  const all = await episodesWhenReady(config, series.id);

  const wanted = new Set(tpdbSceneIds.map(Number));
  const matched = all.filter((e) => wanted.has(e.tvdbId));
  const missing = [...wanted].filter((id) => !matched.some((e) => e.tvdbId === id));

  if (matched.length) {
    await monitor(config, matched.map((e) => e.id), true);
    if (config.searchOnAdd) await search(config, matched.map((e) => e.id));
  }

  return {
    seriesId: series.id,
    added: matched.map((e) => e.tvdbId),
    missing,
    searched: Boolean(config.searchOnAdd) && matched.length > 0,
  };
}

/* Every monitored episode with no file, in one page. */
export async function wantedMissing(config) {
  const out = await call(config, '/wanted/missing?page=1&pageSize=2000&monitored=true&includeSeries=true&sortKey=releaseDate&sortDirection=descending');
  return out?.records || [];
}
