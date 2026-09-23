/*
 * Wild Card — building one scene's record out of several sources at once.
 *
 * The match page answers one question: *which scene is this*, and it answers
 * it by asking sources that can recognise a scene from a fingerprint. When
 * that works it is the best thing in the portal. When it does not — and on
 * pc-import it very often does not, because the file is a DVD rip nobody has
 * ever fingerprinted — the honest answer is that no single source knows what
 * this is, and the page has nothing left to offer.
 *
 * What actually happens then is that you go and look. You find the film on
 * AdultEmpire, the scene list on HotMovies, the credits on AdultFilmIndex, and
 * you copy a field from each into Stash by hand. Three pages, one record, and
 * none of them complete on their own.
 *
 * **So this page does that, and keeps the copying.** You hand it URLs and you
 * hand it keyword sources; every answer arrives as a *contribution* rather
 * than as a candidate, and the record is assembled field by field with you
 * saying which contribution wins each one. Nothing is merged automatically and
 * nothing is ranked: two sources disagreeing about a date is exactly the thing
 * you are here to adjudicate, and a page that quietly picked one would be
 * hiding the only interesting part.
 *
 * **Both halves of it are Stash's own scrapers**, which is the point. Stash
 * has 724 scene scrapers installed here. 705 of them can take a URL and read
 * the page behind it; 193 can take a keyword and search the site themselves.
 * The match page uses neither — it filters to the 186 that answer a FRAGMENT
 * scrape, because that is the shape a fingerprint question takes. Everything
 * this page does was already installed and simply never asked.
 *
 * Nothing here writes until `apply`, and `apply` writes only the fields handed
 * to it. There is no "first non-empty wins" in this module: that rule belongs
 * to the match page, where the picks are whole records from boxes that agree
 * about what a scene is. Here they do not agree, which is why you are reading
 * them side by side.
 */

import { gql } from './stash.mjs';
import { readFile } from 'node:fs/promises';

import { asDate, readName } from './matchsort.mjs';
import * as scenethumb from './scenethumb.mjs';
import * as artwork from './artwork.mjs';
import * as renamer from './renamer.mjs';

const SCENE = `
  id
  title
  date
  details
  organized
  code
  director
  urls
  studio { id name }
  performers { id name }
  tags { id name }
  files { path }
  paths { screenshot }
  stash_ids { endpoint stash_id }
`;

/*
 * What a scraper hands back. The same list the match page asks for, plus the
 * two fields it has no use for and this one does: a scraper that knows a
 * film's director or its catalogue code often knows little else worth having,
 * and those two are exactly what you would otherwise be copying by hand.
 */
const SCRAPED = `
  title code details director urls date image remote_site_id
  studio { stored_id name remote_site_id }
  tags { stored_id name }
  performers { stored_id name gender remote_site_id }
`;

/*
 * What a *group* scraper hands back, which is a different shape and a
 * different thing.
 *
 * A group is a film. Its record has the studio, the date, the director, the
 * synopsis and the box art on it — everything the film-level pages carry — and
 * no cast and no scene title, because a film does not have one scene. That is
 * exactly the gap the DVD rips in pc-import leave, so it is worth having, and
 * it is worth being labelled as the film rather than the scene.
 */
const SCRAPED_GROUP = `
  name date director synopsis urls front_image
  studio { stored_id name }
  tags { stored_id name }
`;

/* ------------------------------------------------------------ the sources
 *
 * Which scrapers can be asked a keyword.
 *
 * NAME, not FRAGMENT. A FRAGMENT scrape is "here is a scene I hold, tell me
 * about it" and needs the scene to exist on both sides; a NAME scrape is
 * "here is a phrase, search your own site" — which is the thing you were doing
 * in a browser tab. The DVD sites are all in this list and in none of the
 * others: AdultFilmIndex, AdultEmpire, AdultDvdMarketPlace, HotMovies,
 * TheClassicPorn.
 *
 * Measured 2026-09-12 on this Stash: 724 scene scrapers, 193 of them NAME.
 */
