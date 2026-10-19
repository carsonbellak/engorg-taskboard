// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: yellow; icon-glyph: sticky-note;

// EngOrg Quick Note — Scriptable (iOS) widget for the Engineering Task Board.
//
// The home-screen widget is a sticky note in the app's style. Tapping it runs your
// "New Note" Apple Shortcut, which asks for each field in native pop-ups, posts the
// note and returns to the home screen (build it from the web app: Settings → Widgets).
// Running this script inside Scriptable instead opens an editable sticky-note form.
//
// It uses the same token-authenticated Cloud Functions as the Siri shortcut
// (/api/listProjects + /api/addNote), so the note syncs to the desktop app and
// PWA like any other.
//
// Setup: add a Scriptable widget, pick this script. Optional widget Parameter:
// yellow | green | blue | red | purple | orange (sticky color). Run the script once
// in Scriptable to connect your API token; the widget then shows your categories.

const API = 'https://assistant-taskboard.firebaseapp.com/api';
const KC_TOKEN = 'engorg.apiToken';
const KC_STATE = 'engorg.quickNote';
// The Apple Shortcut the widget runs when tapped. Must match its name in Shortcuts.
const SHORTCUT_NAME = 'New Note';

// Mirrors STICKY_COLORS_LIGHT / _DARK in renderer/components/sticky-note.js
const STICKY = {
  yellow: { light: ['#FEF08A', '#EAB308'], dark: ['#423A10', '#A08520'] },
  green:  { light: ['#86EFAC', '#22C55E'], dark: ['#14352A', '#22885A'] },
  blue:   { light: ['#93C5FD', '#3B82F6'], dark: ['#162844', '#3070C0'] },
  red:    { light: ['#FCA5A5', '#EF4444'], dark: ['#3A1818', '#C04040'] },
  purple: { light: ['#C4B5FD', '#8B5CF6'], dark: ['#2A1F48', '#7050B8'] },
  orange: { light: ['#FDBA74', '#F97316'], dark: ['#3A2410', '#C06820'] },
};
const PRIORITY_COLORS = { High: '#EF4444', Medium: '#F97316', Low: '#22C55E' };

// ===================== STATE =====================

function loadState() {
  try { return Keychain.contains(KC_STATE) ? JSON.parse(Keychain.get(KC_STATE)) : {}; }
  catch (_) { return {}; }
}
function saveState(s) { Keychain.set(KC_STATE, JSON.stringify(s)); }

function pickColor(v) {
  v = String(v || '').trim().toLowerCase();
  return STICKY[v] ? v : 'yellow';
}

// ===================== API =====================

async function api(path, token, body) {
  const r = new Request(`${API}/${path}`);
  r.timeoutInterval = 20;
  r.headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (body) { r.method = 'POST'; r.body = JSON.stringify(body); }
  try {
    const json = await r.loadJSON();
    return { code: r.response.statusCode, json };
  } catch (err) {
    return { code: (r.response && r.response.statusCode) || 0, json: null, err };
  }
}

// Accepts the bare 64-hex token or any URL/text containing it.
function extractToken(text) {
  const m = String(text || '').match(/[a-f0-9]{64}/i);
  return m ? m[0] : null;
}

async function showAlert(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}

async function ensureToken() {
  if (Keychain.contains(KC_TOKEN)) return Keychain.get(KC_TOKEN);

  let clip = '';
  try { clip = Pasteboard.pasteString() || ''; } catch (_) {}

  const a = new Alert();
  a.title = 'Connect to your task board';
  a.message =
    'Paste your API token, or any link that contains it.\n\n' +
    'On the phone: open the web app → Settings → Widget → "Copy widget token".\n\n' +
    'On the desktop: Settings → Mobile → "Copy widget token", then send it to your phone.';
  a.addTextField('Token or link', extractToken(clip) ? clip : '');
  a.addAction('Connect');
  a.addCancelAction('Cancel');
  if (await a.presentAlert() === -1) return null;

  const token = extractToken(a.textFieldValue(0));
  if (!token) {
    await showAlert('No token found', 'That text doesn\'t contain an API token. Copy the link again and retry.');
    return null;
  }
  Keychain.set(KC_TOKEN, token);
  return token;
}

