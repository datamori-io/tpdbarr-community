/*
 * Catch-up: fill blanks on scenes that already have a stash id, by
 * reading that id from its source. No scene without an id is touched and
 * nothing is searched by title, so it can run unattended.
 *
 *   facts       StashDB first, ThePornDB for what's still blank
 *   timestamps  timestamp.trade first, ThePornDB second
 *
 * Only blanks are filled.
 */

import { gql } from './stash.mjs';
import * as stashdb from './stashdb.mjs';
import * as tpdb from './tpdb.mjs';
import * as markersources from './markersources.mjs';
import * as markerbuilder from './markerbuilder.mjs';
import { stashConfigured } from './config.mjs';

const FILED = '/organized_scenes/';

const STASHDB = /stashdb\.org/i;
// Exactly this, and the trap is written up in markersources.mjs: Stash also
// holds ?type=Movie, ?type=JAV and a bare one sharing the same token.
const TPDB_ENDPOINT = 'https://theporndb.net/graphql?type=Scene';

/* Pause between outside requests. */
const BREATH = 600;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/* --------------------------------------------------------------- the work */

const SCENES = `
  id title date details
  organized
  files { path }
  studio { id name }
  performers { id name }
  tags { id name }
  paths { screenshot }
  stash_ids { endpoint stash_id }
  scene_markers { id }
`;

const filed = (scene) => (scene.files || []).some((f) => String(f?.path || '').includes(FILED));

const idFor = (scene, which) => {
  const hit = (scene.stash_ids || []).find((s) => (which === 'stashdb'
    ? STASHDB.test(s.endpoint || '')
    : s.endpoint === TPDB_ENDPOINT));
  // A "0" is a scraper's placeholder for a site that is not a box at all, and
  // there is nothing behind it to ask. See matchsort.mjs.
  return hit && hit.stash_id && String(hit.stash_id) !== '0' ? hit.stash_id : null;
};

/* Missing fields, as names. Only the four that make a scene findable. */
function gapsIn(scene) {
  const gaps = [];
  if (!scene.title) gaps.push('title');
  if (!scene.date) gaps.push('date');
  if (!scene.studio) gaps.push('studio');
  if (!(scene.performers || []).length) gaps.push('performers');
  return gaps;
}

async function allScenes(config) {
  const data = await gql(config, `{ findScenes(filter: {per_page: -1}) { scenes { ${SCENES} } } }`);
  return (data.findScenes?.scenes || []).filter(filed);
}

/* -> what a run would look at. One Stash query, nothing outside. */
export async function scope(config) {
  if (!stashConfigured(config)) return { ready: false, filed: 0, facts: 0, timestamps: 0, stranded: 0 };

  const scenes = await allScenes(config);

  let facts = 0;
  let stranded = 0;
  let timestamps = 0;

  for (const scene of scenes) {
    const has = idFor(scene, 'stashdb') || idFor(scene, 'tpdb');
    if (gapsIn(scene).length) {
      if (has) facts += 1;
      // A gap nothing can fill, because there is no id to ask about. The Match
      // page is where those get one; this pass cannot help them and says so.
      else stranded += 1;
    }
    if (has && !(scene.scene_markers || []).length) timestamps += 1;
  }

  return { ready: true, filed: scenes.length, facts, timestamps, stranded };
}

/* ------------------------------------------------------------- the writes */

/* A name -> Stash id. Never creates; misses are counted and reported. */
async function findByName(config, kind, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  const query = kind === 'studio'
    ? `query($n: String!) { findStudios(studio_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 5}) { studios { id name } } }`
    : `query($n: String!) { findPerformers(performer_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 5}) { performers { id name } } }`;

  const data = await gql(config, query, { n: clean }).catch(() => null);
  const list = kind === 'studio' ? data?.findStudios?.studios : data?.findPerformers?.performers;
  const hit = (list || []).find((e) => e.name.toLowerCase() === clean.toLowerCase());
  return hit ? hit.id : null;
}

