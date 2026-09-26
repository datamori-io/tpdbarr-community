import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, publicConfig, isConfigured, whisparr2Configured, stashConfigured, whisparr3Reachable, whisparr3Configured, validate } from './config.mjs';
import * as metadata from './metadata.mjs';
import * as whisparr from './whisparr.mjs';
import * as whisparr3 from './whisparr3.mjs';
import * as moviefiles from './moviefiles.mjs';
import * as watch from './watch.mjs';
import * as gapfill from './gapfill.mjs';
import * as tmdb from './tmdb.mjs';
import * as stash from './stash.mjs';
import * as tpdb from './tpdb.mjs';
import * as stashdb from './stashdb.mjs';
import * as discover from './discover.mjs';
import * as ruleKinds from './rules.mjs';
import * as overview from './overview.mjs';
import * as feeds from './feeds.mjs';
import * as integrations from './integrations.mjs';
import * as imagesearch from './imagesearch.mjs';
import * as matchsort from './matchsort.mjs';
import * as wildcard from './wildcard.mjs';
import * as prowlarr from './prowlarr.mjs';
import * as manualdrop from './manualdrop.mjs';
import * as monitored from './monitored.mjs';
import { heldForV2, heldForV3, refusal } from './heldguard.mjs';
import * as renamer from './renamer.mjs';
import * as filer from './filer.mjs';
import * as catalogue from './catalogue.mjs';
import * as chores from './chores.mjs';
import * as categories from './categories.mjs';
import * as tv from './tv.mjs';
import * as artwork from './artwork.mjs';
import * as groupbuilder from './groupbuilder.mjs';
import * as backup from './backup.mjs';
import { siteView, sceneView, performerView, creatorsView } from './library.mjs';
import { moviesView, movieView, forgetMovies } from './movies.mjs';
import * as shelf from './stashlib.mjs';
import * as groupurl from './groupurl.mjs';
import * as identify from './identify.mjs';
import * as films from './films.mjs';
import * as tidy from './tidy.mjs';
import { studioPage } from './studiopage.mjs';
import { performerPage } from './performerpage.mjs';
import * as galleries from './galleries.mjs';
import * as galleryscrape from './galleryscrape.mjs';
import * as gallerybuild from './gallerybuild.mjs';
import * as galleryupload from './galleryupload.mjs';
import * as reddit from './reddit.mjs';
import * as redgifs from './redgifs.mjs';
import * as markerclips from './markerclips.mjs';
import * as scenethumb from './scenethumb.mjs';
import * as markerbuilder from './markerbuilder.mjs';
import * as spritestrip from './spritestrip.mjs';
import * as markersources from './markersources.mjs';
import * as downscale from './downscale.mjs';
import * as resolution from './resolution.mjs';
import * as release from './release.mjs';
import * as catchup from './catchup.mjs';
import * as sceneremove from './sceneremove.mjs';
import { proxy as proxyMedia, forgetSprites, forgetImages } from './media.mjs';
import { ensureHome, homeSnapshot, forgetHome, queueSummary } from './home.mjs';
import { ensureGaps, gapsSnapshot, forgetGaps } from './gaps.mjs';

const PORT = Number(process.env.PORT || 6980);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------- routes

/* Parses the search filters. Shared with "skip all remaining" so both read the same filters. */
function searchFilter(p) {
  return {
    text: (p.get('q') || '').trim(),
    title: (p.get('title') || '').trim(),
    studios: p.getAll('studio'),
    performers: p.getAll('performer'),
    tags: p.getAll('tag'),
    date: p.get('date') || '',
    dateModifier: p.get('dateop') || 'GREATER_THAN',
    sort: p.get('sort') || 'DATE',
    direction: p.get('dir') || 'DESC',
    page: p.get('page'),
    // How many at once. Capped in discover.mjs rather than here, because the
    // queue reads it as a batch size and the results as a page.
    perPage: p.get('per'),
    // Where the decide queue got to. Only that flow sends one.
    cursor: p.get('cursor'),
    have: p.get('have') || 'missing',
    show: p.get('show') || 'open',
    // Every tracked catalogue at once rather than one named in the filters.
    // Only the queue reads it; it means nothing to a page of results.
    pooled: p.get('pool') === '1',
    // Likeliest yes first, scored against what is already in the library.
    ranked: p.get('rank') === '1',
  };
}

/* Which pile. Shared by the queue and phash routes so they agree. */
const pileOf = (url) => ({
  mode: url.searchParams.get('mode') || 'unmatched',
  q: (url.searchParams.get('q') || '').trim(),
  endpoint: (url.searchParams.get('endpoint') || '').trim(),
  have: url.searchParams.get('have') === '1',
  site: (url.searchParams.get('site') || '').trim(),
  hasSite: url.searchParams.get('hassite') === '1',
  aside: url.searchParams.get('aside') === '1',
  thin: url.searchParams.get('thin') === '1',
  described: url.searchParams.get('described') === '1',
});

