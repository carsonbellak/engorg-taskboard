// Git Manager utility — a GitHub-Desktop-style front end for git, driven by
// buttons/dropdowns (no CLI required) with an optional raw git terminal at the
// bottom. Backed by window.api.git.* (see ipc/git.js). Desktop-only (no PWA).
//
// Tracked repos live in settings.json (`gitRepos`, `gitLastRepo`) so the chosen
// repos sync across machines for free, like every other settings-backed list.

const gitManager = (() => {
  let mounted = false;
  let repo = null;          // { path, name } currently selected
  let status = null;        // last git:status result
  let branches = null;      // last git:branches result
  let selectedFile = null;  // repo-relative path shown in the diff pane
  let view = 'changes';     // 'changes' | 'history'
  let cliOpen = false;
  let busy = false;
  let commitDraft = { summary: '', desc: '' }; // survives re-renders from staging toggles
  let amend = false;        // amend-last-commit toggle in the commit box
  let mergeState = null;    // 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
  let active = false;       // utility is the visible pane (gates auto-fetch)
  let autoFetchTimer = null;

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  const baseName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

  // ---- settings-backed repo list -----------------------------------------
  function getRepos() { const l = dataManager.settings.gitRepos; return Array.isArray(l) ? l : []; }
  async function saveRepos(list, last) {
    const patch = { gitRepos: list };
    if (last !== undefined) patch.gitLastRepo = last;
    await dataManager.updateSettings(patch);
  }
  async function addRepo(p) {
    if (!p) return;
    const list = getRepos();
    if (!list.some(r => r.path === p)) list.push({ path: p, name: baseName(p) });
    await saveRepos(list, p);
    repo = list.find(r => r.path === p);
    await refreshAll();
  }
  async function removeRepo(p) {
    const list = getRepos().filter(r => r.path !== p);
    const last = list[0] ? list[0].path : null;
    await saveRepos(list, last);
    if (repo && repo.path === p) { repo = list[0] || null; await refreshAll(); }
    else renderRepoBar();
  }

  // ---- small UI helpers ---------------------------------------------------
  let statusTimer = null;
  function setStatus(msg, kind = '') {
    const el = document.getElementById('gm-statusline');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'gm-statusline' + (kind ? ' gm-' + kind : '');
    if (statusTimer) clearTimeout(statusTimer);
    if (msg && kind === 'ok') statusTimer = setTimeout(() => { el.textContent = ''; el.className = 'gm-statusline'; }, 4000);
  }

  // Run a git op with a busy guard + status feedback, then refresh.
  async function run(label, fn, { refresh = true } = {}) {
    if (busy) return;
    busy = true; setStatus(label + '…', 'busy'); renderToolbar();
    try {
      const out = await fn();
      const text = typeof out === 'string' ? out : (out && out.output);
      if (text && text.trim()) appendCli(`# ${label}\n${text.trim()}`);
      busy = false;
      if (refresh) await refreshAll(); else renderToolbar();
      setStatus(label + ' ✓', 'ok'); // set after refresh re-renders the statusline
      return out;
    } catch (e) {
      busy = false;
      if (refresh) await refreshAll().catch(() => {}); else renderToolbar();
      setStatus(label + ' failed: ' + (e.message || e), 'err');
      appendCli(`# ${label} — ERROR\n${e.message || e}`);
    } finally { busy = false; }
  }

  // Inline prompt overlay (Electron's window.prompt is a no-op — see CLAUDE.md).
  function gmPrompt({ title, fields, okText = 'OK' }) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'gm-modal-overlay';
      ov.innerHTML = `
        <div class="gm-modal">
          <h3>${esc(title)}</h3>
          ${fields.map((f, i) => `
            <label class="gm-field-label">${esc(f.label)}</label>
            ${f.type === 'textarea'
              ? `<textarea class="gm-input" data-k="${f.key}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
              : `<input class="gm-input" data-k="${f.key}" type="text" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}" ${i === 0 ? 'autofocus' : ''}>`}`).join('')}
          <div class="gm-modal-actions">
            <button class="gm-btn gm-btn-ghost" data-act="cancel">Cancel</button>
            <button class="gm-btn gm-btn-primary" data-act="ok">${esc(okText)}</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const collect = () => { const o = {}; ov.querySelectorAll('.gm-input').forEach(i => o[i.dataset.k] = i.value.trim()); return o; };
      const close = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('[data-act="cancel"]').onclick = () => close(null);
      ov.querySelector('[data-act="ok"]').onclick = () => close(collect());
      ov.addEventListener('click', e => { if (e.target === ov) close(null); });
      ov.addEventListener('keydown', e => {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') close(collect());
      });
      setTimeout(() => { const f = ov.querySelector('.gm-input'); if (f) f.focus(); }, 30);
    });
  }
  const confirm = (opts) => (window._showConfirm ? window._showConfirm(opts) : Promise.resolve(window.confirm(opts.message)));

  // Generic modal shell (returns the box element + close()). Used by the
  // folder upload/download dialogs, which re-render their own body on mode switch.
  function dialog() {
    const ov = document.createElement('div');
    ov.className = 'gm-modal-overlay';
    ov.innerHTML = '<div class="gm-modal gm-modal-wide"></div>';
    document.body.appendChild(ov);
    const box = ov.querySelector('.gm-modal');
    const close = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    return { ov, box, close };
  }

  // ---- Upload a folder ----------------------------------------------------
  function openUpload() {
    let mode = repo ? 'add' : 'publish';   // 'add' = into current repo, 'publish' = new repo
    let src = null;
    const { box, close } = dialog();
    function render() {
      box.innerHTML = `
        <h3>⬆️ Upload folder</h3>
        <div class="gm-seg">
          <button class="gm-seg-btn${mode === 'add' ? ' active' : ''}" data-m="add" ${repo ? '' : 'disabled'}>Into current repo${repo ? ' (' + esc(repo.name) + ')' : ''}</button>
          <button class="gm-seg-btn${mode === 'publish' ? ' active' : ''}" data-m="publish">Publish as new repo</button>
        </div>
        <label class="gm-field-label">Folder to upload</label>
        <div class="gm-pickrow"><button class="gm-btn" data-pick="src">Choose folder…</button><span class="gm-pickpath" id="gm-up-src">${src ? esc(src) : 'No folder selected'}</span></div>
        ${mode === 'add' ? `
          <label class="gm-field-label">Name inside repo (optional)</label>
          <input class="gm-input" id="gm-up-name" placeholder="defaults to the folder's name">
          <label class="gm-field-label">Commit message</label>
          <input class="gm-input" id="gm-up-msg" placeholder="Add <folder>">
          <label class="gm-check"><input type="checkbox" id="gm-up-push" checked> Push to remote after committing</label>
        ` : `
          <label class="gm-field-label">Remote URL</label>
          <input class="gm-input" id="gm-up-url" placeholder="https://github.com/user/repo.git">
          <label class="gm-field-label">Branch</label>
          <input class="gm-input" id="gm-up-branch" value="main">
          <label class="gm-field-label">Commit message</label>
          <input class="gm-input" id="gm-up-msg" placeholder="Initial commit">
        `}
        <div class="gm-modal-err" id="gm-up-err"></div>
        <div class="gm-modal-actions">
          <button class="gm-btn gm-btn-ghost" data-act="cancel">Cancel</button>
          <button class="gm-btn gm-btn-primary" data-act="go">Upload</button>
        </div>`;
      box.querySelectorAll('.gm-seg-btn').forEach(b => b.addEventListener('click', () => { if (!b.disabled) { mode = b.dataset.m; render(); } }));
      box.querySelector('[data-pick="src"]').addEventListener('click', async () => {
        const p = await window.api.files.selectFolder();
        if (p) { src = p; box.querySelector('#gm-up-src').textContent = p; }
      });
      box.querySelector('[data-act="cancel"]').addEventListener('click', close);
      box.querySelector('[data-act="go"]').addEventListener('click', submit);
    }
    async function submit() {
      const err = (m) => { box.querySelector('#gm-up-err').textContent = m; };
      if (!src) return err('Choose a folder to upload.');
      if (mode === 'add') {
        const name = box.querySelector('#gm-up-name').value.trim();
        const message = box.querySelector('#gm-up-msg').value.trim();
        const push = box.querySelector('#gm-up-push').checked;
        close();
        await run('Upload folder', () => window.api.git.uploadFolder(repo.path, src, { subfolder: name || undefined, commitMessage: message || undefined, push }));
      } else {
        const url = box.querySelector('#gm-up-url').value.trim();
        if (!url) return err('Enter a remote URL.');
        const branch = box.querySelector('#gm-up-branch').value.trim() || 'main';
        const message = box.querySelector('#gm-up-msg').value.trim();
        close();
        const res = await run('Publish folder', () => window.api.git.publishFolder(src, url, { branch, commitMessage: message || undefined }), { refresh: false });
        if (res && res.path) await addRepo(res.path); // track + show the new repo
      }
    }
    render();
  }

  // ---- Download a folder --------------------------------------------------
  function openDownload() {
    let mode = repo ? 'extract' : 'remote'; // 'extract' = from current repo, 'remote' = sparse from URL
    let srcFolder = null, dest = null;
    const { box, close } = dialog();
    function render() {
      box.innerHTML = `
        <h3>⬇️ Download folder</h3>
        <div class="gm-seg">
          <button class="gm-seg-btn${mode === 'extract' ? ' active' : ''}" data-m="extract" ${repo ? '' : 'disabled'}>From current repo${repo ? ' (' + esc(repo.name) + ')' : ''}</button>
          <button class="gm-seg-btn${mode === 'remote' ? ' active' : ''}" data-m="remote">From a remote URL</button>
        </div>
        ${mode === 'extract' ? `
          <label class="gm-field-label">Folder to download (inside the repo)</label>
          <div class="gm-pickrow"><button class="gm-btn" data-pick="src">Choose folder…</button><span class="gm-pickpath" id="gm-dl-src">${srcFolder ? esc(srcFolder) : 'No folder selected'}</span></div>
        ` : `
          <label class="gm-field-label">Remote URL</label>
          <input class="gm-input" id="gm-dl-url" placeholder="https://github.com/user/repo.git">
          <label class="gm-field-label">Subfolder path in repo</label>
          <input class="gm-input" id="gm-dl-sub" placeholder="e.g. src/components">
          <label class="gm-field-label">Branch (optional)</label>
          <input class="gm-input" id="gm-dl-branch" placeholder="default branch">
        `}
        <label class="gm-field-label">Save into</label>
        <div class="gm-pickrow"><button class="gm-btn" data-pick="dest">Choose destination…</button><span class="gm-pickpath" id="gm-dl-dest">${dest ? esc(dest) : 'No destination selected'}</span></div>
        <div class="gm-modal-err" id="gm-dl-err"></div>
        <div class="gm-modal-actions">
          <button class="gm-btn gm-btn-ghost" data-act="cancel">Cancel</button>
          <button class="gm-btn gm-btn-primary" data-act="go">Download</button>
        </div>`;
      box.querySelectorAll('.gm-seg-btn').forEach(b => b.addEventListener('click', () => { if (!b.disabled) { mode = b.dataset.m; render(); } }));
      const pick = box.querySelector('[data-pick="src"]');
      if (pick) pick.addEventListener('click', async () => { const p = await window.api.files.selectFolder(); if (p) { srcFolder = p; box.querySelector('#gm-dl-src').textContent = p; } });
      box.querySelector('[data-pick="dest"]').addEventListener('click', async () => { const p = await window.api.files.selectFolder(); if (p) { dest = p; box.querySelector('#gm-dl-dest').textContent = p; } });
      box.querySelector('[data-act="cancel"]').addEventListener('click', close);
      box.querySelector('[data-act="go"]').addEventListener('click', submit);
    }
    async function submit() {
      const err = (m) => { box.querySelector('#gm-dl-err').textContent = m; };
      if (!dest) return err('Choose a destination folder.');
      if (mode === 'extract') {
        if (!srcFolder) return err('Choose the folder to download.');
        close();
        const res = await run('Download folder', () => window.api.git.extractFolder(srcFolder, dest), { refresh: false });
        if (res && res.dest) setStatus('Saved to ' + res.dest, 'ok');
      } else {
        const url = box.querySelector('#gm-dl-url').value.trim();
        const sub = box.querySelector('#gm-dl-sub').value.trim();
        const branch = box.querySelector('#gm-dl-branch').value.trim();
        if (!url) return err('Enter a remote URL.');
        if (!sub) return err('Enter the subfolder path to download.');
        close();
        const res = await run('Download folder', () => window.api.git.sparseDownload(url, sub, dest, { branch: branch || undefined }), { refresh: false });
        if (res && res.dest) setStatus('Saved to ' + res.dest, 'ok');
      }
    }
    render();
  }

  // ---- context menu -------------------------------------------------------
  function showContextMenu(x, y, items) {
    document.querySelectorAll('.gm-ctxmenu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'gm-ctxmenu';
    menu.innerHTML = items.map((it, i) => it.sep
      ? '<div class="gm-ctx-sep"></div>'
      : `<div class="gm-ctx-item${it.danger ? ' gm-danger' : ''}" data-i="${i}">${esc(it.label)}</div>`).join('');
    document.body.appendChild(menu);
    // Keep the menu on-screen.
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    menu.querySelectorAll('.gm-ctx-item').forEach(el => el.addEventListener('click', () => { close(); items[+el.dataset.i].onClick(); }));
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // ---- stash manager ------------------------------------------------------
  async function openStashManager() {
    const { box, close } = dialog();
    async function render() {
      box.innerHTML = '<h3>🗂 Stashes</h3><div class="gm-list" id="gm-stash-list">Loading…</div><div class="gm-modal-actions"><button class="gm-btn gm-btn-ghost" data-act="close">Close</button></div>';
      box.querySelector('[data-act="close"]').addEventListener('click', close);
      const res = await window.api.git.stashList(repo.path);
      const list = box.querySelector('#gm-stash-list');
      const stashes = (res && res.stashes) || [];
      if (!stashes.length) { list.innerHTML = '<div class="gm-diff-empty">No stashes.</div>'; return; }
      list.innerHTML = stashes.map(s => `
        <div class="gm-list-row">
          <span class="gm-list-name" title="${esc(s.ref)}">${esc(s.subject)}</span>
          <span class="gm-list-actions">
            <button class="gm-mini" data-pop="${esc(s.ref)}">Pop</button>
            <button class="gm-mini" data-apply="${esc(s.ref)}">Apply</button>
            <button class="gm-mini gm-danger" data-drop="${esc(s.ref)}">Drop</button>
          </span>
        </div>`).join('');
      list.querySelectorAll('[data-pop]').forEach(b => b.addEventListener('click', async () => { await run('Pop ' + b.dataset.pop, () => window.api.git.stashApply(repo.path, b.dataset.pop, true)); render(); }));
      list.querySelectorAll('[data-apply]').forEach(b => b.addEventListener('click', async () => { await run('Apply ' + b.dataset.apply, () => window.api.git.stashApply(repo.path, b.dataset.apply, false)); render(); }));
      list.querySelectorAll('[data-drop]').forEach(b => b.addEventListener('click', async () => { await run('Drop ' + b.dataset.drop, () => window.api.git.stashDrop(repo.path, b.dataset.drop)); render(); }));
    }
    render();
  }

  // ---- tag manager --------------------------------------------------------
  async function openTagManager() {
    const { box, close } = dialog();
    async function render() {
      box.innerHTML = `
        <h3>🏷 Tags</h3>
        <div class="gm-pickrow gm-tagnew">
          <input class="gm-input" id="gm-tag-name" placeholder="New tag (e.g. v1.0.0) — created at HEAD">
          <button class="gm-btn gm-btn-primary" data-act="create">Create</button>
        </div>
        <div class="gm-list" id="gm-tag-list">Loading…</div>
        <div class="gm-modal-actions"><button class="gm-btn gm-btn-ghost" data-act="close">Close</button></div>`;
      box.querySelector('[data-act="close"]').addEventListener('click', close);
      box.querySelector('[data-act="create"]').addEventListener('click', async () => {
        const name = box.querySelector('#gm-tag-name').value.trim();
        if (name) { await run('Create tag ' + name, () => window.api.git.tagAt(repo.path, name, null, undefined)); render(); }
      });
      const res = await window.api.git.tags(repo.path);
      const list = box.querySelector('#gm-tag-list');
      const tags = (res && res.tags) || [];
      if (!tags.length) { list.innerHTML = '<div class="gm-diff-empty">No tags.</div>'; return; }
      list.innerHTML = tags.map(t => `
        <div class="gm-list-row">
          <span class="gm-list-name" title="${esc(t.subject)}">${esc(t.name)}</span>
          <span class="gm-list-actions">
            <button class="gm-mini" data-push="${esc(t.name)}">Push</button>
            <button class="gm-mini gm-danger" data-deltag="${esc(t.name)}">Delete</button>
          </span>
        </div>`).join('');
      list.querySelectorAll('[data-push]').forEach(b => b.addEventListener('click', () => run('Push tag ' + b.dataset.push, () => window.api.git.pushTag(repo.path, b.dataset.push), { refresh: false })));
      list.querySelectorAll('[data-deltag]').forEach(b => b.addEventListener('click', async () => { await run('Delete tag ' + b.dataset.deltag, () => window.api.git.deleteTag(repo.path, b.dataset.deltag), { refresh: false }); render(); }));
    }
    render();
  }

  // ---- remote manager -----------------------------------------------------
  async function openRemoteManager() {
    const { box, close } = dialog();
    async function render() {
      box.innerHTML = `
        <h3>🌐 Remotes</h3>
        <div class="gm-list" id="gm-remote-list">Loading…</div>
        <label class="gm-field-label">Add remote</label>
        <div class="gm-pickrow"><input class="gm-input" id="gm-rm-name" placeholder="name (e.g. origin)" style="max-width:140px"><input class="gm-input" id="gm-rm-url" placeholder="https://github.com/user/repo.git"><button class="gm-btn gm-btn-primary" data-act="add">Add</button></div>
        <div class="gm-modal-actions"><button class="gm-btn gm-btn-ghost" data-act="close">Close</button></div>`;
      box.querySelector('[data-act="close"]').addEventListener('click', close);
      box.querySelector('[data-act="add"]').addEventListener('click', async () => {
        const name = box.querySelector('#gm-rm-name').value.trim();
        const url = box.querySelector('#gm-rm-url').value.trim();
        if (name && url) { await run('Add remote ' + name, () => window.api.git.addRemote(repo.path, name, url), { refresh: false }); render(); }
      });
      const res = await window.api.git.remotes(repo.path);
      const list = box.querySelector('#gm-remote-list');
      const remotes = (res && res.remotes) || [];
      if (!remotes.length) { list.innerHTML = '<div class="gm-diff-empty">No remotes.</div>'; return; }
      list.innerHTML = remotes.map(rm => `
        <div class="gm-list-row">
          <span class="gm-list-name"><strong>${esc(rm.name)}</strong> <span class="gm-list-sub">${esc(rm.url)}</span></span>
          <span class="gm-list-actions">
            <button class="gm-mini" data-editurl="${esc(rm.name)}" data-url="${esc(rm.url)}">Edit URL</button>
            <button class="gm-mini gm-danger" data-delremote="${esc(rm.name)}">Remove</button>
          </span>
        </div>`).join('');
      list.querySelectorAll('[data-editurl]').forEach(b => b.addEventListener('click', async () => {
        const v = await gmPrompt({ title: 'Edit URL for ' + b.dataset.editurl, okText: 'Save', fields: [{ key: 'url', label: 'New URL', value: b.dataset.url }] });
        if (v && v.url) { await run('Set URL ' + b.dataset.editurl, () => window.api.git.setRemoteUrl(repo.path, b.dataset.editurl, v.url), { refresh: false }); render(); }
      }));
      list.querySelectorAll('[data-delremote]').forEach(b => b.addEventListener('click', async () => {
        const yes = await confirm({ title: 'Remove remote', message: `Remove remote "${b.dataset.delremote}"?`, confirmText: 'Remove', danger: true });
        if (yes) { await run('Remove remote ' + b.dataset.delremote, () => window.api.git.removeRemote(repo.path, b.dataset.delremote), { refresh: false }); render(); }
      }));
    }
    render();
  }

  // ---- auto-fetch ---------------------------------------------------------
  function autoFetchOn() { return !!dataManager.settings.gitAutoFetch; }
  async function toggleAutoFetch() {
    await dataManager.updateSettings({ gitAutoFetch: !autoFetchOn() });
    startAutoFetch();
    renderToolbar();
    setStatus('Auto-fetch ' + (autoFetchOn() ? 'on (every 5 min)' : 'off'), 'ok');
  }
  function startAutoFetch() {
    if (autoFetchTimer) { clearInterval(autoFetchTimer); autoFetchTimer = null; }
    if (!autoFetchOn()) return;
    autoFetchTimer = setInterval(async () => {
      if (!active || busy || !repo) return;
      try { await window.api.git.fetch(repo.path); await refreshAll(); } catch { /* offline / no remote */ }
    }, 5 * 60 * 1000);
  }

  // ---- data refresh -------------------------------------------------------
  async function refreshAll() {
    renderRepoBar();
    if (!repo) { renderBody(); renderToolbar(); return; }
    const isRepo = await window.api.git.isRepo(repo.path);
    if (!isRepo) { status = { error: 'Not a git repository.' }; branches = null; renderToolbar(); renderBody(); return; }
    let mergeRes;
    [status, branches, mergeRes] = await Promise.all([
      window.api.git.status(repo.path),
      window.api.git.branches(repo.path),
      window.api.git.mergeStatus(repo.path),
    ]);
    mergeState = mergeRes && mergeRes.state;
    renderToolbar(); renderBody();
  }

  // ---- render: repo bar ---------------------------------------------------
  function renderRepoBar() {
    const el = document.getElementById('gm-repobar');
    if (!el) return;
    const repos = getRepos();
    el.innerHTML = `
      <div class="gm-dropdown" id="gm-repo-dd">
        <button class="gm-dd-btn" data-dd="repo">
          <span class="gm-dd-ico">📁</span>
          <span class="gm-dd-label">${repo ? esc(repo.name) : 'No repository'}</span>
          <span class="gm-dd-caret">▾</span>
        </button>
        <div class="gm-dd-menu" data-menu="repo">
          ${repos.length ? repos.map(r => `
            <div class="gm-dd-item${repo && r.path === repo.path ? ' active' : ''}" data-repo="${esc(r.path)}">
              <span class="gm-dd-item-name">${esc(r.name)}</span>
              <span class="gm-dd-item-x" data-remove="${esc(r.path)}" title="Remove from list">✕</span>
            </div>`).join('') : '<div class="gm-dd-empty">No repositories yet</div>'}
          <div class="gm-dd-sep"></div>
          <div class="gm-dd-item gm-dd-action" data-action="add">➕ Add local repository…</div>
          <div class="gm-dd-item gm-dd-action" data-action="clone">⬇️ Clone repository…</div>
          <div class="gm-dd-item gm-dd-action" data-action="init">✨ Create repository here…</div>
        </div>
      </div>
      <button class="gm-btn gm-folder-btn" id="gm-upload-folder" title="Upload a folder to a repository">⬆️ Upload folder</button>
      <button class="gm-btn gm-folder-btn" id="gm-download-folder" title="Download a folder from a repository">⬇️ Download folder</button>`;
    wireDropdown(el.querySelector('#gm-repo-dd'));
    el.querySelector('#gm-upload-folder').addEventListener('click', openUpload);
    el.querySelector('#gm-download-folder').addEventListener('click', openDownload);
    el.querySelectorAll('[data-repo]').forEach(it => it.addEventListener('click', async e => {
      if (e.target.dataset.remove) return;
      const p = it.dataset.repo; repo = getRepos().find(r => r.path === p); await saveRepos(getRepos(), p); selectedFile = null; await refreshAll();
    }));
    el.querySelectorAll('[data-remove]').forEach(x => x.addEventListener('click', async e => {
      e.stopPropagation(); await removeRepo(x.dataset.remove);
    }));
    el.querySelector('[data-action="add"]').addEventListener('click', onAddLocal);
    el.querySelector('[data-action="clone"]').addEventListener('click', onClone);
    el.querySelector('[data-action="init"]').addEventListener('click', onInit);
  }

  async function onAddLocal() {
    const p = await window.api.files.selectFolder();
    if (!p) return;
    if (!(await window.api.git.isRepo(p))) {
      const yes = await confirm({ title: 'Not a git repo', message: 'That folder is not a git repository. Initialize one there?', confirmText: 'Initialize' });
      if (!yes) return;
      await window.api.git.init(p);
    }
    await addRepo(p);
  }
  async function onClone() {
    const v = await gmPrompt({ title: 'Clone repository', okText: 'Choose folder & clone', fields: [
      { key: 'url', label: 'Repository URL', placeholder: 'https://github.com/user/repo.git' },
      { key: 'name', label: 'Folder name (optional)', placeholder: 'defaults to repo name' },
    ] });
    if (!v || !v.url) return;
    const parent = await window.api.files.selectFolder();
    if (!parent) return;
    await run('Clone', async () => {
      const res = await window.api.git.clone(parent, v.url, v.name || undefined);
      await addRepo(res.path);
      return res.output;
    }, { refresh: false });
  }
  async function onInit() {
    const p = await window.api.files.selectFolder();
    if (!p) return;
    await window.api.git.init(p);
    await addRepo(p);
  }

  // ---- render: toolbar ----------------------------------------------------
  function renderToolbar() {
    const el = document.getElementById('gm-toolbar');
    if (!el) return;
    if (!repo) { el.innerHTML = ''; return; }
    const cur = (branches && branches.current) || (status && status.branch);
    const ahead = (status && status.ahead) || 0;
    const behind = (status && status.behind) || 0;
    const hasUpstream = !!(status && status.upstream);
    const locals = (branches && branches.local) || [];

    let syncBtn;
    if (!hasUpstream) syncBtn = `<button class="gm-btn gm-btn-primary" data-act="publish" ${busy ? 'disabled' : ''}>⬆️ Publish branch</button>`;
    else if (behind && ahead) syncBtn = `<button class="gm-btn gm-btn-primary" data-act="sync" ${busy ? 'disabled' : ''}>🔄 Sync ↓${behind} ↑${ahead}</button>`;
    else if (behind) syncBtn = `<button class="gm-btn gm-btn-primary" data-act="pull" ${busy ? 'disabled' : ''}>⬇️ Pull ${behind}</button>`;
    else if (ahead) syncBtn = `<button class="gm-btn gm-btn-primary" data-act="push" ${busy ? 'disabled' : ''}>⬆️ Push ${ahead}</button>`;
    else syncBtn = `<button class="gm-btn" data-act="fetch" ${busy ? 'disabled' : ''}>🔄 Fetch</button>`;

    el.innerHTML = `
      <div class="gm-dropdown" id="gm-branch-dd">
        <button class="gm-dd-btn" data-dd="branch" ${busy ? 'disabled' : ''}>
          <span class="gm-dd-ico">🔀</span>
          <span class="gm-dd-label">${cur ? esc(cur) : 'detached'}</span>
          <span class="gm-dd-caret">▾</span>
        </button>
        <div class="gm-dd-menu" data-menu="branch">
          <div class="gm-dd-item gm-dd-action" data-baction="new">➕ New branch…</div>
          <div class="gm-dd-sep"></div>
          ${locals.length ? locals.map(b => `
            <div class="gm-dd-item${b.current ? ' active' : ''}" data-branch="${esc(b.name)}">
              <span class="gm-dd-item-name">${b.current ? '✓ ' : ''}${esc(b.name)}</span>
              ${!b.current ? `<span class="gm-dd-item-x" data-delbranch="${esc(b.name)}" title="Delete branch">🗑</span>` : ''}
            </div>`).join('') : '<div class="gm-dd-empty">No branches</div>'}
        </div>
      </div>
      <div class="gm-toolbar-spacer"></div>
      ${syncBtn}
      <div class="gm-dropdown" id="gm-more-dd">
        <button class="gm-dd-btn gm-dd-icon-only" data-dd="more" ${busy ? 'disabled' : ''} title="More actions">⋯</button>
        <div class="gm-dd-menu gm-dd-right" data-menu="more">
          <div class="gm-dd-item gm-dd-action" data-mact="fetch">🔄 Fetch</div>
          <div class="gm-dd-item gm-dd-action" data-mact="pull">⬇️ Pull</div>
          <div class="gm-dd-item gm-dd-action" data-mact="push">⬆️ Push</div>
          <div class="gm-dd-sep"></div>
          <div class="gm-dd-item gm-dd-action" data-mact="merge">🔀 Merge branch into current…</div>
          <div class="gm-dd-item gm-dd-action" data-mact="stash">📦 Stash changes</div>
          <div class="gm-dd-item gm-dd-action" data-mact="stashpop">📤 Pop latest stash</div>
          <div class="gm-dd-item gm-dd-action" data-mact="stashmgr">🗂 Manage stashes…</div>
          <div class="gm-dd-sep"></div>
          <div class="gm-dd-item gm-dd-action" data-mact="tags">🏷 Manage tags…</div>
          <div class="gm-dd-item gm-dd-action" data-mact="remotes">🌐 Manage remotes…</div>
          <div class="gm-dd-sep"></div>
          <div class="gm-dd-item gm-dd-action" data-mact="undo">↩️ Undo last commit</div>
          <div class="gm-dd-item gm-dd-action gm-danger" data-mact="discardall">🗑 Discard all changes</div>
          <div class="gm-dd-sep"></div>
          <div class="gm-dd-item gm-dd-action" data-mact="autofetch">${autoFetchOn() ? '☑' : '☐'} Auto-fetch (5 min)</div>
          <div class="gm-dd-item gm-dd-action" data-mact="open">📂 Open in file browser</div>
          <div class="gm-dd-item gm-dd-action" data-mact="cli">⌨️ Toggle git terminal</div>
        </div>
      </div>`;

    wireDropdown(el.querySelector('#gm-branch-dd'));
    wireDropdown(el.querySelector('#gm-more-dd'));

    el.querySelectorAll('[data-branch]').forEach(it => it.addEventListener('click', e => {
      if (e.target.dataset.delbranch) return;
      onSwitchBranch(it.dataset.branch);
    }));
    el.querySelectorAll('[data-delbranch]').forEach(x => x.addEventListener('click', e => { e.stopPropagation(); onDeleteBranch(x.dataset.delbranch); }));
    el.querySelector('[data-baction="new"]').addEventListener('click', onNewBranch);

    const top = el.querySelector('[data-act]');
    if (top) top.addEventListener('click', () => onSyncAction(top.dataset.act));
    el.querySelectorAll('[data-mact]').forEach(b => b.addEventListener('click', () => onMore(b.dataset.mact)));
  }

  function onSyncAction(act) {
    const cur = branches && branches.current;
    const remote = (status && status.upstream) ? status.upstream.split('/')[0] : 'origin';
    if (act === 'fetch') return run('Fetch', () => window.api.git.fetch(repo.path));
    if (act === 'pull') return run('Pull', () => window.api.git.pull(repo.path));
    if (act === 'push') return run('Push', () => window.api.git.push(repo.path));
    if (act === 'sync') return run('Sync', () => window.api.git.sync(repo.path));
    if (act === 'publish') return run('Publish', () => window.api.git.push(repo.path, { setUpstream: true, remote, branch: cur }));
  }

  async function onMore(act) {
    if (act === 'fetch') return run('Fetch', () => window.api.git.fetch(repo.path));
    if (act === 'pull') return run('Pull', () => window.api.git.pull(repo.path));
    if (act === 'push') return run('Push', () => window.api.git.push(repo.path));
    if (act === 'stash') return run('Stash', () => window.api.git.stash(repo.path));
    if (act === 'stashpop') return run('Pop stash', () => window.api.git.stashApply(repo.path, null, true));
    if (act === 'stashmgr') return openStashManager();
    if (act === 'tags') return openTagManager();
    if (act === 'remotes') return openRemoteManager();
    if (act === 'autofetch') return toggleAutoFetch();
    if (act === 'open') return window.api.files.openPath(repo.path);
    if (act === 'cli') { cliOpen = !cliOpen; renderBody(); return; }
    if (act === 'merge') {
      const others = ((branches && branches.local) || []).filter(b => !b.current).map(b => b.name);
      if (!others.length) return setStatus('No other branches to merge.', 'err');
      const v = await gmPrompt({ title: 'Merge into current branch', okText: 'Merge', fields: [{ key: 'branch', label: 'Branch to merge (' + others.join(', ') + ')', placeholder: others[0], value: others[0] }] });
      if (v && v.branch) return run('Merge ' + v.branch, () => window.api.git.merge(repo.path, v.branch));
    }
    if (act === 'undo') {
      const yes = await confirm({ title: 'Undo last commit', message: 'Undo the last commit? Its changes will be kept and re-staged.', confirmText: 'Undo commit' });
      if (yes) return run('Undo last commit', () => window.api.git.undoLastCommit(repo.path));
    }
    if (act === 'discardall') {
      const yes = await confirm({ title: 'Discard all changes', message: 'Permanently discard ALL uncommitted changes (including untracked files)? This cannot be undone.', confirmText: 'Discard everything', danger: true });
      if (yes) { selectedFile = null; return run('Discard all', () => window.api.git.discardAll(repo.path)); }
    }
  }

  async function onSwitchBranch(name) {
    await run('Switch to ' + name, () => window.api.git.checkout(repo.path, name));
  }
  async function onNewBranch() {
    const v = await gmPrompt({ title: 'New branch', okText: 'Create branch', fields: [{ key: 'name', label: 'Branch name', placeholder: 'feature/my-change' }] });
    if (v && v.name) return run('Create branch ' + v.name, () => window.api.git.createBranch(repo.path, v.name, true));
  }
  async function onDeleteBranch(name) {
    const yes = await confirm({ title: 'Delete branch', message: `Delete branch "${name}"?`, confirmText: 'Delete', danger: true });
    if (!yes) return;
    try { await window.api.git.deleteBranch(repo.path, name, false); await refreshAll(); setStatus('Deleted ' + name, 'ok'); }
    catch (e) {
      const force = await confirm({ title: 'Not fully merged', message: `"${name}" is not fully merged. Force-delete it?`, confirmText: 'Force delete', danger: true });
      if (force) return run('Force-delete ' + name, () => window.api.git.deleteBranch(repo.path, name, true));
    }
  }

  // ---- render: body (changes / history / cli) -----------------------------
  function renderBody() {
    const el = document.getElementById('gm-body');
    if (!el) return;
    if (!repo) {
      el.innerHTML = `<div class="gm-empty"><div class="gm-empty-ico">🌱</div>
        <div class="gm-empty-title">No repository selected</div>
        <div class="gm-empty-sub">Add a local repo, clone one, or create a new repository to get started.</div></div>`;
      return;
    }
    if (status && status.error) {
      el.innerHTML = `<div class="gm-empty"><div class="gm-empty-ico">⚠️</div>
        <div class="gm-empty-title">${esc(status.error)}</div></div>`;
      return;
    }
    const conflicts = ((status && status.files) || []).filter(f => f.conflicted);
    const opBanner = mergeState ? `
      <div class="gm-opbanner${conflicts.length ? ' gm-opbanner-warn' : ''}">
        <span class="gm-opbanner-txt">${conflicts.length
          ? `⚠️ ${esc(mergeState)} in progress — resolve ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} below, then continue.`
          : `✅ ${esc(mergeState)} in progress — no conflicts remain.`}</span>
        <button class="gm-btn gm-btn-sm" data-op="continue" ${conflicts.length ? 'disabled' : ''}>Continue ${esc(mergeState)}</button>
        <button class="gm-btn gm-btn-sm gm-btn-ghost" data-op="abort">Abort</button>
      </div>` : '';

    el.innerHTML = `
      ${opBanner}
      <div class="gm-tabs">
        <button class="gm-tab${view === 'changes' ? ' active' : ''}" data-tab="changes">Changes${status && status.files && status.files.length ? ` <span class="gm-badge">${status.files.length}</span>` : ''}</button>
        <button class="gm-tab${view === 'history' ? ' active' : ''}" data-tab="history">History</button>
      </div>
      <div class="gm-panes">
        <div class="gm-left" id="gm-left"></div>
        <div class="gm-right" id="gm-right"><div class="gm-diff-empty">Select a file to view its diff.</div></div>
      </div>
      <div class="gm-cli${cliOpen ? ' open' : ''}" id="gm-cli">
        <div class="gm-cli-head" id="gm-cli-toggle"><span>⌨️ Git terminal</span><span class="gm-cli-hint">runs in ${esc(repo.name)}</span></div>
        <div class="gm-cli-body">
          <pre class="gm-cli-out" id="gm-cli-out"></pre>
          <div class="gm-cli-inputrow">
            <span class="gm-cli-prompt">git</span>
            <input class="gm-cli-input" id="gm-cli-input" type="text" placeholder="status -s   (Enter to run)" autocomplete="off" spellcheck="false">
          </div>
        </div>
      </div>`;

    el.querySelectorAll('.gm-tab').forEach(t => t.addEventListener('click', () => { view = t.dataset.tab; selectedFile = null; renderBody(); }));
    el.querySelectorAll('[data-op]').forEach(b => b.addEventListener('click', () => onOp(b.dataset.op)));
    document.getElementById('gm-cli-toggle').addEventListener('click', () => { cliOpen = !cliOpen; document.getElementById('gm-cli').classList.toggle('open', cliOpen); });
    const cliIn = document.getElementById('gm-cli-input');
    cliIn.addEventListener('keydown', e => { if (e.key === 'Enter') runCli(cliIn.value); });
    if (cliOutBuffer) document.getElementById('gm-cli-out').textContent = cliOutBuffer;

    if (view === 'changes') renderChanges(); else renderHistory();
    if (selectedFile) showDiff(selectedFile);
  }

  function renderChanges() {
    const left = document.getElementById('gm-left');
    const all = (status && status.files) || [];
    const conflicts = all.filter(f => f.conflicted);
    const files = all.filter(f => !f.conflicted);
    const allStaged = files.length > 0 && files.every(f => f.staged);
    const anyStaged = files.some(f => f.staged);
    const canCommit = anyStaged || (amend && !mergeState);
    const conflictSection = conflicts.length ? `
      <div class="gm-changes-head gm-conflicts-head">⚠️ ${conflicts.length} conflicted file${conflicts.length === 1 ? '' : 's'}</div>
      <div class="gm-filelist gm-conflictlist">
        ${conflicts.map(f => `
          <div class="gm-file-row gm-conflict-row${selectedFile === f.path ? ' selected' : ''}" data-path="${esc(f.path)}">
            <span class="gm-file-stat gm-stat-conf" title="${esc(f.status)}">!</span>
            <span class="gm-file-name" title="${esc(f.path)}">${esc(f.path)}</span>
            <span class="gm-conflict-btns">
              <button class="gm-mini" data-ours="${esc(f.path)}" title="Keep our version">Ours</button>
              <button class="gm-mini" data-theirs="${esc(f.path)}" title="Keep their version">Theirs</button>
              <button class="gm-mini" data-openconf="${esc(f.path)}" title="Edit in default app">Edit</button>
              <button class="gm-mini" data-resolved="${esc(f.path)}" title="Mark resolved (stage as-is)">✓</button>
            </span>
          </div>`).join('')}
      </div>` : '';
    left.innerHTML = `
      ${conflictSection}
      <div class="gm-changes-head">
        <label class="gm-checkall"><input type="checkbox" id="gm-checkall" ${allStaged ? 'checked' : ''} ${anyStaged && !allStaged ? 'data-indeterminate="1"' : ''}> ${files.length} changed file${files.length === 1 ? '' : 's'}</label>
      </div>
      <div class="gm-filelist">
        ${files.length ? files.map(f => `
          <div class="gm-file-row${selectedFile === f.path ? ' selected' : ''}" data-path="${esc(f.path)}">
            <input type="checkbox" class="gm-file-check" data-path="${esc(f.path)}" ${f.staged ? 'checked' : ''}>
            <span class="gm-file-stat gm-stat-${statClass(f)}" title="${esc(f.status)}">${statLetter(f)}</span>
            <span class="gm-file-name" title="${esc(f.path)}">${esc(f.path)}</span>
            <span class="gm-file-discard" data-discard="${esc(f.path)}" title="Discard changes">↺</span>
          </div>`).join('') : '<div class="gm-diff-empty">No changes — working tree clean.</div>'}
      </div>
      <div class="gm-commit-box">
        <input class="gm-commit-summary" id="gm-commit-summary" type="text" placeholder="Summary (required)" value="${esc(commitDraft.summary)}">
        <textarea class="gm-commit-desc" id="gm-commit-desc" rows="2" placeholder="Description">${esc(commitDraft.desc)}</textarea>
        <label class="gm-check gm-amend"><input type="checkbox" id="gm-amend" ${amend ? 'checked' : ''}> Amend last commit</label>
        <button class="gm-btn gm-btn-primary gm-commit-btn" id="gm-commit-btn" ${canCommit ? '' : 'disabled'}>
          ${amend ? 'Amend commit on' : 'Commit to'} <strong>${esc((branches && branches.current) || (status && status.branch) || 'HEAD')}</strong>
        </button>
      </div>`;

    conflicts.length && bindConflicts(left);
    const checkAll = document.getElementById('gm-checkall');
    if (checkAll.dataset.indeterminate) checkAll.indeterminate = true;
    checkAll.addEventListener('change', () => run(checkAll.checked ? 'Stage all' : 'Unstage all',
      () => checkAll.checked ? window.api.git.stageAll(repo.path) : window.api.git.unstageAll(repo.path)));

    left.querySelectorAll('.gm-file-check').forEach(c => c.addEventListener('change', e => {
      e.stopPropagation();
      const p = c.dataset.path;
      run(c.checked ? 'Stage ' + p : 'Unstage ' + p,
        () => c.checked ? window.api.git.stagePaths(repo.path, [p]) : window.api.git.unstagePaths(repo.path, [p]));
    }));
    left.querySelectorAll('.gm-file-row').forEach(r => r.addEventListener('click', e => {
      if (e.target.classList.contains('gm-file-check') || e.target.dataset.discard) return;
      selectedFile = r.dataset.path; renderChanges(); showDiff(selectedFile);
    }));
    left.querySelectorAll('[data-discard]').forEach(x => x.addEventListener('click', async e => {
      e.stopPropagation();
      const p = x.dataset.discard;
      const yes = await confirm({ title: 'Discard changes', message: `Discard changes to "${p}"? This cannot be undone.`, confirmText: 'Discard', danger: true });
      if (yes) { if (selectedFile === p) selectedFile = null; run('Discard ' + p, () => window.api.git.discardPaths(repo.path, [p])); }
    }));
    const sumEl = document.getElementById('gm-commit-summary');
    const descEl = document.getElementById('gm-commit-desc');
    sumEl.addEventListener('input', () => { commitDraft.summary = sumEl.value; });
    descEl.addEventListener('input', () => { commitDraft.desc = descEl.value; });
    sumEl.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onCommit(); });
    document.getElementById('gm-commit-btn').addEventListener('click', onCommit);
    document.getElementById('gm-amend').addEventListener('change', async e => {
      amend = e.target.checked;
      if (amend && !commitDraft.summary && !commitDraft.desc) {
        const msg = await window.api.git.lastCommitMessage(repo.path);
        const [first, ...rest] = (msg || '').split('\n');
        commitDraft = { summary: first || '', desc: rest.join('\n').trim() };
      }
      renderChanges();
    });
  }

  // Conflict-resolution buttons in the conflicts section.
  function bindConflicts(left) {
    left.querySelectorAll('[data-ours]').forEach(b => b.addEventListener('click', () => run('Keep ours: ' + b.dataset.ours, () => window.api.git.resolvePaths(repo.path, [b.dataset.ours], 'ours'))));
    left.querySelectorAll('[data-theirs]').forEach(b => b.addEventListener('click', () => run('Keep theirs: ' + b.dataset.theirs, () => window.api.git.resolvePaths(repo.path, [b.dataset.theirs], 'theirs'))));
    left.querySelectorAll('[data-openconf]').forEach(b => b.addEventListener('click', () => window.api.files.openPath(repo.path + '/' + b.dataset.openconf)));
    left.querySelectorAll('[data-resolved]').forEach(b => b.addEventListener('click', () => run('Mark resolved: ' + b.dataset.resolved, () => window.api.git.stagePaths(repo.path, [b.dataset.resolved]))));
    left.querySelectorAll('.gm-conflict-row').forEach(r => r.addEventListener('click', e => {
      if (e.target.closest('.gm-conflict-btns')) return;
      selectedFile = r.dataset.path; renderChanges(); showDiff(selectedFile);
    }));
  }

  // Continue / abort an in-progress merge, rebase, cherry-pick, or revert.
  async function onOp(op) {
    if (op === 'continue') return run('Continue ' + mergeState, () => window.api.git.continueOp(repo.path, mergeState));
    if (op === 'abort') {
      const yes = await confirm({ title: 'Abort ' + mergeState, message: `Abort the in-progress ${mergeState}? Any conflict resolutions will be lost.`, confirmText: 'Abort', danger: true });
      if (yes) return run('Abort ' + mergeState, () => window.api.git.abort(repo.path, mergeState));
    }
  }

  async function onCommit() {
    const summary = (commitDraft.summary || '').trim();
    const desc = (commitDraft.desc || '').trim();
    if (!summary) { setStatus('Enter a commit summary.', 'err'); return; }
    const msg = desc ? `${summary}\n\n${desc}` : summary;
    const out = await run(amend ? 'Amend' : 'Commit', () => window.api.git.commit(repo.path, msg, { amend }));
    if (out !== undefined) { // success → clear the draft + amend, and the (already re-rendered) inputs
      commitDraft = { summary: '', desc: '' }; amend = false;
      const s = document.getElementById('gm-commit-summary'); if (s) s.value = '';
      const d = document.getElementById('gm-commit-desc'); if (d) d.value = '';
    }
  }

  async function renderHistory() {
    const left = document.getElementById('gm-left');
    left.innerHTML = '<div class="gm-diff-empty">Loading history…</div>';
    const res = await window.api.git.log(repo.path, 100);
    if (res.error) { left.innerHTML = `<div class="gm-diff-empty">${esc(res.error)}</div>`; return; }
    const commits = res.commits || [];
    left.innerHTML = `<div class="gm-commitlist">${commits.length ? commits.map(c => `
      <div class="gm-commit-row" data-hash="${esc(c.hash)}" data-subj="${esc(c.subject)}">
        <div class="gm-commit-subject">${esc(c.subject)}${c.refs ? ` <span class="gm-commit-refs">${esc(c.refs)}</span>` : ''}</div>
        <div class="gm-commit-meta">${esc(c.shortHash)} · ${esc(c.author)} · ${fmtDate(c.date)}</div>
      </div>`).join('') : '<div class="gm-diff-empty">No commits yet.</div>'}</div>`;
    left.querySelectorAll('.gm-commit-row').forEach(r => {
      r.addEventListener('click', async () => {
        left.querySelectorAll('.gm-commit-row').forEach(x => x.classList.remove('selected'));
        r.classList.add('selected');
        const right = document.getElementById('gm-right');
        right.innerHTML = '<div class="gm-diff-empty">Loading…</div>';
        const out = await window.api.git.raw(repo.path, `show --stat --patch ${r.dataset.hash}`);
        right.innerHTML = `<div class="gm-diff">${renderDiff(out.stdout || out.stderr || '')}</div>`;
      });
      r.addEventListener('contextmenu', e => { e.preventDefault(); openCommitMenu(e, r.dataset.hash, r.dataset.subj); });
    });
  }

  // Right-click menu on a commit in the History list.
  function openCommitMenu(e, hash, subject) {
    const short = (hash || '').slice(0, 7);
    showContextMenu(e.clientX, e.clientY, [
      { label: '📋 Copy SHA', onClick: () => { navigator.clipboard.writeText(hash).then(() => setStatus('Copied ' + short, 'ok')); } },
      { label: '🔍 Checkout (detached)', onClick: async () => { const yes = await confirm({ title: 'Checkout commit', message: `Check out ${short} in detached-HEAD state?`, confirmText: 'Checkout' }); if (yes) run('Checkout ' + short, () => window.api.git.checkoutCommit(repo.path, hash)); } },
      { sep: true },
      { label: '🌿 Create branch here…', onClick: async () => { const v = await gmPrompt({ title: 'New branch at ' + short, okText: 'Create', fields: [{ key: 'name', label: 'Branch name', placeholder: 'feature/x' }] }); if (v && v.name) run('Branch at ' + short, () => window.api.git.branchAt(repo.path, v.name, hash)); } },
      { label: '🏷 Create tag here…', onClick: async () => { const v = await gmPrompt({ title: 'New tag at ' + short, okText: 'Create', fields: [{ key: 'name', label: 'Tag name', placeholder: 'v1.0.0' }, { key: 'msg', label: 'Message (optional → annotated tag)', placeholder: '' }] }); if (v && v.name) run('Tag at ' + short, () => window.api.git.tagAt(repo.path, v.name, hash, v.msg || undefined)); } },
      { sep: true },
      { label: '🍒 Cherry-pick onto current', onClick: () => run('Cherry-pick ' + short, () => window.api.git.cherryPick(repo.path, hash)) },
      { label: '↩️ Revert this commit', onClick: async () => { const yes = await confirm({ title: 'Revert commit', message: `Create a new commit that undoes ${short} ("${subject}")?`, confirmText: 'Revert' }); if (yes) run('Revert ' + short, () => window.api.git.revert(repo.path, hash)); } },
      { sep: true },
      { label: '⏪ Reset — keep changes (soft)', onClick: () => doReset(hash, short, 'soft') },
      { label: '⏪ Reset — unstage changes (mixed)', onClick: () => doReset(hash, short, 'mixed') },
      { label: '⏪ Reset — discard changes (hard)', danger: true, onClick: () => doReset(hash, short, 'hard') },
    ]);
  }
  async function doReset(hash, short, mode) {
    const yes = await confirm({
      title: `Reset (${mode})`,
      message: mode === 'hard'
        ? `Hard-reset current branch to ${short}? All changes after it will be PERMANENTLY lost.`
        : `Reset current branch to ${short} (${mode})? History after it is removed; your files are kept.`,
      confirmText: 'Reset', danger: mode === 'hard',
    });
    if (yes) run(`Reset (${mode}) to ${short}`, () => window.api.git.reset(repo.path, hash, mode));
  }

  async function showDiff(p) {
    const right = document.getElementById('gm-right');
    if (!right) return;
    const f = (status.files || []).find(x => x.path === p);
    right.innerHTML = '<div class="gm-diff-empty">Loading diff…</div>';
    const staged = f && f.staged && !f.unstaged;
    const diff = await window.api.git.diffPath(repo.path, p, staged);
    right.innerHTML = diff && diff.trim()
      ? `<div class="gm-diff">${renderDiff(diff)}</div>`
      : '<div class="gm-diff-empty">No textual diff (binary or no changes).</div>';
  }

  // ---- diff / cli rendering ----------------------------------------------
  function renderDiff(text) {
    return text.split('\n').map(line => {
      let cls = 'gm-dl';
      if (line.startsWith('+++') || line.startsWith('---')) cls += ' gm-dl-meta';
      else if (line.startsWith('@@')) cls += ' gm-dl-hunk';
      else if (line.startsWith('+')) cls += ' gm-dl-add';
      else if (line.startsWith('-')) cls += ' gm-dl-del';
      else if (line.startsWith('diff ') || line.startsWith('index ')) cls += ' gm-dl-meta';
      return `<div class="${cls}">${esc(line) || '&nbsp;'}</div>`;
    }).join('');
  }

  let cliOutBuffer = '';
  function appendCli(text) {
    cliOutBuffer = (cliOutBuffer + '\n' + text).trim().split('\n').slice(-400).join('\n');
    const out = document.getElementById('gm-cli-out');
    if (out) { out.textContent = cliOutBuffer; out.scrollTop = out.scrollHeight; }
  }
  async function runCli(line) {
    line = (line || '').trim();
    if (!line || !repo) return;
    const input = document.getElementById('gm-cli-input');
    if (input) input.value = '';
    appendCli('$ git ' + line);
    const res = await window.api.git.raw(repo.path, line);
    if (res.stdout && res.stdout.trim()) appendCli(res.stdout.trim());
    if (res.stderr && res.stderr.trim()) appendCli(res.stderr.trim());
    await refreshAll();
    // refreshAll() re-renders the body; keep the terminal open + scrolled.
    if (cliOpen) document.getElementById('gm-cli')?.classList.add('open');
  }

  // ---- misc helpers -------------------------------------------------------
  function statClass(f) {
    if (f.untracked) return 'new';
    const s = (f.index || f.work);
    return { M: 'mod', A: 'new', D: 'del', R: 'ren', C: 'mod', U: 'conf' }[s] || 'mod';
  }
  function statLetter(f) {
    if (f.untracked) return 'U';
    return (f.index || f.work || 'M');
  }
  function fmtDate(iso) {
    try { const d = new Date(iso); return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return iso; }
  }

  // ---- dropdown plumbing --------------------------------------------------
  function wireDropdown(root) {
    if (!root) return;
    const btn = root.querySelector('.gm-dd-btn');
    const menu = root.querySelector('.gm-dd-menu');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = root.classList.contains('open');
      document.querySelectorAll('.gm-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!open) root.classList.add('open');
    });
    menu.addEventListener('click', e => { /* item handlers close it */ });
  }
  function closeAllDropdowns() { document.querySelectorAll('.gm-dropdown.open').forEach(d => d.classList.remove('open')); }

  // ---- top-level render ---------------------------------------------------
  function render(container) {
    container.innerHTML = `
      <div class="gm-root">
        <div class="gm-topbar">
          <div class="gm-repobar" id="gm-repobar"></div>
          <div class="gm-toolbar" id="gm-toolbar"></div>
        </div>
        <div class="gm-body" id="gm-body"></div>
        <div class="gm-statusline" id="gm-statusline"></div>
      </div>`;
    document.addEventListener('click', closeAllDropdowns);
  }

  // ---- public -------------------------------------------------------------
  return {
    mount(containerEl) {
      if (mounted) return;
      render(containerEl);
      mounted = true;
      // Restore last repo
      const last = dataManager.settings.gitLastRepo;
      const repos = getRepos();
      repo = (last && repos.find(r => r.path === last)) || repos[0] || null;
    },
    async activate() { active = true; startAutoFetch(); if (mounted) await refreshAll(); },
    deactivate() { active = false; closeAllDropdowns(); document.querySelectorAll('.gm-ctxmenu').forEach(m => m.remove()); },
    // Open a specific repo by path (used by the Files tab's "Open in Git Manager").
    async openRepo(path) { if (!mounted) return; selectedFile = null; await addRepo(path); },
  };
})();
