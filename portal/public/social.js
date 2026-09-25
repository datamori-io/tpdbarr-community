/*
 * Reddit for your performers. Reads the poller's cache (reddit.mjs); a
 * walk takes hours, so the page shows how far it's got.
 */

import { api, el } from './util.js';

const view = document.getElementById('view');

// Poll every 10s during a walk.
const WATCH_MS = 10000;

let live = null;

export function leave() {
  if (!live) return;
  live.dead = true;
  clearTimeout(live.timer);
  live = null;
}

// ------------------------------------------------------------------ pieces

const ago = (at) => {
  if (!at) return 'never';
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

/*
 * A post's picture: thumbnail, else the full picture (lazy). Galleries
 * link out.
 */
function card(post) {
  const art = post.thumb || post.full;

  const picture = art
    ? el('img', { src: '/media/social?url=' + encodeURIComponent(art), loading: 'lazy', alt: '' })
    : el('div', { className: 'redditnone' }, post.gallery ? 'Gallery' : 'No picture');

  const shot = el('a', {
    className: 'redditshot',
    href: post.permalink,
    target: '_blank',
    rel: 'noreferrer noopener',
    title: post.title,
  }, picture, post.gallery ? el('span', { className: 'redditbadge' }, 'Gallery') : null);

  return el('figure', { className: 'redditcard' },
    shot,
    el('figcaption', {},
      el('a', { className: 'redditwho', href: `#/library/performer/${post.performerId}` }, post.performerName),
      el('div', { className: 'redditwhat' }, post.title),
      el('div', { className: 'redditwhen' },
        `${post.kind === 'sub' ? 'r/' : 'u/'}${post.handle}`,
        post.at ? ' · ' + ago(post.at) : '',
        // The one thing worth linking separately: the full-size picture, which
        // is a different URL from the thumbnail the tile shows.
        post.full
          ? [' · ', el('a', { href: '/media/social?url=' + encodeURIComponent(post.full), target: '_blank', rel: 'noreferrer noopener' }, 'full')]
          : null
      )
    )
  );
}

function status(data) {
  if (data.running) {
    return `Walking Reddit — ${data.walked} of ${data.total} followed. Posts fill in as it goes.`;
  }

  if (data.blockedUntil) {
    const mins = Math.max(1, Math.round((data.blockedUntil - Date.now()) / 60000));
    return `Reddit is rate limiting. Resuming in about ${mins}m from ${data.walked} of ${data.total}.`;
  }

  if (!data.at) return `Nothing pulled yet — ${data.total} performers in the library have a Reddit address.`;

  return `${data.total} followed · last full pass ${ago(data.at)}`;
}

// -------------------------------------------------------------------- view

function render(session, data) {
  const pick = el('select', { className: 'reelpick', title: 'One performer, or all of them' },
    el('option', { value: '' }, `Everyone (${data.total})`),
    data.performers.map((p) => el('option', { value: p.id }, `${p.name} — ${p.kind === 'sub' ? 'r/' : 'u/'}${p.handle}`))
  );
  pick.value = session.performerId || '';
  pick.onchange = () => {
    session.performerId = pick.value || null;
    load(session);
  };

  const refresh = el('button', { className: 'reelmute', type: 'button', disabled: data.running || Boolean(data.blockedUntil) },
    data.running ? 'Walking…' : 'Pull from Reddit');

  refresh.onclick = async () => {
    refresh.disabled = true;
    try {
      const next = await api('/api/reddit/refresh', { method: 'POST', body: '{}' });
      if (!session.dead) render(session, { ...next, performers: data.performers });
    } catch (err) {
      refresh.disabled = false;
      refresh.textContent = err.message;
    }
  };

  /* Follow something by hand: a URL, `r/name`, `u/name` or a bare name. */
  const entry = el('input', {
    className: 'redditadd',
    type: 'text',
    placeholder: 'r/something, u/someone, or a reddit link',
    spellcheck: false,
  });

  const add = el('button', { className: 'reelmute', type: 'button' }, 'Follow');

  const follow = async () => {
    const what = entry.value.trim();
    if (!what) return;

    add.disabled = true;
    add.textContent = 'Following…';

    try {
      const next = await api('/api/reddit/follow', { method: 'POST', body: JSON.stringify({ what }) });
      if (session.dead) return;
      entry.value = '';
      render(session, next);
    } catch (err) {
      add.disabled = false;
      add.textContent = 'Follow';
      note.textContent = err.message;
    }
  };

  add.onclick = follow;
  entry.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); follow(); } };

  const note = el('span', { className: 'redditnote' }, '');

  // Only the hand-followed ones can be dropped here; the rest are a performer's
  // own URL and belong to Stash.
  const mine = data.performers.filter((p) => p.byHand);

  const followed = mine.length
    ? el('div', { className: 'redditmine' },
        el('span', { className: 'redditstatus' }, 'Followed by hand:'),
        mine.map((p) => {
          const chip = el('span', { className: 'chip' }, `${p.kind === 'sub' ? 'r/' : 'u/'}${p.handle}`);
          const drop = el('button', { className: 'redditdrop', type: 'button', title: 'Stop following' }, '×');
          drop.onclick = async () => {
            drop.disabled = true;
            try {
              const next = await api('/api/reddit/unfollow', { method: 'POST', body: JSON.stringify({ handle: p.handle }) });
              if (!session.dead) render(session, next);
            } catch (err) {
              drop.disabled = false;
              note.textContent = err.message;
            }
          };
          chip.append(drop);
          return chip;
        })
      )
    : null;

  const bar = el('div', { className: 'toolbar' },
    pick, refresh, entry, add, el('span', { className: 'redditstatus' }, status(data)), note);

  const body = data.posts.length
    ? el('div', { className: 'redditgrid' }, data.posts.map(card))
    : el('div', { className: 'empty' },
        data.total
          ? 'Nothing pulled yet. Pull from Reddit above — it fills in over a few hours.'
          : 'No performer has a Reddit address. Add one in Stash to follow it.');

  // replaceChildren does not drop a null the way el() does — it renders the
  // word. Nothing hand-followed means no strip at all.
  view.replaceChildren(...[bar, followed, body].filter(Boolean));

  // Keep watching while a walk is running, and stop the moment it is not.
  clearTimeout(session.timer);
  if (data.running || data.blockedUntil) {
    session.timer = setTimeout(() => { if (!session.dead) load(session, { quiet: true }); }, WATCH_MS);
  }
}

async function load(session, { quiet = false } = {}) {
  if (!quiet) view.replaceChildren(el('div', { className: 'empty' }, 'Loading…'));

  try {
    const query = session.performerId ? '?performer=' + encodeURIComponent(session.performerId) : '';
    const data = await api('/api/reddit' + query);
    if (session.dead) return;
    render(session, data);
  } catch (err) {
    if (session.dead) return;
    view.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

export async function show() {
  leave();
  const session = { performerId: null, timer: null, dead: false };
  live = session;
  await load(session);
}
