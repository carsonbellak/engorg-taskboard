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
    '1.5.5': {
      title: "What's new",
      intro: 'EngInk on the tablet can now draw 3D solids.',
      slides: [
        { emoji: '🧊', title: '3D solids', body: 'The shapes menu in EngInk has a new 3D solids row: box, cylinder, cone, sphere and pyramid. Pick one and draw roughly where it should go. Edges you couldn’t see on a real solid are drawn dashed. On a box, drag the handle at its back corner to change its depth and angle.' },
      ],
    },
    '1.5.1': {
      title: "What's new",
      intro: 'Post notes straight from your iPhone home screen.',
      slides: [
        { emoji: '🗒️', title: 'Quick Note widget', body: 'A sticky-note widget for your iPhone, built with the free Scriptable app. Tap it, fill in the title, project, priority and due date, then hit Post and the note lands on your board. To set it up, open the web app on your phone, go to Settings → Scriptable, tap the code box to copy the script, then tap Copy widget token.' },
      ],
    },
    '1.5.0': {
      title: "What's new",
      intro: 'EngInk on the tablet gets tables, better selection editing and more axes.',
      slides: [
        { emoji: '🔄', title: 'Edit what you select', body: 'Lasso some ink in EngInk, then tap Color to recolor it, drag the round knob under the box to rotate it, or drag it past the top or bottom edge to carry it to another page. To get Cut, Copy and Paste anywhere, hold the select tool still for a second.' },
        { emoji: '📏', title: 'Hold for a straight line', body: 'Finish a stroke and keep the pen still for a moment. It snaps into a straight line, and it levels out when you’re close to horizontal or vertical.' },
        { emoji: '▦', title: 'Tables', body: 'The new table tool draws a grid with or without an outer border. Select a table to add or remove rows and columns, or to turn its border on or off.' },
        { emoji: '📈', title: 'More axes', body: 'The shapes menu now has 1- and 2-quadrant 2D axes and an 8-octant 3D axis, plus a Hashed axes checkbox for tick marks. Tick marks are smaller and thinner, and the 3D axes have them too.' },
      ],
    },
    '1.4.1': {
      title: "What's new",
      intro: 'Your phone now hears about things even when the web app is closed.',
      slides: [
        { emoji: '🔔', title: 'Alerts with the app closed', body: 'Alarms, assignment due-soon reminders and repeating timers are now sent from the cloud, so they reach your iPhone while the home-screen web app is closed. Before, they only appeared when you opened it. Tap “Enable” on the web app’s alerts banner once to turn them on.' },
        { emoji: '☀️', title: 'UV on your lock screen', body: 'The lock-screen schedule wallpaper now shows the day’s max UV index under sunrise and sunset, colored from green to purple by how strong it is.' },
      ],
    },
    '1.4.0': {
      title: "What's new",
      intro: 'EngOrg 1.4 can hand its background work to a Raspberry Pi.',
      slides: [
        { emoji: '🍓', title: 'Raspberry Pi companion', body: 'Install EngOrg Pi on a Raspberry Pi 3 or newer (download EngOrg-Pi.tar.gz from the release and run pi/install.sh), then pair it in Settings → Integrations → Raspberry Pi using the 6-digit code it shows.' },
        { emoji: '🖨️', title: 'Printer, always watched', body: 'The Pi keeps your 3D printer found even when its IP changes, so this PC never has to scan the network. It also logs every print around the clock, so you’re asked how a print went even if it finished while your PC was off.' },
        { emoji: '⚡', title: 'Instant calendar syncs', body: 'The Pi keeps your calendar feeds pre-fetched, so syncs no longer wait on slow servers. It updates itself to match this app. If it’s ever offline, this PC just does the work itself.' },
        { emoji: '🎨', title: 'Signature Mixes', body: 'Eighteen original themes in Settings → Appearance → Signature Mixes: Blueprint, Copper Patina, Aurora, Vaporwave, Plum & Gold, Risograph, Sakura & Indigo, Terracotta and more. Each pairs colors you wouldn’t expect. They’re in the web app too.' },
      ],
    },
    '1.3.56': {
      title: "What's new",
      intro: 'Nineteen new themes, and Windows now keeps up with them.',
      slides: [
        { emoji: '🎨', title: 'Editor & browser themes', body: 'Settings → Appearance has a new “Editor & Browser Themes” section: Dracula, One Dark Pro, Monokai Pro, Tokyo Night, Catppuccin, GitHub, Night Owl, Rosé Pine, Gruvbox, Solarized, Chrome’s Material palettes and more. They’re in the web app too.' },
        { emoji: '🪟', title: 'Windows follows your theme', body: 'Settings → Appearance → Windows Theme now updates Windows every time you change the app theme, with a small progress bar while it works. The new Tinted option also colors Start, the taskbar and title bars with deep shades of your theme.' },
      ],
    },
    '1.3.48': {
      title: "What's new",
      intro: 'Your schedule on your iPhone lock screen — plus class rooms and a smoother mobile app.',
      slides: [
        { emoji: '📱', title: 'Lock screen schedule', body: 'Put a daily-updating picture of your schedule on your iPhone lock screen. On the phone, open the web app → ⚙️ → Wallpaper, generate your link, and follow the one-time Shortcut steps — it repaints every morning.' },
        { emoji: '📅', title: 'Apple Calendar sync', body: 'Subscribe your iPhone calendar to your board — events, assignment due dates and work blocks — from Settings → Calendar → Generate QR Code, then scan it with your camera.' },
        { emoji: '📍', title: 'Class rooms', body: 'Give a project a Location (like a class room) in its editor, and that room now shows next to the class on your lock-screen schedule.' },
      ],
    },
    '1.3.30': {
      title: "What's new",
      intro: 'Handwriting leveled up — split notebooks, and a live desktop mirror.',
      slides: [
        { emoji: '🖋️', title: 'EngInk', body: 'The handwriting app is now “EngInk” — same fast, low-latency ink, with a cleaner tab and icon.' },
        { emoji: '📚', title: 'Split notebooks', body: 'Open up to four notebooks side by side on the tablet. In your library, tap a notebook’s ⋮ menu → “Open in split,” pick which ones, and drag the dividers to re-balance.' },
        { emoji: '🖥️', title: 'Mirror to your PC', body: 'Watch your tablet’s EngInk notebook live on the desktop over Wi‑Fi. Open Engineering → EngInk on the PC, then on the tablet tap the cast icon and choose it. Read-only — great on a big screen, and you can export the mirrored notebook to PDF.' },
      ],
    },
    '1.2.0': {
      title: "What's new",
      intro: 'A pass over the themes — cleaner looks and a new way to tune the glass.',
      slides: [
        { emoji: '🫧', title: 'Liquid Glass slider', body: 'Settings → Appearance → Liquid Glass lets you dial how see-through the panels are — from frosted all the way to fully translucent, leaving just text and borders.' },
        { emoji: '🌙', title: 'Liquid Glass Dark, fixed', body: 'Dark glass no longer washes out to light-gray panels — surfaces now stay properly dark and frosted with a cleaner cool glow.' },
        { emoji: '🎨', title: 'Calmer themes', body: 'Brutalist is toned down for HDR/OLED, Neon lost its floating orbs, Nord lost the snow (and its notes now match the palette), and Forest is a calmer sage/pine with no more falling leaves.' },
      ],
    },
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
