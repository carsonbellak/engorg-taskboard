// Thermo engine for the Thermo Lab utility — property evaluation + cycle/device/reservoir
// analysis in the style of Purdue ME 20000 (Moran & Shapiro, "Fundamentals of Engineering
// Thermodynamics"): SI units, state numbering and sign conventions as in the text.
//
// Substances
//   water  IAPWS-IF97 regions 1 (compressed liquid), 2 (vapour) and 4 (saturation). Region 3
//          (near-critical: T > 350 °C at p > ~16.5 MPa) and region 5 (> 800 °C) are not
//          included — states there throw a clear error.
//   r134a  Tillner-Roth & Baehr (1994) Helmholtz equation of state, re-referenced to the
//          ASHRAE convention the textbook tables use (h = s = 0 for saturated liquid at −40 °C).
//   air    Ideal gas with variable specific heats (NASA 7-coefficient polynomials for N₂/O₂/Ar),
//          offset so h(300 K) = 300.19 kJ/kg and s°(300 K) = 1.70203 kJ/kg·K like Table A-22.
//          s is reported relative to 1 atm: s = s°(T) − R ln(p / 101.325 kPa).
//   aircold Cold-air-standard ideal gas (cp = 1.005, cv = 0.718, k = 1.4, h = cp·T).
//
// Internal units: T in K, p in kPa, v m³/kg, u/h kJ/kg, s kJ/kg·K. Pure JS, no DOM — also
// loads under Node (module.exports) for tests. Desktop-only utility.

