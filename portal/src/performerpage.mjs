/*
 * The performer page's StashDB half: Stash says what you hold, StashDB what
 * exists, joined on the stash id. The percentage is tracked coverage for
 * this performer; tracking turns it on.
 */

import * as shelf from './stashlib.mjs';
import * as stashdb from './stashdb.mjs';
import * as discover from './discover.mjs';

export async function performerPage(config, id, { page = 1, only = null } = {}) {
  const view = await shelf.performerView(config, id, { page });

  // Paging the shelf is the same page asking for more of what it already has;
  // nothing about the catalogue changed between page one and page two.
  if (only === 'scenes') return view;

  const endpoint = await stashdb.endpointFor(config).catch(() => null);
  const stashdbId = stashdb.idAt(view.performer.stash_ids, endpoint);

  const [catalogue, coverage, wanted] = await Promise.all([
    stashdbId ? stashdb.getPerformer(config, stashdbId).catch(() => null) : null,
    stashdbId ? coverageFor(config, stashdbId) : null,
    // The want list for this performer, already asked whether each has arrived.
    stashdbId
      ? discover.trackedSceneView(config, { performer: stashdbId }).catch(() => null)
      : null,
  ]);

  return {
    ...view,
    performer: {
      ...view.performer,
      stashdbId,
      // StashDB's photograph, kept for the tracked list rather than for this
      // page — this one draws Stash's own, which it already has.
      image: catalogue?.image || null,
    },
    stashdb: { available: Boolean(endpoint) },
    tracked: Boolean(coverage),
    coverage,
    wanted: wanted || { scenes: [], count: 0, missing: 0 },
  };
}

/* Tracked coverage. Returns what it has and measures in the background. */
async function coverageFor(config, stashdbId) {
  const snapshot = await discover.ensureCoverage(config).catch(() => ({ rows: [] }));
  return snapshot.rows.find((row) => row.kind === 'performer' && row.id === stashdbId) || null;
}
