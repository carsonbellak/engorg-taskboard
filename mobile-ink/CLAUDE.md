# EngInk (`mobile-ink/`) — where the code is

Android app: a thin WebView shell around the PWA (`MainActivity`, `HomeActivity`) plus native handwriting (`InkActivity`), called **EngInk** (not NoteOrg). `README.md` describes the features; this file says where they live.

All Kotlin is one flat package: `app/src/main/java/com/engorg/inkpad/`. Analysis JS is in `app/src/main/assets/analysis/`. Line numbers rot, so everything below is named by function or section. Grep the name.

## Start here for…

| The task is about | Go to |
|---|---|
| **Analyze panel results**, circuit/thermo reading, warnings | `assets/analysis/ink-analysis.js` (`circuit()`, `thermo()`, `analyze()`) |
| **Mechanics** (trusses, beams, pulleys, buoyancy) | `assets/analysis/ink-mechanics.js` |
| The **solvers** themselves | `renderer/circuit-engine.js`, `renderer/thermo-engine.js` at the repo root. Shared with the desktop, copied into the APK by Gradle `copyAnalysisEngines`. There is no copy under `assets/`. |
| A part's **value sheet**: which fields, hints, keypad keys | fields: `circuitFields()` in `ink-analysis.js`. UI: `ValueSheet.kt`. Open/save flow: `AnalysisEditor.kt` |
| **Variables and dependent sources** (`ix`, `Vx`, `i(t)`, `2ix`) | `partVars`, `varExpr`, `varKey`, `varShow`, `varTab` in `ink-analysis.js`; keypad keys are `Entry.vars` in `ValueSheet.kt` |
| **Wire currents** (tap a wire, the arrow) | `AnalysisEditor.openWire/showWireSheet`, `PageCanvas.addCurrentTag`, `cutWires()` in `ink-analysis.js`, arrow drawing in `Symbols.bareParts` |
| **Labels** on the page ("6 Ω", "i(t)") | text: `circuitLabel` + `varLabel`. Position: `placeAll()`. Stored: `AnalysisEditor.reconcile`. Drawn: `FinishedStrokesView.drawSymbolLabel` |
| Result chips over the page | `out.annots` in `ink-analysis.js`, `drawAnnots` in `FinishedStrokesView.kt` |
| Panel layout, plots, tables | `AnalysisPanel.kt` |
| **A symbol's drawing**, its size, the symbol catalogue | `Symbols.kt` (`enum Sym`, `draw()`, `bareParts()`). Menu: `InkActivity.showSymbolMenu` |
| Shapes (line, arrow, axes, tables) | `ShapeSpec.kt`, `InkActivity.showShapeMenu`; freehand cleanup in `ShapeRecognizer.kt` |
| **Pen, touch, selection, lasso, undo, saving** | `PageCanvas.kt`: sections `touch`, `selection / editing`, `undo / redo`, `persistence` |
| **Stroke rendering**, zoom, paper styles, long-press menu | `FinishedStrokesView.kt`; wet ink in `WetOverlay.kt` |
| Toolbar, popups, split panes, tool state | `InkActivity.kt`: `buildToolbar`, `show*Menu`, sections `panes / focus`, `dynamic split panes`, `toolbar` |
| Assignment submit, PDF export + email, desktop mirror | `InkActivity.kt` sections of those names; `AssignmentSubmit.kt`, `MirrorManager.kt` |
| Notebook library, covers, page files | `LibraryActivity.kt`, `NotebookStore.kt`, `Covers.kt` |
| Grapher | `GrapherWindow.kt` (floating), `GraphPane.kt` + `GraphCard.kt` (on a page), `GraphModel.kt`, `GraphView.kt`, `Graph3D.kt`, `MathEngine.kt`, `MathField.kt`, `MathTypeset.kt` |
| Calculator | `CalculatorWindow.kt` (shares `MathField.kt`) |
| 3D solids | `Solid3D.kt`, `SolidPreviewView.kt`, `InkActivity.showSolidBuilder` |
| Claude | `ClaudePanel.kt`, `ClaudeClient.kt`, `AskInClaude.kt` |
| Workbooks | `Workbooks.kt`, `WorkbookPane.kt`, `WorkbookShareActivity.kt` |
| Imports | `PdfImport.kt`, `NoteshelfImport.kt` (+ `PlistLite.kt`) |
| Settings, theme, updates | `InkSettings.kt`, `AppTheme.kt`, `InkUpdater.kt` |
| PWA shell, home screen | `MainActivity.kt`, `HomeActivity.kt`, `FileSaveBridge.kt` |

## How analysis flows

```
page records → AnalysisHost.pageJson → EI.run (index.html) → InkAnalysis.analyze → { analyses, annots, comps, wiring }
```

- A select-tool tap goes `PageCanvas.symbolTap` → `AnalysisEditor.onSymbolTap` → value sheet (`comps[i].fields`) or wire sheet.
- Save writes `ShapeSpec.props` (`pr` in the page JSON), then `relabel`. With the panel open, `AnalysisPanel.apply` re-runs instead.
- Comps are keyed by record index, and records are immutable: a props change swaps in a new record. `AnalysisEditor.current()` follows old to new.
- Props starting `_` (`_label`, `_lx`, `_ly`, `_la`, `_mk`) are derived. `reconcile` owns them, so never set them elsewhere.
- Page JSON: `k: 's'` shape, `k: 'f'` freehand; see `PageCanvas` section `persistence`.

## Adding a circuit symbol

`enum Sym` + `draw()` in `Symbols.kt`, then in `ink-analysis.js`: `ECE`, `CIRCUIT_INFO`, `circuitFields`, `circuitLabel`, and the `switch (s.sym)` in `circuit()` that builds engine parts.

## Checking a change

Analysis JS runs in Node, so test it there before anything else. Synthetic geometry is enough; inline symbols need `{ i, sym, inline: true, terms, half, w, h, rot, pivot, props }`, wires `{ i, kind: 'line', pts }`:

```js
global.CircuitEngine = require('C:/Assistant/renderer/circuit-engine.js');
global.ThermoEngine = require('C:/Assistant/renderer/thermo-engine.js');
const InkAnalysis = require('C:/Assistant/mobile-ink/app/src/main/assets/analysis/ink-analysis.js');
InkAnalysis.analyze({ symbols, wires });   // look at .comps[i].label / .fields and .analyses[].blocks
```

Kotlin: compile-check at `C:\androidbuild` (memory: android-local-build), then delete `mobile-ink/.gradle` and `mobile-ink/app/build` so a release can't sweep them in. No emulator or app screenshots; QA is the user's, on the tablet.

## Gotchas

- Kotlin block comments nest: a `/*` inside a KDoc swallows the rest of the file.
- Keep the engines free of Electron and the DOM; the Android WebView runs them too.
- `CircuitEngine.parseSI` reads `1F` as femto. Use `siVal(v, unit)`, which strips the unit first.
- The value keypad has no letters, so a source can only use a variable through a key from `PAGE_VARS`. A name `partVars` rejects never reaches the keypad.
- The PWA side of the app is the live site in a WebView, so PWA changes reach it without a new APK; native changes need a release.
