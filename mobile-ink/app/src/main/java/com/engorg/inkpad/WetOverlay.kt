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
        isAntiAlias = true; isDither = true; style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }

    fun setStroke(points: List<PointF>, color: Int, widthPx: Float, highlighter: Boolean) {
        paint.strokeWidth = widthPx
        paint.color = if (highlighter)
            Color.argb(0x66, Color.red(color), Color.green(color), Color.blue(color))
        else Color.argb(0xFF, Color.red(color), Color.green(color), Color.blue(color))
        // Same Catmull-Rom smoothing the committed stroke uses, so wet == final.
        path = if (points.isEmpty()) null else FinishedStrokesView.buildPath(points)
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