const routes = [
  ['GET', /^\/api\/state$/, async () => {
    const config = await loadConfig();
    const state = {
      configured: isConfigured(config),
      config: publicConfig(config),
      whisparr: { ok: false, enabled: Boolean(config.whisparrUrl && config.apiKey) },
      whisparr3: { ok: false, enabled: whisparr3Reachable(config), configured: whisparr3Configured(config) },
      stash: { ok: false, enabled: stashConfigured(config) },
      tpdb: { available: await tpdb.available(config), source: 'stash' },
      tmdb: { enabled: tmdb.configured(config), ok: false },
    };

    if (config.whisparrUrl && config.apiKey) {
      try {
        const status = await whisparr.systemStatus(config);
        const major = parseInt(String(status.version || '0').split('.')[0], 10);
        state.whisparr = { ...state.whisparr, ok: true, version: status.version, isV2: major === 2 };
      } catch (err) {
        state.whisparr = { ...state.whisparr, ok: false, error: err.message };
      }
    }

    if (whisparr3Reachable(config)) {
      try {
        const seen = await whisparr3.identify(config);
        state.whisparr3 = { ...state.whisparr3, ok: true, version: seen.version, isV3: seen.isV3 };
      } catch (err) {
        state.whisparr3 = { ...state.whisparr3, ok: false, error: err.message };
      }
    }

    if (tmdb.configured(config)) {
      try {
        await tmdb.check(config);
        state.tmdb = { enabled: true, ok: true };
      } catch (err) {
        state.tmdb = { enabled: true, ok: false, error: err.message };
      }
    }

    if (stashConfigured(config)) {
      try {
        const [v, endpoint] = await Promise.all([stash.version(config), stash.tpdbEndpoint(config)]);
        state.stash = { ok: true, enabled: true, version: v.version?.version || '?', endpoint };
      } catch (err) {
        state.stash = { ok: false, enabled: true, error: err.message };
      }
    }

    return state;
  }],

  ['GET', /^\/api\/home$/, async (_m, _b, url) => {
    const config = await loadConfig();
    await ensureHome(config, { force: url.searchParams.get('refresh') === '1' });

    // The queue moves faster than the 30-minute cache, so it is read every time.
    const snapshot = homeSnapshot();
    snapshot.queue = await queueSummary(config);
    return snapshot;
  }],

  ['GET', /^\/api\/options$/, async (_m, _b, url) => {
    const config = await loadConfig();
    const client = url.searchParams.get('instance') === 'v3' ? whisparr3 : whisparr;

    const [profiles, folders] = await Promise.all([
      client.qualityProfiles(config),
      client.rootFolders(config),
    ]);
    return {
      qualityProfiles: profiles.map((p) => ({ id: p.id, name: p.name })),
      rootFolders: folders.map((f) => ({ path: f.path, freeSpace: f.freeSpace })),
    };
  }],

  ['POST', /^\/api\/config$/, async (_m, body) => {
    const warnings = validate(body || {});
    const saved = await saveConfig(body || {});
    tpdb.forgetToken(); // Stash details may have changed
    forgetHome();
    forgetGaps();
    forgetMovies();
    stash.forgetGroups();
    shelf.forgetRails();
    forgetSprites();
    forgetImages();
    return { config: publicConfig(saved), configured: isConfigured(saved), warnings };
  }],

  /* Its own route: /api/config drops every cache. */
  ['POST', /^\/api\/tilescale$/, async (_m, body) => {
    const page = String(body?.page || '').slice(0, 80);
    const step = String(body?.step || '');
    if (!page) throw new Error('page is required');
    if (!['s', 'm', 'l', 'xl'].includes(step)) throw new Error('unknown size step');

    const config = await loadConfig();
    const tileScale = { ...config.tileScale };
    // "m" is the default, so storing it would just grow the file forever.
    if (step === 'm') delete tileScale[page];
    else tileScale[page] = step;

    const saved = await saveConfig({ tileScale });
    return { tileScale: saved.tileScale };
  }],

  ['GET', /^\/api\/sites$/, async (_m, _b, url) => {
    const sites = await metadata.searchSites(url.searchParams.get('q'));
    return { sites };
  }],

  ['GET', /^\/api\/sites\/(\d+)$/, async (m) => {
    const config = await loadConfig();
    return siteView(config, Number(m[1]));
  }],

  // Both are keyed on the TPDB UUID, not the numeric id the catalogue uses.
  ['GET', /^\/api\/scenes\/([0-9a-fA-F-]{36})$/, async (m) => sceneView(await loadConfig(), m[1])],

  ['GET', /^\/api\/performers\/([0-9a-fA-F-]{36})$/, async (m) => performerView(await loadConfig(), m[1])],

  /* Movies (TPDB, checked against Stash groups) and creators (your library's cast). */
  ['GET', /^\/api\/movies$/, async (_m, _b, url) =>
    moviesView(await loadConfig(), {
      force: url.searchParams.get('refresh') === '1',
      q: url.searchParams.get('q') || '',
      sort: url.searchParams.get('sort') || 'date',
    })],

  ['GET', /^\/api\/movies\/([0-9a-fA-F-]{36})$/, async (m) => movieView(await loadConfig(), m[1])],

  ['GET', /^\/api\/creators$/, async () => creatorsView(await loadConfig())],

  // Polled while the background artwork pull for a site is still running.
  ['GET', /^\/api\/sites\/(\d+)\/art$/, async (m) => {
    const siteId = Number(m[1]);
    const { art, matches, progress } = tpdb.artSnapshot(siteId);

    const out = {};
    for (const [id, value] of art) {
      out[id] = {
        image: value.image,
        isMovie: value.isMovie,
        poster: value.poster,
        still: value.still,
        tags: value.tags,
        duration: value.duration,
      };
    }

    const stashHits = {};
    for (const [id, value] of matches) stashHits[id] = value;

    return { progress, art: out, stash: stashHits };
  }],

  ['POST', /^\/api\/add$/, async (_m, body) => {
    const config = await loadConfig();
    if (!whisparr2Configured(config)) throw httpError(400, 'Whisparr is not configured yet');

    const siteId = Number(body?.siteId);
    const sceneIds = Array.isArray(body?.sceneIds) ? body.sceneIds.map(Number).filter(Boolean) : [];
    if (!siteId || !sceneIds.length) throw httpError(400, 'siteId and sceneIds are required');

    // What Stash already has is left out; if that is all of it, say so rather
    // than reporting an add that did nothing. `force` sends everything.
    const held = body?.force ? [] : await heldForV2(config, siteId, sceneIds);
    const heldIds = new Set(held.map((h) => Number(h.id)));
    const rest = sceneIds.filter((id) => !heldIds.has(id));
    if (!rest.length) throw refusal(held);

    const out = await whisparr.addScenes(config, siteId, rest);
    monitored.forget();
    return held.length ? { ...out, heldSkipped: held } : out;
  }],

  ['GET', /^\/api\/queue$/, async () => {
    const config = await loadConfig();
    const q = await whisparr.queue(config);
    return {
      records: (q.records || []).map((r) => ({
        id: r.id,
        title: r.episode?.title || r.title,
        series: r.series?.title || '',
        status: r.status,
        trackedDownloadState: r.trackedDownloadState,
        sizeleft: r.sizeleft,
        size: r.size,
        timeleft: r.timeleft || null,
      })),
    };
  }],

  /*
   * ------------------------------------------------------------- stashdb
   *
   * Search starts at StashDB: its ids are what v3 and Stash use. Each result
   * says whether Stash has it and what v3 thinks.
   */

  ['GET', /^\/api\/stashdb\/search$/, async (_m, _b, url) => {
    const config = await loadConfig();
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) throw httpError(400, 'A search term is required.');

    if (!(await stashdb.available(config))) return { available: false, count: 0, scenes: [] };

    const { count, scenes } = await stashdb.searchScenes(config, q);
    return { available: true, count, scenes: await annotate(config, scenes) };
  }],

  ['GET', /^\/api\/stashdb\/scenes\/([0-9a-fA-F-]{36})$/, async (m) => {
    const config = await loadConfig();
    const scene = await stashdb.getScene(config, m[1]);
    if (!scene) throw httpError(404, 'StashDB has no scene with that id.');

    const [annotated] = await annotate(config, [scene]);
    return { scene: annotated };
  }],

  /*
   * Is this TPDB scene on StashDB? Exact = fingerprint; probable = title and
   * date, only reported. The browser decides what to do.
   */
  ['GET', /^\/api\/stashdb\/bridge\/([0-9a-fA-F-]{36})$/, async (m) => {
    const config = await loadConfig();
    if (!(await stashdb.available(config))) return { available: false, match: null };

    const scene = await tpdb.getScene(config, m[1]);
    if (!scene) throw httpError(404, 'ThePornDB has no scene with that id.');

    const found = await stashdb.bridge(config, scene);
    if (!found) return { available: true, match: null };

    const [annotated] = await annotate(config, [found.scene]);
    return { available: true, match: found.match, via: found.via, scene: annotated, others: found.others };
  }],

  /*
   * -------------------------------------------------------------- acquire
   *
   * Filters go to StashDB whole, so counts are of the match. See discover.mjs.
   */

  /* Import overview: tracked catalogues summed, plus suggestions. Built in the background. */
  ['GET', /^\/api\/import\/overview$/, async (_m, _b, url) => {
    const config = await loadConfig();
    /* Start coverage so the summary isn't stuck on "measuring". Not awaited. */
    discover.ensureCoverage(config).catch(() => {});
    return overview.ensureOverview(config, { force: url.searchParams.get('refresh') === '1' });
  }],

  // Live, always. A pipeline view half an hour old is worse than none.
  ['GET', /^\/api\/import\/integrations$/, async () => integrations.view(await loadConfig())],

  /* Backups, read from disk. */
  ['GET', /^\/api\/import\/backups$/, async () =>
    ({ ...backup.snapshot(), onDisk: await backup.existing() })],

  ['POST', /^\/api\/import\/backups$/, async () => backup.run({ force: true, why: 'asked for' })],

  /* Image search. `places` only lists where to look; only offered URLs are fetched. */
  ['GET', /^\/api\/import\/images\/places$/, async (_m, _b, url) =>
    imagesearch.placesToLook((url.searchParams.get('name') || '').trim())],

  /* A listing page read for its galleries. Only addresses `places` offered. */
  /*
   * ------------------------------------------------------- match and sort
   *
   * Scenes with no stash id, no cover, or not organised. Every write is on a
   * press. `sources` is a list; apply takes picks back, not ids.
   */

  ['GET', /^\/api\/import\/match\/sources$/, async () =>
    matchsort.sources(await stashLibrary())],

  // The hosts this library's scene links actually point at, for the filter
  // beside the stash-box one. Counted off the scenes, not off the scrapers.
  ['GET', /^\/api\/import\/match\/sites$/, async () =>
    matchsort.sites(await stashLibrary())],

  ['GET', /^\/api\/import\/match$/, async (_m, _b, url) =>
    matchsort.queue(await stashLibrary(), {
      mode: url.searchParams.get('mode') || 'unmatched',
      page: url.searchParams.get('page'),
      sort: url.searchParams.get('sort') || matchsort.SORT_DEFAULT,
      dir: url.searchParams.get('dir') || 'desc',
      q: (url.searchParams.get('q') || '').trim(),
      // One stash-box only. See endpointTerm() in matchsort.mjs.
      endpoint: (url.searchParams.get('endpoint') || '').trim(),
      have: url.searchParams.get('have') === '1',
      // The scraper half of the same question. A scraper files a URL rather
      // than an id, so this asks the link — see siteTerm() in matchsort.mjs.
      site: (url.searchParams.get('site') || '').trim(),
      hasSite: url.searchParams.get('hassite') === '1',
      // Scenes you have looked for and given up on are out of every pile
      // until this asks for them.
      aside: url.searchParams.get('aside') === '1',
      // Only the ones still missing a title, a studio or a date — the ones
      // nobody has described yet, rather than the ones already been to.
      thin: url.searchParams.get('thin') === '1',
      // The opposite: only the ones that already have a title, a studio and a
      // date. On the unorganised pile that is the bulk-clearable half.
      described: url.searchParams.get('described') === '1',
    })],

  /* What's left to catalogue, by folder. One pass rather than six counts. */
  ['GET', /^\/api\/catalogue\/overview$/, async () =>
    catalogue.overview(await stashLibrary())],

  /* Tell Stash to scan the disk. Returns a job id; the page watches it. */
  ['GET', /^\/api\/catalogue\/scan$/, async () =>
    catalogue.scanState(await stashLibrary())],

  ['POST', /^\/api\/catalogue\/scan$/, async () =>
    catalogue.startScan(await stashLibrary())],

  ['GET', /^\/api\/catalogue\/scan\/(\d+)$/, async (m) =>
    catalogue.scanStatus(await stashLibrary(), m[1])],

  /*
   * Previews, sprites, image and clip previews for /organized_scenes only.
   * Returns a job id.
   */
  ['GET', /^\/api\/catalogue\/generate$/, async () =>
    catalogue.generateState(await stashLibrary())],

  ['POST', /^\/api\/catalogue\/generate$/, async () =>
    catalogue.generateMedia(await stashLibrary())],

  ['GET', /^\/api\/catalogue\/generate\/(\d+)$/, async (m) =>
    catalogue.generateStatus(await stashLibrary(), m[1])],

  /* Manage › Stash: organized scan, the chores (chores.mjs), and Stash's phash duplicate finder. */
  ['GET', /^\/api\/manage\/scan$/, async () =>
    catalogue.scanState(await stashLibrary())],

  ['POST', /^\/api\/manage\/scan$/, async () =>
    catalogue.startScan(await stashLibrary(), ['/organized_scenes'])],

  ['GET', /^\/api\/manage\/scan\/(\d+)$/, async (m) =>
    catalogue.scanStatus(await stashLibrary(), m[1])],

  ['GET', /^\/api\/manage\/duplicates$/, async (_m, _b, url) =>
    chores.duplicates(await stashLibrary(), url.searchParams.get('distance'))],

  ['GET', /^\/api\/manage\/chores$/, async () => chores.state()],

  ['POST', /^\/api\/manage\/chores\/stop$/, async () => chores.stop()],

  ['GET', /^\/api\/manage\/reshelve$/, async () =>
    chores.reshelvePlan(await stashLibrary())],

  ['POST', /^\/api\/manage\/reshelve$/, async () =>
    chores.reshelve(await stashLibrary())],

  ['POST', /^\/api\/manage\/copies\/keep-better$/, async () =>
    chores.keepBetter(await stashLibrary())],

  ['POST', /^\/api\/manage\/nfo\/(missing|all)$/, async (m) =>
    chores.nfos(await stashLibrary(), m[1] === 'all')],

  ['POST', /^\/api\/manage\/thumbs\/(missing|all)$/, async (m) =>
    chores.thumbs(await stashLibrary(), m[1] === 'all')],

  /* Missing phashes for this pile, and generating them. Returns a job id. */
  ['GET', /^\/api\/import\/match\/phash$/, async (_m, _b, url) =>
    matchsort.phashPlan(await stashLibrary(), pileOf(url))],

  ['POST', /^\/api\/import\/match\/phash$/, async (_m, _b, url) =>
    matchsort.generatePhashes(await stashLibrary(), pileOf(url))],

  ['GET', /^\/api\/import\/match\/phash\/(\d+)$/, async (m) =>
    matchsort.phashStatus(await stashLibrary(), m[1])],

  /* Cover, preview, sprites and phash for one scene. Numeric id, unlike the UUID routes. */
  ['POST', /^\/api\/scenes\/(\d+)\/generate$/, async (m) =>
    matchsort.generateFor(await stashLibrary(), m[1])],

  ['GET', /^\/api\/scenes\/(\d+)\/generate\/(\d+)$/, async (m) =>
    matchsort.generateStatus(await stashLibrary(), m[2])],

  ['GET', /^\/api\/import\/match\/(\d+)$/, async (m, _b, url) =>
    matchsort.candidates(await stashLibrary(), m[1], {
      sources: url.searchParams.getAll('source').filter(Boolean),
      term: (url.searchParams.get('term') || '').trim(),
    })],

  ['POST', /^\/api\/import\/match\/(\d+)$/, async (m, body) => {
    // The old single-id shape, still answered: one StashDB id is a list of one.
    const picks = Array.isArray(body?.picks) && body.picks.length
      ? body.picks
      : body?.stashdbId
        ? [{ source: 'stashdb', sourceLabel: 'StashDB', endpoint: body.endpoint || null, remoteId: String(body.stashdbId) }]
        : [];

    if (!picks.length) throw httpError(400, 'Which scene, from which source?');

    return matchsort.applyMatch(await stashLibrary(), m[1], {
      picks,
      fields: Array.isArray(body.fields) ? body.fields : [],
      overwrite: Boolean(body.overwrite),
      rename: body.rename === true,
    });
  }],

  /* One candidate's page. POST so the URL comes from a deliberate press, not a link. */
  ['POST', /^\/api\/import\/match\/(\d+)\/page$/, async (m, body) =>
    matchsort.readPage(await stashLibrary(), m[1], body?.url || '', body?.key || null)],

  /* The filename these picks would give. POST because it carries picks; doesn't write. */
  ['POST', /^\/api\/import\/match\/(\d+)\/rename\/plan$/, async (m, body) =>
    matchsort.renamePlan(await stashLibrary(), m[1], {
      picks: Array.isArray(body?.picks) ? body.picks : [],
      fields: Array.isArray(body?.fields) ? body.fields : [],
      overwrite: Boolean(body?.overwrite),
    })],

  /*
   * ---------------------------------------------------------- the wild card
   *
   * One scene, several sources, assembled by hand: `scrapeSceneURL` for a
   * page you found, NAME scrapes for a phrase. POSTs, though they only read.
   */

  ['GET', /^\/api\/import\/wildcard\/sources$/, async () =>
    wildcard.sources(await stashLibrary())],

  ['GET', /^\/api\/import\/wildcard\/find$/, async (_m, _b, url) =>
    wildcard.find(await stashLibrary(), (url.searchParams.get('q') || '').trim())],

  /*
   * Studios, performers and tags Stash holds. The write attaches by name, so
   * a typed name that doesn't exist would be silently dropped.
   */
  ['GET', /^\/api\/import\/wildcard\/names$/, async (_m, _b, url) =>
    wildcard.names(
      await stashLibrary(),
      (url.searchParams.get('kind') || '').trim(),
      (url.searchParams.get('q') || '').trim()
    )],

  /* Create a studio, performer or tag, one at a time, on a press. */
  ['POST', /^\/api\/import\/wildcard\/names$/, async (_m, body) =>
    wildcard.create(
      await stashLibrary(),
      String(body?.kind || '').trim(),
      String(body?.name || '').trim()
    )],

  ['GET', /^\/api\/import\/wildcard\/scene\/(\d+)$/, async (m) =>
    wildcard.scene(await stashLibrary(), m[1])],

  /* Frames to search by. Listing is free; cutting only on a press. */
  /* Frames cut from a file, for Wild Card and Match. The old wildcard path still answers. */
  ['GET', /^\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)$/, async (m) =>
    scenethumb.frames(await loadConfig(), m[1])],

  ['POST', /^\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)$/, async (m, body) =>
    scenethumb.cutFrames(await loadConfig(), m[1], { count: Number(body?.count) || undefined })],

  ['POST', /^\/api\/import\/wildcard\/urls$/, async (_m, body) =>
    wildcard.fromUrls(await stashLibrary(), body?.urls || [])],

  ['POST', /^\/api\/import\/wildcard\/ask$/, async (_m, body) =>
    wildcard.ask(await stashLibrary(), body?.query || '', body?.sources || [])],

  ['POST', /^\/api\/import\/wildcard\/scene\/(\d+)$/, async (m, body) =>
    wildcard.apply(await stashLibrary(), m[1], body?.values || {}, {
      rename: body?.rename === true,
    })],

  /* The filename the record on screen would give. POST because it carries the choices. */
  ['POST', /^\/api\/import\/wildcard\/scene\/(\d+)\/rename\/plan$/, async (m, body) =>
    renamer.plan(await stashLibrary(), m[1], body?.values || null)],

  /* Rename a matched file. Scoped to /pc-import in renamer.mjs; only a scene id crosses here. */
  /* Set a scene aside, or undo it. A tag on the scene. */
  ['POST', /^\/api\/import\/match\/(\d+)\/aside$/, async (m, body) =>
    /* The endpoint scopes it: "no box has this" vs "TPDB doesn't". */
    matchsort.setAside(await stashLibrary(), m[1], body?.aside !== false, body?.endpoint || '')],

  ['GET', /^\/api\/import\/match\/(\d+)\/rename$/, async (m) =>
    renamer.plan(await stashLibrary(), m[1])],

  ['POST', /^\/api\/import\/match\/(\d+)\/rename$/, async (m) =>
    renamer.rename(await stashLibrary(), m[1])],

  ['GET', /^\/api\/import\/tags$/, async (_m, _b, url) =>
    matchsort.tags(await stashLibrary(), (url.searchParams.get('q') || '').trim())],

  ['POST', /^\/api\/import\/tags$/, async (_m, body) =>
    matchsort.addTags(await stashLibrary(), body?.scenes || [], body?.tags || [], {
      organized: typeof body?.organized === 'boolean' ? body.organized : null,
    })],

  /*
   * ---------------------------------------------------------- group builder
   *
   * Films your loose scenes add up to. Approve and the per-scene answers are
   * the only writes. See groupbuilder.mjs.
   */

  ['GET', /^\/api\/import\/groups$/, async () => groupbuilder.studios(await stashLibrary())],

  /* Start a studio's scan and return. The page polls for progress. */
  ['POST', /^\/api\/import\/groups\/scan$/, async (_m, body) => {
    if (!body?.studio) throw httpError(400, 'Which studio should be scanned?');
    return groupbuilder.scan(await stashLibrary(), String(body.studio), { force: body.force === true });
  }],

  /* Offline tier: films named in scene titles. One pass over the library. */
  ['POST', /^\/api\/import\/groups\/titles$/, async () =>
    groupbuilder.scanTitles(await stashLibrary())],

  ['GET', /^\/api\/import\/groups\/proposals$/, async (_m, _b, url) =>
    groupbuilder.proposals(await loadConfig(), { studio: url.searchParams.get('studio') || null })],

  // The one write that makes a group. Everything it will do is on screen first.
  ['POST', /^\/api\/import\/groups\/([^/]+)\/approve$/, async (m, body) =>
    groupbuilder.approve(await stashLibrary(), decodeURIComponent(m[1]), {
      sceneIds: Array.isArray(body?.sceneIds) ? body.sceneIds.map(String) : null,
    })],

  ['POST', /^\/api\/import\/groups\/([^/]+)\/decline$/, async (m) =>
    groupbuilder.decline(await loadConfig(), decodeURIComponent(m[1]))],

  ['POST', /^\/api\/import\/groups\/([^/]+)\/reconsider$/, async (m) =>
    groupbuilder.reconsider(await loadConfig(), decodeURIComponent(m[1]))],

  /* One missing scene answered. Key is a TPDB guid or "<movie>:<n>" (IAFD only). */
  ['POST', /^\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)$/, async (m, body) =>
    groupbuilder.decideScene(await loadConfig(), decodeURIComponent(m[1]), decodeURIComponent(m[2]), String(body?.verdict || ''), { force: Boolean(body?.force) })],

  ['DELETE', /^\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)$/, async (m) =>
    groupbuilder.undecideScene(await loadConfig(), decodeURIComponent(m[1]), decodeURIComponent(m[2]))],

  // What StashDB has for a cast IAFD named and nothing else. Writes nothing.
  ['GET', /^\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find$/, async (m) =>
    groupbuilder.findMissing(await loadConfig(), decodeURIComponent(m[1]), decodeURIComponent(m[2]))],

  /* Name which candidate it is. Writes only to this page's store. */
  ['POST', /^\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find$/, async (m, body) =>
    groupbuilder.resolveMissing(await loadConfig(), decodeURIComponent(m[1]), decodeURIComponent(m[2]), body?.stashdbId)],

  /*
   * --------------------------------------------------- the marker builder
   *
   * Cutting markers by hand. Needs Stash only. See markerbuilder.mjs.
   */
  ['GET', /^\/api\/import\/markers$/, async (_m, _b, url) =>
    markerbuilder.queue(await stashLibrary(), {
      q: url.searchParams.get('q') || '',
      mode: url.searchParams.get('mode') || 'unmarked',
      page: Number(url.searchParams.get('page')) || 1,
    })],

  /* Must stay above /api/import/markers so that route can't swallow it. */
  ['GET', /^\/api\/import\/markers\/queue$/, async () =>
    markerbuilder.queued(await stashLibrary())],

  /* Every marker, paged — the management list. See all() in markerbuilder.mjs. */
  ['GET', /^\/api\/import\/markers\/all$/, async (_m, _b, url) =>
    markerbuilder.all(await stashLibrary(), {
      q: url.searchParams.get('q') || '',
      tag: url.searchParams.get('tag') || null,
      sort: url.searchParams.get('sort') || 'created_at',
      page: Number(url.searchParams.get('page')) || 1,
      limit: Number(url.searchParams.get('limit')) || 60,
    })],

  // The palette. Marker tags only, seeds first — not the whole 985.
  ['GET', /^\/api\/import\/markers\/tags$/, async () => markerbuilder.tags(await stashLibrary())],

  // The search behind the palette, for a tag that has never been on a marker.
  ['GET', /^\/api\/import\/markers\/tags\/search$/, async (_m, _b, url) =>
    markerbuilder.searchTags(await stashLibrary(), url.searchParams.get('q') || '')],

  ['GET', /^\/api\/import\/markers\/scene\/(\d+)$/, async (m) =>
    markerbuilder.editor(await stashLibrary(), m[1])],

  ['POST', /^\/api\/import\/markers\/scene\/(\d+)$/, async (m, body) =>
    markerbuilder.create(await stashLibrary(), {
      sceneId: m[1],
      seconds: body?.seconds,
      end: body?.end ?? null,
      tagId: body?.tagId || null,
      tagName: body?.tagName || '',
      title: body?.title || '',
    })],

  ['POST', /^\/api\/import\/markers\/marker\/(\d+)$/, async (m, body) =>
    markerbuilder.update(await stashLibrary(), m[1], {
      seconds: body?.seconds ?? null,
      // Untouched unless the body says so, because clearing an out point and
      // leaving it alone are different edits. See update() in markerbuilder.
      end: 'end' in (body || {}) ? body.end : undefined,
      tagId: body?.tagId || null,
      tagName: body?.tagName || '',
      title: body?.title ?? null,
    })],

  ['DELETE', /^\/api\/import\/markers\/marker\/(\d+)$/, async (m) =>
    markerbuilder.destroy(await stashLibrary(), m[1])],

  /* Markers timestamp.trade and ThePornDB have for this scene. Read-only. */
  ['GET', /^\/api\/import\/markers\/scene\/(\d+)\/sources$/, async (m) =>
    markersources.fetched(await stashLibrary(), m[1])],

  /* The sharper filmstrip. See spritestrip.mjs. */
  ['GET', /^\/api\/import\/markers\/scene\/(\d+)\/strip$/, async (m) => spritestrip.view(m[1])],

  ['POST', /^\/api\/import\/markers\/scene\/(\d+)\/strip$/, async (m) => {
    const config = await stashLibrary();

    // Refused rather than queued. The encoder takes every core it is given,
    // and a queue would let a page you have left tie the machine up.
    if (spritestrip.busy() && spritestrip.runningFor() !== m[1]) {
      throw httpError(409, `Already cutting a strip for scene ${spritestrip.runningFor()}. One at a time — it takes every core it can get.`);
    }

    spritestrip.build(config, m[1]);
    return spritestrip.view(m[1]);
  }],

  ['DELETE', /^\/api\/import\/markers\/scene\/(\d+)\/strip$/, async (m) => {
    await spritestrip.remove(m[1]);
    return spritestrip.view(m[1]);
  }],

  ['GET', /^\/api\/import\/images\/galleries$/, async (_m, _b, url) => {
    const target = (url.searchParams.get('url') || '').trim();
    if (!/^https?:\/\//i.test(target)) throw httpError(400, 'That needs to be an http:// or https:// address.');
    return imagesearch.galleriesFor(target);
  }],

  ['GET', /^\/api\/import\/images\/performers$/, async (_m, _b, url) => {
    const config = await loadConfig();
    return { results: await imagesearch.lookup(config, (url.searchParams.get('q') || '').trim()) };
  }],

  ['GET', /^\/api\/acquire\/search$/, async (_m, _b, url) =>
    discover.search(await loadConfig(), searchFilter(url.searchParams))],

  // The chips. One term, whichever kinds were asked for.
  ['GET', /^\/api\/acquire\/lookup$/, async (_m, _b, url) => {
    const config = await loadConfig();
    const term = (url.searchParams.get('q') || '').trim();
    return { results: await discover.lookup(config, url.searchParams.get('kind') || 'all', term) };
  }],

  // Ids back into names, for a search that arrived as a bookmarked URL.
  ['GET', /^\/api\/acquire\/chips$/, async (_m, _b, url) => {
    const config = await loadConfig();
    return discover.resolveChips(config, {
      studios: url.searchParams.getAll('studio'),
      performers: url.searchParams.getAll('performer'),
      tags: url.searchParams.getAll('tag'),
    });
  }],

  /* Wild card results, never merged: TPDB goes to v2, StashDB to v3. */
  ['GET', /^\/api\/acquire\/wildcard$/, async (_m, _b, url) => {
    const config = await loadConfig();
    return discover.wildcard(config, (url.searchParams.get('q') || '').trim());
  }],

  /* Prowlarr search, by hand. Grabs go to Prowlarr's client, not Whisparr. */
  ['GET', /^\/api\/acquire\/prowlarr$/, async (_m, _b, url) => {
    const config = await loadConfig();
    if (!prowlarr.configured(config)) return { available: false, releases: [] };
    try {
      const out = await prowlarr.search(config, (url.searchParams.get('q') || '').trim(), { any: url.searchParams.get('any') === '1' });
      return { available: true, ...out };
    } catch (err) {
      throw httpError(502, err.message);
    }
  }],

  // What either Whisparr is still looking for, with a query for the indexers.
  ['GET', /^\/api\/acquire\/monitored$/, async (_m, _b, url) => {
    const config = await loadConfig();
    const from = url.searchParams.get('from') === 'v2' ? 'v2' : 'v3';
    if (from === 'v3' && !whisparr3Reachable(config)) throw httpError(503, 'Whisparr v3 is not set up.');
    if (from === 'v2' && !(config.whisparrUrl && config.apiKey)) throw httpError(503, 'Whisparr v2 is not set up.');
    return monitored.list(config, from, { force: url.searchParams.get('refresh') === '1' });
  }],

  // What the last carry of NZBGet's Manual downloads did; POST runs one now.
  ['GET', /^\/api\/acquire\/manualdrop$/, async () => manualdrop.lastSweep()],
  ['POST', /^\/api\/acquire\/manualdrop$/, async () => manualdrop.sweep(await loadConfig())],

  // `for` is the Monitored row the band was opened from, when it was, so the
  // row can say it was already grabbed rather than inviting a second one.
  ['POST', /^\/api\/acquire\/prowlarr\/grab$/, async (_m, body) => {
    let out;
    try {
      out = await prowlarr.grab(await loadConfig(), body || {});
    } catch (err) {
      throw httpError(502, err.message);
    }
    if (body?.for) await monitored.noteGrab(body.for, out).catch(() => {});
    return out;
  }],

  /*
   * Coverage for tracked studios and performers. From cache, measured in the
   * background; unmeasured ones come back pending.
   */
  /* The standing noes. Read and written whole. */
  ['GET', /^\/api\/acquire\/rules$/, async () =>
    ({ rules: discover.decideRules(await loadConfig()), kinds: ruleKinds.KINDS })],

  ['POST', /^\/api\/acquire\/rules$/, async (_m, body) =>
    discover.setDecideRules(await loadConfig(), body?.rules || [])],

  ['GET', /^\/api\/acquire\/tracked$/, async (_m, _b, url) => {
    const config = await loadConfig();
    return discover.ensureCoverage(config, { force: url.searchParams.get('refresh') === '1' });
  }],

  ['POST', /^\/api\/acquire\/tracked$/, async (_m, body) => {
    const config = await loadConfig();
    const entry = await discover.track(config, body || {});
    // Measuring starts now rather than on the next page load.
    discover.ensureCoverage(await loadConfig()).catch(() => {});
    return { tracked: entry };
  }],

  ['DELETE', /^\/api\/acquire\/tracked\/(performer|studio|tag)\/([0-9a-fA-F-]{36})$/, async (m) => {
    const config = await loadConfig();
    await discover.untrack(config, m[1], m[2]);
    return { ok: true };
  }],

  /*
   * The want list, one entry per StashDB id. Marking doesn't touch Whisparr;
   * Add does. Untracking unmonitors in Whisparr (files stay).
   */
  /* The nightly release. See release.mjs. */
  ['GET', /^\/api\/acquire\/release$/, async () => release.view(await loadConfig())],

  ['POST', /^\/api\/acquire\/release$/, async (_m, body) =>
    release.update(await loadConfig(), body || {})],

  /* Tonight's batch now, on top of the nightly one. */
  ['POST', /^\/api\/acquire\/release\/now$/, async (_m, body) =>
    release.release(await loadConfig(), { limit: Number(body?.limit) || null, manual: true })],

  ['GET', /^\/api\/acquire\/tracked\/scenes$/, async (_m, _b, url) =>
    discover.trackedSceneView(await loadConfig(), {
      // Only the ones no tracked catalogue covers. Default on — see orphaned().
      loose: url.searchParams.get('loose') !== '0',
      studio: url.searchParams.get('studio') || null,
      performer: url.searchParams.get('performer') || null,
    })],

  ['POST', /^\/api\/acquire\/tracked\/scenes$/, async (_m, body) =>
    ({ tracked: await discover.trackScene(await loadConfig(), body || {}) })],

  /* Fill fields older marks lack. Only asks about records missing something. */
  ['POST', /^\/api\/acquire\/tracked\/scenes\/backfill$/, async () =>
    discover.backfillSceneDetails(await loadConfig())],

  /* Ignore: "not for me". Leaves results and the percentage. */
  ['POST', /^\/api\/acquire\/ignored$/, async (_m, body) => {
    const config = await loadConfig();
    await discover.ignoreScene(config, body?.id);
    return { ignored: true };
  }],

  /* A screenful in one write. See ignoreScenes(). */
  ['POST', /^\/api\/acquire\/ignored\/batch$/, async (_m, body) =>
    discover.ignoreScenes(await loadConfig(), body?.ids || [])],

  /* Skip everything the current filter still returns, in the background. */
  ['POST', /^\/api\/acquire\/skiprest$/, async (_m, body) => {
    const config = await loadConfig();
    // The raw query string, parsed by the same function the results used.
    return discover.skipRest(config, searchFilter(new URLSearchParams(body?.query || '')));
  }],

  ['GET', /^\/api\/acquire\/skiprest$/, async () => discover.sweepStatus()],

  ['DELETE', /^\/api\/acquire\/ignored\/([0-9a-fA-F-]{36})$/, async (m) => {
    await discover.unignoreScene(await loadConfig(), m[1]);
    return { ignored: false };
  }],

  ['DELETE', /^\/api\/acquire\/tracked\/scenes\/([0-9a-fA-F-]{36})$/, async (m) => {
    const config = await loadConfig();
    await discover.untrackScene(config, m[1]);

    const dropped = whisparr3Reachable(config)
      ? await whisparr3.removeScene(config, m[1]).catch((err) => ({ removed: false, error: err.message }))
      : { removed: false };

    return { ok: true, whisparr3: dropped };
  }],

  /*
   * ------------------------------------------------------------- library
   *
   * Keyed on Stash ids. See stashlib.mjs.
   */

  ['GET', /^\/api\/library\/rails$/, async (_m, _b, url) =>
    ({ rails: await shelf.rails(await stashLibrary(), { force: url.searchParams.get('refresh') === '1' }) })],

  /* The five news feeds. Cached, refreshed when stale. See feeds.mjs. */
  ['GET', /^\/api\/library\/feeds$/, async () => feeds.view()],

  /* The four library sections and their overview. Counted in the library folders. */

  ['GET', /^\/api\/library\/overview$/, async () => shelf.overview(await stashLibrary())],

  /* Films as one shelf with its facets, sent whole. See films.mjs. */
  ['GET', /^\/api\/library\/films$/, async () => films.filmsView(await stashLibrary())],

  // Candidate addresses for a title, asked on demand rather than by the crawl.
  ['GET', /^\/api\/library\/films\/lookup$/, async (_m, _b, url) => {
    await stashLibrary();
    return { candidates: await groupurl.lookUp(url.searchParams.get('title') || '', url.searchParams.get('date')) };
  }],

  // Read an address with Stash's scrapers. Writes nothing.
  ['POST', /^\/api\/library\/films\/(group|film)\/(\d+)\/scrape$/, async (_m, body) => {
    const target = (body?.url || '').trim();
    if (!target) throw httpError(400, 'Which URL should Stash read?');
    return { scraped: await films.scrapeFrom(await stashLibrary(), target) };
  }],

  // What the dialog ticked, onto the group or the scene.
  ['POST', /^\/api\/library\/films\/(group|film)\/(\d+)\/apply$/, async (m, body) =>
    films.applyScraped(await stashLibrary(), m[1], m[2], body?.fields || {}, { url: body?.url || null })],

  // Deleting one. The file is only touched when the body says so outright.
  ['POST', /^\/api\/library\/films\/(group|film)\/(\d+)\/delete$/, async (m, body) =>
    films.remove(await stashLibrary(), m[1], m[2], { deleteFile: body?.deleteFile === true })],

  ['GET', /^\/api\/library\/performers$/, async () => shelf.performersView(await stashLibrary())],

  ['GET', /^\/api\/library\/studios$/, async () => shelf.studiosView(await stashLibrary())],

  /*
   * Find scrapeable addresses for films with none. Long (30s crawl delay);
   * returns what's found so far.
   */
  /* Fill feature films from their .nfo files. Dry run by default. */
  ['GET', /^\/api\/library\/identify\/movies$/, async () =>
    identify.preview(await stashLibrary())],

  /* Emby's artwork onto the scenes. Dry run by default: this overwrites. */
  ['POST', /^\/api\/library\/identify\/covers$/, async (_m, body) =>
    identify.pushCovers(await stashLibrary(), {
      which: body?.which === 'fanart' ? 'fanart' : 'poster',
      dryRun: body?.apply !== true,
      only: Array.isArray(body?.only) ? body.only : null,
    })],

  ['POST', /^\/api\/library\/identify\/movies$/, async (_m, body) =>
    identify.apply(await stashLibrary(), { only: Array.isArray(body?.only) ? body.only : null })],

  ['GET', /^\/api\/library\/groups\/urls$/, async (_m, _b, url) => {
    const config = await stashLibrary();
    return groupurl.ensureGroupUrls(config, { force: url.searchParams.get('refresh') === '1' });
  }],

  /*
   * Read an address with Stash's scrapers, unwritten. Stash gets past
   * data18's captcha and AdultEmpire's age wall; a plain fetch doesn't.
   */
  ['POST', /^\/api\/library\/groups\/(\d+)\/scrape$/, async (m, body) => {
    const target = (body?.url || '').trim();
    if (!target) throw httpError(400, 'Which URL should Stash read?');
    return { scraped: await shelf.scrapeGroup(await stashLibrary(), target) };
  }],

  // What the dialog ticked, written onto the group.
  ['POST', /^\/api\/library\/groups\/(\d+)\/apply$/, async (m, body) => {
    if (!body || typeof body !== 'object') throw httpError(400, 'Nothing to apply.');
    return shelf.applyScrape(await stashLibrary(), m[1], body);
  }],

  /* Confirm one. Title matches are guesses, so a person confirms. */
  ['POST', /^\/api\/library\/groups\/(\d+)\/url$/, async (m, body) => {
    const chosen = (body?.url || '').trim();
    if (!chosen) throw httpError(400, 'Which URL?');
    return shelf.setGroupUrl(await stashLibrary(), m[1], chosen);
  }],

  /* Scenes still in the pipeline, or one stage. See STAGES in stashlib.mjs. */
  ['GET', /^\/api\/library\/in-flight$/, async (_m, _b, url) =>
    shelf.inFlight(await stashLibrary(), { limit: 60, page: Number(url.searchParams.get('page')) || 1 })],

  ['GET', /^\/api\/library\/stage\/([a-z]+)$/, async (m, _b, url) =>
    shelf.stageList(await stashLibrary(), m[1], { limit: 60, page: Number(url.searchParams.get('page')) || 1 })],

  /*
   * ---------------------------------------------------------------- tidying
   *
   * What Whisparr holds that Stash has filed. Removal only touches things
   * unmonitored for 15 days. See tidy.mjs.
   */

  ['GET', /^\/api\/tidy$/, async (_m, _b, url) =>
    tidy.survey(await stashLibrary(), { force: url.searchParams.get('refresh') === '1' })],

  ['POST', /^\/api\/tidy\/unmonitor$/, async () => tidy.unmonitor(await stashLibrary())],

  ['POST', /^\/api\/tidy\/remove$/, async () => tidy.remove(await stashLibrary())],

  /*
   * What's missing from the people and sites you collect. Studios come from
   * the home page's coverage table.
   */
  ['GET', /^\/api\/library\/gaps$/, async (_m, _b, url) => {
    const config = await loadConfig();
    const force = url.searchParams.get('refresh') === '1';

    /* Build the home page too, or the studio gaps stay empty. */
    await Promise.all([ensureGaps(config, { force }), ensureHome(config, { force })]);

    const snapshot = gapsSnapshot();
    const home = homeSnapshot();
    const coverage = home.home?.coverage || null;

    return {
      ...snapshot,
      building: snapshot.building || (!coverage && home.building),
      studios: (coverage?.rows || []).filter((r) => r.missing).sort((a, b) => b.missing - a.missing),
      studiosBasis: coverage?.basis || null,
    };
  }],

  /* The whole shelf with tags, filtered in the browser. */
  ['GET', /^\/api\/library\/shelf$/, async () => shelf.shelf(await stashLibrary())],
  // TV: the channel list, and one channel's lineup for today. See tv.mjs.
  ['GET', /^\/api\/library\/tv\/channels$/, async () => tv.channels(await stashLibrary())],
  ['GET', /^\/api\/library\/tv$/, async (_m, _b, url) => tv.lineup(await stashLibrary(), url.searchParams.get('ch') || 'random')],

  ['GET', /^\/api\/library\/list\/([a-z]+)$/, async (m, _b, url) =>
    shelf.list(await stashLibrary(), m[1], { page: Number(url.searchParams.get('page')) || 1 })],

  /*
   * Categories are portal-owned (categories.mjs). Mutations are POSTs: the
   * dispatcher only reads a body on POST.
   */
  ['GET', /^\/api\/library\/categories$/, async () => categories.index(await stashLibrary())],
  ['GET', /^\/api\/library\/categories\/terms$/, async () => categories.terms(await stashLibrary())],
  ['POST', /^\/api\/library\/categories\/preview$/, async (_m, body) =>
    categories.preview(await stashLibrary(), body)],
  // A director makes a filmography category — a StashDB want list rather than
  // a rule over the shelf — everything else makes the ordinary kind.
  ['POST', /^\/api\/library\/categories$/, async (_m, body) =>
    (body?.kind === 'filmography'
      ? categories.createFilmography(await stashLibrary(), body)
      : categories.create(await stashLibrary(), body))],

  ['GET', /^\/api\/library\/categories\/([a-z0-9-]+)$/, async (m, _b, url) =>
    categories.read(await stashLibrary(), m[1], {
      page: Number(url.searchParams.get('page')) || 1,
      all: url.searchParams.get('all') === '1',
    })],
  ['POST', /^\/api\/library\/categories\/([a-z0-9-]+)$/, async (m, body) =>
    categories.update(await stashLibrary(), m[1], body)],
  ['DELETE', /^\/api\/library\/categories\/([a-z0-9-]+)$/, async (m) =>
    categories.remove(await stashLibrary(), m[1])],

  // Re-pull a filmography category's want list from StashDB.
  ['POST', /^\/api\/library\/categories\/([a-z0-9-]+)\/refresh$/, async (m) =>
    categories.refreshFilmography(await stashLibrary(), m[1])],

  ['DELETE', /^\/api\/library\/categories\/([a-z0-9-]+)\/art$/, async (m) =>
    categories.clearArt(await stashLibrary(), m[1])],

  ['POST', /^\/api\/library\/categories\/([a-z0-9-]+)\/scenes$/, async (m, body) =>
    categories.assign(await stashLibrary(), m[1], body)],
  ['POST', /^\/api\/library\/categories\/([a-z0-9-]+)\/order$/, async (m, body) =>
    categories.reorder(await stashLibrary(), m[1], body)],

  // Which categories hold this scene, for the scene page's own picker.
  ['GET', /^\/api\/library\/scenes\/(\d+)\/categories$/, async (m) =>
    categories.forScene(await stashLibrary(), m[1])],

  /* The reel. The client picks the shuffle seed; digits only, since it goes into a sort string. */
  ['GET', /^\/api\/library\/reel$/, async (_m, _b, url) => {
    const seed = (url.searchParams.get('seed') || '').replace(/\D/g, '').slice(0, 9) || '1';
    const page = Number(url.searchParams.get('page')) || 1;
    const tag = (url.searchParams.get('tag') || '').replace(/\D/g, '') || null;

    // Tags to keep out. Digits only, and capped, because they go into a query.
    const exclude = (url.searchParams.get('ex') || '')
      .split(',')
      .map((value) => value.replace(/\D/g, ''))
      .filter(Boolean)
      .slice(0, 40);
    const config = await stashLibrary();

    /*
     * Which feed:
     *
     *   mixed    all three, by the ratio slider
     *   library  your own only
     *   redgifs  RedGIFs only
     *   reddit   Reddit only
     */
    const feed = ['library', 'scenes', 'redgifs', 'reddit'].includes(url.searchParams.get('feed'))
      ? url.searchParams.get('feed')
      : 'mixed';

    if (feed === 'redgifs') return redgifs.feed({ page, seed });
    if (feed === 'reddit') return reddit.feed({ page, seed });

    /* `source` is still read for older links. */
    const scenes = feed === 'scenes' || (feed === 'mixed' && url.searchParams.get('source') === 'scenes');

    const base = scenes
      ? await shelf.sceneReel(config, { seed, page })
      : await shelf.markerReel(config, { seed, page, tag, exclude });

    // Your own and nothing else — the mix, with the other two turned off.
    if (feed === 'library' || feed === 'scenes') return base;

    /*
     * The mix as percentages: library, RedGIFs, Reddit (default 75/15/10).
     * The other two are sized relative to the fixed library page.
     */
    const ratio = (url.searchParams.get('ratio') || '')
      .split(',')
      .map((value) => Math.max(0, Math.min(100, Number(value) || 0)));

    const [libraryPart = 75, gifPart = 15, redditPart = 10] = ratio.length === 3 ? ratio : [75, 15, 10];

    if (!libraryPart) return base;

    const own = base.items.length;

    /* From the running total, so small pages still average to the ratio. */
    const upto = (part, pages) => Math.round(own * (part / libraryPart) * pages);
    const gifTake = upto(gifPart, page) - upto(gifPart, page - 1);
    const redditTake = upto(redditPart, page) - upto(redditPart, page - 1);

    let out = base;
    if (gifTake > 0) out = await redgifs.mixInto(out, { page, take: gifTake, seed });

    /* Offset so the two outside sources don't land side by side. */
    if (redditTake > 0) out = await reddit.mixInto(out, { page, take: redditTake, offset: 2, seed });

    return out;
  }],

  /* Its own route: /api/config drops every cache. */
  ['GET', /^\/api\/library\/reel\/settings$/, async () => ({ reel: (await loadConfig()).reel || {} })],

  ['POST', /^\/api\/library\/reel\/settings$/, async (_m, body) => {
    const allowed = ['feed', 'crop', 'ratio', 'roll', 'info', 'play', 'source'];
    const reel = { ...(await loadConfig()).reel };

    for (const key of allowed) {
      if (key in (body || {})) reel[key] = body[key];
    }

    const saved = await saveConfig({ reel });
    return { reel: saved.reel };
  }],

  ['GET', /^\/api\/library\/reel\/tags$/, async () => shelf.reelTags(await stashLibrary())],

  /* Reddit. Reads the cache; refresh starts a walk and returns at once. See reddit.mjs. */
  ['GET', /^\/api\/reddit$/, async (_m, _b, url) =>
    reddit.view(await stashLibrary(), { performerId: url.searchParams.get('performer') || null })],

  /* Our marker clips: 720p, cut from the source. See markerclips.mjs. */
  ['GET', /^\/api\/markerclips$/, async () => markerclips.view(await stashLibrary())],

  ['POST', /^\/api\/markerclips\/generate$/, async (_m, body) => {
    const config = await stashLibrary();
    markerclips.generate(config, { force: body?.force === true });
    return markerclips.view(config);
  }],

  ['GET', /^\/api\/redgifs$/, async () => redgifs.view()],

  ['POST', /^\/api\/redgifs\/refresh$/, async () => {
    redgifs.refresh(await reelHandles());
    return redgifs.view();
  }],

  ['POST', /^\/api\/redgifs\/follow$/, async (_m, body) => {
    const result = await redgifs.follow(body?.name);
    // With the handles, always: a pass given none used to be able to decide
    // the creator list was finished and empty. See pass() in redgifs.mjs.
    if (!result.already) redgifs.refresh(await reelHandles());
    return { ...result, ...(await redgifs.view()) };
  }],

  ['POST', /^\/api\/redgifs\/unfollow$/, async (_m, body) => {
    await redgifs.unfollow(body?.name);
    return redgifs.view();
  }],

  ['POST', /^\/api\/redgifs\/tags$/, async (_m, body) => {
    const result = await redgifs.addTag(body?.tag);
    if (!result.already) redgifs.refresh(await reelHandles());
    return { ...result, ...(await redgifs.view()) };
  }],

  ['POST', /^\/api\/redgifs\/tags\/remove$/, async (_m, body) => {
    await redgifs.removeTag(body?.tag);
    return redgifs.view();
  }],

  ['POST', /^\/api\/reddit\/follow$/, async (_m, body) => {
    const config = await stashLibrary();
    const result = await reddit.follow(config, body?.what);
    // Following something and then waiting six hours to see it is not useful.
    if (!result.already) reddit.refresh(config);
    return { ...result, ...(await reddit.view(config)) };
  }],

  ['POST', /^\/api\/reddit\/unfollow$/, async (_m, body) => {
    await reddit.unfollow(body?.handle);
    return reddit.view(await stashLibrary());
  }],

  ['POST', /^\/api\/reddit\/refresh$/, async () => {
    const config = await stashLibrary();
    reddit.refresh(config);
    return reddit.view(config);
  }],

  ['GET', /^\/api\/library\/scenes\/(\d+)$/, async (m) => shelf.sceneView(await stashLibrary(), m[1])],

  /*
   * One performer: the shelf and, if identified on StashDB, the catalogue and
   * wanted scenes. `only=scenes` pages the shelf.
   */
  ['GET', /^\/api\/library\/performers\/(\d+)$/, async (m, _b, url) =>
    performerPage(await stashLibrary(), m[1], {
      page: Number(url.searchParams.get('page')) || 1,
      only: url.searchParams.get('only'),
    })],

  /* IAFD facts Stash doesn't carry. Separate request so the page draws first. See iafd.mjs. */
  ['GET', /^\/api\/library\/performers\/(\d+)\/iafd$/, async (m) =>
    shelf.performerIafd(await stashLibrary(), m[1])],

  /* Write IAFD's facts into Stash's blanks only, from a fresh read. */
  ['POST', /^\/api\/library\/performers\/(\d+)\/iafd$/, async (m) =>
    shelf.fillPerformerFromIafd(await stashLibrary(), m[1])],

  /* One studio: shelf, cast, and the StashDB catalogue. `only=scenes` pages the shelf. */
  ['GET', /^\/api\/library\/studios\/(\d+)$/, async (m, _b, url) => {
    const performer = url.searchParams.get('performer');
    return studioPage(await stashLibrary(), m[1], {
      page: Number(url.searchParams.get('page')) || 1,
      performer: /^\d+$/.test(performer || '') ? performer : null,
      only: url.searchParams.get('only'),
    });
  }],

  /* Studio facts from the TPDB mirror; POST writes Stash's blanks only. See studiofacts.mjs. */
  ['GET', /^\/api\/library\/studios\/(\d+)\/facts$/, async (m) =>
    shelf.studioFacts(await stashLibrary(), m[1])],

  ['POST', /^\/api\/library\/studios\/(\d+)\/facts$/, async (m) =>
    shelf.fillStudioFromSite(await stashLibrary(), m[1])],

  ['GET', /^\/api\/library\/groups\/(\d+)$/, async (m, _b, url) =>
    shelf.groupView(await stashLibrary(), m[1], { page: Number(url.searchParams.get('page')) || 1 })],

  /*
   * --------------------------------------------------------- galleries
   *
   * One collection route; filters narrow it to a scene, performer and so on.
   */

  ['GET', /^\/api\/library\/galleries$/, async (_m, _b, url) => {
    const config = await stashLibrary();
    const scene = url.searchParams.get('scene');
    const performer = url.searchParams.get('performer');
    const group = url.searchParams.get('group');

    if (scene || performer || group) return galleries.attached(config, { scene, performer, group });
    return galleries.galleriesView(config);
  }],

  // Who you hold films of and no pictures of. A row, not a page.
  ['GET', /^\/api\/library\/galleries\/gaps$/, async () =>
    galleries.withoutPictures(await stashLibrary())],

  ['GET', /^\/api\/library\/galleries\/(\d+)$/, async (m, _b, url) =>
    galleries.galleryView(await stashLibrary(), m[1], { page: Number(url.searchParams.get('page')) || 1 })],

  ['POST', /^\/api\/library\/galleries\/(\d+)\/organized$/, async (m, body) =>
    galleries.setOrganized(await stashLibrary(), m[1], body?.organized !== false)],

  ['POST', /^\/api\/library\/galleries\/(\d+)\/rating$/, async (m, body) =>
    galleries.setRating(await stashLibrary(), m[1], body?.rating ?? null)],

  /* Rename, cover, crop and delete. The crop is a focal point; the file is never touched. */
  ['POST', /^\/api\/library\/galleries\/(\d+)\/title$/, async (m, body) =>
    galleries.rename(await stashLibrary(), m[1], body?.title)],

  ['POST', /^\/api\/library\/galleries\/(\d+)\/cover$/, async (m, body) =>
    galleries.setCover(await stashLibrary(), m[1], body?.imageId || null)],

  ['POST', /^\/api\/library\/galleries\/(\d+)\/focus$/, async (m, body) => {
    const focus = body?.focus;
    if (focus && (!Number.isFinite(focus.x) || !Number.isFinite(focus.y))) {
      throw httpError(400, 'A focal point is an x and a y.');
    }
    return galleries.setFocus(await stashLibrary(), m[1], focus || null);
  }],

  /* Which scene, performers and studio a gallery belongs to. */
  ['POST', /^\/api\/library\/galleries\/(\d+)\/ties$/, async (m, body) =>
    galleries.setTies(await stashLibrary(), m[1], {
      sceneIds: Array.isArray(body?.sceneIds) ? body.sceneIds : undefined,
      performerIds: Array.isArray(body?.performerIds) ? body.performerIds : undefined,
      studioId: 'studioId' in (body || {}) ? body.studioId : undefined,
    })],

  /* Type-ahead for those pickers, answered by Stash. */
  ['GET', /^\/api\/library\/lookup$/, async (_m, _b, url) => {
    const kind = url.searchParams.get('kind') || '';
    if (!['performer', 'scene', 'studio'].includes(kind)) {
      throw httpError(400, 'Look up a performer, a scene or a studio.');
    }
    return shelf.lookup(await stashLibrary(), kind, url.searchParams.get('q'));
  }],

  /*
   * Rescan a gallery's folder after an upload. Removing uses Stash's delete,
   * which takes the file (or the next scan brings it back).
   */
  ['POST', /^\/api\/library\/galleries\/(\d+)\/rescan$/, async (m) => {
    const config = await stashLibrary();
    const { folder, zipped } = await galleries.folderOf(config, m[1]);

    if (zipped) throw httpError(400, 'That gallery is a zip file — there is no folder to rescan.');
    if (!folder) throw httpError(400, 'Stash does not say where that gallery keeps its pictures.');

    await gallerybuild.rescan(config, folder);
    return galleries.galleryView(config, m[1]);
  }],

  ['POST', /^\/api\/library\/galleries\/(\d+)\/images\/delete$/, async (_m, body) =>
    galleries.removeImages(await stashLibrary(), body?.ids, { files: body?.files === true })],

  /* Delete takes the folder too, or Stash rebuilds the gallery on its next scan. */
  ['POST', /^\/api\/library\/galleries\/(\d+)\/delete$/, async (m, body) =>
    galleries.destroy(await stashLibrary(), m[1], { files: body?.files === true })],

  /*
   * ------------------------------------------------------ building one
   *
   * Find, choose, write. The build is the only thing that puts files where
   * Stash imports them. See gallerybuild.mjs.
   */

  ['GET', /^\/api\/galleries\/setup$/, async () => gallerybuild.setupState(await stashLibrary())],

  // A settings write on Stash, so it is a POST behind a button of its own.
  ['POST', /^\/api\/galleries\/setup$/, async () => gallerybuild.enableInStash(await stashLibrary())],

  ['POST', /^\/api\/galleries\/find$/, async (_m, body) => {
    const config = await loadConfig();

    if (body?.url) {
      const target = String(body.url).trim();
      if (!/^https?:\/\//i.test(target)) throw httpError(400, 'That needs to be an http:// or https:// address.');
      return galleryscrape.fromPage(target);
    }
    if (body?.scene) return galleryscrape.fromScene(config, String(body.scene));
    if (body?.performer) return galleryscrape.fromPerformer(config, String(body.performer));

    throw httpError(400, 'Give it a url, a scene or a performer.');
  }],

  ['POST', /^\/api\/galleries\/build$/, async (_m, body) => {
    const config = await stashLibrary();

    const urls = Array.isArray(body?.urls) ? body.urls.map(String) : [];

    /* An upload has already written its files, so only scan and tie here. */
    if (!urls.length && !body?.uploaded) throw httpError(400, 'Pick at least one picture.');

    // Only what was offered. The same rule as the thumbnail proxy, and the
    // reason this cannot be handed an arbitrary address.
    const unknown = urls.find((u) => !galleryscrape.isOffered(u));
    if (unknown) throw httpError(400, 'That picture was not one of the ones found — search again.');

    const setup = await gallerybuild.setupState(config);
    if (!setup.ready) {
      throw httpError(400, setup.error || (setup.excludesImages
        ? `Stash has ${setup.stashPath} but excludes images from it. Turn that off first.`
        : `Stash is not scanning ${setup.stashPath}. Add it as a library path first.`));
    }

    return gallerybuild.start(config, {
      name: String(body?.name || '').trim() || 'Gallery',
      items: urls.map((url) => ({ url, referer: galleryscrape.refererFor(url) })),
      tie: {
        date: body?.tie?.date || null,
        sceneIds: Array.isArray(body?.tie?.sceneIds) ? body.tie.sceneIds : [],
        performerIds: Array.isArray(body?.tie?.performerIds) ? body.tie.performerIds : [],
        studioId: body?.tie?.studioId || null,
        url: body?.tie?.url || null,
      },
    });
  }],

  ['GET', /^\/api\/galleries\/jobs\/(\d+)$/, async (m) => {
    const job = gallerybuild.snapshot(m[1]);
    if (!job) throw httpError(404, 'No such build.');
    return job;
  }],

  ['GET', /^\/api\/library\/search$/, async (_m, _b, url) => {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return { q: '', count: 0, scenes: [] };
    return shelf.search(await stashLibrary(), q);
  }],

  /* The player reports every ~15s and on leaving. The busiest write in the app. */
  ['POST', /^\/api\/library\/scenes\/(\d+)\/activity$/, async (m, body) =>
    shelf.saveActivity(await stashLibrary(), m[1], {
      resume: Number.isFinite(body?.resume) ? body.resume : null,
      played: Number.isFinite(body?.played) ? body.played : null,
    })],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/play$/, async (m) => shelf.addPlay(await stashLibrary(), m[1])],

  /*
   * Mark a scene filed, and move the file (see filer.mjs).
   *
   * The flag is set first and the move may fail; `filed` says what happened.
   * Unmarking doesn't move the file back.
   */
  ['POST', /^\/api\/library\/scenes\/(\d+)\/organized$/, async (m, body) => {
    const on = body?.organized !== false;
    const scene = await shelf.setOrganized(await stashLibrary(), m[1], on);
    if (!on) return scene;

    const config = await stashLibrary();
    try {
      const done = await filer.file(config, m[1], {
        beforeMove: (dir) => resolution.beforeFiling(m[1], dir),
      });
      const chosen = await resolution.afterFiling(config, m[1]).catch(() => null);
      return { ...scene, filed: { moved: true, ...done, resolution: chosen } };
    } catch (err) {
      /* Re-plan to tell "already filed" (normal) from a real failure. */
      const why = await filer.plan(config, m[1]).catch(() => null);
      const said = why?.why || err.message;

      /* Log it: the button clears after a few seconds. */
      if (!why?.already) console.warn(`[tpdbarr] scene ${m[1]} marked filed but not moved - ${said}`);

      return { ...scene, filed: { moved: false, already: Boolean(why?.already), why: said } };
    }
  }],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/rating$/, async (m, body) =>
    shelf.setRating(await stashLibrary(), m[1], body?.rating ?? null)],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/o$/, async (m) => shelf.addO(await stashLibrary(), m[1])],

  /* Deleting a scene. The page asks what would go first, then deletes. */
  /*
   * Re-encode a filed scene smaller and replace it. The plan says why not
   * before any button is drawn. See downscale.mjs.
   */
  ['GET', /^\/api\/library\/scenes\/(\d+)\/downscale$/, async (m) =>
    downscale.plan(await loadConfig(), m[1])],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/downscale$/, async (m, body) =>
    downscale.start(await loadConfig(), m[1], Number(body?.height) || 0)],

  /* Target resolution and the FileFlows flag. See resolution.mjs. */
  ['GET', /^\/api\/library\/scenes\/(\d+)\/resolution$/, async (m) =>
    resolution.plan(await loadConfig(), m[1])],
  ['POST', /^\/api\/library\/scenes\/(\d+)\/resolution$/, async (m, body) =>
    (body?.release
      ? resolution.release(await loadConfig(), m[1])
      : resolution.choose(await loadConfig(), m[1], body?.choice))],

  // One job for the whole portal, so its progress is not per scene.
  /*
   * Catch-up: fill blanks on filed scenes from the source their stash id
   * belongs to. Never guesses. See catchup.mjs.
   */
  ['GET', /^\/api\/library\/catchup$/, async () => ({
    ...catchup.status(),
    scope: await catchup.scope(await loadConfig()),
  })],

  ['POST', /^\/api\/library\/catchup$/, async (_m, body) => (body?.stop
    ? catchup.stop()
    : catchup.start(await loadConfig()))],

  ['GET', /^\/api\/library\/downscale$/, async () => downscale.status()],

  ['GET', /^\/api\/library\/scenes\/(\d+)\/removal$/, async (m) =>
    sceneremove.preview(await stashLibrary(), m[1])],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/delete$/, async (m, body) =>
    sceneremove.remove(await stashLibrary(), m[1], {
      file: body?.file === true,
      galleries: body?.galleries === true,
      clips: body?.clips !== false,
    })],

  /*
   * ---------------------------------------------------------- movie files
   *
   * Films on the share, read off the mount (moviefiles.mjs). Not /api/movies,
   * which is TPDB's catalogue.
   */

  ['GET', /^\/api\/moviefiles$/, async (_m, _b, url) =>
    moviefiles.overview({ force: url.searchParams.get('refresh') === '1' })],

  ['GET', /^\/api\/moviefiles\/([0-9a-f]{12})$/, async (m) => {
    const movie = await moviefiles.findMovieWatched(m[1]);
    if (!movie) throw httpError(404, 'No movie with that id.');
    return { movie };
  }],

  /* Resume point and play count for films, kept beside the config. */
  ['POST', /^\/api\/moviefiles\/([0-9a-f]{12})\/activity$/, async (m, body) =>
    watch.saveActivity(m[1], {
      resume: Number.isFinite(body?.resume) ? body.resume : null,
      duration: Number.isFinite(body?.duration) ? body.duration : null,
    })],

  ['POST', /^\/api\/moviefiles\/([0-9a-f]{12})\/play$/, async (m) => watch.addPlay(m[1])],

  ['POST', /^\/api\/moviefiles\/([0-9a-f]{12})\/forget$/, async (m) => watch.clearWatch(m[1])],

  /* Fill in a film Emby never matched. The apply is the only write to the share. See gapfill.mjs. */
  ['GET', /^\/api\/moviefiles\/([0-9a-f]{12})\/candidates$/, async (m, _b, url) => {
    const only = url.searchParams.get('source');
    if (only && !['tpdb', 'tmdb', 'imdb'].includes(only)) throw httpError(400, 'source must be tpdb, tmdb or imdb.');
    return gapfill.candidates(await loadConfig(), m[1], { only });
  }],

  ['POST', /^\/api\/moviefiles\/([0-9a-f]{12})\/metadata$/, async (m, body) => {
    // guid is still accepted on its own and means ThePornDB, which is what it
    // meant before there was a second source.
    const source = String(body?.source || (body?.guid ? 'tpdb' : ''));
    const id = String(body?.id || body?.guid || '');

    if (!['tpdb', 'tmdb', 'imdb'].includes(source)) throw httpError(400, 'source must be tpdb, tmdb or imdb.');
    if (!id) throw httpError(400, 'A movie id is required.');

    return gapfill.apply(await loadConfig(), m[1], { source, id }, {
      nfo: body?.nfo !== false,
      poster: body?.poster !== false,
      fanart: body?.fanart !== false,
    });
  }],

  /*
   * ---------------------------------------------------------- whisparr v3
   *
   * Keyed on the StashDB scene UUID. Asked after the page draws, so a down v3
   * costs a badge, not the page.
   */

  ['GET', /^\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})$/, async (m) =>
    whisparr3.sceneStatus(await whisparr3Instance(), m[1])],

  ['POST', /^\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})$/, async (m, body) => {
    const config = await whisparr3Instance();
    if (!whisparr3Configured(config)) {
      throw httpError(400, 'Whisparr v3 needs a root folder and quality profile before it can add anything.');
    }
    if (!body?.force) {
      const held = await heldForV3(config, m[1]);
      if (held) throw refusal(held);
    }
    const out = await whisparr3.addScene(config, m[1]);
    monitored.forget();
    return out;
  }],

  /* "Get me another file": add and monitor if needed, then search. Deletes nothing. */
  ['POST', /^\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})\/again$/, async (m) => {
    const config = await whisparr3Instance();
    if (!whisparr3Configured(config)) {
      throw httpError(400, 'Whisparr v3 needs a root folder and quality profile before it can search.');
    }
    return whisparr3.askAgain(config, m[1]);
  }],

  ['GET', /^\/api\/whisparr3\/queue$/, async () => {
    const q = await whisparr3.queue(await whisparr3Instance());
    return {
      records: (q.records || []).map((r) => ({
        id: r.id,
        title: r.movie?.title || r.title,
        studio: r.movie?.studioTitle || '',
        status: r.status,
        trackedDownloadState: r.trackedDownloadState,
        sizeleft: r.sizeleft,
        size: r.size,
        timeleft: r.timeleft || null,
      })),
    };
  }],
];

