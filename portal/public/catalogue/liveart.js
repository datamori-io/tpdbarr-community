/*
 * The picture on a working row, made to behave like the picture on a shelf.
 *
 * Match and Wild Card are piles of rows you are trying to recognise, and until
 * now each row had one still frame to recognise it by. The shelves have had
 * the better answer for a while — hover and the scene's own preview loop plays,
 * run along the bottom of it and you scrub the whole runtime off the sprite
 * sheet — and there was never a reason those pages should not have it too.
 *
 * So this borrows it rather than reimplementing it: `hoverPreview` from the
 * library half is the same code driving both, and a fix to the scrub is a fix
 * in one place. The only thing that had to change is the shape around the
 * picture — the overlays need something positioned to sit in, and these rows
 * were a bare <img>.
 *
 * The other half of the file is the button that makes any of it possible. A
 * preview to hover and sprites to scrub are things Stash generates, and on
 * these two pages the scenes most likely to have neither are exactly the ones
 * you are looking at — freshly arrived, never organised, never generated.
 */

import { api, el } from '../util.js';
import { hoverPreview } from '../library/core.js';

/*
 * Wrap a row's artwork so it can carry a preview and a scrub.
 *
 * The <img> stays exactly what it was — same class, same src, same double-click
 * — and gains a positioned parent. Sizing lives in the stylesheet against
 * `.rowart`, so a page that already had an opinion about how big its pictures
 * are keeps it.
 */
export function liveArt(sceneId, img) {
  const art = el('div', { className: 'rowart' }, img);
  // Node and container are the same element here: unlike a tile, there is no
  // caption below the picture that should also count as hovering it.
  hoverPreview(art, art, sceneId);
  return art;
}

/*
 * Ask Stash to make the lot for one scene: cover, preview, sprites, phash.
 *
 * Separate from the frame the portal cuts for itself. That one is a stand-in
 * for looking at — never written back, gone when you match the scene. This is
 * Stash generating its own, keeping them, and handing them to the scene page
 * and the shelves as well as to this row.
 *
 * It polls, because generating a preview is ffmpeg over the whole file and a
 * held-open request across that is not a plan. One job at a time across the
 * whole of Stash, which is Stash's own constraint rather than ours — queue a
 * second and it decodes everything twice — so a press while one is running is
 * told so rather than obeyed.
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

    /*
     * The row is still showing whatever it had before — most likely the frame
     * the portal cut, which Stash has now made a real cover for. Asking for it
     * again with a fresh query string is the whole of the refresh.
     */
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
