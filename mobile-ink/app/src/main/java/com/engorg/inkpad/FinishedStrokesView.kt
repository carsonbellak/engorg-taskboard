package com.engorg.inkpad

import android.content.Context
import android.graphics.Canvas
import android.graphics.Matrix
import android.view.View
import androidx.ink.rendering.android.canvas.CanvasStrokeRenderer
import androidx.ink.strokes.Stroke

/**
 * Renders the strokes the user has finished drawing. In-progress strokes are rendered
 * separately (and with much lower latency) by [androidx.ink.authoring.InProgressStrokesView];
 * when a stroke finishes it's handed off here so the low-latency layer stays empty.
 */
class FinishedStrokesView(context: Context) : View(context) {

    private val renderer = CanvasStrokeRenderer.create()
    private val strokes = ArrayList<Stroke>()
    private val identity = Matrix()

    fun addStrokes(newStrokes: Collection<Stroke>) {
        strokes.addAll(newStrokes)
        invalidate()
    }

    fun clearAll() {
        strokes.clear()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        for (stroke in strokes) {
            renderer.draw(canvas, stroke, identity)
        }
    }
}