/*
 * Ownership and v3 state for StashDB results, in bulk. Exact matches only
 * for ownership. A missing Stash or v3 means no annotation, not an error.
 */
/*
 * See discover.annotate: StashDB id match, then title and date for scenes
 * identified against TPDB.
 */
const annotate = (config, scenes) => discover.annotate(config, scenes);

/* Everything under /api/library needs Stash. */
/* Reddit handles for seeding the RedGIFs creator list. Never hands it an empty list. */
async function reelHandles() {
  return reddit.sources(await stashLibrary()).catch(() => []);
}

async function stashLibrary() {
  const config = await loadConfig();
  if (!stashConfigured(config)) throw httpError(503, 'Stash is not configured — the library lives there.');
  return config;
}

// v3 is optional, so "you have not set one up" is a 503 and not a crash.
async function whisparr3Instance() {
  const config = await loadConfig();
  if (!whisparr3Reachable(config)) throw httpError(503, 'Whisparr v3 is not set up.');
  return config;
}

// -------------------------------------------------------------------- plumbing

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* Which folder an upload goes into: a new gallery's or an existing one's. */
async function uploadFolder(config, url) {
  const id = url.searchParams.get('gallery');

  if (id) {
    const { folder, zipped } = await galleries.folderOf(config, id);
    if (zipped) throw httpError(400, 'That gallery is a zip file — pictures cannot be added to it.');
    if (!folder) throw httpError(400, 'Stash does not say where that gallery keeps its pictures.');

    const here = gallerybuild.portalPathFor(config, folder);
    if (!here) {
      throw httpError(400, `That gallery lives at ${folder}, outside the folder this portal manages.`);
    }
    return here;
  }

  const name = (url.searchParams.get('name') || '').trim();
  if (!name) throw httpError(400, 'The upload needs a gallery to go into.');

  const setup = await gallerybuild.setupState(config);
  if (!setup.writable) throw httpError(400, setup.error || 'The gallery folder cannot be written to.');

  return gallerybuild.folderFor(config, name).path;
}

