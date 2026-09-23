/*
 * A movie, played as a movie.
 *
 * A Stash group is a release cut into scene files, and a list of those files
 * is not what a film is. So this page is the scene page's shape — player,
 * what it is, a rail of what you read — with one difference that is the whole
 * point: the player holds the whole group. It starts on the first part and
 * walks into the next when one ends, so a five-part release plays through
 * once you press play.
 *
 * The order is the hard part. Stash keeps a scene_index on the join and
 * almost nothing here sets it, so the names are what is left — and the names
 * in this library are consistent enough to read: "pt. 2", "- Scene 4",
 * "Act III", "Ep 3". What is read is the part of the title that is *not* the
 * group's own name, because half these releases carry a volume number —
 * "Lindsey in Barely Legal #2" — and that number is the film, not the place
 * in it.
 */

import { api, clock, el } from '../util.js';
import { withControls } from '../player.js';
import { claim, day, failedIn, holds, loadingIn, onTeardown, plural, runtime, shell, sidecard, stashOrigin } from './core.js';
import { sideGalleries } from './galleries.js';
import { castStrip } from './scene.js';

/* -------------------------------------------------------------- the order */

const escaped = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/*
 * Only numbers wearing a word that says what they count. A bare number in one
 * of these titles is nearly always the volume — #17, Vol. 8 — and ordering
 * five scenes by the volume they all share is worse than not trying.
 */
const PLACES = [
  /\bscenes?\s*#?\s*(\d{1,2})\b/i,
  /\bp(?:ar)?ts?\.?\s*#?\s*(\d{1,2})\b/i,
  /\bep(?:isode)?s?\.?\s*#?\s*(\d{1,2})\b/i,
  /\bacts?\.?\s*(\d{1,2})\b/i,
  /\b(?:disc|disk|cd)\s*(\d{1,2})\b/i,
];

// The same words, counted the old way: "Act III", "Episode IV".
const ROMAN_PLACE = /\b(?:acts?|ep(?:isode)?s?|p(?:ar)?ts?)\.?\s*([ivx]{1,4})\b/i;

export function placeOf(title, groupName) {
  // The group's own name out of the way first, so its volume number goes with
  // it and what is left is whatever this file is called within the release.
  let rest = String(title || '');
  const name = String(groupName || '').trim();
  if (name) rest = rest.replace(new RegExp(escaped(name), 'ig'), ' ');

  for (const rule of PLACES) {
    const hit = rule.exec(rest);
    if (hit) return Number(hit[1]);
  }

  const roman = ROMAN_PLACE.exec(rest);
  if (roman) {
    const n = ROMAN[roman[1].toLowerCase()];
    if (n) return n;
  }

  return null;
}

/*
 * -> the scenes in the order they should play.
 *
 * Whatever place can be read comes first; everything unreadable falls to the
 * back in date order, which is the order a serial came out in and the least
 * wrong answer for a compilation. The position it arrived in is the last
 * tiebreak, so the sort never shuffles equals about.
 */
export function ordered(scenes, groupName) {
  const keyed = scenes.map((scene, at) => ({
    scene,
    at,
    place: Number.isFinite(scene.index) ? scene.index : placeOf(scene.title, groupName),
  }));

  keyed.sort((a, b) => {
    const pa = a.place === null ? Infinity : a.place;
    const pb = b.place === null ? Infinity : b.place;
    if (pa !== pb) return pa - pb;

    const da = a.scene.date || '9999-99-99';
    const db = b.scene.date || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;

    const byTitle = String(a.scene.title).localeCompare(String(b.scene.title), undefined, { numeric: true });
    return byTitle || a.at - b.at;
  });

  return keyed.map((k) => k.scene);
}

/* -------------------------------------------------------- what was watched
 *
 * The same contract the scene page keeps, moved along as the film moves: a
 * play counted once per part, real elapsed time rather than seek distance,
 * and the position written back to Stash — so "continue watching" is the same
 * list whether you watched this here, on the scene page, or in Stash itself.
 *
 * The part being left is reported before the next one starts.
 */
const REPORT_EVERY = 15000;

