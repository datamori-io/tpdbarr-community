/* What to play for each slide, and what counts as unplayable. */

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
        /* A RedGIFs clip loops whole; a Reddit picture has no video element. */
        src: item.video ? proxied(item.video) : null,
        poster: item.poster || item.art ? proxied(item.poster || item.art) : null,
        start: 0,
        end: 0,
      }
    : item.kind === 'marker'
    ? {
        /*
         * Stash's rendered marker clip is `stream` (an mp4).
         *
         * NOT `preview`: that's an animated WebP, which a <video> can't play, so
         * every marker fell back to the whole scene. A marker Stash hasn't
         * rendered 404s on `stream` and falls back per marker.
         */
        /* Ours (720p) first, then Stash's, then the scene. */
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
 * Settings: the off-library sources and the mix. The sliders set RedGIFs
 * and Reddit; the library gets the rest.
 */
/* The clip renderer's status (it runs hourly), and a button to run it. */
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
