/*
 * TV: channels that play filed scenes (or films, on the Movies channel)
 * back to back, live.
 *
 * A channel's lineup is its scenes shuffled with a seed of the channel and
 * the day (UTC), starting at that day's midnight and looping. The page works
 * out what is on from the clock, so every device shows the same thing and
 * tuning in joins a scene part-way through. Nothing is streamed or cut here:
 * the page plays the files directly.
 */

import { shelf } from './stashlib.mjs';
import { heldIds, index as categoryIndex } from './categories.mjs';
import { shuffled } from './shuffle.mjs';
import { gql } from './stash.mjs';
import { ordered } from '../public/partorder.js';

const DAY = 24 * 60 * 60 * 1000;
const FILED = '/organized_scenes/';
const FILMS = '/movies/';

// A channel needs this many scenes to be offered in the picker; tags more,
// since there are hundreds of them.
const MIN_SCENES = 3;
const MIN_TAG_SCENES = 10;

const playable = (scene, root) =>
  String(scene.path || '').includes(root) && scene.duration > 0 && !scene.immersive;

async function filed(config) {
  return (await shelf(config)).scenes.filter((s) => playable(s, FILED));
}

async function films(config) {
  return (await shelf(config)).scenes.filter((s) => playable(s, FILMS));
}

/*
 * Stash groups (films cut into scene files) with their playable parts in
 * play order (partorder.js). Only groups with two or more parts.
 */
const GROUP_TTL = 5 * 60 * 1000;
let groupCache = null;
async function groups(config) {
  if (groupCache && Date.now() - groupCache.at < GROUP_TTL) return groupCache.list;
  const [data, { scenes }] = await Promise.all([
    gql(config, '{ findGroups(filter: {per_page: -1}) { groups { id name scenes { id } } } }'),
    shelf(config),
  ]);
  const byId = new Map(scenes.filter((s) => playable(s, FILED) || playable(s, FILMS)).map((s) => [String(s.id), s]));
  const list = (data.findGroups.groups || [])
    .map((g) => ({
      id: String(g.id),
      name: g.name,
      parts: ordered((g.scenes || []).map((s) => byId.get(String(s.id))).filter(Boolean), g.name),
    }))
    .filter((g) => g.parts.length >= 2)
    .sort((a, b) => Number(a.id) - Number(b.id));
  groupCache = { list, at: Date.now() };
  return list;
}

const counted = (scenes, keysOf, min = MIN_SCENES) => {
  const tally = new Map();
  for (const scene of scenes) {
    for (const [key, label] of keysOf(scene)) {
      const hit = tally.get(key) || { key, label, count: 0 };
      hit.count += 1;
      tally.set(key, hit);
    }
  }
  return [...tally.values()]
    .filter((c) => c.count >= min)
    .sort((a, b) => a.label.localeCompare(b.label));
};

/* Every channel worth offering: Random, Movies, then categories, studios, performers, tags. */
export async function channels(config) {
  const [scenes, movies, parted, cats] = await Promise.all([
    filed(config),
    films(config),
    groups(config).catch(() => []),
    categoryIndex(config).catch(() => ({ categories: [] })),
  ]);
  const ids = new Set(scenes.map((s) => String(s.id)));

  const categories = [];
  for (const cat of cats.categories) {
    const held = (await heldIds(config, cat.slug).catch(() => null)) || [];
    const count = held.filter((id) => ids.has(String(id))).length;
    if (count >= MIN_SCENES) categories.push({ key: `category:${cat.slug}`, label: cat.name, count });
  }

  return {
    random: { key: 'random', label: 'Random', count: scenes.length },
    movies: { key: 'movies', label: 'Movies', count: movies.length },
    groups: { key: 'groups', label: 'Groups', count: parted.length },
    categories,
    studios: counted(scenes, (s) => (s.studio ? [[`studio:${s.studio.id}`, s.studio.name]] : [])),
    performers: counted(scenes, (s) => s.performers.map((p) => [`performer:${p.id}`, p.name])),
    tags: counted(scenes, (s) => (s.tags || []).map((t) => [`tag:${t}`, t]), MIN_TAG_SCENES),
  };
}

/* A channel's scenes, unordered, and its label. Null when the key is unknown. */
async function members(config, key) {
  const scenes = await filed(config);
  const [kind, ...rest] = String(key || 'random').split(':');
  const value = rest.join(':');

  if (kind === 'random') return { label: 'Random', scenes };
  if (kind === 'movies') return { label: 'Movies', scenes: await films(config) };
  if (kind === 'studio') {
    const list = scenes.filter((s) => String(s.studio?.id) === value);
    return { label: list[0]?.studio?.name || 'Studio', scenes: list };
  }
  if (kind === 'performer') {
    const list = scenes.filter((s) => s.performers.some((p) => String(p.id) === value));
    const who = list[0]?.performers.find((p) => String(p.id) === value);
    return { label: who?.name || 'Performer', scenes: list };
  }
  if (kind === 'tag') {
    return { label: value, scenes: scenes.filter((s) => (s.tags || []).includes(value)) };
  }
  if (kind === 'category') {
    const held = await heldIds(config, value);
    if (!held) return null;
    const wanted = new Set(held.map(String));
    const cats = await categoryIndex(config).catch(() => ({ categories: [] }));
    const label = cats.categories.find((c) => c.slug === value)?.name || value;
    return { label, scenes: scenes.filter((s) => wanted.has(String(s.id))) };
  }
  return null;
}

/*
 * -> { key, label, day, epoch, now, total, scenes }
 * `epoch` is when the lineup started (today's UTC midnight); `now` is the
 * server clock, so the page can correct for its own.
 */
export async function lineup(config, key) {
  if (key === 'groups') return groupLineup(config);
  const found = await members(config, key);
  if (!found) {
    const err = new Error('No such channel.');
    err.status = 404;
    throw err;
  }

  const now = Date.now();
  const day = Math.floor(now / DAY);
  const order = shuffled(
    [...found.scenes].sort((a, b) => Number(a.id) - Number(b.id)),
    `${key}:${day}`
  );

  return shaped(key, found.label, now, order.map((scene) => brief(scene)));
}

const brief = (s, group = null) => ({
  id: s.id,
  title: s.title,
  date: s.date || null,
  studio: s.studio?.name || null,
  performers: s.performers.map((p) => p.name),
  duration: s.duration,
  group,
});

// The lineup as the page reads it; `scenes` are already brief().
function shaped(key, label, now, scenes) {
  const day = Math.floor(now / DAY);
  return {
    key,
    label,
    day,
    epoch: day * DAY,
    now,
    total: scenes.reduce((sum, s) => sum + s.duration, 0),
    scenes,
  };
}

/* Groups, shuffled for the day; each plays its parts in order. */
async function groupLineup(config) {
  const now = Date.now();
  const day = Math.floor(now / DAY);
  const order = shuffled(await groups(config), `groups:${day}`);
  const items = order.flatMap((g) => g.parts.map((s, n) =>
    brief(s, { id: g.id, name: g.name, part: n + 1, of: g.parts.length })));
  return shaped('groups', 'Groups', now, items);
}
