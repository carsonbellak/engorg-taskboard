package com.engorg.inkpad

import android.graphics.PointF
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Turns a closed freehand loop into a clean, editable shape: a rectangle, a circle or ellipse, a
 * triangle, or any other four-cornered outline (a diamond, a parallelogram). It runs on the
 * draw-and-hold gesture in [PageCanvas] (open strokes there still become straight lines).
 *
 * Every candidate is fitted, and the one whose outline sits closest to the ink wins. A loop that
 * fits none of them well (a figure 8, a scribble) returns null and stays as handwriting.
 * Points are page-local; the result's verts are what [ShapeSpec] takes for its type.
 */
object ShapeRecognizer {

    class Match(val type: ShapeType, val verts: ArrayList<PointF>)

    /** Mean distance from the ink to the fitted outline, as a fraction of the loop's diagonal. */
    private const val MAX_ERR = 0.03f

    fun detect(pts: List<PointF>): Match? {
        if (pts.size < 8) return null
        val minX = pts.minOf { it.x }; val maxX = pts.maxOf { it.x }
        val minY = pts.minOf { it.y }; val maxY = pts.maxOf { it.y }
        val w = maxX - minX; val h = maxY - minY
        val diag = hypot(w, h)
        if (diag < 48f) return null   // a written "o" or "0" held a moment too long stays a letter
        // Closed: the pen ends near where it started. Thin loops (a line drawn there and back) aren't shapes.
        if (dist(pts.first(), pts.last()) > 0.28f * diag) return null
        if (min(w, h) < 0.12f * max(w, h)) return null

        val cands = ArrayList<Pair<Match, Float>>()

        // Ellipse in the bounding box; a near-round one becomes a true circle.
        run {
            val cx = (minX + maxX) / 2f; val cy = (minY + maxY) / 2f
            var rx = w / 2f; var ry = h / 2f
            if (abs(rx - ry) < 0.1f * max(rx, ry)) { val r = (rx + ry) / 2f; rx = r; ry = r }
            val m = Match(ShapeType.ELLIPSE, arrayListOf(PointF(cx - rx, cy - ry), PointF(cx + rx, cy + ry)))
            cands.add(m to fitError(pts, ellipse(cx, cy, rx, ry), diag))
        }

        val corners = corners(pts, diag)
        if (corners.size == 3) {
            cands.add(Match(ShapeType.TRIANGLE, ArrayList(corners)) to fitError(pts, closed(corners), diag))
        }
        if (corners.size == 4) {
            if (axisAligned(corners)) {
                // Average the two corners on each side, so a slightly skewed box comes out square.
                val xs = corners.map { it.x }.sorted(); val ys = corners.map { it.y }.sorted()
                val l = (xs[0] + xs[1]) / 2f; val r = (xs[2] + xs[3]) / 2f
                val t = (ys[0] + ys[1]) / 2f; val b = (ys[2] + ys[3]) / 2f
                val box = listOf(PointF(l, t), PointF(r, t), PointF(r, b), PointF(l, b))
                cands.add(Match(ShapeType.RECT, arrayListOf(PointF(l, t), PointF(r, b))) to fitError(pts, closed(box), diag))
            } else {
                cands.add(Match(ShapeType.TRAPEZOID, ArrayList(corners)) to fitError(pts, closed(corners), diag))
            }
        }

        val best = cands.minByOrNull { it.second } ?: return null
        return if (best.second <= MAX_ERR) best.first else null
    }

    // ---- corners ----

