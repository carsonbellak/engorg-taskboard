# renderer/ — module notes

Everything here is a **global** loaded by `<script>` tags in `index.html` (order matters, no imports/modules). Shared globals: `dataManager`, `viewRenderer`, `modalManager`, `firebaseSync`, `engineeringUtilities`; helpers `escapeHtml`, `assignRainbowColors`, `resolveAutoColor`, `formatDateShort`, `isOverdue`, `getStickyColors`; constants `DAYS`, `PRIORITY_COLORS`, `CATEGORY_LABELS`, `PROJECT_CATEGORY_COLORS`, `APP_CATEGORIES`/`DEFAULT_CATEGORIES`.

**Parity:** a user-facing change here must land equivalently in `pwa/app.js` / `pwa/styles.css` (see root CLAUDE.md; class translations in `.claude/parity-map.json`). Desktop-only modules are marked below.

Linked-account sync loops (`syncGradescope`, `syncVariate`, `syncCalendars`/`syncBrightspaceNotes`, `syncGitHub`) live in `app.js`; their full behavior is documented in `ipc/CLAUDE.md` § Integrations.

---

## Views & Navigation (`app.js`)

- **Interface mode** (`window.applyUiMode`, `settings.uiMode` `'tabbed'`|`'organic'`, Settings → General → Interface): `body.organic-mode` hides `.header-tabs`/`#btn-tab-lock` and the Ecosystem tree *is* the app (create data by right-clicking a branch; the gear stays to switch back).
- **Header tabs** (`.header-tab[data-view=…]`) map to `#view-<name>`: `notes`, `projects`, `ecosystem`, `calendar`, `email`, `timeline`, `timers`, `board`, `purchasing`, `stats`, `files`, `engineering`. `viewRenderer.currentView` tracks the active one; `renderCurrentView()` dispatches. Tabs are hide-/reorderable (`hiddenTabs`/`tabOrder`/`hotbarUtilities`; `MAIN_TABS` in `settings.js`).
- **Sidebar = project filter.** `viewRenderer.selectedProject` is `'all'`, a project id, or `'all-archived'`. "All Projects" is a pure filter — it does **not** switch views. `viewRenderer.selectedDay` still exists (default day for new notes + progress bar) though the sidebar day picker is gone.
- **Projects tab** — `ViewRenderer.renderProjectSlates()` renders one slate per project into `#view-projects`, sectioned by `projectGroups` then "Ungrouped"; "+ Group" toolbar button; ••• per group (Edit/Archive/Delete). Clicking a slate drills into that project's Notes. "All Archived" reuses this tab (archived-group sections offer **Unarchive group**).
- **Project groups in the sidebar:** `#btn-add-group`, collapsible `.sidebar-group` headers, ••• menus via `#modal-group`. Assign by **drag** (group header/body/ungrouped zone) or project ••• **Move to**. After any sidebar drag, `commitSidebarOrder()` rebuilds `dataManager.projects` order + each `groupId` from the DOM.
- **Group actions are centralized** in `app.js` (`editGroupFlow / archiveGroupFlow / deleteGroupFlow / unarchiveGroupFlow`) driven by `window` CustomEvents (`add-group`, `edit-group`, `archive-group`, `delete-group`, `unarchive-group`) — sidebar and Projects page share that path. Group CRUD lives in `data.js` (`addProjectGroup / updateProjectGroup / deleteProjectGroup / setProjectGroup / getProjectGroups / getActiveProjectGroups / archiveProjectGroup / unarchiveProjectGroup`; `getActiveProjectGroups()` = `!archived`).
- **PWA mirror of groups:** `<optgroup>`s in the PWA's project `<select>` (`projectOptionGroups()` in `pwa/app.js`). The PWA has no projects-overview view.

---

## Modules

