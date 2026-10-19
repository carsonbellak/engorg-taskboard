// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: thumbtack;

// EngOrg Due Today — Scriptable (iOS) widget for the Engineering Task Board.
//
// A corkboard of sticky notes for the notes due today. Once everything due today is done
// (or nothing is due), it shows tomorrow's instead. Tapping a note opens it in the web app.
//
// Data comes from your subscribed-calendar feed (the same one the iPhone calendar uses),
// so notes need a due date to appear. Setup: run this script once in Scriptable and paste
// your calendar link (web app → Settings → Widgets), then add a Scriptable widget (medium
// or large works best) and pick this script.

const FEED = 'https://calendarfeed-sf7sdunyuq-uc.a.run.app';
const WEB_APP = 'https://assistant-taskboard.web.app/';
const KC_TOKEN = 'engorg.calToken';
const CACHE_FILE = 'engorg-due-today.ics';

// Mirrors STICKY_COLORS_LIGHT / _DARK in renderer/components/sticky-note.js
const STICKY = [
  { light: ['#FEF08A', '#EAB308'], dark: ['#423A10', '#A08520'] },
  { light: ['#93C5FD', '#3B82F6'], dark: ['#162844', '#3070C0'] },
  { light: ['#86EFAC', '#22C55E'], dark: ['#14352A', '#22885A'] },
  { light: ['#C4B5FD', '#8B5CF6'], dark: ['#2A1F48', '#7050B8'] },
  { light: ['#FDBA74', '#F97316'], dark: ['#3A2410', '#C06820'] },
  { light: ['#FCA5A5', '#EF4444'], dark: ['#3A1818', '#C04040'] },
];

const dyn = (l, d, a) => Color.dynamic(new Color(l, a), new Color(d, a));
const C = {
  cork: dyn('#C99A66', '#4A3522'),
  corkInk: dyn('#4A3420', '#E8D5BC'),
  corkInkSoft: dyn('#4A3420', '#E8D5BC', 0.75),
  ink: dyn('#1E293B', '#E2E8F0'),
  inkSoft: dyn('#1E293B', '#E2E8F0', 0.65),
  chip: Color.dynamic(new Color('#000000', 0.08), new Color('#FFFFFF', 0.1)),
  pin: new Color('#D9534F'),
  danger: dyn('#B91C1C', '#FCA5A5'),
};

// ===================== DATA =====================

function extractToken(text) {
  const m = String(text || '').match(/[a-f0-9]{64}/i);
  return m ? m[0] : null;
}

async function fetchFeed(token) {
  const fm = FileManager.local();
  const cachePath = fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
  try {
    const r = new Request(`${FEED}?token=${token}&nc=${Date.now()}`);
    r.timeoutInterval = 20;
    const text = await r.loadString();
    if (r.response.statusCode === 200 && text.includes('BEGIN:VCALENDAR')) {
      fm.writeString(cachePath, text);
      return { text, fresh: true };
    }
    if (r.response.statusCode === 403) return { error: 'token' };
  } catch (_) {}
  if (fm.fileExists(cachePath)) return { text: fm.readString(cachePath), fresh: false };
  return { error: 'offline' };
}

