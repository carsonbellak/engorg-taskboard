// Email hub view — IMAP/SMTP client UI. Renders into #view-email.
// All network/credential work happens in the main process via window.api.email.*.

class EmailView {
  constructor() {
    this.accounts = [];
    this.providers = {};
    this.selection = 'unified';     // 'unified' or an accountId
    this.folder = 'INBOX';
    this.foldersByAccount = {};     // accountId -> [folders]
    this.messages = [];
    this.openMsg = null;            // { accountId, folder, uid }
    this.pollTimer = null;
    this.loadImages = false;
    this.composeAttachments = [];
    this.built = false;
  }

  // ── lifecycle ──
  async init() {
    this._buildShell();
    this._buildModals();
    this.providers = await window.api.email.listProviders().catch(() => ({}));
    await this._loadAccounts();
    this.built = true;
  }

  activate() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._refreshList(true), 60000);
  }

  deactivate() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  _esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ── shell ──
  _buildShell() {
    const root = document.getElementById('view-email');
    root.innerHTML = `
      <div class="email-layout">
        <aside class="email-sidebar">
          <button class="email-compose-btn" id="email-compose">&#9998; Compose</button>
          <div class="email-nav" id="email-nav"></div>
          <button class="email-add-account" id="email-add-account">+ Add account</button>
        </aside>
        <section class="email-list-pane">
          <div class="email-list-header">
            <input type="search" class="email-search" id="email-search" placeholder="Search mail…">
            <button class="email-icon-btn" id="email-refresh" title="Refresh">&#10227;</button>
          </div>
          <div class="email-list" id="email-list"></div>
        </section>
        <section class="email-read-pane" id="email-read">
          <div class="email-read-empty">Select a message to read</div>
        </section>
      </div>`;

    root.querySelector('#email-compose').addEventListener('click', () => this._openCompose());
    root.querySelector('#email-add-account').addEventListener('click', () => this._openAccountModal());
    root.querySelector('#email-refresh').addEventListener('click', () => this._refreshList());
    const search = root.querySelector('#email-search');
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._search(search.value.trim()); });
  }

  // ── accounts / nav ──
  async _loadAccounts() {
    this.accounts = await window.api.email.listAccounts().catch(() => []);
    this._renderNav();
    if (this.accounts.length === 0) {
      document.getElementById('email-list').innerHTML =
        `<div class="email-empty">No accounts yet.<br>Click <b>+ Add account</b> to connect Gmail, Outlook, or any IMAP mailbox.</div>`;
      document.getElementById('email-read').innerHTML = `<div class="email-read-empty">No accounts connected</div>`;
      return;
    }
    if (this.selection !== 'unified' && !this.accounts.find(a => a.id === this.selection)) {
      this.selection = 'unified';
    }
    this._loadMessages();
  }

  _renderNav() {
    const nav = document.getElementById('email-nav');
    let html = '';
    if (this.accounts.length > 1) {
      html += `<div class="email-nav-item ${this.selection === 'unified' ? 'active' : ''}" data-sel="unified">
        <span class="email-nav-dot" style="background:linear-gradient(135deg,#3B82F6,#8B5CF6)"></span>All Inboxes</div>`;
    }
    for (const a of this.accounts) {
      const active = this.selection === a.id;
      html += `<div class="email-account">
        <div class="email-nav-item email-account-head ${active ? 'active' : ''}" data-sel="${a.id}">
          <span class="email-nav-dot" style="background:${this._esc(a.color)}"></span>
          <span class="email-account-name" title="${this._esc(a.email)}">${this._esc(a.name || a.email)}</span>
          <button class="email-acct-remove" data-remove="${a.id}" title="Remove account">&times;</button>
        </div>
        <div class="email-folders" data-folders="${a.id}">${active ? this._renderFolders(a.id) : ''}</div>
      </div>`;
    }
    nav.innerHTML = html;

    nav.querySelectorAll('.email-nav-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.email-acct-remove')) return;
        this._select(el.dataset.sel);
      });
    });
    nav.querySelectorAll('.email-acct-remove').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this._removeAccount(btn.dataset.remove); });
    });
    nav.querySelectorAll('.email-folder').forEach(el => {
      el.addEventListener('click', () => { this.folder = el.dataset.folder; this._renderNav(); this._loadMessages(); });
    });
  }

  _renderFolders(accountId) {
    const folders = this.foldersByAccount[accountId];
    if (!folders) { this._loadFolders(accountId); return `<div class="email-folder-loading">Loading folders…</div>`; }
    return folders.map(f => {
      const label = f.specialUse ? f.name : f.name;
      return `<div class="email-folder ${this.selection === accountId && this.folder === f.path ? 'active' : ''}" data-folder="${this._esc(f.path)}">
        ${this._folderIcon(f.specialUse)} ${this._esc(label)}</div>`;
    }).join('');
  }

  _folderIcon(special) {
    switch (special) {
      case '\\Sent': return '&#128228;';
      case '\\Drafts': return '&#128221;';
      case '\\Trash': return '&#128465;';
      case '\\Junk': return '&#9888;';
      case '\\Archive': return '&#128230;';
      default: return '&#128193;';
    }
  }

  async _loadFolders(accountId) {
    try {
      this.foldersByAccount[accountId] = await window.api.email.listFolders(accountId);
    } catch (err) {
      this.foldersByAccount[accountId] = [{ path: 'INBOX', name: 'Inbox', specialUse: null }];
      console.warn('[email] folders:', err.message);
    }
    if (this.selection === accountId) this._renderNav();
  }

  _select(sel) {
    this.selection = sel;
    this.folder = 'INBOX';
    this._renderNav();
    this._loadMessages();
  }

  // ── message list ──
  async _loadMessages() {
    const listEl = document.getElementById('email-list');
    listEl.innerHTML = `<div class="email-loading">Loading…</div>`;
    try {
      if (this.selection === 'unified') {
        const { messages } = await window.api.email.listUnified({ limit: 40 });
        this.messages = messages;
      } else {
        const { messages } = await window.api.email.listMessages(this.selection, this.folder, { limit: 50 });
        this.messages = messages.map(m => ({ ...m, accountId: this.selection, folder: this.folder }));
      }
      this._renderList();
    } catch (err) {
      listEl.innerHTML = `<div class="email-empty email-error">Could not load mail:<br>${this._esc(err.message)}</div>`;
    }
  }

  async _refreshList(silent) {
    if (this.accounts.length === 0) return;
    if (!silent) document.getElementById('email-list').innerHTML = `<div class="email-loading">Refreshing…</div>`;
    await this._loadMessages();
  }

  _renderList() {
    const listEl = document.getElementById('email-list');
    if (this.messages.length === 0) {
      listEl.innerHTML = `<div class="email-empty">No messages</div>`;
      return;
    }
    // Group consecutive messages by threadKey for light threading.
    listEl.innerHTML = this.messages.map(m => {
      const open = this.openMsg && this.openMsg.accountId === m.accountId && this.openMsg.uid === m.uid && this.openMsg.folder === m.folder;
      const who = m.from ? (m.from.name || m.from.address) : '(unknown)';
      const acctTag = (this.selection === 'unified' && m.accountColor)
        ? `<span class="email-list-acct" style="background:${this._esc(m.accountColor)}"></span>` : '';
      return `<div class="email-list-item ${m.seen ? '' : 'unread'} ${open ? 'open' : ''}"
                   data-acct="${this._esc(m.accountId)}" data-folder="${this._esc(m.folder)}" data-uid="${m.uid}">
        ${acctTag}
        <div class="email-list-main">
          <div class="email-list-row1">
            <span class="email-list-from">${this._esc(who)}</span>
            <span class="email-list-date">${this._fmtDate(m.date)}</span>
          </div>
          <div class="email-list-subject">${m.flagged ? '&#11088; ' : ''}${this._esc(m.subject)}</div>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.email-list-item').forEach(el => {
      el.addEventListener('click', () => this._open(el.dataset.acct, el.dataset.folder, parseInt(el.dataset.uid, 10)));
    });
  }

  async _search(query) {
    if (!query) return this._loadMessages();
    if (this.selection === 'unified') return; // search needs a specific account/folder
    const listEl = document.getElementById('email-list');
    listEl.innerHTML = `<div class="email-loading">Searching…</div>`;
    try {
      const { messages } = await window.api.email.search(this.selection, this.folder, query);
      this.messages = messages.map(m => ({ ...m, accountId: this.selection, folder: this.folder }));
      this._renderList();
    } catch (err) {
      listEl.innerHTML = `<div class="email-empty email-error">${this._esc(err.message)}</div>`;
    }
  }

  // ── reading pane ──
  async _open(accountId, folder, uid) {
    this.openMsg = { accountId, folder, uid };
    this.loadImages = false;
    const pane = document.getElementById('email-read');
    pane.innerHTML = `<div class="email-loading">Loading message…</div>`;
    this._renderList(); // highlight + clear unread
    try {
      const msg = await window.api.email.getMessage(accountId, folder, uid);
      this._renderMessage(msg, accountId, folder, uid);
      const item = this.messages.find(m => m.accountId === accountId && m.uid === uid && m.folder === folder);
      if (item) item.seen = true;
      this._renderList();
    } catch (err) {
      pane.innerHTML = `<div class="email-read-empty email-error">${this._esc(err.message)}</div>`;
    }
  }

  _renderMessage(msg, accountId, folder, uid) {
    const pane = document.getElementById('email-read');
    const fromName = msg.from ? (msg.from.name || msg.from.address) : '(unknown)';
    const fromAddr = msg.from ? msg.from.address : '';
    const toLine = msg.to.map(t => this._esc(t.name || t.address)).join(', ');

    const attachHtml = msg.attachments.length ? `
      <div class="email-attachments">
        ${msg.attachments.map(a => `
          <button class="email-attach-chip" data-att="${a.index}" title="Open ${this._esc(a.filename)}">
            &#128206; ${this._esc(a.filename)} <span class="email-attach-size">${this._fmtSize(a.size)}</span>
            <span class="email-attach-dl" data-dl="${a.index}" title="Save as…">&#11015;</span>
          </button>`).join('')}
      </div>` : '';

    pane.innerHTML = `
      <div class="email-read-head">
        <div class="email-read-subject">${this._esc(msg.subject)}</div>
        <div class="email-read-meta">
          <div class="email-read-from"><b>${this._esc(fromName)}</b> <span class="email-read-addr">${this._esc(fromAddr)}</span></div>
          <div class="email-read-date">${this._fmtDate(msg.date, true)}</div>
        </div>
        <div class="email-read-to">to ${toLine || '—'}</div>
        <div class="email-read-actions">
          <button class="email-btn" data-act="reply">&#8617; Reply</button>
          <button class="email-btn" data-act="replyAll">&#8617; Reply All</button>
          <button class="email-btn" data-act="forward">&#8618; Forward</button>
          <button class="email-btn email-btn-danger" data-act="delete">&#128465; Delete</button>
          ${(msg.html && !this.loadImages) ? `<button class="email-btn email-btn-ghost" data-act="images">Load remote images</button>` : ''}
        </div>
        ${attachHtml}
      </div>
      <iframe class="email-read-body" id="email-body-frame" sandbox></iframe>`;

    const frame = pane.querySelector('#email-body-frame');
    frame.srcdoc = this._buildBodyDoc(msg);

    pane.querySelectorAll('.email-read-actions [data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'reply') this._openCompose({ mode: 'reply', msg, accountId });
        else if (act === 'replyAll') this._openCompose({ mode: 'replyAll', msg, accountId });
        else if (act === 'forward') this._openCompose({ mode: 'forward', msg, accountId });
        else if (act === 'delete') this._deleteOpen(accountId, folder, uid);
        else if (act === 'images') { this.loadImages = true; this._renderMessage(msg, accountId, folder, uid); }
      });
    });
    pane.querySelectorAll('.email-attach-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        const idx = parseInt(chip.dataset.att, 10);
        const save = e.target.closest('[data-dl]');
        window.api.email.saveAttachment(accountId, folder, uid, idx, !save).catch(err => alert('Attachment failed: ' + err.message));
      });
    });
  }

  // Build the sandboxed document. A CSP meta blocks remote images until the user opts in.
  _buildBodyDoc(msg) {
    const imgPolicy = this.loadImages ? 'img-src data: cid: https: http:' : 'img-src data: cid:';
    const csp = `default-src 'none'; style-src 'unsafe-inline'; ${imgPolicy};`;
    const body = msg.html || msg.textAsHtml || `<pre>${this._esc(msg.text)}</pre>`;
    return `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <style>
        html,body{margin:0;padding:14px;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;background:#fff;word-wrap:break-word;}
        img{max-width:100%;height:auto;} a{color:#2563eb;} pre{white-space:pre-wrap;font:inherit;}
        table{max-width:100%;}
      </style></head><body>${body}</body></html>`;
  }

  async _deleteOpen(accountId, folder, uid) {
    try {
      await window.api.email.deleteMessage(accountId, folder, uid);
      this.openMsg = null;
      document.getElementById('email-read').innerHTML = `<div class="email-read-empty">Message deleted</div>`;
      this._loadMessages();
    } catch (err) { alert('Delete failed: ' + err.message); }
  }

  async _removeAccount(id) {
    const acct = this.accounts.find(a => a.id === id);
    if (!confirm(`Remove ${acct ? acct.email : 'this account'} from the app? (Your mailbox is not affected.)`)) return;
    await window.api.email.removeAccount(id).catch(() => {});
    delete this.foldersByAccount[id];
    if (this.selection === id) this.selection = 'unified';
    await this._loadAccounts();
  }

  // ── account setup modal ──
  _buildModals() {
    if (document.getElementById('email-account-modal')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div id="email-account-modal" class="modal hidden">
        <div class="modal-box email-modal-box">
          <h3 class="email-modal-title">Add email account</h3>
          <label class="email-field"><span>Provider</span>
            <select id="email-provider"></select></label>
          <label class="email-field"><span>Display name</span>
            <input id="email-f-name" placeholder="e.g. Carson (Work)"></label>
          <label class="email-field"><span>Email address</span>
            <input id="email-f-email" type="email" placeholder="you@example.com"></label>
          <label class="email-field"><span>App password</span>
            <input id="email-f-pass" type="password" placeholder="App password (not your normal password)"></label>
          <div class="email-oauth hidden" id="email-oauth">
            <button class="email-btn email-btn-primary email-oauth-btn" id="email-oauth-btn" type="button">&#128273; Sign in with Microsoft</button>
            <div class="email-oauth-note" id="email-oauth-note"></div>
          </div>
          <div class="email-help" id="email-help"></div>
          <div class="email-guide hidden" id="email-guide"></div>
          <div class="email-custom hidden" id="email-custom">
            <div class="email-custom-row">
              <label class="email-field"><span>IMAP host</span><input id="email-imap-host"></label>
              <label class="email-field email-field-sm"><span>Port</span><input id="email-imap-port" type="number"></label>
              <label class="email-check"><input type="checkbox" id="email-imap-secure" checked> TLS</label>
            </div>
            <div class="email-custom-row">
              <label class="email-field"><span>SMTP host</span><input id="email-smtp-host"></label>
              <label class="email-field email-field-sm"><span>Port</span><input id="email-smtp-port" type="number"></label>
              <label class="email-check"><input type="checkbox" id="email-smtp-secure"> TLS</label>
            </div>
          </div>
          <div class="email-modal-status" id="email-modal-status"></div>
          <div class="email-modal-actions">
            <button class="email-btn email-btn-ghost" id="email-cancel-account">Cancel</button>
            <button class="email-btn email-btn-primary" id="email-save-account">Test &amp; Save</button>
          </div>
        </div>
      </div>

      <div id="email-compose-modal" class="modal hidden">
        <div class="modal-box email-compose-box">
          <h3 class="email-modal-title" id="email-compose-title">New message</h3>
          <label class="email-field"><span>From</span><select id="email-c-from"></select></label>
          <label class="email-field"><span>To</span><input id="email-c-to" placeholder="recipient@example.com, ..."></label>
          <label class="email-field"><span>Cc</span><input id="email-c-cc" placeholder="optional"></label>
          <label class="email-field"><span>Subject</span><input id="email-c-subject"></label>
          <textarea id="email-c-body" class="email-c-body" placeholder="Write your message…"></textarea>
          <div class="email-c-attachments" id="email-c-attachments"></div>
          <div class="email-modal-status" id="email-compose-status"></div>
          <div class="email-modal-actions">
            <button class="email-btn email-btn-ghost" id="email-c-attach">&#128206; Attach</button>
            <span style="flex:1"></span>
            <button class="email-btn email-btn-ghost" id="email-c-cancel">Cancel</button>
            <button class="email-btn email-btn-primary" id="email-c-send">Send</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    // Account modal wiring
    const provSel = document.getElementById('email-provider');
    document.getElementById('email-cancel-account').addEventListener('click', () => this._closeModal('email-account-modal'));
    document.getElementById('email-save-account').addEventListener('click', () => this._saveAccount());
    document.getElementById('email-oauth-btn').addEventListener('click', () => this._saveOAuthAccount());
    provSel.addEventListener('change', () => this._onProviderChange());

    // Compose modal wiring
    document.getElementById('email-c-cancel').addEventListener('click', () => this._closeModal('email-compose-modal'));
    document.getElementById('email-c-send').addEventListener('click', () => this._send());
    document.getElementById('email-c-attach').addEventListener('click', () => this._attach());
  }

  async _openAccountModal() {
    const provSel = document.getElementById('email-provider');
    provSel.innerHTML = Object.entries(this.providers).map(([id, p]) => `<option value="${id}">${this._esc(p.label)}</option>`).join('');
    document.getElementById('email-f-name').value = '';
    document.getElementById('email-f-email').value = '';
    document.getElementById('email-f-pass').value = '';
    document.getElementById('email-modal-status').textContent = '';
    // Whether Microsoft OAuth is wired up (client ID present in config) — gates the button.
    this.oauthConfigured = await window.api.email.oauthConfigured().catch(() => false);
    this._onProviderChange();
    this._showModal('email-account-modal');
  }

  _onProviderChange() {
    const id = document.getElementById('email-provider').value;
    const p = this.providers[id];
    const help = document.getElementById('email-help');
    const custom = document.getElementById('email-custom');
    const oauthBox = document.getElementById('email-oauth');
    const guide = document.getElementById('email-guide');
    const emailField = document.getElementById('email-f-email').closest('.email-field');
    const passField = document.getElementById('email-f-pass').closest('.email-field');
    const saveBtn = document.getElementById('email-save-account');
    if (!p) return;

    if (p.oauth) {
      // OAuth provider (Microsoft): sign-in replaces the email + app-password fields.
      custom.classList.add('hidden');
      guide.classList.add('hidden');
      emailField.classList.add('hidden');
      passField.classList.add('hidden');
      oauthBox.classList.remove('hidden');
      saveBtn.classList.add('hidden');
      const note = document.getElementById('email-oauth-note');
      const btn = document.getElementById('email-oauth-btn');
      if (this.oauthConfigured) {
        help.innerHTML = 'You’ll sign in securely with Microsoft — no password is stored.';
        note.textContent = '';
        btn.disabled = false;
      } else {
        help.innerHTML = '';
        note.innerHTML = 'Microsoft sign-in needs a one-time Azure app registration. <a href="#" data-extlink="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">Open Azure App registrations &#8599;</a> — create one (multitenant + personal accounts, public client, scopes IMAP.AccessAsUser.All + SMTP.Send + offline_access), copy its <b>Application (client) ID</b> into <code>config.js</code> (<code>MS_OAUTH_CLIENT_ID</code>), then restart.';
        const azLink = note.querySelector('[data-extlink]');
        if (azLink) azLink.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(azLink.dataset.extlink); });
        btn.disabled = true;
      }
      return;
    }

    // Password-based providers (Gmail, Yahoo, iCloud, custom).
    oauthBox.classList.add('hidden');
    emailField.classList.remove('hidden');
    passField.classList.remove('hidden');
    saveBtn.classList.remove('hidden');
    if (id === 'custom') {
      custom.classList.remove('hidden');
      guide.classList.add('hidden');
      help.innerHTML = 'Enter your provider’s IMAP and SMTP server settings.';
    } else {
      custom.classList.add('hidden');
      document.getElementById('email-imap-host').value = p.imap.host;
      document.getElementById('email-imap-port').value = p.imap.port;
      document.getElementById('email-imap-secure').checked = p.imap.secure;
      document.getElementById('email-smtp-host').value = p.smtp.host;
      document.getElementById('email-smtp-port').value = p.smtp.port;
      document.getElementById('email-smtp-secure').checked = p.smtp.secure;
      help.innerHTML = 'Use an <b>app password</b>, not your normal password.';
      this._renderGuide(p);
    }
  }

  // Render the in-app, step-by-step app-password walkthrough for a provider.
  _renderGuide(p) {
    const guide = document.getElementById('email-guide');
    if (!p.appPasswordSteps || !p.appPasswordSteps.length) {
      guide.classList.add('hidden');
      guide.innerHTML = '';
      return;
    }
    const steps = p.appPasswordSteps.map(s => `<li>${this._esc(s)}</li>`).join('');
    const openBtn = p.appPasswordUrl
      ? `<button class="email-btn email-btn-ghost email-guide-open" type="button" data-url="${this._esc(p.appPasswordUrl)}">Open ${this._esc(p.label.split(' ')[0])} app passwords &#8599;</button>`
      : '';
    guide.innerHTML = `
      <div class="email-guide-title">How to get your app password</div>
      <ol class="email-guide-steps">${steps}</ol>
      ${openBtn}`;
    guide.classList.remove('hidden');
    const btn = guide.querySelector('.email-guide-open');
    if (btn) btn.addEventListener('click', () => window.api.openExternal(btn.dataset.url));
  }

  async _saveOAuthAccount() {
    const provider = document.getElementById('email-provider').value;
    const name = document.getElementById('email-f-name').value.trim();
    const status = document.getElementById('email-modal-status');
    const btn = document.getElementById('email-oauth-btn');
    status.className = 'email-modal-status';
    status.textContent = 'Opening Microsoft sign-in…';
    btn.disabled = true;
    try {
      await window.api.email.addOAuthAccount({ provider, name, color: '#3B82F6' });
      this._closeModal('email-account-modal');
      this.selection = 'unified';
      await this._loadAccounts();
    } catch (err) {
      status.className = 'email-modal-status email-error';
      status.textContent = 'Sign-in failed: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  _collectAccountConfig() {
    const id = document.getElementById('email-provider').value;
    const email = document.getElementById('email-f-email').value.trim();
    return {
      provider: id,
      name: document.getElementById('email-f-name').value.trim() || email,
      email,
      user: email,
      color: '#3B82F6',
      imap: {
        host: document.getElementById('email-imap-host').value.trim(),
        port: parseInt(document.getElementById('email-imap-port').value, 10),
        secure: document.getElementById('email-imap-secure').checked,
      },
      smtp: {
        host: document.getElementById('email-smtp-host').value.trim(),
        port: parseInt(document.getElementById('email-smtp-port').value, 10),
        secure: document.getElementById('email-smtp-secure').checked,
      },
    };
  }

  async _saveAccount() {
    const cfg = this._collectAccountConfig();
    const pass = document.getElementById('email-f-pass').value;
    const status = document.getElementById('email-modal-status');
    if (!cfg.email || !pass || !cfg.imap.host || !cfg.smtp.host) {
      status.className = 'email-modal-status email-error';
      status.textContent = 'Fill in email, password, and server settings.';
      return;
    }
    status.className = 'email-modal-status';
    status.textContent = 'Testing connection…';
    const btn = document.getElementById('email-save-account');
    btn.disabled = true;
    try {
      await window.api.email.addAccount(cfg, pass);
      this._closeModal('email-account-modal');
      this.selection = 'unified';
      await this._loadAccounts();
    } catch (err) {
      status.className = 'email-modal-status email-error';
      status.textContent = 'Failed: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ── compose ──
  _openCompose(opts = {}) {
    if (this.accounts.length === 0) { alert('Add an account first.'); return; }
    this.composeAttachments = [];
    this._renderComposeAttachments();
    const fromSel = document.getElementById('email-c-from');
    fromSel.innerHTML = this.accounts.map(a => `<option value="${a.id}">${this._esc(a.name || a.email)} &lt;${this._esc(a.email)}&gt;</option>`).join('');
    document.getElementById('email-compose-status').textContent = '';

    const to = document.getElementById('email-c-to');
    const cc = document.getElementById('email-c-cc');
    const subject = document.getElementById('email-c-subject');
    const body = document.getElementById('email-c-body');
    to.value = ''; cc.value = ''; subject.value = ''; body.value = '';
    this._replyContext = null;

    if (opts.msg) {
      if (opts.accountId) fromSel.value = opts.accountId;
      const m = opts.msg;
      const origFrom = m.from ? m.from.address : '';
      if (opts.mode === 'forward') {
        subject.value = 'Fwd: ' + m.subject.replace(/^fwd:\s*/i, '');
        document.getElementById('email-compose-title').textContent = 'Forward message';
        body.value = `\n\n---------- Forwarded message ----------\nFrom: ${origFrom}\nSubject: ${m.subject}\n\n${m.text || ''}`;
      } else {
        subject.value = 'Re: ' + m.subject.replace(/^re:\s*/i, '');
        to.value = origFrom;
        if (opts.mode === 'replyAll') {
          cc.value = (m.to || []).map(t => t.address).filter(a => a && a !== origFrom).join(', ');
        }
        document.getElementById('email-compose-title').textContent = 'Reply';
        body.value = `\n\nOn ${this._fmtDate(m.date, true)}, ${origFrom} wrote:\n> ${(m.text || '').replace(/\n/g, '\n> ')}`;
        this._replyContext = { inReplyTo: m.messageId, references: [...(m.references || []), m.messageId].filter(Boolean) };
      }
    } else {
      document.getElementById('email-compose-title').textContent = 'New message';
    }
    this._showModal('email-compose-modal');
  }

  async _attach() {
    const files = await window.api.openFileDialog().catch(() => []);
    if (files && files.length) {
      this.composeAttachments.push(...files);
      this._renderComposeAttachments();
    }
  }

  _renderComposeAttachments() {
    const el = document.getElementById('email-c-attachments');
    el.innerHTML = this.composeAttachments.map((f, i) =>
      `<span class="email-attach-chip">&#128206; ${this._esc(f.name)} <span class="email-attach-dl" data-rm="${i}">&times;</span></span>`).join('');
    el.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      this.composeAttachments.splice(parseInt(b.dataset.rm, 10), 1);
      this._renderComposeAttachments();
    }));
  }

  async _send() {
    const status = document.getElementById('email-compose-status');
    const to = document.getElementById('email-c-to').value.trim();
    if (!to) { status.className = 'email-modal-status email-error'; status.textContent = 'Add at least one recipient.'; return; }
    const payload = {
      accountId: document.getElementById('email-c-from').value,
      to,
      cc: document.getElementById('email-c-cc').value.trim() || undefined,
      subject: document.getElementById('email-c-subject').value.trim(),
      body: document.getElementById('email-c-body').value,
      inReplyTo: this._replyContext?.inReplyTo,
      references: this._replyContext?.references,
      attachments: this.composeAttachments.map(f => ({ name: f.name, path: f.path })),
    };
    status.className = 'email-modal-status';
    status.textContent = 'Sending…';
    const btn = document.getElementById('email-c-send');
    btn.disabled = true;
    try {
      await window.api.email.sendMessage(payload);
      this._closeModal('email-compose-modal');
    } catch (err) {
      status.className = 'email-modal-status email-error';
      status.textContent = 'Send failed: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ── helpers ──
  _showModal(id) { document.getElementById(id).classList.remove('hidden'); }
  _closeModal(id) { document.getElementById(id).classList.add('hidden'); }

  _fmtDate(d, full) {
    if (!d) return '';
    const date = new Date(d);
    if (isNaN(date)) return '';
    if (full) return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  }

  _fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
}
