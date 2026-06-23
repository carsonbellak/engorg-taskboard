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
  let pendingPortName = null; // OS COM name of the port being added (for codegen)
  let program = { name: 'untitled', steps: [] };
  let running = false;      // program run state

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
      port, info, portName: pendingPortName || null, connected: false, reader: null, writer: null,
      x: 40 + (devices.length % 3) * 300, y: 40 + Math.floor(devices.length / 3) * 200,
      baud: 9600, dataBits: 8, parity: 'none', stopBits: 1,
      board: 'generic', driver: 'serial-command',
      cmds: { set: 'GPIO {pin} {val}\n', read: 'READ {pin}\n' },
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
      mask: 0x01, baud: 9600, board: 'ftdi', driver: 'ftdi-bitbang',
      sendMode: 'hex', sendText: '01', lineEnding: 'none', repeat: false, interval: 1000, repTimer: null, pulseState: 0,
      pinState: 0, txCount: 0, rxCount: 0,
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
    pendingPortName = null;
    if (!ports || !ports.length) { window.api.serial.selectPort(''); alert('No serial ports detected.'); return; }
    if (ports.length === 1) { pendingPortName = ports[0].portName || null; window.api.serial.selectPort(ports[0].portId); return; }
    const ov = overlay(`
      <div class="uart-modal-title">Select a serial port</div>
      <div id="uart-portlist" class="uart-portlist"></div>
      <div class="uart-modal-actions"><button id="uart-port-cancel" class="kicad-btn kicad-btn-outline">Cancel</button></div>`);
    const list = ov.querySelector('#uart-portlist');
    list.innerHTML = ports.map((p, i) => `<button class="uart-port-row" data-id="${esc(p.portId)}" data-name="${esc(p.portName || '')}">
      <b>${esc(p.portName || p.displayName || ('Port ' + i))}</b>
      <span>${p.vendorId ? 'VID ' + p.vendorId + ' PID ' + p.productId : ''}</span></button>`).join('');
    list.querySelectorAll('.uart-port-row').forEach((b) => b.addEventListener('click', () => { pendingPortName = b.dataset.name || null; window.api.serial.selectPort(b.dataset.id); ov.remove(); }));
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
        <div class="uart-mid">
          <div id="uart-canvas" class="uart-canvas">
            <svg id="uart-wires" class="uart-wires"></svg>
            <div id="uart-nodes"></div>
          </div>
          <div id="uart-program" class="uart-program"></div>
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
      const chipOpts = Object.entries(CHIPS).filter(([id, c]) => c.driver !== 'ftdi-bitbang')
        .map(([id, c]) => `<option value="${id}"${dev.board === id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
      cfg = `<div class="uart-cfg">
        <select data-f="baud" class="kicad-input">${opt(BAUDS, dev.baud)}</select>
        <select data-f="dataBits" class="kicad-input">${opt([7, 8], dev.dataBits)}</select>
        <select data-f="parity" class="kicad-input">${['none', 'even', 'odd'].map((p) => `<option${p === dev.parity ? ' selected' : ''}>${p}</option>`).join('')}</select>
        <select data-f="stopBits" class="kicad-input">${opt([1, 2], dev.stopBits)}</select>
      </div>
      <div class="uart-cfg">
        <select data-f="board" class="kicad-input" title="Chip — gives named pins for program steps">${chipOpts}</select>
        <select data-f="driver" class="kicad-input" title="How pin commands are sent">
          <option value="serial-command"${dev.driver === 'serial-command' ? ' selected' : ''}>Cmd</option>
          <option value="firmata"${dev.driver === 'firmata' ? ' selected' : ''}>Firmata</option>
        </select>
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
    renderProgram();
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
        if (f === 'board' || f === 'driver') renderProgram();
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

  // ==========================================================================
  //  CHIPS · DRIVERS · PROGRAM  (sequential visual scripting → Python)
  // ==========================================================================

  // Controllable-pin maps per chip. `n` = numeric pin used in commands/Firmata
  // (or the literal id for chips without a simple number, e.g. MSP430 ports).
  const CHIPS = {
    'generic':       { name: 'Generic (type pin)', pins: [] },
    'ftdi':          { name: 'FTDI (bit-bang)', driver: 'ftdi-bitbang',
                       pins: [0,1,2,3,4,5,6,7].map((b) => ({ id: 'D' + b, n: b })) },
    'arduino-uno':   { name: 'Arduino Uno', pins: [
                       ...[2,3,4,5,6,7,8,9,10,11,12,13].map((d) => ({ id: 'D' + d, n: d })),
                       ...[0,1,2,3,4,5].map((a) => ({ id: 'A' + a, n: 14 + a })) ] },
    'esp32':         { name: 'ESP32', pins: [2,4,5,12,13,14,15,16,17,18,19,21,22,23,25,26,27,32,33].map((g) => ({ id: 'GPIO' + g, n: g })) },
    'esp8266':       { name: 'ESP8266 (NodeMCU)', pins: [
                       ['D0',16],['D1',5],['D2',4],['D3',0],['D4',2],['D5',14],['D6',12],['D7',13],['D8',15]].map(([id,n]) => ({ id, n })) },
    'raspberry-pi':  { name: 'Raspberry Pi (BCM)', pins: [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27].map((g) => ({ id: 'GPIO' + g, n: g })) },
    'msp430':        { name: 'TI MSP430', pins: ['P1.0','P1.1','P1.2','P1.3','P1.4','P1.5','P1.6','P1.7','P2.0','P2.1','P2.2','P2.3','P2.4','P2.5'].map((id) => ({ id, n: id })) },
  };
  const chipPins = (dev) => (CHIPS[dev.board] && CHIPS[dev.board].pins) || [];
  function resolvePin(dev, pinStr) {
    const pp = chipPins(dev).find((x) => x.id === pinStr);
    if (pp) return { label: pinStr, num: pp.n };
    const numeric = pinStr !== '' && !isNaN(parseInt(pinStr, 10)) ? parseInt(pinStr, 10) : pinStr;
    return { label: pinStr, num: numeric };
  }
  const fillTpl = (t, vars) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));

  // ---- drivers: live execution (run) -------------------------------------
  const DRIVERS = {
    'ftdi-bitbang': {
      async pinWrite(dev, pinStr, val) {
        const { num } = resolvePin(dev, pinStr); const bit = (typeof num === 'number') ? num : 0;
        let s = dev.pinState || 0;
        s = (val === 'high') ? (s | (1 << bit)) : (val === 'low') ? (s & ~(1 << bit)) : (s ^ (1 << bit));
        dev.pinState = s & 0xff;
        await writeOut(dev, new Uint8Array([dev.pinState]), false);
      },
      async send(dev, bytes) { await writeOut(dev, bytes, false); },
    },
    'serial-command': {
      async pinWrite(dev, pinStr, val) {
        const { num } = resolvePin(dev, pinStr);
        const s = fillTpl(dev.cmds.set, { pin: num, val: val === 'low' ? 0 : 1 });
        await writeOut(dev, new TextEncoder().encode(s), false);
      },
      async readPin(dev, pinStr) {
        const { num } = resolvePin(dev, pinStr);
        await writeOut(dev, new TextEncoder().encode(fillTpl(dev.cmds.read, { pin: num })), false);
      },
      async send(dev, bytes) { await writeOut(dev, bytes, false); },
    },
    'firmata': {
      async pinWrite(dev, pinStr, val) {
        const { num } = resolvePin(dev, pinStr); const n = (typeof num === 'number') ? num : 0;
        await writeOut(dev, new Uint8Array([0xF4, n, 1]), false);            // pinMode OUTPUT
        await writeOut(dev, new Uint8Array([0xF5, n, val === 'low' ? 0 : 1]), false); // SET_DIGITAL_PIN_VALUE
      },
      async send(dev, bytes) { await writeOut(dev, bytes, false); },
    },
  };

  // ---- program blocks (registry; expand by adding an entry) ----------------
  let stepSeq = 0;
  const newStep = (type) => ({ sid: 's' + (++stepSeq), type, ...(BLOCKS[type].defaults()) });
  const devOpts = (sel) => '<option value="">— device —</option>' + devices.map((d) => `<option value="${d.id}"${sel === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
  function pinField(step) {
    const dev = byId(step.device); const pins = dev ? chipPins(dev) : [];
    if (pins.length) return `<select data-sid="${step.sid}" data-k="pin">${pins.map((p) => `<option${step.pin === p.id ? ' selected' : ''}>${p.id}</option>`).join('')}</select>`;
    return `<input data-sid="${step.sid}" data-k="pin" class="kicad-input" style="width:80px" placeholder="pin" value="${esc(step.pin || '')}">`;
  }
  const valOpts = (step) => { const dev = byId(step.device); const vals = (dev && dev.type === 'ftdi') ? ['high','low','toggle'] : ['high','low'];
    return `<select data-sid="${step.sid}" data-k="value">${vals.map((v) => `<option${step.value === v ? ' selected' : ''}>${v}</option>`).join('')}</select>`; };

  const BLOCKS = {
    pin_write: { label: 'Set pin', defaults: () => ({ device: '', pin: '', value: 'high' }),
      editor: (s) => `<select data-sid="${s.sid}" data-k="device" data-rer="1">${devOpts(s.device)}</select> ${pinField(s)} ${valOpts(s)}`,
      summary: (s) => `set ${devName(s.device)}.${s.pin || '?'} = ${s.value}`,
      async run(s) { const d = byId(s.device); if (!d || !d.connected) return warn(s); await DRIVERS[d.driver].pinWrite(d, s.pin, s.value); },
      py(s, ind) { return pinWritePy(s, ind); } },
    pin_pulse: { label: 'Pulse pin', defaults: () => ({ device: '', pin: '', ms: 200 }),
      editor: (s) => `<select data-sid="${s.sid}" data-k="device" data-rer="1">${devOpts(s.device)}</select> ${pinField(s)} <input data-sid="${s.sid}" data-k="ms" class="kicad-input" style="width:64px" value="${s.ms}"> ms`,
      summary: (s) => `pulse ${devName(s.device)}.${s.pin || '?'} ${s.ms}ms`,
      async run(s) { const d = byId(s.device); if (!d || !d.connected) return warn(s); await DRIVERS[d.driver].pinWrite(d, s.pin, 'high'); await sleep(+s.ms || 0); await DRIVERS[d.driver].pinWrite(d, s.pin, 'low'); },
      py(s, ind) { return [...pinWritePy({ ...s, value: 'high' }, ind), `${ind}time.sleep(${(+s.ms || 0) / 1000})`, ...pinWritePy({ ...s, value: 'low' }, ind)]; } },
    send: { label: 'Send data', defaults: () => ({ device: '', mode: 'hex', data: '' }),
      editor: (s) => `<select data-sid="${s.sid}" data-k="device">${devOpts(s.device)}</select> <select data-sid="${s.sid}" data-k="mode"><option${s.mode === 'hex' ? ' selected' : ''}>hex</option><option${s.mode === 'ascii' ? ' selected' : ''}>ascii</option></select> <input data-sid="${s.sid}" data-k="data" class="kicad-input" style="flex:1;min-width:90px" value="${esc(s.data)}" placeholder="${s.mode === 'ascii' ? 'text' : '01 FF'}">`,
      summary: (s) => `send ${devName(s.device)} ${s.mode}: ${s.data}`,
      async run(s) { const d = byId(s.device); if (!d || !d.connected) return warn(s); await DRIVERS[d.driver].send(d, parseInput(s.mode, s.data)); },
      py(s, ind) { const d = byId(s.device); if (!d) return [`${ind}# send: device missing`]; const lit = s.mode === 'ascii' ? pyBytesStr(s.data) : `bytes.fromhex('${(s.data || '').replace(/[^0-9a-fA-F]/g, '')}')`; return [`${ind}${pyVar(d)}.write(${lit})`]; } },
    read: { label: 'Read pin', defaults: () => ({ device: '', pin: '' }),
      editor: (s) => `<select data-sid="${s.sid}" data-k="device" data-rer="1">${devOpts(s.device)}</select> ${pinField(s)}`,
      summary: (s) => `read ${devName(s.device)}.${s.pin || '?'}`,
      async run(s) { const d = byId(s.device); if (!d || !d.connected) return warn(s); if (DRIVERS[d.driver].readPin) await DRIVERS[d.driver].readPin(d, s.pin); log(d.name, 'sys', null, 'read ' + s.pin + ' (reply shows in monitor)'); },
      py(s, ind) { const d = byId(s.device); if (!d) return [`${ind}# read: device missing`]; if (d.driver === 'serial-command') { const { num } = resolvePin(d, s.pin); return [`${ind}${pyVar(d)}.write(${pyBytesStr(fillTpl(d.cmds.read, { pin: num }))})`, `${ind}print(${pyVar(d)}.readline())`]; } return [`${ind}# read ${s.pin}: depends on firmware`]; } },
    wait: { label: 'Wait', defaults: () => ({ ms: 500 }),
      editor: (s) => `<input data-sid="${s.sid}" data-k="ms" class="kicad-input" style="width:80px" value="${s.ms}"> ms`,
      summary: (s) => `wait ${s.ms}ms`,
      async run(s) { await sleep(+s.ms || 0); },
      py(s, ind) { return [`${ind}time.sleep(${(+s.ms || 0) / 1000})`]; } },
    loop: { label: 'Repeat', defaults: () => ({ count: 5, steps: [] }),
      editor: (s) => `repeat <input data-sid="${s.sid}" data-k="count" class="kicad-input" style="width:56px" value="${s.count}"> times`,
      summary: (s) => `repeat ${s.count}×`,
      async run(s) { for (let i = 0; i < (+s.count || 0); i++) { if (!running) break; await runSteps(s.steps); } },
      py(s, ind) { const out = [`${ind}for _ in range(${+s.count || 0}):`]; const inner = s.steps.length ? s.steps : null; if (!inner) out.push(`${ind}    pass`); else s.steps.forEach((c) => BLOCKS[c.type].py(c, ind + '    ').forEach((l) => out.push(l))); return out; } },
    comment: { label: 'Comment', defaults: () => ({ text: '' }),
      editor: (s) => `<input data-sid="${s.sid}" data-k="text" class="kicad-input" style="flex:1" value="${esc(s.text)}" placeholder="note…">`,
      summary: (s) => `# ${s.text}`,
      async run() {},
      py(s, ind) { return [`${ind}# ${s.text || ''}`]; } },
  };
  const BLOCK_ORDER = ['pin_write', 'pin_pulse', 'send', 'read', 'wait', 'loop', 'comment'];
  const devName = (id) => { const d = byId(id); return d ? d.name : '?'; };
  function warn(s) { log('program', 'sys', null, 'step skipped — device not connected'); }

  // ---- run engine ----------------------------------------------------------
  async function runProgram() {
    if (running) return;
    running = true; renderProgram();
    log('program', 'sys', null, '▶ running "' + program.name + '"');
    try { await runSteps(program.steps); } catch (e) { log('program', 'sys', null, 'error: ' + e.message); }
    running = false; renderProgram();
    log('program', 'sys', null, '■ finished');
  }
  async function runSteps(steps) { for (const s of steps) { if (!running) break; await BLOCKS[s.type].run(s); } }
  function stopProgram() { running = false; }

  // ---- find/move/delete steps ---------------------------------------------
  function findStep(sid, list = program.steps) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].sid === sid) return { step: list[i], list, idx: i };
      if (list[i].type === 'loop') { const r = findStep(sid, list[i].steps); if (r) return r; }
    }
    return null;
  }

  // ---- program panel render ------------------------------------------------
  function stepHTML(s) {
    let inner = `
      <div class="uart-step" data-sid="${s.sid}">
        <div class="uart-step-head">
          <span class="uart-step-type">${BLOCKS[s.type].label}</span>
          <span class="uart-step-ctl">
            <button data-act="up" data-sid="${s.sid}" title="Up">▲</button>
            <button data-act="down" data-sid="${s.sid}" title="Down">▼</button>
            <button data-act="del" data-sid="${s.sid}" title="Delete">✕</button>
          </span>
        </div>
        <div class="uart-step-body">${BLOCKS[s.type].editor(s)}</div>`;
    if (s.type === 'loop') {
      inner += `<div class="uart-loop-body">${s.steps.map(stepHTML).join('') || '<div class="uart-loop-empty">empty</div>'}
        <div class="uart-loop-add"><select data-loopsel="${s.sid}">${BLOCK_ORDER.map((t) => `<option value="${t}">${BLOCKS[t].label}</option>`).join('')}</select>
        <button data-act="addin" data-sid="${s.sid}" class="kicad-btn kicad-btn-outline">+ in loop</button></div></div>`;
    }
    inner += `</div>`;
    return inner;
  }

  function renderProgram() {
    const el = document.getElementById('uart-program');
    if (!el) return;
    el.innerHTML = `
      <div class="uart-prog-head">
        <input id="prog-name" class="kicad-input" value="${esc(program.name)}" title="Program name">
        <div class="uart-prog-btns">
          <button id="prog-new" class="kicad-btn kicad-btn-outline">New</button>
          <button id="prog-save" class="kicad-btn kicad-btn-outline">Save</button>
          <button id="prog-open" class="kicad-btn kicad-btn-outline">Open</button>
          <button id="prog-exp" class="kicad-btn kicad-btn-outline">Export .py</button>
          <button id="prog-imp" class="kicad-btn kicad-btn-outline">Import .py</button>
        </div>
      </div>
      <div class="uart-prog-add">
        <select id="prog-addtype" class="kicad-input">${BLOCK_ORDER.map((t) => `<option value="${t}">${BLOCKS[t].label}</option>`).join('')}</select>
        <button id="prog-addbtn" class="kicad-btn kicad-btn-start">+ Step</button>
      </div>
      <div id="prog-steps" class="uart-prog-steps">${program.steps.map(stepHTML).join('') || '<div class="uart-loop-empty">No steps yet — add one above.</div>'}</div>
      <div class="uart-prog-run"><button id="prog-run" class="kicad-btn ${running ? 'kicad-btn-outline' : 'kicad-btn-start'}">${running ? '■ Stop' : '▶ Run program'}</button></div>`;

    const g = (id) => document.getElementById(id);
    g('prog-name').addEventListener('input', (e) => { program.name = e.target.value; });
    g('prog-new').addEventListener('click', () => { if (program.steps.length && !confirm('Clear current program?')) return; program = { name: 'untitled', steps: [] }; renderProgram(); });
    g('prog-save').addEventListener('click', saveProgram);
    g('prog-open').addEventListener('click', openProgram);
    g('prog-exp').addEventListener('click', exportPy);
    g('prog-imp').addEventListener('click', importPy);
    g('prog-addbtn').addEventListener('click', () => { program.steps.push(newStep(g('prog-addtype').value)); renderProgram(); });
    g('prog-run').addEventListener('click', () => running ? stopProgram() : runProgram());

    const steps = g('prog-steps');
    steps.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act, f = findStep(b.dataset.sid); if (!f) return;
      if (act === 'up' && f.idx > 0) { f.list.splice(f.idx - 1, 0, f.list.splice(f.idx, 1)[0]); }
      else if (act === 'down' && f.idx < f.list.length - 1) { f.list.splice(f.idx + 1, 0, f.list.splice(f.idx, 1)[0]); }
      else if (act === 'del') { f.list.splice(f.idx, 1); }
      else if (act === 'addin') { const sel = steps.querySelector(`[data-loopsel="${b.dataset.sid}"]`); f.step.steps.push(newStep(sel.value)); }
      renderProgram();
    });
    const onField = (e) => {
      const el2 = e.target; if (!el2.dataset || !el2.dataset.sid || !el2.dataset.k) return;
      const f = findStep(el2.dataset.sid); if (!f) return;
      f.step[el2.dataset.k] = el2.value;
      if (el2.dataset.rer) renderProgram();
    };
    steps.addEventListener('change', onField);
    steps.addEventListener('input', onField);
  }

  // ---- serialization / save / load ----------------------------------------
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const unb64 = (s) => decodeURIComponent(escape(atob(s)));
  function serializeState() {
    return { v: 1,
      devices: devices.map((d) => ({ id: d.id, type: d.type, name: d.name, board: d.board, driver: d.driver,
        baud: d.baud, dataBits: d.dataBits, parity: d.parity, stopBits: d.stopBits, portName: d.portName,
        ftdiIndex: d.ftdiIndex, serial: d.serial, mask: d.mask, cmds: d.cmds, x: d.x, y: d.y })),
      wires: wires.map((w) => ({ id: w.id, from: w.from, to: w.to })),
      program };
  }
  function loadState(model) {
    devices.forEach((d) => { if (d.connected) disconnect(d); });
    devices = (model.devices || []).map((d) => ({
      ...d, port: null, info: null, connected: false, reader: null, writer: null,
      sendMode: d.type === 'ftdi' ? 'hex' : 'hex', sendText: d.type === 'ftdi' ? '01' : '', lineEnding: 'none',
      repeat: false, interval: 1000, repTimer: null, dtr: false, rts: false, pulseState: 0, pinState: 0,
      txCount: 0, rxCount: 0, cmds: d.cmds || { set: 'GPIO {pin} {val}\n', read: 'READ {pin}\n' },
    }));
    wires = model.wires || [];
    program = model.program || { name: 'untitled', steps: [] };
    // re-seed counters so new ids don't collide
    devices.forEach((d) => { const m = /^d(\d+)$/.exec(d.id); if (m) counter = Math.max(counter, +m[1]); });
    const reseq = (list) => list.forEach((s) => { s.sid = 's' + (++stepSeq); if (s.type === 'loop') reseq(s.steps); });
    reseq(program.steps);
    renderNodes();
  }

  async function saveProgram() {
    if (!program.name || program.name === 'untitled') { const n = prompt('Save program as:', program.name); if (!n) return; program.name = n; }
    const r = await window.api.uartProg.save(program.name, JSON.stringify(serializeState()));
    if (r.error) alert('Save failed: ' + r.error); else log('program', 'sys', null, 'saved "' + r.name + '"');
    renderProgram();
  }
  async function openProgram() {
    const r = await window.api.uartProg.list();
    const names = (r && r.names) || [];
    if (!names.length) { alert('No saved programs yet.'); return; }
    const ov = overlay(`<div class="uart-modal-title">Open program</div><div id="uart-portlist" class="uart-portlist"></div>
      <div class="uart-modal-actions"><button id="op-cancel" class="kicad-btn kicad-btn-outline">Cancel</button></div>`);
    ov.querySelector('#uart-portlist').innerHTML = names.map((n) => `<button class="uart-port-row" data-n="${esc(n)}"><b>${esc(n)}</b><span></span></button>`).join('');
    ov.querySelectorAll('.uart-port-row').forEach((b) => b.addEventListener('click', async () => {
      ov.remove(); const res = await window.api.uartProg.load(b.dataset.n);
      if (res.error) { alert('Load failed: ' + res.error); return; }
      try { loadState(JSON.parse(res.data)); log('program', 'sys', null, 'opened "' + b.dataset.n + '"'); }
      catch (e) { alert('Bad program file: ' + e.message); }
    }));
    ov.querySelector('#op-cancel').addEventListener('click', () => ov.remove());
  }

  // ---- Python codegen ------------------------------------------------------
  const pyVar = (d) => 'd_' + d.id;
  function pyBytesStr(s) {
    let o = '';
    for (const ch of String(s)) { const c = ch.charCodeAt(0);
      if (ch === '\n') o += '\\n'; else if (ch === '\r') o += '\\r'; else if (ch === '\\') o += '\\\\';
      else if (ch === "'") o += "\\'"; else if (c >= 32 && c < 127) o += ch; else o += '\\x' + c.toString(16).padStart(2, '0'); }
    return "b'" + o + "'";
  }
  function pinWritePy(s, ind) {
    const d = byId(s.device); if (!d) return [`${ind}# set pin: device missing`];
    const { num } = resolvePin(d, s.pin);
    if (d.driver === 'ftdi-bitbang') { const op = s.value === 'high' ? '|=' : s.value === 'low' ? '&= ~' : '^='; const bit = (typeof num === 'number') ? num : 0;
      return [`${ind}st_${d.id} ${op} (1 << ${bit})`, `${ind}${pyVar(d)}.write(bytes([st_${d.id} & 0xFF]))`]; }
    if (d.driver === 'firmata') { const n = (typeof num === 'number') ? num : 0; return [`${ind}${pyVar(d)}.write(bytes([0xF4, ${n}, 1]))`, `${ind}${pyVar(d)}.write(bytes([0xF5, ${n}, ${s.value === 'low' ? 0 : 1}]))`]; }
    return [`${ind}${pyVar(d)}.write(${pyBytesStr(fillTpl(d.cmds.set, { pin: num, val: s.value === 'low' ? 0 : 1 }))})`];
  }
  function deviceSetupPy(d) {
    if (d.type === 'ftdi') return [`${pyVar(d)} = ftd2xx.open(${d.ftdiIndex})`, `${pyVar(d)}.setBitMode(0x${(d.mask || 0).toString(16)}, 0x01)`, `st_${d.id} = 0`];
    const par = { none: 'serial.PARITY_NONE', even: 'serial.PARITY_EVEN', odd: 'serial.PARITY_ODD' }[d.parity] || 'serial.PARITY_NONE';
    const port = d.portName ? `'${d.portName}'` : `'COM_X'  # TODO set port`;
    return [`${pyVar(d)} = serial.Serial(${port}, ${d.baud}, bytesize=${d.dataBits}, parity=${par}, stopbits=${d.stopBits}, timeout=1)`];
  }
  function generatePython() {
    const L = ['#!/usr/bin/env python3',
      `# EngOrg UART Bridge — generated program: ${program.name}`,
      '# Re-import this file in UART Bridge (Import .py) to restore the visual program.',
      '# @ENGORG-UART-PROGRAM v1',
      '# @MODEL ' + b64(JSON.stringify(serializeState())),
      'import time'];
    if (devices.some((d) => d.type === 'uart')) L.push('import serial  # pip install pyserial');
    if (devices.some((d) => d.type === 'ftdi')) L.push('import ftd2xx  # pip install ftd2xx');
    L.push('');
    devices.forEach((d) => deviceSetupPy(d).forEach((l) => L.push(l)));
    L.push('', 'try:');
    const body = [];
    program.steps.forEach((s) => BLOCKS[s.type].py(s, '    ').forEach((l) => body.push(l)));
    if (!body.length) body.push('    pass');
    body.forEach((l) => L.push(l));
    L.push('finally:');
    const fin = [];
    devices.forEach((d) => { if (d.type === 'ftdi') { fin.push(`    try:\n        ${pyVar(d)}.setBitMode(0, 0); ${pyVar(d)}.close()\n    except Exception: pass`); } else { fin.push(`    try: ${pyVar(d)}.close()\n    except Exception: pass`); } });
    if (!fin.length) fin.push('    pass');
    fin.forEach((l) => L.push(l));
    return L.join('\n') + '\n';
  }
  async function exportPy() {
    const r = await window.api.uartProg.exportPython({ suggestedName: program.name, code: generatePython() });
    if (r && r.error) alert('Export failed: ' + r.error);
    else if (r && r.path) log('program', 'sys', null, 'exported → ' + r.path);
  }
  async function importPy() {
    const r = await window.api.uartProg.importPython();
    if (!r || r.canceled) return;
    if (r.error) { alert('Import failed: ' + r.error); return; }
    const m = /^#\s*@MODEL\s+(\S+)/m.exec(r.content || '');
    if (!m) { alert('Not an EngOrg UART Bridge script (no @MODEL header).'); return; }
    try { loadState(JSON.parse(unb64(m[1]))); log('program', 'sys', null, 'imported program from .py'); }
    catch (e) { alert('Could not parse the embedded program: ' + e.message); }
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
