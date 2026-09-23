/*
 * Connections — the boxes this portal talks to.
 *
 * The form is not rebuilt here. It lives in the document and is borrowed:
 * detaching a node does not destroy it, so the save and test handlers bound at
 * the bottom of this file go on working however many times you come and go
 * from this page.
 *
 * The gallery folder pair sits in a holder of its own next door, because it is
 * the Galleries page's question rather than this one's. One Save still writes
 * the lot — there is a single config document and half a save would blank the
 * other half — but the two boxes are read by direct reference rather than
 * through the form.
 *
 * **They cannot be form-associated, however well `form="settings-form"` reads.**
 * That association only holds while both nodes are in the same document tree,
 * and these two are borrowed onto different pages independently: stand the
 * fieldset on Settings › Galleries, navigate, and the form is the detached one
 * — at which point a name lookup through it is undefined and this page throws
 * on the way in, leaving the address bar saying Connections over whatever was
 * on screen before. Which is exactly what it did.
 */

import { api, el } from '../util.js';
import { refreshState, state } from '../import/core.js';
import { shell } from './core.js';

const form = document.getElementById('settings-form');
const note = document.getElementById('settings-note');
const galleryFields = document.getElementById('gallery-fields');
const galleryPath = document.getElementById('gallery-path');
const galleryStashPath = document.getElementById('gallery-stash-path');

export const SECTION = '#/parameters';

export function showConnections(paint) {
  fillForm();
  shell(paint, SECTION, 'Connections', 'the boxes this portal talks to', form);
}

// The gallery folder pair, for the Galleries page to stand on.
export const galleryFieldset = () => galleryFields;

export function fillForm() {
  const config = state?.config || {};
  form.whisparrUrl.value = config.whisparrUrl || '';
  form.stashUrl.value = config.stashUrl || '';
  form.searchOnAdd.checked = config.searchOnAdd !== false;
  form.cutThumbs.checked = config.cutThumbs !== false;
  form.whisparr3Url.value = config.whisparr3Url || '';
  form.apiKey.placeholder = config.apiKeySet ? 'unchanged' : '';
  form.stashApiKey.placeholder = config.stashApiKeySet ? 'unchanged' : '';
  form.whisparr3ApiKey.placeholder = config.whisparr3ApiKeySet ? 'unchanged' : '';
  form.tmdbApiKey.placeholder = config.tmdbApiKeySet ? 'unchanged' : '';
  form.prowlarrUrl.value = config.prowlarrUrl || '';
  form.prowlarrApiKey.placeholder = config.prowlarrApiKeySet ? 'unchanged' : '';
  form.nzbgetUrl.value = config.nzbgetUrl || '';
  form.nzbgetUsername.value = config.nzbgetUsername || '';
  form.nzbgetPassword.placeholder = config.nzbgetPasswordSet ? 'unchanged' : '';
  form.nzbgetCategory.value = config.nzbgetCategory || '';
  // One folder, two paths: the portal writes there, Stash scans it.
  galleryPath.value = config.galleryPath || '';
  galleryStashPath.value = config.galleryStashPath || '';
  note.textContent = '';

  if (config.whisparrUrl) loadOptions(config);
}

async function loadOptions(config) {
  try {
    const { qualityProfiles, rootFolders } = await api('/api/options');
    fill(form.qualityProfileId, qualityProfiles.map((p) => [p.id, p.name]), config.qualityProfileId);
    fill(form.rootFolderPath, rootFolders.map((f) => [f.path, f.path]), config.rootFolderPath);
  } catch (err) {
    note.textContent = 'Whisparr v2: ' + err.message;
  }

  // v3 is optional, so a v3 that is not set up yet is silence, not an error.
  try {
    const v3 = await api('/api/options?instance=v3');
    fill(form.whisparr3QualityProfileId, v3.qualityProfiles.map((p) => [p.id, p.name]), config.whisparr3QualityProfileId);
    fill(form.whisparr3RootFolderPath, v3.rootFolders.map((f) => [f.path, f.path]), config.whisparr3RootFolderPath);
  } catch {
    fill(form.whisparr3QualityProfileId, [], null);
    fill(form.whisparr3RootFolderPath, [], null);
  }
}

function fill(select, pairs, selected) {
  select.replaceChildren(...pairs.map(([value, label]) =>
    el('option', { value: String(value), selected: String(value) === String(selected) }, label)
  ));
}

function formValues() {
  return {
    whisparrUrl: form.whisparrUrl.value.trim(),
    apiKey: form.apiKey.value.trim(),
    qualityProfileId: Number(form.qualityProfileId.value) || 0,
    rootFolderPath: form.rootFolderPath.value,
    searchOnAdd: form.searchOnAdd.checked,
    stashUrl: form.stashUrl.value.trim(),
    stashApiKey: form.stashApiKey.value.trim(),
    cutThumbs: form.cutThumbs.checked,
    whisparr3Url: form.whisparr3Url.value.trim(),
    whisparr3ApiKey: form.whisparr3ApiKey.value.trim(),
    whisparr3QualityProfileId: Number(form.whisparr3QualityProfileId.value) || 0,
    whisparr3RootFolderPath: form.whisparr3RootFolderPath.value,
    tmdbApiKey: form.tmdbApiKey.value.trim(),
    galleryPath: galleryPath.value.trim(),
    galleryStashPath: galleryStashPath.value.trim(),
    fileflowsUrl: form.fileflowsUrl.value.trim(),
    fileflowsApiKey: form.fileflowsApiKey.value.trim(),
    prowlarrUrl: form.prowlarrUrl.value.trim(),
    prowlarrApiKey: form.prowlarrApiKey.value.trim(),
    nzbgetUrl: form.nzbgetUrl.value.trim(),
    nzbgetUsername: form.nzbgetUsername.value.trim(),
    nzbgetPassword: form.nzbgetPassword.value,
    nzbgetCategory: form.nzbgetCategory.value.trim() || 'Manual',
  };
}

/*
 * One write of the whole form, wherever it was pressed from. The gallery page
 * has a Save of its own for the two paths it shows, and it is this one — there
 * is a single config document and half a save would blank the other half.
 */
export async function saveConfig() {
  const { warnings } = await api('/api/config', { method: 'POST', body: JSON.stringify(formValues()) });
  await refreshState();
  return warnings || [];
}

// ---------------------------------------------------------------- the form

document.getElementById('settings-test').onclick = async () => {
  note.textContent = 'Saving and testing…';
  const warnings = await saveConfig();
  loadOptions(state.config);

  const lines = [...warnings];
  lines.push(state.whisparr.ok
    ? `Whisparr ${state.whisparr.version}${state.whisparr.isV2 ? ' — ok' : ' — not a v2 instance'}`
    : `Whisparr: ${state.whisparr.error || 'not configured'}`);

  if (state.stash.enabled) {
    lines.push(state.stash.ok
      ? `Stash ${state.stash.version} — ${state.stash.endpoint ? 'TPDB stash-box found, exact matching on' : 'no TPDB stash-box, title + date matching only'}`
      : `Stash: ${state.stash.error}`);
  }
  note.textContent = lines.join('\n');
};

document.getElementById('settings-save').onclick = async () => {
  try {
    const warnings = await saveConfig();
    if (warnings.length) {
      note.textContent = warnings.join('\n');
      return; // stay open so the problem is visible
    }
    note.textContent = 'Saved.';
    // A saved URL is a new set of profiles and root folders to choose from.
    loadOptions(state.config);
  } catch (err) {
    note.textContent = err.message;
  }
};
