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

/**
 * Continuous multi-page document (8.5x11 pages stacked vertically with a gap) drawn on a backdrop.
 * Everything renders through one scale+translate transform (zoom + pan). Strokes are stored in
 * PAGE-LOCAL coordinates per page and drawn with plain Canvas paths (no native ink renderer), so
 * what you see while drawing is exactly what persists, glued to its page under pan/zoom.
 */
class FinishedStrokesView(context: Context) : View(context) {

    enum class PaperStyle { PLAIN, GRID, RULED, DOTS }

    /** One drawable object on a page: freehand ink (shape == null) or a parametric shape. */
    class Rec(
        val paths: List<Path>,      // page-local smoothed paths (one for freehand, several for shapes)
        var points: List<PointF>,   // page-local, for erase / selection / bounds
        val color: Int,
        val widthPx: Float,         // page units
        val highlighter: Boolean,
        val shape: ShapeSpec?,
    )

    class Page(val recs: ArrayList<Rec> = ArrayList())

    companion object {
        const val PAGE_W = 816f   // 8.5in * 96
        const val PAGE_H = 1056f  // 11in  * 96
        const val GAP = 56f       // space between stacked pages (world units)
        const val ADD_TILE_H = 150f

        /** Catmull-Rom smoothed path through page-local points (for handwriting). */
        fun buildPath(pts: List<PointF>): Path {
            val p = Path()
            if (pts.isEmpty()) return p
            if (pts.size == 1) { p.addCircle(pts[0].x, pts[0].y, 0.6f, Path.Direction.CW); return p }
            if (pts.size == 2) { p.moveTo(pts[0].x, pts[0].y); p.lineTo(pts[1].x, pts[1].y); return p }
            p.moveTo(pts[0].x, pts[0].y)
            for (i in 0 until pts.size - 1) {
                val p0 = pts[if (i == 0) 0 else i - 1]
                val p1 = pts[i]
                val p2 = pts[i + 1]
                val p3 = pts[if (i + 2 < pts.size) i + 2 else pts.size - 1]
                val c1x = p1.x + (p2.x - p0.x) / 6f; val c1y = p1.y + (p2.y - p0.y) / 6f
                val c2x = p2.x - (p3.x - p1.x) / 6f; val c2y = p2.y - (p3.y - p1.y) / 6f
                p.cubicTo(c1x, c1y, c2x, c2y, p2.x, p2.y)
            }
            return p
        }

        /** Straight-segment path (for shapes, so corners stay sharp). */
        fun buildStraightPath(pts: List<PointF>): Path {
            val p = Path()
            if (pts.isEmpty()) return p
            p.moveTo(pts[0].x, pts[0].y)
            for (i in 1 until pts.size) p.lineTo(pts[i].x, pts[i].y)
            return p
        }
    }

    var pages: List<Page> = listOf(Page())
        set(value) { field = value; invalidate() }

    var paperStyle = PaperStyle.GRID
        set(v) { field = v; invalidate() }
    var pageColor = Color.WHITE
        set(v) { field = v; invalidate() }
    var backdrop = Color.rgb(0xE9, 0xEA, 0xEC)
    var accent = Color.rgb(0x81, 0x8C, 0xF8)
    var textColor = Color.rgb(0x3A, 0x41, 0x4E)
    var showAddPage = true
    private var addRectScreen: RectF? = null
    fun addPageRectScreen(): RectF? = addRectScreen

    var scale = 1f; private set
    var tx = 0f; private set
    var ty = 0f; private set

    private var selPage = -1
    private var selBox: RectF? = null
    private var vertexHandles: List<PointF>? = null
    private var lasso: List<PointF>? = null

