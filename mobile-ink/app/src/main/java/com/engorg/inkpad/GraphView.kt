package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * The grapher's plot surface: grid + labelled axes, every curve / region / point from a
 * [GraphModel], points of interest for the focused row, pan (drag), pinch / wheel zoom and
 * tap-or-drag tracing with a coordinate bubble. Geometry is computed off the UI thread by
 * [GraphCompute] in world coordinates (with a margin), so panning redraws the last result
 * immediately and the refined one lands a moment later.
 */
@SuppressLint("ViewConstructor")
class GraphView(context: Context) : View(context) {
    private val dens = resources.displayMetrics.density
    private fun dp(v: Float) = v * dens

    var cx = 0.0; var cy = 0.0
    var ppu = 0.0          // pixels per unit (uniform on both axes); 0 until first layout
    var model: GraphModel? = null; private set
    var focusRow = -1
        set(v) { if (field != v) { field = v; requestCompute(true) } }
    var onViewChanged: (() -> Unit)? = null

    private var scene: Scene? = null
    private val exec = Executors.newSingleThreadExecutor()
    @Volatile private var gen = 0
    private var running = false
    private var pending = false

    private class Trace(val color: Int, val x: Double, val y: Double, val curve: Curve?)
    private var trace: Trace? = null

    // ---------------------------------------------------------------- paints
    /** Colors when drawn as part of a page graph (else the app theme's). */
    var bgOverride: Int? = null
    var inkOverride: Int? = null
    private val bg get() = bgOverride ?: AppTheme.surface
    private val ink get() = inkOverride ?: AppTheme.text
    private fun alpha(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))
    private val gridPaint = Paint().apply { strokeWidth = 1f }
    private val axisPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeWidth = dp(1.4f) }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(11.5f) }
    private val haloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = dp(11.5f); style = Paint.Style.STROKE; strokeWidth = dp(3.5f); strokeJoin = Paint.Join.ROUND }
    private val curvePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = dp(2.6f); strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dash = DashPathEffect(floatArrayOf(dp(9f), dp(6f)), 0f)
    private val path = Path()

    fun setModel(m: GraphModel) { model = m; requestCompute(true) }

    fun dispose() { exec.shutdownNow() }

    // ---------------------------------------------------------------- view transform
    private fun viewport(): Viewport {
        val hw = width / 2.0 / ppu; val hh = height / 2.0 / ppu
        return Viewport(cx - hw, cx + hw, cy - hh, cy + hh, width, height)
    }
    private fun sx(x: Double) = (width / 2.0 + (x - cx) * ppu).coerceIn(-1e6, 1e6).toFloat()
    private fun sy(y: Double) = (height / 2.0 - (y - cy) * ppu).coerceIn(-1e6, 1e6).toFloat()
    private fun wx(px: Float) = cx + (px - width / 2.0) / ppu
    private fun wy(py: Float) = cy - (py - height / 2.0) / ppu

    fun home() {
        if (width == 0) return
        cx = 0.0; cy = 0.0; ppu = width / 20.0
        viewChanged()
    }

    fun setView(x: Double, y: Double, unitsAcross: Double) {
        cx = x; cy = y
        if (width > 0 && unitsAcross > 0) ppu = width / unitsAcross
        pendingUnits = if (width > 0) 0.0 else unitsAcross
        viewChanged()
    }
    private var pendingUnits = 0.0
    fun unitsAcross() = if (ppu > 0 && width > 0) width / ppu else 20.0

    private fun viewChanged() { invalidate(); requestCompute(false); onViewChanged?.invoke() }

    private fun zoomAt(fx: Float, fy: Float, f: Double) {
        val x = wx(fx); val y = wy(fy)
        ppu = (ppu * f).coerceIn(1e-9, 1e13)
        cx = x - (fx - width / 2.0) / ppu
        cy = y + (fy - height / 2.0) / ppu
    }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        super.onSizeChanged(w, h, ow, oh)
        if (w <= 0) return
        if (ppu == 0.0) ppu = w / (if (pendingUnits > 0) pendingUnits else 20.0)
        else if (ow > 0) ppu *= w.toDouble() / ow   // keep the same x-range when the window is resized
        pendingUnits = 0.0
        requestCompute(true)
    }

    // ---------------------------------------------------------------- background compute
    fun requestCompute(force: Boolean) {
        if (width == 0 || height == 0 || ppu == 0.0 || model == null) return
        if (!force) {
            val s = scene
            if (s != null && s.region.contains(viewport()) && abs(ln(ppu / s.viewPpu)) < 0.15) return
        }
        gen++
        pending = true
        if (!running) launch()
    }

    private fun launch() {
        val m = model ?: return
        pending = false; running = true
        val my = gen
        val vp = viewport(); val fr = focusRow
        try {
            exec.execute {
                val s = try { GraphCompute.compute(m, vp, fr) { gen != my } } catch (t: Throwable) { null }
                post {
                    running = false
                    if (s != null) { scene = s; invalidate() }
                    if (pending) launch()
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) { running = false }
    }

    // ---------------------------------------------------------------- drawing
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

    override fun onDraw(c: Canvas) {
        c.drawColor(bg)
        if (ppu <= 0.0 || width == 0) return
        val vp = viewport()
        val major = niceStep(dp(105f) / ppu)
        val minor = major / (if (mantissa(major) == 2) 4 else 5)

        // grid
        gridPaint.color = alpha(ink, 0x12)
        drawLines(c, vp, minor)
        gridPaint.color = alpha(ink, 0x2C)
        drawLines(c, vp, major)

        // axes
        axisPaint.color = alpha(ink, 0xC0)
        val ax = sx(0.0); val ay = sy(0.0)
        if (ax in 0f..width.toFloat()) c.drawLine(ax, 0f, ax, height.toFloat(), axisPaint)
        if (ay in 0f..height.toFloat()) c.drawLine(0f, ay, width.toFloat(), ay, axisPaint)

        // plots
        val s = scene
        if (s != null) {
            for (f in s.fills) {
                fillPaint.color = alpha(f.color, 0x38)
                for (poly in f.polys) { if (buildPath(poly, false)) { path.close(); c.drawPath(path, fillPaint) } }
                val r = f.rects
                if (r != null) {
                    path.reset()
                    var i = 0
                    while (i + 3 < r.size) { path.addRect(sx(r[i]), sy(r[i + 3]), sx(r[i + 2]), sy(r[i + 1]), Path.Direction.CW); i += 4 }
                    c.drawPath(path, fillPaint)
                }
            }
            for (cv in s.curves) {
                curvePaint.color = cv.color
                curvePaint.pathEffect = if (cv.dashed) dash else null
                for (line in cv.lines) if (buildPath(line, true)) c.drawPath(path, curvePaint)
            }
            curvePaint.pathEffect = null
            for (p in s.pois) {
                dotPaint.style = Paint.Style.FILL; dotPaint.color = bg
                c.drawCircle(sx(p.x), sy(p.y), dp(4.5f), dotPaint)
                dotPaint.style = Paint.Style.STROKE; dotPaint.strokeWidth = dp(2f); dotPaint.color = alpha(ink, 0x99)
                c.drawCircle(sx(p.x), sy(p.y), dp(4.5f), dotPaint)
            }
            for (d in s.dots) {
                dotPaint.style = Paint.Style.FILL; dotPaint.color = d.color
                c.drawCircle(sx(d.x), sy(d.y), dp(5.5f), dotPaint)
                bubble(c, sx(d.x), sy(d.y), "(" + MathEngine.fmt(d.x, 5) + ", " + MathEngine.fmt(d.y, 5) + ")", d.color, small = true)
            }
        }

        drawLabels(c, vp, major)

        trace?.let { t ->
            val px = sx(t.x); val py = sy(t.y)
            dotPaint.style = Paint.Style.FILL; dotPaint.color = t.color
            c.drawCircle(px, py, dp(6.5f), dotPaint)
            dotPaint.style = Paint.Style.STROKE; dotPaint.strokeWidth = dp(2f); dotPaint.color = bg
            c.drawCircle(px, py, dp(6.5f), dotPaint)
            bubble(c, px, py, "(" + MathEngine.fmt(t.x, 6) + ", " + MathEngine.fmt(t.y, 6) + ")", t.color, small = false)
        }
    }

    private fun drawLines(c: Canvas, vp: Viewport, step: Double) {
        val kx0 = ceil(vp.x0 / step).toLong(); val kx1 = floor(vp.x1 / step).toLong()
        if (kx1 - kx0 < 600) for (k in kx0..kx1) { val x = sx(k * step); c.drawLine(x, 0f, x, height.toFloat(), gridPaint) }
        val ky0 = ceil(vp.y0 / step).toLong(); val ky1 = floor(vp.y1 / step).toLong()
        if (ky1 - ky0 < 600) for (k in ky0..ky1) { val y = sy(k * step); c.drawLine(0f, y, width.toFloat(), y, gridPaint) }
    }

    private fun label(c: Canvas, text: String, x: Float, y: Float, align: Paint.Align) {
        textPaint.textAlign = align; haloPaint.textAlign = align
        haloPaint.color = bg; textPaint.color = alpha(ink, 0xD8)
        c.drawText(text, x, y, haloPaint); c.drawText(text, x, y, textPaint)
    }

    private fun drawLabels(c: Canvas, vp: Viewport, step: Double) {
        val th = textPaint.textSize
        val pad = dp(4f)
        val ax = sx(0.0); val ay = sy(0.0)
        // x labels sit under the x-axis (pinned to an edge when it's off screen)
        val base = (ay + th + pad).coerceIn(th + pad, height - pad)
        val kx0 = ceil(vp.x0 / step).toLong(); val kx1 = floor(vp.x1 / step).toLong()
        if (kx1 - kx0 < 200) for (k in kx0..kx1) {
            if (k == 0L) continue
            val x = sx(k * step)
            if (x < dp(10f) || x > width - dp(10f)) continue
            label(c, tickText(k * step, step), x, base, Paint.Align.CENTER)
        }
        // y labels sit left of the y-axis (or pinned to the left / right edge)
        val ky0 = ceil(vp.y0 / step).toLong(); val ky1 = floor(vp.y1 / step).toLong()
        if (ky1 - ky0 < 200) for (k in ky0..ky1) {
            if (k == 0L) continue
            val y = sy(k * step)
            if (y < th || y > height - pad) continue
            val t = tickText(k * step, step)
            val w = textPaint.measureText(t)
            when {
                ax - pad - w < pad -> label(c, t, pad, y + th / 3, Paint.Align.LEFT)
                ax > width - pad -> label(c, t, width - pad, y + th / 3, Paint.Align.RIGHT)
                else -> label(c, t, ax - pad, y + th / 3, Paint.Align.RIGHT)
            }
        }
        if (ax in 0f..width.toFloat() && ay in 0f..height.toFloat()) label(c, "0", ax - pad, ay + th + pad, Paint.Align.RIGHT)
    }

    /** Fill [path] from a world polyline, skipping sub-pixel steps. Returns false if empty. */
    private fun buildPath(a: DoubleArray, decimate: Boolean): Boolean {
        path.reset()
        if (a.size < 4) return false
        var lx = sx(a[0]); var ly = sy(a[1])
        path.moveTo(lx, ly)
        var i = 2
        val n = a.size
        while (i < n) {
            val x = sx(a[i]); val y = sy(a[i + 1])
            if (!decimate || i == n - 2 || abs(x - lx) + abs(y - ly) > 0.7f) { path.lineTo(x, y); lx = x; ly = y }
            i += 2
        }
        return true
    }

    private val bubbleRect = RectF()
    private fun bubble(c: Canvas, px: Float, py: Float, text: String, color: Int, small: Boolean) {
        textPaint.textAlign = Paint.Align.LEFT
        val ts = textPaint.textSize
        if (small) textPaint.textSize = ts * 0.92f
        val w = textPaint.measureText(text) + dp(14f)
        val h = textPaint.textSize + dp(10f)
        var left = px + dp(10f); var top = py - h - dp(8f)
        if (left + w > width - dp(4f)) left = px - w - dp(10f)
        if (top < dp(4f)) top = py + dp(10f)
        left = left.coerceIn(dp(2f), max(dp(2f), width - w - dp(2f)))
        bubbleRect.set(left, top, left + w, top + h)
        fillPaint.color = alpha(bg, 0xF2)
        c.drawRoundRect(bubbleRect, dp(7f), dp(7f), fillPaint)
        dotPaint.style = Paint.Style.STROKE; dotPaint.strokeWidth = dp(1.4f); dotPaint.color = color
        c.drawRoundRect(bubbleRect, dp(7f), dp(7f), dotPaint)
        textPaint.color = ink
        c.drawText(text, left + dp(7f), top + h - dp(6.5f) - (textPaint.descent() / 2), textPaint)
        textPaint.textSize = ts
    }

    // ---------------------------------------------------------------- touch
    private var mode = 0       // 0 idle, 1 pan, 2 trace, 3 pinch
    private var lastX = 0f; private var lastY = 0f
    private var downX = 0f; private var downY = 0f
    private var moved = false
    private var prevFocusX = 0f; private var prevFocusY = 0f

    private val scaleDet = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(d: ScaleGestureDetector): Boolean { prevFocusX = d.focusX; prevFocusY = d.focusY; mode = 3; return true }
        override fun onScale(d: ScaleGestureDetector): Boolean {
            cx -= (d.focusX - prevFocusX) / ppu; cy += (d.focusY - prevFocusY) / ppu
            prevFocusX = d.focusX; prevFocusY = d.focusY
            zoomAt(d.focusX, d.focusY, d.scaleFactor.toDouble())
            viewChanged()
            return true
        }
    }).apply { isQuickScaleEnabled = false }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (ppu <= 0.0) return true
        parent?.requestDisallowInterceptTouchEvent(true)
        scaleDet.onTouchEvent(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = e.x; downY = e.y; lastX = e.x; lastY = e.y; moved = false
                val hit = hitTest(e.x, e.y)
                if (hit != null) { mode = 2; trace = hit; invalidate() } else mode = 1
            }
            MotionEvent.ACTION_POINTER_DOWN -> mode = 3
            MotionEvent.ACTION_POINTER_UP -> {
                val keep = if (e.actionIndex == 0) 1 else 0
                if (keep < e.pointerCount) { lastX = e.getX(keep); lastY = e.getY(keep) }
                if (e.pointerCount <= 2) mode = 1
            }
            MotionEvent.ACTION_MOVE -> {
                if (mode == 3 || scaleDet.isInProgress) return true
                if (hypot(e.x - downX, e.y - downY) > dp(6f)) moved = true
                if (mode == 1) {
                    cx -= (e.x - lastX) / ppu; cy += (e.y - lastY) / ppu
                    lastX = e.x; lastY = e.y
                    viewChanged()
                } else if (mode == 2) dragTrace(e.x, e.y)
            }
            MotionEvent.ACTION_UP -> {
                if (mode == 1 && !moved) { trace = null; invalidate() }
                mode = 0
                onViewChanged?.invoke()
            }
            MotionEvent.ACTION_CANCEL -> mode = 0
        }
        return true
    }

    override fun onGenericMotionEvent(e: MotionEvent): Boolean {
        if (e.isFromSource(InputDevice.SOURCE_CLASS_POINTER) && e.actionMasked == MotionEvent.ACTION_SCROLL) {
            val v = e.getAxisValue(MotionEvent.AXIS_VSCROLL)
            if (v != 0f) { zoomAt(e.x, e.y, 1.15.pow(v.toDouble())); viewChanged(); return true }
        }
        return super.onGenericMotionEvent(e)
    }

    /** What's under a touch: a point, a point of interest, else the nearest curve vertex. */
    private fun hitTest(px: Float, py: Float): Trace? {
        val s = scene ?: return null
        val r = dp(20f)
        for (d in s.dots) if (hypot(sx(d.x) - px, sy(d.y) - py) < r) return Trace(d.color, d.x, d.y, null)
        for (p in s.pois) if (hypot(sx(p.x) - px, sy(p.y) - py) < r) return Trace(alpha(ink, 0xB0), p.x, p.y, null)
        var best: Curve? = null; var bd = dp(22f).toDouble(); var bx = 0.0; var by = 0.0
        for (cv in s.curves) for (line in cv.lines) {
            var i = 0
            while (i < line.size) {
                val d = hypot((sx(line[i]) - px).toDouble(), (sy(line[i + 1]) - py).toDouble())
                if (d < bd) { bd = d; best = cv; bx = line[i]; by = line[i + 1] }
                i += 2
            }
        }
        val cv = best ?: return null
        return traceOn(cv, px, py) ?: Trace(cv.color, bx, by, cv)
    }

    /** Exact trace on an explicit curve (evaluates the function at the finger), else nearest vertex. */
    private fun traceOn(cv: Curve, px: Float, py: Float): Trace? {
        val it = cv.item as? PlotItem.Explicit ?: return null
        val fr = it.g.frame()
        return if (!it.alongY) {
            val x = wx(px); fr[MathEngine.SX] = x; val y = it.g.f(fr)
            if (y.isFinite()) Trace(cv.color, x, y, cv) else null
        } else {
            val y = wy(py); fr[MathEngine.SY] = y; val x = it.g.f(fr)
            if (x.isFinite()) Trace(cv.color, x, y, cv) else null
        }
    }

    private fun dragTrace(px: Float, py: Float) {
        val t = trace ?: return
        val cv = t.curve ?: return
        val exact = traceOn(cv, px, py)
        if (exact != null) { trace = exact; invalidate(); return }
        var bd = Double.MAX_VALUE; var bx = t.x; var by = t.y
        for (line in cv.lines) {
            var i = 0
            while (i < line.size) {
                val d = hypot((sx(line[i]) - px).toDouble(), (sy(line[i + 1]) - py).toDouble())
                if (d < bd) { bd = d; bx = line[i]; by = line[i + 1] }
                i += 2
            }
        }
        trace = Trace(cv.color, bx, by, cv); invalidate()
    }

    // ---------------------------------------------------------------- export to the notebook page
    /**
     * The visible graph as ink: frame, axes, ticks, stroke-font numbers and every curve / point,
     * in a box [w]×[h] page units (y down). Strict-inequality boundaries become dashed strokes.
     */
    fun exportInk(maxW: Float = 420f, maxH: Float = 560f): Triple<List<GraphInk>, Float, Float>? {
        val s = scene ?: return null
        if (width == 0 || height == 0) return null
        val vp = viewport()
        var W = maxW; var H = W * height / width
        if (H > maxH) { H = maxH; W = H * width / height }
        val out = ArrayList<GraphInk>()
        fun bx(x: Double) = ((x - vp.x0) / (vp.x1 - vp.x0) * W).toFloat()
        fun by(y: Double) = ((vp.y1 - y) / (vp.y1 - vp.y0) * H).toFloat()
        val frameColor = Color.rgb(0xA0, 0xA6, 0xB0)
        out.add(GraphInk(listOf(PointF(0f, 0f), PointF(W, H)), frameColor, 1f, GraphInk.RECT))

        // axes + ticks + labels
        val step = niceStep((vp.x1 - vp.x0) / 6)
        val ax = bx(0.0); val ay = by(0.0)
        val xAxisVisible = ay in 0f..H; val yAxisVisible = ax in 0f..W
        if (xAxisVisible) out.add(GraphInk(listOf(PointF(0f, ay), PointF(W, ay)), GraphInk.AXIS, 1.3f, GraphInk.LINE))
        if (yAxisVisible) out.add(GraphInk(listOf(PointF(ax, 0f), PointF(ax, H)), GraphInk.AXIS, 1.3f, GraphInk.LINE))
        val tickY = if (xAxisVisible) ay else H
        val tickX = if (yAxisVisible) ax else 0f
        val glyph = 8.5f
        run {
            val k0 = ceil(vp.x0 / step).toLong(); val k1 = floor(vp.x1 / step).toLong()
            if (k1 - k0 < 60) for (k in k0..k1) {
                if (k == 0L) continue
                val x = bx(k * step)
                if (x < 6f || x > W - 6f) continue
                out.add(GraphInk(listOf(PointF(x, tickY - 3.5f), PointF(x, tickY + 3.5f)), GraphInk.AXIS, 1f, GraphInk.LINE))
                val txt = exportLabel(k * step, step)
                val top = if (tickY + 5f + glyph < H - 2f) tickY + 5f else tickY - 5f - glyph
                StrokeFont.layout(txt, x, top, glyph, StrokeFont.CENTER).forEach { out.add(GraphInk(it, GraphInk.AXIS, 0.9f, GraphInk.FREE)) }
            }
        }
        run {
            val k0 = ceil(vp.y0 / step).toLong(); val k1 = floor(vp.y1 / step).toLong()
            if (k1 - k0 < 60) for (k in k0..k1) {
                if (k == 0L) continue
                val y = by(k * step)
                if (y < 6f || y > H - 6f) continue
                out.add(GraphInk(listOf(PointF(tickX - 3.5f, y), PointF(tickX + 3.5f, y)), GraphInk.AXIS, 1f, GraphInk.LINE))
                val txt = exportLabel(k * step, step)
                val w = StrokeFont.width(txt, glyph)
                if (tickX - 5f - w > 2f) StrokeFont.layout(txt, tickX - 5f, y - glyph / 2, glyph, StrokeFont.RIGHT).forEach { out.add(GraphInk(it, GraphInk.AXIS, 0.9f, GraphInk.FREE)) }
                else StrokeFont.layout(txt, tickX + 5f, y - glyph / 2, glyph, StrokeFont.LEFT).forEach { out.add(GraphInk(it, GraphInk.AXIS, 0.9f, GraphInk.FREE)) }
            }
        }

        // curves, clipped to the view box
        for (cv in s.curves) {
            for (line in cv.lines) {
                for (piece in clip(line, vp)) {
                    val pts = ArrayList<PointF>()
                    var i = 0
                    while (i < piece.size) {
                        val p = PointF(bx(piece[i]), by(piece[i + 1]))
                        if (pts.isEmpty() || i == piece.size - 2 || hypot(p.x - pts.last().x, p.y - pts.last().y) > 0.8f) pts.add(p)
                        i += 2
                    }
                    if (pts.size < 2) continue
                    if (cv.dashed) dashes(pts, 8f, 5f).forEach { out.add(GraphInk(it, cv.color, 2.2f, GraphInk.FREE)) }
                    else out.add(GraphInk(pts, cv.color, 2.2f, GraphInk.FREE))
                }
            }
        }
        for (d in s.dots) {
            if (d.x < vp.x0 || d.x > vp.x1 || d.y < vp.y0 || d.y > vp.y1) continue
            val x = bx(d.x); val y = by(d.y)
            out.add(GraphInk(listOf(PointF(x - 2.4f, y - 2.4f), PointF(x + 2.4f, y + 2.4f)), d.color, 2.6f, GraphInk.DOT))
        }
        return Triple(out, W, H)
    }

    private fun exportLabel(v: Double, step: Double): String {
        val a = abs(step)
        if (a >= 1e5 || a < 1e-4) {
            val e = floor(log10(abs(v))).toInt()
            val m = v / 10.0.pow(e)
            val ms = if (abs(m - Math.rint(m)) < 1e-9) Math.rint(m).toLong().toString() else "%.1f".format(m)
            return ms + "e" + e
        }
        val d = max(0, ceil(-log10(a) - 1e-9).toInt())
        return "%.${d}f".format(v)
    }

    /** Split a polyline (world coords) into the pieces inside [vp] (Liang–Barsky per segment). */
    private fun clip(a: DoubleArray, vp: Viewport): List<DoubleArray> {
        val out = ArrayList<DoubleArray>()
        var cur = ArrayList<Double>()
        fun flush() { if (cur.size >= 4) out.add(cur.toDoubleArray()); cur = ArrayList() }
        var i = 0
        while (i + 3 < a.size) {
            val x0 = a[i]; val y0 = a[i + 1]; val x1 = a[i + 2]; val y1 = a[i + 3]
            val dx = x1 - x0; val dy = y1 - y0
            var t0 = 0.0; var t1 = 1.0; var ok = true
            for ((p, q) in listOf(-dx to x0 - vp.x0, dx to vp.x1 - x0, -dy to y0 - vp.y0, dy to vp.y1 - y0)) {
                if (p == 0.0) { if (q < 0) { ok = false; break } }
                else { val r = q / p; if (p < 0) { if (r > t1) { ok = false; break }; if (r > t0) t0 = r } else { if (r < t0) { ok = false; break }; if (r < t1) t1 = r } }
            }
            if (!ok) { flush() }
            else {
                val sx0 = x0 + t0 * dx; val sy0 = y0 + t0 * dy; val sx1 = x0 + t1 * dx; val sy1 = y0 + t1 * dy
                if (t0 > 0.0) flush()
                if (cur.isEmpty()) { cur.add(sx0); cur.add(sy0) }
                cur.add(sx1); cur.add(sy1)
                if (t1 < 1.0) flush()
            }
            i += 2
        }
        flush()
        return out
    }

    private fun dashes(pts: List<PointF>, on: Float, off: Float): List<List<PointF>> {
        val out = ArrayList<List<PointF>>()
        var cur = ArrayList<PointF>()
        var drawing = true; var left = on
        cur.add(pts[0])
        for (k in 1 until pts.size) {
            var a = pts[k - 1]; val b = pts[k]
            var seg = hypot(b.x - a.x, b.y - a.y)
            while (seg > 0f) {
                val take = min(seg, left)
                val t = take / seg
                val p = PointF(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
                if (drawing) cur.add(p)
                seg -= take; left -= take; a = p
                if (left <= 0f) {
                    if (drawing && cur.size >= 2) out.add(cur)
                    drawing = !drawing; left = if (drawing) on else off
                    cur = ArrayList(); if (drawing) cur.add(p)
                }
            }
        }
        if (drawing && cur.size >= 2) out.add(cur)
        return out
    }
}

