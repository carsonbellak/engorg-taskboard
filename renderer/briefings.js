// Weekly briefings — two automatic popups, both rendered through the shared appTour
// slideshow engine (tour.js), so they match the onboarding / What's-New look:
//
//   • Monday  "Week ahead"   — an itinerary of everything due this week (notes with a
//     due date + calendar events), grouped by day. Shown once, on the first launch of
//     the week (gated by localStorage per Monday date).
//   • Friday  "Week wrapped" — a recap of what you finished this week plus what's left
//     for the weekend. Shown once on Friday, the moment every assignment due this week
//     is complete (re-checked live on tasks-changed), with a 5 PM fallback so it never
//     gets stuck if something's left undone.
//
// Everything here reads the in-memory dataManager collections; nothing is persisted
// except the tiny per-week "already shown" flags in localStorage (device-local).

const briefings = (() => {
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const FRIDAY_FALLBACK_HOUR = 17; // show the Friday wrap-up by 5 PM even if work is left
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // Monday (00:00) of the week containing d — the week anchor used for gating + ranges.
  function mondayOf(d) {
    const x = new Date(d); x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Sun→-6, Mon→0, … Sat→-5
    return x;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmtDayDate(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function fmtTime(hhmm) {
    if (!hhmm || !/^\d{1,2}:\d{2}/.test(hhmm)) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const ap = h < 12 ? 'AM' : 'PM';
    return `${((h + 11) % 12) + 1}:${pad(m)} ${ap}`;
  }

  const projOf = (id) => (dataManager.projects || []).find(p => p.id === id) || null;

  // Unified item shape used by both briefings, gathered from notes (by dueDate) and
  // calendar events (by date) within [startStr, endStr] inclusive (YYYY-MM-DD strings
  // compare lexicographically, so no Date objects needed for the range test).
  function collectItems(startStr, endStr) {
    const now = new Date();
    const items = [];
    for (const t of (dataManager.tasks || [])) {
      if (!t.dueDate || t.dueDate < startStr || t.dueDate > endStr) continue;
      const proj = projOf(t.projectId);
      const when = new Date(t.dueDate + 'T' + (t.dueTime || '23:59'));
      items.push({
        dateStr: t.dueDate, time: t.dueTime || '', sortT: t.dueTime || '99:99',
        title: t.title || '(untitled)', projName: proj ? proj.name : '', projColor: proj ? proj.color : '#94A3B8',
        completed: !!t.completed, isAssignment: t.category === 'assignment', kind: 'note',
        overdue: !t.completed && when < now, priority: t.priority || '',
      });
    }
    for (const s of (dataManager.scheduleItems || [])) {
      if (!s.date || s.date < startStr || s.date > endStr) continue;
      const proj = projOf(s.projectId);
      items.push({
        dateStr: s.date, time: s.startTime || '', sortT: s.startTime || '99:99',
        title: s.title || '(event)', projName: proj ? proj.name : '', projColor: proj ? proj.color : '#3B82F6',
        completed: !!s.completed, isAssignment: false, kind: 'event', overdue: false, priority: '',
      });
    }
    return items;
  }

  const byDay = (items, dateStr) => items
    .filter(i => i.dateStr === dateStr)
    .sort((a, b) => a.sortT.localeCompare(b.sortT) || a.title.localeCompare(b.title));

  function itemRow(i) {
    const cls = ['brief-item'];
    if (i.completed) cls.push('done');
    if (i.overdue) cls.push('overdue');
    const tag = i.isAssignment ? '<span class="brief-tag">ASGN</span>'
      : (i.kind === 'event' ? '<span class="brief-tag brief-tag-evt">EVENT</span>' : '');
    return `<li class="${cls.join(' ')}">
      <span class="brief-time">${esc(fmtTime(i.time) || (i.kind === 'event' ? '' : 'end of day'))}</span>
      <span class="brief-dot" style="background:${esc(i.projColor)}"></span>
      <span class="brief-title">${esc(i.title)}</span>
      ${tag}
      ${i.projName ? `<span class="brief-proj">${esc(i.projName)}</span>` : ''}
    </li>`;
  }

  // A grouped-by-day list across [weekStart .. weekStart+span-1].
  function dayGroupsHtml(items, weekStart, span, emptyMsg) {
    let html = '';
    for (let d = 0; d < span; d++) {
      const day = addDays(weekStart, d);
      const rows = byDay(items, ymd(day));
      if (!rows.length) continue;
      html += `<div class="brief-day">
          <span class="brief-day-name">${DAY_NAMES[day.getDay()]}</span>
          <span class="brief-day-date">${fmtDayDate(day)}</span>
          <span class="brief-day-count">${rows.length}</span>
        </div>
        <ul class="brief-ul">${rows.map(itemRow).join('')}</ul>`;
    }
    return html ? `<div class="brief-list">${html}</div>` : `<p class="brief-empty">${esc(emptyMsg)}</p>`;
  }

  // ── Monday: the week ahead ──────────────────────────────────────────────────
  function weekAheadSlides(now) {
    const weekStart = mondayOf(now);
    const weekEnd = addDays(weekStart, 6);
    const items = collectItems(ymd(weekStart), ymd(weekEnd));
    const todo = items.filter(i => !i.completed);
    const asg = todo.filter(i => i.isAssignment).length;
    const tasks = todo.filter(i => i.kind === 'note' && !i.isAssignment).length;
    const events = todo.filter(i => i.kind === 'event').length;

    const bits = [];
    if (asg) bits.push(`<b>${asg}</b> assignment${asg === 1 ? '' : 's'}`);
    if (tasks) bits.push(`<b>${tasks}</b> task${tasks === 1 ? '' : 's'}`);
    if (events) bits.push(`<b>${events}</b> event${events === 1 ? '' : 's'}`);
    const summary = bits.length
      ? `You've got ${bits.join(', ').replace(/, ([^,]*)$/, ' and $1')} on the board this week.`
      : 'Nothing is on the board for this week yet — a clean slate.';

    const range = `${fmtDayDate(weekStart)} – ${fmtDayDate(weekEnd)}`;
    return [
      { emoji: '📅', title: 'Your week ahead', bodyHtml: `<p class="brief-range">${esc(range)}</p><p>${summary}</p>` },
      { emoji: '🗒️', title: "This week's itinerary",
        bodyHtml: dayGroupsHtml(items, weekStart, 7, 'Nothing scheduled this week. Enjoy the breathing room!') },
    ];
  }

  // ── Friday: the week wrapped + weekend outlook ──────────────────────────────
  function weekReviewSlides(now) {
    const weekStart = mondayOf(now);
    const friday = addDays(weekStart, 4);
    const saturday = addDays(weekStart, 5);
    const sunday = addDays(weekStart, 6);

    // Completed this week (by completion timestamp within the week window).
    const wkStartMs = weekStart.getTime();
    const wkEndMs = addDays(weekStart, 7).getTime();
    let doneAsg = 0, doneTasks = 0;
    for (const t of (dataManager.tasks || [])) {
      if (!t.completed || !t.completedAt) continue;
      const ms = new Date(t.completedAt).getTime();
      if (isNaN(ms) || ms < wkStartMs || ms >= wkEndMs) continue;
      if (t.category === 'assignment') doneAsg++; else doneTasks++;
    }

    const bits = [];
    if (doneAsg) bits.push(`<b>${doneAsg}</b> assignment${doneAsg === 1 ? '' : 's'}`);
    if (doneTasks) bits.push(`<b>${doneTasks}</b> other task${doneTasks === 1 ? '' : 's'}`);
    const recap = bits.length
      ? `You wrapped up ${bits.join(' and ')} this week. Nice work. 🎉`
      : 'A quiet week on the board — enjoy the weekend.';

    // Left for the weekend: incomplete items due Sat/Sun, plus any still-overdue carryover.
    const weekendItems = collectItems(ymd(saturday), ymd(sunday)).filter(i => !i.completed);
    const overdue = collectItems('1970-01-01', ymd(friday)).filter(i => !i.completed && i.overdue);
    // De-dupe overdue vs weekend (different ranges, so no overlap) — just concat.
    const left = overdue.concat(weekendItems);

    let leftHtml;
    if (!left.length) {
      leftHtml = '<p class="brief-empty">Your weekend is clear — nothing due. Go enjoy it. 🌤️</p>';
    } else {
      let html = '';
      if (overdue.length) {
        html += `<div class="brief-day brief-day-overdue"><span class="brief-day-name">Still overdue</span>
            <span class="brief-day-count">${overdue.length}</span></div>
          <ul class="brief-ul">${overdue.sort((a, b) => a.dateStr.localeCompare(b.dateStr)).map(itemRow).join('')}</ul>`;
      }
      for (const d of [saturday, sunday]) {
        const rows = byDay(weekendItems, ymd(d));
        if (!rows.length) continue;
        html += `<div class="brief-day"><span class="brief-day-name">${DAY_NAMES[d.getDay()]}</span>
            <span class="brief-day-date">${fmtDayDate(d)}</span><span class="brief-day-count">${rows.length}</span></div>
          <ul class="brief-ul">${rows.map(itemRow).join('')}</ul>`;
      }
      leftHtml = `<div class="brief-list">${html}</div>`;
    }

    return [
      { emoji: '✅', title: 'Week wrapped', bodyHtml: `<p>${recap}</p>` },
      { emoji: '🧭', title: 'Left for the weekend', bodyHtml: leftHtml },
    ];
  }

  // ── gating + triggers ───────────────────────────────────────────────────────
  const seen = (key) => { try { return !!localStorage.getItem(key); } catch { return false; } };
  const markSeen = (key) => { try { localStorage.setItem(key, new Date().toISOString()); } catch {} };

  function assignmentsDueThroughFriday(now) {
    const weekStart = mondayOf(now);
    const fri = ymd(addDays(weekStart, 4));
    const start = ymd(weekStart);
    return (dataManager.tasks || []).filter(t =>
      t.category === 'assignment' && t.dueDate && t.dueDate >= start && t.dueDate <= fri);
  }

  async function showTour(slides, finishLabel) {
    if (typeof appTour === 'undefined' || appTour.isActive()) return false;
    await appTour.run(slides, { finishLabel: finishLabel || 'Got it' });
    return true;
  }

  // Called at startup and again on tasks-changed. Idempotent: the per-week localStorage
  // flags mean each briefing shows at most once per week regardless of how often we run.
  async function maybeShow() {
    if (typeof dataManager === 'undefined' || typeof appTour === 'undefined') return false;
    if (appTour.isActive()) return false;
    const now = new Date();
    const dow = now.getDay();
    const wkKey = ymd(mondayOf(now));

    // Mark the week "seen" only once the popup has actually shown — otherwise a briefing
    // that's blocked (e.g. onboarding still on screen) would be burned for the whole week
    // without ever appearing, which is why these never surfaced before.
    if (dow === 1) { // Monday
      const key = 'engorg_brief_mon_' + wkKey;
      if (seen(key)) return false;
      const shown = await showTour(weekAheadSlides(now), 'Let’s go');
      if (shown) markSeen(key);
      return shown;
    }

    if (dow === 5) { // Friday
      const key = 'engorg_brief_fri_' + wkKey;
      if (seen(key)) return false;
      const asg = assignmentsDueThroughFriday(now);
      const allDone = asg.length > 0 && asg.every(t => t.completed);
      const pastFallback = now.getHours() >= FRIDAY_FALLBACK_HOUR;
      if (!allDone && !pastFallback) return false; // wait until finished (or the evening)
      const shown = await showTour(weekReviewSlides(now), 'Have a great weekend');
      if (shown) markSeen(key);
      return shown;
    }

    return false;
  }

  // Manual previews (ignore gating) — handy for testing and for the Settings button.
  function previewWeekAhead() { return showTour(weekAheadSlides(new Date()), 'Close'); }
  function previewWeekReview() { return showTour(weekReviewSlides(new Date()), 'Close'); }
  // Day-aware manual trigger for the "Show weekly briefing" button: the wrap-up recap
  // on Fri/Sat/Sun, the week-ahead itinerary otherwise.
  function preview() {
    const dow = new Date().getDay();
    return (dow === 5 || dow === 6 || dow === 0) ? previewWeekReview() : previewWeekAhead();
  }

  return { maybeShow, preview, previewWeekAhead, previewWeekReview };
})();

window.briefings = briefings;