const ThermoEngine = (() => {
  // ---- small numerics ----------------------------------------------------------------------
  function bisect(f, a, b, tol = 1e-10, maxIt = 200) {
    let fa = f(a), fb = f(b);
    if (!isFinite(fa) || !isFinite(fb)) throw new Error('solver: bad bracket');
    if (fa === 0) return a;
    if (fb === 0) return b;
    if (fa * fb > 0) throw new Error('solver: value out of range');
    for (let i = 0; i < maxIt; i++) {
      const m = 0.5 * (a + b), fm = f(m);
      if (fm === 0 || (b - a) / 2 < tol * Math.max(1, Math.abs(m))) return m;
      if (fa * fm < 0) { b = m; fb = fm; } else { a = m; fa = fm; }
    }
    return 0.5 * (a + b);
  }
  // Brent-style secant/bisection hybrid on a bracket — fast for smooth monotonic props.
  function solve(f, a, b, tol = 1e-9) {
    let fa = f(a), fb = f(b);
    if (fa * fb > 0) throw new Error('solver: value out of range');
    let c = a, fc = fa, d = b - a, e = d;
    for (let i = 0; i < 200; i++) {
      if (fb * fc > 0) { c = a; fc = fa; d = b - a; e = d; }
      if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
      const tol1 = 2e-16 * Math.abs(b) + 0.5 * tol * Math.max(1, Math.abs(b)), xm = 0.5 * (c - b);
      if (Math.abs(xm) <= tol1 || fb === 0) return b;
      if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
        const s = fb / fa;
        let p, q;
        if (a === c) { p = 2 * xm * s; q = 1 - s; } else {
          const qq = fa / fc, r = fb / fc;
          p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1)); q = (qq - 1) * (r - 1) * (s - 1);
        }
        if (p > 0) q = -q; p = Math.abs(p);
        if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q; } else { d = xm; e = d; }
      } else { d = xm; e = d; }
      a = b; fa = fb;
      b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
      fb = f(b);
    }
    return b;
  }

  // =========================================================================================
  // WATER — IAPWS-IF97
  // =========================================================================================
  const RW = 0.461526;
  const R1 = {
    I: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 8, 8, 21, 23, 29, 30, 31, 32],
    J: [-2, -1, 0, 1, 2, 3, 4, 5, -9, -7, -1, 0, 1, 3, -3, 0, 1, 3, 17, -4, 0, 6, -5, -2, 10, -8, -11, -6, -29, -31, -38, -39, -40, -41],
    n: [0.14632971213167, -0.84548187169114, -0.37563603672040e1, 0.33855169168385e1, -0.95791963387872, 0.15772038513228,
      -0.16616417199501e-1, 0.81214629983568e-3, 0.28319080123804e-3, -0.60706301565874e-3, -0.18990068218419e-1,
      -0.32529748770505e-1, -0.21841717175414e-1, -0.52838357969930e-4, -0.47184321073267e-3, -0.30001780793026e-3,
      0.47661393906987e-4, -0.44141845330846e-5, -0.72694996297594e-15, -0.31679644845054e-4, -0.28270797985312e-5,
      -0.85205128120103e-9, -0.22425281908000e-5, -0.65171222895601e-6, -0.14341729937924e-12, -0.40516996860117e-6,
      -0.12734301741641e-8, -0.17424871230634e-9, -0.68762131295531e-18, 0.14478307828521e-19, 0.26335781662795e-22,
      -0.11947622640071e-22, 0.18228094581404e-23, -0.93537087292458e-25],
  };
  const R2_0 = {
    J: [0, 1, -5, -4, -3, -2, -1, 2, 3],
    n: [-0.96927686500217e1, 0.10086655968018e2, -0.56087911283020e-2, 0.71452738081455e-1, -0.40710498223928,
      0.14240819171444e1, -0.43839511319450e1, -0.28408632460772, 0.21268463753307e-1],
  };
  const R2_R = {
    I: [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 10, 10, 10, 16, 16, 18, 20, 20, 20, 21, 22, 23, 24, 24, 24],
    J: [0, 1, 2, 3, 6, 1, 2, 4, 7, 36, 0, 1, 3, 6, 35, 1, 2, 3, 7, 3, 16, 35, 0, 11, 25, 8, 36, 13, 4, 10, 14, 29, 50, 57, 20, 35, 48, 21, 53, 39, 26, 40, 58],
    n: [-0.17731742473213e-2, -0.17834862292358e-1, -0.45996013696365e-1, -0.57581259083432e-1, -0.50325278727930e-1,
      -0.33032641670203e-4, -0.18948987516315e-3, -0.39392777243355e-2, -0.43797295650573e-1, -0.26674547914087e-4,
      0.20481737692309e-7, 0.43870667284435e-6, -0.32277677238570e-4, -0.15033924542148e-2, -0.40668253562649e-1,
      -0.78847309559367e-9, 0.12790717852285e-7, 0.48225372718507e-6, 0.22922076337661e-5, -0.16714766451061e-10,
      -0.21171472321355e-2, -0.23895741934104e2, -0.59059564324270e-17, -0.12621808899101e-5, -0.38946842435739e-1,
      0.11256211360459e-10, -0.82311340897998e1, 0.19809712802088e-7, 0.10406965210174e-18, -0.10234747095929e-12,
      -0.10018179379511e-8, -0.80882908646985e-10, 0.10693031879409, -0.33662250574171, 0.89185845355421e-24,
      0.30629316876232e-12, -0.42002467698208e-5, -0.59056029685639e-25, 0.37826947613457e-5, -0.12768608934681e-14,
      0.73087610595061e-28, 0.55414715350778e-16, -0.94369707241210e-6],
  };
  const R4 = [0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2, 0.12020824702470e5, -0.32325550322333e7,
    0.14915108613530e2, -0.48232657361591e4, 0.40511340542057e6, -0.23855557567849, 0.65017534844798e3];
  const B23 = [0.34805185628969e3, -0.11671859879975e1, 0.10192970039326e-2, 0.57254459862746e3, 0.13918839778870e2];
  const W_TC = 647.096, W_PC = 22064, W_TMIN = 273.15, W_TMAX = 1073.15, W_PMAX = 100000;
  const W_T3 = 623.15, W_P3 = 16529.164; // region 1/2/3 corner (psat(623.15 K))

  function w1(T, p) {
    const pi = p / 16530, tau = 1386 / T, a = 7.1 - pi, b = tau - 1.222;
    let g = 0, gp = 0, gt = 0, gtt = 0;
    for (let i = 0; i < 34; i++) {
      const I = R1.I[i], J = R1.J[i], n = R1.n[i];
      const aI = Math.pow(a, I), bJ = Math.pow(b, J);
      g += n * aI * bJ;
      gp -= n * I * Math.pow(a, I - 1) * bJ;
      gt += n * aI * J * Math.pow(b, J - 1);
      gtt += n * aI * J * (J - 1) * Math.pow(b, J - 2);
    }
    return {
      v: RW * T / p * pi * gp, h: RW * T * tau * gt, u: RW * T * (tau * gt - pi * gp),
      s: RW * (tau * gt - g), cp: -RW * tau * tau * gtt,
    };
  }
  function w2(T, p) {
    const pi = p / 1000, tau = 540 / T;
    let g0 = Math.log(pi), g0t = 0, g0tt = 0;
    for (let i = 0; i < 9; i++) {
      const J = R2_0.J[i], n = R2_0.n[i];
      g0 += n * Math.pow(tau, J); g0t += n * J * Math.pow(tau, J - 1); g0tt += n * J * (J - 1) * Math.pow(tau, J - 2);
    }
    let gr = 0, grp = 0, grt = 0, grtt = 0;
    const b = tau - 0.5;
    for (let i = 0; i < 43; i++) {
      const I = R2_R.I[i], J = R2_R.J[i], n = R2_R.n[i];
      const pI = Math.pow(pi, I), bJ = Math.pow(b, J);
      gr += n * pI * bJ; grp += n * I * Math.pow(pi, I - 1) * bJ;
      grt += n * pI * J * Math.pow(b, J - 1); grtt += n * pI * J * (J - 1) * Math.pow(b, J - 2);
    }
    const gp = 1 / pi + grp, gt = g0t + grt;
    return {
      v: RW * T / p * pi * gp, h: RW * T * tau * gt, u: RW * T * (tau * gt - pi * gp),
      s: RW * (tau * gt - (g0 + gr)), cp: -RW * tau * tau * (g0tt + grtt),
    };
  }
  function wPsat(T) {
    const n = R4, th = T + n[8] / (T - n[9]);
    const A = th * th + n[0] * th + n[1], B = n[2] * th * th + n[3] * th + n[4], C = n[5] * th * th + n[6] * th + n[7];
    return Math.pow(2 * C / (-B + Math.sqrt(B * B - 4 * A * C)), 4) * 1000;
  }
  function wTsat(p) {
    const n = R4, be = Math.pow(p / 1000, 0.25);
    const E = be * be + n[2] * be + n[5], F = n[0] * be * be + n[3] * be + n[6], G = n[1] * be * be + n[4] * be + n[7];
    const D = 2 * G / (-F - Math.sqrt(F * F - 4 * E * G));
    return (n[9] + D - Math.sqrt((n[9] + D) ** 2 - 4 * (n[8] + n[9] * D))) / 2;
  }
  const wPB23 = (T) => (B23[0] + B23[1] * T + B23[2] * T * T) * 1000;
  const wTB23 = (p) => B23[3] + Math.sqrt((p / 1000 - B23[4]) / B23[2]);
  const R3_MSG = 'This state is in the near-critical region (IAPWS-IF97 region 3: about 350–590 °C above 16.5 MPa), which Thermo Lab does not include.';

  // Single-phase water at (T, p). `prefer` picks a side exactly on the saturation line.
  function waterTP(T, p, prefer) {
    if (T < W_TMIN - 1e-6 || T > W_TMAX + 1e-6) throw new Error('Water: T must be between 0 °C and 800 °C.');
    if (p <= 0 || p > W_PMAX) throw new Error('Water: p must be between 0 and 100 MPa.');
    if (T <= W_T3) {
      const ps = wPsat(T);
      const liquid = p > ps || (p === ps && prefer === 'liquid');
      return { ...(liquid ? w1(T, p) : w2(T, p)), region: liquid ? 1 : 2 };
    }
    if (p <= wPB23(T)) return { ...w2(T, p), region: 2 };
    throw new Error(R3_MSG);
  }
  function waterSat(by, val) {
    let T, p;
    if (by === 'T') {
      T = val;
      if (T < W_TMIN - 1e-6 || T >= W_TC) throw new Error('Water: saturation needs 0 °C ≤ T < 373.946 °C.');
      p = wPsat(T);
    } else {
      p = val;
      if (p < 0.611212 || p >= W_PC) throw new Error('Water: saturation needs 0.6112 kPa ≤ p < 22.064 MPa.');
      T = wTsat(p);
    }
    if (T > W_T3 + 1e-9) throw new Error(R3_MSG);
    const f = w1(T, p), g = w2(T, p);
    return { T, p, vf: f.v, vg: g.v, uf: f.u, ug: g.u, hf: f.h, hg: g.h, sf: f.s, sg: g.s };
  }

  // =========================================================================================
  // R-134a — Tillner-Roth & Baehr (1994)
  // =========================================================================================
  const RF = {
    Tc: 374.18, rhoc: 508.0, M: 102.032, R: 8.314471 / 102.032, Ttp: 169.85, pc: 4056.3,
    n: [0.5586817e-1, 0.4982230, 0.2458698e-1, 0.8570145e-3, 0.4788584e-3, -0.1800808e1, 0.2671641, -0.4781652e-1,
      0.1423987e-1, 0.3324062, -0.7485907e-2, 0.1017263e-3, -0.5184567, -0.8692288e-1, 0.2057144, -0.5000457e-2,
      0.4603262e-3, -0.3497836e-2, 0.6995038e-2, -0.1452184e-1, -0.1285458e-3],
    t: [-0.5, 0, 0, 0, 1.5, 1.5, 2, 2, 1, 3, 5, 1, 5, 5, 6, 10, 10, 10, 18, 22, 50],
    d: [2, 1, 3, 6, 6, 1, 1, 2, 5, 2, 2, 4, 1, 4, 1, 2, 4, 1, 5, 3, 10],
    l: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4],
    a: [-1.019535, 9.047135, -1.629789, -9.723916, -3.927170],
  };
  // Reduced Helmholtz energy and its (scaled) derivatives: d* = δ·∂/∂δ etc.
  function rfAlpha(rho, T) {
    const del = rho / RF.rhoc, tau = RF.Tc / T;
    let ar = 0, ad = 0, add = 0, at = 0, att = 0, adt = 0;
    for (let i = 0; i < 21; i++) {
      const n = RF.n[i], d = RF.d[i], t = RF.t[i], l = RF.l[i];
      let base = n * Math.pow(del, d) * Math.pow(tau, t);
      if (l === 0) {
        ar += base; ad += d * base; add += d * (d - 1) * base;
        at += t * base; att += t * (t - 1) * base; adt += d * t * base;
      } else {
        const dl = Math.pow(del, l), e = Math.exp(-dl);
        base *= e;
        const k = d - l * dl;
        ar += base; ad += k * base; add += (k * (k - 1) - l * l * dl) * base;
        at += t * base; att += t * (t - 1) * base; adt += k * t * base;
      }
    }
    const a = RF.a;
    const a0 = Math.log(del) + a[0] + a[1] * tau + a[2] * Math.log(tau) + a[3] * Math.pow(tau, -0.5) + a[4] * Math.pow(tau, -0.75);
    const a0t = a[1] * tau + a[2] - 0.5 * a[3] * Math.pow(tau, -0.5) - 0.75 * a[4] * Math.pow(tau, -0.75);
    const a0tt = -a[2] + 0.75 * a[3] * Math.pow(tau, -0.5) + 1.3125 * a[4] * Math.pow(tau, -0.75);
    return { ar, ad, add, at, att, adt, a0, a0t, a0tt };
  }
  let rfRef = { h: 0, s: 0 };   // ASHRAE offsets, set below once the solver exists
  function rfProps(rho, T) {
    const A = rfAlpha(rho, T), R = RF.R;
    const p = rho * R * T * (1 + A.ad);
    const h = R * T * (1 + A.a0t + A.at + A.ad) + rfRef.h;
    const s = R * (A.a0t + A.at - A.a0 - A.ar) + rfRef.s;
    const u = R * T * (A.a0t + A.at) + rfRef.h - 0;   // u = h − pv; offsets shift u like h
    const g = R * T * (1 + A.a0 + A.ar + A.ad);
    const dpdr = R * T * (1 + 2 * A.ad + A.add);
    const cv = -R * (A.a0tt + A.att);
    const cp = cv + R * Math.pow(1 + A.ad - A.adt, 2) / (1 + 2 * A.ad + A.add);
    return { p, h, s, u: h - p / rho, g, dpdr, v: 1 / rho, cp, cv, rho };
  }
  // Saturation at T: equal pressure and Gibbs energy in both phases (Newton on ρl, ρv).
  function rfSatNewton(T, rl, rv) {
    for (let it = 0; it < 100; it++) {
      const L = rfProps(rl, T), V = rfProps(rv, T);
      const F1 = L.p - V.p, F2 = L.g - V.g;
      const J11 = L.dpdr, J12 = -V.dpdr, J21 = L.dpdr / rl, J22 = -V.dpdr / rv;
      const det = J11 * J22 - J12 * J21;
      let dl = (-F1 * J22 + F2 * J12) / det, dv = (-J11 * F2 + J21 * F1) / det;
      // Damp so densities stay on their own branches.
      const lim = (x, r, f) => Math.max(-f * r, Math.min(f * r, x));
      dl = lim(dl, rl, 0.2); dv = lim(dv, rv, 0.5);
      rl += dl; rv += dv;
      if (Math.abs(dl) < 1e-10 * rl && Math.abs(dv) < 1e-10 * rv) break;
    }
    return [rl, rv];
  }
  const rfSatCache = new Map();
  function rfSatT(T) {
    const key = T.toFixed(9);
    if (rfSatCache.has(key)) return rfSatCache.get(key);
    if (T < RF.Ttp - 1e-6 || T > RF.Tc - 1 + 1e-9) throw new Error('R-134a: saturation needs −103.3 °C ≤ T ≤ 100.0 °C (the solver stops 1 K short of the critical point).');
    // Close to the critical point plain guesses converge to the trivial (ρl = ρv) root, so march
    // up from 20 K below Tc, seeding each step with the previous densities.
    let rl, rv;
    if (T > RF.Tc - 20 + 1e-9) {
      // Seed from the cached solution on a 0.5 K grid just below T (built recursively, once).
      const t0 = RF.Tc - 20;
      const base = rfSatT(t0 + Math.floor((T - t0) / 0.5 - 1e-9) * 0.5);
      [rl, rv] = rfSatNewton(T, base.L.rho, base.V.rho);
    } else {
      const Tr = T / RF.Tc, w = 0.32684;
      const psG = RF.pc * Math.pow(10, 7 / 3 * (1 + w) * (1 - 1 / Tr));
      const Zc = RF.pc / (RF.rhoc * RF.R * RF.Tc);
      [rl, rv] = rfSatNewton(T, RF.rhoc / Math.pow(Zc, Math.pow(1 - Tr, 2 / 7)), psG / (RF.R * T) * (1 + 0.3 * psG / RF.pc));
    }
    const L = rfProps(rl, T), V = rfProps(rv, T);
    if (!(rl > rv * 1.0001)) throw new Error('R-134a: saturation solve failed (too close to the critical point).');
    const out = { T, p: (L.p + V.p) / 2, L, V };
    if (rfSatCache.size > 4000) rfSatCache.clear();
    rfSatCache.set(key, out);
    return out;
  }
  function rfSat(by, val) {
    let T;
    if (by === 'T') T = val;
    else {
      const p = val;
      const pTop = rfSatT(RF.Tc - 1).p;
      if (p < 0.3896 || p > pTop) throw new Error(`R-134a: saturation needs 0.39 kPa ≤ p ≤ ${(pTop / 1000).toFixed(2)} MPa.`);
      T = solve(t => rfSatT(t).p - p, RF.Ttp, RF.Tc - 1, 1e-11);
    }
    const S = rfSatT(T);
    return { T, p: S.p, vf: S.L.v, vg: S.V.v, uf: S.L.u, ug: S.V.u, hf: S.L.h, hg: S.V.h, sf: S.L.s, sg: S.V.s };
  }
  // Density from (T, p) on the requested branch.
  function rfRho(T, p, phase) {
    const f = (r) => rfProps(r, T).p - p;
    if (T <= RF.Tc - 1) {
      const S = rfSatT(T);
      if (phase === 'liquid' || (phase == null && p > S.p)) return solve(f, S.L.rho * 0.9999, 1800);
      return solve(f, 1e-9, S.V.rho * 1.0001);
    }
    // Supercritical temperature: p(ρ) is monotonic.
    return solve(f, 1e-9, 1800);
  }
  function r134aTP(T, p, prefer) {
    if (T < RF.Ttp || T > 455) throw new Error('R-134a: T must be between −103 °C and 180 °C.');
    if (p <= 0 || p > 70000) throw new Error('R-134a: p must be between 0 and 70 MPa.');
    let phase = null;
    if (T <= RF.Tc - 1) { const ps = rfSatT(T).p; phase = p > ps || (p === ps && prefer === 'liquid') ? 'liquid' : 'vapor'; }
    const P = rfProps(rfRho(T, p, phase), T);
    return { v: P.v, u: P.u, h: P.h, s: P.s, cp: P.cp, region: phase === 'liquid' ? 1 : 2 };
  }
  // ASHRAE reference: saturated liquid at −40 °C has h = 0 and s = 0.
  (function setRef() {
    const S = rfSatT(233.15);
    rfRef = { h: -S.L.h, s: -S.L.s };
    rfSatCache.clear();
  })();

  // =========================================================================================
  // AIR — ideal gas
  // =========================================================================================
  const RU = 8.314462618, M_AIR = 28.97, R_AIR = RU / M_AIR;   // 0.287 kJ/kg·K
  const NASA = {   // [low 200–1000 K], [high 1000–6000 K]: cp/R = a1 + a2 T + a3 T² + a4 T³ + a5 T⁴
    N2: [[3.298677, 1.4082404e-3, -3.963222e-6, 5.641515e-9, -2.444854e-12], [2.92664, 1.4879768e-3, -5.68476e-7, 1.0097038e-10, -6.753351e-15]],
    O2: [[3.2129364, 1.1274864e-3, -5.75615e-7, 1.3138773e-9, -8.768554e-13], [3.6975782, 6.1351969e-4, -1.258842e-7, 1.775281e-11, -1.1364354e-15]],
  };
  const MIX = [['N2', 0.7808], ['O2', 0.2095]], X_AR = 0.0097;
  const Hint = (a, T) => a[0] * T + a[1] * T * T / 2 + a[2] * T ** 3 / 3 + a[3] * T ** 4 / 4 + a[4] * T ** 5 / 5;
  const Sint = (a, T) => a[0] * Math.log(T) + a[1] * T + a[2] * T * T / 2 + a[3] * T ** 3 / 3 + a[4] * T ** 4 / 4;
  function molarHS(T) {
    let H = X_AR * 2.5 * T, S = X_AR * 2.5 * Math.log(T), Cp = X_AR * 2.5;
    for (const [sp, x] of MIX) {
      const [lo, hi] = NASA[sp];
      const cpOf = (a, t) => a[0] + a[1] * t + a[2] * t * t + a[3] * t ** 3 + a[4] * t ** 4;
      if (T <= 1000) { H += x * Hint(lo, T); S += x * Sint(lo, T); Cp += x * cpOf(lo, T); } else {
        H += x * (Hint(lo, 1000) + Hint(hi, T) - Hint(hi, 1000));
        S += x * (Sint(lo, 1000) + Sint(hi, T) - Sint(hi, 1000));
        Cp += x * cpOf(hi, T);
      }
    }
    return { H, S, Cp };   // in units of R_u (H in R_u·K)
  }
  const AIR0 = molarHS(300);
  function airHS(T) {
    if (T < 200 || T > 3000) throw new Error('Air: T must be between 200 K and 3000 K.');
    const m = molarHS(T);
    return {
      h: (m.H - AIR0.H) * R_AIR + 300.19,
      s0: (m.S - AIR0.S) * R_AIR + 1.70203,
      cp: m.Cp * R_AIR,
    };
  }
  const AIR_COLD = { cp: 1.005, cv: 1.005 / 1.4, k: 1.4, R: 1.005 - 1.005 / 1.4 };   // k exactly 1.4
  function gasTP(sub, T, p) {
    if (sub === 'aircold') {
      const { cp, cv, R } = AIR_COLD;
      if (T <= 0) throw new Error('T must be above 0 K.');
      return { v: R * T / p, h: cp * T, u: cv * T, s0: cp * Math.log(T / 298.15), s: cp * Math.log(T / 298.15) - R * Math.log(p / 101.325), cp, region: 0 };
    }
    const a = airHS(T);
    return { v: R_AIR * T / p, h: a.h, u: a.h - R_AIR * T, s0: a.s0, s: a.s0 - R_AIR * Math.log(p / 101.325), cp: a.cp, region: 0 };
  }
  const gasR = (sub) => (sub === 'aircold' ? AIR_COLD.R : R_AIR);
  function gasT(sub, prop, val, p) {
    const lo = sub === 'aircold' ? 1 : 200, hi = sub === 'aircold' ? 5000 : 3000;
    return solve(T => {
      const g = gasTP(sub, T, p || 101.325);
      return (prop === 'h' ? g.h : prop === 'u' ? g.u : prop === 's0' ? g.s0 : g.s) - val;
    }, lo, hi);
  }

  // =========================================================================================
  // Generic state evaluation
  // =========================================================================================
  const SUBSTANCES = {
    water: { name: 'Water (steam)', short: 'H₂O', kind: 'fluid', Tc: W_TC, pc: W_PC, Tmin: W_TMIN },
    r134a: { name: 'Refrigerant 134a', short: 'R-134a', kind: 'fluid', Tc: RF.Tc, pc: RF.pc, Tmin: RF.Ttp },
    air: { name: 'Air (ideal gas, variable cp)', short: 'Air', kind: 'gas' },
    aircold: { name: 'Air (cold-air standard, k = 1.4)', short: 'Air (cold)', kind: 'gas' },
  };
  const isGas = (sub) => SUBSTANCES[sub].kind === 'gas';
  function sat(sub, by, val) {
    if (sub === 'water') return waterSat(by, val);
    if (sub === 'r134a') return rfSat(by, val);
    throw new Error('Saturation properties apply to water and R-134a only.');
  }
  function single(sub, T, p, prefer) { return sub === 'water' ? waterTP(T, p, prefer) : r134aTP(T, p, prefer); }
  const Tmax = (sub) => (sub === 'water' ? W_TMAX : 455);
  const Pmax = (sub) => (sub === 'water' ? W_PMAX : 70000);

  function mix(S, x) {
    return {
      T: S.T, p: S.p, x, v: S.vf + x * (S.vg - S.vf), u: S.uf + x * (S.ug - S.uf),
      h: S.hf + x * (S.hg - S.hf), s: S.sf + x * (S.sg - S.sf), phase: x <= 0 ? 'Saturated liquid' : x >= 1 ? 'Saturated vapor' : 'Two-phase mixture',
    };
  }
  function phaseName(sub, T, p, region) {
    const P = SUBSTANCES[sub];
    if (T >= P.Tc && p >= P.pc) return 'Supercritical fluid';
    if (T >= P.Tc) return 'Superheated vapor (gas)';
    if (p >= P.pc) return 'Compressed liquid';
    return region === 1 ? 'Compressed liquid' : 'Superheated vapor';
  }
  function fromTP(sub, T, p, prefer) {
    if (isGas(sub)) {
      const g = gasTP(sub, T, p);
      return { T, p, v: g.v, u: g.u, h: g.h, s: g.s, s0: g.s0, cp: g.cp, x: null, phase: 'Ideal gas' };
    }
    const r = single(sub, T, p, prefer);
    return { T, p, v: r.v, u: r.u, h: r.h, s: r.s, cp: r.cp, x: null, phase: phaseName(sub, T, p, r.region) };
  }
  // Fluid at fixed p with one more property y ∈ {h, s, v, u}: check the dome, else solve T.
  function fluidPY(sub, p, y, val) {
    const P = SUBSTANCES[sub];
    if (p < P.pc) {
      let S = null;
      try { S = sat(sub, 'p', p); } catch (e) { if (!/region 3|near-critical/.test(e.message)) throw e; }
      if (S) {
        const f = S[y + 'f'], g = S[y + 'g'];
        if (val >= f && val <= g) return mix(S, (val - f) / (g - f));
        const lo = val < f;
        const T = solve(t => single(sub, t, p, lo ? 'liquid' : 'vapor')[y] - val, lo ? P.Tmin : S.T, lo ? S.T : Tmax(sub));
        return fromTP(sub, T, p, lo ? 'liquid' : 'vapor');
      }
    }
    if (sub === 'water') {
      // Above the region-1/2 corner: region 1 to 350 °C, region 2 above the B23 line.
      const top1 = waterTP(W_T3, p, 'liquid')[y];
      if (val <= top1) return fromTP(sub, solve(t => waterTP(t, p, 'liquid')[y] - val, W_TMIN, W_T3), p);
      const tb = Math.min(W_TMAX, wTB23(p));
      if (tb >= W_TMAX || val < waterTP(tb + 1e-6, p)[y]) throw new Error(R3_MSG);
      return fromTP(sub, solve(t => waterTP(t, p)[y] - val, tb + 1e-6, W_TMAX), p);
    }
    return fromTP(sub, solve(t => single(sub, t, p)[y] - val, P.Tmin, Tmax(sub)), p);
  }
  // Fluid at fixed T with one more property y ∈ {v, s, h, u}: dome, else solve p.
  function fluidTY(sub, T, y, val) {
    const P = SUBSTANCES[sub];
    if (T < P.Tc) {
      const S = sat(sub, 'T', T);
      const f = S[y + 'f'], g = S[y + 'g'];
      if ((val - f) * (val - g) <= 0) return mix(S, (val - f) / (g - f));
      // v, s and h decrease with p in the vapour region; liquid lies at p > psat.
      const vapor = y === 'h' ? val > g : (y === 'v' || y === 's' || y === 'u') ? val > g : false;
      const lo = vapor ? 0.01 : S.p, hi = vapor ? S.p : Pmax(sub);
      const p = solve(pp => single(sub, T, pp, vapor ? 'vapor' : 'liquid')[y] - val, lo * (vapor ? 1 : 1.0000001), hi * (vapor ? 0.9999999 : 1));
      return fromTP(sub, T, p, vapor ? 'vapor' : 'liquid');
    }
    const p = solve(pp => single(sub, T, pp)[y] - val, 0.01, Pmax(sub));
    return fromTP(sub, T, p);
  }

  // state(sub, { T, p, x, v, u, h, s }) — any two independent properties (T K, p kPa).
  function state(sub, q) {
    const has = (k) => q[k] != null && q[k] !== '' && isFinite(q[k]);
    const keys = ['T', 'p', 'x', 'v', 'u', 'h', 's'].filter(has);
    if (keys.length !== 2) throw new Error('Give exactly two independent properties.');
    const k = keys.join('');
    let st;
    if (isGas(sub)) {
      const R = gasR(sub);
      if (has('x')) throw new Error('Quality applies to two-phase fluids, not an ideal gas.');
      if (k === 'Tp') st = fromTP(sub, q.T, q.p);
      else if (k === 'Tv') st = fromTP(sub, q.T, R * q.T / q.v);
      else if (k === 'pv') st = fromTP(sub, q.p * q.v / R, q.p);
      else if (k === 'ph') st = fromTP(sub, gasT(sub, 'h', q.h), q.p);
      else if (k === 'pu') st = fromTP(sub, gasT(sub, 'u', q.u), q.p);
      else if (k === 'ps') st = fromTP(sub, gasT(sub, 's', q.s, q.p), q.p);
      else if (k === 'Ts') { const g = gasTP(sub, q.T, 101.325); st = fromTP(sub, q.T, 101.325 * Math.exp((g.s - q.s) / R)); }
      else if (k === 'vs') { const T = solve(t => gasTP(sub, t, R * t / q.v).s - q.s, sub === 'aircold' ? 1 : 200, sub === 'aircold' ? 5000 : 3000); st = fromTP(sub, T, R * T / q.v); }
      else if (k === 'vu') { const T = gasT(sub, 'u', q.u); st = fromTP(sub, T, R * T / q.v); }
      else if (k === 'vh') { const T = gasT(sub, 'h', q.h); st = fromTP(sub, T, R * T / q.v); }
      else throw new Error('For an ideal gas, T, u and h are not independent — pair one of them with p, v or s.');
      return st;
    }
    if (k === 'Tp') {
      const P = SUBSTANCES[sub];
      if (q.T < P.Tc && q.p < P.pc) {
        const ps = sat(sub, 'T', q.T).p;
        if (Math.abs(q.p - ps) / ps < 1e-9) throw new Error('T and p are on the saturation line — they are not independent there. Give the quality x too.');
      }
      st = fromTP(sub, q.T, q.p);
    } else if (k === 'Tx') st = mix(sat(sub, 'T', q.T), clampX(q.x));
    else if (k === 'px') st = mix(sat(sub, 'p', q.p), clampX(q.x));
    else if (k === 'ph') st = fluidPY(sub, q.p, 'h', q.h);
    else if (k === 'ps') st = fluidPY(sub, q.p, 's', q.s);
    else if (k === 'pv') st = fluidPY(sub, q.p, 'v', q.v);
    else if (k === 'pu') st = fluidPY(sub, q.p, 'u', q.u);
    else if (k === 'Tv') st = fluidTY(sub, q.T, 'v', q.v);
    else if (k === 'Ts') st = fluidTY(sub, q.T, 's', q.s);
    else if (k === 'Th') st = fluidTY(sub, q.T, 'h', q.h);
    else if (k === 'Tu') st = fluidTY(sub, q.T, 'u', q.u);
    else if (k === 'xh' || k === 'xs' || k === 'xv') {
      const y = k[1], X = clampX(q.x);
      const T = solve(t => { const m = mix(sat(sub, 'T', t), X); return m[y] - q[y]; }, SUBSTANCES[sub].Tmin + 0.01, sub === 'water' ? W_T3 : RF.Tc - 1);
      st = mix(sat(sub, 'T', T), X);
    } else throw new Error(`The pair ${keys.join(', ')} isn't supported — use T or p with one other property.`);
    return st;
  }
  function clampX(x) { if (x < 0 || x > 1) throw new Error('Quality x must be between 0 and 1.'); return x; }

  // Saturation dome for plotting: [{ T, sf, sg, vf, vg, p }]
  const domeCache = {};
  function dome(sub) {
    if (domeCache[sub]) return domeCache[sub];
    const P = SUBSTANCES[sub];
    const top = sub === 'water' ? W_T3 : RF.Tc - 1;
    const pts = [];
    const N = 70;
    for (let i = 0; i <= N; i++) {
      // Cluster points toward the top where the dome bends sharply.
      const f = 1 - Math.pow(1 - i / N, 1.6);
      const T = P.Tmin + 0.01 + f * (top - P.Tmin - 0.01);
      try { const S = sat(sub, 'T', T); pts.push({ T, p: S.p, sf: S.sf, sg: S.sg, vf: S.vf, vg: S.vg, hf: S.hf, hg: S.hg }); } catch (_) { /* skip */ }
    }
    // IF97 here stops at 350 °C (region 3 isn't included): close the water dome to the critical point.
    if (sub === 'water') pts.push({ T: W_TC, p: W_PC, sf: 4.4070, sg: 4.4070, vf: 0.003106, vg: 0.003106, hf: 2087.5, hg: 2087.5 });
    return (domeCache[sub] = pts);
  }

  // =========================================================================================
  // Process paths (for T-s / p-v plots): constant-p, constant-v, isentropic, straight.
  // =========================================================================================
  function pathP(sub, p, a, b, n = 24) {   // constant pressure, from state a to state b (by h)
    const out = [];
    for (let i = 0; i <= n; i++) {
      const h = a.h + (b.h - a.h) * i / n;
      try { const st = isGas(sub) ? state(sub, { p, h }) : fluidPY(sub, p, 'h', h); out.push(st); } catch (_) { /* skip */ }
    }
    return out;
  }
  function pathV(sub, v, a, b, n = 24) {   // constant volume (ideal gas only)
    const out = [];
    for (let i = 0; i <= n; i++) { const T = a.T + (b.T - a.T) * i / n; out.push(fromTP(sub, T, gasR(sub) * T / v)); }
    return out;
  }
  function pathS(sub, a, b, n = 16) {      // isentropic, by pressure
    const out = [];
    for (let i = 0; i <= n; i++) {
      const p = a.p * Math.pow(b.p / a.p, i / n);
      try { out.push(state(sub, { p, s: a.s })); } catch (_) { /* skip */ }
    }
    return out;
  }
  const seg = (a, b) => [a, b];

  // =========================================================================================
  // Analyses
  // =========================================================================================
  // Second-law analysis of a cycle between two reservoirs (Moran ch. 5).
  //   mode: 'power' | 'refrigeration' | 'heatpump'; TH, TL in K; any two of QH, QL, W, perf.
  function reservoirCycle(mode, TH, TL, known) {
    if (!(TH > 0 && TL > 0)) throw new Error('Reservoir temperatures must be above 0 K.');
    if (!(TH > TL)) throw new Error('The hot reservoir must be hotter than the cold one.');
    let { QH, QL, W, perf } = known;
    const given = ['QH', 'QL', 'W', 'perf'].filter(k => known[k] != null && isFinite(known[k]));
    if (given.length < 2) throw new Error('Enter any two of Q_H, Q_C, W and the efficiency/COP.');
    // Energy balance W_cycle = Q_H − Q_C for all three (W is out for power, in otherwise).
    // With more than two given, the first two in the order Q_H, Q_C, W, perf win.
    const [k1, k2] = given;
    const pick = new Set([k1, k2]);
    QH = pick.has('QH') ? known.QH : null; QL = pick.has('QL') ? known.QL : null;
    W = pick.has('W') ? known.W : null; perf = pick.has('perf') ? known.perf : null;
    if (perf == null) {
      if (W == null) W = QH - QL; else if (QL == null) QL = QH - W; else QH = QL + W;
    } else if (mode === 'power') {                       // η = W / Q_H
      if (QH != null) W = perf * QH; else if (W != null) QH = W / perf; else QH = QL / (1 - perf);
      if (W == null) W = perf * QH;
      QL = QH - W;
    } else if (mode === 'refrigeration') {               // β = Q_C / W
      if (QL != null) W = QL / perf; else if (W != null) QL = perf * W; else W = QH / (1 + perf);
      if (QL == null) QL = perf * W;
      QH = QL + W;
    } else {                                             // γ = Q_H / W
      if (QH != null) W = QH / perf; else if (W != null) QH = perf * W; else W = QL / (perf - 1);
      if (QH == null) QH = perf * W;
      QL = QH - W;
    }
    const perfCalc = mode === 'power' ? W / QH : mode === 'refrigeration' ? QL / W : QH / W;
    const perfMax = mode === 'power' ? 1 - TL / TH : mode === 'refrigeration' ? TL / (TH - TL) : TH / (TH - TL);
    const warnings = [];
    if (given.length > 2) {
      if (Math.abs(known.QH - known.QL - known.W) > 1e-6 * Math.max(1, Math.abs(known.QH)) && ['QH', 'QL', 'W'].every(k => given.includes(k))) warnings.push('Q_H − Q_C ≠ W: the values you gave break the energy balance; results use the first two.');
      if (given.includes('perf') && Math.abs(perfCalc - known.perf) > 1e-6 * Math.abs(known.perf)) warnings.push('The efficiency/COP you gave doesn\'t match the heat and work values; results use the first two.');
    }
    // Clausius: σ_cycle = −∮(δQ/T)_b. Power: heat in from TH, out to TL; refrigerator/heat pump: in from TL, out to TH.
    const sigma = mode === 'power' ? QL / TL - QH / TH : QH / TH - QL / TL;
    const tol = 1e-9 * Math.max(Math.abs(QH / TH), Math.abs(QL / TL), 1e-12);
    let verdict;
    if (QH < 0 || QL < 0 || W < 0) verdict = { kind: 'bad', text: 'Negative heat or work — check the directions you entered.' };
    else if (mode === 'power' && QL === 0 && W > 0) verdict = { kind: 'bad', text: 'Impossible — a cycle that rejects no heat violates the Kelvin–Planck statement.' };
    else if (mode !== 'power' && W === 0 && QL > 0) verdict = { kind: 'bad', text: 'Impossible — moving heat from cold to hot with no work input violates the Clausius statement.' };
    else if (sigma < -tol) verdict = { kind: 'bad', text: 'Impossible — σ_cycle < 0 (it would beat the Carnot limit).' };
    else if (Math.abs(sigma) <= tol) verdict = { kind: 'rev', text: 'Reversible (Carnot) — σ_cycle = 0, the maximum possible performance.' };
    else verdict = { kind: 'ok', text: 'Possible, irreversible — σ_cycle > 0.' };
    return { QH, QL, W, perf: perfCalc, perfMax, ratio: perfCalc / perfMax, sigma, clausius: -sigma, verdict, warnings };
  }

  // Control-volume device at steady state (Moran ch. 4 & 6).
  //   d: { device, sub, in: stateQuery, p2, mode: 'eta'|'T2'|'h2'|'x2', eta, T2, h2, x2, mdot, V1, V2, Qdot, Tb, T0 }
  function device(d) {
    const sub = d.sub;
    const s1 = state(sub, d.in);
    const kind = d.device;
    const ke = (V) => (V || 0) * (V || 0) / 2000;           // kJ/kg
    const mdot = d.mdot > 0 ? d.mdot : 1;
    let s2, s2s = null, eta = null;
    const p2 = d.p2;
    if (kind === 'throttle') {
      s2 = state(sub, { p: p2, h: s1.h });
    } else if (kind === 'heater') {
      s2 = d.mode === 'x2' ? state(sub, { p: p2, x: d.x2 }) : d.mode === 'h2' ? state(sub, { p: p2, h: d.h2 }) : state(sub, { T: d.T2, p: p2 });
    } else {
      s2s = state(sub, { p: p2, s: s1.s });
      const expand = kind === 'turbine' || kind === 'nozzle';
      if (d.mode === 'eta') {
        eta = d.eta;
        if (!(eta > 0 && eta <= 1)) throw new Error('Isentropic efficiency must be between 0 and 1.');
        if (kind === 'nozzle') {
          const keS = s1.h - s2s.h + ke(d.V1);                // ideal exit KE
          s2 = state(sub, { p: p2, h: s1.h + ke(d.V1) - eta * keS });
        } else if (kind === 'diffuser') {
          // η = (h2s − h1)/(h2 − h1) with h2 − h1 = KE1 − KE2.
          const dh = ke(d.V1) - ke(d.V2);
          s2 = state(sub, { p: p2, h: s1.h + dh });
          eta = dh > 0 ? (s2s.h - s1.h) / dh : null;
        } else {
          const dhs = s2s.h - s1.h;
          s2 = state(sub, { p: p2, h: expand ? s1.h + eta * dhs : s1.h + dhs / eta });
        }
      } else {
        s2 = d.mode === 'x2' ? state(sub, { p: p2, x: d.x2 }) : d.mode === 'h2' ? state(sub, { p: p2, h: d.h2 }) : state(sub, { T: d.T2, p: p2 });
        if (kind === 'turbine') eta = (s1.h - s2.h) / (s1.h - s2s.h);
        else if (kind === 'compressor' || kind === 'pump') eta = (s2s.h - s1.h) / (s2.h - s1.h);
        else if (kind === 'nozzle') eta = (s1.h - s2.h + ke(d.V1)) / (s1.h - s2s.h + ke(d.V1));
      }
    }
    // Energy balance per unit mass: q − w = (h2 − h1) + ΔKE.
    let w = 0, q = 0, V2 = d.V2 || 0;
    if (kind === 'turbine' || kind === 'compressor' || kind === 'pump') {
      q = d.Qdot != null && isFinite(d.Qdot) ? d.Qdot / mdot : 0;
      w = q - (s2.h - s1.h) - (ke(d.V2) - ke(d.V1));
    } else if (kind === 'nozzle') {
      V2 = Math.sqrt(Math.max(0, 2000 * (s1.h - s2.h + ke(d.V1))));
    } else if (kind === 'heater') {
      q = s2.h - s1.h + ke(d.V2) - ke(d.V1);
    }
    const Tb = d.Tb > 0 ? d.Tb : null;
    const Qdot = q * mdot;
    const sigma = mdot * (s2.s - s1.s) - (Qdot !== 0 && Tb ? Qdot / Tb : 0);
    const T0 = d.T0 > 0 ? d.T0 : 298.15;
    return {
      s1, s2, s2s, eta, w, q, Wdot: w * mdot, Qdot, V2, mdot, sigma, sigmaUnknownTb: Qdot !== 0 && !Tb,
      Ed: T0 * sigma, ds: s2.s - s1.s,
    };
  }

  // ---- cycles ---------------------------------------------------------------------------------
  // Each returns { states: [{ label, ...state }], procs: [{ from, to, kind, path: [states], label }],
  //   q/w per process, totals, performance, reservoir second-law figures, sub }.
  const S = (label, st) => ({ label, ...st });

  function rankine(o) {
    const sub = 'water';
    const pB = o.pBoiler, pC = o.pCond, et = o.etaT ?? 1, ep = o.etaP ?? 1;
    if (!(pB > pC)) throw new Error('Boiler pressure must be above condenser pressure.');
    const st = [], procs = [];
    const s1 = o.T1 != null ? state(sub, { T: o.T1, p: pB }) : state(sub, { p: pB, x: 1 });
    if (s1.x === null && s1.phase === 'Compressed liquid') throw new Error('Turbine inlet is liquid — raise the turbine inlet temperature.');
    const expandTo = (a, p) => { const is = state(sub, { p, s: a.s }); return { is, act: state(sub, { p, h: a.h - et * (a.h - is.h) }) }; };
    let wT = 0, qIn = 0;
    const reheat = o.reheat && o.pReheat > pC && o.pReheat < pB;
    let last;
    st.push(S('1', s1));
    if (reheat) {
      const e1 = expandTo(s1, o.pReheat);
      const s3 = state(sub, { T: o.TReheat ?? o.T1 ?? s1.T, p: o.pReheat });
      const e2 = expandTo(s3, pC);
      st.push(S('2', e1.act), S('3', s3), S('4', e2.act));
      wT = (s1.h - e1.act.h) + (s3.h - e2.act.h);
      procs.push({ from: '1', to: '2', kind: 'expand', label: 'HP turbine', w: s1.h - e1.act.h, q: 0, path: et < 1 ? seg(s1, e1.act) : pathS(sub, s1, e1.act), ideal: e1.is });
      procs.push({ from: '2', to: '3', kind: 'heat', label: 'Reheat', q: s3.h - e1.act.h, w: 0, path: pathP(sub, o.pReheat, e1.act, s3) });
      procs.push({ from: '3', to: '4', kind: 'expand', label: 'LP turbine', w: s3.h - e2.act.h, q: 0, path: et < 1 ? seg(s3, e2.act) : pathS(sub, s3, e2.act), ideal: e2.is });
      qIn += s3.h - e1.act.h;
      last = e2.act;
    } else {
      const e = expandTo(s1, pC);
      st.push(S('2', e.act));
      wT = s1.h - e.act.h;
      procs.push({ from: '1', to: '2', kind: 'expand', label: 'Turbine', w: wT, q: 0, path: et < 1 ? seg(s1, e.act) : pathS(sub, s1, e.act), ideal: e.is });
      last = e.act;
    }
    const n = st.length;                            // condenser exit / pump exit labels follow on
    const sc = state(sub, { p: pC, x: 0 });
    const pumpIs = state(sub, { p: pB, s: sc.s });
    const sp = state(sub, { p: pB, h: sc.h + (pumpIs.h - sc.h) / ep });
    st.push(S(String(n + 1), sc), S(String(n + 2), sp));
    const qOut = last.h - sc.h, wP = sp.h - sc.h;
    qIn += s1.h - sp.h;
    procs.push({ from: String(n), to: String(n + 1), kind: 'reject', label: 'Condenser', q: -qOut, w: 0, path: pathP(sub, pC, last, sc) });
    procs.push({ from: String(n + 1), to: String(n + 2), kind: 'compress', label: 'Pump', w: -wP, q: 0, path: seg(sc, sp), ideal: pumpIs });
    procs.push({ from: String(n + 2), to: '1', kind: 'heat', label: 'Boiler', q: s1.h - sp.h, w: 0, path: pathP(sub, pB, sp, s1) });
    const wNet = wT - wP;
    return finish({ sub, kind: 'power', states: st, procs, qIn, qOut, wNet, extra: { wT, wP, bwr: wP / wT, x2: last.x } }, o);
  }

  function brayton(o) {
    const sub = o.cold ? 'aircold' : 'air', R = gasR(sub);
    const rp = o.rp, ec = o.etaC ?? 1, et = o.etaT ?? 1, eps = o.regen || 0;
    if (!(rp > 1)) throw new Error('Pressure ratio must be above 1.');
    const s1 = state(sub, { T: o.T1, p: o.p1 });
    const p2 = o.p1 * rp;
    const s2s = state(sub, { p: p2, s: s1.s });
    const s2 = state(sub, { p: p2, h: s1.h + (s2s.h - s1.h) / ec });
    const s3 = state(sub, { T: o.T3, p: p2 });
    if (!(s3.T > s2.T)) throw new Error('Turbine inlet temperature must be above the compressor exit temperature.');
    const s4s = state(sub, { p: o.p1, s: s3.s });
    const s4 = state(sub, { p: o.p1, h: s3.h - et * (s3.h - s4s.h) });
    const states = [S('1', s1), S('2', s2)];
    const procs = [{ from: '1', to: '2', kind: 'compress', label: 'Compressor', w: -(s2.h - s1.h), q: 0, path: ec < 1 ? seg(s1, s2) : pathS(sub, s1, s2), ideal: s2s }];
    let qIn, qOut, hx = s2, hy = s4;
    if (eps > 0 && s4.T > s2.T) {
      hx = state(sub, { p: p2, h: s2.h + eps * (s4.h - s2.h) });
      hy = state(sub, { p: o.p1, h: s4.h - (hx.h - s2.h) });
      states.push(S('x', hx));
      procs.push({ from: '2', to: 'x', kind: 'regen', label: 'Regenerator (cold side)', q: hx.h - s2.h, w: 0, internal: true, path: pathP(sub, p2, s2, hx) });
    }
    states.push(S('3', s3), S('4', s4));
    procs.push({ from: hx === s2 ? '2' : 'x', to: '3', kind: 'heat', label: 'Combustor / heater', q: s3.h - hx.h, w: 0, path: pathP(sub, p2, hx, s3) });
    procs.push({ from: '3', to: '4', kind: 'expand', label: 'Turbine', w: s3.h - s4.h, q: 0, path: et < 1 ? seg(s3, s4) : pathS(sub, s3, s4), ideal: s4s });
    if (hy !== s4) {
      states.push(S('y', hy));
      procs.push({ from: '4', to: 'y', kind: 'regen', label: 'Regenerator (hot side)', q: -(s4.h - hy.h), w: 0, internal: true, path: pathP(sub, o.p1, s4, hy) });
    }
    qIn = s3.h - hx.h; qOut = hy.h - s1.h;
    procs.push({ from: hy === s4 ? '4' : 'y', to: '1', kind: 'reject', label: 'Heat rejection', q: -qOut, w: 0, path: pathP(sub, o.p1, hy, s1) });
    const wC = s2.h - s1.h, wT = s3.h - s4.h;
    return finish({ sub, kind: 'power', states, procs, qIn, qOut, wNet: wT - wC, extra: { wT, wC, bwr: wC / wT, R } }, o);
  }

  // Closed-system air-standard cycles: work/heat are on u, mass basis (kJ/kg).
  function isentropicV(sub, a, v2) { return state(sub, { v: v2, s: a.s }); }
  function otto(o) {
    const sub = o.cold ? 'aircold' : 'air', R = gasR(sub);
    const r = o.r;
    if (!(r > 1)) throw new Error('Compression ratio must be above 1.');
    const s1 = state(sub, { T: o.T1, p: o.p1 });
    const v2 = s1.v / r;
    const s2 = isentropicV(sub, s1, v2);
    const s3 = o.qIn > 0 ? state(sub, { v: v2, u: s2.u + o.qIn }) : state(sub, { T: o.T3, v: v2 });
    if (!(s3.T > s2.T)) throw new Error('Peak temperature must be above the end-of-compression temperature.');
    const s4 = isentropicV(sub, s3, s1.v);
    const qIn = s3.u - s2.u, qOut = s4.u - s1.u;
    const procs = [
      { from: '1', to: '2', kind: 'compress', label: 'Isentropic compression', w: -(s2.u - s1.u), q: 0, path: pathS(sub, s1, s2) },
      { from: '2', to: '3', kind: 'heat', label: 'Constant-volume heat addition', q: qIn, w: 0, path: pathV(sub, v2, s2, s3) },
      { from: '3', to: '4', kind: 'expand', label: 'Isentropic expansion', w: s3.u - s4.u, q: 0, path: pathS(sub, s3, s4) },
      { from: '4', to: '1', kind: 'reject', label: 'Constant-volume heat rejection', q: -qOut, w: 0, path: pathV(sub, s1.v, s4, s1) },
    ];
    const wNet = qIn - qOut;
    return finish({ sub, kind: 'power', closed: true, states: [S('1', s1), S('2', s2), S('3', s3), S('4', s4)], procs, qIn, qOut, wNet,
      extra: { mep: wNet / (s1.v - v2), R, ideal: 1 - Math.pow(r, 1 - 1.4) } }, o);
  }
  function diesel(o) {
    const sub = o.cold ? 'aircold' : 'air';
    const r = o.r, rc = o.rc;
    if (!(r > 1)) throw new Error('Compression ratio must be above 1.');
    const s1 = state(sub, { T: o.T1, p: o.p1 });
    const v2 = s1.v / r;
    const s2 = isentropicV(sub, s1, v2);
    let s3;
    if (rc > 1) s3 = state(sub, { v: v2 * rc, p: s2.p });
    else if (o.T3 > s2.T) s3 = state(sub, { T: o.T3, p: s2.p });
    else throw new Error('Give a cutoff ratio above 1 (or a peak temperature above T₂).');
    if (s3.v >= s1.v) throw new Error('Cutoff volume reaches the bottom-dead-centre volume — lower the cutoff ratio.');
    const s4 = isentropicV(sub, s3, s1.v);
    const qIn = s3.h - s2.h, qOut = s4.u - s1.u;
    const procs = [
      { from: '1', to: '2', kind: 'compress', label: 'Isentropic compression', w: -(s2.u - s1.u), q: 0, path: pathS(sub, s1, s2) },
      { from: '2', to: '3', kind: 'heat', label: 'Constant-pressure heat addition', q: qIn, w: s2.p * (s3.v - v2), path: pathP(sub, s2.p, s2, s3) },
      { from: '3', to: '4', kind: 'expand', label: 'Isentropic expansion', w: s3.u - s4.u, q: 0, path: pathS(sub, s3, s4) },
      { from: '4', to: '1', kind: 'reject', label: 'Constant-volume heat rejection', q: -qOut, w: 0, path: pathV(sub, s1.v, s4, s1) },
    ];
    const wNet = qIn - qOut;
    return finish({ sub, kind: 'power', closed: true, states: [S('1', s1), S('2', s2), S('3', s3), S('4', s4)], procs, qIn, qOut, wNet,
      extra: { mep: wNet / (s1.v - v2), rc: s3.v / v2 } }, o);
  }
  function vaporCompression(o) {
    const sub = 'r134a';
    const ec = o.etaC ?? 1;
    const evap = sat(sub, 'T', o.Tevap), cond = sat(sub, 'T', o.Tcond);
    if (!(cond.p > evap.p)) throw new Error('Condenser temperature must be above evaporator temperature.');
    const s1 = o.superheat > 0 ? state(sub, { T: o.Tevap + o.superheat, p: evap.p }) : state(sub, { T: o.Tevap, x: 1 });
    const s2s = state(sub, { p: cond.p, s: s1.s });
    const s2 = state(sub, { p: cond.p, h: s1.h + (s2s.h - s1.h) / ec });
    const s3 = o.subcool > 0 ? state(sub, { T: o.Tcond - o.subcool, p: cond.p }) : state(sub, { T: o.Tcond, x: 0 });
    const s4 = state(sub, { p: evap.p, h: s3.h });
    const qL = s1.h - s4.h, qH = s2.h - s3.h, w = s2.h - s1.h;
    const hp = o.mode === 'heatpump';
    const procs = [
      { from: '1', to: '2', kind: 'compress', label: 'Compressor', w: -w, q: 0, path: ec < 1 ? seg(s1, s2) : pathS(sub, s1, s2), ideal: s2s },
      { from: '2', to: '3', kind: 'reject', label: 'Condenser', q: -qH, w: 0, path: pathP(sub, cond.p, s2, s3) },
      { from: '3', to: '4', kind: 'throttle', label: 'Expansion valve', q: 0, w: 0, path: seg(s3, s4) },
      { from: '4', to: '1', kind: 'heat', label: 'Evaporator', q: qL, w: 0, path: pathP(sub, evap.p, s4, s1) },
    ];
    return finish({ sub, kind: hp ? 'heatpump' : 'refrigeration', states: [S('1', s1), S('2', s2), S('3', s3), S('4', s4)], procs,
      qIn: qL, qOut: qH, wNet: -w, extra: { w, qL, qH, pEvap: evap.p, pCond: cond.p, Tcond: cond.T } }, o);
  }
  // Common tail: performance, mass flow for a target power/capacity, Carnot comparisons.
  function finish(c, o) {
    const T = c.states.map(s => s.T);
    const Tmax = Math.max(...T), Tmin = Math.min(...T);
    if (c.kind === 'power') {
      c.eta = c.wNet / c.qIn;
      c.carnotCycle = 1 - Tmin / Tmax;
      c.mdot = o.Wnet > 0 ? o.Wnet / c.wNet : null;
    } else {
      const w = -c.wNet;
      c.cop = c.kind === 'refrigeration' ? c.qIn / w : c.qOut / w;
      c.carnotCycle = c.kind === 'refrigeration' ? Tmin / (Tmax - Tmin) : Tmax / (Tmax - Tmin);
      const cap = o.capacity > 0 ? o.capacity : null;
      c.mdot = cap ? cap / (c.kind === 'refrigeration' ? c.qIn : c.qOut) : null;
    }
    if (o.mdot > 0 && !c.mdot) c.mdot = o.mdot;
    // Heat exchange with the reservoirs (second law, Moran ch. 5/6).
    if (o.TH > 0 && o.TL > 0) {
      const qFromHot = c.kind === 'power' ? c.qIn : c.qOut;   // magnitudes
      const qToCold = c.kind === 'power' ? c.qOut : c.qIn;
      c.res = {
        TH: o.TH, TL: o.TL,
        sigma: c.kind === 'power' ? c.qOut / o.TL - c.qIn / o.TH : c.qOut / o.TH - c.qIn / o.TL,
        perfMax: c.kind === 'power' ? 1 - o.TL / o.TH : c.kind === 'refrigeration' ? o.TL / (o.TH - o.TL) : o.TH / (o.TH - o.TL),
        qFromHot, qToCold,
        warn: [],
      };
      if (c.kind === 'power') {
        if (o.TH < Tmax - 1e-6) c.res.warn.push("The hot reservoir is cooler than the cycle's peak temperature — heat could not flow from it to the working fluid there.");
        if (o.TL > Tmin + 1e-6) c.res.warn.push("The cold reservoir is warmer than the cycle's lowest temperature — heat could not be rejected to it there.");
      } else {
        const Tev = c.states.find(s => s.label === '4').T, Tcd = c.extra.Tcond;
        if (o.TL < Tev - 1e-6) c.res.warn.push('The cold region is colder than the evaporating refrigerant — heat could not flow into it.');
        if (o.TH > Tcd + 1e-6) c.res.warn.push('The warm region is hotter than the condensing refrigerant — heat could not be rejected to it.');
      }
    }
    return c;
  }

  return {
    SUBSTANCES, state, sat, dome, fromTP, isGas, gasR,
    reservoirCycle, device, rankine, brayton, otto, diesel, vaporCompression,
    pathP, pathS, pathV,
    _water: { w1, w2, wPsat, wTsat }, _r134a: { rfSatT, rfProps }, _air: { airHS },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ThermoEngine;
