// Slicer Tab - OrcaSlicer CLI integration with Three.js STL/G-code viewer

const slicerController = (() => {
  let isActive = false;
  let profiles = { process: [], filament: [] };
  let lastGcodePath = null;

  // Multi-model support
  let loadedModels = []; // { path, name, mesh, bbox }

  // Three.js objects
  let scene, camera, renderer, controls, gridHelper, plateMesh;
  let animFrameId = null;

  // G-code viewer state
  let gcodeMode = false;
  let gcodeLayers = [];       // Array of { z, objects[] }
  let gcodeLayerGroup = null;
  let currentMaxLayer = 0;
  let totalLayers = 0;

  // G-code type colors (matches OrcaSlicer TYPE comments)
  const TYPE_COLORS = {
    'Outer wall':       0xFF8C00, // orange
    'Inner wall':       0xFFD700, // gold
    'Solid infill':     0xE06030, // dark orange
    'Sparse infill':    0x40C040, // green
    'Top surface':      0xFF4040, // red
    'Bottom surface':   0xC04040, // dark red
    'Bridge':           0x40A0FF, // light blue
    'Support':          0x00CED1, // dark cyan
    'Support interface':0x20B2AA, // light sea green
    'Skirt':            0xAA60FF, // purple
    'Brim':             0xAA60FF, // purple
    'Wipe tower':       0x888888, // gray
    'Custom':           0xFF69B4, // pink
    'default':          0x3B82F6  // blue fallback
  };

  function activate() {
    if (!isActive) {
      isActive = true;
      render();
      loadProfiles();
    }
  }

  function deactivate() {
    isActive = false;
    stopAnimation();
  }

  function stopAnimation() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  async function loadProfiles() {
    try {
      profiles = await window.api.slicer.getProfiles();
      updateProfileDropdowns();
    } catch (e) {
      console.warn('Failed to load slicer profiles:', e);
    }
  }

  function updateProfileDropdowns() {
    const processSelect = document.getElementById('slicer-process-select');
    const filamentSelect = document.getElementById('slicer-filament-select');
    if (!processSelect || !filamentSelect) return;

    processSelect.innerHTML = '';
    let lastSource = null;
    for (const p of profiles.process) {
      if (p.source !== lastSource) {
        const optGroup = document.createElement('optgroup');
        optGroup.label = p.source === 'user' ? 'My Profiles' : 'System Profiles';
        processSelect.appendChild(optGroup);
        lastSource = p.source;
      }
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ path: p.path, source: p.source });
      opt.textContent = p.name;
      if (p.source === 'user') opt.textContent += ' *';
      processSelect.lastElementChild.appendChild(opt);
    }

    filamentSelect.innerHTML = '';
    lastSource = null;
    for (const p of profiles.filament) {
      if (p.source !== lastSource) {
        const optGroup = document.createElement('optgroup');
        optGroup.label = p.source === 'user' ? 'My Filaments' : 'System Filaments';
        filamentSelect.appendChild(optGroup);
        lastSource = p.source;
      }
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ path: p.path, source: p.source });
      opt.textContent = p.name;
      if (p.source === 'user') opt.textContent += ' *';
      filamentSelect.lastElementChild.appendChild(opt);
    }
  }

  function render() {
    const container = document.getElementById('view-slicer');
    container.innerHTML = `
      <div class="slicer-dashboard">
        <div class="slicer-main-grid">
          <!-- 3D Viewer -->
          <div class="printer-card slicer-viewer-card">
            <div class="printer-card-header">
              <span class="printer-card-title" id="slicer-viewer-title">3D Model Preview</span>
              <span id="slicer-model-name" class="slicer-model-name">${loadedModels.length ? loadedModels.map(m => escapeHtml(m.name)).join(', ') : 'No model loaded'}</span>
              <div class="slicer-header-btns">
                <button id="slicer-btn-back-model" class="printer-btn printer-btn-sm hidden">Back to Model</button>
                <button id="slicer-btn-load" class="printer-btn printer-btn-sm">Load Model</button>
              </div>
            </div>
            <div id="slicer-viewport" class="slicer-viewport">
              <div id="slicer-viewport-empty" class="slicer-viewport-empty">
                <div class="slicer-empty-icon">&#9649;</div>
                <div class="slicer-empty-text">Load an STL, 3MF, or OBJ file to preview</div>
              </div>
              <canvas id="slicer-canvas"></canvas>

              <!-- Floating tool buttons (top-left of viewport) -->
              <div id="slicer-toolbar" class="slicer-toolbar">
                <button id="slicer-tool-rotate" class="slicer-tool-btn" title="Rotate">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M21.34 15.57a10 10 0 1 1-.57-8.38L21.5 8"/></svg>
                </button>
                <button id="slicer-tool-support" class="slicer-tool-btn" title="Supports">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                </button>
                <button id="slicer-tool-iron" class="slicer-tool-btn" title="Ironing">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20h12"/><path d="M6 16h12l3-8H3l3 8z"/><path d="M9 12V8"/><path d="M15 12V8"/></svg>
                </button>
                <button id="slicer-tool-arrange" class="slicer-tool-btn" title="Arrange">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                </button>
              </div>

              <!-- Rotate panel -->
              <div id="slicer-rotate-panel" class="slicer-float-panel hidden">
                <div class="slicer-float-panel-title">Rotation</div>
                <div class="slicer-orient-grid">
                  <div class="slicer-orient-axis">
                    <span style="color:#EF4444;font-weight:700">X</span>
                    <input type="number" id="slicer-rot-x" class="slicer-input slicer-orient-input" value="0" step="5">
                    <span class="slicer-orient-deg">&deg;</span>
                  </div>
                  <div class="slicer-orient-axis">
                    <span style="color:#22C55E;font-weight:700">Y</span>
                    <input type="number" id="slicer-rot-y" class="slicer-input slicer-orient-input" value="0" step="5">
                    <span class="slicer-orient-deg">&deg;</span>
                  </div>
                  <div class="slicer-orient-axis">
                    <span style="color:#3B82F6;font-weight:700">Z</span>
                    <input type="number" id="slicer-rot-z" class="slicer-input slicer-orient-input" value="0" step="5">
                    <span class="slicer-orient-deg">&deg;</span>
                  </div>
                  <button id="slicer-btn-apply-rot" class="printer-btn printer-btn-sm">Apply</button>
                </div>
                <div class="slicer-float-panel-divider"></div>
                <div class="slicer-float-panel-title">Auto Orient</div>
                <div class="slicer-orient-auto-row">
                  <select id="slicer-auto-orient-mode" class="slicer-select slicer-orient-select">
                    <option value="default">Balanced</option>
                    <option value="min-support">Min Supports</option>
                    <option value="min-time">Min Print Time</option>
                  </select>
                  <button id="slicer-btn-auto-orient" class="printer-btn printer-btn-sm">Orient</button>
                </div>
              </div>

              <!-- Support panel -->
              <div id="slicer-support-panel" class="slicer-float-panel hidden">
                <div class="slicer-float-panel-title">Supports</div>
                <select id="slicer-supports" class="slicer-select">
                  <option value="off">Off</option>
                  <option value="normal">Normal</option>
                  <option value="tree">Tree</option>
                </select>
              </div>

              <!-- Ironing panel -->
              <div id="slicer-iron-panel" class="slicer-float-panel hidden">
                <div class="slicer-float-panel-title">Ironing</div>
                <select id="slicer-ironing-type" class="slicer-select">
                  <option value="off">Off</option>
                  <option value="top">Top Surfaces Only</option>
                  <option value="topmost">Topmost Surface Only</option>
                  <option value="all">All Solid Surfaces</option>
                </select>
                <div class="slicer-float-panel-sub" id="slicer-ironing-options" style="display:none">
                  <div class="slicer-orient-auto-row" style="margin-top:8px">
                    <div class="slicer-orient-axis" style="flex:1">
                      <span style="font-size:11px;color:#64748B">Speed</span>
                      <input type="number" id="slicer-ironing-speed" class="slicer-input slicer-orient-input" value="15" min="1" max="100" step="1">
                      <span class="slicer-orient-deg">mm/s</span>
                    </div>
                  </div>
                  <div class="slicer-orient-auto-row" style="margin-top:6px">
                    <div class="slicer-orient-axis" style="flex:1">
                      <span style="font-size:11px;color:#64748B">Flow</span>
                      <input type="number" id="slicer-ironing-flow" class="slicer-input slicer-orient-input" value="10" min="1" max="50" step="1">
                      <span class="slicer-orient-deg">%</span>
                    </div>
                  </div>
                  <div class="slicer-orient-auto-row" style="margin-top:6px">
                    <div class="slicer-orient-axis" style="flex:1">
                      <span style="font-size:11px;color:#64748B">Spacing</span>
                      <input type="number" id="slicer-ironing-spacing" class="slicer-input slicer-orient-input" value="0.10" min="0.01" max="1" step="0.01">
                      <span class="slicer-orient-deg">mm</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Arrange panel -->
              <div id="slicer-arrange-panel" class="slicer-float-panel hidden">
                <div class="slicer-float-panel-title">Arrange</div>
                <div class="slicer-orient-auto-row">
                  <span style="font-size:12px;color:#475569">Models: <strong id="slicer-model-count">${loadedModels.length}</strong></span>
                </div>
                <div class="slicer-orient-auto-row" style="margin-top:8px">
                  <div class="slicer-orient-axis" style="flex:1">
                    <span style="font-size:11px;color:#64748B">Spacing</span>
                    <input type="number" id="slicer-arrange-spacing" class="slicer-input slicer-orient-input" value="5" min="0" max="50" step="1">
                    <span class="slicer-orient-deg">mm</span>
                  </div>
                </div>
                <div class="slicer-orient-auto-row" style="margin-top:10px;gap:8px">
                  <button id="slicer-btn-arrange" class="printer-btn printer-btn-sm" style="flex:1">Arrange</button>
                  <button id="slicer-btn-clear" class="printer-btn printer-btn-sm printer-btn-danger" style="flex:1">Clear All</button>
                </div>
              </div>

              <!-- Layer slider overlay -->
              <div id="slicer-layer-controls" class="slicer-layer-controls hidden">
                <div class="slicer-layer-slider-wrap">
                  <input type="range" id="slicer-layer-slider" class="slicer-layer-slider" min="1" max="1" value="1" orient="vertical">
                </div>
                <div class="slicer-layer-info">
                  <span id="slicer-layer-num">1 / 1</span>
                  <span id="slicer-layer-z">Z: 0.00</span>
                </div>
              </div>
              <!-- G-code legend -->
              <div id="slicer-gcode-legend" class="slicer-gcode-legend hidden"></div>
            </div>
          </div>

          <!-- Settings Panel -->
          <div class="slicer-settings-col">
            <div class="printer-card">
              <div class="printer-card-header">
                <span class="printer-card-title">Print Settings</span>
              </div>
              <div class="slicer-settings-body">
                <div class="slicer-field">
                  <label class="slicer-label">Print Profile</label>
                  <select id="slicer-process-select" class="slicer-select"></select>
                </div>
                <div class="slicer-field">
                  <label class="slicer-label">Filament</label>
                  <select id="slicer-filament-select" class="slicer-select"></select>
                </div>
                <div class="slicer-divider"></div>
                <div class="slicer-field">
                  <label class="slicer-label">Layer Height (mm)</label>
                  <input type="number" id="slicer-layer-height" class="slicer-input" value="0.20" min="0.04" max="0.60" step="0.02">
                </div>
                <div class="slicer-field">
                  <label class="slicer-label">Infill %</label>
                  <div class="slicer-range-row">
                    <input type="range" id="slicer-infill-range" class="slicer-range" min="0" max="100" value="15" step="5">
                    <span id="slicer-infill-value" class="slicer-range-value">15%</span>
                  </div>
                </div>
              </div>
            </div>

            <button id="slicer-btn-slice" class="printer-btn slicer-btn-slice" disabled>
              <span id="slicer-btn-slice-text">Select a model to slice</span>
            </button>

            <!-- Status -->
            <div id="slicer-status-card" class="printer-card hidden">
              <div class="printer-card-header">
                <span class="printer-card-title">Status</span>
              </div>
              <div class="slicer-status-body">
                <div id="slicer-status-msg" class="slicer-status-msg"></div>
                <div id="slicer-progress-bar" class="slicer-progress-bar hidden">
                  <div id="slicer-progress-fill" class="slicer-progress-fill"></div>
                </div>
              </div>
            </div>

            <!-- Results -->
            <div id="slicer-results-card" class="printer-card hidden">
              <div class="printer-card-header">
                <span class="printer-card-title">Slice Results</span>
              </div>
              <div class="slicer-results-body">
                <div class="slicer-result-grid">
                  <div class="slicer-result-item">
                    <div class="slicer-result-label">Print Time</div>
                    <div id="slicer-result-time" class="slicer-result-value">--</div>
                  </div>
                  <div class="slicer-result-item">
                    <div class="slicer-result-label">Filament</div>
                    <div id="slicer-result-filament" class="slicer-result-value">--</div>
                  </div>
                  <div class="slicer-result-item">
                    <div class="slicer-result-label">Weight</div>
                    <div id="slicer-result-weight" class="slicer-result-value">--</div>
                  </div>
                  <div class="slicer-result-item">
                    <div class="slicer-result-label">File Size</div>
                    <div id="slicer-result-size" class="slicer-result-value">--</div>
                  </div>
                </div>
                <div class="slicer-result-actions">
                  <button id="slicer-btn-view-gcode" class="printer-btn printer-btn-info">View G-code</button>
                  <button id="slicer-btn-upload" class="printer-btn printer-btn-success">Upload to Printer</button>
                  <button id="slicer-btn-upload-print" class="printer-btn printer-btn-print">Upload & Print</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    bindEvents();
    updateProfileDropdowns();

    if (loadedModels.length && !gcodeMode) {
      initThreeJS();
      reloadAllModels();
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  let activePanel = null; // 'rotate' | 'support' | null
  let axisRingsGroup = null;

  function bindEvents() {
    document.getElementById('slicer-btn-load').addEventListener('click', selectModel);

    const infillRange = document.getElementById('slicer-infill-range');
    infillRange.addEventListener('input', () => {
      document.getElementById('slicer-infill-value').textContent = infillRange.value + '%';
    });

    document.getElementById('slicer-btn-slice').addEventListener('click', startSlicing);
    document.getElementById('slicer-btn-upload')?.addEventListener('click', () => uploadGcode(false));
    document.getElementById('slicer-btn-upload-print')?.addEventListener('click', () => uploadGcode(true));
    document.getElementById('slicer-btn-view-gcode')?.addEventListener('click', viewGcode);
    document.getElementById('slicer-btn-back-model')?.addEventListener('click', backToModel);
    document.getElementById('slicer-btn-arrange')?.addEventListener('click', arrangeModels);
    document.getElementById('slicer-btn-clear')?.addEventListener('click', clearAllModels);

    // Toolbar toggle buttons
    document.getElementById('slicer-tool-rotate')?.addEventListener('click', () => togglePanel('rotate'));
    document.getElementById('slicer-tool-support')?.addEventListener('click', () => togglePanel('support'));
    document.getElementById('slicer-tool-iron')?.addEventListener('click', () => togglePanel('iron'));
    document.getElementById('slicer-tool-arrange')?.addEventListener('click', () => togglePanel('arrange'));

    // Ironing type toggle — show/hide options
    document.getElementById('slicer-ironing-type')?.addEventListener('change', (e) => {
      const opts = document.getElementById('slicer-ironing-options');
      if (opts) opts.style.display = e.target.value === 'off' ? 'none' : 'block';
    });

    document.getElementById('slicer-btn-apply-rot')?.addEventListener('click', applyManualRotation);
    document.getElementById('slicer-btn-auto-orient')?.addEventListener('click', autoOrient);

    for (const id of ['slicer-rot-x', 'slicer-rot-y', 'slicer-rot-z']) {
      document.getElementById(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyManualRotation();
      });
    }

    const slider = document.getElementById('slicer-layer-slider');
    if (slider) {
      slider.addEventListener('input', () => setVisibleLayers(parseInt(slider.value)));
    }
  }

  // ===== Toolbar Panels =====
  const panelIds = {
    rotate:  { panel: 'slicer-rotate-panel',  btn: 'slicer-tool-rotate' },
    support: { panel: 'slicer-support-panel',  btn: 'slicer-tool-support' },
    iron:    { panel: 'slicer-iron-panel',     btn: 'slicer-tool-iron' },
    arrange: { panel: 'slicer-arrange-panel',  btn: 'slicer-tool-arrange' }
  };

  function togglePanel(panel) {
    const closing = activePanel === panel;
    activePanel = closing ? null : panel;

    for (const [key, ids] of Object.entries(panelIds)) {
      const el = document.getElementById(ids.panel);
      const btn = document.getElementById(ids.btn);
      const show = !closing && key === panel;
      el?.classList.toggle('hidden', !show);
      btn?.classList.toggle('active', show);
    }

    if (activePanel === 'rotate') showAxisRings();
    else removeAxisRings();
  }

  // ===== Axis Visualization Rings =====
  function showAxisRings() {
    removeAxisRings();
    if (!scene || loadedModels.length === 0) return;

    axisRingsGroup = new THREE.Group();

    // Get model center and size for ring radius
    const box = new THREE.Box3().setFromObject(loadedModels[0].mesh);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) * 0.7;

    // X axis = Red ring (rotates around X → lies in YZ plane)
    const xRing = createRing(radius, 0xEF4444);
    xRing.rotation.y = Math.PI / 2; // YZ plane
    xRing.position.copy(center);
    axisRingsGroup.add(xRing);

    // Y axis = Green ring (rotates around Y → lies in XZ plane)
    // In Three.js this is rotateZ, but for the user it's "Y" = print Y
    const yRing = createRing(radius, 0x22C55E);
    yRing.rotation.x = Math.PI / 2; // XZ plane
    yRing.position.copy(center);
    axisRingsGroup.add(yRing);

    // Z axis = Blue ring (rotates around Z → lies in XY plane, yaw on plate)
    // In Three.js this is rotateY
    const zRing = createRing(radius, 0x3B82F6);
    // Default orientation: XY plane (no rotation needed for TorusGeometry which is in XY)
    zRing.position.copy(center);
    axisRingsGroup.add(zRing);

    scene.add(axisRingsGroup);
  }

  function createRing(radius, color) {
    const geometry = new THREE.TorusGeometry(radius, radius * 0.015, 16, 64);
    const material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.6, depthTest: false
    });
    return new THREE.Mesh(geometry, material);
  }

  function removeAxisRings() {
    if (axisRingsGroup && scene) {
      axisRingsGroup.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      scene.remove(axisRingsGroup);
      axisRingsGroup = null;
    }
  }

  // ===== Model Rotation =====
  function applyManualRotation() {
    if (loadedModels.length === 0) return;
    const rx = (parseFloat(document.getElementById('slicer-rot-x').value) || 0) * Math.PI / 180;
    const ry = (parseFloat(document.getElementById('slicer-rot-y').value) || 0) * Math.PI / 180;
    const rz = (parseFloat(document.getElementById('slicer-rot-z').value) || 0) * Math.PI / 180;

    for (const m of loadedModels) {
      if (!m.mesh) continue;
      // Reset rotation first, then apply new angles
      m.mesh.rotation.set(0, 0, 0);
      m.mesh.position.y = 0;
      // Apply in XYZ order (print-space: X=pitch, Y=roll, Z=yaw on plate)
      m.mesh.rotateX(rx);
      m.mesh.rotateZ(ry);  // print Y → Three.js Z
      m.mesh.rotateY(rz);  // print Z → Three.js Y (plate rotation)
      seatOnPlate(m);
    }
    frameCameraToModels();
    if (activePanel === 'rotate') showAxisRings();
  }

  function seatOnPlate(m) {
    m.mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(m.mesh);
    if (box.min.y < 0) m.mesh.position.y -= box.min.y;
    const size = new THREE.Vector3();
    box.getSize(size);
    m.size = size;
  }

  // ===== Auto Orient =====
  function autoOrient() {
    if (loadedModels.length === 0) return;
    const mode = document.getElementById('slicer-auto-orient-mode').value;

    showStatus('Finding optimal orientation...', 'progress');
    // Defer to let UI update
    setTimeout(() => {
      for (const m of loadedModels) {
        if (!m.mesh) continue;
        findBestOrientation(m, mode);
      }
      frameCameraToModels();
      // Update the rotation inputs to reflect the chosen angles
      if (loadedModels.length > 0) {
        const m = loadedModels[0].mesh;
        document.getElementById('slicer-rot-x').value = Math.round(m.rotation.x * 180 / Math.PI);
        document.getElementById('slicer-rot-y').value = Math.round(m.rotation.z * 180 / Math.PI);
        document.getElementById('slicer-rot-z').value = Math.round(m.rotation.y * 180 / Math.PI);
      }
      if (activePanel === 'rotate') showAxisRings();
      showStatus('Orientation optimized (' + mode + ')', 'success');
    }, 50);
  }

  function findBestOrientation(model, mode) {
    const mesh = model.mesh;
    const geometry = mesh.geometry;

    // Get face normals and areas from the geometry
    const posAttr = geometry.attributes.position;
    const triCount = posAttr.count / 3;

    // Pre-compute face normals and areas in local space
    const faces = [];
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();

    for (let i = 0; i < triCount; i++) {
      vA.fromBufferAttribute(posAttr, i * 3);
      vB.fromBufferAttribute(posAttr, i * 3 + 1);
      vC.fromBufferAttribute(posAttr, i * 3 + 2);
      ab.subVectors(vB, vA);
      ac.subVectors(vC, vA);
      normal.crossVectors(ab, ac);
      const area = normal.length() * 0.5;
      if (area > 0.001) {
        normal.normalize();
        faces.push({ nx: normal.x, ny: normal.y, nz: normal.z, area });
      }
    }

    // Candidate orientations: sample 26 directions (6 faces + 12 edges + 8 corners)
    const candidates = [];
    const angles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    for (const rx of angles) {
      for (const ry of angles) {
        candidates.push([rx, 0, ry]);
      }
    }
    // Add 45-degree tilts
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      candidates.push([a, 0, 0], [0, 0, a], [a, 0, Math.PI / 2], [a, 0, -Math.PI / 2]);
    }

    let bestScore = Infinity;
    let bestRot = [0, 0, 0];
    const overhangThreshold = Math.cos(45 * Math.PI / 180); // 45 degrees

    for (const [rx, ry, rz] of candidates) {
      // Build rotation matrix
      const euler = new THREE.Euler(rx, rz, ry, 'XYZ');
      const mat = new THREE.Matrix4().makeRotationFromEuler(euler);
      const normalMat = new THREE.Matrix3().setFromMatrix4(mat);

      let supportArea = 0;
      const rotN = new THREE.Vector3();
      // Also compute bounding box height
      let minY = Infinity, maxY = -Infinity;

      for (const f of faces) {
        rotN.set(f.nx, f.ny, f.nz).applyMatrix3(normalMat).normalize();
        // Overhang: face normal pointing down more than 45° from vertical
        if (rotN.y < -overhangThreshold) {
          supportArea += f.area;
        }
      }

      // Compute rotated bounding height
      const testPos = new THREE.Vector3();
      for (let i = 0; i < posAttr.count; i++) {
        testPos.fromBufferAttribute(posAttr, i).applyMatrix4(mat);
        if (testPos.y < minY) minY = testPos.y;
        if (testPos.y > maxY) maxY = testPos.y;
      }
      const height = maxY - minY;

      // Score based on mode
      let score;
      if (mode === 'min-support') {
        score = supportArea;
      } else if (mode === 'min-time') {
        score = height; // shorter = fewer layers = faster
      } else {
        // Default: balanced — weight both
        score = supportArea * 2 + height;
      }

      if (score < bestScore) {
        bestScore = score;
        bestRot = [rx, ry, rz];
      }
    }

    // Apply best rotation
    mesh.rotation.set(0, 0, 0);
    mesh.position.y = 0;
    mesh.rotateX(bestRot[0]);
    mesh.rotateZ(bestRot[1]);
    mesh.rotateY(bestRot[2]);
    seatOnPlate(model);
  }

  // ===== Model Loading (multi-model) =====
  async function selectModel() {
    const filePath = await window.api.slicer.selectModel();
    if (!filePath) return;

    if (gcodeMode) exitGcodeMode();

    const name = filePath.split(/[\\/]/).pop();

    if (!scene) initThreeJS();

    await addModelToScene(filePath, name);

    updateModelUI();
  }

  function updateModelUI() {
    const nameEl = document.getElementById('slicer-model-name');
    if (nameEl) nameEl.textContent = loadedModels.map(m => m.name).join(', ') || 'No model loaded';

    const countEl = document.getElementById('slicer-model-count');
    if (countEl) countEl.textContent = loadedModels.length;

    const sliceBtn = document.getElementById('slicer-btn-slice');
    if (sliceBtn) {
      sliceBtn.disabled = loadedModels.length === 0;
      document.getElementById('slicer-btn-slice-text').textContent = loadedModels.length ? 'Slice' : 'Select a model to slice';
    }

    document.getElementById('slicer-results-card')?.classList.add('hidden');
  }

  async function addModelToScene(filePath, name) {
    try {
      const data = await window.api.files.readBinary(filePath);
      if (!data) return;

      const ext = filePath.split('.').pop().toLowerCase();
      let geometry;

      if (ext === 'stl') {
        geometry = parseSTL(data.buffer || data);
      } else if (ext === 'obj') {
        const text = await window.api.files.readText(filePath);
        geometry = parseOBJ(text);
      } else {
        console.warn('Unsupported format:', ext);
        return;
      }

      if (!geometry) return;

      geometry.computeVertexNormals();
      geometry.center();
      geometry.computeBoundingBox();
      const bbox = geometry.boundingBox;
      const size = new THREE.Vector3();
      bbox.getSize(size);

      // Sit on the build plate
      geometry.translate(0, -bbox.min.y, 0);

      // Random color per model
      const hue = (loadedModels.length * 0.37 + 0.6) % 1;
      const color = new THREE.Color().setHSL(hue, 0.7, 0.55);

      const material = new THREE.MeshPhongMaterial({
        color, specular: 0x444444, shininess: 40
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      // Recompute bbox after translate
      geometry.computeBoundingBox();

      loadedModels.push({ path: filePath, name, mesh, size });

      // Auto-arrange if multiple models
      if (loadedModels.length > 1) {
        arrangeModels();
      } else {
        frameCameraToModels();
      }
    } catch (e) {
      console.error('Failed to load model:', e);
    }
  }

  function reloadAllModels() {
    const paths = loadedModels.map(m => ({ path: m.path, name: m.name }));
    // Clear meshes from scene
    for (const m of loadedModels) {
      if (m.mesh) {
        scene.remove(m.mesh);
        m.mesh.geometry?.dispose();
        m.mesh.material?.dispose();
      }
    }
    loadedModels = [];
    for (const p of paths) {
      addModelToScene(p.path, p.name);
    }
  }

  function clearAllModels() {
    removeAxisRings();
    for (const m of loadedModels) {
      if (m.mesh && scene) {
        scene.remove(m.mesh);
        m.mesh.geometry?.dispose();
        m.mesh.material?.dispose();
      }
    }
    loadedModels = [];
    lastGcodePath = null;
    updateModelUI();
  }

  // ===== Arrange =====
  function arrangeModels() {
    if (loadedModels.length === 0) return;

    const spacingInput = document.getElementById('slicer-arrange-spacing');
    const spacing = spacingInput ? parseFloat(spacingInput.value) || 5 : 5;
    const plateSize = 220;

    if (loadedModels.length === 1) {
      // Center single model
      const m = loadedModels[0];
      m.mesh.position.set(0, 0, 0);
      frameCameraToModels();
      return;
    }

    // Sort by largest dimension descending for better packing
    const sorted = [...loadedModels].sort((a, b) => {
      const aMax = Math.max(a.size.x, a.size.z);
      const bMax = Math.max(b.size.x, b.size.z);
      return bMax - aMax;
    });

    // Simple row-based packing
    let curX = -plateSize / 2 + spacing;
    let curZ = -plateSize / 2 + spacing;
    let rowHeight = 0;

    for (const m of sorted) {
      const w = m.size.x;
      const d = m.size.z;

      // New row if doesn't fit
      if (curX + w + spacing > plateSize / 2) {
        curX = -plateSize / 2 + spacing;
        curZ += rowHeight + spacing;
        rowHeight = 0;
      }

      m.mesh.position.set(curX + w / 2, 0, curZ + d / 2);
      curX += w + spacing;
      rowHeight = Math.max(rowHeight, d);
    }

    frameCameraToModels();
  }

  function frameCameraToModels() {
    if (!camera || !controls || loadedModels.length === 0) return;

    // Compute combined bounds
    const allMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const allMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of loadedModels) {
      const bb = new THREE.Box3().setFromObject(m.mesh);
      allMin.min(bb.min);
      allMax.max(bb.max);
    }
    const center = allMin.clone().add(allMax).multiplyScalar(0.5);
    const size = allMax.clone().sub(allMin);
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.8;

    camera.position.set(center.x + dist * 0.6, dist * 0.5, center.z + dist * 0.6);
    controls.target.copy(center);
    controls.update();
  }

  // ===== Three.js Setup =====
  function initThreeJS() {
    const canvas = document.getElementById('slicer-canvas');
    const viewport = document.getElementById('slicer-viewport');
    if (!canvas || !viewport) return;

    const emptyState = document.getElementById('slicer-viewport-empty');
    if (emptyState) emptyState.style.display = 'none';
    canvas.style.display = 'block';

    stopAnimation();
    if (renderer) renderer.dispose();

    const width = viewport.clientWidth;
    const height = viewport.clientHeight || 500;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f2f5);

    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    camera.position.set(200, 200, 200);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    if (typeof THREE.OrbitControls !== 'undefined') {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.1;
      controls.autoRotateSpeed = 3;
      controls.target.set(0, 0, 0);
    }

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dir1.position.set(200, 300, 200);
    dir1.castShadow = true;
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir2.position.set(-100, 200, -100);
    scene.add(dir2);

    // Grid (220mm K1C build plate)
    gridHelper = new THREE.GridHelper(220, 22, 0xcccccc, 0xe0e0e0);
    scene.add(gridHelper);

    const plateGeom = new THREE.PlaneGeometry(220, 220);
    const plateMat = new THREE.MeshBasicMaterial({ color: 0xe8ecf0, side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
    plateMesh = new THREE.Mesh(plateGeom, plateMat);
    plateMesh.rotation.x = -Math.PI / 2;
    plateMesh.position.y = -0.1;
    scene.add(plateMesh);

    animate();

    const resizeObserver = new ResizeObserver(() => {
      const w = viewport.clientWidth;
      const h = viewport.clientHeight;
      if (w > 0 && h > 0) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
    });
    resizeObserver.observe(viewport);
  }

  function animate() {
    animFrameId = requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }

  // ===== Parsers =====
  function parseSTL(buffer) {
    const arrayBuffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const dv = new DataView(arrayBuffer);
    const header = String.fromCharCode.apply(null, new Uint8Array(arrayBuffer, 0, 5));
    if (header === 'solid') {
      const triCount = dv.getUint32(80, true);
      const expectedSize = 80 + 4 + triCount * 50;
      if (Math.abs(arrayBuffer.byteLength - expectedSize) > 100) {
        return parseSTLAscii(new TextDecoder().decode(arrayBuffer));
      }
    }
    const numTriangles = dv.getUint32(80, true);
    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array(numTriangles * 9);
    const normals = new Float32Array(numTriangles * 9);
    let offset = 84;
    for (let i = 0; i < numTriangles; i++) {
      const nx = dv.getFloat32(offset, true); offset += 4;
      const ny = dv.getFloat32(offset, true); offset += 4;
      const nz = dv.getFloat32(offset, true); offset += 4;
      for (let j = 0; j < 3; j++) {
        const idx = i * 9 + j * 3;
        vertices[idx] = dv.getFloat32(offset, true); offset += 4;
        vertices[idx + 1] = dv.getFloat32(offset, true); offset += 4;
        vertices[idx + 2] = dv.getFloat32(offset, true); offset += 4;
        normals[idx] = nx; normals[idx + 1] = ny; normals[idx + 2] = nz;
      }
      offset += 2;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    return geometry;
  }

  function parseSTLAscii(text) {
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    const re = /vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) vertices.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    return geometry;
  }

  function parseOBJ(text) {
    const positions = [], finalVerts = [];
    for (const line of text.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'v') positions.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
      else if (parts[0] === 'f') {
        const fv = parts.slice(1).map(p => parseInt(p.split('/')[0]) - 1);
        for (let i = 1; i < fv.length - 1; i++)
          for (const idx of [fv[0], fv[i], fv[i + 1]])
            finalVerts.push(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(finalVerts), 3));
    return geometry;
  }

  // ===== G-code Parser =====
  function parseGcode(text) {
    const layers = [];
    let curX = 0, curY = 0, curZ = 0, curE = 0;
    let absolute = true, absoluteE = true;
    let currentType = 'default';
    let currentWidth = 0.45;  // default nozzle width
    let currentHeight = 0.2;  // default layer height

    // Per-layer segments: type -> [{fx,fz,tx,tz, width}]  (Y is the layer Z)
    let layerSegments = {};
    let layerTravels = []; // flat array of fx,fy,fz,tx,ty,tz
    let lastZ = -999;

    const offsetX = -110, offsetY = -110;

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const full = lines[i].trim();
      const commentIdx = full.indexOf(';');
      const cmd = commentIdx >= 0 ? full.substring(0, commentIdx).trim() : full;
      const comment = commentIdx >= 0 ? full.substring(commentIdx + 1).trim() : '';

      // Parse OrcaSlicer metadata comments
      if (comment.startsWith('TYPE:')) { currentType = comment.substring(5).trim(); continue; }
      if (comment.startsWith('WIDTH:')) { currentWidth = parseFloat(comment.substring(6)) || 0.45; continue; }
      if (comment.startsWith('HEIGHT:')) { currentHeight = parseFloat(comment.substring(7)) || 0.2; continue; }

      if (cmd === 'G90') { absolute = true; continue; }
      if (cmd === 'G91') { absolute = false; continue; }
      if (cmd === 'M82') { absoluteE = true; continue; }
      if (cmd === 'M83') { absoluteE = false; continue; }
      if (cmd.startsWith('G92')) {
        const tokens = cmd.split(/\s+/);
        for (const t of tokens) {
          if (t[0] === 'E') curE = parseFloat(t.substring(1)) || 0;
        }
        continue;
      }

      if (!cmd.startsWith('G0') && !cmd.startsWith('G1')) continue;

      const params = {};
      const tokens = cmd.split(/\s+/);
      for (const t of tokens) {
        const key = t[0];
        if ('XYZEF'.includes(key)) params[key] = parseFloat(t.substring(1));
      }

      const prevX = curX, prevY = curY, prevZ = curZ, prevE = curE;

      if (absolute) {
        if (params.X !== undefined) curX = params.X;
        if (params.Y !== undefined) curY = params.Y;
        if (params.Z !== undefined) curZ = params.Z;
      } else {
        if (params.X !== undefined) curX += params.X;
        if (params.Y !== undefined) curY += params.Y;
        if (params.Z !== undefined) curZ += params.Z;
      }
      if (absoluteE) {
        if (params.E !== undefined) curE = params.E;
      } else {
        if (params.E !== undefined) curE += params.E;
      }

      // Layer change
      if (curZ !== lastZ) {
        if (Object.keys(layerSegments).length > 0 || layerTravels.length > 0) {
          layers.push({ z: lastZ, segments: layerSegments, travels: layerTravels });
        }
        layerSegments = {};
        layerTravels = [];
        lastZ = curZ;
      }

      if (params.X === undefined && params.Y === undefined) continue;

      const isExtrude = absoluteE ? curE > prevE : (params.E !== undefined && params.E > 0);

      // Gcode XY → Three.js: X stays, Z = -Y, Y = layer height
      const fx = prevX + offsetX, fz = -(prevY + offsetY);
      const tx = curX + offsetX, tz = -(curY + offsetY);

      if (isExtrude) {
        if (!layerSegments[currentType]) layerSegments[currentType] = [];
        layerSegments[currentType].push({ fx, fz, tx, tz, width: currentWidth, height: currentHeight });
      } else {
        layerTravels.push(fx, curZ, fz, tx, curZ, tz);
      }
    }

    if (Object.keys(layerSegments).length > 0 || layerTravels.length > 0) {
      layers.push({ z: lastZ, segments: layerSegments, travels: layerTravels });
    }

    return layers;
  }

  // Build a flat ribbon quad for each extrusion segment
  // Each segment becomes 2 triangles (6 verts) forming a rectangle at the layer Z
  function buildRibbonGeometry(segments, layerZ) {
    const vertCount = segments.length * 6; // 2 tris per segment
    const positions = new Float32Array(vertCount * 3);
    let vi = 0;

    for (const seg of segments) {
      const dx = seg.tx - seg.fx;
      const dz = seg.tz - seg.fz;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.001) continue;

      // Perpendicular offset (half width)
      const hw = seg.width * 0.5;
      const nx = (-dz / len) * hw;
      const nz = (dx / len) * hw;

      const y = layerZ; // flat at layer height

      // Quad: 4 corners, 2 triangles
      // Bottom-left, bottom-right, top-right, top-left
      const x0 = seg.fx + nx, z0 = seg.fz + nz;  // from + offset
      const x1 = seg.fx - nx, z1 = seg.fz - nz;  // from - offset
      const x2 = seg.tx - nx, z2 = seg.tz - nz;  // to - offset
      const x3 = seg.tx + nx, z3 = seg.tz + nz;  // to + offset

      // Triangle 1: 0-1-2
      positions[vi++] = x0; positions[vi++] = y; positions[vi++] = z0;
      positions[vi++] = x1; positions[vi++] = y; positions[vi++] = z1;
      positions[vi++] = x2; positions[vi++] = y; positions[vi++] = z2;
      // Triangle 2: 0-2-3
      positions[vi++] = x0; positions[vi++] = y; positions[vi++] = z0;
      positions[vi++] = x2; positions[vi++] = y; positions[vi++] = z2;
      positions[vi++] = x3; positions[vi++] = y; positions[vi++] = z3;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, vi), 3));
    geom.computeVertexNormals();
    return geom;
  }

  function buildGcodeScene(layers) {
    clearGcodeScene();
    gcodeLayerGroup = new THREE.Group();
    gcodeLayers = [];

    const usedTypes = new Set();

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const layerObj = { z: layer.z, objects: [] };

      // Extrusion ribbons by type
      for (const [type, segments] of Object.entries(layer.segments)) {
        usedTypes.add(type);
        const colorHex = TYPE_COLORS[type] || TYPE_COLORS['default'];

        const geom = buildRibbonGeometry(segments, layer.z);
        if (geom.attributes.position.count === 0) continue;

        const mat = new THREE.MeshBasicMaterial({
          color: colorHex,
          side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geom, mat);
        layerObj.objects.push(mesh);
        gcodeLayerGroup.add(mesh);
      }

      // Travel moves (thin lines, faint)
      if (layer.travels.length > 0) {
        const positions = new Float32Array(layer.travels);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.LineBasicMaterial({
          color: 0x556677, transparent: true, opacity: 0.12, depthWrite: false
        });
        const line = new THREE.LineSegments(geom, mat);
        layerObj.objects.push(line);
        gcodeLayerGroup.add(line);
      }

      gcodeLayers.push(layerObj);
    }

    scene.add(gcodeLayerGroup);
    totalLayers = gcodeLayers.length;
    currentMaxLayer = totalLayers;

    buildLegend(usedTypes);
  }

  function buildLegend(types) {
    const el = document.getElementById('slicer-gcode-legend');
    if (!el) return;
    el.classList.remove('hidden');

    let html = '';
    for (const type of types) {
      const color = TYPE_COLORS[type] || TYPE_COLORS['default'];
      const hex = '#' + color.toString(16).padStart(6, '0');
      html += `<div class="slicer-legend-item"><span class="slicer-legend-swatch" style="background:${hex}"></span>${escapeHtml(type)}</div>`;
    }
    el.innerHTML = html;
  }

  function setVisibleLayers(maxLayer) {
    currentMaxLayer = maxLayer;
    for (let i = 0; i < gcodeLayers.length; i++) {
      const visible = i < maxLayer;
      for (const obj of gcodeLayers[i].objects) obj.visible = visible;
    }
    const numEl = document.getElementById('slicer-layer-num');
    const zEl = document.getElementById('slicer-layer-z');
    if (numEl) numEl.textContent = `${maxLayer} / ${totalLayers}`;
    if (zEl && gcodeLayers[maxLayer - 1]) zEl.textContent = `Z: ${gcodeLayers[maxLayer - 1].z.toFixed(2)} mm`;
  }

  function clearGcodeScene() {
    if (gcodeLayerGroup && scene) {
      gcodeLayerGroup.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      scene.remove(gcodeLayerGroup);
    }
    gcodeLayerGroup = null;
    gcodeLayers = [];
    totalLayers = 0;
    currentMaxLayer = 0;
    const legend = document.getElementById('slicer-gcode-legend');
    if (legend) { legend.classList.add('hidden'); legend.innerHTML = ''; }
  }

  async function viewGcode() {
    if (!lastGcodePath) return;
    showStatus('Loading G-code...', 'progress');

    try {
      const text = await window.api.files.readText(lastGcodePath);
      if (!text) { showStatus('Failed to read G-code file', 'error'); return; }

      showStatus('Parsing G-code layers...', 'progress');
      await new Promise(r => setTimeout(r, 50));

      const layers = parseGcode(text);
      if (layers.length === 0) { showStatus('No layers found in G-code', 'error'); return; }

      enterGcodeMode();
      buildGcodeScene(layers);

      const slider = document.getElementById('slicer-layer-slider');
      slider.min = 1;
      slider.max = totalLayers;
      slider.value = totalLayers;
      setVisibleLayers(totalLayers);

      const maxZ = layers[layers.length - 1].z;
      const dist = Math.max(220, maxZ * 2.5);
      camera.position.set(dist * 0.5, dist * 0.5, dist * 0.5);
      if (controls) { controls.target.set(0, maxZ / 2, 0); controls.update(); }

      showStatus(`G-code loaded: ${totalLayers} layers`, 'success');
    } catch (e) {
      showStatus('Error loading G-code: ' + e.message, 'error');
      console.error(e);
    }
  }

  function enterGcodeMode() {
    gcodeMode = true;
    for (const m of loadedModels) if (m.mesh) m.mesh.visible = false;
    if (scene) scene.background = new THREE.Color(0x0f1520);

    document.getElementById('slicer-layer-controls')?.classList.remove('hidden');
    const title = document.getElementById('slicer-viewer-title');
    if (title) title.textContent = 'G-code Viewer';
    document.getElementById('slicer-btn-back-model')?.classList.remove('hidden');
    document.getElementById('slicer-btn-load')?.classList.add('hidden');

    setGridDark(true);
  }

  function exitGcodeMode() {
    gcodeMode = false;
    clearGcodeScene();
    for (const m of loadedModels) if (m.mesh) m.mesh.visible = true;
    if (scene) scene.background = new THREE.Color(0xf0f2f5);

    document.getElementById('slicer-layer-controls')?.classList.add('hidden');
    const title = document.getElementById('slicer-viewer-title');
    if (title) title.textContent = '3D Model Preview';
    document.getElementById('slicer-btn-back-model')?.classList.add('hidden');
    document.getElementById('slicer-btn-load')?.classList.remove('hidden');

    setGridDark(false);
  }

  function setGridDark(dark) {
    if (gridHelper) {
      const mats = Array.isArray(gridHelper.material) ? gridHelper.material : [gridHelper.material];
      mats.forEach(m => m.color.set(dark ? 0x252540 : 0xcccccc));
    }
    if (plateMesh) {
      plateMesh.material.color.set(dark ? 0x151525 : 0xe8ecf0);
      plateMesh.material.opacity = dark ? 0.9 : 0.5;
    }
  }

  function backToModel() {
    exitGcodeMode();
    frameCameraToModels();
  }

  // ===== Slicing =====
  async function startSlicing() {
    if (loadedModels.length === 0) return;

    const processSelect = document.getElementById('slicer-process-select');
    const filamentSelect = document.getElementById('slicer-filament-select');
    if (!processSelect.value || !filamentSelect.value) {
      showStatus('Please select both a print profile and filament.', 'error');
      return;
    }

    if (gcodeMode) exitGcodeMode();

    const processProfile = JSON.parse(processSelect.value);
    const filamentProfile = JSON.parse(filamentSelect.value);

    const supportsVal = document.getElementById('slicer-supports').value;

    const ironType = document.getElementById('slicer-ironing-type')?.value || 'off';

    const overrides = {
      infill: parseInt(document.getElementById('slicer-infill-range').value),
      supports: supportsVal !== 'off' ? supportsVal : false,
      layerHeight: parseFloat(document.getElementById('slicer-layer-height').value),
      ironing: ironType !== 'off' ? {
        type: ironType,
        speed: parseFloat(document.getElementById('slicer-ironing-speed')?.value) || 15,
        flow: parseFloat(document.getElementById('slicer-ironing-flow')?.value) || 10,
        spacing: parseFloat(document.getElementById('slicer-ironing-spacing')?.value) || 0.1
      } : false
    };

    const sliceBtn = document.getElementById('slicer-btn-slice');
    sliceBtn.disabled = true;
    document.getElementById('slicer-btn-slice-text').textContent = 'Slicing...';
    document.getElementById('slicer-results-card').classList.add('hidden');
    showStatus('Slicing model with OrcaSlicer...', 'progress');

    try {
      // Use first model path for now (OrcaSlicer handles single file)
      const result = await window.api.slicer.slice({
        modelPath: loadedModels[0].path,
        processProfile,
        filamentProfile,
        overrides
      });

      if (result.success) {
        lastGcodePath = result.gcodePath;
        showStatus('Slicing complete!', 'success');
        showResults(result.estimates);
      } else {
        showStatus('Slicing failed: ' + (result.error || 'Unknown error'), 'error');
        if (result.output) console.error('Slicer output:', result.output);
      }
    } catch (e) {
      showStatus('Slicing error: ' + e.message, 'error');
    }

    sliceBtn.disabled = false;
    document.getElementById('slicer-btn-slice-text').textContent = 'Slice';
  }

  function showStatus(message, type) {
    const card = document.getElementById('slicer-status-card');
    const msg = document.getElementById('slicer-status-msg');
    const progressBar = document.getElementById('slicer-progress-bar');
    card.classList.remove('hidden');
    msg.textContent = message;
    msg.className = 'slicer-status-msg slicer-status-' + type;
    if (type === 'progress') {
      progressBar.classList.remove('hidden');
      document.getElementById('slicer-progress-fill').style.width = '100%';
    } else {
      progressBar.classList.add('hidden');
    }
  }

  function showResults(estimates) {
    const card = document.getElementById('slicer-results-card');
    card.classList.remove('hidden');
    document.getElementById('slicer-result-time').textContent = estimates.time || '--';
    document.getElementById('slicer-result-filament').textContent = estimates.filamentM ? estimates.filamentM + ' m' : '--';
    document.getElementById('slicer-result-weight').textContent = estimates.filamentG ? estimates.filamentG.toFixed(1) + ' g' : '--';
    document.getElementById('slicer-result-size').textContent = estimates.fileSize ? formatFileSize(estimates.fileSize) : '--';
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ===== Upload =====
  async function uploadGcode(startPrint) {
    if (!lastGcodePath) return;
    const uploadBtn = document.getElementById('slicer-btn-upload');
    const printBtn = document.getElementById('slicer-btn-upload-print');
    uploadBtn.disabled = true;
    printBtn.disabled = true;
    showStatus('Uploading G-code to printer...', 'progress');

    try {
      const settings = await window.api.loadData('settings.json') || {};
      const ip = settings.printerIp || '192.168.0.130';
      const port = settings.printerPort || '7125';
      const baseUrl = `http://${ip}:${port}`;
      const result = await window.api.printer.uploadFile(baseUrl, lastGcodePath);

      if (result && !result.error) {
        if (startPrint) {
          const filename = lastGcodePath.split(/[\\/]/).pop();
          await window.api.printer.apiPost(baseUrl, '/printer/print/start', { filename });
          showStatus('Upload complete! Print started: ' + filename, 'success');
        } else {
          showStatus('Upload complete! File ready on printer.', 'success');
        }
      } else {
        showStatus('Upload failed: ' + (result?.error || 'Unknown error'), 'error');
      }
    } catch (e) {
      showStatus('Upload error: ' + e.message, 'error');
    }
    uploadBtn.disabled = false;
    printBtn.disabled = false;
  }

  return { activate, deactivate };
})();
