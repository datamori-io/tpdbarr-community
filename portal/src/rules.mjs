/*
 * Standing noes for the decide queue: a no you give once (too short, a
 * compilation, too old). The queue and the tracked counts both apply them.
 *
 * A rule hides, it doesn't skip: nothing is written, and deleting the rule
 * brings everything back. A scene missing the field a rule reads (e.g. no
 * duration) is never hidden.
 */

/*
 * The five kinds. `rich` marks those that need duration or tags, which
 * cost a bigger record.
 */
export const KINDS = {
  shorter: { label: 'Shorter than', unit: 'minutes', rich: true },
  before: { label: 'Released before', unit: 'year', rich: false },
  after: { label: 'Released after', unit: 'year', rich: false },
  tag: { label: 'Tagged', unit: 'tag', rich: true },
  title: { label: 'Title contains', unit: 'words', rich: false },
  studio: { label: 'From studio', unit: 'name', rich: false },
};

/*
 * ------------------------------------------------------------- where it bites
 *
 * No `on`: applies everywhere. With `on`: only inside that catalogue.
 * Stored with the name, so it reads as a sentence offline.
 */
export const SCOPES = { performer: 'performer', studio: 'studio', tag: 'tag' };

const cleanScope = (raw) => {
  const kind = String(raw?.kind || '');
  const id = String(raw?.id || '').trim();
  if (!SCOPES[kind] || !id) return null;
  return { kind, id, name: String(raw?.name || '').trim() || id };
};

const text = (value) => String(value ?? '').trim().toLowerCase();

/* One rule, cleaned. A rule that would match nothing returns null. */
export function clean(raw) {
  const kind = String(raw?.kind || '');
  if (!KINDS[kind]) return null;

  const on = cleanScope(raw?.on);

  if (kind === 'shorter' || kind === 'before' || kind === 'after') {
    const n = Math.floor(Number(raw.value));
    if (!Number.isFinite(n) || n <= 0) return null;
    return on ? { kind, value: n, on } : { kind, value: n };
  }

  const value = String(raw.value ?? '').trim();
  if (!value) return null;
  return on ? { kind, value, on } : { kind, value };
}

export const cleanAll = (list) => (Array.isArray(list) ? list.map(clean).filter(Boolean).slice(0, 40) : []);

export const needsRich = (rules) =>
  cleanAll(rules).some((rule) => KINDS[rule.kind].rich || rule.on?.kind === 'tag');

/* Whether any rule needs the cast (a list per scene, so it costs more). */
export const needsCast = (rules) => cleanAll(rules).some((rule) => rule.on?.kind === 'performer');

/* -> the first rule that catches this scene, or null. */
export function caughtBy(scene, rules) {
  for (const rule of rules) {
    if (!inScope(scene, rule.on)) continue;
    if (matches(scene, rule)) return rule;
  }
  return null;
}

/*
 * Is this scene inside the rule's catalogue? By id, else by name. If it
 * can't be checked, it isn't a match.
 */
function inScope(scene, on) {
  if (!on) return true;

  if (on.kind === 'performer') {
    return (scene.performers || []).some((p) => p.id === on.id || text(p.name) === text(on.name));
  }
  if (on.kind === 'studio') {
    return scene.studio?.id === on.id
      || text(scene.studioName || scene.studio?.name) === text(on.name)
      || text(scene.network) === text(on.name);
  }
  return (scene.tags || []).some((tag) => text(tag) === text(on.name));
}

function matches(scene, rule) {
  switch (rule.kind) {
    case 'shorter': {
      // Minutes, as stashdb.mjs hands them over. No duration is not a short
      // scene, it is an unmeasured one.
      const mins = Number(scene.duration);
      return Number.isFinite(mins) && mins > 0 && mins < rule.value;
    }
    case 'before': {
      const year = Number(String(scene.date || '').slice(0, 4));
      return Number.isFinite(year) && year > 0 && year < rule.value;
    }
    case 'after': {
      const year = Number(String(scene.date || '').slice(0, 4));
      return Number.isFinite(year) && year > 0 && year > rule.value;
    }
    /*
     * Tag, title and studio match as keywords ("VR" catches CockVR). An
     * over-reaching rule shows in the held-back count and is easy to delete.
     */
    case 'tag': {
      const wanted = text(rule.value);
      return Boolean(wanted) && (scene.tags || []).some((tag) => text(tag).includes(wanted));
    }
    case 'title':
      return Boolean(scene.title) && text(scene.title).includes(text(rule.value));
    case 'studio': {
      const wanted = text(rule.value);
      const name = text(scene.studioName || scene.studio?.name);
      const network = text(scene.network);
      return Boolean(wanted) && (name.includes(wanted) || network.includes(wanted));
    }
    default:
      return false;
  }
}

/* A rule as one sentence, for screen and tooltip. */
export function say(rule) {
  const what = (() => {
    switch (rule.kind) {
      case 'shorter': return `shorter than ${rule.value} minutes`;
      case 'before': return `released before ${rule.value}`;
      case 'after': return `released after ${rule.value}`;
      case 'tag': return `tagged something with “${rule.value}” in it`;
      case 'title': return `title contains “${rule.value}”`;
      case 'studio': return `from a studio with “${rule.value}” in the name`;
      default: return 'a rule';
    }
  })();

  return rule.on ? `${what}, in ${rule.on.name}` : what;
}
