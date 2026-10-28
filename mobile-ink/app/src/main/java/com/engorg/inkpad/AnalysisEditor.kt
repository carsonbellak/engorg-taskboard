package com.engorg.inkpad

import android.app.Activity
import android.widget.FrameLayout
import org.json.JSONObject
import java.util.WeakHashMap
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * Symbol values, with or without the Analyze panel. Owns the one [AnalysisHost] the notebook uses
 * (the panel runs its analyses on [engine] too) and the [ValueSheet]: a select-tool tap on a class
 * symbol ([onSymbolTap], wired to every pane's [PageCanvas.symbolTap]) opens its values whenever the
 * analysis gives it fields. When the panel isn't showing that page the analysis runs silently —
 * nothing is drawn — just to learn the fields, and again after a save to refresh the symbols' drawn
 * labels and their smart placement (props `_label`, `_lx`, `_ly`, `_la`; contract §4).
 */
class AnalysisEditor(private val act: Activity, host: FrameLayout) {
    private var eng: AnalysisHost? = null
    /** The shared analysis engine (a headless WebView), made on first use. */
    val engine: AnalysisHost get() = eng ?: AnalysisHost(act).also { eng = it }

    /** True when the Analyze panel shows [page] of [pane] (it then re-runs and relabels on every edit itself). */
    var panelShows: (pane: PageCanvas, page: Int) -> Boolean = { _, _ -> false }

    private val sheet = ValueSheet(act, host)
    private var sheetPane: PageCanvas? = null

    // The latest analysis we know of: comps (by record index) for one pane's page as it was then.
    private var cPane: PageCanvas? = null
    private var cPage = -1
    private var cRecs: List<FinishedStrokesView.Rec> = emptyList()
    private var cComps: Map<Int, JSONObject> = emptyMap()
    private var tapSeq = 0

    // Records are immutable, so a props update swaps in a new one; this follows old → new so a
    // sheet (or the panel's list) opened on an older record still acts on the live one.
    private val successor = WeakHashMap<FinishedStrokesView.Rec, FinishedStrokesView.Rec>()

    /** Remember an analysis of [pane]'s [page] ([recs] = the records the comps' indices refer to). */
    fun remember(pane: PageCanvas, page: Int, recs: List<FinishedStrokesView.Rec>, comps: Map<Int, JSONObject>) {
        cPane = pane; cPage = page; cRecs = ArrayList(recs); cComps = comps
    }

    /** The live record [rec] became after props updates (itself if it wasn't replaced). */
    fun current(rec: FinishedStrokesView.Rec): FinishedStrokesView.Rec {
        var r = rec; var n = 0
        while (n++ < 64) r = successor[r] ?: break
        return r
    }

    /**
     * A select-tool tap on symbol [rec]. Returns true when it's consumed (its value sheet opens, now or
     * once a silent analysis says what its fields are); false lets the tap select it as usual. A symbol
     * that turns out to have no fields after a silent run is selected then, as the tap would have.
     */
    fun onSymbolTap(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec): Boolean = open(pane, page, rec, selectIfNone = true)

    /** Open [rec]'s value sheet (the panel's Values list); does nothing for a symbol without fields. */
    fun edit(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec) { open(pane, page, current(rec), selectIfNone = false) }

    private fun open(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec, selectIfNone: Boolean): Boolean {
        if (cacheValid(pane, page)) {
            val comp = cComps[cRecs.indexOf(rec)]
            if (!hasFields(comp)) return false
            showSheet(pane, page, rec, comp!!)
            return true
        }
        val seq = ++tapSeq
        analyse(pane, page) { recs, comps ->
            if (seq != tapSeq) return@analyse   // a newer tap won
            val comp = comps?.get(recs.indexOf(rec))
            if (hasFields(comp)) showSheet(pane, page, rec, comp!!)
            else if (selectIfNone) pane.selectRec(page, rec)
        }
        return true
    }

    private fun hasFields(comp: JSONObject?) = (comp?.optJSONArray("fields")?.length() ?: 0) > 0

    /** Is the remembered analysis still about exactly the records on that page now? */
    private fun cacheValid(pane: PageCanvas, page: Int): Boolean {
        if (cPane !== pane || cPage != page) return false
        val live = pane.finishedView.pages.getOrNull(page)?.recs ?: return false
        if (live.size != cRecs.size) return false
        for (k in live.indices) if (live[k] !== cRecs[k]) return false
        return true
    }

    /** Analyse [pane]'s [page] without drawing anything; [done] gets the records it saw and the comps (null if the engine failed). */
    private fun analyse(pane: PageCanvas, page: Int, done: (List<FinishedStrokesView.Rec>, Map<Int, JSONObject>?) -> Unit) {
        val recs = ArrayList(pane.finishedView.pages.getOrNull(page)?.recs ?: return)
        engine.run(AnalysisHost.pageJson(recs)) { res ->
            if (res == null) { done(recs, null); return@run }
            val comps = compsOf(res)
            remember(pane, page, recs, comps)
            done(recs, comps)
        }
    }

    private fun showSheet(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec, comp: JSONObject) {
        sheetPane = pane
        sheet.show(comp, current(rec).shape?.props,
            onSave = { values -> save(pane, page, rec, values) },
            onSelect = { pane.selectRec(page, current(rec)) },
            onDelete = { pane.removeRec(page, current(rec)) })
    }

    private fun save(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec, values: Map<String, String>) {
        val live = current(rec)
        val old = live.shape?.props
        val np = JSONObject(old?.toString() ?: "{}")
        var changed = false
        for ((key, v) in values) {
            if (v == (old?.optString(key) ?: "")) continue
            changed = true
            if (v.isEmpty()) np.remove(key) else np.put(key, v)
        }
        if (!changed) return   // nothing new: no undo step, no re-run
        val fresh = pane.updateShapeProps(page, live, np, undoable = true) ?: return
        successor[live] = fresh
        // The panel re-runs on the edit itself; otherwise refresh the labels quietly.
        if (panelShows(pane, page)) return
        analyse(pane, page) { recs, comps ->
            if (comps == null) return@analyse
            val m = ArrayList(recs)
            reconcile(pane, page, m, comps)
            remember(pane, page, m, comps)
        }
    }

    /**
     * Bring each analysed symbol's drawn label in step with [comps]: `_label` = comp.label, and when
     * the script placed it, `_lx`/`_ly` = labelAt − anchor and `_la` = its alignment. Derived data, so
     * not an undo step; only written when the text changes or the spot moves more than 0.5 page units
     * (no churn). Replaced records are swapped into [recs] so its indices stay valid.
     */
    fun reconcile(pane: PageCanvas, page: Int, recs: MutableList<FinishedStrokesView.Rec>, comps: Map<Int, JSONObject>) {
        val live = pane.finishedView.pages.getOrNull(page)?.recs ?: return
        for ((i, comp) in comps) {
            val rec = recs.getOrNull(i) ?: continue
            val shape = rec.shape ?: continue
            if (shape.type != ShapeType.SYMBOL || !live.contains(rec)) continue
            val props = shape.props
            val np = JSONObject(props?.toString() ?: "{}")
            var changed = false
            val want = comp.optString("label")
            if (want != np.optString("_label")) { changed = true; if (want.isEmpty()) np.remove("_label") else np.put("_label", want) }
            val at = comp.optJSONObject("labelAt")
            val anchor = comp.optJSONArray("anchor")
            if (want.isNotEmpty() && at != null && anchor != null && anchor.length() >= 2) {
                val lx = at.optDouble("x") - anchor.optDouble(0)
                val ly = at.optDouble("y") - anchor.optDouble(1)
                if (lx.isFinite() && ly.isFinite()) {
                    val moved = !np.has("_lx") || !np.has("_ly") ||
                        abs(np.optDouble("_lx", 0.0) - lx) > 0.5 || abs(np.optDouble("_ly", 0.0) - ly) > 0.5
                    if (moved) { changed = true; np.put("_lx", round2(lx)); np.put("_ly", round2(ly)) }
                    val align = at.optString("align").takeIf { it == "left" || it == "right" } ?: "center"
                    if (align != np.optString("_la")) { changed = true; np.put("_la", align) }
                }
            } else if (np.has("_lx") || np.has("_ly") || np.has("_la")) {
                // No placement from the script: back to the default spot beside the symbol.
                changed = true; np.remove("_lx"); np.remove("_ly"); np.remove("_la")
            }
            if (!changed) continue
            val fresh = pane.updateShapeProps(page, rec, np, undoable = false) ?: continue
            successor[rec] = fresh
            recs[i] = fresh
        }
    }

    private fun round2(v: Double) = (v * 100.0).roundToLong() / 100.0

    /** Close the value sheet, if one is open. */
    fun closeSheet() { sheet.close(); sheetPane = null }

    /** [pane] is going away: drop what's remembered about it (and its sheet). */
    fun forget(pane: PageCanvas) {
        if (cPane === pane) { cPane = null; cPage = -1; cRecs = emptyList(); cComps = emptyMap() }
        if (sheetPane === pane) closeSheet()
    }

    fun dispose() { closeSheet(); eng?.dispose(); eng = null }

    companion object {
        /** `res.comps` (keyed by record index) as a map. */
        fun compsOf(res: JSONObject): Map<Int, JSONObject> {
            val map = HashMap<Int, JSONObject>()
            res.optJSONObject("comps")?.let { c -> c.keys().forEach { k -> k.toIntOrNull()?.let { i -> c.optJSONObject(k)?.let { map[i] = it } } } }
            return map
        }
    }
}
