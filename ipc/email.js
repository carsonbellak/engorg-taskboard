// IPC handlers: Email hub via IMAP (receive) + SMTP (send).
//
// All mail logic runs in the main process. App passwords are encrypted at rest with
// Electron safeStorage (DPAPI on Windows) and are decrypted only here, at connect time —
// the renderer never receives a plaintext password.
//
// One ImapFlow connection is pooled per account; every folder operation grabs a mailbox
// lock so operations on the same connection are serialized (per imapflow guidance).
const { ipcMain, safeStorage, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const { EMAIL_ACCOUNTS_FILE, EMAIL_ATTACH_DIR, EMAIL_PROVIDERS } = require('../config');
const oauth = require('./oauth');
const { normalizeIcs } = require('./calendar');

// ───────────────────────── Account store (encrypted) ─────────────────────────

function loadAccounts() {
  try {
    const raw = fs.readFileSync(EMAIL_ACCOUNTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

function saveAccounts(accounts) {
  fs.mkdirSync(path.dirname(EMAIL_ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(EMAIL_ACCOUNTS_FILE, JSON.stringify({ accounts }, null, 2), 'utf8');
}

function getAccount(id) {
  return loadAccounts().find(a => a.id === id);
}

// Strip the secret before anything crosses to the renderer.
function publicAccount(a) {
  return {
    id: a.id, name: a.name, email: a.email, color: a.color,
    user: a.user, imap: a.imap, smtp: a.smtp, provider: a.provider,
    authType: a.authType || 'password',
  };
}

function encryptSecret(plain) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption unavailable — cannot securely store credentials.');
  }
  return safeStorage.encryptString(plain).toString('base64');
}
const encryptPassword = encryptSecret; // alias kept for the app-password paths

function decryptSecret(enc) {
  return safeStorage.decryptString(Buffer.from(enc, 'base64'));
}

function decryptPassword(account) {
  return decryptSecret(account.passwordEnc);
}

// ───────────────────────── OAuth access tokens ─────────────────────────

const tokenCache = new Map(); // accountId -> { accessToken, expiresAt }

// Return a valid access token for an OAuth account, refreshing (and persisting a
// rotated refresh token) as needed.
async function getAccessToken(account) {
  const cached = tokenCache.get(account.id);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.accessToken;

  const refreshToken = decryptSecret(account.oauthRefreshEnc);
  const res = await oauth.refresh(refreshToken);
  tokenCache.set(account.id, { accessToken: res.accessToken, expiresAt: Date.now() + res.expiresIn * 1000 });

  if (res.refreshToken && res.refreshToken !== refreshToken) {
    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.id === account.id);
    if (idx !== -1) { accounts[idx].oauthRefreshEnc = encryptSecret(res.refreshToken); saveAccounts(accounts); }
  }
  return res.accessToken;
}

// Build the auth object for imapflow / nodemailer based on the account's auth type.
async function imapAuth(account) {
  if (account.authType === 'oauth') return { user: account.user, accessToken: await getAccessToken(account) };
  return { user: account.user, pass: decryptPassword(account) };
}
async function smtpAuth(account) {
  if (account.authType === 'oauth') return { type: 'OAuth2', user: account.user, accessToken: await getAccessToken(account) };
  return { user: account.user, pass: decryptPassword(account) };
}

function genId() {
  return 'acct_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

// ───────────────────────── IMAP connection pool ─────────────────────────

const pool = new Map(); // accountId -> ImapFlow

async function buildImap(account) {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: await imapAuth(account),
    logger: false,
    emitLogs: false,
  });
}

async function getImap(accountId) {
  let client = pool.get(accountId);
  if (client && client.usable) return client;
  if (client) { try { await client.logout(); } catch {} pool.delete(accountId); }

  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  client = await buildImap(account);
  client.on('error', () => { pool.delete(accountId); });
  client.on('close', () => { pool.delete(accountId); });
  await client.connect();
  pool.set(accountId, client);
  return client;
}

async function closeAccount(accountId) {
  const client = pool.get(accountId);
  pool.delete(accountId);
  if (client) { try { await client.logout(); } catch {} }
}

// Find a folder by IMAP special-use flag (e.g. '\\Sent', '\\Trash'), with name fallbacks.
async function findSpecialFolder(client, specialUse, fallbacks) {
  const list = await client.list();
  const special = list.find(m => m.specialUse === specialUse);
  if (special) return special.path;
  for (const fb of fallbacks) {
    const hit = list.find(m => m.path.toLowerCase() === fb.toLowerCase());
    if (hit) return hit.path;
  }
  return null;
}

// ───────────────────────── Mapping helpers ─────────────────────────

function addr(a) {
  if (!a) return null;
  return { name: a.name || '', address: a.address || '' };
}
function addrList(arr) {
  return (arr || []).map(addr).filter(Boolean);
}

// Normalize a subject for cheap thread grouping (strip re:/fwd: prefixes).
function threadKey(subject) {
  return (subject || '(no subject)')
    .replace(/^(\s*(re|fwd|fw|aw|wg)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase() || '(no subject)';
}

function mapEnvelope(msg) {
  const env = msg.envelope || {};
  const flags = msg.flags || new Set();
  return {
    uid: msg.uid,
    seq: msg.seq,
    subject: env.subject || '(no subject)',
    from: addr((env.from || [])[0]),
    to: addrList(env.to),
    date: env.date || msg.internalDate || null,
    messageId: env.messageId || '',
    inReplyTo: env.inReplyTo || '',
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    threadKey: threadKey(env.subject),
  };
}

// ───────────────────────── Message operations ─────────────────────────

async function listMessages(accountId, folder, opts = {}) {
  const limit = Math.min(opts.limit || 50, 200);
  const offset = opts.offset || 0;
  const client = await getImap(accountId);
  const lock = await client.getMailboxLock(folder);
  try {
    const total = client.mailbox.exists || 0;
    if (total === 0) return { messages: [], total: 0 };
    const end = Math.max(1, total - offset);
    const start = Math.max(1, end - limit + 1);
    if (end < 1) return { messages: [], total };

    const messages = [];
    for await (const msg of client.fetch(`${start}:${end}`, {
      uid: true, envelope: true, flags: true, internalDate: true,
    })) {
      messages.push(mapEnvelope(msg));
    }
    messages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return { messages, total };
  } finally {
    lock.release();
  }
}

async function getMessage(accountId, folder, uid, { markSeen = true } = {}) {
  const client = await getImap(accountId);
  const lock = await client.getMailboxLock(folder);
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('Message not found');
    const parsed = await simpleParser(msg.source);

    if (markSeen && !(msg.flags || new Set()).has('\\Seen')) {
      try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch {}
    }

    return {
      uid,
      subject: parsed.subject || '(no subject)',
      from: parsed.from?.value?.[0] ? addr(parsed.from.value[0]) : null,
      to: addrList(parsed.to?.value),
      cc: addrList(parsed.cc?.value),
      date: parsed.date || null,
      messageId: parsed.messageId || '',
      inReplyTo: parsed.inReplyTo || '',
      references: [].concat(parsed.references || []),
      html: parsed.html || null,
      text: parsed.text || '',
      textAsHtml: parsed.textAsHtml || '',
      attachments: (parsed.attachments || []).map((a, i) => ({
        index: i,
        filename: a.filename || `attachment-${i + 1}`,
        contentType: a.contentType || 'application/octet-stream',
        size: a.size || (a.content ? a.content.length : 0),
        cid: a.cid || null,
      })),
    };
  } finally {
    lock.release();
  }
}

// Re-fetch + parse to pull one attachment's bytes (kept out of the renderer payload).
async function extractAttachment(accountId, folder, uid, index) {
  const client = await getImap(accountId);
  const lock = await client.getMailboxLock(folder);
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('Message not found');
    const parsed = await simpleParser(msg.source);
    const att = (parsed.attachments || [])[index];
    if (!att) throw new Error('Attachment not found');
    return att; // { filename, content (Buffer), contentType, ... }
  } finally {
    lock.release();
  }
}

// ───────────────────────── SMTP send ─────────────────────────

async function sendMessage(payload) {
  const account = getAccount(payload.accountId);
  if (!account) throw new Error('Account not found');

  const message = {
    from: { name: account.name || '', address: account.email },
    to: payload.to,
    cc: payload.cc || undefined,
    bcc: payload.bcc || undefined,
    subject: payload.subject || '(no subject)',
    text: payload.body || '',
    html: payload.html || undefined,
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.references || undefined,
    attachments: (payload.attachments || []).map(a => ({ filename: a.name, path: a.path })),
  };

  const smtp = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: await smtpAuth(account),
  });
  await smtp.sendMail(message);

  // Build the raw RFC822 once more so we can append a copy to the Sent folder
  // (SMTP delivery does not save to Sent for most providers, e.g. Gmail).
  try {
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' });
    const built = await builder.sendMail(message);
    const client = await getImap(payload.accountId);
    const sentFolder = await findSpecialFolder(client, '\\Sent', ['Sent', 'Sent Items', 'Sent Mail']);
    if (sentFolder) await client.append(sentFolder, built.message, ['\\Seen']);
  } catch {
    // Non-fatal: the mail was sent even if the Sent copy fails.
  }
  return { ok: true };
}

