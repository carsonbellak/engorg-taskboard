// Timers View — Desktop
// A small "clock" utility with three modes: countdown Timers, scheduled
// Alarms (one-shot or repeating on days of the week), and a Stopwatch.

let _timerCountdownInterval = null;
const _CIRC = 2 * Math.PI * 54; // SVG ring circumference (r=54)
const _notifiedTimers = new Set(); // ids we've already alerted for (avoid repeat)

let _timerTab = 'timers';          // 'timers' | 'alarms' | 'stopwatch'
let _editingAlarmId = null;        // when set, the create panel is in "edit" mode
let _alarmDayDraft = [];           // selected weekday pills while building/editing an alarm

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// ── Sounds ─────────────────────────────────────────────────────
function _beepSequence(freq, count, gap, dur, vol) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    osc.connect(gain); gain.connect(ctx.destination);
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    for (let i = 0; i < count; i++) {
      const s = t0 + i * gap;
      gain.gain.setValueAtTime(vol, s);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + dur);
    }
    osc.start(t0); osc.stop(t0 + count * gap + 0.1);
    osc.onended = () => { try { ctx.close(); } catch {} };
  } catch {}
}

function _notify(title, body) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') new Notification(title, { body });
    else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
    }
  } catch {}
}

// Fire a desktop notification + audible beeps when a timer reaches zero.
function _onTimerExpired(label) {
  _notify('⏱ Timer finished', label);
  _beepSequence(880, 3, 0.32, 0.25, 0.2);
}

// Alarms get a longer, more insistent tone so they stand out from timers.
function _onAlarmFired(alarm) {
  _notify('⏰ Alarm', alarm.label || 'Alarm');
  _beepSequence(740, 6, 0.45, 0.34, 0.25);
}

// ── Render ─────────────────────────────────────────────────────
function renderTimers() {
  const container = document.getElementById('view-timers');
  if (!container) return;

  let html = '<div class="timers-view">';

  // Mode switcher
  html += `<div class="timers-tabs">
    ${[['timers', '⏱ Timers'], ['alarms', '⏰ Alarms'], ['stopwatch', '⏲ Stopwatch']]
      .map(([id, label]) => `<button class="timers-tab-btn ${_timerTab === id ? 'active' : ''}" data-ttab="${id}">${label}</button>`)
      .join('')}
  </div>`;

  if (_timerTab === 'timers')          html += _renderTimersPane();
  else if (_timerTab === 'alarms')     html += _renderAlarmsPane();
  else if (_timerTab === 'stopwatch')  html += _renderStopwatchPane();

  html += '</div>';
  container.innerHTML = html;

  if (_timerTab === 'timers')         { _bindTimerEvents(); _startCountdown(); }
  else if (_timerTab === 'alarms')    { _bindAlarmEvents(); stopTimerCountdown(); }
  else if (_timerTab === 'stopwatch') { _bindStopwatchEvents(); stopTimerCountdown(); _swTick(); }

  document.querySelectorAll('#view-timers .timers-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { _timerTab = btn.dataset.ttab; renderTimers(); });
  });
}

