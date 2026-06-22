// WiFi Checker utility — desktop port of the standalone PyQt5 "Wifi Checker".
// Scans meters over the test WiFi: discovers IPs (arp/nmap), pings + SSH-checks
// each meter, and writes per-meter result files. Supports Standard, Continuous
// and Scheduled ping modes, a Temperature-Shutdown push tool, multiple tabs and
// saved meter selection profiles.
//
// Backed by window.api.wifi.* (see ipc/wifi-checker.js). Excel parsing uses the
// bundled global XLSX (renderer/lib/xlsx.full.min.js). Desktop-only utility.

const wifiChecker = (() => {
  const MAX_PER_ITEM_SECS = 300;          // 5 min per device
  const MAX_IP_DISCOVERY_ATTEMPTS = 3;
  const MAX_WORKERS = 20;
  const WIFI_SSID = 'revelotest3';
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index = JS-style Mon=0

  let mounted = false;
  let tabs = [];
  let activeId = null;
  let counter = 0;

  // ---------- helpers -------------------------------------------------------
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  const hexOnly = (s) => String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  const formatMac = (mac) => { const h = hexOnly(mac); return (h.match(/.{1,2}/g) || []).join(':').toUpperCase(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmtHMS(secs) {
    secs = Math.max(0, Math.floor(secs));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function fmtWait(secs) {
    secs = Math.floor(secs);
    const d = Math.floor(secs / 86400); secs %= 86400;
    const h = Math.floor(secs / 3600); secs %= 3600;
    const m = Math.floor(secs / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  }

  function newTab(name) {
    counter += 1;
    return {
      id: 'wt' + counter,
      name: name || `Scan ${counter}`,
      excelPath: null,
      outputFolder: null,
      meters: [],            // [{ display, mac, checked }]
      search: '',
      voltage: 'LV', voltageOn: true,
      befaft: 'bef', befaftOn: true,
      suffix: '',
      recordFails: false,
      overwrite: false,
      wifiConnect: true,
      scanMode: 0,           // 0 standard, 1 continuous, 2 scheduled
      pingMode: 0,           // 0 until stopped, 1 duration min, 2 success count
      pingValue: '',
      pingDelay: '',
      separateFiles: false,
      // runtime
      running: false,
      stopRequested: false,
      schedulerSessionStop: false,
      scanGen: 0,
      statusDict: {},
      startTimes: {},
      filtered: [],          // [{ display, mac, filename }]
      elapsedStart: null,
      timerInt: null,
      scheduleSettings: null,
    };
  }

  const getTab = () => tabs.find((t) => t.id === activeId) || null;
  const isActive = (tab) => tab && tab.id === activeId;

  // ---------- status + timer -----------------------------------------------
  function setStatus(tab, name, text) {
    tab.statusDict[name] = text;
    if (isActive(tab)) refreshStatus(tab);
  }
  function delStatus(tab, name) {
    delete tab.statusDict[name];
    if (isActive(tab)) refreshStatus(tab);
  }
  function refreshStatus(tab) {
    const el = document.getElementById('wifi-status');
    if (!el) return;
    el.textContent = Object.entries(tab.statusDict).map(([k, v]) => `${k} … ${v}`).join('\n');
  }
  function startTimer(tab) {
    tab.elapsedStart = Date.now();
    stopTimerInterval(tab);
    tab.timerInt = setInterval(() => {
      if (!isActive(tab)) return;
      const lbl = document.getElementById('wifi-timer');
      if (lbl && tab.elapsedStart) lbl.textContent = '⏱  ' + fmtHMS((Date.now() - tab.elapsedStart) / 1000);
    }, 1000);
  }
  function stopTimerInterval(tab) { if (tab.timerInt) { clearInterval(tab.timerInt); tab.timerInt = null; } }
  function stopTimer(tab) {
    stopTimerInterval(tab);
    tab.elapsedStart = null;
    tab.running = false;
    if (isActive(tab)) {
      const lbl = document.getElementById('wifi-timer'); if (lbl) lbl.textContent = '⏱  00:00:00';
      const run = document.getElementById('wifi-run'); if (run) run.disabled = false;
    }
  }

  // ---------- tab bar + layout ---------------------------------------------
  function renderTabBar() {
    const bar = document.getElementById('wifi-tabbar');
    if (!bar) return;
    bar.innerHTML = tabs.map((t) => `
      <div class="wifi-tab${t.id === activeId ? ' active' : ''}" data-id="${t.id}">
        <span class="wifi-tab-name">${esc(t.name)}</span>
        ${tabs.length > 1 ? `<span class="wifi-tab-close" data-close="${t.id}">&times;</span>` : ''}
      </div>`).join('') + `<button class="wifi-tab-add" id="wifi-tab-add" title="New tab">+</button>`;
    bar.querySelectorAll('.wifi-tab').forEach((el) => {
      el.addEventListener('click', (e) => { if (e.target.dataset.close) return; selectTab(el.dataset.id); });
    });
    bar.querySelectorAll('.wifi-tab-close').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); closeTab(el.dataset.close); });
    });
    const add = document.getElementById('wifi-tab-add');
    if (add) add.addEventListener('click', () => { const t = newTab(); tabs.push(t); selectTab(t.id); });
  }

  function selectTab(id) { activeId = id; renderTabBar(); renderBody(); }
  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0 || tabs.length === 1) return;
    const t = tabs[idx];
    t.stopRequested = true; stopTimerInterval(t);
    tabs.splice(idx, 1);
    if (activeId === id) activeId = tabs[Math.max(0, idx - 1)].id;
    renderTabBar(); renderBody();
  }

  function renderBody() {
    const body = document.getElementById('wifi-body');
    const tab = getTab();
    if (!body || !tab) return;
    body.innerHTML = `
      <div class="wifi-row wifi-files">
        <div class="wifi-card">
          <div class="wifi-card-title">Meter Status File</div>
          <div id="wifi-file-label" class="wifi-pathlabel">${tab.excelPath ? '✓ ' + esc(tab.excelPath.split(/[\\/]/).pop()) : 'No file selected'}</div>
          <button id="wifi-pick-file" class="kicad-btn">📁 Select Meter Status File</button>
        </div>
        <div class="wifi-card">
          <div class="wifi-card-title">Output Location</div>
          <div id="wifi-out-label" class="wifi-pathlabel">${tab.outputFolder ? '✓ ' + esc(tab.outputFolder) : 'No output folder selected'}</div>
          <button id="wifi-pick-out" class="kicad-btn">📂 Select Output Folder</button>
        </div>
      </div>

      <div class="wifi-row wifi-main">
        <div class="wifi-card wifi-col-meters">
          <div class="wifi-card-title">Meter Selection</div>
          <input id="wifi-search" class="kicad-input" placeholder="🔍 Search meters..." value="${esc(tab.search)}">
          <div class="wifi-btnrow">
            <button id="wifi-uncheck" class="kicad-btn kicad-btn-outline">Uncheck All</button>
            <button id="wifi-check" class="kicad-btn kicad-btn-outline">Check All</button>
            <button id="wifi-save-profile" class="kicad-btn kicad-btn-outline">Save Profile</button>
            <button id="wifi-load-profile" class="kicad-btn kicad-btn-outline">Load Profile</button>
          </div>
          <div id="wifi-meter-list" class="wifi-meter-list"></div>
        </div>

        <div class="wifi-card wifi-col-settings">
          <div class="wifi-card-title">File Naming</div>
          <div class="wifi-field">
            <label>Voltage</label>
            <select id="wifi-voltage" class="kicad-input wifi-inline">
              <option value="LV"${tab.voltage === 'LV' ? ' selected' : ''}>LV</option>
              <option value="HV"${tab.voltage === 'HV' ? ' selected' : ''}>HV</option>
            </select>
            <label class="wifi-cb"><input type="checkbox" id="wifi-voltage-on"${tab.voltageOn ? ' checked' : ''}> Include</label>
          </div>
          <div class="wifi-field">
            <label>Bef/Aft</label>
            <select id="wifi-befaft" class="kicad-input wifi-inline">
              <option value="bef"${tab.befaft === 'bef' ? ' selected' : ''}>bef</option>
              <option value="aft"${tab.befaft === 'aft' ? ' selected' : ''}>aft</option>
            </select>
            <label class="wifi-cb"><input type="checkbox" id="wifi-befaft-on"${tab.befaftOn ? ' checked' : ''}> Include</label>
          </div>
          <label>Custom Suffix</label>
          <input id="wifi-suffix" class="kicad-input" placeholder="Custom suffix (e.g., 85C)" value="${esc(tab.suffix)}">
          <label class="wifi-cb"><input type="checkbox" id="wifi-recordfails"${tab.recordFails ? ' checked' : ''}> Record Failed Connections</label>
          <label class="wifi-cb"><input type="checkbox" id="wifi-overwrite"${tab.overwrite ? ' checked' : ''}> Overwrite existing files</label>
          <div class="wifi-card-title" style="margin-top:10px">Connection</div>
          <label class="wifi-cb"><input type="checkbox" id="wifi-wificonnect"${tab.wifiConnect ? ' checked' : ''}> Connect to ${WIFI_SSID}</label>
          <button id="wifi-temp" class="kicad-btn kicad-btn-outline" style="margin-top:8px">🌡 Temp. Shutdown</button>
        </div>

        <div class="wifi-card wifi-col-actions">
          <div class="wifi-card-title">Controls</div>
          <button id="wifi-run" class="kicad-btn kicad-btn-start">▶ Start Scan</button>
          <button id="wifi-stop" class="kicad-btn kicad-btn-outline">⬛ Stop Scan</button>
          <div id="wifi-timer" class="wifi-timer">⏱  00:00:00</div>
          <label>Scan Mode</label>
          <select id="wifi-scanmode" class="kicad-input">
            <option value="0"${tab.scanMode === 0 ? ' selected' : ''}>Standard Scan</option>
            <option value="1"${tab.scanMode === 1 ? ' selected' : ''}>Continuous Ping</option>
            <option value="2"${tab.scanMode === 2 ? ' selected' : ''}>Scheduled Ping</option>
          </select>
          <div class="wifi-field"><label>Mode</label>
            <select id="wifi-pingmode" class="kicad-input wifi-inline">
              <option value="0"${tab.pingMode === 0 ? ' selected' : ''}>Until Stopped</option>
              <option value="1"${tab.pingMode === 1 ? ' selected' : ''}>Duration (minutes)</option>
              <option value="2"${tab.pingMode === 2 ? ' selected' : ''}>Success Count</option>
            </select>
          </div>
          <div class="wifi-field"><label>Value</label><input id="wifi-pingvalue" class="kicad-input wifi-inline" value="${esc(tab.pingValue)}"></div>
          <div class="wifi-field"><label>Delay</label><input id="wifi-pingdelay" class="kicad-input wifi-inline" value="${esc(tab.pingDelay)}"></div>
          <label class="wifi-cb"><input type="checkbox" id="wifi-separate"${tab.separateFiles ? ' checked' : ''}> Separate file per ping</label>
          <button id="wifi-schedule" class="kicad-btn kicad-btn-outline" style="margin-top:6px">📅 Set Schedule...</button>
        </div>
      </div>

      <div class="wifi-card wifi-statuscard">
        <div class="wifi-card-title">Status &amp; Progress</div>
        <pre id="wifi-status" class="wifi-status"></pre>
      </div>`;

    bindBody(tab);
    renderMeterList(tab);
    refreshStatus(tab);
    applyScanModeUi(tab);
    if (tab.running && tab.elapsedStart) {
      const lbl = document.getElementById('wifi-timer');
      if (lbl) lbl.textContent = '⏱  ' + fmtHMS((Date.now() - tab.elapsedStart) / 1000);
      const run = document.getElementById('wifi-run'); if (run) run.disabled = true;
    }
  }

  function bindBody(tab) {
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on('wifi-pick-file', 'click', () => pickExcel(tab));
    on('wifi-pick-out', 'click', () => pickFolder(tab));
    on('wifi-search', 'input', (e) => { tab.search = e.target.value; filterMeters(tab); });
    on('wifi-uncheck', 'click', () => { tab.meters.forEach((m) => m.checked = false); renderMeterList(tab); });
    on('wifi-check', 'click', () => { tab.meters.forEach((m) => { if (matchSearch(tab, m)) m.checked = true; }); renderMeterList(tab); });
    on('wifi-save-profile', 'click', () => saveProfile(tab));
    on('wifi-load-profile', 'click', () => loadProfile(tab));
    on('wifi-voltage', 'change', (e) => tab.voltage = e.target.value);
    on('wifi-voltage-on', 'change', (e) => tab.voltageOn = e.target.checked);
    on('wifi-befaft', 'change', (e) => tab.befaft = e.target.value);
    on('wifi-befaft-on', 'change', (e) => tab.befaftOn = e.target.checked);
    on('wifi-suffix', 'input', (e) => tab.suffix = e.target.value);
    on('wifi-recordfails', 'change', (e) => tab.recordFails = e.target.checked);
    on('wifi-overwrite', 'change', (e) => tab.overwrite = e.target.checked);
    on('wifi-wificonnect', 'change', (e) => tab.wifiConnect = e.target.checked);
    on('wifi-scanmode', 'change', (e) => { tab.scanMode = +e.target.value; applyScanModeUi(tab); });
    on('wifi-pingmode', 'change', (e) => { tab.pingMode = +e.target.value; applyScanModeUi(tab); });
    on('wifi-pingvalue', 'input', (e) => tab.pingValue = e.target.value);
    on('wifi-pingdelay', 'input', (e) => tab.pingDelay = e.target.value);
    on('wifi-separate', 'change', (e) => tab.separateFiles = e.target.checked);
    on('wifi-run', 'click', () => startScan(tab));
    on('wifi-stop', 'click', () => requestStop(tab));
    on('wifi-temp', 'click', () => openTempDialog(tab));
    on('wifi-schedule', 'click', () => openSchedulerDialog(tab));
  }

  function applyScanModeUi(tab) {
    const cont = tab.scanMode === 1, sched = tab.scanMode === 2;
    const set = (id, en, ph) => { const el = document.getElementById(id); if (el) { el.disabled = !en; if (ph != null) el.placeholder = ph; } };
    set('wifi-pingmode', cont);
    set('wifi-pingdelay', cont, cont ? 'Seconds (default: 0)' : 'N/A');
    set('wifi-separate', cont);
    set('wifi-schedule', sched);
    // value field only when continuous + duration/count
    const valEn = cont && (tab.pingMode === 1 || tab.pingMode === 2);
    set('wifi-pingvalue', valEn, !cont ? 'N/A' : (tab.pingMode === 1 ? 'Minutes (e.g., 30)' : (tab.pingMode === 2 ? '# of successes (e.g., 10)' : 'N/A')));
  }

  // ---------- meter list ----------------------------------------------------
  function matchSearch(tab, m) { return !tab.search || m.display.toLowerCase().includes(tab.search.toLowerCase()); }
  function renderMeterList(tab) {
    const list = document.getElementById('wifi-meter-list');
    if (!list) return;
    if (!tab.meters.length) { list.innerHTML = '<div class="kicad-empty">No meters loaded — select a meter status file.</div>'; return; }
    list.innerHTML = tab.meters.map((m, i) => `
      <label class="wifi-meter-row${matchSearch(tab, m) ? '' : ' hidden'}">
        <input type="checkbox" data-i="${i}"${m.checked ? ' checked' : ''}>
        <span>${esc(m.display)}</span>
      </label>`).join('');
    list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => { tab.meters[+cb.dataset.i].checked = cb.checked; });
    });
  }
  function filterMeters(tab) {
    const list = document.getElementById('wifi-meter-list');
    if (!list) return;
    list.querySelectorAll('.wifi-meter-row').forEach((row) => {
      const i = +row.querySelector('input').dataset.i;
      row.classList.toggle('hidden', !matchSearch(tab, tab.meters[i]));
    });
  }

  // ---------- file pickers + excel -----------------------------------------
  async function pickExcel(tab) {
    const p = await window.api.wifi.selectExcel();
    if (!p) return;
    tab.excelPath = p;
    const lbl = document.getElementById('wifi-file-label');
    if (lbl) lbl.textContent = '✓ ' + p.split(/[\\/]/).pop();
    await readExcel(tab, p);
  }
  async function pickFolder(tab) {
    const p = await window.api.wifi.selectFolder();
    if (!p) return;
    tab.outputFolder = p;
    const lbl = document.getElementById('wifi-out-label'); if (lbl) lbl.textContent = '✓ ' + p;
  }
  async function readExcel(tab, p) {
    try {
      const res = await window.api.wifi.readExcelBuffer(p);
      if (res.error) { alert('Failed to read Excel file: ' + res.error); return; }
      const wb = XLSX.read(new Uint8Array(res.data), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      tab.meters = [];
      const tails = ['S', 'Se', 'SD', 'SC', '2'];
      for (const row of rows) {
        const a = String(row[0] == null ? '' : row[0]).trim();
        const b = String(row[1] == null ? '' : row[1]).trim();
        const e = String(row[4] == null ? '' : row[4]).trim();
        if (!e) continue;
        if (tails.some((t) => a.endsWith(t))) tab.meters.push({ display: `${a}-${b}`, mac: e, checked: false });
      }
      renderMeterList(tab);
    } catch (err) {
      alert('Failed to read Excel file: ' + err.message);
    }
  }

  // ---------- profiles (stored in settings.json) ----------------------------
  function getProfiles() { return (dataManager.settings.wifiProfiles) || {}; }
  async function saveProfile(tab) {
    const selected = tab.meters.filter((m) => m.checked).map((m) => m.display);
    if (!selected.length) { alert('Please select at least one meter.'); return; }
    const name = prompt('Profile name:');
    if (!name) return;
    const profiles = { ...getProfiles(), [name]: selected };
    await dataManager.updateSettings({ wifiProfiles: profiles });
    alert(`Profile "${name}" saved (${selected.length} meters).`);
  }
  function loadProfile(tab) {
    const profiles = getProfiles();
    const names = Object.keys(profiles);
    if (!names.length) { alert('No saved profiles yet.'); return; }
    const name = prompt('Load which profile?\n\n' + names.join('\n'), names[0]);
    if (!name || !profiles[name]) return;
    const want = new Set(profiles[name]);
    tab.meters.forEach((m) => { m.checked = want.has(m.display); });
    renderMeterList(tab);
  }

  // ---------- scan orchestration -------------------------------------------
  function buildFilename(tab, display) {
    const parts = [display];
    if (tab.voltageOn && tab.voltage) parts.push(tab.voltage);
    if (tab.befaftOn && tab.befaft) parts.push(tab.befaft);
    const suffix = (tab.suffix || '').trim();
    if (suffix) parts.push(suffix.replace(/^-+|-+$/g, ''));
    return parts.join('-') + '.txt';
  }
  function prepareRun(tab, initialStatus) {
    tab.filtered = tab.meters.filter((m) => m.checked).map((m) => ({ display: m.display, mac: m.mac, filename: buildFilename(tab, m.display) }));
    tab.statusDict = {};
    tab.startTimes = {};
    const now = Date.now();
    tab.filtered.forEach((m) => { tab.statusDict[m.filename] = initialStatus; tab.startTimes[m.filename] = now; });
    refreshStatus(tab);
  }
  const genCurrent = (tab, gen) => gen == null || gen === tab.scanGen;

  async function startScan(tab) {
    if (!tab.meters.length || !tab.outputFolder) { alert('Please select both a meter file and an output folder.'); return; }
    if (!tab.meters.some((m) => m.checked)) { alert('Please select at least one meter to scan.'); return; }

    if (tab.scanMode === 2) { alert("Please use the 'Set Schedule...' button to configure and start a scheduled ping."); return; }

    const runBtn = document.getElementById('wifi-run'); if (runBtn) runBtn.disabled = true;

    if (tab.wifiConnect) {
      setStatus(tab, 'WiFi', `Connecting to ${WIFI_SSID}...`);
      const r = await window.api.wifi.connectWifi();
      setStatus(tab, 'WiFi', (r.connected ? '✓ ' : '✗ ') + r.message);
      if (!r.connected) { alert('Could not connect to ' + WIFI_SSID + '. Check WiFi and try again.'); stopTimer(tab); return; }
      delStatus(tab, 'WiFi');
    }

    const hasNmap = await window.api.wifi.hasNmap();
    if (!hasNmap) setStatus(tab, 'System', '⚠ nmap not found — discovery limited to the ARP table.');

    prepareRun(tab, '⏳ RUNNING');
    tab.running = true;
    tab.stopRequested = false;
    tab.schedulerSessionStop = false;
    startTimer(tab);
    tab.scanGen += 1;
    const gen = tab.scanGen;

    if (tab.scanMode === 1) runContinuousPingLoop(tab, gen);
    else runScanLoop(tab, gen, false);
  }

  function requestStop(tab) {
    tab.stopRequested = true;
    tab.schedulerSessionStop = true;
    for (const k of Object.keys(tab.statusDict)) {
      if (!tab.statusDict[k].includes('DONE') && !tab.statusDict[k].includes('✓')) tab.statusDict[k] = '⬛ STOPPED';
    }
    refreshStatus(tab);
    stopTimer(tab);
  }

  // run async fn over items with limited concurrency
  async function runPool(items, limit, fn) {
    const queue = items.slice();
    const workers = [];
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
      workers.push((async () => { let it; while ((it = queue.shift()) !== undefined) await fn(it); })());
    }
    await Promise.all(workers);
  }

  async function processMeter(tab, meter, gen) {
    const elapsed = () => fmtHMS((Date.now() - tab.startTimes[meter.filename]) / 1000);
    if (tab.stopRequested || tab.schedulerSessionStop || !genCurrent(tab, gen)) return { meter, success: false, message: '⬛ STOPPED' };
    if ((Date.now() - tab.startTimes[meter.filename]) / 1000 >= MAX_PER_ITEM_SECS) return { meter, success: false, message: `⏱ TIMEOUT (${elapsed()})` };

    setStatus(tab, meter.filename, `📡 Pinging ${meter.ip}... (${elapsed()})`);
    const ping = await window.api.wifi.ping(meter.ip);
    setStatus(tab, meter.filename, (ping.pass ? '✓ Ping OK → SSH' : '✗ Ping FAILED → SSH') + ` ${meter.ip}... (${elapsed()})`);

    if (tab.stopRequested || tab.schedulerSessionStop || !genCurrent(tab, gen)) return { meter, success: false, message: '⬛ STOPPED' };
    const ssh = await window.api.wifi.ssh(meter.ip);

    const content =
      `File: ${meter.filename}\n` +
      `MAC: ${formatMac(meter.mac)}\n` +
      `IP: ${meter.ip}\n` +
      `Ping Pass: ${ping.pass ? 'Yes' : 'No'}\n` +
      `SSH Pass: ${ssh.ok ? 'Yes' : 'No'}\n` +
      (ssh.prompt ? `SSH Prompt: ${ssh.prompt}\n` : '') +
      `\n${'='.repeat(40)}\nPing Output:\n${'─'.repeat(40)}\n${ping.output}` +
      `\n${'='.repeat(40)}\nSSH Output:\n${'─'.repeat(40)}\n${ssh.raw || 'No SSH response'}\n`;
    await window.api.wifi.writeFile({ folder: tab.outputFolder, filename: meter.filename, content, overwrite: tab.overwrite });

    const e = elapsed();
    if (ssh.ok && ping.pass) return { meter, success: true, message: `✓ DONE — Ping OK, SSH OK (${meter.ip}) (${e})` };
    if (ssh.ok && !ping.pass) return { meter, success: true, message: `⚠ DONE — Ping FAILED, SSH OK (${meter.ip}) (${e})` };
    if (ping.pass && !ssh.ok) return { meter, success: true, message: `⚠ DONE — Ping OK, SSH FAILED (${meter.ip}) (${e})` };
    return { meter, success: true, message: `✗ DONE — Ping FAILED, SSH FAILED (${meter.ip}) (${e})` };
  }

  async function writeFailFile(tab, meter, attempts, lastMap) {
    const failName = meter.filename.replace('.txt', '-FAIL.txt');
    let content =
      `File: ${failName}\nFAILED TO CONNECT\n${'='.repeat(50)}\n\n` +
      `Meter ID: ${meter.display}\nMAC Address: ${formatMac(meter.mac)}\nMAC (hex): ${hexOnly(meter.mac)}\n` +
      `Discovery Attempts: ${attempts}\nStatus: No IP address found after ${attempts} attempts\n\n` +
      `Network Information:\n${'-'.repeat(50)}\n`;
    const entries = Object.entries(lastMap || {});
    if (entries.length) {
      content += `Total devices discovered: ${entries.length}\n\nAll discovered MAC addresses:\n`;
      entries.sort((a, b) => a[1].localeCompare(b[1])).forEach(([mac, ip]) => {
        content += `  ${(mac.match(/.{1,2}/g) || []).join(':').toUpperCase()} -> ${ip}\n`;
      });
    } else content += 'No devices discovered in last scan\n';
    await window.api.wifi.writeFile({ folder: tab.outputFolder, filename: failName, content, overwrite: tab.overwrite });
  }

  async function runScanLoop(tab, gen, scheduled) {
    let meters = tab.filtered.map((m) => ({ ...m, ip: null, attempts: 0, status: 'pending' }));
    let lastMap = {};
    const shouldStop = () => !genCurrent(tab, gen) || tab.stopRequested || (scheduled && tab.schedulerSessionStop);

    while (meters.some((m) => m.status === 'pending') && !shouldStop()) {
      const pendingCount = meters.filter((m) => m.status === 'pending').length;
      setStatus(tab, 'System', `🔍 Discovering IPs for ${pendingCount} meter(s)...`);
      const res = await window.api.wifi.discoverIps();
      const map = res.map || {};
      lastMap = map;

      meters.forEach((m) => { if (m.status === 'pending') m.attempts += 1; });
      const found = [];
      let stillPending = false;
      for (const m of meters) {
        if (m.status !== 'pending') continue;
        const ip = map[hexOnly(m.mac)];
        const el = fmtHMS((Date.now() - tab.startTimes[m.filename]) / 1000);
        if (ip) { m.ip = ip; m.status = 'found'; found.push(m); }
        else if (m.attempts >= MAX_IP_DISCOVERY_ATTEMPTS) {
          m.status = 'failed';
          if (tab.recordFails) { await writeFailFile(tab, m, m.attempts, lastMap); setStatus(tab, m.filename, `✗ FAILED - File Created (${el})`); }
          else setStatus(tab, m.filename, `✗ FAILED - No IP Found (${el})`);
        } else { stillPending = true; setStatus(tab, m.filename, `🔍 Searching... (Attempt ${m.attempts}/${MAX_IP_DISCOVERY_ATTEMPTS}) (${el})`); }
      }

      if (found.length) {
        setStatus(tab, 'System', `⚡ Testing ${found.length} meter(s)...`);
        await runPool(found, Math.min(MAX_WORKERS, found.length), async (m) => {
          if (shouldStop()) return;
          try {
            const { success, message } = await processMeter(tab, m, gen);
            if (success) { setStatus(tab, m.filename, message); m.status = 'complete'; }
            else if (message === '⬛ STOPPED') m.status = 'stopped';
            else if (message) { setStatus(tab, m.filename, message); m.status = 'timeout'; }
          } catch (err) {
            setStatus(tab, m.filename, `✗ ERROR: ${err.message} (${fmtHMS((Date.now() - tab.startTimes[m.filename]) / 1000)})`);
            m.status = 'error';
          }
        });
      }

      meters = meters.filter((m) => m.status === 'pending');
      if (stillPending && !shouldStop()) await sleep(2000);
    }

    delStatus(tab, 'System');
    if (!scheduled && genCurrent(tab, gen)) {
      if (!tab.stopRequested) setTimeout(() => alert('Scan complete — all selected devices have been checked.'), 0);
      stopTimer(tab);
    }
  }

  // ---------- continuous ping ----------------------------------------------
  async function runContinuousPingLoop(tab, gen) {
    const pingMode = tab.pingMode;
    const separate = tab.separateFiles;
    const delay = parseInt(tab.pingDelay, 10) || 0;
    let targetDuration = null, targetCount = null;
    if (pingMode === 1) targetDuration = (parseInt(tab.pingValue, 10) || 0) * 60;
    else if (pingMode === 2) targetCount = parseInt(tab.pingValue, 10) || 0;

    const startTime = Date.now();
    const testStart = new Date().toLocaleString();
    const meters = tab.filtered.map((m) => ({
      ...m, ip: null, ipHistory: [], pingCount: 0, successCount: 0, failCount: 0, responseTimes: [], pingLog: [],
    }));
    let round = 0;

    while (!tab.stopRequested && genCurrent(tab, gen)) {
      round += 1;
      if (targetDuration && (Date.now() - startTime) / 1000 >= targetDuration) { setStatus(tab, 'System', `✓ Duration limit reached (${targetDuration / 60} min)`); break; }
      if (targetCount && meters.every((m) => m.successCount >= targetCount)) { setStatus(tab, 'System', `✓ All meters reached ${targetCount} successful pings`); break; }

      setStatus(tab, 'System', `🔍 Round ${round}: Discovering IPs...`);
      const res = await window.api.wifi.discoverIps();
      const map = res.map || {};

      for (const m of meters) {
        if (tab.stopRequested) break;
        if (targetCount && m.successCount >= targetCount) continue;
        const ts = new Date().toLocaleString();
        const ip = map[hexOnly(m.mac)];
        const el = Math.floor((Date.now() - startTime) / 1000);
        if (!ip) {
          m.pingCount += 1; m.failCount += 1;
          const entry = { timestamp: ts, round, ip: null, success: false, responseTime: null, error: 'No IP found' };
          m.pingLog.push(entry);
          if (separate) await writeIndividualPing(tab, m, entry);
          setStatus(tab, m.filename, `❌ No IP | Pings: ${m.pingCount} | Success: ${m.successCount} | ${el}s`);
          continue;
        }
        if (!m.ipHistory.includes(ip)) m.ipHistory.push(ip);
        m.ip = ip;
        const ping = await window.api.wifi.ping(ip);
        m.pingCount += 1;
        let avg = null;
        if (ping.pass) { m.successCount += 1; m.responseTimes.push(...(ping.times || [])); avg = ping.times && ping.times.length ? ping.times.reduce((a, b) => a + b, 0) / ping.times.length : 0; }
        else m.failCount += 1;
        const entry = { timestamp: ts, round, ip, success: ping.pass, responseTime: avg, responseTimes: ping.times, rawOutput: ping.output };
        m.pingLog.push(entry);
        if (separate) await writeIndividualPing(tab, m, entry);
        const rate = m.pingCount ? (m.successCount / m.pingCount * 100) : 0;
        const overallAvg = m.responseTimes.length ? m.responseTimes.reduce((a, b) => a + b, 0) / m.responseTimes.length : 0;
        const tstr = avg ? ` ${avg.toFixed(0)}ms` : '';
        setStatus(tab, m.filename, `${ping.pass ? '✓' : '✗'}${tstr} ${ip} | ${m.successCount}/${m.pingCount} (${rate.toFixed(0)}%) | Avg: ${overallAvg.toFixed(1)}ms | ${el}s`);
      }

      if (delay > 0 && !tab.stopRequested) {
        for (let r = delay; r > 0; r--) { if (tab.stopRequested) break; setStatus(tab, 'System', `⏳ Next ping in ${r}s... (Round ${round} complete)`); await sleep(1000); }
      }
    }

    if (!genCurrent(tab, gen)) return;
    const testEnd = new Date().toLocaleString();
    const totalDuration = Math.floor((Date.now() - startTime) / 1000);
    for (const m of meters) await writeContinuousReport(tab, m, testStart, testEnd, totalDuration, round, separate);
    delStatus(tab, 'System');
    if (!tab.stopRequested) setTimeout(() => alert(`Continuous ping complete — ${round} rounds. Results saved to the output folder.`), 0);
    stopTimer(tab);
  }

  async function writeIndividualPing(tab, m, entry) {
    const base = m.filename.replace('.txt', '');
    const tsStr = entry.timestamp.replace(/[-:]/g, '').replace(/[ ,]/g, '-');
    const filename = `${base}-${tsStr}.txt`;
    let content =
      `File: ${filename}\n${'='.repeat(50)}\n\n` +
      `Meter: ${m.display}\nMAC: ${formatMac(m.mac)}\nTimestamp: ${entry.timestamp}\nPing #: ${m.pingCount}\n\n` +
      `IP: ${entry.ip || 'Not found'}\nPing Pass: ${entry.success ? 'Yes' : 'No'}\n`;
    if (entry.responseTime != null) content += `Response Time: ${entry.responseTime.toFixed(1)}ms\n`;
    if (entry.error) content += `Error: ${entry.error}\n`;
    content += `\n${'='.repeat(50)}\nPing Output:\n${'─'.repeat(40)}\n${entry.rawOutput || 'No ping output'}\n`;
    await window.api.wifi.writeFile({ folder: tab.outputFolder, filename, content, overwrite: tab.overwrite });
  }

  async function writeContinuousReport(tab, m, start, end, duration, rounds, separate) {
    const base = m.filename.replace('.txt', '');
    const filename = `${base}-report.txt`;
    const rate = m.pingCount ? (m.successCount / m.pingCount * 100) : 0;
    const rt = m.responseTimes;
    const avg = rt.length ? rt.reduce((a, b) => a + b, 0) / rt.length : 0;
    const min = rt.length ? Math.min(...rt) : 0, max = rt.length ? Math.max(...rt) : 0;
    const ipChanged = m.ipHistory.length > 1;
    let c =
      `File: ${filename}\n${'='.repeat(60)}\n  CONTINUOUS PING REPORT\n${'='.repeat(60)}\n\n` +
      `METER INFORMATION\n${'-'.repeat(40)}\n` +
      `  Meter ID:     ${m.display}\n  MAC Address:  ${formatMac(m.mac)}\n  Last IP:      ${m.ip || 'Not found'}\n`;
    if (ipChanged) c += `  ⚠ IP CHANGED DURING TEST\n  IP History:   ${m.ipHistory.join(', ')}\n`;
    c += `\nTEST PARAMETERS\n${'-'.repeat(40)}\n` +
      `  Start Time:   ${start}\n  End Time:     ${end}\n` +
      `  Duration:     ${duration} seconds (${Math.floor(duration / 60)}m ${duration % 60}s)\n  Total Rounds: ${rounds}\n` +
      `\nPING STATISTICS\n${'-'.repeat(40)}\n` +
      `  Total Pings:      ${m.pingCount}\n  Successful:       ${m.successCount}\n  Failed:           ${m.failCount}\n` +
      `  Success Rate:     ${rate.toFixed(1)}%\n  Packet Loss:      ${(100 - rate).toFixed(1)}%\n` +
      `\nRESPONSE TIME STATISTICS\n${'-'.repeat(40)}\n`;
    if (rt.length) c += `  Average:          ${avg.toFixed(2)}ms\n  Minimum:          ${min.toFixed(2)}ms\n  Maximum:          ${max.toFixed(2)}ms\n  Samples:          ${rt.length}\n`;
    else c += `  No successful pings recorded\n`;
    if (!separate) {
      c += `\n${'='.repeat(60)}\n  DETAILED PING LOG\n${'='.repeat(60)}\n\n`;
      m.pingLog.forEach((entry, i) => {
        const st = entry.success ? '✓ OK' : '✗ FAIL';
        const tstr = entry.responseTime ? `${entry.responseTime.toFixed(1)}ms` : 'N/A';
        c += `[${String(i + 1).padStart(4, '0')}] ${entry.timestamp} | Round ${String(entry.round).padStart(3, '0')} | ${st} | ${entry.ip || 'No IP'} | ${tstr}\n`;
        if (entry.error) c += `       Error: ${entry.error}\n`;
      });
    } else c += `\nIndividual ping files saved with format: ${base}-YYYYMMDD-HHMMSS.txt\n`;
    await window.api.wifi.writeFile({ folder: tab.outputFolder, filename, content: c, overwrite: tab.overwrite });
  }

  // ---------- scheduled ping -----------------------------------------------
  function openSchedulerDialog(tab) {
    if (!tab.meters.some((m) => m.checked)) { alert('Please select at least one meter before scheduling.'); return; }
    if (!tab.outputFolder) { alert('Please select an output folder before scheduling.'); return; }
    buildSchedulerModal(tab);
  }

  function findNextScheduled(now, hour, minute, days) {
    const cand = new Date(now); cand.setHours(hour, minute, 0, 0);
    const jsDay = (d) => (d.getDay() + 6) % 7; // convert Sun=0 to Mon=0
    if (cand > now && days.has(jsDay(now))) return cand;
    for (let off = 1; off <= 7; off++) {
      const c = new Date(now); c.setDate(c.getDate() + off); c.setHours(hour, minute, 0, 0);
      if (days.has(jsDay(c))) return c;
    }
    return null;
  }

  async function runScheduledLoop(tab, gen, settings) {
    const { hour, minute, totalHours, selectedDays, runMode, extendSeconds } = settings;
    const days = new Set(selectedDays);
    let runUntil = (runMode === 'until' && settings.runUntil) ? new Date(settings.runUntil) : new Date(Date.now() + totalHours * 3600 * 1000);
    let accumulated = 0;
    const daysStr = [...days].sort().map((d) => DAY_NAMES[d]).join(', ');
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const budget = () => `Until ${runUntil.toLocaleString()}`;
    const timeUp = () => Date.now() >= runUntil.getTime();

    setStatus(tab, 'Scheduler', `📅 Scheduled: ${daysStr} at ${timeStr} | Budget: ${budget()}`);

    while (!tab.stopRequested && !timeUp() && genCurrent(tab, gen)) {
      const now = new Date();
      const next = findNextScheduled(now, hour, minute, days);
      if (!next) { setStatus(tab, 'Scheduler', '⚠ No valid days selected'); break; }
      if (next.getTime() >= runUntil.getTime()) { setStatus(tab, 'Scheduler', '⏸ Next scheduled run would be after the end time — stopping.'); break; }

      const waitMs = next - now;
      if (waitMs > 0) {
        setStatus(tab, 'Scheduler', `💤 Next run: ${next.toLocaleString()} (in ${fmtWait(waitMs / 1000)}) | Logged: ${(accumulated / 3600).toFixed(1)}h | Budget: ${budget()}`);
        let last = 0;
        while (Date.now() < next.getTime()) {
          if (tab.stopRequested || Date.now() >= runUntil.getTime()) break;
          await sleep(1000);
          if (Date.now() - last >= 30000) { const rem = (next.getTime() - Date.now()) / 1000; if (rem > 0) setStatus(tab, 'Scheduler', `💤 ${fmtWait(rem)} until next run (${next.toLocaleString()})`); last = Date.now(); }
        }
        if (tab.stopRequested || timeUp()) break;
      }

      const remaining = Math.max(0, (runUntil.getTime() - Date.now()) / 1000);
      const midnight = new Date(); midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
      const maxSession = Math.min(remaining, (midnight.getTime() - Date.now()) / 1000);
      if (maxSession <= 0) break;

      setStatus(tab, 'Scheduler', `▶ Running ping session (max ${fmtWait(maxSession)}) | Logged: ${(accumulated / 3600).toFixed(1)}h | Budget: ${budget()}`);
      tab.schedulerSessionStop = false;
      const runStart = Date.now();
      const watchdog = setTimeout(() => { if (!tab.stopRequested) tab.schedulerSessionStop = true; }, maxSession * 1000);
      await runPingSession(tab, gen);
      clearTimeout(watchdog);
      accumulated += (Date.now() - runStart) / 1000;

      if (extendSeconds > 0) { runUntil = new Date(runUntil.getTime() + extendSeconds * 1000); setStatus(tab, 'Scheduler', `⏸ Session done (+${fmtWait(extendSeconds)} extend) | Logged: ${(accumulated / 3600).toFixed(1)}h | ${budget()}`); }
      else setStatus(tab, 'Scheduler', `⏸ Session done | Logged: ${(accumulated / 3600).toFixed(1)}h | Budget: ${budget()}`);
    }

    if (!genCurrent(tab, gen)) return;
    if (timeUp()) { setStatus(tab, 'Scheduler', `✓ Schedule complete! Ran ${(accumulated / 3600).toFixed(1)} hours total.`); setTimeout(() => alert(`Scheduled ping completed.\nTotal runtime: ${(accumulated / 3600).toFixed(1)} hours`), 0); }
    else setStatus(tab, 'Scheduler', `⬛ Schedule stopped. Logged ${(accumulated / 3600).toFixed(1)}h | Budget: ${budget()}`);
    stopTimer(tab);
  }

  async function runPingSession(tab, gen) {
    if (tab.wifiConnect) {
      setStatus(tab, 'Scheduler', '📶 Reconnecting to WiFi...');
      const r = await window.api.wifi.connectWifi();
      if (r.connected) { for (let i = 15; i > 0; i--) { if (tab.stopRequested || tab.schedulerSessionStop) break; setStatus(tab, 'Scheduler', `⏳ Waiting for network to stabilize... (${i}s)`); await sleep(1000); } }
      else { setStatus(tab, 'Scheduler', '⚠ WiFi reconnect failed — attempting scan anyway...'); await sleep(5000); }
    }
    // fresh status/start-times for this session
    const now = Date.now();
    tab.filtered.forEach((m) => { tab.statusDict[m.filename] = '⏳ RUNNING'; tab.startTimes[m.filename] = now; });
    refreshStatus(tab);
    await runScanLoop(tab, gen, true);
  }

  // ---------- modals --------------------------------------------------------
  function overlay(inner, width) {
    const ov = document.createElement('div');
    ov.className = 'wifi-modal-overlay';
    ov.innerHTML = `<div class="wifi-modal" style="max-width:${width || 560}px">${inner}</div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    return ov;
  }

  function buildSchedulerModal(tab) {
    const dayBtns = DAY_NAMES.map((d, i) => `<button type="button" class="wifi-day active" data-day="${i}">${d}</button>`).join('');
    const hours = Array.from({ length: 12 }, (_, i) => `<option${i + 1 === 8 ? ' selected' : ''}>${i + 1}</option>`).join('');
    const ov = overlay(`
      <div class="wifi-modal-title">📅 Schedule Ping</div>
      <div class="wifi-modal-section">
        <label>Repeat on</label>
        <div class="wifi-days">${dayBtns}</div>
        <label>Start time</label>
        <div class="wifi-time">
          <select id="sch-hour" class="kicad-input">${hours}</select> :
          <select id="sch-min" class="kicad-input"><option>00</option><option>15</option><option>30</option><option>45</option></select>
          <select id="sch-ampm" class="kicad-input"><option>AM</option><option>PM</option></select>
        </div>
      </div>
      <div class="wifi-modal-section">
        <label>Duration</label>
        <div class="wifi-radio"><label><input type="radio" name="sch-mode" value="for" checked> Run for</label>
          <label><input type="radio" name="sch-mode" value="until"> Run until</label></div>
        <div id="sch-for" class="wifi-time">
          Days <input id="sch-d" class="kicad-input wifi-num" type="number" min="0" value="0">
          Hrs <input id="sch-h" class="kicad-input wifi-num" type="number" min="0" max="23" value="1">
          Min <input id="sch-m" class="kicad-input wifi-num" type="number" min="0" max="59" value="0">
        </div>
        <div id="sch-until" class="wifi-time" style="display:none">Until <input id="sch-until-dt" class="kicad-input" type="datetime-local"></div>
      </div>
      <div class="wifi-modal-section">
        <label>Extend remaining time (after each session)</label>
        <div class="wifi-time">
          Days <input id="sch-ed" class="kicad-input wifi-num" type="number" min="0" value="0">
          Hrs <input id="sch-eh" class="kicad-input wifi-num" type="number" min="0" max="23" value="0">
          Min <input id="sch-em" class="kicad-input wifi-num" type="number" min="0" max="59" value="0">
        </div>
      </div>
      <div class="wifi-modal-actions">
        <button id="sch-cancel" class="kicad-btn kicad-btn-outline">Cancel</button>
        <button id="sch-start" class="kicad-btn kicad-btn-start">Start Schedule</button>
      </div>`, 560);

    ov.querySelectorAll('.wifi-day').forEach((b) => b.addEventListener('click', () => b.classList.toggle('active')));
    ov.querySelectorAll('input[name=sch-mode]').forEach((r) => r.addEventListener('change', () => {
      const isFor = ov.querySelector('input[name=sch-mode]:checked').value === 'for';
      ov.querySelector('#sch-for').style.display = isFor ? '' : 'none';
      ov.querySelector('#sch-until').style.display = isFor ? 'none' : '';
    }));
    ov.querySelector('#sch-cancel').addEventListener('click', () => ov.remove());
    ov.querySelector('#sch-start').addEventListener('click', () => {
      const days = [...ov.querySelectorAll('.wifi-day.active')].map((b) => +b.dataset.day);
      if (!days.length) { alert('Please select at least one day.'); return; }
      let hour = parseInt(ov.querySelector('#sch-hour').value, 10);
      const minute = parseInt(ov.querySelector('#sch-min').value, 10);
      const pm = ov.querySelector('#sch-ampm').value === 'PM';
      if (pm && hour !== 12) hour += 12; else if (!pm && hour === 12) hour = 0;
      const mode = ov.querySelector('input[name=sch-mode]:checked').value;
      let totalSeconds = 0, runUntil = null;
      if (mode === 'for') {
        totalSeconds = (+ov.querySelector('#sch-d').value) * 86400 + (+ov.querySelector('#sch-h').value) * 3600 + (+ov.querySelector('#sch-m').value) * 60;
        if (totalSeconds <= 0) { alert('Please enter a positive run duration.'); return; }
      } else {
        const v = ov.querySelector('#sch-until-dt').value;
        if (!v) { alert('Please enter a valid end date/time.'); return; }
        runUntil = new Date(v);
        if (runUntil.getTime() <= Date.now()) { alert('Run-until must be in the future.'); return; }
        totalSeconds = (runUntil.getTime() - Date.now()) / 1000;
      }
      const extendSeconds = (+ov.querySelector('#sch-ed').value) * 86400 + (+ov.querySelector('#sch-eh').value) * 3600 + (+ov.querySelector('#sch-em').value) * 60;
      ov.remove();
      startScheduled(tab, { hour, minute, totalHours: totalSeconds / 3600, selectedDays: days, runMode: mode, runUntil: runUntil ? runUntil.toISOString() : null, extendSeconds });
    });
  }

  function startScheduled(tab, settings) {
    prepareRun(tab, '📅 SCHEDULED');
    tab.running = true; tab.stopRequested = false; tab.schedulerSessionStop = false;
    startTimer(tab);
    tab.scanGen += 1;
    runScheduledLoop(tab, tab.scanGen, settings);
  }

  function openTempDialog(tab) {
    if (!tab.outputFolder) { alert('Please select an output folder first.'); return; }
    const meters = tab.meters;
    if (!meters.length) { alert('Load a meter status file first.'); return; }
    const rows = meters.map((m, i) => `<label class="wifi-meter-row"><input type="checkbox" data-i="${i}"> <span>${esc(m.display)}</span></label>`).join('');
    const ov = overlay(`
      <div class="wifi-modal-title">🌡 Temperature Shutdown</div>
      <div class="wifi-modal-section">
        <label>Select Meters</label>
        <input id="temp-search" class="kicad-input" placeholder="🔍 Search meters...">
        <div class="wifi-btnrow"><button id="temp-uncheck" class="kicad-btn kicad-btn-outline">Uncheck All</button><button id="temp-check" class="kicad-btn kicad-btn-outline">Check All</button></div>
        <div id="temp-list" class="wifi-meter-list" style="max-height:240px">${rows}</div>
      </div>
      <div class="wifi-modal-section">
        <label>Set Temperature</label>
        <input id="temp-value" class="kicad-input" placeholder="Enter temperature (e.g., 85)">
        <button id="temp-push" class="kicad-btn kicad-btn-start" style="margin-top:8px">PUSH TEMPERATURE</button>
      </div>
      <div class="wifi-modal-section"><label>Status</label><pre id="temp-status" class="wifi-status" style="min-height:140px"></pre></div>
      <div class="wifi-modal-actions"><button id="temp-close" class="kicad-btn kicad-btn-outline">Close</button></div>`, 700);

    const listEl = ov.querySelector('#temp-list');
    ov.querySelector('#temp-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      listEl.querySelectorAll('.wifi-meter-row').forEach((r) => { r.classList.toggle('hidden', !r.textContent.toLowerCase().includes(q)); });
    });
    ov.querySelector('#temp-check').addEventListener('click', () => listEl.querySelectorAll('input').forEach((c) => { if (!c.closest('.wifi-meter-row').classList.contains('hidden')) c.checked = true; }));
    ov.querySelector('#temp-uncheck').addEventListener('click', () => listEl.querySelectorAll('input').forEach((c) => c.checked = false));
    ov.querySelector('#temp-close').addEventListener('click', () => ov.remove());
    ov.querySelector('#temp-push').addEventListener('click', () => pushTemp(tab, ov));
  }

  async function pushTemp(tab, ov) {
    const idxs = [...ov.querySelectorAll('#temp-list input:checked')].map((c) => +c.dataset.i);
    if (!idxs.length) { alert('Please select at least one meter.'); return; }
    const temp = ov.querySelector('#temp-value').value.trim();
    if (!/^\d+$/.test(temp)) { alert('Please enter a valid temperature (number).'); return; }
    const statusEl = ov.querySelector('#temp-status');
    const status = {};
    const render = () => { statusEl.textContent = Object.entries(status).map(([k, v]) => `${k} … ${v}`).join('\n'); };
    const selected = idxs.map((i) => ({ display: tab.meters[i].display, mac: tab.meters[i].mac, filename: `${tab.meters[i].display}-temp_${temp}.txt` }));
    selected.forEach((m) => status[m.filename] = 'RUNNING');
    render();

    const map = (await window.api.wifi.discoverIps()).map || {};
    for (const m of selected) {
      status[m.filename] = 'FINDING IP...'; render();
      const ip = map[hexOnly(m.mac)];
      if (!ip) { status[m.filename] = 'NO IP FOUND'; render(); continue; }
      status[m.filename] = `PUSHING TEMP TO ${ip}`; render();
      const r = await window.api.wifi.setTemp({ ip, temp });
      let content = `File: ${m.filename}\nMAC: ${formatMac(m.mac)}\nIP: ${ip}\nTemperature Set: ${temp}\n`;
      if (r.error && !r.output) { content += `Error: ${r.error}\n`; status[m.filename] = `PUSH FAILED: ${r.error}`; }
      else {
        content += `Set Command Output:\n${r.output}\nSet Command Error:\n${r.error || ''}\nVerify Command Output:\n${r.verify}\n`;
        status[m.filename] = r.ok ? `PUSHED SUCCESSFULLY (Verified: ${r.verify})` : `PUSH FAILED: ${r.error || 'Verification failed'}`;
      }
      await window.api.wifi.writeFile({ folder: tab.outputFolder, filename: m.filename, content, overwrite: tab.overwrite });
      render();
    }
  }

  // ---------- public --------------------------------------------------------
  function render(container) {
    container.innerHTML = `
      <div class="wifi-checker">
        <div id="wifi-tabbar" class="wifi-tabbar"></div>
        <div id="wifi-body" class="wifi-body-wrap"></div>
      </div>`;
    if (!tabs.length) { const t = newTab(); tabs.push(t); activeId = t.id; }
    renderTabBar();
    renderBody();
  }

  return {
    mount(container) { if (!mounted) { render(container); mounted = true; } },
    activate() { if (mounted) { renderTabBar(); renderBody(); } },
    deactivate() {},
  };
})();
