/*
 * One shelf for everything that is a film.
 *
 * Two things in Stash mean "a film" and they are different objects. A **group**
 * is a release assembled from several scene files. A **feature** is one long
 * file that is the whole release by itself. Stash has no single type for that
 * idea, so this module makes one: it reads both, flattens them into the same
 * shape, and lets the page treat them alike while still saying which is which.
 *
 * Merged in memory rather than by query, and that is a deliberate ceiling.
 * Groups and scenes take different filter types — a GroupFilterType cannot ask
 * about performers the way a SceneFilterType can — so any server-side combined
 * filter would either be two half-filters pretending to be one, or a lie about
 * the count. At fifty-odd films the whole set fits in one response and the page
 * filters instantly with no round trip. If this ever reaches thousands, that is
 * the assumption to revisit, and it will need real paging rather than tuning.
 *
 * A group's cast is the union of its scenes' casts, because a group carries a
 * performer_count and no performers of its own.
 */

import { gql } from './stash.mjs';

const MOVIE_ROOT = '/movies/';

const byName = (a, b) => String(a.name).localeCompare(String(b.name));
const yearOf = (date) => (date ? Number(String(date).slice(0, 4)) || null : null);

// ------------------------------------------------------------------ reading

async function groups(config) {
  const data = await gql(config, `{
    findGroups(filter: {per_page: -1, sort: "name", direction: ASC}) {
      groups {
        id name date duration rating100 synopsis director urls scene_count front_image_path
        studio { id name }
        tags { id name }
        scenes { id performers { id name } tags { id name } }
      }
    }
  }`);

  return (data.findGroups.groups || []).map((g) => {
    // A group has performer_count but no performers; its cast is its scenes'.
    const cast = new Map();
    const tags = new Map((g.tags || []).map((t) => [t.id, t]));
    for (const scene of g.scenes || []) {
      for (const p of scene.performers || []) cast.set(p.id, p);
      for (const t of scene.tags || []) tags.set(t.id, t);
    }

    return {
      kind: 'group',
      id: g.id,
      title: g.name,
      date: g.date || null,
      year: yearOf(g.date),
      studio: g.studio || null,
      performers: [...cast.values()].sort(byName),
      tags: [...tags.values()].sort(byName),
      cover: `/media/group/${g.id}`,
      href: `#/library/group/${g.id}`,
      duration: g.duration || null,
      sceneCount: g.scene_count || 0,
      rating: g.rating100 ?? null,
      details: g.synopsis || '',
      director: g.director || null,
      urls: g.urls || [],
      // Groups have no watch state of their own; the scenes inside carry it.
      playCount: null,
      resume: null,
      organized: null,
    };
  });
}

async function features(config) {
  const data = await gql(
    config,
    `query($f: SceneFilterType) {
       findScenes(scene_filter: $f, filter: {per_page: -1, sort: "title", direction: ASC}) {
         scenes {
           id title date rating100 details organized play_count resume_time urls
           studio { id name }
           performers { id name }
           tags { id name }
           files { duration width height path }
         }
       }
     }`,
    { f: { path: { value: MOVIE_ROOT, modifier: 'INCLUDES' } } }
  );

  return (data.findScenes.scenes || []).map((s) => {
    const file = s.files?.[0] || null;

    return {
      kind: 'film',
      id: s.id,
      title: s.title || '(untitled)',
      date: s.date || null,
      year: yearOf(s.date),
      studio: s.studio || null,
      performers: (s.performers || []).slice().sort(byName),
      tags: (s.tags || []).slice().sort(byName),
      cover: `/media/scene/${s.id}/screenshot`,
      href: `#/library/scene/${s.id}`,
      duration: file?.duration ? Math.round(file.duration) : null,
      // One file is the whole release, which is the entire distinction here.
      sceneCount: 1,
      rating: s.rating100 ?? null,
      details: s.details || '',
      director: null,
      urls: s.urls || [],
      playCount: s.play_count || 0,
      resume: s.resume_time || 0,
      organized: Boolean(s.organized),
      resolution: file?.height ? resolution(file.height) : null,
      path: file?.path || null,
    };
  });
}

function resolution(height) {
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  return height + 'p';
}

// ------------------------------------------------------------------ facets

/*
 * What the filter bar can offer, counted from what is actually on the shelf.
 *
 * Built from the films themselves rather than from Stash's full tag and
 * performer lists: offering all 1286 performers when eleven of them are in a
 * film here would make the control useless. A filter should only ever suggest
 * something that changes what you see.
 */
