// Timers View — Desktop

let _timerCountdownInterval = null;
const _CIRC = 2 * Math.PI * 54; // SVG ring circumference (r=54)
const _notifiedTimers = new Set(); // ids we've already alerted for (avoid repeat)

// Fire a desktop notification + audible beeps when a timer reaches zero.
function _onTimerExpired(label) {
  try {
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') new Notification('⏱ Timer finished', { body: label });
      else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => { if (p === 'granted') new Notification('⏱ Timer finished', { body: label }); });
      }
    }
  } catch {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    osc.connect(gain); gain.connect(ctx.destination);
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    for (let i = 0; i < 3; i++) { // three short beeps
      const s = t0 + i * 0.32;
      gain.gain.setValueAtTime(0.2, s);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.25);
    }
    osc.start(t0); osc.stop(t0 + 1.0);
    osc.onended = () => { try { ctx.close(); } catch {} };
  } catch {}
}

function renderTimers() {
  const container = document.getElementById('view-timers');
  if (!container) return;

  const timers = window._timers || { active: [], recent: [] };

  let html = '<div class="timers-view">';

  // ── Create form ──────────────────────────────────────────────
  html += `<div class="timers-create-panel">
    <div class="timers-create-header">
      <span class="timers-create-title">&#9201; New Timer</span>
      <span class="timers-create-sub">Set a duration and hit start</span>
    </div>
    <div class="timers-create-top">
      <div class="timers-create-inputs">
        <div class="timers-digit-group">
          <input type="number" id="dt-hours"   class="timers-digit" placeholder="00" min="0" max="23">
          <span class="timers-digit-label">h</span>
        </div>
        <span class="timers-digit-sep">:</span>
        <div class="timers-digit-group">
          <input type="number" id="dt-minutes" class="timers-digit" placeholder="00" min="0" max="59">
          <span class="timers-digit-label">m</span>
        </div>
        <span class="timers-digit-sep">:</span>
        <div class="timers-digit-group">
          <input type="number" id="dt-seconds" class="timers-digit" placeholder="00" min="0" max="59">
          <span class="timers-digit-label">s</span>
        </div>
      </div>
      <input type="text" id="dt-label" class="timers-label-input" placeholder="Timer label (optional)" maxlength="100">
      <button class="timers-start-btn" id="dt-start-btn">&#9654; Start</button>
    </div>
    <div class="timers-presets">
      ${[1,5,10,15,30].map(m => `<button class="timer-preset" data-m="${m}">${m}m</button>`).join('')}
      ${[1,2,4].map(h => `<button class="timer-preset" data-h="${h}">${h}h</button>`).join('')}
    </div>
  </div>`;

  // ── Active timers grid ───────────────────────────────────────
  if (timers.active.length > 0) {
    html += '<div class="timers-section-label">Active</div><div class="timers-grid">';
    for (const t of timers.active) {
      const secsLeft  = t.expiresAt ? Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000)) : 0;
      const expiresMs = t.expiresAt ? t.expiresAt.getTime() : 0;
      const progress  = t.durationSeconds > 0 ? secsLeft / t.durationSeconds : 0;
      const offset    = (_CIRC * (1 - progress)).toFixed(1);
      const ringCls   = progress > 0.5 ? 'ring-ok' : progress > 0.2 ? 'ring-warn' : 'ring-urgent';

      html += `<div class="timer-card timer-card-active" data-id="${t.id}">
        <button class="timer-cancel-btn" data-id="${t.id}" title="Cancel">&#10005;</button>
        <div class="timer-ring-wrap">
          <svg class="timer-ring-svg" viewBox="0 0 120 120">
            <circle class="timer-ring-bg" cx="60" cy="60" r="54"/>
            <circle class="timer-ring-fg ${ringCls}"
              cx="60" cy="60" r="54"
              transform="rotate(-90 60 60)"
              stroke-dasharray="${_CIRC.toFixed(1)}"
              stroke-dashoffset="${offset}"
              data-expires="${expiresMs}"
              data-duration="${t.durationSeconds}"/>
          </svg>
          <div class="timer-ring-inner">
            <div class="timer-card-countdown" data-expires="${expiresMs}">${fmtCountdown(secsLeft)}</div>
            <div class="timer-ring-total">${fmtDur(t.durationSeconds)}</div>
          </div>
        </div>
        <div class="timer-card-label">${escapeHtml(t.label || 'Timer')}</div>
      </div>`;
    }
    html += '</div>';
  }

  // ── Recent timers list ───────────────────────────────────────
  if (timers.recent.length > 0) {
    html += '<div class="timers-section-label">Recent</div><div class="timers-list">';
    for (const t of timers.recent) {
      const badge = { expired: 'Done', dismissed: 'Dismissed', cancelled: 'Cancelled' }[t.status] || t.status;
      html += `<div class="timer-card timer-recent-card timer-card-${t.status}">
        <div class="timer-recent-icon">&#9201;</div>
        <div class="timer-card-body">
          <div class="timer-card-label">${escapeHtml(t.label || 'Timer')}</div>
          <div class="timer-recent-dur">${fmtDur(t.durationSeconds)}</div>
        </div>
        <span class="timer-status-badge timer-badge-${t.status}">${badge}</span>
      </div>`;
    }
    html += '</div>';
  }

  if (timers.active.length === 0 && timers.recent.length === 0) {
    html += `<div class="timers-empty">
      <div class="timers-empty-icon">&#9201;</div>
      <div class="timers-empty-text">No timers yet.<br>Set a duration above and hit Start.</div>
    </div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  _bindTimerEvents();
  _startCountdown();
}

function _bindTimerEvents() {
  document.querySelectorAll('#view-timers .timer-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('dt-hours').value   = btn.dataset.h || 0;
      document.getElementById('dt-minutes').value = btn.dataset.m || 0;
      document.getElementById('dt-seconds').value = 0;
    });
  });

  document.getElementById('dt-start-btn')?.addEventListener('click', async () => {
    const label = document.getElementById('dt-label').value.trim() || 'Timer';
    const h = parseInt(document.getElementById('dt-hours').value)   || 0;
    const m = parseInt(document.getElementById('dt-minutes').value) || 0;
    const s = parseInt(document.getElementById('dt-seconds').value) || 0;
    const totalSeconds = h * 3600 + m * 60 + s;

    if (totalSeconds < 5) { alert('Please set a duration of at least 5 seconds.'); return; }

    const btn = document.getElementById('dt-start-btn');
    btn.disabled = true; btn.textContent = 'Starting…';

    try {
      await _createTimer(label, totalSeconds);
      document.getElementById('dt-label').value   = '';
      document.getElementById('dt-hours').value   = '';
      document.getElementById('dt-minutes').value = '';
      document.getElementById('dt-seconds').value = '';
    } catch (err) {
      alert('Could not start timer: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '&#9654; Start';
    }
  });

  document.querySelectorAll('#view-timers .timer-cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await firebaseSync.db.doc(`timers/${btn.dataset.id}`).update({ status: 'cancelled' });
      } catch (err) {
        btn.disabled = false;
      }
    });
  });
}

async function _createTimer(label, durationSeconds) {
  const user = firebaseSync.user;
  if (!user) throw new Error('Not signed in to cloud sync.');

  const now      = new Date();
  const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
  const timerId  = `timer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Optimistic local add: show the timer & start its countdown immediately,
  // without waiting for the Firestore listener to round-trip (and so it still
  // works if cloud sync is briefly unavailable). The listener reconciles later.
  window._timers = window._timers || { active: [], recent: [] };
  window._timers.active = [...window._timers.active, {
    id: timerId, label, durationSeconds, status: 'active', expiresAt, startedAt: now,
  }].sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0));
  window.dispatchEvent(new CustomEvent('timers-changed'));

  try {
    await firebaseSync.db.doc(`timers/${timerId}`).set({
      uid: user.uid,
      label,
      durationSeconds,
      startedAt:        firebase.firestore.Timestamp.fromDate(now),
      expiresAt:        firebase.firestore.Timestamp.fromDate(expiresAt),
      status:           'active',
      notificationSent: false,
      createdAt:        now.toISOString(),
      createdVia:       'desktop'
    });
  } catch (err) {
    // Roll back the optimistic entry only if the write genuinely failed.
    window._timers.active = window._timers.active.filter(t => t.id !== timerId);
    window.dispatchEvent(new CustomEvent('timers-changed'));
    throw err;
  }
}

