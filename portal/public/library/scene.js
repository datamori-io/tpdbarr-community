/* The video page: player, controls, and the reading rail. */

import { api, clock, el, gigabytes } from '../util.js';
import { thumbnailCues, withControls } from '../player.js';
import { markHere } from '../markertag.js';
import { claim, day, failedIn, filedAndStars, holds, initial, loading, loadingIn, mbps, onTeardown, plural, shell, sidecard, stashOrigin } from './core.js';
import { scenePicker } from './categories.js';
import { buildPanel, sideGalleries } from './galleries.js';
import { rail } from './tiles.js';

/*
 * ---------------------------------------------------------------- the scene
 *
 * Playback position is written back to Stash, so Continue watching matches Stash.
 */

const REPORT_EVERY = 15000;

function playerFor(scene, onWide = null) {
  const video = el('video', {
    className: 'player',
    src: `/media/scene/${scene.id}/stream`,
    poster: `/media/scene/${scene.id}/screenshot`,
    controls: true,
    preload: 'metadata',
    playsInline: true,
  });

  // Pick up where you left off — unless that was the last half minute, which
  // means you finished it and want it from the top.
  video.addEventListener('loadedmetadata', () => {
    const done = scene.duration && scene.resume > scene.duration - 30;
    if (scene.resume > 2 && !done) video.currentTime = scene.resume;
  }, { once: true });

  let counted = false;
  let watched = 0;
  let mark = null;

  video.addEventListener('timeupdate', () => {
    if (video.paused) return;
    const now = video.currentTime;
    // Only count real elapsed time; a seek is not two minutes of watching.
    if (mark !== null && now > mark && now - mark < 2) watched += now - mark;
    mark = now;
  });

  video.addEventListener('play', () => {
    mark = video.currentTime;
    if (!counted) {
      counted = true;
      api(`/api/library/scenes/${scene.id}/play`, { method: 'POST' }).catch(() => {});
    }
  });

  const payload = () => JSON.stringify({ resume: video.currentTime, played: watched });

  const report = () => {
    if (!counted) return;
    api(`/api/library/scenes/${scene.id}/activity`, { method: 'POST', body: payload() }).catch(() => {});
    watched = 0;
  };

  // Closing the tab gets a beacon; it survives the page going away, a fetch
  // does not.
  const beacon = () => {
    if (!counted) return;
    navigator.sendBeacon(
      `/api/library/scenes/${scene.id}/activity`,
      new Blob([payload()], { type: 'application/json' })
    );
  };

  const timer = setInterval(report, REPORT_EVERY);
  video.addEventListener('pause', report);
  window.addEventListener('pagehide', beacon);

  onTeardown(() => {
    clearInterval(timer);
    window.removeEventListener('pagehide', beacon);
    report();
    video.pause();
    video.removeAttribute('src');
  });

  /* Return the video too; the marker list seeks it. */
  return {
    video,
    node: withControls(video, {
      // The portal proxies the sprite pair (named by file hash) and rewrites the vtt.
      thumbnails: scene.vtt ? `/media/scene/${scene.id}/vtt` : null,
      markers: scene.markers || [],
      duration: scene.duration || 0,
      onWide,
      /*
       * Add a marker while watching: the same prompt and write as `t` on the
       * bench. The player adds it to its own track; the page list updates on the
       * next visit.
       */
      onMark: async (seconds) => {
        try {
          const made = await markHere(scene.id, seconds);
          if (!made) return null;

          /* A hand-cut marker's title is empty; label it with its tag, as stashlib does. */
          const shown = {
            id: made.id,
            title: made.tag?.name || made.title || 'Marker',
            seconds: made.seconds,
          };

          scene.markers = [...(scene.markers || []), shown].sort((a, b) => a.seconds - b.seconds);
          return shown;
        } catch (err) {
          window.alert(err.message);
          return null;
        }
      },
    }),
  };
}

