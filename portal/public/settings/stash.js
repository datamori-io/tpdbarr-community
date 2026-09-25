/* Manage › Stash: jobs you ask Stash (or the portal) to run. */

import { api, el } from '../util.js';
import { state } from '../import/core.js';
import { shell } from './core.js';

export const SECTION = '#/parameters/stash';

const n = (v) => (typeof v === 'number' ? v.toLocaleString() : '—');

export async function showStash(paint) {
  const title = 'Stash';
  const note = 'jobs Stash runs for you — they carry on if you leave';

  if (!state?.stash?.enabled) {
    shell(paint, SECTION, title, note,
      el('div', { className: 'empty' }, 'This works on your Stash library. Connect it in Connections.'));
    return;
  }

  shell(paint, SECTION, title, note, el('div', { className: 'empty' }, 'Counting the library…'));

  try {
    const [{ totals }, prints] = await Promise.all([
      api('/api/catalogue/overview'),
      // Whether a generate is in flight, which changes what the fingerprint
      // card is allowed to offer. Its failure is not worth losing the page over.
      api('/api/import/match/phash?mode=unmatched').catch(() => null),
    ]);
    shell(paint, SECTION, title, note,
      el('div', { className: 'jobrow' },
        scan(), organizedScan(), fingerprints(totals, prints),
        media(), reshelve(), sidecar('nfo'), sidecar('thumbs')),
      duplicates());
  } catch (err) {
    shell(paint, SECTION, title, note, el('div', { className: 'empty' }, err.message));
  }
}

/*
 * A Stash job card. Returns a job id and polls; copes with a job already
 * running (Stash would queue a duplicate). Drawn first, status asked after.
 */
function jobCard({ title, hint, label, idle, endpoint, doing, done }) {
  const said = el('span', { className: 'muted small' }, 'Checking with Stash…');
  const go = el('button', { className: 'add', type: 'button', hidden: true }, label);

  const card = el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('strong', {}, title),
      el('span', { className: 'muted small' }, hint)),
    // `jobline` rather than a plain controls row: the button and what it does
    // stay on the same line whatever the length of the sentence. See the CSS.
    el('div', { className: 'controls jobline' }, go, said)
  );

  let timer = null;

  const watch = async (id) => {
    // The page may well have been left. Nothing here is worth a request once
    // the card is off the document — the job carries on in Stash regardless.
    if (!card.isConnected) { clearInterval(timer); return; }

    const { job } = await api(`${endpoint}/${id}`).catch(() => ({ job: null }));
    if (!job) return;

    const pct = typeof job.progress === 'number' ? ` — ${Math.round(job.progress * 100)}%` : '';
    said.textContent = job.over
      ? (job.error ? 'Stash could not finish: ' + job.error : done)
      : `${doing}${pct}. You can leave this page; it carries on.`;

    if (job.over) {
      clearInterval(timer);
      go.hidden = false;
      go.disabled = false;
      go.textContent = 'Run it again';
    }
  };

  const follow = (id) => {
    if (!id) return;
    watch(id);
    // Poll every four seconds.
    timer = setInterval(() => watch(id), 4000);
  };

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = 'Asking Stash…';
    try {
      const started = await api(endpoint, { method: 'POST' });
      go.hidden = true;
      if (!started.started) {
        said.textContent = started.why || 'Nothing to do.';
        follow(started.job?.id);
        return;
      }
      said.textContent = `${doing}${started.scenes ? ` over ${n(started.scenes)} scenes` : ''}. `
        + 'You can leave this page; it carries on.';
      follow(started.job);
    } catch (err) {
      go.disabled = false;
      go.textContent = label;
      said.textContent = err.message;
    }
  };

  api(endpoint).then((now) => {
    if (now.running) {
      said.textContent = `Stash is already busy: ${now.running.description || 'a job is running'}.`;
      follow(now.running.id);
      return;
    }
    said.textContent = idle;
    go.hidden = false;
  }).catch((err) => { said.textContent = err.message; });

  return card;
}

