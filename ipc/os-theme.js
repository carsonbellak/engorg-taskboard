// IPC handlers: osTheme:* — make Windows itself match the app's current theme.
// Two modes, both reversible, both Windows-only (no-op elsewhere):
//
//   ACCENT  (osTheme:apply)  — sets the Windows accent COLOUR (used for highlights,
//     selected items, links, toggles) + dark/light mode to match the theme. We keep
//     ColorPrevalence OFF so the accent stays a highlight and does NOT flood Start /
//     taskbar / title-bar backgrounds (which would turn all of Windows the accent
//     colour). Light-touch; leaves the rest of Windows alone. Keys under HKCU:
//       - DWM\{AccentColor,AccentColorInactive,ColorizationColor,
//         ColorizationAfterglow,ColorPrevalence,EnableWindowColorization}
//       - Themes\Personalize\{ColorPrevalence,AppsUseLightTheme,SystemUsesLightTheme}
//       - Explorer\Accent\{AccentColorMenu,StartColorMenu,AccentPalette}
//     The registry is only Windows' *cache* of the accent — the shell reads the live
//     colour from uxtheme's immersive colour set, so registry writes alone don't show
//     until something forces a reload. We push the colour live with uxtheme's
//     SetUserColorPreference (exported by ordinal #122 only; #120 is its named twin
//     GetUserColorPreference) — the same call the Settings app makes — then broadcast
//     WM_SETTINGCHANGE("ImmersiveColorSet") so apps pick up dark/light.
//
//   TINTED  (osTheme:apply with payload.tint) — ACCENT plus ColorPrevalence ON, with
//     Start/taskbar (StartColorMenu / crStartColor) and title bars (DWM AccentColor)
//     set to deep shades of the theme (background × accent, luminance-capped), so
//     Windows reads as the theme without being flooded by the raw accent. System
//     mode is forced dark (the taskbar shows no colour in light mode).
//
//   CONTRAST (osTheme:applyContrast) — the fullest match. Generates a Windows
//     *contrast theme* from the app's whole palette (background, text, links,
//     selection, buttons) by writing HKCU\Control Panel\Colors and turning on
//     Windows high-contrast mode via SystemParametersInfo(SPI_SETHIGHCONTRAST).
//     NOT wired to any UI (it force-flattens every app — see memory
//     windows-os-theming); still PowerShell, kept as a capability.
//
// Speed: accent/restore/snapshot call Win32 directly through koffi (registry +
// uxtheme + user32, same as ipc/desktop-mode.js) — no powershell.exe spawn and no
// Add-Type C# compile per apply, which is what used to lag the PC for seconds. The
// slow, broadcast-y calls run on koffi's worker thread (.async) so the main process
// never blocks; requests are serialised and a newer apply supersedes queued ones.
// Each step reports `osTheme:progress` { pct, label } to the requesting window.
//
// Reversibility: the FIRST apply of EITHER mode snapshots everything we might
// touch (accent keys, dark/light, Control Panel\Colors, and the high-contrast
// on/off state + scheme) to appdata/windows_accent_backup.json. osTheme:restore
// writes it back (only what actually differs — re-toggling high contrast or
// rewriting system colours forces every app to repaint), and removes the backup.
const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const BACKUP_FILE = path.join(DATA_DIR, 'windows_accent_backup.json');
// Diagnostic: what the last apply pushed (mode + colours + whether the live push worked).
const LAST_FILE = path.join(DATA_DIR, 'os_theme_last.json');

// Sub-keys of HKEY_CURRENT_USER.
const K_DWM    = 'Software\\Microsoft\\Windows\\DWM';
const K_PERS   = 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const K_ACC    = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent';
const K_COLORS = 'Control Panel\\Colors';
const K_HC     = 'Control Panel\\Accessibility\\HighContrast';
// PowerShell (contrast path) spellings of the same keys.
const REG_PERS   = 'HKCU:\\' + K_PERS;
const REG_COLORS = 'HKCU:\\' + K_COLORS;
const REG_HC     = 'HKCU:\\' + K_HC;

