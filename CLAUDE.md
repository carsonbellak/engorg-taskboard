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

## 🚀 Submitting changes (push / contribute) — use the script, not raw git

This install directory is **not a git checkout**, so don't try to `git commit`/`push`
from here. When the user asks to "push", "submit", or "contribute" changes, use the
self-contained CLI:

```bash
node submit-changes.js --list          # safe: shows the real change set, commits nothing
node submit-changes.js -m "<message>"  # commit + push to main (owner/collaborator)
node submit-changes.js -m "..." --pr   # push to a branch and print a PR-compare link
```

The script keeps a cached clone at `~/.engorg-submit/<repo>`, mirrors your changed
source files into it (git normalizes CRLF↔LF so only real edits show), commits, and
pushes. It is **update-only** — it never deletes repo files the install doesn't ship.
Always run `--list` first to confirm the change set. Full details: `CONTRIBUTING.md`.
The in-app equivalent (for non-maintainers) is Settings → Contribute → "Submit Changes…"
(`ipc/contribute.js`), which forks + opens a PR via GitHub sign-in.

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
| `ipc/github.js` | `github:*` — Linked-account GitHub. PAT encrypted at rest via `safeStorage` in `GITHUB_TOKEN_FILE` (`appdata/github.json`), decrypted only in main, never sent to renderer. `github:fetchActivity` lists owned repos (sorted by pushed) and their recent commits → cached by the renderer in `settings.gitActivity` for the **Timeline**. |
| `ipc/files.js` | All `files:*` handlers — readdir, read/write, rename, delete, search, watch, KiCad SVG/GLB export |
| `ipc/git.js` | `git:status`, `git:stage`, `git:unstage`, `git:commit`, `git:diff`, `git:isRepo` |
| `ipc/auth.js` | `auth:googleSignIn` — opens child BrowserWindow to hosted auth page, polls for token |
| `ipc/printer.js` | `printer:apiGet/Post`, `printer:uploadFile/FileData`, `printer:webrtcOffer`, `printer:sendCameraFrame`, `printer:selectFile`, `printer:setEnabled` |
| `ipc/slicer.js` | `slicer:selectModel`, `slicer:getProfiles`, `slicer:slice` — OrcaSlicer CLI integration with profile merging |
| `ipc/email.js` | All `email:*` handlers — IMAP (imapflow) receive + SMTP (nodemailer) send. App passwords encrypted at rest via Electron `safeStorage`; decrypted only in main, never sent to renderer. One pooled IMAP connection per account. |
| `ipc/kicad-importer.js` | All `kicad:*` handlers — KiCad library importer (port of `kicadImporter.py`). Staged: `extractZips` (dependency-free unzip via `tar`/`Expand-Archive`), `digikeyLookup` (OAuth2 client-credentials → metadata via global `fetch`), `addStepFile`, `writeLibrary` (regex s-expr manipulation). DigiKey creds from `config.js` defaults or `settings.json` override. |
| `ipc/utility-store.js` | All `store:*` handlers — Utility Store. Fetches catalog JSON from GitHub (`UTILITY_STORE_CATALOG_URL`); downloads remote utility HTML to `appdata/utilities/<id>/`. Remote utilities render in a sandboxed iframe (no Node/IPC) — never run with app privileges. |

### Renderer modules (`renderer/`)

