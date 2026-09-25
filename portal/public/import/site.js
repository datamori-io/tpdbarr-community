/* One TPDB site: its scenes, what you hold of them, and the artwork pull. */

import { api, el, minutes } from '../util.js';
import { SECTION_OF, artFor, artShape, countChip, paint, painterFor, show, statusLabel, view } from './core.js';
import { postAdd } from './send.js';

let current = null; // last loaded site view
let filter = 'all';

// ------------------------------------------------------------------- utils

export function siteRow(site) {
  const row = el('div', { className: 'siterow' },
    site.poster || site.logo
      ? el('img', { src: site.poster || site.logo, loading: 'lazy', alt: '' })
      : el('img', { alt: '' }),
    el('div', {},
      el('h3', {}, site.title),
      el('p', {}, [site.network, (site.types || []).join(', ')].filter(Boolean).join(' · '))
    )
  );
  row.onclick = () => { location.hash = `#/site/${site.id}`; };
  return row;
}

export async function showSite(siteId) {
  const paint = painterFor();
  show(paint, SECTION_OF.site, el('div', { className: 'empty' }, 'Loading catalogue…'));
  try {
    current = await api('/api/sites/' + siteId);
    filter = 'all';
    renderSite(paint);
    followArtwork(siteId);
  } catch (err) {
    show(paint, SECTION_OF.site, el('div', { className: 'empty' }, err.message));
  }
}

function visibleScenes() {
  const scenes = current.scenes;
  if (filter === 'missing') return scenes.filter((s) => s.status === 'absent' && !s.stash);
  if (filter === 'wanted') return scenes.filter((s) => s.status !== 'absent');
  if (filter === 'stash') return scenes.filter((s) => s.stash);
  return scenes;
}

function renderSite(paint) {
  const { site, counts, stash } = current;
  const scenes = visibleScenes();

  const head = el('div', { className: 'sitehead' },
    site.poster || site.logo ? el('img', { src: site.poster || site.logo, alt: '' }) : null,
    el('div', {},
      el('h1', {}, site.title),
      site.overview ? el('p', {}, site.overview) : null,
      el('div', { className: 'counts' },
        countChip('scenes', counts.total),
        countChip('downloaded', counts.downloaded),
        countChip('monitored', counts.monitored),
        stash.enabled ? countChip('in Stash', counts.inStash) : null,
        countChip('not added', counts.absent)
      )
    )
  );

  const addAll = el('button', { className: 'primary', type: 'button' }, 'Add all shown');
  addAll.onclick = () => addScenes(scenes.filter((s) => s.status === 'absent').map((s) => s.id), addAll);
  addAll.disabled = !scenes.some((s) => s.status === 'absent');

  const toolbar = el('div', { className: 'toolbar' },
    chip('all', 'All'),
    chip('missing', 'Do not have'),
    chip('wanted', 'In Whisparr'),
    stash.enabled ? chip('stash', 'In Stash') : null,
    el('span', { className: 'spacer' }),
    current.art && !current.art.done ? el('span', { className: 'artnote' }, 'loading artwork…') : null,
    addAll
  );

  const errors = [current.whisparrError, stash.error].filter(Boolean);

  show(paint, SECTION_OF.site,
    head,
    errors.map((e) => el('div', { className: 'empty' }, e)),
    toolbar,
    el('div', { className: 'scenes' }, scenes.map(sceneRow))
  );
}

export function chip(key, label) {
  const button = el('button', { className: 'chip', type: 'button' }, label);
  button.setAttribute('aria-pressed', String(filter === key));
  button.onclick = () => { filter = key; renderSite(paint); };
  return button;
}

function sceneRow(scene) {
  const box = el('input', { type: 'checkbox', className: 'pick' });
  box.dataset.sceneId = scene.id;
  box.disabled = scene.status !== 'absent';

  const thumb = el('div', { className: 'thumb ' + artShape(scene) });
  thumb.dataset.sceneId = scene.id;
  const art = artFor(scene);
  if (art) thumb.append(el('img', { src: art, loading: 'lazy', alt: '' }));

  const badges = el('div', { className: 'right' });
  badges.append(el('span', { className: 'badge ' + scene.status }, statusLabel(scene.status)));

  if (scene.stash) {
    const how = scene.stash.via ? `matched on ${scene.stash.via}` : '';
    badges.append(el('span', {
      className: 'badge stash-' + scene.stash.match,
      title: [how, scene.stash.path].filter(Boolean).join('\n'),
    }, scene.stash.match === 'exact' ? 'In Stash' : 'Probably in Stash'));
  }

  if (scene.status === 'absent') {
    const button = el('button', { className: 'add', type: 'button' }, 'Add');
    button.onclick = () => addScenes([scene.id], button);
    badges.append(button);
  }

  const meta = [
    scene.date,
    minutes(scene.duration),
    scene.performers.map((p) => p.name).join(', '),
  ].filter(Boolean);

  return el('div', { className: 'scene' },
    box,
    thumb,
    el('div', {},
      scene.guid
        ? el('a', { className: 'title', href: `#/scene/${scene.guid}` }, scene.title)
        : el('div', { className: 'title' }, scene.title),
      el('div', { className: 'meta' }, meta.map((m) => el('span', {}, m)))
    ),
    badges
  );
}