// The scene keeps one of its own on the end: nothing counts an O for a gallery.
function actions(scene, redraw) {
  const row = el('div', { className: 'sceneactions' },
    filedAndStars(scene, `/api/library/scenes/${scene.id}`, redraw));

  const o = el('button', { className: 'act', type: 'button' }, `O ${scene.oCount}`);
  o.onclick = async () => {
    const next = await api(`/api/library/scenes/${scene.id}/o`, { method: 'POST' }).catch(() => null);
    if (next) { scene.oCount = next.oCount; o.textContent = `O ${next.oCount}`; }
  };
  row.append(o);

  return row;
}

/* "Find more": TPDB id -> this portal's acquisition page, StashDB id -> v3. */
function findMore(scene) {
  if (scene.identity.tpdb) {
    return el('a', { className: 'act', href: `#/scene/${scene.identity.tpdb}` }, 'Find more on ThePornDB');
  }
  if (scene.identity.stashdb) {
    return el('a', {
      className: 'act',
      href: `https://stashdb.org/scenes/${scene.identity.stashdb}`,
      target: '_blank',
      rel: 'noreferrer',
    }, 'On StashDB ↗');
  }
  return el('span', { className: 'act muted', title: 'Stash has not identified this scene' }, 'Unidentified');
}

/*
 * ------------------------------------------------------------- whisparr v3
 *
 * Asked after the page draws; a down v3 costs a badge. No button until v3 answers.
 */
const V3_LABEL = {
  downloaded: 'In Whisparr v3',
  monitored: 'Monitored in v3',
  known: 'Known to v3, not monitored',
};

const AGAIN_HELP =
  'Monitors this scene in Whisparr v3 and searches again. Nothing is deleted — '
  + 'the file you have stays where it is until something better has actually landed.';

function whisparr3Slot(scene) {
  if (!scene.identity.stashdb) return null;

  const stashId = scene.identity.stashdb;
  const slot = el('span', { className: 'act muted' }, 'Checking Whisparr v3…');

  /* One button, one request; `done` reads the answer to report what happened. */
  const asks = (path, label, working, done, className = 'act primary') => {
    const button = el('button', { className, type: 'button' }, label);
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = working;
      try {
        // `force`: this is a scene on your own shelf, so the server's "Stash
        // already has it" check (heldguard.mjs) is not news here.
        const result = await api(`/api/whisparr3/scenes/${stashId}${path}`,
          { method: 'POST', body: JSON.stringify({ force: true }) });
        button.textContent = done(result, button);
        button.className = 'act on';
        button.disabled = false;
      } catch (err) {
        button.textContent = err.message;
        button.className = 'act muted';
        button.disabled = false;
      }
    };
    return button;
  };

  /* "Get me another" on a scene v3 already holds. Stays after use. */
  const again = () => {
    const button = asks(
      '/again',
      'Ask for another file',
      'Asking…',
      () => 'Searching for another file',
      'act'
    );
    button.title = AGAIN_HELP;
    return button;
  };

  // An add is also an ask, so the follow-up ask appears beside it once it lands.
  const add = (label) => asks('', label, 'Sending…', (result, button) => {
    button.after(again());
    return result.searched ? 'Monitored, searching' : 'Monitored in v3';
  });

  api(`/api/whisparr3/scenes/${stashId}`)
    .then((state) => {
      if (state.status === 'absent' || state.status === 'known') {
        slot.replaceWith(add(state.status === 'absent' ? 'Send to Whisparr v3' : 'Monitor in v3'));
        return;
      }

      const badge = el('span', { className: 'act on', title: state.path || '' }, V3_LABEL[state.status]);
      slot.replaceWith(badge, again());
    })
    // A v3 that is not set up is the common case, not an error worth shouting.
    .catch(() => slot.remove());

  return slot;
}

/* Cast as faces; Stash's silhouette is replaced with an initial. */
function castFace(p) {
  return el('a', { className: 'castling', href: `#/library/performer/${p.id}` },
    el('div', { className: 'castart' },
      p.art
        ? el('img', { src: `/media/performer/${p.id}`, loading: 'lazy', alt: '' })
        : el('span', { className: 'castblank' }, initial(p.name)),
      p.favorite ? el('span', { className: 'fav', title: 'Favourite in Stash' }, '★') : null
    ),
    el('span', { className: 'castname' }, p.name)
  );
}

