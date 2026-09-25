/*
 * ------------------------------------------------------------ their picture
 *
 * Replace a performer's photo or studio's logo. Writes into Stash, which
 * keeps no copy of the old one, so it asks twice when there's a picture to
 * lose, once when there isn't.
 */

import { el } from '../util.js';

export function pictureBox({ kind, id, has, name, onDone }) {
  const what = kind === 'performers' ? 'photograph' : 'logo';

  const chooser = el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif',
  });

  const go = el('button', { className: 'act', type: 'button' }, `Replace the ${what}`);
  const off = el('button', { className: 'act', type: 'button', hidden: !has }, `Remove the ${what}`);
  const yes = el('button', { className: 'act danger', type: 'button', hidden: true }, 'Replace it');
  const no = el('button', { className: 'act', type: 'button', hidden: true }, 'Cancel');
  const said = el('span', { className: 'muted small' }, '');

  // Which action the confirmation is for.
  let pending = null;

  const reset = () => {
    pending = null;
    go.hidden = false;
    off.hidden = !has;
    yes.hidden = true;
    no.hidden = true;
    yes.textContent = 'Replace it';
  };

  const send = async () => {
    const file = chooser.files[0];
    said.textContent = `Sending ${file.name}…`;
    go.disabled = true;
    yes.disabled = true;

    try {
      // Not api(): that stamps a JSON content type on anything with a body,
      // and this body is a picture.
      const res = await fetch(`/api/library/${kind}/${id}/image`, { method: 'POST', body: file });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || res.statusText);

      said.textContent = 'Done.';
      reset();
      onDone?.();
    } catch (err) {
      said.textContent = err.message;
      reset();
    } finally {
      go.disabled = false;
      yes.disabled = false;
    }
  };

  const remove = async () => {
    said.textContent = 'Removing…';
    go.disabled = true;
    yes.disabled = true;

    try {
      const res = await fetch(`/api/library/${kind}/${id}/image`, { method: 'DELETE' });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || res.statusText);

      said.textContent = 'Removed.';
      reset();
      onDone?.();
    } catch (err) {
      said.textContent = err.message;
      reset();
    } finally {
      go.disabled = false;
      yes.disabled = false;
    }
  };

  const ask = (what_for, line, label) => {
    pending = what_for;
    said.textContent = line;
    yes.textContent = label;
    go.hidden = true;
    off.hidden = true;
    yes.hidden = false;
    no.hidden = false;
  };

  go.onclick = () => {
    if (!chooser.files[0]) { said.textContent = `Choose a picture to use as the ${what}.`; return; }

    // Nothing to lose, so nothing to ask about.
    if (!has) return send();

    ask('send',
      `This replaces ${name}'s ${what} in Stash, and Stash keeps no copy of the old one.`,
      'Replace it');
  };

  off.onclick = () => ask('remove',
    `This takes ${name}'s ${what} off in Stash, and Stash keeps no copy of it.`,
    `Remove the ${what}`);

  yes.onclick = () => (pending === 'remove' ? remove() : send());
  no.onclick = () => { reset(); said.textContent = ''; };

  return el('div', { className: 'pictureswap' },
    el('div', { className: 'toolbar' }, chooser, go, off, yes, no),
    said
  );
}
