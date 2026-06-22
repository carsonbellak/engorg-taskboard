// EngOrg PWA — Mobile Companion App

const firebaseConfig = {
  apiKey: "AIzaSyA0PSZdBoVrNUrDR384m8O5PcMcbDrGGSw",
  authDomain: "assistant-taskboard.firebaseapp.com",
  projectId: "assistant-taskboard",
  storageBucket: "assistant-taskboard.firebasestorage.app",
  messagingSenderId: "1036110821826",
  appId: "1:1036110821826:web:53c88fa09d3d24a141be5b"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW:', err));
}

// ===================== iOS "ADD TO HOME SCREEN" BANNER =====================
// Show a gentle prompt on iOS Safari when the PWA isn't already installed.
// Hidden forever once dismissed, and hidden automatically when launched from the home screen.
(function showIOSInstallBannerIfNeeded() {
  try {
    const ua = window.navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    // iPadOS 13+ reports as Mac — catch it via touch support
    const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const isIOSLike = isIOS || isIPadOS;
    if (!isIOSLike) return;

    // Safari-only: Chrome/Firefox on iOS can't install PWAs and exposing
    // "Add to Home Screen" instructions would be misleading there.
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    if (!isSafari) return;

    // Already running as an installed PWA?
    const isStandalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (isStandalone) return;

    // Respect prior dismissal
    if (localStorage.getItem('iosInstallBannerDismissed') === '1') return;

    const banner = document.getElementById('ios-install-banner');
    if (!banner) return;

    // Wait a beat so it doesn't slam in on first paint
    setTimeout(() => banner.classList.remove('hidden'), 1200);

    document.getElementById('ios-install-dismiss').addEventListener('click', () => {
      banner.classList.add('hidden');
      try { localStorage.setItem('iosInstallBannerDismissed', '1'); } catch (e) {}
    });
  } catch (e) {
    console.warn('iOS install banner:', e);
  }
})();

// ===================== THEMES (synced from desktop) =====================
const COLOR_THEMES = {
  default: { name:'Default', dark:false, vars:{'--bg':'#F8FAFC','--bg-card':'#FFFFFF','--bg-elevated':'#F1F5F9','--border':'#E2E8F0','--text':'#0F172A','--text-secondary':'#334155','--text-muted':'#64748B','--accent':'#3B82F6','--accent-light':'rgba(59,130,246,0.12)','--success':'#22C55E','--warning':'#F59E0B','--danger':'#EF4444','--radius':'12px'} },
  dark: { name:'Dark', dark:true, vars:{'--bg':'#0F172A','--bg-card':'#1E293B','--bg-elevated':'#334155','--border':'#334155','--text':'#F1F5F9','--text-secondary':'#CBD5E1','--text-muted':'#94A3B8','--accent':'#3B82F6','--accent-light':'rgba(59,130,246,0.15)','--success':'#4ADE80','--warning':'#FBBF24','--danger':'#F87171','--radius':'12px'} },
  glass: { name:'Glass', dark:true, vars:{'--bg':'#0B0E1A','--bg-card':'rgba(255,255,255,0.06)','--bg-elevated':'rgba(255,255,255,0.08)','--border':'rgba(255,255,255,0.1)','--text':'#E8ECF4','--text-secondary':'#B8C4D8','--text-muted':'#7B8BA8','--accent':'#818CF8','--accent-light':'rgba(129,140,248,0.12)','--success':'#34D399','--warning':'#FBBF24','--danger':'#FB7185','--radius':'16px'} },
  neon: { name:'Neon', dark:true, vars:{'--bg':'#0A0A0F','--bg-card':'#141420','--bg-elevated':'#1A1A2A','--border':'#2A2A3E','--text':'#E0E0FF','--text-secondary':'#A0A0CC','--text-muted':'#6B6B99','--accent':'#00FFAA','--accent-light':'rgba(0,255,170,0.08)','--success':'#00FF88','--warning':'#FFD600','--danger':'#FF2266','--radius':'6px'} },
  brutalist: { name:'Brutalist', dark:false, vars:{'--bg':'#FAFAE0','--bg-card':'#FFFFF0','--bg-elevated':'#F0F0D8','--border':'#000000','--text':'#000000','--text-secondary':'#222200','--text-muted':'#555544','--accent':'#FF3300','--accent-light':'#FFEEEE','--success':'#008800','--warning':'#CC8800','--danger':'#CC0000','--radius':'0px'} },
  nord: { name:'Nord', dark:true, vars:{'--bg':'#2E3440','--bg-card':'#3B4252','--bg-elevated':'#434C5E','--border':'#434C5E','--text':'#ECEFF4','--text-secondary':'#D8DEE9','--text-muted':'#81A1C1','--accent':'#88C0D0','--accent-light':'rgba(136,192,208,0.12)','--success':'#A3BE8C','--warning':'#EBCB8B','--danger':'#BF616A','--radius':'8px'} },
  midnight: { name:'Midnight', dark:true, vars:{'--bg':'#13111C','--bg-card':'#1C1929','--bg-elevated':'#2D2640','--border':'#2D2640','--text':'#E8E4F0','--text-secondary':'#C4BDD4','--text-muted':'#8B80A5','--accent':'#A78BFA','--accent-light':'rgba(167,139,250,0.15)','--success':'#4ADE80','--warning':'#FBBF24','--danger':'#F87171','--radius':'12px'} },
  forest: { name:'Forest', dark:false, vars:{'--bg':'#E6F0EB','--bg-card':'#FFFFFF','--bg-elevated':'#D5E8DD','--border':'#C6DDD0','--text':'#1A3A2A','--text-secondary':'#2D5940','--text-muted':'#4A7A5C','--accent':'#16A34A','--accent-light':'#DCFCE7','--success':'#22C55E','--warning':'#F59E0B','--danger':'#EF4444','--radius':'12px'} },
  ocean: { name:'Ocean', dark:true, vars:{'--bg':'#0C1222','--bg-card':'#131D33','--bg-elevated':'#1A2844','--border':'#1E3055','--text':'#E0E8F5','--text-secondary':'#B0C4E0','--text-muted':'#6B8DBB','--accent':'#0EA5E9','--accent-light':'rgba(14,165,233,0.15)','--success':'#34D399','--warning':'#FBBF24','--danger':'#FB7185','--radius':'12px'} },
  rose: { name:'Rose', dark:false, vars:{'--bg':'#FEE2E8','--bg-card':'#FFFFFF','--bg-elevated':'#FECDD3','--border':'#FECDD3','--text':'#4C0519','--text-secondary':'#881337','--text-muted':'#BE185D','--accent':'#E11D48','--accent-light':'#FFE4E6','--success':'#22C55E','--warning':'#F59E0B','--danger':'#EF4444','--radius':'12px'} },
  sand: { name:'Sand', dark:false, vars:{'--bg':'#F0EBE1','--bg-card':'#FFFFFF','--bg-elevated':'#E8E0D0','--border':'#D4C9B8','--text':'#3D3425','--text-secondary':'#5C503C','--text-muted':'#8C7D66','--accent':'#B45309','--accent-light':'#FEF3C7','--success':'#22C55E','--warning':'#F59E0B','--danger':'#EF4444','--radius':'12px'} },
  soft: { name:'Soft', dark:false, vars:{'--bg':'#FAE8FF','--bg-card':'#FFFFFF','--bg-elevated':'#F5D0FE','--border':'#F0ABFC','--text':'#4A1D6A','--text-secondary':'#6B2F8A','--text-muted':'#A855F7','--accent':'#C084FC','--accent-light':'#FAE8FF','--success':'#86EFAC','--warning':'#FDE68A','--danger':'#FCA5A5','--radius':'18px'} },
  mono: { name:'Mono', dark:false, vars:{'--bg':'#F5F5F5','--bg-card':'#FFFFFF','--bg-elevated':'#EEEEEE','--border':'#DDDDDD','--text':'#111111','--text-secondary':'#333333','--text-muted':'#777777','--accent':'#111111','--accent-light':'#F0F0F0','--success':'#333333','--warning':'#666666','--danger':'#111111','--radius':'3px'} },
  grunge: { name:'Grunge', dark:true, vars:{'--bg':'#33291E','--bg-card':'#352C22','--bg-elevated':'#3D3328','--border':'#504030','--text':'#D4C8B0','--text-secondary':'#B8A888','--text-muted':'#8A7860','--accent':'#C8553A','--accent-light':'rgba(200,85,58,0.12)','--success':'#7AA44A','--warning':'#CC9933','--danger':'#C83A3A','--radius':'3px'} },
  hacker: { name:'Hacker', dark:true, vars:{'--bg':'#0F0F0F','--bg-card':'#111111','--bg-elevated':'#1A1A1A','--border':'#1A3A1A','--text':'#00FF41','--text-secondary':'#00CC33','--text-muted':'#008822','--accent':'#00FF41','--accent-light':'rgba(0,255,65,0.06)','--success':'#00FF41','--warning':'#CCFF00','--danger':'#FF3300','--radius':'0px'} },
  highContrast: { name:'High Contrast', dark:true, vars:{'--bg':'#1A1A1A','--bg-card':'#1A1A1A','--bg-elevated':'#333333','--border':'#555555','--text':'#FFFFFF','--text-secondary':'#E0E0E0','--text-muted':'#BBBBBB','--accent':'#00BFFF','--accent-light':'rgba(0,191,255,0.2)','--success':'#00FF7F','--warning':'#FFD700','--danger':'#FF4444','--radius':'10px'} },
  sunset: { name:'Sunset', dark:true, vars:{'--bg':'#241530','--bg-card':'rgba(255,255,255,0.05)','--bg-elevated':'rgba(255,255,255,0.08)','--border':'rgba(255,140,80,0.15)','--text':'#FDE8D8','--text-secondary':'#E8C4AC','--text-muted':'#B08870','--accent':'#FF8C50','--accent-light':'rgba(255,140,80,0.12)','--success':'#4ADE80','--warning':'#FBBF24','--danger':'#FB7185','--radius':'14px'} },
};

function applyTheme(themeId) {
  const theme = COLOR_THEMES[themeId] || COLOR_THEMES.dark;
  const root = document.documentElement;
  for (const [prop, val] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, val);
  }
  // Drive native controls (select dropdown popups, scrollbars) to match the theme.
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  document.body.classList.toggle('theme-dark', theme.dark);
  document.body.classList.toggle('theme-light', !theme.dark);
  // Update meta theme-color
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.vars['--accent'] || '#818CF8');
}

// ===================== PUSH NOTIFICATIONS =====================
// Set after VAPID keys are generated: npx web-push generate-vapid-keys
// Paste only the PUBLIC key here (private key goes in Firebase secrets only).
const VAPID_PUBLIC_KEY = 'BDmHi7C-yoOita_aL7JFADc18CiVCcn0Jw43XPIQZ_4Bu4J279M1PgRnktePqsJh_-UGkhikhwnnUOdUsBEeQhM';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function getApiToken() {
  let token = localStorage.getItem('engorg_api_token');
  if (token) return token;
  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch('/api/generateApiToken', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + idToken }
  });
  const d = await r.json();
  token = d.token;
  if (token) localStorage.setItem('engorg_api_token', token);
  return token;
}

async function subscribeToPush(uid) {
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const idToken = await auth.currentUser.getIdToken();
    await fetch('/api/registerPushSubscription', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() })
    });
  } catch (err) {
    console.warn('Push subscription failed:', err);
  }
}

