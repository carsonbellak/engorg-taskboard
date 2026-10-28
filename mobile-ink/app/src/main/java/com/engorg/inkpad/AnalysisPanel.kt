package com.engorg.inkpad

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Built-in drawing analysis, docked on the right of the notebook. It reads the focused pane's page —
 * class symbols and the wires between them — and analyses it with deterministic code (no AI):
 * circuits get node voltages, currents, meter readings and AC phasors; thermo flow diagrams are
 * recognised as Rankine / Brayton / refrigeration cycles (or a single device) and solved with
 * states numbered on the pipes; heat engine / refrigerator symbols get the second-law check.
 * The logic is ink-analysis.js, run by [AnalysisHost].
 *
 * Results draw straight onto the page ([FinishedStrokesView.annotations]) and re-run a moment after
 * every edit. Symbol values are edited through the shared [AnalysisEditor] (tap a symbol with the
 * select tool — panel open or not — or pick it from the Values list here); they're saved with the
 * symbol ([ShapeSpec.props]) and labelled beside it on the page, placed clear of the wiring.
 */
@SuppressLint("SetTextI18n")
class AnalysisPanel(
    private val act: Activity,
    private val host: FrameLayout,
    private val editor: AnalysisEditor,
    private val focusedPane: () -> PageCanvas?,
    private val onOpened: () -> Unit,
) {
    private val dens = act.resources.displayMetrics.density
    private fun dp(v: Int) = (v * dens).toInt()
    private val main = Handler(Looper.getMainLooper())
    private val onSurface get() = AppTheme.text
    private val muted get() = Color.argb(0xA8, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))

    private var pane: PageCanvas? = null
    private var page = 0
    private var runSeq = 0
    private var comps: Map<Int, JSONObject> = emptyMap()
    private var compRecs: List<FinishedStrokesView.Rec> = emptyList()   // the recs the comps' indices refer to
    private val rerun = Runnable { runNow() }

    private val frame = LinearLayout(act).apply {
        orientation = LinearLayout.VERTICAL
        background = GradientDrawable().apply {
            cornerRadius = dp(20).toFloat(); setColor(AppTheme.surface)
            setStroke(dp(1), Color.argb(0x2A, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
        }
        elevation = dp(14).toFloat()
        clipToOutline = true
        isClickable = true
    }
    private val subtitle = TextView(act)
    private val content = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(4), dp(14), dp(16)) }
    private var built = false

    val isOpen: Boolean get() = frame.parent != null
    var onClosed: (() -> Unit)? = null

    fun toggle() { if (isOpen) close() else open() }

    fun open() {
        if (!built) build()
        if (frame.parent == null) {
            val w = minOf(dp(400), (act.resources.displayMetrics.widthPixels * 0.46f).toInt())
            host.addView(frame, FrameLayout.LayoutParams(w, MATCH_PARENT).apply {
                gravity = Gravity.END or Gravity.TOP; rightMargin = dp(10); bottomMargin = dp(10)
            })
            SystemBars.marginTopBelowStatusBar(frame, dp(76))
        }
        onOpened()
        attach(focusedPane())
        runNow()
    }

    fun close() {
        detach()
        host.removeView(frame)
        onClosed?.invoke()
    }

    /** The engine belongs to [editor] (shared with tap-to-edit), so only the panel's own state goes. */
    fun dispose() { main.removeCallbacks(rerun); detach() }

    /** Is the panel showing (and keeping up to date) [pg] of [p]? */
    fun shows(p: PageCanvas, pg: Int): Boolean = isOpen && p === pane && pg == page

    /** The focused notebook changed: follow it. */
    fun onFocusChanged(p: PageCanvas) { if (isOpen && p !== pane) { attach(p); runNow() } }

    /** The pane scrolled to another page: analyse that one instead. */
    fun onPageChanged(p: PageCanvas) { if (isOpen && p === pane && p.currentPage().coerceAtLeast(0) != page) runNow() }

    private fun attach(p: PageCanvas?) {
        if (p === pane) return
        detach()
        pane = p ?: return
        p.onEdited = { pg -> if (pg == page) { main.removeCallbacks(rerun); main.postDelayed(rerun, 350) } }
    }

    private fun detach() {
        pane?.let { it.onEdited = null; it.finishedView.annotations = emptyList() }
        pane = null
    }

    // ---------- running ----------
    private fun runNow() {
        main.removeCallbacks(rerun)
        val p = pane ?: run { showMessage("Open a notebook page to analyse it."); return }
        val eng = editor.engine
        page = p.currentPage().coerceAtLeast(0)
        subtitle.text = "Page ${page + 1}"
        val recs = ArrayList(p.finishedView.pages.getOrNull(page)?.recs ?: return)
        val seq = ++runSeq
        eng.run(AnalysisHost.pageJson(recs)) { res ->
            if (seq != runSeq || pane !== p) return@run
            if (res == null) { showMessage("The analysis engine didn't load. Try closing and reopening the panel."); return@run }
            apply(p, page, recs, res)
        }
    }

    private fun apply(p: PageCanvas, pg: Int, recs: List<FinishedStrokesView.Rec>, res: JSONObject) {
        // Overlay on the page.
        val ann = ArrayList<FinishedStrokesView.Annot>()
        res.optJSONArray("annots")?.let { a ->
            for (k in 0 until a.length()) {
                val o = a.getJSONObject(k)
                ann.add(FinishedStrokesView.Annot(pg, o.optDouble("x").toFloat(), o.optDouble("y").toFloat(),
                    o.optString("text").replace("_", ""), o.optString("kind") == "badge", o.optString("tone", "v")))
            }
        }
        p.finishedView.annotations = ann
        // Components (by record index).
        val map = AnalysisEditor.compsOf(res)
        // Keep each symbol's drawn label (text + placement) in step with its values (not an undo
        // step); swapped-in records replace their old ones in the list, so the indices stay valid.
        val live = ArrayList(recs)
        editor.reconcile(p, pg, live, map)
        comps = map; compRecs = live
        editor.remember(p, pg, live, map)   // so a tap on the page opens its sheet straight away
        render(res, pg)
    }

    // ---------- chrome ----------
    private fun build() {
        built = true
        frame.addView(LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(10), dp(8), dp(8))
            addView(ImageView(act).apply {
                setImageBitmap(Icons.bitmap(Icons.ANALYZE, dp(20))); setColorFilter(AppTheme.accent)
                layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(8) }
            })
            addView(LinearLayout(act).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(act).apply { text = "Analyze"; textSize = 16f; setTextColor(onSurface); setTypeface(null, Typeface.BOLD) })
                addView(subtitle.apply { textSize = 12f; setTextColor(muted) })
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(smallBtn(Icons.REDO) { runNow() })
            addView(smallBtn(Icons.CLOSE) { close() })
        })
        frame.addView(ScrollView(act).apply { addView(content) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    }

    private fun smallBtn(path: String, onClick: () -> Unit) = ImageButton(act).apply {
        setImageBitmap(Icons.bitmap(path, dp(18))); setColorFilter(onSurface)
        background = pill(AppTheme.elevated); scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
        val pd = dp(6); setPadding(pd, pd, pd, pd)
        layoutParams = LinearLayout.LayoutParams(dp(32), dp(32)).apply { leftMargin = dp(6) }
        setOnClickListener { onClick() }
    }

    private fun pill(color: Int, radius: Int = 16): Drawable {
        val ripple = Color.argb(0x3A, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val bg = GradientDrawable().apply { cornerRadius = dp(radius).toFloat(); setColor(color) }
        val mask = GradientDrawable().apply { cornerRadius = dp(radius).toFloat(); setColor(Color.WHITE) }
        return RippleDrawable(ColorStateList.valueOf(ripple), bg, mask)
    }

    /** "T_H" → T with a subscript H, as in the textbook. */
    private fun rich(s: String): CharSequence = analysisRich(s)

    private fun showMessage(msg: String) {
        content.removeAllViews()
        content.addView(TextView(act).apply { text = msg; textSize = 14f; setTextColor(muted); setPadding(0, dp(12), 0, 0) })
    }

    // ---------- results ----------
    private fun render(res: JSONObject, pg: Int) {
        content.removeAllViews()
        val analyses = res.optJSONArray("analyses") ?: JSONArray()
        for (k in 0 until analyses.length()) {
            val a = analyses.getJSONObject(k)
            content.addView(TextView(act).apply {
                text = rich(a.optString("title")); textSize = 15f; setTypeface(null, Typeface.BOLD); setTextColor(onSurface)
                setPadding(0, dp(if (k == 0) 6 else 18), 0, dp(6))
            })
            val blocks = a.optJSONArray("blocks") ?: JSONArray()
            for (b in 0 until blocks.length()) renderBlock(blocks.getJSONObject(b))
        }
        // Components: a second way in to the value sheet (besides tapping the drawing).
        val editable = comps.entries.filter { (it.value.optJSONArray("fields")?.length() ?: 0) > 0 }.sortedBy { it.key }
        if (editable.isNotEmpty()) {
            content.addView(TextView(act).apply { text = "Values — tap a symbol on the page or here"; textSize = 13f; setTypeface(null, Typeface.BOLD); setTextColor(onSurface); setPadding(0, dp(18), 0, dp(6)) })
            for ((i, comp) in editable) {
                val rec = compRecs.getOrNull(i) ?: continue
                content.addView(TextView(act).apply {
                    val lab = comp.optString("label")
                    text = rich(comp.optString("name") + if (lab.isNotEmpty()) "  ·  $lab" else "  ·  set values")
                    textSize = 13.5f; setTextColor(onSurface); background = pill(AppTheme.elevated, 12)
                    setPadding(dp(12), dp(9), dp(12), dp(9))
                    layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(6) }
                    setOnClickListener { pane?.let { pp -> editor.edit(pp, pg, rec) } }
                })
            }
        }
    }

    private fun tint(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))

    private fun renderBlock(b: JSONObject) {
        when (b.optString("t")) {
            "warn", "err", "ok", "note" -> {
                val c = when (b.optString("t")) { "warn" -> Color.rgb(0xD9, 0x77, 0x06); "err" -> Color.rgb(0xDC, 0x26, 0x26); "ok" -> Color.rgb(0x05, 0x96, 0x69); else -> 0 }
                content.addView(TextView(act).apply {
                    text = rich(b.optString("text")); textSize = if (c == 0) 12f else 13f
                    setTextColor(if (c == 0) muted else onSurface)
                    if (c != 0) { background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(tint(c, 0x26)) }; setPadding(dp(10), dp(8), dp(10), dp(8)) }
                    else setPadding(0, dp(4), 0, dp(4))
                    layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(6) }
                })
            }
            "cards" -> {
                val items = b.optJSONArray("items") ?: return
                var row: LinearLayout? = null
                for (k in 0 until items.length()) {
                    if (k % 2 == 0) { row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }; content.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(6) }) }
                    val it = items.getJSONArray(k)
                    row!!.addView(LinearLayout(act).apply {
                        orientation = LinearLayout.VERTICAL
                        background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(AppTheme.elevated) }
                        setPadding(dp(10), dp(7), dp(10), dp(7))
                        addView(TextView(act).apply { text = rich(it.optString(0)); textSize = 11f; setTextColor(muted) })
                        addView(TextView(act).apply { text = rich(it.optString(1)); textSize = 15f; setTypeface(null, Typeface.BOLD); setTextColor(onSurface) })
                    }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { if (k % 2 == 0) rightMargin = dp(6) })
                }
                if (items.length() % 2 == 1) row?.addView(View(act), LinearLayout.LayoutParams(0, 1, 1f))
            }
            "table" -> {
                b.optString("title").takeIf { it.isNotEmpty() }?.let { t ->
                    content.addView(TextView(act).apply { text = rich(t); textSize = 12.5f; setTypeface(null, Typeface.BOLD); setTextColor(onSurface); setPadding(0, dp(8), 0, dp(4)) })
                }
                val table = TableLayout(act)
                fun row(cells: JSONArray, head: Boolean) = TableRow(act).apply {
                    for (k in 0 until cells.length()) addView(TextView(act).apply {
                        text = rich(cells.optString(k)); textSize = 12f
                        setTextColor(if (head) muted else onSurface); if (head) setTypeface(null, Typeface.BOLD)
                        setPadding(dp(4), dp(3), dp(10), dp(3))
                    })
                }
                b.optJSONArray("head")?.let { table.addView(row(it, true)) }
                b.optJSONArray("rows")?.let { r -> for (k in 0 until r.length()) table.addView(row(r.getJSONArray(k), false)) }
                content.addView(HorizontalScrollView(act).apply { isHorizontalScrollBarEnabled = false; addView(table) },
                    LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(6) })
            }
            "plot" -> {
                b.optString("title").takeIf { it.isNotEmpty() }?.let { t ->
                    content.addView(TextView(act).apply { text = t; textSize = 12.5f; setTypeface(null, Typeface.BOLD); setTextColor(onSurface); setPadding(0, dp(8), 0, dp(4)) })
                }
                content.addView(XYPlotView(act, b), LinearLayout.LayoutParams(MATCH_PARENT, dp(230)).apply { bottomMargin = dp(6) })
            }
        }
    }

    /**
     * A small XY plot for the results: polylines (the saturation dome, each process), labelled state
     * points and horizontal reference lines (reservoir temperatures). Data in plot units.
     */
    private class XYPlotView(ctx: Context, val spec: JSONObject) : View(ctx) {
        private val d = ctx.resources.displayMetrics.density
        private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND; strokeCap = Paint.Cap.ROUND }
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10f * d }

        private fun tone(t: String) = when (t) {
            "hot" -> Color.rgb(0xDC, 0x26, 0x26); "cold" -> Color.rgb(0x25, 0x63, 0xEB); "regen" -> Color.rgb(0x8B, 0x5C, 0xF6)
            "throttle" -> Color.rgb(0xD9, 0x77, 0x06); "dome" -> Color.argb(0x99, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text))
            else -> AppTheme.text
        }

        private fun ticks(lo: Double, hi: Double, n: Int): List<Double> {
            val step0 = (hi - lo) / n
            val mag = 10.0.pow(floor(log10(step0)))
            val step = listOf(1.0, 2.0, 2.5, 5.0, 10.0).map { it * mag }.first { it >= step0 }
            val out = ArrayList<Double>(); var v = ceil(lo / step) * step
            while (v <= hi + step * 1e-6) { out.add(v); v += step }
            return out
        }

        override fun onDraw(c: Canvas) {
            val polys = spec.optJSONArray("polys") ?: JSONArray()
            val pts = spec.optJSONArray("pts") ?: JSONArray()
            val hl = spec.optJSONArray("hlines") ?: JSONArray()
            var x0 = Double.MAX_VALUE; var x1 = -Double.MAX_VALUE; var y0 = Double.MAX_VALUE; var y1 = -Double.MAX_VALUE
            fun grow(x: Double, y: Double) { if (x.isFinite() && y.isFinite()) { x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y) } }
            for (k in 0 until polys.length()) { val a = polys.getJSONObject(k).optJSONArray("pts") ?: continue; for (j in 0 until a.length()) { val p = a.getJSONArray(j); grow(p.optDouble(0), p.optDouble(1)) } }
            for (k in 0 until pts.length()) { val p = pts.getJSONObject(k); grow(p.optDouble("x"), p.optDouble("y")) }
            for (k in 0 until hl.length()) { val y = hl.getJSONObject(k).optDouble("y"); if (y.isFinite()) { y0 = min(y0, y); y1 = max(y1, y) } }
            if (x0 > x1 || y0 > y1) return
            val px = (x1 - x0) * 0.06 + 1e-9; val py = (y1 - y0) * 0.08 + 1e-9
            x0 -= px; x1 += px; y0 -= py; y1 += py
            val L = 40f * d; val R = 8f * d; val T = 8f * d; val B = 26f * d
            val w = width - L - R; val h = height - T - B
            fun X(x: Double) = (L + (x - x0) / (x1 - x0) * w).toFloat()
            fun Y(y: Double) = (T + h - (y - y0) / (y1 - y0) * h).toFloat()
            val ink = AppTheme.text
            line.pathEffect = null; line.strokeWidth = 1f; line.color = Color.argb(0x22, Color.red(ink), Color.green(ink), Color.blue(ink))
            text.color = Color.argb(0xA0, Color.red(ink), Color.green(ink), Color.blue(ink))
            text.textAlign = Paint.Align.CENTER
            for (v in ticks(x0, x1, 5)) { c.drawLine(X(v), T, X(v), T + h, line); c.drawText(fmt(v), X(v), T + h + 13f * d, text) }
            text.textAlign = Paint.Align.RIGHT
            for (v in ticks(y0, y1, 5)) { c.drawLine(L, Y(v), L + w, Y(v), line); c.drawText(fmt(v), L - 4f * d, Y(v) + 3.5f * d, text) }
            text.textAlign = Paint.Align.CENTER
            c.drawText(spec.optString("xLabel"), L + w / 2f, height - 2f * d, text)
            text.textAlign = Paint.Align.LEFT
            c.drawText(spec.optString("yLabel"), L + 3f * d, T + 10f * d, text)
            for (k in 0 until polys.length()) {
                val o = polys.getJSONObject(k)
                val a = o.optJSONArray("pts") ?: continue
                if (a.length() < 2) continue
                val path = Path()
                for (j in 0 until a.length()) { val p = a.getJSONArray(j); val xx = X(p.optDouble(0)); val yy = Y(p.optDouble(1)); if (j == 0) path.moveTo(xx, yy) else path.lineTo(xx, yy) }
                val t = o.optString("tone")
                if (o.optBoolean("closed")) { path.close(); fill.color = Color.argb(0x14, Color.red(ink), Color.green(ink), Color.blue(ink)); c.drawPath(path, fill) }
                line.color = tone(t); line.strokeWidth = (if (t == "dome") 1.2f else 2.2f) * d
                line.pathEffect = if (o.optBoolean("dash")) DashPathEffect(floatArrayOf(6f * d, 4f * d), 0f) else null
                c.drawPath(path, line)
            }
            line.pathEffect = DashPathEffect(floatArrayOf(7f * d, 4f * d), 0f); line.strokeWidth = 1.2f * d
            for (k in 0 until hl.length()) {
                val o = hl.getJSONObject(k); val y = o.optDouble("y"); if (!y.isFinite()) continue
                line.color = tone(o.optString("tone")); c.drawLine(L, Y(y), L + w, Y(y), line)
                text.color = line.color; text.textAlign = Paint.Align.RIGHT
                c.drawText(o.optString("label").replace("_", ""), L + w - 2f * d, Y(y) - 3f * d, text)
            }
            line.pathEffect = null
            text.color = ink; text.textAlign = Paint.Align.LEFT; text.isFakeBoldText = true
            for (k in 0 until pts.length()) {
                val p = pts.getJSONObject(k)
                fill.color = AppTheme.accent
                c.drawCircle(X(p.optDouble("x")), Y(p.optDouble("y")), 3.5f * d, fill)
                c.drawText(p.optString("label"), X(p.optDouble("x")) + 5f * d, Y(p.optDouble("y")) - 4f * d, text)
            }
            text.isFakeBoldText = false
        }

        private fun fmt(v: Double): String = if (abs(v) >= 100 || v == 0.0) v.toInt().toString() else String.format("%.3g", v)
    }
}