export async function sources(config) {
  const data = await gql(
    config,
    '{ listScrapers(types: [SCENE]) { id name scene { supported_scrapes } } }'
  ).catch(() => null);

  const all = data?.listScrapers || [];
  const can = (s, what) => (s.scene?.supported_scrapes || []).includes(what);

  const films = await groupCount(config);

  return {
    films,
    /*
     * Sorted by name because this is a list you read rather than a list you
     * rank — there is no sensible "best" scraper for a phrase nobody has typed
     * yet, and 193 of them in arbitrary order is a wall.
     */
    ask: all
      .filter((s) => can(s, 'NAME'))
      .map((s) => ({ key: s.id, label: s.name || s.id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    /*
     * Not a list to choose from: Stash picks the scraper off the URL's host
     * itself. The count is here only so the page can say how many hosts it is
     * able to read, which is the answer to "will it know this site".
     */
    urls: all.filter((s) => can(s, 'URL')).length,
  };
}

/*
 * How many sites can be read as a *film*.
 *
 * Asked separately because Stash keeps a scraper's abilities per type, and a
 * scraper can be a group scraper and not a scene one — AdultFilmIndex is
 * exactly that as of 2026-09-12, which is why it vanished from the list above
 * without anybody touching it.
 *
 * **None of them search by name.** All 118 are URL-only, so there is no group
 * half of the keyword panel and there is not going to be one; the film sites
 * are reached by pasting a film page, and that is the whole of it.
 */
async function groupCount(config) {
  const data = await gql(
    config,
    '{ listScrapers(types: [GROUP]) { id group { supported_scrapes } } }'
  ).catch(() => null);

  return (data?.listScrapers || [])
    .filter((s) => (s.group?.supported_scrapes || []).includes('URL')).length;
}

/* -------------------------------------------------------------- the scene
 *
 * The record being built up, and its current values as the baseline. Every
 * contribution is read against these: a field Stash already has is a field you
 * are choosing whether to overrule, not a blank you are filling.
 */

const briefScene = (raw) => ({
  id: String(raw.id),
  title: raw.title || '',
  date: raw.date || '',
  details: raw.details || '',
  code: raw.code || '',
  director: raw.director || '',
  organized: !!raw.organized,
  studioName: raw.studio?.name || '',
  performers: (raw.performers || []).map((p) => p.name).filter(Boolean),
  tags: (raw.tags || []).map((t) => t.name).filter(Boolean),
  urls: raw.urls || [],
  path: raw.files?.[0]?.path || null,
  image: raw.paths?.screenshot || null,
  stashIds: raw.stash_ids || [],
  /*
   * The filename read down to its title, from the same parser the match page
   * uses. It is what the keyword box starts with, and on the scenes that end
   * up here it is the only description that exists — these are the files with
   * no title, which is most of why they are here.
   */
  term: raw.title || readName(raw.files?.[0]?.path).title,
});

export async function scene(config, id) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id: String(id) });
  if (!data.findScene) throw new Error('Stash has no scene with that id.');
  return { scene: briefScene(data.findScene) };
}

/*
 * Finding the scene to work on.
 *
 * Stash's own `q` reads the path as well as the title, which is the whole
 * reason it is used rather than a title filter: the scenes that need this page
 * are the scenes with no title, and that is most of why they need it.
 */
export async function find(config, term, { limit = 20 } = {}) {
  const q = String(term || '').trim();
  if (!q) return { scenes: [] };

  const data = await gql(
    config,
    `query($q: String!, $n: Int!) {
       findScenes(filter: {q: $q, per_page: $n, sort: "updated_at", direction: DESC}) {
         scenes { ${SCENE} }
       }
     }`,
    { q, n: Math.min(50, Math.max(1, Number(limit) || 20)) }
  );

  return { scenes: (data.findScenes?.scenes || []).map(briefScene) };
}

/* ------------------------------------------------------- the contributions
 *
 * Whatever a source said, in one shape.
 *
 * `ok` and `note` are as much a part of the answer as the fields are. A
 * scraper that is broken today is a normal Tuesday, and a page that silently
 * dropped it would have you wondering why AdultEmpire "had nothing" when what
 * actually happened was a 403. Every source reports, the failures included,
 * and they stay on screen saying so.
 */
