/*
 * The studio page — the one screen where the two halves of the portal meet.
 *
 * Stash answers the left-hand question: what do I hold from this studio, and
 * who is in it. StashDB answers the right-hand one: what exists at all. They
 * are joined by the studio's stash id and by nothing else, so a studio Stash
 * never identified against StashDB still gets its library half and says plainly
 * why the other half is missing.
 *
 * The percentage is not invented here. It is the tracked coverage the Acquire
 * page shows, read for one studio — measured against StashDB, counted in Stash.
 * Tracking is what turns it on, because a catalogue read per studio on every
 * page load is not a page load. See discover.mjs.
 */

import * as shelf from './stashlib.mjs';
import * as stashdb from './stashdb.mjs';
import * as discover from './discover.mjs';

export async function studioPage(config, id, { page = 1, performer = null, only = null } = {}) {
  const scenesOnly = only === 'scenes';

  const view = await shelf.studioView(config, id, { page, performer, cast: !scenesOnly });
  const { stashIds, ...studio } = view.studio;

  // Paging and the cast filter come back through here; neither needs the
  // catalogue asked about again.
  if (scenesOnly) return { ...view, studio };

  const endpoint = await stashdb.endpointFor(config).catch(() => null);
  const stashdbId = stashdb.idAt(stashIds, endpoint);

  const [catalogue, coverage, wanted] = await Promise.all([
    stashdbId ? stashdb.getStudio(config, stashdbId).catch(() => null) : null,
    stashdbId ? coverageFor(config, stashdbId) : null,
    // The want list for this studio, already asked whether each has arrived —
    // the missing view is this list and needs no second trip.
    stashdbId
      ? discover.trackedSceneView(config, { studio: stashdbId }).catch(() => null)
      : null,
  ]);

  return {
    ...view,
    studio: {
      ...studio,
      stashdbId,
      // StashDB's logo, kept for the tracked list rather than for this page —
      // the page draws Stash's own artwork, which is the one it already has.
      image: catalogue?.image || null,
      network: catalogue?.parentId ? { id: catalogue.parentId, name: catalogue.detail || null } : null,
    },
    stashdb: { available: Boolean(endpoint) },
    tracked: Boolean(coverage),
    coverage,
    wanted: wanted || { scenes: [], count: 0, missing: 0 },
    cast: (view.cast || []).map(({ stashIds: ids, ...p }) => ({ ...p, stashdbId: stashdb.idAt(ids, endpoint) })),
  };
}

/*
 * Tracked, and how far along. ensureCoverage returns what it has and measures
 * in the background, so a studio tracked a second ago comes back pending rather
 * than blocking the page on a catalogue read.
 */
async function coverageFor(config, stashdbId) {
  const snapshot = await discover.ensureCoverage(config).catch(() => ({ rows: [] }));
  return snapshot.rows.find((row) => row.kind === 'studio' && row.id === stashdbId) || null;
}
