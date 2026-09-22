# Engineering Task Board — LLM Navigation Guide

Electron desktop app for engineering project management. Includes task board, project tracking, 3D printing control, CAD viewer, file browser, Git integration, and Firebase cloud sync. Companion PWA at `assistant-taskboard.web.app`.

---

## ⚠️ ALWAYS keep the desktop app and PWA in sync

The PWA (`pwa/`) is meant to be a **reflection of the desktop app** (`renderer/` + `ipc/`). Whenever you change a user-facing feature, view, layout, style, or shared data/behavior in one, **apply the equivalent change to the other** in the same task. The PWA is a leaner parallel implementation (different file/class names — e.g. `.board-card` vs `.board-note-card`, `.timer-preset-btn` vs `.timer-preset`), so this means *equivalent behavior/appearance*, not a literal copy-paste. Mirror these by default:

- UI/layout/CSS changes → `renderer/styles.css` ↔ `pwa/styles.css`
- Renderer view logic → `renderer/*.js` ↔ `pwa/app.js`
- Data-model / business-logic changes (status, completion, filtering, sorting) → keep both in agreement

Pure desktop-only concerns (Electron main process, IPC, OS/file/printer/slicer integration) have no PWA equivalent and don't need syncing. When in doubt, sync it.

---

## 🚀 Shipping changes — one command, fully automated

**"push" / "ship" / "submit changes" (from the maintainer) ⇒ cut a versioned release
with `release.js`.** This is the single automated pipeline that gets a change to users,
and it is the default for *every* change. This install directory is **not a git
checkout**, so never `git commit`/`push` from here, and never hand-push the cached clone.

```bash
node release.js               # patch bump (1.3.21 → 1.3.22) — the default
node release.js minor -m "…"  # 1.3.21 → 1.4.0 with release notes
node release.js major -m "…"  # 1.3.21 → 2.0.0
node release.js 1.5.0         # explicit version
```

### Ship runbook — do this automatically when the user says push / ship / release

1. **Sync desktop ↔ PWA first** (see the parity rule at the top of this file). Never ship
   a user-facing change to one without the equivalent change in the other — the release
   publishes both, so an unmirrored change ships a divergence.
2. **Preview the real change set:** `node submit-changes.js --list` (safe — commits and
   pushes nothing; normalizes CRLF↔LF so only genuine edits show). Confirm it's what you
   expect, then move on.
3. **Ship it:** `node release.js patch -m "<one-line summary>"` (use `minor`/`major` when
   the change warrants it). This bumps `package.json` + `package-lock.json`, pushes the
   bump to `main` via `submit-changes.js`, then pushes a `vX.Y.Z` tag.
4. **Let CI finish on its own — do NOT poll it.** The tag triggers
   `.github/workflows/release-installer.yml`, which automatically, in parallel:
   - **builds `EngOrg-Setup.exe`** (Inno Setup) and attaches it to the `vX.Y.Z` GitHub
     Release, then prunes older version releases so the Releases page stays tidy;
   - **builds the Android ink APK** (`mobile-ink/`, `build-android.yml` logic mirrored in
     the `android` job) and attaches it to the release; and
   - **deploys the companion PWA to Firebase Hosting** — *only if* the repo has a
     `FIREBASE_SERVICE_ACCOUNT` Actions secret (otherwise that job warns and skips).
5. **Deploy the PWA yourself if CI can't** (secret not configured) or when you changed only
   `pwa/` and want it live immediately — see "Deploying the PWA" below.

> **Never bypass the release for a normal change.** No `git commit`/`push` against the
> `~/.engorg-submit/…` clone, no bare `submit-changes.js -m`, no manual tag/release surgery
> — this holds even for `mobile-ink/` or `.github/workflows/` edits, and even when a
> release would sweep up unrelated in-progress edits (that is acceptable; don't hand-push
> just your own files to "protect" WIP). A plain `submit-changes.js` push only refreshes
> the rolling `latest` installer and builds **no** versioned release — which is not what
> "push" means here. The **only** exception is when the user *explicitly* asks for a
> non-release push; then:
> ```bash
> node submit-changes.js -m "<message>"  # push source to main (updates rolling `latest` only, no version tag)
> node submit-changes.js -m "..." --pr   # push a branch and print a PR-compare link
> ```
> `submit-changes.js` is **update-only** (it never deletes repo files the install doesn't
> ship) and keeps its cached clone at `~/.engorg-submit/<repo>`. Full details: `CONTRIBUTING.md`.

### Deploying the PWA (Firebase Hosting, project `assistant-taskboard`)

A release tag auto-deploys the PWA **iff** the repo has a `FIREBASE_SERVICE_ACCOUNT`
Actions secret (the `pwa` job in `release-installer.yml`). When that secret isn't set — or
to push a PWA-only change live *without* a full release — deploy manually from a directory
that has `firebase.json` + `.firebaserc`. After a release the cached clone has both the
config and the just-pushed source:

```bash
cd ~/.engorg-submit/engorg-taskboard && npx firebase deploy --only hosting
```

