/*
 * The Import overview: the tracked catalogues summed, and suggestions
 * from your StashDB favourites (studios and performers), then trending.
 * Suggestions are built in the background and cached.
 */

import * as stashdb from './stashdb.mjs';
import * as discover from './discover.mjs';
import { stashConfigured } from './config.mjs';

const TTL = 30 * 60 * 1000;
const ROW = 12; // scenes per suggestion row

let cache = null;
let building = null;

export const forgetOverview = () => { cache = null; };

/* Only suggestions are cached; the summary is recomputed from memory each time. */
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

/*
 * ------------------------------------------------------------ the summary
 *
 * The tracked rows added up. `decisions` is the headline.
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

  /* Drop suggestions you own or skipped. */
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

  /* Studios and performers as separate rows. */
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