// The body is the picture. Capped, and read into memory because a zip has to
// be read backwards from its end before any of it means anything.
async function readUpload(req, limit = galleryupload.MAX_UPLOAD) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    // Said in the units of whatever asked, because 512MB of photo set and 8MB
    // of cover art are not the same sentence.
    if (size > limit) throw httpError(413, `That upload is over ${Math.round(limit / 1024 / 1024)}MB.`);
    chunks.push(chunk);
  }

  if (!size) throw httpError(400, 'The upload was empty.');
  return Buffer.concat(chunks);
}

/*
 * 1 MB for JSON bodies. Match routes get more: scraped covers arrive as
 * base64 data URIs, most of a megabyte each.
 */
const BODY_LIMIT = 1_000_000;
const PICTURE_ROUTES = /^\/api\/import\/(?:match\/\d+|wildcard\/scene\/\d+)(\/rename\/plan)?$/;

async function readBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON body');
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/*
 * The stylesheet is public/css/, joined in filename order (the three-digit
 * prefix sets the cascade). Joined once per process.
 */
let stylesheet = null;

async function serveStylesheet(res) {
  if (stylesheet === null) {
    const dir = join(PUBLIC_DIR, 'css');
    const names = (await readdir(dir)).filter((f) => f.endsWith('.css')).sort();
    const parts = await Promise.all(names.map((f) => readFile(join(dir, f), 'utf8')));
    stylesheet = parts.join('');
  }

  res.writeHead(200, { 'Content-Type': MIME['.css'], 'Cache-Control': 'no-cache' });
  res.end(stylesheet);
}