/*
 * Scan the three arrival folders (see SCAN_PATHS in catalogue.mjs),
 * generating covers and phashes on the way in.
 */
const scan = () => jobCard({
  title: 'The library on disk',
  hint: 'the Catalogue counts are only as fresh as the last scan',
  label: 'Scan for new files',
  endpoint: '/api/catalogue/scan',
  doing: 'Stash is scanning',
  done: 'Scan finished. Reload the page to count what it found.',
  idle: 'New files are invisible to everything here until Stash has walked the folders. '
    + 'Only the three a scene arrives in — /pc-import, /Import Folder and /movies — so this is '
    + 'minutes rather than the whole library. Covers and phashes are made for anything it finds.',
});

/* Previews, sprites, image and clip previews, for /organized_scenes only. Hours. */
const media = () => jobCard({
  title: 'Previews and sprites',
  hint: 'the heavy ones — hovering on a shelf, scrubbing on a page',
  label: 'Generate previews and sprites',
  endpoint: '/api/catalogue/generate',
  doing: 'Stash is generating',
  done: 'Generating finished. Shelves hover and pages scrub.',
  idle: 'Previews, sprites, image previews and clip previews for filed scenes missing them. '
    + 'Only /organized_scenes, nothing already made is touched, and it is hours rather than minutes.',
});

/* Fingerprints: without a phash, a scene only matches a byte-identical file. */
function fingerprints(totals, prints) {
  const said = el('span', { className: 'muted small' }, '');
  const go = el('button', { className: 'add', type: 'button', hidden: true }, 'Generate the missing ones');

  if (!totals.noPhash) {
    said.textContent = 'Every scene has a phash. Match can recognise anything the boxes know.';
  } else if (prints?.running) {
    said.textContent = `Stash is generating them now — ${prints.running.description || 'a generate is running'}. `
      + `${n(totals.noPhash)} still to go, and the number falls as it works.`;
  } else {
    said.textContent = `${n(totals.noPhash)} scenes have no phash, so the boxes cannot recognise them by their `
      + 'frames and every find on them is a keyword guess.';
    go.hidden = false;
  }

  /* The whole library, unlike Match's button, which is scoped to the pile. */
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = 'Asking Stash…';
    try {
      const started = await api('/api/import/match/phash?mode=unorganized', { method: 'POST' });
      go.hidden = true;
      said.textContent = started.started
        ? `Generating for ${n(started.scenes)} scenes. It runs in Stash and survives you closing this.`
        : started.why || 'Nothing to do.';
    } catch (err) {
      go.disabled = false;
      go.textContent = 'Generate the missing ones';
      said.textContent = err.message;
    }
  };

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('strong', {}, 'Fingerprints'),
      el('span', { className: 'muted small' }, 'why matching works or does not')),
    // `jobline` rather than a plain controls row: the button and what it does
    // stay on the same line whatever the length of the sentence. See the CSS.
    el('div', { className: 'controls jobline' }, go, said)
  );
}

/* Scan /organized_scenes alone, after a re-shelve or a manual move. */
const organizedScan = () => jobCard({
  title: 'Organized folder',
  hint: 'the filed library, walked on its own',
  label: 'Scan organized',
  endpoint: '/api/manage/scan',
  doing: 'Stash is scanning /organized_scenes',
  done: 'Scan finished. Stash has caught up with the organized folder.',
  idle: 'Walks /organized_scenes only. Moved files are found by fingerprint and keep their scene, '
    + 'so nothing is imported twice. Longer than the arrival scan — it is the whole library.',
});

/*
 * ------------------------------------------------------------ the chores
 *
 * Rename, nfo and thumbnails: the portal's own loops, one at a time. Every
 * chore card shows the shared run.
 */
const choreCards = new Set();
let choreTimer = null;

