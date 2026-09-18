package com.engorg.inkpad

import android.graphics.PointF
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

/**
 * Cleans a freehand stroke into a geometric shape (line / rectangle / triangle / ellipse)
 * when it clearly resembles one. Returns dense points for the clean shape in the SAME
 * coordinate space as the input, or null to keep the original handwriting.
 */
object ShapeRecognizer {

    fun recognize(pts: List<PointF>): List<PointF>? {
        if (pts.size < 8) return null
        val minX = pts.minOf { it.x }; val maxX = pts.maxOf { it.x }
        val minY = pts.minOf { it.y }; val maxY = pts.maxOf { it.y }
        val w = maxX - minX; val h = maxY - minY
        val diag = hypot(w, h)
        if (diag < 40f) return null

        val start = pts.first(); val end = pts.last()
        val closed = dist(start, end) < 0.28f * diag

        if (!closed) {
            val straightDev = maxPerpDist(pts, start, end) / max(1f, dist(start, end))
            return if (straightDev < 0.09f) line(start, end) else null
        }

        // Closed: simplify to estimate corner count.
        val simp = rdp(pts, 0.06f * diag)
        var corners = simp.size
        if (corners > 1 && dist(simp.first(), simp.last()) < 0.08f * diag) corners -= 1
        return when {
            corners == 4 -> rect(minX, minY, maxX, maxY)
            corners == 3 -> polygon(simp.take(3))
            else -> ellipse((minX + maxX) / 2f, (minY + maxY) / 2f, w / 2f, h / 2f)
        }
    }

    // ---- shape point generators (dense, so the ink renders smoothly) ----

    private fun line(a: PointF, b: PointF): List<PointF> = interp(a, b, 28)

    private fun rect(x0: Float, y0: Float, x1: Float, y1: Float): List<PointF> {
        val c = listOf(PointF(x0, y0), PointF(x1, y0), PointF(x1, y1), PointF(x0, y1))
        return polygon(c)
    }

    private fun polygon(corners: List<PointF>): List<PointF> {
        val out = ArrayList<PointF>()
        for (i in corners.indices) {
            val a = corners[i]; val b = corners[(i + 1) % corners.size]
            out.addAll(interp(a, b, 16).dropLast(1))
        }
        out.add(corners[0])
        return out
    }

    private fun ellipse(cx: Float, cy: Float, rx: Float, ry: Float): List<PointF> {
        val n = 48
        return (0..n).map {
            val t = (it.toFloat() / n) * (2f * Math.PI.toFloat())
            PointF(cx + rx * cos(t), cy + ry * sin(t))
        }
    }

    private fun interp(a: PointF, b: PointF, n: Int): List<PointF> =
        (0..n).map { val t = it.toFloat() / n; PointF(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) }

    // ---- geometry helpers ----

    private fun dist(a: PointF, b: PointF) = hypot(b.x - a.x, b.y - a.y)

    private fun perpDist(p: PointF, a: PointF, b: PointF): Float {
        val dx = b.x - a.x; val dy = b.y - a.y
        val len = hypot(dx, dy)
        if (len < 1e-3f) return dist(p, a)
        return abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
    }

    private fun maxPerpDist(pts: List<PointF>, a: PointF, b: PointF): Float =
        pts.maxOf { perpDist(it, a, b) }

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
