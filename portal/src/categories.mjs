/*
 * Categories: shelves you arrange yourself. Portal-owned
 * (config/categories.json); nothing is written to Stash.
 *
 *   picks  scenes chosen by hand, in order
 *   rule   lines that keep adding matching scenes
 *   drops  matches you removed, so the rule can't add them back
 *
 * Members are picks then matches, resolved against the cached shelf read.
 */

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ART_TYPES, checked } from './artwork.mjs';
import { shelf, scenesDirectedBy } from './stashlib.mjs';
import * as stashdb from './stashdb.mjs';
import * as whisparr3 from './whisparr3.mjs';
import { whisparr3Reachable } from './config.mjs';

const CONFIG_DIR = process.env.CONFIG_DIR || './config';
const PATH = join(CONFIG_DIR, 'categories.json');

// ------------------------------------------------------------------- store

let cache = null;
let loading = null;

const empty = () => ({ categories: [] });

function load() {
  if (cache) return Promise.resolve(cache);
  if (loading) return loading;

  loading = readFile(PATH, 'utf8')
    .then((text) => { cache = JSON.parse(text); })
    .catch(() => { cache = empty(); })
    .then(() => {
      if (!Array.isArray(cache.categories)) cache = empty();
      /* Old rules are converted to clauses on load. */
      for (const row of cache.categories) row.rule = shapeRule(row.rule);
      loading = null;
      return cache;
    });

  return loading;
}

// Temp file then rename, the same as the group builder: a crash mid-write must
// not be able to leave a file that parses as "you have no categories".
async function save() {
  if (!cache) return;
  await mkdir(CONFIG_DIR, { recursive: true });
  const temp = PATH + '.tmp';
  await writeFile(temp, JSON.stringify(cache, null, 2), 'utf8');
  await rename(temp, PATH);
}

// ------------------------------------------------------------------ shaping

/* The slug is made once and kept through renames, so links don't break. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const clean = (value, limit) => String(value ?? '').trim().slice(0, limit);

// Rule terms are compared folded, so "Sci-Fi" in the rule catches "sci fi" on
// the scene. Stash's tag names are not typed consistently enough to match raw.
const fold = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const listOf = (value) => (Array.isArray(value) ? value : [])
  .map((v) => clean(v, 80))
  .filter(Boolean)
  .slice(0, 40);

/*
 * ------------------------------------------------------------------ rules
 *
 * A rule is a list of lines, read top to bottom. Each line is one field,
 * one operator and its words; lines after the first say how they join:
 *
 *   tags        any of   anal, dp
 *   and studios none of  BangBros
 *   or performers any of Riley Reid
 *   or title     any of  wedding
 *
 * Left to right, no precedence: `a or b and c` is `(a or b) and c`.
 * Tags, studios and titles match loosely; performers exactly. Title also
 * matches the filename when Stash has no title.
 */

export const FIELDS = ['tags', 'studios', 'performers', 'title'];
const OPS = ['any', 'all', 'none'];

// A rule with more lines than this is not a rule you can read, and each one
// costs a pass over the shelf on every count.
const MAX_CLAUSES = 12;

function shapeClause(clause) {
  return {
    field: FIELDS.includes(clause?.field) ? clause.field : 'tags',
    op: OPS.includes(clause?.op) ? clause.op : 'any',
    values: listOf(clause?.values),
    // "and" is the useful default for a line you have just added: you are
    // narrowing what is already there, or you would not be adding one.
    join: clause?.join === 'or' ? 'or' : 'and',
  };
}

/* Old shape (three OR-ed fields plus `match`) -> clauses, catching the same scenes. */
function shapeRule(rule) {
  if (Array.isArray(rule?.clauses)) {
    return { clauses: rule.clauses.slice(0, MAX_CLAUSES).map(shapeClause) };
  }

  const op = rule?.match === 'all' ? 'all' : 'any';
  const clauses = [
    { field: 'tags', op, values: listOf(rule?.tags) },
    { field: 'studios', op: 'any', values: listOf(rule?.studios) },
    { field: 'performers', op: 'any', values: listOf(rule?.performers) },
  ]
    .filter((c) => c.values.length)
    .map((c, i) => shapeClause({ ...c, join: i ? 'or' : 'and' }));

  return { clauses };
}

