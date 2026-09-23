/*
 * Categories — the shelf as you would arrange it, rather than as it arrived.
 *
 * Stash's tags are what a scraper said a scene contains. A category is what you
 * say a set of scenes *is*, and the two are not the same question: there are
 * hundreds of tags, nobody chose most of them, and no tag has a cover, a blurb
 * or an order. So this is portal-owned and lives in config/categories.json
 * beside the group builder's store — nothing here is ever written into Stash,
 * which is what keeps a category out of the tag facet on the Scenes shelf.
 *
 * A category holds scenes two ways at once:
 *
 *   picks  ids you chose by hand, in the order you chose them
 *   rule   a list of lines that keeps filling it as scenes land
 *
 * Both, because either alone is wrong. Hand-picking means a scene that arrives
 * tonight never joins anything; a rule alone means the one scene that belongs
 * and does not match can never be put in. So members are picks then matches,
 * and `drops` is the third list — the matches you have thrown out, remembered
 * so the rule cannot drag them back in tomorrow.
 *
 * Membership is resolved against the shelf read (stashlib.shelf), which is the
 * whole library with tag names, already cached for five minutes. A category
 * page therefore costs no extra read of Stash.
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
      /*
       * Every rule is shaped on the way in rather than only on the way out, so
       * nothing downstream has to know that a rule used to be three lists and
       * a word. A file written before clauses existed is read as clauses from
       * here on, and rewritten in the new shape the next time it is saved.
       */
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

/*
 * The slug is the address, so it is made once at creation and then left alone
 * even if the name changes. Renaming a category must not break a link you sent
 * yourself, and there is nothing here that could fix one up afterwards.
 */
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

/* ------------------------------------------------------------------ rules
 *
 * A rule is a list of lines, read top to bottom.
 *
 * It was one line: three comma-separated fields — tags, studios, performers —
 * OR-ed against each other, with a single "any / all" word that applied to the
 * tags only. Two things were wrong with that. You could not say the same thing
 * twice ("these tags, but not those"), and the one place a joining word
 * appeared did not join the things it sat between, so nobody could tell what
 * it did without reading this file.
 *
 * So each line names one field, one operator and its words, and every line
 * after the first carries the word that joins it to what is above it:
 *
 *   tags        any of   anal, dp
 *   and studios none of  BangBros
 *   or performers any of Riley Reid
 *   or title     any of  wedding
 *
 * **Left to right, no precedence.** Each line joins to the result of every
 * line above it, not to the line immediately above. `a or b and c` is
 * therefore `(a or b) and c`, which is what the page says it is and what the
 * stack of rows looks like. Borrowing arithmetic's precedence would make the
 * picture on screen a lie about the rule, and there is nowhere in a flat list
 * to draw a bracket.
 *
 * Tags, studios and titles match loosely (a rule word inside the name) because
 * Stash's names are not typed consistently; performers match exactly, because
 * two people's names overlapping is common and catching the wrong one is worse
 * than missing.
 *
 * **Title catches the file name too, for nothing.** `card()` already falls back
 * to the file's basename where Stash holds no title, so a line saying
 * `title any of wedding` finds both the scene called "The Wedding Night" and
 * the unidentified one sitting on disk as `wedding-night-1080p.mp4`. Which is
 * the whole point of having it: the scenes with no tags and no studio are
 * exactly the ones a rule could not reach before.
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

/*
 * Both shapes in, one shape out. The old rule's three fields were OR-ed and its
 * `match` word applied inside the tags, so that is exactly what it becomes —
 * an upgraded rule catches the same scenes the day after as the day before.
 */
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

/*
 * Does the rule name this scene? Left to right, as written — see above. A line
 * with no words in it is skipped rather than counted as false, so a half-typed
 * row cannot quietly empty the category while you are still filling it in.
 */
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

/*
 * The scenes of one category, in the order the page shows them: what you put
 * there first, in the order you put it, then what the rule found, newest
 * arrival first. Picks lead because they are the argument the category is
 * making; the rule's haul is the long tail underneath it.
 */
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

/*
 * What the client is given for one category. The membership lists stay on the
 * server side of the wire except where the editor needs them — a page drawing
 * a wall of tiles has no use for the pick order, and sending it would make the
 * index response grow with the size of the biggest category.
 */
const publicRow = (row, count, cover) => ({
  slug: row.slug,
  name: row.name,
  blurb: row.blurb || '',
  cover: cover || null,
  /*
   * The uploaded picture, if there is one, as the address that serves it. A
   * URL rather than a flag: every page that draws a category needs an <img>
   * src and not one of them should have to know how this is stored. The stamp
   * is what makes a replacement show up rather than the browser redrawing the
   * cached one.
   */
  art: row.art ? `/api/library/categories/${row.slug}/art?v=${row.artAt || 0}` : null,
  rule: row.rule,
  ruled: !ruleIsEmpty(row.rule),
  picks: (row.picks || []).length,
  count,
  createdAt: row.createdAt || null,
});

