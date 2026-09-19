package com.engorg.inkpad

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.view.View
import androidx.ink.rendering.android.canvas.CanvasStrokeRenderer
import androidx.ink.strokes.Stroke

/**
 * Continuous multi-page document (8.5x11 pages stacked vertically with a gap) drawn on a backdrop.
 * Everything renders through one scale+translate transform (zoom + pan). Strokes are stored in
 * PAGE-LOCAL coordinates per page, so they always live ON their page and move with it. Also draws
 * the selection box / vertex handles / lasso overlay for the editing tools.
 */
class FinishedStrokesView(context: Context) : View(context) {

    enum class PaperStyle { PLAIN, GRID, RULED, DOTS }

    /** One drawable object on a page: freehand ink (shape == null) or a parametric shape. */
    class Rec(
        val strokes: List<Stroke>,
        var points: List<PointF>,   // page-local, for erase / selection / bounds
        val highlighter: Boolean,
        val shape: ShapeSpec?,
        val colorArgb: Int,
        val sizePx: Float,
    )

    class Page(val recs: ArrayList<Rec> = ArrayList())

    companion object {
        const val PAGE_W = 816f   // 8.5in * 96
        const val PAGE_H = 1056f  // 11in  * 96
        const val GAP = 56f       // space between stacked pages (world units)
    }

    private val renderer = CanvasStrokeRenderer.create()

    var pages: List<Page> = listOf(Page())
        set(value) { field = value; invalidate() }

    var paperStyle = PaperStyle.GRID
        set(v) { field = v; invalidate() }
    var pageColor = Color.WHITE
        set(v) { field = v; invalidate() }
    var backdrop = Color.rgb(0xE9, 0xEA, 0xEC)
    var accent = Color.rgb(0x81, 0x8C, 0xF8)

    var scale = 1f; private set
    var tx = 0f; private set
    var ty = 0f; private set

    // selection / overlay (page-local coords on selPage)
    private var selPage = -1
    private var selBox: RectF? = null
    private var vertexHandles: List<PointF>? = null
    private var lasso: List<PointF>? = null   // screen coords

