/* Scenes Stash never identified, and the candidates for them. */

import { api, el, folderLine, gigabytes } from '../util.js';
import { SECTION_OF, painterFor, show, state } from '../import/core.js';
import { compareSheet } from './compare.js';
import { generateBit, liveArt } from './liveart.js';

/*
 * ============================================================ match & sort
 *
 * The piles of library work:
 *
 *   No stash id   — no usable stash-box id
 *   No cover      — invisible on every shelf; the match brings a picture
 *   Not organised — not marked finished
 *
 * A find asks every stash-box and scraper at once, one band each. Tick what's
 * right (usually StashDB and TPDB) and one press files both. Every write is
 * on a press.
 */

const MATCH_MODES = [
  ['unmatched', 'No stash id'],
  ['nocover', 'No cover'],
  ['unorganized', 'Not organised'],
];

// Stash sorts. `path` sorts by folder, then filename.
/* Must match SORT_DEFAULT in matchsort.mjs: the address omits the default. */
const SORT_DEFAULT = 'added';

const SORTS = [
  ['date', 'Scene date'],
  ['added', 'Date added'],
  ['updated', 'Last changed'],
  ['title', 'Title'],
  ['path', 'Folder, then filename'],
  ['size', 'File size'],
  ['duration', 'Runtime'],
  ['random', 'Shuffled'],
];

// The fields a match can bring across. The ids are not on this list because the
// ids are not optional — they are the whole point of matching.
const MATCH_FIELDS = [
  ['title', 'Title'],
  ['date', 'Date'],
  ['cover', 'Cover'],
  ['studio', 'Studio'],
  ['performers', 'Performers'],
  ['tags', 'Tags'],
  ['details', 'Description'],
  ['organized', 'Mark organised'],
];

const DEFAULT_FIELDS = ['title', 'date', 'cover', 'studio', 'performers', 'tags'];

const matchHash = (params) => {
  const qs = params.toString();
  return '#/catalogue/match' + (qs ? '?' + qs : '');
};

/* The pile's filters, shared by the queue and the phash bar so both mean the same scenes. */
const pileParams = (params) => new URLSearchParams({
  mode: params.get('mode') || 'unmatched',
  q: params.get('q') || '',
  endpoint: params.get('ep') || '',
  have: params.get('epq') === 'has' ? '1' : '',
  site: params.get('site') || '',
  hassite: params.get('siteq') === 'has' ? '1' : '',
  aside: params.get('aside') === '1' ? '1' : '',
  thin: params.get('thin') === '1' ? '1' : '',
  described: params.get('described') === '1' ? '1' : '',
});

function goMatch(params) {
  const hash = matchHash(params);
  if (location.hash === hash) showMatch(params.toString());
  else location.hash = hash;
}

/* Sources are asked of Stash once per page. */
let sourceCache = null;

async function knownSources() {
  if (!sourceCache) sourceCache = api('/api/import/match/sources').catch(() => ({ sources: [] }));
  const { sources } = await sourceCache;
  return sources || [];
}

// What a find will ask when nothing has been ticked: every box, no scrapers.
// Scrapers are slower and noisier, so they are opt-in rather than default.
const defaultSources = (sources) => sources.filter((s) => s.kind !== 'scraper').map((s) => s.key);

const chosenSources = (params, sources) => {
  const named = (params.get('src') || '').split(',').filter(Boolean);
  const known = new Set(sources.map((s) => s.key));
  const kept = named.filter((k) => known.has(k));
  return kept.length ? kept : defaultSources(sources);
};

/*
 * Which fields a filing writes, for the whole page (in the address).
 * `all` means every field.
 */
const chosenFields = (params) => {
  const known = new Set(MATCH_FIELDS.map(([key]) => key));
  const named = (params.get('fields') || '').split(',').filter(Boolean);

  if (named.length === 1 && named[0] === 'all') return MATCH_FIELDS.map(([key]) => key);
  // Read back in MATCH_FIELDS order too, so a hand-edited address cannot make
  // the chip line disagree with itself about whether this is the default set.
  const kept = MATCH_FIELDS.map(([key]) => key).filter((k) => named.includes(k) && known.has(k));
  /* `none` survives a reload as "no fields" rather than the defaults. */
  if (named.length === 1 && named[0] === 'none') return [];
  return kept.length ? kept : [...DEFAULT_FIELDS];
};

/* Hosts the library links to, asked once per visit. */
let siteMemo = null;

const knownSites = async () => {
  if (!siteMemo) siteMemo = api('/api/import/match/sites').then((r) => r.sites || []).catch(() => []);
  return siteMemo;
};

