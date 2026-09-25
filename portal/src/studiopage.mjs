/*
 * The studio page: Stash says what you hold and who's in it; StashDB says
 * what exists. Joined on the stash id. The percentage is tracked coverage
 * for this studio; tracking turns it on. See discover.mjs.
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

/* Tracked coverage. Returns what it has and measures in the background. */
async function coverageFor(config, stashdbId) {
  const snapshot = await discover.ensureCoverage(config).catch(() => ({ rows: [] }));
  return snapshot.rows.find((row) => row.kind === 'studio' && row.id === stashdbId) || null;
}
