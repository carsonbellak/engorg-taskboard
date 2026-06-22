const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');
const webpush = require('web-push');

initializeApp();
const db = getFirestore();

/**
 * ICS Calendar Feed — secured with a random token.
 * URL uses a token instead of UID so no sensitive data is exposed.
 * Token is stored in Firestore at: calendarTokens/{token} -> { uid }
 */
exports.calendarFeed = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  const token = req.query.token;
  if (!token) {
    res.status(400).send('Missing token parameter');
    return;
  }

  try {
    // Look up which user this token belongs to
    const tokenDoc = await db.doc(`calendarTokens/${token}`).get();
    if (!tokenDoc.exists) {
      res.status(403).send('Invalid or expired token');
      return;
    }

    const uid = tokenDoc.data().uid;
    const scheduleDoc = await db.doc(`users/${uid}/data/schedule`).get();
    if (!scheduleDoc.exists) {
      res.status(404).send('No schedule data found');
      return;
    }

    const data = scheduleDoc.data();
    const events = data.items || [];

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//EngOrg//Engineering Task Board//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:EngOrg',
      'X-WR-TIMEZONE:America/New_York',
      'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
      'X-PUBLISHED-TTL:PT30M',
    ];

    for (const evt of events) {
      if (!evt.date || !evt.title) continue;

      const dateStr = evt.date.replace(/-/g, '');
      const eventUid = evt.id || `engorg-${dateStr}-${Math.random().toString(36).slice(2, 8)}`;

      lines.push('BEGIN:VEVENT');

      if (evt.startTime) {
        const st = evt.startTime.replace(':', '') + '00';
        lines.push(`DTSTART:${dateStr}T${st}`);
        if (evt.endTime) {
          const et = evt.endTime.replace(':', '') + '00';
          lines.push(`DTEND:${dateStr}T${et}`);
        } else {
          const [h, m] = evt.startTime.split(':').map(Number);
          const endH = String(h + 1).padStart(2, '0');
          const endM = String(m).padStart(2, '0');
          lines.push(`DTEND:${dateStr}T${endH}${endM}00`);
        }
      } else {
        lines.push(`DTSTART;VALUE=DATE:${dateStr}`);
        const d = new Date(evt.date);
        d.setDate(d.getDate() + 1);
        const nextDay = d.toISOString().slice(0, 10).replace(/-/g, '');
        lines.push(`DTEND;VALUE=DATE:${nextDay}`);
      }

      const stamp = evt.createdAt
        ? new Date(evt.createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z')
        : new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
      lines.push(`DTSTAMP:${stamp}`);
      lines.push(`UID:${eventUid}@engorg`);
      lines.push(`SUMMARY:${escapeICS(evt.title)}`);

      if (evt.description) {
        lines.push(`DESCRIPTION:${escapeICS(evt.description)}`);
      }

      lines.push(evt.completed ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED');

      lines.push('BEGIN:VALARM');
      lines.push('TRIGGER:-PT15M');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${escapeICS(evt.title)}`);
      lines.push('END:VALARM');

      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="engorg.ics"');
    res.set('Cache-Control', 'public, max-age=1800');
    res.send(lines.join('\r\n'));
  } catch (err) {
    console.error('Calendar feed error:', err);
    res.status(500).send('Internal error');
  }
});

/**
 * Generate a calendar token for the authenticated user.
 * Called from the app to get a shareable calendar URL.
 * Requires uid and a valid Firebase ID token for verification.
 */
exports.generateCalendarToken = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const { getAuth } = require('firebase-admin/auth');
    const idToken = authHeader.split('Bearer ')[1];
    const decoded = await getAuth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // Check if user already has a token
    const existing = await db.collection('calendarTokens')
      .where('uid', '==', uid).limit(1).get();

    if (!existing.empty) {
      const existingToken = existing.docs[0].id;
      res.json({ token: existingToken });
      return;
    }

    // Generate a new random token
    const token = crypto.randomBytes(32).toString('hex');
    await db.doc(`calendarTokens/${token}`).set({
      uid,
      createdAt: new Date().toISOString()
    });

    res.json({ token });
  } catch (err) {
    console.error('Token generation error:', err);
    res.status(500).send('Internal error');
  }
});

// ============ SHORTCUTS API ============

/**
 * Helper: verify an API token from the Authorization header.
 * Returns the uid if valid, or sends an error response and returns null.
 */
async function verifyApiToken(req, res) {
  // Accept token from Authorization header (Bearer token) OR as a query/body param
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split('Bearer ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  } else if (req.body && req.body.token) {
    token = req.body.token;
  }

  if (!token) {
    res.status(401).json({ error: 'Missing API token' });
    return null;
  }
  const tokenDoc = await db.doc(`apiTokens/${token}`).get();
  if (!tokenDoc.exists) {
    res.status(401).json({ error: 'Invalid or expired API token' });
    return null;
  }
  return tokenDoc.data().uid;
}

/**
 * Generate a long-lived API token for Apple Shortcuts integration.
 * Requires a valid Firebase ID token for initial authentication.
 * Token is stored in Firestore at: apiTokens/{token} -> { uid, createdAt }
 */
exports.generateApiToken = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const { getAuth } = require('firebase-admin/auth');
    const idToken = authHeader.split('Bearer ')[1];
    const decoded = await getAuth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // Check if user already has an API token
    const existing = await db.collection('apiTokens')
      .where('uid', '==', uid).limit(1).get();

    if (!existing.empty) {
      const existingToken = existing.docs[0].id;
      res.json({ token: existingToken });
      return;
    }

    // Generate a new random token
    const token = crypto.randomBytes(32).toString('hex');
    await db.doc(`apiTokens/${token}`).set({
      uid,
      createdAt: new Date().toISOString()
    });

    res.json({ token });
  } catch (err) {
    console.error('API token generation error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * List the user's projects and categories for Apple Shortcuts pickers.
 * Authenticated via long-lived API token.
 */
exports.listProjects = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  try {
    const uid = await verifyApiToken(req, res);
    if (!uid) return;

    const [projectsDoc, settingsDoc] = await Promise.all([
      db.doc(`users/${uid}/data/projects`).get(),
      db.doc(`users/${uid}/data/settings`).get()
    ]);

    const projects = projectsDoc.exists
      ? (projectsDoc.data().projects || []).map(p => ({ id: p.id, name: p.name }))
      : [];

    const defaultCategories = [
      { id: 'mechanical', name: 'Mechanical' },
      { id: 'electrical', name: 'Electrical' },
      { id: 'purchasing', name: 'Purchasing' },
      { id: 'meeting', name: 'Meeting' }
    ];

    let categories = defaultCategories;
    if (settingsDoc.exists && settingsDoc.data().categories) {
      categories = settingsDoc.data().categories.map(c => ({ id: c.id, name: c.name }));
    }

    // Also provide plain string arrays so Apple Shortcuts' "Choose from List"
    // can speak them aloud / render them without needing Get Dictionary Value loops.
    const projectNames = projects.map(p => p.name);
    const categoryNames = categories.map(c => c.name);

    res.json({ projects, categories, projectNames, categoryNames });
  } catch (err) {
    console.error('listProjects error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Create a new note via Apple Shortcuts / external API.
 * Authenticated via long-lived API token.
 *
 * Body fields:
 *   title (required), projectName or projectId, priority, description,
 *   status, categoryName or category, dueDate, dueTime, checklist (comma-separated string or array)
 */
exports.addNote = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'GET or POST required' });
    return;
  }

  try {
    // Merge query params and body so both GET (Siri URL approach) and POST (JSON) work.
    // GET is used by the Siri shortcut (far simpler to build URLs than JSON bodies).
    const body = Object.assign({}, req.query || {}, req.body || {});

    console.log('addNote called — method:', req.method,
      '| auth header present:', !!req.headers.authorization,
      '| params:', JSON.stringify(body));

    const uid = await verifyApiToken(req, res);
    if (!uid) return;
    const title = (body.title || '').trim();
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    // Resolve project — tolerate "skip"/"none"/empty (fall back to first project)
    const projectsDoc = await db.doc(`users/${uid}/data/projects`).get();
    const projects = projectsDoc.exists ? (projectsDoc.data().projects || []) : [];
    const SKIP_WORDS = new Set(['', 'skip', 'none', 'no', 'n/a', 'na']);

    let projectId = body.projectId || '';
    const rawProjectName = (body.projectName || '').trim();
    const projectNameSkip = SKIP_WORDS.has(rawProjectName.toLowerCase());

    if (!projectId && rawProjectName && !projectNameSkip) {
      const name = rawProjectName.toLowerCase();
      let match = projects.find(p => p.name.toLowerCase() === name);
      // If no exact match, try a fuzzy contains match (Siri sometimes transcribes extra words)
      if (!match) match = projects.find(p => p.name.toLowerCase().includes(name) || name.includes(p.name.toLowerCase()));
      if (match) projectId = match.id;
    }
    if (!projectId && projects.length > 0) {
      projectId = projects[0].id;
    }
    if (!projectId) {
      res.status(400).json({ error: 'No projects found. Create a project first.' });
      return;
    }

    // Resolve category
    let category = body.category || '';
    if (!category && body.categoryName) {
      const settingsDoc = await db.doc(`users/${uid}/data/settings`).get();
      const defaultCats = [
        { id: 'mechanical', name: 'Mechanical' },
        { id: 'electrical', name: 'Electrical' },
        { id: 'purchasing', name: 'Purchasing' },
        { id: 'meeting', name: 'Meeting' }
      ];
      const cats = (settingsDoc.exists && settingsDoc.data().categories) || defaultCats;
      const catName = body.categoryName.trim().toLowerCase();
      if (catName !== 'none' && catName !== 'skip' && catName !== '') {
        const match = cats.find(c => c.name.toLowerCase() === catName);
        if (match) category = match.id;
      }
    }

    // Validate priority — handle Siri transcription quirks ("Hi" → "High", etc.)
    const priorityAliases = {
      'high': 'High', 'hi': 'High', 'h': 'High',
      'medium': 'Medium', 'med': 'Medium', 'm': 'Medium', 'mid': 'Medium', 'normal': 'Medium',
      'low': 'Low', 'lo': 'Low', 'l': 'Low'
    };
    const pKey = (body.priority || '').toString().trim().toLowerCase();
    const priority = priorityAliases[pKey] || 'Medium';

    // Validate status — app uses camelCase "inProgress", accept several common variants
    const statusAliases = {
      'backlog': 'backlog',
      'inprogress': 'inProgress',
      'in-progress': 'inProgress',
      'in progress': 'inProgress',
      'progress': 'inProgress',
      'review': 'review',
      'done': 'done',
      'complete': 'done',
      'completed': 'done'
    };
    const sKey = (body.status || 'backlog').toString().trim().toLowerCase();
    const status = statusAliases[sKey] || 'backlog';

    // Parse checklist
    let checklist = [];
    if (body.checklist) {
      const items = Array.isArray(body.checklist)
        ? body.checklist
        : body.checklist.split(',').map(s => s.trim()).filter(Boolean);
      checklist = items.map(text => ({
        id: `cl_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        text,
        done: false,
        completedAt: null
      }));
    }

    // Parse optional fields — normalize "skip"/"none" everywhere
    const rawDesc = (body.description || '').trim();
    const description = SKIP_WORDS.has(rawDesc.toLowerCase()) ? '' : rawDesc;

    // Natural language due date — "this friday", "tomorrow", "April 20", or YYYY-MM-DD
    let dueDate = null;
    const rawDue = (body.dueDate || '').trim();
    if (rawDue && !SKIP_WORDS.has(rawDue.toLowerCase())) {
      try {
        const chrono = require('chrono-node');
        const parsed = chrono.parseDate(rawDue);
        if (parsed) {
          dueDate = parsed.toISOString().slice(0, 10); // YYYY-MM-DD
        } else {
          // Fall back to direct use if it's already YYYY-MM-DD
          dueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : null;
        }
      } catch (e) {
        dueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : null;
      }
    }
    const dueTime = SKIP_WORDS.has((body.dueTime || '').trim().toLowerCase()) ? null : (body.dueTime || null);

    const now = new Date().toISOString();
    const noteId = `note_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    const newNote = {
      id: noteId,
      title,
      description,
      projectId,
      priority,
      status,
      category,
      dueDate,
      dueTime,
      day: null,
      colorIdx: 0,
      completed: false,
      completedAt: null,
      createdAt: now,
      modifiedAt: now,
      checklist,
      attachments: [],
      links: [],
      statusHistory: []
    };

    // Use a transaction to safely append to the tasks array
    const tasksRef = db.doc(`users/${uid}/data/tasks`);
    await db.runTransaction(async (t) => {
      const tasksDoc = await t.get(tasksRef);
      const tasks = tasksDoc.exists ? (tasksDoc.data().tasks || []) : [];
      tasks.push(newNote);
      t.set(tasksRef, {
        tasks,
        _updatedAt: require('firebase-admin/firestore').FieldValue.serverTimestamp(),
        _source: 'shortcuts'
      });
    });

    res.json({ success: true, noteId, title });
  } catch (err) {
    console.error('addNote error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Generate and serve a downloadable .shortcut file for Apple Shortcuts.
 * The API token is baked into the shortcut so the user doesn't need to configure it.
 * URL: /api/getShortcut?token=<apiToken>
 */
exports.getShortcut = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  const apiToken = req.query.token;
  if (!apiToken) {
    res.status(400).send('Missing token parameter');
    return;
  }

  // Verify the token is valid
  const tokenDoc = await db.doc(`apiTokens/${apiToken}`).get();
  if (!tokenDoc.exists) {
    res.status(403).send('Invalid token');
    return;
  }

  const baseUrl = 'https://assistant-taskboard.firebaseapp.com';
  const plist = buildShortcutPlist(apiToken, baseUrl);

  res.set('Content-Type', 'application/x-apple-shortcut');
  res.set('Content-Disposition', 'attachment; filename="Create Task Board Note.shortcut"');
  res.send(plist);
});

// ============ SHORTCUT PLIST GENERATOR ============

function buildShortcutPlist(apiToken, baseUrl) {
  const OBJ = '\uFFFC'; // Object Replacement Character — variable placeholder
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // --- Plist helper builders ---
  function pStr(s) { return `<string>${esc(s)}</string>`; }
  function pInt(n) { return `<integer>${n}</integer>`; }

  function tokenStr(s) {
    // A plain text token string (no variable references)
    return `<dict>
      <key>Value</key><dict><key>string</key>${pStr(s)}</dict>
      <key>WFSerializationType</key><string>WFTextTokenString</string>
    </dict>`;
  }

  function varTokenStr(varName) {
    // A token string that is entirely a variable reference
    return `<dict>
      <key>Value</key><dict>
        <key>attachmentsByRange</key><dict>
          <key>{0, 1}</key><dict>
            <key>Type</key><string>Variable</string>
            <key>VariableName</key>${pStr(varName)}
          </dict>
        </dict>
        <key>string</key><string>${OBJ}</string>
      </dict>
      <key>WFSerializationType</key><string>WFTextTokenString</string>
    </dict>`;
  }

  function dictField(key, valuePlist) {
    // A single key-value pair for WFDictionaryFieldValueItems
    return `<dict>
      <key>WFItemType</key>${pInt(0)}
      <key>WFKey</key>${tokenStr(key)}
      <key>WFValue</key>${valuePlist}
    </dict>`;
  }

  function dictFieldValue(items) {
    return `<dict>
      <key>Value</key><dict>
        <key>WFDictionaryFieldValueItems</key><array>${items.join('\n')}</array>
      </dict>
      <key>WFSerializationType</key><string>WFDictionaryFieldValue</string>
    </dict>`;
  }

  // --- Action builders ---
  function commentAction(text) {
    return `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.comment</string>
      <key>WFWorkflowActionParameters</key><dict>
        <key>WFCommentActionText</key>${pStr(text)}
      </dict>
    </dict>`;
  }

  function askAction(prompt, defaultAnswer) {
    const defPart = defaultAnswer !== undefined
      ? `<key>WFAskActionDefaultAnswer</key>${pStr(defaultAnswer)}` : '';
    return `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.ask</string>
      <key>WFWorkflowActionParameters</key><dict>
        <key>WFAskActionPrompt</key>${pStr(prompt)}
        ${defPart}
      </dict>
    </dict>`;
  }

  function setVarAction(name) {
    return `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.setvariable</string>
      <key>WFWorkflowActionParameters</key><dict>
        <key>WFVariableName</key>${pStr(name)}
      </dict>
    </dict>`;
  }

  function listAction(items) {
    return `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.list</string>
      <key>WFWorkflowActionParameters</key><dict>
        <key>WFItems</key><array>${items.map(i => pStr(i)).join('\n')}</array>
      </dict>
    </dict>`;
  }

  function chooseFromListAction(prompt) {
    return `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.choosefromlist</string>
      <key>WFWorkflowActionParameters</key><dict>
        <key>WFChooseFromListActionPrompt</key>${pStr(prompt)}
      </dict>
    </dict>`;
  }

  function showResultAction(text) {
    return `<dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.showresult</string>
      <key>WFWorkflowActionParameters</key><dict>
        <key>WFText</key>${tokenStr(text)}
      </dict>
    </dict>`;
  }

  // --- Build the actions list ---
  const actions = [];

  actions.push(commentAction('Engineering Task Board — Create Note via Siri'));

  // 1. Ask for title
  actions.push(askAction("What's the note title?"));
  actions.push(setVarAction('NoteTitle'));

  // 2. Ask for project name
  actions.push(askAction('Which project?'));
  actions.push(setVarAction('ProjectName'));

  // 3. Priority picker
  actions.push(listAction(['High', 'Medium', 'Low']));
  actions.push(chooseFromListAction('What priority?'));
  actions.push(setVarAction('Priority'));

  // 4. Status picker
  actions.push(listAction(['Backlog', 'In Progress', 'Review', 'Done']));
  actions.push(chooseFromListAction('What status?'));
  actions.push(setVarAction('Status'));

  // 5. Category
  actions.push(askAction('Category? (say None to skip)', 'None'));
  actions.push(setVarAction('Category'));

  // 6. Description
  actions.push(askAction('Description? (say Skip for none)', 'Skip'));
  actions.push(setVarAction('Description'));

  // 7. Due date
  actions.push(askAction('Due date? (YYYY-MM-DD or say Skip)', 'Skip'));
  actions.push(setVarAction('DueDate'));

  // 8. Checklist
  actions.push(askAction('Checklist items? (comma-separated, or say Skip)', 'Skip'));
  actions.push(setVarAction('Checklist'));

  // 9. POST to addNote API
  const jsonFields = [
    dictField('title', varTokenStr('NoteTitle')),
    dictField('projectName', varTokenStr('ProjectName')),
    dictField('priority', varTokenStr('Priority')),
    dictField('status', varTokenStr('Status')),
    dictField('categoryName', varTokenStr('Category')),
    dictField('description', varTokenStr('Description')),
    dictField('dueDate', varTokenStr('DueDate')),
    dictField('checklist', varTokenStr('Checklist'))
  ];

  const headerFields = [
    dictField('Authorization', tokenStr(`Bearer ${apiToken}`)),
    dictField('Content-Type', tokenStr('application/json'))
  ];

  actions.push(`<dict>
    <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.downloadurl</string>
    <key>WFWorkflowActionParameters</key><dict>
      <key>WFURL</key>${pStr(baseUrl + '/api/addNote')}
      <key>WFHTTPMethod</key>${pStr('POST')}
      <key>WFHTTPBodyType</key>${pStr('Json')}
      <key>WFJSONValues</key>${dictFieldValue(jsonFields)}
      <key>WFHTTPHeaders</key>${dictFieldValue(headerFields)}
    </dict>
  </dict>`);

  // 10. Show result
  actions.push(showResultAction('Note created! Check your Task Board.'));

  // --- Wrap in full plist ---
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconStartColor</key><integer>463140863</integer>
    <key>WFWorkflowIconGlyphNumber</key><integer>59761</integer>
  </dict>
  <key>WFWorkflowTypes</key>
  <array><string>NCWidget</string><string>WatchKit</string></array>
  <key>WFWorkflowInputContentItemClasses</key>
  <array>
    <string>WFStringContentItem</string>
  </array>
  <key>WFWorkflowActions</key>
  <array>
    ${actions.join('\n    ')}
  </array>
</dict>
</plist>`;
}

