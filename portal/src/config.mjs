import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  whisparrUrl: '',
  apiKey: '',
  qualityProfileId: 0,
  rootFolderPath: '',
  searchOnAdd: true,
  stashUrl: '',
  stashApiKey: '',
  /*
   * Whisparr v3 (Eros), which takes StashDB scenes. It runs alongside v2 rather
   * than replacing it: v2 is the only one that accepts TPDB, v3 is the only one
   * that accepts StashDB, and most of the library came from v3. Its own quality
   * profile and root folder, because the two instances must never be pointed at
   * the same folder.
   */
  whisparr3Url: '',
  whisparr3ApiKey: '',
  whisparr3QualityProfileId: 0,
  whisparr3RootFolderPath: '',
  /*
   * TMDB, the second source for films. Unlike the TPDB token there is nothing
   * on this machine to borrow one from, so it is asked for. Only the movie
   * gap-filler uses it.
   */
  tmdbApiKey: '',
  /*
   * Where a built gallery lands. One folder, two paths, because two containers
   * see it: the portal writes the files at `galleryPath`, Stash scans them at
   * `galleryStashPath`, and neither can use the other's. Getting them the wrong
   * way round is the one mistake this feature can make, so the setup check
   * reports both back rather than assuming they agree.
   */
  galleryPath: '/galleries',
  galleryStashPath: '/data/galleries',
  /*
   * FileFlows, the encoder in the middle of the pipeline — the one step of the
   * chain the portal has never been able to see. Optional: with no URL the
   * Integrations page says "not set up" rather than showing it as down.
   */
  fileflowsUrl: '',
  fileflowsApiKey: '',
  /*
   * Prowlarr, for searching the indexers by hand when neither catalogue knows
   * a scene. Optional; the same one Whisparr v3's indexers are synced from.
   */
  prowlarrUrl: '',
  prowlarrApiKey: '',
  /*
   * The NZBGet on this machine, for a usenet release picked from Prowlarr.
   * Its own category, so Whisparr does not try to import what it never asked
   * for.
   */
  nzbgetUrl: '',
  nzbgetUsername: '',
  nzbgetPassword: '',
  nzbgetCategory: 'Manual',
  /*
   * The studios and performers the acquisition search measures you against.
   *
   * A percentage is only meaningful against a catalogue somebody chose — done
   * automatically it would be a number about how complete StashDB is, and it
   * would cost a full catalogue read per studio on every page load. So this is
   * a list you keep, and nothing outside it is measured.
   *
   * {studios: [{kind, id, name, image, scope}], performers: [same]}, where a
   * studio scope of "network" measures everything under that parent studio.
   *
   * `scenes` is a different thing wearing the same coat: not something measured
   * but a want list, one entry per StashDB scene you have marked. It lives here
   * rather than in Whisparr for the reason in discover.mjs — Whisparr fetches
   * files, it does not remember what you meant to get.
   */
  tracked: { studios: [], performers: [], scenes: [], tags: [] },
  /*
   * Standing answers for the decide queue — the noes you would have given
   * anyway, given once. See rules.mjs. They hide rather than skip, so this
   * list is the whole of their state and deleting one puts everything it was
   * holding back straight back in the queue.
   */
  decideRules: [],
  // Advanced each time the home page is rebuilt; drives "since your last visit".
  lastSeenAt: '',
  /*
   * Thumbnail size per page, {"<route key>": "s"|"m"|"l"|"xl"}. Kept here
   * rather than in the browser so the choice survives a different device —
   * this portal is used from more than one.
   */
  tileScale: {},
  /*
   * What the reel was left set to. Its settings are a sitting rather than a
   * place — the framing, whether it rolls, the mix, which feed — and having to
   * set them again every visit is the kind of small friction that makes a page
   * feel like it is not listening.
   *
   * Here rather than in the browser for the same reason as tileScale: this
   * portal gets used from more than one machine, and "how I like the reel" does
   * not change between them.
   *
   * The address still wins. A link with settings in it is somebody being
   * specific, and that must not be overwritten by what was left last time.
   */
  reel: {},
  /*
   * The nightly release — see release.mjs.
   *
   * The want list is 2,300 scenes long and sending it to Whisparr in one go is
   * not a plan, it is a denial of service against your own indexers. So a
   * handful go out a night and the rest wait their turn.
   *
   * {on, perDay, hour, lastRun: 'YYYY-MM-DD', lastSent: n}. `lastRun` is a
   * local date rather than a timestamp, because "has today's gone out yet" is
   * the only question asked of it and a restart must not re-answer it.
   */
  release: { on: true, perDay: 10, hour: 3, lastRun: '', lastSent: 0 },
  /*
   * Cut a frame for a scene that has no cover — everywhere, not just on the
   * two pages that grew the habit.
   *
   * Match and Wild Card have always done this, because a pile of rows with no
   * pictures cannot be worked through. But a scene with no cover is invisible
   * on every shelf in the portal too, and the answer that worked on those two
   * pages is the same answer here — so it is a setting rather than a thing two
   * pages happen to do.
   *
   * On by default, which is what those pages were already doing. Turning it off
   * gives you Stash's own answer everywhere: the real cover where there is one,
   * its placeholder where there is not.
   *
   * Only ever for what has nothing. A scene Stash holds a cover for is never
   * re-cut by this — the setting decides what happens in the gap, and nowhere
   * else. (The double-click on a match row is the separate escape hatch, for a
   * cover that exists and is useless.)
   *
   * And still only for looking. Nothing this cuts is written back to Stash; the
   * Generate button on the row is what asks Stash to make its own.
   */
  cutThumbs: true,
};

