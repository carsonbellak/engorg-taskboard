const path = require('path');

module.exports = {
  DATA_DIR: 'C:\\Assistant\\appdata',
  FLUIDD_DIR: path.join(__dirname, 'tools', 'fluidd'),
  FLUIDD_PORT: 8765,
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
  // Files/dirs never included in a contribution PR (mirrors .gitignore + safety).
  CONTRIB_IGNORE: ['.git', 'node_modules', 'nodejs', 'tools', 'dist', 'appdata', '.firebase', '.claude'],

  // Email hub — encrypted account store (app passwords encrypted via safeStorage)
  EMAIL_ACCOUNTS_FILE: path.join('C:\\Assistant\\appdata', 'email_accounts.json'),
  EMAIL_ATTACH_DIR: path.join('C:\\Assistant\\appdata', 'email_attachments'),

  // Microsoft OAuth (modern auth) for Outlook / Microsoft 365 mail accounts.
  // Create an Azure app registration: Mobile/desktop platform, "Allow public client
  // flows" = Yes, delegated scopes IMAP.AccessAsUser.All + SMTP.Send + offline_access.
  // Paste its Application (client) ID below. Empty = OAuth disabled (app-password only).
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
