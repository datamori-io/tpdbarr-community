/*
 * Local NZBGet, for hand-picked usenet releases. Its own category, never
 * WhisparrV2/V3 (Whisparr would try to import it).
 *
 *   POST /jsonrpc  {method: 'append', params: [name, base64, category, priority,
 *                   addToTop, paused, dupeKey, dupeScore, dupeMode, ppParams]}
 *     -> {result: nzbId}, 0 or less when it refused
 */

const TIMEOUT = 20_000;

export const configured = (config) => Boolean(config.nzbgetUrl);

// A bare host:port is what NZBGet's own address bar shows, so take it as http.
const base = (config) => {
  const url = String(config.nzbgetUrl || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(url) ? url : 'http://' + url;
};

async function rpc(config, method, params = []) {
  const auth = config.nzbgetUsername
    ? { Authorization: 'Basic ' + Buffer.from(`${config.nzbgetUsername}:${config.nzbgetPassword || ''}`).toString('base64') }
    : {};

  let res;
  try {
    res = await fetch(base(config) + '/jsonrpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    throw new Error(`NZBGet unreachable: ${err.message}`);
  }
  if (res.status === 401) throw new Error('NZBGet refused the username or password.');
  if (!res.ok) throw new Error(`NZBGet ${res.status}`);
  const out = await res.json();
  if (out.error) throw new Error(`NZBGet: ${out.error.message || JSON.stringify(out.error)}`);
  return out.result;
}

export const version = (config) => rpc(config, 'version');

export async function append(config, { name, nzb }) {
  const category = config.nzbgetCategory || 'Manual';
  const file = /\.nzb$/i.test(name) ? name : name + '.nzb';
  const id = await rpc(config, 'append', [file, nzb.toString('base64'), category, 0, false, false, '', 0, 'SCORE', []]);
  if (!(id > 0)) throw new Error('NZBGet would not take the NZB.');
  return { id, category };
}

// Finished and failed downloads, newest first. Hidden entries left out.
export const history = (config) => rpc(config, 'history', [false]);
