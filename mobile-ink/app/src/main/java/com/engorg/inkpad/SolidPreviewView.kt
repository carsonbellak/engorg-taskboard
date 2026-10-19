package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.view.MotionEvent
import android.view.View
import kotlin.math.hypot

/**
 * The live picture in the 3D solid editor: the solid with its face colors and water, drawn as it
 * will look on the page. Drag to turn it (the water levels out as it turns), tap a face to pick it
 * for coloring — picked faces are tinted with the accent.
 */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class SolidPreviewView(
    context: Context,
    var params: SolidParams,
    val fill: SolidFill,
    view: FloatArray,
    val picked: MutableSet<Int>,
    private val onPick: (Int) -> Unit,
) : View(context) {
    private val dens = resources.displayMetrics.density
    private var rot = view.copyOf()
    private var cx = 0f; private var cy = 0f; private var size = 1f

    private val fillP = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val lineP = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val path = Path()

    private fun solid(): Solid {
        val s = Solid(params.copy(), rot.copyOf(), 1f, fill)
        val pad = 14f * dens
        val c = s.fitTo(pad, pad, width - pad, height - pad)
        cx = c.x; cy = c.y; size = s.size
        return s
    }

    override fun onDraw(c: Canvas) {
        if (width == 0) return
        val s = solid()
        for (f in s.fills(cx, cy)) {
            path.reset()
            for (poly in f.polys) if (poly.size >= 3) { path.moveTo(poly[0].x, poly[0].y); for (k in 1 until poly.size) path.lineTo(poly[k].x, poly[k].y); path.close() }
            fillP.color = f.color; c.drawPath(path, fillP)
            if (f.edge != 0) { lineP.color = f.edge; lineP.strokeWidth = 1.2f * dens; lineP.pathEffect = null; c.drawPath(path, lineP) }
        }
        // Picked faces: an accent tint over their visible side.
        for (r in picked) {
            path.reset()
            for (poly in s.regionPolys(cx, cy, r)) if (poly.size >= 3) { path.moveTo(poly[0].x, poly[0].y); for (k in 1 until poly.size) path.lineTo(poly[k].x, poly[k].y); path.close() }
            fillP.color = Color.argb(0x55, Color.red(AppTheme.accent), Color.green(AppTheme.accent), Color.blue(AppTheme.accent)); c.drawPath(path, fillP)
            lineP.color = AppTheme.accent; lineP.strokeWidth = 2.4f * dens; lineP.pathEffect = null; c.drawPath(path, lineP)
        }
        // The outline on top: hidden edges dashed.
        lineP.color = AppTheme.text; lineP.strokeWidth = 1.6f * dens
        val dash = DashPathEffect(floatArrayOf(5f * dens, 4f * dens), 0f)
        for (part in s.parts(cx, cy)) {
            path.reset()
            part.pts.forEachIndexed { k, p -> if (k == 0) path.moveTo(p.x, p.y) else path.lineTo(p.x, p.y) }
            lineP.pathEffect = if (part.hidden) dash else null
            c.drawPath(path, lineP)
        }
        lineP.pathEffect = null
    }

    private var downX = 0f; private var downY = 0f; private var moved = false
    private var base = rot.copyOf()

    override fun onTouchEvent(e: MotionEvent): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downX = e.x; downY = e.y; moved = false; base = rot.copyOf() }
            MotionEvent.ACTION_MOVE -> {
                if (hypot(e.x - downX, e.y - downY) > 6f * dens) moved = true
                if (moved) {
                    val s = Solid(params, base.copyOf())
                    s.orbit(base, (e.x - downX) / dens * 0.6f, (e.y - downY) / dens * 0.6f)
                    rot = s.r.copyOf(); invalidate()
                }
            }
            MotionEvent.ACTION_UP -> if (!moved) {
                val s = solid()
                val r = s.regionAt(cx, cy, e.x, e.y)
                if (r >= 0) onPick(r)
            }
        }
        return true
    }
}
