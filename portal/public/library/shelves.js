/*
 * The four filtered shelves — scenes, performers, studios, galleries — and the
 * one read of the whole library they all filter in the browser.
 */

import { api, el } from '../util.js';
import { stashdbCard } from '../catalogue.js';
import { UNSAID, claim, failedIn, heading, holds, loadingIn, shell, spoken } from './core.js';
import { PEOPLE_SORTS, entityTile, grid, missingRail, orderPeople, shaped, shelfIndex, shelfPage, tile } from './tiles.js';
import { coverageBadge, trackedEntityRail, trackedOn, trackedRows } from './tracked.js';

export async function showList(key) {
  const mine = claim();
  loadingIn('#/library/scenes');
  try {
    const data = await api(`/api/library/list/${key}`);
    if (!holds(mine)) return;
    shell('#/library/scenes',
      heading(data.title, `${data.count} scene${data.count === 1 ? '' : 's'}`),
      grid(data.scenes));
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/scenes', err);
  }
}

/* ----------------------------------------------------------------- scenes
 *
 * The shelf, with the questions you actually ask of one: what is it, whose is
 * it, who is in it, what is it about, and when. Resolution and watched-state
 * are deliberately not here — at this size they are noise, and the tile
 * already carries both.
 *
 * One read of the whole library backs this page and the two below it. That is
 * affordable exactly once — a couple of megabytes, cached on the server for
 * five minutes and here for the same — and a bar built from the first sixty
 * scenes would offer the wrong studios and lie about the counts.
 */

const SHELF_TTL = 5 * 60 * 1000;
let shelfMemo = null;

/*
 * Kind is not a field Stash has — it is read off the tags, first match wins.
 * More than half the shelf says nothing at all, so it lands in "Not said".
 */
const KINDS = [
  ['Solo', ['solo']],
  ['Lesbian', ['lesbian', 'girl/girl']],
  ['Group', ['group sex', 'orgy', 'foursome', 'gangbang', 'moresome', 'fivesome']],
  ['Threesome', ['threesome']],
  ['Couple', ['twosome', 'couple', 'boy/girl']],
];

function kindOf(scene) {
  const tags = (scene.tags || []).map((t) => t.toLowerCase());
  for (const [name, words] of KINDS) {
    if (tags.some((tag) => words.some((word) => tag.includes(word)))) return name;
  }
  return UNSAID;
}

// Search reads the things you would name out loud. Tags have their own
// dropdown, and matching them here as well would make it hard to tell which of
// the two you were looking at.
const sceneHaystack = (scene) => [
  scene.title,
  scene.studio?.name,
  ...scene.performers.map((p) => p.name),
].filter(Boolean).join(' ').toLowerCase();

/*
 * The two fields the shelf bar needs and Stash does not have: what kind of
 * scene it is, and the words you would search for it by. A category page reads
 * its own scenes rather than the whole library, so this is shared rather than
 * inlined — a tile filtered on one page must be filtered the same way on the
 * other.
 */
export function shapeScene(scene) {
  const shaped = { ...scene, kind: kindOf(scene) };
  shaped.haystack = sceneHaystack(shaped);
  return shaped;
}

export async function shelfScenes() {
  if (shelfMemo && Date.now() - shelfMemo.at < SHELF_TTL) return shelfMemo.scenes;

  const data = await api('/api/library/shelf');
  const scenes = data.scenes.map(shapeScene);

  shelfMemo = { scenes, at: Date.now() };
  return scenes;
}

export const SCENE_FACETS = [
  { key: 'kind', any: 'Any kind', of: (s) => [s.kind] },
  { key: 'studio', any: 'Any studio', of: (s) => (s.studio ? [s.studio.name] : []) },
  { key: 'performer', any: 'Anyone', of: (s) => s.performers.map((p) => p.name) },
  { key: 'tag', any: 'Any tag', of: (s) => s.tags },
  { key: 'year', any: 'Any year', of: (s) => (s.date ? [s.date.slice(0, 4)] : []) },
];

/*
 * Recently Added leads, and so is the shelf's own order: what you want off this
 * page nine times in ten is what landed since you last looked, not what a
 * studio happened to release first.
 */
