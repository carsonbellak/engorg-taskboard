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
//     then broadcasts WM_SETTINGCHANGE("ImmersiveColorSet") to refresh live.
//
//   CONTRAST (osTheme:applyContrast) — the fullest match. Generates a Windows
//     *contrast theme* from the app's whole palette (background, text, links,
//     selection, buttons) by writing HKCU\Control Panel\Colors and turning on
//     Windows high-contrast mode via SystemParametersInfo(SPI_SETHIGHCONTRAST) —
//     which is what makes the OS honour those custom colours everywhere. Then it
//     re-asserts the colours and broadcasts WM_SYSCOLORCHANGE / WM_THEMECHANGED /
//     WM_SETTINGCHANGE so surfaces repaint.
//
// Reversibility: the FIRST apply of EITHER mode snapshots everything we might
// touch (accent keys, dark/light, the whole Control Panel\Colors table, and the
// high-contrast on/off state + scheme) to appdata/windows_accent_backup.json.
// osTheme:restore writes it all back, returns high-contrast to its prior state,
// and removes the backup. The renderer calls restore before switching modes and
// when turning the feature off, so transitions are always clean.
//
// No native modules — all via PowerShell, like ipc/outlook.js.
const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const BACKUP_FILE = path.join(DATA_DIR, 'windows_accent_backup.json');

const REG_DWM    = 'HKCU:\\Software\\Microsoft\\Windows\\DWM';
const REG_PERS   = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const REG_ACC    = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent';
const REG_COLORS = 'HKCU:\\Control Panel\\Colors';
const REG_HC     = 'HKCU:\\Control Panel\\Accessibility\\HighContrast';

// ── colour maths (done here so PowerShell just writes values) ───────────────
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

function normalizeRgb(rgb) {
  if (!rgb || typeof rgb !== 'object') return null;
  const r = clamp8(rgb.r), g = clamp8(rgb.g), b = clamp8(rgb.b);
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  return { r, g, b };
}

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

// A single-line P/Invoke of SendMessageTimeout, used by the accent path to
// broadcast the colour change so surfaces refresh live.
const BROADCAST_PS = `
try {
  $sig = '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);';
  $t = Add-Type -MemberDefinition $sig -Name 'Bcast' -Namespace 'OsThemeSync' -PassThru -ErrorAction Stop;
  $res = [UIntPtr]::Zero;
  $t::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 3000, [ref]$res) | Out-Null;
} catch {}
`;

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

// Snapshot EVERYTHING we might change, so one backup reverts either mode fully.
const SNAPSHOT_PS = `
$ErrorActionPreference = 'SilentlyContinue';
function ReadVal($p,$n){ try { return (Get-ItemProperty -Path $p -Name $n -ErrorAction Stop).$n } catch { return $null } }
$dwm='${REG_DWM}'; $pers='${REG_PERS}'; $acc='${REG_ACC}'; $colors='${REG_COLORS}'; $hcPath='${REG_HC}';
$pal = ReadVal $acc 'AccentPalette';
$palOut = $null;
if ($null -ne $pal) { $palOut = @($pal | ForEach-Object { [int]$_ }) }
# Whole Control Panel\Colors table.
$cmap = [ordered]@{};
try { $ck = Get-Item -Path $colors -ErrorAction Stop; foreach ($nm in $ck.GetValueNames()) { $cmap[$nm] = (Get-ItemProperty -Path $colors -Name $nm -ErrorAction SilentlyContinue).$nm } } catch {}
$hcFlags = ReadVal $hcPath 'Flags';
$hcScheme = ReadVal $hcPath 'High Contrast Scheme';
$hcOn = $false;
if ($hcFlags) { try { $hcOn = ((([int]$hcFlags) -band 1) -eq 1) } catch {} }
$o = [ordered]@{
  DWM_AccentColor = ReadVal $dwm 'AccentColor';
  DWM_AccentColorInactive = ReadVal $dwm 'AccentColorInactive';
  DWM_ColorizationColor = ReadVal $dwm 'ColorizationColor';
  DWM_ColorizationAfterglow = ReadVal $dwm 'ColorizationAfterglow';
  DWM_ColorPrevalence = ReadVal $dwm 'ColorPrevalence';
  DWM_EnableWindowColorization = ReadVal $dwm 'EnableWindowColorization';
  Personalize_ColorPrevalence = ReadVal $pers 'ColorPrevalence';
  Personalize_AppsUseLightTheme = ReadVal $pers 'AppsUseLightTheme';
  Personalize_SystemUsesLightTheme = ReadVal $pers 'SystemUsesLightTheme';
  Accent_AccentColorMenu = ReadVal $acc 'AccentColorMenu';
  Accent_StartColorMenu = ReadVal $acc 'StartColorMenu';
  Accent_AccentPalette = $palOut;
  Colors = $cmap;
  HC_Flags = $hcFlags;
  HC_Scheme = $hcScheme;
  HC_On = $hcOn;
};
$o | ConvertTo-Json -Compress -Depth 6
`;

