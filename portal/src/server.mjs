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

/*
 * One reading of the acquisition filters, shared by the search and by the
 * sweep that skips everything the same filters still have to say.
 *
 * Shared rather than copied on purpose: "skip all remaining" means *these*
 * filters, and two parsers that drift by a field would make it mean something
 * slightly different from what the screen was showing.
 */
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

/*
 * The filters that say which pile. Read in one place because the queue and the
 * phash routes have to agree about what "this pile" means — a generate scoped
 * to a different set of scenes than the list you are looking at would be a
 * button that lied about what it was about to do.
 */
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

  /*
   * Thumbnail size for one page. Its own route rather than /api/config: that
   * one drops every cache on the way through, which is right for a changed
   * Stash URL and absurd for a size button.
   */
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

  /*
   * The other two sections. Movies are TPDB's, checked against Stash groups;
   * creators are your own library's cast. Neither adds anything to Whisparr —
   * see movies.mjs and library.mjs for why.
   */
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

  /* ------------------------------------------------------------- stashdb
   *
   * The front door. StashDB is what the library should contain — it is the one
   * catalogue whose ids survive the whole trip, since Whisparr v3 indexes on
   * them and Stash stores them back on the scene. So a search starts here, and
   * ThePornDB is where it goes for what StashDB has never heard of.
   *
   * Every result carries the two answers that decide what you can do with it:
   * whether Stash already has it, and what v3 currently thinks.
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
   * "Is this TPDB scene on StashDB?" — asked before an add, so something found
   * on the TPDB side can still go the v3 route. An exact answer is a
   * fingerprint and can be acted on; a probable is title and date, and this
   * only reports it. Which of the two happens next is the browser's business,
   * because the answer to a probable is a person.
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

  /* -------------------------------------------------------------- acquire
   *
   * The search area. Every filter is StashDB's own — the query goes to StashDB
   * whole, so the count next to a filtered search is the count of the match and
   * not of the two dozen things on screen. See discover.mjs.
   */

  /*
   * The Import overview: the tracked catalogues summed, plus three rows of
   * suggestions drawn from marks you have already made on StashDB itself.
   * Built in the background and cached, like the console.
   */
  ['GET', /^\/api\/import\/overview$/, async (_m, _b, url) => {
    const config = await loadConfig();
    /*
     * Coverage has to have been asked for at least once or the summary is a
     * page of "measuring" that never starts. Not awaited: the first row appears
     * as soon as it is measured, and the page polls for the rest.
     */
    discover.ensureCoverage(config).catch(() => {});
    return overview.ensureOverview(config, { force: url.searchParams.get('refresh') === '1' });
  }],

  // Live, always. A pipeline view half an hour old is worse than none.
  ['GET', /^\/api\/import\/integrations$/, async () => integrations.view(await loadConfig())],

  /*
   * The backups. Reading lists what is actually on disk rather than only what
   * this process has taken since it started — a portal that restarted still
   * knows what it has.
   */
  ['GET', /^\/api\/import\/backups$/, async () =>
    ({ ...backup.snapshot(), onDisk: await backup.existing() })],

  ['POST', /^\/api\/import\/backups$/, async () => backup.run({ force: true, why: 'asked for' })],

  /*
   * Image search. `places` fetches nothing — it hands back where to look, and
   * the fetching happens when one is picked, which is what keeps the rule that
   * only a URL the portal offered is ever fetched.
   */
  ['GET', /^\/api\/import\/images\/places$/, async (_m, _b, url) =>
    imagesearch.placesToLook((url.searchParams.get('name') || '').trim())],

  /*
   * A listing page read for the galleries on it. Only an address the places
   * list already offered, same rule the picture scraper has always kept.
   */
  /* ------------------------------------------------------- match and sort
   *
   * The three piles of work a library this size always has: scenes with no
   * stash-box id, scenes with no cover, and scenes nobody has called finished.
   * Every one of these is a write against Stash, so every one is deliberate —
   * nothing here runs on a page load.
   *
   * A find asks several sources at once and the page decides which answers to
   * keep, so `sources` is a repeated list rather than one name, and the apply
   * takes the picks back rather than an id: a scraper has no id to re-fetch by.
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
      // One stash-box rather than all of them — "what has no ThePornDB id" is
      // a different and much larger question than "what has no id". See
      // endpointTerm() in matchsort.mjs.
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

  /*
   * What is left to catalogue, and where it is. One pass over the library
   * rather than six filtered counts — the folder breakdown needs every path
   * anyway, and six queries could disagree with each other between them.
   */
  ['GET', /^\/api\/catalogue\/overview$/, async () =>
    catalogue.overview(await stashLibrary())],

  /*
   * Telling Stash to go and look at the disk.
   *
   * The counts above are counts of what Stash knows about, and a folder the
   * downloader filled an hour ago is not a small pile — it is no pile at all.
   * Fire-and-report, like the generate: Stash walks the library and hands back
   * a job id, and the page watches that.
   */
  ['GET', /^\/api\/catalogue\/scan$/, async () =>
    catalogue.scanState(await stashLibrary())],

  ['POST', /^\/api\/catalogue\/scan$/, async () =>
    catalogue.startScan(await stashLibrary())],

  ['GET', /^\/api\/catalogue\/scan\/(\d+)$/, async (m) =>
    catalogue.scanStatus(await stashLibrary(), m[1])],

  /*
   * The heavy half of what Stash can make: previews, sprites, image previews,
   * clip previews. Scoped to /organized_scenes — a preview built over a file
   * still waiting on FileFlows is thrown away with it. Same fire-and-report.
   */
  ['GET', /^\/api\/catalogue\/generate$/, async () =>
    catalogue.generateState(await stashLibrary())],

  ['POST', /^\/api\/catalogue\/generate$/, async () =>
    catalogue.generateMedia(await stashLibrary())],

  ['GET', /^\/api\/catalogue\/generate\/(\d+)$/, async (m) =>
    catalogue.generateStatus(await stashLibrary(), m[1])],

  /*
   * Manage › Stash. The organized scan is the arrival-folder scan pointed at
   * /organized_scenes; the chores are the portal's own loops over filed
   * scenes (chores.mjs), one at a time; duplicates is Stash's phash finder.
   */
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

  /*
   * The phashes this pile is missing, and the asking for them.
   *
   * Same filters the queue takes, because the question is about the pile in
   * front of you. The generate is fire-and-report: Stash does the decoding and
   * hands back a job id, and the page watches that rather than holding a
   * request open across a few hundred files.
   */
  ['GET', /^\/api\/import\/match\/phash$/, async (_m, _b, url) =>
    matchsort.phashPlan(await stashLibrary(), pileOf(url))],

  ['POST', /^\/api\/import\/match\/phash$/, async (_m, _b, url) =>
    matchsort.generatePhashes(await stashLibrary(), pileOf(url))],

  ['GET', /^\/api\/import\/match\/phash\/(\d+)$/, async (m) =>
    matchsort.phashStatus(await stashLibrary(), m[1])],

  /*
   * Everything Stash can make for one scene — cover, preview, sprites, phash.
   *
   * Not under /import/match, because Wild Card wants the same button and a
   * scene is a scene. Numeric id, so it cannot be confused with the StashDB
   * uuid routes above it.
   */
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

  /*
   * One candidate's own page, read because you pressed it.
   *
   * A POST because it carries an address, not because it writes — and because
   * a URL this portal is about to fetch should be something the browser handed
   * over deliberately rather than something a link could carry.
   */
  ['POST', /^\/api\/import\/match\/(\d+)\/page$/, async (m, body) =>
    matchsort.readPage(await stashLibrary(), m[1], body?.url || '', body?.key || null)],

  /*
   * The name the file would get if these picks were filed. A POST because it
   * carries the picks, not because it writes — it is renamer.plan with the
   * unfiled values laid over the scene.
   */
  ['POST', /^\/api\/import\/match\/(\d+)\/rename\/plan$/, async (m, body) =>
    matchsort.renamePlan(await stashLibrary(), m[1], {
      picks: Array.isArray(body?.picks) ? body.picks : [],
      fields: Array.isArray(body?.fields) ? body.fields : [],
      overwrite: Boolean(body?.overwrite),
    })],

  /* ---------------------------------------------------------- the wild card
   *
   * One scene, several sources, assembled by hand. Everything here is Stash's
   * own scrapers reached two ways the match page never uses: `scrapeSceneURL`
   * for a page you found yourself, and a NAME scrape for a phrase asked of
   * sites that can search themselves.
   *
   * Both are POSTs even though both only read, because a list of addresses and
   * a list of scraper ids do not belong in a query string — and because a URL
   * this portal is about to fetch should be something the browser handed over
   * deliberately rather than something a link could carry.
   */

  ['GET', /^\/api\/import\/wildcard\/sources$/, async () =>
    wildcard.sources(await stashLibrary())],

  ['GET', /^\/api\/import\/wildcard\/find$/, async (_m, _b, url) =>
    wildcard.find(await stashLibrary(), (url.searchParams.get('q') || '').trim())],

  /*
   * The studios, performers and tags Stash already holds, for the fields the
   * page lets you fill by hand. A list to pick from rather than a box to type
   * into, because the write attaches these by name and only where Stash has
   * one — a typed name that does not exist is a field silently left empty.
   */
  ['GET', /^\/api\/import\/wildcard\/names$/, async (_m, _b, url) =>
    wildcard.names(
      await stashLibrary(),
      (url.searchParams.get('kind') || '').trim(),
      (url.searchParams.get('q') || '').trim()
    )],

  /*
   * Making one Stash does not have yet. A studio, a performer or a tag, one at
   * a time, and only because somebody typed a name into the blank box and then
   * pressed the button next to it — nothing here is reached by scraping and
   * nothing is created by the write.
   */
  ['POST', /^\/api\/import\/wildcard\/names$/, async (_m, body) =>
    wildcard.create(
      await stashLibrary(),
      String(body?.kind || '').trim(),
      String(body?.name || '').trim()
    )],

  ['GET', /^\/api\/import\/wildcard\/scene\/(\d+)$/, async (m) =>
    wildcard.scene(await stashLibrary(), m[1])],

  /*
   * Frames to search by. Listing is free; cutting is several seeks into one
   * file over the share and is only ever done because somebody pressed.
   */
  /*
   * Frames cut out of a file. Under /catalogue because both pages under that
   * tab want them now — Wild Card to search by, and Match to compare a
   * candidate's artwork against something better than one thumbnail. The
   * wildcard spelling still answers; it was the first caller and is somebody's
   * bookmark by now.
   */
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

  /*
   * The name the file would get if the record on screen were written.
   *
   * A POST because it carries the choices, not because it does anything — it
   * is renamer.plan with the unsaved values laid over the scene. Wild Card
   * needs this and Match does not: Match has already written by the time the
   * question comes up, so its plan can be a GET of what Stash holds.
   */
  ['POST', /^\/api\/import\/wildcard\/scene\/(\d+)\/rename\/plan$/, async (m, body) =>
    renamer.plan(await stashLibrary(), m[1], body?.values || null)],

  /*
   * Renaming a matched file to what the match said it was. Scoped to
   * /pc-import inside renamer.mjs, against the resolved path — the only thing
   * that crosses this boundary is a scene id, so there is no path here to have
   * to validate and none to get wrong.
   */
  /*
   * Setting a scene aside, and taking it back. A tag on the scene rather than
   * a list in here — it is a fact about the scene, it shows in Stash, and it
   * survives this portal being rebuilt.
   */
  ['POST', /^\/api\/import\/match\/(\d+)\/aside$/, async (m, body) =>
    /*
     * The endpoint scopes the claim. Sent from the per-box piles and absent
     * from the others, because "no box has this" and "TPDB does not have this"
     * are different things to have decided.
     */
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

  /* ---------------------------------------------------------- group builder
   *
   * The films your loose scenes add up to. Every route here reads; the two that
   * write — approve and the per-scene answers — are pressed one at a time by
   * somebody looking at the evidence. See groupbuilder.mjs for why nothing
   * scans on a page load.
   */

  ['GET', /^\/api\/import\/groups$/, async () => groupbuilder.studios(await stashLibrary())],

  /*
   * Kicks a studio's scan off and returns immediately. One studio is a few
   * hundred ThePornDB calls plus an IAFD page every 1.2 seconds, so this can
   * never be the thing a request waits on — the page polls the proposals route
   * for progress, the same contract the gaps and coverage builds use.
   */
  ['POST', /^\/api\/import\/groups\/scan$/, async (_m, body) => {
    if (!body?.studio) throw httpError(400, 'Which studio should be scanned?');
    return groupbuilder.scan(await stashLibrary(), String(body.studio), { force: body.force === true });
  }],

  /*
   * The offline tier: films the scene titles name themselves. One pass over the
   * whole library rather than one studio, because it needs no catalogue to
   * scope it to. Cheap enough to be the first thing anybody runs.
   */
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

  /*
   * One missing scene, answered. The key is a ThePornDB guid where TPDB named
   * the scene and "<movie>:<n>" where only IAFD did, so it is matched loosely
   * and decoded rather than pattern-matched into a shape.
   */
  ['POST', /^\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)$/, async (m, body) =>
    groupbuilder.decideScene(await loadConfig(), decodeURIComponent(m[1]), decodeURIComponent(m[2]), String(body?.verdict || ''), { force: Boolean(body?.force) })],

  ['DELETE', /^\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)$/, async (m) =>
    groupbuilder.undecideScene(await loadConfig(), decodeURIComponent(m[1]), decodeURIComponent(m[2]))],

  // What StashDB has for a cast IAFD named and nothing else. Writes nothing.
  ['GET', /^\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find$/, async (m) =>
    groupbuilder.findMissing(await loadConfig(), decodeURIComponent(m[1]), decodeURIComponent(m[2]))],

  /*
   * Which of those candidates it is. Writes only to this page's own store — it
   * names the scene so track and add have something to work with, and does not
   * do either of them.
   */
  ['POST', /^\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find$/, async (m, body) =>
    groupbuilder.resolveMissing(await loadConfig(), decodeURIComponent(m[1]), decodeURIComponent(m[2]), body?.stashdbId)],

  /* --------------------------------------------------- the marker builder
   *
   * Cutting markers by hand, one scene at a time. Everything here needs Stash
   * and nothing else — markers are a Stash object and no catalogue knows
   * anything about them. See markerbuilder.mjs for why it creates tags when
   * the batch tagger deliberately refuses to.
   */
  ['GET', /^\/api\/import\/markers$/, async (_m, _b, url) =>
    markerbuilder.queue(await stashLibrary(), {
      q: url.searchParams.get('q') || '',
      mode: url.searchParams.get('mode') || 'unmarked',
      page: Number(url.searchParams.get('page')) || 1,
    })],

  /*
   * The whole queue as ids, for the shelf the picker draws. Above this line so
   * the exact-match route for /api/import/markers cannot swallow it — these are
   * anchored regexes, but the order is the thing that makes that true and it is
   * cheaper to keep than to re-derive.
   */
  ['GET', /^\/api\/import\/markers\/queue$/, async () =>
    markerbuilder.queued(await stashLibrary())],

  /*
   * Every marker, a page at a time — the management list. Asked of the markers
   * rather than of the scenes holding them, which is the one question neither
   * route above can answer. See all() in markerbuilder.mjs.
   */
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

  /*
   * What timestamp.trade and ThePornDB have for this scene. Read-only, both of
   * them, and nothing is written until the page says which rows to take — see
   * markersources.mjs for why that is the whole point.
   */
  ['GET', /^\/api\/import\/markers\/scene\/(\d+)\/sources$/, async (m) =>
    markersources.fetched(await stashLibrary(), m[1])],

  /*
   * The sharper filmstrip. Stash's own sprite sheet is ~81 tiles whatever the
   * length, which is a picture every 17 seconds on a half-hour scene — right
   * for a scrub bar, useless as a timeline. See spritestrip.mjs.
   */
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

  /*
   * The wild card, asked separately and never merged into the results above —
   * a TPDB scene goes to Whisparr v2 and a StashDB one to v3, and a card should
   * not hide which.
   */
  ['GET', /^\/api\/acquire\/wildcard$/, async (_m, _b, url) => {
    const config = await loadConfig();
    return discover.wildcard(config, (url.searchParams.get('q') || '').trim());
  }],

  /*
   * The indexers, by hand, through Prowlarr — for a scene neither catalogue
   * has. A grab goes to Prowlarr's download client, not to a Whisparr.
   */
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
   * Coverage for the tracked studios and performers.
   *
   * Served from cache and measured in the background, like the home page: a
   * catalogue read plus a match against Stash per entity is not something to do
   * inside a page load. Anything not measured yet comes back pending, so a
   * studio appears the moment it is tracked.
   */
  /*
   * The standing noes. Read and written whole: it is a short list somebody is
   * looking at while they edit it, and a per-rule route would be three routes
   * for a list of five things.
   */
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
   * The want list: scenes you have marked, one entry per StashDB id.
   *
   * Nothing here talks to Whisparr on the way in. Marking a scene says you want
   * it; Add says fetch it, and the two are different sentences. Untracking does
   * reach Whisparr, because a scene nobody wants should not still be being
   * looked for — the record goes, the files do not.
   */
  /*
   * The nightly release: the want list let out a few at a time rather than all
   * at once. See release.mjs for why it is random and why it is a trickle.
   */
  ['GET', /^\/api\/acquire\/release$/, async () => release.view(await loadConfig())],

  ['POST', /^\/api\/acquire\/release$/, async (_m, body) =>
    release.update(await loadConfig(), body || {})],

  /*
   * Tonight's, now. Does not mark the day as done — pressing this is somebody
   * asking for a batch on top, not instead of.
   */
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

  /*
   * Fill in fields older marks were made without — today, the description the
   * card grew. Asks StashDB only about the records missing something, so a
   * second run costs nothing and it is safe to call whenever a field is added.
   */
  ['POST', /^\/api\/acquire\/tracked\/scenes\/backfill$/, async () =>
    discover.backfillSceneDetails(await loadConfig())],

  /*
   * The third answer. Tracking a scene says "get this", ignoring one says "not
   * for me" — and the point of saying so is that it leaves both the results and
   * the percentage, rather than coming back every time the catalogue is read.
   */
  ['POST', /^\/api\/acquire\/ignored$/, async (_m, body) => {
    const config = await loadConfig();
    await discover.ignoreScene(config, body?.id);
    return { ignored: true };
  }],

  /*
   * A screenful at once, and one write for the lot. See ignoreScenes() — the
   * per-card route above rewrites the config every time it is pressed, which
   * is fine for one press and not for twenty-four.
   */
  ['POST', /^\/api\/acquire\/ignored\/batch$/, async (_m, body) =>
    discover.ignoreScenes(await loadConfig(), body?.ids || [])],

  /*
   * Everything the current filter still has to say, swept in the background.
   * One at a time, because it walks StashDB a page at a time to get there.
   */
  ['POST', /^\/api\/acquire\/skiprest$/, async (_m, body) => {
    const config = await loadConfig();
    // The page sends the query string it is looking at rather than a parsed
    // object, so the sweep is reading the same filters through the same
    // function the results came out of.
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

  /* ------------------------------------------------------------- library
   *
   * Keyed on Stash ids, not TPDB UUIDs. See stashlib.mjs for why.
   */

  ['GET', /^\/api\/library\/rails$/, async (_m, _b, url) =>
    ({ rails: await shelf.rails(await stashLibrary(), { force: url.searchParams.get('refresh') === '1' }) })],

  /*
   * The five news feeds on the Overview's landing block. Reads whatever is
   * cached and refreshes in the background when it is stale — see feeds.mjs.
   * Nothing here needs Stash, so it sits with the library routes rather than
   * gated behind them.
   */
  ['GET', /^\/api\/library\/feeds$/, async () => feeds.view()],

  /* The four library sections, plus the overview that fronts them. Each is
   * "what you hold" and "what Stash knows about but you hold nothing of" —
   * counted in the library folder, not in Stash's own totals. */

  ['GET', /^\/api\/library\/overview$/, async () => shelf.overview(await stashLibrary())],

  /*
   * Groups and single-file features as one shelf, with the facets the filter
   * bar offers. Sent whole: fifty-odd films is one response and the page
   * narrows it without coming back. See films.mjs for that ceiling.
   */
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
   * Finding a scrapeable address for the films that have none.
   *
   * A long pass — it obeys the source's thirty-second crawl delay — so this
   * kicks it off and hands back whatever has been found so far, the same
   * contract the gaps and coverage builds use.
   */
  /*
   * Filling the feature films in from the .nfo files beside them. A dry run by
   * default: the preview is the whole point, since this writes to fifty-one
   * scenes at once and nothing about that should be a surprise.
   */
  ['GET', /^\/api\/library\/identify\/movies$/, async () =>
    identify.preview(await stashLibrary())],

  /*
   * Emby's artwork onto the Stash scenes. A dry run unless asked otherwise,
   * because this one overwrites the generated covers rather than filling a gap.
   */
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
   * Read an address with Stash's own scrapers and hand back what they found,
   * unwritten. The gates that turn away a plain fetch — data18's captcha,
   * AdultEmpire's age wall — are Stash's problem here, and it walks through
   * both. That is why this asks Stash rather than fetching anything itself.
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

  /*
   * Confirming one. Separate from finding it on purpose: a title match is a
   * guess, and this library has five groups sharing a name — so a candidate only
   * becomes a URL when somebody says so.
   */
  ['POST', /^\/api\/library\/groups\/(\d+)\/url$/, async (m, body) => {
    const chosen = (body?.url || '').trim();
    if (!chosen) throw httpError(400, 'Which URL?');
    return shelf.setGroupUrl(await stashLibrary(), m[1], chosen);
  }],

  /*
   * Scenes still moving through the pipeline, and one stage on its own. Both
   * are statuses now rather than an exclusion — a scene in /pc-import is yours,
   * it just has not finished moving. See STAGES in stashlib.mjs.
   */
  ['GET', /^\/api\/library\/in-flight$/, async (_m, _b, url) =>
    shelf.inFlight(await stashLibrary(), { limit: 60, page: Number(url.searchParams.get('page')) || 1 })],

  ['GET', /^\/api\/library\/stage\/([a-z]+)$/, async (m, _b, url) =>
    shelf.stageList(await stashLibrary(), m[1], { limit: 60, page: Number(url.searchParams.get('page')) || 1 })],

  /* ---------------------------------------------------------------- tidying
   *
   * What Whisparr is still holding that Stash has already filed. The survey is
   * a read; the two writes are separate buttons, and the removal only ever
   * touches something unmonitored for a full fortnight. See tidy.mjs.
   */

  ['GET', /^\/api\/tidy$/, async (_m, _b, url) =>
    tidy.survey(await stashLibrary(), { force: url.searchParams.get('refresh') === '1' })],

  ['POST', /^\/api\/tidy\/unmonitor$/, async () => tidy.unmonitor(await stashLibrary())],

  ['POST', /^\/api\/tidy\/remove$/, async () => tidy.remove(await stashLibrary())],

  /*
   * The TPDB half of each page: what is missing from the people and sites you
   * already collect. Performers are built in the background here; studios come
   * from the home page's coverage table, which already counts exactly this.
   */
  ['GET', /^\/api\/library\/gaps$/, async (_m, _b, url) => {
    const config = await loadConfig();
    const force = url.searchParams.get('refresh') === '1';

    /*
     * Studio gaps are the home page's coverage table. Kick that build off too,
     * or the studios page stays empty until someone happens to open Acquire.
     */
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

  /*
   * The whole shelf, tags and all. One read the Scenes page filters in the
   * browser, so its dropdowns are built from what you hold rather than from
   * Stash's full lists.
   */
  ['GET', /^\/api\/library\/shelf$/, async () => shelf.shelf(await stashLibrary())],

  ['GET', /^\/api\/library\/list\/([a-z]+)$/, async (m, _b, url) =>
    shelf.list(await stashLibrary(), m[1], { page: Number(url.searchParams.get('page')) || 1 })],

  /*
   * Categories. Portal-owned — see categories.mjs — so these read the shelf
   * Stash already gave us and nothing here writes back to it. Every mutation
   * is a POST because the dispatcher above only reads a body for POST, and a
   * DELETE that had to carry one would be the odd route out.
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

  /*
   * The reel. The client picks the shuffle's seed so that paging holds
   * together across requests, and it is stripped to digits here because it
   * goes into a sort string on its way to Stash.
   */
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
     * Which feed you are on, which the reel now moves between sideways.
     *
     *   mixed    all three, in the proportions the ratio slider sets
     *   library  your own, and nothing else
     *   redgifs  RedGIFs on its own
     *   reddit   Reddit on its own
     *
     * The three dedicated ones are not the mix with a ratio pushed to an
     * extreme: a pure RedGIFs feed has no library page to thread through, so
     * there is nothing to mix into and it is dealt straight from the pool.
     */
    const feed = ['library', 'scenes', 'redgifs', 'reddit'].includes(url.searchParams.get('feed'))
      ? url.searchParams.get('feed')
      : 'mixed';

    if (feed === 'redgifs') return redgifs.feed({ page, seed });
    if (feed === 'reddit') return reddit.feed({ page, seed });

    /*
     * Markers and scenes used to be a dropdown in the bar. They are two of the
     * feeds now, which is what they always were — a different set of slides,
     * not a setting applied to the same ones. The `source` parameter is still
     * read for older links.
     */
    const scenes = feed === 'scenes' || (feed === 'mixed' && url.searchParams.get('source') === 'scenes');

    const base = scenes
      ? await shelf.sceneReel(config, { seed, page })
      : await shelf.markerReel(config, { seed, page, tag, exclude });

    // Your own and nothing else — the mix, with the other two turned off.
    if (feed === 'library' || feed === 'scenes') return base;

    /*
     * How the page is made up, as three percentages of the finished thing —
     * library, RedGIFs, Reddit. Set in the reel's own settings; 75/15/10 by
     * default, which is a library reel with things woven through it rather
     * than a feed with some of your own scenes in.
     *
     * The library page size is fixed, so the other two are worked out relative
     * to it: a page of twelve at 75/15/10 gains two and two.
     */
    const ratio = (url.searchParams.get('ratio') || '')
      .split(',')
      .map((value) => Math.max(0, Math.min(100, Number(value) || 0)));

    const [libraryPart = 75, gifPart = 15, redditPart = 10] = ratio.length === 3 ? ratio : [75, 15, 10];

    if (!libraryPart) return base;

    const own = base.items.length;

    /*
     * Counted from the running total rather than per page, so the numbers mean
     * what they say. Twelve library items a page cannot express 15% against
     * 10% — both round to two — and every page would come out an even 2/2. So
     * each page takes the difference between where the ratio has reached by
     * the end of it and where it had reached by the end of the last one, and
     * over a few pages the split lands where it was asked to.
     */
    const upto = (part, pages) => Math.round(own * (part / libraryPart) * pages);
    const gifTake = upto(gifPart, page) - upto(gifPart, page - 1);
    const redditTake = upto(redditPart, page) - upto(redditPart, page - 1);

    let out = base;
    if (gifTake > 0) out = await redgifs.mixInto(out, { page, take: gifTake, seed });

    /*
     * Offset, so the second source does not land next to the first. Both space
     * themselves the same way from the same starting point, and without it a
     * page reads M M M M R G M M M M — two off-library slides back to back and
     * then a long run of nothing but library.
     */
    if (redditTake > 0) out = await reddit.mixInto(out, { page, take: redditTake, offset: 2, seed });

    return out;
  }],

  /*
   * What the reel was left set to. Its own route rather than /api/config,
   * which drops every cache on the way through — right for a changed Stash
   * URL, absurd for someone flipping the framing button.
   */
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

  /*
   * Reddit. The read is always of the cache, because a walk of every source
   * takes half an hour at the pace Reddit's feeds allow — see reddit.mjs. So
   * refresh starts one and answers immediately with where it has got to, and
   * the page watches that rather than waiting on it.
   */
  ['GET', /^\/api\/reddit$/, async (_m, _b, url) =>
    reddit.view(await stashLibrary(), { performerId: url.searchParams.get('performer') || null })],

  /*
   * Our own marker clips — 720 high, cut from the source, because Stash's are
   * 640x360 and nothing reaches that number. See markerclips.mjs.
   */
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
   * One performer: the shelf, and — when Stash has identified them against
   * StashDB — the catalogue they are measured against and the scenes of theirs
   * you said you wanted. `only=scenes` is the same page paging itself.
   */
  ['GET', /^\/api\/library\/performers\/(\d+)$/, async (m, _b, url) =>
    performerPage(await stashLibrary(), m[1], {
      page: Number(url.searchParams.get('page')) || 1,
      only: url.searchParams.get('only'),
    })],

  /*
   * What IAFD has about them — the birthplace, the weight, the year they
   * stopped, none of which Stash carries. Its own request rather than part of
   * the page above, because this one leaves the house: the performer page
   * draws from Stash straight away and fills these in when they arrive, or
   * never. See iafd.mjs.
   */
  ['GET', /^\/api\/library\/performers\/(\d+)\/iafd$/, async (m) =>
    shelf.performerIafd(await stashLibrary(), m[1])],

  /*
   * And those gaps written into Stash. Gaps only — a field Stash has an answer
   * for is never touched, so this needs no preview to tick through and there
   * is nothing it can undo. The list it writes is worked out from a fresh read
   * at the moment of the click, not from whatever the open page was told.
   */
  ['POST', /^\/api\/library\/performers\/(\d+)\/iafd$/, async (m) =>
    shelf.fillPerformerFromIafd(await stashLibrary(), m[1])],

  /*
   * One studio: the shelf, the cast, and — when Stash has identified it against
   * StashDB — the catalogue it is measured against. `only=scenes` is the same
   * page paging or filtering itself and skips everything it already has.
   */
  ['GET', /^\/api\/library\/studios\/(\d+)$/, async (m, _b, url) => {
    const performer = url.searchParams.get('performer');
    return studioPage(await stashLibrary(), m[1], {
      page: Number(url.searchParams.get('page')) || 1,
      performer: /^\d+$/.test(performer || '') ? performer : null,
      only: url.searchParams.get('only'),
    });
  }],

  /*
   * A studio's facts from ThePornDB's mirror, and those of them Stash is
   * missing written back. The studio page's answer to the performer page's
   * IAFD pair — a different source for the reason in studiofacts.mjs, the same
   * gaps-only rule, and the same split: reading is a GET the page fills itself
   * in with, writing is the button.
   */
  ['GET', /^\/api\/library\/studios\/(\d+)\/facts$/, async (m) =>
    shelf.studioFacts(await stashLibrary(), m[1])],

  ['POST', /^\/api\/library\/studios\/(\d+)\/facts$/, async (m) =>
    shelf.fillStudioFromSite(await stashLibrary(), m[1])],

  ['GET', /^\/api\/library\/groups\/(\d+)$/, async (m, _b, url) =>
    shelf.groupView(await stashLibrary(), m[1], { page: Number(url.searchParams.get('page')) || 1 })],

  /* --------------------------------------------------------- galleries
   *
   * The still half of the library. One collection route, because "every
   * gallery" and "the galleries on this scene" are the same question with a
   * different filter — and the ties are asked for by a page that has already
   * drawn, so a Stash with no galleries costs a row that never appears.
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

  /*
   * The card's own tool set: what it is called, which picture fronts it, how
   * that picture is cropped into the square, and getting rid of it. Renaming
   * and cropping are the two a photo set actually needs — the crop is a focal
   * point on the record, so the original file is never touched.
   */
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

  /*
   * What it belongs to. The build sets these from the page you built on; this
   * is for every other gallery, and for changing your mind.
   */
  ['POST', /^\/api\/library\/galleries\/(\d+)\/ties$/, async (m, body) =>
    galleries.setTies(await stashLibrary(), m[1], {
      sceneIds: Array.isArray(body?.sceneIds) ? body.sceneIds : undefined,
      performerIds: Array.isArray(body?.performerIds) ? body.performerIds : undefined,
      studioId: 'studioId' in (body || {}) ? body.studioId : undefined,
    })],

  /*
   * The type-ahead behind those pickers. One box each for a performer, a scene
   * and a studio, answered by Stash rather than by reading the whole library
   * into the browser.
   */
  ['GET', /^\/api\/library\/lookup$/, async (_m, _b, url) => {
    const kind = url.searchParams.get('kind') || '';
    if (!['performer', 'scene', 'studio'].includes(kind)) {
      throw httpError(400, 'Look up a performer, a scene or a studio.');
    }
    return shelf.lookup(await stashLibrary(), kind, url.searchParams.get('q'));
  }],

  /*
   * Pictures in and out of a gallery that already exists.
   *
   * Adding is two halves: the files arrive at /api/galleries/upload, then this
   * asks Stash to look at the folder again — which is where the new pictures
   * become images in the gallery. Removing is Stash's own delete, and it takes
   * the file with it, because a file left in the folder comes back on the next
   * scan.
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

  /*
   * The files go too, and only when asked for by name. Leaving the folder
   * behind would mean Stash rebuilding the gallery on its next scan, so the
   * button that says "delete" has to mean it.
   */
  ['POST', /^\/api\/library\/galleries\/(\d+)\/delete$/, async (m, body) =>
    galleries.destroy(await stashLibrary(), m[1], { files: body?.files === true })],

  /* ------------------------------------------------------ building one
   *
   * Find, then choose, then write. The find is a read and says nothing about
   * what will be kept; the build is the only thing in the portal that puts a
   * file where Stash will import it, and it only ever runs on a list someone
   * has looked at. See gallerybuild.mjs.
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

    /*
     * An upload has already written its files — the browser sent them one at a
     * time before getting here — so this half is only the scan and the tie.
     */
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

  /*
   * The player reports back roughly every 15s and once on leaving, so this is
   * the hottest write in the app. It is fire-and-forget on the client side.
   */
  ['POST', /^\/api\/library\/scenes\/(\d+)\/activity$/, async (m, body) =>
    shelf.saveActivity(await stashLibrary(), m[1], {
      resume: Number.isFinite(body?.resume) ? body.resume : null,
      played: Number.isFinite(body?.played) ? body.played : null,
    })],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/play$/, async (m) => shelf.addPlay(await stashLibrary(), m[1])],

  /*
   * Marking a scene filed, and filing it.
   *
   * "Organized" was a flag and nothing else: the record said filed and the
   * file stayed in whichever folder it had landed in, so the library on disk
   * drifted from the library Stash describes and the actual filing was done
   * later, by hand, in a plugin. The flag does the move now — see filer.mjs
   * for the shape it moves things into and why most of it costs nothing.
   *
   * **The flag is set first and the move is allowed to fail.** Marking
   * something filed is a statement about the scene; refusing it because the
   * title has no date in it yet would be the tail wagging the dog. So the
   * press always does what it says, and `filed` carries what became of the
   * file — moved, already there, or a reason it could not be.
   *
   * Only on the way *in*. Unmarking a scene does not carry the file back out
   * to a folder it has not been in for months.
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
      /*
       * Re-planned for the reason rather than reusing the thrown message: a
       * scene already sitting in /organized_scenes is the ordinary case and
       * has to come back marked as such, so the page can stay quiet about it
       * instead of reporting a failure on every scene that was already filed.
       */
      const why = await filer.plan(config, m[1]).catch(() => null);
      const said = why?.why || err.message;

      /*
       * Said on the server as well as on the button. The button clears itself
       * after a few seconds and the press often happens while looking at
       * something else, so a filing that failed left no trace anywhere — and
       * "it says filed but the file did not move" is exactly the thing you
       * come back to the logs for. An already-filed scene is not a failure
       * and does not get a line.
       */
      if (!why?.already) console.warn(`[tpdbarr] scene ${m[1]} marked filed but not moved - ${said}`);

      return { ...scene, filed: { moved: false, already: Boolean(why?.already), why: said } };
    }
  }],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/rating$/, async (m, body) =>
    shelf.setRating(await stashLibrary(), m[1], body?.rating ?? null)],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/o$/, async (m) => shelf.addO(await stashLibrary(), m[1])],

  /*
   * Deleting one. Two calls on purpose: the page asks what would go before it
   * offers to do it, so the warning it shows is the truth from Stash rather
   * than a guess made in the browser.
   */
  /*
   * Re-encoding a filed scene smaller, and replacing it with the result. The
   * plan is what the page asks before it draws the buttons — a scene that
   * cannot be shrunk says why rather than offering a control that fails when
   * it is pressed. See downscale.mjs for what it refuses and why.
   */
  ['GET', /^\/api\/library\/scenes\/(\d+)\/downscale$/, async (m) =>
    downscale.plan(await loadConfig(), m[1])],

  ['POST', /^\/api\/library\/scenes\/(\d+)\/downscale$/, async (m, body) =>
    downscale.start(await loadConfig(), m[1], Number(body?.height) || 0)],

  /*
   * What resolution a scene should end up at, and whether FileFlows is kept
   * off it. See resolution.mjs: a choice waits for filing on an unfiled scene
   * and acts at once on a filed one.
   */
  ['GET', /^\/api\/library\/scenes\/(\d+)\/resolution$/, async (m) =>
    resolution.plan(await loadConfig(), m[1])],
  ['POST', /^\/api\/library\/scenes\/(\d+)\/resolution$/, async (m, body) =>
    (body?.release
      ? resolution.release(await loadConfig(), m[1])
      : resolution.choose(await loadConfig(), m[1], body?.choice))],

  // One job for the whole portal, so its progress is not per scene.
  /*
   * The catch-up: every filed scene that already carries a stash id, asked of
   * the source that id belongs to and filled in where it is blank. Nothing is
   * matched or guessed — see catchup.mjs. `scope` is what a run would look at,
   * read before the button is pressed so it can say so.
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

  /* ---------------------------------------------------------- movie files
   *
   * The films on the share, read off the mount rather than out of Stash — see
   * moviefiles.mjs. Distinct from /api/movies, which is TPDB's movie catalogue
   * on the acquisition side: these are the ones you already have.
   */

  ['GET', /^\/api\/moviefiles$/, async (_m, _b, url) =>
    moviefiles.overview({ force: url.searchParams.get('refresh') === '1' })],

  ['GET', /^\/api\/moviefiles\/([0-9a-f]{12})$/, async (m) => {
    const movie = await moviefiles.findMovieWatched(m[1]);
    if (!movie) throw httpError(404, 'No movie with that id.');
    return { movie };
  }],

  /*
   * Where you got to, and how many times. Stash keeps this for scenes; films
   * have nowhere else to keep it, so it lives beside the config. Same contract
   * as the scene player: reported on a timer and beaconed on the way out.
   */
  ['POST', /^\/api\/moviefiles\/([0-9a-f]{12})\/activity$/, async (m, body) =>
    watch.saveActivity(m[1], {
      resume: Number.isFinite(body?.resume) ? body.resume : null,
      duration: Number.isFinite(body?.duration) ? body.duration : null,
    })],

  ['POST', /^\/api\/moviefiles\/([0-9a-f]{12})\/play$/, async (m) => watch.addPlay(m[1])],

  ['POST', /^\/api\/moviefiles\/([0-9a-f]{12})\/forget$/, async (m) => watch.clearWatch(m[1])],

  /*
   * Filling in a film Emby never matched. The search is a read; the apply is
   * the only write this app makes to the media share, and it happens because
   * someone looked at the candidates and picked one. See gapfill.mjs.
   */
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

  /* ---------------------------------------------------------- whisparr v3
   *
   * Keyed on the StashDB scene UUID, which is what v3 indexes on. The library
   * scene page asks for this after it has drawn, so a v3 that is down or unset
   * costs a badge and not the page.
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
    return whisparr3.addScene(config, m[1]);
  }],

  /*
   * "I have this one — get me another." Adds and monitors the scene if v3 has
   * forgotten it, then forces a search. Deletes nothing: the file on the share
   * stays exactly where it is until you have something better to put in its
   * place. See whisparr3.askAgain.
   */
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
 * The two questions a StashDB result raises, answered in bulk.
 *
 * Ownership is the exact half only — a StashDB id found on a scene in Stash.
 * There is no title-and-date fallback here on purpose: this is the answer that
 * decides whether a button says "add", and a probable is not good enough to
 * hide the button on.
 *
 * Neither side is allowed to take the search down with it. A Stash that is
 * unset or a v3 that is off both mean "no annotation", which is a page that
 * still works.
 */
