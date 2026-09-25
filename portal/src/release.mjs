/*
 * The nightly release: a few want-list scenes sent to Whisparr each night,
 * chosen at random (the list isn't a queue), rather than thousands of
 * searches at once. Sends exactly what Add sends.
 */

import { loadConfig, saveConfig, whisparr3Configured } from './config.mjs';
import * as discover from './discover.mjs';
import * as whisparr3 from './whisparr3.mjs';

const SETTINGS = { on: true, perDay: 10, hour: 3, lastRun: '', lastSent: 0 };

// Nothing sensible below 1, and above this it stops being a trickle and
// becomes the thing this exists to avoid.
const MOST = 50;

export const settings = (config) => ({ ...SETTINGS, ...(config.release || {}) });

/* Today as a local date. */
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/* --------------------------------------------------------------- the pool */

/*
 * Eligible: wanted, not in Stash, not already in Whisparr. Same annotated
 * view as the Tracked page.
 */
export async function pool(config) {
  const view = await discover.trackedSceneView(config, {});
  return (view.scenes || []).filter((s) => !s.stash && (s.whisparr3?.status || 'absent') === 'absent');
}

/*
 * -> what the page and scheduler need. `waiting` costs a full annotate,
 * so only when someone's looking.
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

// Pause between adds.
const BREATH = 3000;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/* Pick and send, one at a time, carrying on past failures. */
async function send(config, limit) {
  const ready = await pool(config);

  // Fisher-Yates on a copy (sorting by Math.random() isn't a shuffle).
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

/* Mark the night done before sending, so a crash can't send twice. */
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

/* Checked hourly: is it on, is it late enough, has today's gone. */
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

  /* Not at boot: the pool read is heavy while caches warm. */
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, EVERY);
}