function watchChores() {
  if (choreTimer) return;
  const tick = async () => {
    for (const card of choreCards) if (!card.node.isConnected) choreCards.delete(card);
    if (!choreCards.size) { clearInterval(choreTimer); choreTimer = null; return; }
    const { run } = await api('/api/manage/chores').catch(() => ({ run: null }));
    for (const card of choreCards) card.update(run);
  };
  // After the cards are on the page, or the first tick finds none connected.
  setTimeout(tick, 0);
  choreTimer = setInterval(tick, 2500);
}

function progressLine(run, changedWord) {
  const failed = run.failedCount ? `, ${n(run.failedCount)} failed` : '';
  return `${n(run.done)} of ${n(run.total)} — ${n(run.changed)} ${changedWord}, ${n(run.skipped)} left as they were${failed}`;
}

function failures(run) {
  if (!run.failed?.length) return null;
  return el('details', { className: 'small' },
    el('summary', { className: 'muted' }, `${n(run.failedCount)} failed — the last few`),
    el('ul', { className: 'muted small' }, run.failed.map((f) =>
      el('li', {}, el('a', { href: `#/library/scene/${f.id}` }, f.title || `scene ${f.id}`), ` — ${f.why}`))));
}

/* One chore card, kept current by the shared poll. */
function choreCard({ title, hint, idle, kinds, changedWord, buttons }) {
  const said = el('span', { className: 'muted small' }, idle);
  const extra = el('div', {});
  const halt = el('button', { className: 'chip', type: 'button', hidden: true }, 'Stop');
  const row = el('div', { className: 'controls jobline' }, ...buttons, halt, said);

  const node = el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('strong', {}, title),
      el('span', { className: 'muted small' }, hint)),
    row, extra);

  halt.onclick = async () => {
    halt.disabled = true;
    await api('/api/manage/chores/stop', { method: 'POST' }).catch(() => null);
  };

  const card = {
    node,
    extra,
    held: false,
    update(run) {
      const mine = run && kinds.includes(run.kind);
      const busy = Boolean(run && !run.over);
      for (const b of buttons) b.disabled = busy;
      halt.hidden = !(mine && busy);
      if (!mine) {
        if (!card.held) said.textContent = busy ? `Waiting — ${run.label.toLowerCase()} is running.` : idle;
        return;
      }
      // A finished run of this card's own stays on screen until something new
      // is asked for — unless the card is showing an answer of its own.
      if (card.held && run.over) return;
      card.held = false;
      said.textContent = run.over
        ? `${run.label} — done. ${progressLine(run, changedWord)}.${run.note ? ' ' + run.note : ''}`
        : `${run.stopping ? 'Stopping after this one' : run.label} — ${progressLine(run, changedWord)}.`;
      extra.replaceChildren(...[failures(run)].filter(Boolean));
    },
    say(text) { card.held = true; said.textContent = text; },
  };

  choreCards.add(card);
  watchChores();
  return card;
}

async function startChore(card, endpoint) {
  try {
    const { run } = await api(endpoint, { method: 'POST' });
    card.held = false;
    card.update(run);
    watchChores();
  } catch (err) {
    card.say(err.message);
  }
}

/*
 * Press twice for anything that deletes or overwrites. Not window.confirm:
 * the app's browser pane answers it "no" without showing it. Disarms after
 * a few seconds.
 */
function armed(button, warning, action) {
  let timer = null;
  let label = '';
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    button.textContent = label;
    button.classList.remove('danger');
  };
  button.onclick = () => {
    if (!timer) {
      label = button.textContent;
      button.textContent = warning();
      button.classList.add('danger');
      timer = setTimeout(disarm, 6000);
      return;
    }
    disarm();
    action();
  };
}