// Verify a candidate account (IMAP login + SMTP login) before persisting it.
async function testConnection(cfg, password) {
  const imap = new ImapFlow({
    host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.secure,
    auth: { user: cfg.user, pass: password }, logger: false, emitLogs: false,
  });
  await imap.connect();
  await imap.logout();

  const smtp = nodemailer.createTransport({
    host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure,
    auth: { user: cfg.user, pass: password },
  });
  await smtp.verify();
  return { ok: true };
}

// ───────────────────────── Calendar invite scanning ─────────────────────────

// Walk an imapflow bodyStructure tree, collecting part IDs that hold an iCal payload.
function findCalendarParts(node, acc = []) {
  if (!node) return acc;
  const fn = (node.dispositionParameters && node.dispositionParameters.filename) ||
             (node.parameters && node.parameters.name) || '';
  if (node.type === 'text/calendar' || /\.ics$/i.test(fn)) {
    if (node.part) acc.push(node.part);
  }
  if (Array.isArray(node.childNodes)) node.childNodes.forEach(c => findCalendarParts(c, acc));
  return acc;
}

// Scan one account's INBOX (last ~90 days, capped) for meeting invites and parse them.
async function scanAccountInvites(accountId) {
  const client = await getImap(accountId);
  const lock = await client.getMailboxLock('INBOX');
  const out = [];
  try {
    const since = new Date(Date.now() - 90 * 86400000);
    let uids = await client.search({ since }, { uid: true });
    if (!uids || !uids.length) return out;
    uids = uids.slice(-150); // most recent only

    const withCal = [];
    for await (const msg of client.fetch(uids, { uid: true, bodyStructure: true }, { uid: true })) {
      const parts = findCalendarParts(msg.bodyStructure);
      if (parts.length) withCal.push({ uid: msg.uid, part: parts[0] });
    }

    for (const { uid, part } of withCal) {
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, bodyParts: [part] }, { uid: true });
        const buf = msg && msg.bodyParts && msg.bodyParts.get(part);
        if (!buf) continue;
        const text = buf.toString('utf8');
        if (!/BEGIN:VCALENDAR/i.test(text)) continue;
        for (const ev of normalizeIcs(text, 'email')) out.push(ev);
      } catch { /* skip unreadable invite */ }
    }
  } finally {
    lock.release();
  }
  return out;
}