const shape = (raw, from, label, { url = '' } = {}) => ({
  from,
  label,
  url: url || (raw.urls || [])[0] || '',
  remoteId: raw.remote_site_id || null,
  ok: true,
  note: '',
  fields: {
    title: raw.title || '',
    // Scrapers print the date the way the site did. Stash takes one shape and
    // refuses the whole write over any other, so it is read here or dropped.
    date: asDate(raw.date),
    details: raw.details || '',
    code: raw.code || '',
    director: raw.director || '',
    studioName: raw.studio?.name || '',
    performers: (raw.performers || []).map((p) => p.name).filter(Boolean),
    tags: (raw.tags || []).map((t) => t.name).filter(Boolean),
    image: raw.image || '',
    urls: (raw.urls || []).filter(Boolean),
  },
});

/*
 * A film, in the same shape a scene answer arrives in.
 *
 * `kind` is the one addition, and the page needs it: a group answer's title is
 * the *film's* name, and taking it as the scene title would give you four
 * scenes all called "Oil Overload #15". Everything else on it — the studio,
 * the date, the director, the box art — is the answer you came for, because a
 * film page is where those actually live.
 */
const shapeGroup = (raw, label, url) => ({
  from: 'url',
  kind: 'group',
  label: `${label} (the film)`,
  url: url || (raw.urls || [])[0] || '',
  remoteId: null,
  ok: true,
  note: '',
  fields: {
    title: raw.name || '',
    date: asDate(raw.date),
    details: raw.synopsis || '',
    code: '',
    director: raw.director || '',
    studioName: raw.studio?.name || '',
    // A film has a cast between all its scenes and none that belongs to any
    // one of them, so this is deliberately empty rather than wrong.
    performers: [],
    tags: (raw.tags || []).map((t) => t.name).filter(Boolean),
    image: raw.front_image || '',
    urls: (raw.urls || []).filter(Boolean),
  },
});

const nothing = (from, label, note, extra = {}) =>
  ({ from, label, note, ok: false, url: '', remoteId: null, fields: null, ...extra });

const urlOf = (value) => { try { return new URL(String(value)); } catch { return null; } };
const hostOf = (value) => urlOf(value)?.host || String(value).slice(0, 60);
const protocolOf = (value) => urlOf(value)?.protocol || '';

/*
 * A page you found yourself.
 *
 * This is the half that replaces the copying. Stash picks the scraper off the
 * URL's host, so there is nothing to choose here and nothing to configure —
 * paste the address of the page you are already looking at and the fields come
 * back off it, cover included.
 *
 * **Only addresses you typed.** Nothing on this page follows a link it found
 * inside somebody else's answer, which is the same rule the picture scraper
 * has always kept: a scraped page is data, and data does not get to decide
 * what gets fetched next.
 */
const MOST_URLS = 12;

export async function fromUrls(config, urls = []) {
  const list = [...new Set(
    (Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim()).filter(Boolean)
  )].slice(0, MOST_URLS);

  if (!list.length) return { contributions: [] };

  /*
   * In parallel, unlike the match page's Search All. That one is a hundred and
   * forty calls at one endpoint and gets you rate-limited for the afternoon;
   * this is a handful of addresses you typed, at a handful of different hosts.
   */
  const contributions = await Promise.all(list.map(async (url) => {
    const host = hostOf(url);
    if (!/^https?:$/.test(protocolOf(url))) return nothing('url', host, 'Not an http address.', { url });

    /*
     * The scene attempt swallows its own failure rather than throwing, because
     * a site that cannot be read as a scene must still get its chance to be
     * read as a film — and "cannot" arrives both ways. AdultFilmIndex answers
     * a scene scrape with `runtime error: index out of range`, not an empty
     * result, and letting that throw skipped the group scraper that would have
     * answered it perfectly well.
     */
    try {
      const data = await gql(
        config,
        `query($u: String!) { scrapeSceneURL(url: $u) { ${SCRAPED} } }`,
        { u: url }
      ).catch(() => null);

      if (data?.scrapeSceneURL) return shape(data.scrapeSceneURL, 'url', host, { url });

      /*
       * Nothing read it as a scene, so try reading it as a film.
       *
       * This is most of what gets pasted here. An AdultEmpire or
       * AdultFilmIndex address is a *film* page, and 118 scrapers can read one
       * — including several that cannot read a scene at all. Asked second
       * rather than first because a scene answer is the more specific one and
       * wins where both exist.
       */
      const film = await gql(
        config,
        `query($u: String!) { scrapeGroupURL(url: $u) { ${SCRAPED_GROUP} } }`,
        { u: url }
      ).catch(() => null);

      if (film?.scrapeGroupURL) return shapeGroup(film.scrapeGroupURL, host, url);

      return nothing('url', host, 'No scraper here reads that site, as a scene or as a film.', { url });
    } catch (err) {
      return nothing('url', host, err.message, { url });
    }
  }));

  return { contributions };
}

