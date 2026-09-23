/*
 * The home page.
 *
 * Not a feed reader — an acquisition console. The bands answer, in order, the
 * questions a collector actually arrives with:
 *
 *   1. what dropped since I last looked?   -> since
 *   2. is anything stuck?                  -> attention
 *   3. what am I nearly done with?         -> completion
 *   4. what have my performers been in?    -> performers
 *   5. what else is out there?             -> discovery
 *
 * The previous page answered only (1), three times over.
 *
 * Scene data is sourced from TPDB rather than the free mirror, because TPDB
 * carries posters, performer genders and fingerprints in the same response —
 * which is what makes the filtering and the "already have it" check possible.
 *
 * It is slow enough (dozens of paged requests) that it is built in the
 * background and served from cache. The queue is the exception: it changes by
 * the minute, so it is read live on every request instead.
 */

import * as tpdb from './tpdb.mjs';
import * as whisparr from './whisparr.mjs';
import * as stash from './stash.mjs';
import * as metadata from './metadata.mjs';
import { whisparr2Configured, stashConfigured, saveConfig } from './config.mjs';

const TTL = 30 * 60 * 1000;

const STALE_DAYS = 30; // monitored this long with no file is worth a nudge
const FIRST_RUN_DAYS = 7; // no watermark yet, so "new" means the last week
const BULK_ADD_LIMIT = 20; // a bigger gap than this does not belong behind one button
const MAX_SITES = 20; // sites polled for new releases per build
const MAX_COVERAGE_SITES = 12; // coverage costs a catalogue read and a match per site

let cache = null; // {at, home}
let building = null;

export function homeSnapshot() {
  return {
    home: cache?.home || null,
    building: Boolean(building),
    builtAt: cache?.at || null,
  };
}

export function forgetHome() {
  cache = null;
}

export async function ensureHome(config, { force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL) return homeSnapshot();
  if (building) return homeSnapshot();

  building = (async () => {
    try {
      const home = await build(config);
      cache = { at: Date.now(), home };
    } catch (err) {
      console.warn('[tpdbarr] home build failed -', err.message);
    } finally {
      building = null;
    }
  })();

  return homeSnapshot();
}

// ------------------------------------------------------------------- dates

const day = (d) => String(d).slice(0, 10);
const today = () => day(new Date().toISOString());
const daysAgo = (n) => day(new Date(Date.now() - n * 86400000).toISOString());
const byDate = (a, b) => String(b.date).localeCompare(String(a.date));
const byDateAsc = (a, b) => String(a.date).localeCompare(String(b.date));

const report = (label) => (err) => {
  console.warn(`[tpdbarr] home section "${label}" failed -`, err.message);
  return [];
};

// --------------------------------------------------------------- the build

async function build(config) {
  const watermark = config.lastSeenAt ? day(config.lastSeenAt) : null;
  const state = await whisparrState(config);

  const [siteScenes, discovery, performers, cover] = await Promise.all([
    fromYourSites(config, state).catch(report('your sites')),
    fromStudios(config).catch(report('studios')),
    fromPerformers(config).catch(report('performers')),
    coverage(config, state).catch((err) => {
      console.warn('[tpdbarr] home section "coverage" failed -', err.message);
      return { basis: 'whisparr', rows: [] };
    }),
  ]);

  const home = {
    since: sinceBand(siteScenes, performers, watermark),
    attention: {
      stale: await staleWanted(config, state),
      upcoming: siteScenes.filter((s) => s.date > today()).sort(byDateAsc).slice(0, 8),
      whisparrError: state.error,
    },
    coverage: cover,
    performers: performers.slice(0, 6),
    discovery: { scenes: discovery },
    watermark,
  };

  await annotate(config, state, allScenes(home));

  /*
   * Advance the watermark only once the page has actually been built, and
   * always compare against the value from before it. A rebuild inside the same
   * day therefore finds nothing new — which is why the band falls back to
   * "Latest from your sites" rather than rendering an empty row.
   */
  await saveConfig({ lastSeenAt: new Date().toISOString() }).catch(() => {});

  return home;
}

function allScenes(home) {
  return [
    ...home.since.scenes,
    ...home.attention.upcoming,
    ...home.performers.flatMap((p) => p.scenes),
    ...home.discovery.scenes,
  ];
}

// ------------------------------------------------------ Whisparr, read once

/*
 * Every band that knows what you already have is driven from this one pass:
 * the new-releases feed, the stale list, the completion table and the badges
 * on every card. Reading it once is the difference between one walk over the
 * library and four.
 */