// ───────────────────────── Registration ─────────────────────────

module.exports = function register(getMainWindow) {
  ipcMain.handle('email:listProviders', () => EMAIL_PROVIDERS);

  ipcMain.handle('email:oauthConfigured', () => oauth.isConfigured());

  ipcMain.handle('email:listAccounts', () => loadAccounts().map(publicAccount));

  ipcMain.handle('email:testConnection', async (e, cfg, password) => testConnection(cfg, password));

  // OAuth account: interactive Microsoft sign-in, verify IMAP, then persist with the
  // refresh token encrypted at rest. The refresh token never reaches the renderer.
  ipcMain.handle('email:addOAuthAccount', async (e, opts = {}) => {
    const provider = opts.provider || 'outlook';
    const preset = EMAIL_PROVIDERS[provider] || EMAIL_PROVIDERS.outlook;
    const signin = await oauth.interactiveSignIn(getMainWindow);
    if (!signin.email) throw new Error('Could not determine your email address from Microsoft.');
    if (!signin.refreshToken) throw new Error('Microsoft did not return a refresh token — check that offline_access is granted.');

    const account = {
      id: genId(),
      name: opts.name || signin.email,
      email: signin.email,
      user: signin.email,
      color: opts.color || '#3B82F6',
      provider,
      authType: 'oauth',
      imap: preset.imap,
      smtp: preset.smtp,
      oauthRefreshEnc: encryptSecret(signin.refreshToken),
    };

    // Reuse the freshly issued access token to verify IMAP login before persisting.
    tokenCache.set(account.id, { accessToken: signin.accessToken, expiresAt: Date.now() + signin.expiresIn * 1000 });
    const imap = new ImapFlow({
      host: account.imap.host, port: account.imap.port, secure: account.imap.secure,
      auth: { user: account.user, accessToken: signin.accessToken }, logger: false, emitLogs: false,
    });
    await imap.connect();
    await imap.logout();

    const accounts = loadAccounts();
    accounts.push(account);
    saveAccounts(accounts);
    return publicAccount(account);
  });

  ipcMain.handle('email:addAccount', async (e, cfg, password) => {
    // Prove the credentials work before we store anything.
    await testConnection(cfg, password);
    const accounts = loadAccounts();
    const account = {
      id: genId(),
      name: cfg.name || cfg.email,
      email: cfg.email,
      user: cfg.user || cfg.email,
      color: cfg.color || '#3B82F6',
      provider: cfg.provider || 'custom',
      imap: cfg.imap,
      smtp: cfg.smtp,
      passwordEnc: encryptPassword(password),
    };
    accounts.push(account);
    saveAccounts(accounts);
    return publicAccount(account);
  });

  ipcMain.handle('email:updateAccount', async (e, id, updates, password) => {
    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.id === id);
    if (idx === -1) throw new Error('Account not found');
    const merged = { ...accounts[idx], ...updates, id };
    if (password) {
      await testConnection(merged, password);
      merged.passwordEnc = encryptPassword(password);
    }
    accounts[idx] = merged;
    saveAccounts(accounts);
    await closeAccount(id); // force reconnect with new settings
    return publicAccount(merged);
  });

  ipcMain.handle('email:removeAccount', async (e, id) => {
    await closeAccount(id);
    tokenCache.delete(id);
    saveAccounts(loadAccounts().filter(a => a.id !== id));
    return { ok: true };
  });

  ipcMain.handle('email:listFolders', async (e, accountId) => {
    const client = await getImap(accountId);
    const list = await client.list();
    return list
      .filter(m => !m.flags?.has('\\Noselect'))
      .map(m => ({
        path: m.path,
        name: m.name,
        specialUse: m.specialUse || null,
        delimiter: m.delimiter || '/',
      }));
  });

  ipcMain.handle('email:listMessages', async (e, accountId, folder, opts) =>
    listMessages(accountId, folder, opts));

  // Unified inbox: fan out across every account's INBOX, merge, sort by date.
  ipcMain.handle('email:listUnified', async (e, opts = {}) => {
    const accounts = loadAccounts();
    const limit = Math.min(opts.limit || 40, 100);
    const results = await Promise.allSettled(
      accounts.map(a => listMessages(a.id, 'INBOX', { limit }))
    );
    const merged = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const acct = accounts[i];
        r.value.messages.forEach(m => merged.push({
          ...m, accountId: acct.id, accountColor: acct.color, accountEmail: acct.email, folder: 'INBOX',
        }));
      }
    });
    merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return { messages: merged.slice(0, limit * accounts.length) };
  });

  ipcMain.handle('email:getMessage', async (e, accountId, folder, uid) =>
    getMessage(accountId, folder, uid));

  ipcMain.handle('email:search', async (e, accountId, folder, query) => {
    const client = await getImap(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
      if (!uids || uids.length === 0) return { messages: [] };
      const recent = uids.slice(-100);
      const messages = [];
      for await (const msg of client.fetch(recent, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
        messages.push(mapEnvelope(msg));
      }
      messages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      return { messages };
    } finally {
      lock.release();
    }
  });

  ipcMain.handle('email:setFlags', async (e, accountId, folder, uid, flags, add) => {
    const client = await getImap(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      if (add) await client.messageFlagsAdd(String(uid), flags, { uid: true });
      else await client.messageFlagsRemove(String(uid), flags, { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });

  ipcMain.handle('email:move', async (e, accountId, folder, uid, target) => {
    const client = await getImap(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(String(uid), target, { uid: true });
      return { ok: true };
    } finally {
      lock.release();
    }
  });

  ipcMain.handle('email:delete', async (e, accountId, folder, uid) => {
    const client = await getImap(accountId);
    const trash = await findSpecialFolder(client, '\\Trash', ['Trash', 'Deleted', 'Deleted Items']);
    const lock = await client.getMailboxLock(folder);
    try {
      if (trash && trash !== folder) {
        await client.messageMove(String(uid), trash, { uid: true });
      } else {
        await client.messageDelete(String(uid), { uid: true });
      }
      return { ok: true };
    } finally {
      lock.release();
    }
  });

  ipcMain.handle('email:sendMessage', async (e, payload) => sendMessage(payload));

  // Scan every account's inbox for meeting invites (.ics), returning normalized events.
  ipcMain.handle('email:scanInvites', async () => {
    const accounts = loadAccounts();
    const results = await Promise.allSettled(accounts.map(a => scanAccountInvites(a.id)));
    const seen = new Set();
    const events = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const ev of r.value) {
        if (seen.has(ev.extId)) continue;
        seen.add(ev.extId);
        events.push(ev);
      }
    }
    return events;
  });

  // Save an attachment: open=true → write to temp dir and open with the OS;
  // otherwise prompt a Save dialog.
  ipcMain.handle('email:saveAttachment', async (e, accountId, folder, uid, index, open) => {
    const att = await extractAttachment(accountId, folder, uid, index);
    const filename = att.filename || `attachment-${index + 1}`;
    if (open) {
      fs.mkdirSync(EMAIL_ATTACH_DIR, { recursive: true });
      const dest = path.join(EMAIL_ATTACH_DIR, filename);
      fs.writeFileSync(dest, att.content);
      await shell.openPath(dest);
      return { ok: true, path: dest };
    }
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: filename });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, att.content);
    return { ok: true, path: filePath };
  });
};