export async function showMatch(qs) {
  const paint = painterFor();
  const params = new URLSearchParams(qs || '');
  const mode = MATCH_MODES.some(([m]) => m === params.get('mode')) ? params.get('mode') : 'unmatched';

  const body = el('div', {});
  const panel = el('div', {});
  show(paint, SECTION_OF.match, panel, body);

  if (!state?.stash?.enabled) {
    panel.replaceChildren();
    body.replaceChildren(el('div', { className: 'empty' }, 'This works on your Stash library. Connect it in Settings.'));
    return;
  }

  body.replaceChildren(el('div', { className: 'empty' }, 'Reading the library…'));

  const [sources, sites] = await Promise.all([knownSources(), knownSites()]);

  /*
   * Mutated, never replaced: rows read it when you press Find, so changing
   * sources doesn't rebuild them.
   */
  const picked = chosenSources(params, sources);

  /* Mutated, never replaced, for the same reason as `picked`. */
  const fields = chosenFields(params);

  // Whoever wants telling when the list changes. The bulk bar quotes the count
  // in its own line and would otherwise go on quoting the old one.
  const listeners = [];
  const onSources = (now) => { for (const fn of listeners) fn(now); };

  /*
   * Rows with a rename preview open, re-planned when fields change. Detached
   * ones are dropped as found.
   */
  const watchers = [];
  const onFields = () => {
    for (let i = watchers.length - 1; i >= 0; i--) {
      if (watchers[i].node.isConnected) watchers[i].run();
      else watchers.splice(i, 1);
    }
  };

  panel.replaceChildren(matchPanel(params, mode, sources, picked, sites, onSources, fields, onFields));

  try {
    const queue = await api('/api/import/match?' + new URLSearchParams({
      mode,
      page: params.get('page') || '1',
      sort: params.get('sort') || SORT_DEFAULT,
      dir: params.get('dir') || 'desc',
      q: params.get('q') || '',
      // Which box's id, and whether the pile is the scenes that have one or
      // the scenes that do not. Empty means the question is not being asked.
      endpoint: params.get('ep') || '',
      have: params.get('epq') === 'has' ? '1' : '',
      // The scraper half: a scraper leaves a link rather than an id.
      site: params.get('site') || '',
      hassite: params.get('siteq') === 'has' ? '1' : '',
      // The ones you gave up on, and the ones already described. Both hide by
      // default: a pile you cannot empty is a pile you stop reading.
      aside: params.get('aside') === '1' ? '1' : '',
      thin: params.get('thin') === '1' ? '1' : '',
      described: params.get('described') === '1' ? '1' : '',
    }));
    /* The box being asked about, only on its "missing" side. */
    const scoped = params.get('epq') === 'has'
      ? null
      : (sources.find((src) => src.kind === 'box' && src.endpoint === params.get('ep')) || null);

    renderMatchQueue(body, params, queue, picked, listeners, fields, watchers, scoped);
  } catch (err) {
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

/* Pile, order, keyword and sources all go through the address, so a queue can be linked. */
function matchPanel(params, mode, sources, picked, sites = [], onSources = null, fields = [], onFields = null) {
  // A change of pile, order or keyword starts at page one; staying on page 9 of
  // a list that just became a different list is never what was meant.
  const move = (fn) => {
    const next = new URLSearchParams(params);
    fn(next);
    next.delete('page');
    goMatch(next);
  };

  const set = (key, value, fallback) => move((next) => {
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
  });

  const nowEp = params.get('ep') || '';
  const nowSide = params.get('epq') === 'has' ? 'has' : 'missing';

  const pile = (key, label) => {
    // A plain pile only lights when no box is named.
    const on = key === mode && !nowEp;
    const chip = el('button', { type: 'button', className: 'chip' + (on ? ' on' : '') }, label);
    chip.onclick = () => move((next) => {
      next.delete('ep');
      next.delete('epq');
      if (key === 'unmatched') next.delete('mode');
      else next.set('mode', key);
    });
    return chip;
  };

  /*
   * Per-box piles ("No TPDB id"), asked of the whole library. Shortcuts for
   * what the dropdown below can also say.
   */
  const boxPile = (label, match) => {
    const box = sources.find((src) => src.kind === 'box' && src.endpoint && match(src.endpoint));
    if (!box) return null;

    const on = mode === 'unmatched' && nowEp === box.endpoint && nowSide === 'missing';
    const chip = el('button', { type: 'button', className: 'chip' + (on ? ' on' : '') }, label);
    chip.title = `Every scene in the library with no ${box.label} id, whatever else it has`;

    chip.onclick = () => move((next) => {
      next.delete('mode');
      next.delete('epq');
      if (on) next.delete('ep');
      else next.set('ep', box.endpoint);
    });
    return chip;
  };

  const sort = el('select', { className: 'facetinput' },
    SORTS.map(([key, label]) => el('option', { value: key, selected: key === (params.get('sort') || SORT_DEFAULT) }, label)));
  sort.onchange = () => set('sort', sort.value, SORT_DEFAULT);

  const descending = (params.get('dir') || 'desc') !== 'asc';
  const flip = el('button', { type: 'button', className: 'chip' }, descending ? 'Newest first' : 'Oldest first');
  flip.onclick = () => set('dir', descending ? 'asc' : 'desc', 'desc');

  /*
   * Described: missing any of title/studio/date, or all present. A
   * three-way, since both can't be on. "Fully described" makes the
   * unorganised pile bulk-clearable.
   */
  const nowDesc = params.get('described') === '1' ? 'described' : params.get('thin') === '1' ? 'thin' : '';

  const desc = el('select', { className: 'facetinput' },
    el('option', { value: '', selected: !nowDesc }, 'Any description'),
    el('option', { value: 'thin', selected: nowDesc === 'thin' }, 'Missing title, studio or date'),
    el('option', { value: 'described', selected: nowDesc === 'described' }, 'Has title, studio and date'));

  desc.onchange = () => move((next) => {
    next.delete('thin');
    next.delete('described');
    if (desc.value === 'thin') next.set('thin', '1');
    else if (desc.value === 'described') next.set('described', '1');
  });

  /* The keyword searches the path. */
  const words = el('input', {
    type: 'search',
    className: 'facetinput',
    placeholder: 'A word in the path or filename…',
    value: params.get('q') || '',
    autocomplete: 'off',
  });
  words.onchange = () => set('q', words.value.trim(), '');
  words.onkeydown = (e) => { if (e.key === 'Enter') set('q', words.value.trim(), ''); };

  /* Which box's id, and which side. Stash-boxes only (scrapers file no id). */
  const withEndpoints = sources.filter((s) => s.kind === 'box' && s.endpoint);
  const nowEndpoint = nowEp;

  const endpointPick = withEndpoints.length
    ? el('select', { className: 'facetinput' },
      el('option', { value: '', selected: !nowEndpoint }, 'Any box'),
      withEndpoints.map((s) => el('option', { value: s.endpoint, selected: s.endpoint === nowEndpoint }, s.label)))
    : null;

  if (endpointPick) endpointPick.onchange = () => set('ep', endpointPick.value, '');

  const sidePick = el('select', { className: 'facetinput' },
    el('option', { value: 'missing', selected: nowSide === 'missing' }, 'missing its id'),
    el('option', { value: 'has', selected: nowSide === 'has' }, 'has its id'));

  // Nothing to be on either side of until a box is named, and a live control
  // that changes nothing is worse than one that says it is not in play.
  sidePick.disabled = !nowEndpoint;
  sidePick.onchange = () => set('epq', sidePick.value, 'missing');

  /* The same for scrapers, by the host of the URLs they left. */
  const nowSite = params.get('site') || '';
  const nowSiteSide = params.get('siteq') === 'has' ? 'has' : 'missing';

  const sitePick = sites.length
    ? el('select', { className: 'facetinput' },
      el('option', { value: '', selected: !nowSite }, 'Any site'),
      el('option', { value: 'none', selected: nowSite === 'none' }, 'No link at all'),
      sites.map((s) => el('option', { value: s.value, selected: s.value === nowSite },
        `${s.value} (${s.count.toLocaleString()})`)))
    : null;

  if (sitePick) sitePick.onchange = () => set('site', sitePick.value, '');

  const siteSide = el('select', { className: 'facetinput' },
    el('option', { value: 'missing', selected: nowSiteSide === 'missing' }, 'no link to it'),
    el('option', { value: 'has', selected: nowSiteSide === 'has' }, 'linked to it'));

  /* "No link at all" has no other side. */
  siteSide.disabled = !nowSite || nowSite === 'none';
  siteSide.onchange = () => set('siteq', siteSide.value, 'missing');

  /*
   * Source chips rewrite the address in place without re-reading the pile
   * (which would jump back to page one). `picked` is mutated so rows see it.
   */
  const sourceLine = el('div', { className: 'controls sourceline' });

  const boxes = sources.filter((s) => s.kind !== 'scraper');
  const scrapers = sources.filter((s) => s.kind === 'scraper');

  const setSources = (now) => {
    picked.length = 0;
    picked.push(...now);

    const next = new URLSearchParams(params);
    if (!now.length || now.join(',') === defaultSources(sources).join(',')) next.delete('src');
    else next.set('src', now.join(','));

    /* replaceState, not a navigation. */
    params = next;
    history.replaceState(null, '', matchHash(next));

    drawSources();
    onSources?.(picked);
  };

  const toggle = (key) => setSources(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]);

  /*
   * ------------------------------------------------------------ what to write
   *
   * Fields a filing keeps, for the whole page. Ids are always written.
   */
  const fieldLine = el('div', { className: 'controls fieldline' });

  const setFields = (list) => {
    /* Keep MATCH_FIELDS order so the default set compares equal. */
    const every = MATCH_FIELDS.map(([key]) => key);
    const now = every.filter((key) => list.includes(key));

    fields.length = 0;
    fields.push(...now);

    const next = new URLSearchParams(params);
    if (!now.length) next.set('fields', 'none');
    else if (now.length === every.length) next.set('fields', 'all');
    else if (now.join(',') === every.filter((k) => DEFAULT_FIELDS.includes(k)).join(',')) next.delete('fields');
    else next.set('fields', now.join(','));

    // replaceState, like the sources: the address stays honest and the page you
    // are on stays the page you are on.
    params = next;
    history.replaceState(null, '', matchHash(next));

    drawFields();
    onFields?.(fields);
  };

  function drawFields() {
    const chipFor = ([key, label]) => {
      const on = fields.includes(key);
      const chip = el('button', { type: 'button', className: 'chip' + (on ? ' on' : '') }, label);
      chip.onclick = () => setFields(on ? fields.filter((k) => k !== key) : [...fields, key]);
      return chip;
    };

    const all = el('button', { className: 'chip', type: 'button' },
      fields.length === MATCH_FIELDS.length ? 'None' : 'All');
    all.onclick = () => setFields(
      fields.length === MATCH_FIELDS.length ? [] : MATCH_FIELDS.map(([key]) => key)
    );

    fieldLine.replaceChildren(
      el('span', { className: 'muted small' }, 'Write'),
      ...MATCH_FIELDS.map(chipFor),
      all,
      el('span', { className: 'muted small' },
        fields.length ? `${fields.length} of ${MATCH_FIELDS.length}` : 'ids only')
    );
  }

  drawFields();

  /* Boxes are chips; scrapers are added from a picker, then shown as chips. */
  const chipFor = (source) => {
    const on = picked.includes(source.key);
    const chip = el('button', { type: 'button', className: 'chip' + (on ? ' on' : '') }, source.label);
    // A scraper that can only be asked a keyword says so, because what it
    // answers is a guess and the row will label it one.
    if (source.kind === 'scraper' && source.name && !source.fragment) chip.title = 'Searches by name — cannot be asked about fingerprints';
    chip.onclick = () => toggle(source.key);
    return chip;
  };

  function drawSources() {
    const added = scrapers.filter((s) => picked.includes(s.key));

    const picker = scrapers.length
      ? el('select', { className: 'facetinput scraperpick' },
        el('option', { value: '' }, `Add a scraper (${scrapers.length})…`),
        scrapers
          .filter((s) => !picked.includes(s.key))
          .map((s) => el('option', { value: s.key }, s.label)))
      : null;

    if (picker) picker.onchange = () => { if (picker.value) toggle(picker.value); };

    sourceLine.replaceChildren(
      el('span', { className: 'muted small' }, 'Ask'),
      ...boxes.map(chipFor),
      ...added.map(chipFor),
      ...(picker ? [picker] : []),
      el('span', { className: 'muted small' }, `${picked.length} at once`)
    );
  }

  drawSources();

  const box = withEndpoints.find((s) => s.endpoint === nowEndpoint) || null;

  // What the link filter is currently saying, in a clause the sentences below
  // can hang off. Empty when it is not in play.
  const linkSaid = !nowSite
    ? ''
    : nowSite === 'none'
      ? ' With no link on them at all — nothing has ever been scraped onto these.'
      : ` ${nowSiteSide === 'has' ? 'Linked to' : 'With no link to'} ${nowSite}.`;

  /* The pile's meaning in a sentence: naming a box changes the question. */
  const said = (box && mode === 'unmatched'
    ? (nowSide === 'has'
      ? `Every scene with a ${box.label} id.`
      : `Every scene with no ${box.label} id, including ones matched elsewhere.`)
    : mode === 'unmatched'
      ? 'Scenes with no usable stash-box id, including “0” ids not yet organised.'
      : mode === 'nocover'
        ? `Scenes with no cover. A match brings the picture with it.${box ? ` Narrowed to the ones that ${nowSide === 'has' ? 'have' : 'have no'} ${box.label} id.` : ''}`
        : `Scenes not marked organised. Tick, tag and mark them done.${box ? ` Narrowed to the ones that ${nowSide === 'has' ? 'have' : 'have no'} ${box.label} id.` : ''}`)
    + linkSaid;

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('div', { className: 'viewswitch' }, [
        ...MATCH_MODES.map(([key, label]) => pile(key, label)),
        boxPile('No StashDB id', (e) => /stashdb\.org/i.test(e)),
        boxPile('No TPDB id', (e) => /theporndb\.net/i.test(e) && /type=Scene/i.test(e)),
      ].filter(Boolean))),
    el('div', { className: 'controls sortline' }, words, sort, flip, desc),
    endpointPick || sitePick
      ? el('div', { className: 'controls sortline' },
        endpointPick ? el('span', { className: 'muted small' }, 'Stash-box id') : null,
        endpointPick,
        endpointPick ? sidePick : null,
        sitePick ? el('span', { className: 'muted small filtergap' }, 'Site link') : null,
        sitePick,
        sitePick ? siteSide : null)
      : null,
    sources.length ? sourceLine : null,
    // Directly under the sources, because they are the two halves of one press:
    // who gets asked, and what gets kept from the answer.
    fieldLine,
    el('div', { className: 'controls' }, el('span', { className: 'muted small' }, said))
  );
}