/* Rename all in organized: the first press plans, the second moves. */
function reshelve() {
  const look = el('button', { className: 'add', type: 'button' }, 'Rename all in organized');
  const go = el('button', { className: 'add', type: 'button', hidden: true }, 'Move them');
  const keep = el('button', { className: 'chip', type: 'button', hidden: true }, 'Keep the better copy');

  const card = choreCard({
    title: 'Rename and reorganize',
    hint: 'Studio / date.Title / Studio.date.Title',
    idle: 'Puts every filed scene where its Stash record says it belongs, in the shape the rest of '
      + 'the library uses. Nothing is overwritten; its .nfo and thumbnail move with it. You see the plan first.',
    kinds: ['reshelve', 'copies'],
    changedWord: 'done',
    buttons: [look, go, keep],
  });

  const sample = (label, items, row) => (items.length
    ? el('details', { className: 'small' },
      el('summary', { className: 'muted' }, `${label} — the first ${items.length}`),
      el('ul', { className: 'muted small' }, items.map(row)))
    : null);

  look.onclick = async () => {
    look.disabled = true;
    card.say('Working out what would move — it checks every filed file, so give it ten seconds…');
    try {
      const plan = await api('/api/manage/reshelve');
      const count = (kinds) => plan.copies.filter((c) => kinds.includes(c.keep)).length;
      const decided = count(['loose', 'filed']);
      const unlike = count(['length']);
      const even = count(['tie', 'unknown']);
      card.say([
        `${n(plan.scenes)} filed scenes.`,
        `${n(plan.right)} are already right.`,
        plan.moves ? `${n(plan.moves)} would move.` : 'Nothing to move.',
        plan.copies.length
          ? `${n(plan.copies.length)} are a second copy of a filed scene: ${n(decided)} have a clear better copy`
            + (unlike ? `, ${n(unlike)} are a different length and are left alone` : '')
            + (even ? `, ${n(even)} cannot be told apart` : '') + '.'
          : '',
        plan.cannot ? `${n(plan.cannot)} cannot be placed yet (two files, or no date or studio).` : '',
        plan.waiting ? `${n(plan.waiting)} already moved, waiting on Stash's rescan.` : '',
        plan.gone.length ? `${n(plan.gone.length)} are gone from disk — Clean in Stash drops the record.` : '',
      ].filter(Boolean).join(' '));
      go.textContent = `Move ${n(plan.moves)} files`;
      go.hidden = !plan.moves;
      keep.textContent = `Keep the better copy — ${n(decided)} pairs`;
      keep.hidden = !decided;
      keep.dataset.count = String(decided);
      card.extra.replaceChildren(...[
        sample('What moves', plan.sampleMoves, (m) =>
          el('li', {}, el('code', {}, m.from), ' → ', el('code', {}, m.to))),
        // Every copy, not a sample: this is the list you work through. The one
        // the button would keep is marked — by quality, not size.
        plan.copies.length ? el('details', { className: 'small' },
          el('summary', { className: 'muted' }, `Second copies — all ${plan.copies.length}`),
          el('ul', { className: 'muted small' }, plan.copies.map((c) => {
            const mark = (side) => (c.keep === side ? ' — keep'
              : c.keep === 'tie' ? ' — tie, left alone'
                : c.keep === 'length' ? ' — different length, left alone' : '');
            return el('li', {},
              el('a', { href: `#/library/scene/${c.id}` }, el('code', {}, c.path)),
              ` ${c.quality || '?'}, ${clock(c.duration)}, ${gb(c.size)}${mark('loose')}. Already filed as `,
              c.filedId
                ? el('a', { href: `#/library/scene/${c.filedId}` }, el('code', {}, c.filedPath))
                : el('code', {}, c.filedPath),
              ` ${c.filedQuality || '?'}, ${clock(c.filedDuration)}, ${gb(c.filedSize)}${mark('filed')}.`);
          }))) : null,
        sample('Gone from disk', plan.gone, (g) =>
          el('li', {}, el('a', { href: `#/library/scene/${g.id}` }, el('code', {}, g.path)))),
        sample('What cannot', plan.sampleCannot, (c) =>
          el('li', {}, el('a', { href: `#/library/scene/${c.id}` }, el('code', {}, c.path)), ` — ${c.why}`)),
      ].filter(Boolean));
    } catch (err) {
      card.say(err.message);
    }
    look.disabled = false;
  };

  /* Deletes the worse file of each pair; the filed scene is kept. */
  armed(keep, () => `Press again to delete the worse file of ${keep.dataset.count} pairs`, async () => {
    keep.hidden = true;
    go.hidden = true;
    card.extra.replaceChildren();
    await startChore(card, '/api/manage/copies/keep-better');
  });

  go.onclick = async () => {
    go.hidden = true;
    keep.hidden = true;
    card.extra.replaceChildren();
    await startChore(card, '/api/manage/reshelve');
  };

  return card.node;
}