// ── colour maths (done here so the writers just store values) ───────────────
const clamp8 = (n) => Math.max(0, Math.min(255, Math.round(n)));
// amt > 0 darkens toward black, amt < 0 lightens toward white.
function shade({ r, g, b }, amt) {
  if (amt >= 0) return { r: clamp8(r * (1 - amt)), g: clamp8(g * (1 - amt)), b: clamp8(b * (1 - amt)) };
  const a = -amt;
  return { r: clamp8(r + (255 - r) * a), g: clamp8(g + (255 - g) * a), b: clamp8(b + (255 - b) * a) };
}
// DWM AccentColor / Explorer AccentColorMenu use 0xAABBGGRR (ABGR, alpha 0xFF).
const abgr = ({ r, g, b }, a = 0xff) => (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
// DWM ColorizationColor / Afterglow use 0xAARRGGBB (ARGB).
const argb = ({ r, g, b }, a = 0xc4) => (((a << 24) | (r << 16) | (g << 8) | b) >>> 0);
// Linear blend of two colours (t = 0 → c1, t = 1 → c2).
const mix = (c1, c2, t) => ({
  r: clamp8(c1.r + (c2.r - c1.r) * t),
  g: clamp8(c1.g + (c2.g - c1.g) * t),
  b: clamp8(c1.b + (c2.b - c1.b) * t),
});
// Control Panel\Colors stores each colour as a "R G B" REG_SZ string.
const triplet = ({ r, g, b }) => `${clamp8(r)} ${clamp8(g)} ${clamp8(b)}`;
const hex = ({ r, g, b }) => '#' + [r, g, b].map((n) => clamp8(n).toString(16).padStart(2, '0')).join('');

// 8-shade accent palette (lightest → darkest), base at index 3 — the layout the
// Windows personalization colour palette uses. 4th byte is 0 (as the shell stores it).
function paletteBytes(base) {
  const amts = [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.75];
  const out = [];
  for (const a of amts) {
    const s = shade(base, a);
    out.push(s.r, s.g, s.b, 0x00);
  }
  return out; // 32 bytes
}

// Scale a colour down until its (approximate) relative luminance is <= max.
function capLuma(c, max) {
  const l = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  if (l <= max || l === 0) return c;
  const k = max / l;
  return { r: clamp8(c.r * k), g: clamp8(c.g * k), b: clamp8(c.b * k) };
}

// TINTED mode surface colours. Start/taskbar only show colour while Windows' system
// mode is dark, so `start` is always a deep shade: a dark theme's own background
// blended with its accent, or (light themes) a near-black blended with it. Title bars
// get the theme header with a touch of accent — deep on dark themes, pastel on light.
// Never the raw accent: that's what flooded Windows bright green before.
function tintColors(base, tint, isDark) {
  const bg = normalizeRgb(tint && tint.bg) || base;
  const header = normalizeRgb(tint && tint.header) || bg;
  const start = capLuma(mix(isDark ? bg : { r: 28, g: 28, b: 34 }, base, isDark ? 0.32 : 0.4), 0.2);
  const title = isDark ? capLuma(mix(header, base, 0.3), 0.24) : mix(header, base, 0.18);
  return { start, title };
}
// Accent palette whose dark end leans into the tinted surface colour.
function paletteBytesTinted(base, start) {
  const shades = [shade(base, -0.6), shade(base, -0.4), shade(base, -0.2), base,
    shade(base, 0.2), mix(start, base, 0.15), start, shade(start, 0.3)];
  const out = [];
  for (const c of shades) out.push(c.r, c.g, c.b, 0x00);
  return out;
}

function normalizeRgb(rgb) {
  if (!rgb || typeof rgb !== 'object') return null;
  const r = clamp8(rgb.r), g = clamp8(rgb.g), b = clamp8(rgb.b);
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  return { r, g, b };
}

// ── native bindings (lazy; koffi → advapi32 / user32 / uxtheme) ─────────────
const HKCU = -2147483647;            // (HKEY)(LONG)0x80000001, sign-extended on x64
const REG_SZ = 1, REG_BINARY = 3, REG_DWORD = 4;
const RRF_RT_ANY = 0x0000ffff;
const KEY_READ_WRITE = 0x2001f;      // KEY_READ | KEY_WRITE
const HWND_BROADCAST = 0xffff;
const WM_SETTINGCHANGE = 0x001a, WM_SYSCOLORCHANGE = 0x0015;
const SMTO_ABORTIFHUNG = 0x0002;
const SPI_GETHIGHCONTRAST = 0x0042, SPI_SETHIGHCONTRAST = 0x0043;
const HCF_HIGHCONTRASTON = 0x1;

let _native = null;
function native() {
  if (_native) return _native;
  const koffi = require('koffi');
  const adv = koffi.load('advapi32.dll');
  const user32 = koffi.load('user32.dll');
  const ux = koffi.load('uxtheme.dll');
  const PREF = koffi.struct('ENG_IMMERSIVE_COLOR_PREFERENCE', { crStartColor: 'uint32_t', crAccentColor: 'uint32_t' });
  const HC = koffi.struct('ENG_HIGHCONTRASTW', { cbSize: 'uint32_t', dwFlags: 'uint32_t', lpszDefaultScheme: 'str16' });
  _native = {
    koffi, HC,
    RegGetValueW: adv.func('long __stdcall RegGetValueW(intptr_t hKey, str16 sub, str16 val, uint32_t flags, _Out_ uint32_t *type, void *data, _Inout_ uint32_t *cb)'),
    RegCreateKeyExW: adv.func('long __stdcall RegCreateKeyExW(intptr_t hKey, str16 sub, uint32_t res, str16 cls, uint32_t opts, uint32_t sam, void *sec, _Out_ intptr_t *out, _Out_ uint32_t *disp)'),
    RegSetValueExW: adv.func('long __stdcall RegSetValueExW(intptr_t hKey, str16 name, uint32_t res, uint32_t type, void *data, uint32_t cb)'),
    RegCloseKey: adv.func('long __stdcall RegCloseKey(intptr_t hKey)'),
    RegDeleteKeyValueW: adv.func('long __stdcall RegDeleteKeyValueW(intptr_t hKey, str16 sub, str16 val)'),
    SendMessageTimeoutW: user32.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t hWnd, uint32_t msg, uintptr_t w, str16 l, uint32_t flags, uint32_t timeout, void *res)'),
    SystemParametersInfoW: user32.func('__stdcall', 'SystemParametersInfoW', 'bool', ['uint32_t', 'uint32_t', koffi.inout(koffi.pointer(HC)), 'uint32_t']),
    // Ordinal-only export (see header). Binding resolves the address only; it's
    // never called unless we're applying/restoring a colour.
    SetUserColorPreference: (() => { try { return ux.func('__stdcall', 122, 'long', [koffi.pointer(PREF), 'bool']); } catch { return null; } })(),
  };
  return _native;
}