export const SCENE_SORTS = [
  ['added', 'Recently Added'],
  ['newest', 'Newest'],
  ['title', 'Title'],
  ['longest', 'Longest'],
  ['studio', 'Most in that studio'],
];

/*
 * "Most in that studio" is not a field either: it orders by how much of that
 * studio is on the shelf, so the sites you have collected most of come first
 * and their scenes arrive together. Counted over what is showing rather than
 * the whole library — a filtered shelf should sort by what is in front of you.
 */
export function orderScenes(scenes, sort) {
  const by = [...scenes];

  // Released when, versus arrived when. A studio's back catalogue imported
  // last night is old by `date` and the newest thing you own by `addedAt`.
  if (sort === 'added') {
    return by.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  }

  if (sort === 'title') return by.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'longest') return by.sort((a, b) => (b.duration || 0) - (a.duration || 0));

  if (sort === 'studio') {
    const held = new Map();
    for (const s of scenes) {
      const name = s.studio?.name || '';
      held.set(name, (held.get(name) || 0) + 1);
    }
    return by.sort((a, b) => {
      const an = a.studio?.name || '';
      const bn = b.studio?.name || '';
      return (held.get(bn) - held.get(an)) || an.localeCompare(bn) || (b.date || '').localeCompare(a.date || '');
    });
  }

  return by.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/*
 * The two shelves this page can be.
 *
 * What you hold is the page. What you monitored and have not got is the same
 * question turned round, and it used to lead the page as a rail — which put a
 * handful of cards above the whole library every time you opened it. As a
 * second view it is out of the way until you ask for it, and it gets the whole
 * page rather than a row you scroll sideways.
 */
const MONITORED_WALL = 120;

function monitoredWall(wanted, reload) {
  const missing = (wanted?.scenes || []).filter((s) => !s.stash);

  if (!missing.length) {
    return el('div', {}, el('div', { className: 'empty small' }, wanted?.count
      ? 'Everything you monitored has arrived.'
      : 'Nothing monitored yet. Mark scenes on a studio, a performer or the Import pages.'));
  }

  const cards = el('div', { className: 'cards' });
  const more = el('button', { className: 'act showmore', type: 'button' });

  const card = (scene) => {
    // Untracked from here, a card is answering a question it is no longer part
    // of, so it goes rather than sitting there relabelled.
    const node = stashdbCard(scene, {
      onTrackChange: (_scene, tracked) => { if (!tracked) node.remove(); return reload(); },
    });
    return node;
  };

  // Paged the same way the shelf is, and for the same reason: a want list of a
  // couple of thousand is a couple of thousand stills off StashDB's CDN.
  let shown = 0;
  const fill = () => {
    const next = missing.slice(shown, shown + MONITORED_WALL);
    cards.append(...next.map(card));
    shown += next.length;
    more.hidden = shown >= missing.length;
    more.textContent = `Show ${Math.min(MONITORED_WALL, missing.length - shown)} more`;
  };

  more.onclick = fill;
  fill();

  return el('div', {}, cards, more);
}