// ===================== WIDGET =====================

function widgetColors(colorName) {
  const pal = STICKY[colorName];
  const dyn = (l, d, a) => Color.dynamic(new Color(l, a), new Color(d, a));
  return {
    bg: dyn(pal.light[0], pal.dark[0]),
    edge: dyn(pal.light[1], pal.dark[1]),
    ink: dyn('#1E293B', '#E2E8F0'),
    inkSoft: dyn('#1E293B', '#E2E8F0', 0.6),
    chip: Color.dynamic(new Color('#000000', 0.08), new Color('#FFFFFF', 0.08)),
    chipOn: Color.dynamic(new Color('#FFFFFF', 0.5), new Color('#FFFFFF', 0.14)),
    rule: Color.dynamic(new Color('#000000', 0.1), new Color('#FFFFFF', 0.1)),
  };
}

function buildWidget(state, colorName) {
  const C = widgetColors(colorName);
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}`;

  const family = config.widgetFamily || 'small';
  if (family.startsWith('accessory')) {
    const t = w.addText('＋ New note');
    t.font = Font.boldSystemFont(14);
    return w;
  }
  if (family === 'small') return buildSmallWidget(w, state, C);
  return buildFormWidget(w, state, C, family === 'large' || family === 'extraLarge');
}

// Small widgets allow a single tap target, so they stay a compact "tap to write" note.
function buildSmallWidget(w, state, C) {
  w.setPadding(14, 14, 12, 14);

  const top = w.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  const badge = top.addStack();
  badge.backgroundColor = C.chip;
  badge.cornerRadius = 99;
  badge.setPadding(2, 7, 2, 7);
  const bt = badge.addText('Quick Note');
  bt.font = Font.boldSystemFont(10);
  bt.textColor = C.ink;
  bt.lineLimit = 1;
  top.addSpacer();
  const sym = SFSymbol.named('square.and.pencil');
  sym.applyFont(Font.boldSystemFont(13));
  const pen = top.addImage(sym.image);
  pen.imageSize = new Size(15, 15);
  pen.tintColor = C.edge;

  w.addSpacer(8);
  const title = w.addText('New note');
  title.font = Font.boldSystemFont(15);
  title.textColor = C.ink;
  w.addSpacer(2);
  const hint = w.addText('Tap to jot it down…');
  hint.font = Font.systemFont(12);
  hint.textColor = C.inkSoft;

  w.addSpacer();
  addBottomRow(w, C);
  return w;
}

// Medium/large: draw the sticky-note form. Widgets can't hold real inputs, so the whole
// widget is one tap target that runs the New Note shortcut's pop-ups.
function buildFormWidget(w, state, C, large) {
  w.setPadding(14, 16, 12, 16);
  const innerW = widgetInnerWidth();

  // Top row: project badge + NEW NOTE
  const top = w.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  const badge = top.addStack();
  badge.backgroundColor = C.chip;
  badge.cornerRadius = 99;
  badge.setPadding(3, 9, 3, 9);
  const bt = badge.addText('Project ▾');
  bt.font = Font.boldSystemFont(11);
  bt.textColor = C.ink;
  bt.lineLimit = 1;
  top.addSpacer();
  const kick = top.addText('NEW NOTE');
  kick.font = Font.boldSystemFont(9);
  kick.textColor = C.inkSoft;

  w.addSpacer(large ? 10 : 6);
  const title = w.addText('What needs doing?');
  title.font = Font.semiboldSystemFont(large ? 18 : 16);
  title.textColor = C.inkSoft;

  if (large) {
    w.addSpacer(6);
    const desc = w.addText('Description (optional)');
    desc.font = Font.systemFont(14);
    desc.textColor = C.inkSoft;
    w.addSpacer(8);
    const rule = w.addStack();
    rule.backgroundColor = C.rule;
    rule.size = new Size(innerW, 1);
    w.addSpacer(4);
    sectionLabel(w, 'PRIORITY', C);
  } else {
    w.addSpacer(8);
  }

  // Priority chips
  const prow = w.addStack();
  prow.layoutHorizontally();
  prow.spacing = 6;
  for (const p of ['High', 'Medium', 'Low']) {
    widgetChip(prow, p, C, { dot: PRIORITY_COLORS[p] });
  }

  if (large) {
    const cats = state.categories || [];
    if (cats.length) {
      sectionLabel(w, 'CATEGORY', C);
      // Widgets have no flex-wrap, so wrap the chips into rows by estimated width.
      const rows = [[]];
      let used = 0;
      for (const c of cats) {
        const cw = c.name.length * 7 + 20;
        if (used && used + 6 + cw > innerW) {
          if (rows.length === 3) break;
          rows.push([]);
          used = 0;
        }
        rows[rows.length - 1].push(c);
        used += (used ? 6 : 0) + cw;
      }
      rows.forEach((row, i) => {
        if (i) w.addSpacer(6);
        const r = w.addStack();
        r.layoutHorizontally();
        r.spacing = 6;
        row.forEach(c => widgetChip(r, c.name, C, {}));
      });
    }

    sectionLabel(w, 'DUE', C);
    const due = w.addStack();
    due.layoutHorizontally();
    due.spacing = 8;
    for (const [label, width] of [['Date', 118], ['Time', 84]]) {
      const box = due.addStack();
      box.backgroundColor = C.chip;
      box.cornerRadius = 8;
      box.size = new Size(width, 28);
      box.setPadding(0, 10, 0, 10);
      box.centerAlignContent();
      const t = box.addText(label);
      t.font = Font.systemFont(12);
      t.textColor = C.inkSoft;
      box.addSpacer();
    }
  }

  w.addSpacer();
  addBottomRow(w, C);
  return w;
}

function widgetInnerWidth() {
  let screenW = 390;
  try { const s = Device.screenSize(); screenW = Math.min(s.width, s.height); } catch (_) {}
  // Medium/large widgets span the screen minus ~20pt insets each side, minus our 16pt padding.
  return Math.max(260, Math.min(screenW - 40, 364) - 32);
}

function sectionLabel(w, text, C) {
  w.addSpacer(10);
  const t = w.addText(text);
  t.font = Font.boldSystemFont(9);
  t.textColor = C.inkSoft;
  w.addSpacer(5);
}

function widgetChip(parent, text, C, opts) {
  const s = parent.addStack();
  s.layoutHorizontally();
  s.centerAlignContent();
  s.backgroundColor = C.chip;
  s.cornerRadius = 99;
  s.setPadding(4, 10, 4, 10);
  if (opts.dot) {
    const d = s.addText('●');
    d.font = Font.systemFont(8);
    d.textColor = new Color(opts.dot);
    s.addSpacer(5);
  }
  const t = s.addText(text);
  t.font = Font.semiboldSystemFont(12);
  t.textColor = C.ink;
  t.lineLimit = 1;
  return s;
}

// Bottom row (.note-bottom): priority summary + Post pill
function addBottomRow(w, C) {
  const bottom = w.addStack();
  bottom.layoutHorizontally();
  bottom.centerAlignContent();
  const hint = bottom.addText('Tap to write');
  hint.font = Font.boldSystemFont(10);
  hint.textColor = C.inkSoft;
  bottom.addSpacer();
  const post = bottom.addStack();
  post.backgroundColor = C.edge;
  post.cornerRadius = 99;
  post.setPadding(4, 14, 4, 14);
  const ptx = post.addText('Post');
  ptx.font = Font.boldSystemFont(12);
  ptx.textColor = Color.white();
}

// ===================== FORM (WebView sticky note) =====================

function buildHtml(data) {
  const pal = STICKY[data.color];
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<style>
  :root {
    --bg: ${pal.light[0]}; --edge: ${pal.light[1]};
    --ink: #1E293B; --ink2: rgba(30,41,59,0.65);
    --chip: rgba(0,0,0,0.08); --chip-on: rgba(255,255,255,0.5);
    --page: #E2E8F0; --toast-bg: #1E293B; --toast-ink: #F8FAFC;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: ${pal.dark[0]}; --edge: ${pal.dark[1]};
      --ink: #E2E8F0; --ink2: rgba(226,232,240,0.65);
      --chip: rgba(255,255,255,0.08); --chip-on: rgba(255,255,255,0.14);
      --page: #0B1120; --toast-bg: #E2E8F0; --toast-ink: #0F172A;
    }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; background: var(--page); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  body { min-height: 100vh; padding: 28px 16px 40px; display: flex; flex-direction: column; align-items: center; overflow-x: hidden; }

  .sticky {
    width: 100%; max-width: 400px;
    background: var(--bg); border: 1.5px solid var(--edge); border-radius: 12px;
    padding: 14px 16px 14px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.15);
    transform: rotate(-1deg);
    transition: transform .45s cubic-bezier(.4,0,.2,1), opacity .45s cubic-bezier(.4,0,.2,1);
  }
  .sticky.fly { transform: translateY(-110vh) rotate(8deg); opacity: 0; }
  .sticky.drop { animation: drop .42s cubic-bezier(.2,.9,.3,1.15); }
  @keyframes drop {
    from { transform: translateY(-36px) rotate(-4deg) scale(.96); opacity: 0; }
    to   { transform: rotate(-1deg); opacity: 1; }
  }

  .note-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; }
  .badge { position: relative; display: inline-flex; align-items: center; gap: 4px; max-width: 70%;
    font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 99px; background: var(--chip); }
  .badge span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge select { position: absolute; inset: 0; opacity: 0; font-size: 16px; width: 100%; }
  .kicker { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ink2); }

  textarea { display: block; width: 100%; border: none; outline: none; background: transparent; color: var(--ink);
    resize: none; padding: 4px 0; font-family: inherit; line-height: 1.35; }
  textarea::placeholder { color: var(--ink2); }
  #title { font-size: 19px; font-weight: 600; }
  #desc { font-size: 16px; color: var(--ink2); }
  #desc:focus { color: var(--ink); }

  .rule { height: 1px; background: var(--chip); margin: 10px 0 2px; }
  .label { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink2); margin: 12px 0 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; border: 1.5px solid transparent; background: var(--chip);
    color: var(--ink); border-radius: 99px; padding: 6px 12px; font-size: 14px; font-weight: 600; line-height: 1; font-family: inherit; }
  .chip.on { background: var(--chip-on); border-color: var(--edge); }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

  .due { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .due input { -webkit-appearance: none; appearance: none; border: none; outline: none; background: var(--chip);
    color: var(--ink); border-radius: 8px; padding: 7px 10px; font-size: 16px; font-weight: 500; font-family: inherit;
    min-height: 36px; min-width: 120px; }
  .due input[type=time] { min-width: 96px; }
  .clear { border: none; background: none; color: var(--ink2); font-size: 15px; padding: 6px; }

  .note-bottom { display: flex; justify-content: space-between; align-items: center; margin-top: 16px; gap: 10px; }
  .summary { font-size: 11px; font-weight: 700; color: var(--ink2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .post { border: none; border-radius: 99px; padding: 10px 22px; background: var(--edge); color: #fff;
    font-size: 16px; font-weight: 700; font-family: inherit; box-shadow: 0 2px 8px rgba(0,0,0,.2); flex-shrink: 0; }
  .post:disabled { opacity: .45; box-shadow: none; }

  .foot { margin-top: 22px; text-align: center; }
  .link { border: none; background: none; color: var(--ink2); font-size: 12px; font-family: inherit; text-decoration: underline; }

  .toast { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translate(-50%, 20px);
    max-width: calc(100% - 32px); background: var(--toast-bg); color: var(--toast-ink); border-radius: 12px;
    padding: 10px 16px; font-size: 14px; font-weight: 600; opacity: 0; pointer-events: none;
    transition: opacity .25s, transform .25s; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.err { background: #EF4444; color: #fff; }
  .fatal { width: 100%; max-width: 400px; margin-bottom: 16px; padding: 12px 14px; border-radius: 10px;
    background: #EF4444; color: #fff; font-size: 13px; font-weight: 600; white-space: pre-wrap; word-break: break-word; }
</style>
<script>
  window.onerror = function (msg, src, line) {
    var b = document.createElement('div');
    b.className = 'fatal';
    b.textContent = 'Quick Note error: ' + msg + (line ? ' (line ' + line + ')' : '') + '\\nScreenshot this and send it over.';
    (document.body || document.documentElement).insertBefore(b, (document.body || document.documentElement).firstChild);
  };
</script>
</head>
<body>
  <form class="sticky" id="note" onsubmit="return false">
    <div class="note-top">
      <label class="badge"><span id="projName"></span>▾<select id="project" aria-label="Project"></select></label>
      <span class="kicker">New note</span>
    </div>
    <textarea id="title" rows="1" placeholder="What needs doing?" maxlength="300"></textarea>
    <textarea id="desc" rows="1" placeholder="Description (optional)"></textarea>
    <div class="rule"></div>

    <div class="label">Priority</div>
    <div class="chips" id="prio"></div>

    <div id="catWrap">
      <div class="label">Category</div>
      <div class="chips" id="cats"></div>
    </div>

    <div class="label">Due</div>
    <div class="due">
      <input type="date" id="dueDate" aria-label="Due date">
      <input type="time" id="dueTime" aria-label="Due time">
      <button type="button" class="clear" id="clearDue" aria-label="Clear due date">✕</button>
    </div>

    <div class="note-bottom">
      <span class="summary" id="summary"></span>
      <button type="button" class="post" id="post" disabled>Post</button>
    </div>
  </form>

  <div class="foot"><button type="button" class="link" id="changeToken">Change API token</button></div>
  <div class="toast" id="toast"></div>

<script>
(function () {
  var D = ${json};
  var PCOL = { High: '#EF4444', Medium: '#F97316', Low: '#22C55E' };
  var $ = function (id) { return document.getElementById(id); };
  var priority = PCOL[D.lastPriority] ? D.lastPriority : 'Medium';
  var category = D.categories.some(function (c) { return c.id === D.category; }) ? D.category : '';
  var armed = null, queued = null, busy = false, toastTimer = null;

  // Scriptable bridge: the script calls window.__arm(completion) to wait for the next action.
  function send(msg) {
    var s = JSON.stringify(msg);
    if (armed) { var cb = armed; armed = null; cb(s); } else { queued = s; }
  }
  window.__arm = function (cb) {
    if (queued) { var s = queued; queued = null; cb(s); } else { armed = cb; }
  };

  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast' + (isErr ? ' err' : ''); }, isErr ? 4000 : 2600);
  }

  // Project badge
  var sel = $('project');
  D.projects.forEach(function (p) {
    var o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  });
  if (D.lastProjectId && D.projects.some(function (p) { return p.id === D.lastProjectId; })) sel.value = D.lastProjectId;
  function syncProject() {
    var o = sel.options[sel.selectedIndex];
    $('projName').textContent = o ? o.textContent : 'No project';
  }
  sel.addEventListener('change', syncProject);
  syncProject();

  function renderPrio() {
    var box = $('prio'); box.innerHTML = '';
    ['High', 'Medium', 'Low'].forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (p === priority ? ' on' : '');
      if (p === priority) b.style.borderColor = PCOL[p];
      var dot = document.createElement('span');
      dot.className = 'dot'; dot.style.background = PCOL[p];
      b.appendChild(dot);
      b.appendChild(document.createTextNode(p));
      b.onclick = function () { priority = p; renderPrio(); summary(); };
      box.appendChild(b);
    });
  }

  function renderCats() {
    var box = $('cats'); box.innerHTML = '';
    if (!D.categories.length) { $('catWrap').style.display = 'none'; return; }
    D.categories.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (c.id === category ? ' on' : '');
      b.textContent = c.name;
      b.onclick = function () { category = category === c.id ? '' : c.id; renderCats(); summary(); };
      box.appendChild(b);
    });
  }

  function summary() {
    var s = $('summary'); s.innerHTML = '';
    var p = document.createElement('span');
    p.style.color = PCOL[priority];
    p.textContent = '● ' + priority;
    s.appendChild(p);
    var bits = [];
    var cat = D.categories.filter(function (c) { return c.id === category; })[0];
    if (cat) bits.push(cat.name.toUpperCase());
    var dd = $('dueDate').value;
    if (dd) {
      var d = new Date(dd + 'T00:00');
      var txt = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      if ($('dueTime').value) txt += ' ' + $('dueTime').value;
      bits.push('Due ' + txt);
    }
    if (bits.length) s.appendChild(document.createTextNode('  ·  ' + bits.join('  ·  ')));
  }

  function autosize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  function syncPost() { $('post').disabled = busy || !$('title').value.trim(); }

  ['title', 'desc'].forEach(function (id) {
    $(id).addEventListener('input', function () { autosize($(id)); syncPost(); });
  });
  $('title').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('desc').focus(); }
  });
  $('dueDate').addEventListener('change', summary);
  $('dueTime').addEventListener('change', summary);
  $('clearDue').onclick = function () { $('dueDate').value = ''; $('dueTime').value = ''; summary(); };

  function setBusy(b) {
    busy = b;
    $('post').textContent = b ? 'Posting…' : 'Post';
    syncPost();
  }

  $('post').onclick = function () {
    var title = $('title').value.trim();
    if (!title || busy) return;
    if (!sel.value) { toast('Pick a project first', true); return; }
    setBusy(true);
    send({ action: 'post', note: {
      title: title,
      description: $('desc').value.trim(),
      projectId: sel.value,
      priority: priority,
      category: category,
      dueDate: $('dueDate').value || '',
      dueTime: $('dueDate').value ? ($('dueTime').value || '') : ''
    }});
  };

  $('changeToken').onclick = function () { send({ action: 'token' }); };

  function reset() {
    $('title').value = ''; $('desc').value = '';
    $('dueDate').value = ''; $('dueTime').value = '';
    category = '';
    renderCats(); summary();
    autosize($('title')); autosize($('desc'));
    setBusy(false);
  }

  window.onPosted = function (projName) {
    var card = $('note');
    if (document.activeElement) document.activeElement.blur();
    card.classList.add('fly');
    toast('Posted to ' + projName + ' ✓');
    setTimeout(function () {
      reset();
      card.classList.remove('fly');
      card.classList.add('drop');
      setTimeout(function () { card.classList.remove('drop'); }, 450);
    }, 460);
  };
  window.onError = function (msg) { setBusy(false); toast(msg, true); };
  window.onInfo = function (msg) { toast(msg, false); };

  renderPrio(); renderCats(); summary();
  autosize($('title')); autosize($('desc'));
  if (D.offline) toast('Offline: using your saved project list', true);
  // The widget part that was tapped decides where typing starts.
  var focusId = D.focus === 'desc' ? 'desc' : D.focus === 'due' ? 'dueDate' : 'title';
  setTimeout(function () { $(focusId).focus(); }, 350);
})();
</script>
</body></html>`;
}