// Run a bound function on koffi's worker thread so the main process stays responsive.
const callAsync = (fn, ...args) => new Promise((resolve, reject) => {
  fn.async(...args, (err, res) => (err ? reject(err) : resolve(res)));
});

function regRead(sub, name) {
  const n = native();
  const type = [0], cb = [0];
  if (n.RegGetValueW(HKCU, sub, name, RRF_RT_ANY, type, null, cb) !== 0) return null;
  const buf = Buffer.alloc(Math.max(cb[0], 4));
  if (n.RegGetValueW(HKCU, sub, name, RRF_RT_ANY, type, buf, cb) !== 0) return null;
  const data = buf.subarray(0, cb[0]);
  if (type[0] === REG_DWORD) return data.length >= 4 ? data.readUInt32LE(0) : null;
  if (type[0] === REG_BINARY) return Array.from(data);
  if (type[0] === REG_SZ || type[0] === 2 /* REG_EXPAND_SZ */) return data.toString('utf16le').replace(/\0+$/, '');
  return null;
}
function regWrite(sub, name, type, buf) {
  const n = native();
  const hk = [0], disp = [0];
  const rc = n.RegCreateKeyExW(HKCU, sub, 0, null, 0, KEY_READ_WRITE, null, hk, disp);
  if (rc !== 0) throw new Error(`RegCreateKeyEx ${sub} failed (${rc})`);
  try {
    const w = n.RegSetValueExW(hk[0], name, 0, type, buf, buf.length);
    if (w !== 0) throw new Error(`RegSetValueEx ${name} failed (${w})`);
  } finally { n.RegCloseKey(hk[0]); }
}
function writeDword(sub, name, v) {
  const b = Buffer.alloc(4); b.writeUInt32LE((Number(v) >>> 0), 0);
  regWrite(sub, name, REG_DWORD, b);
}
const writeBinary = (sub, name, bytes) => regWrite(sub, name, REG_BINARY, Buffer.from(bytes.map((x) => x & 0xff)));
const writeString = (sub, name, s) => regWrite(sub, name, REG_SZ, Buffer.from(String(s) + '\0', 'utf16le'));
const deleteValue = (sub, name) => { try { native().RegDeleteKeyValueW(HKCU, sub, name); } catch {} };

