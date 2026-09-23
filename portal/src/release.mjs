/*
 * The want list, let out a few at a time.
 *
 * Marking a scene as wanted and fetching it are deliberately two acts — see
 * discover.mjs — and the gap between them has been growing: 2,782 scenes
 * marked, 2,309 of them still missing, and 1,890 of those never sent to
 * Whisparr at all. Pressing Add on them one at a time is a week of clicking,
 * and sending them all at once is not a plan either. It would be several
 * thousand searches at somebody else's indexers in a single minute, which is
 * how an account stops working.
 *
 * So: a handful a night, chosen at random, and the rest wait their turn. Ten a
 * day against 1,890 is about six months, which sounds slow until you notice
 * that the list took longer than that to build.
 *
 * **Random rather than oldest-first**, which was a choice. The want list is not
 * a queue — nothing in it is more urgent than anything else, it is just a long
 * record of things that looked good at the time. Oldest-first would work
 * through it in the order it was written, which means months of one studio you
 * went through in an afternoon last spring. Random gives a nightly ten that
 * looks like the list rather than like one corner of it.
 *
 * What goes out is exactly what the Add button sends: monitored, and searched
 * if `searchOnAdd` is on. This is not a second way of fetching things, it is
 * the same way, pressed by a clock.
 */

import { loadConfig, saveConfig, whisparr3Configured } from './config.mjs';
import * as discover from './discover.mjs';
import * as whisparr3 from './whisparr3.mjs';

const SETTINGS = { on: true, perDay: 10, hour: 3, lastRun: '', lastSent: 0 };

// Nothing sensible below 1, and above this it stops being a trickle and
// becomes the thing this exists to avoid.
const MOST = 50;

export const settings = (config) => ({ ...SETTINGS, ...(config.release || {}) });

/*
 * Today, where the portal is standing. A local date rather than UTC, because
 * "has tonight's batch gone" is a question about the night you are in — a UTC
 * date rolls over mid-evening in some timezones and mid-morning in others.
 */
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/* --------------------------------------------------------------- the pool */

/*
 * What is eligible tonight: wanted, not in Stash, and not already in Whisparr.
 *
 * All three matter. Not in Stash is obvious. Not already in Whisparr is the one
 * worth saying out loud — 388 of the missing are monitored already and sending
 * them again would be a search Whisparr has not been asked for, against scenes
 * it is already looking for. A scene nothing has found in six months is not
 * made more likely by asking twice.
 *
 * This is the same annotated view the Tracked page draws, so a scene that has
 * quietly arrived since it was marked drops out of here at the same moment it
 * drops off that page.
 */
export async function pool(config) {
  const view = await discover.trackedSceneView(config, {});
  return (view.scenes || []).filter((s) => !s.stash && (s.whisparr3?.status || 'absent') === 'absent');
}

/*
 * -> what the page needs to draw the control, and the scheduler to decide.
 *
 * `waiting` is the honest size of the backlog and costs a full annotate, so it
 * is only read when somebody is looking; the scheduler does not need it.
 */
export async function view(config) {
  const held = settings(config);
  const ready = whisparr3Configured(config);

  let waiting = null;
  if (ready) waiting = (await pool(config).catch(() => [])).length;

  return {
    ...held,
    ready,
    waiting,
    // Whether tonight's has already gone, which is what the switch reads as
    // "next one tomorrow" rather than "next one in an hour".
    doneToday: held.lastRun === today(),
    sending: Boolean(running),
  };
}

/* --------------------------------------------------------------- the send */

let running = null;
let last = { at: 0, sent: [], failed: [] };

export const busy = () => Boolean(running);
export const lastRelease = () => ({ ...last });

// Between one add and the next. Each is a write to Whisparr plus, usually, a
// search command it fans out to every indexer — ten of those in a second is
// the burst this whole module exists to avoid.
const BREATH = 3000;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/*
 * Pick and send. -> what went and what would not.
 *
 * Sequential, and it keeps going past a failure: one scene Whisparr will not
 * take — a dead StashDB id, a scene it has an import exclusion for — is not a
 * reason for the other nine to stay in.
 */
async function send(config, limit) {
  const ready = await pool(config);

  // Fisher-Yates over a copy. Sorting by Math.random() is the usual shortcut
  // and it is not a shuffle; with a comparator that disagrees with itself the
  // result is neither random nor stable.
  const bag = ready.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }

  const going = bag.slice(0, limit);
  const sent = [];
  const failed = [];

  for (const scene of going) {
    try {
      const out = await whisparr3.addScene(config, scene.id);
      sent.push({ id: scene.id, title: scene.title || '', searched: Boolean(out.searched) });
    } catch (err) {
      failed.push({ id: scene.id, title: scene.title || '', why: err.message });
    }
    if (going.indexOf(scene) < going.length - 1) await wait(BREATH);
  }

  last = { at: Date.now(), sent, failed };
  return { sent, failed, waiting: Math.max(0, ready.length - sent.length) };
}

/*
 * Tonight's batch, marked as done before anything is sent.
 *
 * The date is written first on purpose. If the portal dies halfway through ten
 * adds, the ones that went are in Whisparr and cannot be unsent — and a restart
 * that decides tonight has not happened yet would send ten more. A night that
 * half happened is a night that happened.
 */
export async function release(config, { limit = null, manual = false } = {}) {
  if (running) throw new Error('A release is already going out.');
  if (!whisparr3Configured(config)) throw new Error('Whisparr v3 needs a root folder and quality profile before it can add anything.');

  const held = settings(config);
  const many = Math.min(MOST, Math.max(1, Number(limit) || held.perDay));

  if (!manual) await saveConfig({ release: { ...held, lastRun: today() } });

  running = send(config, many)
    .then(async (out) => {
      const now = await loadConfig();
      await saveConfig({ release: { ...settings(now), lastSent: out.sent.length } });
      console.log(`[tpdbarr] release: ${out.sent.length} sent to Whisparr v3, ${out.failed.length} refused, ${out.waiting} still waiting`);
      return out;
    })
    .finally(() => { running = null; });

  return running;
}

export async function update(config, patch = {}) {
  const held = settings(config);

  const next = {
    ...held,
    on: 'on' in patch ? Boolean(patch.on) : held.on,
    perDay: 'perDay' in patch ? Math.min(MOST, Math.max(1, Number(patch.perDay) || held.perDay)) : held.perDay,
    hour: 'hour' in patch ? Math.min(23, Math.max(0, Number(patch.hour) || 0)) : held.hour,
  };

  await saveConfig({ release: next });
  return view(await loadConfig());
}

/* ----------------------------------------------------------- the schedule */

/*
 * Checked hourly rather than slept until, because an interval started at boot
 * drifts with every restart and this library restarts the portal several times a
 * day. The question asked each hour is small and local: is it on, is it late
 * enough, and has today's already gone.
 */
const EVERY = 60 * 60 * 1000;

export function schedule() {
  const tick = async () => {
    try {
      const config = await loadConfig();
      const held = settings(config);

      if (!held.on || running) return;
      if (held.lastRun === today()) return;
      if (new Date().getHours() < held.hour) return;
      if (!whisparr3Configured(config)) return;

      await release(config).catch((err) => {
        console.warn('[tpdbarr] release:', err.message);
      });
    } catch {
      // A night that could not go out is not a reason to bring the portal down.
    }
  };

  /*
   * Not at boot, and the delay is not politeness. The pool is read through the
   * same annotate the Tracked page uses — every wanted scene asked of Stash and
   * of Whisparr — and doing that while the portal is still warming its caches
   * would make the first page anyone opens the slow one.
   */
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, EVERY);
}
