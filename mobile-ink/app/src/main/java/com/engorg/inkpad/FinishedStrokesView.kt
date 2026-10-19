package com.engorg.inkpad

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.graphics.Shader
import android.view.View
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

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
        val brush: Brush = Brush.PEN, // ink style (freehand only; shapes always draw pen-style)
        val fine: List<Path> = emptyList(), // shape detail drawn thinner than the outline (axis tick marks)
        val hidden: List<Path> = emptyList(), // a 3D solid's back edges, always drawn dashed
    )

    class Page(val recs: ArrayList<Rec> = ArrayList())

    /** Actions in the floating menu over a selection (or the lone Paste pill after an empty tap). */
    enum class MenuAction(val label: String) {
        CUT("Cut"), COPY("Copy"), PASTE("Paste"), DUPLICATE("Duplicate"), COLOR("Color"), DELETE("Delete"),
        // Second row, shown when a single table is selected.
        ROW_ADD("+ Row"), ROW_DEL("− Row"), COL_ADD("+ Col"), COL_DEL("− Col"), BORDER("Border"),
        // Second row, shown when a single 3D solid is selected: snap to a standard view, or reshape it.
        VIEW_ISO("Iso"), VIEW_FRONT("Front"), VIEW_TOP("Top"), VIEW_SIDE("Side"), SOLID_EDIT("Edit shape"),
        // Second row, shown when a single graph card is selected.
        GRAPH_EDIT("Edit graph"), GRAPH_LEGEND("Expressions"),
    }

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

        /** Dash pattern for a dashed shape, sized (in page units) to the pen width so it reads at any weight. */
        fun dashEffect(widthPx: Float): DashPathEffect {
            val dash = (widthPx * 3f).coerceAtLeast(9f)
            val gap = (widthPx * 2.2f).coerceAtLeast(6f)
            return DashPathEffect(floatArrayOf(dash, gap), 0f)
        }

        /** Straight-segment path (for shapes, so corners stay sharp). */
        fun buildStraightPath(pts: List<PointF>): Path {
            val p = Path()
            if (pts.isEmpty()) return p
            p.moveTo(pts[0].x, pts[0].y)
            for (i in 1 until pts.size) p.lineTo(pts[i].x, pts[i].y)
            return p
        }

        /** Per-brush render width multiplier (baked into the outline geometry). */
        private fun widthScale(brush: Brush): Float = when (brush) {
            Brush.MARKER -> 1.5f
            Brush.PENCIL -> 0.9f
            else -> 1f
        }

        /** Per-brush fill opacity: marker near-solid (overlaps still build up); pen/pencil opaque. */
        private fun inkAlpha(brush: Brush): Int = if (brush == Brush.MARKER) 0xF0 else 0xFF

        // Dense graphite tooth for the pencil: mostly-opaque noise with fine speckle + a few gaps,
        // tinted to the stroke color at draw time. Not bilinear-filtered, so it stays crisp on commit.
        private val pencilGrain: BitmapShader by lazy {
            val s = 72
            val bmp = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
            val rnd = java.util.Random(0x9E77)
            val px = IntArray(s * s)
            for (i in px.indices) {
                val n = rnd.nextInt(100)
                val a = if (n < 7) 55 + rnd.nextInt(55) else 150 + rnd.nextInt(106)
                px[i] = Color.argb(a, 255, 255, 255)
            }
            bmp.setPixels(px, 0, s, 0, 0, s, s)
            BitmapShader(bmp, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
        }

        // Reusable stroker for converting a centerline into a fillable outline (see buildStrokeOutline).
        private val stroker = Paint().apply {
            isAntiAlias = true; style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
        }

        /** Turn a centerline into a filled outline of the given width. Filling this (one closed path)
         *  avoids the AA seams a hardware-accelerated *stroked* path shows along solid ink. */
        private fun buildStrokeOutline(centerline: Path, width: Float): Path {
            stroker.strokeWidth = width.coerceAtLeast(0.4f)
            val out = Path()
            stroker.getFillPath(centerline, out)
            return out
        }

        /**
         * The ready-to-draw geometry for a stroke. Everything except the highlighter is a FILLED path
         * (fountain = variable-width ribbon; pen/marker/pencil = a constant-width stroke outline), so
         * solid ink never shows the stroked-path AA graininess. Built once and reused every redraw.
         */
        fun buildInkGeometry(pts: List<PointF>, baseW: Float, brush: Brush, highlighter: Boolean): Path = when {
            highlighter -> buildPath(pts)
            brush == Brush.FOUNTAIN -> buildFountainRibbon(pts, baseW)
            else -> buildStrokeOutline(buildPath(pts), baseW * widthScale(brush))
        }

        // Broad-edge "nib" for the fountain pen. A real fountain/italic nib is a flat broad edge held
        // at a fixed angle: the line is thickest when you drag ACROSS the edge and thins to a hairline
        // when you travel ALONG it. That direction-driven width — bold downstrokes, thin upstrokes, the
        // weight sweeping as the stroke curves — is the fountain-pen signature. It's also inherently
        // ball-proof: width comes from *heading*, not *speed*, so the slow touch-down / lift-off points
        // are not fattened, and there are no round end caps to bulge into a bead.
        private const val NIB_ANGLE_DEG = -40f     // edge tilt: "\" downstroke bold, "/" upstroke thin
        private const val NIB_MIN_RATIO = 0.22f    // hairline width as a fraction of the broad width
        private val NIB_EX = cos(Math.toRadians(NIB_ANGLE_DEG.toDouble())).toFloat()
        private val NIB_EY = sin(Math.toRadians(NIB_ANGLE_DEG.toDouble())).toFloat()

        /**
         * Fountain nib: a filled band whose width is set by the stroke's direction against a fixed
         * broad-nib edge (thick across the edge, hairline along it), not by speed. The width sweeps
         * smoothly as the heading changes, tips end in a chisel (a slightly softened flat nib edge),
         * and a lone tap stamps the nib's footprint — so no round end balls, on long or short strokes.
         */
        private fun buildFountainRibbon(pts: List<PointF>, baseW: Float): Path {
            val p = Path()
            val n = pts.size
            if (n == 0) return p
            val half = (baseW / 2f).coerceAtLeast(0.4f)
            if (n == 1) return nibStamp(pts[0].x, pts[0].y, half)
            val cum = FloatArray(n)
            for (i in 1 until n) cum[i] = cum[i - 1] + hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
            val total = cum[n - 1]
            if (total < 1e-3f) return nibStamp(pts[0].x, pts[0].y, half)
            // Per-point half-width from heading vs. the nib edge: |T x e| = |sin(angle)| → 1 across, 0 along.
            val h = FloatArray(n)
            for (i in 0 until n) {
                val a = pts[if (i > 0) i - 1 else i]; val c = pts[if (i < n - 1) i + 1 else i]
                var tx = c.x - a.x; var ty = c.y - a.y
                val len = hypot(tx, ty)
                if (len > 1e-4f) { tx /= len; ty /= len }
                val across = abs(tx * NIB_EY - ty * NIB_EX)          // 1 when crossing the edge, 0 when along it
                h[i] = half * (NIB_MIN_RATIO + (1f - NIB_MIN_RATIO) * across)
            }
            // Smooth the weight so the thick↔thin transition glides as the stroke curves (ink can't jump).
            val sh = FloatArray(n)
            for (i in 0 until n) {
                val lo = (i - 1).coerceAtLeast(0); val hi = (i + 1).coerceAtMost(n - 1)
                sh[i] = (h[lo] + h[i] + h[hi]) / ((hi - lo) + 1)
            }
            // Soften just the last ~½-width at each tip so the flat chisel end isn't a hard block. This
            // NARROWS the tip (never widens) and adds no cap, so it can't bring the end balls back.
            val soft = (baseW * 0.5f).coerceAtMost(total * 0.25f)
            if (soft > 1e-3f) for (i in 0 until n) {
                val edge = minOf(cum[i], total - cum[i])
                if (edge < soft) { val e = edge / soft; sh[i] *= 0.7f + 0.3f * (e * e * (3f - 2f * e)) }
            }
            val nx = FloatArray(n); val ny = FloatArray(n)
            for (i in 0 until n) {
                val a = pts[if (i > 0) i - 1 else i]; val c = pts[if (i < n - 1) i + 1 else i]
                var tx = c.x - a.x; var ty = c.y - a.y
                val len = hypot(tx, ty)
                if (len > 1e-4f) { tx /= len; ty /= len } else { tx = 1f; ty = 0f }
                nx[i] = -ty; ny[i] = tx
            }
            // Perpendicular-offset band with plain flat caps. Because the width already collapses toward
            // the nib direction, a bold stroke's flat cap lands along the nib edge (a true chisel end)
            // and a hairline's cap is vanishingly small — either way, no bead.
            p.moveTo(pts[0].x + nx[0] * sh[0], pts[0].y + ny[0] * sh[0])
            for (i in 1 until n) p.lineTo(pts[i].x + nx[i] * sh[i], pts[i].y + ny[i] * sh[i])
            for (i in n - 1 downTo 0) p.lineTo(pts[i].x - nx[i] * sh[i], pts[i].y - ny[i] * sh[i])
            p.close()
            p.fillType = Path.FillType.WINDING
            return p
        }

        /** A single nib dab (a tap): the broad edge stamped once — thin across, broad along the edge. */
        private fun nibStamp(x: Float, y: Float, half: Float): Path {
            val t = (half * NIB_MIN_RATIO).coerceAtLeast(0.4f)   // half-thickness across the edge
            val nx = -NIB_EY; val ny = NIB_EX
            return Path().apply {
                moveTo(x + NIB_EX * half + nx * t, y + NIB_EY * half + ny * t)
                lineTo(x - NIB_EX * half + nx * t, y - NIB_EY * half + ny * t)
                lineTo(x - NIB_EX * half - nx * t, y - NIB_EY * half - ny * t)
                lineTo(x + NIB_EX * half - nx * t, y + NIB_EY * half - ny * t)
                close()
            }
        }

        /**
         * Draw one freehand stroke in the canvas's current coordinate space (page-local under the
         * finished view's matrix, or raw screen space in the wet overlay), honoring its [brush].
         * [prebuilt] is the geometry when the caller already has it (finished recs); pass null to
         * build it. [paint] is a reusable paint owned by the caller — this mutates it and restores
         * style/shader/colorFilter/alpha afterward.
         */
        fun drawInk(
            canvas: Canvas,
            pts: List<PointF>,
            prebuilt: Path?,
            color: Int,
            width: Float,
            brush: Brush,
            highlighter: Boolean,
            paint: Paint,
        ) {
            if (width <= 0f || (prebuilt == null && pts.isEmpty())) return
            val r = Color.red(color); val g = Color.green(color); val b = Color.blue(color)
            val geom = prebuilt ?: buildInkGeometry(pts, width, brush, highlighter)
            if (highlighter) {
                // Translucent broad marker line — kept as a plain stroke (self-overlap must not darken).
                paint.style = Paint.Style.STROKE
                paint.shader = null; paint.colorFilter = null; paint.alpha = 0xFF
                paint.strokeJoin = Paint.Join.ROUND; paint.strokeCap = Paint.Cap.ROUND
                paint.color = Color.argb(0x66, r, g, b)
                paint.strokeWidth = width
                canvas.drawPath(geom, paint)
                return
            }
            // Everything else is a filled path (ribbon or stroke outline) — no AA seam graininess.
            paint.style = Paint.Style.FILL
            if (brush == Brush.PENCIL) {
                paint.shader = pencilGrain
                paint.isFilterBitmap = false
                paint.colorFilter = PorterDuffColorFilter(Color.rgb(r, g, b), PorterDuff.Mode.SRC_IN)
                paint.alpha = 0xF0
            } else {
                paint.shader = null; paint.colorFilter = null
                paint.color = Color.argb(inkAlpha(brush), r, g, b)
            }
            canvas.drawPath(geom, paint)
            paint.shader = null; paint.colorFilter = null; paint.alpha = 0xFF
            paint.style = Paint.Style.STROKE
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
    var menuBg = Color.rgb(0xEE, 0xF0, 0xF4)
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
    private var selMenu: List<MenuAction> = emptyList()
    private var tableMenu: List<MenuAction> = emptyList()
    private var orbit = false   // a lone 3D solid is selected: show the orbit knob
    private var pasteMenuPage = -1
    private val pasteMenuAt = PointF()
    private val menuHits = ArrayList<Pair<MenuAction, RectF>>()   // screen-space, rebuilt every draw

    private val density = resources.displayMetrics.density
    private fun dpf(v: Float) = v * density

    private val strokePaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val paperPaint = Paint().apply { isAntiAlias = true }
    private val pagePaint = Paint().apply { isAntiAlias = true }
    private val shadowPaint = Paint().apply { isAntiAlias = true; color = Color.argb(50, 0, 0, 0) }
    private val borderPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 1f; color = Color.argb(40, 0, 0, 0) }
    private val selPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f; pathEffect = DashPathEffect(floatArrayOf(10f, 8f), 0f) }
    private val handleFill = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL; color = Color.WHITE }
    private val handleStroke = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f }
    private val lassoPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f; pathEffect = DashPathEffect(floatArrayOf(8f, 6f), 0f) }
    private val selFill = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL }
    private val menuPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL }
    private val menuShadow = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL; color = Color.argb(60, 0, 0, 0) }
    private val menuDivider = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 1f }
    private val menuText = Paint().apply { isAntiAlias = true; textAlign = Paint.Align.CENTER; typeface = android.graphics.Typeface.DEFAULT_BOLD }
    private val addTilePaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 3f; pathEffect = DashPathEffect(floatArrayOf(16f, 12f), 0f) }
    private val addTileText = Paint().apply { isAntiAlias = true; textAlign = Paint.Align.CENTER; typeface = android.graphics.Typeface.DEFAULT_BOLD }

    fun setTransform(s: Float, x: Float, y: Float) { scale = s; tx = x; ty = y; invalidate() }

    fun pageTop(i: Int) = i * (PAGE_H + GAP)
    fun docHeight(): Float = if (pages.isEmpty()) PAGE_H else pages.size * (PAGE_H + GAP) - GAP
    fun contentHeight(): Float = docHeight() + if (showAddPage) GAP + ADD_TILE_H else 0f

    fun setSelection(page: Int, box: RectF?, handles: List<PointF>?, menu: List<MenuAction>, tableMenu: List<MenuAction> = emptyList(), orbit: Boolean = false) {
        selPage = page; selBox = box; vertexHandles = handles; selMenu = menu; this.tableMenu = tableMenu; this.orbit = orbit; invalidate()
    }
    fun clearSelection() { selPage = -1; selBox = null; vertexHandles = null; selMenu = emptyList(); tableMenu = emptyList(); orbit = false; pasteMenuPage = -1; menuHits.clear(); invalidate() }
    fun setLasso(pts: List<PointF>?) { lasso = pts; invalidate() }

    /** Show a lone "Paste" pill anchored at page-local ([x],[y]) on [page] (follows pan/zoom). */
    fun showPasteMenu(page: Int, x: Float, y: Float) { pasteMenuPage = page; pasteMenuAt.set(x, y); invalidate() }
    fun pasteMenuShowing() = pasteMenuPage >= 0
    fun pasteMenuAnchor(): Pair<Int, PointF>? = if (pasteMenuPage >= 0) pasteMenuPage to PointF(pasteMenuAt.x, pasteMenuAt.y) else null

    /** The floating-menu action under a screen point, if any (hit rects are padded for fingers). */
    fun menuActionAt(x: Float, y: Float): MenuAction? = menuHits.firstOrNull { it.second.contains(x, y) }?.first

    /**
     * The selection box as drawn on screen: the strokes' bounds padded a little and grown to a
     * minimum size, so a thin line or a dot still gets a box you can actually land a finger in.
     * PageCanvas hit-tests against this same rect so what you see is what you can grab.
     */
    fun selectionScreenRect(): RectF? {
        val box = selBox ?: return null
        val r = RectF(sx(selPage, box.left), sy(selPage, box.top), sx(selPage, box.right), sy(selPage, box.bottom))
        r.inset(-dpf(6f), -dpf(6f))
        val min = dpf(48f)
        if (r.width() < min) r.inset(-(min - r.width()) / 2f, 0f)
        if (r.height() < min) r.inset(0f, -(min - r.height()) / 2f)
        return r
    }

    /** Where the rotate knob sits on screen (centered under the selection box), or null. */
    fun rotateHandleScreen(): PointF? {
        val r = selectionScreenRect() ?: return null
        return PointF(if (orbit) r.centerX() - dpf(24f) else r.centerX(), r.bottom + dpf(30f))
    }

    /** Where the 3D orbit knob sits (beside the rotate knob), or null when no lone solid is selected. */
    fun orbitHandleScreen(): PointF? {
        if (!orbit) return null
        val r = selectionScreenRect() ?: return null
        return PointF(r.centerX() + dpf(24f), r.bottom + dpf(30f))
    }

    /** Erase whole strokes near the tip. Tables and graph cards are skipped, so erasing writing inside
     *  one never deletes it (select it and Delete it instead). */
    fun eraseNear(page: Int, x: Float, y: Float, radius: Float): Boolean {
        if (page < 0 || page >= pages.size) return false
        val r2 = radius * radius
        val recs = pages[page].recs
        val before = recs.size
        recs.removeAll { rec -> rec.shape?.type != ShapeType.TABLE && rec.shape?.type != ShapeType.GRAPH && rec.points.any { val dx = it.x - x; val dy = it.y - y; dx * dx + dy * dy <= r2 } }
        val changed = recs.size != before
        if (changed) invalidate()
        return changed
    }

    private fun pageMatrix(i: Int): Matrix = Matrix().apply { setScale(scale, scale); postTranslate(tx, ty); preTranslate(0f, pageTop(i)) }

    /** True while rendering for export (PDF / snapshots): graph cards compute their curves right away. */
    private var syncCards = false

    private fun drawGraphCard(canvas: Canvas, spec: ShapeSpec) {
        val card = spec.graph ?: return
        val a = spec.verts[0]; val b = spec.verts[1]
        val box = RectF(kotlin.math.min(a.x, b.x), kotlin.math.min(a.y, b.y), kotlin.math.max(a.x, b.x), kotlin.math.max(a.y, b.y))
        val lum = (0.299 * Color.red(pageColor) + 0.587 * Color.green(pageColor) + 0.114 * Color.blue(pageColor)) / 255.0
        val save = canvas.save()
        if (spec.rot != 0f) canvas.rotate(spec.rot, spec.pivot.x, spec.pivot.y)
        GraphCardRenderer.draw(canvas, card, box, lum < 0.5, syncCards) { postInvalidate() }
        canvas.restoreToCount(save)
    }

    private fun drawRecs(canvas: Canvas, page: Page) {
        for (rec in page.recs) {
            if (rec.shape?.type == ShapeType.GRAPH) { drawGraphCard(canvas, rec.shape!!); continue }
            if (rec.shape != null) {
                // Parametric shapes draw as a crisp solid pen line — or a dashed one when flagged.
                strokePaint.style = Paint.Style.STROKE
                strokePaint.shader = null; strokePaint.colorFilter = null; strokePaint.alpha = 0xFF
                strokePaint.color = if (rec.highlighter)
                    Color.argb(0x66, Color.red(rec.color), Color.green(rec.color), Color.blue(rec.color))
                else Color.argb(0xFF, Color.red(rec.color), Color.green(rec.color), Color.blue(rec.color))
                strokePaint.strokeWidth = rec.widthPx
                if (rec.shape.dashed) {
                    // Dash/gap are page-local (so they scale with zoom like the stroke) and grow with the
                    // pen so the pattern reads at any weight. Butt caps keep the gaps clean on thick lines.
                    strokePaint.pathEffect = dashEffect(rec.widthPx)
                    strokePaint.strokeCap = Paint.Cap.BUTT
                } else {
                    strokePaint.pathEffect = null
                    strokePaint.strokeCap = Paint.Cap.ROUND
                }
                for (p in rec.paths) canvas.drawPath(p, strokePaint)
                if (rec.hidden.isNotEmpty()) {
                    // Hidden edges: dashed whatever the outline style, like a drafting hidden line.
                    strokePaint.pathEffect = dashEffect(rec.widthPx)
                    strokePaint.strokeCap = Paint.Cap.BUTT
                    for (p in rec.hidden) canvas.drawPath(p, strokePaint)
                }
                strokePaint.pathEffect = null   // never leak the dash onto the next rec / freehand ink
                if (rec.fine.isNotEmpty()) {
                    // Tick marks: solid and about half the outline weight.
                    strokePaint.strokeWidth = (rec.widthPx * 0.5f).coerceAtLeast(0.6f)
                    strokePaint.strokeCap = Paint.Cap.ROUND
                    for (p in rec.fine) canvas.drawPath(p, strokePaint)
                }
            } else {
                strokePaint.pathEffect = null
                drawInk(canvas, rec.points, rec.paths.firstOrNull(), rec.color, rec.widthPx, rec.brush, rec.highlighter, strokePaint)
            }
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
        syncCards = true
        try { drawRecs(canvas, pages[i]) } finally { syncCards = false }
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
        menuHits.clear()
        if (pasteMenuPage >= 0) {
            val px = sx(pasteMenuPage, pasteMenuAt.x); val py = sy(pasteMenuPage, pasteMenuAt.y)
            drawMenu(canvas, listOf(MenuAction.PASTE), px, py - dpf(14f), py + dpf(14f))
        }
        val rect = selectionScreenRect() ?: return
        selPaint.color = accent; handleStroke.color = accent
        handleStroke.strokeWidth = dpf(1.5f)
        // Faint tint inside the box so it reads as one grabbable object, not just a dashed outline.
        selFill.color = Color.argb(0x1A, Color.red(accent), Color.green(accent), Color.blue(accent))
        canvas.drawRect(rect, selFill)
        canvas.drawRect(rect, selPaint)
        val hr = dpf(8f)
        for (c in listOf(floatArrayOf(rect.left, rect.top), floatArrayOf(rect.right, rect.top), floatArrayOf(rect.right, rect.bottom), floatArrayOf(rect.left, rect.bottom))) {
            canvas.drawCircle(c[0], c[1], hr, handleFill); canvas.drawCircle(c[0], c[1], hr, handleStroke)
        }
        vertexHandles?.let { hs ->
            for (h in hs) {
                val hx = sx(selPage, h.x); val hy = sy(selPage, h.y)
                canvas.drawCircle(hx, hy, dpf(9f), handleFill); canvas.drawCircle(hx, hy, dpf(9f), handleStroke)
            }
        }
        // Rotate knob: a stalk down from the box to a circle holding a circular-arrow glyph.
        rotateHandleScreen()?.let { k ->
            val kr = dpf(11f)
            canvas.drawLine(k.x, rect.bottom, k.x, k.y - kr, handleStroke)
            canvas.drawCircle(k.x, k.y, kr, handleFill); canvas.drawCircle(k.x, k.y, kr, handleStroke)
            val ar = kr * 0.5f
            canvas.drawArc(k.x - ar, k.y - ar, k.x + ar, k.y + ar, -60f, 280f, false, handleStroke)
            val tipA = Math.toRadians(220.0)
            val tx0 = k.x + ar * cos(tipA).toFloat(); val ty0 = k.y + ar * sin(tipA).toFloat()
            canvas.drawLine(tx0, ty0, tx0 + ar * 0.55f, ty0 - ar * 0.1f, handleStroke)
            canvas.drawLine(tx0, ty0, tx0 + ar * 0.1f, ty0 + ar * 0.55f, handleStroke)
        }
        // Orbit knob (3D rotate): a little globe, an equator and a meridian inside a circle.
        orbitHandleScreen()?.let { k ->
            val kr = dpf(11f)
            canvas.drawLine(k.x, rect.bottom, k.x, k.y - kr, handleStroke)
            canvas.drawCircle(k.x, k.y, kr, handleFill); canvas.drawCircle(k.x, k.y, kr, handleStroke)
            val gr = kr * 0.6f
            canvas.drawCircle(k.x, k.y, gr, handleStroke)
            canvas.drawOval(k.x - gr, k.y - gr * 0.38f, k.x + gr, k.y + gr * 0.38f, handleStroke)
            canvas.drawOval(k.x - gr * 0.38f, k.y - gr, k.x + gr * 0.38f, k.y + gr, handleStroke)
        }
        // Sit the menu clear of the corner handles' touch zones (above the box, or below — past the
        // rotate knob — if there's no room).
        if (selMenu.isNotEmpty()) {
            val main = drawMenu(canvas, selMenu, rect.centerX(), rect.top - dpf(28f), rect.bottom + dpf(52f))
            if (tableMenu.isNotEmpty()) {
                if (main.bottom <= rect.top) drawMenu(canvas, tableMenu, rect.centerX(), main.top - dpf(6f), main.bottom + dpf(6f))
                else drawMenu(canvas, tableMenu, rect.centerX(), -Float.MAX_VALUE, main.bottom + dpf(6f))
            }
        }
    }

    /**
     * A rounded pill of text buttons whose bottom edge sits at [aboveY] (or whose top sits at
     * [belowY] when there's no room above), clamped on-screen so it stays reachable when zoomed in.
     * Records each button's padded hit rect in [menuHits].
     */
    private fun drawMenu(canvas: Canvas, actions: List<MenuAction>, cx: Float, aboveY: Float, belowY: Float): RectF {
        menuText.textSize = dpf(14f)
        val padH = dpf(14f); val h = dpf(40f); val margin = dpf(8f)
        val widths = actions.map { menuText.measureText(it.label) + padH * 2f }
        val total = widths.sum()
        var top = aboveY - h
        if (top < margin) top = belowY
        top = top.coerceIn(margin, (height - h - margin).coerceAtLeast(margin))
        var left = (cx - total / 2f).coerceIn(margin, (width - total - margin).coerceAtLeast(margin))
        val bounds = RectF(left, top, left + total, top + h)
        val rr = h / 2f
        canvas.drawRoundRect(left + dpf(1f), top + dpf(2f), left + total + dpf(1f), top + h + dpf(2f), rr, rr, menuShadow)
        menuPaint.color = menuBg
        canvas.drawRoundRect(left, top, left + total, top + h, rr, rr, menuPaint)
        menuDivider.color = Color.argb(0x30, Color.red(textColor), Color.green(textColor), Color.blue(textColor))
        val baseline = top + h / 2f - (menuText.descent() + menuText.ascent()) / 2f
        for ((i, a) in actions.withIndex()) {
            val w = widths[i]
            if (i > 0) canvas.drawLine(left, top + h * 0.25f, left, top + h * 0.75f, menuDivider)
            menuText.color = if (a == MenuAction.DELETE) Color.rgb(0xE5, 0x3E, 0x3E) else textColor
            canvas.drawText(a.label, left + w / 2f, baseline, menuText)
            menuHits.add(a to RectF(left, top - dpf(4f), left + w, top + h + dpf(4f)))
            left += w
        }
        return bounds
    }
}