function getHighContrast() {
  const n = native();
  const hc = { cbSize: n.koffi.sizeof(n.HC), dwFlags: 0, lpszDefaultScheme: null };
  if (!n.SystemParametersInfoW(SPI_GETHIGHCONTRAST, hc.cbSize, hc, 0)) return null;
  return { on: (hc.dwFlags & HCF_HIGHCONTRASTON) !== 0, flags: hc.dwFlags, scheme: hc.lpszDefaultScheme || '' };
}
async function setHighContrast(on, scheme) {
  const n = native();
  const cur = getHighContrast() || { flags: 0x2, scheme: '' };
  const hc = {
    cbSize: n.koffi.sizeof(n.HC),
    dwFlags: on ? (cur.flags | HCF_HIGHCONTRASTON) : (cur.flags & ~HCF_HIGHCONTRASTON),
    lpszDefaultScheme: scheme || cur.scheme || 'Night sky',
  };
  // SPIF_UPDATEINIFILE | SPIF_SENDCHANGE — this repaints everything, so it's async.
  await callAsync(n.SystemParametersInfoW, SPI_SETHIGHCONTRAST, hc.cbSize, hc, 0x3);
}

// Push the accent into the live immersive colour set. start/accent are ABGR.
async function pushUserColor(start, accent) {
  const n = native();
  if (!n.SetUserColorPreference) return false;
  try {
    await callAsync(n.SetUserColorPreference, { crStartColor: start >>> 0, crAccentColor: accent >>> 0 }, true);
    return true;
  } catch { return false; }
}

// Broadcast without letting one hung window stall us (worker thread + abort-if-hung).
async function broadcast(msg, lParam) {
  try { await callAsync(native().SendMessageTimeoutW, HWND_BROADCAST, msg, 0, lParam, SMTO_ABORTIFHUNG, 1000, null); } catch {}
}

// ── snapshot ────────────────────────────────────────────────────────────────
// The Control Panel\Colors entries the contrast path writes (only these are snapshotted).
const COLOR_NAMES = [
  'Window', 'WindowText', 'WindowFrame', 'Background', 'ButtonFace', 'ButtonText', 'ButtonShadow',
  'ButtonHilight', 'ButtonDkShadow', 'ButtonLight', 'ButtonAlternateFace', 'GrayText', 'Hilight',
  'HilightText', 'HotTrackingColor', 'ActiveTitle', 'TitleText', 'GradientActiveTitle', 'InactiveTitle',
  'InactiveTitleText', 'GradientInactiveTitle', 'ActiveBorder', 'InactiveBorder', 'AppWorkspace', 'Menu',
  'MenuText', 'MenuBar', 'MenuHilight', 'Scrollbar', 'InfoText', 'InfoWindow',
];

// Same JSON shape the old PowerShell snapshot wrote, so existing backups restore.
function takeSnapshot() {
  const colors = {};
  for (const nm of COLOR_NAMES) { const v = regRead(K_COLORS, nm); if (v != null) colors[nm] = v; }
  const hc = getHighContrast();
  return {
    DWM_AccentColor: regRead(K_DWM, 'AccentColor'),
    DWM_AccentColorInactive: regRead(K_DWM, 'AccentColorInactive'),
    DWM_ColorizationColor: regRead(K_DWM, 'ColorizationColor'),
    DWM_ColorizationAfterglow: regRead(K_DWM, 'ColorizationAfterglow'),
    DWM_ColorPrevalence: regRead(K_DWM, 'ColorPrevalence'),
    DWM_EnableWindowColorization: regRead(K_DWM, 'EnableWindowColorization'),
    Personalize_ColorPrevalence: regRead(K_PERS, 'ColorPrevalence'),
    Personalize_AppsUseLightTheme: regRead(K_PERS, 'AppsUseLightTheme'),
    Personalize_SystemUsesLightTheme: regRead(K_PERS, 'SystemUsesLightTheme'),
    Accent_AccentColorMenu: regRead(K_ACC, 'AccentColorMenu'),
    Accent_StartColorMenu: regRead(K_ACC, 'StartColorMenu'),
    Accent_AccentPalette: regRead(K_ACC, 'AccentPalette'),
    Colors: colors,
    HC_Flags: regRead(K_HC, 'Flags'),
    HC_Scheme: hc ? hc.scheme : regRead(K_HC, 'High Contrast Scheme'),
    HC_On: hc ? hc.on : false,
  };
}

