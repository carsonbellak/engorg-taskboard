// IPC handlers: Outlook calendar via classic Outlook COM (MAPI)
// The work/school account (e.g. *.landisgyr.com) lives in classic Outlook, not the
// Windows AppointmentStore. The WinRT AppointmentStore only exposes the consumer
// "Microsoft account" calendar (usually empty), which is why the old WinRT-based
// sync returned nothing. COM reads the real default calendar including recurrences.
//
// Requirements: classic Outlook installed and a profile configured (verified present).
const { ipcMain } = require('electron');
const { execFile } = require('child_process');

// Reads the default Outlook calendar folder (olFolderCalendar = 9) over a date window.
// Notes:
//   - IncludeRecurrences expands recurring meetings into per-day instances.
//   - .Count is unreliable on a recurrence-expanded collection (returns Int32.MaxValue),
//     so we iterate with a hard cap and rely on the Restrict upper bound to terminate.
//   - entryId is composited with the occurrence date so each day's instance of a
//     recurring meeting is a distinct, stable schedule item across syncs.
const COM_SCRIPT = (daysBack, daysForward) => `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  # Guard: if classic Outlook has no mail profile configured, instantiating the
  # Outlook COM object makes Outlook pop its "Create New Profile" dialog (which
  # -NonInteractive cannot suppress, since Outlook is a separate process). Detect
  # the absence of any profile via the registry and bail out silently instead.
  $profilePaths = @(
    'HKCU:\\Software\\Microsoft\\Office\\16.0\\Outlook\\Profiles',
    'HKCU:\\Software\\Microsoft\\Office\\15.0\\Outlook\\Profiles',
    'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows Messaging Subsystem\\Profiles'
  )
  $hasProfile = $false
  foreach ($p in $profilePaths) {
    if (Test-Path $p) {
      $kids = @(Get-ChildItem $p -ErrorAction SilentlyContinue)
      if ($kids.Count -gt 0) { $hasProfile = $true; break }
    }
  }
  if (-not $hasProfile) { '[]'; exit 0 }

  $ol  = New-Object -ComObject Outlook.Application
  $ns  = $ol.GetNamespace('MAPI')
  $cal = $ns.GetDefaultFolder(9)
  $items = $cal.Items
  $items.IncludeRecurrences = $true
  $items.Sort('[Start]')

  $startDt = (Get-Date).AddDays(-${daysBack})
  $endDt   = (Get-Date).AddDays(${daysForward})
  $filter  = "[Start] >= '" + $startDt.ToString('g') + "' AND [Start] <= '" + $endDt.ToString('g') + "'"
  $restricted = $items.Restrict($filter)

  $events = @()
  $count  = 0
  foreach ($a in $restricted) {
    if ($count -ge 1000) { break }
    $bodyText = try { $b = "$($a.Body)"; if ($b.Length -gt 200) { $b.Substring(0,200) } else { $b } } catch { '' }
    $bodyText = $bodyText -replace "\\r?\\n", ' '
    $dayKey = try { $a.Start.ToString('yyyyMMdd') } catch { '' }
    $events += @{
      subject   = "$($a.Subject)"
      startTime = $a.Start.ToString('o')
      endTime   = $a.End.ToString('o')
      location  = "$($a.Location)"
      body      = $bodyText
      isAllDay  = [bool]$a.AllDayEvent
      entryId   = "$($a.EntryID)_$dayKey"
    }
    $count++
  }

  if ($events.Count -eq 0) { '[]' } else { $events | ConvertTo-Json -Depth 3 }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`;

function runScript(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || 'exit code ' + (error.code ?? 1)));
        return;
      }
      try {
        const trimmed = stdout.trim();
        if (!trimmed || trimmed === '[]') { resolve([]); return; }
        let parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) parsed = [parsed];
        resolve(parsed);
      } catch (e) {
        reject(new Error('Failed to parse calendar data: ' + e.message));
      }
    });
  });
}

module.exports = function register() {
  ipcMain.handle('outlook:fetchLocal', async (event, daysBack, daysForward) => {
    const back    = daysBack    || 30;
    const forward = daysForward || 60;
    // COM has higher startup cost than WinRT — allow 30s before giving up.
    return runScript(COM_SCRIPT(back, forward), 30000).catch(err => {
      console.warn('[Outlook] Calendar fetch failed:', err.message.split('\n')[0]);
      return [];
    });
  });
};