| File | Purpose |
|------|---------|
| `app.js` | Root — initializes all modules, handles tab switching |
| `taskboard.js` | Day-of-week task board UI |
| `data.js` | Data layer — wraps `window.api.loadData/saveData`, in-memory cache |
| `firebase-sync.js` | Firestore real-time sync, offline persistence |
| `firebase-config.js` | Firebase project credentials |
| `printer.js` | Printer tab — Moonraker status, camera WebRTC, print controls |
| `slicer.js` | Slicer tab — model select, profile picker, slice and send |
| `cad-viewer.js` | 3D model viewer — STL/OBJ/GLTF via Three.js, KiCad SVG/GLB via kicad-cli |
| `file-viewer.js` | File browser — directory tree, text/binary viewer, batch rename, content search, and **Git integration**: branch indicator, commit panel, per-file status badges (incl. conflicts), and a right-click git menu (status-aware Stage/Unstage, View Diff modal, Discard, **Open in Git Manager** → `gitManager.openRepo`). Badges/menu read `window.api.git.status` (cached as `gitStatus`/`gitFileMap`). |
| `settings.js` | Settings — persists to `settings.json`. Opens as a **popup modal** (`#settings-modal` in `index.html`; the gear button calls `window.openSettings()` which renders into `#view-settings` and shows the overlay — Esc / backdrop / × closes). It is no longer a full view. **Tabbed layout** (`renderSettings` builds a left-rail `.settings-nav` + `.settings-tab-panel` sections: Appearance / General / Linked Accounts / Calendar / Integrations / Mobile & Sharing / Data / About; active tab kept in module var `_settingsTab`). **Linked Accounts hub** (`refreshLinkedAccounts`) — unified cards for Cloud Sync (Google/Firebase), GitHub, and Email (Gmail/Outlook/IMAP via `api.email.listAccounts`). The account *registry* (`settings.linkedAccounts`) syncs across devices; secrets stay device-local (OS keystore), so cards can show "Reconnect on this device". |
| `stats.js` | Stats/analytics tab |
| `noteboard.js` | Sticky notes board |
| `timers.js` | Countdown timers |
| `email.js` | Email hub tab — IMAP/SMTP client UI (3-pane: accounts/folders, message list, sandboxed reading pane), compose/reply/forward, account setup. Desktop-only (no PWA equivalent). |
| `engineering.js` | **Engineering Utilities** tab — hosts installable utilities (Printer, Slicer, KiCad Importer + GitHub-installed remote utilities) under one tab with a sub-nav + **Utility Store**. Built-in registry + `installedUtilities` (settings.json) install state. Desktop-only. |
| `kicad-importer.js` | KiCad Importer utility UI — ZIP picker, options, progress/log, part-selection & missing-STEP modals. Mounts inside the Engineering Utilities tab. Desktop-only. |
| `purchasing.js` | Purchase tracking |
| `stats.js` | Stats/analytics tab |
| `updates.js` | In-app update checker — scans canonical repo for newer commits, prompts to update |
| `theme-fx.js` | Theme/visual-style engine (the many `body.style-*` themes in `styles.css`) |
| `titlebar.js` | Custom window titlebar (frameless window controls) + the visible **File/Edit/View/Window** menu (the native menu is hidden). Items support `action` (→ `api.menu.action`), `onClick` (local), and `submenu` (right-hand flyout). The **View** menu's "Split Window" and "Set Theme" submenus are built from `window.windowSplit`. |
| `window-split.js` | **Split Window** + **local theme**. Loaded *before* app.js. Splits the window into a gap-less grid of same-origin `index.html?embedded=1` `<iframe>` app instances — layouts `2v/2h/3v/3h/4q/4v/4h` (vertical=columns, horizontal=rows), `single` to restore. Layout + per-pane themes persist in **localStorage** (`splitLayout`), never synced. When this window is the split *shell* it **hides its own titlebar/header** (so the only chrome is each pane's bar) and shows a small floating min/max/close cluster (`#split-winctrls`, with a drag-grab strip); app.js bails early (`windowSplit.isShell()`) so no data/Firebase/auth-gate loads behind the panes. Embedded panes are full apps but suppress background services. **Layout changes from a pane** post to the shell (`split-setlayout`) since only the top window can re-tile. **View → Set Theme** sets a display-only theme: top window → `localStorage.localTheme`; a pane → `postMessage` (`split-theme`, persisted per pane). `settings.js` `initTheme()` honors `windowSplit.startupThemeOverride()`. Desktop-only. |
| `wifi-checker.js` | Wi-Fi / network diagnostics utility |
| `uart-bridge.js` | Serial/UART bridge utility |
| `git-manager.js` | **Git Manager** utility — GitHub-Desktop-style git client: repo + branch dropdowns, Fetch/Pull/Push/Sync, stage checkboxes, commit box (with **amend**), History + diff viewer with a **right-click commit context menu** (checkout/branch/tag/cherry-pick/revert/reset/copy-SHA), **conflict resolution** (ours/theirs/edit/continue/abort banner), stash/tags/remotes **manager dialogs**, optional **auto-fetch** (5 min), one-click **Upload folder** / **Download folder**, plus a raw git terminal. Tracked repos persist in `settings.json` (`gitRepos`, `gitLastRepo`); auto-fetch toggle in `gitAutoFetch`. Mounts in the Engineering Utilities tab via the `git-manager` BUILTIN. Backed by `window.api.git.*`. Desktop-only. |
| `components/add-note-modal.js` | **`ModalManager`** — owns ALL modals: add/edit note, schedule event, **project**, category. (Despite the filename, this is the central modal controller, not just notes.) |
| `components/sticky-note.js` | Sticky-note card rendering/helpers |
| `components/project-manager.js` | Stub only — project CRUD actually lives in `ModalManager` (`add-note-modal.js`) |
| `components/tracking-utils.js` | Shared tracking helpers |

> **Project groups + Projects tab** (see "Views & Navigation" below) are wired across `app.js` (sidebar groups, drag-to-group, group modal), `taskboard.js` (`renderProjectSlates`), `data.js` (group CRUD), and `index.html` (`#modal-group`, `data-view="projects"`).

### Data files (`appdata/`)

Stored in `C:\Assistant\appdata\`. Allowed filenames are whitelisted in `ipc/data.js`:
`tasks.json`, `projects.json`, `purchases.json`, `settings.json`, `schedule.json`, `todos.json`, `archived_projects.json`

---

## Data Model

All data is loaded/cached by `renderer/data.js` (`DataManager`, the global `dataManager`). Each collection saves locally **and** uploads to Firestore via `firebaseSync.upload(...)`. IDs are generated by `_genId(prefix)` (`note_`, `proj_`, `grp_`, `sch_`, `pur_`, `todo_`).

| Collection | File | Key fields |
|------------|------|-----------|
| `tasks` (sticky notes) | `tasks.json` | `id, title, projectId, day, status` (`backlog`/`inProgress`/`review`/`done`), `completed`, `priority` (High/Medium/Low), `category`, `dueDate`, `checklist[]`, `createdAt/modifiedAt/completedAt`, `statusHistory[]`. **Invariant:** `status === 'done'` ⇔ `completed === true` (healed on load and in `addTask`/`updateTaskStatus`). |
| `projects` | `projects.json` | `id, name, color` (auto-assigned rainbow via `assignRainbowColors`), `categories[]`, **`groupId`** (null = ungrouped), `createdAt`. |
| `projectGroups` | inside `settings.json` | `id, name, color, collapsed, archived, archivedAt, createdAt`. Managed by `addProjectGroup / updateProjectGroup / deleteProjectGroup / setProjectGroup / getProjectGroups / getActiveProjectGroups / archiveProjectGroup / unarchiveProjectGroup`. **Delete** ungroups its projects (never deletes projects). **Archive** archives the group *and* all its member projects (`archived:true` on the group; members move to `archivedProjects` with `groupId` preserved). `getActiveProjectGroups()` = `!archived` (used by active sidebar + Projects overview). Stored in settings so it syncs everywhere for free. |
| `archivedProjects` | `archived_projects.json` | A project plus bundled `_tasks/_scheduleItems/_todos/_purchases` and `archivedAt`. Archive/unarchive moves data in/out of the active collections. |
| `scheduleItems` (calendar events) | `schedule.json` | `id, title, projectId, date, day, startTime, endTime, completed, source` (`outlook`/ICS), `outlookId`/`extId` for dedup. |
| `purchases` | `purchases.json` | `id, item, projectId, status` (`toPlace`/…), `trackingNumber, carrier` (auto-detected), `cost, quantity`. |
| `todos` | `todos.json` | `id, projectId, done`. |
| `settings` | `settings.json` | `activeView, theme, categories[], projectGroups[], hiddenTabs[], hotbarUtilities[], tabOrder[], tabsLocked, printerEnabled, autoCheckUpdates`, DigiKey/utility overrides, `gitRepos`/`gitLastRepo`/`gitAutoFetch` (Git Manager), `gitActivity[]`/`gitLastSync` (cached GitHub commits → Timeline), `linkedAccounts` (synced registry of linked accounts — `{ github:{username}, email:[{email,name,provider}] }`; secrets are NOT here, they stay device-local), etc. (Local-only `localTheme`/`splitLayout` live in **localStorage**, not here.) |

---

## Views & Navigation (`renderer/app.js`)

- **Header tabs** (`.header-tab[data-view=...]` in `index.html`) map to `#view-<name>` panels: `notes`, `projects`, `calendar`, `email`, `timeline`, `timers`, `board`, `purchasing`, `stats`, `files`, `engineering`. `viewRenderer.currentView` tracks the active one; `renderCurrentView()` dispatches. Tabs are show/hide-able and reorderable (the "hotbar" — `hiddenTabs`/`tabOrder`/`hotbarUtilities` in settings; editable in Settings → `MAIN_TABS` in `settings.js`).
- **Sidebar** = project filter + day picker. `viewRenderer.selectedProject` is `'all'`, a project id, or `'all-archived'`. **"All Projects" is a pure filter** (shows every project's items in the current view) — it does *not* switch views.
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

### GitHub (Linked Accounts → Timeline)
- `github:status()` → `{ connected, username, name }` (never returns the token)
- `github:connect(token)` → validates via `/user`, encrypts+stores the PAT → `{ username, name }` or `{ error }`
- `github:disconnect()` → deletes the stored token
- `github:fetchActivity(days=90)` → `{ commits: [{ sha, repo, message, date, url, author }] }` — commits on **owned** repos within the window. The renderer (`app.js` `syncGitHub`, on startup + every 30 min) caches the result in `settings.gitActivity` (+ `gitLastSync`); `taskboard.js` `renderTimeline()` renders them as `git-commit` items (only in the "All Projects" view; click opens the commit).

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
- **Firebase**: Firestore is accessed entirely from the renderer (`renderer/firebase-sync.js`). The main process only handles auth token acquisition.
- **⚠️ `window.prompt()` does NOT work in Electron** — it silently returns `null`, so any feature relying on it does nothing. Use a custom modal instead (see `#modal-group` / `ModalManager`). `alert()` and `confirm()` *do* work but are unthemed native dialogs. (Note: `file-viewer.js` and `wifi-checker.js` still use `prompt()` and are affected.)
- **Themed confirm**: prefer `window._showConfirm({ title, message, confirmText, danger })` (returns `Promise<boolean>`, backed by `#modal-confirm`) over native `confirm()` for in-app dialogs — it matches the theme and supports a danger style. (Several older confirms still use native `confirm()`.)
- **⚠️ Outlook sync can pop a native "Create New Profile" dialog**: `ipc/outlook.js` instantiates the `Outlook.Application` COM object, which makes classic Outlook show its mail-profile dialog when **no profile exists** (PowerShell `-NonInteractive` can't suppress it — Outlook is a separate process). `outlook.js` guards against this by checking the registry for any configured profile first and bailing out (`[]`) if none. The sync runs on startup + every 30 min (`app.js`).
- **Renderer globals** (no imports/modules — everything is a global loaded via `<script>` tags in `index.html`, order matters): `dataManager`, `viewRenderer`, `modalManager`, `firebaseSync`, `engineeringUtilities`; helpers `escapeHtml`, `assignRainbowColors`, `resolveAutoColor`, `formatDateShort`, `isOverdue`, `getStickyColors`; constants `DAYS`, `PRIORITY_COLORS`, `CATEGORY_LABELS`, `PROJECT_CATEGORY_COLORS`, `APP_CATEGORIES`/`DEFAULT_CATEGORIES`.
- **Re-render batching**: data-change events (`tasks-changed`, `projects-changed`, …) are coalesced by `scheduleRender({sidebar, dots})` into one `requestAnimationFrame` rebuild — fire the event, don't re-render by hand.
