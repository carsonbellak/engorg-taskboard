// ipc/desktop-mode.js
//
// Desktop mode — the app window acts as the Windows desktop: it fills the primary
// monitor's work area, sits BEHIND every other app window (but above the wallpaper),
// stays fully interactive (click and type straight into it), and comes forward when you
// "Show desktop" (Win+D / the taskbar corner).
//
// Technique (Rainmeter's "On Desktop" approach, via koffi → user32 — no native build):
//   • The window stays a normal TOP-LEVEL window, so input, DPI scaling and the acrylic
//     backdrop all keep working exactly as in normal mode.
//   • Its OWNER is set to Progman (the desktop window). An owned window is always kept
//     above its owner, so pushing it to HWND_BOTTOM parks it just above the wallpaper.
//   • WM_WINDOWPOSCHANGING is hooked to add SWP_NOZORDER, so clicking the board focuses
//     it without lifting it over your other windows. Our own z-moves pause the hook.
//   • A light 400 ms poll watches the foreground window: when the desktop itself comes
//     forward (Show desktop) the board is lifted above it, and when an app takes focus
//     again it drops back to the bottom. The same poll re-owns the window if Explorer
//     restarts. A minimize (Win+M) is undone immediately.
//   • Ctrl+Alt+D (global, registered only while active) turns desktop mode off from
//     anywhere — the escape hatch if the board is ever unreachable.
//
// Why not re-parent into WorkerW/Progman like Wallpaper Engine (this module's first
// version)? A re-parented window lives inside the shell's desktop layer: the icon view
// (SHELLDLL_DefView) sits over it and takes every click, so nothing is interactive; DWM
// stops compositing it as a top-level window; and GetParent() returns 0 for a
// re-parented window that lacks WS_CHILD, which made a watchdog re-parent it every few
// seconds (visible flashing). Also note Electron implements resizable:false as
// min = max = the current size, so the window must be sized BEFORE it's locked.
//
// "Keep a normal window too" (`separate`): instead of turning the main window into the
// desktop, a second app window (index.html?embedded=1&desktop=1 — embedded so it doesn't
// duplicate the main window's background services) is created and attached, and the main
// window stays a normal app window. Closing the main window then only hides it (a relaunch
// brings it back); closing the desktop window turns desktop mode off.
//
// On/off is persisted by main in appdata/desktop_mode.json — device-local, never synced,
// and never written by the renderer, so a stale renderer settings save can't re-enable it.

const { app, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const STATE_FILE = path.join(config.DATA_DIR, 'desktop_mode.json');
const ESCAPE_ACCEL = 'CommandOrControl+Alt+D';

const WM_WINDOWPOSCHANGING = 0x0046;
const SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010;
const HWND_TOP = 0, HWND_BOTTOM = 1;
const GWLP_HWNDPARENT = -8; // on a top-level window this sets the OWNER (not the parent)
const GW_OWNER = 4;

// WINDOWPOS { HWND hwnd; HWND hwndInsertAfter; int x, y, cx, cy; UINT flags; }
const PTR = process.arch === 'ia32' ? 4 : 8;
const WP_FLAGS_OFFSET = PTR * 2 + 16;

let getWin = null;
let makeDeskWin = null; // main.js factory for the separate desktop window (registerDesktopMode opts)
let deskWin = null;     // the separate desktop window, when "keep a normal window too" is on
let separate = false;   // mirror of the persisted `separate` pref
let quitting = false;
let fns = null;
let ffiBroken = false;
let active = false;
let saved = null;       // { bounds, expanded, normalBounds } from before attaching
let hooked = false;
let poll = null;
let onMinimize = null;
let lifted = false;     // currently raised above other windows (desktop is showing)
let lastFg = 0;
let lockHits = 0;       // z-order changes the hook has blocked (diagnostics)

// ── FFI ────────────────────────────────────────────────────────────────────────────
// HWNDs are modelled as uintptr_t (plain JS numbers — window handles and user-mode
// addresses both fit well inside 2^53). __stdcall is honoured on 32-bit builds and
// ignored on x64/arm64, so these prototypes are correct on every Electron arch.
function loadFfi() {
  if (fns) return fns;
  if (ffiBroken || process.platform !== 'win32') return null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    fns = {
      FindWindowW: user32.func('uintptr_t __stdcall FindWindowW(str16 cls, str16 win)'),
      SetOwnerRaw: PTR === 8
        ? user32.func('intptr_t __stdcall SetWindowLongPtrW(uintptr_t hWnd, int index, intptr_t value)')
        : user32.func('long __stdcall SetWindowLongW(uintptr_t hWnd, int index, long value)'),
      GetWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, unsigned int cmd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(uintptr_t hWnd)'),
      GetForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, void *buf, int max)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t after, int x, int y, int cx, int cy, unsigned int flags)'),
      // RtlMoveMemory both ways — to read and patch the WINDOWPOS a WM_WINDOWPOSCHANGING points at.
      ReadMem: kernel32.func('void __stdcall RtlMoveMemory(void *dst, uintptr_t src, size_t len)'),
      WriteMem: kernel32.func('void __stdcall RtlMoveMemory(uintptr_t dst, void *src, size_t len)'),
    };
    return fns;
  } catch (e) {
    console.warn('[DesktopMode] FFI unavailable:', e.message);
    ffiBroken = true;
    return null;
  }
}

