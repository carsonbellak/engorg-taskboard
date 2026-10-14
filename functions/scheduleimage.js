// Renders a phone-wallpaper PNG of one day's schedule, for the daily lock-screen
// automation (a Shortcuts Time-of-Day automation fetches this and Set Wallpaper's it).
//
// Pure-JS rendering via `pureimage` (no native binaries → deploys cleanly to Cloud
// Functions) with two bundled Roboto TTFs. Draws the same three sources the in-app
// calendar shows for a day: scheduled events, due-dated notes (assignments), and
// recurring project work blocks. A project's `location` (e.g. a class room) is shown as
// the item's subtitle so you can read the room off the lock screen. The top ~27% is left
// empty so it sits behind the iOS clock and lock-screen widgets.
//
// Colors follow the user's chosen app theme (passed in as `theme` → theme-palettes.js,
// generated from the repo-root themes.json) so the wallpaper matches the app; completion
// is signalled with the theme's own `--success` color (green in every theme) — a green
// progress bar + a green "all done" check — rather than tinting the whole background.
//
// Weather (optional, from weather.js): current temp + condition icon and the day's high/
// low sit at the right of the header, and a compact 7-day strip (day, icon, high, low) is
// anchored at the bottom above the dock. Icons are drawn as vector shapes (no emoji).

const path = require('path');
const { PassThrough } = require('stream');
const PImage = require('pureimage');
const THEME_PALETTES = require('./theme-palettes');

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The app stores a couple of theme-id variants that aren't literal keys in themes.json.
const THEME_ALIASES = { glassDark: 'glass', glassLight: 'glass' };
function paletteFor(theme) {
  return THEME_PALETTES[THEME_ALIASES[theme] || theme] || THEME_PALETTES.default;
}

// White or near-black, whichever reads better on top of `hex` (for the check mark on the
// success-colored disc, which is light in some themes and dark in others).
function contrastOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#FFFFFF';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#0B0B0F' : '#FFFFFF';
}

// Register the bundled fonts once per warm instance.
let _fontsReady = false;
function ensureFonts() {
  if (_fontsReady) return;
  PImage.registerFont(path.join(__dirname, 'assets', 'Roboto-Regular.ttf'), 'Roboto').loadSync();
  PImage.registerFont(path.join(__dirname, 'assets', 'Roboto-Bold.ttf'), 'RobotoBold').loadSync();
  _fontsReady = true;
}

function pad(n) { return String(n).padStart(2, '0'); }