/*
 * -------------------------------------------------------- the missing phash
 *
 * A box asked by scene id only matches fingerprints. Without a phash a
 * scene has only an oshash (exact file). This bar generates missing
 * phashes for the pile. Its count loads after the queue.
 */
function phashBar(params) {
  const said = el('span', { className: 'muted small' }, 'Checking fingerprints…');
  const make = el('button', { className: 'add', type: 'button', hidden: true }, 'Generate phashes');
  const bar = el('div', { className: 'searchpanel phashbar' }, el('div', { className: 'controls' }, make, said));

  let timer = null;

  const watch = async (id) => {
    const { job } = await api('/api/import/match/phash/' + id).catch(() => ({ job: null }));
    if (!job) return;

    const pct = typeof job.progress === 'number' ? ` — ${Math.round(job.progress * 100)}%` : '';
    said.textContent = job.over
      ? (job.error ? 'Stash could not finish: ' + job.error : 'Done. Re-run a find and the fingerprints will answer.')
      : `Stash is hashing${pct}. You can leave this page; it carries on.`;

    if (job.over) {
      clearInterval(timer);
      make.hidden = false;
      make.disabled = false;
      make.textContent = 'Check again';
    }
  };

  make.onclick = async () => {
    make.disabled = true;
    make.textContent = 'Asking Stash…';
    try {
      const started = await api('/api/import/match/phash?' + pileParams(params), { method: 'POST' });
      if (!started.started) {
        said.textContent = started.why || 'Nothing to do.';
        make.hidden = true;
        return;
      }
      make.hidden = true;
      said.textContent = `Hashing ${started.scenes.toLocaleString()} scenes…`;
      // Slow on purpose: this runs for minutes and the answer only changes on
      // that scale. A tighter poll is a hundred requests saying the same thing.
      if (started.job) {
        watch(started.job);
        timer = setInterval(() => watch(started.job), 4000);
      }
    } catch (err) {
      make.disabled = false;
      make.textContent = 'Generate phashes';
      said.textContent = err.message;
    }
  };

  api('/api/import/match/phash?' + pileParams(params)).then((plan) => {
    if (plan.running) {
      said.textContent = `Stash is already busy: ${plan.running.description || 'a generate is running'}.`;
      return;
    }
    if (!plan.missing) {
      // Nothing missing is nothing to say. The bar takes itself away rather
      // than sitting there reporting a zero.
      bar.remove();
      return;
    }
    said.textContent = `${plan.missing.toLocaleString()} of ${plan.scenes.toLocaleString()} in this pile have no phash, `
      + 'so the boxes cannot recognise them by their frames and every find here is a keyword guess.';
    make.hidden = false;
  }).catch((err) => { said.textContent = err.message; });

  return bar;
}

function renderMatchQueue(body, params, queue, picked, listeners = [], fields = [], watchers = [], box = null) {
  const { mode, count, scenes, page, perPage, zeros, sort, dir } = queue;

  const order = (SORTS.find(([k]) => k === sort) || SORTS[0])[1].toLowerCase();

  /* Toggle to show set-aside scenes, only once there are some. */
  const showing = params.get('aside') === '1';
  const asideToggle = queue.asideCount
    ? (() => {
      const chip = el('button', { type: 'button', className: 'chip' + (showing ? ' on' : '') },
        showing ? 'Showing set aside' : `${queue.asideCount.toLocaleString()} set aside`);
      chip.title = showing
        ? 'Back to the scenes still worth looking for'
        : 'Scenes you have looked for and no stash-box has. Press to read them again.';
      chip.onclick = () => {
        const next = new URLSearchParams(params);
        if (showing) next.delete('aside');
        else next.set('aside', '1');
        next.delete('page');
        goMatch(next);
      };
      return chip;
    })()
    : null;

  const head = el('div', { className: 'feedhead' },
    el('h2', {}, `${count.toLocaleString()} to go`),
    el('span', { className: 'muted' }, `showing ${scenes.length}, by ${order}, ${dir === 'asc' ? 'ascending' : 'descending'}`),
    asideToggle ? el('span', { className: 'spacer' }) : null,
    asideToggle
  );

  if (!scenes.length) {
    body.replaceChildren(head, el('div', { className: 'empty small' }, 'Nothing left in this pile.'));
    return;
  }

  const kids = [head, phashBar(params)];

  // Stash refused the zero-id branch: the pile is smaller than it should be.
  // Not shown when a box is named.
  if (mode === 'unmatched' && zeros === false && !params.get('ep')) {
    kids.push(el('div', { className: 'muted small' },
      'Your Stash would not filter on the “0” ids, so this is only the scenes with no stash_id at all.'));
  }

  if (mode === 'unorganized') {
    const cards = scenes.map(taggableCard);
    kids.push(tagBar(scenes, body, params, cards));
    kids.push(el('div', { className: 'cards' }, cards.map((c) => c.node)));
  } else {
    const rows = scenes.map((scene) => matchRow(scene, picked, fields, watchers, box, queue.asideTag));
    kids.push(bulkBar(rows, picked, listeners, box));
    kids.push(el('div', { className: 'tracked' }, rows.map((row) => row.node)));
    // At the bottom, where you arrive after reading down the page rather than
    // where you started before there was anything to file.
    kids.push(fileAllBar(rows, box));
  }

  kids.push(matchPager(params, { page, perPage, count }));
  body.replaceChildren(...kids.filter(Boolean));
}

function matchPager(params, { page, perPage, count }) {
  const pages = Math.max(1, Math.ceil(count / perPage));
  if (pages < 2) return null;

  const go = (n) => () => {
    const next = new URLSearchParams(params);
    next.set('page', String(n));
    goMatch(next);
    window.scrollTo({ top: 0 });
  };

  const back = el('button', { className: 'chip', type: 'button', disabled: page <= 1 }, 'Previous');
  const on = el('button', { className: 'chip', type: 'button', disabled: page >= pages }, 'Next');
  back.onclick = go(page - 1);
  on.onclick = go(page + 1);

  return el('div', { className: 'toolbar' }, back, el('span', { className: 'muted' }, `Page ${page} of ${pages}`), on);
}

/*
 * ------------------------------------------------------------ the bulk bar
 *
 * Like the Tagger Bulk plugin: search every row in turn, and find/replace
 * across every row's query. Search All is sequential with an adjustable
 * pause; Stop takes effect after the current row.
 */
