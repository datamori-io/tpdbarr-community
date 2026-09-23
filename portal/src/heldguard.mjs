/*
 * The last check before anything is handed to a Whisparr: does Stash already
 * have it?
 *
 * Every page that offers Add or Send to v3 is meant to have asked this before
 * it drew the button. Several did not, or asked only part of the question, and
 * one of them fetched a scene that was already on the shelf (2026-09-22,
 * through the Monitored tab). The pages are fixed; this is the backstop, so the
 * next page that forgets cannot cause the same thing. It sits on the server,
 * in front of the writes, so every page and every job goes through it.
 *
 * Refusing is a 409 that names what Stash holds and where. The browser's api()
 * asks whether to go ahead, and a yes sends the same request again with
 * `force: true`. "Get me another copy" has its own route (askAgain) and is not
 * guarded, because a second copy is the point of it.
 *
 * It fails open. If Stash is down or slow, the add goes through as it always
 * did: a backstop that blocks every add while Stash restarts is worse than
 * one that sometimes lets a duplicate past.
 */

import * as metadata from './metadata.mjs';
import * as stash from './stash.mjs';
import * as stashdb from './stashdb.mjs';
import { stashConfigured } from './config.mjs';

const brief = (hit, match) => ({
  stashSceneId: String(hit.id),
  title: hit.title || '',
  path: hit.path || hit.files?.[0]?.path || null,
  match,
});

// One StashDB scene, as Whisparr v3 would take it. -> held record or null.
export async function heldForV3(config, stashId) {
  if (!stashConfigured(config) || !stashId) return null;
  // StashDB ids are lowercase in Stash; a URL or a pasted id may not be.
  stashId = String(stashId).toLowerCase();
  try {
    const endpoint = await stashdb.endpointFor(config);
    const owned = await stash.ownedByStashIds(config, endpoint, [stashId]);
    const exact = owned.get(String(stashId).toLowerCase());
    if (exact) return brief(exact, 'exact');

    // No StashDB id in Stash: the scene may have been identified against
    // ThePornDB instead. StashDB's own title and date, against the shelf.
    const card = await stashdb.getScene(config, stashId).catch(() => null);
    if (!card?.title || !card?.date) return null;
    const index = await stash.titleDateIndex(config);
    const probable = stash.matchByTitleDate(index, { title: card.title, date: card.date });
    return probable ? brief(probable, 'probable') : null;
  } catch {
    return null;
  }
}

// TPDB scene ids under one site, as Whisparr v2 would take them.
// -> [{id, ...held record}] for the ones Stash has.
export async function heldForV2(config, siteId, sceneIds) {
  if (!stashConfigured(config) || !sceneIds.length) return [];
  try {
    const site = await metadata.getSite(siteId);
    const wanted = new Set(sceneIds.map(Number));
    const scenes = (site?.scenes || []).filter((s) => wanted.has(Number(s.id)));
    if (!scenes.length) return [];
    const { found } = await stash.matchScenes(config, scenes);
    return scenes
      .filter((s) => found.has(s.id))
      .map((s) => ({ id: s.id, ...brief(found.get(s.id).scene, found.get(s.id).match) }));
  } catch {
    return [];
  }
}

// The refusal itself. `held` travels to the browser in the error body.
export function refusal(held) {
  const list = Array.isArray(held) ? held : [held];
  const first = list[0];
  const what = list.length === 1
    ? `Stash already has “${first.title}”${first.match === 'probable' ? ' (matched on title + date)' : ''}${first.path ? ` at ${first.path}` : ''}.`
    : `Stash already has ${list.length} of these, starting with “${first.title}”.`;
  const err = new Error(what);
  err.status = 409;
  err.payload = { held: list };
  return err;
}
