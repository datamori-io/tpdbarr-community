/* One TPDB scene, and what you can do with it. */

import { api, el } from '../util.js';
import { SECTION_OF, artFor, artShape, externalLink, link, paint, painterFor, show, statusLabel, text } from './core.js';
import { addOne } from './send.js';

/* ------------------------------------------------------------ scene page */

export async function showScene(guid) {
  const paint = painterFor();
  show(paint, SECTION_OF.scene, el('div', { className: 'empty' }, 'Loading scene…'));
  try {
    const { scene } = await api('/api/scenes/' + guid);
    renderScene(paint, scene);
  } catch (err) {
    show(paint, SECTION_OF.scene, el('div', { className: 'empty' }, err.message));
  }
}

function renderScene(paint, scene) {
  const src = artFor(scene) || scene.background;

  const meta = [
    scene.siteId ? link(scene.siteName || 'site', `#/site/${scene.siteId}`) : text(scene.siteName),
    scene.network && scene.network !== scene.siteName ? text(scene.network) : null,
    text(scene.date),
    scene.duration ? text(scene.duration + ' min') : null,
    scene.directors?.length ? text('dir. ' + scene.directors.join(', ')) : null,
  ].filter(Boolean);

  const performers = scene.performers?.length
    ? el('div', { className: 'chips' }, scene.performers.map((p) =>
        p.uuid
          ? el('a', { className: 'chip person', href: `#/performer/${p.uuid}` }, p.name)
          : el('span', { className: 'chip person' }, p.name)
      ))
    : null;

  const tags = scene.tags?.length
    ? el('div', { className: 'chips' }, scene.tags.map((t) => el('span', { className: 'chip quiet' }, t)))
    : null;

  show(paint, SECTION_OF.scene, el('div', { className: 'detail' },
    src ? el('div', { className: 'detailart ' + artShape(scene) }, el('img', { src, alt: '' })) : null,
    el('div', {},
      el('h1', {}, scene.title),
      el('div', { className: 'detailmeta' }, meta),
      sceneActions(scene),
      performers,
      scene.overview ? el('p', { className: 'overview' }, scene.overview) : null,
      tags,
      externalLink(scene.url, 'View on ThePornDB')
    )
  ));
}

/*
 * The same state the cards carry, at page size, with the add as a real button
 * rather than something tucked into a corner.
 */
function sceneActions(scene) {
  const status = scene.status || 'absent';
  const row = el('div', { className: 'detailstate' });

  if (status !== 'absent' || !scene.stash) {
    row.append(el('span', { className: 'badge ' + status },
      status === 'absent' ? 'Do not have' : statusLabel(status)));
  }

  if (scene.stash) {
    row.append(el('span', {
      className: 'badge stash-' + scene.stash.match,
      title: scene.stash.path || '',
    }, scene.stash.match === 'exact' ? 'In Stash' : 'Probably in Stash'));

    if (scene.stash.via) row.append(el('span', { className: 'muted' }, 'matched on ' + scene.stash.via));
    if (scene.stash.path) row.append(el('code', { className: 'path' }, scene.stash.path));
  }

  if (status === 'absent' && scene.siteId) {
    const add = el('button', { className: 'primary', type: 'button' }, 'Add to Whisparr');
    add.onclick = () => addOne(scene, add, () => renderScene(paint, scene));
    row.append(add);
  }

  return row;
}