function bulkBar(rows, picked, listeners = [], box = null) {
  let running = false;
  let stopping = false;

  const idle = () => `${rows.length} rows, asking ${picked.length} source${picked.length === 1 ? '' : 's'} each`;
  const said = el('span', { className: 'muted small' }, idle());

  // The source chips can change under us now that they no longer re-read the
  // page. Quoting a count that is no longer true is worse than not quoting one.
  listeners.push(() => { if (!running) said.textContent = idle(); });

  const onlyPicked = el('input', { type: 'checkbox' });
  const skipDone = el('input', { type: 'checkbox', checked: true });
  const regex = el('input', { type: 'checkbox' });

  const find = el('input', { type: 'text', className: 'facetinput', placeholder: 'Find in query' });
  const replace = el('input', { type: 'text', className: 'facetinput', placeholder: 'Replace with' });

  // Sequential and slow on purpose; this is the knob for when it is still too
  // fast for whoever is on the other end.
  const gap = el('input', { type: 'number', className: 'facetinput gapbox', value: '800', min: '0', step: '100', title: 'Pause between rows, in milliseconds' });

  const searchAll = el('button', { className: 'add', type: 'button' }, 'Search All');
  const selectAll = el('button', { className: 'chip', type: 'button' }, 'Select all');

  /*
   * --------------------------------------------------- giving up on a page
   *
   * Set aside the ticked rows for this box. Ticked rows only. Two presses,
   * the second naming the count and box.
   */
  const asideWhere = box ? shortHost(box.endpoint) : null;
  const asideAll = el('button', { className: 'chip', type: 'button' },
    asideWhere ? `Set aside on ${asideWhere}` : 'Set aside');
  const asideYes = el('button', { className: 'chip danger', type: 'button', hidden: true }, 'Set them aside');
  const asideNo = el('button', { className: 'chip', type: 'button', hidden: true }, 'Cancel');

  const asideTargets = () => rows.filter((row) => row.selected() && !row.isAside());

  asideAll.onclick = () => {
    const list = asideTargets();
    if (!list.length) {
      said.textContent = rows.some((row) => row.selected())
        ? 'Those are already set aside.'
        : 'Tick the rows you have given up on first.';
      return;
    }
    said.textContent = asideWhere
      ? `${list.length} scene${list.length === 1 ? '' : 's'} off the ${asideWhere} pile. They stay in every other pile, and one press brings any of them back.`
      : `${list.length} scene${list.length === 1 ? '' : 's'} off every pile. One press brings any of them back.`;
    asideAll.hidden = true;
    asideYes.hidden = false;
    asideNo.hidden = false;
  };

  asideNo.onclick = () => {
    asideAll.hidden = false;
    asideYes.hidden = true;
    asideNo.hidden = true;
    said.textContent = idle();
  };

  asideYes.onclick = async () => {
    const list = asideTargets();
    asideYes.disabled = true;
    asideNo.disabled = true;

    let done = 0;
    const failed = [];

    /* One at a time: each is a read and write of the scene's tags. */
    for (const row of list) {
      said.textContent = `Setting aside ${done + 1} of ${list.length}…`;
      try {
        await row.setAside(true);
        done += 1;
      } catch {
        failed.push(row.id);
      }
    }

    asideYes.disabled = false;
    asideNo.disabled = false;
    asideAll.hidden = false;
    asideYes.hidden = true;
    asideNo.hidden = true;

    said.textContent = `Set aside ${done} of ${list.length}.`
      + (failed.length ? ` ${failed.length} would not take it.` : '')
      + ' Gone from this pile on the next read.';
  };

  const apply = el('button', { className: 'chip', type: 'button' }, 'Apply');
  const reset = el('button', { className: 'chip', type: 'button' }, 'Reset');

  /*
   * Select all: tick the first answer in each box on every answered row. If
   * they're all ticked already, untick them. Doesn't write.
   */
  selectAll.onclick = () => {
    const list = rows.filter((row) => row.hasFirsts());
    if (!list.length) {
      said.textContent = 'Nothing has answered yet — search first.';
      return;
    }

    const on = list.every((row) => row.firstsOn());
    for (const row of list) row.setFirsts(!on);

    const n = `${list.length} row${list.length === 1 ? '' : 's'}`;
    said.textContent = on
      ? `Unticked the first of each box on ${n}.`
      : `Ticked the first of each box on ${n}.`;
  };

  const targets = () => {
    const wanted = onlyPicked.checked ? rows.filter((row) => row.selected()) : rows;
    return skipDone.checked ? wanted.filter((row) => !row.answered()) : wanted;
  };

  const runningUI = (on) => {
    searchAll.textContent = on ? 'Stop' : 'Search All';
    searchAll.classList.toggle('danger', on);
    selectAll.disabled = on;
    apply.disabled = on;
    reset.disabled = on;
  };

  const nap = (ms) => new Promise((go) => setTimeout(go, ms));

  searchAll.onclick = async () => {
    if (running) {
      stopping = true;
      said.textContent = 'Stopping after this row…';
      return;
    }

    const list = targets();
    if (!list.length) {
      said.textContent = skipDone.checked ? 'Every row here has already been asked.' : 'No rows picked.';
      return;
    }

    running = true;
    stopping = false;
    runningUI(true);

    const pause = Math.min(60000, Math.max(0, Number(gap.value) || 0));
    let done = 0;

    for (const [at, row] of list.entries()) {
      if (stopping) break;
      said.textContent = `Searching ${at + 1} of ${list.length}…`;
      // Don't scroll to each row; the counter says where the run is. A failing
      // row doesn't stop the run.
      await row.search().catch(() => {});
      done += 1;
      if (at < list.length - 1 && pause) await nap(pause);
    }

    running = false;
    runningUI(false);
    said.textContent = `${stopping ? 'Stopped after' : 'Searched'} ${done} of ${list.length}.`;
    stopping = false;
  };

  const escaped = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  apply.onclick = () => {
    if (!find.value) {
      said.textContent = 'Type something to find first.';
      return;
    }

    let pattern;
    try {
      pattern = new RegExp(regex.checked ? find.value : escaped(find.value), 'gi');
    } catch (err) {
      said.textContent = 'Bad regex: ' + err.message;
      return;
    }

    let changed = 0;
    for (const row of targets()) {
      const now = row.query();
      const next = now.replace(pattern, replace.value).replace(/\s+/g, ' ').trim();
      if (next !== now) {
        row.setQuery(next);
        changed += 1;
      }
    }

    said.textContent = `Updated ${changed} quer${changed === 1 ? 'y' : 'ies'}.`;
  };

  /* Back to the keyword generated from the filename. */
  reset.onclick = () => {
    let count = 0;
    for (const row of targets()) {
      if (row.query() === row.generated) continue;
      row.setQuery(row.generated);
      count += 1;
    }
    said.textContent = `Reset ${count} quer${count === 1 ? 'y' : 'ies'}.`;
  };

  for (const box of [find, replace]) {
    box.onkeydown = (e) => { if (e.key === 'Enter') apply.onclick(); };
  }

  return el('div', { className: 'searchpanel bulkbar' },
    el('div', { className: 'controls' },
      searchAll,
      selectAll,
      el('label', { className: 'check' }, onlyPicked, ' Selected only'),
      el('label', { className: 'check' }, skipDone, ' Skip rows already asked'),
      el('span', { className: 'muted small' }, 'wait'),
      gap,
      el('span', { className: 'muted small' }, 'ms'),
      el('span', { className: 'spacer' }),
      asideAll,
      asideYes,
      asideNo),
    el('div', { className: 'controls' },
      find,
      replace,
      el('label', { className: 'check' }, regex, ' Regex'),
      apply,
      reset),
    el('div', { className: 'controls' }, said)
  );
}

/*
 * ------------------------------------------------------------- filing the lot
 *
 * File every row with something ticked, in order. Separate from Search All:
 * asking is free, writing isn't. A refused row doesn't stop the run.
 */
function fileAllBar(rows, box = null) {
  let running = false;
  let stopping = false;
  // While the set-aside question is showing, the counter mustn't overwrite it.
  let asking = false;

  const said = el('span', { className: 'muted small' }, '');
  const go = el('button', { className: 'add', type: 'button' }, 'File all ticked');

  /*
   * ------------------------------------------- and the ones with no answer
   *
   * Set aside the rows with nothing ticked, but only rows that were searched;
   * unsearched ones are counted, not touched. Two presses.
   */
  const where = box ? shortHost(box.endpoint) : null;
  const asideGo = el('button', { className: 'chip', type: 'button' },
    where ? `Not on ${where}` : 'Not in Stash/TPDB');
  const asideYes = el('button', { className: 'chip danger', type: 'button', hidden: true }, 'Set them aside');
  const asideNo = el('button', { className: 'chip', type: 'button', hidden: true }, 'Cancel');

  asideGo.title = where
    ? `Set aside every row that found nothing on ${where}. They stay in the other piles.`
    : 'Set aside every row here that found nothing. They leave every pile until you ask for them back.';

  const bar = el('div', { className: 'searchpanel fileallbar' },
    el('div', { className: 'controls' }, go, said,
      el('span', { className: 'spacer' }), asideGo, asideYes, asideNo));

  const ready = () => rows.filter((row) => row.ticked() > 0);

  // Asked, found nothing, and not already put aside.
  const empties = () => rows.filter((row) => !row.ticked() && !row.isAside() && row.answered());
  const unasked = () => rows.filter((row) => !row.ticked() && !row.isAside() && !row.answered());

  const count = () => {
    const list = ready();
    const ids = list.reduce((n, row) => n + row.ticked(), 0);
    said.textContent = list.length
      ? `${list.length} row${list.length === 1 ? '' : 's'} ticked, ${ids} id${ids === 1 ? '' : 's'} to file`
      : 'Nothing ticked yet — find something first.';
    go.disabled = !list.length;

    const blanks = empties().length;
    asideGo.disabled = !blanks;
    asideGo.textContent = blanks
      ? `${where ? `Not on ${where}` : 'Not in Stash/TPDB'} (${blanks})`
      : (where ? `Not on ${where}` : 'Not in Stash/TPDB');
  };

  /*
   * Ticks come from fingerprints, the picture pass and you, so the bar
   * recounts whenever the page is touched.
   */
  const watch = () => {
    // Stop listening once the bar is gone.
    if (!bar.isConnected) return stop();
    if (!running && !asking) count();
  };

  const stop = () => {
    document.removeEventListener('click', watch);
    document.removeEventListener('change', watch);
    clearInterval(settle);
  };

  document.addEventListener('click', watch);
  document.addEventListener('change', watch);
  // The picture pass ticks with no event at all, so the first half-minute is
  // polled. One pass over two dozen rows, not a loop that lives forever.
  const settle = setInterval(watch, 1200);
  setTimeout(stop, 30000);

  go.onclick = async () => {
    if (running) {
      stopping = true;
      said.textContent = 'Stopping after this one…';
      return;
    }

    const list = ready();
    if (!list.length) return count();

    running = true;
    stopping = false;
    go.textContent = 'Stop';
    go.classList.add('danger');

    let done = 0;
    let failed = 0;

    for (const [at, row] of list.entries()) {
      if (stopping) break;
      said.textContent = `Filing ${at + 1} of ${list.length}…`;
      row.node.scrollIntoView({ block: 'nearest' });
      try {
        await row.file();
        done += 1;
      } catch {
        // The row says so in its own found area; the run carries on.
        failed += 1;
      }
    }

    running = false;
    stopping = false;
    go.textContent = 'File all ticked';
    go.classList.remove('danger');
    said.textContent = `Filed ${done} of ${list.length}${failed ? `, ${failed} refused` : ''}.`;
  };

  const asideReset = () => {
    asideGo.hidden = false;
    asideYes.hidden = true;
    asideNo.hidden = true;
  };

  asideGo.onclick = () => {
    const list = empties();
    if (!list.length) {
      said.textContent = rows.some((row) => !row.ticked() && !row.isAside())
        ? 'Those rows have not been asked yet — search first.'
        : 'Every row here either found something or is already set aside.';
      return;
    }

    const waiting = unasked().length;
    said.textContent = `${list.length} row${list.length === 1 ? '' : 's'} found nothing`
      + (where ? ` on ${where}. They leave this pile and stay in the others.` : '. They leave every pile.')
      + (waiting ? ` ${waiting} more have not been asked and are left alone.` : '')
      + ' One press on any row brings it back.';

    asking = true;
    asideGo.hidden = true;
    asideYes.hidden = false;
    asideNo.hidden = false;
  };

  asideNo.onclick = () => {
    asking = false;
    asideReset();
    count();
  };

  /* One at a time, to avoid racing on a scene's tag list. */
  asideYes.onclick = async () => {
    const list = empties();
    asideYes.disabled = true;
    asideNo.disabled = true;
    // Filing and setting aside both write the same rows; disable the other while one runs.
    go.disabled = true;

    let done = 0;
    const failed = [];

    for (const row of list) {
      said.textContent = `Setting aside ${done + 1} of ${list.length}…`;
      try {
        await row.setAside(true);
        done += 1;
      } catch {
        failed.push(row.id);
      }
    }

    asideYes.disabled = false;
    asideNo.disabled = false;
    asideReset();
    asking = false;
    // Put back by hand rather than by count(), which would overwrite the line
    // below with the tick tally before anybody had read it.
    go.disabled = !ready().length;
    asideGo.disabled = !empties().length;

    said.textContent = `Set aside ${done} of ${list.length}.`
      + (failed.length ? ` ${failed.length} would not take it.` : '')
      + ' Gone from this pile on the next read.';
  };

  count();
  return bar;
}