async function whisparrState(config) {
  const out = { series: [], perSeries: new Map(), byTpdbId: new Map(), error: null };
  if (!whisparr2Configured(config)) return out;

  try {
    out.series = await whisparr.listSeries(config);
    for (const one of out.series) {
      const eps = await whisparr.episodes(config, one.id);
      out.perSeries.set(one.id, eps);
      for (const episode of eps) out.byTpdbId.set(episode.tvdbId, episode);
    }
  } catch (err) {
    out.error = err.message;
    console.warn('[tpdbarr] could not read Whisparr state for the home page -', err.message);
  }

  return out;
}

// ------------------------------------------------------------- the sections

async function fromYourSites(config, state) {
  if (!state.series.length) return [];

  const perSite = await Promise.all(
    state.series
      .slice(0, MAX_SITES)
      .map((s) => tpdb.recentForSite(config, s.tvdbId, { limit: 8 }).catch(() => []))
  );

  return perSite.flat().sort(byDate);
}

/*
 * The global feed is mostly clip sites, so this has to read a long way to fill
 * a row — roughly 2000 scenes for 24 cards. It runs in the background and is
 * cached, so the depth costs nothing at page load.
 */
async function fromStudios(config) {
  return tpdb.recentGlobal(config, { pages: 20, limit: 24 });
}

/*
 * Grouped by performer rather than flattened into one row. Performer is the
 * primary entity everywhere else in this hobby — a scene listed under a name is
 * a different question from a scene listed under a date.
 */
async function fromPerformers(config) {
  if (!stashConfigured(config)) return [];

  const performers = await stash.followedPerformers(config, { limit: 25 });
  if (!performers.length) return [];

  const seen = new Set();
  const groups = [];

  for (const performer of performers) {
    const scenes = await tpdb.recentForPerformer(config, performer.uuid, { limit: 6 }).catch(() => []);

    const fresh = [];
    for (const scene of scenes) {
      if (seen.has(scene.id)) continue;
      seen.add(scene.id);
      fresh.push({ ...scene, because: performer.name });
    }

    if (fresh.length) {
      groups.push({ name: performer.name, uuid: performer.uuid, scenes: fresh.sort(byDate) });
    }
  }

  // Whoever released most recently goes first.
  return groups.sort((a, b) => byDate(a.scenes[0], b.scenes[0]));
}

// ---------------------------------------------------------------- the bands

/*
 * "New" is meaningless without a personal watermark — an absolute date sort is
 * the same three rows you already scrolled past this morning. Upcoming scenes
 * are held back for the attention band, or they would sit at the top of this
 * one forever.
 */
function sinceBand(siteScenes, performerGroups, watermark) {
  const now = today();
  const cutoff = watermark || daysAgo(FIRST_RUN_DAYS);

  const union = new Map();
  for (const scene of [...siteScenes, ...performerGroups.flatMap((p) => p.scenes)]) {
    if (!union.has(scene.id)) union.set(scene.id, scene);
  }

  const released = [...union.values()].filter((s) => s.date && s.date <= now).sort(byDate);
  const fresh = released.filter((s) => s.date > cutoff);

  if (fresh.length) {
    return {
      mode: 'since',
      title: 'Since your last visit',
      note: `released after ${cutoff}, from your sites and your performers`,
      cutoff,
      scenes: fresh.slice(0, 24),
    };
  }

  return {
    mode: 'latest',
    title: 'Latest from your sites',
    note: `nothing new since ${cutoff} — the most recent instead`,
    cutoff,
    scenes: released.slice(0, 12),
  };
}

/*
 * Monitored, no file, and the release date well past. Whisparr will not tell
 * you this on its own — it just keeps searching quietly forever.
 *
 * Minus what Stash already has: v2 never unmonitors a scene the pipeline filed
 * (see tidy.mjs), so without this the nudge counts the shelf as missing.
 */
async function staleWanted(config, state) {
  const cutoff = daysAgo(STALE_DAYS);
  const shelf = stashConfigured(config) ? await stash.titleDateIndex(config).catch(() => null) : null;
  const titles = new Map(state.series.map((s) => [s.id, s.title]));
  const out = [];

  for (const eps of state.perSeries.values()) {
    for (const episode of eps) {
      if (episode.hasFile || !episode.monitored) continue;
      const date = day(episode.airDateUtc || episode.airDate || '');
      if (!date || date > cutoff) continue;
      if (stash.matchByTitleDate(shelf, { title: episode.title, date })) continue;
      out.push({
        title: episode.title || '(untitled)',
        site: titles.get(episode.seriesId) || '',
        date,
      });
    }
  }

  return { total: out.length, records: out.sort(byDate).slice(0, 8), days: STALE_DAYS };
}

/*
 * How much of each site you actually have.
 *
 * Counted in Stash, not in Whisparr. Whisparr is a downloader: a scene passes
 * through it, gets encoded and moved, Stash imports it, and Whisparr is then
 * told to delete it and not fetch it again. So `hasFile` is true only for the
 * hours a scene is in flight — Stash is the thing that remembers.
 *
 * Whisparr is still consulted, for the scenes currently in flight and for the
 * ones already monitored, so neither shows up as a gap to re-add.
 *
 * Per site this costs one catalogue read from the metadata mirror (cached 6h)
 * and one batched match against Stash, so it is capped: the cost grows with the
 * number of sites you track, not with the size of your library.
 */
