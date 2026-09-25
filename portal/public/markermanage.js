/*
 * Marker management: a list of markers from every scene, to find, open,
 * retag, retime or delete. Filters live in the address, rewritten in place.
 */

import { api, el } from './util.js';
import { askTag, palette, remember, stamp } from './markertag.js';

const PER_PAGE = 60;

const SORTS = [
  ['created_at', 'Newest first'],
  ['updated_at', 'Recently changed'],
  ['seconds', 'Time in scene'],
  ['title', 'Title'],
  ['scene_id', 'By scene'],
];

/* mm:ss, mm:ss.t or hh:mm:ss -> seconds, or null. A bare number is seconds. */
function seconds(text) {
  const clean = String(text || '').trim().replace(',', '.');
  if (!clean) return null;
  if (/^\d+(\.\d+)?$/.test(clean)) return Number(clean);
  if (!/^\d{1,2}(:\d{1,2}){1,2}(\.\d+)?$/.test(clean)) return null;

  const parts = clean.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;

  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

export async function manage(body, { params, go, back }) {
  /* ------------------------------------------------------------- the state */

  const state = {
    q: params.get('q') || '',
    tag: params.get('tag') || '',
    sort: params.get('sort') || 'created_at',
  };

  let page = 1;
  let rows = [];
  let count = 0;
  let loading = false;

  const address = () => {
    const out = new URLSearchParams({ manage: '1' });
    if (state.q.trim()) out.set('q', state.q.trim());
    if (state.tag) out.set('tag', state.tag);
    if (state.sort !== 'created_at') out.set('sort', state.sort);
    history.replaceState(null, '', '#/catalogue/markers?' + out.toString());
  };

  /* -------------------------------------------------------------- the bar */

  const find = el('input', {
    className: 'mmfind',
    type: 'search',
    placeholder: 'Find by title, or by the scene it is in…',
    value: state.q,
    spellcheck: false,
  });

  const tagPick = el('select', { className: 'mmtag' },
    el('option', { value: '' }, 'Any tag'));

  const sortPick = el('select', { className: 'mmsort' },
    ...SORTS.map(([value, label]) => el('option', { value }, label)));
  sortPick.value = state.sort;

  const clear = el('button', { className: 'chip', type: 'button', hidden: true }, 'Clear');

  const toQueue = el('button', { className: 'link', type: 'button' }, '← the marking queue');
  toQueue.onclick = () => back();

  const said = el('div', { className: 'mmsaid muted small' }, 'Reading the library…');

  const bar = el('div', { className: 'mmbar' }, find, tagPick, sortPick, clear);

  const list = el('div', { className: 'mmlist' });
  const more = el('button', { className: 'chip mmmore', type: 'button', hidden: true }, 'Show more');

  body.replaceChildren(
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Markers'),
      el('span', { className: 'muted' }, 'everything cut, by hand or by plugin'),
      el('div', { className: 'vgap' }),
      toQueue),
    bar,
    said,
    list,
    more
  );

  /* The marker-tag palette. A tag in the address stays selected even if not listed. */
  palette().then((tags) => {
    tagPick.replaceChildren(
      el('option', { value: '' }, 'Any tag'),
      ...tags
        .filter((t) => t.id)
        .map((t) => el('option', { value: String(t.id) }, t.count ? `${t.name} (${t.count})` : t.name))
    );
    if (state.tag) tagPick.value = state.tag;
  });

  /* ------------------------------------------------------------- the rows */

  const shape = (m) => {
    const scene = m.scene || null;

    /* The time opens the bench if the scene is filed, else the scene page. */
    const where = el('button', { className: 'link mmtime', type: 'button' },
      stamp(m.seconds) + (m.end ? ` → ${stamp(m.end)}` : ''));
    where.title = scene?.filed
      ? 'Open this scene on the bench'
      : 'Not filed — the bench will not open it. Opens the scene page instead.';
    where.onclick = () => {
      if (!scene) return;
      if (scene.filed) go(new URLSearchParams({ scene: scene.id }));
      else location.hash = `#/library/scene/${scene.id}`;
    };

    const name = el('button', { className: 'chip', type: 'button', title: 'Change the tag' },
      m.tag?.name || m.title || 'Marker');
    name.onclick = () => retag(m);

    const sceneName = el('button', { className: 'link mmscene', type: 'button' },
      scene?.title || 'Scene gone');
    sceneName.title = 'The scene page';
    sceneName.onclick = () => { if (scene) location.hash = `#/library/scene/${scene.id}`; };

    const time = el('button', { className: 'mmedit', type: 'button', title: 'Retime this marker' }, '✎');
    time.onclick = (e) => retime(m, e.currentTarget.closest('.mmrow'));

    const drop = el('button', { className: 'mbdrop', type: 'button', title: 'Delete this marker' }, '×');
    drop.onclick = () => remove(m);

    const row = el('div', { className: 'mmrow' + (m.end ? ' span' : '') },
      where,
      name,
      el('div', { className: 'mmwhere' },
        sceneName,
        el('span', { className: 'muted small' },
          [scene?.studio?.name, scene?.date].filter(Boolean).join(' · '))),
      /* Plugin markers are signed in the title; shown only when it differs from the tag. */
      m.title && m.title !== (m.tag?.name || '')
        ? el('span', { className: 'muted small mmtitle' }, m.title)
        : null,
      time,
      drop);

    // Set as an attribute: el() assigns props, and a dashed name would be ignored.
    row.dataset.marker = m.id;
    return row;
  };

  const render = () => {
    if (!rows.length) {
      list.replaceChildren(el('div', { className: 'empty' },
        state.q || state.tag
          ? 'Nothing matches that.'
          : 'No markers in the library yet.'));
      return;
    }
    list.replaceChildren(...rows.map(shape));
  };

  const redrawRow = (m) => {
    const old = list.querySelector(`[data-marker="${m.id}"]`);
    if (old) old.replaceWith(shape(m));
  };

  /* ------------------------------------------------------------ the reads */

  async function load({ append = false } = {}) {
    if (loading) return;
    loading = true;

    if (!append) said.textContent = 'Reading…';
    more.disabled = true;

    const query = new URLSearchParams({ page: String(page), limit: String(PER_PAGE) });
    if (state.q.trim()) query.set('q', state.q.trim());
    if (state.tag) query.set('tag', state.tag);
    if (state.sort) query.set('sort', state.sort);

    try {
      const found = await api('/api/import/markers/all?' + query.toString());
      count = found.count || 0;
      rows = append ? [...rows, ...(found.markers || [])] : (found.markers || []);
      render();

      said.textContent = count
        ? `${rows.length} of ${count.toLocaleString()} marker${count === 1 ? '' : 's'}`
        : 'No markers.';
      more.hidden = rows.length >= count;
    } catch (err) {
      said.textContent = err.message;
      if (!append) { rows = []; render(); }
    } finally {
      loading = false;
      more.disabled = false;
    }
  }

  const again = () => { page = 1; address(); load(); };

  // Whether anything is narrowing the list, which is the only thing Clear is
  // for — a Clear button on an unfiltered list is a button that does nothing.
  const filtered = () => Boolean(state.q.trim() || state.tag || state.sort !== 'created_at');

  /* Search after 200ms of no typing. */
  let typing = null;
  find.oninput = () => {
    state.q = find.value;
    clear.hidden = !filtered();
    clearTimeout(typing);
    typing = setTimeout(again, 200);
  };

  tagPick.onchange = () => { state.tag = tagPick.value; clear.hidden = !filtered(); again(); };
  sortPick.onchange = () => { state.sort = sortPick.value; clear.hidden = !filtered(); again(); };

  clear.onclick = () => {
    state.q = '';
    state.tag = '';
    state.sort = 'created_at';
    find.value = '';
    tagPick.value = '';
    sortPick.value = 'created_at';
    clear.hidden = true;
    again();
  };

  more.onclick = () => { page += 1; load({ append: true }); };

  clear.hidden = !filtered();

  /* ----------------------------------------------------------- the writes */

  const swap = (saved) => {
    rows = rows.map((m) => (String(m.id) === String(saved.id) ? { ...m, ...saved } : m));
    redrawRow(rows.find((m) => String(m.id) === String(saved.id)));
  };

  async function retag(m) {
    const chosen = await askTag({ seconds: m.seconds, end: m.end });
    if (!chosen) return;

    said.textContent = 'Writing…';
    try {
      const { marker } = await api(`/api/import/markers/marker/${m.id}`, {
        method: 'POST',
        body: JSON.stringify(chosen),
      });
      remember(marker.tag);
      swap({ ...marker, scene: m.scene });
      said.textContent = `Now ${marker.tag?.name || 'untagged'}.`;
    } catch (err) {
      said.textContent = err.message;
    }
  }

  /* Retime in the row: start and end; empty the end to make it a point. */
  function retime(m, row) {
    if (!row || row.querySelector('.mmretime')) return;

    const from = el('input', { className: 'mmfield', type: 'text', value: stamp(m.seconds), spellcheck: false });
    const to = el('input', {
      className: 'mmfield',
      type: 'text',
      value: m.end ? stamp(m.end) : '',
      placeholder: 'no end',
      spellcheck: false,
    });

    const save = el('button', { className: 'chip', type: 'button' }, 'Save');
    const stop = el('button', { className: 'link', type: 'button' }, 'cancel');

    const panel = el('div', { className: 'mmretime' },
      el('span', { className: 'muted small' }, 'start'), from,
      el('span', { className: 'muted small' }, 'end'), to,
      save, stop);

    const close = () => panel.remove();
    stop.onclick = close;

    save.onclick = async () => {
      const start = seconds(from.value);
      if (start == null) { said.textContent = 'That start time is not a time.'; return; }

      const end = to.value.trim() ? seconds(to.value) : null;
      if (to.value.trim() && end == null) { said.textContent = 'That end time is not a time.'; return; }
      if (end != null && end <= start) { said.textContent = 'The end has to come after the start.'; return; }

      said.textContent = 'Writing…';
      try {
        const { marker } = await api(`/api/import/markers/marker/${m.id}`, {
          method: 'POST',
          body: JSON.stringify({ seconds: start, end }),
        });
        close();
        swap({ ...marker, scene: m.scene });
        said.textContent = `Moved to ${stamp(marker.seconds)}.`;
      } catch (err) {
        said.textContent = err.message;
      }
    };

    from.onkeydown = (e) => { if (e.key === 'Enter') save.onclick(); if (e.key === 'Escape') close(); };
    to.onkeydown = from.onkeydown;

    row.append(panel);
    from.focus();
    from.select();
  }

  async function remove(m) {
    const what = m.tag?.name || m.title || 'this marker';
    if (!window.confirm(`Delete ${what} at ${stamp(m.seconds)}? Markers do not come back.`)) return;

    said.textContent = 'Removing…';
    try {
      await api(`/api/import/markers/marker/${m.id}`, { method: 'DELETE' });
      rows = rows.filter((row) => String(row.id) !== String(m.id));
      count = Math.max(0, count - 1);
      render();
      said.textContent = `Removed. ${rows.length} of ${count.toLocaleString()} shown.`;
    } catch (err) {
      said.textContent = err.message;
    }
  }

  address();
  await load();
}
