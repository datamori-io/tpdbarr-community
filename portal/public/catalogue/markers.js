/* The marker builder. */

import * as markerbuilder from '../markerbuilder.js';
import { manage } from '../markermanage.js';
import { el } from '../util.js';
import { SECTION_OF, paint, painterFor, show, state } from '../import/core.js';

/*
 * -------------------------------------------------- the marker builder
 *
 * Three states on one address: no `scene` is the queue, a `scene` is the
 * bench (markerbuilder.js), `manage` is the list of cut markers
 * (markermanage.js).
 *
 * The timestampTrade and TPDBMarkers plugins rewrite markers within 15
 * seconds; run them after marking, or not at all.
 */

export async function showMarkerBuilder(qs) {
  const paint = painterFor();
  const params = new URLSearchParams(qs || '');
  const sceneId = params.get('scene');
  const managing = params.get('manage');

  const body = el('div', { className: 'mbuild' });

  show(paint, SECTION_OF.markers,
    // The bench and the management list both lead with a heading of their own,
    // about the scene or the list rather than about the page.
    sceneId || managing ? null : el('div', { className: 'feedhead' },
      el('h2', {}, 'Marker Builder'),
      el('span', { className: 'muted' },
        'the moments inside a scene — cut by hand, with the keyboard')
    ),
    body);

  if (!state?.stash?.enabled) {
    body.replaceChildren(el('div', { className: 'empty' },
      'Markers live in your Stash library. Connect it in Settings.'));
    return;
  }

  // The queue's filters and the scene being marked both live in the address,
  // so a bench you were on is a place you can come back to.
  const go = (next) => {
    const qsNext = next.toString();
    location.hash = '#/catalogue/markers' + (qsNext ? '?' + qsNext : '');
  };

  if (sceneId) return markerbuilder.editor(body, { sceneId, go });

  // The way back out of the list is the shelf the picker was on, the same one
  // the bench hands back — see lastShelf() in markerbuilder.js.
  if (managing) {
    return manage(body, {
      params,
      go,
      back: () => go(new URLSearchParams(markerbuilder.lastShelf())),
    });
  }

  return markerbuilder.picker(body, { params, go });
}