const liveClauses = (rule) => (rule?.clauses || []).filter((c) => c.values.length);

const ruleIsEmpty = (rule) => liveClauses(rule).length === 0;

const ids = (value) => (Array.isArray(value) ? value : [])
  .map((v) => String(v).replace(/\D/g, ''))
  .filter(Boolean);

// ------------------------------------------------------------- the matching

const HAYSTACK = {
  tags: (scene) => (scene.tags || []).map(fold),
  studios: (scene) => (scene.studio ? [fold(scene.studio.name)] : []),
  performers: (scene) => (scene.performers || []).map((p) => fold(p.name)),
  title: (scene) => [fold(scene.title)],
};

function clauseHits(scene, clause) {
  const hay = (HAYSTACK[clause.field] || HAYSTACK.tags)(scene);
  const named = (want) => (clause.field === 'performers'
    ? hay.some((h) => h === want)
    : hay.some((h) => h.includes(want)));

  const wanted = clause.values.map(fold);

  if (clause.op === 'all') return wanted.every(named);
  if (clause.op === 'none') return !wanted.some(named);
  return wanted.some(named);
}

/* Does the rule match this scene? An empty line is skipped, not false. */
function matches(scene, rule) {
  const live = liveClauses(rule);
  if (!live.length) return false;

  let held = clauseHits(scene, live[0]);
  for (const clause of live.slice(1)) {
    const hit = clauseHits(scene, clause);
    held = clause.join === 'or' ? (held || hit) : (held && hit);
  }
  return held;
}

/* Picks first, in order, then rule matches, newest first. */
function membersOf(row, scenes) {
  const byId = new Map(scenes.map((s) => [String(s.id), s]));
  const dropped = new Set(row.drops || []);

  const picked = (row.picks || [])
    .filter((id) => !dropped.has(id))
    .map((id) => byId.get(id))
    .filter(Boolean);

  const seen = new Set(picked.map((s) => String(s.id)));

  const found = scenes
    .filter((s) => !seen.has(String(s.id)) && !dropped.has(String(s.id)) && matches(s, row.rule))
    .sort((a, b) => String(b.addedAt || b.date || '').localeCompare(String(a.addedAt || a.date || '')));

  return { picked, found, all: [...picked, ...found] };
}

/* What the client gets for one category. Membership lists stay server-side. */
const publicRow = (row, count, cover) => ({
  slug: row.slug,
  name: row.name,
  blurb: row.blurb || '',
  cover: cover || null,
  /* The uploaded picture's URL; the stamp busts the browser cache. */
  art: row.art ? `/api/library/categories/${row.slug}/art?v=${row.artAt || 0}` : null,
  rule: row.rule,
  ruled: !ruleIsEmpty(row.rule),
  picks: (row.picks || []).length,
  count,
  createdAt: row.createdAt || null,
});

/* The chosen cover scene, else the first member. */
function coverOf(row, members) {
  if (row.cover && members.some((s) => String(s.id) === String(row.cover))) return String(row.cover);
  return members.length ? String(members[0].id) : null;
}

/*
 * ------------------------------------------------------------ filmography
 *
 * A category of everything a director made, owned or not, from StashDB.
 * See stashdb.findByDirector.
 *
 *   manifest  what the last search found — replaced on refresh
 *   extra     added by hand — kept
 *   drops     removed by hand — kept
 *
 * `row.kind === 'filmography'` is what everything branches on.
 */

// Enough of a StashDB scene to draw a tile.
const filmStub = (card) => ({
  id: card.id,
  title: card.title,
  date: card.date || null,
  studioName: card.studioName || '',
  performers: (card.performers || []).map((p) => ({ id: p.id, name: p.name })),
  image: card.image || null,
  url: card.url,
});

