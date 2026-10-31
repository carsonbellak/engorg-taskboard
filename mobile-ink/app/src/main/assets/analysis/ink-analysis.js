// EngInk drawing analysis — reads the class symbols and wires on a notebook page and analyses
// them with deterministic geometry + the desktop's verified solvers (no AI, no recognition model).
//
// The Kotlin side (AnalysisHost) sends one page as plain geometry:
//   { symbols: [{ i, sym, inline, terms?, half?, box?, w, h, rot, pivot, props }],
//     wires:   [{ i, kind: 'line' | 'arrow' | 'ink', pts: [[x, y], …] }] }      (page units, y down)
// INLINE symbols give their two terminals; BOX symbols give their unrotated box [l, t, r, b],
// standard size w×h and rotation (deg, about pivot), so local symbol coordinates (Symbols.kt)
// can be mapped onto the page. `i` is the record's index on the page.
//
// Connectivity: a wire joins a terminal when one of its ends lands within TOL of it (or the
// terminal sits on the wire); wires join when an end touches another wire (T / L junctions);
// plain crossings don't connect unless a Node dot sits on them. Freehand ink only counts as a wire
// when it's long and nearly straight, so handwriting next to a part is ignored.
//
// WIRE symbols are turned into plain wires before anything runs.
// Circuits → CircuitEngine (DC operating point + phasors at the AC source frequency; AC voltage and
// current sources). Vn+ / Vn− probe symbols read Vn = V(+) − V(−) wherever their tips touch.
// Thermo flow devices are walked inlet → outlet (flow runs left → right through each symbol, as
// drawn in Symbols.kt) to find the cycle, which is classified (Rankine ± reheat, Brayton, vapor-
// compression) and solved with ThermoEngine, states numbered as in Moran & Shapiro. Hot / cold
// reservoir symbols linked by lines supply T_H / T_C to cycles and heat-engine diagrams. Heat engine /
// refrigerator symbols get the reservoir (second-law) analysis.
// A last pass (placeAll) picks value-label spots and nudges result chips off wires, symbols and each other.
//
// Output: { analyses: [{ title, blocks }], annots: [...], comps: { [i]: { name, title, label, fields, anchor?, labelAt? } } }
// — blocks are rendered generically by AnalysisPanel; annots are drawn over the page by
// FinishedStrokesView; comps drive the tap-to-edit value sheet (fields carry keypad + unit buttons).

