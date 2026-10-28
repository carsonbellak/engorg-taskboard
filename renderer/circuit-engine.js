// Circuit engine for the Circuit Lab utility — a small SPICE-style simulator.
//
// Modified Nodal Analysis (MNA): unknowns are the node voltages (ground = node 0, not
// solved) plus one branch current per voltage source, inductor and op-amp output.
// Nonlinear parts (diode/LED, op-amp rail clamp) are solved with Newton-Raphson using
// SPICE's pnjlim voltage limiting. Transient uses trapezoidal companion models (first
// step backward-Euler) with step halving when Newton fails; AC is a complex linear
// solve linearized at the DC operating point. Pure JS, no DOM — also loads under Node
// (module.exports) so the solver can be tested without the app. Desktop-only utility.
//
// Netlist shape (built from the schematic by circuitLab, or by hand in tests):
//   { nodes: ['0', 'in', 'out', …],           // index 0 is ground
//     parts: [{ id, ref, type, n: [nodeIdx…], p: { …props } }] }
// Types / pins: R C L D LED (a,b) · V I (+,−) · OA (in−, in+, out).

const CircuitEngine = (() => {
  const VT = 0.025852;  // thermal voltage @ 300 K
  const GMIN = 1e-12;   // conductance to ground on every node — keeps floating nodes solvable

  // ---- SI value parsing / formatting ----------------------------------------
  const PREFIX = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  function parseSI(v) {
    if (typeof v === 'number') return v;
    const s = String(v == null ? '' : v).trim().replace(/,/g, '');
    const m = s.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(meg|Meg|MEG|[fpnuµmkKMGT])?/i);
    if (!m) return NaN;
    let n = parseFloat(m[1]);
    const p = m[2];
    if (p) n *= /^meg$/i.test(p) ? 1e6 : (PREFIX[p] != null ? PREFIX[p] : PREFIX[p.toLowerCase()] || 1);
    return n;
  }
  function fmtSI(v, unit = '', digits = 3) {
    if (v == null || !isFinite(v)) return '—';
    if (v === 0) return '0 ' + unit;
    const a = Math.abs(v);
    const steps = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
    for (const [f, p] of steps) {
      if (a >= f * 0.9995) return +(v / f).toPrecision(digits) + ' ' + p + unit;
    }
    return v.toExponential(2) + ' ' + unit;
  }

  // ---- source waveforms -----------------------------------------------------
  // p.wave: 'dc' | 'sine' | 'pulse' | 'square' | 'tri'. DC op uses value(t = 0).
  function sourceValue(p, t) {
    const dc = parseSI(p.dc != null ? p.dc : p.value) || 0;
    const amp = parseSI(p.amp) || 0, freq = parseSI(p.freq) || 0;
    switch (p.wave) {
      case 'sine': {
        const ph = (parseSI(p.phase) || 0) * Math.PI / 180;
        return dc + amp * Math.sin(2 * Math.PI * freq * t + ph);
      }
      case 'square': case 'pulse': {
        const v1 = p.wave === 'square' ? dc - amp : (parseSI(p.v1) || 0);
        const v2 = p.wave === 'square' ? dc + amp : parseSI(p.v2 != null ? p.v2 : 5);
        const per = p.wave === 'square' ? (freq > 0 ? 1 / freq : Infinity) : (parseSI(p.period) || Infinity);
        const duty = Math.min(1, Math.max(0, (parseSI(p.duty != null ? p.duty : 50) || 0) / 100));
        const delay = parseSI(p.delay) || 0;
        const tr = Math.max(parseSI(p.rise) || 0, 0);
        if (t <= delay) return v1;
        const tt = isFinite(per) ? (t - delay) % per : t - delay;
        const on = isFinite(per) ? per * duty : Infinity;
        if (tr > 0 && tt < tr) return v1 + (v2 - v1) * tt / tr;
        if (tt < on) return v2;
        if (tr > 0 && tt < on + tr) return v2 + (v1 - v2) * (tt - on) / tr;
        return v1;
      }
      case 'tri': {
        if (!(freq > 0)) return dc;
        const x = (t * freq) % 1;
        return dc + amp * (x < 0.5 ? 4 * x - 1 : 3 - 4 * x);
      }
      default: return dc;
    }
  }
  // Waveform edges, so the transient step lands on them instead of skipping over them.
  function breakpoints(p, tStop) {
    const out = [];
    if (p.wave !== 'pulse' && p.wave !== 'square') return out;
    const freq = parseSI(p.freq) || 0;
    const per = p.wave === 'square' ? (freq > 0 ? 1 / freq : 0) : (parseSI(p.period) || 0);
    const duty = Math.min(1, Math.max(0, (parseSI(p.duty != null ? p.duty : 50) || 0) / 100));
    const delay = parseSI(p.delay) || 0, tr = Math.max(parseSI(p.rise) || 0, 0);
    if (!(per > 0)) { out.push(delay, delay + tr); return out; }
    for (let k = 0, t0 = delay; t0 <= tStop && k < 5000; k++, t0 += per) out.push(t0, t0 + tr, t0 + per * duty, t0 + per * duty + tr);
    return out;
  }

  // ---- part parameters ------------------------------------------------------
  const LED_COLORS = { red: [1e-18, 1.9], green: [1e-21, 2.0], blue: [1e-25, 3.5], yellow: [1e-19, 2.1], white: [1e-25, 3.3] };
  function diodeParams(part) {
    const p = part.p || {};
    if (part.type === 'LED') {
      const [is, n] = LED_COLORS[p.color] || LED_COLORS.red;
      return { is: parseSI(p.is) || is, n: parseSI(p.n) || n, rs: parseSI(p.rs) || 2 };
    }
    return { is: parseSI(p.is) || 1e-14, n: parseSI(p.n) || 1, rs: parseSI(p.rs) || 0.01 };
  }

  // SPICE pnjlim — damp big jumps in junction voltage so exp() can't explode.
  function pnjlim(vnew, vold, vt, vcrit) {
    if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
      if (vold > 0) {
        const arg = 1 + (vnew - vold) / vt;
        vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
      } else {
        vnew = vt * Math.log(vnew / vt);
      }
    }
    return vnew;
  }

  // ---- dense linear solvers (partial pivoting) -------------------------------
  function solveReal(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let piv = c, best = Math.abs(A[c][c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r][c]); if (v > best) { best = v; piv = r; } }
      if (best < 1e-300) return null;
      if (piv !== c) { const t = A[c]; A[c] = A[piv]; A[piv] = t; const tb = b[c]; b[c] = b[piv]; b[piv] = tb; }
      const rowC = A[c], d = rowC[c];
      for (let r = c + 1; r < n; r++) {
        const row = A[r], f = row[c] / d;
        if (f === 0) continue;
        for (let k = c; k < n; k++) row[k] -= f * rowC[k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }
  function solveComplex(Ar, Ai, br, bi) {
    const n = br.length;
    for (let c = 0; c < n; c++) {
      let piv = c, best = Ar[c][c] ** 2 + Ai[c][c] ** 2;
      for (let r = c + 1; r < n; r++) { const v = Ar[r][c] ** 2 + Ai[r][c] ** 2; if (v > best) { best = v; piv = r; } }
      if (best < 1e-300) return null;
      if (piv !== c) {
        [Ar[c], Ar[piv]] = [Ar[piv], Ar[c]]; [Ai[c], Ai[piv]] = [Ai[piv], Ai[c]];
        [br[c], br[piv]] = [br[piv], br[c]]; [bi[c], bi[piv]] = [bi[piv], bi[c]];
      }
      const dr = Ar[c][c], di = Ai[c][c], dd = dr * dr + di * di;
      for (let r = c + 1; r < n; r++) {
        const xr = Ar[r][c], xi = Ai[r][c];
        if (xr === 0 && xi === 0) continue;
        const fr = (xr * dr + xi * di) / dd, fi = (xi * dr - xr * di) / dd;   // f = x / d
        for (let k = c; k < n; k++) {
          const ar = Ar[c][k], ai = Ai[c][k];
          Ar[r][k] -= fr * ar - fi * ai; Ai[r][k] -= fr * ai + fi * ar;
        }
        const sr = br[c], si = bi[c];
        br[r] -= fr * sr - fi * si; bi[r] -= fr * si + fi * sr;
      }
    }
    const xr = new Array(n), xi = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let sr = br[r], si = bi[r];
      for (let k = r + 1; k < n; k++) { sr -= Ar[r][k] * xr[k] - Ai[r][k] * xi[k]; si -= Ar[r][k] * xi[k] + Ai[r][k] * xr[k]; }
      const dr = Ar[r][r], di = Ai[r][r], dd = dr * dr + di * di;
      xr[r] = (sr * dr + si * di) / dd; xi[r] = (si * dr - sr * di) / dd;
    }
    return { re: xr, im: xi };
  }

  // ---- system layout ----------------------------------------------------------
  // Assigns a branch-current row to each V / L / OA and validates values.
  function prepare(net) {
    const N = net.nodes.length - 1;            // solved node voltages (ground excluded)
    let k = N;
    const errors = [];
    const parts = net.parts.map(pt => {
      const q = { ...pt, br: -1 };
      const p = pt.p || {};
      if (pt.type === 'V' || pt.type === 'L' || pt.type === 'OA') q.br = k++;
      if (pt.type === 'R') { q.R = parseSI(p.value); if (!(q.R > 0)) errors.push(`${pt.ref}: resistance must be > 0`); }
      if (pt.type === 'C') { q.C = parseSI(p.value); if (!(q.C > 0)) errors.push(`${pt.ref}: capacitance must be > 0`); }
      if (pt.type === 'L') { q.L = parseSI(p.value); if (!(q.L > 0)) errors.push(`${pt.ref}: inductance must be > 0`); }
      if (pt.type === 'D' || pt.type === 'LED') q.dp = diodeParams(pt);
      if (pt.type === 'OA') {
        q.A0 = parseSI(p.gain) || 1e5;
        q.vsat = parseSI(p.vsat); if (!(q.vsat > 0)) q.vsat = 15;
        q.gbw = parseSI(p.gbw) || 1e6;
      }
      return q;
    });
    return { N, size: k, parts, errors };
  }

  // v(node) helper over the solution vector (node 0 = ground).
  const vAt = (x, n) => (n > 0 ? x[n - 1] : 0);

  // Stamp helpers on a real system. Row/col for node n is n-1; ground is dropped.
  function stampG(A, a, b, g) {
    if (a > 0) A[a - 1][a - 1] += g;
    if (b > 0) A[b - 1][b - 1] += g;
    if (a > 0 && b > 0) { A[a - 1][b - 1] -= g; A[b - 1][a - 1] -= g; }
  }
  function stampI(z, a, b, i) {           // current i flowing a → b through the element
    if (a > 0) z[a - 1] -= i;
    if (b > 0) z[b - 1] += i;
  }
  function stampVsrc(A, z, a, b, br, v) { // V(a) − V(b) = v, branch current br (enters a)
    if (a > 0) { A[a - 1][br] += 1; A[br][a - 1] += 1; }
    if (b > 0) { A[b - 1][br] -= 1; A[br][b - 1] -= 1; }
    z[br] += v;
  }

  // Op-amp: out = vsat·tanh(A0·(v+ − v−)/vsat), linearized for Newton.
  function stampOpAmp(A, z, q, x) {
    const [nm, np, no] = q.n;
    const vd = vAt(x, np) - vAt(x, nm);
    const u = q.A0 * vd / q.vsat;
    const th = Math.tanh(Math.max(-40, Math.min(40, u)));
    const f = q.vsat * th, g = q.A0 * (1 - th * th);
    const br = q.br;
    // KCL: output node sources the branch current. Constraint: v_out − g·v+ + g·v− = f − g·vd
    if (no > 0) { A[no - 1][br] += 1; A[br][no - 1] += 1; }
    if (np > 0) A[br][np - 1] -= g;
    if (nm > 0) A[br][nm - 1] += g;
    z[br] += f - g * vd;
  }

  // Diode (with series resistance folded into the Newton linearization).
  function diodeEval(q, vd) {
    const { is, n } = q.dp, nvt = n * VT;
    const e = Math.exp(Math.min(vd / nvt, 80));
    const id = is * (e - 1), gd = is * e / nvt;
    return { id, gd };
  }

  // Build + Newton-solve the real system for one time point.
  //   mode: 'dc' | 'tran'; ctx carries the companion state for C/L in transient.
  function newton(sys, x0, mode, ctx) {
    const { N, size, parts } = sys;
    let x = x0 ? x0.slice() : new Array(size).fill(0);
    const vj = ctx.vj || {};               // limited diode junction voltages (by part id)
    for (let it = 0; it < 150; it++) {
      const A = Array.from({ length: size }, () => new Float64Array(size));
      const z = new Float64Array(size);
      for (let i = 0; i < N; i++) A[i][i] += GMIN;
      for (const q of parts) {
        const [a, b] = q.n;
        switch (q.type) {
          case 'R': stampG(A, a, b, 1 / q.R); break;
          case 'C':
            if (mode === 'tran') {
              const st = ctx.cap[q.id];
              const geq = ctx.be ? q.C / ctx.h : 2 * q.C / ctx.h;
              const ieq = ctx.be ? geq * st.v : geq * st.v + st.i;   // history current, b → a
              stampG(A, a, b, geq); stampI(z, a, b, -ieq);
            }
            break;                                                  // DC: open circuit
          case 'L':
            if (mode === 'tran') {
              const st = ctx.ind[q.id];
              const req = ctx.be ? q.L / ctx.h : 2 * q.L / ctx.h;
              // V(a)−V(b) − req·i = −req·i_prev (−v_prev for trapezoidal)
              stampVsrc(A, z, a, b, q.br, ctx.be ? -req * st.i : -req * st.i - st.v);
              A[q.br][q.br] -= req;
            } else stampVsrc(A, z, a, b, q.br, 0);                 // DC: short
            break;
          case 'V': stampVsrc(A, z, a, b, q.br, sourceValue(q.p, ctx.t || 0)); break;
          case 'I': stampI(z, a, b, sourceValue(q.p, ctx.t || 0)); break;
          case 'D': case 'LED': {
            const vd = vj[q.id] != null ? vj[q.id] : vAt(x, a) - vAt(x, b);
            const { id, gd } = diodeEval(q, vd);
            // Series Rs: combine the junction conductance with 1/Rs for a stable stamp.
            const rs = q.dp.rs;
            const geff = gd / (1 + gd * rs);
            const ieff = (id - gd * vd) / (1 + gd * rs);
            stampG(A, a, b, geff + GMIN); stampI(z, a, b, ieff);
            break;
          }
          case 'OA': stampOpAmp(A, z, q, x); break;
        }
      }
      const xn = solveReal(A.map(r => Array.from(r)), Array.from(z));
      if (!xn || xn.some(v => !isFinite(v))) return { ok: false, err: 'singular matrix — check for floating parts, loops of voltage sources, or a missing ground' };
      // Junction limiting on the new iterate.
      let limited = false;
      for (const q of parts) {
        if (q.type !== 'D' && q.type !== 'LED') continue;
        const nvt = q.dp.n * VT;
        const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * q.dp.is));
        const v = vAt(xn, q.n[0]) - vAt(xn, q.n[1]);
        const prev = vj[q.id] != null ? vj[q.id] : vAt(x, q.n[0]) - vAt(x, q.n[1]);
        // Back out the drop across Rs (from the linearized current) so the limiter acts on
        // the junction voltage itself.
        const { id, gd } = diodeEval(q, prev);
        const rs = q.dp.rs, geff = gd / (1 + gd * rs);
        const iNew = id + geff * (v - (prev + rs * id));
        const want = v - rs * iNew;
        const vjNew = pnjlim(want, prev, nvt, vcrit);
        if (Math.abs(vjNew - want) > 1e-9 || Math.abs(vjNew - prev) > 1e-6) limited = true;
        vj[q.id] = vjNew;
      }
      let conv = !limited;
      for (let i = 0; i < size && conv; i++) {
        if (Math.abs(xn[i] - x[i]) > 1e-6 * Math.max(Math.abs(xn[i]), Math.abs(x[i])) + (i < N ? 1e-7 : 1e-10)) conv = false;
      }
      x = xn;
      if (conv && it > 0) { ctx.vj = vj; return { ok: true, x, iters: it + 1 }; }
    }
    return { ok: false, err: 'did not converge' };
  }

  // Current through each part (into pin 0, out of pin 1 — for V sources, into +).
  function partCurrents(sys, x, mode, ctx) {
    const out = {};
    for (const q of sys.parts) {
      const [a, b] = q.n;
      const v = vAt(x, a) - vAt(x, b);
      let i = 0;
      switch (q.type) {
        case 'R': i = v / q.R; break;
        case 'C':
          if (mode === 'tran') {
            const st = ctx.cap[q.id];
            const geq = ctx.be ? q.C / ctx.h : 2 * q.C / ctx.h;
            i = ctx.be ? geq * (v - st.v) : geq * (v - st.v) - st.i;
          }
          break;
        case 'L': case 'V': i = x[q.br]; break;
        case 'I': i = sourceValue(q.p, ctx.t || 0); break;
        case 'D': case 'LED': {
          const vjq = (ctx.vj && ctx.vj[q.id] != null) ? ctx.vj[q.id] : v;
          const { id, gd } = diodeEval(q, vjq);
          i = id + gd / (1 + gd * q.dp.rs) * (v - (vjq + q.dp.rs * id));
          break;
        }
        case 'OA': i = -x[q.br]; break;  // current delivered out of the output pin
      }
      out[q.id] = i;
    }
    return out;
  }
  // Voltage "across" a part as shown in the analysis table (OA: output to ground).
  function partVoltage(q, x) {
    if (q.type === 'OA') return vAt(x, q.n[2]);
    return vAt(x, q.n[0]) - vAt(x, q.n[1]);
  }

  // Homotopy fallback when plain Newton fails at DC: ramp all sources from 10% → 100%.
  function dcSolve(sys, ctx) {
    let r = newton(sys, null, 'dc', ctx);
    if (r.ok) return r;
    const scaled = (s) => ({ ...sys, parts: sys.parts.map(q => (q.type === 'V' || q.type === 'I')
      ? { ...q, p: { ...q.p, wave: 'dc', dc: sourceValue(q.p, ctx.t || 0) * s } } : q) });
    let x = null;
    ctx.vj = {};
    for (let s = 0.1; s <= 1.0001; s += 0.1) {
      r = newton(scaled(Math.min(1, s)), x, 'dc', ctx);
      if (!r.ok) return r;
      x = r.x;
    }
    return r;
  }

  function nodeMap(net, x) {
    const v = {};
    net.nodes.forEach((name, i) => { v[name] = vAt(x, i); });
    return v;
  }

  // ---- analyses -----------------------------------------------------------------
  function operatingPoint(net) {
    const sys = prepare(net);
    if (sys.errors.length) return { error: sys.errors.join('\n') };
    const ctx = { t: 0, vj: {} };
    const r = dcSolve(sys, ctx);
    if (!r.ok) return { error: 'DC operating point: ' + r.err };
    const I = partCurrents(sys, r.x, 'dc', ctx);
    const parts = sys.parts.map(q => {
      const v = partVoltage(q, r.x), i = I[q.id];
      // Power absorbed (negative = delivering). Op-amp: what it sources into its load.
      const pw = q.type === 'OA' ? -v * i : v * i;
      return { id: q.id, ref: q.ref, type: q.type, v, i, p: pw };
    });
    return { x: r.x, nodes: nodeMap(net, r.x), parts, iters: r.iters, sys, vj: ctx.vj };
  }

  function transient(net, opts = {}) {
    const sys = prepare(net);
    if (sys.errors.length) return { error: sys.errors.join('\n') };
    const tStop = parseSI(opts.tStop) || 1e-3;
    const nPts = Math.max(50, Math.min(20000, Math.round(opts.points || 1000)));
    const hNom = tStop / nPts;
    const ctx = { t: 0, vj: {}, cap: {}, ind: {}, h: hNom, be: true };
    let x;
    if (opts.uic) {
      x = new Array(sys.size).fill(0);
    } else {
      const r = dcSolve(sys, ctx);
      if (!r.ok) return { error: 'Initial operating point: ' + r.err };
      x = r.x;
    }
    for (const q of sys.parts) {
      if (q.type === 'C') ctx.cap[q.id] = { v: opts.uic ? 0 : vAt(x, q.n[0]) - vAt(x, q.n[1]), i: 0 };
      if (q.type === 'L') ctx.ind[q.id] = { i: opts.uic ? 0 : x[q.br], v: 0 };
    }
    const bps = [];
    for (const q of sys.parts) if (q.type === 'V' || q.type === 'I') bps.push(...breakpoints(q.p, tStop));
    const bpSet = [...new Set(bps.filter(t => t > 0 && t < tStop).map(t => +t.toPrecision(12)))].sort((a, b) => a - b);

    const time = [0];
    const V = net.nodes.map(() => []);
    const Ip = {}; sys.parts.forEach(q => { Ip[q.id] = []; });
    const record = (xx, cur) => {
      net.nodes.forEach((_, i) => V[i].push(vAt(xx, i)));
      for (const q of sys.parts) Ip[q.id].push(cur[q.id]);
    };
    record(x, partCurrents(sys, x, 'dc', { ...ctx, be: true, h: hNom, cap: Object.fromEntries(Object.keys(ctx.cap).map(k => [k, { v: ctx.cap[k].v, i: 0 }])) }));
    // Initial currents for C come out as 0 above (DC); with UIC they're unknown until step 1.

    let t = 0, bi = 0, steps = 0, firstAfterBp = true;
    const minH = hNom / 1024;
    while (t < tStop - hNom * 1e-9 && steps < 200000) {
      let h = Math.min(hNom, tStop - t);
      while (bi < bpSet.length && bpSet[bi] <= t + minH * 0.5) bi++;
      if (bi < bpSet.length && bpSet[bi] < t + h) h = bpSet[bi] - t;
      let r, tried = 0;
      for (;;) {
        ctx.h = h; ctx.t = t + h; ctx.be = firstAfterBp;
        const vjSave = { ...ctx.vj };
        r = newton(sys, x, 'tran', ctx);
        if (r.ok) break;
        ctx.vj = vjSave;
        h /= 4; tried++;
        if (h < minH || tried > 6) return { error: `Transient failed at t = ${fmtSI(t, 's')}: ${r.err}` };
      }
      const cur = partCurrents(sys, r.x, 'tran', ctx);
      for (const q of sys.parts) {
        if (q.type === 'C') ctx.cap[q.id] = { v: vAt(r.x, q.n[0]) - vAt(r.x, q.n[1]), i: cur[q.id] };
        if (q.type === 'L') ctx.ind[q.id] = { i: r.x[q.br], v: vAt(r.x, q.n[0]) - vAt(r.x, q.n[1]) };
      }
      x = r.x; t += h; steps++;
      firstAfterBp = bi < bpSet.length && Math.abs(bpSet[bi] - t) < minH;
      time.push(t); record(x, cur);
    }
    const nodes = {}; net.nodes.forEach((name, i) => { nodes[name] = V[i]; });
    return { time, nodes, currents: Ip, steps };
  }

  // AC small-signal sweep. Sources' `ac` prop (magnitude, default 1 V on the first V
  // source if none set) drive the circuit; everything else is linearized at the DC OP.
  function acSweep(net, opts = {}) {
    const op = operatingPoint(net);
    if (op.error) return op;
    const sys = op.sys;
    const fStart = parseSI(opts.fStart) || 1, fStop = parseSI(opts.fStop) || 1e6;
    const ppd = Math.max(5, Math.min(200, opts.ppd || 40));
    const decades = Math.log10(fStop / fStart);
    if (!(decades > 0)) return { error: 'AC sweep: stop frequency must be above start' };
    const nF = Math.max(2, Math.round(decades * ppd) + 1);
    const hasAc = sys.parts.some(q => (q.type === 'V' || q.type === 'I') && parseSI(q.p.ac) > 0);
    const acOf = (q, firstV) => {
      const m = parseSI(q.p.ac);
      if (m > 0) return m;
      return !hasAc && q === firstV ? 1 : 0;
    };
    const firstV = sys.parts.find(q => q.type === 'V') || sys.parts.find(q => q.type === 'I');
    if (!firstV) return { error: 'AC sweep needs a voltage or current source.' };
    const freq = [], mag = {}, phase = {};
    let cur = null;
    net.nodes.forEach(n => { mag[n] = []; phase[n] = []; });
    const { N, size } = sys;
    for (let k = 0; k < nF; k++) {
      const f = fStart * Math.pow(10, decades * k / (nF - 1));
      const w = 2 * Math.PI * f;
      const Ar = Array.from({ length: size }, () => new Array(size).fill(0));
      const Ai = Array.from({ length: size }, () => new Array(size).fill(0));
      const br = new Array(size).fill(0), bi = new Array(size).fill(0);
      for (let i = 0; i < N; i++) Ar[i][i] += GMIN;
      const yG = (a, b, gr, gi) => { stampG(Ar, a, b, gr); if (gi) stampG(Ai, a, b, gi); };
      for (const q of sys.parts) {
        const [a, b] = q.n;
        switch (q.type) {
          case 'R': yG(a, b, 1 / q.R, 0); break;
          case 'C': yG(a, b, 0, w * q.C); break;
          case 'L': stampVsrc(Ar, br, a, b, q.br, 0); Ai[q.br][q.br] -= w * q.L; break;
          // Optional p.acPhase (degrees) puts a source at an angle — several sources at one frequency.
          case 'V': { const m = acOf(q, firstV), ph = (parseSI(q.p.acPhase) || 0) * Math.PI / 180; stampVsrc(Ar, br, a, b, q.br, m * Math.cos(ph)); bi[q.br] += m * Math.sin(ph); break; }
          case 'I': { const m = acOf(q, firstV), ph = (parseSI(q.p.acPhase) || 0) * Math.PI / 180; stampI(br, a, b, m * Math.cos(ph)); stampI(bi, a, b, m * Math.sin(ph)); break; }
          case 'D': case 'LED': {
            const vd = op.vj[q.id] != null ? op.vj[q.id] : vAt(op.x, a) - vAt(op.x, b);
            const { gd } = diodeEval(q, vd);
            yG(a, b, gd / (1 + gd * q.dp.rs) + GMIN, 0);
            break;
          }
          case 'OA': {
            // Single-pole model: A(jw) = A0 / (1 + jw/wp), wp = GBW / A0, times the tanh slope at the OP.
            const [nm, np, no] = q.n;
            const vd = vAt(op.x, np) - vAt(op.x, nm);
            const th = Math.tanh(Math.max(-40, Math.min(40, q.A0 * vd / q.vsat)));
            const a0 = q.A0 * (1 - th * th), wp = 2 * Math.PI * q.gbw / q.A0;
            const d = 1 + (w / wp) ** 2;
            const gr = a0 / d, gi = -a0 * (w / wp) / d;
            if (no > 0) { Ar[no - 1][q.br] += 1; Ar[q.br][no - 1] += 1; }
            if (np > 0) { Ar[q.br][np - 1] -= gr; Ai[q.br][np - 1] -= gi; }
            if (nm > 0) { Ar[q.br][nm - 1] += gr; Ai[q.br][nm - 1] += gi; }
            break;
          }
        }
      }
      const s = solveComplex(Ar, Ai, br, bi);
      if (!s) return { error: `AC sweep: singular matrix at ${fmtSI(f, 'Hz')}` };
      freq.push(f);
      if (opts.currents) {
        // Phasor current through each part (into pin 0) — branch unknowns where the MNA has them.
        const V = (n) => (n > 0 ? [s.re[n - 1], s.im[n - 1]] : [0, 0]);
        const row = {};
        for (const q of sys.parts) {
          const [va, vb] = [V(q.n[0]), V(q.n[1])], dv = [va[0] - vb[0], va[1] - vb[1]];
          let c = null;
          if (q.type === 'R') c = [dv[0] / q.R, dv[1] / q.R];
          else if (q.type === 'C') c = [-w * q.C * dv[1], w * q.C * dv[0]];
          else if (q.type === 'L' || q.type === 'V') c = [s.re[q.br], s.im[q.br]];
          else if (q.type === 'OA') c = [-s.re[q.br], -s.im[q.br]];
          else if (q.type === 'I') { const m = acOf(q, firstV), ph = (parseSI(q.p.acPhase) || 0) * Math.PI / 180; c = [m * Math.cos(ph), m * Math.sin(ph)]; }
          else if (q.type === 'D' || q.type === 'LED') {
            const vd = op.vj[q.id] != null ? op.vj[q.id] : vAt(op.x, q.n[0]) - vAt(op.x, q.n[1]);
            const { gd } = diodeEval(q, vd), g = gd / (1 + gd * q.dp.rs);
            c = [g * dv[0], g * dv[1]];
          }
          if (c) row[q.id] = c;
        }
        (cur = cur || []).push(row);
      }
      net.nodes.forEach((n, i) => {
        const re = i > 0 ? s.re[i - 1] : 0, im = i > 0 ? s.im[i - 1] : 0;
        mag[n].push(Math.hypot(re, im));
        phase[n].push(Math.atan2(im, re) * 180 / Math.PI);
      });
    }
    // Unwrap phase so a filter's −180° roll-off reads continuously.
    for (const n of net.nodes) {
      const ph = phase[n];
      for (let i = 1; i < ph.length; i++) {
        while (ph[i] - ph[i - 1] > 180) ph[i] -= 360;
        while (ph[i] - ph[i - 1] < -180) ph[i] += 360;
      }
    }
    return { freq, mag, phase, cur, source: (sys.parts.find(q => acOf(q, firstV) > 0) || {}).ref };
  }

  // Thevenin equivalent seen between nodes a and b (small-signal at the DC OP):
  // Voc from the OP, Rth from the response to a 1 µA test current injected into a.
  function thevenin(net, aName, bName) {
    const ai = net.nodes.indexOf(aName), bIdx = net.nodes.indexOf(bName);
    if (ai < 0 || bIdx < 0 || ai === bIdx) return { error: 'Pick two different nodes.' };
    const op = operatingPoint(net);
    if (op.error) return op;
    const voc = op.nodes[aName] - op.nodes[bName];
    const dI = 1e-6;
    const probe = { ...net, parts: [...net.parts, { id: '__thev', ref: 'Itest', type: 'I', n: [bIdx, ai], p: { wave: 'dc', dc: dI } }] };
    const op2 = operatingPoint(probe);
    if (op2.error) return op2;
    const rth = ((op2.nodes[aName] - op2.nodes[bName]) - voc) / dI;
    return { voc, rth, isc: Math.abs(rth) > 1e-12 ? voc / rth : Infinity, pmax: rth > 1e-12 ? voc * voc / (4 * rth) : Infinity };
  }

  // ---- waveform measurements --------------------------------------------------------
  function measure(t, y) {
    const n = y.length;
    if (!n) return null;
    let mn = Infinity, mx = -Infinity;
    for (const v of y) { if (v < mn) mn = v; if (v > mx) mx = v; }
    let area = 0, sq = 0;
    for (let i = 1; i < n; i++) {
      const dt = t[i] - t[i - 1];
      area += dt * (y[i] + y[i - 1]) / 2;
      sq += dt * (y[i] * y[i] + y[i - 1] * y[i - 1] + y[i] * y[i - 1]) / 3;
    }
    const T = t[n - 1] - t[0] || 1;
    const avg = area / T, rms = Math.sqrt(Math.max(0, sq / T));
    // Frequency from rising crossings of the midpoint (needs ≥ 2 crossings).
    const mid = (mn + mx) / 2, cross = [];
    for (let i = 1; i < n; i++) {
      if (y[i - 1] < mid && y[i] >= mid) cross.push(t[i - 1] + (mid - y[i - 1]) / (y[i] - y[i - 1]) * (t[i] - t[i - 1]));
    }
    const freq = cross.length >= 2 && mx - mn > 1e-9 ? (cross.length - 1) / (cross[cross.length - 1] - cross[0]) : null;
    // First 10 → 90 % rise across the swing.
    let rise = null;
    if (mx - mn > 1e-9) {
      const lo = mn + 0.1 * (mx - mn), hi = mn + 0.9 * (mx - mn);
      let tl = null;
      for (let i = 1; i < n; i++) {
        if (tl == null && y[i - 1] < lo && y[i] >= lo) tl = t[i];
        if (tl != null && y[i - 1] < hi && y[i] >= hi) { rise = t[i] - tl; break; }
      }
    }
    return { min: mn, max: mx, pp: mx - mn, avg, rms, freq, rise, final: y[n - 1] };
  }

  // Bode summary for one node: DC/low gain, peak, −3 dB points, unity-gain crossing.
  function bodeSummary(freq, mag, phase) {
    const db = mag.map(m => 20 * Math.log10(Math.max(m, 1e-30)));
    let pk = 0; db.forEach((d, i) => { if (d > db[pk]) pk = i; });
    const ref = db[pk];
    const interp = (i, target, arr) => {
      const f0 = Math.log10(freq[i - 1]), f1 = Math.log10(freq[i]);
      return Math.pow(10, f0 + (target - arr[i - 1]) / (arr[i] - arr[i - 1]) * (f1 - f0));
    };
    let fLow = null, fHigh = null, fUnity = null;
    for (let i = pk; i > 0; i--) if (db[i - 1] < ref - 3 && db[i] >= ref - 3) { fLow = interp(i, ref - 3, db); break; }
    for (let i = pk + 1; i < db.length; i++) if (db[i - 1] >= ref - 3 && db[i] < ref - 3) { fHigh = interp(i, ref - 3, db); break; }
    for (let i = 1; i < db.length; i++) if ((db[i - 1] >= 0) !== (db[i] >= 0)) { fUnity = interp(i, 0, db); break; }
    let phaseAtUnity = null;
    if (fUnity) {
      const i = freq.findIndex(f => f >= fUnity);
      if (i > 0) phaseAtUnity = phase[i - 1] + (phase[i] - phase[i - 1]) * (Math.log10(fUnity / freq[i - 1]) / Math.log10(freq[i] / freq[i - 1]));
    }
    return { lowDb: db[0], highDb: db[db.length - 1], peakDb: ref, peakF: freq[pk], fLow, fHigh, fUnity, phaseAtUnity };
  }

  return { parseSI, fmtSI, sourceValue, operatingPoint, transient, acSweep, thevenin, measure, bodeSummary, LED_COLORS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CircuitEngine;
