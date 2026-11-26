/* Portfolio viewers: interactive 3D models (three.js r128, same stack as the
 * desktop CAD viewer) and live KiCad boards/schematics (KiCanvas).
 * Globals: ModelViewer, PcbViewer. Each has dispose(). */

(function () {
  const ICON = {
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    wire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/></svg>',
    spin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  };

  const OCCT_BASE = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/';
  const KICANVAS_SRC = 'https://kicanvas.org/kicanvas/kicanvas.js';

  function loadScript(src, attrs = {}) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      Object.assign(s, attrs);
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  const once = {};
  const loadOnce = (key, fn) => (once[key] ||= fn().catch(e => { delete once[key]; throw e; }));

  function cssColor(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function extOf(src) {
    return (src.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
  }

  // ------------------------------------------------------------------ 3D
  class ModelViewer {
    constructor(host, opts) {
      this.opts = Object.assign({ autoRotate: false, tools: true }, opts);
      this.host = host;
      this.root = document.createElement('div');
      this.root.className = 'viewer';
      host.appendChild(this.root);

      this.status = document.createElement('div');
      this.status.className = 'viewer-status';
      this.root.appendChild(this.status);
      this._setStatus('loading');

      if (typeof THREE === 'undefined') { this._setStatus('error', '3D library failed to load. Check your connection.'); return; }

      const w = host.clientWidth || 600, h = host.clientHeight || 450;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 1000);
      // logarithmic depth: CAD assemblies have many near-coplanar faces (sheet metal, panels on
      // frames) that z-fight ("flicker") with a normal depth buffer
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(w, h, false);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.root.insertBefore(this.renderer.domElement, this.status);

      // Studio lighting: a soft room environment (from Google's model-viewer) for even, product-
      // shot shading, plus a gentle key light for shape definition.
      if (THREE.RoomEnvironment) {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this._envTex = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
        this.scene.environment = this._envTex;
        pmrem.dispose();
        const key = new THREE.DirectionalLight(0xffffff, 0.6); key.position.set(3, 6, 4);
        this.scene.add(key);
      } else {
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 0.75));
        const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(3, 5, 4);
        const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-4, 2, -3);
        this.scene.add(key, fill);
      }
      this.scene.add(this.camera);

      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.autoRotate = !!this.opts.autoRotate;
      this.controls.autoRotateSpeed = 1.2;

      // Render on demand: loop only while visible and something is moving.
      this._raf = 0; this._decay = 0; this._visible = true;
      this.controls.addEventListener('start', () => {
        this._interacting = true;
        if (this.controls.autoRotate && this.opts.stopRotateOnTouch) this._setAutoRotate(false);
        this._kick();
      });
      this.controls.addEventListener('end', () => { this._interacting = false; this._decay = 60; this._kick(); });
      this.controls.addEventListener('change', () => this._kick());

      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(host);
      this._io = new IntersectionObserver(([e]) => { this._visible = e.isIntersecting; this._kick(); });
      this._io.observe(this.root);

      if (this.opts.tools) this._buildTools();
      this._loadWithRetry();
    }

    // Big models over flaky connections: retry twice with backoff, then offer a Retry button.
    async _loadWithRetry() {
      for (let attempt = 0; attempt < 3 && !this._disposed; attempt++) {
        try { await this._load(this.opts.src); return; }
        catch (err) {
          console.warn('[portfolio] model load failed (attempt ' + (attempt + 1) + ')', err);
          if (attempt < 2) { this._setStatus('loading', 'Connection hiccup, retrying…'); await new Promise(r => setTimeout(r, 800 * (attempt + 1))); }
        }
      }
      if (this._disposed) return;
      this._setStatus('error', 'Could not load this model.');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-sm'; b.textContent = 'Retry'; b.style.marginTop = '12px'; b.style.pointerEvents = 'auto';
      b.addEventListener('click', () => { this._setStatus('loading'); this._loadWithRetry(); });
      this.status.firstElementChild.appendChild(document.createElement('br'));
      this.status.firstElementChild.appendChild(b);
    }

    _setStatus(kind, text) {
      if (!this.status) return;
      if (kind === 'done') { this.status.hidden = true; return; }
      this.status.hidden = false;
      this.status.innerHTML = kind === 'loading'
        ? `<div><div class="spin"></div><span>${text || 'Loading model…'}</span></div>`
        : `<div>${text}</div>`;
    }

    _buildTools() {
      const bar = document.createElement('div');
      bar.className = 'viewer-tools';
      const mk = (icon, label, fn, pressed) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'icon-btn'; b.innerHTML = ICON[icon];
        b.title = label; b.setAttribute('aria-label', label);
        if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
        b.addEventListener('click', e => { e.stopPropagation(); fn(b); });
        bar.appendChild(b);
        return b;
      };
      mk('reset', 'Reset view', () => this.resetView());
      mk('wire', 'Wireframe', b => {
        this._wire = !this._wire; b.setAttribute('aria-pressed', String(this._wire));
        this._materials().forEach(m => { m.wireframe = this._wire; });
        this._kick();
      }, false);
      this._spinBtn = mk('spin', 'Auto-rotate', () => this._setAutoRotate(!this.controls.autoRotate), this.controls.autoRotate);
      if (this.root.requestFullscreen) {
        mk('full', 'Fullscreen', () => {
          if (document.fullscreenElement) document.exitFullscreen();
          else this.root.requestFullscreen().catch(() => {});
        });
      }
      this.root.appendChild(bar);
    }

    _setAutoRotate(on) {
      this.controls.autoRotate = on;
      if (this._spinBtn) this._spinBtn.setAttribute('aria-pressed', String(on));
      this._kick();
    }

    _material() {
      const color = this.opts.color || cssColor('--accent', '#b5652c');
      // Output is sRGB (so GLB textures look right); hex colours are sRGB, so linearise them.
      return new THREE.MeshStandardMaterial({ color: new THREE.Color(color).convertSRGBToLinear(), metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
    }

    _materials() {
      const out = [];
      this.model && this.model.traverse(o => {
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => out.push(m));
      });
      return out;
    }

    _progress(e) {
      if (e && e.lengthComputable && e.total) this._setStatus('loading', `Loading model… ${Math.round(e.loaded / e.total * 100)}%`);
    }

    async _load(src) {
      if (!src) throw new Error('no src');
      const ext = extOf(src);
      const zUp = this.opts.zUp !== undefined ? this.opts.zUp : (ext === 'stl' || ext === 'step' || ext === 'stp');
      let obj;

      if (ext === 'stl') {
        const geo = await new Promise((res, rej) => new THREE.STLLoader().load(src, res, e => this._progress(e), rej));
        if (!geo.attributes.normal) geo.computeVertexNormals();
        obj = new THREE.Mesh(geo, this._material());
      } else if (ext === 'glb' || ext === 'gltf') {
        const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load(src, res, e => this._progress(e), rej));
        obj = gltf.scene;
      } else if (ext === 'obj') {
        obj = await new Promise((res, rej) => new THREE.OBJLoader().load(src, res, e => this._progress(e), rej));
        const mat = this._material();
        obj.traverse(o => { if (o.isMesh) o.material = mat; });
      } else if (ext === 'step' || ext === 'stp') {
        obj = await this._loadStep(src);
      } else {
        throw new Error('Unsupported model type: ' + ext);
      }

      if (this._disposed) return;
      if (zUp) obj.rotation.x = -Math.PI / 2;

      // Centre on the origin and fit the camera to the bounding sphere.
      const pivot = new THREE.Group();
      pivot.add(obj);
      pivot.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(pivot);
      const center = box.getCenter(new THREE.Vector3());
      obj.position.sub(center); // pivot is identity, so pivot space = world space
      pivot.updateMatrixWorld(true);
      const sphere = new THREE.Box3().setFromObject(pivot).getBoundingSphere(new THREE.Sphere());
      this.model = pivot;
      this.scene.add(pivot);

      const r = sphere.radius || 1;
      const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.08;
      // tight clip range = more depth precision (with the log buffer, no visible flicker)
      this.camera.near = r * 0.02;
      this.camera.far = dist + r * 6;
      this.camera.updateProjectionMatrix();

      // soft contact shadow under the model (product-shot grounding)
      const fitBox = new THREE.Box3().setFromObject(pivot);
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d'); const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, 'rgba(0,0,0,0.28)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.12)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
      const fs = fitBox.getSize(new THREE.Vector3());
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(fs.x * 1.5 + r * 0.1, fs.z * 1.5 + r * 0.1),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = fitBox.min.y - r * 0.002; shadow.renderOrder = -1;
      this.scene.add(shadow); this._shadow = shadow;
      // Frame the model's box (not its bounding sphere) from the starting direction, so tall
      // or flat parts fill the stage instead of sitting small in the middle.
      const dir = new THREE.Vector3(...(this.opts.view || [1, 0.75, 1.15])).normalize();
      const fwd = dir.clone().negate(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const upv = new THREE.Vector3().crossVectors(right, fwd);
      const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)), tanH = tanV * Math.max(this.camera.aspect, 0.3);
      let need = 0;
      for (const x of [fitBox.min.x, fitBox.max.x]) for (const y of [fitBox.min.y, fitBox.max.y]) for (const z of [fitBox.min.z, fitBox.max.z]) {
        const corner = new THREE.Vector3(x, y, z);
        const toward = corner.dot(dir);
        need = Math.max(need, toward + Math.abs(corner.dot(right)) / tanH, toward + Math.abs(corner.dot(upv)) / tanV);
      }
      const fitDist = Math.min(dist, need * 1.12);
      this._home = dir.multiplyScalar(fitDist);
      this.controls.minDistance = Math.min(r * 0.6, fitDist * 0.5);
      this.controls.maxDistance = dist * 5;
      this.resetView();
      this._setStatus('done');
      if (this.opts.onLoad) this.opts.onLoad(this);
    }

    async _loadStep(src) {
      this._setStatus('loading', 'Loading STEP converter…');
      await loadOnce('occt', () => (typeof occtimportjs !== 'undefined' ? Promise.resolve() : loadScript(OCCT_BASE + 'occt-import-js.js')));
      const occt = await loadOnce('occtInit', () => occtimportjs({ locateFile: name => OCCT_BASE + name }));
      this._setStatus('loading', 'Converting STEP…');
      const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
      const result = occt.ReadStepFile(buf, null);
      if (!result || !result.success) throw new Error('STEP parse failed');
      const group = new THREE.Group();
      const fallback = this._material();
      for (const m of result.meshes) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
        if (m.attributes.normal) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
        if (m.index) geo.setIndex(new THREE.Uint32BufferAttribute(m.index.array, 1));
        if (!m.attributes.normal) geo.computeVertexNormals();
        let mat = fallback;
        if (m.color && !this.opts.color) {
          mat = fallback.clone();
          mat.color.setRGB(m.color[0], m.color[1], m.color[2]).convertSRGBToLinear();
        }
        group.add(new THREE.Mesh(geo, mat));
      }
      return group;
    }

    resetView() {
      if (!this._home) return;
      this.camera.position.copy(this._home);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      this._kick();
    }

    _resize() {
      const w = this.host.clientWidth, h = this.host.clientHeight;
      if (!w || !h) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
      this._kick();
    }

    _kick() {
      if (this._disposed || this._raf) return;
      this._raf = requestAnimationFrame(() => this._frame());
    }

    _frame() {
      this._raf = 0;
      if (this._disposed) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (this._decay > 0) this._decay--;
      const moving = this._interacting || this._decay > 0 || (this.controls.autoRotate && this.model);
      if (moving && this._visible && !document.hidden) this._kick();
    }

    dispose() {
      this._disposed = true;
      cancelAnimationFrame(this._raf);
      this._ro && this._ro.disconnect();
      this._io && this._io.disconnect();
      if (this.scene) {
        this.scene.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        });
      }
      if (this.controls) this.controls.dispose();
      if (this._envTex) this._envTex.dispose();
      if (this._shadow) this._shadow.material.map.dispose();
      if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss(); }
      this.root.remove();
    }
  }

  // ------------------------------------------------------------------ PCB
  class PcbViewer {
    constructor(host, opts) {
      this.root = document.createElement('div');
      this.root.className = 'pcb-host';
      host.appendChild(this.root);
      this.status = document.createElement('div');
      this.status.className = 'viewer-status';
      this.status.innerHTML = '<div><div class="spin"></div><span>Loading board viewer…</span></div>';
      this.root.appendChild(this.status);
      this._mount(opts).catch(err => {
        console.error('[portfolio] pcb viewer failed', err);
        if (!this._disposed) this.status.innerHTML = '<div>Could not load the PCB viewer.</div>';
      });
    }

    async _mount(opts) {
      await loadOnce('kicanvas', () => loadScript(KICANVAS_SRC, { type: 'module' }));
      await Promise.race([
        customElements.whenDefined('kicanvas-embed'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('kicanvas timeout')), 15000)),
      ]);
      if (this._disposed) return;
      const el = document.createElement('kicanvas-embed');
      el.setAttribute('controls', 'full');
      const files = opts.files && opts.files.length ? opts.files : [opts.src];
      if (files.length === 1) el.setAttribute('src', files[0]);
      else files.forEach(f => { const s = document.createElement('kicanvas-source'); s.setAttribute('src', f); el.appendChild(s); });
      this.root.appendChild(el);
      this.status.hidden = true;
    }

    dispose() { this._disposed = true; this.root.remove(); }
  }

  // ------------------------------------------------------------------ PDF drawings
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  class PdfViewer {
    constructor(host, opts) {
      this.root = document.createElement('div');
      this.root.className = 'pdf-host';
      host.appendChild(this.root);
      this.pages = document.createElement('div');
      this.pages.className = 'pdf-pages';
      this.root.appendChild(this.pages);
      this.status = document.createElement('div');
      this.status.className = 'viewer-status';
      this.status.innerHTML = '<div><div class="spin"></div><span>Loading drawing…</span></div>';
      this.root.appendChild(this.status);
      this.zoom = 1;
      const bar = document.createElement('div');
      bar.className = 'viewer-tools';
      const mk = (txt, label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn'; b.textContent = txt; b.title = label; b.setAttribute('aria-label', label); b.addEventListener('click', fn); bar.appendChild(b); };
      mk('−', 'Zoom out', () => this._setZoom(this.zoom / 1.4));
      mk('+', 'Zoom in', () => this._setZoom(this.zoom * 1.4));
      const a = document.createElement('a'); a.className = 'icon-btn'; a.href = opts.src; a.target = '_blank'; a.rel = 'noopener'; a.title = 'Open PDF'; a.setAttribute('aria-label', 'Open PDF');
      a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
      bar.appendChild(a);
      this.root.appendChild(bar);
      this._open(opts.src).catch(err => { console.error('[portfolio] pdf failed', err); if (!this._disposed) this.status.innerHTML = `<div>Could not show the drawing. <a href="${opts.src}" target="_blank" rel="noopener">Open the PDF</a></div>`; });
    }
    async _open(src) {
      await loadOnce('pdfjs', () => loadScript(PDFJS + 'pdf.min.js'));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
      this.doc = await window.pdfjsLib.getDocument(src).promise;
      if (this._disposed) return;
      await this._render();
      this.status.hidden = true;
    }
    async _render() {
      const token = (this._token = {});
      this.pages.innerHTML = '';
      const width = Math.max(200, this.root.clientWidth - 24) * this.zoom;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let n = 1; n <= this.doc.numPages; n++) {
        const page = await this.doc.getPage(n);
        if (this._disposed || token !== this._token) return;
        const v1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (width / v1.width) * dpr });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height; c.style.width = width + 'px';
        this.pages.appendChild(c);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      }
    }
    _setZoom(z) { this.zoom = Math.min(4, Math.max(0.5, z)); if (this.doc) this._render(); }
    dispose() { this._disposed = true; if (this.doc) this.doc.destroy(); this.root.remove(); }
  }

  window.ModelViewer = ModelViewer;
  window.PcbViewer = PcbViewer;
  window.PdfViewer = PdfViewer;
})();