    private val strokePaint = Paint().apply { isAntiAlias = true; isDither = true; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val paperPaint = Paint().apply { isAntiAlias = true }
    private val pagePaint = Paint().apply { isAntiAlias = true }
    private val shadowPaint = Paint().apply { isAntiAlias = true; color = Color.argb(50, 0, 0, 0) }
    private val borderPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 1f; color = Color.argb(40, 0, 0, 0) }
    private val selPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f; pathEffect = DashPathEffect(floatArrayOf(10f, 8f), 0f) }
    private val handleFill = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL; color = Color.WHITE }
    private val handleStroke = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f }
    private val lassoPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f; pathEffect = DashPathEffect(floatArrayOf(8f, 6f), 0f) }
    private val delPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL; color = Color.rgb(0xE5, 0x3E, 0x3E) }
    private val delX = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 3f; color = Color.WHITE }
    private val addTilePaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 3f; pathEffect = DashPathEffect(floatArrayOf(16f, 12f), 0f) }
    private val addTileText = Paint().apply { isAntiAlias = true; textAlign = Paint.Align.CENTER; typeface = android.graphics.Typeface.DEFAULT_BOLD }

    fun setTransform(s: Float, x: Float, y: Float) { scale = s; tx = x; ty = y; invalidate() }

    fun pageTop(i: Int) = i * (PAGE_H + GAP)
    fun docHeight(): Float = if (pages.isEmpty()) PAGE_H else pages.size * (PAGE_H + GAP) - GAP
    fun contentHeight(): Float = docHeight() + if (showAddPage) GAP + ADD_TILE_H else 0f

    fun setSelection(page: Int, box: RectF?, handles: List<PointF>?) { selPage = page; selBox = box; vertexHandles = handles; invalidate() }
    fun clearSelection() { selPage = -1; selBox = null; vertexHandles = null; invalidate() }
    fun setLasso(pts: List<PointF>?) { lasso = pts; invalidate() }

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

    private fun pageMatrix(i: Int): Matrix = Matrix().apply { setScale(scale, scale); postTranslate(tx, ty); preTranslate(0f, pageTop(i)) }

    private fun drawRecs(canvas: Canvas, page: Page) {
        for (rec in page.recs) {
            strokePaint.color = if (rec.highlighter)
                Color.argb(0x66, Color.red(rec.color), Color.green(rec.color), Color.blue(rec.color))
            else Color.argb(0xFF, Color.red(rec.color), Color.green(rec.color), Color.blue(rec.color))
            strokePaint.strokeWidth = rec.widthPx
            for (p in rec.paths) canvas.drawPath(p, strokePaint)
        }
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
            if (b < -4f || t > vh + 4f) continue
            canvas.drawRect(l + 5, t + 7, r + 5, b + 7, shadowPaint)
            pagePaint.color = pageColor
            canvas.drawRect(l, t, r, b, pagePaint)
            val save = canvas.save()
            canvas.clipRect(l, t, r, b)
            drawPaper(canvas, l, t, scale)
            canvas.concat(pageMatrix(i))
            drawRecs(canvas, pages[i])
            canvas.restoreToCount(save)
            canvas.drawRect(l, t, r, b, borderPaint)
        }
        drawAddTile(canvas, vh)
        drawOverlay(canvas)
    }

    /** Renders one page (background + paper + strokes) at [s] scale, origin (0,0) — used for PDF export. */
    fun renderPageInto(canvas: Canvas, i: Int, s: Float) {
        pagePaint.color = pageColor
        canvas.drawRect(0f, 0f, PAGE_W * s, PAGE_H * s, pagePaint)
        val save = canvas.save()
        canvas.clipRect(0f, 0f, PAGE_W * s, PAGE_H * s)
        drawPaper(canvas, 0f, 0f, s)
        canvas.concat(Matrix().apply { setScale(s, s) })
        drawRecs(canvas, pages[i])
        canvas.restoreToCount(save)
    }

    private fun drawAddTile(canvas: Canvas, vh: Float) {
        if (!showAddPage || pages.isEmpty()) { addRectScreen = null; return }
        val l = tx
        val t = ty + scale * (docHeight() + GAP)
        val r = tx + PAGE_W * scale
        val b = t + ADD_TILE_H * scale
        addRectScreen = RectF(l, t, r, b)
        if (b < -4f || t > vh + 4f) return
        addTilePaint.color = Color.argb(0x66, Color.red(textColor), Color.green(textColor), Color.blue(textColor))
        addTileText.color = Color.argb(0xCC, Color.red(textColor), Color.green(textColor), Color.blue(textColor))
        canvas.drawRoundRect(l, t, r, b, 18f, 18f, addTilePaint)
        addTileText.textSize = (20f * scale).coerceIn(16f, 30f)
        canvas.drawText("+  Add page", (l + r) / 2f, (t + b) / 2f + addTileText.textSize / 3f, addTileText)
    }

    private fun drawPaper(canvas: Canvas, l: Float, t: Float, s: Float) {
        if (paperStyle == PaperStyle.PLAIN) return
        val sp = 32f
        val lum = 0.299 * Color.red(pageColor) + 0.587 * Color.green(pageColor) + 0.114 * Color.blue(pageColor)
        paperPaint.color = if (lum < 128) Color.argb(46, 255, 255, 255) else Color.argb(30, 30, 50, 90)
        val bottom = t + PAGE_H * s
        val right = l + PAGE_W * s
        when (paperStyle) {
            PaperStyle.GRID -> {
                paperPaint.style = Paint.Style.STROKE; paperPaint.strokeWidth = 1f
                var xw = sp; while (xw < PAGE_W) { val xs = l + xw * s; canvas.drawLine(xs, t, xs, bottom, paperPaint); xw += sp }
                var yw = sp; while (yw < PAGE_H) { val ys = t + yw * s; canvas.drawLine(l, ys, right, ys, paperPaint); yw += sp }
            }
            PaperStyle.RULED -> {
                paperPaint.style = Paint.Style.STROKE; paperPaint.strokeWidth = 1f
                var yw = sp; while (yw < PAGE_H) { val ys = t + yw * s; canvas.drawLine(l, ys, right, ys, paperPaint); yw += sp }
            }
            PaperStyle.DOTS -> {
                paperPaint.style = Paint.Style.FILL
                // A single small dot needs far more weight than a continuous grid line to be
                // visible at the same spacing — bump the alpha and scale the radius with zoom.
                paperPaint.color = if (lum < 128) Color.argb(96, 255, 255, 255) else Color.argb(74, 30, 50, 90)
                // Radius tracks the zoom (≈1.35 page-units) so the dots stay proportional as you
                // zoom into a page instead of pinning to a tiny 3.6px cap and looking like specks.
                val r = (1.35f * s).coerceIn(1.6f, 14f)
                var yw = sp
                while (yw < PAGE_H) {
                    var xw = sp
                    while (xw < PAGE_W) { canvas.drawCircle(l + xw * s, t + yw * s, r, paperPaint); xw += sp }
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
        val hr = 11f
        for (c in listOf(floatArrayOf(l, t), floatArrayOf(r, t), floatArrayOf(r, b), floatArrayOf(l, b))) {
            canvas.drawCircle(c[0], c[1], hr, handleFill); canvas.drawCircle(c[0], c[1], hr, handleStroke)
        }
        val dcx = r + 20f; val dcy = t - 20f
        canvas.drawCircle(dcx, dcy, 15f, delPaint)
        canvas.drawLine(dcx - 6, dcy - 6, dcx + 6, dcy + 6, delX)
        canvas.drawLine(dcx - 6, dcy + 6, dcx + 6, dcy - 6, delX)
        vertexHandles?.let { hs ->
            for (h in hs) {
                val hx = sx(selPage, h.x); val hy = sy(selPage, h.y)
                canvas.drawCircle(hx, hy, 12f, handleFill); canvas.drawCircle(hx, hy, 12f, handleStroke)
            }
        }
    }
}