// Take the one-time snapshot before the first apply of any mode.
function ensureSnapshot() {
  if (fs.existsSync(BACKUP_FILE)) return false;
  const snap = takeSnapshot();
  try { fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(snap), 'utf8');
  return true;
}

// ── ACCENT / TINTED mode ────────────────────────────────────────────────────
// tint = null → ACCENT (highlights only). tint = { bg, header } → TINTED: Start,
// taskbar and title bars are also coloured (deep theme shades, see tintColors).
async function applyAccent(base, isDark, progress, tint) {
  progress(10, 'Preparing…');
  if (ensureSnapshot()) progress(20, 'Saved your current Windows colors');
  const tc = tint ? tintColors(base, tint, isDark) : null;
  const title = tc ? tc.title : base;           // DWM title-bar / border colour
  const startC = tc ? tc.start : shade(base, 0.2);
  const acm = abgr(base);
  const scm = abgr(startC);
  const mode = isDark ? 0 : 1; // AppsUseLightTheme/SystemUsesLightTheme: 1 = light, 0 = dark
  const prevalence = tc ? 1 : 0;
  const writeDwm = () => {
    writeDword(K_DWM, 'AccentColor', abgr(title));
    writeDword(K_DWM, 'AccentColorInactive', abgr(shade(title, 0.15)));
    writeDword(K_DWM, 'ColorizationColor', argb(title));
    writeDword(K_DWM, 'ColorizationAfterglow', argb(title));
    // ACCENT keeps ColorPrevalence OFF (0): the accent stays a *highlight* colour.
    // Turning it ON with the raw accent floods Start / taskbar / title bars (a vivid
    // accent like Neon green turned all of Windows that colour). TINTED turns it ON
    // but with the deep theme shades above, never the raw accent.
    writeDword(K_DWM, 'ColorPrevalence', prevalence);
    writeDword(K_DWM, 'EnableWindowColorization', 1);
  };

  progress(30, tc ? 'Writing theme colors for Start, taskbar + title bars…' : 'Writing accent color + dark/light mode…');
  writeDwm();
  writeDword(K_PERS, 'AppsUseLightTheme', mode);
  // Start/taskbar only show colour in dark system mode, so TINTED keeps it dark.
  writeDword(K_PERS, 'SystemUsesLightTheme', tc ? 0 : mode);
  writeDword(K_PERS, 'ColorPrevalence', prevalence);
  writeDword(K_ACC, 'AccentColorMenu', acm);
  writeDword(K_ACC, 'StartColorMenu', scm);
  writeBinary(K_ACC, 'AccentPalette', tc ? paletteBytesTinted(base, startC) : paletteBytes(base));

  progress(55, 'Updating the Windows accent…');
  // crStartColor drives the Start/taskbar fill (when prevalence is on), crAccentColor
  // the highlights. It may re-derive the DWM colours from the accent, so re-assert ours.
  const live = await pushUserColor(scm, acm);
  if (tc) writeDwm();
  try {
    fs.writeFileSync(LAST_FILE, JSON.stringify({
      at: new Date().toISOString(), mode: tc ? 'tinted' : 'accent', dark: isDark, livePush: live,
      accent: hex(base), start: hex(startC), title: hex(title),
    }, null, 1), 'utf8');
  } catch {}

  progress(80, 'Refreshing apps…');
  await broadcast(WM_SETTINGCHANGE, 'ImmersiveColorSet');
  progress(100, 'Windows theme updated');
}

