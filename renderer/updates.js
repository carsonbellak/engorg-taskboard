// Startup update checker — asks the main process whether the canonical repo has
// newer commits than this install, and if so prompts the user to update.
//
// Detection + git pull live in ipc/updates.js. This module only owns the prompt
// UI. It runs once per launch from app.js (non-blocking) and stays silent on
// errors, when up to date, or when the user has skipped the current version.

const updateChecker = (() => {
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

  function closeModal(ov) { ov.remove(); }

  // Build the shared overlay/box shell; `bodyHtml` is trusted (already escaped).
  function buildModal({ title, bodyHtml, actions }) {
    const ov = document.createElement('div');
    ov.className = 'modal update-modal';
    const box = document.createElement('div');
    box.className = 'modal-box modal-sm';
    box.innerHTML = `<h2>${esc(title)}</h2><div class="update-modal-body">${bodyHtml}</div>`;
    const row = document.createElement('div');
    row.className = 'modal-actions';
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.className = a.primary ? 'btn-modal-primary' : 'btn-modal-cancel';
      btn.textContent = a.label;
      btn.addEventListener('click', () => a.onClick(ov, box));
      row.appendChild(btn);
    });
    box.appendChild(row);
    ov.appendChild(box);
    // Clicking the dim backdrop dismisses (same as "Later").
    ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(ov); });
    document.body.appendChild(ov);
    return { ov, box };
  }

  function commitList(res) {
    if (!res.commits || !res.commits.length) return '';
    const items = res.commits.map((c) => `<li><code>${esc(c.shortSha)}</code> ${esc(c.message)}</li>`).join('');
    return `<ul class="update-commit-list">${items}</ul>`;
  }

  function showAvailable(res) {
    const latest = res.latest || {};
    const headline = res.isGitRepo && res.behindBy
      ? `You're <b>${res.behindBy}</b> commit${res.behindBy === 1 ? '' : 's'} behind the latest version.`
      : `A newer version of the app is available.`;
    const latestLine = latest.shortSha
      ? `<div class="update-latest">Latest: <code>${esc(latest.shortSha)}</code> — ${esc(latest.message || '')}</div>`
      : '';
    const bodyHtml = `<p>${headline}</p>${latestLine}${commitList(res)}`;

    const actions = [];
    actions.push({ label: 'Later', onClick: (ov) => closeModal(ov) });

    if (res.isGitRepo) {
      actions.push({ label: 'Update now', primary: true, onClick: (ov, box) => applyGitUpdate(ov, box, res) });
    } else {
      actions.push({ label: 'Open repo', primary: true, onClick: async (ov) => {
        await window.api.updates.openRepo();
        if (latest.sha) window.api.updates.skip(latest.sha); // assume they'll update; stop nagging
        closeModal(ov);
      } });
    }

    const { box } = buildModal({ title: 'Update available', bodyHtml, actions });

    // Secondary "skip this version" link so the prompt can be silenced per-version.
    if (latest.sha) {
      const skip = document.createElement('button');
      skip.className = 'update-skip-link';
      skip.textContent = 'Skip this version';
      skip.addEventListener('click', () => { window.api.updates.skip(latest.sha); box.closest('.modal').remove(); });
      box.querySelector('.modal-actions').insertAdjacentElement('beforebegin', skip);
    }
  }

  async function applyGitUpdate(ov, box, res) {
    const body = box.querySelector('.update-modal-body');
    const actions = box.querySelector('.modal-actions');
    body.innerHTML = '<p>Pulling the latest changes…</p>';
    actions.innerHTML = '';
    const skipLink = box.querySelector('.update-skip-link');
    if (skipLink) skipLink.remove();

    const r = await window.api.updates.apply();
    if (r && r.ok) {
      body.innerHTML = `<p>Update complete. Restart the app to load the new version.</p>${r.output ? `<pre class="update-output">${esc(r.output)}</pre>` : ''}`;
      addActions(actions, [
        { label: 'Later', onClick: () => closeModal(ov) },
        { label: 'Restart now', primary: true, onClick: () => window.api.updates.restart() },
      ]);
    } else {
      const msg = (r && r.error) || 'The update could not be applied automatically.';
      body.innerHTML = `<p>Couldn't update automatically:</p><pre class="update-output update-error">${esc(msg)}</pre>
        <p>You can pull manually, or open the repository to update.</p>`;
      addActions(actions, [
        { label: 'Close', onClick: () => closeModal(ov) },
        { label: 'Open repo', primary: true, onClick: async () => { await window.api.updates.openRepo(); closeModal(ov); } },
      ]);
    }
  }

  function addActions(row, actions) {
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.className = a.primary ? 'btn-modal-primary' : 'btn-modal-cancel';
      btn.textContent = a.label;
      btn.addEventListener('click', () => a.onClick());
      row.appendChild(btn);
    });
  }

  async function run() {
    try {
      if (!window.api || !window.api.updates) return;
      const res = await window.api.updates.check();
      if (!res || res.error || !res.updatesAvailable || res.skipped) {
        if (res && res.error) console.warn('[Updates] check failed:', res.error);
        return;
      }
      showAvailable(res);
    } catch (e) {
      console.warn('[Updates] check error:', e.message);
    }
  }

  return { run };
})();