async function initPushNotifications(uid) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'denied') return;
  if (Notification.permission === 'granted') await subscribeToPush(uid);
  // If 'default', wait for user gesture in the Timers UI
}

// ===================== STATE =====================
let currentView = 'notes';
let currentProject = 'all';
let data = { tasks: [], projects: [], archivedProjects: [], purchases: [], scheduleItems: [], todos: [], settings: {} };
let printerFeed = null;
let listeners = [];
let editingNoteId = null;
let timers = { active: [], recent: [] };
let timerCountdownInterval = null;
let editingScheduleId = null;
let editingPurchaseId = null;
let calendarMonth = new Date();
let filters = { priority: '', category: '', overdue: false };
let noteSortMode = 'priority';
let noteColorMode = 'category';
let completedShown = 10;
let completedObserver = null;

// ===================== AUTH =====================
const loginScreen = document.getElementById('screen-login');
const appScreen = document.getElementById('screen-app');

auth.onAuthStateChanged(user => {
  if (user) {
    loginScreen.classList.remove('active');
    appScreen.classList.add('active');
    setupListeners(user.uid);
    updateUserMenu(user);
    initPushNotifications(user.uid);
  } else {
    appScreen.classList.remove('active');
    loginScreen.classList.add('active');
    removeListeners();
  }
});

document.getElementById('btn-google-login').addEventListener('click', async () => {
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (err) { showLoginError(err.message); }
});

document.getElementById('btn-email-login').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return;
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      try { await auth.createUserWithEmailAndPassword(email, password); }
      catch (e) { showLoginError(e.message); }
    } else if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      showLoginError('Incorrect password.');
    } else { showLoginError(err.message); }
  }
});

document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-email-login').click();
});

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ===================== FIRESTORE LISTENERS =====================
function setupListeners(uid) {
  removeListeners();
  const base = db.collection('users').doc(uid).collection('data');

  const mappings = [
    { doc: 'tasks', prop: 'tasks', key: 'tasks' },
    { doc: 'projects', prop: 'projects', key: 'projects' },
    { doc: 'purchases', prop: 'purchases', key: 'purchases' },
    { doc: 'schedule', prop: 'scheduleItems', key: 'items' },
    { doc: 'todos', prop: 'todos', key: 'items' },
    { doc: 'archived_projects', prop: 'archivedProjects', key: 'projects' },
  ];

  for (const m of mappings) {
    const unsub = base.doc(m.doc).onSnapshot(snap => {
      if (!snap.exists) return;
      const d = snap.data();
      const items = d[m.key];
      if (items && Array.isArray(items)) data[m.prop] = items;
      scheduleRender();
    });
    listeners.push(unsub);
  }

  // Settings — includes theme
  const unsubSettings = base.doc('settings').onSnapshot(snap => {
    if (!snap.exists) return;
    const d = snap.data();
    delete d._updatedAt;
    delete d._source;
    data.settings = d;
    // Apply synced theme
    if (d.theme && COLOR_THEMES[d.theme]) {
      applyTheme(d.theme);
    }
    // Show/hide printer tab based on setting
    const printerNav = document.querySelector('.nav-item[data-view="printer"]');
    if (printerNav) printerNav.style.display = d.printerEnabled ? '' : 'none';
    // If on printer view and it just got disabled, switch to notes
    if (!d.printerEnabled && currentView === 'printer') {
      const notesNav = document.querySelector('.nav-item[data-view="notes"]');
      if (notesNav) notesNav.click();
    }
    populateFilterCategory();
  });
  listeners.push(unsubSettings);

  const unsubProjects = base.doc('projects').onSnapshot(snap => {
    if (!snap.exists) return;
    populateProjectSelector();
  });
  listeners.push(unsubProjects);

  const unsubPrinter = base.doc('printerFeed').onSnapshot(snap => {
    if (!snap.exists) { printerFeed = null; return; }
    printerFeed = snap.data();
    if (currentView === 'printer') renderPrinterFeed();
  });
  listeners.push(unsubPrinter);

  const unsubTimers = db.collection('timers')
    .where('uid', '==', uid)
    .orderBy('expiresAt', 'asc')
    .onSnapshot(snap => {
      const all = snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
        expiresAt: d.data().expiresAt?.toDate?.() || null,
        startedAt: d.data().startedAt?.toDate?.() || null
      }));
      timers.active = all.filter(t => t.status === 'active');
      timers.recent = all
        .filter(t => t.status !== 'active')
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, 20);
      if (currentView === 'timers') render();
    });
  listeners.push(unsubTimers);
}

function removeListeners() {
  listeners.forEach(fn => fn());
  listeners = [];
}

// ===================== SAVE TO FIRESTORE =====================
async function saveCollection(name, obj) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    await db.collection('users').doc(uid).collection('data').doc(name).set({
      ...obj,
      _updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      _source: 'pwa'
    });
  } catch (err) { console.error('Save failed:', err); }
}

// ===================== NAVIGATION =====================
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    completedShown = 10;
    timelineShown = 30;
    render();
  });
});

document.getElementById('project-selector').addEventListener('change', (e) => {
  currentProject = e.target.value;
  render();
});

// ===================== FILTERS =====================
document.getElementById('filter-priority').addEventListener('change', e => { filters.priority = e.target.value; render(); });
document.getElementById('filter-category').addEventListener('change', e => { filters.category = e.target.value; render(); });
document.getElementById('filter-overdue').addEventListener('click', () => {
  filters.overdue = !filters.overdue;
  document.getElementById('filter-overdue').classList.toggle('active', filters.overdue);
  render();
});
document.getElementById('filter-sort').addEventListener('change', e => { noteSortMode = e.target.value; render(); });
document.getElementById('filter-color').addEventListener('change', e => { noteColorMode = e.target.value; render(); });

