// Trace Designer utility — lay out and route PCB traces, sized from the current they carry.
//
// A 2-layer board editor in millimetres (SVG; y grows downward from the board's top-left
// corner): footprints (pads with nets), traces (polylines on F.Cu / B.Cu with a width)
// and vias. Parts come from Circuit Lab ("To Trace Designer" → importNetlist, which keeps
// the placement of refs already on the board) or from the footprint picker. Routing is
// click-to-click with 45° bends; V drops a via and flips layer mid-route. Copper
// connectivity drives the ratsnest (unrouted pad-to-pad lines, MST per net), net
// inheritance for traces, and DRC (clearance, min width, shorts, off-board copper,
// ampacity). A grid A* autorouter routes the remaining ratsnest on both layers.
//
// Trace sizing is IPC-2221: I = k·ΔT^0.44·A^0.725 (A in mil², k = 0.048 external /
// 0.024 internal), resistance from copper resistivity with its temperature coefficient,
// and IPC-2141 microstrip/stripline impedance. Each net can carry a design current; the
// Nets table suggests a width and "Apply" resizes that net's traces.
//
// Export writes a Gerber RS-274X set (F/B copper, mask, F silk, edge cuts) + an Excellon
// drill file into a chosen folder (window.api.circuitLab.saveFolder); boards save as
// .board.json. Working board autosaves to localStorage. Desktop-only utility.