/* The cast beside the title, right-aligned, scrolling sideways if long. */
export function castStrip(performers) {
  if (!performers.length) return null;
  return el('div', { className: 'headcast' },
    el('div', { className: 'castfaces' }, performers.map(castFace)));
}

/* The file as a spec list. */
function fileCard(scene) {
  const f = scene.file;
  const rows = [
    ['Resolution', scene.resolution],
    ['Video', f?.videoCodec],
    ['Audio', f?.audioCodec],
    ['Size', f ? gigabytes(f.size) : null],
    ['Frame rate', f?.frameRate ? `${Math.round(f.frameRate * 100) / 100} fps` : null],
    ['Bitrate', mbps(f?.bitRate)],
    ['Added', day(scene.addedAt)],
    ['Last played', day(scene.lastPlayed)],
    ['Plays', scene.plays || null],
  ].filter(([, value]) => value);

  if (!rows.length && !f) return null;

  return sidecard('File',
    rows.length
      ? el('dl', { className: 'spec' },
          rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, String(value))]))
      : null,
    f ? el('p', { className: 'filepath' }, f.path) : null,
    shrinkRow(scene)
  );
}

/*
 * Downscale, on the file card. The only control here that destroys
 * anything: it says what it will do, asks, and shows progress while
 * running. See downscale.mjs.
 */
/* Sizes in MB where GB would round to nothing. */
const sized = (bytes) => {
  if (!bytes) return '0 MB';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
};

