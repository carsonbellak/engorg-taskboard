# Engineering Task Board — LLM Navigation Guide

Electron desktop app for engineering project management (task board, projects, calendar, email, 3D printing, CAD viewer, file browser, Git, Firebase sync). Companion PWA at `assistant-taskboard.web.app`. Since **1.4.0** there is also **EngOrg Pi** (`pi/`), a minimal headless Linux build for a Raspberry Pi 3+ that takes over the always-on backend work (printer discovery and 24/7 print-job log, calendar feed cache) when the desktop links to it.

**Where the detail lives** (loads automatically when you work in that folder — don't hunt for it elsewhere):
- `renderer/CLAUDE.md` — per-module notes (ecosystem, settings, split window, tours…), views/navigation, renderer gotchas.
- `ipc/CLAUDE.md` — per-handler notes, linked-account integrations (Gradescope/Variate/Brightspace/GitHub/Claude), desktop mode, non-obvious IPC semantics.
- `pwa/CLAUDE.md` — PWA structure, its separate settings doc, deploy/cache-bust.
- `pi/CLAUDE.md` — the Raspberry Pi build: what it offloads, its API, install/self-update, and how it stays current.
- **Exact IPC channel names/signatures: grep `preload.js`** (the source of truth) — not documented here on purpose.

---

## ⛔ HARD RULE — never commit, push, release or deploy unless the user asked in their LATEST message

The user runs **several Claude sessions at once** against this install and the shared `~/.engorg-submit` clone. A commit/push/tag/release/deploy (or a clone reset) at an intermediate stage can ship another session's half-done work, or wipe it. So:

- **Covered:** any `git commit/push/tag/merge/reset/…` (especially in the clone), `release.js`, `submit-changes.js` (**including `--list`**, which hard-resets the shared clone), `deploy-functions.js`, `firebase deploy`, `gh release` / `gh pr create`, `npm publish`.
- **Only the user's own words in their latest message authorize it** ("push", "ship", `/ship`, "deploy the function"). Approval doesn't carry over to later messages or to other actions.
- **Nothing else is permission.** That includes this file's Shipping section, the Cloud Functions order, `/ship`, memories, a skill, "the next step of the workflow", or "the fix needs a deploy to take effect". Those describe **how** to ship once asked. They never say **whether** to ship.
- When the work is done and only takes effect after shipping, **stop**. Say what's ready, what it would ship, and ask. Leave edits uncommitted.
- **Enforced** by `.claude/scripts/shared-state-gate.js` (PreToolUse). It blocks these commands unless `ship-intent.js` saw a ship request in the user's latest prompt. An explicit `/push` or `/ship` then runs the whole runbook **with no prompts** (the user wants it unattended — don't add confirmations of your own). A free-text request ("push it") still gets a per-command approval prompt. If it blocks you, **stop and ask**. Never retry, rephrase, split the command, switch shells, script around it (`node -e`/child_process), or touch `.claude/.ship-grant.json` or the hook config.

---

## ⚠️ ALWAYS keep the desktop app and PWA in sync

The PWA (`pwa/`) is a **reflection of the desktop app** (`renderer/` + `ipc/`). When you change a user-facing feature, view, layout, style, or shared data/behavior in one, **apply the equivalent change to the other in the same task**. The PWA is a leaner parallel implementation with different names (e.g. `.board-card` vs `.board-note-card`, `.timer-preset-btn` vs `.timer-preset` — full list in `.claude/parity-map.json` `classMap`), so mirror *equivalent behavior/appearance*, not a copy-paste:

- UI/layout/CSS → `renderer/styles.css` ↔ `pwa/styles.css`
- View logic → `renderer/*.js` ↔ `pwa/app.js`
- Data model / business logic (status, completion, filtering, sorting) → keep both in agreement
- `tour.js` is the exception: mirrored **verbatim** (`renderer/tour.js` ≡ `pwa/tour.js`)

Desktop-only (no PWA mirror): Electron main, IPC, OS/file/printer/slicer/serial integrations, Engineering utilities, email, the Raspberry Pi link. When in doubt, sync it.

---

## 🍓 Keep the Raspberry Pi build current

