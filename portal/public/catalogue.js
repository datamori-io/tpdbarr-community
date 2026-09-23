/*
 * The StashDB half of a scene, drawn the same way wherever it appears.
 *
 * The acquisition side draws it in its results; the library's studio page draws
 * it for the scenes that studio put out and you do not have. Both are asking
 * the same two questions — do I already have this, and is anything already
 * trying to get it — so both ask them with the same badges and the same button.
 * Two copies would be two answers waiting to disagree.
 */

import { api, el, minutes } from './util.js';

/*
 * The badges and the button. A scene you own still gets the button — wanting a
 * second, better file for something already on the shelf is exactly what the v3
 * side is for.
 */
export function stashdbState(scene, className, { onTrackChange = null, onDispose = null } = {}) {
  const badges = el('div', { className });

  /*
   * An ignored scene is a decision already made, so it says so and offers only
   * the way back. Showing it the same three buttons as everything else is how a
   * decision stops meaning anything.
   */
  if (scene.disposition === 'ignored') {
    badges.append(el('span', { className: 'badge ignored' }, 'Skipped'));
    badges.append(undoIgnore(scene, onTrackChange));
    return badges;
  }

  if (scene.stash) {
    const label = scene.stash.match === 'exact' ? 'In Stash' : 'Probably';
    const props = {
      className: 'badge stash-' + scene.stash.match,
      title: [scene.stash.via && `matched on ${scene.stash.via}`, scene.stash.path].filter(Boolean).join('\n'),
    };

    // A match that found a scene id can go there. The click is stopped short of
    // the card, which opens StashDB — the badge is about your copy, not theirs.
    if (scene.stash.id) {
      const link = el('a', { ...props, href: `#/library/scene/${scene.stash.id}` }, label);
      link.onclick = (e) => e.stopPropagation();
      badges.append(link);
    } else {
      badges.append(el('span', props, label));
    }
  }

  const state3 = scene.whisparr3?.status || 'absent';
  if (state3 !== 'absent') {
    badges.append(el('span', { className: 'badge ' + (state3 === 'downloaded' ? 'downloaded' : 'monitored') },
      state3 === 'downloaded' ? 'In v3' : state3 === 'monitored' ? 'Monitored' : 'Known to v3'));
  }

  /*
   * The three answers a scene in a tracked catalogue can be given: Skip, Want
   * and Add — not for me, I want it, get it now. They sit together because
   * they are one decision, and a scene you already hold is not asked: owning
   * it was the answer.
   */
  if (!scene.stash) badges.append(ignoreButton(scene, onDispose));
  badges.append(trackToggle(scene, onTrackChange));

  if (state3 !== 'monitored' && state3 !== 'downloaded') {
    const button = el('button', { className: 'add', type: 'button' }, scene.stash ? 'Get another' : 'Add');
    button.title = scene.stash
      ? 'Send to Whisparr v3 and search. Nothing you already have is touched.'
      : 'Send to Whisparr v3 and monitor.';

    button.onclick = async (e) => {
      e.stopPropagation();
      button.disabled = true;
      button.textContent = 'Adding…';
      try {
        const result = await api(`/api/whisparr3/scenes/${scene.id}`, { method: 'POST' });
        button.textContent = result.searched ? 'Searching' : 'Monitored';

        /*
         * Adding is wanting, said louder. Leaving it off the want list would
         * mean a scene you fetched on purpose still counted as undecided
         * against the studio it came from.
         */
        if (!scene.tracked) {
          await api('/api/acquire/tracked/scenes', { method: 'POST', body: JSON.stringify(wanted(scene)) });
          scene.tracked = true;
          scene.disposition = 'tracked';
          onTrackChange?.(scene, true);
        }
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Add';
        alert(err.message);
      }
    };
    badges.append(button);
  }

  return badges;
}

/*
 * Skip — "not for me."
 *
 * The row leaves the page on the way out, because the whole point of saying it
 * is that you do not want to be asked again — a decision that leaves the thing
 * sitting there is a decision that has to be made twice. It leaves the
 * percentage too: a skipped scene is in neither half of the fraction.
 */
function ignoreButton(scene, onDispose) {
  const button = el('button', { className: 'chip quiet ignore', type: 'button' }, 'Skip');
  button.title = 'Not for me. Drops out of the results and out of the percentage.';

  button.onclick = async (e) => {
    e.stopPropagation();
    button.disabled = true;
    try {
      await api('/api/acquire/ignored', { method: 'POST', body: JSON.stringify({ id: scene.id }) });
      scene.disposition = 'ignored';
      scene.tracked = false;

      const node = button.closest('.scene, .card');
      if (onDispose) onDispose(scene, node);
      else node?.remove();
    } catch (err) {
      button.disabled = false;
      alert(err.message);
    }
  };

  return button;
}

// The way back, for the pass where you are looking at what you skipped.
function undoIgnore(scene, onTrackChange) {
  const button = el('button', { className: 'chip quiet', type: 'button' }, 'Undo');
  button.title = 'Put this back to be decided again.';

  button.onclick = async (e) => {
    e.stopPropagation();
    button.disabled = true;
    try {
      await api(`/api/acquire/ignored/${scene.id}`, { method: 'DELETE' });
      scene.disposition = 'undecided';
      onTrackChange?.(scene, false);
    } catch (err) {
      button.disabled = false;
      alert(err.message);
    }
  };

  return button;
}

