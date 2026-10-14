# pwa/ — companion PWA notes

A leaner parallel implementation of the desktop app, hosted on Firebase Hosting (project `assistant-taskboard`, `public: "pwa"`). **Parity rule** (root CLAUDE.md): mirror equivalent behavior/appearance of user-facing desktop changes; class-name translations are in `.claude/parity-map.json` `classMap`.

## Navigating `app.js` (~200 KB — don't read it whole)

It is one file split by banner comments. Grep `// ===================== <NAME>` to jump to a section:
`NATIVE INK APP SETTINGS BRIDGE` · `iOS "ADD TO HOME SCREEN" BANNER` · `THEMES` · `PWA-LOCAL SETTINGS` · `PUSH NOTIFICATIONS` · `STATE` · `AUTH` · `FIRESTORE LISTENERS` · `SAVE TO FIRESTORE` · `NAVIGATION` · `FILTERS` · `RENDER` · `NOTES VIEW` · `BOARD VIEW` · `NOTE DETAIL` · `TIMELINE VIEW` · `CALENDAR VIEW` (sub-sections `── MONTH/WEEK/DAY/AGENDA VIEW`) · `SCHEDULE CRUD` · `PURCHASES VIEW` · `PURCHASE CRUD` · `STATS VIEW` · `ADD/EDIT NOTE` · `PRINTER VIEW` · `USER MENU` · `NEW PROJECT` · `SHEETS` · `PWA SETTINGS SHEET` · `TIMERS VIEW` (`── PWA Alarms/Stopwatch/always-on watcher`) · `ECOSYSTEM`.

**EngInk is Android-only.** There is no web ink page. The `ink` nav tab exists only inside the Android shell (`NATIVE_AUTH`): it navigates to `ink.html`, which `mobile-ink` `MainActivity` intercepts to launch native ink, so that page is never served. In a browser the tab is removed. Keep the `NATIVE INK APP SETTINGS BRIDGE`, because the Android app uses it.

Desktop counterparts worth knowing: sticky-note palette + `sourceLogoSvg` mirror `renderer/components/sticky-note.js`; `projectOptionGroups()` renders project groups as `<optgroup>`s; `mountEcosystem` is the read/open-only Ecosystem mirror; `tour.js` is a **verbatim** copy of `renderer/tour.js`.

## PWA-only settings (no desktop mirror needed)

Stored in their own Firestore doc **`users/{uid}/data/pwaSettings`** — never inside the shared `settings` doc, because the desktop uploads settings with a full `.set()` (no merge) that would wipe any PWA key. Code: `pwaSettings` + `PWA_SETTINGS_DEFAULTS` + `PWA_NAV_ITEMS`, `applyAppearance()`/`effectiveTheme()` (PWA theme wins, else desktop's when `theme:'sync'`), `applyHotbar()` (reorders `.nav-item[data-navid]`), `savePwaSettings()`, localStorage cache `engorg_pwa_settings`.

## Deploying (manual — CI does not)

**Only as part of a ship the user asked for in their latest message** (root CLAUDE.md → HARD RULE). Never deploy on your own initiative. The shared-state gate hook blocks `firebase deploy` otherwise.

The `FIREBASE_SERVICE_ACCOUNT` secret is not set, so a release does **not** update the live PWA. After any release that touches `pwa/`:

1. **Before releasing**, bump `CACHE_NAME` in `pwa/sw.js` (e.g. `engorg-v26` → `engorg-v27`) so installed PWAs refresh.
2. Deploy from the submit clone (it has `firebase.json`/`.firebaserc` + the just-pushed source). `npx firebase` fails there (no `node_modules`), so use the install's copy:
   ```bash
   cd ~/.engorg-submit/engorg-taskboard && node /c/Assistant/node_modules/firebase-tools/lib/bin/firebase.js deploy --only hosting
   ```
   Always `--only hosting` (never touch Functions/Firestore rules).
3. Verify: `curl -s "https://assistant-taskboard.web.app/app.js?nc=$(date +%s)" | grep <new marker>`

Auth is already set up (login stored at `~/.config/configstore/firebase-tools.json`, **not** `%APPDATA%`). Check with `node /c/Assistant/node_modules/firebase-tools/lib/bin/firebase.js login:list`; only if logged out does the *user* run `firebase login` (browser OAuth — their step).

Cache: `firebase.json` serves `app.js`/`styles.css` with `no-cache`; other JS `max-age=3600`. An old cached copy can stick ≤1 h; iOS shows a suspended snapshot — swipe-close the PWA to force a cold load.
