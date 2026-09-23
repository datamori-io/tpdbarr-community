/*
 * FileFlows — the encoder in the middle of the pipeline.
 *
 * It was the one step of this library's chain the portal could not see. Whisparr
 * grabs a file, FileFlows encodes it and moves it, Stash imports it — and
 * between the grab and the import the only honest answer the Integrations page
 * could give was "somewhere in there".
 *
 * Read off a live instance (server 26.07.9.7525) rather than guessed:
 *
 *   GET /api/status
 *     {queue, processing, processed, time, processingFiles: [
 *       {name, relativePath, library, step, stepPercent}
 *     ]}
 *
 *   GET /api/library-file/status
 *     [{Status, StatusCount}, …]   0 unprocessed, 1 done, 2 processing,
 *                                  negatives are held back rather than failed
 *
 * `/api/status` is the one worth having: it is small, it is the numbers the
 * page wants, and it carries what is encoding *right now*, which is the only
 * part of this pipeline that changes while you are looking at it.
 *
 * No key was needed — it answered unauthenticated on the LAN — but the field is
 * kept and sent when set, since that is a server setting that can change.
 *
 * **Its queue is not the same number as "waiting on FileFlows" from Stash.**
 * Stash counts scenes it has a record for sitting in /Import Folder; FileFlows
 * counts every file it has been pointed at, including ones Stash has never
 * seen. Measured on the same afternoon: 1061 against 1342. Both are true and
 * the page shows them as the two different steps they are.
 */

const TIMEOUT = 8000;

export const configured = (config) => Boolean(config.fileflowsUrl);

const base = (config) => String(config.fileflowsUrl || '').replace(/\/+$/, '');

async function call(config, path) {
  const res = await fetch(base(config) + path, {
    headers: {
      Accept: 'application/json',
      ...(config.fileflowsApiKey ? { 'x-token': config.fileflowsApiKey } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!res.ok) throw new Error(`${path} -> ${res.status}`);

  /*
   * A FileFlows that does not know a path hands back its own web app with a
   * 200, so the content type is checked rather than trusted. Without this a
   * wrong URL reports as "up" and then fails to parse.
   */
  const type = res.headers.get('content-type') || '';
  if (!/json/i.test(type)) throw new Error(`${path} answered with ${type.split(';')[0] || 'no content type'}, not JSON`);

  return res.json();
}

/*
 * -> {note, role, queue, processing, processed, doing}
 *
 * `doing` is what is being encoded at this moment, named — the one thing on the
 * Integrations page worth watching rather than counting.
 */
export async function status(config) {
  const data = await call(config, '/api/status');

  const doing = (data.processingFiles || []).slice(0, 4).map((file) => ({
    name: file.relativePath || file.name || '(unnamed)',
    library: file.library || '',
    step: file.step || '',
    percent: typeof file.stepPercent === 'number' ? Math.round(file.stepPercent) : null,
  }));

  return {
    note: doing.length ? `encoding ${doing[0].step || 'a file'}` : 'idle',
    role: 'encodes and moves what Whisparr grabs',
    queue: typeof data.queue === 'number' ? data.queue : null,
    processing: typeof data.processing === 'number' ? data.processing : null,
    processed: typeof data.processed === 'number' ? data.processed : null,
    doing,
  };
}

/*
 * The encoder's step in the pipeline band. Soft on purpose: a step whose count
 * cannot be read shows as unknown rather than as zero, because zero is a claim
 * and a FileFlows that is down cannot support one.
 */
export async function queued(config) {
  if (!configured(config)) return { configured: false, count: null };

  try {
    const seen = await status(config);
    return {
      configured: true,
      count: seen.queue,
      processing: seen.processing,
      processed: seen.processed,
      doing: seen.doing,
    };
  } catch (err) {
    return { configured: true, count: null, error: err.message };
  }
}
