// Thermo Lab utility — ME 20000 (Purdue Thermodynamics I) companion: reservoirs & cycle limits,
// power / refrigeration cycles, steady-flow devices and property tables.
//
// All the thermodynamics lives in thermo-engine.js (global ThermoEngine, SI: K, kPa, kJ/kg).
// This module is the UI: four tabs, each a form on the left and live results on the right.
//   Reservoirs  heat engine / refrigerator / heat pump between T_H and T_C: energy balance,
//               η or COP vs the Carnot maximum, σ_cycle and the Kelvin–Planck / Clausius verdict,
//               a heat-flow diagram and the max-performance-vs-T_H curve.
//   Cycles      Rankine (+ reheat), Brayton (+ regeneration), Otto, Diesel, vapor-compression
//               refrigeration / heat pump — state table, process q/w table, η or COP, back-work
//               ratio, mass flow for a target power/capacity, σ with reservoirs, T-s (and p-v)
//               diagram with the saturation dome and the reservoir temperatures drawn in.
//   Devices     turbine / compressor / pump / nozzle / diffuser / throttle / heat exchanger with
//               isentropic efficiency, entropy generation and exergy destroyed.
//   Properties  any two independent properties → full state, and saturation / single-phase tables.
// Form values are kept in SI and shown in the chosen units (T: °C/K, p: kPa/bar/MPa). Inputs
// and the active tab persist in localStorage `engorg_thermolab`. Desktop-only utility.

