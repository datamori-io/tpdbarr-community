/* Scenes Stash never identified, and the candidates for them. */

import { api, el, folderLine, gigabytes } from '../util.js';
import { SECTION_OF, painterFor, show, state } from '../import/core.js';
import { compareSheet } from './compare.js';
import { generateBit, liveArt } from './liveart.js';

/* ============================================================ match & sort
 *
 * The piles of work a library this size always has waiting, and the reason
 * this page exists: all of them currently mean leaving the portal for Stash's
 * own interface.
 *
 *   No stash id — the scene carries no usable stash-box id. An id is the thing
 *                 every other page here recognises a scene by, so attaching one
 *                 makes coverage, dispositions and the whole import side more
 *                 accurate at once.
 *   No cover    — the scene is invisible on every shelf in the portal. Same fix
 *                 as above: the picture comes with the match.
 *   Not organised — nobody has said this one is finished.
 *
 * **A find asks every source at once.** This is Stash's Identify, in a page you
 * can watch: the stash-boxes and the scene scrapers are asked in parallel and
 * their answers are kept apart, one band each. You tick as many as are right —
 * StashDB *and* TPDB, normally — and one press files both ids.
 *
 * Everything here writes to Stash, so nothing on this page happens on a page
 * load. You press the thing that says what it will do.
 */

const MATCH_MODES = [
  ['unmatched', 'No stash id'],
  ['nocover', 'No cover'],
  ['unorganized', 'Not organised'],
];

// Sorting is Stash's, not ours. `path` is the one worth naming: sorting on the
// whole path sorts by folder first and filename second, which is what "grouped
// by folders" means when the folder is the only grouping a loose scene has.
/*
 * Newest into the library first — see SORT_DEFAULT in matchsort.mjs for why
 * that is not the scene's own date. This end has to name the same default as
 * that one: the address only carries `sort` when it differs from it, so a
 * disagreement would be an address that sorted differently at each end.
 */
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

/*
 * The address's filters, in the spelling the API uses. The queue and the phash
 * bar must ask about the same set of scenes — a Generate scoped to a different
 * pile than the list underneath it would be a button that lied — so both build
 * their query from here.
 */
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

/*
 * The source list is asked of Stash once and kept, because it is the same
 * answer for every row on the page and every page of the pile — a scraper is
 * not installed halfway down a queue.
 */
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
 * Which fields a find will write, for the whole page rather than for one row.
 *
 * These used to live inside each row's answer panel, which meant the decision
 * was re-made every single time: work down a pile with descriptions turned off
 * and you untick Description twenty-four times, once per row, because the panel
 * that held the tick was built fresh with the candidates. The decision is not a
 * per-row one — "I do not want scraped descriptions" is a thing you mean about
 * the pile — so it moved up to where the rest of the page's decisions live.
 *
 * In the address like the sources are, so it survives a reload and can be
 * linked. `all` is the spelling for every field, because an empty list already
 * means the default rather than nothing.
 */
const chosenFields = (params) => {
  const known = new Set(MATCH_FIELDS.map(([key]) => key));
  const named = (params.get('fields') || '').split(',').filter(Boolean);

  if (named.length === 1 && named[0] === 'all') return MATCH_FIELDS.map(([key]) => key);
  // Read back in MATCH_FIELDS order too, so a hand-edited address cannot make
  // the chip line disagree with itself about whether this is the default set.
  const kept = MATCH_FIELDS.map(([key]) => key).filter((k) => named.includes(k) && known.has(k));
  /*
   * `none` rather than an empty string, so "I unticked everything" survives a
   * reload as itself instead of coming back as the defaults. Filing no fields
   * is a real thing to want — the ids alone, with the metadata left as it is.
   */
  if (named.length === 1 && named[0] === 'none') return [];
  return kept.length ? kept : [...DEFAULT_FIELDS];
};

