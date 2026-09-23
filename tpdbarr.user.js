// ==UserScript==
// @name         tpdbarr
// @namespace    https://theporndb.net/
// @version      0.1.0
// @description  Send ThePornDB scenes to Whisparr v2 with one click. The v2/TPDB counterpart to stasharr.
// @match        https://theporndb.net/*
// @icon         https://theporndb.net/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      api.whisparr.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/*
 * How this works
 * --------------
 * Whisparr v2 is a Sonarr fork: a TPDB *site* is a series, a TPDB *scene* is an
 * episode, and episode.tvdbId holds the TPDB scene id.
 *
 *   1. Read the scene slug + site slug off the TPDB page.
 *   2. api.whisparr.com/v3/site/search?q=<siteSlug>  -> TPDB site id
 *   3. GET  /api/v3/series?tvdbId=<siteId>           -> already added?
 *      GET  /api/v3/series/lookup?term=tpdb:<siteId> -> if not
 *      POST /api/v3/series  (addOptions.monitor = none)
 *   4. api.whisparr.com/v3/site/<siteId>             -> scene slug -> TPDB scene id
 *   5. GET  /api/v3/episode?seriesId=<id>            -> match on tvdbId
 *   6. PUT  /api/v3/episode/monitor {episodeIds, monitored:true}
 *   7. POST /api/v3/command {name:"EpisodeSearch", episodeIds}
 *
 * Adding the site with monitor:none means nothing is grabbed except the scenes
 * you explicitly click. Nothing here writes to TPDB.
 */

