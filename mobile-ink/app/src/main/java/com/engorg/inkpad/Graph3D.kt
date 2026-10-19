package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.os.Build
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

// ============================================================================ geometry

/**
 * World-space geometry for the 3D grapher: triangles (with per-vertex normals for smooth shading)
 * and line segments (wire mesh, curves, region edges), all already clipped to the view cube
 * [-R, R]³. Built off the UI thread by [Graph3Compute]; drawn by [Render3D].
 */
class Mesh3 {
    var tv = FloatArray(9 * 1024); var tn = FloatArray(9 * 1024); var tc = IntArray(1024); var nt = 0
    var sv = FloatArray(6 * 1024); var sc = IntArray(1024); var sw = FloatArray(1024); var sb = FloatArray(1024); var ns = 0
    class Dot(val x: Float, val y: Float, val z: Float, val color: Int)
    val dots = ArrayList<Dot>()

    fun tri(p: FloatArray, n: FloatArray, color: Int) {
        if (nt + 1 > tc.size) { tv = tv.copyOf(tv.size * 2); tn = tn.copyOf(tn.size * 2); tc = tc.copyOf(tc.size * 2) }
        System.arraycopy(p, 0, tv, nt * 9, 9); System.arraycopy(n, 0, tn, nt * 9, 9); tc[nt] = color; nt++
    }

    /** A segment; [width] in "dp" units of the target; [bias] pulls it toward the viewer (normalized). */
    fun seg(x0: Float, y0: Float, z0: Float, x1: Float, y1: Float, z1: Float, color: Int, width: Float, bias: Float) {
        if (ns + 1 > sc.size) { sv = sv.copyOf(sv.size * 2); sc = sc.copyOf(sc.size * 2); sw = sw.copyOf(sw.size * 2); sb = sb.copyOf(sb.size * 2) }
        val o = ns * 6
        sv[o] = x0; sv[o + 1] = y0; sv[o + 2] = z0; sv[o + 3] = x1; sv[o + 4] = y1; sv[o + 5] = z1
        sc[ns] = color; sw[ns] = width; sb[ns] = bias; ns++
    }
}

class Scene3(val range: Double, val mesh: Mesh3)