// ── ACCENT mode ─────────────────────────────────────────────────────────────
function buildApplyScript(base, isDark) {
  const ac   = abgr(base);
  const aci  = abgr(shade(base, 0.15));
  const cc   = argb(base);
  const acm  = abgr(base);
  const scm  = abgr(shade(base, 0.2));
  const pal  = paletteBytes(base).join(',');
  const mode = isDark ? 0 : 1; // AppsUseLightTheme/SystemUsesLightTheme: 1 = light, 0 = dark
  return `
$ErrorActionPreference = 'Stop';
function WriteDword($p,$n,[uint32]$v){
  if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
  $i = [System.BitConverter]::ToInt32([System.BitConverter]::GetBytes($v), 0);
  Set-ItemProperty -Path $p -Name $n -Type DWord -Value $i;
}
$dwm='${REG_DWM}'; $pers='${REG_PERS}'; $acc='${REG_ACC}';
WriteDword $dwm 'AccentColor' ${ac};
WriteDword $dwm 'AccentColorInactive' ${aci};
WriteDword $dwm 'ColorizationColor' ${cc};
WriteDword $dwm 'ColorizationAfterglow' ${cc};
# ColorPrevalence OFF (0): keep the accent as a *highlight* colour (selected items,
# links, toggles) only. Setting it ON floods Start / taskbar / title-bar backgrounds
# with the accent, which for a vivid accent (e.g. Neon green) turns all of Windows
# that colour — the opposite of a "dark theme with accents".
WriteDword $dwm 'ColorPrevalence' 0;
WriteDword $dwm 'EnableWindowColorization' 1;
WriteDword $pers 'AppsUseLightTheme' ${mode};
WriteDword $pers 'SystemUsesLightTheme' ${mode};
WriteDword $pers 'ColorPrevalence' 0;
WriteDword $acc 'AccentColorMenu' ${acm};
WriteDword $acc 'StartColorMenu' ${scm};
if (-not (Test-Path $acc)) { New-Item -Path $acc -Force | Out-Null }
Set-ItemProperty -Path $acc -Name 'AccentPalette' -Type Binary -Value ([byte[]]@(${pal}));
${BROADCAST_PS}
'OK'
`;
}

// ── CONTRAST mode ───────────────────────────────────────────────────────────
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

