@echo off
set PATH=C:\Assistant\nodejs;%PATH%
cd /d C:\Assistant

echo.
echo === Firebase Login ===
echo A browser window will open for you to sign in with Google.
echo.
C:\Assistant\nodejs\node.exe node_modules\firebase-tools\lib\bin\firebase.js login

echo.
echo === Deploying Firestore Security Rules ===
C:\Assistant\nodejs\node.exe node_modules\firebase-tools\lib\bin\firebase.js deploy --only firestore:rules

echo.
echo === Deploying PWA to Firebase Hosting ===
C:\Assistant\nodejs\node.exe node_modules\firebase-tools\lib\bin\firebase.js deploy --only hosting

echo.
echo === Done! ===
echo Your PWA should now be live at: https://assistant-taskboard.web.app
echo.
pause