function populateFilterCategory() {
  const sel = document.getElementById('filter-category');
  const cats = data.settings.categories || [];
  sel.innerHTML = `<option value="">All Categories</option>` +
    cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function applyFilters(tasks) {
  let result = tasks;
  if (filters.priority) result = result.filter(t => t.priority === filters.priority);
  if (filters.category) result = result.filter(t => t.category === filters.category);
  if (filters.overdue) {
    const now = new Date(); now.setHours(0,0,0,0);
    result = result.filter(t => t.dueDate && !t.completed && new Date(t.dueDate) < now);
  }
  return result;
}

// ===================== RENDER =====================
// Coalesce a burst of sync-driven re-renders (Firebase pushing several
// collections at once) into a single rAF rebuild instead of one per snapshot.
let _renderScheduled = false;
function scheduleRender() {
  if (_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(() => { _renderScheduled = false; render(); });
}

function render() {
  if (timerCountdownInterval) { clearInterval(timerCountdownInterval); timerCountdownInterval = null; }
  const content = document.getElementById('app-content');
  const fab = document.getElementById('fab-add');
  const filterBar = document.getElementById('filter-bar');

  const fabViews = ['notes', 'board', 'timeline', 'calendar', 'purchases'];
  if (fab) fab.style.display = fabViews.includes(currentView) ? 'flex' : 'none';

  const filterViews = ['notes', 'board'];
  filterBar.classList.toggle('hidden', !filterViews.includes(currentView));

  switch (currentView) {
    case 'notes': content.innerHTML = renderNotes(); bindNoteEvents(); setupCompletedObserver(); break;
    case 'board': {
      // Preserve per-column scroll across re-render (move buttons / sync re-render
      // would otherwise jump the board back to the top).
      const boardScroll = [];
      content.querySelectorAll('.board-column-cards').forEach(el => boardScroll.push(el.scrollTop));
      content.innerHTML = renderBoard();
      bindBoardEvents();
      content.querySelectorAll('.board-column-cards').forEach((el, i) => {
        if (boardScroll[i] != null) el.scrollTop = boardScroll[i];
      });
      break;
    }
    case 'timeline': content.innerHTML = renderTimeline(); bindTimelineEvents(); break;
    case 'calendar': content.innerHTML = renderCalendar(); bindCalendarEvents(); break;
    case 'purchases': content.innerHTML = renderPurchases(); bindPurchaseEvents(); break;
    case 'stats': content.innerHTML = renderStats(); break;
    case 'printer': content.innerHTML = renderPrinter(); renderPrinterFeed(); bindPrinterEvents(); break;
    case 'timers': content.innerHTML = renderTimers(); bindTimerEvents(); startTimerCountdown(); break;
  }
}

function getProjectName(id) { return data.projects.find(p => p.id === id)?.name || ''; }
function getProjectColor(id) { return data.projects.find(p => p.id === id)?.color || '#818CF8'; }
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function filterByProject(items) {
  if (currentProject === 'all') return items;
  return items.filter(i => i.projectId === currentProject);
}

// ===================== NOTES VIEW =====================

// Color resolution for notes
const PRIORITY_COLOR = { High: '#EF4444', Medium: '#F59E0B', Low: '#3B82F6' };
const STATUS_COLOR = { backlog: '#94A3B8', 'in-progress': '#3B82F6', review: '#A855F7', done: '#22C55E' };

function resolveNoteColorIdx(note) {
  switch (noteColorMode) {
    case 'priority': return { High: 0, Medium: 1, Low: 2 }[note.priority] ?? 1;
    case 'project': {
      const proj = data.projects.find(p => p.id === note.projectId);
      return proj ? data.projects.indexOf(proj) : 99;
    }
    case 'status': return { backlog: 0, 'in-progress': 1, review: 2, done: 3 }[note.status || 'backlog'] ?? 0;
    case 'due': {
      if (!note.dueDate) return 99;
      const days = Math.ceil((new Date(note.dueDate) - new Date()) / 86400000);
      return days < 0 ? 0 : days <= 1 ? 1 : days <= 7 ? 2 : 3;
    }
    case 'category':
    default: {
      const cats = data.settings.categories || [];
      const idx = cats.findIndex(c => c.id === note.category);
      return idx >= 0 ? idx : 99;
    }
  }
}

// ── Sticky-note color palette — mirrors desktop renderer/components/sticky-note.js
// so a given note resolves to the SAME color on the board in both apps. ──
const PWA_STICKY_LIGHT = [
  { bg: '#FEF08A', border: '#EAB308' }, // 0 Yellow
  { bg: '#86EFAC', border: '#22C55E' }, // 1 Green
  { bg: '#93C5FD', border: '#3B82F6' }, // 2 Blue
  { bg: '#FCA5A5', border: '#EF4444' }, // 3 Red
  { bg: '#C4B5FD', border: '#8B5CF6' }, // 4 Purple
  { bg: '#FDBA74', border: '#F97316' }, // 5 Orange
];
const PWA_STICKY_DARK = [
  { bg: '#423A10', border: '#A08520' },
  { bg: '#14352A', border: '#22885A' },
  { bg: '#162844', border: '#3070C0' },
  { bg: '#3A1818', border: '#C04040' },
  { bg: '#2A1F48', border: '#7050B8' },
  { bg: '#3A2410', border: '#C06820' },
];
function getStickyColors() {
  return document.body.classList.contains('theme-dark') ? PWA_STICKY_DARK : PWA_STICKY_LIGHT;
}

const STICKY_PRIORITY_IDX = { High: 3, Medium: 5, Low: 1 };          // Red, Orange, Green
const STICKY_STATUS_IDX = { backlog: 0, inProgress: 2, review: 4, done: 1 };

function hexToClosestStickyIdx(hex) {
  if (!hex) return 0;
  const map = { '#3B82F6': 2, '#EAB308': 0, '#22C55E': 1, '#F97316': 5, '#EF4444': 3, '#8B5CF6': 4 };
  if (map[hex] !== undefined) return map[hex];
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  let best = 0, bestD = Infinity;
  PWA_STICKY_LIGHT.forEach((sc, i) => {
    const sr = parseInt(sc.border.slice(1, 3), 16), sg = parseInt(sc.border.slice(3, 5), 16), sb = parseInt(sc.border.slice(5, 7), 16);
    const d = Math.abs(r - sr) + Math.abs(g - sg) + Math.abs(b - sb);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function stickyDueIdx(note) {
  if (note.completed) return 1;          // Green — done
  if (!note.dueDate) return 0;           // Yellow — no date
  const due = new Date(note.dueDate + 'T' + (note.dueTime || '23:59'));
  const daysLeft = (due - new Date()) / 86400000;
  if (daysLeft < 0) return 3;            // Red — overdue
  if (daysLeft < 2) return 5;            // Orange — due soon
  if (daysLeft < 7) return 2;            // Blue — this week
  return 1;                              // Green — plenty of time
}

// Resolve a note to its sticky color {bg, border} for the board, honoring noteColorMode.
function resolveBoardStickyColor(note) {
  const palette = getStickyColors();
  let idx;
  switch (noteColorMode) {
    case 'priority': idx = STICKY_PRIORITY_IDX[note.priority] ?? 5; break;
    case 'status':   idx = STICKY_STATUS_IDX[note.status || 'backlog'] ?? 0; break;
    case 'due':      idx = stickyDueIdx(note); break;
    case 'manual':   idx = note.colorIdx || 0; break;
    case 'project': {
      const proj = data.projects.find(p => p.id === note.projectId);
      idx = proj ? hexToClosestStickyIdx(proj.color || '#6366F1') : 0;
      break;
    }
    case 'category':
    default: {
      const cat = (data.settings.categories || []).find(c => c.id === note.category);
      idx = cat ? hexToClosestStickyIdx(cat.color) : 0;
      break;
    }
  }
  return palette[idx] || palette[0];
}

function renderNotes() {
  let tasks = applyFilters(filterByProject(data.tasks));
  if (tasks.length === 0) {
    return `<div class="empty-state"><div class="empty-icon">&#128204;</div><div class="empty-text">No notes yet.<br>Tap + to add one.</div></div>`;
  }

  const priorityOrder = { High: 0, Medium: 1, Low: 2 };

  // Sort
  tasks.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    let primary = 0;
    switch (noteSortMode) {
      case 'created': primary = new Date(b.createdAt || 0) - new Date(a.createdAt || 0); break;
      case 'created-asc': primary = new Date(a.createdAt || 0) - new Date(b.createdAt || 0); break;
      case 'due': {
        const da = a.dueDate ? new Date(a.dueDate) : new Date('2999-12-31');
        const db = b.dueDate ? new Date(b.dueDate) : new Date('2999-12-31');
        primary = da - db; break;
      }
      case 'alpha': primary = (a.title || '').localeCompare(b.title || ''); break;
      case 'category': primary = (a.category || '').localeCompare(b.category || ''); break;
      case 'project': {
        const pa = getProjectName(a.projectId) || '';
        const pb = getProjectName(b.projectId) || '';
        primary = pa.localeCompare(pb); break;
      }
      case 'priority':
      default: primary = (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1); break;
    }
    if (primary !== 0) return primary;
    // Secondary: color index
    return resolveNoteColorIdx(a) - resolveNoteColorIdx(b);
  });

  const active = tasks.filter(t => !t.completed);
  const completed = tasks.filter(t => t.completed);

  // Build groups based on sort mode
  let groups = [];
  switch (noteSortMode) {
    case 'priority':
    default:
      groups = [
        { label: 'High Priority', color: '#EF4444', notes: [] },
        { label: 'Medium Priority', color: '#F59E0B', notes: [] },
        { label: 'Low Priority', color: '#3B82F6', notes: [] },
      ];
      for (const n of active) {
        const idx = n.priority === 'High' ? 0 : n.priority === 'Low' ? 2 : 1;
        groups[idx].notes.push(n);
      }
      break;
    case 'created':
    case 'created-asc': {
      const buckets = {};
      const now = new Date();
      for (const n of active) {
        const d = new Date(n.createdAt || 0);
        const diff = Math.floor((now - d) / 86400000);
        let label;
        if (diff === 0) label = 'Today';
        else if (diff === 1) label = 'Yesterday';
        else if (diff <= 7) label = 'This Week';
        else if (diff <= 30) label = 'This Month';
        else label = 'Older';
        if (!buckets[label]) buckets[label] = [];
        buckets[label].push(n);
      }
      const order = noteSortMode === 'created'
        ? ['Today', 'Yesterday', 'This Week', 'This Month', 'Older']
        : ['Older', 'This Month', 'This Week', 'Yesterday', 'Today'];
      for (const label of order) {
        if (buckets[label]) groups.push({ label, color: '#818CF8', notes: buckets[label] });
      }
      break;
    }
    case 'due': {
      const buckets = {};
      const now = new Date();
      for (const n of active) {
        let label;
        if (!n.dueDate) { label = 'No Due Date'; }
        else {
          const diff = Math.ceil((new Date(n.dueDate) - now) / 86400000);
          if (diff < 0) label = 'Overdue';
          else if (diff === 0) label = 'Due Today';
          else if (diff === 1) label = 'Due Tomorrow';
          else if (diff <= 7) label = 'This Week';
          else label = 'Later';
        }
        if (!buckets[label]) buckets[label] = [];
        buckets[label].push(n);
      }
      for (const label of ['Overdue', 'Due Today', 'Due Tomorrow', 'This Week', 'Later', 'No Due Date']) {
        if (buckets[label]) groups.push({ label, color: label === 'Overdue' ? '#EF4444' : '#F59E0B', notes: buckets[label] });
      }
      break;
    }
    case 'alpha': {
      const letterMap = {};
      for (const n of active) {
        const ch = (n.title || '?')[0].toUpperCase().replace(/[^A-Z]/, '#');
        if (!letterMap[ch]) letterMap[ch] = [];
        letterMap[ch].push(n);
      }
      for (const ch of Object.keys(letterMap).sort()) {
        groups.push({ label: ch, color: '#818CF8', notes: letterMap[ch] });
      }
      break;
    }
    case 'category': {
      const catMap = {};
      for (const n of active) {
        const catId = n.category || '_none';
        if (!catMap[catId]) {
          const cat = (data.settings.categories || []).find(c => c.id === catId);
          catMap[catId] = { label: cat ? cat.label || cat.name : 'Uncategorized', color: cat?.color || '#94A3B8', notes: [] };
        }
        catMap[catId].notes.push(n);
      }
      groups = Object.values(catMap).sort((a, b) => a.label.localeCompare(b.label));
      break;
    }
    case 'project': {
      const projMap = {};
      for (const n of active) {
        const pid = n.projectId || '_none';
        if (!projMap[pid]) {
          const proj = data.projects.find(p => p.id === pid);
          projMap[pid] = { label: proj ? proj.name : 'No Project', color: proj?.color || '#94A3B8', notes: [] };
        }
        projMap[pid].notes.push(n);
      }
      groups = Object.values(projMap).sort((a, b) => a.label.localeCompare(b.label));
      break;
    }
  }

  // Remove empty groups
  groups = groups.filter(g => g.notes.length > 0);

  // Add completed group with lazy loading
  if (completed.length > 0) {
    completed.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
    const shown = completed.slice(0, completedShown);
    const hasMore = completed.length > completedShown;
    groups.push({ label: `Completed (${completed.length})`, color: '#22C55E', notes: shown, hasMore });
  }

  let html = '';
  for (const group of groups) {
    html += `<div class="note-group"><div class="note-group-title"><span class="note-group-dot" style="background:${group.color}"></span>${group.label}<span class="note-group-count">${group.notes.length}</span></div>`;
    for (const t of group.notes) html += renderNoteCard(t);
    if (group.hasMore) html += `<div id="completed-sentinel" class="load-more-sentinel"><span class="load-more-text">Loading more...</span></div>`;
    html += `</div>`;
  }
  return html;
}

function setupCompletedObserver() {
  if (completedObserver) completedObserver.disconnect();
  const sentinel = document.getElementById('completed-sentinel');
  if (!sentinel) return;
  completedObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      completedShown += 10;
      completedObserver.disconnect();
      render();
    }
  }, { rootMargin: '200px' });
  completedObserver.observe(sentinel);
}

function renderNoteCard(t) {
  const pClass = (t.priority || 'medium').toLowerCase();
  const projName = getProjectName(t.projectId);
  const isOverdue = t.dueDate && !t.completed && new Date(t.dueDate) < new Date();

  let metaHtml = '';
  if (t.category) {
    const cat = (data.settings.categories || []).find(c => c.id === t.category);
    metaHtml += `<span class="note-badge cat">${cat?.label || t.category}</span>`;
  }
  if (projName) metaHtml += `<span class="note-badge project">${escapeHtml(projName)}</span>`;
  if (t.status && t.status !== 'backlog') metaHtml += `<span class="note-badge status">${t.status}</span>`;
  if (isOverdue) metaHtml += `<span class="note-badge due">Overdue</span>`;
  else if (t.dueDate) metaHtml += `<span class="note-badge due" style="background:rgba(245,158,11,0.15);color:#FCD34D">${t.dueDate}</span>`;

  let checklistHtml = '';
  if (t.checklist && t.checklist.length > 0) {
    const done = t.checklist.filter(c => c.done).length;
    const total = t.checklist.length;
    const pct = Math.round((done / total) * 100);
    checklistHtml = `<div class="note-checklist-progress"><div class="note-checklist-bar"><div class="note-checklist-fill" style="width:${pct}%"></div></div>${done}/${total}</div>`;
  }

  return `<div class="note-card ${t.completed ? 'completed' : ''}" data-id="${t.id}">
    <div class="note-priority-bar ${pClass}"></div>
    <div class="note-header">
      <button class="note-checkbox ${t.completed ? 'checked' : ''}" data-toggle="${t.id}">${t.completed ? '&#10003;' : ''}</button>
      <div class="note-title">${escapeHtml(t.title)}</div>
    </div>
    ${metaHtml || checklistHtml ? `<div class="note-meta">${metaHtml}${checklistHtml}</div>` : ''}
  </div>`;
}

function bindNoteEvents() {
  document.querySelectorAll('.note-checkbox').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const task = data.tasks.find(t => t.id === btn.dataset.toggle);
      if (!task) return;
      task.completed = !task.completed;
      task.completedAt = task.completed ? new Date().toISOString() : null;
      task.modifiedAt = new Date().toISOString();
      if (task.completed) task.status = 'done';
      await saveCollection('tasks', { tasks: data.tasks });
      render();
    });
  });
  document.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.note-checkbox')) return;
      showNoteDetail(card.dataset.id);
    });
  });
}