// ── restore ─────────────────────────────────────────────────────────────────
function buildRestoreScript(backupPath) {
  const bp = backupPath.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'SilentlyContinue';
${HC_TYPE_PS}
$bp = '${bp}';
if (-not (Test-Path $bp)) { 'NOFILE'; return }
$j = Get-Content -Raw -Path $bp | ConvertFrom-Json;
$dwm='${REG_DWM}'; $pers='${REG_PERS}'; $acc='${REG_ACC}'; $colors='${REG_COLORS}'; $hcPath='${REG_HC}';
function RestoreDword($p,$n,$v){
  if ($null -eq $v) { Remove-ItemProperty -Path $p -Name $n -ErrorAction SilentlyContinue }
  else {
    # Stored value may exceed Int32 (e.g. 0xFFxxxxxx); reinterpret the 32 bits.
    $i = [System.BitConverter]::ToInt32([System.BitConverter]::GetBytes([uint32]$v), 0);
    Set-ItemProperty -Path $p -Name $n -Type DWord -Value $i;
  }
}
RestoreDword $dwm 'AccentColor' $j.DWM_AccentColor;
RestoreDword $dwm 'AccentColorInactive' $j.DWM_AccentColorInactive;
RestoreDword $dwm 'ColorizationColor' $j.DWM_ColorizationColor;
RestoreDword $dwm 'ColorizationAfterglow' $j.DWM_ColorizationAfterglow;
RestoreDword $dwm 'ColorPrevalence' $j.DWM_ColorPrevalence;
RestoreDword $dwm 'EnableWindowColorization' $j.DWM_EnableWindowColorization;
RestoreDword $pers 'ColorPrevalence' $j.Personalize_ColorPrevalence;
RestoreDword $pers 'AppsUseLightTheme' $j.Personalize_AppsUseLightTheme;
RestoreDword $pers 'SystemUsesLightTheme' $j.Personalize_SystemUsesLightTheme;
RestoreDword $acc 'AccentColorMenu' $j.Accent_AccentColorMenu;
RestoreDword $acc 'StartColorMenu' $j.Accent_StartColorMenu;
if ($null -eq $j.Accent_AccentPalette) { Remove-ItemProperty -Path $acc -Name 'AccentPalette' -ErrorAction SilentlyContinue }
else { Set-ItemProperty -Path $acc -Name 'AccentPalette' -Type Binary -Value ([byte[]]($j.Accent_AccentPalette | ForEach-Object { [byte]$_ })) }
# Restore the whole Control Panel\Colors table.
function RestoreColors {
  if ($j.Colors) { foreach ($prop in $j.Colors.PSObject.Properties) { if ($null -ne $prop.Value) { Set-ItemProperty -Path $colors -Name $prop.Name -Value ([string]$prop.Value) } } }
}
RestoreColors;
# Return high-contrast to its prior on/off state + scheme, then re-assert the
# restored colours (toggling HC can reload a scheme) and broadcast.
Set-HighContrast ([bool]$j.HC_On) ([string]$j.HC_Scheme);
RestoreColors;
if ($null -ne $j.HC_Flags) { Set-ItemProperty -Path $hcPath -Name 'Flags' -Value ([string]$j.HC_Flags) }
Broadcast-ColorChange;
'OK'
`;
}

// Take the one-time snapshot before the first apply of any mode.
async function ensureSnapshot() {
  if (fs.existsSync(BACKUP_FILE)) return;
  const snap = await runPowerShell(SNAPSHOT_PS, 20000);
  if (snap) {
    try { JSON.parse(snap); } catch { /* keep whatever we got; restore guards on parse */ }
    try { fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true }); } catch {}
    fs.writeFileSync(BACKUP_FILE, snap, 'utf8');
  }
}

module.exports = function registerOsTheme() {
  // ACCENT mode. payload = { r, g, b, dark }.
  ipcMain.handle('osTheme:apply', async (event, payload) => {
    if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
    const base = normalizeRgb(payload);
    if (!base) return { ok: false, error: 'Invalid color' };
    const isDark = !!(payload && payload.dark);
    try {
      await ensureSnapshot();
      await runPowerShell(buildApplyScript(base, isDark), 20000);
      return { ok: true };
    } catch (err) {
      console.warn('[osTheme] apply failed:', (err.message || '').split('\n')[0]);
      return { ok: false, error: err.message };
    }
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
    try {
      await ensureSnapshot();
      await runPowerShell(buildContrastScript(palette, isDark), 20000);
      return { ok: true };
    } catch (err) {
      console.warn('[osTheme] applyContrast failed:', (err.message || '').split('\n')[0]);
      return { ok: false, error: err.message };
    }
  });

  // Put Windows back the way it was before we first applied, and forget the backup.
  ipcMain.handle('osTheme:restore', async () => {
    if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
    try {
      if (fs.existsSync(BACKUP_FILE)) {
        await runPowerShell(buildRestoreScript(BACKUP_FILE), 20000);
        try { fs.unlinkSync(BACKUP_FILE); } catch {}
      }
      return { ok: true };
    } catch (err) {
      console.warn('[osTheme] restore failed:', (err.message || '').split('\n')[0]);
      return { ok: false, error: err.message };
    }
  });

  // Whether we currently hold a saved snapshot (i.e. Windows is under our control).
  ipcMain.handle('osTheme:status', async () => ({
    supported: process.platform === 'win32',
    active: (() => { try { return fs.existsSync(BACKUP_FILE); } catch { return false; } })(),
  }));
};
