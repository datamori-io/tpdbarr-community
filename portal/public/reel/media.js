/*
 * Getting a thing to play. Three sources answer here and they fail in
 * different ways, so what "not playable" means is decided in one place.
 */

import { api, el } from '../util.js';
import { CLIP_STRIKES, WINDOW } from './config.js';
import { live } from './core.js';

const proxied = (url) => '/media/social?url=' + encodeURIComponent(url);

export const mediaFor = (item) =>
  item.kind === 'redgifs'
    ? {
        // Always video, and the whole of it is the clip, so it loops itself.
        src: proxied(item.video),
        poster: item.poster ? proxied(item.poster) : null,
        start: 0,
        end: 0,
      }
    : item.kind === 'reddit'
    ? {
        /*
         * A RedGIFs clip is video and loops as itself — no window, because the
         * whole of it is the point. Everything else from Reddit is a picture,
         * and a picture slide has no video element at all.
         */
        src: item.video ? proxied(item.video) : null,
        poster: item.poster || item.art ? proxied(item.poster || item.art) : null,
        start: 0,
        end: 0,
      }
    : item.kind === 'marker'
    ? {
        /*
         * The rendered clip Stash generates for the marker — `stream`, which
         * is an mp4 of the moment itself, not the film it came out of.
         *
         * NOT `preview`. That path looks like the obvious one and is a trap:
         * it serves a 520kB animated WebP, which is a picture, and a <video>
         * cannot decode a picture. Every marker therefore failed and fell back
         * to streaming the whole scene — which is the slow, seek-into-a-2GB-
         * file path this was written to avoid in the first place.
         *
         * Where Stash has not rendered a marker, `stream` 404s and the slide
         * falls back to the scene. Per marker, so a half-finished Generate job
         * works: the ones that have a clip use it, the rest seek as before.
         */
        /*
         * Ours first — 720 high, cut from the source — then Stash's 640x360,
         * then the scene itself. Each step is tried and falls through on
         * failure, so a half-finished render improves the reel while it runs.
         */
        src: live?.play === 'source' || live?.clipless >= CLIP_STRIKES
          ? `/media/scene/${item.sceneId}/stream`
          : `/media/marker/${item.id}/clip`,
        then: `/media/scene/${item.sceneId}/marker/${item.id}/stream`,
        instead: live?.play === 'source' || live?.clipless >= CLIP_STRIKES
          ? null
          : `/media/scene/${item.sceneId}/stream`,
        // The marker's own frame, not the scene's cover.
        poster: `/media/scene/${item.sceneId}/marker/${item.id}/screenshot`,
        start: item.seconds,
        end: item.end || item.seconds + WINDOW,
      }
    : {
        src: `/media/scene/${item.sceneId}/preview`,
        poster: `/media/scene/${item.sceneId}/screenshot`,
        start: 0,
        end: 0,
      };

export function loadInto(slide, muted) {
  const video = slide.querySelector('video');
  if (!video) return null;
  if (!video.getAttribute('src')) video.src = slide.dataset.src;
  video.muted = muted;
  return video;
}

/*
 * Settings.
 *
 * Everything that is not a moment-to-moment control: the way in to the two
 * off-library sources, and how much of the reel they are allowed to be.
 *
 * The mixer is expressed as what comes from *away* — RedGIFs and Reddit — and
 * the library takes whatever is left. That way the three always add to a
 * hundred without anyone having to make them, and the library can never be
 * squeezed to nothing by two sliders arguing.
 */
/*
 * What the clip renderer is up to, and the way to prod it.
 *
 * It runs itself on the hour, so this is mostly a window rather than a
 * control — but a job that takes hours needs somewhere to say how far it has
 * got, or the only way to know is to ask someone who can read a log.
 */
export function clipStatus(box) {
  const line = el('div', { className: 'reelsetnote' }, 'Checking rendered clips…');
  const button = el('button', { className: 'reelmute', type: 'button' }, 'Render missing');

  let timer = null;
  box.addEventListener('close', () => clearTimeout(timer));

  const paint = (data) => {
    const missing = Math.max(0, data.markers - data.clips);

    if (data.running) {
      line.textContent = `Rendering — ${data.done} of ${data.total} done${data.failed ? `, ${data.failed} failed` : ''}. It carries on if you close this.`;
      button.disabled = true;
      button.textContent = 'Rendering…';
    } else if (!data.markers) {
      line.textContent = 'No markers in Stash yet.';
      button.disabled = true;
    } else if (!missing) {
      line.textContent = `All ${data.clips} markers have a ${data.height}p clip.`;
      button.disabled = true;
      button.textContent = 'Nothing to render';
    } else {
      line.textContent = `${data.clips} of ${data.markers} rendered — ${missing} still on Stash's 640x360.`;
      button.disabled = false;
      button.textContent = 'Render missing';
    }

    clearTimeout(timer);
    if (data.running && box.open) timer = setTimeout(look, 4000);
  };

  const look = async () => {
    try {
      const data = await api('/api/markerclips');
      if (box.open) paint(data);
    } catch {
      line.textContent = 'Could not read the clip renderer.';
    }
  };

  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      paint(await api('/api/markerclips/generate', { method: 'POST', body: '{}' }));
    } catch (err) {
      line.textContent = err.message;
      button.disabled = false;
    }
  };

  look();

  // Three cells, not four: this row has no slider, and the spare column the
  // others use for one pushed the button onto a line of its own.
  return el('div', { className: 'reelset reelsetclips' },
    el('div', { className: 'reelseticon' }, ''),
    el('div', { className: 'reelsetname' }, el('div', {}, 'Marker clips'), line),
    button
  );
}
