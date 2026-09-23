/*
 * The Import overview.
 *
 * The first page of the import side, and it answers two questions rather than
 * one: what am I already collecting, and what is worth a look that I am not.
 *
 * The first half is the tracked catalogues, summed — how many decisions are
 * outstanding across all of them, how much of what you said you want you
 * actually have. That summary is the reason this page exists: the Tracked page
 * lists seven rows, and seven rows do not tell you whether you are behind.
 *
 * The second half is suggestions, and every one of them comes from something
 * you have already said. Favourites are marked on StashDB itself, so this page reads them rather than inventing a
 * taste model. Trending is the one row that is not about you, and it is last
 * for that reason.
 *
 * Slow enough to be built in the background and served from cache, like the
 * console. Nothing here changes minute to minute.
 */

import * as stashdb from './stashdb.mjs';
import * as discover from './discover.mjs';
import { stashConfigured } from './config.mjs';

const TTL = 30 * 60 * 1000;
const ROW = 12; // scenes per suggestion row

let cache = null;
let building = null;

export const forgetOverview = () => { cache = null; };

/*
 * The summary is recomputed every time and only the suggestions are cached.
 *
 * They cost wildly different things: the summary is a sum over a snapshot
 * already in memory, the suggestions are three StashDB reads and an ownership
 * pass. Caching them together meant that a restart — which empties the coverage
 * cache — froze a page of zeros in place for half an hour, because the summary
 * was built from measurements that had not happened yet.
 */
export function overviewSnapshot(config) {
  const { rows } = discover.coverageSnapshot(config);

  return {
    overview: {
      summary: summarise(rows),
      suggestions: cache?.suggestions || [],
      available: cache?.available ?? true,
    },
    building: Boolean(building) || !cache,
    builtAt: cache?.at || null,
  };
}

export async function ensureOverview(config, { force = false } = {}) {
  if (force || (!building && (!cache || Date.now() - cache.at >= TTL))) {
    building = (async () => {
      try {
        cache = { at: Date.now(), ...(await buildSuggestions(config)) };
      } catch (err) {
        console.warn('[tpdbarr] overview build failed -', err.message);
      } finally {
        building = null;
      }
    })();
  }

  return overviewSnapshot(config);
}

/* ------------------------------------------------------------ the summary
 *
 * The tracked rows added up. `decisions` is the headline: it is the only number
 * here that is a job rather than a fact, and a growing one means the catalogues
 * have moved on without you.
 */
function summarise(rows) {
  const measured = rows.filter((r) => !r.pending);

  const sum = (key) => measured.reduce((total, row) => total + (row[key] || 0), 0);
  const counted = sum('counted');
  const have = sum('have');

  return {
    tracking: rows.length,
    studios: rows.filter((r) => r.kind === 'studio').length,
    performers: rows.filter((r) => r.kind === 'performer').length,
    measuring: rows.length - measured.length,
    counted,
    have,
    missing: sum('missing'),
    decisions: sum('undecided'),
    ignored: sum('ignored'),
    pct: counted ? Math.round((have / counted) * 100) : null,
    // Whoever has moved furthest ahead of you, so the summary can point at one.
    behind: measured
      .filter((r) => r.undecided)
      .sort((a, b) => b.undecided - a.undecided)
      .slice(0, 3)
      .map((r) => ({ kind: r.kind, id: r.id, name: r.name, undecided: r.undecided })),
  };
}

/* -------------------------------------------------------- the suggestions */

const row = async (config, input, label, why) => {
  const { scenes } = await stashdb.queryScenes(config, stashdb.sceneQuery({ ...input, perPage: ROW * 2 }));
  const annotated = await discover.annotate(config, scenes);

  /*
   * A suggestion you already own is not a suggestion, and one you have already
   * said no to is worse than that. Both come out here rather than being drawn
   * greyed — this row is short, and every slot spent on a decision you already
   * made is one not spent on a scene you have not seen.
   */
  return {
    label,
    why,
    scenes: annotated.filter((s) => !s.stash && s.disposition !== 'ignored').slice(0, ROW),
  };
};

async function buildSuggestions(config) {
  if (!stashConfigured(config) || !(await stashdb.available(config))) {
    return { suggestions: [], available: false };
  }

  const report = (label) => (err) => {
    console.warn(`[tpdbarr] overview row "${label}" failed -`, err.message);
    return null;
  };

  /*
   * Studios and performers separately rather than one favourites feed. They are
   * different questions — "my studios have released something" is a shelf you
   * are filling, "my performers have" is a person you follow — and StashDB's
   * FavoriteFilter can tell them apart, so there is no reason to blur them.
   */
  const suggestions = await Promise.all([
    row(config, { favorites: 'STUDIO', sort: 'DATE' }, 'New from your studios',
      'the newest from the 107 studios you have favourited on StashDB').catch(report('studios')),
    row(config, { favorites: 'PERFORMER', sort: 'DATE' }, 'New from your performers',
      'the newest from the performers you have favourited on StashDB').catch(report('performers')),
    row(config, { sort: 'TRENDING' }, 'Trending on StashDB',
      'what everyone else is looking at — the one row here that is not about you').catch(report('trending')),
  ]);

  return { suggestions: suggestions.filter((r) => r && r.scenes.length), available: true };
}
