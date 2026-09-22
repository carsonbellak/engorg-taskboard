const path = require('path');

module.exports = {
  DATA_DIR: 'C:\\Assistant\\appdata',
  FLUIDD_DIR: path.join(__dirname, 'tools', 'fluidd'),
  FLUIDD_PORT: 8765,
  // EngInk live mirror — the desktop runs a LAN WebSocket server the native EngInk (Android)
  // app connects to and streams strokes at; the desktop reflects them read-only. A UDP port is
  // used for zero-config discovery (the tablet broadcasts a probe, the desktop replies with its
  // host/port/pairing-code). Both are localhost-network only (no cloud).
  ENGINK_MIRROR_PORT: 8770,   // WebSocket (stroke stream)
  ENGINK_DISCOVERY_PORT: 8771, // UDP (discovery broadcast/response)
  MOONRAKER_URL: 'http://192.168.0.131:7125',
  ORCASLICER_EXE: path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'OrcaSlicer', 'orca-slicer.exe'),
  ORCASLICER_RESOURCES: path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'OrcaSlicer', 'resources', 'profiles', 'Creality'),
  SLICER_OUTPUT_DIR: path.join(__dirname, 'appdata', 'slicer_output'),

  // DigiKey API (client-credentials) defaults for the KiCad Importer utility.
  // These pre-fill the Settings fields; a user-entered value in settings.json overrides them.
  DIGIKEY_CLIENT_ID: 'n7mFDwSdRdQCKPNq52lSAzjXf0hisj7MpxFoscdblIgtTh05',
  DIGIKEY_CLIENT_SECRET: 'Y1G22SWYHvwakrBfglCXhjeVkCffj12EIn2j9opGLRevodkMMQkuAKArXMqvAizl',

  // Utility Store — GitHub-hosted catalog of installable utilities. Point this at a
  // raw.githubusercontent.com URL for a JSON file shaped like { "utilities": [ ... ] }.
  // Each remote utility entry: { id, name, icon, description, version, entry: <raw HTML url> }.
  UTILITY_STORE_CATALOG_URL: 'https://raw.githubusercontent.com/carsonbellak/engorg-taskboard/main/utilities/catalog.json',

  // Contribute — the canonical app repo users submit changes to (Settings > Contribute).
  // The "Submit Changes" button forks this repo to the submitter's account and opens a PR.
  // owner/repo here is the authoritative upstream; the owner (you) reviews + merges PRs.
  CONTRIB_REPO: { owner: 'carsonbellak', repo: 'engorg-taskboard', branch: 'main' },
  CONTRIB_REPO_URL: 'https://github.com/carsonbellak/engorg-taskboard',
  // "Sign in with GitHub" for Submit Changes uses GitHub's OAuth Device Flow so
  // users never paste a Personal Access Token. Set this to a GitHub OAuth App
  // client ID (https://github.com/settings/developers → New OAuth App, then enable
  // "Device Flow"). The client ID is public (not a secret); it can also be set per
  // machine via settings.json → "githubOAuthClientId".
  GITHUB_OAUTH_CLIENT_ID: 'Ov23li96Mzewh6RckDT4',
  // Files/dirs never included in a contribution PR (mirrors .gitignore + safety).
  CONTRIB_IGNORE: ['.git', 'node_modules', 'nodejs', 'tools', 'dist', 'appdata', '.firebase', '.claude'],

  // Email hub — encrypted account store (app passwords encrypted via safeStorage)
  EMAIL_ACCOUNTS_FILE: path.join('C:\\Assistant\\appdata', 'email_accounts.json'),
  GITHUB_TOKEN_FILE: path.join('C:\\Assistant\\appdata', 'github.json'),
  // Claude / Anthropic link — the user's own API key, encrypted at rest via
  // safeStorage (DPAPI on Windows), decrypted only in main and never sent to the
  // renderer. Foundation for the "Claude agents" features (first: syllabus import).
  // Non-secret prefs (chosen model) live alongside the encrypted key in this file.
  CLAUDE_CREDS_FILE: path.join('C:\\Assistant\\appdata', 'claude.json'),
  ANTHROPIC_API_URL: 'https://api.anthropic.com',
  ANTHROPIC_VERSION: '2023-06-01',
  // Models offered in the Linked Accounts → Claude card. Default is Opus 5.
  CLAUDE_MODELS: [
    { id: 'claude-opus-5', label: 'Claude Opus 5 (most capable)' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (fast, no thinking)' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (balanced)' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest / cheapest)' },
  ],
  CLAUDE_DEFAULT_MODEL: 'claude-opus-5',
  // Gradescope link — email + password encrypted at rest via safeStorage (we must
  // keep the password, not a token, because Gradescope has no API and sessions expire
  // so we re-login on each sync).
  GRADESCOPE_CREDS_FILE: path.join('C:\\Assistant\\appdata', 'gradescope.json'),
  // Downloaded assignment attachments (device-local — paths are local, so NOT synced).
  GRADESCOPE_ATTACH_DIR: path.join('C:\\Assistant\\appdata', 'gradescope_attachments'),
  EMAIL_ATTACH_DIR: path.join('C:\\Assistant\\appdata', 'email_attachments'),

  // Variate link — Purdue's StudioKit assessment platform (assignments → calendar).
  // Its API is real JSON but gated behind Purdue Career Account SSO (BoilerKey + Duo)
  // via OAuth/PKCE, so there is NO headless password login. We authenticate by opening
  // the web app in a BrowserWindow on a persistent session partition and letting the
  // SPA manage the token; no password is stored (variate.json holds only name/email).
  // Change these two URLs to point the integration at a different school's Variate.
  VARIATE_APP_URL: 'https://purdue.variate.org',
  VARIATE_API_URL: 'https://purdue.api.variate.org',
  VARIATE_STATE_FILE: path.join('C:\\Assistant\\appdata', 'variate.json'),

  // Microsoft OAuth (modern auth) for Outlook / Microsoft 365 mail accounts.
  // Create an Azure app registration: Mobile/desktop platform, "Allow public client
  // flows" = Yes, delegated scopes IMAP.AccessAsUser.All + SMTP.Send + offline_access.
  // Paste its Application (client) ID below. Empty = OAuth disabled (app-password only).
  //
  // Per-machine override (wins over these, survives in-app updates): settings.json →
  //   "msOAuthClientId", "msOAuthRedirect", "msOAuthAuthority"
  // (see ipc/oauth.js). Use that instead of editing this file so the value isn't shipped
  // as the public default and isn't clobbered when the app updates.
  MS_OAUTH_CLIENT_ID: '',
  MS_OAUTH_AUTHORITY: 'https://login.microsoftonline.com/common',
  MS_OAUTH_REDIRECT: 'http://localhost',

  // IMAP/SMTP presets per provider. `secure: true` = implicit TLS; false = STARTTLS.
  EMAIL_PROVIDERS: {
    gmail: {
      label: 'Gmail / Google Workspace',
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
      help: 'https://support.google.com/accounts/answer/185833', // App passwords (requires 2FA)
      appPasswordUrl: 'https://myaccount.google.com/apppasswords',
      appPasswordSteps: [
        'Turn on 2-Step Verification for your Google account (app passwords require it).',
        'Open Google’s App passwords page with the button below.',
        'Type an app name like “EngOrg” and click Create.',
        'Copy the 16-character code and paste it in the App password box above.',
      ],
    },
    outlook: {
      label: 'Outlook / Microsoft 365',
      oauth: true, // sign in with Microsoft (OAuth/XOAUTH2) instead of an app password
      imap: { host: 'outlook.office365.com', port: 993, secure: true },
      smtp: { host: 'smtp.office365.com', port: 587, secure: false },
      help: 'https://support.microsoft.com/account-billing/manage-app-passwords-for-two-step-verification-d6dc8c6d-4bf7-4851-ad95-6d07799387e9',
    },
    yahoo: {
      label: 'Yahoo Mail',
      imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
      smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
      help: 'https://help.yahoo.com/kb/SLN15241.html',
      appPasswordUrl: 'https://login.yahoo.com/account/security/app-passwords',
      appPasswordSteps: [
        'Open Yahoo Account Security with the button below.',
        'Turn on 2-step verification if it isn’t already on.',
        'Choose “Generate app password” and name it (e.g. “EngOrg”).',
        'Copy the generated password and paste it in the box above.',
      ],
    },
    icloud: {
      label: 'iCloud Mail',
      imap: { host: 'imap.mail.me.com', port: 993, secure: true },
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
      help: 'https://support.apple.com/102654',
      appPasswordUrl: 'https://appleid.apple.com/account/manage',
      appPasswordSteps: [
        'Sign in to appleid.apple.com with the button below.',
        'Make sure Two-Factor Authentication is on (required for app passwords).',
        'Under Sign-In and Security → App-Specific Passwords, click Generate.',
        'Name it (e.g. “EngOrg”), copy it, and paste it in the box above.',
      ],
    },
    custom: {
      label: 'Other (custom IMAP/SMTP)',
      imap: { host: '', port: 993, secure: true },
      smtp: { host: '', port: 587, secure: false },
      help: '',
    },
  },
};