/** A tiny single-stroke font for the numbers on exported graph axes (digits, − . e). */
object StrokeFont {
    const val LEFT = 0; const val CENTER = 1; const val RIGHT = 2

    private fun P(vararg v: Float): List<PointF> { val o = ArrayList<PointF>(); var i = 0; while (i < v.size) { o.add(PointF(v[i], v[i + 1])); i += 2 }; return o }

    // Glyphs in a 0.6 × 1 cell, y down.
    private val GLYPHS: Map<Char, List<List<PointF>>> = mapOf(
        '0' to listOf(P(0.3f, 0f, 0.5f, 0.08f, 0.58f, 0.3f, 0.58f, 0.7f, 0.5f, 0.92f, 0.3f, 1f, 0.1f, 0.92f, 0.02f, 0.7f, 0.02f, 0.3f, 0.1f, 0.08f, 0.3f, 0f)),
        '1' to listOf(P(0.12f, 0.2f, 0.32f, 0f, 0.32f, 1f)),
        '2' to listOf(P(0.04f, 0.22f, 0.14f, 0.05f, 0.3f, 0f, 0.47f, 0.06f, 0.55f, 0.22f, 0.5f, 0.42f, 0.04f, 1f, 0.58f, 1f)),
        '3' to listOf(P(0.05f, 0.1f, 0.25f, 0f, 0.45f, 0.05f, 0.53f, 0.2f, 0.45f, 0.38f, 0.25f, 0.46f, 0.48f, 0.53f, 0.57f, 0.72f, 0.48f, 0.92f, 0.28f, 1f, 0.05f, 0.92f)),
        '4' to listOf(P(0.45f, 1f, 0.45f, 0f, 0.02f, 0.7f, 0.6f, 0.7f)),
        '5' to listOf(P(0.55f, 0f, 0.1f, 0f, 0.06f, 0.45f, 0.28f, 0.38f, 0.5f, 0.45f, 0.58f, 0.68f, 0.5f, 0.9f, 0.3f, 1f, 0.05f, 0.92f)),
        '6' to listOf(P(0.5f, 0.05f, 0.3f, 0f, 0.12f, 0.12f, 0.04f, 0.45f, 0.05f, 0.75f, 0.15f, 0.95f, 0.3f, 1f, 0.48f, 0.95f, 0.57f, 0.75f, 0.5f, 0.55f, 0.3f, 0.48f, 0.12f, 0.55f, 0.05f, 0.7f)),
        '7' to listOf(P(0.02f, 0f, 0.58f, 0f, 0.2f, 1f)),
        '8' to listOf(P(0.3f, 0.47f, 0.1f, 0.37f, 0.08f, 0.15f, 0.3f, 0f, 0.52f, 0.15f, 0.5f, 0.37f, 0.3f, 0.47f, 0.07f, 0.6f, 0.05f, 0.85f, 0.3f, 1f, 0.55f, 0.85f, 0.53f, 0.6f, 0.3f, 0.47f)),
        '9' to listOf(P(0.55f, 0.3f, 0.45f, 0.48f, 0.27f, 0.52f, 0.08f, 0.42f, 0.05f, 0.22f, 0.15f, 0.05f, 0.3f, 0f, 0.48f, 0.05f, 0.55f, 0.25f, 0.55f, 0.6f, 0.45f, 0.88f, 0.3f, 1f, 0.08f, 0.95f)),
        '-' to listOf(P(0.08f, 0.55f, 0.45f, 0.55f)),
        '.' to listOf(P(0.12f, 0.95f, 0.16f, 0.97f)),
        'e' to listOf(P(0.08f, 0.68f, 0.52f, 0.68f, 0.48f, 0.5f, 0.3f, 0.42f, 0.1f, 0.52f, 0.06f, 0.76f, 0.18f, 0.96f, 0.48f, 0.95f)),
        // Axis letters for exported 3D graphs.
        'x' to listOf(P(0.06f, 0.42f, 0.54f, 1f), P(0.54f, 0.42f, 0.06f, 1f)),
        'y' to listOf(P(0.06f, 0.42f, 0.3f, 0.95f), P(0.54f, 0.42f, 0.22f, 1.15f, 0.08f, 1.22f)),
        'z' to listOf(P(0.08f, 0.42f, 0.52f, 0.42f, 0.08f, 1f, 0.54f, 1f)),
    )

    private fun advance(ch: Char) = when (ch) { '.' -> 0.32f; '1' -> 0.55f; '-' -> 0.58f; else -> 0.72f }

    fun width(text: String, size: Float): Float = text.sumOf { advance(it).toDouble() }.toFloat() * size - 0.12f * size

    /** Strokes for [text] with cap height [size], anchored at ([x], [top]). */
    fun layout(text: String, x: Float, top: Float, size: Float, anchor: Int): List<List<PointF>> {
        val w = width(text, size)
        var pen = when (anchor) { CENTER -> x - w / 2; RIGHT -> x - w; else -> x }
        val out = ArrayList<List<PointF>>()
        for (ch in text) {
            GLYPHS[ch]?.forEach { stroke -> out.add(stroke.map { PointF(pen + it.x * size, top + it.y * size) }) }
            pen += advance(ch) * size
        }
        return out
    }
}
