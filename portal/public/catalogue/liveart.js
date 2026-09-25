/*
 * Match and Wild Card row pictures that preview on hover and scrub along
 * the bottom, using the library's `hoverPreview`. Plus a Generate button,
 * since these scenes often have no preview or sprites yet.
 */

import { api, el } from '../util.js';
import { hoverPreview } from '../library/core.js';

/* Wrap a row's <img> in a positioned parent. Sizing is `.rowart` in the CSS. */
export function liveArt(sceneId, img) {
  const art = el('div', { className: 'rowart' }, img);
  // Node and container are the same element here: unlike a tile, there is no
  // caption below the picture that should also count as hovering it.
  hoverPreview(art, art, sceneId);
  return art;
}

/*
 * Ask Stash to generate cover, preview, sprites and phash for one scene
 * (kept by Stash, unlike our cut frame). Polls. One job at a time across
 * Stash; a press while one runs is refused.
 */
export function generateBit(sceneId, img = null) {
  const button = el('button', { className: 'chip', type: 'button' }, 'Generate');
  const said = el('span', { className: 'muted small' }, '');
  const bit = el('span', { className: 'genbit' }, button, said);

  let timer = null;

  const stop = () => { clearTimeout(timer); timer = null; };

  const done = (text) => {
    stop();
    button.disabled = false;
    button.textContent = 'Generate';
    said.textContent = text;

    /* Refresh the row picture with a fresh query string. */
    if (img) img.src = img.src.split('?')[0] + '?at=' + Date.now();
  };

  const watch = (job) => {
    timer = setTimeout(async () => {
      // Navigated away, or the pile was redrawn under us.
      if (!bit.isConnected) return stop();

      const status = await api(`/api/scenes/${sceneId}/generate/${job}`).catch(() => null);
      if (!status) return done('Lost track of the job — check Stash.');

      const live = status.job;
      if (!live || /finish/i.test(live.status || '')) return done('Generated.');
      if (/cancel|fail/i.test(live.status || '')) return done(live.error || `Stash said ${live.status}.`);

      const pct = Math.round((live.progress || 0) * 100);
      said.textContent = pct ? `Generating… ${pct}%` : 'Generating…';
      watch(job);
    }, 1500);
  };

  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Asking…';
    said.textContent = '';

    try {
      const out = await api(`/api/scenes/${sceneId}/generate`, { method: 'POST' });
      if (!out.started) return done(out.why || 'Stash would not start it.');
      said.textContent = 'Generating…';
      button.textContent = 'Generating…';
      if (out.job) watch(out.job);
      else done('Started.');
    } catch (err) {
      done(err.message);
    }
  };

  return bit;
}