/* Artwork arrives in the background and is patched into rows. */
export let artTimer = null;

// A TPDB stash id is the most certain thing we have; then fingerprints; then
// title + date, which is only ever a guess.
const CONFIDENCE = { 'TPDB stash id': 4, oshash: 3, phash: 3 };
const rank = (m) => (m ? (CONFIDENCE[m.via] ?? (m.match === 'exact' ? 3 : /^phash distance/.test(m.via || '') ? 2 : 1)) : 0);
const betterMatch = (next, existing) => rank(next) > rank(existing);

async function followArtwork(siteId) {
  clearTimeout(artTimer);
  if (!current?.art || current.art.done) return;

  try {
    const { progress, art, stash } = await api(`/api/sites/${siteId}/art`);
    let patched = 0;
    let upgraded = 0;

    for (const scene of current.scenes) {
      const extra = art[scene.id];
      if (extra && !scene.image) {
        Object.assign(scene, {
          image: extra.image,
          isMovie: extra.isMovie,
          poster: extra.poster,
          still: extra.still,
        });
        if (extra.duration) scene.duration = Math.round(extra.duration / 60);

        const slot = view.querySelector(`.thumb[data-scene-id="${scene.id}"]`);
        const src = artFor(scene);
        if (slot && !slot.firstChild && src) {
          slot.className = 'thumb ' + artShape(scene);
          slot.append(el('img', { src, loading: 'lazy', alt: '' }));
          patched++;
        }
      }

      // A fingerprint hit beats title+date, and finds scenes that had no match.
      const hit = stash?.[scene.id];
      if (hit && betterMatch(hit, scene.stash)) {
        scene.stash = hit;
        upgraded++;
      }
    }

    current.art = progress;
    if (upgraded) {
      current.counts = recount(current.scenes);
      renderSite(paint);
    }
    updateArtNote();
    if (!progress?.done) artTimer = setTimeout(() => followArtwork(siteId), 2500);
  } catch {
    // artwork is decoration; stop quietly
  }
}

function updateArtNote() {
  const note = view.querySelector('.artnote');
  if (!note) return;
  const p = current.art;

  if (!p || p.done) note.remove();
  else if (p.matching) note.textContent = 'matching fingerprints against Stash…';
  else note.textContent = `loading artwork… ${p.fetched}${p.total ? ' / ' + p.total : ''}`;
}

async function addScenes(sceneIds, trigger) {
  if (!sceneIds.length) return;

  const label = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = sceneIds.length > 1 ? `Adding ${sceneIds.length}…` : 'Adding…';

  try {
    const result = await postAdd(current.site.id, sceneIds);

    for (const scene of current.scenes) {
      if (result.added.includes(scene.id)) scene.status = 'monitored';
    }
    current.counts = recount(current.scenes);
    renderSite(paint);

    if (result.missing.length) {
      alert(`${result.missing.length} scene(s) are not in Whisparr's copy of this site yet. Refresh the site in Whisparr and try again.`);
    }
  } catch (err) {
    trigger.textContent = label;
    trigger.disabled = false;
    alert(err.message);
  }
}

function recount(scenes) {
  const counts = { total: scenes.length, downloaded: 0, monitored: 0, absent: 0, inStash: 0 };
  for (const s of scenes) {
    counts[s.status]++;
    if (s.stash) counts.inStash++;
  }
  return counts;
}

async function showQueue() {
  const paint = painterFor();
  paint(el('div', { className: 'empty' }, 'Loading queue…'));
  try {
    const { records } = await api('/api/queue');
    if (!records.length) {
      paint(el('div', { className: 'empty' }, 'Nothing downloading.'));
      return;
    }
    paint(el('div', { className: 'queue' }, records.map((r) =>
      el('div', { className: 'qrow' },
        el('div', {},
          el('div', { className: 'title' }, r.title || '(untitled)'),
          el('div', { className: 'meta' }, r.series)
        ),
        el('span', { className: 'badge busy' }, r.trackedDownloadState || r.status)
      )
    )));
  } catch (err) {
    paint(el('div', { className: 'empty' }, err.message));
  }
}

// ------------------------------------------------------------ binge plugin