// ===================== BOARD VIEW (Kanban) =====================
// Sort tasks by the active sort mode (mirrors the notes-view comparator) so each
// board column can be sorted individually.
function sortTasksByMode(arr) {
  const priorityOrder = { High: 0, Medium: 1, Low: 2 };
  return arr.sort((a, b) => {
    let primary = 0;
    switch (noteSortMode) {
      case 'created': primary = new Date(b.createdAt || 0) - new Date(a.createdAt || 0); break;
      case 'created-asc': primary = new Date(a.createdAt || 0) - new Date(b.createdAt || 0); break;
      case 'due': {
        const da = a.dueDate ? new Date(a.dueDate) : new Date('2999-12-31');
        const db = b.dueDate ? new Date(b.dueDate) : new Date('2999-12-31');
        primary = da - db; break;
      }
      case 'alpha': primary = (a.title || '').localeCompare(b.title || ''); break;
      case 'category': primary = (a.category || '').localeCompare(b.category || ''); break;
      case 'project': {
        const pa = getProjectName(a.projectId) || '';
        const pb = getProjectName(b.projectId) || '';
        primary = pa.localeCompare(pb); break;
      }
      case 'priority':
      default: primary = (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1); break;
    }
    if (primary !== 0) return primary;
    return resolveNoteColorIdx(a) - resolveNoteColorIdx(b);
  });
}