    private val paperPaint = Paint().apply { isAntiAlias = true }
    private val pagePaint = Paint().apply { isAntiAlias = true }
    private val shadowPaint = Paint().apply { isAntiAlias = true; color = Color.argb(50, 0, 0, 0) }
    private val borderPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 1f; color = Color.argb(40, 0, 0, 0) }
    private val selPaint = Paint().apply {
        isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f
        pathEffect = DashPathEffect(floatArrayOf(10f, 8f), 0f)
    }
    private val handleFill = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL; color = Color.WHITE }
    private val handleStroke = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f }
    private val lassoPaint = Paint().apply {
        isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f
        pathEffect = DashPathEffect(floatArrayOf(8f, 6f), 0f)
    }
    private val delPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL; color = Color.rgb(0xE5, 0x3E, 0x3E) }
    private val delX = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 3f; color = Color.WHITE }

    fun setTransform(s: Float, x: Float, y: Float) { scale = s; tx = x; ty = y; invalidate() }

    fun pageTop(i: Int) = i * (PAGE_H + GAP)
    fun docHeight(): Float = if (pages.isEmpty()) PAGE_H else pages.size * (PAGE_H + GAP) - GAP

    fun setSelection(page: Int, box: RectF?, handles: List<PointF>?) {
        selPage = page; selBox = box; vertexHandles = handles; invalidate()
    }
    fun clearSelection() { selPage = -1; selBox = null; vertexHandles = null; invalidate() }
    fun setLasso(pts: List<PointF>?) { lasso = pts; invalidate() }

    /** Remove any rec on [page] with a point within [radius] of (x,y). Returns true if changed. */
    fun eraseNear(page: Int, x: Float, y: Float, radius: Float): Boolean {
        if (page < 0 || page >= pages.size) return false
        val r2 = radius * radius
        val recs = pages[page].recs
        val before = recs.size
        recs.removeAll { rec -> rec.points.any { val dx = it.x - x; val dy = it.y - y; dx * dx + dy * dy <= r2 } }
        val changed = recs.size != before
        if (changed) invalidate()
        return changed
    }

    private fun pageMatrix(i: Int): Matrix = Matrix().apply {
        setScale(scale, scale); postTranslate(tx, ty); preTranslate(0f, pageTop(i))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(backdrop)
        val vh = height.toFloat()
        for (i in pages.indices) {
            val l = tx
            val t = ty + scale * pageTop(i)
            val r = tx + PAGE_W * scale
            val b = t + PAGE_H * scale
            if (b < -4f || t > vh + 4f) continue // cull off-screen pages
            canvas.drawRect(l + 5, t + 7, r + 5, b + 7, shadowPaint)
            pagePaint.color = pageColor
            canvas.drawRect(l, t, r, b, pagePaint)
            val save = canvas.save()
            canvas.clipRect(l, t, r, b)
            drawPaper(canvas, l, t)
            val m = pageMatrix(i)
            for (rec in pages[i].recs) for (s in rec.strokes) renderer.draw(canvas, s, m)
            canvas.restoreToCount(save)
            canvas.drawRect(l, t, r, b, borderPaint)
        }
        drawOverlay(canvas)
    }

    private fun drawPaper(canvas: Canvas, l: Float, t: Float) {
        if (paperStyle == PaperStyle.PLAIN) return
        val sp = 32f
        val lum = 0.299 * Color.red(pageColor) + 0.587 * Color.green(pageColor) + 0.114 * Color.blue(pageColor)
        paperPaint.color = if (lum < 128) Color.argb(46, 255, 255, 255) else Color.argb(30, 30, 50, 90)
        val bottom = t + PAGE_H * scale
        val right = l + PAGE_W * scale
        when (paperStyle) {
            PaperStyle.GRID -> {
                paperPaint.style = Paint.Style.STROKE; paperPaint.strokeWidth = 1f
                var xw = sp; while (xw < PAGE_W) { val xs = l + xw * scale; canvas.drawLine(xs, t, xs, bottom, paperPaint); xw += sp }
                var yw = sp; while (yw < PAGE_H) { val ys = t + yw * scale; canvas.drawLine(l, ys, right, ys, paperPaint); yw += sp }
            }
            PaperStyle.RULED -> {
                paperPaint.style = Paint.Style.STROKE; paperPaint.strokeWidth = 1f
                var yw = sp; while (yw < PAGE_H) { val ys = t + yw * scale; canvas.drawLine(l, ys, right, ys, paperPaint); yw += sp }
            }
            PaperStyle.DOTS -> {
                paperPaint.style = Paint.Style.FILL
                var yw = sp
                while (yw < PAGE_H) {
                    var xw = sp
                    while (xw < PAGE_W) { canvas.drawCircle(l + xw * scale, t + yw * scale, 1.6f, paperPaint); xw += sp }
                    yw += sp
                }
            }
            else -> {}
        }
    }

    private fun sx(page: Int, x: Float) = tx + scale * x
    private fun sy(page: Int, y: Float) = ty + scale * (pageTop(page) + y)

    private fun drawOverlay(canvas: Canvas) {
        lasso?.let { pts ->
            if (pts.size > 1) {
                lassoPaint.color = accent
                val p = Path(); p.moveTo(pts[0].x, pts[0].y)
                for (k in 1 until pts.size) p.lineTo(pts[k].x, pts[k].y)
                canvas.drawPath(p, lassoPaint)
            }
        }
        val box = selBox ?: return
        selPaint.color = accent; handleStroke.color = accent
        val l = sx(selPage, box.left); val t = sy(selPage, box.top)
        val r = sx(selPage, box.right); val b = sy(selPage, box.bottom)
        canvas.drawRect(l, t, r, b, selPaint)
        // corner resize handles
        val hr = 11f
        for (c in listOf(floatArrayOf(l, t), floatArrayOf(r, t), floatArrayOf(r, b), floatArrayOf(l, b))) {
            canvas.drawCircle(c[0], c[1], hr, handleFill)
            canvas.drawCircle(c[0], c[1], hr, handleStroke)
        }
        // delete button (top-right, offset out)
        val dcx = r + 20f; val dcy = t - 20f
        canvas.drawCircle(dcx, dcy, 15f, delPaint)
        canvas.drawLine(dcx - 6, dcy - 6, dcx + 6, dcy + 6, delX)
        canvas.drawLine(dcx - 6, dcy + 6, dcx + 6, dcy - 6, delX)
        // vertex handles (only for a single selected shape)
        vertexHandles?.let { hs ->
            for (h in hs) {
                val hx = sx(selPage, h.x); val hy = sy(selPage, h.y)
                canvas.drawCircle(hx, hy, 12f, handleFill)
                canvas.drawCircle(hx, hy, 12f, handleStroke)
            }
        }
    }
}
