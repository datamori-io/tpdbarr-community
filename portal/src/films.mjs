/*
 * One shelf for films: Stash groups (releases built from scene files) and
 * features (one long file), flattened into one shape.
 *
 * Merged in memory, not by query: groups and scenes take different filter
 * types. Fine at dozens of films; thousands would need real paging.
 * A group's cast is the union of its scenes' casts.
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

/* Filter options counted from the films on the shelf. */
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

/* Remove one. The file only goes if the caller asks. Deleting a group takes no files. */
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

/* Cover: front_image on a group, cover_image on a scene. Same data URL. */
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

/*
 * ------------------------------------------------------------ rescanning
 *
 * Via Stash's group scrapers (data18, Adult Empire, Bang, AdultFilmDatabase),
 * which get past age gates and captchas. Group records map onto features too.
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

/* Apply the ticked fields. Studio is never sent (name vs id). */
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
