/* A site's TPDB, Whisparr and Stash views, merged. */

import * as metadata from './metadata.mjs';
import * as whisparr from './whisparr.mjs';
import * as stash from './stash.mjs';
import * as tpdb from './tpdb.mjs';
import { stashConfigured, whisparr2Configured } from './config.mjs';

export async function siteView(config, siteId) {
  const site = await metadata.getSite(siteId);

  // Artwork arrives in the background; take whatever is ready.
  await tpdb.ensureArt(config, siteId);
  const { art, progress } = tpdb.artSnapshot(siteId);

  const [whisparrSide, stashSide] = await Promise.all([
    whisparrStatus(config, siteId),
    stashStatus(config, site.scenes),
  ]);

  const scenes = site.scenes.map((scene) => {
    const episode = whisparrSide.byTpdbId.get(scene.id);
    const held = stashSide.found.get(scene.id);
    const extra = art.get(scene.id);

    let status = 'absent';
    if (episode?.hasFile) status = 'downloaded';
    else if (episode?.monitored) status = 'monitored';

    return {
      ...scene,
      status,
      episodeId: episode?.id ?? null,
      stash: held
        ? {
            match: held.match,
            via: held.via || null,
            id: held.scene.id,
            path: held.scene.files?.[0]?.path || null,
          }
        : null,
      image: extra?.image || null,
      isMovie: extra?.isMovie || false,
      poster: extra?.poster || null,
      still: extra?.still || null,
      tags: extra?.tags || [],
      // TPDB's duration is exact seconds; the mirror rounds to minutes.
      duration: extra?.duration ? Math.round(extra.duration / 60) : scene.duration,
      overview: extra?.description || scene.overview,
    };
  });

  return {
    site: { ...site, scenes: undefined },
    art: progress,
    series: whisparrSide.series
      ? { id: whisparrSide.series.id, title: whisparrSide.series.title, path: whisparrSide.series.path }
      : null,
    stash: {
      enabled: stashConfigured(config),
      endpoint: stashSide.endpoint,
      error: stashSide.error,
    },
    whisparrError: whisparrSide.error,
    scenes,
    counts: tally(scenes),
  };
}

/*
 * ------------------------------------------------------- the detail pages
 *
 * A scene and a performer from TPDB, merged with Whisparr and Stash state.
 */

export async function sceneView(config, guid) {
  const scene = await tpdb.getScene(config, guid);
  if (!scene) throw new Error('ThePornDB has no scene with that id.');

  await annotateScenes(config, [scene]);
  return { scene };
}

export async function performerView(config, uuid) {
  const [performer, scenes] = await Promise.all([
    tpdb.getPerformer(config, uuid),
    tpdb.performerScenes(config, uuid),
  ]);
  if (!performer) throw new Error('ThePornDB has no performer with that id.');

  await annotateScenes(config, scenes);
  return { performer, scenes, counts: tally(scenes) };
}

/* The Creators page: everyone in your library a stash-box knows (either one). */
export async function creatorsView(config) {
  if (!stashConfigured(config)) return { creators: [], stash: { enabled: false }, counts: { total: 0, favourites: 0 } };

  /* High enough for the whole cast; the page filters in the browser. */
  const { performers, total } = await stash.libraryPerformers(config, { limit: 1000 });

  return {
    creators: performers,
    stash: { enabled: true },
    counts: {
      total,
      shown: performers.length,
      favourites: performers.filter((c) => c.favorite).length,
    },
  };
}

/* Whisparr and Stash state for scenes from any number of sites. */
export async function annotateScenes(config, scenes) {
  if (!scenes.length) return;

  const episodes = await episodeIndexFor(config, scenes);

  const held = stashConfigured(config)
    ? (await stash.matchScenes(config, scenes).catch(() => ({ found: new Map() }))).found
    : new Map();

  // TPDB ships fingerprints on these responses, so the strong match is available
  // here without the slow per-site artwork pull.
  const index = stashConfigured(config)
    ? await stash.fingerprintIndex(config).catch(() => null)
    : null;

  for (const scene of scenes) {
    const episode = episodes.get(scene.id);
    scene.status = episode?.hasFile ? 'downloaded' : episode?.monitored ? 'monitored' : 'absent';
    scene.episodeId = episode?.id ?? null;

    const hit = held.get(scene.id) || (index ? stash.matchByFingerprints(index, scene) : null);
    scene.stash = hit
      ? {
          match: hit.match,
          via: hit.via || null,
          id: hit.scene.id,
          path: hit.scene.path || hit.scene.files?.[0]?.path || null,
        }
      : null;

    delete scene.phashes;
    delete scene.oshashes;
  }
}

async function episodeIndexFor(config, scenes) {
  const byTpdbId = new Map();
  if (!whisparr2Configured(config)) return byTpdbId;

  const siteIds = [...new Set(scenes.map((s) => s.siteId).filter(Boolean))];

  try {
    const bySiteId = new Map((await whisparr.listSeries(config)).map((s) => [s.tvdbId, s]));

    for (const siteId of siteIds) {
      // Whisparr has never heard of this site, so it has nothing to say about it.
      const series = bySiteId.get(siteId);
      if (!series) continue;
      for (const episode of await whisparr.episodes(config, series.id)) {
        byTpdbId.set(episode.tvdbId, episode);
      }
    }
  } catch (err) {
    console.warn('[tpdbarr] could not read Whisparr state -', err.message);
  }

  return byTpdbId;
}

export function tally(scenes) {
  const counts = { total: scenes.length, downloaded: 0, monitored: 0, absent: 0, inStash: 0 };
  for (const scene of scenes) {
    counts[scene.status]++;
    if (scene.stash) counts.inStash++;
  }
  return counts;
}

async function whisparrStatus(config, siteId) {
  const empty = { series: null, byTpdbId: new Map(), error: null };
  // Not set up yet is a state, not an error.
  if (!whisparr2Configured(config)) return empty;

  try {
    const series = await whisparr.findSeries(config, siteId);
    if (!series) return empty;

    const eps = await whisparr.episodes(config, series.id);
    return { series, byTpdbId: new Map(eps.map((e) => [e.tvdbId, e])), error: null };
  } catch (err) {
    return { ...empty, error: err.message };
  }
}

async function stashStatus(config, scenes) {
  if (!stashConfigured(config)) return { found: new Map(), endpoint: null, error: null };
  try {
    const result = await stash.matchScenes(config, scenes);
    return { ...result, error: null };
  } catch (err) {
    return { found: new Map(), endpoint: null, error: err.message };
  }
}