/*
 * The cover picture. A category can name a scene to lead with; otherwise the
 * first member stands in, so a category never shows an empty frame just
 * because nobody chose one. Falls back to null only when it is genuinely empty.
 */
function coverOf(row, members) {
  if (row.cover && members.some((s) => String(s.id) === String(row.cover))) return String(row.cover);
  return members.length ? String(members[0].id) : null;
}

/* ------------------------------------------------------------ filmography
 *
 * A second kind of category, alongside the rule-based one above: not "which
 * of the scenes I hold match this", but "everything this person directed,
 * whether or not I hold it" — a want list built from StashDB rather than a
 * filter over the shelf. See stashdb.findByDirector for where the list comes
 * from and why it can only ever be a best effort.
 *
 * Same three-list shape as a rule (picks / matches / drops), because it is the
 * same problem: an automated search can miss something that belongs, and a
 * hand fix must survive the next refresh rather than being overwritten by it.
 *
 *   manifest  what the last StashDB search found — replaced whole on refresh
 *   extra     scenes added by hand, because the search missed them — kept
 *   drops     scenes thrown out by hand — kept, so a refresh cannot bring
 *             back exactly the thing you removed
 *
 * A row of this kind carries no `rule` and no `picks` — those stay on the
 * other kind. `row.kind === 'filmography'` is the one flag everything below
 * branches on.
 */

// A category's own small copy of a StashDB scene — enough to draw a tile and
// nothing that goes stale on its own, since a refresh replaces the manifest
// wholesale anyway.
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

// The manifest, the hand-added extras and the drops, folded into one ordered
// list — extras patch over a manifest entry with the same id, so re-adding a
// scene the search also found does not create a duplicate.
function filmMembers(row) {
  const drops = new Set(row.drops || []);
  const byId = new Map();
  for (const m of row.manifest || []) byId.set(m.id, m);
  for (const e of row.extra || []) byId.set(e.id, e);

  return [...byId.values()]
    .filter((m) => !drops.has(m.id))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/*
 * The uuid join alone missed every scene identified against ThePornDB rather
 * than StashDB — about a third of the library — so those showed as missing,
 * faded, with a Send to v3 under them. Title + date is the second pass, the
 * same one the StashDB search results use (discover.annotate), and a hit on it
 * is marked `probable` so the page can say so.
 */
const titleKey = (title, date) =>
  String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '') + '|' + String(date || '').slice(0, 10);

/*
 * Which of them you already hold. The join is a StashDB uuid against Stash's
 * own `stash_ids`, through whichever endpoint Stash has a StashDB stash-box
 * configured for — the same trick the tracked studios and performers use on
 * the Overview (see stashlib.trackedStashIds). Without a StashDB stash-box
 * configured at all, nothing can be marked owned and everything shows as
 * missing, which is the honest answer rather than a guess.
 *
 * `skipped` reads the acquisition ignore list — `config.tracked.ignored`, the
 * same list "Skip" writes to in the decide queue (see discover.mjs). A
 * director you do not formally track still has scenes turn up there, under
 * whichever tracked studio or performer surfaced them, and a scene you have
 * already looked at and said no to is a different thing from one you have
 * simply never seen — worth telling apart even though neither is owned.
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

// The picture a filmography category leads with: the newest one you actually
// hold, since that is the one with a thumbnail this portal generated rather
// than one borrowed from StashDB; failing that, whatever the first entry
// carries. Unlike a rule-based category's `cover`, this is already a usable
// image address rather than a Stash scene id — see categories.js's coverOf.
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
    // The category exists either way — an empty filmography that has not
    // reached StashDB yet is a valid, if unhelpful, thing to land on, and the
    // page offers Refresh again rather than the create failing outright.
  }

  return read(config, slug);
}

/*
 * The crawl itself — ported from the standalone Stash plugin this replaces
 * (a refresh_catalog.py script), because it answers the
 * question properly where a plain text search only guesses at it.
 *
 * StashDB cannot be asked "everything this person directed". What it can
 * answer is "everything under this studio network", a page at a time, with
 * each scene's own director credit along for the ride — so the real trick is
 * finding which networks to ask. That comes from Stash's own `director`
 * field: whatever you already own and have credited to him (by hand, or by a
 * scraper that fills it in — GameLink does) names the studios he works for,
 * and a network is the unit his byline actually sticks to, not one studio in
 * isolation.
 *
 * The plain text search runs too, as a smaller net alongside the network
 * crawl, for a one-off scene sitting outside every network that was seeded —
 * a studio he has worked with exactly once, which owning nothing from means
 * no network was ever seeded from it either.
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

/*
 * `all` hands back every member in one answer rather than a page of sixty. The
 * category page asks for that because its filter bar is the shelf's — built in
 * the browser out of what is in front of it — and a bar built from the first
 * page would offer the wrong studios and lie about the counts. A category is
 * a slice of the library, so this is smaller than the shelf read either way.
 */
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
    // No paging: a director's filmography runs to dozens or a couple of
    // hundred, never the thousands a rule-based category can, and the page
    // that draws it already shows-more in the browser the same way the
    // Scenes shelf does.
    const decorated = decorateFilm(filmMembers(row), scenes, endpoint, ignoredIds(config));
    const held = decorated.filter((e) => e.owned).length;

    /*
     * Where each missing one stands in Whisparr v3, so the page can offer to
     * send it — and not offer twice. One call for everything v3 holds (cached
     * thirty seconds), not one per tile. Only here, not on the index: the wall
     * of categories has no buttons to draw.
     */
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

