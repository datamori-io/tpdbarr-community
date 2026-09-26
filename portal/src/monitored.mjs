/*
 * What both Whisparrs are still looking for, to search by hand. Each row
 * gets a query for the Indexers band: squashed studio plus first performer
 * (finds releases a dated query misses). v3 has no cast, so StashDB is
 * read in batches, cached.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { stashConfigured } from './config.mjs';
import * as stash from './stash.mjs';
import * as stashdb from './stashdb.mjs';
import * as whisparr from './whisparr.mjs';
import * as whisparr3 from './whisparr3.mjs';

const TTL = 10 * 60 * 1000;
const cache = { v3: null, v2: null };
// Something was just sent to a Whisparr, so its wanted list has changed.
export const forget = () => { cache.v3 = null; cache.v2 = null; };

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const GRABBED_PATH = join(CONFIG_DIR, 'monitored-grabs.json');

const squash = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');

// Women first: release names lead with them far more often than not.
const lead = (performers) => {
  const women = performers.filter((p) => p.gender === 'FEMALE' || p.gender === 'TRANSGENDER_FEMALE');
  return (women[0] || performers[0])?.name || '';
};

const queryFor = (studio, performers, title) => {
  const who = lead(performers);
  return [squash(studio), who || String(title || '').split(/\s+/).slice(0, 4).join(' ')].filter(Boolean).join(' ');
};

async function fromV3(config) {
  const movies = (await whisparr3.allMovies(config, { force: true })).filter((m) => m.monitored && !m.hasFile);

  let cast = new Map();
  const ids = movies.map((m) => m.stashId).filter(Boolean);
  if (ids.length && (await stashdb.available(config).catch(() => false))) {
    cast = await stashdb.scenesByIds(config, ids).catch(() => new Map());
  }

  return movies.map((m) => {
    const card = m.stashId ? cast.get(m.stashId) : null;
    const performers = (card?.performers || []).map((p) => ({ name: p.name, gender: p.gender }));
    const studio = m.studioTitle || card?.studioName || '';
    return {
      from: 'v3',
      id: m.id,
      stashId: m.stashId || null,
      title: card?.title || m.title || '',
      studio,
      date: (m.releaseDate || card?.date || '').slice(0, 10),
      performers: performers.map((p) => p.name),
      added: m.added || null,
      lastSearch: m.lastSearchTime || null,
      query: queryFor(studio, performers, card?.title || m.title),
    };
  });
}

async function fromV2(config) {
  const episodes = await whisparr.wantedMissing(config);
  return episodes.map((e) => {
    const performers = (e.actors || []).map((a) => ({ name: a.name || a.character || '', gender: a.gender || null }))
      .filter((p) => p.name);
    const studio = e.series?.title || '';
    return {
      from: 'v2',
      id: e.id,
      stashId: null,
      title: e.title || '',
      studio,
      date: String(e.releaseDate || e.airDate || '').slice(0, 10),
      performers: performers.map((p) => p.name),
      added: null,
      lastSearch: e.lastSearchTime || null,
      // v2's actors carry no gender, so the first one listed leads.
      query: [squash(studio), performers[0]?.name || String(e.title || '').split(/\s+/).slice(0, 4).join(' ')].filter(Boolean).join(' '),
    };
  });
}

/*
 * Checked against Stash on every request: Whisparr isn't told when a scene
 * is filed, so held scenes are dropped. Also marks what's downloading and
 * what was already hand-grabbed from this list.
 */
async function annotate(config, key, rows, { force = false } = {}) {
  const [owned, titles, queued, grabbed] = await Promise.all([
    key === 'v3' && stashConfigured(config)
      ? stash.stashdbEndpoint(config)
        .then((endpoint) => stash.ownedByStashIds(config, endpoint, rows.map((r) => r.stashId).filter(Boolean)))
        .catch(() => new Map())
      : Promise.resolve(new Map()),
    stashConfigured(config) ? stash.titleDateIndex(config, { force }).catch(() => null) : Promise.resolve(null),
    inQueue(config, key),
    readGrabs(),
  ]);

  const missing = [];
  const held = [];
  for (const r of rows) {
    const exact = r.stashId ? owned.get(r.stashId.toLowerCase()) : null;
    const probable = exact ? null : stash.matchByTitleDate(titles, r);
    const hit = exact || probable;
    if (hit) {
      held.push({ ...r, stash: { id: hit.id, path: hit.path || null, match: exact ? 'exact' : 'probable' } });
      continue;
    }
    missing.push({
      ...r,
      downloading: queued.has(r.id),
      grabbed: grabbed[key + ':' + r.id] || null,
    });
  }
  return { rows: missing, held, stashChecked: stashConfigured(config) && titles !== null };
}

async function inQueue(config, key) {
  try {
    const out = key === 'v2' ? await whisparr.queue(config) : await whisparr3.queue(config);
    const records = out?.records || [];
    return new Set(records.map((q) => (key === 'v2' ? q.episodeId : q.movieId)).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function list(config, from = 'v3', { force = false } = {}) {
  const key = from === 'v2' ? 'v2' : 'v3';
  let held = cache[key];
  if (force || !held || Date.now() - held.at >= TTL) {
    const rows = key === 'v2' ? await fromV2(config) : await fromV3(config);
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    held = cache[key] = { rows, at: Date.now() };
  }
  return { from: key, at: held.at, ...(await annotate(config, key, held.rows, { force })) };
}

/* Hand grabs from this list, keyed "<v2|v3>:<whisparr id>". */
async function readGrabs() {
  try {
    return JSON.parse(await readFile(GRABBED_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function noteGrab({ from, id }, { title = '', to = '' } = {}) {
  const key = (from === 'v2' ? 'v2' : 'v3') + ':' + Number(id);
  if (!Number(id)) return;
  const all = await readGrabs();
  all[key] = { at: new Date().toISOString(), title, to };
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = GRABBED_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(all, null, 2));
  await rename(tmp, GRABBED_PATH);
}
