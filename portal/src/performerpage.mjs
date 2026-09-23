/*
 * The performer page's other half.
 *
 * The same join the studio page makes, asked of a person: Stash says what you
 * hold of them, StashDB says what there is, and the two meet on the performer's
 * stash id. A performer Stash never identified against StashDB still gets the
 * whole library half and says plainly why there is no number.
 *
 * The percentage is not invented here either — it is the tracked coverage the
 * Acquire page shows, read for one performer. Tracking is the switch, because a
 * catalogue read per performer on every page load is not a page load. What is
 * different from a studio is only what is asked of StashDB: a filter on
 * performers rather than on studios, one line down in discover.mjs.
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

/*
 * Tracked, and how far along. Same as the studio's: ensureCoverage returns what
 * it has and measures in the background, so a performer tracked a second ago
 * comes back pending rather than blocking the page on a catalogue read.
 */
async function coverageFor(config, stashdbId) {
  const snapshot = await discover.ensureCoverage(config).catch(() => ({ rows: [] }));
  return snapshot.rows.find((row) => row.kind === 'performer' && row.id === stashdbId) || null;
}
