package com.engorg.inkpad

import android.graphics.PointF
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Families of 3D solids. [sides] is the n-fold symmetry of the base (or, for PLATONIC, the face
 * count: 4/6/8/12/20). [roundable] families turn into their curved version (cylinder, cone…)
 * when the base is round.
 */
enum class SolidKind(val label: String, val roundable: Boolean) {
    PRISM("Prism", true), PYRAMID("Pyramid", true), FRUSTUM("Frustum", true), BIPYRAMID("Bipyramid", true),
    ANTIPRISM("Antiprism", false), SPHERE("Sphere", false), PLATONIC("Platonic", false),
}

/**
 * What a solid is, independent of where it sits or how it's turned. Proportions are relative to
 * a base of radius 1: [height] = total height ÷ base diameter, [depth] stretches the base front to
 * back (1 = regular), [top] = a frustum's top radius ÷ its base radius.
 */
class SolidParams(
    var kind: SolidKind = SolidKind.PRISM,
    var sides: Int = 6,
    var round: Boolean = false,
    var height: Float = 1f,
    var depth: Float = 1f,
    var top: Float = 0.5f,
) {
    fun copy() = SolidParams(kind, sides, round, height, depth, top)

    fun copyInto(o: SolidParams) { o.kind = kind; o.sides = sides; o.round = round; o.height = height; o.depth = depth; o.top = top }

    /** Round only where the family has a curved version. */
    val isRound: Boolean get() = round && kind.roundable

    /** Sides actually built: round = a fine polygon; platonic = a valid face count. */
    val n: Int get() = when {
        kind == SolidKind.PLATONIC -> PLATONIC_FACES.minByOrNull { abs(it - sides) } ?: 6
        isRound -> 64
        else -> sides.coerceIn(3, 24)
    }

    val label: String get() = when (kind) {
        SolidKind.PRISM -> when { isRound -> "cylinder"; n == 4 && depth == 1f -> if (abs(height - CUBE_H) < 0.01f) "cube" else "box"; else -> "${polyName(n)} prism" }
        SolidKind.PYRAMID -> if (isRound) "cone" else "${polyName(n)} pyramid"
        SolidKind.FRUSTUM -> if (isRound) "truncated cone" else "${polyName(n)} frustum"
        SolidKind.BIPYRAMID -> if (isRound) "double cone" else "${polyName(n)} bipyramid"
        SolidKind.ANTIPRISM -> "${polyName(n)} antiprism"
        SolidKind.SPHERE -> if (height == 1f && depth == 1f) "sphere" else "ellipsoid"
        SolidKind.PLATONIC -> PLATONIC_NAMES[n] ?: "polyhedron"
    }

    /** Faces · edges · vertices, for the builder's readout (round solids count their curved parts). */
    fun counts(): Triple<Int, Int, Int>? {
        if (isRound || kind == SolidKind.SPHERE) return null
        val m = Solid.mesh(this)
        return Triple(m.faces.size, m.edges.size, m.v.size)
    }

    fun key() = "${kind.name}/$n/$isRound/$height/$depth/$top"

    fun toJson(): JSONObject = JSONObject().put("k", kind.name).put("n", sides).put("rd", round)
        .put("h", height.toDouble()).put("dp", depth.toDouble()).put("tp", top.toDouble())

    companion object {
        val PLATONIC_FACES = listOf(4, 6, 8, 12, 20)
        private val PLATONIC_NAMES = mapOf(4 to "tetrahedron", 6 to "cube", 8 to "octahedron", 12 to "dodecahedron", 20 to "icosahedron")
        /** Height of a prism-4 that makes a cube (square side = √2 × the base radius). */
        const val CUBE_H = 0.7071f

        fun polyName(n: Int) = when (n) {
            3 -> "triangular"; 4 -> "square"; 5 -> "pentagonal"; 6 -> "hexagonal"; 7 -> "heptagonal"
            8 -> "octagonal"; 9 -> "nonagonal"; 10 -> "decagonal"; 12 -> "dodecagonal"; else -> "$n-sided"
        }

        fun fromJson(o: JSONObject) = SolidParams(
            runCatching { SolidKind.valueOf(o.getString("k")) }.getOrDefault(SolidKind.PRISM),
            o.optInt("n", 6).coerceIn(3, 24), o.optBoolean("rd", false),
            o.optDouble("h", 1.0).toFloat().coerceIn(0.1f, 5f), o.optDouble("dp", 1.0).toFloat().coerceIn(0.1f, 5f),
            o.optDouble("tp", 0.5).toFloat().coerceIn(0.02f, 1f),
        )

        // Quick picks in the shapes menu.
        fun box() = SolidParams(SolidKind.PRISM, 4, height = CUBE_H)
        fun cylinder() = SolidParams(SolidKind.PRISM, 6, round = true, height = 1f)
        fun cone() = SolidParams(SolidKind.PYRAMID, 6, round = true, height = 1.1f)
        fun sphere() = SolidParams(SolidKind.SPHERE)
        fun pyramid() = SolidParams(SolidKind.PYRAMID, 4, height = 0.8f)
    }
}