/*
 * Every category a given scene is in. The scene page shows this, and it is the
 * other half of assigning: the place you are most likely to notice a scene
 * belongs somewhere is while you are looking at it.
 */
export async function forScene(config, sceneId) {
  const [store, { scenes }] = await Promise.all([load(), shelf(config)]);
  const id = String(sceneId);

  // Filmography categories sit out of this picker entirely: "add" there means
  // finding a StashDB credit for a director, not filing an arbitrary Stash
  // scene into a want list, and the two are not the same action wearing the
  // same chip. See categories.js's scenePicker.
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

/*
 * Editing the category itself. Only the fields actually sent are touched, so
 * the cover picker and the rule editor can each save on their own without
 * having to hold the rest of the record.
 */
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

/*
 * Putting scenes in and taking them out.
 *
 * Taking one out has to do two things, because a scene can be in a category for
 * two reasons: drop the pick, and remember the drop so the rule does not put it
 * straight back. A scene that was never a match only needs the first, but
 * writing the drop anyway costs one string and removes a whole class of "why is
 * this still here".
 */
export async function assign(config, slug, body) {
  const store = await load();
  const row = find(store, slug);

  // A filmography category has no picks and no rule to drop out of — `add`
  // and `remove` mean something different there (a StashDB link, not a Stash
  // scene id) and assignFilmography is where that is actually done.
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

/*
 * The hand order. Only picks can be reordered — the rule's haul has an order of
 * its own (newest first) and there is nowhere to put a manual position for a
 * scene that might stop matching tomorrow. Ids not currently picked are
 * ignored rather than promoted, so a stale editor cannot quietly add anything.
 */
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

/*
 * What a rule would catch, before you commit to it. The editor calls this on
 * every keystroke-settled change: a rule you cannot see the result of is a
 * rule you will get wrong, and this costs nothing beyond the cached shelf.
 */
export async function preview(config, body) {
  const { scenes } = await shelf(config);
  const rule = shapeRule(body?.rule);

  if (ruleIsEmpty(rule)) return { count: 0, scenes: [] };

  const found = scenes
    .filter((s) => matches(s, rule))
    .sort((a, b) => String(b.addedAt || b.date || '').localeCompare(String(a.addedAt || a.date || '')));

  return { count: found.length, scenes: found.slice(0, 24) };
}

/* --------------------------------------------------------- your own artwork
 *
 * A picture you uploaded, which beats the scene a category leads with.
 *
 * What counts as a picture is artwork.mjs's, shared with the performer and
 * studio uploads - three callers with one magic-byte table between them,
 * because two copies of that table are two copies that drift.
 *
 * It lives in config/covers/ rather than anywhere near the library. Nothing
 * here is a scene, Stash must never scan it, and it is the one thing about a
 * category that cannot be fetched again — so it belongs beside the store that
 * already holds the rest of what you typed.
 *
 * One file per category, named for the slug. The slug is made once at creation
 * and never follows a rename, so the file never has to be moved and there is
 * nothing to leave orphaned; uploading again replaces what is there, including
 * across formats.
 *
 * **Sniffed, not trusted.** The extension comes from the bytes rather than
 * from the name the browser sent: the name is the one part of an upload that
 * is entirely the client's, and it is what decides the filename this writes
 * and the content type it is later served as.
 */

const COVERS = join(CONFIG_DIR, 'covers');

/*
 * Where a category's picture is, for the route that serves it. Returns null
 * rather than throwing for a category with no picture, because "there isn't
 * one" is a 404 and not a fault.
 */
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
  // Stamped so the browser fetches the new one. Same URL every time otherwise,
  // and a replaced cover that still showed the old picture would read as a
  // failed upload.
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

/*
 * The words a rule can be built from, counted over the shelf you actually
 * hold. Same reasoning as the Scenes filter bar: a list of every tag Stash
 * knows would offer hundreds that match nothing here.
 */
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
