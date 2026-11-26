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
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(w, h, false);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      this.root.insertBefore(this.renderer.domElement, this.status);

      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 0.75));
      const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(3, 5, 4);
      const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-4, 2, -3);
      this.scene.add(key, fill);
      this.camera.add(new THREE.DirectionalLight(0xffffff, 0.2)); // headlight so no face goes flat black
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
      this._load(this.opts.src).catch(err => {
        console.error('[portfolio] model load failed', err);
        this._setStatus('error', 'Could not load this model.');
      });
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
      this.camera.near = dist / 100;
      this.camera.far = dist * 100;
      this.camera.updateProjectionMatrix();
      this._home = new THREE.Vector3(1, 0.75, 1.15).normalize().multiplyScalar(dist);
      this.controls.minDistance = r * 0.6;
      this.controls.maxDistance = dist * 5;
      this.resetView();
      this._setStatus('done');
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

  window.ModelViewer = ModelViewer;
  window.PcbViewer = PcbViewer;
})();
