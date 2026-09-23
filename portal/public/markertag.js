/*
 * The tag prompt, and the palette behind it.
 *
 * This was inside the marker builder, where it is the last step of `t` — a
 * marker is not written until somebody has said what it is. It is out here now
 * because the scene players ask the same question: the button on the player
 * bar drops a point at the current second, and the only difference between
 * that and the bench's `t` is which page it was pressed on.
 *
 * The palette is module-level rather than per-page for the same reason it was
 * already held across markers within one bench: the answer is usually the same
 * tag again, and a tag created on a scene page should be on the list the next
 * page offers without a round trip to be told what we just said.
 */

import { api, el } from './util.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const two = (n) => String(Math.floor(n)).padStart(2, '0');

/*
 * hh:mm:ss.t — tenths, because a marker placed with the arrow keys is placed
 * more precisely than a scrub bar can show, and a readout that rounds to the
 * second cannot say that it worked.
 */
export function stamp(seconds, { tenths = true } = {}) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const whole = `${h ? h + ':' + two(m) : two(m)}:${two(rest)}`;
  return tenths ? `${whole}.${Math.floor((rest % 1) * 10)}` : whole;
}

/*
 * A finger rather than a pointer. Asked at the moment it matters rather than
 * once at load, because the answer can change under you — a tablet with a
 * keyboard folded on and off is the ordinary case, not the clever one.
 */
export const coarse = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/* ------------------------------------------------------------- the palette */

let choices = null;
let asked = null;

/*
 * -> the tags a marker can wear, most-used first behind the three seeds.
 *
 * One request per page load however many prompts are opened. A failure is
 * answered with an empty palette rather than an error: typing a name still
 * works, and a prompt that refuses to open because a list did not load is a
 * worse answer than one with nothing premade on it.
 */
export function palette() {
  if (choices) return Promise.resolve(choices);
  if (!asked) {
    asked = api('/api/import/markers/tags')
      .then((found) => { choices = found.tags || []; return choices; })
      .catch(() => { choices = []; return choices; });
  }
  return asked;
}

// A tag that has just been used. Joins the list so the next prompt offers it.
export function remember(tag) {
  if (!tag || !tag.id) return;
  if (!choices) choices = [];
  if (choices.some((t) => String(t.id) === String(tag.id))) return;
  choices = [...choices, { id: tag.id, name: tag.name, count: 0 }];
}

/* -------------------------------------------------------------- the prompt */

/*
 * -> { tagId, tagName } once something is picked, or null if it was thrown
 * away. Nothing is written here; the caller does that, because what it writes
 * to differs — a new marker on the bench, a new marker from a player bar, a
 * retag of one that already exists.
 *
 * `host` is only what removes the panel when the page goes away: it is
 * positioned against the window rather than against whatever it is inside.
 */
