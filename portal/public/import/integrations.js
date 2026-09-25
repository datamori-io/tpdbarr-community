/* Is everything up, and what is in flight. */

import { api, el } from '../util.js';
import { SECTION_OF, paint, painterFor, show } from './core.js';

/*
 * =========================================================== integrations
 *
 * Is everything up, and what's in flight (formerly the Queue tab).
 */

export let integrationsTimer = null;

export async function showIntegrations() {
  const paint = painterFor();
  clearTimeout(integrationsTimer);

  show(paint, SECTION_OF.integrations, el('div', { className: 'empty' }, 'Asking everything…'));

  try {
    renderIntegrations(paint, await api('/api/import/integrations'));
    integrationsTimer = setTimeout(showIntegrations, 20000);
  } catch (err) {
    show(paint, SECTION_OF.integrations, el('div', { className: 'empty' }, err.message));
  }
}

function renderIntegrations(paint, { services, pipeline, moving, encoderQueue }) {
  show(paint, SECTION_OF.integrations,
    el('section', { className: 'feed' },
      el('div', { className: 'feedhead' },
        el('h2', {}, 'Connected'),
        el('span', { className: 'muted' },
          'tokens for StashDB and ThePornDB are borrowed from Stash, never stored here')
      ),
      el('div', { className: 'services' }, services.map(serviceRow))
    ),
    backupBand(),
    el('section', { className: 'feed' },
      el('div', { className: 'feedhead' },
        el('h2', {}, 'In flight'),
        el('span', { className: 'muted' },
          [
            moving
              ? `${moving.toLocaleString()} scenes somewhere between grabbed and filed, counted in Stash`
              : 'nothing moving in Stash — everything that arrived has been filed',
            // Its own figure, not added in: the encoder counts files, Stash
            // counts scenes, and they are largely the same things seen twice.
            encoderQueue ? `${encoderQueue.toLocaleString()} files in the encoder's queue` : null,
          ].filter(Boolean).join(' · '))
      ),
      el('div', { className: 'tracked' }, pipeline.map(pipelineRow))
    )
  );
}

/*
 * Backups of what can't be recomputed: want list, ignore list, tracked
 * catalogues. No clips or reel cache.
 */
function backupBand() {
  const body = el('div', {}, el('div', { className: 'empty small' }, 'Reading…'));

  const now = el('button', { className: 'add', type: 'button' }, 'Back up now');
  now.onclick = async () => {
    now.disabled = true;
    now.textContent = 'Copying…';
    try {
      await api('/api/import/backups', { method: 'POST' });
      await fill();
      now.textContent = 'Done';
      setTimeout(() => { now.disabled = false; now.textContent = 'Back up now'; }, 1500);
    } catch (err) {
      now.disabled = false;
      now.textContent = 'Back up now';
      alert(err.message);
    }
  };

  const note = el('span', { className: 'muted' }, '');

  const fill = async () => {
    try {
      const { onDisk, backups } = await api('/api/import/backups');
      const newest = backups?.[0] || null;

      note.textContent = onDisk.length
        ? `${onDisk.length} kept, newest ${onDisk[0].name.replace('T', ' at ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')}`
        : 'none yet';

      if (!onDisk.length) {
        body.replaceChildren(el('div', { className: 'empty small' },
          'No copies yet. One is taken when the portal starts and when anything changes.'));
        return;
      }

      body.replaceChildren(el('div', { className: 'tracked' }, onDisk.slice(0, 6).map((set) =>
        el('div', { className: 'crow prow' },
          el('div', { className: 'fignum' }, Math.round(set.bytes / 1024) + 'K'),
          el('div', {},
            el('div', { className: 'title' }, set.name.replace('T', ' at ')),
            el('div', { className: 'meta' },
              el('span', {}, `${set.files} files`),
              // Only the newest is known to have reached the NAS: the rest were
              // taken before this page was open and nothing here re-checks them.
              newest && newest.name === set.name
                ? el('span', {}, newest.nas ? 'on the NAS too' : `NAS: ${newest.nasError}`)
                : null)
          ),
          el('span', {}))
      )));
    } catch (err) {
      body.replaceChildren(el('div', { className: 'empty small' }, err.message));
    }
  };

  fill();

  return el('section', { className: 'feed' },
    el('div', { className: 'feedhead' },
      el('h2', {}, 'Backups'),
      note,
      el('span', { className: 'spacer' }),
      now
    ),
    body
  );
}

function serviceRow(service) {
  const light = service.ok ? 'good' : service.configured ? 'bad' : 'off';

  return el('div', { className: 'srow' },
    el('span', { className: 'lamp ' + light }),
    el('div', {},
      el('div', { className: 'title' }, service.name),
      el('div', { className: 'meta' },
        el('span', {}, service.error || service.note || (service.ok ? 'up' : 'no answer')),
        service.role ? el('span', {}, service.role) : null
      )
    )
  );
}

function pipelineRow(step) {
  const count = step.error ? '—' : step.count == null ? '?' : step.count.toLocaleString();

  const body = el('div', {},
    el('div', { className: 'title' }, step.label),
    el('div', { className: 'meta' }, el('span', {}, step.error || step.note))
  );

  for (const item of step.items || []) {
    body.append(el('div', { className: 'meta' + (item.stalled ? ' stalled' : '') },
      el('span', {}, item.title),
      item.detail ? el('span', {}, item.detail) : null));
  }

  return el('div', { className: 'crow prow' + (step.done ? ' done' : '') },
    el('div', { className: 'fignum' }, count),
    body,
    step.href ? el('a', { className: 'chip', href: step.href }, 'Open') : el('span', {})
  );
}