(function () {
  'use strict';

  const META = 'https://api.whisparr.com/v3';
  const SITE_CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

  // ---------------------------------------------------------------- settings

  const defaults = {
    whisparrUrl: '',
    apiKey: '',
    qualityProfileId: 0,
    rootFolderPath: '',
    searchOnAdd: true,
    seriesType: 'standard',
    stashUrl: '',
    stashApiKey: '',
  };

  const cfg = {
    get(key) {
      return GM_getValue(key, defaults[key]);
    },
    set(key, value) {
      GM_setValue(key, value);
    },
    ready() {
      return !!(cfg.get('whisparrUrl') && cfg.get('apiKey') && cfg.get('rootFolderPath') && cfg.get('qualityProfileId'));
    },
  };

  // ------------------------------------------------------------------- http

  function request(url, options) {
    const opts = options || {};
    const method = opts.method || 'GET';
    const body = opts.body || null;

    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: Object.assign(
          { Accept: 'application/json' },
          body ? { 'Content-Type': 'application/json' } : {},
          opts.headers || {}
        ),
        data: body ? JSON.stringify(body) : undefined,
        timeout: 60000,
        onload: function (res) {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error(method + ' ' + url + ' -> ' + res.status + ' ' + String(res.responseText).slice(0, 300)));
            return;
          }
          try {
            resolve(res.responseText ? JSON.parse(res.responseText) : null);
          } catch (err) {
            reject(new Error('bad JSON from ' + url + ': ' + err.message));
          }
        },
        onerror: function () {
          reject(new Error('network error: ' + method + ' ' + url));
        },
        ontimeout: function () {
          reject(new Error('timeout: ' + method + ' ' + url));
        },
      });
    });
  }

  function whisparr(path, options) {
    const opts = options || {};
    const base = cfg.get('whisparrUrl').replace(/\/+$/, '');
    return request(base + '/api/v3' + path, Object.assign({}, opts, {
      headers: Object.assign({ 'X-Api-Key': cfg.get('apiKey') }, opts.headers || {}),
    }));
  }

  const metaCache = new Map();

  function metadata(path) {
    if (!metaCache.has(path)) {
      metaCache.set(path, request(META + path));
    }
    return metaCache.get(path);
  }

  // --------------------------------------------------------- tpdb page model
  // The only part that depends on TPDB's markup. If their DOM changes, these
  // three functions are what break.

  function pageKind() {
    const path = location.pathname;
    if (/^\/scenes\/[^/]+\/?$/.test(path)) return 'scene';
    if (/^\/sites\/[^/]+\/?$/.test(path)) return 'site';
    return 'other';
  }

  function currentSceneSlug() {
    const m = location.pathname.match(/^\/scenes\/([^/]+)/);
    return m ? m[1] : null;
  }

  // Every /sites/ slug linked from the page, best guess first. A scene page
  // links its own site, but it may also carry nav or "related" links, so this
  // returns candidates and the caller confirms by looking for the scene in the
  // site's catalogue.
  function candidateSiteSlugs(sceneSlug) {
    const own = location.pathname.match(/^\/sites\/([^/]+)/);
    if (own) return [own[1]];

    const seen = [];
    document.querySelectorAll('a[href*="/sites/"]').forEach(function (a) {
      const hit = (a.getAttribute('href') || '').match(/\/sites\/([^/?#]+)/);
      if (hit && seen.indexOf(hit[1]) === -1) seen.push(hit[1]);
    });

    // Scene slugs are conventionally "<site-slug>-<scene-title>".
    const prefixes = String(sceneSlug || '').toLowerCase();
    return seen.sort(function (a, b) {
      const aHit = prefixes.indexOf(a.toLowerCase() + '-') === 0 ? 1 : 0;
      const bHit = prefixes.indexOf(b.toLowerCase() + '-') === 0 ? 1 : 0;
      return bHit - aHit;
    });
  }

  // ------------------------------------------------------------- resolution

  async function resolveSiteId(siteSlug) {
    const key = 'siteId:' + siteSlug;
    const cached = GM_getValue(key, null);
    if (cached && Date.now() - cached.at < SITE_CACHE_TTL) return cached.id;

    const results = await metadata('/site/search?q=' + encodeURIComponent(siteSlug.replace(/-/g, ' ')));
    const exact = results.find(function (s) {
      return String(s.Slug || '').toLowerCase() === siteSlug.toLowerCase();
    });
    const hit = exact || results[0];
    if (!hit) throw new Error('no TPDB site matching "' + siteSlug + '"');
    if (!exact) console.warn('[tpdbarr] no exact slug match for "' + siteSlug + '", using "' + hit.Slug + '"');

    GM_setValue(key, { id: hit.ForeignId, at: Date.now() });
    return hit.ForeignId;
  }

  // slug -> {id, guid, title, date} for a whole site. The catalogue response is
  // large, so it is reduced to this map and cached.
  //
  // guid is the TPDB scene UUID, which is also the stash_id Stash stores when a
  // scene has been identified against TPDB's stash-box endpoint.
  async function sceneIndex(siteId) {
    const key = 'sceneIndex:v2:' + siteId;
    const cached = GM_getValue(key, null);
    if (cached && Date.now() - cached.at < SITE_CACHE_TTL) return cached.map;

    const site = await metadata('/site/' + siteId);
    const map = {};
    (site.Episodes || []).forEach(function (e) {
      if (!e.Slug) return;
      map[String(e.Slug).toLowerCase()] = {
        id: e.ForeignId,
        guid: e.ForeignGuid || null,
        title: e.Title || '',
        date: e.ReleaseDate || '',
      };
    });

    GM_setValue(key, { map: map, at: Date.now() });
    return map;
  }

  // Work out which TPDB site this scene belongs to and what its scene id is.
  async function locateScene(sceneSlug) {
    const candidates = candidateSiteSlugs(sceneSlug);
    if (!candidates.length) throw new Error('no site linked from this page — cannot tell Whisparr which site to add');

    const tried = [];
    for (let i = 0; i < candidates.length; i++) {
      const siteSlug = candidates[i];
      try {
        const siteId = await resolveSiteId(siteSlug);
        const index = await sceneIndex(siteId);
        const scene = index[sceneSlug.toLowerCase()];
        if (scene) {
          return {
            siteId: siteId,
            siteSlug: siteSlug,
            tpdbSceneId: scene.id,
            guid: scene.guid,
            title: scene.title,
            date: scene.date,
          };
        }
        tried.push(siteSlug + '(' + siteId + ')');
      } catch (err) {
        tried.push(siteSlug + '(' + err.message + ')');
      }
    }

    throw new Error('scene "' + sceneSlug + '" not found under any linked site: ' + tried.join(', '));
  }

  // -------------------------------------------------------------- stash ops
  // "Do I already have this?" TPDB runs a stash-box endpoint, so any scene you
  // identified against TPDB carries its UUID as a stash_id in Stash. That is an
  // exact match. Failing that, fall back to title + release date, reported as
  // probable rather than certain.

  function stashConfigured() {
    return !!(cfg.get('stashUrl') && cfg.get('stashApiKey'));
  }

  function stashGql(query, variables) {
    const base = cfg.get('stashUrl').replace(/\/+$/, '');
    return request(base + '/graphql', {
      method: 'POST',
      headers: { ApiKey: cfg.get('stashApiKey') },
      body: { query: query, variables: variables || {} },
    }).then(function (res) {
      if (res && res.errors && res.errors.length) {
        throw new Error('stash: ' + res.errors[0].message);
      }
      return res.data;
    });
  }

  const SCENE_FIELDS = 'id title date studio { name } stash_ids { endpoint stash_id } files { path }';

  // Which of the user's configured stash-box endpoints is TPDB?
  let tpdbEndpointPromise = null;

  function tpdbStashBoxEndpoint() {
    if (!tpdbEndpointPromise) {
      tpdbEndpointPromise = stashGql('{ configuration { general { stashBoxes { endpoint name } } } }')
        .then(function (data) {
          const boxes = ((data.configuration || {}).general || {}).stashBoxes || [];
          const hit = boxes.find(function (b) {
            return /theporndb|metadataapi/i.test(b.endpoint || '');
          });
          return hit ? hit.endpoint : null;
        })
        .catch(function (err) {
          console.warn('[tpdbarr] could not read Stash config:', err.message);
          return null;
        });
    }
    return tpdbEndpointPromise;
  }

  async function findInStashByStashId(endpoint, guid) {
    const query =
      'query($f: SceneFilterType) { findScenes(scene_filter: $f, filter: {per_page: 5}) { count scenes { ' +
      SCENE_FIELDS +
      ' } } }';

    // stash_ids_endpoint is the current filter; older Stash only has the
    // singular stash_id_endpoint.
    try {
      const data = await stashGql(query, {
        f: { stash_ids_endpoint: { endpoint: endpoint, stash_ids: [guid], modifier: 'INCLUDES' } },
      });
      return data.findScenes.scenes;
    } catch (err) {
      const data = await stashGql(query, {
        f: { stash_id_endpoint: { endpoint: endpoint, stash_id: guid, modifier: 'EQUALS' } },
      });
      return data.findScenes.scenes;
    }
  }

  async function findInStashByTitleDate(title, date) {
    if (!title || !date) return [];
    const query =
      'query($f: SceneFilterType) { findScenes(scene_filter: $f, filter: {per_page: 5}) { count scenes { ' +
      SCENE_FIELDS +
      ' } } }';
    const data = await stashGql(query, {
      f: {
        title: { value: title, modifier: 'EQUALS' },
        date: { value: date, modifier: 'EQUALS' },
      },
    });
    return data.findScenes.scenes;
  }

  // -> {status: 'exact'|'probable'|'absent'|'off'|'error', scene, note}
  async function stashLookup(located) {
    if (!stashConfigured()) return { status: 'off' };

    try {
      const endpoint = await tpdbStashBoxEndpoint();

      if (endpoint && located.guid) {
        const hits = await findInStashByStashId(endpoint, located.guid);
        if (hits.length) return { status: 'exact', scene: hits[0] };
      }

      const probable = await findInStashByTitleDate(located.title, located.date);
      if (probable.length) {
        return {
          status: 'probable',
          scene: probable[0],
          note: endpoint
            ? 'matched on title + date, not on a TPDB stash id'
            : 'no TPDB stash-box endpoint configured in Stash — matched on title + date',
        };
      }

      return {
        status: 'absent',
        note: endpoint ? '' : 'no TPDB stash-box endpoint configured in Stash',
      };
    } catch (err) {
      console.error('[tpdbarr] stash lookup failed', err);
      return { status: 'error', note: err.message };
    }
  }

  // ----------------------------------------------------------- whisparr ops

  async function findSeries(siteId) {
    const all = await whisparr('/series?tvdbId=' + siteId);
    return Array.isArray(all) && all.length ? all[0] : null;
  }

  async function addSeries(siteId) {
    const lookup = await whisparr('/series/lookup?term=' + encodeURIComponent('tpdb:' + siteId));
    if (!lookup.length) throw new Error('Whisparr could not look up tpdb:' + siteId);

    const series = lookup[0];
    series.qualityProfileId = Number(cfg.get('qualityProfileId'));
    series.rootFolderPath = cfg.get('rootFolderPath');
    series.seriesType = cfg.get('seriesType');
    series.monitored = true;
    series.monitorNewItems = 'none';
    series.addOptions = {
      monitor: 'none',
      searchForMissingEpisodes: false,
      searchForCutoffUnmetEpisodes: false,
    };

    return whisparr('/series', { method: 'POST', body: series });
  }

  async function ensureSeries(siteId) {
    const existing = await findSeries(siteId);
    return existing || addSeries(siteId);
  }

  async function episodesFor(seriesId, retries, waitMs) {
    const attempts = retries || 12;
    const wait = waitMs || 2000;
    for (let i = 0; i < attempts; i++) {
      const eps = await whisparr('/episode?seriesId=' + seriesId);
      if (eps.length) return eps;
      // freshly added site, Whisparr is still pulling metadata
      await new Promise(function (r) { setTimeout(r, wait); });
    }
    return [];
  }

  async function sceneState(sceneSlug) {
    const located = await locateScene(sceneSlug);

    // Whisparr and Stash know nothing about each other; ask both at once.
    const results = await Promise.all([findSeries(located.siteId), stashLookup(located)]);
    const series = results[0];
    const stash = results[1];

    if (!series) return { status: 'absent', located: located, stash: stash };

    const episodes = await whisparr('/episode?seriesId=' + series.id);
    const episode = episodes.find(function (e) { return e.tvdbId === located.tpdbSceneId; });
    if (!episode) return { status: 'absent', located: located, series: series, stash: stash };

    let status = 'absent';
    if (episode.hasFile) status = 'downloaded';
    else if (episode.monitored) status = 'monitored';

    return { status: status, located: located, series: series, episode: episode, stash: stash };
  }

  async function addScene(sceneSlug, onProgress) {
    const progress = onProgress || function () {};

    progress('resolving scene');
    const located = await locateScene(sceneSlug);

    progress('adding site');
    const series = await ensureSeries(located.siteId);

    progress('finding episode');
    const episodes = await episodesFor(series.id);
    const episode = episodes.find(function (e) { return e.tvdbId === located.tpdbSceneId; });
    if (!episode) {
      throw new Error('Whisparr has the site but not scene ' + located.tpdbSceneId + ' yet — refresh the site and retry');
    }

    progress('monitoring');
    await whisparr('/episode/monitor', {
      method: 'PUT',
      body: { episodeIds: [episode.id], monitored: true },
    });

    if (cfg.get('searchOnAdd')) {
      progress('searching');
      await whisparr('/command', {
        method: 'POST',
        body: { name: 'EpisodeSearch', episodeIds: [episode.id] },
      });
    }

    return episode;
  }

  // ---------------------------------------------------------------- the UI

  GM_addStyle([
    '.tpdbarr-btn {',
    '  position: fixed; right: 20px; bottom: 20px; z-index: 99999;',
    '  display: inline-flex; align-items: center; gap: 8px;',
    '  padding: 10px 16px; border: 0; border-radius: 8px;',
    '  font: 600 14px/1.2 system-ui, sans-serif; color: #fff;',
    '  background: #6f42c1; cursor: pointer;',
    '  box-shadow: 0 4px 14px rgba(0,0,0,.35);',
    '}',
    '.tpdbarr-btn:disabled { opacity: .65; cursor: default; }',
    '.tpdbarr-stash {',
    '  position: fixed; right: 20px; bottom: 66px; z-index: 99999;',
    '  padding: 5px 11px; border: 0; border-radius: 999px;',
    '  font: 600 12px/1.2 system-ui, sans-serif; color: #fff;',
    '  background: #495057; cursor: default;',
    '  box-shadow: 0 2px 8px rgba(0,0,0,.3);',
    '}',
    '.tpdbarr-stash[data-state="exact"]    { background: #198754; cursor: pointer; }',
    '.tpdbarr-stash[data-state="probable"] { background: #fd7e14; cursor: pointer; }',
    '.tpdbarr-stash[data-state="error"]    { background: #842029; }',
    '.tpdbarr-btn[data-state="downloaded"] { background: #198754; }',
    '.tpdbarr-btn[data-state="monitored"]  { background: #0d6efd; }',
    '.tpdbarr-btn[data-state="error"]      { background: #dc3545; }',
    '.tpdbarr-btn[data-state="busy"]       { background: #6c757d; }',
    '.tpdbarr-modal {',
    '  position: fixed; inset: 0; z-index: 100000;',
    '  display: flex; align-items: center; justify-content: center;',
    '  background: rgba(0,0,0,.6);',
    '}',
    '.tpdbarr-modal form {',
    '  background: #1f2125; color: #e9ecef; padding: 24px;',
    '  border-radius: 10px; width: min(460px, 92vw);',
    '  font: 14px/1.5 system-ui, sans-serif;',
    '}',
    '.tpdbarr-modal h2 { margin: 0 0 16px; font-size: 18px; }',
    '.tpdbarr-modal label { display: block; margin: 12px 0 4px; font-weight: 600; }',
    '.tpdbarr-modal input[type=text], .tpdbarr-modal input[type=password], .tpdbarr-modal select {',
    '  width: 100%; padding: 7px 9px; border-radius: 6px;',
    '  border: 1px solid #495057; background: #14161a; color: inherit;',
    '}',
    '.tpdbarr-modal .row { display: flex; gap: 10px; margin-top: 20px; }',
    '.tpdbarr-modal button { padding: 8px 14px; border-radius: 6px; border: 0; cursor: pointer; font-weight: 600; }',
    '.tpdbarr-modal .primary { background: #6f42c1; color: #fff; }',
    '.tpdbarr-modal .ghost { background: #343a40; color: #e9ecef; }',
    '.tpdbarr-note { margin-top: 12px; font-size: 12px; color: #adb5bd; min-height: 18px; }',
  ].join('\n'));

  function fillSelect(select, pairs, selected) {
    select.innerHTML = '';
    pairs.forEach(function (pair) {
      const opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      if (String(pair[0]) === String(selected)) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function settingsModal() {
    const wrap = document.createElement('div');
    wrap.className = 'tpdbarr-modal';
    wrap.innerHTML = [
      '<form>',
      '  <h2>tpdbarr settings</h2>',
      '  <label>Whisparr v2 URL</label>',
      '  <input type="text" name="whisparrUrl" placeholder="http://localhost:6969" />',
      '  <label>API key</label>',
      '  <input type="password" name="apiKey" />',
      '  <label>Quality profile</label>',
      '  <select name="qualityProfileId"><option value="">connect first</option></select>',
      '  <label>Root folder</label>',
      '  <select name="rootFolderPath"><option value="">connect first</option></select>',
      '  <label><input type="checkbox" name="searchOnAdd" /> search immediately after adding</label>',
      '  <hr style="margin:18px 0;border:0;border-top:1px solid #343a40" />',
      '  <label>Stash URL <span style="font-weight:400;color:#adb5bd">(optional)</span></label>',
      '  <input type="text" name="stashUrl" placeholder="http://localhost:9999" />',
      '  <label>Stash API key</label>',
      '  <input type="password" name="stashApiKey" />',
      '  <div class="tpdbarr-note"></div>',
      '  <div class="row">',
      '    <button type="button" class="ghost" data-act="test">Connect</button>',
      '    <button type="submit" class="primary">Save</button>',
      '    <button type="button" class="ghost" data-act="close">Cancel</button>',
      '  </div>',
      '</form>',
    ].join('\n');

    const form = wrap.querySelector('form');
    const note = wrap.querySelector('.tpdbarr-note');
    form.whisparrUrl.value = cfg.get('whisparrUrl');
    form.apiKey.value = cfg.get('apiKey');
    form.searchOnAdd.checked = cfg.get('searchOnAdd');
    form.stashUrl.value = cfg.get('stashUrl');
    form.stashApiKey.value = cfg.get('stashApiKey');

    function stage() {
      cfg.set('whisparrUrl', form.whisparrUrl.value.trim());
      cfg.set('apiKey', form.apiKey.value.trim());
      cfg.set('stashUrl', form.stashUrl.value.trim());
      cfg.set('stashApiKey', form.stashApiKey.value.trim());
    }

    async function connect() {
      note.textContent = 'connecting...';
      stage();
      tpdbEndpointPromise = null; // settings may have changed

      const lines = [];

      try {
        const results = await Promise.all([
          whisparr('/qualityprofile'),
          whisparr('/rootfolder'),
          whisparr('/system/status'),
        ]);
        const profiles = results[0];
        const folders = results[1];
        const status = results[2];

        fillSelect(form.qualityProfileId, profiles.map(function (p) { return [p.id, p.name]; }), cfg.get('qualityProfileId'));
        fillSelect(form.rootFolderPath, folders.map(function (f) { return [f.path, f.path]; }), cfg.get('rootFolderPath'));

        const major = parseInt(String(status.version || '0').split('.')[0], 10);
        lines.push(major === 2
          ? 'Whisparr ' + status.version + ' - ok'
          : 'Whisparr ' + status.version + ' - tpdbarr targets v2; use stasharr for v3');
      } catch (err) {
        lines.push('Whisparr: ' + err.message);
      }

      if (stashConfigured()) {
        try {
          const version = await stashGql('{ version { version } }');
          const endpoint = await tpdbStashBoxEndpoint();
          lines.push('Stash ' + ((version.version || {}).version || '?') + ' - ' + (endpoint
            ? 'TPDB stash-box found, exact matching on'
            : 'no TPDB stash-box endpoint, will match on title + date only'));
        } catch (err) {
          lines.push('Stash: ' + err.message);
        }
      }

      note.textContent = lines.join('\n');
      note.style.whiteSpace = 'pre-line';
    }

    form.addEventListener('click', function (e) {
      const act = e.target.dataset.act;
      if (act === 'test') connect();
      if (act === 'close') wrap.remove();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      stage();
      tpdbEndpointPromise = null;
      cfg.set('qualityProfileId', Number(form.qualityProfileId.value));
      cfg.set('rootFolderPath', form.rootFolderPath.value);
      cfg.set('searchOnAdd', form.searchOnAdd.checked);
      wrap.remove();
      painted = null;
      render();
    });

    document.body.appendChild(wrap);
    if (cfg.get('whisparrUrl') && cfg.get('apiKey')) connect();
  }

  GM_registerMenuCommand('tpdbarr settings', settingsModal);

  const LABELS = {
    absent: 'Add to Whisparr',
    monitored: 'Monitored',
    downloaded: 'Downloaded',
    setup: 'Set up tpdbarr',
    error: 'Retry',
  };

  function button() {
    let el = document.querySelector('.tpdbarr-btn');
    if (!el) {
      el = document.createElement('button');
      el.className = 'tpdbarr-btn';
      document.body.appendChild(el);
    }
    return el;
  }

  function paint(state, label, title) {
    const el = button();
    el.dataset.state = state;
    el.textContent = label;
    el.title = title || '';
    el.disabled = state === 'busy' || state === 'downloaded' || state === 'monitored';
    return el;
  }

  const STASH_LABELS = {
    exact: 'In Stash',
    probable: 'Probably in Stash',
    absent: 'Not in Stash',
    error: 'Stash unreachable',
  };

  function paintStash(result) {
    let el = document.querySelector('.tpdbarr-stash');

    if (!result || result.status === 'off') {
      if (el) el.remove();
      return;
    }

    if (!el) {
      el = document.createElement('button');
      el.className = 'tpdbarr-stash';
      document.body.appendChild(el);
    }

    el.dataset.state = result.status;
    el.textContent = STASH_LABELS[result.status] || result.status;

    const scene = result.scene;
    const bits = [];
    if (scene) {
      bits.push(scene.title || '(untitled)');
      if (scene.date) bits.push(scene.date);
      if (scene.files && scene.files.length) bits.push(scene.files[0].path);
    }
    if (result.note) bits.push(result.note);
    el.title = bits.join('\n');

    el.onclick = scene
      ? function () {
          window.open(cfg.get('stashUrl').replace(/\/+$/, '') + '/scenes/' + scene.id, '_blank');
        }
      : null;
  }

  function clearChrome() {
    ['.tpdbarr-btn', '.tpdbarr-stash'].forEach(function (sel) {
      const el = document.querySelector(sel);
      if (el) el.remove();
    });
  }

  let painted = null;

  async function render() {
    if (pageKind() !== 'scene') {
      clearChrome();
      painted = null;
      return;
    }

    const slug = currentSceneSlug();
    if (painted === slug) return;
    painted = slug;

    if (!cfg.ready()) {
      paint('setup', LABELS.setup, 'click to configure Whisparr v2').onclick = settingsModal;
      return;
    }

    paint('busy', 'Checking...').onclick = null;

    function failed(err) {
      console.error('[tpdbarr]', err);
      paint('error', LABELS.error, err.message).onclick = function () {
        painted = null;
        render();
      };
    }

    try {
      const state = await sceneState(slug);
      paintStash(state.stash);
      const el = paint(state.status, LABELS[state.status]);
      if (state.status === 'absent') {
        el.onclick = async function () {
          paint('busy', 'Working...');
          try {
            await addScene(slug, function (step) { paint('busy', step + '...'); });
            paint('monitored', cfg.get('searchOnAdd') ? 'Searching' : 'Monitored');
          } catch (err) {
            failed(err);
          }
        };
      }
    } catch (err) {
      failed(err);
    }
  }

  // TPDB swaps content without a full reload in places, so watch the URL.
  let lastPath = location.pathname;
  new MutationObserver(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      painted = null;
      render();
    }
  }).observe(document.body, { childList: true, subtree: true });

  render();
})();