/*
 * -------------------------------------------------------------- renaming
 *
 * Rename a pc-import file to `Studio.YYYY-MM-DD.Title`, one at a time, after
 * the preview. Never in bulk. Scope is enforced server-side.
 */
/* Set a scene aside: a tag, not organised. One press removes it. */
/* A stash-box endpoint, shortened. Matches the tag matchsort writes. */
const shortHost = (endpoint) => {
  try { return new URL(endpoint).host.replace(/^www\./, ''); } catch { return String(endpoint || ''); }
};

function asideBit(scene, row, box = null, asideTag = '') {
  const said = el('span', { className: 'muted small' }, '');

  /*
   * The claim depends on the pile: "not on any box" on No stash id, "not on
   * this box" on a per-box pile.
   */
  /* The host, not the full endpoint. Matches the tag's spelling. */
  const where = box ? shortHost(box.endpoint) : null;

  const put = el('button', { className: 'chip', type: 'button' },
    where ? `Not on ${where}` : 'Not on any box');

  put.title = where
    ? `Set aside for ${where} only. It stays in the other piles.`
    : 'Set aside: you have looked, and no stash-box has this. It leaves every pile until you ask for it back.';

  /* Read from the scene's tags whether it's already set aside. */
  let on = Boolean(asideTag) && (scene.tags || []).some((t) => t.name === asideTag);

  const draw = () => {
    put.textContent = on ? 'Bring it back' : (where ? `Not on ${where}` : 'Not on any box');
    put.classList.toggle('on', on);
    row.classList.toggle('setaside', on);
  };

  /* The press as a function, so the bulk bar goes through the row. */
  const press = async (going = !on) => {
    if (going === on) return on;
    put.disabled = true;
    said.textContent = going ? 'Setting aside…' : 'Bringing it back…';
    try {
      await api('/api/import/match/' + scene.id + '/aside', {
        method: 'POST',
        body: JSON.stringify({ aside: going, endpoint: box?.endpoint || '' }),
      });
      on = going;
      draw();
      // The row stays until the next read, so the undo stays under the cursor.
      said.textContent = on
        ? (where
          ? `Set aside for ${where} — gone from this pile on the next read, still in the others.`
          : 'Set aside — gone from the piles on the next read.')
        : 'Back in the pile.';
    } catch (err) {
      said.textContent = err.message;
      throw err;
    } finally {
      put.disabled = false;
    }
    return on;
  };

  put.onclick = () => press().catch(() => {});

  // Drawn once before it is handed over, because `on` can now start true — the
  // button was built with the other label and would otherwise keep it.
  draw();

  return { node: el('div', { className: 'controls asidebit' }, put, said), press, is: () => on };
}

/* A refused rename is a note, not a failure: the ids were filed. */
function renameSaid(out) {
  if (!out) return '';
  if (!out.ok) return ` The file was left alone: ${out.why}`;
  return ` Renamed to ${out.to.split('/').pop()}.`
    + (out.scanned ? '' : ' Stash would not rescan, so its path is stale until it does.');
}

/*
 * What happened to the file when marking organised moved it. Silent when
 * already filed; the time shown only when noticeable (out of /pc-import).
 */
function filedSaid(out) {
  if (!out || out.already) return '';
  if (!out.ok) return ` Marked organised, but the file did not move: ${out.why}`;

  const where = out.to.split('/').slice(0, -1).pop();
  const slow = out.how === 'copy' && out.ms > 1500 ? ` (copied in ${Math.round(out.ms / 1000)}s)` : '';
  return ` Filed into ${where}.${slow}`
    + (out.scanned ? '' : ' Stash would not rescan, so its path is stale until it does.');
}

/*
 * ------------------------------------------------------------- deleting
 *
 * The scene page's delete, here too: same routes and opt-ins. Two presses;
 * the second names what goes.
 */
function deleteBit(scene, row) {
  const said = el('span', { className: 'muted small' }, '');

  const start = el('button', { className: 'chip danger', type: 'button' }, 'Delete…');
  start.title = 'Delete this scene from Stash, and its file.';

  const yes = el('button', { className: 'chip danger', type: 'button', hidden: true }, 'Delete permanently');
  const keep = el('button', { className: 'chip', type: 'button', hidden: true }, 'Keep it');

  /* File ticked, galleries not (same rule as the scene page). */
  const fileBox = el('input', { type: 'checkbox', checked: true });
  const galBox = el('input', { type: 'checkbox' });
  const clipBox = el('input', { type: 'checkbox', checked: true });

  const options = el('span', { className: 'controls delopts', hidden: true });

  let facts = null;

  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const galleries = (n) => (n === 1 ? '1 gallery' : `${n} galleries`);

  const line = (box, text) => el('label', { className: 'check' }, box, ' ' + text);

  start.onclick = async () => {
    start.disabled = true;
    said.textContent = 'Reading what would go…';

    /* Reset to defaults every time it opens. */
    fileBox.checked = true;
    galBox.checked = false;
    clipBox.checked = true;

    try {
      facts = await api('/api/library/scenes/' + scene.id + '/removal');

      const held = facts.files?.[0] || null;
      const bits = [
        held
          ? line(fileBox, `Erase the file — ${gigabytes(held.size)}`)
          : el('span', { className: 'muted small' }, 'Stash holds no file for this one.'),
        facts.galleries?.length
          ? line(galBox, `Delete ${galleries(facts.galleries.length)} and their pictures`)
          : null,
        facts.clips ? line(clipBox, count(facts.clips, 'reel clip')) : null,
      ].filter(Boolean);

      options.replaceChildren(...bits);
      options.hidden = false;

      // Built at the moment you press, from the boxes as they stand.
      const going = () => [
        'the Stash record',
        held && fileBox.checked ? 'the file' : null,
        galBox.checked && facts.galleries?.length
          ? galleries(facts.galleries.length)
          : null,
        clipBox.checked && facts.clips ? count(facts.clips, 'clip') : null,
      ].filter(Boolean);

      const say = () => { said.textContent = `Taking ${going().join(', ')}. There is no undo.`; };
      for (const box of [fileBox, galBox, clipBox]) box.onchange = say;
      say();

      start.hidden = true;
      yes.hidden = false;
      keep.hidden = false;
    } catch (err) {
      said.textContent = err.message;
    } finally {
      start.disabled = false;
    }
  };

  keep.onclick = () => {
    yes.hidden = true;
    keep.hidden = true;
    options.hidden = true;
    start.hidden = false;
    said.textContent = '';
  };

  yes.onclick = async () => {
    yes.disabled = true;
    keep.disabled = true;
    said.textContent = 'Deleting…';
    try {
      await api('/api/library/scenes/' + scene.id + '/delete', {
        method: 'POST',
        body: JSON.stringify({
          file: Boolean(facts?.files?.[0]) && fileBox.checked,
          galleries: galBox.checked,
          clips: clipBox.checked,
        }),
      });
      /* The row stays until the next read. */
      row.classList.add('deleted');
      options.hidden = true;
      yes.hidden = true;
      keep.hidden = true;
      said.textContent = 'Deleted. Gone from the pile on the next read.';
    } catch (err) {
      yes.disabled = false;
      keep.disabled = false;
      said.textContent = err.message;
    }
  };

  return el('div', { className: 'controls deletebit' }, start, options, yes, keep, said);
}

function renameBit(scene, row) {
  // Only offer rename in /pc-import; checked locally to save requests.
  if (!scene.path || !scene.path.startsWith('/pc-import/')) return null;

  const said = el('span', { className: 'muted small' }, '');
  const ask = el('button', { className: 'chip', type: 'button' }, 'Rename file…');
  const doIt = el('button', { className: 'chip danger', type: 'button', hidden: true }, 'Rename');
  const bit = el('div', { className: 'controls renamebit' }, ask, doIt, said);

  ask.onclick = async () => {
    ask.disabled = true;
    said.textContent = 'Working out the name…';
    try {
      const plan = await api('/api/import/match/' + scene.id + '/rename');
      if (!plan.can) {
        said.textContent = plan.why;
        doIt.hidden = true;
        return;
      }
      // The name in full before the press, because a rename you did not read
      // is a rename you had no chance to disagree with.
      said.textContent = '→ ' + plan.to;
      doIt.hidden = false;
    } catch (err) {
      said.textContent = err.message;
    } finally {
      ask.disabled = false;
    }
  };

  doIt.onclick = async () => {
    doIt.disabled = true;
    ask.disabled = true;
    said.textContent = 'Renaming…';
    try {
      const done = await api('/api/import/match/' + scene.id + '/rename', { method: 'POST' });
      doIt.hidden = true;
      ask.hidden = true;
      said.textContent = 'Renamed' + (done.scanned ? '. Stash is rescanning the folder.' : ', but Stash would not rescan — its path is stale until it does.');
      // The row's own path line is now wrong, and the row is not going to be
      // redrawn until the pile is.
      const path = row.querySelector('.path');
      if (path) path.textContent = done.to;
    } catch (err) {
      doIt.disabled = false;
      ask.disabled = false;
      said.textContent = err.message;
    }
  };

  return bit;
}

