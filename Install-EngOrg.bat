@echo off
setlocal EnableDelayedExpansion
title EngOrg Installer
color 1F

echo.
echo  ========================================
echo    EngOrg - Engineering Task Board
echo    Installer
echo  ========================================
echo.

:: Determine where this script is running from
set "SOURCE=%~dp0"
set "TARGET=C:\Assistant"

:: Check if we're already in C:\Assistant
if /I "%SOURCE:~0,-1%"=="%TARGET%" (
    echo  Already installed at %TARGET%
    echo  Setting up shortcuts...
    goto :shortcuts
)

:: Check if target already exists
if exist "%TARGET%\main.js" (
    echo  An existing installation was found at %TARGET%
    echo.
    set /p OVERWRITE="  Overwrite? (Y/N): "
    if /I "!OVERWRITE!" NEQ "Y" (
        echo  Installation cancelled.
        pause
        exit /b
    )
    echo.
    echo  Backing up user data...
    if exist "%TARGET%\appdata" (
        xcopy "%TARGET%\appdata" "%TARGET%\appdata_backup\" /E /I /Q /Y >nul 2>&1
    )
)

echo  Installing to %TARGET%...
echo.

:: Create target directory
if not exist "%TARGET%" mkdir "%TARGET%"

:: Copy all files (excluding installer output and backups)
echo  Copying files...
xcopy "%SOURCE%*" "%TARGET%\" /E /I /Q /Y /EXCLUDE:%SOURCE%install-exclude.txt >nul 2>&1
if errorlevel 1 (
    :: If exclude file doesn't exist, copy everything
    xcopy "%SOURCE%*" "%TARGET%\" /E /I /Q /Y >nul 2>&1
)

:: Restore user data backup if we overwrote
if exist "%TARGET%\appdata_backup" (
    echo  Restoring user data...
    xcopy "%TARGET%\appdata_backup\*" "%TARGET%\appdata\" /E /I /Q /Y >nul 2>&1
    rmdir /S /Q "%TARGET%\appdata_backup" >nul 2>&1
)

echo  Files copied successfully.
echo.

:: Install dependencies
echo  Installing dependencies (this may take a few minutes)...
echo.
pushd "%TARGET%"
set "PATH=%TARGET%\nodejs;%PATH%"
"%TARGET%\nodejs\npm.cmd" install 2>nul
if errorlevel 1 (
    echo  Warning: npm install had issues. You may need to run it manually.
) else (
    echo  Dependencies installed successfully.
)
popd
echo.

:shortcuts
echo  Creating shortcuts...

:: Create Start Menu shortcut using PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$startMenu = [Environment]::GetFolderPath('StartMenu');" ^
  "$shortcutPath = Join-Path $startMenu 'Programs\EngOrg.lnk';" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut($shortcutPath);" ^
  "$sc.TargetPath = 'C:\Assistant\start.bat';" ^
  "$sc.WorkingDirectory = 'C:\Assistant';" ^
  "$sc.IconLocation = 'C:\Assistant\assets\icon.ico,0';" ^
  "$sc.Description = 'EngOrg - Engineering Task Board';" ^
  "$sc.WindowStyle = 7;" ^
  "$sc.Save();" ^
  "Write-Host '  Start Menu shortcut created.'"

:: Create Desktop shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$shortcutPath = Join-Path $desktop 'EngOrg.lnk';" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut($shortcutPath);" ^
  "$sc.TargetPath = 'C:\Assistant\start.bat';" ^
  "$sc.WorkingDirectory = 'C:\Assistant';" ^
  "$sc.IconLocation = 'C:\Assistant\assets\icon.ico,0';" ^
  "$sc.Description = 'EngOrg - Engineering Task Board';" ^
  "$sc.WindowStyle = 7;" ^
  "$sc.Save();" ^
  "Write-Host '  Desktop shortcut created.'"

echo.
echo  ========================================
echo    Installation complete!
echo.
echo    App location: C:\Assistant
echo    Search "EngOrg" in Start Menu to launch
echo  ========================================
echo.

set /p LAUNCH="  Launch EngOrg now? (Y/N): "
if /I "%LAUNCH%"=="Y" (
    start "" "C:\Assistant\start.bat"
)

endlocal
pause