    /**
     * The loop's corners: Ramer–Douglas–Peucker on the stroke, the overshoot past the start dropped,
     * and corners that crowd each other (a wobble at one corner) merged into one.
     */
    private fun corners(pts: List<PointF>, diag: Float): List<PointF> {
        var simp = rdp(pts, 0.06f * diag)
        if (simp.size > 1 && dist(simp.first(), simp.last()) < 0.12f * diag) simp = simp.dropLast(1)
        val out = ArrayList<PointF>()
        for (p in simp) {
            val last = out.lastOrNull()
            if (last != null && dist(last, p) < 0.15f * diag) {
                last.set((last.x + p.x) / 2f, (last.y + p.y) / 2f)
            } else out.add(PointF(p.x, p.y))
        }
        if (out.size > 2 && dist(out.first(), out.last()) < 0.15f * diag) {
            val a = out.removeAt(out.size - 1); val f = out[0]
            f.set((f.x + a.x) / 2f, (f.y + a.y) / 2f)
        }
        // RDP can leave a vertex partway along a side; a corner the outline barely turns at isn't one.
        var changed = true
        while (changed && out.size > 3) {
            changed = false
            for (i in out.indices) {
                val a = out[(i + out.size - 1) % out.size]; val b = out[i]; val n = out[(i + 1) % out.size]
                var turn = abs(Math.toDegrees((atan2(n.y - b.y, n.x - b.x) - atan2(b.y - a.y, b.x - a.x)).toDouble()))
                if (turn > 180.0) turn = 360.0 - turn
                if (turn < 30.0) { out.removeAt(i); changed = true; break }
            }
        }
        return out
    }

    /** Every edge within 12° of level or plumb. */
    private fun axisAligned(c: List<PointF>): Boolean {
        for (i in c.indices) {
            val a = c[i]; val b = c[(i + 1) % c.size]
            val deg = Math.toDegrees(atan2(abs(b.y - a.y).toDouble(), abs(b.x - a.x).toDouble()))
            if (deg > 12.0 && deg < 78.0) return false
        }
        return true
    }

    // ---- fit ----

    private fun fitError(pts: List<PointF>, outline: List<PointF>, diag: Float): Float {
        var sum = 0f
        for (p in pts) {
            var best = Float.MAX_VALUE
            for (k in 0 until outline.size - 1) best = min(best, segDist(p, outline[k], outline[k + 1]))
            sum += best
        }
        return sum / pts.size / diag
    }

    private fun closed(c: List<PointF>): List<PointF> = c + c.first()

    private fun ellipse(cx: Float, cy: Float, rx: Float, ry: Float): List<PointF> {
        val n = 48
        return (0..n).map {
            val t = (it.toFloat() / n) * (2f * Math.PI.toFloat())
            PointF(cx + rx * cos(t), cy + ry * sin(t))
        }
    }

    // ---- geometry helpers ----

    private fun dist(a: PointF, b: PointF) = hypot(b.x - a.x, b.y - a.y)

    private fun segDist(p: PointF, a: PointF, b: PointF): Float {
        val dx = b.x - a.x; val dy = b.y - a.y
        val len2 = dx * dx + dy * dy
        if (len2 < 1e-6f) return dist(p, a)
        val t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).coerceIn(0f, 1f)
        val qx = a.x + dx * t; val qy = a.y + dy * t
        return sqrt((p.x - qx) * (p.x - qx) + (p.y - qy) * (p.y - qy))
    }

    private fun perpDist(p: PointF, a: PointF, b: PointF): Float {
        val dx = b.x - a.x; val dy = b.y - a.y
        val len = hypot(dx, dy)
        if (len < 1e-3f) return dist(p, a)
        return abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
    }

    /** Ramer–Douglas–Peucker simplification. */
    private fun rdp(pts: List<PointF>, epsilon: Float): List<PointF> {
        if (pts.size < 3) return pts
        var maxD = 0f; var idx = 0
        for (i in 1 until pts.size - 1) {
            val d = perpDist(pts[i], pts.first(), pts.last())
            if (d > maxD) { maxD = d; idx = i }
        }
        return if (maxD > epsilon) {
            val left = rdp(pts.subList(0, idx + 1), epsilon)
            val right = rdp(pts.subList(idx, pts.size), epsilon)
            left.dropLast(1) + right
        } else {
            listOf(pts.first(), pts.last())
        }
    }
}