/* --------------------------------------------------------------- matching */

function matchRow(scene, picked, fields = [], watchers = [], box = null, asideTag = '') {
  const found = el('div', {});

  // Ticked rows are what "Selected only" means on the bar above. Same idea as
  // the tagger's own row check: a way to say "these ones, not the page".
  const tick = el('input', { type: 'checkbox', className: 'rowtick', title: 'Include in Search All' });

  /*
   * The search keyword, generated from the filename (resolution and codec
   * removed). Editable, since it's often wrong.
   */
  const term = el('input', {
    type: 'text',
    className: 'facetinput termbox',
    placeholder: 'Search words…',
    value: scene.term || '',
    autocomplete: 'off',
  });

  const look = el('button', { className: 'add', type: 'button' }, 'Find it');

  /* What this row would file. Replaced on every find. */
  let filer = null;

  const find = async ({ typed }) => {
    look.disabled = true;
    look.textContent = 'Looking…';
    found.replaceChildren(el('div', { className: 'muted small' }, `Asking ${picked.length} source${picked.length === 1 ? '' : 's'}…`));

    const query = new URLSearchParams();
    for (const key of picked) query.append('source', key);
    // Only sent when it was typed at: an untouched box means "use the
    // fingerprints", which is the answer that cannot be a coincidence.
    if (typed && term.value.trim() && term.value.trim() !== (scene.term || '')) query.set('term', term.value.trim());

    try {
      const result = await api('/api/import/match/' + scene.id + '?' + query);
      filer = null;
      renderCandidates(found, scene, result, row, (f) => { filer = f; }, sheetSlot, fields, watchers);
    } catch (err) {
      found.replaceChildren(el('div', { className: 'muted small' }, err.message));
    } finally {
      look.disabled = false;
      look.textContent = 'Find it';
    }
  };

  look.onclick = () => find({ typed: true });
  term.onkeydown = (e) => { if (e.key === 'Enter') find({ typed: true }); };

  const meta = [
    scene.date || 'no date',
    scene.studio?.name,
    scene.performers.map((p) => p.name).join(', '),
    scene.phashes.length ? 'has a phash' : scene.oshashes.length ? 'oshash only' : 'no fingerprints',
    scene.deadIds.length ? `${scene.deadIds.length} dead id` : null,
    scene.organized ? 'organised' : null,
  ].filter(Boolean);

  /* Show how the filename was read; a DVD-style name can't be answered by StashDB. */
  const read = scene.name || {};
  const asRead = [
    read.performer ? `performer: ${read.performer}` : null,
    read.studio ? `studio: ${read.studio}` : null,
    read.sceneNo ? `scene ${read.sceneNo} of it` : null,
    read.shape === 'movie-scene' ? 'reads as a film — try the TPDB movies box' : null,
  ].filter(Boolean);

  // Filled after the row exists: the button rewrites the row's own path line
  // when it succeeds, and cannot be handed a row that is not built yet.
  const rename = el('div', {});

  /* The compare sheet's slot, a direct child of the row so it spans all four columns. */
  const sheetSlot = el('div', { className: 'cmpslot' });

  const art = sceneArt(scene);

  // Built before the row so the delete can be appended to it afterwards — it
  // needs the row to mark it, and the row needs this to be drawn.
  const actions = el('div', { className: 'trackedactions matchactions' },
    term, look, generateBit(scene.id, art.img));

  const row = el('div', { className: 'crow matchrow' },
    el('label', { className: 'check rowpick' }, tick),
    art.node,
    el('div', {},
      el('div', { className: 'title' }, scene.title || '(untitled)'),
      el('div', { className: 'meta' }, meta.map((m) => el('span', {}, m))),
      asRead.length ? el('div', { className: 'meta asread' }, asRead.map((m) => el('span', {}, m))) : null,
      scene.path ? el('div', { className: 'muted small path' }, scene.path) : null,
      rename,
      found
    ),
    actions,
    sheetSlot
  );

  /* Rename and set-aside under the path; delete at the foot, away from them. */
  const aside = asideBit(scene, row, box, asideTag);
  const bits = [renameBit(scene, row), aside.node].filter(Boolean);
  if (bits.length) rename.replaceChildren(...bits);

  actions.append(deleteBit(scene, row));

  /* A controller, so the bulk bar drives rows without reaching into their DOM. */
  return {
    id: scene.id,
    node: row,
    generated: scene.term || '',
    query: () => term.value,
    setQuery: (value) => { term.value = value; },
    selected: () => tick.checked,
    answered: () => found.dataset.answered === '1',
    search: () => find({ typed: true }),
    // What File All needs: whether this row has anything to file, and the
    // same press the row's own button makes.
    ticked: () => (filer ? filer.count() : 0),
    file: () => (filer ? filer.run() : Promise.resolve()),
    // And what Tick All needs: whether this row has firsts to speak for, where
    // they currently stand, and the way to set them.
    hasFirsts: () => Boolean(filer && filer.hasFirsts()),
    firstsOn: () => Boolean(filer && filer.firstsOn()),
    setFirsts: (on) => filer && filer.setFirsts(on),
    // And what Set Aside All needs: where this row stands, and the row's own
    // press — so the row says what happened to it rather than the bar guessing.
    isAside: () => aside.is(),
    setAside: (on) => aside.press(on),
  };
}

/*
 * The row's picture, via the portal: a real cover or a frame cut from the
 * file (Stash's placeholder is undetectable here). Double-click cuts one anyway.
 */
function sceneArt(scene) {
  const src = `/media/scene/${scene.id}/thumb`;
  const art = el('img', { className: 'art', src, loading: 'lazy', alt: '', title: 'Double-click for a fresh frame' });

  art.ondblclick = () => {
    art.classList.add('cutting');
    art.src = `${src}?force=1&at=${Date.now()}`;
  };
  art.onload = () => art.classList.remove('cutting');

  /* Hover plays the preview; the bottom edge scrubs. */
  return { node: liveArt(scene.id, art), img: art };
}

/*
 * One band per source, never merged. Fingerprint hits and title guesses
 * are drawn alike but labelled differently.
 */
