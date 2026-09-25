/*
 * A shuffle that differs per visit and holds within one. The client picks
 * a seed per visit and sends it with every page. mulberry32: small,
 * stateless, good enough.
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

/* Fisher-Yates on a copy; the input is usually a shared cache. */
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
 * One page of a shuffled list for a mixed-in source. Wraps with a fresh
 * shuffle each lap, since these pools are smaller than the library.
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