function unescapeIcs(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

// Pull due-dated notes out of the feed. Notes keep their app id (note_…) as the UID;
// events (sch_…) and recurring work blocks are skipped.
function parseNotes(ics) {
  const text = ics.replace(/\r?\n[ \t]/g, '');
  const notes = [];
  for (const block of text.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const f = {};
    for (const line of body.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon < 1) continue;
      const key = line.slice(0, colon).split(';')[0].toUpperCase();
      f[key] = line.slice(colon + 1);
    }
    const uid = (f.UID || '').replace(/@engorg$/, '');
    if (!uid.startsWith('note_') || f.RRULE || !f.DTSTART) continue;
    const m = f.DTSTART.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
    if (!m) continue;
    let desc = f.DESCRIPTION ? unescapeIcs(f.DESCRIPTION) : '';
    let project = '';
    const pm = desc.match(/(?:^| — )Project: (.+)$/);
    if (pm) { project = pm[1].trim(); desc = desc.slice(0, pm.index).trim(); }
    notes.push({
      id: uid,
      title: unescapeIcs(f.SUMMARY || '').trim(),
      description: desc,
      project,
      date: `${m[1]}-${m[2]}-${m[3]}`,
      time: m[4] ? `${m[4]}:${m[5]}` : null,
      done: (f.STATUS || '').toUpperCase() === 'CANCELLED',
    });
  }
  return notes;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const byTime = (a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.title.localeCompare(b.title);

// Decide what the wall shows: today's open notes; once those are all done (or none are
// due), tomorrow's; if tomorrow is empty too, an "all clear" with the next thing due.
function pickBoard(notes, now = new Date()) {
  const today = ymd(now), tomorrow = ymd(addDays(now, 1));
  const dueToday = notes.filter(n => n.date === today);
  const openToday = dueToday.filter(n => !n.done).sort(byTime);
  const overdue = notes.filter(n => n.date < today && !n.done).length;

  if (openToday.length) {
    return { mode: 'today', title: 'Due today', items: openToday,
      sub: `${openToday.length} left${dueToday.length > openToday.length ? ` · ${dueToday.length - openToday.length} done` : ''}`, overdue };
  }
  const openTomorrow = notes.filter(n => n.date === tomorrow && !n.done).sort(byTime);
  const lead = dueToday.length ? 'Today’s done ✓' : 'Nothing due today';
  if (openTomorrow.length) {
    return { mode: 'tomorrow', title: 'Tomorrow', lead, items: openTomorrow,
      sub: `${openTomorrow.length} due`, overdue };
  }
  const next = notes.filter(n => n.date > tomorrow && !n.done)
    .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b))[0] || null;
  return { mode: 'clear', title: 'All clear', lead, items: [], next, sub: '', overdue };
}

// ===================== WIDGET =====================

// Widget sizes in points, by portrait screen size (Apple's published widget metrics).
const WIDGET_SIZES = {
  '430x932': [170, 364, 382], '428x926': [170, 364, 382], '440x956': [170, 364, 382],
  '414x896': [169, 360, 379], '414x736': [159, 348, 357],
  '402x874': [162, 344, 360], '393x852': [158, 338, 354], '390x844': [158, 338, 354],
  '375x812': [155, 329, 345], '375x667': [148, 321, 324], '360x780': [155, 329, 345],
};
function widgetSize(family) {
  let s = { width: 393, height: 852 };
  try { s = Device.screenSize(); } catch (_) {}
  const key = `${Math.min(s.width, s.height)}x${Math.max(s.width, s.height)}`;
  let [small, medW, largeH] = WIDGET_SIZES[key] || [];
  if (!small) {
    const w = Math.min(s.width, s.height);
    medW = Math.floor(w * 0.84); small = Math.floor(medW * 0.465); largeH = Math.floor(medW * 1.04);
  }
  if (family === 'small') return { w: small, h: small };
  if (family === 'medium') return { w: medW, h: small };
  return { w: medW, h: largeH };
}

function hashIdx(s, n) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % n;
}