`firebase-tools` is a devDependency (run it via `npx firebase`; it isn't on PATH globally).
**Auth is a one-time manual step for the user, not Claude:** `npx firebase login` opens a
browser OAuth flow (a credential action). Once logged in (persists in
`%APPDATA%\configstore\firebase-tools.json`), a non-interactive
`firebase deploy --only hosting` works. Use `--only hosting` so the deploy never touches
Functions / Firestore rules the install doesn't ship.

### Contributors without push access

The in-app path — Settings → Contribute → "Submit Changes…" (`ipc/contribute.js`) — forks
the repo and opens a PR via GitHub sign-in (no PAT, no git, no terminal). Full details:
`CONTRIBUTING.md`.

---

## File Map

| File | Purpose |
|------|---------|
| `main.js` | Electron entry point — app bootstrap, window creation, registers all IPC modules |
| `config.js` | All constants: DATA_DIR, printer URL, port, slicer paths. **Edit here to change any hardcoded paths or IPs.** |
| `state.js` | Shared mutable state: `latestCameraFrame` (camera buffer), `fluiddServer` (http.Server instance) |
| `fluidd-server.js` | HTTP/WebSocket proxy server on port 8765 — serves Fluidd UI, proxies Moonraker API, injects webcam config, handles OrcaSlicer OctoPrint-compat endpoints |
| `preload.js` | Exposes `window.api` to renderer via contextBridge. **Add new IPC channels here when adding features.** |
| `ipc/data.js` | `data:load`, `data:save`, `shell:openExternal`, `shell:openPath`, `dialog:openFiles`, `installer:build` |
| `ipc/outlook.js` | `outlook:fetchLocal` — reads Outlook calendar via PowerShell COM |
| `ipc/spell.js` | `spell:check/suggest/add` — self-contained offline spell checker. Lazy-loads a bundled word list (`renderer/lib/words-en.txt`, ~370k words) into a Set; Norvig-style suggestions; user dictionary persisted to `appdata/spell_user.json`. Chromium's built-in checker is disabled (`webPreferences.spellcheck:false`) so it doesn't double-underline. Renderer side: `renderer/spellcheck.js`. |
| `ipc/gradescope.js` | `gradescope:*` — Linked-account Gradescope. No API exists, so it logs in via the login form (CSRF token + `session[email]`/`session[password]`) using Electron `net.fetch` against a dedicated in-memory session partition (cookie jar persists across the redirect chain + course requests; `ensureAuth` caches the login ~40 min so one sync logs in once). Scrapes the dashboard course boxes + each `#assignments-student-table` (or React `data-react-props`) for assignment due dates. Password encrypted at rest via `safeStorage` in `GRADESCOPE_CREDS_FILE` (`appdata/gradescope.json`), decrypted only in main. `gradescope:fetchAssignments` returns calendar-ready schedule-item objects (same shape as `ipc/calendar.js`) enriched with `courseId/course/courseShort/assignmentId/dueISO`. The renderer (`app.js` `syncGradescope`) turns those into: a **project per class** (linked by `project.gradescopeCourseId`) and **one `category:'assignment'` note per assignment** (`task.source:'gradescope'`, `task.gradescopeId`, Gradescope URL added as a note **link**) whose **priority is recomputed every sync** from time-to-due (>1wk Low / ≤1wk Medium / ≤24h High). **The note (via its `dueDate`) IS the calendar entry** — no separate `scheduleItem` is created for an assignment (step 4 imports an empty list with `prune:true` to purge any duplicates older versions made); the calendar renders notes-by-due-date directly. The note card + every calendar surface show a **Gradescope brand logo** (`sourceLogoSvg` in `renderer/components/sticky-note.js`, mirrored in `pwa/app.js`). Submitted/graded assignments are **marked done** (never auto-un-completed). Course names have their term prefix (`Fall 2026`…) stripped. `gradescope:fetchAttachments(courseId, assignmentId)` best-effort downloads assignment files (allowlisted coursework extensions, only from gradescope.com / its S3+CloudFront CDNs, no executables, ≤30MB) into `GRADESCOPE_ATTACH_DIR` (`appdata/gradescope_attachments/<assignmentId>/`, **device-local — NOT synced**) and returns `[{ name, path }]` for the note's `attachments`. Desktop-only integration, but the projects/notes/calendar entries sync to the PWA via Firebase for free (attachment files stay device-local, like the print archive). |
| `ipc/variate.js` | `variate:*` — Linked-account **Variate** (Purdue's [StudioKit](https://purdue.api.variate.org) assessment platform). It has a real JSON API but is gated behind **Purdue Career Account SSO (BoilerKey + Duo 2FA)** via OAuth/PKCE, so — unlike Gradescope — there is **no headless password login**. Auth is interactive: `variate:connect` opens the web app (`VARIATE_APP_URL`) in a **BrowserWindow on a persistent partition (`persist:variate`)**; the user completes SSO+Duo once, and the SPA manages the OAuth token. Each sync (`variate:fetchAssignments`) reopens the app **hidden** — while the Purdue SSO session is alive the SPA re-auths silently (no Duo prompt) — reads the SPA's bearer token from its own `localStorage` (`persist:auth`) and calls the API (`VARIATE_API_URL`) from inside the page (CORS-allowed, so it's exactly what the SPA does): `/api/groups/home` (courses), `/api/groupAssessments` (assignments: `startDate`/`endDate`/`dueDate`/`currentLearnerStatus` ∈ UNSTARTED/SUBMITTED/COMPLETED/ENDED), `/api/assessments` (names), `/api/account/userInfo`. Effective due = `dueDate || endDate`. **No password is stored** — `VARIATE_STATE_FILE` (`appdata/variate.json`) holds only name/email/connected; the session lives in the encrypted partition cookie jar. `fetchAssignments` returns the same schedule-item shape as Gradescope (`courseId`=groupId, `assignmentId`=groupAssessmentId, `course/courseShort/dueISO/submitted`). Renderer `app.js` `syncVariate` (startup +30 min) builds a **project per class** (linked by `project.variateGroupId`, **merged by course code with the Gradescope/Brightspace project of the same class**) and **one `category:'assignment'` note per assessment** (`task.source:'variate'`, `task.variateId`, "Open in Variate" link) with the same time-based auto-priority; submitted/completed → **marked done** (never auto-un-completed). The note's `dueDate` IS its calendar entry (step 4 prunes duplicate schedule items). **Variate brand logo** (teal ✖) via the shared `sourceLogoSvg` helper, mirrored in `pwa/app.js`. Desktop-only integration; projects/notes sync to the PWA via Firebase for free. Point it at another school by editing `VARIATE_APP_URL`/`VARIATE_API_URL` in `config.js`. |
| `ipc/github.js` | `github:*` — Linked-account GitHub. PAT encrypted at rest via `safeStorage` in `GITHUB_TOKEN_FILE` (`appdata/github.json`), decrypted only in main, never sent to renderer. `github:fetchActivity` lists owned repos (sorted by pushed) and their recent commits → cached by the renderer in `settings.gitActivity` for the **Timeline**. |
| `ipc/files.js` | All `files:*` handlers — readdir, read/write, rename, delete, search, watch, KiCad SVG/GLB export |
| `ipc/git.js` | `git:status`, `git:stage`, `git:unstage`, `git:commit`, `git:diff`, `git:isRepo` |
| `ipc/auth.js` | `auth:googleSignIn` — opens child BrowserWindow to hosted auth page, polls for token |
| `ipc/printer.js` | `printer:apiGet/Post`, `printer:uploadFile/FileData`, `printer:webrtcOffer`, `printer:sendCameraFrame`, `printer:selectFile`, `printer:setEnabled` |
| `ipc/slicer.js` | `slicer:selectModel`, `slicer:getProfiles`, `slicer:slice` — OrcaSlicer CLI integration with profile merging |
| `ipc/print-history.js` | `printHistory:archive` (copies the STL + G-code of each tracked print into `appdata/print_archive/<id>/`) · `printHistory:openArchive`. Backs the 3D-print tracker. |
| `ipc/email.js` | All `email:*` handlers — IMAP (imapflow) receive + SMTP (nodemailer) send. App passwords encrypted at rest via Electron `safeStorage`; decrypted only in main, never sent to renderer. One pooled IMAP connection per account. |
| `ipc/kicad-importer.js` | All `kicad:*` handlers — KiCad library importer (port of `kicadImporter.py`). Staged: `extractZips` (dependency-free unzip via `tar`/`Expand-Archive`), `digikeyLookup` (OAuth2 client-credentials → metadata via global `fetch`), `addStepFile`, `writeLibrary` (regex s-expr manipulation). DigiKey creds from `config.js` defaults or `settings.json` override. |
| `ipc/utility-store.js` | All `store:*` handlers — Utility Store. Fetches catalog JSON from GitHub (`UTILITY_STORE_CATALOG_URL`); downloads remote utility HTML to `appdata/utilities/<id>/`. Remote utilities render in a sandboxed iframe (no Node/IPC) — never run with app privileges. |
| `ipc/engink-mirror.js` | `engink:*` — **EngInk live mirror** server. Runs a LAN WebSocket server (`ws`, `ENGINK_MIRROR_PORT` 8770) the native EngInk (Android) app streams strokes to, plus a UDP discovery responder (`dgram`, `ENGINK_DISCOVERY_PORT` 8771) that answers the tablet's broadcast probe with `{name,port,code}`. A 6-digit pairing code gates connections. Parsed client messages are forwarded to the renderer via `engink:message`; the renderer draws them (view-only mirror). Lives on `state.enginkMirror`; started on demand by the utility, stopped on quit. Desktop-only (no cloud — direct tablet↔PC LAN). |
| `ipc/file-merger.js` | `fileMerger:*` — File Merger utility helpers. `fileMerger:selectFiles` opens the native open dialog (PDF+image filters, multi-select) → `[{name,path,ext,size}]`; `fileMerger:save(bytes, defaultName)` shows a save dialog and writes the assembled PDF bytes → `{path}`/`{canceled}`/`{error}`. The PDF assembly itself runs in the **renderer** (`renderer/file-merger.js` with the bundled `PDFLib` global) because it needs a `<canvas>` to normalize arbitrary image formats; input bytes are read via the existing `files:readBinary`. Desktop-only. |

### Renderer modules (`renderer/`)

| File | Purpose |
|------|---------|
| `app.js` | Root — initializes all modules, handles tab switching |
| `taskboard.js` | Day-of-week task board UI. Note cards: description shows one truncated line (full on hover); **attachments** render one preview at a time with the chip row as a selector (click a chip → preview switches; click the preview → opens the file). |
| `ecosystem.js` | **Ecosystem tab** (the "branched view") — one radial workspace tree. **The tree is structure only** (workspace → projects → categories/deliverable buckets → hand-attached species); the **bulk data is NOT branches** — tasks/events/purchases/todos live as `items` on their category/bucket node (shown as a count badge) and surface in a **hover list widget** (`openListPopup`, a `.eco-list` child of `.eco-root`; clicking a task row opens its editor via the `edit-note` event). Hand-attached species ARE nodes: folders, files, **CAD models** (open live in a slide-in Three.js panel via `window.CadViewer`), links, notes, sub-branches, and **live utility instances** (e.g. a UART tester bound to a folder → opens via `window.openEngineeringUtility`). **Progressive disclosure**: default view shows **only the projects** (`isOpen()` — just `root` is open; everything deeper opens when pinned or on the cursor's focus path); big fans cluster into synthetic **"+N more"** nodes (`CAP`). **Cursor-steered nav** (`steerTick`, rAF): hover a branch → it expands and, if the bloom overflows the viewport (`allVisibleInView`), the camera **eases to fit** (`camTarget`/`easeCamera`); move off every branch → the focus collapses and the camera **recenters** to the overview. Layout is **cached & stable** (`placed`) so expanding one branch never reflows the others — children fan outward from their parent across three staggered rings. Nodes are **sized by how much they hold** (`nodeScale` via `--eco-scale`), and a **microscope depth-of-field** (`updateTiers`, `.tier-mid`/`.tier-bg`) blurs everything off the focused branch's spine. Ease speed is user-settable (Settings → General → "Ecosystem transitions": slow/normal/fast/instant → `settings.ecosystem.easeSpeed`, `EASE` map). Toggle the whole cursor behavior via 🧭. Also drag-to-move, drag-onto-a-node to re-parent, hover "+" and **right-click-at-cursor** menus, double-click to open. **Organizing lenses** (`LENSES`, right-click a project → **Group by** Discipline / Phase / Status / Priority / Timeline / Categories): re-buckets that project's tasks via keyword+category classifiers (`disciplineBucket`/`phaseBucket`/`dueBucket`/`taskBucket`), grounded in the discipline / Ulrich-Eppinger-phase / Kanban taxonomies; stored per-project in `settings.ecosystem.lens`. **Suggestions engine** (`computeSuggestions`, 💡 toolbar w/ badge; cached, busted via `bustCache` on data change): reactive recommendations — overdue-goal focus blocks, imminent-deadline protection, Kanban WIP trims, **V-model phase gaps** + **next-phase task ideas** (🔮 `NEXT_TASKS`/`PHASE_ORDER`), utility hookups, stale nudges, WBS breakdown, and **intent-mined candidate tasks** (`INTENT_RE` scans note text for "need to…/next step:…"). **Data-driven rules calibrated to the workspace's own history** via `computeInsights` (a general analytics pass over all tasks — cycle-time median/mean/p90 overall + per category/project/priority, velocity + trend, weekday rhythm, keyword→duration, title-length penalty, aging backlog, bottleneck project, `estimate(task)`): vague-title penalty, bottleneck-project session, backlog grooming, and deadline-vs-lead-time reality checks. The same analytics power the **📊 Insights panel** (`openInsightsPanel`) — a stat-tile + weekday-bars + category/keyword dashboard. Each suggestion has one-click **apply** + dismiss (`settings.ecosystem.dismissed`). **Canvas widgets** (`.eco-widgets` layer, `positionWidgets`): suggestions also **bloom as cards next to the branch they concern** (`suggestionTarget`), and you can drop **⏱ timers** + **🗒️ sticky notes** on the canvas (right-click → Add …) that persist in `settings.ecosystem.widgets` and follow the canvas as it pans/zooms. Full-bleed view (`#view-ecosystem`, in `isFullView`). Persists to **`settings.ecosystem`** (`{ nodes, layout, expanded, dismissed, lens, showData, steer, easeSpeed }`), synced; camera is transient (fits on first open). Mirrored read/open-only + same progressive disclosure/clustering (touch pan/zoom/pinch, desktop-only nodes → info sheet) in `pwa/app.js` (`mountEcosystem`). |
| `data.js` | Data layer — wraps `window.api.loadData/saveData`, in-memory cache |
| `firebase-sync.js` | Firestore real-time sync, offline persistence |
| `firebase-config.js` | Firebase project credentials |
| `printer.js` | Printer tab — Moonraker status, camera WebRTC, print controls |
| `slicer.js` | Slicer tab — model select, profile picker, slice and send. On **Upload & Print** it captures the slice meta and calls `printTracker.onPrintStarted(...)`; a 🖨️ History button opens the print log. |
| `print-tracker.js` | **3D Print Tracker** (`window.printTracker`, `window.openPrintHistory`) — records every print sent to the printer: archives STL+gcode+settings, asks which project it's for, polls Moonraker `print_stats` for completion, then asks success/fail (+ categorized reason). Failures are charted, and successful settings roll up into **best profiles** per material+layer-height. History/analysis modal works from both the tabbed Slicer and the organic view (🖨️ toolbar). Persists to `print_history.json` (device-local — archived file paths are local, so NOT synced). |
| `cad-viewer.js` | 3D model viewer — STL/OBJ/GLTF via Three.js, KiCad SVG/GLB via kicad-cli |
| `file-viewer.js` | File browser — directory tree, text/binary viewer, batch rename, content search, and **Git integration**: branch indicator, commit panel, per-file status badges (incl. conflicts), and a right-click git menu (status-aware Stage/Unstage, View Diff modal, Discard, **Open in Git Manager** → `gitManager.openRepo`). Badges/menu read `window.api.git.status` (cached as `gitStatus`/`gitFileMap`). |
| `settings.js` | Settings — persists to `settings.json`. Opens as a **popup modal** (`#settings-modal` in `index.html`; the gear button calls `window.openSettings()` which renders into `#view-settings` and shows the overlay — Esc / backdrop / × closes). It is no longer a full view. **Tabbed layout** (`renderSettings` builds a left-rail `.settings-nav` + `.settings-tab-panel` sections: Appearance / General / Linked Accounts / Calendar / Integrations / **Hotbar** / Mobile / Data / About; active tab kept in module var `_settingsTab`). **Hotbar tab** (`bindHotbarEditor`) — a drag-reorderable list of the tabs + utilities in the top bar (writes `hiddenTabs`/`hotbarUtilities`/`tabOrder`) with show/hide, promote/demote, a Lock toggle (`tabsLocked`), and Reset; mirrors what the bar renders and calls `window.applyHotbar()` live. **About tab** groups Version, Build Installer, Request a Feature, and Submit Changes. **Linked Accounts hub** (`refreshLinkedAccounts`) — unified cards for Cloud Sync (Google/Firebase), GitHub, **Gradescope** (email+password → calendar due dates), **Variate** (Purdue SSO → calendar due dates; Connect opens a sign-in window, no stored password), and Email (Gmail/Outlook/IMAP via `api.email.listAccounts`). The account *registry* (`settings.linkedAccounts`) syncs across devices; secrets stay device-local (OS keystore), so cards can show "Reconnect on this device". |
| `stats.js` | Stats/analytics tab |
| `noteboard.js` | Sticky notes board |
| `timers.js` | Clock utility with a 3-mode switcher (`_timerTab`): **Timers** (countdown, with a 🔁 Repeat option that auto-restarts on finish), **Alarms** (scheduled HH:MM, one-shot or repeating on weekdays; iOS-style enable toggle, edit/delete; fires a desktop Notification + beeps), and **Stopwatch** (start/stop/lap/reset). A 1s `_globalTimerWatch` runs app-wide: fires timer expiry (+repeat rollover) and checks alarms (`_checkAlarms`) even when the tab is closed. Alarms persist in `settings.alarms` (synced) via `dataManager` `getAlarms/addAlarm/updateAlarm/deleteAlarm`. Countdown timers still live in the top-level Firestore `timers` collection (requires cloud sign-in). |
| `email.js` | Email hub tab — IMAP/SMTP client UI (3-pane: accounts/folders, message list, sandboxed reading pane), compose/reply/forward, account setup. Desktop-only (no PWA equivalent). |
| `engineering.js` | **Engineering Utilities** tab — hosts installable utilities (Printer, Slicer, KiCad Importer + GitHub-installed remote utilities) under one tab with a sub-nav + **Utility Store**. Built-in registry + `installedUtilities` (settings.json) install state. Desktop-only. |
| `kicad-importer.js` | KiCad Importer utility UI — ZIP picker, options, progress/log, part-selection & missing-STEP modals. Mounts inside the Engineering Utilities tab. Desktop-only. |
| `purchasing.js` | Purchase tracking |
| `stats.js` | Stats/analytics tab |
| `updates.js` | In-app update checker — scans canonical repo for newer commits, prompts to update. The "Update available" prompt has a **View changes** button → `onboarding.showChanges(res)` (walks through curated notes for the offered version, or the commit list). **Version sync:** `updates:check` also reports `currentVersion` (`app.getVersion()` ← `package.json`) vs `latestVersion` (the repo's upstream `package.json` version) + `versionBehind` (semver). The repo's `package.json` `version` is the single source of truth; bump it when releasing. Settings → About shows the version + a "Check for updates" (`updates:version` for the cheap local read). |
| `tour.js` | **Guided-tour engine** (`window.appTour`) — framework-free coachmark/slideshow system. `appTour.run(steps, opts)` → `Promise`; steps are spotlight steps (`{ target, title, body\|bodyHtml, placement, view? }` — dims the screen, rings the element, anchors a tooltip) or centered slide steps (no `target`). `appTour.isActive()` lets the updater defer so prompts don't stack. Shared by first-run onboarding and the What's New walkthrough. Mirrored verbatim in `pwa/tour.js`. |
| `onboarding.js` | **Onboarding orchestration** (`window.onboarding`) over `appTour`. `maybeRunFirstRun()` runs the first-run spotlight tour once per device (localStorage `engorg_onboarded`); `maybeShowWhatsNew()` shows curated highlights once after a version bump (localStorage `engorg_whatsnew_seen`); `showChanges(res)` powers the updater's View changes button; `replayFirstRun()`/`replayWhatsNew()` back the Settings → About **Tour & Tips** buttons. Curated release notes live in the `WHATS_NEW` map keyed by version — **add an entry here when shipping a notable feature**. Both are invoked from `app.js` startup (after `EMB`/shell gate). |
| `theme-fx.js` | Theme/visual-style engine (the many `body.style-*` themes in `styles.css`) |
| `titlebar.js` | Custom window titlebar (frameless window controls) + the visible **File/Edit/View/Window** menu (the native menu is hidden). Items support `action` (→ `api.menu.action`), `onClick` (local), and `submenu` (right-hand flyout). The **View** menu's "Split Window" and "Set Theme" submenus are built from `window.windowSplit`. A top-level menu entry with `onClick` (no `items`) renders as a **direct-action button** — e.g. **🌐 Web App** opens the companion PWA (`assistant-taskboard.firebaseapp.com`) in the browser. |
| `window-split.js` | **Split Window** + **local theme**. Loaded *before* app.js. Splits the window into a gap-less grid of same-origin `index.html?embedded=1` `<iframe>` app instances — layouts `2v/2h/3v/3h/4q/4v/4h` (vertical=columns, horizontal=rows), `single` to restore. Layout + per-pane themes persist in **localStorage** (`splitLayout`), never synced. When this window is the split *shell* it **hides its own titlebar/header** (so the only chrome is each pane's bar) and shows a small floating min/max/close cluster (`#split-winctrls`, with a drag-grab strip); app.js bails early (`windowSplit.isShell()`) so no data/Firebase/auth-gate loads behind the panes. Embedded panes are full apps but suppress background services. **Layout changes from a pane** post to the shell (`split-setlayout`) since only the top window can re-tile. **View → Set Theme** sets a display-only theme: top window → `localStorage.localTheme`; a pane → `postMessage` (`split-theme`, persisted per pane). `settings.js` `initTheme()` honors `windowSplit.startupThemeOverride()`. Desktop-only. |
| `wifi-checker.js` | Wi-Fi / network diagnostics utility |
| `uart-bridge.js` | Serial/UART bridge utility |
| `git-manager.js` | **Git Manager** utility — GitHub-Desktop-style git client: repo + branch dropdowns, Fetch/Pull/Push/Sync, stage checkboxes, commit box (with **amend**), History + diff viewer with a **right-click commit context menu** (checkout/branch/tag/cherry-pick/revert/reset/copy-SHA), **conflict resolution** (ours/theirs/edit/continue/abort banner), stash/tags/remotes **manager dialogs**, optional **auto-fetch** (5 min), one-click **Upload folder** / **Download folder**, plus a raw git terminal. Tracked repos persist in `settings.json` (`gitRepos`, `gitLastRepo`); auto-fetch toggle in `gitAutoFetch`. Mounts in the Engineering Utilities tab via the `git-manager` BUILTIN. Backed by `window.api.git.*`. Desktop-only. |
| `engink-mirror.js` | **EngInk** utility (`enginkMirror`) — a **view-only live reflection of the tablet's EngInk notebook over the LAN** (no cloud). Starts the desktop mirror server (`window.api.engink.*` → `ipc/engink-mirror.js`), shows a pairing panel (this PC's IP:port + 6-digit code + connected device), and renders the incoming strokes on a canvas that reproduces the native `FinishedStrokesView` (816×1056 pages, GRID/RULED/DOTS/PLAIN paper, highlighter alpha, Catmull-Rom ink) — with page-follow (mirrors the tablet's current page), inspect pan/zoom, and **Export PDF** (browser print-to-PDF of all mirrored pages). Mounts via the `engink` BUILTIN. The tablet side is the native `mobile-ink` app's `MirrorManager`/`MirrorClient` (OkHttp WS + UDP discovery). Desktop-only (no PWA equivalent). |
| `file-merger.js` | **File Merger** utility (`fileMerger`) — combines any number of PDFs and images into a single PDF, in a user-arranged order. Add files via the native dialog (`window.api.fileMerger.selectFiles`), drag rows or use ▲▼ to reorder, pick how images are laid out (**Fit to image** / Letter / A4), then export. Assembly uses the bundled `PDFLib` global (`renderer/lib/pdf-lib.min.js`): PDF inputs have their pages copied in via `copyPages`; image inputs are embedded on their own page (JPG/PNG embedded directly, other formats — webp/gif/bmp — normalized through a `<canvas>` to PNG bytes first). Input bytes come from `files:readBinary`; the finished PDF is written via `window.api.fileMerger.save` (→ `ipc/file-merger.js`), which then opens the result. Mounts via the `file-merger` BUILTIN. Desktop-only (no PWA equivalent). |
| `components/add-note-modal.js` | **`ModalManager`** — owns ALL modals: add/edit note, schedule event, **project**, category. (Despite the filename, this is the central modal controller, not just notes.) |
| `components/sticky-note.js` | Sticky-note card rendering/helpers |
| `components/project-manager.js` | Stub only — project CRUD actually lives in `ModalManager` (`add-note-modal.js`) |
| `components/tracking-utils.js` | Shared tracking helpers |

> **Project groups + Projects tab** (see "Views & Navigation" below) are wired across `app.js` (sidebar groups, drag-to-group, group modal), `taskboard.js` (`renderProjectSlates`), `data.js` (group CRUD), and `index.html` (`#modal-group`, `data-view="projects"`).

### Data files (`appdata/`)

Stored in `C:\Assistant\appdata\`. Allowed filenames are whitelisted in `ipc/data.js`:
`tasks.json`, `projects.json`, `purchases.json`, `settings.json`, `schedule.json`, `todos.json`, `archived_projects.json`, `print_history.json` (+ the `print_archive/` folder of copied STL/gcode, and the `gradescope_attachments/` folder of downloaded assignment files — both device-local, written directly by main, not via the `data:save` whitelist). Linked-account metadata files are also written directly by main, outside the `data:save` whitelist: `github.json`, `gradescope.json`, `variate.json` (Variate — non-secret name/email/connected only; the SSO session lives in the `persist:variate` partition, not here).

---

## Data Model

All data is loaded/cached by `renderer/data.js` (`DataManager`, the global `dataManager`). Each collection saves locally **and** uploads to Firestore via `firebaseSync.upload(...)`. IDs are generated by `_genId(prefix)` (`note_`, `proj_`, `grp_`, `sch_`, `pur_`, `todo_`).

| Collection | File | Key fields |
|------------|------|-----------|
| `tasks` (sticky notes) | `tasks.json` | `id, title, projectId, day, status` (`backlog`/`inProgress`/`review`/`done`), `completed`, `priority` (High/Medium/Low), `category`, `dueDate`, `checklist[]`, `createdAt/modifiedAt/completedAt`, `statusHistory[]`. **Invariant:** `status === 'done'` ⇔ `completed === true` (healed on load and in `addTask`/`updateTaskStatus`). |
| `projects` | `projects.json` | `id, name, color` (auto-assigned rainbow via `assignRainbowColors`), `categories[]`, **`groupId`** (null = ungrouped), **`workSchedule[]`** (recurring weekly work blocks `{ day, start, end }` edited via a **drag-to-paint weekly grid picker** — the project modal shows a summary + "Set weekly schedule…" button that opens `#modal-schedule-picker`; `ModalManager` paints 15-min slots on a 24-hour grid and collapses them back to blocks on Done. The calendar synthesizes "Schedule" pseudo-events from them via `ViewRenderer._getWorkBlocks(dayName, dateStr)` — never stored as `scheduleItems`. Each occurrence **auto-completes once its end time has passed** for its date (`completed = endDateTime <= now`), so finished sessions drop into the day panel's Completed section on their own — past days fully completed, today's earlier blocks complete as the day goes, future days stay active. No manual/stored completion state), `createdAt`. |
| `projectGroups` | inside `settings.json` | `id, name, color, collapsed, archived, archivedAt, createdAt`. Managed by `addProjectGroup / updateProjectGroup / deleteProjectGroup / setProjectGroup / getProjectGroups / getActiveProjectGroups / archiveProjectGroup / unarchiveProjectGroup`. **Delete** ungroups its projects (never deletes projects). **Archive** archives the group *and* all its member projects (`archived:true` on the group; members move to `archivedProjects` with `groupId` preserved). `getActiveProjectGroups()` = `!archived` (used by active sidebar + Projects overview). Stored in settings so it syncs everywhere for free. |
| `archivedProjects` | `archived_projects.json` | A project plus bundled `_tasks/_scheduleItems/_todos/_purchases` and `archivedAt`. Archive/unarchive moves data in/out of the active collections. |
| `scheduleItems` (calendar events) | `schedule.json` | `id, title, projectId, date, day, startTime, endTime, completed, source` (`outlook`/ICS), `outlookId`/`extId` for dedup. |
| `purchases` | `purchases.json` | `id, item, projectId, status` (`toPlace`/…), `trackingNumber, carrier` (auto-detected), `cost, quantity`. |
| `todos` | `todos.json` | `id, projectId, done`. |
| `settings` | `settings.json` | `activeView, theme, categories[], projectGroups[], hiddenTabs[], hotbarUtilities[], tabOrder[], tabsLocked, printerEnabled, autoCheckUpdates, noteSortMode, noteColorMode, noteTertiarySort` (`alpha`/`newest`/`oldest` — secondary tie-break, exposed only in Settings), `staleAnimations` (note wiggle), `askewNotes` (note tilt), `projectIndicator` (`dot`/`bar` — sidebar project color style, Settings → Appearance, device-local), DigiKey/utility overrides, `gitRepos`/`gitLastRepo`/`gitAutoFetch` (Git Manager), `gitActivity[]`/`gitLastSync` (cached GitHub commits → Timeline), `alarms[]` (Timers tab alarms — `{ id, label, time:'HH:MM', days:[0-6] ([]=one-shot), enabled, lastFired:'YYYY-MM-DD' }`; **synced**), `linkedAccounts` (synced registry of linked accounts — `{ github:{username}, email:[{email,name,provider}] }`; secrets are NOT here, they stay device-local), etc. (Local-only `localTheme`/`splitLayout` live in **localStorage**, not here.) |

---

## Views & Navigation (`renderer/app.js`)

- **Interface mode** (`window.applyUiMode`, `settings.uiMode` = `'tabbed'`|`'organic'`; toggle in **Settings → General → Interface**, `#settings-ui-mode`): switches between the classic tabbed UI and **organic mode**, where `body.organic-mode` hides `.header-tabs`/`#btn-tab-lock` and the Ecosystem tree *is* the whole app (boots into it; the gear stays available to switch back). In organic mode you create real data from the tree (right-click a branch → Add task/event/purchase/to-do; complete/add from the hover list widget).
- **Header tabs** (`.header-tab[data-view=...]` in `index.html`) map to `#view-<name>` panels: `notes`, `projects`, `ecosystem`, `calendar`, `email`, `timeline`, `timers`, `board`, `purchasing`, `stats`, `files`, `engineering`. `viewRenderer.currentView` tracks the active one; `renderCurrentView()` dispatches. Tabs are show/hide-able and reorderable (the "hotbar" — `hiddenTabs`/`tabOrder`/`hotbarUtilities` in settings; editable in Settings → `MAIN_TABS` in `settings.js`).
- **Sidebar** = project filter. `viewRenderer.selectedProject` is `'all'`, a project id, or `'all-archived'`. **"All Projects" is a pure filter** (shows every project's items in the current view) — it does *not* switch views. (`viewRenderer.selectedDay` still exists — defaults to today, used as the default day for new notes + the progress bar — but the sidebar DAY picker was removed.)
- **Projects tab** (`data-view="projects"`) is the project overview/dashboard — `ViewRenderer.renderProjectSlates()` renders one slate per project into `#view-projects`, grouped into sections by `projectGroups` (then an "Ungrouped" section). It has its own **"+ Group"** toolbar button and a ••• menu on each group header (Edit / Archive / Delete). Clicking a slate (or a sidebar project) drills into that project's Notes. "All Archived" (sidebar) reuses this tab with `selectedProject='all-archived'`, where archived projects are grouped by their group and archived-group sections offer **Unarchive group**.
- **Project groups** also live in the sidebar: a **`#btn-add-group`** "+ Group" button, collapsible group headers (`.sidebar-group`), and per-group ••• menus (Edit / Archive / Delete via `#modal-group`). Projects are assigned to groups by **drag** (drop onto a group header / body / the ungrouped zone) or via the project's ••• **Move to** submenu. After any sidebar drag, `commitSidebarOrder()` rebuilds `dataManager.projects` order + each project's `groupId` from the DOM.
- **Group actions are centralized** in `app.js` as `editGroupFlow / archiveGroupFlow / deleteGroupFlow / unarchiveGroupFlow`, driven by `window` CustomEvents (`add-group`, `edit-group`, `archive-group`, `delete-group`, `unarchive-group`) so the sidebar and the Projects page share one code path. Confirms use the themed `showConfirm`.
- **Mirror to PWA:** group membership is reflected in the PWA's project `<select>` via `<optgroup>` (`projectOptionGroups()` in `pwa/app.js`). The PWA has no projects-overview view; its "All Projects" was always a pure filter.

---

## Key Constants (`config.js`)

| Constant | Value | What it controls |
|----------|-------|-----------------|
| `DATA_DIR` | `C:\Assistant\appdata` | All local JSON storage |
| `MOONRAKER_URL` | `http://192.168.0.130:7125` | K1C printer Moonraker API |
| `FLUIDD_PORT` | `8765` | Local Fluidd proxy server port |
| `FLUIDD_DIR` | `tools/fluidd` | Fluidd static files |
| `ORCASLICER_EXE` | `%ProgramFiles%\OrcaSlicer\orca-slicer.exe` | Slicer executable |
| `ORCASLICER_RESOURCES` | `%ProgramFiles%\OrcaSlicer\resources\profiles\Creality` | Slicer profile directories |
| `SLICER_OUTPUT_DIR` | `appdata/slicer_output` | Gcode output and merged profile temp files |
| `DIGIKEY_CLIENT_ID` / `_SECRET` | (defaults) | KiCad Importer DigiKey API creds; overridable in Settings → stored in `settings.json` |
| `UTILITY_STORE_CATALOG_URL` | raw GitHub URL | Utility Store catalog JSON (`{ utilities: [{ id, name, icon, description, version, entry }] }`) |

---

## IPC Channel Reference

### Data
- `data:load(filename)` → parsed JSON or null
- `data:save(filename, data)` → true
- `shell:openExternal(url)` → void
- `shell:openPath(filePath)` → void
- `dialog:openFiles()` → `[{ name, path }]`
- `installer:build()` → `{ success, path|error }`

### Outlook
- `outlook:fetchLocal(daysBack, daysForward)` → `[{ subject, startTime, endTime, location, body, isAllDay, entryId }]`

### Spell check (note fields)
- `spell:check(text)` → `[{ word, start, end }]` misspelled ranges · `spell:suggest(word)` → `[string]` · `spell:add(word)` → true (user dictionary)
- `renderer/spellcheck.js` `Spellcheck.attach(textarea)` overlays red wavy underlines (a mirrored backdrop behind a transparent-bg textarea) and shows a **hover** suggestions popup; click to replace. Attached to `#note-text`/`#note-description` on note-modal open.

### GitHub (Linked Accounts → Timeline)
- `github:status()` → `{ connected, username, name }` (never returns the token)
- `github:connect(token)` → validates via `/user`, encrypts+stores the PAT → `{ username, name }` or `{ error }`
- `github:disconnect()` → deletes the stored token
- `github:fetchActivity(days=90)` → `{ commits: [{ sha, repo, message, date, url, author }] }` — commits on **owned** repos within the window. The renderer (`app.js` `syncGitHub`, on startup + every 30 min) caches the result in `settings.gitActivity` (+ `gitLastSync`); `taskboard.js` `renderTimeline()` renders them as `git-commit` items (only in the "All Projects" view; click opens the commit).

### Gradescope (Linked Accounts → Calendar due dates)
- `gradescope:status()` → `{ connected, email }` (never returns the password)
- `gradescope:connect(email, password)` → validates by logging in, encrypts+stores the password → `{ email }` or `{ error }`
- `gradescope:disconnect()` → deletes the stored creds + clears the scrape session cookies
- `gradescope:fetchAssignments()` → `{ events: [schedule-item + courseId/course/courseShort/assignmentId/dueISO…], courses: [{ id, name, short, count }], coursesScanned }` or `{ error, events: [] }` — logs in with stored creds, scrapes upcoming assignment due dates. Renderer (`app.js` `syncGradescope`, startup + every 30 min) creates a project per class and creates/updates one `category:'assignment'` note per assignment with a time-based auto-priority. The note's `dueDate` drives its calendar appearance, so **no separate `scheduleItem` is created** — step 4 calls `importExternalEvents([], { source:'gradescope', prune:true })` purely to prune duplicates from older versions.
- `gradescope:fetchAttachments(courseId, assignmentId)` → `{ attachments: [{ name, path }] }` — best-effort download of that assignment's files (fetches the `/submissions/new` page; the instructor template PDF's real URL lives in a `data-template-url` attribute, not the empty anchor href) to `appdata/gradescope_attachments/<assignmentId>/` (device-local). Renderer calls it lazily once per note (`fetchGradescopeAttachments`, guarded by `task.gsAttachVer`).

### Variate (Linked Accounts → Calendar due dates)
Purdue's StudioKit assessment platform. **SSO-only** (Career Account + Duo), so auth is interactive — no credentials cross IPC.
- `variate:status()` → `{ connected, name, email }` (metadata only, from `appdata/variate.json`)
- `variate:connect()` → opens the web app in a **visible BrowserWindow** (partition `persist:variate`), waits for the user to complete Purdue SSO+Duo, reads the account info → `{ name, email }` or `{ error }`. Takes **no arguments** (unlike `gradescope:connect`).
- `variate:disconnect()` → deletes `variate.json` + clears the `persist:variate` partition (signs out on this device).
- `variate:fetchAssignments()` → `{ events: [schedule-item + courseId(groupId)/course/courseShort/assignmentId/variateAssessmentId/dueISO/submitted], courses: [{ id, name, short, count }], coursesScanned }` or `{ error, events: [], needAuth? }`. Reopens the app **hidden**; if the SSO session is alive it re-auths silently and calls the API (`/api/groups/home`, `/api/groupAssessments`, `/api/assessments`, `/api/account/userInfo`) from the page context using the SPA's own bearer token. If the session expired, returns `{ needAuth:true }` → renderer surfaces "reconnect". Renderer `app.js` `syncVariate` (startup +30 min) mirrors `syncGradescope`: project per class (linked by `variateGroupId`, merged by course code), one `category:'assignment'` note per assessment (`source:'variate'`, `variateId`), time-based auto-priority, submitted/completed → done. Step 4 prunes duplicate schedule items (`importExternalEvents([], { source:'variate', prune:true })`).

### Brightspace → assignment notes (renderer only, no new IPC)
`app.js` `syncCalendars` → `syncBrightspaceNotes(events)` turns each Brightspace ICS entry whose SUMMARY ends in **"- Due"** into a `category:'assignment'` note (`task.source:'brightspace'`, `task.brightspaceId`), same shape as Gradescope notes (time-based auto-priority). The **course is the event's `LOCATION`** (e.g. `Fall 2026 ME 164 - LAB`); it's matched to the class project via a normalized Purdue course code (`courseCodeOf`, pads 3-digit → 5-digit so `ME 164` ≡ `ME 16400`) so Brightspace merges into the **same project** as Gradescope instead of duplicating. Gradescope sync stores `project.courseShort`/`courseCode` to enable this; the initial calendar sync is delayed (~16s) so Gradescope populates those first. Content-release ("- Available") entries are ignored. Like Gradescope, **the note (via its `dueDate`) IS the calendar entry**: `syncBrightspaceNotes` flags each note-backed deadline with `ev._noteBacked`, and `syncCalendars` filters those out of the `importExternalEvents` schedule import (`events.filter(ev => !ev._noteBacked)`) so no duplicate `scheduleItem` is created (non-"- Due" Brightspace events still import as normal calendar events). Brightspace notes + calendar surfaces show a **Brightspace brand logo** via the shared `sourceLogoSvg` helper.

> **Brightspace completion status:** the integration only consumes the **public ICS calendar feed**, which carries deadlines but **no per-student submission/completion data** — so unlike Gradescope (which scrapes the logged-in dashboard and can auto-mark submitted assignments done), Brightspace notes **cannot** be auto-completed. Detecting completion would require logging into Brightspace/D2L (stored credentials + scraping the quiz/assignment submission pages, or the D2L Valence API with institutional OAuth keys) — a separate, larger integration not yet built.

### Files
- `files:selectFolder()` → path or null
- `files:readdir(dirPath)` → `[{ name, path, isDirectory, size, modified }]`
- `files:readText(filePath)` → string (max 50MB)
- `files:readBinary(filePath)` → ArrayBuffer
- `files:getFileUrl(filePath)` → `file:///` URL
- `files:stat(filePath)` → `{ size, modified, created, isDirectory }`
- `files:getHome()` → home dir path
- `files:rename(old, new)` → true
- `files:delete(filePath)` → true (moves to trash)
- `files:writeText(filePath, content)` → true (auto-creates dirs)
- `files:mkdir(dirPath)` → true
- `files:copyFile(src, dest)` → true
- `files:moveFile(src, dest)` → true
- `files:exists(filePath)` → boolean
- `files:readHead(filePath, bytes)` → string
- `files:batchRename(dirPath, find, replace, { regex, caseSensitive })` → `[{ old, new, success, error? }]`
- `files:searchContent(rootDir, query, { regex, caseSensitive, maxResults })` → `[{ filePath, matches: [{ line, lineNumber }] }]`
- `files:watch(dirPath)` → true; fires `files:changed` event on mainWindow
- `files:unwatch(dirPath)` → true
- `files:exportKicad(filePath)` → `[{ name, content }]` SVG array
- `files:exportKicadGlb(filePath)` → ArrayBuffer GLB
- `files:hasKicadCli()` → boolean

### Git
All shell out to system `git` (no native deps). Network ops run with `GIT_TERMINAL_PROMPT=0` — auth relies on the OS credential manager. `dirPath` = repo working dir; paths in the `*Paths` variants are **repo-relative**.
- `git:status(dirPath)` → `{ branch, files: [{ path, orig, status, index, work, staged, unstaged, untracked }], upstream, ahead, behind, staged[], unstaged[], error? }` (back-compat: `branch`, `files[].path`, `files[].status` preserved)
- `git:branches(dirPath)` → `{ current, local: [{ name, current, upstream }], remote: [names], error? }`
- `git:log(dirPath, limit=80)` → `{ commits: [{ hash, shortHash, author, email, date, subject, refs }], error? }`
- `git:remotes(dirPath)` → `{ remotes: [{ name, url }], error? }`
- `git:isRepo(dirPath)` → boolean
- `git:diff(filePath)` → string diff · `git:diffPath(dirPath, relPath, staged)` → string diff (untracked files shown via `--no-index`)
- `git:stage(filePath)` / `git:unstage(filePath)` → true (resolve repo root from the file)
- `git:stagePaths(dirPath, paths[])` / `git:unstagePaths(dirPath, paths[])` / `git:stageAll(dirPath)` / `git:unstageAll(dirPath)` → true
- `git:discardPaths(dirPath, paths[])` / `git:discardAll(dirPath)` → true (restore + clean)
- `git:commit(dirPath, message, { amend?, stageAll? })` → string · `git:undoLastCommit(dirPath)` → true (soft reset, keeps changes staged)
- `git:createBranch(dirPath, name, checkout=true)` / `git:checkout(dirPath, name)` / `git:deleteBranch(dirPath, name, force)` / `git:renameBranch(dirPath, old, new)` / `git:merge(dirPath, branch)` → true/string
- `git:stash(dirPath, message?)` / `git:stashList(dirPath)` / `git:stashApply(dirPath, ref, drop=true)` / `git:stashDrop(dirPath, ref)`
- **In-progress ops / conflicts**: `git:mergeStatus(dirPath)` → `{ state: 'merge'|'rebase'|'cherry-pick'|'revert'|null }` (reads the git dir for MERGE_HEAD etc.) · `git:resolvePaths(dirPath, paths[], 'ours'|'theirs')` (checkout side + add) · `git:abort(dirPath, state)` · `git:continueOp(dirPath, state)` (commits/continues with `GIT_EDITOR=true`). Conflicted files are flagged `conflicted:true` in `git:status`.
- **Commit-level ops** (History context menu): `git:revert` · `git:cherryPick` · `git:reset(dirPath, hash, 'soft'|'mixed'|'hard')` · `git:checkoutCommit` (detached) · `git:branchAt(dirPath, name, hash)` · `git:lastCommitMessage(dirPath)` (for amend prefill)
- **Tags**: `git:tags(dirPath)` → `{ tags: [{ name, subject }] }` · `git:tagAt(dirPath, name, hash?, message?)` (annotated if message) · `git:deleteTag` · `git:pushTag`
- **Remotes (write)**: `git:removeRemote` · `git:renameRemote` · `git:setRemoteUrl`
- `git:fetch(dirPath)` / `git:pull(dirPath, { rebase? })` / `git:push(dirPath, { setUpstream?, remote?, branch?, force?, tags? })` / `git:sync(dirPath)` (fetch → pull → push) → string
- `git:init(dirPath)` → true · `git:clone(parentDir, url, dirName?)` → `{ path, output }` · `git:addRemote(dirPath, name, url)` → true
- **Folder upload/download** (one-folder workflows in the Git Manager):
  - `git:uploadFolder(repoDir, srcFolder, { subfolder?, commitMessage?, push? })` → `{ dest, output }` — recursively copy a local folder INTO the repo, then `add -A` + commit (+ push)
  - `git:publishFolder(srcFolder, remoteUrl, { branch?, commitMessage? })` → `{ path, branch, output }` — init the folder as a repo, add `origin`, commit, `push -u`
  - `git:extractFolder(srcFolder, destParent)` → `{ dest }` — recursively copy a folder out of the repo to a destination
  - `git:sparseDownload(remoteUrl, subfolder, destParent, { branch? })` → `{ dest }` — sparse-checkout just one subfolder from a remote, copy it out (temp clone auto-cleaned)
  - `git:listFolders(dirPath)` → `{ folders: [name] }` — immediate subfolders (excludes `.git`)
- `git:raw(dirPath, commandLine)` → `{ stdout, stderr, ok, error? }` (powers the in-utility git terminal; a leading `git` is tolerated)

### EngInk mirror (Engineering → EngInk)
LAN, view-only reflection of the native EngInk (Android) notebook. `ipc/engink-mirror.js` runs the sockets; `renderer/engink-mirror.js` draws. No cloud.
- `engink:start()` → `{ running, host, port, code, clients:[{device,version}] }` — starts (idempotent) the WebSocket server (`ENGINK_MIRROR_PORT`) + UDP discovery responder (`ENGINK_DISCOVERY_PORT`) and returns pairing info.
- `engink:stop()` → `{ running:false }` · `engink:status()` → same shape as start.
- Push channels (renderer subscribes): `engink:message` (the tablet's `open`/`page`/`wet`/`wetClear`/`view` traffic + synthetic `server`/`client` status events) and `engink:status` (pairing/connection snapshot). Preload: `window.api.engink.{start,stop,status,onMessage,onStatus,removeListeners}`.

### Auth
- `auth:googleSignIn()` → `{ idToken, accessToken }`

### Printer
- `printer:apiGet(baseUrl, path)` → parsed JSON
- `printer:apiPost(baseUrl, path, body)` → parsed JSON
- `printer:uploadFile(baseUrl, filePath)` → parsed JSON
- `printer:uploadFileData(baseUrl, filename, base64Data)` → parsed JSON
- `printer:webrtcOffer(printerIp, sdpOffer)` → `{ status, body (SDP answer), headers }`
- `printer:sendCameraFrame(jpegDataUrl)` → true
- `printer:selectFile()` → path or null
- `printer:setEnabled(boolean)` → `{ started|stopped|noChange: true }`

### Slicer
- `slicer:selectModel()` → path or null
- `slicer:getProfiles()` → `{ process: [{ name, path, source }], filament: [...] }`
- `slicer:slice({ modelPath, processProfile, filamentProfile, overrides })` → `{ success, gcodePath, output, estimates: { time, filamentMm, filamentG, filamentM, fileSize } }`

---

## How to Add a Feature

1. **Main process logic** → add handler in the appropriate `ipc/*.js` module, or create a new `ipc/myfeature.js` and `module.exports = function register(getMainWindow) { ... }`
2. **Register the module** → `require('./ipc/myfeature')` and call `registerMyFeature(getMainWindow)` in `main.js`
3. **Expose to renderer** → add the channel wrapper to the correct namespace in `preload.js`
4. **Renderer UI** → add to an existing renderer module or create a new `renderer/myfeature.js` and wire it into `renderer/app.js`
5. **Persistent data** → add filename to `ALLOWED_FILES` in `ipc/data.js` if a new JSON file is needed

---

## Architecture Notes

- **Context isolation**: renderer has no Node access. All OS/file/network calls go through `window.api` (preload) → IPC → main process.
- **⚠️ Subframe preload (`nodeIntegrationInSubFrames: true`)**: needed so Split Window's `<iframe>` app panes get `window.api`. Because it runs the preload in *every* subframe, `preload.js` **gates `contextBridge.exposeInMainWorld('api', …)` to real app frames only** (`location.pathname` ends with `/renderer/index.html`). This keeps the sandboxed remote-utility / email iframes privilege-free — if you add another trusted in-app frame, make sure it loads `renderer/index.html` or the gate must be updated.
- **Fluidd camera bridge**: renderer captures WebRTC H.264 frames, decodes to JPEG via canvas, sends via `printer:sendCameraFrame`. Fluidd's `/snapshot` and `/stream` endpoints read `state.latestCameraFrame`.
- **OrcaSlicer workaround**: CLI never exits on Windows — `slicer:slice` spawns it, polls for output file stability, then kills it.
- **Profile merging**: user OrcaSlicer profiles lack a `type` field required by the CLI. `mergeUserProfile()` in `ipc/slicer.js` merges them with the inherited system base profile into a temp file before slicing.
- **Firebase**: Firestore is accessed entirely from the renderer (`renderer/firebase-sync.js`). The main process only handles auth token acquisition. Real-time listeners cover `tasks/projects/purchases/schedule/todos/archived_projects` (each replaces the local array → preserves project **order**). **Settings sync is selective**: a dedicated `settings` listener merges only a whitelist of shared keys (`projectGroups`, `categories`, `noteSortMode/ColorMode/TertiarySort`, `calendarFeeds`, `linkedAccounts`, `alarms`, `ecosystem`) so **project groups + tree order + the Ecosystem tree propagate across devices** (an `ecosystem` change fires an `ecosystem-changed` event) without clobbering device-local settings (printer, installed utilities, hotbar layout, git repos, `localTheme`/`splitLayout`). The whole settings doc is still *uploaded*; only those keys are *downloaded*.
- **⚠️ `window.prompt()` does NOT work in Electron** — it silently returns `null`, so any feature relying on it does nothing. Use a custom modal instead (see `#modal-group` / `ModalManager`). `alert()` and `confirm()` *do* work but are unthemed native dialogs. (Note: `file-viewer.js` and `wifi-checker.js` still use `prompt()` and are affected.)
- **Themed confirm**: prefer `window._showConfirm({ title, message, confirmText, danger })` (returns `Promise<boolean>`, backed by `#modal-confirm`) over native `confirm()` for in-app dialogs — it matches the theme and supports a danger style. (Several older confirms still use native `confirm()`.)
- **⚠️ Outlook sync can pop a native "Create New Profile" dialog**: `ipc/outlook.js` instantiates the `Outlook.Application` COM object, which makes classic Outlook show its mail-profile dialog when **no profile exists** (PowerShell `-NonInteractive` can't suppress it — Outlook is a separate process). `outlook.js` guards against this by checking the registry for any configured profile first and bailing out (`[]`) if none. The sync runs on startup + every 30 min (`app.js`).
- **Renderer globals** (no imports/modules — everything is a global loaded via `<script>` tags in `index.html`, order matters): `dataManager`, `viewRenderer`, `modalManager`, `firebaseSync`, `engineeringUtilities`; helpers `escapeHtml`, `assignRainbowColors`, `resolveAutoColor`, `formatDateShort`, `isOverdue`, `getStickyColors`; constants `DAYS`, `PRIORITY_COLORS`, `CATEGORY_LABELS`, `PROJECT_CATEGORY_COLORS`, `APP_CATEGORIES`/`DEFAULT_CATEGORIES`.
- **Re-render batching**: data-change events (`tasks-changed`, `projects-changed`, …) are coalesced by `scheduleRender({sidebar, dots})` into one `requestAnimationFrame` rebuild — fire the event, don't re-render by hand.