// `pre` = choices made by tapping a part of the widget: { priority, category, focus }.
async function runForm(colorName, pre = {}) {
  let token = await ensureToken();
  if (!token) return;
  const state = loadState();

  let res = await api('listProjects', token);
  if (res.code === 401) {
    Keychain.remove(KC_TOKEN);
    await showAlert('Token rejected', 'That API token isn\'t valid any more. Paste a fresh one.');
    token = await ensureToken();
    if (!token) return;
    res = await api('listProjects', token);
  }
  const online = res.code === 200 && res.json && Array.isArray(res.json.projects);
  if (online) {
    state.projects = res.json.projects;
    state.categories = res.json.categories || [];
    saveState(state);
  }
  const projects = state.projects || [];
  if (!projects.length) {
    await showAlert('No projects',
      online ? 'Create a project in the app first. Notes need a project to live in.'
             : 'Couldn\'t reach your task board and no saved project list exists yet. Check your connection and try again.');
    return;
  }

  // Present first, then load: HTML loaded into a WebView that isn't on screen yet can
  // come up as a blank white sheet.
  const wv = new WebView();
  const closed = wv.present(false).then(() => null);
  await wv.loadHTML(buildHtml({
    color: colorName,
    projects,
    categories: state.categories || [],
    lastProjectId: state.lastProjectId || null,
    lastPriority: PRIORITY_COLORS[pre.priority] ? pre.priority : (state.lastPriority || 'Medium'),
    category: pre.category || '',
    focus: pre.focus || 'title',
    offline: !online,
  }));

  for (;;) {
    const raw = await Promise.race([closed, wv.evaluateJavaScript(
      'if (window.__arm) window.__arm(completion); else completion(JSON.stringify({ action: "broken" }))', true)]);
    if (!raw) break; // sheet dismissed
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { continue; }

    if (msg.action === 'post') {
      const note = msg.note;
      const r = await api('addNote', token, note);
      if (r.code === 200 && r.json && r.json.success) {
        const proj = projects.find(p => p.id === note.projectId);
        const s = loadState();
        s.lastProjectId = note.projectId;
        s.lastProjectName = proj ? proj.name : '';
        s.lastPriority = note.priority;
        s.last = { title: note.title, at: new Date().toISOString() };
        saveState(s);
        await wv.evaluateJavaScript(`window.onPosted(${JSON.stringify(s.lastProjectName || 'your board')})`);
      } else {
        const why = r.code === 401 ? 'API token rejected. Tap "Change API token".'
          : r.code === 0 ? 'Couldn\'t reach the server. Check your connection.'
          : (r.json && r.json.error) || `Post failed (HTTP ${r.code})`;
        await wv.evaluateJavaScript(`window.onError(${JSON.stringify(why)})`);
      }
    } else if (msg.action === 'token') {
      Keychain.remove(KC_TOKEN);
      await wv.evaluateJavaScript(`window.onInfo(${JSON.stringify('Token cleared. Close this and tap the widget again to paste a new one.')})`);
    } else if (msg.action === 'broken') {
      break; // page script failed; its window.onerror banner says why
    }
  }
}

// ===================== MAIN =====================

if (config.runsInWidget) {
  // Notes now post through the shortcut, so the widget keeps its own category list fresh.
  const state = loadState();
  if (Keychain.contains(KC_TOKEN)) {
    const res = await api('listProjects', Keychain.get(KC_TOKEN));
    if (res.code === 200 && res.json && Array.isArray(res.json.projects)) {
      state.projects = res.json.projects;
      state.categories = res.json.categories || [];
      saveState(state);
    }
  }
  Script.setWidget(buildWidget(state, pickColor(args.widgetParameter)));
} else {
  const qp = args.queryParameters || {};
  try {
    await runForm(pickColor(qp.color || args.widgetParameter),
      { priority: qp.priority, category: qp.category, focus: qp.focus });
  } catch (err) {
    console.error(err);
    await showAlert('Quick Note hit an error', String(err && err.message || err));
  }
}
Script.complete();
