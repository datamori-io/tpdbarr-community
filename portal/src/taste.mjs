/*
 * How much a scene looks like what you already collect, to order the
 * decide queue. The signal is your library: performers and studios on
 * disk, counted, matched by StashDB uuid then name. Reorders only; hides
 * and skips nothing.
 */

import * as stash from './stash.mjs';

const TTL = 30 * 60 * 1000;
let held = null;

export function forgetTaste() {
  held = null;
}

const key = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const PERFORMERS = `{
  findPerformers(filter: {per_page: -1}) {
    performers { id name favorite scene_count stash_ids { endpoint stash_id } }
  }
}`;

const STUDIOS = `{
  findStudios(filter: {per_page: -1}) {
    studios { id name scene_count stash_ids { endpoint stash_id } }
  }
}`;

const stashdbIdOf = (row) =>
  (row.stash_ids || []).find((s) => /stashdb\.org/i.test(s.endpoint))?.stash_id || null;

/* Lookups by uuid and by name, cached half an hour. */
export async function taste(config) {
  if (held && Date.now() - held.at < TTL) return held;

  const [people, places] = await Promise.all([
    stash.gql(config, PERFORMERS).catch(() => null),
    stash.gql(config, STUDIOS).catch(() => null),
  ]);

  const performers = new Map();
  const performersByName = new Map();
  for (const row of people?.findPerformers?.performers || []) {
    const count = row.scene_count || 0;
    if (!count) continue;
    const one = { name: row.name, count, favourite: Boolean(row.favorite) };
    const uuid = stashdbIdOf(row);
    if (uuid) performers.set(uuid, one);
    performersByName.set(key(row.name), one);
  }

  const studios = new Map();
  const studiosByName = new Map();
  for (const row of places?.findStudios?.studios || []) {
    const count = row.scene_count || 0;
    if (!count) continue;
    const one = { name: row.name, count };
    const uuid = stashdbIdOf(row);
    if (uuid) studios.set(uuid, one);
    studiosByName.set(key(row.name), one);
  }

  held = { at: Date.now(), performers, performersByName, studios, studiosByName };
  return held;
}

/*
 * Scoring: each performer capped (so one name doesn't dominate); a studio
 * counts less than a person; a favourite is worth about a dozen scenes.
 */
const PER_CAP = 30;
const STUDIO_CAP = 40;
const FAVOURITE = 12;

export function score(scene, map) {
  if (!map) return null;

  let points = 0;
  const why = [];

  for (const person of scene.performers || []) {
    const hit = (person.id && map.performers.get(person.id))
      || map.performersByName.get(key(person.name));
    if (!hit) continue;

    points += Math.min(hit.count, PER_CAP) + (hit.favourite ? FAVOURITE : 0);
    why.push({
      at: hit.count + (hit.favourite ? 1000 : 0),
      say: `${hit.name}: ${hit.count} in your library${hit.favourite ? ', a favourite' : ''}`,
    });
  }

  const studio = (scene.studio?.id && map.studios.get(scene.studio.id))
    || map.studiosByName.get(key(scene.studioName || scene.studio?.name));
  if (studio) {
    points += Math.min(studio.count, STUDIO_CAP) / 2;
    why.push({ at: studio.count / 2, say: `${studio.name}: ${studio.count} in your library` });
  }

  // Loudest first, and only the three that would fit on a line.
  why.sort((a, b) => b.at - a.at);

  return { score: Math.round(points), why: why.slice(0, 3).map((one) => one.say) };
}