/*
 * One implementation, in discover.mjs — it does the same StashDB-id match this
 * used to and then a title-and-date pass for the third of the library that was
 * identified against ThePornDB's stash-box instead. Before that second pass,
 * those scenes reported as missing on every page that shows a StashDB result.
 */
const annotate = (config, scenes) => discover.annotate(config, scenes);

/*
 * Everything under /api/library needs Stash. Whisparr being down or unset is a
 * state the rest of the portal copes with; here it is the whole point.
 */
/*
 * The Reddit handles the RedGIFs creator list seeds itself from. Every path
 * that starts a pass goes through here, so none of them can hand it an empty
 * list and let it conclude there are no creators.
 */
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

/*
 * Which folder an upload is going into: a new gallery's, or an existing
 * gallery's. Both end up as a path this app can write to, or an error saying
 * why not.
 */
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
 * One megabyte is the right cap for a JSON body that is somebody's typed
 * answer. It is the wrong cap for the match page.
 *
 * A candidate's cover comes back from Stash's scrapers as a base64 data URI
 * rather than a link, and one 1080p cover is most of a megabyte on its own. So
 * two ticked sources on the match page could overrun a limit meant for text,
 * and the error read as "untick something" — which is what it was being worked
 * around with. Those routes get room for the pictures they are actually
 * carrying; everything else keeps the small cap.
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
 * The stylesheet is a folder now.
 *
 * It was 4,581 lines in one file, which is the same problem the two front-end
 * modules had: everything about every page in one place. It is split under
 * public/css/ and joined here rather than with @import or a dozen <link> tags,
 * because both of those cost a request each and the cascade is unforgiving
 * about order.
 *
 * Order is the filename order, which is why every one carries a three-digit
 * prefix. There is no manifest to fall out of step with the directory: a new
 * section is a new file, named where it belongs.
 *
 * Joined once per process. The page asks for it with no-cache like everything
 * else here, and the container is rebuilt when the files change.
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

