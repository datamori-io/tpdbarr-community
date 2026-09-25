/*
 * Fetch a scene's timestamps from timestamp.trade and ThePornDB, the same
 * sources the plugins use, without writing. The page shows what came back
 * and what it would collide with. Both fail soft with a short timeout.
 * Ends are kept (the plugins drop them).
 */

import { gql, tpdbToken } from './stash.mjs';

/*
 * Must match exactly: TPDB stash_ids are filed under `?type=Scene`. The
 * bare endpoint matches nothing, silently.
 */
const TPDB_ENDPOINT = 'https://theporndb.net/graphql?type=Scene';
const STASHDB = /stashdb\.org/i;

const TRADE = 'https://timestamp.trade/get-markers/';
const TPDB = 'https://api.theporndb.net/scenes/';

// Somebody else's server, on a page that is waiting. Long enough for a slow
// answer, short enough that a dead source does not hold the panel open.
const TIMEOUT = 12000;

const asJson = async (url, headers = {}) => {
  const stop = AbortSignal.timeout(TIMEOUT);
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: stop });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

/* Tenths. An end not after the start becomes null. */
const at = (n) => Math.max(0, Math.round((Number(n) || 0) * 10) / 10);

const cut = (start, end) => {
  const seconds = at(start);
  const out = end == null ? null : at(end);
  return { seconds, end: out != null && out > seconds ? out : null };
};

/* ------------------------------------------------------- timestamp.trade */

/*
 * One GET by StashDB id. `marker[]` (singular) of `{name, tag, start, end}`
 * in milliseconds. Unknown ids return 200 with an empty object.
 */
async function fromTrade(stashId) {
  const data = await asJson(TRADE + stashId);
  const rows = Array.isArray(data?.marker) ? data.marker : [];

  return {
    scene: data?.scene_id ? `https://timestamp.trade/scene/${data.scene_id}` : null,
    title: data?.title || '',
    markers: rows.map((m) => ({
      ...cut((m.start || 0) / 1000, m.end == null ? null : m.end / 1000),
      // Prefer `tag` over `name`.
      tag: String(m.tag || m.name || '').trim(),
      name: String(m.name || m.tag || '').trim(),
    })),
  };
}

/* ------------------------------------------------------------------ TPDB */

/*
 * TPDB REST, with the token from Stash. `data.markers[]` of
 * `{title, start_time, end_time}` in seconds; the title is the tag.
 */
async function fromTpdb(config, stashId) {
  const key = await tpdbToken(config);
  if (!key) throw new Error('Stash has no ThePornDB token to borrow.');

  const data = await asJson(TPDB + stashId, { Authorization: `Bearer ${key}` });
  const rows = Array.isArray(data?.data?.markers) ? data.data.markers : [];

  return {
    scene: `https://theporndb.net/scenes/${stashId}`,
    title: data?.data?.title || '',
    markers: rows.map((m) => ({
      ...cut(m.start_time, m.end_time),
      tag: String(m.title || '').trim(),
      name: String(m.title || '').trim(),
    })),
  };
}

/* --------------------------------------------------------------- the ask */

const IDS = `id title stash_ids { endpoint stash_id } scene_markers { id title seconds end_seconds primary_tag { id name } }`;

/* Both sources for one scene, together. A missing id is reported, since it's fixable. */
export async function fetched(config, sceneId) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${IDS} } }`, { id: String(sceneId) });
  const scene = data.findScene;
  if (!scene) {
    const err = new Error('Stash has no scene with that id.');
    err.status = 404;
    throw err;
  }

  const ids = scene.stash_ids || [];
  const stashdb = ids.find((s) => STASHDB.test(s.endpoint || ''))?.stash_id || null;
  const tpdb = ids.find((s) => s.endpoint === TPDB_ENDPOINT)?.stash_id || null;

  const ask = async (key, name, id, missing, run) => {
    if (!id) return { key, name, ok: false, reason: missing, markers: [] };
    try {
      const found = await run();
      return {
        key,
        name,
        ok: true,
        reason: found.markers.length ? '' : 'Knows the scene, has no timestamps on it.',
        ...found,
      };
    } catch (err) {
      return { key, name, ok: false, reason: err.message, markers: [] };
    }
  };

  const sources = await Promise.all([
    ask('tstrade', 'timestamp.trade', stashdb,
      'This scene has no StashDB id — timestamp.trade is keyed on one.',
      () => fromTrade(stashdb)),
    ask('tpdb', 'ThePornDB', tpdb,
      'This scene has no ThePornDB id.',
      () => fromTpdb(config, tpdb)),
  ]);

  return {
    scene: { id: scene.id, title: scene.title || '' },
    /* Current markers, so the page can show collisions. */
    have: (scene.scene_markers || []).map((m) => ({
      id: m.id,
      title: m.title || '',
      tag: m.primary_tag ? { id: m.primary_tag.id, name: m.primary_tag.name } : null,
      seconds: Number(m.seconds) || 0,
      end: Number(m.end_seconds) > Number(m.seconds) ? Number(m.end_seconds) : null,
    })).sort((a, b) => a.seconds - b.seconds),
    sources,
  };
}