const supported = () => process.platform === 'win32' && !!loadFfi();

// The window that acts as the desktop: the main window itself, or — in "separate" mode —
// a second, dedicated app window, so the normal app window keeps working alongside it.
function target() {
  if (separate) return deskWin && !deskWin.isDestroyed() ? deskWin : null;
  return getWin && getWin();
}

// Create the separate desktop window (hidden until it has painted).
function openDeskWin() {
  if (deskWin && !deskWin.isDestroyed()) return Promise.resolve(deskWin);
  if (!makeDeskWin) return Promise.resolve(null);
  const win = makeDeskWin();
  deskWin = win;
  // Closing it (e.g. Window → Close from inside it) turns desktop mode off; quitting doesn't.
  win.on('close', (e) => { if (quitting) return; e.preventDefault(); setEnabled(false); });
  win.on('closed', () => { if (deskWin === win) deskWin = null; });
  return new Promise((resolve) => {
    const done = () => resolve(win.isDestroyed() ? null : win);
    win.webContents.once('did-finish-load', done);
    setTimeout(done, 8000);
  });
}

// Native HWND of a BrowserWindow (the buffer holds the handle value itself).
function hwndOf(win) {
  return readPtr(win.getNativeWindowHandle(), 0);
}
function readPtr(buf, off) {
  return PTR === 8 ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off);
}

function isDesktopWindow(h) {
  if (!h) return false;
  const b = Buffer.alloc(128);
  const n = fns.GetClassNameW(h, b, 64);
  const cls = b.toString('utf16le', 0, n * 2);
  return cls === 'Progman' || cls === 'WorkerW';
}

// ── Z-order lock ───────────────────────────────────────────────────────────────────
// Runs synchronously inside the window procedure. It only ever ORs SWP_NOZORDER into
// the flags, and only after confirming the WINDOWPOS really is ours (its hwnd field
// matches) — anything unexpected and it leaves the message untouched.
function onWindowPosChanging(_wParam, lParam) {
  try {
    const win = target();
    if (!active || !fns || !win || win.isDestroyed()) return;
    const addr = readPtr(lParam, 0);
    if (!addr) return;
    const wp = Buffer.alloc(WP_FLAGS_OFFSET + 4);
    fns.ReadMem(wp, addr, wp.length);
    if (readPtr(wp, 0) !== hwndOf(win)) return;
    const flags = wp.readUInt32LE(WP_FLAGS_OFFSET);
    if (flags & SWP_NOZORDER) return;
    // While the desktop itself is in front (Show desktop), let the board come forward
    // with it — that's exactly when it should be visible.
    if (isDesktopWindow(fns.GetForegroundWindow())) return;
    const patched = Buffer.alloc(4);
    patched.writeUInt32LE((flags | SWP_NOZORDER) >>> 0, 0);
    fns.WriteMem(addr + WP_FLAGS_OFFSET, patched, 4);
    lockHits++;
  } catch (_) { /* never throw inside the window procedure */ }
}

function setHook(win, on) {
  if (on && !hooked) {
    win.hookWindowMessage(WM_WINDOWPOSCHANGING, onWindowPosChanging);
    hooked = true;
  } else if (!on && hooked) {
    try { win.unhookWindowMessage(WM_WINDOWPOSCHANGING); } catch (_) {}
    hooked = false;
  }
}

// Our own Win32 window calls run with the hook paused, so the hook never re-enters
// while an FFI call is in flight (and never blocks our deliberate moves).
function withHookPaused(win, fn) {
  const was = hooked;
  if (was) setHook(win, false);
  try { return fn(); } finally { if (was) setHook(win, true); }
}