/* nfo and thumbnails: fill missing, or overwrite (asks first). */
function sidecar(what) {
  const nfo = what === 'nfo';
  const label = nfo ? 'nfo’s' : 'thumbnails';
  const missing = el('button', { className: 'add', type: 'button' }, `Generate missing ${label}`);
  const all = el('button', { className: 'chip', type: 'button' }, `Overwrite all ${label}`);

  const card = choreCard({
    title: nfo ? 'nfo’s' : 'Thumbnails',
    hint: nfo ? 'beside the video, for Emby and Kodi' : 'Stash’s cover, beside the video',
    idle: nfo
      ? 'A Kodi/Emby .nfo named after each filed video — title, date, studio, cast, tags, ids — '
        + 'the same shape as the ones in /movies.'
      : 'Each filed scene’s cover from Stash, written as <video name>-thumb.jpg. '
        + 'Scenes Stash has no cover for are listed as failed, not written.',
    kinds: nfo ? ['nfo-missing', 'nfo-all'] : ['thumbs-missing', 'thumbs-all'],
    changedWord: 'written',
    buttons: [missing, all],
  });

  const base = nfo ? '/api/manage/nfo' : '/api/manage/thumbs';
  missing.onclick = () => startChore(card, `${base}/missing`);
  armed(all, () => `Press again to overwrite every ${nfo ? '.nfo' : 'thumbnail'}`,
    () => startChore(card, `${base}/all`));

  return card.node;
}

/* ------------------------------------------------------------ duplicates */

const gb = (bytes) => (bytes ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : '');
const clock = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

/* Stash's phash duplicate finder, as a list. Delete from the scene page. */
function duplicates() {
  const pick = el('select', {},
    el('option', { value: '0' }, 'Exact'),
    el('option', { value: '4' }, 'High'),
    el('option', { value: '8' }, 'Medium'));
  const go = el('button', { className: 'add', type: 'button' }, 'Duplicate check');
  const said = el('span', { className: 'muted small' },
    'Scenes whose frames match, across the whole library. A list only — open one to decide.');
  const list = el('div', {});

  go.onclick = async () => {
    go.disabled = true;
    said.textContent = 'Asking Stash — this can take a minute on a big library…';
    list.replaceChildren();
    try {
      const { groups } = await api(`/api/manage/duplicates?distance=${pick.value}`);
      said.textContent = groups.length
        ? `${n(groups.length)} groups, ${n(groups.reduce((t, g) => t + g.length, 0))} scenes.`
        : 'No duplicates at this accuracy.';
      list.replaceChildren(...groups.map((group) =>
        el('div', { className: 'cattablewrap' },
          el('table', { className: 'cattable' },
            el('tbody', {}, group.map((s) =>
              el('tr', {},
                el('td', {}, el('a', { href: `#/library/scene/${s.id}` }, s.title || `scene ${s.id}`)),
                el('td', { className: 'muted' }, s.studio),
                el('td', { className: 'muted' }, s.width ? `${s.width}×${s.height}` : ''),
                el('td', { className: 'muted' }, clock(s.duration)),
                el('td', { className: 'muted' }, gb(s.size)),
                el('td', {}, el('code', {}, s.path)))))))));
    } catch (err) {
      said.textContent = err.message;
    }
    go.disabled = false;
  };

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' },
      el('strong', {}, 'Duplicates'),
      el('span', { className: 'muted small' }, 'by phash, as Stash sees them')),
    el('div', { className: 'controls jobline' }, go, pick, said),
    list);
}