/*
 * The hosts the library's links point at. Asked once per visit and held, the
 * same way the sources are — it is a dropdown, and it is one query over every
 * scene's urls on the way in.
 */
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
   * Mutated, never replaced. The rows and the bulk bar close over this array
   * when they are built and read it at the moment you press Find, so changing
   * which sources are picked does not mean rebuilding either of them — which
   * is the whole reason the source chips no longer re-read the pile.
   */
  const picked = chosenSources(params, sources);

  /*
   * Which fields get written, shared by every row on the page. Mutated and
   * never replaced for the same reason `picked` is: the rows close over it when
   * they are built and read it at the moment you press File, so changing it
   * halfway down the pile changes what the next press does without rebuilding
   * anything.
   */
  const fields = chosenFields(params);

  // Whoever wants telling when the list changes. The bulk bar quotes the count
  // in its own line and would otherwise go on quoting the old one.
  const listeners = [];
  const onSources = (now) => { for (const fn of listeners) fn(now); };

  /*
   * Rows with a rename preview open, so it can be re-planned when the fields
   * change — unticking Title has to show in the name it is offering to write.
   * Each entry names the node it belongs to, and the detached ones are dropped
   * as they are found: a fresh find on a row replaces its panel, and the
   * watcher the old panel registered would otherwise go on firing forever.
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
    /*
     * Which box this pile is asking about, if any. Only when the pile is the
     * "missing" side of one — on the "has" side you are not giving up on
     * anything, and a set-aside there would be a decision about a scene that
     * already has the id.
     */
    const scoped = params.get('epq') === 'has'
      ? null
      : (sources.find((src) => src.kind === 'box' && src.endpoint === params.get('ep')) || null);

    renderMatchQueue(body, params, queue, picked, listeners, fields, watchers, scoped);
  } catch (err) {
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

/*
 * The panel is four decisions: which pile, which order, which words, which
 * sources. Changing any of them is a fresh read, so all four go through the
 * address — a queue you cannot link somebody to is a queue you cannot come back
 * to tomorrow either.
 */
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
    // A plain pile is only itself when no box has been named: "No stash id"
    // and "No TPDB id" are the same mode with and without an endpoint, and
    // lighting both would say the pile is two things at once.
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
   * The per-box piles, which are the question this library actually raises.
   *
   * "No stash id" is no id from anywhere, and it is the smaller and rarer
   * question — a scene StashDB knows and ThePornDB does not is matched by that
   * pile's reckoning and never appears in it. Asking one box at a time is how
   * you find those, and it is asked of the whole library rather than of the
   * pile, so the numbers are much larger.
   *
   * The dropdown below can already express this and will go on being the
   * general form — any box, either side of it. These two are the ones asked
   * every time, and a filter you use every session should not be three presses
   * into a picker.
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
   * How described a scene is, as a three-way rather than two chips.
   *
   * They are the two halves of one question and they cannot both be on, so a
   * pair of toggles would have had an unreachable fourth state and a rule
   * about it. A title, a studio and a date is the line: below it nobody has
   * been to the scene yet, above it somebody has.
   *
   * Both directions earn their place. "Missing something" is what you want on
   * the id and cover piles, where the described ones are most of what you page
   * past. "Fully described" is what you want on the unorganised pile, where
   * they are the 285 of 513 that are finished and simply have not been told
   * so — tick them and mark them, which is the one bulk action in here that is
   * genuinely safe.
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

  /*
   * The keyword reads the path — filename and every folder above it — because
   * on the scenes in these piles the path is usually the only description
   * there is. A title would have meant somebody had already been here.
   */
  const words = el('input', {
    type: 'search',
    className: 'facetinput',
    placeholder: 'A word in the path or filename…',
    value: params.get('q') || '',
    autocomplete: 'off',
  });
  words.onchange = () => set('q', words.value.trim(), '');
  words.onkeydown = (e) => { if (e.key === 'Enter') set('q', words.value.trim(), ''); };

  /*
   * Which box's id, and which side of it.
   *
   * "No stash id" is no id from anywhere, and the question this library
   * actually raises is narrower: *what has no ThePornDB id* — 1,615 scenes
   * against the pile's 302, because a scene with a StashDB id and no TPDB one
   * counts as matched and never appears. Naming a box asks that question
   * instead, of the whole library rather than of the pile.
   *
   * On the other two piles it simply narrows them, which is the more ordinary
   * use: the no-cover scenes that TPDB could still be asked about.
   *
   * Only stash-boxes are offered. A scraper has no endpoint to file an id
   * under, so there is nothing here for it to be missing.
   */
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

  /*
   * The same question for the sources that have no endpoint.
   *
   * A scraper cannot be asked about with the picker above, because a scraper
   * files no id — what it leaves on a scene is the URL it scraped from. So
   * this asks the link instead, and it is the only way to answer "which of
   * these has never been scraped from its own site".
   *
   * The hosts come from the scenes rather than from the installed scrapers:
   * there are a hundred and ninety of those and a couple of dozen of these,
   * and a list of scrapers that have never touched this library would be a
   * wall to read past for the one line that matters.
   */
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

  /*
   * "No link at all" already says which side it is on, and offering to invert
   * it would be a double negative nobody should have to read.
   */
  siteSide.disabled = !nowSite || nowSite === 'none';
  siteSide.onchange = () => set('siteq', siteSide.value, 'missing');

  /*
   * Which sources a find will ask, changed without re-reading anything.
   *
   * This used to go through `move()` like the pile and the ordering do, and it
   * should never have: those change *which scenes are in the list*, so they
   * rightly start again at page one. The source list changes nothing about the
   * list — it is what a row will ask when you press Find on it. Going through
   * the router meant that ticking a box on page nine of a pile threw you back
   * to page one of it, which is a long way to walk for a decision you had
   * already made.
   *
   * So the address is rewritten in place, the chips redraw themselves, and
   * `picked` is mutated rather than replaced — the rows closed over that array
   * when they were built and read it at the moment you press Find, so they see
   * the change without being rebuilt.
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

    /*
     * replaceState, not a navigation. The address stays honest — this is still
     * a queue you can link somebody to — but nothing is torn down and the page
     * you are on stays the page you are on.
     */
    params = next;
    history.replaceState(null, '', matchHash(next));

    drawSources();
    onSources?.(picked);
  };

  const toggle = (key) => setSources(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]);

  /* ------------------------------------------------------------ what to write
   *
   * The same decision the source chips are, about the other end of the press:
   * those say who gets asked, these say what gets kept from the answer.
   *
   * Global because that is how it is actually meant. Working down the
   * unmatched pile with scraped descriptions turned off used to mean unticking
   * Description on every row — twenty-four times a page, for a decision made
   * once. The ids are never optional and are not listed here; these are the
   * metadata that rides along with them.
   */
  const fieldLine = el('div', { className: 'controls fieldline' });

  const setFields = (list) => {
    /*
     * Put back into MATCH_FIELDS order before anything else looks at it.
     * Toggles append, so without this the list drifts into press order — which
     * makes the address untidy and, worse, makes "is this the default set?"
     * a string comparison that fails on a set that *is* the default.
     */
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

  /*
   * The boxes are chips and the scrapers are not.
   *
   * There are six boxes here and two hundred and thirty installed scrapers,
   * and the first cut drew all of them as chips — a wall you had to read to
   * find the one line that actually mattered. So the handful you use every
   * time stay one press away, and the long tail goes behind a picker that adds
   * one at a time. The ones you have added come back as chips, because by then
   * they are part of the short list too.
   */
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

  /*
   * What the pile currently means, in a sentence. It has to be said out loud
   * because naming a box changes the first pile into a different question
   * rather than narrowing it — and a page that quietly answered a question you
   * did not ask would be worse than one with no filter at all.
   */
  const said = (box && mode === 'unmatched'
    ? (nowSide === 'has'
      ? `Every scene that already carries a ${box.label} id, whatever else it has. Not a pile of work — a way of seeing what is covered.`
      : `Every scene with no ${box.label} id, including ones already matched somewhere else. Wider than the pile it replaces, and the “0” ids are not in it — a “0” is filed against no box at all.`)
    : mode === 'unmatched'
      ? 'Scenes with no usable stash-box id — including the ones a scraper filed a “0” against, unless you have already marked them organised.'
      : mode === 'nocover'
        ? `Scenes with no cover, which means scenes you cannot see anywhere else in here. A match brings the picture with it.${box ? ` Narrowed to the ones that ${nowSide === 'has' ? 'have' : 'have no'} ${box.label} id.` : ''}`
        : `Scenes Stash has not been told are finished. Tick the ones that belong together, tag them and call them done.${box ? ` Narrowed to the ones that ${nowSide === 'has' ? 'have' : 'have no'} ${box.label} id.` : ''}`)
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

/* -------------------------------------------------------- the missing phash
 *
 * The bar that explains why the rest of this page was so hard to use.
 *
 * A stash-box asked about a scene matches on fingerprints and nothing else. An
 * oshash is a hash of the file's bytes and only matches somebody holding the
 * byte-identical file — which does happen, and is why some of these rows do
 * answer on a fingerprint already. A phash is the frames, and it is the one
 * that survives a re-encode, a remux or a trim. Without one a scene has a
 * single brittle chance and then falls to a keyword guess.
 *
 * Measured 2026-09-12: every one of the 226 scenes in /pc-import had no phash,
 * against 59 of 60 in /organized_scenes. Generation had simply never been run
 * over the folder the work lives in, and there was nothing on this page that
 * would ever have told you so.
 *
 * The count is asked for after the queue is drawn rather than before it. It is
 * a read over the whole pile rather than one page of it, the rows are useful
 * without it, and a page that waits on a footnote is a page that feels broken.
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

  /*
   * The scenes you looked for and gave up on. Drawn here rather than in the
   * panel because this is where the count is known, and offered at all only
   * once there is one — a toggle for an empty set is a control that does
   * nothing and has to be read anyway.
   */
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

  // Said once, at the top, when Stash would not take the zero-id branch — the
  // pile is still right, it is just smaller than it should be.
  // Not when a box is named: that pile never asked for the zero ids, so their
  // absence is the design rather than something Stash refused.
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

/* ------------------------------------------------------------ the bulk bar
 *
 * The same two things the Tagger Bulk plugin adds to Stash's own Scene Tagger,
 * because the job is the same job and the muscle memory should be too: press
 * every row's search in turn, and edit every row's query at once.
 *
 * **Search All is sequential and it pauses.** Twenty-four rows times six
 * sources is a hundred and forty-four calls at somebody else's endpoints, and
 * firing those in parallel is how you get rate-limited off StashDB for the
 * afternoon. One row at a time, with a gap you can raise, and a Stop that takes
 * effect after the row in flight rather than abandoning it half-written.
 *
 * **Find and replace is the actual work.** The generated keyword is right about
 * half the time and wrong the same way down a whole folder — every filename
 * carrying the same release-group suffix, the same site prefix, the same
 * "1080p" the stripper missed. Fixing that twenty-four times by hand is the
 * thing this page was supposed to stop.
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

  /* --------------------------------------------------- giving up on a page
   *
   * The per-box piles are thousands of rows deep and most of a pass down one
   * ends the same way: you look, that box does not have it, and you press the
   * same chip on row after row. Ticking the rows and saying it once is the
   * same decision made once.
   *
   * **Only the rows you ticked.** Every other bulk press here reads the whole
   * page and this one will not, because it is the only one that writes
   * something you have to undo row by row. "Select all" is right there if the
   * whole page is what you mean.
   *
   * Two presses, and the second names the number and the box. It is not
   * destructive — one press on any row brings a scene back — but two dozen
   * scenes silently leaving a pile is the kind of thing you want to have
   * agreed to.
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

    /*
     * One at a time. Each is a read of the scene's tags and a write of them
     * back, and two dozen of those in parallel is two dozen chances to race
     * over the same tag list — which on a scene somebody has spent time
     * tagging is the worst thing this could do.
     */
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
   * Select all — beside the press that filled the page, because it is the
   * press you make next.
   *
   * Search All leaves two dozen rows each holding a list per box, best first,
   * and on a pile the boxes agree about the answer is the top row of every
   * one of those lists. Ticking them by hand is a press per box per row for
   * something the page already sorted.
   *
   * The first of *each* box rather than everything on a row, because the bands
   * are never merged: one id per box is the shape of a filing, and ticking
   * four StashDB rows would be offering a write that cannot happen.
   *
   * Only rows that answered. A row still waiting on a scraper has no firsts to
   * speak for, and is neither counted nor touched.
   *
   * One value across the whole pile rather than a toggle per row: a press up
   * here that ticked half of them and unticked the other half is nobody's idea
   * of select all. So it asks whether they are already all on, and the press is
   * the opposite of that answer, everywhere — which makes it its own undo.
   *
   * It does not write. File all ticked does that, and deliberately separately.
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
      // The run does not drag the page along with it. It used to scroll each
      // row into view as it reached it, which on a long pile meant the screen
      // moved under you every time an answer came back — you could not read
      // the row you were looking at. The counter above says where the run is;
      // that is enough, and it leaves you free to read anywhere in the pile
      // while it works.
      //
      // A row that throws is a row that said so in its own found area; the run
      // carries on, because one dead scraper must not end the other twenty.
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

  /*
   * Back to the keyword generated off the filename, which is where every box
   * started. The tagger's Reset blanks the field and lets Stash re-derive it;
   * ours puts the derived one back, because here it is the portal that derived
   * it and a blank box would just mean "search on nothing".
   */
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

/* ------------------------------------------------------------- filing the lot
 *
 * Search All fills a page with answers in one press and then leaves you to
 * make twenty-four more. Most of those presses are a formality: the row was
 * ticked by a fingerprint or by the picture pass, you scrolled past and agreed
 * with it, and the only thing standing between that and it being filed is your
 * finger.
 *
 * So this files every row that has something ticked, in row order, and reports
 * as it goes. It is deliberately **not** the same button as Search All: asking
 * is free and reversible, and writing to Stash is neither.
 *
 * Sequential, and a row that refuses does not end the run — these are writes
 * against your own Stash rather than somebody else's endpoint, so the pause is
 * only there to keep the counter readable.
 */
function fileAllBar(rows, box = null) {
  let running = false;
  let stopping = false;
  // The set-aside press has asked and is waiting for a yes. The counter below
  // must not run while it is, or the interval that keeps the tick count fresh
  // would wipe the question off the line it is asked on.
  let asking = false;

  const said = el('span', { className: 'muted small' }, '');
  const go = el('button', { className: 'add', type: 'button' }, 'File all ticked');

  /* ------------------------------------------- and the ones with no answer
   *
   * The other half of the same press. File all ticked clears the rows that
   * found something, and what is left on the page is the rows that did not —
   * which on a deep pile is most of them, and every one of those is the same
   * conclusion reached again: you looked, this box has not got it.
   *
   * So: the rows with nothing ticked, set aside in one press.
   *
   * **Only rows that have actually been asked.** A row nobody searched has
   * nothing ticked because nobody looked, and setting it aside would be
   * recording a decision that was never made — on the one pile where a wrong
   * "not here" hides the scene from the tool that could have finished it. Any
   * unasked rows are counted out loud rather than silently skipped, so the
   * number on the button and the number on the page agree.
   *
   * Two presses, like the bulk bar's. It is undone one row at a time, and two
   * dozen scenes leaving a pile is worth having agreed to.
   */
  const where = box ? shortHost(box.endpoint) : null;
  const asideGo = el('button', { className: 'chip', type: 'button' },
    where ? `Not on ${where}` : 'Not in Stash/TPDB');
  const asideYes = el('button', { className: 'chip danger', type: 'button', hidden: true }, 'Set them aside');
  const asideNo = el('button', { className: 'chip', type: 'button', hidden: true }, 'Cancel');

  asideGo.title = where
    ? `Set aside every row here that found nothing: you have looked and ${where} does not have them. They leave this pile and stay in the others.`
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
   * The ticks are made by three different things — a fingerprint on arrival,
   * the picture pass a moment later, and you — and none of them announce
   * themselves here. Rather than have all three report upwards, the bar counts
   * what is on screen whenever the page is touched.
   */
  const watch = () => {
    // Navigating away leaves these listeners bound to a document that no
    // longer holds the rows they are counting. Nothing tells a page here it
    // has been torn down, so the bar notices its own absence and lets go.
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

  /*
   * One at a time, for the reason the bulk bar gives: each is a read of the
   * scene's tags and a write of them back, and doing those in parallel is a
   * race over the same tag list.
   */
  asideYes.onclick = async () => {
    const list = empties();
    asideYes.disabled = true;
    asideNo.disabled = true;
    // Filing and setting aside are both writes over the same rows, so the one
    // that is not running is shut for the duration rather than left to be
    // pressed into the middle of it.
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

/* -------------------------------------------------------------- renaming
 *
 * The natural end of a match, and only in pc-import.
 *
 * You find the scene, file the ids, take the title and studio and date across
 * — and the file on disk is still called whatever you were guessing from. This
 * renames it to `Studio.YYYY-MM-DD.Title`, which is the shape the rest of the
 * library already uses and the shape the filename parser reads best, so a file
 * renamed here comes back through this page cleaner than it left.
 *
 * **Asked for, one at a time, after you have read what it will say.** There is
 * no bulk rename and there is not going to be one. A plugin went through
 * pc-import on 2026-09-12 renaming 456 files unattended and dropped the
 * performer's name off ninety-odd of them; the whole value of this button is
 * that it is a button.
 *
 * The scope is enforced on the server against the resolved path, not here — a
 * row that offered the wrong thing would then be a bug in a filename rather
 * than a bug in the page. This only asks whether the offer exists.
 */
/*
 * Giving up on one, on purpose.
 *
 * "No stash id" assumes every scene has an answer waiting somewhere and plenty
 * do not — an obscure rip, a site that folded, something amateur. Those sat in
 * the pile permanently, and a pile with a permanent floor is one you stop
 * reading, which costs you the scenes underneath it that *do* have an answer.
 *
 * It writes a tag rather than setting organised, because they are different
 * facts: a scene can be catalogued to your satisfaction and still want an id,
 * and one that will never have an id may be nowhere near finished. The tag
 * shows on the scene in Stash, and one press takes it off again.
 */
/*
 * A stash-box's endpoint, as short as it can be said. Matches how matchsort
 * spells the same box in the tag it writes.
 */
const shortHost = (endpoint) => {
  try { return new URL(endpoint).host.replace(/^www\./, ''); } catch { return String(endpoint || ''); }
};

function asideBit(scene, row, box = null, asideTag = '') {
  const said = el('span', { className: 'muted small' }, '');

  /*
   * What the press actually claims, which is not the same on every pile.
   *
   * On "No stash id" you have asked everything and nothing had it, and the
   * scene should leave every pile. On "No TPDB id" you have asked TPDB — and
   * learned nothing at all about StashDB, where this scene may well have an
   * answer waiting. Saying "not on any box" there would be filing a decision
   * you did not make, and it would hide the scene from the pile that could
   * still finish it.
   */
  /*
   * The host, not the box's label. A stash-box names itself with its whole
   * endpoint — "https://stashdb.org/graphql" — and a chip is not the place for
   * it. The tag Stash ends up carrying is spelled the same way, off the same
   * host, so the button and the tag agree.
   */
  const where = box ? shortHost(box.endpoint) : null;

  const put = el('button', { className: 'chip', type: 'button' },
    where ? `Not on ${where}` : 'Not on any box');

  put.title = where
    ? `Set aside for ${where} only: you have looked and it does not have this. It leaves this pile and stays in the others.`
    : 'Set aside: you have looked, and no stash-box has this. It leaves every pile until you ask for it back.';

  /*
   * Whether this one is already set aside, read off the tags the scene came
   * with rather than assumed to be no.
   *
   * This was always wrong and only became visible once there was a way to look
   * at the set-aside ones: the row drew "Not on theporndb.net" on a scene that
   * already carried exactly that tag, offering to do a thing it had done. The
   * name comes from the queue, so the two ends cannot disagree about spelling.
   */
  let on = Boolean(asideTag) && (scene.tags || []).some((t) => t.name === asideTag);

  const draw = () => {
    put.textContent = on ? 'Bring it back' : (where ? `Not on ${where}` : 'Not on any box');
    put.classList.toggle('on', on);
    row.classList.toggle('setaside', on);
  };

  /*
   * The press, as a function, so the bar above can make it too.
   *
   * Bulk goes through this rather than posting on its own: the row has to end
   * up saying what happened to it, and a bar that wrote behind the row's back
   * would leave two dozen buttons all still offering to do a thing they had
   * already done.
   */
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
      // The row stays put rather than vanishing. It leaves the pile on the
      // next read, and a row that disappeared under the cursor would take the
      // undo with it.
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

/*
 * A refused rename is a sentence, not a failure. The ids were filed either way,
 * and the filing is the thing that was worth the trip.
 */
function renameSaid(out) {
  if (!out) return '';
  if (!out.ok) return ` The file was left alone: ${out.why}`;
  return ` Renamed to ${out.to.split('/').pop()}.`
    + (out.scanned ? '' : ' Stash would not rescan, so its path is stale until it does.');
}

/*
 * What became of the file when the press marked it organised.
 *
 * Ticking "Mark organised" moves the file into /organized_scenes now, and a
 * move that did not happen has to say so here — this is the page the marking
 * is done from, and a silent failure leaves a record saying filed over a file
 * that never went anywhere. A scene already in /organized_scenes is the
 * ordinary case and says nothing.
 *
 * The time is only worth showing when it was long enough to have noticed.
 * Filing off the share is a rename the Mac does to itself and comes back in
 * a fraction of a second; filing out of /pc-import is a real copy across the
 * network, and that is the one you want the number for.
 */
function filedSaid(out) {
  if (!out || out.already) return '';
  if (!out.ok) return ` Marked organised, but the file did not move: ${out.why}`;

  const where = out.to.split('/').slice(0, -1).pop();
  const slow = out.how === 'copy' && out.ms > 1500 ? ` (copied in ${Math.round(out.ms / 1000)}s)` : '';
  return ` Filed into ${where}.${slow}`
    + (out.scanned ? '' : ' Stash would not rescan, so its path is stale until it does.');
}

/* ------------------------------------------------------------- deleting
 *
 * The one irreversible thing on this page, and it is here because this is
 * where you find out you do not want the file.
 *
 * Working down the unmatched pile, a good proportion of what is left is not a
 * scene nobody has identified — it is a trailer, a sample, a duplicate at a
 * worse bitrate, or something that was never worth keeping. Leaving the page
 * to go and delete one in Stash is enough friction that they stay in the pile
 * instead, and a pile with a permanent floor is one you stop reading. Same
 * argument "Not on any box" makes, with a different answer.
 *
 * **It is the scene page's delete, not a second one.** Same two routes, same
 * three separate opt-ins, same rule that the file is ticked and the galleries
 * are not. A delete that behaved differently depending on which page you
 * pressed it from would be the kind of difference nobody discovers until it
 * has cost them something.
 *
 * Two presses, and the second one names what it is taking rather than asking
 * whether you are sure. The list is the warning.
 */
function deleteBit(scene, row) {
  const said = el('span', { className: 'muted small' }, '');

  const start = el('button', { className: 'chip danger', type: 'button' }, 'Delete…');
  start.title = 'Delete this scene from Stash, and its file.';

  const yes = el('button', { className: 'chip danger', type: 'button', hidden: true }, 'Delete permanently');
  const keep = el('button', { className: 'chip', type: 'button', hidden: true }, 'Keep it');

  /*
   * The file is ticked and the galleries are not, which is the scene page's
   * rule and is not arbitrary: a scene taken out of Stash with its file still
   * under a library path comes back on the next scan, so a record-only delete
   * mostly undoes itself. A photo set is its own thing that happens to be tied
   * to this scene, so that one is a decision.
   */
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

    /*
     * Back to the documented defaults every time this opens, rather than
     * carrying over the last pass. Backing out and pressing again is how you
     * restart a decision, and the file box in particular has a reason to be
     * ticked — a record-only delete mostly undoes itself on the next scan.
     * Inheriting a previous untick would leave that switched off with only the
     * warning line to say so.
     */
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
      /*
       * The row stays put rather than vanishing, the same way a set-aside row
       * does. It leaves the pile on the next read, and a row that disappeared
       * under the cursor would take the next row up to meet your finger.
       */
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
  // Nothing to offer on a file the renamer will refuse anyway. Asked of the
  // path rather than of the server, so twenty-four rows are not twenty-four
  // requests to be told no.
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
   * The keyword the find will search on. It arrives generated off the filename
   * — stripped of the resolution and the codec, which are about the file rather
   * than the scene — and it is a box rather than a label because the generated
   * guess is wrong often enough that retyping it is the actual work.
   */
  const term = el('input', {
    type: 'text',
    className: 'facetinput termbox',
    placeholder: 'Search words…',
    value: scene.term || '',
    autocomplete: 'off',
  });

  const look = el('button', { className: 'add', type: 'button' }, 'Find it');

  /*
   * What this row would file, once it has candidates and something is ticked.
   * Set by renderCandidates and replaced on every fresh find, because the old
   * one closes over picks that are no longer on screen.
   */
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

  /*
   * What the filename was read as, said on the row.
   *
   * The search box above holds the *title* now rather than the whole basename,
   * and that is a big enough change to owe an explanation — a box that quietly
   * dropped half the filename would look like a bug. It also says the thing
   * worth knowing before you press: a name read as a DVD is a name StashDB
   * cannot answer, however it is spelled, because StashDB indexes scenes.
   */
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

  /*
   * Where the compare sheet goes, and it has to be here rather than down in
   * `found` with everything else the find produces.
   *
   * The row is a four-column grid and `found` sits in the third of them, which
   * on a full window is 571px of 1144 — the picture, the search box and the
   * buttons have the rest. A sheet whose entire job is showing pictures side
   * by side cannot live in half a row: at that width its grid fits exactly one
   * tile and it reads as a column. As a direct child of the row it can span
   * all four columns and get the whole width.
   */
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

  /*
   * Rename and set-aside sit under the path, because both are statements about
   * the scene you are reading. Delete does not: it goes to the foot of the
   * actions column, away from the two chips you press while working a row and
   * as far from the one you never mean to press as the row allows.
   */
  const aside = asideBit(scene, row, box, asideTag);
  const bits = [renameBit(scene, row), aside.node].filter(Boolean);
  if (bits.length) rename.replaceChildren(...bits);

  actions.append(deleteBit(scene, row));

  /*
   * The row, and the handful of things the bar above needs to do to it. A
   * controller rather than a node, because Search All is the same press as
   * Find it — it just makes it for you, one row at a time — and the bar should
   * not be reaching into somebody else's DOM to do that.
   */
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
 * The picture, asked for by scene rather than by address.
 *
 * Stash answers a missing cover with a 200 and a 733-byte SVG placeholder, so
 * the front end cannot tell an empty row from a full one — no 404, no onerror,
 * nothing to hang a fallback off. The portal can, so it decides: the real cover
 * when there is one, a frame cut out of the file when there is not.
 *
 * The double-click is the escape hatch for the covers that exist and are
 * useless — a black frame, a studio card. It cuts one anyway.
 */
function sceneArt(scene) {
  const src = `/media/scene/${scene.id}/thumb`;
  const art = el('img', { className: 'art', src, loading: 'lazy', alt: '', title: 'Double-click for a fresh frame' });

  art.ondblclick = () => {
    art.classList.add('cutting');
    art.src = `${src}?force=1&at=${Date.now()}`;
  };
  art.onload = () => art.classList.remove('cutting');

  /*
   * Wrapped, so the row's picture behaves like a tile on a shelf: hover and
   * the preview loop plays, run along the bottom of it and you scrub the whole
   * runtime. On a pile you are trying to recognise, one still frame was never
   * going to be enough — and a scene that has neither a preview nor sprites is
   * exactly what the Generate button beside it is for.
   */
  return { node: liveArt(scene.id, art), img: art };
}

/*
 * What the sources think it is.
 *
 * One band per source, never merged. Two boxes describing the same scene
 * disagree about the title often enough that a blended row would be a row
 * nobody wrote — and the ids are why you are here. You want StashDB's answer
 * and TPDB's answer side by side, tick both, and file both.
 *
 * A fingerprint hit needs no judgement: it is the same frames. A title hit is a
 * guess and is labelled one, which is why they are drawn the same but say
 * different things.
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

  /*
   * Read at the moment you press, never copied. The chips at the top of the
   * page mutate `fields` in place, so a row built ten minutes ago files what
   * the page says now rather than what it said when the row was drawn.
   */
  const wants = () => new Set(fields);
  const picks = new Map(); // key -> the match itself, in tick order

  /*
   * What actually goes up the wire.
   *
   * A candidate's cover arrives from Stash's scrapers as a base64 data URI, not
   * a link, and a 1080p one is most of a megabyte. The write only ever uses the
   * first cover it finds, in tick order, and the rename preview never uses one
   * at all — so sending every picked source's picture was sending megabytes to
   * be thrown away, and on two or three ticked sources it was the whole reason
   * the body came back too large.
   *
   * `trim` keeps the first picture when the cover box is ticked and drops the
   * rest. `bones` is the rename preview's version: the three fields a filename
   * is made of, and nothing else.
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

  /* ------------------------------------------------- renaming with the filing
   *
   * Same shape as Wild Card: a tick beside the write, ticked for you, with the
   * name it will write sitting next to it.
   *
   * The name is planned against the picks you have ticked and the fields you
   * have left ticked — not against what Stash holds — so it is the name the
   * scene is about to deserve rather than the one the file arrived with. Untick
   * Title and the preview goes back to the old title, because that is what the
   * write will actually do.
   *
   * This does not make the rename unattended. The 2026-09-12 plugin renamed 456
   * files nobody was looking at; this is one row, with its new name on screen,
   * under a button you pressed. The standalone "Rename file…" further up the
   * row stays for the other case — a scene that is already filed and only wants
   * a better filename.
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

  // Set once the bands are drawn, below. Declared up here because redraw runs
  // on every tick and has to keep the select-all button's label honest, and a
  // tick can happen before there is anything for it to count.
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

      /*
       * Filing collapses a tall candidate list into one line, and that pulls
       * the page out from under you: by the time you press the button you are
       * usually scrolled down among the covers, so the row's own top is above
       * the viewport. Shrink it and the document gets shorter, the browser
       * clamps the scroll to the new bottom, and the screen lurches back up
       * to somewhere you were not reading.
       *
       * So the row is pinned. Where its top sat before the swap is where it
       * sits after — measured, not guessed, because how much the row loses
       * depends on how many candidates were on it. If the document is now too
       * short to hold that position the browser clamps anyway, and the row is
       * still the thing on screen.
       */
      const was = row.getBoundingClientRect().top;
      const hold = () => {
        const now = row.getBoundingClientRect().top;
        if (now !== was) window.scrollBy({ top: now - was, behavior: 'instant' });
      };

      row.classList.add('matched');
      /*
       * "No id could be filed" is the right sentence when you asked a stash-box
       * and it had nothing. It is the wrong one when every pick was a page the
       * scene already linked to — those never carried an id to file, and the
       * metadata was the whole point of the press.
       */
      const onlyLinks = [...picks.values()].every((p) => p.source === 'links');
      const filed = saved.ids.length
        ? `Filed ${saved.ids.length} id${saved.ids.length === 1 ? '' : 's'}. `
        : onlyLinks
          ? 'Read off the links this scene already had. '
          : 'No id could be filed. ';

      /*
       * Anything this press had to make, before what it left alone. A studio
       * or a performer appearing in the library is the one part of filing that
       * is not undone by re-filing, so it is said first and by name.
       */
      const made = (saved.created || []).length
        ? 'Made ' + saved.created.join(', ') + '. '
        : '';

      found.replaceChildren(el('div', { className: 'muted small' },
        filed + made + (saved.skipped.length
          ? 'Left alone: ' + saved.skipped.join(', ') + '.'
          : 'Everything ticked came across.')
        + renameSaid(saved.renamed) + filedSaid(saved.filed)));

      // The row's own path line is now wrong, and the row is not redrawn until
      // the pile is. Filing moves the file further than a rename does, so it
      // wins where a press did both.
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

  /*
   * The row's own button shouts; File All above catches the throw itself and
   * carries on down the list, because one refused write must not end the run.
   */
  apply.onclick = () => fileThese().catch((err) => alert(err.message));
  onFiler?.({
    count: () => picks.size,
    run: fileThese,
    /*
     * The select-all press, made from above.
     *
     * Set to a value rather than toggled, because one press on the bar has to
     * mean the same thing on every row — a toggle per row would tick the ones
     * that were off and untick the ones that were on, which is not what
     * anybody pressing a bar button is asking for.
     */
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

  /*
   * The index sheet, for when the bands are four titles that all look plausible
   * and the only thing that separates them is the picture — which is most of
   * what a keyword search returns. Opened on request rather than always: it
   * cuts frames off the file, and doing that for every row of a Search All
   * would be two dozen ffmpegs nobody asked for.
   */
  /*
   * Select all: the top answer in every box, in one press.
   *
   * Every source is asked at once and each one comes back with its own list,
   * best first — so on a scene the boxes agree about, the thing you want is
   * the first row of each band and nothing else. Ticking those by hand is one
   * press per box for an answer the page already sorted.
   *
   * The first of *each* band rather than everything on screen, because the
   * bands are never merged: one id per box is the whole shape of a filing, and
   * a select-all that ticked four StashDB rows would be offering a write that
   * cannot happen.
   *
   * It unticks as well. When those firsts are already the ticks, the press
   * takes them back off — otherwise the only way out of a wrong press is four
   * right ones.
   *
   * Anything ticked below a first — by the picture pass, or by you — is left
   * exactly as it is. This button speaks for the top row of each band and for
   * nothing else.
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

  /*
   * Filtered, because this is replaceChildren and not el(): el() drops a null
   * child and the DOM's own method stringifies it, so every row outside
   * pc-import — where there is no rename to offer — was drawing the word
   * "null" under its buttons.
   */
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

  /*
   * The pictures are compared after the rows are on screen rather than before.
   * Decoding a dozen of them is tens of milliseconds, but it is tens of
   * milliseconds of nothing to look at, and the rows are useful the instant
   * they are drawn. Ticks arrive a moment later.
   */
  pickByLooks(scene.id, drawn).catch(() => {});

  // What "skip rows that already answered" reads. Set here rather than counted
  // off the DOM, so a row that answered with nothing is not mistaken for one
  // that was never asked.
  found.dataset.answered = '1';

  // Title, Date and Studio are the filename, so a change to them at the top of
  // the page has to show in the name this row is offering to write.
  if (home) watchers.push({ node: found, run: replan });

  redraw();
}

/* ------------------------------------------------------- looking alike
 *
 * Ticking the candidate whose artwork is this scene's artwork.
 *
 * A fingerprint hit is ticked already and needs nothing from this — it is the
 * same frames, which is the strongest thing either end can say. The trouble is
 * everything else: a box asked by scene id that knows nothing about these
 * frames falls back to a keyword, and a keyword returns four or eight titles
 * that are all "possible" and all look identical in a list. Reading them meant
 * looking at the pictures, and if a person can decide it by looking then so
 * can the page.
 *
 * It is a difference hash — the picture reduced to nine by eight greys, each
 * pixel compared with the one to its right, sixty-four bits. Tolerant of the
 * things that differ between two copies of the same artwork (size, crop at the
 * edges, JPEG quality, brightness) and not of the things that differ between
 * two different pictures.
 *
 * **Measured on this library before it was built**, because the alternative
 * was a threshold pulled out of the air. Against Stash's own cover, correct
 * candidates scored 0, 0, 7, 7 and 18; every wrong candidate across the same
 * scenes scored 25 or more and most sat in the 30s — a 64-bit hash of two
 * unrelated pictures averages 32, which is to say the wrong ones are
 * indistinguishable from noise and the right one is nowhere near it.
 *
 * So the line is drawn at 20: above anything a correct answer has scored here,
 * below everything a wrong one has. The margin on the wrong side is five bits
 * and worth knowing about — if a wrong answer ever does get ticked, this
 * number is why, and it should come down rather than the idea being abandoned.
 *
 * **Measure it in a browser if you change it.** The first pass at this was
 * calibrated with ffmpeg and the numbers did not carry: the same correct
 * candidate measured 12 there and 18 here, because the two downscalers are not
 * the same downscaler. The comparison runs in the browser, so the browser is
 * where the threshold has to be read.
 *
 * **And one thing it deliberately cannot do.** A scene with no cover of its
 * own is drawn with a frame cut out of the file, and promotional artwork is
 * not a frame from the video: measured against those, the right candidate
 * scored 31 to 40 — no better than the wrong ones. Nor does it help when a
 * box's artwork is simply a different picture of the same scene, which is
 * real: one scene's correct TPDB answer measured 34. There is no signal in
 * either case and this does not pretend otherwise; nothing gets ticked, which
 * is the honest answer rather than a coin toss.
 */

const LOOKS_CLOSE = 20;

// 9x8 greys, then each pixel against its right-hand neighbour.
const HASH_W = 9;
const HASH_H = 8;

/*
 * -> 64 bits, or null if the picture cannot be read.
 *
 * Null covers every way this can fail and they are all the same answer: no
 * image, a load that never completed, a canvas the browser will not let us
 * read back. StashDB serves its artwork with `Access-Control-Allow-Origin: *`
 * and the boxes hand theirs over as data URIs, so neither taints the canvas —
 * but a source that did would land here rather than throwing, and its band
 * would simply not be ticked.
 */
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

/*
 * One tick per source at most, and only where the picture says so.
 *
 * Per band rather than across all of them, because a scene has an id on each
 * box and the bands are deliberately never merged — the answer to "which
 * StashDB scene is this" has no bearing on which TPDB one it is.
 *
 * A band that already has something ticked is left alone: that tick came off a
 * fingerprint, and a picture does not get to argue with frames.
 */
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

/*
 * One candidate, with a tick rather than a button. The tick is the difference
 * this page is for: a scene is one thing but it has an id on each box, and the
 * old single-press row could only ever say which one of them you meant.
 */
function candidateRow(match, picks, redraw, sure, sceneId = null) {
  /*
   * An exact hit is ticked already. It came off a fingerprint, which is the
   * same frames rather than the same words, and the reason both boxes are asked
   * at once is that both of them normally have one — leaving you to tick two
   * certainties by hand would be the page asking you to agree with arithmetic.
   * Everything less than exact stays untouched.
   */
  const box = el('input', { type: 'checkbox', checked: Boolean(sure) });
  if (sure) picks.set(match.key, match);

  box.onchange = () => {
    if (box.checked) picks.set(match.key, match);
    else picks.delete(match.key);
    line.classList.toggle('on', box.checked);
    redraw();
  };

  // Why it was ticked, when it was not a person who ticked it. Added rather
  // than drawn up front, because until the pictures have been compared there
  // is nothing to say.
  const why = el('span', { className: 'badge looksame', hidden: true }, 'same picture');

  /*
   * Ticked by the picture pass. It goes through the same three steps a press
   * does — the box, the map, the class — because a tick that only looked
   * ticked would be applied to nothing.
   */
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
   * Picture first and at the size of the scene's own, because the comparison
   * this row is asking you to make is between two pictures.
   *
   * The candidate art used to be 72 wide and sat at the far end of the row,
   * which put it as far from the scene's 176-wide frame as the layout allowed
   * and shrank it to the point where two blondes on a sofa are the same
   * photograph. They are the same size and side by side now — the scene's on
   * the row, the candidate's under it — and the tick has the other end of the
   * row to itself.
   *
   * A candidate with no artwork still takes the column. A row that shuffled
   * left when a source had no picture would break the one alignment the whole
   * band depends on.
   */
  const art = match.image
    ? el('img', { className: 'pickart', src: match.image, loading: 'lazy', alt: '' })
    : el('div', { className: 'pickart none' }, el('span', { className: 'muted small' }, 'no art'));

  /* ----------------------------------------------------- reading its page
   *
   * A search result is thin and the page behind it is not. Bang's search gives
   * a title, a date and a cover and calls it done; its page has the cast and
   * the tags. Filing the search result throws those away without ever showing
   * you they existed.
   *
   * Merged into the candidate rather than drawn somewhere else, because this
   * row *is* what gets filed — `picks` holds this very object, so what the page
   * adds is filed by a tick that was made before the read. Anything the page is
   * quiet about keeps the search's answer: a fuller record, never a shorter
   * one.
   */
  const readBit = el('span', { className: 'readbit' });

  /*
   * Only on a scraper's answer, because that is the only place the problem is.
   *
   * A stash-box answers from its own record and hands back everything it has —
   * there is no thinner version of a StashDB hit to fill in. Its `url` is a
   * stashdb.org page no scraper claims, so offering the button there produced
   * nothing but "index out of range" from Stash. A link the scene already had
   * has been read by definition. That leaves the scrapers, which is exactly the
   * set that answers a NAME search with a title and a cover and calls it done.
   */
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

        /*
         * Only where the page actually said something. A scraper that answers a
         * page with an empty field must not blank a field the search filled.
         */
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

  // What pickByLooks needs of a row: what it is offering, whether it is
  // already spoken for, and the way to tick it.
  // What the picture pass and the compare sheet each need of a row: what it is
  // offering, whether it is spoken for, a way to tick it by measurement, and a
  // way to toggle it the way a press would.
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

/*
 * The cards on the unorganised pile, and the handful of them the bar above
 * needs to drive. A controller rather than a bare node, for the same reason
 * the match rows are one: "select all" is the same press as clicking each
 * card, and the bar should not be reaching into somebody else's DOM to make
 * twenty-four of them.
 */
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

/*
 * Tags Stash already has, never new ones — a page that lets you type a tag into
 * a batch write is a page that grows a second tag with a trailing space.
 *
 * Organised rides along with the tags rather than having a bar of its own,
 * because on this pile they are the same press: you tick the scenes that are
 * done, say what they are, and say they are done.
 */
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

  /*
   * All of them, or none.
   *
   * The point of the "has title, studio and date" filter above: on that pile
   * every scene on the page is one you were going to tick anyway, and ticking
   * twenty-four things you have already decided about is not a decision, it is
   * a chore. It only ever covers the page in front of you — a select-all that
   * silently included the other eleven pages would be a bulk write nobody
   * looked at.
   */
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
