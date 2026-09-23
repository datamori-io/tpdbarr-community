/* The group builder: loose scenes that are really one film. */

import * as shelf from '../shelf.js';
import { api, el } from '../util.js';
import { SECTION_OF, paint, painterFor, show, state } from '../import/core.js';

/* --------------------------------------------------- the group builder
 *
 * "Which of my loose scenes are actually one film?"
 *
 * Two pages in one, and the order is the point. The top half is the studios
 * that have loose scenes, because a scan costs somebody else's crawl budget and
 * is worth running against a studio you hold two hundred scenes of and not
 * against one you hold two of. The bottom half is what the scans have found,
 * waiting on a yes or a no.
 *
 * Every proposal wears the source that made it. An *exact* one came off
 * ThePornDB's own scene list and needs no judgement; a *probable* one was
 * matched on the cast IAFD lists for that film, which is a guess, and the cast
 * it matched on is shown so it can be judged rather than trusted.
 *
 * Nothing on this page writes to Stash until Build it is pressed, and what it
 * will write is on screen before you press it.
 */

const groupsHash = (params) => {
  const qs = params.toString();
  return '#/catalogue/groups' + (qs ? '?' + qs : '');
};

function goGroups(params) {
  const hash = groupsHash(params);
  if (location.hash === hash) showGroupBuilder(params.toString());
  else location.hash = hash;
}

// While a scan is running the page is a progress bar; four seconds is often
// enough to feel live and rare enough that a quarter-hour scan is not two
// hundred requests of its own.
const SCAN_POLL = 4000;
let scanPoll = null;

const stopScanPoll = () => {
  if (scanPoll) clearInterval(scanPoll);
  scanPoll = null;
};