// Fields never sent to the browser.
const SECRETS = ['apiKey', 'stashApiKey', 'whisparr3ApiKey', 'tmdbApiKey', 'fileflowsApiKey', 'prowlarrApiKey', 'nzbgetPassword'];

let cache = null;

export async function loadConfig() {
  if (cache) return cache;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

// Catches the easy mistakes before they turn into an opaque 401.
export function validate(patch) {
  const problems = [];

  for (const [field, label] of [
    ['apiKey', 'Whisparr v2 API key'],
    ['stashApiKey', 'Stash API key'],
    ['whisparr3ApiKey', 'Whisparr v3 API key'],
    ['prowlarrApiKey', 'Prowlarr API key'],
  ]) {
    const value = patch[field];
    if (!value) continue;
    if (/^https?:\/\//i.test(value)) problems.push(`${label} looks like a URL — it belongs in the URL field above.`);
    else if (/\s/.test(value)) problems.push(`${label} contains a space.`);
  }

  for (const [field, label] of [
    ['whisparrUrl', 'Whisparr v2 URL'],
    ['stashUrl', 'Stash URL'],
    ['whisparr3Url', 'Whisparr v3 URL'],
    ['fileflowsUrl', 'FileFlows URL'],
    ['prowlarrUrl', 'Prowlarr URL'],
    ['nzbgetUrl', 'NZBGet URL'],
  ]) {
    const value = patch[field];
    if (value && !/^https?:\/\//i.test(value)) problems.push(`${label} must start with http:// or https://`);
  }

  // A Whisparr key is 32 hex characters. Warn rather than reject, in case that
  // ever changes.
  for (const [field, label] of [['apiKey', 'Whisparr v2'], ['whisparr3ApiKey', 'Whisparr v3'], ['prowlarrApiKey', 'Prowlarr']]) {
    if (patch[field] && !/^[a-f0-9]{32}$/i.test(patch[field])) {
      problems.push(`${label} API key is not the usual 32 hex characters — check you copied the whole thing.`);
    }
  }

  // Both halves of the gallery folder are absolute paths inside a container,
  // never a Windows path off the host — that is the mistake worth catching.
  for (const [field, label] of [
    ['galleryPath', 'Gallery folder (portal)'],
    ['galleryStashPath', 'Gallery folder (Stash)'],
  ]) {
    const value = patch[field];
    if (value && !value.startsWith('/')) {
      problems.push(`${label} must be an absolute path inside the container, like /galleries.`);
    }
  }

  // Two instances sharing a root folder will fight over the same file.
  if (patch.rootFolderPath && patch.whisparr3RootFolderPath && patch.rootFolderPath === patch.whisparr3RootFolderPath) {
    problems.push('v2 and v3 are pointed at the same root folder. Give them separate ones or they will fight over files.');
  }

  return problems;
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = { ...current };

  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in patch)) continue;
    // An unchanged secret arrives as the empty string; keep what we have.
    if (SECRETS.includes(key) && patch[key] === '') continue;
    next[key] = patch[key];
  }

  next.qualityProfileId = Number(next.qualityProfileId) || 0;
  next.whisparr3QualityProfileId = Number(next.whisparr3QualityProfileId) || 0;
  next.searchOnAdd = Boolean(next.searchOnAdd);

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  cache = next;

  /*
   * Every change to this file is a decision that cannot be recomputed — a
   * tracked studio, an ignored scene, a scene put on the want list. The backup
   * decides for itself whether enough time has passed to be worth a copy, so
   * this can be called on every save without taking six hundred of them.
   *
   * Imported here rather than at the top: config.mjs is imported by almost
   * everything, and backup.mjs imports nothing that would come back round.
   */
  const { changed } = await import('./backup.mjs');
  changed('config saved');

  return next;
}

// Safe to hand to the browser: secrets become a boolean "is it set".
export function publicConfig(config) {
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = SECRETS.includes(key) ? undefined : value;
    if (SECRETS.includes(key)) out[key + 'Set'] = Boolean(value);
  }
  return out;
}

/*
 * What the portal needs before it has anything to show you. That is Stash: the
 * library of record, and where everything you watch comes from. A Whisparr is
 * how new files arrive, which is a separate question and a later one — the
 * portal is perfectly usable with a library and no downloader attached.
 */
export function isConfigured(config) {
  return Boolean(config.stashUrl);
}

// What Whisparr v2 needs before it can be asked to add anything.
export function whisparr2Configured(config) {
  return Boolean(config.whisparrUrl && config.apiKey && config.rootFolderPath && config.qualityProfileId);
}

// A Stash with no API key set serves GraphQL openly, so the key is optional.
export function stashConfigured(config) {
  return Boolean(config.stashUrl);
}

/*
 * v3 is optional and is asked about separately: plenty of the library came from
 * it, but you can run this portal against v2 alone. Reachable is enough for
 * reading status; adding also needs a profile and a folder.
 */
export function whisparr3Reachable(config) {
  return Boolean(config.whisparr3Url && config.whisparr3ApiKey);
}

export function whisparr3Configured(config) {
  return Boolean(whisparr3Reachable(config) && config.whisparr3RootFolderPath && config.whisparr3QualityProfileId);
}