/*
 * A file off the disk, with Range support.
 *
 * Our marker clips are video, and a video the browser cannot seek is a video
 * the reel cannot scrub. Ranges also let a slide start playing before the
 * whole clip has arrived, which on a megabyte file is the difference between
 * instant and nearly instant.
 */
/*
 * This served only marker clips until the bench grew a filmstrip of its own,
 * which is JPEG sheets. A sheet handed over as video/mp4 is a sheet the
 * browser will not put in a background-image, and it fails silently — the
 * strip just stays empty.
 */
/*
 * The three picture formats on the end are for uploaded category artwork,
 * which is the first thing this serves off disk that is not a scene or a
 * still. Without them a perfectly good WebP went out as a byte stream and the
 * browser drew a broken image at it.
 */
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
   * A picture for a row, whatever it takes — the real cover when there is one,
   * a frame cut out of the file when there is not. Ahead of the proxy below
   * because Stash answers a missing cover with a 200 and a placeholder, so
   * nothing downstream of it can tell the difference. See scenethumb.mjs.
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

  /*
   * One of the frames the wild card page cuts to search by. Ours, off our own
   * disk, so it goes beside the thumb rather than through the Stash proxy.
   */
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

  /*
   * Our own rendered clip for a marker, straight off the disk. Ahead of the
   * Stash proxy below it, because when we have one it is the better file:
   * 720 rather than 360, and written faststart.
   */
  const ours = url.pathname.match(/^\/media\/marker\/(\d+)\/clip$/);

  if (ours) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    return serveFile(res, req, markerclips.clipPath(ours[1]));
  }

  /*
   * One sheet of a scene's own filmstrip. Ours, off the disk, so it does not
   * go near the Stash proxy — Stash has never heard of these.
   */
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

  /*
   * Candidate artwork from ThePornDB and TMDB. Only URLs the gap-filler has
   * already offered as candidates are fetchable — see gapfill.mjs — so this
   * cannot be pointed at anything on the network by hand.
   */
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

  /*
   * Pictures and clips from off the library — Reddit's, and RedGIFs'. Same
   * rule again: only a URL one of those modules has already put on a page can
   * be fetched, so this is not an open proxy either. Their media hosts are not
   * rate limited, so unlike the feeds these are fetched live.
   */
  if (url.pathname === '/media/social') {
    const target = url.searchParams.get('url') || '';
    const owner = redgifs.isKnown(target) ? redgifs : reddit.isKnown(target) ? reddit : null;

    if (!owner) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('unknown media');
      return;
    }

    /*
     * Cancelled with the response rather than on a timer. A clip is megabytes
     * and the reel abandons requests constantly as you scroll — an
     * AbortSignal.timeout() fires in the middle of a download that is going
     * perfectly well, and the stream error it raises took the whole server
     * down until this was written the way media.mjs already does it.
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
     * Content-Length is deliberately not passed on. fetch has already undone
     * any compression by the time the body is readable, so the length the
     * upstream declared is not the length of what goes out — and a browser
     * handed a mismatched one drops the request with ERR_CONTENT_LENGTH_
     * MISMATCH. Letting Node chunk it costs nothing and is always right.
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
   * Thumbnails for the gallery picker, from wherever the pictures were found.
   * Same rule as the artwork proxy above: only a URL galleryscrape.mjs has
   * already offered is fetchable, and it goes out with the Referer of the page
   * it was found on — plenty of image hosts serve a placeholder otherwise.
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
   * Sits ahead of the routing table because it is not JSON: the body is the
   * file, and the table's reader caps a body at 1MB and parses it. One request
   * per file, which keeps a failed picture to a failed picture rather than a
   * failed set, and means no multipart parser has to exist.
   *
   * `name` builds a new gallery's folder; `gallery` adds to one that already
   * exists. Only folders this app manages can be written to — a photo set
   * Stash scanned from somewhere else is not this app's to change.
   */
  /*
   * A category's own artwork: up as the request body, back as a file.
   *
   * Both halves are here rather than in the table for the same reason the
   * gallery upload is - one carries a picture in and the other a picture out,
   * and the table reads a JSON body and writes a JSON answer.
   *
   * The GET is public in the same sense every other picture this app serves
   * is: it is on your own network, behind whatever the portal is behind.
   */
  /*
   * Wild Card's own cover: a picture you uploaded, or one fetched from an
   * address you pasted. Here rather than in the table because the POST may
   * carry bytes rather than JSON, and the GET hands bytes back.
   *
   * Nothing is written to Stash by either. The picture is held in memory under
   * the address this returns, the row draws it as one more option, and it only
   * reaches the scene if it is the one chosen when Write is pressed.
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
    // serveFile types it off the extension, which here was chosen from the
    // file's own header rather than from the name the browser sent - so the
    // type it lands on is the type the bytes actually are.
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

  /*
   * A performer's photograph and a studio's logo, replaced with one you
   * uploaded. Here rather than in the table for the same reason as the two
   * above: the body is a picture.
   *
   * Straight into Stash. The portal draws Stash's copy of both everywhere,
   * and a picture kept on this side would be a second answer to a question
   * the library of record already answers. See stashlib.setPerformerImage.
   */
  const person = /^\/api\/library\/(performers|studios)\/(\d+)\/image$/.exec(url.pathname);

  /*
   * Taking one off again. The empty string is how Stash is told to clear an
   * image - null on an update means "leave it alone", which is the opposite.
   *
   * It is here rather than in the table only to sit beside the POST it undoes;
   * its body is nothing at all.
   */
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

  /*
   * A path can appear more than once with different methods — reading a scene's
   * Whisparr v3 state and sending it there are the same URL. So a method that
   * does not match keeps looking, and 405 is only the answer once every route
   * for this path has been tried.
   */
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
 * The Reddit walk picks itself back up.
 *
 * A pass over every source takes hours at the pace Reddit allows, so a restart
 * in the middle of one would otherwise leave it stopped until somebody opened
 * the page and pressed the button. The cursor is already on disk, so this only
 * has to start it going again — a minute after boot, so it is not competing
 * with the rest of startup, and only when the cache has actually gone stale.
 */
const REDDIT_CHECK_MS = 60 * 60 * 1000;

/*
 * Marker clips look after themselves.
 *
 * Markers arrive whenever you cut them — from a scrape, or in Stash itself —
 * and a clip only exists because something rendered it. Left to
 * a button, the reel quietly degrades to Stash's 640x360 for everything new
 * and nobody notices until they look closely.
 *
 * So this checks on the hour: any marker without a clip gets one. It is
 * incremental and skips what already exists, so the usual answer is that there
 * is nothing to do and it costs one GraphQL query.
 */
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

  /*
   * Not at boot. A restart in the middle of an import would set a two-hour
   * encode going against a library that is still moving, and the first thing
   * anyone does after a restart is look at the reel.
   */
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