/**
 * A 3D solid placed on the page: [params] (its shape), [r] (a 3×3 rotation, row-major, model →
 * view) and [size] (page units per model unit). The model is y-up and centered; the view looks
 * down −z (z points at the viewer), and the page center comes from the owning ShapeSpec.
 *
 * Rendering is an orthographic projection with exact hidden-line removal (every family is convex,
 * so back-face culling is exact): a crease edge is drawn solid when either of its faces points at
 * the viewer and dashed when both face away; the facets of a curved surface only draw their
 * silhouette. So the dashed lines move correctly as the solid turns.
 */
class Solid(val params: SolidParams, val r: FloatArray = defaultView(), var size: Float = 50f) {

    fun copy() = Solid(params.copy(), r.copyOf(), size)

    /** Orbit: yaw about the screen's vertical axis, then pitch about its horizontal axis (degrees). */
    fun orbit(base: FloatArray, yawDeg: Float, pitchDeg: Float) {
        val m = mul(rotX(pitchDeg), mul(rotY(yawDeg), base))
        orthonormalize(m); m.copyInto(r)
    }

    /** Spin in the page plane by [deg] (page coords are y-down, so it's −deg about the view z). */
    fun rollBy(deg: Float) { val m = mul(rotZ(-deg), r); orthonormalize(m); m.copyInto(r) }

    fun setView(view: FloatArray) { view.copyInto(r) }

    /** Polylines on the page for a solid centered at ([cx],[cy]). */
    fun parts(cx: Float, cy: Float): List<ShapeSpec.Part> =
        if (params.kind == SolidKind.SPHERE) sphereParts(cx, cy) else meshParts(cx, cy)

    /** Projected (x,y) extent of the solid at size 1: minX, minY, maxX, maxY in view coords (y up). */
    private fun unitExtent(): FloatArray {
        val e = floatArrayOf(Float.MAX_VALUE, Float.MAX_VALUE, -Float.MAX_VALUE, -Float.MAX_VALUE)
        val saved = size; size = 1f
        for (p in parts(0f, 0f)) for (q in p.pts) {
            e[0] = min(e[0], q.x); e[2] = max(e[2], q.x); e[1] = min(e[1], -q.y); e[3] = max(e[3], -q.y)
        }
        size = saved
        return e
    }

    /** Scale to fit the page box (l,t)–(r,b) and return the center that fills it. */
    fun fitTo(l: Float, t: Float, rt: Float, b: Float): PointF {
        val e = unitExtent()
        val w = max(e[2] - e[0], 1e-3f); val h = max(e[3] - e[1], 1e-3f)
        size = max(min((rt - l) / w, (b - t) / h), 4f)
        // The model's center needn't project to the middle of its outline (a cone's doesn't).
        val ox = (e[0] + e[2]) / 2f * size; val oy = (e[1] + e[3]) / 2f * size
        return PointF((l + rt) / 2f - ox, (t + b) / 2f + oy)
    }

    // ---------------- polyhedral solids ----------------