export async function showScenes(query = '') {
  const mine = claim();
  loadingIn('#/library/scenes');

  try {
    const [scenes, gaps, wanted] = await Promise.all([
      shelfScenes(),
      api('/api/library/gaps').catch(() => null),
      api('/api/acquire/tracked/scenes').catch(() => null),
    ]);

    if (!holds(mine)) return;

    const missing = (wanted?.scenes || []).filter((s) => !s.stash);

    /*
     * The switch sits under the heading rather than in the shelf bar: it says
     * which shelf you are reading, and the bar below it filters whichever one
     * that is. The held shelf keeps its bar, its wall and its Show more between
     * switches — they are hidden, not rebuilt, so a filter you set survives a
     * look at the want list.
     */
    const toggle = el('div', { className: 'viewswitch shelfviews' });
    const monitored = el('div', {});
    let view = 'have';

    const page = shelfPage({
      section: '#/library/scenes',
      title: 'Scenes',
      note: 'in your library',
      items: scenes,
      facets: SCENE_FACETS,
      sorts: SCENE_SORTS,
      order: orderScenes,
      card: tile,
      query,
    });

    const [feedhead, ...held] = page;
    const heldBox = el('div', {}, held);
    const note = feedhead.querySelector('.muted');
    let heldNote = note.textContent;

    const reload = async () => {
      const next = await api('/api/acquire/tracked/scenes').catch(() => null);
      if (!holds(mine)) return;
      monitored.replaceChildren(monitoredWall(next, reload));
    };

    const pick = (next) => {
      if (next === view) return;
      if (view === 'have') heldNote = note.textContent;
      view = next;

      heldBox.hidden = view !== 'have';
      monitored.hidden = view !== 'monitored';
      note.textContent = view === 'have'
        ? heldNote
        : `${missing.length.toLocaleString()} monitored, not here yet`;

      for (const chip of toggle.children) chip.classList.toggle('on', chip.dataset.view === view);
    };

    toggle.append(...[
      ['have', `In your library (${scenes.length.toLocaleString()})`],
      ['monitored', `Monitored, not here (${missing.length.toLocaleString()})`],
    ].map(([key, label]) => {
      const chip = el('button', { type: 'button', className: 'chip' + (key === 'have' ? ' on' : '') }, label);
      chip.dataset.view = key;
      chip.onclick = () => pick(key);
      return chip;
    }));

    monitored.hidden = true;
    monitored.append(monitoredWall(wanted, reload));

    shell('#/library/scenes',
      feedhead,
      toggle,
      heldBox,
      monitored,
      gapRails(gaps, 'scenes')
    );
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/scenes', err);
  }
}

const PERFORMER_FACETS = [
  { key: 'gender', any: 'Any gender', of: (p) => [p.gender] },
  { key: 'country', any: 'Anywhere', of: (p) => [p.country] },
  { key: 'studio', any: 'Any studio', of: (p) => p.studios },
  { key: 'kind', any: 'Any kind', of: (p) => p.kinds },
  { key: 'year', any: 'Any year', of: (p) => p.years },
  { key: 'tracked', any: 'Tracked or not', of: (p) => [p.trackedAs] },
];

const STUDIO_FACETS = [
  { key: 'performer', any: 'Anyone', of: (s) => s.performers },
  { key: 'kind', any: 'Any kind', of: (s) => s.kinds },
  { key: 'year', any: 'Any year', of: (s) => s.years },
  { key: 'tracked', any: 'Tracked or not', of: (s) => [s.trackedAs] },
];

export async function showPerformers(query = '') {
  const mine = claim();
  loadingIn('#/library/performers');
  try {
    const [{ held, missing }, scenes, gaps, coverage] = await Promise.all([
      api('/api/library/performers'),
      shelfScenes(),
      api('/api/library/gaps').catch(() => null),
      trackedRows(),
    ]);

    if (!holds(mine)) return;

    const index = shelfIndex(scenes, (scene) => scene.performers);
    const people = held.map((p) => ({
      ...shaped(p, index),
      gender: spoken(p.gender),
      country: p.country || UNSAID,
      ...trackedOn(coverage.byId, 'performer', p.stashdbId),
    }));

    shell('#/library/performers',
      trackedEntityRail(coverage.rows, 'performer', people),
      shelfPage({
        section: '#/library/performers',
        title: 'Performers',
        note: 'you hold files of',
        placeholder: 'Search by name…',
        items: people,
        facets: PERFORMER_FACETS,
        sorts: PEOPLE_SORTS,
        order: orderPeople,
        wall: 'facets',
        card: (p) => entityTile({
          name: p.name,
          image: p.art ? `/media/performer/${p.id}` : null,
          meta: `${p.held} in your library`,
          href: `#/library/performer/${p.id}`,
          favorite: p.favorite,
          badge: coverageBadge(p.coverage),
        }),
        query,
      }),
      gapRails(gaps, 'performers'),
      missing.length
        ? missingRail({
            title: 'In Stash, nothing in the library',
            note: 'names that arrived in a cast list, with no file of their own',
            count: String(missing.length),
            items: missing.slice(0, 60).map((p) => entityTile({
              name: p.name,
              image: p.art ? `/media/performer/${p.id}` : null,
              meta: p.known ? `${p.known} still importing` : 'no files',
              faded: true,
            })),
          })
        : null
    );
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/performers', err);
  }
}