function tracking(video) {
  let scene = null;
  let counted = false;
  let watched = 0;
  let mark = null;

  const payload = (at) => JSON.stringify({ resume: at, played: watched });

  const report = (at = video.currentTime) => {
    if (!scene || !counted) return;
    api(`/api/library/scenes/${scene.id}/activity`, { method: 'POST', body: payload(at) }).catch(() => {});
    watched = 0;
  };

  // A fetch does not survive the page going away; a beacon does.
  const beacon = () => {
    if (!scene || !counted) return;
    navigator.sendBeacon(
      `/api/library/scenes/${scene.id}/activity`,
      new Blob([payload(video.currentTime)], { type: 'application/json' })
    );
  };

  video.addEventListener('timeupdate', () => {
    if (video.paused || !scene) return;
    const now = video.currentTime;
    // Only count real elapsed time; a seek is not two minutes of watching.
    if (mark !== null && now > mark && now - mark < 2) watched += now - mark;
    mark = now;
  });

  video.addEventListener('play', () => {
    mark = video.currentTime;
    if (!scene || counted) return;
    counted = true;
    api(`/api/library/scenes/${scene.id}/play`, { method: 'POST' }).catch(() => {});
  });

  video.addEventListener('pause', () => report());

  const timer = setInterval(() => report(), REPORT_EVERY);
  window.addEventListener('pagehide', beacon);

  onTeardown(() => {
    clearInterval(timer);
    window.removeEventListener('pagehide', beacon);
    report();
  });

  return {
    /*
     * `at` is where the part being left got to, which on a part that ran out
     * is its runtime rather than wherever the video element now sits: a
     * browser can fire `ended` a fraction short, and a part left four seconds
     * from the end comes back forever as unfinished.
     */
    move(next, at = video.currentTime) {
      report(at);
      // Onto the card as well as into Stash. The cards are what the chapter
      // list draws its bars from and what a part picks up from when you come
      // back to it, and within one sitting this page is the only thing that
      // knows a part has moved on.
      if (scene) scene.resume = at;
      scene = next;
      counted = false;
      watched = 0;
      mark = null;
    },
    report,
  };
}

/* ------------------------------------------------------------- the player */

const finished = (scene) => Boolean(scene.duration && scene.resume > scene.duration - 30);

// Where a film opens: the first part you have not finished. All of them
// finished means you are coming back to it, and that starts at the top.
function startOn(scenes) {
  const at = scenes.findIndex((s) => !finished(s));
  return at < 0 ? 0 : at;
}

function play(scenes, onScene) {
  const video = el('video', {
    className: 'player',
    preload: 'metadata',
    playsInline: true,
  });

  const watch = tracking(video);
  let at = -1;
  let rolling = false;
  let page = null;

  const node = withControls(video, {
    duration: scenes[0]?.duration || 0,
    onWide: (on) => {
      page?.classList.toggle('wide', on);
      // The page dims around the player rather than only giving it the width.
      document.body.classList.toggle('videowide', on);
    },
  });

  /*
   * A part's markers and its sprite sheet are not on the cards this page was
   * handed, so they are asked for as each part starts and given to the bar.
   * One small request per part, and a part that answers nothing plays with a
   * plain bar rather than not playing.
   */
  const dress = (scene) => {
    api(`/api/library/scenes/${scene.id}`)
      .then(({ scene: full }) => {
        // Long enough to fetch that the film may have moved on already.
        if (scenes[at]?.id !== scene.id) return;
        node.reload({
          thumbnails: full.vtt ? `/media/scene/${scene.id}/vtt` : null,
          markers: full.markers || [],
          duration: full.duration || scene.duration || 0,
        });
      })
      .catch(() => {});
  };

  /*
   * Moving to a part. `from` is where the part being left got to; `resume` is
   * whether this one picks up where it was stopped, which is true when you
   * open the film and false when the one before it just ran out.
   */
  const go = (next, { resume = true, autoplay = true, from = null } = {}) => {
    if (next < 0 || next >= scenes.length) return;

    const scene = scenes[next];
    watch.move(scene, from === null ? video.currentTime : from);
    at = next;

    node.reload({ duration: scene.duration || 0 });
    video.poster = `/media/scene/${scene.id}/screenshot`;
    video.src = `/media/scene/${scene.id}/stream`;

    // Pick up where this part was left — unless that was its last half minute,
    // which means it was finished and is wanted from the top.
    const into = resume && scene.resume > 2 && !finished(scene) ? scene.resume : 0;
    if (into) {
      video.addEventListener('loadedmetadata', () => { video.currentTime = into; }, { once: true });
    }

    video.load();
    if (autoplay && rolling) video.play().catch(() => {});

    dress(scene);
    onScene(next);
  };

  // The join between parts, and the only thing that makes this a film.
  video.addEventListener('ended', () => {
    const done = scenes[at];
    const end = done?.duration || video.currentTime;

    if (at + 1 >= scenes.length) { watch.report(end); return; }

    rolling = true;
    go(at + 1, { resume: false, from: end });
  });

  // Anything started by hand means the film is playing now, so the parts after
  // it follow on without being asked.
  video.addEventListener('play', () => { rolling = true; });

  onTeardown(() => {
    video.pause();
    video.removeAttribute('src');
  });

  return {
    node,
    go,
    // The page hands its own root back, so the wide switch has something to
    // fold; the root is built after this is.
    owns: (root) => { page = root; },
  };
}

/* ----------------------------------------------------------- the chapters
 *
 * Under the player, where the scene page keeps its markers and for the same
 * reason: it is the list of places in what you are watching. Each row says
 * where that part starts in the film as a whole rather than in its own file,
 * because that is the number a person means by "about an hour in".
 */
// How far through a part you are. Read off the card rather than off the
// `progress` the shelf worked out, because the card moves as the film plays.
const through = (scene) =>
  (scene.duration ? Math.min(100, Math.round((scene.resume / scene.duration) * 100)) : 0);