function setOwner(hwnd, owner) {
  fns.SetOwnerRaw(hwnd, GWLP_HWNDPARENT, owner);
}

function zMove(win, after) {
  withHookPaused(win, () =>
    fns.SetWindowPos(hwndOf(win), after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE));
}
const raise = (win) => { zMove(win, HWND_TOP); lifted = true; };
const lower = (win) => { zMove(win, HWND_BOTTOM); lifted = false; };

// ── Show-desktop / Explorer-restart watcher ──────────────────────────────────────────
function tick() {
  const win = target();
  if (!active || !fns || !win || win.isDestroyed()) return;
  try {
    const me = hwndOf(win);
    // Explorer restarted → the old Progman (our owner) is gone; re-own to the new one.
    const owner = fns.GetWindow(me, GW_OWNER);
    if (!owner || !fns.IsWindow(owner)) {
      const pm = fns.FindWindowW('Progman', null);
      if (pm) withHookPaused(win, () => setOwner(me, pm));
    }
    const fg = fns.GetForegroundWindow();
    if (fg === lastFg) return;
    lastFg = fg;
    if (!fg || fg === me) return;
    if (isDesktopWindow(fg)) { if (!lifted) raise(win); }
    else if (lifted) lower(win);
  } catch (_) {}
}

// ── Attach / detach ──────────────────────────────────────────────────────────────────
// Fill the primary monitor's work area (everything but the taskbar). Electron treats
// resizable:false as min = max = current size, so unlock → size → relock.
function fitToWorkArea(win) {
  win.setResizable(true);
  win.setBounds(screen.getPrimaryDisplay().workArea);
  win.setResizable(false);
}

function notify(win, on) {
  try { win.webContents.send('desktop:changed', on); } catch (_) {}
}

async function attach() {
  if (!supported()) return { ok: false, error: 'Desktop mode needs Windows.' };
  if (separate && !target()) await openDeskWin();
  const win = target();
  if (!win || win.isDestroyed()) return { ok: false, error: 'No app window.' };
  if (active) { fitToWorkArea(win); return { ok: true }; }
  const progman = fns.FindWindowW('Progman', null);
  if (!progman) return { ok: false, error: 'Could not find the Windows desktop window.' };

  saved = { bounds: win.getBounds(), expanded: !!win._expanded, normalBounds: win._normalBounds };
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  win._expanded = false;
  win._desktopMode = true; // ipc/window.js ignores minimize / expand / fullscreen while set

  fitToWorkArea(win);
  win.setMovable(false);
  win.setMinimizable(false);
  win.setMaximizable(false);
  win.setFullScreenable(false);

  const me = hwndOf(win);
  setOwner(me, progman);
  fns.SetWindowPos(me, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  if (!win.isVisible()) {
    // The separate desktop window starts hidden; show it without stealing focus, then
    // park it back at the bottom in case showing nudged it up.
    win.showInactive();
    fns.SetWindowPos(me, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  lifted = false;
  lastFg = 0;

  active = true;
  setHook(win, true);
  onMinimize = () => setImmediate(() => {
    if (active && !win.isDestroyed() && win.isMinimized()) win.restore();
  });
  win.on('minimize', onMinimize);
  poll = setInterval(tick, 400);
  try {
    if (!globalShortcut.isRegistered(ESCAPE_ACCEL)) globalShortcut.register(ESCAPE_ACCEL, () => setEnabled(false));
  } catch (_) {}
  notify(win, true);
  return { ok: true };
}

function stopRuntime(win) {
  if (poll) { clearInterval(poll); poll = null; }
  try { globalShortcut.unregister(ESCAPE_ACCEL); } catch (_) {}
  if (win && !win.isDestroyed()) {
    if (onMinimize) win.removeListener('minimize', onMinimize);
    setHook(win, false);
  }
  onMinimize = null;
  lifted = false;
}

function detach() {
  const win = target();
  const wasActive = active;
  stopRuntime(win);
  active = false;

  // Separate mode: the desktop window simply goes away; bring the normal window back if
  // it was tucked away (closing it while the desktop was up only hides it).
  if (separate) {
    if (win && !win.isDestroyed()) win.destroy();
    deskWin = null;
    saved = null;
    const main = getWin && getWin();
    if (wasActive && main && !main.isDestroyed()) {
      if (!main.isVisible()) main.show();
      main.focus();
    }
    return { ok: true };
  }

  if (!wasActive || !win || win.isDestroyed()) return { ok: true };

  win._desktopMode = false;
  try { setOwner(hwndOf(win), 0); } catch (_) {}
  win.setResizable(true);
  win.setMovable(true);
  win.setMinimizable(true);
  win.setMaximizable(true);
  win.setFullScreenable(true);
  if (saved) {
    win.setBounds(saved.bounds);
    win._expanded = saved.expanded;
    win._normalBounds = saved.normalBounds;
  }
  saved = null;
  if (win.isVisible()) { win.moveTop(); win.focus(); }
  notify(win, false);
  return { ok: true };
}

// ── Persistence (main-owned) ───────────────────────────────────────────────────────────
// { enabled, separate } — `separate` = "keep a normal window too": the desktop runs in its
// own second window instead of turning the main window into the desktop.
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return { enabled: s.enabled === true, separate: s.separate === true };
  } catch (_) { return { enabled: false, separate: false }; }
}
const readPersisted = () => readState().enabled;
function writeState(patch) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch })); }
  catch (e) { console.warn('[DesktopMode] could not save state:', e.message); }
}

