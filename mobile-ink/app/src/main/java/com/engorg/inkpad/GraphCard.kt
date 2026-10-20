package com.engorg.inkpad

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * A live graph on a notebook page (the GRAPH shape): the grapher's expressions and view, drawn the
 * way the grapher window shows them — grid, labelled axes, colored curves and shading (or the 3D
 * view), optionally with the typeset expression list beside it. It stays vector (crisp at any zoom,
 * in PDFs too) and can be reopened in the grapher with "Edit graph".
 *
 * Immutable: editing makes a new card. The computed geometry is cached on the instance, so moving
 * a card never recomputes it; resizing recomputes only when the visible range changes.
 */
class GraphCard(
    val dim3: Boolean,
    val rows: List<GraphRow>,
    val degrees: Boolean,
    val cx: Double, val cy: Double, val units: Double,        // 2D: view center + x-units across the plot
    val yaw: Double, val pitch: Double, val range: Double,   // 3D camera
    val legend: Boolean,
) {
    @Volatile internal var model: GraphModel? = null
    /** The rows' parses for typesetting the legend before [model] is ready (built on first draw). */
    internal var legendParsed: List<MathEngine.Statement?>? = null
    @Volatile internal var scene2: Scene? = null
    @Volatile internal var scene2Key: String? = null
    @Volatile internal var scene3: Scene3? = null
    @Volatile internal var computing = false
    internal val waiting = ArrayList<() -> Unit>()

    fun withLegend(on: Boolean) = GraphCard(dim3, rows, degrees, cx, cy, units, yaw, pitch, range, on)

    fun toJson(): JSONObject {
        val arr = JSONArray()
        for (r in rows) arr.put(JSONObject().put("t", r.text).put("c", r.color).put("h", r.hidden)
            .put("tmin", r.tMin).put("tmax", r.tMax).put("umin", r.uMin).put("umax", r.uMax).put("vmin", r.vMin).put("vmax", r.vMax))
        return JSONObject().put("d3", dim3).put("rows", arr).put("deg", degrees)
            .put("cx", cx).put("cy", cy).put("u", units).put("yaw", yaw).put("pitch", pitch).put("range", range).put("leg", legend)
    }

    companion object {
        fun copyRows(src: List<GraphRow>) = src.map { GraphRow(it.text, it.color, it.hidden, it.sMin, it.sMax, it.tMin, it.tMax, it.uMin, it.uMax, it.vMin, it.vMax) }

        fun fromJson(o: JSONObject?): GraphCard? {
            if (o == null) return null
            return try {
                val arr = o.optJSONArray("rows") ?: JSONArray()
                val rows = (0 until arr.length()).map { i ->
                    val r = arr.getJSONObject(i)
                    GraphRow(r.optString("t", ""), r.optInt("c", Color.BLACK), r.optBoolean("h", false), -10.0, 10.0,
                        r.optString("tmin", "0"), r.optString("tmax", "2pi"), r.optString("umin", "0"), r.optString("umax", "2pi"),
                        r.optString("vmin", "0"), r.optString("vmax", "pi"))
                }
                GraphCard(o.optBoolean("d3", false), rows, o.optBoolean("deg", false),
                    o.optDouble("cx", 0.0), o.optDouble("cy", 0.0), o.optDouble("u", 20.0).takeIf { it > 0 } ?: 20.0,
                    o.optDouble("yaw", Graph3DView.DEFAULT_YAW), o.optDouble("pitch", Graph3DView.DEFAULT_PITCH),
                    o.optDouble("range", Graph3DView.DEFAULT_RANGE).takeIf { it > 0 } ?: Graph3DView.DEFAULT_RANGE,
                    o.optBoolean("leg", true))
            } catch (_: Exception) { null }
        }
    }
}

/** Draws [GraphCard]s on a page canvas (page units) and computes their geometry in the background. */
object GraphCardRenderer {
    private val exec = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val r3 = Render3D()

    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
    private val path = Path()
    private val clipPath = Path()

    private class Theme(val bg: Int, val ink: Int)
    private fun theme(dark: Boolean) = cardColors(dark).let { Theme(it.first, it.second) }