// ── Timers pane ────────────────────────────────────────────────
function _renderTimersPane() {
  const timers = window._timers || { active: [], recent: [] };
  let html = '';

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
      <label class="timer-repeat-toggle" title="Auto-restart this timer when it finishes">
        <input type="checkbox" id="dt-repeat"> &#128257; Repeat
      </label>
    </div>
  </div>`;

  if (timers.active.length > 0) {
    html += '<div class="timers-section-label">Active</div><div class="timers-grid">';
    for (const t of timers.active) {
      const secsLeft  = t.expiresAt ? Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000)) : 0;
      const expiresMs = t.expiresAt ? t.expiresAt.getTime() : 0;
      const progress  = t.durationSeconds > 0 ? secsLeft / t.durationSeconds : 0;
      const offset    = (_CIRC * (1 - progress)).toFixed(1);
      const ringCls   = progress > 0.5 ? 'ring-ok' : progress > 0.2 ? 'ring-warn' : 'ring-urgent';

      html += `<div class="timer-card timer-card-active" data-id="${t.id}">
        ${t.repeat ? '<span class="timer-repeat-badge" title="Repeats">&#128257;</span>' : ''}
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
  } else {
    html += `<div class="timers-empty">
      <div class="timers-empty-icon">&#9201;</div>
      <div class="timers-empty-text">No active timers.<br>Set a duration above and hit Start.</div>
    </div>`;
  }

  return html;
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
    const repeat = document.getElementById('dt-repeat')?.checked || false;
    const totalSeconds = h * 3600 + m * 60 + s;

    if (totalSeconds < 5) { alert('Please set a duration of at least 5 seconds.'); return; }

    const btn = document.getElementById('dt-start-btn');
    btn.disabled = true; btn.textContent = 'Starting…';

    try {
      await _createTimer(label, totalSeconds, { repeat });
      document.getElementById('dt-label').value   = '';
      document.getElementById('dt-hours').value   = '';
      document.getElementById('dt-minutes').value = '';
      document.getElementById('dt-seconds').value = '';
      document.getElementById('dt-repeat').checked = false;
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

async function _createTimer(label, durationSeconds, opts = {}) {
  const user = firebaseSync.user;
  if (!user) throw new Error('Not signed in to cloud sync.');

  const repeat   = !!opts.repeat;
  const now      = new Date();
  const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
  const timerId  = `timer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Optimistic local add: show the timer & start its countdown immediately,
  // without waiting for the Firestore listener to round-trip (and so it still
  // works if cloud sync is briefly unavailable). The listener reconciles later.
  window._timers = window._timers || { active: [], recent: [] };
  window._timers.active = [...window._timers.active, {
    id: timerId, label, durationSeconds, status: 'active', expiresAt, startedAt: now, repeat,
  }].sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0));
  window.dispatchEvent(new CustomEvent('timers-changed'));

  try {
    await firebaseSync.db.doc(`timers/${timerId}`).set({
      uid: user.uid,
      label,
      durationSeconds,
      repeat,
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
      if (secsLeft === 0) el.closest('.timer-card')?.classList.add('timer-card-expired');
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

// ── Alarms pane ────────────────────────────────────────────────
function _renderAlarmsPane() {
  const alarms = (typeof dataManager !== 'undefined' && dataManager.getAlarms) ? dataManager.getAlarms() : [];
  let html = '';

  const editing = _editingAlarmId && alarms.find(a => a.id === _editingAlarmId);
  if (!editing) _editingAlarmId = null;
  const draftTime = editing ? editing.time : '08:00';
  const draftLabel = editing ? (editing.label || '') : '';

  html += `<div class="timers-create-panel alarm-create-panel">
    <div class="timers-create-header">
      <span class="timers-create-title">&#9200; ${editing ? 'Edit Alarm' : 'New Alarm'}</span>
      <span class="timers-create-sub">Pick a time and choose which days it repeats</span>
    </div>
    <div class="timers-create-top">
      <input type="time" id="alarm-time" class="alarm-time-input" value="${draftTime}">
      <input type="text" id="alarm-label" class="timers-label-input" placeholder="Alarm label (optional)" maxlength="100" value="${escapeHtml(draftLabel)}">
      <button class="timers-start-btn" id="alarm-save-btn">${editing ? 'Save' : '+ Add Alarm'}</button>
      ${editing ? '<button class="alarm-cancel-edit" id="alarm-cancel-edit">Cancel</button>' : ''}
    </div>
    <div class="alarm-day-row">
      <div class="alarm-day-pills">
        ${WEEKDAY_INITIALS.map((d, i) => `<button class="alarm-day-pill ${_alarmDayDraft.includes(i) ? 'active' : ''}" data-day="${i}">${d}</button>`).join('')}
      </div>
      <div class="alarm-day-presets">
        <button class="alarm-preset" data-preset="daily">Every day</button>
        <button class="alarm-preset" data-preset="weekdays">Weekdays</button>
        <button class="alarm-preset" data-preset="weekends">Weekends</button>
        <button class="alarm-preset" data-preset="once">Once</button>
      </div>
    </div>
  </div>`;

  if (alarms.length > 0) {
    const sorted = [...alarms].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    html += '<div class="timers-section-label">Alarms</div><div class="alarm-list">';
    for (const a of sorted) {
      const next = _nextAlarmOccurrence(a);
      html += `<div class="alarm-row ${a.enabled ? '' : 'alarm-row-off'}" data-id="${a.id}">
        <div class="alarm-time">${_fmt12(a.time)}</div>
        <div class="alarm-info">
          <div class="alarm-label">${escapeHtml(a.label || 'Alarm')}</div>
          <div class="alarm-meta">
            <span class="alarm-days">${_daysSummary(a.days)}</span>
            ${a.enabled && next ? `<span class="alarm-next">&middot; ${_fmtNextFire(next)}</span>` : ''}
          </div>
        </div>
        <label class="alarm-switch" title="${a.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" class="alarm-toggle" data-id="${a.id}" ${a.enabled ? 'checked' : ''}>
          <span class="alarm-switch-track"></span>
        </label>
        <button class="alarm-act alarm-edit" data-id="${a.id}" title="Edit">&#9998;</button>
        <button class="alarm-act alarm-delete" data-id="${a.id}" title="Delete">&#128465;</button>
      </div>`;
    }
    html += '</div>';
  } else {
    html += `<div class="timers-empty">
      <div class="timers-empty-icon">&#9200;</div>
      <div class="timers-empty-text">No alarms yet.<br>Set a time above and add one.</div>
    </div>`;
  }

  return html;
}

function _bindAlarmEvents() {
  document.querySelectorAll('#view-timers .alarm-day-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = parseInt(btn.dataset.day);
      if (_alarmDayDraft.includes(d)) _alarmDayDraft = _alarmDayDraft.filter(x => x !== d);
      else _alarmDayDraft = [..._alarmDayDraft, d].sort();
      btn.classList.toggle('active');
    });
  });

  document.querySelectorAll('#view-timers .alarm-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      if (p === 'daily')         _alarmDayDraft = [0, 1, 2, 3, 4, 5, 6];
      else if (p === 'weekdays') _alarmDayDraft = [1, 2, 3, 4, 5];
      else if (p === 'weekends') _alarmDayDraft = [0, 6];
      else                       _alarmDayDraft = [];
      document.querySelectorAll('#view-timers .alarm-day-pill').forEach(pill => {
        pill.classList.toggle('active', _alarmDayDraft.includes(parseInt(pill.dataset.day)));
      });
    });
  });

  document.getElementById('alarm-save-btn')?.addEventListener('click', async () => {
    const time = document.getElementById('alarm-time').value;
    if (!time) { alert('Please pick a time.'); return; }
    const label = document.getElementById('alarm-label').value.trim() || 'Alarm';
    const days = [..._alarmDayDraft];

    if (_editingAlarmId) {
      // Reset lastFired so an edited alarm can fire again today.
      await dataManager.updateAlarm(_editingAlarmId, { time, label, days, enabled: true, lastFired: null });
      _editingAlarmId = null;
    } else {
      await dataManager.addAlarm({ time, label, days, enabled: true });
    }
    _alarmDayDraft = [];
    window.dispatchEvent(new CustomEvent('alarms-changed'));
  });

  document.getElementById('alarm-cancel-edit')?.addEventListener('click', () => {
    _editingAlarmId = null; _alarmDayDraft = [];
    window.dispatchEvent(new CustomEvent('alarms-changed'));
  });

  document.querySelectorAll('#view-timers .alarm-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      const patch = { enabled: cb.checked };
      if (cb.checked) patch.lastFired = null; // re-arm so it can fire again today
      await dataManager.updateAlarm(cb.dataset.id, patch);
      window.dispatchEvent(new CustomEvent('alarms-changed'));
    });
  });

  document.querySelectorAll('#view-timers .alarm-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = dataManager.getAlarms().find(x => x.id === btn.dataset.id);
      if (!a) return;
      _editingAlarmId = a.id;
      _alarmDayDraft = Array.isArray(a.days) ? [...a.days] : [];
      renderTimers();
    });
  });

  document.querySelectorAll('#view-timers .alarm-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = window._showConfirm
        ? await window._showConfirm({ title: 'Delete alarm?', message: 'This alarm will be removed.', confirmText: 'Delete', danger: true })
        : confirm('Delete this alarm?');
      if (!ok) return;
      if (_editingAlarmId === btn.dataset.id) _editingAlarmId = null;
      await dataManager.deleteAlarm(btn.dataset.id);
      window.dispatchEvent(new CustomEvent('alarms-changed'));
    });
  });
}

function _nextAlarmOccurrence(a) {
  if (!a || !a.enabled || !a.time) return null;
  const [h, m] = a.time.split(':').map(Number);
  const now = new Date();
  const recurring = Array.isArray(a.days) && a.days.length > 0;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d <= now) continue;
    if (!recurring) return d;            // one-shot: next time it elapses
    if (a.days.includes(d.getDay())) return d;
  }
  return null;
}

function _daysSummary(days) {
  if (!Array.isArray(days) || days.length === 0) return 'Once';
  const set = [...days].sort();
  if (set.length === 7) return 'Every day';
  if (set.length === 5 && [1, 2, 3, 4, 5].every(d => set.includes(d))) return 'Weekdays';
  if (set.length === 2 && set.includes(0) && set.includes(6)) return 'Weekends';
  return set.map(d => WEEKDAYS[d]).join(', ');
}

function _fmt12(time) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function _fmtNextFire(d) {
  const diff = d - Date.now();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'in <1 min';
  if (mins < 60) return `in ${mins} min`;
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) {
    const hrs = Math.floor(mins / 60), rem = mins % 60;
    return `in ${hrs}h${rem ? ' ' + rem + 'm' : ''}`;
  }
  const wd = d.toLocaleDateString(undefined, { weekday: 'short' });
  const tm = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${wd} ${tm}`;
}

// ── Stopwatch pane ─────────────────────────────────────────────
let _stopwatch = { running: false, startTs: 0, accumulated: 0, laps: [] };
let _swInterval = null;

function _swElapsed() {
  return _stopwatch.accumulated + (_stopwatch.running ? Date.now() - _stopwatch.startTs : 0);
}

function fmtStopwatch(ms) {
  const cs = Math.floor((ms % 1000) / 10);
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  const base = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${base}.${String(cs).padStart(2, '0')}`;
}

function _renderStopwatchPane() {
  const running = _stopwatch.running;
  const hasTime = _swElapsed() > 0 || running;
  let html = `<div class="stopwatch-panel">
    <div class="sw-display" id="sw-display">${fmtStopwatch(_swElapsed())}</div>
    <div class="sw-controls">
      <button class="sw-btn ${running ? 'sw-stop' : 'sw-start'}" id="sw-toggle">${running ? '⏸ Stop' : '▶ Start'}</button>
      <button class="sw-btn sw-lap" id="sw-lap" ${running ? '' : 'disabled'}>⚐ Lap</button>
      <button class="sw-btn sw-reset" id="sw-reset" ${hasTime ? '' : 'disabled'}>↺ Reset</button>
    </div>`;

  if (_stopwatch.laps.length > 0) {
    html += '<div class="sw-laps">';
    let prev = 0;
    _stopwatch.laps.forEach((total, i) => {
      const split = total - prev; prev = total;
      html += `<div class="sw-lap-row">
        <span class="sw-lap-num">Lap ${i + 1}</span>
        <span class="sw-lap-split">${fmtStopwatch(split)}</span>
        <span class="sw-lap-total">${fmtStopwatch(total)}</span>
      </div>`;
    });
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function _swTick() {
  const el = document.getElementById('sw-display');
  if (el) el.textContent = fmtStopwatch(_swElapsed());
}

function _ensureSwInterval() {
  if (!_swInterval) _swInterval = setInterval(_swTick, 50);
}

function _bindStopwatchEvents() {
  document.getElementById('sw-toggle')?.addEventListener('click', () => {
    if (_stopwatch.running) {
      _stopwatch.accumulated = _swElapsed();
      _stopwatch.running = false;
      if (_swInterval) { clearInterval(_swInterval); _swInterval = null; }
    } else {
      _stopwatch.startTs = Date.now();
      _stopwatch.running = true;
      _ensureSwInterval();
    }
    renderTimers();
  });

  document.getElementById('sw-lap')?.addEventListener('click', () => {
    if (!_stopwatch.running) return;
    _stopwatch.laps.push(_swElapsed());
    renderTimers();
  });

  document.getElementById('sw-reset')?.addEventListener('click', () => {
    _stopwatch = { running: false, startTs: 0, accumulated: 0, laps: [] };
    if (_swInterval) { clearInterval(_swInterval); _swInterval = null; }
    renderTimers();
  });

  if (_stopwatch.running) _ensureSwInterval();
}

// ── Always-on watcher ──────────────────────────────────────────
// Fires timer expiry alerts (and handles repeating timers) and checks
// alarms even when the Timers tab isn't open.
function _handleTimerExpiry(t) {
  if (!t || !t.id || _notifiedTimers.has(t.id)) return;
  _notifiedTimers.add(t.id);
  _onTimerExpired(t.label || 'Timer');
  if (t.repeat && t.durationSeconds) {
    // Roll over to a fresh countdown and retire the finished one.
    _createTimer(t.label || 'Timer', t.durationSeconds, { repeat: true }).catch(() => {});
    try { firebaseSync.db.doc(`timers/${t.id}`).update({ status: 'expired' }); } catch {}
  }
}

function _checkAlarms() {
  if (typeof dataManager === 'undefined' || !dataManager.settings) return;
  const alarms = dataManager.getAlarms ? dataManager.getAlarms() : (dataManager.settings.alarms || []);
  if (!alarms.length) return;

  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dow = now.getDay();
  let changed = false;

  for (const a of alarms) {
    if (!a.enabled || a.time !== cur || a.lastFired === today) continue;
    const recurring = Array.isArray(a.days) && a.days.length > 0;
    if (recurring && !a.days.includes(dow)) continue;
    a.lastFired = today;
    if (!recurring) a.enabled = false; // one-shot alarms switch off after firing
    changed = true;
    _onAlarmFired(a);
  }

  if (changed) {
    dataManager._saveSettings();
    window.dispatchEvent(new CustomEvent('alarms-changed'));
  }
}

let _globalTimerWatch = null;
function _ensureGlobalTimerWatch() {
  if (_globalTimerWatch) return;
  _globalTimerWatch = setInterval(() => {
    const active = (window._timers && window._timers.active) || [];
    const now = Date.now();
    for (const t of active) {
      const expMs = t.expiresAt ? (t.expiresAt.getTime ? t.expiresAt.getTime() : +new Date(t.expiresAt)) : 0;
      if (expMs && expMs <= now) _handleTimerExpiry(t);
    }
    _checkAlarms();
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