export async function showGroupBuilder(qs) {
  const paint = painterFor();
  const params = new URLSearchParams(qs || '');
  stopScanPoll();

  const head = el('div', {});
  const body = el('div', {});
  show(paint, SECTION_OF.groups, head, body);

  if (!state?.stash?.enabled) {
    body.replaceChildren(el('div', { className: 'empty' },
      'This works on your Stash library — the loose scenes live there. Connect it in Settings.'));
    return;
  }

  body.replaceChildren(el('div', { className: 'empty' }, 'Reading the library…'));

  /*
   * `headOnly` is the whole reason the poll is not just refresh().
   *
   * Redrawing the proposals while a scan runs would wipe whatever you were in
   * the middle of — a group you had just built and were answering the missing
   * scenes of is a form, and a form that redraws itself every four seconds is
   * not usable. So a tick moves the progress line and nothing else, and the
   * list is rebuilt once, when the scan stops.
   */
  const refresh = async (headOnly = false) => {
    const [shelf, found] = await Promise.all([
      api('/api/import/groups'),
      api('/api/import/groups/proposals' + (params.get('studio') ? '?studio=' + params.get('studio') : '')),
    ]);

    head.replaceChildren(groupPanel(shelf, found, params));
    if (!headOnly) renderProposals(body, found, refresh);
    return found;
  };

  const tick = async () => {
    // A page you have navigated away from is not a page that should still be
    // asking. The interval outlives the render; this is what ends it.
    if (!location.hash.startsWith('#/catalogue/groups')) return stopScanPoll();

    try {
      const found = await refresh(true);
      if (!found.scanning.running) {
        stopScanPoll();
        renderProposals(body, found, refresh);
      }
    } catch {
      // A tick that failed is a tick. The next one either works or the scan
      // has finished and the full redraw will say what went wrong.
    }
  };

  try {
    const found = await refresh();
    // Poll only while something is actually running, and stop the moment it is
    // not — a page left open overnight should not be a client of anything.
    if (found.scanning.running) scanPoll = setInterval(tick, SCAN_POLL);
  } catch (err) {
    body.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
}

/*
 * The studio picker and the scan.
 *
 * A studio with no ThePornDB id anywhere in its loose scenes has no catalogue
 * to read, and the row says so rather than offering a button that does nothing.
 */
function groupPanel(shelf, found, params) {
  const chosen = params.get('studio') || '';
  const scanning = found.scanning;

  const picker = el('select', { className: 'chipselect' },
    el('option', { value: '' }, `Everything found so far (${found.counts.open})`),
    shelf.studios.map((studio) =>
      el('option', { value: studio.id, selected: studio.id === chosen },
        `${studio.name} — ${studio.loose} loose` +
        (studio.waiting ? `, ${studio.waiting} waiting` : '') +
        (studio.scannedAt ? '' : ', never scanned')))
  );

  picker.onchange = () => {
    const next = new URLSearchParams();
    if (picker.value) next.set('studio', picker.value);
    goGroups(next);
  };

  const studio = shelf.studios.find((s) => s.id === chosen) || null;

  const run = el('button', {
    className: 'add',
    type: 'button',
    disabled: Boolean(scanning.running) || !studio || studio.withTpdbId === 0,
  }, studio ? `Scan ${studio.name}` : 'Pick a studio to scan');

  run.onclick = async () => {
    run.disabled = true;
    run.textContent = 'Starting…';
    try {
      await api('/api/import/groups/scan', {
        method: 'POST',
        body: JSON.stringify({ studio: studio.id, force: true }),
      });
      // Re-entering rather than refreshing, because the page only starts
      // polling on the way in and a scan that nothing is watching looks stuck.
      showGroupBuilder(params.toString());
    } catch (err) {
      run.textContent = err.message;
    }
  };

  const say = [];

  if (scanning.running) {
    say.push(el('span', { className: 'good' },
      `Scanning ${scanning.studio} — ${scanning.phase}` +
      (scanning.total ? ` (${scanning.looked} of ${scanning.total})` : '')));
  } else if (studio && studio.withTpdbId === 0) {
    say.push(el('span', { className: 'muted small' },
      'None of this studio’s loose scenes carry a ThePornDB id, so there is no catalogue to read.'));
  } else if (studio?.scannedAt) {
    /*
     * Two numbers, and the small one is not a failure. A film none of your
     * loose scenes fits inside cannot hold one, so it is never asked about —
     * that is why a thousand films read can come down to a handful worth a
     * question.
     */
    say.push(el('span', { className: 'muted small' },
      `${(studio.read ?? studio.movies).toLocaleString()} films read` +
      (studio.catalogue && studio.catalogue > studio.read ? ` of ${studio.catalogue.toLocaleString()}` : '') +
      `, ${studio.movies} worth asking about — ${new Date(studio.scannedAt).toLocaleDateString()}`));

    // Beside the count rather than instead of it: "there is more to do" and
    // "here is what was done" are both worth having on screen at once.
    if (studio.note) say.push(el('span', { className: 'small' }, studio.note));
  } else {
    say.push(el('span', { className: 'muted small' },
      'A scan reads the studio’s catalogue on ThePornDB, then IAFD’s scene breakdowns for the films TPDB cannot answer for. IAFD is asked one page at a time, so a big studio takes a while.'));
  }

  /*
   * The offline pass, always available and not tied to the picker: it reads
   * what the scene titles already say and asks nobody anything. Deliberately
   * beside the studio scan rather than inside it — it is a different question,
   * it costs seconds instead of minutes, and it is the one to try first.
   */
  const titles = el('button', { className: 'chip', type: 'button', disabled: Boolean(scanning.running) },
    'Read the titles');

  titles.onclick = async () => {
    titles.disabled = true;
    titles.textContent = 'Reading…';
    try {
      await api('/api/import/groups/titles', { method: 'POST' });
      showGroupBuilder(params.toString());
    } catch (err) {
      titles.textContent = err.message;
    }
  };

  return el('section', { className: 'searchpanel' },
    el('div', { className: 'controls' }, picker, run, titles),
    el('div', { className: 'controls' },
      ...say,
      el('span', { className: 'muted small' },
        `${found.counts.approved} built, ${found.counts.declined} declined`))
  );
}

function renderProposals(body, found, refresh) {
  const { proposals, finishing } = found;
  const kids = [];

  /*
   * The groups you have built that still have a question open, above the ones
   * you have not looked at. Building a group and saying what to do about what
   * it is missing are two steps, and the second one is the one a reload used to
   * lose — so it is the first thing on the page until it is done.
   */
  if (finishing.length) {
    kids.push(el('div', { className: 'feedhead' },
      el('h2', {}, `${finishing.length} built, still to answer`),
      el('span', { className: 'muted' }, 'what these films are missing, and what to do about it')));
    kids.push(el('div', { className: 'proposals' },
      finishing.map((proposal) => finishingCard(proposal))));
  }

  kids.push(el('div', { className: 'feedhead' },
    el('h2', {}, proposals.length ? `${proposals.length} to look at` : 'Nothing waiting'),
    el('span', { className: 'muted' }, 'strongest evidence first — an id, then what the file says of itself, then a cast that lines up')));

  if (!proposals.length) {
    kids.push(el('div', { className: 'empty small' },
      found.scanning.running
        ? 'The scan is still going. Anything it finds will appear here.'
        : 'Pick a studio above and scan it, and whatever your loose scenes add up to will be listed here.'));
  } else {
    kids.push(el('div', { className: 'proposals' },
      proposals.map((proposal) => proposalCard(proposal, refresh))));
  }

  body.replaceChildren(...kids);
}

/*
 * A group that exists, shown only for the sake of the scenes it is missing.
 * There is nothing to approve here and no way back to a decision — undoing a
 * group is the film shelf's job, and it asks properly.
 */
function finishingCard(proposal) {
  const open = (proposal.missing || []).filter((scene) => !proposal.scenes[scene.key]);

  return el('article', { className: 'proposal' },
    proposal.poster
      ? el('img', { className: 'art portrait', src: proposal.poster, loading: 'lazy', alt: '' })
      : el('div', { className: 'noposter' }),
    el('div', { className: 'proposalbody' },
      el('div', { className: 'title' },
        el('a', { className: 'link', href: `#/library/group/${proposal.groupId}` }, proposal.title)),
      el('div', { className: 'meta' },
        el('span', {}, proposal.date || 'no date'),
        el('span', {}, proposal.studioName),
        el('span', {}, `${open.length} of ${proposal.total} still unanswered`)),
      el('div', { className: 'heldrows' },
        (proposal.missing || []).map((scene) =>
          missingRow(proposal, scene, proposal.scenes[scene.key] || null)))
    )
  );
}

/*
 * One film, and the case for it.
 *
 * The held scenes are tickable and start ticked: this is the one place where
 * "the evidence is right but that third scene is not part of it" has to be
 * sayable, and dropping a row is cheaper than undoing a group.
 */
function proposalCard(proposal, refresh) {
  const chosen = new Map();
  const rows = el('div', { className: 'heldrows' });
  const after = el('div', {});

  for (const row of proposal.held) {
    if (row.ambiguous) {
      rows.append(ambiguousRow(row, chosen));
      continue;
    }
    chosen.set(row.sceneId, true);
    rows.append(heldRow(row, chosen, proposal.studioName));
  }

  const build = el('button', { className: 'add', type: 'button' }, 'Build it');
  const no = el('button', { className: 'chip', type: 'button' }, 'Not a group');

  build.onclick = async () => {
    const sceneIds = [...chosen.entries()].filter(([, on]) => on).map(([id]) => id);
    if (!sceneIds.length) {
      after.replaceChildren(el('div', { className: 'muted small' }, 'Tick at least one scene to put in it.'));
      return;
    }

    build.disabled = true;
    no.disabled = true;
    build.textContent = 'Building…';

    try {
      const result = await api(`/api/import/groups/${encodeURIComponent(proposal.id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ sceneIds }),
      });
      build.textContent = 'Built';
      renderAfterBuild(after, proposal, result);
    } catch (err) {
      build.disabled = false;
      no.disabled = false;
      build.textContent = 'Build it';
      after.replaceChildren(el('div', { className: 'bad small' }, err.message));
    }
  };

  no.onclick = async () => {
    no.disabled = true;
    build.disabled = true;
    try {
      await api(`/api/import/groups/${encodeURIComponent(proposal.id)}/decline`, { method: 'POST' });
      await refresh();
    } catch (err) {
      no.disabled = false;
      build.disabled = false;
      after.replaceChildren(el('div', { className: 'bad small' }, err.message));
    }
  };

  const heldCount = proposal.held.filter((row) => row.sceneId).length;

  const links = [
    proposal.urls.adultEmpire && ['AdultEmpire', proposal.urls.adultEmpire],
    proposal.urls.iafd && ['IAFD', proposal.urls.iafd],
    // The page this proposal was read off, when Bang was the one that answered.
    // Checking a title match means looking at the list it came from.
    proposal.bang?.url && ['Bang', proposal.bang.url],
    proposal.urls.tpdb && ['ThePornDB', proposal.urls.tpdb],
  ].filter(Boolean);

  return el('article', { className: 'proposal' },
    proposal.poster
      ? el('img', { className: 'art portrait', src: proposal.poster, loading: 'lazy', alt: '' })
      : el('div', { className: 'noposter' }),
    el('div', { className: 'proposalbody' },
      el('div', { className: 'title' }, proposal.title),
      el('div', { className: 'meta' },
        el('span', {}, proposal.date || 'no date'),
        el('span', {}, proposal.studioName),
        proposal.director ? el('span', {}, proposal.director) : null,
        /*
         * Exact is green because it needs no judgement from you. Likely is not
         * — a title match is a good guess and still a guess — so it reads as
         * every other tier does and the row below says what answered.
         */
        el('span', { className: proposal.match === 'exact' ? 'good' : 'muted' }, proposal.match)),
      /*
       * The titles tier has no denominator and does not pretend to one. Nothing
       * knows whether Barely Legal #14 had five scenes or eight, so it counts
       * what you hold and stops — the alternative is a 100% badge on a film you
       * own half of, which is the lie the builder in groupbuilder.mjs refuses to
       * tell.
       */
      el('div', { className: 'muted small' },
        (proposal.total
          ? `${heldCount} of ${proposal.total} — matched on ${proposal.via}`
          : `${heldCount} scenes name this film in their own titles — nothing says how many it has`) +
        (proposal.iafd?.compilation ? '. IAFD calls this a compilation.' : '')),
      /*
       * The film's size is known but the gap cannot be named: something you
       * hold did not land on any of the breakdown's rows, so one of the empty
       * rows might be it. Said plainly, because "3 of 5 and no missing list"
       * otherwise reads as a bug.
       */
      proposal.total && !proposal.missing.length && proposal.total > heldCount
        ? el('div', { className: 'muted small' },
            `${proposal.total - heldCount} not here. ` +
            (proposal.iafd?.unplaced
              ? `Which ones is not clear — ${proposal.iafd.unplaced} of the scenes you hold could not be placed against IAFD’s breakdown.`
              : 'IAFD does not say which.'))
        : null,
      proposal.returning
        ? el('div', { className: 'small' },
            'You said no to this before. It is back because you now hold a scene of it that you did not then.')
        : null,
      rows,
      links.length
        ? el('div', { className: 'meta' },
            links.map(([label, href]) =>
              el('a', { className: 'link', href, target: '_blank', rel: 'noreferrer noopener' }, label)))
        : null,
      el('div', { className: 'toolbar' }, build, no),
      after
    )
  );
}

function heldRow(row, chosen, studioName) {
  const tick = el('input', { type: 'checkbox', checked: true });
  tick.onchange = () => chosen.set(row.sceneId, tick.checked);

  /*
   * Where the scene is filed, but only when that is not where the film says it
   * should be. A DVD gathers scenes from sibling labels, so this is normal
   * rather than wrong — and it is still the thing to look at twice before
   * agreeing, which is why it is said out loud and nowhere else.
   */
  const elsewhere = row.studio && studioName && row.studio !== studioName ? row.studio : null;

  return el('label', { className: 'heldrow' },
    tick,
    row.screenshot
      ? el('img', { className: 'thumb', src: row.screenshot, loading: 'lazy', alt: '' })
      : el('span', { className: 'thumb blank' }),
    el('span', { className: 'small' }, `${row.index}. ${row.title || '(untitled)'}`),
    elsewhere ? el('span', { className: 'chip quiet' }, `filed under ${elsewhere}`) : null,
    el('span', { className: 'muted small' }, [row.date, (row.cast || []).join(', ')].filter(Boolean).join(' · '))
  );
}

/*
 * Two of your scenes have exactly this cast, so IAFD's row cannot say which one
 * it means. Both are offered and neither is assumed — leaving it alone builds
 * the group without this scene, which is a smaller wrong than filing the wrong
 * one.
 */
function ambiguousRow(row, chosen) {
  const name = `amb-${Math.random().toString(36).slice(2)}`;

  const options = row.ambiguous.map((option) => {
    const pick = el('input', { type: 'radio', name });
    pick.onchange = () => {
      for (const other of row.ambiguous) chosen.set(other.sceneId, false);
      chosen.set(option.sceneId, true);
    };
    return el('label', { className: 'heldrow' },
      pick,
      option.screenshot
        ? el('img', { className: 'thumb', src: option.screenshot, loading: 'lazy', alt: '' })
        : el('span', { className: 'thumb blank' }),
      el('span', { className: 'small' }, option.title || '(untitled)'),
      el('span', { className: 'muted small' }, option.date || ''));
  });

  return el('div', { className: 'ambiguous' },
    el('div', { className: 'muted small' },
      `Scene ${row.index} — ${(row.cast || []).join(', ')} — ${row.ambiguous.length} of your scenes have exactly this cast. Pick one, or leave it out.`),
    options
  );
}

/* -------------------------------------------------- what it is missing
 *
 * The second question, asked only once the group exists. Three answers, and
 * they are three different sentences: Want means put it on the want list, Add
 * means fetch it now, Skip means this film is complete enough without it.
 *
 * Skip here is local to this page. It deliberately does not touch the want
 * list's own skip list, which means "not for me" and moves the tracked
 * percentage every other page reads.
 */
function renderAfterBuild(after, proposal, result) {
  const kids = [
    el('div', { className: 'good small' },
      `Built. ${result.filed.length} scene${result.filed.length === 1 ? '' : 's'} filed into it.`),
  ];

  if (result.failed.length) {
    kids.push(el('div', { className: 'bad small' },
      `${result.failed.length} could not be filed: ${result.failed.map((f) => f.error).join('; ')}`));
  }

  if (result.coverFailed) {
    kids.push(el('div', { className: 'muted small' },
      'Built without its cover — Stash could not fetch the poster. The Movies page can scrape one from the address on the group.'));
  }

  if (!result.missing.length) {
    kids.push(el('div', { className: 'muted small' }, 'You hold all of it.'));
    after.replaceChildren(...kids);
    return;
  }

  kids.push(el('div', { className: 'small' },
    `${result.missing.length} scene${result.missing.length === 1 ? '' : 's'} of this film you do not have.`));

  kids.push(el('div', { className: 'heldrows' },
    result.missing.map((scene) => missingRow(proposal, scene))));

  after.replaceChildren(...kids);
}

function missingRow(proposal, scene, answered = null) {
  const said = el('span', { className: answered ? 'good small' : 'muted small' }, answered || '');
  const extra = el('div', {});
  const actions = el('div', { className: 'trackedactions' });

  const answer = (verdict, label) => {
    const button = el('button', { className: 'chip', type: 'button' }, label);
    button.onclick = async () => {
      button.disabled = true;
      said.textContent = '…';
      try {
        const done = await api(
          `/api/import/groups/${encodeURIComponent(proposal.id)}/scenes/${encodeURIComponent(scene.key)}`,
          { method: 'POST', body: JSON.stringify({ verdict }) }
        );
        said.className = 'good small';
        // How it was matched is only a fact about tracking — that is the one
        // answer that had to find the scene on StashDB before it could be given.
        said.textContent = verdict === 'tracked' && done.match
          ? `tracked — matched on ${done.match}`
          : verdict;
        actions.replaceChildren(change(), said);
      } catch (err) {
        button.disabled = false;
        said.className = 'bad small';
        said.textContent = err.message;
      }
    };
    return button;
  };

  /*
   * Taking an answer back only forgets the answer. A tracked scene stays
   * tracked and a fetched one stays fetched — this page did not put the file
   * there and is not the thing that should take it away.
   */
  const change = () => {
    const button = el('button', { className: 'chip', type: 'button' }, 'Change');
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/api/import/groups/${encodeURIComponent(proposal.id)}/scenes/${encodeURIComponent(scene.key)}`,
          { method: 'DELETE' });
        said.className = 'muted small';
        said.textContent = '';
        actions.replaceChildren(...buttons(), said);
      } catch (err) {
        button.disabled = false;
        said.className = 'bad small';
        said.textContent = err.message;
      }
    };
    return button;
  };

  /*
   * IAFD named the cast and nothing else, so there is no id to track or fetch
   * by. Rather than a button that fails, the row offers to go and look for it
   * on StashDB — the same "Find it" the Match page uses for a scene Stash
   * cannot name.
   */
  const find = el('button', { className: 'chip', type: 'button' }, 'Find it');
  find.onclick = async () => {
    find.disabled = true;
    extra.replaceChildren(el('div', { className: 'muted small' }, 'Asking StashDB…'));
    try {
      const found = await api(
        `/api/import/groups/${encodeURIComponent(proposal.id)}/scenes/${encodeURIComponent(scene.key)}/find`);

      /*
       * How it was asked matters as much as what came back. A cast search is
       * the real one; a text search means StashDB did not recognise any of
       * these names and the results are a much weaker guess, so the line says
       * so rather than letting both look equally trustworthy.
       */
      const how = found.by === 'cast'
        ? `Scenes with all of ${found.term}`
        : `No StashDB performer matched, so this searched the names as text: “${found.term}”`;

      const missed = (found.unknown || []).length
        ? el('div', { className: 'muted small' }, `Not on StashDB under that name: ${found.unknown.join(', ')}`)
        : null;

      /*
       * IAFD's stand-in for somebody a film never credited. Saying so matters:
       * a four-person row searched on three names is a wider net than the row
       * implies, and a reader who does not know one slot was blank will read a
       * loose result as a bad match rather than an under-specified one.
       */
      const blank = (found.unnamed || []).length
        ? el('div', { className: 'muted small' },
            `IAFD did not name ${found.unnamed.length === 1 ? 'one performer' : `${found.unnamed.length} performers`} `
            + `(“${found.unnamed.join('”, “')}”), so this searched on the rest.`)
        : null;

      if (!found.candidates.length) {
        extra.replaceChildren(
          ...[el('div', { className: 'muted small' }, `${how} — nothing on StashDB.`), blank, missed].filter(Boolean));
        return;
      }

      extra.replaceChildren(...[
        el('div', { className: 'muted small' }, `${how} — ${found.count} on StashDB`),
        blank,
        missed,
        el('div', { className: 'heldrows' }, found.candidates.map((card) => candidateRow(card))),
      ].filter(Boolean));
    } catch (err) {
      extra.replaceChildren(el('div', { className: 'bad small' }, err.message));
    } finally {
      find.disabled = false;
    }
  };

  /*
   * Naming which candidate it is, which is what turns Track and Add on. The
   * title still links out to StashDB — the point of looking is to look — and
   * "That one" is the separate press that commits.
   */
  const candidateRow = (card) => {
    const pick = el('button', { className: 'chip', type: 'button' }, 'That one');
    pick.onclick = async () => {
      pick.disabled = true;
      try {
        const done = await api(
          `/api/import/groups/${encodeURIComponent(proposal.id)}/scenes/${encodeURIComponent(scene.key)}/find`,
          { method: 'POST', body: JSON.stringify({ stashdbId: card.id }) }
        );
        Object.assign(scene, done.scene);
        extra.replaceChildren();
        redraw();
      } catch (err) {
        pick.disabled = false;
        extra.append(el('div', { className: 'bad small' }, err.message));
      }
    };

    return el('div', { className: 'heldrow' },
      el('a', { className: 'link small', href: card.url, target: '_blank', rel: 'noreferrer noopener' },
        card.title || '(untitled)'),
      el('span', { className: 'muted small' }, [card.date, card.studioName].filter(Boolean).join(' · ')),
      pick);
  };

  /*
   * Track and Add both need an id. A scene only IAFD named has none, so those
   * two are not offered at all — a button that can only fail is worse than no
   * button, and Find it is the thing that makes them possible.
   */
  const buttons = () => [
    scene.addressable ? answer('tracked', 'Want') : find,
    scene.addressable ? answer('added', 'Add') : null,
    answer('ignored', 'Skip'),
  ].filter(Boolean);

  const title = el('div', { className: 'small' });
  const meta = el('div', { className: 'muted small' });
  const art = el('span', { className: 'thumb blank' });

  // Called again once a cast-only row has been given a name, so the row stops
  // reading as four people and starts reading as a scene.
  function redraw() {
    title.textContent = scene.title
      ? `${scene.index}. ${scene.title}`
      : `Scene ${scene.index} — ${(scene.performers || []).join(', ')}`;

    meta.textContent = [scene.date, scene.title ? (scene.performers || []).join(', ') : null]
      .filter(Boolean).join(' · ');

    // The span is the frame either way — style.css already sizes .thumb and
    // fits whatever image is put inside it.
    art.className = scene.image ? 'thumb' : 'thumb blank';
    art.replaceChildren(...(scene.image
      ? [el('img', { src: scene.image, loading: 'lazy', alt: '' })]
      : []));

    actions.replaceChildren(...(answered ? [change()] : buttons()), said);
  }

  redraw();

  return el('div', { className: 'heldrow missing' },
    art,
    el('div', {}, title, meta, extra),
    actions
  );
}
