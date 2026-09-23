/*
 * What you already collect, and how much a scene looks like it.
 *
 * The decide queue is honest and exhausting in the same breath: it hands you
 * the catalogue in date order and every card costs the same attention, whether
 * it is the performer you own forty scenes of or a studio you have never once
 * said yes to. Rules took out the obvious noes. This is the other end — the
 * obvious yeses, first, so that a backlog you will never finish is at least
 * read in the order that pays.
 *
 * **The signal is your own library.** Not a model of taste and not StashDB's
 * popularity: the performers and studios already on your disk, counted. Forty
 * scenes of somebody is a statement you made forty times, and it is the only
 * statement here nobody had to invent.
 *
 * Matched on StashDB's uuid where Stash holds one and on the name where it
 * does not, which is the same two-pass join the rest of the portal uses — a
 * third of this library was identified against ThePornDB's box instead, and
 * dropping those would quietly mean "you do not collect her".
 *
 * Nothing here decides anything. A score reorders what you were going to be
 * shown anyway; no scene is hidden by it and none is skipped.
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

/*
 * Two lookups per kind, by uuid and by name, built once and held for half an
 * hour. A library does not change between one card and the next, and this is
 * two full-table reads out of Stash — paying that per batch would be paying it
 * every few seconds.
 */
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
 * How the points are given, and why these numbers.
 *
 * **Each performer is capped.** Owning eighty scenes of somebody does not make
 * a scene twice as interesting as owning forty — past a point it only says
 * "yes, her", and without a cap one name would decide every ranking in the
 * queue.
 *
 * **A studio counts for less than a person.** You collect people and you end
 * up with studios; a studio you have two hundred scenes of is mostly a fact
 * about who shoots for them.
 *
 * **A favourite is worth about a dozen scenes** — it is a statement you made
 * on purpose, and it is the only one here that survives a thin library.
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
