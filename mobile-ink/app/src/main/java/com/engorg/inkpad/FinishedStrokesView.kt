package com.engorg.inkpad

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PointF
import android.view.View
import androidx.ink.rendering.android.canvas.CanvasStrokeRenderer
import androidx.ink.strokes.Stroke

/**
 * Renders a fixed-size page (8.5x11 in world units) on a backdrop, with paper ruling and the
 * finished strokes. Everything is drawn through a scale+translate transform (zoom + pan).
 * Strokes are stored in WORLD (page) coordinates; each record keeps world points for erase.
 */
class FinishedStrokesView(context: Context) : View(context) {

    enum class PaperStyle { PLAIN, GRID, RULED, DOTS }

    data class Rec(val stroke: Stroke, val points: List<PointF>, val highlighter: Boolean)

    companion object {
        const val PAGE_W = 816f  // 8.5in * 96
        const val PAGE_H = 1056f // 11in  * 96
    }

    private val renderer = CanvasStrokeRenderer.create()
    private val recs = ArrayList<Rec>()
    private val worldToScreen = Matrix()
    private val paperPaint = Paint().apply { isAntiAlias = true }
    private val pagePaint = Paint().apply { isAntiAlias = true }
    private val shadowPaint = Paint().apply { isAntiAlias = true; color = Color.argb(60, 0, 0, 0) }
    private val borderPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 1f; color = Color.argb(40, 0, 0, 0) }

    var scale = 1f; private set
    var tx = 0f; private set
    var ty = 0f; private set

    var backdrop = Color.rgb(0xE9, 0xEA, 0xEC)
    var pageColor = Color.WHITE
        set(value) { field = value; invalidate() }
    var paperStyle = PaperStyle.GRID
        set(value) { field = value; invalidate() }

    fun setTransform(s: Float, x: Float, y: Float) {
        scale = s; tx = x; ty = y
        worldToScreen.setScale(s, s); worldToScreen.postTranslate(x, y)
        invalidate()
    }

    fun addStroke(stroke: Stroke, worldPoints: List<PointF>, highlighter: Boolean) {
        recs.add(Rec(stroke, worldPoints, highlighter)); invalidate()
    }

    fun clearAll() { recs.clear(); invalidate() }
    fun snapshot(): List<Rec> = ArrayList(recs)
    fun setAll(list: List<Rec>) { recs.clear(); recs.addAll(list); invalidate() }

    fun eraseNear(wx: Float, wy: Float, radius: Float): Boolean {
        val r2 = radius * radius
        val before = recs.size
        recs.removeAll { rec ->
            rec.points.any { val dx = it.x - wx; val dy = it.y - wy; dx * dx + dy * dy <= r2 }
        }
        val changed = recs.size != before
        if (changed) invalidate()
        return changed
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(backdrop)
        val l = tx; val t = ty; val r = tx + PAGE_W * scale; val b = ty + PAGE_H * scale
        canvas.drawRect(l + 5, t + 7, r + 5, b + 7, shadowPaint)
        pagePaint.color = pageColor
        canvas.drawRect(l, t, r, b, pagePaint)
        val save = canvas.save()
        canvas.clipRect(l, t, r, b)
        drawPaper(canvas, l, t)
        for (rec in recs) renderer.draw(canvas, rec.stroke, worldToScreen)
        canvas.restoreToCount(save)
        canvas.drawRect(l, t, r, b, borderPaint)
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
}
