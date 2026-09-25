/*
 * The tag prompt and palette, shared by the bench and the player bars. The
 * palette is module-level so a tag created on one page is offered on the next.
 */

import { api, el } from './util.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const two = (n) => String(Math.floor(n)).padStart(2, '0');

/* hh:mm:ss.t */
export function stamp(seconds, { tenths = true } = {}) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const whole = `${h ? h + ':' + two(m) : two(m)}:${two(rest)}`;
  return tenths ? `${whole}.${Math.floor((rest % 1) * 10)}` : whole;
}

/* Touch rather than mouse, checked each time (tablets change). */
export const coarse = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/* ------------------------------------------------------------- the palette */

let choices = null;
let asked = null;

/*
 * -> marker tags, most used, behind the three seeds. One request per page
 * load; a failure gives an empty palette (typing still works).
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
 * -> { tagId, tagName }, or null if thrown away. The caller writes.
 * `host` removes the panel when the page goes; the panel is positioned
 * against the window.
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

    /* Cancel, since phones have no Esc. */
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

      // Create is offered last, never highlighted.
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
     * On the window, capturing: the box isn't focused on touch, and the page's
     * own keydown listener must not see these.
     */
    function onKey(e) {
      if (e.ctrlKey || e.metaKey) return;

      const stop = () => { e.preventDefault(); e.stopPropagation(); };

      if (e.key === 'Escape') { stop(); close(); decided(null); return; }
      if (e.key === 'Enter') { stop(); take(shown[cursor]); return; }
      if (e.key === 'ArrowDown') { stop(); cursor = Math.min(shown.length - 1, cursor + 1); shape(); return; }
      if (e.key === 'ArrowUp') { stop(); cursor = Math.max(0, cursor - 1); shape(); return; }

      /* A digit picks an option only while the box is empty ("69" is a tag). */
      if (!input.value && /^[1-9]$/.test(e.key)) {
        stop();
        take(shown[Number(e.key) - 1]);
      }
    }

    window.addEventListener('keydown', onKey, true);

    cancel.onclick = () => { close(); decided(null); };

    shape();
    (host || document.body).append(panel);

    /* Don't focus on touch: the keyboard would cover the presets. */
    if (!touch) input.focus();
  });
}

/*
 * "Mark this moment" for a page with a video.
 * -> the marker as written, or null if cancelled. Throws on a failed write.
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