object Graph3Compute {
    private fun darker(c: Int, k: Float, a: Int) = Color.argb(a, (Color.red(c) * k).toInt(), (Color.green(c) * k).toInt(), (Color.blue(c) * k).toInt())
    private fun withAlpha(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))

    /** Build every item of [model] for the cube [-R, R]³; [res] scales the sampling density. */
    fun compute(model: GraphModel, R: Double, res: Float, stale: () -> Boolean): Scene3? {
        val m = Mesh3()
        val clip = Clipper(R.toFloat())
        for (item in model.items3) {
            if (stale()) return null
            when (item) {
                is Plot3.Explicit -> explicit(item, R, (56 * res).toInt().coerceIn(16, 120), m, clip)
                is Plot3.Surface -> surface(item, (48 * res).toInt().coerceIn(12, 100), m, clip, R)
                is Plot3.Curve -> curve(item, m, clip, R)
                is Plot3.Implicit -> if (implicit(item, R, (30 * res).toInt().coerceIn(12, 56), m, clip, stale) == null) return null
                is Plot3.Point -> if (abs(item.x) <= R && abs(item.y) <= R && abs(item.z) <= R && item.x.isFinite() && item.y.isFinite() && item.z.isFinite())
                    m.dots.add(Mesh3.Dot(item.x.toFloat(), item.y.toFloat(), item.z.toFloat(), item.color))
                is Plot3.Region -> region(item, (24 * res).toInt().coerceIn(8, 48), m, clip, R)
            }
        }
        return if (stale()) null else Scene3(R, m)
    }

    // ---------------------------------------------------------------- clipping to the cube
    /** Sutherland–Hodgman against the six cube faces; vertices carry position + normal (6 floats). */
    class Clipper(val R: Float) {
        private var a = FloatArray(6 * 12); private var b = FloatArray(6 * 12)
        private val p = FloatArray(9); private val n = FloatArray(9)

        fun tri(v0: FloatArray, v1: FloatArray, v2: FloatArray, color: Int, m: Mesh3) {
            for (k in 0 until 6) { a[k] = v0[k]; a[6 + k] = v1[k]; a[12 + k] = v2[k] }
            var cnt = 3
            var inside = true
            for (i in 0 until 3) for (ax in 0 until 3) { val v = a[i * 6 + ax]; if (v > R || v < -R) inside = false }
            if (!inside) {
                for (ax in 0 until 3) for (side in 0 until 2) {
                    cnt = clipPlane(cnt, ax, if (side == 0) R else -R, side == 0)
                    if (cnt < 3) return
                }
            }
            for (k in 1 until cnt - 1) {
                for (q in 0 until 3) { p[q] = a[q]; n[q] = a[3 + q]; p[3 + q] = a[k * 6 + q]; n[3 + q] = a[k * 6 + 3 + q]; p[6 + q] = a[(k + 1) * 6 + q]; n[6 + q] = a[(k + 1) * 6 + 3 + q] }
                m.tri(p, n, color)
            }
        }

        private fun clipPlane(cnt: Int, ax: Int, bound: Float, upper: Boolean): Int {
            if (b.size < (cnt + 2) * 6) b = FloatArray((cnt + 4) * 6)
            var out = 0
            fun inside(i: Int) = if (upper) a[i * 6 + ax] <= bound else a[i * 6 + ax] >= bound
            for (i in 0 until cnt) {
                val j = (i + 1) % cnt
                val ii = inside(i); val ji = inside(j)
                if (ii) { System.arraycopy(a, i * 6, b, out * 6, 6); out++ }
                if (ii != ji) {
                    val t = (bound - a[i * 6 + ax]) / (a[j * 6 + ax] - a[i * 6 + ax])
                    for (k in 0 until 6) b[out * 6 + k] = a[i * 6 + k] + (a[j * 6 + k] - a[i * 6 + k]) * t
                    out++
                }
            }
            val tmp = a; a = b; b = tmp
            if (b.size < a.size) b = FloatArray(a.size)
            return out
        }

        /** Liang–Barsky against the cube; adds the visible part (if any). */
        fun seg(x0: Float, y0: Float, z0: Float, x1: Float, y1: Float, z1: Float, color: Int, w: Float, bias: Float, m: Mesh3) {
            if (!(x0.isFinite() && y0.isFinite() && z0.isFinite() && x1.isFinite() && y1.isFinite() && z1.isFinite())) return
            var t0 = 0f; var t1 = 1f
            val d = floatArrayOf(x1 - x0, y1 - y0, z1 - z0); val o = floatArrayOf(x0, y0, z0)
            for (ax in 0 until 3) {
                for ((p, q) in arrayOf(-d[ax] to o[ax] + R, d[ax] to R - o[ax])) {
                    if (p == 0f) { if (q < 0) return } else {
                        val r = q / p
                        if (p < 0) { if (r > t1) return; if (r > t0) t0 = r } else { if (r < t0) return; if (r < t1) t1 = r }
                    }
                }
            }
            m.seg(x0 + d[0] * t0, y0 + d[1] * t0, z0 + d[2] * t0, x0 + d[0] * t1, y0 + d[1] * t1, z0 + d[2] * t1, color, w, bias)
        }
    }

    // ---------------------------------------------------------------- explicit surfaces
    private fun explicit(item: Plot3.Explicit, R: Double, n: Int, m: Mesh3, clip: Clipper) {
        val fr = item.g.frame()
        val tk = if (item.degrees) 180 / PI else 1.0
        val N = n + 1; val step = 2 * R / n
        val v = DoubleArray(N * N)
        for (j in 0..n) for (i in 0..n) {
            val a = -R + i * step; val b = -R + j * step
            when (item.axis) {
                2 -> { fr[MathEngine.SX] = a; fr[MathEngine.SY] = b; fr[MathEngine.SR] = hypot(a, b); fr[MathEngine.STHETA] = atan2(b, a).let { if (it < 0) it + 2 * PI else it } * tk }
                0 -> { fr[MathEngine.SY] = a; fr[MathEngine.SZ] = b }
                else -> { fr[MathEngine.SX] = a; fr[MathEngine.SZ] = b }
            }
            v[j * N + i] = item.g.f(fr)
        }
        fun pos(i: Int, j: Int, out: FloatArray) {
            val a = (-R + i * step).toFloat(); val b = (-R + j * step).toFloat(); val c = v[j * N + i].toFloat()
            when (item.axis) { 2 -> { out[0] = a; out[1] = b; out[2] = c }; 0 -> { out[0] = c; out[1] = a; out[2] = b }; else -> { out[0] = a; out[1] = c; out[2] = b } }
        }
        fun nrm(i: Int, j: Int, out: FloatArray) {
            val c = v[j * N + i]
            val l = if (i > 0) v[j * N + i - 1] else c; val r = if (i < n) v[j * N + i + 1] else c
            val d = if (j > 0) v[(j - 1) * N + i] else c; val u = if (j < n) v[(j + 1) * N + i] else c
            val da = (if (r.isFinite() && l.isFinite()) (r - l) else 0.0) / (step * ((if (i > 0) 1 else 0) + (if (i < n) 1 else 0)).coerceAtLeast(1))
            val db = (if (u.isFinite() && d.isFinite()) (u - d) else 0.0) / (step * ((if (j > 0) 1 else 0) + (if (j < n) 1 else 0)).coerceAtLeast(1))
            val nx = -da; val ny = -db; val nz = 1.0
            val k = 1 / sqrt(nx * nx + ny * ny + nz * nz)
            val a = (nx * k).toFloat(); val b = (ny * k).toFloat(); val cc = (nz * k).toFloat()
            when (item.axis) { 2 -> { out[3] = a; out[4] = b; out[5] = cc }; 0 -> { out[3] = cc; out[4] = a; out[5] = b }; else -> { out[3] = a; out[4] = cc; out[5] = b } }
        }
        val color = withAlpha(item.color, 0xEC)
        val p00 = FloatArray(6); val p10 = FloatArray(6); val p11 = FloatArray(6); val p01 = FloatArray(6)
        val jumpLim = 3 * R
        for (j in 0 until n) for (i in 0 until n) {
            val a = v[j * N + i]; val b = v[j * N + i + 1]; val c = v[(j + 1) * N + i + 1]; val d = v[(j + 1) * N + i]
            val fa = a.isFinite(); val fb = b.isFinite(); val fc = c.isFinite(); val fd = d.isFinite()
            val fin = listOf(a, b, c, d).filter { it.isFinite() }
            if (fin.size < 3) continue
            if (fin.max() - fin.min() > jumpLim) continue   // an asymptote, not a steep wall
            pos(i, j, p00); nrm(i, j, p00); pos(i + 1, j, p10); nrm(i + 1, j, p10)
            pos(i + 1, j + 1, p11); nrm(i + 1, j + 1, p11); pos(i, j + 1, p01); nrm(i, j + 1, p01)
            if (fa && fb && fc) clip.tri(p00, p10, p11, color, m)
            if (fa && fc && fd) clip.tri(p00, p11, p01, color, m)
            if (!fa && fb && fc && fd) clip.tri(p10, p11, p01, color, m)
            if (!fc && fa && fb && fd) clip.tri(p00, p10, p01, color, m)
        }
        // Wire mesh: ~16 lines each way, sampled at the full resolution so they follow the surface.
        val wire = darker(item.color, 0.55f, 0xA0)
        val every = max(1, n / 16)
        val bias = (1.6f / n).coerceAtLeast(0.012f)
        val q0 = FloatArray(6); val q1 = FloatArray(6)
        for (line in 0..n step every) for (k in 0 until n) {
            // along the second coordinate at fixed first index, then the transpose
            for (dir in 0..1) {
                val i0 = if (dir == 0) line else k; val j0 = if (dir == 0) k else line
                val i1 = if (dir == 0) line else k + 1; val j1 = if (dir == 0) k + 1 else line
                val va = v[j0 * N + i0]; val vb = v[j1 * N + i1]
                if (!va.isFinite() || !vb.isFinite() || abs(va - vb) > jumpLim) continue
                pos(i0, j0, q0); pos(i1, j1, q1)
                clip.seg(q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], wire, 1f, bias, m)
            }
        }
    }

    // ---------------------------------------------------------------- parametric surfaces
    private fun surface(item: Plot3.Surface, n: Int, m: Mesh3, clip: Clipper, R: Double) {
        val fx = item.fx.frame(); val fy = item.fy.frame(); val fz = item.fz.frame()
        val N = n + 1
        val P = FloatArray(N * N * 3)
        for (j in 0..n) for (i in 0..n) {
            val u = item.u0 + (item.u1 - item.u0) * i / n; val w = item.v0 + (item.v1 - item.v0) * j / n
            fx[MathEngine.SU] = u; fx[MathEngine.SV] = w; fy[MathEngine.SU] = u; fy[MathEngine.SV] = w; fz[MathEngine.SU] = u; fz[MathEngine.SV] = w
            val o = (j * N + i) * 3
            P[o] = item.fx.f(fx).toFloat(); P[o + 1] = item.fy.f(fy).toFloat(); P[o + 2] = item.fz.f(fz).toFloat()
        }
        fun fin(i: Int, j: Int): Boolean { val o = (j * N + i) * 3; return P[o].isFinite() && P[o + 1].isFinite() && P[o + 2].isFinite() }
        fun fill(i: Int, j: Int, out: FloatArray) {
            val o = (j * N + i) * 3
            out[0] = P[o]; out[1] = P[o + 1]; out[2] = P[o + 2]
            // normal = ∂P/∂u × ∂P/∂v by finite differences (one-sided on the edges)
            val il = max(0, i - 1); val ir = min(n, i + 1); val jd = max(0, j - 1); val ju = min(n, j + 1)
            val a = (j * N + il) * 3; val b = (j * N + ir) * 3; val c = (jd * N + i) * 3; val d = (ju * N + i) * 3
            val ux = P[b] - P[a]; val uy = P[b + 1] - P[a + 1]; val uz = P[b + 2] - P[a + 2]
            val vx = P[d] - P[c]; val vy = P[d + 1] - P[c + 1]; val vz = P[d + 2] - P[c + 2]
            var nx = uy * vz - uz * vy; var ny = uz * vx - ux * vz; var nz = ux * vy - uy * vx
            val l = sqrt(nx * nx + ny * ny + nz * nz)
            if (l > 0 && l.isFinite()) { nx /= l; ny /= l; nz /= l } else { nx = 0f; ny = 0f; nz = 1f }
            out[3] = nx; out[4] = ny; out[5] = nz
        }
        val color = withAlpha(item.color, 0xEC)
        val a = FloatArray(6); val b = FloatArray(6); val c = FloatArray(6); val d = FloatArray(6)
        val jump = (4 * R).toFloat()
        for (j in 0 until n) for (i in 0 until n) {
            if (!fin(i, j) || !fin(i + 1, j) || !fin(i + 1, j + 1) || !fin(i, j + 1)) continue
            fill(i, j, a); fill(i + 1, j, b); fill(i + 1, j + 1, c); fill(i, j + 1, d)
            if (abs(a[0] - c[0]) + abs(a[1] - c[1]) + abs(a[2] - c[2]) > jump) continue
            clip.tri(a, b, c, color, m); clip.tri(a, c, d, color, m)
        }
        val wire = darker(item.color, 0.55f, 0xA0)
        val every = max(1, n / 16)
        val bias = (1.6f / n).coerceAtLeast(0.012f)
        for (line in 0..n step every) for (k in 0 until n) for (dir in 0..1) {
            val i0 = if (dir == 0) line else k; val j0 = if (dir == 0) k else line
            val i1 = if (dir == 0) line else k + 1; val j1 = if (dir == 0) k + 1 else line
            if (!fin(i0, j0) || !fin(i1, j1)) continue
            val o0 = (j0 * N + i0) * 3; val o1 = (j1 * N + i1) * 3
            clip.seg(P[o0], P[o0 + 1], P[o0 + 2], P[o1], P[o1 + 1], P[o1 + 2], wire, 1f, bias, m)
        }
    }

    // ---------------------------------------------------------------- space curves
    private fun curve(item: Plot3.Curve, m: Mesh3, clip: Clipper, R: Double) {
        val fx = item.fx.frame(); val fy = item.fy.frame(); val fz = item.fz.frame()
        val n = 1600
        var px = Float.NaN; var py = 0f; var pz = 0f
        val jump = (R * 0.8).toFloat()
        for (k in 0..n) {
            val t = item.t0 + (item.t1 - item.t0) * k / n
            fx[MathEngine.ST] = t; fy[MathEngine.ST] = t; fz[MathEngine.ST] = t
            val x = item.fx.f(fx).toFloat(); val y = item.fy.f(fy).toFloat(); val z = item.fz.f(fz).toFloat()
            if (!x.isFinite() || !y.isFinite() || !z.isFinite()) { px = Float.NaN; continue }
            if (px.isFinite() && abs(x - px) + abs(y - py) + abs(z - pz) < jump) clip.seg(px, py, pz, x, y, z, item.color, 2.6f, 0.01f, m)
            px = x; py = y; pz = z
        }
    }

    // ---------------------------------------------------------------- implicit surfaces (marching tetrahedra)
    private val TETS = arrayOf(intArrayOf(0, 5, 1, 6), intArrayOf(0, 1, 2, 6), intArrayOf(0, 2, 3, 6), intArrayOf(0, 3, 7, 6), intArrayOf(0, 7, 4, 6), intArrayOf(0, 4, 5, 6))
    private val CORNER = arrayOf(intArrayOf(0, 0, 0), intArrayOf(1, 0, 0), intArrayOf(1, 1, 0), intArrayOf(0, 1, 0), intArrayOf(0, 0, 1), intArrayOf(1, 0, 1), intArrayOf(1, 1, 1), intArrayOf(0, 1, 1))

    private fun implicit(item: Plot3.Implicit, R: Double, g: Int, m: Mesh3, clip: Clipper, stale: () -> Boolean): Unit? {
        val fr = item.f.frame()
        val tk = if (item.degrees) 180 / PI else 1.0
        val N = g + 1; val step = 2 * R / g
        val F = FloatArray(N * N * N)
        fun idx(i: Int, j: Int, k: Int) = (k * N + j) * N + i
        for (k in 0..g) {
            if (stale()) return null
            val z = -R + k * step
            for (j in 0..g) {
                val y = -R + j * step
                for (i in 0..g) {
                    val x = -R + i * step
                    fr[MathEngine.SX] = x; fr[MathEngine.SY] = y; fr[MathEngine.SZ] = z
                    fr[MathEngine.SR] = hypot(x, y); fr[MathEngine.STHETA] = atan2(y, x).let { if (it < 0) it + 2 * PI else it } * tk
                    F[idx(i, j, k)] = item.f.f(fr).toFloat()
                }
            }
        }
        fun grad(i: Int, j: Int, k: Int, out: FloatArray, o: Int) {
            fun at(a: Int, b: Int, c: Int) = F[idx(a.coerceIn(0, g), b.coerceIn(0, g), c.coerceIn(0, g))]
            var gx = at(i + 1, j, k) - at(i - 1, j, k); var gy = at(i, j + 1, k) - at(i, j - 1, k); var gz = at(i, j, k + 1) - at(i, j, k - 1)
            val l = sqrt(gx * gx + gy * gy + gz * gz)
            if (l > 0 && l.isFinite()) { gx /= l; gy /= l; gz /= l } else { gx = 0f; gy = 0f; gz = 1f }
            out[o] = gx; out[o + 1] = gy; out[o + 2] = gz
        }
        val color = withAlpha(item.color, 0xEC)
        val cv = FloatArray(8); val cp = Array(8) { FloatArray(6) }
        val e0 = FloatArray(6); val e1 = FloatArray(6); val e2 = FloatArray(6); val e3 = FloatArray(6)
        fun lerp(a: Int, b: Int, out: FloatArray) {
            val fa = cv[a]; val fb = cv[b]
            val t = if (fa == fb) 0.5f else (fa / (fa - fb)).coerceIn(0f, 1f)
            for (q in 0 until 6) out[q] = cp[a][q] + (cp[b][q] - cp[a][q]) * t
            val l = sqrt(out[3] * out[3] + out[4] * out[4] + out[5] * out[5]); if (l > 0) { out[3] /= l; out[4] /= l; out[5] /= l }
        }
        for (k in 0 until g) {
            if (stale()) return null
            for (j in 0 until g) for (i in 0 until g) {
                var anyNeg = false; var anyPos = false; var bad = false
                for (c in 0 until 8) {
                    val ci = i + CORNER[c][0]; val cj = j + CORNER[c][1]; val ck = k + CORNER[c][2]
                    val f = F[idx(ci, cj, ck)]
                    if (!f.isFinite()) { bad = true; break }
                    cv[c] = f; if (f < 0) anyNeg = true else anyPos = true
                }
                if (bad || !anyNeg || !anyPos) continue
                for (c in 0 until 8) {
                    val ci = i + CORNER[c][0]; val cj = j + CORNER[c][1]; val ck = k + CORNER[c][2]
                    cp[c][0] = (-R + ci * step).toFloat(); cp[c][1] = (-R + cj * step).toFloat(); cp[c][2] = (-R + ck * step).toFloat()
                    grad(ci, cj, ck, cp[c], 3)
                }
                for (t in TETS) {
                    val ins = t.filter { cv[it] < 0 }; val outs = t.filter { cv[it] >= 0 }
                    when (ins.size) {
                        1, 3 -> {
                            val lone = if (ins.size == 1) ins[0] else outs[0]
                            val others = if (ins.size == 1) outs else ins
                            lerp(lone, others[0], e0); lerp(lone, others[1], e1); lerp(lone, others[2], e2)
                            clip.tri(e0, e1, e2, color, m)
                        }
                        2 -> {
                            lerp(ins[0], outs[0], e0); lerp(ins[0], outs[1], e1); lerp(ins[1], outs[1], e2); lerp(ins[1], outs[0], e3)
                            clip.tri(e0, e1, e2, color, m); clip.tri(e0, e2, e3, color, m)
                        }
                    }
                }
            }
        }
        return Unit
    }

    // ---------------------------------------------------------------- integral regions
    private fun region(item: Plot3.Region, n: Int, m: Mesh3, clip: Clipper, R: Double) {
        val idx = item.vars.map { when (it) { "x" -> 0; "y" -> 1; else -> 2 } }
        val slot = idx.map { when (it) { 0 -> MathEngine.SX; 1 -> MathEngine.SY; else -> MathEngine.SZ } }
        val fmLo = item.mLo.frame(); val fmHi = item.mHi.frame(); val fiLo = item.iLo.frame(); val fiHi = item.iHi.frame()
        // Point on the region for outer o ∈ [0,1], middle s ∈ [0,1], inner w ∈ [0,1].
        fun at(o01: Double, s: Double, w: Double, out: FloatArray): Boolean {
            val o = item.oLo + (item.oHi - item.oLo) * o01
            fmLo[slot[0]] = o; fmHi[slot[0]] = o
            val mlo = item.mLo.f(fmLo); val mhi = item.mHi.f(fmHi)
            val mv = mlo + (mhi - mlo) * s
            fiLo[slot[0]] = o; fiHi[slot[0]] = o; fiLo[slot[1]] = mv; fiHi[slot[1]] = mv
            val ilo = item.iLo.f(fiLo); val ihi = item.iHi.f(fiHi)
            val iv = ilo + (ihi - ilo) * w
            if (!mv.isFinite() || !iv.isFinite()) return false
            out[idx[0]] = o.toFloat(); out[idx[1]] = mv.toFloat(); out[idx[2]] = iv.toFloat()
            return true
        }
        val fill = withAlpha(item.color, 0x66)
        val edge = darker(item.color, 0.7f, 0xE0)
        val a = FloatArray(6); val b = FloatArray(6); val c = FloatArray(6); val d = FloatArray(6)
        // Each face: a grid over two of (o, s, w) with the third fixed; flat normals from the quad.
        fun face(fix: Int, value: Double) {
            fun pt(p: Double, q: Double, out: FloatArray) = when (fix) {
                0 -> at(value, p, q, out); 1 -> at(p, value, q, out); else -> at(p, q, value, out)
            }
            for (j in 0 until n) for (i in 0 until n) {
                val p0 = i.toDouble() / n; val p1 = (i + 1.0) / n; val q0 = j.toDouble() / n; val q1 = (j + 1.0) / n
                if (!pt(p0, q0, a) || !pt(p1, q0, b) || !pt(p1, q1, c) || !pt(p0, q1, d)) continue
                val ux = c[0] - a[0]; val uy = c[1] - a[1]; val uz = c[2] - a[2]
                val vx = d[0] - b[0]; val vy = d[1] - b[1]; val vz = d[2] - b[2]
                var nx = uy * vz - uz * vy; var ny = uz * vx - ux * vz; var nz = ux * vy - uy * vx
                val l = sqrt(nx * nx + ny * ny + nz * nz)
                if (l > 0) { nx /= l; ny /= l; nz /= l } else nz = 1f
                for (v in arrayOf(a, b, c, d)) { v[3] = nx; v[4] = ny; v[5] = nz }
                clip.tri(a, b, c, fill, m); clip.tri(a, c, d, fill, m)
            }
        }
        face(2, 0.0); face(2, 1.0); face(0, 0.0); face(0, 1.0); face(1, 0.0); face(1, 1.0)
        // The twelve edges of the (curved) box.
        val p = FloatArray(6); val q = FloatArray(6)
        for (e in 0 until 12) {
            val axis = e / 4; val f1 = (e and 1).toDouble(); val f2 = ((e shr 1) and 1).toDouble()
            for (k in 0 until n) {
                val t0 = k.toDouble() / n; val t1 = (k + 1.0) / n
                val ok = when (axis) {
                    0 -> at(t0, f1, f2, p) && at(t1, f1, f2, q)
                    1 -> at(f1, t0, f2, p) && at(f1, t1, f2, q)
                    else -> at(f1, f2, t0, p) && at(f1, f2, t1, q)
                }
                if (ok) clip.seg(p[0], p[1], p[2], q[0], q[1], q[2], edge, 1.6f, 0.02f, m)
            }
        }
    }
}