export async function showStudios(query = '') {
  const mine = claim();
  loadingIn('#/library/studios');
  try {
    const [{ held, missing }, scenes, gaps, coverage] = await Promise.all([
      api('/api/library/studios'),
      shelfScenes(),
      api('/api/library/gaps').catch(() => null),
      trackedRows(),
    ]);

    if (!holds(mine)) return;

    const index = shelfIndex(scenes, (scene) => (scene.studio ? [scene.studio] : []));
    const studios = held.map((s) => ({ ...shaped(s, index), ...trackedOn(coverage.byId, 'studio', s.stashdbId) }));

    shell('#/library/studios',
      trackedEntityRail(coverage.rows, 'studio', studios),
      shelfPage({
        section: '#/library/studios',
        title: 'Studios',
        note: 'you hold files from',
        placeholder: 'Search by name…',
        items: studios,
        facets: STUDIO_FACETS,
        sorts: PEOPLE_SORTS,
        order: orderPeople,
        wall: 'facets',
        card: (s) => entityTile({
          name: s.name,
          shape: 'logo',
          image: s.art ? `/media/studio/${s.id}` : null,
          meta: `${s.held} in your library`,
          href: `#/library/studio/${s.id}`,
          badge: coverageBadge(s.coverage),
        }),
        query,
      }),
      gapRails(gaps, 'studios'),
      missing.length
        ? missingRail({
            title: 'In Stash, nothing in the library',
            note: 'a studio on a scene record, with no file behind it',
            count: String(missing.length),
            items: missing.slice(0, 60).map((s) => entityTile({
              name: s.name,
              shape: 'logo',
              image: s.art ? `/media/studio/${s.id}` : null,
              meta: s.known ? `${s.known} still importing` : 'no files',
              faded: true,
            })),
          })
        : null
    );
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/studios', err);
  }
}

/* -------------------------------------------------------------- the gaps
 *
 * The TPDB half: not "what exists" — TPDB's directory is meaningless at this
 * size — but what is missing from the people and sites you already collect.
 * Ranked by the size of the gap, because that is the only ordering that makes
 * the row worth scrolling.
 */

function gapRails(gaps, kind) {
  if (!gaps) return null;

  if (gaps.building && !gaps.performers) {
    return el('div', { className: 'empty small' }, 'Working out what you are missing on ThePornDB…');
  }

  if (kind === 'studios') {
    const rows = gaps.studios || [];
    if (!rows.length) return null;

    return missingRail({
      title: 'Missing from studios you collect',
      note: 'counted in Stash against the full catalogue',
      count: String(rows.length),
      items: rows.map((r) => entityTile({
        name: r.title,
        shape: 'logo',
        image: r.poster || null,
        meta: `${r.missing} you do not have of ${r.total}`,
        href: `#/site/${r.siteId}`,
      })),
    });
  }

  const people = gaps.performers || [];
  if (!people.length) return null;

  if (kind === 'performers') {
    return missingRail({
      title: 'Missing from performers you collect',
      note: 'your biggest gaps on ThePornDB',
      count: String(people.length),
      items: people.map((p) => entityTile({
        name: p.name,
        image: `/media/performer/${p.stashId}`,
        // Say which it is: a gap counted against a partial catalogue is not
        // the same claim as one counted against the whole of it.
        meta: p.complete
          ? `${p.missing} you do not have of ${p.onTpdb}`
          : `${p.missing} you do not have of the newest ${p.onTpdb}`,
        href: `#/performer/${p.uuid}`,
      })),
    });
  }

  // On the scenes page the gap is worth showing as the scenes themselves.
  const scenes = people.flatMap((p) => p.newest.map((s) => ({ ...s, who: p.name })));
  if (!scenes.length) return null;

  return missingRail({
    title: 'Newest you do not have',
    note: 'from the performers you collect, on ThePornDB',
    items: scenes.slice(0, 24).map((s) => entityTile({
      name: s.title,
      shape: 'wide',
      image: s.image || null,
      meta: [s.who, s.date].filter(Boolean).join(' · '),
      href: s.guid ? `#/scene/${s.guid}` : null,
    })),
  });
}