function escapeICS(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// ============================================================
// TIMER FEATURE
// ============================================================

function parseDuration(raw) {
  const s = (raw || '').toLowerCase().trim();
  const patterns = [
    [/^(\d+(?:\.\d+)?)\s*h(?:ou?r?s?)?$/, m => Math.round(parseFloat(m[1]) * 3600)],
    [/^(\d+)\s*h(?:ou?r?s?)?\s*(\d+)\s*m(?:in)?/, m => parseInt(m[1]) * 3600 + parseInt(m[2]) * 60],
    [/^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/, m => Math.round(parseFloat(m[1]) * 60)],
    [/^(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?$/, m => Math.round(parseFloat(m[1]))],
    [/^(\d+)$/, m => parseInt(m[1]) >= 60 ? parseInt(m[1]) : parseInt(m[1]) * 60],
  ];
  for (const [re, fn] of patterns) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  try {
    const chrono = require('chrono-node');
    const ref = new Date();
    const parsed = chrono.parseDate(raw, ref, { forwardDate: true });
    if (parsed) {
      const diff = Math.round((parsed.getTime() - ref.getTime()) / 1000);
      if (diff > 0) return diff;
    }
  } catch (e) {}
  return null;
}

function formatDurationShort(seconds) {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

exports.startTimer = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'GET or POST required' }); return;
  }
  try {
    const uid = await verifyApiToken(req, res);
    if (!uid) return;

    const body = Object.assign({}, req.query || {}, req.body || {});
    const label = ((body.label || '').trim() || 'Timer').slice(0, 100);
    const rawDuration = (body.duration || '').trim();

    if (!rawDuration) {
      res.status(400).json({ error: 'duration is required (e.g. "5 minutes", "90 seconds")' }); return;
    }

    const durationSeconds = parseDuration(rawDuration);
    if (!durationSeconds || durationSeconds < 5 || durationSeconds > 86400) {
      res.status(400).json({ error: 'Duration must be between 5 seconds and 24 hours' }); return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationSeconds * 1000);
    const timerId = `timer_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    await db.doc(`timers/${timerId}`).set({
      uid,
      label,
      durationSeconds,
      startedAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromDate(expiresAt),
      status: 'active',
      notificationSent: false,
      createdAt: now.toISOString(),
      createdVia: req.body && Object.keys(req.body).length ? 'shortcut' : 'pwa'
    });

    res.json({
      success: true,
      timerId,
      label,
      durationSeconds,
      expiresAt: expiresAt.toISOString(),
      message: `Timer "${label}" started for ${formatDurationShort(durationSeconds)}.`
    });
  } catch (err) {
    console.error('startTimer error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

exports.cancelTimer = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST required' }); return; }
  try {
    const uid = await verifyApiToken(req, res);
    if (!uid) return;

    const timerId = (req.body || {}).timerId;
    if (!timerId) { res.status(400).json({ error: 'timerId required' }); return; }

    const timerRef = db.doc(`timers/${timerId}`);
    const timerDoc = await timerRef.get();
    if (!timerDoc.exists || timerDoc.data().uid !== uid) {
      res.status(404).json({ error: 'Timer not found' }); return;
    }
    if (timerDoc.data().status !== 'active') {
      res.status(400).json({ error: 'Timer is not active' }); return;
    }

    await timerRef.update({ status: 'cancelled' });
    res.json({ success: true });
  } catch (err) {
    console.error('cancelTimer error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

exports.dismissTimer = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST required' }); return; }
  try {
    const timerId = (req.body || {}).timerId;
    if (!timerId) { res.status(400).json({ error: 'timerId required' }); return; }

    const timerRef = db.doc(`timers/${timerId}`);
    const timerDoc = await timerRef.get();
    if (!timerDoc.exists) { res.status(404).json({ error: 'Not found' }); return; }
    if (timerDoc.data().status !== 'expired') {
      res.json({ ok: true, skipped: true }); return;
    }

    await timerRef.update({ status: 'dismissed', dismissedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('dismissTimer error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

exports.listTimers = onRequest({ cors: true, invoker: 'public' }, async (req, res) => {
  try {
    const uid = await verifyApiToken(req, res);
    if (!uid) return;

    const [activeSnap, recentSnap] = await Promise.all([
      db.collection('timers').where('uid', '==', uid).where('status', '==', 'active')
        .orderBy('expiresAt', 'asc').get(),
      db.collection('timers').where('uid', '==', uid).where('status', '!=', 'active')
        .orderBy('status').orderBy('createdAt', 'desc').limit(20).get()
    ]);

    const toObj = doc => ({
      id: doc.id,
      ...doc.data(),
      expiresAt: doc.data().expiresAt?.toDate?.().toISOString(),
      startedAt: doc.data().startedAt?.toDate?.().toISOString()
    });

    res.json({ active: activeSnap.docs.map(toObj), recent: recentSnap.docs.map(toObj) });
  } catch (err) {
    console.error('listTimers error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

exports.registerPushSubscription = onRequest(
  { cors: true, invoker: 'public', secrets: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST required' }); return; }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return; }

    try {
      const { getAuth } = require('firebase-admin/auth');
      const decoded = await getAuth().verifyIdToken(authHeader.split('Bearer ')[1]);
      const uid = decoded.uid;
      const { subscription } = req.body;

      if (!subscription?.endpoint) { res.status(400).json({ error: 'Invalid subscription' }); return; }

      const endpointHash = crypto.createHash('sha256').update(subscription.endpoint).digest('hex').slice(0, 16);
      await db.doc(`pushSubscriptions/${uid}_${endpointHash}`).set({
        uid,
        subscription,
        endpoint: subscription.endpoint,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('registerPushSubscription error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

exports.fireExpiredTimers = onSchedule(
  {
    schedule: 'every 1 minutes',
    timeZone: 'America/New_York',
    secrets: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']
  },
  async () => {
    const now = Timestamp.now();

    const expired = await db.collection('timers')
      .where('status', '==', 'active')
      .where('notificationSent', '==', false)
      .where('expiresAt', '<=', now)
      .limit(50)
      .get();

    if (expired.empty) return;

    webpush.setVapidDetails(
      'mailto:admin@assistant-taskboard.firebaseapp.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    for (const timerDoc of expired.docs) {
      const timer = timerDoc.data();

      await timerDoc.ref.update({
        status: 'expired',
        notificationSent: true,
        expiredAt: new Date().toISOString()
      });

      const subsSnap = await db.collection('pushSubscriptions')
        .where('uid', '==', timer.uid).get();

      if (subsSnap.empty) continue;

      const payload = JSON.stringify({
        title: `Timer Done: ${timer.label}`,
        body: `Your ${formatDurationShort(timer.durationSeconds)} timer has finished.`,
        timerId: timerDoc.id,
        url: '/#timers'
      });

      await Promise.all(subsSnap.docs.map(async subDoc => {
        try {
          await webpush.sendNotification(subDoc.data().subscription, payload);
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await subDoc.ref.delete();
          } else {
            console.error('Push send error:', err.statusCode, err.body);
          }
        }
      }));
    }
  }
);