// ============================================================================ rendering

/**
 * Projects a [Scene3] (orthographic, orbit camera: [yaw] about z, then [pitch] above the horizon)
 * and paints it back-to-front: triangles and line quads go into one depth-sorted vertex batch drawn
 * with a single drawVertices, then points and labels on top. Reused by the grapher's 3D view and by
 * graph cards on the page.
 */
class Render3D {
    class Style(val bg: Int, val ink: Int, val unit: Float, val labels: Boolean = true)

    private var pv = FloatArray(6 * 4096); private var pc = IntArray(3 * 4096); private var keys = LongArray(4096); private var np = 0
    private var outV = FloatArray(6 * 4096); private var outC = IntArray(3 * 4096)
    private val vPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)

    // camera state for one frame
    private var cyw = 1.0; private var syw = 0.0; private var cpt = 1.0; private var spt = 0.0
    private var scale = 1.0; private var ox = 0f; private var oy = 0f; private var invR = 1.0

    // Light from the upper left, a little in front (view space: x right, y up, z = depth away).
    private val LX = -0.38; private val LY = 0.62; private val LZ = -0.69

    fun setup(yaw: Double, pitch: Double, R: Double, rect: RectF) {
        cyw = cos(Math.toRadians(yaw)); syw = sin(Math.toRadians(yaw))
        cpt = cos(Math.toRadians(pitch)); spt = sin(Math.toRadians(pitch))
        scale = min(rect.width(), rect.height()) / 2.0 / 1.8 / R
        ox = rect.centerX(); oy = rect.centerY(); invR = 1 / R
    }

    // world → screen x, screen y, normalized depth (bigger = farther)
    private val tmp = FloatArray(3)
    fun project(x: Float, y: Float, z: Float, out: FloatArray = tmp): FloatArray {
        val x1 = x * cyw - y * syw; val y1 = x * syw + y * cyw
        out[0] = (ox + x1 * scale).toFloat()
        out[1] = (oy - (y1 * spt + z * cpt) * scale).toFloat()
        out[2] = ((y1 * cpt - z * spt) * invR).toFloat()
        return out
    }

    private fun shadeColor(base: Int, nx: Float, ny: Float, nz: Float): Int {
        val n1x = nx * cyw - ny * syw; val n1y = nx * syw + ny * cyw
        val vx = n1x; val vy = n1y * spt + nz * cpt; val vz = n1y * cpt - nz * spt
        val d = abs(vx * LX + vy * LY + vz * LZ)
        val k = 0.36 + 0.64 * d
        return Color.argb(Color.alpha(base), (Color.red(base) * k).toInt().coerceIn(0, 255), (Color.green(base) * k).toInt().coerceIn(0, 255), (Color.blue(base) * k).toInt().coerceIn(0, 255))
    }

    private fun ensure(n: Int) {
        if (n <= keys.size) return
        var cap = keys.size; while (cap < n) cap *= 2
        pv = pv.copyOf(cap * 6); pc = pc.copyOf(cap * 3); keys = keys.copyOf(cap)
    }

    private fun push(x0: Float, y0: Float, x1: Float, y1: Float, x2: Float, y2: Float, c0: Int, c1: Int, c2: Int, depth: Float) {
        ensure(np + 1)
        val o = np * 6
        pv[o] = x0; pv[o + 1] = y0; pv[o + 2] = x1; pv[o + 3] = y1; pv[o + 4] = x2; pv[o + 5] = y2
        pc[np * 3] = c0; pc[np * 3 + 1] = c1; pc[np * 3 + 2] = c2
        val key = ((depth + 8f) * 100000f).toInt().coerceIn(0, Int.MAX_VALUE)
        keys[np] = (key.toLong() shl 32) or np.toLong()
        np++
    }

    private val a = FloatArray(3); private val b = FloatArray(3); private val c3 = FloatArray(3)

    /** A screen-space quad of width [w] px for the segment, sorted at its midpoint depth − [bias]. */
    private fun lineQuad(x0: Float, y0: Float, z0: Float, x1: Float, y1: Float, z1: Float, color: Int, w: Float, bias: Float) {
        project(x0, y0, z0, a); project(x1, y1, z1, b)
        val dx = b[0] - a[0]; val dy = b[1] - a[1]
        val len = hypot(dx, dy)
        if (len < 0.01f) return
        val nx = -dy / len * w / 2; val ny = dx / len * w / 2
        val depth = (a[2] + b[2]) / 2 - bias
        push(a[0] + nx, a[1] + ny, b[0] + nx, b[1] + ny, b[0] - nx, b[1] - ny, color, color, color, depth)
        push(a[0] + nx, a[1] + ny, b[0] - nx, b[1] - ny, a[0] - nx, a[1] - ny, color, color, color, depth)
    }

    private fun niceStep(raw: Double): Double {
        val e = floor(log10(raw)); val b0 = 10.0.pow(e); val f = raw / b0
        return b0 * when { f < 1.5 -> 1.0; f < 3.5 -> 2.0; f < 7.5 -> 5.0; else -> 10.0 }
    }

    private fun tick(v: Double, step: Double): String {
        if (abs(step) >= 1e5 || abs(step) < 1e-4) return MathEngine.fmt(v, 3)
        val d = max(0, ceil(-log10(abs(step)) - 1e-9).toInt())
        return ("%.${d}f".format(v)).replace("-", "−")
    }

    private fun alpha(c: Int, al: Int) = Color.argb(al, Color.red(c), Color.green(c), Color.blue(c))

    fun draw(c: Canvas, scene: Scene3?, yaw: Double, pitch: Double, R: Double, rect: RectF, st: Style) {
        setup(yaw, pitch, R, rect)
        np = 0
        val u = st.unit
        val Rf = R.toFloat()
        // Cube edges, the xy-plane grid and the axes (split so they sort against the surfaces).
        val boxC = alpha(st.ink, 0x30); val gridC = alpha(st.ink, 0x1C); val axisC = alpha(st.ink, 0xB0)
        val corners = arrayOf(floatArrayOf(-Rf, -Rf), floatArrayOf(Rf, -Rf), floatArrayOf(Rf, Rf), floatArrayOf(-Rf, Rf))
        fun splitSeg(x0: Float, y0: Float, z0: Float, x1: Float, y1: Float, z1: Float, color: Int, w: Float, bias: Float, parts: Int) {
            for (k in 0 until parts) {
                val t0 = k.toFloat() / parts; val t1 = (k + 1f) / parts
                lineQuad(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, z0 + (z1 - z0) * t0, x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1, z0 + (z1 - z0) * t1, color, w, bias)
            }
        }
        for (k in 0 until 4) {
            val p = corners[k]; val q = corners[(k + 1) % 4]
            splitSeg(p[0], p[1], -Rf, q[0], q[1], -Rf, boxC, u, 0f, 8); splitSeg(p[0], p[1], Rf, q[0], q[1], Rf, boxC, u, 0f, 8)
            splitSeg(p[0], p[1], -Rf, p[0], p[1], Rf, boxC, u, 0f, 8)
        }
        val step = niceStep(R / 2.5)
        val kMax = floor(R / step).toInt()
        for (k in -kMax..kMax) {
            val v = (k * step).toFloat()
            if (k == 0) continue
            splitSeg(v, -Rf, 0f, v, Rf, 0f, gridC, u * 0.8f, 0.002f, 12); splitSeg(-Rf, v, 0f, Rf, v, 0f, gridC, u * 0.8f, 0.002f, 12)
        }
        splitSeg(-Rf, 0f, 0f, Rf, 0f, 0f, axisC, u * 1.5f, 0.004f, 24)
        splitSeg(0f, -Rf, 0f, 0f, Rf, 0f, axisC, u * 1.5f, 0.004f, 24)
        splitSeg(0f, 0f, -Rf, 0f, 0f, Rf, axisC, u * 1.5f, 0.004f, 24)

        val m = scene?.mesh
        if (m != null) {
            val p0 = FloatArray(3); val p1 = FloatArray(3); val p2 = FloatArray(3)
            for (t in 0 until m.nt) {
                val o = t * 9
                project(m.tv[o], m.tv[o + 1], m.tv[o + 2], p0); project(m.tv[o + 3], m.tv[o + 4], m.tv[o + 5], p1); project(m.tv[o + 6], m.tv[o + 7], m.tv[o + 8], p2)
                val base = m.tc[t]
                push(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1],
                    shadeColor(base, m.tn[o], m.tn[o + 1], m.tn[o + 2]), shadeColor(base, m.tn[o + 3], m.tn[o + 4], m.tn[o + 5]), shadeColor(base, m.tn[o + 6], m.tn[o + 7], m.tn[o + 8]),
                    (p0[2] + p1[2] + p2[2]) / 3)
            }
            for (s in 0 until m.ns) {
                val o = s * 6
                lineQuad(m.sv[o], m.sv[o + 1], m.sv[o + 2], m.sv[o + 3], m.sv[o + 4], m.sv[o + 5], m.sc[s], m.sw[s] * u, m.sb[s])
            }
        }

        // Back to front.
        java.util.Arrays.sort(keys, 0, np)
        if (outV.size < np * 6) { outV = FloatArray(np * 6 + 600); outC = IntArray(np * 3 + 300) }
        var w = 0
        for (k in np - 1 downTo 0) {
            val i = (keys[k] and 0xFFFFFFFFL).toInt()
            System.arraycopy(pv, i * 6, outV, w * 6, 6); System.arraycopy(pc, i * 3, outC, w * 3, 3); w++
        }
        c.save()
        c.clipRect(rect)
        if (Build.VERSION.SDK_INT >= 29 || !c.isHardwareAccelerated) {
            c.drawVertices(Canvas.VertexMode.TRIANGLES, w * 6, outV, 0, null, 0, outC, 0, null, 0, 0, vPaint)
        } else {
            // Hardware canvases before Android 10 can't draw vertices: fall back to one path per triangle.
            vPaint.style = Paint.Style.FILL
            for (k in 0 until w) {
                val o = k * 6
                path.reset(); path.moveTo(outV[o], outV[o + 1]); path.lineTo(outV[o + 2], outV[o + 3]); path.lineTo(outV[o + 4], outV[o + 5]); path.close()
                vPaint.color = outC[k * 3]; c.drawPath(path, vPaint)
            }
        }

        // Points, then labels on top.
        if (m != null) for (d in m.dots) {
            project(d.x, d.y, d.z, a)
            dot.style = Paint.Style.FILL; dot.color = d.color
            c.drawCircle(a[0], a[1], 4.5f * u, dot)
            dot.style = Paint.Style.STROKE; dot.strokeWidth = 1.5f * u; dot.color = st.bg
            c.drawCircle(a[0], a[1], 4.5f * u, dot)
        }
        if (st.labels) {
            text.textSize = 11f * u; halo.textSize = 11f * u; halo.strokeWidth = 3f * u; halo.color = st.bg
            text.color = alpha(st.ink, 0xC8); text.textAlign = Paint.Align.CENTER; halo.textAlign = Paint.Align.CENTER
            fun label(s: String, x: Float, y: Float, z: Float, dy: Float = 0f) {
                project(x, y, z, a)
                c.drawText(s, a[0], a[1] + dy, halo); c.drawText(s, a[0], a[1] + dy, text)
            }
            for (k in -kMax..kMax) {
                if (k == 0) continue
                val v = (k * step).toFloat(); val s = tick(k * step, step)
                label(s, v, 0f, 0f, 14f * u); label(s, 0f, v, 0f, 14f * u); label(s, 0f, 0f, v, 4f * u)
            }
            text.textSize = 14f * u; halo.textSize = 14f * u; text.color = alpha(st.ink, 0xE8)
            text.typeface = android.graphics.Typeface.create(android.graphics.Typeface.SERIF, android.graphics.Typeface.ITALIC)
            halo.typeface = text.typeface
            label("x", Rf * 1.08f, 0f, 0f, 5f * u); label("y", 0f, Rf * 1.08f, 0f, 5f * u); label("z", 0f, 0f, Rf * 1.08f, 5f * u)
            text.typeface = null; halo.typeface = null
        }
        c.restore()
    }

    // ---------------------------------------------------------------- ink export (hidden lines removed)
    /**
     * The view as ink strokes in a [W]×[H] box (y down): wire mesh, curves, region edges and axes,
     * with the parts hidden behind surfaces removed by a coarse depth buffer. Points become dots.
     */
    fun exportInk(scene: Scene3?, yaw: Double, pitch: Double, R: Double, W: Float, H: Float): List<GraphInk> {
        val out = ArrayList<GraphInk>()
        out.add(GraphInk(listOf(PointF(0f, 0f), PointF(W, H)), Color.rgb(0xA0, 0xA6, 0xB0), 1f, GraphInk.RECT))
        val rect = RectF(0f, 0f, W, H)
        setup(yaw, pitch, R, rect)
        val zs = 2f   // depth buffer resolution: 2 cells per page unit
        val zw = (W * zs).toInt().coerceAtLeast(2); val zh = (H * zs).toInt().coerceAtLeast(2)
        val zb = FloatArray(zw * zh) { Float.MAX_VALUE }
        val m = scene?.mesh
        if (m != null) {
            val p0 = FloatArray(3); val p1 = FloatArray(3); val p2 = FloatArray(3)
            for (t in 0 until m.nt) {
                val o = t * 9
                project(m.tv[o], m.tv[o + 1], m.tv[o + 2], p0); project(m.tv[o + 3], m.tv[o + 4], m.tv[o + 5], p1); project(m.tv[o + 6], m.tv[o + 7], m.tv[o + 8], p2)
                if (Color.alpha(m.tc[t]) < 0x90) continue   // translucent regions don't hide lines
                raster(zb, zw, zh, zs, p0, p1, p2)
            }
        }
        val eps = 0.02f
        fun visible(x: Float, y: Float, d: Float): Boolean {
            val i = (x * zs).toInt(); val j = (y * zs).toInt()
            if (i < 0 || j < 0 || i >= zw || j >= zh) return false
            var best = Float.MAX_VALUE
            for (dj in -1..1) for (di in -1..1) { val ii = i + di; val jj = j + dj; if (ii in 0 until zw && jj in 0 until zh) best = min(best, zb[jj * zw + ii]) }
            return d <= best + eps
        }
        var cur: ArrayList<PointF>? = null; var curColor = 0; var curW = 0f
        fun flush() { val cc = cur; if (cc != null && cc.size >= 2) out.add(GraphInk(cc, curColor, curW, GraphInk.FREE)); cur = null }
        fun addSeg(x0: Float, y0: Float, z0: Float, x1: Float, y1: Float, z1: Float, color: Int, w: Float) {
            project(x0, y0, z0, a); project(x1, y1, z1, b)
            val len = hypot(b[0] - a[0], b[1] - a[1])
            val pieces = (len / 1.5f).toInt().coerceIn(1, 400)
            for (k in 0 until pieces) {
                val t0 = k.toFloat() / pieces; val t1 = (k + 1f) / pieces
                val sx0 = a[0] + (b[0] - a[0]) * t0; val sy0 = a[1] + (b[1] - a[1]) * t0
                val sx1 = a[0] + (b[0] - a[0]) * t1; val sy1 = a[1] + (b[1] - a[1]) * t1
                val dm = a[2] + (b[2] - a[2]) * (t0 + t1) / 2
                if (visible((sx0 + sx1) / 2, (sy0 + sy1) / 2, dm)) {
                    val cc = cur
                    if (cc != null && curColor == color && hypot(cc.last().x - sx0, cc.last().y - sy0) < 0.05f) cc.add(PointF(sx1, sy1))
                    else { flush(); cur = arrayListOf(PointF(sx0, sy0), PointF(sx1, sy1)); curColor = color; curW = w }
                } else flush()
            }
        }
        val Rf = R.toFloat()
        val axis = GraphInk.AXIS
        addSeg(-Rf, 0f, 0f, Rf, 0f, 0f, axis, 1.2f); flush()
        addSeg(0f, -Rf, 0f, 0f, Rf, 0f, axis, 1.2f); flush()
        addSeg(0f, 0f, -Rf, 0f, 0f, Rf, axis, 1.2f); flush()
        if (m != null) {
            for (s in 0 until m.ns) {
                val o = s * 6
                val col = Color.rgb(Color.red(m.sc[s]), Color.green(m.sc[s]), Color.blue(m.sc[s]))
                addSeg(m.sv[o], m.sv[o + 1], m.sv[o + 2], m.sv[o + 3], m.sv[o + 4], m.sv[o + 5], col, if (m.sw[s] > 2f) 2.2f else 1f)
            }
            flush()
            for (d in m.dots) {
                project(d.x, d.y, d.z, a)
                if (a[0] in 0f..W && a[1] in 0f..H) out.add(GraphInk(listOf(PointF(a[0] - 2.4f, a[1] - 2.4f), PointF(a[0] + 2.4f, a[1] + 2.4f)), d.color, 2.6f, GraphInk.DOT))
            }
        }
        // Axis letters at the positive ends.
        for ((name, p) in listOf("x" to floatArrayOf(Rf * 1.1f, 0f, 0f), "y" to floatArrayOf(0f, Rf * 1.1f, 0f), "z" to floatArrayOf(0f, 0f, Rf * 1.1f))) {
            project(p[0], p[1], p[2], a)
            if (a[0] in 4f..W - 4f && a[1] in 8f..H - 4f) StrokeFont.layout(name, a[0], a[1] - 4f, 8.5f, StrokeFont.CENTER).forEach { out.add(GraphInk(it, axis, 0.9f, GraphInk.FREE)) }
        }
        return out
    }

    private fun raster(zb: FloatArray, zw: Int, zh: Int, zs: Float, p0: FloatArray, p1: FloatArray, p2: FloatArray) {
        val x0 = p0[0] * zs; val y0 = p0[1] * zs; val x1 = p1[0] * zs; val y1 = p1[1] * zs; val x2 = p2[0] * zs; val y2 = p2[1] * zs
        val minX = max(0, floor(min(x0, min(x1, x2))).toInt()); val maxX = min(zw - 1, ceil(max(x0, max(x1, x2))).toInt())
        val minY = max(0, floor(min(y0, min(y1, y2))).toInt()); val maxY = min(zh - 1, ceil(max(y0, max(y1, y2))).toInt())
        val area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if (abs(area) < 1e-6f) return
        for (j in minY..maxY) {
            val py = j + 0.5f
            for (i in minX..maxX) {
                val px = i + 0.5f
                val w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area
                val w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area
                val w2 = 1 - w0 - w1
                if (w0 < -0.01f || w1 < -0.01f || w2 < -0.01f) continue
                val d = w0 * p0[2] + w1 * p1[2] + w2 * p2[2]
                val k = j * zw + i
                if (d < zb[k]) zb[k] = d
            }
        }
    }
}

