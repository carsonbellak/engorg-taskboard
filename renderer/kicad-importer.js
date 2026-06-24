// KiCad Importer utility — UI for safely APPENDING new parts to an existing
// governance-style shared library (the "Big Blue Library").
//
// Pick the library's .kicad_sym once (auto-detects the .pretty + 3dmodels folders
// and remembers it in settings.json), add UltraLibrarian/SnapMagic ZIPs, optionally
// enrich from DigiKey, review each part (governance name + required metadata), then
// write — which backs up the library and inserts the new symbols without rewriting
// the existing ones. Backed by window.api.kicad.* (see ipc/kicad-importer.js).

const kicadImporter = (() => {
  let mounted = false;
  let zips = [];
  let library = null;   // descriptor: { symLib, libName, sharedRoot, fpLib, fpNickname, modelDir, modelRefDir, symVersion }
  let running = false;

  // ---- Governance helpers --------------------------------------------------
  function typePrefix(dk) {
    const d = (dk.description || '').toLowerCase();
    const has = (ws) => ws.some(w => d.includes(w));
    if (has(['resistor'])) return 'RES';
    if (has(['capacitor'])) return 'CAP';
    if (has(['inductor', 'ferrite'])) return 'IND';
    if (has(['ldo', 'low-dropout', 'low dropout'])) return 'LDO';
    if (has(['voltage reference'])) return 'VREF';
    if (has(['regulator', 'dc dc', 'dc-dc', 'converter'])) return 'REG';
    if (has(['diode', 'rectifier', 'tvs', 'zener', 'schottky'])) return 'DIODE';
    if (has(['relay'])) return 'RELAY';
    if (has(['connector', 'receptacle', 'header', 'plug', 'socket', 'jack'])) return 'CONN';
    if (has(['mosfet', 'transistor', 'bjt'])) return 'TRANSISTOR';
    if (has(['led'])) return 'LED';
    if (has(['op amp', 'opamp', 'operational amplifier'])) return 'OPAMP';
    if (has(['optocoupler', 'opto'])) return 'OPTOCOUPLER';
    if (has(['crystal', 'oscillator'])) return 'CRYSTAL';
    return '';
  }

  function pkgShort(pkg) {
    if (!pkg) return '';
    let m = pkg.match(/\b(0201|0402|0603|0805|1206|1210|2010|2512|2920)\b/);
    if (m) return m[1];
    m = pkg.match(/(SOT-?\d+[-\d]*|SOIC-?\d+|SO-?\d+|TO-?\d+[-\d]*|QFN-?\d+|DIP-?\d+|DO-?\d+\w*|SC-?\d+[-\d]*|SOD-?\d+\w*|TSSOP-?\d+)/i);
    if (m) return m[1].toUpperCase();
    return pkg.split(/[\s(]/)[0];
  }

  // Required metadata per governance §4.1.2, pre-filled from DigiKey cleaned params.
  function requiredFieldsFor(prefix, dk) {
    const cp = dk.cleaned_parameters || {};
    const F = (key, val) => ({ key, value: val || '' });
    switch (prefix) {
      case 'RES': return [F('RESISTANCE', cp.Resistance), F('Power Rating', cp['Power Rating']), F('Tolerance', cp.Tolerance), F('Composition', ''), F('TempCo (PPM)', cp['Temperature Coefficient'])];
      case 'CAP': return [F('CAPACITANCE', cp.Capacitance), F('Voltage Rating', cp['Voltage Rating']), F('Tolerance', cp.Tolerance), F('TempCo', cp['Temperature Coefficient'])];
      case 'CONN': return [F('Voltage Rating', cp['Voltage Rating']), F('Current Rating', cp['Current Rating']), F('Operating Temperature', cp['Operating Temperature'])];
      case 'DIODE': return [F('Reverse Voltage', cp['Reverse Voltage']), F('Current Rating', cp['Current Rating']), F('Operating Temperature', cp['Operating Temperature'])];
      case 'LDO': case 'REG': case 'VREF': return [F('Output Voltage', cp['Output Voltage']), F('Output Current', cp['Output Current']), F('Operating Temperature', cp['Operating Temperature'])];
      case 'RELAY': return [F('Contact Voltage', cp['Contact Voltage']), F('Contact Current', cp['Contact Current']), F('Operating Temperature', cp['Operating Temperature'])];
      default: return [F('Operating Temperature', cp['Operating Temperature'])];
    }
  }

  function suggestName(prefix, dk, mpn) {
    if (!prefix) return mpn;
    const cp = dk.cleaned_parameters || {};
    const clean = (s) => String(s || '').replace(/\s+/g, '').replace(/[^\w./%+-]/g, '');
    const segs = [prefix];
    const pkg = pkgShort(dk.package || '');
    if (pkg) segs.push(pkg);
    if (prefix === 'RES') {
      if (cp.Resistance) segs.push(clean(cp.Resistance));
      if (cp.Tolerance) segs.push(clean(cp.Tolerance));
      if (cp['Temperature Coefficient']) segs.push(clean(cp['Temperature Coefficient']));
      if (cp['Power Rating']) segs.push(clean(cp['Power Rating']));
    } else if (prefix === 'CAP') {
      if (cp.Capacitance) segs.push(clean(cp.Capacitance));
      if (cp.Tolerance) segs.push(clean(cp.Tolerance));
      if (cp['Voltage Rating']) segs.push(clean(cp['Voltage Rating']));
    } else if (mpn) {
      segs.push(clean(mpn));
    }
    return segs.filter(Boolean).join('_');
  }

  // Assemble the Big-Blue-schema base metadata from a DigiKey record.
  function baseFields(dk) {
    const f = {};
    if (!dk || dk.error) return f;
    if (dk.manufacturer && dk.manufacturer !== 'Unknown') f['Manufacturer'] = dk.manufacturer;
    if (dk.mpn) f['Manufacturer PN'] = dk.mpn;
    f['Supplier'] = 'Digikey';
    if (dk.digikey_pn && dk.digikey_pn !== 'N/A') f['Supplier PN'] = dk.digikey_pn;
    if (dk.product_url) f['Supplier Link'] = dk.product_url;
    if (dk.unit_price != null && dk.unit_price !== 'N/A') f['Cost'] = '$' + dk.unit_price;
    if (dk.package && dk.package !== 'Unknown') f['Package'] = dk.package;
    if (dk.description) f['Description'] = dk.description;
    if (dk.datasheet) f['Datasheet'] = dk.datasheet;
    return f;
  }

  // ---- UI plumbing ---------------------------------------------------------
  function logmsg(m) {
    const el = document.getElementById('kicad-log');
    if (!el) return;
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    el.textContent += `[${ts}] ${m}\n`;
    el.scrollTop = el.scrollHeight;
  }

  function setProgress(pct) {
    const bar = document.getElementById('kicad-prog-fill');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  function renderList() {
    const list = document.getElementById('kicad-zip-list');
    if (!list) return;
    if (!zips.length) {
      list.innerHTML = '<div class="kicad-empty">No ZIPs added yet</div>';
      return;
    }
    list.innerHTML = zips.map((z, i) => `
      <div class="kicad-zip-row">
        <span class="kicad-zip-name" title="${escapeAttr(z)}">${escapeHtml(z.split(/[\\/]/).pop())}</span>
        <button class="kicad-zip-remove" data-i="${i}" title="Remove">&times;</button>
      </div>`).join('');
    list.querySelectorAll('.kicad-zip-remove').forEach(b => {
      b.addEventListener('click', () => { zips.splice(parseInt(b.dataset.i, 10), 1); renderList(); });
    });
  }

  function renderTarget() {
    const el = document.getElementById('kicad-target');
    if (!el) return;
    if (!library) {
      el.innerHTML = '<div class="kicad-empty">No library selected — choose your library .kicad_sym</div>';
      return;
    }
    el.innerHTML = `
      <div class="kicad-target-name">📚 ${escapeHtml(library.libName)}</div>
      <div class="kicad-target-path" title="${escapeAttr(library.symLib)}">sym: ${escapeHtml(library.symLib)}</div>
      <div class="kicad-target-path" title="${escapeAttr(library.fpLib)}">fp: ${escapeHtml(library.fpLib)}</div>
      <div class="kicad-target-path" title="${escapeAttr(library.modelDir)}">3d: ${escapeHtml(library.modelDir)}</div>`;
  }

  function render(container) {
    container.innerHTML = `
      <div class="kicad-importer">
        <div class="kicad-left">
          <div class="kicad-group">
            <label class="kicad-label">Target Library</label>
            <div id="kicad-target" class="kicad-target"></div>
            <button id="kicad-btn-pick" class="kicad-btn kicad-btn-append">Choose Library (.kicad_sym)…</button>
          </div>

          <button id="kicad-btn-addzips" class="kicad-btn">Add ZIP Files (UltraLibrarian / SnapMagic)</button>
          <div id="kicad-zip-list" class="kicad-zip-list"></div>
          <button id="kicad-btn-clear" class="kicad-btn kicad-btn-outline">Clear ZIPs</button>

          <div class="kicad-group kicad-options">
            <div class="kicad-options-title">Options</div>
            <label class="kicad-check"><input type="checkbox" id="kicad-opt-fp" checked> Auto-link Footprints</label>
            <label class="kicad-check"><input type="checkbox" id="kicad-opt-3d" checked> Auto-link 3D Models</label>
            <label class="kicad-check"><input type="checkbox" id="kicad-opt-dk" checked> Pull metadata from DigiKey</label>
          </div>

          <button id="kicad-btn-start" class="kicad-btn kicad-btn-start">APPEND PARTS TO LIBRARY</button>
          <div class="kicad-prog"><div id="kicad-prog-fill" class="kicad-prog-fill"></div></div>
        </div>
        <div class="kicad-right">
          <div class="kicad-log-title">Log</div>
          <pre id="kicad-log" class="kicad-log"></pre>
        </div>
      </div>`;

    container.querySelector('#kicad-btn-pick').addEventListener('click', pickLibrary);
    container.querySelector('#kicad-btn-addzips').addEventListener('click', addZips);
    container.querySelector('#kicad-btn-clear').addEventListener('click', () => { zips = []; renderList(); });
    container.querySelector('#kicad-btn-start').addEventListener('click', start);
    renderList();
    renderTarget();
    restoreSavedLibrary();
  }

  // Re-load the last-used library from settings.json (one-click resume).
  async function restoreSavedLibrary() {
    try {
      const settings = await window.api.loadData('settings.json') || {};
      if (!settings.bigBlueLibrary) return;
      const desc = await window.api.kicad.resolveLibrary({ symLib: settings.bigBlueLibrary });
      if (desc && !desc.error) {
        library = desc;
        renderTarget();
        logmsg(`Loaded saved library: ${desc.libName}`);
      }
    } catch {}
  }

  async function pickLibrary() {
    const desc = await window.api.kicad.selectExistingLibrary();
    if (!desc) return;
    if (desc.error) { alert(desc.error); return; }
    library = desc;
    renderTarget();
    logmsg(`Target: ${desc.libName}`);
    logmsg(`  footprints → ${desc.fpLib}`);
    logmsg(`  3D models  → ${desc.modelDir}`);
    try {
      const settings = await window.api.loadData('settings.json') || {};
      settings.bigBlueLibrary = desc.symLib;
      await window.api.saveData('settings.json', settings);
    } catch {}
  }

  async function addZips() {
    const files = await window.api.kicad.selectZips();
    for (const f of files) if (!zips.includes(f)) zips.push(f);
    renderList();
    logmsg(`Loaded ${zips.length} ZIP(s)`);
  }

  async function start() {
    if (running) return;
    if (!library) { alert('Choose your library .kicad_sym first!'); return; }
    if (!zips.length) { alert('Add ZIPs first!'); return; }

    const options = {
      footprints: document.getElementById('kicad-opt-fp').checked,
      models3d: document.getElementById('kicad-opt-3d').checked,
      digikey: document.getElementById('kicad-opt-dk').checked,
    };

    running = true;
    document.getElementById('kicad-btn-start').disabled = true;
    setProgress(2);
    let stageDir = null;

    try {
      logmsg('Extracting ZIPs (staged — your library is untouched until you confirm)…');
      const ext = await window.api.kicad.extractZips({ zips });
      (ext.logs || []).forEach(logmsg);
      const partsMap = ext.parts || {};
      const mpns = ext.mpns || [];
      stageDir = ext.stageDir;
      setProgress(35);

      // DigiKey enrichment
      let dkData = {};
      if (options.digikey && mpns.length) {
        logmsg(`Fetching DigiKey data for ${mpns.length} part(s)…`);
        const creds = await getCreds();
        const dk = await window.api.kicad.digikeyLookup({ mpns, creds });
        (dk.logs || []).forEach(logmsg);
        dkData = await resolveAmbiguous(dk.results || {});
      }
      setProgress(55);

      // Missing STEP files (still pre-review)
      if (options.models3d) {
        for (const mpn of Object.keys(partsMap)) {
          if (partsMap[mpn].hasStep) continue;
          const dk = dkData[mpn] || {};
          const chosen = await promptStepFile(mpn, dk.manufacturer || 'Unknown', dk.product_url || '');
          if (chosen) {
            const r = await window.api.kicad.addStepFile({ filePath: chosen, stageDir });
            if (r.error) logmsg(`  ✗ ${mpn}: ${r.error}`);
            else { partsMap[mpn].modelStaged.push(r.modelStaged); partsMap[mpn].hasStep = true; logmsg(`  ✓ Staged STEP for ${mpn}`); }
          } else {
            logmsg(`  → No 3D model for ${mpn}`);
          }
        }
      }
      setProgress(65);

      // ---- Per-part review (governance name + required metadata) ----
      const finalized = [];
      for (const mpn of Object.keys(partsMap)) {
        const part = partsMap[mpn];
        const dk = (options.digikey && dkData[mpn] && !dkData[mpn].error) ? dkData[mpn] : {};
        const prefix = typePrefix(dk);
        const review = await promptPartReview({
          mpn,
          suggestedName: suggestName(prefix, dk, mpn),
          footprintName: part.fpSourceName || mpn,
          required: requiredFieldsFor(prefix, dk),
        });
        if (!review) { logmsg(`  ⊘ Skipped ${mpn}`); continue; }

        const fields = options.digikey ? baseFields(dk) : {};
        for (const r of review.required) if (r.value) fields[r.key] = r.value;

        finalized.push({
          mpn, origName: part.origName, symbolBlock: part.symbolBlock,
          symbolName: review.symbolName,
          footprintName: options.footprints ? review.footprintName : null,
          fields,
          modelStaged: options.models3d ? part.modelStaged : [],
          fpStaged: options.footprints ? part.fpStaged : [],
        });
      }

      if (!finalized.length) {
        logmsg('Nothing to write — all parts skipped.');
        setProgress(0);
        return;
      }

      logmsg(`Writing ${finalized.length} part(s) — backing up library first…`);
      const res = await window.api.kicad.writeLibrary({ descriptor: library, parts: finalized, stageDir });
      (res.logs || []).forEach(logmsg);
      if (res.error) { alert('Write aborted: ' + res.error); return; }
      setProgress(100);
      logmsg(`DONE — ${res.added} added, ${res.skipped} skipped. Backup: ${res.backupPath}`);
      alert(`Appended ${res.added} symbol(s) to ${library.libName}.\n${res.skipped} skipped (duplicates).\n\nBackup saved:\n${res.backupPath}`);
    } catch (e) {
      logmsg(`Error: ${e.message}`);
      alert('Import failed: ' + e.message);
    } finally {
      running = false;
      document.getElementById('kicad-btn-start').disabled = false;
    }
  }

  // Resolve ambiguous DigiKey results by prompting the user to pick a match.
  async function resolveAmbiguous(results) {
    const out = {};
    for (const [mpn, r] of Object.entries(results)) {
      if (r && r.ambiguous) {
        const pick = await promptPartSelection(mpn, r.matches);
        if (pick != null) { out[mpn] = r.matches[pick].parsed; logmsg(`  ✓ Selected match #${pick + 1} for ${mpn}`); }
        else { out[mpn] = { error: 'User skipped' }; logmsg(`  ⊘ Skipped DigiKey for ${mpn}`); }
      } else {
        out[mpn] = r;
      }
    }
    return out;
  }

  async function getCreds() {
    const settings = await window.api.loadData('settings.json') || {};
    let clientId = settings.digikeyClientId;
    let clientSecret = settings.digikeyClientSecret;
    if (!clientId || !clientSecret) {
      const d = await window.api.kicad.getDigikeyDefaults();
      clientId = clientId || d.clientId;
      clientSecret = clientSecret || d.clientSecret;
    }
    return { clientId, clientSecret };
  }

  // ---- Modals --------------------------------------------------------------
  function promptPartReview({ mpn, suggestedName, footprintName, required }) {
    return new Promise((resolve) => {
      const rows = required.map((r, i) => `
        <label class="kicad-review-row">
          <span class="kicad-review-key">${escapeHtml(r.key)}${r.value ? '' : ' <em>(missing)</em>'}</span>
          <input class="kicad-input kicad-review-val" data-i="${i}" type="text" value="${escapeAttr(r.value)}">
        </label>`).join('');
      const modal = buildModal(`Review Part — ${escapeHtml(mpn)}`,
        `<p class="kicad-modal-sub">Confirm the governance symbol name and required metadata before it's written.</p>
         <label class="kicad-review-row">
           <span class="kicad-review-key">Symbol Name</span>
           <input id="kicad-rev-name" class="kicad-input" type="text" value="${escapeAttr(suggestedName)}">
         </label>
         <label class="kicad-review-row">
           <span class="kicad-review-key">Footprint Name</span>
           <input id="kicad-rev-fp" class="kicad-input" type="text" value="${escapeAttr(footprintName)}">
         </label>
         <div class="kicad-review-fields">${rows || '<div class="kicad-empty">No type-specific required fields</div>'}</div>
         <p class="kicad-modal-hint">e.g. RES_0603_1k_1%_100PPM_0.333Watt_ThickFilm · CAP_0603_100nF_5%_16V_X7R · DIODE_DO-213AB_1000V_1A_SM4007</p>`,
        [
          { label: 'Skip This Part', cls: 'kicad-btn-outline', action: () => { close(); resolve(null); } },
          { label: 'Confirm', cls: 'kicad-btn-start', action: () => {
              const symbolName = modal.querySelector('#kicad-rev-name').value.trim();
              const fpName = modal.querySelector('#kicad-rev-fp').value.trim();
              if (!symbolName) { alert('Symbol name is required.'); return; }
              const vals = [...modal.querySelectorAll('.kicad-review-val')].map(inp => ({ key: required[parseInt(inp.dataset.i, 10)].key, value: inp.value.trim() }));
              const missing = vals.filter(v => !v.value).map(v => v.key);
              if (missing.length && !confirm(`Missing required field(s): ${missing.join(', ')}.\nWrite anyway?`)) return;
              close();
              resolve({ symbolName, footprintName: fpName || symbolName, required: vals });
            } },
        ]);
      function close() { modal.remove(); }
    });
  }

  function promptPartSelection(mpn, matches) {
    return new Promise((resolve) => {
      const modal = buildModal(`Select Correct Part for ${escapeHtml(mpn)}`,
        `<p class="kicad-modal-sub">Multiple different parts found. Please select the correct one:</p>
         <div class="kicad-match-list">${matches.map((m, i) => `
           <label class="kicad-match-row">
             <input type="radio" name="kicad-match" value="${i}">
             <span><b>${escapeHtml(m.display.mpn)}</b> — ${escapeHtml(m.display.manufacturer)} · DK#${escapeHtml(m.display.digikey_pn)}<br>
             <small>${escapeHtml(m.display.description)}</small></span>
           </label>`).join('')}</div>`,
        [
          { label: 'Skip This Part', cls: 'kicad-btn-outline', action: () => { close(); resolve(null); } },
          { label: 'Select', cls: 'kicad-btn-start', action: () => {
              const sel = modal.querySelector('input[name="kicad-match"]:checked');
              if (!sel) { alert('Please select a part first'); return; }
              close(); resolve(parseInt(sel.value, 10));
            } },
        ]);
      function close() { modal.remove(); }
    });
  }

  function promptStepFile(mpn, manufacturer, digikeyUrl) {
    return new Promise((resolve) => {
      let chosen = null;
      const linkHtml = digikeyUrl
        ? `<a href="#" id="kicad-dk-link" class="kicad-modal-link">Open DigiKey page to download 3D model</a>` : '';
      const modal = buildModal(`Missing 3D Model — ${escapeHtml(mpn)}`,
        `<p><b>Component:</b> ${escapeHtml(mpn)}<br><b>Manufacturer:</b> ${escapeHtml(manufacturer)}</p>
         ${linkHtml}
         <p class="kicad-modal-sub">Provide a STEP file (.step, .stp) or a ZIP containing the STEP model:</p>
         <div class="kicad-file-row">
           <input id="kicad-step-path" class="kicad-input" type="text" readonly placeholder="No file selected…">
           <button id="kicad-step-browse" class="kicad-btn kicad-btn-outline">Browse…</button>
         </div>`,
        [
          { label: 'Skip (No 3D Model)', cls: 'kicad-btn-outline', action: () => { close(); resolve(null); } },
          { label: 'Use This File', cls: 'kicad-btn-start', action: () => {
              if (!chosen) { alert('Please select a file first, or click Skip.'); return; }
              close(); resolve(chosen);
            } },
        ]);
      const dk = modal.querySelector('#kicad-dk-link');
      if (dk) dk.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(digikeyUrl); });
      modal.querySelector('#kicad-step-browse').addEventListener('click', async () => {
        const f = await window.api.kicad.selectStepFile();
        if (f) { chosen = f; modal.querySelector('#kicad-step-path').value = f; }
      });
      function close() { modal.remove(); }
    });
  }

  function buildModal(title, bodyHtml, buttons) {
    const overlay = document.createElement('div');
    overlay.className = 'kicad-modal-overlay';
    overlay.innerHTML = `
      <div class="kicad-modal">
        <div class="kicad-modal-title">${title}</div>
        <div class="kicad-modal-body">${bodyHtml}</div>
        <div class="kicad-modal-actions"></div>
      </div>`;
    const actions = overlay.querySelector('.kicad-modal-actions');
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'kicad-btn ' + (b.cls || '');
      btn.textContent = b.label;
      btn.addEventListener('click', b.action);
      actions.appendChild(btn);
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str == null ? '' : str; return d.innerHTML; }
  function escapeAttr(str) { return String(str == null ? '' : str).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  return {
    id: 'kicad-importer',
    mount(container) { if (!mounted) { render(container); mounted = true; } },
    activate() {},
    deactivate() {},
  };
})();