function chapters(scenes, film, onPick) {
  const rows = [];
  let running = 0;

  scenes.forEach((scene, at) => {
    const starts = running;
    running += scene.duration || 0;

    const row = el('button', { className: 'chapter', type: 'button' },
      el('span', { className: 'chapterno' }, String(at + 1)),
      el('span', { className: 'chaptertext' },
        el('span', { className: 'chaptertitle' }, scene.title),
        el('span', { className: 'chapterfacts' },
          [clock(starts) || '0m', runtime(scene.duration), scene.date]
            .filter(Boolean).join(' · '))
      ),
      el('span', { className: 'chapterbar' },
        el('span', { className: 'chapterbarfill', style: `width:${through(scene)}%` })),
      el('a', {
        className: 'chapteraway',
        href: `#/library/scene/${scene.id}`,
        title: 'Open this part on its own page',
      }, '↗')
    );

    row.onclick = (event) => {
      // The corner link is a way out of the film, not a seek within it.
      if (event.target.closest('.chapteraway')) return;
      onPick(at);
    };

    rows.push(row);
  });

  const list = el('div', { className: 'chapters' }, rows);

  return {
    node: el('div', { className: 'chapterblock' },
      el('div', { className: 'chapterhead' },
        `${plural(scenes.length, 'part')} · ${runtime(film) || 'runtime unknown'} · plays straight through`),
      list),
    mark: (at) => {
      [...list.children].forEach((row, i) => {
        row.classList.toggle('on', i === at);
        const fill = row.querySelector('.chapterbarfill');
        if (fill) fill.style.width = `${through(scenes[i])}%`;
      });
      list.children[at]?.scrollIntoView({ block: 'nearest' });
    },
  };
}

/* --------------------------------------------------------------- the page */

export async function showGroup(id) {
  const mine = claim();
  loadingIn('#/library/movies');

  try {
    const [{ group, count, scenes: held }, galleryCard, origin] = await Promise.all([
      api(`/api/library/groups/${id}`),
      // Through its scenes: a gallery carries no group of its own.
      sideGalleries(`group=${id}`),
      stashOrigin(),
    ]);
    if (!holds(mine)) return;

    const scenes = ordered(held, group.name);

    if (!scenes.length) {
      shell('#/library/movies',
        el('div', { className: 'empty' }, `Stash holds no scenes for “${group.name}”.`));
      return;
    }

    // A group has no cast of its own; its cast is its scenes'.
    const cast = new Map();
    for (const scene of scenes) for (const p of scene.performers) cast.set(p.id, p);

    // The film is as long as its parts. `group.duration` is what a scraper was
    // told the release runs to, which is the right thing to fall back on and
    // the wrong thing to trust over the files actually here.
    const film = scenes.reduce((sum, s) => sum + (s.duration || 0), 0) || group.duration || 0;

    let list = null;
    const player = play(scenes, (at) => list?.mark(at));
    list = chapters(scenes, film, (at) => player.go(at));

    const facts = [
      group.date,
      group.director ? `dir. ${group.director}` : null,
      runtime(film),
      `${plural(scenes.length, 'part')}${count > scenes.length ? ` of ${count}` : ''}`,
    ].filter(Boolean);

    const main = el('div', { className: 'scenemain' },
      el('div', { className: 'stage' }, player.node),
      el('div', { className: 'scenemeta' },
        el('div', { className: 'scenehead' },
          el('div', { className: 'headtext' },
            el('h1', {}, group.name),
            el('div', { className: 'scenefacts' },
              group.studio
                ? el('a', { className: 'link', href: `#/library/studio/${group.studio.id}` }, group.studio.name)
                : null,
              facts.map((f) => el('span', {}, f))
            )
          ),
          castStrip([...cast.values()])
        ),
        list.node,
        group.synopsis ? el('p', { className: 'scenedetails' }, group.synopsis) : null
      )
    );

    const spec = [
      ['Released', day(group.date)],
      ['Studio', group.studio?.name],
      ['Director', group.director],
      ['Runtime', runtime(film)],
      ['Parts', String(scenes.length)],
    ].filter(([, value]) => value);

    const side = el('aside', { className: 'sceneside' },
      sidecard('The film',
        el('img', { className: 'filmposter', src: `/media/group/${id}`, alt: '', loading: 'lazy' }),
        el('dl', { className: 'spec' },
          spec.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, String(value))]))),
      galleryCard,
      origin
        ? sidecard('Elsewhere', el('div', { className: 'sidelinks' },
            el('a', {
              className: 'act',
              href: `${origin}/groups/${id}`,
              target: '_blank',
              rel: 'noreferrer',
            }, 'Edit in Stash ↗')))
        : null
    );

    const page = el('div', { className: 'scenepage filmpage' }, main, side);
    player.owns(page);

    shell('#/library/movies', page);

    // Nothing loads until the page is up. The first part sets the poster and
    // the bar, and then waits to be played.
    player.go(startOn(scenes), { autoplay: false });
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/movies', err);
  }
}
