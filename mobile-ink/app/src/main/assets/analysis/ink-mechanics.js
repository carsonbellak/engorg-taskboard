// EngInk drawing analysis — MECHANICS: trusses, beams/frames, supports, loads, ropes & pulleys,
// blocks on inclines and buoyancy. Deterministic geometry + linear algebra, no AI.
//
// Called from ink-analysis.js analyze() as InkMechanics.analyze(syms, wires, out, H) after the
// circuit / thermo passes (H = InkAnalysis.helpers). Results go into the shared `out`
// ({ analyses, annots, comps }) exactly like the other analysers (analysis-contract §3, §5).
//
// CONVENTIONS
// • Page geometry is in page units with y DOWN. All mechanics runs in a physics frame: x right,
//   y UP, metres, newtons, counter-clockwise (↺) moments positive. Page → physics:
//   X = x / ppm, Y = −y / ppm, where ppm = page units per metre.
// • Scale: by default 1 grid square (32 page units) = 1 m. A MEMBER prop L (its real length)
//   recalibrates the whole page; conflicting L's give a warning and the first one wins.
// • g = 9.81 m/s² along −Y; weights W = m g. Units typed into fields are parsed here (N, kN, lbf,
//   kN·m, kN/m, kg, L, cm³ …); if any load or length is in US units, results are shown in lb / ft.
// • Members: axial force N, tension positive "(T)", compression negative "(C)".
// • Reactions are components on the physics axes (A_x +→, A_y +↑, M_A +↺); a roller-type support
//   gives one reaction perpendicular to its base (its local y axis), a collar ⟂ to its rod (local x).
// • Beam diagrams: x runs along the beam from its left (or lower) end. V(x) = Σ transverse forces on
//   the segment left of the cut (Hibbeler: positive shear acts downward on the left segment's cut
//   face); M(x) is sagging-positive (bottom fibre in tension for a horizontal beam).
// • Ropes are ideal (massless, inextensible) and pulleys ideal (massless, frictionless), so one
//   continuous rope has one tension; a spring in a rope carries the same tension (extension T/k).
//
// STRUCTURES. MEMBER terminals within TOL merge into joints (as do HINGE centres, support pins,
// FORCE ends, rope / mass attach points). A load or support touching a member's interior splits it.
// With loads only at joints → pin-jointed TRUSS (2 dof per joint, axial only). Any mid-member load,
// DIST_LOAD, couple MOMENT, FIXED_SUPPORT, internal hinge or T-junction → FRAME (3 dof per joint,
// axial + bending; member-to-member joints are rigid unless a HINGE releases the moment). Both are
// solved by the direct stiffness method with supports as Lagrange-multiplier constraints, uniform EA
// (and EI): exact for statically determinate structures, "equal EA / EI" for indeterminate ones.
// A singular system = unstable structure (mechanism), reported as such.
//
// ROPES & BODIES. Wires (and SPRING symbols) are rope strands. Strands meeting at a pulley wheel, or
// end-to-end, belong to one rope; three or more ends meeting is a knot (a massless particle). Bodies
// are MASS / CART blocks, movable pulleys (with what hangs on their hook) and knots. A 2-D static
// solve (least squares over tensions T, normal forces N and friction f) is tried first; if
// equilibrium is impossible, or friction can't hold, a 1-dof-per-body dynamic solve with rope-length
// constraints gives accelerations and tensions (Atwood machines, incline + hanging mass, …).
//
// BUOYANCY. WATER_TANK water = its local y −36 … 56. A block overlapping it gets F_b = ρ_f g V_sub. A
// free block floats (fraction submerged ρ/ρ_f), sinks (a = (W − F_b)/m, drag ignored) or is
// neutral; a tether to the tank or a rope from above falls out of the static solve (T = F_b − W,
// apparent weight T = W − F_b). With a real `depth`, gauge pressure p = ρ g h.
const InkMechanics = (() => {
  const G = 9.81, GRID = 32, LBF = 4.4482216152605, LBFT = 1.3558179483314, LBPFT = 14.593902937;
  const DEG = Math.PI / 180;
  const MECH = new Set(['MEMBER', 'FORCE', 'ROCKER', 'COLLAR', 'SLIDER', 'HINGE', 'MOVABLE_PULLEY', 'MASS', 'DIST_LOAD', 'INCLINE', 'WATER_TANK',
    'PIN_SUPPORT', 'ROLLER_SUPPORT', 'FIXED_SUPPORT', 'GROUND_SURFACE', 'SPRING', 'DAMPER', 'CART', 'PULLEY', 'MOMENT_CCW', 'MOMENT_CW']);
  const SUPPORTS = new Set(['PIN_SUPPORT', 'ROLLER_SUPPORT', 'ROCKER', 'FIXED_SUPPORT', 'COLLAR', 'SLIDER']);
  const TITLE = {
    MEMBER: 'Truss member', FORCE: 'Force', ROCKER: 'Rocker support', COLLAR: 'Collar on smooth rod', SLIDER: 'Pin in smooth slot',
    HINGE: 'Hinge (internal pin)', MOVABLE_PULLEY: 'Movable pulley', MASS: 'Mass', DIST_LOAD: 'Distributed load', INCLINE: 'Incline',
    WATER_TANK: 'Water tank', PIN_SUPPORT: 'Pin support', ROLLER_SUPPORT: 'Roller support', FIXED_SUPPORT: 'Fixed support',
    GROUND_SURFACE: 'Ground / ceiling', SPRING: 'Spring', DAMPER: 'Damper', CART: 'Cart', PULLEY: 'Fixed pulley',
    MOMENT_CCW: 'Couple moment ↺', MOMENT_CW: 'Couple moment ↻',
  };
  const FLUIDS = { water: 1000, seawater: 1025, oil: 900 };

  // Bound per call from H (ink-analysis helpers).
  let H, TOL, dist, segDist, polyLen, midpointOf, boxMap;
  let FMT = { us: false, zero: 1e-9 };
  let LAST = null;   // raw numbers of the last run (for tests / debugging)

  // =========================================================================================
  // small linear algebra
  // =========================================================================================
  const zeros = (n) => new Array(n).fill(0);
  const zeros2 = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
  // Square solve, Gaussian elimination with row equilibration + partial pivoting. A pivot that
  // vanishes means the system is singular (an unstable structure / undetermined motion).
  function solveSq(A, b) {
    const n = b.length, M = A.map(r => r.slice()), y = b.slice();
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = 0; j < n; j++) m = Math.max(m, Math.abs(M[i][j]));
      if (m > 0) { for (let j = 0; j < n; j++) M[i][j] /= m; y[i] /= m; }
    }
    for (let c = 0; c < n; c++) {
      let p = c, best = Math.abs(M[c][c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(M[r][c]); if (v > best) { best = v; p = r; } }
      if (!(best > 1e-11)) return { singular: c };
      if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; const u = y[p]; y[p] = y[c]; y[c] = u; }
      const Mc = M[c], piv = Mc[c];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / piv;
        if (!f) continue;
        const Mr = M[r];
        for (let j = c; j < n; j++) Mr[j] -= f * Mc[j];
        y[r] -= f * y[c];
      }
    }
    const x = zeros(n);
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return { x };
  }
  // Least squares A x ≈ b (A is m×n). Returns the (minimum-norm when rank deficient) solution, the
  // numerical rank and the max residual — a residual > 0 means "no equilibrium is possible".
  function lsq(A, b, n) {
    if (!n) return { x: [], rank: 0, res: b.reduce((m, v) => Math.max(m, Math.abs(v)), 0) };
    const N = zeros2(n, n), r = zeros(n);
    for (let k = 0; k < A.length; k++) {
      const row = A[k];
      for (let i = 0; i < n; i++) { if (!row[i]) continue; r[i] += row[i] * b[k]; for (let j = 0; j < n; j++) N[i][j] += row[i] * row[j]; }
    }
    // Rank by symmetric diagonal pivoting on the normal matrix.
    const W = N.map(x => x.slice());
    let maxd = 0;
    for (let i = 0; i < n; i++) maxd = Math.max(maxd, W[i][i]);
    const tol = 1e-10 * (maxd || 1);
    let rank = 0;
    const done = new Array(n).fill(false);
    for (let k = 0; k < n; k++) {
      let p = -1;
      for (let j = 0; j < n; j++) if (!done[j] && (p < 0 || W[j][j] > W[p][p])) p = j;
      if (p < 0 || !(W[p][p] > tol)) break;
      done[p] = true; rank++;
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        const f = W[i][p] / W[p][p];
        if (!f) continue;
        for (let j = 0; j < n; j++) W[i][j] -= f * W[p][j];
      }
    }
    // Tiny Tikhonov term → the minimum-norm solution when the tensions are indeterminate.
    const lam = rank < n ? 1e-9 * (maxd || 1) : 0;
    const Nr = N.map((row, i) => row.map((v, j) => v + (i === j ? lam : 0)));
    const s = solveSq(Nr, r);
    const x = s.x || zeros(n);
    let res = 0;
    for (let k = 0; k < A.length; k++) { let v = -b[k]; for (let i = 0; i < n; i++) v += A[k][i] * x[i]; res = Math.max(res, Math.abs(v)); }
    return { x, rank, res };
  }

  // =========================================================================================
  // units & formatting
  // =========================================================================================
  const UNIT = {
    F: { '': 1, n: 1, kn: 1e3, mn: 1e6, k: 1e3, lbf: LBF, lb: LBF, lbs: LBF, kip: 1e3 * LBF, kips: 1e3 * LBF },
    M: { '': 1, nm: 1, knm: 1e3, mnm: 1e6, nmm: 1e-3, knmm: 1, lbfft: LBFT, lbft: LBFT, ftlb: LBFT, ftlbf: LBFT, kipft: 1e3 * LBFT, lbfin: LBFT / 12, lbin: LBFT / 12, inlb: LBFT / 12 },
    w: { '': 1, 'n/m': 1, 'kn/m': 1e3, 'n/mm': 1e3, 'kn/mm': 1e6, 'lbf/ft': LBPFT, 'lb/ft': LBPFT, 'kip/ft': 1e3 * LBPFT, 'lbf/in': 12 * LBPFT, 'lb/in': 12 * LBPFT },
    L: { '': 1, m: 1, mm: 1e-3, cm: 1e-2, km: 1e3, ft: 0.3048, in: 0.0254, "'": 0.3048, '"': 0.0254 },
    m: { '': 1, kg: 1, g: 1e-3, t: 1e3, lb: 0.45359237, lbm: 0.45359237, lbs: 0.45359237, slug: 14.593902937 },
    V: { '': 1, m3: 1, l: 1e-3, ml: 1e-6, cm3: 1e-6, cc: 1e-6, mm3: 1e-9, ft3: 0.028316846592, in3: 1.6387064e-5, gal: 3.785411784e-3 },
    rho: { '': 1, 'kg/m3': 1, 'g/cm3': 1e3, 'g/cc': 1e3, 'g/ml': 1e3, 'kg/l': 1e3, 'lb/ft3': 16.018463374, 'lbm/ft3': 16.018463374, 'slug/ft3': 515.378818 },
    k: { '': 1, 'n/m': 1, 'kn/m': 1e3, 'n/mm': 1e3, 'n/cm': 100, 'lbf/in': 12 * LBPFT, 'lb/in': 12 * LBPFT, 'lbf/ft': LBPFT, 'lb/ft': LBPFT },
    deg: { '': 1, '°': 1, deg: 1, rad: 180 / Math.PI },
    n: { '': 1 },
  };
  const NUMRE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i;
  // Typed value → SI number; null when blank, NaN when unreadable.
  function parseQ(v, kind) {
    if (v == null) return null;
    const s = String(v).trim().replace(/[−–]/g, '-').replace(/,/g, '');
    if (!s) return null;
    const m = s.match(NUMRE);
    if (!m) return NaN;
    const n = parseFloat(m[0]);
    const u = s.slice(m[0].length).toLowerCase().replace(/[\s·*⋅•.\-^]/g, '').replace(/³/g, '3').replace(/²/g, '2');
    const tab = UNIT[kind] || UNIT.n;
    if (!(u in tab)) return NaN;
    return n * tab[u];
  }
  const isUS = (v) => { if (v == null) return false; const u = String(v).toLowerCase().replace(NUMRE, '').trim(); return /lb|kip|ft|^in$|\/in|'|"/.test(u); };
  const sig = (v, p = 3) => { if (v == null || !isFinite(v)) return '—'; const r = +(+v).toPrecision(p); return String(r === 0 ? 0 : r); };
  function fF(N) {
    if (N == null || !isFinite(N)) return '—';
    if (Math.abs(N) < FMT.zero) return '0';
    if (FMT.us) { const lb = N / LBF; return Math.abs(lb) >= 1000 ? sig(lb / 1000) + ' kip' : sig(lb) + ' lb'; }
    return Math.abs(N) >= 1000 ? sig(N / 1000) + ' kN' : sig(N) + ' N';
  }
  function fM(Nm) {
    if (Nm == null || !isFinite(Nm)) return '—';
    if (Math.abs(Nm) < FMT.zero) return '0';
    if (FMT.us) { const v = Nm / LBFT; return Math.abs(v) >= 1000 ? sig(v / 1000) + ' kip·ft' : sig(v) + ' lb·ft'; }
    return Math.abs(Nm) >= 1000 ? sig(Nm / 1000) + ' kN·m' : sig(Nm) + ' N·m';
  }
  const fL = (m) => (m == null || !isFinite(m) ? '—' : FMT.us ? sig(m / 0.3048) + ' ft' : sig(m) + ' m');
  const fA = (a) => (a == null || !isFinite(a) ? '—' : Math.abs(a) < 1e-9 ? '0' : sig(Math.abs(a)) + ' m/s²');
  const fKg = (m) => sig(m) + ' kg';
  const fPa = (p) => (Math.abs(p) >= 1e6 ? sig(p / 1e6) + ' MPa' : Math.abs(p) >= 1e3 ? sig(p / 1e3) + ' kPa' : sig(p) + ' Pa');
  const fDx = (m) => (FMT.us ? sig(m / 0.0254) + ' in' : Math.abs(m) >= 1 ? sig(m) + ' m' : Math.abs(m) >= 0.01 ? sig(m * 100) + ' cm' : sig(m * 1000) + ' mm');
  const arrowX = (v) => (Math.abs(v) < FMT.zero ? '' : v > 0 ? ' →' : ' ←');
  const arrowY = (v) => (Math.abs(v) < FMT.zero ? '' : v > 0 ? ' ↑' : ' ↓');
  const arrowM = (v) => (Math.abs(v) < FMT.zero ? '' : v > 0 ? ' ↺' : ' ↻');
  // Plot axis units for forces / moments (keeps numbers readable).
  function plotUnit(maxAbs, moment) {
    if (FMT.us) { const base = moment ? LBFT : LBF; return maxAbs / base >= 1000 ? { k: 1 / (1000 * base), u: moment ? 'kip·ft' : 'kip' } : { k: 1 / base, u: moment ? 'lb·ft' : 'lb' }; }
    return maxAbs >= 1000 ? { k: 1e-3, u: moment ? 'kN·m' : 'kN' } : { k: 1, u: moment ? 'N·m' : 'N' };
  }

  // =========================================================================================
  // geometry
  // =========================================================================================
  const P = (s, x, y) => boxMap(s).toPage([x, y]);
  const scaleOf = (s) => { const m = boxMap(s); return (Math.abs(m.sx) + Math.abs(m.sy)) / 2 || 1; };
  const unit = (v) => { const L = Math.hypot(v[0], v[1]); return L > 0 ? [v[0] / L, v[1] / L] : [0, 0]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const neg = (a) => [-a[0], -a[1]];
  // Page a → b as a PHYSICS unit vector (y flipped).
  const pdir = (a, b) => unit([b[0] - a[0], -(b[1] - a[1])]);
  const localDir = (s, x, y) => pdir(P(s, 0, 0), P(s, x, y));
  function projSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, tc = Math.max(0, Math.min(1, t));
    const q = [a[0] + tc * dx, a[1] + tc * dy];
    return { t, q, d: dist(p, q), dLine: Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.sqrt(L2) };
  }
  // Snap a direction to the nearest axis when it's within `deg` of it (hand-drawn ropes).
  function snapDir(u, deg = 7) {
    const a = Math.atan2(u[1], u[0]), q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
    return Math.abs(a - q) <= deg * DEG ? [Math.round(Math.cos(q)) || 0, Math.round(Math.sin(q)) || 0] : u;
  }
  function pinOf(s) { return s.sym === 'PIN_SUPPORT' || s.sym === 'ROLLER_SUPPORT' || s.sym === 'ROCKER' ? P(s, 0, -14) : P(s, 0, 0); }
  // Distance from a page point to a local rectangle of a BOX symbol (0 inside).
  function rectDist(s, p, x0, y0, x1, y1) {
    const m = boxMap(s), [lx, ly] = m.toLocal(p);
    const dx = Math.max(x0 - lx, 0, lx - x1) * Math.abs(m.sx), dy = Math.max(y0 - ly, 0, ly - y1) * Math.abs(m.sy);
    return Math.hypot(dx, dy);
  }
  const massRect = (s) => (s.sym === 'CART' ? [-28, -28, 28, 28] : [-24, -20, 24, 20]);
  const massDist = (s, p) => rectDist(s, p, ...massRect(s));
  const massTop = (s) => P(s, 0, massRect(s)[1]);
  const massBottomPts = (s) => { const [x0, y0, x1, y1] = massRect(s); return [P(s, 0, y1), P(s, x0, y1), P(s, x1, y1), P(s, x0, y0), P(s, x1, y0)]; };

  // =========================================================================================
  // entry
  // =========================================================================================
  function analyze(syms, wires, out, h) {
    LAST = { structures: [], systems: [], tanks: [], warns: [] };
    try { run(syms || [], wires || [], out, h); } catch (e) {
      out.analyses.push({ title: 'Mechanics', blocks: [{ t: 'err', text: 'Mechanics analysis failed: ' + e.message }] });
    }
  }

  function run(allSyms, wires, out, h) {
    H = h; TOL = h.TOL; dist = h.dist; segDist = h.segDist; polyLen = h.polyLen; midpointOf = h.midpointOf; boxMap = h.boxMap;
    FMT = { us: false, zero: 1e-9 };
    const syms = allSyms.filter(s => MECH.has(s.sym) && (s.inline ? s.terms && s.terms.length === 2 && s.terms.every(t => t && isFinite(t[0]) && isFinite(t[1])) : s.box && s.w && s.h));
    if (!syms.length) return;
    syms.forEach(s => { if (!s.props) s.props = {}; });
    const ctx = {
      out, syms, wires: (wires || []).filter(w => w && w.pts && w.pts.length >= 2 && w.pts.every(p => p && isFinite(p[0]) && isFinite(p[1]))),
      warns: [], names: new Map(), used: new Set(), ropeUsed: new Set(), ppm: GRID, tankObjs: new Map(), missing: [],
    };
    for (const s of syms) for (const k of ['F', 'M', 'w', 'L']) if (isUS(s.props[k])) FMT.us = true;
    calibrate(ctx);
    nameAll(ctx);
    const ext = [];   // point loads the rope / body pass hands to the structure pass
    const guard = (title, fn) => { try { fn(); } catch (e) { out.analyses.push({ title, blocks: [{ t: 'err', text: 'Analysis failed: ' + e.message }] }); } };
    guard('Ropes, pulleys and blocks', () => bodies(ctx, ext));
    guard('Structure', () => structures(ctx, ext));
    guard('Water tank', () => tanks(ctx));
    guard('Mechanics', () => leftovers(ctx));
    for (const s of syms) out.comps[s.i] = { name: ctx.names.get(s) || TITLE[s.sym], title: TITLE[s.sym], label: labelFor(ctx, s), fields: fieldsFor(s) };
    LAST.warns = ctx.warns.slice();
  }

  const toPhys = (ctx, p) => [p[0] / ctx.ppm, -p[1] / ctx.ppm];
  const toPage = (ctx, q) => [q[0] * ctx.ppm, -q[1] * ctx.ppm];
  const blank = (v) => v == null || String(v).trim() === '';

  // A MEMBER's typed length L sets page units per metre.
  function calibrate(ctx) {
    let first = null, conflict = false;
    for (const s of ctx.syms) {
      if (s.sym !== 'MEMBER' || blank(s.props.L)) continue;
      const L = parseQ(s.props.L, 'L'), pl = dist(s.terms[0], s.terms[1]);
      if (!(L > 0)) { ctx.warns.push(`Couldn't read the member length L = "${s.props.L}" — type a positive length like 2.5 m or 8 ft.`); continue; }
      if (!(pl > 4)) continue;
      const k = pl / L;
      if (first == null) first = k; else if (Math.abs(k / first - 1) > 0.02) conflict = true;
    }
    if (first) ctx.ppm = first;
    ctx.scaleSet = !!first;
    if (conflict) ctx.warns.push(`The member lengths L you typed don't all match the drawing's proportions — the first one sets the scale (1 grid square = ${fL(GRID / ctx.ppm)}).`);
  }
  const scaleNote = (ctx) => `Scale: 1 grid square = ${fL(GRID / ctx.ppm)}` + (ctx.scaleSet ? ' (from a member length L).' : ' — set a member\'s length L to rescale.');

  // Default names (masses m1, m2 … left → right; forces F1 …); joints get letters in the structure pass.
  function nameAll(ctx) {
    const PRE = { FORCE: 'F', MASS: 'm', CART: 'm', PULLEY: 'P', MOVABLE_PULLEY: 'P', SPRING: 'S', DAMPER: 'D', MOMENT_CCW: 'M', MOMENT_CW: 'M', DIST_LOAD: 'w', INCLINE: 'Incline ', WATER_TANK: 'Tank ', HINGE: 'Hinge ' };
    const pos = (s) => (s.inline ? [(s.terms[0][0] + s.terms[1][0]) / 2, (s.terms[0][1] + s.terms[1][1]) / 2] : P(s, 0, 0));
    const order = ctx.syms.slice().sort((a, b) => { const pa = pos(a), pb = pos(b); return Math.abs(pa[0] - pb[0]) > 8 ? pa[0] - pb[0] : pa[1] - pb[1]; });
    const cnt = {};
    for (const s of order) {
      if (!blank(s.props.name)) { ctx.names.set(s, String(s.props.name)); continue; }
      const pre = PRE[s.sym];
      if (!pre) continue;
      cnt[pre.trim()] = (cnt[pre.trim()] || 0) + 1;
      ctx.names.set(s, pre + cnt[pre.trim()]);
    }
  }
  const nameOf = (ctx, s) => ctx.names.get(s) || TITLE[s.sym];

  // Read a prop, falling back to a placeholder that the panel then warns about.
  const PLACEHOLDER = { F: '1 kN', M: '1 kN·m', w: '1 kN/m', m: '10 kg' };
  function need(ctx, s, key, kind, def, what) {
    const v = parseQ(s.props[key], kind);
    if (v == null || !isFinite(v)) {
      ctx.missing.push(`${nameOf(ctx, s)}'s ${what}${v != null ? ` (couldn't read "${s.props[key]}")` : ''} — using ${PLACEHOLDER[kind] || def}`);
      return def;
    }
    return v;
  }
  function takeMissing(ctx, blocks) {
    if (!ctx.missing.length) return;
    blocks.unshift({ t: 'warn', text: 'No value yet for ' + [...new Set(ctx.missing)].join('; ') + '. Tap the symbol to set it.' });
    ctx.missing = [];
  }
  function forceVec(ctx, f) {
    const F = need(ctx, f, 'F', 'F', 1000, 'force');
    let u = pdir(f.terms[0], f.terms[1]);
    const ang = parseQ(f.props.angle, 'deg');
    if (ang != null && isFinite(ang)) u = [Math.cos(ang * DEG), Math.sin(ang * DEG)];
    return [F * u[0], F * u[1]];
  }
  const massOf = (ctx, s) => { const m = need(ctx, s, 'm', 'm', 10, 'mass'); return m > 0 ? m : 10; };

  // =========================================================================================
  // STRUCTURES (trusses, beams, frames)
  // =========================================================================================
  function structures(ctx, ext) {
    const memSyms = ctx.syms.filter(s => s.sym === 'MEMBER' && dist(s.terms[0], s.terms[1]) > 4);
    if (!memSyms.length) return;
    const nodes = [];
    const nodeAt = (p) => {
      for (let k = 0; k < nodes.length; k++) {
        const n = nodes[k];
        if (dist(n.p, p) <= TOL) { n.pts.push(p); n.p = [n.pts.reduce((a, q) => a + q[0], 0) / n.pts.length, n.pts.reduce((a, q) => a + q[1], 0) / n.pts.length]; return k; }
      }
      nodes.push({ p: p.slice(), pts: [p.slice()], hinge: false });
      return nodes.length - 1;
    };
    const M = [];
    for (const s of memSyms) {
      const na = nodeAt(s.terms[0]), nb = nodeAt(s.terms[1]);
      if (na !== nb) M.push({ s, na, nb, splits: [] });
    }
    const A = (m) => nodes[m.na].p, B = (m) => nodes[m.nb].p;
    const why = new Map();   // node → reason the structure must be treated as a frame
    const flag = (k, r) => { if (!why.has(k)) why.set(k, r); };
    const splitAt = (m, t, node) => {
      const a = A(m), b = B(m), L = dist(a, b);
      if (t * L <= TOL) return m.na;
      if ((1 - t) * L <= TOL) return m.nb;
      for (const sp of m.splits) if (Math.abs(sp.t - t) * L <= TOL) return sp.node;
      if (node == null) { nodes.push({ p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], pts: [], hinge: false, split: true }); node = nodes.length - 1; }
      m.splits.push({ t, node });
      return node;
    };
    // Where a point lands on the structure: an existing joint, else a member's interior (split).
    const attach = (p, tol, mid = true) => {
      let best = -1, bd = tol;
      nodes.forEach((n, k) => { const d = dist(n.p, p); if (d <= bd) { bd = d; best = k; } });
      if (best >= 0) return { node: best, mid: !!nodes[best].split };
      if (!mid) return null;
      let bm = null, bt = 0;
      bd = tol;
      for (const m of M) { const r = projSeg(p, A(m), B(m)); if (r.t > 0 && r.t < 1 && r.d <= bd) { bd = r.d; bm = m; bt = r.t; } }
      return bm ? { node: splitAt(bm, bt), mid: true } : null;
    };
    // A member ending on another member's interior (T-joint) connects there.
    for (const m of M) for (const k of [m.na, m.nb]) for (const o of M) {
      if (o === m || o.na === k || o.nb === k) continue;
      const r = projSeg(nodes[k].p, A(o), B(o)), L = dist(A(o), B(o));
      if (r.d <= TOL && r.t * L > TOL && (1 - r.t) * L > TOL) { splitAt(o, r.t, k); flag(k, 'a member ends part-way along another'); }
    }
    for (const s of ctx.syms.filter(x => x.sym === 'HINGE')) {
      const r = attach(P(s, 0, 0), TOL + 4);
      if (!r) continue;
      nodes[r.node].hinge = true; ctx.used.add(s);
      if (r.mid) flag(r.node, 'an internal hinge');
    }
    // Supports
    const sups = [];
    for (const s of ctx.syms.filter(x => SUPPORTS.has(x.sym))) {
      let r = null;
      if (s.sym === 'FIXED_SUPPORT') {
        const w0 = P(s, 8, -32), w1 = P(s, 8, 32);
        let best = -1, bd = TOL + 2;
        nodes.forEach((n, k) => { if (n.split) return; const d = segDist(n.p, w0, w1); if (d <= bd) { bd = d; best = k; } });
        if (best >= 0) r = { node: best };
      } else r = attach(pinOf(s), TOL + 4);
      if (!r) continue;
      if (sups.some(x => x.node === r.node)) { ctx.warns.push(`Two supports sit on the same joint — only the first is used.`); ctx.used.add(s); continue; }
      let n = null;
      if (s.sym === 'ROLLER_SUPPORT' || s.sym === 'ROCKER' || s.sym === 'SLIDER') n = snapDir(neg(localDir(s, 0, 1)), 0.5);
      else if (s.sym === 'COLLAR') n = snapDir(localDir(s, 1, 0), 0.5);
      sups.push({ s, node: r.node, n });
      ctx.used.add(s);
      if (r.mid) flag(r.node, 'a support part-way along a member');
      if (s.sym === 'FIXED_SUPPORT') flag(r.node, 'a fixed support');
    }
    // Loads
    const loads = [];
    for (const f of ctx.syms.filter(x => x.sym === 'FORCE' && !ctx.used.has(x))) {
      const [t0, t1] = f.terms;
      // Prefer the tip on a joint, then the tail, then either end on a member's interior.
      const r = attach(t1, TOL, false) || attach(t0, TOL, false) || attach(t1, TOL) || attach(t0, TOL);
      if (!r) continue;
      loads.push({ node: r.node, F: forceVec(ctx, f), M: 0, src: f });
      ctx.used.add(f);
      if (r.mid) flag(r.node, 'a load part-way along a member');
    }
    for (const e of ext) {
      const r = attach(e.p, TOL + 4);
      if (!r) continue;
      loads.push({ node: r.node, F: e.F, M: 0, src: e.src, what: e.what });
      if (r.mid) flag(r.node, 'a load part-way along a member');
    }
    for (const s of ctx.syms.filter(x => x.sym === 'MOMENT_CCW' || x.sym === 'MOMENT_CW')) {
      const r = attach(P(s, 0, 0), 26 * scaleOf(s));
      if (!r) continue;
      const Mv = need(ctx, s, 'M', 'M', 1000, 'moment');
      loads.push({ node: r.node, F: [0, 0], M: s.sym === 'MOMENT_CCW' ? Mv : -Mv, src: s });
      ctx.used.add(s);
      flag(r.node, 'a couple moment');
    }
    const dls = [];
    for (const s of ctx.syms.filter(x => x.sym === 'DIST_LOAD')) {
      const L0 = P(s, -48, 16), L1 = P(s, 48, 16), d = pdir(P(s, 0, -16), P(s, 0, 16));
      let w = null;
      for (const m of M) {
        const a = A(m), b = B(m), Lm = dist(a, b), r0 = projSeg(L0, a, b), r1 = projSeg(L1, a, b);
        if (r0.dLine > TOL + 6 || r1.dLine > TOL + 6) continue;
        const ta = Math.max(0, Math.min(r0.t, r1.t)), tb = Math.min(1, Math.max(r0.t, r1.t));
        if ((tb - ta) * Lm < 4) continue;
        if (w == null) w = need(ctx, s, 'w', 'w', 1000, 'load intensity');
        const na = splitAt(m, ta), nb = splitAt(m, tb);
        flag(na, 'a distributed load'); flag(nb, 'a distributed load');
        dls.push({ m, ta: ta * Lm <= TOL ? 0 : ta, tb: (1 - tb) * Lm <= TOL ? 1 : tb, q: [w * d[0], w * d[1]], s });
      }
      if (w != null) ctx.used.add(s);
    }
    // Elements: members cut at their split points.
    const els = [];
    for (const m of M) {
      const chain = [{ t: 0, node: m.na }, ...m.splits.slice().sort((x, y) => x.t - y.t), { t: 1, node: m.nb }];
      for (let k = 0; k + 1 < chain.length; k++) if (chain[k].node !== chain[k + 1].node) els.push({ m, a: chain[k].node, b: chain[k + 1].node, ta: chain[k].t, tb: chain[k + 1].t, q: [0, 0] });
    }
    for (const dl of dls) {
      const dt = TOL / (dist(A(dl.m), B(dl.m)) || 1);
      for (const e of els) if (e.m === dl.m) { const mid = (e.ta + e.tb) / 2; if (mid >= dl.ta - dt && mid <= dl.tb + dt) { e.q[0] += dl.q[0]; e.q[1] += dl.q[1]; } }
    }
    // Joint letters, left → right then top → bottom (Hibbeler style).
    const usedNodes = [...new Set(els.flatMap(e => [e.a, e.b]))].sort((a, b) => { const pa = nodes[a].p, pb = nodes[b].p; return Math.abs(pa[0] - pb[0]) > 4 ? pa[0] - pb[0] : pa[1] - pb[1]; });
    const letter = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + (i % 26)) + Math.floor(i / 26));
    const jname = new Map(usedNodes.map((k, i) => [k, letter(i)]));
    for (const sp of sups) if (!blank(sp.s.props.name)) jname.set(sp.node, String(sp.s.props.name));
    const jn = (k) => jname.get(k) || '?';
    for (const m of M) ctx.names.set(m.s, jn(m.na) + jn(m.nb));
    for (const sp of sups) ctx.names.set(sp.s, jn(sp.node));
    // Connected structures
    const uf = H.UF();
    els.forEach(e => uf.union(e.a, e.b));
    const groups = new Map();
    for (const e of els) { const r = uf.find(e.a); if (!groups.has(r)) groups.set(r, { els: [], nodes: new Set() }); const g = groups.get(r); g.els.push(e); g.nodes.add(e.a); g.nodes.add(e.b); }
    const multi = groups.size > 1;
    let gi = 0;
    for (const g of groups.values()) {
      gi++;
      const C = {
        els: g.els, nodes: [...g.nodes].sort((a, b) => usedNodes.indexOf(a) - usedNodes.indexOf(b)),
        sups: sups.filter(sp => g.nodes.has(sp.node)), loads: loads.filter(l => g.nodes.has(l.node)),
        why: [...new Set([...g.nodes].filter(k => why.has(k)).map(k => why.get(k)))],
      };
      C.frame = C.why.length > 0;
      solveStructure(ctx, C, nodes, jn, multi ? ' ' + gi : '');
    }
  }

  // Frame element stiffness in local axes (x along the member).
  function frameKl(L, EA, EI) {
    const a = EA / L, b = 12 * EI / L ** 3, c = 6 * EI / L ** 2, d = 4 * EI / L, e = 2 * EI / L;
    return [[a, 0, 0, -a, 0, 0], [0, b, c, 0, -b, c], [0, c, d, 0, -c, e], [-a, 0, 0, a, 0, 0], [0, -b, -c, 0, b, -c], [0, c, e, 0, -c, d]];
  }
  const rot6 = (c, s) => [[c, s, 0, 0, 0, 0], [-s, c, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, c, s, 0], [0, 0, 0, -s, c, 0], [0, 0, 0, 0, 0, 1]];
  const matVec = (A, v) => A.map(r => r.reduce((s, x, j) => s + x * v[j], 0));
  // Equivalent nodal loads of a uniform load q (global vector per metre) on an element, local axes.
  function udlLocal(e) {
    const qa = e.q[0] * e.c + e.q[1] * e.s, qt = -e.q[0] * e.s + e.q[1] * e.c, L = e.L;
    return { f: [qa * L / 2, qt * L / 2, qt * L * L / 12, qa * L / 2, qt * L / 2, -qt * L * L / 12], qa, qt };
  }

  function solveStructure(ctx, C, nodes, jn, suffix, forceFrame) {
    const frame = C.frame || !!forceFrame;
    const out = ctx.out, blocks = [];
    const ph = (k) => toPhys(ctx, nodes[k].p);
    const deg = new Map();
    C.els.forEach(e => { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); });
    // DOFs: (ux, uy[, θ]) per joint; at a hinge every member end gets its own θ (moment release).
    let nd = 0;
    const ND = new Map();
    for (const k of C.nodes) { const hinged = frame && nodes[k].hinge && deg.get(k) > 1; ND.set(k, frame ? [nd++, nd++, hinged ? -1 : nd++] : [nd++, nd++]); }
    for (const e of C.els) {
      const pa = ph(e.a), pb = ph(e.b);
      e.L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]); e.c = (pb[0] - pa[0]) / e.L; e.s = (pb[1] - pa[1]) / e.L;
      const da = ND.get(e.a), db = ND.get(e.b);
      e.dofs = frame ? [da[0], da[1], da[2] >= 0 ? da[2] : nd++, db[0], db[1], db[2] >= 0 ? db[2] : nd++] : [da[0], da[1], db[0], db[1]];
    }
    const rotDof = (k) => { if (!frame) return -1; const d = ND.get(k); if (d[2] >= 0) return d[2]; const e = C.els.find(x => x.a === k || x.b === k); return e.a === k ? e.dofs[2] : e.dofs[5]; };
    const Lavg = C.els.reduce((a, e) => a + e.L, 0) / C.els.length;
    // Uniform section: EA/EI = 10⁴/L² keeps axial strain negligible next to bending (as hand methods assume).
    const EI = 1, EA = frame ? 1e4 / (Lavg * Lavg) : 1;
    const n = nd, K = zeros2(n, n), F = zeros(n);
    for (const e of C.els) {
      let kg;
      if (frame) {
        const T = rot6(e.c, e.s), kl = frameKl(e.L, EA, EI);
        kg = zeros2(6, 6);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { let s = 0; for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) s += T[a][i] * kl[a][b] * T[b][j]; kg[i][j] = s; }
        if (e.q[0] || e.q[1]) { const fl = udlLocal(e).f; for (let i = 0; i < 6; i++) { let s = 0; for (let a = 0; a < 6; a++) s += T[a][i] * fl[a]; F[e.dofs[i]] += s; } }
      } else {
        const c = e.c, s = e.s, k = EA / e.L, m = [[c * c, c * s, -c * c, -c * s], [c * s, s * s, -c * s, -s * s], [-c * c, -c * s, c * c, c * s], [-c * s, -s * s, c * s, s * s]];
        kg = m.map(r => r.map(v => v * k));
      }
      const ne = e.dofs.length;
      for (let i = 0; i < ne; i++) for (let j = 0; j < ne; j++) K[e.dofs[i]][e.dofs[j]] += kg[i][j];
    }
    for (const l of C.loads) { const d = ND.get(l.node); F[d[0]] += l.F[0]; F[d[1]] += l.F[1]; if (l.M) { const r = rotDof(l.node); if (r >= 0) F[r] += l.M; } }
    // Support constraints (one row each).
    const cons = [];
    for (const sp of C.sups) {
      const d = ND.get(sp.node);
      const add = (coefs, dir, kind) => cons.push({ sp, coefs, dir, kind });
      if (sp.s.sym === 'PIN_SUPPORT' || sp.s.sym === 'FIXED_SUPPORT') { add([[d[0], 1]], [1, 0], 'x'); add([[d[1], 1]], [0, 1], 'y'); }
      else add([[d[0], sp.n[0]], [d[1], sp.n[1]]], sp.n, 'n');
      if (sp.s.sym === 'FIXED_SUPPORT' && frame) {
        if (d[2] >= 0) add([[d[2], 1]], null, 'm');
        else blocks.push({ t: 'warn', text: `The hinge at ${jn(sp.node)} releases the fixed support's moment — it acts as a pin.` });
      }
    }
    const nc = cons.length, m = C.els.length, j = C.nodes.length;
    const degree = (frame ? 3 : 1) * m + nc - n;
    const kindName = frame ? (isStraight(ctx, C, nodes) ? 'Beam' : 'Frame') : 'Truss';
    const title = `${kindName}${suffix} — ${frame ? 'reactions, shear and moment' : 'member forces'}`;
    const cRel = n - 3 * j;   // extra rotation unknowns released by hinges
    const countText = frame
      ? `3m + r = ${3 * m} + ${nc} = ${3 * m + nc} vs 3j${cRel ? ' + c' : ''} = ${n}` + (cRel ? ` (c = ${cRel} hinge release${cRel > 1 ? 's' : ''})` : '')
      : `m + r = ${m} + ${nc} = ${m + nc} vs 2j = ${2 * j}`;
    // Load scale → what counts as "zero" when printing.
    let scale = 0;
    for (const l of C.loads) scale = Math.max(scale, Math.hypot(l.F[0], l.F[1]), Math.abs(l.M) / (Lavg || 1));
    for (const e of C.els) scale = Math.max(scale, Math.hypot(e.q[0], e.q[1]) * e.L);
    FMT.zero = 1e-7 * Math.max(scale, 1e-6);
    const record = { kind: kindName.toLowerCase(), frame, degree, members: {}, reactions: {}, singular: false, joints: Object.fromEntries(C.nodes.map(k => [jn(k), nodes[k].p.slice()])) };
    LAST.structures.push(record);

    if (!C.sups.length) {
      blocks.push({ t: 'err', text: 'No supports touch this structure, so it isn\'t held in place. Put pin / roller / fixed supports under its joints (the support\'s pin must land on a joint or member).' });
      takeMissing(ctx, blocks);
      out.analyses.push({ title, blocks }); record.singular = true; return;
    }
    const NT = n + nc, Aug = zeros2(NT, NT), rhs = zeros(NT);
    for (let a = 0; a < n; a++) { for (let b = 0; b < n; b++) Aug[a][b] = K[a][b]; rhs[a] = F[a]; }
    cons.forEach((c, i) => { for (const [dof, v] of c.coefs) { Aug[n + i][dof] = v; Aug[dof][n + i] = v; } });
    const sol = solveSq(Aug, rhs);
    if (sol.singular != null) {
      // Two collinear members drawn as one beam are a truss mechanism but a fine beam: retry as a frame.
      if (!frame && isStraight(ctx, C, nodes)) { LAST.structures.pop(); return solveStructure(ctx, C, nodes, jn, suffix, true); }
      record.singular = true;
      let where = '';
      if (sol.singular < n) for (const [k, d] of ND) if (d.includes(sol.singular)) { where = ` Check joint ${jn(k)}.`; break; }
      blocks.push({ t: 'err', text: degree < 0
        ? `Unstable — ${countText}: too few members or reactions, so it's a mechanism (it can move).${where}`
        : `Unstable — the structure can move (a mechanism) even though ${countText} is enough. Look for reactions that are all parallel or all pass through one point, or a joint held only by members in a straight line.${where}` });
      takeMissing(ctx, blocks);
      out.analyses.push({ title, blocks });
      return;
    }
    const x = sol.x, u = x.slice(0, n), lam = x.slice(n);
    // Reactions = −λ along each constraint direction.
    const R = new Map();
    cons.forEach((c, i) => {
      const v = -lam[i], r = R.get(c.sp) || { x: 0, y: 0, m: 0, n: null };
      if (c.kind === 'm') r.m += v; else { r.x += v * c.dir[0]; r.y += v * c.dir[1]; if (c.kind === 'n') r.n = v; }
      R.set(c.sp, r);
    });
    // Member forces
    for (const e of C.els) {
      const ue = e.dofs.map(d => u[d]);
      e.name = jn(e.a) + jn(e.b);
      if (!frame) { e.N = EA / e.L * ((ue[2] - ue[0]) * e.c + (ue[3] - ue[1]) * e.s); continue; }
      const ul = matVec(rot6(e.c, e.s), ue), kl = frameKl(e.L, EA, EI), U = udlLocal(e);
      const f = matVec(kl, ul).map((v, i) => v - U.f[i]);
      e.f = f; e.qt = U.qt; e.N = (f[3] - f[0]) / 2;
      // Sagging moment along the element: M(x) = f1·x − f2 + qt·x²/2; extremes at the ends or where V = 0.
      const Mx = (xx) => f[1] * xx - f[2] + U.qt * xx * xx / 2;
      let best = { M: Mx(0), x: 0 };
      const cand = [e.L];
      if (Math.abs(U.qt) > 1e-12) { const xs = -f[1] / U.qt; if (xs > 0 && xs < e.L) cand.push(xs); }
      for (const xx of cand) { const v = Mx(xx); if (Math.abs(v) > Math.abs(best.M)) best = { M: v, x: xx }; }
      e.Mmax = best; e.Ma = Mx(0); e.Mb = Mx(e.L); e.Va = f[1]; e.Vb = -f[4];
    }
    // Equilibrium check over the whole structure.
    let sx = 0, sy = 0, sm = 0;
    for (const l of C.loads) { const p = ph(l.node); sx += l.F[0]; sy += l.F[1]; sm += cross(p, l.F) + l.M; }
    for (const e of C.els) if (e.q[0] || e.q[1]) { const pa = ph(e.a), pb = ph(e.b), mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], W = [e.q[0] * e.L, e.q[1] * e.L]; sx += W[0]; sy += W[1]; sm += cross(mid, W); }
    for (const [sp, r] of R) { const p = ph(sp.node); sx += r.x; sy += r.y; sm += cross(p, [r.x, r.y]) + r.m; }
    const eqOK = Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sm) / (Lavg || 1)) <= 1e-6 * Math.max(scale, 1);

    // ---- reactions: chips + table
    const reactRows = [];
    for (const sp of C.sups) {
      const r = R.get(sp), J = jn(sp.node), parts = [];
      record.reactions[J] = { x: r.x, y: r.y, m: r.m, n: r.n };
      if (r.n != null) {
        const nv = sp.n;
        if (Math.abs(nv[0]) < 1e-9) { parts.push(`${J}_y = ${fF(Math.abs(r.y))}${arrowY(r.y)}`); reactRows.push([J, `${J}_y`, fF(r.y)]); }
        else if (Math.abs(nv[1]) < 1e-9) { parts.push(`${J}_x = ${fF(Math.abs(r.x))}${arrowX(r.x)}`); reactRows.push([J, `${J}_x`, fF(r.x)]); }
        else {
          const ang = Math.atan2(r.y, r.x) / DEG;
          parts.push(`${J} = ${fF(Math.abs(r.n))} ∠${sig(ang)}°`);
          reactRows.push([J, `${J} (⟂ base)`, `${fF(Math.abs(r.n))} at ${sig(ang)}°`], [J, `${J}_x`, fF(r.x)], [J, `${J}_y`, fF(r.y)]);
        }
      } else {
        parts.push(`${J}_x = ${fF(Math.abs(r.x))}${arrowX(r.x)}`, `${J}_y = ${fF(Math.abs(r.y))}${arrowY(r.y)}`);
        reactRows.push([J, `${J}_x`, fF(r.x)], [J, `${J}_y`, fF(r.y)]);
        if (sp.s.sym === 'FIXED_SUPPORT' && frame) { parts.push(`M_${J} = ${fM(Math.abs(r.m))}${arrowM(r.m)}`); reactRows.push([J, `M_${J}`, fM(r.m)]); }
      }
      const c = sp.s.sym === 'FIXED_SUPPORT' ? P(sp.s, -6, 46) : P(sp.s, 0, 32);
      out.annots.push({ x: c[0], y: c[1], text: parts.join(', '), kind: 'chip', tone: 'v' });
    }
    // ---- determinacy
    if (degree > 0) blocks.push({ t: 'warn', text: `Statically indeterminate (degree ${degree}): ${countText}. The solution assumes every member has the same ${frame ? 'EA and EI' : 'EA'} — real sections change the answer.` });
    else blocks.push({ t: 'note', text: `Statically determinate: ${countText}.` });
    takeMissing(ctx, blocks);

    if (!frame) {
      let maxT = null, maxC = null;
      const rows = [];
      for (const e of C.els) {
        const z = Math.abs(e.N) < FMT.zero, tc = z ? '0 (zero-force)' : e.N > 0 ? 'T' : 'C';
        rows.push([e.name, fL(e.L), z ? '0' : fF(Math.abs(e.N)), tc]);
        record.members[e.name] = z ? 0 : e.N;
        if (!z && e.N > 0 && (!maxT || e.N > maxT.N)) maxT = e;
        if (!z && e.N < 0 && (!maxC || e.N < maxC.N)) maxC = e;
        const pa = nodes[e.a].p, pb = nodes[e.b].p;
        out.annots.push({ x: (pa[0] + pb[0]) / 2, y: (pa[1] + pb[1]) / 2, text: z ? '0' : `${fF(Math.abs(e.N))} (${tc})`, kind: 'chip', tone: z ? 'state' : e.N > 0 ? 'cold' : 'hot' });
      }
      blocks.push({ t: 'cards', items: [['Members', String(m)], ['Joints', String(j)], ['Reactions', String(nc)],
        ['Max tension', maxT ? `${fF(maxT.N)} (${maxT.name})` : '—'], ['Max compression', maxC ? `${fF(-maxC.N)} (${maxC.name})` : '—'],
        ['Zero-force members', String(C.els.filter(e => Math.abs(e.N) < FMT.zero).length)]] });
      blocks.push({ t: 'table', title: 'Member forces', head: ['Member', 'Length', 'Force', 'T / C'], rows });
      blocks.push({ t: 'table', title: 'Support reactions', head: ['Support', 'Component', 'Value'], rows: reactRows });
      blocks.push(eqBlock(eqOK, sx, sy, sm));
      blocks.push({ t: 'note', text: `Method of joints, solved all at once (2D direct stiffness, pin-jointed members carrying axial force only). Tension (T) pulls on the joints, compression (C) pushes. ${scaleNote(ctx)}` });
    } else {
      let worst = null, maxN = null;
      const rows = [];
      for (const e of C.els) {
        rows.push([e.name, fL(e.L), Math.abs(e.N) < FMT.zero ? '0' : fF(Math.abs(e.N)) + (e.N > 0 ? ' (T)' : ' (C)'), `${fF(e.Va)} / ${fF(e.Vb)}`, `${fM(e.Ma)} / ${fM(e.Mb)}`]);
        record.members[e.name] = { N: e.N, Va: e.Va, Vb: e.Vb, Ma: e.Ma, Mb: e.Mb, Mmax: e.Mmax.M };
        if (!worst || Math.abs(e.Mmax.M) > Math.abs(worst.Mmax.M)) worst = e;
        if (!maxN || Math.abs(e.N) > Math.abs(maxN.N)) maxN = e;
      }
      const beam = isStraight(ctx, C, nodes) ? beamDiagram(ctx, C, nodes, R, jn) : null;
      record.beam = beam;
      const cards = [['Segments', String(m)], ['Joints', String(j)], ['Reactions', String(nc)]];
      if (beam) {
        cards.push(['Max |V|', `${fF(Math.abs(beam.Vmax))} at x = ${fL(beam.xV)}`], ['Max |M|', `${fM(Math.abs(beam.Mmax))} at x = ${fL(beam.xM)}`], ['Span', fL(beam.L)]);
        if (Math.abs(beam.Mmax) >= FMT.zero) out.annots.push({ ...H.pt(toPage(ctx, beam.pM)), text: `M_max = ${fM(beam.Mmax)}`, kind: 'chip', tone: 'state' });
      } else {
        cards.push(['Max |M|', `${fM(Math.abs(worst.Mmax.M))} (${worst.name})`], ['Max |N|', `${fF(Math.abs(maxN.N))} (${maxN.name})`]);
        if (Math.abs(worst.Mmax.M) >= FMT.zero) {
          const pa = ph(worst.a), t = worst.Mmax.x;
          out.annots.push({ ...H.pt(toPage(ctx, [pa[0] + worst.c * t, pa[1] + worst.s * t])), text: `M_max = ${fM(worst.Mmax.M)}`, kind: 'chip', tone: 'state' });
        }
      }
      blocks.push({ t: 'cards', items: cards });
      blocks.push({ t: 'table', title: 'Support reactions', head: ['Support', 'Component', 'Value'], rows: reactRows });
      if (beam) blocks.push(...beam.plots);
      blocks.push({ t: 'table', title: 'Member end forces', head: ['Segment', 'Length', 'Axial N', 'V start / end', 'M start / end'], rows });
      blocks.push(eqBlock(eqOK, sx, sy, sm));
      blocks.push({ t: 'note', text: `Analysed as a ${beam ? 'beam' : 'frame'} (axial + bending) because of ${C.why.length ? C.why.join(', ') : 'collinear members'}. ` +
        (C.els.length > 1 && !beam ? 'Joints between members are rigid — place a Hinge symbol where members are pinned together. ' : '') +
        `Shear V and moment M follow Hibbeler's convention (M > 0 sags). ${scaleNote(ctx)}` });
    }
    out.analyses.push({ title, blocks });
  }
  const eqBlock = (ok, sx, sy, sm) => ({ t: ok ? 'ok' : 'warn', text: ok ? 'Equilibrium check: ΣF_x = 0, ΣF_y = 0, ΣM = 0 ✓' : `Equilibrium check failed: ΣF_x = ${fF(sx)}, ΣF_y = ${fF(sy)}, ΣM = ${fM(sm)}.` });

  function isStraight(ctx, C, nodes) {
    const ps = C.nodes.map(k => nodes[k].p);
    if (ps.length < 2) return false;
    let a = ps[0], b = ps[0];
    for (const p of ps) if (dist(p, a) > dist(b, a)) b = p;
    a = b;
    for (const p of ps) if (dist(p, a) > dist(b, a)) b = p;
    if (dist(a, b) < 4) return false;
    return ps.every(p => projSeg(p, a, b).dLine <= 3);
  }

  // Shear and moment diagrams of a single straight beam from all external forces on it.
  function beamDiagram(ctx, C, nodes, R, jn) {
    const ph = (k) => toPhys(ctx, nodes[k].p);
    const ps = C.nodes.map(ph);
    let a = ps[0], b = ps[0];
    for (const p of ps) if (Math.hypot(p[0] - a[0], p[1] - a[1]) > Math.hypot(b[0] - a[0], b[1] - a[1])) b = p;
    a = b;
    for (const p of ps) if (Math.hypot(p[0] - a[0], p[1] - a[1]) > Math.hypot(b[0] - a[0], b[1] - a[1])) b = p;
    let e = unit([b[0] - a[0], b[1] - a[1]]);
    if (e[0] < -1e-9 || (Math.abs(e[0]) <= 1e-9 && e[1] < 0)) { e = neg(e); const t = a; a = b; b = t; }
    const nrm = [-e[1], e[0]], X = (p) => (p[0] - a[0]) * e[0] + (p[1] - a[1]) * e[1], Ltot = X(b);
    const pf = [], pm = [], dq = [];
    for (const l of C.loads) { const x = X(ph(l.node)); if (l.F[0] || l.F[1]) pf.push({ x, F: dot(l.F, nrm) }); if (l.M) pm.push({ x, M: l.M }); }
    for (const [sp, r] of R) { const x = X(ph(sp.node)); pf.push({ x, F: dot([r.x, r.y], nrm) }); if (r.m) pm.push({ x, M: r.m }); }
    for (const el of C.els) if (el.q[0] || el.q[1]) { const xa = X(ph(el.a)), xb = X(ph(el.b)); dq.push({ a: Math.min(xa, xb), b: Math.max(xa, xb), q: dot(el.q, nrm) }); }
    const eps = 1e-9 * (Ltot || 1);
    const inc = (xi, x, right) => (right ? xi <= x + eps : xi < x - eps);
    const V = (x, right) => { let v = 0; for (const f of pf) if (inc(f.x, x, right)) v += f.F; for (const d of dq) v += d.q * Math.max(0, Math.min(x, d.b) - d.a); return v; };
    const Mf = (x, right) => {
      let v = 0;
      for (const f of pf) if (inc(f.x, x, right)) v += f.F * (x - f.x);
      for (const m of pm) if (inc(m.x, x, right)) v -= m.M;
      for (const d of dq) { const l = Math.max(0, Math.min(x, d.b) - d.a); v += d.q * l * (x - d.a - l / 2); }
      return v;
    };
    const ev = [...new Set([0, Ltot, ...pf.map(f => f.x), ...pm.map(m => m.x), ...dq.flatMap(d => [d.a, d.b])].map(x => +Math.max(0, Math.min(Ltot, x)).toFixed(9)))].sort((p, q) => p - q);
    const Vp = [[0, 0]], Mp = [[0, 0]];
    let Vmax = { v: 0, x: 0 }, Mmax = { v: 0, x: 0 };
    const seeV = (x, v) => { if (Math.abs(v) > Math.abs(Vmax.v) + 1e-12) Vmax = { v, x }; };
    const seeM = (x, v) => { if (Math.abs(v) > Math.abs(Mmax.v) + 1e-12) Mmax = { v, x }; };
    for (let k = 0; k + 1 < ev.length; k++) {
      const x0 = ev[k], x1 = ev[k + 1];
      const v0 = V(x0, true), v1 = V(x1, false);
      Vp.push([x0, v0], [x1, v1]); seeV(x0, v0); seeV(x1, v1);
      const N = 16;
      for (let i = 0; i <= N; i++) { const xx = x0 + (x1 - x0) * i / N, mv = Mf(xx, i < N); Mp.push([xx, mv]); seeM(xx, mv); }
      if (v0 * v1 < 0) { const xs = x0 + v0 / (v0 - v1) * (x1 - x0); seeM(xs, Mf(xs, true)); }
    }
    Vp.push([Ltot, 0]); Mp.push([Ltot, Mf(Ltot, true)], [Ltot, 0]);
    // Snap round-off so a textbook PL/4 prints as exactly that.
    const uV = plotUnit(Math.abs(Vmax.v), false), uM = plotUnit(Math.abs(Mmax.v), true), kx = FMT.us ? 1 / 0.3048 : 1, xu = FMT.us ? 'ft' : 'm';
    const sc = (pts, k) => pts.map(([x, y]) => [x * kx, Math.abs(y) < FMT.zero ? 0 : y * k]);
    const plots = [
      { t: 'plot', title: 'Shear diagram V(x)', xLabel: `x (${xu})`, yLabel: `V (${uV.u})`, polys: [{ pts: sc(Vp, uV.k), tone: 'cold', closed: true }], pts: [], hlines: [{ y: 0, label: '', tone: 'dome' }] },
      { t: 'plot', title: 'Bending moment diagram M(x)', xLabel: `x (${xu})`, yLabel: `M (${uM.u})`, polys: [{ pts: sc(Mp, uM.k), tone: 'hot', closed: true }],
        pts: Math.abs(Mmax.v) >= FMT.zero ? [{ x: Mmax.x * kx, y: Mmax.v * uM.k, label: 'Mmax ' + fM(Mmax.v) }] : [], hlines: [{ y: 0, label: '', tone: 'dome' }] },
    ];
    const pM = [a[0] + e[0] * Mmax.x, a[1] + e[1] * Mmax.x];
    return { L: Ltot, Vmax: Vmax.v, xV: Vmax.x, Mmax: Mmax.v, xM: Mmax.x, pM, plots, V: (x) => V(x, true), M: (x) => Mf(x, true) };
  }

  // =========================================================================================
  // ROPES, PULLEYS, BLOCKS (+ buoyancy forces)
  // =========================================================================================
  function cutAtWheels(st, wheels) {
    if (st.spring || st.pts.length < 3) return [st];
    const pts = st.pts, out = [];
    let cur = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const w = wheels.find(x => dist(pts[i], x.c) <= x.r + TOL);
      if (!w) { cur.push(pts[i]); continue; }
      let j = i;
      while (j + 1 < pts.length - 1 && dist(pts[j + 1], w.c) <= w.r + TOL) j++;
      cur.push(pts[i]); out.push({ pts: cur }); cur = [pts[j]]; i = j;
    }
    cur.push(pts[pts.length - 1]); out.push({ pts: cur });
    return out;
  }
  function interiorHit(pts, e) {
    const a = pts[0], z = pts[pts.length - 1];
    for (let j = 0; j + 1 < pts.length; j++) {
      const r = projSeg(e, pts[j], pts[j + 1]);
      if (r.d <= TOL && dist(r.q, a) > TOL && dist(r.q, z) > TOL) return { seg: j, q: r.q };
    }
    return null;
  }

  function bodies(ctx, ext) {
    const S = ctx.syms, out = ctx.out;
    const masses = S.filter(s => s.sym === 'MASS' || s.sym === 'CART');
    const wheels = [];
    for (const s of S) {
      if (s.sym === 'PULLEY') wheels.push({ s, c: P(s, 0, 0), r: 20 * scaleOf(s), fixed: true, ends: [] });
      if (s.sym === 'MOVABLE_PULLEY') wheels.push({ s, c: P(s, 0, -10), r: 18 * scaleOf(s), fixed: false, ends: [] });
    }
    if (!masses.length && !wheels.length) return;
    const members = S.filter(s => s.sym === 'MEMBER' && dist(s.terms[0], s.terms[1]) > 4);
    const anchorSegs = [], anchorPins = [];
    for (const s of S) {
      if (s.sym === 'FIXED_SUPPORT') anchorSegs.push({ s, seg: [P(s, 8, -32), P(s, 8, 32)], what: 'wall' });
      else if (s.sym === 'GROUND_SURFACE') anchorSegs.push({ s, seg: [P(s, -48, -6), P(s, 48, -6)], what: 'ceiling' });
      else if (s.sym === 'WATER_TANK') anchorSegs.push({ s, seg: [P(s, -64, 56), P(s, 64, 56)], what: 'tank bottom' }, { s, seg: [P(s, -64, -56), P(s, -64, 56)], what: 'tank wall' }, { s, seg: [P(s, 64, -56), P(s, 64, 56)], what: 'tank wall' });
      else if (SUPPORTS.has(s.sym)) anchorPins.push({ s, p: pinOf(s), what: 'support' });
    }
    for (const s of members) anchorSegs.push({ s, seg: s.terms, what: 'structure', struct: true });
    const onMember = (p, tol) => members.some(s => segDist(p, s.terms[0], s.terms[1]) <= tol);

    // What a rope end is tied to: the nearest thing within reach.
    const classify = (e, skipW) => {
      let best = null;
      const cand = (kind, d, extra) => { if (!best || d < best.d - 1e-9) best = { kind, d, ...extra }; };
      for (const w of wheels) {
        if (w === skipW) continue;
        const dc = dist(e, w.c);
        if (dc <= 0.45 * w.r) cand(w.fixed ? 'axle' : 'mbody', 0, { w });
        else if (dc <= w.r + TOL + 2) cand('wheel', Math.abs(dc - w.r) * 0.5, { w });
        if (!w.fixed) {
          const dh = Math.min(dist(e, P(w.s, 0, 30)), dist(e, P(w.s, 0, 26)));
          if (dh <= TOL + 2) cand('mbody', dh * 0.5, { w });
          if (segDist(e, P(w.s, 0, -7), P(w.s, 0, 22)) <= 4) cand('mbody', 1, { w });
        }
      }
      for (const s of masses) { const d = massDist(s, e); if (d <= TOL + 2) cand('mass', d, { s }); }
      for (const a of anchorSegs) { const d = segDist(e, a.seg[0], a.seg[1]); if (d <= TOL + 2) cand(a.struct ? 'struct' : 'anchor', d + 0.5, { a }); }
      for (const a of anchorPins) { const d = dist(e, a.p), inside = rectDist(a.s, e, -a.s.w / 2, -a.s.h / 2, a.s.w / 2, a.s.h / 2) === 0; if (d <= TOL + 4 || inside) cand('anchor', Math.min(d, TOL) + 0.5, { a }); }
      return best;
    };
    // Strands: lines + springs, cut where a single stroke wraps a wheel.
    let strands = ctx.wires.map(w => ({ pts: w.pts.map(q => [q[0], q[1]]) }));
    for (const sp of S.filter(s => s.sym === 'SPRING' || s.sym === 'DAMPER')) strands.push({ pts: [sp.terms[0].slice(), sp.terms[1].slice()], spring: sp });
    strands = strands.flatMap(st => cutAtWheels(st, wheels)).filter(st => polyLen(st.pts) > 3);
    const endPt = (st, k) => (k ? st.pts[st.pts.length - 1] : st.pts[0]);
    const nbrPt = (st, k) => (k ? st.pts[st.pts.length - 2] : st.pts[1]);
    strands.forEach(st => {
      st.ends = [classify(endPt(st, 0)), classify(endPt(st, 1))];
      // A pulley's mount line starts at its axle; its far end belongs to whatever holds the pulley.
      for (const k of [0, 1]) if (st.ends[k] && st.ends[k].kind === 'axle') st.ends[1 - k] = classify(endPt(st, 1 - k), st.ends[k].w);
    });
    // T-junctions (an untied end landing on another strand's middle) split that strand → knot.
    for (let pass = 0; pass < 60; pass++) {
      let hit = null;
      outer: for (const st of strands) for (let k = 0; k < 2; k++) {
        if (st.ends[k]) continue;
        for (const o of strands) { if (o === st || o.spring) continue; const h = interiorHit(o.pts, endPt(st, k)); if (h) { hit = { o, h }; break outer; } }
      }
      if (!hit) break;
      const { o, h } = hit, i = strands.indexOf(o);
      const a = { pts: [...o.pts.slice(0, h.seg + 1), h.q], ends: [o.ends[0], null] }, b = { pts: [h.q, ...o.pts.slice(h.seg + 1)], ends: [null, o.ends[1]] };
      strands.splice(i, 1, a, b);
    }
    // Untied ends: alone = free (a pull), two = the rope continues, three or more = a knot.
    const ru = H.UF();
    strands.forEach((st, i) => { st.id = i; ru.find(i); });
    const loose = [];
    strands.forEach(st => [0, 1].forEach(k => { if (!st.ends[k]) loose.push({ st, k, p: endPt(st, k) }); }));
    const lu = H.UF();
    loose.forEach((a, i) => { lu.find(i); for (let j = 0; j < i; j++) if (dist(a.p, loose[j].p) <= TOL) lu.union(i, j); });
    const lg = new Map();
    loose.forEach((a, i) => { const r = lu.find(i); if (!lg.has(r)) lg.set(r, []); lg.get(r).push(a); });
    const knots = [];
    for (const g of lg.values()) {
      if (g.length === 1) g[0].st.ends[g[0].k] = { kind: 'free' };
      else if (g.length === 2) { g.forEach(a => { a.st.ends[a.k] = { kind: 'join' }; }); ru.union(g[0].st.id, g[1].st.id); }
      else {
        const kn = { id: knots.length, p: [g.reduce((s, a) => s + a.p[0], 0) / g.length, g.reduce((s, a) => s + a.p[1], 0) / g.length] };
        knots.push(kn);
        g.forEach(a => { a.st.ends[a.k] = { kind: 'knot', knot: kn }; });
      }
    }
    // Ends know their strand, point and pull direction (physics, from the end along the strand).
    strands.forEach(st => {
      st.ends = st.ends.map((en, k) => ({ ...en, st, k, p: endPt(st, k), u: pdir(endPt(st, k), nbrPt(st, k)) }));
      st.mount = st.ends.some(en => en.kind === 'axle');   // pulley axle → its support: not part of a rope
      if (st.mount) {
        const ax = st.ends.find(en => en.kind === 'axle'), far = st.ends.find(en => en !== ax);
        ax.w.mountEnd = far;
        if (far.kind === 'anchor' && far.a) ctx.ropeUsed.add(far.a.s);
      }
    });
    // Wheels: the strands that reach a wheel are one rope over it.
    for (const st of strands) if (!st.mount) for (const en of st.ends) if (en.kind === 'wheel') en.w.ends.push(en);
    for (const w of wheels) {
      if (w.ends.length >= 2) { for (let k = 1; k < w.ends.length; k++) ru.union(w.ends[0].st.id, w.ends[k].st.id); if (w.ends.length > 2) ctx.warns.push(`${nameOf(ctx, w.s)} has ${w.ends.length} rope ends on its wheel — they're treated as one rope.`); }
      else if (w.ends.length === 1) { const en = w.ends[0]; en.kind = w.fixed ? 'anchor' : 'mbody'; en.a = { s: w.s, what: nameOf(ctx, w.s) }; w.ends = []; }
    }
    // Ropes
    const ropeMap = new Map();
    for (const st of strands) {
      if (st.mount) continue;
      const r = ru.find(st.id);
      if (!ropeMap.has(r)) ropeMap.set(r, { strands: [], ends: [] });
      const rp = ropeMap.get(r);
      rp.strands.push(st);
      for (const en of st.ends) { en.rope = rp; rp.ends.push(en); }
    }
    const isBodyEnd = (en) => en.kind === 'mass' || en.kind === 'mbody' || en.kind === 'knot' || (en.kind === 'wheel' && !en.w.fixed);
    let ropes = [...ropeMap.values()].filter(rp => rp.ends.some(isBodyEnd));
    for (const rp of ropes) {
      rp.free = rp.ends.some(en => en.kind === 'free');
      rp.via = [...new Set(rp.ends.filter(en => en.kind === 'wheel').map(en => en.w))];
      rp.springs = rp.strands.filter(st => st.spring).map(st => st.spring);
      for (const en of rp.ends) if (en.kind === 'anchor' && en.a) ctx.ropeUsed.add(en.a.s);
    }
    // Bodies
    const bu = H.UF();
    const bkey = (en) => (en.kind === 'mass' ? 'm' + en.s.i : en.kind === 'mbody' || en.kind === 'wheel' ? 'p' + en.w.s.i : en.kind === 'knot' ? 'k' + en.knot.id : null);
    for (const s of masses) for (const w of wheels) if (!w.fixed && dist(massTop(s), P(w.s, 0, 30)) <= TOL + 4) bu.union('m' + s.i, 'p' + w.s.i);
    const ropeEndsOf = new Map();
    for (const rp of ropes) for (const en of rp.ends) if (isBodyEnd(en)) { const k = bkey(en); if (!ropeEndsOf.has(k)) ropeEndsOf.set(k, []); ropeEndsOf.get(k).push(en); }
    const bodyMap = new Map();
    const getBody = (key) => { const r = bu.find(key); if (!bodyMap.has(r)) bodyMap.set(r, { key: r, masses: [], pulleys: [], knot: null, ends: [], applied: [], m: 0, Fext: [0, 0], surface: null, water: null, Fb: 0 }); return bodyMap.get(r); };
    // Blocks hung straight off a member (no rope) are loads on the structure, not bodies.
    const structMass = new Set();
    for (const s of masses) {
      const k = 'm' + s.i, hooked = wheels.some(w => !w.fixed && bu.find(k) === bu.find('p' + w.s.i));
      if (ropeEndsOf.has(k) || hooked) continue;
      if (onMember(massTop(s), TOL + 2)) {
        const m = massOf(ctx, s), W = m * G;
        ext.push({ p: massTop(s), F: [0, -W], src: s, what: 'weight' });
        structMass.add(s);
        const c = P(s, 0, massRect(s)[3] + 14);
        out.annots.push({ x: c[0], y: c[1], text: `W = ${fF(W)}`, kind: 'chip', tone: 'i' });
      }
    }
    for (const s of masses) if (!structMass.has(s)) { const b = getBody('m' + s.i); b.masses.push(s); }
    for (const w of wheels) if (!w.fixed && (ropeEndsOf.has('p' + w.s.i) || bodyMap.has(bu.find('p' + w.s.i)))) getBody('p' + w.s.i).pulleys.push(w);
    for (const kn of knots) if (ropeEndsOf.has('k' + kn.id)) getBody('k' + kn.id).knot = kn;
    for (const [k, ens] of ropeEndsOf) { const b = bodyMap.get(bu.find(k)); if (b) b.ends.push(...ens); }
    const B = [...bodyMap.values()];
    if (!B.length) return;
    // Forces typed on blocks (FORCE symbols touching a block but not a member).
    for (const f of S.filter(x => x.sym === 'FORCE')) {
      for (const b of B) {
        const s = b.masses.find(x => massDist(x, f.terms[1]) <= TOL || massDist(x, f.terms[0]) <= TOL);
        if (!s) continue;
        const tipOn = massDist(s, f.terms[1]) <= TOL, endPt2 = tipOn ? f.terms[1] : f.terms[0];
        if (onMember(endPt2, TOL)) continue;
        b.applied.push({ s: f, F: forceVec(ctx, f) }); ctx.used.add(f);
        break;
      }
    }
    // Mass, weight, contact surface, water.
    for (const b of B) {
      for (const s of b.masses) { const m = massOf(ctx, s); b.m += m; b.Fext[1] -= m * G; }
      for (const a of b.applied) { b.Fext[0] += a.F[0]; b.Fext[1] += a.F[1]; }
      const s = b.masses[0];
      b.name = b.masses.length ? b.masses.map(x => nameOf(ctx, x)).join(' + ') : b.pulleys.length ? nameOf(ctx, b.pulleys[0].s) : 'knot';
      if (s && b.masses.length === 1 && !b.pulleys.length) { b.surface = contactOf(ctx, s, members); b.water = waterOf(ctx, s); }
      b.mus = s ? Math.max(0, parseQ(s.props.mus, 'n') || 0) : 0;
      b.muk = s ? Math.max(0, parseQ(s.props.muk, 'n') || 0) : 0;
      if (s && s.sym === 'CART') b.mus = b.muk = 0;   // wheels roll freely
      if (b.muk > b.mus && b.mus > 0) ctx.warns.push(`${b.name}: μ_k is larger than μ_s — usually μ_k < μ_s.`);
      // Snap hand-drawn rope directions onto the slope / the axes.
      for (const en of b.ends) {
        if (b.surface) { const t = b.surface.t; en.u = Math.abs(cross(en.u, t)) < Math.sin(8 * DEG) ? (dot(en.u, t) >= 0 ? t : neg(t)) : snapDir(en.u); }
        else en.u = snapDir(en.u, 8);
      }
      if (!b.surface && !b.knot && b.ends.length === 1 && !b.applied.length && Math.abs(b.ends[0].u[1]) > Math.cos(35 * DEG)) b.ends[0].u = [0, Math.sign(b.ends[0].u[1])];
    }
    for (const w of wheels) if (w.fixed) for (const en of w.ends) en.u = snapDir(en.u, 8);
    // Rope chains: bodies tied together by ropes.
    const cu = H.UF();
    B.forEach(b => cu.find(b.key));
    for (const rp of ropes) { const ks = rp.ends.filter(isBodyEnd).map(en => bu.find(bkey(en))); ks.forEach(k => cu.union(ks[0], k)); }
    const groups = new Map();
    for (const b of B) { const r = cu.find(b.key); if (!groups.has(r)) groups.set(r, { bodies: [], ropes: [] }); groups.get(r).bodies.push(b); }
    for (const rp of ropes) { const en = rp.ends.find(isBodyEnd); groups.get(cu.find(bu.find(bkey(en)))).ropes.push(rp); }
    // Rope names: T, or T_1, T_2 … left → right.
    ropes.sort((p, q) => Math.min(...p.ends.map(en => en.p[0])) - Math.min(...q.ends.map(en => en.p[0])));
    ropes.forEach((rp, i) => { rp.name = ropes.length > 1 ? 'T_' + (i + 1) : 'T'; });
    const gl = [...groups.values()].sort((p, q) => Math.min(...p.bodies.map(b => bodyX(b))) - Math.min(...q.bodies.map(b => bodyX(b))));
    for (const g of gl) solveBodies(ctx, g, wheels, ext);
  }
  const bodyX = (b) => (b.masses[0] ? P(b.masses[0], 0, 0)[0] : b.pulleys[0] ? b.pulleys[0].c[0] : b.knot ? b.knot.p[0] : 0);

  // The surface a block rests on (incline, ground, tank bottom, member): normal n (out of the
  // surface, physics), downhill tangent t, slope angle.
  function contactOf(ctx, s, members) {
    const bottom = massBottomPts(s), c = P(s, 0, 0);
    let best = null;
    const tryseg = (A, B, sym, kind, angOverride) => {
      const d = Math.min(...bottom.map(p => segDist(p, A, B)));
      if (d > TOL + 4) return;
      const tp = pdir(A, B);
      let n = [-tp[1], tp[0]];                    // physics normal of the surface line …
      if (dot(n, pdir(A, c)) < 0) n = neg(n);     // … pointing toward the block
      if (n[1] < 0.25) return;                   // can't rest on a wall or a ceiling
      if (angOverride != null) { const sgn = n[0] < 0 ? -1 : n[0] > 0 ? 1 : 0; n = [sgn * Math.sin(angOverride * DEG), Math.cos(angOverride * DEG)]; }
      let t = [n[1], -n[0]];
      if (t[1] > 1e-12 || (Math.abs(t[1]) <= 1e-12 && t[0] < 0)) t = neg(t);
      if (!best || d < best.d) best = { d, n, t, sym, kind, A, B, theta: Math.acos(Math.min(1, n[1])) / DEG };
    };
    for (const x of ctx.syms) {
      if (x.sym === 'INCLINE') { const ov = parseQ(x.props.angle, 'deg'); tryseg(P(x, -48, 28), P(x, 48, -28), x, 'incline', ov != null && isFinite(ov) ? ov : null); }
      else if (x.sym === 'GROUND_SURFACE') tryseg(P(x, -48, -6), P(x, 48, -6), x, 'ground');
      else if (x.sym === 'WATER_TANK') tryseg(P(x, -64, 56), P(x, 64, 56), x, 'tank');
    }
    for (const m of members) tryseg(m.terms[0], m.terms[1], m, 'member');
    if (best && Math.abs(best.n[0]) < 1e-9) { best.n = [0, 1]; best.t = [1, 0]; }
    if (best) ctx.used.add(best.sym);
    return best;
  }
  // How much of a block sits below the water surface of a tank.
  function waterOf(ctx, s) {
    for (const tk of ctx.syms.filter(x => x.sym === 'WATER_TANK')) {
      const m = boxMap(tk), [x0, y0, x1, y1] = massRect(s);
      const loc = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(q => m.toLocal(P(s, q[0], q[1])));
      const lx0 = Math.min(...loc.map(q => q[0])), lx1 = Math.max(...loc.map(q => q[0])), ly0 = Math.min(...loc.map(q => q[1])), ly1 = Math.max(...loc.map(q => q[1]));
      if (lx1 < -64 || lx0 > 64) continue;
      const ov = Math.max(0, Math.min(ly1, 56) - Math.max(ly0, -36)), frac = ov / ((ly1 - ly0) || 1);
      if (frac <= 0.02) continue;
      return { tank: tk, frac: frac >= 0.95 ? 1 : frac, lyc: (ly0 + ly1) / 2 };
    }
    return null;
  }
  function fluidRho(tk) {
    const p = tk.props || {}, r = parseQ(p.rho, 'rho');
    if (r != null && r > 0) return { rho: r, name: 'ρ = ' + sig(r, 4) + ' kg/m³' };
    const f = String(p.fluid || 'water').toLowerCase();
    return { rho: FLUIDS[f] || 1000, name: FLUIDS[f] ? f : 'water' };
  }

  function solveBodies(ctx, g, wheels, ext) {
    const out = ctx.out, B = g.bodies, R = g.ropes, blocks = [];
    FMT.zero = 1e-9;
    // Buoyancy forces; free blocks in water are settled first (float / neutral / sink).
    let floatRes = null;
    for (const b of B) {
      if (!b.water) continue;
      const s = b.masses[0], fl = fluidRho(b.water.tank), Vp = parseQ(s.props.V, 'V'), rp = parseQ(s.props.rho, 'rho');
      const V = Vp > 0 ? Vp : rp > 0 ? b.m / rp : null;
      b.rhoF = fl.rho; b.fluid = fl.name;
      if (!V) { blocks.push({ t: 'warn', text: `${b.name} is in the water — set its volume V or density ρ to get the buoyant force.` }); continue; }
      b.V = V;
      const rhoObj = b.m / V, free = !b.ends.length && (!b.surface || b.surface.kind === 'tank');
      if (free && rhoObj < fl.rho * 0.995) { b.Fb = -b.Fext[1]; b.floatFrac = rhoObj / fl.rho; floatRes = b; }
      else if (free && Math.abs(rhoObj / fl.rho - 1) <= 0.005) { b.Fb = -b.Fext[1]; b.neutral = true; floatRes = b; }
      else b.Fb = fl.rho * G * V * b.water.frac;
      b.Fext[1] += b.Fb;
      b.rhoObj = rhoObj;
    }
    const knotted = B.some(b => b.knot);
    const Fscale = Math.max(1, ...B.map(b => Math.hypot(b.Fext[0], b.Fext[1])));
    const tolF = 1e-6 * Fscale;
    // ---- static attempt
    // Near-vertical ropes on hanging blocks / movable pulleys count as vertical (as in textbook
    // figures) when the slanted drawing can't balance sideways.
    const vEnds = [];
    for (const b of B) if (!b.surface && !b.knot) for (const en of b.ends) if (Math.abs(en.u[0]) > 1e-12 && Math.abs(en.u[1]) >= Math.cos(25 * DEG)) { en.u0 = en.u; vEnds.push(en); }
    let slack = new Set(), st = null, mode = null, why = '', vertical = false;
    const tryStatic = () => {
      slack = new Set();
      let s0 = null;
      for (let it = 0; it < 6; it++) {
        s0 = staticSolve(B, R, slack);
        if (s0.res > tolF) break;
        const negs = s0.ropes.filter(rp => s0.T.get(rp) < -tolF);
        if (!negs.length) break;
        negs.forEach(rp => slack.add(rp));   // a rope can only pull
      }
      return s0;
    };
    if (floatRes && B.length === 1) mode = 'float';
    else {
      st = tryStatic();
      if (st.res > tolF && vEnds.length) { vEnds.forEach(en => { en.u = [0, Math.sign(en.u0[1])]; }); vertical = true; st = tryStatic(); }
      if (st.res <= tolF && !st.ropes.some(rp => st.T.get(rp) < -tolF)) {
        mode = 'static';
        for (const b of B) {
          if (!b.surface) continue;
          const N = st.N.get(b), f = st.f.get(b) || 0;
          if (N < -tolF) { mode = null; why = `${b.name} would lift off its surface`; break; }
          if (Math.abs(f) > b.mus * N + tolF) { mode = null; why = b.mus > 0 ? `friction can't hold ${b.name}: it needs ${fF(Math.abs(f))} but μ_s N = ${fF(b.mus * N)}` : `${b.name} sits on a smooth surface (μ_s = 0) with a net push along it`; b.fNeed = f; break; }
        }
      }
    }
    // ---- dynamic
    let dyn = null;
    if (!mode) {
      if (knotted) {
        blocks.push({ t: 'err', text: 'These ropes can\'t be in equilibrium as drawn (the forces at the knot don\'t balance), so the system would move — knotted rope systems are only analysed at rest. Check the rope angles and the loads.' });
      } else {
        for (let it = 0; it < 6; it++) {
          const s0 = new Map();
          let d = dynSolve(B, R, slack, s0);
          if (d && B.some(b => b.surface && b.muk > 0)) {
            for (const b of B) if (b.surface && b.muk > 0) s0.set(b, Math.abs(d.a.get(b)) > 1e-9 ? Math.sign(d.a.get(b)) : Math.sign(b.fNeed ? -b.fNeed : 0));
            d = dynSolve(B, R, slack, s0);
          }
          if (!d) break;
          const negs = d.ropes.filter(rp => d.T.get(rp) < -tolF);
          if (!negs.length) { dyn = d; break; }
          negs.forEach(rp => slack.add(rp));
        }
        if (dyn) mode = 'dynamic';
        else blocks.push({ t: 'err', text: 'The motion of this rope system can\'t be determined from the drawing (a rope or pulley is free to move without anything resisting it).' });
      }
    }
    // ---- classify for the title
    const hanging = B.filter(b => b.masses.length && !b.surface && !b.pulleys.length && !b.knot);
    const resting = B.filter(b => b.surface);
    const movable = B.some(b => b.pulleys.length) && R.length > 0;
    const fixedW = new Set(R.flatMap(rp => rp.via.filter(w => w.fixed)));
    const inWater = B.find(b => b.water);
    let title = 'Ropes and pulleys';
    if (inWater) title = `Buoyancy — ${inWater.name}` + (floatRes ? '' : inWater.ends.length ? (inWater.ends.some(en => en.rope.ends.some(e2 => e2.kind === 'anchor' && e2.a && e2.a.what && /tank/.test(e2.a.what))) ? ' (tethered)' : ' (hanging)') : '');
    else if (movable) title = 'Block and tackle';
    else if (knotted) title = 'Cable equilibrium';
    else if (B.length === 2 && hanging.length === 2 && R.length === 1 && fixedW.size >= 1) title = 'Atwood machine';
    else if (B.length === 2 && resting.length === 1 && hanging.length === 1 && R.length === 1) title = resting[0].surface.kind === 'incline' ? 'Block on an incline with a hanging mass' : 'Block on a surface with a hanging mass';
    else if (B.length === 1 && resting.length === 1 && !R.length) title = resting[0].surface.kind === 'incline' ? 'Block on an incline' : 'Block on a surface';
    else if (B.length === 1 && hanging.length === 1 && R.length >= 1) title = 'Hanging mass';
    else if (B.length === 1 && !R.length && !resting.length) title = 'Free body';
    takeMissing(ctx, blocks);
    const rec = { title, mode, bodies: {}, ropes: {} };
    LAST.systems.push(rec);
    if (!mode) { out.analyses.push({ title, blocks }); return; }

    // ---- results per rope / body
    const T = new Map(), A = new Map(), Nn = new Map(), Ff = new Map();
    for (const rp of R) T.set(rp, slack.has(rp) ? 0 : mode === 'static' ? st.T.get(rp) : mode === 'dynamic' ? dyn.T.get(rp) : 0);
    for (const b of B) {
      A.set(b, mode === 'dynamic' ? dyn.a.get(b) : 0);
      if (b.surface) { Nn.set(b, mode === 'static' ? st.N.get(b) : dyn.N.get(b)); Ff.set(b, mode === 'static' ? (st.f.get(b) || 0) : dyn.f.get(b)); }
    }
    const cards = [], rows = [], ropeRows = [];
    if (mode === 'float') {
      const b = floatRes;
      blocks.push({ t: 'ok', text: b.neutral ? `${b.name} is neutrally buoyant (ρ = ρ_fluid): it stays wherever it is put.` : `${b.name} floats with ${sig(b.floatFrac * 100)}% of its volume submerged (ρ_block / ρ_fluid = ${sig(b.rhoObj, 4)} / ${sig(b.rhoF, 4)}).` });
    } else if (mode === 'static') blocks.push({ t: 'ok', text: 'In equilibrium — everything stays at rest.' + (slack.size ? ' (A rope that would have to push goes slack.)' : '') });
    else if (title === 'Free body') blocks.push({ t: 'note', text: 'Nothing holds this block up — no rope, surface or water touches it — so it falls freely with a = g. Tie a rope to it or rest it on a surface.' });
    else blocks.push({ t: 'note', text: 'Not in equilibrium' + (why ? ` (${why})` : '') + ' — it accelerates. Results are for the moment it\'s released from rest.' });
    if (vertical) blocks.push({ t: 'note', text: 'Ropes drawn nearly vertical are taken as exactly vertical.' });
    if (st && st.rank < st.n && mode === 'static') blocks.push({ t: 'warn', text: 'Statically indeterminate: more ropes than the equilibrium equations can resolve — the split shown is the most even one (real ropes share load by stiffness).' });
    // Rope tensions
    for (const rp of R) {
      const t = T.get(rp);
      rec.ropes[rp.name] = t;
      const names = [...new Set(rp.ends.filter(en => en.kind !== 'wheel' && en.kind !== 'join').map(en => endName(ctx, en, B)))];
      ropeRows.push([rp.name, names.join(' – ') + (rp.via.length ? ' (over ' + rp.via.map(w => nameOf(ctx, w.s)).join(', ') + ')' : ''), slack.has(rp) ? 'slack' : fF(t)]);
      const longest = rp.strands.filter(x => !x.spring).sort((p, q) => polyLen(q.pts) - polyLen(p.pts))[0] || rp.strands[0];
      const mp = midpointOf(longest.pts), d = pdir(longest.pts[0], longest.pts[longest.pts.length - 1]);
      out.annots.push({ x: mp[0] + 14 * Math.abs(d[1]), y: mp[1] - 10 * Math.abs(d[0]), text: slack.has(rp) ? `${rp.name} = 0 (slack)` : `${rp.name} = ${fF(t)}`, kind: 'chip', tone: 'i' });
      for (const sp of rp.springs) {
        if (sp.sym !== 'SPRING') continue;
        const k = parseQ(sp.props.k, 'k'), c = H.chipSpot(sp, true);
        if (k > 0) { out.annots.push({ x: c[0], y: c[1], text: `x = ${fDx(t / k)}`, kind: 'chip', tone: 'v' }); ropeRows.push([nameOf(ctx, sp), `spring k = ${sig(k)} N/m`, `stretch x = T/k = ${fDx(t / k)}`]); rec.ropes[nameOf(ctx, sp) + '.x'] = t / k; }
        else blocks.push({ t: 'note', text: `Set ${nameOf(ctx, sp)}'s stiffness k to get its stretch (x = T/k).` });
      }
      for (const en of rp.ends) if (en.kind === 'struct' && !slack.has(rp)) ext.push({ p: en.p, F: [t * en.u[0], t * en.u[1]], src: null, what: 'rope' });
    }
    // Fixed pulleys: load on the axle = vector sum of the two rope pulls.
    for (const w of wheels) {
      if (!w.fixed || !w.ends.length || !w.ends[0].rope || !R.includes(w.ends[0].rope)) continue;
      const t = T.get(w.ends[0].rope), Rv = w.ends.reduce((a, en) => [a[0] + t * en.u[0], a[1] + t * en.u[1]], [0, 0]);
      ropeRows.push([nameOf(ctx, w.s), 'axle load', `${fF(Math.hypot(Rv[0], Rv[1]))} at ${sig(Math.atan2(Rv[1], Rv[0]) / DEG)}°`]);
      // A pulley hung from a member (by its mount line, or its axle on the member) loads the structure.
      if (w.mountEnd && w.mountEnd.kind === 'struct') ext.push({ p: w.mountEnd.p, F: Rv, src: w.s, what: 'pulley' });
      else if (ctx.syms.some(x => x.sym === 'MEMBER' && segDist(w.c, x.terms[0], x.terms[1]) <= TOL + 2)) ext.push({ p: w.c, F: Rv, src: w.s, what: 'pulley' });
    }
    // Bodies
    for (const b of B) {
      const a = A.get(b), W = b.m * G, r = { a, W, m: b.m };
      const s = b.masses[0];
      const spot = (k) => (s ? P(s, 0, massRect(s)[3] + 14 + 17 * k) : b.pulleys[0] ? P(b.pulleys[0].s, 34, -10 + 17 * k) : [b.knot.p[0] + 16, b.knot.p[1] + 14 + 17 * k]);
      let ci = 0;
      const chip = (text, tone) => { const p = spot(ci++); out.annots.push({ x: p[0], y: p[1], text, kind: 'chip', tone }); };
      const dirTxt = b.surface ? (b.surface.theta > 0.5 ? (a > 0 ? 'down the slope' : 'up the slope') : (dot(b.surface.t, [1, 0]) * a > 0 ? '→' : '←')) : (a > 0 ? '↓' : '↑');
      if (b.knot) { rec.bodies['knot' + b.knot.id] = r; continue; }
      if (mode === 'dynamic') { chip(Math.abs(a) < 1e-9 ? 'a = 0' : `a = ${fA(a)} ${dirTxt}`, 'ok'); }
      if (b.surface) {
        const N = Nn.get(b), f = Ff.get(b);
        r.N = N; r.f = f; r.theta = b.surface.theta;
        chip(`N = ${fF(N)}`, 'v');
        if (Math.abs(f) > 1e-9) chip(`f = ${fF(Math.abs(f))}`, 'v');
        if (b.surface.kind === 'member') ext.push({ p: projSeg(P(s, 0, massRect(s)[3]), b.surface.A, b.surface.B).q, F: [-(N * b.surface.n[0] + f * b.surface.t[0]), -(N * b.surface.n[1] + f * b.surface.t[1])], src: s, what: 'contact' });
      }
      if (b.water && b.V) {
        r.Fb = b.Fb; r.V = b.V;
        chip(`F_b = ${fF(b.Fb)}`, 'cold');
        if (mode === 'float') { r.frac = b.neutral ? 1 : b.floatFrac; chip(b.neutral ? 'neutrally buoyant' : `floats — ${sig(b.floatFrac * 100)}% submerged`, 'ok'); }
        const objs = ctx.tankObjs.get(b.water.tank) || [];
        const tether = b.ends.length ? T.get(b.ends[0].rope) : null;
        objs.push({ name: b.name, W, Fb: b.Fb, V: b.V, frac: mode === 'float' ? (b.neutral ? 1 : b.floatFrac) : b.water.frac, lyc: b.water.lyc, a, T: tether, mode, N: Nn.get(b) });
        ctx.tankObjs.set(b.water.tank, objs);
      }
      if (!b.surface && !b.water && mode !== 'dynamic' && !b.ends.length) chip(`W = ${fF(W)}`, 'i');
      rec.bodies[b.name] = r;
      rows.push([b.name, b.masses.length ? fKg(b.m) : 'massless', b.masses.length ? fF(W) : '—', mode === 'dynamic' ? (Math.abs(a) < 1e-9 ? '0' : `${fA(a)} ${dirTxt}`) : '0',
        b.surface ? fF(Nn.get(b)) : '—', b.surface ? fF(Math.abs(Ff.get(b))) : '—', b.water && b.V ? fF(b.Fb) : '—']);
    }
    // ---- cards by situation
    const R0 = R[0] && T.get(R[0]);
    if (title === 'Atwood machine') {
      const [b1, b2] = hanging, a1 = A.get(b1);
      cards.push(['Acceleration a', fA(a1)], ['Tension T', fF(R0)], ['Moving down', Math.abs(a1) < 1e-9 ? '— (balanced)' : a1 > 0 ? b1.name : b2.name]);
      blocks.push({ t: 'note', text: 'Atwood machine: a = g(m_1 − m_2)/(m_1 + m_2), T = 2 m_1 m_2 g/(m_1 + m_2) (ideal pulley and rope).' });
    } else if (resting.length === 1 && B.length <= 2 && !movable) {
      const b = resting[0], N = Nn.get(b), f = Ff.get(b);
      cards.push(['Slope θ', sig(b.surface.theta) + '°'], ['Normal force N', fF(N)]);
      if (mode === 'static') cards.push(['Friction needed', fF(Math.abs(f))], ['Max static friction μ_s N', fF(b.mus * N)]);
      else cards.push(['Acceleration', `${fA(A.get(b))}${Math.abs(A.get(b)) > 1e-9 ? ' ' + (b.surface.theta > 0.5 ? (A.get(b) > 0 ? 'down the slope' : 'up the slope') : (A.get(b) > 0 ? '→' : '←')) : ''}`], ['Kinetic friction μ_k N', fF(Math.abs(f))]);
      if (R.length) cards.push(['Rope tension T', fF(R0)]);
      blocks.push({ t: 'note', text: `${b.surface.theta > 0.5 ? 'On the slope: N = m g cos θ' : 'On a level surface: N = m g'}${R.length ? ' (minus any rope pull across the surface)' : ''}; it stays put while the friction needed ≤ μ_s N, otherwise it slides with kinetic friction μ_k N opposing the motion. μ_s = ${sig(b.mus)}, μ_k = ${sig(b.muk)} (tap the block to change).` });
    } else if (movable) {
      const W = B.reduce((s2, b) => s2 + b.m * G, 0), pull = R.find(rp => rp.free);
      if (pull && mode === 'static') {
        const P2 = T.get(pull), n = pull.ends.filter(en => (en.kind === 'wheel' && !en.w.fixed) || en.kind === 'mbody').filter(en => en.u[1] > 0.5).length;
        rec.MA = W / P2; rec.pull = P2; rec.segments = n;
        cards.push(['Load W', fF(W)], ['Pull needed P', fF(P2)], ['Mechanical advantage W/P', sig(W / P2)], ['Supporting rope segments', String(n)]);
        out.annots.push({ ...H.pt(pull.ends.find(en => en.kind === 'free').p), text: `pull P = ${fF(P2)}`, kind: 'chip', tone: 'ok' });
        blocks.push({ t: 'note', text: `Ideal block and tackle: T = W / n with n rope segments holding up the moving block, so MA = n and the load rises 1/n as far as the rope is pulled.` });
      } else cards.push(['Load W', fF(W)], ...R.map(rp => [`Tension ${rp.name}`, fF(T.get(rp))]));
    } else if (inWater) {
      const b = inWater;
      cards.push(['Weight W = mg', fF(b.m * G)], ['Buoyant force F_b', b.V ? fF(b.Fb) : '—'], ['Fluid density', `${sig(b.rhoF, 4)} kg/m³`]);
      if (b.V) cards.push(['Block density', `${sig(b.rhoObj, 4)} kg/m³`]);
      if (mode === 'float' && !b.neutral) cards.push(['Submerged', sig(b.floatFrac * 100) + '%']);
      if (mode === 'dynamic') cards.push(['Net force', fF(b.m * Math.abs(A.get(b)))], ['Acceleration', `${fA(A.get(b))}${A.get(b) > 0 ? ' ↓ (sinks)' : A.get(b) < 0 ? ' ↑ (rises)' : ''}`]);
      if (b.ends.length) {
        const t = T.get(b.ends[0].rope), tether = /tethered/.test(title);
        cards.push([tether ? 'Cable tension T = F_b − W' : 'Apparent weight T = W − F_b', slack.has(b.ends[0].rope) ? 'slack' : fF(t)]);
        if (slack.has(b.ends[0].rope)) blocks.push({ t: 'warn', text: tether ? `The block is heavier than the water it displaces (W > F_b), so it would sink — the tether goes slack.` : 'The buoyant force exceeds the weight — the rope goes slack and the block rises.' });
      }
      blocks.push({ t: 'note', text: 'Archimedes: F_b = ρ_fluid g V_submerged. ' + (b.water.frac < 1 && mode !== 'float' ? `About ${sig(b.water.frac * 100)}% of the block is drawn under water.` : '') });
    } else if (title === 'Hanging mass') cards.push(['Tension T', fF(R0)], ['Weight W', fF(B[0].m * G)]);
    else for (const rp of R) cards.push([`Tension ${rp.name}`, slack.has(rp) ? 'slack' : fF(T.get(rp))]);
    if (cards.length) blocks.push({ t: 'cards', items: cards });
    if (ropeRows.length) blocks.push({ t: 'table', title: 'Ropes', head: ['Rope', 'Connects', 'Tension'], rows: ropeRows });
    if (rows.length) blocks.push({ t: 'table', title: 'Blocks', head: ['Block', 'm', 'W', 'a', 'N', 'f', 'F_b'], rows });
    blocks.push({ t: 'note', text: 'Ideal ropes and pulleys (massless, frictionless, inextensible); g = 9.81 m/s².' });
    out.analyses.push({ title, blocks });
  }
  function endName(ctx, en, B) {
    if (en.kind === 'mass') return nameOf(ctx, en.s);
    if (en.kind === 'mbody') return nameOf(ctx, en.w.s);
    if (en.kind === 'wheel') return nameOf(ctx, en.w.s);
    if (en.kind === 'knot') return 'knot';
    if (en.kind === 'free') return 'free end';
    if (en.kind === 'struct') return 'structure';
    if (en.kind === 'anchor') return en.a ? (en.a.what === 'support' ? nameOf(ctx, en.a.s) : en.a.what) : 'support';
    return '?';
  }

  // 2-D equilibrium of every body: Σ T u + N n + f t + F_ext = 0, least squares over T, N, f.
  function staticSolve(B, R, slack) {
    const ropes = R.filter(rp => !slack.has(rp)), col = new Map();
    let nu = 0;
    ropes.forEach(rp => col.set(rp, nu++));
    const cN = new Map(), cf = new Map();
    for (const b of B) if (b.surface) { cN.set(b, nu++); if (b.mus > 0) cf.set(b, nu++); }
    const A = [], rhs = [];
    for (const b of B) for (const ax of [0, 1]) {
      const row = zeros(nu);
      for (const en of b.ends) if (col.has(en.rope)) row[col.get(en.rope)] += en.u[ax];
      if (b.surface) { row[cN.get(b)] += b.surface.n[ax]; if (cf.has(b)) row[cf.get(b)] += b.surface.t[ax]; }
      A.push(row); rhs.push(-b.Fext[ax]);
    }
    const r = lsq(A, rhs, nu);
    const T = new Map(ropes.map(rp => [rp, r.x[col.get(rp)]])), N = new Map(), f = new Map();
    for (const b of B) if (b.surface) { N.set(b, r.x[cN.get(b)]); f.set(b, cf.has(b) ? r.x[cf.get(b)] : 0); }
    return { ropes, T, N, f, res: r.res, rank: r.rank, n: nu };
  }
  // One dof per body along d (down for hanging bodies, downhill along a surface) + one length
  // constraint per rope: Σ (u·d) a = 0. Kinetic friction −μ_k N sign(motion) on sliding blocks.
  function dynSolve(B, R, slack, sgn) {
    const ropes = R.filter(rp => !slack.has(rp)), nb = B.length, nr = ropes.length, N = nb + nr;
    const A = zeros2(N, N), rhs = zeros(N), rc = new Map(ropes.map((rp, i) => [rp, nb + i]));
    B.forEach((b, i) => {
      b.d = b.surface ? b.surface.t : [0, -1];
      const nn = b.surface ? b.surface.n : null, mk = nn ? b.muk * (sgn.get(b) || 0) : 0;
      A[i][i] = b.m;
      for (const en of b.ends) if (rc.has(en.rope)) A[i][rc.get(en.rope)] -= dot(en.u, b.d) + (nn ? mk * dot(en.u, nn) : 0);
      rhs[i] = dot(b.Fext, b.d) + (nn ? mk * dot(b.Fext, nn) : 0);
    });
    ropes.forEach((rp, j) => {
      const row = nb + j;
      if (rp.free) { A[row][row] = 1; return; }   // nobody is pulling a loose end
      B.forEach((b, i) => { for (const en of b.ends) if (en.rope === rp) A[row][i] += dot(en.u, b.d); });
    });
    const s = solveSq(A, rhs);
    if (!s.x) return null;
    const a = new Map(B.map((b, i) => [b, s.x[i]])), T = new Map(ropes.map(rp => [rp, s.x[rc.get(rp)]])), Nn = new Map(), f = new Map();
    for (const b of B) if (b.surface) {
      let tn = dot(b.Fext, b.surface.n);
      for (const en of b.ends) if (rc.has(en.rope)) tn += T.get(en.rope) * dot(en.u, b.surface.n);
      Nn.set(b, -tn); f.set(b, -b.muk * (sgn.get(b) || 0) * -tn);
    }
    return { a, T, N: Nn, f, ropes };
  }

  // =========================================================================================
  // WATER TANKS (fluid statics summary)
  // =========================================================================================
  function tanks(ctx) {
    for (const tk of ctx.syms.filter(x => x.sym === 'WATER_TANK')) {
      const fl = fluidRho(tk), depth = parseQ(tk.props.depth, 'L'), objs = ctx.tankObjs.get(tk) || [], blocks = [];
      const cards = [['Fluid', fl.name], ['Density ρ', sig(fl.rho, 4) + ' kg/m³']];
      if (depth > 0) {
        const pb = fl.rho * G * depth;
        cards.push(['Water depth', fL(depth)], ['Gauge pressure at the bottom', fPa(pb)]);
        const c = P(tk, 0, 70);
        ctx.out.annots.push({ x: c[0], y: c[1], text: `p_bottom = ${fPa(pb)}`, kind: 'chip', tone: 'cold' });
      }
      blocks.push({ t: 'cards', items: cards });
      if (objs.length) {
        blocks.push({ t: 'table', title: 'Objects in the water', head: ['Object', 'W', 'F_b', 'V', 'Result', ...(depth > 0 ? ['p at its centre'] : [])], rows: objs.map(o => {
          const res = o.mode === 'float' ? (o.frac >= 1 ? 'neutrally buoyant' : `floats, ${sig(o.frac * 100)}% submerged`) : o.T != null ? `rope T = ${fF(o.T)}` : o.N != null ? `rests on the bottom, N = ${fF(o.N)}` : o.mode === 'dynamic' ? (o.a > 0 ? `sinks, a = ${fA(o.a)}` : `rises, a = ${fA(o.a)}`) : 'at rest';
          const h = depth > 0 ? Math.max(0, depth * (o.lyc + 36) / 92) : 0;
          return [o.name, fF(o.W), fF(o.Fb), sig(o.V) + ' m³', res, ...(depth > 0 ? [fPa(fl.rho * G * h) + ` (h ≈ ${fL(h)})`] : [])];
        }) });
      } else blocks.push({ t: 'note', text: 'Drop a Mass into the water (set its V or ρ) to get the buoyant force.' });
      blocks.push({ t: 'note', text: 'Gauge pressure p = ρ g h grows linearly with depth h below the surface. ' + (depth > 0 ? 'Object depths are taken in proportion to the drawn water height.' : 'Set the real water depth to get pressures.') });
      LAST.tanks.push({ rho: fl.rho, depth, pBottom: depth > 0 ? fl.rho * G * depth : null, objs });
      ctx.out.analyses.push({ title: `${nameOf(ctx, tk)} — fluid statics`, blocks });
    }
  }

  // Parts that didn't connect to anything: say so instead of silently ignoring them.
  function leftovers(ctx) {
    const w = ctx.warns.slice();
    for (const s of ctx.syms) {
      const n = nameOf(ctx, s);
      if (SUPPORTS.has(s.sym) && !ctx.used.has(s) && !ctx.ropeUsed.has(s)) w.push(`${n === TITLE[s.sym] ? 'A ' + n.toLowerCase() : n} isn't connected to any member or rope — put its pin on a joint (or tie a rope to it).`);
      else if (s.sym === 'FORCE' && !ctx.used.has(s)) w.push(`${n} doesn't touch a joint, member or block — draw it so its tip (or tail) lands on one.`);
      else if ((s.sym === 'MOMENT_CCW' || s.sym === 'MOMENT_CW') && !ctx.used.has(s)) w.push(`${n} isn't on a member — centre it on a joint or on the beam.`);
      else if (s.sym === 'DIST_LOAD' && !ctx.used.has(s)) w.push(`${n} doesn't sit on a member — its bottom edge (the arrow tips) should lie along the beam.`);
      else if (s.sym === 'HINGE' && !ctx.used.has(s)) w.push(`${n} isn't on a member.`);
      else if (s.sym === 'INCLINE' && !ctx.used.has(s)) w.push(`Nothing rests on ${n} — put a Mass on it with the block's bottom edge on the slope.`);
    }
    if (ctx.syms.some(s => s.sym === 'DAMPER')) w.push('Dampers carry no force at rest, so they\'re ignored in statics (treated like a rope link).');
    if (!w.length) return;
    ctx.out.analyses.push({ title: 'Mechanics — check the drawing', blocks: [...new Set(w)].map(t => ({ t: 'warn', text: t })) });
  }

  // =========================================================================================
  // value sheet fields + labels (contract §3)
  // =========================================================================================
  function fieldsFor(s) {
    const p = s.props || {};
    const f = (key, label, units, ph, extra) => ({ key, label, unit: units && units.length ? units[0] : '', ph, value: p[key] == null ? '' : String(p[key]), keypad: units ? 'num' : 'text', ...(units && units.length ? { units } : {}), ...(extra || {}) });
    const nm = f('name', 'Name', null, '');
    switch (s.sym) {
      case 'FORCE': return [f('F', 'Force F', ['N', 'kN', 'lbf'], '1 kN'), f('angle', 'Direction (optional)', ['°'], 'as drawn', { hint: 'degrees counter-clockwise from → ; leave blank to use the arrow' }), nm];
      case 'MASS': return [f('m', 'Mass m', ['kg', 'g', 'lb'], '10'), f('mus', 'Static friction μ_s', [], '0'), f('muk', 'Kinetic friction μ_k', [], '0'),
        f('V', 'Volume V (for buoyancy)', ['m³', 'L', 'cm³'], 'optional'), f('rho', 'Density ρ (instead of V)', ['kg/m³', 'g/cm³'], 'optional'), nm];
      case 'CART': return [f('m', 'Mass m', ['kg', 'g', 'lb'], '10'), nm];
      case 'MOMENT_CCW': case 'MOMENT_CW': return [f('M', 'Couple moment M', ['N·m', 'kN·m', 'lbf·ft'], '1 kN·m'), nm];
      case 'DIST_LOAD': return [f('w', 'Load intensity w', ['N/m', 'kN/m', 'lbf/ft'], '1 kN/m', { hint: 'force per metre of the member it sits on' }), nm];
      case 'MEMBER': return [f('L', 'Real length L (sets the scale)', ['m', 'mm', 'ft'], 'as drawn', { hint: 'optional — by default 1 grid square = 1 m' }), nm];
      case 'SPRING': return [f('k', 'Stiffness k', ['N/m', 'kN/m', 'N/mm'], 'unknown'), nm];
      case 'WATER_TANK': return [f('fluid', 'Fluid', null, 'water', { options: ['water', 'seawater', 'oil', 'custom'] }), f('rho', 'Custom density ρ', ['kg/m³', 'g/cm³'], 'from fluid'), f('depth', 'Water depth', ['m', 'cm', 'ft'], 'unknown'), nm];
      case 'INCLINE': return [f('angle', 'Slope angle θ (optional)', ['°'], 'as drawn'), nm];
      case 'MOVABLE_PULLEY': case 'PULLEY': return [nm];
      default: return [nm];
    }
  }
  function labelFor(ctx, s) {
    const p = s.props || {};
    const vs = (v, u) => { const t = String(v).trim(); return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? t + ' ' + u : t.replace(/^([-+]?[\d.]+(?:e[-+]?\d+)?)\s*/i, '$1 '); };
    switch (s.sym) {
      case 'FORCE': return blank(p.F) ? '' : 'F = ' + vs(p.F, 'N');
      case 'MASS': case 'CART': return blank(p.m) ? '' : 'm = ' + vs(p.m, 'kg');
      case 'MOMENT_CCW': case 'MOMENT_CW': return blank(p.M) ? '' : 'M = ' + vs(p.M, 'N·m');
      case 'DIST_LOAD': return blank(p.w) ? '' : 'w = ' + vs(p.w, 'N/m');
      case 'MEMBER': return blank(p.L) ? '' : 'L = ' + vs(p.L, 'm');
      case 'SPRING': return blank(p.k) ? '' : 'k = ' + vs(p.k, 'N/m');
      case 'WATER_TANK': { const f = fluidRho(s); return blank(p.rho) && blank(p.fluid) && blank(p.depth) ? '' : f.name + (blank(p.depth) ? '' : ', ' + vs(p.depth, 'm') + ' deep'); }
      case 'INCLINE': { const ov = parseQ(p.angle, 'deg'); if (ov != null && isFinite(ov)) return `θ = ${sig(ov)}°`; const [l, t, r, b] = s.box; return `θ = ${sig(Math.atan(Math.abs(b - t) / (Math.abs(r - l) || 1)) / DEG)}°`; }
      default: return '';
    }
  }

  return { analyze, get _last() { return LAST; }, _test: { parseQ, solveSq, lsq } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = InkMechanics;
