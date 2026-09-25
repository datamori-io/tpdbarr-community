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
   * Whisparr v3, for StashDB scenes; runs alongside v2 (TPDB). Its own
   * profile and root folder — never share a folder with v2.
   */
  whisparr3Url: '',
  whisparr3ApiKey: '',
  whisparr3QualityProfileId: 0,
  whisparr3RootFolderPath: '',
  /* TMDB key, for the movie gap-filler. Nothing to borrow it from. */
  tmdbApiKey: '',
  /*
   * One folder, two paths: the portal writes at `galleryPath`, Stash scans at
   * `galleryStashPath`. The setup check reports both.
   */
  galleryPath: '/galleries',
  galleryStashPath: '/data/galleries',
  /* FileFlows. Optional; no URL means "not set up", not down. */
  fileflowsUrl: '',
  fileflowsApiKey: '',
  /* Prowlarr, for hand searches. Optional. */
  prowlarrUrl: '',
  prowlarrApiKey: '',
  /* NZBGet, for usenet grabs from Prowlarr. Its own category, so Whisparr ignores them. */
  nzbgetUrl: '',
  nzbgetUsername: '',
  nzbgetPassword: '',
  nzbgetCategory: 'Manual',
  /*
   * Tracked catalogues, measured for coverage:
   * {studios: [{kind, id, name, image, scope}], performers: [same]}.
   * Scope "network" measures everything under a parent studio.
   * `scenes` is the want list, one per StashDB scene (see discover.mjs).
   */
  tracked: { studios: [], performers: [], scenes: [], tags: [] },
  /*
   * Standing noes for the decide queue (rules.mjs). They hide, so deleting
   * one brings its scenes back.
   */
  decideRules: [],
  // Advanced each time the home page is rebuilt; drives "since your last visit".
  lastSeenAt: '',
  /*
   * Thumbnail size per page, {"<route key>": "s"|"m"|"l"|"xl"}. Server-side
   * so it follows you across devices.
   */
  tileScale: {},
  /* The reel's settings, server-side like tileScale. A URL's settings still win. */
  reel: {},
  /*
   * The nightly release (release.mjs): a few want-list scenes a night.
   * {on, perDay, hour, lastRun: 'YYYY-MM-DD', lastSent: n}. `lastRun` is a
   * local date so a restart can't send twice.
   */
  release: { on: true, perDay: 10, hour: 3, lastRun: '', lastSent: 0 },
  /*
   * Cut a frame for scenes with no cover, everywhere. Off shows Stash's own
   * answer. Never re-cuts a real cover, never written back to Stash.
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
   * Back up on change; backup.mjs decides if it's worth a copy. Imported
   * lazily to avoid a cycle.
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

/* Configured means Stash is set. A Whisparr is optional. */
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

/* v3 is optional. Reachable is enough to read; adding needs profile and folder. */
export function whisparr3Reachable(config) {
  return Boolean(config.whisparr3Url && config.whisparr3ApiKey);
}

export function whisparr3Configured(config) {
  return Boolean(whisparr3Reachable(config) && config.whisparr3RootFolderPath && config.whisparr3QualityProfileId);
}