/*
 * A phrase, asked of sites that can search themselves.
 *
 * One source can answer with several scenes — HotMovies returns every scene in
 * a film, which is exactly what you want when the filename is "Oil Overload 15
 * Scene 3" — so a source becomes several contributions rather than one, capped
 * per source and each labelled with which answer it was. Reading eight
 * near-identical rows is the job; reading eighty is not.
 */
const PER_SOURCE = 5;
const MOST_SOURCES = 8;

export async function ask(config, query, keys = []) {
  const term = String(query || '').trim();
  if (!term) throw new Error('Nothing to search for.');

  const wanted = [...new Set(
    (Array.isArray(keys) ? keys : []).map(String).filter(Boolean)
  )].slice(0, MOST_SOURCES);
  if (!wanted.length) throw new Error('Pick at least one source to ask.');

  const { ask: available } = await sources(config);
  const known = new Map(available.map((s) => [s.key, s.label]));

  const answers = await Promise.all(wanted.map(async (key) => {
    const label = known.get(key);
    /*
     * A key that is not in the list is a key that cannot do a NAME scrape.
     * Asking anyway is a GraphQL error rather than an empty answer, and an
     * error here would take the other seven sources down with it.
     */
    if (!label) return [nothing('ask', key, 'That scraper cannot search by name.')];

    try {
      const data = await gql(
        config,
        `query($s: ScraperSourceInput!, $i: ScrapeSingleSceneInput!) {
           scrapeSingleScene(source: $s, input: $i) { ${SCRAPED} }
         }`,
        { s: { scraper_id: key }, i: { query: term } }
      );

      const found = data.scrapeSingleScene || [];
      if (!found.length) return [nothing('ask', label, `nothing for “${term}”`)];

      const shown = Math.min(found.length, PER_SOURCE);
      return found.slice(0, PER_SOURCE).map((raw, at) =>
        shape(raw, 'ask', shown > 1 ? `${label} (${at + 1} of ${shown})` : label));
    } catch (err) {
      return [nothing('ask', label, err.message)];
    }
  }));

  return { term, contributions: answers.flat() };
}

/* ------------------------------------------------------------- the writing
 *
 * What you assembled, onto the scene.
 *
 * Unlike the match page there is no field precedence here and no overwrite
 * flag: every value in `values` was chosen by a person looking at the
 * alternatives, so an occupied field being replaced is the intent rather than
 * an accident. A field absent from `values` is not touched at all, which is
 * how "keep what Stash has" is spelled.
 *
 * Performers, studios and tags are attached **only when Stash already has one
 * of that name**, the same rule the match page keeps and for the same reason:
 * creating them means inventing records off the back of a guess, and a wrong
 * guess then has a page of its own. What could not be attached is reported
 * rather than silently dropped.
 */
const NAMED = {
  performer: `query($n: String!) {
    findPerformers(performer_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { performers { id name } }
  }`,
  studio: `query($n: String!) {
    findStudios(studio_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { studios { id name } }
  }`,
  tag: `query($n: String!) {
    findTags(tag_filter: {name: {value: $n, modifier: EQUALS}}, filter: {per_page: 2}) { tags { id name } }
  }`,
};

async function idFor(config, kind, name) {
  const data = await gql(config, NAMED[kind], { n: name }).catch(() => null);
  const list = data?.findPerformers?.performers || data?.findStudios?.studios || data?.findTags?.tags || [];
  return list[0]?.id || null;
}

