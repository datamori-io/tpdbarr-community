/*
 * A shuffle that is random every visit and identical within one.
 *
 * The reel needs both halves of that. Paging has to hold together — page two
 * must not re-deal the cards page one was dealt from, or you get the same clip
 * twice and miss another entirely — but arriving tomorrow has to give a
 * different order, or it is not a shuffle at all.
 *
 * So: the client picks a seed once per visit and sends it with every page. The
 * library reel already worked this way, passing the seed into Stash's own sort.
 * RedGIFs and Reddit did not — they took `slice((page - 1) * take, page * take)`
 * off a list in insertion order, with no seed anywhere near them. That is not a
 * weak shuffle, it is no shuffle: the first clips of the first page were the
 * same first clips every session, for every session, which is exactly what it
 * looked like from the sofa.
 *
 * mulberry32 rather than anything cleverer. It is thirty characters of integer
 * arithmetic, it has no state to keep between calls, and the quality needed
 * here is "does not visibly repeat", not cryptographic.
 */

// A seed arrives as a string of digits from a query parameter. Anything that is
// not one still has to produce a number, and the same number each time.
function hash(seed) {
  const text = String(seed ?? '');
  let value = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }

  return value >>> 0;
}

export function rng(seed) {
  let state = hash(seed) || 1;

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * Fisher-Yates, on a copy. The caller's array is usually a cache that outlives
 * the request, so shuffling it in place would reorder what everybody else sees
 * and make the next request's "deterministic" order a different one.
 */
export function shuffled(list, seed) {
  const out = [...list];
  const next = rng(seed);

  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}

/*
 * The page of a shuffled list, for a source that is mixed into something else.
 *
 * Wraps rather than running out. These pools are small next to a library —
 * a few hundred clips against a few thousand markers — so a long sitting will
 * reach the end of one while the library still has pages to give. Wrapping with
 * a re-shuffle on each lap means it keeps offering clips instead of quietly
 * dropping out of the mix, and the second lap is not in the same order as the
 * first.
 */
export function page(list, seed, at, take) {
  if (!list.length || take <= 0) return [];

  const size = list.length;
  const start = (at - 1) * take;

  // Which lap round the pool this page falls on, so each lap gets its own deal.
  const lap = Math.floor(start / size);
  const deck = shuffled(list, `${seed}:${lap}`);

  // A pool smaller than the page cannot fill it without handing back the same
  // clip twice, which is the thing this whole file exists to stop.
  const want = Math.min(take, size);

  const out = [];
  for (let i = 0; i < want; i += 1) out.push(deck[(start + i) % size]);

  return out;
}
