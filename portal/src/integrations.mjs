/*
 * Integrations — is everything up, and what is in flight.
 *
 * This replaces the Queue tab, which showed one step of a five-step pipeline as
 * though it were the whole thing. A file that arrives here does this:
 *
 *   1. Whisparr grabs it                    -> the downloader queue
 *   2. it lands in Whisparr's own root      -> Stash has no record of it yet
 *   3. FileFlows encodes it                 -> /Import Folder
 *   4. it gets edited by hand, sometimes    -> /pc-import
 *   5. Stash files it                       -> /organized_scenes
 *
 * "Where is that scene I grabbed on Tuesday" is answerable only if all five are
 * on one page, and until now steps two to five were spread across the library
 * overview and the tidy-up while step one had a tab to itself.
 *
 * Every count here is read live. A pipeline view that is half an hour old is
 * worse than no pipeline view — it is the same complaint the old queue page
 * made about itself.
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

/*
 * A service, reported the same way whichever it is: is it set up at all, did it
 * answer, and what did it say. "Not configured" is a different answer from
 * "down", and a page that blurs them sends you looking for a network fault that
 * is really an empty settings field.
 */
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

/*
 * The encoder, between the downloaders and the folders. Its own step because it
 * is its own machine: FileFlows counts every file it has been pointed at, which
 * is not the same set as the scenes Stash can see sitting in /Import Folder.
 */
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

/*
 * The rest of the pipeline is folders, and folders are what Stash can see.
 *
 * The one step it cannot see is the gap between a completed download and a
 * FileFlows run: the file is sitting in Whisparr's own root and Stash has no
 * record of it at all. tidy.mjs already counts that from the Whisparr side, so
 * it is asked for rather than guessed at.
 */
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

  /*
   * The headline deliberately does not add every step up.
   *
   * FileFlows counts files it has been pointed at; Stash counts scenes it has a
   * record for in /Import Folder. Those are largely the same files seen from
   * two sides — 1342 against 1057 on the afternoon this was written — so
   * summing them says two and a half thousand things are in flight when it is
   * closer to half that. Stash's view is the one summed, because every other
   * number in this portal is counted in Stash; the encoder's queue is reported
   * beside it as its own figure rather than folded in.
   */
  const counted = pipeline.filter((s) => !s.done && s.key !== 'fileflows');
  const encoderStep = pipeline.find((s) => s.key === 'fileflows') || null;

  return {
    services: live,
    pipeline,
    moving: counted.reduce((total, s) => total + (s.count || 0), 0),
    encoderQueue: encoderStep ? encoderStep.count : null,
  };
}