`pi/` is a headless Node service (no Electron, no UI). It runs the **desktop's own Electron-free modules**, listed in `pi/manifest.json`: `config.js`, `state.js`, `moonraker.js`, `core/`. They're bundled by `build-pi.js` and never forked, so a desktop fix reaches the Pi automatically. Your side of that:
- **Code in a manifest file must stay Electron-free.** Shared logic goes in `core/`; the `ipcMain` wrapper stays in `ipc/` (example: `ipc/calendar.js` → `core/ics.js`). If a Pi feature needs more desktop code, move it into `core/` and add it to the manifest.
- **Changed a Pi `/api/*` shape?** Bump `PROTOCOL` in `core/pi-protocol.js`, which holds the ports, header and asset name shared by both sides.
- **Run `node build-pi.js --check`** after touching a manifest file (the hook prints a **PI POINTER**). The pre-ship guard **blocks `release.js`** if it fails.
- Releases ship the Pi too: CI job `pi` attaches `EngOrg-Pi.tar.gz` to each `vX.Y.Z` tag, and linked Pis self-update to it. The desktop also asks an outdated Pi to update. Details: `pi/CLAUDE.md`.

---

## 🚀 Shipping — "push" / "ship" / "submit changes" ⇒ `/ship` (alias `/push`)

**Only when the user's latest message asks for it** (hard rule above). Everything below is *how*, never *whether*.

`/ship` holds the full runbook. In short: parity check → `node submit-changes.js --list` (safe preview, CRLF-normalized) → `node release.js patch -m "<summary>"` (`minor`/`major`/`X.Y.Z` when warranted). The tag triggers `.github/workflows/release-installer.yml` (installer + Android APK + Raspberry Pi bundle `EngOrg-Pi.tar.gz`). **Don't poll CI.** **1.4.0** (the Pi release) is cut with `node release.js 1.4.0` (or `minor`). `package.json` deliberately stays at the previous version until then, because `release.js` refuses an unchanged version.