function renderCandidates(found, scene, result, row, onFiler, sheetSlot = null, fields = [], watchers = []) {
  const bands = result.results || [];
  const answered = bands.filter((band) => band.matches.length);

  if (!answered.length) {
    const notes = bands.map((band) => `${band.label}: ${band.note || 'nothing'}`).join(' · ');
    found.replaceChildren(el('div', { className: 'muted small' },
      notes || `Nothing found for “${result.term}”.`));
    // Asked and answered with nothing, which is still asked — Search All must
    // not come back round and ask it again.
    found.dataset.answered = '1';
    return;
  }

  /* Read at press time, so the chips' current state applies. */
  const wants = () => new Set(fields);
  const picks = new Map(); // key -> the match itself, in tick order

  /*
   * Covers arrive as base64 data URIs (up to ~1MB). `trim` sends only the
   * first when Cover is ticked; `bones` sends just the rename fields.
   */
  const trim = (list, keepCover) => {
    let used = false;
    return list.map((p) => {
      if (keepCover && !used && p.image) { used = true; return p; }
      return { ...p, image: null };
    });
  };

  const bones = (list) => list.map((p) => ({
    source: p.source,
    sourceLabel: p.sourceLabel,
    title: p.title,
    date: p.date,
    rawDate: p.rawDate,
    studioName: p.studioName,
  }));

  const apply = el('button', { className: 'add', type: 'button', disabled: true }, 'File these');
  const counter = el('span', { className: 'muted small' }, 'nothing ticked');

  /*
   * ------------------------------------------------- renaming with the filing
   *
   * A rename tick beside File (in pc-import), with the name planned from the
   * ticked picks and fields.
   */
  const home = scene.path && scene.path.startsWith('/pc-import/');
  const also = el('input', { type: 'checkbox', checked: home });
  const willBe = el('span', { className: 'muted small' }, '');
  let touched = false;
  also.onchange = () => { touched = true; };

  let timer = null;
  let asked = 0;
  const replan = () => {
    if (!home) return;
    clearTimeout(timer);
    if (!picks.size) {
      willBe.textContent = '';
      also.disabled = true;
      return;
    }
    willBe.textContent = 'working out the name…';
    timer = setTimeout(async () => {
      const mine = ++asked;
      try {
        const plan = await api('/api/import/match/' + scene.id + '/rename/plan', {
          method: 'POST',
          body: JSON.stringify({ picks: bones([...picks.values()]), fields: [...wants()] }),
        });
        // A slower answer to an older question must not overwrite a newer one.
        if (mine !== asked) return;
        willBe.textContent = plan.can ? '→ ' + plan.to : plan.why;
        also.disabled = !plan.can;
        also.checked = plan.can ? (touched ? also.checked : true) : false;
      } catch (err) {
        if (mine === asked) willBe.textContent = err.message;
      }
    }, 350);
  };

  // Replaced once the bands are drawn; redraw may run before that.
  let syncFirsts = () => {};

  const redraw = () => {
    const boxes = [...picks.values()].map((p) => p.sourceLabel);
    counter.textContent = boxes.length ? `filing ${boxes.join(' + ')}` : 'nothing ticked';
    apply.disabled = !picks.size;
    syncFirsts();
    replan();
  };

  const fileThese = async () => {
    if (!picks.size) return;
    for (const b of found.querySelectorAll('button')) b.disabled = true;
    apply.textContent = 'Saving…';

    try {
      const saved = await api('/api/import/match/' + scene.id, {
        method: 'POST',
        body: JSON.stringify({
          picks: trim([...picks.values()], wants().has('cover')),
          fields: [...wants()],
          rename: Boolean(home && also.checked && !also.disabled),
        }),
      });

      /* Filing shrinks the row; pin its top so the page doesn't jump. */
      const was = row.getBoundingClientRect().top;
      const hold = () => {
        const now = row.getBoundingClientRect().top;
        if (now !== was) window.scrollBy({ top: now - was, behavior: 'instant' });
      };

      row.classList.add('matched');
      /* Link picks never file an id, so don't report that as a failure. */
      const onlyLinks = [...picks.values()].every((p) => p.source === 'links');
      const filed = saved.ids.length
        ? `Filed ${saved.ids.length} id${saved.ids.length === 1 ? '' : 's'}. `
        : onlyLinks
          ? 'Read off the links this scene already had. '
          : 'No id could be filed. ';

      /* Anything created (studios, performers) is reported first, by name. */
      const made = (saved.created || []).length
        ? 'Made ' + saved.created.join(', ') + '. '
        : '';

      found.replaceChildren(el('div', { className: 'muted small' },
        filed + made + (saved.skipped.length
          ? 'Left alone: ' + saved.skipped.join(', ') + '.'
          : 'Everything ticked came across.')
        + renameSaid(saved.renamed) + filedSaid(saved.filed)));

      // Update the row's path line: filing moves further than a rename.
      const moved = saved.filed?.ok ? saved.filed.to : saved.renamed?.ok ? saved.renamed.to : null;
      if (moved) {
        const path = row.querySelector('.path');
        if (path) path.textContent = moved;
      }

      hold();
    } catch (err) {
      for (const b of found.querySelectorAll('button')) b.disabled = false;
      apply.textContent = 'File these';
      throw err;
    }
  };

  /* This button alerts; File All catches and carries on. */
  apply.onclick = () => fileThese().catch((err) => alert(err.message));
  onFiler?.({
    count: () => picks.size,
    run: fileThese,
    /* Select all, set to a value rather than toggled, so every row agrees. */
    hasFirsts: () => firsts().length > 0,
    firstsOn: () => {
      const list = firsts();
      return list.length > 0 && list.every((row) => row.ticked());
    },
    setFirsts: (on) => {
      for (const row of firsts()) if (row.ticked() !== on) row.toggle();
    },
  });

  // Kept per band, because the picture pass ticks one per source at most.
  const drawn = [];

  const band = (answer) => {
    const rows = answer.matches.map((match, at) =>
      candidateRow(match, picks, redraw, at === 0 && match.confidence === 'exact', scene.id));

    drawn.push({ answer, rows });

    return el('div', { className: 'sourceband' },
      el('div', { className: 'muted small bandhead' },
        answer.label,
        answer.via ? ` — matched on ${answer.via}` : '',
        answer.matches.length ? '' : ` — ${answer.note || 'nothing'}`),
      rows.length ? el('div', { className: 'idpicks' }, rows.map((row) => row.node)) : null
    );
  };

  /* The compare sheet, on request (it cuts frames from the file). */
  /*
   * Select all: the first row of each band. Unticks them if they're already
   * the ticks. Other ticks are left alone.
   */
  const firsts = () => drawn.map(({ rows }) => rows[0]).filter(Boolean);

  const all = el('button', { className: 'chip', type: 'button' }, 'Tick the first of each');

  all.onclick = () => {
    const list = firsts();
    if (!list.length) return;
    // Already all on? Then this press is the undo.
    const on = list.every((row) => row.ticked());
    for (const row of list) if (row.ticked() === on) row.toggle();
  };

  syncFirsts = () => {
    const list = firsts();
    all.hidden = !list.length;
    all.textContent = list.length && list.every((row) => row.ticked())
      ? 'Untick those'
      : 'Tick the first of each';
  };

  const sheet = sheetSlot || el('div', {});
  const look = el('button', { className: 'chip', type: 'button' }, 'Compare pictures');

  look.onclick = () => {
    if (sheet.firstChild) {
      sheet.replaceChildren();
      look.textContent = 'Compare pictures';
      return;
    }

    const images = drawn.flatMap(({ answer, rows }) =>
      rows
        .filter((r) => r.match.image)
        .map((r) => ({
          key: r.match.key,
          label: `${answer.label} — ${r.match.title || 'untitled'}`,
          src: r.match.image,
          // Deciding by looking and then ticking in the same press, which is
          // the only reason this is more than a picture viewer.
          onPick: () => { r.toggle(); return r.ticked(); },
        })));

    if (!images.length) {
      sheet.replaceChildren(el('div', { className: 'muted small' }, 'None of the answers came with a picture.'));
      return;
    }

    look.textContent = 'Hide the comparison';
    sheet.replaceChildren(compareSheet(scene.id, images, {
      onClose: () => { sheet.replaceChildren(); look.textContent = 'Compare pictures'; },
    }));
  };

  /* Filtered: replaceChildren stringifies null (el() drops it). */
  found.replaceChildren(
    ...[
      el('div', { className: 'bands' }, bands.map(band)),
      el('div', { className: 'controls applyline' }, apply, counter, all, look),
      home
        ? el('div', { className: 'controls wcrename' },
            el('label', { className: 'check' }, also, ' Rename the file too'),
            willBe)
        : null,
    ].filter(Boolean)
  );

  // A fresh find replaces the answers, so anything the last one left open in
  // the slot is about scenes that are no longer on screen.
  if (sheetSlot) sheetSlot.replaceChildren();

  /* Compare pictures after drawing; ticks arrive a moment later. */
  pickByLooks(scene.id, drawn).catch(() => {});

  // Marks the row as answered, even if it found nothing.
  found.dataset.answered = '1';

  // Title, Date and Studio are the filename, so a change to them at the top of
  // the page has to show in the name this row is offering to write.
  if (home) watchers.push({ node: found, run: replan });

  redraw();
}

/*
 * ------------------------------------------------------- looking alike
 *
 * Tick the candidate whose artwork matches the scene's cover, by a 64-bit
 * difference hash. Measured here: correct candidates scored 0–18, wrong
 * ones 25+, so the line is 20. Measure in a browser if you change it —
 * ffmpeg's downscaler gives different numbers.
 *
 * No help when the scene's picture is a cut frame, or the box's art is a
 * different shot; nothing is ticked then.
 */

const LOOKS_CLOSE = 20;

// 9x8 greys, then each pixel against its right-hand neighbour.
const HASH_W = 9;
const HASH_H = 8;

/* -> 64 bits, or null if the picture can't be read (including a tainted canvas). */
function pictureHash(src) {
  return new Promise((done) => {
    if (!src) return done(null);

    const img = new Image();
    // Harmless on a data URI, and the whole reason a remote one can be read.
    img.crossOrigin = 'anonymous';

    const give = () => done(null);
    img.onerror = give;

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = HASH_W;
        canvas.height = HASH_H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, HASH_W, HASH_H);

        const { data } = ctx.getImageData(0, 0, HASH_W, HASH_H);
        const grey = [];
        for (let i = 0; i < data.length; i += 4) {
          grey.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        }

        const bits = [];
        for (let y = 0; y < HASH_H; y++) {
          for (let x = 0; x < HASH_W - 1; x++) {
            bits.push(grey[y * HASH_W + x] > grey[y * HASH_W + x + 1] ? 1 : 0);
          }
        }
        done(bits);
      } catch {
        // A tainted canvas throws on read. Not an error worth showing.
        give();
      }
    };

    img.src = src;
  });
}

const bitsApart = (a, b) => a.reduce((n, bit, i) => n + (bit === b[i] ? 0 : 1), 0);

/* At most one tick per band, by picture. Bands with a tick already are left alone. */
async function pickByLooks(sceneId, bands) {
  const mine = await pictureHash(`/media/scene/${sceneId}/thumb`);
  if (!mine) return;

  for (const { rows } of bands) {
    if (!rows.length || rows.some((row) => row.ticked())) continue;

    let best = null;
    for (const row of rows) {
      const theirs = await pictureHash(row.match.image);
      if (!theirs) continue;
      const apart = bitsApart(mine, theirs);
      if (apart <= LOOKS_CLOSE && (!best || apart < best.apart)) best = { row, apart };
    }

    if (best) best.row.tick(best.apart);
  }
}

