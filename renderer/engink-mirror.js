// EngInk live mirror (desktop, view-only).
//
// Reflects the native EngInk (Android) app over the LAN: the tablet streams its notebook + strokes
// to the desktop's WebSocket server (ipc/engink-mirror.js), which forwards each message here. We keep
// a small notebook model and redraw the current page on a canvas — reproducing FinishedStrokesView's
// geometry (816x1056 pages), paper styles, Catmull-Rom ink and highlighter alpha — so what appears on
// the tablet appears here in ~real time. Nothing is editable; this is a mirror. Export renders the
// mirrored pages to a PDF via the browser's print-to-PDF.
//
// Wire format (from MirrorClient.kt):
//   { t:'server', running, error? }                         server up/down
//   { t:'client', connected, device, version? }             a tablet paired / dropped
//   { t:'open', id, title, paper, pageColor, pageCount }     notebook opened (resets model)
//   { t:'page', index, recs:[{ c,w,h,k,d?,segs:[[[x,y]...]] }] } a page's committed strokes (d=dashed shape)
//   { t:'wet', page, pts:[[x,y]...], c, w, h }               in-progress stroke (older tablets: the whole stroke)
//   { t:'wetAdd', page, pts, c, w, h, reset }                in-progress stroke, just the new points
//   { t:'wetClear' }                                         pen lifted
//   { t:'view', scale, tx, ty, page }                        tablet viewport (page-follow)

