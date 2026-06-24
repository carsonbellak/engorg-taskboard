// Printer Control Panel - Moonraker API integration for Creality K1C

const printerController = (() => {
  let pollInterval = null;
  let isActive = false;
  let printerSettings = { ip: '192.168.0.130', port: '7125' };
  let lastState = {};
  let isConnected = false;
  let peerConnection = null;
  let videoRetryTimeout = null;
  let cloudFeedInterval = null;
  let snapshotInterval = null;
  let commandListener = null;
  let userDisconnected = false;  // set when the user explicitly clicks Disconnect — suppresses auto-connect
  let backgroundActive = false;  // camera/cloud bridge running independent of the printer tab being visible
  let lastFileList = [];
  let fileEstimatedTime = 0;   // slicer estimated_time for current file (seconds)
  let fileMetadataFor = null;  // filename last fetched
  const CLOUD_FEED_INTERVAL = 3000; // Upload a frame every 3 seconds

  function getBaseUrl() {
    return `http://${printerSettings.ip}:${printerSettings.port}`;
  }

  async function apiGet(path) {
    return window.api.printer.apiGet(getBaseUrl(), path);
  }

  async function apiPost(path, body) {
    return window.api.printer.apiPost(getBaseUrl(), path, body);
  }

  // Load settings from app data
  async function loadSettings() {
    try {
      const settings = await window.api.loadData('settings.json');
      if (settings && settings.printerIp) {
        printerSettings.ip = settings.printerIp;
      }
      if (settings && settings.printerPort) {
        printerSettings.port = settings.printerPort;
      }
    } catch (e) {
      console.warn('Could not load printer settings:', e);
    }
    // Auto-discover: if the saved IP is unreachable (e.g. the printer got a new DHCP
    // lease), the main process scans the LAN for Moonraker and returns the live URL.
    // The saved URL is passed as a seed, so a working manual setting is never overridden.
    try {
      const resolved = await window.api.printer.resolveUrl(getBaseUrl());
      if (resolved) {
        const u = new URL(resolved);
        if (u.hostname !== printerSettings.ip || String(u.port) !== String(printerSettings.port)) {
          printerSettings.ip = u.hostname;
          printerSettings.port = u.port || '7125';
          await saveSettings();
          console.log('[Printer] adopted discovered Moonraker URL:', resolved);
        }
      }
    } catch (e) {
      console.warn('Printer URL auto-discovery failed:', e);
    }
  }

  async function saveSettings() {
    try {
      let settings = await window.api.loadData('settings.json') || {};
      settings.printerIp = printerSettings.ip;
      settings.printerPort = printerSettings.port;
      await window.api.saveData('settings.json', settings);
    } catch (e) {
      console.warn('Could not save printer settings:', e);
    }
  }

  // Format seconds to HH:MM:SS
  function formatTime(seconds) {
    if (!seconds || seconds <= 0) return '--:--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // Format file size
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Format date
  function formatDate(timestamp) {
    if (!timestamp) return '--';
    const d = new Date(timestamp * 1000);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Render the full printer UI
  function render() {
    const container = document.getElementById('view-printer');
    container.innerHTML = `
      <div class="printer-dashboard">
        <!-- Settings Bar -->
        <div class="printer-settings-bar">
          <div class="printer-settings-row">
            <span class="printer-settings-label">Printer IP:</span>
            <input type="text" id="printer-ip" class="printer-input-sm" value="${printerSettings.ip}" placeholder="192.168.0.130">
            <span class="printer-settings-label">Port:</span>
            <input type="text" id="printer-port" class="printer-input-sm printer-input-port" value="${printerSettings.port}" placeholder="7125">
            <button id="printer-save-settings" class="printer-btn printer-btn-sm">Save</button>
            <button id="printer-test-connection" class="printer-btn printer-btn-sm printer-btn-outline">Test</button>
            <span id="printer-connection-status" class="printer-connection-dot disconnected"></span>
            <span id="printer-connection-text" class="printer-connection-text">Disconnected</span>
          </div>
        </div>

        <!-- Main Layout: Video + Status -->
        <div class="printer-main-grid">
          <!-- Video Feed -->
          <div class="printer-card printer-video-card">
            <div class="printer-card-header">
              <span class="printer-card-title">Camera Feed</span>
              <span id="printer-video-status" class="printer-video-status">Disconnected</span>
              <button id="printer-btn-video" class="printer-btn printer-btn-sm">&#9654; Connect</button>
            </div>
            <div id="printer-video-container" class="printer-video-container">
              <video id="printer-video" autoplay playsinline muted></video>
              <div id="printer-video-overlay" class="printer-video-overlay">
                <div class="printer-video-placeholder">
                  <span>&#127909;</span>
                  <p>Click "Connect" to start camera</p>
                </div>
              </div>
              <button id="printer-btn-fullscreen" class="printer-btn-fullscreen" title="Fullscreen">&#x26F6;</button>
            </div>
          </div>

          <!-- Right Column: Status + Temps -->
          <div class="printer-right-col">

          <!-- Status Card -->
          <div class="printer-card printer-status-card">
            <div class="printer-card-header">
              <span class="printer-card-title">Printer Status</span>
              <span id="printer-state-badge" class="printer-state-badge offline">Offline</span>
            </div>
            <div class="printer-status-body">
              <div class="printer-file-info">
                <div class="printer-file-label">Current File</div>
                <div id="printer-filename" class="printer-file-name">--</div>
              </div>
              <div class="printer-progress-section">
                <div class="printer-progress-header">
                  <span>Progress</span>
                  <span id="printer-progress-pct">0%</span>
                </div>
                <div class="printer-progress-bar-bg">
                  <div id="printer-progress-fill" class="printer-progress-fill" style="width:0%"></div>
                </div>
              </div>
              <div class="printer-time-row">
                <div class="printer-time-item">
                  <div class="printer-time-label">Elapsed</div>
                  <div id="printer-elapsed" class="printer-time-value">--:--:--</div>
                </div>
                <div class="printer-time-item">
                  <div class="printer-time-label">Remaining</div>
                  <div id="printer-remaining" class="printer-time-value">--:--:--</div>
                </div>
                <div class="printer-time-item">
                  <div class="printer-time-label">Filament</div>
                  <div id="printer-filament" class="printer-time-value">--</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Temperature Card -->
          <div class="printer-card printer-temp-card">
            <div class="printer-card-header">
              <span class="printer-card-title">Temperatures</span>
            </div>
            <div class="printer-temp-body">
              <!-- Hotend -->
              <div class="printer-temp-gauge">
                <div class="printer-temp-gauge-header">
                  <span class="printer-temp-icon">&#128293;</span>
                  <span class="printer-temp-name">Hotend</span>
                  <span id="printer-hotend-temp" class="printer-temp-reading">-- / --</span>
                </div>
                <div class="printer-temp-bar-bg">
                  <div id="printer-hotend-bar" class="printer-temp-bar" style="width:0%"></div>
                </div>
              </div>
              <!-- Bed -->
              <div class="printer-temp-gauge">
                <div class="printer-temp-gauge-header">
                  <span class="printer-temp-icon">&#9632;</span>
                  <span class="printer-temp-name">Bed</span>
                  <span id="printer-bed-temp" class="printer-temp-reading">-- / --</span>
                </div>
                <div class="printer-temp-bar-bg">
                  <div id="printer-bed-bar" class="printer-temp-bar" style="width:0%"></div>
                </div>
              </div>
              <!-- Preset Buttons -->
              <div class="printer-temp-presets">
                <button class="printer-btn printer-btn-preset" data-hotend="220" data-bed="55">PLA<br><small>220/55</small></button>
                <button class="printer-btn printer-btn-preset" data-hotend="250" data-bed="70">PETG<br><small>250/70</small></button>
                <button class="printer-btn printer-btn-preset" data-hotend="290" data-bed="100">PC<br><small>290/100</small></button>
                <button class="printer-btn printer-btn-preset printer-btn-cooldown" data-hotend="0" data-bed="0">Cool<br><small>Off</small></button>
              </div>
              <!-- Manual Temp -->
              <div class="printer-temp-manual">
                <div class="printer-temp-manual-row">
                  <label>Hotend:</label>
                  <input type="number" id="printer-hotend-input" class="printer-input-sm" min="0" max="300" placeholder="200">
                  <button id="printer-set-hotend" class="printer-btn printer-btn-sm">Set</button>
                </div>
                <div class="printer-temp-manual-row">
                  <label>Bed:</label>
                  <input type="number" id="printer-bed-input" class="printer-input-sm" min="0" max="120" placeholder="60">
                  <button id="printer-set-bed" class="printer-btn printer-btn-sm">Set</button>
                </div>
              </div>
            </div>
          </div>
          </div><!-- /printer-right-col -->
        </div><!-- /printer-main-grid -->

        <!-- Print Controls -->
        <div class="printer-card printer-controls-card">
          <div class="printer-card-header">
            <span class="printer-card-title">Print Controls</span>
          </div>
          <div class="printer-controls-row">
            <button id="printer-btn-pause" class="printer-btn printer-btn-action" disabled>&#9208; Pause</button>
            <button id="printer-btn-resume" class="printer-btn printer-btn-action printer-btn-success" disabled style="display:none">&#9654; Resume</button>
            <button id="printer-btn-cancel" class="printer-btn printer-btn-action printer-btn-danger" disabled>&#9724; Cancel</button>
            <button id="printer-btn-home" class="printer-btn printer-btn-action">&#127968; Home (G28)</button>
            <button id="printer-btn-estop" class="printer-btn printer-btn-action printer-btn-estop">&#9888; Emergency Stop</button>
          </div>
        </div>

        <!-- Files Section -->
        <div class="printer-card printer-files-card">
          <div class="printer-card-header">
            <span class="printer-card-title">G-code Files</span>
            <button id="printer-btn-upload" class="printer-btn printer-btn-sm">&#8613; Upload</button>
            <button id="printer-btn-refresh-files" class="printer-btn printer-btn-sm printer-btn-outline">&#8635; Refresh</button>
          </div>
          <div id="printer-files-list" class="printer-files-list">
            <div class="printer-files-empty">Connect to printer to view files</div>
          </div>
        </div>

        <!-- Print History -->
        <div class="printer-card printer-history-card">
          <div class="printer-card-header">
            <span class="printer-card-title">Recent Print History</span>
          </div>
          <div id="printer-history-list" class="printer-history-list">
            <div class="printer-files-empty">Connect to printer to view history</div>
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  // Bind all UI events
  function bindEvents() {
    // Settings
    document.getElementById('printer-save-settings').addEventListener('click', async () => {
      printerSettings.ip = document.getElementById('printer-ip').value.trim();
      printerSettings.port = document.getElementById('printer-port').value.trim();
      await saveSettings();
      pollNow();
    });

    document.getElementById('printer-test-connection').addEventListener('click', async () => {
      await testConnection();
    });

    // Temperature presets
    document.querySelectorAll('.printer-btn-preset').forEach(btn => {
      btn.addEventListener('click', async () => {
        const hotend = btn.dataset.hotend;
        const bed = btn.dataset.bed;
        try {
          await apiPost('/printer/gcode/script', { script: `M104 S${hotend}` });
          await apiPost('/printer/gcode/script', { script: `M140 S${bed}` });
        } catch (e) {
          console.error('Failed to set temps:', e);
        }
      });
    });

    // Manual temp set
    document.getElementById('printer-set-hotend').addEventListener('click', async () => {
      const temp = document.getElementById('printer-hotend-input').value;
      if (temp !== '') {
        try { await apiPost('/printer/gcode/script', { script: `M104 S${temp}` }); } catch (e) { console.error(e); }
      }
    });

    document.getElementById('printer-set-bed').addEventListener('click', async () => {
      const temp = document.getElementById('printer-bed-input').value;
      if (temp !== '') {
        try { await apiPost('/printer/gcode/script', { script: `M140 S${temp}` }); } catch (e) { console.error(e); }
      }
    });

    // Print controls
    document.getElementById('printer-btn-pause').addEventListener('click', async () => {
      try { await apiPost('/printer/print/pause'); } catch (e) { console.error(e); }
    });

    document.getElementById('printer-btn-resume').addEventListener('click', async () => {
      try { await apiPost('/printer/print/resume'); } catch (e) { console.error(e); }
    });

    document.getElementById('printer-btn-cancel').addEventListener('click', async () => {
      if (confirm('Are you sure you want to cancel the current print?')) {
        try { await apiPost('/printer/print/cancel'); } catch (e) { console.error(e); }
      }
    });

    document.getElementById('printer-btn-home').addEventListener('click', async () => {
      try { await apiPost('/printer/gcode/script', { script: 'G28' }); } catch (e) { console.error(e); }
    });

    document.getElementById('printer-btn-estop').addEventListener('click', async () => {
      if (confirm('EMERGENCY STOP - This will immediately halt the printer. Continue?')) {
        try { await apiPost('/printer/emergency_stop'); } catch (e) { console.error(e); }
      }
    });

    // File upload
    document.getElementById('printer-btn-upload').addEventListener('click', async () => {
      try {
        const filePath = await window.api.printer.selectFile();
        if (!filePath) return;
        const uploadBtn = document.getElementById('printer-btn-upload');
        uploadBtn.textContent = 'Uploading...';
        uploadBtn.disabled = true;
        await window.api.printer.uploadFile(getBaseUrl(), filePath);
        uploadBtn.textContent = '\u21A5 Upload';
        uploadBtn.disabled = false;
        loadFiles();
      } catch (e) {
        console.error('Upload failed:', e);
        const uploadBtn = document.getElementById('printer-btn-upload');
        uploadBtn.textContent = '\u21A5 Upload';
        uploadBtn.disabled = false;
        alert('Upload failed: ' + e.message);
      }
    });

    // Refresh files
    document.getElementById('printer-btn-refresh-files').addEventListener('click', () => {
      loadFiles();
    });

    // Video feed
    document.getElementById('printer-btn-video').addEventListener('click', () => {
      if (peerConnection && peerConnection.connectionState !== 'closed') {
        stopVideo();
      } else {
        userDisconnected = false;
        startVideo();
      }
    });

    // Fullscreen button
    document.getElementById('printer-btn-fullscreen').addEventListener('click', () => {
      const container = document.getElementById('printer-video-container');
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (container.requestFullscreen) {
        container.requestFullscreen();
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const btn = document.getElementById('printer-btn-fullscreen');
      if (btn) btn.textContent = document.fullscreenElement ? '\u2716' : '\u26F6';
    });
  }

  // === WebRTC Video Feed ===
  async function startVideo() {
    const statusEl = document.getElementById('printer-video-status');
    const btnEl = document.getElementById('printer-btn-video');
    const overlayEl = document.getElementById('printer-video-overlay');
    const videoEl = document.getElementById('printer-video');

    // Video element must exist (it persists in the DOM even when tab is hidden)
    if (!videoEl) return;

    if (statusEl) { statusEl.textContent = 'Connecting...'; statusEl.className = 'printer-video-status connecting'; }
    if (btnEl) { btnEl.textContent = '⏳ Connecting...'; btnEl.disabled = true; }

    try {
      // Clean up any existing connection
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }

      // Create peer connection with STUN (matching printer's own WebRTC page)
      const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
      peerConnection = new RTCPeerConnection(config);

      // Add transceiver — MetaRTC requires sendrecv even though only the printer sends video
      peerConnection.addTransceiver('video', { direction: 'sendrecv' });

      // Handle incoming video track
      peerConnection.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          videoEl.srcObject = event.streams[0];
        } else if (event.track) {
          const stream = new MediaStream([event.track]);
          videoEl.srcObject = stream;
        }
        if (overlayEl) overlayEl.style.display = 'none';
        if (statusEl) { statusEl.textContent = 'Live'; statusEl.className = 'printer-video-status live'; }
        if (btnEl) { btnEl.textContent = '\u23F9 Disconnect'; btnEl.disabled = false; }
        startSnapshotFeed(videoEl);
      };

      // Monitor connection state
      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          // Update UI only if elements exist (printer tab may not be visible)
          if (statusEl) { statusEl.textContent = state === 'failed' ? 'Failed' : 'Disconnected'; statusEl.className = 'printer-video-status disconnected'; }
          if (btnEl) { btnEl.textContent = '\u25B6 Connect'; btnEl.disabled = false; }
          if (overlayEl) overlayEl.style.display = 'flex';
          if (state === 'failed' || state === 'disconnected') {
            // Always auto-retry — keeps camera feed alive for Fluidd/OrcaSlicer even when off-screen
            videoRetryTimeout = setTimeout(() => startVideo(), 5000);
          }
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE state:', peerConnection.iceConnectionState);
      };

      // Create offer
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      // Wait for ICE gathering to complete (fast on LAN with no STUN)
      await new Promise((resolve) => {
        if (peerConnection.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        peerConnection.onicegatheringstatechange = () => {
          if (peerConnection.iceGatheringState === 'complete') resolve();
        };
        setTimeout(resolve, 3000); // Safety timeout
      });

      // Send offer to printer via IPC (POST to port 8000)
      const localSdp = peerConnection.localDescription.sdp;
      const response = await window.api.printer.webrtcOffer(printerSettings.ip, localSdp);

      console.log('WebRTC signaling response:', response.status, response.body.substring(0, 500));

      if (response.status !== 200) {
        throw new Error(`Signaling failed with status ${response.status}: ${response.body}`);
      }

      // The SDP answer comes pre-decoded from main.js (base64 JSON already parsed)
      let sdpAnswer = response.body;

      if (!sdpAnswer || !sdpAnswer.includes('v=0')) {
        throw new Error('Invalid SDP response from printer: ' + (sdpAnswer || '').substring(0, 200));
      }

      // Normalize line endings and strip MetaRTC's malformed ICE candidates
      sdpAnswer = sdpAnswer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = sdpAnswer.split('\n').filter(l => !l.startsWith('a=candidate:'));
      sdpAnswer = lines.join('\r\n');
      if (!sdpAnswer.endsWith('\r\n')) sdpAnswer += '\r\n';

      // Set remote description (SDP answer from printer)
      const answer = new RTCSessionDescription({
        type: 'answer',
        sdp: sdpAnswer
      });
      await peerConnection.setRemoteDescription(answer);

    } catch (e) {
      console.error('WebRTC video failed:', e);
      if (statusEl) { statusEl.textContent = 'Failed'; statusEl.className = 'printer-video-status disconnected'; }
      if (btnEl) { btnEl.textContent = '\u25B6 Connect'; btnEl.disabled = false; }
      if (overlayEl) {
        overlayEl.style.display = 'flex';
        const placeholder = overlayEl.querySelector('.printer-video-placeholder p');
        if (placeholder) placeholder.textContent = 'Connection failed — ' + e.message;
      }
      // Auto-retry even if off-screen — keeps camera feed alive for Fluidd/OrcaSlicer
      videoRetryTimeout = setTimeout(() => startVideo(), 5000);
    }
  }

  // === Snapshot Feed ===
  // Decodes the live WebRTC video to JPEG frames and pushes them to the main process
  // (state.latestCameraFrame), which serves them at /snapshot and /stream. This is the
  // ONLY camera source Fluidd and OrcaSlicer see — the K1C allows just one WebRTC peer,
  // and the desktop owns it, so everything else consumes this MJPEG feed instead.
  function startSnapshotFeed(videoEl) {
    stopSnapshotFeed();
    const canvas = document.createElement('canvas');
    snapshotInterval = setInterval(() => {
      if (videoEl.srcObject && videoEl.videoWidth > 0) {
        const scale = Math.min(1, 640 / videoEl.videoWidth);
        canvas.width = videoEl.videoWidth * scale;
        canvas.height = videoEl.videoHeight * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        window.api.printer.sendCameraFrame(dataUrl);
      }
    }, 100); // ~10fps — matches the /stream push cadence so Fluidd shows smooth video
  }

  function stopSnapshotFeed() {
    if (snapshotInterval) {
      clearInterval(snapshotInterval);
      snapshotInterval = null;
    }
  }

  // Fully disconnect video — only called when user explicitly clicks Disconnect
  function stopVideo() {
    userDisconnected = true; // user opted out — don't auto-reconnect on the next poll
    stopSnapshotFeed();
    if (videoRetryTimeout) {
      clearTimeout(videoRetryTimeout);
      videoRetryTimeout = null;
    }
    if (peerConnection) {
      // Remove state change handler so it doesn't trigger auto-retry
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
      peerConnection = null;
    }
    const videoEl = document.getElementById('printer-video');
    const overlayEl = document.getElementById('printer-video-overlay');
    const statusEl = document.getElementById('printer-video-status');
    const btnEl = document.getElementById('printer-btn-video');
    if (videoEl) videoEl.srcObject = null;
    if (overlayEl) {
      overlayEl.style.display = 'flex';
      const placeholder = overlayEl.querySelector('.printer-video-placeholder p');
      if (placeholder) placeholder.textContent = 'Click "Connect" to start camera';
    }
    if (statusEl) { statusEl.textContent = 'Disconnected'; statusEl.className = 'printer-video-status disconnected'; }
    if (btnEl) { btnEl.textContent = '\u25B6 Connect'; btnEl.disabled = false; }
  }

  // Sync the video UI to the current connection state (when returning to the printer tab)
  function refreshVideoUI() {
    const statusEl = document.getElementById('printer-video-status');
    const btnEl = document.getElementById('printer-btn-video');
    const overlayEl = document.getElementById('printer-video-overlay');
    if (!statusEl) return;
    if (peerConnection && (peerConnection.connectionState === 'connected' || peerConnection.connectionState === 'connecting')) {
      overlayEl.style.display = 'none';
      statusEl.textContent = peerConnection.connectionState === 'connected' ? 'Live' : 'Connecting...';
      statusEl.className = 'printer-video-status ' + (peerConnection.connectionState === 'connected' ? 'live' : 'connecting');
      btnEl.textContent = peerConnection.connectionState === 'connected' ? '\u23F9 Disconnect' : '⏳ Connecting...';
      btnEl.disabled = peerConnection.connectionState !== 'connected';
    }
  }

  // Auto-connect the camera whenever the printer is reachable, so the cloud feed
  // always has video for the PWA — even when the printer tab isn't open. Skipped
  // only if the user explicitly disconnected, or a connection is already up/pending.
  function maybeAutoStartVideo() {
    if (userDisconnected) return;
    if (videoRetryTimeout) return; // a reconnect is already scheduled
    if (peerConnection) {
      const s = peerConnection.connectionState;
      if (s === 'new' || s === 'connecting' || s === 'connected') return;
    }
    startVideo();
  }

  // Test connection
  async function testConnection() {
    const statusDot = document.getElementById('printer-connection-status');
    const statusText = document.getElementById('printer-connection-text');
    statusText.textContent = 'Testing...';
    statusDot.className = 'printer-connection-dot testing';
    try {
      const info = await apiGet('/printer/info');
      if (info && info.result) {
        isConnected = true;
        statusDot.className = 'printer-connection-dot connected';
        statusText.textContent = 'Connected - ' + (info.result.hostname || 'Printer');
        maybeAutoStartVideo();
        loadFiles();
        loadHistory();
      } else {
        throw new Error('Invalid response');
      }
    } catch (e) {
      isConnected = false;
      statusDot.className = 'printer-connection-dot disconnected';
      statusText.textContent = 'Cannot connect';
    }
  }

  // Poll printer status
  async function pollStatus() {
    if (!isActive) return;
    try {
      const res = await apiGet('/printer/objects/query?heater_bed&extruder&print_stats&virtual_sdcard&display_status');
      if (res && res.result && res.result.status) {
        isConnected = true;
        updateStatusUI(res.result.status);
        maybeAutoStartVideo();
        // Update connection indicator
        const dot = document.getElementById('printer-connection-status');
        const txt = document.getElementById('printer-connection-text');
        if (dot) {
          dot.className = 'printer-connection-dot connected';
          txt.textContent = 'Connected';
        }
      }
    } catch (e) {
      isConnected = false;
      showOffline();
    }
  }

  // Update all status UI elements
  function updateStatusUI(status) {
    const extruder = status.extruder || {};
    const bed = status.heater_bed || {};
    const printStats = status.print_stats || {};
    const sdcard = status.virtual_sdcard || {};
    const display = status.display_status || {};

    // State badge
    const state = printStats.state || 'standby';
    const badge = document.getElementById('printer-state-badge');
    if (badge) {
      const stateLabels = { standby: 'Ready', printing: 'Printing', paused: 'Paused', complete: 'Complete', cancelled: 'Cancelled', error: 'Error' };
      badge.textContent = stateLabels[state] || state;
      badge.className = 'printer-state-badge ' + state;
    }

    // Temperatures
    const hotendCurrent = extruder.temperature != null ? extruder.temperature.toFixed(1) : '--';
    const hotendTarget = extruder.target != null ? extruder.target.toFixed(0) : '--';
    const bedCurrent = bed.temperature != null ? bed.temperature.toFixed(1) : '--';
    const bedTarget = bed.target != null ? bed.target.toFixed(0) : '--';

    const hotendEl = document.getElementById('printer-hotend-temp');
    if (hotendEl) hotendEl.textContent = `${hotendCurrent}\u00B0C / ${hotendTarget}\u00B0C`;
    const bedEl = document.getElementById('printer-bed-temp');
    if (bedEl) bedEl.textContent = `${bedCurrent}\u00B0C / ${bedTarget}\u00B0C`;

    // Temperature bars (max 300 for hotend, 120 for bed)
    const hotendPct = extruder.temperature ? Math.min((extruder.temperature / 300) * 100, 100) : 0;
    const bedPct = bed.temperature ? Math.min((bed.temperature / 120) * 100, 100) : 0;
    const hotendBar = document.getElementById('printer-hotend-bar');
    const bedBar = document.getElementById('printer-bed-bar');
    if (hotendBar) {
      hotendBar.style.width = hotendPct + '%';
      hotendBar.className = 'printer-temp-bar ' + getTempColorClass(extruder.temperature, extruder.target);
    }
    if (bedBar) {
      bedBar.style.width = bedPct + '%';
      bedBar.className = 'printer-temp-bar ' + getTempColorClass(bed.temperature, bed.target);
    }

    // Progress
    const progress = sdcard.progress != null ? (sdcard.progress * 100) : 0;
    const progressFill = document.getElementById('printer-progress-fill');
    const progressPct = document.getElementById('printer-progress-pct');
    if (progressFill) progressFill.style.width = progress.toFixed(1) + '%';
    if (progressPct) progressPct.textContent = progress.toFixed(1) + '%';

    // File name
    const fnEl = document.getElementById('printer-filename');
    if (fnEl) fnEl.textContent = printStats.filename || '--';

    // Fetch file metadata (estimated_time) when filename changes
    const filename = printStats.filename || '';
    if (filename && filename !== fileMetadataFor) {
      fileMetadataFor = filename;
      fileEstimatedTime = 0;
      apiGet(`/server/files/metadata?filename=${encodeURIComponent(filename)}`)
        .then(r => { if (r && r.result && r.result.estimated_time) fileEstimatedTime = r.result.estimated_time; })
        .catch(() => {});
    }
    if (!filename) { fileMetadataFor = null; fileEstimatedTime = 0; }

    // Time
    const elapsed = printStats.print_duration || 0;
    const elapsedEl = document.getElementById('printer-elapsed');
    if (elapsedEl) elapsedEl.textContent = formatTime(elapsed);

    // Remaining: use file's slicer estimated_time if available
    const remainingEl = document.getElementById('printer-remaining');
    if (remainingEl) {
      if (state === 'printing' || state === 'paused') {
        if (fileEstimatedTime > 0) {
          const remaining = Math.max(0, fileEstimatedTime * (1 - progress / 100));
          remainingEl.textContent = formatTime(remaining);
        } else if (progress > 1 && elapsed > 0) {
          const remaining = elapsed / (progress / 100) - elapsed;
          remainingEl.textContent = formatTime(remaining);
        } else {
          remainingEl.textContent = '--:--:--';
        }
      } else {
        remainingEl.textContent = '--:--:--';
      }
    }

    // Filament used
    const filamentEl = document.getElementById('printer-filament');
    if (filamentEl) {
      const filament = printStats.filament_used || 0;
      if (filament > 0) {
        filamentEl.textContent = (filament / 1000).toFixed(2) + ' m';
      } else {
        filamentEl.textContent = '--';
      }
    }

    // Update print control buttons
    const pauseBtn = document.getElementById('printer-btn-pause');
    const resumeBtn = document.getElementById('printer-btn-resume');
    const cancelBtn = document.getElementById('printer-btn-cancel');
    if (pauseBtn && resumeBtn && cancelBtn) {
      if (state === 'printing') {
        pauseBtn.style.display = '';
        pauseBtn.disabled = false;
        resumeBtn.style.display = 'none';
        cancelBtn.disabled = false;
      } else if (state === 'paused') {
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = '';
        resumeBtn.disabled = false;
        cancelBtn.disabled = false;
      } else {
        pauseBtn.style.display = '';
        pauseBtn.disabled = true;
        resumeBtn.style.display = 'none';
        cancelBtn.disabled = true;
      }
    }

    lastState = status;
  }

  function getTempColorClass(current, target) {
    if (!target || target === 0) {
      if (current > 50) return 'temp-cooling';
      return 'temp-cold';
    }
    if (Math.abs(current - target) <= 2) return 'temp-ready';
    if (current < target) return 'temp-heating';
    return 'temp-ready';
  }

  function showOffline() {
    const badge = document.getElementById('printer-state-badge');
    if (badge) {
      badge.textContent = 'Offline';
      badge.className = 'printer-state-badge offline';
    }
    const dot = document.getElementById('printer-connection-status');
    const txt = document.getElementById('printer-connection-text');
    if (dot) {
      dot.className = 'printer-connection-dot disconnected';
      txt.textContent = 'Disconnected';
    }
  }

  // Load file list
  async function loadFiles() {
    try {
      const res = await apiGet('/server/files/list?root=gcodes');
      const listEl = document.getElementById('printer-files-list');
      if (!listEl) return;
      if (res && res.result && res.result.length > 0) {
        // Sort by modified date descending
        const files = res.result.sort((a, b) => (b.modified || 0) - (a.modified || 0));
        lastFileList = files;
        listEl.innerHTML = files.map(f => `
          <div class="printer-file-row" data-filename="${escapeAttr(f.path || f.filename)}">
            <div class="printer-file-row-name">${escapeHtml(f.path || f.filename)}</div>
            <div class="printer-file-row-meta">
              <span>${formatSize(f.size || 0)}</span>
              <span>${formatDate(f.modified)}</span>
            </div>
            <button class="printer-btn printer-btn-sm printer-btn-print" data-filename="${escapeAttr(f.path || f.filename)}">&#9654; Print</button>
          </div>
        `).join('');

        // Bind print buttons
        listEl.querySelectorAll('.printer-btn-print').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const filename = btn.dataset.filename;
            if (confirm(`Start printing "${filename}"?`)) {
              try {
                await apiPost('/printer/print/start', { filename });
              } catch (err) {
                alert('Failed to start print: ' + err.message);
              }
            }
          });
        });
      } else {
        listEl.innerHTML = '<div class="printer-files-empty">No G-code files found</div>';
      }
    } catch (e) {
      const listEl = document.getElementById('printer-files-list');
      if (listEl) listEl.innerHTML = '<div class="printer-files-empty">Could not load files</div>';
    }
  }

  // Load print history
  async function loadHistory() {
    try {
      const res = await apiGet('/server/history/list?limit=10');
      const listEl = document.getElementById('printer-history-list');
      if (!listEl) return;
      if (res && res.result && res.result.jobs && res.result.jobs.length > 0) {
        listEl.innerHTML = res.result.jobs.map(j => {
          const statusClass = j.status === 'completed' ? 'history-complete' : (j.status === 'cancelled' ? 'history-cancelled' : 'history-error');
          return `
            <div class="printer-history-row ${statusClass}">
              <div class="printer-history-name">${escapeHtml(j.filename || 'Unknown')}</div>
              <div class="printer-history-meta">
                <span class="printer-history-status">${j.status || '--'}</span>
                <span>${formatTime(j.total_duration || 0)}</span>
                <span>${j.filament_used ? (j.filament_used / 1000).toFixed(2) + ' m' : '--'}</span>
              </div>
            </div>
          `;
        }).join('');
      } else {
        listEl.innerHTML = '<div class="printer-files-empty">No print history</div>';
      }
    } catch (e) {
      const listEl = document.getElementById('printer-history-list');
      if (listEl) listEl.innerHTML = '<div class="printer-files-empty">Could not load history</div>';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function pollNow() {
    await pollStatus();
    loadFiles();
    loadHistory();
  }

  // ===================== CLOUD FEED =====================
  // Captures video frames + printer status and uploads to Firestore
  // so the PWA can display a near-live printer feed remotely

  function startCloudFeed() {
    if (cloudFeedInterval) return;
    cloudFeedInterval = setInterval(uploadCloudFrame, CLOUD_FEED_INTERVAL);
    startCommandListener();
    console.log('Cloud feed started');
  }

  function stopCloudFeed() {
    if (cloudFeedInterval) {
      clearInterval(cloudFeedInterval);
      cloudFeedInterval = null;
    }
    if (commandListener) {
      commandListener();
      commandListener = null;
    }
  }

  // Listen for remote commands from PWA
  function startCommandListener() {
    if (commandListener) return;
    if (typeof firebase === 'undefined' || !firebase.auth().currentUser) return;

    const uid = firebase.auth().currentUser.uid;
    const cmdRef = firebase.firestore()
      .collection('users').doc(uid)
      .collection('data').doc('printerCommand');

    commandListener = cmdRef.onSnapshot(async (snap) => {
      if (!snap.exists) return;
      const cmd = snap.data();
      if (!cmd || cmd.status !== 'pending') return;

      console.log('Remote command received:', cmd.action, cmd.params);

      // Mark as executing
      await cmdRef.update({ status: 'executing' });

      try {
        let result = '';
        switch (cmd.action) {
          case 'pause':
            await apiPost('/printer/print/pause', {});
            result = 'Print paused';
            break;
          case 'resume':
            await apiPost('/printer/print/resume', {});
            result = 'Print resumed';
            break;
          case 'cancel':
            await apiPost('/printer/print/cancel', {});
            result = 'Print cancelled';
            break;
          case 'print':
            if (cmd.params && cmd.params.filename) {
              await apiPost('/printer/print/start', { filename: cmd.params.filename });
              result = 'Print started: ' + cmd.params.filename;
            } else {
              throw new Error('No filename specified');
            }
            break;
          case 'setTemp':
            if (cmd.params) {
              const gcode = cmd.params.heater === 'bed'
                ? `M140 S${cmd.params.target}`
                : `M104 S${cmd.params.target}`;
              await apiPost('/printer/gcode/script', { script: gcode });
              result = `${cmd.params.heater} target set to ${cmd.params.target}°C`;
            }
            break;
          case 'uploadFile': {
            // File was chunked into Firestore — reassemble and upload to printer
            if (cmd.params && cmd.params.filename && cmd.params.totalChunks) {
              const uid = firebase.auth().currentUser.uid;
              const chunksRef = firebase.firestore()
                .collection('users').doc(uid)
                .collection('data').doc('printerCommand')
                .collection('chunks');

              // Read all chunks in order
              const chunksSnap = await chunksRef.orderBy('index').get();
              let base64 = '';
              chunksSnap.forEach(doc => { base64 += doc.data().data; });

              // Decode base64 to binary string, send via IPC for upload
              await window.api.printer.uploadFileData(getBaseUrl(), cmd.params.filename, base64);

              // Clean up chunks
              const batch = firebase.firestore().batch();
              chunksSnap.forEach(doc => batch.delete(doc.ref));
              await batch.commit();

              result = 'File uploaded: ' + cmd.params.filename;
              loadFiles();
            }
            break;
          }
          default:
            throw new Error('Unknown command: ' + cmd.action);
        }

        await cmdRef.update({
          status: 'done',
          result: result,
          _completedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Trigger immediate status refresh
        pollStatus();

      } catch (e) {
        console.error('Remote command failed:', e);
        await cmdRef.update({
          status: 'error',
          result: e.message,
          _completedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    });
  }

  async function uploadCloudFrame() {
    // Only upload if Firebase is available and user is signed in
    if (typeof firebase === 'undefined' || !firebase.auth().currentUser) return;

    // Retry command listener setup if auth wasn't ready when cloud feed started
    if (!commandListener) startCommandListener();

    const videoEl = document.getElementById('printer-video');
    let frameData = null;

    // Capture frame from video if playing
    if (videoEl && videoEl.srcObject && videoEl.videoWidth > 0) {
      try {
        const canvas = document.createElement('canvas');
        // Scale down for bandwidth (max 640px wide)
        const scale = Math.min(1, 640 / videoEl.videoWidth);
        canvas.width = videoEl.videoWidth * scale;
        canvas.height = videoEl.videoHeight * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        // JPEG at 50% quality — keeps frames ~20-40KB
        frameData = canvas.toDataURL('image/jpeg', 0.5);
      } catch (e) {
        console.warn('Frame capture failed:', e);
      }
    }

    // Build status payload from lastState
    const extruder = lastState.extruder || {};
    const bed = lastState.heater_bed || {};
    const printStats = lastState.print_stats || {};
    const sdcard = lastState.virtual_sdcard || {};

    const printerStatus = {
      connected: isConnected,
      state: printStats.state || 'standby',
      hotendTemp: extruder.temperature || 0,
      hotendTarget: extruder.target || 0,
      bedTemp: bed.temperature || 0,
      bedTarget: bed.target || 0,
      progress: sdcard.progress ? (sdcard.progress * 100) : 0,
      filename: printStats.filename || '',
      elapsed: printStats.print_duration || 0,
      filamentUsed: printStats.filament_used || 0,
    };

    // Upload to Firestore
    try {
      const uid = firebase.auth().currentUser.uid;
      const doc = firebase.firestore()
        .collection('users').doc(uid)
        .collection('data').doc('printerFeed');

      const payload = {
        status: printerStatus,
        videoLive: !!frameData,
        files: lastFileList.slice(0, 50).map(f => ({
          name: f.path || f.filename,
          size: f.size || 0,
          modified: f.modified || 0
        })),
        _updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        _source: 'desktop'
      };

      // Only include frame if we have one (keeps doc small when no video)
      if (frameData) {
        payload.frame = frameData;
      }

      await doc.set(payload);
    } catch (e) {
      console.warn('Cloud feed upload failed:', e);
    }
  }

  // Public API
  return {
    async init() {
      await loadSettings();
      render();
      this.startPolling();
    },
    // Always-on bridge: keep status polling, the cloud feed and the camera running
    // in the background (independent of the printer tab) so the PWA always receives
    // video whenever the printer is reachable. Safe to call once at app startup.
    async startBackground() {
      if (backgroundActive) return;
      backgroundActive = true;
      userDisconnected = false; // enabling the bridge always re-arms auto-connect
      await loadSettings();
      // Render the (hidden) printer view so the <video> element exists for capture
      if (!document.querySelector('#view-printer .printer-dashboard')) render();
      this.startPolling();
    },
    stopBackground() {
      backgroundActive = false;
      this.stopPolling();
      stopVideo();
    },
    startPolling() {
      isActive = true;
      pollNow();
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(() => {
        if (isActive) pollStatus();
      }, 2000);
      startCloudFeed();
      // Sync video UI to reflect background connection state
      refreshVideoUI();
    },
    stopPolling() {
      // When the background bridge is running, leaving the printer tab must NOT
      // stop status polling, the cloud feed, or the camera — the PWA depends on them.
      if (backgroundActive) {
        refreshVideoUI();
        return;
      }
      isActive = false;
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      // Keep WebRTC camera + snapshot feed alive so Fluidd/OrcaSlicer can still access /snapshot and /stream
      // stopVideo() is only called when the user explicitly clicks disconnect
      stopCloudFeed();
    }
  };
})();