// ── restore ─────────────────────────────────────────────────────────────────
async function restoreFromBackup(progress) {
  if (!fs.existsSync(BACKUP_FILE)) { progress(100, 'Nothing to restore'); return; }
  progress(10, 'Reading your saved Windows colors…');
  let j = null;
  try { j = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8').replace(/^﻿/, '')); } catch {}
  if (!j || typeof j !== 'object') throw new Error('Backup file is unreadable');

  progress(30, 'Restoring accent + dark/light mode…');
  const dword = (sub, name, v) => { if (v == null) deleteValue(sub, name); else writeDword(sub, name, v); };
  dword(K_DWM, 'AccentColor', j.DWM_AccentColor);
  dword(K_DWM, 'AccentColorInactive', j.DWM_AccentColorInactive);
  dword(K_DWM, 'ColorizationColor', j.DWM_ColorizationColor);
  dword(K_DWM, 'ColorizationAfterglow', j.DWM_ColorizationAfterglow);
  dword(K_DWM, 'ColorPrevalence', j.DWM_ColorPrevalence);
  dword(K_DWM, 'EnableWindowColorization', j.DWM_EnableWindowColorization);
  dword(K_PERS, 'ColorPrevalence', j.Personalize_ColorPrevalence);
  dword(K_PERS, 'AppsUseLightTheme', j.Personalize_AppsUseLightTheme);
  dword(K_PERS, 'SystemUsesLightTheme', j.Personalize_SystemUsesLightTheme);
  dword(K_ACC, 'AccentColorMenu', j.Accent_AccentColorMenu);
  dword(K_ACC, 'StartColorMenu', j.Accent_StartColorMenu);
  if (Array.isArray(j.Accent_AccentPalette)) writeBinary(K_ACC, 'AccentPalette', j.Accent_AccentPalette);
  else deleteValue(K_ACC, 'AccentPalette');

  // System colours: only rewrite entries that actually differ (accent mode never
  // touches them, so normally nothing is written and no repaint is forced).
  let colorsChanged = false;
  if (j.Colors && typeof j.Colors === 'object') {
    for (const [nm, v] of Object.entries(j.Colors)) {
      if (v == null) continue;
      if (regRead(K_COLORS, nm) !== String(v)) { writeString(K_COLORS, nm, v); colorsChanged = true; }
    }
  }
  if (colorsChanged) progress(45, 'Restored system colors');

  // High contrast: only toggle if it isn't already in the saved state — flipping it
  // forces a full repaint of every window, which is what made restores lag.
  const hc = getHighContrast();
  if (hc && hc.on !== !!j.HC_On) {
    progress(55, 'Restoring high-contrast state…');
    await setHighContrast(!!j.HC_On, j.HC_Scheme ? String(j.HC_Scheme) : '');
  }

  progress(70, 'Restoring the Windows accent…');
  if (j.Accent_StartColorMenu != null && j.Accent_AccentColorMenu != null) {
    await pushUserColor(j.Accent_StartColorMenu, j.Accent_AccentColorMenu);
  }

  progress(85, 'Refreshing apps…');
  if (colorsChanged) await broadcast(WM_SYSCOLORCHANGE, null);
  await broadcast(WM_SETTINGCHANGE, 'ImmersiveColorSet');
  try { fs.unlinkSync(BACKUP_FILE); } catch {}
  progress(100, 'Windows colors restored');
}

// ── CONTRAST mode (unwired; PowerShell) ─────────────────────────────────────
function runPowerShell(script, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || '').trim() || error.message)); return; }
      resolve((stdout || '').trim());
    });
  });
}

// C# source (assembled without a here-string to dodge indentation rules) that
// gives the contrast path SystemParametersInfo(SPI_SETHIGHCONTRAST) + broadcasts.
const HC_TYPE_PS = `
$engHcSrc = @(
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class EngHc {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
  '  public struct HIGHCONTRAST { public uint cbSize; public uint dwFlags; public string lpszDefaultScheme; }',
  '  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
  '  public static extern bool SystemParametersInfoW(uint a, uint b, ref HIGHCONTRAST c, uint d);',
  '  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]',
  '  public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);',
  '}'
) -join ([char]10);
try { Add-Type -TypeDefinition $engHcSrc -ErrorAction Stop } catch {}
function Set-HighContrast([bool]$on, [string]$scheme) {
  try {
    $hc = New-Object EngHc+HIGHCONTRAST;
    $hc.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type]'EngHc+HIGHCONTRAST');
    $hc.dwFlags = if ($on) { 0x1 -bor 0x2 } else { 0x2 };  # HCF_HIGHCONTRASTON | HCF_AVAILABLE
    if (-not $scheme) { $scheme = 'Night sky' }
    $hc.lpszDefaultScheme = $scheme;
    # SPI_SETHIGHCONTRAST = 0x0043 ; uiParam = sizeof(HIGHCONTRAST) ;
    # SPIF_UPDATEINIFILE | SPIF_SENDCHANGE = 0x3
    [EngHc]::SystemParametersInfoW(0x0043, $hc.cbSize, [ref]$hc, 0x3) | Out-Null;
  } catch {}
}
function Broadcast-ColorChange {
  try {
    $r = [UIntPtr]::Zero;
    [EngHc]::SendMessageTimeout([IntPtr]0xffff, 0x0015, [UIntPtr]::Zero, $null, 2, 3000, [ref]$r) | Out-Null;             # WM_SYSCOLORCHANGE
    [EngHc]::SendMessageTimeout([IntPtr]0xffff, 0x031A, [UIntPtr]::Zero, $null, 2, 3000, [ref]$r) | Out-Null;             # WM_THEMECHANGED
    [EngHc]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 3000, [ref]$r) | Out-Null; # WM_SETTINGCHANGE
  } catch {}
}
`;

