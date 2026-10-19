package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ComposeShader
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.SweepGradient
import android.view.MotionEvent
import android.view.View
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin

/**
 * HSV color wheel: hue around the disc, saturation from the center (white) out to the rim, and
 * brightness ([value]) applied as a dark veil set from outside (the popup's brightness slider).
 * Drag anywhere on (or past) the disc to pick; [onChange] fires on every move.
 */
class ColorWheelView(ctx: Context) : View(ctx) {
    var hue = 0f; private set
    var sat = 0f; private set
    var value = 1f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }
    var onChange: ((Int) -> Unit)? = null

    val color: Int get() = Color.HSVToColor(floatArrayOf(hue, sat, value))

    fun setColor(c: Int) {
        val hsv = FloatArray(3); Color.colorToHSV(c, hsv)
        hue = hsv[0]; sat = hsv[1]; value = hsv[2]
    }

    private val density = ctx.resources.displayMetrics.density
    private val disc = Paint(Paint.ANTI_ALIAS_FLAG)
    private val veil = Paint(Paint.ANTI_ALIAS_FLAG)
    private val thumbFill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val thumbRing = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private var cx = 0f
    private var cy = 0f
    private var r = 0f

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        cx = w / 2f; cy = h / 2f
        r = min(w, h) / 2f - 12 * density   // leave room for the thumb at the rim
        val hues = intArrayOf(Color.RED, Color.YELLOW, Color.GREEN, Color.CYAN, Color.BLUE, Color.MAGENTA, Color.RED)
        disc.shader = ComposeShader(
            SweepGradient(cx, cy, hues, null),
            RadialGradient(cx, cy, r.coerceAtLeast(1f), Color.WHITE, 0x00FFFFFF, Shader.TileMode.CLAMP),
            PorterDuff.Mode.SRC_OVER,
        )
    }

    override fun onDraw(c: Canvas) {
        c.drawCircle(cx, cy, r, disc)
        veil.color = Color.argb(((1f - value) * 255).toInt(), 0, 0, 0)
        c.drawCircle(cx, cy, r, veil)

        val a = Math.toRadians(hue.toDouble())
        val tx = cx + (cos(a) * sat * r).toFloat()
        val ty = cy + (sin(a) * sat * r).toFloat()
        val tr = 9 * density
        thumbFill.color = color
        c.drawCircle(tx, ty, tr, thumbFill)
        thumbRing.strokeWidth = 3 * density; thumbRing.color = Color.WHITE
        c.drawCircle(tx, ty, tr, thumbRing)
        thumbRing.strokeWidth = 1 * density; thumbRing.color = Color.argb(0x80, 0, 0, 0)
        c.drawCircle(tx, ty, tr + 1.5f * density, thumbRing)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                val dx = e.x - cx; val dy = e.y - cy
                hue = ((Math.toDegrees(atan2(dy, dx).toDouble()) + 360.0) % 360.0).toFloat()
                sat = (hypot(dx, dy) / r).coerceIn(0f, 1f)
                invalidate()
                onChange?.invoke(color)
            }
        }
        return true
    }
}
