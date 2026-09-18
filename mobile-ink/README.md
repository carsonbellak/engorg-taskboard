# EngOrg tablet app — PWA shell + native ink

A thin native Android shell. It is **not** a second codebase:

- **Everything** (notes, calendar, projects, …) is your existing **PWA** loaded in a WebView
  (`MainActivity` → `https://assistant-taskboard.web.app`), so it stays in sync with whatever
  you deploy to Firebase Hosting — nothing is duplicated.
- The **only** native piece is handwriting: when the PWA opens its **Ink** tab, the shell
  intercepts it and launches the native low-latency ink surface (`InkActivity`,
  `androidx.ink` front-buffered rendering + motion prediction).

## Ink surface behavior
- **Pen (stylus)** writes — pressure-driven width, front-buffered for minimal latency.
- **Finger** drags the page (pan) instead of writing.
- **S Pen side button** (or an eraser-tip pen) erases whole strokes under the tip.
- Toolbar: back to app, ink/blue/red, size −/+, clear.

> Sign-in note: Google blocks its OAuth flow inside raw WebViews, so **sign in with
> email/password** in the app. The PWA supports that already.

## Build & run — locally (Android Studio)
1. Install **Android Studio**. **File → Open** → this `mobile-ink` folder.
2. Let Gradle sync (use **Gradle 8.9** if it asks; bump `inkVersion` in `app/build.gradle.kts`
   only if `androidx.ink` fails to resolve).
3. On the Tab: Settings → About → tap **Build number** 7× → **Developer options** → **USB
   debugging** on. Plug in, hit **Run ▶** — installs and launches directly.

## Build — in CI (no local install)
It also builds in GitHub Actions. Every `vX.Y.Z` release attaches a sideloadable
`EngOrg-Ink-<tag>.apk` to the GitHub Release — download and install it on the Tab
(My Files → tap the APK → Install; allow "install unknown apps" the first time).
