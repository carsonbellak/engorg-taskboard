// Handwriter utility — paste or drop LaTeX (a whole .tex file or just a formula) and get it back
// as handwriting in the user's own font, laid out on EngInk-style pages (816x1056, the same
// GRID/RULED/DOTS/PLAIN paper as the tablet), ready to export as a PDF or copy as an image.
//
// Everything runs here on a <canvas>:
//   parseDoc()  — LaTeX text mode → a flat token flow (words, inline/display math, headings, lists…).
//                 Handles the preamble, \newcommand/\def macros, comments, common text commands.
//   parseMath() — math mode → atoms (fractions, roots, scripts, big operators, matrices, \left…\right,
//                 accents, Greek…), laid out by mathBox() into TeX-like boxes {w,h,d,draw}.
//   layout()    — flows the boxes into lines/pages, snapping baselines to the ruled lines.
//
// Connected letters: the handwriting font joins letters through its own OpenType `liga`
// (t_h, i_n_g, t_i_o_n…) and `calt` (contextual .alt forms) features, which only apply within ONE
// shaped text run. So every word — and every run of math letters — is drawn with a single fillText
// (never glyph-by-glyph, never with letterSpacing, which disables ligatures), and the hand-drawn
// "messiness" jitters whole words, not letters. Strokes the font can't provide (fraction bars,
// radicals, tall delimiters, arrows, accents) are drawn as wobbly ink lines matching the font's stem.
//
// The font is loaded from the system by name via FontFace(local(...)) — the user's handwriting font
// is never bundled with the app. Saving goes through window.api.handwriter.save (ipc/handwriter.js).
// Desktop-only utility.