// Map the app palette → the Windows system colours a contrast theme defines.
// High contrast drops gradients/effects and shows flat fills, so if we used the
// theme's *literal* (often near-neutral) background, Windows would read as grey
// and "colourless". Instead we infuse the theme accent into every surface so the
// contrast theme looks vividly themed — tinted window/menu/button fills, accent
// title bars + borders — while keeping text strongly contrasting for legibility.
function colorAssignments(p) {
  const { bg, bg2, text, muted, accent, accentText } = p;
  const surface1 = mix(bg, accent, 0.12);          // main window background (subtle tint)
  const surface2 = mix(bg2 || bg, accent, 0.24);   // buttons, menus, inactive title, scrollbars
  const gradient = mix(accent, bg, 0.35);          // title-bar gradient tail
  const WINDOW = triplet(surface1);
  const SURFACE = triplet(surface2);
  const GRAD = triplet(gradient);
  const TEXT = triplet(text);
  const MUTED = triplet(muted);
  const ACCENT = triplet(accent);
  const ACCENTTEXT = triplet(accentText);
  const map = {
    Window: WINDOW, WindowText: TEXT, WindowFrame: ACCENT, Background: WINDOW,
    ButtonFace: SURFACE, ButtonText: TEXT, ButtonShadow: ACCENT, ButtonHilight: TEXT,
    ButtonDkShadow: TEXT, ButtonLight: ACCENT, ButtonAlternateFace: SURFACE,
    GrayText: MUTED, Hilight: ACCENT, HilightText: ACCENTTEXT, HotTrackingColor: ACCENT,
    ActiveTitle: ACCENT, TitleText: ACCENTTEXT, GradientActiveTitle: GRAD,
    InactiveTitle: SURFACE, InactiveTitleText: MUTED, GradientInactiveTitle: WINDOW,
    ActiveBorder: SURFACE, InactiveBorder: SURFACE, AppWorkspace: WINDOW,
    Menu: SURFACE, MenuText: TEXT, MenuBar: SURFACE, MenuHilight: ACCENT,
    Scrollbar: SURFACE, InfoText: TEXT, InfoWindow: SURFACE,
  };
  return Object.entries(map)
    .map(([k, v]) => `  Set-ItemProperty -Path $colors -Name '${k}' -Value '${v}';`)
    .join('\n');
}

function buildContrastScript(p, isDark) {
  const setLines = colorAssignments(p);
  const mode = isDark ? 0 : 1;
  return `
$ErrorActionPreference = 'SilentlyContinue';
${HC_TYPE_PS}
$colors='${REG_COLORS}'; $pers='${REG_PERS}'; $hcPath='${REG_HC}';
function ApplyColors {
${setLines}
}
# Match dark/light too (helps the few surfaces that aren't fully HC-driven).
if (-not (Test-Path $pers)) { New-Item -Path $pers -Force | Out-Null }
Set-ItemProperty -Path $pers -Name 'AppsUseLightTheme' -Type DWord -Value ${mode};
Set-ItemProperty -Path $pers -Name 'SystemUsesLightTheme' -Type DWord -Value ${mode};
# Write our palette first, enter high-contrast (this re-loads a scheme's colours),
# then re-assert ours so they win, and broadcast so the shell + apps re-read.
ApplyColors;
$scheme = (Get-ItemProperty -Path $hcPath -Name 'High Contrast Scheme' -ErrorAction SilentlyContinue).'High Contrast Scheme';
Set-HighContrast $true $scheme;
ApplyColors;
Broadcast-ColorChange;
'OK'
`;
}