export async function askTag({ seconds, end = null, host = null } = {}) {
  await palette();

  return new Promise((decided) => {
    // Asked once per prompt rather than per render, so the panel cannot change
    // its mind about which device it is on halfway through.
    const touch = coarse();

    const input = el('input', {
      className: 'mbtaginput',
      type: 'text',
      placeholder: 'Tag this — type to filter, or type a new name',
      spellcheck: false,
    });

    const options = el('div', { className: 'mboptions' });

    /*
     * Esc throws the marker away, and Esc is a key. Without a button here a
     * phone has no way out of the prompt at all — the marker is not written
     * until a tag is picked, so the only exit would be to pick a wrong one and
     * delete it afterwards.
     */
    const cancel = el('button', { className: 'mbcancel', type: 'button' }, 'Cancel');

    const panel = el('div', { className: 'mbprompt' },
      el('div', { className: 'mbpromptwhat' },
        end != null ? `${stamp(seconds)} → ${stamp(end)}` : stamp(seconds),
        el('span', { className: 'muted' }, end != null ? ' span' : ' point')),
      input,
      options,
      el('div', { className: 'mbpromptfoot' },
        el('span', { className: 'muted small' },
          touch ? 'Tap a tag, or type a name of your own.' : 'Enter to use · 1–9 to pick · Esc to throw it away'),
        cancel)
    );

    let shown = [];
    let cursor = 0;
    let done = false;

    const shape = () => {
      const text = input.value.replace(/\s+/g, ' ').trim();
      const lower = text.toLowerCase();
      const have = choices || [];

      const hits = text ? have.filter((t) => t.name.toLowerCase().includes(lower)) : have.slice(0, 12);
      const exact = have.some((t) => t.name.toLowerCase() === lower);

      // Creating is offered last, not first — the whole reason the palette
      // exists is that the answer is usually already in it, and an offer to
      // make a second "Kissing" should never be the highlighted one.
      shown = [
        ...hits.slice(0, 9).map((t) => ({ kind: 'have', tag: t, label: t.name, count: t.count })),
        ...(text && !exact ? [{ kind: 'new', label: text }] : []),
      ];

      cursor = clamp(cursor, 0, Math.max(0, shown.length - 1));

      options.replaceChildren(...shown.map((option, i) => {
        const node = el('button', {
          className: 'mboption' + (i === cursor ? ' on' : '') + (option.kind === 'new' ? ' new' : ''),
          type: 'button',
        },
          el('span', { className: 'mbkey' }, i < 9 ? String(i + 1) : ''),
          option.kind === 'new' ? `Create “${option.label}”` : option.label,
          option.kind === 'have' && option.count
            ? el('span', { className: 'muted' }, ` ${option.count}`)
            : null
        );
        node.onmousedown = (e) => { e.preventDefault(); take(option); };
        return node;
      }));
    };

    const close = () => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      panel.remove();
    };

    const take = (option) => {
      if (!option) return;
      close();
      decided(option.kind === 'new'
        ? { tagName: option.label }
        : { tagId: option.tag.id, tagName: option.tag.name });
    };

    input.oninput = shape;

    /*
     * On the window rather than only on the box, and capturing — the box is
     * not focused on a touch device (see the foot of this function), and the
     * page underneath has its own keydown listener that must not see any of
     * these while the prompt is open.
     */
    function onKey(e) {
      if (e.ctrlKey || e.metaKey) return;

      const stop = () => { e.preventDefault(); e.stopPropagation(); };

      if (e.key === 'Escape') { stop(); close(); decided(null); return; }
      if (e.key === 'Enter') { stop(); take(shown[cursor]); return; }
      if (e.key === 'ArrowDown') { stop(); cursor = Math.min(shown.length - 1, cursor + 1); shape(); return; }
      if (e.key === 'ArrowUp') { stop(); cursor = Math.max(0, cursor - 1); shape(); return; }

      /*
       * A digit picks an option only while the box is empty. Once there is
       * text in it the digit is part of a name — "69" is a tag somebody will
       * type — and stealing it would make that tag unnameable.
       */
      if (!input.value && /^[1-9]$/.test(e.key)) {
        stop();
        take(shown[Number(e.key) - 1]);
      }
    }

    window.addEventListener('keydown', onKey, true);

    cancel.onclick = () => { close(); decided(null); };

    shape();
    (host || document.body).append(panel);

    /*
     * Not on a phone. Focusing the box summons the software keyboard, which
     * covers a panel pinned to the bottom of the screen — and what it covers
     * is the list of presets, which is the answer nine times in ten. Tapping
     * the field is how you say you would rather type.
     */
    if (!touch) input.focus();
  });
}

/*
 * The whole of "mark this moment", for a page that has a video and no bench.
 *
 * -> the marker as Stash wrote it, or null if the prompt was thrown away.
 * Throws only on a write that failed, which the caller says out loud in
 * whatever way that page says things.
 */
export async function markHere(sceneId, seconds, { end = null, host = null } = {}) {
  const chosen = await askTag({ seconds, end, host });
  if (!chosen) return null;

  const { marker } = await api(`/api/import/markers/scene/${sceneId}`, {
    method: 'POST',
    body: JSON.stringify({ seconds, end, ...chosen }),
  });

  remember(marker.tag);
  return marker;
}
