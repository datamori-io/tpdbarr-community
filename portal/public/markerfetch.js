/*
 * Timestamps from somewhere else, reviewed before they land.
 *
 * timestamp.trade and ThePornDB both know a great many of this library's
 * scenes, and both have Stash plugins that will pour what they know straight
 * in. This is the same two sources and the opposite arrangement: nothing is
 * written until somebody has looked at it.
 *
 * That is not caution for its own sake. The plugins hand their answer to
 * `import_scene_markers(..., 15)`, which *rewrites an existing marker in
 * place* whenever exactly one sits within fifteen seconds of an incoming one —
 * which is how 156 timestamp.trade markers in this library were retimed and
 * retitled by a single unattended TPDB pass, and why the run order of those
 * two plugins is close to permanent. Here a collision is a row on screen that
 * names what it would land on, and it does nothing until it is told which of
 * three things to do.
 *
 * The offset is the other half of the reason this is a panel rather than a
 * button. A fetched set is regularly right about the scene and wrong about the
 * file: a different cut, an intro the encode dropped, a couple of seconds of
 * black at the head. One field shifts every row at once, and the times on
 * screen are what would be written — so it can be checked against the picture
 * before anything is.
 */

import { api, el } from './util.js';
import { stamp } from './markertag.js';

/*
 * What counts as landing on a marker you already have.
 *
 * Fifteen seconds, and the number is borrowed rather than chosen: it is the
 * window the two plugins already match on, so it is the window this library's
 * markers were shaped by. A tighter one here would call two markers separate
 * that the next plugin run would treat as the same one.
 */
const COLLIDE = 15;

/*
 * How an imported marker is signed.
 *
 * The plugins write their provenance into the marker title — `[TsTrade]` and
 * `[TPDBMarker]` — and that prefix is the only record in Stash of where a
 * marker came from. A marker fetched here came from exactly the same place as
 * one the plugin would have fetched, so it is signed the same way: one
 * convention for the library rather than a second one that means the same
 * thing. A hand-cut marker still has no title at all, which is what tells it
 * apart from both.
 */
const SIGN = { tstrade: '[TsTrade]', tpdb: '[TPDBMarker]' };

const TAKE = [
  ['skip', 'Skip'],
  ['add', 'Add alongside'],
  ['replace', 'Replace'],
];

/*
 * -> a panel, already fetching. `host` is what it is appended to; `markers` is
 * the bench's current list, used for the collisions; `goTo` seeks the bench so
 * a row can be checked against the picture; `done` is handed what was written
 * so the bench can put it on its own timeline without asking Stash again.
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

  /*
   * The marker this row would land on, or null. The nearest one within the
   * window rather than the first — two markers inside fifteen seconds of each
   * other is ordinary on a dense scene, and naming the further one would be a
   * confusing thing to be asked about.
   */
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
      /*
       * Nothing to review, and why. Both sources report their own reason —
       * no id of the right kind, a request that failed, or a scene they know
       * and have nothing on — because those are three different problems and
       * only one of them is worth doing anything about.
       */
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
      // The collisions move with the times, so they are worked out again
      // rather than kept — a row shifted twelve seconds is a different
      // question about the same marker.
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

      /*
       * The tag is a field rather than a label. What comes back is somebody
       * else's vocabulary — "Pussy Licking" against a palette that says
       * "Licking" — and the write end matches an existing tag by name before
       * it creates one, so correcting the word here is what keeps a fetch from
       * growing the tag list.
       */
      const tag = el('input', { className: 'mftag', type: 'text', value: row.tag, spellcheck: false });
      tag.onchange = () => { row.tag = tag.value.replace(/\s+/g, ' ').trim() || row.tag; tag.value = row.tag; };

      const node = el('div', { className: 'mfrow' + (row.onto ? ' onto' : '') });

      if (row.onto) {
        /*
         * A collision is a choice rather than a tick, because there are three
         * honest answers and a checkbox only carries two. It starts on Skip:
         * the marker that is already there was put there on purpose, possibly
         * by hand, and the burden is on the incoming one.
         */
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

      /*
       * A row only has its answer reset when it changes side. Somebody who has
       * said Replace to a row and then nudged the offset a tenth still means
       * Replace; somebody whose row has just stopped colliding meant Add.
       */
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

    /*
     * One at a time and in order. Each write is a Stash mutation that may also
     * create a tag, and firing twelve of those at once at a server that is
     * also serving the video is how you get a timeout that leaves half a set
     * written with no record of which half.
     */
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