function fmtTime(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function fmtDay(dateStr) {
  const d = new Date(dateStr + 'T00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function addSticky(parent, size, palette, opts) {
  const n = parent.addStack();
  n.size = size;
  n.layoutVertically();
  n.backgroundColor = dyn(palette.light[0], palette.dark[0]);
  n.borderColor = dyn(palette.light[1], palette.dark[1]);
  n.borderWidth = 1.5;
  n.cornerRadius = 8;
  n.setPadding(6, 8, 7, 8);
  if (opts.url) n.url = opts.url;

  // Badge + pin
  const top = n.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  if (opts.badge) {
    const b = top.addStack();
    b.backgroundColor = C.chip;
    b.cornerRadius = 99;
    b.setPadding(1, 6, 1, 6);
    const bt = b.addText(opts.badge);
    bt.font = Font.boldSystemFont(9);
    bt.textColor = C.ink;
    bt.lineLimit = 1;
  }
  top.addSpacer();
  const pin = SFSymbol.named('pin.fill');
  pin.applyFont(Font.boldSystemFont(10));
  const pi = top.addImage(pin.image);
  pi.imageSize = new Size(11, 11);
  pi.tintColor = C.pin;

  n.addSpacer(4);
  const t = n.addText(opts.title);
  t.font = Font.semiboldSystemFont(opts.titleSize || 12);
  t.textColor = C.ink;
  t.lineLimit = opts.lines || 3;
  t.minimumScaleFactor = 0.8;

  n.addSpacer();
  if (opts.foot) {
    const f = n.addText(opts.foot);
    f.font = Font.boldSystemFont(9);
    f.textColor = opts.footColor || C.inkSoft;
    f.lineLimit = 1;
  }
  return n;
}

function buildWidget(board, family, status) {
  const w = new ListWidget();
  w.backgroundColor = C.cork;
  w.url = WEB_APP;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  if (family.startsWith('accessory')) {
    const t = w.addText(board.items.length ? `${board.items.length} ${board.mode === 'today' ? 'due today' : 'due tomorrow'}` : 'All clear');
    t.font = Font.boldSystemFont(14);
    if (board.items[0]) { const s = w.addText(board.items[0].title); s.font = Font.systemFont(12); s.lineLimit = 1; }
    return w;
  }

  const size = widgetSize(family);
  const pad = 12, gap = 8, headerH = 16;
  w.setPadding(pad, pad, pad, pad);

  // Header: "Due today · 3 left" (or "Today's done ✓ · Tomorrow")
  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  head.size = new Size(size.w - 2 * pad, headerH);
  if (board.lead && family !== 'small') {
    const l = head.addText(`${board.lead}  ·  `);
    l.font = Font.semiboldSystemFont(11);
    l.textColor = C.corkInkSoft;
  }
  const ht = head.addText(board.title);
  ht.font = Font.boldSystemFont(12);
  ht.textColor = C.corkInk;
  head.addSpacer();
  const right = status === 'offline' ? 'offline' : board.sub;
  if (right) {
    const r = head.addText(right);
    r.font = Font.semiboldSystemFont(10);
    r.textColor = C.corkInkSoft;
    r.lineLimit = 1;
  }
  if (board.overdue && family !== 'small') {
    const o = head.addText(`${right ? '  ·  ' : ''}${board.overdue} overdue`);
    o.font = Font.semiboldSystemFont(10);
    o.textColor = C.danger;
    o.lineLimit = 1;
  }
  w.addSpacer(6);

  const cols = family === 'small' ? 1 : 3;
  const rows = family === 'large' || family === 'extraLarge' ? 2 : 1;
  const stagger = [0, 6, 2, 5, 0, 4];
  const maxStagger = family === 'small' ? 0 : 6;
  const noteW = Math.floor((size.w - 2 * pad - (cols - 1) * gap) / cols);
  const noteH = Math.floor((size.h - 2 * pad - headerH - 6 - (rows - 1) * gap - maxStagger) / rows);
  const noteSize = new Size(noteW, noteH);
  const lines = rows === 2 ? 4 : family === 'small' ? 4 : 3;

  // "All clear": one note with the next thing due
  if (!board.items.length) {
    const row = w.addStack();
    row.layoutHorizontally();
    row.addSpacer();
    const next = board.next;
    addSticky(row, new Size(Math.min(size.w - 2 * pad, noteW * 2 + gap), noteH), STICKY[2], {
      badge: next ? `Next up${next.project ? ' · ' + next.project : ''}` : null,
      title: next ? next.title : 'Nothing due today or tomorrow',
      foot: next ? `${fmtDay(next.date)}${next.time ? ' · ' + fmtTime(next.time) : ''}` : 'Enjoy it',
      lines: 3, titleSize: 13,
      url: next ? `${WEB_APP}?note=${encodeURIComponent(next.id)}` : null,
    });
    row.addSpacer();
    w.addSpacer();
    return w;
  }

  // With room for several notes, the last slot becomes "+N more"; a single-slot (small)
  // widget just shows the first note, and the header already says how many are left.
  const slots = cols * rows;
  const shown = board.items.length <= slots ? board.items
    : slots === 1 ? board.items.slice(0, 1) : board.items.slice(0, slots - 1);
  const extra = slots === 1 ? 0 : board.items.length - shown.length;
  const cells = shown.map(n => ({ note: n }));
  if (extra > 0) cells.push({ more: extra });

  for (let r = 0; r < rows; r++) {
    const rowCells = cells.slice(r * cols, r * cols + cols);
    if (!rowCells.length) break;
    if (r) w.addSpacer(gap);
    const row = w.addStack();
    row.layoutHorizontally();
    row.topAlignContent();
    row.spacing = gap;
    rowCells.forEach((cell, c) => {
      const col = row.addStack();
      col.layoutVertically();
      col.size = new Size(noteW, noteH + maxStagger);
      const off = maxStagger ? stagger[(r * cols + c) % stagger.length] : 0;
      if (off) col.addSpacer(off);
      if (cell.more) {
        addSticky(col, noteSize, STICKY[0], {
          title: `+${cell.more} more`, titleSize: 15, lines: 1,
          foot: board.mode === 'today' ? 'due today' : 'due tomorrow', url: WEB_APP,
        });
      } else {
        const n = cell.note;
        const time = fmtTime(n.time);
        addSticky(col, noteSize, STICKY[hashIdx(n.project || n.title, STICKY.length)], {
          badge: n.project || null,
          title: n.title, lines,
          foot: time || (board.mode === 'today' ? 'Today' : 'Tomorrow'),
          url: `${WEB_APP}?note=${encodeURIComponent(n.id)}`,
        });
      }
      col.addSpacer();
    });
  }
  w.addSpacer();
  return w;
}

function messageWidget(title, body) {
  const w = new ListWidget();
  w.backgroundColor = C.cork;
  w.setPadding(14, 14, 14, 14);
  const t = w.addText(title);
  t.font = Font.boldSystemFont(14);
  t.textColor = C.corkInk;
  w.addSpacer(4);
  const b = w.addText(body);
  b.font = Font.systemFont(12);
  b.textColor = C.corkInkSoft;
  w.url = `scriptable:///run/${encodeURIComponent(Script.name())}`;
  return w;
}

// ===================== SETUP (in the app) =====================

async function ensureToken() {
  if (Keychain.contains(KC_TOKEN)) return Keychain.get(KC_TOKEN);
  let clip = '';
  try { clip = Pasteboard.pasteString() || ''; } catch (_) {}
  const a = new Alert();
  a.title = 'Connect your calendar';
  a.message = 'Paste your calendar link (or just its token).\n\nOn the phone: web app → Settings → Widgets → "Copy calendar link".';
  a.addTextField('Calendar link', extractToken(clip) ? clip : '');
  a.addAction('Connect');
  a.addCancelAction('Cancel');
  if (await a.presentAlert() === -1) return null;
  const token = extractToken(a.textFieldValue(0));
  if (!token) {
    const e = new Alert();
    e.title = 'No token found';
    e.message = 'That text doesn’t contain a calendar token. Copy the link again and retry.';
    e.addAction('OK');
    await e.presentAlert();
    return null;
  }
  Keychain.set(KC_TOKEN, token);
  return token;
}

// ===================== MAIN =====================

const family = config.widgetFamily || 'large';
let token = Keychain.contains(KC_TOKEN) ? Keychain.get(KC_TOKEN) : null;
if (!config.runsInWidget && !token) token = await ensureToken();

let widget;
if (!token) {
  widget = messageWidget('Connect Due Today', 'Tap here, then paste your calendar link.');
} else {
  const res = await fetchFeed(token);
  if (res.error === 'token') {
    Keychain.remove(KC_TOKEN);
    widget = messageWidget('Calendar link expired', 'Tap here and paste a fresh link from Settings → Widgets.');
  } else if (res.error) {
    widget = messageWidget('Can’t reach your board', 'Check your connection. This updates on its own.');
  } else {
    widget = buildWidget(pickBoard(parseNotes(res.text)), family, res.fresh ? 'ok' : 'offline');
  }
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}
Script.complete();