| File | Notes |
|------|-------|
| `app.js` | Root — initializes modules, tab switching, sidebar/groups, sync loops (startup + every 30 min). Bails early when `windowSplit.isShell()`. |
| `data.js` | `DataManager` — wraps `window.api.loadData/saveData`, in-memory cache, all CRUD + Firebase upload. |
| `firebase-sync.js` / `firebase-config.js` | Firestore real-time sync + offline persistence (selective settings download — see root CLAUDE.md) / credentials. |
| `taskboard.js` | `ViewRenderer` — day-of-week board, project slates, calendar, timeline (`renderTimeline()`; GitHub commits render as `git-commit` items only in "All Projects"). Note cards: description shows one truncated line (full on hover); **attachments** render one preview at a time with the chip row as selector (chip → switch preview; preview → open file). |
| `components/add-note-modal.js` | **`ModalManager` owns ALL modals** (note, schedule event, project, category) despite the filename. Project modal's work schedule: summary + "Set weekly schedule…" → `#modal-schedule-picker`, a drag-to-paint 24h grid of 15-min slots collapsed back to `{day,start,end}` blocks on Done. |
| `components/sticky-note.js` | Note card rendering + `sourceLogoSvg` (Gradescope/Variate/Brightspace brand logos, shared by note cards and every calendar surface; mirrored in `pwa/app.js`). |
| `components/project-manager.js` | Empty stub — project CRUD is in `ModalManager`. |
| `components/tracking-utils.js` | Shared tracking helpers (carrier detection). |
| `settings.js` | Popup modal (`#settings-modal`; gear → `window.openSettings()` renders into `#view-settings`; Esc/backdrop/× closes). Tabbed: `.settings-nav` rail + `.settings-tab-panel` (Appearance / General / Linked Accounts / Calendar / Integrations / Hotbar / Mobile / Data / About; active tab in `_settingsTab`). **Hotbar tab** (`bindHotbarEditor`): drag-reorder list writing `hiddenTabs`/`hotbarUtilities`/`tabOrder`, Lock (`tabsLocked`), Reset; calls `window.applyHotbar()` live. **About:** version, Build Installer, Request a Feature, Submit Changes, Tour & Tips. **Integrations → Raspberry Pi** (`refreshPiLink`/`renderPiPairing`, desktop-only): find/pair with code, status grid, auto-update toggle, Update now, Unpair. **Linked Accounts hub** (`refreshLinkedAccounts`): cards for Cloud Sync, GitHub, Gradescope, Variate, Claude, Email. Registry (`settings.linkedAccounts`) syncs; secrets don't, so cards can show "Reconnect on this device". `initTheme()` honors `windowSplit.startupThemeOverride()`. |
| `ecosystem.js` | **Ecosystem tab** — radial workspace tree, see below. |
| `timers.js` | 3-mode clock (`_timerTab`): **Timers** (countdown, 🔁 Repeat auto-restarts), **Alarms** (HH:MM, one-shot or weekdays; desktop Notification + beeps), **Stopwatch**. A 1 s `_globalTimerWatch` runs app-wide (expiry, repeat rollover, `_checkAlarms`) even with the tab closed. Alarms: `settings.alarms` (synced) via `dataManager.getAlarms/addAlarm/updateAlarm/deleteAlarm`. Countdowns: Firestore `timers` collection (needs cloud sign-in). |
| `noteboard.js` | Sticky notes board. |
| `purchasing.js` | Purchase tracking. |
| `stats.js` | Stats/analytics tab. |
| `briefings.js` | Once-a-day popup (localStorage flag per `YYYY-MM-DD`) rendered through `appTour` — greeting, day-load summary, stats. |
| `syllabus-import.js` | Syllabus Importer (first Claude-agent feature): pick PDF/image/text → `ipc/claude.js` → `{ course, events }` → editable preview → `dataManager.importExternalEvents`. |
| `tour.js` | `window.appTour` — coachmark/slideshow engine. `appTour.run(steps, opts)` → Promise; spotlight steps `{ target, title, body\|bodyHtml, placement, view? }` or centered slides (no `target`). `appTour.isActive()` lets the updater defer. **Mirrored verbatim** in `pwa/tour.js`. |
| `onboarding.js` | `window.onboarding` over `appTour`: `maybeRunFirstRun()` (once per device, localStorage `engorg_onboarded`), `maybeShowWhatsNew()` (once per version, `engorg_whatsnew_seen`), `showChanges(res)` (updater's View changes), `replayFirstRun()`/`replayWhatsNew()`. **Curated notes: `WHATS_NEW` map keyed by version — add an entry when shipping a notable feature.** |
| `updates.js` | Update checker UI — "Update available" prompt with View changes; shows `currentVersion` vs `latestVersion`/`versionBehind`. The repo's `package.json` `version` is the single source of truth (bumped by `release.js`). |
| `spellcheck.js` | `Spellcheck.attach(textarea)` — red wavy underlines via a mirrored backdrop behind a transparent textarea + hover suggestion popup. Attached to `#note-text`/`#note-description`. Chromium's checker is disabled. |
| `theme-fx.js` | Theme/visual-style engine for the `body.style-*` themes in `styles.css`. User's display is HDR OLED — avoid pure-black/max-contrast + busy particle effects. |
| `titlebar.js` | Frameless titlebar + visible File/Edit/View/Window menu (native menu hidden). Items: `action` (→ `api.menu.action`), `onClick`, `submenu` (flyout). A top-level entry with `onClick` and no `items` is a direct button (e.g. 🌐 Web App). View → Split Window / Set Theme submenus come from `window.windowSplit`. Toggles `body.desktop-mode-active` on `desktop:changed`. |
| `window-split.js` | **Desktop-only.** Loaded *before* app.js. Splits the window into a gap-less grid of `index.html?embedded=1` iframes — layouts `2v/2h/3v/3h/4q/4v/4h` (v = columns), `single` restores. Layout + per-pane themes in **localStorage** (`splitLayout`), never synced. As the shell it hides its own titlebar and shows `#split-winctrls` (min/max/close + drag strip); app.js bails so no data/Firebase loads behind the panes. Embedded panes suppress background services. Layout changes from a pane post `split-setlayout` to the shell; View → Set Theme: top window → `localStorage.localTheme`, pane → `postMessage` `split-theme`. |
| `email.js` | **Desktop-only.** Email hub — 3-pane (accounts/folders, list, sandboxed reading iframe), compose/reply/forward, account setup. |
| `file-viewer.js` | **Desktop-only.** File browser — tree, text/binary viewer, batch rename, content search, git badges/branch/commit panel, right-click git menu (Stage/Unstage, View Diff, Discard, Open in Git Manager → `gitManager.openRepo`). Reads `window.api.git.status` (cached `gitStatus`/`gitFileMap`). Uses broken `prompt()`. |
| `print-tracker.js` | **Desktop-only** (`window.printTracker`, `window.openPrintHistory`). Records each print: archives STL+gcode+settings, asks which project, polls Moonraker `print_stats`, then asks success/fail + reason. With a linked Raspberry Pi it first checks the Pi's 24/7 job log (`api.pi.printerJobs`), so prints that ended while the PC was off still get prompted. Charts failures; rolls successes into **best profiles** per material+layer height. `print_history.json` is device-local (local paths) — not synced. |

### Engineering utilities (all desktop-only)

`engineering.js` hosts them under one tab: sub-nav, built-in `BUILTIN` registry, `installedUtilities` (settings.json), and the **Utility Store** (remote utilities run in a sandboxed iframe). New one → `/new-utility`.

| File | Notes |
|------|-------|
| `printer.js` | Moonraker status, WebRTC camera, print controls. |
| `slicer.js` | Model select, profile picker, slice & send. **Upload & Print** calls `printTracker.onPrintStarted(...)`; 🖨️ History opens the print log. |
| `cad-viewer.js` | Three.js STL/OBJ/GLTF viewer; KiCad SVG/GLB via kicad-cli. `window.CadViewer` is also used by Ecosystem. |
| `kicad-importer.js` | ZIP picker, options, progress/log, part-selection + missing-STEP modals. |
| `git-manager.js` | GitHub-Desktop-style client: repo/branch dropdowns, Fetch/Pull/Push/Sync, staging, commit (+amend), History + diff with right-click commit menu (checkout/branch/tag/cherry-pick/revert/reset/copy SHA), conflict banner (ours/theirs/edit/continue/abort), stash/tag/remote dialogs, 5-min auto-fetch, Upload/Download folder, raw git terminal. Settings: `gitRepos`, `gitLastRepo`, `gitAutoFetch`. |
| `uart-bridge.js` | Serial/UART bridge + visual program editor (FTDI bit-bang via `ipc/ftdi.js`; programs via `ipc/uart-programs.js`). |
| `wifi-checker.js` | Wi-Fi/network diagnostics (backed by `ipc/wifi-checker.js`). Uses broken `prompt()`. |
| `engink-mirror.js` | `enginkMirror` — view-only LAN reflection of the tablet's EngInk notebook (no cloud). Pairing panel (IP:port + 6-digit code), canvas reproducing native `FinishedStrokesView` (816×1056 pages, GRID/RULED/DOTS/PLAIN, highlighter alpha, Catmull-Rom), page-follow, pan/zoom, Export PDF (print-to-PDF). |
| `file-merger.js` | Combines PDFs + images into one PDF in user order (drag/▲▼). Assembly runs **here** with the bundled `PDFLib` (`lib/pdf-lib.min.js`) because it needs a `<canvas>`: PDFs via `copyPages`; JPG/PNG embedded directly, webp/gif/bmp normalized to PNG via canvas. Layout: Fit to image / Letter / A4. Bytes from `files:readBinary`; saved via `fileMerger.save`. |

---

## Ecosystem (`ecosystem.js`) — the "branched view"

- **Tree is structure only:** workspace → projects → categories/deliverable buckets → hand-attached species. **Bulk data is NOT branches** — tasks/events/purchases/todos are `items` on their bucket node (count badge) shown in a hover list widget (`openListPopup`, `.eco-list` inside `.eco-root`; clicking a task fires `edit-note`).
- **Hand-attached species are nodes:** folders, files, CAD models (live Three.js slide-in via `window.CadViewer`), links, notes, sub-branches, live utility instances (`window.openEngineeringUtility`).
- **Progressive disclosure:** default shows only projects (`isOpen()` — only `root` open); deeper opens when pinned or on the cursor's focus path. Big fans cluster into **"+N more"** nodes (`CAP`).
- **Cursor-steered nav** (`steerTick`, rAF): hover expands a branch; if the bloom overflows (`allVisibleInView`) the camera eases to fit (`camTarget`/`easeCamera`); leaving all branches collapses + recenters. Toggle via 🧭. Ease speed: Settings → General → "Ecosystem transitions" → `settings.ecosystem.easeSpeed` (`EASE` map).
- **Layout is cached & stable** (`placed`) — expanding one branch never reflows others; children fan outward across three staggered rings. Node size by contents (`nodeScale` → `--eco-scale`); depth-of-field blur off the focused spine (`updateTiers`, `.tier-mid`/`.tier-bg`).
- **Interaction:** drag to move, drop onto a node to re-parent, hover "+", right-click-at-cursor menus, double-click to open.
- **Lenses** (`LENSES`; right-click project → Group by Discipline/Phase/Status/Priority/Timeline/Categories) re-bucket tasks via `disciplineBucket`/`phaseBucket`/`dueBucket`/`taskBucket`; stored per project in `settings.ecosystem.lens`.
- **Suggestions** (`computeSuggestions`, 💡 badge; cached, `bustCache` on data change): overdue focus blocks, deadline protection, WIP trims, V-model phase gaps + next-phase ideas (`NEXT_TASKS`/`PHASE_ORDER`), utility hookups, stale nudges, WBS breakdown, intent-mined tasks (`INTENT_RE`). Calibrated by `computeInsights` (cycle-time median/mean/p90 by category/project/priority, velocity, weekday rhythm, keyword→duration, `estimate(task)`), which also powers the 📊 Insights panel (`openInsightsPanel`). One-click apply + dismiss (`settings.ecosystem.dismissed`).
- **Canvas widgets** (`.eco-widgets`, `positionWidgets`): suggestion cards bloom next to their branch (`suggestionTarget`); ⏱ timers + 🗒️ sticky notes via right-click, persisted in `settings.ecosystem.widgets`.
- Full-bleed (`#view-ecosystem`, in `isFullView`). Persists to **`settings.ecosystem`** `{ nodes, layout, expanded, dismissed, lens, showData, steer, easeSpeed, widgets }` (synced; a change fires `ecosystem-changed`). Camera is transient.
- **PWA mirror:** `mountEcosystem` in `pwa/app.js` — read/open-only, same disclosure/clustering, touch pan/zoom/pinch, desktop-only nodes → info sheet.