/* One scene's facts. -> the fields filled (often none). */
async function fillFacts(config, scene, held) {
  const gaps = gapsIn(scene);
  if (!gaps.length) return [];

  const input = { id: scene.id };
  const filled = [];
  const missed = [];

  const take = async (card) => {
    if (!card) return;

    if (gaps.includes('title') && !input.title && card.title) {
      input.title = card.title;
      filled.push('title');
    }
    if (gaps.includes('date') && !input.date && card.date) {
      input.date = card.date;
      filled.push('date');
    }

    if (gaps.includes('studio') && !input.studio_id) {
      const name = card.studio?.name || card.studioName;
      const id = name ? await findByName(config, 'studio', name) : null;
      if (id) { input.studio_id = id; filled.push('studio'); }
      else if (name) missed.push(`studio ${name}`);
    }

    if (gaps.includes('performers') && !input.performer_ids) {
      const names = (card.performers || []).map((p) => p.name).filter(Boolean);
      const ids = [];
      for (const name of names) {
        const id = await findByName(config, 'performer', name);
        if (id) ids.push(id);
        else missed.push(`performer ${name}`);
      }
      if (ids.length) { input.performer_ids = ids; filled.push('performers'); }
    }
  };

  // StashDB first, and only asked for what it has an id for.
  const sdb = idFor(scene, 'stashdb');
  if (sdb) {
    await take(await stashdb.getScene(config, sdb).catch(() => null));
    await wait(BREATH);
  }

  // Then ThePornDB for what's still blank.
  const tp = idFor(scene, 'tpdb');
  if (tp && filled.length < gaps.length) {
    await take(await tpdb.getScene(config, tp).catch(() => null));
    await wait(BREATH);
  }

  if (!filled.length) return { filled: [], missed };

  await gql(
    config,
    `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
    { input }
  );

  held.missed.push(...missed);
  return { filled, missed };
}

/* Markers only onto a scene with none. Merging two sets is a decision for the bench. */
async function fillTimestamps(config, scene) {
  const found = await markersources.fetched(config, scene.id).catch(() => null);
  if (!found) return 0;

  const bySource = new Map((found.sources || []).map((s) => [s.key, s]));

  // timestamp.trade first. The order is the house's, not a preference.
  const rows = bySource.get('tstrade')?.markers?.length
    ? { key: 'tstrade', sign: '[TsTrade]', markers: bySource.get('tstrade').markers }
    : bySource.get('tpdb')?.markers?.length
      ? { key: 'tpdb', sign: '[TPDBMarker]', markers: bySource.get('tpdb').markers }
      : null;

  if (!rows) return 0;

  let made = 0;
  for (const marker of rows.markers) {
    try {
      await markerbuilder.create(config, {
        sceneId: scene.id,
        seconds: marker.seconds,
        end: marker.end,
        tagName: marker.tag,
        // Signed the way the plugins sign theirs, because it is the same
        // source and one convention beats two.
        title: `${rows.sign} ${marker.name || marker.tag}`.trim(),
      });
      made += 1;
    } catch {
      // One marker Stash would not take is not a reason to abandon the rest.
    }
  }

  return made;
}

/* --------------------------------------------------------------- the run */

let running = null;
let stopping = false;

let job = {
  running: false,
  step: '',
  done: 0,
  total: 0,
  facts: 0,
  fields: 0,
  markers: 0,
  scenes: 0,
  missed: [],
  error: null,
  at: 0,
};

export const busy = () => Boolean(running);
export const status = () => ({ ...job, running: busy(), stopping });

export function stop() {
  if (running) stopping = true;
  return status();
}

async function run(config) {
  const scenes = await allScenes(config);
  const held = { missed: [] };

  const needFacts = scenes.filter((s) => gapsIn(s).length && (idFor(s, 'stashdb') || idFor(s, 'tpdb')));
  const needMarks = scenes.filter((s) => !(s.scene_markers || []).length && (idFor(s, 'stashdb') || idFor(s, 'tpdb')));

  job = { ...job, step: 'facts', done: 0, total: needFacts.length + needMarks.length, at: Date.now() };

  for (const scene of needFacts) {
    if (stopping) break;
    try {
      const out = await fillFacts(config, scene, held);
      if (out.filled?.length) { job.facts += 1; job.fields += out.filled.length; }
    } catch (err) {
      console.warn('[tpdbarr] catch-up facts', scene.id, err.message);
    }
    job.done += 1;
    job.at = Date.now();
  }

  job.step = 'timestamps';

  for (const scene of needMarks) {
    if (stopping) break;
    try {
      const made = await fillTimestamps(config, scene);
      if (made) { job.scenes += 1; job.markers += made; }
    } catch (err) {
      console.warn('[tpdbarr] catch-up timestamps', scene.id, err.message);
    }
    job.done += 1;
    job.at = Date.now();
    await wait(BREATH);
  }

  // Only the distinct ones, and only a few: this is a hint about what to go
  // and create by hand, not a log.
  job.missed = [...new Set(held.missed)].slice(0, 40);
  job.step = stopping ? 'stopped' : 'done';
  return job;
}

export function start(config) {
  if (running) return status();
  if (!stashConfigured(config)) throw new Error('This reads and writes your Stash library. Connect it in Settings.');

  stopping = false;
  job = {
    running: true,
    step: 'starting',
    done: 0,
    total: 0,
    facts: 0,
    fields: 0,
    markers: 0,
    scenes: 0,
    missed: [],
    error: null,
    at: Date.now(),
  };

  running = run(config)
    .catch((err) => {
      console.error('[tpdbarr] catch-up', err.message);
      job.error = err.message;
      job.step = 'failed';
    })
    .finally(() => {
      running = null;
      stopping = false;
      job.running = false;
      job.at = Date.now();
    });

  return status();
}
