// UART Bridge utility — a node-graph serial workbench. Add as many devices as you
// need (standard COM/UART ports via Web Serial, or FTDI bit-bang channels via the
// Python helper), drag wires from a device's TX to another's RX to live-bridge
// their data, send hex/ASCII/line-pulses, and watch all traffic in a monitor.
//
// UART uses the browser-native Web Serial API (no native module); the OS port
// picker is relayed from main (see main.js select-serial-port). FTDI uses
// window.api.ftdi.* → ipc/ftdi_helper.py (ftd2xx). Desktop-only built-in utility.

const uartBridge = (() => {
  const NODE_W = 264;       // node width (px) — used for terminal coordinates
  const TERM_Y = 34;        // terminal vertical offset from node top
  const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

  let mounted = false;
  let devices = [];         // see newUart/newFtdi
  let wires = [];           // { id, from: devId (TX/source), to: devId (RX/sink) }
  let counter = 0;
  let drag = null;          // node drag state
  let wireDrag = null;      // wire drag state
  let portPickCb = null;    // pending Web Serial port-list resolver

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  const byId = (id) => devices.find((d) => d.id === id);

  // ---- byte helpers --------------------------------------------------------
  function parseInput(mode, text) {
    if (mode === 'ascii') return new TextEncoder().encode(text);
    // hex
    const hex = (text || '').replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
    const out = [];
    for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    if (hex.length % 2) out.push(parseInt(hex[hex.length - 1], 16));
    return new Uint8Array(out);
  }
  const toHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const toAscii = (bytes) => Array.from(bytes).map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '·').join('');
  function lineEndingBytes(dev) {
    return { lf: [0x0a], crlf: [0x0d, 0x0a], cr: [0x0d] }[dev.lineEnding] || [];
  }
  function concatBytes(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }
  function updateStats(dev) {
    const el = document.getElementById('stats-' + dev.id);
    if (el) el.textContent = `TX ${dev.txCount} B · RX ${dev.rxCount} B`;
  }

  // ---- monitor log ---------------------------------------------------------
  function log(devName, dir, bytes, note) {
    const el = document.getElementById('uart-monitor');
    if (!el) return;
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    const arrow = dir === 'rx' ? '◀ RX' : dir === 'tx' ? 'TX ▶' : '··';
    const cls = dir === 'rx' ? 'uart-rx' : dir === 'tx' ? 'uart-tx' : 'uart-sys';
    const hex = bytes ? `<span class="uart-hex">${toHex(bytes)}</span>  <span class="uart-ascii">${esc(toAscii(bytes))}</span>` : '';
    const line = document.createElement('div');
    line.className = 'uart-logline ' + cls;
    line.innerHTML = `<span class="uart-ts">${ts}</span> <b>${esc(devName)}</b> ${arrow} ${hex}${note ? '<i> ' + esc(note) + '</i>' : ''}`;
    el.appendChild(line);
    while (el.childNodes.length > 500) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  // ---- device factories ----------------------------------------------------
  function newUart(port, info) {
    counter += 1;
    return {
      id: 'd' + counter, type: 'uart', name: (info && (info.displayName || info.portName)) || ('COM ' + counter),
      port, info, connected: false, reader: null, writer: null,
      x: 40 + (devices.length % 3) * 300, y: 40 + Math.floor(devices.length / 3) * 200,
      baud: 9600, dataBits: 8, parity: 'none', stopBits: 1,
      sendMode: 'hex', sendText: '', lineEnding: 'none', repeat: false, interval: 1000, repTimer: null,
      dtr: false, rts: false, txCount: 0, rxCount: 0,
    };
  }
  function newFtdi(index, serial) {
    counter += 1;
    return {
      id: 'd' + counter, type: 'ftdi', name: 'FTDI ' + (serial || index), ftdiIndex: index, serial,
      connected: false,
      x: 40 + (devices.length % 3) * 300, y: 40 + Math.floor(devices.length / 3) * 200,
      mask: 0x01, baud: 9600,
      sendMode: 'hex', sendText: '01', lineEnding: 'none', repeat: false, interval: 1000, repTimer: null, pulseState: 0,
      txCount: 0, rxCount: 0,
    };
  }

  // ---- add devices ---------------------------------------------------------
  async function addUart() {
    if (!('serial' in navigator)) { alert('Web Serial is not available in this build.'); return; }
    portPickCb = (ports) => { portPickCb = null; showPortPicker(ports); };
    try {
      const port = await navigator.serial.requestPort();
      const info = (typeof port.getInfo === 'function') ? port.getInfo() : {};
      devices.push(newUart(port, info));
      renderNodes();
    } catch (e) { /* user cancelled / no port */ }
  }

  function showPortPicker(ports) {
    // Resolve a friendly label, then auto-call selectPort with the chosen portId.
    if (!ports || !ports.length) { window.api.serial.selectPort(''); alert('No serial ports detected.'); return; }
    if (ports.length === 1) { window.api.serial.selectPort(ports[0].portId); return; }
    const ov = overlay(`
      <div class="uart-modal-title">Select a serial port</div>
      <div id="uart-portlist" class="uart-portlist"></div>
      <div class="uart-modal-actions"><button id="uart-port-cancel" class="kicad-btn kicad-btn-outline">Cancel</button></div>`);
    const list = ov.querySelector('#uart-portlist');
    list.innerHTML = ports.map((p, i) => `<button class="uart-port-row" data-id="${esc(p.portId)}">
      <b>${esc(p.portName || p.displayName || ('Port ' + i))}</b>
      <span>${p.vendorId ? 'VID ' + p.vendorId + ' PID ' + p.productId : ''}</span></button>`).join('');
    list.querySelectorAll('.uart-port-row').forEach((b) => b.addEventListener('click', () => { window.api.serial.selectPort(b.dataset.id); ov.remove(); }));
    ov.querySelector('#uart-port-cancel').addEventListener('click', () => { window.api.serial.selectPort(''); ov.remove(); });
  }

  async function addFtdi() {
    const r = await window.api.ftdi.list();
    if (!r.ok) { alert('FTDI: ' + (r.error || 'could not list devices')); return; }
    if (!r.ports || !r.ports.length) { alert('No FTDI devices found.'); return; }
    const ov = overlay(`
      <div class="uart-modal-title">Select an FTDI channel</div>
      <div id="uart-portlist" class="uart-portlist"></div>
      <div class="uart-modal-actions"><button id="uart-ftdi-cancel" class="kicad-btn kicad-btn-outline">Cancel</button></div>`);
    const list = ov.querySelector('#uart-portlist');
    list.innerHTML = r.ports.map((p) => `<button class="uart-port-row" data-i="${p.index}" data-s="${esc(p.serial)}">
      <b>${esc(p.serial || ('Index ' + p.index))}</b><span>index ${p.index}</span></button>`).join('');
    list.querySelectorAll('.uart-port-row').forEach((b) => b.addEventListener('click', () => {
      devices.push(newFtdi(parseInt(b.dataset.i, 10), b.dataset.s)); renderNodes(); ov.remove();
    }));
    ov.querySelector('#uart-ftdi-cancel').addEventListener('click', () => ov.remove());
  }

  // ---- connect / disconnect ------------------------------------------------
  async function connect(dev) {
    if (dev.type === 'uart') {
      try {
        await dev.port.open({ baudRate: dev.baud, dataBits: dev.dataBits, stopBits: dev.stopBits, parity: dev.parity, flowControl: 'none' });
        dev.writer = dev.port.writable.getWriter();
        dev.connected = true;
        readLoop(dev);
        log(dev.name, 'sys', null, `opened @ ${dev.baud} ${dev.dataBits}${dev.parity[0].toUpperCase()}${dev.stopBits}`);
      } catch (e) { alert('Open failed: ' + e.message); return; }
    } else {
      const o = await window.api.ftdi.open(dev.ftdiIndex);
      if (!o.ok) { alert('FTDI open failed: ' + o.error); return; }
      const bm = await window.api.ftdi.bitmode(dev.ftdiIndex, dev.mask, 0x01); // async bit-bang
      if (!bm.ok) { alert('FTDI bitmode failed: ' + bm.error); return; }
      dev.connected = true;
      log(dev.name, 'sys', null, `bit-bang mask 0x${dev.mask.toString(16)}`);
    }
    renderNodes();
  }

  async function disconnect(dev) {
    stopRepeat(dev);
    if (dev.type === 'uart') {
      try { if (dev.reader) { await dev.reader.cancel(); dev.reader.releaseLock(); } } catch {}
      try { if (dev.writer) { dev.writer.releaseLock(); } } catch {}
      try { await dev.port.close(); } catch {}
      dev.reader = dev.writer = null;
    } else {
      try { await window.api.ftdi.close(dev.ftdiIndex); } catch {}
    }
    dev.connected = false;
    log(dev.name, 'sys', null, 'closed');
    renderNodes();
  }

  async function readLoop(dev) {
    try {
      dev.reader = dev.port.readable.getReader();
      while (dev.connected) {
        const { value, done } = await dev.reader.read();
        if (done) break;
        if (value && value.length) handleIncoming(dev, value);
      }
    } catch (e) { /* closed */ } finally {
      try { dev.reader && dev.reader.releaseLock(); } catch {}
    }
  }

  // Data received on dev → log + forward along wires where dev is the source (TX).
  function handleIncoming(dev, bytes) {
    dev.rxCount += bytes.length; updateStats(dev);
    log(dev.name, 'rx', bytes);
    forward(dev, bytes);
  }
  function forward(srcDev, bytes) {
    for (const w of wires) {
      if (w.from !== srcDev.id) continue;
      const target = byId(w.to);
      if (target && target.connected) { writeOut(target, bytes, true); }
    }
  }

  async function writeOut(dev, bytes, bridged) {
    if (!dev.connected) return;
    try {
      if (dev.type === 'uart') { await dev.writer.write(bytes); }
      else { await window.api.ftdi.write(dev.ftdiIndex, Array.from(bytes)); }
      dev.txCount += bytes.length; updateStats(dev);
      log(dev.name, 'tx', bytes, bridged ? 'bridged' : null);
    } catch (e) { log(dev.name, 'sys', null, 'write error: ' + e.message); }
  }

  // ---- manual send ---------------------------------------------------------
  async function manualSend(dev) {
    if (!dev.connected) { alert('Connect the device first.'); return; }
    if (dev.type === 'uart' && dev.sendMode === 'line') {
      dev.dtr = !dev.dtr; // toggle DTR as the "line" pulse
      try { await dev.port.setSignals({ dataTerminalReady: dev.dtr, requestToSend: dev.rts }); log(dev.name, 'sys', null, 'DTR ' + (dev.dtr ? 'HIGH' : 'LOW')); }
      catch (e) { log(dev.name, 'sys', null, 'signal error: ' + e.message); }
      return;
    }
    if (dev.type === 'ftdi' && dev.sendMode === 'pulse') {
      dev.pulseState = dev.pulseState ? 0 : (dev.mask & 0xff); // toggle masked pins
      await writeOut(dev, new Uint8Array([dev.pulseState]), false);
      return;
    }
    let bytes = parseInput(dev.sendMode, dev.sendText);
    if (dev.type === 'uart' && (dev.sendMode === 'hex' || dev.sendMode === 'ascii')) {
      const le = lineEndingBytes(dev);
      if (le.length) bytes = concatBytes(bytes, new Uint8Array(le));
    }
    if (!bytes.length) return;
    await writeOut(dev, bytes, false);
    forward(dev, bytes); // also push manual sends downstream
  }

  function startRepeat(dev) {
    stopRepeat(dev);
    const ms = Math.max(50, parseInt(dev.interval, 10) || 1000);
    dev.repTimer = setInterval(() => manualSend(dev), ms);
  }
  function stopRepeat(dev) { if (dev.repTimer) { clearInterval(dev.repTimer); dev.repTimer = null; } }

  // ---- rendering -----------------------------------------------------------
  function render(container) {
    container.innerHTML = `
      <div class="uart-bridge">
        <div class="uart-toolbar">
          <button id="uart-add-uart" class="kicad-btn kicad-btn-start">+ COM / UART Device</button>
          <button id="uart-add-ftdi" class="kicad-btn">+ FTDI Bit-bang</button>
          <span class="uart-hint">Drag a node to move it • drag from a <b>TX</b> dot to an <b>RX</b> dot to bridge</span>
          <button id="uart-clear" class="kicad-btn kicad-btn-outline" style="margin-left:auto">Clear All</button>
        </div>
        <div id="uart-canvas" class="uart-canvas">
          <svg id="uart-wires" class="uart-wires"></svg>
          <div id="uart-nodes"></div>
        </div>
        <div class="uart-monitor-wrap">
          <div class="uart-monitor-head"><span>Monitor</span>
            <span style="margin-left:auto;display:flex;gap:6px">
              <button id="uart-save-mon" class="kicad-btn kicad-btn-outline">Save log</button>
              <button id="uart-clear-mon" class="kicad-btn kicad-btn-outline">Clear log</button>
            </span></div>
          <div id="uart-monitor" class="uart-monitor"></div>
        </div>
      </div>`;
    document.getElementById('uart-add-uart').addEventListener('click', addUart);
    document.getElementById('uart-add-ftdi').addEventListener('click', addFtdi);
    document.getElementById('uart-clear').addEventListener('click', clearAll);
    document.getElementById('uart-clear-mon').addEventListener('click', () => { const m = document.getElementById('uart-monitor'); if (m) m.innerHTML = ''; });
    document.getElementById('uart-save-mon').addEventListener('click', saveLog);
    const canvas = document.getElementById('uart-canvas');
    canvas.addEventListener('mousemove', onCanvasMove);
    canvas.addEventListener('mouseup', onCanvasUp);
    renderNodes();
  }

  function nodeHTML(dev) {
    const opt = (arr, v) => arr.map((x) => `<option${x === v ? ' selected' : ''}>${x}</option>`).join('');
    const statusDot = `<span class="uart-status ${dev.connected ? 'on' : ''}"></span>`;
    let cfg, send;
    if (dev.type === 'uart') {
      cfg = `<div class="uart-cfg">
        <select data-f="baud" class="kicad-input">${opt(BAUDS, dev.baud)}</select>
        <select data-f="dataBits" class="kicad-input">${opt([7, 8], dev.dataBits)}</select>
        <select data-f="parity" class="kicad-input">${['none', 'even', 'odd'].map((p) => `<option${p === dev.parity ? ' selected' : ''}>${p}</option>`).join('')}</select>
        <select data-f="stopBits" class="kicad-input">${opt([1, 2], dev.stopBits)}</select>
      </div>`;
      send = `<div class="uart-send">
        <select data-f="sendMode" class="kicad-input uart-sm">
          <option value="hex"${dev.sendMode === 'hex' ? ' selected' : ''}>Hex</option>
          <option value="ascii"${dev.sendMode === 'ascii' ? ' selected' : ''}>ASCII</option>
          <option value="line"${dev.sendMode === 'line' ? ' selected' : ''}>Line (DTR)</option>
        </select>
        <input data-f="sendText" class="kicad-input" value="${esc(dev.sendText)}" placeholder="${dev.sendMode === 'ascii' ? 'text… (Enter to send)' : '01 FF A0'}">
        <select data-f="lineEnding" class="kicad-input uart-le" title="Appended to each send">
          <option value="none"${dev.lineEnding === 'none' ? ' selected' : ''}>—</option>
          <option value="lf"${dev.lineEnding === 'lf' ? ' selected' : ''}>\\n</option>
          <option value="crlf"${dev.lineEnding === 'crlf' ? ' selected' : ''}>\\r\\n</option>
          <option value="cr"${dev.lineEnding === 'cr' ? ' selected' : ''}>\\r</option>
        </select>
      </div>`;
    } else {
      cfg = `<div class="uart-cfg">
        <label class="uart-lbl">Pin mask 0x</label>
        <input data-f="mask" class="kicad-input uart-mask" value="${dev.mask.toString(16)}">
      </div>`;
      send = `<div class="uart-send">
        <select data-f="sendMode" class="kicad-input uart-sm">
          <option value="hex"${dev.sendMode === 'hex' ? ' selected' : ''}>Pins (hex)</option>
          <option value="pulse"${dev.sendMode === 'pulse' ? ' selected' : ''}>Pulse</option>
        </select>
        <input data-f="sendText" class="kicad-input" value="${esc(dev.sendText)}" placeholder="01">
      </div>`;
    }
    return `
      <div class="uart-node" id="node-${dev.id}" style="left:${dev.x}px;top:${dev.y}px;width:${NODE_W}px">
        <div class="uart-node-head" data-drag="${dev.id}">
          ${statusDot}<span class="uart-node-name">${esc(dev.name)}</span>
          <span class="uart-node-type">${dev.type === 'uart' ? 'UART' : 'FTDI'}</span>
          <button class="uart-node-x" data-remove="${dev.id}" title="Remove">&times;</button>
        </div>
        <div class="uart-term uart-term-rx" data-term="rx" data-dev="${dev.id}" title="RX — data written into this port (wire sink)"></div>
        <div class="uart-term uart-term-tx" data-term="tx" data-dev="${dev.id}" title="TX — data this port emits (wire source)"></div>
        <span class="uart-term-label uart-tl-rx">RX</span>
        <span class="uart-term-label uart-tl-tx">TX</span>
        <div class="uart-node-body">
          ${cfg}
          ${send}
          <div class="uart-row">
            <label class="uart-cb"><input type="checkbox" data-f="repeat" ${dev.repeat ? 'checked' : ''}> Repeat</label>
            <input data-f="interval" class="kicad-input uart-int" value="${dev.interval}" title="ms"> ms
            <button class="uart-send-btn kicad-btn kicad-btn-start" data-send="${dev.id}">Send</button>
          </div>
          <div class="uart-stats" id="stats-${dev.id}">TX ${dev.txCount} B · RX ${dev.rxCount} B</div>
          <button class="kicad-btn ${dev.connected ? 'kicad-btn-outline' : ''} uart-conn" data-conn="${dev.id}">${dev.connected ? 'Disconnect' : 'Connect'}</button>
        </div>
      </div>`;
  }

  function renderNodes() {
    const wrap = document.getElementById('uart-nodes');
    if (!wrap) return;
    wrap.innerHTML = devices.map(nodeHTML).join('');
    devices.forEach(bindNode);
    renderWires();
  }

  function bindNode(dev) {
    const node = document.getElementById('node-' + dev.id);
    if (!node) return;
    node.querySelector('[data-drag]').addEventListener('mousedown', (e) => {
      if (e.target.dataset.remove !== undefined) return;
      drag = { dev, dx: e.clientX - dev.x, dy: e.clientY - dev.y }; e.preventDefault();
    });
    node.querySelector('[data-remove]').addEventListener('click', () => removeDevice(dev));
    node.querySelector('[data-conn]').addEventListener('click', () => dev.connected ? disconnect(dev) : connect(dev));
    node.querySelector('[data-send]').addEventListener('click', () => manualSend(dev));
    node.querySelectorAll('[data-f]').forEach((el) => {
      const ev = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(ev, () => {
        const f = el.dataset.f;
        if (f === 'repeat') { dev.repeat = el.checked; dev.repeat ? startRepeat(dev) : stopRepeat(dev); return; }
        if (f === 'mask') { dev.mask = parseInt(el.value, 16) || 0; return; }
        if (['baud', 'dataBits', 'stopBits', 'interval'].includes(f)) dev[f] = parseInt(el.value, 10);
        else dev[f] = el.value;
        if (f === 'sendMode') renderNodes();
      });
    });
    // Enter in the send field = Send
    const sendInput = node.querySelector('[data-f="sendText"]');
    if (sendInput) sendInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); manualSend(dev); } });
    // terminals: start a wire from TX, accept on RX
    const tx = node.querySelector('[data-term="tx"]');
    const rx = node.querySelector('[data-term="rx"]');
    tx.addEventListener('mousedown', (e) => { wireDrag = { from: dev.id, x: e.clientX, y: e.clientY }; e.stopPropagation(); e.preventDefault(); });
    rx.addEventListener('mouseup', (e) => {
      if (wireDrag && wireDrag.from && wireDrag.from !== dev.id) { addWire(wireDrag.from, dev.id); }
      wireDrag = null; e.stopPropagation();
    });
  }

  function onCanvasMove(e) {
    if (drag) {
      const canvas = document.getElementById('uart-canvas').getBoundingClientRect();
      drag.dev.x = Math.max(0, e.clientX - drag.dx);
      drag.dev.y = Math.max(0, e.clientY - drag.dy);
      const node = document.getElementById('node-' + drag.dev.id);
      node.style.left = drag.dev.x + 'px'; node.style.top = drag.dev.y + 'px';
      renderWires();
    } else if (wireDrag) {
      wireDrag.x = e.clientX; wireDrag.y = e.clientY; renderWires();
    }
  }
  function onCanvasUp() { drag = null; wireDrag = null; renderWires(); }

  function termPos(dev, term) {
    const canvas = document.getElementById('uart-canvas').getBoundingClientRect();
    const x = dev.x + (term === 'tx' ? NODE_W : 0);
    const y = dev.y + TERM_Y;
    return { x, y };
  }

  function renderWires() {
    const svg = document.getElementById('uart-wires');
    if (!svg) return;
    const canvas = document.getElementById('uart-canvas').getBoundingClientRect();
    let paths = '';
    for (const w of wires) {
      const a = byId(w.from), b = byId(w.to);
      if (!a || !b) continue;
      const p1 = termPos(a, 'tx'), p2 = termPos(b, 'rx');
      paths += wirePath(p1, p2, w.id, false);
    }
    if (wireDrag && wireDrag.from) {
      const a = byId(wireDrag.from);
      if (a) { const p1 = termPos(a, 'tx'); const p2 = { x: wireDrag.x - canvas.left, y: wireDrag.y - canvas.top }; paths += wirePath(p1, p2, 'drag', true); }
    }
    svg.innerHTML = paths;
    svg.querySelectorAll('[data-wire]').forEach((p) => p.addEventListener('click', () => removeWire(p.dataset.wire)));
  }
  function wirePath(p1, p2, id, temp) {
    const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
    const d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
    if (temp) return `<path d="${d}" class="uart-wire uart-wire-temp" fill="none"/>`;
    return `<path d="${d}" class="uart-wire-hit" data-wire="${id}" fill="none"/><path d="${d}" class="uart-wire" fill="none"/>`;
  }

  function addWire(from, to) {
    if (wires.some((w) => w.from === from && w.to === to)) return;
    counter += 1;
    wires.push({ id: 'w' + counter, from, to });
    const a = byId(from), b = byId(to);
    log('bridge', 'sys', null, `${a ? a.name : from} TX → ${b ? b.name : to} RX`);
    renderWires();
  }
  function removeWire(id) { wires = wires.filter((w) => w.id !== id); renderWires(); }

  async function removeDevice(dev) {
    if (dev.connected) await disconnect(dev);
    wires = wires.filter((w) => w.from !== dev.id && w.to !== dev.id);
    devices = devices.filter((d) => d.id !== dev.id);
    renderNodes();
  }
  async function clearAll() {
    if (devices.length && !confirm('Disconnect and remove all devices and wires?')) return;
    for (const d of devices.slice()) { if (d.connected) await disconnect(d); }
    devices = []; wires = []; renderNodes();
  }

  function saveLog() {
    const m = document.getElementById('uart-monitor');
    if (!m || !m.textContent.trim()) { alert('Monitor is empty.'); return; }
    const text = Array.from(m.children).map((c) => c.textContent).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'uart-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- modal helper --------------------------------------------------------
  function overlay(inner) {
    const ov = document.createElement('div');
    ov.className = 'wifi-modal-overlay';
    ov.innerHTML = `<div class="wifi-modal" style="max-width:420px">${inner}</div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    return ov;
  }

  // ---- public --------------------------------------------------------------
  return {
    mount(container) {
      if (mounted) return;
      // Web Serial port-list relay from main → our pending picker.
      if (window.api.serial && window.api.serial.onPortList) window.api.serial.onPortList((ports) => { if (portPickCb) portPickCb(ports); });
      render(container);
      mounted = true;
    },
    activate() { if (mounted) renderNodes(); },
    deactivate() {},
  };
})();
