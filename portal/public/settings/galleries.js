/*
 * Galleries — where a built one lands, and the builder itself.
 *
 * The untied builder used to sit at the top of the Galleries shelf, above the
 * wall of what you already hold. It is a setup question wearing a shelf's
 * clothes: you open that page to look at galleries, not to make one, and the
 * panel pushed the wall down every time. The tied ones stay where they are —
 * a scene's builder knows which scene it is for, and that is the whole reason
 * to press it there.
 */

import { el } from '../util.js';
import { buildPanel, setupCheck } from '../library/galleries.js';
import { galleryFieldset, saveConfig } from './connections.js';
import { shell } from './core.js';

export const SECTION = '#/parameters/galleries';

export function showGallerySettings(paint) {
  shell(paint, SECTION, 'Galleries', 'where a built one lands, and what builds it',
    folders(),
    builder());
}

/*
 * The two paths, which are one folder named twice. They are part of the
 * connections form wherever they are standing, so Save here writes the whole
 * config — see connections.js.
 */
function folders() {
  const note = el('p', { className: 'note' });
  const check = el('div', {}, setupCheck());
  const save = el('button', { className: 'primary', type: 'button' }, 'Save folders');

  save.onclick = async () => {
    save.disabled = true;
    note.textContent = '';
    try {
      const warnings = await saveConfig();
      note.textContent = warnings.length ? warnings.join('\n') : 'Saved.';
      // Whether Stash can actually see the folder is the next question, and
      // the answer has just changed.
      check.replaceChildren(setupCheck());
    } catch (err) {
      note.textContent = err.message;
    }
    save.disabled = false;
  };

  return el('div', {}, galleryFieldset(), check, note, el('menu', {}, save));
}

function builder() {
  return el('fieldset', {},
    el('legend', {}, 'Build a gallery ', el('span', { className: 'muted' }, 'from a page, or your own pictures')),
    el('p', { className: 'note' },
      'Pictures from a web page, or a zip of your own. Nothing is tied to a scene or a performer from here — ',
      'for that, press Build a gallery on their own page, which ties it as it goes.'),
        // The folder check is already the box above; the panel's own copy of it
    // would say the same thing twice.
    buildPanel({ label: 'Build a gallery', setup: false })
  );
}
