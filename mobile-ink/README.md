# Ink POC — native low-latency handwriting test

A throwaway app whose only job is to answer one question: **does native `androidx.ink`
feel smooth on the Galaxy Tab + S Pen?** It's just a paper canvas with Google's
front-buffered low-latency ink + motion prediction, plus a tiny color/size/clear toolbar.
No notes, no sync, no Capacitor — that all comes later, only if this passes.

## Build & run — locally (Android Studio, fast loop)

1. Install **Android Studio** (Hedgehog or newer). It bundles JDK 17 + the Android SDK.
2. **File → Open** → select this `mobile-ink` folder (open it as its own project, not the
   whole repo).
3. Let Gradle sync. If it prompts about a missing Gradle wrapper, let it use **Gradle 8.9**.
   If `androidx.ink` fails to resolve, bump `inkVersion` in `app/build.gradle.kts` to the
   latest version Android Studio suggests, then re-sync.
4. Enable **Developer options** on the Tab (Settings → About → tap *Build number* 7×), turn
   on **USB debugging**, plug the Tab into the PC, then hit **Run ▶** in Android Studio. It
   installs and launches directly — no manual sideload needed over USB.

## Build — in CI (GitHub Actions, no local install)

Push `mobile-ink/**` to the repo (or Actions → **Build Ink POC APK** → *Run workflow*).
When it's green, open the run → **Artifacts** → download **inkpoc-debug-apk**, unzip → you
get `app-debug.apk`. Then sideload it (below).

## Sideload the APK onto the Tab (manual install)

1. On the Tab: **Settings → Apps → Special access → Install unknown apps** → pick the app
   you'll open the APK from (e.g. **My Files** or **Chrome**) → toggle **Allow**.
2. Get `app-debug.apk` onto the Tab — email it to yourself, drop it in Google Drive, or
   copy over USB.
3. Tap the APK in **My Files** → **Install** → open **Ink POC**.
4. To update later, install the new APK over the old one (same package id, so it upgrades).

> A "debug" APK is auto-signed with the standard debug key, so it installs like any
> sideloaded app. It is **not** for the Play Store — this is a personal test build.

## What to judge

Write naturally with the S Pen. It should track the tip with far less lag than the web
version — close to how your friend's iPad feels. If it does, we move to the real build
(Capacitor wrapping the PWA + this ink surface as a plugin, with save/sync). If it still
lags badly, the Tab's digitizer is the ceiling and we'll know for certain.
