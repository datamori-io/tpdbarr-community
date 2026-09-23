/*
 * Stash — the things you ask Stash to go and do.
 *
 * These were a row of cards on the Catalogue landing page, above the piles
 * they act on. They are presses rather than counts, and a landing page that
 * says which tool to open is a different page from one that starts jobs, so
 * they live under Manage now and the Catalogue page keeps its numbers.
 */

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
 * The things you ask Stash to go and do, which are the same shape.
 *
 * Both are fire-and-report: Stash hands back a job id and the browser must not
 * hold a request open across work measured in minutes or hours. Both have to
 * cope with the job already running when the page opens, because the job
 * outlives the page by design and Stash will happily queue a second one behind
 * the first and do everything twice.
 *
 * Drawn immediately and asked about afterwards. Whether something is already
 * running is one more round trip, the counts below are useful without it, and
 * a landing page that waits on a footnote is a landing page that feels broken.
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
    // Slow on purpose: these run for minutes at least and the answer only
    // changes on that scale. A tighter poll is a hundred requests saying the
    // same thing.
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
 * Telling Stash to go and look at the disk.
 *
 * Every count on this page is a count of what Stash knows about, and Stash
 * only knows about a file it has scanned. A folder the downloader filled an
 * hour ago is not a small pile here — it is no pile at all, and the page reads
 * as finished at exactly the moment it is furthest from it. So the control
 * that makes the numbers true sits above them rather than in Stash's settings
 * two clicks away.
 *
 * **The three arrival folders, not the library.** A scene only ever enters
 * through /pc-import, /Import Folder or /movies; the rest of what Stash is
 * configured with is either already counted or on its way out. Walking all of
 * it to find this morning's grab was minutes spent where the answer could not
 * be. See SCAN_PATHS in catalogue.mjs.
 *
 * Covers and phashes are asked for on the way in, which is why this is not
 * quite the same press as Stash's own Scan button: the two piles below that a
 * scan can avoid creating, it avoids creating.
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

/*
 * The heavy half of what Stash can make.
 *
 * Previews, sprites, image previews and clip previews — ffmpeg over whole
 * files, which is what makes a scene hover on a shelf and scrub on its page.
 * Hours rather than minutes, and nothing else in the portal needs it to have
 * happened, which is why it is a press and not something that runs on its own.
 *
 * Only /organized_scenes. The other folders are a scene passing through, and a
 * preview built over a file that FileFlows is about to re-encode and move is
 * thrown away with it.
 */
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

/*
 * Fingerprints, which are not a pile — they are the reason the piles are hard.
 *
 * A stash-box asked about a scene matches on fingerprints and nothing else. An
 * oshash only matches somebody holding the byte-identical file; a phash is the
 * frames and survives a re-encode. Without one a scene has a single brittle
 * chance at a certainty and then falls to a keyword guess, which is what makes
 * Match feel like it does not work.
 */
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

  /*
   * The button here does the whole library, which is the difference between it
   * and the one on the Match page — that one is scoped to the pile in front of
   * you, and the gap deliberately is not. Counted on 2026-09-12: the three
   * piles overlap and none of them covers it.
   */
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

/*
 * The organized folder on its own. The arrival scan above leaves it alone on
 * purpose; this is for after a re-shelve, or after something on the Mac was
 * moved by hand and Stash is holding paths that are not there any more.
 */
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

/* ------------------------------------------------------------ the chores
 *
 * Rename, nfo and thumbnails are the portal's own loops, not Stash jobs, and
 * only one runs at a time. Every chore card watches the same run and says what
 * it is doing — its own progress, or which other chore has the floor.
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

/*
 * One chore card: a title, some buttons, and a line under them that the
 * shared poll keeps true.
 */
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
 * Press twice for anything that deletes or overwrites.
 *
 * Not window.confirm: the app's own browser pane never shows the dialog and
 * answers it "no" on your behalf, so the button looked dead. The first press
 * arms the button and says what the second will do; it disarms itself after
 * a few seconds if the second never comes.
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

/*
 * Rename all in organized. Two presses on purpose: the first only asks what
 * would move, and the page says so — how many, and a sample of each — before
 * the second moves anything.
 */
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

  /*
   * Deletes files, so it asks — with the number, and what "better" means.
   * The filed scene is kept either way; only the worse file goes.
   */
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

/*
 * nfo's and thumbnails: the same card twice, a gentle press and a heavy one.
 * Overwrite asks first — it replaces files that may have been edited by hand.
 */
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

/*
 * Stash's phash duplicate finder, as a list. Nothing here deletes — each row
 * opens the scene, where removing one is a decision made looking at it.
 */
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