const traceDesigner = (() => {
  const LS_KEY = 'engorg_tracedesigner_doc';
  const LAYERS = ['top', 'bottom'];
  const LAYER_NAME = { top: 'F.Cu', bottom: 'B.Cu' };
  const GRIDS = [0.25, 0.5, 0.635, 1, 1.27, 2.54];
  const OZ_UM = 34.79;          // 1 oz/ft² copper ≈ 34.79 µm
  const MIL = 0.0254;           // mm per mil

  // ---- footprint library (pads along x at rot 0; mm) ---------------------------------
  const round = (num, dx, dy, d, drill) => ({ num, dx, dy, shape: 'round', w: d, h: d, drill });
  const rect = (num, dx, dy, w, h, drill = 0) => ({ num, dx, dy, shape: 'rect', w, h, drill });
  const FOOTPRINTS = {
    AXIAL_400: { name: 'Axial 0.4" (R/L)', pads: [round(1, -5.08, 0, 1.8, 0.9), round(2, 5.08, 0, 1.8, 0.9)], outline: [-3.3, -1.3, 3.3, 1.3] },
    AXIAL_300: { name: 'Axial 0.3" (diode)', pads: [round(1, -3.81, 0, 1.8, 1.0), rect(2, 3.81, 0, 1.8, 1.8, 1.0)], outline: [-2.4, -1.2, 2.4, 1.2], band: 1.7 },
    RADIAL_5: { name: 'Radial 5 mm pitch (C)', pads: [rect(1, -2.5, 0, 1.6, 1.6, 0.8), round(2, 2.5, 0, 1.6, 0.8)], circle: 4 },
    LED_5MM: { name: 'LED 5 mm', pads: [rect(1, -1.27, 0, 1.8, 1.8, 0.9), round(2, 1.27, 0, 1.8, 0.9)], circle: 2.9 },
    HDR_1x2: { name: 'Header 1×2 2.54 mm', pads: [rect(1, -1.27, 0, 1.7, 1.7, 1.0), round(2, 1.27, 0, 1.7, 1.0)], outline: [-2.54, -1.27, 2.54, 1.27] },
    // Pins 1–4 along the bottom row left→right, 5–8 back along the top (pin 1 square).
    DIP8: { name: 'DIP-8 (op-amp)', pads: [1, 2, 3, 4, 5, 6, 7, 8].map(n => {
      const dx = n <= 4 ? -3.81 + (n - 1) * 2.54 : 3.81 - (n - 5) * 2.54, dy = n <= 4 ? 3.81 : -3.81;
      return n === 1 ? rect(n, dx, dy, 1.6, 1.6, 0.8) : round(n, dx, dy, 1.6, 0.8);
    }), outline: [-5.1, -2.6, 5.1, 2.6], notch: true },
    TP: { name: 'Test point / pad', pads: [round(1, 0, 0, 2, 1.0)] },
    R0805: { name: '0805 SMD', pads: [rect(1, -0.95, 0, 1.0, 1.25), rect(2, 0.95, 0, 1.0, 1.25)], outline: [-1.75, -1.0, 1.75, 1.0] },
    SOD123: { name: 'SOD-123 (diode)', pads: [rect(1, -1.65, 0, 0.9, 1.2), rect(2, 1.65, 0, 0.9, 1.2)], outline: [-2.4, -1.0, 2.4, 1.0], band: -1.2 },
    SOIC8: { name: 'SOIC-8 (op-amp)', pads: [1, 2, 3, 4, 5, 6, 7, 8].map(n => (n <= 4
      ? rect(n, -1.905 + (n - 1) * 1.27, 2.7, 0.6, 1.5) : rect(n, 1.905 - (n - 5) * 1.27, -2.7, 0.6, 1.5))), outline: [-2.5, -1.95, 2.5, 1.95], notch: true },
  };
  // Circuit Lab part type → footprint + which circuit pin lands on which pad number.
  const IMPORT_MAP = {
    tht: { R: 'AXIAL_400', L: 'AXIAL_400', C: 'RADIAL_5', D: 'AXIAL_300', LED: 'LED_5MM', V: 'HDR_1x2', I: 'HDR_1x2', OA: 'DIP8' },
    smd: { R: 'R0805', L: 'R0805', C: 'R0805', D: 'SOD123', LED: 'R0805', V: 'HDR_1x2', I: 'HDR_1x2', OA: 'SOIC8' },
  };
  const PIN_TO_PAD = { OA: [2, 3, 6] };   // in−, in+, out → DIP/SOIC pins 2, 3, 6

  // ---- state ----------------------------------------------------------------------------
  let doc = null;
  let undoStack = [], redoStack = [];
  let tool = 'select';             // 'select' | 'route' | 'via' | 'pad'
  let sel = null;                  // { kind: 'fp'|'trace'|'via', id }
  let hover = null;
  let cursor = [0, 0];
  let routing = null;              // { trace, layer } while drawing
  let flip45 = false;
  let drag = null, pan = null;
  let view = { x: -5, y: -5, scale: 10 };   // px per mm
  let conn = null;                 // connectivity cache
  let drc = [];
  let rightTab = 'board';
  let mounted = false, root = null, svg = null;
  let status = '';

  function emptyDoc() {
    return {
      board: { w: 60, h: 40 }, grid: 1.27,
      stack: { oz: 1, thickness: 1.6, er: 4.5, ambient: 25 },
      rules: { clearance: 0.25, minWidth: 0.2, dT: 10, via: 0.8, viaDrill: 0.4 },
      layer: 'top', width: 0.5, importStyle: 'tht',
      fps: [], traces: [], vias: [], netCurrent: {},
    };
  }
  function ensureDoc() {
    if (doc) return;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.fps)) { doc = { ...emptyDoc(), ...d, rules: { ...emptyDoc().rules, ...d.rules }, stack: { ...emptyDoc().stack, ...d.stack } }; return; } }
    } catch (_) { /* fall through */ }
    doc = emptyDoc();
  }
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(doc)); } catch (_) { /* storage blocked */ } }
  let idSeq = 1;
  const newId = (p) => p + Date.now().toString(36) + (idSeq++).toString(36);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const r3 = (v) => +(+v).toFixed(3);
  const fmtMm = (v) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)) + ' mm';
  const fmt = (v, u) => (typeof CircuitEngine !== 'undefined' ? CircuitEngine.fmtSI(v, u) : (+v).toPrecision(3) + ' ' + u);

  function pushUndo() { undoStack.push(JSON.stringify(doc)); if (undoStack.length > 150) undoStack.shift(); redoStack = []; }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(doc)); doc = JSON.parse(undoStack.pop()); sel = null; routing = null; changed(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(doc)); doc = JSON.parse(redoStack.pop()); sel = null; routing = null; changed(); }
  function changed() { save(); computeConn(); runDrc(); render(); renderSide(); }

  // ---- IPC-2221 / IPC-2141 math -----------------------------------------------------------
  const tMil = (oz) => oz * OZ_UM / 25.4;                       // copper thickness in mil
  const kOf = (internal) => (internal ? 0.024 : 0.048);
  function ampacity(wmm, oz, dT, internal) {
    const A = (wmm / MIL) * tMil(oz);
    return kOf(internal) * Math.pow(dT, 0.44) * Math.pow(A, 0.725);
  }
  function widthFor(I, oz, dT, internal) {
    const A = Math.pow(I / (kOf(internal) * Math.pow(dT, 0.44)), 1 / 0.725);
    return (A / tMil(oz)) * MIL;
  }
  function tempRise(I, wmm, oz, internal) {
    const A = (wmm / MIL) * tMil(oz);
    return Math.pow(I / (kOf(internal) * Math.pow(A, 0.725)), 1 / 0.44);
  }
  function resistance(lenMm, wmm, oz, tempC) {
    const rho = 1.724e-8 * (1 + 0.00393 * (tempC - 20));
    return rho * (lenMm / 1000) / ((wmm / 1000) * (oz * OZ_UM * 1e-6));
  }
  function microstripZ0(wmm, hmm, er, oz) {
    const t = oz * OZ_UM / 1000;
    return 87 / Math.sqrt(er + 1.41) * Math.log(5.98 * hmm / (0.8 * wmm + t));
  }
  function striplineZ0(wmm, bmm, er, oz) {
    const t = oz * OZ_UM / 1000;
    return 60 / Math.sqrt(er) * Math.log(4 * bmm / (0.67 * Math.PI * (0.8 * wmm + t)));
  }

  // ---- geometry ---------------------------------------------------------------------------
  const rot = ([x, y], r) => { for (let i = 0; i < ((r % 4) + 4) % 4; i++) [x, y] = [-y, x]; return [x, y]; };
  function padsOf(fp) {
    return fp.pads.map(p => {
      const [dx, dy] = rot([p.dx, p.dy], fp.rot);
      const swap = fp.rot % 2 === 1;
      return { ...p, fp, x: r3(fp.x + dx), y: r3(fp.y + dy), w: swap ? p.h : p.w, h: swap ? p.w : p.h, layers: p.drill > 0 ? LAYERS : ['top'] };
    });
  }
  function fpBox(fp) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of padsOf(fp)) { x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
    const lib = FOOTPRINTS[fp.lib] || {};
    const ol = lib.outline || (lib.circle ? [-lib.circle, -lib.circle, lib.circle, lib.circle] : null);
    if (ol) {
      for (const c of [[ol[0], ol[1]], [ol[2], ol[3]]]) { const [dx, dy] = rot(c, fp.rot); x0 = Math.min(x0, fp.x + dx); x1 = Math.max(x1, fp.x + dx); y0 = Math.min(y0, fp.y + dy); y1 = Math.max(y1, fp.y + dy); }
    }
    return [x0, y0, x1, y1];
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function segSegDist(a, b, c, d) {
    // Proper intersection → 0; otherwise the min endpoint-to-segment distance.
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
    return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
  }
  // Copper shapes as capsules { a, b, r }: round pads/vias are points, rect pads run along
  // their long side (slightly generous at the corners — fine for clearance checks).
  function padCapsule(p) {
    if (p.shape === 'round') return { a: [p.x, p.y], b: [p.x, p.y], r: p.w / 2 };
    const long = Math.max(p.w, p.h), short = Math.min(p.w, p.h), e = (long - short) / 2;
    return p.w >= p.h ? { a: [p.x - e, p.y], b: [p.x + e, p.y], r: short / 2, rectHalf: [p.w / 2, p.h / 2] } : { a: [p.x, p.y - e], b: [p.x, p.y + e], r: short / 2, rectHalf: [p.w / 2, p.h / 2] };
  }
  const capDist = (A, B) => segSegDist(A.a, A.b, B.a, B.b) - A.r - B.r;
  function inPad(p, pt, slack = 0) {
    if (p.shape === 'round') return Math.hypot(pt[0] - p.x, pt[1] - p.y) <= p.w / 2 + slack;
    return Math.abs(pt[0] - p.x) <= p.w / 2 + slack && Math.abs(pt[1] - p.y) <= p.h / 2 + slack;
  }
  const traceLen = (t) => t.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - t.pts[i - 1][0], p[1] - t.pts[i - 1][1]) : 0), 0);
  function route45(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 1e-6 || ay < 1e-6 || Math.abs(ax - ay) < 1e-6) return [b];
    const d = Math.min(ax, ay), sx = Math.sign(dx), sy = Math.sign(dy);
    const mid = flip45 ? [r3(a[0] + sx * d), r3(a[1] + sy * d)] : (ax > ay ? [r3(b[0] - sx * d), a[1]] : [a[0], r3(b[1] - sy * d)]);
    return [mid, b];
  }

  // ---- connectivity ------------------------------------------------------------------------
  // Items: pads, vias, traces. Union those whose copper touches on a shared layer.
  function computeConn() {
    const pads = [];
    for (const fp of doc.fps) for (const p of padsOf(fp)) pads.push(p);
    const items = [];
    pads.forEach(p => items.push({ kind: 'pad', ref: p, layers: p.layers, net: p.net || '' }));
    doc.vias.forEach(v => items.push({ kind: 'via', ref: v, layers: LAYERS, net: v.net || '' }));
    doc.traces.forEach(t => items.push({ kind: 'trace', ref: t, layers: [t.layer], net: t.net || '' }));
    const parent = items.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    const share = (A, B) => A.layers.some(l => B.layers.includes(l));
    const touches = (A, B) => {
      if (!share(A, B)) return false;
      const ta = A.kind === 'trace' ? A.ref : null, tb = B.kind === 'trace' ? B.ref : null;
      if (ta && tb) {
        const tol = Math.max(ta.w, tb.w) / 2;
        return [ta.pts[0], ta.pts[ta.pts.length - 1]].some(p => tb.pts.some((q, i) => i && segDist(p, tb.pts[i - 1], q) <= tol))
          || [tb.pts[0], tb.pts[tb.pts.length - 1]].some(p => ta.pts.some((q, i) => i && segDist(p, ta.pts[i - 1], q) <= tol));
      }
      const t = ta || tb, o = ta ? B : A;
      if (t) {
        const ends = t.pts;
        if (o.kind === 'pad') return ends.some(p => inPad(o.ref, p, 0.01));
        return ends.some(p => Math.hypot(p[0] - o.ref.x, p[1] - o.ref.y) <= o.ref.dia / 2 + 0.01);
      }
      // pad/via vs pad/via: overlapping copper
      const ca = A.kind === 'pad' ? padCapsule(A.ref) : { a: [A.ref.x, A.ref.y], b: [A.ref.x, A.ref.y], r: A.ref.dia / 2 };
      const cb = B.kind === 'pad' ? padCapsule(B.ref) : { a: [B.ref.x, B.ref.y], b: [B.ref.x, B.ref.y], r: B.ref.dia / 2 };
      return capDist(ca, cb) < -0.01;
    };
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (touches(items[i], items[j])) union(i, j);
    // Island → set of pad nets; traces/vias inherit the island's net when they have none.
    const islandNets = {};
    items.forEach((it, i) => { if (it.net) { const r = find(i); (islandNets[r] = islandNets[r] || new Set()).add(it.net); } });
    items.forEach((it, i) => {
      if (it.kind === 'pad') return;
      const nets = islandNets[find(i)];
      const want = nets && nets.size === 1 ? [...nets][0] : (nets ? it.ref.net : '');
      if ((it.ref.net || '') !== (want || '')) { it.ref.net = want || ''; it.net = want || ''; }
    });
    const shorts = [];
    for (const r in islandNets) if (islandNets[r].size > 1) shorts.push({ root: +r, nets: [...islandNets[r]] });
    // Ratsnest: per net, MST over copper islands using nearest pad pairs.
    const byNet = {};
    items.forEach((it, i) => { if (it.kind === 'pad' && it.net) (byNet[it.net] = byNet[it.net] || []).push({ p: it.ref, island: find(i) }); });
    const rats = [];
    let unrouted = 0;
    for (const n in byNet) {
      const list = byNet[n];
      const islands = [...new Set(list.map(x => x.island))];
      if (islands.length < 2) continue;
      const inTree = new Set([islands[0]]);
      while (inTree.size < islands.length) {
        let best = null;
        for (const a of list) {
          if (!inTree.has(a.island)) continue;
          for (const b of list) {
            if (inTree.has(b.island)) continue;
            const d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y);
            if (!best || d < best.d) best = { a: a.p, b: b.p, d, island: b.island };
          }
        }
        if (!best) break;
        inTree.add(best.island);
        rats.push({ net: n, a: best.a, b: best.b, d: best.d });
        unrouted++;
      }
    }
    conn = { items, find, pads, rats, unrouted, shorts, netNames: Object.keys(byNet).sort() };
  }

  // ---- DRC -------------------------------------------------------------------------------
  function runDrc() {
    drc = [];
    if (!conn) return;
    const R = doc.rules, B = doc.board;
    const shapes = [];
    for (const p of conn.pads) shapes.push({ kind: 'pad', net: p.net || '', layers: p.layers, cap: padCapsule(p), label: `${p.fp.ref}.${p.num}` });
    for (const v of doc.vias) shapes.push({ kind: 'via', net: v.net || '', layers: LAYERS, cap: { a: [v.x, v.y], b: [v.x, v.y], r: v.dia / 2 }, label: 'via' });
    for (const t of doc.traces) for (let i = 1; i < t.pts.length; i++) shapes.push({ kind: 'trace', net: t.net || '', layers: [t.layer], cap: { a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, label: 'trace ' + (t.net || '(no net)'), trace: t });
    for (let i = 0; i < shapes.length; i++) {
      const A = shapes[i];
      for (let j = i + 1; j < shapes.length; j++) {
        const Bs = shapes[j];
        if (A.trace && A.trace === Bs.trace) continue;
        if (A.net && A.net === Bs.net) continue;
        if (!A.layers.some(l => Bs.layers.includes(l))) continue;
        const d = capDist(A.cap, Bs.cap);
        if (d < R.clearance - 1e-6) {
          // Unnetted copper touching netted copper is inheritance, not a violation.
          if (d < 0 && (!A.net || !Bs.net)) continue;
          const at = [(A.cap.a[0] + A.cap.b[0] + Bs.cap.a[0] + Bs.cap.b[0]) / 4, (A.cap.a[1] + A.cap.b[1] + Bs.cap.a[1] + Bs.cap.b[1]) / 4];
          drc.push({ kind: d < 0 ? 'short' : 'clearance', at, msg: `${d < 0 ? 'Short' : 'Clearance ' + Math.max(0, d).toFixed(2) + ' mm'}: ${A.label} ↔ ${Bs.label}` });
        }
      }
    }
    for (const s of conn.shorts) drc.push({ kind: 'short', at: null, msg: 'Nets shorted together: ' + s.nets.join(', ') });
    for (const t of doc.traces) {
      const mid = t.pts[Math.floor(t.pts.length / 2)];
      if (t.w < R.minWidth - 1e-6) drc.push({ kind: 'width', at: mid, msg: `Trace ${t.net || ''} is ${t.w} mm (< min ${R.minWidth} mm)` });
      const I = +doc.netCurrent[t.net] || 0;
      if (I > 0) {
        const cap = ampacity(t.w, doc.stack.oz, R.dT, false);
        if (cap < I) drc.push({ kind: 'current', at: mid, msg: `${t.net}: ${t.w} mm carries ${cap.toFixed(2)} A at ΔT ${R.dT} °C — needs ≥ ${widthFor(I, doc.stack.oz, R.dT, false).toFixed(2)} mm for ${I} A` });
      }
      if (t.pts.some(p => p[0] < 0 || p[1] < 0 || p[0] > B.w || p[1] > B.h)) drc.push({ kind: 'edge', at: mid, msg: `Trace ${t.net || ''} leaves the board` });
    }
    for (const p of conn.pads) if (p.x < 0 || p.y < 0 || p.x > B.w || p.y > B.h) drc.push({ kind: 'edge', at: [p.x, p.y], msg: `${p.fp.ref} pad ${p.num} is off the board` });
  }

  // ---- autorouter --------------------------------------------------------------------------
  // Grid A* over both layers. Obstacles = other nets' copper inflated by clearance + half
  // the track width (and + via radius for via sites). Shortest connections go first.
  function autoroute() {
    if (!conn || !conn.rats.length) { setStatus('Nothing to route — every net is connected.'); return; }
    pushUndo();
    const res = 0.25;
    const B = doc.board, R = doc.rules;
    const nx = Math.ceil(B.w / res) + 1, ny = Math.ceil(B.h / res) + 1, N = nx * ny;
    const w = doc.width, viaR = R.via / 2;
    const rats = conn.rats.slice().sort((a, b) => a.d - b.d);
    let ok = 0, fail = 0;
    const failed = [];
    for (const rat of rats) {
      computeConn();
      const block = { top: new Uint8Array(N), bottom: new Uint8Array(N) };
      const blockVia = new Uint8Array(N);
      const paint = (cap, layers, net) => {
        if (net === rat.net) return;
        for (const [arr, extra] of [[null, w / 2], ['via', viaR]]) {
          const inf = cap.r + R.clearance + extra;
          const x0 = Math.max(0, Math.floor((Math.min(cap.a[0], cap.b[0]) - inf) / res)), x1 = Math.min(nx - 1, Math.ceil((Math.max(cap.a[0], cap.b[0]) + inf) / res));
          const y0 = Math.max(0, Math.floor((Math.min(cap.a[1], cap.b[1]) - inf) / res)), y1 = Math.min(ny - 1, Math.ceil((Math.max(cap.a[1], cap.b[1]) + inf) / res));
          for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
            if (segDist([gx * res, gy * res], cap.a, cap.b) < inf) {
              if (arr === 'via') blockVia[gy * nx + gx] = 1;
              else for (const l of layers) block[l][gy * nx + gx] = 1;
            }
          }
        }
      };
      for (const p of conn.pads) paint(padCapsule(p), p.layers, p.net || '');
      for (const v of doc.vias) paint({ a: [v.x, v.y], b: [v.x, v.y], r: v.dia / 2 }, LAYERS, v.net || '');
      for (const t of doc.traces) for (let i = 1; i < t.pts.length; i++) paint({ a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, [t.layer], t.net || '');
      // Keep tracks a half-width plus clearance inside the board edge.
      const edge = Math.ceil((w / 2 + R.clearance) / res);
      for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
        if (gx < edge || gy < edge || gx >= nx - edge || gy >= ny - edge) { block.top[gy * nx + gx] = 1; block.bottom[gy * nx + gx] = 1; blockVia[gy * nx + gx] = 1; }
      }
      const cell = (p) => [Math.round(p.x / res), Math.round(p.y / res)];
      const [sx, sy] = cell(rat.a), [tx, ty] = cell(rat.b);
      const startLayers = rat.a.layers, endLayers = rat.b.layers;
      // Clear the pads' own cells so the search can enter them.
      const clearPad = (p) => { for (let gy = Math.floor((p.y - p.h / 2) / res); gy <= Math.ceil((p.y + p.h / 2) / res); gy++) for (let gx = Math.floor((p.x - p.w / 2) / res); gx <= Math.ceil((p.x + p.w / 2) / res); gx++) { if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue; if (inPad(p, [gx * res, gy * res], res)) for (const l of p.layers) block[l][gy * nx + gx] = 0; } };
      clearPad(rat.a); clearPad(rat.b);
      const path = astar(nx, ny, block, blockVia, [sx, sy], [tx, ty], startLayers, endLayers, res);
      if (!path) { fail++; failed.push(rat.net); continue; }
      ok++;
      // Path → traces per layer run, with vias at layer changes. Ends snap to pad centres.
      const pts = path.map(([gx, gy, l]) => [r3(gx * res), r3(gy * res), l]);
      pts[0][0] = rat.a.x; pts[0][1] = rat.a.y;
      pts[pts.length - 1][0] = rat.b.x; pts[pts.length - 1][1] = rat.b.y;
      let run = [pts[0]];
      const flush = () => {
        const simp = simplify(run.map(p => [p[0], p[1]]));
        if (simp.length >= 2) doc.traces.push({ id: newId('t'), net: rat.net, layer: run[0][2], w, pts: simp });
      };
      for (let i = 1; i < pts.length; i++) {
        if (pts[i][2] !== pts[i - 1][2]) {
          flush();
          doc.vias.push({ id: newId('v'), x: pts[i][0], y: pts[i][1], dia: R.via, drill: R.viaDrill, net: rat.net });
          run = [pts[i]];
        } else run.push(pts[i]);
      }
      flush();
    }
    changed();
    setStatus(`Autoroute: ${ok} connection${ok === 1 ? '' : 's'} routed${fail ? `, ${fail} failed (${[...new Set(failed)].join(', ')}) — try a narrower width, a bigger board, or move parts apart` : ''}.`);
  }
  function simplify(pts) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) > 1e-9) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out.filter((p, i) => !i || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
  }
  function astar(nx, ny, block, blockVia, s, t, sLayers, tLayers, res) {
    const N = nx * ny, L = 2;
    const g = new Float32Array(N * L).fill(Infinity);
    const from = new Int32Array(N * L).fill(-1);
    const dirOf = new Int8Array(N * L).fill(-1);
    const closed = new Uint8Array(N * L);
    const heapI = [], heapF = [];
    const push = (i, f) => {
      heapI.push(i); heapF.push(f);
      let k = heapI.length - 1;
      while (k > 0) { const p = (k - 1) >> 1; if (heapF[p] <= heapF[k]) break; [heapI[p], heapI[k]] = [heapI[k], heapI[p]]; [heapF[p], heapF[k]] = [heapF[k], heapF[p]]; k = p; }
    };
    const pop = () => {
      const top = heapI[0], last = heapI.pop(), lf = heapF.pop();
      if (heapI.length) {
        heapI[0] = last; heapF[0] = lf;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1; let m = k;
          if (l < heapI.length && heapF[l] < heapF[m]) m = l;
          if (r < heapI.length && heapF[r] < heapF[m]) m = r;
          if (m === k) break;
          [heapI[m], heapI[k]] = [heapI[k], heapI[m]]; [heapF[m], heapF[k]] = [heapF[k], heapF[m]]; k = m;
        }
      }
      return top;
    };
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const h = (x, y) => { const dx = Math.abs(x - t[0]), dy = Math.abs(y - t[1]); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
    const li = (l) => (l === 'top' ? 0 : 1);
    const lname = ['top', 'bottom'];
    for (const l of sLayers) { const i = (s[1] * nx + s[0]) * L + li(l); g[i] = 0; push(i, h(s[0], s[1])); }
    const VIA_COST = 12, TURN = 0.6;
    let iter = 0;
    while (heapI.length && iter++ < 2e6) {
      const cur = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      const c = Math.floor(cur / L), layer = cur % L, x = c % nx, y = Math.floor(c / nx);
      if (x === t[0] && y === t[1] && tLayers.includes(lname[layer])) {
        const path = [];
        for (let k = cur; k >= 0; k = from[k]) { const cc = Math.floor(k / L); path.push([cc % nx, Math.floor(cc / nx), lname[k % L]]); }
        return path.reverse();
      }
      const pd = dirOf[cur];
      for (let d = 0; d < 8; d++) {
        const X = x + DIRS[d][0], Y = y + DIRS[d][1];
        if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
        const ci = Y * nx + X;
        if (block[lname[layer]][ci]) continue;
        // Diagonal moves must not cut a blocked corner.
        if (d >= 4 && (block[lname[layer]][y * nx + X] || block[lname[layer]][Y * nx + x])) continue;
        const ni = ci * L + layer;
        if (closed[ni]) continue;
        const step = (d >= 4 ? Math.SQRT2 : 1) + (pd >= 0 && pd !== d ? TURN : 0);
        const ng = g[cur] + step;
        if (ng < g[ni]) { g[ni] = ng; from[ni] = cur; dirOf[ni] = d; push(ni, ng + h(X, Y)); }
      }
      // Layer change through a via.
      const other = 1 - layer, oi = c * L + other;
      if (!blockVia[c] && !block[lname[other]][c] && !closed[oi]) {
        const ng = g[cur] + VIA_COST;
        if (ng < g[oi]) { g[oi] = ng; from[oi] = cur; dirOf[oi] = -1; push(oi, ng + h(x, y)); }
      }
    }
    return null;
  }

  // ---- Circuit Lab hand-off ------------------------------------------------------------------
  function importNetlist(nl) {
    ensureDoc();
    pushUndo();
    const style = IMPORT_MAP[doc.importStyle] ? doc.importStyle : 'tht';
    const keep = {};
    for (const fp of doc.fps) keep[fp.ref] = fp;
    const next = [];
    let placeX = 4, placeY = 6, rowH = 0;
    const placed = [];
    for (const part of nl.parts) {
      const lib = IMPORT_MAP[style][part.type];
      if (!lib) continue;
      const libFp = FOOTPRINTS[lib];
      const old = keep[part.ref];
      const fp = old && old.lib === lib ? old : { id: newId('f'), ref: part.ref, lib, x: 0, y: 0, rot: 0, pads: [] };
      fp.value = part.value || '';
      const map = PIN_TO_PAD[part.type];
      fp.pads = libFp.pads.map(p => {
        const pinIdx = map ? map.indexOf(p.num) : p.num - 1;
        const pin = pinIdx >= 0 ? part.pins[pinIdx] : null;
        return { ...p, net: pin && pin.net ? pin.net : '' };
      });
      if (!(old && old.lib === lib)) placed.push(fp);
      next.push(fp);
    }
    // New parts: shelf-pack left→right, top→bottom inside the board.
    for (const fp of placed) {
      fp.x = 0; fp.y = 0;
      const b = fpBox(fp), w = b[2] - b[0], h = b[3] - b[1];
      if (placeX + w > doc.board.w - 3) { placeX = 4; placeY += rowH + 4; rowH = 0; }
      fp.x = r3(Math.round((placeX - b[0]) / doc.grid) * doc.grid);
      fp.y = r3(Math.round((placeY - b[1]) / doc.grid) * doc.grid);
      placeX += w + 4; rowH = Math.max(rowH, h);
    }
    if (placeY + rowH + 4 > doc.board.h) doc.board.h = Math.ceil(placeY + rowH + 4);
    doc.fps = next;
    const live = new Set(nl.nets);
    for (const n of Object.keys(doc.netCurrent)) if (!live.has(n)) delete doc.netCurrent[n];
    sel = null;
    changed();
    setStatus(`Imported ${next.length} part${next.length === 1 ? '' : 's'} from Circuit Lab (${placed.length} new). Drag to place, then route or Autoroute.`);
    if (mounted) requestAnimationFrame(fitView);
  }

  // ---- rendering ----------------------------------------------------------------------------
  function padSvg(p, cls) {
    const drill = p.drill > 0 ? `<circle class="td-drill" cx="${p.x}" cy="${p.y}" r="${p.drill / 2}"/>` : '';
    const shape = p.shape === 'round'
      ? `<circle class="td-pad ${cls}" cx="${p.x}" cy="${p.y}" r="${p.w / 2}"/>`
      : `<rect class="td-pad ${cls}" x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${Math.min(p.w, p.h) * 0.12}"/>`;
    return shape + drill;
  }
  function silkSvg(fp, cls) {
    const lib = FOOTPRINTS[fp.lib] || {};
    let out = '';
    const tf = `translate(${fp.x} ${fp.y}) rotate(${fp.rot * 90})`;
    if (lib.outline) {
      const [x0, y0, x1, y1] = lib.outline;
      out += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}"/>`;
      if (lib.notch) out += `<path d="M${x0} -0.6A0.6 0.6 0 0 1 ${x0} 0.6"/>`;
      if (lib.band) out += `<path d="M${lib.band} ${y0}V${y1}"/>`;
    }
    if (lib.circle) out += `<circle cx="0" cy="0" r="${lib.circle}"/>`;
    const b = fpBox(fp);
    return `<g class="td-silk ${cls}" transform="${tf}">${out}</g><text class="td-ref ${cls}" x="${(b[0] + b[2]) / 2}" y="${b[1] - 0.5}" text-anchor="middle">${esc(fp.ref)}</text>`;
  }
  function render() {
    if (!svg) return;
    const W = svg.clientWidth || 800, H = svg.clientHeight || 500;
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${W / view.scale} ${H / view.scale}`);
    const B = doc.board, act = doc.layer;
    const selNet = (() => {
      if (!sel) return null;
      if (sel.kind === 'trace') { const t = doc.traces.find(x => x.id === sel.id); return t && t.net; }
      if (sel.kind === 'via') { const v = doc.vias.find(x => x.id === sel.id); return v && v.net; }
      return null;
    })();
    const hl = (n) => (selNet && n === selNet ? ' hl' : '');
    let out = `<rect class="td-board" x="0" y="0" width="${B.w}" height="${B.h}"/>
      <rect x="0" y="0" width="${B.w}" height="${B.h}" fill="url(#td-grid)"/>`;
    const order = act === 'top' ? ['bottom', 'top'] : ['top', 'bottom'];
    for (const l of order) {
      out += `<g class="td-layer td-${l}${l === act ? ' active' : ''}">`;
      for (const t of doc.traces) {
        if (t.layer !== l) continue;
        const cls = (sel && sel.kind === 'trace' && sel.id === t.id ? ' sel' : hover && hover.kind === 'trace' && hover.id === t.id ? ' hov' : '') + hl(t.net);
        out += `<polyline class="td-trace${cls}" points="${t.pts.map(p => p.join(',')).join(' ')}" stroke-width="${t.w}"/>`;
      }
      out += '</g>';
    }
    for (const fp of doc.fps) {
      const cls = sel && sel.kind === 'fp' && sel.id === fp.id ? 'sel' : hover && hover.kind === 'fp' && hover.id === fp.id ? 'hov' : '';
      out += silkSvg(fp, cls);
      for (const p of padsOf(fp)) out += padSvg(p, (p.layers.length === 1 ? 'smd ' : '') + hl(p.net));
    }
    for (const v of doc.vias) {
      const cls = (sel && sel.kind === 'via' && sel.id === v.id ? ' sel' : '') + hl(v.net);
      out += `<circle class="td-via${cls}" cx="${v.x}" cy="${v.y}" r="${v.dia / 2}"/><circle class="td-drill" cx="${v.x}" cy="${v.y}" r="${v.drill / 2}"/>`;
    }
    if (conn) for (const r of conn.rats) out += `<line class="td-rat${hl(r.net)}" x1="${r.a.x}" y1="${r.a.y}" x2="${r.b.x}" y2="${r.b.y}"/>`;
    for (const d of drc) if (d.at) out += `<circle class="td-drc" cx="${d.at[0]}" cy="${d.at[1]}" r="0.9"/>`;
    // Routing preview
    if (routing) {
      const t = routing.trace, last = t.pts[t.pts.length - 1];
      const pts = [last, ...route45(last, cursor)];
      out += `<polyline class="td-trace ghost td-${routing.layer}" points="${pts.map(p => p.join(',')).join(' ')}" stroke-width="${doc.width}"/>`;
      if (t.pts.length > 1) out += `<polyline class="td-trace ghost td-${routing.layer}" points="${t.pts.map(p => p.join(',')).join(' ')}" stroke-width="${t.w}"/>`;
    }
    if (tool === 'route' || tool === 'via' || tool === 'pad') {
      out += `<circle class="td-cursor" cx="${cursor[0]}" cy="${cursor[1]}" r="${tool === 'via' ? doc.rules.via / 2 : tool === 'pad' ? 1 : doc.width / 2}"/>`;
    }
    svg.querySelector('.td-world').innerHTML = out;
    renderStatus();
  }
  function renderStatus() {
    const el = root && root.querySelector('.td-status');
    if (!el) return;
    const routed = conn ? conn.rats.length : 0;
    const errs = drc.length;
    el.innerHTML = `<span class="td-chip td-chip-${doc.layer}">${LAYER_NAME[doc.layer]}</span>
      <span>width ${doc.width} mm</span>
      <span>${cursor[0].toFixed(2)}, ${cursor[1].toFixed(2)} mm</span>
      <span class="${routed ? 'td-warn' : 'td-good'}">${routed ? routed + ' unrouted' : '✓ all routed'}</span>
      <span class="${errs ? 'td-bad' : 'td-good'}">${errs ? errs + ' DRC' : '✓ DRC clean'}</span>
      <span class="td-msg">${esc(status)}</span>`;
  }
  function setStatus(s) { status = s; renderStatus(); }

  // ---- side panel -----------------------------------------------------------------------------
  const num = (label, attr, val, unit, step = 'any') => `<label class="clab-field"><span>${label}</span><input class="kicad-input" type="number" step="${step}" ${attr} value="${val}">${unit ? `<em>${unit}</em>` : ''}</label>`;
  function traceStats(t) {
    const len = traceLen(t), oz = doc.stack.oz, dT = doc.rules.dT;
    const I = +doc.netCurrent[t.net] || 0;
    const cap = ampacity(t.w, oz, dT, false);
    const temp = doc.stack.ambient + (I > 0 ? tempRise(I, t.w, oz, false) : 0);
    const Rt = resistance(len, t.w, oz, temp);
    return { len, I, cap, Rt, vdrop: I * Rt, p: I * I * Rt, rise: I > 0 ? tempRise(I, t.w, oz, false) : 0, z0: microstripZ0(t.w, doc.stack.thickness, doc.stack.er, oz) };
  }
  function inspectorHtml() {
    if (sel && sel.kind === 'trace') {
      const t = doc.traces.find(x => x.id === sel.id);
      if (!t) return '';
      const s = traceStats(t);
      return `<div class="clab-prop-head"><span class="clab-prop-type">Trace · ${LAYER_NAME[t.layer]}</span><b>${esc(t.net || '(no net)')}</b></div>
        ${num('Width', 'data-tw', t.w, 'mm', '0.05')}
        <label class="clab-field"><span>Layer</span><select class="kicad-input" data-tlayer>${LAYERS.map(l => `<option value="${l}"${t.layer === l ? ' selected' : ''}>${LAYER_NAME[l]}</option>`).join('')}</select></label>
        ${t.net ? num(`Net current (${esc(t.net)})`, 'data-neti="' + esc(t.net) + '"', doc.netCurrent[t.net] || 0, 'A', '0.1') : ''}
        <div class="clab-op-mini">
          <div><span>Length</span><b>${fmtMm(s.len)}</b></div><div><span>Resistance</span><b>${fmt(s.Rt, 'Ω')}</b></div>
          <div><span>Ampacity</span><b>${s.cap.toFixed(2)} A</b></div><div><span>V drop</span><b>${s.I ? fmt(s.vdrop, 'V') : '—'}</b></div>
          <div><span>Temp rise</span><b class="${s.I && s.rise > doc.rules.dT ? 'clab-neg' : ''}">${s.I ? s.rise.toFixed(1) + ' °C' : '—'}</b></div><div><span>Loss</span><b>${s.I ? fmt(s.p, 'W') : '—'}</b></div>
          <div><span>Z₀ microstrip</span><b>${isFinite(s.z0) && s.z0 > 0 ? s.z0.toFixed(1) + ' Ω' : '—'}</b></div><div><span>Segments</span><b>${t.pts.length - 1}</b></div>
        </div>
        <div class="clab-note">Ampacity at ΔT ${doc.rules.dT} °C, ${doc.stack.oz} oz external copper (IPC-2221). Z₀ over a ${doc.stack.thickness} mm, εr ${doc.stack.er} dielectric.</div>
        <div class="clab-prop-actions"><button class="kicad-btn kicad-btn-outline clab-danger" data-act="delete">🗑 Delete</button></div>`;
    }
    if (sel && sel.kind === 'via') {
      const v = doc.vias.find(x => x.id === sel.id);
      if (!v) return '';
      return `<div class="clab-prop-head"><span class="clab-prop-type">Via</span><b>${esc(v.net || '(no net)')}</b></div>
        ${num('Diameter', 'data-vdia', v.dia, 'mm', '0.05')}${num('Drill', 'data-vdrill', v.drill, 'mm', '0.05')}
        <div class="clab-prop-actions"><button class="kicad-btn kicad-btn-outline clab-danger" data-act="delete">🗑 Delete</button></div>`;
    }
    if (sel && sel.kind === 'fp') {
      const fp = doc.fps.find(x => x.id === sel.id);
      if (!fp) return '';
      const lib = FOOTPRINTS[fp.lib] || { name: fp.lib };
      const nets = conn ? conn.netNames : [];
      return `<div class="clab-prop-head"><span class="clab-prop-type">${esc(lib.name)}</span><input class="kicad-input clab-ref-input" data-fpref value="${esc(fp.ref)}" spellcheck="false"></div>
        ${fp.value ? `<div class="clab-note">${esc(fp.value)}</div>` : ''}
        <table class="clab-table"><tr><th>Pad</th><th>Net</th></tr>
        ${fp.pads.map((p, i) => `<tr><td>${p.num}${p.drill ? '' : ' (SMD)'}</td><td><input class="kicad-input td-net-input" data-padnet="${i}" list="td-netlist" value="${esc(p.net || '')}" placeholder="—" spellcheck="false"></td></tr>`).join('')}
        </table><datalist id="td-netlist">${nets.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        <div class="clab-prop-actions"><button class="kicad-btn kicad-btn-outline" data-act="rotate">⟳ Rotate</button><button class="kicad-btn kicad-btn-outline clab-danger" data-act="delete">🗑 Delete</button></div>`;
    }
    // Nothing selected: board setup + per-net current/width table.
    const S = doc.stack, R = doc.rules;
    let h = `<div class="clab-sec"><div class="clab-sec-title">Board</div><div class="td-grid2">
      ${num('Width', 'data-board="w"', doc.board.w, 'mm', '1')}${num('Height', 'data-board="h"', doc.board.h, 'mm', '1')}
      <label class="clab-field"><span>Grid</span><select class="kicad-input" data-grid>${GRIDS.map(g => `<option value="${g}"${doc.grid === g ? ' selected' : ''}>${g} mm${g === 1.27 ? ' (50 mil)' : g === 2.54 ? ' (100 mil)' : g === 0.635 ? ' (25 mil)' : ''}</option>`).join('')}</select></label>
      <label class="clab-field"><span>Import style</span><select class="kicad-input" data-istyle><option value="tht"${doc.importStyle === 'tht' ? ' selected' : ''}>Through-hole</option><option value="smd"${doc.importStyle === 'smd' ? ' selected' : ''}>SMD</option></select></label>
      ${num('Copper', 'data-stack="oz"', S.oz, 'oz', '0.5')}${num('Thickness', 'data-stack="thickness"', S.thickness, 'mm', '0.1')}
      ${num('Dielectric εr', 'data-stack="er"', S.er, '', '0.1')}${num('Ambient', 'data-stack="ambient"', S.ambient, '°C', '1')}
      </div></div>
      <div class="clab-sec"><div class="clab-sec-title">Design rules</div><div class="td-grid2">
      ${num('Clearance', 'data-rule="clearance"', R.clearance, 'mm', '0.05')}${num('Min width', 'data-rule="minWidth"', R.minWidth, 'mm', '0.05')}
      ${num('Max temp rise', 'data-rule="dT"', R.dT, '°C', '1')}${num('Via Ø / drill', 'data-rule="via"', R.via, 'mm', '0.05')}
      </div></div>`;
    const nets = conn ? conn.netNames : [];
    if (nets.length) {
      h += `<div class="clab-sec"><div class="clab-sec-title">Nets <span>current → width</span></div><table class="clab-table td-nets"><tr><th>Net</th><th>Current</th><th>Width</th><th></th></tr>`;
      for (const n of nets) {
        const I = +doc.netCurrent[n] || 0;
        const wNeed = I > 0 ? Math.max(R.minWidth, widthFor(I, S.oz, R.dT, false)) : null;
        const unr = conn.rats.filter(r => r.net === n).length;
        h += `<tr><td>${esc(n)}${unr ? ` <em class="td-warn">${unr}✕</em>` : ''}</td><td><input class="kicad-input td-cur" type="number" min="0" step="0.1" data-neti="${esc(n)}" value="${I || ''}" placeholder="0"></td>
          <td>${wNeed ? wNeed.toFixed(2) + ' mm' : '—'}</td><td>${wNeed ? `<button class="kicad-btn kicad-btn-outline clab-mini" data-applyw="${esc(n)}" title="Resize this net's traces to ${wNeed.toFixed(2)} mm">Apply</button>` : ''}</td></tr>`;
      }
      h += `</table><div class="clab-note">Set the current a net carries to get its IPC-2221 width (ΔT ${R.dT} °C, ${S.oz} oz). New traces on that net start at it.</div></div>`;
    } else {
      h += `<div class="clab-hint"><p><b>Start</b> from a schematic: Circuit Lab → 🧵 To Trace Designer. Or add footprints with the picker and give their pads nets.</p>
        <p><b>Route</b> <kbd>X</kbd>: click a pad, click to bend (45°), finish on a pad. <kbd>V</kbd> drops a via and swaps layer; <kbd>/</kbd> flips the bend; <kbd>[</kbd> <kbd>]</kbd> width; <kbd>L</kbd> layer.</p>
        <p><b>Autoroute</b> routes the dashed ratsnest. <b>Export</b> writes Gerbers + drill for fab.</p></div>`;
    }
    return h;
  }
  function calcHtml() {
    const c = doc.calc || (doc.calc = { I: 1, dT: 10, oz: 1, len: 50, internal: false, w: 0.5 });
    const S = doc.stack;
    const wNeed = widthFor(c.I, c.oz, c.dT, c.internal);
    const capW = ampacity(c.w, c.oz, c.dT, c.internal);
    const Rw = resistance(c.len, wNeed, c.oz, S.ambient + c.dT);
    const z = c.internal ? striplineZ0(c.w, S.thickness, S.er, c.oz) : microstripZ0(c.w, S.thickness, S.er, c.oz);
    return `<div class="clab-sec"><div class="clab-sec-title">Width for a current <span>IPC-2221</span></div><div class="td-grid2">
      ${num('Current', 'data-calc="I"', c.I, 'A', '0.1')}${num('Temp rise', 'data-calc="dT"', c.dT, '°C', '1')}
      ${num('Copper', 'data-calc="oz"', c.oz, 'oz', '0.5')}${num('Length', 'data-calc="len"', c.len, 'mm', '1')}
      <label class="clab-field"><span>Layer</span><select class="kicad-input" data-calc="internal"><option value="0"${!c.internal ? ' selected' : ''}>External</option><option value="1"${c.internal ? ' selected' : ''}>Internal</option></select></label></div>
      <div class="clab-op-mini"><div><span>Min width</span><b>${wNeed.toFixed(3)} mm</b></div><div><span>= </span><b>${(wNeed / MIL).toFixed(1)} mil</b></div>
      <div><span>Resistance</span><b>${fmt(Rw, 'Ω')}</b></div><div><span>V drop</span><b>${fmt(c.I * Rw, 'V')}</b></div>
      <div><span>Power loss</span><b>${fmt(c.I * c.I * Rw, 'W')}</b></div><div><span>Cross-section</span><b>${((wNeed / MIL) * tMil(c.oz)).toFixed(0)} mil²</b></div></div>
      <div class="clab-prop-actions"><button class="kicad-btn kicad-btn-start" data-act="usew" data-w="${Math.max(doc.rules.minWidth, Math.ceil(wNeed * 20) / 20)}">Route at ${Math.max(doc.rules.minWidth, Math.ceil(wNeed * 20) / 20).toFixed(2)} mm</button></div></div>
      <div class="clab-sec"><div class="clab-sec-title">Current for a width</div>
      ${num('Width', 'data-calc="w"', c.w, 'mm', '0.05')}
      <div class="clab-op-mini"><div><span>Max current</span><b>${capW.toFixed(2)} A</b></div><div><span>Z₀ ${c.internal ? 'stripline' : 'microstrip'}</span><b>${isFinite(z) && z > 0 ? z.toFixed(1) + ' Ω' : '—'}</b></div></div>
      <div class="clab-note">Z₀ uses the board's ${S.thickness} mm dielectric and εr ${S.er} (IPC-2141; best for 0.1 &lt; w/h &lt; 2). Internal layers carry about half the current of external ones for the same rise.</div></div>`;
  }
  function drcHtml() {
    const rats = conn ? conn.rats : [];
    let h = `<div class="clab-prop-actions"><button class="kicad-btn kicad-btn-start" data-act="autoroute">⚡ Autoroute ${rats.length ? `(${rats.length})` : ''}</button></div>`;
    if (!drc.length && !rats.length) return h + '<div class="clab-hint"><p>✓ No DRC violations and every net is routed.</p></div>';
    if (drc.length) h += `<div class="clab-sec"><div class="clab-sec-title">Violations <span>${drc.length}</span></div>${drc.map((d, i) => `<div class="td-drc-row" data-drc="${i}"><span class="td-drc-k td-drc-${d.kind}">${d.kind}</span>${esc(d.msg)}</div>`).join('')}</div>`;
    if (rats.length) h += `<div class="clab-sec"><div class="clab-sec-title">Unrouted <span>${rats.length}</span></div>${rats.map(r => `<div class="td-drc-row" data-rat="${esc(r.net)}" data-x="${(r.a.x + r.b.x) / 2}" data-y="${(r.a.y + r.b.y) / 2}"><span class="td-drc-k">${esc(r.net)}</span>${esc(r.a.fp.ref)}.${r.a.num} → ${esc(r.b.fp.ref)}.${r.b.num} · ${fmtMm(r.d)}</div>`).join('')}</div>`;
    return h;
  }
  function renderSide() {
    const side = root && root.querySelector('.td-side-body');
    if (!side) return;
    const a = document.activeElement;
    if (a && side.contains(a) && a.tagName === 'INPUT') return;
    root.querySelectorAll('.td-side-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === rightTab));
    side.innerHTML = rightTab === 'board' ? inspectorHtml() : rightTab === 'calc' ? calcHtml() : drcHtml();
  }
  function bindSide() {
    const side = root.querySelector('.td-side-body');
    root.querySelectorAll('.td-side-tab').forEach(b => b.addEventListener('click', () => { rightTab = b.dataset.tab; renderSide(); }));
    side.addEventListener('change', (e) => {
      const t = e.target, v = t.value, n = parseFloat(v);
      const selT = sel && sel.kind === 'trace' && doc.traces.find(x => x.id === sel.id);
      const selV = sel && sel.kind === 'via' && doc.vias.find(x => x.id === sel.id);
      const selF = sel && sel.kind === 'fp' && doc.fps.find(x => x.id === sel.id);
      if (t.matches('[data-calc]')) {
        doc.calc[t.dataset.calc] = t.dataset.calc === 'internal' ? v === '1' : (isFinite(n) && n > 0 ? n : doc.calc[t.dataset.calc]);
        save(); renderSide(); return;
      }
      pushUndo();
      if (t.matches('[data-tw]') && selT && n > 0) selT.w = n;
      else if (t.matches('[data-tlayer]') && selT) selT.layer = v;
      else if (t.matches('[data-vdia]') && selV && n > 0) selV.dia = n;
      else if (t.matches('[data-vdrill]') && selV && n > 0) selV.drill = n;
      else if (t.matches('[data-fpref]') && selF) selF.ref = v.trim() || selF.ref;
      else if (t.matches('[data-padnet]') && selF) selF.pads[+t.dataset.padnet].net = v.trim();
      else if (t.matches('[data-neti]')) { if (n > 0) doc.netCurrent[t.dataset.neti] = n; else delete doc.netCurrent[t.dataset.neti]; }
      else if (t.matches('[data-board]') && n > 0) doc.board[t.dataset.board] = n;
      else if (t.matches('[data-grid]')) doc.grid = n;
      else if (t.matches('[data-istyle]')) doc.importStyle = v;
      else if (t.matches('[data-stack]') && n > 0) doc.stack[t.dataset.stack] = n;
      else if (t.matches('[data-rule]') && n >= 0) { doc.rules[t.dataset.rule] = n; if (t.dataset.rule === 'via') doc.rules.viaDrill = r3(n / 2); }
      else { undoStack.pop(); return; }
      t.blur();
      changed();
    });
    side.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });
    side.addEventListener('focusout', () => setTimeout(() => { if (!side.contains(document.activeElement)) renderSide(); }, 0));
    side.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act],[data-applyw],[data-drc],[data-rat]');
      if (!b) return;
      if (b.dataset.applyw) {
        const net = b.dataset.applyw, I = +doc.netCurrent[net] || 0;
        const w = Math.max(doc.rules.minWidth, Math.ceil(widthFor(I, doc.stack.oz, doc.rules.dT, false) * 20) / 20);
        pushUndo();
        let k = 0;
        for (const t of doc.traces) if (t.net === net) { t.w = w; k++; }
        changed();
        setStatus(`${net}: ${k} trace${k === 1 ? '' : 's'} set to ${w.toFixed(2)} mm.`);
        return;
      }
      if (b.dataset.drc != null) { const d = drc[+b.dataset.drc]; if (d && d.at) centerOn(d.at); return; }
      if (b.dataset.rat != null) { centerOn([+b.dataset.x, +b.dataset.y]); return; }
      const a = b.dataset.act;
      if (a === 'delete') deleteSel();
      if (a === 'rotate') rotateSel();
      if (a === 'autoroute') autoroute();
      if (a === 'usew') { doc.width = +b.dataset.w; save(); setTool('route'); setStatus(`Routing width set to ${doc.width} mm.`); render(); }
    });
  }
  function centerOn(p) {
    const W = svg.clientWidth, H = svg.clientHeight;
    view.scale = Math.max(view.scale, 18);
    view.x = p[0] - W / view.scale / 2; view.y = p[1] - H / view.scale / 2;
    render();
  }

  // ---- editing ------------------------------------------------------------------------------
  function toWorld(ev) { const r = svg.getBoundingClientRect(); return [view.x + (ev.clientX - r.left) / view.scale, view.y + (ev.clientY - r.top) / view.scale]; }
  const snapGrid = (p) => [r3(Math.round(p[0] / doc.grid) * doc.grid), r3(Math.round(p[1] / doc.grid) * doc.grid)];
  function padAt(p, layer) {
    const pads = conn ? conn.pads : [];
    for (let i = pads.length - 1; i >= 0; i--) if ((!layer || pads[i].layers.includes(layer)) && inPad(pads[i], p)) return pads[i];
    return null;
  }
  // Routing snap: pad centre / via centre / existing trace vertex, else the grid.
  function snapRoute(wp) {
    const pd = padAt(wp, doc.layer);
    if (pd) return { p: [pd.x, pd.y], pad: pd, net: pd.net };
    for (const v of doc.vias) if (Math.hypot(wp[0] - v.x, wp[1] - v.y) <= v.dia / 2) return { p: [v.x, v.y], via: v, net: v.net };
    for (const t of doc.traces) if (t.layer === doc.layer) for (const q of t.pts) if (Math.hypot(wp[0] - q[0], wp[1] - q[1]) <= Math.max(t.w / 2, 0.3)) return { p: q.slice(), trace: t, net: t.net };
    return { p: snapGrid(wp) };
  }
  function hitTest(wp) {
    for (const v of doc.vias) if (Math.hypot(wp[0] - v.x, wp[1] - v.y) <= v.dia / 2 + 0.1) return { kind: 'via', id: v.id };
    const layersOrder = [doc.layer, doc.layer === 'top' ? 'bottom' : 'top'];
    for (const l of layersOrder) for (let i = doc.traces.length - 1; i >= 0; i--) {
      const t = doc.traces[i];
      if (t.layer !== l) continue;
      for (let k = 1; k < t.pts.length; k++) if (segDist(wp, t.pts[k - 1], t.pts[k]) <= t.w / 2 + 0.15) return { kind: 'trace', id: t.id };
    }
    for (let i = doc.fps.length - 1; i >= 0; i--) {
      const b = fpBox(doc.fps[i]);
      if (wp[0] >= b[0] && wp[0] <= b[2] && wp[1] >= b[1] && wp[1] <= b[3]) return { kind: 'fp', id: doc.fps[i].id };
    }
    return null;
  }
  function setTool(t) {
    if (routing) finishRoute();
    tool = t;
    root.querySelectorAll('.td-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
    render();
  }
  function setLayer(l) {
    doc.layer = l;
    root.querySelectorAll('.td-layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === l));
    save(); render();
  }
  function startRoute(s) {
    pushUndo();
    const I = +doc.netCurrent[s.net] || 0;
    if (I > 0) doc.width = Math.max(doc.width, Math.max(doc.rules.minWidth, Math.ceil(widthFor(I, doc.stack.oz, doc.rules.dT, false) * 20) / 20));
    routing = { layer: doc.layer, trace: { id: newId('t'), net: s.net || '', layer: doc.layer, w: doc.width, pts: [s.p] } };
  }
  function finishRoute() {
    if (!routing) return;
    const t = routing.trace;
    if (t.pts.length >= 2) doc.traces.push(t);
    else undoStack.pop();
    routing = null;
    changed();
  }
  function routeClick(wp) {
    const s = snapRoute(wp);
    if (!routing) { startRoute(s); render(); return; }
    const t = routing.trace;
    const last = t.pts[t.pts.length - 1];
    if (s.p[0] === last[0] && s.p[1] === last[1]) { finishRoute(); return; }
    for (const p of route45(last, s.p)) t.pts.push(p);
    if (!t.net && s.net) t.net = s.net;
    // Landing on copper ends this trace.
    if (s.pad || s.via || s.trace) finishRoute();
    else render();
  }
  function routeVia() {
    if (!routing) return;
    const t = routing.trace;
    const at = t.pts[t.pts.length - 1];
    const net = t.net;
    if (t.pts.length >= 2) doc.traces.push(t);
    doc.vias.push({ id: newId('v'), x: at[0], y: at[1], dia: doc.rules.via, drill: doc.rules.viaDrill, net });
    const nl = doc.layer === 'top' ? 'bottom' : 'top';
    setLayerQuiet(nl);
    routing = { layer: nl, trace: { id: newId('t'), net, layer: nl, w: doc.width, pts: [at.slice()] } };
    save(); computeConn(); runDrc(); render();
  }
  function setLayerQuiet(l) { doc.layer = l; root.querySelectorAll('.td-layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === l)); }
  function deleteSel() {
    if (!sel) return;
    pushUndo();
    if (sel.kind === 'trace') doc.traces = doc.traces.filter(t => t.id !== sel.id);
    if (sel.kind === 'via') doc.vias = doc.vias.filter(v => v.id !== sel.id);
    if (sel.kind === 'fp') doc.fps = doc.fps.filter(f => f.id !== sel.id);
    sel = null;
    changed();
  }
  function rotateSel() {
    const fp = sel && sel.kind === 'fp' && doc.fps.find(f => f.id === sel.id);
    if (!fp) return;
    pushUndo();
    fp.rot = (fp.rot + 1) % 4;
    changed();
  }
  function addFootprint(lib, at) {
    pushUndo();
    const L = FOOTPRINTS[lib];
    const pre = lib === 'TP' ? 'TP' : lib === 'HDR_1x2' ? 'J' : lib.startsWith('DIP') || lib.startsWith('SOIC') ? 'U' : lib.includes('AXIAL_300') || lib === 'SOD123' ? 'D' : lib === 'RADIAL_5' ? 'C' : lib === 'LED_5MM' ? 'LED' : 'R';
    let n = 1; while (doc.fps.some(f => f.ref === pre + n)) n++;
    const fp = { id: newId('f'), ref: pre + n, lib, value: '', x: at[0], y: at[1], rot: 0, pads: L.pads.map(p => ({ ...p, net: '' })) };
    doc.fps.push(fp);
    sel = { kind: 'fp', id: fp.id };
    changed();
  }

  function onPointerDown(ev) {
    if (ev.button === 1 || (ev.button === 0 && ev.altKey)) { startPan(ev); return; }
    if (ev.button !== 0) return;
    const wp = toWorld(ev);
    if (tool === 'route') { routeClick(wp); return; }
    if (tool === 'via') {
      pushUndo();
      const s = snapRoute(wp);
      doc.vias.push({ id: newId('v'), x: s.p[0], y: s.p[1], dia: doc.rules.via, drill: doc.rules.viaDrill, net: s.net || '' });
      changed(); return;
    }
    if (tool === 'pad') { addFootprint('TP', snapGrid(wp)); return; }
    const hit = hitTest(wp);
    sel = hit;
    if (rightTab !== 'board' && hit) rightTab = 'board';
    if (!hit) { render(); renderSide(); startPan(ev); return; }
    if (hit.kind === 'fp') {
      const fp = doc.fps.find(f => f.id === hit.id);
      // Traces ending on this footprint's pads follow it (rubber-band their end points).
      const ends = [];
      for (const p of padsOf(fp)) for (const t of doc.traces) [0, t.pts.length - 1].forEach(i => { if (inPad(p, t.pts[i], 0.01)) ends.push({ t, i, dx: t.pts[i][0] - fp.x, dy: t.pts[i][1] - fp.y }); });
      drag = { fp, start: snapGrid(wp), orig: [fp.x, fp.y], ends, moved: false, snapshot: JSON.stringify(doc) };
      try { svg.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic or already-released pointer */ }
    }
    render(); renderSide();
  }
  function startPan(ev) { pan = { cx: ev.clientX, cy: ev.clientY, vx: view.x, vy: view.y }; try { svg.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic pointer */ } svg.classList.add('panning'); }
  function onPointerMove(ev) {
    if (pan) { view.x = pan.vx - (ev.clientX - pan.cx) / view.scale; view.y = pan.vy - (ev.clientY - pan.cy) / view.scale; render(); return; }
    const wp = toWorld(ev);
    cursor = tool === 'route' || tool === 'via' ? snapRoute(wp).p : snapGrid(wp);
    if (drag) {
      const sp = snapGrid(wp);
      const dx = sp[0] - drag.start[0], dy = sp[1] - drag.start[1];
      if (!dx && !dy && !drag.moved) return;
      drag.moved = true;
      drag.fp.x = r3(drag.orig[0] + dx); drag.fp.y = r3(drag.orig[1] + dy);
      for (const e of drag.ends) e.t.pts[e.i] = [r3(drag.fp.x + e.dx), r3(drag.fp.y + e.dy)];
      computeConn();
      render();
      return;
    }
    const h = tool === 'select' ? hitTest(wp) : null;
    if (JSON.stringify(h) !== JSON.stringify(hover)) hover = h;
    render();
  }
  function onPointerUp() {
    if (pan) { pan = null; svg.classList.remove('panning'); return; }
    if (drag) {
      if (drag.moved) { undoStack.push(drag.snapshot); redoStack = []; drag = null; changed(); } else drag = null;
    }
  }
  function onContextMenu(ev) {
    ev.preventDefault();
    if (routing) { finishRoute(); return; }
    if (tool !== 'select') { setTool('select'); return; }
    const hit = hitTest(toWorld(ev));
    if (hit && hit.kind === 'fp') { sel = hit; rotateSel(); }
  }
  function onDblClick(ev) {
    if (routing) { finishRoute(); return; }
    if (tool !== 'select') return;
    // Double-click a pad = start routing from it.
    const pd = padAt(toWorld(ev));
    if (pd) { setTool('route'); if (!pd.layers.includes(doc.layer)) setLayer(pd.layers[0]); routeClick([pd.x, pd.y]); }
  }
  function onWheel(ev) {
    ev.preventDefault();
    const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const wx = view.x + mx / view.scale, wy = view.y + my / view.scale;
    view.scale = Math.max(2, Math.min(200, view.scale * Math.exp(-ev.deltaY * 0.0015)));
    view.x = wx - mx / view.scale; view.y = wy - my / view.scale;
    render();
  }
  function fitView() {
    if (!svg) return;
    const W = svg.clientWidth || 800, H = svg.clientHeight || 500, B = doc.board;
    view.scale = Math.max(2, Math.min(W / (B.w + 10), H / (B.h + 10)));
    view.x = B.w / 2 - W / view.scale / 2; view.y = B.h / 2 - H / view.scale / 2;
    render();
  }
  function onKey(ev) {
    if (!root || !root.offsetParent) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); if (routing) { routing = null; undoStack.pop(); render(); } else (ev.shiftKey ? redo() : undo()); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); redo(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (k === 'escape') { if (routing) finishRoute(); else { setTool('select'); sel = null; renderSide(); } return; }
    if (k === 'delete' || k === 'backspace') { ev.preventDefault(); if (routing) { routing = null; undoStack.pop(); render(); } else deleteSel(); return; }
    if (k === 'x' || k === 't') { setTool('route'); return; }
    if (k === 'v') { if (routing) routeVia(); else setTool('via'); return; }
    if (k === 'l') { if (routing) { routeVia(); return; } setLayer(doc.layer === 'top' ? 'bottom' : 'top'); return; }
    if (k === '/') { flip45 = !flip45; render(); return; }
    if (k === '[' || k === ']') {
      const steps = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
      let i = steps.findIndex(s => s >= doc.width - 1e-9); if (i < 0) i = steps.length - 1;
      doc.width = steps[Math.max(0, Math.min(steps.length - 1, i + (k === ']' ? 1 : -1)))];
      if (routing) routing.trace.w = doc.width;
      save(); syncToolbar(); render(); return;
    }
    if (k === 'r' || k === ' ') { ev.preventDefault(); rotateSel(); return; }
    if (k === 'f') { fitView(); return; }
    if (k === 's' && !routing) { setTool('select'); return; }
  }

  // ---- export: Gerber RS-274X + Excellon --------------------------------------------------
  function gerberFiles(base) {
    const B = doc.board, H = B.h;
    const cx = (v) => Math.round(v * 1e6), cy = (v) => Math.round((H - v) * 1e6);
    const XY = (p) => `X${cx(p[0])}Y${cy(p[1])}`;
    const header = (fn, polarity = 'Positive') => [
      `G04 EngOrg Trace Designer - ${fn}*`, `%TF.GenerationSoftware,EngOrg,TraceDesigner,1*%`, `%TF.FileFunction,${fn}*%`, `%TF.FilePolarity,${polarity}*%`,
      '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', 'G01*', 'G75*'];
    const pads = conn.pads;
    function layerFile(fn, layer, opts = {}) {
      const ap = new Map(); let next = 10;
      const apOf = (def) => { if (!ap.has(def)) ap.set(def, next++); return ap.get(def); };
      const body = [];
      const grow = opts.expand || 0;
      let curAp = null;
      const sel = (d) => { if (d !== curAp) { body.push(`D${d}*`); curAp = d; } };
      if (!opts.padsOnly) {
        for (const t of doc.traces) {
          if (t.layer !== layer) continue;
          sel(apOf(`C,${t.w.toFixed(4)}`));
          body.push(XY(t.pts[0]) + 'D02*');
          for (let i = 1; i < t.pts.length; i++) body.push(XY(t.pts[i]) + 'D01*');
        }
      }
      for (const p of pads) {
        if (!p.layers.includes(layer)) continue;
        const w = p.w + 2 * grow, h = p.h + 2 * grow;
        sel(apOf(p.shape === 'round' ? `C,${w.toFixed(4)}` : `R,${w.toFixed(4)}X${h.toFixed(4)}`));
        body.push(XY([p.x, p.y]) + 'D03*');
      }
      for (const v of doc.vias) {
        if (opts.tentVias) continue;
        sel(apOf(`C,${(v.dia + 2 * grow).toFixed(4)}`));
        body.push(XY([v.x, v.y]) + 'D03*');
      }
      const apLines = [...ap.entries()].map(([def, d]) => `%ADD${d}${def}*%`);
      return [...header(fn, opts.negative ? 'Negative' : 'Positive'), ...apLines, ...body, 'M02*'].join('\n');
    }
    function outlineFile() {
      return [...header('Profile,NP'), '%ADD10C,0.1000*%', 'D10*', XY([0, 0]) + 'D02*', XY([B.w, 0]) + 'D01*', XY([B.w, B.h]) + 'D01*', XY([0, B.h]) + 'D01*', XY([0, 0]) + 'D01*', 'M02*'].join('\n');
    }
    function silkFile() {
      const body = ['%ADD10C,0.1500*%', 'D10*'];
      const line = (a, b) => { body.push(XY(a) + 'D02*', XY(b) + 'D01*'); };
      for (const fp of doc.fps) {
        const lib = FOOTPRINTS[fp.lib] || {};
        const T = (p) => { const [dx, dy] = rot(p, fp.rot); return [fp.x + dx, fp.y + dy]; };
        if (lib.outline) {
          const [x0, y0, x1, y1] = lib.outline;
          const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(T);
          for (let i = 0; i < 4; i++) line(c[i], c[(i + 1) % 4]);
          if (lib.band) line(T([lib.band, y0]), T([lib.band, y1]));
        }
        if (lib.circle) {
          const n = 36, pts = [];
          for (let i = 0; i <= n; i++) pts.push(T([lib.circle * Math.cos(i / n * 2 * Math.PI), lib.circle * Math.sin(i / n * 2 * Math.PI)]));
          for (let i = 1; i < pts.length; i++) line(pts[i - 1], pts[i]);
        }
      }
      return [...header('Legend,Top'), ...body, 'M02*'].join('\n');
    }
    function drillFile() {
      const holes = [];
      for (const p of pads) if (p.drill > 0) holes.push({ d: p.drill, x: p.x, y: p.y });
      for (const v of doc.vias) holes.push({ d: v.drill, x: v.x, y: v.y });
      const sizes = [...new Set(holes.map(h => h.d.toFixed(3)))].sort((a, b) => a - b);
      const lines = ['M48', '; DRILL file - EngOrg Trace Designer', 'FMAT,2', 'METRIC,TZ'];
      sizes.forEach((s, i) => lines.push(`T${i + 1}C${s}`));
      lines.push('%', 'G90', 'G05');
      sizes.forEach((s, i) => {
        lines.push(`T${i + 1}`);
        for (const h of holes) if (h.d.toFixed(3) === s) lines.push(`X${h.x.toFixed(3)}Y${(H - h.y).toFixed(3)}`);
      });
      lines.push('T0', 'M30');
      return lines.join('\n');
    }
    const mask = 0.05;
    return [
      { name: `${base}-F_Cu.gtl`, text: layerFile('Copper,L1,Top', 'top') },
      { name: `${base}-B_Cu.gbl`, text: layerFile('Copper,L2,Bot', 'bottom') },
      { name: `${base}-F_Mask.gts`, text: layerFile('Soldermask,Top', 'top', { padsOnly: true, expand: mask, negative: true, tentVias: true }) },
      { name: `${base}-B_Mask.gbs`, text: layerFile('Soldermask,Bot', 'bottom', { padsOnly: true, expand: mask, negative: true, tentVias: true }) },
      { name: `${base}-F_Silkscreen.gto`, text: silkFile() },
      { name: `${base}-Edge_Cuts.gm1`, text: outlineFile() },
      { name: `${base}.drl`, text: drillFile() },
    ];
  }
  async function exportGerbers() {
    computeConn(); runDrc();
    if (drc.length || conn.rats.length) {
      const msg = `${drc.length ? drc.length + ' DRC violation(s)' : ''}${drc.length && conn.rats.length ? ' and ' : ''}${conn.rats.length ? conn.rats.length + ' unrouted connection(s)' : ''}. Export anyway?`;
      const ok = window._showConfirm ? await window._showConfirm({ title: 'Board not finished', message: msg, confirmText: 'Export anyway' }) : true;
      if (!ok) return;
    }
    const r = await window.api.circuitLab.saveFolder(gerberFiles('board'), 'board-gerbers');
    if (r && r.error) setStatus('Export failed: ' + r.error);
    else if (r && r.dir) setStatus(`Wrote ${r.count} files to ${r.dir}`);
  }
  function exportSvg() {
    const B = doc.board;
    const world = svg.querySelector('.td-world').innerHTML;
    const css = `.td-board{fill:#1d4a37}.td-trace{fill:none;stroke-linecap:round;stroke-linejoin:round}.td-top .td-trace{stroke:#c8463c}.td-bottom .td-trace{stroke:#4a72d0;opacity:.75}
      .td-pad{fill:#cfa648}.td-via{fill:#b8b8b8}.td-drill{fill:#10251c}.td-silk{fill:none;stroke:#e6e6e6;stroke-width:.15}.td-ref{fill:#e6e6e6;font:1px sans-serif}.td-rat,.td-drc,.td-cursor{display:none}`;
    const text = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${B.w + 4} ${B.h + 4}" width="${(B.w + 4) * 4}mm" height="${(B.h + 4) * 4}mm"><style>${css}</style>${world.replace(/url\(#td-grid\)/g, 'none')}</svg>`;
    window.api.circuitLab.saveText(text, 'board.svg');
  }
  async function saveFile() {
    const r = await window.api.circuitLab.saveText(JSON.stringify({ engorgBoard: 1, ...doc }, null, 1), 'board.board.json');
    if (r && r.error) setStatus('Save failed: ' + r.error);
  }
  async function openFile() {
    const r = await window.api.circuitLab.openText([{ name: 'Board', extensions: ['json'] }]);
    if (!r || r.canceled) return;
    if (r.error) { setStatus('Open failed: ' + r.error); return; }
    try {
      const d = JSON.parse(r.text);
      if (!Array.isArray(d.fps)) throw new Error('not a Trace Designer board');
      pushUndo(); delete d.engorgBoard;
      doc = { ...emptyDoc(), ...d }; sel = null; routing = null;
      syncToolbar(); changed(); fitView();
    } catch (e) { setStatus('Open failed: ' + e.message); }
  }

  // ---- mount ------------------------------------------------------------------------------
  function syncToolbar() {
    if (!root) return;
    root.querySelector('#td-width').value = doc.width;
    setLayerQuiet(doc.layer);
  }
  function build(container) {
    container.innerHTML = `
      <div class="clab td">
        <div class="clab-toolbar">
          <button class="kicad-btn kicad-btn-outline" data-cmd="new">New</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="open">Open</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="save">Save</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="import" title="Pull the current Circuit Lab schematic in as footprints + nets">⬇ From Circuit Lab</button>
          <span class="clab-sep"></span>
          <button class="clab-tool td-tool" data-tool="select" title="Select / move (S, Esc)"><span class="td-ico">⬉</span><span>Select</span></button>
          <button class="clab-tool td-tool" data-tool="route" title="Route trace (X) — double-click a pad to start"><span class="td-ico">⟋</span><span>Route</span></button>
          <button class="clab-tool td-tool" data-tool="via" title="Via (V)"><span class="td-ico">◎</span><span>Via</span></button>
          <button class="clab-tool td-tool" data-tool="pad" title="Test pad"><span class="td-ico">●</span><span>Pad</span></button>
          <select id="td-addfp" class="kicad-input clab-sel" title="Add a footprint"><option value="">+ Footprint…</option>${Object.entries(FOOTPRINTS).map(([k, f]) => `<option value="${k}">${esc(f.name)}</option>`).join('')}</select>
          <span class="clab-sep"></span>
          <button class="td-layer-btn td-top" data-layer="top" title="Top copper (L toggles)">F.Cu</button>
          <button class="td-layer-btn td-bottom" data-layer="bottom" title="Bottom copper (L toggles)">B.Cu</button>
          <label class="clab-chk">Width <input id="td-width" class="kicad-input clab-num" type="number" min="0.1" step="0.05"> mm</label>
          <span class="clab-spacer"></span>
          <button class="kicad-btn kicad-btn-start" data-cmd="autoroute" title="Route all unrouted connections">⚡ Autoroute</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="undo" title="Undo (Ctrl+Z)">↶</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="redo" title="Redo (Ctrl+Y)">↷</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="fit" title="Fit board (F)">⤢</button>
          <button class="kicad-btn kicad-btn-outline" data-cmd="svg" title="Export the board picture as SVG">SVG</button>
          <button class="kicad-btn kicad-btn-start" data-cmd="gerber" title="Export Gerber + drill files for fabrication">📦 Gerbers</button>
        </div>
        <div class="clab-main">
          <div class="clab-canvas-col">
            <div class="clab-canvas td-canvas">
              <svg class="clab-svg" xmlns="http://www.w3.org/2000/svg">
                <defs><pattern id="td-grid" width="2.54" height="2.54" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r=".08" class="td-grid-dot"/></pattern></defs>
                <g class="td-world"></g>
              </svg>
            </div>
            <div class="td-status"></div>
          </div>
          <div class="clab-side">
            <div class="clab-side-tabs"><button class="clab-side-tab td-side-tab" data-tab="board">Inspect</button><button class="clab-side-tab td-side-tab" data-tab="calc">Calculator</button><button class="clab-side-tab td-side-tab" data-tab="drc">DRC</button></div>
            <div class="clab-side-body td-side-body"></div>
          </div>
        </div>
      </div>`;
    root = container.querySelector('.td');
    svg = root.querySelector('.clab-svg');
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('contextmenu', onContextMenu);
    svg.addEventListener('dblclick', onDblClick);
    svg.addEventListener('wheel', onWheel, { passive: false });
    root.querySelectorAll('.td-tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    root.querySelectorAll('.td-layer-btn').forEach(b => b.addEventListener('click', () => setLayer(b.dataset.layer)));
    root.querySelector('#td-width').addEventListener('change', (e) => { const n = parseFloat(e.target.value); if (n > 0) { doc.width = n; save(); render(); } });
    root.querySelector('#td-addfp').addEventListener('change', (e) => {
      const v = e.target.value; e.target.value = '';
      if (!v) return;
      const W = svg.clientWidth, H = svg.clientHeight;
      addFootprint(v, snapGrid([view.x + W / view.scale / 2, view.y + H / view.scale / 2]));
      setTool('select');
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      const c = b.dataset.cmd;
      if (c === 'undo') undo();
      if (c === 'redo') redo();
      if (c === 'fit') fitView();
      if (c === 'autoroute') autoroute();
      if (c === 'gerber') exportGerbers();
      if (c === 'svg') exportSvg();
      if (c === 'save') saveFile();
      if (c === 'open') openFile();
      if (c === 'import') {
        if (typeof circuitLab === 'undefined') return;
        const nl = circuitLab.exportNetlist();
        if (nl.error) setStatus('Circuit Lab: ' + nl.error); else importNetlist(nl);
      }
      if (c === 'new') {
        const reset = () => { pushUndo(); doc = emptyDoc(); sel = null; routing = null; syncToolbar(); changed(); fitView(); };
        if (window._showConfirm) window._showConfirm({ title: 'New board', message: 'Clear the board? (Undo can bring it back.)', confirmText: 'Clear', danger: true }).then(ok => { if (ok) reset(); });
        else reset();
      }
    });
    bindSide();
    new ResizeObserver(() => render()).observe(root.querySelector('.td-canvas'));
  }

  return {
    mount(container) {
      if (mounted || !container) return;
      mounted = true;
      ensureDoc();
      build(container);
      syncToolbar();
      setTool('select');
      changed();
      requestAnimationFrame(fitView);
    },
    activate() {
      document.addEventListener('keydown', onKey);
      requestAnimationFrame(render);
    },
    deactivate() { if (routing) finishRoute(); document.removeEventListener('keydown', onKey); },
    importNetlist,
    // exposed for tests / other utilities
    _calc: { ampacity, widthFor, tempRise, resistance, microstripZ0, striplineZ0 },
  };
})();
