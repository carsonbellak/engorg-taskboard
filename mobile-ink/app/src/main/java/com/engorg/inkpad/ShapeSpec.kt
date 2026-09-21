package com.engorg.inkpad

import android.graphics.PointF
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

enum class ShapeType { LINE, ARROW, RECT, ELLIPSE, TRIANGLE, AXES2D, AXES3D }

/**
 * A parametric shape defined by a small set of draggable vertices (in page-local coords).
 * The vertices ARE the editable handles; [polylines] turns them into dense point paths that
 * get built into ink strokes for rendering. Editing a handle just moves a vertex and rebuilds.
 */
class ShapeSpec(var type: ShapeType, val verts: ArrayList<PointF>) {

    fun clone() = ShapeSpec(type, ArrayList(verts.map { PointF(it.x, it.y) }))

    /** The draggable handle points (same objects as [verts]). */
    val handles: List<PointF> get() = verts

    /** One or more dense polylines (page-local) — each becomes a stroke. */
    fun polylines(): List<List<PointF>> = when (type) {
        ShapeType.LINE -> listOf(interp(verts[0], verts[1], 24))
        ShapeType.ARROW -> listOf(arrow(verts[0], verts[1]))
        ShapeType.RECT -> {
            val a = verts[0]; val b = verts[1]
            listOf(closed(listOf(PointF(a.x, a.y), PointF(b.x, a.y), PointF(b.x, b.y), PointF(a.x, b.y))))
        }
        ShapeType.ELLIPSE -> {
            val cx = (verts[0].x + verts[1].x) / 2f; val cy = (verts[0].y + verts[1].y) / 2f
            listOf(ellipse(cx, cy, abs(verts[1].x - verts[0].x) / 2f, abs(verts[1].y - verts[0].y) / 2f))
        }
        ShapeType.TRIANGLE -> listOf(closed(listOf(verts[0], verts[1], verts[2])))
        ShapeType.AXES2D -> axes2d(verts[0], verts[1])
        ShapeType.AXES3D -> axes3d(verts[0], verts[1])
    }

    companion object {
        /** Build a shape of a sensible default size centered at (cx,cy). */
        fun make(type: ShapeType, cx: Float, cy: Float, s: Float): ShapeSpec {
            val v = when (type) {
                ShapeType.LINE, ShapeType.ARROW -> arrayListOf(PointF(cx - s, cy + s * 0.4f), PointF(cx + s, cy - s * 0.4f))
                ShapeType.RECT, ShapeType.ELLIPSE -> arrayListOf(PointF(cx - s, cy - s * 0.72f), PointF(cx + s, cy + s * 0.72f))
                ShapeType.TRIANGLE -> arrayListOf(PointF(cx, cy - s), PointF(cx + s, cy + s), PointF(cx - s, cy + s))
                ShapeType.AXES2D -> arrayListOf(PointF(cx, cy), PointF(cx + s, cy - s))
                ShapeType.AXES3D -> arrayListOf(PointF(cx, cy + s * 0.55f), PointF(cx + s * 0.75f, cy - s * 0.75f))
            }
            return ShapeSpec(type, v)
        }

        private fun interp(a: PointF, b: PointF, n: Int): List<PointF> =
            (0..n).map { val t = it.toFloat() / n; PointF(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) }

        private fun closed(corners: List<PointF>): List<PointF> {
            val out = ArrayList<PointF>()
            for (i in corners.indices) out.addAll(interp(corners[i], corners[(i + 1) % corners.size], 14).dropLast(1))
            out.add(PointF(corners[0].x, corners[0].y))
            return out
        }

        private fun ellipse(cx: Float, cy: Float, rx: Float, ry: Float): List<PointF> {
            val n = 60
            return (0..n).map { val t = it.toFloat() / n * 2f * Math.PI.toFloat(); PointF(cx + rx * cos(t), cy + ry * sin(t)) }
        }

        /** Line a→b with a V arrowhead at b, as one continuous polyline. */
        private fun arrow(a: PointF, b: PointF): List<PointF> {
            val ang = atan2((b.y - a.y).toDouble(), (b.x - a.x).toDouble())
            // Compact arrowhead — small, notes-scale wings rather than the previous chunky ~16–70px V.
            val hl = (hypot(b.x - a.x, b.y - a.y) * 0.13f).coerceIn(6f, 22f)
            val left = PointF((b.x - hl * cos(ang - 0.42)).toFloat(), (b.y - hl * sin(ang - 0.42)).toFloat())
            val right = PointF((b.x - hl * cos(ang + 0.42)).toFloat(), (b.y - hl * sin(ang + 0.42)).toFloat())
            val out = ArrayList<PointF>(interp(a, b, 22))
            out.add(left); out.add(PointF(b.x, b.y)); out.add(right)
            return out
        }

        /** Center c, extent handle e. Full 4-quadrant cross: x and y both directions, arrows on all ends. */
        private fun axes2d(c: PointF, e: PointF): List<List<PointF>> {
            val lenX = abs(e.x - c.x).coerceAtLeast(30f)
            val lenY = abs(c.y - e.y).coerceAtLeast(30f)
            val out = ArrayList<List<PointF>>()
            // four half-axes from the center, each with an arrowhead at its far end
            out.add(arrow(c, PointF(c.x + lenX, c.y)))
            out.add(arrow(c, PointF(c.x - lenX, c.y)))
            out.add(arrow(c, PointF(c.x, c.y - lenY)))
            out.add(arrow(c, PointF(c.x, c.y + lenY)))
            // tick marks on both sides of each axis (small, so they read as scale marks not bars)
            val tk = 3.5f
            var i = 1
            while (i <= 4) {
                val dx = lenX * i / 5f
                out.add(listOf(PointF(c.x + dx, c.y - tk), PointF(c.x + dx, c.y + tk)))
                out.add(listOf(PointF(c.x - dx, c.y - tk), PointF(c.x - dx, c.y + tk)))
                val dy = lenY * i / 5f
                out.add(listOf(PointF(c.x - tk, c.y - dy), PointF(c.x + tk, c.y - dy)))
                out.add(listOf(PointF(c.x - tk, c.y + dy), PointF(c.x + tk, c.y + dy)))
                i++
            }
            return out
        }

        /** Isometric x/y/z axes from origin o; e scales the reach. */
        private fun axes3d(o: PointF, e: PointF): List<List<PointF>> {
            val len = hypot(e.x - o.x, e.y - o.y).coerceAtLeast(40f)
            val z = PointF(o.x, o.y - len)
            val x = PointF(o.x + len * 0.87f, o.y + len * 0.5f)
            val y = PointF(o.x - len * 0.87f, o.y + len * 0.5f)
            return listOf(arrow(o, x), arrow(o, y), arrow(o, z))
        }
    }
}
