/*
 * The film wall and everything behind it: the features on the share, and the
 * two editors. A group's own page plays it as one film and lives next door,
 * in group.js.
 */

import { api, el, gigabytes } from '../util.js';
import { withControls } from '../player.js';
import { claim, failedIn, holds, loadingIn, onTeardown, runtime, shell } from './core.js';
import { shelfPage } from './tiles.js';
import { blurb } from '../catalogue.js';

/*
 * Filling a group in.
 *
 * Three steps, in the order the uncertainty falls away: pick an address, let
 * Stash read it, then choose what of that to keep. They are separate on purpose
 * — a title match is a guess, a scrape of the wrong cut of a film looks right
 * until you see the cover, and this library has five groups sharing one name.
 * Nothing is written until the last button.
 *
 * The reading is done by Stash, not by this portal, and that is the whole
 * trick: data18 puts a captcha in front of a plain fetch and Adult Empire an
 * age wall, and Stash's own scrapers walk through both.
 */
async function editGroup(group, onChanged) {
  const dialog = el('dialog', { className: 'galleryedit groupedit' });
  const close = () => { dialog.close(); dialog.remove(); };

  const note = el('p', { className: 'note' });
  const box = el('input', {
    type: 'url',
    placeholder: 'https://…',
    spellcheck: false,
    value: (group.urls || []).find((u) => /data18\.com\/movies|adultempire|adultfilmdatabase/i.test(u)) || '',
  });

  const choices = el('div', { className: 'urlchoices' },
    el('p', { className: 'muted small' }, 'Looking for addresses…'));
  const preview = el('div', { className: 'scraped' });

  const read = el('button', { className: 'act primary', type: 'button' }, 'Read it');
  const apply = el('button', { className: 'act primary', type: 'button', disabled: true }, 'Save to Stash');

  // ---------------------------------------------------------- the addresses

  const offer = (url, label, why) => {
    const row = el('button', { className: 'urlchoice', type: 'button', title: url },
      el('span', { className: 'urllabel' }, label),
      el('span', { className: 'urlwhy muted small' }, why)
    );
    row.onclick = () => { box.value = url; box.focus(); };
    return row;
  };

  const short = (url) => url.replace(/^https?:\/\//, '').slice(0, 60);

  const drawChoices = (found) => {
    const rows = [];

    for (const url of group.urls || []) rows.push(offer(url, short(url), 'already on the group'));
    for (const url of rewritten(group.urls)) rows.push(offer(url, short(url), 'same shop, one Stash can read'));
    for (const hit of found) rows.push(offer(hit.url, hit.title, hit.how));

    choices.replaceChildren(
      rows.length
        ? el('div', { className: 'urllist' }, rows)
        : el('p', { className: 'muted small' }, 'Nothing found for this name. Paste an address below.')
    );
  };

  /*
   * The finding pass is slow — it obeys a thirty-second crawl delay — so the
   * dialog draws whatever has been reached rather than waiting on it, and says
   * where the pass has got to when this group is not among them yet.
   */
  api('/api/library/groups/urls')
    .then((data) => {
      const found = data.candidates?.[group.id] || null;
      drawChoices(found || []);
      if (!found && data.searching) {
        choices.append(el('p', { className: 'muted small' },
          `Still looking — ${data.looked} of ${data.total} films done.`));
      }
    })
    .catch(() => drawChoices([]));

  // ------------------------------------------------------------ the reading

  let scraped = null;
  const ticks = new Map();

  const FIELDS = [
    ['name', 'Title'], ['date', 'Date'], ['duration', 'Duration'],
    ['director', 'Director'], ['studio', 'Studio'], ['synopsis', 'Synopsis'],
  ];

  const drawScraped = () => {
    ticks.clear();
    if (!scraped) { preview.replaceChildren(); return; }

    const covers = el('div', { className: 'covers' });
    for (const [key, label] of [['front_image', 'Front'], ['back_image', 'Back']]) {
      if (!scraped[key]) continue;
      const on = el('input', { type: 'checkbox', checked: true });
      ticks.set(key, on);
      covers.append(el('label', { className: 'cover' },
        el('img', { src: scraped[key], alt: '' }),
        el('span', {}, on, ' ', label)));
    }

    const rows = [];
    for (const [key, label] of FIELDS) {
      const value = key === 'studio' ? scraped.studio?.name : scraped[key];
      if (!value) continue;

      const on = el('input', { type: 'checkbox', checked: true });
      let caveat = null;

      /*
       * Stash wants a studio id and the scraper only knows a name, so this row
       * is shown to be read and never sent. Better than hiding it: "Pure Taboo"
       * is often the thing that tells you the scrape found the right film.
       */
      if (key === 'studio') {
        on.disabled = true;
        on.checked = false;
        on.title = 'Set the studio in Stash itself';
      } else {
        ticks.set(key, on);
      }

      /*
       * The older catalogue entries print a bare year. Stash wants a full date
       * and nothing here can honestly supply the rest of one, so the row comes
       * unticked and says why rather than failing on save.
       */
      // Stash takes a bare year and stores it verbatim — checked against a real
      // write — so a year is offered like any other value, just labelled.
      if (key === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        caveat = el('span', { className: 'urlwhy muted small' }, ' year only');
      }

      rows.push(el('label', { className: 'scrapedrow' },
        on,
        el('span', { className: 'scrapedkey muted small' }, label),
        el('span', { className: 'scrapedval' }, String(value).slice(0, 400), caveat)));
    }

    preview.replaceChildren(
      el('h3', {}, 'What Stash read'),
      covers.children.length ? covers : null,
      el('div', { className: 'scrapedfields' }, rows)
    );
    apply.disabled = false;
  };

  read.onclick = async () => {
    const url = box.value.trim();
    if (!url) { note.textContent = 'Pick an address or paste one first.'; return; }

    read.disabled = true;
    apply.disabled = true;
    note.textContent = 'Asking Stash to read it…';
    try {
      const { scraped: got } = await api(`/api/library/groups/${group.id}/scrape`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      scraped = got;
      note.textContent = '';
      drawScraped();
    } catch (err) {
      scraped = null;
      preview.replaceChildren();
      note.textContent = err.message;
    } finally {
      read.disabled = false;
    }
  };

  // ------------------------------------------------------------ the writing

  apply.onclick = async () => {
    if (!scraped) return;

    /*
     * A real modal, in front of the only thing here that writes to Stash.
     *
     * On 2026-08-31 a group was written to during testing without the Save
     * button being clicked, and the cause was never found: scrapeGroupURL takes
     * no group id and cannot do it, /apply has exactly one caller, and every
     * button is type="button". Until that is explained, the write goes behind
     * something a stray programmatic click cannot satisfy — confirm() needs a
     * person. Remove this only once the mechanism is understood.
     */
    if (!window.confirm(`Write these details onto "${group.name}" in Stash?`)) return;

    // The address that produced this is kept alongside whatever was already
    // there, so a timestamp.trade link that can still size the film survives.
    const payload = {
      urls: [...new Set([...(group.urls || []), box.value.trim()])].filter(Boolean),
    };
    for (const [key, on] of ticks) if (on.checked) payload[key] = scraped[key];

    apply.disabled = true;
    note.textContent = 'Saving…';
    try {
      await api(`/api/library/groups/${group.id}/apply`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      close();
      await onChanged();
    } catch (err) {
      note.textContent = err.message;
      apply.disabled = false;
    }
  };

  dialog.append(
    el('form', { method: 'dialog' },
      el('h2', {}, group.name),
      el('p', { className: 'muted small' },
        'Give Stash an address for this film and it fills in the rest — including the cover.'),
      choices,
      el('label', {}, 'Address', box),
      preview,
      note,
      el('menu', {}, read, el('span', { className: 'spacer' }), apply,
        (() => {
          const shut = el('button', { className: 'act', type: 'button' }, 'Close');
          shut.onclick = close;
          return shut;
        })())
    )
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
}

/*
 * Adult Empire's store and data18's `empirestores` mirror are the same shop at
 * two addresses, and Stash has a scraper for one of them. So a group already
 * pointing at the mirror is one string replacement away from being scrapeable —
 * offered as a suggestion rather than rewritten underneath you.
 */
function rewritten(urls) {
  return (urls || [])
    .filter((u) => /data18\.empirestores\.co/i.test(u))
    .map((u) => u.replace(/^https?:\/\/data18\.empirestores\.co/i, 'https://www.adultempire.com'));
}

/*
 * One film. Same furniture as the scene page — a player at the top and the
 * facts under it — but everything comes off the mount, so there is no resume
 * position and no organised flag: Stash is not involved and has nothing to
 * remember on this one's behalf.
 */
function renderMovie(movie) {
  /*
   * Fanart for the still, not the poster: the poster is portrait and a 2:3
   * image letterboxed into a 16:9 stage looks like a mistake.
   */
  const still = movie.fanart
    ? `/media/moviefile/${movie.id}/fanart`
    : movie.hasPoster ? `/media/moviefile/${movie.id}/poster` : null;

  const video = el('video', {
    className: 'player',
    src: `/media/moviefile/${movie.id}/file`,
    controls: true,
    preload: 'metadata',
    playsInline: true,
    ...(still ? { poster: still } : {}),
  });

  /*
   * Resume, the same contract as the scene player — except there is no Stash
   * behind this one, so the position goes to a small store beside the config
   * instead. Picking up mid-film matters more here than on a scene: nobody
   * watches two and a half hours in one sitting.
   */
  video.addEventListener('loadedmetadata', () => {
    const duration = video.duration || movie.duration || 0;
    const finished = duration && movie.resume > duration - 60;
    if (movie.resume > 10 && !finished) video.currentTime = movie.resume;
  }, { once: true });

  let counted = false;

  video.addEventListener('play', () => {
    if (counted) return;
    counted = true;
    api(`/api/moviefiles/${movie.id}/play`, { method: 'POST' }).catch(() => {});
  });

  const payload = () =>
    JSON.stringify({ resume: video.currentTime, duration: video.duration || movie.duration || null });

  const report = () => {
    if (!counted || !video.currentTime) return;
    api(`/api/moviefiles/${movie.id}/activity`, { method: 'POST', body: payload() }).catch(() => {});
  };

  // A fetch does not survive the page going away; a beacon does.
  const beacon = () => {
    if (!counted || !video.currentTime) return;
    navigator.sendBeacon(
      `/api/moviefiles/${movie.id}/activity`,
      new Blob([payload()], { type: 'application/json' })
    );
  };

  const timer = setInterval(report, 15000);
  video.addEventListener('pause', report);
  window.addEventListener('pagehide', beacon);

  onTeardown(() => {
    clearInterval(timer);
    window.removeEventListener('pagehide', beacon);
    report();
    video.pause();
    video.removeAttribute('src');
  });

  /*
   * Containers are not the useful test — this library is mostly hevc in .mkv
   * and it plays here. What matters is whether *this* browser managed it, so
   * the warning waits to be earned rather than being guessed up front.
   */
  const cannotPlay = el('p', { className: 'note', hidden: true },
    'Your browser could not decode this file. Open it in another player.');
  video.addEventListener('error', () => { cannotPlay.hidden = false; });

  const facts = [
    movie.year,
    runtime(movie.duration),
    movie.resolution,
    movie.videoCodec,
    movie.size ? gigabytes(movie.size) : null,
    movie.certification,
    movie.rating ? `★ ${movie.rating}` : null,
  ].filter(Boolean);

  return [
    // No sprite sheet on this side: the film comes off the mount rather than
    // out of Stash, so there is nothing to have generated one. The bar is the
    // same otherwise — the thumbnails are the part that goes missing.
    el('div', { className: 'stage' }, withControls(video, { duration: movie.duration || 0 })),
    el('div', { className: 'scenepage' },
      el('h1', {}, movie.title),
      el('div', { className: 'scenefacts' },
        movie.studio ? el('span', {}, movie.studio) : null,
        movie.director ? el('span', {}, `dir. ${movie.director}`) : null,
        facts.map((f) => el('span', {}, f))
      ),
      cannotPlay,
      movie.plot ? el('p', { className: 'scenedetails' }, movie.plot) : null,
      movie.cast.length
        ? el('div', { className: 'castrow' },
            movie.cast.map((p) => el('span', { className: 'tagchip flat', title: p.role || '' }, p.name)))
        : null,
      movie.genres.length
        ? el('div', { className: 'tagrow' },
            movie.genres.map((g) => el('span', { className: 'tagchip flat' }, g)))
        : null,
      !movie.hasNfo || !movie.hasPoster ? gapPanel(movie) : null,
      el('p', { className: 'filepath' }, `${movie.folder}/${movie.file}`)
    ),
  ];
}

/* ------------------------------------------------------------- gap-filler
 *
 * The one place the portal offers to write to the share. It is a panel and not
 * a button because the choice is the point: matching is on a title someone
 * typed into a folder name, so the candidates get shown with their posters and
 * a person decides. Nothing is written until one is picked, and an existing
 * file is never replaced.
 */

function gapPanel(movie) {
  const missing = [!movie.hasNfo && 'no .nfo', !movie.hasPoster && 'no poster'].filter(Boolean).join(', ');

  const panel = el('div', { className: 'gappanel' });
  const status = el('p', { className: 'note' },
    `Emby never matched this one — ${missing}. Everything above was read off the folder name.`);

  const find = el('button', { className: 'act', type: 'button' }, 'Find metadata');
  const row = el('div', { className: 'sceneactions' }, find);

  /*
   * The default follows the hierarchy — ThePornDB, then TMDB, then the IMDB id
   * out of the .nfo. These force one source instead, because a source that
   * answered is not necessarily the source that was right.
   */
  const search = async (only, button) => {
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    const was = button.textContent;
    button.textContent = 'Searching…';

    try {
      const query = only ? `?source=${only}` : '';
      const { candidates, source, asked, sources } = await api(`/api/moviefiles/${movie.id}/candidates${query}`);

      panel.querySelector('.candidates')?.remove();
      panel.querySelector('.sourcenote')?.remove();

      const from = { tpdb: 'ThePornDB', tmdb: 'TMDB', imdb: 'IMDB id, via TMDB' }[source] || source;
      panel.append(el('p', { className: 'note sourcenote' }, candidates.length
        ? `${candidates.length} from ${from}${asked && asked !== movie.title ? ` — searched “${asked}”` : ''}`
        : `${from} has nothing under that title.`));

      if (candidates.length) {
        panel.append(el('div', { className: 'candidates' },
          candidates.map((c) => candidateCard(movie, c, status))));
      }

      // Once there is a result, the other sources become a way to disagree
      // with it rather than a fallback nobody would ever reach.
      if (!row.dataset.expanded) {
        row.dataset.expanded = '1';
        if (sources?.tmdb) row.append(sourceButton('tmdb', 'Try TMDB'));
        if (sources?.tmdb && movie.ids?.imdb) row.append(sourceButton('imdb', 'Use the IMDB id'));
        if (only) row.append(sourceButton(null, 'Back to the usual order'));
      }
    } catch (err) {
      status.textContent = err.message;
    } finally {
      for (const b of row.querySelectorAll('button')) b.disabled = false;
      button.textContent = was;
    }
  };

  function sourceButton(only, label) {
    const button = el('button', { className: 'act', type: 'button' }, label);
    button.onclick = () => search(only, button);
    return button;
  }

  find.onclick = () => search(null, find);

  panel.append(status, row);
  return panel;
}

function candidateCard(movie, candidate, status) {
  /*
   * Through the portal, not straight from the studio's host: these posters sit
   * behind members areas and hotlink checks, and half of them would be broken
   * images otherwise. If one still fails, fall back to the backdrop and then to
   * a placeholder rather than leaving a blank frame.
   */
  const proxied = (u) => `/media/candidate?url=${encodeURIComponent(u)}`;
  const first = candidate.poster || candidate.background;

  const art = el('div', { className: 'candart' });
  if (first) {
    const img = el('img', { src: proxied(first), loading: 'lazy', alt: '' });
    let fallbackTried = false;
    img.addEventListener('error', () => {
      if (!fallbackTried && candidate.background && candidate.background !== first) {
        fallbackTried = true;
        img.src = proxied(candidate.background);
        return;
      }
      img.replaceWith(el('span', { className: 'facetblank' }, '?'));
    });
    art.append(img);
  } else {
    art.append(el('span', { className: 'facetblank' }, '?'));
  }

  const use = el('button', { className: 'act primary', type: 'button' }, 'Use this');

  use.onclick = async () => {
    use.disabled = true;
    use.textContent = 'Writing…';
    try {
      const result = await api(`/api/moviefiles/${movie.id}/metadata`, {
        method: 'POST',
        body: JSON.stringify({ source: candidate.source, id: candidate.id }),
      });

      const wrote = result.wrote.length ? `Wrote ${result.wrote.join(', ')}.` : 'Wrote nothing new.';
      const left = result.skipped.length ? ` Left alone: ${result.skipped.join(', ')}.` : '';
      // A studio host refusing a hotlink is common and is not a failed apply —
      // the .nfo still landed, and the other source usually has the picture.
      const bad = result.failed?.length
        ? ` Could not fetch: ${result.failed.join(', ')} — try the other source for the artwork.`
        : '';
      status.textContent = `${wrote}${left}${bad} Reload to see it.`;
      use.textContent = 'Done';
      use.className = 'act on';
    } catch (err) {
      use.disabled = false;
      use.textContent = 'Use this';
      status.textContent = err.message;
    }
  };

  return el('article', { className: 'candidate' },
    art,
    el('div', { className: 'candbody' },
      el('div', { className: 'title' }, candidate.title),
      el('div', { className: 'meta' },
        [candidate.siteName, candidate.date, candidate.duration ? candidate.duration + ' min' : null]
          .filter(Boolean).join(' · ')),
      use
    )
  );
}

export async function showMovie(movieId) {
  const mine = claim();
  loadingIn('#/library/movies');
  try {
    const { movie } = await api(`/api/moviefiles/${movieId}`);
    if (!holds(mine)) return;
    shell('#/library/movies', renderMovie(movie));
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/movies', err);
  }
}

/* ============================================================ the film wall
 *
 * One shelf for both kinds of film. A group is a release made of several scene
 * files; a feature is one long file that is the whole release. They are
 * different objects in Stash and the same thing to a person browsing, so they
 * share a card and the card says which it is.
 *
 * Always portrait. Group box art and the posters now sitting on the features
 * are both 2:3, and a poster wall is what a film library looks like — the 16:9
 * still belongs on the Scenes shelf, where the subject is a moment rather than
 * a release.
 *
 * Everything filters in the browser. The whole shelf arrives in one response,
 * so narrowing by tag or performer is instant and costs no round trip; see
 * films.mjs for why that ceiling is deliberate.
 */

const KIND_ICON = { group: '⛓', film: '▤' };
const KIND_WORD = { group: 'Several scenes', film: 'One file' };

function filmRuntime(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function filmCard(film, onChanged) {
  const about = blurb(film.details, film.title, 140);

  const art = el('div', { className: 'facetart' },
    el('img', { src: film.cover, loading: 'lazy', alt: '' })
  );

  /*
   * Top left, as asked. It is the one thing about a card you cannot work out by
   * looking at the picture, and it says what you are about to get — a group is
   * several files played through as one film, a feature is the one file.
   */
  art.append(el('span', {
    className: 'kindmark ' + film.kind,
    title: KIND_WORD[film.kind] + (film.kind === 'group' ? ` (${film.sceneCount})` : ''),
  }, KIND_ICON[film.kind]));

  if (film.resume > 60) {
    art.append(el('div', { className: 'tileprogress' },
      el('div', { className: 'tileprogressbar', style: `width:${Math.min(100, Math.round((film.resume / (film.duration || film.resume)) * 100))}%` })));
  }

  const node = el('article', { className: 'facet film' },
    art,
    el('div', { className: 'facetbody' },
      el('div', { className: 'title' }, film.title),
      el('div', { className: 'meta' }, [
        film.year,
        film.studio?.name,
        filmRuntime(film.duration),
        film.kind === 'group' ? `${film.sceneCount} scenes` : film.resolution,
      ].filter(Boolean).join(' · ')),
      // What it is about — a group's synopsis, a feature's scene details. Cut
      // by the same rule as the scene tile, and to the same length: these
      // posters sit in the same size grid.
      about ? el('div', { className: 'facetdesc' }, about) : null
    )
  );

  node.onclick = () => { location.hash = film.href; };
  node.dataset.name = String(film.title).toLowerCase();

  /*
   * Both, because both are asked for and they are not the same gesture: the
   * pencil is for when you have stopped to look at one film, the row underneath
   * is for working along a shelf doing the same thing to several.
   */
  const edit = el('button', { className: 'facetedit', type: 'button', title: 'Edit this film' }, '✎');
  edit.onclick = (event) => { event.stopPropagation(); editFilm(film, onChanged); };
  art.append(edit);

  const act = (label, hint, run) => {
    const b = el('button', { className: 'cardact', type: 'button', title: hint }, label);
    b.onclick = (event) => { event.stopPropagation(); run(); };
    return b;
  };

  node.append(el('div', { className: 'cardacts' },
    act('✎', 'Edit', () => editFilm(film, onChanged)),
    act('🖼', 'Change the cover', () => editFilm(film, onChanged, 'cover')),
    act('⟳', 'Rescan metadata', () => editFilm(film, onChanged, 'rescan')),
    act('🗑', 'Remove from Stash', () => editFilm(film, onChanged, 'delete'))
  ));

  return node;
}

/* ------------------------------------------------------------ the filters
 *
 * The shelf's bar, not one of its own. Movies used to carry an older,
 * film-shaped copy of the same idea — a search, five dropdowns, a sort and a
 * Clear — written before the shelves shared one, and the two had already
 * drifted: its dropdowns counted the whole wall rather than what the other
 * filters left, its state was a module variable rather than the address, and
 * it had no Random. So this is the same furniture the Scenes shelf and a
 * category wear, asked of films.
 *
 * Narrowed by name rather than by Stash id, because that is what a dropdown
 * built out of what is in front of it can count. Two studios sharing a name
 * would fold together, which has never happened here and reads better than an
 * id ever did.
 */

const FILM_FACETS = [
  { key: 'kind', any: 'Any kind', of: (f) => [KIND_WORD[f.kind]] },
  { key: 'studio', any: 'Any studio', of: (f) => (f.studio ? [f.studio.name] : []) },
  { key: 'performer', any: 'Anyone', of: (f) => f.performers.map((p) => p.name) },
  { key: 'tag', any: 'Any tag', of: (f) => f.tags.map((t) => t.name) },
  { key: 'year', any: 'Any year', of: (f) => (f.year ? [String(f.year)] : []) },
];

// Title first: a film wall is a shelf you read along, and the first sort is
// also what Clear goes back to.
const FILM_SORTS = [
  ['title', 'Title'],
  ['date', 'Newest'],
  ['duration', 'Longest'],
  ['scenes', 'Most scenes'],
];

function orderFilms(films, sort) {
  const by = [...films];
  if (sort === 'date') return by.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  if (sort === 'duration') return by.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  if (sort === 'scenes') return by.sort((a, b) => b.sceneCount - a.sceneCount);
  return by.sort((a, b) => a.title.localeCompare(b.title));
}

// The same words the scene shelf searches: what you would say out loud looking
// for a film. Tags have their own dropdown and stay out of it.
const shapeFilm = (film) => ({
  ...film,
  haystack: [film.title, film.studio?.name, ...film.performers.map((p) => p.name)]
    .filter(Boolean).join(' ').toLowerCase(),
});

/* --------------------------------------------------------------- the page */

export async function showMovies(query = '') {
  const mine = claim();
  loadingIn('#/library/movies');
  try {
    const data = await api('/api/library/films');
    if (!holds(mine)) return;
    drawFilms(mine, data, query);
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/movies', err);
  }
}

// The filters live in the address, so a redraw after a delete or a new cover
// puts you back on the shelf you were reading.
const filtersNow = () => location.hash.split('?')[1] || '';

function drawFilms(mine, data, query) {
  /*
   * After a delete or a new cover the shelf is re-read and the page rebuilt
   * rather than patched: a cover change alters a URL the browser has already
   * cached, the counts move when something goes, and the bar is built from the
   * films it is offering.
   */
  const reload = async () => {
    const fresh = await api('/api/library/films');
    if (!holds(mine)) return;
    drawFilms(mine, fresh, filtersNow());
  };

  shell('#/library/movies', shelfPage({
    section: '#/library/movies',
    title: 'Movies',
    note: `films · ${data.counts.groups} in scenes, ${data.counts.features} single file`,
    placeholder: 'Search this shelf…',
    items: data.films.map(shapeFilm),
    facets: FILM_FACETS,
    sorts: FILM_SORTS,
    order: orderFilms,
    wall: 'facets posters',
    card: (film) => filmCard(film, reload),
    query,
  }));
}

/* --------------------------------------------------------- editing one film
 *
 * Delete and cover live here. Both write, so both sit behind the same native
 * confirm the group dialog uses — see editGroup for why that guard exists.
 */
async function editFilm(film, onChanged, focus = null) {
  const dialog = el('dialog', { className: 'galleryedit filmedit' });
  const close = () => { dialog.close(); dialog.remove(); };
  const note = el('p', { className: 'note' });

  const shot = el('img', { className: 'filmposter', src: film.cover, alt: '' });

  const covers = el('div', { className: 'coverpick' });
  if (film.kind === 'film') {
    for (const [which, label] of [['poster', 'Emby poster'], ['fanart', 'Emby fanart']]) {
      const b = el('button', { className: 'act', type: 'button' }, label);
      b.onclick = async () => {
        note.textContent = 'Setting…';
        try {
          const r = await api('/api/library/identify/covers', {
            method: 'POST',
            body: JSON.stringify({ which, apply: true, only: [film.id] }),
          });
          if (!r.pushed) throw new Error(r.skippedRows?.[0]?.why || 'nothing to set');
          // Same URL, new bytes — the browser needs telling.
          shot.src = film.cover + '?v=' + Date.now();
          note.textContent = `Cover set from ${label}.`;
        } catch (err) { note.textContent = err.message; }
      };
      covers.append(b);
    }
  } else {
    const b = el('button', { className: 'act', type: 'button' }, 'Scrape it from a URL…');
    b.onclick = () => { close(); editGroup({ id: film.id, name: film.title, urls: film.urls }, onChanged); };
    covers.append(b);
  }

  const withFile = el('input', { type: 'checkbox' });
  const remove = el('button', { className: 'act danger', type: 'button' }, 'Remove from Stash');
  remove.onclick = async () => {
    const alsoFile = film.kind === 'film' && withFile.checked;
    const warn = alsoFile
      ? `Delete "${film.title}" from Stash AND erase the file from disk? This cannot be undone.`
      : `Remove "${film.title}" from Stash? The file stays on disk.`;
    if (!window.confirm(warn)) return;

    note.textContent = 'Removing…';
    try {
      await api(`/api/library/films/${film.kind}/${film.id}/delete`, {
        method: 'POST',
        body: JSON.stringify({ deleteFile: alsoFile }),
      });
      close();
      await onChanged();
    } catch (err) { note.textContent = err.message; }
  };

  /* ------------------------------------------------------------- rescanning
   *
   * Stash's scrapers rather than TMDB, which barely knows this catalogue. The
   * film scrapers describe a *release*, which is right for both kinds — a
   * single-file feature is a release that happens to be one file, so the same
   * record maps onto it.
   *
   * Same three steps as the group dialog and for the same reason: find an
   * address, let Stash read it, then choose what of it to keep. Nothing is
   * written before the last button.
   */
  const urlBox = el('input', {
    type: 'url', placeholder: 'https://\u2026', spellcheck: false,
    value: (film.urls || [])[0] || '',
  });
  const found = el('div', { className: 'urlchoices' });
  const scrapedBox = el('div', { className: 'scraped' });
  const ticks = new Map();
  let scraped = null;

  const look = el('button', { className: 'act', type: 'button' }, 'Find it');
  look.onclick = async () => {
    look.disabled = true;
    found.replaceChildren(el('p', { className: 'muted small' }, 'Looking\u2026'));
    try {
      const { candidates } = await api(
        '/api/library/films/lookup?title=' + encodeURIComponent(film.title) +
        (film.date ? '&date=' + encodeURIComponent(film.date) : ''));

      found.replaceChildren(candidates.length
        ? el('div', { className: 'urllist' }, candidates.map((c) => {
            const row = el('button', { className: 'urlchoice', type: 'button', title: c.url },
              el('span', { className: 'urllabel' }, c.title),
              el('span', { className: 'urlwhy muted small' }, c.how));
            row.onclick = () => { urlBox.value = c.url; urlBox.focus(); };
            return row;
          }))
        : el('p', { className: 'muted small' }, 'Nothing found under that title. Paste an address instead.'));
    } catch (err) {
      found.replaceChildren(el('p', { className: 'muted small' }, err.message));
    } finally {
      look.disabled = false;
    }
  };

  const SCRAPED_FIELDS = [['name', 'Title'], ['date', 'Date'], ['director', 'Director'], ['synopsis', 'Synopsis']];

  const readIt = el('button', { className: 'act primary', type: 'button' }, 'Read it');
  const save = el('button', { className: 'act primary', type: 'button', disabled: true }, 'Save to Stash');

  readIt.onclick = async () => {
    const url = urlBox.value.trim();
    if (!url) { note.textContent = 'Pick an address or paste one first.'; return; }

    readIt.disabled = true;
    save.disabled = true;
    note.textContent = 'Asking Stash to read it\u2026';
    try {
      const r = await api('/api/library/films/' + film.kind + '/' + film.id + '/scrape',
        { method: 'POST', body: JSON.stringify({ url }) });
      scraped = r.scraped;
      ticks.clear();

      const rows = [];
      if (scraped.front_image) {
        const on = el('input', { type: 'checkbox', checked: true });
        ticks.set('front_image', on);
        rows.push(el('label', { className: 'scrapedrow' }, on,
          el('span', { className: 'scrapedkey muted small' }, 'Cover'),
          el('img', { className: 'coverthumb', src: scraped.front_image, alt: '' })));
      }
      for (const [key, label] of SCRAPED_FIELDS) {
        if (!scraped[key]) continue;
        const on = el('input', { type: 'checkbox', checked: true });
        ticks.set(key, on);
        rows.push(el('label', { className: 'scrapedrow' }, on,
          el('span', { className: 'scrapedkey muted small' }, label),
          el('span', { className: 'scrapedval' }, String(scraped[key]).slice(0, 400))));
      }
      // Shown to be read, never sent: the scraper knows a name, Stash wants an id.
      if (scraped.studio && scraped.studio.name) {
        rows.push(el('label', { className: 'scrapedrow' },
          el('input', { type: 'checkbox', disabled: true, title: 'Set the studio in Stash itself' }),
          el('span', { className: 'scrapedkey muted small' }, 'Studio'),
          el('span', { className: 'scrapedval' }, scraped.studio.name)));
      }

      scrapedBox.replaceChildren(el('h3', {}, 'What Stash read'),
        el('div', { className: 'scrapedfields' }, rows));
      note.textContent = '';
      save.disabled = false;
    } catch (err) {
      scraped = null;
      scrapedBox.replaceChildren();
      note.textContent = err.message;
    } finally {
      readIt.disabled = false;
    }
  };

  save.onclick = async () => {
    if (!scraped) return;
    // The same guard the group dialog carries; see editGroup for why it is here.
    if (!window.confirm('Write these details onto "' + film.title + '" in Stash?')) return;

    const fields = { existingUrls: film.urls || [] };
    for (const [key, on] of ticks) if (on.checked) fields[key] = scraped[key];

    save.disabled = true;
    note.textContent = 'Saving\u2026';
    try {
      await api('/api/library/films/' + film.kind + '/' + film.id + '/apply',
        { method: 'POST', body: JSON.stringify({ fields, url: urlBox.value.trim() }) });
      close();
      await onChanged();
    } catch (err) {
      note.textContent = err.message;
      save.disabled = false;
    }
  };

  dialog.append(
    el('form', { method: 'dialog' },
      el('h2', {}, film.title),
      el('p', { className: 'muted small' },
        [KIND_WORD[film.kind], film.year, film.studio?.name, filmRuntime(film.duration)].filter(Boolean).join(' · ')),
      el('div', { className: 'filmedrow' },
        shot,
        el('div', {},
          el('h3', {}, 'Cover'),
          covers,
          el('h3', {}, 'Remove'),
          film.kind === 'film'
            ? el('label', { className: 'confirmrow' }, withFile,
                el('span', { className: 'muted small' }, 'also erase the file from disk'))
            : el('p', { className: 'muted small' }, 'A group is a record about scenes; no files are touched.'),
          remove
        )
      ),
      el('h3', {}, 'Rescan metadata'),
      el('p', { className: 'muted small' },
        'Stash reads the address with its own scrapers \u2014 data18, Adult Empire, Bang, AdultFilmDatabase.'),
      el('div', { className: 'coverpick' }, look),
      found,
      el('label', {}, 'Address', urlBox),
      scrapedBox,
      note,
      el('menu', {}, readIt, el('span', { className: 'spacer' }), save,
        (() => { const shut = el('button', { className: 'act', type: 'button' }, 'Close'); shut.onclick = close; return shut; })())
    )
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  if (focus === 'delete') remove.focus();
  if (focus === 'rescan') look.click();
}