async function serveStatic(res, pathname) {
  if (pathname === '/style.css') return serveStylesheet(res);

  const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^([/\\.]+)/, '');
  const file = join(PUBLIC_DIR, rel);

  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    // Unknown path: hand back the app shell so client-side routing works.
    try {
      const shell = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(shell);
    } catch {
      res.writeHead(404).end('not found');
    }
  }
}

/* A file off the disk, with Range support so video can seek and start early. */
/* Typed by extension: a JPEG sheet sent as video/mp4 silently fails as a background-image. */
/* Image types for uploaded category artwork. */
const TYPE_OF = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
};

async function serveFile(res, req, file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no such file');
    return;
  }

  const dot = file.lastIndexOf('.');
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const head = {
    'Content-Type': TYPE_OF[dot < 0 ? '' : file.slice(dot).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  };

  if (!range) {
    res.writeHead(200, { ...head, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
    return;
  }

  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;

  if (start >= info.size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
    return;
  }

  res.writeHead(206, {
    ...head,
    'Content-Range': `bytes ${start}-${end}/${info.size}`,
    'Content-Length': end - start + 1,
  });

  if (req.method === 'HEAD') return res.end();

  const source = createReadStream(file, { start, end });
  source.on('error', () => res.destroy());
  res.on('close', () => source.destroy());
  source.pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  /*
   * A cover, or a frame cut from the file when there is none. Ahead of the
   * proxy because Stash answers a missing cover with 200 and a placeholder.
   * See scenethumb.mjs.
   */
  const thumb = url.pathname.match(/^\/media\/scene\/(\d+)\/thumb$/);

  if (thumb) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const thumbConfig = await loadConfig();
    return scenethumb.serve(thumbConfig, req, res, thumb[1], {
      force: url.searchParams.get('force') === '1',
      cut: thumbConfig.cutThumbs !== false,
    });
  }

  /* A frame Wild Card cut. Ours, off our disk. */
  const frame = url.pathname.match(/^\/media\/scene\/(\d+)\/frame\/(\d+)$/);

  if (frame) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    return scenethumb.serveFrame(req, res, frame[1], frame[2]);
  }

  // Video, previews and artwork, streamed through from Stash. Not JSON, so it
  // sits ahead of the routing table rather than in it.
  const media =
    url.pathname.match(/^\/media\/scene\/(\d+)\/(stream|preview|screenshot|sprite|vtt)$/) ||
    url.pathname.match(/^\/media\/(performer|studio|group|image|imagethumb)\/(\d+)$/);

  if (media) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const [, a, b] = media;
    const scene = url.pathname.startsWith('/media/scene/');
    return proxyMedia(await loadConfig(), req, res, scene ? b : a, scene ? a : b);
  }

  /* Our own marker clip (720p, faststart), ahead of Stash's. */
  const ours = url.pathname.match(/^\/media\/marker\/(\d+)\/clip$/);

  if (ours) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    return serveFile(res, req, markerclips.clipPath(ours[1]));
  }

  /* One sheet of a scene's own filmstrip. Ours, off our disk. */
  const strip = url.pathname.match(/^\/media\/scene\/(\d+)\/strip\/(\d+)$/);

  if (strip) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    return serveFile(res, req, spritestrip.sheetPath(strip[1], Number(strip[2])));
  }

  // A marker's clip from Stash, which is the only media named by two ids — the
  // scene it is cut from and the marker itself.
  const marker = url.pathname.match(/^\/media\/scene\/(\d+)\/marker\/(\d+)\/(stream|preview|screenshot)$/);

  if (marker) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const [, sceneId, markerId, kind] = marker;
    return proxyMedia(await loadConfig(), req, res, 'marker' + kind, sceneId, markerId);
  }

  /* Candidate artwork. Only URLs the gap-filler offered (see gapfill.mjs). */
  if (url.pathname === '/media/candidate') {
    const target = url.searchParams.get('url') || '';

    if (!gapfill.isKnownArt(target)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('unknown artwork');
      return;
    }

    try {
      const upstream = await fetch(target, { signal: AbortSignal.timeout(30000) });
      const type = upstream.headers.get('content-type') || '';

      if (!upstream.ok || !/^image\//i.test(type)) {
        res.writeHead(502, { 'Content-Type': 'text/plain' }).end('artwork unavailable');
        return;
      }

      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('artwork unavailable');
    }
    return;
  }

  /* Reddit and RedGIFs media. Only URLs those modules offered. Fetched live. */
  if (url.pathname === '/media/social') {
    const target = url.searchParams.get('url') || '';
    const owner = redgifs.isKnown(target) ? redgifs : reddit.isKnown(target) ? reddit : null;

    if (!owner) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('unknown media');
      return;
    }

    /*
     * Abort with the response, not on a timer: AbortSignal.timeout() fired
     * mid-download and its stream error crashed the server.
     */
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let upstream;
    try {
      // Range goes through because some of this is video — a clip that cannot
      // seek is a clip that cannot loop cleanly.
      const headers = owner.headers();
      if (req.headers.range) headers.Range = req.headers.range;

      upstream = await fetch(target, { headers, signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted) return;
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('media unavailable');
      return;
    }

    const type = upstream.headers.get('content-type') || '';

    if ((!upstream.ok && upstream.status !== 206) || !/^(image|video)\//i.test(type)) {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('media unavailable');
      return;
    }

    /*
     * No Content-Length: fetch has already decompressed the body, so the
     * upstream length is wrong and browsers fail with ERR_CONTENT_LENGTH_MISMATCH.
     */
    const back = { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' };
    for (const name of ['content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) back[name] = value;
    }

    res.writeHead(upstream.status === 206 ? 206 : 200, back);

    if (!upstream.body) {
      res.end();
      return;
    }

    try {
      await new Promise((resolve, reject) => {
        const source = Readable.fromWeb(upstream.body);
        source.on('error', reject);
        source.pipe(res).on('finish', resolve).on('error', reject);
      });
    } catch {
      // Almost always the browser hanging up mid-scroll. Nothing to report.
      res.destroy();
    }
    return;
  }

  /*
   * Gallery picker thumbnails. Only URLs galleryscrape.mjs offered, sent with
   * the page's Referer (many hosts serve a placeholder otherwise).
   */
  if (url.pathname === '/media/scrape') {
    const target = url.searchParams.get('url') || '';

    if (!galleryscrape.isOffered(target)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('unknown image');
      return;
    }

    try {
      const upstream = await fetch(target, {
        headers: galleryscrape.headers(galleryscrape.refererFor(target)),
        signal: AbortSignal.timeout(30000),
      });
      const type = upstream.headers.get('content-type') || '';

      if (!upstream.ok || !/^image\//i.test(type)) {
        res.writeHead(502, { 'Content-Type': 'text/plain' }).end('image unavailable');
        return;
      }

      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('image unavailable');
    }
    return;
  }

  /*
   * Uploading pictures into a gallery folder.
   *
   * Ahead of the routing table because the body is the file, not JSON. One
   * request per file. `name` makes a new gallery's folder; `gallery` adds to
   * an existing one. Only folders this app manages.
   */
  /* A category's artwork, up and back. Outside the table: bytes, not JSON. */
  /*
   * Wild Card's own cover: uploaded or fetched from a pasted URL. Held in
   * memory; reaches Stash only if chosen when Write is pressed.
   */
  const wcart = /^\/api\/import\/wildcard\/art(?:\/([a-z0-9]+))?$/.exec(url.pathname);

  if (wcart?.[1] && (req.method === 'GET' || req.method === 'HEAD')) {
    const held = wildcard.heldArt(wcart[1]);
    if (!held) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no picture');
      return;
    }
    // Held for an hour and never the same id twice, so it is cacheable for as
    // long as the tab that asked for it is open and no longer.
    res.writeHead(200, { 'Content-Type': held.kind.type, 'Cache-Control': 'private, max-age=3600' });
    res.end(held.bytes);
    return;
  }

  if (wcart && !wcart[1] && req.method === 'POST') {
    try {
      // Two ways in, one hold. A JSON body is an address to go and get;
      // anything else is the picture itself.
      const json = /^application\/json/i.test(req.headers['content-type'] || '');
      send(res, 200, json
        ? await wildcard.fetchArt((await readBody(req))?.url || '')
        : wildcard.holdArt(await readUpload(req, artwork.MAX_ART)));
    } catch (err) {
      send(res, err.status || 500, { error: err.message });
    }
    return;
  }

  const art = /^\/api\/library\/categories\/([a-z0-9-]+)\/art$/.exec(url.pathname);
  if (art && (req.method === 'GET' || req.method === 'HEAD')) {
    const held = await categories.artFile(art[1]).catch(() => null);
    if (!held) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no artwork');
      return;
    }
    // Typed by the extension chosen from the file's header, not the browser's name.
    await serveFile(res, req, held.file);
    return;
  }

  if (art && req.method === 'POST') {
    try {
      const buffer = await readUpload(req, artwork.MAX_ART);
      send(res, 200, await categories.setArt(await stashLibrary(), art[1], buffer));
    } catch (err) {
      send(res, err.status || 500, { error: err.message });
    }
    return;
  }

  /* Replace a performer's photo or studio's logo, straight into Stash. */
  const person = /^\/api\/library\/(performers|studios)\/(\d+)\/image$/.exec(url.pathname);

  /* Remove it. Stash clears an image on "", not null (null means leave it). */
  if (person && req.method === 'DELETE') {
    try {
      const config = await stashLibrary();
      send(res, 200, person[1] === 'performers'
        ? await shelf.setPerformerImage(config, person[2], '')
        : await shelf.setStudioImage(config, person[2], ''));
    } catch (err) {
      send(res, err.status || 500, { error: err.message });
    }
    return;
  }

  if (person && req.method === 'POST') {
    try {
      const config = await stashLibrary();
      const buffer = await readUpload(req, artwork.MAX_ART);
      const kind = artwork.checked(buffer);
      const image = artwork.dataUrl(buffer, kind);

      send(res, 200, person[1] === 'performers'
        ? await shelf.setPerformerImage(config, person[2], image)
        : await shelf.setStudioImage(config, person[2], image));
    } catch (err) {
      send(res, err.status || 500, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/galleries/upload') {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    try {
      const config = await loadConfig();
      if (!stashConfigured(config)) throw httpError(503, 'Stash is not configured — the library lives there.');

      const filename = (url.searchParams.get('file') || '').trim();
      if (!filename) throw httpError(400, 'The upload needs a filename.');

      const folder = await uploadFolder(config, url);
      const body = await readUpload(req);
      const { files, skipped } = galleryupload.unpack(filename, body);

      if (!files.length) {
        const why = skipped[0] ? ` (${skipped[0].why})` : '';
        throw httpError(400, `Nothing in ${filename} was a picture${why}.`);
      }

      const wrote = await galleryupload.writeInto(folder, files);
      send(res, 200, {
        file: filename,
        written: wrote.written.length,
        skipped: [...skipped, ...wrote.skipped],
      });
    } catch (err) {
      const status = err.status || 500;
      if (!err.status) console.error('[tpdbarr]', err);
      send(res, status, { error: err.message });
    }
    return;
  }

  // Films on the share come off the mount rather than through Stash, so they
  // are served here rather than proxied.
  const movieMedia = url.pathname.match(/^\/media\/moviefile\/([0-9a-f]{12})\/(file|poster|fanart)$/);

  if (movieMedia) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const movie = await moviefiles.findMovie(movieMedia[1]).catch(() => null);
    if (!movie) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    return moviefiles.serve(req, res, movie, movieMedia[2]);
  }

  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    return serveStatic(res, url.pathname);
  }

  /* One path can have several methods. 405 only once every route for it is tried. */
  let pathExists = false;

  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (!match) continue;
    if (req.method !== method) {
      pathExists = true;
      continue;
    }

    try {
      const body = method === 'POST'
        ? await readBody(req, PICTURE_ROUTES.test(url.pathname) ? 24_000_000 : BODY_LIMIT)
        : null;
      send(res, 200, await handler(match, body, url));
    } catch (err) {
      const status = err.status || 502;
      if (!err.status) console.error('[tpdbarr]', err);
      send(res, status, { ...(err.payload || {}), error: err.message });
    }
    return;
  }

  if (pathExists) {
    send(res, 405, { error: 'method not allowed' });
    return;
  }

  send(res, 404, { error: 'no such endpoint' });
});