    private fun meshParts(cx: Float, cy: Float): List<ShapeSpec.Part> {
        val mesh = mesh(params)
        val vx = FloatArray(mesh.v.size); val vy = FloatArray(mesh.v.size)
        for (i in mesh.v.indices) {
            val p = mesh.v[i]
            vx[i] = size * (r[0] * p[0] + r[1] * p[1] + r[2] * p[2])
            vy[i] = size * (r[3] * p[0] + r[4] * p[1] + r[5] * p[2])
        }
        // Newell's z: positive when the (outward, CCW) face turns toward the viewer.
        val front = BooleanArray(mesh.faces.size) { f ->
            val fc = mesh.faces[f]; var nz = 0f
            for (k in fc.indices) { val a = fc[k]; val b = fc[(k + 1) % fc.size]; nz += (vx[a] - vx[b]) * (vy[a] + vy[b]) }
            nz > 1e-6f * size * size
        }
        val vis = ArrayList<IntArray>(); val hid = ArrayList<IntArray>()
        for (e in mesh.edges) {
            val f1 = front[e.f1]; val f2 = front[e.f2]
            if (e.smooth) { if (f1 != f2) vis.add(intArrayOf(e.a, e.b)) }
            else if (f1 || f2) vis.add(intArrayOf(e.a, e.b)) else hid.add(intArrayOf(e.a, e.b))
        }
        val out = ArrayList<ShapeSpec.Part>()
        fun emit(edges: List<IntArray>, hidden: Boolean) {
            for (chain in chains(edges)) {
                val pts = ArrayList<PointF>()
                for (k in 0 until chain.size - 1) {
                    val a = chain[k]; val b = chain[k + 1]
                    val seg = dense(cx + vx[a], cy - vy[a], cx + vx[b], cy - vy[b])
                    pts.addAll(if (k < chain.size - 2) seg.dropLast(1) else seg)
                }
                if (pts.size >= 2) out.add(ShapeSpec.Part(pts, hidden = hidden))
            }
        }
        emit(vis, false); emit(hid, true)
        return out
    }

    // ---------------- sphere / ellipsoid (exact outline) ----------------

    private fun sphereParts(cx: Float, cy: Float): List<ShapeSpec.Part> {
        // Model → view linear map M = size · R · D, D = diag(1, height, depth).
        val d = floatArrayOf(1f, params.height, params.depth)
        val m = FloatArray(9) { size * r[it] * d[it % 3] }
        // Outline: the image of the unit ball under the 2×3 top of M is the ellipse with shape
        // matrix S = A·Aᵀ; walk it as S^½ · (cos t, sin t).
        val sxx = m[0] * m[0] + m[1] * m[1] + m[2] * m[2]
        val sxy = m[0] * m[3] + m[1] * m[4] + m[2] * m[5]
        val syy = m[3] * m[3] + m[4] * m[4] + m[5] * m[5]
        val (h00, h01, h11) = sqrt2x2(sxx, sxy, syy)
        val out = ArrayList<ShapeSpec.Part>()
        val n = 72
        out.add(ShapeSpec.Part((0..n).map {
            val t = 2.0 * PI * it / n; val c = cos(t).toFloat(); val s = sin(t).toFloat()
            PointF(cx + h00 * c + h01 * s, cy - (h01 * c + h11 * s))
        }))
        // Equator and the front meridian, split where they pass behind. A surface point u faces the
        // viewer when the view-z of its normal (R · D⁻¹ · u) is positive.
        fun ring(f: (Double) -> FloatArray) {
            var run = ArrayList<PointF>(); var runFront: Boolean? = null
            for (i in 0..n) {
                val u = f(2.0 * PI * i / n)
                val nz = r[6] * u[0] / d[0] + r[7] * u[1] / d[1] + r[8] * u[2] / d[2]
                val isFront = nz >= 0f
                val p = PointF(cx + m[0] * u[0] + m[1] * u[1] + m[2] * u[2], cy - (m[3] * u[0] + m[4] * u[1] + m[5] * u[2]))
                if (runFront != null && isFront != runFront) {
                    run.add(p); out.add(ShapeSpec.Part(run, hidden = !runFront)); run = arrayListOf(PointF(p.x, p.y))
                } else run.add(p)
                runFront = isFront
            }
            if (run.size >= 2) out.add(ShapeSpec.Part(run, hidden = runFront == false))
        }
        ring { t -> floatArrayOf(cos(t).toFloat(), 0f, sin(t).toFloat()) }
        ring { t -> floatArrayOf(0f, sin(t).toFloat(), cos(t).toFloat()) }
        return out
    }

    // ---------------- mesh model ----------------

    class Edge(val a: Int, val b: Int, val f1: Int, val f2: Int, val smooth: Boolean)

