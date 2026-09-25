/*
 * Timestamps from timestamp.trade and ThePornDB, reviewed before they're
 * written. The plugins overwrite any marker within 15s of an incoming one;
 * here each collision is a row you decide. An offset shifts every row, to
 * fix a set that's right about the scene but off for this file.
 */

import { api, el } from './util.js';
import { stamp } from './markertag.js';

/* Collision window: 15s, the plugins' own. */
const COLLIDE = 15;

/*
 * Imported markers are signed like the plugins' ([TsTrade], [TPDBMarker]).
 * Hand-cut ones have no title.
 */
const SIGN = { tstrade: '[TsTrade]', tpdb: '[TPDBMarker]' };

const TAKE = [
  ['skip', 'Skip'],
  ['add', 'Add alongside'],
  ['replace', 'Replace'],
];

/*
 * -> a panel, already fetching. `markers`: the bench's list, for collisions.
 * `goTo` seeks the bench; `done` gets what was written.
 */
export function timestamps(host, { sceneId, markers = [], goTo, note, done }) {
  const head = el('div', { className: 'mfhead' });
  const body = el('div', { className: 'mfbody' }, el('div', { className: 'empty small' }, 'Asking both sources…'));
  const foot = el('div', { className: 'mffoot' });

  const panel = el('div', { className: 'mfpanel' },
    el('div', { className: 'mftop' },
      el('strong', {}, 'Timestamps'),
      el('span', { className: 'muted small' }, 'from timestamp.trade and ThePornDB — nothing is written until you say so'),
      el('div', { className: 'vgap' })),
    head, body, foot);

  const close = () => panel.remove();

  const shut = el('button', { className: 'mfclose', type: 'button', title: 'Close' }, '×');
  shut.onclick = close;
  panel.querySelector('.mftop').append(shut);

  host.append(panel);

  /* ------------------------------------------------------------ the state */

  let sources = [];
  let showing = null;
  // Per source: offset in seconds, and per row what to do with it.
  const state = new Map();

  const have = () => markers.slice().sort((a, b) => a.seconds - b.seconds);

  /* The nearest existing marker within the window, or null. */
  const collides = (seconds) => {
    let best = null;
    for (const m of have()) {
      const gap = Math.abs(m.seconds - seconds);
      if (gap <= COLLIDE && (!best || gap < Math.abs(best.seconds - seconds))) best = m;
    }
    return best;
  };

  const rowsOf = (source) => state.get(source.key)?.rows || [];
  const offsetOf = (source) => state.get(source.key)?.offset || 0;

  // Where a row would actually be written, which is the source's time plus
  // whatever the offset field says. Never before the start of the scene.
  const timeOf = (row, offset) => ({
    seconds: Math.max(0, Math.round((row.seconds + offset) * 10) / 10),
    end: row.end == null ? null : Math.max(0, Math.round((row.end + offset) * 10) / 10),
  });

  /* -------------------------------------------------------------- drawing */

  function drawHead() {
    const tabs = sources.map((source) => {
      const count = source.markers.length;
      const node = el('button', {
        className: 'chip mftab' + (source === showing ? ' on' : ''),
        type: 'button',
      }, source.name, count ? el('span', { className: 'muted' }, ` ${count}`) : null);
      node.onclick = () => { showing = source; draw(); };
      node.disabled = !count;
      return node;
    });

    head.replaceChildren(el('div', { className: 'mftabs' }, ...tabs));
  }

  function drawFoot() {
    if (!showing || !showing.markers.length) { foot.replaceChildren(); return; }

    const rows = rowsOf(showing);
    const adding = rows.filter((r) => r.take === 'add').length;
    const replacing = rows.filter((r) => r.take === 'replace').length;

    const write = el('button', { className: 'chip mfwrite', type: 'button' },
      adding || replacing
        ? `Write ${[adding && `add ${adding}`, replacing && `replace ${replacing}`].filter(Boolean).join(' · ')}`
        : 'Nothing ticked');
    write.disabled = !adding && !replacing;
    write.onclick = () => commit();

    const cancel = el('button', { className: 'link', type: 'button' }, 'cancel');
    cancel.onclick = close;

    foot.replaceChildren(write, cancel);
  }

  function draw() {
    drawHead();

    if (!showing) {
      /* Nothing to review, and each source's reason. */
      body.replaceChildren(el('div', { className: 'mfnone' },
        ...sources.map((source) => el('div', { className: 'muted small' },
          el('strong', {}, source.name), ' — ', source.reason || 'nothing found.'))));
      drawFoot();
      return;
    }

    const offset = offsetOf(showing);
    const rows = rowsOf(showing);
    const hit = rows.filter((r) => r.onto).length;

    /* the offset, and what it is for */

    const field = el('input', {
      className: 'mffield',
      type: 'text',
      value: String(offset),
      spellcheck: false,
      title: 'Seconds to add to every row. Negative moves them earlier.',
    });

    const apply = () => {
      const n = Number(field.value.replace(',', '.').trim());
      if (!Number.isFinite(n)) { field.value = String(offset); return; }
      const held = state.get(showing.key);
      held.offset = Math.round(n * 10) / 10;
      // Recompute collisions after an offset change.
      recollide(showing);
      draw();
    };

    field.onchange = apply;
    field.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } };

    const bump = (by) => {
      const node = el('button', { className: 'mfbump', type: 'button' }, by > 0 ? `+${by}` : String(by));
      node.onclick = () => {
        const held = state.get(showing.key);
        held.offset = Math.round((held.offset + by) * 10) / 10;
        recollide(showing);
        draw();
      };
      return node;
    };

    const all = (take) => {
      const node = el('button', { className: 'chip small', type: 'button' },
        take === 'replace' ? 'replace them all' : 'skip them all');
      node.onclick = () => {
        for (const row of rows) if (row.onto) row.take = take;
        draw();
      };
      return node;
    };

    const bar = el('div', { className: 'mfbar' },
      el('span', { className: 'muted small' }, 'shift every row by'),
      bump(-1), field, el('span', { className: 'muted small' }, 's'), bump(1),
      el('div', { className: 'vgap' }),
      showing.scene
        ? el('a', { className: 'muted small', href: showing.scene, target: '_blank', rel: 'noopener' }, 'the source ↗')
        : null);

    const warn = hit
      ? el('div', { className: 'mfwarn small' },
          `${hit} of ${rows.length} land within ${COLLIDE}s of a marker you already have — `,
          all('replace'), ' ', all('skip'))
      : null;

    /* the rows */

    const drawn = rows.map((row) => {
      const when = timeOf(row, offset);

      const jump = el('button', { className: 'link mftime', type: 'button' },
        stamp(when.seconds) + (when.end != null ? ` → ${stamp(when.end)}` : ''));
      jump.title = 'Take the playhead there';
      jump.onclick = () => goTo(when.seconds);

      /* The tag is editable: fetched names often differ from yours. */
      const tag = el('input', { className: 'mftag', type: 'text', value: row.tag, spellcheck: false });
      tag.onchange = () => { row.tag = tag.value.replace(/\s+/g, ' ').trim() || row.tag; tag.value = row.tag; };

      const node = el('div', { className: 'mfrow' + (row.onto ? ' onto' : '') });

      if (row.onto) {
        /* A collision is Skip, Replace or Add; starts on Skip. */
        const pick = el('select', { className: 'mfpick' },
          ...TAKE.map(([value, label]) => el('option', { value }, label)));
        pick.value = row.take;
        pick.onchange = () => { row.take = pick.value; drawFoot(); };

        const onto = el('button', { className: 'link mfonto small', type: 'button' },
          `${row.onto.tag?.name || row.onto.title || 'Marker'} at ${stamp(row.onto.seconds)}`);
        onto.title = 'The marker this would land on';
        onto.onclick = () => goTo(row.onto.seconds);

        node.append(jump, tag, el('span', { className: 'muted small' }, 'onto'), onto, pick);
      } else {
        const tick = el('input', { className: 'mftick', type: 'checkbox' });
        tick.checked = row.take === 'add';
        tick.onchange = () => { row.take = tick.checked ? 'add' : 'skip'; drawFoot(); };
        node.append(tick, jump, tag);
      }

      return node;
    });

    body.replaceChildren(bar, warn, el('div', { className: 'mfrows' }, ...drawn));
    drawFoot();
  }

  /* ------------------------------------------------------------ collisions */

  function recollide(source) {
    const offset = offsetOf(source);
    for (const row of rowsOf(source)) {
      const when = timeOf(row, offset);
      const onto = collides(when.seconds);
      const was = row.onto;
      row.onto = onto;

      /* Reset a row's answer only when it changes side. */
      if (!was && onto) row.take = 'skip';
      if (was && !onto) row.take = 'add';
    }
  }

  /* ---------------------------------------------------------- the writing */

  async function commit() {
    const source = showing;
    const offset = offsetOf(source);
    const rows = rowsOf(source).filter((r) => r.take !== 'skip');
    if (!rows.length) return;

    foot.replaceChildren(el('span', { className: 'muted small' }, `Writing 0 of ${rows.length}…`));

    const wrote = { added: [], changed: [] };
    let failed = 0;

    /* Written one at a time, in order. */
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const when = timeOf(row, offset);
      const title = `${SIGN[source.key] || ''} ${row.name || row.tag}`.trim();

      try {
        if (row.take === 'replace' && row.onto) {
          const { marker } = await api(`/api/import/markers/marker/${row.onto.id}`, {
            method: 'POST',
            body: JSON.stringify({ seconds: when.seconds, end: when.end, tagName: row.tag, title }),
          });
          wrote.changed.push(marker);
        } else {
          const { marker } = await api(`/api/import/markers/scene/${sceneId}`, {
            method: 'POST',
            body: JSON.stringify({ seconds: when.seconds, end: when.end, tagName: row.tag, title }),
          });
          wrote.added.push(marker);
        }
      } catch (err) {
        failed += 1;
        if (note) note(err.message, true);
      }

      foot.replaceChildren(el('span', { className: 'muted small' }, `Writing ${i + 1} of ${rows.length}…`));
    }

    if (done) done(wrote);

    if (note) {
      const said = [
        wrote.added.length ? `${wrote.added.length} added` : '',
        wrote.changed.length ? `${wrote.changed.length} replaced` : '',
        failed ? `${failed} failed` : '',
      ].filter(Boolean).join(', ');
      note(`${source.name}: ${said || 'nothing written'}.`, Boolean(failed));
    }

    close();
  }

  /* ------------------------------------------------------------- the fetch */

  api(`/api/import/markers/scene/${sceneId}/sources`)
    .then((found) => {
      // Closed while both sources were being asked. Nothing to draw into.
      if (!panel.isConnected) return;

      sources = found.sources || [];

      for (const source of sources) {
        state.set(source.key, {
          offset: 0,
          rows: source.markers.map((m) => ({ ...m, take: 'add', onto: null })),
        });
        recollide(source);
      }

      // Whichever has anything, best first. A source with nothing is still a
      // tab, because "timestamp.trade has none" is worth being able to see.
      showing = sources.find((s) => s.markers.length) || null;
      draw();
    })
    .catch((err) => {
      if (!panel.isConnected) return;
      body.replaceChildren(el('div', { className: 'empty small' }, err.message));
    });

  return panel;
}
