@echo off
set PATH=C:\Assistant\nodejs;%PATH%
cd /d C:\Assistant
rmdir /s /q "node_modules\firebase-tools" 2>nul
del "node_modules\.bin\firebase" 2>nul
del "node_modules\.bin\firebase.cmd" 2>nul
del "node_modules\.bin\firebase.ps1" 2>nul
call npm install firebase-tools --save-dev > install-log.txt 2>&1
echo EXIT_CODE=%ERRORLEVEL% >> install-log.txt
