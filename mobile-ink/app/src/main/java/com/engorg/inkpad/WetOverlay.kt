package com.engorg.inkpad

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.view.View

/**
 * Draws the in-progress ("wet") stroke ourselves, in plain screen coordinates, straight from the
 * captured touch points. This removes any dependence on the ink engine's coordinate space, so the
 * wet stroke is always exactly under the pen — and the committed stroke (built from the same
 * points) lands in the same place.
 */
class WetOverlay(context: Context) : View(context) {

    private var path: Path? = null
    private val paint = Paint().apply {
        isAntiAlias = true; style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }

    fun setStroke(points: List<PointF>, color: Int, widthPx: Float, highlighter: Boolean) {
        paint.strokeWidth = widthPx
        paint.color = if (highlighter)
            Color.argb(0x66, Color.red(color), Color.green(color), Color.blue(color))
        else Color.argb(0xFF, Color.red(color), Color.green(color), Color.blue(color))
        if (points.size < 2) {
            if (points.size == 1) { val p = Path(); p.addCircle(points[0].x, points[0].y, widthPx / 2f, Path.Direction.CW); path = p }
            else path = null
            invalidate(); return
        }
        val p = Path()
        p.moveTo(points[0].x, points[0].y)
        for (i in 1 until points.size - 1) {
            val mx = (points[i].x + points[i + 1].x) / 2f
            val my = (points[i].y + points[i + 1].y) / 2f
            p.quadTo(points[i].x, points[i].y, mx, my)
        }
        val last = points[points.size - 1]
        p.lineTo(last.x, last.y)
        path = p
        invalidate()
    }

    fun clear() { path = null; invalidate() }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val p = path ?: return
        if (paint.style == Paint.Style.STROKE && paint.strokeWidth <= 0f) return
        canvas.drawPath(p, paint)
    }
}