    /** A convex polyhedron: vertices, outward CCW faces, and each edge with its two faces. */
    class Mesh(val v: List<FloatArray>, val faces: List<IntArray>, val edges: List<Edge>)

    companion object {
        /** A gentle three-quarter view: the front, right side and top all show, and no edges overlap. */
        fun defaultView(): FloatArray = mul(rotX(22f), rotY(-32f))
        fun isoView(): FloatArray = mul(rotX(35.264f), rotY(-45f))
        fun frontView(): FloatArray = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
        fun topView(): FloatArray = rotX(90f)
        fun sideView(): FloatArray = rotY(-90f)

        private val cache = object : LinkedHashMap<String, Mesh>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Mesh>?) = size > 24
        }

        @Synchronized
        fun mesh(p: SolidParams): Mesh = cache.getOrPut(p.key()) { build(p) }

        private fun build(p: SolidParams): Mesh {
            val v = ArrayList<FloatArray>(); val faces = ArrayList<IntArray>(); val group = ArrayList<Int>()
            val n = p.n; val hh = p.height   // half-height (total height = height × diameter 2)
            val phase = PI / n + PI / 2      // a flat side faces the front (axis-aligned square for n = 4)
            fun ring(rad: Float, y: Float, twist: Double = 0.0): Int {
                val first = v.size
                for (k in 0 until n) {
                    val a = phase + twist + 2 * PI * k / n
                    v.add(floatArrayOf(rad * cos(a).toFloat(), y, rad * p.depth * sin(a).toFloat()))
                }
                return first
            }
            fun point(y: Float): Int { v.add(floatArrayOf(0f, y, 0f)); return v.size - 1 }
            fun face(g: Int, vararg idx: Int) { faces.add(idx); group.add(g) }
            fun cap(first: Int) = face(-1, *IntArray(n) { first + it })
            val side = if (p.isRound) 0 else -1
            when (p.kind) {
                SolidKind.PRISM, SolidKind.FRUSTUM -> {
                    val topR = if (p.kind == SolidKind.FRUSTUM) p.top.coerceIn(0.02f, 1f) else 1f
                    val b = ring(1f, -hh); val t = ring(topR, hh)
                    cap(b); cap(t)
                    for (k in 0 until n) { val k2 = (k + 1) % n; face(side, b + k, b + k2, t + k2, t + k) }
                }
                SolidKind.PYRAMID -> {
                    val b = ring(1f, -hh); val apex = point(hh)
                    cap(b)
                    for (k in 0 until n) face(side, b + k, b + (k + 1) % n, apex)
                }
                SolidKind.BIPYRAMID -> {
                    val m = ring(1f, 0f); val up = point(hh); val dn = point(-hh)
                    for (k in 0 until n) {
                        face(side, m + k, m + (k + 1) % n, up)
                        face(if (p.isRound) 1 else -1, m + k, m + (k + 1) % n, dn)
                    }
                }
                SolidKind.ANTIPRISM -> {
                    val b = ring(1f, -hh); val t = ring(1f, hh, PI / n)
                    cap(b); cap(t)
                    for (k in 0 until n) {
                        val k2 = (k + 1) % n
                        face(-1, b + k, b + k2, t + k)
                        face(-1, t + k, b + k2, t + k2)
                    }
                }
                SolidKind.PLATONIC -> return hull(platonic(n).map { floatArrayOf(it[0], it[1] * hh, it[2] * p.depth) })
                SolidKind.SPHERE -> {}
            }
            orient(v, faces)
            return Mesh(v, faces, edgesOf(faces, group))
        }

        /** Flip any face whose normal points at the solid's centroid (convex ⇒ it's inward). */
        private fun orient(v: List<FloatArray>, faces: MutableList<IntArray>) {
            val c = FloatArray(3); for (p in v) for (i in 0..2) c[i] += p[i] / v.size
            for (f in faces.indices) {
                val fc = faces[f]; val nrm = newell(v, fc)
                val mid = FloatArray(3); for (i in fc) for (k in 0..2) mid[k] += v[i][k] / fc.size
                if (nrm[0] * (mid[0] - c[0]) + nrm[1] * (mid[1] - c[1]) + nrm[2] * (mid[2] - c[2]) < 0f) faces[f] = fc.reversedArray()
            }
        }

        private fun newell(v: List<FloatArray>, fc: IntArray): FloatArray {
            val n = FloatArray(3)
            for (k in fc.indices) {
                val a = v[fc[k]]; val b = v[fc[(k + 1) % fc.size]]
                n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1])
            }
            return n
        }

        private fun edgesOf(faces: List<IntArray>, group: List<Int>): List<Edge> {
            val seen = HashMap<Long, Int>(); val out = ArrayList<Edge>()
            for (f in faces.indices) {
                val fc = faces[f]
                for (k in fc.indices) {
                    val a = fc[k]; val b = fc[(k + 1) % fc.size]
                    val key = min(a, b).toLong() shl 32 or max(a, b).toLong()
                    val other = seen.remove(key)
                    if (other == null) seen[key] = f
                    else out.add(Edge(a, b, other, f, group[f] >= 0 && group[f] == group[other]))
                }
            }
            return out
        }

        /** Vertices of the regular solid with [faces] faces, circumradius 1. */
        private fun platonic(faces: Int): List<FloatArray> {
            val g = ((1 + sqrt(5.0)) / 2).toFloat(); val ig = 1f / g
            val pts = ArrayList<FloatArray>()
            fun signs(x: Float, y: Float, z: Float) {
                for (sx in listOf(1f, -1f)) for (sy in listOf(1f, -1f)) for (sz in listOf(1f, -1f)) {
                    val p = floatArrayOf(x * sx, y * sy, z * sz)
                    if (pts.none { abs(it[0] - p[0]) + abs(it[1] - p[1]) + abs(it[2] - p[2]) < 1e-5f }) pts.add(p)
                }
            }
            when (faces) {
                4 -> { pts.add(floatArrayOf(1f, 1f, 1f)); pts.add(floatArrayOf(1f, -1f, -1f)); pts.add(floatArrayOf(-1f, 1f, -1f)); pts.add(floatArrayOf(-1f, -1f, 1f)) }
                8 -> { signs(1f, 0f, 0f); signs(0f, 1f, 0f); signs(0f, 0f, 1f) }
                12 -> { signs(1f, 1f, 1f); signs(0f, ig, g); signs(ig, g, 0f); signs(g, 0f, ig) }
                20 -> { signs(0f, 1f, g); signs(1f, g, 0f); signs(g, 0f, 1f) }
                else -> signs(1f, 1f, 1f)
            }
            val rad = pts.maxOf { sqrt(it[0] * it[0] + it[1] * it[1] + it[2] * it[2]) }
            return pts.map { floatArrayOf(it[0] / rad, it[1] / rad, it[2] / rad) }
        }

        /**
         * Convex hull of a small point set (≤ 20 points): every supporting plane through three
         * points becomes a face holding all its coplanar points, ordered CCW from outside.
         */
        private fun hull(v: List<FloatArray>): Mesh {
            val faces = ArrayList<IntArray>(); val planes = ArrayList<FloatArray>()
            val eps = 1e-4f
            for (i in v.indices) for (j in i + 1 until v.size) for (k in j + 1 until v.size) {
                val a = v[i]; val b = v[j]; val c = v[k]
                val n = cross(sub(b, a), sub(c, a)); val len = sqrt(dot(n, n))
                if (len < 1e-6f) continue
                for (q in 0..2) n[q] /= len
                var pos = false; var neg = false
                for (p in v) { val s = dot(n, sub(p, a)); if (s > eps) pos = true else if (s < -eps) neg = true }
                if (pos && neg) continue
                if (pos) for (q in 0..2) n[q] = -n[q]
                val off = dot(n, a)
                if (planes.any { abs(it[0] - n[0]) + abs(it[1] - n[1]) + abs(it[2] - n[2]) < 1e-3f && abs(it[3] - off) < 1e-3f }) continue
                planes.add(floatArrayOf(n[0], n[1], n[2], off))
                val on = v.indices.filter { abs(dot(n, v[it]) - off) < eps }
                val ctr = FloatArray(3); for (q in on) for (t in 0..2) ctr[t] += v[q][t] / on.size
                val u = sub(v[on[0]], ctr); val ul = sqrt(dot(u, u)); for (t in 0..2) u[t] /= ul
                val w = cross(n, u)
                faces.add(on.sortedBy { q -> val d = sub(v[q], ctr); atan2(dot(d, w), dot(d, u)) }.toIntArray())
            }
            return Mesh(v, faces, edgesOf(faces, List(faces.size) { -1 }))
        }

        // ---- polyline helpers ----

        /** Join edges that share vertices into as few polylines as possible (open runs first, then loops). */
        private fun chains(edges: List<IntArray>): List<List<Int>> {
            val adj = HashMap<Int, ArrayList<Int>>()
            for ((i, e) in edges.withIndex()) { adj.getOrPut(e[0]) { ArrayList() }.add(i); adj.getOrPut(e[1]) { ArrayList() }.add(i) }
            val used = BooleanArray(edges.size); val out = ArrayList<List<Int>>()
            fun walk(start: Int) {
                val chain = arrayListOf(start); var at = start
                while (true) {
                    val next = adj[at]?.firstOrNull { !used[it] } ?: break
                    used[next] = true
                    at = if (edges[next][0] == at) edges[next][1] else edges[next][0]
                    chain.add(at)
                }
                if (chain.size >= 2) out.add(chain)
            }
            for ((vtx, list) in adj) if (list.size != 2) while (adj[vtx]!!.any { !used[it] }) walk(vtx)
            for (i in edges.indices) if (!used[i]) walk(edges[i][0])
            return out
        }

        /** Segment with points every ~8 page units (so taps, the lasso and the eraser find it). */
        private fun dense(x0: Float, y0: Float, x1: Float, y1: Float): List<PointF> {
            val n = (hypot(x1 - x0, y1 - y0) / 8f).toInt().coerceIn(1, 200)
            return (0..n).map { val t = it.toFloat() / n; PointF(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) }
        }

        // ---- small 3×3 linear algebra (row-major) ----

        private fun rotX(deg: Float): FloatArray { val a = Math.toRadians(deg.toDouble()); val c = cos(a).toFloat(); val s = sin(a).toFloat(); return floatArrayOf(1f, 0f, 0f, 0f, c, -s, 0f, s, c) }
        private fun rotY(deg: Float): FloatArray { val a = Math.toRadians(deg.toDouble()); val c = cos(a).toFloat(); val s = sin(a).toFloat(); return floatArrayOf(c, 0f, s, 0f, 1f, 0f, -s, 0f, c) }
        private fun rotZ(deg: Float): FloatArray { val a = Math.toRadians(deg.toDouble()); val c = cos(a).toFloat(); val s = sin(a).toFloat(); return floatArrayOf(c, -s, 0f, s, c, 0f, 0f, 0f, 1f) }

        private fun mul(a: FloatArray, b: FloatArray) = FloatArray(9) { val i = it / 3; val j = it % 3; a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] }

        /** Keep repeated drags from drifting the rotation off orthonormal (Gram–Schmidt on the rows). */
        private fun orthonormalize(m: FloatArray) {
            val x = floatArrayOf(m[0], m[1], m[2]); val y = floatArrayOf(m[3], m[4], m[5])
            norm(x); val d = dot(x, y); for (i in 0..2) y[i] -= d * x[i]; norm(y)
            val z = cross(x, y)
            x.copyInto(m, 0); y.copyInto(m, 3); z.copyInto(m, 6)
        }

        private fun norm(a: FloatArray) { val l = sqrt(dot(a, a)); if (l > 0f) for (i in 0..2) a[i] /= l }
        private fun dot(a: FloatArray, b: FloatArray) = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
        private fun sub(a: FloatArray, b: FloatArray) = floatArrayOf(a[0] - b[0], a[1] - b[1], a[2] - b[2])
        private fun cross(a: FloatArray, b: FloatArray) = floatArrayOf(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

        /** Symmetric square root of the 2×2 SPD matrix [[a, b], [b, c]] → (h00, h01, h11). */
        private fun sqrt2x2(a: Float, b: Float, c: Float): Triple<Float, Float, Float> {
            val det = max(a * c - b * b, 0f); val s = sqrt(det)
            val t = sqrt(max(a + c + 2f * s, 1e-12f))
            return Triple((a + s) / t, b / t, (c + s) / t)
        }

        fun rToJson(r: FloatArray) = JSONArray().apply { for (x in r) put(x.toDouble()) }
        fun rFromJson(a: JSONArray?): FloatArray =
            if (a == null || a.length() != 9) defaultView() else FloatArray(9) { a.getDouble(it).toFloat() }.also { orthonormalize(it) }
    }
}
