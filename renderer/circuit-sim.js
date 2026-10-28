// Circuit Lab utility — draw a schematic, simulate it, and analyze the result.
//
// The editor is an SVG on a 1-unit grid (all coordinates are integer grid points):
// parts carry pins at fixed offsets, wires are straight 2-point segments, and
// connectivity is computed from coincident points (a pin or wire end lying on another
// wire's interior also connects — a T junction). Net labels with the same name are one
// net; ground symbols are node 0. buildNetlist() turns that into the netlist shape the
// solver in circuit-engine.js (global CircuitEngine) takes.
//
// Analyses: DC operating point (live while editing: net voltages tag the schematic,
// hovering a part shows V/I/P), transient (scope plot of the probed nets/currents) and
// AC sweep (Bode magnitude + phase). The Analysis tab adds the OP table with a power
// balance, a Thevenin/Norton equivalent between any two nets, waveform measurements and
// Bode figures (−3 dB, peak, unity-gain/phase margin). "Send to Trace Designer" hands the
// netlist to traceDesigner so the board can be routed from it.
//
// The working circuit autosaves to localStorage; Save/Open use .circuit.json files via
// window.api.circuitLab (ipc/circuit-lab.js). Desktop-only utility.

const circuitLab = (() => {
  const E = CircuitEngine;
  const LS_KEY = 'engorg_circuitlab_doc';
  const PROBE_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

  const DIODE_MODELS = {
    '1N4148': { is: '2.52n', n: '1.752', rs: '0.568' },
    '1N4007': { is: '14.11n', n: '1.984', rs: '33.89m' },
    '1N5819': { is: '31.7u', n: '1.373', rs: '51m' },
    Generic: { is: '10f', n: '1', rs: '10m' },
  };
  const SRC_DEF = { wave: 'dc', dc: '5', ac: '0', amp: '1', freq: '1k', phase: '0', v1: '0', v2: '5', period: '1m', duty: '50', delay: '0', rise: '0' };

  // Part library. Pins are local offsets at rot 0; box is the local hit/selection box.
  const TYPES = {
    R: { name: 'Resistor', key: 'r', prefix: 'R', unit: 'Ω', pins: [[-2, 0], [2, 0]], box: [-2, -0.7, 2, 0.7], def: { value: '1k' },
      path: 'M-2 0H-1.2L-1-.45L-.6.45L-.2-.45L.2.45L.6-.45L1 .45L1.2 0H2' },
    C: { name: 'Capacitor', key: 'c', prefix: 'C', unit: 'F', pins: [[-2, 0], [2, 0]], box: [-2, -0.9, 2, 0.9], def: { value: '1u' },
      path: 'M-2 0H-.25M-.25-.8V.8M.25-.8V.8M.25 0H2' },
    L: { name: 'Inductor', key: 'l', prefix: 'L', unit: 'H', pins: [[-2, 0], [2, 0]], box: [-2, -0.7, 2, 0.5], def: { value: '1m' },
      path: 'M-2 0H-1.2a.3.3 0 0 1 .6 0a.3.3 0 0 1 .6 0a.3.3 0 0 1 .6 0a.3.3 0 0 1 .6 0H2' },
    D: { name: 'Diode', key: 'd', prefix: 'D', pins: [[-2, 0], [2, 0]], box: [-2, -0.8, 2, 0.8], def: { model: '1N4148', ...DIODE_MODELS['1N4148'] },
      path: 'M-2 0H-.5M.5-.6V.6M.5 0H2', fill: 'M-.5-.6V.6L.5 0Z' },
    LED: { name: 'LED', key: 'e', prefix: 'LED', pins: [[-2, 0], [2, 0]], box: [-2, -1.4, 2, 0.8], def: { color: 'red' },
      path: 'M-2 0H-.5M.5-.6V.6M.5 0H2M-.1-.8L.5-1.4M.3-1.4H.5V-1.2M.4-.7L1-1.3M.8-1.3H1V-1.1', fill: 'M-.5-.6V.6L.5 0Z' },
    V: { name: 'Voltage source', key: 'v', prefix: 'V', unit: 'V', pins: [[0, -2], [0, 2]], box: [-1.1, -2, 1.1, 2], def: { ...SRC_DEF } },
    I: { name: 'Current source', key: 'i', prefix: 'I', unit: 'A', pins: [[0, 2], [0, -2]], box: [-1.1, -2, 1.1, 2], def: { ...SRC_DEF, dc: '1m', v2: '1m' } },
    OA: { name: 'Op-amp', key: 'o', prefix: 'U', pins: [[-3, -1], [-3, 1], [3, 0]], box: [-3, -1.8, 3, 1.8], def: { gain: '100k', gbw: '1meg', vsat: '15' },
      path: 'M-2-1.7L-2 1.7L2 0ZM-3-1H-2M-3 1H-2M2 0H3M-1.75-1H-1.25M-1.75 1H-1.25M-1.5.75V1.25' },
    GND: { name: 'Ground', key: 'g', prefix: '', pins: [[0, 0]], box: [-0.9, -0.2, 0.9, 1.3],
      path: 'M0 0V.6M-.8.6H.8M-.5.9H.5M-.2 1.2H.2' },
    LABEL: { name: 'Net label', key: 'n', prefix: '', pins: [[0, 0]], box: [-0.3, -0.5, 3, 0.5], def: { name: 'out' } },
  };
  const PALETTE = ['R', 'C', 'L', 'D', 'LED', 'V', 'I', 'OA', 'GND', 'LABEL'];
  const ELECTRICAL = new Set(['R', 'C', 'L', 'D', 'LED', 'V', 'I', 'OA']);

  // ---- document state ---------------------------------------------------------------
  let doc = emptyDoc();
  let undoStack = [], redoStack = [];
  let tool = 'select';          // 'select' | 'wire' | 'probe' | a TYPES key
  let placeRot = 0;
  let sel = null;               // { kind: 'comp'|'wire', id }
  let hover = null;             // { kind, id } under the cursor
  let cursor = [0, 0];          // snapped world point under the pointer
  let wireStart = null;         // wire tool: current start point
  let drag = null;              // { kind, id, start, orig, attached, moved }
  let pan = null;
  let view = { x: -12, y: -10, scale: 28 };
  let net = null;               // last buildNetlist()
  let opRes = null;             // last operating point (live)
  let runRes = null;            // last transient / AC result { kind, ... }
  let showValues = true;
  let liveTimer = null;
  let lastRunMs = 0;
  let rightTab = 'props';
  let plotHoverX = null;
  let mounted = false, root = null, svg = null;

  function emptyDoc() {
    return {
      comps: [], wires: [], probes: [],
      mode: 'op',
      tran: { tStop: '10m', points: 1000, uic: false },
      ac: { fStart: '1', fStop: '1meg', ppd: 40 },
    };
  }
  let idSeq = 1;
  const newId = (p) => p + Date.now().toString(36) + (idSeq++).toString(36);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const key = (x, y) => x + ',' + y;
  const fmt = (v, u, d) => E.fmtSI(v, u, d);

  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(doc)); } catch (_) { /* storage blocked */ } }
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.comps)) return { ...emptyDoc(), ...d }; }
    } catch (_) { /* fall through to the example */ }
    return null;
  }
  function pushUndo() {
    undoStack.push(JSON.stringify(doc));
    if (undoStack.length > 150) undoStack.shift();
    redoStack = [];
  }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(doc)); doc = JSON.parse(undoStack.pop()); sel = null; changed(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(doc)); doc = JSON.parse(redoStack.pop()); sel = null; changed(); }

  // Every edit funnels here: rebuild connectivity, re-run the live OP, redraw.
  function changed() {
    save();
    net = buildNetlist();
    if (runRes) runRes.stale = true;
    scheduleLive();
    renderSchematic();
    renderSide();
  }

  // ---- geometry -----------------------------------------------------------------------
  function rotPt([x, y], r) {
    for (let i = 0; i < ((r % 4) + 4) % 4; i++) [x, y] = [-y, x];
    return [x, y];
  }
  function pinsOf(c) { return TYPES[c.type].pins.map(p => { const [x, y] = rotPt(p, c.rot); return [c.x + x, c.y + y]; }); }
  function labelBox(c) { return [-0.3, -0.55, 0.9 + 0.62 * String(c.p.name || '').length, 0.55]; }
  function boxOf(c) {
    const b = c.type === 'LABEL' ? labelBox(c) : TYPES[c.type].box;
    const pts = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(p => rotPt(p, c.rot));
    const xs = pts.map(p => p[0] + c.x), ys = pts.map(p => p[1] + c.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function onSegInterior(p, a, b) {
    if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1])) return false;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) > 1e-9) return false;
    return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  }

  // ---- connectivity → netlist -------------------------------------------------------
  function buildNetlist() {
    const parent = new Map();
    const find = (k) => { if (!parent.has(k)) parent.set(k, k); let r = k; while (parent.get(r) !== r) r = parent.get(r); let c = k; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

    const points = [];
    for (const c of doc.comps) for (const p of pinsOf(c)) points.push(p);
    for (const w of doc.wires) { points.push(w.pts[0], w.pts[1]); union(key(...w.pts[0]), key(...w.pts[1])); }
    for (const pr of doc.probes) if (pr.x != null) points.push([pr.x, pr.y]);
    for (const p of points) {
      find(key(...p));
      for (const w of doc.wires) if (onSegInterior(p, w.pts[0], w.pts[1])) union(key(...p), key(...w.pts[0]));
    }
    const labels = {};
    let hasGnd = false;
    for (const c of doc.comps) {
      const k = key(...pinsOf(c)[0]);
      if (c.type === 'GND') { union(k, '#gnd'); hasGnd = true; }
      if (c.type === 'LABEL' && c.p.name) {
        const nm = String(c.p.name).trim();
        if (/^(0|gnd)$/i.test(nm)) { union(k, '#gnd'); hasGnd = true; continue; }
        if (labels[nm]) union(k, labels[nm]); else labels[nm] = k;
      }
    }
    // Names: ground → '0'; a labelled net takes its label; others N1, N2… in pin order.
    const nameOfRoot = {};
    if (hasGnd) nameOfRoot[find('#gnd')] = '0';
    for (const c of doc.comps) if (c.type === 'LABEL' && c.p.name) {
      const r = find(key(...pinsOf(c)[0]));
      if (!nameOfRoot[r]) nameOfRoot[r] = String(c.p.name).trim();
    }
    const nodes = ['0'], idxOfRoot = {}, pinCount = {};
    if (hasGnd) idxOfRoot[find('#gnd')] = 0;
    let auto = 1;
    const parts = [], warnings = [], pinNodes = {};
    for (const c of doc.comps) {
      if (!ELECTRICAL.has(c.type)) continue;
      const n = pinsOf(c).map(p => {
        const r = find(key(...p));
        pinCount[r] = (pinCount[r] || 0) + 1;
        if (idxOfRoot[r] == null) {
          let nm = nameOfRoot[r];
          if (!nm || nodes.includes(nm)) { while (nodes.includes('N' + auto)) auto++; nm = 'N' + auto++; }
          idxOfRoot[r] = nodes.length; nodes.push(nm);
        }
        return idxOfRoot[r];
      });
      pinNodes[c.id] = n;
      parts.push({ id: c.id, ref: c.ref, type: c.type, n, p: c.p });
    }
    for (const c of doc.comps) {
      if (!ELECTRICAL.has(c.type)) continue;
      pinsOf(c).forEach((p, i) => {
        const r = find(key(...p));
        if (pinCount[r] === 1 && idxOfRoot[r] !== 0 && !nameOfRoot[r]) warnings.push(`${c.ref} pin ${i + 1} is not connected`);
      });
    }
    const nodeAt = (x, y) => { const r = find(key(x, y)); return idxOfRoot[r] != null ? idxOfRoot[r] : -1; };
    // A representative point per node, for drawing the voltage tag.
    const tagPts = {};
    for (const c of doc.comps) if (c.type === 'LABEL') { const i = nodeAt(...pinsOf(c)[0]); if (i > 0 && !tagPts[i]) tagPts[i] = { p: pinsOf(c)[0], label: c }; }
    for (const w of doc.wires) {
      const i = nodeAt(...w.pts[0]);
      if (i > 0 && !tagPts[i]) tagPts[i] = { p: [(w.pts[0][0] + w.pts[1][0]) / 2, (w.pts[0][1] + w.pts[1][1]) / 2] };
    }
    for (const c of doc.comps) if (ELECTRICAL.has(c.type)) pinsOf(c).forEach(p => { const i = nodeAt(...p); if (i > 0 && !tagPts[i]) tagPts[i] = { p }; });
    const error = !doc.comps.some(c => ELECTRICAL.has(c.type)) ? 'Place some parts to simulate.'
      : !hasGnd ? 'Add a ground (G) so voltages have a reference.' : null;
    return { nodes, parts, warnings, error, nodeAt, pinNodes, tagPts, find };
  }

  // ---- simulation runners ---------------------------------------------------------------
  function scheduleLive() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      // Transient/AC re-run on their own after an edit while they're quick; slower runs
      // wait for ▶ Run and the plot is marked stale meanwhile.
      if (doc.mode !== 'op' && runRes && runRes.kind !== 'error' && lastRunMs < 400) { run({ auto: true }); return; }
      if (doc.mode !== 'op' && runRes && runRes.kind === 'error') { run({ auto: true }); return; }
      runOp(); renderSchematic(); renderSide(); renderPlot();
    }, 150);
  }
  function runOp() {
    opRes = null;
    if (!net || net.error) return;
    opRes = E.operatingPoint({ nodes: net.nodes, parts: net.parts });
  }
  // Resolved probe list → [{ label, color, node | partId }]
  function probeSeries() {
    if (!net || net.error) return [];
    let list = doc.probes.map(pr => {
      if (pr.part) {
        const c = doc.comps.find(x => x.id === pr.part);
        return c ? { id: pr.id, label: 'I(' + c.ref + ')', partId: c.id, unit: 'A' } : null;
      }
      const i = net.nodeAt(pr.x, pr.y);
      return i > 0 ? { id: pr.id, label: 'V(' + net.nodes[i] + ')', node: net.nodes[i], unit: 'V' } : null;
    }).filter(Boolean);
    const seen = new Set();
    list = list.filter(s => { const k = s.label; if (seen.has(k)) return false; seen.add(k); return true; });
    if (!list.length) {
      // No probes yet: plot the labelled nets, else the first few nets.
      const labelled = net.nodes.filter((n, i) => i > 0 && !/^N\d+$/.test(n));
      const pick = labelled.length ? labelled : net.nodes.slice(1, 4);
      list = pick.map(n => ({ id: 'auto-' + n, label: 'V(' + n + ')', node: n, unit: 'V', auto: true }));
    }
    return list.map((s, i) => ({ ...s, color: PROBE_COLORS[i % PROBE_COLORS.length] }));
  }
  // Probe series the current run has data for (a run made before an edit can lack a new net).
  function runSeries() {
    if (!runRes) return [];
    return probeSeries().filter(s => (runRes.kind === 'tran'
      ? (s.node ? runRes.nodes[s.node] : runRes.currents[s.partId])
      : (s.node && runRes.mag[s.node])));
  }
  function run(opts = {}) {
    net = buildNetlist();
    if (net.error) { runRes = { kind: 'error', error: net.error }; renderSide(); renderPlot(); return; }
    const nl = { nodes: net.nodes, parts: net.parts };
    runOp();
    const t0 = performance.now();
    if (doc.mode === 'tran') {
      const r = E.transient(nl, doc.tran);
      runRes = r.error ? { kind: 'error', error: r.error } : { kind: 'tran', ...r };
    } else if (doc.mode === 'ac') {
      const r = E.acSweep(nl, doc.ac);
      runRes = r.error ? { kind: 'error', error: r.error } : { kind: 'ac', ...r };
    } else {
      runRes = null;
    }
    lastRunMs = performance.now() - t0;
    if (runRes) runRes.ms = lastRunMs;
    if (!opts.auto && (runRes || doc.mode === 'op')) rightTab = 'analysis';
    renderSchematic(); renderSide(); renderPlot();
  }

  // ---- SVG rendering ----------------------------------------------------------------------
  function valueText(c) {
    const p = c.p || {};
    const T = TYPES[c.type];
    switch (c.type) {
      case 'R': case 'C': case 'L': { const v = E.parseSI(p.value); return isFinite(v) ? fmt(v, T.unit) : String(p.value); }
      case 'D': return p.model || 'D';
      case 'LED': return (p.color || 'red') + ' LED';
      case 'V': case 'I': {
        const u = T.unit;
        if (p.wave === 'sine') return `${fmt(E.parseSI(p.amp), u)} ${fmt(E.parseSI(p.freq), 'Hz')} ∿` + (E.parseSI(p.dc) ? ` +${fmt(E.parseSI(p.dc), u)}` : '');
        if (p.wave === 'square') return `±${fmt(E.parseSI(p.amp), u)} ${fmt(E.parseSI(p.freq), 'Hz')} ⊓`;
        if (p.wave === 'tri') return `${fmt(E.parseSI(p.amp), u)} ${fmt(E.parseSI(p.freq), 'Hz')} △`;
        if (p.wave === 'pulse') return `${fmt(E.parseSI(p.v1), u)}→${fmt(E.parseSI(p.v2), u)} ⊓`;
        return fmt(E.parseSI(p.dc), u) + (E.parseSI(p.ac) > 0 ? ' · AC' : '');
      }
      case 'OA': return '';
      default: return '';
    }
  }
  function symbolSvg(c, cls) {
    const T = TYPES[c.type];
    const tf = `translate(${c.x} ${c.y}) rotate(${(c.rot % 4) * 90})`;
    let body = '';
    if (T.path) body += `<path d="${T.path}"/>`;
    if (T.fill) body += `<path class="clab-fill${c.type === 'LED' ? ' clab-led-' + esc(c.p.color || 'red') : ''}" d="${T.fill}"/>`;
    if (c.type === 'V' || c.type === 'I') {
      body += '<path d="M0-2V-1M0 1V2"/><circle cx="0" cy="0" r="1"/>';
      if (c.type === 'I') body += '<path d="M0 .6V-.6M-.3-.25L0-.6L.3-.25"/>';
      else if (c.p.wave === 'sine') body += '<path d="M-.55 0q.275-.6.55 0t.55 0"/>';
      else if (c.p.wave === 'square' || c.p.wave === 'pulse') body += '<path d="M-.55.3H-.2V-.3H.2V.3H.55"/>';
      else if (c.p.wave === 'tri') body += '<path d="M-.55.3L-.27-.3L0 .3L.27-.3L.55.3"/>';
      else body += '<path d="M-.25-.5H.25M0-.75V-.25M-.25.5H.25"/>';
    }
    if (c.type === 'LABEL') {
      const w = 0.9 + 0.62 * String(c.p.name || '').length;
      body += `<path d="M0 0L.35-.45H${w}V.45H.35Z"/>`;
    }
    return `<g class="clab-part ${cls}" data-id="${c.id}" transform="${tf}">${body}</g>`;
  }
  function textSvg(c) {
    if (c.type === 'GND') return '';
    if (c.type === 'LABEL') {
      // Upright text inside the flag for horizontal labels; beside it otherwise.
      const r = c.rot % 4, w = 0.9 + 0.62 * String(c.p.name || '').length;
      const [x, y, anchor] = r === 0 ? [c.x + 0.6, c.y + 0.22, 'start'] : r === 2 ? [c.x - 0.6, c.y + 0.22, 'end']
        : r === 1 ? [c.x + 0.7, c.y + w / 2 + 0.2, 'start'] : [c.x + 0.7, c.y - w / 2 + 0.2, 'start'];
      return `<text class="clab-label-txt" x="${x}" y="${y}" text-anchor="${anchor}">${esc(c.p.name)}</text>`;
    }
    const pins = pinsOf(c);
    const horiz = c.type === 'OA' ? (c.rot % 2 === 0) : Math.abs(pins[0][0] - pins[1][0]) > Math.abs(pins[0][1] - pins[1][1]);
    const val = valueText(c);
    if (horiz) {
      const top = c.type === 'OA' ? 2.4 : 1.1;
      return `<text class="clab-ref" x="${c.x}" y="${c.y - top}" text-anchor="middle">${esc(c.ref)}</text>`
        + (val ? `<text class="clab-val" x="${c.x}" y="${c.y + top + 0.55}" text-anchor="middle">${esc(val)}</text>` : '');
    }
    const dx = c.type === 'OA' ? 2.4 : 1.4;
    return `<text class="clab-ref" x="${c.x + dx}" y="${c.y - 0.15}">${esc(c.ref)}</text>`
      + (val ? `<text class="clab-val" x="${c.x + dx}" y="${c.y + 0.75}">${esc(val)}</text>` : '');
  }

  function junctions() {
    const count = {};
    const bump = (p) => { const k = key(...p); count[k] = (count[k] || 0) + 1; };
    for (const w of doc.wires) { bump(w.pts[0]); bump(w.pts[1]); }
    for (const c of doc.comps) for (const p of pinsOf(c)) bump(p);
    const out = [];
    for (const k in count) {
      const p = k.split(',').map(Number);
      let n = count[k];
      for (const w of doc.wires) if (onSegInterior(p, w.pts[0], w.pts[1])) n += 2;
      if (n >= 3) out.push(p);
    }
    return out;
  }
  // Open pin ends drawn as small hollow squares, so it's obvious where to wire.
  function openPins() {
    if (!net) return [];
    const out = [];
    for (const c of doc.comps) {
      if (!ELECTRICAL.has(c.type)) continue;
      for (const p of pinsOf(c)) {
        const touching = doc.wires.some(w => (w.pts.some(q => q[0] === p[0] && q[1] === p[1])) || onSegInterior(p, w.pts[0], w.pts[1]))
          || doc.comps.some(o => o !== c && pinsOf(o).some(q => q[0] === p[0] && q[1] === p[1]));
        if (!touching) out.push(p);
      }
    }
    return out;
  }
  function lRoute(a, b) {
    if (a[0] === b[0] || a[1] === b[1]) return [[a, b]];
    const horizFirst = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const mid = horizFirst ? [b[0], a[1]] : [a[0], b[1]];
    return [[a, mid], [mid, b]];
  }

  function renderSchematic() {
    if (!svg) return;
    const W = svg.clientWidth || 800, H = svg.clientHeight || 500;
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${W / view.scale} ${H / view.scale}`);
    const isSel = (k, id) => sel && sel.kind === k && sel.id === id;
    const isHov = (k, id) => hover && hover.kind === k && hover.id === id;
    let out = `<rect class="clab-bg" x="${view.x}" y="${view.y}" width="${W / view.scale}" height="${H / view.scale}" fill="url(#clab-grid)"/>`;
    // Wires
    for (const w of doc.wires) {
      const cls = isSel('wire', w.id) ? ' sel' : isHov('wire', w.id) ? ' hov' : '';
      out += `<line class="clab-wire${cls}" data-wire="${w.id}" x1="${w.pts[0][0]}" y1="${w.pts[0][1]}" x2="${w.pts[1][0]}" y2="${w.pts[1][1]}"/>`;
    }
    for (const p of junctions()) out += `<circle class="clab-junction" cx="${p[0]}" cy="${p[1]}" r=".2"/>`;
    // Parts
    for (const c of doc.comps) {
      const cls = isSel('comp', c.id) ? 'sel' : isHov('comp', c.id) ? 'hov' : '';
      out += symbolSvg(c, cls) + textSvg(c);
    }
    for (const p of openPins()) out += `<rect class="clab-openpin" x="${p[0] - 0.18}" y="${p[1] - 0.18}" width=".36" height=".36"/>`;
    // Probes
    const series = probeSeries();
    for (const pr of doc.probes) {
      const s = series.find(x => x.id === pr.id);
      const col = s ? s.color : '#888';
      if (pr.part) {
        const c = doc.comps.find(x => x.id === pr.part);
        if (!c) continue;
        const b = boxOf(c);
        out += `<rect class="clab-probe-ring" x="${b[0] - 0.25}" y="${b[1] - 0.25}" width="${b[2] - b[0] + 0.5}" height="${b[3] - b[1] + 0.5}" rx=".3" style="stroke:${col}"/>`;
      } else {
        out += `<g class="clab-probe" transform="translate(${pr.x} ${pr.y})" style="--pc:${col}"><path d="M0 0L.9-1.3L1.4-.9Z"/><circle cx="1.4" cy="-1.4" r=".35"/></g>`;
      }
    }
    // Live DC voltage tags
    if (showValues && opRes && !opRes.error && net && !net.error) {
      for (const idx in net.tagPts) {
        const t = net.tagPts[idx];
        const v = opRes.nodes[net.nodes[idx]];
        const txt = fmt(v, 'V');
        const w = 0.42 * txt.length + 0.5;
        const [x, y] = t.label ? [t.p[0], t.p[1] - 1.25] : [t.p[0] + 0.3, t.p[1] - 0.95];
        out += `<g class="clab-vtag"><rect x="${x - 0.25}" y="${y - 0.5}" width="${w}" height=".72" rx=".2"/><text x="${x}" y="${y}">${esc(txt)}</text></g>`;
      }
    }
    // Tool previews
    if (tool === 'wire') {
      if (wireStart) for (const [a, b] of lRoute(wireStart, cursor)) out += `<line class="clab-wire ghost" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
      out += `<circle class="clab-cursor" cx="${cursor[0]}" cy="${cursor[1]}" r=".22"/>`;
    } else if (TYPES[tool]) {
      out += symbolSvg({ id: '', type: tool, x: cursor[0], y: cursor[1], rot: placeRot, p: TYPES[tool].def || {} }, 'ghost');
    } else if (tool === 'probe') {
      out += `<g class="clab-probe ghost" transform="translate(${cursor[0]} ${cursor[1]})" style="--pc:var(--util-color)"><path d="M0 0L.9-1.3L1.4-.9Z"/><circle cx="1.4" cy="-1.4" r=".35"/></g>`;
    }
    svg.querySelector('.clab-world').innerHTML = out;
    renderHoverTip();
  }

  function renderHoverTip() {
    const tip = root && root.querySelector('.clab-tip');
    if (!tip) return;
    const c = hover && hover.kind === 'comp' && doc.comps.find(x => x.id === hover.id);
    if (!c || !ELECTRICAL.has(c.type) || drag || !opRes || opRes.error) { tip.style.display = 'none'; return; }
    const r = opRes.parts.find(p => p.id === c.id);
    if (!r) { tip.style.display = 'none'; return; }
    tip.innerHTML = `<b>${esc(c.ref)}</b> ${esc(valueText(c))}<br>V ${fmt(r.v, 'V')} · I ${fmt(r.i, 'A')}<br>P ${fmt(r.p, 'W')}${r.p < 0 ? ' (delivering)' : ''}`;
    const b = boxOf(c);
    const sx = (b[2] - view.x) * view.scale + 8, sy = (b[1] - view.y) * view.scale;
    tip.style.left = sx + 'px'; tip.style.top = Math.max(4, sy) + 'px';
    tip.style.display = 'block';
  }

  // ---- hit testing ----------------------------------------------------------------------
  function hitTest(wp) {
    for (let i = doc.comps.length - 1; i >= 0; i--) {
      const c = doc.comps[i], b = boxOf(c);
      if (wp[0] >= b[0] - 0.15 && wp[0] <= b[2] + 0.15 && wp[1] >= b[1] - 0.15 && wp[1] <= b[3] + 0.15) return { kind: 'comp', id: c.id };
    }
    let best = null, bd = 0.35;
    for (const w of doc.wires) { const d = segDist(wp, w.pts[0], w.pts[1]); if (d < bd) { bd = d; best = { kind: 'wire', id: w.id }; } }
    return best;
  }
  function isConnPoint(p) {
    return doc.comps.some(c => pinsOf(c).some(q => q[0] === p[0] && q[1] === p[1]))
      || doc.wires.some(w => w.pts.some(q => q[0] === p[0] && q[1] === p[1]) || onSegInterior(p, w.pts[0], w.pts[1]));
  }
  function toWorld(ev) {
    const r = svg.getBoundingClientRect();
    return [view.x + (ev.clientX - r.left) / view.scale, view.y + (ev.clientY - r.top) / view.scale];
  }
  const snap = (p) => [Math.round(p[0]), Math.round(p[1])];

  // ---- editing --------------------------------------------------------------------------
  function nextRef(type) {
    const pre = TYPES[type].prefix;
    if (!pre) return '';
    let n = 1;
    const used = new Set(doc.comps.filter(c => c.type === type).map(c => c.ref));
    while (used.has(pre + n)) n++;
    return pre + n;
  }
  function placePart(type, at) {
    pushUndo();
    const c = { id: newId('c'), type, ref: nextRef(type), x: at[0], y: at[1], rot: placeRot, p: JSON.parse(JSON.stringify(TYPES[type].def || {})) };
    if (type === 'LABEL') {
      // Suggest a fresh name: out, in, then n1…
      const names = new Set(doc.comps.filter(x => x.type === 'LABEL').map(x => x.p.name));
      c.p.name = ['out', 'in', 'vcc'].find(n => !names.has(n)) || ('n' + (names.size + 1));
    }
    doc.comps.push(c);
    sel = { kind: 'comp', id: c.id };
    changed();
  }
  function addWire(a, b) {
    for (const [p, q] of lRoute(a, b)) {
      if (p[0] === q[0] && p[1] === q[1]) continue;
      if (doc.wires.some(w => (key(...w.pts[0]) === key(...p) && key(...w.pts[1]) === key(...q)) || (key(...w.pts[0]) === key(...q) && key(...w.pts[1]) === key(...p)))) continue;
      doc.wires.push({ id: newId('w'), pts: [p, q] });
    }
  }
  function deleteSel() {
    if (!sel) return;
    pushUndo();
    if (sel.kind === 'comp') {
      doc.comps = doc.comps.filter(c => c.id !== sel.id);
      doc.probes = doc.probes.filter(p => p.part !== sel.id);
    } else doc.wires = doc.wires.filter(w => w.id !== sel.id);
    sel = null;
    changed();
  }
  function rotateSel() {
    if (TYPES[tool]) { placeRot = (placeRot + 1) % 4; renderSchematic(); return; }
    const c = sel && sel.kind === 'comp' && doc.comps.find(x => x.id === sel.id);
    if (!c) return;
    pushUndo();
    c.rot = (c.rot + 1) % 4;
    changed();
  }
  function setTool(t) {
    tool = t;
    wireStart = null;
    if (TYPES[t]) sel = null;
    root.querySelectorAll('.clab-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
    renderSchematic();
  }
  function toggleProbe(wp) {
    const hit = hitTest(wp);
    pushUndo();
    if (hit && hit.kind === 'comp') {
      const c = doc.comps.find(x => x.id === hit.id);
      if (ELECTRICAL.has(c.type)) {
        const ex = doc.probes.find(p => p.part === c.id);
        if (ex) doc.probes = doc.probes.filter(p => p !== ex);
        else doc.probes.push({ id: newId('p'), part: c.id });
        changed(); renderPlot();
        return;
      }
    }
    // Voltage probe: snap onto the wire/pin under the cursor.
    let pt = null;
    const s = snap(wp);
    if (isConnPoint(s)) pt = s;
    else if (hit && hit.kind === 'wire') {
      // Off-grid diagonal wire: fall back to its nearer end.
      const w = doc.wires.find(x => x.id === hit.id);
      const d0 = Math.hypot(wp[0] - w.pts[0][0], wp[1] - w.pts[0][1]), d1 = Math.hypot(wp[0] - w.pts[1][0], wp[1] - w.pts[1][1]);
      pt = d0 < d1 ? w.pts[0] : w.pts[1];
    }
    if (!pt) { undoStack.pop(); return; }
    const nodeIdx = net && net.nodeAt(pt[0], pt[1]);
    const ex = doc.probes.find(p => !p.part && net && net.nodeAt(p.x, p.y) === nodeIdx && nodeIdx > 0);
    if (ex) doc.probes = doc.probes.filter(p => p !== ex);
    else doc.probes.push({ id: newId('p'), x: pt[0], y: pt[1] });
    changed(); renderPlot();
  }

  function onPointerDown(ev) {
    if (ev.button === 1 || (ev.button === 0 && ev.altKey)) { startPan(ev); return; }
    if (ev.button === 2) return;  // handled in contextmenu
    const wp = toWorld(ev), sp = snap(wp);
    cursor = sp;
    if (tool === 'wire') {
      if (!wireStart) { wireStart = sp; renderSchematic(); return; }
      if (sp[0] === wireStart[0] && sp[1] === wireStart[1]) { wireStart = null; renderSchematic(); return; }
      const ends = isConnPoint(sp);      // landing on a pin or wire finishes the run
      pushUndo();
      addWire(wireStart, sp);
      wireStart = ends ? null : sp;
      changed();
      return;
    }
    if (tool === 'probe') { toggleProbe(wp); return; }
    if (TYPES[tool]) { placePart(tool, sp); return; }
    // select tool
    const hit = hitTest(wp);
    if (!hit) { sel = null; renderSchematic(); renderSide(); startPan(ev); return; }
    sel = hit;
    if (hit.kind === 'comp') {
      const c = doc.comps.find(x => x.id === hit.id);
      const pins = pinsOf(c).map(p => key(...p));
      const attached = [];
      doc.wires.forEach(w => w.pts.forEach((q, i) => { const pi = pins.indexOf(key(...q)); if (pi >= 0) attached.push({ w, i, pi }); }));
      drag = { kind: 'comp', c, start: sp, orig: [c.x, c.y], attached, moved: false, snapshot: JSON.stringify(doc) };
    } else {
      const w = doc.wires.find(x => x.id === hit.id);
      drag = { kind: 'wire', w, start: sp, orig: w.pts.map(p => p.slice()), moved: false, snapshot: JSON.stringify(doc) };
    }
    try { svg.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic or already-released pointer */ }
    renderSchematic(); renderSide();
  }
  function startPan(ev) {
    pan = { cx: ev.clientX, cy: ev.clientY, vx: view.x, vy: view.y };
    try { svg.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic or already-released pointer */ }
    svg.classList.add('panning');
  }
  function onPointerMove(ev) {
    if (pan) {
      view.x = pan.vx - (ev.clientX - pan.cx) / view.scale;
      view.y = pan.vy - (ev.clientY - pan.cy) / view.scale;
      renderSchematic();
      return;
    }
    const wp = toWorld(ev), sp = snap(wp);
    const moved = sp[0] !== cursor[0] || sp[1] !== cursor[1];
    cursor = sp;
    if (drag) {
      const dx = sp[0] - drag.start[0], dy = sp[1] - drag.start[1];
      if (!dx && !dy && !drag.moved) return;
      drag.moved = true;
      if (drag.kind === 'comp') {
        drag.c.x = drag.orig[0] + dx; drag.c.y = drag.orig[1] + dy;
        const pins = pinsOf(drag.c);
        for (const a of drag.attached) a.w.pts[a.i] = pins[a.pi].slice();
      } else {
        drag.w.pts = drag.orig.map(p => [p[0] + dx, p[1] + dy]);
      }
      net = buildNetlist();
      renderSchematic();
      return;
    }
    const h = tool === 'select' || tool === 'probe' ? hitTest(wp) : null;
    const hovChanged = JSON.stringify(h) !== JSON.stringify(hover);
    hover = h;
    if (moved || hovChanged) renderSchematic();
  }
  function onPointerUp(ev) {
    if (pan) { pan = null; svg.classList.remove('panning'); return; }
    if (drag) {
      if (drag.moved) {
        undoStack.push(drag.snapshot); redoStack = [];
        // Drop zero-length wires left by rubber-banding.
        doc.wires = doc.wires.filter(w => key(...w.pts[0]) !== key(...w.pts[1]));
        drag = null;
        changed();
      } else drag = null;
    }
  }
  function onContextMenu(ev) {
    ev.preventDefault();
    if (tool === 'wire' && wireStart) { wireStart = null; renderSchematic(); return; }
    if (tool !== 'select') { setTool('select'); return; }
    // Right-click a part = rotate it (fewest clicks).
    const hit = hitTest(toWorld(ev));
    if (hit && hit.kind === 'comp') { sel = hit; rotateSel(); }
  }
  function onDblClick(ev) {
    if (tool === 'wire') { wireStart = null; renderSchematic(); return; }
    const hit = hitTest(toWorld(ev));
    if (hit && hit.kind === 'comp') {
      sel = hit; rightTab = 'props'; renderSide();
      const f = root.querySelector('.clab-side [data-prop]');
      if (f) { f.focus(); if (f.select) f.select(); }
    } else if (!hit) {
      setTool('wire'); wireStart = snap(toWorld(ev)); renderSchematic();
    }
  }
  function onWheel(ev) {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const wx = view.x + mx / view.scale, wy = view.y + my / view.scale;
    const f = Math.exp(-ev.deltaY * 0.0015);
    view.scale = Math.max(6, Math.min(120, view.scale * f));
    view.x = wx - mx / view.scale; view.y = wy - my / view.scale;
    renderSchematic();
  }
  function fitView() {
    if (!svg) return;
    const W = svg.clientWidth || 800, H = svg.clientHeight || 500;
    if (!doc.comps.length && !doc.wires.length) { view = { x: -W / 56, y: -H / 56, scale: 28 }; renderSchematic(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of doc.comps) { const b = boxOf(c); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
    for (const w of doc.wires) for (const p of w.pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    x0 -= 3; y0 -= 3; x1 += 3; y1 += 3;
    view.scale = Math.max(8, Math.min(48, Math.min(W / (x1 - x0), H / (y1 - y0))));
    view.x = (x0 + x1) / 2 - W / view.scale / 2;
    view.y = (y0 + y1) / 2 - H / view.scale / 2;
    renderSchematic();
  }

  function onKey(ev) {
    if (!root || !root.offsetParent) return;                       // pane hidden
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); t.blur(); run(); }
      return;
    }
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); redo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'r') { ev.preventDefault(); rotateSel(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'enter') { ev.preventDefault(); run(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'd') { ev.preventDefault(); duplicateSel(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (k === 'escape') { if (wireStart) { wireStart = null; renderSchematic(); } else { setTool('select'); sel = null; renderSide(); } return; }
    if (k === 'delete' || k === 'backspace') { ev.preventDefault(); deleteSel(); return; }
    if (k === ' ') { ev.preventDefault(); rotateSel(); return; }
    if (k === 'w') { setTool('wire'); return; }
    if (k === 'p') { setTool('probe'); return; }
    if (k === 'f') { fitView(); return; }
    const type = PALETTE.find(ty => TYPES[ty].key === k);
    if (type) setTool(type);
  }
  function duplicateSel() {
    const c = sel && sel.kind === 'comp' && doc.comps.find(x => x.id === sel.id);
    if (!c) return;
    pushUndo();
    const d = { ...JSON.parse(JSON.stringify(c)), id: newId('c'), ref: nextRef(c.type), x: c.x + 2, y: c.y + 2 };
    doc.comps.push(d);
    sel = { kind: 'comp', id: d.id };
    changed();
  }

  // ---- side panel (properties / analysis) -----------------------------------------------
  const field = (label, prop, val, hint = '') => `
    <label class="clab-field"><span>${label}</span>
      <input class="kicad-input" data-prop="${prop}" value="${esc(val)}" spellcheck="false">${hint ? `<em>${hint}</em>` : ''}</label>`;
  function sourceFields(c) {
    const p = c.p, u = TYPES[c.type].unit;
    const w = p.wave || 'dc';
    let h = `<label class="clab-field"><span>Waveform</span><select class="kicad-input" data-prop="wave">
      ${[['dc', 'DC'], ['sine', 'Sine'], ['square', 'Square'], ['pulse', 'Pulse / step'], ['tri', 'Triangle']].map(([v, l]) => `<option value="${v}"${w === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select></label>`;
    if (w === 'dc') h += field('Value', 'dc', p.dc, u);
    if (w === 'sine' || w === 'square' || w === 'tri') h += field('Offset', 'dc', p.dc, u) + field('Amplitude', 'amp', p.amp, u + ' peak') + field('Frequency', 'freq', p.freq, 'Hz');
    if (w === 'sine') h += field('Phase', 'phase', p.phase, '°');
    if (w === 'square') h += field('Duty', 'duty', p.duty, '%');
    if (w === 'pulse') h += field('Initial', 'v1', p.v1, u) + field('Pulsed', 'v2', p.v2, u) + field('Delay', 'delay', p.delay, 's')
      + field('Rise/fall', 'rise', p.rise, 's') + field('Period', 'period', p.period, 's · 0 = step') + field('Duty', 'duty', p.duty, '%');
    h += field('AC magnitude', 'ac', p.ac, u + ' · AC sweep drive');
    return h;
  }
  function propsHtml() {
    const c = sel && sel.kind === 'comp' && doc.comps.find(x => x.id === sel.id);
    if (!c) {
      const w = sel && sel.kind === 'wire';
      return `<div class="clab-hint">
        ${w ? '<p><b>Wire</b> selected — <kbd>Del</kbd> removes it, drag to move.</p>' : ''}
        <p><b>Place</b> a part from the toolbar (or press its letter), click to drop. <kbd>Space</kbd> or right-click rotates.</p>
        <p><b>Wire</b> <kbd>W</kbd>: click point to point; it ends on a pin or wire. Double-click empty canvas to start one.</p>
        <p><b>Probe</b> <kbd>P</kbd>: click a wire to plot its voltage, a part for its current.</p>
        <p><b>Run</b> <kbd>Ctrl</kbd>+<kbd>Enter</kbd>. DC values update live as you edit.</p>
        <p><kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> undo/redo · <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate · <kbd>F</kbd> fit · wheel zoom · drag empty space to pan</p>
      </div>`;
    }
    const T = TYPES[c.type];
    let h = `<div class="clab-prop-head"><span class="clab-prop-type">${esc(T.name)}</span>`;
    if (T.prefix) h += `<input class="kicad-input clab-ref-input" data-ref value="${esc(c.ref)}" spellcheck="false">`;
    h += '</div>';
    switch (c.type) {
      case 'R': h += field('Resistance', 'value', c.p.value, 'Ω — 4.7k, 1meg'); break;
      case 'C': h += field('Capacitance', 'value', c.p.value, 'F — 100n, 10u'); break;
      case 'L': h += field('Inductance', 'value', c.p.value, 'H — 10u, 1m'); break;
      case 'D':
        h += `<label class="clab-field"><span>Model</span><select class="kicad-input" data-prop="model">
          ${Object.keys(DIODE_MODELS).map(m => `<option${c.p.model === m ? ' selected' : ''}>${m}</option>`).join('')}
          ${!DIODE_MODELS[c.p.model] ? '<option selected>Custom</option>' : ''}</select></label>`
          + field('Saturation current Is', 'is', c.p.is, 'A') + field('Emission n', 'n', c.p.n) + field('Series Rs', 'rs', c.p.rs, 'Ω');
        break;
      case 'LED':
        h += `<label class="clab-field"><span>Colour</span><select class="kicad-input" data-prop="color">
          ${Object.keys(E.LED_COLORS).map(m => `<option${c.p.color === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>`;
        break;
      case 'V': case 'I': h += sourceFields(c); break;
      case 'OA': h += field('Open-loop gain', 'gain', c.p.gain, 'V/V') + field('Gain-bandwidth', 'gbw', c.p.gbw, 'Hz (AC sweep)') + field('Output swing', 'vsat', c.p.vsat, '± V rails'); break;
      case 'LABEL': h += field('Net name', 'name', c.p.name, 'same name = same net · "0"/"gnd" = ground'); break;
    }
    if (opRes && !opRes.error && ELECTRICAL.has(c.type)) {
      const r = opRes.parts.find(p => p.id === c.id);
      if (r) h += `<div class="clab-op-mini"><div><span>Voltage</span><b>${fmt(r.v, 'V')}</b></div><div><span>Current</span><b>${fmt(r.i, 'A')}</b></div><div><span>Power</span><b>${fmt(r.p, 'W')}</b></div></div>`;
    }
    h += `<div class="clab-prop-actions">
      <button class="kicad-btn kicad-btn-outline" data-act="rotate">⟳ Rotate</button>
      <button class="kicad-btn kicad-btn-outline" data-act="dup">⧉ Duplicate</button>
      ${ELECTRICAL.has(c.type) ? `<button class="kicad-btn kicad-btn-outline" data-act="probe-i">${doc.probes.some(p => p.part === c.id) ? '✕ Unprobe I' : '📈 Probe current'}</button>` : ''}
      <button class="kicad-btn kicad-btn-outline clab-danger" data-act="delete">🗑 Delete</button></div>`;
    return h;
  }

  function analysisHtml() {
    let h = '';
    if (net && net.error) return `<div class="clab-hint"><p>${esc(net.error)}</p></div>`;
    if (net && net.warnings.length) h += `<div class="clab-warn">${net.warnings.map(w => '⚠ ' + esc(w)).join('<br>')}</div>`;
    if (runRes && runRes.kind === 'error') h += `<div class="clab-err">${esc(runRes.error)}</div>`;
    if (opRes && opRes.error) h += `<div class="clab-err">${esc(opRes.error)}</div>`;

    // Run-specific measurements first — that's what the user just asked for.
    if (runRes && runRes.kind === 'tran') {
      h += `<div class="clab-sec"><div class="clab-sec-title">Transient measurements <span>${runRes.steps} steps · ${runRes.ms.toFixed(0)} ms</span></div><table class="clab-table"><tr><th></th><th>min</th><th>max</th><th>avg</th><th>RMS</th><th>freq</th><th>rise</th></tr>`;
      for (const s of runSeries()) {
        const y = s.node ? runRes.nodes[s.node] : runRes.currents[s.partId];
        const m = y && E.measure(runRes.time, y);
        if (!m) continue;
        h += `<tr><td><i style="background:${s.color}"></i>${esc(s.label)}</td><td>${fmt(m.min, s.unit)}</td><td>${fmt(m.max, s.unit)}</td><td>${fmt(m.avg, s.unit)}</td><td>${fmt(m.rms, s.unit)}</td><td>${m.freq ? fmt(m.freq, 'Hz') : '—'}</td><td>${m.rise ? fmt(m.rise, 's') : '—'}</td></tr>`;
      }
      h += '</table></div>';
    }
    if (runRes && runRes.kind === 'ac') {
      h += `<div class="clab-sec"><div class="clab-sec-title">Frequency response <span>driven by ${esc(runRes.source || '—')}</span></div><table class="clab-table"><tr><th></th><th>low-f</th><th>peak</th><th>−3 dB</th><th>0 dB</th><th>∠ at 0 dB</th></tr>`;
      for (const s of runSeries()) {
        const b = E.bodeSummary(runRes.freq, runRes.mag[s.node], runRes.phase[s.node]);
        const f3 = [b.fLow && ('↑' + fmt(b.fLow, 'Hz')), b.fHigh && ('↓' + fmt(b.fHigh, 'Hz'))].filter(Boolean).join(' ') || '—';
        const pm = b.phaseAtUnity != null ? b.phaseAtUnity.toFixed(0) + '°' : '—';
        h += `<tr><td><i style="background:${s.color}"></i>${esc(s.label)}</td><td>${b.lowDb.toFixed(1)} dB</td><td>${b.peakDb.toFixed(1)} dB @ ${fmt(b.peakF, 'Hz')}</td><td>${f3}</td><td>${b.fUnity ? fmt(b.fUnity, 'Hz') : '—'}</td><td>${pm}</td></tr>`;
      }
      h += '</table><div class="clab-note">Gain is relative to the AC drive (1 V unless a source sets "AC magnitude"). Op-amps use a single-pole GBW model here. For a loop-gain node, phase margin = 180° + ∠ at 0 dB.</div></div>';
    }

    if (opRes && !opRes.error) {
      h += `<div class="clab-sec"><div class="clab-sec-title">DC operating point <span>${opRes.iters} Newton iter${opRes.iters === 1 ? '' : 's'}</span></div>`;
      h += '<table class="clab-table"><tr><th>Net</th><th>Voltage</th></tr>';
      for (const n of net.nodes.slice(1)) h += `<tr><td>${esc(n)}</td><td>${fmt(opRes.nodes[n], 'V')}</td></tr>`;
      h += '</table><table class="clab-table"><tr><th>Part</th><th>V</th><th>I</th><th>P</th></tr>';
      let supplied = 0, absorbed = 0;
      for (const r of opRes.parts) {
        if (r.p < 0) supplied -= r.p; else absorbed += r.p;
        h += `<tr class="clab-row-part" data-part="${r.id}"><td>${esc(r.ref)}</td><td>${fmt(r.v, 'V')}</td><td>${fmt(r.i, 'A')}</td><td class="${r.p < 0 ? 'clab-neg' : ''}">${fmt(r.p, 'W')}</td></tr>`;
      }
      h += `</table><div class="clab-note">Power balance: sources deliver ${fmt(supplied, 'W')}, parts absorb ${fmt(absorbed, 'W')}${supplied > 1e-12 ? ` (${(Math.abs(absorbed - supplied) / supplied * 100).toFixed(2)}% mismatch)` : ''}. Negative P = delivering.</div></div>`;

      // Thevenin / Norton between two nets
      const opts = (selName) => net.nodes.map(n => `<option value="${esc(n)}"${n === selName ? ' selected' : ''}>${n === '0' ? 'GND' : esc(n)}</option>`).join('');
      const tA = doc.thevA && net.nodes.includes(doc.thevA) ? doc.thevA : (net.nodes.find(n => n === 'out') || net.nodes[net.nodes.length - 1]);
      const tB = doc.thevB && net.nodes.includes(doc.thevB) ? doc.thevB : '0';
      h += `<div class="clab-sec"><div class="clab-sec-title">Thevenin / Norton equivalent</div>
        <div class="clab-thev-row"><select class="kicad-input" data-thev="A">${opts(tA)}</select><span>to</span><select class="kicad-input" data-thev="B">${opts(tB)}</select></div>`;
      const th = E.thevenin({ nodes: net.nodes, parts: net.parts }, tA, tB);
      if (th.error) h += `<div class="clab-note">${esc(th.error)}</div>`;
      else h += `<div class="clab-op-mini"><div><span>V<sub>th</sub></span><b>${fmt(th.voc, 'V')}</b></div><div><span>R<sub>th</sub></span><b>${fmt(th.rth, 'Ω')}</b></div><div><span>I<sub>N</sub></span><b>${isFinite(th.isc) ? fmt(th.isc, 'A') : '∞'}</b></div><div><span>P<sub>max</sub></span><b>${isFinite(th.pmax) ? fmt(th.pmax, 'W') : '—'}</b></div></div>
        <div class="clab-note">Small-signal at the operating point (exact for linear circuits). P<sub>max</sub> into a matched load R<sub>L</sub> = R<sub>th</sub>.</div>`;
      h += '</div>';
    }
    h += `<div class="clab-sec"><div class="clab-sec-title">Netlist</div><pre class="clab-netlist">${esc(spiceNetlist())}</pre></div>`;
    return h;
  }
  // SPICE-flavoured text of the circuit — handy to paste into LTspice/ngspice.
  function spiceNetlist() {
    if (!net || net.error) return '';
    const nn = (i) => net.nodes[i];
    const lines = ['* EngOrg Circuit Lab'];
    const models = {};
    for (const p of net.parts) {
      const q = p.p || {};
      const pins = p.n.map(nn).join(' ');
      if (p.type === 'R' || p.type === 'C' || p.type === 'L') lines.push(`${p.ref} ${pins} ${q.value}`);
      else if (p.type === 'D' || p.type === 'LED') {
        const m = p.type === 'LED' ? 'LED_' + (q.color || 'red') : (q.model && DIODE_MODELS[q.model] ? q.model : 'D_' + p.ref);
        if (p.type === 'LED') { const [is, n] = E.LED_COLORS[q.color] || E.LED_COLORS.red; models[m] = `.model ${m} D(Is=${is} N=${n} Rs=2)`; } else models[m] = `.model ${m} D(Is=${q.is} N=${q.n} Rs=${q.rs})`;
        lines.push(`${p.ref} ${pins} ${m}`);
      } else if (p.type === 'V' || p.type === 'I') {
        const w = q.wave || 'dc';
        let s = `DC ${q.dc}`;
        if (w === 'sine') s = `SIN(${q.dc} ${q.amp} ${q.freq} 0 0 ${q.phase || 0})`;
        if (w === 'square') { const f = E.parseSI(q.freq); s = `PULSE(${E.parseSI(q.dc) - E.parseSI(q.amp)} ${E.parseSI(q.dc) + E.parseSI(q.amp)} 0 0 0 ${(1 / f) * (E.parseSI(q.duty) / 100)} ${1 / f})`; }
        if (w === 'pulse') s = `PULSE(${q.v1} ${q.v2} ${q.delay} ${q.rise || 0} ${q.rise || 0} ${E.parseSI(q.period) ? E.parseSI(q.period) * E.parseSI(q.duty) / 100 : 1e9} ${E.parseSI(q.period) || 2e9})`;
        if (w === 'tri') s = `PULSE(${E.parseSI(q.dc) - E.parseSI(q.amp)} ${E.parseSI(q.dc) + E.parseSI(q.amp)} 0 ${0.5 / E.parseSI(q.freq)} ${0.5 / E.parseSI(q.freq)} 0 ${1 / E.parseSI(q.freq)})`;
        if (E.parseSI(q.ac) > 0) s += ` AC ${q.ac}`;
        lines.push(`${p.ref} ${p.type === 'I' ? [nn(p.n[0]), nn(p.n[1])].join(' ') : pins} ${s}`);
      } else if (p.type === 'OA') {
        lines.push(`E${p.ref} ${nn(p.n[2])} 0 ${nn(p.n[1])} ${nn(p.n[0])} ${q.gain}  ; ideal op-amp (±${q.vsat} V rails in Circuit Lab)`);
      }
    }
    lines.push(...Object.values(models));
    if (doc.mode === 'tran') lines.push(`.tran ${E.parseSI(doc.tran.tStop) / doc.tran.points} ${doc.tran.tStop}${doc.tran.uic ? ' uic' : ''}`);
    else if (doc.mode === 'ac') lines.push(`.ac dec ${doc.ac.ppd} ${doc.ac.fStart} ${doc.ac.fStop}`);
    else lines.push('.op');
    lines.push('.end');
    return lines.join('\n');
  }

  function renderSide() {
    const side = root && root.querySelector('.clab-side-body');
    if (!side) return;
    // Keep the field being typed in focused: skip re-rendering while it has focus.
    const active = document.activeElement;
    if (active && side.contains(active) && active.tagName === 'INPUT') return;
    root.querySelectorAll('.clab-side-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === rightTab));
    side.innerHTML = rightTab === 'props' ? propsHtml() : analysisHtml();
  }

  function bindSide() {
    const side = root.querySelector('.clab-side-body');
    root.querySelectorAll('.clab-side-tab').forEach(b => b.addEventListener('click', () => { rightTab = b.dataset.tab; renderSide(); }));
    let typingSnap = null;
    side.addEventListener('focusin', (e) => { if (e.target.matches('[data-prop],[data-ref]')) typingSnap = JSON.stringify(doc); });
    const apply = (e, commit) => {
      const t = e.target;
      const c = sel && sel.kind === 'comp' && doc.comps.find(x => x.id === sel.id);
      if (!c) return;
      if (t.matches('[data-ref]')) { c.ref = t.value.trim() || c.ref; }
      else if (t.matches('[data-prop]')) {
        const prop = t.dataset.prop;
        c.p[prop] = t.value;
        if (c.type === 'D' && prop === 'model' && DIODE_MODELS[t.value]) Object.assign(c.p, DIODE_MODELS[t.value]);
        if (c.type === 'D' && ['is', 'n', 'rs'].includes(prop)) c.p.model = Object.keys(DIODE_MODELS).find(m => ['is', 'n', 'rs'].every(k => DIODE_MODELS[m][k] === c.p[k])) || 'Custom';
      } else return;
      save();
      net = buildNetlist();
      scheduleLive();
      renderSchematic();
      if (commit) {
        if (typingSnap && typingSnap !== JSON.stringify(doc)) { undoStack.push(typingSnap); redoStack = []; }
        typingSnap = JSON.stringify(doc);
        if (t.tagName === 'SELECT') { runRes = null; renderPlot(); renderSide(); }
      }
    };
    side.addEventListener('input', (e) => apply(e, false));
    side.addEventListener('change', (e) => {
      if (e.target.matches('[data-thev]')) {
        doc[e.target.dataset.thev === 'A' ? 'thevA' : 'thevB'] = e.target.value; save(); renderSide(); return;
      }
      apply(e, true);
    });
    side.addEventListener('focusout', () => setTimeout(() => { if (!side.contains(document.activeElement)) renderSide(); }, 0));
    side.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.ctrlKey && e.target.tagName === 'INPUT') e.target.blur(); });
    side.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) {
        const a = b.dataset.act;
        if (a === 'rotate') rotateSel();
        if (a === 'dup') duplicateSel();
        if (a === 'delete') deleteSel();
        if (a === 'probe-i') {
          pushUndo();
          const ex = doc.probes.find(p => p.part === sel.id);
          if (ex) doc.probes = doc.probes.filter(p => p !== ex); else doc.probes.push({ id: newId('p'), part: sel.id });
          changed(); renderPlot();
        }
        return;
      }
      const row = e.target.closest('.clab-row-part');
      if (row) { sel = { kind: 'comp', id: row.dataset.part }; renderSchematic(); }
    });
  }

  // ---- plot ---------------------------------------------------------------------------
  function renderPlot() {
    const wrap = root && root.querySelector('.clab-plot');
    if (!wrap) return;
    const show = runRes && (runRes.kind === 'tran' || runRes.kind === 'ac');
    wrap.classList.toggle('open', !!show);
    if (!show) return;
    const legend = wrap.querySelector('.clab-legend');
    const series = runSeries();
    legend.innerHTML = (runRes.stale ? '<span class="clab-leg-hint">circuit changed — ▶ Run to refresh</span>' : '') + series.map(s => `<span class="clab-leg" data-label="${esc(s.label)}"><i style="background:${s.color}"></i>${esc(s.label)}<b></b></span>`).join('')
      + (series.some(s => s.auto) ? '<span class="clab-leg-hint">auto-picked · press P and click wires/parts to choose</span>' : '');
    drawPlot();
  }
  function niceTicks(lo, hi, n = 5) {
    if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
    const step0 = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  function drawPlot() {
    const wrap = root.querySelector('.clab-plot');
    const cv = wrap.querySelector('canvas');
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(root);
    const cText = css.getPropertyValue('--text-muted').trim() || '#888';
    const cGrid = css.getPropertyValue('--border-color').trim() || '#444';
    g.font = '11px system-ui, sans-serif';
    const series = runSeries();
    const legendVals = {};

    const panel = (top, h, xs, ysList, xLog, yUnit, rightUnit) => {
      const L = 62, R = rightUnit ? 62 : 14, T = top + 8, B = top + h - 22;
      const xMin = xs[0], xMax = xs[xs.length - 1];
      const X = (x) => L + (xLog ? Math.log10(x / xMin) / Math.log10(xMax / xMin) : (x - xMin) / (xMax - xMin || 1)) * (W - L - R);
      const axes = {};
      for (const side of ['L', 'R']) {
        const ys = ysList.filter(s => s.side === side);
        if (!ys.length) continue;
        let lo = Infinity, hi = -Infinity;
        for (const s of ys) for (const v of s.y) { if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        if (!(hi > lo)) { const m = isFinite(lo) ? Math.abs(lo) * 0.1 || 1 : 1; lo = (isFinite(lo) ? lo : 0) - m; hi = (isFinite(hi) ? hi : 0) + m; }
        const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
        axes[side] = { lo, hi, Y: (v) => B - (v - lo) / (hi - lo) * (B - T), unit: side === 'L' ? yUnit : rightUnit };
      }
      // grid + labels
      g.strokeStyle = cGrid; g.lineWidth = 1; g.fillStyle = cText; g.globalAlpha = 0.55;
      if (xLog) {
        for (let d = Math.ceil(Math.log10(xMin)); d <= Math.floor(Math.log10(xMax)); d++) {
          const x = X(Math.pow(10, d));
          g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke();
          g.globalAlpha = 1; g.textAlign = 'center'; g.fillText(fmt(Math.pow(10, d), 'Hz', 2), x, B + 14); g.globalAlpha = 0.55;
        }
      } else {
        for (const v of niceTicks(xMin, xMax, 8)) {
          const x = X(v);
          g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke();
          g.globalAlpha = 1; g.textAlign = 'center'; g.fillText(fmt(v, 's', 3), x, B + 14); g.globalAlpha = 0.55;
        }
      }
      for (const side of Object.keys(axes)) {
        const a = axes[side];
        for (const v of niceTicks(a.lo, a.hi, 4)) {
          const y = a.Y(v);
          if (side === 'L') { g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); }
          g.globalAlpha = 1; g.textAlign = side === 'L' ? 'right' : 'left';
          g.fillText(a.unit === 'dB' ? v.toFixed(0) + ' dB' : a.unit === '°' ? v.toFixed(0) + '°' : fmt(v, a.unit, 3), side === 'L' ? L - 6 : W - R + 6, y + 4);
          g.globalAlpha = 0.55;
        }
      }
      g.globalAlpha = 1;
      g.strokeRect(L, T, W - L - R, B - T);
      // traces
      for (const s of ysList) {
        const a = axes[s.side];
        if (!a) continue;
        g.strokeStyle = s.color; g.lineWidth = 1.6; g.beginPath();
        const step = Math.max(1, Math.floor(xs.length / ((W - L - R) * 2)));
        for (let i = 0; i < xs.length; i += step) { const x = X(xs[i]), y = a.Y(s.y[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke();
      }
      // hover crosshair + readout
      if (plotHoverX != null && plotHoverX >= L && plotHoverX <= W - R) {
        const fr = (plotHoverX - L) / (W - L - R);
        const xv = xLog ? xMin * Math.pow(xMax / xMin, fr) : xMin + fr * (xMax - xMin);
        let i = xs.findIndex(x => x >= xv); if (i < 0) i = xs.length - 1;
        g.strokeStyle = cText; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(plotHoverX, T); g.lineTo(plotHoverX, B); g.stroke(); g.setLineDash([]);
        g.fillStyle = cText; g.textAlign = 'left'; g.fillText(xLog ? fmt(xs[i], 'Hz') : fmt(xs[i], 's'), plotHoverX + 4, T + 12);
        for (const s of ysList) {
          const a = axes[s.side]; if (!a) continue;
          g.fillStyle = s.color; g.beginPath(); g.arc(plotHoverX, a.Y(s.y[i]), 3, 0, 7); g.fill();
          const u = a.unit, v = s.y[i];
          legendVals[s.label] = (legendVals[s.label] ? legendVals[s.label] + ' / ' : '') + (u === 'dB' ? v.toFixed(2) + ' dB' : u === '°' ? v.toFixed(1) + '°' : fmt(v, u, 4));
        }
      }
    };

    if (runRes.kind === 'tran') {
      const hasV = series.some(s => s.unit === 'V'), hasI = series.some(s => s.unit === 'A');
      const ys = series.map(s => ({ label: s.label, color: s.color, side: (s.unit === 'A' && hasV) ? 'R' : 'L', y: s.node ? runRes.nodes[s.node] : runRes.currents[s.partId] })).filter(s => s.y);
      panel(0, H, runRes.time, ys, false, hasV ? 'V' : 'A', hasV && hasI ? 'A' : null);
    } else {
      const mag = series.map(s => ({ label: s.label, color: s.color, side: 'L', y: runRes.mag[s.node].map(m => 20 * Math.log10(Math.max(m, 1e-30))) }));
      const ph = series.map(s => ({ label: s.label, color: s.color, side: 'L', y: runRes.phase[s.node] }));
      panel(0, H * 0.58, runRes.freq, mag, true, 'dB');
      panel(H * 0.58, H * 0.42, runRes.freq, ph, true, '°');
    }
    wrap.querySelectorAll('.clab-leg').forEach(el => { el.querySelector('b').textContent = legendVals[el.dataset.label] ? ' ' + legendVals[el.dataset.label] : ''; });
  }
  function exportCsv() {
    if (!runRes || (runRes.kind !== 'tran' && runRes.kind !== 'ac')) return;
    const series = runSeries();
    let rows;
    if (runRes.kind === 'tran') {
      rows = [['time_s', ...series.map(s => s.label)].join(',')];
      runRes.time.forEach((t, i) => rows.push([t, ...series.map(s => (s.node ? runRes.nodes[s.node] : runRes.currents[s.partId])[i])].join(',')));
    } else {
      rows = [['freq_Hz', ...series.flatMap(s => [s.label + '_dB', s.label + '_deg'])].join(',')];
      runRes.freq.forEach((f, i) => rows.push([f, ...series.flatMap(s => [20 * Math.log10(Math.max(runRes.mag[s.node][i], 1e-30)), runRes.phase[s.node][i]])].join(',')));
    }
    window.api.circuitLab.saveText(rows.join('\n'), (runRes.kind === 'tran' ? 'transient' : 'ac-sweep') + '.csv');
  }

  // ---- examples -----------------------------------------------------------------------
  // Each: parts [type, x, y, rot, props, ref?] + wire polylines [[x,y], …].
  const EXAMPLES = {
    'Voltage divider': { mode: 'op', parts: [['V', 0, 0, 0, { dc: '12' }], ['R', 3, -4, 0, { value: '10k' }], ['R', 6, 0, 1, { value: '4.7k' }], ['GND', 0, 2, 0], ['GND', 6, 2, 0], ['LABEL', 6, -4, 0, { name: 'out' }]],
      wires: [[[0, -2], [0, -4], [1, -4]], [[5, -4], [6, -4], [6, -2]]] },
    'RC low-pass filter': { mode: 'tran', tran: { tStop: '5m', points: 1000 }, ac: { fStart: '10', fStop: '1meg', ppd: 40 },
      parts: [['V', 0, 0, 0, { wave: 'square', dc: '2.5', amp: '2.5', freq: '500', ac: '1' }], ['R', 3, -4, 0, { value: '1k' }], ['C', 6, 0, 1, { value: '100n' }], ['GND', 0, 2, 0], ['GND', 6, 2, 0], ['LABEL', 0, -4, 2, { name: 'in' }], ['LABEL', 6, -4, 0, { name: 'out' }]],
      wires: [[[0, -2], [0, -4], [1, -4]], [[5, -4], [6, -4], [6, -2]]] },
    'Half-wave rectifier': { mode: 'tran', tran: { tStop: '100m', points: 2000 },
      parts: [['V', 0, 0, 0, { wave: 'sine', dc: '0', amp: '12', freq: '60' }], ['D', 3, -4, 0, { model: '1N4007', ...DIODE_MODELS['1N4007'] }], ['C', 7, 0, 1, { value: '220u' }], ['R', 10, 0, 1, { value: '1k' }], ['GND', 0, 2, 0], ['GND', 7, 2, 0], ['GND', 10, 2, 0], ['LABEL', 0, -4, 2, { name: 'in' }], ['LABEL', 10, -4, 0, { name: 'out' }]],
      wires: [[[0, -2], [0, -4], [1, -4]], [[5, -4], [7, -4], [7, -2]], [[7, -4], [10, -4], [10, -2]]] },
    'Inverting amplifier': { mode: 'tran', tran: { tStop: '3m', points: 1500 }, ac: { fStart: '10', fStop: '10meg', ppd: 40 },
      parts: [['V', 0, 2, 0, { wave: 'sine', dc: '0', amp: '0.5', freq: '1k', ac: '1' }], ['R', 3, 0, 0, { value: '1k' }], ['R', 9, -3, 0, { value: '10k' }], ['OA', 9, 1, 0, {}], ['GND', 0, 4, 0], ['GND', 6, 2, 0], ['LABEL', 0, 0, 2, { name: 'in' }], ['LABEL', 13, 1, 0, { name: 'out' }]],
      wires: [[[0, 0], [1, 0]], [[5, 0], [6, 0], [6, -3], [7, -3]], [[11, -3], [13, -3], [13, 1], [12, 1]]] },
    'RLC resonance': { mode: 'tran', tran: { tStop: '2m', points: 2000 }, ac: { fStart: '100', fStop: '100k', ppd: 60 },
      parts: [['V', 0, 0, 0, { wave: 'pulse', v1: '0', v2: '1', delay: '100u', period: '0', ac: '1' }], ['R', 3, -4, 0, { value: '10' }], ['L', 8, -4, 0, { value: '1m' }], ['C', 11, 0, 1, { value: '1u' }], ['GND', 0, 2, 0], ['GND', 11, 2, 0], ['LABEL', 11, -4, 0, { name: 'out' }]],
      wires: [[[0, -2], [0, -4], [1, -4]], [[5, -4], [6, -4]], [[10, -4], [11, -4], [11, -2]]] },
    'LED current limit': { mode: 'op',
      parts: [['V', 0, 0, 0, { dc: '5' }], ['R', 3, -4, 0, { value: '220' }], ['LED', 7, 0, 1, { color: 'red' }], ['GND', 0, 2, 0], ['GND', 7, 2, 0], ['LABEL', 7, -4, 0, { name: 'anode' }]],
      wires: [[[0, -2], [0, -4], [1, -4]], [[5, -4], [7, -4], [7, -2]]] },
  };
  function loadExample(name) {
    const ex = EXAMPLES[name];
    if (!ex) return;
    pushUndo();
    const d = emptyDoc();
    d.mode = ex.mode || 'op';
    if (ex.tran) d.tran = { ...d.tran, ...ex.tran };
    if (ex.ac) d.ac = { ...d.ac, ...ex.ac };
    doc = d;
    runRes = null;
    for (const [type, x, y, rot, props] of ex.parts) {
      doc.comps.push({ id: newId('c'), type, ref: nextRef(type), x, y, rot, p: { ...JSON.parse(JSON.stringify(TYPES[type].def || {})), ...(props || {}) } });
    }
    for (const poly of ex.wires) for (let i = 1; i < poly.length; i++) doc.wires.push({ id: newId('w'), pts: [poly[i - 1], poly[i]] });
    sel = null;
    syncToolbar();
    changed();
    fitView();
    if (doc.mode !== 'op') run();
  }

  // ---- files / hand-off ---------------------------------------------------------------
  async function saveFile() {
    const r = await window.api.circuitLab.saveText(JSON.stringify({ engorgCircuit: 1, ...doc }, null, 1), 'circuit.circuit.json');
    if (r && r.error) alert('Save failed: ' + r.error);
  }
  async function openFile() {
    const r = await window.api.circuitLab.openText([{ name: 'Circuit', extensions: ['json'] }]);
    if (!r || r.canceled) return;
    if (r.error) { alert('Open failed: ' + r.error); return; }
    try {
      const d = JSON.parse(r.text);
      if (!Array.isArray(d.comps)) throw new Error('not a Circuit Lab file');
      pushUndo();
      delete d.engorgCircuit;
      doc = { ...emptyDoc(), ...d };
      sel = null; runRes = null; syncToolbar(); changed(); fitView(); renderPlot();
    } catch (e) { alert('Open failed: ' + e.message); }
  }
  // Netlist for the Trace Designer: one entry per real part, pins named by number.
  function exportNetlist() {
    const n = buildNetlist();
    if (n.error) return { error: n.error };
    const name = (i) => (i === 0 ? 'GND' : n.nodes[i]);
    return {
      parts: n.parts.map(p => {
        const c = doc.comps.find(x => x.id === p.id);
        return { ref: p.ref, type: p.type, value: valueText(c), pins: p.n.map((ni, k) => ({ num: k + 1, net: name(ni) })) };
      }),
      nets: n.nodes.map((_, i) => name(i)),
    };
  }
  function sendToTraces() {
    const nl = exportNetlist();
    if (nl.error) { alert(nl.error); return; }
    if (typeof traceDesigner === 'undefined') return;
    traceDesigner.importNetlist(nl);
    engineeringUtilities.select('trace-designer');
  }

  // ---- mount ------------------------------------------------------------------------------
  function syncToolbar() {
    if (!root) return;
    root.querySelector('#clab-mode').value = doc.mode;
    root.querySelectorAll('.clab-mode-opts').forEach(el => { el.style.display = el.dataset.mode === doc.mode ? '' : 'none'; });
    root.querySelector('#clab-tstop').value = doc.tran.tStop;
    root.querySelector('#clab-tpts').value = doc.tran.points;
    root.querySelector('#clab-uic').checked = !!doc.tran.uic;
    root.querySelector('#clab-fstart').value = doc.ac.fStart;
    root.querySelector('#clab-fstop').value = doc.ac.fStop;
    root.querySelector('#clab-ppd').value = doc.ac.ppd;
  }
  function render(container) {
    const tb = PALETTE.map(t => `<button class="clab-tool" data-tool="${t}" title="${TYPES[t].name} (${TYPES[t].key.toUpperCase()})">
      <svg viewBox="-3.2 -2.2 6.4 4.4"><g>${symbolSvg({ id: '', type: t, x: 0, y: t === 'GND' ? -0.6 : 0, rot: t === 'V' || t === 'I' ? 1 : 0, p: TYPES[t].def || {} }, '')}</g></svg>
      <span>${TYPES[t].name.split(' ')[0]}</span></button>`).join('');
    container.innerHTML = `
      <div class="clab">
        <div class="clab-toolbar">
          <select id="clab-examples" class="kicad-input clab-sel" title="Load an example circuit">
            <option value="">Examples…</option>${Object.keys(EXAMPLES).map(n => `<option>${esc(n)}</option>`).join('')}</select>
          <button class="kicad-btn kicad-btn-outline" data-cmd="new" title="New circuit">New</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="open" title="Open a .circuit.json">Open</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="save" title="Save as .circuit.json">Save</button>
          <span class="clab-sep"></span>
          <button class="clab-tool" data-tool="select" title="Select / move (Esc)"><svg viewBox="-3 -2.2 6 4.4"><path class="clab-cursor-ico" d="M-1-1.8V1.4L-.2.6L.4 1.8L1 1.5L.4.4H1.5Z"/></svg><span>Select</span></button>
          <button class="clab-tool" data-tool="wire" title="Wire (W)"><svg viewBox="-3 -2.2 6 4.4"><path class="clab-wire-ico" d="M-2.5 1.2H0V-1.2H2.5"/></svg><span>Wire</span></button>
          <button class="clab-tool" data-tool="probe" title="Probe (P) — click a wire for V, a part for I"><svg viewBox="-3 -2.2 6 4.4"><g class="clab-probe" style="--pc:var(--util-color)" transform="translate(-1 1.2)"><path d="M0 0L.9-1.3L1.4-.9Z"/><circle cx="1.4" cy="-1.4" r=".35"/></g></svg><span>Probe</span></button>
          ${tb}
        </div>
        <div class="clab-runbar">
          <select id="clab-mode" class="kicad-input clab-sel">
            <option value="op">DC operating point</option><option value="tran">Transient</option><option value="ac">AC sweep</option></select>
          <span class="clab-mode-opts clab-muted" data-mode="op">Updates live as you edit · hover a part for V / I / P</span>
          <span class="clab-mode-opts" data-mode="tran">
            <label>Stop <input id="clab-tstop" class="kicad-input clab-num" spellcheck="false"></label>
            <label>Points <input id="clab-tpts" class="kicad-input clab-num" type="number" min="50" max="20000"></label>
            <label class="clab-chk" title="Start with capacitors discharged and inductors at 0 A instead of the DC operating point"><input type="checkbox" id="clab-uic"> Start from 0</label></span>
          <span class="clab-mode-opts" data-mode="ac">
            <label>From <input id="clab-fstart" class="kicad-input clab-num" spellcheck="false"></label>
            <label>To <input id="clab-fstop" class="kicad-input clab-num" spellcheck="false"></label>
            <label>Pts/dec <input id="clab-ppd" class="kicad-input clab-num" type="number" min="5" max="200"></label></span>
          <button class="kicad-btn kicad-btn-start" data-cmd="run" title="Run (Ctrl+Enter)">▶ Run</button>
          <span class="clab-spacer"></span>
          <label class="clab-chk" title="Show DC net voltages on the schematic"><input type="checkbox" id="clab-values" checked> Values</label>
          <button class="kicad-btn kicad-btn-outline" data-cmd="undo" title="Undo (Ctrl+Z)">↶</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="redo" title="Redo (Ctrl+Y)">↷</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="fit" title="Fit to view (F)">⤢</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="traces" title="Open this circuit in the Trace Designer to lay out a PCB">🧵 To Trace Designer</button>
        </div>
        <div class="clab-main">
          <div class="clab-canvas-col">
            <div class="clab-canvas">
              <svg class="clab-svg" xmlns="http://www.w3.org/2000/svg">
                <defs><pattern id="clab-grid" width="1" height="1" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r=".06" class="clab-grid-dot"/></pattern></defs>
                <g class="clab-world"></g>
              </svg>
              <div class="clab-tip"></div>
            </div>
            <div class="clab-plot">
              <div class="clab-plot-head"><div class="clab-legend"></div>
                <button class="kicad-btn kicad-btn-outline clab-mini" data-cmd="csv" title="Export the plotted data as CSV">CSV</button>
                <button class="kicad-btn kicad-btn-outline clab-mini" data-cmd="closeplot" title="Hide plot">✕</button></div>
              <canvas></canvas>
            </div>
          </div>
          <div class="clab-side">
            <div class="clab-side-tabs"><button class="clab-side-tab" data-tab="props">Properties</button><button class="clab-side-tab" data-tab="analysis">Analysis</button></div>
            <div class="clab-side-body"></div>
          </div>
        </div>
      </div>`;
    root = container.querySelector('.clab');
    svg = root.querySelector('.clab-svg');

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointerleave', () => { if (hover) { hover = null; renderSchematic(); } });
    svg.addEventListener('contextmenu', onContextMenu);
    svg.addEventListener('dblclick', onDblClick);
    svg.addEventListener('wheel', onWheel, { passive: false });
    root.querySelectorAll('.clab-tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      const c = b.dataset.cmd;
      if (c === 'run') run();
      if (c === 'undo') undo();
      if (c === 'redo') redo();
      if (c === 'fit') fitView();
      if (c === 'save') saveFile();
      if (c === 'open') openFile();
      if (c === 'csv') exportCsv();
      if (c === 'traces') sendToTraces();
      if (c === 'closeplot') { runRes = null; renderPlot(); }
      if (c === 'new') {
        window._showConfirm ? window._showConfirm({ title: 'New circuit', message: 'Clear the schematic? (Undo can bring it back.)', confirmText: 'Clear', danger: true })
          .then(ok => { if (ok) { pushUndo(); doc = emptyDoc(); sel = null; runRes = null; syncToolbar(); changed(); fitView(); renderPlot(); } })
          : (pushUndo(), doc = emptyDoc(), sel = null, runRes = null, syncToolbar(), changed(), fitView(), renderPlot());
      }
    });
    root.querySelector('#clab-examples').addEventListener('change', (e) => { const v = e.target.value; e.target.value = ''; if (v) loadExample(v); });
    root.querySelector('#clab-mode').addEventListener('change', (e) => { doc.mode = e.target.value; runRes = null; syncToolbar(); save(); renderPlot(); renderSide(); if (doc.mode !== 'op') run(); });
    root.querySelector('#clab-values').addEventListener('change', (e) => { showValues = e.target.checked; renderSchematic(); });
    const bindNum = (sel, obj, prop, num) => root.querySelector(sel).addEventListener('change', (e) => { doc[obj][prop] = num ? Number(e.target.value) || doc[obj][prop] : e.target.value; save(); });
    bindNum('#clab-tstop', 'tran', 'tStop'); bindNum('#clab-tpts', 'tran', 'points', true);
    bindNum('#clab-fstart', 'ac', 'fStart'); bindNum('#clab-fstop', 'ac', 'fStop'); bindNum('#clab-ppd', 'ac', 'ppd', true);
    root.querySelector('#clab-uic').addEventListener('change', (e) => { doc.tran.uic = e.target.checked; save(); });
    const cv = root.querySelector('.clab-plot canvas');
    cv.addEventListener('pointermove', (e) => { plotHoverX = e.clientX - cv.getBoundingClientRect().left; drawPlot(); });
    cv.addEventListener('pointerleave', () => { plotHoverX = null; drawPlot(); });
    bindSide();
    new ResizeObserver(() => { renderSchematic(); if (runRes) drawPlot(); }).observe(root.querySelector('.clab-canvas'));
  }

  return {
    mount(container) {
      if (mounted || !container) return;
      mounted = true;
      const saved = load();
      render(container);
      if (saved) doc = saved;
      syncToolbar();
      setTool('select');
      if (saved) { changed(); requestAnimationFrame(fitView); } else requestAnimationFrame(() => loadExample('RC low-pass filter'));
    },
    activate() {
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(() => { renderSchematic(); if (runRes) drawPlot(); });
    },
    deactivate() { document.removeEventListener('keydown', onKey); },
    exportNetlist,
  };
})();
