/*
 * Reddit, for the performers already in the library.
 *
 * The page never fetches from Reddit. It reads what the poller in reddit.mjs
 * has cached and, if that is stale, offers to start another walk — which takes
 * hours, because Reddit hands out two or three feed requests a minute and then
 * makes you wait. So the interesting part of this page is telling you honestly
 * where that walk has got to instead of looking hung.
 */

import { api, el } from './util.js';

const view = document.getElementById('view');

// How often to ask again while a walk is running. It moves once every 25s at
// best and far less when Reddit is refusing, so anything faster than this is
// asking to be told the same thing.
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
 * A post is a picture if Reddit gave us one. Plenty of entries carry a
 * full-size i.redd.it link and no media:thumbnail at all, so the tile falls
 * back to the full picture rather than showing a hole — lazily, because that
 * one can be a couple of megabytes.
 *
 * A gallery gives us only its 140px crop and would cost another request per
 * picture to open properly, so it says what it is and links out. Anything else
 * is a link.
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
    return `Walking Reddit — ${data.walked} of ${data.total} followed. It goes slowly on purpose; the posts below fill in as it goes.`;
  }

  if (data.blockedUntil) {
    const mins = Math.max(1, Math.round((data.blockedUntil - Date.now()) / 60000));
    return `Reddit is rate limiting us. Backing off for about ${mins}m, then it carries on from ${data.walked} of ${data.total}.`;
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

  /*
   * Following something that is not on a performer. Takes what people actually
   * type — a full URL, `r/name`, `u/name`, or a bare name — and the server
   * decides which of those it is.
   */
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
          ? 'Nothing pulled yet. Pull from Reddit above — it fills in over the next few hours, and you can leave it to it.'
          : 'No performer in the library has a Reddit address on them. Add one to a performer in Stash and it will be followed.');

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