// ============================================================================ the 3D view

/**
 * The 3D plot surface in the grapher: drag to orbit, pinch to zoom (changes the cube's range and
 * re-samples), double-tap to reset. Geometry is computed off the UI thread; orbiting only
 * re-projects, so it stays smooth.
 */
@SuppressLint("ViewConstructor")
class Graph3DView(context: Context) : View(context) {
    private val dens = resources.displayMetrics.density
    var yaw = DEFAULT_YAW; var pitch = DEFAULT_PITCH; var range = DEFAULT_RANGE
    var model: GraphModel? = null; private set
    var scene: Scene3? = null; private set
    var onViewChanged: (() -> Unit)? = null
    private val renderer = Render3D()
    private val exec = Executors.newSingleThreadExecutor()
    @Volatile private var gen = 0
    private var running = false; private var pending = false
    private val rect = RectF()

    init { if (Build.VERSION.SDK_INT < 29) setLayerType(LAYER_TYPE_SOFTWARE, null) }

    fun setModel(m: GraphModel) { model = m; requestCompute() }
    fun dispose() { exec.shutdownNow() }

    fun home() { yaw = DEFAULT_YAW; pitch = DEFAULT_PITCH; val changed = range != DEFAULT_RANGE; range = DEFAULT_RANGE; if (changed) requestCompute(); invalidate(); onViewChanged?.invoke() }

