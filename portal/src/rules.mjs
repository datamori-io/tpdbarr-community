/*
 * Standing answers, for the scenes you would have said no to anyway.
 *
 * The decide queue is one card at a time, which is the right shape for a
 * decision and the wrong one for a foregone conclusion. Fourteen studios and
 * thirty-two performers came to 9,381 scenes still to answer for, and most of
 * them were a no on sight — under twenty minutes, a compilation, or older than
 * anything this library is interested in. Answering those one at a time is not
 * deciding, it is typing.
 *
 * So a rule is a no you only have to give once. The queue applies them as it
 * fills and says how many it took, and the tracked counts apply them too — a
 * heading that says 9,381 over a queue holding 1,500 would be the page lying
 * about the size of the job.
 *
 * **Nothing is written.** A rule hides; it does not skip. Skipping is a
 * decision recorded against a scene and undone one at a time; a rule is a view
 * of the pile and undone by deleting the rule, at which point everything it
 * was holding back comes straight back. That difference is the whole reason
 * this is not just the sweep with a filter on it.
 *
 * **What cannot be measured is never hidden.** A scene StashDB has no duration
 * for does not match "shorter than 20 minutes" — it matches nothing, and it
 * reaches you. A rule that hid the unknown would quietly eat the records that
 * are thin for some other reason, which is the opposite of what it is for.
 */

/*
 * The five, and what each reads off a scene.
 *
 * `rich` marks the two that need more than StashDB's brief record — duration
 * and tags are not in the id/title/date shape the coverage pass reads, so a
 * rule using them asks for a bigger record. Kept here rather than in the
 * caller so that adding a sixth kind cannot forget to say what it costs.
 */
export const KINDS = {
  shorter: { label: 'Shorter than', unit: 'minutes', rich: true },
  before: { label: 'Released before', unit: 'year', rich: false },
  after: { label: 'Released after', unit: 'year', rich: false },
  tag: { label: 'Tagged', unit: 'tag', rich: true },
  title: { label: 'Title contains', unit: 'words', rich: false },
  studio: { label: 'From studio', unit: 'name', rich: false },
};

/* ------------------------------------------------------------- where it bites
 *
 * A rule with no `on` is the blanket one: VR is VR wherever it turns up, and
 * that is most of what anybody wants.
 *
 * The other kind is the one a blanket cannot say. "Nothing before 2015" is
 * wrong as a standing answer and right about one performer whose early work
 * you have already been through; "not this studio" is wrong everywhere and
 * right for one person who guested there twice. So a rule can name a
 * catalogue, and then it only looks at scenes inside it.
 *
 * Stored with the name beside the id, the same as a tracked entry, so a rule
 * still reads as a sentence when StashDB is not there to be asked.
 */
export const SCOPES = { performer: 'performer', studio: 'studio', tag: 'tag' };

const cleanScope = (raw) => {
  const kind = String(raw?.kind || '');
  const id = String(raw?.id || '').trim();
  if (!SCOPES[kind] || !id) return null;
  return { kind, id, name: String(raw?.name || '').trim() || id };
};

const text = (value) => String(value ?? '').trim().toLowerCase();

/*
 * One rule, cleaned up. Anything that would match nothing — a blank phrase, a
 * length of zero — comes back null rather than being stored as a rule that
 * does not do anything.
 */
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

/*
 * Whether anything here has to know who is in a scene.
 *
 * Asked separately from `needsRich` because it costs more: the coverage pass
 * reads a stripped record of every scene of every catalogue you follow, and
 * the cast is the one field that is a list of its own. A rule about a
 * performer is worth it; the other four should not pay for it.
 */
export const needsCast = (rules) => cleanAll(rules).some((rule) => rule.on?.kind === 'performer');

/*
 * -> the rule that catches this scene, or null.
 *
 * The first match rather than all of them: the queue only has to say why a
 * scene is not in front of you, and "the first reason" is a shorter sentence
 * than "the reasons".
 */
export function caughtBy(scene, rules) {
  for (const rule of rules) {
    if (!inScope(scene, rule.on)) continue;
    if (matches(scene, rule)) return rule;
  }
  return null;
}

/*
 * Is this scene inside the catalogue the rule was written about?
 *
 * By id where the record has one and by name where it does not, the same two
 * passes everything else here uses. A scope that cannot be checked — a rule
 * about a performer, on a record with no cast — is not a match, so the scene
 * reaches you. Silently applying a rule you cannot verify is how a queue
 * starts hiding things for reasons it cannot explain.
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
     * Tag, title and studio are all keyword, not equality.
     *
     * A standing answer is written in the words you would have said out loud,
     * and out loud "no VR" is a thing about a name, not a studio you could
     * pick off a list. Exact matching meant a rule of "VR" let CockVR and
     * VRBangers straight through, and the only way to get them was to write a
     * rule per studio and keep writing them as new ones appeared. The same
     * goes for tags: "BDSM" should catch "BDSM Hardcore".
     *
     * It over-reaches in the other direction — a two-letter rule will hit
     * names nobody meant — but a rule hides rather than skips, so an
     * over-reaching one is visible in the held-back count and undone by
     * deleting it. Nothing is written against a scene either way.
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

/*
 * How a rule reads on screen and in a tooltip. One sentence, the same words
 * the editor uses, so a count that says "held back by your rules" can name the
 * one that did it.
 */
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
