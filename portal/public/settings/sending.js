/*
 * Sending — the nightly trickle out of the want list.
 *
 * This lived on the Tracked page, beside the list it drains, on the argument
 * that a switch nobody can see beside the thing it acts on is a switch nobody
 * remembers is on. That was right when the page was one column; it stopped
 * being right when the page grew a second layer of tabs and the bar ended up
 * halfway down one of them. A schedule is set about twice a year, and a
 * control you touch twice a year is a setting.
 *
 * What did not come with it is "Send N now". That one is not a schedule, it is
 * a thing you do to the list while looking at it, so it stays on the list. See
 * release.mjs for why it is a trickle and why the ten are random.
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

    /*
     * How long the list will take at this rate. The number people actually want
     * from a trickle is not "ten a night", it is "so when is it done".
     */
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
