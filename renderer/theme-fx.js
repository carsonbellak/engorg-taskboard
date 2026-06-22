/**
 * theme-fx.js — Immersive ambient decorative elements per theme.
 * Injects SVG / canvas layers when a theme is activated, cleans up on switch.
 */
(function () {
  'use strict';

  let _layer    = null;
  let _active   = null;
  let _ivals    = [];   // setInterval ids
  let _rafs     = [];   // cancelAnimationFrame tokens (via wrapper)

  // ── helpers ────────────────────────────────────────────────────────────

  function svgNS(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function div(cls, css) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    if (css) el.style.cssText = css;
    return el;
  }

  // Managed RAF: auto-stops when theme changes
  function raf(fn, themeId) {
    let id;
    function tick(ts) {
      if (document.body.dataset.theme !== themeId) return;
      fn(ts);
      id = requestAnimationFrame(tick);
    }
    id = requestAnimationFrame(tick);
    _rafs.push(() => cancelAnimationFrame(id));
  }

  // Managed setInterval: auto-stops on destroy
  function ival(fn, ms) {
    const id = setInterval(fn, ms);
    _ivals.push(id);
    return id;
  }

  // ── parametric gear path ───────────────────────────────────────────────

  function gearPath(cx, cy, R, r, holeR, teeth) {
    const step = (Math.PI * 2) / teeth;
    const tw = step * 0.28;  // half-tooth angular width
    let d = '';
    for (let i = 0; i < teeth; i++) {
      const a = step * i;
      const pts = [
        [r, a - step * 0.45],
        [R, a - tw],
        [R, a + tw],
        [r, a + step * 0.45],
      ];
      pts.forEach(([rad, ang], j) => {
        const x = (cx + rad * Math.cos(ang)).toFixed(2);
        const y = (cy + rad * Math.sin(ang)).toFixed(2);
        d += (i === 0 && j === 0 ? 'M ' : 'L ') + x + ' ' + y + ' ';
      });
    }
    d += 'Z ';
    // Centre hole (counterclockwise → evenodd punch-out)
    const hx = (cx + holeR).toFixed(2), hy = cy.toFixed(2),
          hx2 = (cx - holeR).toFixed(2);
    d += `M ${hx} ${hy} A ${holeR} ${holeR} 0 1 0 ${hx2} ${hy} A ${holeR} ${holeR} 0 1 0 ${hx} ${hy} Z`;
    return d;
  }

  // ── layer management ───────────────────────────────────────────────────

  function getLayer() {
    if (!_layer) {
      _layer = div('theme-fx-layer');
      document.body.appendChild(_layer);
    }
    return _layer;
  }

  function destroyFx() {
    _rafs.forEach(cancel => cancel());
    _rafs = [];
    _ivals.forEach(clearInterval);
    _ivals = [];
    if (_layer) _layer.innerHTML = '';
  }

  // ══════════════════════════════════════════════════════════════════════
  //  GRUNGE — Moving Gears
  // ══════════════════════════════════════════════════════════════════════
  function initGrunge(layer) {
    const configs = [
      { pos: 'left:-80px;bottom:-60px',  size: 180, teeth: 16, speed:  9, dir:  1 },
      { pos: 'right:-50px;top:-30px',    size: 130, teeth: 12, speed: 14, dir: -1 },
      { pos: 'right:120px;top:40%',      size:  70, teeth:  9, speed:  7, dir:  1 },
      { pos: 'left:140px;bottom:30%',    size:  48, teeth:  7, speed: 20, dir: -1 },
      { pos: 'right:-20px;bottom:25%',   size:  55, teeth:  8, speed: 11, dir:  1 },
    ];

    configs.forEach((cfg, idx) => {
      const S   = cfg.size;
      const svg = svgNS('svg', {
        viewBox: `0 0 ${S} ${S}`,
        width: S, height: S,
        class: 'theme-gear',
      });
      svg.style.cssText = `position:fixed;${cfg.pos};pointer-events:none;z-index:0;`;

      // Main gear body
      const path = svgNS('path', {
        d: gearPath(S/2, S/2, S*0.46, S*0.34, S*0.13, cfg.teeth),
        fill: '#7A6245',
        'fill-rule': 'evenodd',
      });
      svg.appendChild(path);

      // Rivet / bolt details
      const numSpokes = 4;
      for (let s = 0; s < numSpokes; s++) {
        const ang  = (s / numSpokes) * Math.PI * 2;
        const mid  = S * 0.235;
        const line = svgNS('line', {
          x1: (S/2 + S*0.14*Math.cos(ang)).toFixed(1),
          y1: (S/2 + S*0.14*Math.sin(ang)).toFixed(1),
          x2: (S/2 + mid*Math.cos(ang)).toFixed(1),
          y2: (S/2 + mid*Math.sin(ang)).toFixed(1),
          stroke: '#5C4A30', 'stroke-width': (S*0.045).toFixed(1),
          'stroke-linecap': 'round',
        });
        svg.appendChild(line);
        // Rivet dot
        svg.appendChild(svgNS('circle', {
          cx: (S/2 + mid*Math.cos(ang)).toFixed(1),
          cy: (S/2 + mid*Math.sin(ang)).toFixed(1),
          r: (S*0.035).toFixed(1),
          fill: '#9C7D50',
        }));
      }

      layer.appendChild(svg);

      // Rotation RAF  — cfg.speed is seconds per full revolution
      let angle = (idx * 45) % 360;
      const degPerMs = (cfg.dir * 360) / (cfg.speed * 1000);  // deg / ms
      let last = 0;
      raf(ts => {
        const dt = last ? ts - last : 16;
        last = ts;
        angle = (angle + degPerMs * dt) % 360;
        svg.style.transform = `rotate(${angle.toFixed(2)}deg)`;
      }, _active);
    });

    // Bolts / screws scattered
    const boltPositions = [
      'left:12px;top:20px', 'right:20px;top:12px',
      'left:20px;bottom:18px', 'right:12px;bottom:20px',
    ];
    boltPositions.forEach(pos => {
      const bolt = svgNS('svg', { viewBox:'0 0 16 16', width:14, height:14, class:'theme-bolt' });
      bolt.style.cssText = `position:fixed;${pos};pointer-events:none;z-index:0;opacity:0.35;`;
      bolt.appendChild(svgNS('polygon', {
        points: '8,1 10,5 15,5 11,9 13,15 8,11 3,15 5,9 1,5 6,5',
        fill: '#9C7D50',
      }));
      layer.appendChild(bolt);
    });

    // Rust streak overlay
    const rust = div('theme-rust-overlay', '');
    layer.appendChild(rust);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  FOREST — Swaying Branches + Falling Leaves
  // ══════════════════════════════════════════════════════════════════════
  function leafSvgPath() {
    return 'M 0 0 C -10 -8 -14 -28 0 -38 C 14 -28 10 -8 0 0 Z';
  }

  function initForest(layer) {
    // Build a branch cluster SVG
    function makeBranch(mirror) {
      const svg = svgNS('svg', { viewBox: '0 0 220 420', width: 200, height: 380 });
      svg.style.cssText = `position:fixed;${mirror ? 'right:-45px' : 'left:-45px'};top:0;pointer-events:none;z-index:0;opacity:0.45;${mirror ? 'transform:scaleX(-1)' : ''}`;

      const trunks = [
        { d: 'M 20 420 C 40 320 60 260 80 200', sw: 8 },
        { d: 'M 80 200 C 100 150 140 120 170 90', sw: 5 },
        { d: 'M 80 200 C 60 170 50 140 40 110', sw: 4 },
        { d: 'M 40 110 C 30 90 20 70 10 50', sw: 3 },
        { d: 'M 170 90 C 185 65 195 45 210 20', sw: 3 },
      ];
      trunks.forEach(t => {
        svg.appendChild(svgNS('path', {
          d: t.d, stroke: '#5D4037', 'stroke-width': t.sw,
          fill: 'none', 'stroke-linecap': 'round',
        }));
      });

      const leafClusters = [
        { x: 168, y: 88, count: 8, r: 28 },
        { x: 40,  y: 108, count: 6, r: 22 },
        { x: 10,  y: 48, count: 5, r: 20 },
        { x: 210, y: 20, count: 7, r: 25 },
        { x: 80,  y: 55, count: 4, r: 18 },
      ];
      const leafColors = ['#2D6A4F','#40916C','#52B788','#74C69D','#1B4332','#081C15'];

      leafClusters.forEach(cl => {
        for (let i = 0; i < cl.count; i++) {
          const lx  = cl.x + (Math.random() - 0.5) * cl.r * 2;
          const ly  = cl.y + (Math.random() - 0.5) * cl.r * 2;
          const rot = Math.random() * 360;
          const sc  = 0.6 + Math.random() * 0.8;
          const g   = svgNS('g', { transform: `translate(${lx.toFixed(1)} ${ly.toFixed(1)}) rotate(${rot.toFixed(0)}) scale(${sc.toFixed(2)})` });
          g.appendChild(svgNS('path', {
            d: leafSvgPath(),
            fill: leafColors[Math.floor(Math.random() * leafColors.length)],
            opacity: (0.75 + Math.random() * 0.25).toFixed(2),
          }));
          svg.appendChild(g);
        }
      });

      // SVG sway animation anchored at trunk base
      const anim = svgNS('animateTransform', {
        attributeName: 'transform',
        type: 'rotate',
        from: mirror ? '2 220 420' : '-2 0 420',
        to:   mirror ? '-3 220 420' : '3 0 420',
        dur: (3.5 + Math.random()).toFixed(1) + 's',
        repeatCount: 'indefinite',
        additive: 'sum',
        calcMode: 'spline',
        keySplines: '0.45 0 0.55 1',
        keyTimes: '0;1',
      });
      svg.appendChild(anim);
      return svg;
    }

    layer.appendChild(makeBranch(false));
    layer.appendChild(makeBranch(true));

    // Seed initial falling leaves mid-screen
    for (let i = 0; i < 14; i++) spawnLeaf(layer, true, 'forest');

    // Continuous spawning
    ival(() => {
      if (document.body.dataset.theme !== 'forest') return;
      spawnLeaf(layer, false, 'forest');
    }, 2200);

    // Dappled light pulse overlay
    const dapple = div('theme-forest-dapple', '');
    layer.appendChild(dapple);
  }

  function spawnLeaf(layer, instant, themeId) {
    const colors = ['#2D6A4F','#40916C','#52B788','#74C69D','#95D5B2','#1B4332'];
    const size   = 18 + Math.random() * 24;
    const sx     = Math.random() * window.innerWidth;
    const dur    = 9 + Math.random() * 14;
    const sy     = instant ? -(Math.random() * window.innerHeight) : -55;

    const svg = svgNS('svg', { width: size, height: size * 2, viewBox: '-15 -40 30 42' });
    svg.style.cssText = `position:fixed;left:${sx}px;top:${sy}px;pointer-events:none;z-index:0;opacity:${(0.5 + Math.random() * 0.5).toFixed(2)};`;
    svg.appendChild(svgNS('path', {
      d: leafSvgPath(),
      fill: colors[Math.floor(Math.random() * colors.length)],
    }));

    // Leaf stem
    svg.appendChild(svgNS('line', {
      x1: '0', y1: '0', x2: '0', y2: '6',
      stroke: '#5D4037', 'stroke-width': '1.5', 'stroke-linecap': 'round',
    }));
    layer.appendChild(svg);

    const t0   = performance.now() + (instant ? -Math.random() * dur * 1000 : 0);
    const drift = (Math.random() - 0.5) * 250;
    const spin  = (Math.random() > 0.5 ? 1 : -1) * (100 + Math.random() * 200);

    function animate(ts) {
      const p = (ts - t0) / (dur * 1000);
      if (p < 0) { requestAnimationFrame(animate); return; }
      if (p > 1 || document.body.dataset.theme !== themeId) { svg.remove(); return; }
      const y  = sy + p * (window.innerHeight + 80);
      const x  = Math.sin(p * Math.PI * 3.5) * 45 + drift * p;
      const r  = spin * p;
      svg.style.transform = `translate(${x.toFixed(1)}px, ${(y - sy).toFixed(1)}px) rotate(${r.toFixed(1)}deg)`;
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ROSE — Rose Petals + Edge Vines
  // ══════════════════════════════════════════════════════════════════════
  function petalPath() {
    return 'M 0 0 C -18 -8 -22 -40 0 -52 C 22 -40 18 -8 0 0 Z';
  }

  function makeMiniRose(parent, x, y) {
    const g = svgNS('g', { transform: `translate(${x} ${y})` });
    const petalCols = ['#FB7185','#F43F5E','#FDA4AF','#FECDD3','#E11D48'];
    for (let p = 0; p < 5; p++) {
      const ang = (p / 5) * Math.PI * 2;
      const ep  = svgNS('ellipse', {
        cx: (Math.cos(ang) * 10).toFixed(1),
        cy: (Math.sin(ang) * 10).toFixed(1),
        rx: 9, ry: 6,
        fill: petalCols[p % petalCols.length],
        transform: `rotate(${(p/5*360).toFixed(0)} ${(Math.cos(ang)*10).toFixed(1)} ${(Math.sin(ang)*10).toFixed(1)})`,
      });
      g.appendChild(ep);
    }
    g.appendChild(svgNS('circle', { r: 5, fill: '#9F1239' }));
    parent.appendChild(g);
  }

  function initRose(layer) {
    // Vine decorations on left and right edges
    [false, true].forEach(mirror => {
      const svg = svgNS('svg', { viewBox: '0 0 90 700', width: 90, height: 700 });
      svg.style.cssText = `position:fixed;${mirror ? 'right:0' : 'left:0'};top:50px;pointer-events:none;z-index:0;opacity:0.18;${mirror ? 'transform:scaleX(-1)' : ''}`;

      // Vine stem
      svg.appendChild(svgNS('path', {
        d: 'M 25 0 C 55 80 5 180 30 280 C 55 380 10 480 25 600 C 35 650 20 680 25 700',
        stroke: '#9F1239', 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round',
      }));
      // Tendrils
      ['M 30 100 C 60 90 70 70 65 55', 'M 25 250 C -5 240 -10 210 5 195',
       'M 28 420 C 65 410 75 385 60 370', 'M 26 570 C -8 555 -12 530 4 520'].forEach(d => {
        svg.appendChild(svgNS('path', { d, stroke: '#BE185D', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }));
      });
      // Mini roses at intervals
      [[30, 80], [25, 250], [28, 420], [26, 570]].forEach(([x, y]) => makeMiniRose(svg, x, y));
      layer.appendChild(svg);
    });

    // Initial petal burst
    for (let i = 0; i < 18; i++) spawnPetal(layer, true);
    ival(() => {
      if (document.body.dataset.theme !== 'rose') return;
      spawnPetal(layer, false);
    }, 1600);

    // Soft bloom glow overlay
    layer.appendChild(div('theme-rose-glow', ''));
  }

  function spawnPetal(layer, instant) {
    const cols = [
      'rgba(244,114,182,0.7)', 'rgba(225,29,72,0.55)',
      'rgba(254,205,211,0.85)', 'rgba(251,207,232,0.75)',
      'rgba(253,164,175,0.65)', 'rgba(159,18,57,0.5)',
    ];
    const size = 22 + Math.random() * 28;
    const sx   = Math.random() * window.innerWidth;
    const sy   = instant ? -(Math.random() * window.innerHeight) : -65;
    const dur  = 11 + Math.random() * 16;
    const col  = cols[Math.floor(Math.random() * cols.length)];

    const svg = svgNS('svg', { width: size, height: size * 1.6, viewBox: '-24 -56 48 58' });
    svg.style.cssText = `position:fixed;left:${sx}px;top:${sy}px;pointer-events:none;z-index:0;`;
    svg.appendChild(svgNS('path', { d: petalPath(), fill: col }));
    layer.appendChild(svg);

    const t0    = performance.now() + (instant ? -Math.random() * dur * 1000 : 0);
    const sway  = (Math.random() - 0.5) * 180;
    const spinR = Math.random() * 280 * (Math.random() > 0.5 ? 1 : -1);

    function animate(ts) {
      const p = (ts - t0) / (dur * 1000);
      if (p < 0) { requestAnimationFrame(animate); return; }
      if (p > 1 || document.body.dataset.theme !== 'rose') { svg.remove(); return; }
      const y    = sy + p * (window.innerHeight + 100);
      const x    = Math.sin(p * Math.PI * 5) * 55 + sway * p;
      const spin = spinR * p;
      const tilt = Math.sin(p * Math.PI * 2) * 30;
      svg.style.transform = `translate(${x.toFixed(1)}px,${(y-sy).toFixed(1)}px) rotate(${spin.toFixed(1)}deg) rotateX(${tilt.toFixed(1)}deg)`;
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  DARK — Twinkling Star Field
  // ══════════════════════════════════════════════════════════════════════
  function initDark(layer) {
    const canvas = document.createElement('canvas');
    canvas.className = 'theme-canvas-base';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    layer.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const stars = Array.from({ length: 160 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: 0.3 + Math.random() * 1.6,
      speed: 0.0008 + Math.random() * 0.003,
      phase: Math.random() * Math.PI * 2,
      color: Math.random() > 0.85
        ? `rgba(${180+Math.floor(Math.random()*75)},${180+Math.floor(Math.random()*75)},255,`
        : 'rgba(255,255,255,',
    }));

    raf(ts => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      stars.forEach(s => {
        const a = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(ts * s.speed + s.phase));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = s.color + a.toFixed(3) + ')';
        ctx.fill();
        // Tiny cross gleam for bigger stars
        if (s.r > 1.1) {
          ctx.strokeStyle = s.color + (a * 0.4).toFixed(3) + ')';
          ctx.lineWidth = 0.5;
          const gl = s.r * 3;
          ctx.beginPath(); ctx.moveTo(s.x - gl, s.y); ctx.lineTo(s.x + gl, s.y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(s.x, s.y - gl); ctx.lineTo(s.x, s.y + gl); ctx.stroke();
        }
      });
    }, 'dark');
  }

  // ══════════════════════════════════════════════════════════════════════
  //  NORD — Crystalline Snowflakes
  // ══════════════════════════════════════════════════════════════════════
  function initNord(layer) {
    for (let i = 0; i < 28; i++) spawnSnowflake(layer, true);
    ival(() => {
      if (document.body.dataset.theme !== 'nord') return;
      spawnSnowflake(layer, false);
    }, 1800);
  }

  function spawnSnowflake(layer, instant) {
    const size = 10 + Math.random() * 20;
    const sx   = Math.random() * window.innerWidth;
    const sy   = instant ? -(Math.random() * window.innerHeight) : -35;
    const dur  = 16 + Math.random() * 22;

    const svg = svgNS('svg', { width: size, height: size, viewBox: '-10 -10 20 20' });
    svg.style.cssText = `position:fixed;left:${sx}px;top:${sy}px;pointer-events:none;z-index:0;opacity:${(0.35 + Math.random() * 0.55).toFixed(2)};`;

    const g = svgNS('g', { stroke: '#D8DEE9', 'stroke-linecap': 'round' });
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * Math.PI * 2;
      const ex = (Math.cos(ang) * 9).toFixed(2), ey = (Math.sin(ang) * 9).toFixed(2);
      g.appendChild(svgNS('line', { x1: 0, y1: 0, x2: ex, y2: ey, 'stroke-width': 1.4 }));
      // Branch bars at 40% and 70%
      [0.4, 0.72].forEach(frac => {
        const bx = (Math.cos(ang) * 9 * frac).toFixed(2);
        const by = (Math.sin(ang) * 9 * frac).toFixed(2);
        const perp = ang + Math.PI / 2;
        const bl = 9 * (1 - frac) * 0.45;
        g.appendChild(svgNS('line', {
          x1: (parseFloat(bx) + Math.cos(perp) * bl).toFixed(2),
          y1: (parseFloat(by) + Math.sin(perp) * bl).toFixed(2),
          x2: (parseFloat(bx) - Math.cos(perp) * bl).toFixed(2),
          y2: (parseFloat(by) - Math.sin(perp) * bl).toFixed(2),
          'stroke-width': frac < 0.5 ? 1.2 : 0.9,
        }));
      });
    }
    g.appendChild(svgNS('circle', { r: 1.5, fill: '#ECEFF4', stroke: 'none' }));
    svg.appendChild(g);
    layer.appendChild(svg);

    const t0   = performance.now() + (instant ? -Math.random() * dur * 1000 : 0);
    const sw   = Math.sin(Math.random() * Math.PI) * 30;
    const spin = (Math.random() > 0.5 ? 1 : -1) * 60;

    function animate(ts) {
      const p = (ts - t0) / (dur * 1000);
      if (p < 0) { requestAnimationFrame(animate); return; }
      if (p > 1 || document.body.dataset.theme !== 'nord') { svg.remove(); return; }
      const y = sy + p * (window.innerHeight + 50);
      const x = Math.sin(p * Math.PI * 2.5) * sw;
      svg.style.transform = `translate(${x.toFixed(1)}px,${(y-sy).toFixed(1)}px) rotate(${(spin*p).toFixed(1)}deg)`;
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  HACKER — Matrix Data Rain (canvas)
  // ══════════════════════════════════════════════════════════════════════
  function initHacker(layer) {
    const canvas = document.createElement('canvas');
    canvas.className = 'theme-canvas-base';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    layer.appendChild(canvas);

    const ctx  = canvas.getContext('2d');
    const W    = canvas.width, H = canvas.height;
    const cols = Math.floor(W / 16);
    const drops = Array.from({ length: cols }, () => Math.random() * -(H / 16));
    const CHARS = '01アイウエオカキクケコサシスセソタチ0110101ナニヌネノハヒフへホ';

    function draw() {
      if (document.body.dataset.theme !== 'hacker') return;
      ctx.fillStyle = 'rgba(0,8,0,0.06)';
      ctx.fillRect(0, 0, W, H);
      ctx.font = '13px "Courier New", monospace';
      drops.forEach((y, i) => {
        const bright = Math.random() > 0.97;
        ctx.fillStyle = bright ? '#AFFFB8' : '#00FF41';
        const ch = CHARS[Math.floor(Math.random() * CHARS.length)];
        ctx.fillText(ch, i * 16 + 2, y * 16);
        drops[i] = y > H / 16 + Math.random() * 40 ? 0 : y + 1;
      });
      setTimeout(draw, 55);
    }
    draw();
  }

  // ══════════════════════════════════════════════════════════════════════
  //  NEON — Electric Orbs + Glow Pulses
  // ══════════════════════════════════════════════════════════════════════
  function initNeon(layer) {
    const orbs = [
      { left: '10%',  top: '70%', size: 160, color: '0,255,170', delay: 0 },
      { left: '80%',  top: '15%', size: 120, color: '0,170,255', delay: 1.5 },
      { left: '50%',  top: '85%', size: 90,  color: '0,255,170', delay: 3 },
      { left: '70%',  top: '55%', size: 70,  color: '180,0,255', delay: 2 },
    ];
    orbs.forEach(o => {
      const d = div('theme-neon-orb');
      d.style.cssText = `left:${o.left};top:${o.top};width:${o.size}px;height:${o.size}px;
        background:radial-gradient(ellipse at 40% 40%, rgba(${o.color},0.12), transparent 70%);
        box-shadow: 0 0 ${o.size*0.4}px ${o.size*0.15}px rgba(${o.color},0.1);
        animation-delay:${o.delay}s;`;
      layer.appendChild(d);
    });

    // Electric arc SVG
    const arcSvg = svgNS('svg', { viewBox: '0 0 100 60', width: 100, height: 60, class: 'theme-neon-arc' });
    arcSvg.style.cssText = 'position:fixed;right:30px;top:60px;pointer-events:none;z-index:0;opacity:0.25;';
    arcSvg.appendChild(svgNS('path', {
      d: 'M 5 55 C 20 30 40 5 50 30 C 60 55 80 10 95 5',
      stroke: '#00FFAA', 'stroke-width': 2, fill: 'none',
      'stroke-linecap': 'round',
    }));
    layer.appendChild(arcSvg);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  GLASS — Floating Bubbles
  // ══════════════════════════════════════════════════════════════════════
  function initGlass(layer) {
    for (let i = 0; i < 9; i++) {
      const size = 24 + Math.random() * 70;
      const d    = div('theme-glass-bubble');
      d.style.cssText = `
        width:${size}px;height:${size}px;
        left:${Math.random()*100}%;top:${Math.random()*100}%;
        animation-delay:${Math.random()*8}s;
        animation-duration:${10+Math.random()*10}s;
      `;
      layer.appendChild(d);
    }
    // Light beam
    layer.appendChild(div('theme-glass-beam', ''));
  }

  // ══════════════════════════════════════════════════════════════════════
  //  GRADIENT / SUNSET — Drifting Cloud Wisps
  // ══════════════════════════════════════════════════════════════════════
  function initGradient(layer) {
    for (let i = 0; i < 4; i++) {
      const d = div('theme-cloud-wisp');
      d.style.cssText = `top:${8 + i*20}%;opacity:${0.35 + i*0.08};
        animation-delay:${i*7}s;animation-duration:${35+i*12}s;width:${300+i*100}px;`;
      layer.appendChild(d);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  SAND — Drifting Sand Grains (canvas)
  // ══════════════════════════════════════════════════════════════════════
  function initSand(layer) {
    const canvas = document.createElement('canvas');
    canvas.className = 'theme-canvas-base';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    layer.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const grains = Array.from({ length: 90 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: 0.5 + Math.random() * 1.8,
      vx: (Math.random() - 0.5) * 0.5,
      vy: 0.1 + Math.random() * 0.35,
      a: 0.2 + Math.random() * 0.5,
    }));

    raf(() => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      grains.forEach(g => {
        g.x += g.vx + Math.sin(Date.now() * 0.0003 + g.y) * 0.3;
        g.y += g.vy;
        if (g.y > canvas.height + 4) { g.y = -4; g.x = Math.random() * canvas.width; }
        if (g.x < 0) g.x = canvas.width;
        if (g.x > canvas.width) g.x = 0;
        ctx.beginPath();
        ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180,140,80,${g.a})`;
        ctx.fill();
      });
    }, 'sand');
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Public API
  // ══════════════════════════════════════════════════════════════════════
  window.ThemeFx = {
    init(themeId) {
      if (_active === themeId) return;
      _active = themeId;
      destroyFx();
      const layer = getLayer();

      switch (themeId) {
        case 'grunge':   initGrunge(layer);   break;
        case 'forest':   initForest(layer);   break;
        case 'rose':     initRose(layer);     break;
        case 'dark':     initDark(layer);     break;
        case 'nord':     initNord(layer);     break;
        case 'hacker':   initHacker(layer);   break;
        case 'neon':     initNeon(layer);     break;
        case 'glass':    initGlass(layer);    break;
        case 'gradient': initGradient(layer); break;
        case 'sand':     initSand(layer);     break;
      }
    },
    destroy: destroyFx,
  };

})();