const thermoLab = (() => {
  const E = ThermoEngine;
  const LS_KEY = 'engorg_thermolab';
  const P_UNITS = { kPa: 1, bar: 100, MPa: 1000 };
  const TON = 3.5168525;   // kW per ton of refrigeration

  let mounted = false, root = null;
  let prefs = null;
  let computeTimer = null;
  let lastTable = null;    // { head, rows } for CSV export on the Properties tab

  const DEFAULTS = {
    tab: 'reservoirs',
    units: { T: 'C', p: 'kPa' },
    reservoirs: { mode: 'power', TH: 500, TL: 300, basis: 'kJ', QH: 1000, QL: null, W: 450, perf: null },
    cycles: {
      type: 'rankine',
      rankine: { pBoiler: 8000, inlet: 'super', T1: 753.15, pCond: 8, etaT: 0.85, etaP: 0.85, reheat: 'no', pReheat: 700, TReheat: 713.15, Wnet: 100000, TH: 1000, TL: 288.15 },
      brayton: { T1: 300, p1: 100, rp: 10, T3: 1400, etaC: 1, etaT: 1, regen: 0, model: 'variable', Wnet: 10000, TH: 1600, TL: 300 },
      otto: { T1: 300, p1: 100, r: 8, heatBy: 'T3', T3: 2000, qIn: 1400, model: 'variable', TH: 2200, TL: 300 },
      diesel: { T1: 300, p1: 100, r: 18, rc: 2, model: 'variable', TH: 2000, TL: 300 },
      refrig: { Tevap: 263.15, Tcond: 308.15, superheat: 0, subcool: 0, etaC: 1, capacity: 10, capUnit: 'ton', TH: 299.15, TL: 273.15 },
      heatpump: { Tevap: 263.15, Tcond: 318.15, superheat: 0, subcool: 0, etaC: 0.8, capacity: 15, capUnit: 'kW', TH: 293.15, TL: 268.15 },
      view: 'Ts',
    },
    devices: { device: 'turbine', sub: 'water', pair: 'Tp', a: 673.15, b: 3000, p2: 10, mode: 'eta', eta: 0.85, T2: 400, h2: 2400, x2: 0.9, mdot: 1, V1: 0, V2: 0, Qdot: 0, Tb: 298.15, T0: 298.15 },
    props: { sub: 'water', pair: 'Tp', a: 573.15, b: 1000, tableKind: 'satT', from: 273.16, to: 373.15, step: 10, tableP: 1000 },
  };

  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_) { p = {}; }
    const merge = (d, v) => (v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object') ? Object.fromEntries(Object.keys({ ...d, ...v }).map(k => [k, merge(d[k], v[k])])) : (v === undefined ? d : v);
    return merge(JSON.parse(JSON.stringify(DEFAULTS)), p);
  }
  function savePrefs() { try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (_) { /* storage blocked */ } }

  // ---- units / formatting -----------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const Tu = () => (prefs.units.T === 'K' ? 'K' : '°C');
  const pu = () => prefs.units.p;
  const Tdisp = (K) => (prefs.units.T === 'K' ? K : K - 273.15);
  const Tsi = (v) => (prefs.units.T === 'K' ? v : v + 273.15);
  const pdisp = (kPa) => kPa / P_UNITS[pu()];
  const psi = (v) => v * P_UNITS[pu()];
  // Textbook subscripts: "T_H" → T<sub>H</sub> in HTML and a lowered <tspan> inside SVG.
  function subify(html) {
    return html.split(/(<svg[\s\S]*?<\/svg>)/).map(part => (part.startsWith('<svg')
      ? part.replace(/_([A-Za-z0-9]+)/g, '<tspan baseline-shift="sub" font-size="72%">$1</tspan>')
      : part.replace(/_([A-Za-z0-9]+)/g, '<sub>$1</sub>'))).join('');
  }
  const trim = (n, sig = 6) => (n == null || !isFinite(n) ? '' : String(+(+n).toPrecision(sig)));
  const fx = (n, d) => (n == null || !isFinite(n) ? '—' : (+n).toFixed(d));
  const fT = (K) => fx(Tdisp(K), 2);
  const fp = (kPa) => { const v = pdisp(kPa); return v == null || !isFinite(v) ? '—' : +v.toPrecision(5) + ''; };
  const fv = (v) => (v == null || !isFinite(v) ? '—' : v < 0.01 ? v.toExponential(4) : (+v.toPrecision(5)).toString());
  const fh = (h) => fx(h, 2);
  const fs = (s) => fx(s, 4);
  const fpct = (f) => (f == null || !isFinite(f) ? '—' : (f * 100).toFixed(1) + '%');
  const fpow = (kW) => (kW == null || !isFinite(kW) ? '—' : Math.abs(kW) >= 1e4 ? (kW / 1000).toFixed(2) + ' MW' : kW.toFixed(Math.abs(kW) < 10 ? 3 : 1) + ' kW');

  // ---- form field specs ---------------------------------------------------------------------
  // type: T (absolute temperature), dT (difference), p, pct (stored as fraction), num, sel.
  const F = (key, label, type, o = {}) => ({ key, label, type, ...o });
  const toDisplay = (f, v) => {
    if (v == null || v === '') return '';
    if (f.type === 'T') return trim(Tdisp(v));
    if (f.type === 'p') return trim(pdisp(v));
    if (f.type === 'pct') return trim(v * 100);
    if (f.type === 'kWMW') return trim(v / 1000);
    return trim(v);
  };
  const toSI = (f, s) => {
    const t = String(s).trim();
    if (t === '') return null;
    const n = parseFloat(t.replace(/,/g, ''));
    if (!isFinite(n)) return undefined;
    if (f.type === 'T') return Tsi(n);
    if (f.type === 'p') return psi(n);
    if (f.type === 'pct') return n / 100;
    if (f.type === 'kWMW') return n * 1000;
    return n;
  };
  const unitOf = (f) => (f.type === 'T' ? Tu() : f.type === 'dT' ? (prefs.units.T === 'K' ? 'K' : '°C') : f.type === 'p' ? pu() : f.type === 'pct' ? '%' : f.type === 'kWMW' ? 'MW' : (f.unit || ''));
  function fieldHtml(f, v) {
    if (f.type === 'sel') {
      return `<label class="clab-field"><span>${f.label}</span><select class="kicad-input" data-k="${f.key}">${f.options.map(([val, lab]) => `<option value="${esc(val)}"${String(v) === String(val) ? ' selected' : ''}>${esc(lab)}</option>`).join('')}</select>${f.hint ? `<em>${f.hint}</em>` : ''}</label>`;
    }
    const u = unitOf(f);
    return `<label class="clab-field"><span>${f.label}</span><div class="tl-inp"><input class="kicad-input" data-k="${f.key}" value="${esc(toDisplay(f, v))}" placeholder="${esc(f.ph || '')}" spellcheck="false"${f.disabled ? ' disabled' : ''}>${u ? `<b>${esc(u)}</b>` : ''}</div>${f.hint ? `<em>${f.hint}</em>` : ''}</label>`;
  }
  const group = (title, html) => `<div class="tl-group"><div class="tl-group-title">${title}</div>${html}</div>`;

  // Property pairs offered for a substance (values a, b follow the pair order).
  const PROP = {
    T: F('a', 'Temperature T', 'T'), p: F('a', 'Pressure p', 'p'), x: F('a', 'Quality x', 'num', { unit: '0–1' }),
    v: F('a', 'Specific volume v', 'num', { unit: 'm³/kg' }), u: F('a', 'Internal energy u', 'num', { unit: 'kJ/kg' }),
    h: F('a', 'Enthalpy h', 'num', { unit: 'kJ/kg' }), s: F('a', 'Entropy s', 'num', { unit: 'kJ/kg·K' }),
  };
  const FLUID_PAIRS = ['Tp', 'Tx', 'px', 'ph', 'ps', 'pv', 'Tv', 'Ts', 'Th', 'pu'];
  const GAS_PAIRS = ['Tp', 'ph', 'ps', 'pv', 'Tv', 'Ts'];
  const pairsFor = (sub) => (E.isGas(sub) ? GAS_PAIRS : FLUID_PAIRS);
  const pairLabel = (k) => k.split('').join(', ');
  const pairFields = (pair) => [{ ...PROP[pair[0]], key: 'a' }, { ...PROP[pair[1]], key: 'b' }];
  const pairQuery = (pair, a, b) => ({ [pair[0]]: a, [pair[1]]: b });
  const SUB_OPTS = Object.entries(E.SUBSTANCES).map(([k, s]) => [k, s.name]);

  // =========================================================================================
  // RESERVOIRS
  // =========================================================================================
  const RES_EXAMPLES = {
    "Inventor's claim: 45% engine, 500 K → 300 K": { mode: 'power', TH: 500, TL: 300, basis: 'kJ', QH: 1000, QL: null, W: 450, perf: null },
    'Power plant: 30% at 1000 K / 300 K, 500 MW': { mode: 'power', TH: 1000, TL: 300, basis: 'kW', QH: null, QL: null, W: 500000, perf: 0.3 },
    'Refrigerator: β = 4, 3 °C food / 25 °C kitchen': { mode: 'refrigeration', TH: 298.15, TL: 276.15, basis: 'kW', QH: null, QL: 0.3, W: null, perf: 4 },
    'Heat pump claim: γ = 15 between 0 °C and 20 °C': { mode: 'heatpump', TH: 293.15, TL: 273.15, basis: 'kW', QH: 10, QL: null, W: null, perf: 15 },
    'Reversible engine: find Q_C for 100 kW out': { mode: 'power', TH: 800, TL: 300, basis: 'kW', QH: null, QL: null, W: 100, perf: 0.625 },
  };
  function resFields() {
    const r = prefs.reservoirs;
    const perfLabel = r.mode === 'power' ? 'Thermal efficiency η' : r.mode === 'refrigeration' ? 'Coefficient of performance β' : 'Coefficient of performance γ';
    const qu = r.basis === 'kW' ? 'kW' : 'kJ';
    return group('Cycle', [
      F('mode', 'Type', 'sel', { options: [['power', 'Power cycle (heat engine)'], ['refrigeration', 'Refrigeration cycle'], ['heatpump', 'Heat pump cycle']] }),
      F('basis', 'Basis', 'sel', { options: [['kJ', 'Per cycle — energy (kJ)'], ['kW', 'Rate — power (kW)']] }),
    ].map(f => fieldHtml(f, r[f.key])).join(''))
      + group('Reservoirs', [F('TH', 'Hot reservoir T_H', 'T'), F('TL', 'Cold reservoir T_C', 'T')].map(f => fieldHtml(f, r[f.key])).join(''))
      + group('Known quantities <span>enter any two</span>', [
        F('QH', r.mode === 'power' ? 'Heat in from hot, Q_H' : 'Heat out to hot, Q_H', 'num', { unit: qu, ph: 'unknown' }),
        F('QL', r.mode === 'power' ? 'Heat out to cold, Q_C' : 'Heat in from cold, Q_C', 'num', { unit: qu, ph: 'unknown' }),
        F('W', r.mode === 'power' ? 'Net work out, W_cycle' : 'Net work in, W_cycle', 'num', { unit: qu, ph: 'unknown' }),
        F('perf', perfLabel, r.mode === 'power' ? 'pct' : 'num', { ph: 'unknown' }),
      ].map(f => fieldHtml(f, r[f.key])).join(''))
      + `<label class="clab-field"><span>Examples</span><select class="kicad-input" data-example="res"><option value="">Load an example…</option>${Object.keys(RES_EXAMPLES).map((k, i) => `<option value="${i}">${esc(k)}</option>`).join('')}</select></label>`;
  }

  function resCompute() {
    const r = prefs.reservoirs;
    const qu = r.basis === 'kW' ? 'kW' : 'kJ', su = r.basis === 'kW' ? 'kW/K' : 'kJ/K';
    let R;
    try { R = E.reservoirCycle(r.mode, r.TH, r.TL, { QH: r.QH, QL: r.QL, W: r.W, perf: r.perf }); } catch (e) {
      return `<div class="tl-card">${resDiagram(r, null)}</div><div class="clab-err">${esc(e.message)}</div>`;
    }
    const pName = r.mode === 'power' ? 'η' : r.mode === 'refrigeration' ? 'β' : 'γ';
    const perfStr = (v) => (r.mode === 'power' ? fpct(v) : fx(v, 3));
    const formula = r.mode === 'power'
      ? `η = W_cycle / Q_H = 1 − Q_C / Q_H &nbsp;·&nbsp; η_max = 1 − T_C / T_H &nbsp;·&nbsp; σ_cycle = Q_C / T_C − Q_H / T_H`
      : r.mode === 'refrigeration'
        ? `β = Q_C / W_cycle = Q_C / (Q_H − Q_C) &nbsp;·&nbsp; β_max = T_C / (T_H − T_C) &nbsp;·&nbsp; σ_cycle = Q_H / T_H − Q_C / T_C`
        : `γ = Q_H / W_cycle = Q_H / (Q_H − Q_C) &nbsp;·&nbsp; γ_max = T_H / (T_H − T_C) &nbsp;·&nbsp; σ_cycle = Q_H / T_H − Q_C / T_C`;
    return `<div class="tl-card tl-split">${resDiagram(r, R)}${resCurve(r, R)}</div>
      <div class="tl-verdict tl-v-${R.verdict.kind}">${esc(R.verdict.text)}</div>
      ${R.warnings.map(w => `<div class="clab-warn">⚠ ${esc(w)}</div>`).join('')}
      <div class="tl-cards">
        <div><span>Q_H</span><b>${fx(R.QH, 3)} ${qu}</b></div><div><span>Q_C</span><b>${fx(R.QL, 3)} ${qu}</b></div>
        <div><span>W_cycle</span><b>${fx(R.W, 3)} ${qu}</b></div>
        <div><span>${pName} actual</span><b>${perfStr(R.perf)}</b></div><div><span>${pName}_max (Carnot)</span><b>${perfStr(R.perfMax)}</b></div>
        <div><span>${pName} / ${pName}_max</span><b>${fpct(R.ratio)}</b></div>
        <div><span>σ_cycle</span><b>${(+R.sigma.toPrecision(4))} ${su}</b></div><div><span>∮(δQ/T)_b</span><b>${(+R.clausius.toPrecision(4))} ${su}</b></div>
        <div><span>T_C / T_H</span><b>${fx(r.TL / r.TH, 4)}</b></div>
      </div>
      <div class="clab-note tl-formula">${formula}<br>Temperatures in kelvin: T_H = ${fx(r.TH, 2)} K, T_C = ${fx(r.TL, 2)} K. σ_cycle &gt; 0 irreversible · = 0 reversible · &lt; 0 impossible (Clausius inequality, ∮(δQ/T)_b = −σ_cycle).</div>`;
  }
  function resDiagram(r, R) {
    const power = r.mode === 'power';
    const QH = R ? R.QH : null, QL = R ? R.QL : null, W = R ? R.W : null;
    const max = Math.max(1e-12, Math.abs(QH || 0), Math.abs(QL || 0), Math.abs(W || 0));
    const sw = (q) => (q == null || !isFinite(q) ? 3 : 3 + 16 * Math.abs(q) / max);
    const qu = r.basis === 'kW' ? 'kW' : 'kJ';
    const val = (q) => (q == null || !isFinite(q) ? '?' : (+q.toPrecision(4)) + ' ' + qu);
    const arrow = (x1, y1, x2, y2, w, cls) => {
      const ang = Math.atan2(y2 - y1, x2 - x1), hl = 10 + w * 0.6;
      const bx = x2 - Math.cos(ang) * hl, by = y2 - Math.sin(ang) * hl;
      const px = Math.cos(ang + Math.PI / 2) * (w / 2 + 6), py = Math.sin(ang + Math.PI / 2) * (w / 2 + 6);
      return `<line class="tl-arrow ${cls}" x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke-width="${w}"/><path class="tl-arrowhead ${cls}" d="M${x2} ${y2}L${bx + px} ${by + py}L${bx - px} ${by - py}Z"/>`;
    };
    const name = power ? 'Power cycle' : r.mode === 'refrigeration' ? 'Refrigerator' : 'Heat pump';
    const cx = 210, cy = 170;
    const qh = power ? arrow(cx, 66, cx, cy - 46, sw(QH), 'hot') : arrow(cx, cy - 46, cx, 66, sw(QH), 'hot');
    const qc = power ? arrow(cx, cy + 46, cx, 274, sw(QL), 'cold') : arrow(cx, 274, cx, cy + 46, sw(QL), 'cold');
    const w = power ? arrow(cx + 46, cy, 370, cy, sw(W), 'work') : arrow(370, cy, cx + 46, cy, sw(W), 'work');
    return `<svg class="tl-res-svg" viewBox="0 0 420 340" xmlns="http://www.w3.org/2000/svg">
      <rect class="tl-res-hot" x="40" y="12" width="340" height="54" rx="10"/><text class="tl-res-title" x="210" y="36" text-anchor="middle">Hot reservoir</text><text class="tl-res-sub" x="210" y="55" text-anchor="middle">T_H = ${fT(r.TH)} ${Tu()}</text>
      <rect class="tl-res-cold" x="40" y="274" width="340" height="54" rx="10"/><text class="tl-res-title" x="210" y="298" text-anchor="middle">Cold reservoir</text><text class="tl-res-sub" x="210" y="317" text-anchor="middle">T_C = ${fT(r.TL)} ${Tu()}</text>
      ${qh}${qc}${w}
      <circle class="tl-res-dev" cx="${cx}" cy="${cy}" r="46"/><text class="tl-res-dev-t" x="${cx}" y="${cy + 4}" text-anchor="middle">${name}</text>
      <text class="tl-res-lbl" x="${cx + 18}" y="${(66 + cy - 46) / 2 + 4}">Q_H = ${val(QH)}</text>
      <text class="tl-res-lbl" x="${cx + 18}" y="${(cy + 46 + 274) / 2 + 4}">Q_C = ${val(QL)}</text>
      <text class="tl-res-lbl" x="${(cx + 46 + 370) / 2}" y="${cy - 16}" text-anchor="middle">W = ${val(W)}</text>
    </svg>`;
  }
  // Max performance vs T_H at fixed T_C (Moran's η_max curve), with the cycle's point.
  function resCurve(r, R) {
    const TL = r.TL, TH = r.TH;
    if (!(TL > 0 && TH > TL)) return '';
    const hi = Math.max(TH * 1.4, TL * 3);
    const pts = [];
    const f = (t) => (r.mode === 'power' ? 1 - TL / t : r.mode === 'refrigeration' ? TL / (t - TL) : t / (t - TL));
    const lo = r.mode === 'power' ? TL : TL + (hi - TL) * 0.02;
    for (let i = 0; i <= 80; i++) { const t = lo + (hi - lo) * i / 80; pts.push([t, f(t)]); }
    let yMax = r.mode === 'power' ? 1 : Math.min(Math.max(...pts.map(p => p[1])), Math.max(f(TH) * 3, R && isFinite(R.perf) ? R.perf * 1.6 : 0, 5));
    const W = 300, H = 200, L = 46, B = 34, T = 14, Rm = 10;
    const X = (t) => L + (t - lo) / (hi - lo) * (W - L - Rm), Y = (v) => H - B - Math.min(v, yMax) / yMax * (H - B - T);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join('');
    const name = r.mode === 'power' ? 'η_max' : r.mode === 'refrigeration' ? 'β_max' : 'γ_max';
    let marks = '';
    if (R && isFinite(R.perf)) {
      marks += `<circle class="tl-curve-pt ${R.verdict.kind}" cx="${X(TH)}" cy="${Y(R.perf)}" r="4.5"/><circle class="tl-curve-max" cx="${X(TH)}" cy="${Y(f(TH))}" r="3.5"/>`;
      marks += `<line class="tl-curve-guide" x1="${X(TH)}" y1="${T}" x2="${X(TH)}" y2="${H - B}"/>`;
    }
    const ticksY = [0, 0.25, 0.5, 0.75, 1].map(k => k * yMax);
    return `<svg class="tl-curve" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${ticksY.map(v => `<line class="tl-grid" x1="${L}" y1="${Y(v)}" x2="${W - Rm}" y2="${Y(v)}"/><text class="tl-tick" x="${L - 5}" y="${Y(v) + 3}" text-anchor="end">${r.mode === 'power' ? Math.round(v * 100) + '%' : +v.toPrecision(2)}</text>`).join('')}
      <path class="tl-curve-line" d="${path}"/>${marks}
      <text class="tl-tick" x="${L}" y="${H - B + 14}">${fT(lo)}</text><text class="tl-tick" x="${W - Rm}" y="${H - B + 14}" text-anchor="end">${fT(hi)} ${Tu()}</text>
      <text class="tl-axis" x="${(L + W) / 2}" y="${H - 4}" text-anchor="middle">T_H (T_C fixed)</text>
      <text class="tl-axis" x="12" y="${T + 4}">${name}</text>
    </svg>`;
  }

  // =========================================================================================
  // CYCLES
  // =========================================================================================
  const CYCLES = {
    rankine: { name: 'Rankine — vapor power (water)', fields: (c) => [
      group('Boiler & turbine', [F('pBoiler', 'Boiler pressure', 'p'), F('inlet', 'Turbine inlet', 'sel', { options: [['sat', 'Saturated vapor'], ['super', 'Superheated vapor']] }),
        ...(c.inlet === 'super' ? [F('T1', 'Turbine inlet temperature T₁', 'T')] : []), F('etaT', 'Turbine isentropic efficiency', 'pct')].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Reheat', [F('reheat', 'Reheat', 'sel', { options: [['no', 'None'], ['yes', 'One reheat stage']] }),
        ...(c.reheat === 'yes' ? [F('pReheat', 'Reheat pressure', 'p'), F('TReheat', 'Reheat temperature', 'T')] : [])].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Condenser & pump', [F('pCond', 'Condenser pressure', 'p'), F('etaP', 'Pump isentropic efficiency', 'pct')].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Size', fieldHtml(F('Wnet', 'Net power output', 'kWMW', { ph: 'per kg only' }), c.Wnet)),
    ], run: (c) => E.rankine({ pBoiler: c.pBoiler, pCond: c.pCond, T1: c.inlet === 'super' ? c.T1 : null, etaT: c.etaT, etaP: c.etaP, reheat: c.reheat === 'yes', pReheat: c.pReheat, TReheat: c.TReheat, Wnet: c.Wnet, TH: c.TH, TL: c.TL }) },
    brayton: { name: 'Brayton — gas turbine (air)', fields: (c) => [
      group('Compressor', [F('T1', 'Inlet temperature T₁', 'T'), F('p1', 'Inlet pressure p₁', 'p'), F('rp', 'Pressure ratio p₂/p₁', 'num'), F('etaC', 'Compressor isentropic efficiency', 'pct')].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Turbine', [F('T3', 'Turbine inlet temperature T₃', 'T'), F('etaT', 'Turbine isentropic efficiency', 'pct'), F('regen', 'Regenerator effectiveness', 'pct', { hint: '0 = no regenerator' })].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Model & size', [F('model', 'Air model', 'sel', { options: [['variable', 'Air-standard, variable specific heats'], ['cold', 'Cold air-standard (k = 1.4)']] }), F('Wnet', 'Net power output', 'kWMW', { ph: 'per kg only' })].map(f => fieldHtml(f, c[f.key])).join('')),
    ], run: (c) => E.brayton({ T1: c.T1, p1: c.p1, rp: c.rp, T3: c.T3, etaC: c.etaC, etaT: c.etaT, regen: c.regen, cold: c.model === 'cold', Wnet: c.Wnet, TH: c.TH, TL: c.TL }) },
    otto: { name: 'Otto — spark ignition (air)', fields: (c) => [
      group('Start of compression', [F('T1', 'T₁', 'T'), F('p1', 'p₁', 'p'), F('r', 'Compression ratio r = V₁/V₂', 'num')].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Heat addition', [F('heatBy', 'Specify', 'sel', { options: [['T3', 'Peak temperature T₃'], ['qIn', 'Heat added per kg']] }),
        c.heatBy === 'qIn' ? F('qIn', 'Heat added q₂₃', 'num', { unit: 'kJ/kg' }) : F('T3', 'Peak temperature T₃', 'T')].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Model', fieldHtml(F('model', 'Air model', 'sel', { options: [['variable', 'Air-standard, variable specific heats'], ['cold', 'Cold air-standard (k = 1.4)']] }), c.model)),
    ], run: (c) => E.otto({ T1: c.T1, p1: c.p1, r: c.r, T3: c.heatBy === 'T3' ? c.T3 : null, qIn: c.heatBy === 'qIn' ? c.qIn : null, cold: c.model === 'cold', TH: c.TH, TL: c.TL }) },
    diesel: { name: 'Diesel — compression ignition (air)', fields: (c) => [
      group('Start of compression', [F('T1', 'T₁', 'T'), F('p1', 'p₁', 'p'), F('r', 'Compression ratio r = V₁/V₂', 'num')].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Combustion', fieldHtml(F('rc', 'Cutoff ratio r_c = V₃/V₂', 'num'), c.rc)),
      group('Model', fieldHtml(F('model', 'Air model', 'sel', { options: [['variable', 'Air-standard, variable specific heats'], ['cold', 'Cold air-standard (k = 1.4)']] }), c.model)),
    ], run: (c) => E.diesel({ T1: c.T1, p1: c.p1, r: c.r, rc: c.rc, cold: c.model === 'cold', TH: c.TH, TL: c.TL }) },
    refrig: { name: 'Vapor-compression refrigeration (R-134a)', fields: (c) => vcFields(c), run: (c) => vcRun(c, 'refrigeration') },
    heatpump: { name: 'Vapor-compression heat pump (R-134a)', fields: (c) => vcFields(c), run: (c) => vcRun(c, 'heatpump') },
  };
  function vcFields(c) {
    return [
      group('Evaporator', [F('Tevap', 'Evaporator saturation temperature', 'T'), F('superheat', 'Superheat at compressor inlet', 'dT')].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Condenser', [F('Tcond', 'Condenser saturation temperature', 'T'), F('subcool', 'Subcooling at condenser exit', 'dT')].map(f => fieldHtml(f, c[f.key])).join('')),
      group('Compressor & size', [F('etaC', 'Compressor isentropic efficiency', 'pct'), F('capacity', prefs.cycles.type === 'heatpump' ? 'Heating capacity' : 'Refrigerating capacity', 'num', { ph: 'per kg only' }),
        F('capUnit', 'Capacity unit', 'sel', { options: [['kW', 'kW'], ['ton', 'tons of refrigeration']] })].map(f => fieldHtml(f, c[f.key])).join('')),
    ];
  }
  function vcRun(c, mode) {
    return E.vaporCompression({ Tevap: c.Tevap, Tcond: c.Tcond, superheat: c.superheat, subcool: c.subcool, etaC: c.etaC, capacity: c.capacity > 0 ? c.capacity * (c.capUnit === 'ton' ? TON : 1) : null, mode, TH: c.TH, TL: c.TL });
  }
  const CYCLE_EXAMPLES = {
    'Rankine — Ex. 8.1 ideal, 8 MPa sat. vapor, 0.008 MPa, 100 MW': ['rankine', { pBoiler: 8000, inlet: 'sat', pCond: 8, etaT: 1, etaP: 1, reheat: 'no', Wnet: 100000 }],
    'Rankine — Ex. 8.2 same with 85% turbine & pump': ['rankine', { pBoiler: 8000, inlet: 'sat', pCond: 8, etaT: 0.85, etaP: 0.85, reheat: 'no', Wnet: 100000 }],
    'Rankine — Ex. 8.3 reheat 8 MPa/480 °C → 0.7 MPa/440 °C': ['rankine', { pBoiler: 8000, inlet: 'super', T1: 753.15, pCond: 8, etaT: 1, etaP: 1, reheat: 'yes', pReheat: 700, TReheat: 713.15, Wnet: 100000 }],
    'Brayton — Ex. 9.4 ideal, r = 10, 300 K / 1400 K': ['brayton', { T1: 300, p1: 100, rp: 10, T3: 1400, etaC: 1, etaT: 1, regen: 0, model: 'variable' }],
    'Brayton — Ex. 9.5 with 80% compressor & turbine': ['brayton', { T1: 300, p1: 100, rp: 10, T3: 1400, etaC: 0.8, etaT: 0.8, regen: 0, model: 'variable' }],
    'Brayton — regenerative, ε = 80%': ['brayton', { T1: 300, p1: 100, rp: 10, T3: 1400, etaC: 1, etaT: 1, regen: 0.8, model: 'variable' }],
    'Otto — Ex. 9.1 r = 8, T₃ = 2000 K': ['otto', { T1: 300, p1: 100, r: 8, heatBy: 'T3', T3: 2000, model: 'variable' }],
    'Diesel — Ex. 9.2 r = 18, r_c = 2': ['diesel', { T1: 300, p1: 100, r: 18, rc: 2, model: 'variable' }],
    'Refrigeration — Ex. 10.1 −10 °C evap., 9 bar cond., 10 tons': ['refrig', { Tevap: 263.15, Tcond: 308.66, superheat: 0, subcool: 0, etaC: 1, capacity: 10, capUnit: 'ton' }],
    'Refrigeration — 80% compressor, 5 °C superheat': ['refrig', { Tevap: 263.15, Tcond: 308.66, superheat: 5, subcool: 3, etaC: 0.8, capacity: 10, capUnit: 'ton' }],
    'Heat pump — house at 20 °C, outdoors −5 °C': ['heatpump', { Tevap: 263.15, Tcond: 318.15, superheat: 0, subcool: 0, etaC: 0.8, capacity: 15, capUnit: 'kW', TH: 293.15, TL: 268.15 }],
  };
  function cycFields() {
    const cy = prefs.cycles, c = cy[cy.type];
    const resLabels = cy.type === 'refrig' ? ['Warm surroundings T_H', 'Cold region T_C'] : cy.type === 'heatpump' ? ['Heated space T_H', 'Outdoors / source T_C'] : ['Hot reservoir T_H', 'Cold reservoir T_C'];
    return `<label class="clab-field"><span>Cycle</span><select class="kicad-input" data-k="type" data-scope="cycles">${Object.entries(CYCLES).map(([k, d]) => `<option value="${k}"${cy.type === k ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>`
      + CYCLES[cy.type].fields(c).join('')
      + group('Reservoirs <span>optional — for σ and the Carnot limit</span>', [F('TH', resLabels[0], 'T', { ph: 'none' }), F('TL', resLabels[1], 'T', { ph: 'none' })].map(f => fieldHtml(f, c[f.key])).join(''))
      + `<label class="clab-field"><span>Examples (Moran &amp; Shapiro)</span><select class="kicad-input" data-example="cyc"><option value="">Load an example…</option>${Object.keys(CYCLE_EXAMPLES).map((k, i) => `<option value="${i}">${esc(k)}</option>`).join('')}</select></label>`;
  }

  // Field type lookup for the current cycle form (parsing needs the type).
  function cycFieldType(key) {
    const types = {
      pBoiler: 'p', pCond: 'p', pReheat: 'p', p1: 'p', T1: 'T', T3: 'T', TReheat: 'T', Tevap: 'T', Tcond: 'T', TH: 'T', TL: 'T',
      etaT: 'pct', etaP: 'pct', etaC: 'pct', regen: 'pct', Wnet: 'kWMW', superheat: 'dT', subcool: 'dT',
      inlet: 'sel', reheat: 'sel', model: 'sel', heatBy: 'sel', capUnit: 'sel', type: 'sel',
    };
    return types[key] || 'num';
  }
  function cycCompute() {
    const cy = prefs.cycles, c = cy[cy.type];
    let C;
    try { C = CYCLES[cy.type].run(c); } catch (e) { return `<div class="clab-err">${esc(e.message)}</div>`; }
    const power = C.kind === 'power';
    const closed = !!C.closed;
    const gas = E.isGas(C.sub);
    const view = (closed || gas) ? cy.view : 'Ts';
    const unitE = closed ? 'kJ/kg' : 'kJ/kg';
    let out = `<div class="tl-card">
      <div class="tl-card-head"><b>${esc(CYCLES[cy.type].name)}</b>${gas ? `<div class="tl-seg">${['Ts', 'pv'].map(v => `<button data-view="${v}" class="${view === v ? 'active' : ''}">${v === 'Ts' ? 'T-s' : 'p-v'}</button>`).join('')}</div>` : ''}</div>
      ${view === 'pv' ? pvDiagram(C) : tsDiagram({ sub: C.sub, states: C.states, procs: C.procs, TH: c.TH, TL: c.TL })}</div>`;
    // Headline figures
    const cards = [];
    if (power) {
      cards.push(['Thermal efficiency η', fpct(C.eta)], ['Carnot η (cycle T extremes)', fpct(C.carnotCycle)]);
      if (C.res) cards.push(['η_max between reservoirs', fpct(C.res.perfMax)], ['η / η_max', fpct(C.eta / C.res.perfMax)]);
      cards.push(['Net work w_cycle', fh(C.wNet) + ' ' + unitE], ['Heat in q_in', fh(C.qIn) + ' ' + unitE], ['Heat out q_out', fh(C.qOut) + ' ' + unitE]);
      if (C.extra.bwr != null) cards.push(['Back work ratio', fpct(C.extra.bwr)]);
      if (C.extra.mep != null) cards.push(['Mean effective pressure', fp(C.extra.mep) + ' ' + pu()]);
      if (C.extra.x2 != null) cards.push(['Turbine exit quality', fx(C.extra.x2, 4)]);
      if (C.mdot) cards.push(['Mass flow ṁ', fx(C.mdot, 3) + ' kg/s'], ['', fx(C.mdot * 3600, 0) + ' kg/h'], ['Q̇_in', fpow(C.mdot * C.qIn)], ['Q̇_out', fpow(C.mdot * C.qOut)]);
    } else {
      const hp = C.kind === 'heatpump';
      cards.push([hp ? 'Coefficient of performance γ' : 'Coefficient of performance β', fx(C.cop, 3)], ['Carnot (cycle T extremes)', fx(C.carnotCycle, 3)]);
      if (C.res) cards.push([hp ? 'γ_max between regions' : 'β_max between regions', fx(C.res.perfMax, 3)], [hp ? 'γ / γ_max' : 'β / β_max', fpct(C.cop / C.res.perfMax)]);
      cards.push(['Refrigeration effect q_in', fh(C.extra.qL) + ' kJ/kg'], ['Compressor work w_c', fh(C.extra.w) + ' kJ/kg'], ['Heat rejected q_out', fh(C.extra.qH) + ' kJ/kg'],
        ['Evaporator pressure', fp(C.extra.pEvap) + ' ' + pu()], ['Condenser pressure', fp(C.extra.pCond) + ' ' + pu()]);
      if (C.mdot) cards.push(['Mass flow ṁ', fx(C.mdot, 4) + ' kg/s'], ['Compressor power', fpow(C.mdot * C.extra.w)], ['Q̇_in (evaporator)', fpow(C.mdot * C.extra.qL)], ['Q̇_out (condenser)', fpow(C.mdot * C.extra.qH)]);
    }
    if (C.res) {
      cards.push(['σ_cycle per kg', (+C.res.sigma.toPrecision(4)) + ' kJ/kg·K']);
      if (C.mdot) cards.push(['σ̇_cycle', (+(C.res.sigma * C.mdot).toPrecision(4)) + ' kW/K']);
    }
    out += `<div class="tl-cards">${cards.map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>`;
    if (C.res) out += C.res.warn.map(w => `<div class="clab-warn">⚠ ${esc(w)}</div>`).join('');
    if (C.extra.x2 != null && C.extra.x2 < 0.88) out += `<div class="clab-warn">⚠ Turbine exit quality ${fx(C.extra.x2, 3)} is below ~0.88 — that much moisture erodes turbine blades. Superheat or reheat raises it.</div>`;
    // State table
    out += `<div class="tl-card"><div class="tl-card-head"><b>States</b></div><table class="clab-table tl-table"><tr><th>State</th><th>T (${Tu()})</th><th>p (${pu()})</th><th>v (m³/kg)</th><th>${closed ? 'u' : 'h'} (kJ/kg)</th><th>s (kJ/kg·K)</th><th>x</th><th>Phase</th></tr>
      ${C.states.map(s => `<tr><td><b>${esc(s.label)}</b></td><td>${fT(s.T)}</td><td>${fp(s.p)}</td><td>${fv(s.v)}</td><td>${fh(closed ? s.u : s.h)}</td><td>${fs(s.s)}</td><td>${s.x != null ? fx(s.x, 4) : '—'}</td><td>${esc(s.phase)}</td></tr>`).join('')}
      ${C.procs.filter(p => showIdeal(p, C.states)).map(p => `<tr class="tl-ideal"><td>${esc(p.to)}s</td><td>${fT(p.ideal.T)}</td><td>${fp(p.ideal.p)}</td><td>${fv(p.ideal.v)}</td><td>${fh(closed ? p.ideal.u : p.ideal.h)}</td><td>${fs(p.ideal.s)}</td><td>${p.ideal.x != null ? fx(p.ideal.x, 4) : '—'}</td><td>isentropic exit</td></tr>`).join('')}
      </table>${gas && !closed ? '<div class="clab-note">Air entropy is s°(T) − R ln(p / 1 atm); only differences are meaningful.</div>' : ''}</div>`;
    // Process table
    out += `<div class="tl-card"><div class="tl-card-head"><b>Processes</b><span>per kg of working fluid · + = into the fluid</span></div><table class="clab-table tl-table"><tr><th>Process</th><th>Component</th><th>q (kJ/kg)</th><th>w (kJ/kg, out +)</th>${C.mdot ? '<th>Q̇</th><th>Ẇ</th>' : ''}</tr>
      ${C.procs.map(p => `<tr><td>${esc(p.from)} → ${esc(p.to)}</td><td>${esc(p.label)}${p.internal ? ' <em>(internal)</em>' : ''}</td><td>${p.q ? fh(p.q) : '0'}</td><td>${p.w ? fh(p.w) : '0'}</td>${C.mdot ? `<td>${p.q ? fpow(p.q * C.mdot) : '—'}</td><td>${p.w ? fpow(p.w * C.mdot) : '—'}</td>` : ''}</tr>`).join('')}
      </table></div>`;
    out += `<div class="clab-note">${cycleNote(cy.type, C)}</div>`;
    return out;
  }
  function cycleNote(type, C) {
    if (type === 'rankine') return 'η = (W_t − W_p) / Q_in, with h₂ = h₁ − η_t(h₁ − h₂s) and h₄ = h₃ + (h₄s − h₃)/η_p. Water from IAPWS-IF97 — matches current steam tables (NIST/Çengel) and may differ from older printed tables by ~0.1%.';
    if (type === 'brayton') return `η = (w_t − w_c) / q_in. ${C.sub === 'aircold' ? 'Cold air-standard: T₂s/T₁ = (p₂/p₁)^((k−1)/k).' : 'Variable specific heats: isentropic states from s°₂ = s°₁ + R ln(p₂/p₁), as with p_r in Table A-22.'}`;
    if (type === 'otto') return 'Closed system, per kg: q₂₃ = u₃ − u₂, q₄₁ = u₄ − u₁, η = 1 − q₄₁/q₂₃; mep = w_cycle / (v₁ − v₂). Cold-air η = 1 − 1/r^(k−1).';
    if (type === 'diesel') return 'Closed system, per kg: q₂₃ = h₃ − h₂ (constant pressure), q₄₁ = u₄ − u₁, η = 1 − q₄₁/q₂₃.';
    return 'β = (h₁ − h₄)/(h₂ − h₁), γ = (h₂ − h₃)/(h₂ − h₁); the expansion valve is a throttle (h₄ = h₃). R-134a from the Tillner-Roth & Baehr equation of state, ASHRAE reference (h = s = 0 for saturated liquid at −40 °C), which matches Çengel\'s tables; Moran\'s older R-134a tables differ by up to ~3 kJ/kg.';
  }

  // ---- diagrams ------------------------------------------------------------------------------
  function niceTicks(lo, hi, n = 6) {
    if (!(hi > lo)) { hi = lo + 1; }
    const step0 = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  // A process's isentropic end state only matters when the real process isn't isentropic.
  const showIdeal = (p, states) => { const to = p.ideal && states.find(s => s.label === p.to); return !!to && Math.abs(to.h - p.ideal.h) > 1e-6; };
  const KIND_CLASS = { heat: 'heat', reject: 'reject', expand: 'work', compress: 'work', regen: 'regen', throttle: 'throttle' };
  // T-s diagram: dome (fluids), process paths, state points, isentropic-exit markers, reservoirs.
  function tsDiagram({ sub, states, procs = [], TH, TL, point, isobar }) {
    const W = 660, H = 360, L = 58, R = 18, T = 14, B = 42;
    const fluid = !E.isGas(sub);
    const dome = fluid ? E.dome(sub) : [];
    const pts = [];
    dome.forEach(d => { pts.push([d.sf, d.T], [d.sg, d.T]); });
    procs.forEach(p => p.path.forEach(s => pts.push([s.s, s.T])));
    (states || []).forEach(s => pts.push([s.s, s.T]));
    if (point) pts.push([point.s, point.T]);
    if (isobar) isobar.forEach(s => pts.push([s.s, s.T]));
    if (!pts.length) return '';
    if (TH > 0) pts.push([pts[0][0], TH]);
    if (TL > 0) pts.push([pts[0][0], TL]);
    let x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
    let y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
    const px = (x1 - x0) * 0.06 || 0.5, py = (y1 - y0) * 0.08 || 10;
    x0 -= px; x1 += px; y0 -= py; y1 += py;
    const X = (s) => L + (s - x0) / (x1 - x0) * (W - L - R), Y = (t) => H - B - (t - y0) / (y1 - y0) * (H - B - T);
    let g = '';
    for (const v of niceTicks(x0, x1, 8)) g += `<line class="tl-grid" x1="${X(v)}" y1="${T}" x2="${X(v)}" y2="${H - B}"/><text class="tl-tick" x="${X(v)}" y="${H - B + 15}" text-anchor="middle">${+v.toPrecision(4)}</text>`;
    for (const vK of niceTicks(Tdisp(y0), Tdisp(y1), 6)) { const yy = Y(prefs.units.T === 'K' ? vK : vK + 273.15); g += `<line class="tl-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/><text class="tl-tick" x="${L - 6}" y="${yy + 3}" text-anchor="end">${+vK.toPrecision(5)}</text>`; }
    g += `<text class="tl-axis" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">s (kJ/kg·K)</text><text class="tl-axis" transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">T (${Tu()})</text>`;
    if (fluid && dome.length) {
      const d = dome.map(p => `${X(p.sf).toFixed(1)},${Y(p.T).toFixed(1)}`).concat(dome.slice().reverse().map(p => `${X(p.sg).toFixed(1)},${Y(p.T).toFixed(1)}`));
      g += `<polygon class="tl-dome" points="${d.join(' ')}"/>`;
      if (sub === 'r134a' || sub === 'water') {
        const top = dome[dome.length - 1];
        g += `<circle class="tl-crit" cx="${X((top.sf + top.sg) / 2)}" cy="${Y(top.T)}" r="2.5"/>`;
      }
    }
    if (isobar && isobar.length > 1) g += `<polyline class="tl-isobar" points="${isobar.map(s => `${X(s.s).toFixed(1)},${Y(s.T).toFixed(1)}`).join(' ')}"/>`;
    const resLine = (t, cls, label) => (t > 0 ? `<line class="tl-resline ${cls}" x1="${L}" y1="${Y(t)}" x2="${W - R}" y2="${Y(t)}"/><text class="tl-reslbl ${cls}" x="${W - R - 4}" y="${Y(t) - 4}" text-anchor="end">${label} ${fT(t)} ${Tu()}</text>` : '');
    g += resLine(TH, 'hot', 'T_H') + resLine(TL, 'cold', 'T_C');
    for (const p of procs) {
      const dashed = p.path.length === 2 && p.kind !== 'heat' && p.kind !== 'reject';
      g += `<polyline class="tl-proc ${KIND_CLASS[p.kind] || ''}${dashed ? ' dashed' : ''}" points="${p.path.map(s => `${X(s.s).toFixed(1)},${Y(s.T).toFixed(1)}`).join(' ')}"/>`;
      if (showIdeal(p, states)) {
        const from = states.find(s => s.label === p.from);
        if (from) g += `<line class="tl-isen" x1="${X(from.s)}" y1="${Y(from.T)}" x2="${X(p.ideal.s)}" y2="${Y(p.ideal.T)}"/><circle class="tl-pt-ideal" cx="${X(p.ideal.s)}" cy="${Y(p.ideal.T)}" r="3"/><text class="tl-pt-lbl ideal" x="${X(p.ideal.s) - 6}" y="${Y(p.ideal.T) + 13}" text-anchor="end">${esc(p.to)}s</text>`;
      }
    }
    for (const s of states || []) g += `<circle class="tl-pt" cx="${X(s.s)}" cy="${Y(s.T)}" r="4"/><text class="tl-pt-lbl" x="${X(s.s) + 6}" y="${Y(s.T) - 6}">${esc(s.label)}</text>`;
    if (point) g += `<circle class="tl-pt big" cx="${X(point.s)}" cy="${Y(point.T)}" r="5.5"/>`;
    return `<svg class="tl-diagram" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
  }
  function pvDiagram(C) {
    const W = 660, H = 360, L = 64, R = 18, T = 14, B = 42;
    const pts = [];
    C.procs.forEach(p => p.path.forEach(s => pts.push([s.v, s.p])));
    const x0 = 0, x1 = Math.max(...pts.map(p => p[0])) * 1.08;
    const y0 = 0, y1 = Math.max(...pts.map(p => p[1])) * 1.08;
    const X = (v) => L + (v - x0) / (x1 - x0) * (W - L - R), Y = (p) => H - B - (p - y0) / (y1 - y0) * (H - B - T);
    let g = '';
    for (const v of niceTicks(x0, x1, 8)) g += `<line class="tl-grid" x1="${X(v)}" y1="${T}" x2="${X(v)}" y2="${H - B}"/><text class="tl-tick" x="${X(v)}" y="${H - B + 15}" text-anchor="middle">${+v.toPrecision(3)}</text>`;
    for (const pv of niceTicks(pdisp(y0), pdisp(y1), 6)) { const yy = Y(psi(pv)); g += `<line class="tl-grid" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/><text class="tl-tick" x="${L - 6}" y="${yy + 3}" text-anchor="end">${+pv.toPrecision(4)}</text>`; }
    g += `<text class="tl-axis" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">v (m³/kg)</text><text class="tl-axis" transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">p (${pu()})</text>`;
    for (const p of C.procs) {
      const dashed = p.path.length === 2 && p.kind !== 'heat' && p.kind !== 'reject';
      g += `<polyline class="tl-proc ${KIND_CLASS[p.kind] || ''}${dashed ? ' dashed' : ''}" points="${p.path.map(s => `${X(s.v).toFixed(1)},${Y(s.p).toFixed(1)}`).join(' ')}"/>`;
    }
    for (const s of C.states) g += `<circle class="tl-pt" cx="${X(s.v)}" cy="${Y(s.p)}" r="4"/><text class="tl-pt-lbl" x="${X(s.v) + 6}" y="${Y(s.p) - 6}">${esc(s.label)}</text>`;
    return `<svg class="tl-diagram" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
  }

  // =========================================================================================
  // DEVICES
  // =========================================================================================
  // A typical textbook setup per device, loaded when the device type changes.
  const DEVICE_DEFAULTS = {
    turbine: { sub: 'water', pair: 'Tp', a: 673.15, b: 3000, p2: 10, mode: 'eta', eta: 0.85, mdot: 1, Qdot: 0 },
    compressor: { sub: 'air', pair: 'Tp', a: 300, b: 100, p2: 800, mode: 'eta', eta: 0.85, mdot: 1, Qdot: 0 },
    pump: { sub: 'water', pair: 'px', a: 10, b: 0, p2: 3000, mode: 'eta', eta: 0.8, mdot: 1, Qdot: 0 },
    nozzle: { sub: 'air', pair: 'Tp', a: 500, b: 300, p2: 100, mode: 'eta', eta: 0.95, mdot: 1, V1: 10 },
    diffuser: { sub: 'air', pair: 'Tp', a: 250, b: 50, p2: 70, mdot: 1, V1: 250, V2: 30 },
    throttle: { sub: 'r134a', pair: 'Tx', a: 309.15, b: 0, p2: 200, mdot: 0.1 },
    heater: { sub: 'water', pair: 'Tp', a: 313.15, b: 8000, p2: 8000, mode: 'T2', T2: 753.15, mdot: 1, Tb: 1273.15 },
  };
  const DEVICES = {
    turbine: 'Turbine', compressor: 'Compressor', pump: 'Pump', nozzle: 'Nozzle', diffuser: 'Diffuser',
    throttle: 'Throttling valve', heater: 'Heat exchanger (one stream)',
  };
  function devFields() {
    const d = prefs.devices;
    const pairs = pairsFor(d.sub);
    if (!pairs.includes(d.pair)) d.pair = 'Tp';
    const pf = pairFields(d.pair);
    let exit = [F('p2', 'Exit pressure p₂', 'p')];
    const modeOpts = d.device === 'heater' ? [['T2', 'Exit temperature T₂'], ['x2', 'Exit quality x₂'], ['h2', 'Exit enthalpy h₂']]
      : d.device === 'throttle' ? null
        : d.device === 'diffuser' ? null
          : [['eta', 'Isentropic efficiency'], ['T2', 'Measured exit temperature'], ['x2', 'Measured exit quality'], ['h2', 'Measured exit enthalpy']];
    if (modeOpts) {
      if (!modeOpts.some(o => o[0] === d.mode)) d.mode = modeOpts[0][0];
      exit.push(F('mode', 'Exit state from', 'sel', { options: modeOpts }));
      if (d.mode === 'eta') exit.push(F('eta', 'Isentropic efficiency η', 'pct'));
      if (d.mode === 'T2') exit.push(F('T2', 'T₂', 'T'));
      if (d.mode === 'x2') exit.push(F('x2', 'x₂', 'num', { unit: '0–1' }));
      if (d.mode === 'h2') exit.push(F('h2', 'h₂', 'num', { unit: 'kJ/kg' }));
    }
    const flow = [F('mdot', 'Mass flow ṁ', 'num', { unit: 'kg/s' })];
    if (d.device === 'nozzle' || d.device === 'diffuser') flow.push(F('V1', 'Inlet velocity V₁', 'num', { unit: 'm/s' }));
    if (d.device === 'diffuser') flow.push(F('V2', 'Exit velocity V₂', 'num', { unit: 'm/s' }));
    const heat = (d.device === 'turbine' || d.device === 'compressor' || d.device === 'pump')
      ? [F('Qdot', 'Heat transfer Q̇_cv', 'num', { unit: 'kW', hint: 'negative = heat lost; 0 = adiabatic' }), F('Tb', 'Boundary temperature T_b', 'T')]
      : d.device === 'heater' ? [F('Tb', 'Heat source/sink temperature T_b', 'T', { hint: 'for entropy generation' })] : [];
    return group('Device', [F('device', 'Type', 'sel', { options: Object.entries(DEVICES) }), F('sub', 'Working fluid', 'sel', { options: SUB_OPTS })].map(f => fieldHtml(f, d[f.key])).join(''))
      + group('Inlet (state 1)', fieldHtml(F('pair', 'Known properties', 'sel', { options: pairs.map(k => [k, pairLabel(k)]) }), d.pair) + pf.map(f => fieldHtml(f, d[f.key])).join(''))
      + group('Exit (state 2)', exit.map(f => fieldHtml(f, d[f.key])).join(''))
      + group('Flow & heat', [...flow, ...heat, F('T0', 'Dead state T₀ (exergy)', 'T')].map(f => fieldHtml(f, d[f.key])).join(''));
  }
  function devFieldType(key) {
    const d = prefs.devices;
    if (key === 'a' || key === 'b') { const f = pairFields(d.pair)[key === 'a' ? 0 : 1]; return f.type; }
    return { p2: 'p', T2: 'T', Tb: 'T', T0: 'T', eta: 'pct', device: 'sel', sub: 'sel', pair: 'sel', mode: 'sel' }[key] || 'num';
  }
  function devCompute() {
    const d = prefs.devices;
    let D;
    try {
      D = E.device({ device: d.device, sub: d.sub, in: pairQuery(d.pair, d.a, d.b), p2: d.p2, mode: d.device === 'diffuser' ? 'eta' : d.mode, eta: d.eta, T2: d.T2, h2: d.h2, x2: d.x2, mdot: d.mdot, V1: d.V1, V2: d.V2, Qdot: d.Qdot, Tb: d.Tb, T0: d.T0 });
    } catch (e) { return `<div class="clab-err">${esc(e.message)}</div>`; }
    const states = [{ label: '1', ...D.s1 }, { label: '2', ...D.s2 }];
    const proc = { from: '1', to: '2', kind: d.device === 'heater' ? (D.q >= 0 ? 'heat' : 'reject') : d.device === 'throttle' ? 'throttle' : (d.device === 'turbine' || d.device === 'nozzle') ? 'expand' : 'compress',
      path: d.device === 'heater' ? E.pathP(d.sub, d.p2, D.s1, D.s2) : [D.s1, D.s2], ideal: D.s2s };
    const cards = [];
    if (D.eta != null && isFinite(D.eta)) cards.push(['Isentropic efficiency', fpct(D.eta)]);
    if (d.device === 'turbine' || d.device === 'compressor' || d.device === 'pump') cards.push([d.device === 'turbine' ? 'Power out Ẇ_cv' : 'Power in −Ẇ_cv', fpow(Math.abs(D.Wdot))], ['Work per kg', fh(D.w) + ' kJ/kg']);
    if (d.device === 'nozzle') cards.push(['Exit velocity V₂', fx(D.V2, 1) + ' m/s']);
    if (d.device === 'heater') cards.push([D.q >= 0 ? 'Heat added Q̇' : 'Heat removed Q̇', fpow(Math.abs(D.Qdot))], ['q per kg', fh(D.q) + ' kJ/kg']);
    cards.push(['Δh = h₂ − h₁', fh(D.s2.h - D.s1.h) + ' kJ/kg'], ['Δs = s₂ − s₁', fs(D.ds) + ' kJ/kg·K']);
    cards.push(['Entropy generation σ̇_cv', D.sigmaUnknownTb ? 'needs T_b' : (+D.sigma.toPrecision(4)) + ' kW/K'], ['Exergy destroyed T₀σ̇', D.sigmaUnknownTb ? '—' : fpow(D.Ed)]);
    if (D.s2.x != null) cards.push(['Exit quality x₂', fx(D.s2.x, 4)]);
    const verdict = D.sigmaUnknownTb ? '' : D.sigma < -1e-9 ? '<div class="tl-verdict tl-v-bad">Impossible — σ̇_cv &lt; 0 violates the second law. Check the exit state or efficiency.</div>'
      : Math.abs(D.sigma) <= 1e-9 ? '<div class="tl-verdict tl-v-rev">Internally reversible — no entropy generated.</div>' : '';
    const rows = [['1 (inlet)', D.s1], ['2 (exit)', D.s2]];
    if (D.s2s && Math.abs(D.s2s.h - D.s2.h) > 1e-6) rows.push(['2s (isentropic)', D.s2s]);
    return `<div class="tl-card"><div class="tl-card-head"><b>${esc(DEVICES[d.device])} — ${esc(E.SUBSTANCES[d.sub].short)}</b></div>${tsDiagram({ sub: d.sub, states, procs: [proc] })}</div>
      ${verdict}
      <div class="tl-cards">${cards.map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>
      <div class="tl-card"><table class="clab-table tl-table"><tr><th>State</th><th>T (${Tu()})</th><th>p (${pu()})</th><th>v (m³/kg)</th><th>h (kJ/kg)</th><th>s (kJ/kg·K)</th><th>x</th><th>Phase</th></tr>
      ${rows.map(([n, s]) => `<tr${n.startsWith('2s') ? ' class="tl-ideal"' : ''}><td><b>${n}</b></td><td>${fT(s.T)}</td><td>${fp(s.p)}</td><td>${fv(s.v)}</td><td>${fh(s.h)}</td><td>${fs(s.s)}</td><td>${s.x != null ? fx(s.x, 4) : '—'}</td><td>${esc(s.phase)}</td></tr>`).join('')}</table></div>
      <div class="clab-note">Steady state, one inlet and one exit: 0 = Q̇_cv − Ẇ_cv + ṁ[(h₁ − h₂) + (V₁² − V₂²)/2] and σ̇_cv = ṁ(s₂ − s₁) − Q̇_cv/T_b. Turbine/nozzle η = (h₁ − h₂)/(h₁ − h₂s); compressor/pump η = (h₂s − h₁)/(h₂ − h₁).</div>`;
  }

  // =========================================================================================
  // PROPERTIES
  // =========================================================================================
  function propFields() {
    const pr = prefs.props;
    const pairs = pairsFor(pr.sub);
    if (!pairs.includes(pr.pair)) pr.pair = 'Tp';
    const fluid = !E.isGas(pr.sub);
    const kinds = fluid ? [['satT', 'Saturated — temperature table'], ['satP', 'Saturated — pressure table'], ['single', 'Superheated / compressed at fixed p']] : [['single', 'Ideal-gas table at fixed p']];
    if (!kinds.some(k => k[0] === pr.tableKind)) pr.tableKind = kinds[0][0];
    const rangeType = pr.tableKind === 'satP' ? 'p' : 'T';
    return group('Substance', fieldHtml(F('sub', 'Substance', 'sel', { options: SUB_OPTS }), pr.sub))
      + group('State', fieldHtml(F('pair', 'Known properties', 'sel', { options: pairs.map(k => [k, pairLabel(k)]) }), pr.pair) + pairFields(pr.pair).map(f => fieldHtml(f, pr[f.key])).join(''))
      + group('Table', [F('tableKind', 'Kind', 'sel', { options: kinds }), ...(pr.tableKind === 'single' ? [F('tableP', 'At pressure', 'p')] : []),
        F('from', 'From', rangeType), F('to', 'To', rangeType), F('step', 'Step', rangeType === 'T' ? 'dT' : 'p')].map(f => fieldHtml(f, pr[f.key])).join(''))
      + `<div class="clab-prop-actions"><button class="kicad-btn kicad-btn-outline" data-cmd="csv">Copy table as CSV</button></div>`;
  }
  function propFieldType(key) {
    const pr = prefs.props;
    if (key === 'a' || key === 'b') return pairFields(pr.pair)[key === 'a' ? 0 : 1].type;
    if (key === 'from' || key === 'to') return pr.tableKind === 'satP' ? 'p' : 'T';
    if (key === 'step') return pr.tableKind === 'satP' ? 'p' : 'dT';
    return { tableP: 'p', sub: 'sel', pair: 'sel', tableKind: 'sel' }[key] || 'num';
  }
  function propCompute() {
    const pr = prefs.props;
    let out = '';
    let st = null;
    try { st = E.state(pr.sub, pairQuery(pr.pair, pr.a, pr.b)); } catch (e) { out += `<div class="clab-err">${esc(e.message)}</div>`; }
    if (st) {
      let iso = null;
      try {
        if (!E.isGas(pr.sub)) {
          const P = E.SUBSTANCES[pr.sub];
          const a = E.state(pr.sub, { T: P.Tmin + 1, p: Math.max(st.p, 1) });
          const b = E.state(pr.sub, { T: Math.min(pr.sub === 'water' ? 1073 : 450, Math.max(st.T + 150, (P.Tc || 0) + 50)), p: st.p });
          iso = E.pathP(pr.sub, st.p, a, b, 60);
        } else {
          const a = E.state(pr.sub, { T: Math.max(220, st.T * 0.5), p: st.p }), b = E.state(pr.sub, { T: Math.min(2900, st.T * 1.6), p: st.p });
          iso = E.pathP(pr.sub, st.p, a, b, 30);
        }
      } catch (_) { iso = null; }
      const cards = [['Phase', esc(st.phase)], ['T', fT(st.T) + ' ' + Tu()], ['p', fp(st.p) + ' ' + pu()], ['v', fv(st.v) + ' m³/kg'], ['u', fh(st.u) + ' kJ/kg'], ['h', fh(st.h) + ' kJ/kg'], ['s', fs(st.s) + ' kJ/kg·K']];
      if (st.x != null) cards.push(['Quality x', fx(st.x, 4)]);
      if (st.s0 != null) cards.push(['s°(T)', fs(st.s0) + ' kJ/kg·K']);
      if (st.cp != null) cards.push(['c_p', fx(st.cp, 4) + ' kJ/kg·K']);
      if (st.T) cards.push(['T (K)', fx(st.T, 2) + ' K']);
      out += `<div class="tl-card"><div class="tl-card-head"><b>${esc(E.SUBSTANCES[pr.sub].name)}</b><span>isobar through the state shown</span></div>${tsDiagram({ sub: pr.sub, states: [], procs: [], point: st, isobar: iso })}</div>
        <div class="tl-cards">${cards.map(([k, v]) => `<div><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>`;
      if (!E.isGas(pr.sub) && st.x == null) {
        try {
          const S = st.T < E.SUBSTANCES[pr.sub].Tc ? E.sat(pr.sub, 'T', st.T) : null;
          if (S) out += `<div class="clab-note">At this temperature: p_sat = ${fp(S.p)} ${pu()} — ${st.p > S.p ? 'p > p_sat, so the state is a compressed liquid' : 'p < p_sat, so the state is superheated vapor'}.</div>`;
        } catch (_) { /* near critical */ }
      }
    }
    out += propTable();
    return out;
  }
  function propTable() {
    const pr = prefs.props;
    const lo = pr.from, hi = pr.to, step = pr.step;
    if (!(isFinite(lo) && isFinite(hi) && step > 0)) return '';
    const n = Math.floor((hi - lo) / step + 1e-9) + 1;
    if (n > 400 || n < 1) return '<div class="clab-warn">⚠ Pick a range with at most 400 rows.</div>';
    const rows = [];
    let head;
    const errs = [];
    if (pr.tableKind === 'satT' || pr.tableKind === 'satP') {
      head = pr.tableKind === 'satT'
        ? [`T (${Tu()})`, `p_sat (${pu()})`, 'v_f', 'v_g', 'u_f', 'u_g', 'h_f', 'h_fg', 'h_g', 's_f', 's_g']
        : [`p (${pu()})`, `T_sat (${Tu()})`, 'v_f', 'v_g', 'u_f', 'u_g', 'h_f', 'h_fg', 'h_g', 's_f', 's_g'];
      for (let i = 0; i < n; i++) {
        const val = lo + i * step;
        try {
          const S = E.sat(pr.sub, pr.tableKind === 'satT' ? 'T' : 'p', val);
          const first = pr.tableKind === 'satT' ? [fT(S.T), fp(S.p)] : [fp(S.p), fT(S.T)];
          rows.push([...first, fv(S.vf), fv(S.vg), fh(S.uf), fh(S.ug), fh(S.hf), fh(S.hg - S.hf), fh(S.hg), fs(S.sf), fs(S.sg)]);
        } catch (e) { errs.push(e.message); }
      }
    } else {
      head = [`T (${Tu()})`, 'v (m³/kg)', 'u (kJ/kg)', 'h (kJ/kg)', 's (kJ/kg·K)', 'Phase'];
      for (let i = 0; i < n; i++) {
        const T = lo + i * step;
        try { const s = E.fromTP(pr.sub, T, pr.tableP); rows.push([fT(T), fv(s.v), fh(s.u), fh(s.h), fs(s.s), s.phase]); } catch (e) { errs.push(e.message); }
      }
    }
    lastTable = { head, rows };
    const title = pr.tableKind === 'satT' ? 'Saturation table (temperature)' : pr.tableKind === 'satP' ? 'Saturation table (pressure)' : `Single-phase table at p = ${fp(pr.tableP)} ${pu()}`;
    return `<div class="tl-card"><div class="tl-card-head"><b>${title}</b><span>${rows.length} rows</span></div>
      ${errs.length ? `<div class="clab-warn">⚠ ${esc([...new Set(errs)][0])}</div>` : ''}
      <div class="tl-table-wrap"><table class="clab-table tl-table"><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div></div>`;
  }

  // =========================================================================================
  // shell
  // =========================================================================================
  const TABS = {
    reservoirs: { name: 'Reservoirs & limits', icon: '🔥', fields: resFields, compute: resCompute, scope: () => prefs.reservoirs,
      type: (k) => ({ TH: 'T', TL: 'T', perf: prefs.reservoirs.mode === 'power' ? 'pct' : 'num', mode: 'sel', basis: 'sel' }[k] || 'num') },
    cycles: { name: 'Power & refrigeration cycles', icon: '♻️', fields: cycFields, compute: cycCompute, scope: () => prefs.cycles[prefs.cycles.type], type: cycFieldType },
    devices: { name: 'Devices', icon: '🌀', fields: devFields, compute: devCompute, scope: () => prefs.devices, type: devFieldType },
    props: { name: 'Property tables', icon: '📋', fields: propFields, compute: propCompute, scope: () => prefs.props, type: propFieldType },
  };
  // Fields whose change reshapes the form (so the form re-renders instead of just recomputing).
  const RESHAPE = new Set(['mode', 'type', 'inlet', 'reheat', 'heatBy', 'device', 'sub', 'pair', 'tableKind', 'capUnit']);

  function renderForm() {
    const el = root.querySelector('.tl-form');
    el.innerHTML = subify(TABS[prefs.tab].fields());
  }
  function renderOut() {
    const el = root.querySelector('.tl-out');
    let html;
    try { html = TABS[prefs.tab].compute(); } catch (e) { html = `<div class="clab-err">${esc(e.message)}</div>`; }
    el.innerHTML = subify(html);
  }
  function renderAll() {
    root.querySelectorAll('.tl-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === prefs.tab));
    root.querySelector('#tl-tunit').value = prefs.units.T;
    root.querySelector('#tl-punit').value = prefs.units.p;
    renderForm();
    renderOut();
  }
  function scheduleCompute() { clearTimeout(computeTimer); computeTimer = setTimeout(() => { savePrefs(); renderOut(); }, 140); }

  function onFormInput(e, committed) {
    const t = e.target;
    if (t.dataset.example) {
      if (!committed || !t.value) return;
      if (t.dataset.example === 'res') prefs.reservoirs = { ...prefs.reservoirs, ...Object.values(RES_EXAMPLES)[+t.value] };
      else {
        const [type, vals] = Object.values(CYCLE_EXAMPLES)[+t.value];
        prefs.cycles.type = type;
        prefs.cycles[type] = { ...DEFAULTS.cycles[type], ...vals };
      }
      savePrefs(); renderForm(); renderOut();
      return;
    }
    const k = t.dataset.k;
    if (!k) return;
    if (t.dataset.scope === 'cycles' && k === 'type') { prefs.cycles.type = t.value; savePrefs(); renderForm(); renderOut(); return; }
    const tab = TABS[prefs.tab];
    const scope = tab.scope();
    const type = tab.type(k);
    if (type === 'sel') {
      if (!committed) return;
      scope[k] = t.value;
      // A new substance resets the inlet/property values to something valid for it.
      if (k === 'sub') Object.assign(scope, t.value === 'water' ? { pair: 'Tp', a: 573.15, b: 1000 } : t.value === 'r134a' ? { pair: 'Tp', a: 293.15, b: 200 } : { pair: 'Tp', a: 300, b: 100 });
      if (k === 'sub' && prefs.tab === 'props') Object.assign(scope, t.value === 'water' ? { from: 273.16, to: 373.15, step: 10, tableP: 1000 } : t.value === 'r134a' ? { from: 233.15, to: 333.15, step: 10, tableP: 200 } : { tableKind: 'single', from: 250, to: 1500, step: 50, tableP: 100 });
      if (k === 'sub' && prefs.tab === 'devices') Object.assign(scope, t.value === 'water' ? { p2: 10 } : t.value === 'r134a' ? { p2: 1000 } : { p2: 1000 });
      if (k === 'pair') { scope.a = null; scope.b = null; }
      if (k === 'device') Object.assign(scope, DEVICE_DEFAULTS[t.value] || {});
      savePrefs();
      if (RESHAPE.has(k)) renderForm();
      renderOut();
      return;
    }
    const v = toSI({ type }, t.value);
    if (v === undefined) { t.classList.add('tl-bad'); return; }
    t.classList.remove('tl-bad');
    scope[k] = v;
    scheduleCompute();
  }

  function build(container) {
    container.innerHTML = `
      <div class="clab tl">
        <div class="clab-toolbar">
          <div class="tl-tabs">${Object.entries(TABS).map(([k, t]) => `<button class="tl-tab" data-tab="${k}"><span>${t.icon}</span>${esc(t.name)}</button>`).join('')}</div>
          <span class="clab-spacer"></span>
          <label class="clab-chk">T <select id="tl-tunit" class="kicad-input clab-sel"><option value="C">°C</option><option value="K">K</option></select></label>
          <label class="clab-chk">p <select id="tl-punit" class="kicad-input clab-sel"><option>kPa</option><option>bar</option><option>MPa</option></select></label>
        </div>
        <div class="tl-main">
          <div class="tl-form"></div>
          <div class="tl-out"></div>
        </div>
      </div>`;
    root = container.querySelector('.tl');
    root.querySelectorAll('.tl-tab').forEach(b => b.addEventListener('click', () => { prefs.tab = b.dataset.tab; savePrefs(); renderAll(); }));
    root.querySelector('#tl-tunit').addEventListener('change', (e) => { prefs.units.T = e.target.value; savePrefs(); renderAll(); });
    root.querySelector('#tl-punit').addEventListener('change', (e) => { prefs.units.p = e.target.value; savePrefs(); renderAll(); });
    const form = root.querySelector('.tl-form');
    form.addEventListener('input', (e) => onFormInput(e, false));
    form.addEventListener('change', (e) => onFormInput(e, true));
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd="csv"]');
      if (b && lastTable) {
        const csv = [lastTable.head, ...lastTable.rows].map(r => r.map(c => /[",]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
        navigator.clipboard.writeText(csv).then(() => { b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = 'Copy table as CSV'; }, 1500); }, () => {});
      }
    });
    root.querySelector('.tl-out').addEventListener('click', (e) => {
      const v = e.target.closest('[data-view]');
      if (v) { prefs.cycles.view = v.dataset.view; savePrefs(); renderOut(); }
    });
  }

  return {
    mount(container) {
      if (mounted || !container) return;
      mounted = true;
      prefs = loadPrefs();
      build(container);
      renderAll();
    },
    activate() { if (root) renderOut(); },
    deactivate() { clearTimeout(computeTimer); savePrefs(); },
  };
})();
