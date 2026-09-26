/*
 * The play order of a group's parts, shared by the group page and the TV
 * Groups channel (the server imports this file too, so no DOM here).
 *
 * Stash's scene_index is rarely set, so the order is read from the part of
 * each title that isn't the group's name ("pt. 2", "- Scene 4", "Act III").
 */

const escaped = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/* Only numbers with a word saying what they count; a bare number is usually the volume. */
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
 * -> scenes in play order: readable places first, the rest by date, then
 * arrival order.
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