function facetsFrom(films) {
  const tally = (pick) => {
    const seen = new Map();
    for (const film of films) {
      for (const item of pick(film)) {
        if (!item) continue;
        const row = seen.get(item.id) || { id: item.id, name: item.name, count: 0 };
        row.count++;
        seen.set(item.id, row);
      }
    }
    return [...seen.values()].sort((a, b) => b.count - a.count || byName(a, b));
  };

  const years = new Map();
  for (const film of films) {
    if (!film.year) continue;
    years.set(film.year, (years.get(film.year) || 0) + 1);
  }

  return {
    studios: tally((f) => (f.studio ? [f.studio] : [])),
    performers: tally((f) => f.performers),
    tags: tally((f) => f.tags),
    years: [...years.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year),
  };
}

export async function filmsView(config) {
  const [asGroups, asFeatures] = await Promise.all([groups(config), features(config)]);
  const films = [...asGroups, ...asFeatures].sort((a, b) => String(a.title).localeCompare(String(b.title)));

  return {
    films,
    facets: facetsFrom(films),
    counts: {
      total: films.length,
      groups: asGroups.length,
      features: asFeatures.length,
    },
  };
}

// ------------------------------------------------------------------ writing

/*
 * Removing one.
 *
 * The file is left alone unless asked for explicitly, and the asking has to
 * come from the caller rather than being inferred: everything else in this app
 * can be undone by running something again, and this cannot. A group destroyed
 * takes no files with it in any case — it is a record about scenes, not a
 * thing on disk.
 */
export async function remove(config, kind, id, { deleteFile = false } = {}) {
  if (kind === 'group') {
    await gql(config, 'mutation($id: ID!) { groupDestroy(input: {id: $id}) }', { id });
    return { removed: 'group', id, fileDeleted: false };
  }

  await gql(
    config,
    'mutation($input: SceneDestroyInput!) { sceneDestroy(input: $input) }',
    { input: { id, delete_file: Boolean(deleteFile), delete_generated: true } }
  );

  return { removed: 'film', id, fileDeleted: Boolean(deleteFile) };
}

/*
 * Artwork. A group keeps its cover in front_image, a scene in cover_image, and
 * both take the same data URL — so the only thing that differs is the field.
 */
export async function setCover(config, kind, id, dataUrl) {
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl)) {
    throw new Error('That is not an image this can set.');
  }

  if (kind === 'group') {
    await gql(
      config,
      'mutation($input: GroupUpdateInput!) { groupUpdate(input: $input) { id } }',
      { input: { id, front_image: dataUrl } }
    );
  } else {
    await gql(
      config,
      'mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }',
      { input: { id, cover_image: dataUrl } }
    );
  }

  return { id, kind };
}

/* ------------------------------------------------------------ rescanning
 *
 * Stash's own scrapers, not TMDB.
 *
 * TMDB barely knows this catalogue, whereas data18, Adult Empire, Bang and
 * AdultFilmDatabase return a full record and both covers from one address —
 * and Stash walks through the age gates and captchas that turn a plain fetch
 * away, which is why the reading is asked of Stash rather than done here.
 *
 * The film scrapers are *group* scrapers, because a release is what they
 * describe. That is right for both kinds: a single-file feature is a release
 * that happens to be one file, so the same record maps onto it — the name
 * becomes the title, the synopsis the details, the front image the cover.
 */

const SCRAPED_TO_SCENE = {
  name: 'title',
  date: 'date',
  director: 'director',
  synopsis: 'details',
  front_image: 'cover_image',
};

export async function scrapeFrom(config, url) {
  const data = await gql(
    config,
    `query($u: String!) {
       scrapeGroupURL(url: $u) {
         name date duration director synopsis urls front_image back_image
         studio { stored_id name }
       }
     }`,
    { u: url }
  );

  if (!data.scrapeGroupURL) throw new Error('No scraper here could read that address.');
  return data.scrapeGroupURL;
}

/*
 * `fields` is what the dialog ticked, so a scrape that got the cover right and
 * the title wrong can be taken in part. Studio is never sent: the scraper knows
 * a name and Stash wants an id.
 */
export async function applyScraped(config, kind, id, fields, { url = null } = {}) {
  const input = { id };

  if (kind === 'group') {
    for (const key of ['name', 'date', 'director', 'synopsis', 'front_image', 'back_image']) {
      if (fields[key]) input[key] = fields[key];
    }
    if (url) input.urls = [...new Set([...(fields.existingUrls || []), url])];

    const data = await gql(
      config,
      'mutation($input: GroupUpdateInput!) { groupUpdate(input: $input) { id } }',
      { input }
    );
    return data.groupUpdate;
  }

  for (const [from, to] of Object.entries(SCRAPED_TO_SCENE)) {
    if (fields[from]) input[to] = fields[from];
  }
  if (url) input.urls = [...new Set([...(fields.existingUrls || []), url])];

  const data = await gql(
    config,
    'mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }',
    { input }
  );
  return data.sceneUpdate;
}
