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
| `file-viewer.js` | File browser — directory tree, text/binary viewer, Git panel, batch rename, content search |
| `settings.js` | Settings tab — persists to `settings.json` |
| `stats.js` | Stats/analytics tab |
| `noteboard.js` | Sticky notes board |
| `timers.js` | Countdown timers |
| `email.js` | Email hub tab — IMAP/SMTP client UI (3-pane: accounts/folders, message list, sandboxed reading pane), compose/reply/forward, account setup. Desktop-only (no PWA equivalent). |
| `engineering.js` | **Engineering Utilities** tab — hosts installable utilities (Printer, Slicer, KiCad Importer + GitHub-installed remote utilities) under one tab with a sub-nav + **Utility Store**. Built-in registry + `installedUtilities` (settings.json) install state. Desktop-only. |
| `kicad-importer.js` | KiCad Importer utility UI — ZIP picker, options, progress/log, part-selection & missing-STEP modals. Mounts inside the Engineering Utilities tab. Desktop-only. |
| `purchasing.js` | Purchase tracking |
| `components/project-manager.js` | Project CRUD modal |
| `components/tracking-utils.js` | Shared tracking helpers |

### Data files (`appdata/`)

Stored in `C:\Assistant\appdata\`. Allowed filenames are whitelisted in `ipc/data.js`:
`tasks.json`, `projects.json`, `purchases.json`, `settings.json`, `schedule.json`, `todos.json`, `archived_projects.json`

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
- `git:status(dirPath)` → `{ branch, files: [{ path, status }], error? }`
- `git:stage(filePath)` → true
- `git:unstage(filePath)` → true
- `git:commit(dirPath, message)` → string output
- `git:diff(filePath)` → string diff
- `git:isRepo(dirPath)` → boolean

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
- **Fluidd camera bridge**: renderer captures WebRTC H.264 frames, decodes to JPEG via canvas, sends via `printer:sendCameraFrame`. Fluidd's `/snapshot` and `/stream` endpoints read `state.latestCameraFrame`.
- **OrcaSlicer workaround**: CLI never exits on Windows — `slicer:slice` spawns it, polls for output file stability, then kills it.
- **Profile merging**: user OrcaSlicer profiles lack a `type` field required by the CLI. `mergeUserProfile()` in `ipc/slicer.js` merges them with the inherited system base profile into a temp file before slicing.
- **Firebase**: Firestore is accessed entirely from the renderer (`renderer/firebase-sync.js`). The main process only handles auth token acquisition.