// A pasted StashDB link or a bare uuid, either one. Anything else is not
// something this can act on, and the caller skips it rather than guessing.
const STASHDB_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const extractStashdbId = (raw) => (STASHDB_UUID.exec(String(raw || '')) || [])[0]?.toLowerCase() || null;

// Manifest, extras and drops folded into one list; extras override by id.
function filmMembers(row) {
  const drops = new Set(row.drops || []);
  const byId = new Map();
  for (const m of row.manifest || []) byId.set(m.id, m);
  for (const e of row.extra || []) byId.set(e.id, e);

  return [...byId.values()]
    .filter((m) => !drops.has(m.id))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/* Title + date second pass, for scenes identified against TPDB. Marked `probable`. */
const titleKey = (title, date) =>
  String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '') + '|' + String(date || '').slice(0, 10);

/*
 * Which you already hold: StashDB uuid against Stash's `stash_ids`. With no
 * StashDB stash-box in Stash, everything shows missing.
 * `skipped` reads the acquisition ignore list (config.tracked.ignored).
 */
function decorateFilm(entries, scenes, endpoint, ignored) {
  const owned = new Map();
  const byTitle = new Map();
  for (const scene of scenes) {
    const id = endpoint ? stashdb.idAt(scene.stash_ids, endpoint) : null;
    if (id) owned.set(String(id).toLowerCase(), scene);
    if (!scene.untitled && scene.title && scene.date) {
      const key = titleKey(scene.title, scene.date);
      if (!byTitle.has(key)) byTitle.set(key, scene);
    }
  }

  return entries.map((entry) => {
    const exact = owned.get(String(entry.id).toLowerCase());
    const hit = exact || (entry.title && entry.date ? byTitle.get(titleKey(entry.title, entry.date)) : null);
    return {
      ...entry,
      owned: Boolean(hit),
      probable: Boolean(hit && !exact),
      sceneId: hit ? String(hit.id) : null,
      skipped: !hit && ignored.has(entry.id),
    };
  });
}

// The ignore list as a Set of bare ids — read once per request rather than
// once per entry, since a well-used library holds thousands of them.
const ignoredIds = (config) => new Set((config?.tracked?.ignored || []).map((s) => s.id));

// Lead with the newest one you hold, else the first entry's picture.
// Already an image URL, unlike a rule category's cover.
function filmCoverOf(entries) {
  const owned = entries.find((e) => e.owned);
  if (owned) return `/media/scene/${owned.sceneId}/thumb`;
  return entries[0]?.image || null;
}

const publicFilmRow = (row, count, held, coverImage) => ({
  slug: row.slug,
  name: row.name,
  kind: 'filmography',
  director: row.director,
  blurb: row.blurb || '',
  art: row.art ? `/api/library/categories/${row.slug}/art?v=${row.artAt || 0}` : null,
  coverImage: coverImage || null,
  count,
  held,
  manifestAt: row.manifestAt || null,
  createdAt: row.createdAt || null,
});

export async function createFilmography(config, body) {
  const store = await load();

  const director = clean(body?.director, 80);
  if (!director) throw Object.assign(new Error('A filmography category needs a director.'), { status: 400 });

  const name = clean(body?.name, 60) || director;
  const slug = slugify(name);
  if (!slug) throw Object.assign(new Error('That name has no letters or numbers in it.'), { status: 400 });
  if (store.categories.some((c) => c.slug === slug)) {
    throw Object.assign(new Error('There is already a category with that name.'), { status: 409 });
  }

  store.categories.push({
    slug,
    name,
    kind: 'filmography',
    director,
    blurb: clean(body?.blurb, 400),
    art: null,
    artAt: 0,
    manifest: [],
    extra: [],
    drops: [],
    manifestAt: null,
    createdAt: new Date().toISOString(),
  });

  await save();

  try {
    await refreshFilmography(config, slug);
  } catch {
    // Create the category even if StashDB isn't reached; Refresh can retry.
  }

  return read(config, slug);
}

