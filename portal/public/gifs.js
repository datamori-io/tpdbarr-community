/*
 * What RedGIFs is pulling: creators (seeded from performers' Reddit
 * handles) and tags (added by hand). A pass takes about a minute.
 */

import { api, el } from './util.js';

const view = document.getElementById('view');

// A pass is short, so this can watch closely without being a nuisance.
const WATCH_MS = 4000;

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

const proxied = (url) => '/media/social?url=' + encodeURIComponent(url);

/* Posters, not playing clips. */
function card(gif) {
  const shot = el('a', {
    className: 'redditshot',
    href: gif.link,
    target: '_blank',
    rel: 'noreferrer noopener',
    title: gif.title || gif.tags.join(', '),
  },
    gif.poster
      ? el('img', { src: proxied(gif.poster), loading: 'lazy', alt: '' })
      : el('div', { className: 'redditnone' }, 'No poster'),
    gif.seconds ? el('span', { className: 'redditbadge' }, `${gif.seconds}s`) : null
  );

  return el('figure', { className: 'redditcard' },
    shot,
    el('figcaption', {},
      el('div', { className: 'redditwho' }, gif.creator ? '@' + gif.creator : 'RedGIFs'),
      el('div', { className: 'redditwhat' }, gif.title || gif.tags.slice(0, 4).join(', ')),
      el('div', { className: 'redditwhen' },
        [gif.sound ? null : 'silent', gif.at ? ago(gif.at) : null].filter(Boolean).join(' · '))
    )
  );
}

function status(data) {
  if (data.running) return 'Pulling from RedGIFs…';
  if (!data.at) return `Nothing pulled yet — ${data.creators.length} creators and ${data.tags.length} tags to go at.`;

  const base = `${data.held} clips held · ${data.creators.length} creators · ${data.tags.length} tags · last pass ${ago(data.at)}`;

  /* What the pass managed, when it didn't get everything. */
  if (!data.last) return base;
  if (data.last.limited) {
    return `${base} — read ${data.last.read} of ${data.last.read + data.last.limited}, added ${data.last.added}. RedGIFs was rate limiting the rest; try again in a while.`;
  }

  return `${base}, added ${data.last.added}`;
}

// -------------------------------------------------------------------- view

function render(session, data) {
  const note = el('span', { className: 'redditnote' }, '');

  const post = async (path, body, button, busyText) => {
    const was = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    note.textContent = '';

    try {
      const next = await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (!session.dead) render(session, next);
    } catch (err) {
      button.disabled = false;
      button.textContent = was;
      note.textContent = err.message;
    }
  };

  const refresh = el('button', { className: 'reelmute', type: 'button', disabled: data.running },
    data.running ? 'Pulling…' : 'Pull from RedGIFs');
  refresh.onclick = () => post('/api/redgifs/refresh', {}, refresh, 'Pulling…');

  // --- the two lists ---------------------------------------------------

  const creatorBox = el('input', {
    className: 'redditadd',
    type: 'text',
    placeholder: 'a redgifs creator name',
    spellcheck: false,
  });

  const addCreator = el('button', { className: 'reelmute', type: 'button' }, 'Follow');
  const followCreator = () => {
    const name = creatorBox.value.trim();
    if (name) post('/api/redgifs/follow', { name }, addCreator, 'Checking…');
  };
  addCreator.onclick = followCreator;
  creatorBox.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); followCreator(); } };

  const tagBox = el('input', {
    className: 'redditadd',
    type: 'text',
    placeholder: 'a tag to pull — blonde, cowgirl, redhead…',
    spellcheck: false,
  });

  const addTag = el('button', { className: 'reelmute', type: 'button' }, 'Add tag');
  const pushTag = () => {
    const tag = tagBox.value.trim();
    if (tag) post('/api/redgifs/tags', { tag }, addTag, 'Checking…');
  };
  addTag.onclick = pushTag;
  tagBox.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); pushTag(); } };

  const chip = (label, title, onDrop) => {
    const node = el('span', { className: 'chip', title }, label);
    const drop = el('button', { className: 'redditdrop', type: 'button', title: 'Remove' }, '×');
    drop.onclick = () => { drop.disabled = true; onDrop(drop); };
    node.append(drop);
    return node;
  };

  const tags = data.tags.length
    ? el('div', { className: 'redditmine' },
        el('span', { className: 'redditstatus' }, 'Tags pulled:'),
        data.tags.map((tag) => chip(tag, 'Pulled every pass',
          (button) => post('/api/redgifs/tags/remove', { tag }, button, '…')))
      )
    : null;

  /* Creators in one strip, hand-added first. */
  const ordered = [...data.creators].sort((a, b) => (b.byHand ? 1 : 0) - (a.byHand ? 1 : 0));

  const creators = data.creators.length
    ? el('div', { className: 'redditmine' },
        el('span', { className: 'redditstatus' }, 'Creators followed:'),
        ordered.map((c) => chip(
          '@' + c.name + (c.gifs ? ` · ${c.gifs}` : ''),
          c.byHand ? 'Followed by hand' : `From ${c.from}`,
          (button) => post('/api/redgifs/unfollow', { name: c.name }, button, '…')
        ))
      )
    : null;

  const bar = el('div', { className: 'toolbar' },
    refresh, creatorBox, addCreator, tagBox, addTag, el('span', { className: 'redditstatus' }, status(data)), note);

  const body = data.gifs.length
    ? el('div', { className: 'redditgrid' }, data.gifs.map(card))
    : el('div', { className: 'empty' },
        data.seeded
          ? 'Nothing pulled yet. Pull from RedGIFs above — it takes about a minute.'
          : 'Nothing pulled yet. The first pull takes a few minutes.');

  view.replaceChildren(...[bar, creators, tags, body].filter(Boolean));

  clearTimeout(session.timer);
  if (data.running) {
    session.timer = setTimeout(() => { if (!session.dead) load(session, { quiet: true }); }, WATCH_MS);
  }
}

async function load(session, { quiet = false } = {}) {
  if (!quiet) view.replaceChildren(el('div', { className: 'empty' }, 'Loading…'));

  try {
    const data = await api('/api/redgifs');
    if (session.dead) return;
    render(session, data);
  } catch (err) {
    if (session.dead) return;
    view.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

export async function show() {
  leave();
  const session = { timer: null, dead: false };
  live = session;
  await load(session);
}
