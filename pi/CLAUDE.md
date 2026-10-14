# pi/ — EngOrg Pi (minimal headless Linux build for a Raspberry Pi 3+)

A **headless Node service**, not a port of the Electron app (a Pi 3 has 1 GB RAM, too little for Electron). It runs the always-on backend work a linked desktop offloads to it. The desktop stays fully functional without it: every Pi call fails soft and the desktop does the work itself.

| Feature | Pi side | Desktop side |
|---------|---------|--------------|
| **Printer address** | `lib/printer-watch.js` keeps `state.moonrakerUrl` resolved with the desktop's own `moonraker.js` (health check → /24 scan, DHCP self-heal, rescans ≤ 1 per 10 min) | `moonraker.setRemoteResolver(piLink.printerUrl)` (wired in `ipc/pi-link.js`): asked **before** the desktop's own LAN scan |
| **24/7 print-job log** | polls `print_stats/display_status` (5 s printing, 30 s idle) → `data/printer_jobs.json` (start/end, `complete`/`cancelled`/`error`/`interrupted`, last 200) | `renderer/print-tracker.js` `checkPrints` → `pi.printerJobs(since)`: prints that ended while the PC was off still get their outcome prompt |
| **Calendar feed cache** | `lib/calendar-cache.js`: stale-while-revalidate, refreshes every requested feed every 10 min, forgets feeds unused for 14 days; parsing is `core/ics.js` | `ipc/calendar.js` `calendar:fetchFeed` → `piLink.fetchFeed` first, local `core/ics.fetchFeed` on any failure |
| **Self-update** | `lib/updater.js`: every 12 h + on desktop request, newest `vX.Y.Z` GitHub release with `EngOrg-Pi.tar.gz` → `releases/<ver>` → `--selftest` → atomic `current` symlink swap → exit (systemd restarts) | `pi-link.syncVersion` (15 s after launch, then every 6 h): pushes config; if the Pi is older or its `PROTOCOL` differs and auto-update is on → `POST /api/update` |
| **Health** | `GET /` read-only status page (no secrets) · `lib/sysinfo.js` (model, temp, load, mem, disk) | Settings → Integrations → Raspberry Pi card |

## ⚠️ Keeping the Pi build current (the rule)

