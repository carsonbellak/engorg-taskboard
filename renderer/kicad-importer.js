// KiCad Importer utility — UI for consolidating UltraLibrarian / SnapMagic ZIP
// exports into one KiCad library, with optional DigiKey enrichment.
// Backed by window.api.kicad.* (see ipc/kicad-importer.js).

const kicadImporter = (() => {
  let mounted = false;
  let zips = [];
  let appendMode = false;
  let outputFolder = null;   // set when appending to an existing library
  let running = false;

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

  function render(container) {
    container.innerHTML = `
      <div class="kicad-importer">
        <div class="kicad-left">
          <div class="kicad-group">
            <label class="kicad-label">Library Name</label>
            <input id="kicad-libname" class="kicad-input" type="text" value="My_Imported_FULL"
              placeholder="e.g. Connectors, Passives, MyCompany_Lib">
          </div>

          <button id="kicad-btn-append" class="kicad-btn kicad-btn-append">Append to Existing Library</button>
          <div id="kicad-append-status" class="kicad-append-status"></div>

          <button id="kicad-btn-addzips" class="kicad-btn">Add ZIP Files (UltraLibrarian / SnapMagic)</button>
          <div id="kicad-zip-list" class="kicad-zip-list"></div>
          <button id="kicad-btn-clear" class="kicad-btn kicad-btn-outline">Clear</button>

          <div class="kicad-group kicad-options">
            <div class="kicad-options-title">Options</div>
            <label class="kicad-check"><input type="checkbox" id="kicad-opt-fp" checked> Auto-link Footprints</label>
            <label class="kicad-check"><input type="checkbox" id="kicad-opt-3d" checked> Auto-link 3D Models</label>
            <label class="kicad-check"><input type="checkbox" id="kicad-opt-dk" checked> Pull metadata from DigiKey</label>
          </div>

          <button id="kicad-btn-start" class="kicad-btn kicad-btn-start">START FULL IMPORT</button>
          <div class="kicad-prog"><div id="kicad-prog-fill" class="kicad-prog-fill"></div></div>
        </div>
        <div class="kicad-right">
          <div class="kicad-log-title">Log</div>
          <pre id="kicad-log" class="kicad-log"></pre>
        </div>
      </div>`;

    container.querySelector('#kicad-btn-append').addEventListener('click', selectExistingLibrary);
    container.querySelector('#kicad-btn-addzips').addEventListener('click', addZips);
    container.querySelector('#kicad-btn-clear').addEventListener('click', () => { zips = []; appendMode = false; outputFolder = null; document.getElementById('kicad-append-status').textContent = ''; document.getElementById('kicad-libname').value = 'My_Imported_FULL'; renderList(); });
    container.querySelector('#kicad-btn-start').addEventListener('click', start);
    renderList();
  }

  async function selectExistingLibrary() {
    const res = await window.api.kicad.selectExistingLibrary();
    if (!res) return;
    if (res.error) { alert(res.error); return; }
    appendMode = true;
    outputFolder = res.folder;
    document.getElementById('kicad-libname').value = res.libName;
    document.getElementById('kicad-append-status').textContent = `APPEND MODE → "${res.libName}" in ${res.folder}`;
    logmsg(`APPEND MODE: Will add to existing library '${res.libName}' in ${res.folder}`);
  }

  async function addZips() {
    const files = await window.api.kicad.selectZips();
    for (const f of files) if (!zips.includes(f)) zips.push(f);
    renderList();
    logmsg(`Loaded ${zips.length} ZIP(s)`);
  }

  async function start() {
    if (running) return;
    if (!zips.length) { alert('Add ZIPs first!'); return; }

    const libName = (document.getElementById('kicad-libname').value || '').trim() || 'My_Imported_FULL';
    const options = {
      footprints: document.getElementById('kicad-opt-fp').checked,
      models3d: document.getElementById('kicad-opt-3d').checked,
      digikey: document.getElementById('kicad-opt-dk').checked,
    };

    let out = outputFolder;
    if (!(appendMode && out)) {
      out = await window.api.kicad.selectOutputFolder();
      if (!out) return;
    }

    running = true;
    document.getElementById('kicad-btn-start').disabled = true;
    setProgress(2);

    try {
      logmsg('Extracting ZIPs…');
      const ext = await window.api.kicad.extractZips({ zips, outputFolder: out, libName });
      (ext.logs || []).forEach(logmsg);
      let partInfo = ext.partInfo || {};
      const mpns = ext.mpns || [];
      const modelDir = ext.modelDir;
      const symLib = ext.symLib;
      setProgress(45);

      // DigiKey enrichment
      let dkData = {};
      if (options.digikey && mpns.length) {
        logmsg(`Fetching DigiKey data for ${mpns.length} parts…`);
        const creds = await getCreds();
        const dk = await window.api.kicad.digikeyLookup({ mpns, creds });
        (dk.logs || []).forEach(logmsg);
        dkData = await resolveAmbiguous(dk.results || {});
      }
      setProgress(70);

      // Missing STEP files
      if (options.models3d) {
        const missing = Object.keys(partInfo).filter(mpn => !partInfo[mpn].has_step);
        if (missing.length) {
          logmsg(`Found ${missing.length} components without STEP files`);
          for (let i = 0; i < missing.length; i++) {
            const mpn = missing[i];
            const dk = dkData[mpn] || {};
            const chosen = await promptStepFile(mpn, dk.manufacturer || 'Unknown', dk.product_url || '', i + 1, missing.length);
            if (chosen) {
              const r = await window.api.kicad.addStepFile({ mpn, filePath: chosen, modelDir });
              if (r.error) logmsg(`  ✗ ${mpn}: ${r.error}`);
              else { partInfo[mpn].model3d = r.model3d; partInfo[mpn].has_step = true; logmsg(`  ✓ Added STEP file for ${mpn}`); }
            } else {
              logmsg(`  → Skipped 3D model for ${mpn}`);
            }
          }
        }
      }
      setProgress(85);

      logmsg('Writing library…');
      const res = await window.api.kicad.writeLibrary({ partInfo, dkData, options, symLib, appendMode, libName });
      (res.logs || []).forEach(logmsg);
      setProgress(100);
      logmsg(`PERFECT — ${res.added} symbols ${res.mode} '${libName}'`);
      alert(`Successfully ${res.mode} ${res.added} symbols!\nFile: ${res.symLib}`);
    } catch (e) {
      logmsg(`Error: ${e.message}`);
      alert('Import failed: ' + e.message);
    } finally {
      running = false;
      appendMode = false;
      document.getElementById('kicad-btn-start').disabled = false;
    }
  }

  // Resolve any ambiguous DigiKey results by prompting the user to pick a match.
  async function resolveAmbiguous(results) {
    const out = {};
    for (const [mpn, r] of Object.entries(results)) {
      if (r && r.ambiguous) {
        const pick = await promptPartSelection(mpn, r.matches);
        if (pick != null) { out[mpn] = r.matches[pick].parsed; logmsg(`  ✓ User selected match #${pick + 1} for ${mpn}`); }
        else { out[mpn] = { error: 'User skipped' }; logmsg(`  ⊘ User skipped ${mpn}`); }
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

  function promptStepFile(mpn, manufacturer, digikeyUrl, idx, total) {
    return new Promise((resolve) => {
      let chosen = null;
      const linkHtml = digikeyUrl
        ? `<a href="#" id="kicad-dk-link" class="kicad-modal-link">Open DigiKey page to download 3D model</a>` : '';
      const modal = buildModal(`Missing 3D Model — ${escapeHtml(mpn)} (${idx}/${total})`,
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
