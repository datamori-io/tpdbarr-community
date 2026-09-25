/*
 * The standing-rules editor, on the Tracked page. Rules hide rather than
 * skip: deleting one brings its scenes back. The list is saved whole.
 */

import { api, el } from '../util.js';

const KINDS = [
  ['shorter', 'Shorter than', 'minutes', 'number'],
  ['before', 'Released before', 'year', 'number'],
  ['after', 'Released after', 'year', 'number'],
  ['tag', 'Tagged', 'a word in the tag — “BDSM” catches “BDSM Hardcore”', 'text'],
  ['title', 'Title contains', 'a word or a phrase', 'text'],
  ['studio', 'From studio', 'a word in the name — “VR” catches “CockVR”', 'text'],
];

/* Where a rule applies: everywhere (default), or one catalogue. */
const SCOPES = [
  ['', 'Everywhere'],
  ['performer', 'For performer'],
  ['studio', 'For studio'],
  ['tag', 'For tag'],
];

/* Pick the catalogue via StashDB's type-ahead; the name is kept with the id. */
function scopePicker(rule, onPick) {
  const kind = el('select', { className: 'control' },
    SCOPES.map(([value, label]) => el('option', { value, selected: value === (rule.on?.kind || '') }, label)));

  const box = el('input', {
    type: 'text',
    className: 'facetinput rulewho',
    placeholder: 'start typing a name…',
    value: rule.on?.name || '',
    autocomplete: 'off',
  });
  box.hidden = !rule.on?.kind;

  const menu = el('div', { className: 'facetmenu' });
  const wrap = el('div', { className: 'facetfield rulescope' }, kind, box, menu);

  const close = () => { menu.replaceChildren(); wrap.classList.remove('open'); };

  kind.onchange = () => {
    box.hidden = !kind.value;
    box.value = '';
    close();
    // Cleared rather than kept: a rule that says "for studio" and names a
    // performer is a rule nobody can read.
    onPick(null, kind.value);
  };

  let timer = null;
  let run = 0;

  box.oninput = () => {
    clearTimeout(timer);
    const term = box.value.trim();
    if (term.length < 2) return close();

    timer = setTimeout(async () => {
      const mine = ++run;
      try {
        const { results } = await api(`/api/acquire/lookup?kind=${kind.value}&q=` + encodeURIComponent(term));
        if (mine !== run) return;
        menu.replaceChildren(...results.slice(0, 8).map((hit) => {
          const row = el('button', { type: 'button', className: 'facetrow' },
            el('span', { className: 'facename' }, hit.name),
            hit.detail ? el('span', { className: 'muted small' }, hit.detail) : null);
          row.onclick = () => {
            box.value = hit.name;
            close();
            onPick({ kind: kind.value, id: hit.id, name: hit.name }, kind.value);
          };
          return row;
        }));
        wrap.classList.add('open');
      } catch {
        close();
      }
    }, 250);
  };

  box.onblur = () => setTimeout(close, 150);

  return wrap;
}

export function rulesPanel(onSaved) {
  const rows = el('div', { className: 'rulelist' });
  const said = el('span', { className: 'muted small' }, '');

  let held = [];

  const save = async () => {
    /* Half-written rules aren't sent, so the row stays while you type. */
    const ready = held.filter((rule) => String(rule.value ?? '').trim() !== '' && !rule.pointing);

    said.textContent = 'Saving…';
    try {
      const back = await api('/api/acquire/rules', {
        method: 'POST',
        body: JSON.stringify({ rules: ready.map(sendable) }),
      });
      said.textContent = back.rules.length
        ? `${back.rules.length} rule${back.rules.length === 1 ? '' : 's'} — the counts above have been worked out again.`
        : 'No rules — everything reaches the queue.';
      onSaved?.();
    } catch (err) {
      said.textContent = err.message;
    }
  };

  const draw = () => {
    rows.replaceChildren(...held.map((rule, at) => row(rule, at)));
    if (!held.length) {
      rows.append(el('div', { className: 'muted small' },
        'No rules yet. Add one and every scene it catches drops out of the queue and out of the counts above.'));
    }
  };

  const row = (rule, at) => {
    const kind = el('select', { className: 'control' },
      KINDS.map(([value, label]) => el('option', { value, selected: value === rule.kind }, label)));

    const scope = scopePicker(rule, (on, wants) => {
      held[at] = { ...held[at], on: on || undefined };
      // A scope chosen but not yet named holds the rule back from saving
      // rather than saving it as the blanket rule it is not.
      held[at].pointing = Boolean(wants) && !on;
      if (!held[at].pointing) save();
    });

    const spec = KINDS.find(([value]) => value === rule.kind) || KINDS[0];
    const value = el('input', {
      type: spec[3],
      className: 'facetinput ruleval',
      value: String(rule.value ?? ''),
      placeholder: spec[2],
      autocomplete: 'off',
    });

    kind.onchange = () => {
      // Changing the kind clears the value; scope is kept.
      held[at] = { ...held[at], kind: kind.value, value: '' };
      draw();
    };

    value.onchange = () => {
      held[at] = { ...held[at], kind: kind.value, value: value.value.trim() };
      save();
    };
    value.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); value.blur(); } };

    const drop = el('button', { type: 'button', className: 'chip quiet' }, 'Remove');
    drop.onclick = () => { held.splice(at, 1); draw(); save(); };

    return el('div', { className: 'rulerow' }, kind, value, scope, drop);
  };

  const add = el('button', { type: 'button', className: 'chip' }, 'Add a rule');
  add.onclick = () => { held.push({ kind: 'shorter', value: '' }); draw(); };

  // `pointing` is the editor's own bookkeeping and means nothing to the
  // server, so it never travels.
  const sendable = (rule) => ({ kind: rule.kind, value: rule.value, on: rule.on });

  api('/api/acquire/rules')
    .then((back) => { held = back.rules || []; draw(); })
    .catch((err) => { said.textContent = err.message; });

  draw();

  return el('section', { className: 'feed rulesbox' },
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Standing answers'),
      el('span', { className: 'muted' },
        'the noes you would give anyway — given once')),
    rows,
    el('div', { className: 'controls' }, add, said),
    el('div', { className: 'muted small' },
      'A rule hides, it never skips. Nothing is written against a scene, so removing a rule '
      + 'puts everything it was holding back straight back into the queue.')
  );
}
