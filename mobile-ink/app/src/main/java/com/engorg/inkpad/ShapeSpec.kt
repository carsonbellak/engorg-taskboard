package com.engorg.inkpad

import android.graphics.PointF
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * AXES2D = full 4-quadrant cross; AXES2D_2Q = right half (x ≥ 0, y both ways — signal plots);
 * AXES2D_1Q = first quadrant only. AXES3D = positive octant (isometric x/y/z); AXES3D_8 = all
 * eight octants (each axis runs both ways). TABLE = a rows × cols grid, with or without its border.
 */
enum class ShapeType { LINE, ARROW, RECT, ELLIPSE, TRIANGLE, AXES2D_1Q, AXES2D_2Q, AXES2D, AXES3D, AXES3D_8, TABLE }

/**
 * A parametric shape defined by a small set of draggable vertices (in page-local coords).
 * The vertices ARE the editable handles; [polylines] turns them into dense point paths that
 * get built into ink strokes for rendering. Editing a handle just moves a vertex and rebuilds.
 *
 * [dashed] is a render-only trait (the geometry is identical): when true the shape's outline is
 * drawn with a dashed stroke — handy for system boundaries, control volumes, hidden edges, etc.
 * [hashed] puts scale tick marks on the axes shapes. [rows]/[cols]/[border] describe a TABLE.
 *
 * [rot] (degrees) rotates the whole shape about [pivot]. The verts stay in the shape's unrotated
 * frame so a rotated rectangle/ellipse/table keeps its exact geometry; [handles] / [setHandle]
 * convert between that frame and the page.
 */
class ShapeSpec(var type: ShapeType, val verts: ArrayList<PointF>, var dashed: Boolean = false) {

    var hashed = true
    var rows = 3
    var cols = 3
    var border = true
    var rot = 0f
    val pivot = PointF()

    fun clone() = ShapeSpec(type, ArrayList(verts.map { PointF(it.x, it.y) }), dashed).also {
        it.hashed = hashed; it.rows = rows; it.cols = cols; it.border = border
        it.rot = rot; it.pivot.set(pivot.x, pivot.y)
    }

    /** A polyline of the shape. [fine] ones (axis tick marks) render thinner than the outline. */
    class Part(val pts: List<PointF>, val fine: Boolean = false)

    /** The draggable handle points, on the page (rotated with the shape). */
    val handles: List<PointF> get() = if (rot == 0f) verts else verts.map { rotated(it) }

    /** Move handle [i] to page point ([x],[y]). */
    fun setHandle(i: Int, x: Float, y: Float) {
        if (rot == 0f) { verts[i].set(x, y); return }
        val a = Math.toRadians(-rot.toDouble()); val c = cos(a).toFloat(); val s = sin(a).toFloat()
        val dx = x - pivot.x; val dy = y - pivot.y
        verts[i].set(pivot.x + dx * c - dy * s, pivot.y + dx * s + dy * c)
    }

    /** Line, arrow and triangle are pure point shapes — rotating them just rotates their verts. */
    val rotatesByVerts: Boolean get() = type == ShapeType.LINE || type == ShapeType.ARROW || type == ShapeType.TRIANGLE

    /** Rotate the whole shape by [deg] about page point ([cx],[cy]). */
    fun rotateBy(deg: Float, cx: Float, cy: Float) {
        val a = Math.toRadians(deg.toDouble()); val c = cos(a).toFloat(); val s = sin(a).toFloat()
        fun spin(p: PointF) { val dx = p.x - cx; val dy = p.y - cy; p.set(cx + dx * c - dy * s, cy + dx * s + dy * c) }
        if (rotatesByVerts) { verts.forEach { spin(it) }; return }
        if (rot == 0f) {
            var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE; var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
            for (v in verts) { minX = min(minX, v.x); minY = min(minY, v.y); maxX = max(maxX, v.x); maxY = max(maxY, v.y) }
            pivot.set((minX + maxX) / 2f, (minY + maxY) / 2f)
        }
        // R(d,c)·R(rot,p) = R(rot+d,p') with p' = R(d,c)·p, once the verts shift by p'−p.
        val p0x = pivot.x; val p0y = pivot.y
        spin(pivot)
        val ox = pivot.x - p0x; val oy = pivot.y - p0y
        for (v in verts) v.set(v.x + ox, v.y + oy)
        rot = ((rot + deg) % 360f).let { if (abs(it) < 0.01f) 0f else it }
    }