function renderBoard() {
  const tasks = applyFilters(filterByProject(data.tasks));
  const columns = [
    { key: 'backlog', label: 'Backlog', icon: '&#128203;' },
    { key: 'inProgress', label: 'In Progress', icon: '&#9881;' },
    { key: 'review', label: 'Review', icon: '&#128269;' },
    { key: 'done', label: 'Done', icon: '&#9989;' },
  ];

  let html = '<div class="board-container">';
  for (const col of columns) {
    const colTasks = sortTasksByMode(tasks.filter(t => (t.status || 'backlog') === col.key));
    html += `<div class="board-column">
      <div class="board-column-header">
        <span>${col.icon} ${col.label}</span>
        <span class="board-column-count">${colTasks.length}</span>
      </div>
      <div class="board-column-cards">`;
    if (colTasks.length === 0) {
      html += `<div class="board-empty-col">No tasks</div>`;
    }
    for (const t of colTasks) {
      const projName = getProjectName(t.projectId);
      const sc = resolveBoardStickyColor(t);
      html += `<div class="board-card ${t.completed ? 'completed' : ''}" data-id="${t.id}" style="background:${sc.bg}">
        <div class="note-priority-bar" style="background:${sc.border}"></div>
        <div class="board-card-body">
          <div class="board-card-title">${escapeHtml(t.title)}</div>
          ${projName ? `<span class="note-badge project">${escapeHtml(projName)}</span>` : ''}
        </div>
        <div class="board-card-actions">
          ${col.key !== 'backlog' ? `<button class="board-move-btn" data-id="${t.id}" data-dir="left">&#9664;</button>` : ''}
          ${col.key !== 'done' ? `<button class="board-move-btn" data-id="${t.id}" data-dir="right">&#9654;</button>` : ''}
        </div>
      </div>`;
    }
    html += `</div></div>`;
  }
  html += '</div>';
  return html;
}

function bindBoardEvents() {
  const statusFlow = ['backlog', 'inProgress', 'review', 'done'];
  document.querySelectorAll('.board-move-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const task = data.tasks.find(t => t.id === btn.dataset.id);
      if (!task) return;
      const idx = statusFlow.indexOf(task.status || 'backlog');
      const newIdx = btn.dataset.dir === 'right' ? idx + 1 : idx - 1;
      if (newIdx < 0 || newIdx >= statusFlow.length) return;
      task.status = statusFlow[newIdx];
      task.modifiedAt = new Date().toISOString();
      if (task.status === 'done') { task.completed = true; task.completedAt = new Date().toISOString(); }
      else { task.completed = false; task.completedAt = null; }
      await saveCollection('tasks', { tasks: data.tasks });
      render();
    });
  });
  document.querySelectorAll('.board-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.board-move-btn')) return;
      showNoteDetail(card.dataset.id);
    });
  });
}

// ===================== NOTE DETAIL =====================
function showNoteDetail(id) {
  const t = data.tasks.find(t => t.id === id);
  if (!t) return;
  const projName = getProjectName(t.projectId);
  const cat = (data.settings.categories || []).find(c => c.id === t.category);

  let checklistHtml = '';
  if (t.checklist && t.checklist.length > 0) {
    checklistHtml = `<div class="detail-checklist">`;
    for (const item of t.checklist) {
      checklistHtml += `<div class="detail-checklist-item">
        <button class="detail-check ${item.done ? 'done' : ''}" data-check-id="${item.id}" data-note-id="${t.id}">${item.done ? '&#10003;' : ''}</button>
        <span class="detail-check-text ${item.done ? 'done' : ''}">${escapeHtml(item.text)}</span>
      </div>`;
    }
    checklistHtml += `</div>`;
  }

  document.getElementById('note-detail-content').innerHTML = `
    <div class="detail-title">${escapeHtml(t.title)}</div>
    ${t.description ? `<div class="detail-desc">${escapeHtml(t.description)}</div>` : ''}
    <div class="detail-meta">
      ${projName ? `<div class="detail-row"><span class="detail-label">Project</span><span class="detail-value">${escapeHtml(projName)}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Priority</span><span class="detail-value">${t.priority || 'Medium'}</span></div>
      <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">${t.status || 'backlog'}</span></div>
      ${cat ? `<div class="detail-row"><span class="detail-label">Category</span><span class="detail-value">${cat.name}</span></div>` : ''}
      ${t.dueDate ? `<div class="detail-row"><span class="detail-label">Due</span><span class="detail-value">${t.dueDate}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">${new Date(t.createdAt).toLocaleDateString()}</span></div>
    </div>
    ${checklistHtml}
  `;

  const overlay = document.getElementById('note-detail-overlay');
  overlay.classList.remove('hidden');
  editingNoteId = id;

  overlay.querySelectorAll('.detail-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      const task = data.tasks.find(t => t.id === btn.dataset.noteId);
      if (!task) return;
      const item = task.checklist.find(c => c.id === btn.dataset.checkId);
      if (!item) return;
      item.done = !item.done;
      item.completedAt = item.done ? new Date().toISOString() : null;
      task.modifiedAt = new Date().toISOString();
      await saveCollection('tasks', { tasks: data.tasks });
      showNoteDetail(btn.dataset.noteId);
    });
  });
}

document.getElementById('btn-close-detail').addEventListener('click', () => {
  document.getElementById('note-detail-overlay').classList.add('hidden');
  editingNoteId = null;
});
document.getElementById('btn-edit-detail').addEventListener('click', () => {
  document.getElementById('note-detail-overlay').classList.add('hidden');
  if (editingNoteId) openAddNote(editingNoteId);
});
document.getElementById('btn-delete-detail').addEventListener('click', async () => {
  if (!editingNoteId) return;
  if (!confirm('Delete this note?')) return;
  data.tasks = data.tasks.filter(t => t.id !== editingNoteId);
  await saveCollection('tasks', { tasks: data.tasks });
  document.getElementById('note-detail-overlay').classList.add('hidden');
  editingNoteId = null;
  render();
});

// ===================== TIMELINE VIEW =====================
let timelineShown = 30;
let timelineObserver = null;

function formatTime12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function buildTimelineEvents() {
  const events = [];
  const projFilter = t => currentProject === 'all' || t.projectId === currentProject;

  // Notes created
  data.tasks.filter(projFilter).forEach(note => {
    const proj = data.projects.find(p => p.id === note.projectId);
    events.push({
      date: note.createdAt || '2024-01-01T00:00:00Z',
      type: 'note-created', icon: '\u{1F4DD}',
      title: note.title,
      subtitle: proj ? proj.name : '',
      color: proj?.color || '#6366F1',
      completed: note.completed,
      category: note.category,
      priority: note.priority
    });
    if (note.completedAt) {
      events.push({
        date: note.completedAt,
        type: 'note-completed', icon: '\u2705',
        title: 'Completed: ' + note.title,
        subtitle: proj ? proj.name : '',
        color: '#22C55E', completed: true
      });
    }
    if (note.checklist) {
      note.checklist.forEach(cl => {
        if (cl.done && cl.completedAt) {
          events.push({
            date: cl.completedAt,
            type: 'checklist-completed', icon: '\u2611\uFE0F',
            title: cl.text,
            subtitle: (proj ? proj.name + ' \u00B7 ' : '') + note.title,
            color: '#16A34A', completed: true
          });
        }
      });
    }
  });

  // Schedule events
  data.scheduleItems.filter(projFilter).forEach(item => {
    const proj = data.projects.find(p => p.id === item.projectId);
    events.push({
      date: item.createdAt || '2024-01-01T00:00:00Z',
      type: 'event-created', icon: '\u{1F4C5}',
      title: item.title,
      subtitle: proj ? proj.name : '',
      color: proj?.color || '#3B82F6',
      completed: item.completed,
      time: item.startTime
    });
  });

  // Projects created
  data.projects.filter(p => currentProject === 'all' || p.id === currentProject).forEach(proj => {
    events.push({
      date: proj.createdAt || '2024-01-01T00:00:00Z',
      type: 'project-created', icon: '\u{1F680}',
      title: 'Project created: ' + proj.name,
      subtitle: '', color: proj.color || '#6366F1'
    });
  });

  // Purchases
  (data.purchases || []).filter(p => projFilter(p) && p.status !== 'toPlace').forEach(pur => {
    const proj = data.projects.find(p => p.id === pur.projectId);
    events.push({
      date: pur.createdAt || '2024-01-01T00:00:00Z',
      type: 'purchase-created', icon: '\u{1F4E6}',
      title: pur.item,
      subtitle: (proj ? proj.name + ' \u00B7 ' : '') + (pur.supplier || ''),
      color: proj?.color || '#22C55E',
      cost: pur.cost, status: pur.status
    });
  });

  events.sort((a, b) => new Date(b.date) - new Date(a.date));
  return events;
}

function renderTimeline() {
  const events = buildTimelineEvents();
  if (events.length === 0) {
    return `<div class="empty-state"><div class="empty-icon">\u{1F4CA}</div><div class="empty-text">No activity yet.<br>Start creating notes and events!</div></div>`;
  }

  const projFilter = t => currentProject === 'all' || t.projectId === currentProject;

  // Summary stats
  const totalNotes = data.tasks.filter(projFilter).length;
  const completedNotes = data.tasks.filter(t => projFilter(t) && t.completed).length;
  const totalEvents = data.scheduleItems.filter(projFilter).length;
  const checklistTotal = data.tasks.filter(projFilter).reduce((s, t) => s + (t.checklist ? t.checklist.length : 0), 0);
  const checklistDone = data.tasks.filter(projFilter).reduce((s, t) => s + (t.checklist ? t.checklist.filter(c => c.done).length : 0), 0);
  const purchases = (data.purchases || []).filter(p => projFilter(p) && p.status !== 'toPlace');
  const totalSpent = purchases.reduce((s, p) => s + ((p.cost || 0) * (p.quantity || 1)), 0);
  const overdueNotes = data.tasks.filter(t => projFilter(t) && !t.completed && t.dueDate && new Date(t.dueDate) < new Date()).length;

  let html = '<div class="tl-container">';

  // Stats row
  html += `<div class="tl-summary">
    <div class="tl-stat"><div class="tl-stat-num">${totalNotes}</div><div class="tl-stat-label">Notes</div></div>
    <div class="tl-stat"><div class="tl-stat-num">${completedNotes}</div><div class="tl-stat-label">Done</div></div>
    <div class="tl-stat"><div class="tl-stat-num">${totalNotes > 0 ? Math.round((completedNotes / totalNotes) * 100) : 0}%</div><div class="tl-stat-label">Rate</div></div>
    <div class="tl-stat"><div class="tl-stat-num">${checklistDone}/${checklistTotal}</div><div class="tl-stat-label">Checklist</div></div>
    <div class="tl-stat"><div class="tl-stat-num">${totalEvents}</div><div class="tl-stat-label">Events</div></div>
    ${purchases.length > 0 ? `<div class="tl-stat"><div class="tl-stat-num">$${totalSpent.toFixed(0)}</div><div class="tl-stat-label">Spent</div></div>` : ''}
    ${overdueNotes > 0 ? `<div class="tl-stat"><div class="tl-stat-num" style="color:#EF4444">${overdueNotes}</div><div class="tl-stat-label">Overdue</div></div>` : ''}
  </div>`;

  // Group by date, apply lazy load
  const shown = events.slice(0, timelineShown);
  const hasMore = events.length > timelineShown;
  const grouped = {};
  shown.forEach(ev => {
    const dateKey = new Date(ev.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(ev);
  });

  html += '<div class="tl-feed">';
  const statusLabels = { toPlace: 'To Place', placed: 'Placed', shipped: 'Shipped', delivered: 'Delivered' };

  for (const [dateKey, items] of Object.entries(grouped)) {
    html += `<div class="tl-date-group"><div class="tl-date-label">${dateKey}</div>`;
    for (const ev of items) {
      const timeStr = new Date(ev.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      let metaHtml = '';

      if (ev.type === 'note-created') {
        const catLabel = ev.category ? ((data.settings.categories || []).find(c => c.id === ev.category)?.label || ev.category) : '';
        metaHtml = `<span class="tl-meta">${catLabel}${ev.priority ? (catLabel ? ' \u00B7 ' : '') + ev.priority : ''}</span>`;
        if (ev.completed) metaHtml += '<span class="tl-badge tl-done">Done</span>';
      } else if (ev.type === 'note-completed') {
        metaHtml = '<span class="tl-badge tl-done">Completed</span>';
      } else if (ev.type === 'checklist-completed') {
        metaHtml = '<span class="tl-badge tl-done">Checked Off</span>';
      } else if (ev.type === 'event-created') {
        metaHtml = ev.time ? `<span class="tl-meta">${formatTime12(ev.time)}</span>` : '';
        if (ev.completed) metaHtml += '<span class="tl-badge tl-done">Done</span>';
      } else if (ev.type === 'purchase-created') {
        metaHtml = ev.cost ? `<span class="tl-meta">$${Number(ev.cost).toFixed(2)}</span>` : '';
        if (ev.status) metaHtml += `<span class="tl-badge tl-status-${ev.status}">${statusLabels[ev.status] || ev.status}</span>`;
      }

      const isDone = ev.completed;
      const dotColor = isDone ? '#22C55E' : ev.color;

      html += `<div class="tl-item${isDone ? ' tl-item-done' : ''}">
        <div class="tl-dot" style="background:${dotColor}"></div>
        <div class="tl-item-content${isDone ? ' tl-content-done' : ''}">
          <div class="tl-item-header">
            <span class="tl-icon">${ev.icon}</span>
            <span class="tl-item-title">${escapeHtml(ev.title)}</span>
            <span class="tl-item-time">${timeStr}</span>
          </div>
          ${ev.subtitle || metaHtml ? `<div class="tl-item-sub">${escapeHtml(ev.subtitle)}${metaHtml ? ' ' + metaHtml : ''}</div>` : ''}
        </div>
      </div>`;
    }
    html += '</div>';
  }

  if (hasMore) {
    html += '<div id="timeline-sentinel" class="load-more-sentinel"><span class="load-more-text">Loading more...</span></div>';
  }

  html += '</div></div>';
  return html;
}

function setupTimelineObserver() {
  if (timelineObserver) timelineObserver.disconnect();
  const sentinel = document.getElementById('timeline-sentinel');
  if (!sentinel) return;
  timelineObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      timelineShown += 30;
      timelineObserver.disconnect();
      render();
    }
  }, { rootMargin: '200px' });
  timelineObserver.observe(sentinel);
}

function bindTimelineEvents() {
  setupTimelineObserver();
}

// ===================== CALENDAR VIEW =====================
function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const monthName = calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // Event map
  const eventMap = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dateStr = date.toISOString().slice(0, 10);
    const dayName = DAYS[date.getDay()];
    const dayEvents = data.scheduleItems.filter(item => {
      if (item.date === dateStr) return true;
      if (!item.date && item.day === dayName) return true;
      return false;
    });
    if (dayEvents.length > 0) eventMap[d] = dayEvents;
  }

  let html = `<div class="calendar-header">
    <button class="cal-nav-btn" id="cal-prev">&#9664;</button>
    <span class="cal-month-title">${monthName}</span>
    <button class="cal-nav-btn" id="cal-next">&#9654;</button>
  </div>`;

  html += `<div class="calendar-grid">`;
  html += ['S','M','T','W','T','F','S'].map(d => `<div class="cal-day-label">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const isToday = date.getTime() === today.getTime();
    const hasEvents = eventMap[d];
    const evCount = hasEvents ? hasEvents.length : 0;
    html += `<div class="cal-cell ${isToday ? 'today' : ''} ${hasEvents ? 'has-events' : ''}" data-day="${d}">
      <span class="cal-date">${d}</span>
      ${evCount > 0 ? `<div class="cal-dot-row">${evCount > 3 ? '<div class="cal-dot"></div><div class="cal-dot"></div><div class="cal-dot"></div>' : Array(evCount).fill('<div class="cal-dot"></div>').join('')}</div>` : ''}
    </div>`;
  }
  html += `</div>`;
  html += `<div id="cal-day-events" class="cal-day-events"></div>`;
  return html;
}

function bindCalendarEvents() {
  const prevBtn = document.getElementById('cal-prev');
  const nextBtn = document.getElementById('cal-next');
  if (prevBtn) prevBtn.addEventListener('click', () => {
    calendarMonth.setMonth(calendarMonth.getMonth() - 1);
    document.getElementById('app-content').innerHTML = renderCalendar();
    bindCalendarEvents();
  });
  if (nextBtn) nextBtn.addEventListener('click', () => {
    calendarMonth.setMonth(calendarMonth.getMonth() + 1);
    document.getElementById('app-content').innerHTML = renderCalendar();
    bindCalendarEvents();
  });

  document.querySelectorAll('.cal-cell:not(.empty)').forEach(cell => {
    cell.addEventListener('click', () => {
      const day = parseInt(cell.dataset.day);
      const year = calendarMonth.getFullYear();
      const month = calendarMonth.getMonth();
      const date = new Date(year, month, day);
      const dateStr = date.toISOString().slice(0, 10);
      const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const dayName = DAYS[date.getDay()];

      const events = data.scheduleItems.filter(item => {
        if (item.date === dateStr) return true;
        if (!item.date && item.day === dayName) return true;
        return false;
      }).sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

      const eventsEl = document.getElementById('cal-day-events');
      if (!eventsEl) return;

      document.querySelectorAll('.cal-cell').forEach(c => c.classList.remove('selected'));
      cell.classList.add('selected');

      if (events.length === 0) {
        eventsEl.innerHTML = `<div class="cal-no-events">${date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} — No events</div>`;
        return;
      }

      let ehtml = `<div class="cal-events-title">${date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>`;
      for (const item of events) {
        ehtml += `<div class="event-card cal-event-card" data-id="${item.id}">
          <div class="event-time">${item.startTime || ''}<br>${item.endTime || ''}</div>
          <div style="flex:1"><div class="event-title">${escapeHtml(item.title)}</div></div>
          <button class="event-edit-btn" data-id="${item.id}">&#9998;</button>
        </div>`;
      }
      eventsEl.innerHTML = ehtml;

      eventsEl.querySelectorAll('.event-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openScheduleForm(btn.dataset.id); });
      });
    });
  });

  // Auto-select today's cell on load
  const todayCell = document.querySelector('.cal-cell.today');
  if (todayCell) todayCell.click();
}

// ===================== SCHEDULE CRUD =====================
function openScheduleForm(editId = null) {
  editingScheduleId = editId;
  const overlay = document.getElementById('add-schedule-overlay');
  const heading = document.getElementById('add-schedule-heading');
  const deleteBtn = document.getElementById('btn-delete-sched');

  const projSel = document.getElementById('sched-project');
  projSel.innerHTML = `<option value="">No project</option>` +
    data.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  if (editId) {
    const item = data.scheduleItems.find(i => i.id === editId);
    if (!item) return;
    heading.textContent = 'Edit Event';
    document.getElementById('sched-title').value = item.title || '';
    document.getElementById('sched-date').value = item.date || '';
    document.getElementById('sched-day').value = item.day || '';
    document.getElementById('sched-start').value = item.startTime || '';
    document.getElementById('sched-end').value = item.endTime || '';
    projSel.value = item.projectId || '';
    deleteBtn.style.display = '';
    document.getElementById('btn-save-sched').textContent = 'Update';
  } else {
    heading.textContent = 'New Event';
    document.getElementById('sched-title').value = '';
    document.getElementById('sched-date').value = '';
    document.getElementById('sched-day').value = '';
    document.getElementById('sched-start').value = '';
    document.getElementById('sched-end').value = '';
    projSel.value = currentProject !== 'all' ? currentProject : '';
    deleteBtn.style.display = 'none';
    document.getElementById('btn-save-sched').textContent = 'Save';
  }
  overlay.classList.remove('hidden');
}

document.getElementById('btn-cancel-sched').addEventListener('click', () => {
  document.getElementById('add-schedule-overlay').classList.add('hidden');
  editingScheduleId = null;
});

document.getElementById('btn-save-sched').addEventListener('click', async () => {
  const title = document.getElementById('sched-title').value.trim();
  if (!title) return;
  const date = document.getElementById('sched-date').value || null;
  const day = document.getElementById('sched-day').value || null;
  const startTime = document.getElementById('sched-start').value || null;
  const endTime = document.getElementById('sched-end').value || null;
  const projectId = document.getElementById('sched-project').value || null;

  if (editingScheduleId) {
    const item = data.scheduleItems.find(i => i.id === editingScheduleId);
    if (item) { item.title = title; item.date = date; item.day = day; item.startTime = startTime; item.endTime = endTime; item.projectId = projectId; item.modifiedAt = new Date().toISOString(); }
  } else {
    data.scheduleItems.push({
      id: 'sched_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      title, date, day, startTime, endTime, projectId,
      createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString()
    });
  }
  await saveCollection('schedule', { items: data.scheduleItems });
  document.getElementById('add-schedule-overlay').classList.add('hidden');
  editingScheduleId = null;
  render();
});

document.getElementById('btn-delete-sched').addEventListener('click', async () => {
  if (!editingScheduleId) return;
  if (!confirm('Delete this event?')) return;
  data.scheduleItems = data.scheduleItems.filter(i => i.id !== editingScheduleId);
  await saveCollection('schedule', { items: data.scheduleItems });
  document.getElementById('add-schedule-overlay').classList.add('hidden');
  editingScheduleId = null;
  render();
});

// ===================== PURCHASES VIEW =====================
function renderPurchases() {
  const purchases = filterByProject(data.purchases);
  if (purchases.length === 0) {
    return `<div class="empty-state"><div class="empty-icon">&#128230;</div><div class="empty-text">No purchase orders.<br>Tap + to add one.</div></div>`;
  }
  const statusLabels = { toPlace: 'To Order', placed: 'Ordered', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
  const statusOrder = ['toPlace', 'placed', 'shipped', 'delivered', 'cancelled'];
  const groups = {};
  for (const p of purchases) { const s = p.status || 'toPlace'; if (!groups[s]) groups[s] = []; groups[s].push(p); }

  let html = '';
  for (const status of statusOrder) {
    if (!groups[status]) continue;
    html += `<div class="purchase-group"><div class="purchase-group-title">${statusLabels[status]} (${groups[status].length})</div>`;
    for (const p of groups[status]) {
      const projName = getProjectName(p.projectId);
      html += `<div class="purchase-card" data-id="${p.id}">
        <div class="purchase-header">
          <div class="purchase-item">${escapeHtml(p.itemDescription)}</div>
          <button class="purchase-edit-btn" data-id="${p.id}">&#9998;</button>
        </div>
        <div class="purchase-details">
          ${p.supplier ? `<span class="purchase-detail">${escapeHtml(p.supplier)}</span>` : ''}
          ${p.quantity > 1 ? `<span class="purchase-detail">Qty: ${p.quantity}</span>` : ''}
          ${p.cost ? `<span class="purchase-detail purchase-cost">$${Number(p.cost).toFixed(2)}</span>` : ''}
          ${projName ? `<span class="purchase-detail">${escapeHtml(projName)}</span>` : ''}
        </div>
        ${status !== 'delivered' && status !== 'cancelled' ? `<div class="purchase-status-actions">
          ${status === 'toPlace' ? `<button class="purch-status-btn" data-id="${p.id}" data-status="placed">Mark Ordered</button>` : ''}
          ${status === 'placed' ? `<button class="purch-status-btn" data-id="${p.id}" data-status="shipped">Mark Shipped</button>` : ''}
          ${status === 'shipped' ? `<button class="purch-status-btn" data-id="${p.id}" data-status="delivered">Mark Delivered</button>` : ''}
        </div>` : ''}
      </div>`;
    }
    html += `</div>`;
  }
  return html;
}

function bindPurchaseEvents() {
  document.querySelectorAll('.purchase-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openPurchaseForm(btn.dataset.id); });
  });
  document.querySelectorAll('.purch-status-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const purchase = data.purchases.find(p => p.id === btn.dataset.id);
      if (!purchase) return;
      purchase.status = btn.dataset.status;
      purchase.modifiedAt = new Date().toISOString();
      await saveCollection('purchases', { purchases: data.purchases });
      render();
    });
  });
}

