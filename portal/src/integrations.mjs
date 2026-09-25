/*
 * Integrations: is everything up, and what's in flight, all read live.
 *
 *   1. Whisparr grabs it                    -> the downloader queue
 *   2. it lands in Whisparr's own root      -> not in Stash yet
 *   3. FileFlows encodes it                 -> /Import Folder
 *   4. it gets edited by hand, sometimes    -> /pc-import
 *   5. Stash files it                       -> /organized_scenes
 */

import * as whisparr from './whisparr.mjs';
import * as whisparr3 from './whisparr3.mjs';
import * as stash from './stash.mjs';
import * as stashdb from './stashdb.mjs';
import * as tpdb from './tpdb.mjs';
import * as fileflows from './fileflows.mjs';
import * as prowlarr from './prowlarr.mjs';
import * as nzbget from './nzbget.mjs';
import * as shelf from './stashlib.mjs';
import { whisparr2Configured, stashConfigured, whisparr3Reachable } from './config.mjs';

/* One service: configured, answered, what it said. "Not configured" isn't "down". */
async function probe(name, { configured, check }) {
  if (!configured) return { name, configured: false, ok: false, note: 'not set up' };

  try {
    return { name, configured: true, ok: true, ...(await check()) };
  } catch (err) {
    return { name, configured: true, ok: false, error: err.message };
  }
}

async function services(config) {
  return Promise.all([
    probe('Stash', {
      configured: stashConfigured(config),
      // Stash reports its version already carrying the v; the two Whisparrs do
      // not. Prefixing blindly gives "vv0.31.1".
      check: async () => {
        const seen = (await stash.version(config)).version?.version || '?';
        return { note: seen.startsWith('v') ? seen : 'v' + seen, role: 'the library of record' };
      },
    }),
    probe('Whisparr v2', {
      configured: whisparr2Configured(config),
      check: async () => {
        const status = await whisparr.systemStatus(config);
        return { note: `v${status.version}`, role: 'ThePornDB scenes in' };
      },
    }),
    probe('Whisparr v3', {
      configured: whisparr3Reachable(config),
      check: async () => {
        const seen = await whisparr3.identify(config);
        return { note: `v${seen.version}`, role: 'StashDB scenes in' };
      },
    }),
    probe('StashDB', {
      configured: stashConfigured(config),
      check: async () => {
        if (!(await stashdb.available(config))) throw new Error('no StashDB stash-box with an API key in Stash');
        return { note: 'token borrowed from Stash', role: 'the catalogue the search runs on' };
      },
    }),
    probe('ThePornDB', {
      configured: stashConfigured(config),
      check: async () => {
        if (!(await tpdb.available(config))) throw new Error('no ThePornDB stash-box with an API key in Stash');
        return { note: 'token borrowed from Stash', role: 'movies, artwork, the wild card' };
      },
    }),
    probe('FileFlows', {
      configured: fileflows.configured(config),
      check: async () => await fileflows.status(config),
    }),
    probe('Prowlarr', {
      configured: prowlarr.configured(config),
      check: async () => {
        const status = await prowlarr.systemStatus(config);
        return { note: `v${status.version}`, role: 'the indexers, searched by hand' };
      },
    }),
    probe('NZBGet', {
      configured: nzbget.configured(config),
      check: async () => ({ note: `v${await nzbget.version(config)}`, role: `hand-picked usenet grabs, into ${config.nzbgetCategory || 'Manual'}` }),
    }),
  ]);
}

/* ----------------------------------------------------------- the pipeline */

const step = (key, label, note, count, extra = {}) => ({ key, label, note, count, ...extra });

/* FileFlows' own counts: files it was pointed at, not Stash's scenes. */
async function encoding(config) {
  const seen = await fileflows.queued(config);
  if (!seen.configured) return [];

  const doing = seen.doing || [];

  return [
    step('fileflows', 'FileFlows', seen.error || (doing.length
      ? `encoding now — ${seen.processed ?? 0} done`
      : `idle — ${seen.processed ?? 0} done`), seen.count, {
      error: seen.error || null,
      items: doing.map((file) => ({
        title: file.name,
        detail: [file.step, file.percent === null ? null : file.percent + '%', file.library]
          .filter(Boolean).join(' — '),
      })),
    }),
  ];
}

async function downloading(config) {
  const out = [];

  if (whisparr2Configured(config)) {
    try {
      const records = (await whisparr.queue(config)).records || [];
      out.push(step('v2', 'Whisparr v2', 'grabbing — ThePornDB scenes', records.length, {
        items: records.slice(0, 8).map((r) => ({
          title: r.episode?.title || r.title || '(untitled)',
          detail: [r.series?.title, r.status].filter(Boolean).join(' — '),
          stalled: /warning|error/i.test(r.trackedDownloadStatus || '') || /failed|warning/i.test(r.status || ''),
        })),
      }));
    } catch (err) {
      out.push(step('v2', 'Whisparr v2', 'grabbing — ThePornDB scenes', null, { error: err.message }));
    }
  }

  if (whisparr3Reachable(config)) {
    try {
      const records = (await whisparr3.queue(config)).records || [];
      out.push(step('v3', 'Whisparr v3', 'grabbing — StashDB scenes', records.length, {
        items: records.slice(0, 8).map((r) => ({
          title: r.movie?.title || r.title || '(untitled)',
          detail: [r.quality?.quality?.name, r.status].filter(Boolean).join(' — '),
          stalled: /warning|error/i.test(r.trackedDownloadStatus || '') || /failed|warning/i.test(r.status || ''),
        })),
      }));
    } catch (err) {
      out.push(step('v3', 'Whisparr v3', 'grabbing — StashDB scenes', null, { error: err.message }));
    }
  }

  return out;
}

/* The folder stages, from Stash. Whisparr's root comes from tidy.mjs. */
async function inTheFolders(config) {
  if (!stashConfigured(config)) return [];

  const counts = await shelf.stageCounts(config);

  return [
    step('encoding', 'In the import folder', 'scenes Stash can see in /Import Folder', counts.encoding ?? 0, {
      href: '#/library/stage/encoding',
    }),
    step('editing', 'Being edited', 'in /pc-import, held back by hand', counts.editing ?? 0, {
      href: '#/library/stage/editing',
    }),
    step('library', 'Filed', 'in /organized_scenes — done', counts.library ?? 0, {
      href: '#/library/stage/library',
      done: true,
    }),
  ];
}

export async function view(config) {
  const [live, grabbing, encoder, folders] = await Promise.all([
    services(config),
    downloading(config).catch(() => []),
    encoding(config).catch(() => []),
    inTheFolders(config).catch((err) => {
      console.warn('[tpdbarr] pipeline folder counts failed -', err.message);
      return [];
    }),
  ]);

  const pipeline = [...grabbing, ...encoder, ...folders];

  /* The headline sums Stash's view only; FileFlows' queue overlaps it and is shown separately. */
  const counted = pipeline.filter((s) => !s.done && s.key !== 'fileflows');
  const encoderStep = pipeline.find((s) => s.key === 'fileflows') || null;

  return {
    services: live,
    pipeline,
    moving: counted.reduce((total, s) => total + (s.count || 0), 0),
    encoderQueue: encoderStep ? encoderStep.count : null,
  };
}
