// Daily briefings — an automatic once-a-day popup rendered through the shared appTour
// slideshow engine (tour.js), so it matches the onboarding / What's-New look.
//
// It fires at most once per calendar day (gated by a localStorage flag per YYYY-MM-DD)
// on the first launch of the day, and always leads with:
//   1. a greeting + a one-line summary of the day's load + a strip of relevant stats
//      (streak, done this week, completion rate, net flow, overdue, stale);
//   2. today's agenda — anything due today + today's events, with overdue carryover.
// Two days get an extra, day-appropriate slide folded on:
//   • Monday  → "This week's itinerary" (everything due this week, grouped by day);
//   • Friday  → "Week wrapped" recap + the weekend/overdue outlook.
//
// Everything here reads the in-memory dataManager collections; nothing is persisted
// except the tiny per-day "already shown" flag in localStorage (device-local).

const briefings = (() => {
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const ONE_WEEK = 7 * ONE_DAY;

  // Monday (00:00) of the week containing d — the week anchor used for ranges + stats.
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

  // Unified item shape, gathered from notes (by dueDate) and calendar events (by date)
  // within [startStr, endStr] inclusive (YYYY-MM-DD strings compare lexicographically,
  // so no Date objects needed for the range test).
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

  // ── Relevant stats (a light echo of the Stats dashboard's headline numbers) ─────
  function computeStats(now) {
    const tasks = dataManager.tasks || [];
    const nowMs = now.getTime();
    const todayStr = ymd(now);
    const yStr = ymd(new Date(nowMs - ONE_DAY));
    const wkStartMs = mondayOf(now).getTime();

    const completed = tasks.filter(t => t.completed);
    const total = tasks.length;
    const rate = total ? Math.round((completed.length / total) * 100) : 0;

    const compDay = (t) => (t.completedAt ? ymd(new Date(t.completedAt)) : null);
    const completedToday = completed.filter(t => compDay(t) === todayStr).length;
    const completedYest = completed.filter(t => compDay(t) === yStr).length;
    const completedThisWeek = completed.filter(t => t.completedAt && new Date(t.completedAt).getTime() >= wkStartMs).length;
    const createdThisWeek = tasks.filter(t => t.createdAt && new Date(t.createdAt).getTime() >= wkStartMs).length;
    const net = completedThisWeek - createdThisWeek;

    const last30 = completed.filter(t => t.completedAt && (nowMs - new Date(t.completedAt).getTime()) < 30 * ONE_DAY).length;
    const velocity = +(last30 / (30 / 7)).toFixed(1);

    const incomplete = tasks.filter(t => !t.completed);
    const stale = incomplete.filter(t => (nowMs - new Date(t.modifiedAt || t.createdAt).getTime()) > ONE_WEEK).length;

    let dueTodayTotal = 0, dueTodayLeft = 0, overdue = 0;
    for (const t of tasks) {
      if (!t.dueDate) continue;
      if (t.dueDate === todayStr) { dueTodayTotal++; if (!t.completed) dueTodayLeft++; }
      if (!t.completed && new Date(t.dueDate + 'T' + (t.dueTime || '23:59')) < now) overdue++;
    }

    // Current completion streak (must run up to today or yesterday).
    const days = [...new Set(completed.filter(t => t.completedAt).map(t => ymd(new Date(t.completedAt))))].sort();
    let streak = 0;
    if (days.length) {
      const last = days[days.length - 1];
      if (last === todayStr || last === yStr) {
        streak = 1;
        for (let i = days.length - 2; i >= 0; i--) {
          if ((new Date(days[i + 1]) - new Date(days[i])) / ONE_DAY <= 1) streak++; else break;
        }
      }
    }

    return { rate, completedToday, completedYest, completedThisWeek, createdThisWeek,
             net, velocity, stale, dueTodayTotal, dueTodayLeft, overdue, streak };
  }

  function chip(emoji, value, label, tone) {
    return `<div class="brief-chip${tone ? ' brief-chip-' + tone : ''}">
      <span class="brief-chip-emoji">${emoji}</span>
      <span class="brief-chip-val">${esc(value)}</span>
      <span class="brief-chip-label">${esc(label)}</span>
    </div>`;
  }
  function statChipsHtml(s) {
    return `<div class="brief-chips">
      ${chip('🔥', s.streak, 'day streak')}
      ${chip('✅', s.completedThisWeek, 'done this wk')}
      ${chip('📊', s.rate + '%', 'completion')}
      ${chip('⚖️', (s.net >= 0 ? '+' : '') + s.net, 'net this wk', s.net >= 0 ? 'good' : 'bad')}
      ${chip('⏳', s.overdue, 'overdue', s.overdue > 0 ? 'bad' : '')}
      ${chip('💤', s.stale, 'stale', s.stale > 0 ? 'warn' : '')}
    </div>`;
  }

  function greeting(now) {
    const h = now.getHours();
    if (h < 12) return { emoji: '☀️', word: 'Good morning' };
    if (h < 17) return { emoji: '🌤️', word: 'Good afternoon' };
    return { emoji: '🌙', word: 'Good evening' };
  }

  // Today's agenda: any still-overdue carryover, then everything on today's plate.
  function todayAgendaHtml(now, todayItems) {
    const yesterday = ymd(new Date(now.getTime() - ONE_DAY));
    const overdue = collectItems('1970-01-01', yesterday).filter(i => !i.completed && i.overdue);
    const rows = [...todayItems].sort((a, b) => a.sortT.localeCompare(b.sortT) || a.title.localeCompare(b.title));

    let html = '';
    if (overdue.length) {
      html += `<div class="brief-day brief-day-overdue"><span class="brief-day-name">Overdue</span>
          <span class="brief-day-count">${overdue.length}</span></div>
        <ul class="brief-ul">${overdue.sort((a, b) => a.dateStr.localeCompare(b.dateStr)).map(itemRow).join('')}</ul>`;
    }
    if (rows.length) {
      html += `<div class="brief-day"><span class="brief-day-name">Today</span>
          <span class="brief-day-date">${fmtDayDate(now)}</span><span class="brief-day-count">${rows.length}</span></div>
        <ul class="brief-ul">${rows.map(itemRow).join('')}</ul>`;
    }
    if (!html) return '<p class="brief-empty">Nothing due today and nothing overdue — enjoy the open day. 🌿</p>';
    return `<div class="brief-list">${html}</div>`;
  }

  // ── The daily briefing ──────────────────────────────────────────────────────
  function dailySlides(now) {
    const s = computeStats(now);
    const g = greeting(now);
    const todayStr = ymd(now);
    const todayItems = collectItems(todayStr, todayStr);
    const dueNotes = todayItems.filter(i => i.kind === 'note' && !i.completed).length;
    const events = todayItems.filter(i => i.kind === 'event' && !i.completed).length;

    const bits = [];
    if (dueNotes) bits.push(`<b>${dueNotes}</b> due`);
    if (events) bits.push(`<b>${events}</b> event${events === 1 ? '' : 's'}`);
    let summary = bits.length
      ? `You have ${bits.join(' and ')} today.`
      : "Nothing's on the calendar for today — a clear runway. 🛫";
    if (s.overdue) summary += ` <span class="brief-warn">⚠️ ${s.overdue} still overdue.</span>`;

    const dateLine = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    const slides = [
      { emoji: g.emoji, title: g.word,
        bodyHtml: `<p class="brief-range">${esc(dateLine)}</p><p>${summary}</p>${statChipsHtml(s)}` },
      { emoji: '🗓️', title: "Today's agenda", bodyHtml: todayAgendaHtml(now, todayItems) },
    ];

    // Day-appropriate extra: the week ahead on Monday, the week wrapped on Friday.
    const dow = now.getDay();
    if (dow === 1) {
      const wk = weekAheadSlides(now);
      slides.push(wk[wk.length - 1]); // "This week's itinerary"
    } else if (dow === 5) {
      const wr = weekReviewSlides(now);
      slides.push(wr[0], wr[1]); // "Week wrapped" recap + weekend/overdue outlook
    }
    return slides;
  }

  // ── Monday: the week ahead (itinerary slide is reused by the Monday daily brief) ─
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

  async function showTour(slides, finishLabel) {
    if (typeof appTour === 'undefined' || appTour.isActive()) return false;
    await appTour.run(slides, { finishLabel: finishLabel || 'Got it' });
    return true;
  }

  // Called at startup and again on tasks-changed. Idempotent: the per-day localStorage
  // flag means the briefing shows at most once per calendar day regardless of how often
  // this runs. The flag is set only once the popup has actually shown — otherwise a
  // briefing blocked behind onboarding would be burned for the whole day unseen.
  async function maybeShow() {
    if (typeof dataManager === 'undefined' || typeof appTour === 'undefined') return false;
    if (appTour.isActive()) return false;
    const now = new Date();
    const key = 'engorg_brief_day_' + ymd(now);
    if (seen(key)) return false;
    const shown = await showTour(dailySlides(now), "Let's go");
    if (shown) markSeen(key);
    return shown;
  }

  // Manual previews (ignore gating) — handy for testing and for the Settings button.
  function previewDaily() { return showTour(dailySlides(new Date()), 'Close'); }
  function previewWeekAhead() { return showTour(weekAheadSlides(new Date()), 'Close'); }
  function previewWeekReview() { return showTour(weekReviewSlides(new Date()), 'Close'); }
  const preview = previewDaily; // the "Show briefing" button always shows today's brief

  return { maybeShow, preview, previewDaily, previewWeekAhead, previewWeekReview };
})();

window.briefings = briefings;
