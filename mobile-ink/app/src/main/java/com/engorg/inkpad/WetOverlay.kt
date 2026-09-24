package com.engorg.inkpad

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.view.View

/**
 * Draws the in-progress ("wet") stroke ourselves, in plain screen coordinates, straight from the
 * captured touch points. This removes any dependence on the ink engine's coordinate space, so the
 * wet stroke is always exactly under the pen — and the committed stroke (built from the same
 * points) lands in the same place.
 *
 * When smoothing is on, the committed line trails behind the pen; we also paint a small "ball"
 * cursor at the raw pen position with a thin leash back to the line's head (Photoshop-style), so
 * you can see where the ink is being pulled toward.
 */
class WetOverlay(context: Context) : View(context) {

    private var points: List<PointF> = emptyList()
    private var color = Color.BLACK
    private var widthPx = 2f
    private var highlighter = false
    private var brush = Brush.PEN

    private var showBall = false
    private var ballX = 0f
    private var ballY = 0f
    private var headX = 0f
    private var headY = 0f
    private var ballRadius = 0f

    private val paint = Paint().apply {
        isAntiAlias = true; isDither = true; style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val leashPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 1.5f }
    private val ballStroke = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f }
    private val ballFill = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL }

    fun setStroke(points: List<PointF>, color: Int, widthPx: Float, highlighter: Boolean, brush: Brush) {
        this.points = points; this.color = color; this.widthPx = widthPx
        this.highlighter = highlighter; this.brush = brush
        invalidate()
    }

    /** Position the pen-ahead cursor. [show] false hides it (e.g. when smoothing is off). */
    fun setBall(ballX: Float, ballY: Float, headX: Float, headY: Float, radius: Float, show: Boolean) {
        this.ballX = ballX; this.ballY = ballY; this.headX = headX; this.headY = headY
        this.ballRadius = radius; this.showBall = show
        invalidate()
    }

    fun clear() { points = emptyList(); showBall = false; invalidate() }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (points.isNotEmpty() && widthPx > 0f) {
            FinishedStrokesView.drawInk(canvas, points, null, color, widthPx, brush, highlighter, paint)
        }
        if (showBall) {
            val r = Color.red(color); val g = Color.green(color); val b = Color.blue(color)
            leashPaint.color = Color.argb(0x55, r, g, b)
            canvas.drawLine(headX, headY, ballX, ballY, leashPaint)
            ballFill.color = Color.argb(0x22, r, g, b)
            canvas.drawCircle(ballX, ballY, ballRadius, ballFill)
            ballStroke.color = Color.argb(0xC0, r, g, b)
            canvas.drawCircle(ballX, ballY, ballRadius, ballStroke)
        }
    }
}