    private fun rotated(p: PointF): PointF {
        val a = Math.toRadians(rot.toDouble()); val c = cos(a).toFloat(); val s = sin(a).toFloat()
        val dx = p.x - pivot.x; val dy = p.y - pivot.y
        return PointF(pivot.x + dx * c - dy * s, pivot.y + dx * s + dy * c)
    }

    /** Every polyline with its weight class, rotated onto the page. */
    fun parts(): List<Part> {
        val raw = rawParts()
        if (rot == 0f) return raw
        return raw.map { part -> Part(part.pts.map { rotated(it) }, part.fine) }
    }

    /** One or more dense polylines (page-local) — each becomes a stroke. */
    fun polylines(): List<List<PointF>> = parts().map { it.pts }

    private fun rawParts(): List<Part> = when (type) {
        ShapeType.LINE -> listOf(Part(interp(verts[0], verts[1], 24)))
        ShapeType.ARROW -> listOf(Part(arrow(verts[0], verts[1])))
        ShapeType.RECT -> {
            val a = verts[0]; val b = verts[1]
            listOf(Part(closed(listOf(PointF(a.x, a.y), PointF(b.x, a.y), PointF(b.x, b.y), PointF(a.x, b.y)))))
        }
        ShapeType.ELLIPSE -> {
            val cx = (verts[0].x + verts[1].x) / 2f; val cy = (verts[0].y + verts[1].y) / 2f
            listOf(Part(ellipse(cx, cy, abs(verts[1].x - verts[0].x) / 2f, abs(verts[1].y - verts[0].y) / 2f)))
        }
        ShapeType.TRIANGLE -> listOf(Part(closed(listOf(verts[0], verts[1], verts[2]))))
        ShapeType.AXES2D -> axes2d(verts[0], verts[1], left = true, down = true, ticks = hashed)
        ShapeType.AXES2D_2Q -> axes2d(verts[0], verts[1], left = false, down = true, ticks = hashed)
        ShapeType.AXES2D_1Q -> axes2d(verts[0], verts[1], left = false, down = false, ticks = hashed)
        ShapeType.AXES3D -> axes3d(verts[0], verts[1], both = false, ticks = hashed)
        ShapeType.AXES3D_8 -> axes3d(verts[0], verts[1], both = true, ticks = hashed)
        ShapeType.TABLE -> table(verts[0], verts[1], rows.coerceAtLeast(1), cols.coerceAtLeast(1), border)
    }

