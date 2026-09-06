// Email hub view — IMAP/SMTP client UI. Renders into #view-email.
// All network/credential work happens in the main process via window.api.email.*.

// Colour flags map to Thunderbird-compatible IMAP keywords ($Label1..$Label5), so they
// persist server-side and interop with other mail clients.
const EMAIL_LABELS = [
  { key: '$Label1', color: '#EF4444', name: 'Red' },
  { key: '$Label2', color: '#F59E0B', name: 'Orange' },
  { key: '$Label3', color: '#22C55E', name: 'Green' },
  { key: '$Label4', color: '#3B82F6', name: 'Blue' },
  { key: '$Label5', color: '#A855F7', name: 'Purple' },
];
const EMAIL_LABEL_COLOR = (key) => (EMAIL_LABELS.find(l => l.key === key) || {}).color || '';

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
    this.shellBuilt = false;        // whether the 3-pane shell (vs the onboarding screen) is mounted
  }

  // ── lifecycle ──
  async init() {
    this._buildModals();
    this.providers = await window.api.email.listProviders().catch(() => ({}));
    await this._loadAccounts();   // builds the 3-pane shell, or the onboarding screen if no accounts
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
    this.shellBuilt = true;
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
            <button class="email-icon-btn" id="email-rules" title="Mail rules (sender → folder)">&#9776;</button>
            <button class="email-icon-btn" id="email-refresh" title="Refresh">&#10227;</button>
          </div>
          <div class="email-list" id="email-list"></div>
        </section>
        <section class="email-read-pane" id="email-read">${this._placeholderHtml('Select a message to read')}</section>
      </div>`;

    root.querySelector('#email-compose').addEventListener('click', () => this._openCompose());
    root.querySelector('#email-add-account').addEventListener('click', () => this._openAccountModal());
    root.querySelector('#email-refresh').addEventListener('click', () => this._refreshList());
    root.querySelector('#email-rules').addEventListener('click', () => this._openRulesManager());
    const search = root.querySelector('#email-search');
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._search(search.value.trim()); });
  }

  // ── accounts / nav ──
  async _loadAccounts() {
    this.accounts = await window.api.email.listAccounts().catch(() => []);
    if (this.accounts.length === 0) { this._renderEmptyState(); return; }
    if (!this.shellBuilt) this._buildShell();   // coming back from the onboarding screen
    this._renderNav();
    if (this.selection !== 'unified' && !this.accounts.find(a => a.id === this.selection)) {
      this.selection = 'unified';
    }
    this._loadMessages();
  }

  // Full-panel onboarding shown when no accounts are connected (replaces the old
  // cramped placeholder wedged into the narrow list column).
  _renderEmptyState() {
    this.shellBuilt = false;
    const root = document.getElementById('view-email');
    root.innerHTML = `
      <div class="email-onboard">
        <div class="email-onboard-card">
          <div class="email-onboard-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/>
              <path d="M3 6l9 6.5L21 6"/>
            </svg>
          </div>
          <h2 class="email-onboard-title">Connect your email</h2>
          <p class="email-onboard-sub">Read, search, and send mail without leaving EngOrg — with Gmail, Outlook / Microsoft&nbsp;365, or any IMAP mailbox.</p>
          <button class="email-onboard-btn" id="email-onboard-add">&#43;&nbsp; Add an account</button>
          <div class="email-onboard-providers">
            <span class="email-onboard-provider">Gmail</span>
            <span class="email-onboard-provider">Outlook</span>
            <span class="email-onboard-provider">Microsoft 365</span>
            <span class="email-onboard-provider">IMAP</span>
          </div>
          <p class="email-onboard-hint">Gmail &amp; Outlook use an <b>app password</b> (or Microsoft sign-in) — never your normal password.</p>
        </div>
      </div>`;
    root.querySelector('#email-onboard-add').addEventListener('click', () => this._openAccountModal());
  }

  _renderNav() {
    const nav = document.getElementById('email-nav');
    let html = '';
    if (this.accounts.length > 1) {
      html += `<div class="email-nav-item ${this.selection === 'unified' ? 'active' : ''}" data-sel="unified">
        <span class="email-nav-dot" style="background:linear-gradient(135deg,#3B82F6,#8B5CF6)"></span>All Inboxes</div>`;
    }
    this._logoCache = this._logoCache || {};
    for (const a of this.accounts) {
      const active = this.selection === a.id;
      const domain = (a.email || '').split('@')[1] || '';
      // A domain logo we've already resolved is inlined immediately (no flicker on
      // re-render); otherwise show the colour dot and fetch the logo async below.
      const cached = domain ? this._logoCache[domain] : null;
      // Note: use background-color (NOT the `background` shorthand) — the shorthand resets
      // background-size to auto inline, which would override the stylesheet's `cover` and
      // make the favicon paint at its natural size.
      const icStyle = cached
        ? `background-image:url("${cached}");background-color:transparent;background-size:cover`
        : `background-color:${this._esc(a.color)}`;
      html += `<div class="email-account">
        <div class="email-nav-item email-account-head ${active ? 'active' : ''}" data-sel="${a.id}">
          <span class="email-nav-dot email-acct-ic${cached ? ' has-logo' : ''}" data-logo-domain="${this._esc(domain)}" style="${icStyle}"></span>
          <span class="email-account-name" title="${this._esc(a.email)}">${this._esc(a.name || a.email)}</span>
          <button class="email-acct-remove" data-remove="${a.id}" title="Remove account">&times;</button>
        </div>
        <div class="email-folders" data-folders="${a.id}">${active ? this._renderFolders(a.id) : ''}</div>
      </div>`;
    }
    nav.innerHTML = html;
    this._decorateAccountLogos();

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

  // Lazily resolve each account's domain logo (once per domain) and paint it onto the
  // account icon. Cached on the instance so re-renders apply synchronously; a null result
  // (no logo available) is remembered too so we don't refetch, and the colour dot stays.
  async _decorateAccountLogos() {
    this._logoCache = this._logoCache || {};
    const domains = [...new Set(this.accounts.map(a => (a.email || '').split('@')[1] || '').filter(Boolean))];
    for (const domain of domains) {
      if (this._logoCache[domain] === undefined) {
        this._logoCache[domain] = await window.api.email.fetchLogo(domain).catch(() => null);
      }
      const url = this._logoCache[domain];
      if (!url) continue;
      // Re-query live nodes each time; an interleaved re-render may have replaced them.
      document.querySelectorAll(`#email-nav .email-acct-ic[data-logo-domain="${CSS.escape(domain)}"]`).forEach(el => {
        el.style.backgroundImage = `url("${url}")`;
        el.style.backgroundColor = 'transparent';
        el.style.backgroundSize = 'cover'; // explicit, in case an inline shorthand reset it
        el.classList.add('has-logo');
      });
    }
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
      this._applyRules().catch(() => {}); // move rule-matched senders out of the inbox
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
    listEl.innerHTML = this.messages.map(m => {
      const open = this.openMsg && this.openMsg.accountId === m.accountId && this.openMsg.uid === m.uid && this.openMsg.folder === m.folder;
      const who = m.from ? (m.from.name || m.from.address) : '(unknown)';
      const acctTag = (this.selection === 'unified' && m.accountColor)
        ? `<span class="email-list-acct" style="background:${this._esc(m.accountColor)}"></span>` : '';
      const initial = this._avatarInitial(m.from && m.from.name, m.from && m.from.address);
      const avColor = this._avatarColor((m.from && (m.from.address || m.from.name)) || who);
      const markers = `${m.flagged ? '<span class="email-mark-flag">&#11088;</span> ' : ''}${m.answered ? '<span class="email-mark-answered" title="Replied">&#8617;</span> ' : ''}`;
      const labelColor = m.label ? EMAIL_LABEL_COLOR(m.label) : '';
      return `<div class="email-list-item ${m.seen ? '' : 'unread'} ${open ? 'open' : ''}"
                   data-acct="${this._esc(m.accountId)}" data-folder="${this._esc(m.folder)}" data-uid="${m.uid}"
                   ${labelColor ? `style="box-shadow: inset 3px 0 0 ${labelColor}"` : ''}>
        ${acctTag}
        <div class="email-avatar" style="background:${avColor}">${this._esc(initial)}</div>
        <div class="email-list-main">
          <div class="email-list-row1">
            <span class="email-list-from">${this._esc(who)}</span>
            <span class="email-list-date">${this._fmtDate(m.date)}</span>
          </div>
          <div class="email-list-subject">${markers}${this._esc(m.subject)}</div>
        </div>
        ${m.seen ? '' : '<span class="email-unread-dot" title="Unread"></span>'}
      </div>`;
    }).join('');

    listEl.querySelectorAll('.email-list-item').forEach(el => {
      el.addEventListener('click', () => this._open(el.dataset.acct, el.dataset.folder, parseInt(el.dataset.uid, 10)));
    });
  }

  // Deterministic avatar for a sender: first letter + a colour hashed from the address.
  _avatarInitial(name, address) {
    const src = String(name || address || '?').trim();
    const ch = src.replace(/[^A-Za-z0-9]/g, '').charAt(0);
    return (ch || '?').toUpperCase();
  }
  _avatarColor(seed) {
    const palette = ['#3B82F6', '#8B5CF6', '#EC4899', '#F97316', '#0EA5E9', '#22C55E', '#14B8A6', '#6366F1', '#F43F5E', '#EAB308'];
    const s = String(seed || '?');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
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
    this.loadImages = true;   // images load by default now; a toggle can block them
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
    this.openMsgData = msg;   // kept so action toggles (flag/images) can re-render in place
    const fromName = msg.from ? (msg.from.name || msg.from.address) : '(unknown)';
    const fromAddr = msg.from ? msg.from.address : '';
    const toLine = msg.to.map(t => this._esc(t.name || t.address)).join(', ');
    const listItem = this.messages.find(m => m.accountId === accountId && m.uid === uid && m.folder === folder);
    const isFlagged = !!(listItem && listItem.flagged);
    const curLabel = (listItem && listItem.label) || msg.label || null;
    const labelPicker = `<span class="email-label-picker" title="Colour flag">
      ${EMAIL_LABELS.map(l => `<button class="email-label-swatch ${curLabel === l.key ? 'active' : ''}" data-label="${l.key}" style="background:${l.color}" title="${l.name} flag"></button>`).join('')}
      <button class="email-label-swatch email-label-none ${!curLabel ? 'active' : ''}" data-label="" title="No flag">&times;</button>
    </span>`;
    const folders = this.foldersByAccount[accountId] || [];
    const archiveFolder = (folders.find(f => f.specialUse === '\\Archive') || {}).path;

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
          <button class="email-btn ${isFlagged ? 'email-btn-active' : ''}" data-act="flag">${isFlagged ? '&#11088; Flagged' : '&#9734; Flag'}</button>
          <button class="email-btn" data-act="unread">&#9993; Mark unread</button>
          ${archiveFolder ? `<button class="email-btn" data-act="archive">&#128230; Archive</button>` : ''}
          <button class="email-btn" data-act="rule" title="Always move mail from this sender to a folder">&#9202; Rule…</button>
          <button class="email-btn email-btn-danger" data-act="delete">&#128465; Delete</button>
          ${msg.html ? `<button class="email-btn email-btn-ghost" data-act="images">${this.loadImages ? 'Block images' : 'Load images'}</button>` : ''}
          ${labelPicker}
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
        else if (act === 'flag') this._toggleFlag(accountId, folder, uid);
        else if (act === 'unread') this._markUnread(accountId, folder, uid);
        else if (act === 'archive') this._archiveOpen(accountId, folder, uid, archiveFolder);
        else if (act === 'rule') this._openRuleForSender(accountId, msg);
        else if (act === 'images') { this.loadImages = !this.loadImages; this._renderMessage(msg, accountId, folder, uid); }
      });
    });
    pane.querySelectorAll('.email-label-swatch').forEach(sw => {
      sw.addEventListener('click', () => this._setLabel(accountId, folder, uid, sw.dataset.label));
    });
    pane.querySelectorAll('.email-attach-chip').forEach(chip => {
      chip.addEventListener('click', async (e) => {
        if (chip.classList.contains('loading')) return;      // ignore double-clicks while busy
        const idx = parseInt(chip.dataset.att, 10);
        const save = e.target.closest('[data-dl]');
        // Immediate visual feedback — the fetch/decode can take a couple of seconds and
        // otherwise the click feels like it did nothing.
        chip.classList.add('loading');
        chip.dataset.busy = save ? 'Saving…' : 'Opening…';
        try {
          const r = await window.api.email.saveAttachment(accountId, folder, uid, idx, !save);
          if (r && r.canceled) { /* user dismissed the Save dialog */ }
        } catch (err) {
          alert('Attachment failed: ' + err.message);
        } finally {
          chip.classList.remove('loading');
          delete chip.dataset.busy;
        }
      });
    });
  }

  // Build the sandboxed document. A CSP meta blocks remote images until the user opts in.
  // The message is repainted in the app theme (user preference): we pull the live theme
  // colours from the app, repaint the surface + text, and neutralise senders' own (usually
  // white) backgrounds so the body blends with the app instead of a white block. Some
  // heavily-designed HTML emails will therefore look plainer — an accepted trade-off.
  _buildBodyDoc(msg) {
    const imgPolicy = this.loadImages ? 'img-src data: cid: https: http:' : 'img-src data: cid:';
    const csp = `default-src 'none'; style-src 'unsafe-inline'; ${imgPolicy};`;
    const body = msg.html || msg.textAsHtml || `<pre>${this._esc(msg.text)}</pre>`;
    // Read the *actual rendered* theme colours off the live pane instead of guessing CSS
    // variable names (those may be defined on an inner wrapper, so reading them from an
    // arbitrary element returns empty and we'd fall back to white-on-white). `color` is
    // always concrete; for the surface we walk up to the first element with an opaque
    // background so a transparent pane doesn't defeat us.
    const readEl = document.getElementById('email-read') || document.body;
    const csRead = getComputedStyle(readEl);
    const isTransparent = (c) => !c || c === 'transparent' || /,\s*0\)\s*$/.test(c);
    const opaqueBg = (el) => { while (el) { const c = getComputedStyle(el).backgroundColor; if (!isTransparent(c)) return c; el = el.parentElement; } return ''; };
    const fg = csRead.color || '#e2e8f0';
    const bg = opaqueBg(readEl) || '#0f172a';
    const v = (name, fb) => ((csRead.getPropertyValue(name) || '').trim() || fb);
    const link = v('--accent-text', v('--accent', '#60a5fa'));
    const border = v('--border-color', 'rgba(148,163,184,0.35)');
    return `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <style>
        html,body{margin:0;padding:14px;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:${fg} !important;background:${bg} !important;word-wrap:break-word;}
        /* Force app theme: drop senders' own backgrounds and inherit the theme text colour
           so no white boxes remain; re-tint links, borders, quotes. */
        *{background-color:transparent !important;background-image:none !important;color:inherit !important;border-color:${border} !important;}
        a,a *{color:${link} !important;text-decoration:underline;}
        img{max-width:100%;height:auto;}
        pre{white-space:pre-wrap;font:inherit;}
        table{max-width:100%;border-collapse:collapse;}
        blockquote{border-left:3px solid ${border};margin:.5em 0;padding-left:10px;opacity:.9;}
        hr{border:0;border-top:1px solid ${border};}
      </style></head><body>${body}</body></html>`;
  }

  async _deleteOpen(accountId, folder, uid) {
    try {
      await window.api.email.deleteMessage(accountId, folder, uid);
      this.openMsg = null; this.openMsgData = null;
      document.getElementById('email-read').innerHTML = this._placeholderHtml('Message deleted');
      this._loadMessages();
    } catch (err) { alert('Delete failed: ' + err.message); }
  }

  // Star / unstar the open message and reflect it in the list + button.
  async _toggleFlag(accountId, folder, uid) {
    const item = this.messages.find(m => m.accountId === accountId && m.uid === uid && m.folder === folder);
    const add = !(item && item.flagged);
    try { await window.api.email.setFlags(accountId, folder, uid, ['\\Flagged'], add); }
    catch (err) { alert('Flag failed: ' + err.message); return; }
    if (item) item.flagged = add;
    this._renderList();
    if (this.openMsgData) this._renderMessage(this.openMsgData, accountId, folder, uid);
  }

  // Set (or clear, key='') the colour flag on a message — one $LabelN keyword at a time.
  async _setLabel(accountId, folder, uid, key) {
    const item = this.messages.find(m => m.accountId === accountId && m.uid === uid && m.folder === folder);
    try {
      const others = EMAIL_LABELS.map(l => l.key).filter(k => k !== key);
      if (others.length) await window.api.email.setFlags(accountId, folder, uid, others, false);
      if (key) await window.api.email.setFlags(accountId, folder, uid, [key], true);
    } catch (err) { alert('Flag failed: ' + err.message); return; }
    if (item) item.label = key || null;
    if (this.openMsgData) this.openMsgData.label = key || null;
    this._renderList();
    if (this.openMsgData) this._renderMessage(this.openMsgData, accountId, folder, uid);
  }

  // ── rules (sender → folder) ──
  // Stored in app settings so they persist (and sync). Each rule: { id, accountId, from, target }.
  _getRules() {
    const dm = (typeof dataManager !== 'undefined') ? dataManager : null;
    return (dm && Array.isArray(dm.settings.emailRules)) ? dm.settings.emailRules : [];
  }
  async _saveRules(rules) {
    const dm = (typeof dataManager !== 'undefined') ? dataManager : null;
    if (dm) await dm.updateSettings({ emailRules: rules });
  }

  // Build a rule from the open message's sender, then apply it to the current inbox.
  async _openRuleForSender(accountId, msg) {
    const sender = msg.from ? (msg.from.address || '').toLowerCase() : '';
    if (!sender) { alert('This message has no sender address.'); return; }
    let folders = this.foldersByAccount[accountId];
    if (!folders) { await this._loadFolders(accountId); folders = this.foldersByAccount[accountId] || []; }
    const choices = folders.filter(f => f.path && f.path !== 'INBOX').map(f => ({ value: f.path, label: f.name || f.path }));
    if (!choices.length) { alert('No destination folders found. Create a folder in your mailbox first.'); return; }
    const target = await this._promptSelect('Always move this sender to…', choices, `From: ${sender}`);
    if (!target) return;
    const rules = this._getRules().slice();
    // Replace any existing rule for the same sender+account.
    const idx = rules.findIndex(r => r.from === sender && (r.accountId || accountId) === accountId);
    const rule = { id: 'rule_' + Date.now(), accountId, from: sender, target };
    if (idx >= 0) rules[idx] = rule; else rules.push(rule);
    await this._saveRules(rules);
    const n = await this._applyRules(true);
    this._toast(n ? `Rule saved · moved ${n} message${n > 1 ? 's' : ''}.` : 'Rule saved.');
  }

  // Move any currently-listed inbox messages that match a rule into their target folder.
  // Only runs for a specific account's INBOX (not the unified view or other folders).
  async _applyRules(force) {
    if (this.selection === 'unified' || this.folder !== 'INBOX') return 0;
    const rules = this._getRules().filter(r => !r.accountId || r.accountId === this.selection);
    if (!rules.length) return 0;
    const moved = [];
    for (const m of this.messages.slice()) {
      const from = (m.from && m.from.address || '').toLowerCase();
      if (!from) continue;
      const rule = rules.find(r => from === r.from || (r.from.indexOf('@') === -1 && from.endsWith('@' + r.from)));
      if (!rule || rule.target === m.folder) continue;
      try {
        await window.api.email.move(this.selection, m.folder, m.uid, rule.target);
        moved.push(m);
      } catch (e) { console.warn('[email] rule move failed:', e.message); }
    }
    if (moved.length) {
      this.messages = this.messages.filter(m => !moved.includes(m));
      this._renderList();
    }
    return moved.length;
  }

  _openRulesManager() {
    const rules = this._getRules();
    const acctName = (id) => { const a = this.accounts.find(x => x.id === id); return a ? (a.name || a.email) : 'Any account'; };
    const ov = document.createElement('div');
    ov.className = 'modal email-prompt-modal';
    ov.innerHTML = `<div class="modal-box email-rules-box">
      <h3 class="email-modal-title">Mail rules</h3>
      <p class="email-rules-sub">Mail from these senders is moved to its folder when you open or refresh that inbox.</p>
      <div class="email-rules-list">${rules.length ? rules.map(r => `
        <div class="email-rule-row">
          <span class="email-rule-from">${this._esc(r.from)}</span>
          <span class="email-rule-arrow">&#8594;</span>
          <span class="email-rule-target">${this._esc(r.target)}</span>
          <span class="email-rule-acct">${this._esc(acctName(r.accountId))}</span>
          <button class="email-btn email-btn-danger email-rule-del" data-del="${r.id}">Delete</button>
        </div>`).join('') : '<div class="email-rules-empty">No rules yet. Open a message and click “Rule…” to add one.</div>'}</div>
      <div class="email-modal-actions"><span style="flex:1"></span><button class="email-btn email-btn-ghost" data-x="close">Close</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('[data-x="close"]').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.querySelectorAll('.email-rule-del').forEach(b => b.addEventListener('click', async () => {
      await this._saveRules(this._getRules().filter(r => r.id !== b.dataset.del));
      close(); this._openRulesManager();
    }));
  }

  // Themed single-select prompt (returns the chosen value or null).
  _promptSelect(title, options, subtitle = '') {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal email-prompt-modal';
      ov.innerHTML = `<div class="modal-box email-prompt-box">
        <h3 class="email-modal-title">${this._esc(title)}</h3>
        ${subtitle ? `<p class="email-rules-sub">${this._esc(subtitle)}</p>` : ''}
        <select class="email-prompt-input">${options.map(o => `<option value="${this._esc(o.value)}">${this._esc(o.label)}</option>`).join('')}</select>
        <div class="email-modal-actions"><span style="flex:1"></span>
          <button class="email-btn email-btn-ghost" data-x="cancel">Cancel</button>
          <button class="email-btn email-btn-primary" data-x="ok">OK</button></div>
      </div>`;
      document.body.appendChild(ov);
      const sel = ov.querySelector('select');
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('[data-x="cancel"]').addEventListener('click', () => done(null));
      ov.querySelector('[data-x="ok"]').addEventListener('click', () => done(sel.value || null));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
      setTimeout(() => sel.focus(), 30);
    });
  }

  _toast(text) {
    const t = document.createElement('div');
    t.className = 'email-toast';
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  // Mark the open message unread again (it was marked seen when opened).
  async _markUnread(accountId, folder, uid) {
    try { await window.api.email.setFlags(accountId, folder, uid, ['\\Seen'], false); }
    catch (err) { alert('Failed: ' + err.message); return; }
    const item = this.messages.find(m => m.accountId === accountId && m.uid === uid && m.folder === folder);
    if (item) item.seen = false;
    this._renderList();
  }

  // Move the open message to the account's Archive folder.
  async _archiveOpen(accountId, folder, uid, target) {
    if (!target) { alert('This account has no Archive folder.'); return; }
    try { await window.api.email.move(accountId, folder, uid, target); }
    catch (err) { alert('Archive failed: ' + err.message); return; }
    this.openMsg = null; this.openMsgData = null;
    document.getElementById('email-read').innerHTML = this._placeholderHtml('Message archived');
    this._loadMessages();
  }

  _placeholderHtml(text) {
    return `<div class="email-read-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 6h16M4 12h16M4 18h10"/>
      </svg>
      <div class="email-read-placeholder-text">${this._esc(text)}</div>
    </div>`;
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
          <div class="email-c-toolbar" id="email-c-toolbar">
            <button type="button" class="email-c-tool" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
            <button type="button" class="email-c-tool" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
            <button type="button" class="email-c-tool" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
            <button type="button" class="email-c-tool" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
            <span class="email-c-sep"></span>
            <button type="button" class="email-c-tool" data-cmd="formatBlock" data-val="h3" title="Heading">H</button>
            <button type="button" class="email-c-tool" data-cmd="formatBlock" data-val="blockquote" title="Quote">&#10078;</button>
            <button type="button" class="email-c-tool" data-cmd="insertUnorderedList" title="Bulleted list">&#8226;</button>
            <button type="button" class="email-c-tool" data-cmd="insertOrderedList" title="Numbered list">1.</button>
            <span class="email-c-sep"></span>
            <button type="button" class="email-c-tool" data-cmd="justifyLeft" title="Align left">&#8676;</button>
            <button type="button" class="email-c-tool" data-cmd="justifyCenter" title="Align center">&#8596;</button>
            <span class="email-c-sep"></span>
            <button type="button" class="email-c-tool" data-cmd="createLink" title="Insert link">&#128279;</button>
            <label class="email-c-tool email-c-color" title="Text colour">A<span class="email-c-bar" style="background:#2563eb"></span><input type="color" id="email-c-fore" value="#2563eb"></label>
            <label class="email-c-tool email-c-color" title="Highlight">&#9639;<span class="email-c-bar" style="background:#ffe066"></span><input type="color" id="email-c-back" value="#ffe066"></label>
            <span class="email-c-sep"></span>
            <button type="button" class="email-c-tool" data-cmd="removeFormat" title="Clear formatting">&#10006;</button>
          </div>
          <div id="email-c-body" class="email-c-body" contenteditable="true" data-placeholder="Write your message…"></div>
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

    // Rich-text toolbar. mousedown-preventDefault keeps the editor selection while the
    // button is clicked; foreColor/hiliteColor come from the two colour inputs.
    const toolbar = document.getElementById('email-c-toolbar');
    toolbar.querySelectorAll('.email-c-tool[data-cmd]').forEach(b => {
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this._execCmd(b.dataset.cmd, b.dataset.val));
    });
    toolbar.querySelectorAll('.email-c-color').forEach(l => l.addEventListener('mousedown', () => {
      // Opening the native colour picker steals focus, so snapshot the selection first.
      this._saveEditorRange();
    }));
    const fore = document.getElementById('email-c-fore');
    const back = document.getElementById('email-c-back');
    fore.addEventListener('input', (e) => { fore.previousElementSibling.style.background = e.target.value; this._applyColor('foreColor', e.target.value); });
    back.addEventListener('input', (e) => { back.previousElementSibling.style.background = e.target.value; this._applyColor('hiliteColor', e.target.value); });
  }

  // Save/restore the caret/selection inside the compose editor so opening a colour picker
  // or link dialog (which moves focus) doesn't lose where formatting should apply.
  _saveEditorRange() {
    const sel = window.getSelection();
    const editor = document.getElementById('email-c-body');
    if (sel && sel.rangeCount && editor && editor.contains(sel.anchorNode)) this._editorRange = sel.getRangeAt(0);
  }
  _restoreEditorRange() {
    const editor = document.getElementById('email-c-body');
    editor.focus();
    if (this._editorRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(this._editorRange);
    }
  }

  async _execCmd(cmd, val) {
    const editor = document.getElementById('email-c-body');
    if (cmd === 'createLink') {
      // The prompt modal moves focus, so save the selection and put it back after.
      this._saveEditorRange();
      const url = await this._promptText('Insert link', 'https://…');
      this._restoreEditorRange();
      if (!url) return;
      document.execCommand('createLink', false, url);
      return;
    }
    // Toolbar buttons preventDefault on mousedown, so the live selection is still intact —
    // just refocus (without clobbering it with a stale saved range) and run the command.
    editor.focus();
    try { document.execCommand(cmd, false, val || null); } catch {}
  }

  // Colour commands come from the native picker, which stole focus — restore the saved range.
  _applyColor(cmd, val) {
    this._restoreEditorRange();
    try { document.execCommand(cmd, false, val); } catch {}
  }

  // Themed one-field text prompt (window.prompt is a no-op in Electron). Resolves the
  // trimmed value, or null on cancel/empty.
  _promptText(title, placeholder = '', value = '') {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal email-prompt-modal';
      ov.innerHTML = `<div class="modal-box email-prompt-box">
        <h3 class="email-modal-title">${this._esc(title)}</h3>
        <input class="email-prompt-input" type="text" placeholder="${this._esc(placeholder)}" value="${this._esc(value)}">
        <div class="email-modal-actions">
          <span style="flex:1"></span>
          <button class="email-btn email-btn-ghost" data-x="cancel">Cancel</button>
          <button class="email-btn email-btn-primary" data-x="ok">OK</button>
        </div></div>`;
      document.body.appendChild(ov);
      const input = ov.querySelector('.email-prompt-input');
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('[data-x="cancel"]').addEventListener('click', () => done(null));
      ov.querySelector('[data-x="ok"]').addEventListener('click', () => done(input.value.trim() || null));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim() || null); else if (e.key === 'Escape') done(null); });
      setTimeout(() => input.focus(), 30);
    });
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
    to.value = ''; cc.value = ''; subject.value = ''; body.innerHTML = '';
    this._replyContext = null;
    this._editorRange = null;
    const quote = (m) => `<blockquote class="email-quote">${this._esc(m.text || '').replace(/\n/g, '<br>') || '&nbsp;'}</blockquote>`;

    if (opts.msg) {
      if (opts.accountId) fromSel.value = opts.accountId;
      const m = opts.msg;
      const origFrom = m.from ? m.from.address : '';
      if (opts.mode === 'forward') {
        subject.value = 'Fwd: ' + m.subject.replace(/^fwd:\s*/i, '');
        document.getElementById('email-compose-title').textContent = 'Forward message';
        body.innerHTML = `<p><br></p><div class="email-quote-head">---------- Forwarded message ----------<br>From: ${this._esc(origFrom)}<br>Subject: ${this._esc(m.subject)}</div>${quote(m)}`;
      } else {
        subject.value = 'Re: ' + m.subject.replace(/^re:\s*/i, '');
        to.value = origFrom;
        if (opts.mode === 'replyAll') {
          cc.value = (m.to || []).map(t => t.address).filter(a => a && a !== origFrom).join(', ');
        }
        document.getElementById('email-compose-title').textContent = 'Reply';
        body.innerHTML = `<p><br></p><div class="email-quote-head">On ${this._esc(this._fmtDate(m.date, true))}, ${this._esc(origFrom)} wrote:</div>${quote(m)}`;
        this._replyContext = { inReplyTo: m.messageId, references: [...(m.references || []), m.messageId].filter(Boolean) };
      }
    } else {
      document.getElementById('email-compose-title').textContent = 'New message';
    }
    this._showModal('email-compose-modal');
    // Put the caret at the very top so the user types above any quoted content.
    setTimeout(() => { body.focus(); const sel = window.getSelection(); sel.selectAllChildren(body); sel.collapseToStart(); }, 30);
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
    const editor = document.getElementById('email-c-body');
    const html = editor.innerHTML;
    const payload = {
      accountId: document.getElementById('email-c-from').value,
      to,
      cc: document.getElementById('email-c-cc').value.trim() || undefined,
      subject: document.getElementById('email-c-subject').value.trim(),
      body: editor.innerText,                     // plain-text fallback part
      html: `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">${html}</div>`,
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