function shrinkRow(scene) {
  const row = el('div', { className: 'shrink' });
  let watching = null;

  const stop = () => { clearTimeout(watching); watching = null; };
  onTeardown(stop);

  const said = (text, bad = false) =>
    el('div', { className: 'muted small' + (bad ? ' bad' : '') }, text);

  /* While any encode runs, this row shows it (one at a time, server-side). */
  const watch = (found) => {
    if (found.running || found.step === 'done' || found.step === 'failed') {
      const mine = String(found.sceneId) === String(scene.id);
      const where = mine ? 'this file' : `scene ${found.sceneId}`;

      if (found.step === 'failed') {
        row.replaceChildren(said(`Re-encode failed — ${found.error}`, true), buttons());
        return;
      }

      if (found.step === 'done' && mine) {
        const saved = found.was && found.now ? ` — ${sized(found.was)} down to ${sized(found.now)}` : '';
        row.replaceChildren(said(`Re-encoded${saved}. Reload the page to see the new file.`));
        return;
      }

      if (found.running) {
        const step = found.step === 'encoding'
          ? `Re-encoding ${where} to ${found.height}p — ${found.percent}%`
          : `${found.step} ${where}…`;
        row.replaceChildren(said(step));
        stop();
        watching = setTimeout(poll, 2000);
        return;
      }
    }

    row.replaceChildren(buttons());
  };

  const poll = () => {
    api('/api/library/downscale').then(watch).catch(() => {});
  };

  /*
   * Choices from resolution.mjs: unfiled scenes remember them; filed scenes
   * act now. 720p is the default.
   */
  const label = (value) => (value === 'keep' ? 'Keep as is' : `${value}p`);

  const send = (body) => api(`/api/library/scenes/${scene.id}/resolution`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  function buttons() {
    const holder = el('div', { className: 'shrinkbuttons' });

    api(`/api/library/scenes/${scene.id}/resolution`).then((found) => {
      if (!found.options.length) {
        holder.replaceChildren(el('span', { className: 'muted small' }, found.reason));
        return;
      }
      holder.replaceChildren(...(found.filed ? filedChoices(found) : laterChoices(found)));
    }).catch(() => {
      holder.replaceChildren(el('span', { className: 'muted small' }, 'Could not read the file.'));
    });

    return holder;
  }

  const chip = (option, on) => el('button', {
    className: 'chip quiet' + (on ? ' on' : '') + (option.default ? ' default' : ''),
    type: 'button',
    disabled: !option.can,
    title: option.why || '',
  }, label(option.value), option.default ? el('span', { className: 'chipnote' }, ' default') : null);

  // Not filed yet: pick what filing should do. Nothing is touched until then,
  // so there is nothing to confirm.
  function laterChoices(found) {
    const current = found.pending ?? 720;
    return [
      el('span', { className: 'muted small' }, 'When filed'),
      ...found.options.map((option) => {
        const button = chip(option, option.value === current);
        button.onclick = async () => {
          try {
            await send({ choice: option.value });
            row.replaceChildren(buttons());
          } catch (err) {
            row.replaceChildren(said(err.message, true), buttons());
          }
        };
        return button;
      }),
      said(current === 720
        ? 'FileFlows takes it to 720p once it is filed.'
        : `${label(current)}: a .fileflows-ignore goes in its folder before the file does, so FileFlows leaves it alone.`),
    ];
  }

  /*
   * Filed: Keep is one press (writes the flag); an encode is two. Not a
   * dialog: the app's browser answers confirm() with no.
   */
  function filedChoices(found) {
    const out = [el('span', { className: 'muted small' }, found.flagged ? 'Kept from FileFlows' : 'Now')];

    for (const option of found.options) {
      const keeping = option.value === 'keep';
      if (keeping && found.flagged) continue;

      const button = chip(option, false);
      let armed = false;

      button.onclick = async () => {
        if (!keeping && !armed) {
          armed = true;
          button.textContent = `${label(option.value)} — press again`;
          button.classList.add('on');
          setTimeout(() => {
            if (!armed) return;
            armed = false;
            row.replaceChildren(buttons());
          }, 4000);
          return;
        }
        armed = false;
        button.disabled = true;
        try {
          await send({ choice: option.value });
          if (keeping) row.replaceChildren(buttons());
          else poll();
        } catch (err) {
          row.replaceChildren(said(err.message, true), buttons());
        }
      };
      out.push(button);
    }

    if (found.flagged) {
      const back = el('button', { className: 'chip quiet', type: 'button' }, 'Let FileFlows have it');
      back.title = 'Take the .fileflows-ignore away. FileFlows will treat the file like any other filed scene, which means 720p.';
      back.onclick = async () => {
        back.disabled = true;
        try {
          await send({ release: true });
          row.replaceChildren(buttons());
        } catch (err) {
          row.replaceChildren(said(err.message, true), buttons());
        }
      };
      out.push(back);
    }

    out.push(said(found.flagged
      ? `${found.height}p, ${sized(found.size)}. An encode replaces the original once the new file has been checked — no undo.`
      : `${found.height}p, ${sized(found.size)}. FileFlows will take it to 720p unless you choose otherwise. An encode replaces the original — no undo.`));
    return out;
  }

  // Asked once on the way in: an encode started from another tab, or still
  // running from before this page was opened, is the state of this control too.
  poll();

  return row;
}


/* Show 16 tags, the rest behind a click. */
const TAGS_SHOWN = 16;

function tagCard(tags) {
  if (!tags.length) return null;

  const row = el('div', { className: 'tagrow' },
    tags.slice(0, TAGS_SHOWN).map((t) => el('span', { className: 'tagchip flat' }, t.name)));

  const rest = tags.slice(TAGS_SHOWN);
  if (rest.length) {
    const more = el('button', { className: 'tagchip more', type: 'button' }, `+${rest.length} more`);
    more.onclick = () => {
      more.replaceWith(...rest.map((t) => el('span', { className: 'tagchip flat' }, t.name)));
    };
    row.append(more);
  }

  return sidecard('Tags', row);
}
/*
 * --------------------------------------------------------- deleting a scene
 *
 * Asks the server what's there (file, galleries, clips) and reads it back,
 * then asks twice.
 */
function removeLine(box, label, note) {
  return el('label', { className: 'removeline' },
    box,
    el('span', {}, el('span', { className: 'removewhat' }, label),
      note ? el('span', { className: 'muted small' }, note) : null)
  );
}

async function removeScene(scene) {
  const dialog = el('dialog', { className: 'galleryedit sceneremove' });
  const close = () => { dialog.close(); dialog.remove(); };

  const note = el('p', { className: 'note' }, 'Asking Stash what is there…');
  const what = el('div', { className: 'removewhats' });
  const menu = el('menu', {});

  dialog.append(el('form', { method: 'dialog' },
    el('h2', {}, `Delete “${scene.title}”`),
    what,
    note,
    menu
  ));

  document.body.append(dialog);
  dialog.showModal();

  let facts = null;
  try {
    facts = await api(`/api/library/scenes/${scene.id}/removal`);
  } catch (err) {
    note.textContent = err.message;
    const shut = el('button', { className: 'act', type: 'button' }, 'Close');
    shut.onclick = close;
    menu.append(shut);
    return;
  }

  /* File ticked, galleries not. */
  const file = el('input', { type: 'checkbox', checked: true });
  const galleries = el('input', { type: 'checkbox' });
  const clips = el('input', { type: 'checkbox', checked: true });

  const held = facts.files[0] || null;

  // append has none of el()'s tolerance for a null child — it would write the
  // word "null" into the dialog — so the empty ones are dropped here.
  what.append(...[
    el('p', { className: 'muted small' },
      'The Stash record goes either way. What else goes is up to you.'),

    held
      ? removeLine(file, `Erase the file — ${gigabytes(held.size)}`,
          'Leave it and Stash imports the scene again on its next scan.')
      : el('p', { className: 'muted small' }, 'Stash holds no file for this scene.'),

    held ? el('p', { className: 'filepath' }, held.path) : null,

    facts.galleries.length
      ? removeLine(galleries, facts.galleries.length === 1
          ? 'Delete the gallery and its pictures'
          : `Delete ${facts.galleries.length} galleries and their pictures`,
          facts.galleries.map((g) => `${g.title} (${plural(g.images, 'picture')})`).join(' · '))
      : null,

    facts.clips
      ? removeLine(clips, `Delete ${plural(facts.clips, 'reel clip')}`,
          'Cut from this file. Nothing else can play them once it has gone.')
      : null,
  ].filter(Boolean));

  note.textContent = '';

  /* The second press names what it takes. */
  const going = () => [
    'the Stash record',
    held && file.checked ? 'the file' : null,
    galleries.checked && facts.galleries.length
      ? `${facts.galleries.length === 1 ? '1 gallery' : facts.galleries.length + ' galleries'}`
      : null,
    clips.checked && facts.clips ? plural(facts.clips, 'clip') : null,
  ].filter(Boolean);

  const start = el('button', { className: 'act danger', type: 'button' }, 'Delete…');
  const cancel = el('button', { className: 'act', type: 'button' }, 'Cancel');

  const yes = el('button', { className: 'act danger', type: 'button' }, 'Delete permanently');
  const keep = el('button', { className: 'act', type: 'button' }, 'Keep it');
  const warning = el('span', { className: 'muted small' });

  const confirm = el('span', { className: 'confirmrow', hidden: true }, warning, yes, keep);

  start.onclick = () => {
    warning.textContent = `Taking ${going().join(', ')}. There is no undo.`;
    start.hidden = true;
    cancel.hidden = true;
    confirm.hidden = false;
  };

  keep.onclick = () => {
    confirm.hidden = true;
    start.hidden = false;
    cancel.hidden = false;
  };

  cancel.onclick = close;

  yes.onclick = async () => {
    yes.disabled = true;
    yes.textContent = 'Deleting…';
    try {
      await api(`/api/library/scenes/${scene.id}/delete`, {
        method: 'POST',
        body: JSON.stringify({
          file: Boolean(held) && file.checked,
          galleries: galleries.checked,
          clips: clips.checked,
        }),
      });
      close();
      // There is no scene page to go back to, so the shelf it came from is
      // where this lands.
      location.hash = '#/library/scenes';
    } catch (err) {
      yes.disabled = false;
      yes.textContent = 'Delete permanently';
      note.textContent = err.message;
    }
  };

  menu.append(start, cancel, confirm);
}

/*
 * A contact sheet: 24 frames from Stash's sprite sheet, four across, each
 * a place to jump to. No extra fetch beyond the sheet and vtt. No sheet,
 * no card.
 */

const INDEX_ACROSS = 4;
const INDEX_DOWN = 6;
const INDEX_OF = INDEX_ACROSS * INDEX_DOWN;

function indexCard(scene, video) {
  const grid = el('div', { className: 'sceneindex' });
  const card = sidecard('Scene index', grid);
  if (!card) return null;

  thumbnailCues(`/media/scene/${scene.id}/vtt`).then((cues) => {
    if (!cues || !cues.length || !cues[0].crop) {
      // No sheet: remove the card.
      card.remove();
      return;
    }

    /* Sheet size from the crops' extents. */
    let sheetW = 0;
    let sheetH = 0;
    for (const cue of cues) {
      sheetW = Math.max(sheetW, cue.crop.x + cue.crop.w);
      sheetH = Math.max(sheetH, cue.crop.y + cue.crop.h);
    }

    /* Spread over the cues, not the runtime (the last cue starts before the end). */
    const cells = [];
    for (let i = 0; i < INDEX_OF; i++) {
      const at = Math.min(cues.length - 1, Math.round((i / (INDEX_OF - 1)) * (cues.length - 1)));
      const cue = cues[at];
      if (!cue?.crop) continue;

      // clock() answers '' for zero, which is right on a runtime and wrong on
      // a position — the first cell is a place in the scene like every other.
      const when = clock(cue.start) || '0m';

      const cell = el('button', { className: 'indexcell', type: 'button' },
        el('span', { className: 'indexat' }, when)
      );
      cell.title = `Jump to ${when}`;

      /* Sized once the cell is in the document and has a width. */
      cell.dataset.at = String(cue.start);
      cell.dataset.crop = `${cue.crop.x},${cue.crop.y},${cue.crop.w},${cue.crop.h}`;
      cell.style.backgroundImage = `url("${cue.src}")`;

      cell.onclick = () => {
        video.currentTime = cue.start;
        video.play().catch(() => {});
        // The player is above the rail on a narrow screen, and a jump you
        // cannot see land is a jump you have to go looking for.
        video.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };

      cells.push(cell);
    }

    grid.replaceChildren(...cells);

    /* background-size needs arithmetic CSS can't do. */
    const scaleCells = () => {
      const wide = grid.firstElementChild?.clientWidth || 0;
      if (!wide) return;
      for (const cell of grid.children) {
        const [x, y, w] = cell.dataset.crop.split(',').map(Number);
        const scale = wide / w;
        cell.style.backgroundSize = `${sheetW * scale}px ${sheetH * scale}px`;
        cell.style.backgroundPosition = `-${x * scale}px -${y * scale}px`;
      }
    };

    scaleCells();
    // The rail is a flexible column: it changes width with the wide switch and
    // with the window, and a sheet scaled to yesterday's width is a smear.
    const watch = new ResizeObserver(scaleCells);
    watch.observe(grid);
    onTeardown(() => watch.disconnect());
  }).catch(() => card.remove());

  return card;
}

function removeCard(scene) {
  const button = el('button', { className: 'act danger', type: 'button' }, 'Delete scene…');
  button.onclick = () => removeScene(scene);
  /* In `.sidelinks` so the button fills the card. */
  return sidecard('Remove', el('div', { className: 'sidelinks' }, button));
}

async function renderScene(data, mine) {
  const { scene, related } = data;

  // The galleries filed against this scene, asked for alongside the Stash
  // origin so the page waits once rather than twice.
  const [origin, galleryCard] = await Promise.all([
    stashOrigin(),
    sideGalleries(`scene=${scene.id}`),
  ]);

  // The wide switch folds the rail away; the page is built below.
  let page = null;
  const { video, node: player } = playerFor(scene, (on) => {
    page?.classList.toggle('wide', on);
    // Dim the chrome on the body, since the page doesn't own it.
    document.body.classList.toggle('videowide', on);
  });

  // The player is built once; redraws only touch the meta around it.
  const meta = el('div', { className: 'scenemeta' });
  const side = el('aside', { className: 'sceneside' });
  const main = el('div', { className: 'scenemain' }, el('div', { className: 'stage' }, player), meta);

  // Built once for the same reason: the v3 badge asks Whisparr when it is
  // made, and a redraw is not a new question.
  const elsewhere = el('div', { className: 'sidelinks' },
    whisparr3Slot(scene),
    findMore(scene),
    origin
      ? el('a', { className: 'act', href: `${origin}/scenes/${scene.id}`, target: '_blank', rel: 'noreferrer' }, 'Edit in Stash ↗')
      : null
  );

  const draw = () => {
    // Only what identifies the scene. The file's half of this moved to the rail.
    const facts = [scene.date, clock(scene.duration), scene.resolution].filter(Boolean);

    // replaceChildren has none of el()'s tolerance for a null child — it would
    // write the word "null" into the page — so the empty ones are dropped here.
    meta.replaceChildren(...[
      el('div', { className: 'scenehead' },
        el('div', { className: 'headtext' },
          el('h1', { className: scene.untitled ? 'untitled' : '' }, scene.title),
          el('div', { className: 'scenefacts' },
            scene.studio ? el('a', { className: 'link', href: `#/library/studio/${scene.studio.id}` }, scene.studio.name) : null,
            facts.map((f) => el('span', {}, f))
          ),
          el('div', { className: 'sceneactionbar' }, actions(scene, draw))
        ),
        castStrip(scene.performers)
      ),
      scene.markers.length
        ? el('div', { className: 'markers' },
            scene.markers.map((m) => {
              const jump = el('button', { className: 'marker', type: 'button' }, `${clock(m.seconds)} · ${m.title}`);
              jump.onclick = () => { video.currentTime = m.seconds; video.play().catch(() => {}); };
              return jump;
            }))
        : null,
      scene.details ? el('p', { className: 'scenedetails' }, scene.details) : null,
    ].filter(Boolean));

    side.replaceChildren(...[
      sidecard('Elsewhere', elsewhere),
      // The contact sheet, directly under the links, because both are ways out
      // of this page — one to another service, one to a minute of this scene.
      indexCard(scene, video),
      galleryCard,
      tagCard(scene.tags),
      /* Your categories holding this scene, under the tags. */
      sidecard('Categories', scenePicker(String(scene.id))),
      fileCard(scene),
      // Last in the rail on purpose: the one button here you do not want to
      // find under your thumb on the way to something else.
      removeCard(scene),
    ].filter(Boolean));
  };

  draw();
  page = el('div', { className: 'scenepage' }, main, side);

  if (!holds(mine)) return;
  shell('#/library/scenes',
    page,
    /*
     * A gallery built here is tied to this scene, cast and studio. TPDB is
     * offered only if the scene was identified against it.
     */
    buildPanel({
      label: 'Add a gallery to this scene',
      tpdbScene: scene.identity.tpdb,
      tie: {
        sceneIds: [scene.id],
        performerIds: scene.performers.map((p) => p.id),
        studioId: scene.studio?.id || null,
        date: scene.date || null,
      },
    }),
    related.map((r) => rail({ ...r, scenes: r.scenes }))
  );
}

export async function showScene(id) {
  const mine = claim();
  loadingIn('#/library/scenes');
  try {
    await renderScene(await api(`/api/library/scenes/${id}`), mine);
  } catch (err) {
    if (!holds(mine)) return;
    failedIn('#/library/scenes', err);
  }
}
