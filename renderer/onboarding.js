// Onboarding & What's-New orchestration.
//
// Two surfaces, both driven by the shared appTour engine (tour.js):
//   • First-run tour  — a spotlight walkthrough of the main UI, shown once per
//     device (gated by localStorage 'engorg_onboarded').
//   • What's New       — a slideshow of curated highlights for a version, shown
//     automatically after the app updates to a version with notes
//     (localStorage 'engorg_whatsnew_seen'), and on demand from the updater's
//     "View changes" button or Settings → About.
//
// Curated notes live in WHATS_NEW keyed by version. When the updater offers a
// version with no curated entry, showChanges() falls back to the commit list.

const onboarding = (() => {
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const SEEN_KEY = 'engorg_whatsnew_seen';
  const DONE_KEY = 'engorg_onboarded';

  // ---- Curated release highlights (newest entries win in replay) -------------
  const WHATS_NEW = {
    '1.1.5': {
      title: "What's new",
      intro: 'A friendlier first run and a clearer way to keep up with updates.',
      slides: [
        { emoji: '🧭', title: 'Guided tour', body: 'New here? A quick walkthrough now points out the main parts of the app on first launch — replay it anytime from Settings → About.' },
        { emoji: '🆕', title: 'See what changed', body: 'When an update is available, hit "View changes" to step through the highlights before you install.' },
      ],
    },
    '1.1.4': {
      title: "What's new",
      intro: 'The Timers tab grew up into a full clock utility.',
      slides: [
        { emoji: '⏰', title: 'Scheduled alarms', body: 'Set alarms for a time of day — one-shot or repeating on the weekdays you pick. They ring with a notification even when the tab is closed.' },
        { emoji: '🔁', title: 'Repeating timers', body: 'Flip on Repeat and a countdown restarts itself the moment it finishes — perfect for intervals and pomodoro.' },
        { emoji: '⏲', title: 'Stopwatch', body: 'A proper stopwatch with lap splits lives under the new Timers / Alarms / Stopwatch switcher.' },
      ],
    },
  };

  function latestNotesVersion() {
    const keys = Object.keys(WHATS_NEW);
    if (!keys.length) return null;
    return keys.sort(cmpSemver).pop();
  }
  function cmpSemver(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
    return 0;
  }

  async function currentVersion() {
    try { const r = await window.api.updates.version(); return r && r.version; } catch { return null; }
  }

  // ---- First-run tour --------------------------------------------------------
  function firstRunSteps() {
    return [
      { emoji: '⚙️', title: 'Welcome to EngOrg', body: "Your engineering command center — tasks, projects, calendar, 3D printing, CAD, files and more in one place. Here's a 30-second tour." },
      { target: '.header-tabs', placement: 'bottom', title: 'Your views', body: 'Switch between Notes, Projects, Calendar, Timers, Files, Engineering Utilities and more. You can reorder or hide these in Settings → Hotbar.' },
      { target: '#sidebar-active-section', placement: 'right', title: 'Projects & filters', body: 'Filter the current view by project, organize projects into groups, and drag to reorder. "All Projects" shows everything.' },
      { target: '#btn-add-main', placement: 'bottom', title: 'Capture work fast', body: 'Add a note or task to the selected day and project. Notes carry priority, due dates, checklists and categories.' },
      { target: '#btn-add-project-header', placement: 'bottom', title: 'Start a project', body: 'Spin up a new project anytime — each gets its own color and shows up across every view.' },
      { target: '#btn-cloud-sync', placement: 'bottom', title: 'Sync everywhere', body: 'Sign in to sync your data across devices and the companion web app — your board travels with you.' },
      { target: '#btn-settings-header', placement: 'left', title: 'Make it yours', body: 'Themes, the hotbar, linked accounts and integrations all live in Settings. You can replay this tour from About.' },
      { emoji: '🚀', title: "You're all set", body: 'That\'s the lay of the land. Dive in — and check the Engineering Utilities tab for the printer, slicer and Git tools when you need them.' },
    ];
  }

  // Run the first-run tour once per device. Returns true if it ran.
  async function maybeRunFirstRun() {
    if (localStorage.getItem(DONE_KEY)) return false;
    if (typeof appTour === 'undefined') return false;
    // Treat the current version as already-seen so What's New doesn't also pop on
    // the very first launch.
    const v = await currentVersion();
    if (v) localStorage.setItem(SEEN_KEY, v);
    localStorage.setItem(DONE_KEY, '1');
    await appTour.run(firstRunSteps(), { finishLabel: 'Get started' });
    return true;
  }

  function slidesFor(entry, version) {
    const intro = { emoji: '🎉', title: entry.title || "What's new", body: entry.intro || `You've updated to v${version}. Here's what changed.` };
    return [intro, ...(entry.slides || [])];
  }

  // After an update bumps the version, show curated highlights once.
  async function maybeShowWhatsNew() {
    if (typeof appTour === 'undefined') return false;
    const v = await currentVersion();
    if (!v) return false;
    const seen = localStorage.getItem(SEEN_KEY);
    if (seen === v) return false;
    localStorage.setItem(SEEN_KEY, v);
    if (!seen) return false;            // fresh install (no prior baseline) → skip
    const entry = WHATS_NEW[v];
    if (!entry) return false;           // no curated notes for this version
    await appTour.run(slidesFor(entry, v), { finishLabel: 'Got it' });
    return true;
  }

  // ---- Updater "View changes" walkthrough -----------------------------------
  function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

  // Build a walkthrough for an *available* update (called from updates.js). Uses
  // curated notes for the target version when present, else the commit list.
  function showChanges(res) {
    if (typeof appTour === 'undefined') return;
    res = res || {};
    const ver = res.latestVersion;
    const intro = {
      emoji: '🚀',
      title: ver ? `Version ${ver} is available` : 'Update available',
      body: `Here's what's changed${res.currentVersion ? ` since your v${res.currentVersion}` : ''}.`,
    };

    let slides;
    const curated = ver && WHATS_NEW[ver];
    if (curated) {
      slides = [intro, ...(curated.slides || [])];
    } else {
      const commits = (res.commits || []).filter(c => c && c.message && !/^Merge /.test(c.message));
      if (!commits.length) {
        slides = [intro, { emoji: '✨', title: 'Improvements & fixes', body: 'This update bundles general improvements and bug fixes.' }];
      } else {
        const pages = chunk(commits, 5).slice(0, 5);
        slides = [intro, ...pages.map((pg, i) => ({
          emoji: '📝',
          title: pages.length > 1 ? `Changes (${i + 1}/${pages.length})` : 'Changes in this update',
          bodyHtml: `<ul class="tour-changes">${pg.map(c => `<li><code>${esc(c.shortSha || '')}</code> ${esc(c.message)}</li>`).join('')}</ul>`,
        }))];
      }
    }
    appTour.run(slides, { finishLabel: 'Close' });
  }

  // ---- Replay entry points (Settings → About) -------------------------------
  function replayFirstRun() {
    if (typeof window.closeSettings === 'function') window.closeSettings();
    setTimeout(() => appTour.run(firstRunSteps(), { finishLabel: 'Done' }), 220);
  }
  async function replayWhatsNew() {
    const v = (await currentVersion()) || latestNotesVersion();
    const ver = WHATS_NEW[v] ? v : latestNotesVersion();
    if (!ver || !WHATS_NEW[ver]) return;
    if (typeof window.closeSettings === 'function') window.closeSettings();
    setTimeout(() => appTour.run(slidesFor(WHATS_NEW[ver], ver), { finishLabel: 'Got it' }), 220);
  }

  return { maybeRunFirstRun, maybeShowWhatsNew, showChanges, replayFirstRun, replayWhatsNew };
})();

window.onboarding = onboarding;