// ===================== PURCHASE CRUD =====================
function openPurchaseForm(editId = null) {
  editingPurchaseId = editId;
  const overlay = document.getElementById('add-purchase-overlay');
  const heading = document.getElementById('add-purchase-heading');
  const deleteBtn = document.getElementById('btn-delete-purch');

  const projSel = document.getElementById('purch-project');
  projSel.innerHTML = `<option value="">No project</option>` +
    data.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  if (editId) {
    const p = data.purchases.find(i => i.id === editId);
    if (!p) return;
    heading.textContent = 'Edit Order';
    document.getElementById('purch-item').value = p.itemDescription || '';
    document.getElementById('purch-supplier').value = p.supplier || '';
    document.getElementById('purch-cost').value = p.cost || '';
    document.getElementById('purch-qty').value = p.quantity || 1;
    document.getElementById('purch-status').value = p.status || 'toPlace';
    document.getElementById('purch-url').value = p.url || '';
    projSel.value = p.projectId || '';
    deleteBtn.style.display = '';
    document.getElementById('btn-save-purch').textContent = 'Update';
  } else {
    heading.textContent = 'New Order';
    document.getElementById('purch-item').value = '';
    document.getElementById('purch-supplier').value = '';
    document.getElementById('purch-cost').value = '';
    document.getElementById('purch-qty').value = 1;
    document.getElementById('purch-status').value = 'toPlace';
    document.getElementById('purch-url').value = '';
    projSel.value = currentProject !== 'all' ? currentProject : '';
    deleteBtn.style.display = 'none';
    document.getElementById('btn-save-purch').textContent = 'Save';
  }
  overlay.classList.remove('hidden');
}

document.getElementById('btn-cancel-purch').addEventListener('click', () => {
  document.getElementById('add-purchase-overlay').classList.add('hidden');
  editingPurchaseId = null;
});

document.getElementById('btn-save-purch').addEventListener('click', async () => {
  const itemDescription = document.getElementById('purch-item').value.trim();
  if (!itemDescription) return;
  const supplier = document.getElementById('purch-supplier').value.trim();
  const cost = parseFloat(document.getElementById('purch-cost').value) || 0;
  const quantity = parseInt(document.getElementById('purch-qty').value) || 1;
  const status = document.getElementById('purch-status').value;
  const url = document.getElementById('purch-url').value.trim();
  const projectId = document.getElementById('purch-project').value || null;

  if (editingPurchaseId) {
    const p = data.purchases.find(i => i.id === editingPurchaseId);
    if (p) { p.itemDescription = itemDescription; p.supplier = supplier; p.cost = cost; p.quantity = quantity; p.status = status; p.url = url; p.projectId = projectId; p.modifiedAt = new Date().toISOString(); }
  } else {
    data.purchases.push({
      id: 'purch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      itemDescription, supplier, cost, quantity, status, url, projectId,
      createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString()
    });
  }
  await saveCollection('purchases', { purchases: data.purchases });
  document.getElementById('add-purchase-overlay').classList.add('hidden');
  editingPurchaseId = null;
  render();
});

document.getElementById('btn-delete-purch').addEventListener('click', async () => {
  if (!editingPurchaseId) return;
  if (!confirm('Delete this order?')) return;
  data.purchases = data.purchases.filter(i => i.id !== editingPurchaseId);
  await saveCollection('purchases', { purchases: data.purchases });
  document.getElementById('add-purchase-overlay').classList.add('hidden');
  editingPurchaseId = null;
  render();
});

// ===================== STATS VIEW =====================
function renderStats() {
  const tasks = filterByProject(data.tasks);
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const active = total - completed;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  const statusCounts = { backlog: 0, inProgress: 0, review: 0, done: 0 };
  for (const t of tasks) statusCounts[t.status || 'backlog'] = (statusCounts[t.status || 'backlog'] || 0) + 1;

  const priorityCounts = { High: 0, Medium: 0, Low: 0 };
  for (const t of tasks) priorityCounts[t.priority || 'Medium'] = (priorityCounts[t.priority || 'Medium'] || 0) + 1;

  const now = new Date(); now.setHours(0,0,0,0);
  const overdue = tasks.filter(t => t.dueDate && !t.completed && new Date(t.dueDate) < now).length;

  const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
  const recentCompleted = tasks.filter(t => t.completedAt && new Date(t.completedAt) >= weekAgo).length;

  const purchases = filterByProject(data.purchases);
  const totalSpent = purchases.filter(p => p.status !== 'cancelled' && p.status !== 'toPlace').reduce((sum, p) => sum + ((p.cost || 0) * (p.quantity || 1)), 0);
  const pendingOrders = purchases.filter(p => ['toPlace','placed','shipped'].includes(p.status)).length;

  return `<div class="stats-container">
    <div class="stats-section">
      <div class="stats-section-title">Overview</div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total Tasks</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--success)">${completed}</div><div class="stat-label">Completed</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${active}</div><div class="stat-label">Active</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--danger)">${overdue}</div><div class="stat-label">Overdue</div></div>
      </div>
    </div>
    <div class="stats-section">
      <div class="stats-section-title">Completion Rate</div>
      <div class="stats-progress-ring">
        <div class="stats-ring-value">${completionRate}%</div>
        <div class="stats-ring-bar"><div class="stats-ring-fill" style="width:${completionRate}%"></div></div>
      </div>
      <div class="stats-sub-text">${recentCompleted} completed this week</div>
    </div>
    <div class="stats-section">
      <div class="stats-section-title">By Status</div>
      ${renderStatBar('Backlog', statusCounts.backlog, total, 'var(--text-muted)')}
      ${renderStatBar('In Progress', statusCounts.inProgress, total, 'var(--accent)')}
      ${renderStatBar('Review', statusCounts.review, total, 'var(--warning)')}
      ${renderStatBar('Done', statusCounts.done, total, 'var(--success)')}
    </div>
    <div class="stats-section">
      <div class="stats-section-title">By Priority</div>
      ${renderStatBar('High', priorityCounts.High, total, 'var(--danger)')}
      ${renderStatBar('Medium', priorityCounts.Medium, total, 'var(--warning)')}
      ${renderStatBar('Low', priorityCounts.Low, total, 'var(--success)')}
    </div>
    <div class="stats-section">
      <div class="stats-section-title">Purchases</div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" style="color:var(--success)">$${totalSpent.toFixed(2)}</div><div class="stat-label">Total Spent</div></div>
        <div class="stat-card"><div class="stat-value">${pendingOrders}</div><div class="stat-label">Pending Orders</div></div>
      </div>
    </div>
  </div>`;
}

function renderStatBar(label, count, total, color) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return `<div class="stat-bar-row">
    <div class="stat-bar-label">${label}</div>
    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="stat-bar-count">${count}</div>
  </div>`;
}