// ── request queue ───────────────────────────────────────────────────────────
// One OS-theme operation at a time. A newer apply/restore supersedes any apply
// still waiting in the queue (rapidly flipping theme cards → only the last runs).
let _chain = Promise.resolve();
let _seq = 0;
let _lastApplied = null; // "r,g,b,dark" of the accent currently pushed (skip repeats)
function enqueue(fn) {
  const p = _chain.then(fn, fn);
  _chain = p.catch(() => {});
  return p;
}
function progressTo(sender, op) {
  return (pct, label) => {
    try { if (sender && !sender.isDestroyed()) sender.send('osTheme:progress', { op, pct, label }); } catch {}
  };
}

module.exports = function registerOsTheme() {
  // ACCENT mode. payload = { r, g, b, dark, tint? } — tint = { bg, header } ({ r,g,b }
  // each) switches to TINTED (Start / taskbar / title bars coloured too).
  ipcMain.handle('osTheme:apply', async (event, payload) => {
    if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
    const base = normalizeRgb(payload);
    if (!base) return { ok: false, error: 'Invalid color' };
    const isDark = !!(payload && payload.dark);
    const tint = payload && payload.tint && typeof payload.tint === 'object'
      ? { bg: normalizeRgb(payload.tint.bg), header: normalizeRgb(payload.tint.header) } : null;
    const seq = ++_seq;
    return enqueue(async () => {
      const progress = progressTo(event.sender, 'apply');
      if (seq !== _seq) return { ok: true, superseded: true };
      const key = `${base.r},${base.g},${base.b},${isDark ? 1 : 0}` + (tint ? `|${JSON.stringify(tint)}` : '');
      if (key === _lastApplied && fs.existsSync(BACKUP_FILE)) { progress(100, 'Windows already matches'); return { ok: true, unchanged: true }; }
      try {
        await applyAccent(base, isDark, progress, tint);
        _lastApplied = key;
        return { ok: true };
      } catch (err) {
        console.warn('[osTheme] apply failed:', (err.message || '').split('\n')[0]);
        progress(100, 'Couldn’t update Windows');
        return { ok: false, error: err.message };
      }
    });
  });

  // CONTRAST mode. payload = { bg, bg2, text, muted, accent, accentText, border, dark }
  // where each colour is { r, g, b }.
  ipcMain.handle('osTheme:applyContrast', async (event, payload) => {
    if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
    const p = payload || {};
    const roles = ['bg', 'bg2', 'text', 'muted', 'accent', 'accentText', 'border'];
    const palette = {};
    for (const role of roles) {
      const c = normalizeRgb(p[role]);
      if (!c) return { ok: false, error: `Missing color: ${role}` };
      palette[role] = c;
    }
    const isDark = !!p.dark;
    ++_seq;
    return enqueue(async () => {
      try {
        ensureSnapshot();
        _lastApplied = null;
        await runPowerShell(buildContrastScript(palette, isDark), 20000);
        return { ok: true };
      } catch (err) {
        console.warn('[osTheme] applyContrast failed:', (err.message || '').split('\n')[0]);
        return { ok: false, error: err.message };
      }
    });
  });

  // Put Windows back the way it was before we first applied, and forget the backup.
  ipcMain.handle('osTheme:restore', async (event) => {
    if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
    ++_seq; // drop any queued applies
    return enqueue(async () => {
      const progress = progressTo(event.sender, 'restore');
      try {
        await restoreFromBackup(progress);
        _lastApplied = null;
        return { ok: true };
      } catch (err) {
        console.warn('[osTheme] restore failed:', (err.message || '').split('\n')[0]);
        progress(100, 'Couldn’t restore Windows colors');
        return { ok: false, error: err.message };
      }
    });
  });

  // Whether we currently hold a saved snapshot (i.e. Windows is under our control).
  ipcMain.handle('osTheme:status', async () => ({
    supported: process.platform === 'win32',
    active: (() => { try { return fs.existsSync(BACKUP_FILE); } catch { return false; } })(),
  }));
};
