package com.engorg.inkpad

import android.app.Activity
import android.graphics.PointF
import android.os.Handler
import android.os.Looper
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.util.WeakHashMap
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToLong

/**
 * Symbol values, with or without the Analyze panel. Owns the one [AnalysisHost] the notebook uses
 * (the panel runs its analyses on [engine] too) and the [ValueSheet]: a select-tool tap on a class
 * symbol ([onSymbolTap], wired to every pane's [PageCanvas.symbolTap]) opens its values whenever the
 * analysis gives it fields. When the panel isn't showing that page the analysis runs silently —
 * nothing is drawn — just to learn the fields, and again after a save to refresh the symbols' drawn
 * labels and their smart placement (props `_label`, `_lx`, `_ly`, `_la`, `_mk`; contract §4), and
 * after any edit to a labelled page, so a label follows its part through moves and turns.
 *
 * A tap on a wire of a circuit offers to name its current: Save drops a [Sym.CURRENT] arrow on the wire.
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
    private var cWires: Set<Int> = emptySet()   // record indices of the circuit's wires
    private var cNextI = ""                     // a current name not used on the page yet
    private var tapSeq = 0

    private val main = Handler(Looper.getMainLooper())
    private var editedPane: PageCanvas? = null
    private var editedPage = 0
    private val quietRelabel = Runnable { editedPane?.let { relabel(it, editedPage) } }

    // Records are immutable, so a props update swaps in a new one; this follows old → new so a
    // sheet (or the panel's list) opened on an older record still acts on the live one.
    private val successor = WeakHashMap<FinishedStrokesView.Rec, FinishedStrokesView.Rec>()

    /** Remember an analysis of [pane]'s [page] ([recs] = the records the comps' indices refer to); [res] is its full result. */
    fun remember(pane: PageCanvas, page: Int, recs: List<FinishedStrokesView.Rec>, comps: Map<Int, JSONObject>, res: JSONObject? = null) {
        cPane = pane; cPage = page; cRecs = ArrayList(recs); cComps = comps
        if (res == null) return
        val wiring = res.optJSONObject("wiring")
        val wires = wiring?.optJSONArray("wires")
        cWires = if (wires == null) emptySet() else (0 until wires.length()).map { wires.optInt(it, -1) }.toSet()
        cNextI = wiring?.optString("nextI").orEmpty()
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
     * A wire (a WIRE symbol, a line, an arrow or a pen stroke) tapped at page point ([x],[y]) gets the
     * wire-current sheet instead, on a page that has a circuit.
     */
    fun onSymbolTap(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec, x: Float, y: Float): Boolean {
        val sp = rec.shape
        if (sp == null || sp.type != ShapeType.SYMBOL || sp.symbol == Sym.WIRE) return openWire(pane, page, rec, x, y)
        return open(pane, page, rec, selectIfNone = true)
    }

    private fun openWire(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec, x: Float, y: Float): Boolean {
        val live = pane.finishedView.pages.getOrNull(page)?.recs ?: return false
        if (live.none { it.shape?.symbol?.let { s -> s.group == SymGroup.ECE && s != Sym.WIRE } == true }) return false
        if (cacheValid(pane, page)) {
            if (cRecs.indexOf(rec) !in cWires) return false
            showWireSheet(pane, page, rec, x, y)
            return true
        }
        val seq = ++tapSeq
        analyse(pane, page) { recs, _ ->
            if (seq != tapSeq) return@analyse
            if (recs.indexOf(rec) in cWires) showWireSheet(pane, page, rec, x, y) else pane.selectRec(page, rec)
        }
        return true
    }

    /** Where the arrow goes on wire [rec] for a tap at ([x],[y]): a point on it and the unit direction there, right/down first. */
    private class WireSpot(val x: Float, val y: Float, val ux: Float, val uy: Float)

    private fun wireSpot(rec: FinishedStrokesView.Rec, x: Float, y: Float): WireSpot? {
        val h = rec.shape?.handles.orEmpty()
        val at: PointF; var ux: Float; var uy: Float
        if (h.size >= 2) {
            val a = h[0]; val b = h[1]; val len = hypot(b.x - a.x, b.y - a.y).coerceAtLeast(1e-3f)
            ux = (b.x - a.x) / len; uy = (b.y - a.y) / len
            val t = ((x - a.x) * ux + (y - a.y) * uy).coerceIn(0f, len)
            at = PointF(a.x + ux * t, a.y + uy * t)
        } else {
            val pts = rec.points
            if (pts.size < 2) return null
            val k = pts.indices.minByOrNull { hypot(pts[it].x - x, pts[it].y - y) } ?: return null
            val a = pts[(k - 4).coerceAtLeast(0)]; val b = pts[(k + 4).coerceAtMost(pts.size - 1)]
            val len = hypot(b.x - a.x, b.y - a.y).coerceAtLeast(1e-3f)
            ux = (b.x - a.x) / len; uy = (b.y - a.y) / len
            at = pts[k]
        }
        if (abs(uy) < 0.26f) { ux = 1f; uy = 0f } else if (abs(ux) < 0.26f) { ux = 0f; uy = 1f }
        if (if (abs(ux) >= abs(uy)) ux < 0f else uy < 0f) { ux = -ux; uy = -uy }
        return WireSpot(at.x, at.y, ux, uy)
    }

    private fun showWireSheet(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec, x: Float, y: Float) {
        val spot = wireSpot(rec, x, y) ?: return
        val flat = abs(spot.ux) >= abs(spot.uy)
        val comp = JSONObject().put("name", "Current in this wire").put("title", "Current in this wire").put("fields", JSONArray()
            .put(JSONObject().put("key", "vars").put("label", "Current name").put("keypad", "text").put("ph", "ix").put("hint", "A source can use it: 2ix"))
            .put(JSONObject().put("key", "rev").put("label", "Arrow points")
                .put("options", JSONArray().put(if (flat) "→" else "↓").put(if (flat) "←" else "↑")).put("optValues", JSONArray().put("").put("1"))))
        sheetPane = pane
        sheet.show(comp, JSONObject().put("vars", cNextI), onSave = { values ->
            val name = values["vars"].orEmpty()
            if (!name.startsWith("i", ignoreCase = true)) Toast.makeText(act, "A current's name starts with i: ix, i1", Toast.LENGTH_SHORT).show()
            else {
                val props = JSONObject().put("vars", name)
                if (values["rev"] == "1") props.put("rev", "1")
                pane.addCurrentTag(page, current(rec), spot.x, spot.y, spot.ux, spot.uy, props)
                relabel(pane, page)
            }
        }, onSelect = { pane.selectRec(page, current(rec)) }, onDelete = { pane.removeRec(page, current(rec)) })
    }

    /** Any edit to a page with labels: refresh them once it settles, unless the panel is doing that already. */
    fun onPageEdited(pane: PageCanvas, page: Int) {
        if (panelShows(pane, page)) return
        val recs = pane.finishedView.pages.getOrNull(page)?.recs ?: return
        if (recs.none { it.shape?.props?.has("_label") == true }) return
        editedPane = pane; editedPage = page
        main.removeCallbacks(quietRelabel)
        main.postDelayed(quietRelabel, 400)
    }

    /** Open [rec]'s value sheet (the panel's Values list); does nothing for a symbol without fields. */
    fun edit(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec) { open(pane, page, current(rec), selectIfNone = false) }

    /**
     * The selection's "Values" button: a lone part gets its usual sheet, several (a lassoed circuit)
     * share one sheet with Next running through them all. [x] = the selection's center in [pane].
     */
    fun editAll(pane: PageCanvas, page: Int, recs: List<FinishedStrokesView.Rec>, x: Float) {
        val syms = recs.filter { it.shape?.type == ShapeType.SYMBOL }
        if (cacheValid(pane, page)) { showAll(pane, page, syms, cRecs, cComps, x); return }
        val seq = ++tapSeq
        analyse(pane, page) { seen, comps ->
            if (seq == tapSeq) showAll(pane, page, syms, seen, comps ?: emptyMap(), x)
        }
    }

    private fun showAll(pane: PageCanvas, page: Int, syms: List<FinishedStrokesView.Rec>, seen: List<FinishedStrokesView.Rec>, comps: Map<Int, JSONObject>, x: Float) {
        val all = syms.mapNotNull { rec -> comps[seen.indexOf(rec)]?.takeIf { hasFields(it) }?.let { rec to it } }
        // Parts with something to enter, by name (R1, R2, V1); meters and grounds only have a name to set.
        val valued = all.filter { (_, comp) -> (0 until comp.getJSONArray("fields").length()).any { comp.getJSONArray("fields").getJSONObject(it).optString("key") != "name" } }
            .sortedWith(compareBy({ it.second.optString("name").takeWhile { c -> !c.isDigit() } }, { it.second.optString("name").dropWhile { c -> !c.isDigit() }.toIntOrNull() ?: 0 }))
        when {
            valued.size > 1 -> {
                val loc = IntArray(2); pane.getLocationInWindow(loc)
                val parts = valued.map { (rec, comp) -> ValueSheet.Part(comp, current(rec).shape?.props) }
                sheetPane = pane
                // Docked away from the selection so the circuit stays in view.
                sheet.showParts(parts, dockEnd = loc[0] + x < act.window.decorView.width / 2f,
                    onPart = { k -> pane.ringRec(page, current(valued[k].first)) },
                    onClosed = { pane.ringRec(page, null) },
                    onSave = { values -> saveAll(pane, page, valued.map { it.first }, values) })
            }
            valued.size == 1 -> showSheet(pane, page, valued[0].first, valued[0].second)
            all.size == 1 -> showSheet(pane, page, all[0].first, all[0].second)
            else -> Toast.makeText(act, "No values to enter here", Toast.LENGTH_SHORT).show()
        }
    }

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
            remember(pane, page, recs, comps, res)
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

    /** [live]'s props with [values] applied, or null if that changes nothing. */
    private fun merged(live: FinishedStrokesView.Rec, values: Map<String, String>): JSONObject? {
        val old = live.shape?.props
        val np = JSONObject(old?.toString() ?: "{}")
        var changed = false
        for ((key, v) in values) {
            if (v == (old?.optString(key) ?: "")) continue
            changed = true
            if (v.isEmpty()) np.remove(key) else np.put(key, v)
        }
        return np.takeIf { changed }
    }

    private fun save(pane: PageCanvas, page: Int, rec: FinishedStrokesView.Rec, values: Map<String, String>) {
        val live = current(rec)
        val np = merged(live, values) ?: return   // nothing new: no undo step, no re-run
        val fresh = pane.updateShapeProps(page, live, np, undoable = true) ?: return
        successor[live] = fresh
        relabel(pane, page)
    }

    /** Save a multi-part sheet: [values][k] belongs to [recs][k], and the lot is one undo step. */
    private fun saveAll(pane: PageCanvas, page: Int, recs: List<FinishedStrokesView.Rec>, values: List<Map<String, String>>) {
        var saved = false
        recs.forEachIndexed { k, rec ->
            val live = current(rec)
            val np = merged(live, values.getOrNull(k) ?: return@forEachIndexed) ?: return@forEachIndexed
            val fresh = pane.updateShapeProps(page, live, np, undoable = !saved) ?: return@forEachIndexed
            successor[live] = fresh
            saved = true
        }
        if (saved) relabel(pane, page)
    }

    /** The panel re-runs on an edit itself; otherwise refresh the drawn labels quietly. */
    private fun relabel(pane: PageCanvas, page: Int) {
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
     * the script placed it, `_lx`/`_ly` = labelAt − anchor, `_la` = its alignment and `_mk` = where a
     * named voltage's + and − go ("px,py,mx,my", also from the anchor). Derived data, so
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
                val mk = comp.optJSONArray("marks")?.let { m -> (0 until m.length()).joinToString(",") { m.optDouble(it).toString() } }.orEmpty()
                if (mk != np.optString("_mk")) { changed = true; if (mk.isEmpty()) np.remove("_mk") else np.put("_mk", mk) }
            } else if (np.has("_lx") || np.has("_ly") || np.has("_la") || np.has("_mk")) {
                // No placement from the script: back to the default spot beside the symbol.
                changed = true; np.remove("_lx"); np.remove("_ly"); np.remove("_la"); np.remove("_mk")
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
        if (cPane === pane) { cPane = null; cPage = -1; cRecs = emptyList(); cComps = emptyMap(); cWires = emptySet() }
        if (editedPane === pane) { main.removeCallbacks(quietRelabel); editedPane = null }
        if (sheetPane === pane) closeSheet()
    }

    fun dispose() { main.removeCallbacks(quietRelabel); closeSheet(); eng?.dispose(); eng = null }

    companion object {
        /** `res.comps` (keyed by record index) as a map. */
        fun compsOf(res: JSONObject): Map<Int, JSONObject> {
            val map = HashMap<Int, JSONObject>()
            res.optJSONObject("comps")?.let { c -> c.keys().forEach { k -> k.toIntOrNull()?.let { i -> c.optJSONObject(k)?.let { map[i] = it } } } }
            return map
        }
    }
}
