// Renders a phone-wallpaper PNG of one day's schedule, for the daily lock-screen
// automation (a Shortcuts Time-of-Day automation fetches this and Set Wallpaper's it).
//
// Pure-JS rendering via `pureimage` (no native binaries → deploys cleanly to Cloud
// Functions) with two bundled Roboto TTFs. Draws the same three sources the in-app
// calendar shows for a day: scheduled events, due-dated notes (assignments), and
// recurring project work blocks. A project's `location` (e.g. a class room) is shown as
// the item's subtitle so you can read the room off the lock screen. The top ~42% is left
// empty so it sits behind the iOS clock and lock-screen widgets. Dark background.

const path = require('path');
const { PassThrough } = require('stream');
const PImage = require('pureimage');

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Register the bundled fonts once per warm instance.
let _fontsReady = false;
function ensureFonts() {
  if (_fontsReady) return;
  PImage.registerFont(path.join(__dirname, 'assets', 'Roboto-Regular.ttf'), 'Roboto').loadSync();
  PImage.registerFont(path.join(__dirname, 'assets', 'Roboto-Bold.ttf'), 'RobotoBold').loadSync();
  _fontsReady = true;
}

function pad(n) { return String(n).padStart(2, '0'); }

// 'HH:MM' (24h) → '7:30 PM' style. null/'' → ''.
function time12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ap}`;
}

// Compact start–end label; drops the shared AM/PM on the start ('6:00–8:00 PM').
function rangeLabel(start, end) {
  if (!end) return time12(start);
  const ap = (t) => (Number(t.split(':')[0]) < 12 ? 'AM' : 'PM');
  const bare = (t) => { const [h, m] = t.split(':').map(Number); const x = h % 12 === 0 ? 12 : h % 12; return `${x}:${pad(m)}`; };
  return ap(start) === ap(end) ? `${bare(start)}–${time12(end)}` : `${time12(start)}–${time12(end)}`;
}

// Gather the day's display items from the three data arrays. `date` is 'YYYY-MM-DD'.
// Returns items sorted: untimed (all-day / due) first, then timed ascending. Each item's
// subtitle carries the room/location where relevant (event's own location, else the
// project's `location`).
function itemsForDate({ date, events = [], tasks = [], projects = [] }) {
  const d = new Date(date + 'T00:00:00');
  const weekday = DAYS_FULL[d.getDay()];
  const projName = {}, projColor = {}, projLoc = {};
  for (const p of projects) if (p && p.id) { projName[p.id] = p.name; projColor[p.id] = p.color; projLoc[p.id] = p.location; }

  const out = [];

  for (const ev of events) {
    if (!ev || !ev.title) continue;
    const match = ev.date === date || (!ev.date && ev.day === weekday);
    if (!match) continue;
    const loc = ev.location || projLoc[ev.projectId] || '';
    out.push({
      sort: ev.startTime || '',
      timeLabel: ev.startTime ? time12(ev.startTime) : 'All day',
      title: ev.title,
      subtitle: [projName[ev.projectId], loc].filter(Boolean).join(' · '),
      color: projColor[ev.projectId] || '#3B82F6',
      completed: !!ev.completed,
    });
  }

  for (const t of tasks) {
    if (!t || !t.title || t.dueDate !== date) continue;
    const isAsgn = t.category === 'assignment';
    out.push({
      sort: t.dueTime || '',
      timeLabel: t.dueTime ? time12(t.dueTime) : (isAsgn ? 'Due' : 'All day'),
      title: t.title,
      subtitle: (isAsgn ? 'Due · ' : '') + (projName[t.projectId] || ''),
      color: projColor[t.projectId] || '#8B5CF6',
      completed: !!t.completed,
    });
  }

  // Recurring project work blocks. A project with a `location` is a place you go (a class),
  // so show its name + room rather than the generic "— work block" label.
  for (const p of projects) {
    if (!p) continue;
    for (const wb of (p.workSchedule || [])) {
      if (!wb || wb.day !== weekday || !wb.start) continue;
      const loc = p.location || '';
      out.push({
        sort: wb.start,
        timeLabel: rangeLabel(wb.start, wb.end),
        title: loc ? (p.name || 'Class') : `${p.name || 'Work'} — work block`,
        subtitle: loc,
        color: p.color || '#6366F1',
        completed: false,
      });
    }
  }

  out.sort((a, b) => {
    if (!a.sort && b.sort) return -1;
    if (a.sort && !b.sort) return 1;
    if (a.sort !== b.sort) return a.sort < b.sort ? -1 : 1;
    return (a.completed ? 1 : 0) - (b.completed ? 1 : 0);
  });
  return { weekday, items: out };
}

// ---- drawing helpers ----
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

async function renderScheduleWallpaper({ date, events, tasks, projects, width = 1290, height = 2796 }) {
  ensureFonts();
  const { weekday, items } = itemsForDate({ date, events, tasks, projects });

  const img = PImage.make(width, height);
  const ctx = img.getContext('2d');

  // Background — deep navy-charcoal (not pure black; gentle on OLED).
  ctx.fillStyle = '#0E1420';
  ctx.fillRect(0, 0, width, height);

  const M = Math.round(width * 0.09);            // side margin
  let y = Math.round(height * 0.44);             // content top — below clock/widgets

  // Header: weekday + date.
  const d = new Date(date + 'T00:00:00');
  ctx.fillStyle = '#F2F5FA';
  ctx.font = `${Math.round(width * 0.072)}px RobotoBold`;
  ctx.fillText(weekday, M, y);
  y += Math.round(width * 0.052);
  ctx.fillStyle = '#7C8698';
  ctx.font = `${Math.round(width * 0.040)}px Roboto`;
  ctx.fillText(`${MONTHS[d.getMonth()]} ${d.getDate()} · ${items.length} item${items.length === 1 ? '' : 's'}`, M, y);
  y += Math.round(width * 0.055);

  // Divider.
  ctx.fillStyle = '#232C3B';
  ctx.fillRect(M, y, width - 2 * M, 3);
  y += Math.round(width * 0.045);

  if (!items.length) {
    ctx.fillStyle = '#9AA4B6';
    ctx.font = `${Math.round(width * 0.046)}px Roboto`;
    ctx.fillText('No scheduled items today', M, y + Math.round(width * 0.02));
  }

  const rowH = Math.round(width * 0.115);
  const barW = Math.round(width * 0.014);
  const timeX = M + Math.round(width * 0.03);
  const textX = M + Math.round(width * 0.275);
  const textMaxW = width - textX - M;
  const maxRows = Math.floor((height - y - Math.round(height * 0.05)) / rowH);

  items.slice(0, maxRows).forEach((it) => {
    const primary = it.completed ? '#5A6373' : '#EDF1F7';
    const muted = it.completed ? '#454D5C' : '#8B95A7';
    // Accent bar.
    ctx.fillStyle = it.completed ? '#3A4250' : it.color;
    ctx.fillRect(M, y - Math.round(rowH * 0.62), barW, Math.round(rowH * 0.72));
    // Time label.
    ctx.fillStyle = muted;
    ctx.font = `${Math.round(width * 0.033)}px RobotoBold`;
    ctx.fillText(fitText(ctx, it.timeLabel || '', textX - timeX - 12), timeX, y - Math.round(rowH * 0.24));
    // Title (completed → struck through, drawn dim).
    ctx.fillStyle = primary;
    ctx.font = `${Math.round(width * 0.044)}px RobotoBold`;
    const titleY = y - Math.round(rowH * 0.24);
    const title = fitText(ctx, it.title, textMaxW);
    ctx.fillText(title, textX, titleY);
    if (it.completed) {
      const tw = ctx.measureText(title).width;
      ctx.fillStyle = muted;
      ctx.fillRect(textX, titleY - Math.round(width * 0.014), tw, 3);
    }
    // Subtitle (project · room).
    if (it.subtitle) {
      ctx.fillStyle = muted;
      ctx.font = `${Math.round(width * 0.032)}px Roboto`;
      ctx.fillText(fitText(ctx, it.subtitle, textMaxW), textX, y + Math.round(rowH * 0.06));
    }
    y += rowH;
  });

  if (items.length > maxRows) {
    ctx.fillStyle = '#7C8698';
    ctx.font = `${Math.round(width * 0.036)}px Roboto`;
    ctx.fillText(`+ ${items.length - maxRows} more`, textX, y);
  }

  // Footer tag.
  ctx.fillStyle = '#4A5364';
  ctx.font = `${Math.round(width * 0.030)}px Roboto`;
  ctx.fillText('EngOrg schedule', M, height - Math.round(height * 0.025));

  // Encode to PNG buffer.
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { out.on('end', res); out.on('error', rej); });
  await PImage.encodePNGToStream(img, out);
  await done;
  return Buffer.concat(chunks);
}

module.exports = { renderScheduleWallpaper, itemsForDate, time12 };
