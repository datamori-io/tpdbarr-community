/* Sending to a downloader. Which Whisparr a button talks to is never implied. */

import { api, el } from '../util.js';

export const postAdd = (siteId, sceneIds) =>
  api('/api/add', { method: 'POST', body: JSON.stringify({ siteId, sceneIds }) });

/*
 * Add one scene, StashDB first: v3 when StashDB has it, else TPDB and v2.
 * A fingerprint match goes straight through; a title match asks.
 */
export async function addOne(scene, trigger, redraw) {
  const label = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = 'Checking StashDB…';

  let found = null;
  try {
    if (scene.guid) found = await api('/api/stashdb/bridge/' + scene.guid);
  } catch {
    // StashDB being unreachable is not a reason to refuse the ThePornDB route.
  }

  if (found?.match === 'exact') return sendToV3(found.scene, trigger, label);
  if (found?.match === 'probable') return askWhich(found, scene, trigger, label, redraw);

  return sendToV2(scene, trigger, label, redraw);
}

async function sendToV3(candidate, trigger, label) {
  trigger.textContent = 'Sending to Whisparr v3…';
  try {
    const result = await api(`/api/whisparr3/scenes/${candidate.id}`, { method: 'POST' });
    trigger.textContent = result.searched ? 'Sent to v3, searching' : 'Monitored in v3';
  } catch (err) {
    trigger.disabled = false;
    trigger.textContent = label;
    alert(err.message);
  }
}

async function sendToV2(scene, trigger, label, redraw) {
  if (!scene.siteId) {
    trigger.disabled = false;
    trigger.textContent = label;
    alert('Neither StashDB nor ThePornDB can place this scene, so there is nowhere to send it.');
    return;
  }

  trigger.textContent = 'Adding…';
  try {
    await postAdd(scene.siteId, [scene.id]);
    scene.status = 'monitored';
    redraw();
  } catch (err) {
    trigger.disabled = false;
    trigger.textContent = label;
    alert(err.message);
  }
}

/* The probable match, put to you: v3 or v2. */
function askWhich(found, scene, trigger, label, redraw) {
  const candidate = found.scene;
  const others = found.others?.length || 0;

  const yes = el('button', { className: 'primary', type: 'button' }, 'Yes — send to v3');
  const no = el('button', { type: 'button' }, 'No — ThePornDB, v2');

  const panel = el('div', { className: 'bridgeask' },
    el('p', {}, `StashDB has a likely match on ${found.via}, but not a certain one:`),
    el('p', { className: 'bridgehit' },
      el('a', { className: 'link', href: candidate.url, target: '_blank', rel: 'noreferrer' }, candidate.title + ' ↗'),
      el('span', { className: 'muted' }, [candidate.studioName, candidate.date].filter(Boolean).join(' · '))
    ),
    candidate.stash ? el('p', { className: 'muted' }, 'That one is already in your library.') : null,
    others ? el('p', { className: 'muted' }, `${others} other candidate${others === 1 ? '' : 's'} with the same title.`) : null,
    el('div', { className: 'bridgebuttons' }, yes, no)
  );

  trigger.after(panel);
  trigger.textContent = 'Which one?';

  yes.onclick = () => { panel.remove(); sendToV3(candidate, trigger, label); };
  no.onclick = () => { panel.remove(); sendToV2(scene, trigger, label, redraw); };
}

/* One request per site (Whisparr adds per site). */
export async function addMissing(scenes, trigger, redraw) {
  const missing = scenes.filter((s) => s.status === 'absent' && !s.stash && s.siteId);
  if (!missing.length) return;

  trigger.disabled = true;
  trigger.textContent = `Adding ${missing.length}…`;

  const bySite = new Map();
  for (const scene of missing) {
    if (!bySite.has(scene.siteId)) bySite.set(scene.siteId, []);
    bySite.get(scene.siteId).push(scene.id);
  }

  try {
    for (const [siteId, ids] of bySite) {
      const result = await postAdd(siteId, ids);
      const added = new Set(result.added);
      for (const scene of missing) if (added.has(scene.id)) scene.status = 'monitored';
    }
    redraw();
  } catch (err) {
    trigger.disabled = false;
    trigger.textContent = `Add the ${missing.length} you do not have`;
    alert(err.message);
  }
}
