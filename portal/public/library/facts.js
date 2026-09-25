/* The facts grid for performers and studios, and the gaps-only save button. */

import { api, el } from '../util.js';
import { grid } from './tiles.js';

/*
 * Performer vitals beside the photo. Stash wins every row it has; IAFD
 * fills blanks and adds four more, marked as IAFD's. Only rows with a value.
 */
export function vitals(performer, iafd) {
  const p = performer;
  const i = iafd || {};

  const height = (cm) => (cm ? `${cm} cm` : null);
  const weight = (kg) => (kg ? `${kg} kg` : null);

  const born = p.birthdate || i.birthdate;
  const age = p.birthdate ? p.age : null;

  /* Career: a closed span from IAFD beats Stash's open "2018 -". */
  const closed = (span) => /\d{4}\s*$/.test(span || '');
  const theirCareer = i.careerStart
    ? (i.careerEnd ? `${i.careerStart}–${i.careerEnd}` : `${i.careerStart} –`)
    : null;

  let career = either(p.careerLength, theirCareer);
  if (p.careerLength && !closed(p.careerLength) && i.careerEnd) career = [theirCareer, true];

  /* IAFD-only fields, once saved, are read from Stash's custom fields. */
  const kept = p.custom || {};

  const rows = [
    ['Born', either(born && (age !== null ? `${born} (${age})` : born), null)],
    ['Birthplace', either(kept.Birthplace, i.birthplace)],
    ['Died', either(p.deathDate, null)],
    ['Star sign', either(kept['Star sign'], i.astrology)],
    ['Country', either(p.country, null)],
    ['Ethnicity', either(p.ethnicity, i.ethnicity)],
    ['Hair', either(p.hairColor, i.hairColor)],
    ['Eyes', either(p.eyeColor, i.eyeColor)],
    ['Height', either(height(p.heightCm), height(i.heightCm))],
    ['Weight', either(weight(p.weightKg), weight(i.weightKg))],
    ['Measurements', either(p.measurements, i.measurements)],
    ['Breasts', either(p.fakeTits, null)],
    ['Shoe size', either(kept['Shoe size'], i.shoeSize)],
    ['Career', career],
    ['Tattoos', either(p.tattoos, i.tattoos)],
    ['Piercings', either(p.piercings, i.piercings)],
    ['Also known as', either(
      p.aliases.length ? p.aliases.join(', ') : null,
      i.aka && i.aka.length ? i.aka.join(', ') : null)],
  ].filter(([, cell]) => cell);

  if (!rows.length) return null;

  return factGrid(rows, 'iafd');
}

/*
 * The grid, shared by both pages. Each dt/dd pair is wrapped so columns
 * don't split them.
 */
function factGrid(rows, source) {
  if (!rows.length) return null;

  return el('dl', { className: 'vitals' },
    rows.map(([label, [value, borrowed]]) => el('div', {},
      el('dt', {}, label),
      el('dd', {}, String(value),
        borrowed
          ? el('span', { className: 'src', title: `From ${source.toUpperCase()}, not your library` }, source)
          : null))));
}

/* Stash's value, or the other source's marked, or no row. */
const either = (mine, theirs) => (mine ? [mine, false] : theirs ? [theirs, true] : null);

/*
 * The grid and the save button, redrawn together from what Stash returns
 * after a write.
 */
function draw(box, id, stash, iafd, fill) {
  const grid = vitals(stash, iafd);
  box.replaceChildren(...[grid, fill.length ? saveButton(box, id, iafd, fill) : null].filter(Boolean));
}

/* Gaps only: the button lists what it will add. */
function saveButton(box, id, iafd, fill) {
  const button = el('button', { className: 'keep', type: 'button' },
    `Add ${fill.length === 1 ? 'this' : `these ${fill.length}`} to Stash`);
  button.title = fill.map((f) => `${f.label}: ${f.text}`).join('\n');

  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      const { performer, written } = await api(`/api/library/performers/${id}/iafd`, { method: 'POST' });
      // Nothing left to mark and nothing left to offer, so the grid is redrawn
      // against the record Stash just wrote and the button goes with it.
      draw(box, id, performer, iafd, []);
      box.append(el('p', { className: 'kept' },
        `${written.length} added to Stash: ${written.map((w) => w.label.toLowerCase()).join(', ')}.`));
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Add to Stash';
      box.append(el('p', { className: 'kept bad' }, err.message));
    }
  };

  return button;
}

/* Same for studios. */
export function keepButton(id, state, fill, redraw) {
  const button = el('button', { className: 'keep', type: 'button' },
    `Add ${fill.length === 1 ? 'this' : `these ${fill.length}`} to Stash`);
  button.title = fill.map((f) => `${f.label}: ${f.text}`).join('\n');

  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      const { written, studio } = await api(`/api/library/studios/${id}/facts`, { method: 'POST' });
      state.data = { ...state.data, studio: { ...state.data.studio, ...studio } };
      redraw(el('p', { className: 'kept' },
        `${written.length} added to Stash: ${written.map((w) => w.label.toLowerCase()).join(', ')}.`));
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Add to Stash';
      button.after(el('p', { className: 'kept bad' }, err.message));
    }
  };

  return button;
}

/*
 * Studio facts: Stash first (a parent studio is the network), the TPDB
 * mirror for the rest. See studiofacts.mjs.
 */
export function studioFacts(studio, site) {
  const s = site || {};
  const kept = studio.custom || {};

  // Three ways of knowing the network, in the order they are worth having.
  /* StashDB isn't consulted: marked rows must be ones the button can write. */
  const network = studio.parent?.name || kept.Network || null;

  const rows = [
    ['Network', either(network, s.network)],
    ['Website', either(studio.homepage, s.homepage)],
    ['Typical scene', either(kept['Typical scene'], s.runtime ? `${s.runtime} min` : null)],
    ['Status', either(kept.Status, s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : null)],
    ['Also known as', either((studio.aliases || []).join(', ') || null, null)],
  ].filter(([, cell]) => cell);

  return factGrid(rows, 'tpdb');
}