const InkAnalysis = (() => {
  const CE = CircuitEngine, TE = ThermoEngine;
  const TOL = 10;

  // ---- geometry ------------------------------------------------------------------------------
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function polyDist(p, pts) {
    if (pts.length === 1) return dist(p, pts[0]);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1], pts[i]));
    return d;
  }
  function polyLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    let idx = -1, dmax = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
    const a = rdp(pts.slice(0, idx + 1), eps), b = rdp(pts.slice(idx), eps);
    return a.slice(0, -1).concat(b);
  }
  // Freehand ink is a wire if it's long and made of a few straight runs (handwriting isn't).
  function wireLike(pts) {
    if (pts.length < 2) return null;
    const len = polyLen(pts);
    if (len < 26) return null;
    const simple = rdp(pts, 3.5);
    if (simple.length > 7) return null;
    // Every run should be a real segment, not a squiggle collapsed by RDP.
    if (polyLen(simple) < 0.85 * len) return null;
    return simple;
  }
  function midpointOf(pts) {
    const L = polyLen(pts);
    if (!(L > 0)) return pts[0];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = dist(pts[i - 1], pts[i]);
      if (acc + d >= L / 2) { const t = (L / 2 - acc) / (d || 1); return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]; }
      acc += d;
    }
    return pts[pts.length - 1];
  }
  // BOX symbol local ↔ page (Symbols.parts maps local (x, y) to the box, then ShapeSpec rotates).
  function boxMap(s) {
    const [l, t, r, b] = s.box;
    const cx = (l + r) / 2, cy = (t + b) / 2, sx = (r - l) / s.w || 1, sy = (b - t) / s.h || 1;
    const a = (s.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    const pv = s.pivot || [cx, cy];
    return {
      cx, cy, sx, sy,
      toPage: ([x, y]) => {
        const px = cx + x * sx, py = cy + y * sy, dx = px - pv[0], dy = py - pv[1];
        return [pv[0] + dx * c - dy * sn, pv[1] + dx * sn + dy * c];
      },
      toLocal: ([X, Y]) => {
        const dx = X - pv[0], dy = Y - pv[1];
        const px = pv[0] + dx * c + dy * sn, py = pv[1] - dx * sn + dy * c;
        return [(px - cx) / sx, (py - cy) / sy];
      },
    };
  }
  function centerOf(s) { return s.inline ? [(s.terms[0][0] + s.terms[1][0]) / 2, (s.terms[0][1] + s.terms[1][1]) / 2] : boxMap(s).toPage([0, 0]); }
  // The side of an inline part the value label sits on (FinishedStrokesView): above a horizontal
  // part, right of a vertical one. Analysis chips go on the other side.
  function labelSide(s) {
    const [a, b] = s.terms, L = dist(a, b) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    let nx = -uy, ny = ux;
    if (!(ny < -0.3 || (Math.abs(ny) <= 0.3 && nx > 0))) { nx = -nx; ny = -ny; }
    return [nx, ny];
  }
  function chipSpot(s, other) {
    const c = centerOf(s);
    if (s.inline) {
      const [nx, ny] = labelSide(s), k = other ? -1 : 1, off = (s.half || 10) + 15;
      return [c[0] + k * nx * off, c[1] + k * ny * off];
    }
    const m = boxMap(s);
    const p = m.toPage([0, s.h / 2]);
    return [p[0], p[1] + 14];
  }
  // Oriented rectangle { c, u, v, hu, hv } around a symbol's body (inline: the terminal span, ±half;
  // box: the rotated box), grown by pad. Used for reservoir links and label placement.
  function obbOf(s, pad = 0) {
    if (s.inline) {
      const [a, b] = s.terms, L = dist(a, b) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      return { c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u, v: [-u[1], u[0]], hu: L / 2 + pad, hv: Math.max(s.half || 8, 4) + pad };
    }
    const ang = (s.rot || 0) * Math.PI / 180, u = [Math.cos(ang), Math.sin(ang)];
    return { c: boxMap(s).toPage([0, 0]), u, v: [-u[1], u[0]], hu: Math.abs(s.box[2] - s.box[0]) / 2 + pad, hv: Math.abs(s.box[3] - s.box[1]) / 2 + pad };
  }
  const toObb = (o, p) => { const dx = p[0] - o.c[0], dy = p[1] - o.c[1]; return [dx * o.u[0] + dy * o.u[1], dx * o.v[0] + dy * o.v[1]]; };
  function inObb(p, o) { const [x, y] = toObb(o, p); return Math.abs(x) <= o.hu && Math.abs(y) <= o.hv; }
  // Length of segment a–b inside the oriented rect (Liang–Barsky), or −1 if it misses.
  function segClipLen(a, b, o) {
    const [ax, ay] = toObb(o, a), [bx, by] = toObb(o, b), dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (clip(-dx, ax + o.hu) && clip(dx, o.hu - ax) && clip(-dy, ay + o.hv) && clip(dy, o.hv - ay)) return (t1 - t0) * Math.hypot(dx, dy);
    return -1;
  }
  // Separating-axis test between two oriented rects.
  function obbOverlap(A, B) {
    const d = [B.c[0] - A.c[0], B.c[1] - A.c[1]];
    const rad = (O, ax) => O.hu * Math.abs(O.u[0] * ax[0] + O.u[1] * ax[1]) + O.hv * Math.abs(O.v[0] * ax[0] + O.v[1] * ax[1]);
    for (const ax of [A.u, A.v, B.u, B.v]) if (Math.abs(d[0] * ax[0] + d[1] * ax[1]) > rad(A, ax) + rad(B, ax)) return false;
    return true;
  }
  function touchesSym(pts, s, pad) {
    const o = obbOf(s, pad);
    if (pts.length === 1) return inObb(pts[0], o);
    for (let k = 1; k < pts.length; k++) if (segClipLen(pts[k - 1], pts[k], o) >= 0) return true;
    return false;
  }

  // ---- union-find --------------------------------------------------------------------------------
  function UF() {
    const parent = new Map();
    const find = (k) => { if (!parent.has(k)) parent.set(k, k); let r = k; while (parent.get(r) !== r) r = parent.get(r); let c = k; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
    return { find, union: (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); } };
  }

  // ---- value parsing --------------------------------------------------------------------------------
  const blank = (v) => v == null || String(v).trim() === '';
  function num(v) { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : NaN; }
  // dims: T (→ K, default °C), dT (K), p (→ kPa, default kPa), pct (→ fraction), P (→ kW), E (→ kJ), n (plain)
  function qty(v, dim) {
    if (blank(v)) return null;
    const s = String(v).trim().toLowerCase().replace(/\s+/g, '');
    const n = num(s);
    if (!isFinite(n)) return NaN;
    const unit = s.replace(/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/, '');
    switch (dim) {
      case 'T': return /^k$/.test(unit) ? n : /^(°?f|degf)$/.test(unit) ? (n - 32) * 5 / 9 + 273.15 : n + 273.15;
      case 'dT': return /f/.test(unit) ? n * 5 / 9 : n;
      case 'p': return unit === 'mpa' ? n * 1000 : unit === 'bar' ? n * 100 : unit === 'pa' ? n / 1000 : unit === 'atm' ? n * 101.325 : unit === 'psi' || unit === 'psia' ? n * 6.894757 : unit === 'gpa' ? n * 1e6 : n;
      case 'pct': return unit === '%' ? n / 100 : n > 1 ? n / 100 : n;
      case 'P': return unit === 'w' ? n / 1000 : unit === 'mw' ? n * 1000 : /^(ton|tons|tr)$/.test(unit) ? n * 3.5168525 : unit === 'hp' ? n * 0.745699872 : n;
      case 'E': return unit === 'j' ? n / 1000 : unit === 'mj' ? n * 1000 : n;
      default: return n;
    }
  }
  const fT = (K) => (K == null || !isFinite(K) ? '—' : (K - 273.15).toFixed(1) + ' °C');
  const fp = (kPa) => (kPa == null || !isFinite(kPa) ? '—' : kPa >= 1000 ? +(kPa / 1000).toPrecision(4) + ' MPa' : +kPa.toPrecision(4) + ' kPa');
  const fx = (v, d) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d));
  const fpct = (v) => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1) + '%');
  const fpow = (kW) => (kW == null || !isFinite(kW) ? '—' : Math.abs(kW) >= 1000 ? (kW / 1000).toFixed(2) + ' MW' : Math.abs(kW) >= 10 ? kW.toFixed(1) + ' kW' : kW.toFixed(3) + ' kW');
  const si = (v, u) => CE.fmtSI(v, u);
  // SI value with an optional typed unit suffix. The keypad appends the unit ("1F", "10mA"), and
  // parseSI would read a bare "F" as femto, so the unit is stripped first.
  function siVal(v, u) {
    if (typeof v === 'number') return v;
    let s = String(v == null ? '' : v).trim();
    if (u) s = s.replace(new RegExp('\\s*' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
    s = s.replace(/\s*(ohms?|Ω)$/i, '');
    // A fraction: "1/2" = 0.5; a prefix after it scales the whole thing ("1/2k" = 500).
    const fr = s.match(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*\/\s*([\d.]+(?:e[-+]?\d+)?)\s*(.*)$/i);
    if (fr) return parseFloat(fr[1]) / parseFloat(fr[2]) * CE.parseSI('1' + fr[3]);
    return CE.parseSI(s);
  }
  // A value written in circuit variables ("2ix", "1/2 Vx", "Vx/2", "2ix − 3Vy"): [{ k, name }], or
  // null when it's a plain number. Variable names start with i or v and run at least two characters,
  // so "5 V" and "10 mV" stay numbers. A value that mixes in anything else comes back with bad: true.
  function varExpr(v) {
    if (blank(v) || typeof v === 'number') return null;
    const s = String(v).replace(/[()*·\s]/g, '').replace(/−/g, '-');
    if (!/(^|[\d.\/+\-pnuµmkMG])[iIvV][A-Za-z0-9_]/.test(s)) return null;
    const terms = [];
    const re = /([-+]?)((?:[\d.]+(?:e[-+]?\d+)?)(?:\/[\d.]+)?)?([pnuµmkMG])?([iIvV][A-Za-z0-9_]+)(?:\/([\d.]+))?/y;
    let at = 0;
    while (at < s.length) {
      re.lastIndex = at;
      const m = re.exec(s);
      if (!m || (!m[1] && at > 0)) { terms.bad = true; break; }
      let k = m[2] ? siVal(m[2] + (m[3] || '')) : m[3] ? NaN : 1;
      if (m[5]) k /= parseFloat(m[5]);
      if (!isFinite(k)) { terms.bad = true; break; }
      terms.push({ k: m[1] === '-' ? -k : k, name: m[4] });
      at = re.lastIndex;
    }
    return terms;
  }
  // The variables a part names ("ix", "Vx, ix", "-ix" = the opposite way round): [{ name, sign }].
  function partVars(p) {
    return String((p && p.vars) || '').split(/[,;\s]+/).filter(Boolean).map(t => {
      const m = t.replace(/−/g, '-').match(/^([-+]?)([iIvV][A-Za-z0-9_]*)$/);
      return m ? { name: m[2], sign: m[1] === '-' ? -1 : 1 } : null;
    }).filter(Boolean);
  }

  // ---- value fields (contract §3: keypad + unit buttons for every field) ------------------------------
  const UNIT_SPEC = {
    'Ω': ['si', ['Ω']], F: ['si', ['F']], H: ['si', ['H']], V: ['si', ['V']], A: ['si', ['A']], Hz: ['si', ['Hz']],
    '°': ['num', ['°']], kPa: ['num', ['kPa', 'MPa', 'bar']], '°C': ['num', ['°C', 'K']], '%': ['num', ['%']],
    MW: ['num', ['MW', 'kW']], kW: ['num', ['kW', 'MW']], kJ: ['num', ['kJ', 'MJ']], 'kg/s': ['num', ['kg/s']], 'm/s': ['num', ['m/s']],
    kg: ['num', ['kg']], N: ['num', ['N', 'kN']], m: ['num', ['m']],
  };
  function fieldSpec(unit, extra) {
    if (extra && extra.options) return {};          // chip picker, no keypad
    const sp = UNIT_SPEC[unit];
    return sp ? { keypad: sp[0], units: sp[1].slice() } : unit ? { keypad: 'num', units: [] } : { keypad: 'text', units: [] };
  }
  // Field factory bound to a symbol's props: f(key, label, unit, ph, extra) — extra overrides keypad/units.
  const fld = (p) => (key, label, unit, ph, extra = {}) => ({ key, label, unit, ph, value: p[key] == null ? '' : String(p[key]), ...fieldSpec(unit, extra), ...extra });

  // ---- symbol catalogue ----------------------------------------------------------------------------
  const ECE = new Set(['RESISTOR', 'RESISTOR_BOX', 'CAPACITOR', 'CAP_POLAR', 'INDUCTOR', 'VSOURCE', 'ISOURCE', 'VSOURCE_AC', 'ISOURCE_AC', 'VSOURCE_DEP', 'ISOURCE_DEP', 'BATTERY', 'DIODE', 'LED', 'SWITCH', 'AMMETER', 'VOLTMETER', 'GROUND', 'OPAMP', 'NODE', 'PROBE_POS', 'PROBE_NEG']);
  const PROBES = new Set(['PROBE_POS', 'PROBE_NEG']);
  const FLOW = new Set(['COMPRESSOR', 'TURBINE', 'PUMP', 'HEAT_EXCHANGER', 'VALVE', 'NOZZLE', 'DIFFUSER']);
  const RES = new Set(['HEAT_ENGINE', 'REFRIGERATOR']);
  const HEATRES = new Set(['HOT_RESERVOIR', 'COLD_RESERVOIR']);
  const DIRECTIONAL = new Set(['COMPRESSOR', 'TURBINE', 'PUMP', 'NOZZLE', 'DIFFUSER']);
  // Probe contact point = the tip of the stem, local (0, 14).
  const BOX_PINS = { GROUND: [[0, -12]], OPAMP: [[-48, -32], [-48, 32], [48, 0]], NODE: [[0, 0]], PROBE_POS: [[0, 14]], PROBE_NEG: [[0, 14]] };
  const DIODE_MODELS = { '1N4148': { is: '2.52n', n: '1.752', rs: '0.568' }, '1N4007': { is: '14.11n', n: '1.984', rs: '33.89m' }, '1N5819': { is: '31.7u', n: '1.373', rs: '51m' } };

  // =========================================================================================
  // CIRCUITS
  // =========================================================================================
  const CIRCUIT_INFO = {
    RESISTOR: ['R', 'Resistor'], RESISTOR_BOX: ['R', 'Resistor'], CAPACITOR: ['C', 'Capacitor'], CAP_POLAR: ['C', 'Capacitor'],
    INDUCTOR: ['L', 'Inductor'], VSOURCE: ['V', 'Voltage source'], BATTERY: ['V', 'Battery'], VSOURCE_AC: ['V', 'AC source'],
    ISOURCE: ['I', 'Current source'], ISOURCE_AC: ['I', 'AC current source'], DIODE: ['D', 'Diode'], LED: ['LED', 'LED'], SWITCH: ['S', 'Switch'],
    AMMETER: ['AM', 'Ammeter'], VOLTMETER: ['VM', 'Voltmeter'], OPAMP: ['U', 'Op-amp'],
    VSOURCE_DEP: ['E', 'Dependent voltage source'], ISOURCE_DEP: ['G', 'Dependent current source'],
  };
  const probeNum = (s) => { const n = Math.round(num((s.props || {}).n)); return n > 0 ? n : 1; };
  const probeName = (s) => 'V' + probeNum(s) + (s.sym === 'PROBE_POS' ? '+' : '−');
  // The page's circuit variables (variable keys on the source keypads), set at the start of circuit().
  let PAGE_VARS = [];
  function circuitFields(s) {
    const p = s.props || {};
    const f = fld(p);
    const nm = f('name', 'Name', '', '');
    // Names this part's voltage or current so a source elsewhere can depend on it.
    const vr = f('vars', 'Variable here', '', 'ix or Vx', { keypad: 'text', hint: 'Vx: + at the first end. ix: first end → second. Use -ix for the other way.' });
    const src = (hint) => ({ vars: PAGE_VARS.slice(), hint });
    switch (s.sym) {
      case 'RESISTOR': case 'RESISTOR_BOX': return [f('value', 'Resistance', 'Ω', '1k', { hint: 'e.g. 4.7k, 1meg, 1/2' }), vr, nm];
      case 'CAPACITOR': case 'CAP_POLAR': return [f('value', 'Capacitance', 'F', '1u', { hint: 'e.g. 100n, 10u, 1/4' }), vr, nm];
      case 'INDUCTOR': return [f('value', 'Inductance', 'H', '1m', { hint: 'e.g. 10m, 1/2' }), vr, nm];
      case 'VSOURCE': return [f('value', 'Voltage', 'V', '5', src('+ is at the end you dragged to. A variable makes it dependent: 2ix')), vr, nm];
      case 'BATTERY': return [f('value', 'Voltage', 'V', '9', src('')), vr, nm];
      case 'VSOURCE_DEP': return [f('value', 'Value', 'V', '2ix', { keypad: 'si', units: [], ...src('e.g. 2ix, 1/2 Vx. + is at the end you dragged to') }), vr, nm];
      case 'ISOURCE_DEP': return [f('value', 'Value', 'A', '2ix', { keypad: 'si', units: [], ...src('e.g. 2ix, 1/2 Vx. Flows the way the arrow points') }), vr, nm];
      case 'VSOURCE_AC': return [f('amp', 'Amplitude (peak)', 'V', '10'), f('freq', 'Frequency', 'Hz', '60'), f('phase', 'Phase', '°', '0'), vr, nm];
      case 'ISOURCE_AC': return [f('amp', 'Amplitude (peak)', 'A', '1m', { hint: 'flows the way the arrow points' }), f('freq', 'Frequency', 'Hz', '60'), f('phase', 'Phase', '°', '0'), vr, nm];
      case 'ISOURCE': return [f('value', 'Current', 'A', '1m', src('flows the way the arrow points. A variable makes it dependent: 2Vx')), vr, nm];
      case 'DIODE': return [f('model', 'Model', '', '1N4148', { options: ['1N4148', '1N4007', '1N5819'] }), vr, nm];
      case 'LED': return [f('color', 'Colour', '', 'red', { options: ['red', 'green', 'blue', 'yellow', 'white'] }), vr, nm];
      case 'SWITCH': return [f('state', 'Position', '', 'closed', { options: ['closed', 'open'] }), vr, nm];
      case 'OPAMP': return [f('vsat', 'Output limit ±', 'V', '15'), f('gain', 'Open-loop gain', '', '100k', { keypad: 'si' }), nm];
      case 'PROBE_POS': case 'PROBE_NEG': return [f('n', 'Probe number', '', '1', { keypad: 'num', hint: `V${probeNum(s)}+ pairs with V${probeNum(s)}− — reads V(+) − V(−), and 2V${probeNum(s)} works as a source value` })];
      case 'AMMETER': case 'VOLTMETER': return [vr, nm];
      default: return [nm];
    }
  }
  // A part's named variables as drawn beside it, showing their sense: "+Vx−", "ix→".
  function varLabel(s) {
    if (!s.inline) return '';
    const dx = s.terms[1][0] - s.terms[0][0], dy = s.terms[1][1] - s.terms[0][1], flat = Math.abs(dx) >= Math.abs(dy);
    return partVars(s.props).map(({ name, sign }) => {
      const fwd = (flat ? dx > 0 : dy > 0) === (sign > 0);
      if (/^v/i.test(name)) return fwd ? `+${name}−` : `−${name}+`;
      return flat ? (fwd ? `${name}→` : `←${name}`) : `${name}${fwd ? '↓' : '↑'}`;
    }).join(' ');
  }
  function circuitLabel(s) {
    const p = s.props || {}, v = (k, d) => (blank(p[k]) ? d : p[k]);
    const val = (k, u) => {
      if (blank(p[k])) return '';
      const typed = String(p[k]).trim();
      if (varExpr(typed)) return typed;
      const n = siVal(p[k], u);
      // A fraction stays a fraction on the page, as it's written in the problem.
      if (isFinite(n) && typed.includes('/')) return typed.replace(new RegExp('\\s*' + u + '$'), '') + ' ' + u;
      return isFinite(n) ? si(n, u) : p[k] + ' ' + u;
    };
    const acLabel = (u, defAmp) => (blank(p.amp) && blank(p.freq) ? '' : `${si(siVal(v('amp', defAmp), u), u)} ${si(siVal(v('freq', 60), 'Hz'), 'Hz')}` + (siVal(p.phase, '°') ? ` ∠${siVal(p.phase, '°')}°` : ''));
    switch (s.sym) {
      case 'RESISTOR': case 'RESISTOR_BOX': return val('value', 'Ω');
      case 'CAPACITOR': case 'CAP_POLAR': return val('value', 'F');
      case 'INDUCTOR': return val('value', 'H');
      case 'VSOURCE': case 'BATTERY': case 'VSOURCE_DEP': return val('value', 'V');
      case 'ISOURCE': case 'ISOURCE_DEP': return val('value', 'A');
      case 'VSOURCE_AC': return acLabel('V', 10);
      case 'ISOURCE_AC': return acLabel('A', '1m');
      case 'PROBE_POS': case 'PROBE_NEG': return probeName(s);
      case 'DIODE': return p.model || '';
      case 'LED': return p.color ? p.color + ' LED' : '';
      case 'SWITCH': return p.state === 'open' ? 'open' : '';
      default: return '';
    }
  }

  function circuit(syms, wires, out) {
    const parts = syms.filter(s => ECE.has(s.sym));
    if (!parts.length) return;
    PAGE_VARS = [...new Set(parts.flatMap(s => (PROBES.has(s.sym) ? (s.sym === 'PROBE_POS' ? ['V' + probeNum(s)] : []) : partVars(s.props).map(v => v.name))))];
    const real = parts.filter(s => s.sym !== 'GROUND' && s.sym !== 'NODE' && !PROBES.has(s.sym));
    const probes = parts.filter(s => PROBES.has(s.sym));
    // Terminals (a probe's contact point joins nets like a terminal but carries no current)
    const terms = [];
    for (const s of parts) {
      const pts = s.inline ? s.terms : BOX_PINS[s.sym] ? BOX_PINS[s.sym].map(boxMap(s).toPage) : [];
      pts.forEach((pt, k) => terms.push({ s, k, pt, node: s.sym === 'NODE', probe: PROBES.has(s.sym) }));
    }
    const uf = UF();
    const tk = (n) => 't' + n, wk = (n) => 'w' + n;
    terms.forEach((t, n) => uf.find(tk(n)));
    wires.forEach((w, n) => uf.find(wk(n)));
    for (let a = 0; a < terms.length; a++) {
      for (let b = a + 1; b < terms.length; b++) if (terms[a].s !== terms[b].s && dist(terms[a].pt, terms[b].pt) <= TOL) uf.union(tk(a), tk(b));
      wires.forEach((w, n) => {
        const ends = [w.pts[0], w.pts[w.pts.length - 1]];
        const tol = terms[a].node ? TOL + 4 : TOL;
        // A probe tip touches anywhere along a wire (that's how you'd clip a meter lead on).
        const onTol = terms[a].node ? tol : terms[a].probe ? TOL : TOL * 0.6;
        if (ends.some(e => dist(e, terms[a].pt) <= tol) || polyDist(terms[a].pt, w.pts) <= onTol) uf.union(tk(a), wk(n));
      });
    }
    for (let a = 0; a < wires.length; a++) for (let b = 0; b < wires.length; b++) {
      if (a === b) continue;
      const A = wires[a];
      if ([A.pts[0], A.pts[A.pts.length - 1]].some(e => polyDist(e, wires[b].pts) <= TOL)) uf.union(wk(a), wk(b));
    }
    // Nets
    const rootOf = (n) => uf.find(tk(n));
    const ground = new Set(terms.map((t, n) => (t.s.sym === 'GROUND' ? rootOf(n) : null)).filter(Boolean));
    const warns = [];
    // Names, ordered top-left → bottom-right so they read like a schematic.
    const order = real.slice().sort((a, b) => { const ca = centerOf(a), cb = centerOf(b); return Math.abs(ca[1] - cb[1]) > 24 ? ca[1] - cb[1] : ca[0] - cb[0]; });
    const counters = {}, names = new Map();
    for (const s of order) {
      const [pre] = CIRCUIT_INFO[s.sym] || ['X'];
      counters[pre] = (counters[pre] || 0) + 1;
      names.set(s, !blank(s.props && s.props.name) ? String(s.props.name) : pre + counters[pre]);
    }
    const termIdx = (s, k) => terms.findIndex(t => t.s === s && t.k === k);
    // Reference node: drawn ground, else the − end of the first voltage source, else any net.
    let refRoot = ground.size ? [...ground][0] : null;
    if (!refRoot) {
      const src = order.find(s => s.sym === 'VSOURCE' || s.sym === 'BATTERY' || s.sym === 'VSOURCE_AC');
      const pick = src ? termIdx(src, 0) : terms.findIndex(t => t.s.sym !== 'NODE' && !t.probe);
      if (pick >= 0) { refRoot = rootOf(pick); warns.push(`No ground symbol — voltages are measured from ${src ? names.get(src) + '’s − terminal' : 'an arbitrary node'}.`); }
    }
    const nodes = ['0'], idx = new Map();
    for (const r of ground) idx.set(r, 0);
    if (refRoot) idx.set(refRoot, 0);
    const nodeOf = (r) => { if (!idx.has(r)) { idx.set(r, nodes.length); nodes.push('N' + nodes.length); } return idx.get(r); };
    // Engine parts
    const eparts = [], missing = [], unreadable = [], comp = new Map();
    let acFreq = null;
    for (const s of order) {
      const name = names.get(s), p = s.props || {};
      const pins = (s.inline ? [0, 1] : s.sym === 'OPAMP' ? [0, 1, 2] : []).map(k => nodeOf(rootOf(termIdx(s, k))));
      // Values go to the engine as numbers (unit suffix stripped); unreadable ones fall back to the placeholder.
      const need = (k, def, unitHint, u) => {
        if (blank(p[k])) { missing.push(`${name} (${unitHint || k})`); return siVal(def, u); }
        const v = varExpr(p[k]) ? NaN : siVal(p[k], u);   // only sources can take a variable
        if (!isFinite(v)) { unreadable.push(`${name} (“${p[k]}”)`); return siVal(def, u); }
        return v;
      };
      const id = 'p' + s.i;
      let ep = null;
      // A source whose value is written in variables is a dependent source (pins as the plain one's: + at t1, I flows t0 → t1).
      const dep = (isV) => {
        const expr = varExpr(p.value);
        if (expr && expr.bad) { unreadable.push(`${name} (“${p.value}”)`); return { type: isV ? 'V' : 'I', n: isV ? [pins[1], pins[0]] : pins, p: { wave: 'dc', dc: 0 } }; }
        return expr ? { type: 'DS', n: isV ? [pins[1], pins[0]] : pins, p: { out: isV ? 'V' : 'I', expr, ctrl: [] } } : null;
      };
      switch (s.sym) {
        case 'RESISTOR': case 'RESISTOR_BOX': ep = { type: 'R', n: pins, p: { value: need('value', '1k', 'resistance', 'Ω') } }; break;
        case 'CAPACITOR': case 'CAP_POLAR': ep = { type: 'C', n: pins, p: { value: need('value', '1u', 'capacitance', 'F') } }; break;
        case 'INDUCTOR': ep = { type: 'L', n: pins, p: { value: need('value', '1m', 'inductance', 'H') } }; break;
        case 'VSOURCE': case 'BATTERY': ep = dep(true) || { type: 'V', n: [pins[1], pins[0]], p: { wave: 'dc', dc: need('value', s.sym === 'BATTERY' ? '9' : '5', 'voltage', 'V') } }; break;
        case 'VSOURCE_DEP': ep = dep(true) || { type: 'V', n: [pins[1], pins[0]], p: { wave: 'dc', dc: need('value', '0', 'value', 'V') } }; break;
        case 'ISOURCE_DEP': ep = dep(false) || { type: 'I', n: pins, p: { wave: 'dc', dc: need('value', '0', 'value', 'A') } }; break;
        case 'VSOURCE_AC': case 'ISOURCE_AC': {
          // AC sources: DC part 0, phasor amplitude/phase at the page's AC frequency.
          const isV = s.sym === 'VSOURCE_AC';
          const amp = need('amp', isV ? '10' : '1m', 'amplitude', isV ? 'V' : 'A');
          let f = blank(p.freq) ? 60 : siVal(p.freq, 'Hz');
          if (!(f > 0)) { warns.push(`${name}: frequency “${p.freq}” isn't a positive number — using 60 Hz.`); f = 60; }
          if (acFreq == null) acFreq = f; else if (Math.abs(f - acFreq) > 1e-9 * acFreq) warns.push(`${name} runs at a different frequency — phasors are only computed at ${si(acFreq, 'Hz')}.`);
          const ph = siVal(p.phase, '°') || 0;
          // V: pins swapped so + is t1 (as the DC source); I: current flows t0 → t1, toward the arrow tip.
          ep = isV ? { type: 'V', n: [pins[1], pins[0]], p: { wave: 'dc', dc: 0, ac: amp, acPhase: ph, freq: f } }
            : { type: 'I', n: pins, p: { wave: 'dc', dc: 0, ac: amp, acPhase: ph, freq: f } };
          break;
        }
        case 'ISOURCE': ep = dep(false) || { type: 'I', n: pins, p: { wave: 'dc', dc: need('value', '1m', 'current', 'A') } }; break;
        case 'DIODE': ep = { type: 'D', n: pins, p: { ...(DIODE_MODELS[p.model] || DIODE_MODELS['1N4148']) } }; break;
        case 'LED': ep = { type: 'LED', n: pins, p: { color: p.color || 'red' } }; break;
        case 'SWITCH': if (p.state !== 'open') ep = { type: 'R', n: pins, p: { value: '1m' } }; break;
        case 'AMMETER': ep = { type: 'V', n: pins, p: { wave: 'dc', dc: 0 } }; break;
        case 'VOLTMETER': break;
        case 'OPAMP': ep = { type: 'OA', n: pins, p: { gain: blank(p.gain) ? 1e5 : siVal(p.gain) || 1e5, vsat: blank(p.vsat) ? 15 : siVal(p.vsat, 'V') || 15, gbw: '1meg' } }; break;
      }
      comp.set(s, { name, pins, id, ep });
      if (ep) eparts.push({ id, ref: name, ...ep });
    }
    // Floating terminals
    const counts = new Map();
    terms.forEach((t, n) => { if (t.s.sym !== 'NODE' && !t.probe) { const r = rootOf(n); counts.set(r, (counts.get(r) || 0) + 1); } });
    const wired = new Set(wires.map((w, n) => uf.find(wk(n))));
    for (const s of order) {
      const ks = s.inline ? [0, 1] : s.sym === 'OPAMP' ? [0, 1, 2] : [];
      for (const k of ks) { const r = rootOf(termIdx(s, k)); if (counts.get(r) === 1 && !wired.has(r) && idx.get(r) !== 0) warns.push(`${names.get(s)} has an unconnected terminal.`); }
    }
    for (const s of parts) {
      if (PROBES.has(s.sym)) { out.comps[s.i] = { name: probeName(s), title: s.sym === 'PROBE_POS' ? 'V+ probe' : 'V− probe', label: probeName(s), fields: circuitFields(s) }; continue; }
      out.comps[s.i] = { name: names.get(s) || (s.sym === 'GROUND' ? 'Ground' : 'Node'), title: (CIRCUIT_INFO[s.sym] || [, s.sym === 'GROUND' ? 'Ground' : 'Node'])[1], label: [circuitLabel(s), varLabel(s)].filter(Boolean).join('  '), fields: circuitFields(s) };
    }
    if (missing.length) warns.push('No value yet for ' + missing.join(', ') + ' — tap the part to set it. Using a placeholder for now.');
    if (unreadable.length) warns.push('Couldn\'t read the value of ' + unreadable.join(', ') + ' — use a number with an optional SI prefix (e.g. 4.7k, 100n). Using a placeholder for now.');
    // Probe pairing: Vn+ with Vn−. Each probe's net (null = its tip isn't on the circuit).
    const probeNet = (s) => { const r = rootOf(termIdx(s, 0)); return idx.has(r) ? idx.get(r) : null; };
    const probePairs = [];
    if (probes.length) {
      const byN = new Map();
      for (const s of probes) { const n = probeNum(s); if (!byN.has(n)) byN.set(n, { pos: [], neg: [] }); byN.get(n)[s.sym === 'PROBE_POS' ? 'pos' : 'neg'].push(s); }
      for (const [n, g] of [...byN.entries()].sort((a, b) => a[0] - b[0])) {
        if (g.pos.length > 1) warns.push(`There are ${g.pos.length} V${n}+ probes — only one is used. Tap a probe to renumber it (V2+, V3+ …).`);
        if (g.neg.length > 1) warns.push(`There are ${g.neg.length} V${n}− probes — only one is used. Tap a probe to renumber it.`);
        const pos = g.pos[0], neg = g.neg[0];
        if (!pos) { warns.push(`V${n}− has no V${n}+ partner — place a V+ probe numbered ${n} to measure V${n}.`); continue; }
        let ok = true;
        for (const s of [pos, neg]) if (s && probeNet(s) == null) { warns.push(`${probeName(s)} isn't touching the circuit — drop its tip onto a wire or terminal.`); ok = false; }
        if (ok) probePairs.push({ n, pos, neg, a: probeNet(pos), b: neg ? probeNet(neg) : 0 });
      }
    }

    // Circuit variables: named on a part (its voltage t0 − t1, its current t0 → t1) or a probe pair's Vn.
    const varTab = new Map();
    for (const s of order) {
      const c = comp.get(s), flipped = c.ep && c.ep.n[0] !== c.pins[0];   // voltage sources are stamped + at t1
      for (const { name, sign } of partVars(s.props)) {
        if (/^v/i.test(name)) varTab.set(name.toLowerCase(), { name, v: [c.pins[0], c.pins[1]], sign });
        else if (c.ep && (c.ep.type === 'R' || c.ep.type === 'C' || c.ep.type === 'L' || c.ep.type === 'V' || (c.ep.type === 'DS' && c.ep.p.out === 'V'))) varTab.set(name.toLowerCase(), { name, i: c.id, sign: flipped ? -sign : sign });
        else warns.push(`${name} can't be read on ${c.name} — put an ammeter in series and name it there.`);
      }
    }
    for (const pr of probePairs) if (!varTab.has('v' + pr.n)) varTab.set('v' + pr.n, { name: 'V' + pr.n, v: [pr.a, pr.b], sign: 1 });
    for (const c of comp.values()) {
      if (!c.ep || c.ep.type !== 'DS') continue;
      for (const { k, name } of c.ep.p.expr) {
        const t = varTab.get(name.toLowerCase());
        if (!t) warns.push(`${c.name} depends on ${name}, but no part is named ${name} — enter it under Variable here on the part it belongs to.`);
        else if (t.v) c.ep.p.ctrl.push({ k: k * t.sign, v: t.v });
        else c.ep.p.ctrl.push({ k: k * t.sign, i: t.i });
      }
    }

    const blocks = warns.map(w => ({ t: 'warn', text: w }));
    const nl = { nodes, parts: eparts };
    if (!eparts.length) { out.analyses.push({ title: 'Circuit', blocks: [...blocks, { t: 'note', text: 'Add components between the wires to analyse the circuit.' }] }); return; }
    const op = CE.operatingPoint(nl);
    if (op.error) { blocks.push({ t: 'err', text: op.error }); out.analyses.push({ title: 'Circuit', blocks }); return; }
    let ac = null;
    if (acFreq != null) {
      const r = CE.acSweep(nl, { fStart: acFreq, fStop: acFreq * 1.0001, ppd: 5, currents: true });
      if (r.error) blocks.push({ t: 'err', text: 'AC: ' + r.error }); else ac = r;
    }
    const phasor = (mag, ph, u) => `${si(mag, u)} ∠${fx(ph, 1)}°`;
    const cplx = (c) => [Math.hypot(c[0], c[1]), Math.atan2(c[1], c[0]) * 180 / Math.PI];
    const res = new Map(op.parts.map(r => [r.id, r]));
    // Node voltage chips: a spot on each net (the longest wire's midpoint, else a terminal).
    const netSpot = new Map();
    wires.forEach((w, n) => {
      const r = uf.find(wk(n)), L = polyLen(w.pts);
      if (!netSpot.has(r) || netSpot.get(r).L < L) netSpot.set(r, { L, pt: midpointOf(w.pts) });
    });
    terms.forEach((t, n) => { const r = rootOf(n); if (!netSpot.has(r) && t.s.sym !== 'GROUND' && !t.probe) netSpot.set(r, { L: 0, pt: t.pt }); });
    const nodeRows = [];
    const seenIdx = new Set();
    for (const [r, spot] of netSpot) {
      const k = idx.get(r);
      if (k == null || k === 0 || seenIdx.has(k)) continue;
      seenIdx.add(k);
      const name = nodes[k];
      const vdc = op.nodes[name];
      let txt = si(vdc, 'V');
      let acTxt = '';
      if (ac) { acTxt = phasor(ac.mag[name][0], ac.phase[name][0], 'V'); txt = Math.abs(vdc) > 1e-9 ? txt + ' + ' + acTxt : acTxt; }
      out.annots.push({ x: spot.pt[0], y: spot.pt[1] - 13, text: txt, kind: 'chip', tone: 'v' });
      nodeRows.push([name, si(vdc, 'V'), ...(ac ? [acTxt] : [])]);
    }
    // Per-part results
    const compRows = [], meterRows = [];
    let pSup = 0, pAbs = 0;
    for (const s of order) {
      const c = comp.get(s);
      if (s.sym === 'VOLTMETER') {
        const v = (k) => op.nodes[nodes[c.pins[k]]] || 0;
        const vd = v(0) - v(1);
        let txt = si(Math.abs(vd), 'V');
        if (ac) { const z = (k) => { const nm = nodes[c.pins[k]]; const m = ac.mag[nm][0], ph = ac.phase[nm][0] * Math.PI / 180; return [m * Math.cos(ph), m * Math.sin(ph)]; }; const d = cplx([z(0)[0] - z(1)[0], z(0)[1] - z(1)[1]]); txt = Math.abs(vd) > 1e-9 ? txt + ' + ' + phasor(d[0], d[1], 'V') : phasor(d[0], d[1], 'V'); }
        out.annots.push({ x: chipSpot(s, true)[0], y: chipSpot(s, true)[1], text: txt, kind: 'chip', tone: 'meter' });
        meterRows.push([c.name, 'Voltage', txt]);
        continue;
      }
      if (!c.ep) continue;
      const r = res.get(c.id);
      if (!r) continue;
      if (r.p < 0) pSup -= r.p; else pAbs += r.p;
      let acI = '';
      if (ac && ac.cur && ac.cur[0][c.id]) { const z = cplx(ac.cur[0][c.id]); acI = phasor(z[0], z[1], 'A'); }
      const dcI = si(Math.abs(r.i), 'A');
      const iTxt = ac ? (Math.abs(r.i) > 1e-12 ? dcI + ' + ' + acI : acI) : dcI;
      if (s.sym === 'AMMETER') {
        out.annots.push({ x: chipSpot(s, true)[0], y: chipSpot(s, true)[1], text: iTxt, kind: 'chip', tone: 'meter' });
        meterRows.push([c.name, 'Current', iTxt]);
        continue;
      }
      if (s.sym !== 'OPAMP') out.annots.push({ x: chipSpot(s, true)[0], y: chipSpot(s, true)[1], text: iTxt, kind: 'chip', tone: 'i' });
      compRows.push([c.name, circuitLabel(s) || '—', si(r.v, 'V'), si(r.i, 'A'), si(r.p, 'W'), ...(ac ? [acI || '—'] : [])]);
    }
    // Probe voltages: Vn = V(+) − V(−), signed; a lone + probe reads against the reference node.
    const probeRows = [];
    const refName = ground.size ? 'ground' : 'the reference node';
    const vAt = (k) => (k ? op.nodes[nodes[k]] || 0 : 0);
    const zAt = (k) => { if (!ac || !k) return [0, 0]; const nm = nodes[k], m = ac.mag[nm][0], ph = ac.phase[nm][0] * Math.PI / 180; return [m * Math.cos(ph), m * Math.sin(ph)]; };
    const nodeLabel = (k) => (k ? nodes[k] : ground.size ? 'ground' : 'ref (0)');
    for (const pr of probePairs) {
      const vd = vAt(pr.a) - vAt(pr.b);
      let txt = si(vd, 'V'), acTxt = '';
      if (ac) { const za = zAt(pr.a), zb = zAt(pr.b), d = cplx([za[0] - zb[0], za[1] - zb[1]]); acTxt = phasor(d[0], d[1], 'V'); txt = Math.abs(vd) > 1e-9 ? txt + ' + ' + acTxt : acTxt; }
      const tip = boxMap(pr.pos).toPage([0, -14]);
      out.annots.push({ x: tip[0], y: tip[1] - 12, text: `V${pr.n} = ${txt}`, kind: 'chip', tone: 'meter' });
      probeRows.push([`V${pr.n}`, nodeLabel(pr.a), pr.neg ? nodeLabel(pr.b) : nodeLabel(0) + ' (no V' + pr.n + '−)', si(vd, 'V'), ...(ac ? [acTxt] : [])]);
      if (!pr.neg) blocks.push({ t: 'note', text: `V${pr.n} has no V${pr.n}− probe, so it's measured from ${refName}. Add a V${pr.n}− probe to measure across a part.` });
    }
    const varRows = [...varTab.values()].map(t => {
      const dc = t.v ? (vAt(t.v[0]) - vAt(t.v[1])) * t.sign : (res.get(t.i) || { i: 0 }).i * t.sign;
      let acTxt = '';
      if (ac) {
        const za = t.v ? zAt(t.v[0]) : (ac.cur && ac.cur[0][t.i]) || [0, 0], zb = t.v ? zAt(t.v[1]) : [0, 0];
        const d = cplx([(za[0] - zb[0]) * t.sign, (za[1] - zb[1]) * t.sign]);
        acTxt = phasor(d[0], d[1], t.v ? 'V' : 'A');
      }
      return [t.name, si(dc, t.v ? 'V' : 'A'), ...(ac ? [acTxt] : [])];
    });
    const cards = [['Nodes', String(nodes.length - 1)], ['Components', String(eparts.length)], ['Power supplied', si(pSup, 'W')], ['Power absorbed', si(pAbs, 'W')]];
    if (ac) cards.push(['AC frequency', si(acFreq, 'Hz')], ['ω', si(2 * Math.PI * acFreq, 'rad/s')]);
    blocks.push({ t: 'cards', items: cards });
    if (varRows.length) blocks.push({ t: 'table', title: 'Variables', head: ['Variable', 'DC', ...(ac ? ['AC phasor'] : [])], rows: varRows });
    if (probeRows.length) blocks.push({ t: 'table', title: 'Probe voltages', head: ['Probe', 'V+ at', 'V− at', 'DC', ...(ac ? ['AC phasor'] : [])], rows: probeRows });
    if (meterRows.length) blocks.push({ t: 'table', title: 'Meter readings', head: ['Meter', 'Reads', 'Value'], rows: meterRows });
    blocks.push({ t: 'table', title: 'Node voltages', head: ['Node', 'DC', ...(ac ? ['AC phasor'] : [])], rows: nodeRows });
    blocks.push({ t: 'table', title: 'Components', head: ['Part', 'Value', 'V', 'I', 'P', ...(ac ? ['AC current'] : [])], rows: compRows });
    blocks.push({ t: 'note', text: (ac ? 'Phasors are peak amplitudes at ' + si(acFreq, 'Hz') + '; the DC part is shown separately. ' : '') + 'Current is positive from a part\'s first terminal to its second; P < 0 means the part delivers power. Ideal op-amps saturate at ±V_sat.' });
    out.analyses.push({ title: ac ? 'Circuit — DC + AC phasor analysis' : 'Circuit — DC analysis', blocks });
  }

  // =========================================================================================
  // THERMAL RESERVOIR SYMBOLS (hot / cold) — linked to devices by lines
  // =========================================================================================
  // Links for the page being analysed (analyze() is synchronous, so one shared slot is fine).
  let LINKS = emptyLinks();
  function emptyLinks() {
    const use = new Map();
    return { list: [], heatWires: new Set(), byDev: new Map(), use, useOf: (r) => { if (!use.has(r)) use.set(r, []); return use.get(r); } };
  }
  // A reservoir links to every flow device / heat-engine diagram that a line touching its box also
  // touches — directly or through a chain of lines joined end-to-line. A line that runs between two
  // flow devices is a pipe, not a heat line, so chains never cross into the working-fluid loop.
  function linkReservoirs(syms, wires) {
    const L = emptyLinks();
    const rs = syms.filter(s => HEATRES.has(s.sym) && s.box);
    if (!rs.length) return L;
    const targets = syms.filter(s => FLOW.has(s.sym) || RES.has(s.sym));
    const info = wires.map(w => ({ devs: targets.filter(d => touchesSym(w.pts, d, TOL)), res: rs.filter(r => touchesSym(w.pts, r, TOL)) }));
    const flowCount = (k) => info[k].devs.filter(d => FLOW.has(d.sym)).length;
    const endsOn = (a, b) => [wires[a].pts[0], wires[a].pts[wires[a].pts.length - 1]].some(e => polyDist(e, wires[b].pts) <= TOL);
    const counters = { hot: 0, cold: 0 };
    for (const r of rs) {
      const hot = r.sym === 'HOT_RESERVOIR', n = ++counters[hot ? 'hot' : 'cold'];
      const T = qty(r.props.T, 'T');
      const e = { s: r, hot, T: T > 0 ? T : null, bad: !blank(r.props.T) && !(T > 0), name: (hot ? 'Hot reservoir' : 'Cold reservoir') + (n > 1 ? ' ' + n : ''), devs: [], wires: new Set() };
      const stack = [];
      info.forEach((x, k) => { if (x.res.includes(r) && flowCount(k) < 2) stack.push(k); });
      while (stack.length) {
        const k = stack.pop();
        if (e.wires.has(k)) continue;
        e.wires.add(k);
        for (let j = 0; j < wires.length; j++) if (!e.wires.has(j) && flowCount(j) < 2 && (endsOn(k, j) || endsOn(j, k))) stack.push(j);
      }
      const devs = new Set();
      for (const k of e.wires) for (const d of info[k].devs) devs.add(d);
      // Drawn right against a device (boxes within TOL) also counts.
      const ro = obbOf(r, TOL);
      for (const d of targets) if (obbOverlap(ro, obbOf(d, 0))) devs.add(d);
      e.devs = [...devs];
      for (const d of devs) { if (!L.byDev.has(d)) L.byDev.set(d, []); L.byDev.get(d).push(e); }
      for (const k of e.wires) L.heatWires.add(wires[k]);
      L.list.push(e);
    }
    return L;
  }
  // Chips, comps and a summary for every reservoir symbol (after the cycles recorded what used them).
  function reservoirReport(out) {
    if (!LINKS.list.length) return;
    const blocks = [], rows = [];
    for (const e of LINKS.list) {
      const s = e.s, f = fld(s.props);
      out.comps[s.i] = { name: e.name, title: e.hot ? 'Hot thermal reservoir' : 'Cold thermal reservoir', label: '', fields: [f('T', 'Temperature', '°C', e.hot ? '500' : '20', { hint: 'add K for kelvin, e.g. 300 K' })] };
      const edge = boxMap(s).toPage([0, e.hot ? -20 : 20]), tag = e.hot ? 'T_H' : 'T_C';
      out.annots.push({ x: edge[0], y: edge[1] + (e.hot ? -14 : 14), text: e.T ? `${tag} ${fT(e.T)}` : `${tag} not set`, kind: 'chip', tone: e.T ? (e.hot ? 'hot' : 'cold') : 'warn' });
      if (e.bad) blocks.push({ t: 'warn', text: `${e.name}: “${s.props.T}” isn't a temperature above absolute zero — try 500 (°C) or 300 K.` });
      else if (!e.T) blocks.push({ t: 'warn', text: `Tap the ${e.name.toLowerCase()} and set its temperature.` });
      const linkedTo = e.devs.map(d => (out.comps[d.i] && out.comps[d.i].name) || DEV_TITLE[d.sym] || d.sym).join(', ');
      const use = LINKS.use.get(e) || [];
      if (!e.devs.length) blocks.push({ t: 'warn', text: `${e.name} isn't linked to anything — draw a line from it to a boiler, condenser, heat exchanger, heat engine or refrigerator.` });
      else if (!use.length && e.T) blocks.push({ t: 'note', text: `${e.name} touches ${linkedTo}, but nothing there takes its temperature — link it to the heat-input or heat-rejection device of a recognised cycle, or to a heat engine / refrigerator diagram.` });
      rows.push([e.name, e.T ? `${fT(e.T)} (${fx(e.T, 2)} K)` : '—', linkedTo || '—', use.join('; ') || '—']);
    }
    // Heat only flows hot → cold: every hot reservoir must be hotter than every cold one on the page.
    const hots = LINKS.list.filter(e => e.hot && e.T), colds = LINKS.list.filter(e => !e.hot && e.T);
    for (const h of hots) for (const c of colds) if (h.T <= c.T) blocks.push({ t: 'warn', text: `${h.name} (${fT(h.T)}) isn't hotter than ${c.name} (${fT(c.T)}) — heat flows from hot to cold, so check the temperatures.` });
    blocks.push({ t: 'table', title: 'Reservoirs', head: ['Reservoir', 'T', 'Linked to', 'Used as'], rows });
    blocks.push({ t: 'note', text: 'A reservoir links to whatever its line (or a chain of joined lines) touches. In a power cycle the hot reservoir sets T_H at the boiler / heater and the cold one T_C at the condenser / cooler; in a refrigerator or heat pump the hot reservoir is the warm region at the condenser and the cold one the cold region at the evaporator. A reservoir T typed on the device itself wins.' });
    out.analyses.push({ title: 'Thermal reservoirs', blocks });
  }

  // =========================================================================================
  // RESERVOIR DIAGRAMS (heat engine / refrigerator symbols)
  // =========================================================================================
  function reservoirs(syms, out) {
    for (const s of syms.filter(x => RES.has(x.sym))) {
      const p = s.props || {}, engine = s.sym === 'HEAT_ENGINE';
      const mode = engine ? 'power' : p.mode === 'heatpump' ? 'heatpump' : 'refrigeration';
      const rate = p.basis === 'kJ' ? false : true;
      const dimE = rate ? 'P' : 'E', uE = rate ? 'kW' : 'kJ';
      const f = fld(p);
      // Reservoir symbols linked by a line fill T_H / T_C when the diagram's own props are blank.
      const blocks = [];
      const linked = (LINKS.byDev.get(s) || []);
      const hotL = linked.filter(r => r.hot), coldL = linked.filter(r => !r.hot);
      const fromRes = (key, list, which) => {
        const own = qty(p[key], 'T');
        const r = list.find(x => x.T > 0);
        if (list.length > 1) blocks.push({ t: 'warn', text: `${list.length} ${which} reservoirs are linked to this diagram — using ${r ? r.name : 'the first'}.` });
        if (own != null && isFinite(own)) {
          if (r && Math.abs(r.T - own) > 0.05) blocks.push({ t: 'note', text: `The diagram's own ${key === 'TH' ? 'T_H' : 'T_C'} (${fT(own)}) differs from the linked ${r.name.toLowerCase()} (${fT(r.T)}) — using the diagram's value. Clear it to use the reservoir.` });
          return { T: own, src: null };
        }
        if (!r) return { T: own, src: null };
        LINKS.useOf(r).push(`${key === 'TH' ? 'T_H' : 'T_C'} of the ${engine ? 'heat engine' : mode === 'heatpump' ? 'heat pump' : 'refrigerator'}`);
        return { T: r.T, src: r };
      };
      const hot = fromRes('TH', hotL, 'hot'), cold = fromRes('TC', coldL, 'cold');
      const TH = hot.T, TC = cold.T;
      out.comps[s.i] = {
        name: engine ? 'Heat engine' : mode === 'heatpump' ? 'Heat pump' : 'Refrigerator', title: engine ? 'Power cycle between reservoirs' : 'Refrigeration / heat pump cycle',
        label: '',
        fields: [
          ...(engine ? [] : [f('mode', 'Cycle', '', 'refrigerator', { options: ['refrigerator', 'heatpump'] })]),
          f('TH', 'Hot reservoir T_H', '°C', hot.src ? fT(hot.src.T) + ' (linked)' : '', { hint: hot.src ? 'from the linked hot reservoir — type a value to override' : 'add K for kelvin, e.g. 500 K' }),
          f('TC', 'Cold reservoir T_C', '°C', cold.src ? fT(cold.src.T) + ' (linked)' : '', cold.src ? { hint: 'from the linked cold reservoir — type a value to override' } : {}),
          f('basis', 'Energy or rate', '', 'kW', { options: ['kW', 'kJ'] }),
          f('QH', 'Q_H', uE, 'unknown'), f('QC', 'Q_C', uE, 'unknown'), f('W', 'W_cycle', uE, 'unknown'),
          f('perf', engine ? 'Efficiency η' : mode === 'heatpump' ? 'COP γ' : 'COP β', engine ? '%' : '', 'unknown', engine ? {} : { keypad: 'num' }),
        ],
      };
      const m = boxMap(s);
      const at = (x, y) => m.toPage([x, y]);
      const known = { QH: qty(p.QH, dimE), QL: qty(p.QC, dimE), W: qty(p.W, dimE), perf: engine ? qty(p.perf, 'pct') : qty(p.perf, 'n') };
      if (!(TH > 0 && TC > 0)) blocks.push({ t: 'warn', text: hotL.length || coldL.length ? 'Set the temperature of each linked reservoir (or T_H and T_C on the diagram).' : 'Tap the diagram and set T_H and T_C — or draw a line from a hot and a cold reservoir to it.' });
      let R = null;
      if (TH > 0 && TC > 0) {
        try { R = TE.reservoirCycle(mode, TH, TC, known); } catch (e) { blocks.push({ t: 'warn', text: e.message }); }
      }
      // A linked reservoir's own chip already shows its T, so only typed values get a chip here.
      if (TH > 0 && !hot.src) out.annots.push({ ...pt(at(0, -54)), text: 'T_H ' + fT(TH), kind: 'chip', tone: 'hot' });
      if (TC > 0 && !cold.src) out.annots.push({ ...pt(at(0, 54)), text: 'T_C ' + fT(TC), kind: 'chip', tone: 'cold' });
      if (R) {
        const e = (v) => (+v.toPrecision(4)) + ' ' + uE;
        out.annots.push({ ...pt(at(26, -32)), text: 'Q_H ' + e(R.QH), kind: 'chip', tone: 'hot' });
        out.annots.push({ ...pt(at(26, 32)), text: 'Q_C ' + e(R.QL), kind: 'chip', tone: 'cold' });
        out.annots.push({ ...pt(at(52, -12)), text: 'W ' + e(R.W), kind: 'chip', tone: 'i' });
        const pn = engine ? 'η' : mode === 'heatpump' ? 'γ' : 'β';
        const pv = (v) => (engine ? fpct(v) : fx(v, 3));
        out.annots.push({ ...pt(at(0, 80)), text: `${pn} ${pv(R.perf)} · max ${pv(R.perfMax)}`, kind: 'chip', tone: R.verdict.kind === 'bad' ? 'warn' : R.verdict.kind === 'rev' ? 'v' : 'ok' });
        blocks.push({ t: R.verdict.kind === 'bad' ? 'err' : 'ok', text: R.verdict.text });
        R.warnings.forEach(w => blocks.push({ t: 'warn', text: w }));
        blocks.push({ t: 'cards', items: [['Q_H', e(R.QH)], ['Q_C', e(R.QL)], ['W_cycle', e(R.W)], [pn + ' actual', pv(R.perf)], [pn + '_max (Carnot)', pv(R.perfMax)], [pn + ' / ' + pn + '_max', fpct(R.ratio)], ['σ_cycle', (+R.sigma.toPrecision(4)) + (rate ? ' kW/K' : ' kJ/K')], ['T_C / T_H', fx(TC / TH, 4)]] });
        blocks.push({ t: 'note', text: engine ? 'η = W/Q_H, η_max = 1 − T_C/T_H, σ_cycle = Q_C/T_C − Q_H/T_H (kelvin).' : mode === 'heatpump' ? 'γ = Q_H/W, γ_max = T_H/(T_H − T_C), σ_cycle = Q_H/T_H − Q_C/T_C.' : 'β = Q_C/W, β_max = T_C/(T_H − T_C), σ_cycle = Q_H/T_H − Q_C/T_C.' });
      }
      out.analyses.push({ title: out.comps[s.i].name + ' — second-law check', blocks });
    }
  }
  const pt = (p) => ({ x: p[0], y: p[1] });

  // =========================================================================================
  // THERMO FLOW (cycles and single devices)
  // =========================================================================================
  const DEV_TITLE = { COMPRESSOR: 'Compressor', TURBINE: 'Turbine', PUMP: 'Pump', HEAT_EXCHANGER: 'Heat exchanger', VALVE: 'Throttle valve', NOZZLE: 'Nozzle', DIFFUSER: 'Diffuser' };
  const LETTER = { COMPRESSOR: 'C', TURBINE: 'T', PUMP: 'P', HEAT_EXCHANGER: 'H', VALVE: 'V', NOZZLE: 'N', DIFFUSER: 'D' };

  function thermo(syms, wires, out) {
    const devs = syms.filter(s => FLOW.has(s.sym));
    if (!devs.length) return;
    // Pipes: wires joined end-to-line.
    const uf = UF();
    wires.forEach((w, n) => uf.find(n));
    for (let a = 0; a < wires.length; a++) for (let b = 0; b < wires.length; b++) {
      if (a !== b && [wires[a].pts[0], wires[a].pts[wires[a].pts.length - 1]].some(e => polyDist(e, wires[b].pts) <= TOL)) uf.union(a, b);
    }
    // Ports: where pipe ends land on a device (inside its box, or on a valve's terminal).
    for (const d of devs) {
      d.ports = new Map();   // pipe root → { lx, at }
      const m = d.inline ? null : boxMap(d);
      wires.forEach((w, n) => {
        for (const e of [w.pts[0], w.pts[w.pts.length - 1]]) {
          let lx = null;
          if (d.inline) {
            const d0 = dist(e, d.terms[0]), d1 = dist(e, d.terms[1]);
            if (Math.min(d0, d1) <= TOL + 4) lx = d0 < d1 ? -1 : 1;
            else if (polyDist(e, d.terms) <= TOL) lx = dist(e, d.terms[0]) < dist(e, d.terms[1]) ? -1 : 1;
          } else {
            const [x, y] = m.toLocal(e), mx = d.w / 2 + (TOL + 4) / Math.abs(m.sx), my = d.h / 2 + (TOL + 4) / Math.abs(m.sy);
            if (Math.abs(x) <= mx && Math.abs(y) <= my) lx = x;
          }
          if (lx == null) continue;
          const r = uf.find(n), prev = d.ports.get(r);
          if (!prev) d.ports.set(r, { lx, at: e });
        }
      });
      const ps = [...d.ports.entries()].sort((a, b) => a[1].lx - b[1].lx);
      d.portList = ps.map(([r, v]) => ({ pipe: r, ...v }));
    }
    // Pipe → devices on it
    const onPipe = new Map();
    for (const d of devs) for (const pp of d.portList) { if (!onPipe.has(pp.pipe)) onPipe.set(pp.pipe, []); onPipe.get(pp.pipe).push(d); }
    const pipeSpot = (r) => {
      let best = null;
      wires.forEach((w, n) => { if (uf.find(n) === r) { const L = polyLen(w.pts); if (!best || L > best.L) best = { L, pt: midpointOf(w.pts) }; } });
      return best ? best.pt : null;
    };
    // Group devices into connected trains.
    const seen = new Set();
    const trains = [];
    for (const d of devs) {
      if (seen.has(d)) continue;
      const group = [], stack = [d];
      while (stack.length) {
        const x = stack.pop();
        if (seen.has(x)) continue;
        seen.add(x); group.push(x);
        for (const pp of x.portList) for (const y of onPipe.get(pp.pipe) || []) if (!seen.has(y)) stack.push(y);
      }
      trains.push(group);
    }
    for (const g of trains) analyzeTrain(g, onPipe, pipeSpot, out);
  }

  // Order a train along the flow: inlet = the port further left in the symbol's own frame.
  function orderTrain(group, onPipe) {
    const warns = [];
    const portsOf = (d) => d.portList;
    const nextOn = (pipe, from) => (onPipe.get(pipe) || []).find(x => x !== from);
    // Start: a directional device (they fix the flow direction).
    const start = group.find(d => d.sym === 'PUMP') || group.find(d => d.sym === 'COMPRESSOR') || group.find(d => DIRECTIONAL.has(d.sym)) || group[0];
    const io = new Map();   // device → { in, out }
    const setIO = (d, inPipe) => {
      const ps = portsOf(d).map(p => p.pipe);
      if (ps.length > 2) warns.push(`${DEV_TITLE[d.sym]} has ${ps.length} connections — only two-port devices are analysed.`);
      let i, o;
      if (inPipe != null) { i = inPipe; o = ps.find(p => p !== inPipe) ?? null; }
      else { i = ps.length === 2 ? ps[0] : ps.length === 1 ? (DIRECTIONAL.has(d.sym) && portsOf(d)[0].lx > 0 ? null : ps[0]) : null; o = ps.length === 2 ? ps[1] : ps.length === 1 && i == null ? ps[0] : null; }
      if (DIRECTIONAL.has(d.sym) && inPipe != null && ps.length === 2 && ps[0] !== inPipe) warns.push(`The ${DEV_TITLE[d.sym].toLowerCase()} looks reversed — flow enters it on the right. Symbols run left → right; flip it if that's not intended.`);
      io.set(d, { in: i, out: o });
    };
    // Walk backwards to the start of an open train (or around a loop).
    let first = start;
    setIO(start, null);
    const back = new Set([start]);
    for (let k = 0; k < 20; k++) {
      const inP = io.get(first).in;
      const prev = inP != null ? nextOn(inP, first) : null;
      if (!prev || prev === start || back.has(prev)) break;
      back.add(prev);
      // prev's outlet is inP
      const ps = portsOf(prev).map(p => p.pipe);
      io.set(prev, { in: ps.find(p => p !== inP) ?? null, out: inP });
      first = prev;
    }
    // Forward walk from `first`.
    const seq = [first];
    let closed = false;
    let cur = first;
    if (first !== start) setIO(first, io.get(first).in);
    for (let k = 0; k < 20; k++) {
      const o = io.get(cur).out;
      if (o == null) break;
      const nx = nextOn(o, cur);
      if (!nx) break;
      if (nx === first) { closed = true; break; }
      if (seq.includes(nx)) break;
      setIO(nx, o);
      seq.push(nx); cur = nx;
    }
    if (seq.length < group.length) warns.push(`${group.length - seq.length} device(s) branch off the main flow path and were skipped.`);
    return { seq, closed, io, warns };
  }

  function analyzeTrain(group, onPipe, pipeSpot, out) {
    const { seq, closed, io, warns } = orderTrain(group, onPipe);
    const code = seq.map(d => LETTER[d.sym]).join('');
    const rot = (k) => seq.slice(k).concat(seq.slice(0, k));
    let kind = null, ordered = seq;
    if (closed) {
      for (let k = 0; k < seq.length; k++) {
        const c = rot(k).map(d => LETTER[d.sym]).join('');
        if (c === 'PHTH') { kind = 'rankine'; ordered = rot(k); break; }
        if (c === 'PHTHTH') { kind = 'rankine-reheat'; ordered = rot(k); break; }
        if (c === 'CHTH') { kind = 'brayton'; ordered = rot(k); break; }
        if (c === 'CHVH') { kind = 'refrig'; ordered = rot(k); break; }
      }
    } else if (code === 'CHT') kind = 'brayton-open';
    else if (seq.length === 1) kind = 'device';
    const blocks = warns.map(w => ({ t: 'warn', text: w }));
    const title = { rankine: 'Rankine cycle', 'rankine-reheat': 'Rankine cycle with reheat', brayton: 'Brayton cycle (closed)', 'brayton-open': 'Brayton cycle (open, air-standard)', refrig: 'Vapor-compression cycle', device: DEV_TITLE[seq[0].sym] };
    if (!kind) {
      blocks.push({ t: 'warn', text: `Flow path ${closed ? '(closed) ' : ''}${seq.map(d => DEV_TITLE[d.sym]).join(' → ')} isn't a cycle Thermo analysis knows. It recognises Rankine (pump → boiler → turbine → condenser, optionally with reheat), Brayton (compressor → heater → turbine [→ cooler]) and vapor compression (compressor → condenser → valve → evaporator).` });
      for (const d of seq) out.comps[d.i] = { name: DEV_TITLE[d.sym], title: DEV_TITLE[d.sym], label: '', fields: [] };
      out.analyses.push({ title: 'Thermo flow diagram', blocks });
      return;
    }
    if (kind === 'device') return singleDevice(seq[0], io.get(seq[0]), pipeSpot, blocks, out);
    cycleTrain(kind, ordered, closed, io, pipeSpot, blocks, title[kind], out);
  }

  // Roles and the props each role owns, per cycle kind (Moran & Shapiro state numbering).
  const ROLES = {
    rankine: ['pump', 'boiler', 'turbine', 'condenser'],
    'rankine-reheat': ['pump', 'boiler', 'hpTurbine', 'reheater', 'lpTurbine', 'condenser'],
    brayton: ['compressor', 'heater', 'turbine', 'cooler'],
    'brayton-open': ['compressor', 'heater', 'turbine'],
    refrig: ['compressor', 'condenser', 'valve', 'evaporator'],
  };
  // State number of each role's OUTLET.
  const OUT_STATE = {
    rankine: { pump: '4', boiler: '1', turbine: '2', condenser: '3' },
    'rankine-reheat': { pump: '6', boiler: '1', hpTurbine: '2', reheater: '3', lpTurbine: '4', condenser: '5' },
    brayton: { compressor: '2', heater: '3', turbine: '4', cooler: '1' },
    'brayton-open': { compressor: '2', heater: '3', turbine: '4' },
    refrig: { compressor: '2', condenser: '3', valve: '4', evaporator: '1' },
  };
  const ROLE_TITLE = { pump: 'Pump', boiler: 'Boiler', turbine: 'Turbine', condenser: 'Condenser', hpTurbine: 'HP turbine', lpTurbine: 'LP turbine', reheater: 'Reheater', compressor: 'Compressor', heater: 'Combustor / heater', cooler: 'Heat rejection', valve: 'Expansion valve', evaporator: 'Evaporator' };
  function roleFields(kind, role, p) {
    const f = fld(p);
    const eta = f('eta', 'Isentropic efficiency', '%', '100');
    if (kind.startsWith('rankine')) {
      if (role === 'boiler') return [f('p', 'Boiler pressure', 'kPa', '8000', { hint: 'or 8 MPa, 80 bar' }), f('T', 'Turbine inlet temperature', '°C', 'saturated vapor'), f('Tres', 'Heat source (hot reservoir) T', '°C', 'optional')];
      if (role === 'reheater') return [f('p', 'Reheat pressure', 'kPa', '700'), f('T', 'Reheat temperature', '°C', 'same as turbine inlet')];
      if (role === 'condenser') return [f('p', 'Condenser pressure', 'kPa', '8'), f('Tres', 'Cooling water (cold reservoir) T', '°C', 'optional')];
      if (role === 'pump') return [eta];
      if (role === 'turbine' || role === 'hpTurbine') return [eta, f('Wnet', 'Net power of the plant', 'MW', 'per kg only', { hint: 'kW or MW' })];
      return [eta];
    }
    if (kind.startsWith('brayton')) {
      if (role === 'compressor') return [f('T', 'Inlet temperature T₁', '°C', '27', { hint: 'add K for kelvin, e.g. 300 K' }), f('p', 'Inlet pressure p₁', 'kPa', '100'), f('rp', 'Pressure ratio p₂/p₁', '', '10', { keypad: 'num' }), eta, f('model', 'Air model', '', 'variable cp', { options: ['variable cp', 'cold air (k = 1.4)'] })];
      if (role === 'heater') return [f('T', 'Turbine inlet temperature T₃', '°C', '1126.85', { hint: 'e.g. 1400 K' }), f('Tres', 'Heat source T', '°C', 'optional')];
      if (role === 'turbine') return [eta, f('Wnet', 'Net power', 'MW', 'per kg only', { hint: 'kW or MW' })];
      if (role === 'cooler') return [f('Tres', 'Heat sink T', '°C', 'optional')];
    }
    if (kind === 'refrig') {
      if (role === 'compressor') return [eta, f('mode', 'Use as', '', 'refrigerator', { options: ['refrigerator', 'heat pump'] }), f('capacity', 'Capacity (cooling, or heating for a heat pump)', 'kW', 'per kg only', { hint: 'kW or tons', units: ['kW', 'tons'] })];
      if (role === 'condenser') return [f('T', 'Condensing temperature', '°C', '36'), f('dT', 'Subcooling', '°C', '0'), f('Tres', 'Warm surroundings T', '°C', 'optional')];
      if (role === 'evaporator') return [f('T', 'Evaporating temperature', '°C', '-10'), f('dT', 'Superheat', '°C', '0'), f('Tres', 'Cold region T', '°C', 'optional')];
      return [];
    }
    return [];
  }
  function roleLabel(kind, role, p) {
    const parts = [];
    if (!blank(p.p)) parts.push(fp(qty(p.p, 'p')));
    if (!blank(p.T)) parts.push(fT(qty(p.T, 'T')));
    if (!blank(p.eta)) parts.push('η ' + fpct(qty(p.eta, 'pct')));
    if (!blank(p.rp)) parts.push('r_p ' + p.rp);
    return parts.join(' · ');
  }

  // Which roles exchange heat with the hot / cold side (refrigeration: the condenser rejects to the
  // warm region T_H, the evaporator draws from the cold region T_C).
  const HOT_ROLES = { rankine: ['boiler'], 'rankine-reheat': ['boiler', 'reheater'], brayton: ['heater'], 'brayton-open': ['heater'], refrig: ['condenser'] };
  const COLD_ROLES = { rankine: ['condenser'], 'rankine-reheat': ['condenser'], brayton: ['cooler'], 'brayton-open': [], refrig: ['evaporator'] };
  // T_H / T_L for the cycle: a device's own Tres prop if typed, else a linked reservoir symbol's T.
  function cycleReservoirs(kind, by, title, blocks, out) {
    let linked = false;
    const side = (roles, hotSide) => {
      const tag = hotSide ? 'T_H' : 'T_C';
      for (const role of roles) {
        const d = by[role];
        if (!d) continue;
        const own = qty((d.props || {}).Tres, 'T');
        const list = LINKS.byDev.get(d) || [];
        if (!list.length) { if (own > 0) return own; continue; }
        linked = true;
        const r = list.find(x => x.hot === hotSide && x.T) || list.find(x => x.T) || list[0];
        if (list.length > 1) blocks.push({ t: 'note', text: `${list.length} reservoirs are linked to the ${ROLE_TITLE[role].toLowerCase()} — using ${r.name}.` });
        if (r.hot !== hotSide) blocks.push({ t: 'warn', text: `${r.name} is linked to the ${ROLE_TITLE[role].toLowerCase()}, which ${hotSide ? 'takes heat from the hot side' : 'rejects heat to the cold side'} — it's drawn as a ${r.hot ? 'hot' : 'cold'} reservoir but is used as ${tag} here.` });
        // Show the linked value in the device's own reservoir field.
        const fl = out.comps[d.i] && out.comps[d.i].fields.find(x => x.key === 'Tres');
        if (fl && r.T) { fl.ph = fT(r.T) + ' (linked)'; fl.hint = `from ${r.name.toLowerCase()} — type a value to override`; }
        if (own > 0) {
          if (r.T && Math.abs(r.T - own) > 0.05) blocks.push({ t: 'note', text: `The ${ROLE_TITLE[role].toLowerCase()}'s own reservoir T (${fT(own)}) differs from the linked ${r.name.toLowerCase()} (${fT(r.T)}) — using the ${ROLE_TITLE[role].toLowerCase()}'s value. Clear it to use the reservoir.` });
          return own;
        }
        if (!r.T) continue;
        LINKS.useOf(r).push(`${tag} of the ${title} (${ROLE_TITLE[role].toLowerCase()})`);
        return r.T;
      }
      return null;
    };
    const TH = side(HOT_ROLES[kind], true), TL = side(COLD_ROLES[kind], false);
    // Reservoirs on devices that don't exchange heat with one are ignored — say so.
    const heatRoles = new Set([...HOT_ROLES[kind], ...COLD_ROLES[kind]]);
    for (const [role, d] of Object.entries(by)) {
      if (heatRoles.has(role)) continue;
      for (const r of LINKS.byDev.get(d) || []) blocks.push({ t: 'warn', text: `${r.name} is linked to the ${ROLE_TITLE[role].toLowerCase()} — reservoirs exchange heat with the ${[...heatRoles].map(x => ROLE_TITLE[x].toLowerCase()).join(' / ')}, so it's ignored.` });
    }
    return { TH, TL, linked };
  }

  function cycleTrain(kind, seq, closed, io, pipeSpot, blocks, title, out) {
    const roles = ROLES[kind];
    const by = {};
    seq.forEach((d, k) => { by[roles[k]] = d; });
    const P = (role) => (by[role] && by[role].props) || {};
    for (const [k, d] of seq.entries()) out.comps[d.i] = { name: ROLE_TITLE[roles[k]], title: `${ROLE_TITLE[roles[k]]} (${DEV_TITLE[d.sym].toLowerCase()})`, label: roleLabel(kind, roles[k], d.props || {}), fields: roleFields(kind, roles[k], d.props || {}) };
    const RT = cycleReservoirs(kind, by, title, blocks, out);
    const assumed = [];
    const get = (role, key, dim, def, what) => {
      const v = qty(P(role)[key], dim);
      if (v == null || !isFinite(v)) { if (what) assumed.push(what); return def; }
      return v;
    };
    let C;
    try {
      if (kind.startsWith('rankine')) {
        const reheat = kind === 'rankine-reheat';
        const pB = get('boiler', 'p', 'p', 8000, 'boiler 8 MPa'), pC = get('condenser', 'p', 'p', 8, 'condenser 8 kPa');
        const T1 = qty(P('boiler').T, 'T');
        const tTurb = reheat ? 'hpTurbine' : 'turbine';
        const etaT = get(tTurb, 'eta', 'pct', 1, null), etaP = get('pump', 'eta', 'pct', 1, null);
        if (reheat && P('lpTurbine').eta && Math.abs(qty(P('lpTurbine').eta, 'pct') - etaT) > 1e-9) blocks.push({ t: 'note', text: 'Both turbines use the HP turbine\'s efficiency.' });
        const Wnet = qty(P(tTurb).Wnet, 'P') ?? (blank(P(tTurb).Wnet) ? null : null);
        C = TE.rankine({
          pBoiler: pB, pCond: pC, T1: T1 > 0 ? T1 : null, etaT, etaP, reheat,
          pReheat: reheat ? get('reheater', 'p', 'p', 700, 'reheat 0.7 MPa') : null,
          TReheat: reheat ? (qty(P('reheater').T, 'T') || (T1 > 0 ? T1 : null)) : null,
          Wnet: wnetKW(P(tTurb).Wnet), TH: RT.TH, TL: RT.TL,
        });
      } else if (kind.startsWith('brayton')) {
        C = TE.brayton({
          T1: get('compressor', 'T', 'T', 300, 'inlet 300 K'), p1: get('compressor', 'p', 'p', 100, 'inlet 100 kPa'),
          rp: get('compressor', 'rp', 'n', 10, 'pressure ratio 10'), T3: get('heater', 'T', 'T', 1400, 'turbine inlet 1400 K'),
          etaC: get('compressor', 'eta', 'pct', 1, null), etaT: get('turbine', 'eta', 'pct', 1, null), regen: 0,
          cold: /cold/.test(P('compressor').model || ''), Wnet: wnetKW(P('turbine').Wnet),
          TH: RT.TH, TL: kind === 'brayton' ? RT.TL : null,
        });
      } else {
        const hp = /heat/.test(P('compressor').mode || '');
        C = TE.vaporCompression({
          Tevap: get('evaporator', 'T', 'T', 263.15, 'evaporator −10 °C'), Tcond: get('condenser', 'T', 'T', 309.15, 'condenser 36 °C'),
          superheat: get('evaporator', 'dT', 'dT', 0, null), subcool: get('condenser', 'dT', 'dT', 0, null),
          etaC: get('compressor', 'eta', 'pct', 1, null), capacity: qty(P('compressor').capacity, 'P') || null, mode: hp ? 'heatpump' : 'refrigeration',
          TH: RT.TH, TL: RT.TL,
        });
      }
    } catch (e) {
      blocks.push({ t: 'err', text: e.message });
      out.analyses.push({ title, blocks });
      return;
    }
    if (assumed.length) blocks.push({ t: 'warn', text: 'Using textbook defaults for ' + assumed.join(', ') + ' — tap a component to set your values.' });
    // State badges on the pipes.
    const stateByLabel = new Map(C.states.map(s => [s.label, s]));
    seq.forEach((d, k) => {
      const lab = OUT_STATE[kind][roles[k]];
      const pipe = io.get(d).out;
      const spot = pipe != null ? pipeSpot(pipe) : null;
      const st = stateByLabel.get(lab);
      if (!spot || !st) return;
      out.annots.push({ x: spot[0], y: spot[1], text: lab, kind: 'badge', tone: 'state' });
      out.annots.push({ x: spot[0], y: spot[1] - 22, text: stateText(st), kind: 'chip', tone: 'v' });
    });
    // Open Brayton: state 1 sits on the compressor's inlet pipe.
    if (kind === 'brayton-open') {
      const pipe = io.get(seq[0]).in, spot = pipe != null ? pipeSpot(pipe) : null, st = stateByLabel.get('1');
      if (spot && st) { out.annots.push({ x: spot[0], y: spot[1], text: '1', kind: 'badge', tone: 'state' }); out.annots.push({ x: spot[0], y: spot[1] - 22, text: stateText(st), kind: 'chip', tone: 'v' }); }
    }
    // Device chips: work / heat per kg (or rate when sized).
    const mdot = C.mdot;
    const procFor = (d, k) => C.procs.find(pr => pr.from === prevLabel(kind, roles, k) && pr.to === OUT_STATE[kind][roles[k]]);
    seq.forEach((d, k) => {
      const pr = procFor(d, k);
      if (!pr) return;
      const v = pr.w ? pr.w : pr.q;
      if (!v) return;
      const sym = pr.w ? (pr.w > 0 ? 'w out ' : 'w in ') : (pr.q > 0 ? 'q in ' : 'q out ');
      const txt = mdot ? sym.replace('w', 'Ẇ').replace('q', 'Q̇') + fpow(Math.abs(v) * mdot) : sym + fx(Math.abs(v), 1) + ' kJ/kg';
      const c = chipSpot(d, false);
      out.annots.push({ x: c[0], y: c[1], text: txt, kind: 'chip', tone: pr.w ? 'i' : (pr.q > 0 ? 'hot' : 'cold') });
    });
    // Cycle summary at the centroid of the devices.
    const cx = seq.reduce((a, d) => a + centerOf(d)[0], 0) / seq.length, cy = seq.reduce((a, d) => a + centerOf(d)[1], 0) / seq.length;
    const power = C.kind === 'power';
    out.annots.push({ x: cx, y: cy, text: power ? `η = ${fpct(C.eta)}` : `${C.kind === 'heatpump' ? 'γ' : 'β'} = ${fx(C.cop, 2)}`, kind: 'chip', tone: 'ok' });
    // Panel
    const cards = [];
    if (power) {
      cards.push(['Thermal efficiency η', fpct(C.eta)], ['Carnot η (cycle extremes)', fpct(C.carnotCycle)], ['Net work', fx(C.wNet, 1) + ' kJ/kg'], ['Heat in', fx(C.qIn, 1) + ' kJ/kg'], ['Heat out', fx(C.qOut, 1) + ' kJ/kg'], ['Back work ratio', fpct(C.extra.bwr)]);
      if (C.extra.x2 != null) cards.push(['Turbine exit quality', fx(C.extra.x2, 4)]);
      if (mdot) cards.push(['Mass flow', fx(mdot, 3) + ' kg/s'], ['Q̇ in', fpow(mdot * C.qIn)], ['Q̇ out', fpow(mdot * C.qOut)]);
    } else {
      const hp = C.kind === 'heatpump';
      cards.push([hp ? 'COP γ' : 'COP β', fx(C.cop, 3)], ['Carnot (cycle extremes)', fx(C.carnotCycle, 3)], ['Refrigeration effect', fx(C.extra.qL, 1) + ' kJ/kg'], ['Compressor work', fx(C.extra.w, 1) + ' kJ/kg'], ['Heat rejected', fx(C.extra.qH, 1) + ' kJ/kg'], ['Evaporator p', fp(C.extra.pEvap)], ['Condenser p', fp(C.extra.pCond)]);
      if (mdot) cards.push(['Mass flow', fx(mdot, 4) + ' kg/s'], ['Compressor power', fpow(mdot * C.extra.w)]);
    }
    if (C.res) {
      cards.push([power ? 'η_max between reservoirs' : 'COP_max between regions', power ? fpct(C.res.perfMax) : fx(C.res.perfMax, 3)], ['σ_cycle', (+C.res.sigma.toPrecision(4)) + ' kJ/kg·K'], ['T_H', fT(C.res.TH)], ['T_C', fT(C.res.TL)]);
      if (!(C.res.TH > C.res.TL)) blocks.push({ t: 'err', text: `The hot side (${fT(C.res.TH)}) isn't hotter than the cold side (${fT(C.res.TL)}) — check the reservoir temperatures.` });
      else if (C.res.sigma < -1e-9) blocks.push({ t: 'err', text: 'σ_cycle < 0 — this cycle couldn\'t run between these reservoirs (it would beat the Carnot limit).' });
      C.res.warn.forEach(w => blocks.push({ t: 'warn', text: w }));
    } else if (RT.linked && kind !== 'brayton-open') {
      blocks.push({ t: 'note', text: RT.TH > 0 ? `Link a cold reservoir to the ${ROLE_TITLE[COLD_ROLES[kind][0]] ? ROLE_TITLE[COLD_ROLES[kind][0]].toLowerCase() : 'heat-rejection side'} (or set its T) to get σ_cycle and the Carnot limit between reservoirs.` : `Link a hot reservoir to the ${ROLE_TITLE[HOT_ROLES[kind][0]].toLowerCase()} (or set its T) to get σ_cycle and the Carnot limit between reservoirs.` });
    }
    if (C.extra.x2 != null && C.extra.x2 < 0.88) blocks.push({ t: 'warn', text: `Turbine exit quality ${fx(C.extra.x2, 3)} is below ~0.88 — that much moisture erodes the blades.` });
    blocks.push({ t: 'cards', items: cards });
    blocks.push({ t: 'plot', ...tsPlot(C) });
    const closedSys = !!C.closed;
    blocks.push({ t: 'table', title: 'States', head: ['State', 'T', 'p', closedSys ? 'u (kJ/kg)' : 'h (kJ/kg)', 's (kJ/kg·K)', 'x'], rows: C.states.map(s => [s.label, fT(s.T), fp(s.p), fx(closedSys ? s.u : s.h, 2), fx(s.s, 4), s.x != null ? fx(s.x, 4) : '—']) });
    blocks.push({ t: 'table', title: 'Processes (per kg)', head: ['', 'Component', 'q', 'w'], rows: C.procs.map(p => [`${p.from}→${p.to}`, p.label, p.q ? fx(p.q, 1) : '0', p.w ? fx(p.w, 1) : '0']) });
    blocks.push({ t: 'note', text: C.sub === 'water' ? 'Water from IAPWS-IF97 (current steam tables). States are numbered as in Moran & Shapiro.' : C.sub === 'r134a' ? 'R-134a with the ASHRAE reference (h = s = 0 for saturated liquid at −40 °C), matching Çengel\'s tables.' : 'Air-standard analysis' + (C.sub === 'aircold' ? ' with constant specific heats (k = 1.4).' : ' with variable specific heats (Table A-22).') });
    out.analyses.push({ title, blocks });
  }
  function wnetKW(v) { if (blank(v)) return null; const s = String(v).toLowerCase(); return /kw|\bw$/.test(s) ? qty(v, 'P') : qty(/mw/.test(s) ? v : v + 'MW', 'P'); }
  function prevLabel(kind, roles, k) { const r = roles[(k - 1 + roles.length) % roles.length]; return kind === 'brayton-open' && k === 0 ? '1' : OUT_STATE[kind][r]; }
  function stateText(st) { return st.x != null && st.x >= 0 && st.x <= 1 && /Two|Saturated/.test(st.phase) ? `${fT(st.T)} · ${fp(st.p)} · x ${fx(st.x, 3)}` : `${fT(st.T)} · ${fp(st.p)}`; }

  function tsPlot(C) {
    const polys = [];
    if (!TE.isGas(C.sub)) {
      const d = TE.dome(C.sub);
      polys.push({ pts: d.map(p => [p.sf, p.T - 273.15]).concat(d.slice().reverse().map(p => [p.sg, p.T - 273.15])), tone: 'dome', closed: true });
    }
    const TONE = { heat: 'hot', reject: 'cold', expand: 'work', compress: 'work', regen: 'regen', throttle: 'throttle' };
    for (const p of C.procs) polys.push({ pts: p.path.map(s => [s.s, s.T - 273.15]), tone: TONE[p.kind] || 'work', dash: p.path.length === 2 && p.kind !== 'heat' && p.kind !== 'reject' });
    const hlines = [];
    if (C.res) { hlines.push({ y: C.res.TH - 273.15, label: 'T_H', tone: 'hot' }, { y: C.res.TL - 273.15, label: 'T_C', tone: 'cold' }); }
    return { title: 'T-s diagram', xLabel: 's (kJ/kg·K)', yLabel: 'T (°C)', polys, pts: C.states.map(s => ({ x: s.s, y: s.T - 273.15, label: s.label })), hlines };
  }

  // ---- a single steady-flow device -----------------------------------------------------------------
  function singleDevice(d, io, pipeSpot, blocks, out) {
    const p = d.props || {};
    const kind = { COMPRESSOR: 'compressor', TURBINE: 'turbine', PUMP: 'pump', NOZZLE: 'nozzle', DIFFUSER: 'diffuser', VALVE: 'throttle', HEAT_EXCHANGER: 'heater' }[d.sym];
    const defSub = d.sym === 'COMPRESSOR' || d.sym === 'NOZZLE' || d.sym === 'DIFFUSER' ? 'air' : d.sym === 'VALVE' ? 'r134a' : 'water';
    const subName = { water: 'water', r134a: 'R-134a', air: 'air' };
    const subKey = (v) => (/134/.test(v || '') ? 'r134a' : /air/i.test(v || '') ? 'air' : /water|steam/i.test(v || '') ? 'water' : null);
    const sub = subKey(p.fluid) || defSub;
    const f = fld(p);
    const DEF = {
      turbine: { p1: '3000', T1: '400', p2: '10', eta: '85' }, compressor: { p1: '100', T1: '27', p2: '800', eta: '85' },
      pump: { p1: '10', T1: '40', p2: '3000', eta: '80' }, nozzle: { p1: '300', T1: '227', p2: '100', eta: '95', V1: '10' },
      diffuser: { p1: '50', T1: '-23', p2: '70', V1: '250', V2: '30' }, throttle: { p1: '900', x1: '0', p2: '200' }, heater: { p1: '8000', T1: '40', T2: '480' },
    }[kind];
    const fields = [f('fluid', 'Fluid', '', subName[defSub], { options: ['water', 'R-134a', 'air'] }), f('p1', 'Inlet pressure', 'kPa', DEF.p1), f('T1', 'Inlet temperature', '°C', DEF.T1 || 'use quality')];
    if (sub !== 'air') fields.push(f('x1', 'Inlet quality (instead of T)', '0–1', DEF.x1 || '', { keypad: 'num', units: [] }));
    if (kind !== 'heater') fields.push(f('p2', 'Exit pressure', 'kPa', DEF.p2));
    if (['turbine', 'compressor', 'pump', 'nozzle'].includes(kind)) fields.push(f('eta', 'Isentropic efficiency', '%', DEF.eta));
    if (kind === 'heater') fields.push(f('T2', 'Exit temperature', '°C', DEF.T2));
    if (kind === 'nozzle' || kind === 'diffuser') fields.push(f('V1', 'Inlet velocity', 'm/s', DEF.V1));
    if (kind === 'diffuser') fields.push(f('V2', 'Exit velocity', 'm/s', DEF.V2));
    fields.push(f('mdot', 'Mass flow', 'kg/s', '1'));
    out.comps[d.i] = { name: DEV_TITLE[d.sym], title: DEV_TITLE[d.sym], label: [blank(p.p1) ? '' : fp(qty(p.p1, 'p')) + ' → ' + (blank(p.p2) ? '?' : fp(qty(p.p2, 'p')))].filter(Boolean).join(''), fields };
    const val = (k, dim) => { const v = qty(blank(p[k]) ? DEF[k] : p[k], dim); return v; };
    const usedDefaults = ['p1', 'T1', 'p2', 'eta'].filter(k => DEF[k] != null && blank(p[k]) && !(k === 'T1' && !blank(p.x1)));
    const inlet = !blank(p.x1) && sub !== 'air' ? { p: val('p1', 'p'), x: num(p.x1) } : (DEF.x1 != null && blank(p.T1) ? { p: val('p1', 'p'), x: num(DEF.x1) } : { p: val('p1', 'p'), T: val('T1', 'T') });
    let D;
    try {
      D = TE.device({ device: kind, sub, in: inlet, p2: kind === 'heater' ? val('p1', 'p') : val('p2', 'p'), mode: kind === 'heater' ? 'T2' : 'eta', eta: val('eta', 'pct'), T2: val('T2', 'T'), mdot: val('mdot', 'n') || 1, V1: val('V1', 'n') || 0, V2: val('V2', 'n') || 0, Qdot: 0, Tb: null, T0: 298.15 });
    } catch (e) {
      blocks.push({ t: 'err', text: e.message });
      out.analyses.push({ title: DEV_TITLE[d.sym], blocks });
      return;
    }
    if (usedDefaults.length) blocks.push({ t: 'warn', text: 'Using example values for ' + usedDefaults.join(', ') + ' — tap the device to set yours.' });
    // Badges at the inlet / exit (pipes if drawn, else the symbol's sides).
    const side = (lx) => (d.inline ? d.terms[lx < 0 ? 0 : 1] : boxMap(d).toPage([lx * d.w / 2 * 1.15, 0]));
    const inSpot = io.in != null ? pipeSpot(io.in) : side(-1), outSpot = io.out != null ? pipeSpot(io.out) : side(1);
    out.annots.push({ x: inSpot[0], y: inSpot[1], text: '1', kind: 'badge', tone: 'state' }, { x: inSpot[0], y: inSpot[1] - 22, text: stateText(D.s1), kind: 'chip', tone: 'v' });
    out.annots.push({ x: outSpot[0], y: outSpot[1], text: '2', kind: 'badge', tone: 'state' }, { x: outSpot[0], y: outSpot[1] - 22, text: stateText(D.s2), kind: 'chip', tone: 'v' });
    const c = chipSpot(d, false);
    const main = kind === 'nozzle' ? `V₂ = ${fx(D.V2, 1)} m/s` : kind === 'heater' ? `Q̇ = ${fpow(D.Qdot)}` : kind === 'throttle' || kind === 'diffuser' ? `σ̇ = ${(+D.sigma.toPrecision(3))} kW/K` : `Ẇ = ${fpow(D.Wdot)}`;
    out.annots.push({ x: c[0], y: c[1], text: main, kind: 'chip', tone: 'ok' });
    const cards = [];
    if (D.eta != null && isFinite(D.eta)) cards.push(['Isentropic efficiency', fpct(D.eta)]);
    if (['turbine', 'compressor', 'pump'].includes(kind)) cards.push([kind === 'turbine' ? 'Power out' : 'Power in', fpow(Math.abs(D.Wdot))], ['Work per kg', fx(Math.abs(D.w), 2) + ' kJ/kg']);
    if (kind === 'nozzle') cards.push(['Exit velocity', fx(D.V2, 1) + ' m/s']);
    if (kind === 'heater') cards.push(['Heat transfer', fpow(D.Qdot)]);
    cards.push(['Δh', fx(D.s2.h - D.s1.h, 2) + ' kJ/kg'], ['Δs', fx(D.ds, 4) + ' kJ/kg·K'], ['Entropy generation σ̇', (+D.sigma.toPrecision(4)) + ' kW/K'], ['Exergy destroyed T₀σ̇', fpow(D.Ed)]);
    if (D.s2.x != null) cards.push(['Exit quality', fx(D.s2.x, 4)]);
    blocks.push({ t: 'cards', items: cards });
    const rows = [['1', D.s1], ['2', D.s2]];
    if (D.s2s && Math.abs(D.s2s.h - D.s2.h) > 1e-6) rows.push(['2s', D.s2s]);
    blocks.push({ t: 'table', title: 'States', head: ['State', 'T', 'p', 'h (kJ/kg)', 's (kJ/kg·K)', 'x'], rows: rows.map(([n, s]) => [n, fT(s.T), fp(s.p), fx(s.h, 2), fx(s.s, 4), s.x != null ? fx(s.x, 4) : '—']) });
    blocks.push({ t: 'note', text: 'Steady flow, adiabatic unless it\'s a heat exchanger: 0 = Q̇ − Ẇ + ṁ[(h₁ − h₂) + (V₁² − V₂²)/2]; σ̇ = ṁ(s₂ − s₁) − Q̇/T_b.' });
    out.analyses.push({ title: `${DEV_TITLE[d.sym]} — ${subName[sub]}`, blocks });
  }

  // =========================================================================================
  function analyze(page) {
    const out = { analyses: [], annots: [], comps: {} };
    const all = (page.symbols || []).map(s => ({ ...s, props: s.props || {} }));
    const wires = [];
    // WIRE symbols are just straight wires t0 → t1, so every analyser (circuit nets, thermo pipes,
    // mechanics ropes) sees them as lines.
    for (const s of all) if (s.sym === 'WIRE' && s.terms && dist(s.terms[0], s.terms[1]) >= 1) wires.push({ i: s.i, kind: 'line', pts: [s.terms[0].slice(), s.terms[1].slice()], fromSym: true });
    const syms = all.filter(s => s.sym !== 'WIRE');
    for (const w of page.wires || []) {
      if (!w.pts || w.pts.length < 2) continue;
      if (w.kind === 'ink') { const s = wireLike(w.pts); if (s) wires.push({ ...w, pts: s }); }
      else wires.push(w);
    }
    try { circuit(syms, wires, out); } catch (e) { out.analyses.push({ title: 'Circuit', blocks: [{ t: 'err', text: 'Analysis failed: ' + e.message }] }); }
    LINKS = emptyLinks();
    try { LINKS = linkReservoirs(syms, wires); } catch (e) { out.analyses.push({ title: 'Thermal reservoirs', blocks: [{ t: 'err', text: 'Linking failed: ' + e.message }] }); }
    try { reservoirs(syms, out); } catch (e) { out.analyses.push({ title: 'Reservoirs', blocks: [{ t: 'err', text: 'Analysis failed: ' + e.message }] }); }
    // Heat lines from reservoir symbols aren't pipes — keep them out of the flow-path walk.
    try { thermo(syms, wires.filter(w => !LINKS.heatWires.has(w)), out); } catch (e) { out.analyses.push({ title: 'Thermo', blocks: [{ t: 'err', text: 'Analysis failed: ' + e.message }] }); }
    try { reservoirReport(out); } catch (e) { out.analyses.push({ title: 'Thermal reservoirs', blocks: [{ t: 'err', text: 'Analysis failed: ' + e.message }] }); }
    // Statics / pulleys / buoyancy live in ink-mechanics.js (same out object, same helpers).
    if (typeof InkMechanics !== 'undefined') {
      try { InkMechanics.analyze(syms, wires, out, HELPERS); } catch (e) { out.analyses.push({ title: 'Mechanics', blocks: [{ t: 'err', text: 'Analysis failed: ' + e.message }] }); }
    }
    // Final pass: move value labels and result chips so they don't sit on wires, symbols or each other.
    try { placeAll(out, syms, wires); } catch (_) { /* placement is cosmetic */ }
    if (!out.analyses.length) {
      out.analyses.push({ title: 'Nothing to analyse yet', blocks: [{ t: 'note', text: 'Place circuit or thermo symbols from the symbols menu and connect them with lines (straight strokes or the line tool). Circuits get node voltages and currents (add V+ / V− probes to measure across a part); pumps, turbines, compressors, heat exchangers and valves joined in a loop are recognised as Rankine, Brayton or refrigeration cycles; a heat engine or refrigerator symbol gets the second-law check, with hot / cold reservoirs linked by lines.' }] });
    }
    return out;
  }

  // =========================================================================================
  // SMART PLACEMENT (contract §4)
  // =========================================================================================
  // Every value label (comps[i].labelAt) and result chip is moved to the nearby spot that clashes
  // least with wires, symbol bodies and the labels/chips already placed. Candidates are scored, and
  // since every penalty is ≥ 0 the scan stops once a candidate's own distance cost can't win.
  const PAGE_W = 816, PAGE_H = 1056;
  const textLen = (t) => [...String(t).replace(/_/g, '').replace(/[̀-ͯ]/g, '')].length;
  const labelW = (t) => 6.3 * textLen(t);
  const chipW = (t) => 5.8 * textLen(t) + 10;
  // Text box for a baseline anchor: 11 units tall, ~9 above the baseline and 2 below.
  function labelRect(x, y, align, w) { const l = align === 'left' ? x : align === 'right' ? x - w : x - w / 2; return { l, r: l + w, t: y - 9, b: y + 2 }; }
  const chipRect = (x, y, w) => ({ l: x - w / 2, r: x + w / 2, t: y - 7.5, b: y + 7.5 });
  // Anchor so the text box touches point p on the side `dir` points to.
  function anchorAt(p, dir) {
    const [dx, dy] = dir;
    if (Math.abs(dx) < 0.38) return { x: p[0], y: dy < 0 ? p[1] - 2 : p[1] + 9, align: 'center' };
    const align = dx > 0 ? 'left' : 'right';
    if (Math.abs(dy) < 0.38) return { x: p[0], y: p[1] + 3.5, align };
    return { x: p[0], y: dy < 0 ? p[1] - 2 : p[1] + 9, align };
  }
  const DISTS = [3, 8, 14, 22, 32, 44];
  function labelCands(s) {
    const c = [];
    if (s.inline) {
      const [a, b] = s.terms, L = dist(a, b) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], [nx, ny] = labelSide(s);
      const h = Math.max(s.half || 8, 4), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      for (const side of [1, -1]) for (const d of DISTS) for (const sh of [0, 0.25, -0.25, 0.45, -0.45]) {
        c.push({ p: [m[0] + side * nx * (h + d) + u[0] * sh * L, m[1] + side * ny * (h + d) + u[1] * sh * L], dir: [side * nx, side * ny], cost: d * 0.5 + Math.abs(sh) * L * 0.2 + (side < 0 ? 3 : 0) });
      }
      for (const [e, sg] of [[b, 1], [a, -1]]) for (const d of [4, 12, 22]) c.push({ p: [e[0] + sg * u[0] * d, e[1] + sg * u[1] * d], dir: [sg * u[0], sg * u[1]], cost: 14 + d * 0.5 });
    } else {
      // Local half-size (boxMap falls back to page units when w/h are missing).
      const m = boxMap(s), ctr = m.toPage([0, 0]), hw = (s.w || Math.abs(s.box[2] - s.box[0])) / 2, hh = (s.h || Math.abs(s.box[3] - s.box[1])) / 2;
      // Above first (box chips usually sit below), then right, below, left, then the corners.
      const spots = [[0, -hh], [hw, 0], [0, hh], [-hw, 0], [hw, -hh], [-hw, -hh], [hw, hh], [-hw, hh]];
      spots.forEach(([lx, ly], rank) => {
        const P = m.toPage([lx, ly]), vx = P[0] - ctr[0], vy = P[1] - ctr[1], n = Math.hypot(vx, vy);
        if (!(n > 0.5)) return;
        const dir = [vx / n, vy / n];
        for (const d of DISTS) c.push({ p: [P[0] + dir[0] * d, P[1] + dir[1] * d], dir, cost: d * 0.5 + rank * 2 });
      });
    }
    return c.sort((x, y) => x.cost - y.cost);
  }
  // Ring of offsets around a chip's own point (small moves first; vertical moves slightly cheaper,
  // since chips are wide and short).
  const RING = (() => {
    const r = [[0, 0, 0]];
    for (const rad of [7, 14, 22, 32, 44, 58, 74]) { const n = rad < 20 ? 8 : 16; for (let k = 0; k < n; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / n, dx = rad * Math.cos(a), dy = rad * Math.sin(a); r.push([dx, dy, 0.45 * Math.hypot(dx, dy * 0.8)]); } }
    return r.sort((a, b) => a[2] - b[2]);
  })();

  function placeAll(out, syms, wires) {
    const M = 2;   // clearance kept around every text box
    const segs = [];
    for (const w of wires) for (let k = 1; k < w.pts.length; k++) {
      const a = w.pts[k - 1], b = w.pts[k];
      segs.push({ a, b, l: Math.min(a[0], b[0]), r: Math.max(a[0], b[0]), t: Math.min(a[1], b[1]), bt: Math.max(a[1], b[1]) });
    }
    const bodies = syms.filter(s => (s.inline ? s.terms : s.box)).map(s => {
      const o = obbOf(s, 0), ex = Math.abs(o.u[0]) * o.hu + Math.abs(o.v[0]) * o.hv, ey = Math.abs(o.u[1]) * o.hu + Math.abs(o.v[1]) * o.hv;
      return { s, o, l: o.c[0] - ex, r: o.c[0] + ex, t: o.c[1] - ey, b: o.c[1] + ey };
    });
    const placed = [];
    const clash = (R, skip, soft) => {
      const E = { l: R.l - M, t: R.t - M, r: R.r + M, b: R.b + M };
      const eo = { c: [(E.l + E.r) / 2, (E.t + E.b) / 2], u: [1, 0], v: [0, 1], hu: (E.r - E.l) / 2, hv: (E.b - E.t) / 2 };
      let pen = 0;
      if (R.l < 0 || R.t < 0 || R.r > PAGE_W || R.b > PAGE_H) pen += 40;
      for (const g of segs) {
        if (g.r < E.l || g.l > E.r || g.bt < E.t || g.t > E.b) continue;
        const L = segClipLen(g.a, g.b, eo);
        if (L >= 0) pen += 60 + 3 * L;
      }
      for (const B of bodies) {
        if (B.r < E.l || B.l > E.r || B.b < E.t || B.t > E.b || (skip && skip.has(B.s))) continue;
        if (obbOverlap(eo, B.o)) pen += 90;
      }
      for (const Q of placed) {
        const ox = Math.min(E.r, Q.r) - Math.max(E.l, Q.l), oy = Math.min(E.b, Q.b) - Math.max(E.t, Q.t);
        if (ox > 0 && oy > 0) pen += 150 + ox * oy;
      }
      if (soft) for (const Q of soft) {
        const ox = Math.min(E.r, Q.r) - Math.max(E.l, Q.l), oy = Math.min(E.b, Q.b) - Math.max(E.t, Q.t);
        if (ox > 0 && oy > 0) pen += 40 + 0.5 * ox * oy;
      }
      return pen;
    };
    // Badges (state numbers on pipes) and other fixed annotations stay put but are obstacles.
    for (const a of out.annots) {
      if (a.kind === 'chip' || !isFinite(a.x) || !isFinite(a.y)) continue;
      if (a.kind === 'badge') placed.push({ l: a.x - 9, r: a.x + 9, t: a.y - 9, b: a.y + 9 });
      else if (a.text) placed.push(chipRect(a.x, a.y, chipW(a.text)));
    }
    // 1. Value labels. Chips haven't moved yet, so their intended spots are soft obstacles — a label
    // shouldn't grab the place a result was meant to go.
    const chipSpots = out.annots.filter(a => a.kind === 'chip' && isFinite(a.x) && isFinite(a.y)).map(a => chipRect(a.x, a.y, chipW(a.text || '')));
    for (const s of syms) {
      const c = out.comps[s.i];
      if (!c || blank(c.label) || !(s.inline ? s.terms : s.box)) continue;
      const w = labelW(c.label);
      let best = null;
      for (const cand of labelCands(s)) {
        if (best && cand.cost >= best.score) break;
        const A = anchorAt(cand.p, cand.dir), R = labelRect(A.x, A.y, A.align, w), score = cand.cost + clash(R, null, chipSpots);
        if (!best || score < best.score) best = { A, R, score };
      }
      if (!best) continue;
      c.anchor = centerOf(s).map(v => +v.toFixed(1));
      c.labelAt = { x: +best.A.x.toFixed(1), y: +best.A.y.toFixed(1), align: best.A.align };
      placed.push(best.R);
    }
    // 2. Result chips: nudge each off wires / symbols / labels / earlier chips, staying close to its point.
    for (const a of out.annots) {
      if (a.kind !== 'chip' || !isFinite(a.x) || !isFinite(a.y)) continue;
      const w = chipW(a.text || '');
      // A chip whose own point is inside a symbol was put there on purpose (e.g. Q_H on the
      // heat-engine diagram) — that body doesn't count against it.
      const skip = new Set(bodies.filter(B => inObb([a.x, a.y], B.o)).map(B => B.s));
      let best = null;
      for (const [dx, dy, cost] of RING) {
        if (best && cost >= best.score) break;
        const R = chipRect(a.x + dx, a.y + dy, w), score = cost + clash(R, skip);
        if (!best || score < best.score) best = { dx, dy, R, score };
      }
      a.x = +(a.x + best.dx).toFixed(1); a.y = +(a.y + best.dy).toFixed(1);
      placed.push(best.R);
    }
  }

  const HELPERS = { TOL, dist, segDist, polyDist, polyLen, rdp, midpointOf, boxMap, centerOf, labelSide, chipSpot, UF, qty, blank, num, fT, fp, fx, fpct, fpow, si, pt, siVal, fld, fieldSpec, obbOf, inObb, segClipLen, obbOverlap, touchesSym };
  return { analyze, helpers: HELPERS, _test: { wireLike, qty, boxMap, siVal, labelRect, chipRect, chipW, labelW, obbOf, segClipLen, placeAll } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = InkAnalysis;
