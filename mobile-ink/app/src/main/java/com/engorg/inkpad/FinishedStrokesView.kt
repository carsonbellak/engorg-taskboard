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
 * Renders the page: background color, paper ruling, then the finished strokes. Strokes are
 * stored in WORLD coordinates (pan-independent) and drawn through [worldToScreen], so the
 * whole page — paper lines included — pans together. Each stroke keeps its input points
 * (world coords) so the eraser can hit-test without the ink geometry API.
 */
class FinishedStrokesView(context: Context) : View(context) {

    enum class PaperStyle { PLAIN, GRID, RULED, DOTS }

    private val renderer = CanvasStrokeRenderer.create()
    private val strokes = ArrayList<Pair<Stroke, List<PointF>>>()
    private val worldToScreen = Matrix()
    private val paperPaint = Paint().apply { isAntiAlias = true }

    var panX = 0f; private set
    var panY = 0f; private set

    var pageColor = Color.rgb(0xFD, 0xFD, 0xFB)
        set(value) { field = value; invalidate() }
    var paperStyle = PaperStyle.GRID
        set(value) { field = value; invalidate() }

    fun addStroke(stroke: Stroke, worldPoints: List<PointF>) {
        strokes.add(stroke to worldPoints); invalidate()
    }

    fun clearAll() { strokes.clear(); invalidate() }

    fun setPan(x: Float, y: Float) {
        panX = x; panY = y
        worldToScreen.setTranslate(panX, panY)
        invalidate()
    }

    /** Remove every stroke passing within [radius] world units of ([wx],[wy]). */
    fun eraseNear(wx: Float, wy: Float, radius: Float): Boolean {
        val r2 = radius * radius
        val before = strokes.size
        strokes.removeAll { (_, pts) ->
            pts.any { val dx = it.x - wx; val dy = it.y - wy; dx * dx + dy * dy <= r2 }
        }
        val changed = strokes.size != before
        if (changed) invalidate()
        return changed
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(pageColor)
        drawPaper(canvas)
        for ((stroke, _) in strokes) renderer.draw(canvas, stroke, worldToScreen)
    }

    private fun drawPaper(canvas: Canvas) {
        if (paperStyle == PaperStyle.PLAIN) return
        val w = width.toFloat()
        val h = height.toFloat()
        val sp = 56f
        val lum = 0.299 * Color.red(pageColor) + 0.587 * Color.green(pageColor) + 0.114 * Color.blue(pageColor)
        paperPaint.color = if (lum < 128) Color.argb(46, 255, 255, 255) else Color.argb(32, 30, 50, 90)
        when (paperStyle) {
            PaperStyle.GRID -> {
                paperPaint.style = Paint.Style.STROKE; paperPaint.strokeWidth = 1f
                var x = (panX % sp) - sp; while (x < w) { canvas.drawLine(x, 0f, x, h, paperPaint); x += sp }
                var y = (panY % sp) - sp; while (y < h) { canvas.drawLine(0f, y, w, y, paperPaint); y += sp }
            }
            PaperStyle.RULED -> {
                paperPaint.style = Paint.Style.STROKE; paperPaint.strokeWidth = 1f
                var y = (panY % sp) - sp; while (y < h) { canvas.drawLine(0f, y, w, y, paperPaint); y += sp }
            }
            PaperStyle.DOTS -> {
                paperPaint.style = Paint.Style.FILL
                var y = (panY % sp) - sp
                while (y < h) {
                    var x = (panX % sp) - sp
                    while (x < w) { canvas.drawCircle(x, y, 1.7f, paperPaint); x += sp }
                    y += sp
                }
            }
            else -> {}
        }
    }
}