// ===================== ADD/EDIT NOTE =====================
function populateProjectSelector() {
  const sel = document.getElementById('project-selector');
  const addSel = document.getElementById('add-project');
  const catSel = document.getElementById('add-category');

  sel.innerHTML = `<option value="all">All Projects</option>` +
    data.projects.map(p => `<option value="${p.id}" ${p.id === currentProject ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

  if (addSel) addSel.innerHTML = data.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  if (catSel) {
    const cats = data.settings.categories || [];
    catSel.innerHTML = `<option value="">None</option>` + cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  }
}

document.getElementById('fab-add').addEventListener('click', () => {
  switch (currentView) {
    case 'notes': case 'board': openAddNote(); break;
    case 'timeline': case 'calendar': openScheduleForm(); break;
    case 'purchases': openPurchaseForm(); break;
  }
});

function openAddNote(editId = null) {
  editingNoteId = editId;
  const overlay = document.getElementById('add-note-overlay');
  const heading = document.getElementById('add-note-heading');
  populateProjectSelector();

  if (editId) {
    const t = data.tasks.find(t => t.id === editId);
    if (!t) return;
    heading.textContent = 'Edit Note';
    document.getElementById('add-title').value = t.title || '';
    document.getElementById('add-desc').value = t.description || '';
    document.getElementById('add-project').value = t.projectId || '';
    document.getElementById('add-status').value = t.status || 'backlog';
    document.getElementById('add-due').value = t.dueDate || '';
    document.getElementById('add-category').value = t.category || '';
    document.querySelectorAll('.priority-btn').forEach(b => b.classList.toggle('active', b.dataset.p === (t.priority || 'Medium')));
    document.getElementById('btn-save-add').textContent = 'Update';
  } else {
    heading.textContent = 'New Note';
    document.getElementById('add-title').value = '';
    document.getElementById('add-desc').value = '';
    document.getElementById('add-status').value = 'backlog';
    document.getElementById('add-due').value = '';
    document.getElementById('add-category').value = '';
    if (currentProject !== 'all') document.getElementById('add-project').value = currentProject;
    document.querySelectorAll('.priority-btn').forEach(b => b.classList.toggle('active', b.dataset.p === 'Medium'));
    document.getElementById('btn-save-add').textContent = 'Save';
  }
  overlay.classList.remove('hidden');
}

document.querySelectorAll('.priority-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('btn-cancel-add').addEventListener('click', () => {
  document.getElementById('add-note-overlay').classList.add('hidden');
  editingNoteId = null;
});

document.getElementById('btn-save-add').addEventListener('click', async () => {
  const title = document.getElementById('add-title').value.trim();
  if (!title) return;
  const priority = document.querySelector('.priority-btn.active')?.dataset.p || 'Medium';
  const projectId = document.getElementById('add-project').value;
  const status = document.getElementById('add-status').value;
  const category = document.getElementById('add-category').value;
  const dueDate = document.getElementById('add-due').value || null;
  const description = document.getElementById('add-desc').value.trim();

  if (editingNoteId) {
    const task = data.tasks.find(t => t.id === editingNoteId);
    if (!task) return;
    Object.assign(task, { title, description, projectId, priority, status, category, dueDate, modifiedAt: new Date().toISOString() });
    if (status === 'done' && !task.completed) { task.completed = true; task.completedAt = new Date().toISOString(); }
    else if (status !== 'done' && task.completed) { task.completed = false; task.completedAt = null; }
  } else {
    const now = new Date().toISOString();
    data.tasks.push({
      id: 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      title, description, projectId, priority, status, category, dueDate,
      colorIdx: 0, day: null, dueTime: null,
      completed: status === 'done', completedAt: status === 'done' ? now : null,
      createdAt: now, modifiedAt: now,
      checklist: [], attachments: [], links: [], statusHistory: []
    });
  }
  await saveCollection('tasks', { tasks: data.tasks });
  document.getElementById('add-note-overlay').classList.add('hidden');
  editingNoteId = null;
  render();
});

// ===================== PRINTER VIEW =====================
function renderPrinter() {
  return `
    <div class="printer-feed-page">
      <div class="printer-feed-video-wrap">
        <img id="printer-feed-img" class="printer-feed-img" alt="Printer camera">
        <div id="printer-feed-overlay" class="printer-feed-overlay">
          <div class="printer-feed-offline-icon">&#127912;</div>
          <div class="printer-feed-offline-text">Waiting for feed...</div>
          <div class="printer-feed-offline-hint">Desktop app must be running</div>
        </div>
        <div id="printer-feed-badge" class="printer-feed-badge">Offline</div>
        <button id="printer-feed-fullscreen" class="printer-feed-fullscreen-btn" title="Fullscreen">&#x26F6;</button>
      </div>
      <div class="printer-feed-status">
        <div class="printer-feed-state-row">
          <span id="pf-state" class="printer-feed-state">--</span>
          <span id="pf-progress" class="printer-feed-progress"></span>
        </div>
        <div id="pf-filename" class="printer-feed-filename"></div>
        <div id="pf-progress-bar-wrap" class="printer-feed-progress-bar-wrap" style="display:none">
          <div class="printer-feed-progress-bar"><div id="pf-progress-fill" class="printer-feed-progress-fill"></div></div>
          <span id="pf-progress-text" class="printer-feed-progress-text">0%</span>
        </div>
      </div>
      <div class="pf-controls">
        <button id="pf-btn-pause" class="pf-ctrl-btn pf-btn-warn" disabled>&#9646;&#9646; Pause</button>
        <button id="pf-btn-resume" class="pf-ctrl-btn pf-btn-good" style="display:none" disabled>&#9654; Resume</button>
        <button id="pf-btn-cancel" class="pf-ctrl-btn pf-btn-danger" disabled>&#9632; Cancel</button>
      </div>
      <div class="printer-feed-temps">
        <div class="printer-feed-temp-card"><div class="printer-feed-temp-label">Hotend</div><div id="pf-hotend" class="printer-feed-temp-value">--</div></div>
        <div class="printer-feed-temp-card"><div class="printer-feed-temp-label">Bed</div><div id="pf-bed" class="printer-feed-temp-value">--</div></div>
        <div class="printer-feed-temp-card"><div class="printer-feed-temp-label">Elapsed</div><div id="pf-elapsed" class="printer-feed-temp-value">--</div></div>
      </div>
      <div class="pf-temp-controls">
        <div class="pf-temp-row"><label>Hotend</label><input type="number" id="pf-hotend-input" class="pf-temp-input" placeholder="0" min="0" max="300" step="5"><button id="pf-btn-hotend" class="pf-temp-set-btn">Set</button><button class="pf-temp-off-btn" data-heater="hotend">Off</button></div>
        <div class="pf-temp-row"><label>Bed</label><input type="number" id="pf-bed-input" class="pf-temp-input" placeholder="0" min="0" max="120" step="5"><button id="pf-btn-bed" class="pf-temp-set-btn">Set</button><button class="pf-temp-off-btn" data-heater="bed">Off</button></div>
      </div>
      <div class="pf-section">
        <div class="pf-section-header"><span class="pf-section-title">Files</span><label class="pf-upload-btn">&#128228; Upload<input type="file" id="pf-file-upload" accept=".gcode,.g,.gco" hidden></label></div>
        <div id="pf-file-list" class="pf-file-list"><div class="pf-empty">No files</div></div>
      </div>
      <div id="pf-cmd-status" class="pf-cmd-status" style="display:none"></div>
      <div id="pf-updated" class="printer-feed-updated"></div>
    </div>`;
}

function renderPrinterFeed() {
  const img = document.getElementById('printer-feed-img');
  const overlay = document.getElementById('printer-feed-overlay');
  const badge = document.getElementById('printer-feed-badge');
  if (!img) return;

  if (!printerFeed || !printerFeed.status) {
    overlay.style.display = 'flex'; badge.textContent = 'Offline'; badge.className = 'printer-feed-badge offline'; return;
  }
  const s = printerFeed.status;
  let staleMs = 999999;
  try { if (printerFeed._updatedAt && printerFeed._updatedAt.toDate) staleMs = Date.now() - printerFeed._updatedAt.toDate().getTime(); } catch (e) {}
  const isStale = staleMs > 15000;

  if (printerFeed.frame && printerFeed.videoLive && !isStale) {
    img.src = printerFeed.frame; img.style.display = 'block'; overlay.style.display = 'none';
    badge.textContent = 'Live'; badge.className = 'printer-feed-badge live';
  } else if (!isStale && s.connected) {
    overlay.style.display = 'flex';
    overlay.querySelector('.printer-feed-offline-text').textContent = 'Camera not connected';
    overlay.querySelector('.printer-feed-offline-hint').textContent = 'Connect camera on desktop app';
    badge.textContent = 'No Video'; badge.className = 'printer-feed-badge novideo';
  } else {
    overlay.style.display = 'flex';
    overlay.querySelector('.printer-feed-offline-text').textContent = 'Desktop app offline';
    overlay.querySelector('.printer-feed-offline-hint').textContent = 'Start the desktop app to enable feed';
    badge.textContent = 'Offline'; badge.className = 'printer-feed-badge offline';
  }

  const stateEl = document.getElementById('pf-state');
  const stateLabels = { standby:'Ready', printing:'Printing', paused:'Paused', complete:'Complete', cancelled:'Cancelled', error:'Error' };
  if (stateEl) { stateEl.textContent = stateLabels[s.state] || s.state || '--'; stateEl.className = 'printer-feed-state ' + (s.state || 'standby'); }
  const hotendEl = document.getElementById('pf-hotend');
  if (hotendEl) hotendEl.textContent = `${(s.hotendTemp||0).toFixed(1)}\u00B0 / ${(s.hotendTarget||0).toFixed(0)}\u00B0`;
  const bedEl = document.getElementById('pf-bed');
  if (bedEl) bedEl.textContent = `${(s.bedTemp||0).toFixed(1)}\u00B0 / ${(s.bedTarget||0).toFixed(0)}\u00B0`;
  const elapsedEl = document.getElementById('pf-elapsed');
  if (elapsedEl) elapsedEl.textContent = formatPrinterTime(s.elapsed || 0);
  const fnEl = document.getElementById('pf-filename');
  if (fnEl) fnEl.textContent = s.filename || '';

  const barWrap = document.getElementById('pf-progress-bar-wrap');
  if (barWrap) {
    if (s.state === 'printing' || s.state === 'paused') {
      barWrap.style.display = 'flex';
      document.getElementById('pf-progress-fill').style.width = (s.progress||0).toFixed(1)+'%';
      document.getElementById('pf-progress-text').textContent = (s.progress||0).toFixed(1)+'%';
    } else barWrap.style.display = 'none';
  }
  const progressEl = document.getElementById('pf-progress');
  if (progressEl) progressEl.textContent = (s.state==='printing'||s.state==='paused') ? (s.progress||0).toFixed(1)+'%' : '';

  const pauseBtn = document.getElementById('pf-btn-pause');
  const resumeBtn = document.getElementById('pf-btn-resume');
  const cancelBtn = document.getElementById('pf-btn-cancel');
  if (pauseBtn && resumeBtn && cancelBtn) {
    const online = !isStale && s.connected;
    if (s.state === 'printing') { pauseBtn.style.display=''; pauseBtn.disabled=!online; resumeBtn.style.display='none'; cancelBtn.disabled=!online; }
    else if (s.state === 'paused') { pauseBtn.style.display='none'; resumeBtn.style.display=''; resumeBtn.disabled=!online; cancelBtn.disabled=!online; }
    else { pauseBtn.style.display=''; pauseBtn.disabled=true; resumeBtn.style.display='none'; cancelBtn.disabled=true; }
  }

  const fileListEl = document.getElementById('pf-file-list');
  if (fileListEl && printerFeed.files && printerFeed.files.length > 0) {
    fileListEl.innerHTML = printerFeed.files.map(f => `<div class="pf-file-row"><div class="pf-file-name">${escapeHtml(f.name)}</div><div class="pf-file-meta">${formatFileSize(f.size)}</div><button class="pf-file-print-btn" data-filename="${escapeHtml(f.name)}">&#9654;</button></div>`).join('');
  } else if (fileListEl) fileListEl.innerHTML = '<div class="pf-empty">No files available</div>';

  const updatedEl = document.getElementById('pf-updated');
  if (updatedEl && printerFeed._updatedAt) {
    const ago = Math.round(staleMs / 1000);
    updatedEl.textContent = ago < 5 ? 'Just now' : `${ago}s ago`;
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1048576).toFixed(1) + ' MB';
}

function bindPrinterEvents() {
  const fsBtn = document.getElementById('printer-feed-fullscreen');
  const wrap = document.querySelector('.printer-feed-video-wrap');
  if (!fsBtn || !wrap) return;
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen();
    else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
  });
  const onFsChange = () => { const btn = document.getElementById('printer-feed-fullscreen'); if (btn) btn.textContent = document.fullscreenElement ? '\u2716' : '\u26F6'; };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  document.getElementById('pf-btn-pause').addEventListener('click', () => sendPrinterCmd('pause'));
  document.getElementById('pf-btn-resume').addEventListener('click', () => sendPrinterCmd('resume'));
  document.getElementById('pf-btn-cancel').addEventListener('click', () => { if (confirm('Cancel the current print?')) sendPrinterCmd('cancel'); });

  document.getElementById('pf-btn-hotend').addEventListener('click', () => {
    const val = parseInt(document.getElementById('pf-hotend-input').value);
    if (!isNaN(val) && val >= 0 && val <= 300) sendPrinterCmd('setTemp', { heater: 'hotend', target: val });
  });
  document.getElementById('pf-btn-bed').addEventListener('click', () => {
    const val = parseInt(document.getElementById('pf-bed-input').value);
    if (!isNaN(val) && val >= 0 && val <= 120) sendPrinterCmd('setTemp', { heater: 'bed', target: val });
  });
  document.querySelectorAll('.pf-temp-off-btn').forEach(btn => {
    btn.addEventListener('click', () => sendPrinterCmd('setTemp', { heater: btn.dataset.heater, target: 0 }));
  });

  document.getElementById('pf-file-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.pf-file-print-btn');
    if (btn && confirm(`Start printing "${btn.dataset.filename}"?`)) sendPrinterCmd('print', { filename: btn.dataset.filename });
  });

  document.getElementById('pf-file-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('pf-cmd-status');
    statusEl.style.display = 'block'; statusEl.textContent = 'Reading ' + file.name + '...'; statusEl.className = 'pf-cmd-status pending';
    try {
      const uid = auth.currentUser.uid;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const CHUNK_SIZE = 750000;
      const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);
      statusEl.textContent = `Uploading ${file.name}... 0%`;
      const cmdRef = db.collection('users').doc(uid).collection('data').doc('printerCommand');
      const chunksRef = cmdRef.collection('chunks');
      const oldChunks = await chunksRef.get();
      if (!oldChunks.empty) { const batch = db.batch(); oldChunks.forEach(doc => batch.delete(doc.ref)); await batch.commit(); }
      for (let i = 0; i < totalChunks; i++) {
        await chunksRef.doc('chunk_' + String(i).padStart(4, '0')).set({ index: i, data: base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) });
        statusEl.textContent = `Uploading ${file.name}... ${Math.round(((i+1)/totalChunks)*100)}%`;
      }
      statusEl.textContent = 'Sending to printer...';
      await sendPrinterCmd('uploadFile', { filename: file.name, totalChunks });
    } catch (err) {
      statusEl.textContent = 'Upload failed: ' + err.message; statusEl.className = 'pf-cmd-status error';
      setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    }
    e.target.value = '';
  });
}