/* One candidate, with a tick. */
function candidateRow(match, picks, redraw, sure, sceneId = null) {
  /* Exact (fingerprint) hits start ticked. */
  const box = el('input', { type: 'checkbox', checked: Boolean(sure) });
  if (sure) picks.set(match.key, match);

  box.onchange = () => {
    if (box.checked) picks.set(match.key, match);
    else picks.delete(match.key);
    line.classList.toggle('on', box.checked);
    redraw();
  };

  // Why it was ticked, added once pictures are compared.
  const why = el('span', { className: 'badge looksame', hidden: true }, 'same picture');

  /* Tick via the same steps as a press, so it's applied. */
  const tickByLooks = (apart) => {
    box.checked = true;
    picks.set(match.key, match);
    line.classList.add('on');
    why.hidden = false;
    why.title = `The artwork matches this scene's own picture — ${apart} of 64 apart, where a wrong answer has never measured below 25.`;
    redraw();
  };

  const metaLine = el('div', { className: 'meta' });

  const drawMeta = () => {
    const bits = [
      match.date || 'no date',
      match.studioName,
      match.performers?.length ? match.performers.map((p) => p.name).join(', ') : null,
      match.tags?.length ? `${match.tags.length} tag${match.tags.length === 1 ? '' : 's'}` : null,
      match.remoteId ? null : 'no id, metadata only',
    ].filter(Boolean);
    metaLine.replaceChildren(...bits.map((m) => el('span', {}, m)));
  };

  drawMeta();

  /*
   * The candidate's art at the same size as the scene's, so they can be
   * compared. A missing picture still takes the column.
   */
  const art = match.image
    ? el('img', { className: 'pickart', src: match.image, loading: 'lazy', alt: '' })
    : el('div', { className: 'pickart none' }, el('span', { className: 'muted small' }, 'no art'));

  /*
   * ----------------------------------------------------- reading its page
   *
   * Read the candidate's page for cast and tags a search result lacks.
   * Merged into the candidate (the same object in `picks`); never shortens it.
   */
  const readBit = el('span', { className: 'readbit' });

  /* Scraper answers only: stash-boxes return full records. */
  const thinnable = String(match.source || '').startsWith('scraper:');

  if (match.url && sceneId && thinnable) {
    const read = el('button', { className: 'chip tiny', type: 'button' }, 'Read its page');
    read.title = 'Fetch the candidate’s own page — searches answer thin, pages do not.';
    const said = el('span', { className: 'muted small' }, '');

    read.onclick = async () => {
      read.disabled = true;
      read.textContent = 'Reading…';
      try {
        const out = await api('/api/import/match/' + sceneId + '/page', {
          method: 'POST',
          body: JSON.stringify({ url: match.url, key: match.key }),
        });

        const before = {
          performers: match.performers?.length || 0,
          tags: match.tags?.length || 0,
          studio: Boolean(match.studioName),
        };

        /* Only non-empty fields from the page. */
        for (const [key, value] of Object.entries(out.match || {})) {
          if (key === 'key') continue;
          const empty = value == null || value === ''
            || (Array.isArray(value) && !value.length);
          if (!empty) match[key] = value;
        }

        drawMeta();

        const gained = [
          (match.performers?.length || 0) - before.performers,
          (match.tags?.length || 0) - before.tags,
        ];
        const won = [
          gained[0] > 0 ? `${gained[0]} performer${gained[0] === 1 ? '' : 's'}` : null,
          gained[1] > 0 ? `${gained[1]} tag${gained[1] === 1 ? '' : 's'}` : null,
          !before.studio && match.studioName ? 'the studio' : null,
        ].filter(Boolean);

        said.textContent = won.length ? `+ ${won.join(', ')}` : 'the page said no more than the search did';
        read.hidden = true;
        // Ticked or not, the object the tick points at is the one just filled
        // in — so this has to run either way.
        redraw();
      } catch (err) {
        said.textContent = err.message;
        read.disabled = false;
        read.textContent = 'Read its page';
      }
    };

    readBit.append(read, said);
  }

  const line = el('div', { className: 'idpick' },
    art,
    el('div', { className: 'idpickbody' },
      match.url
        ? el('a', { className: 'title', href: match.url, target: '_blank', rel: 'noreferrer' }, match.title || '(untitled)')
        : el('div', { className: 'title' }, match.title || '(untitled)'),
      metaLine,
      el('div', { className: 'idpickbadges' },
        el('span', { className: 'badge ' + (match.confidence === 'exact' ? 'stash-exact' : 'monitored') },
          match.confidence),
        why,
        readBit)
    ),
    // Hard against the right edge, whatever the row is currently doing with
    // the space in the middle.
    el('label', { className: 'check idpicktick' }, box)
  );

  if (sure) line.classList.add('on');

  // What the picture pass and compare sheet need of a row: its offer,
  // whether it's ticked, and ways to tick it.
  return {
    node: line,
    match,
    ticked: () => box.checked,
    tick: tickByLooks,
    toggle: () => { box.checked = !box.checked; box.onchange(); return box.checked; },
  };
}

/* ---------------------------------------------------------------- tagging */

const picked = new Set();

/* A controller for the unorganised pile's cards, for select all. */
function taggableCard(scene) {
  // Same picture rule as the match rows: the portal decides, because Stash
  // answers a missing cover with a placeholder rather than a miss.
  const art = el('div', { className: 'cardart landscape' },
    el('img', { src: `/media/scene/${scene.id}/thumb`, loading: 'lazy', alt: '' }));

  const card = el('article', { className: 'card taggable' },
    art,
    el('div', { className: 'cardbody' },
      el('div', { className: 'title' }, scene.title || '(untitled)'),
      el('div', { className: 'meta' },
        el('span', {}, scene.date || 'no date'),
        scene.studio?.name ? el('span', {}, scene.studio.name) : null),
      folderLine(scene.path, 'cardfolder')
    )
  );

  const set = (on) => {
    if (on) picked.add(scene.id);
    else picked.delete(scene.id);
    card.classList.toggle('on', on);
  };

  card.onclick = () => {
    set(!picked.has(scene.id));
    document.dispatchEvent(new CustomEvent('tagpick'));
  };

  return { node: card, set, id: scene.id };
}

/* Existing tags only. Organised rides along with the tags. */
function tagBar(scenes, body, params, cards = []) {
  picked.clear();

  const chosen = new Map(); // id -> name
  const counter = el('span', { className: 'muted small' }, 'nothing picked');
  const chips = el('div', { className: 'chips' });

  const search = el('input', {
    type: 'text',
    className: 'facetinput',
    placeholder: 'A tag Stash already has…',
    autocomplete: 'off',
  });

  const menu = el('div', { className: 'facetmenu' });
  const wrap = el('div', { className: 'facet' }, search, menu);

  const done = el('input', { type: 'checkbox', checked: true });
  const doneLabel = el('label', { className: 'check' }, done, ' Mark organised');

  const apply = el('button', { className: 'add', type: 'button' }, 'Save');

  /* Select all or none, on this page only. */
  const all = el('button', { className: 'chip', type: 'button' }, `Select all ${cards.length}`);
  const none = el('button', { className: 'chip', type: 'button' }, 'Clear');

  const setAll = (on) => {
    for (const card of cards) card.set(on);
    document.dispatchEvent(new CustomEvent('tagpick'));
  };

  all.onclick = () => setAll(true);
  none.onclick = () => setAll(false);

  const redrawCount = () => {
    counter.textContent = picked.size
      ? `${picked.size} scene${picked.size === 1 ? '' : 's'} picked`
      : 'nothing picked';
    apply.disabled = !picked.size || (!chosen.size && !done.checked);
  };
  document.addEventListener('tagpick', redrawCount);
  done.onchange = redrawCount;
  redrawCount();

  const redrawChips = () => {
    chips.replaceChildren(...[...chosen.entries()].map(([id, name]) => {
      const chip = el('span', { className: 'chip tag' }, el('span', {}, name));
      const drop = el('button', { className: 'chipx', type: 'button' }, '×');
      drop.onclick = () => { chosen.delete(id); redrawChips(); redrawCount(); };
      chip.append(drop);
      return chip;
    }));
    redrawCount();
  };

  const close = () => { menu.replaceChildren(); wrap.classList.remove('open'); };

  let timer = null;
  const look = async () => {
    const term = search.value.trim();
    try {
      const { tags } = await api('/api/import/tags?q=' + encodeURIComponent(term));
      menu.replaceChildren(...tags.slice(0, 20).map((tag) => {
        const row = el('button', { type: 'button', className: 'facetrow' },
          el('span', { className: 'facename' }, tag.name),
          el('span', { className: 'muted small' }, String(tag.scene_count)));
        row.onclick = () => {
          chosen.set(tag.id, tag.name);
          search.value = '';
          close();
          redrawChips();
        };
        return row;
      }));
      wrap.classList.add('open');
    } catch (err) {
      menu.replaceChildren(el('div', { className: 'facetnone' }, err.message));
      wrap.classList.add('open');
    }
  };

  search.oninput = () => { clearTimeout(timer); timer = setTimeout(look, 250); };
  search.onfocus = look;
  search.onblur = () => setTimeout(close, 150);

  apply.onclick = async () => {
    apply.disabled = true;
    const was = apply.textContent;
    apply.textContent = 'Saving…';

    try {
      const { changed } = await api('/api/import/tags', {
        method: 'POST',
        body: JSON.stringify({
          scenes: [...picked],
          tags: [...chosen.keys()],
          organized: done.checked ? true : null,
        }),
      });
      apply.textContent = `Saved ${changed}`;
      // The scenes just saved are no longer in this pile, so the pile is reread.
      setTimeout(() => goMatch(new URLSearchParams(params)), 900);
    } catch (err) {
      apply.disabled = false;
      apply.textContent = was;
      alert(err.message);
    }
  };

  return el('div', { className: 'searchpanel tagbar' },
    el('div', { className: 'searchline' }, wrap, doneLabel, apply),
    el('div', { className: 'controls' }, all, none, counter, chips)
  );
}