    companion object {
        /** Build a shape of a sensible default size centered at (cx,cy). */
        fun make(type: ShapeType, cx: Float, cy: Float, s: Float): ShapeSpec {
            val v = when (type) {
                ShapeType.LINE, ShapeType.ARROW -> arrayListOf(PointF(cx - s, cy + s * 0.4f), PointF(cx + s, cy - s * 0.4f))
                ShapeType.RECT, ShapeType.ELLIPSE -> arrayListOf(PointF(cx - s, cy - s * 0.72f), PointF(cx + s, cy + s * 0.72f))
                ShapeType.TRIANGLE -> arrayListOf(PointF(cx, cy - s), PointF(cx + s, cy + s), PointF(cx - s, cy + s))
                ShapeType.AXES2D -> arrayListOf(PointF(cx, cy), PointF(cx + s, cy - s))
                ShapeType.AXES2D_2Q -> arrayListOf(PointF(cx - s, cy), PointF(cx + s, cy - s))
                ShapeType.AXES2D_1Q -> arrayListOf(PointF(cx - s, cy + s), PointF(cx + s, cy - s))
                ShapeType.AXES3D -> arrayListOf(PointF(cx, cy + s * 0.55f), PointF(cx + s * 0.75f, cy - s * 0.75f))
                ShapeType.AXES3D_8 -> arrayListOf(PointF(cx, cy), PointF(cx + s * 0.6f, cy - s * 0.6f))
                ShapeType.TABLE -> arrayListOf(PointF(cx - s, cy - s * 0.75f), PointF(cx + s, cy + s * 0.75f))
            }
            return ShapeSpec(type, v)
        }

        private fun interp(a: PointF, b: PointF, n: Int): List<PointF> =
            (0..n).map { val t = it.toFloat() / n; PointF(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) }

        /** Straight segment with points every ~8 page units (so taps, the lasso and the eraser find it). */
        private fun seg(a: PointF, b: PointF): List<PointF> = interp(a, b, (hypot(b.x - a.x, b.y - a.y) / 8f).toInt().coerceIn(2, 200))

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

        // Tick (hash) marks: tiny half-length, drawn as fine lines so they read as scale marks.
        private const val TICK = 2f

        /** Ticks across the axis o→end at 1/5 steps (skipping the arrowhead end). */
        private fun ticksAlong(o: PointF, end: PointF, out: MutableList<Part>) {
            val dx = end.x - o.x; val dy = end.y - o.y
            val len = hypot(dx, dy); if (len < 1f) return
            val nx = -dy / len * TICK; val ny = dx / len * TICK
            for (i in 1..4) {
                val t = i / 5f
                val px = o.x + dx * t; val py = o.y + dy * t
                out.add(Part(listOf(PointF(px - nx, py - ny), PointF(px + nx, py + ny)), fine = true))
            }
        }

        /**
         * Origin c, extent handle e (sets the +x / +y reach). Right and up always; [left] / [down]
         * add the negative half-axes (4-quadrant = both, 2-quadrant = down only, 1-quadrant = neither).
         */
        private fun axes2d(c: PointF, e: PointF, left: Boolean, down: Boolean, ticks: Boolean): List<Part> {
            val lenX = abs(e.x - c.x).coerceAtLeast(30f)
            val lenY = abs(c.y - e.y).coerceAtLeast(30f)
            val ends = ArrayList<PointF>()
            ends.add(PointF(c.x + lenX, c.y)); ends.add(PointF(c.x, c.y - lenY))
            if (left) ends.add(PointF(c.x - lenX, c.y))
            if (down) ends.add(PointF(c.x, c.y + lenY))
            val out = ArrayList<Part>()
            for (end in ends) out.add(Part(arrow(c, end)))
            if (ticks) for (end in ends) ticksAlong(c, end, out)
            return out
        }

        /** Isometric x/y/z axes from origin o; e scales the reach. [both] runs each axis through o. */
        private fun axes3d(o: PointF, e: PointF, both: Boolean, ticks: Boolean): List<Part> {
            val len = hypot(e.x - o.x, e.y - o.y).coerceAtLeast(40f)
            val ends = arrayListOf(
                PointF(o.x + len * 0.87f, o.y + len * 0.5f),   // x
                PointF(o.x - len * 0.87f, o.y + len * 0.5f),   // y
                PointF(o.x, o.y - len),                        // z
            )
            if (both) for (k in 0 until 3) { val p = ends[k]; ends.add(PointF(2 * o.x - p.x, 2 * o.y - p.y)) }
            val out = ArrayList<Part>()
            for (end in ends) out.add(Part(arrow(o, end)))
            if (ticks) for (end in ends) ticksAlong(o, end, out)
            return out
        }

        /** A rows × cols grid inside the box a–b; [border] adds the outer frame. */
        private fun table(a: PointF, b: PointF, rows: Int, cols: Int, border: Boolean): List<Part> {
            val l = min(a.x, b.x); val r = max(a.x, b.x); val t = min(a.y, b.y); val bt = max(a.y, b.y)
            val out = ArrayList<Part>()
            if (border) {
                val tl = PointF(l, t); val tr = PointF(r, t); val br = PointF(r, bt); val bl = PointF(l, bt)
                out.add(Part(seg(tl, tr).dropLast(1) + seg(tr, br).dropLast(1) + seg(br, bl).dropLast(1) + seg(bl, tl)))
            }
            for (i in 1 until cols) { val x = l + (r - l) * i / cols; out.add(Part(seg(PointF(x, t), PointF(x, bt)))) }
            for (j in 1 until rows) { val y = t + (bt - t) * j / rows; out.add(Part(seg(PointF(l, y), PointF(r, y)))) }
            return out
        }
    }
}
