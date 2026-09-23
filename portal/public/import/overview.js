/* The front page of Import: how far behind you are, and what is worth a look. */

import { api, el } from '../util.js';
import { stashdbCard } from '../catalogue.js';
import { SECTION_OF, paint, painterFor, renderSetup, show, state } from './core.js';

/* ================================================================ overview
 *
 * The first page of Import, answering two questions rather than one: what am I
 * already collecting, and what is worth a look that I am not.
 *
 * The summary comes first because seven tracked rows do not tell you whether
 * you are behind — one number, "N decisions waiting", does. The suggestions
 * below it are drawn from marks you have already made on StashDB itself, except
 * the trending row, which is the only thing here that is not about him and is
 * last for that reason.
 */

export let overviewTimer = null;

export async function showOverview() {
  const paint = painterFor();
  clearTimeout(overviewTimer);

  if (!state?.stash?.enabled) return renderSetup();

  try {
    const { overview, building } = await api('/api/import/overview');

    if (!overview) {
      show(paint, SECTION_OF.overview, el('div', { className: 'empty' },
        building ? 'Building the overview… this takes a moment the first time.' : 'Nothing to show yet.'));
      overviewTimer = setTimeout(showOverview, 4000);
      return;
    }

    renderOverview(paint, overview, building);
    if (building) overviewTimer = setTimeout(showOverview, 5000);
  } catch (err) {
    show(paint, SECTION_OF.overview, el('div', { className: 'empty' }, err.message));
  }
}

function renderOverview(paint, overview, building) {
  const { summary, suggestions } = overview;

  const refresh = el('button', { className: 'chip', type: 'button' }, building ? 'refreshing…' : 'Refresh');
  refresh.disabled = building;
  refresh.onclick = async () => {
    refresh.disabled = true;
    refresh.textContent = 'refreshing…';
    await api('/api/import/overview?refresh=1');
    showOverview();
  };

  show(paint, SECTION_OF.overview,
    summaryBand(summary, refresh),
    suggestions.map((row) => stashdbBand(row.label, row.why, row.scenes)),
    suggestions.length ? null : el('div', { className: 'empty small' },
      'No suggestions yet — favourite a studio or a performer on StashDB and they turn up here.')
  );
}

/*
 * The tracked catalogues, summed. Decisions is the headline because it is the
 * only number on the page that is a job rather than a fact: it grows on its own
 * as catalogues release things, and going stale is what it actually costs you.
 */
function summaryBand(summary, refresh) {
  const figure = (value, label, href, loud) =>
    el(href ? 'a' : 'div', { className: 'figure' + (loud ? ' loud' : ''), ...(href ? { href } : {}) },
      el('div', { className: 'fignum' }, value),
      el('div', { className: 'figlabel' }, label));

  const behind = summary.behind || [];

  return el('section', { className: 'feed' },
    el('div', { className: 'feedhead' },
      el('h2', {}, 'What you are collecting'),
      el('span', { className: 'muted' },
        summary.measuring
          ? `${summary.measuring} of ${summary.tracking} still measuring…`
          : `${summary.performers} performers and ${summary.studios} studios, counted in Stash`),
      el('span', { className: 'spacer' }),
      refresh
    ),
    el('div', { className: 'figures' },
      figure(summary.pct === null ? '—' : summary.pct + '%', 'of what you want, held', '#/import/tracked'),
      figure(summary.have.toLocaleString(), 'wanted and have'),
      figure(summary.missing.toLocaleString(), 'wanted, still missing', '#/import/tracked'),
      figure(summary.decisions.toLocaleString(), 'still to decide', '#/import/tracked', summary.decisions > 0)
    ),
    behind.length
      ? el('div', { className: 'muted small behindline' },
        'Furthest ahead of you: ',
        behind.flatMap((one, i) => [
          i ? ', ' : '',
          el('a', { className: 'link', href: `#/import/video?${one.kind}=${one.id}&show=undecided` },
            `${one.name} (${one.undecided.toLocaleString()})`),
        ]))
      : null
  );
}

/*
 * A row of StashDB scenes. Not `band()` — that draws a ThePornDB card, whose
 * Add needs a ThePornDB site id these do not have, so every suggestion would
 * come out reading "Do not have" with no way to act on it.
 */
function stashdbBand(title, note, scenes) {
  return el('section', { className: 'feed' },
    el('div', { className: 'feedhead' },
      el('h2', {}, title),
      el('span', { className: 'muted' }, note)
    ),
    scenes.length
      ? el('div', { className: 'cards' }, scenes.map((scene) => stashdbCard(scene)))
      : el('div', { className: 'empty small' }, 'Nothing here you have not already seen.')
  );
}
