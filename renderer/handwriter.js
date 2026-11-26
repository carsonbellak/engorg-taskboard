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
  const PAGE_W = 816, PAGE_H = 1056, GRID = 32, INK_BIN = 8;
  const MARGIN_L = 48, MARGIN_R = 48, MARGIN_T = 64, MARGIN_B = 48;
  const DEFAULT_FONT = 'Carson Hand';
  const FALLBACK = '"Segoe Print", "Segoe UI Symbol", "Cambria Math", sans-serif';
  const DRAFT_KEY = 'engorg_handwriter_draft';
  const SECTIONS_KEY = 'engorg_handwriter_sections'; // committed sections (device-local)
  // settings that belong to a section (frozen on commit); paper, page colour and font are page-wide
  const SECTION_KEYS = ['size', 'mess', 'group', 'pen', 'ink', 'nib', 'disp', 'mode', 'seed',
    'lean', 'gap', 'vSlant', 'vSize', 'vSpace', 'vBase', 'vTilt', 'vDrift', 'vWob', 'vLetter', 'vLetterW', 'vWave', 'nodeGap',
    'vInk', 'vPress', 'vOops', 'vShape', 'vAlt', 'vJoin', 'vTight', 'inkV'];
  // Pen types: how ink lands on the paper. `solid` = a stylus / EngInk pen: clean, even, opaque
  // ink drawn straight onto the page. The others go through finishInk's grain and flow.
  const NIBS = [
    { k: 'solid', name: 'Solid pen' }, { k: 'gel', name: 'Gel pen' }, { k: 'ballpoint', name: 'Ballpoint' },
    { k: 'fountain', name: 'Fountain pen' }, { k: 'pencil', name: 'Pencil' },
  ];
  // preview resolution: the canvas is drawn at the screen's own pixel density for its shown width
  // (a 1.25× canvas stretched over a 2× screen blurs thin pen lines and makes them look uneven)
  const previewK = (el) => clamp(Math.round(((el && el.clientWidth) || PAGE_W) * (window.devicePixelRatio || 1) / PAGE_W * 4) / 4, 1, 3);
  const INKS = [
    { c: '#1F2329', name: 'Black' }, { c: '#1E3A8A', name: 'Blue' }, { c: '#2563EB', name: 'Bright blue' },
    { c: '#B91C1C', name: 'Red' }, { c: '#166534', name: 'Green' }, { c: '#6D28D9', name: 'Purple' }, { c: '#52525B', name: 'Pencil' },
  ];
  const PAGES = { white: '#FFFFFF', cream: '#FCF6D8', dark: '#23262D' };
  // pen: stroke width in page px (0 = auto, the font's own weight at the default size)
  // group: about how many words rise or fall together before the baseline turns the other way
  // The messiness knobs (⚙ next to the Mess slider). lean/gap are a steady trait of the hand
  // (not scaled by Mess); the v* ones are how strongly each kind of irregularity shows, each
  // multiplied by Mess, so Mess stays the master "how messy" and 0 is still perfectly neat.
  // vLetter/vLetterW/vWave move letters inside a word, vShape re-draws each one a little differently,
  // vAlt = how often the font's alternate letter forms are used (writeWord); nodeGap = letter rhythm.
  // vInk/vPress (ink texture, pressure) are a property of the pen, so they're not ×Mess either.
  // vOops = cross-outs (false starts struck through), ×Mess, off by default.
  const MESS_DEFAULTS = { lean: 0, gap: 1, vSlant: 1, vSize: 1, vSpace: 1, vBase: 1, vTilt: 1, vDrift: 1, vWob: 1, vLetter: 1, vLetterW: 1, vWave: 1, nodeGap: 1, vInk: 1, vPress: 1, vOops: 0, vShape: 1, vAlt: 0.35, vJoin: 0.6, vTight: 1 };
  const DEFAULTS = { font: DEFAULT_FONT, size: 30, mess: 0.8, group: 3, pen: 0, ink: INKS[0].c, nib: 'solid', inkV: 2, paper: 'GRID', page: 'white', mode: 'auto', disp: 'center', seed: 1, inkOnly: false, ...MESS_DEFAULTS };
  const xV = (v) => `×${(+v).toFixed(2).replace(/\.?0+$/, '')}`;
  const MESS_VARS = [
    { k: 'lean', label: 'Lean', min: -0.35, max: 0.35, step: 0.01, tip: 'Steady slant of the whole hand: right (forward) or left (backhand)',
      fmt: v => (Math.abs(v) < 0.005 ? 'upright' : `${Math.round(Math.abs(Math.atan(v)) * 180 / Math.PI)}° ${v > 0 ? 'right' : 'left'}`) },
    { k: 'gap', label: 'Word gap', min: 0.5, max: 2.5, step: 0.05, tip: 'Space between words', fmt: v => `${Math.round(v * 100)}%` },
    { head: 'Ink (any Mess)' },
    { k: 'vInk', label: 'Texture', max: 2, tip: 'How much the pen type shows: grain, uneven ink flow and soft paper edges (0 = solid ink)' },
    { k: 'vPress', label: 'Pressure', max: 2, tip: 'How much the hand’s pressure varies: darker and lighter words, strokes that taper as the pen lifts' },
    { head: 'Letters (× Mess)' },
    { k: 'vShape', label: 'Shape', tip: 'How differently each letter is drawn each time it appears: curves, loops and stroke ends vary (it always stays readable)' },
    { k: 'vAlt', label: 'Alternates', min: 0, max: 1, step: 0.05, tip: 'How often a letter is written in your font’s second form instead of its first', fmt: v => `${Math.round(v * 100)}%` },
    { k: 'vJoin', label: 'Joins', min: 0, max: 1, step: 0.05, tip: 'How often the pen runs on from one letter into the next (on top of the joined pairs your font already has)', fmt: v => `${Math.round(v * 100)}%` },
    { k: 'vTight', label: 'Tightness', min: 0, max: 2.5, step: 0.05, tip: 'How much closer together your letters sit than the font spaces them (letters may touch, never pile up). Not × Mess.', fmt: xV },
    { k: 'vLetter', label: 'Size', tip: 'Each letter a little taller or shorter than its neighbours — x-height, ascenders and descenders vary on their own' },
    { k: 'vLetterW', label: 'Spacing', tip: 'Uneven gaps between the letters of a word (the word keeps its length)' },
    { k: 'vWave', label: 'Bob', tip: 'Letters sitting above and below the baseline inside a word' },
    { k: 'nodeGap', label: 'Rhythm', min: 0.4, max: 3, step: 0.05, tip: 'How much each letter follows the one before it: low = every letter on its own, high = slow swells across a word',
      fmt: v => (v < 0.56 ? 'none' : `${Math.round(clamp(1 - 0.55 / v, 0, 0.9) * 100)}%`) },
    { head: 'Words (× Mess)' },
    { k: 'vSlant', label: 'Slant', tip: 'How much the slant wavers, word to word and letter to letter' },
    { k: 'vSize', label: 'Size', tip: 'How much word sizes vary (the pen width stays the same)' },
    { k: 'vSpace', label: 'Spacing', tip: 'How uneven the gaps between words are' },
    { k: 'vBase', label: 'Baseline', tip: 'How far words bob above and below the line' },
    { k: 'vTilt', label: 'Tilt', tip: 'How much each word is rotated on its own' },
    { k: 'vOops', label: 'Cross-outs', max: 3, tip: 'Now and then a word is started, struck out and written again (0 = never)' },
    { head: 'Lines & strokes (× Mess)' },
    { k: 'vDrift', label: 'Wander', tip: 'How far the writing curves off the ruled line (lines climb, sag and wave), and the line start off the margin' },
    { k: 'vWob', label: 'Strokes', tip: 'Wobble of hand-drawn strokes (fraction bars, radicals, arrows, underlines)' },
  ].map(v => (v.head ? v : { min: 0, max: 4, step: 0.05, fmt: xV, ...v }));
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
  let faceAlt = null, faceAltFamily = null; // the same font with its stylistic alternates on (salt)
  let M = null;               // font metrics as fractions of the em (see measureMetrics)
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
  function fontStr(fs, alt) {
    const fam = alt && faceAltFamily ? faceAltFamily : faceFamily;
    return `${fs.toFixed(2)}px ${fam ? `"${fam}", ` : ''}${FALLBACK}`;
  }
  function setText(c, fs, alt) {
    c.font = fontStr(fs, alt);
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
    // A handwriting font often carries a second form of each letter (the user's font has
    // a.alt…z.alt under `salt`). A second face with that feature on lets writeWord mix them.
    if (faceAlt) { document.fonts.delete(faceAlt); faceAlt = null; faceAltFamily = null; }
    if (fontOk) {
      try {
        const fa = new FontFace('EngOrgHandAlt' + faceSeq, src, { featureSettings: '"salt" 1' });
        await fa.load();
        document.fonts.add(fa);
        faceAlt = fa; faceAltFamily = fa.family;
      } catch (_) { /* no alternates: every letter uses its first form */ }
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
    skCache.clear(); wordCache.clear(); ligCache.clear();
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

  // ---- ink on paper ------------------------------------------------------------
  // What makes it read as real ink rather than a font: every mark — a word bitmap or a drawn
  // stroke — is first drawn as a black coverage mask, then finishInk() lays the ink down: grain
  // and uneven flow for the chosen pen type (NIB_INK), slightly ragged paper edges, and the hand's
  // pressure (darker / lighter words). Pages blend ink with `multiply`, so the ruled lines show
  // through and crossings come out darker, as on paper.
  const NOISE_P = new Uint8Array(512), NOISE_V = new Float32Array(256);
  (() => {
    const r = mulberry(0x5eed1e55), a = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    for (let i = 0; i < 512; i++) NOISE_P[i] = a[i & 255];
    for (let i = 0; i < 256; i++) NOISE_V[i] = r();
  })();
  /** Smooth value noise in [0, 1], one lattice cell per unit. */
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255, P = NOISE_P, V = NOISE_V;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = V[P[P[X] + Y]], b = V[P[P[X + 1] + Y]], c = V[P[P[X] + Y + 1]], d = V[P[P[X + 1] + Y + 1]];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  // Per pen type: fq = grain cells per page px, fm = flow cells per page px, rough = edge
  // raggedness, dens(nf, nm) = ink density from the fine grain and the slower flow noise.
  const NIB_INK = {
    gel:       { fq: 1.3, fm: 0.3, rough: 0.22, dens: (nf, nm) => 1 - 0.07 * (1 - nm) - 0.03 * nf },
    // a ball rolling over paper fibres: lighter overall, speckled where it skips
    ballpoint: { fq: 1.9, fm: 0.33, rough: 0.34, dens: (nf, nm) => 0.96 - 0.14 * (1 - nm) - 0.55 * Math.max(0, nf - 0.58) },
    // wet ink: solid, with slow swells of flow across letters
    fountain:  { fq: 1.1, fm: 0.12, rough: 0.16, dens: (nf, nm) => 1 - 0.2 * (1 - nm) - 0.03 * nf },
    // graphite catching the paper's tooth
    pencil:    { fq: 2.6, fm: 0.45, rough: 0.7, dens: (nf, nm) => clamp(0.2 + 0.95 * (0.62 * nf + 0.38 * nm), 0.14, 0.94) },
  };
  // A fountain nib is a flat edge held at an angle: strokes across it (down-strokes) come out
  // thick, strokes along it (the ↗ up-strokes) thin. Up-right 40° in page coordinates (y down).
  const NIB_ANGLE = -40 * Math.PI / 180, NIB_THIN = 0.62, NIB_LONG = 0.75;

  const rgbCache = new Map();
  function inkRgb(col) {
    let v = rgbCache.get(col);
    if (v) return v;
    mcx.fillStyle = '#000'; mcx.fillStyle = col || '#000';
    const s = String(mcx.fillStyle);
    if (s[0] === '#') v = [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
    else { const m = s.match(/[\d.]+/g); v = m ? m.slice(0, 3).map(Number) : [0, 0, 0]; }
    rgbCache.set(col, v);
    return v;
  }

  /** Coverage A (0..1, W×H device px, s px per local unit, pixel (0,0) at local (ox, oy)) → inked
   *  RGBA. `press` is an optional per-column density factor (the hand's pressure along a word). */
  function finishInk(A, W, H, s, ox, oy, J, ink, press) {
    const img = new ImageData(W, H), d = img.data;
    const [r, g, b] = inkRgb(ink);
    const N = J.nib === 'solid' ? null : NIB_INK[J.nib] || NIB_INK.gel;
    const T = N ? clamp(J.tex, 0, 3) : 0, off = J.noiseOff || 0;
    for (let j = 0; j < H; j++) {
      const Y = oy + (j + 0.5) / s;
      for (let i = 0; i < W; i++) {
        const p = j * W + i;
        let a = A[p];
        if (a < 0.004) continue;
        let dens = 1;
        if (T > 0) {
          const X = ox + (i + 0.5) / s + off;
          dens = 1 - T * (1 - N.dens(vnoise(X * N.fq, Y * N.fq), vnoise(X * N.fm + 37.1, Y * N.fm + 11.7)));
          // ink soaks unevenly into the paper's fibres, so an edge is never a clean antialiased line
          if (a < 0.995) a = clamp(a + N.rough * T * (vnoise(X * 3.1 + 71.3, Y * 3.1 + 5.9) - 0.5) * 4 * a * (1 - a), 0, 1);
        }
        if (press) dens *= press[i];
        const q = p * 4;
        d[q] = r; d[q + 1] = g; d[q + 2] = b; d[q + 3] = clamp(a * dens, 0, 1) * 255;
      }
    }
    return img;
  }

  /** Draw a mark through the ink: `fill(m)` paints it (local coords) into a coverage mask covering
   *  [x0,y0]–[x1,y1], which is inked and drawn back onto c under c's current transform. */
  function paintInk(c, x0, y0, x1, y1, J, ink, fill, dim = 1) {
    if (J.nib === 'solid') { c.save(); c.fillStyle = ink; c.strokeStyle = ink; fill(c); c.restore(); return; } // a solid pen: clean, opaque ink
    const T = c.getTransform(), s = clamp(Math.max(Math.hypot(T.a, T.b), Math.hypot(T.c, T.d)), 0.5, 8);
    const W = Math.ceil((x1 - x0) * s), H = Math.ceil((y1 - y0) * s);
    if (!(W > 0 && H > 0)) return;
    if (W * H > 6e6) { c.save(); c.fillStyle = ink; fill(c); c.restore(); return; } // absurdly large: skip the texture
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const m = cv.getContext('2d', { willReadFrequently: true });
    m.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    m.fillStyle = '#000'; m.strokeStyle = '#000';
    fill(m);
    const px = m.getImageData(0, 0, W, H).data, A = new Float32Array(W * H);
    for (let i = 0; i < A.length; i++) A[i] = px[i * 4 + 3] / 255;
    const press = dim !== 1 ? new Float32Array(W).fill(dim) : null;
    m.putImageData(finishInk(A, W, H, s, x0, y0, J, ink, press), 0, 0);
    c.drawImage(cv, x0, y0, W / s, H / s);
  }

  /** Sample the Catmull-Rom curve through pts (same curve EngInk draws) every ~step units. */
  function sampleSmooth(pts, step = 1.2) {
    if (pts.length < 2) return pts.length ? [pts[0], [pts[0][0] + 0.05, pts[0][1]]] : [];
    if (pts.length === 2) {
      const n = Math.max(1, Math.ceil(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / step));
      return Array.from({ length: n + 1 }, (_, i) => [pts[0][0] + (pts[1][0] - pts[0][0]) * i / n, pts[0][1] + (pts[1][1] - pts[0][1]) * i / n]);
    }
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        out.push([u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
                  u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1]]);
      }
    }
    return out;
  }

  /** Append the outline of a round-capped stroke of varying width (ws[i] at pts[i]) to the current
   *  path. Every outline winds the same way, so one nonzero fill unions them with no seams. */
  function strokeOutline(m, pts, ws) {
    const n = pts.length;
    if (n < 2) return;
    const L = [], R = [], ang = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
      const nx = -ty, ny = tx, h = ws[i] / 2;
      L.push([pts[i][0] + nx * h, pts[i][1] + ny * h]); R.push([pts[i][0] - nx * h, pts[i][1] - ny * h]);
      ang.push(Math.atan2(ny, nx));
    }
    m.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < n; i++) m.lineTo(L[i][0], L[i][1]);
    m.arc(pts[n - 1][0], pts[n - 1][1], ws[n - 1] / 2, ang[n - 1], ang[n - 1] - Math.PI, true);
    for (let i = n - 1; i >= 0; i--) m.lineTo(R[i][0], R[i][1]);
    m.arc(pts[0][0], pts[0][1], ws[0] / 2, ang[0] + Math.PI, ang[0], true);
    m.closePath();
  }

  /** A hand-drawn stroke through `pts`: densified with smooth perpendicular wobble, Catmull-Rom
   *  smoothed like EngInk's ink, its width following the hand (a touch heavier where the pen lands,
   *  thinning as it lifts off) and the nib, then inked. `corners` keeps each segment's endpoints
   *  sharp (radicals, brackets). */
  function inkStroke(c, pts, J, o = {}) {
    // o.calm: a smooth, deliberate stroke (brackets, arrowheads) — no wobble at all.
    // o.steady: a straight stroke that may bow a little but starts and ends exactly where aimed,
    // so something else (an arrowhead) can join it.
    const r = J.rng, wob = o.calm ? 0 : (o.wob == null ? 1 : o.wob) * J.wob * (o.steady ? 0.5 : 1);
    // endpoints wander a little, so nothing starts or ends exactly where it was aimed
    if (!o.steady) pts = pts.map(([px, py], i) => (i === 0 || i === pts.length - 1)
      ? [px + (r() - 0.5) * 2.2 * wob, py + (r() - 0.5) * 2.2 * wob] : [px, py]);
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const n = Math.max(2, Math.round(len / 12));
      const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
      // a hand never draws a straight line: a gentle bow across the whole segment, plus a little
      // tremor (kept small: big point-to-point jitter turned lines into zig-zags at high Mess)
      const bow = (r() - 0.5) * Math.min(len * 0.05, 7) * wob;
      const seg = [];
      for (let j = 0; j <= n; j++) {
        const t = j / n, edge = j === 0 || j === n;
        const jit = o.steady ? 0 : (r() - 0.5) * Math.min(1.2, 0.3 + len * 0.006) * wob * (edge ? 0.3 : 1);
        const off = bow * Math.sin(Math.PI * t) + jit;
        seg.push([x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off]);
      }
      segs.push(seg);
    }
    const lines = o.corners ? segs.map(s => sampleSmooth(s)) : [sampleSmooth(segs.reduce((a, s, i) => a.concat(i ? s.slice(1) : s), []))];
    // the width along the stroke
    const flat = J.nib === 'solid', P = flat ? 0 : J.press, fount = J.nib === 'fountain';
    const base = o.width || 1, taper = !o.calm && !o.steady;
    const total = lines.reduce((t, l) => t + l.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0), 0) || 1;
    const flow = P ? nodeNoise(r, total, 14) : null;
    let run = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const widths = lines.map(l => l.map((p, i) => {
      if (i) run += Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]);
      const t = run / total;
      let w = base;
      if (P) {
        w *= 1 + 0.05 * P * flow(run);
        if (t < 0.06) w *= 1 + 0.06 * P * (1 - t / 0.06);                       // the pen lands
        if (taper && t > 0.8) w *= 1 - 0.3 * P * Math.pow((t - 0.8) / 0.2, 2);   // and lifts off moving
      }
      if (fount) {
        const a = l[Math.max(0, i - 1)], b = l[Math.min(l.length - 1, i + 1)];
        w *= NIB_THIN + NIB_LONG * Math.abs(Math.sin(Math.atan2(b[1] - a[1], b[0] - a[0]) - NIB_ANGLE));
      }
      w = Math.max(0.3, w);
      x0 = Math.min(x0, p[0] - w); x1 = Math.max(x1, p[0] + w); y0 = Math.min(y0, p[1] - w); y1 = Math.max(y1, p[1] + w);
      return w;
    }));
    paintInk(c, x0 - 1, y0 - 1, x1 + 1, y1 + 1, J, o.color || J.ink, (m) => {
      m.beginPath();
      lines.forEach((l, i) => strokeOutline(m, l, widths[i]));
      m.fill('nonzero');
    }, J.dim);
  }

  function inkDot(c, x, y, rad, J) {
    const r = J.rng, cx = x + (r() - 0.5) * J.wob, cy = y + (r() - 0.5) * J.wob;
    paintInk(c, cx - rad - 1, cy - rad - 1, cx + rad + 1, cy + rad + 1, J, J.ink, (m) => {
      m.beginPath(); m.ellipse(cx, cy, rad, rad * (0.85 + 0.15 * r()), r() * Math.PI, 0, Math.PI * 2); m.fill();
    }, J.dim);
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
    return { w, h, d, ld, items, at, draw(c, x, y, J) { items.forEach((b, i) => b.draw(c, x + at[i], y, J)); } };
  }

  /** Where a box actually has ink: leaf rectangles [x0, x1, top, bottom] (y down from the
   *  baseline). Line spacing uses this skyline instead of the whole line's bounding box, so a
   *  fraction at one end of a row doesn't push the next row down under its other end. A box
   *  with hand-drawn extras (radical, boxed, …) is one solid rectangle. */
  function inkRects(b, x, y, s, out) {
    if (!b.solid) {
      if (b.kids) { for (const k of b.kids) inkRects(k.b, x + k.dx * s, y - k.dy * s, s, out); return; }
      if (b.items) { b.items.forEach((c, i) => inkRects(c, x + b.at[i] * s, y, s, out)); return; }
      if (b.inner) { inkRects(b.inner, x, y, s * b.s, out); return; }
    }
    if (b.run && M && !b.solid) { runRects(b, x, y, s, out); return; }
    if (b.w > 0 && (b.h > 0 || ldOf(b) > 0)) out.push([x, x + b.w * s, y - b.h * s, y + ldOf(b) * s]);
  }

  /** Children at (dx, dy) — dy is UP-positive from the parent baseline. `extra` draws decorations. */
  function compose(w, kids, extra, min = {}) {
    kids = kids.filter(k => k && k.b);
    let h = min.h || 0, d = min.d || 0, ld = min.d || 0;
    for (const k of kids) { h = Math.max(h, k.dy + k.b.h); d = Math.max(d, k.b.d - k.dy); ld = Math.max(ld, ldOf(k.b) - k.dy); }
    return { w, h, d, ld, kids, solid: !!(extra || min.h || min.d), draw(c, x, y, J) { for (const k of kids) k.b.draw(c, x + k.dx, y - k.dy, J); if (extra) extra(c, x, y, J); } };
  }

  function scaleBox(b, s) {
    return { w: b.w * s, h: b.h * s, d: b.d * s, ld: ldOf(b) * s, inner: b, s, draw(c, x, y, J) { c.save(); c.translate(x, y); c.scale(s, s); b.draw(c, 0, 0, J); c.restore(); } };
  }
  const colorBox = (b, ink) => (ink ? { ...b, draw(c, x, y, J) { b.draw(c, x, y, { ...J, ink }); } } : b);
  const hpad = (b, p) => hlist([kern(p), b, kern(p)]);

  /** One shaped text run (a word, or a run of math letters) — ligatures and contextual
   *  alternates happen here, inside a single fillText. */
  function runBox(text, fs, o = {}) {
    const m = measureRun(text, fs);
    const w = m.w - (o.tight || 0) * fs * Math.max(0, [...text].length - 1) + (o.bold ? 0.04 * fs : 0) + (o.bb ? 0.12 * fs : 0);
    return { w, h: m.h, d: m.d, ld: Math.min(m.d, 0.12 * fs), run: { text, fs, o }, draw(c, x, y, J) { drawRun(c, text, fs, x, y, J, o, w, m); } };
  }

  /** A word's ink column by column, from its traced pen strokes (em bins, cached on the
   *  skeleton): line spacing then reacts to where the letters really are — an h under a subscript
   *  — instead of to the word's whole box. Bottoms stop at `ld` (descender loops may hang into
   *  the next row; writeWord shortens them where they'd hit it). */
  function runRects(b, x, y, s, out) {
    const { text, fs, o } = b.run, sk = skeletonOf(text, false, o);
    if (!sk.prof) {
      const step = 0.08, bins = new Map();
      for (const st of sk.strokes) for (const p of st.pts) {
        const k = Math.floor(p[0] / step), v = bins.get(k);
        if (!v) bins.set(k, [p[1], p[1]]); else { if (p[1] < v[0]) v[0] = p[1]; if (p[1] > v[1]) v[1] = p[1]; }
      }
      for (const d of sk.dots) { const k = Math.floor(d[0] / step), v = bins.get(k); if (!v) bins.set(k, [d[1], d[1]]); else { v[0] = Math.min(v[0], d[1]); v[1] = Math.max(v[1], d[1]); } }
      sk.prof = [...bins].map(([k, v]) => [k * step, (k + 1) * step, v[0], v[1]]);
    }
    const S = fs * s, half = 0.6 * (opts.pen > 0 ? opts.pen : autoPen()) * s, ld = ldOf(b) * s;
    for (const [a, c, t, d] of sk.prof) out.push([x + a * S, x + c * S, y + t * S - half, y + Math.min(d * S + half, ld)]);
  }

  /** How strongly Mess bends letter and word SHAPES. Up to 1 it's Mess itself; past that it grows
   *  a little slower, so a very messy hand gets sloppier mostly in where it puts things. */
  const shapeMess = (k) => (k <= 1 ? k : Math.pow(k, 0.8));
  /** Ruled-row height for a section of text size fs (the same rule layoutSection snaps to). */
  const pitchOf = (fs) => (opts.paper !== 'PLAIN' ? GRID * Math.max(1, Math.ceil(fs * 1.05 / GRID)) : Math.round(fs * 1.3));

  function drawRun(c, text, fs, x, y, J, o, w, m) {
    if (!M) return;
    const k = (o.jit == null ? 1 : o.jit) * J.mess, ke = shapeMess(k), r = J.rng, V = J.v;
    // Text words get their bob, tilt and size in layout, where the line can keep them clear of
    // the lines around it (o.sized). Other runs (math letters, symbols) jitter a little here.
    const own = !o.sized;
    const dy = own ? (r() - 0.5) * 0.1 * fs * k * V.vBase : 0;
    const sc = own ? clamp(1 + (r() - 0.5) * 0.1 * ke * V.vSize, 0.8, 1.25) : 1;
    const rot = own ? (r() - 0.5) * 0.05 * ke * V.vTilt : 0;
    const shear = J.lean + (J.sl || 0) + (r() - 0.5) * 0.07 * ke * V.vSlant + (o.slant ? 0.2 : 0);
    const ink = o.color || J.ink;
    // the descender limit is measured from the item's baseline; a run inside an equation (a
    // denominator, a subscript) sits lower or higher than that, so shift it to this run's own
    let Jw = J;
    if (J.dmax != null && J.toItem) {
      const p = J.toItem.transformPoint(c.getTransform().transformPoint(new DOMPoint(x, y + dy)));
      if (Math.abs(p.y) > 0.5) Jw = { ...J, dmax: J.dmax - p.y };
    }
    const wd = writeWord(text, fs, Jw, ke, o, m);
    // One pen, one weight, for every word at every size (a word written a little smaller is not
    // written with a finer pen). Only really small script text — under 62% of the section's size —
    // gets a slightly finer line so its loops stay open; bold is a firmer hand, not a fat marker.
    const rel = J.size ? fs / J.size : 1;
    const pen = J.pen * (rel < 0.62 ? Math.max(0.72, rel / 0.62) : 1) * (o.bold ? 1.2 : 1);
    const S = fs * sc, tf = (p) => [(p[0] - shear * p[1]) * S, p[1] * S];
    c.save();
    c.translate(x, y + dy); if (rot) c.rotate(rot);
    drawPen(c, wd.lines.map(l => l.map(tf)), wd.dots.map(d => d.map(tf)), pen, J, ink);
    c.restore();
    if (o.ul) inkStroke(c, [[x, y + 0.17 * fs], [x + w, y + 0.17 * fs]], J, { width: stemW(fs, J), color: ink });
  }

  /** Smooth 1-D noise in [-1, 1]: random values at nodes ~`gap` apart (each gap jittered ±25%),
   *  Catmull-Rom between them, so it swells and dips like a hand's rhythm rather than flickering. */
  function nodeNoise(rng, len, gap) {
    const xs = [-gap], vs = [rng() * 2 - 1];
    for (let x = 0; x <= len + gap; ) { xs.push(x); vs.push(rng() * 2 - 1); x += gap * (0.75 + rng() * 0.5); }
    xs.push(xs[xs.length - 1] + gap); vs.push(rng() * 2 - 1);
    let i = 1;
    return (x) => {
      while (i > 1 && x < xs[i]) i--;
      while (i < xs.length - 3 && x >= xs[i + 1]) i++;
      const t = clamp((x - xs[i]) / (xs[i + 1] - xs[i]), 0, 1);
      const p0 = vs[i - 1], p1 = vs[i], p2 = vs[i + 1], p3 = vs[i + 2];
      const v = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
      return clamp(v, -1, 1);
    };
  }

  // ---- letters re-written with the pen ---------------------------------------------------
  // The font is the user's own handwriting, written with one constant-width pen, so every glyph
  // is really a centre line traced by that pen. skeletonOf() recovers the centre lines once per
  // word (rendered big, thinned to one pixel, traced into strokes, cached in em units), and
  // writeWord() re-writes the word through a fresh, slightly different copy of them each time it
  // appears — loops rounder or flatter, ascenders taller or shorter, stroke ends over- or
  // under-shooting, dots landing off-centre, and the font's second form of a letter (`salt`) now
  // and then. The pen then draws those strokes at exactly its own width, so nothing is ever
  // stretched or fattened the way warping a picture of the word did.
  const skCache = new Map(), wordCache = new Map();

  /** Zhang–Suen thinning of a 0/1 image (with a clear 1-px border) down to 1-px centre lines. */
  function thin(B, W, H) {
    let pts = [];
    for (let i = 0; i < B.length; i++) if (B[i]) pts.push(i);
    const del = [];
    for (let changed = true; changed; ) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        del.length = 0;
        for (const i of pts) {
          if (!B[i]) continue;
          const p2 = B[i - W], p3 = B[i - W + 1], p4 = B[i + 1], p5 = B[i + W + 1], p6 = B[i + W], p7 = B[i + W - 1], p8 = B[i - 1], p9 = B[i - W - 1];
          const n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (n < 2 || n > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
        for (const i of del) B[i] = 0;
        if (del.length) changed = true;
      }
      pts = pts.filter(i => B[i]);
    }
  }

  /** The pen's centre lines for `text` in one face: { strokes: [{ pts, e0, e1, closed }], dots:
   *  [[x, y, r]], cuts, adv } in em units from the text origin (y down, baseline 0). `cuts` are
   *  where one letter ends and the next starts (the font's advances, moved to the nearest column
   *  with the least ink so a cut never runs through a letter's body). */
  function skeletonOf(text, alt, o) {
    const key = (alt ? 'A' : 'B') + (o.bb ? 'b' : '') + '|' + text;
    let sk = skCache.get(key);
    if (sk) return sk;
    const R = clamp(Math.round(8 / M.stem), 50, 200); // ~8 px strokes: enough to thin cleanly
    setText(mcx, R, alt);
    const mt = mcx.measureText(text);
    const L = Math.max(0, mt.actualBoundingBoxLeft || 0), asc = Math.max(0, mt.actualBoundingBoxAscent || 0), desc = Math.max(0, mt.actualBoundingBoxDescent || 0);
    const right = Math.max(mt.width, mt.actualBoundingBoxRight || 0), pad = 4;
    const W = Math.ceil(L + right) + 2 * pad, H = Math.ceil(asc + desc) + 2 * pad;
    sk = { strokes: [], dots: [], cuts: [], adv: mt.width / R };
    if (W < 4 || H < 4 || W * H > 5e6) { skCache.set(key, sk); return sk; }
    const ox = L + pad, oy = asc + pad;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    setText(cx, R, alt);
    cx.fillStyle = '#000';
    cx.fillText(text, ox, oy);
    const px = cx.getImageData(0, 0, W, H).data, B = new Uint8Array(W * H);
    for (let i = 0; i < B.length; i++) B[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
    for (let x = 0; x < W; x++) { B[x] = 0; B[(H - 1) * W + x] = 0; }
    for (let y = 0; y < H; y++) { B[y * W] = 0; B[y * W + W - 1] = 0; }
    const toEm = (i) => [((i % W) + 0.5 - ox) / R, (((i / W) | 0) + 0.5 - oy) / R];
    const NB = [-W, -W + 1, 1, W + 1, W, W - 1, -1, -W - 1]; // N NE E SE S SW W NW
    const sw = M.stem * R;
    // letter cuts, from the ink in each column
    const col = new Float32Array(W);
    for (let i = 0; i < B.length; i++) if (B[i]) col[i % W]++;
    const cps = [...text];
    if (cps.length > 1) {
      const rad = 0.2 * R;
      for (let i = 1; i < cps.length; i++) {
        const c0 = ox + mcx.measureText(cps.slice(0, i).join('')).width;
        let best = -1, bv = Infinity;
        for (let x = Math.max(1, Math.round(c0 - rad)); x <= Math.min(W - 2, Math.round(c0 + rad)); x++) {
          const v = col[x] + 0.5 * (col[x - 1] + col[x + 1]) + 0.6 * sw * Math.abs(x - c0) / rad;
          if (v < bv) { bv = v; best = x; }
        }
        if (best < 0) continue;
        const X = (best + 0.5 - ox) / R, prev = sk.cuts.length ? sk.cuts[sk.cuts.length - 1] : -L / R;
        if (X - prev >= 0.14 && right / R - X >= 0.14) sk.cuts.push(X);
      }
    }
    // dots (i, j, periods, colons): small blobs, kept as taps of the pen rather than thinned
    const seen = new Uint8Array(W * H), stack = [];
    for (let s = 0; s < B.length; s++) {
      if (!B[s] || seen[s]) continue;
      const comp = []; stack.push(s); seen[s] = 1;
      let x0 = W, x1 = 0, y0 = H, y1 = 0;
      while (stack.length) {
        const i = stack.pop(); comp.push(i);
        const x = i % W, y = (i / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const d of NB) { const n = i + d; if (B[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
      }
      if (Math.max(x1 - x0, y1 - y0) + 1 <= 2.3 * sw) {
        let sx = 0, sy = 0;
        for (const i of comp) { sx += i % W; sy += (i / W) | 0; B[i] = 0; }
        sk.dots.push([(sx / comp.length + 0.5 - ox) / R, (sy / comp.length + 0.5 - oy) / R, Math.sqrt(comp.length / Math.PI) / R]);
      }
    }
    thin(B, W, H);
    // trace the 1-px centre lines into strokes. A pixel's kind comes from its crossing number
    // (how many separate runs of ink surround it): 1 = a stroke end, 2 = along a stroke, ≥3 = a fork.
    const kind = new Uint8Array(W * H); // 1 end, 2 chain, 3 fork
    for (let i = 0; i < B.length; i++) {
      if (!B[i]) continue;
      let t = 0, n = 0;
      for (let k = 0; k < 8; k++) { n += B[i + NB[k]]; if (!B[i + NB[k]] && B[i + NB[(k + 1) & 7]]) t++; }
      kind[i] = n === 0 ? 1 : t === 1 ? 1 : t === 2 ? 2 : 3;
      if (n === 0) sk.dots.push([...toEm(i), sw / 2 / R]);
    }
    const used = new Uint8Array(W * H), edges = new Set();
    const ek = (a, b) => (a < b ? a * 8388608 + b : b * 8388608 + a);
    const adj = (a, b) => Math.abs((a % W) - (b % W)) <= 1 && Math.abs(((a / W) | 0) - ((b / W) | 0)) <= 1;
    const isNode = (i) => kind[i] !== 2;
    const paths = [];
    const walk = (p, q) => {
      const path = [p];
      let prev = p, cur = q;
      edges.add(ek(p, q));
      for (let guard = 0; guard < 200000; guard++) {
        path.push(cur);
        if (isNode(cur) || cur === p) break;
        used[cur] = 1;
        let best = -1, score = -1;
        for (let k = 0; k < 8; k++) {
          const n = cur + NB[k];
          if (!B[n] || n === prev || edges.has(ek(cur, n)) || (!isNode(n) && used[n] && n !== p)) continue;
          const sc = (adj(n, prev) ? 0 : 2) + (k % 2 === 0 ? 1 : 0); // skip staircase shortcuts; prefer straight steps
          if (sc > score) { score = sc; best = n; }
        }
        if (best < 0) break;
        edges.add(ek(cur, best));
        prev = cur; cur = best;
      }
      return path;
    };
    for (let i = 0; i < B.length; i++) {
      if (!B[i] || !isNode(i)) continue;
      for (const d of NB) {
        const q = i + d;
        if (!B[q] || edges.has(ek(i, q)) || (!isNode(q) && used[q])) continue;
        paths.push(walk(i, q));
      }
    }
    for (let i = 0; i < B.length; i++) { // closed loops with no ends or forks (an o, a 0)
      if (!B[i] || isNode(i) || used[i]) continue;
      used[i] = 1;
      const q = NB.map(d => i + d).find(n => B[n] && !used[n]);
      if (q == null) continue;
      const path = walk(i, q);
      if (path[path.length - 1] !== i && adj(path[path.length - 1], i)) path.push(i);
      paths.push(path);
    }
    for (const path of paths) {
      const e0 = kind[path[0]] === 1, e1 = kind[path[path.length - 1]] === 1;
      const closed = path.length > 3 && path[0] === path[path.length - 1];
      // a short whisker off a fork is an artefact of thinning a corner, not a stroke
      if (path.length < 0.9 * sw && ((e0 && !e1) || (e1 && !e0))) continue;
      let pts = path.map(toEm);
      for (let it = 0; it < 2; it++) { // smooth away the pixel staircase (ends stay put)
        const q = pts.map(p => p.slice());
        for (let j = 1; j < pts.length - 1; j++) { q[j][0] = (pts[j - 1][0] + 2 * pts[j][0] + pts[j + 1][0]) / 4; q[j][1] = (pts[j - 1][1] + 2 * pts[j][1] + pts[j + 1][1]) / 4; }
        pts = q;
      }
      pts = simplify(pts, 0.35 / R);
      sk.strokes.push({ pts: densify(pts, 0.06), e0, e1, closed });
    }
    if (o.bb) { // blackboard bold the way it's hand-written (ℝ ℕ ℤ): the letter's left side drawn again just to its right
      const xcut = -L / R + (L + mt.width) / R * 0.42, dx = 0.12;
      for (const st of sk.strokes.slice()) {
        let run = [];
        const flush = () => { if (run.length > 1) sk.strokes.push({ pts: run.map(p => [p[0] + dx, p[1]]), e0: true, e1: true, closed: false }); run = []; };
        for (const p of st.pts) { if (p[0] < xcut) run.push(p); else flush(); }
        flush();
      }
    }
    if (skCache.size > 4000) skCache.delete(skCache.keys().next().value);
    skCache.set(key, sk);
    return sk;
  }

  /** Ramer–Douglas–Peucker. */
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      let far = -1, fd = eps;
      for (let i = a + 1; i < b; i++) {
        // a closed loop starts and ends on the same point: measure from that point instead
        const d = len < 1e-6 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
        if (d > fd) { fd = d; far = i; }
      }
      if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  /** Points no more than `step` apart, so a smooth deformation can bend long straight runs too. */
  function densify(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
      for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
    }
    return out;
  }

  /** One written instance of `text`: { lines, dots } in em units (x right, y down from the
   *  baseline), re-written from the skeletons with this instance's own variation:
   *   - which letters use the font's alternate form (vAlt);
   *   - per LETTER, as a correlated sequence (Rhythm = nodeGap): x-height, ascender and descender
   *     length (each on its own), width, slant, bob and the gap before it — each letter moves as
   *     a whole, blending only across the narrow seam where it meets the next;
   *   - a smooth, gentle bend through the strokes (vShape), so curves and loops differ each time;
   *   - stroke ends that stop a little short or run on, and dots that land off-centre;
   *   - descenders shortened where the line below would otherwise be hit (J.dmax).
   *  The pen draws all of it at one width, so none of this changes the stroke. Cached per item. */
  function writeWord(text, fs, J, kL, o, m) {
    const V = J.v, vS = V.vShape == null ? 1 : V.vShape;
    const pAlt = faceAltFamily ? clamp(V.vAlt == null ? 0.35 : V.vAlt, 0, 1) * Math.min(1, J.mess) : 0;
    const pJoin = clamp(V.vJoin == null ? 0.6 : V.vJoin, 0, 1) * Math.min(1, 1.5 * J.mess);
    const tight = o.tight || 0; // em taken out of each gap between letters (the hand writes tighter than the font)
    const pitchEm = (J.pitch || 1.07 * fs) / fs, dmaxEm = J.dmax != null ? J.dmax / fs : Infinity;
    const ck = [J.key, J.seed, text, fs.toFixed(2), kL.toFixed(3), V.vLetter, V.vLetterW, V.vWave, V.vSlant, vS, pAlt.toFixed(2), pJoin.toFixed(2), tight.toFixed(3), V.nodeGap,
      o.stretch ? o.stretch.toFixed(1) : '', o.bb ? 1 : 0, pitchEm.toFixed(3), Number.isFinite(dmaxEm) ? dmaxEm.toFixed(2) : ''].join('|');
    let wd = wordCache.get(ck);
    if (wd) return wd;
    const rng = rngFor('write|' + J.key + '|' + text, J.seed);
    const gauss = () => (rng() + rng() + rng() + rng() - 2) * 1.732; // ≈ N(0, 1), bounded
    // Which form each letter takes. The font's joined pairs (its ligatures: th, he, in, er… the
    // user's own conjoined letters) only form inside one run of the FIRST form, so a letter in such
    // a pair keeps the first form — splitting them was what made the writing look unjoined. Other
    // letters switch to the alternate now and then, in short runs rather than letter by letter.
    const cps = [...text], chunks = [];
    const bound = cps.map(() => false);
    for (let i = 0; i + 1 < cps.length; i++) if (ligPair(cps[i], cps[i + 1])) bound[i] = bound[i + 1] = true;
    let prevAlt = false;
    for (let i = 0; i < cps.length; i++) {
      const ch = cps[i];
      let alt = false;
      if (pAlt > 0 && /\p{Ll}/u.test(ch) && !(bound[i] && rng() < 0.9)) alt = rng() < (prevAlt ? Math.min(0.85, pAlt * 1.8) : pAlt);
      prevAlt = alt;
      if (chunks.length && chunks[chunks.length - 1].alt === alt) chunks[chunks.length - 1].t += ch;
      else chunks.push({ t: ch, alt });
    }
    let off = 0;
    const strokes = [], dots = [], segs = [];
    for (const ch of chunks.length ? chunks : [{ t: text, alt: false }]) {
      const sk = skeletonOf(ch.t, ch.alt, o);
      for (const s of sk.strokes) strokes.push({ ...s, pts: s.pts.map(p => [p[0] + off, p[1]]) });
      for (const d of sk.dots) dots.push([d[0] + off, d[1], d[2]]);
      const e = [0, ...sk.cuts, sk.adv];
      for (let i = 0; i < e.length - 1; i++) segs.push([e[i] + off, e[i + 1] + off]);
      off += sk.adv;
    }
    // the width the line laid out for this word: the font's, less the hand's tighter spacing. The
    // difference (and any from the alternates' widths) goes into the gaps between letters, never
    // into the letters themselves.
    const target = m.w / fs - tight * Math.max(0, cps.length - 1);
    const extra = target - off;
    // a tall bracket: its straight middle gets longer, its ends keep their shape
    if (o.stretch) {
      const top = -m.h / fs, bot = m.d / fs, hh = bot - top || 1;
      const bands = text === '{' || text === '}' ? [[0.22, 0.4], [0.6, 0.78]] : [[0.32, 0.68]];
      const add = o.stretch / fs / bands.length;
      const sy = (y) => {
        let dy = 0;
        for (const [a, b] of bands) {
          const ya = top + a * hh, yb = top + b * hh;
          if (y <= ya) break;
          if (y < yb) return y + dy + (y - ya) / (yb - ya) * add;
          dy += add;
        }
        return y + dy;
      };
      for (const s of strokes) for (const p of s.pts) p[1] = sy(p[1]);
      for (const d of dots) d[1] = sy(d[1]);
    }
    // ---- per-letter moves ----
    const n = segs.length, flow = V.nodeGap || 1, rho = clamp(1 - 0.55 / flow, 0, 0.9), inn = Math.sqrt(1 - rho * rho);
    // A real hand is CONSISTENT letter to letter — same size, same lean, letters never touching —
    // and imperfect only in small ways. (Bigger per-letter swings read as a scramble, not as a
    // messier hand; past Mess 2 a hand gets sloppier in placement, not in its letters.)
    const kc = Math.min(kL, 2);
    const aX = 0.04 * kc * V.vLetter, aA = 0.08 * kc * V.vLetter, aD = 0.08 * kc * V.vLetter, aWd = 0.035 * kc * V.vLetter;
    const aH = 0.06 * kc * V.vSlant, aB = 0.025 * kc * V.vWave, aG = 0.02 * Math.min(kc, 1.5) * V.vLetterW;
    const st = [gauss(), gauss(), gauss(), gauss(), gauss(), gauss()];
    const Ls = [];
    for (let i = 0; i < n; i++) {
      if (i) for (let j = 0; j < st.length; j++) st[j] = rho * st[j] + inn * gauss();
      const [gx, ga, gd, gw, gh, gb] = st;
      Ls.push({ a: segs[i][0], b: segs[i][1], sx: 1 + clamp(aX * gx, -0.1, 0.12), sa: 1 + clamp(aA * ga, -0.18, 0.2), sd: 1 + clamp(aD * gd, -0.2, 0.18),
        sw: 1 + clamp(aWd * (0.6 * gx + 0.8 * gw), -0.1, 0.12), sh: clamp(aH * gh, -0.15, 0.15), bob: clamp(aB * gb, -0.05, 0.05), gap: i ? aG * gauss() : 0 });
    }
    if (n) { // relative to the word: its overall size, slant, height and length don't move
      const wsum = Ls.reduce((t, l) => t + (l.b - l.a), 0) || 1;
      const mx = Ls.reduce((t, l) => t + l.sx * (l.b - l.a), 0) / wsum, mw = Ls.reduce((t, l) => t + l.sw * (l.b - l.a), 0) / wsum;
      const mb = Ls.reduce((t, l) => t + l.bob, 0) / n, mh = Ls.reduce((t, l) => t + l.sh, 0) / n;
      const mg = n > 1 ? Ls.reduce((t, l) => t + l.gap, 0) / (n - 1) : 0;
      let A = Ls[0].a;
      for (let i = 0; i < n; i++) {
        const l = Ls[i];
        l.sx /= mx; l.sw /= mw; l.bob -= mb; l.sh -= mh;
        if (i) { l.gap += -mg + extra / (n - 1); A += l.gap; }
        l.A = A; A += (l.b - l.a) * l.sw;
      }
      const over = A - (Ls[n - 1].b + (n > 1 ? extra : 0)), span = (Ls[n - 1].b - Ls[0].a) || 1;
      for (const l of Ls) l.A -= over * (l.a - Ls[0].a) / span;
    }
    // descenders: a hand writing in a ruled row keeps loops short of the line below
    let deep = 0;
    for (const s of strokes) for (const p of s.pts) if (p[1] > deep) deep = p[1];
    const lim = Math.min(0.66 * pitchEm, Math.max(0.15, dmaxEm)), knee = 0.55 * lim;
    const squash = deep * 1.1 > lim && deep > knee ? clamp((lim - knee) / (deep * 1.1 - knee), 0.15, 1) : 1;
    const xh = M.xh, rw = 0.06;
    const zone = (l, y) => {
      if (y < -xh) return -xh * l.sx + (y + xh) * l.sa;
      if (y <= 0) return y * l.sx;
      const yy = y * l.sd;
      return yy > knee ? knee + (yy - knee) * squash : yy;
    };
    const move = (l, x, y) => { const Y = zone(l, y); return [l.A + (x - l.a) * l.sw - l.sh * Y, Y + l.bob]; };
    // Letters may come close enough to touch, as in a quick hand, but never pile into each other:
    // where the moves (or the tighter spacing) would close more than ~60% of the space the font had
    // between two letters, the rest of the word steps right. Overlaps the font has (a t bar) stay.
    if (n > 1) {
      const lo = Array(n).fill(Infinity), hi = Array(n).fill(-Infinity), slo = Array(n).fill(Infinity), shi = Array(n).fill(-Infinity);
      for (const st of strokes) for (const p of st.pts) {
        let i = 0;
        while (i < n - 1 && p[0] > Ls[i].b) i++;
        const q = move(Ls[i], p[0], p[1]);
        if (p[0] < slo[i]) slo[i] = p[0]; if (p[0] > shi[i]) shi[i] = p[0];
        if (q[0] < lo[i]) lo[i] = q[0]; if (q[0] > hi[i]) hi[i] = q[0];
      }
      const penEm = (J.pen || 2) / fs;
      let shift = 0, last = 0;
      for (let i = 1; i < n; i++) {
        Ls[i].A += shift; lo[i] += shift; hi[i] += shift;
        if (Number.isFinite(hi[i - 1])) last = i - 1;
        if (!Number.isFinite(lo[i]) || !Number.isFinite(hi[last])) continue;
        const src = slo[i] - shi[last], gap = lo[i] - hi[last];
        const need = src > 0 ? Math.max(0.42 * src, Math.min(src, 0.55 * penEm)) : src - 0.015;
        if (gap < need) { const d = need - gap; shift += d; Ls[i].A += d; lo[i] += d; hi[i] += d; }
      }
      // whatever the word had to spread is shared between the spaces before and after it
      if (shift > 0) for (const l of Ls) l.A -= shift / 2;
    }
    // the smooth bend that makes each copy of a letter its own shape
    const aF = 0.015 * kc * vS, fq = 3.3, o1 = rng() * 200, o2 = rng() * 200 + 300;
    const place = (x, y) => {
      if (aF > 0) { const bx = (vnoise(x * fq + o1, y * fq + o1) - 0.5) * 2 * aF, by = (vnoise(x * fq + o2, y * fq + o2) - 0.5) * 2 * aF; x += bx; y += by; }
      if (!n) return [x, y];
      let i = 0;
      while (i < n - 1 && x > Ls[i].b) i++;
      const p = move(Ls[i], x, y);
      // across the seam to a neighbour, blend the two moves so a joining stroke bends, not breaks
      const sR = i < n - 1 ? Ls[i].b : Infinity, sL = i > 0 ? Ls[i - 1].b : -Infinity;
      const sm = (u) => u * u * (3 - 2 * u);
      let j = -1, t = 0;
      if (x > sR - rw / 2) { j = i + 1; t = sm((x - sR + rw / 2) / rw); }
      else if (x < sL + rw / 2) { j = i - 1; t = 1 - sm((x - sL + rw / 2) / rw); }
      if (j < 0) return p;
      const q = move(Ls[j], x, y);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    };
    // stroke ends: the pen stops a touch early or runs on a little past where the font ends
    const aE = 0.015 * kc * vS;
    const lines = [];
    for (const s of strokes) {
      let pts = s.pts;
      if (aE > 0 && pts.length > 2 && !s.closed) {
        pts = pts.slice();
        if (s.e1) pts = endShift(pts, clamp(aE * gauss(), -0.03, 0.04));
        if (s.e0) pts = endShift(pts.reverse(), clamp(aE * gauss(), -0.03, 0.04)).reverse();
      }
      lines.push(pts.map(p => place(p[0], p[1])));
    }
    // Joins: a quick hand runs the end of one letter on into the start of the next. Where a letter
    // has a free stroke end low on its right side and the next one a free start on its left, close
    // enough, the pen carries on between them in one smooth curve (an upstroke into an n, a flick
    // along the baseline into an e). Each pair joins with probability pJoin (vJoin × Mess).
    if (pJoin > 0 && n > 1) {
      const ends = [];
      strokes.forEach((st, k) => {
        if (st.closed || !lines[k] || lines[k].length < 2) return;
        const L = lines[k];
        if (st.e0) ends.push({ src: st.pts[0], out: L[0], dir: [L[0][0] - L[1][0], L[0][1] - L[1][1]] });
        if (st.e1) ends.push({ src: st.pts[st.pts.length - 1], out: L[L.length - 1], dir: [L[L.length - 1][0] - L[L.length - 2][0], L[L.length - 1][1] - L[L.length - 2][1]] });
      });
      const letterOf = (x) => { let i = 0; while (i < n - 1 && x > Ls[i].b) i++; return i; };
      for (const e of ends) { const i = letterOf(e.src[0]); e.i = i; e.rel = (e.src[0] - Ls[i].a) / ((Ls[i].b - Ls[i].a) || 1); }
      const band = (y) => y > -M.xh - 0.12 && y < 0.08;
      const top = Array(n).fill(0); // highest ink of each letter: punctuation never reaches the x-height
      for (const st of strokes) for (const p of st.pts) { const i = letterOf(p[0]); if (p[1] < top[i]) top[i] = p[1]; }
      const letterish = (i) => top[i] < -0.6 * M.xh;
      for (let i = 0; i < n - 1; i++) {
        if (rng() >= pJoin || !letterish(i) || !letterish(i + 1)) continue;
        let best = null, bd = Infinity;
        for (const a of ends) {
          if (a.i !== i || a.rel < 0.5 || !band(a.src[1])) continue;
          for (const b of ends) {
            if (b.i !== i + 1 || b.rel > 0.5 || !band(b.src[1])) continue;
            const dx = b.out[0] - a.out[0], dy = b.out[1] - a.out[1], d = Math.hypot(dx, dy);
            if (dx < -0.02 || dx > 0.42 || d > 0.5 || d < 0.02) continue;
            if (d < bd) { bd = d; best = [a, b]; }
          }
        }
        if (!best) continue;
        const [a, b] = best;
        // leave the first letter the way its stroke was heading, arrive at the second's start
        const la = Math.hypot(a.dir[0], a.dir[1]) || 1, lb = Math.hypot(b.dir[0], b.dir[1]) || 1;
        const c1 = [a.out[0] + a.dir[0] / la * bd * 0.35, a.out[1] + a.dir[1] / la * bd * 0.35];
        const c2 = [b.out[0] + b.dir[0] / lb * bd * 0.35, b.out[1] + b.dir[1] / lb * bd * 0.35];
        const curve = [];
        for (let k = 0; k <= 8; k++) {
          const t = k / 8, u = 1 - t;
          curve.push([u * u * u * a.out[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b.out[0],
                      u * u * u * a.out[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b.out[1]]);
        }
        lines.push(curve);
        a.i = b.i = -1; // each end joins once
      }
    }
    // is there a letter stem right under this dot? (an i or j, not a colon or a period)
    const overStem = (x, y) => strokes.some(s => s.pts.some(p => Math.abs(p[0] - x) < 0.1 && p[1] > y + 0.08 && p[1] < y + 0.6));
    const outDots = dots.map(([x, y]) => {
      // a dot is a quick tap. The dot of an i or j is put on afterwards and lands a little right
      // of where it belongs, higher or lower; periods and colons stay where they are.
      const free = y < -0.3 && overStem(x, y) ? 1 : 0.2;
      const p = place(x + (0.005 + 0.03 * rng()) * kc * vS * free, y + 0.02 * kc * vS * gauss() * free);
      const fl = 0.004 + 0.02 * rng() * Math.min(kc, 1.5); // and sometimes drags into a tiny flick
      return [p, [p[0] + fl * 0.8, p[1] - fl * 0.6]];
    });
    wd = { lines, dots: outDots };
    if (wordCache.size > 8000) wordCache.delete(wordCache.keys().next().value);
    wordCache.set(ck, wd);
    return wd;
  }

  /** Does the font write these two letters as one joined glyph (a ligature)? The font has no
   *  kerning, so a pair whose shaped width differs from its letters' widths is a ligature. */
  const ligCache = new Map();
  function ligPair(a, b) {
    const k = a + b;
    let v = ligCache.get(k);
    if (v == null) {
      setText(mcx, 100);
      v = Math.abs(mcx.measureText(k).width - mcx.measureText(a).width - mcx.measureText(b).width) > 0.6;
      ligCache.set(k, v);
    }
    return v;
  }

  /** Lengthen (e > 0, along the end's direction) or shorten (e < 0) a stroke at its last point. */
  function endShift(pts, e) {
    const n = pts.length, a = pts[Math.max(0, n - 4)], b = pts[n - 1];
    if (e > 0) {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      pts.push([b[0] + (b[0] - a[0]) / d * e, b[1] + (b[1] - a[1]) / d * e]);
      return pts;
    }
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let cut = Math.min(-e, total * 0.35);
    while (pts.length > 2 && cut > 0) {
      const p = pts[pts.length - 1], q = pts[pts.length - 2], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d <= cut) { pts.pop(); cut -= d; } else { const t = cut / d; pts[pts.length - 1] = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; cut = 0; }
    }
    return pts;
  }

  /** Draw pen strokes (and dot taps) at the pen's width: straight onto the page for a solid pen,
   *  through the ink texture (paintInk) for the others; a fountain nib's width follows direction. */
  function drawPen(c, lines, dots, pen, J, ink) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of lines) for (const p of l) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    for (const d of dots) for (const p of d) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    if (!Number.isFinite(x0)) return;
    const pad = pen * 1.5 + 1, fount = J.nib === 'fountain';
    paintInk(c, x0 - pad, y0 - pad, x1 + pad, y1 + pad, J, ink, (m) => {
      if (fount) {
        m.beginPath();
        for (const l of lines) {
          const ws = l.map((p, i) => {
            const a = l[Math.max(0, i - 1)], b = l[Math.min(l.length - 1, i + 1)];
            return pen * (NIB_THIN + NIB_LONG * Math.abs(Math.sin(Math.atan2(b[1] - a[1], b[0] - a[0]) - NIB_ANGLE)));
          });
          strokeOutline(m, l, ws);
        }
        m.fill('nonzero');
      } else {
        m.lineWidth = pen; m.lineCap = 'round'; m.lineJoin = 'round';
        m.beginPath();
        for (const l of lines) { m.moveTo(l[0][0], l[0][1]); for (let i = 1; i < l.length; i++) m.lineTo(l[i][0], l[i][1]); if (l.length === 1) m.lineTo(l[0][0] + 0.01, l[0][1]); }
        m.stroke();
      }
      // dot taps a touch heavier than the line, the way a pen pauses on them
      m.lineWidth = pen * 1.12; m.lineCap = 'round';
      m.beginPath();
      for (const [a, b] of dots) { m.moveTo(a[0], a[1]); m.lineTo(b[0], b[1]); }
      m.stroke();
    }, J.dim);
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
    // a hand keeps numerator and denominator close to the bar, so a display fraction fits in
    // about two ruled rows instead of three
    const ax = M.axis * fs, t = M.stem * fs, gap = (disp ? 0.12 : 0.1) * fs + (bar ? 0 : 0.08 * fs), pad = 0.1 * fs;
    const w = Math.max(num.w, den.w) + 2 * pad;
    const nDy = ax + t / 2 + gap + num.d, dDy = ax - t / 2 - gap - den.h;
    const b = compose(w, [{ b: num, dx: (w - num.w) / 2, dy: nDy }, { b: den, dx: (w - den.w) / 2, dy: dDy }],
      bar ? (c, x, y, J) => inkStroke(c, [[x + 0.03 * fs, y - ax], [x + w - 0.03 * fs, y - ax + (J.rng() - 0.5) * 1.5 * J.wob]], J, { width: stemW(fs, J) }) : null);
    b.solid = false; // the bar sits between num and den, so their own ink is the skyline
    return b;
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

  // Delimiters: always the font's own glyph, stretched when it must be taller. Only shapes a
  // handwriting font rarely has (floor/ceil, angle, double bar) are drawn as strokes.
  const DRAWN_ONLY = new Set(['⌊', '⌋', '⌈', '⌉', '‖', '⟨', '⟩']);
  /** The glyph's own ink height (its h + d) at size fs — not cap + descender: a handwriting
   *  font's descender can be over an em, which made every bracket twice the height it needed. */
  const glyphH = (ch, fs) => { const m = measureRun(ch, fs); return m.h + m.d; };
  function delimBox(ch, h, d, fs) {
    if (!ch || ch === '.') return kern(0.05 * fs);
    const ax = M.axis * fs, ext = Math.max(h - ax, d + ax) + 0.06 * fs;
    return sizedDelim(ch, ext, fs);
  }

  /** A delimiter reaching `ext` above and below the math axis. The font glyph is used as is when
   *  it's tall enough. A taller one is set a little larger (s^¼, so its ends grow a bit like a
   *  hand's do) and its straight middle is lengthened the rest of the way (writeWord, o.stretch). */
  function sizedDelim(ch, ext, fs) {
    const gh = glyphH(ch, fs);
    if (DRAWN_ONLY.has(ch) || !(gh > 0.2 * fs)) return drawnDelim(ch, Math.max(ext, 0.5 * fs), fs);
    const ax = M.axis * fs, s = (2 * ext) / gh;
    if (s <= 1.1) return runBox(ch, fs, { jit: 0.4 });
    const sz = fs * Math.pow(s, 0.25), m = measureRun(ch, sz);
    const extra = Math.max(0, 2 * ext - (m.h + m.d));
    const w = m.w, o = { jit: 0.4, stretch: extra };
    // baseline placed so the stretched glyph's centre sits on the axis
    const yb = -ax - (m.d + extra - m.h) / 2;
    return { w, h: ax + ext, d: ext - ax, draw(c, x, y, J) { drawRun(c, ch, sz, x, y + yb, J, o, w, m); } };
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
        // a hand writes a display ∫ about a line and a half tall, not TeX's ~2 lines — that keeps
        // a row of working inside two ruled rows
        const k = integral ? (st.disp ? 1.45 : 1.2) : (st.disp ? 1.3 : 1.1);
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
      // \big … \Bigg: that multiple of the font's own ( height
      case 'bigdelim': return { b: a.ch === '.' ? kern(0.05 * fs) : sizedDelim(a.ch, glyphH('(', fs) * a.scale / 2, fs), cls: a.cls };
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
    const alignEnv = /^(aligned|alignedat|split|align|flalign|eqnarray)/.test(env);
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
    // trailing empty cells (flalign's `… &&`) would otherwise become the "last cell" the
    // overflow breaker splits — an empty one yields no pieces and the whole row vanished
    const rows = splitTop(s, 'row').map(r => {
      const cells = splitTop(r, 'cell');
      while (cells.length > 1 && !cells[cells.length - 1].trim()) cells.pop();
      return cells.map(c => parseMath(c));
    });
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
    if (/\\begin\{document\}|\\(sub)*section|\\item|\$|\\\[|\\\(|\\begin\{(equation|(?:fl)?align|gather|multline|eqnarray|displaymath|itemize|enumerate|description)|\\(noindent|textbf|textit|paragraph)(?![a-zA-Z])/.test(src)) return 'doc';
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
    const S = { prevBase: null, prevD: 0, prevBot: null, pendGap: 0, atTop: true };
    sections.forEach((sec, i) => layoutSection(sec.flow, sec.o, out, S, i));
    for (const pg of out) limitDescenders(pg);
    return out.filter((pg, i) => pg.length || i === 0);
  }

  /** The font's descender loops hang over an em — further than a ruled row. A hand writing in
   *  rows keeps them short of the next line's letters, so each item gets `dmax`: how far below
   *  its baseline its ink may reach before the tallest ink of the line(s) under it (writeWord
   *  folds longer descenders up to fit). */
  function limitDescenders(items) {
    const rows = items.filter(it => it.tops).sort((a, b) => a.y - b.y);
    for (let i = 0; i < rows.length; i++) {
      const it = rows[i], fs = it.o.size, x0 = it.x - 0.1 * fs, x1 = it.x + it.box.w + 0.1 * fs;
      let lim = Infinity;
      for (let j = i + 1; j < rows.length; j++) {
        const q = rows[j];
        if (q.y <= it.y + 0.4 * it.pitch) continue;
        if (q.y > it.y + 2.2 * it.pitch) break;
        for (const [a, b, top] of q.tops) if (b > x0 && a < x1) lim = Math.min(lim, top - it.y - 0.06 * fs);
      }
      if (Number.isFinite(lim)) it.dmax = Math.max(0.12 * fs, lim);
    }
  }

  function layoutSection(flow, so, out, S, si) {
    const fs = so.size, snap = opts.paper !== 'PLAIN';
    const pitch = pitchOf(fs);
    const nomH = pitch * 0.72, nomD = pitch * 0.28;
    const maxW = PAGE_W - MARGIN_L - MARGIN_R;
    let { prevBase, prevD, prevBot, pendGap, atTop } = S;
    if (prevBase == null) prevBase = MARGIN_T - pitch;
    else if (!atTop) pendGap = Math.max(pendGap, pitch * 0.5); // a new section starts a new paragraph
    let line = [], lineX = 0, nContent = 0, pendSpace = false, indent = 0, align = 'left', deco = null;
    const lists = [];
    const occ = new Map();
    const keyOf = (s) => { const n = (occ.get(s) || 0) + 1; occ.set(s, n); return si + '|' + s + '#' + n; };
    const counters = [0, 0, 0, 0];

    // ---- the hand ----------------------------------------------------------------------------
    // A real hand doesn't roll a fresh random size, slant and gap for every word: it swells and
    // shrinks over a few words, leans further as it speeds up, loosens and tightens its spacing.
    // These drifts run along the writing distance t (line number × line width + x), so they
    // change smoothly word to word and carry on across line breaks. Per-word randomness rides on top.
    const hr = (tag) => rngFor('hand|' + tag + '|' + si, so.seed);
    const WORD = 2.6 * fs, TLEN = 3e5;
    const hSize = nodeNoise(hr('size'), TLEN, 3 * WORD), hSlant = nodeNoise(hr('slant'), TLEN, 4 * WORD), hGap = nodeNoise(hr('gap'), TLEN, 2 * WORD);
    const hMargin = nodeNoise(hr('margin'), 3000, 3), hLine = nodeNoise(hr('lines'), 3000, 2.5);
    const climb = hr('trait')() * 2 - 1; // this writer's lines tend to climb (or sag) to the right
    let lineNo = 0;
    const tNow = () => (lineNo * maxW + lineX) % TLEN;

    function newPage() { if (out.length < 300) out.push([]); prevBase = MARGIN_T - pitch; prevD = 0; prevBot = null; atTop = true; }

    function placeLine(items, w, h, d, al, x0, dec, eq = false) {
      const xL = al === 'center' ? MARGIN_L + (maxW - w) / 2 : MARGIN_L + x0;
      // this line's ink skyline, relative to its baseline
      const rects = [];
      for (const it of items) inkRects(it.box, xL + it.dx, 0, 1, rects);
      if (dec) rects.push([xL, xL + w, 0, d]);
      let base;
      if (prevBot && !atTop) {
        // Use the very next ruled line unless ink would actually collide: the lowest point of the
        // line above, column by column, against this line's highest point in the same column
        // (± a bin for drift). A fraction at one end of a row no longer pushes the whole next row down.
        let ink = -Infinity;
        const clr = 0.1 * fs;
        for (const [a, b, top] of rects) {
          const i0 = Math.max(0, Math.floor(a / INK_BIN) - 1), i1 = Math.min(prevBot.length - 1, Math.floor(b / INK_BIN) + 1);
          for (let i = i0; i <= i1; i++) if (prevBot[i] > -Infinity) ink = Math.max(ink, prevBot[i] - top + clr);
        }
        base = prevBase + pitch + pendGap;
        // the snap may lift a line slightly into the row above (tall letters crossing the rule),
        // but never so far that its ink lands on that row's ink. A near-miss (a subscript above
        // a tall letter) doesn't cost a whole blank row: the words that would touch are lowered
        // a little on their own below. Display rows can't do that, so they keep a full clearance.
        if (snap) { base = Math.ceil((base - 0.22 * GRID) / GRID) * GRID; while (base < ink - (eq ? 0 : 0.4 * fs) + pendGap) base += GRID; }
        else base = Math.max(base, ink + pendGap);
      } else {
        base = prevBase + pitch + Math.max(0, prevD - nomD) + Math.max(0, h - nomH) + (atTop ? 0 : pendGap);
        // sit on the ruled line; tall letters may overlap the line above a little, like real handwriting
        if (snap) base = Math.ceil((base - 0.22 * GRID) / GRID) * GRID;
      }
      if (base + d > PAGE_H - MARGIN_B && !atTop) { newPage(); placeLine(items, w, h, d, al, x0, dec, eq); return; }
      const above = prevBot && !atTop ? prevBot : null; // the line above's ink, column by column
      pendGap = 0; atTop = false;
      // Messiness, the way a hand drifts. The baseline is a smooth curve — a slight climb or sag
      // across the line (this writer's habit, varying line to line) plus a slow wave that rises and
      // falls every `so.group` words or so — and each word sits on it as a rigid unit, turned to the
      // curve's slope plus a little tilt and bob of its own. On ruled, grid or dot paper the hand
      // follows the guide: writing floats a little above the line, dips only slightly below it,
      // and no word may reach the ink of the line above (it's lowered until it clears). On plain
      // paper whole lines are free to climb and sag. The line start wanders a little off the margin.
      const mess = so.mess * so.vDrift, key0 = items[0] ? items[0].key : '';
      const lr = rngFor('line|' + key0, so.seed);
      const page = out[out.length - 1];
      // On guide paper a hand sets every word down ON the line — letters touch it, a few float a
      // hair above, almost none sink below — so the guided bounds are tight and lopsided upward.
      const up = (snap ? 0.17 : 0.4) * fs * mess + 0.5, down = (snap ? 0.05 : 0.4) * fs * mess + 0.5;
      // a display equation is one wide item: tilting it would swing its far end into the next row
      // and drifting it would break the = alignment of an align block, so it only shifts slightly
      // (its symbols still tilt and bob individually in drawRun)
      const drift = eq ? (lr() - 0.5) * 3 * mess : mess * (4 * hMargin(lineNo) + 3 * (lr() - 0.5));
      const ox = (al === 'center' ? MARGIN_L + (maxW - w) / 2 : MARGIN_L + x0) + drift;
      const G = Math.max(1, Math.round(so.group) || 3), gap = G * WORD * 0.85;
      const slope = mess * (snap ? 0.002 * climb + 0.003 * hLine(lineNo) : 0.007 * climb + 0.012 * hLine(lineNo));
      const wave = nodeNoise(lr, w + gap, gap), amp = (snap ? 0.06 : 0.14) * fs * mess;
      const y0 = snap ? -0.03 * fs + (lr() - 0.5) * 0.05 * fs * mess : (lr() - 0.5) * 0.08 * fs * mess;
      const yAt = (x) => (eq ? clamp(y0, -2, 2) : clamp(y0 + slope * x + amp * wave(x), -up, down));
      const clr = 0.08 * fs, NBIN = Math.ceil(PAGE_W / INK_BIN) + 1;
      const bins = (a, b) => [Math.max(0, Math.floor(a / INK_BIN)), Math.min(NBIN - 1, Math.floor(b / INK_BIN))];
      const below = new Float64Array(NBIN).fill(-Infinity);
      for (const it of items) {
        const R = [];
        inkRects(it.box, xL + it.dx + drift, 0, 1, R);
        const sx = ox + it.dx, xa = Math.max(0, it.dx), xb = xa + Math.max(1, it.box.w);
        let yy = eq ? yAt(0) : clamp(yAt(xa) + (it.bob || 0), -up, down);
        let rot = eq ? 0 : clamp(Math.atan2(yAt(xb) - yAt(xa), xb - xa) + (it.tilt || 0), -0.1, 0.1);
        const sr = Math.sin(rot);
        const lift = (a, b) => Math.min((a - sx) * sr, (b - sx) * sr), sink = (a, b) => Math.max((a - sx) * sr, (b - sx) * sr);
        if (above && !eq) {
          // lowest the line above reaches over this word vs. this word's highest ink
          let need = -Infinity;
          for (const [a, b, top] of R) {
            const t = base + yy + top + lift(a, b);
            const [i0, i1] = bins(a, b);
            for (let i = i0; i <= i1; i++) if (above[i] > -Infinity) need = Math.max(need, above[i] + clr - t);
          }
          // step down only a little: a hand tucks the word under, it doesn't drop it a row
          if (need > 0) { yy += Math.min(need, 0.18 * fs); if (Math.abs(rot) > 0.02) rot *= 0.5; }
        }
        const sr2 = Math.sin(rot), tops = [];
        for (const [a, b, top, bot] of R) {
          const lo = base + yy + bot + Math.max((a - sx) * sr2, (b - sx) * sr2);
          const [i0, i1] = bins(a, b);
          for (let i = i0; i <= i1; i++) below[i] = Math.max(below[i], lo);
          tops.push([a, b, base + yy + top + Math.min((a - sx) * sr2, (b - sx) * sr2)]);
        }
        page.push({ box: it.box, key: it.key, x: sx, y: base + yy, rot, sl: it.sl || 0, o: so, tops, pitch });
      }
      if (dec) {
        const [i0, i1] = bins(ox, ox + w);
        for (let i = i0; i <= i1; i++) below[i] = Math.max(below[i], base + d);
        page.push({ box: dec(w), key: 'deco|' + key0, x: ox, y: base, rot: 0, o: so });
      }
      prevBot = below;
      lineNo++;
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
      const gj = so.mess * so.vSpace;
      // gaps open up freely but only close so far: a hand that crams words into each other reads
      // as one long smudge, not as messy writing
      let gf = 1 + gj * (0.3 * hGap(tNow()) + 0.9 * (hash01(key, so.seed) - 0.5));
      if (gf < 1) gf = Math.max(0.85, 1 - (1 - gf) * 0.4);
      // a hand that sets its letters tighter than the font leaves relatively clearer gaps between words
      gf *= 1 + 0.3 * Math.min(1, so.vTight == null ? 1 : so.vTight);
      let sp = pendSpace && nContent ? M.space * sz * so.gap * gf : 0;
      pendSpace = false;
      if (nContent && lineX + sp + box.w > avail) {
        // near the margin a hand squeezes the last word in rather than start a new line
        const cram = so.mess > 0.15 && lineX + sp * 0.6 + box.w <= avail && hash01('cram|' + key, so.seed) < 0.75;
        if (cram) sp *= 0.6; else { flush(); sp = 0; }
      }
      // the hand's slant drift at this point of the writing (added to the word's own in drawRun)
      line.push({ box, key, dx: lineX + sp, sl: so.mess * so.vSlant * 0.07 * hSlant(tNow()),
        bob: (hash01('bob|' + key, so.seed) - 0.5) * (snap ? 0.08 : 0.12) * fs * so.mess * so.vBase,
        tilt: (hash01('tilt|' + key, so.seed) - 0.5) * (snap ? 0.045 : 0.05) * shapeMess(so.mess) * so.vTilt });
      lineX += sp + box.w; nContent++;
    }

    function addToken(tok, scale = 1, extra = {}) {
      if (tok.t === 'sp') { pendSpace = true; return; }
      const sz = fs * ((tok.sty && tok.sty.size) || 1) * scale;
      if (tok.t === 'word') {
        const st = tok.sty, key = keyOf(tok.text);
        // Size variation happens here, not in drawRun, so a bigger word also takes more room and
        // gets the pen-width correction for its real size. Quantized so repeated words reuse
        // their cached bitmaps. It reports the nominal height/depth, so a big word can't push
        // its line down a whole ruled row.
        const sj = so.mess * so.vSize;
        const s = sj ? clamp(Math.round((1 + sj * (0.05 * hSize(tNow()) + 0.06 * (hash01('sz|' + key, so.seed) - 0.5))) * 50) / 50, 0.8, 1.25) : 1;
        // now and then the hand starts a word, fumbles it, strikes the false start and writes it again
        const oops = so.mess * (so.vOops || 0), len = [...tok.text].length;
        if (oops > 0 && len >= 4 && /\p{L}{3}/u.test(tok.text) && hash01('oops|' + key, so.seed) < 0.025 * oops) {
          const n = 1 + Math.floor(hash01('oops#|' + key, so.seed) * Math.min(4, len - 2));
          addInline(struckBox([...tok.text].slice(0, n).join(''), sz, st, so.seed + '|' + key), key + '~x', sz);
          pendSpace = true;
        }
        let b = runBox(tok.text, sz * s, { bold: st.bold || extra.bold, slant: st.italic, ul: st.ul, color: st.color, sized: true, tight: 0.025 * (so.vTight == null ? 1 : so.vTight) });
        if (s !== 1) b = { ...b, h: b.h / s, d: b.d / s, ld: ldOf(b) / s };
        addInline(b, key, sz);
      } else if (tok.t === 'math') {
        let b = mathBox(parseMath(tok.src), { fs: sz, base: sz, disp: false });
        b = colorBox(hpad(b, 0.04 * sz), tok.sty && tok.sty.color);
        b.ld = b.d; // its scripts' real depth counts (inkRects finds each piece, not the whole box)
        addInline(b, keyOf('$' + tok.src), sz);
      }
    }

    /** A false start, struck through with one or two quick strokes (sometimes a scribble). */
    function struckBox(text, sz, st, hk) {
      const b = runBox(text, sz, { bold: st.bold, color: st.color });
      const kind = hash01('oopsk|' + hk, so.seed), mid = M.xh * sz * 0.5;
      return compose(b.w, [{ b, dx: 0, dy: 0 }], (c, x, y, J) => {
        const L = x - 0.06 * sz, R = x + b.w + 0.08 * sz, sw = stemW(sz, J), ink = st.color || J.ink;
        if (kind < 0.25) { // scribbled out
          const pts = [], n = Math.max(4, Math.round(b.w / (0.16 * sz)));
          for (let i = 0; i <= n; i++) pts.push([L + (R - L) * i / n, y - mid + (i % 2 ? -1 : 1) * M.xh * sz * 0.42]);
          inkStroke(c, pts, J, { width: sw, color: ink, wob: 0.6 });
        } else {
          inkStroke(c, [[L, y - mid + 0.03 * sz], [R, y - mid - 0.05 * sz]], J, { width: sw, color: ink });
          if (kind > 0.6) inkStroke(c, [[L + 0.04 * sz, y - mid - 0.09 * sz], [R - 0.02 * sz, y - mid + 0.02 * sz]], J, { width: sw, color: ink });
        }
      });
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
    Object.assign(S, { prevBase, prevD, prevBot, pendGap, atTop });
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
    } else if (paper === 'DOTS' || paper === 'DOTS_HALF') {
      const half = paper === 'DOTS_HALF', sp = half ? GRID / 2 : GRID, r = half ? 1.2 : 1.6;
      c.fillStyle = half ? (light ? 'rgba(255,255,255,0.33)' : 'rgba(30,50,90,0.25)')
                         : (light ? 'rgba(255,255,255,0.38)' : 'rgba(30,50,90,0.29)');
      for (let y = sp; y < PAGE_H; y += sp) for (let x = sp; x < PAGE_W; x += sp) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
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
    // Real ink (gel, ballpoint…) sinks into the paper: on a light page it multiplies with what's
    // under it, so the ruled lines show through and crossings come out darker. A solid pen's ink
    // sits on top, opaque, like EngInk's. (Over a dark page or an ink-only image: plain painting.)
    const multiply = !inkOnly && lumHex(PAGES[opts.page] || PAGES.white) >= 128;
    for (const it of items) {
      const so = it.o || opts; // the settings of the section this item belongs to
      const nib = so.nib || DEFAULTS.nib, press = nib === 'solid' ? 0 : (so.vPress == null ? 1 : so.vPress);
      cx.globalCompositeOperation = multiply && nib !== 'solid' ? 'multiply' : 'source-over';
      const J = { ink: so.ink, mess: so.mess, wob: shapeMess(so.mess) * so.vWob, lean: so.lean, v: so, key: it.key, seed: so.seed, pen: so.pen > 0 ? so.pen : autoPen(), rng: rngFor(it.key, so.seed),
        nib, tex: so.vInk == null ? 1 : so.vInk, press,
        // the hand presses harder on some words than others (and a section's pen keeps its flow)
        dim: clamp(1 - press * 0.09 * hash01('dim|' + it.key, so.seed), 0.6, 1),
        noiseOff: hash01('grain|' + it.key, so.seed) * 997, sl: it.sl || 0,
        // the row height, and how far this word's descenders may reach before the line below
        pitch: pitchOf(so.size), size: so.size, dmax: it.dmax };
      // rotate the item about its own start, so each word (and underline) follows its line's angle
      cx.save();
      cx.translate(it.x, it.y); cx.rotate(it.rot || 0);
      if (it.dmax != null) J.toItem = cx.getTransform().inverse(); // device → this item's own frame
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
          <label class="hw-opt">Mess <input id="hw-mess" type="range" min="0" max="3" step="0.05" title="Messiness"><button id="hw-mess-more" class="hw-more" title="Fine-tune the hand: lean, word gap, ink texture and pressure, and how much letters, words and lines vary">⚙</button></label>
          <label class="hw-opt" title="Word groups: about how many words rise or fall together before the line turns the other way">Groups <input id="hw-group" type="range" min="1" max="8" step="1"><span id="hw-group-val" class="hw-group-val"></span></label>
          <label class="hw-opt" title="Pen stroke width — the same at every text size, like a real pen">Pen <input id="hw-pen" type="range" min="0.6" max="5" step="0.1"><button id="hw-pen-val" class="hw-pen-val"></button></label>
          <select id="hw-nib" class="kicad-input hw-select" title="Pen type: how the ink lands on the paper">
            ${NIBS.map(n => `<option value="${n.k}">${esc(n.name)}</option>`).join('')}
          </select>
          <div class="hw-inks" id="hw-inks">${INKS.map(i => `<button class="hw-ink" data-ink="${i.c}" title="${esc(i.name)}" style="background:${i.c}"></button>`).join('')}</div>
          <select id="hw-paper" class="kicad-input hw-select" title="Paper">
            <option value="GRID">Grid</option><option value="RULED">Ruled</option><option value="DOTS">Dots</option><option value="DOTS_HALF">Dots (½)</option><option value="PLAIN">Plain</option>
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
        <div id="hw-mess-pop" class="hw-pop" hidden>
          ${MESS_VARS.map(v => v.head ? `<div class="hw-pop-head">${esc(v.head)}</div>` : `
            <label class="hw-pop-row" title="${esc(v.tip)} (double-click to reset)">
              <span class="hw-pop-label">${esc(v.label)}</span>
              <input type="range" data-mv="${v.k}" min="${v.min}" max="${v.max}" step="${v.step}">
              <span class="hw-pop-val" data-mv-val="${v.k}"></span>
            </label>`).join('')}
          <div class="hw-pop-foot">
            <span class="hw-pop-note">At Mess 0 nothing varies; Lean, Word gap and Ink still apply.</span>
            <button id="hw-mess-reset" class="fmerge-mini hw-mini">Reset</button>
          </div>
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

    // ⚙ Messiness knobs: a popover anchored under the button (the toolbar scrolls sideways, so
    // the panel is fixed-positioned rather than living inside it). Live while dragging.
    const pop = $('hw-mess-pop'), more = $('hw-mess-more');
    const closePop = () => { pop.hidden = true; more.classList.remove('active'); };
    more.addEventListener('click', (e) => {
      e.preventDefault();
      if (!pop.hidden) { closePop(); return; }
      syncMessVars();
      pop.hidden = false; more.classList.add('active');
      const r = more.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
      pop.style.left = clamp(r.left + r.width / 2 - pw / 2, 8, window.innerWidth - pw - 8) + 'px';
      pop.style.top = (r.bottom + 6 + ph > window.innerHeight - 8 ? Math.max(8, r.top - ph - 6) : r.bottom + 6) + 'px';
    });
    document.addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !more.contains(e.target)) closePop(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closePop(); });
    const setVar = (k, v) => { opts[k] = v; persist(); syncMessVars(); scheduleRender(60); };
    pop.addEventListener('input', (e) => { const k = e.target.dataset.mv; if (k) setVar(k, parseFloat(e.target.value)); });
    pop.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.hw-pop-row'); const inp = row && row.querySelector('[data-mv]');
      if (inp) setVar(inp.dataset.mv, MESS_DEFAULTS[inp.dataset.mv]);
    });
    $('hw-mess-reset').addEventListener('click', () => { Object.assign(opts, MESS_DEFAULTS); persist(); syncMessVars(); scheduleRender(0); });

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
    onOpt('hw-paper', 'paper'); onOpt('hw-page', 'page'); onOpt('hw-nib', 'nib'); onOpt('hw-mode', 'mode'); onOpt('hw-disp', 'disp');
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
    try {
      const v = JSON.parse(localStorage.getItem(SECTIONS_KEY) || '[]');
      // sections committed before the messiness knobs existed get today's defaults for them
      return Array.isArray(v) ? v.filter(s => s && typeof s.src === 'string' && s.o).map(s => ({ src: s.src, o: migrateSection({ ...MESS_DEFAULTS, ...s.o }) })) : [];
    }
    catch (_) { return []; }
  }
  function migrateSection(o) {
    if (!(o.inkV >= 2) || !o.nib || o.nib === 'digital') { o.nib = 'solid'; o.inkV = 2; }
    return o;
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
    root.querySelector('#hw-nib').value = opts.nib || DEFAULTS.nib;
    syncMessVars();
  }

  function syncMessVars() {
    if (!root) return;
    let changed = false;
    for (const v of MESS_VARS) {
      if (v.head) continue;
      const val = opts[v.k] == null ? MESS_DEFAULTS[v.k] : opts[v.k];
      const inp = root.querySelector(`[data-mv="${v.k}"]`), out = root.querySelector(`[data-mv-val="${v.k}"]`);
      if (inp) inp.value = val;
      if (out) out.textContent = v.fmt(val);
      if (Math.abs(val - MESS_DEFAULTS[v.k]) > 1e-9) changed = true;
    }
    const more = root.querySelector('#hw-mess-more');
    if (more) more.classList.toggle('tuned', changed); // a dot shows the knobs aren't at their defaults
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
      renderPage(items, previewK(card), false, card.querySelector('canvas'));
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
      // The pen-type picker briefly defaulted to a textured gel pen; the user writes with a solid
      // stylus pen, so anything saved before inkV 2 goes back to solid.
      if (!(saved.inkV >= 2) || opts.nib === 'digital') { opts.nib = 'solid'; opts.inkV = 2; }
      build(container);
      mounted = true;
      loadFont(opts.font).then(() => scheduleRender(0));
    },
    activate() { if (mounted && M) scheduleRender(0); },
    deactivate() {},
    // exposed for quick checks from devtools
    _parse: (s, mode = 'auto') => parseDoc(s, mode),
    // baselines of every placed item, per page: [[{ y, x, w }]] — for checking line spacing
    _baselines: (s, o = {}) => layout([{ flow: parseDoc(s, o.mode || 'auto'), o: { ...opts, ...o } }]).map(pg => pg.map(it => ({ y: Math.round(it.y), x: Math.round(it.x), w: Math.round(it.box.w), h: Math.round(it.box.h), d: Math.round(it.box.d), ink: (() => { const r = []; inkRects(it.box, 0, 0, 1, r); return r.map(q => q.map(Math.round)); })() }))),
    // a laid-out page rendered at scale k (2 = what Export PDF / PNG write) — for checking the ink
    _renderPage: (i = 0, k = 2) => (pages[i] ? renderPage(pages[i], k, false) : null),
    // the pen centre lines recovered from the font for one word (em units)
    _skeleton: (text, alt = false) => (M ? skeletonOf(text, alt, {}) : null),
  };
})();
