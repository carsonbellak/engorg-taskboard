package com.engorg.inkpad

import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.PointF
import android.view.View
import androidx.ink.rendering.android.canvas.CanvasStrokeRenderer
import androidx.ink.strokes.Stroke

/**
 * Renders finished strokes and owns the pan (page offset). Strokes are stored in WORLD
 * coordinates (pan-independent) and drawn through [worldToScreen] so panning the page just
 * moves everything. Each stroke keeps its input points (also world coords) so the eraser can
 * hit-test without touching the ink geometry API.
 */
class FinishedStrokesView(context: Context) : View(context) {

    private val renderer = CanvasStrokeRenderer.create()
    private val strokes = ArrayList<Pair<Stroke, List<PointF>>>()
    private val worldToScreen = Matrix()
    var panX = 0f; private set
    var panY = 0f; private set

    fun addStroke(stroke: Stroke, worldPoints: List<PointF>) {
        strokes.add(stroke to worldPoints)
        invalidate()
    }

    fun clearAll() {
        strokes.clear()
        invalidate()
    }

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
        for ((stroke, _) in strokes) renderer.draw(canvas, stroke, worldToScreen)
    }
}
