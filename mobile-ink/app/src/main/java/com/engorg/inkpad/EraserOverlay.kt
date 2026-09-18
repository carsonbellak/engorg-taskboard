package com.engorg.inkpad

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View

/** Non-interactive top layer that draws a circle showing the eraser's reach. */
class EraserOverlay(context: Context) : View(context) {

    private var cx = 0f
    private var cy = 0f
    private var r = 0f
    private var shown = false

    private val ring = Paint().apply {
        isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = 2f
        color = Color.argb(0xC0, 0x50, 0x50, 0x50)
    }
    private val fill = Paint().apply {
        isAntiAlias = true; style = Paint.Style.FILL
        color = Color.argb(0x22, 0x80, 0x80, 0x80)
    }

    fun show(x: Float, y: Float, radius: Float) {
        cx = x; cy = y; r = radius; shown = true; invalidate()
    }

    fun hide() {
        if (shown) { shown = false; invalidate() }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (shown) {
            canvas.drawCircle(cx, cy, r, fill)
            canvas.drawCircle(cx, cy, r, ring)
        }
    }
}
