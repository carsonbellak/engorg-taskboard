// Share utility (Engineering Utilities) — send links, notes and files between your own
// devices (this PC, other PCs, the PWA on your phone). Mirrored in pwa/app.js (SHARE VIEW).
//
// Transport is Firestore, under the path the existing rules already allow for the
// signed-in user (users/{uid}/data/{document=**}), so nothing needs deploying:
//   users/{uid}/data/shares/items/{id}             one doc per shared item
//   users/{uid}/data/shares/items/{id}/chunks/{n}  file bytes as ≤900 KB Firestore Blobs
// Items: { kind: 'link' | 'text' | 'file', text, name, mime, size, chunks, thumb (small JPEG
// data URL for images), from (device label), fromId, fromPlatform, createdMs, ready }.
// A file's item is written first with ready:false, then its chunks, then ready:true, so other
// devices show "Uploading…" and never fetch a half-written file. Items expire after TTL_DAYS;
// whichever device is open sweeps them (chunks first — deleting a doc leaves its subcollection).
// The listener runs app-wide (start(), from app.js) so incoming items pop a card + badge even
// while the utility is closed.

const shareView = (() => {
  const CHUNK = 900 * 1024;
  const MAX_FILE = 25 * 1024 * 1024;
  const MAX_TEXT = 200000;           // longer text goes as a .txt file (1 MB doc limit)
  const TTL_DAYS = 7;
  const LIMIT = 60;
  const POOL = 3;                    // chunk uploads/downloads in flight at once
  const LS_NAME = 'engorg_share_device', LS_ID = 'engorg_share_device_id', LS_SEEN = 'engorg_share_seen';

  let items = [], unsub = null, started = false, notify = false, active = false, container = null;
  let listenSince = 0, swept = false, status = null, statusT = null, filter = 'all', newSince = 0;
  const progress = new Map();        // id → { done, total, dir: 'up' | 'down' }
  const savedPaths = new Map();      // id → local path once saved into Downloads (this session)
  const announced = new Set();

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const isUrl = (s) => /^https?:\/\/\S+$/i.test(s);

  // Line icons (stroke = currentColor) so tiles and buttons pick up the theme.
  const svg = (d, w = 18) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const IC = {
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
    note: '<path d="M5 4h14v16H5z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    clip: '<path d="M20.5 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.7a1.7 1.7 0 0 1-2.4-2.4L15 7.6"/>',
    send: '<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    open: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    inbox: '<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
  };

  function deviceId() {
    let id = localStorage.getItem(LS_ID);
    if (!id) { id = 'dev_' + Math.random().toString(36).slice(2, 10); localStorage.setItem(LS_ID, id); }
    return id;
  }
  let deviceName = localStorage.getItem(LS_NAME) || '';
  if (!deviceName && window.api && window.api.share) {
    window.api.share.deviceName().then(n => { if (!localStorage.getItem(LS_NAME)) { deviceName = n || 'PC'; if (active) render(); } }).catch(() => {});
  }
  const myName = () => deviceName || 'PC';

  const signedIn = () => typeof firebaseSync !== 'undefined' && !!firebaseSync.user && !!firebaseSync.db;
  const col = () => firebaseSync.db.collection('users').doc(firebaseSync.user.uid).collection('data').doc('shares').collection('items');
  const chunkId = (i) => String(i).padStart(4, '0');
  const newId = () => 'shr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtAgo(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function dayLabel(ms) {
    const d = new Date(ms), t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function setStatus(msg, kind) {
    status = msg ? { msg, kind: kind || 'info' } : null;
    clearTimeout(statusT);
    if (msg) statusT = setTimeout(() => { status = null; renderStatus(); }, 5000);
    renderStatus();
  }

  // Run fn(i) for i in [0, n) with at most POOL in flight.
  async function pool(n, fn) {
    let next = 0;
    const worker = async () => { while (next < n) { const i = next++; await fn(i); } };
    await Promise.all(Array.from({ length: Math.min(POOL, n) }, worker));
  }

  // ---- Sending -------------------------------------------------------------
  function meta() {
    return { from: myName(), fromId: deviceId(), fromPlatform: 'desktop', createdMs: Date.now(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp() };
  }

  async function sendText(text) {
    text = String(text || '').trim();
    if (!text || !signedIn()) return false;
    if (text.length > MAX_TEXT) {
      return sendFile(new File([text], 'shared-text.txt', { type: 'text/plain' }));
    }
    try {
      await col().doc(newId()).set({ kind: isUrl(text) ? 'link' : 'text', text, ready: true, ...meta() });
      setStatus(isUrl(text) ? 'Link sent to your devices.' : 'Note sent to your devices.', 'success');
      return true;
    } catch (e) { setStatus('Couldn’t send: ' + (e.message || e), 'error'); return false; }
  }

  // Small JPEG preview for images, so other devices can show it without downloading.
  async function makeThumb(file) {
    if (!/^image\//.test(file.type || '') || file.size > 30 * 1024 * 1024) return null;
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return c.toDataURL('image/jpeg', 0.7);
    } catch (e) { return null; }
  }

  async function sendFile(file) {
    if (!signedIn()) return false;
    if (file.size > MAX_FILE) { setStatus(`${file.name} is ${fmtSize(file.size)}. The limit is ${fmtSize(MAX_FILE)}.`, 'error'); return false; }
    const id = newId();
    const ref = col().doc(id);
    const total = Math.max(1, Math.ceil(file.size / CHUNK));
    try {
      const thumb = await makeThumb(file);
      await ref.set({ kind: 'file', name: file.name || 'file', mime: file.type || '', size: file.size,
        chunks: total, thumb: thumb || null, ready: false, ...meta() });
      progress.set(id, { done: 0, total, dir: 'up' }); renderList();
      const buf = new Uint8Array(await file.arrayBuffer());
      await pool(total, async (i) => {
        await ref.collection('chunks').doc(chunkId(i))
          .set({ i, data: firebase.firestore.Blob.fromUint8Array(buf.subarray(i * CHUNK, (i + 1) * CHUNK)) });
        const p = progress.get(id); if (p) { p.done++; renderRow(id); }
      });
      await ref.update({ ready: true });
      progress.delete(id); renderRow(id);
      setStatus(`Sent ${file.name}.`, 'success');
      return true;
    } catch (e) {
      progress.delete(id);
      setStatus(`Couldn’t send ${file.name}: ${e.message || e}`, 'error');
      removeItem(id).catch(() => {});
      return false;
    }
  }

  async function sendFiles(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    if (!signedIn()) { setStatus('Sign in to cloud sync first.', 'error'); return; }
    for (const f of files) await sendFile(f);
  }

  // ---- Receiving -----------------------------------------------------------
  async function fetchBytes(item) {
    if (!item.ready) throw new Error('Still uploading from the other device.');
    const ref = col().doc(item.id);
    const parts = new Array(item.chunks);
    progress.set(item.id, { done: 0, total: item.chunks, dir: 'down' }); renderRow(item.id);
    try {
      await pool(item.chunks, async (i) => {
        const d = await ref.collection('chunks').doc(chunkId(i)).get();
        if (!d.exists) throw new Error('The file is incomplete. Share it again.');
        parts[i] = d.data().data.toUint8Array();
        const p = progress.get(item.id); if (p) { p.done++; renderRow(item.id); }
      });
    } finally { progress.delete(item.id); renderRow(item.id); }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  // Save into Downloads once per session; later clicks reuse the saved copy.
  async function saveLocal(item) {
    if (savedPaths.has(item.id)) return savedPaths.get(item.id);
    const bytes = await fetchBytes(item);
    const res = await window.api.share.saveDownload(bytes, item.name);
    if (!res || res.error) throw new Error((res && res.error) || 'Save failed');
    savedPaths.set(item.id, res.path);
    renderRow(item.id);
    return res.path;
  }

  async function removeItem(id) {
    const ref = col().doc(id);
    const chunks = await ref.collection('chunks').get();
    const batch = firebaseSync.db.batch();
    chunks.docs.forEach(d => batch.delete(d.ref));
    batch.delete(ref);
    await batch.commit();
  }

  async function sweep() {
    if (swept) return; swept = true;
    try {
      const old = await col().where('createdMs', '<', Date.now() - TTL_DAYS * 86400000).get();
      for (const d of old.docs) await removeItem(d.id).catch(() => {});
    } catch (e) { console.warn('Share sweep:', e && e.code); }
  }

  // ---- Listener ------------------------------------------------------------
  function attach() {
    detach();
    if (!signedIn()) { items = []; refreshBadge(); if (active) render(); return; }
    listenSince = Date.now();
    unsub = col().orderBy('createdMs', 'desc').limit(LIMIT).onSnapshot((snap) => {
      items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      snap.docChanges().forEach((ch) => {
        const it = { id: ch.doc.id, ...ch.doc.data() };
        if (ch.type !== 'removed' && it.ready && it.fromId !== deviceId() && it.createdMs >= listenSince - 5000 && !announced.has(it.id)) {
          announced.add(it.id);
          if (notify && !active) announce(it);
        }
      });
      if (active) { markSeen(); render(); }
      refreshBadge();
    }, (err) => console.warn('Share listener:', err && err.code));
    sweep();
  }
  function detach() { if (unsub) { unsub(); unsub = null; } }

  function markSeen() { try { localStorage.setItem(LS_SEEN, String(Date.now())); } catch (e) {} }
  // Unread count on the Share sub-nav item, its promoted hotbar tab, or (when it lives only in
  // the sub-nav) the Engineering tab, so a new item is visible from anywhere in the app.
  function refreshBadge() {
    const seen = +localStorage.getItem(LS_SEEN) || 0;
    const n = active ? 0 : items.filter(i => i.fromId !== deviceId() && (i.createdMs || 0) > seen).length;
    const promoted = document.querySelector('.header-tab[data-util="share"]');
    const targets = [document.querySelector('.eng-nav-item[data-util="share"]'),
      promoted || document.querySelector('.header-tab[data-view="engineering"]')].filter(Boolean);
    document.querySelectorAll('.shr-badge').forEach(b => { if (!targets.includes(b.parentElement)) b.remove(); });
    targets.forEach(t => {
      let b = t.querySelector(':scope > .shr-badge');
      if (!n) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement('span'); b.className = 'shr-badge'; t.appendChild(b); }
      b.textContent = n > 9 ? '9+' : String(n);
    });
  }

  // Bottom-right card (same look as the EngInk cards) + a system notification when unfocused.
  let card = null, cardT = null;
  function announce(it) {
    const what = it.kind === 'file' ? it.name : it.kind === 'link' ? 'a link' : 'a note';
    if (!document.hasFocus()) {
      try {
        if (window.Notification && Notification.permission === 'granted') {
          const n = new Notification(`📥 ${it.from || 'Another device'} shared ${what}`, { body: it.kind === 'file' ? fmtSize(it.size) : (it.text || '').slice(0, 140) });
          n.onclick = () => { window.focus(); openUtility(); };
        }
      } catch (e) {}
    }
    if (!card || !document.body.contains(card)) {
      card = document.createElement('div');
      card.className = 'engink-connect-card';
      card.setAttribute('role', 'status');
      document.body.appendChild(card);
    }
    const primary = it.kind === 'link' ? 'Open link' : it.kind === 'text' ? 'Copy' : 'Open';
    card.innerHTML = `
      <div class="engink-connect-head"><span class="engink-connect-icon">📥</span><span class="engink-connect-title">Shared from ${esc(it.from || 'another device')}</span>
        <button class="engink-connect-x" data-act="x" title="Dismiss">×</button></div>
      <div class="engink-connect-body">${it.kind === 'file' ? `<b>${esc(it.name)}</b> · ${fmtSize(it.size)}` : esc((it.text || '').slice(0, 200))}</div>
      <div class="engink-connect-actions"><button class="engink-connect-btn" data-act="view">View all</button><button class="engink-connect-btn primary" data-act="go">${primary}</button></div>`;
    card.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'go') act('primary', it);
      if (b.dataset.act === 'view') openUtility();
      card.classList.remove('show');
    };
    requestAnimationFrame(() => card.classList.add('show'));
    clearTimeout(cardT); cardT = setTimeout(() => card && card.classList.remove('show'), 15000);
  }
  const openUtility = () => { if (window.openEngineeringUtility) window.openEngineeringUtility('share'); };

  // ---- Actions -------------------------------------------------------------
  // 'primary' = what clicking the row does: open a link, copy a note, open a file.
  async function act(action, it) {
    if (action === 'primary') action = it.kind === 'text' ? 'copy' : 'open';
    try {
      if (action === 'open') {
        if (it.kind === 'link') { window.api.openExternal(it.text); return; }
        if (it.kind === 'file') { const p = await saveLocal(it); window.api.openPath(p); }
      } else if (action === 'folder') {
        const p = await saveLocal(it); window.api.share.showInFolder(p);
        setStatus(`Saved to Downloads: ${it.name}`, 'success');
      } else if (action === 'copy') {
        await navigator.clipboard.writeText(it.text || '');
        setStatus('Copied to the clipboard.', 'success');
      } else if (action === 'delete') {
        await removeItem(it.id);
      }
    } catch (e) { setStatus(e.message || String(e), 'error'); }
  }

  // ---- Rendering -----------------------------------------------------------
  const KIND_OF = { link: 'links', text: 'notes', file: 'files' };
  const visible = () => filter === 'all' ? items : items.filter(i => KIND_OF[i.kind] === filter);

  function rowHtml(it) {
    const p = progress.get(it.id);
    const mine = it.fromId === deviceId();
    const btn = (a, icon, title) => `<button class="shr-act" data-act="${a}" title="${title}">${svg(IC[icon], 16)}</button>`;
    let tile, main, extra = '', acts = '';
    if (it.kind === 'link') {
      let host = ''; try { host = new URL(it.text).hostname.replace(/^www\./, ''); } catch (e) {}
      tile = svg(IC.link, 20);
      main = `<div class="shr-main shr-main-link" title="${esc(it.text)}">${esc(host || it.text)}</div><div class="shr-url">${esc(it.text)}</div>`;
      acts = btn('copy', 'copy', 'Copy link') + btn('open', 'open', 'Open in browser');
    } else if (it.kind === 'text') {
      tile = svg(IC.note, 20);
      main = `<div class="shr-main shr-main-text">${esc(it.text)}</div>`;
      acts = btn('copy', 'copy', 'Copy');
    } else {
      tile = it.thumb ? `<img src="${esc(it.thumb)}" alt="">` : svg(IC.file, 20);
      main = `<div class="shr-main" title="${esc(it.name)}">${esc(it.name)}</div>`;
      extra = `<span>${fmtSize(it.size)}</span>`;
      acts = it.ready ? btn('folder', savedPaths.has(it.id) ? 'folder' : 'download', savedPaths.has(it.id) ? 'Show in folder' : 'Save to Downloads') + btn('open', 'open', 'Open') : '';
    }
    const state = p ? `<span class="shr-state">${p.dir === 'up' ? 'Sending' : 'Downloading'} ${Math.round(100 * p.done / p.total)}%</span>`
      : (it.kind === 'file' && !it.ready ? '<span class="shr-state">Uploading…</span>' : '');
    const bar = p ? `<div class="shr-progress"><div style="width:${Math.round(100 * p.done / p.total)}%"></div></div>` : '';
    const isNew = !mine && (it.createdMs || 0) > newSince;
    return `<div class="shr-item shr-k-${it.kind}${it.thumb ? ' has-thumb' : ''}${isNew ? ' is-new' : ''}" data-id="${esc(it.id)}" data-act="primary">
      <div class="shr-tile">${tile}</div>
      <div class="shr-body">${main}
        <div class="shr-meta"><span class="shr-from">${svg(it.fromPlatform === 'pwa' ? IC.phone : IC.device, 12)}${mine ? 'This device' : esc(it.from || 'Another device')}</span><span>${fmtAgo(it.createdMs || 0)}</span>${extra}${state}</div>${bar}
      </div>
      <div class="shr-acts">${acts}<button class="shr-act shr-act-del" data-act="delete" title="Delete from every device">${svg(IC.trash, 16)}</button></div>
    </div>`;
  }

  function listHtml() {
    const list = visible();
    if (!items.length) {
      return `<div class="shr-empty">${svg(IC.inbox, 34)}<div class="shr-empty-title">Nothing shared yet</div>
        <div class="shr-empty-sub">Send something from here or from the EngOrg app on your phone. It shows up on every device you're signed in on.</div></div>`;
    }
    if (!list.length) return `<div class="shr-empty shr-empty-sm">No ${filter} right now.</div>`;
    let html = '', day = '';
    list.forEach(it => {
      const d = dayLabel(it.createdMs || 0);
      if (d !== day) { day = d; html += `<div class="shr-day">${esc(d)}</div>`; }
      html += rowHtml(it);
    });
    return html;
  }

  function filtersHtml() {
    const n = (k) => k === 'all' ? items.length : items.filter(i => KIND_OF[i.kind] === k).length;
    return [['all', 'All'], ['links', 'Links'], ['notes', 'Notes'], ['files', 'Files']].map(([k, label]) =>
      `<button class="shr-chip${filter === k ? ' active' : ''}" data-filter="${k}">${label}<span>${n(k)}</span></button>`).join('');
  }

  function renderRow(id) {
    if (!active || !container) return;
    const el = container.querySelector(`.shr-item[data-id="${CSS.escape(id)}"]`);
    const it = items.find(i => i.id === id);
    if (el && it) el.outerHTML = rowHtml(it); else if (!el && it) renderList();
  }

  function renderList() {
    if (!active || !container) return;
    const list = container.querySelector('.shr-list');
    if (!list) return;
    list.innerHTML = listHtml();
    const f = container.querySelector('.shr-filters'); if (f) f.innerHTML = filtersHtml();
    const head = container.querySelector('.shr-inbox-head'); if (head) head.style.display = items.length ? '' : 'none';
  }

  function renderStatus() {
    const el = active && container && container.querySelector('.shr-status');
    if (!el) return;
    el.className = 'shr-status' + (status ? ' show ' + status.kind : '');
    el.textContent = status ? status.msg : '';
  }

  function render() {
    if (!container) return;
    if (!signedIn()) {
      container.innerHTML = `<div class="shr"><div class="shr-empty shr-signedout">${svg(IC.upload, 36)}
        <div class="shr-empty-title">Share between your devices</div>
        <div class="shr-empty-sub">Sign in to cloud sync to send links, notes and files to your phone and your other PCs.</div>
        <button class="shr-send" id="shr-signin">Sign in</button></div></div>`;
      container.querySelector('#shr-signin').onclick = () => firebaseSync.showSignInModal();
      return;
    }
    if (!container.querySelector('.shr-compose')) {
      container.innerHTML = `<div class="shr">
        <div class="shr-head">
          <div>
            <div class="shr-title">Share</div>
            <div class="shr-sub">Send to your phone and other PCs. Items are removed after ${TTL_DAYS} days.</div>
          </div>
          <label class="shr-device" title="How this PC is labeled on your other devices. Click to rename.">${svg(IC.device, 14)}<input id="shr-device" maxlength="40" spellcheck="false"></label>
        </div>
        <div class="shr-compose">
          <textarea id="shr-text" rows="2" placeholder="Paste a link or write a note…"></textarea>
          <div class="shr-compose-bar">
            <input type="file" id="shr-file-input" multiple hidden>
            <button class="shr-tool" id="shr-attach">${svg(IC.clip, 16)}<span>Attach files</span></button>
            <span class="shr-hint">or drop and paste them anywhere here · up to ${fmtSize(MAX_FILE)}</span>
            <span class="shr-kbd">Ctrl + Enter</span>
            <button class="shr-send" id="shr-send">${svg(IC.send, 15)}<span>Send</span></button>
          </div>
        </div>
        <div class="shr-status"></div>
        <div class="shr-inbox-head">
          <div class="shr-filters"></div>
          <button class="shr-clear" id="shr-clear">Clear all</button>
        </div>
        <div class="shr-list"></div>
        <div class="shr-drop"><div class="shr-drop-card">${svg(IC.upload, 40)}<div>Drop to send to your devices</div></div></div>
      </div>`;
      bindShell();
    }
    const nameIn = container.querySelector('#shr-device');
    if (nameIn && document.activeElement !== nameIn) nameIn.value = myName();
    renderList(); renderStatus();
  }

  function bindShell() {
    const host = container;
    const ta = host.querySelector('#shr-text');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight) + 'px'; };
    const send = async () => { if (await sendText(ta.value)) { ta.value = ''; grow(); } ta.focus(); };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    host.querySelector('#shr-send').onclick = send;
    const fi = host.querySelector('#shr-file-input');
    host.querySelector('#shr-attach').onclick = () => fi.click();
    fi.onchange = () => { sendFiles(fi.files); fi.value = ''; };
    host.querySelector('#shr-device').addEventListener('change', (e) => {
      deviceName = e.target.value.trim(); e.target.value = myName();
      try { deviceName ? localStorage.setItem(LS_NAME, deviceName) : localStorage.removeItem(LS_NAME); } catch (er) {}
    });
    host.querySelector('.shr-filters').addEventListener('click', (e) => {
      const c = e.target.closest('[data-filter]'); if (!c) return;
      filter = c.dataset.filter; renderList();
    });
    host.querySelector('#shr-clear').onclick = async () => {
      const ok = window._showConfirm ? await window._showConfirm({ title: 'Clear all shared items?', message: 'This removes them from every device.', confirmText: 'Clear all', danger: true }) : true;
      if (!ok) return;
      for (const it of items.slice()) await removeItem(it.id).catch(() => {});
    };
    // Clicking a row does its main thing; the icon buttons do the specific ones.
    host.querySelector('.shr-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const row = b.closest('.shr-item');
      const it = row && items.find(i => i.id === row.dataset.id);
      if (it) act(b.dataset.act, it);
    });
    const view = host.querySelector('.shr');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let depth = 0;
    view.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; view.classList.add('dragging'); });
    view.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; view.classList.remove('dragging'); } });
    view.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    view.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; view.classList.remove('dragging');
      sendFiles(e.dataTransfer.files);
    });
    // Pasting files (screenshots, copied files) sends them; pasted text lands in the box.
    view.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length && e.target.id !== 'shr-device') { e.preventDefault(); sendFiles(files); }
    });
  }

  // Dropping files onto the Share sub-nav item (or its promoted hotbar tab) sends them without
  // opening it first. Delegated, because the sub-nav and hotbar tabs are rebuilt often.
  function bindNavDrop() {
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const target = (e) => e.target.closest && e.target.closest('.eng-nav-item[data-util="share"], .header-tab[data-util="share"]');
    document.addEventListener('dragover', (e) => {
      const t = target(e);
      document.querySelectorAll('.shr-nav-drop').forEach(x => { if (x !== t) x.classList.remove('shr-nav-drop'); });
      if (t && hasFiles(e)) { e.preventDefault(); t.classList.add('shr-nav-drop'); }
    });
    document.addEventListener('drop', (e) => {
      const t = target(e);
      document.querySelectorAll('.shr-nav-drop').forEach(x => x.classList.remove('shr-nav-drop'));
      if (!t || !hasFiles(e)) return;
      e.preventDefault();
      const files = e.dataTransfer.files;
      openUtility();
      sendFiles(files);
    });
  }

  return {
    /** Listen for shared items. `opts.notify` = pop a card for incoming items (main window only). */
    start(opts) {
      if (started) return; started = true;
      notify = !!(opts && opts.notify);
      window.addEventListener('auth-changed', () => attach());   // attach() also handles signing out
      bindNavDrop();
      attach();
    },
    mount(el) { if (container !== el) { container = el; } },
    activate() {
      newSince = +localStorage.getItem(LS_SEEN) || 0;   // highlight what arrived since the last visit
      active = true; markSeen(); refreshBadge(); render();
    },
    deactivate() { if (!active) return; active = false; markSeen(); refreshBadge(); },
    refreshBadge,
    sendText, sendFiles,
  };
})();
