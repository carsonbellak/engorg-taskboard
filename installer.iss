; EngOrg Installer - Inno Setup Script
; Classic Windows installer with component selection

#define MyAppName "EngOrg"
#define MyAppVersion "1.0"
#define MyAppPublisher "EngOrg"
#define MyAppURL "https://assistant-taskboard.web.app"
; launch.vbs runs the app with no visible console window (see View > Show Console in-app)
#define MyAppExeName "launch.vbs"
; Engineering Utilities — the Utility Store pulls its catalog from this GitHub repo.
; Keep in sync with UTILITY_STORE_CATALOG_URL in config.js.
#define MyUtilitiesRepoURL "https://github.com/carsonbellak/engorg-taskboard/tree/main/utilities"
#define MyUtilitiesCatalogURL "https://raw.githubusercontent.com/carsonbellak/engorg-taskboard/main/utilities/catalog.json"

[Setup]
AppId={{E4A3D2B1-7F6C-4D8E-9A5B-1C2D3E4F5A6B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName=C:\Assistant
DefaultGroupName={#MyAppName}
OutputDir=C:\Assistant
OutputBaseFilename=EngOrg-Setup
SetupIconFile=C:\Assistant\assets\icon.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=admin
UninstallDisplayIcon={app}\assets\icon.ico
UninstallDisplayName={#MyAppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full"; Description: "Full installation (with 3D Printer Tools)"
Name: "compact"; Description: "Compact installation (no 3D Printer Tools)"
Name: "custom"; Description: "Custom installation"; Flags: iscustom

[Components]
Name: "core"; Description: "EngOrg Core Application"; Types: full compact custom; Flags: fixed
Name: "nodejs"; Description: "Node.js Runtime"; Types: full compact custom; Flags: fixed
Name: "tools"; Description: "3D Printer Tools (OrcaSlicer + Fluidd)"; Types: full

[Files]
; Core app files
Source: "C:\Assistant\main.js"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\preload.js"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\package.json"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\package-lock.json"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\start.bat"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\launch.vbs"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\Install-EngOrg.bat"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\build-installer.js"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\build-icon.js"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\installer.iss"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\config.js"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\state.js"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\moonraker.js"; DestDir: "{app}"; Components: core; Flags: ignoreversion
Source: "C:\Assistant\fluidd-server.js"; DestDir: "{app}"; Components: core; Flags: ignoreversion

; IPC modules
Source: "C:\Assistant\ipc\*"; DestDir: "{app}\ipc"; Components: core; Flags: ignoreversion recursesubdirs

; Assets
Source: "C:\Assistant\assets\*"; DestDir: "{app}\assets"; Components: core; Flags: ignoreversion recursesubdirs

; Renderer (UI)
Source: "C:\Assistant\renderer\*"; DestDir: "{app}\renderer"; Components: core; Flags: ignoreversion recursesubdirs

; PWA
Source: "C:\Assistant\pwa\*"; DestDir: "{app}\pwa"; Components: core; Flags: ignoreversion recursesubdirs

; Node.js runtime
Source: "C:\Assistant\nodejs\*"; DestDir: "{app}\nodejs"; Components: nodejs; Flags: ignoreversion recursesubdirs

; 3D Printer Tools (optional)
Source: "C:\Assistant\tools\*"; DestDir: "{app}\tools"; Components: tools; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\icon.ico"; WorkingDir: "{app}"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\assets\icon.ico"; WorkingDir: "{app}"

[Run]
Filename: "{cmd}"; Parameters: "/C set ""PATH={app}\nodejs;%PATH%"" && ""{app}\nodejs\npm.cmd"" install"; WorkingDir: "{app}"; StatusMsg: "Installing dependencies..."; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent shellexec

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"

[Code]
{ ---------------------------------------------------------------------------
  Engineering Utilities — a dedicated wizard screen that explains the built-in
  utilities, points the user at the in-app Utility Store for adding more, and
  links to the GitHub repo the store pulls its (auto-updating) catalog from.
  --------------------------------------------------------------------------- }
var
  UtilitiesPage: TWizardPage;
  UtilitiesLink: TNewStaticText;

procedure OpenUtilitiesRepo(Sender: TObject);
var
  ErrorCode: Integer;
begin
  ShellExec('open', '{#MyUtilitiesRepoURL}', '', '', SW_SHOW, ewNoWait, ErrorCode);
end;

procedure InitializeWizard;
var
  Intro: TNewStaticText;
  StoreNote: TNewStaticText;
begin
  UtilitiesPage := CreateCustomPage(wpSelectComponents,
    'Engineering Utilities',
    'Modular engineering tools — expandable any time from the Utility Store');

  Intro := TNewStaticText.Create(WizardForm);
  Intro.Parent := UtilitiesPage.Surface;
  Intro.Left := 0;
  Intro.Top := 0;
  Intro.Width := UtilitiesPage.SurfaceWidth;
  Intro.AutoSize := False;
  Intro.WordWrap := True;
  Intro.Height := ScaleY(130);
  Intro.Caption :=
    'EngOrg includes a set of built-in Engineering Utilities:' + #13#10 +
    '       3D Printer  —  Moonraker status, live camera, print controls' + #13#10 +
    '       Slicer  —  slice models with OrcaSlicer and send to the printer' + #13#10 +
    '       KiCad Importer  —  consolidate UltraLibrarian / SnapMagic ZIPs' + #13#10 +
    '       WiFi Checker  —  ping + SSH meter scans, temp shutdown, scheduled pings' + #13#10 + #13#10 +
    'After installation, open the Engineering Utilities tab and turn on whichever ' +
    'tools you need.';

  StoreNote := TNewStaticText.Create(WizardForm);
  StoreNote.Parent := UtilitiesPage.Surface;
  StoreNote.Left := 0;
  StoreNote.Top := Intro.Top + Intro.Height + ScaleY(8);
  StoreNote.Width := UtilitiesPage.SurfaceWidth;
  StoreNote.AutoSize := False;
  StoreNote.WordWrap := True;
  StoreNote.Height := ScaleY(56);
  StoreNote.Caption :=
    'Need more? Additional utilities can be installed at any time through the ' +
    'built-in Utility Store (Engineering Utilities tab > Utility Store). The store ' +
    'pulls its catalog from GitHub, so new and updated utilities appear ' +
    'automatically — no reinstall required. Browse the catalog:';

  UtilitiesLink := TNewStaticText.Create(WizardForm);
  UtilitiesLink.Parent := UtilitiesPage.Surface;
  UtilitiesLink.Left := 0;
  UtilitiesLink.Top := StoreNote.Top + StoreNote.Height + ScaleY(2);
  UtilitiesLink.Caption := '{#MyUtilitiesRepoURL}';
  UtilitiesLink.Cursor := crHand;
  UtilitiesLink.Font.Color := clBlue;
  UtilitiesLink.Font.Style := [fsUnderline];
  UtilitiesLink.OnClick := @OpenUtilitiesRepo;
end;