const enginkMirror = (() => {
  const PAGE_W = 816, PAGE_H = 1056, GAP = 56, PAPER_SP = 32;

  let root = null, canvas = null, ctx = null, stageEl = null, barEl = null, pairEl = null, pageLabel = null;
  let built = false, subscribed = false, active = false;
  let renderQueued = false;
  let ro = null;

  // Live model of the tablet's notebook.
  const model = {
    server: { running: false, host: '', port: 0, code: '' },
    connected: [],           // [{ device, version }]
    notebook: null,          // { id, title, paper, pageColor, pageCount }
    pages: new Map(),        // index -> recs[]
    wet: null,               // { page, pts, c, w, h }
    view: null,              // { scale, tx, ty, page } — tablet viewport
    pinnedPage: null,        // when the user browses pages themselves (free-look)
    showPair: false,         // pairing details opened from the status chip while connected
  };
  // Desktop-side inspection transform (independent of the tablet).
  // mode 'page' fits the whole page; 'width' fills the width (scroll to move down the page).
  const look = { zoom: 1, panX: 0, panY: 0, mode: 'page' };

  // ---- color helpers (Android color ints, possibly signed) ----
  const rgb = (c) => `rgb(${(c >> 16) & 0xFF},${(c >> 8) & 0xFF},${c & 0xFF})`;
  const rgba = (c, a) => `rgba(${(c >> 16) & 0xFF},${(c >> 8) & 0xFF},${c & 0xFF},${a})`;
  const lum = (c) => 0.299 * ((c >> 16) & 0xFF) + 0.587 * ((c >> 8) & 0xFF) + 0.114 * (c & 0xFF);

  function curPage() {
    if (model.pinnedPage != null) return model.pinnedPage;
    if (model.view) return model.view.page || 0;
    return 0;
  }
  function pageCount() { return model.notebook ? model.notebook.pageCount : 1; }

  // ---- Catmull-Rom smoothed path (mirrors FinishedStrokesView.buildPath) ----
  function traceSmooth(pts) {
    if (!pts.length) return;
    if (pts.length === 1) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[0][0] + 0.1, pts[0][1]); return; }
    if (pts.length === 2) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); return; }
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
    }
  }
  function traceStraight(pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  // ---- message handling ----
  function handle(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'server':
        model.server.running = !!msg.running;
        if (!msg.running) { model.connected = []; }
        refreshStatus();
        break;
      case 'client':
        if (msg.connected) {
          if (!model.connected.some(c => c.device === msg.device)) model.connected.push({ device: msg.device, version: msg.version || '' });
          if (!active) showConnectCard(msg.device);
        } else {
          model.connected = model.connected.filter(c => c.device !== msg.device);
          if (!model.connected.length) { model.notebook = null; model.pages.clear(); model.wet = null; model.view = null; hideConnectCard(); }
        }
        refreshStatus();
        requestRender();
        break;
      case 'open':
        model.notebook = { id: msg.id, title: msg.title || 'Notebook', paper: msg.paper || 'GRID', pageColor: (msg.pageColor != null ? msg.pageColor : -1), pageCount: msg.pageCount || 1 };
        model.pages.clear(); model.wet = null; model.pinnedPage = null;
        refreshStatus(); requestRender();
        break;
      case 'page':
        if (Array.isArray(msg.recs)) model.pages.set(msg.index, msg.recs);
        requestRender();
        break;
      case 'wet':
        model.wet = { page: msg.page, pts: msg.pts || [], c: msg.c, w: msg.w, h: !!msg.h };
        requestRender();
        break;
      case 'wetAdd':
        // The tablet sends only the points added since its last update (reset = a new or redrawn stroke).
        if (msg.reset || !model.wet || model.wet.page !== msg.page) model.wet = { page: msg.page, pts: (msg.pts || []).slice(), c: msg.c, w: msg.w, h: !!msg.h };
        else if (Array.isArray(msg.pts)) { for (const p of msg.pts) model.wet.pts.push(p); }
        requestRender();
        break;
      case 'wetClear':
        model.wet = null; requestRender();
        break;
      case 'view':
        model.view = { scale: msg.scale, tx: msg.tx, ty: msg.ty, page: msg.page || 0 };
        if (model.pinnedPage == null) { updatePageLabel(); requestRender(); }
        break;
    }
  }

  // ---- rendering ----
  function fitScale(cssW, cssH) {
    const base = look.mode === 'width' ? (cssW / PAGE_W) * 0.98 : Math.min(cssW / PAGE_W, cssH / PAGE_H) * 0.96;
    return base * look.zoom;
  }

  /** Keep the page reachable: it can scroll until its edge is a little past the view's edge, no further. */
  function clampPan(cssW, cssH) {
    const s = fitScale(cssW, cssH), pw = PAGE_W * s, ph = PAGE_H * s, m = 40;
    const lim = (page, view) => Math.max(0, (page - view) / 2 + m);
    const lx = lim(pw, cssW), ly = lim(ph, cssH);
    look.panX = Math.min(lx, Math.max(-lx, look.panX));
    look.panY = Math.min(ly, Math.max(-ly, look.panY));
  }

  /** Scroll the page to its top (used when switching to fill-width). */
  function toTop() {
    const cssW = stageEl.clientWidth, cssH = stageEl.clientHeight;
    const ph = PAGE_H * fitScale(cssW, cssH);
    look.panX = 0; look.panY = Math.max(0, (ph - cssH) / 2);
  }

  /** Zoom by [f] keeping the page point under the screen point (mx, my) still. */
  function zoomAt(f, mx, my) {
    const cssW = stageEl.clientWidth, cssH = stageEl.clientHeight;
    const s0 = fitScale(cssW, cssH);
    const ox0 = (cssW - PAGE_W * s0) / 2 + look.panX, oy0 = (cssH - PAGE_H * s0) / 2 + look.panY;
    const ux = (mx - ox0) / s0, uy = (my - oy0) / s0;
    look.zoom = Math.min(8, Math.max(0.3, look.zoom * f));
    const s1 = fitScale(cssW, cssH);
    look.panX = mx - (cssW - PAGE_W * s1) / 2 - ux * s1;
    look.panY = my - (cssH - PAGE_H * s1) / 2 - uy * s1;
  }

  function setFullscreen(on) {
    const wrap = root && root.querySelector('.engink-wrap');
    if (!wrap) return;
    if (on) {
      // Fill the EngOrg window below its titlebar (so the window controls stay reachable).
      const tb = document.getElementById('titlebar');
      const top = tb && tb.offsetParent !== null ? Math.max(0, tb.getBoundingClientRect().bottom) : 0;
      wrap.style.top = top + 'px';
    }
    wrap.classList.toggle('engink-full', on);
    const b = barEl && barEl.querySelector('[data-act="full"]');
    if (b) { b.classList.toggle('active', on); b.title = on ? 'Exit full screen (Esc)' : 'Full screen'; }
    requestRender();
  }

  function drawPaper(paper, pageColor, s) {
    if (paper === 'PLAIN') return;
    const light = lum(pageColor) < 128;
    ctx.strokeStyle = light ? 'rgba(255,255,255,0.18)' : 'rgba(30,50,90,0.12)';
    ctx.lineWidth = 1;
    if (paper === 'GRID' || paper === 'RULED') {
      ctx.beginPath();
      if (paper === 'GRID') for (let x = PAPER_SP; x < PAGE_W; x += PAPER_SP) { ctx.moveTo(x * s, 0); ctx.lineTo(x * s, PAGE_H * s); }
      for (let y = PAPER_SP; y < PAGE_H; y += PAPER_SP) { ctx.moveTo(0, y * s); ctx.lineTo(PAGE_W * s, y * s); }
      ctx.stroke();
    } else if (paper === 'DOTS') {
      ctx.fillStyle = light ? 'rgba(255,255,255,0.38)' : 'rgba(30,50,90,0.29)';
      const r = Math.min(Math.max(1.35 * s, 1.6), 14);
      for (let y = PAPER_SP; y < PAGE_H; y += PAPER_SP)
        for (let x = PAPER_SP; x < PAGE_W; x += PAPER_SP) { ctx.beginPath(); ctx.arc(x * s, y * s, r, 0, 7); ctx.fill(); }
    }
  }

  function drawRecs(recs, s) {
    if (!recs) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const rec of recs) {
      ctx.strokeStyle = rec.h ? rgba(rec.c, 0.4) : rgb(rec.c);
      ctx.lineWidth = Math.max(rec.w * s, 0.4);
      const smooth = rec.k !== 's';
      // Dashed shapes (rec.d): same width-scaled dash/gap as the tablet, butt caps for clean gaps.
      if (rec.d) {
        ctx.setLineDash([Math.max(rec.w * 3, 9) * s, Math.max(rec.w * 2.2, 6) * s]);
        ctx.lineCap = 'butt';
      }
      for (const seg of (rec.segs || [])) {
        ctx.beginPath();
        if (smooth) traceSmooth(seg.map(p => [p[0] * s, p[1] * s]));
        else traceStraight(seg.map(p => [p[0] * s, p[1] * s]));
        ctx.stroke();
      }
      if (rec.d) { ctx.setLineDash([]); ctx.lineCap = 'round'; }
    }
  }

  function render() {
    renderQueued = false;
    if (!canvas || !ctx) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cssW = stageEl.clientWidth, cssH = stageEl.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // backdrop
    ctx.fillStyle = getComputedStyle(root).getPropertyValue('--bg-elevated') || '#1b1f27';
    ctx.fillRect(0, 0, cssW, cssH);

    if (!model.notebook) return;
    const nb = model.notebook;
    clampPan(cssW, cssH);
    const s = fitScale(cssW, cssH);
    const pageW = PAGE_W * s, pageH = PAGE_H * s;
    const ox = (cssW - pageW) / 2 + look.panX;
    const oy = (cssH - pageH) / 2 + look.panY;

    ctx.save();
    ctx.translate(ox, oy);
    // page shadow + fill
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(4, 6, pageW, pageH);
    ctx.fillStyle = rgb(nb.pageColor);
    ctx.fillRect(0, 0, pageW, pageH);
    // clip to page for paper + strokes
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip();
    drawPaper(nb.paper, nb.pageColor, s);
    const p = curPage();
    drawRecs(model.pages.get(p), s);
    if (model.wet && model.wet.page === p && model.wet.pts.length) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = model.wet.h ? rgba(model.wet.c, 0.4) : rgb(model.wet.c);
      ctx.lineWidth = Math.max(model.wet.w * s, 0.4);
      ctx.beginPath(); traceSmooth(model.wet.pts.map(pt => [pt[0] * s, pt[1] * s])); ctx.stroke();
    }
    ctx.restore();
    // page border
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1; ctx.strokeRect(0, 0, pageW, pageH);
    ctx.restore();
  }

  function requestRender() {
    if (!active || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  // ---- status / pairing UI ----
  function updatePageLabel() {
    if (pageLabel) pageLabel.textContent = `${curPage() + 1} / ${pageCount()}`;
  }

  function syncModeButtons() {
    if (!barEl) return;
    barEl.querySelector('[data-act="width"]').classList.toggle('active', look.mode === 'width');
  }

  function refreshStatus() {
    if (!built) return;
    const sv = model.server;
    const conn = model.connected;
    const followOn = model.pinnedPage == null;
    // Once a tablet is connected the pairing details fold away (the status chip brings them back),
    // so the notebook gets the room.
    const statusBtn = barEl.querySelector('[data-act="pair"]');
    statusBtn.innerHTML = conn.length
      ? `<span class="engink-dot on"></span>${escapeHtml(conn.map(c => c.device).join(', '))}`
      : `<span class="engink-dot"></span>${sv.running ? 'Waiting for tablet' : 'Server off'}`;
    pairEl.classList.toggle('collapsed', conn.length > 0 && !model.showPair);
    pairEl.innerHTML = sv.running
      ? `<div class="engink-pair-grid">
           <div class="engink-pair-cell"><span class="engink-k">This PC</span><b>${escapeHtml(sv.host)}:${sv.port}</b></div>
           <div class="engink-pair-cell engink-code"><span class="engink-k">Pairing code</span><b>${escapeHtml(sv.code)}</b></div>
           <div class="engink-pair-cell"><span class="engink-k">Connected</span><b>${conn.length ? escapeHtml(conn.map(c => c.device).join(', ')) : '—'}</b></div>
         </div>
         <div class="engink-hint">On your tablet: open <b>EngInk</b> → tap the <b>Mirror</b> icon → pick this PC (or type <b>${escapeHtml(sv.host)}:${sv.port}</b> and the code above).
           If it can't find this PC, tap <b>Mirror over the internet</b> instead. That works on any Wi-Fi with no code, as long as you're signed in to EngOrg here.</div>`
      : `<div class="engink-hint">The mirror server is stopped. Start it, then connect from your tablet's EngInk app.</div>`;

    barEl.querySelector('[data-act="toggle"]').textContent = sv.running ? 'Stop server' : 'Start server';
    barEl.querySelector('[data-act="follow"]').classList.toggle('active', followOn);
    const waiting = sv.running && !model.notebook;
    stageEl.classList.toggle('engink-waiting', !model.notebook);
    stageEl.setAttribute('data-msg', !sv.running ? 'Start the server to begin.' : (waiting ? (conn.length ? 'Open a notebook on your tablet…' : 'Waiting for your tablet to connect…') : ''));
    updatePageLabel();
  }

  function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str == null ? '' : str; return d.innerHTML; }

  // ---- PDF export (browser print-to-PDF of all mirrored pages) ----
  function exportPdf() {
    if (!model.notebook) return;
    const nb = model.notebook;
    const holder = document.createElement('div');
    holder.id = 'engink-print';
    for (let i = 0; i < nb.pageCount; i++) {
      const c = document.createElement('canvas');
      const s = 1; // page units == device px (816x1056)
      c.width = PAGE_W; c.height = PAGE_H;
      const cx = c.getContext('2d');
      cx.fillStyle = rgb(nb.pageColor); cx.fillRect(0, 0, PAGE_W, PAGE_H);
      // paper + strokes via the shared drawing on a temporary ctx binding
      const savedCtx = ctx; ctx = cx;
      cx.save(); cx.beginPath(); cx.rect(0, 0, PAGE_W, PAGE_H); cx.clip();
      drawPaper(nb.paper, nb.pageColor, s);
      drawRecs(model.pages.get(i), s);
      cx.restore();
      ctx = savedCtx;
      const img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      holder.appendChild(img);
    }
    document.body.appendChild(holder);
    document.body.classList.add('engink-printing');
    const cleanup = () => { document.body.classList.remove('engink-printing'); holder.remove(); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => window.print(), 60);
  }

  // ---- submit to an assignment (from the PC) ----
  // The mirrored pages become a PDF here (pdf-lib, already loaded for the File Merger) and go
  // straight to Gradescope through this PC's login — the same upload the tablet's Attach & submit
  // asks EngOrg to do. Other platforms (or a failed upload): save the PDF and open the assignment.

  /** Render the mirrored pages ([only] = one page index) to PDF bytes, 2× for crisp handwriting. */
  async function buildPdf(only) {
    const nb = model.notebook;
    const doc = await PDFLib.PDFDocument.create();
    const idx = only != null ? [only] : Array.from({ length: nb.pageCount }, (_, i) => i);
    const k = 2;
    for (const i of idx) {
      const c = document.createElement('canvas');
      c.width = PAGE_W * k; c.height = PAGE_H * k;
      const cx = c.getContext('2d');
      cx.fillStyle = rgb(nb.pageColor); cx.fillRect(0, 0, c.width, c.height);
      const savedCtx = ctx; ctx = cx;
      cx.save(); cx.beginPath(); cx.rect(0, 0, c.width, c.height); cx.clip();
      drawPaper(nb.paper, nb.pageColor, k);
      drawRecs(model.pages.get(i), k);
      cx.restore();
      ctx = savedCtx;
      const png = await new Promise(res => c.toBlob(b => res(b), 'image/png'));
      const img = await doc.embedPng(new Uint8Array(await png.arrayBuffer()));
      const page = doc.addPage([612, 792]);   // US Letter, like the tablet's own export
      page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
    }
    return await doc.save();
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function openAssignments() {
    const projects = new Map((dataManager.projects || []).map(p => [p.id, p.courseShort || p.name || '']));
    return (dataManager.tasks || [])
      .filter(t => !t.completed && t.status !== 'done' && (t.category === 'assignment' || ['gradescope', 'variate', 'brightspace'].includes(t.source)))
      .map(t => ({
        t, course: projects.get(t.projectId) || '',
        gs: !!(t.gradescopeCourseId && t.gradescopeAssignmentId),
        url: ((t.links || []).find(l => /^https?:/.test(l.url || '')) || {}).url || '',
      }))
      .sort((a, b) => (!a.t.dueDate) - (!b.t.dueDate) || String(a.t.dueDate || '').localeCompare(String(b.t.dueDate || '')));
  }

  function dueLabel(d) {
    if (!d) return 'no due date';
    const day = new Date(String(d).slice(0, 10) + 'T00:00');
    if (isNaN(day)) return 'due ' + d;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const n = Math.round((day - today) / 86400000);
    const txt = n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return 'due ' + txt + (String(d).length > 11 ? ' ' + String(d).slice(11, 16) : '');
  }

  function openSubmit() {
    if (!model.notebook) { alertCard('Open a notebook on your tablet first.'); return; }
    const back = document.createElement('div');
    back.className = 'engink-submit-back';
    back.innerHTML = '<div class="engink-submit"><div class="engink-submit-head"><span>📤 Submit to an assignment</span><button class="engink-connect-x" data-x>×</button></div><div class="engink-submit-body"></div></div>';
    document.body.appendChild(back);
    const body = back.querySelector('.engink-submit-body');
    const close = () => back.remove();
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-x]')) close(); });

    const list = () => {
      const items = openAssignments();
      body.innerHTML = items.length
        ? '<div class="engink-submit-note">Which assignment is this notebook for?</div>' + items.slice(0, 80).map((it, i) => `
            <button class="engink-submit-row" data-i="${i}">
              <b>${escapeHtml(it.t.title || 'Untitled')}</b>
              <span>${escapeHtml([({ gradescope: 'Gradescope', variate: 'Variate', brightspace: 'Brightspace' })[it.t.source] || 'Assignment', it.gs ? 'auto-submit' : '', it.course, dueLabel(it.t.dueDate)].filter(Boolean).join(' · '))}</span>
            </button>`).join('')
        : '<div class="engink-submit-note">No open assignments in EngOrg.</div>';
      body.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => confirm(items[+b.dataset.i])));
    };

    const confirm = (it) => {
      let only = null;
      const pageNow = curPage();
      const paint = () => body.querySelectorAll('[data-scope]').forEach(c => c.classList.toggle('active', (c.dataset.scope === 'page') === (only != null)));
      body.innerHTML = `
        <div class="engink-submit-title">${escapeHtml(it.t.title || 'Untitled')}</div>
        <div class="engink-submit-note">${escapeHtml([it.course, dueLabel(it.t.dueDate)].filter(Boolean).join(' · '))}</div>
        <div class="engink-submit-scope">
          <button class="engink-btn" data-scope="all">Whole notebook (${model.notebook.pageCount} pages)</button>
          <button class="engink-btn" data-scope="page">Just page ${pageNow + 1}</button>
        </div>
        <div class="engink-submit-note">${it.gs
          ? 'Uploads to Gradescope and marks it done. If the assignment needs pages matched to questions, Gradescope opens so you can do that.'
          : 'This one can’t be submitted automatically: you’ll save the PDF, then the assignment opens so you can upload it.'}</div>
        <div class="engink-submit-actions">
          <button class="engink-btn" data-back>Back</button>
          <button class="engink-btn active" data-go>${it.gs ? 'Submit' : 'Save PDF & open assignment'}</button>
        </div>`;
      paint();
      body.querySelectorAll('[data-scope]').forEach(c => c.addEventListener('click', () => { only = c.dataset.scope === 'page' ? pageNow : null; paint(); }));
      body.querySelector('[data-back]').addEventListener('click', list);
      body.querySelector('[data-go]').addEventListener('click', () => run(it, only));
    };

    const result = (title, html, actions) => {
      body.innerHTML = `<div class="engink-submit-title">${escapeHtml(title)}</div><div class="engink-submit-note">${html}</div>
        <div class="engink-submit-actions">${actions || ''}<button class="engink-btn active" data-done>Done</button></div>`;
      body.querySelector('[data-done]').addEventListener('click', close);
    };

    const markDone = (t) => {
      if (t.completed) return;
      dataManager.updateTaskStatus(t.id, 'done').then(() => window.dispatchEvent(new CustomEvent('tasks-changed'))).catch(() => {});
    };

    const fallback = async (it, bytes, why) => {
      const name = (model.notebook.title || 'Notebook').replace(/[^\w .-]/g, '').trim() + '.pdf';
      const saved = await window.api.fileMerger.save(bytes, name).catch(() => null);
      if (it.url) window.api.openExternal(it.url);
      result('Not submitted automatically',
        `${escapeHtml(why)}<br>${saved && saved.path ? 'Saved to ' + escapeHtml(saved.path) + '. ' : ''}${it.url ? 'The assignment is open in your browser, so upload it there.' : 'This note has no assignment link, so upload it yourself.'}`,
        '<button class="engink-btn" data-mark>Mark it done</button>');
      const m = body.querySelector('[data-mark]');
      m.addEventListener('click', () => { markDone(it.t); m.textContent = 'Marked done ✓'; m.disabled = true; });
    };

    const run = async (it, only) => {
      body.innerHTML = `<div class="engink-submit-title">${escapeHtml(it.t.title || 'Untitled')}</div><div class="engink-submit-note" data-status>Making the PDF…</div>`;
      const status = body.querySelector('[data-status]');
      let bytes;
      try { bytes = await buildPdf(only); } catch (e) { result('Couldn’t make the PDF', escapeHtml(e.message || String(e))); return; }
      if (!it.gs) { fallback(it, bytes, 'This assignment isn’t on Gradescope.'); return; }
      status.textContent = 'Uploading to Gradescope…';
      const res = await window.api.gradescope.submitPdf(it.t.gradescopeCourseId, it.t.gradescopeAssignmentId, toBase64(bytes),
        (model.notebook.title || 'Notebook') + '.pdf').catch(e => ({ error: e.message }));
      if (!res || res.error) { fallback(it, bytes, (res && res.error) || 'Gradescope didn’t accept it.'); return; }
      markDone(it.t);
      if (res.needsMatching && res.url) window.api.openExternal(res.url);
      result(res.needsMatching ? 'Uploaded: match your pages' : 'Submitted',
        res.needsMatching ? 'It’s uploaded and marked done. Gradescope is open in your browser so you can assign pages to questions.' : 'Submitted to Gradescope and marked done.',
        res.url ? '<button class="engink-btn" data-open>Open in Gradescope</button>' : '');
      const o = body.querySelector('[data-open]');
      if (o) o.addEventListener('click', () => window.api.openExternal(res.url));
    };

    list();
  }

  function alertCard(msg) {
    if (typeof window._showConfirm === 'function') window._showConfirm({ title: 'EngInk', message: msg, confirmText: 'OK' });
    else console.warn(msg);
  }

  // ---- "tablet connected" card (bottom right, like the Windows-theme popup) ----
  let card = null, cardHideT = null;
  function showConnectCard(device) {
    if (!card || !document.body.contains(card)) {
      card = document.createElement('div');
      card.className = 'engink-connect-card';
      card.setAttribute('role', 'status');
      card.innerHTML = `
        <div class="engink-connect-head"><span class="engink-connect-icon">🖋️</span><span class="engink-connect-title">EngInk is mirroring</span>
          <button class="engink-connect-x" data-act="dismiss" title="Dismiss">×</button></div>
        <div class="engink-connect-body"></div>
        <div class="engink-connect-actions">
          <button class="engink-connect-btn primary" data-act="open">Open mirror</button>
          <button class="engink-connect-btn" data-act="dismiss">Dismiss</button>
        </div>`;
      card.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        hideConnectCard();
        if (b.dataset.act === 'open' && typeof window.openEngineeringUtility === 'function') window.openEngineeringUtility('engink');
      });
      // Hovering keeps it up; leaving restarts the countdown.
      card.addEventListener('mouseenter', () => clearTimeout(cardHideT));
      card.addEventListener('mouseleave', () => { clearTimeout(cardHideT); cardHideT = setTimeout(hideConnectCard, 8000); });
      document.body.appendChild(card);
    }
    card.querySelector('.engink-connect-body').innerHTML = `<b>${escapeHtml(device || 'Your tablet')}</b> connected. Open the mirror to watch your notebook live.`;
    requestAnimationFrame(() => card.classList.add('show'));
    clearTimeout(cardHideT);
    cardHideT = setTimeout(hideConnectCard, 15000);
  }
  function hideConnectCard() {
    clearTimeout(cardHideT);
    if (card) card.classList.remove('show');
  }

  // Subscribe once to the main-process stream (from startup via listen(), or when the utility mounts),
  // so the model is already current when the mirror opens.
  function subscribe() {
    if (subscribed || !(window.api && window.api.engink)) return;
    window.api.engink.onMessage(handle);
    window.api.engink.onStatus((s) => { model.server = { running: !!s.running, host: s.host || '', port: s.port || 0, code: s.code || '' }; model.connected = s.clients || []; refreshStatus(); });
    subscribed = true;
  }

  // ---- internet mirroring (through the signed-in EngOrg account) ----
  // When the tablet can't reach this PC on the Wi-Fi (apartment / campus networks often block
  // device-to-device traffic), it mirrors through Firestore instead: users/{uid}/data/inkMirror holds
  // the session (device, notebook, viewport, heartbeat) and its `pages` subcollection one gzipped page
  // each. We translate that into the same messages the LAN socket delivers, so everything downstream
  // (the canvas, the popup, Export PDF) is shared.
  const cloud = (() => {
    let unsubMeta = null, unsubPages = null, session = null, notebookId = null, lastBeat = 0, staleT = null;
    const FRESH_MS = 2 * 60 * 1000;   // a session counts as live if the tablet spoke this recently
    const STALE_MS = 3 * 60 * 1000;   // …and ends if its heartbeat stops this long

    async function gunzip(b64) {
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    }

    function end() {
      if (unsubPages) { unsubPages(); unsubPages = null; }
      if (session) handle({ t: 'client', connected: false, device: session.device });
      session = null; notebookId = null;
      clearInterval(staleT); staleT = null;
    }

    function watchPages(base, id) {
      if (unsubPages) unsubPages();
      unsubPages = base.doc('inkMirror').collection('pages').where('session', '==', id).onSnapshot(snap => {
        snap.docChanges().forEach(async (ch) => {
          if (ch.type === 'removed') return;
          const d = ch.doc.data();
          try { handle({ t: 'page', index: d.index, recs: JSON.parse(await gunzip(d.z)) }); } catch (e) { console.warn('EngInk cloud page failed', e); }
        });
      }, err => console.warn('EngInk cloud pages:', err && err.code));
    }

    function onMeta(snap) {
      const d = snap.exists ? snap.data() : null;
      const live = d && d.active && (Date.now() - (d.updatedAt || 0) < FRESH_MS);
      if (!live) { if (session && (!d || !d.active)) end(); return; }
      lastBeat = d.updatedAt || Date.now();
      const base = firebaseSync.db.collection('users').doc(firebaseSync.user.uid).collection('data');
      if (!session || session.id !== d.session) {
        if (session) end();
        session = { id: d.session, device: (d.device || 'Tablet') + ' (over the internet)' };
        handle({ t: 'client', connected: true, device: session.device });
        watchPages(base, d.session);
        clearInterval(staleT);
        staleT = setInterval(() => { if (Date.now() - lastBeat > STALE_MS) end(); }, 30000);
      }
      try {
        const nb = d.notebook ? JSON.parse(d.notebook) : null;
        if (nb && nb.id !== notebookId) { notebookId = nb.id; handle(Object.assign({ t: 'open' }, nb)); watchPages(base, d.session); }
        if (d.view) handle(Object.assign({ t: 'view' }, JSON.parse(d.view)));
      } catch (_) { /* malformed meta — wait for the next write */ }
    }

    function attach() {
      detach();
      if (typeof firebaseSync === 'undefined' || !firebaseSync.user || !firebaseSync.db) return;
      const base = firebaseSync.db.collection('users').doc(firebaseSync.user.uid).collection('data');
      unsubMeta = base.doc('inkMirror').onSnapshot({ includeMetadataChanges: false }, onMeta, err => console.warn('EngInk cloud:', err && err.code));
    }
    function detach() { if (unsubMeta) { unsubMeta(); unsubMeta = null; } end(); }

    let started = false;
    return {
      start() {
        if (started) return; started = true;
        window.addEventListener('auth-changed', (e) => { if (e.detail && e.detail.signedIn) attach(); else detach(); });
        attach();   // already signed in before we got here
      },
    };
  })();

  // ---- build DOM ----
  function build() {
    root.innerHTML = `
      <div class="engink-wrap">
        <div class="engink-bar">
          <span class="engink-title">EngInk mirror</span>
          <button class="engink-btn engink-status" data-act="pair" title="Show or hide the pairing details"></button>
          <button class="engink-btn" data-act="toggle">Start server</button>
          <button class="engink-btn" data-act="follow" title="Follow the tablet's current page">Follow tablet</button>
          <div class="engink-pagenav">
            <button class="engink-btn engink-ic" data-act="prev">‹</button>
            <span class="engink-pagelabel">1 / 1</span>
            <button class="engink-btn engink-ic" data-act="next">›</button>
          </div>
          <button class="engink-btn engink-ic" data-act="zoomout" title="Zoom out">−</button>
          <button class="engink-btn engink-ic" data-act="zoomin" title="Zoom in">+</button>
          <button class="engink-btn engink-ic" data-act="fit" title="Fit the whole page">⤢</button>
          <button class="engink-btn" data-act="width" title="Fill the width (scroll to move down the page)">↔ Width</button>
          <button class="engink-btn engink-ic" data-act="full" title="Full screen">⛶</button>
          <button class="engink-btn" data-act="submit" title="Hand this notebook in to an assignment">📤 Submit</button>
          <button class="engink-btn" data-act="pdf">Export PDF</button>
        </div>
        <div class="engink-pair"></div>
        <div class="engink-stage engink-waiting"><canvas></canvas></div>
      </div>`;
    barEl = root.querySelector('.engink-bar');
    pairEl = root.querySelector('.engink-pair');
    stageEl = root.querySelector('.engink-stage');
    canvas = stageEl.querySelector('canvas');
    ctx = canvas.getContext('2d');
    pageLabel = root.querySelector('.engink-pagelabel');

    barEl.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'pair') { model.showPair = !model.showPair; refreshStatus(); return; }
      if (act === 'toggle') {
        if (model.server.running) { await window.api.engink.stop(); model.server.running = false; refreshStatus(); }
        else { model.server = { running: false, ...(await window.api.engink.start()) }; model.server.running = true; refreshStatus(); }
      } else if (act === 'follow') { model.pinnedPage = null; look.zoom = 1; look.panX = 0; look.panY = 0; refreshStatus(); requestRender(); }
      else if (act === 'prev') { model.pinnedPage = Math.max(0, curPage() - 1); updatePageLabel(); refreshStatus(); requestRender(); }
      else if (act === 'next') { model.pinnedPage = Math.min(pageCount() - 1, curPage() + 1); updatePageLabel(); refreshStatus(); requestRender(); }
      else if (act === 'zoomin') { zoomAt(1.25, stageEl.clientWidth / 2, stageEl.clientHeight / 2); requestRender(); }
      else if (act === 'zoomout') { zoomAt(0.8, stageEl.clientWidth / 2, stageEl.clientHeight / 2); requestRender(); }
      else if (act === 'fit') { look.mode = 'page'; look.zoom = 1; look.panX = 0; look.panY = 0; syncModeButtons(); requestRender(); }
      else if (act === 'width') { look.mode = 'width'; look.zoom = 1; toTop(); syncModeButtons(); requestRender(); }
      else if (act === 'full') setFullscreen(!root.querySelector('.engink-wrap.engink-full'));
      else if (act === 'pdf') exportPdf();
      else if (act === 'submit') openSubmit();
    });

    // Inspect: wheel to zoom, drag to pan (desktop-side only; the tablet is unaffected).
    // Wheel / two-finger scroll moves around the page; Ctrl+wheel (or a trackpad pinch) zooms at the cursor.
    stageEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageEl.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        const r = stageEl.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * unit * 0.0025), e.clientX - r.left, e.clientY - r.top);
      } else {
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
        look.panX -= dx; look.panY -= dy;
      }
      requestRender();
    }, { passive: false });
    // Esc leaves full screen; PageUp / PageDown / arrows scroll.
    root.tabIndex = -1;
    root.addEventListener('keydown', (e) => {
      const full = root.querySelector('.engink-wrap.engink-full');
      if (e.key === 'Escape' && full) { setFullscreen(false); e.stopPropagation(); return; }
      const step = { ArrowDown: 60, ArrowUp: -60, PageDown: stageEl.clientHeight * 0.85, PageUp: -stageEl.clientHeight * 0.85 }[e.key];
      if (step) { look.panY -= step; requestRender(); e.preventDefault(); }
    });
    stageEl.addEventListener('pointerdown', () => root.focus({ preventScroll: true }));
    let drag = null;
    stageEl.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; stageEl.setPointerCapture(e.pointerId); });
    stageEl.addEventListener('pointermove', (e) => { if (!drag) return; look.panX += e.clientX - drag.x; look.panY += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; requestRender(); });
    stageEl.addEventListener('pointerup', () => { drag = null; });
    stageEl.addEventListener('pointercancel', () => { drag = null; });

    ro = new ResizeObserver(() => requestRender());
    ro.observe(stageEl);
    built = true;
  }

  return {
    mount(el) {
      root = el;
      if (!built) build();
      subscribe();
    },
    /** Start following the tablet stream at app startup (the server itself auto-starts in main). */
    listen() { subscribe(); cloud.start(); },
    async activate() {
      active = true;
      hideConnectCard();
      // Start (idempotent) so pairing info is ready the moment the tab opens.
      try {
        const s = await window.api.engink.start();
        model.server = { running: !!s.running, host: s.host || '', port: s.port || 0, code: s.code || '' };
        model.connected = s.clients || [];
      } catch (_) {}
      refreshStatus();
      requestRender();
    },
    deactivate() { active = false; setFullscreen(false); },
  };
})();