/*
 * Restart the Reddit walk after a reboot if the cache is stale. The cursor
 * is on disk. A minute after boot.
 */
const REDDIT_CHECK_MS = 60 * 60 * 1000;

/* Hourly: render a clip for any marker without one. Incremental; usually one query. */
const CLIP_CHECK_MS = 60 * 60 * 1000;

function warmMarkerClips() {
  const tick = async () => {
    try {
      const config = await loadConfig();
      if (!stashConfigured(config)) return;
      if (markerclips.busy()) return;

      const state = await markerclips.view(config);
      // Nothing to do is the common case and costs nothing to establish.
      if (state.markers && state.clips < state.markers) markerclips.generate(config);
    } catch {
      // The reel falls back to Stash's clips; this is not worth a crash.
    }
  };

  /* Not at boot: a restart mid-import would start a long encode on a moving library. */
  setTimeout(tick, 10 * 60 * 1000);
  setInterval(tick, CLIP_CHECK_MS);
}

function warmReddit() {
  const tick = async () => {
    try {
      const config = await loadConfig();
      if (!stashConfigured(config)) return;

      const state = await reddit.view(config);
      if (state.stale && !state.running) reddit.refresh(config);
      // Anything pulled before RedGIFs was understood is still a dead link.
      reddit.catchUp();

      const gifs = await redgifs.view();
      if (gifs.stale && !gifs.running) {
        redgifs.refresh(await reddit.sources(config).catch(() => []));
      }
    } catch {
      // The page still reads the cache; only the poller is affected.
    }
  };

  setTimeout(tick, 60000);
  setInterval(tick, REDDIT_CHECK_MS);
}

// A copy from after a crash, not from whenever the portal was last healthy.
backup.onStart();

server.listen(PORT, HOST, () => {
  console.log(`tpdbarr portal listening on http://${HOST}:${PORT}`);
  // The movie share is a CIFS mount and a walk of it takes seconds. Do it now,
  // so the first person to open the Movies tab is not the one who pays for it.
  moviefiles.warm();
  warmReddit();
  warmMarkerClips();
  // The want list, a few a night. See release.mjs.
  release.schedule();
  // Hand-grabbed downloads, across to the Import Folder. See manualdrop.mjs.
  manualdrop.schedule();
});
