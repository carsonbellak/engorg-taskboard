// 3D Print Tracker — records every print you send to the printer: archives the
// STL + G-code, documents the settings used, asks which project it's for, and
// (when the print finishes) asks whether it succeeded and — if not — why. Failed
// prints get a categorized reason so mistakes can be charted, and the winning
// settings roll up into "best profiles" per material + layer height.
//
// Works in both the tabbed app (Slicer / Print History) and the organic view.
// Printer-status auto-detection uses Moonraker; if the printer isn't reachable
// you can still mark prints done manually from the history panel.

const printTracker = (() => {
  let pollTimer = null;
  const MAT_RE = /\b(PLA\+?|PETG|ABS|ASA|TPU|PC|PA-?CF|PA|Nylon|HIPS|PVA|PP|CF|Wood|Silk)\b/i;
  const FAIL_CATS = [
    { key: 'adhesion', label: 'Bed adhesion / warping' },
    { key: 'supports', label: 'Supports failed / hard to remove' },
    { key: 'stringing', label: 'Stringing / oozing' },
    { key: 'layer-shift', label: 'Layer shift' },
    { key: 'under-extrusion', label: 'Under / over-extrusion' },
    { key: 'temp', label: 'Temperature / cooling' },
    { key: 'clog', label: 'Clog / jam / ran out' },
    { key: 'model', label: 'Model / orientation issue' },
    { key: 'knocked', label: 'Knocked / mechanical' },
    { key: 'other', label: 'Something else' },
  ];
  const SETTINGS_FAILS = new Set(['adhesion', 'supports', 'stringing', 'under-extrusion', 'temp']); // "print settings mistakes"

  function baseUrl() { const s = dataManager.settings || {}; return `http://${s.printerIp || '192.168.0.130'}:${s.printerPort || '7125'}`; }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
  function materialOf(meta) {
    const src = (meta.filamentProfile && meta.filamentProfile.name) || meta.material || '';
    const m = String(src).match(MAT_RE);
    return m ? m[1].toUpperCase() : (src ? String(src).split(' ').pop() : 'Unknown');
  }
  function projName(id) { const p = (dataManager.projects || []).find(x => x.id === id); return p ? p.name : ''; }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'pt-toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
  }

  // ---- generic themed picker overlay -------------------------------------
  function chooseOption(title, options, { allowNone } = {}) {
    return new Promise(resolve => {
      const ov = document.createElement('div'); ov.className = 'pt-overlay';
      ov.innerHTML = `<div class="pt-sheet"><h2>${esc(title)}</h2><div class="pt-opts">`
        + options.map((o, i) => `<button class="pt-opt" data-i="${i}">${esc(o.label)}</button>`).join('')
        + (allowNone ? `<button class="pt-opt pt-opt-none" data-none>Skip</button>` : '')
        + `</div></div>`;
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); resolve(v); };
      ov.addEventListener('click', (e) => {
        if (e.target === ov) return done(allowNone ? null : undefined);
        const b = e.target.closest('[data-i]'); if (b) return done(options[+b.dataset.i].value);
        if (e.target.closest('[data-none]')) return done(null);
      });
    });
  }
  function pickProject(title) {
    const opts = (dataManager.projects || []).map(p => ({ label: p.name, value: p.id }));
    if (!opts.length) return Promise.resolve(null);
    return chooseOption(title, opts, { allowNone: true });
  }

  // ===================== CAPTURE ON SEND =================================
  async function onPrintStarted(meta) {
    // meta: { modelPath, modelName, gcodePath, layerHeight, infill, supports, ironing,
    //         processProfile, filamentProfile, estimates }
    const material = materialOf(meta);
    const projectId = await pickProject(`Which project is “${meta.modelName || 'this print'}” for?`);
    const id = dataManager._genId('print');
    let archived = { stl: null, gcode: null };
    try { archived = await window.api.printHistory.archive({ id, stlPath: meta.modelPath, gcodePath: meta.gcodePath }); } catch (e) {}
    const entry = {
      id, projectId: projectId || null, modelName: meta.modelName || 'Print',
      material, layerHeight: meta.layerHeight, infill: meta.infill, supports: meta.supports, ironing: meta.ironing || false,
      processProfile: meta.processProfile ? { name: meta.processProfile.name, source: meta.processProfile.source } : null,
      filamentProfile: meta.filamentProfile ? { name: meta.filamentProfile.name, source: meta.filamentProfile.source } : null,
      estimates: meta.estimates || {},
      stlArchive: archived.stl || meta.modelPath || null,
      gcodeArchive: archived.gcode || meta.gcodePath || null,
      gcodeFilename: (meta.gcodePath || '').split(/[\\/]/).pop() || null,
      sentAt: new Date().toISOString(), status: 'printing', completedAt: null, failCategory: null, failReason: null,
    };
    await dataManager.addPrint(entry);
    window.dispatchEvent(new CustomEvent('prints-changed'));
    toast(`📦 Tracking print “${entry.modelName}”${projectId ? ' · ' + projName(projectId) : ''}`);
    startPolling();
    return entry;
  }

  // ===================== COMPLETION DETECTION ============================
  function startPolling() { if (pollTimer) return; pollTimer = setInterval(checkPrints, 20000); setTimeout(checkPrints, 4000); }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  async function checkPrints() {
    const active = (dataManager.getPrints() || []).filter(p => p.status === 'printing' && !p._prompting);
    if (!active.length) { stopPolling(); return; }
    let stats = null;
    try { const r = await window.api.printer.apiGet(baseUrl(), '/printer/objects/query?print_stats'); stats = r && r.result && r.result.status && r.result.status.print_stats; } catch (e) { return; }
    if (!stats) return;
    if (stats.state === 'complete' || stats.state === 'standby') {
      const p = active.find(x => x.gcodeFilename && stats.filename && String(stats.filename).includes(x.gcodeFilename)) || active[active.length - 1];
      if (p) { p._prompting = true; await promptOutcome(p); }
    }
  }
  async function promptOutcome(p) {
    const ok = await window._showConfirm({ title: '🖨️ Print finished', message: `Did “${p.modelName}” print successfully?`, confirmText: 'Yes, success', cancelText: 'No, it failed' });
    if (ok) {
      await dataManager.updatePrint(p.id, { status: 'success', completedAt: new Date().toISOString(), _prompting: false });
      toast(`✅ Logged a successful ${p.material} print`);
    } else {
      const cat = await chooseOption('What went wrong?', FAIL_CATS.map(c => ({ label: c.label, value: c.key })));
      const why = await window._showPrompt({ title: 'A quick note', message: 'What happened? (optional)', placeholder: 'e.g. corner lifted on the left', confirmText: 'Save' });
      await dataManager.updatePrint(p.id, { status: 'fail', completedAt: new Date().toISOString(), failCategory: cat || 'other', failReason: why || '', settingsFault: SETTINGS_FAILS.has(cat), _prompting: false });
      toast(`📊 Logged a failed print — charted under “${(FAIL_CATS.find(c => c.key === cat) || {}).label || 'Other'}”`);
    }
    window.dispatchEvent(new CustomEvent('prints-changed'));
  }
  function markDone(id) { const p = (dataManager.getPrints() || []).find(x => x.id === id); if (p && p.status === 'printing') { p._prompting = true; promptOutcome(p); } }

  // ===================== ANALYSIS =======================================
  function stats() {
    const prints = dataManager.getPrints() || [];
    const finished = prints.filter(p => p.status === 'success' || p.status === 'fail');
    const succ = finished.filter(p => p.status === 'success');
    const fails = finished.filter(p => p.status === 'fail');
    const byCat = {};
    for (const f of fails) { const k = f.failCategory || 'other'; byCat[k] = (byCat[k] || 0) + 1; }
    return {
      total: prints.length, printing: prints.filter(p => p.status === 'printing').length,
      success: succ.length, fail: fails.length,
      rate: finished.length ? succ.length / finished.length : null,
      settingsFaults: fails.filter(f => f.settingsFault).length,
      byCat,
    };
  }
  // Best profile per material + layer height, from successful prints.
  function bestProfiles() {
    const succ = (dataManager.getPrints() || []).filter(p => p.status === 'success' && p.material);
    const map = {};
    for (const p of succ) { const k = `${p.material}|${p.layerHeight || '?'}`; (map[k] = map[k] || []).push(p); }
    return Object.entries(map).map(([k, arr]) => {
      const [material, lh] = k.split('|');
      const last = arr[arr.length - 1];
      return { material, layerHeight: lh, count: arr.length, process: last.processProfile, filament: last.filamentProfile, infill: last.infill, supports: last.supports, ironing: last.ironing, lastAt: last.completedAt };
    }).sort((a, b) => b.count - a.count || a.material.localeCompare(b.material));
  }
  function isPrinting() { return (dataManager.getPrints() || []).some(p => p.status === 'printing'); }
  function cameraSnapshotUrl() { return `http://localhost:8765/snapshot?t=`; } // fluidd proxy; empty frame if bridge off

  // ===================== HISTORY PANEL ==================================
  function openHistory() {
    const s = stats(); const best = bestProfiles(); const prints = (dataManager.getPrints() || []).slice().reverse();
    const catLabel = (k) => (FAIL_CATS.find(c => c.key === k) || {}).label || k;
    const maxCat = Math.max(1, ...Object.values(s.byCat));
    const badge = (st) => `<span class="pt-badge ${st}">${st === 'printing' ? '● printing' : st === 'success' ? '✓ success' : st === 'fail' ? '✕ fail' : st}</span>`;
    const ov = document.createElement('div'); ov.className = 'pt-overlay';
    ov.innerHTML = `<div class="pt-sheet pt-wide"><button class="pt-close" title="Close">×</button>
      <h2>🖨️ Print History</h2>
      <div class="pt-tiles">
        <div class="pt-tile"><div class="pt-num">${s.total}</div><div class="pt-cap">prints tracked</div></div>
        <div class="pt-tile"><div class="pt-num">${s.rate == null ? '—' : Math.round(s.rate * 100) + '%'}</div><div class="pt-cap">success rate</div></div>
        <div class="pt-tile"><div class="pt-num">${s.settingsFaults}</div><div class="pt-cap">settings mistakes</div></div>
        <div class="pt-tile"><div class="pt-num">${s.printing}</div><div class="pt-cap">printing now</div></div>
      </div>
      ${best.length ? `<h3 class="pt-h">Best profiles</h3><div class="pt-best">${best.map(b => `<div class="pt-best-card"><div class="pt-best-mat">${esc(b.material)} · ${esc(b.layerHeight)}mm</div><div class="pt-best-meta">${b.process ? esc(b.process.name) : '—'}${b.filament ? ' · ' + esc(b.filament.name) : ''}</div><div class="pt-best-set">infill ${b.infill != null ? b.infill + '%' : '—'} · supports ${b.supports ? (b.supports === true ? 'on' : esc(b.supports)) : 'off'} · ${b.count}× success</div></div>`).join('')}</div>` : ''}
      ${s.fail ? `<h3 class="pt-h">Failure breakdown</h3><div class="pt-chart">${Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div class="pt-bar-row"><span class="pt-bar-lb">${esc(catLabel(k))}</span><span class="pt-bar-track"><span class="pt-bar-fill" style="width:${Math.round(n / maxCat * 100)}%"></span></span><span class="pt-bar-n">${n}</span></div>`).join('')}</div>` : ''}
      <h3 class="pt-h">All prints</h3>
      <div class="pt-list">${prints.length ? prints.map(p => `<div class="pt-row" data-id="${esc(p.id)}">
        <div class="pt-row-main"><div class="pt-row-title">${esc(p.modelName)} ${badge(p.status)}</div>
        <div class="pt-row-sub">${esc(p.material || '')}${p.layerHeight ? ' · ' + esc(p.layerHeight) + 'mm' : ''}${p.projectId ? ' · ' + esc(projName(p.projectId)) : ''} · ${new Date(p.sentAt).toLocaleDateString()}${p.status === 'fail' && p.failCategory ? ' · ' + esc(catLabel(p.failCategory)) : ''}</div></div>
        <div class="pt-row-act">${p.status === 'printing' ? `<button data-act="done" data-id="${esc(p.id)}">Mark done</button>` : ''}<button data-act="folder" data-id="${esc(p.id)}" title="Open files">📁</button><button data-act="del" data-id="${esc(p.id)}" title="Delete">🗑</button></div>
      </div>`).join('') : `<div class="pt-empty">No prints tracked yet. Slice something and hit “Upload &amp; Print”.</div>`}</div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector('.pt-close').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.dataset.id, act = b.dataset.act;
      if (act === 'done') { close(); markDone(id); }
      else if (act === 'folder') { window.api.printHistory.openArchive(id); }
      else if (act === 'del') { if (await window._showConfirm({ title: 'Delete print record?', message: 'Remove this print from history? (archived files stay on disk.)', confirmText: 'Delete', danger: true })) { await dataManager.deletePrint(id); window.dispatchEvent(new CustomEvent('prints-changed')); close(); openHistory(); } }
    });
  }

  // On load, resume polling if a print was left "printing".
  function init() { if (isPrinting()) startPolling(); }

  return { onPrintStarted, openHistory, bestProfiles, stats, isPrinting, cameraSnapshotUrl, markDone, init };
})();

window.printTracker = printTracker;
window.openPrintHistory = () => printTracker.openHistory();
