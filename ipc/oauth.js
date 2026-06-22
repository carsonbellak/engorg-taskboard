// Microsoft OAuth (authorization code + PKCE) for Outlook / Microsoft 365 mail.
//
// Public-client desktop flow — no client secret. We open a child BrowserWindow at the
// Microsoft authorize endpoint, intercept the redirect back to the loopback URI to grab
// the auth code, then exchange it (with the PKCE verifier) for tokens. The resulting
// access token is used for IMAP/SMTP XOAUTH2; the refresh token is stored encrypted by
// the email module so we can mint fresh access tokens without re-prompting.
const { BrowserWindow } = require('electron');
const crypto = require('crypto');
const https = require('https');
const config = require('../config');

// Exchange Online resource scopes (NOT Microsoft Graph) for IMAP + SMTP,
// plus offline_access so we receive a refresh token.
const MS_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access', 'openid', 'email', 'profile',
];

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tokenEndpoint() {
  return `${config.MS_OAUTH_AUTHORITY}/oauth2/v2.0/token`;
}

// POST application/x-www-form-urlencoded and parse the JSON token response.
function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { return reject(new Error('Bad token response: ' + data.slice(0, 200))); }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(json.error_description || json.error || ('HTTP ' + res.statusCode)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Pull the mailbox address out of the id_token claims.
function decodeJwtEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return payload.preferred_username || payload.email || payload.upn || '';
  } catch { return ''; }
}

function authorizeUrl({ clientId, challenge, state }) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: config.MS_OAUTH_REDIRECT,
    response_mode: 'query',
    scope: MS_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });
  return `${config.MS_OAUTH_AUTHORITY}/oauth2/v2.0/authorize?` + p.toString();
}

function isConfigured() {
  return !!config.MS_OAUTH_CLIENT_ID;
}

// Interactive sign-in. Resolves { email, refreshToken, accessToken, expiresIn }.
function interactiveSignIn(getMainWindow) {
  const clientId = config.MS_OAUTH_CLIENT_ID;
  if (!clientId) return Promise.reject(new Error('Microsoft OAuth is not configured (set MS_OAUTH_CLIENT_ID in config.js).'));

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 520, height: 720,
      parent: getMainWindow ? getMainWindow() : undefined, modal: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      title: 'Sign in with Microsoft',
    });

    const finish = (fn) => { if (settled) return; settled = true; try { win.close(); } catch {} fn(); };

    // Intercept navigation to the loopback redirect; the code/error is in the query string.
    const handleUrl = (url) => {
      if (!url || !url.startsWith(config.MS_OAUTH_REDIRECT)) return false;
      let parsed;
      try { parsed = new URL(url); } catch { return false; }
      const code = parsed.searchParams.get('code');
      const err = parsed.searchParams.get('error');
      const returnedState = parsed.searchParams.get('state');
      if (err) { finish(() => reject(new Error(parsed.searchParams.get('error_description') || err))); return true; }
      if (!code) return false;
      if (returnedState !== state) { finish(() => reject(new Error('OAuth state mismatch'))); return true; }
      postForm(tokenEndpoint(), {
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.MS_OAUTH_REDIRECT,
        code_verifier: verifier,
        scope: MS_SCOPES.join(' '),
      }).then(tok => finish(() => resolve({
        email: decodeJwtEmail(tok.id_token || ''),
        refreshToken: tok.refresh_token,
        accessToken: tok.access_token,
        expiresIn: tok.expires_in || 3600,
      }))).catch(e => finish(() => reject(e)));
      return true;
    };

    win.webContents.on('will-redirect', (e, url) => { if (handleUrl(url)) e.preventDefault(); });
    win.webContents.on('will-navigate', (e, url) => { if (handleUrl(url)) e.preventDefault(); });
    win.on('closed', () => { if (!settled) { settled = true; reject(new Error('Sign-in window was closed')); } });

    win.loadURL(authorizeUrl({ clientId, challenge, state }));
  });
}

// Mint a fresh access token from a stored refresh token. Microsoft rotates refresh
// tokens, so the caller should persist refreshToken if it differs from the input.
function refresh(refreshToken) {
  const clientId = config.MS_OAUTH_CLIENT_ID;
  if (!clientId) return Promise.reject(new Error('Microsoft OAuth is not configured.'));
  return postForm(tokenEndpoint(), {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MS_SCOPES.join(' '),
  }).then(tok => ({
    accessToken: tok.access_token,
    expiresIn: tok.expires_in || 3600,
    refreshToken: tok.refresh_token || refreshToken,
  }));
}

module.exports = { interactiveSignIn, refresh, isConfigured };