async function setEnabled(on) {
  const res = on ? await attach() : detach();
  if (res.ok) writeState({ enabled: !!on });
  return { ...res, active, separate };
}

// Switch between "the app window is the desktop" and "desktop + a normal window". If
// desktop mode is on, it's re-attached in the new arrangement right away.
async function setSeparate(on) {
  on = !!on;
  if (on === separate) return { ok: true, active, separate };
  const wasActive = active;
  if (wasActive) detach();
  separate = on;
  writeState({ separate: on });
  let res = { ok: true };
  if (wasActive) res = await attach();
  if (wasActive && !res.ok) writeState({ enabled: false });
  return { ...res, active, separate };
}

// ── Registration ───────────────────────────────────────────────────────────────────────
// opts.createDesktopWindow() → a hidden BrowserWindow for separate mode (main.js owns
// window construction so both windows share webPreferences and handlers).
function registerDesktopMode(getMainWindow, opts = {}) {
  getWin = getMainWindow;
  makeDeskWin = opts.createDesktopWindow || null;
  separate = readState().separate;

  // `here` = the asking window is the one acting as the desktop (its titlebar hides the
  // window controls); `active` = desktop mode is on at all (the Settings toggle).
  ipcMain.handle('desktop:status', (e) => {
    const w = target();
    const here = active && !!w && !w.isDestroyed() && w.webContents === e.sender;
    return { supported: supported(), active, here, enabled: readPersisted(), separate };
  });
  ipcMain.handle('desktop:setEnabled', (_e, on) => setEnabled(!!on));
  ipcMain.handle('desktop:setSeparate', (_e, on) => setSeparate(!!on));

  // Keep it fitted to the primary work area as displays / scaling / the taskbar change.
  const refit = () => {
    const w = target();
    if (active && w && !w.isDestroyed()) fitToWorkArea(w);
  };
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { try { globalShortcut.unregister(ESCAPE_ACCEL); } catch (_) {} });
}

// Called from main.js once the window exists: re-enter desktop mode if it was left on.
// (In separate mode the desktop window is created after the main window has loaded, so
// the main renderer — which runs the background services — boots first.)
registerDesktopMode.startupAttach = function startupAttach() {
  if (!readPersisted() || !supported()) return;
  const win = getWin && getWin();
  if (!win) return;
  const go = () => setTimeout(async () => {
    const r = await attach();
    if (!r.ok) console.warn('[DesktopMode] startup attach failed:', r.error);
  }, 400);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go);
  else go();
};

// A second launch while in desktop mode brings the board forward (until another app
// takes focus, when the watcher drops it back to the bottom).
registerDesktopMode.reveal = function reveal() {
  const win = target();
  if (!active || !win || win.isDestroyed()) return;
  raise(win);
  win.focus();
};

registerDesktopMode.isActive = () => active;
// True while the desktop lives in its own window, alongside the normal app window.
registerDesktopMode.hasSeparateWindow = () => active && separate && !!target();
registerDesktopMode.attach = attach;
registerDesktopMode.detach = detach;
registerDesktopMode._debug = () => ({ lockHits, lifted, hooked, PTR, WP_FLAGS_OFFSET, separate });

module.exports = registerDesktopMode;
