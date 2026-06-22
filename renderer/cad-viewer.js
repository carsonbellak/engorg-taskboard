// CAD Viewer - 3D model rendering using global THREE.js (loaded via CDN)

class CadViewerInstance {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 10000);
    this.camera.position.set(5, 5, 5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;

    // Render-on-demand state. The scene is static, so instead of re-rendering at
    // 60fps forever we render only when something changes: user interaction (with
    // a short decay window for inertial damping), programmatic camera moves, and
    // resizes. Saves continuous CPU/GPU once a model is loaded and idle.
    this._loopRunning = false;
    this._interacting = false;
    this._decayFrames = 0;
    this._renderQueued = false;
    this.controls.addEventListener('start', () => { this._interacting = true; this._startLoop(); });
    this.controls.addEventListener('end', () => { this._interacting = false; this._decayFrames = 90; this._startLoop(); });
    this.controls.addEventListener('change', () => this._requestRender());

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight1.position.set(10, 15, 10);
    dirLight1.castShadow = true;
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight2.position.set(-10, 5, -10);
    this.scene.add(dirLight2);

    const grid = new THREE.GridHelper(20, 20, 0x444466, 0x333355);
    this.scene.add(grid);

    const axesHelper = new THREE.AxesHelper(3);
    this.scene.add(axesHelper);

    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          this.camera.aspect = width / height;
          this.camera.updateProjectionMatrix();
          this.renderer.setSize(width, height);
          this._requestRender();
        }
      }
    });
    this._resizeObserver.observe(container);

    this._animating = true;
    this._requestRender();
    this._addToolbar();
  }

  // Schedule a single frame on the next tick (deduped). For one-off changes —
  // model load, resize, programmatic camera moves — when no loop is running.
  _requestRender() {
    if (!this._animating || this._loopRunning || this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      if (!this._animating || this._loopRunning) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // Continuous loop — runs only while the user is interacting and for a short
  // window after, so inertial damping settles, then stops. Avoids re-rendering
  // a static model at 60fps indefinitely.
  _startLoop() {
    if (!this._animating || this._loopRunning) return;
    this._loopRunning = true;
    this._animate();
  }

  _animate() {
    if (!this._animating || !this._loopRunning) return;
    if (this._interacting) this._decayFrames = 90;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this._interacting || this._decayFrames-- > 0) {
      requestAnimationFrame(() => this._animate());
    } else {
      this._loopRunning = false;
    }
  }

  _addToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'viewer-3d-toolbar';
    toolbar.innerHTML = `
      <button class="viewer-3d-btn" data-action="reset" title="Reset View">\u21BA</button>
      <button class="viewer-3d-btn" data-action="front" title="Front View">F</button>
      <button class="viewer-3d-btn" data-action="top" title="Top View">T</button>
      <button class="viewer-3d-btn" data-action="right" title="Right View">R</button>
      <button class="viewer-3d-btn" data-action="wireframe" title="Toggle Wireframe">W</button>
    `;
    this.container.appendChild(toolbar);

    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const box = new THREE.Box3().setFromObject(this.scene);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const dist = maxDim * 2;

      switch (action) {
        case 'reset':
          this.camera.position.set(dist, dist, dist);
          this.controls.target.copy(center);
          break;
        case 'front':
          this.camera.position.set(center.x, center.y, center.z + dist);
          this.controls.target.copy(center);
          break;
        case 'top':
          this.camera.position.set(center.x, center.y + dist, center.z);
          this.controls.target.copy(center);
          break;
        case 'right':
          this.camera.position.set(center.x + dist, center.y, center.z);
          this.controls.target.copy(center);
          break;
        case 'wireframe':
          this.scene.traverse(child => {
            if (child.isMesh && child.material) {
              child.material.wireframe = !child.material.wireframe;
            }
          });
          break;
      }
      this.controls.update();
      this._requestRender(); // wireframe toggle doesn't move the camera
    });
  }

  fitToModel() {
    const box = new THREE.Box3().setFromObject(this.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 2;

    this.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
    this.controls.target.copy(center);
    this.controls.update();

    this.camera.near = maxDim * 0.001;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
  }

  addMesh(geometry, color) {
    const material = new THREE.MeshStandardMaterial({
      color: color || 0x6688cc,
      metalness: 0.3,
      roughness: 0.6,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  dispose() {
    this._animating = false;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.scene.traverse(child => {
      if (child.isMesh) {
        child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      }
    });
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}

// Global CadViewer namespace
window.CadViewer = {
  _activeInstance: null,

  _ensureCleanup() {
    if (this._activeInstance) {
      this._activeInstance.dispose();
      this._activeInstance = null;
    }
  },

  async loadStepFile(container, filePath) {
    this._ensureCleanup();

    if (typeof occtimportjs === 'undefined') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'lib/occt/occt-import-js.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    const occt = await occtimportjs({
      locateFile: (name) => 'lib/occt/' + name
    });

    const buffer = await window.api.files.readBinary(filePath);
    const fileBuffer = new Uint8Array(buffer);
    const result = occt.ReadStepFile(fileBuffer, null);

    const viewer = new CadViewerInstance(container);
    this._activeInstance = viewer;

    for (let i = 0; i < result.meshes.length; i++) {
      const meshData = result.meshes[i];
      const geometry = new THREE.BufferGeometry();

      const posArr = meshData.attributes.position.array;
      const positions = posArr instanceof Float32Array ? posArr : new Float32Array(posArr);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      if (meshData.attributes.normal) {
        const normArr = meshData.attributes.normal.array;
        const normals = normArr instanceof Float32Array ? normArr : new Float32Array(normArr);
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      } else {
        geometry.computeVertexNormals();
      }

      if (meshData.index) {
        const idxArr = meshData.index.array;
        const indices = idxArr instanceof Uint32Array ? idxArr : new Uint32Array(idxArr);
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      }

      const color = meshData.color
        ? new THREE.Color(meshData.color[0], meshData.color[1], meshData.color[2])
        : new THREE.Color(0x6688cc);

      viewer.addMesh(geometry, color);
    }

    viewer.fitToModel();
  },

  async loadStlFile(container, filePath) {
    this._ensureCleanup();
    const viewer = new CadViewerInstance(container);
    this._activeInstance = viewer;

    const url = await window.api.files.getFileUrl(filePath);
    const loader = new THREE.STLLoader();

    return new Promise((resolve, reject) => {
      loader.load(url, (geometry) => {
        geometry.computeVertexNormals();
        viewer.addMesh(geometry, 0x6688cc);
        viewer.fitToModel();
        resolve();
      }, undefined, reject);
    });
  },

  async loadObjFile(container, filePath) {
    this._ensureCleanup();
    const viewer = new CadViewerInstance(container);
    this._activeInstance = viewer;

    const url = await window.api.files.getFileUrl(filePath);
    const loader = new THREE.OBJLoader();

    return new Promise((resolve, reject) => {
      loader.load(url, (obj) => {
        obj.traverse(child => {
          if (child.isMesh) {
            child.material = new THREE.MeshStandardMaterial({
              color: 0x6688cc,
              metalness: 0.3,
              roughness: 0.6,
              side: THREE.DoubleSide
            });
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        viewer.scene.add(obj);
        viewer.fitToModel();
        resolve();
      }, undefined, reject);
    });
  },

  async loadGlbFile(container, glbArrayBuffer) {
    this._ensureCleanup();
    const viewer = new CadViewerInstance(container);
    this._activeInstance = viewer;

    const loader = new THREE.GLTFLoader();

    return new Promise((resolve, reject) => {
      loader.parse(glbArrayBuffer, '', (gltf) => {
        gltf.scene.traverse(child => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        viewer.scene.add(gltf.scene);
        viewer.fitToModel();
        resolve();
      }, reject);
    });
  }
};