    fun setView(y: Double, p: Double, r: Double) { yaw = y; pitch = p.coerceIn(-89.0, 89.0); range = r.coerceIn(1e-3, 1e5); requestCompute(); invalidate() }

    private fun requestCompute() {
        if (model == null) return
        gen++; pending = true
        if (!running) launch()
    }

    private fun launch() {
        val m = model ?: return
        pending = false; running = true
        val my = gen; val r = range
        try {
            exec.execute {
                val s = try { Graph3Compute.compute(m, r, 1f) { gen != my } } catch (t: Throwable) { null }
                post { running = false; if (s != null) { scene = s; invalidate() }; if (pending) launch() }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) { running = false }
    }

    override fun onDraw(c: Canvas) {
        c.drawColor(AppTheme.surface)
        rect.set(0f, 0f, width.toFloat(), height.toFloat())
        // While a zoom re-samples, the previous geometry is drawn at the new scale (it fills in a moment later).
        renderer.draw(c, scene, yaw, pitch, range, rect, Render3D.Style(AppTheme.surface, AppTheme.text, dens))
    }

    /** Ink strokes of the current view in a box at most [maxW]×[maxH] page units. */
    fun exportInk(maxW: Float = 420f, maxH: Float = 420f): Triple<List<GraphInk>, Float, Float>? {
        if (width == 0 || height == 0) return null
        var W = maxW; var H = W * height / width
        if (H > maxH) { H = maxH; W = H * width / height }
        return Triple(renderer.exportInk(scene, yaw, pitch, range, W, H), W, H)
    }

    // ---------------------------------------------------------------- touch
    private var lastX = 0f; private var lastY = 0f
    private var lastTap = 0L
    private var pinching = false
    private val scaleDet = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(d: ScaleGestureDetector): Boolean { pinching = true; return true }
        override fun onScale(d: ScaleGestureDetector): Boolean {
            range = (range / d.scaleFactor).coerceIn(1e-3, 1e5)
            requestCompute(); invalidate()
            return true
        }
    }).apply { isQuickScaleEnabled = false }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        scaleDet.onTouchEvent(e)
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastX = e.x; lastY = e.y; pinching = false
                val now = System.currentTimeMillis()
                if (now - lastTap < 300) home()
                lastTap = now
            }
            MotionEvent.ACTION_MOVE -> if (!pinching && e.pointerCount == 1) {
                yaw -= (e.x - lastX) / dens * 0.45
                pitch = (pitch + (e.y - lastY) / dens * 0.45).coerceIn(-89.0, 89.0)
                lastX = e.x; lastY = e.y
                invalidate()
            }
            MotionEvent.ACTION_POINTER_UP -> { val keep = if (e.actionIndex == 0) 1 else 0; if (keep < e.pointerCount) { lastX = e.getX(keep); lastY = e.getY(keep) } }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { pinching = false; onViewChanged?.invoke() }
        }
        return true
    }

    override fun onGenericMotionEvent(e: MotionEvent): Boolean {
        if (e.actionMasked == MotionEvent.ACTION_SCROLL) {
            val v = e.getAxisValue(MotionEvent.AXIS_VSCROLL)
            if (v != 0f) { range = (range / 1.15.pow(v.toDouble())).coerceIn(1e-3, 1e5); requestCompute(); invalidate(); onViewChanged?.invoke(); return true }
        }
        return super.onGenericMotionEvent(e)
    }

    companion object {
        const val DEFAULT_YAW = -122.0
        const val DEFAULT_PITCH = 24.0
        const val DEFAULT_RANGE = 6.0
    }
}