function _startCountdown() {
  if (_timerCountdownInterval) clearInterval(_timerCountdownInterval);
  _timerCountdownInterval = setInterval(() => {
    const now = Date.now();

    document.querySelectorAll('#view-timers .timer-card-countdown[data-expires]').forEach(el => {
      const secsLeft = Math.max(0, Math.round((parseInt(el.dataset.expires) - now) / 1000));
      el.textContent = fmtCountdown(secsLeft);
      if (secsLeft === 0) {
        const card = el.closest('.timer-card');
        card?.classList.add('timer-card-expired');
        const id = card?.dataset.id;
        if (id && !_notifiedTimers.has(id)) {
          _notifiedTimers.add(id);
          _onTimerExpired(card?.querySelector('.timer-card-label')?.textContent || 'Timer');
        }
      }
    });

    document.querySelectorAll('#view-timers .timer-ring-fg[data-expires]').forEach(ring => {
      const secsLeft = Math.max(0, Math.round((parseInt(ring.dataset.expires) - now) / 1000));
      const duration = parseInt(ring.dataset.duration);
      const progress = duration > 0 ? secsLeft / duration : 0;
      ring.setAttribute('stroke-dashoffset', (_CIRC * (1 - progress)).toFixed(1));
      ring.classList.remove('ring-ok', 'ring-warn', 'ring-urgent');
      ring.classList.add(progress > 0.5 ? 'ring-ok' : progress > 0.2 ? 'ring-warn' : 'ring-urgent');
    });
  }, 1000);
}

function stopTimerCountdown() {
  if (_timerCountdownInterval) { clearInterval(_timerCountdownInterval); _timerCountdownInterval = null; }
}

// Always-on watcher: fires the expiry alert even when the Timers tab isn't open
// (the DOM countdown above only runs while the view is rendered).
let _globalTimerWatch = null;
function _ensureGlobalTimerWatch() {
  if (_globalTimerWatch) return;
  _globalTimerWatch = setInterval(() => {
    const active = (window._timers && window._timers.active) || [];
    const now = Date.now();
    for (const t of active) {
      const expMs = t.expiresAt ? (t.expiresAt.getTime ? t.expiresAt.getTime() : +new Date(t.expiresAt)) : 0;
      if (expMs && expMs <= now && t.id && !_notifiedTimers.has(t.id)) {
        _notifiedTimers.add(t.id);
        _onTimerExpired(t.label || 'Timer');
      }
    }
  }, 1000);
}
_ensureGlobalTimerWatch();

function fmtCountdown(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function fmtDur(seconds) {
  if (!seconds) return '';
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}
