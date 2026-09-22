// File Merger utility — combine any number of PDFs and images into a single PDF,
// in a user-arranged order. Add files via the native dialog, drag rows (or use the
// ↑/↓ buttons) to reorder, pick how images are laid out, then export to one PDF.
//
// The assembly runs here in the renderer with the bundled pdf-lib global
// (renderer/lib/pdf-lib.min.js → window.PDFLib): PDF inputs have their pages
// copied straight in; image inputs are embedded on their own page. Arbitrary image
// formats (webp/gif/bmp, or odd JP/PNG variants) are normalized through a <canvas>
// to PNG bytes that pdf-lib can embed. The native open/save dialogs and the actual
// file write live in main (window.api.fileMerger.* → ipc/file-merger.js). Reading
// each input's bytes reuses window.api.files.readBinary. Desktop-only utility.

const fileMerger = (() => {
  const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

  let mounted = false;
  let files = [];        // [{ uid, name, path, ext, size, meta }]
  let counter = 0;
  let busy = false;
  let dragUid = null;    // uid of the row being dragged (reorder)
  let pageSize = 'auto'; // 'auto' | 'letter' | 'a4'

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  const isPdf = (f) => f.ext === 'pdf';
  const iconFor = (f) => (isPdf(f) ? '📄' : '🖼️');

  // ---- mount / render ------------------------------------------------------
  function render(container) {
    container.innerHTML = `
      <div class="fmerge">
        <div class="fmerge-head">
          <div class="fmerge-title">📎 File Merger</div>
          <div class="fmerge-sub">Combine PDFs and images into a single PDF — drag to arrange the order.</div>
        </div>
        <div class="fmerge-toolbar">
          <button id="fmerge-add" class="kicad-btn kicad-btn-start">➕ Add files…</button>
          <button id="fmerge-clear" class="kicad-btn kicad-btn-outline">Clear</button>
          <div class="fmerge-spacer"></div>
          <label class="fmerge-opt">Image pages
            <select id="fmerge-pagesize" class="kicad-input fmerge-select">
              <option value="auto">Fit to image</option>
              <option value="letter">Letter</option>
              <option value="a4">A4</option>
            </select>
          </label>
        </div>
        <div id="fmerge-list" class="fmerge-list"></div>
        <div class="fmerge-footer">
          <div id="fmerge-status" class="fmerge-status"></div>
          <button id="fmerge-merge" class="kicad-btn kicad-btn-start fmerge-merge">Merge → PDF</button>
        </div>
      </div>`;

    container.querySelector('#fmerge-add').addEventListener('click', addFiles);
    container.querySelector('#fmerge-clear').addEventListener('click', () => { if (!busy) { files = []; renderList(); setStatus(''); } });
    container.querySelector('#fmerge-merge').addEventListener('click', merge);
    const sel = container.querySelector('#fmerge-pagesize');
    sel.value = pageSize;
    sel.addEventListener('change', () => { pageSize = sel.value; });

    renderList();
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('fmerge-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'fmerge-status' + (kind ? ' fmerge-status-' + kind : '');
  }

  function renderList() {
    const list = document.getElementById('fmerge-list');
    if (!list) return;
    const mergeBtn = document.getElementById('fmerge-merge');
    if (mergeBtn) mergeBtn.disabled = busy || files.length === 0;

    if (!files.length) {
      list.innerHTML = `<div class="kicad-empty">No files yet. Click “Add files…” to choose PDFs and images.</div>`;
      return;
    }
    list.innerHTML = files.map((f, i) => `
      <div class="fmerge-row" draggable="true" data-uid="${f.uid}">
        <span class="fmerge-grip" title="Drag to reorder">⠿</span>
        <span class="fmerge-idx">${i + 1}</span>
        <span class="fmerge-icon">${iconFor(f)}</span>
        <span class="fmerge-info">
          <span class="fmerge-name" title="${esc(f.path)}">${esc(f.name)}</span>
          <span class="fmerge-meta">${esc(f.meta || fmtBytes(f.size))}</span>
        </span>
        <span class="fmerge-actions">
          <button class="fmerge-mini" data-act="up" data-uid="${f.uid}" title="Move up"${i === 0 ? ' disabled' : ''}>▲</button>
          <button class="fmerge-mini" data-act="down" data-uid="${f.uid}" title="Move down"${i === files.length - 1 ? ' disabled' : ''}>▼</button>
          <button class="fmerge-mini fmerge-remove" data-act="remove" data-uid="${f.uid}" title="Remove">✕</button>
        </span>
      </div>`).join('');

    list.querySelectorAll('.fmerge-mini').forEach(b => {
      b.addEventListener('click', () => {
        if (busy) return;
        const uid = b.dataset.uid, act = b.dataset.act;
        const idx = files.findIndex(f => f.uid === uid);
        if (idx < 0) return;
        if (act === 'remove') files.splice(idx, 1);
        else if (act === 'up' && idx > 0) [files[idx - 1], files[idx]] = [files[idx], files[idx - 1]];
        else if (act === 'down' && idx < files.length - 1) [files[idx + 1], files[idx]] = [files[idx], files[idx + 1]];
        renderList();
      });
    });

    // Drag-to-reorder (within the app; operates on uids, not paths)
    list.querySelectorAll('.fmerge-row').forEach(row => {
      row.addEventListener('dragstart', (e) => { if (busy) { e.preventDefault(); return; } dragUid = row.dataset.uid; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragend', () => { dragUid = null; row.classList.remove('dragging'); list.querySelectorAll('.fmerge-row').forEach(r => r.classList.remove('drop-before', 'drop-after')); });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragUid || row.dataset.uid === dragUid) return;
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        row.classList.toggle('drop-after', after);
        row.classList.toggle('drop-before', !after);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragUid) return;
        const from = files.findIndex(f => f.uid === dragUid);
        let to = files.findIndex(f => f.uid === row.dataset.uid);
        if (from < 0 || to < 0 || from === to) return;
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        const [moved] = files.splice(from, 1);
        to = files.findIndex(f => f.uid === row.dataset.uid);
        files.splice(after ? to + 1 : to, 0, moved);
        renderList();
      });
    });
  }

  // ---- adding files --------------------------------------------------------
  async function addFiles() {
    if (busy) return;
    if (!window.api || !window.api.fileMerger || typeof window.api.fileMerger.selectFiles !== 'function') {
      setStatus('File Merger isn’t active yet — fully quit and relaunch the app (a page reload isn’t enough).', 'err');
      return;
    }
    let picked;
    try {
      picked = await window.api.fileMerger.selectFiles();
    } catch (err) {
      setStatus('Couldn’t open the file picker: ' + (err && err.message ? err.message : err) + ' — try fully restarting the app.', 'err');
      return;
    }
    if (!picked || !picked.length) return;
    for (const p of picked) {
      const ext = (p.ext || (p.name.split('.').pop() || '')).toLowerCase();
      if (ext !== 'pdf' && !IMAGE_EXTS.has(ext)) continue; // ignore unsupported picks
      counter += 1;
      const entry = { uid: 'fm' + counter, name: p.name, path: p.path, ext, size: p.size || 0, meta: '' };
      files.push(entry);
      describe(entry); // fill in page count / dimensions in the background
    }
    renderList();
    setStatus('');
  }

  // Non-blocking metadata: PDF page count / image pixel dimensions.
  async function describe(entry) {
    try {
      const ab = await window.api.files.readBinary(entry.path);
      const bytes = new Uint8Array(ab);
      if (isPdf(entry)) {
        const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const n = doc.getPageCount();
        entry.meta = `PDF · ${n} page${n === 1 ? '' : 's'} · ${fmtBytes(entry.size)}`;
      } else {
        const dim = await imageDimensions(bytes, entry.ext);
        entry.meta = `${entry.ext.toUpperCase()}${dim ? ` · ${dim.w}×${dim.h}` : ''} · ${fmtBytes(entry.size)}`;
      }
    } catch (_) {
      entry.meta = `${entry.ext.toUpperCase()} · ${fmtBytes(entry.size)}`;
    }
    // Update just this row's meta if still present
    const row = document.querySelector(`.fmerge-row[data-uid="${entry.uid}"] .fmerge-meta`);
    if (row) row.textContent = entry.meta;
  }

  function imageDimensions(bytes, ext) {
    return new Promise((resolve) => {
      const blob = new Blob([bytes], { type: mimeFor(ext) });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { const d = { w: img.naturalWidth, h: img.naturalHeight }; URL.revokeObjectURL(url); resolve(d); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function mimeFor(ext) {
    return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' })[ext] || 'application/octet-stream';
  }

  // ---- merge ---------------------------------------------------------------
  async function merge() {
    if (busy || !files.length) return;
    if (typeof PDFLib === 'undefined') { setStatus('PDF engine failed to load.', 'err'); return; }
    busy = true;
    const mergeBtn = document.getElementById('fmerge-merge');
    if (mergeBtn) { mergeBtn.disabled = true; mergeBtn.textContent = 'Merging…'; }

    const { PDFDocument } = PDFLib;
    const outDoc = await PDFDocument.create();
    const failures = [];
    let pagesAdded = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus(`Processing ${i + 1}/${files.length}: ${f.name}…`);
        try {
          const ab = await window.api.files.readBinary(f.path);
          const bytes = new Uint8Array(ab);
          if (isPdf(f)) {
            const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
            const copied = await outDoc.copyPages(src, src.getPageIndices());
            copied.forEach(p => { outDoc.addPage(p); pagesAdded++; });
          } else {
            await addImagePage(outDoc, f.ext, bytes);
            pagesAdded++;
          }
        } catch (err) {
          failures.push({ name: f.name, error: err.message });
        }
      }

      if (!pagesAdded) {
        setStatus(`Nothing to merge — every file failed. ${failures[0] ? '(' + failures[0].error + ')' : ''}`, 'err');
        return;
      }

      if (failures.length) {
        const list = failures.map(x => `• ${x.name}`).join('\n');
        const opts = {
          title: 'Some files were skipped',
          message: `${failures.length} file(s) couldn't be added:\n${list}\n\nSave a PDF with the remaining ${pagesAdded} page(s)?`,
          confirmText: 'Save anyway',
        };
        const go = window._showConfirm ? await window._showConfirm(opts) : window.confirm(opts.message);
        if (!go) { setStatus('Merge cancelled.', ''); return; }
      }

      setStatus('Saving…');
      const outBytes = await outDoc.save();
      const res = await window.api.fileMerger.save(outBytes, suggestName());
      if (res && res.path) {
        setStatus(`Saved ${pagesAdded} page(s) → ${res.path}`, 'ok');
        window.api.files.openPath(res.path);
      } else if (res && res.error) {
        setStatus('Save failed: ' + res.error, 'err');
      } else {
        setStatus('Save cancelled.', '');
      }
    } catch (err) {
      setStatus('Merge failed: ' + (err && err.message ? err.message : err), 'err');
    } finally {
      busy = false;
      if (mergeBtn) { mergeBtn.textContent = 'Merge → PDF'; mergeBtn.disabled = files.length === 0; }
      renderList();
    }
  }

  async function addImagePage(outDoc, ext, bytes) {
    const img = await embedImage(outDoc, ext, bytes);
    const iw = img.width, ih = img.height;
    if (pageSize === 'auto') {
      const page = outDoc.addPage([iw, ih]);
      page.drawImage(img, { x: 0, y: 0, width: iw, height: ih });
      return;
    }
    let [pw, ph] = PAGE_SIZES[pageSize] || PAGE_SIZES.letter;
    if (iw > ih) [pw, ph] = [ph, pw]; // landscape for wide images
    const page = outDoc.addPage([pw, ph]);
    const margin = 36; // 0.5 inch
    const scale = Math.min((pw - margin * 2) / iw, (ph - margin * 2) / ih);
    const w = iw * scale, h = ih * scale;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }

  // Embed an image, trying the native path first and falling back to a canvas
  // re-encode (handles webp/gif/bmp and any JPG/PNG variant pdf-lib rejects).
  async function embedImage(outDoc, ext, bytes) {
    try {
      if (ext === 'jpg' || ext === 'jpeg') return await outDoc.embedJpg(bytes);
      if (ext === 'png') return await outDoc.embedPng(bytes);
    } catch (_) { /* fall through to canvas normalization */ }
    const png = await toPngBytes(bytes, ext);
    return await outDoc.embedPng(png);
  }

  function toPngBytes(bytes, ext) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([bytes], { type: mimeFor(ext) });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(async (out) => {
            URL.revokeObjectURL(url);
            if (!out) { reject(new Error('could not encode image')); return; }
            resolve(new Uint8Array(await out.arrayBuffer()));
          }, 'image/png');
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unsupported or corrupt image')); };
      img.src = url;
    });
  }

  function suggestName() {
    if (files.length === 1) {
      const base = files[0].name.replace(/\.[^.]+$/, '');
      return base + '.pdf';
    }
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `merged-${stamp}.pdf`;
  }

  // ---- public API ----------------------------------------------------------
  return {
    mount(container) { if (!mounted) { render(container); mounted = true; } },
    activate() { if (mounted) renderList(); },
    deactivate() {},
  };
})();
