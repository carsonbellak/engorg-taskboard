// IPC handlers: Claude / Anthropic link — the user's own API key powers the
// app's "Claude agent" features. The first one is the Syllabus Importer: hand a
// syllabus (PDF / image / pasted text) to Claude and get back structured calendar
// events the renderer drops onto the calendar.
//
// The API key is encrypted at rest with Electron safeStorage (DPAPI on Windows),
// decrypted only here in the main process, and NEVER sent to the renderer —
// claude:status returns just { connected, model }. We call the Anthropic Messages
// API directly with the global fetch (Electron/Node 20), matching how the other
// integrations here talk to their APIs (DigiKey, GitHub) instead of pulling in an
// SDK. Anthropic reads PDFs and images natively (document/image content blocks),
// so no local PDF parser is needed.
const { ipcMain, safeStorage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  CLAUDE_CREDS_FILE, ANTHROPIC_API_URL, ANTHROPIC_VERSION,
  CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL,
} = require('../config');

const MAX_FILE_BYTES = 15 * 1024 * 1024;   // keep well under the API's 32 MB request cap
const VALID_MODELS = new Set((CLAUDE_MODELS || []).map(m => m.id));

// ── credential store ────────────────────────────────────────────────────────
function loadStore() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_CREDS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function saveStore(obj) {
  fs.mkdirSync(path.dirname(CLAUDE_CREDS_FILE), { recursive: true });
  fs.writeFileSync(CLAUDE_CREDS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}
function encrypt(plain) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable — cannot securely store your API key.');
  return safeStorage.encryptString(plain).toString('base64');
}
function decrypt(enc) { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }

function getKey() {
  const s = loadStore();
  if (!s.keyEnc) throw new Error('Claude is not connected.');
  return decrypt(s.keyEnc);
}
function getModel() {
  const s = loadStore();
  return VALID_MODELS.has(s.model) ? s.model : CLAUDE_DEFAULT_MODEL;
}

// ── media typing ──────────────────────────────────────────────────────────────
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.rtf']);

// Build the user content block(s) for a picked file or pasted text.
function buildInputBlocks({ filePath, text }) {
  if (text && text.trim()) {
    return { blocks: [{ type: 'text', text: `SYLLABUS TEXT:\n\n${text.trim()}` }], label: 'pasted text' };
  }
  if (!filePath) throw new Error('No syllabus file or text provided.');
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error('That file is too large (max 15 MB). Try exporting a lighter PDF or pasting the text.');
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);

  if (ext === '.pdf') {
    const data = fs.readFileSync(filePath).toString('base64');
    return {
      blocks: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }],
      label: name,
    };
  }
  if (IMAGE_TYPES[ext]) {
    const data = fs.readFileSync(filePath).toString('base64');
    return {
      blocks: [{ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data } }],
      label: name,
    };
  }
  if (TEXT_EXTS.has(ext)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { blocks: [{ type: 'text', text: `SYLLABUS TEXT (from ${name}):\n\n${raw}` }], label: name };
  }
  throw new Error(`Unsupported file type "${ext}". Use a PDF, an image (PNG/JPG), a .txt, or paste the text. (For .docx, export to PDF or paste the text.)`);
}

// ── extraction prompt ─────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return [
    'You are a precise information-extraction engine for university course syllabi.',
    'You are given a syllabus as a PDF, an image, or plain text. Extract every schedulable, dated calendar item:',
    'assignments/homework due dates, quizzes, exams (midterms/finals), projects and milestones, labs, presentations,',
    'and important one-off class dates (no-class days, holidays, add/drop deadlines).',
    '',
    'Rules:',
    '- Output STRICT JSON only. No markdown, no code fences, no commentary.',
    '- Resolve EVERY date to an absolute calendar date in YYYY-MM-DD. If a date is written without a year, infer the',
    '  correct year from the term/semester and the reference date so the item falls within the course term.',
    '- If an item has no determinable date, omit it. Never invent dates or items.',
    '- Do NOT expand routine recurring meetings (lectures, office hours) into many rows. Only include recurring items',
    '  when the syllabus lists specific dates for them, and always include one-off deadlines and exams.',
    '- Times: 24-hour "HH:MM" or null. Set "allDay": true when no specific time is given.',
    '- "type" must be one of: assignment, quiz, exam, project, lab, lecture, holiday, other.',
    '',
    'Return exactly this JSON shape:',
    '{',
    '  "course": { "name": string|null, "code": string|null, "term": string|null },',
    '  "events": [',
    '    { "title": string, "type": string, "date": "YYYY-MM-DD", "startTime": "HH:MM"|null,',
    '      "endTime": "HH:MM"|null, "allDay": boolean, "location": string|null, "notes": string|null }',
    '  ]',
    '}',
  ].join('\n');
}

// Per-model tuning for the extraction request. Most models use a minimal request
// (no thinking / no output_config) so the same body is valid across the lineup —
// notably effort 400s on Haiku 4.5, and omitting `thinking` already means "off" there.
// Opus 4.8 is offered explicitly as a fast option: thinking disabled + medium effort.
function modelRequestOpts(model) {
  if (model === 'claude-opus-4-8') {
    return { thinking: { type: 'disabled' }, output_config: { effort: 'medium' } };
  }
  return {};
}

