/* Shared by the acquisition side (app.js) and the library side (shelf.js). */

export const api = async (path, options) => {
  const res = await fetch(path, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const payload = await res.json();

  /*
   * The server refuses to hand Whisparr a scene Stash already has (see
   * heldguard.mjs) and says which one and where. Every Add and Send button
   * comes through here, so the question is asked once, here: yes sends the
   * same request again with `force`, no leaves it as the error it was.
   */
  if (res.status === 409 && payload.held && options?.method === 'POST') {
    if (confirm(`${payload.error}\n\nSend it to Whisparr anyway?`)) {
      let body = {};
      try { body = options.body ? JSON.parse(options.body) : {}; } catch { body = {}; }
      return api(path, { ...options, body: JSON.stringify({ ...body, force: true }) });
    }
  }

  if (!res.ok) throw new Error(payload.error || res.statusText);
  return payload;
};

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

export const minutes = (n) => (n ? `${n} min` : '');

// Runtimes are in seconds on the library side and minutes on the TPDB side.
export const clock = (seconds) => {
  if (!seconds) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

export const gigabytes = (bytes) => (bytes ? (bytes / 1e9).toFixed(1) + ' GB' : '');

/*
 * Pages that fill the screen rather than flow down it — the reel, the plugin
 * frame — cannot say so in CSS alone, because nothing above them has a fixed
 * height: the top bar grows with the brand image, the status bar with whatever
 * it has to say. So they carry .fillview and are measured instead, and the one
 * observer below re-measures them whenever the chrome moves.
 */
export function fitFills() {
  for (const node of document.querySelectorAll('.fillview')) {
    const top = Math.round(node.getBoundingClientRect().top + window.scrollY);
    node.style.height = `calc(100dvh - ${top}px)`;
  }
}

const chromeWatch = new ResizeObserver(fitFills);
for (const selector of ['.topbar', '.statusbar']) {
  const node = document.querySelector(selector);
  if (node) chromeWatch.observe(node);
}
