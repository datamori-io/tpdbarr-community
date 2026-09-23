/*
 * The facts grid a performer and a studio share, and the gaps-only button under
 * it. Drawn identically on both pages on purpose: a studio's facts laid out
 * differently to a performer's would read as two features rather than one.
 */

import { api, el } from '../util.js';
import { grid } from './tiles.js';

/*
 * Their vitals, beside the photograph.
 *
 * Stash holds a dozen small facts about a performer and until now the page
 * showed three of them. They belong at the top next to the picture — that is
 * the moment you are looking at a face and asking who this is — so the header
 * carries the lot as a label/value grid and the shelf starts below it.
 *
 * Two sources, and they are not equals. Stash is the library of record and
 * wins every row it has an answer for; IAFD fills the blanks and adds the four
 * things Stash has no field for at all. Anything that came from IAFD says so,
 * because a fact you did not put in your own library should be readable as
 * somebody else's.
 *
 * Only what one of them actually has is drawn. A performer scraped off a
 * single site has a birthdate and nothing else, and a grid of empty dashes
 * would read as a broken page rather than a thin record.
 */
export function vitals(performer, iafd) {
  const p = performer;
  const i = iafd || {};

  const height = (cm) => (cm ? `${cm} cm` : null);
  const weight = (kg) => (kg ? `${kg} kg` : null);

  const born = p.birthdate || i.birthdate;
  const age = p.birthdate ? p.age : null;

  /*
   * Career is the one row where IAFD can beat a value Stash already has.
   * Stash writes an open span — "2018 -" — for everybody, working or not, so
   * a closed one from IAFD is new information rather than a second opinion.
   */
  const closed = (span) => /\d{4}\s*$/.test(span || '');
  const theirCareer = i.careerStart
    ? (i.careerEnd ? `${i.careerStart}–${i.careerEnd}` : `${i.careerStart} –`)
    : null;

  let career = either(p.careerLength, theirCareer);
  if (p.careerLength && !closed(p.careerLength) && i.careerEnd) career = [theirCareer, true];

  /*
   * The three IAFD has that Stash has no column for. They land in Stash's
   * custom fields when the button is pressed, so once saved they are read from
   * there and stop being somebody else's fact.
   */
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
 * The grid itself, shared by the performer page and the studio one. Two pages,
 * two sources, one way of showing a fact and of marking a borrowed one — a
 * studio's facts drawn a little differently to a performer's would read as two
 * features rather than one.
 *
 * Each pair is wrapped, because the columns wrap: a bare grid of dt and dd
 * would flow the label into one column and its value into the next.
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

/*
 * Stash's value, or the other source's marked as theirs, or no row at all.
 * Both pages hold the same rule: everything marked is something the button
 * will write, and nothing else is marked.
 */
const either = (mine, theirs) => (mine ? [mine, false] : theirs ? [theirs, true] : null);

/*
 * The grid, and under it the offer to keep what IAFD lent you.
 *
 * Redrawn in one place rather than two, because pressing the button changes
 * both halves: the rows it wrote stop being marked, and the button itself has
 * nothing left to offer. `stash` is the performer as Stash now has them, so
 * after a write the page is showing the library rather than a promise about
 * it — which is the whole reason the write hands the record back.
 */
function draw(box, id, stash, iafd, fill) {
  const grid = vitals(stash, iafd);
  box.replaceChildren(...[grid, fill.length ? saveButton(box, id, iafd, fill) : null].filter(Boolean));
}

/*
 * Gaps only, so there is nothing to tick through and nothing to undo: the
 * button says what it will add and adding it is the whole of the decision.
 * Its title lists them, for the moment before you press it.
 */
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

/*
 * Gaps only, so the button is the whole decision — the same offer the
 * performer page makes, and the same shape of answer. What comes back is what
 * Stash now holds, so the grid is redrawn against the library rather than
 * against a promise that the write went in.
 */
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
 * A studio's facts, the same shape as a performer's.
 *
 * Stash keeps very little about a studio — this library has 386 of them and
 * not one carries a description — so most of what is worth saying comes from
 * ThePornDB's mirror and says so. What Stash does hold wins, as everywhere:
 * a parent studio is the network already, properly, as a thing you can click
 * rather than a word. See studiofacts.mjs.
 */
export function studioFacts(studio, site) {
  const s = site || {};
  const kept = studio.custom || {};

  // Three ways of knowing the network, in the order they are worth having.
  /*
   * StashDB knows the network too and is deliberately not consulted here. It
   * would draw an unmarked row for a fact that is not in your library and that
   * the button would then still offer to write — and the one rule this grid
   * keeps is that marked and writable are the same set.
   */
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