// 'HH:MM' (24h) → compact '7:30p' style (lowercase, no space) so it stays inside the
// narrow time column even for a cross-meridiem range. null/'' → ''.
function time12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)}${ap}`;
}

// Compact start–end label; drops the shared meridiem on the start ('6:00–8:00p'), keeps
// both when they differ ('11:30a–12:30p') — still short enough to fit the time column.
function rangeLabel(start, end) {
  if (!end) return time12(start);
  const ap = (t) => (Number(t.split(':')[0]) < 12 ? 'a' : 'p');
  const bare = (t) => { const [h, m] = t.split(':').map(Number); const x = h % 12 === 0 ? 12 : h % 12; return `${x}:${pad(m)}`; };
  return ap(start) === ap(end) ? `${bare(start)}–${time12(end)}` : `${time12(start)}–${time12(end)}`;
}

// Gather the day's display items from the three data arrays. `date` is 'YYYY-MM-DD'.
// Returns items sorted: untimed (all-day / due) first, then timed ascending. Each item
// carries a `kind` ('event' | 'assignment' | 'task' | 'block') so the renderer can hide
// appointments once they're all done. Its subtitle carries the room/location where
// relevant (event's own location, else the project's `location`).
function itemsForDate({ date, events = [], tasks = [], projects = [] }) {
  const d = new Date(date + 'T00:00:00');
  const weekday = DAYS_FULL[d.getDay()];

  // "Now" in the app's timezone (Eastern — the same one the handler uses to pick today),
  // so a class / work block whose end time has passed reads as completed, mirroring the
  // in-app auto-complete of past work-block occurrences.
  const now = (() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: (+g('hour')) * 60 + (+g('minute')) };
  })();
  const blockDone = (endHHMM) => {
    if (date < now.date) return true;    // a past day is fully over
    if (date > now.date) return false;   // a future day hasn't happened yet
    if (!endHHMM) return false;          // today with no end time → still ongoing
    const [eh, em] = endHHMM.split(':').map(Number);
    return (eh * 60 + em) <= now.minutes; // today → done once the end time has passed
  };

  const projName = {}, projColor = {}, projLoc = {};
  for (const p of projects) if (p && p.id) { projName[p.id] = p.name; projColor[p.id] = p.color; projLoc[p.id] = p.location; }

  const out = [];

  for (const ev of events) {
    if (!ev || !ev.title) continue;
    const match = ev.date === date || (!ev.date && ev.day === weekday);
    if (!match) continue;
    const loc = ev.location || projLoc[ev.projectId] || '';
    out.push({
      kind: 'event',
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
      kind: isAsgn ? 'assignment' : 'task',
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
        kind: 'block',
        sort: wb.start,
        timeLabel: rangeLabel(wb.start, wb.end),
        title: loc ? (p.name || 'Class') : `${p.name || 'Work'} — work block`,
        subtitle: loc,
        color: p.color || '#6366F1',
        completed: blockDone(wb.end),
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

// An "appointment" is a timed thing you attend — a calendar event or a class/work block
// — as opposed to an assignment (something due). Used to drop appointments from the list
// once they're all finished, leaving just the assignments.
const isAppointment = (it) => it.kind === 'event' || it.kind === 'block';

// ---- drawing helpers ----
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// Draw text horizontally centered on cx (pureimage has no textAlign).
function centerText(ctx, text, cx, y) {
  ctx.fillText(text, Math.round(cx - ctx.measureText(text).width / 2), y);
}

// Greedy word-wrap to a max pixel width → array of lines.
function wrapText(ctx, text, maxW) {
  const lines = [];
  let cur = '';
  for (const w of String(text).split(' ')) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---- weather ----
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SUN_COLOR = '#F5B83D';
const RAIN_COLOR = '#4FA3E0';

function disc(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
}

// Puffy cloud (three lobes on a flat base) centered at cx,cy; `s` = icon size.
function drawCloud(ctx, cx, cy, s, color) {
  ctx.fillStyle = color;
  disc(ctx, cx - s * 0.20, cy + s * 0.06, s * 0.20);
  disc(ctx, cx + s * 0.02, cy - s * 0.08, s * 0.26);
  disc(ctx, cx + s * 0.24, cy + s * 0.08, s * 0.18);
  ctx.fillRect(Math.round(cx - s * 0.20), Math.round(cy + s * 0.06), Math.round(s * 0.44), Math.round(s * 0.20));
}

function drawSun(ctx, cx, cy, s) {
  ctx.fillStyle = SUN_COLOR;
  disc(ctx, cx, cy, s * 0.22);
  ctx.strokeStyle = SUN_COLOR;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, Math.round(s * 0.07));
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * s * 0.32, cy + Math.sin(a) * s * 0.32);
    ctx.lineTo(cx + Math.cos(a) * s * 0.44, cy + Math.sin(a) * s * 0.44);
    ctx.stroke();
  }
}

// Crescent: a disc with a background-colored disc bitten out of it.
function drawMoon(ctx, cx, cy, s, pal) {
  ctx.fillStyle = SUN_COLOR;
  disc(ctx, cx, cy, s * 0.30);
  ctx.fillStyle = pal.bg;
  disc(ctx, cx + s * 0.14, cy - s * 0.10, s * 0.25);
}

// kind ∈ sun | partly | cloud | rain | snow | storm; `night` swaps the sun for a moon.
function drawWeatherIcon(ctx, kind, cx, cy, s, pal, night) {
  const cloud = pal.isDark ? pal.sub : pal.faint;
  if (kind === 'sun') {
    if (night) drawMoon(ctx, cx, cy, s, pal); else drawSun(ctx, cx, cy, s);
    return;
  }
  if (kind === 'partly') {
    const ox = cx + s * 0.16, oy = cy - s * 0.16;
    if (night) drawMoon(ctx, ox, oy, s * 0.75, pal); else drawSun(ctx, ox, oy, s * 0.75);
    drawCloud(ctx, cx - s * 0.06, cy + s * 0.08, s * 0.85, cloud);
    return;
  }
  const lift = kind === 'cloud' ? 0 : s * 0.14;
  drawCloud(ctx, cx, cy - lift, s, cloud);
  if (kind === 'rain') {
    ctx.strokeStyle = RAIN_COLOR;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, Math.round(s * 0.07));
    for (const dx of [-0.18, 0, 0.18]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * (dx + 0.04), cy + s * 0.22);
      ctx.lineTo(cx + s * (dx - 0.04), cy + s * 0.40);
      ctx.stroke();
    }
  } else if (kind === 'snow') {
    ctx.fillStyle = pal.isDark ? pal.text : RAIN_COLOR;
    for (const [dx, dy] of [[-0.18, 0.26], [0, 0.38], [0.18, 0.26]]) disc(ctx, cx + s * dx, cy + s * dy, s * 0.05);
  } else if (kind === 'storm') {
    ctx.fillStyle = SUN_COLOR;
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.04, cy + s * 0.12);
    ctx.lineTo(cx - s * 0.12, cy + s * 0.32);
    ctx.lineTo(cx + s * 0.00, cy + s * 0.32);
    ctx.lineTo(cx - s * 0.06, cy + s * 0.48);
    ctx.lineTo(cx + s * 0.14, cy + s * 0.24);
    ctx.lineTo(cx + s * 0.02, cy + s * 0.24);
    ctx.closePath();
    ctx.fill();
  }
}

// Height of the 7-day strip for a given wallpaper width.
const forecastStripH = (width) => Math.round(width * 0.25);

// 7-day strip: a divider, then one column per day — name, icon, high, low.
function drawForecastStrip(ctx, { weather, top, M, width, pal }) {
  const days = weather.days.slice(0, 7);
  const trackW = width - 2 * M;
  ctx.fillStyle = pal.border;
  ctx.fillRect(M, top, trackW, 3);
  const colW = trackW / days.length;
  const iconS = Math.round(width * 0.07);
  days.forEach((day, i) => {
    const cx = M + colW * (i + 0.5);
    const dd = new Date(day.date + 'T00:00:00');
    ctx.fillStyle = i === 0 ? pal.text : pal.muted;
    ctx.font = `${Math.round(width * 0.030)}px RobotoBold`;
    centerText(ctx, i === 0 ? 'Today' : DAYS_SHORT[dd.getDay()], cx, top + Math.round(width * 0.062));
    drawWeatherIcon(ctx, day.kind, cx, top + Math.round(width * 0.113), iconS, pal, false);
    ctx.fillStyle = pal.text;
    ctx.font = `${Math.round(width * 0.034)}px RobotoBold`;
    centerText(ctx, `${day.hi}°`, cx, top + Math.round(width * 0.192));
    ctx.fillStyle = pal.muted;
    ctx.font = `${Math.round(width * 0.031)}px Roboto`;
    centerText(ctx, `${day.lo}°`, cx, top + Math.round(width * 0.236));
  });
}

// Draw text right-aligned to rx (pureimage has no textAlign).
function rightText(ctx, text, rx, y) {
  ctx.fillText(text, Math.round(rx - ctx.measureText(text).width), y);
}

function dayOfYear(d) {
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

// Encode the finished image to a PNG buffer.
async function encodePng(img) {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { out.on('end', res); out.on('error', rej); });
  await PImage.encodePNGToStream(img, out);
  await done;
  return Buffer.concat(chunks);
}

// Rotating end-of-day messages (stable within a day, varies day to day). No emoji —
// the bundled Roboto fonts have no color glyphs, so an emoji would render as tofu.
const DONE_MESSAGES = [
  "Everything's cleared. Enjoy the rest of your day.",
  "That's the whole day done. Go relax.",
  "Nice work — you finished it all.",
  "All wrapped up. Time to unwind.",
  "Done and dusted. Rest easy.",
  "You cleared the board today. Well done.",
  "Every item complete. Take a breather.",
  "That's a wrap on today. Great job.",
];

// The "you're done for the day" screen: no list, a success-colored check, and a kind
// note — drawn on the theme background the caller already painted.
function drawDoneScreen(ctx, { width, height, d, weekday, count, pal, weather }) {
  const cx = width / 2;

  if (weather) {
    if (weather.current) {
      // Icon + current temp, centered as one group just below the clock zone.
      const iconS = Math.round(width * 0.11);
      const baseY = Math.round(height * 0.31);
      ctx.font = `${Math.round(width * 0.09)}px RobotoBold`;
      const tt = `${weather.current.temp}°`;
      const gap = Math.round(width * 0.025);
      const x0 = cx - (iconS + gap + ctx.measureText(tt).width) / 2;
      drawWeatherIcon(ctx, weather.current.kind, x0 + iconS / 2, baseY - Math.round(width * 0.032), iconS, pal, weather.current.night);
      ctx.fillStyle = pal.text;
      ctx.fillText(tt, Math.round(x0 + iconS + gap), baseY);
      ctx.fillStyle = pal.muted;
      ctx.font = `${Math.round(width * 0.036)}px Roboto`;
      const label = [weather.current.label, `H ${weather.today.hi}°  L ${weather.today.lo}°`].filter(Boolean).join(' · ');
      centerText(ctx, label, cx, baseY + Math.round(width * 0.06));
    }
    const M = Math.round(width * 0.09);
    const BOTTOM_SAFE = Math.round(height * 0.14);
    drawForecastStrip(ctx, { weather, top: height - BOTTOM_SAFE - forecastStripH(width), M, width, pal });
  }

  // Success-colored check disc, centered below the clock zone.
  const R = Math.round(width * 0.12);
  const cy = Math.round(height * 0.46);
  ctx.fillStyle = pal.success;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  // Checkmark, in whichever of black/white reads on the success color.
  ctx.strokeStyle = contrastOn(pal.success);
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.round(R * 0.16);
  ctx.beginPath();
  ctx.moveTo(cx - R * 0.42, cy + R * 0.02);
  ctx.lineTo(cx - R * 0.10, cy + R * 0.34);
  ctx.lineTo(cx + R * 0.46, cy - R * 0.34);
  ctx.stroke();

  let ty = cy + R + Math.round(height * 0.060);
  ctx.fillStyle = pal.text;
  ctx.font = `${Math.round(width * 0.066)}px RobotoBold`;
  centerText(ctx, 'All done for today', cx, ty);
  ty += Math.round(height * 0.030);

  ctx.fillStyle = pal.sub;
  ctx.font = `${Math.round(width * 0.040)}px Roboto`;
  const msg = DONE_MESSAGES[dayOfYear(d) % DONE_MESSAGES.length];
  for (const line of wrapText(ctx, msg, Math.round(width * 0.80))) {
    centerText(ctx, line, cx, ty);
    ty += Math.round(width * 0.056);
  }

  ty += Math.round(height * 0.012);
  ctx.fillStyle = pal.muted;
  ctx.font = `${Math.round(width * 0.033)}px RobotoBold`;
  centerText(ctx, `${count} item${count === 1 ? '' : 's'} complete · ${weekday}, ${MONTHS[d.getMonth()]} ${d.getDate()}`, cx, ty);
}

async function renderScheduleWallpaper({ date, events, tasks, projects, theme, weather = null, width = 1290, height = 2796 }) {
  ensureFonts();
  const pal = paletteFor(theme);
  const { weekday, items } = itemsForDate({ date, events, tasks, projects });
  const d = new Date(date + 'T00:00:00');

  const img = PImage.make(width, height);
  const ctx = img.getContext('2d');

  // Background follows the app theme.
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, width, height);

  // The whole day is done → the calm "all done" screen (counts the full day).
  if (items.length && items.every((it) => it.completed)) {
    drawDoneScreen(ctx, { width, height, d, weekday, count: items.length, pal, weather });
    return encodePng(img);
  }

  // Once every appointment (event / class) is finished, drop them and show just the
  // assignments — by end of day you only care about what's still due.
  const appts = items.filter(isAppointment);
  const showList = (appts.length && appts.every((a) => a.completed))
    ? items.filter((it) => !isAppointment(it))
    : items;

  const total = showList.length;
  const doneCount = showList.filter((it) => it.completed).length;
  const ratio = total ? doneCount / total : 0;

  const M = Math.round(width * 0.09);            // side margin
  // Content sits high on the screen so the list clears the home-screen dock/hotbar;
  // BOTTOM_SAFE reserves ~1" of dock space so the last rows aren't cut off.
  let y = Math.round(height * 0.27);             // content top — below clock/widgets
  const BOTTOM_SAFE = Math.round(height * 0.14); // keep rows above the dock

  const trackW = width - 2 * M;

  // Weather, right side of the header: icon + current temp on the weekday line, the
  // day's high/low on the date line. `wxW` is the room it takes from the date line.
  let wxW = 0;
  if (weather) {
    const rightX = M + trackW;
    if (weather.current) {
      ctx.fillStyle = pal.text;
      ctx.font = `${Math.round(width * 0.072)}px RobotoBold`;
      const tt = `${weather.current.temp}°`;
      const tw = ctx.measureText(tt).width;
      rightText(ctx, tt, rightX, y);
      const iconS = Math.round(width * 0.085);
      drawWeatherIcon(ctx, weather.current.kind, rightX - tw - Math.round(width * 0.02) - iconS / 2,
        y - Math.round(width * 0.026), iconS, pal, weather.current.night);
    }
    ctx.fillStyle = pal.muted;
    ctx.font = `${Math.round(width * 0.040)}px Roboto`;
    const hl = `H ${weather.today.hi}°  L ${weather.today.lo}°`;
    wxW = ctx.measureText(hl).width + Math.round(width * 0.04);
    rightText(ctx, hl, rightX, y + Math.round(width * 0.052));
  }

  // Header: weekday + date + completion count.
  ctx.fillStyle = pal.text;
  ctx.font = `${Math.round(width * 0.072)}px RobotoBold`;
  ctx.fillText(weekday, M, y);
  y += Math.round(width * 0.052);
  ctx.fillStyle = pal.muted;
  ctx.font = `${Math.round(width * 0.040)}px Roboto`;
  const sub = total ? `${doneCount} of ${total} done` : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  ctx.fillText(fitText(ctx, total ? `${MONTHS[d.getMonth()]} ${d.getDate()} · ${sub}` : sub, trackW - wxW), M, y);
  y += Math.round(width * 0.055);

  if (total) {
    // Progress bar — a slim track that fills with the theme's success color as items are
    // checked off. The generous advance clears the first row, whose content sits
    // ~0.62·rowH above its baseline anchor.
    const barH = Math.round(width * 0.013);
    ctx.fillStyle = pal.border;
    ctx.fillRect(M, y, trackW, barH);
    if (ratio > 0) {
      ctx.fillStyle = pal.success;
      ctx.fillRect(M, y, Math.max(barH, Math.round(trackW * ratio)), barH);
    }
    y += Math.round(width * 0.105);
  } else {
    // Empty day — a plain divider, no progress track.
    ctx.fillStyle = pal.border;
    ctx.fillRect(M, y, trackW, 3);
    y += Math.round(width * 0.045);
  }

  if (!total) {
    ctx.fillStyle = pal.muted;
    ctx.font = `${Math.round(width * 0.046)}px Roboto`;
    ctx.fillText('No scheduled items today', M, y + Math.round(width * 0.02));
  }

  const rowH = Math.round(width * 0.115);
  const barW = Math.round(width * 0.014);
  const timeX = M + Math.round(width * 0.03);
  const textX = M + Math.round(width * 0.275);
  const textMaxW = width - textX - M;
  // The 7-day strip is anchored above the dock; the list fills the space above it.
  const stripTop = height - BOTTOM_SAFE - forecastStripH(width);
  const listBottom = weather ? stripTop - Math.round(width * 0.02) : height - BOTTOM_SAFE;
  const maxRows = Math.max(0, Math.floor((listBottom - y) / rowH));

  showList.slice(0, maxRows).forEach((it) => {
    const primary = it.completed ? pal.muted : pal.text;
    const secondary = it.completed ? pal.faint : pal.muted;
    // Accent bar.
    ctx.fillStyle = it.completed ? pal.border : it.color;
    ctx.fillRect(M, y - Math.round(rowH * 0.62), barW, Math.round(rowH * 0.72));
    // Time label.
    ctx.fillStyle = secondary;
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
      ctx.fillStyle = secondary;
      ctx.fillRect(textX, titleY - Math.round(width * 0.014), tw, 3);
    }
    // Subtitle (project · room).
    if (it.subtitle) {
      ctx.fillStyle = secondary;
      ctx.font = `${Math.round(width * 0.032)}px Roboto`;
      ctx.fillText(fitText(ctx, it.subtitle, textMaxW), textX, y + Math.round(rowH * 0.06));
    }
    y += rowH;
  });

  if (showList.length > maxRows) {
    ctx.fillStyle = pal.muted;
    ctx.font = `${Math.round(width * 0.036)}px Roboto`;
    ctx.fillText(`+ ${showList.length - maxRows} more`, textX, y);
  }

  if (weather) drawForecastStrip(ctx, { weather, top: stripTop, M, width, pal });

  return encodePng(img);
}

module.exports = { renderScheduleWallpaper, itemsForDate, time12 };