async function coverage(config, state) {
  const basis = stashConfigured(config) ? 'stash' : 'whisparr';
  const rows = [];

  for (const series of state.series.slice(0, MAX_COVERAGE_SITES)) {
    const row = await coverageFor(config, state, series).catch((err) => {
      console.warn('[tpdbarr] coverage failed for', series.title, '-', err.message);
      return null;
    });
    if (row) rows.push(row);
  }

  return { basis, rows: rows.sort((a, b) => b.pct - a.pct).slice(0, 6) };
}

async function coverageFor(config, state, series) {
  const site = await metadata.getSite(series.tvdbId);
  const scenes = site.scenes || [];
  if (!scenes.length) return null;

  const byTpdbId = new Map((state.perSeries.get(series.id) || []).map((e) => [e.tvdbId, e]));
  const held = stashConfigured(config) ? (await stash.matchScenes(config, scenes)).found : new Map();

  /*
   * Fingerprint matches need TPDB's per-scene hashes, which only arrive with the
   * slow artwork pull. This reads whatever that job has already cached for the
   * site and never starts one — so once you have opened a site, coverage agrees
   * with what its page told you instead of quietly reporting a lower number.
   */
  const fingerprinted = tpdb.artSnapshot(series.tvdbId).matches;

  let had = 0;
  let wanted = 0;
  const missingIds = [];

  for (const scene of scenes) {
    const episode = byTpdbId.get(scene.id);
    if (held.has(scene.id) || fingerprinted.has(scene.id) || episode?.hasFile) had++;
    else if (episode?.monitored) wanted++;
    else missingIds.push(scene.id);
  }

  return {
    siteId: series.tvdbId,
    title: series.title,
    poster: posterOf(series) || site.poster || null,
    total: scenes.length,
    had,
    wanted,
    missing: missingIds.length,
    // Six hundred scenes behind one button is not a shortcut. Small gaps only.
    missingIds: missingIds.length <= BULK_ADD_LIMIT ? missingIds : [],
    pct: Math.round((had / scenes.length) * 100),
  };
}

function posterOf(series) {
  const images = series.images || [];
  const hit =
    images.find((i) => /poster/i.test(i.coverType || '')) ||
    images.find((i) => /banner|fanart/i.test(i.coverType || ''));
  return hit?.remoteUrl || hit?.url || null;
}

// ----------------------------------------------------- the queue, read live

const isStalled = (r) =>
  /warning|error/i.test(r.trackedDownloadStatus || '') || /failed|warning/i.test(r.status || '');

/*
 * Deliberately outside the 30-minute cache: a queue half an hour out of date is
 * worse than no queue at all.
 */
export async function queueSummary(config) {
  const empty = { total: 0, stalled: [], error: null };
  if (!whisparr2Configured(config)) return empty;

  try {
    const records = (await whisparr.queue(config)).records || [];
    return {
      total: records.length,
      stalled: records
        .filter(isStalled)
        .slice(0, 8)
        .map((r) => ({
          title: r.episode?.title || r.title || '(untitled)',
          site: r.series?.title || '',
          why: r.errorMessage || r.statusMessages?.[0]?.title || r.trackedDownloadState || r.status || 'stalled',
        })),
      error: null,
    };
  } catch (err) {
    return { ...empty, error: err.message };
  }
}

// ------------------------------------------------ what we already have of it

async function annotate(config, state, scenes) {
  if (!scenes.length) return;

  // TPDB stash id and title + date first, then fingerprints — the same order
  // as the site pages (library.annotateScenes). Fingerprints alone missed any
  // scene Stash has no phash for yet, and called it not held.
  const [held, index] = stashConfigured(config)
    ? await Promise.all([
      stash.matchScenes(config, scenes).then((r) => r.found).catch(() => new Map()),
      stash.fingerprintIndex(config).catch(() => null),
    ])
    : [new Map(), null];

  for (const scene of scenes) {
    const episode = state.byTpdbId.get(scene.id);
    scene.status = episode?.hasFile ? 'downloaded' : episode?.monitored ? 'monitored' : 'absent';

    const hit = held.get(scene.id) || (index ? stash.matchByFingerprints(index, scene) : null);
    scene.stash = hit
      ? { match: hit.match, via: hit.via || null, id: hit.scene.id, path: hit.scene.path || hit.scene.files?.[0]?.path || null }
      : null;

    // Fingerprints are only needed for matching; don't ship them to the browser.
    delete scene.phashes;
    delete scene.oshashes;
  }
}
