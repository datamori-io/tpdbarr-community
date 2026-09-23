/*
 * Where a scene's timestamps can be fetched from, without a plugin.
 *
 * Two outside sources, and they are the same two the Stash plugins use —
 * timestamp.trade first, ThePornDB second. What is different is what happens
 * to the answer. The plugins hand it to `import_scene_markers(..., 15)`, which
 * *updates an existing marker in place* whenever exactly one sits within
 * fifteen seconds, and that is how 156 timestamp.trade markers in this library
 * were retimed and retitled in a single unattended pass. Nothing here writes
 * anything. It fetches, says what it found and what that would collide with,
 * and the page decides — which is the whole reason for it existing.
 *
 * Both are read-only GETs against somebody else's server, so both are given a
 * short timeout and both fail soft: a source that is down, rate-limiting, or
 * simply has never heard of the scene is a source that says so, not an error
 * that takes the other one with it.
 *
 * One thing the plugins throw away and this does not: both sources carry an
 * end as well as a start. The plugins keep only `seconds`, so every marker
 * either of them has ever written into this library is a point. The bench does
 * spans, so the ends come through.
 */

import { gql, tpdbToken } from './stash.mjs';

/*
 * The endpoint string has to match exactly.
 *
 * A scene's TPDB stash_id is filed under `.../graphql?type=Scene`, not under
 * the bare `.../graphql` — and Stash also holds ?type=Movie and ?type=JAV
 * boxes with the same token. Comparing against the bare endpoint is what made
 * the TPDBMarkers plugin select zero scenes and report success, which is the
 * failure mode to watch for: this is a match that goes quietly wrong rather
 * than loudly.
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

/*
 * Tenths, and never a zero-length span.
 *
 * Both sources carry ends, and both of them sometimes carry an end that is the
 * same as or before the start — a marker somebody saved without moving the
 * out point. Stash stores 0 for "no end", so an end that is not genuinely
 * after the start has to become null here rather than being passed on as a
 * span that draws backwards.
 */
const at = (n) => Math.max(0, Math.round((Number(n) || 0) * 10) / 10);

const cut = (start, end) => {
  const seconds = at(start);
  const out = end == null ? null : at(end);
  return { seconds, end: out != null && out > seconds ? out : null };
};

/* ------------------------------------------------------- timestamp.trade */

/*
 * One unauthenticated GET keyed on the StashDB id, and it answers with
 * everything: the scene it matched, and `marker[]` — singular, which is easy
 * to mistype — where each is `{name, tag, start, end}` in *milliseconds*.
 *
 * An id it has never seen answers 200 with an empty object rather than a 404,
 * so "nothing here" and "no such scene" are the same answer and are reported
 * as the same thing.
 */
async function fromTrade(stashId) {
  const data = await asJson(TRADE + stashId);
  const rows = Array.isArray(data?.marker) ? data.marker : [];

  return {
    scene: data?.scene_id ? `https://timestamp.trade/scene/${data.scene_id}` : null,
    title: data?.title || '',
    markers: rows.map((m) => ({
      ...cut((m.start || 0) / 1000, m.end == null ? null : m.end / 1000),
      // `tag` is what it should be filed under and `name` is what it was
      // called; they are usually the same string and the tag is the one the
      // palette will match, so it wins where they differ.
      tag: String(m.tag || m.name || '').trim(),
      name: String(m.name || m.tag || '').trim(),
    })),
  };
}

/* ------------------------------------------------------------------ TPDB */

/*
 * The REST scene, with the token Stash already holds for TPDB's stash-box —
 * the same one the artwork fetcher borrows. `data.markers[]` is
 * `{title, start_time, end_time}` in *seconds*, and TPDB has no separate tag
 * field: the title is the tag.
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

/*
 * What both sources have for one scene, and what each row would land on.
 *
 * Asked together and answered together, because the question the page is
 * really asking is "where can I get timestamps for this" — and being told
 * about one source at a time turns that into two waits and a comparison the
 * page would have to make anyway.
 *
 * A source with no id for this scene is reported rather than omitted: "this
 * scene has no StashDB id" is the answer to why timestamp.trade has nothing,
 * and it is a fixable thing, which "nothing found" is not.
 */
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
    /*
     * What is already on the scene, sent back with them. The page draws the
     * collisions, and it can only do that against the markers as they are at
     * the moment of asking — the bench's own copy may be several writes old by
     * the time somebody presses this.
     */
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
