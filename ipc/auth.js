// IPC handlers: Google sign-in via hosted auth page in a child BrowserWindow
const { ipcMain, BrowserWindow } = require('electron');

module.exports = function register(getMainWindow) {
  ipcMain.handle('auth:googleSignIn', async () => {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const authWindow = new BrowserWindow({
        width: 500, height: 700,
        parent: getMainWindow(), modal: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        title: 'Sign in with Google'
      });

      // Hosted auth page runs signInWithPopup in a real web context
      authWindow.loadURL('https://assistant-taskboard.web.app/auth.html');

      // Allow Google and Firebase popup domains
      authWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('accounts.google.com') || url.includes('firebaseapp.com')) return { action: 'allow' };
        return { action: 'deny' };
      });

      // Poll for hash change that signals successful auth
      const checkInterval = setInterval(() => {
        if (resolved) return;
        authWindow.webContents.executeJavaScript('window.location.hash')
          .then(hash => {
            if (hash && hash.includes('auth_success=')) {
              const params = new URLSearchParams(hash.substring(1));
              const idToken = params.get('auth_success') || '';
              const accessToken = params.get('access_token') || '';
              if (idToken) {
                resolved = true;
                clearInterval(checkInterval);
                authWindow.close();
                resolve({ idToken, accessToken });
              }
            }
          })
          .catch(() => {});
      }, 500);

      authWindow.on('closed', () => {
        clearInterval(checkInterval);
        if (!resolved) reject(new Error('Sign-in window was closed'));
      });
    });
  });
};
