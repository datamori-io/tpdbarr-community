/*
 * Sending: the nightly release schedule (see release.mjs). "Send N now"
 * stays on the want list.
 */

import { api, el } from '../util.js';
import { shell } from './core.js';

export const SECTION = '#/parameters/sending';

export function showSending(paint) {
  shell(paint, SECTION, 'Sending', 'how fast the want list drains into Whisparr', scheduleBox());
}

function scheduleBox() {
  const box = el('div', { className: 'releasebar' });

  const draw = (state) => {
    if (!state.ready) {
      box.replaceChildren(el('span', { className: 'muted small' },
        'Whisparr v3 needs a root folder and quality profile before anything can be sent.'));
      return;
    }

    const toggle = el('input', { type: 'checkbox', checked: Boolean(state.on) });
    toggle.onchange = () => save({ on: toggle.checked });

    const many = el('input', {
      type: 'number', className: 'releasenum', min: '1', max: '50', value: String(state.perDay),
    });
    many.onchange = () => save({ perDay: Number(many.value) });

    const at = el('input', {
      type: 'number', className: 'releasenum', min: '0', max: '23', value: String(state.hour),
    });
    at.onchange = () => save({ hour: Number(at.value) });

    /* How many days the list will take at this rate. */
    const days = state.waiting && state.perDay ? Math.ceil(state.waiting / state.perDay) : 0;

    const note = el('span', { className: 'muted small' },
      state.waiting == null
        ? ''
        : state.waiting
          ? `${state.waiting.toLocaleString()} waiting to be sent — about ${days.toLocaleString()} night${days === 1 ? '' : 's'} at this rate.`
          : 'Everything on the list has been sent to Whisparr.');

    box.replaceChildren(
      el('label', { className: 'check' }, toggle, ' Send'),
      many,
      el('span', { className: 'muted small' }, 'a night, from'),
      at,
      el('span', { className: 'muted small' }, "o'clock"),
      el('span', { className: 'vgap' }),
      note
    );
  };

  const save = async (patch) => {
    try {
      draw(await api('/api/acquire/release', { method: 'POST', body: JSON.stringify(patch) }));
    } catch (err) {
      box.replaceChildren(el('span', { className: 'muted small' }, err.message));
    }
  };

  api('/api/acquire/release').then(draw).catch(() => {});
  return box;
}
