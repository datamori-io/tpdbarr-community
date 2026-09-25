/* A StashDB scene's badges and buttons, shared by the search and studio pages. */

import { api, el, minutes } from './util.js';

/* Badges and button. Owned scenes keep the button (for a better copy). */
export function stashdbState(scene, className, { onTrackChange = null, onDispose = null } = {}) {
  const badges = el('div', { className });

  /* Ignored: say so and offer the way back. */
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

  /* Skip, Want, Add. Not shown for scenes you hold. */
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

        /* Adding also marks it wanted. */
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

/* Skip: the row leaves, and the scene leaves the percentage. */
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
 * Want: kept by the portal against the StashDB id. Doesn't download.
 * Unwanting unmonitors in Whisparr.
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

/* The blurb, cut at a word to the caller's length; the whole of it on hover. */
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

/* The scene as a card: still, title, date, cast, blurb, state, button. */
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

  // The card opens StashDB; adding stays on the button.
  card.onclick = () => window.open(scene.url, '_blank', 'noreferrer');
  card.title = cast;
  return card;
}

/* Tracked coverage bar (see discover.mjs). */
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