/* ------------------------------------------------------- what Stash already has
 *
 * The names you can pick from, for the fields where a name is only worth
 * choosing if Stash has one.
 *
 * The page has always refused to invent a performer, a studio or a tag — a
 * scraped name Stash does not hold is reported and dropped, because creating
 * records off the back of a guess gives the guess a page of its own. The
 * consequence was that a field nobody scraped was a field you could not fill,
 * even when you knew the answer and Stash was holding it.
 *
 * So this is the other half of that rule rather than an exception to it: you
 * may add anything **Stash already has**, chosen from Stash's own list. Nothing
 * new is created here either.
 *
 * Ordered by how many scenes carry it, because on a library this size the one
 * you mean is nearly always one you already use a lot, and an alphabetical list
 * of nine hundred tags buries it.
 */
const ROSTER = {
  performer: [`query($f: PerformerFilterType) {
    findPerformers(performer_filter: $f, filter: {per_page: 40, sort: "scenes_count", direction: DESC}) {
      count performers { id name scene_count }
    }
  }`, 'findPerformers', 'performers'],
  studio: [`query($f: StudioFilterType) {
    findStudios(studio_filter: $f, filter: {per_page: 40, sort: "scenes_count", direction: DESC}) {
      count studios { id name scene_count }
    }
  }`, 'findStudios', 'studios'],
  tag: [`query($f: TagFilterType) {
    findTags(tag_filter: $f, filter: {per_page: 40, sort: "scenes_count", direction: DESC}) {
      count tags { id name scene_count }
    }
  }`, 'findTags', 'tags'],
};

export async function names(config, kind, term = '') {
  const found = ROSTER[kind];
  if (!found) throw new Error(`There is no list of ${kind} to pick from.`);

  const [query, root, list] = found;
  const q = String(term || '').trim();

  const data = await gql(config, query, {
    f: q ? { name: { value: q, modifier: 'INCLUDES' } } : null,
  });

  return {
    kind,
    count: data[root]?.count ?? 0,
    names: (data[root]?.[list] || []).map((row) => ({
      id: row.id,
      name: row.name,
      scenes: row.scene_count ?? 0,
    })),
  };
}

/* ------------------------------------------------------- making a new one
 *
 * The one thing the roster could not do.
 *
 * "Pick from what Stash has" is the right rule for a *scraped* name: a source
 * spelling a performer three ways is a guess, and three records is what
 * believing all three guesses looks like. But a name **you** typed into the
 * blank box is not a guess and never was — you are looking at the file, you
 * know whose scene it is, and Stash not holding them yet is the ordinary case
 * for a studio nobody has imported before rather than evidence you are wrong.
 *
 * So the blank box stays blank until you ask: nothing is created by typing,
 * and nothing is created by the write. Creating is its own press, on its own
 * button, after the box has told you Stash has nothing by that name.
 *
 * Tags too. They were held back at first on the grounds that a tag you cannot
 * find is usually one that exists under another spelling — which is true, and
 * is also exactly what the box in front of you is for: it has just searched the
 * roster as you typed and come back with nothing. Having looked, you are in a
 * better position to say it is new than this rule was.
 */
const MAKE = {
  performer: [`mutation($n: String!) { performerCreate(input: {name: $n}) { id name } }`, 'performerCreate'],
  studio: [`mutation($n: String!) { studioCreate(input: {name: $n}) { id name } }`, 'studioCreate'],
  tag: [`mutation($n: String!) { tagCreate(input: {name: $n}) { id name } }`, 'tagCreate'],
};

export async function create(config, kind, name) {
  const made = MAKE[kind];
  if (!made) throw new Error(`A ${kind} cannot be created from this page.`);

  const n = String(name || '').trim();
  if (!n) throw new Error('A name is needed.');

  // Somebody else's tab, or a name that differs only in case: Stash would take
  // the second one and you would have two. Hand back the one that exists.
  const already = await idFor(config, kind, n);
  if (already) return { kind, id: already, name: n, made: false };

  const [query, root] = made;
  const data = await gql(config, query, { n });
  const row = data?.[root];
  if (!row?.id) throw new Error(`Stash would not create the ${kind} “${n}”.`);

  return { kind, id: row.id, name: row.name, made: true };
}