const handwriter = (() => {
  const PAGE_W = 816, PAGE_H = 1056, GRID = 32;
  const MARGIN_L = 48, MARGIN_R = 48, MARGIN_T = 64, MARGIN_B = 48;
  const DEFAULT_FONT = 'Carson Hand';
  const FALLBACK = '"Segoe Print", "Segoe UI Symbol", "Cambria Math", sans-serif';
  const DRAFT_KEY = 'engorg_handwriter_draft';
  const SECTIONS_KEY = 'engorg_handwriter_sections'; // committed sections (device-local)
  // settings that belong to a section (frozen on commit); paper, page colour and font are page-wide
  const SECTION_KEYS = ['size', 'mess', 'group', 'pen', 'ink', 'disp', 'mode', 'seed'];
  const PREVIEW_K = 1.25;
  const INKS = [
    { c: '#1F2329', name: 'Black' }, { c: '#1E3A8A', name: 'Blue' }, { c: '#2563EB', name: 'Bright blue' },
    { c: '#B91C1C', name: 'Red' }, { c: '#166534', name: 'Green' }, { c: '#6D28D9', name: 'Purple' }, { c: '#52525B', name: 'Pencil' },
  ];
  const PAGES = { white: '#FFFFFF', cream: '#FBF6E9', dark: '#23262D' };
  // pen: stroke width in page px (0 = auto, the font's own weight at the default size)
  // group: how many words drift together in one direction before the next group turns
  const DEFAULTS = { font: DEFAULT_FONT, size: 30, mess: 0.8, group: 3, pen: 0, ink: INKS[0].c, paper: 'GRID', page: 'white', mode: 'auto', disp: 'center', seed: 1, inkOnly: false };
  const EXAMPLE = String.raw`\section{Projectile Motion}
A ball is launched with speed $v_0$ at an angle $\theta$ above the ground. Ignoring drag, the range is
\[ R = \frac{v_0^2 \sin 2\theta}{g} \]
and the maximum height is $h = \frac{v_0^2 \sin^2\theta}{2g}$.

\subsection{Energy check}
\begin{align*}
  E &= \frac{1}{2} m v^2 + m g y \\
    &= \text{constant}
\end{align*}

\begin{itemize}
  \item Gauss: $\oint \vec{E} \cdot d\vec{A} = \frac{Q}{\varepsilon_0}$
  \item Taylor: $e^x = \sum_{n=0}^{\infty} \frac{x^n}{n!}$
  \item $\int_0^1 x^2 \, dx = \frac{1}{3}$ and $\mathbf{A} = \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$
\end{itemize}`;

  let mounted = false, root = null;
  let opts = { ...DEFAULTS };
  let face = null, faceFamily = null, faceSeq = 0, fontOk = false, fontName = '';
  let M = null;               // font metrics as fractions of the em (see measureMetrics)
  const glyphCache = new Map(); // pen-width-corrected word bitmaps (see glyphBitmap)
  let pages = [];             // last layout: [[{ box, key, x, y }]]
  let renderTimer = null, saveTimer = null, fontTimer = null;
  let busy = false;
  const mcx = document.createElement('canvas').getContext('2d'); // measuring context

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---- deterministic randomness (stable per word, so typing doesn't reshuffle the page) ----
  function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const rngFor = (key, seed = opts.seed) => mulberry(hashStr(seed + '|' + key));
  const hash01 = (key, seed = opts.seed) => hashStr(seed + '~' + key) / 4294967296;

  // ---- font ----------------------------------------------------------------
  function fontStr(fs) { return `${fs.toFixed(2)}px ${faceFamily ? `"${faceFamily}", ` : ''}${FALLBACK}`; }
  function setText(c, fs) {
    c.font = fontStr(fs);
    c.fontKerning = 'normal';
    c.textRendering = 'optimizeLegibility'; // keeps liga/calt (connected letters) on
    if ('letterSpacing' in c) c.letterSpacing = '0px';
  }

  async function loadFont(name) {
    const fam = (name || '').trim() || DEFAULT_FONT;
    const compact = fam.replace(/\s+/g, '');
    // local() matches a font's full or PostScript name, so try the common spellings.
    const src = [fam, fam + ' Regular', compact + '-Regular', compact]
      .map(n => `local("${n.replace(/"/g, '')}")`).join(', ');
    const ff = new FontFace('EngOrgHand' + (++faceSeq), src);
    try {
      await ff.load();
      document.fonts.add(ff);
      if (face) document.fonts.delete(face);
      face = ff; faceFamily = ff.family; fontOk = true;
    } catch (_) {
      fontOk = false; faceFamily = null;
    }
    fontName = fam;
    measureMetrics();
    updateFontStatus();
    syncPen();
  }

  function measureMetrics() {
    setText(mcx, 100);
    const q = (s) => mcx.measureText(s);
    const plus = q('+'), x = q('x'), H = q('H'), asc = q('dhkl'), desc = q('gjpqy');
    const num = (v, d) => (Number.isFinite(v) && v > 0 ? v / 100 : d);
    const stem = measureStem();
    glyphCache.clear();
    M = {
      xh: num(x.actualBoundingBoxAscent, 0.45),
      cap: num(H.actualBoundingBoxAscent, 0.7),
      asc: num(asc.actualBoundingBoxAscent, 0.75),
      desc: num(desc.actualBoundingBoxDescent, 0.25),
      space: num(q(' ').width, 0.3),
      stem: clamp(stem, 0.035, 0.11),
      // math axis = centre of the '+' glyph, so fraction bars and minus signs line up with it
      axis: num((plus.actualBoundingBoxAscent - plus.actualBoundingBoxDescent) / 2, 0.25),
    };
  }

  /** Median stroke thickness (px) of the ink in an ImageData, from its distance transform: a
   *  stroke's centreline (ridge) pixels sit half its width from the nearest background, at any
   *  slant or curvature. Chamfer 3-4 distances, two passes. Needs a few px per stroke to be
   *  accurate, so callers measure supersampled bitmaps. */
  function strokeWidthPx(img) {
    const { width: W, height: H, data } = img, n = W * H;
    const dt = new Int32Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) if (data[i * 4 + 3] > 127) { dt[i] = 1 << 28; count++; }
    if (!count) return 0;
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : dt[y * W + x]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!dt[i]) continue;
      dt[i] = Math.min(dt[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x; if (!dt[i]) continue;
      dt[i] = Math.min(dt[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
    const ridge = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = dt[y * W + x]; if (!v) continue;
      if (v >= at(x - 1, y) && v >= at(x + 1, y) && v >= at(x, y - 1) && v >= at(x, y + 1) &&
          v >= at(x - 1, y - 1) && v >= at(x + 1, y + 1) && v >= at(x + 1, y - 1) && v >= at(x - 1, y + 1)) ridge.push(v / 3);
    }
    ridge.sort((a, b) => a - b);
    return Math.max(1, 2 * ridge[ridge.length >> 1] - 0.5); // pixel centres → edge-to-edge width
  }

  /** The font's typical letter-stroke thickness (fraction of the em), from a sample of lowercase
   *  words rendered big — what "Auto" pen matches. */
  function measureStem() {
    const S = 200, cv = document.createElement('canvas');
    cv.width = S * 7; cv.height = S * 1.6;
    const x = cv.getContext('2d', { willReadFrequently: true });
    setText(x, S); x.fillStyle = '#000';
    x.fillText('minute show', 10, S * 1.1);
    const w = strokeWidthPx(x.getImageData(0, 0, cv.width, cv.height));
    return w ? clamp(w / S, 0.02, 0.15) : 0.06;
  }

  /** Left ink bearing (canvas reports it positive-to-the-left of the origin). */
  function mcxLeft(text, fs) { setText(mcx, fs); return mcx.measureText(text).actualBoundingBoxLeft || 0; }

  function measureRun(text, fs) {
    setText(mcx, fs);
    const m = mcx.measureText(text);
    return { w: m.width, h: Math.max(0, m.actualBoundingBoxAscent || 0), d: Math.max(0, m.actualBoundingBoxDescent || 0) };
  }

  // ---- ink drawing helpers --------------------------------------------------
  // One pen, one width: every stroke — letters at any size, scripts, fraction bars — is J.pen
  // page px wide, like a real pen. (fs is kept in the signature for the callers' readability.)
  const stemW = (fs, J) => J.pen;
  /** The pen width that matches the font as designed at the default size. */
  const autoPen = () => Math.round(M.stem * DEFAULTS.size * 10) / 10;
  const penWidth = () => (opts.pen > 0 ? opts.pen : autoPen());

  function traceSmooth(c, pts, cont) {
    if (!pts.length) return;
    if (cont) c.lineTo(pts[0][0], pts[0][1]); else c.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) { c.lineTo(pts[0][0] + 0.1, pts[0][1]); return; }
    if (pts.length === 2) { c.lineTo(pts[1][0], pts[1][1]); return; }
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
      c.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
  }

  /** A hand-drawn stroke through `pts`: densified with smooth perpendicular wobble, Catmull-Rom
   *  smoothed like EngInk's ink. `corners` keeps each segment's endpoints sharp (radicals, brackets). */
  function inkStroke(c, pts, J, o = {}) {
    // o.calm: a smooth, deliberate stroke (brackets, arrowheads) — no wobble at all.
    // o.steady: a straight stroke that may bow a little but starts and ends exactly where aimed,
    // so something else (an arrowhead) can join it.
    const r = J.rng, wob = o.calm ? 0 : (o.wob == null ? 1 : o.wob) * J.mess * (o.steady ? 0.5 : 1);
    // endpoints wander a little, so nothing starts or ends exactly where it was aimed
    if (!o.steady) pts = pts.map(([px, py], i) => (i === 0 || i === pts.length - 1)
      ? [px + (r() - 0.5) * 2.2 * wob, py + (r() - 0.5) * 2.2 * wob] : [px, py]);
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const n = Math.max(2, Math.round(len / 12));
      const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
      // a hand never draws a straight line: a gentle bow across the whole segment, plus jitter
      const bow = (r() - 0.5) * Math.min(len * 0.05, 7) * wob;
      const seg = [];
      for (let j = 0; j <= n; j++) {
        const t = j / n, edge = j === 0 || j === n;
        const jit = o.steady ? 0 : (r() - 0.5) * Math.min(2.6, 0.6 + len * 0.014) * wob * (edge ? 0.3 : 1);
        const off = bow * Math.sin(Math.PI * t) + jit;
        seg.push([x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off]);
      }
      segs.push(seg);
    }
    c.save();
    c.strokeStyle = o.color || J.ink;
    c.lineWidth = o.width || 1;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    if (o.corners) segs.forEach((s, i) => traceSmooth(c, s, i > 0));
    else traceSmooth(c, segs.reduce((a, s, i) => a.concat(i ? s.slice(1) : s), []));
    c.stroke();
    c.restore();
  }

  function inkDot(c, x, y, rad, J) {
    const r = J.rng;
    c.save(); c.fillStyle = J.ink;
    c.beginPath(); c.arc(x + (r() - 0.5) * J.mess, y + (r() - 0.5) * J.mess, rad, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  // ---- boxes ---------------------------------------------------------------
  // A box is { w, h (above baseline), d (below), ld, draw(c, x, y, J) } with y = baseline.
  // `ld` is the depth line spacing has to clear: like d, except a letter's descender loop
  // (this font's g/y loops hang over a full em) is allowed to overlap the next line, as in real
  // handwriting, while structural depth (a fraction's denominator) is not.
  const kern = (w) => ({ w, h: 0, d: 0, ld: 0, draw() {} });
  const ldOf = (b) => (b.ld != null ? b.ld : b.d);

  function hlist(items) {
    let w = 0, h = 0, d = 0, ld = 0; const at = [];
    for (const b of items) { at.push(w); w += b.w; h = Math.max(h, b.h); d = Math.max(d, b.d); ld = Math.max(ld, ldOf(b)); }
    return { w, h, d, ld, draw(c, x, y, J) { items.forEach((b, i) => b.draw(c, x + at[i], y, J)); } };
  }

  /** Children at (dx, dy) — dy is UP-positive from the parent baseline. `extra` draws decorations. */
  function compose(w, kids, extra, min = {}) {
    kids = kids.filter(k => k && k.b);
    let h = min.h || 0, d = min.d || 0, ld = min.d || 0;
    for (const k of kids) { h = Math.max(h, k.dy + k.b.h); d = Math.max(d, k.b.d - k.dy); ld = Math.max(ld, ldOf(k.b) - k.dy); }
    return { w, h, d, ld, draw(c, x, y, J) { for (const k of kids) k.b.draw(c, x + k.dx, y - k.dy, J); if (extra) extra(c, x, y, J); } };
  }

  function scaleBox(b, s) {
    return { w: b.w * s, h: b.h * s, d: b.d * s, ld: ldOf(b) * s, draw(c, x, y, J) { c.save(); c.translate(x, y); c.scale(s, s); b.draw(c, 0, 0, J); c.restore(); } };
  }
  const colorBox = (b, ink) => (ink ? { ...b, draw(c, x, y, J) { b.draw(c, x, y, { ...J, ink }); } } : b);
  const hpad = (b, p) => hlist([kern(p), b, kern(p)]);

  /** One shaped text run (a word, or a run of math letters) — ligatures and contextual
   *  alternates happen here, inside a single fillText. */
  function runBox(text, fs, o = {}) {
    const m = measureRun(text, fs);
    const w = m.w + (o.bold ? 0.04 * fs : 0) + (o.bb ? 0.12 * fs : 0);
    return { w, h: m.h, d: m.d, ld: Math.min(m.d, 0.12 * fs), draw(c, x, y, J) { drawRun(c, text, fs, x, y, J, o, w, m); } };
  }

  function drawRun(c, text, fs, x, y, J, o, w, m) {
    const k = (o.jit == null ? 1 : o.jit) * J.mess, r = J.rng;
    // each word sits at its own slight angle (on top of its line's drift), bobs off the baseline
    // a little and varies a touch in size
    const dy = (r() - 0.5) * 0.12 * fs * k, sc = 1 + (r() - 0.5) * 0.08 * k;
    const rot = (r() - 0.5) * 0.075 * k;
    const ink = o.color || J.ink;
    const T = c.getTransform(), dev = Math.hypot(T.a, T.b); // page px → device px right now
    const g = glyphBitmap(text, fs, dev, o, ink, J.pen, m);
    c.save();
    c.translate(x, y + dy); c.rotate(rot); c.scale(sc, sc);
    if (o.slant) c.transform(1, 0, -0.2, 1, 0, 0);
    c.drawImage(g.canvas, g.x0, g.y0, g.w, g.h);
    c.restore();
    if (o.ul) inkStroke(c, [[x, y + 0.17 * fs], [x + w, y + 0.17 * fs]], J, { width: stemW(fs, J), color: ink });
  }

  /** A word rendered to its own bitmap with its strokes re-sized to the pen width: the font's
   *  strokes are M.stem·fs thick, so at any other size they're thinned (erosion) or thickened
   *  (dilation) by the difference. Works on pixels, not outlines, so overlapping contours in the
   *  font's ligatures can't open gaps. Cached — the same word at the same size is reused. */
  function glyphBitmap(text, fs, dev, o, ink, pen, m) {
    const s = Math.max(0.5, Math.round(dev * 4) / 4);
    const key = [text, fs.toFixed(2), s, ink, pen, o.bold ? 1 : 0, o.bb ? 1 : 0].join('|');
    let g = glyphCache.get(key);
    if (g) return g;
    const L = mcxLeft(text, fs);
    const pad = Math.max(2, pen, 0.2 * M.stem * fs) + 3; // room to thicken
    const x0 = -L - pad, y0 = -m.h - pad;
    const w = L + m.w + (o.bold ? 0.04 * fs : 0) + (o.bb ? 0.12 * fs : 0) + 2 * pad, h = m.h + m.d + 2 * pad;
    // Measure and correct on a supersampled copy (≥5 px per page px): at screen resolution a
    // stroke is only ~3 px wide, too coarse to see — or fix — a 20% difference.
    const S = Math.max(5, Math.ceil(s * 2));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(w * S)); cv.height = Math.max(1, Math.ceil(h * S));
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.setTransform(S, 0, 0, S, -x0 * S, -y0 * S);
    setText(cx, fs);
    cx.fillStyle = ink;
    cx.fillText(text, 0, 0);
    if (o.bold) cx.fillText(text, 0.04 * fs, 0);
    // blackboard bold the way it's hand-written (ℝ ℕ ℤ ℂ): the letter's left side drawn a second
    // time just to its right — a doubled stem — for whatever shape the font gives the letter
    if (o.bb) {
      cx.save();
      cx.beginPath(); cx.rect(-L - 1, -m.h - 4, (L + m.w) * 0.42 + 0.12 * fs, m.h + m.d + 8); cx.clip();
      cx.fillText(text, 0.12 * fs, 0);
      cx.restore();
    }
    // Measure THIS word's strokes (the font isn't uniform: its =, + and digits are drawn heavier than
    // its letters, its ligature words lighter), then remove (+) or add (−) the difference to the pen.
    // Thickening is capped at 30%: a full pen width would fill the counters of tiny script 2s and 0s.
    const t = strokeWidthPx(cx.getImageData(0, 0, cv.width, cv.height));
    const target = Math.min(pen * S, 1.3 * t);      // thicken by at most 30%, thin all the way
    let fixed = cv;
    if (t && Math.abs(t - target) >= 1) {
      // morph by half the difference per side, then check and correct once: erosion also eats the
      // antialiased edge by an amount that varies with the shape, so a fixed allowance can't be right
      let rad = Math.abs(t - target) / 2, best = Math.abs(t - target);
      const erode = t > target;
      for (let pass = 0; pass < 3; pass++) {
        const cand = morph(cv, Math.max(0.5, rad), erode);
        const got = strokeWidthPx(cand.getContext('2d').getImageData(0, 0, cand.width, cand.height));
        const miss = got - target;                  // + still too thick, − overshot
        if (Math.abs(miss) < best) { best = Math.abs(miss); fixed = cand; } // keep the closest attempt
        if (Math.abs(miss) < 0.8) break;
        rad = Math.max(0.5, rad + (erode ? miss : -miss) / 2);
      }
    }
    // scale down to the display resolution so the cache stays small
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.ceil(w * s)); out.height = Math.max(1, Math.ceil(h * s));
    const ox = out.getContext('2d');
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(fixed, 0, 0, out.width, out.height);
    g = { canvas: out, x0, y0, w: out.width / s, h: out.height / s, t: t / S };
    if (window.__hwDebug) g.after = strokeWidthPx(fixed.getContext('2d').getImageData(0, 0, fixed.width, fixed.height)) / S;
    if (glyphCache.size > 1500) glyphCache.delete(glyphCache.keys().next().value);
    glyphCache.set(key, g);
    return g;
  }

  /** Erode (AND of shifted copies) or dilate (OR of shifted copies) by a disc of radius `rad`. */
  function morph(src, rad, erode) {
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const o = out.getContext('2d');
    o.drawImage(src, 0, 0);
    o.globalCompositeOperation = erode ? 'destination-in' : 'source-over';
    const rings = [];
    for (let rr = rad; rr >= 0.5 && rings.length < 5; rr /= 2) rings.push(rr);
    for (const rr of erode ? rings.slice(0, 1) : rings) {
      const n = Math.min(40, Math.max(12, Math.ceil(rr * 2 * Math.PI / 1.5))); // ≤1.5 px between samples
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        o.drawImage(src, Math.cos(a) * rr, Math.sin(a) * rr);
      }
    }
    return out;
  }

  function textBox(t, fs, o) {
    const clean = t.replace(/\\([%$&#_{}])/g, '$1').replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}]/g, '').replace(/~/g, ' ');
    const parts = clean.split(/(\s+)/).filter(Boolean);
    return hlist(parts.map(p => (/^\s+$/.test(p) ? kern(M.space * fs) : runBox(p, fs, o))));
  }

  function minusBox(fs) {
    const w = (measureRun('+', fs).w || 0.5 * fs) + 0.04 * fs, ax = M.axis * fs;
    return { w, h: ax + 0.05 * fs, d: 0, draw(c, x, y, J) { inkStroke(c, [[x + 0.12 * w, y - ax], [x + 0.88 * w, y - ax]], J, { width: stemW(fs, J) }); } };
  }

  function dotsBox(type, fs) {
    const ax = M.axis * fs, rad = (J) => stemW(fs, J) * 0.62;
    const dot = (pts, w, h, d, big = 1) => ({ w, h, d, draw(c, x, y, J) { for (const [px, py] of pts) inkDot(c, x + px, y - py, rad(J) * big, J); } });
    const W = 1.0 * fs;
    switch (type) {
      case 'cdot': return dot([[0.18 * fs, ax]], 0.36 * fs, ax + 0.05 * fs, 0);
      case 'bullet': return dot([[0.22 * fs, ax]], 0.44 * fs, ax + 0.1 * fs, 0, 1.8);
      case 'cdots': return dot([0.2, 0.5, 0.8].map(t => [t * W, ax]), W, ax + 0.05 * fs, 0);
      case 'vdots': return dot([0.1, 0.4, 0.7].map(t => [0.18 * fs, t * fs]), 0.36 * fs, 0.75 * fs, 0);
      case 'ddots': return dot([[0.2 * W, 0.7 * fs], [0.5 * W, 0.4 * fs], [0.8 * W, 0.1 * fs]], W, 0.75 * fs, 0);
      default: return dot([0.2, 0.5, 0.8].map(t => [t * W, 0.03 * fs]), W, 0.08 * fs, 0); // ldots
    }
  }

  function arrowBox(spec, fs, minW = 0) {
    const ax = M.axis * fs, hs = 0.17 * fs;
    if (spec.d === 'u' || spec.d === 'd') {
      const w = 0.5 * fs, top = 0.75 * fs, bot = -0.1 * fs;
      return { w, h: top, d: -bot, draw(c, x, y, J) {
        const cx = x + w / 2, ty = y - top, by = y - bot, sw = stemW(fs, J);
        inkStroke(c, [[cx, by], [cx, ty]], J, { width: sw, steady: true });
        const tip = spec.d === 'u' ? ty : by, s = spec.d === 'u' ? 1 : -1;
        inkStroke(c, [[cx - hs * 0.65, tip + s * hs], [cx, tip], [cx + hs * 0.65, tip + s * hs]], J, { width: sw, corners: true, calm: true });
      } };
    }
    // Every arrow (→, ⟹, ⇔, ↦…) is written the way a hand writes it: one shaft and one head per
    // pointing end — no double shaft. The shaft starts and ends exactly at the tips (steady) and the
    // head is drawn from that same tip, so even very messy writing never splits head from shaft.
    const w = Math.max(minW, (spec.long ? 1.6 : 1.05) * fs);
    return { w, h: ax + hs, d: 0, draw(c, x, y, J) {
      const sw = stemW(fs, J), x0 = x + 0.06 * fs, x1 = x + w - 0.06 * fs, yy = y - ax;
      const head = spec.dbl ? hs * 1.15 : hs;
      inkStroke(c, [[x0, yy], [x1, yy]], J, { width: sw, steady: true });
      const barb = (tx, dir) => inkStroke(c, [[tx - dir * head, yy - head * 0.62], [tx, yy], [tx - dir * head, yy + head * 0.62]], J, { width: sw, corners: true, calm: true });
      if (spec.d === 'r' || spec.d === 'lr') barb(x1, 1);
      if (spec.d === 'l' || spec.d === 'lr') barb(x0, -1);
      if (spec.bar) inkStroke(c, [[x0, yy - 0.15 * fs], [x0, yy + 0.15 * fs]], J, { width: sw, calm: true });
    } };
  }

  function fracBox(num, den, fs, disp, bar = true) {
    const ax = M.axis * fs, t = M.stem * fs, gap = (disp ? 0.16 : 0.1) * fs + (bar ? 0 : 0.08 * fs), pad = 0.1 * fs;
    const w = Math.max(num.w, den.w) + 2 * pad;
    const nDy = ax + t / 2 + gap + num.d, dDy = ax - t / 2 - gap - den.h;
    return compose(w, [{ b: num, dx: (w - num.w) / 2, dy: nDy }, { b: den, dx: (w - den.w) / 2, dy: dDy }],
      bar ? (c, x, y, J) => inkStroke(c, [[x + 0.03 * fs, y - ax], [x + w - 0.03 * fs, y - ax + (J.rng() - 0.5) * 1.5 * J.mess]], J, { width: stemW(fs, J) }) : null);
  }

  function sqrtBox(body, index, fs) {
    const pad = 0.14 * fs, t = M.stem * fs;
    const top = Math.max(body.h, M.xh * fs) + pad, bot = Math.max(body.d, 0.05 * fs) + 0.04 * fs, H = top + bot;
    const hook = 0.36 * fs + 0.06 * H;
    const lead = index ? Math.max(0, index.w - hook * 0.4) : 0;
    const w = lead + hook + body.w + 0.18 * fs;
    const kids = [{ b: body, dx: lead + hook + 0.06 * fs, dy: 0 }];
    if (index) kids.push({ b: index, dx: 0, dy: -bot + 0.52 * H + index.d + 0.04 * fs });
    return compose(w, kids, (c, x, y, J) => {
      const X = x + lead;
      inkStroke(c, [[X, y + bot - 0.38 * H], [X + 0.16 * hook, y + bot - 0.46 * H], [X + 0.45 * hook, y + bot], [X + hook, y - top], [x + w - 0.04 * fs, y - top]], J, { width: stemW(fs, J), corners: true });
    }, { h: top + t, d: bot + t / 2 });
  }

  function scriptsBox(base, sup, sub, fs, isInt) {
    let up = 0, dn = 0;
    if (sup) up = Math.max(base.h - 0.26 * fs, 0.4 * fs);
    if (sub) dn = Math.max(ldOf(base) + 0.08 * fs, 0.17 * fs); // a letter's loop doesn't push the subscript down
    if (sup && sub) {
      const g = (up - sup.d) - (sub.h - dn), min = 0.12 * fs;
      if (g < min) { up += (min - g) / 2; dn += (min - g) / 2; }
    }
    const supDx = base.w + 0.03 * fs + (isInt ? 0.04 * fs : 0);
    const subDx = isInt ? base.w * 0.62 : base.w + 0.01 * fs;
    const w = Math.max(base.w, sup ? supDx + sup.w : 0, sub ? subDx + sub.w : 0) + 0.04 * fs;
    return compose(w, [{ b: base, dx: 0, dy: 0 }, sup && { b: sup, dx: supDx, dy: up }, sub && { b: sub, dx: subDx, dy: -dn }]);
  }

  function limitsBox(base, sup, sub, fs) {
    const gap = 0.1 * fs, w = Math.max(base.w, sup ? sup.w : 0, sub ? sub.w : 0);
    return compose(w, [
      { b: base, dx: (w - base.w) / 2, dy: 0 },
      sup && { b: sup, dx: (w - sup.w) / 2, dy: base.h + gap + sup.d },
      sub && { b: sub, dx: (w - sub.w) / 2, dy: -(base.d + gap + sub.h) },
    ]);
  }

  function bigOpBox(sym, fs, k) {
    if (sym === '∬' || sym === '∭') {
      const one = bigOpBox('∫', fs, k), n = sym === '∬' ? 2 : 3, step = one.w * 0.55;
      return compose(one.w + step * (n - 1), Array.from({ length: n }, (_, i) => ({ b: one, dx: i * step, dy: 0 })));
    }
    if (sym === '∮') {
      const one = bigOpBox('∫', fs, k), ax = M.axis * fs, rr = 0.16 * fs * k;
      return compose(one.w, [{ b: one, dx: 0, dy: 0 }], (c, x, y, J) => {
        const cx = x + one.w / 2, cy = y - ax;
        inkStroke(c, Array.from({ length: 13 }, (_, i) => [cx + rr * Math.cos(i / 12 * Math.PI * 2), cy + rr * 0.85 * Math.sin(i / 12 * Math.PI * 2)]), J, { width: stemW(fs, J) * 0.9 });
      });
    }
    const g = runBox(sym, fs * k, { jit: 0.4 });
    const dy = M.axis * fs - (g.h - g.d) / 2;
    return compose(g.w + 0.06 * fs, [{ b: g, dx: 0.03 * fs, dy }]);
  }

  // Delimiters: the font's own glyph at normal height, hand-drawn strokes when they must stretch.
  const DRAWN_ONLY = new Set(['⌊', '⌋', '⌈', '⌉', '‖', '⟨', '⟩']);
  function delimBox(ch, h, d, fs) {
    if (!ch || ch === '.') return kern(0.05 * fs);
    const ax = M.axis * fs, ext = Math.max(h - ax, d + ax) + 0.06 * fs;
    const normal = (M.cap + M.desc) * fs * 1.12;
    if (2 * ext <= normal && !DRAWN_ONLY.has(ch)) return runBox(ch, fs, { jit: 0.4 });
    return drawnDelim(ch, Math.max(ext, normal / 2), fs);
  }

  function drawnDelim(ch, ext, fs) {
    const H = 2 * ext, ax = M.axis * fs;
    const base = { '(': 0.3, ')': 0.3, '[': 0.28, ']': 0.28, '{': 0.38, '}': 0.38, '|': 0.2, '‖': 0.32, '⟨': 0.32, '⟩': 0.32, '⌊': 0.28, '⌋': 0.28, '⌈': 0.28, '⌉': 0.28, '/': 0.4, '\\': 0.4 }[ch] || 0.3;
    const w = base * fs + Math.min(0.12 * fs, H * 0.03);
    return { w, h: ax + ext, d: ext - ax, draw(c, x, y, J) {
      const top = y - ax - ext, bot = y - ax + ext, mid = y - ax, sw = stemW(fs, J);
      const X = (f) => x + w * f, Y = (f) => top + H * f;
      const arc = (from, to) => Array.from({ length: 9 }, (_, i) => { const t = i / 8; return [X(from + (to - from) * Math.sin(Math.PI * t)), Y(t)]; });
      // brackets are drawn in one deliberate sweep: smooth, never wobbly
      const S = (pts, corners) => inkStroke(c, pts, J, { width: sw, corners, calm: true });
      switch (ch) {
        case '(': S(arc(0.85, 0.2)); break;
        case ')': S(arc(0.15, 0.8)); break;
        case '[': S([[X(0.8), top], [X(0.25), top], [X(0.25), bot], [X(0.8), bot]], true); break;
        case ']': S([[X(0.2), top], [X(0.75), top], [X(0.75), bot], [X(0.2), bot]], true); break;
        case '{': S([[X(0.9), top], [X(0.5), Y(0.1)], [X(0.5), Y(0.4)], [X(0.12), mid], [X(0.5), Y(0.6)], [X(0.5), Y(0.9)], [X(0.9), bot]]); break;
        case '}': S([[X(0.1), top], [X(0.5), Y(0.1)], [X(0.5), Y(0.4)], [X(0.88), mid], [X(0.5), Y(0.6)], [X(0.5), Y(0.9)], [X(0.1), bot]]); break;
        case '‖': S([[X(0.3), top], [X(0.3), bot]]); S([[X(0.7), top], [X(0.7), bot]]); break;
        case '⟨': S([[X(0.8), top], [X(0.2), mid], [X(0.8), bot]], true); break;
        case '⟩': S([[X(0.2), top], [X(0.8), mid], [X(0.2), bot]], true); break;
        case '⌊': S([[X(0.25), top], [X(0.25), bot], [X(0.8), bot]], true); break;
        case '⌋': S([[X(0.75), top], [X(0.75), bot], [X(0.2), bot]], true); break;
        case '⌈': S([[X(0.8), top], [X(0.25), top], [X(0.25), bot]], true); break;
        case '⌉': S([[X(0.2), top], [X(0.75), top], [X(0.75), bot]], true); break;
        case '/': S([[X(0.85), top], [X(0.15), bot]]); break;
        case '\\': S([[X(0.15), top], [X(0.85), bot]]); break;
        default: S([[X(0.5), top], [X(0.5), bot]]); // |
      }
    } };
  }

  function accentBox(type, body, fs) {
    const w = body.w, top = body.h;
    const S = (c, J, x, y, pts, corners, more) => inkStroke(c, pts.map(([px, py]) => [x + px, y - py]), J, { width: stemW(fs, J), corners, ...more });
    const span = (minW) => { const ww = Math.max(w * 0.64, minW); return [(w - ww) / 2, (w + ww) / 2]; };
    let draw = null, h = body.h, d = body.d;
    switch (type) {
      case 'bar': case 'overline': {
        const yy = top + 0.12 * fs, [a, b] = type === 'bar' ? span(0.32 * fs) : [0, w];
        draw = (c, x, y, J) => S(c, J, x, y, [[a, yy], [b, yy]]); h = yy + 0.06 * fs; break;
      }
      case 'underline': {
        const yy = -(body.d + 0.12 * fs);
        draw = (c, x, y, J) => S(c, J, x, y, [[0, yy], [w, yy]]); d = -yy + 0.06 * fs; break;
      }
      case 'vec': case 'overrightarrow': case 'overleftarrow': {
        const yy = top + 0.16 * fs, hs = 0.11 * fs, [a, b] = type === 'vec' ? span(0.38 * fs) : [0, w];
        draw = (c, x, y, J) => {
          S(c, J, x, y, [[a, yy], [b, yy]], false, { steady: true }); // head joins the shaft's exact tip
          if (type === 'overleftarrow') S(c, J, x, y, [[a + hs, yy + hs * 0.7], [a, yy], [a + hs, yy - hs * 0.7]], true, { calm: true });
          else S(c, J, x, y, [[b - hs, yy + hs * 0.7], [b, yy], [b - hs, yy - hs * 0.7]], true, { calm: true });
        };
        h = yy + hs; break;
      }
      case 'hat': case 'widehat': case 'check': {
        const yb = top + 0.08 * fs, ht = (type === 'widehat' ? 0.2 : 0.15) * fs, [a, b] = span(0.34 * fs), m = (a + b) / 2;
        draw = (c, x, y, J) => S(c, J, x, y, type === 'check' ? [[a, yb + ht], [m, yb], [b, yb + ht]] : [[a, yb], [m, yb + ht], [b, yb]], true);
        h = yb + ht + 0.05 * fs; break;
      }
      case 'tilde': case 'widetilde': {
        const yb = top + 0.14 * fs, amp = 0.05 * fs, [a, b] = span(0.4 * fs);
        draw = (c, x, y, J) => S(c, J, x, y, Array.from({ length: 7 }, (_, i) => [a + (b - a) * i / 6, yb + amp * Math.sin(i / 6 * Math.PI * 2)]));
        h = yb + amp * 2; break;
      }
      case 'acute': case 'grave': {
        const yb = top + 0.08 * fs, m = w / 2;
        draw = (c, x, y, J) => S(c, J, x, y, type === 'acute' ? [[m - 0.04 * fs, yb], [m + 0.1 * fs, yb + 0.16 * fs]] : [[m + 0.04 * fs, yb], [m - 0.1 * fs, yb + 0.16 * fs]]);
        h = yb + 0.18 * fs; break;
      }
      case 'breve': {
        const yb = top + 0.08 * fs, [a, b] = span(0.3 * fs);
        draw = (c, x, y, J) => S(c, J, x, y, Array.from({ length: 7 }, (_, i) => [a + (b - a) * i / 6, yb + 0.12 * fs - 0.12 * fs * Math.sin(i / 6 * Math.PI)]));
        h = yb + 0.14 * fs; break;
      }
      case 'dot': case 'ddot': {
        const yy = top + 0.16 * fs, xs = type === 'dot' ? [w / 2] : [w / 2 - 0.1 * fs, w / 2 + 0.1 * fs];
        draw = (c, x, y, J) => xs.forEach(px => inkDot(c, x + px, y - yy, stemW(fs, J) * 0.6, J));
        h = yy + 0.06 * fs; break;
      }
      case 'overbrace': case 'underbrace': {
        const over = type === 'overbrace', hb = 0.18 * fs, y0 = over ? top + 0.1 * fs : -(body.d + 0.1 * fs), s = over ? 1 : -1, e = Math.min(0.12 * fs, w * 0.1);
        draw = (c, x, y, J) => S(c, J, x, y, [[0, y0], [e, y0 + s * hb * 0.5], [w / 2 - e, y0 + s * hb * 0.5], [w / 2, y0 + s * hb], [w / 2 + e, y0 + s * hb * 0.5], [w - e, y0 + s * hb * 0.5], [w, y0]]);
        if (over) h = y0 + hb + 0.04 * fs; else d = -y0 + hb + 0.04 * fs;
        break;
      }
      default: break;
    }
    return compose(w, [{ b: body, dx: 0, dy: 0 }], draw, { h, d });
  }

  function boxedBox(body, fs) {
    const pad = 0.2 * fs, w = body.w + 2 * pad, h = body.h + pad, d = body.d + pad;
    return compose(w + 0.1 * fs, [{ b: body, dx: pad + 0.05 * fs, dy: 0 }], (c, x, y, J) => {
      const L = x + 0.05 * fs, R = L + w;
      inkStroke(c, [[L, y - h], [R, y - h], [R, y + d], [L, y + d], [L, y - h + 1]], J, { width: stemW(fs, J), corners: true });
    }, { h: h + 2, d: d + 2 });
  }

  function cancelBox(body, fs, type) {
    return compose(body.w, [{ b: body, dx: 0, dy: 0 }], (c, x, y, J) => {
      const L = x - 0.04 * fs, R = x + body.w + 0.04 * fs, T = y - body.h - 0.04 * fs, B = y + body.d + 0.04 * fs, sw = stemW(fs, J);
      if (type !== 'bcancel') inkStroke(c, [[L, B], [R, T]], J, { width: sw });
      if (type === 'bcancel' || type === 'xcancel') inkStroke(c, [[L, T], [R, B]], J, { width: sw });
    });
  }

  // ---- LaTeX source cursor helpers -------------------------------------------
  function skipWs(p) { while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i++; }
  function readBraced(p) { // p.s[p.i] === '{'
    let depth = 0; const start = p.i + 1;
    for (let i = p.i; i < p.s.length; i++) {
      const c = p.s[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { p.i = i + 1; return p.s.slice(start, i); }
    }
    p.i = p.s.length; return p.s.slice(start);
  }
  function readArg(p) {
    skipWs(p);
    const c = p.s[p.i];
    if (c === undefined) return '';
    if (c === '{') return readBraced(p);
    if (c === '\\') { const m = /^\\([a-zA-Z]+|.)/.exec(p.s.slice(p.i)); p.i += m[0].length; return m[0]; }
    p.i++; return c;
  }
  function readOpt(p) {
    const save = p.i; skipWs(p);
    if (p.s[p.i] !== '[') { p.i = save; return null; }
    let depth = 0;
    for (let i = p.i + 1; i < p.s.length; i++) {
      const c = p.s[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') depth++; else if (c === '}') depth--;
      else if (c === ']' && depth === 0) { const v = p.s.slice(p.i + 1, i); p.i = i + 1; return v; }
    }
    p.i = save; return null;
  }
  function readEnvBody(p, name) {
    const open = '\\begin{' + name + '}', close = '\\end{' + name + '}';
    let depth = 1, i = p.i;
    while (i < p.s.length) {
      const a = p.s.indexOf(open, i), b = p.s.indexOf(close, i);
      if (b < 0) break;
      if (a >= 0 && a < b) { depth++; i = a + open.length; continue; }
      if (--depth === 0) { const body = p.s.slice(p.i, b); p.i = b + close.length; return body; }
      i = b + close.length;
    }
    const body = p.s.slice(p.i); p.i = p.s.length; return body;
  }
  function readUntilRight(p) {
    const re = /\\(left|right)(?![a-zA-Z])/g; re.lastIndex = p.i;
    let depth = 1, m;
    while ((m = re.exec(p.s))) {
      if (m[1] === 'left') depth++;
      else if (--depth === 0) { const body = p.s.slice(p.i, m.index); p.i = m.index + m[0].length; return body; }
    }
    const body = p.s.slice(p.i); p.i = p.s.length; return body;
  }
  /** Split at top level (outside braces and nested environments): mode 'row' on \\, 'cell' on &. */
  function splitTop(s, mode) {
    const parts = []; let depth = 0, env = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        // skip the whole \begin{name} / \end{name} so the name's own braces aren't counted as depth
        if (s.startsWith('\\begin{', i)) { env++; i = Math.max(i, s.indexOf('}', i)); continue; }
        if (s.startsWith('\\end{', i)) { env--; i = Math.max(i, s.indexOf('}', i)); continue; }
        if (s[i + 1] === '\\' && mode === 'row' && !depth && !env) {
          parts.push(s.slice(start, i)); i += 1;
          const m = /^\s*\[[^\]]*\]/.exec(s.slice(i + 1)); if (m) i += m[0].length;
          start = i + 1; continue;
        }
        i++; continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '&' && mode === 'cell' && !depth && !env) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    parts.push(s.slice(start));
    return mode === 'row' ? parts.filter(x => x.trim()) : parts;
  }

  const NAMED_COLORS = { red: '#C62828', blue: '#1E40AF', green: '#2E7D32', orange: '#E65100', purple: '#6A1B9A', violet: '#6A1B9A', magenta: '#AD1457', cyan: '#00838F', teal: '#00695C', brown: '#6D4C41', gray: '#616161', grey: '#616161', black: '#1F2329', darkgray: '#424242', lightgray: '#9E9E9E', olive: '#827717', pink: '#D81B60', lime: '#689F38', yellow: '#B8860B', white: '#FFFFFF' };
  function cssColor(name, model) {
    const v = (name || '').trim();
    if (model && /^html$/i.test(model)) return '#' + v.replace(/^#/, '');
    if (model && /^rgb$/i.test(model)) { const n = v.split(',').map(Number); return `rgb(${n.map(x => Math.round((x > 1 ? x / 255 : x) * 255)).join(',')})`; }
    const key = v.split('!')[0].toLowerCase();
    return NAMED_COLORS[key] || key || null;
  }

  // ---- math parsing ----------------------------------------------------------
  const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω' };
  const SYMS = {
    infty: ['∞', 'ord'], partial: ['∂', 'ord'], nabla: ['∇', 'ord'], hbar: ['ℏ', 'ord'], ell: ['ℓ', 'ord'], emptyset: ['∅', 'ord'], varnothing: ['∅', 'ord'], forall: ['∀', 'ord'], exists: ['∃', 'ord'], neg: ['¬', 'ord'], lnot: ['¬', 'ord'], angle: ['∠', 'ord'], triangle: ['△', 'ord'], degree: ['°', 'ord'], prime: ['′', 'ord'], dagger: ['†', 'ord'], aleph: ['ℵ', 'ord'], Re: ['ℜ', 'ord'], Im: ['ℑ', 'ord'], top: ['⊤', 'ord'], bot: ['⊥', 'ord'], surd: ['√', 'ord'], checkmark: ['✓', 'ord'], backslash: ['\\', 'ord'],
    pm: ['±', 'bin'], mp: ['∓', 'bin'], times: ['×', 'bin'], div: ['÷', 'bin'], cup: ['∪', 'bin'], cap: ['∩', 'bin'], wedge: ['∧', 'bin'], land: ['∧', 'bin'], vee: ['∨', 'bin'], lor: ['∨', 'bin'], oplus: ['⊕', 'bin'], otimes: ['⊗', 'bin'], setminus: ['∖', 'bin'], ast: ['*', 'bin'], star: ['⋆', 'bin'], circ: ['∘', 'bin'],
    leq: ['≤', 'rel'], le: ['≤', 'rel'], leqslant: ['≤', 'rel'], geq: ['≥', 'rel'], ge: ['≥', 'rel'], geqslant: ['≥', 'rel'], neq: ['≠', 'rel'], ne: ['≠', 'rel'], approx: ['≈', 'rel'], equiv: ['≡', 'rel'], sim: ['∼', 'rel'], simeq: ['≃', 'rel'], cong: ['≅', 'rel'], propto: ['∝', 'rel'], in: ['∈', 'rel'], notin: ['∉', 'rel'], ni: ['∋', 'rel'], subset: ['⊂', 'rel'], supset: ['⊃', 'rel'], subseteq: ['⊆', 'rel'], supseteq: ['⊇', 'rel'], perp: ['⊥', 'rel'], parallel: ['∥', 'rel'], mid: ['|', 'rel'], ll: ['≪', 'rel'], gg: ['≫', 'rel'], coloneqq: [':=', 'rel'], to: ['→', 'rel'], rightarrow: ['→', 'rel'],
    lbrace: ['{', 'open'], rbrace: ['}', 'close'], langle: ['⟨', 'open'], rangle: ['⟩', 'close'], lfloor: ['⌊', 'open'], rfloor: ['⌋', 'close'], lceil: ['⌈', 'open'], rceil: ['⌉', 'close'], vert: ['|', 'ord'], Vert: ['‖', 'ord'], lvert: ['|', 'open'], rvert: ['|', 'close'], lVert: ['‖', 'open'], rVert: ['‖', 'close'],
    '{': ['{', 'open'], '}': ['}', 'close'], '|': ['‖', 'ord'], '%': ['%', 'ord'], '$': ['$', 'ord'], '#': ['#', 'ord'], '&': ['&', 'ord'], '_': ['_', 'ord'],
  };
  const ARROWS = { gets: { d: 'l' }, leftarrow: { d: 'l' }, leftrightarrow: { d: 'lr' }, Rightarrow: { d: 'r', dbl: 1 }, implies: { d: 'r', dbl: 1, long: 1 }, Leftarrow: { d: 'l', dbl: 1 }, impliedby: { d: 'l', dbl: 1, long: 1 }, Leftrightarrow: { d: 'lr', dbl: 1 }, iff: { d: 'lr', dbl: 1, long: 1 }, longrightarrow: { d: 'r', long: 1 }, longleftarrow: { d: 'l', long: 1 }, longleftrightarrow: { d: 'lr', long: 1 }, Longrightarrow: { d: 'r', dbl: 1, long: 1 }, Longleftarrow: { d: 'l', dbl: 1, long: 1 }, mapsto: { d: 'r', bar: 1 }, longmapsto: { d: 'r', bar: 1, long: 1 }, uparrow: { d: 'u' }, downarrow: { d: 'd' }, rightharpoonup: { d: 'r' }, leftharpoonup: { d: 'l' } };
  const BIGOPS = { sum: '∑', prod: '∏', coprod: '∐', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigvee: '⋁', bigwedge: '⋀', int: '∫', iint: '∬', iiint: '∭', oint: '∮' };
  const INTEGRALS = new Set(['∫', '∬', '∭', '∮']);
  const OPNAMES = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'deg', 'gcd', 'arg', 'dim', 'ker', 'hom', 'Pr', 'tr', 'sgn', 'argmax', 'argmin']);
  const LIMOPS = new Set(['lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'Pr', 'argmax', 'argmin']);
  const SPACES = { ',': 1 / 6, ':': 2 / 9, '>': 2 / 9, ';': 5 / 18, '!': -1 / 6, ' ': 1 / 3, quad: 1, qquad: 2, enspace: 0.5, thinspace: 1 / 6, medspace: 2 / 9, thickspace: 5 / 18, negthinspace: -1 / 6, negmedspace: -2 / 9, negthickspace: -5 / 18 };
  const DELIM_CMDS = { '{': '{', '}': '}', '|': '‖', langle: '⟨', rangle: '⟩', lbrace: '{', rbrace: '}', vert: '|', lvert: '|', rvert: '|', Vert: '‖', lVert: '‖', rVert: '‖', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', backslash: '\\' };
  const MATRIX_DELIMS = { pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', '.'], dcases: ['{', '.'], rcases: ['.', '}'] };
  const ACCENTS = new Set(['vec', 'hat', 'widehat', 'bar', 'overline', 'dot', 'ddot', 'tilde', 'widetilde', 'underline', 'overrightarrow', 'overleftarrow', 'check', 'breve', 'acute', 'grave', 'overbrace', 'underbrace']);

  function parseMath(src) { return mathList({ s: src || '', i: 0 }); }

  function mathList(p) {
    const atoms = [];
    while (p.i < p.s.length) {
      const ch = p.s[p.i];
      if (ch === '}' || ch === '&' || /\s/.test(ch)) { p.i++; continue; }
      if (ch === '^' || ch === '_') { p.i++; attachScript(atoms, ch, parseMath(readArg(p))); continue; }
      if (ch === "'") { let n = 0; while (p.s[p.i] === "'") { n++; p.i++; } atoms.push({ k: 'ch', t: '′'.repeat(n), cls: 'ord' }); continue; }
      if (ch === '{') { atoms.push({ k: 'group', list: parseMath(readBraced(p)) }); continue; }
      if (ch === '~') { p.i++; atoms.push({ k: 'space', em: 1 / 3 }); continue; }
      if (ch === '\\') { const a = mathCommand(p, atoms); if (a) atoms.push(a); continue; }
      p.i++;
      atoms.push(charAtom(ch));
    }
    return atoms;
  }

  function attachScript(atoms, kind, list) {
    let last = atoms[atoms.length - 1];
    if (!last || last.k === 'space') { last = { k: 'group', list: [] }; atoms.push(last); }
    if (last.k !== 'scripts' || (kind === '^' ? last.sup : last.sub)) {
      last = { k: 'scripts', base: last, sup: null, sub: null };
      atoms[atoms.length - 1] = last;
    }
    if (kind === '^') last.sup = list; else last.sub = list;
  }

  function charAtom(ch) {
    if (/[A-Za-z]/.test(ch)) return { k: 'ch', t: ch, grp: 'L', cls: 'ord' };
    if (/[0-9.]/.test(ch)) return { k: 'ch', t: ch, grp: 'D', cls: 'ord' };
    if (ch === '-' || ch === '−') return { k: 'minus', cls: 'bin' };
    if (BIGOPS_CHARS.has(ch)) return { k: 'op', sym: ch, limits: !INTEGRALS.has(ch) };
    if ('+*×÷±·'.includes(ch)) return { k: 'ch', t: ch, cls: 'bin' };
    if ('=<>≤≥≠≈→:'.includes(ch)) return { k: 'ch', t: ch, cls: 'rel' };
    if ('(['.includes(ch)) return { k: 'ch', t: ch, cls: 'open' };
    if (')]'.includes(ch)) return { k: 'ch', t: ch, cls: 'close' };
    if (',;'.includes(ch)) return { k: 'ch', t: ch, cls: 'punct' };
    return { k: 'ch', t: ch, cls: 'ord' };
  }
  const BIGOPS_CHARS = new Set(Object.values(BIGOPS));

  function readDelim(p) {
    skipWs(p);
    if (p.s[p.i] === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(p.s.slice(p.i)); p.i += m[0].length;
      return DELIM_CMDS[m[1]] || '.';
    }
    const c = p.s[p.i]; p.i++;
    return c === '<' ? '⟨' : c === '>' ? '⟩' : (c || '.');
  }

  function lenToEm(v) {
    const m = /(-?[\d.]+)\s*(em|ex|pt|mm|cm|in|mu)?/.exec(v || '');
    if (!m) return 1;
    const n = parseFloat(m[1]);
    return n * ({ em: 1, ex: 0.45, pt: 0.1, mm: 0.28, cm: 2.8, in: 7.2, mu: 1 / 18 }[m[2] || 'em']);
  }

  function mathCommand(p, atoms) {
    const m = /^\\([a-zA-Z]+|.)/.exec(p.s.slice(p.i)) || ['\\', ''];
    p.i += m[0].length;
    const n = m[1];
    if (GREEK[n]) return { k: 'ch', t: GREEK[n], cls: 'ord' };
    if (SYMS[n]) return { k: 'ch', t: SYMS[n][0], cls: SYMS[n][1] };
    if (ARROWS[n]) return { k: 'arrow', spec: ARROWS[n] };
    if (BIGOPS[n]) return { k: 'op', sym: BIGOPS[n], limits: !INTEGRALS.has(BIGOPS[n]) };
    if (OPNAMES.has(n)) return { k: 'opname', t: n === 'limsup' ? 'lim sup' : n === 'liminf' ? 'lim inf' : n, limits: LIMOPS.has(n) };
    if (SPACES[n] != null) return { k: 'space', em: SPACES[n] };
    const big = /^(big|Big|bigg|Bigg)([lrm]?)$/.exec(n);
    if (big) return { k: 'bigdelim', ch: readDelim(p), scale: { big: 1.25, Big: 1.65, bigg: 2.1, Bigg: 2.6 }[big[1]], cls: big[2] === 'l' ? 'open' : big[2] === 'r' ? 'close' : 'ord' };
    if (ACCENTS.has(n)) return { k: 'accent', type: n, body: parseMath(readArg(p)) };
    switch (n) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac':
        return { k: 'frac', num: parseMath(readArg(p)), den: parseMath(readArg(p)), force: n === 'dfrac' || n === 'cfrac' ? 'd' : n === 'tfrac' ? 't' : null };
      case 'binom': case 'dbinom': case 'tbinom':
        return { k: 'frac', num: parseMath(readArg(p)), den: parseMath(readArg(p)), nobar: true, delims: true, force: n === 'dbinom' ? 'd' : n === 'tbinom' ? 't' : null };
      case 'sqrt': { const idx = readOpt(p); return { k: 'sqrt', index: idx != null ? parseMath(idx) : null, body: parseMath(readArg(p)) }; }
      case 'text': case 'textrm': case 'mbox': case 'textnormal': case 'textup': case 'hbox': case 'textsf': case 'texttt':
        return { k: 'text', t: readArg(p) };
      case 'textbf': return { k: 'text', t: readArg(p), bold: true };
      case 'textit': case 'emph': return { k: 'text', t: readArg(p), slant: true };
      case 'mathrm': case 'mathup': return { k: 'ch', t: readArg(p).replace(/[{}\s]|\\[,;: ]/g, ''), cls: 'ord' };
      case 'operatorname': {
        const star = p.s[p.i] === '*' ? (p.i++, true) : false;
        return { k: 'opname', t: readArg(p).replace(/\\[,;: ]|~/g, ' ').replace(/[{}]/g, ''), limits: star };
      }
      case 'mathbf': case 'boldsymbol': case 'bm': case 'pmb': return { k: 'group', list: parseMath(readArg(p)), bold: true };
      case 'mathbb': case 'Bbb': return { k: 'group', list: parseMath(readArg(p)), bb: true };
      case 'mathcal': case 'mathscr': case 'mathit': case 'mathsf': case 'mathtt': case 'mathfrak': case 'mathnormal':
        return { k: 'group', list: parseMath(readArg(p)) };
      case 'left': { const l = readDelim(p); const body = readUntilRight(p); const r = readDelim(p); return { k: 'leftright', l, r, body: parseMath(body) }; }
      case 'right': readDelim(p); return null;
      case 'middle': return { k: 'ch', t: readDelim(p).replace('.', '') || '|', cls: 'rel' };
      case 'overset': case 'stackrel': { const top = parseMath(readArg(p)); return { k: 'stack', top, base: parseMath(readArg(p)), rel: n === 'stackrel' }; }
      case 'underset': { const bot = parseMath(readArg(p)); return { k: 'stack', bot, base: parseMath(readArg(p)) }; }
      case 'xrightarrow': case 'xleftarrow': { const bot = readOpt(p); return { k: 'stack', top: parseMath(readArg(p)), bot: bot ? parseMath(bot) : null, arrow: { d: n === 'xrightarrow' ? 'r' : 'l', long: 1 }, rel: true }; }
      case 'boxed': return { k: 'boxed', body: parseMath(readArg(p)) };
      case 'fbox': return { k: 'boxed', body: [{ k: 'text', t: readArg(p) }] };
      case 'cancel': case 'bcancel': case 'xcancel': return { k: 'cancel', type: n, body: parseMath(readArg(p)) };
      case 'phantom': case 'hphantom': case 'vphantom': return { k: 'phantom', type: n, body: parseMath(readArg(p)) };
      case 'displaystyle': return { k: 'style', disp: true };
      case 'textstyle': return { k: 'style', disp: false };
      case 'scriptstyle': return { k: 'style', disp: false, scale: 0.7 };
      case 'color': { const model = readOpt(p); const col = cssColor(readArg(p), model); return { k: 'group', list: mathList(p), color: col }; }
      case 'textcolor': { const model = readOpt(p); const col = cssColor(readArg(p), model); return { k: 'group', list: parseMath(readArg(p)), color: col }; }
      case 'begin': {
        const env = readArg(p).trim();
        let spec = '';
        if (env === 'array' || env === 'alignedat') spec = readArg(p);
        const body = readEnvBody(p, env);
        return matrixAtom(env, body, spec);
      }
      case 'end': readArg(p); return null;
      case 'substack': return matrixAtom('substack', readArg(p), '');
      case 'cdot': return { k: 'dots', type: 'cdot', cls: 'bin' };
      case 'bullet': return { k: 'dots', type: 'bullet', cls: 'bin' };
      case 'ldots': case 'dots': case 'dotsc': case 'dotsb': case 'dotso': return { k: 'dots', type: 'ldots', cls: 'inner' };
      case 'cdots': return { k: 'dots', type: 'cdots', cls: 'inner' };
      case 'vdots': return { k: 'dots', type: 'vdots', cls: 'ord' };
      case 'ddots': return { k: 'dots', type: 'ddots', cls: 'inner' };
      case 'not': {
        skipWs(p);
        if (p.s[p.i] === '=') { p.i++; return { k: 'ch', t: '≠', cls: 'rel' }; }
        if (/^\\in(?![a-zA-Z])/.test(p.s.slice(p.i))) { p.i += 3; return { k: 'ch', t: '∉', cls: 'rel' }; }
        return null;
      }
      case 'pmod': return { k: 'group', list: [{ k: 'space', em: 0.6 }, { k: 'ch', t: '(', cls: 'open' }, { k: 'text', t: 'mod ' }, ...parseMath(readArg(p)), { k: 'ch', t: ')', cls: 'close' }] };
      case 'bmod': case 'mod': return { k: 'opname', t: 'mod', cls: 'bin' };
      case 'limits': case 'nolimits': { const last = atoms[atoms.length - 1]; if (last && (last.k === 'op' || last.k === 'opname')) last.limits = n === 'limits'; return null; }
      case 'label': case 'tag': readArg(p); return null;
      case 'nonumber': case 'notag': case 'left.': case '\\': case 'displaylimits': case 'mathstrut': case 'strut': return null;
      case 'hspace': return { k: 'space', em: lenToEm(readArg(p)) };
      default: return n ? { k: 'ch', t: n, cls: 'ord' } : null; // unknown command: show its name rather than drop it
    }
  }

  function matrixAtom(env, body, spec) {
    const rows = splitTop(body.replace(/\\hline/g, ''), 'row').map(r => splitTop(r, 'cell').map(parseMath));
    return { k: 'matrix', env, rows, spec };
  }

  // ---- math layout -------------------------------------------------------------
  const SPC = { 1: 1 / 6, 2: 2 / 9, 3: 5 / 18 };
  const PAIR = { 'ord-op': 1, 'ord-bin': 2, 'ord-rel': 3, 'ord-inner': 1, 'op-ord': 1, 'op-op': 1, 'op-rel': 3, 'op-inner': 1, 'bin-ord': 2, 'bin-op': 2, 'bin-open': 2, 'bin-inner': 2, 'rel-ord': 3, 'rel-op': 3, 'rel-open': 3, 'rel-inner': 3, 'close-op': 1, 'close-bin': 2, 'close-rel': 3, 'close-inner': 1, 'punct-ord': 1, 'punct-op': 1, 'punct-rel': 1, 'punct-open': 1, 'punct-close': 1, 'punct-punct': 1, 'punct-inner': 1, 'inner-ord': 1, 'inner-op': 1, 'inner-bin': 2, 'inner-rel': 3, 'inner-open': 1, 'inner-punct': 1, 'inner-inner': 1 };

  /** Merge adjacent math letters (and digits) into one run so the font can join them. */
  function mergeRuns(atoms) {
    const out = [];
    for (const a of atoms) {
      const last = out[out.length - 1];
      if (a.k === 'ch' && a.grp && last && last.k === 'ch' && last.grp === a.grp) { out[out.length - 1] = { ...last, t: last.t + a.t }; continue; }
      out.push(a);
    }
    return out;
  }

  function mathBox(atoms, st0) {
    const lead = st0.leadOrd;
    let st = lead ? { ...st0, leadOrd: false } : st0;
    const items = [];
    for (const a of mergeRuns(atoms)) {
      if (a.k === 'style') { st = { ...st, disp: a.disp, fs: a.scale ? st.fs * a.scale : st.fs }; continue; }
      const r = atomBox(a, st);
      if (r) items.push(r);
    }
    // TeX's bin → ord rules (a leading or post-operator "-" is unary)
    let prev = lead ? { cls: 'ord' } : null;
    for (const it of items) {
      if (it.cls === 'sp') continue;
      if (it.cls === 'bin' && (!prev || ['bin', 'op', 'rel', 'open', 'punct'].includes(prev.cls))) it.cls = 'ord';
      if (['rel', 'close', 'punct'].includes(it.cls) && prev && prev.cls === 'bin') prev.cls = 'ord';
      prev = it;
    }
    if (prev && prev.cls === 'bin') prev.cls = 'ord';
    const script = st.fs < st.base * 0.8;
    const out = [];
    let pc = lead ? 'ord' : null;
    for (const it of items) {
      if (it.cls === 'sp') { out.push(it.b); continue; }
      const s = pc && PAIR[pc + '-' + it.cls];
      if (s && !(script && s > 1)) out.push(kern(SPC[s] * st.fs * 1.2));
      out.push(it.b); pc = it.cls;
    }
    return hlist(out);
  }

  function atomBox(a, st) {
    const fs = st.fs, o = { jit: 0.5, bold: st.bold, bb: st.bb };
    switch (a.k) {
      case 'ch': return { b: runBox(a.t, fs, o), cls: a.cls };
      case 'minus': return { b: minusBox(fs), cls: 'bin' };
      case 'dots': return { b: dotsBox(a.type, fs), cls: a.cls };
      case 'arrow': return { b: arrowBox(a.spec, fs), cls: 'rel' };
      case 'space': return { b: kern(a.em * fs), cls: 'sp' };
      case 'group': return { b: colorBox(mathBox(a.list, { ...st, bold: a.bold || st.bold, bb: a.bb || st.bb }), a.color), cls: 'ord' };
      case 'text': return { b: textBox(a.t, fs, { jit: 0.7, bold: a.bold || st.bold, slant: a.slant }), cls: 'ord' };
      case 'frac': {
        const mode = a.force || (st.disp ? 'd' : 't');
        const k = mode === 'd' ? 1 : (fs > st.base * 0.8 ? 0.85 : 0.9); // hand-written inline fractions stay legible
        const sub = { ...st, disp: false, fs: Math.max(fs * k, st.base * 0.42) };
        let b = fracBox(mathBox(a.num, sub), mathBox(a.den, sub), fs, mode === 'd', !a.nobar);
        if (a.delims) b = hlist([delimBox('(', b.h, b.d, fs), b, delimBox(')', b.h, b.d, fs)]);
        return { b: hpad(b, 0.05 * fs), cls: 'inner' };
      }
      case 'sqrt': {
        const body = mathBox(a.body, st);
        const index = a.index ? mathBox(a.index, { ...st, disp: false, fs: Math.max(fs * 0.55, st.base * 0.4) }) : null;
        return { b: sqrtBox(body, index, fs), cls: 'ord' };
      }
      case 'op': {
        const integral = INTEGRALS.has(a.sym);
        const k = integral ? (st.disp ? 1.75 : 1.25) : (st.disp ? 1.45 : 1.1);
        return { b: bigOpBox(a.sym, fs, k), cls: 'op', limits: a.limits && st.disp, isInt: integral };
      }
      case 'opname': return { b: runBox(a.t, fs, o), cls: a.cls || 'op', limits: a.limits && st.disp };
      case 'scripts': {
        const base = a.base ? atomBox(a.base, st) : null;
        const bb = base ? base.b : kern(0);
        const sst = { ...st, disp: false, fs: Math.max(fs * (fs > st.base * 0.8 ? 0.7 : 0.8), st.base * 0.42) };
        const sup = a.sup ? mathBox(a.sup, sst) : null, sub = a.sub ? mathBox(a.sub, sst) : null;
        const lim = base && (base.limits || (a.base.k === 'accent' && /brace$/.test(a.base.type)));
        return { b: lim ? limitsBox(bb, sup, sub, fs) : scriptsBox(bb, sup, sub, fs, base && base.isInt), cls: base ? base.cls : 'ord' };
      }
      case 'accent': return { b: accentBox(a.type, mathBox(a.body, st), fs), cls: 'ord' };
      case 'leftright': {
        const body = mathBox(a.body, st);
        return { b: hlist([delimBox(a.l, body.h, body.d, fs), kern(0.04 * fs), body, kern(0.04 * fs), delimBox(a.r, body.h, body.d, fs)]), cls: 'inner' };
      }
      case 'bigdelim': return { b: a.ch === '.' ? kern(0.05 * fs) : drawnDelim(a.ch, (M.cap + M.desc) * fs * a.scale / 2, fs), cls: a.cls };
      case 'matrix': return { b: matrixBox(a, st), cls: 'inner' };
      case 'stack': {
        const small = { ...st, disp: false, fs: Math.max(fs * 0.7, st.base * 0.42) };
        const top = a.top ? mathBox(a.top, small) : null, bot = a.bot ? mathBox(a.bot, small) : null;
        const base = a.arrow ? arrowBox(a.arrow, fs, Math.max(top ? top.w : 0, bot ? bot.w : 0) + 0.5 * fs) : mathBox(a.base, st);
        return { b: limitsBox(base, top, bot, fs * 0.7), cls: a.rel ? 'rel' : 'ord' };
      }
      case 'boxed': return { b: boxedBox(mathBox(a.body, st), fs), cls: 'ord' };
      case 'cancel': return { b: cancelBox(mathBox(a.body, st), fs, a.type), cls: 'ord' };
      case 'phantom': {
        const b = mathBox(a.body, st);
        return { b: { w: a.type === 'vphantom' ? 0 : b.w, h: a.type === 'hphantom' ? 0 : b.h, d: a.type === 'hphantom' ? 0 : b.d, draw() {} }, cls: 'ord' };
      }
      default: return null;
    }
  }

  function matrixBox(a, st) {
    const fs = st.fs, env = a.env;
    const small = env === 'smallmatrix' || env === 'substack';
    const alignEnv = /^(aligned|alignedat|split|align|align\*|eqnarray)/.test(env);
    const cfs = small ? Math.max(fs * 0.7, st.base * 0.42) : fs;
    const cst = { ...st, fs: cfs, disp: alignEnv || env === 'gathered' || env === 'dcases' };
    const B = a.rows.map(row => row.map((cell, j) => mathBox(cell, { ...cst, leadOrd: alignEnv && j % 2 === 1 })));
    const ncol = Math.max(1, ...B.map(r => r.length));
    let aligns;
    if (env === 'cases' || env === 'dcases' || env === 'rcases') aligns = ['l', 'l'];
    else if (alignEnv) aligns = Array.from({ length: ncol }, (_, j) => (j % 2 ? 'l' : 'r'));
    else if (env === 'array') aligns = (a.spec.match(/[lcr]/g) || []);
    else aligns = [];
    const colW = Array.from({ length: ncol }, (_, j) => Math.max(0, ...B.map(r => (r[j] ? r[j].w : 0))));
    const gapAfter = (j) => (alignEnv ? (j % 2 ? 1.5 * fs : 0) : (env.includes('cases') ? 1.0 * fs : small ? 0.5 * fs : 0.9 * fs));
    const colX = []; let x = 0;
    for (let j = 0; j < ncol; j++) { colX.push(x); x += colW[j] + (j < ncol - 1 ? gapAfter(j) : 0); }
    const w = x;
    const rowH = B.map(r => Math.max(0.72 * cfs, ...r.map(b => b.h)));
    const rowD = B.map(r => Math.max(0.26 * cfs, ...r.map(b => b.d)));
    const rowGap = (small ? 0.12 : alignEnv ? 0.35 : 0.28) * fs;
    const H = rowH.reduce((s, v, i) => s + v + rowD[i], 0) + rowGap * Math.max(0, B.length - 1);
    const top = M.axis * fs + H / 2;
    const kids = []; let acc = 0;
    B.forEach((row, i) => {
      const base = top - acc - rowH[i];
      row.forEach((b, j) => {
        const al = aligns[j] || 'c';
        const dx = colX[j] + (al === 'l' ? 0 : al === 'r' ? colW[j] - b.w : (colW[j] - b.w) / 2);
        kids.push({ b, dx, dy: base });
      });
      acc += rowH[i] + rowD[i] + rowGap;
    });
    let box = compose(w, kids);
    const dl = MATRIX_DELIMS[env];
    if (dl) box = hlist([delimBox(dl[0], box.h, box.d, fs), kern(0.08 * fs), box, kern(0.08 * fs), delimBox(dl[1], box.h, box.d, fs)]);
    return box;
  }

  /** Top-level display math → one box per written line; rows with & share aligned columns.
   *  A row too long for the page is never shrunk with the rest of its block: it carries on onto
   *  the next line the way a hand would, breaking before a top-level +, −, = or \qquad gap, with
   *  the continuation indented under the right-hand side. Only a piece with nowhere to break is
   *  scaled down, and only that piece. */
  function displayBoxes(src, fs, avail = PAGE_W - MARGIN_L - MARGIN_R) {
    const s = src.replace(/\\(label|tag)\*?\s*\{[^}]*\}/g, '').replace(/\\(nonumber|notag)(?![a-zA-Z])/g, '');
    const st = { fs, base: fs, disp: true };
    const rows = splitTop(s, 'row').map(r => splitTop(r, 'cell').map(c => parseMath(c)));
    const aligned = rows.some(r => r.length > 1);
    const B = rows.map(r => r.map((atoms, j) => mathBox(atoms, { ...st, leadOrd: aligned && j % 2 === 1 })));
    // column grid for aligned rows (only the right-aligned left columns set where the next one starts)
    const ncol = Math.max(1, ...B.map(r => r.length));
    const colW = Array.from({ length: ncol }, (_, j) => Math.max(0, ...B.map(r => (r[j] ? r[j].w : 0))));
    const colX = []; let x = 0;
    for (let j = 0; j < ncol; j++) { colX.push(x); x += colW[j] + (j < ncol - 1 && j % 2 ? 1.5 * fs : 0); }
    const contIndent = 1.2 * fs;
    const lines = [];                                // [{ kids, extent }]
    rows.forEach((r, i) => {
      const boxes = B[i], last = boxes.length - 1;
      const xs = boxes.map((b, j) => (aligned ? colX[j] + (j % 2 ? 0 : colW[j] - b.w) : 0));
      const kids = boxes.map((b, j) => ({ b, dx: xs[j], dy: 0 }));
      if (xs[last] + boxes[last].w <= avail) { lines.push({ kids, extent: xs[last] + boxes[last].w }); return; }
      // too long: break the last cell into pieces that fit, continuing on new lines
      const startX = xs[last];
      const pieces = breakAtoms(r[last], st, aligned && last % 2 === 1, avail - startX, avail - startX - contIndent);
      pieces.forEach((p, k) => {
        const room = avail - startX - (k ? contIndent : 0);
        const b = p.w > room ? scaleBox(p, Math.max(0.45, room / p.w)) : p;
        const at = startX + (k ? contIndent : 0);
        lines.push({ kids: k ? [{ b, dx: at, dy: 0 }] : [...kids.slice(0, last), { b, dx: at, dy: 0 }], extent: at + b.w });
      });
    });
    // every line of an aligned block gets the same width so centring keeps the = signs lined up
    const blockW = Math.min(avail, Math.max(...lines.map(l => l.extent)));
    return lines.map(l => (aligned ? compose(blockW, l.kids) : compose(l.extent, l.kids)));
  }

  /** Split a top-level atom list into lines no wider than firstW (then contW), breaking only
   *  before a top-level + / − / relation or a \quad-sized space — never inside a group, \left…\right,
   *  fraction or root. Returns one box per line. */
  function breakAtoms(atoms, st, leadOrd, firstW, contW) {
    const isBreak = (a) => a.k === 'minus' || a.k === 'arrow' ||
      (a.k === 'ch' && (a.cls === 'bin' || a.cls === 'rel')) || (a.k === 'space' && a.em >= 1);
    // \big( … \big) and bare ( … ) are flat atoms, not a group, so track bracket depth: a hand
    // never breaks a line inside parentheses
    const OPEN = '([{⟨⌊⌈', CLOSE = ')]}⟩⌋⌉';
    const delimOf = (a) => (a.k === 'bigdelim' ? a.ch : a.k === 'ch' && a.t.length === 1 ? a.t : '');
    const chunks = []; let cur = [], depth = 0;
    atoms.forEach((a, i) => {
      if (i > 0 && cur.length && depth === 0 && isBreak(a)) { chunks.push(cur); cur = []; }
      cur.push(a);
      const d = delimOf(a);
      if (OPEN.includes(d) && d) depth++; else if (CLOSE.includes(d) && d) depth = Math.max(0, depth - 1);
    });
    if (cur.length) chunks.push(cur);
    const out = []; let line = [], limit = firstW;
    const boxOf = (ats, first) => mathBox(ats, { ...st, leadOrd: first ? leadOrd : true });
    const dropGap = (ats) => (ats[0] && ats[0].k === 'space' ? ats.slice(1) : ats); // a continuation never starts with the \qquad that caused the break
    for (const ch of chunks) {
      if (!line.length) { line = ch; continue; }
      const trial = line.concat(ch);
      if (boxOf(trial, !out.length).w <= limit) { line = trial; continue; }
      out.push(line); line = dropGap(ch); limit = contW;
    }
    if (line.length) out.push(line);
    return out.map((ats, k) => boxOf(ats, k === 0));
  }

  // ---- document (text mode) parsing -----------------------------------------
  const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'aligned', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'displaymath', 'flalign', 'flalign*', 'alignat', 'alignat*', 'math']);
  const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);
  const SKIP_ENVS = new Set(['tikzpicture', 'comment', 'filecontents', 'verbatim*']);
  const BREAK_ENVS = new Set(['center', 'flushleft', 'flushright', 'quote', 'quotation', 'tabular', 'tabular*', 'figure', 'figure*', 'table', 'table*', 'minipage', 'verse', 'theorem', 'proof', 'lemma', 'definition', 'example']);
  const SIZES = { tiny: 0.6, scriptsize: 0.7, footnotesize: 0.8, small: 0.9, normalsize: 1, large: 1.2, Large: 1.44, LARGE: 1.7, huge: 2, Huge: 2.4 };
  const IGNORE = new Set(['noindent', 'indent', 'centering', 'raggedright', 'raggedleft', 'hline', 'toprule', 'midrule', 'bottomrule', 'cline', 'protect', 'relax', 'tableofcontents', 'listoffigures', 'listoftables', 'appendix', 'frontmatter', 'mainmatter', 'backmatter', 'bibliographystyle', 'onecolumn', 'twocolumn', 'nobreak', 'allowbreak', 'hfil', 'vfill', 'null', 'leavevmode', 'selectfont']);
  const TEXT_SYMS = { textdegree: '°', textpm: '±', texttimes: '×', textdiv: '÷', textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textbar: '|', textless: '<', textgreater: '>', textendash: '-', textemdash: '-', textquoteleft: "'", textquoteright: "'", textquotedblleft: '"', textquotedblright: '"', ldots: '...', dots: '...', textellipsis: '...', S: '§', P: '¶', copyright: '©', LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2e', ss: 'ß', ae: 'æ', o: 'ø', textregistered: '®', texttrademark: '™' };

  const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  function stripComments(s) {
    return s.replace(/(^|[^\\])%[^\n]*(\n[ \t]*)?/g, '$1');
  }

  function expandMacros(src) {
    const macros = {};
    const defRe = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def)(\*?)/g;
    let res = '', last = 0, m;
    while ((m = defRe.exec(src))) {
      const p = { s: src, i: m.index + m[0].length };
      let name, nargs = 0, body, opt = null;
      if (m[1] === 'def') {
        skipWs(p);
        const nm = /^\\([a-zA-Z]+)/.exec(src.slice(p.i)); if (!nm) continue;
        name = nm[1]; p.i += nm[0].length;
        const pm = /^(#\d)*/.exec(src.slice(p.i)); nargs = pm[0].length / 2; p.i += pm[0].length;
        skipWs(p); if (src[p.i] !== '{') continue;
        body = readBraced(p);
      } else {
        name = readArg(p).replace(/^\\/, '').trim();
        if (m[1] === 'DeclareMathOperator') body = `\\operatorname${m[2]}{${readArg(p)}}`;
        else {
          const nArg = readOpt(p); if (nArg) nargs = parseInt(nArg, 10) || 0;
          const d = readOpt(p); if (d != null) opt = d;
          body = readArg(p);
        }
      }
      if (!/^[a-zA-Z]+$/.test(name)) continue;
      macros[name] = { nargs, body, opt };
      res += src.slice(last, m.index); last = p.i; defRe.lastIndex = p.i;
    }
    res += src.slice(last);
    const names = Object.keys(macros).sort((a, b) => b.length - a.length);
    if (!names.length) return res;
    const useRe = new RegExp('\\\\(' + names.join('|') + ')(?![a-zA-Z])', 'g');
    for (let pass = 0; pass < 8; pass++) {
      let out = '', lastI = 0, changed = false, mm;
      useRe.lastIndex = 0;
      while ((mm = useRe.exec(res))) {
        const mac = macros[mm[1]], p = { s: res, i: mm.index + mm[0].length };
        const args = []; let k = 0;
        if (mac.opt != null) { const ov = readOpt(p); args.push(ov != null ? ov : mac.opt); k = 1; }
        for (; k < mac.nargs; k++) args.push(readArg(p));
        const body = mac.body.replace(/#(\d)/g, (_, i) => args[i - 1] || '');
        out += res.slice(lastI, mm.index) + body + (mac.nargs === 0 && /[a-zA-Z]$/.test(body) && /^[a-zA-Z]/.test(res[p.i] || '') ? ' ' : '');
        lastI = p.i; useRe.lastIndex = p.i; changed = true;
      }
      res = out + res.slice(lastI);
      if (!changed) break;
    }
    return res;
  }

  function extractMeta(src, meta) {
    const re = /\\(title|author|date)\s*(?:\[[^\]]*\])?\s*\{/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      const p = { s: src, i: m.index + m[0].length - 1 };
      meta[m[1]] = readBraced(p);
      out += src.slice(last, m.index); last = p.i; re.lastIndex = p.i;
    }
    return out + src.slice(last);
  }

  function detectMode(src) {
    if (/\\begin\{document\}|\\(sub)*section|\\item|\$|\\\[|\\\(|\\begin\{(equation|align|gather|multline|itemize|enumerate)/.test(src)) return 'doc';
    if (/\\(frac|sqrt|int|sum|prod|lim|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega|phi|partial|nabla|infty|cdot|times|leq|geq|neq|approx|vec|hat|left|right|mathbf|mathrm|begin\{[pbvBV]?matrix\})(?![a-zA-Z])|[\^_]/.test(src)) return 'math';
    return 'doc';
  }

  function parseDoc(raw, mode) {
    let src = stripComments(raw.replace(/\r\n?/g, '\n'));
    src = expandMacros(src);
    if ((mode === 'auto' ? detectMode(src) : mode) === 'math') {
      return src.split(/\n\s*\n/).filter(b => b.trim()).map(b => ({ t: 'disp', src: b }));
    }
    const meta = {};
    src = extractMeta(src, meta);
    const b = src.indexOf('\\begin{document}');
    if (b >= 0) { src = src.slice(b + 16); const e = src.indexOf('\\end{document}'); if (e >= 0) src = src.slice(0, e); }
    else src = src.replace(/^\s*\\(documentclass|usepackage|geometry|pagestyle|setlength|graphicspath)\b.*$/gm, '');
    const out = [];
    scanText({ s: src, i: 0 }, { size: 1 }, out, meta);
    return out;
  }

  function scanText(p, sty, out, meta) {
    let word = '';
    const flushWord = () => { if (word) { out.push({ t: 'word', text: word, sty: { ...sty } }); word = ''; } };
    const push = (tok) => { flushWord(); out.push(tok); };
    const s = p.s;
    while (p.i < s.length) {
      const c = s[p.i];
      if (c === '$') {
        flushWord();
        if (s[p.i + 1] === '$') {
          let e = s.indexOf('$$', p.i + 2); if (e < 0) e = s.length;
          out.push({ t: 'disp', src: s.slice(p.i + 2, e) }); p.i = e + 2; continue;
        }
        let e = p.i + 1; while (e < s.length && (s[e] !== '$' || s[e - 1] === '\\')) e++;
        out.push({ t: 'math', src: s.slice(p.i + 1, e), sty: { ...sty } }); p.i = e + 1; continue;
      }
      if (c === '\\') {
        const nx = s[p.i + 1];
        if (nx === '[' || nx === '(') {
          flushWord();
          let e = s.indexOf(nx === '[' ? '\\]' : '\\)', p.i + 2); if (e < 0) e = s.length;
          const body = s.slice(p.i + 2, e); p.i = e + 2;
          out.push(nx === '[' ? { t: 'disp', src: body } : { t: 'math', src: body, sty: { ...sty } });
          continue;
        }
        if (nx === '\\') { p.i += 2; readOpt(p); push({ t: 'br' }); continue; }
        if (nx && !/[a-zA-Z]/.test(nx)) {
          p.i += 2;
          if ('%$&#_{}'.includes(nx)) word += nx;
          else if (' ,;:\n\t'.includes(nx)) push({ t: 'sp' });
          continue;
        }
        const m = /^\\([a-zA-Z]+)(\*?)/.exec(s.slice(p.i));
        p.i += m[0].length;
        textCommand(m[1], m[2], p, sty, out, meta, flushWord, (w) => { word += w; });
        continue;
      }
      if (/\s/.test(c)) {
        let j = p.i, nl = 0;
        while (j < s.length && /\s/.test(s[j])) { if (s[j] === '\n') nl++; j++; }
        p.i = j; push(nl >= 2 ? { t: 'par' } : { t: 'sp' }); continue;
      }
      if (c === '{') { flushWord(); scanText({ s: readBraced(p), i: 0 }, { ...sty }, out, meta); continue; }
      if (c === '}') { p.i++; continue; }
      if (c === '~' || c === '&') { p.i++; push({ t: 'sp' }); continue; }
      if (c === '-' && s[p.i + 1] === '-') { p.i += s[p.i + 2] === '-' ? 3 : 2; word += '-'; continue; }
      if ((c === '`' || c === "'") && s[p.i + 1] === c) { p.i += 2; word += '"'; continue; }
      if (c === '`') { p.i++; word += "'"; continue; }
      word += c; p.i++;
    }
    flushWord();
  }

  function textCommand(name, star, p, sty, out, meta, flushWord, addChars) {
    const push = (t) => { flushWord(); out.push(t); };
    const sub = (raw, patch) => { flushWord(); scanText({ s: raw, i: 0 }, { ...sty, ...patch }, out, meta); };
    switch (name) {
      case 'begin': {
        const env = readArg(p).trim();
        if (MATH_ENVS.has(env)) { if (/^alignat/.test(env)) readArg(p); push({ t: 'disp', src: readEnvBody(p, env) }); return; }
        if (LIST_ENVS.has(env)) { push({ t: 'list+', kind: env }); return; }
        if (SKIP_ENVS.has(env)) { readEnvBody(p, env); return; }
        if (env === 'verbatim' || env === 'lstlisting') { const body = readEnvBody(p, env); push({ t: 'par' }); body.split('\n').forEach(line => { line.split(/\s+/).filter(Boolean).forEach(w => { out.push({ t: 'word', text: w, sty: { ...sty } }); out.push({ t: 'sp' }); }); out.push({ t: 'br' }); }); return; }
        if (env === 'abstract') { push({ t: 'head', level: 3, toks: [{ t: 'word', text: 'Abstract', sty: { ...sty } }] }); return; }
        if (env === 'tabular' || env === 'tabular*' || env === 'array') { if (env === 'tabular*') readArg(p); readOpt(p); readArg(p); }
        if (env === 'minipage') { readOpt(p); readArg(p); }
        if (/^(figure|table)/.test(env)) readOpt(p);
        if (BREAK_ENVS.has(env)) push({ t: 'par' });
        return;
      }
      case 'end': {
        const env = readArg(p).trim();
        if (LIST_ENVS.has(env)) push({ t: 'list-' });
        else if (BREAK_ENVS.has(env) || env === 'abstract') push({ t: 'par' });
        return;
      }
      case 'chapter': case 'section': case 'subsection': case 'subsubsection': case 'paragraph': {
        readOpt(p);
        const toks = []; scanText({ s: readArg(p), i: 0 }, { ...sty }, toks, meta);
        push({ t: 'head', level: { chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 }[name], numbered: !star && name !== 'paragraph', toks });
        return;
      }
      case 'item': push({ t: 'item', label: readOpt(p) }); return;
      case 'textbf': return sub(readArg(p), { bold: true });
      case 'textit': case 'emph': case 'textsl': return sub(readArg(p), { italic: !sty.italic });
      case 'underline': case 'uline': return sub(readArg(p), { ul: true });
      case 'textrm': case 'textsf': case 'texttt': case 'textup': case 'textnormal': case 'text': case 'mbox': case 'makebox': case 'fbox': case 'caption': case 'footnotetext': case 'textsc':
        if (name === 'makebox') readOpt(p);
        return sub(readArg(p), {});
      case 'textcolor': { const model = readOpt(p); const col = cssColor(readArg(p), model); return sub(readArg(p), { color: col }); }
      case 'color': { const model = readOpt(p); flushWord(); sty.color = cssColor(readArg(p), model); return; }
      case 'bf': case 'bfseries': flushWord(); sty.bold = true; return;
      case 'it': case 'itshape': case 'em': case 'sl': case 'slshape': flushWord(); sty.italic = true; return;
      case 'rm': case 'normalfont': case 'upshape': case 'mdseries': flushWord(); sty.bold = false; sty.italic = false; return;
      case 'par': push({ t: 'par' }); return;
      case 'newline': case 'linebreak': case 'break': push({ t: 'br' }); return;
      case 'newpage': case 'clearpage': case 'pagebreak': case 'cleardoublepage': push({ t: 'page' }); return;
      case 'vspace': readArg(p); push({ t: 'vgap', rows: 1 }); return;
      case 'bigskip': push({ t: 'vgap', rows: 1 }); return;
      case 'medskip': case 'smallskip': push({ t: 'vgap', rows: 0.5 }); return;
      case 'hspace': readArg(p); push({ t: 'sp' }); return;
      case 'quad': case 'qquad': case 'hfill': case 'enspace': case 'and': push({ t: 'sp' }); return;
      case 'maketitle': if (meta.title || meta.author) push({ t: 'title', title: meta.title, author: meta.author, date: meta.date }); return;
      case 'today': addChars(today()); return;
      case 'label': case 'index': case 'pagestyle': case 'thispagestyle': case 'vphantom': case 'bibliography': case 'input': case 'include':
        readArg(p); return;
      case 'setlength': case 'setcounter': case 'addtocounter': readArg(p); readArg(p); return;
      case 'includegraphics': readOpt(p); readArg(p); return;
      case 'ref': case 'eqref': case 'pageref': readArg(p); addChars('?'); return;
      case 'cite': readOpt(p); readArg(p); addChars('[?]'); return;
      case 'footnote': return sub('(' + readArg(p) + ')', {});
      case 'url': addChars(readArg(p)); return;
      case 'href': readArg(p); return sub(readArg(p), {});
      default: {
        if (SIZES[name]) { flushWord(); sty.size = SIZES[name]; return; }
        if (TEXT_SYMS[name]) { addChars(TEXT_SYMS[name]); return; }
        if (IGNORE.has(name)) return;
        if (GREEK[name]) { addChars(GREEK[name]); return; }
        if (SYMS[name]) { addChars(SYMS[name][0]); return; }
        // unknown command: keep whatever text its braced arguments carry
        while (p.s[p.i] === '{') sub(readBraced(p), {});
      }
    }
  }

  // ---- page layout -------------------------------------------------------------
  /** Lay out sections one after another on the same pages: the committed ones, then the draft.
   *  Each section = { flow, o } and is written with its own settings `o` (size, messiness, pen, ink…);
   *  page-level settings (paper, page colour, font) are shared. */
  function layout(sections) {
    const out = [[]];
    const S = { prevBase: null, prevD: 0, pendGap: 0, atTop: true };
    sections.forEach((sec, i) => layoutSection(sec.flow, sec.o, out, S, i));
    return out.filter((pg, i) => pg.length || i === 0);
  }

  function layoutSection(flow, so, out, S, si) {
    const fs = so.size, snap = opts.paper !== 'PLAIN';
    const pitch = snap ? GRID * Math.max(1, Math.ceil(fs * 1.05 / GRID)) : Math.round(fs * 1.3);
    const nomH = pitch * 0.72, nomD = pitch * 0.28;
    const maxW = PAGE_W - MARGIN_L - MARGIN_R;
    let { prevBase, prevD, pendGap, atTop } = S;
    if (prevBase == null) prevBase = MARGIN_T - pitch;
    else if (!atTop) pendGap = Math.max(pendGap, pitch * 0.5); // a new section starts a new paragraph
    let line = [], lineX = 0, nContent = 0, pendSpace = false, indent = 0, align = 'left', deco = null;
    const lists = [];
    const occ = new Map();
    const keyOf = (s) => { const n = (occ.get(s) || 0) + 1; occ.set(s, n); return si + '|' + s + '#' + n; };
    const counters = [0, 0, 0, 0];

    function newPage() { if (out.length < 300) out.push([]); prevBase = MARGIN_T - pitch; prevD = 0; atTop = true; }

    function placeLine(items, w, h, d, al, x0, dec, eq = false) {
      const need = pitch + Math.max(0, prevD - nomD) + Math.max(0, h - nomH) + (atTop ? 0 : pendGap);
      let base = prevBase + need;
      // sit on the ruled line; tall letters may overlap the line above a little, like real handwriting
      if (snap) base = Math.ceil((base - 0.22 * GRID) / GRID) * GRID;
      if (base + d > PAGE_H - MARGIN_B && !atTop) { newPage(); placeLine(items, w, h, d, al, x0, dec, eq); return; }
      pendGap = 0; atTop = false;
      // Messiness, the way a hand drifts: the line is never tilted as a whole. Its words walk in
      // groups of `so.group` — each group heads off in its own direction (nudged back toward the
      // ruled line so the writing doesn't wander away), then the next group picks a new one. Each
      // word also tilts on its own (drawRun). The line's start drifts in/out from the margin.
      const mess = so.mess, key0 = items[0] ? items[0].key : '';
      const lr = rngFor('line|' + key0, so.seed);
      // a display equation is one wide item: tilting it would swing its far end into the next row
      // and drifting it would break the = alignment of an align block, so it only shifts slightly
      // (its symbols still tilt and bob individually in drawRun)
      const drift = (lr() - 0.5) * (eq ? 3 : 10) * mess;
      const G = Math.max(1, Math.round(so.group) || 3), maxAng = 0.034 * mess, cap = 0.32 * fs * mess + 0.5;
      const ox = (al === 'center' ? MARGIN_L + (maxW - w) / 2 : MARGIN_L + x0) + drift;
      const page = out[out.length - 1];
      let off = (lr() - 0.5) * 0.1 * fs * mess, ang = 0, gx = 0, goff = off, nWords = 0;
      for (const it of items) {
        const word = it.dx >= 0;                    // list markers hang left of the text, not a word
        if (word && nWords % G === 0) {
          const gr = rngFor('grp|' + it.key, so.seed);
          const pull = -off / (2.5 * fs * G);       // slope that would bring it back over one group
          ang = clamp((gr() - 0.5) * 2 * maxAng + pull * 0.7, -1.6 * maxAng, 1.6 * maxAng);
          gx = it.dx; goff = off;
        }
        const t = Math.tan(ang);
        const y = clamp(goff + (it.dx - gx) * t, -cap, cap);
        // a long item (a whole display equation) can't swing as far as a short word
        const rot = eq ? 0 : clamp(ang, -Math.atan(cap / Math.max(1, it.box.w)), Math.atan(cap / Math.max(1, it.box.w)));
        page.push({ box: it.box, key: it.key, x: ox + it.dx, y: base + (eq ? clamp(y, -2, 2) : y), rot, o: so });
        if (word) { off = clamp(goff + (it.dx + it.box.w - gx) * t, -cap, cap); nWords++; }
      }
      if (dec) page.push({ box: dec(w), key: 'deco|' + key0, x: ox, y: base, rot: 0, o: so });
      prevBase = base; prevD = d;
    }

    function flush() {
      if (!line.length) return;
      let h = 0, d = 0;
      for (const it of line) { h = Math.max(h, it.box.h); d = Math.max(d, ldOf(it.box)); }
      if (deco) d = Math.max(d, 0.5 * fs);
      placeLine(line, lineX, h, d, align, align === 'center' ? 0 : indent, deco);
      line = []; lineX = 0; nContent = 0; pendSpace = false;
    }

    function addInline(box, key, sz) {
      const avail = maxW - indent;
      if (box.w > avail) box = scaleBox(box, avail / box.w);
      let sp = pendSpace && nContent ? M.space * sz * Math.max(0.8, 1 + (hash01(key, so.seed) - 0.5) * 0.4 * so.mess) : 0;
      pendSpace = false;
      if (nContent && lineX + sp + box.w > avail) { flush(); sp = 0; }
      line.push({ box, key, dx: lineX + sp });
      lineX += sp + box.w; nContent++;
    }

    function addToken(tok, scale = 1, extra = {}) {
      if (tok.t === 'sp') { pendSpace = true; return; }
      const sz = fs * ((tok.sty && tok.sty.size) || 1) * scale;
      if (tok.t === 'word') {
        const st = tok.sty;
        addInline(runBox(tok.text, sz, { bold: st.bold || extra.bold, slant: st.italic, ul: st.ul, color: st.color }), keyOf(tok.text), sz);
      } else if (tok.t === 'math') {
        let b = mathBox(parseMath(tok.src), { fs: sz, base: sz, disp: false });
        b = colorBox(hpad(b, 0.04 * sz), tok.sty && tok.sty.color);
        b.ld = b.d; // math is dense: its whole depth is kept clear of the next line
        addInline(b, keyOf('$' + tok.src), sz);
      }
    }

    const underline = (sz) => (w) => ({ w, h: 0, d: 0.36 * sz, draw(c, x, y, J) { inkStroke(c, [[x - 2, y + 0.3 * sz], [x + w + 4, y + 0.3 * sz + (J.rng() - 0.5) * 2]], J, { width: stemW(sz, J) }); } });
    const setIndent = () => { indent = lists.length ? 20 + lists.length * 36 : 0; };
    const roman = (n) => ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'][n - 1] || String(n);

    for (const tok of flow) {
      switch (tok.t) {
        case 'word': case 'math': case 'sp': addToken(tok); break;
        case 'br': if (!line.length) pendGap += pitch; flush(); break;
        case 'par': flush(); if (!atTop) pendGap = Math.max(pendGap, pitch * 0.5); break;
        case 'page': flush(); if (out[out.length - 1].length) newPage(); break;
        case 'vgap': flush(); if (!atTop) pendGap += tok.rows * pitch; break;
        case 'disp': {
          flush();
          const ind = so.disp === 'indent' ? 64 : 0;
          const avail = maxW - indent - ind;
          for (let b of displayBoxes(tok.src, fs, avail)) {
            if (b.w > avail) b = scaleBox(b, avail / b.w);
            placeLine([{ box: b, key: keyOf('$$' + tok.src), dx: 0 }], b.w, b.h, b.d, so.disp === 'center' ? 'center' : 'left', indent + ind, null, true);
          }
          break;
        }
        case 'head': {
          flush();
          if (!atTop) pendGap = Math.max(pendGap, pitch * 0.6);
          const scale = [1.6, 1.35, 1.18, 1.06, 1][tok.level];
          const toks = tok.toks.slice();
          if (tok.numbered && tok.level >= 1 && tok.level <= 3) {
            counters[tok.level]++;
            for (let l = tok.level + 1; l < counters.length; l++) counters[l] = 0;
            toks.unshift({ t: 'word', text: counters.slice(1, tok.level + 1).join('.'), sty: { size: 1 } }, { t: 'sp' });
          }
          const saved = indent; indent = 0;
          deco = tok.level <= 2 ? underline(fs * scale) : null;
          toks.forEach(t => addToken(t, scale, { bold: tok.level >= 3 }));
          flush(); deco = null; indent = saved;
          break;
        }
        case 'title': {
          flush(); align = 'center';
          for (const [field, sc] of [['title', 1.7], ['author', 1.15], ['date', 1]]) {
            const v = field === 'date' ? (tok.date != null ? tok.date : today()) : tok[field];
            if (!v) continue;
            const toks = []; scanText({ s: v, i: 0 }, { size: 1 }, toks, {});
            toks.forEach(t => addToken(t, sc));
            flush();
          }
          align = 'left'; pendGap = pitch * 0.8;
          break;
        }
        case 'list+': flush(); lists.push({ kind: tok.kind, n: 0 }); setIndent(); break;
        case 'list-': flush(); lists.pop(); setIndent(); if (!lists.length && !atTop) pendGap = Math.max(pendGap, pitch * 0.3); break;
        case 'item': {
          flush();
          if (!lists.length) { lists.push({ kind: 'itemize', n: 0 }); setIndent(); }
          const L = lists[lists.length - 1], lvl = lists.length;
          L.n++;
          let mb;
          if (tok.label != null) mb = runBox(tok.label.replace(/[{}$\\]/g, '').trim() || '-', fs, { bold: L.kind === 'description' });
          else if (L.kind === 'enumerate') mb = runBox(lvl === 1 ? `${L.n}.` : lvl === 2 ? `(${String.fromCharCode(96 + L.n)})` : `${roman(L.n)}.`, fs);
          else if (L.kind === 'description') mb = null;
          else mb = lvl === 1 ? dotsBox('bullet', fs) : runBox(lvl === 2 ? '-' : '*', fs);
          if (mb && L.kind === 'description') { addInline(mb, keyOf('item' + lvl + L.n), fs); pendSpace = true; }
          else if (mb) line.push({ box: mb, key: keyOf('item' + lvl + L.n), dx: -mb.w - 0.3 * fs });
          break;
        }
        default: break;
      }
    }
    flush();
    Object.assign(S, { prevBase, prevD, pendGap, atTop });
  }

  // ---- drawing pages -----------------------------------------------------------
  function lumHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  }

  // Same paper as EngInk's FinishedStrokesView (and the EngInk mirror).
  function drawPaper(c, paper, pageHex) {
    if (paper === 'PLAIN') return;
    const light = lumHex(pageHex) < 128;
    c.strokeStyle = light ? 'rgba(255,255,255,0.18)' : 'rgba(30,50,90,0.12)';
    c.lineWidth = 1;
    if (paper === 'GRID' || paper === 'RULED') {
      c.beginPath();
      if (paper === 'GRID') for (let x = GRID; x < PAGE_W; x += GRID) { c.moveTo(x, 0); c.lineTo(x, PAGE_H); }
      for (let y = GRID; y < PAGE_H; y += GRID) { c.moveTo(0, y); c.lineTo(PAGE_W, y); }
      c.stroke();
    } else if (paper === 'DOTS') {
      c.fillStyle = light ? 'rgba(255,255,255,0.38)' : 'rgba(30,50,90,0.29)';
      for (let y = GRID; y < PAGE_H; y += GRID) for (let x = GRID; x < PAGE_W; x += GRID) { c.beginPath(); c.arc(x, y, 1.6, 0, 7); c.fill(); }
    }
  }

  function inkBounds(items) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      x0 = Math.min(x0, it.x - 4); x1 = Math.max(x1, it.x + it.box.w + 4);
      y0 = Math.min(y0, it.y - it.box.h - 6); y1 = Math.max(y1, it.y + it.box.d + 6);
    }
    if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: PAGE_W, y1: PAGE_H };
    const pad = 40; // word drift moves ink off the laid-out boxes a little
    return { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(PAGE_W, x1 + pad), y1: Math.min(PAGE_H, y1 + pad) };
  }

  /** Render one page. inkOnly = transparent background cropped to the ink (for pasting elsewhere). */
  function renderPage(items, k, inkOnly, canvas) {
    const r = inkOnly ? inkBounds(items) : { x0: 0, y0: 0, x1: PAGE_W, y1: PAGE_H };
    const c = canvas || document.createElement('canvas');
    c.width = Math.round((r.x1 - r.x0) * k); c.height = Math.round((r.y1 - r.y0) * k);
    const cx = c.getContext('2d');
    cx.setTransform(k, 0, 0, k, -r.x0 * k, -r.y0 * k);
    if (!inkOnly) {
      const pageHex = PAGES[opts.page] || PAGES.white;
      cx.fillStyle = pageHex; cx.fillRect(0, 0, PAGE_W, PAGE_H);
      drawPaper(cx, opts.paper, pageHex);
    }
    for (const it of items) {
      const so = it.o || opts; // the settings of the section this item belongs to
      const J = { ink: so.ink, mess: so.mess, pen: so.pen > 0 ? so.pen : autoPen(), rng: rngFor(it.key, so.seed) };
      // rotate the item about its own start, so each word (and underline) follows its line's angle
      cx.save();
      cx.translate(it.x, it.y); cx.rotate(it.rot || 0);
      try { it.box.draw(cx, 0, 0, J); } catch (_) { /* one bad box shouldn't blank the page */ }
      cx.restore();
    }
    return c;
  }

  // ---- UI --------------------------------------------------------------------
  function build(container) {
    root = container;
    container.innerHTML = `
      <div class="hw">
        <div class="hw-toolbar">
          <label class="hw-opt" title="Handwriting font (installed on this PC)"><input id="hw-font" class="kicad-input hw-font-input" placeholder="Font" spellcheck="false"><span id="hw-font-status" class="hw-font-status"></span></label>
          <label class="hw-opt">Size <input id="hw-size" type="range" min="16" max="48" step="1"></label>
          <label class="hw-opt">Mess <input id="hw-mess" type="range" min="0" max="3" step="0.05" title="Messiness"></label>
          <label class="hw-opt" title="Word groups: how many words drift together in one direction before the next group turns">Groups <input id="hw-group" type="range" min="1" max="8" step="1"><span id="hw-group-val" class="hw-group-val"></span></label>
          <label class="hw-opt" title="Pen stroke width — the same at every text size, like a real pen">Pen <input id="hw-pen" type="range" min="0.6" max="5" step="0.1"><button id="hw-pen-val" class="hw-pen-val"></button></label>
          <div class="hw-inks" id="hw-inks">${INKS.map(i => `<button class="hw-ink" data-ink="${i.c}" title="${esc(i.name)}" style="background:${i.c}"></button>`).join('')}</div>
          <select id="hw-paper" class="kicad-input hw-select" title="Paper">
            <option value="GRID">Grid</option><option value="RULED">Ruled</option><option value="DOTS">Dots</option><option value="PLAIN">Plain</option>
          </select>
          <select id="hw-page" class="kicad-input hw-select" title="Page color">
            <option value="white">White</option><option value="cream">Cream</option><option value="dark">Dark</option>
          </select>
          <select id="hw-mode" class="kicad-input hw-select" title="How to read the input">
            <option value="auto">Auto</option><option value="doc">Document</option><option value="math">Equations</option>
          </select>
          <select id="hw-disp" class="kicad-input hw-select" title="Display equations: centered or indented">
            <option value="center">Centered</option><option value="indent">Indented</option>
          </select>
          <button id="hw-shuffle" class="kicad-btn kicad-btn-outline hw-shuffle" title="Rewrite: write it again with a different variation">🎲</button>
        </div>
        <div class="hw-body">
          <div class="hw-editor" id="hw-editor">
            <div class="hw-editor-bar">
              <span class="hw-editor-label">LaTeX</span>
              <button id="hw-open" class="fmerge-mini hw-mini">Open…</button>
              <button id="hw-example" class="fmerge-mini hw-mini">Example</button>
              <button id="hw-clear" class="fmerge-mini hw-mini">Clear</button>
              <button id="hw-commit" class="kicad-btn kicad-btn-start hw-commit" title="Freeze what's written as a section (with its own size, ink, pen and messiness) and start the next one below it (Ctrl+Enter)">✓ Commit</button>
              <input id="hw-file" type="file" accept=".tex,.latex,.txt,.md" hidden>
            </div>
            <div id="hw-sections" class="hw-sections"></div>
            <textarea id="hw-src" class="hw-src" spellcheck="false" placeholder="Paste LaTeX here, or drop a .tex file. A whole document or just a formula like \\frac{a}{b} works."></textarea>
          </div>
          <div class="hw-preview" id="hw-preview"></div>
        </div>
        <div class="hw-footer">
          <div id="hw-status" class="fmerge-status"></div>
          <label class="hw-opt" title="Copied / saved page images get a transparent background, cropped to the writing"><input id="hw-inkonly" type="checkbox"> Ink-only images</label>
          <button id="hw-pdf" class="kicad-btn kicad-btn-start">Export PDF</button>
        </div>
      </div>`;

    const $ = (id) => container.querySelector('#' + id);
    const src = $('hw-src');
    let draft = null;
    try { draft = localStorage.getItem(DRAFT_KEY); } catch (_) {}
    src.value = draft != null ? draft : EXAMPLE;

    $('hw-font').value = opts.font;
    $('hw-size').value = opts.size;
    $('hw-mess').value = opts.mess;
    $('hw-paper').value = opts.paper;
    $('hw-page').value = opts.page;
    $('hw-mode').value = opts.mode;
    $('hw-disp').value = opts.disp;
    $('hw-inkonly').checked = !!opts.inkOnly;
    syncInks();
    syncControls();
    renderSections();

    src.addEventListener('input', () => {
      try { localStorage.setItem(DRAFT_KEY, src.value); } catch (_) {}
      scheduleRender(220);
    });
    src.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitSection(); } });
    const onOpt = (id, key, parse) => $(id).addEventListener(id.match(/size|mess|pen|group/) ? 'input' : 'change', (e) => {
      opts[key] = parse ? parse(e.target) : e.target.value;
      persist(); syncPen(); syncControls(); scheduleRender(id.match(/size|mess|pen|group/) ? 60 : 0);
    });
    onOpt('hw-size', 'size', t => parseInt(t.value, 10));
    onOpt('hw-mess', 'mess', t => parseFloat(t.value));
    onOpt('hw-group', 'group', t => parseInt(t.value, 10));
    $('hw-commit').addEventListener('click', commitSection);
    $('hw-sections').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sec]'); if (!b) return;
      const i = parseInt(b.dataset.sec, 10);
      if (b.dataset.act === 'del') removeSection(i);
      else if (b.dataset.act === 'edit') uncommitLast();
      else if (b.dataset.act === 'clear') clearSections();
    });
    onOpt('hw-pen', 'pen', t => parseFloat(t.value));
    $('hw-pen-val').addEventListener('click', (e) => { e.preventDefault(); opts.pen = 0; persist(); syncPen(); scheduleRender(0); });
    onOpt('hw-paper', 'paper'); onOpt('hw-page', 'page'); onOpt('hw-mode', 'mode'); onOpt('hw-disp', 'disp');
    $('hw-inkonly').addEventListener('change', (e) => { opts.inkOnly = e.target.checked; persist(); });
    $('hw-font').addEventListener('input', (e) => {
      clearTimeout(fontTimer);
      fontTimer = setTimeout(async () => { opts.font = e.target.value.trim() || DEFAULT_FONT; persist(); await loadFont(opts.font); scheduleRender(0); }, 500);
    });
    $('hw-inks').addEventListener('click', (e) => {
      const b = e.target.closest('.hw-ink'); if (!b) return;
      opts.ink = b.dataset.ink; syncInks(); persist(); scheduleRender(0);
    });
    $('hw-shuffle').addEventListener('click', () => { opts.seed = (opts.seed % 100000) + 1; persist(); scheduleRender(0); });
    $('hw-example').addEventListener('click', () => { src.value = EXAMPLE; src.dispatchEvent(new Event('input')); });
    $('hw-clear').addEventListener('click', () => { src.value = ''; src.dispatchEvent(new Event('input')); src.focus(); });
    $('hw-open').addEventListener('click', () => $('hw-file').click());
    $('hw-file').addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; if (f) await loadFile(f); e.target.value = ''; });
    $('hw-pdf').addEventListener('click', exportPdf);

    // Drop a .tex/.txt file anywhere on the utility (plain dragged text still drops into the editor).
    const hw = container.querySelector('.hw');
    hw.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); hw.classList.add('hw-drop'); } });
    hw.addEventListener('dragleave', (e) => { if (!hw.contains(e.relatedTarget)) hw.classList.remove('hw-drop'); });
    hw.addEventListener('drop', async (e) => {
      hw.classList.remove('hw-drop');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      await loadFile(f);
    });

    $('hw-preview').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const i = parseInt(b.dataset.page, 10);
      if (b.dataset.act === 'copy') copyPage(i); else savePng(i);
    });
  }

  // ---- committed sections --------------------------------------------------------
  // Each commit freezes the editor's text plus the section settings it was written with, so the
  // page can be built up a section at a time — different sizes, inks or messiness per section —
  // and committed sections never re-shuffle when you change the sliders for the next one.
  let committed = loadSections();
  let statusNote = null; // a message for the next render to show instead of the page count

  function loadSections() {
    try { const v = JSON.parse(localStorage.getItem(SECTIONS_KEY) || '[]'); return Array.isArray(v) ? v.filter(s => s && typeof s.src === 'string' && s.o) : []; }
    catch (_) { return []; }
  }
  function saveSections() {
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(committed.map(({ src, o }) => ({ src, o })))); } catch (_) {}
  }
  const sectionOpts = () => Object.fromEntries(SECTION_KEYS.map(k => [k, opts[k]]));

  function commitSection() {
    const src = root.querySelector('#hw-src');
    if (!src.value.trim()) { setStatus('Write something first, then commit it.', ''); return; }
    committed.push({ src: src.value, o: sectionOpts() });
    saveSections();
    opts.seed = (opts.seed % 100000) + 1; // the next section gets its own variation
    persist();
    src.value = '';
    try { localStorage.setItem(DRAFT_KEY, ''); } catch (_) {}
    renderSections();
    statusNote = `Committed section ${committed.length}. Keep writing; the next section goes below it.`;
    scheduleRender(0);
    src.focus();
  }

  /** Pull the last committed section back into the editor (with its settings) to change it. */
  function uncommitLast() {
    const src = root.querySelector('#hw-src');
    if (!committed.length) return;
    if (src.value.trim()) { setStatus('Commit or clear what’s in the editor first, then edit the last section.', 'err'); return; }
    const s = committed.pop();
    saveSections();
    Object.assign(opts, s.o);
    persist(); syncControls(); syncPen(); syncInks();
    src.value = s.src;
    try { localStorage.setItem(DRAFT_KEY, s.src); } catch (_) {}
    renderSections();
    scheduleRender(0);
    src.focus();
  }

  async function removeSection(i) {
    const opts2 = { title: `Remove section ${i + 1}?`, message: 'Its handwriting will be taken off the page.', confirmText: 'Remove', danger: true };
    const go = window._showConfirm ? await window._showConfirm(opts2) : window.confirm(opts2.message);
    if (!go) return;
    committed.splice(i, 1);
    saveSections(); renderSections(); scheduleRender(0);
  }

  async function clearSections() {
    const opts2 = { title: 'Start a fresh page?', message: `This removes all ${committed.length} committed sections. What's in the editor stays.`, confirmText: 'Clear page', danger: true };
    const go = window._showConfirm ? await window._showConfirm(opts2) : window.confirm(opts2.message);
    if (!go) return;
    committed = [];
    saveSections(); renderSections(); scheduleRender(0);
  }

  function renderSections() {
    const el = root && root.querySelector('#hw-sections');
    if (!el) return;
    el.classList.toggle('empty', !committed.length);
    const snip = (s) => s.replace(/\\[a-zA-Z]+\*?|[{}$\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 34) || '(empty)';
    el.innerHTML = committed.map((s, i) => `
      <div class="hw-sec" title="${esc(s.src.slice(0, 400))}">
        <span class="hw-sec-ink" style="background:${esc(s.o.ink)}"></span>
        <span class="hw-sec-no">§${i + 1}</span><span class="hw-sec-text">${esc(snip(s.src))}</span>
        ${i === committed.length - 1 ? `<button class="fmerge-mini hw-mini" data-sec="${i}" data-act="edit" title="Move back into the editor to change it">Edit</button>` : ''}
        <button class="fmerge-mini hw-mini" data-sec="${i}" data-act="del" title="Remove this section">✕</button>
      </div>`).join('') + (committed.length ? `<button class="hw-sec-clear" data-sec="0" data-act="clear">Clear page</button>` : '');
  }

  function syncControls() {
    if (!root) return;
    root.querySelector('#hw-size').value = opts.size;
    root.querySelector('#hw-mess').value = opts.mess;
    root.querySelector('#hw-group').value = opts.group;
    root.querySelector('#hw-group-val').textContent = String(opts.group);
    root.querySelector('#hw-mode').value = opts.mode;
    root.querySelector('#hw-disp').value = opts.disp;
  }

  async function loadFile(f) {
    if (f.size > 5 * 1024 * 1024) { setStatus('That file is too big for a LaTeX source (over 5 MB).', 'err'); return; }
    const text = await f.text();
    const src = root.querySelector('#hw-src');
    src.value = text;
    src.dispatchEvent(new Event('input'));
    setStatus(`Loaded ${f.name}`, 'ok');
  }

  function syncPen() {
    if (!root || !M) return;
    const v = penWidth();
    root.querySelector('#hw-pen').value = v;
    const lbl = root.querySelector('#hw-pen-val'), auto = !(opts.pen > 0);
    lbl.textContent = `${v.toFixed(1)}px`;
    lbl.classList.toggle('is-auto', auto);
    lbl.title = auto ? 'Auto: matches your font’s own weight' : 'Click to go back to Auto (your font’s own weight)';
  }

  function syncInks() {
    if (!root) return;
    root.querySelectorAll('.hw-ink').forEach(b => b.classList.toggle('active', b.dataset.ink.toLowerCase() === String(opts.ink).toLowerCase()));
  }

  function updateFontStatus() {
    const el = root && root.querySelector('#hw-font-status');
    if (!el) return;
    el.className = 'hw-font-status ' + (fontOk ? 'ok' : 'warn');
    el.title = fontOk ? `${fontName} is loaded` : `“${fontName}” isn’t installed. Using a stand-in font.`;
    el.innerHTML = fontOk ? `<span class="hw-font-sample" style="font-family:'${esc(faceFamily)}'">Aa</span>` : '⚠️';
    if (!fontOk) setStatus(el.title, 'err');
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (typeof dataManager !== 'undefined') dataManager.updateSettings({ handwriter: { ...opts } }); }, 600);
  }

  function setStatus(msg, kind) {
    const el = root && root.querySelector('#hw-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'fmerge-status' + (kind ? ' fmerge-status-' + kind : '');
  }

  function scheduleRender(ms) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, ms);
  }

  function renderAll() {
    if (!root || !M) return;
    const srcText = root.querySelector('#hw-src').value;
    const prev = root.querySelector('#hw-preview');
    try {
      const sections = committed.map(s => {
        if (!s.flow) s.flow = parseDoc(s.src, s.o.mode); // committed text never changes: parse once
        return { flow: s.flow, o: s.o };
      });
      if (srcText.trim()) sections.push({ flow: parseDoc(srcText, opts.mode), o: sectionOpts() });
      pages = sections.length ? layout(sections) : [[]];
    } catch (err) {
      setStatus('Couldn’t read that LaTeX: ' + (err && err.message ? err.message : err), 'err');
      return;
    }
    // reuse page cards so the scroll position survives re-renders while typing
    const cards = [...prev.querySelectorAll('.hw-page')];
    pages.forEach((items, i) => {
      let card = cards[i];
      if (!card) {
        card = document.createElement('div');
        card.className = 'hw-page';
        card.innerHTML = `<canvas></canvas><div class="hw-page-tools"><span class="hw-page-no"></span>
          <button class="fmerge-mini hw-mini" data-act="copy">Copy</button><button class="fmerge-mini hw-mini" data-act="png">PNG</button></div>`;
        prev.appendChild(card);
      }
      card.querySelector('.hw-page-no').textContent = `Page ${i + 1}`;
      card.querySelectorAll('[data-act]').forEach(b => { b.dataset.page = i; });
      renderPage(items, PREVIEW_K, false, card.querySelector('canvas'));
    });
    cards.slice(pages.length).forEach(c => c.remove());
    const n = pages.length, c = committed.length;
    if (statusNote) { setStatus(statusNote, 'ok'); statusNote = null; }
    else if (!srcText.trim() && !c) setStatus('Paste or drop some LaTeX to start.', '');
    else setStatus(`${n} page${n === 1 ? '' : 's'}${c ? ` · ${c} committed section${c === 1 ? '' : 's'}` : ''}`, '');
  }

  const canvasPng = (c) => new Promise(res => c.toBlob(b => res(b), 'image/png'));

  async function copyPage(i) {
    if (!pages[i]) return;
    try {
      const blob = await canvasPng(renderPage(pages[i], 2, opts.inkOnly));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setStatus(`Copied page ${i + 1} as an image.`, 'ok');
    } catch (err) {
      setStatus('Copy failed: ' + (err && err.message ? err.message : err), 'err');
    }
  }

  async function savePng(i) {
    if (!pages[i]) return;
    const blob = await canvasPng(renderPage(pages[i], 2, opts.inkOnly));
    await saveBytes(new Uint8Array(await blob.arrayBuffer()), suggestName(pages.length > 1 ? `-p${i + 1}.png` : '.png'));
  }

  async function exportPdf() {
    if (busy || !pages.length) return;
    if (typeof PDFLib === 'undefined') { setStatus('PDF engine failed to load.', 'err'); return; }
    busy = true;
    const btn = root.querySelector('#hw-pdf');
    btn.disabled = true; btn.textContent = 'Writing…';
    try {
      const doc = await PDFLib.PDFDocument.create();
      for (const items of pages) {
        const blob = await canvasPng(renderPage(items, 2, false));
        const img = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
        const page = doc.addPage([612, 792]); // US Letter, like EngInk's own export
        page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
      }
      await saveBytes(await doc.save(), suggestName('.pdf'), true);
    } catch (err) {
      setStatus('Export failed: ' + (err && err.message ? err.message : err), 'err');
    } finally {
      busy = false; btn.disabled = false; btn.textContent = 'Export PDF';
    }
  }

  async function saveBytes(bytes, name, open) {
    let res;
    if (window.api && window.api.handwriter && window.api.handwriter.save) res = await window.api.handwriter.save(bytes, name);
    else if (window.api && window.api.share && window.api.share.saveDownload) res = await window.api.share.saveDownload(bytes, name); // app not restarted yet
    else { setStatus('Saving isn’t available. Fully restart the app.', 'err'); return; }
    if (res && res.path) {
      setStatus(`Saved → ${res.path}`, 'ok');
      if (open && window.api.files && window.api.files.openPath) window.api.files.openPath(res.path);
    } else if (res && res.error) setStatus('Save failed: ' + res.error, 'err');
    else setStatus('Save cancelled.', '');
  }

  function suggestName(suffix) {
    const t = (((committed[0] && committed[0].src) || root.querySelector('#hw-src').value).match(/\\(?:title|section\*?)\s*\{([^}]*)\}/) || [])[1];
    const base = (t || 'handwriting').replace(/\\[a-zA-Z]+|[{}$\\]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'handwriting';
    return base + suffix;
  }

  // ---- public API --------------------------------------------------------------
  return {
    mount(container) {
      if (mounted) return;
      const saved = (typeof dataManager !== 'undefined' && dataManager.settings && dataManager.settings.handwriter) || {};
      opts = { ...DEFAULTS, ...saved };
      build(container);
      mounted = true;
      loadFont(opts.font).then(() => scheduleRender(0));
    },
    activate() { if (mounted && M) scheduleRender(0); },
    deactivate() {},
    // exposed for quick checks from devtools
    _parse: (s, mode = 'auto') => parseDoc(s, mode),
    // per-word stroke widths (page px) before/after pen correction; set window.__hwDebug first
    _glyphStats: () => [...glyphCache.entries()].map(([k, g]) => ({ text: k.split('|')[0], fs: +k.split('|')[1], before: +(g.t || 0).toFixed(2), after: +(g.after || 0).toFixed(2) })),
  };
})();
