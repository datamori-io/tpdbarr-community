/*
 * Filling in what is already answerable, without asking anybody.
 *
 * Every other way this portal writes metadata involves a person: the Match
 * page asks the sources and you tick what is right, the marker bench and its
 * fetch panel show you what came back before anything lands. That is correct
 * for a scene nobody has identified — a title that matches is a guess, and a
 * guess written unattended is a wrong studio you find six months later.
 *
 * **This is the other case, and it involves no guessing at all.** A scene that
 * already carries a stash id has been identified: by Stash's own Identify, by
 * the Match page, by a scraper that got it right. The id names one scene on one
 * box. Asking that box for that id is not matching, it is reading — so it can
 * be done to two thousand scenes at once with nobody watching.
 *
 * Which is why the rule here is narrow and absolute: **no scene without an id
 * is touched**, and nothing is ever searched for by title.
 *
 * Two passes, and they share that rule:
 *
 *   facts       StashDB first, ThePornDB for whatever is still blank
 *   timestamps  timestamp.trade first, ThePornDB second
 *
 * The order is not arbitrary in either case. StashDB is the better-curated of
 * the two and is what the library is measured against; timestamp.trade is the
 * primary marker source in this library and TPDB the backup — the same order the
 * two Stash plugins are run in, for the reasons in stash-scene-markers.
 *
 * **Only blanks are filled.** A scene that already has a title keeps it, even
 * if StashDB disagrees. This is a catch-up, not a re-identification, and a job
 * that quietly rewrote fields somebody had corrected by hand would be the last
 * time anybody pressed it.
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

/*
 * Between one outside request and the next. These are somebody else's servers
 * and this asks them thousands of times in a row — the marker plugins and the
 * Match page's Search All both take the same care, and for the same reason: a
 * burst is how an account stops working for the rest of the afternoon.
 */
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

/*
 * What is missing from a scene, as a list of field names.
 *
 * Deliberately short. A description or a tag list is not a gap — plenty of
 * scenes never had either and nobody is looking at this page because of it.
 * These four are what make a scene findable and recognisable everywhere else
 * in the portal.
 */
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

/*
 * -> what a run would look at, without doing any of it.
 *
 * Read before the button is pressed, so it can say what it is about to do
 * rather than starting and reporting afterwards. It is one Stash query and no
 * outside requests at all.
 */
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

/*
 * A name back into a Stash id, and never by creating one.
 *
 * The same rule the Match page applies to a hand-picked match, applied here
 * for a stronger reason: this runs unattended over hundreds of scenes, and a
 * pass that created studios and performers from two sources' spellings would
 * leave a library with "Brazzers" and "Brazzers " in it by morning. What could
 * not be attached is counted and reported instead.
 */
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

/*
 * One scene's facts, from whichever source can answer for the blanks.
 *
 * -> the fields that were filled, so the run can report in numbers rather than
 * in a claim. An empty list is the ordinary outcome and not a failure: the
 * commonest reason a scene has no studio is that neither box knows one either.
 */
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

  // ThePornDB for whatever is still blank. On this library it does most of the
  // work despite being second: of the scenes with a gap and an id, the great
  // majority carry a TPDB id and no StashDB one.
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

/*
 * One scene's markers, and only onto a scene that has none.
 *
 * The same rule the TPDB plugin is configured with, and for the reason in
 * stash-scene-markers: an incoming marker within fifteen seconds of an
 * existing one gets *rewritten in place* by the plugins, and while nothing
 * here does that, a scene that already has markers is one where the question
 * is which of two sets to keep. That is a decision, and decisions belong on
 * the bench — the fetch panel there exists for exactly it.
 */
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