/* ------------------------------------------------------------ your own cover
 *
 * A picture off your machine, or off an address you pasted.
 *
 * The row already offers Stash's cover, every scraper's, and any frame this
 * portal has cut out of the file. What it could not offer was the one you
 * have: the DVD sleeve you scanned, or the still on a page whose scraper this
 * library does not have. That was the last field on the page you could see the
 * answer to and not fill.
 *
 * **Held rather than written.** Nothing here touches the scene. An upload is
 * kept in memory under an address of its own, the row draws it like any other
 * option, and it only reaches Stash if you pick it and press Write — the same
 * path a scraper's cover takes. Close the tab and it was never anything.
 *
 * In memory because that is what it is: a choice you are in the middle of
 * making. A folder would need a sweeper, and the failure of a sweeper is a
 * disk full of covers nobody chose. Twelve at a time and an hour each, which
 * is longer than anyone spends on one scene.
 *
 * A pasted address is fetched here rather than handed to Stash as a link, for
 * two reasons worth the round trip: the page can then actually show you what
 * you pasted (hotlink protection refuses the browser and not us), and what
 * Stash gets is bytes this app has already checked are a picture.
 */
const ART_KEEP = 60 * 60 * 1000;
const ART_MOST = 12;

const artHold = new Map();
let artSeq = 0;

const sweepArt = () => {
  const dead = Date.now() - ART_KEEP;
  for (const [id, held] of artHold) if (held.at < dead) artHold.delete(id);
  while (artHold.size > ART_MOST) artHold.delete(artHold.keys().next().value);
};

export const artUrl = (id) => `/api/import/wildcard/art/${id}`;

export function holdArt(buffer) {
  const kind = artwork.checked(buffer);
  const id = `${Date.now().toString(36)}${(++artSeq).toString(36)}`;

  artHold.set(id, { bytes: buffer, kind, at: Date.now() });
  sweepArt();

  return { id, url: artUrl(id), type: kind.type, bytes: buffer.length };
}

export function heldArt(id) {
  const held = artHold.get(String(id));
  if (!held) return null;
  // Read is use: a cover you are still looking at should not expire under you.
  held.at = Date.now();
  return held;
}

/*
 * The same hold, filled from an address instead of a file chooser.
 *
 * http and https only, and the answer has to be a picture by its own header —
 * `artwork.checked` reads the magic bytes, so a page that returns HTML with an
 * image content type is refused here rather than stored as a broken cover.
 */
