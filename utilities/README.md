# Engineering Utilities — Store catalog

This folder is the source for the in-app **Utility Store** (Engineering Utilities
tab → Utility Store). The app fetches [`catalog.json`](catalog.json) at runtime
(`config.UTILITY_STORE_CATALOG_URL`) and lets users install the listed utilities.

Remote utilities are **self-contained HTML** rendered in a **sandboxed iframe**
(`sandbox="allow-scripts allow-forms allow-popups"`). They have **no access** to
Node, the filesystem, IPC, or the rest of the app — keep them to plain
HTML/CSS/JS. No external network requests are guaranteed to work; bundle
everything inline.

## Adding a utility

1. Create a folder `utilities/<your-id>/` with a self-contained `index.html`.
2. Add an entry to `catalog.json`:

   ```json
   {
     "id": "<your-id>",
     "name": "Display Name",
     "icon": "🧩",
     "description": "One line shown on the store card.",
     "version": "1.0.0",
     "entry": "https://raw.githubusercontent.com/carsonbellak/engorg-taskboard/main/utilities/<your-id>/index.html"
   }
   ```

3. Open a Pull Request (the in-app **Settings → Contribute → Submit Changes** button
   does this for you). Once the owner merges it, the utility appears in everyone's
   store automatically — no app reinstall needed.

> Built-in utilities (3D Printer, Slicer, KiCad Importer, WiFi Checker) ship with
> the app itself and are not listed here; this catalog is for installable add-ons.