- This install dir is **not a git checkout**. Never `git commit`/`push` the `~/.engorg-submit/…` clone, never bare `submit-changes.js -m`, no manual tag surgery — even for `mobile-ink/` or `.github/workflows/` edits, and even if the release sweeps up unrelated WIP (acceptable). Only if the user *explicitly* asks for a non-release push: `node submit-changes.js -m "…"` (`--pr` for a branch + PR link).
- **The PWA does NOT auto-deploy** — the `FIREBASE_SERVICE_ACCOUNT` secret is not set, so CI's `pwa` job skips. After any release touching `pwa/`, deploy it yourself (see `pwa/CLAUDE.md`; bump `CACHE_NAME` in `pwa/sw.js` *before* releasing).
- **Cloud Functions** (`functions/`, exists only in the clone) are never shipped by a release. Editing them in the clone is fine. **Then stop and tell the user the edit is uncommitted and not deployed.** Only if the user's latest message asks to ship or deploy it, do this in order: commit + push that file to `main` from the clone → `node deploy-functions.js [name]` → `release.js`. This order is a *procedure*, not standing permission. Warn the user that any release or `submit-changes.js` run (from **any** session, even `--list`) does `reset --hard` + `clean -fd` on the clone, which wipes uncommitted function edits.
- `mobile-ink/` changed → compile-check at `C:\androidbuild` first (memory: android-local-build).
- Notable feature → add a `WHATS_NEW` entry in `renderer/onboarding.js`.
- `submit-changes.js` is update-only (never deletes repo files the install doesn't ship). Contributors without push access use Settings → Contribute (`ipc/contribute.js`, fork + PR). See `CONTRIBUTING.md`.

---

## 🤖 Dev automation (`.claude/`)

- **Hooks:** editing a parity-relevant `renderer/` file flags a pending PWA mirror (editing the PWA side clears it; `node .claude/scripts/parity-ack.js <file>` if genuinely desktop-only). Prompt intent → points at the matching agent. `release.js` is **blocked** while mirrors are pending, or if `node build-pi.js --check` fails. Editing a file the Pi bundle ships prints a **PI POINTER**.
- **Agents:** `pwa-mirror`, `ipc-feature`, `integration-builder`, `utility-builder`, `parity-auditor`. **Commands:** `/ship` (`/push`), `/mirror`, `/add-ipc`, `/new-integration`, `/new-utility`, `/parity-check`.
- **When to delegate:** a subagent starts cold (reloads this file, re-reads the code you already have open). Delegate multi-file recipes — a new IPC channel, integration, utility, or a large mirror. **Mirror a small change (a CSS rule, one function) inline** using `parity-map.json`'s class map.
- `.claude/parity-map.json` = source of truth for desktop↔PWA pairs + class translations — keep it current. Reference: `.claude/AUTOMATION.md`.

---

## File Map

**Root**
| File | Purpose |
|------|---------|
| `main.js` | Electron entry — bootstrap, windows (incl. desktop-mode window), registers every `ipc/*.js`, single-instance lock |
| `config.js` | **All constants** (paths, IPs, ports, slicer paths, DigiKey defaults, store/Variate URLs, `CONTRIB_REPO`). Change hardcoded values here. |
| `state.js` | Shared mutable main-process state (`latestCameraFrame`, `fluiddServer`, `moonrakerUrl`, `enginkMirror`) |
| `preload.js` | `window.api` via contextBridge — **add new channels here**; the IPC reference |
| `fluidd-server.js` | :8765 HTTP/WS proxy — Fluidd UI, Moonraker proxy, webcam injection, OrcaSlicer OctoPrint-compat endpoints |
| `moonraker.js` | Moonraker URL self-healing — printer is on DHCP, so the live URL is `state.moonrakerUrl` (LAN /24 scan if `MOONRAKER_URL` is unreachable). Use it, not the config constant. |
| `release.js` · `submit-changes.js` · `deploy-functions.js` | Shipping (above) |
| `build-installer.js` · `installer.iss` · `build-icon.js` | Inno Setup installer build · `.ico` generator |
| `build-pi.js` | Raspberry Pi bundle → `dist/EngOrg-Pi.tar.gz` (`--check` = stage + Electron guard + self-test only). See `pi/CLAUDE.md`. |

**`core/`**: **Electron-free** modules shared by desktop main and the Pi build: `ics.js` (ICS fetch/parse; `ipc/calendar.js` + `email.js` use it) · `pi-protocol.js` (Pi ports `8780`/`8781`, `PROTOCOL`, discovery probe, asset name).

**`pi/`**: EngOrg Pi service: `server.js` (HTTP API + CLI + `--selftest`), `lib/` (`printer-watch`, `calendar-cache`, `updater`, `auth`, `discovery`, `runtime-config`, `store`, `sysinfo`), `install.sh`, `engorg-pi.service`, `manifest.json`. Details: `pi/CLAUDE.md`.
| `gradescope.js` | Standalone CLI scraper (dev tool; the app uses `ipc/gradescope.js`) |

**`ipc/`** — one module per namespace, `module.exports = function register(getMainWindow)`. Details: `ipc/CLAUDE.md`.
`data` (load/save whitelist, shell, dialogs) · `files` · `git` · `github` · `gradescope` · `variate` · `calendar` (ICS feeds) · `outlook` · `email` (+`oauth` for Microsoft) · `claude` (Anthropic key, syllabus import) · `auth` (Google) · `printer` · `slicer` · `print-history` · `kicad-importer` · `utility-store` · `engink-mirror` · `file-merger` · `ftdi` (+`ftdi_helper.py`) · `uart-programs` · `wifi-checker` · `spell` · `os-theme` · `desktop-mode` · `share` (Share utility: Downloads save) · `window` (titlebar controls) · `updates` · `release` (owner-only in-app release) · `contribute` · `pi-link` (Raspberry Pi companion: discover/pair/status/update; feeds `calendar.js` + `moonraker.js`)

**`renderer/`** — globals loaded by `<script>` tags in `index.html` (order matters, no imports). Details: `renderer/CLAUDE.md`.
Core: `app.js` (root, tabs, sync loops) · `data.js` (`dataManager`) · `firebase-sync.js` · `taskboard.js` (`viewRenderer`) · `components/add-note-modal.js` (`ModalManager` — owns **all** modals) · `settings.js` (popup modal) · `titlebar.js` · `window-split.js`.
Views/features: `ecosystem.js` · `noteboard.js` · `timers.js` · `email.js` · `purchasing.js` · `stats.js` · `file-viewer.js` · `briefings.js` · `syllabus-import.js` · `print-tracker.js` · `share.js` (Share utility, also runs the app-wide inbox listener) · `onboarding.js` + `tour.js` · `spellcheck.js` · `theme-fx.js` · `updates.js`.
Engineering utilities (desktop-only): `engineering.js` (registry) · `printer.js` · `slicer.js` · `cad-viewer.js` · `kicad-importer.js` · `git-manager.js` · `uart-bridge.js` · `wifi-checker.js` · `engink-mirror.js` · `file-merger.js`.

**`pwa/`** — `app.js` (whole app), `styles.css`, `tour.js`, `sw.js`, `index.html`. Details: `pwa/CLAUDE.md`.

### Data files (`C:\Assistant\appdata\`)
`data:save` whitelist (`ALLOWED_FILES` in `ipc/data.js`): `tasks.json`, `projects.json`, `purchases.json`, `settings.json`, `schedule.json`, `todos.json`, `archived_projects.json`, `print_history.json`.
Written directly by main (outside the whitelist, device-local): `print_archive/`, `gradescope_attachments/`, `uart_programs/`, `spell_user.json`, `github.json`, `gradescope.json`, `variate.json`, `desktop_mode.json`, `pi_link.json` (Pi host/id + `safeStorage` token), other linked-account cred files.

---

## Data Model (`renderer/data.js` → global `dataManager`)

Each collection saves locally **and** uploads via `firebaseSync.upload(...)`. IDs: `_genId(prefix)` → `note_`, `proj_`, `grp_`, `sch_`, `pur_`, `todo_`.

| Collection | File | Key fields / rules |
|------------|------|-----------|
| `tasks` (sticky notes) | `tasks.json` | `id, title, projectId, day, status` (`backlog`/`inProgress`/`review`/`done`), `completed`, `priority` (High/Medium/Low), `category`, `dueDate`, `checklist[]`, `attachments[]`, `source` (`gradescope`/`variate`/`brightspace`), `createdAt/modifiedAt/completedAt`, `statusHistory[]`. **Invariant: `status==='done'` ⇔ `completed===true`** (healed on load and in `addTask`/`updateTaskStatus`). A note with a `dueDate` **is** its calendar entry — never also create a `scheduleItem` for it. |
| `projects` | `projects.json` | `id, name, color` (auto rainbow via `assignRainbowColors`), `categories[]`, `groupId` (null = ungrouped), `workSchedule[]` (`{day,start,end}` recurring blocks — rendered as synthetic calendar events by `ViewRenderer._getWorkBlocks`, **never stored as scheduleItems**, auto-complete once their end time passes), class links `gradescopeCourseId`/`variateGroupId`/`courseShort`/`courseCode`. |
| `projectGroups` | in `settings.json` | `id, name, color, collapsed, archived, archivedAt`. Delete ⇒ ungroups members (never deletes projects). Archive ⇒ archives group **and** members (`groupId` kept). Stored in settings so it syncs. |
| `archivedProjects` | `archived_projects.json` | Project + bundled `_tasks/_scheduleItems/_todos/_purchases` + `archivedAt`. |
| `scheduleItems` | `schedule.json` | `id, title, projectId, date, day, startTime, endTime, completed, source`, `outlookId`/`extId` for dedup. Imported via `importExternalEvents(events, { source, prune })`. |
| `purchases` | `purchases.json` | `id, item, projectId, status` (`toPlace`/…), `trackingNumber, carrier` (auto-detected), `cost, quantity`. |
| `todos` | `todos.json` | `id, projectId, done`. |
| `settings` | `settings.json` | Everything else (theme, hotbar `hiddenTabs/tabOrder/hotbarUtilities/tabsLocked`, note sort/color modes, `alarms[]`, `linkedAccounts` registry, `ecosystem`, `gitRepos`, `gitActivity`, utility installs…). **Secrets never live here** — they stay device-local in main (`safeStorage`). `localTheme`/`splitLayout` live in **localStorage**. |

**Firebase sync:** renderer-only (`firebase-sync.js`; main just gets auth tokens). Real-time listeners replace whole arrays for `tasks/projects/purchases/schedule/todos/archived_projects` (preserves order). **Settings sync is selective:** the full doc is uploaded, but only a whitelist is downloaded — `projectGroups, categories, noteSortMode/ColorMode/TertiarySort, calendarFeeds, linkedAccounts, alarms, ecosystem`. Add a key there to make a new setting sync; anything else stays device-local. Countdown timers live in the top-level Firestore `timers` collection. The PWA's own prefs are a separate `pwaSettings` doc (see `pwa/CLAUDE.md`).

---

## Key Constants (`config.js`)

| Constant | Value | Controls |
|----------|-------|---------|
| `DATA_DIR` | `C:\Assistant\appdata` | All local JSON storage |
| `MOONRAKER_URL` | `http://192.168.0.130:7125` | K1C printer — seed only; live URL is `state.moonrakerUrl` (`moonraker.js`) |
| `FLUIDD_PORT` / `FLUIDD_DIR` | `8765` / `tools/fluidd` | Fluidd proxy |
| `ORCASLICER_EXE` / `_RESOURCES` | `%ProgramFiles%\OrcaSlicer\…` | Slicer exe + Creality profiles |
| `SLICER_OUTPUT_DIR` | `appdata/slicer_output` | G-code + merged-profile temp files |
| `ENGINK_MIRROR_PORT` / `ENGINK_DISCOVERY_PORT` | `8770` / `8771` | EngInk LAN mirror (WS / UDP) |
| `PI_LINK_FILE` | `appdata/pi_link.json` | Raspberry Pi link (Pi ports `8780`/`8781` live in `core/pi-protocol.js`, shared with the Pi) |
| `VARIATE_APP_URL` / `VARIATE_API_URL` | Purdue StudioKit | Point Variate at another school |
| `DIGIKEY_CLIENT_ID` / `_SECRET` | defaults | KiCad importer; overridable in Settings |
| `UTILITY_STORE_CATALOG_URL` | raw GitHub URL | Utility Store catalog |
| `CONTRIB_REPO` | owner/repo | Canonical repo for updates/contribute/in-app release |

---

## How to Add a Feature

1. **Main process** → handler in an `ipc/*.js` module (or a new `ipc/myfeature.js` exporting `register(getMainWindow)`).
2. **Register** → `require` + call it in `main.js`.
3. **Expose** → wrapper in the right `preload.js` namespace.
4. **Renderer** → existing module, or new `renderer/myfeature.js` + a `<script>` tag in `renderer/index.html` (order matters) + wire into `app.js`.
5. **New JSON file** → add to `ALLOWED_FILES` in `ipc/data.js`; if it should sync, wire `data.js` + `firebase-sync.js`.
6. **User-facing?** → mirror in `pwa/` (parity rule) and add to `.claude/parity-map.json` if it's a new pair.

New engineering utility → `/new-utility`. New linked account → `/new-integration` (template in `ipc/CLAUDE.md`).

---

## Architecture Notes & Gotchas

- **Context isolation:** renderer has no Node. Everything OS/file/network goes `window.api` (preload) → IPC → main.
- **Secrets stay in main**, encrypted with `safeStorage`; never send tokens/passwords to the renderer.
- **Single instance** (`main.js` `acquireSingleInstance`): a second launch focuses the running app. Two instances on one Chromium profile ⇒ the second can't open Local Storage/IndexedDB and boots signed-out. `updates:restart` relaunches with `--relaunched` (waits ~5 s for the lock).
- **⚠️ Never force-kill the running app** (`Stop-Process -Force` / `taskkill /F`) — it corrupts Local Storage/IndexedDB (lost sign-in, onboarding, local theme). Close gracefully (window ✕ or `WM_CLOSE` to its `Chrome_WidgetWin_1` window), relaunch with `launch.vbs`. Don't launch/screenshot the app to verify UI — the user does visual QA.
- **⚠️ Subframe preload:** `nodeIntegrationInSubFrames: true` (so Split Window iframes get `window.api`) runs the preload in *every* subframe, so `preload.js` only exposes `api` when `location.pathname` ends with `/renderer/index.html`. Keeps sandboxed remote-utility/email iframes privilege-free — a new trusted frame must load `renderer/index.html` or the gate must change.
- **Fluidd camera bridge:** renderer decodes WebRTC H.264 → JPEG via canvas → `printer:sendCameraFrame`; Fluidd's `/snapshot`/`/stream` read `state.latestCameraFrame`.
- **OrcaSlicer CLI never exits on Windows** — `slicer:slice` polls for output-file stability, then kills it. User profiles lack `type`, so `mergeUserProfile()` merges them with the inherited system profile into a temp file first.
- **Outlook COM can pop a native "Create New Profile" dialog** when no mail profile exists (can't be suppressed) — `ipc/outlook.js` checks the registry first and returns `[]`. Keep that guard.
- **`window.prompt()` returns `null` in Electron** — use a modal (`ModalManager` / `#modal-group`). `file-viewer.js` and `wifi-checker.js` still call it (broken). Prefer `window._showConfirm({ title, message, confirmText, danger })` over native `confirm()`.
- **Re-renders are batched:** fire the data-change event (`tasks-changed`, `projects-changed`, …) and let `scheduleRender({sidebar, dots})` rebuild in one rAF — don't re-render by hand.