export async function fetchArt(address) {
  let url;
  try { url = new URL(String(address).trim()); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) {
    throw Object.assign(new Error('That is not a web address this can fetch.'), { status: 400 });
  }

  const res = await fetch(url, { redirect: 'follow' }).catch((err) => {
    throw Object.assign(new Error(`That address could not be reached: ${err.message}`), { status: 502 });
  });
  if (!res.ok) {
    throw Object.assign(new Error(`That address answered ${res.status}.`), { status: 502 });
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  return { ...holdArt(bytes), from: url.href };
}

/*
 * A cover Stash can actually fetch.
 *
 * Everything a scraper offers is an address on somebody's CDN and Stash goes
 * and gets it. A frame cut by this portal is not — its address is
 * `/media/scene/6867/frame/25`, which is relative to the browser that drew the
 * page. Stash is a different container on a different address and would fetch
 * nothing, and the failure would be silent: the write succeeds and the scene
 * has no cover.
 *
 * So a frame is read off disk here and handed over as bytes. Everything else
 * is passed through as the address it is.
 */
const FRAME = /^\/media\/scene\/(\d+)\/frame\/(\d+)(?:\?|$)/;

// The other address of ours: a picture you uploaded or pasted, held in memory
// above. Same problem as a frame and the same answer — Stash cannot fetch it,
// so it goes over as bytes.
const HELD = /^\/api\/import\/wildcard\/art\/([a-z0-9]+)(?:\?|$)/;

async function coverFrom(value) {
  const mine = String(value).match(HELD);
  if (mine) {
    const held = heldArt(mine[1]);
    return held ? artwork.dataUrl(held.bytes, held.kind) : null;
  }

  const local = String(value).match(FRAME);
  if (!local) return value;

  const path = scenethumb.framePath(local[1], local[2]);
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return null;

  return 'data:image/jpeg;base64,' + bytes.toString('base64');
}

const TEXT_FIELDS = ['title', 'date', 'details', 'code', 'director'];

export async function apply(config, sceneId, values = {}, opts = {}) {
  const current = await gql(config, `query($id: ID!) { findScene(id: $id) { ${SCENE} } }`, { id: String(sceneId) });
  if (!current.findScene) throw new Error('Stash has no scene with that id.');

  const input = { id: String(sceneId) };
  const wrote = [];
  const skipped = [];

  for (const key of TEXT_FIELDS) {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    /*
     * The last gate before Stash. The contributions were normalised on arrival,
     * but this is the value the browser handed back and a date Stash cannot
     * read fails the whole write — the cast, the cover and the ids with it.
     */
    if (key === 'date') {
      const when = asDate(value);
      if (!when) { skipped.push(`date “${value.trim()}” is not a date Stash can read`); continue; }
      input.date = when;
      wrote.push('date');
      continue;
    }
    input[key] = value.trim();
    wrote.push(key);
  }

  // Stash fetches the cover itself, given somewhere to fetch it from.
  if (typeof values.image === 'string' && values.image.trim()) {
    const cover = await coverFrom(values.image.trim());
    if (cover) { input.cover_image = cover; wrote.push('cover'); }
    else skipped.push('the picture chosen for the cover is no longer to hand, so the cover was left alone');
  }

  if (typeof values.studioName === 'string' && values.studioName.trim()) {
    const name = values.studioName.trim();
    const id = await idFor(config, 'studio', name);
    if (id) { input.studio_id = id; wrote.push('studio'); }
    else skipped.push(`studio “${name}” is not in Stash`);
  }

  /*
   * The lists replace rather than add to what is already there. On this page a
   * cast is something you assembled by ticking sources against each other, and
   * quietly unioning it with whatever the scene already had would hand you a
   * cast you never chose and cannot see the shape of.
   */
  for (const [key, kind, field] of [
    ['performers', 'performer', 'performer_ids'],
    ['tags', 'tag', 'tag_ids'],
  ]) {
    const names = Array.isArray(values[key])
      ? [...new Set(values[key].map((n) => String(n).trim()).filter(Boolean))]
      : null;
    if (!names || !names.length) continue;

    const ids = [];
    for (const name of names) {
      const id = await idFor(config, kind, name);
      if (id) ids.push(id);
      else skipped.push(`${kind} “${name}” is not in Stash`);
    }
    if (ids.length) { input[field] = [...new Set(ids)]; wrote.push(key); }
  }

  /*
   * The links are added to rather than replaced, which is the opposite of the
   * cast and worth the inconsistency: a URL is a fact about where this scene
   * can be found, and a second address does not make the first one untrue.
   */
  if (Array.isArray(values.urls) && values.urls.length) {
    const now = new Set(current.findScene.urls || []);
    for (const u of values.urls) if (String(u || '').trim()) now.add(String(u).trim());
    input.urls = [...now];
    wrote.push('links');
  }

  if (values.organized === true) { input.organized = true; wrote.push('organised'); }

  if (!wrote.length) throw new Error('Nothing was chosen, so nothing was written.');

  const saved = await gql(
    config,
    `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { ${SCENE} } }`,
    { input }
  );

  /*
   * The rename runs after the write and never before it.
   *
   * renamer.mjs re-plans from Stash rather than being handed a name, so by
   * the time it looks the scene is already carrying the title and studio and
   * date that were just chosen — the file gets named after the record, which
   * is the only order in which that sentence is true. It is also why a refused
   * rename is reported rather than thrown: the write happened, and losing it
   * behind an error about a filename would be the worst of both.
   */
  let renamed = null;
  if (opts.rename) {
    renamed = await renamer.rename(config, sceneId)
      .then((out) => ({ ok: true, to: out.to, scanned: out.scanned }))
      .catch((err) => ({ ok: false, why: err.message }));
  }

  return { scene: briefScene(saved.sceneUpdate), wrote, skipped, renamed };
}