    /** Background and ink of a graph on light or dark paper (shared with the live window, GraphPane). */
    @Suppress("UNUSED_PARAMETER")
    fun cardColors(dark: Boolean): Pair<Int, Int> = AppTheme.surface to AppTheme.text   // follow the app's theme

    /** Where a card's Edit button sits (page units), bottom left. */
    fun editButtonRect(box: RectF): RectF = RectF(box.left + 8f, box.bottom - 8f - 26f, box.left + 8f + 66f, box.bottom - 8f)

    /** Width of the expression list on a card [boxW] page units wide (the live window matches it). */
    fun legendWidth(boxW: Float): Float = (boxW * 0.34f).coerceIn(min(150f, boxW * 0.5f), boxW * 0.5f)
    private fun alpha(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))
    private fun lum(c: Int) = (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) / 255.0

    /** A row color that would vanish on this card (near-white on a light card, near-black on dark) becomes the ink. */
    private fun visible(c: Int, t: Theme): Int = when {
        lum(t.bg) > 0.5 && lum(c) > 0.85 -> t.ink
        lum(t.bg) <= 0.5 && lum(c) < 0.15 -> t.ink
        else -> c
    }

    /** Split [box] into the legend column (or null) and the plot area. */
    private fun layout(card: GraphCard, box: RectF): Pair<RectF?, RectF> {
        if (!card.legend) return null to RectF(box)
        val lw = legendWidth(box.width())
        return RectF(box.left, box.top, box.left + lw, box.bottom) to RectF(box.left + lw, box.top, box.right, box.bottom)
    }

    /** The 2D view region for a plot area of [plot] size. */
    private fun viewport(card: GraphCard, plot: RectF): Viewport {
        val ppu = plot.width() / card.units
        val hw = plot.width() / 2.0 / ppu; val hh = plot.height() / 2.0 / ppu
        // Sample as if the plot were ~3× its page size, so curves stay smooth when you zoom the page in.
        return Viewport(card.cx - hw, card.cx + hw, card.cy - hh, card.cy + hh, (plot.width() * 3).toInt().coerceAtLeast(60), (plot.height() * 3).toInt().coerceAtLeast(40))
    }

    private fun keyOf(v: Viewport) = "%.6g,%.6g,%.6g,%.6g".format(v.x0, v.x1, v.y0, v.y1)

    /** Compute whatever [card] still needs for a plot area [plot]: inline when [sync], else in the background. */
    private fun ensure(card: GraphCard, plot: RectF, sync: Boolean, onReady: () -> Unit): Boolean {
        val vp = if (card.dim3) null else viewport(card, plot)
        val key = vp?.let { keyOf(it) }
        fun ready() = card.model != null && (if (card.dim3) card.scene3 != null else card.scene2 != null && card.scene2Key == key)
        if (ready()) return true
        fun work() {
            val m = card.model ?: GraphModel.build(card.rows, card.degrees, card.dim3).also { card.model = it }
            if (card.dim3) { if (card.scene3 == null) card.scene3 = Graph3Compute.compute(m, card.range, 1.2f) { false } }
            else if (vp != null && card.scene2Key != key) { card.scene2 = GraphCompute.compute(m, vp, -1) { false }; card.scene2Key = key }
        }
        if (sync) { try { work() } catch (_: Throwable) { }; return ready() }
        synchronized(card.waiting) { card.waiting.add(onReady) }
        if (!card.computing) {
            card.computing = true
            exec.execute {
                try { work() } catch (_: Throwable) { }
                main.post {
                    card.computing = false
                    val cbs = synchronized(card.waiting) { ArrayList(card.waiting).also { card.waiting.clear() } }
                    cbs.forEach { it() }
                }
            }
        }
        return false
    }

    /**
     * Draw [card] filling [box] (page units). [dark] picks the card theme to suit the paper. [sync]
     * computes missing geometry right away (PDF export / snapshots); otherwise the card shows its frame
     * and grid immediately and [onReady] fires when the curves are ready.
     */
    fun draw(c: Canvas, card: GraphCard, box: RectF, dark: Boolean, sync: Boolean, onReady: () -> Unit) {
        val t = theme(dark)
        val radius = min(10f, min(box.width(), box.height()) * 0.06f)
        c.save()
        clipPath.reset(); clipPath.addRoundRect(box, radius, radius, Path.Direction.CW)
        c.clipPath(clipPath)
        bgPaint.color = t.bg; c.drawRect(box, bgPaint)
        val (leg, plot) = layout(card, box)
        val ready = ensure(card, plot, sync, onReady)
        if (card.dim3) {
            val unit = 1f   // one page unit per grapher dp, like the live window
            r3.draw(c, if (ready) card.scene3 else null, card.yaw, card.pitch, card.range, plot, Render3D.Style(t.bg, t.ink, unit))
        } else draw2d(c, card, plot, t, if (ready) card.scene2 else null)
        if (leg != null) drawLegend(c, card, leg, t)
        // The Edit button (not in exports: [sync] is only set when rendering a PDF / snapshot).
        if (!sync) {
            val b = editButtonRect(box)
            fill.color = AppTheme.accent; c.drawRoundRect(b, 13f, 13f, fill)
            text.textSize = 12.5f; text.textAlign = Paint.Align.CENTER; text.color = AppTheme.onAccent()
            text.typeface = android.graphics.Typeface.DEFAULT_BOLD
            c.drawText("✎  Edit", b.centerX(), b.centerY() + 4.5f, text)
            text.typeface = null
        }
        c.restore()
        line.style = Paint.Style.STROKE; line.pathEffect = null
        line.color = alpha(t.ink, 0x38); line.strokeWidth = 1f
        c.drawRoundRect(box, radius, radius, line)
    }

    // ---------------------------------------------------------------- 2D
    private fun niceStep(raw: Double): Double {
        val e = floor(log10(raw)); val b = 10.0.pow(e); val f = raw / b
        return b * when { f < 1.5 -> 1.0; f < 3.5 -> 2.0; f < 7.5 -> 5.0; else -> 10.0 }
    }
    private fun mantissa(step: Double): Int { val f = step / 10.0.pow(floor(log10(step))); return Math.rint(f).toInt() }
    private fun tickText(v: Double, step: Double): String {
        if (v == 0.0) return "0"
        val a = abs(step)
        if (a >= 1e5 || a < 1e-4) return MathEngine.fmt(v, 4)
        val d = max(0, ceil(-log10(a) - 1e-9).toInt())
        return ("%.${d}f".format(v)).replace("-", "−")
    }

    private fun draw2d(c: Canvas, card: GraphCard, r: RectF, t: Theme, scene: Scene?) {
        val ppu = r.width() / card.units
        fun sx(x: Double) = (r.centerX() + (x - card.cx) * ppu).coerceIn(-1e6, 1e6).toFloat()
        fun sy(y: Double) = (r.centerY() - (y - card.cy) * ppu).coerceIn(-1e6, 1e6).toFloat()
        val x0 = card.cx - r.width() / 2 / ppu; val x1 = card.cx + r.width() / 2 / ppu
        val y0 = card.cy - r.height() / 2 / ppu; val y1 = card.cy + r.height() / 2 / ppu
        c.save(); c.clipRect(r)
        val u = 1f   // one page unit per grapher dp, like the live window
        val major = niceStep(105.0 * u / ppu)
        val minor = major / (if (mantissa(major) == 2) 4 else 5)
        fun grid(step: Double, a: Int) {
            line.color = alpha(t.ink, a); line.strokeWidth = 0.6f * u; line.strokeCap = Paint.Cap.BUTT
            val kx0 = ceil(x0 / step).toLong(); val kx1 = floor(x1 / step).toLong()
            if (kx1 - kx0 < 400) for (k in kx0..kx1) { val x = sx(k * step); c.drawLine(x, r.top, x, r.bottom, line) }
            val ky0 = ceil(y0 / step).toLong(); val ky1 = floor(y1 / step).toLong()
            if (ky1 - ky0 < 400) for (k in ky0..ky1) { val y = sy(k * step); c.drawLine(r.left, y, r.right, y, line) }
            line.strokeCap = Paint.Cap.ROUND
        }
        grid(minor, 0x12); grid(major, 0x2C)
        line.color = alpha(t.ink, 0xC0); line.strokeWidth = 1.1f * u
        val ax = sx(0.0); val ay = sy(0.0)
        if (ax in r.left..r.right) c.drawLine(ax, r.top, ax, r.bottom, line)
        if (ay in r.top..r.bottom) c.drawLine(r.left, ay, r.right, ay, line)

        if (scene != null) {
            fun build(a: DoubleArray): Boolean {
                path.reset(); if (a.size < 4) return false
                path.moveTo(sx(a[0]), sy(a[1]))
                var i = 2; while (i < a.size) { path.lineTo(sx(a[i]), sy(a[i + 1])); i += 2 }
                return true
            }
            for (f in scene.fills) {
                fill.color = alpha(visible(f.color, t), 0x38)
                for (poly in f.polys) if (build(poly)) { path.close(); c.drawPath(path, fill) }
                val rr = f.rects
                if (rr != null) {
                    path.reset(); var i = 0
                    while (i + 3 < rr.size) { path.addRect(sx(rr[i]), sy(rr[i + 3]), sx(rr[i + 2]), sy(rr[i + 1]), Path.Direction.CW); i += 4 }
                    c.drawPath(path, fill)
                }
            }
            line.strokeWidth = 2.1f * u
            val dash = DashPathEffect(floatArrayOf(7f * u, 5f * u), 0f)
            for (cv in scene.curves) {
                line.color = visible(cv.color, t); line.pathEffect = if (cv.dashed) dash else null
                for (l in cv.lines) if (build(l)) c.drawPath(path, line)
            }
            line.pathEffect = null
            for (d in scene.dots) {
                fill.color = visible(d.color, t); c.drawCircle(sx(d.x), sy(d.y), 3.6f * u, fill)
                label(c, "(" + MathEngine.fmt(d.x, 4) + ", " + MathEngine.fmt(d.y, 4) + ")", sx(d.x) + 6f * u, sy(d.y) - 6f * u, Paint.Align.LEFT, 8.5f * u, t)
            }
        }
        // tick labels
        val th = 8.5f * u; val pad = 3f * u
        val base = (ay + th + pad).coerceIn(r.top + th + pad, r.bottom - pad)
        val kx0 = ceil(x0 / major).toLong(); val kx1 = floor(x1 / major).toLong()
        if (kx1 - kx0 < 120) for (k in kx0..kx1) {
            if (k == 0L) continue
            val x = sx(k * major); if (x < r.left + 8f * u || x > r.right - 8f * u) continue
            label(c, tickText(k * major, major), x, base, Paint.Align.CENTER, th, t)
        }
        val ky0 = ceil(y0 / major).toLong(); val ky1 = floor(y1 / major).toLong()
        if (ky1 - ky0 < 120) for (k in ky0..ky1) {
            if (k == 0L) continue
            val y = sy(k * major); if (y < r.top + th || y > r.bottom - pad) continue
            val s = tickText(k * major, major)
            text.textSize = th; val w = text.measureText(s)
            when {
                ax - pad - w < r.left + pad -> label(c, s, r.left + pad, y + th / 3, Paint.Align.LEFT, th, t)
                ax > r.right - pad -> label(c, s, r.right - pad, y + th / 3, Paint.Align.RIGHT, th, t)
                else -> label(c, s, ax - pad, y + th / 3, Paint.Align.RIGHT, th, t)
            }
        }
        c.restore()
    }

    private fun label(c: Canvas, s: String, x: Float, y: Float, align: Paint.Align, size: Float, t: Theme) {
        text.textSize = size; halo.textSize = size; halo.strokeWidth = size * 0.3f
        text.textAlign = align; halo.textAlign = align
        text.color = alpha(t.ink, 0xD8); halo.color = t.bg
        c.drawText(s, x, y, halo); c.drawText(s, x, y, text)
    }

    // ---------------------------------------------------------------- legend
    private fun drawLegend(c: Canvas, card: GraphCard, r: RectF, t: Theme) {
        fill.color = alpha(t.ink, 0x08); c.drawRect(r, fill)
        line.color = alpha(t.ink, 0x22); line.strokeWidth = 1f
        c.drawLine(r.right, r.top, r.right, r.bottom, line)
        val m = card.model
        // Typeset from the first frame: the full model is computed in the background, but parsing is instant.
        val parsed = m?.parsed ?: card.legendParsed ?: GraphModel.parseRows(card.rows, card.dim3).also { card.legendParsed = it }
        val pad = 8f
        val dotR = 5f
        val size = 15f
        var y = r.top + pad
        c.save(); c.clipRect(r)
        for ((i, row) in card.rows.withIndex()) {
            if (row.text.isBlank()) continue
            val st = parsed.getOrNull(i)
            val status = m?.statuses?.getOrNull(i)
            val box = st?.let { runCatching { MathTypeset.layout(it, size) }.getOrNull() }
            val tx = r.left + pad + dotR * 2 + 6f
            val avail = r.right - pad - tx
            val k = if (box != null) min(1f, avail / max(1f, box.w)) else 1f
            val h = if (box != null) (box.asc + box.desc) * k else size * 1.2f
            val rowH = max(h, dotR * 2) + 4f
            if (y + rowH > r.bottom - pad) break
            val cyRow = y + rowH / 2
            fill.color = visible(row.color, t)
            if (row.hidden) { line.color = fill.color; line.strokeWidth = 1.2f; c.drawCircle(r.left + pad + dotR, cyRow, dotR, line) }
            else c.drawCircle(r.left + pad + dotR, cyRow, dotR, fill)
            if (box != null) {
                c.save(); c.translate(tx, cyRow + (box.asc - box.desc) * k / 2); c.scale(k, k)
                MathTypeset.draw(c, box, 0f, 0f, t.ink); c.restore()
            } else {
                text.textSize = size * 0.9f; text.textAlign = Paint.Align.LEFT; text.color = t.ink
                c.drawText(row.text, tx, cyRow + size * 0.3f, text)
            }
            y += rowH
            // A computed value (an integral, a constant) goes underneath in a smaller, muted line.
            val info = status?.takeIf { !it.error && (it.kind == RowKind.VALUE || it.kind == RowKind.CONST || it.kind == RowKind.POINT) }?.info
            if (!info.isNullOrBlank() && y + 12f < r.bottom - pad) {
                text.textSize = 9.5f; text.color = alpha(t.ink, 0xA8); text.textAlign = Paint.Align.LEFT
                c.drawText(info, tx, y + 9f, text); y += 12f
            }
            y += 4f
        }
        c.restore()
    }

    // ---------------------------------------------------------------- strokes (desktop mirror)
    /** The card as plain strokes in page coordinates (frame, axes, curves) for viewers that can't draw cards. */
    fun strokes(card: GraphCard, box: RectF): List<Pair<Int, List<PointF>>> {
        val out = ArrayList<Pair<Int, List<PointF>>>()
        out.add(Color.GRAY to listOf(PointF(box.left, box.top), PointF(box.right, box.top), PointF(box.right, box.bottom), PointF(box.left, box.bottom), PointF(box.left, box.top)))
        val (_, plot) = layout(card, box)
        if (card.dim3) {
            val s = card.scene3 ?: return out
            for (g in Render3D().exportInk(s, card.yaw, card.pitch, card.range, plot.width(), plot.height())) {
                if (g.kind != GraphInk.FREE) continue
                out.add((if (g.color == GraphInk.AXIS) Color.DKGRAY else g.color) to g.pts.map { PointF(plot.left + it.x, plot.top + it.y) })
            }
            return out
        }
        val s = card.scene2 ?: return out
        val ppu = plot.width() / card.units
        fun px(x: Double) = (plot.centerX() + (x - card.cx) * ppu).toFloat()
        fun py(y: Double) = (plot.centerY() - (y - card.cy) * ppu).toFloat()
        val ax = px(0.0); val ay = py(0.0)
        if (ay in plot.top..plot.bottom) out.add(Color.DKGRAY to listOf(PointF(plot.left, ay), PointF(plot.right, ay)))
        if (ax in plot.left..plot.right) out.add(Color.DKGRAY to listOf(PointF(ax, plot.top), PointF(ax, plot.bottom)))
        for (cv in s.curves) for (l in cv.lines) {
            var cur = ArrayList<PointF>()
            var i = 0
            while (i < l.size) {
                val p = PointF(px(l[i]), py(l[i + 1]))
                if (p.x in plot.left..plot.right && p.y in plot.top..plot.bottom) cur.add(p)
                else { if (cur.size >= 2) out.add(cv.color to cur); cur = ArrayList() }
                i += 2
            }
            if (cur.size >= 2) out.add(cv.color to cur)
        }
        return out
    }
}
