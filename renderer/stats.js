// Stats Dashboard - interactive task analytics and metrics

function renderStats() {
  const container = document.getElementById('view-stats');
  const tasks = dataManager.tasks;
  const projects = dataManager.projects;
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const ONE_WEEK = 7 * ONE_DAY;

  // === Gather data ===
  const completed = tasks.filter(t => t.completed);
  const incomplete = tasks.filter(t => !t.completed);
  const total = tasks.length;

  const completionTimes = completed
    .filter(t => t.createdAt && t.completedAt)
    .map(t => ({
      ms: new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime(),
      category: t.category || 'uncategorized',
      priority: t.priority || 'Medium',
      projectId: t.projectId
    }));

  // === Helpers ===
  function formatDuration(ms) {
    if (ms <= 0) return '\u2014';
    const hours = ms / (1000 * 60 * 60);
    if (hours < 1) return Math.round(ms / (1000 * 60)) + 'm';
    if (hours < 24) return Math.round(hours) + 'h';
    const days = hours / 24;
    if (days < 7) return days.toFixed(1) + 'd';
    return (days / 7).toFixed(1) + 'w';
  }
  function avg(arr) { return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length; }
  function median(arr) {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }

  // === Compute ===
  const completionRate = pct(completed.length, total);
  const avgCompletionTime = avg(completionTimes.map(t => t.ms));
  const medianCompletionTime = median(completionTimes.map(t => t.ms));

  // By category
  const categories = [...new Set(tasks.map(t => t.category || 'uncategorized'))];
  const categoryStats = categories.map(cat => {
    const catTasks = tasks.filter(t => (t.category || 'uncategorized') === cat);
    const catCompleted = catTasks.filter(t => t.completed);
    const catTimes = completionTimes.filter(t => t.category === cat).map(t => t.ms);
    const catInfo = APP_CATEGORIES.find(c => c.id === cat) || { name: cat, color: '#64748B' };
    return {
      id: cat, label: catInfo.name, color: catInfo.color || '#64748B',
      total: catTasks.length, completed: catCompleted.length,
      rate: pct(catCompleted.length, catTasks.length),
      avgTime: avg(catTimes), medianTime: median(catTimes), count: catTimes.length
    };
  }).sort((a, b) => b.total - a.total);

  // By priority
  const priorityStats = ['High', 'Medium', 'Low'].map(pri => {
    const priTasks = tasks.filter(t => (t.priority || 'Medium') === pri);
    const priCompleted = priTasks.filter(t => t.completed);
    const priTimes = completionTimes.filter(t => t.priority === pri).map(t => t.ms);
    return {
      label: pri, color: PRIORITY_COLORS[pri] || '#F97316',
      total: priTasks.length, completed: priCompleted.length,
      rate: pct(priCompleted.length, priTasks.length),
      avgTime: avg(priTimes), medianTime: median(priTimes), count: priTimes.length
    };
  });

  // By project
  const projectStats = projects.map(proj => {
    const pt = tasks.filter(t => t.projectId === proj.id);
    const pc = pt.filter(t => t.completed);
    const pi = pt.filter(t => !t.completed);
    const ptimes = completionTimes.filter(t => t.projectId === proj.id).map(t => t.ms);
    const oldest = pi.length > 0 ? Math.max(...pi.map(t => now - new Date(t.createdAt).getTime())) : 0;
    return {
      name: proj.name, color: proj.color, total: pt.length,
      completed: pc.length, open: pi.length,
      rate: pct(pc.length, pt.length), avgTime: avg(ptimes), oldestOpen: oldest
    };
  }).sort((a, b) => b.total - a.total);

  // Stale
  const staleTasks = incomplete
    .filter(t => (now - new Date(t.modifiedAt || t.createdAt).getTime()) > ONE_WEEK)
    .sort((a, b) => new Date(a.modifiedAt || a.createdAt) - new Date(b.modifiedAt || b.createdAt));

  // Weekly throughput (12 weeks)
  const WEEKS = 12;
  const weeklyData = [];
  for (let i = 0; i < WEEKS; i++) {
    const ws = now - (i + 1) * ONE_WEEK, we = now - i * ONE_WEEK;
    const done = completed.filter(t => { const ca = new Date(t.completedAt).getTime(); return ca >= ws && ca < we; }).length;
    const created = tasks.filter(t => { const ca = new Date(t.createdAt).getTime(); return ca >= ws && ca < we; }).length;
    const label = i === 0 ? 'This wk' : i === 1 ? 'Last wk' : `${i}w ago`;
    weeklyData.push({ label, done, created });
  }
  weeklyData.reverse();

  // Day distribution
  const DAYS_LIST = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dayDist = {};
  DAYS_LIST.forEach(d => dayDist[d] = { total: 0, done: 0 });
  tasks.forEach(t => { if (t.day) { dayDist[t.day].total++; if (t.completed) dayDist[t.day].done++; } });
  const maxDay = Math.max(...DAYS_LIST.map(d => dayDist[d].total), 1);

  // Misc
  const avgAge = incomplete.length > 0 ? avg(incomplete.map(t => now - new Date(t.createdAt).getTime())) : 0;
  const oldestTask = incomplete.length > 0 ? incomplete.reduce((a, b) => new Date(a.createdAt) < new Date(b.createdAt) ? a : b) : null;
  const completedLast7 = completed.filter(t => t.completedAt && (now - new Date(t.completedAt).getTime()) < ONE_WEEK).length;
  const completedLast30 = completed.filter(t => t.completedAt && (now - new Date(t.completedAt).getTime()) < 30 * ONE_DAY).length;
  const createdLast7 = tasks.filter(t => t.createdAt && (now - new Date(t.createdAt).getTime()) < ONE_WEEK).length;
  const createdLast30 = tasks.filter(t => t.createdAt && (now - new Date(t.createdAt).getTime()) < 30 * ONE_DAY).length;

  // Recently completed
  const recentlyCompleted = completed
    .filter(t => t.completedAt)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 8);

  // SVG ring helper
  function ring(pctVal, size, stroke, color, bgColor) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c - (pctVal / 100) * c;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="stats-ring">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${bgColor || 'rgba(0,0,0,0.06)'}" stroke-width="${stroke}"/>
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-dasharray="${c}" stroke-dashoffset="${offset}" stroke-linecap="round"
        transform="rotate(-90 ${size/2} ${size/2})" class="stats-ring-fill"/>
    </svg>`;
  }

  // Sparkline SVG helper
  function sparkline(data, w, h, color) {
    if (data.length === 0) return '';
    const max = Math.max(...data, 1);
    const step = w / (data.length - 1 || 1);
    const pts = data.map((v, i) => `${i * step},${h - (v / max) * h * 0.85 - 2}`).join(' ');
    const area = `${pts} ${w},${h} 0,${h}`;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="stats-sparkline">
      <polygon points="${area}" fill="${color}" opacity="0.15"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }

  const maxWeekly = Math.max(...weeklyData.map(w => Math.max(w.done, w.created)), 1);

  // Completion streaks
  const completedDates = completed
    .filter(t => t.completedAt)
    .map(t => new Date(t.completedAt).toISOString().slice(0, 10))
    .sort();
  const uniqueDates = [...new Set(completedDates)];
  let currentStreak = 0, bestStreak = 0, tempStreak = 0;
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(now - ONE_DAY).toISOString().slice(0, 10);
  // Calculate best streak
  for (let i = 0; i < uniqueDates.length; i++) {
    if (i === 0) { tempStreak = 1; }
    else {
      const prev = new Date(uniqueDates[i - 1]);
      const curr = new Date(uniqueDates[i]);
      const diff = (curr - prev) / ONE_DAY;
      tempStreak = diff <= 1 ? tempStreak + 1 : 1;
    }
    bestStreak = Math.max(bestStreak, tempStreak);
  }
  // Current streak (must include today or yesterday)
  if (uniqueDates.length > 0) {
    const last = uniqueDates[uniqueDates.length - 1];
    if (last === todayStr || last === yesterdayStr) {
      currentStreak = 1;
      for (let i = uniqueDates.length - 2; i >= 0; i--) {
        const prev = new Date(uniqueDates[i]);
        const curr = new Date(uniqueDates[i + 1]);
        if ((curr - prev) / ONE_DAY <= 1) currentStreak++;
        else break;
      }
    }
  }

  // Activity heatmap (last 12 weeks = 84 days)
  const heatmapDays = 84;
  const heatmapData = [];
  for (let i = heatmapDays - 1; i >= 0; i--) {
    const d = new Date(now - i * ONE_DAY);
    const ds = d.toISOString().slice(0, 10);
    const count = completedDates.filter(x => x === ds).length;
    heatmapData.push({ date: ds, count, dow: d.getDay() });
  }
  const heatMax = Math.max(...heatmapData.map(d => d.count), 1);

  // Time-to-complete distribution (buckets)
  const timeBuckets = [
    { label: '<1h', max: 3600000 },
    { label: '1-4h', max: 14400000 },
    { label: '4-24h', max: 86400000 },
    { label: '1-3d', max: 259200000 },
    { label: '3-7d', max: 604800000 },
    { label: '1-2w', max: 1209600000 },
    { label: '2-4w', max: 2592000000 },
    { label: '1m+', max: Infinity }
  ];
  const timeDistribution = timeBuckets.map(b => ({ ...b, count: 0 }));
  completionTimes.forEach(t => {
    for (const bucket of timeDistribution) {
      if (t.ms < bucket.max) { bucket.count++; break; }
    }
  });
  const maxTimeBucket = Math.max(...timeDistribution.map(b => b.count), 1);

  // Overdue estimation (tasks with high priority open > 7 days, or medium > 14 days)
  const overdueTasks = incomplete.filter(t => {
    const age = now - new Date(t.createdAt).getTime();
    const pri = t.priority || 'Medium';
    if (pri === 'High') return age > 7 * ONE_DAY;
    if (pri === 'Medium') return age > 14 * ONE_DAY;
    return age > 30 * ONE_DAY;
  }).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Productivity score (0-100 composite)
  const velocityScore = Math.min(completedLast7 * 10, 30); // max 30
  const completionScore = completionRate * 0.25; // max 25
  const streakScore = Math.min(currentStreak * 5, 20); // max 20
  const freshScore = staleTasks.length === 0 ? 15 : Math.max(0, 15 - staleTasks.length * 2); // max 15
  const netScore = (completedLast7 >= createdLast7) ? 10 : Math.max(0, 10 - (createdLast7 - completedLast7) * 2); // max 10
  const productivityScore = Math.round(Math.min(velocityScore + completionScore + streakScore + freshScore + netScore, 100));

  // Tasks created per month (last 6 months)
  const monthlyData = [];
  for (let i = 0; i < 6; i++) {
    const ms = new Date(now);
    ms.setMonth(ms.getMonth() - i);
    const mStart = new Date(ms.getFullYear(), ms.getMonth(), 1).getTime();
    const mEnd = new Date(ms.getFullYear(), ms.getMonth() + 1, 0, 23, 59, 59).getTime();
    const created = tasks.filter(t => { const c = new Date(t.createdAt).getTime(); return c >= mStart && c <= mEnd; }).length;
    const done = completed.filter(t => { const c = new Date(t.completedAt).getTime(); return c >= mStart && c <= mEnd; }).length;
    const label = ms.toLocaleString('default', { month: 'short' });
    monthlyData.push({ label, created, done });
  }
  monthlyData.reverse();
  const maxMonthly = Math.max(...monthlyData.map(m => Math.max(m.created, m.done)), 1);

  // Focus areas — which categories had most work this week
  const focusThisWeek = categories.map(cat => {
    const catInfo = APP_CATEGORIES.find(c => c.id === cat) || { name: cat, color: '#64748B' };
    const doneThisWeek = completed.filter(t =>
      (t.category || 'uncategorized') === cat &&
      t.completedAt && (now - new Date(t.completedAt).getTime()) < ONE_WEEK
    ).length;
    return { label: catInfo.name, color: catInfo.color || '#64748B', count: doneThisWeek };
  }).filter(f => f.count > 0).sort((a, b) => b.count - a.count);

  // === RENDER ===
  container.innerHTML = `
    <div class="stats-dashboard">

      <!-- Hero KPIs -->
      <div class="stats-hero">
        <div class="stats-hero-left">
          <h2 class="stats-title">Dashboard</h2>
          <p class="stats-subtitle">${total} tasks across ${projects.length} projects</p>
        </div>
        <div class="stats-hero-kpis">
          <div class="stats-kpi stats-kpi-accent" data-tooltip="Tasks completed this week">
            <div class="stats-kpi-icon">\u26A1</div>
            <div class="stats-kpi-body">
              <div class="stats-kpi-value stats-animate-number" data-target="${completedLast7}">${completedLast7}</div>
              <div class="stats-kpi-label">This Week</div>
            </div>
          </div>
          <div class="stats-kpi" data-tooltip="Tasks completed this month">
            <div class="stats-kpi-icon">\uD83D\uDCC8</div>
            <div class="stats-kpi-body">
              <div class="stats-kpi-value">${completedLast30}</div>
              <div class="stats-kpi-label">This Month</div>
            </div>
          </div>
          <div class="stats-kpi" data-tooltip="${createdLast7} created / ${completedLast7} done this week">
            <div class="stats-kpi-icon">\uD83D\uDD04</div>
            <div class="stats-kpi-body">
              <div class="stats-kpi-value">${(completedLast30 / 4.3).toFixed(1)}</div>
              <div class="stats-kpi-label">Velocity / wk</div>
            </div>
          </div>
          <div class="stats-kpi" data-tooltip="Average across ${completionTimes.length} completed tasks">
            <div class="stats-kpi-icon">\u23F1</div>
            <div class="stats-kpi-body">
              <div class="stats-kpi-value">${formatDuration(avgCompletionTime)}</div>
              <div class="stats-kpi-label">Avg Completion</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Overview Ring Cards -->
      <div class="stats-rings-row">
        <div class="stats-ring-card">
          <div class="stats-ring-visual stats-ring-sm">
            ${ring(completionRate, 72, 7, '#22C55E')}
            <div class="stats-ring-center">${completionRate}%</div>
          </div>
          <div class="stats-ring-info">
            <div class="stats-ring-title">Overall Completion</div>
            <div class="stats-ring-detail">${completed.length} of ${total} tasks</div>
          </div>
        </div>
        ${priorityStats.map(p => `
          <div class="stats-ring-card" data-tooltip="${p.completed} of ${p.total} ${p.label} priority tasks done">
            <div class="stats-ring-visual stats-ring-sm">
              ${ring(p.rate, 72, 7, p.color)}
              <div class="stats-ring-center">${p.rate}%</div>
            </div>
            <div class="stats-ring-info">
              <div class="stats-ring-title" style="color:${p.color}">${p.label}</div>
              <div class="stats-ring-detail">${p.completed}/${p.total} \u2022 avg ${p.count > 0 ? formatDuration(p.avgTime) : '\u2014'}</div>
            </div>
          </div>
        `).join('')}
        <div class="stats-ring-card">
          <div class="stats-ring-visual stats-ring-sm">
            ${ring(pct(staleTasks.length, incomplete.length || 1), 72, 7, '#F97316', 'rgba(249,115,22,0.1)')}
            <div class="stats-ring-center">${staleTasks.length}</div>
          </div>
          <div class="stats-ring-info">
            <div class="stats-ring-title" style="color:#F97316">Stale</div>
            <div class="stats-ring-detail">idle 7+ days</div>
          </div>
        </div>
      </div>

      <div class="stats-grid">

        <!-- Activity Trends (tabbed: Weekly / Daily / Monthly) -->
        <div class="stats-card stats-card-wide">
          <div class="stats-card-header">
            <h3 class="stats-card-title">Activity Trends</h3>
            <div class="stats-tabs" role="tablist">
              <button class="stats-tab active" data-stab="weekly">Weekly</button>
              <button class="stats-tab" data-stab="daily">Daily</button>
              <button class="stats-tab" data-stab="monthly">Monthly</button>
            </div>
          </div>

          <!-- Weekly throughput -->
          <div class="stats-tab-panel" data-spanel="weekly">
            <div class="stats-chart-legend" style="margin-bottom:8px">
              <span class="stats-legend-item"><span class="stats-legend-dot" style="background:#22C55E"></span>Completed</span>
              <span class="stats-legend-item"><span class="stats-legend-dot" style="background:#3B82F6"></span>Created</span>
            </div>
            <div class="stats-throughput-chart">
              ${weeklyData.map((w) => {
                const hDone = (w.done / maxWeekly) * 100;
                const hCreated = (w.created / maxWeekly) * 100;
                return `<div class="stats-tp-col" data-tooltip="${w.done} done, ${w.created} created">
                  <div class="stats-tp-bars">
                    <div class="stats-tp-bar stats-tp-done" style="height:${Math.max(hDone, 2)}%"></div>
                    <div class="stats-tp-bar stats-tp-created" style="height:${Math.max(hCreated, 2)}%"></div>
                  </div>
                  <div class="stats-tp-label">${w.label}</div>
                </div>`;
              }).join('')}
            </div>
          </div>

          <!-- Daily distribution -->
          <div class="stats-tab-panel hidden" data-spanel="daily">
            <div class="stats-day-chart">
              ${DAYS_LIST.map(d => {
                const t = dayDist[d].total, dn = dayDist[d].done;
                const h = (t / maxDay) * 100;
                return `<div class="stats-day-col" data-tooltip="${d}: ${t} tasks, ${dn} done">
                  <div class="stats-day-bars" style="height:${Math.max(h, 3)}%">
                    <div class="stats-day-done" style="height:${t > 0 ? (dn/t)*100 : 0}%"></div>
                  </div>
                  <div class="stats-day-label">${d.slice(0, 2)}</div>
                </div>`;
              }).join('')}
            </div>
          </div>

          <!-- Monthly trend -->
          <div class="stats-tab-panel hidden" data-spanel="monthly">
            <div class="stats-chart-legend" style="margin-bottom:8px">
              <span class="stats-legend-item"><span class="stats-legend-dot" style="background:#22C55E"></span>Done</span>
              <span class="stats-legend-item"><span class="stats-legend-dot" style="background:#3B82F6"></span>Created</span>
            </div>
            <div class="stats-monthly-chart">
              ${monthlyData.map(m => `
                <div class="stats-month-col" data-tooltip="${m.label}: ${m.done} done, ${m.created} created">
                  <div class="stats-tp-bars">
                    <div class="stats-tp-bar stats-tp-done" style="height:${Math.max((m.done / maxMonthly) * 100, 2)}%"></div>
                    <div class="stats-tp-bar stats-tp-created" style="height:${Math.max((m.created / maxMonthly) * 100, 2)}%"></div>
                  </div>
                  <div class="stats-tp-label">${m.label}</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- Category Breakdown -->
        <div class="stats-card">
          <h3 class="stats-card-title">By Category</h3>
          <div class="stats-breakdown">
            ${categoryStats.map(c => `
              <div class="stats-breakdown-row" data-tooltip="Avg: ${c.count > 0 ? formatDuration(c.avgTime) : '\u2014'} \u2022 Median: ${c.count > 0 ? formatDuration(c.medianTime) : '\u2014'}">
                <div class="stats-breakdown-label">
                  <span class="stats-breakdown-dot" style="background:${c.color}"></span>
                  <span>${escapeHtml(c.label)}</span>
                  <span class="stats-breakdown-count">${c.completed}/${c.total}</span>
                </div>
                <div class="stats-breakdown-bar-bg">
                  <div class="stats-breakdown-bar" style="width:${c.rate}%;background:${c.color}"></div>
                </div>
                <span class="stats-breakdown-pct">${c.rate}%</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Projects -->
        <div class="stats-card stats-card-wide">
          <h3 class="stats-card-title">Projects</h3>
          <div class="stats-project-grid">
            ${projectStats.map(p => `
              <div class="stats-project-card" data-tooltip="Avg time: ${p.total > 0 ? formatDuration(p.avgTime) : '\u2014'} \u2022 Oldest: ${p.oldestOpen > 0 ? formatDuration(p.oldestOpen) : '\u2014'}">
                <div class="stats-project-header">
                  <span class="stats-project-dot" style="background:${p.color}"></span>
                  <span class="stats-project-name">${escapeHtml(p.name)}</span>
                </div>
                <div class="stats-project-ring">
                  ${ring(p.rate, 52, 5, p.color)}
                  <div class="stats-project-ring-val">${p.rate}%</div>
                </div>
                <div class="stats-project-meta">
                  <span>${p.open} open</span>
                  <span>${p.completed} done</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Stale Tasks (collapsible) -->
        <div class="stats-card stats-card-wide">
          <div class="stats-card-header stats-card-toggle" data-target="stats-stale-body">
            <h3 class="stats-card-title">Stale Tasks <span class="stats-badge stats-badge-warn">${staleTasks.length}</span></h3>
            <span class="stats-toggle-icon">\u25BC</span>
          </div>
          <div id="stats-stale-body" class="stats-collapsible">
            ${staleTasks.length === 0 ? '<div class="stats-empty">No stale tasks \u2014 everything is fresh!</div>' : `
            <div class="stats-stale-list">
              ${staleTasks.slice(0, 25).map(t => {
                const modAge = now - new Date(t.modifiedAt || t.createdAt).getTime();
                const totalAge = now - new Date(t.createdAt).getTime();
                const proj = projects.find(p => p.id === t.projectId);
                const severity = modAge > 30 * ONE_DAY ? 'crit' : modAge > 14 * ONE_DAY ? 'warn' : 'mild';
                return `<div class="stats-stale-item stats-stale-${severity}">
                  <div class="stats-stale-indicator"></div>
                  <span class="stats-stale-title">${escapeHtml(t.title)}</span>
                  <span class="stats-stale-project" style="color:${proj?.color || '#64748B'}">${proj ? escapeHtml(proj.name) : ''}</span>
                  <span class="stats-stale-age">idle ${formatDuration(modAge)}</span>
                  <span class="stats-stale-age">age ${formatDuration(totalAge)}</span>
                </div>`;
              }).join('')}
              ${staleTasks.length > 25 ? `<div class="stats-empty">+ ${staleTasks.length - 25} more</div>` : ''}
            </div>`}
          </div>
        </div>

        <!-- Insights & Completion Speed (merged) -->
        <div class="stats-card stats-card-wide">
          <h3 class="stats-card-title">Insights</h3>
          <div class="stats-insights-combined">
            <div class="stats-insights-col">
              <div class="stats-insight">
                <div class="stats-insight-icon">\uD83D\uDCC5</div>
                <div class="stats-insight-body">
                  <div class="stats-insight-label">Busiest Day</div>
                  <div class="stats-insight-value">${DAYS_LIST.reduce((a, b) => dayDist[a].total >= dayDist[b].total ? a : b)}</div>
                </div>
              </div>
              <div class="stats-insight">
                <div class="stats-insight-icon">\u23F3</div>
                <div class="stats-insight-body">
                  <div class="stats-insight-label">Avg Task Age</div>
                  <div class="stats-insight-value">${formatDuration(avgAge)}</div>
                </div>
              </div>
              <div class="stats-insight">
                <div class="stats-insight-icon">\uD83D\uDCA4</div>
                <div class="stats-insight-body">
                  <div class="stats-insight-label">Oldest Open</div>
                  <div class="stats-insight-value">${oldestTask ? formatDuration(now - new Date(oldestTask.createdAt).getTime()) : '\u2014'}</div>
                </div>
              </div>
              <div class="stats-insight">
                <div class="stats-insight-icon">\u23F1</div>
                <div class="stats-insight-body">
                  <div class="stats-insight-label">Median Time</div>
                  <div class="stats-insight-value">${formatDuration(medianCompletionTime)}</div>
                </div>
              </div>
              <div class="stats-insight">
                <div class="stats-insight-icon">\uD83D\uDCE5</div>
                <div class="stats-insight-body">
                  <div class="stats-insight-label">Created This Week</div>
                  <div class="stats-insight-value">${createdLast7}</div>
                </div>
              </div>
              <div class="stats-insight">
                <div class="stats-insight-icon">\uD83C\uDFAF</div>
                <div class="stats-insight-body">
                  <div class="stats-insight-label">Net This Week</div>
                  <div class="stats-insight-value" style="color:${completedLast7 >= createdLast7 ? '#22C55E' : '#EF4444'}">${completedLast7 >= createdLast7 ? '+' : ''}${completedLast7 - createdLast7}</div>
                </div>
              </div>
            </div>
            <div class="stats-speed-col">
              <div class="stats-speed-heading">Completion Speed</div>
              <div class="stats-speed-list">
                ${categoryStats.filter(c => c.count > 0).map(c => `
                  <div class="stats-speed-row">
                    <span class="stats-speed-label">${escapeHtml(c.label)}</span>
                    <div class="stats-speed-bar-bg">
                      <div class="stats-speed-bar" style="width:${Math.min((c.avgTime / Math.max(...categoryStats.map(x => x.avgTime), 1)) * 100, 100)}%;background:${c.color}"></div>
                    </div>
                    <span class="stats-speed-val">${formatDuration(c.avgTime)}</span>
                  </div>
                `).join('') || '<div class="stats-empty">No completed tasks yet</div>'}
              </div>
            </div>
          </div>
        </div>

        <!-- Recently Completed -->
        <div class="stats-card">
          <h3 class="stats-card-title">Recently Completed</h3>
          ${recentlyCompleted.length === 0 ? '<div class="stats-empty">No completed tasks yet</div>' : `
          <div class="stats-recent-list">
            ${recentlyCompleted.map(t => {
              const proj = projects.find(p => p.id === t.projectId);
              const completedDate = new Date(t.completedAt);
              const daysAgo = Math.floor((now - completedDate.getTime()) / ONE_DAY);
              const timeLabel = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : daysAgo + 'd ago';
              const duration = t.createdAt && t.completedAt ? new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime() : 0;
              return `<div class="stats-recent-item">
                <div class="stats-recent-check">\u2713</div>
                <div class="stats-recent-info">
                  <div class="stats-recent-title">${escapeHtml(t.title)}</div>
                  <div class="stats-recent-meta">
                    ${proj ? `<span style="color:${proj.color}">${escapeHtml(proj.name)}</span> \u2022 ` : ''}${timeLabel}${duration > 0 ? ` \u2022 took ${formatDuration(duration)}` : ''}
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>`}
        </div>

        <!-- Productivity Score -->
        <div class="stats-card">
          <h3 class="stats-card-title">Productivity Score</h3>
          <div class="stats-score-container">
            <div class="stats-ring-visual stats-ring-lg">
              ${ring(productivityScore, 120, 10, productivityScore >= 70 ? '#22C55E' : productivityScore >= 40 ? '#F59E0B' : '#EF4444')}
              <div class="stats-ring-center stats-score-number">${productivityScore}</div>
            </div>
            <div class="stats-score-breakdown">
              <div class="stats-score-factor">
                <span>Velocity (${completedLast7}/wk)</span>
                <div class="stats-mini-bar"><div style="width:${(velocityScore/30)*100}%;background:#3B82F6"></div></div>
                <span class="stats-score-pts">${Math.round(velocityScore)}/30</span>
              </div>
              <div class="stats-score-factor">
                <span>Completion Rate</span>
                <div class="stats-mini-bar"><div style="width:${(completionScore/25)*100}%;background:#22C55E"></div></div>
                <span class="stats-score-pts">${Math.round(completionScore)}/25</span>
              </div>
              <div class="stats-score-factor">
                <span>Streak (${currentStreak}d)</span>
                <div class="stats-mini-bar"><div style="width:${(streakScore/20)*100}%;background:#A855F7"></div></div>
                <span class="stats-score-pts">${Math.round(streakScore)}/20</span>
              </div>
              <div class="stats-score-factor">
                <span>Freshness</span>
                <div class="stats-mini-bar"><div style="width:${(freshScore/15)*100}%;background:#F59E0B"></div></div>
                <span class="stats-score-pts">${Math.round(freshScore)}/15</span>
              </div>
              <div class="stats-score-factor">
                <span>Net Flow</span>
                <div class="stats-mini-bar"><div style="width:${(netScore/10)*100}%;background:#06B6D4"></div></div>
                <span class="stats-score-pts">${Math.round(netScore)}/10</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Activity Heatmap -->
        <div class="stats-card stats-card-wide">
          <div class="stats-card-header">
            <h3 class="stats-card-title">Activity Heatmap</h3>
            <div class="stats-streak-badges">
              <span class="stats-streak-badge" title="Current streak">\uD83D\uDD25 ${currentStreak}d streak</span>
              <span class="stats-streak-badge" title="Best streak">\uD83C\uDFC6 ${bestStreak}d best</span>
            </div>
          </div>
          <div class="stats-heatmap">
            ${(() => {
              // Group by week columns
              const weeks = [];
              let week = [];
              heatmapData.forEach((d, i) => {
                week.push(d);
                if (d.dow === 6 || i === heatmapData.length - 1) {
                  weeks.push(week);
                  week = [];
                }
              });
              return weeks.map(w =>
                `<div class="stats-heatmap-col">${w.map(d => {
                  const intensity = d.count === 0 ? 0 : Math.min(Math.ceil((d.count / heatMax) * 4), 4);
                  return `<div class="stats-heatmap-cell stats-heat-${intensity}" data-tooltip="${d.date}: ${d.count} completed" title="${d.date}: ${d.count}"></div>`;
                }).join('')}</div>`
              ).join('');
            })()}
          </div>
          <div class="stats-heatmap-legend">
            <span>Less</span>
            <div class="stats-heatmap-cell stats-heat-0"></div>
            <div class="stats-heatmap-cell stats-heat-1"></div>
            <div class="stats-heatmap-cell stats-heat-2"></div>
            <div class="stats-heatmap-cell stats-heat-3"></div>
            <div class="stats-heatmap-cell stats-heat-4"></div>
            <span>More</span>
          </div>
        </div>

        <!-- Time to Complete Distribution -->
        <div class="stats-card">
          <h3 class="stats-card-title">Time to Complete</h3>
          <div class="stats-histogram">
            ${timeDistribution.map(b => `
              <div class="stats-hist-col" data-tooltip="${b.count} tasks took ${b.label}">
                <div class="stats-hist-bar" style="height:${(b.count / maxTimeBucket) * 100}%"></div>
                <div class="stats-hist-label">${b.label}</div>
                <div class="stats-hist-count">${b.count}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Focus This Week -->
        ${focusThisWeek.length > 0 ? `
        <div class="stats-card">
          <h3 class="stats-card-title">Focus This Week</h3>
          <div class="stats-focus-list">
            ${focusThisWeek.map(f => `
              <div class="stats-focus-item">
                <span class="stats-breakdown-dot" style="background:${f.color}"></span>
                <span class="stats-focus-label">${escapeHtml(f.label)}</span>
                <span class="stats-focus-count">${f.count} done</span>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        <!-- Overdue / At Risk -->
        <div class="stats-card stats-card-wide">
          <div class="stats-card-header stats-card-toggle" data-target="stats-overdue-body">
            <h3 class="stats-card-title">At Risk <span class="stats-badge stats-badge-danger">${overdueTasks.length}</span></h3>
            <span class="stats-toggle-icon">\u25BC</span>
          </div>
          <div id="stats-overdue-body" class="stats-collapsible${overdueTasks.length === 0 ? ' collapsed' : ''}">
            ${overdueTasks.length === 0 ? '<div class="stats-empty">No overdue tasks!</div>' : `
            <div class="stats-stale-list">
              ${overdueTasks.slice(0, 30).map(t => {
                const age = now - new Date(t.createdAt).getTime();
                const proj = projects.find(p => p.id === t.projectId);
                const pri = t.priority || 'Medium';
                return `<div class="stats-stale-item stats-stale-${pri === 'High' ? 'crit' : 'warn'}">
                  <div class="stats-stale-indicator"></div>
                  <span class="stats-stale-title">${escapeHtml(t.title)}</span>
                  <span class="stats-stale-project" style="color:${proj?.color || '#64748B'}">${proj ? escapeHtml(proj.name) : ''}</span>
                  <span class="stats-stale-age" style="color:${PRIORITY_COLORS[pri] || '#F97316'}">${pri}</span>
                  <span class="stats-stale-age">age ${formatDuration(age)}</span>
                </div>`;
              }).join('')}
              ${overdueTasks.length > 30 ? `<div class="stats-empty">+ ${overdueTasks.length - 30} more</div>` : ''}
            </div>`}
          </div>
        </div>

      </div>
    </div>
  `;

  // === Interactive behaviors ===

  // Tooltips
  container.querySelectorAll('[data-tooltip]').forEach(el => {
    el.addEventListener('mouseenter', (e) => {
      let tip = document.getElementById('stats-tooltip');
      if (!tip) {
        tip = document.createElement('div');
        tip.id = 'stats-tooltip';
        tip.className = 'stats-tooltip';
        document.body.appendChild(tip);
      }
      tip.textContent = el.dataset.tooltip;
      tip.classList.add('visible');
      const rect = el.getBoundingClientRect();
      tip.style.left = rect.left + rect.width / 2 + 'px';
      tip.style.top = rect.top - 8 + 'px';
    });
    el.addEventListener('mouseleave', () => {
      const tip = document.getElementById('stats-tooltip');
      if (tip) tip.classList.remove('visible');
    });
  });

  // Chart tabs (Activity Trends: Weekly / Daily / Monthly)
  container.querySelectorAll('.stats-tabs').forEach(tabs => {
    const card = tabs.closest('.stats-card');
    tabs.querySelectorAll('.stats-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const key = tab.dataset.stab;
        tabs.querySelectorAll('.stats-tab').forEach(t => t.classList.toggle('active', t === tab));
        card.querySelectorAll('.stats-tab-panel').forEach(panel => {
          panel.classList.toggle('hidden', panel.dataset.spanel !== key);
        });
      });
    });
  });

  // Collapsible sections
  container.querySelectorAll('.stats-card-toggle').forEach(header => {
    header.addEventListener('click', () => {
      const target = document.getElementById(header.dataset.target);
      if (!target) return;
      const icon = header.querySelector('.stats-toggle-icon');
      target.classList.toggle('collapsed');
      if (icon) icon.textContent = target.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
    });
  });

  // Animate ring fills on scroll into view
  const rings = container.querySelectorAll('.stats-ring-fill');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('stats-ring-animate');
      }
    });
  }, { threshold: 0.3 });
  rings.forEach(r => observer.observe(r));
}
