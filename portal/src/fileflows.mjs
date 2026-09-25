/*
 * FileFlows, the encoder in the middle of the pipeline.
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
 * `/api/status` is used. No key needed on the LAN, but one is sent if set.
 * Its queue differs from Stash's /Import Folder count; both are shown.
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

  /* An unknown path returns the web app with a 200, so check the content type. */
  const type = res.headers.get('content-type') || '';
  if (!/json/i.test(type)) throw new Error(`${path} answered with ${type.split(';')[0] || 'no content type'}, not JSON`);

  return res.json();
}

/*
 * -> {note, role, queue, processing, processed, doing}
 * `doing` is what's encoding right now.
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

/* The pipeline step. Unknown rather than zero when FileFlows is down. */
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
