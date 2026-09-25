/*
 * Catch up: fill blanks on scenes with a stash id, by reading that id. No
 * searching or guessing. See catchup.mjs.
 */

import { api, el } from '../util.js';
import { shell } from './core.js';

export const SECTION = '#/parameters/catchup';

export function showCatchUp(paint) {
  shell(paint, SECTION, 'Catch up', 'fill in what the sources can already answer', catchUpBox());
}

function catchUpBox() {
  const said = el('p', { className: 'note' }, 'Reading the library…');
  const bar = el('div', { className: 'catchbar' });
  const go = el('button', { className: 'primary', type: 'button' }, 'Search and update');
  const halt = el('button', { className: 'chip', type: 'button', hidden: true }, 'Stop');

  let timer = null;

  /*
   * The on-screen check lives here, not in look(): the first read runs before
   * the fieldset is in the document.
   */
  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (bar.isConnected) look(); }, 2500);
  };

  const draw = (state) => {
    const { scope = {}, running, step } = state;

    if (!scope.ready) {
      said.textContent = 'This reads and writes your Stash library. Connect it in Settings.';
      go.disabled = true;
      return;
    }

    go.hidden = Boolean(running);
    halt.hidden = !running;

    if (running) {
      const left = state.total ? ` — ${state.done.toLocaleString()} of ${state.total.toLocaleString()}` : '';
      said.textContent = state.stopping
        ? 'Stopping after this scene…'
        : `${step === 'facts' ? 'Filling in the blanks' : 'Looking for timestamps'}${left}.`;
      bar.replaceChildren(el('div', {
        className: 'catchfill',
        style: `width:${state.total ? Math.round((state.done / state.total) * 100) : 0}%`,
      }));
      poll();
      return;
    }

    bar.replaceChildren();

    /* What it did, or would do. */
    const did = state.step === 'done' || state.step === 'stopped'
      ? `Last run filled ${state.fields.toLocaleString()} field${state.fields === 1 ? '' : 's'} on ${state.facts.toLocaleString()} scene${state.facts === 1 ? '' : 's'} and added ${state.markers.toLocaleString()} marker${state.markers === 1 ? '' : 's'} to ${state.scenes.toLocaleString()}. `
      : state.step === 'failed'
        ? `Last run stopped: ${state.error}. `
        : '';

    said.replaceChildren(
      did,
      `${scope.facts.toLocaleString()} scene${scope.facts === 1 ? '' : 's'} have a gap something can fill, and ${scope.timestamps.toLocaleString()} have no markers yet.`,
      scope.stranded
        ? ` ${scope.stranded.toLocaleString()} more have gaps and no stash id — those need the Match page first.`
        : '',
      state.missed?.length
        ? el('span', { className: 'muted' }, ` Could not attach: ${state.missed.slice(0, 6).join(', ')}${state.missed.length > 6 ? '…' : ''} — nothing is created by this, so those want making by hand.`)
        : ''
    );
  };

  const look = () => api('/api/library/catchup').then(draw).catch((err) => {
    said.textContent = err.message;
  });

  go.onclick = async () => {
    go.disabled = true;
    try {
      draw(await api('/api/library/catchup', { method: 'POST', body: '{}' }));
    } catch (err) {
      said.textContent = err.message;
    } finally {
      go.disabled = false;
    }
  };

  halt.onclick = async () => {
    halt.disabled = true;
    try { draw(await api('/api/library/catchup', { method: 'POST', body: JSON.stringify({ stop: true }) })); }
    finally { halt.disabled = false; }
  };

  look();

  return el('fieldset', {},
    el('legend', {}, 'Catch up ',
      el('span', { className: 'muted' }, 'fill in what the sources can already answer')),
    el('p', { className: 'note' },
      'StashDB first, then ThePornDB for whatever is still blank; timestamp.trade first for markers, then ThePornDB. ',
      el('b', {}, 'Only scenes that already carry a stash id are touched'),
      ', and only empty fields are filled — nothing is searched for by title and nothing already there is overwritten.'),
    said,
    bar,
    el('div', { className: 'catchrow' }, go, halt)
  );
}