The Pi ships **the desktop's own modules, never forks**. `pi/manifest.json` `include` lists them (`config.js`, `state.js`, `moonraker.js`, `core/`, `pi/`). `dependencies` are taken at the desktop's `package.json` ranges and copied from `./node_modules`.
- **Anything in the manifest must stay Electron-free.** Put Electron-free logic in `core/` and keep the `ipcMain` wrapper in `ipc/` (that's how `ipc/calendar.js` → `core/ics.js` is split). `build-pi.js` fails on any `require('electron')`.
- **A Pi feature that needs another desktop module** → move the Electron-free part into `core/` and add it to `manifest.json`. Don't copy the code into `pi/`.
- **Changed a `/api/*` request/response shape** → bump `PROTOCOL` in `core/pi-protocol.js` (shared by both sides). The desktop then shows "needs an update" and asks the Pi to self-update.
- **Native modules are not allowed** (no ARM prebuilds). `build-pi.js` rejects `binding.gyp`/`gypfile`.
- `node build-pi.js --check` stages the bundle **outside the repo** (so a missing file can't resolve from `./node_modules`), runs the Electron guard, and runs `node pi/server.js --selftest`. Run it after touching any manifest file. The `parity-watch` hook prints a **PI POINTER** reminder when you edit one. The **pre-ship guard blocks `release.js`** if the check fails.
- Desktop-only by design: the Pi has no PWA mirror and no renderer. `ipc/pi-link.js` + the Settings card + the print-tracker hook are desktop-only.

## Build & ship

- `node build-pi.js` → `dist/EngOrg-Pi.tar.gz`, stamped with the root `package.json` version (LF line endings, `node_modules` included, ~1.1 MB). `dist/` is never submitted (`CONTRIB_IGNORE`).
- CI (`release-installer.yml` job **`pi`**, tags only, `needs: build`): checks that `package.json` matches the tag, runs `build-pi.js` (npm-installs deps since CI has no `node_modules`), and attaches the tarball to the `vX.Y.Z` release **and** the rolling `latest` release. Installed Pis update from the version release. The `latest` copy is the first-install URL. Shipping it is just a normal `/ship` (hard rule applies: never on your own).

## On the Pi

```
curl -fsSLO https://github.com/carsonbellak/engorg-taskboard/releases/download/latest/EngOrg-Pi.tar.gz
mkdir engorg-pi && tar -xzf EngOrg-Pi.tar.gz -C engorg-pi && sudo bash engorg-pi/pi/install.sh
```
- `install.sh`: uses system Node if ≥ 20, otherwise downloads the official Node 22 (`armv7l`/`arm64`, checksum-verified) into `/opt/engorg-pi/node`. Prefer **64-bit Raspberry Pi OS**. It creates the `engorg` system user and lays out `/opt/engorg-pi/{releases/<ver>, current→, data/, node/}`. It self-tests before switching, then installs `engorg-pi.service` (`@NODE@` substituted; `--max-old-space-size=192`, `Restart=always`) and the `engorg-pi` CLI, and prints the address and pairing code. `--uninstall` removes the service (data is kept).
- CLI: `sudo engorg-pi code` (pairing code) · `reset-pairing` (new code, revokes every desktop) · `status` · `logs` · `restart`.
- Env: `ENGORG_PI_DATA` (data dir; default `~/.engorg-pi`), `ENGORG_PI_HOME` (install root; **unset = dev mode, self-update disabled**), `ENGORG_PI_PORT`.
- Dev run on any OS: `node pi/server.js` from the repo (uses `./node_modules`). `node pi/server.js --selftest` uses a temp data dir.

## API (`server.js`; ports + header names in `core/pi-protocol.js`)

TCP **8780** (HTTP) + UDP **8781** (discovery: desktop broadcasts `ENGORG_PI_DISCOVER_V1`, the Pi replies `{app:'engorg-pi', id, name, port, version, protocol, paired}`).
- No auth: `GET /` (status page), `GET /api/hello`, `POST /api/pair {code, client}` → `{token, id, name, version}`. The 6-digit code is in `data/auth.json`. Only token SHA-256s are stored. Wrong codes are limited to 5 per 10 min.
- `Authorization: Bearer <token>`: `GET /api/status` · `POST /api/config {printerEnabled, printerSeed, timezone, autoUpdate}` · `GET /api/printer` · `GET /api/printer/jobs?since=ISO` · `GET /api/calendar/feed?url=&source=` → `{events, fetchedAt, stale}` (502 `{error}` if never fetched) · `POST /api/update` → `{updating,from,to}` | `{upToDate}` | `{error}` · `POST /api/unpair`.
- **Printer watch is off until the desktop says `printerEnabled`.** A Pi never scans the LAN for a printer the user doesn't have, same rule as `main.js` for Compact installs.
- **Timezone:** `core/ics.js` renders local dates and times, so the desktop pushes its IANA zone. `lib/runtime-config.js` sets `process.env.TZ`, and calendar-cache entries are keyed by tz.
- Data files (`data/`): `auth.json`, `config.json`, `printer.json`, `printer_jobs.json`, `calendar_cache.json` (atomic writes; feed URLs can carry tokens, so the dir is `750`, owned by `engorg`).

## Desktop link (`ipc/pi-link.js`)

`pi:discover/pair/unpair/status/update/setAutoUpdate/printerJobs` (exact signatures: grep `preload.js` → `pi`). The link (`host, port, id, name, tokenEnc`) is stored in `appdata/pi_link.json`, device-local, with the token encrypted via `safeStorage` (never sent to the renderer). After a failed call the Pi is skipped for 2 minutes. If the Pi changes IP (DHCP), `pi:status` re-discovers it by `id` and adopts the new host. On pairing and every sync, the desktop pushes `{printerEnabled, printerSeed}` from `settings.json` plus its timezone.

## Roadmap (not built)

LMS syncs on the Pi: Gradescope needs the stored password, which stays desktop-only under the secrets rule, and Variate needs an interactive SSO browser. Other ideas: rolling `appdata` backups to the Pi; serving Fluidd from the Pi (the camera bridge needs the desktop's WebRTC decoder); a Pi-side EngInk relay.