async function sendPrinterCmd(action, params) {
  const uid = auth.currentUser?.uid; if (!uid) return;
  const statusEl = document.getElementById('pf-cmd-status');
  if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Sending...'; statusEl.className = 'pf-cmd-status pending'; }
  try {
    await db.collection('users').doc(uid).collection('data').doc('printerCommand').set({
      action, params: params || {}, status: 'pending',
      _createdAt: firebase.firestore.FieldValue.serverTimestamp(), _source: 'pwa'
    });
    const unsub = db.collection('users').doc(uid).collection('data').doc('printerCommand').onSnapshot((snap) => {
      if (!snap.exists) return;
      const cmd = snap.data();
      if (cmd.status === 'done') {
        if (statusEl) { statusEl.textContent = cmd.result || 'Done'; statusEl.className = 'pf-cmd-status success'; setTimeout(() => { statusEl.style.display = 'none'; }, 3000); }
        unsub();
      } else if (cmd.status === 'error') {
        if (statusEl) { statusEl.textContent = 'Error: ' + (cmd.result || 'Unknown'); statusEl.className = 'pf-cmd-status error'; setTimeout(() => { statusEl.style.display = 'none'; }, 5000); }
        unsub();
      }
    });
    setTimeout(() => {
      unsub();
      if (statusEl && statusEl.classList.contains('pending')) {
        statusEl.textContent = 'Command timed out — is desktop app running?'; statusEl.className = 'pf-cmd-status error';
        setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
      }
    }, 15000);
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Failed: ' + err.message; statusEl.className = 'pf-cmd-status error'; setTimeout(() => { statusEl.style.display = 'none'; }, 5000); }
  }
}

function formatPrinterTime(seconds) {
  if (!seconds || seconds <= 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${m.toString().padStart(2,'0')}m` : `${m}m ${s.toString().padStart(2,'0')}s`;
}

// ===================== USER MENU =====================
function updateUserMenu(user) {
  document.getElementById('user-info').innerHTML = `
    ${user.photoURL ? `<img src="${user.photoURL}" class="user-avatar">` : ''}
    <div class="user-name">${user.displayName || 'User'}</div>
    <div class="user-email">${user.email || ''}</div>
  `;
}

// ===================== NEW PROJECT =====================
const PROJECT_PALETTE = [
  '#6366F1','#3B82F6','#10B981','#F59E0B','#EF4444',
  '#8B5CF6','#EC4899','#14B8A6','#F97316','#06B6D4'
];
let selectedProjColor = PROJECT_PALETTE[0];

document.getElementById('btn-new-project').addEventListener('click', () => {
  document.getElementById('new-proj-name').value = '';
  selectedProjColor = PROJECT_PALETTE[data.projects.length % PROJECT_PALETTE.length];
  const swatches = document.getElementById('new-proj-colors');
  swatches.innerHTML = PROJECT_PALETTE.map(c =>
    `<button class="proj-swatch${c === selectedProjColor ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`
  ).join('');
  swatches.querySelectorAll('.proj-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedProjColor = btn.dataset.color;
      swatches.querySelectorAll('.proj-swatch').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  document.getElementById('new-project-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-proj-name').focus(), 100);
});

document.getElementById('btn-cancel-new-proj').addEventListener('click', () =>
  document.getElementById('new-project-overlay').classList.add('hidden'));

document.getElementById('btn-save-new-proj').addEventListener('click', async () => {
  const name = document.getElementById('new-proj-name').value.trim();
  if (!name) { document.getElementById('new-proj-name').focus(); return; }
  const proj = {
    id: `proj_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    name,
    color: selectedProjColor,
    categories: [],
    createdAt: new Date().toISOString()
  };
  data.projects.push(proj);
  await saveCollection('projects', { projects: data.projects });
  populateProjectSelector();
  currentProject = proj.id;
  document.getElementById('project-selector').value = proj.id;
  document.getElementById('new-project-overlay').classList.add('hidden');
  render();
});

document.getElementById('btn-user-menu').addEventListener('click', () => document.getElementById('user-menu-overlay').classList.remove('hidden'));
document.getElementById('btn-close-menu').addEventListener('click', () => document.getElementById('user-menu-overlay').classList.add('hidden'));
document.getElementById('btn-signout').addEventListener('click', async () => {
  document.getElementById('user-menu-overlay').classList.add('hidden');
  await auth.signOut();
});

document.querySelectorAll('.overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
});

// ===================== TIMERS VIEW =====================

function formatCountdown(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatDurationLabel(seconds) {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function renderTimers() {
  const isPushGranted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const isStandalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  let html = '<div class="timers-page">';

  if (!isPushGranted) {
    html += `<div class="timer-push-banner">
      <div class="timer-push-text">${isStandalone
        ? 'Enable notifications to get alerted when timers finish.'
        : 'Add this app to your Home Screen first, then enable notifications for timer alerts.'}</div>
      ${isStandalone
        ? '<button class="timer-push-btn" id="btn-enable-push">Enable Notifications</button>'
        : `<a href="/shortcuts-setup" class="timer-push-btn">How to Install</a>`}
    </div>`;
  }

  html += `<div class="timer-create-card">
    <h2 class="timer-create-title">New Timer</h2>
    <input type="text" id="timer-label-input" class="form-input" placeholder="Label (optional)" maxlength="100">
    <div class="timer-duration-row">
      <input type="number" id="timer-minutes" class="form-input timer-num-input" placeholder="Min" min="0" max="1440">
      <span class="timer-sep">:</span>
      <input type="number" id="timer-seconds" class="form-input timer-num-input" placeholder="Sec" min="0" max="59">
    </div>
    <div class="timer-presets">
      ${[5, 10, 15, 30].map(m => `<button class="timer-preset-btn" data-minutes="${m}">${m}m</button>`).join('')}
      ${[1, 2].map(h => `<button class="timer-preset-btn" data-minutes="${h * 60}">${h}h</button>`).join('')}
    </div>
    <button class="btn-primary-full" id="btn-start-timer">Start Timer</button>
  </div>`;

  if (timers.active.length > 0) {
    html += '<div class="timer-section-title">Active</div>';
    for (const t of timers.active) {
      const secondsLeft = t.expiresAt ? Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000)) : 0;
      html += `<div class="timer-card timer-card-active" data-timer-id="${t.id}">
        <div class="timer-card-label">${escapeHtml(t.label)}</div>
        <div class="timer-countdown" data-expires="${t.expiresAt?.getTime?.() || 0}">${formatCountdown(secondsLeft)}</div>
        <div class="timer-card-meta">${formatDurationLabel(t.durationSeconds)}</div>
        <button class="timer-cancel-btn" data-id="${t.id}">Cancel</button>
      </div>`;
    }
  }

  if (timers.recent.length > 0) {
    html += '<div class="timer-section-title">Recent</div>';
    for (const t of timers.recent) {
      const statusLabel = { expired: 'Done', dismissed: 'Dismissed', cancelled: 'Cancelled' }[t.status] || t.status;
      html += `<div class="timer-card timer-card-${t.status}">
        <div class="timer-card-label">${escapeHtml(t.label)}</div>
        <div class="timer-card-meta">${formatDurationLabel(t.durationSeconds)} &middot; ${statusLabel}</div>
      </div>`;
    }
  }

  if (timers.active.length === 0 && timers.recent.length === 0) {
    html += `<div class="empty-state">
      <div class="empty-icon">&#9201;</div>
      <div class="empty-text">No timers yet.<br>Start one above or say<br><strong>"Hey Siri, Quick Timer"</strong></div>
    </div>`;
  }

  html += '</div>';
  return html;
}

function startTimerCountdown() {
  if (timerCountdownInterval) clearInterval(timerCountdownInterval);
  timerCountdownInterval = setInterval(() => {
    document.querySelectorAll('.timer-countdown[data-expires]').forEach(el => {
      const expiresAt = parseInt(el.dataset.expires);
      const secondsLeft = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      el.textContent = formatCountdown(secondsLeft);
      if (secondsLeft === 0) el.closest('.timer-card')?.classList.add('timer-card-expired');
    });
  }, 1000);
}

function bindTimerEvents() {
  document.querySelectorAll('.timer-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mins = parseInt(btn.dataset.minutes);
      document.getElementById('timer-minutes').value = mins;
      document.getElementById('timer-seconds').value = 0;
    });
  });

  document.getElementById('btn-enable-push')?.addEventListener('click', async () => {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      await subscribeToPush(auth.currentUser.uid);
      render();
    }
  });

  document.getElementById('btn-start-timer')?.addEventListener('click', async () => {
    const label = (document.getElementById('timer-label-input').value.trim()) || 'Timer';
    const mins = parseInt(document.getElementById('timer-minutes').value) || 0;
    const secs = parseInt(document.getElementById('timer-seconds').value) || 0;
    const totalSeconds = mins * 60 + secs;

    if (totalSeconds < 5) { alert('Please set a duration of at least 5 seconds.'); return; }

    const btn = document.getElementById('btn-start-timer');
    btn.disabled = true; btn.textContent = 'Starting…';

    try {
      const apiToken = await getApiToken();
      const r = await fetch('/api/startTimer', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, duration: `${totalSeconds} seconds` })
      });
      const result = await r.json();
      if (!result.success) throw new Error(result.error || 'Failed');
      document.getElementById('timer-label-input').value = '';
      document.getElementById('timer-minutes').value = '';
      document.getElementById('timer-seconds').value = '';
    } catch (err) {
      alert('Could not start timer: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Start Timer';
    }
  });

  document.querySelector('.timers-page')?.addEventListener('click', async e => {
    const cancelBtn = e.target.closest('.timer-cancel-btn');
    if (!cancelBtn) return;
    const timerId = cancelBtn.dataset.id;
    cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…';
    try {
      const apiToken = await getApiToken();
      await fetch('/api/cancelTimer', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timerId })
      });
    } catch (err) {
      cancelBtn.disabled = false; cancelBtn.textContent = 'Cancel';
    }
  });
}
