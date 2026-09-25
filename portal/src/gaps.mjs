/*
 * What you're missing of the performers you have most of. Bounded, built in
 * the background, cached half an hour. Studios come from the home page's
 * coverage table instead.
 */

import * as tpdb from './tpdb.mjs';
import * as stash from './stash.mjs';
import { stashConfigured } from './config.mjs';

const TTL = 30 * 60 * 1000;
const PERFORMERS = 12; // how many of your own to ask TPDB about
const MAX_PAGES = 8; // 800 scenes each, which covers all but the most prolific

let cache = null;
let building = null;

export const forgetGaps = () => { cache = null; };

export function gapsSnapshot() {
  return { performers: cache?.performers || null, building: Boolean(building), builtAt: cache?.at || null };
}

export async function ensureGaps(config, { force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL) return gapsSnapshot();
  if (building) return gapsSnapshot();

  building = (async () => {
    try {
      cache = { at: Date.now(), performers: await performerGaps(config) };
    } catch (err) {
      console.warn('[tpdbarr] gaps build failed -', err.message);
    } finally {
      building = null;
    }
  })();

  return gapsSnapshot();
}

const byDate = (a, b) => String(b.date).localeCompare(String(a.date));

async function performerGaps(config) {
  if (!stashConfigured(config)) return [];

  /* TPDB is keyed on its own uuid, so StashDB-only performers can't be asked here. */
  const { performers } = await stash.libraryPerformers(config, { limit: PERFORMERS });
  const owned = performers.filter((p) => p.uuid);
  if (!owned.length) return [];

  /* Matched on fingerprints in Stash, not Whisparr state. */
  const index = await stash.fingerprintIndex(config).catch(() => null);
  const out = [];

  for (const person of owned) {
    const catalogue = await tpdb
      .performerCatalogue(config, person.uuid, { maxPages: MAX_PAGES })
      .catch(() => null);
    if (!catalogue?.scenes.length) continue;

    const { scenes, complete } = catalogue;
    // TPDB stash id and title + date as well as fingerprints: a scene Stash
    // has no phash for yet is still held, and was being counted as a gap.
    const found = (await stash.matchScenes(config, scenes).catch(() => ({ found: new Map() }))).found;
    const missing = scenes.filter((scene) =>
      !found.has(scene.id) && !(index && stash.matchByFingerprints(index, scene)));
    missing.sort(byDate);

    /* Nothing matched at all means the match failed; say nothing. */
    const held = scenes.length - missing.length;
    if (complete && person.count > 0 && held === 0) continue;

    out.push({
      uuid: person.uuid,
      stashId: person.id,
      name: person.name,
      held,
      inStash: person.count,
      onTpdb: scenes.length,
      complete,
      missing: missing.length,
      // A couple of covers so the rail has something to show for the number.
      newest: missing.slice(0, 3).map((s) => ({
        guid: s.guid,
        title: s.title,
        date: s.date,
        image: s.image || s.still || s.poster || null,
      })),
    });
  }

  return out.filter((p) => p.missing).sort((a, b) => b.missing - a.missing);
}
