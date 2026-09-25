/*
 * Monitored: what either Whisparr still wants, to search by hand. Each row
 * opens the Indexers band with a query ready (squashed studio + lead
 * performer; date queries find nothing). Grabs go to NZBGet's Manual
 * category and the Import Folder, not Whisparr. The server drops scenes
 * Stash already holds (listed at the foot) and marks downloading and
 * already-grabbed ones.
 */

import { api, el } from '../util.js';
import { indexerBand, kindSwitch } from './cards.js';
import { SECTION_OF, painterFor, recall, remember, show } from './core.js';

let run = 0;

export async function showMonitored(qs) {
  const params = new URLSearchParams(qs || '');
  const from = params.get('from') || recall('monitored.from', 'v3');
  const paint = painterFor();
  const mine = ++run;

  const body = el('div', {}, el('div', { className: 'empty' }, 'Asking Whisparr…'));
  show(paint, SECTION_OF.search, kindSwitch(params, 'monitored'), fromSwitch(params, from), body);

  try {
    const { rows, held = [], stashChecked } = await api('/api/acquire/monitored?from=' + from + (params.get('refresh') ? '&refresh=1' : ''));
    if (mine !== run) return;
    body.replaceChildren(...[
      !stashChecked && el('div', { className: 'empty small' },
        'Stash could not be asked — this is Whisparr’s list unchecked, and some of it may already be on the shelf.'),
      listOf(rows, from, params.get('f') || ''),
      heldList(held),
    ].filter(Boolean));
  } catch (err) {
    if (mine !== run) return;
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

function fromSwitch(params, from) {
  const button = (key, label) => {
    const node = el('button', { type: 'button', className: 'chip' + (key === from ? ' on' : '') }, label);
    node.onclick = () => {
      if (key === from) return;
      remember('monitored.from', key);
      const next = new URLSearchParams(params);
      next.set('from', key);
      next.delete('refresh');
      location.hash = '#/import/video?' + next.toString();
    };
    return node;
  };

  const refresh = el('button', { type: 'button', className: 'chip' }, 'Refresh');
  refresh.onclick = () => {
    const next = new URLSearchParams(params);
    next.set('from', from);
    next.set('refresh', String(Date.now()));
    location.hash = '#/import/video?' + next.toString();
  };

  return el('div', { className: 'toolbar' },
    el('div', { className: 'viewswitch' }, button('v3', 'Whisparr v3 · scenes'), button('v2', 'Whisparr v2 · movies')),
    refresh);
}

/* Filtered as you type, not paged. */
function listOf(rows, from, initial) {
  if (!rows.length) {
    return el('div', { className: 'empty' }, `Nothing Whisparr ${from} is looking for is missing from Stash.`);
  }

  const filter = el('input', {
    type: 'search',
    className: 'monitoredfilter',
    placeholder: 'Filter by studio, performer or title…',
    value: initial,
    autocomplete: 'off',
    spellcheck: false,
  });
  const count = el('span', { className: 'muted' });
  const list = el('div', { className: 'monitored' });

  const hay = rows.map((r) => [r.studio, r.title, ...r.performers].join(' ').toLowerCase());
  const nodes = rows.map((r) => row(r, from));

  const apply = () => {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    nodes.forEach((node, i) => {
      const hit = words.every((w) => hay[i].includes(w));
      node.hidden = !hit;
      if (hit) shown += 1;
    });
    count.textContent = words.length ? `${shown} of ${rows.length}` : `${rows.length} monitored, no file`;
  };

  filter.oninput = apply;
  list.append(...nodes);
  apply();

  return el('div', {},
    el('div', { className: 'toolbar' }, filter, count),
    list);
}

const since = (iso) => {
  if (!iso) return 'never searched';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? 'searched today' : `searched ${days}d ago`;
};

function row(r, from) {
  const open = el('button', { type: 'button', className: 'chip' }, 'Search indexers');
  const slot = el('div', {});
  let band = null;

  open.onclick = () => {
    if (band) {
      band.remove();
      band = null;
      open.textContent = 'Search indexers';
      return;
    }
    band = indexerBand(r.query, { heading: false, auto: true, forRow: { from, id: r.id } });
    slot.append(band);
    open.textContent = 'Close';
  };

  const title = r.stashId
    ? el('a', { href: `https://stashdb.org/scenes/${r.stashId}`, target: '_blank', rel: 'noopener noreferrer' }, r.title)
    : r.title;

  return el('div', { className: 'mrow' },
    el('div', { className: 'mhead' },
      el('div', { className: 'mtitle' }, title),
      r.downloading && el('span', { className: 'badge monitored', title: 'In Whisparr’s download queue now' }, 'Downloading'),
      r.grabbed && el('span', {
        className: 'badge stash-probable',
        title: `Grabbed by hand ${r.grabbed.at.slice(0, 16).replace('T', ' ')}${r.grabbed.to ? ' → ' + r.grabbed.to : ''}` +
          (r.grabbed.title ? `\n${r.grabbed.title}` : '') + '\nStash will not know it until it is built from the Import Folder.',
      }, 'Grabbed ' + since(r.grabbed.at).replace('searched ', '')),
      open),
    el('div', { className: 'mmeta muted' },
      [r.studio, r.date, r.performers.slice(0, 4).join(', '), since(r.lastSearch)]
        .filter(Boolean).map((t) => el('span', {}, t))),
    slot);
}

/*
 * Monitored but already in Stash, for checking. Exact = StashDB id,
 * probable = title + date. These want unmonitoring (Stats), not searching.
 */
function heldList(held) {
  if (!held.length) return null;
  const rows = held.map((r) => el('div', { className: 'mrow' },
    el('div', { className: 'mhead' },
      el('div', { className: 'mtitle' },
        el('a', { href: `#/library/scene/${r.stash.id}` }, r.title)),
      el('span', {
        className: 'badge ' + (r.stash.match === 'exact' ? 'stash-exact' : 'stash-probable'),
        title: r.stash.path || '',
      }, r.stash.match === 'exact' ? 'In Stash' : 'Probably in Stash')),
    el('div', { className: 'mmeta muted' },
      [r.studio, r.date, r.performers.slice(0, 4).join(', ')].filter(Boolean).map((t) => el('span', {}, t)))));

  return el('details', { className: 'monitoredheld' },
    el('summary', { className: 'muted' },
      `${held.length} more Whisparr still monitors, already in Stash — left out above; unmonitor them from `,
      el('a', { href: '#/stats' }, 'Stats')),
    el('div', { className: 'monitored' }, rows));
}
