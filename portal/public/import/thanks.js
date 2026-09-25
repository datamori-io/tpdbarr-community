/* Who this is built on. */

import { el } from '../util.js';
import { paint, painterFor } from './core.js';

/*
 * ================================================================== thanks
 *
 * What this portal stands on, grouped by what each is for. Every host here
 * appears in src/; keep the list in step with the code.
 */

const THANKS = [
  {
    group: 'The library',
    note: 'where everything ends up, and the only thing here that is the record',
    items: [
      { name: 'Stash', url: 'https://stashapp.cc',
        role: 'The library of record. Everything the portal counts, it counts here.' },
    ],
  },
  {
    group: 'The catalogues',
    note: 'what exists, according to people who write it down for nothing',
    items: [
      { name: 'StashDB', url: 'https://stashdb.org',
        role: 'The scene catalogue the search runs on. Its ids follow a scene all the way into Stash.' },
      { name: 'ThePornDB', url: 'https://theporndb.net',
        role: 'Movies, artwork, fingerprints, and the wild card for anything StashDB has never heard of.' },
      { name: 'TMDB', url: 'https://www.themoviedb.org',
        role: 'Second source for films, where the adult catalogues have nothing. This product uses the TMDB API but is not endorsed or certified by TMDB.' },
      { name: 'IAFD', url: 'https://www.iafd.com',
        role: 'Second source for performers — the vitals no stash-box carries.' },
      { name: 'Adult Film Database', url: 'https://www.adultfilmdatabase.com',
        role: 'Where a group has no URL of its own. Studio facts, and the odd cover.' },
      { name: 'timestamp.trade', url: 'https://timestamp.trade',
        role: 'Scene markers, and the running time of a group when nothing else knows it.' },
    ],
  },
  {
    group: 'Getting it here',
    note: 'the pipeline, in the order a file goes through it',
    items: [
      { name: 'Whisparr v2', url: 'https://github.com/Whisparr/Whisparr',
        role: 'A Sonarr fork with sites as series. The only way in for a ThePornDB scene.' },
      { name: 'Whisparr v3 (Eros)', url: 'https://github.com/Whisparr/Whisparr',
        role: 'A Radarr fork where a scene is a movie. How StashDB scenes arrive.' },
      { name: 'NZBGet', url: 'https://nzbget.com',
        role: 'The downloader underneath both of them.' },
      { name: 'FileFlows', url: 'https://fileflows.com',
        role: 'Encodes what Whisparr grabs and moves it where Stash will find it.' },
    ],
  },
  {
    group: 'Pictures',
    note: 'photo sets, found by name and read a page at a time',
    items: [
      { name: 'PornPics', url: 'https://www.pornpics.com', role: 'Galleries listed per performer.' },
      { name: 'EliteBabes', url: 'https://www.elitebabes.com', role: 'Galleries listed per model.' },
      { name: 'Girls of Desire', url: 'https://www.girlsofdesire.org', role: 'Searched rather than browsed — it has no per-performer page.' },
    ],
  },
  {
    group: 'Clips',
    note: 'the reel, and nothing on this row is kept — it can always be fetched again',
    items: [
      { name: 'RedGIFs', url: 'https://www.redgifs.com', role: 'Creators and tags, polled slowly.' },
      { name: 'Reddit', url: 'https://www.reddit.com', role: 'The same, from the other direction.' },
    ],
  },
  {
    group: 'What it is built with',
    note: 'a short list on purpose',
    items: [
      { name: 'Node.js', url: 'https://nodejs.org',
        role: 'The whole app is the standard library. No framework, no dependencies.' },
      { name: 'Docker', url: 'https://www.docker.com',
        role: 'Everything above, side by side, on one machine.' },
    ],
  },
];

export function showThanks() {
  const paint = painterFor();

  paint(
    el('div', { className: 'listhead' },
      el('h1', {}, 'Thanks'),
      el('p', { className: 'muted' },
        'Almost nothing here is original. The catalogues are other people’s work, kept up by ' +
        'volunteers; the downloaders and the encoder are other people’s software; the library ' +
        'itself is Stash. This is a way of pointing them at each other.')
    ),
    ...THANKS.map((section) =>
      el('section', { className: 'feed' },
        el('div', { className: 'feedhead' },
          el('h2', {}, section.group),
          el('span', { className: 'muted' }, section.note)
        ),
        el('div', { className: 'thanks' }, section.items.map(thanksRow))
      )
    ),
    el('p', { className: 'muted small thanksfoot' },
      'Every host on this page appears somewhere in the source. If something is added to the app ' +
      'and not to this list, the list is the thing that is wrong.')
  );
}

function thanksRow(item) {
  return el('div', { className: 'crow thanksrow' },
    el('div', {},
      el('a', { className: 'title', href: item.url, target: '_blank', rel: 'noreferrer' }, item.name),
      el('div', { className: 'meta' }, el('span', {}, item.role))
    ),
    el('span', { className: 'muted small path' }, item.url.replace(/^https?:\/\//, ''))
  );
}
