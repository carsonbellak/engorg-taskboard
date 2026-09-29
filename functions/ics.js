// Pure ICS (iCalendar) builder for the subscribed calendar feed.
//
// Kept side-effect-free (no firebase-admin, no network) so it can be unit-tested in
// isolation and reused. `calendarFeed` in index.js reads the user's three Firestore
// docs and hands the arrays here.
//
// The feed mirrors exactly what the in-app calendar draws from, so an iPhone subscribed
// calendar (and its lockscreen widget) shows the same schedule:
//   1) scheduled events          — schedule.items (date-based, or day-only → weekly)
//   2) due-dated notes           — tasks[] with a dueDate (assignments included)
//   3) recurring work blocks     — projects[].workSchedule[] (weekly per weekday)
//
// Times are emitted as "floating" local times (no TZID/Z) so each event lands at the
// same wall-clock time in the viewer's own timezone — the app stores wall-clock times.

function escapeICS(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Weekday name (full "Monday" or 3-letter "Mon") → iCal BYDAY code.
function dayToByday(day) {
  const map = { sun: 'SU', mon: 'MO', tue: 'TU', wed: 'WE', thu: 'TH', fri: 'FR', sat: 'SA' };
  return map[String(day || '').slice(0, 3).toLowerCase()] || null;
}

// A concrete YYYY-MM-DD anchor for a BYDAY code, used as a weekly RRULE's DTSTART. Any
// date whose weekday matches works; we use that weekday within the current UTC week.
// (Everything here is UTC-consistent, so the anchor's weekday always equals `byday`.)
function anchorForByday(byday, now = new Date()) {
  const order = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const target = order.indexOf(byday);
  if (target < 0) return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay() + target);
  return d.toISOString().slice(0, 10);
}

function icsStamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Append one VEVENT to `lines`. o = { uid, summary, date:'YYYY-MM-DD', startTime, endTime,
// description, completed, createdAt, rrule, alarm }.
function pushVevent(lines, o) {
  if (!o.date || !o.summary) return;
  const dateStr = o.date.replace(/-/g, '');
  lines.push('BEGIN:VEVENT');

  if (o.startTime) {
    lines.push(`DTSTART:${dateStr}T${o.startTime.replace(':', '')}00`);
    if (o.endTime) {
      lines.push(`DTEND:${dateStr}T${o.endTime.replace(':', '')}00`);
    } else {
      // No explicit end → 1-hour block, but never roll past midnight (a 23:xx deadline
      // clamps to end-of-day so the VEVENT stays on its own date and stays valid).
      const [h, m] = o.startTime.split(':').map(Number);
      let eh = h + 1, em = m || 0;
      if (eh >= 24) { eh = 23; em = 59; }
      lines.push(`DTEND:${dateStr}T${String(eh).padStart(2, '0')}${String(em).padStart(2, '0')}00`);
    }
  } else {
    lines.push(`DTSTART;VALUE=DATE:${dateStr}`);
    const d = new Date(o.date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    lines.push(`DTEND;VALUE=DATE:${d.toISOString().slice(0, 10).replace(/-/g, '')}`);
  }

  if (o.rrule) lines.push(`RRULE:${o.rrule}`);
  lines.push(`DTSTAMP:${icsStamp(o.createdAt)}`);
  const uid = o.uid || `engorg-${dateStr}-${Math.random().toString(36).slice(2, 8)}`;
  lines.push(`UID:${uid}@engorg`);
  lines.push(`SUMMARY:${escapeICS(o.summary)}`);
  if (o.description) lines.push(`DESCRIPTION:${escapeICS(o.description)}`);
  // Completed items are marked cancelled — Apple Calendar hides them, keeping the
  // lockscreen focused on what's still outstanding.
  lines.push(o.completed ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED');
  if (o.alarm && !o.completed) {
    lines.push('BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY',
      `DESCRIPTION:${escapeICS(o.summary)}`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
}

// Build the full VCALENDAR string from a user's three data arrays.
function buildCalendarIcs({ events = [], tasks = [], projects = [] } = {}) {
  const projName = {};
  for (const p of projects) if (p && p.id) projName[p.id] = p.name;

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

  // 1) Scheduled calendar events. A date-less event that carries a weekday recurs weekly.
  for (const evt of events) {
    if (!evt || !evt.title) continue;
    if (evt.date) {
      pushVevent(lines, {
        uid: evt.id, summary: evt.title, date: evt.date,
        startTime: evt.startTime, endTime: evt.endTime,
        description: evt.description, completed: evt.completed,
        createdAt: evt.createdAt, alarm: !!evt.startTime,
      });
    } else if (evt.day) {
      const byday = dayToByday(evt.day);
      const anchor = byday && anchorForByday(byday);
      if (!anchor) continue;
      pushVevent(lines, {
        uid: evt.id, summary: evt.title, date: anchor,
        startTime: evt.startTime, endTime: evt.endTime,
        description: evt.description, rrule: `FREQ=WEEKLY;BYDAY=${byday}`,
        alarm: !!evt.startTime,
      });
    }
  }

  // 2) Due-dated notes (assignments and any note given a due date). The due date/time is
  //    the calendar appearance — matches how the in-app calendar renders notes.
  for (const t of tasks) {
    if (!t || !t.title || !t.dueDate) continue;
    const proj = projName[t.projectId];
    const desc = [t.description, proj ? `Project: ${proj}` : '']
      .filter(Boolean).join(t.description && proj ? ' — ' : '');
    pushVevent(lines, {
      uid: t.id, summary: t.title, date: t.dueDate,
      startTime: t.dueTime, endTime: null,
      description: desc, completed: t.completed, createdAt: t.createdAt,
      alarm: !!t.dueTime,
    });
  }

  // 3) Recurring project work blocks (project.workSchedule → weekly per weekday).
  for (const p of projects) {
    if (!p) continue;
    (p.workSchedule || []).forEach((wb, i) => {
      if (!wb || !wb.day || !wb.start) return;
      const byday = dayToByday(wb.day);
      const anchor = byday && anchorForByday(byday);
      if (!anchor) return;
      pushVevent(lines, {
        uid: `wblock_${p.id}_${i}`, summary: `${p.name || 'Work'} (work)`,
        date: anchor, startTime: wb.start, endTime: wb.end || wb.start,
        description: 'Project work block', rrule: `FREQ=WEEKLY;BYDAY=${byday}`,
        alarm: false,
      });
    });
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

module.exports = { buildCalendarIcs, escapeICS, dayToByday, anchorForByday, pushVevent };
