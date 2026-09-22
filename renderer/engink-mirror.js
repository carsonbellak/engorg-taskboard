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
//   { t:'page', index, recs:[{ c,w,h,k,segs:[[[x,y]...]] }] }  a page's committed strokes
//   { t:'wet', page, pts:[[x,y]...], c, w, h }               in-progress stroke
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
  };
  // Desktop-side inspection transform (independent of the tablet).
  const look = { zoom: 1, panX: 0, panY: 0 };

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
        } else {
          model.connected = model.connected.filter(c => c.device !== msg.device);
          if (!model.connected.length) { model.notebook = null; model.pages.clear(); model.wet = null; model.view = null; }
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
    return Math.min(cssW / PAGE_W, cssH / PAGE_H) * 0.96 * look.zoom;
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
      for (const seg of (rec.segs || [])) {
        ctx.beginPath();
        if (smooth) traceSmooth(seg.map(p => [p[0] * s, p[1] * s]));
        else traceStraight(seg.map(p => [p[0] * s, p[1] * s]));
        ctx.stroke();
      }
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

  function refreshStatus() {
    if (!built) return;
    const sv = model.server;
    const conn = model.connected;
    const followOn = model.pinnedPage == null;
    pairEl.innerHTML = sv.running
      ? `<div class="engink-pair-grid">
           <div class="engink-pair-cell"><span class="engink-k">This PC</span><b>${escapeHtml(sv.host)}:${sv.port}</b></div>
           <div class="engink-pair-cell engink-code"><span class="engink-k">Pairing code</span><b>${escapeHtml(sv.code)}</b></div>
           <div class="engink-pair-cell"><span class="engink-k">Connected</span><b>${conn.length ? escapeHtml(conn.map(c => c.device).join(', ')) : '—'}</b></div>
         </div>
         <div class="engink-hint">On your tablet: open <b>EngInk</b> → tap the <b>Mirror</b> icon → pick this PC (or type <b>${escapeHtml(sv.host)}:${sv.port}</b>) and enter the code.</div>`
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

  // ---- build DOM ----
  function build() {
    root.innerHTML = `
      <div class="engink-wrap">
        <div class="engink-bar">
          <span class="engink-title">EngInk mirror</span>
          <button class="engink-btn" data-act="toggle">Start server</button>
          <button class="engink-btn" data-act="follow" title="Follow the tablet's current page">Follow tablet</button>
          <div class="engink-pagenav">
            <button class="engink-btn engink-ic" data-act="prev">‹</button>
            <span class="engink-pagelabel">1 / 1</span>
            <button class="engink-btn engink-ic" data-act="next">›</button>
          </div>
          <button class="engink-btn engink-ic" data-act="zoomout" title="Zoom out">−</button>
          <button class="engink-btn engink-ic" data-act="zoomin" title="Zoom in">+</button>
          <button class="engink-btn engink-ic" data-act="fit" title="Fit page">⤢</button>
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
      if (act === 'toggle') {
        if (model.server.running) { await window.api.engink.stop(); model.server.running = false; refreshStatus(); }
        else { model.server = { running: false, ...(await window.api.engink.start()) }; model.server.running = true; refreshStatus(); }
      } else if (act === 'follow') { model.pinnedPage = null; look.zoom = 1; look.panX = 0; look.panY = 0; refreshStatus(); requestRender(); }
      else if (act === 'prev') { model.pinnedPage = Math.max(0, curPage() - 1); updatePageLabel(); refreshStatus(); requestRender(); }
      else if (act === 'next') { model.pinnedPage = Math.min(pageCount() - 1, curPage() + 1); updatePageLabel(); refreshStatus(); requestRender(); }
      else if (act === 'zoomin') { look.zoom = Math.min(6, look.zoom * 1.25); requestRender(); }
      else if (act === 'zoomout') { look.zoom = Math.max(0.3, look.zoom * 0.8); requestRender(); }
      else if (act === 'fit') { look.zoom = 1; look.panX = 0; look.panY = 0; requestRender(); }
      else if (act === 'pdf') exportPdf();
    });

    // Inspect: wheel to zoom, drag to pan (desktop-side only; the tablet is unaffected).
    stageEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      look.zoom = Math.min(6, Math.max(0.3, look.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
      requestRender();
    }, { passive: false });
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
      if (!subscribed) {
        window.api.engink.onMessage(handle);
        window.api.engink.onStatus((s) => { model.server = { running: !!s.running, host: s.host || '', port: s.port || 0, code: s.code || '' }; model.connected = s.clients || []; refreshStatus(); });
        subscribed = true;
      }
    },
    async activate() {
      active = true;
      // Start (idempotent) so pairing info is ready the moment the tab opens.
      try {
        const s = await window.api.engink.start();
        model.server = { running: !!s.running, host: s.host || '', port: s.port || 0, code: s.code || '' };
        model.connected = s.clients || [];
      } catch (_) {}
      refreshStatus();
      requestRender();
    },
    deactivate() { active = false; },
  };
})();