/*
 * Want.
 *
 * Kept by the portal against the StashDB id, not by Whisparr — Whisparr fetches
 * files and is emptied as they import, so it cannot be the record of what you
 * meant to get. Marking downloads nothing: Add is still the sentence that says
 * fetch it. Unmarking does reach the downloader, because a scene nobody wants
 * should not still be being looked for.
 */
function trackToggle(scene, onTrackChange) {
  const button = el('button', { className: 'chip quiet track', type: 'button' });
  let on = Boolean(scene.tracked);

  const paint = () => {
    button.textContent = on ? 'Wanted' : 'Want';
    button.classList.toggle('on', on);
    button.title = on
      ? 'Stop wanting this. Whisparr drops its record too; no file is deleted.'
      : 'Mark this as one you want. Nothing is fetched until you press Add.';
  };
  paint();

  button.onclick = async (e) => {
    e.stopPropagation();
    button.disabled = true;
    try {
      if (on) {
        await api(`/api/acquire/tracked/scenes/${scene.id}`, { method: 'DELETE' });
      } else {
        await api('/api/acquire/tracked/scenes', { method: 'POST', body: JSON.stringify(wanted(scene)) });
      }
      on = !on;
      scene.tracked = on;
      paint();
      onTrackChange?.(scene, on);
    } catch (err) {
      alert(err.message);
    } finally {
      button.disabled = false;
    }
  };

  return button;
}

// What the want list keeps: enough to draw the card again without a second trip
// to StashDB for something it already told us.
const wanted = (scene) => ({
  id: scene.id,
  title: scene.title,
  date: scene.date,
  image: scene.image,
  url: scene.url,
  duration: scene.duration,
  studio: scene.studio || null,
  studioName: scene.studioName,
  performers: scene.performers,
  details: scene.details || '',
});

/*
 * The blurb, cut to a length whatever is drawing it can carry — a card takes
 * the default, a list row is wider and asks for more. StashDB's details run
 * from one line to several paragraphs, and anything that grows with the longest
 * one in the grid ruins the row it is in, so it is cut at a word boundary and
 * the whole of it stays on the hover title.
 */
// Forty-odd scenes on StashDB have the title again as their description. Drawn
// as written that is the same line twice on one card, so it is dropped.
const bare = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function blurb(details, title, limit = 160) {
  const text = String(details || '').replace(/\s+/g, ' ').trim();
  if (!text || bare(text) === bare(title)) return '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit / 2 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/*
 * The scene as a card.
 *
 * A row is for reading — cast, studio, date, all legible at once. A grid is for
 * looking, so the card leads with the still and keeps only what you can take in
 * without reading: the title, the date, who is in it, the first line of what it
 * is about, the state and the button. Both the cast and the blurb are cut to
 * one or two lines and carry the whole of themselves on the hover title.
 */
export function stashdbCard(scene, options) {
  const cast = (scene.performers || []).map((p) => p.name).join(', ');
  const about = blurb(scene.details, scene.title);

  const art = el('div', { className: 'cardart landscape' },
    scene.image ? el('img', { src: scene.image, loading: 'lazy', alt: '' }) : null
  );

  const card = el('article', { className: 'card' },
    art,
    el('div', { className: 'cardbody' },
      el('div', { className: 'title' }, scene.title),
      el('div', { className: 'meta' },
        scene.date ? el('span', {}, scene.date) : null,
        scene.duration ? el('span', {}, minutes(scene.duration)) : null,
        scene.studioName ? el('span', {}, scene.studioName) : null
      ),
      cast ? el('div', { className: 'cardcast', title: cast }, cast) : null,
      about ? el('div', { className: 'carddesc', title: scene.details }, about) : null,
      stashdbState(scene, 'cardstate', options)
    )
  );

  // The card opens the scene on StashDB — the same place the row's title goes.
  // Adding stays on the button, because a whole-card click that quietly starts
  // a download is a click nobody meant to make.
  card.onclick = () => window.open(scene.url, '_blank', 'noreferrer');
  card.title = cast;
  return card;
}

/*
 * How much of a tracked catalogue you hold. The row comes from the coverage
 * measurement in discover.mjs and is drawn identically on the Acquire page and
 * on a studio's own page.
 */
export function coverageBar(row) {
  if (row.pending) return el('div', { className: 'muted small' }, 'Measuring against StashDB…');

  const fill = el('span');
  fill.style.width = row.pct + '%';

  const bits = [
    `${row.have} of ${(row.counted || 0).toLocaleString()} you want`,
    row.probable ? `${row.probable} matched on title + date` : null,
    row.onTheWay ? `${row.onTheWay} monitored in Whisparr` : null,
    row.undecided ? `${row.undecided.toLocaleString()} still to decide` : null,
    row.ignored ? `${row.ignored.toLocaleString()} skipped` : null,
    row.capped ? `catalogue read to ${(row.total || 0).toLocaleString()}` : null,
  ].filter(Boolean);

  // Nothing decided yet is not nought per cent — it is no answer, and saying
  // 0% would read as "you have none of this" when you may have all of it.
  if (!row.counted) {
    return el('div', { className: 'coverage' },
      el('div', { className: 'pct none' }, '—'),
      el('div', { className: 'meta' },
        el('span', {}, row.undecided
          ? `${row.undecided.toLocaleString()} scenes, none decided yet`
          : 'nothing in this catalogue yet'))
    );
  }

  return el('div', { className: 'coverage' },
    el('div', { className: 'pct' }, row.pct + '%'),
    el('div', { className: 'bar' }, fill),
    el('div', { className: 'meta' }, bits.map((b) => el('span', {}, b)))
  );
}
