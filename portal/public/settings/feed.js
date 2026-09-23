/*
 * Feed — what the reel opens as.
 *
 * These are defaults rather than commands: the reel writes the same store every
 * time you touch a control in it, and an address that names a setting still
 * beats both. They are read and written through the reel's own route rather
 * than /api/config — that one drops every cache on its way past, which is right
 * for a changed Stash URL and absurd for a mix slider.
 */

import { api, el } from '../util.js';
import { shell } from './core.js';

export const SECTION = '#/parameters/feed';

const RATIO_CAP = 60;

export async function showFeed(paint) {
  shell(paint, SECTION, 'Feed', 'what the reel opens as', el('div', { className: 'empty' }, 'Loading…'));

  const [reel, clips] = await Promise.all([
    api('/api/library/reel/settings').then((r) => r.reel || {}).catch(() => ({})),
    api('/api/markerclips').catch(() => null),
  ]);

  shell(paint, SECTION, 'Feed', 'what the reel opens as', feedParams(reel, clips));
}

function feedParams(reel, clips) {
  const ratio = Array.isArray(reel.ratio) && reel.ratio.length === 3 ? reel.ratio : [75, 15, 10];

  const set = el('fieldset', {},
    el('legend', {}, 'The mix ', el('span', { className: 'muted' }, 'where a slide comes from'))
  );

  const library = el('b', {}, '');
  const gifOut = el('b', {}, '');
  const redOut = el('b', {}, '');

  const gif = el('input', { type: 'range', min: '0', max: String(RATIO_CAP), step: '5', value: String(ratio[1]) });
  const red = el('input', { type: 'range', min: '0', max: String(RATIO_CAP), step: '5', value: String(ratio[2]) });

  const show = () => {
    let g = Number(gif.value);
    let r = Number(red.value);
    // The two together may not eat more than the cap, or the library stops
    // being the point of the page.
    if (g + r > RATIO_CAP) {
      r = Math.max(0, RATIO_CAP - g);
      red.value = String(r);
    }
    library.textContent = `${100 - g - r}%`;
    gifOut.textContent = `${g}%`;
    redOut.textContent = `${r}%`;
  };

  gif.oninput = show;
  red.oninput = show;
  show();

  const source = el('input', { type: 'checkbox', checked: reel.play === 'source' });

  const note = el('p', { className: 'note' }, '');

  const save = el('button', { className: 'primary', type: 'button' }, 'Save feed settings');
  save.onclick = async () => {
    save.disabled = true;
    note.textContent = '';
    try {
      const g = Number(gif.value);
      const r = Number(red.value);
      await api('/api/library/reel/settings', {
        method: 'POST',
        body: JSON.stringify({ ratio: [100 - g - r, g, r], play: source.checked ? 'source' : 'clip' }),
      });
      note.textContent = 'Saved.';
    } catch (err) {
      note.textContent = err.message;
    }
    save.disabled = false;
  };

  set.append(
    row('Your library', 'whatever the other two leave', null, library),
    row('RedGIFs', 'creators seeded from your performers, plus tags you add', gif, gifOut, '#/binge/redgifs'),
    row('Reddit', 'the performers you already follow', red, redOut, '#/binge/reddit'),
    row('Play markers from source', 'full resolution, slower to start — off plays the rendered 720p clip', null, source),
    clipRow(clips),
    note,
    el('menu', {}, save)
  );

  return set;
}

function row(name, hint, control, out, href) {
  return el('div', { className: 'paramrow' },
    el('div', { className: 'paramname' },
      href ? el('a', { href }, name) : name,
      el('span', { className: 'muted' }, hint)
    ),
    el('div', { className: 'paramctl' }, control),
    out
  );
}

/*
 * The clip renderer, which is the one thing here that is a job rather than a
 * setting. It runs itself on the hour; this is somewhere to see how far it has
 * got and to say "not in an hour, now".
 */
function clipRow(clips) {
  if (!clips) return el('div', { className: 'paramrow' },
    el('div', { className: 'paramname' }, 'Marker clips', el('span', { className: 'muted' }, 'unavailable')),
    el('div', {}, ''), el('span', {}, ''));

  const missing = Math.max(0, clips.markers - clips.clips);
  const line = el('span', { className: 'muted' },
    clips.running
      ? `rendering — ${clips.done} of ${clips.total}`
      : missing
        ? `${clips.clips} of ${clips.markers} rendered at ${clips.height}p`
        : `all ${clips.clips} rendered at ${clips.height}p`);

  const go = el('button', { type: 'button', disabled: clips.running || !missing },
    clips.running ? 'Rendering…' : missing ? `Render ${missing}` : 'Nothing to render');

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = 'Starting…';
    try {
      await api('/api/markerclips/generate', { method: 'POST', body: '{}' });
      go.textContent = 'Rendering…';
    } catch (err) {
      go.textContent = err.message;
    }
  };

  return el('div', { className: 'paramrow' },
    el('div', { className: 'paramname' }, 'Marker clips', line),
    el('div', { className: 'paramctl' }, ''),
    go
  );
}