/*
 * Crawl a director's work (ported from refresh_catalog.py).
 *
 * StashDB can't search by director, but can list a studio network with each
 * scene's director. Networks are seeded from scenes Stash already credits to
 * him. A text search runs too, for one-off studios.
 */
async function crawlDirector(config, director) {
  const found = new Map();

  const [endpoint, credited] = await Promise.all([
    stashdb.endpointFor(config).catch(() => null),
    scenesDirectedBy(config, director).catch(() => []),
  ]);

  const seedIds = endpoint
    ? credited.map((s) => stashdb.idAt(s.stash_ids, endpoint)).filter(Boolean)
    : [];

  const networks = new Map();
  for (const id of seedIds) {
    const network = await stashdb.sceneStudioNetwork(config, id).catch(() => null);
    if (network) networks.set(network.id, network.name);
  }

  for (const [id] of networks) {
    const batch = await stashdb.crawlNetworkForDirector(config, id, director).catch(() => []);
    for (const card of batch) found.set(card.id, card);
  }

  const net = await stashdb.findByDirector(config, director).catch(() => []);
  for (const card of net) if (!found.has(card.id)) found.set(card.id, card);

  // A seeded scene the crawl still missed — structurally possible if its
  // studio has since moved to a different network on StashDB.
  const missing = seedIds.filter((id) => !found.has(id));
  if (missing.length) {
    const extra = await stashdb.scenesByIds(config, missing).catch(() => new Map());
    for (const card of extra.values()) found.set(card.id, card);
  }

  return [...found.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

export async function refreshFilmography(config, slug) {
  const store = await load();
  const row = find(store, slug);
  if (row.kind !== 'filmography') {
    throw Object.assign(new Error('Only a filmography category can be refreshed from StashDB.'), { status: 400 });
  }

  const found = await crawlDirector(config, row.director);
  row.manifest = found.map(filmStub);
  row.manifestAt = new Date().toISOString();

  await save();
  return read(config, slug);
}

async function assignFilmography(config, row, body) {
  row.extra = row.extra || [];
  row.drops = row.drops || [];

  for (const raw of (Array.isArray(body?.add) ? body.add : [])) {
    const id = extractStashdbId(raw);
    if (!id) continue;
    row.drops = row.drops.filter((d) => d !== id);
    if (row.extra.some((e) => e.id === id) || (row.manifest || []).some((m) => m.id === id)) continue;

    const card = await stashdb.getScene(config, id).catch(() => null);
    if (card) row.extra.push(filmStub(card));
  }

  for (const raw of (Array.isArray(body?.remove) ? body.remove : [])) {
    const id = extractStashdbId(raw) || String(raw || '');
    if (!id) continue;
    row.extra = row.extra.filter((e) => e.id !== id);
    if (!row.drops.includes(id)) row.drops.push(id);
  }

  await save();
  return read(config, row.slug);
}

// -------------------------------------------------------------- the reading

export async function index(config) {
  const [store, { scenes }, endpoint] = await Promise.all([
    load(), shelf(config), stashdb.endpointFor(config).catch(() => null),
  ]);
  const ignored = ignoredIds(config);

  const categories = store.categories
    .map((row) => {
      if (row.kind === 'filmography') {
        const entries = decorateFilm(filmMembers(row), scenes, endpoint, ignored);
        const held = entries.filter((e) => e.owned).length;
        return publicFilmRow(row, entries.length, held, filmCoverOf(entries));
      }
      const { all } = membersOf(row, scenes);
      return publicRow(row, all.length, coverOf(row, all));
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { categories, count: categories.length };
}

const PER_PAGE = 60;

/* `all` returns every member at once, so the filter bar is built from all of them. */
export async function read(config, slug, { page = 1, all: whole = false } = {}) {
  const [store, { scenes }, endpoint] = await Promise.all([
    load(), shelf(config), stashdb.endpointFor(config).catch(() => null),
  ]);

  const row = store.categories.find((c) => c.slug === slug);
  if (!row) {
    const err = new Error('No category with that name.');
    err.status = 404;
    throw err;
  }

  if (row.kind === 'filmography') {
    // No paging: filmographies are small.
    const decorated = decorateFilm(filmMembers(row), scenes, endpoint, ignoredIds(config));
    const held = decorated.filter((e) => e.owned).length;

    /* Each missing scene's v3 state, one cached call. Only on the category page. */
    const inV3 = whisparr3Reachable(config)
      ? await whisparr3.allByStashId(config).catch(() => new Map())
      : new Map();
    const entries = decorated.map((e) => ({
      ...e,
      v3: e.owned ? null : whisparr3.statusOf(inV3.get(String(e.id).toLowerCase())).status,
    }));

    return {
      category: publicFilmRow(row, entries.length, held, filmCoverOf(entries)),
      entries,
      v3: whisparr3Reachable(config),
    };
  }

  const { picked, all } = membersOf(row, scenes);
  const at = Math.max(1, Number(page) || 1);

  return {
    category: publicRow(row, all.length, coverOf(row, all)),
    // Which of the ones on screen you put there by hand, so the page can mark
    // them and the editor can offer to take them out again.
    picked: picked.map((s) => String(s.id)),
    page: whole ? 1 : at,
    perPage: whole ? all.length : PER_PAGE,
    count: all.length,
    scenes: whole ? all : all.slice((at - 1) * PER_PAGE, at * PER_PAGE),
  };
}

/* Every category a scene is in, for the scene page. */
export async function forScene(config, sceneId) {
  const [store, { scenes }] = await Promise.all([load(), shelf(config)]);
  const id = String(sceneId);

  // Filmography categories aren't offered in the scene picker.
  const pickable = store.categories.filter((row) => row.kind !== 'filmography');

  const holding = pickable
    .filter((row) => membersOf(row, scenes).all.some((s) => String(s.id) === id))
    .map((row) => ({ slug: row.slug, name: row.name }));

  return {
    categories: pickable
      .map((row) => ({ slug: row.slug, name: row.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    in: holding.map((c) => c.slug),
  };
}

// -------------------------------------------------------------- the writing

export async function create(config, body) {
  const store = await load();

  const name = clean(body?.name, 60);
  if (!name) throw Object.assign(new Error('A category needs a name.'), { status: 400 });

  const slug = slugify(name);
  if (!slug) throw Object.assign(new Error('That name has no letters or numbers in it.'), { status: 400 });
  if (store.categories.some((c) => c.slug === slug)) {
    throw Object.assign(new Error('There is already a category with that name.'), { status: 409 });
  }

  store.categories.push({
    slug,
    name,
    blurb: clean(body?.blurb, 400),
    cover: null,
    picks: ids(body?.picks),
    drops: [],
    rule: shapeRule(body?.rule),
    createdAt: new Date().toISOString(),
  });

  await save();
  return read(config, slug);
}

function find(store, slug) {
  const row = store.categories.find((c) => c.slug === slug);
  if (!row) throw Object.assign(new Error('No category with that name.'), { status: 404 });
  return row;
}

/* Edit a category. Only fields sent are changed. */
export async function update(config, slug, body) {
  const store = await load();
  const row = find(store, slug);

  if (body?.name !== undefined) {
    const name = clean(body.name, 60);
    if (!name) throw Object.assign(new Error('A category needs a name.'), { status: 400 });
    row.name = name;
  }
  if (body?.blurb !== undefined) row.blurb = clean(body.blurb, 400);

  if (row.kind === 'filmography') {
    if (body?.director !== undefined) {
      const director = clean(body.director, 80);
      if (!director) throw Object.assign(new Error('A filmography category needs a director.'), { status: 400 });
      row.director = director;
    }
  } else {
    if (body?.cover !== undefined) row.cover = body.cover ? String(body.cover).replace(/\D/g, '') || null : null;
    if (body?.rule !== undefined) row.rule = shapeRule(body.rule);
  }

  await save();
  return read(config, slug);
}

export async function remove(_config, slug) {
  const store = await load();
  find(store, slug);
  store.categories = store.categories.filter((c) => c.slug !== slug);
  await save();
  return { removed: slug };
}

/* Add and remove scenes. Removing drops the pick and records a drop. */
export async function assign(config, slug, body) {
  const store = await load();
  const row = find(store, slug);

  // Filmography add/remove means a StashDB link. See assignFilmography.
  if (row.kind === 'filmography') return assignFilmography(config, row, body);

  row.picks = row.picks || [];
  row.drops = row.drops || [];

  for (const id of ids(body?.add)) {
    row.drops = row.drops.filter((d) => d !== id);
    if (!row.picks.includes(id)) row.picks.push(id);
  }

  for (const id of ids(body?.remove)) {
    row.picks = row.picks.filter((p) => p !== id);
    if (!row.drops.includes(id)) row.drops.push(id);
  }

  await save();
  return read(config, slug);
}

/* Reorder picks. Unknown ids are ignored. */
export async function reorder(config, slug, body) {
  const store = await load();
  const row = find(store, slug);

  if (row.kind === 'filmography') {
    throw Object.assign(new Error('A filmography category has no hand order — it is sorted by date.'), { status: 400 });
  }

  const wanted = ids(body?.ids);
  const held = new Set(row.picks || []);
  const ordered = wanted.filter((id) => held.has(id));

  // Anything the client did not mention keeps its place at the back, so a
  // partial list can never silently delete picks.
  row.picks = [...ordered, ...(row.picks || []).filter((id) => !ordered.includes(id))];

  await save();
  return read(config, slug);
}

/* What a rule would catch, for the editor's live preview. */
export async function preview(config, body) {
  const { scenes } = await shelf(config);
  const rule = shapeRule(body?.rule);

  if (ruleIsEmpty(rule)) return { count: 0, scenes: [] };

  const found = scenes
    .filter((s) => matches(s, rule))
    .sort((a, b) => String(b.addedAt || b.date || '').localeCompare(String(a.addedAt || a.date || '')));

  return { count: found.length, scenes: found.slice(0, 24) };
}

/*
 * --------------------------------------------------------- your own artwork
 *
 * An uploaded picture, in config/covers/, one per category, named by slug.
 * Type is sniffed from the bytes (artwork.mjs), not the uploaded name.
 */

const COVERS = join(CONFIG_DIR, 'covers');

/* Null when there's no picture (a 404, not a fault). */
export async function artFile(slug) {
  const store = await load();
  const row = store.categories.find((c) => c.slug === slug);
  if (!row?.art) return null;

  const dot = row.art.lastIndexOf('.');
  return {
    file: join(COVERS, row.art),
    type: ART_TYPES[dot < 0 ? '' : row.art.slice(dot)] || 'application/octet-stream',
  };
}

export async function setArt(config, slug, buffer) {
  const store = await load();
  const row = find(store, slug);

  const kind = checked(buffer);

  await mkdir(COVERS, { recursive: true });
  const name = row.slug + kind.ext;
  await writeFile(join(COVERS, name), buffer);

  // The old one, when the new picture is a different format and would
  // otherwise leave the previous file sitting there unreferenced.
  if (row.art && row.art !== name) await rm(join(COVERS, row.art), { force: true });

  row.art = name;
  // Stamp so the browser fetches the new one.
  row.artAt = Date.now();

  await save();
  return read(config, slug);
}

export async function clearArt(config, slug) {
  const store = await load();
  const row = find(store, slug);

  if (row.art) await rm(join(COVERS, row.art), { force: true });
  row.art = null;
  row.artAt = 0;

  await save();
  return read(config, slug);
}

/* Words a rule can use, counted over what you hold. */
export async function terms(config) {
  const { scenes } = await shelf(config);

  const tally = (pick) => {
    const counts = new Map();
    for (const scene of scenes) {
      for (const value of pick(scene)) {
        if (value) counts.set(value, (counts.get(value) || 0) + 1);
      }
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  };

  return {
    tags: tally((s) => s.tags || []),
    studios: tally((s) => (s.studio ? [s.studio.name] : [])),
    performers: tally((s) => (s.performers || []).map((p) => p.name)),
  };
}
