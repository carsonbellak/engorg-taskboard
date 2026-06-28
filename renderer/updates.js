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
    const headline = (res.versionBehind && res.latestVersion)
      ? `<b>v${esc(res.latestVersion)}</b> is available${res.currentVersion ? ` — you're on v${esc(res.currentVersion)}` : ''}.`
      : res.isGitRepo && res.behindBy
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
      // Pull just the changed files in-app (themed, no installer). The full
      // installer remains available as a fallback on the result screen.
      actions.push({ label: 'Update now', primary: true, onClick: (ov, box) => applyFilePull(ov, box, res) });
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

  // Register the shared progress listener once (used by both the file-pull and the
  // installer download — they emit on the same channel).
  let progressBound = false;
  function bindProgress() {
    if (progressBound) return;
    progressBound = true;
    window.api.updates.onProgress(({ pct }) => {
      const bar = document.getElementById('update-progress-bar');
      const pctEl = document.getElementById('update-progress-pct');
      if (bar) bar.style.width = (pct || 0) + '%';
      if (pctEl) pctEl.textContent = (pct != null ? pct : 0) + '%';
    });
  }

  const progressHtml = (label) => `<p>${label}</p>
    <div class="update-progress"><div class="update-progress-bar" id="update-progress-bar"></div></div>
    <div class="update-progress-pct" id="update-progress-pct">0%</div>`;

  // Packaged-build update via file pull: download just the changed files from the
  // repo, in-app, and write them in place — no installer, stays fully themed.
  async function applyFilePull(ov, box, res) {
    const body = box.querySelector('.update-modal-body');
    const actions = box.querySelector('.modal-actions');
    const skipLink = box.querySelector('.update-skip-link');
    if (skipLink) skipLink.remove();
    body.innerHTML = progressHtml('Downloading the latest changes…');
    actions.innerHTML = '';
    bindProgress();

    const r = await window.api.updates.pull();
    if (r && r.ok) {
      if (r.count === 0) {
        body.innerHTML = `<p>You're already up to date.</p>`;
        addActions(actions, [{ label: 'Close', primary: true, onClick: () => closeModal(ov) }]);
        return;
      }
      const depsNote = r.depsChanged
        ? `<p class="update-deps-note">This update touched dependencies. If anything misbehaves after restart, use <b>Full reinstall</b>.</p>`
        : '';
      body.innerHTML = `<p>Updated <b>${r.count}</b> file${r.count === 1 ? '' : 's'}. Restart to load the new version.</p>${depsNote}`;
      addActions(actions, [
        { label: 'Later', onClick: () => closeModal(ov) },
        { label: 'Restart now', primary: true, onClick: () => window.api.updates.restart() },
      ]);
    } else {
      const msg = (r && r.error) || 'The update could not be downloaded.';
      body.innerHTML = `<p>Couldn't pull the update automatically:</p><pre class="update-output update-error">${esc(msg)}</pre>
        <p>You can try a full reinstall instead.</p>`;
      addActions(actions, [
        { label: 'Close', onClick: () => closeModal(ov) },
        { label: 'Full reinstall', primary: true, onClick: () => downloadAndInstall(ov, box, res) },
      ]);
    }
  }

  // Packaged-build update: download the latest installer in-app (with a progress
  // bar) and run it — fallback when a file pull isn't enough (e.g. dependency changes).
  async function downloadAndInstall(ov, box, res) {
    const body = box.querySelector('.update-modal-body');
    const actions = box.querySelector('.modal-actions');
    const skipLink = box.querySelector('.update-skip-link');
    if (skipLink) skipLink.remove();
    body.innerHTML = progressHtml('Downloading the latest version…');
    actions.innerHTML = '';
    bindProgress();

    const latest = res.latest || {};
    const r = await window.api.updates.download();
    if (r && r.ok) {
      body.innerHTML = `<p>Download complete. The app will close so the installer can apply the update, then reopen.</p>`;
      addActions(actions, [
        { label: 'Later', onClick: () => closeModal(ov) },
        { label: 'Install & restart', primary: true, onClick: () => {
          // Advance the baseline so the freshly installed build doesn't re-prompt.
          if (latest.sha) window.api.updates.skip(latest.sha);
          window.api.updates.runInstaller(r.path);
        } },
      ]);
    } else {
      const msg = (r && r.error) || 'The download failed.';
      body.innerHTML = `<p>Couldn't download the update:</p><pre class="update-output update-error">${esc(msg)}</pre>`;
      addActions(actions, [
        { label: 'Close', onClick: () => closeModal(ov) },
        { label: 'Retry', primary: true, onClick: () => downloadAndInstall(ov, box, res) },
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