// Pull the JSON object out of the model's text response (tolerating stray fences).
function parseModelJson(text) {
  if (!text) throw new Error('Empty response from Claude.');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Fall back to the outermost { … } if there's leading/trailing prose.
  if (t[0] !== '{') {
    const first = t.indexOf('{'); const last = t.lastIndexOf('}');
    if (first !== -1 && last !== -1) t = t.slice(first, last + 1);
  }
  return JSON.parse(t);
}

// ── Anthropic API ─────────────────────────────────────────────────────────────
async function anthropicFetch(pathname, { method = 'GET', body, key } = {}) {
  const res = await fetch(ANTHROPIC_API_URL + pathname, {
    method,
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

function friendlyError(status, payload) {
  const msg = (payload && payload.error && payload.error.message) || '';
  // Organization-scoped keys need an anthropic-workspace-id header for Messages API
  // calls, which this app doesn't send — steer the user to a workspace-scoped key.
  if (/workspace/i.test(msg)) return 'This looks like an Organization-scoped key. Create a key with the "Default workspace" scope instead.';
  if (status === 401) return 'Invalid API key. Check the key from console.anthropic.com.';
  if (status === 403) return 'This API key is not permitted to make this request.';
  if (status === 429) return 'Rate limited by Anthropic — wait a moment and try again.';
  if (status === 400 && /credit balance|billing/i.test(msg)) return 'Your Anthropic account has no available credit. Add credits in the Anthropic Console.';
  if (status >= 500) return 'Anthropic had a server error — try again shortly.';
  return msg || `Request failed (HTTP ${status}).`;
}

module.exports = function register(getMainWindow) {
  ipcMain.handle('claude:status', async () => {
    const s = loadStore();
    return { connected: !!s.keyEnc, model: getModel(), models: CLAUDE_MODELS };
  });

  // Validate the key with a cheap GET /v1/models (no tokens spent) and store it.
  ipcMain.handle('claude:connect', async (_e, apiKey, model) => {
    try {
      const key = (apiKey || '').trim();
      if (!key) return { error: 'Enter your Anthropic API key.' };
      const res = await anthropicFetch('/v1/models', { key });
      if (!res.ok) {
        let payload = null; try { payload = await res.json(); } catch {}
        return { error: friendlyError(res.status, payload) };
      }
      const s = loadStore();
      s.keyEnc = encrypt(key);
      if (VALID_MODELS.has(model)) s.model = model;
      else if (!VALID_MODELS.has(s.model)) s.model = CLAUDE_DEFAULT_MODEL;
      saveStore(s);
      return { connected: true, model: getModel() };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  });

  ipcMain.handle('claude:setModel', async (_e, model) => {
    if (!VALID_MODELS.has(model)) return { error: 'Unknown model.' };
    const s = loadStore();
    s.model = model;
    saveStore(s);
    return { model };
  });

  ipcMain.handle('claude:disconnect', async () => {
    try { fs.unlinkSync(CLAUDE_CREDS_FILE); } catch {}
    return { connected: false };
  });

  // Native picker for a syllabus file (PDF / image / text).
  ipcMain.handle('claude:selectSyllabus', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose a syllabus',
      properties: ['openFile'],
      filters: [
        { name: 'Syllabus', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'csv'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const fp = result.filePaths[0];
    return { name: path.basename(fp), path: fp };
  });

  // The core call: syllabus in → structured { course, events } out.
  ipcMain.handle('claude:extractSyllabus', async (_e, { filePath, text } = {}) => {
    let key;
    try { key = getKey(); } catch (e) { return { error: e.message }; }

    let input;
    try { input = buildInputBlocks({ filePath, text }); }
    catch (e) { return { error: e.message }; }

    const today = new Date().toISOString().slice(0, 10);
    const instruction = {
      type: 'text',
      text: `Today's date is ${today}. Extract the calendar items from the syllabus above and return the JSON object described in your instructions. Remember: JSON only.`,
    };
    const model = getModel();
    const body = {
      model,
      max_tokens: 8000,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: [...input.blocks, instruction] }],
      ...modelRequestOpts(model),
    };

    let res;
    try { res = await anthropicFetch('/v1/messages', { method: 'POST', body, key }); }
    catch (e) { return { error: 'Could not reach Anthropic: ' + (e.message || e) }; }

    if (!res.ok) {
      let payload = null; try { payload = await res.json(); } catch {}
      return { error: friendlyError(res.status, payload) };
    }

    let data;
    try { data = await res.json(); } catch (e) { return { error: 'Malformed response from Anthropic.' }; }
    if (data.stop_reason === 'refusal') return { error: 'Claude declined to process this document.' };

    const textOut = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    let parsed;
    try { parsed = parseModelJson(textOut); }
    catch (e) { return { error: 'Could not read the extracted schedule. Try a clearer PDF or paste the text.' }; }

    const events = Array.isArray(parsed.events) ? parsed.events.filter(ev => ev && ev.title && /^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) : [];
    return {
      course: parsed.course || null,
      events,
      source: input.label,
      model: body.model,
      usage: data.usage || null,
    };
  });
};
