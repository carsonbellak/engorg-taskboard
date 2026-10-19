package com.engorg.inkpad

import android.graphics.Color
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
    /** A prism whose cross-section is a trapezoid ([SolidParams.top] = top edge ÷ bottom edge). */
    TRAPEZOID("Trapezoid", false),
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
        kind == SolidKind.TRAPEZOID -> 4
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
        SolidKind.TRAPEZOID -> "trapezoidal prism"
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
        fun trapezoid() = SolidParams(SolidKind.TRAPEZOID, 4, height = 0.6f, depth = 0.6f, top = 0.55f)
    }
}

/**
 * Paint on a solid: one color for every face ([all]), per-face colors ([faces], keyed by face region;
 * 0 = left unfilled), and water filling [water] (0–1) of its volume. Colors carry their own alpha.
 */
class SolidFill(var all: Int = 0, val faces: HashMap<Int, Int> = HashMap(), var water: Float = 0f, var waterColor: Int = WATER) {
    fun copy() = SolidFill(all, HashMap(faces), water, waterColor)
    val isEmpty: Boolean get() = all == 0 && faces.isEmpty() && water <= 0f
    fun colorOf(region: Int): Int = faces[region] ?: all

    fun toJson(): JSONObject = JSONObject().put("a", all).put("w", water.toDouble()).put("wc", waterColor)
        .put("f", JSONObject().apply { for ((k, v) in faces) put(k.toString(), v) })

    companion object {
        val WATER = Color.argb(0x8C, 0x3B, 0x8E, 0xEA)
        fun fromJson(o: JSONObject?): SolidFill {
            if (o == null) return SolidFill()
            val f = HashMap<Int, Int>()
            o.optJSONObject("f")?.let { j -> for (k in j.keys()) k.toIntOrNull()?.let { f[it] = j.optInt(k) } }
            return SolidFill(o.optInt("a", 0), f, o.optDouble("w", 0.0).toFloat().coerceIn(0f, 1f), o.optInt("wc", WATER))
        }
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
class Solid(val params: SolidParams, val r: FloatArray = defaultView(), var size: Float = 50f, var fill: SolidFill = SolidFill()) {

    fun copy() = Solid(params.copy(), r.copyOf(), size, fill.copy())

    // ---------------- fills and water ----------------

    /** Face regions you can color: each flat face on its own, a curved surface's facets together. */
    fun regionCount(): Int = regionIndex(fillMesh(params)).let { if (it.isEmpty()) 0 else it.max() + 1 }

    private class Proj(val x: FloatArray, val y: FloatArray, val z: FloatArray)

    /** Model points → page (x right, y down) and view depth (z toward the viewer) for center ([cx],[cy]). */
    private fun project(pts: List<FloatArray>, cx: Float, cy: Float): Proj {
        val n = pts.size
        val x = FloatArray(n); val y = FloatArray(n); val z = FloatArray(n)
        for (i in 0 until n) {
            val p = pts[i]
            x[i] = cx + size * (r[0] * p[0] + r[1] * p[1] + r[2] * p[2])
            y[i] = cy - size * (r[3] * p[0] + r[4] * p[1] + r[5] * p[2])
            z[i] = size * (r[6] * p[0] + r[7] * p[1] + r[8] * p[2])
        }
        return Proj(x, y, z)
    }

    /** Does the polygon (page coords, from outward CCW model order) face the viewer? */
    private fun facing(xs: FloatArray, ys: FloatArray, idx: IntArray): Boolean {
        var nz = 0f
        for (k in idx.indices) { val a = idx[k]; val b = idx[(k + 1) % idx.size]; nz += (xs[a] - xs[b]) * (-ys[a] - ys[b]) }
        return nz > 0f
    }

    /**
     * Everything painted on the solid, in drawing order (back to front): colored faces facing away,
     * the water, then colored faces facing the viewer. The water's surface stays level with the page
     * however the solid is turned, and holds [SolidFill.water] of the volume.
     */
    fun fills(cx: Float, cy: Float): List<ShapeSpec.Fill> {
        if (fill.isEmpty) return emptyList()
        val m = fillMesh(params)
        val reg = regionIndex(m)
        val pr = project(m.v, cx, cy)
        class G(val polys: ArrayList<List<PointF>>, val color: Int, var depth: Float, var count: Int)
        val back = HashMap<Int, G>(); val front = HashMap<Int, G>()
        for ((f, fc) in m.faces.withIndex()) {
            val c = fill.colorOf(reg[f]); if (Color.alpha(c) == 0) continue
            val map = if (facing(pr.x, pr.y, fc)) front else back
            val g = map.getOrPut(reg[f]) { G(ArrayList(), c, 0f, 0) }
            g.polys.add(fc.map { PointF(pr.x[it], pr.y[it]) })
            g.depth += fc.sumOf { pr.z[it].toDouble() }.toFloat() / fc.size; g.count++
        }
        val out = ArrayList<ShapeSpec.Fill>()
        back.values.sortedBy { it.depth / it.count }.forEach { out.add(ShapeSpec.Fill(it.polys, it.color)) }
        if (fill.water > 0.001f) out.addAll(waterFills(m, cx, cy))
        front.values.sortedBy { it.depth / it.count }.forEach { out.add(ShapeSpec.Fill(it.polys, it.color)) }
        return out
    }

    private fun waterFills(m: Mesh, cx: Float, cy: Float): List<ShapeSpec.Fill> {
        val polys = water(m, fill.water)
        if (polys.isEmpty()) return emptyList()
        val wc = fill.waterColor
        val backP = ArrayList<List<PointF>>(); val frontP = ArrayList<List<PointF>>(); var cap: List<PointF>? = null
        for ((k, poly) in polys.withIndex()) {
            val pr = project(poly, cx, cy)
            val idx = IntArray(poly.size) { it }
            val pts = idx.map { PointF(pr.x[it], pr.y[it]) }
            if (k == polys.size - 1 && capLast) cap = pts
            else if (facing(pr.x, pr.y, idx)) frontP.add(pts) else backP.add(pts)
        }
        val out = ArrayList<ShapeSpec.Fill>()
        if (backP.isNotEmpty()) out.add(ShapeSpec.Fill(backP, wc))
        cap?.let {
            val surface = Color.argb((Color.alpha(wc) * 0.75f).toInt(), Color.red(wc), Color.green(wc), Color.blue(wc))
            out.add(ShapeSpec.Fill(listOf(it), surface, Color.argb(0xE0, (Color.red(wc) * 0.6f).toInt(), (Color.green(wc) * 0.6f).toInt(), (Color.blue(wc) * 0.75f).toInt())))
        }
        if (frontP.isNotEmpty()) out.add(ShapeSpec.Fill(frontP, wc))
        return out
    }

    private var capLast = false

    /**
     * The water: the solid cut by a level plane (perpendicular to the page's "down") placed so the
     * part below holds [level] of the volume. Returns its faces in model coordinates (outward CCW),
     * with the water surface last when there is one.
     */
    private fun water(m: Mesh, level: Float): List<List<FloatArray>> {
        capLast = false
        val up = floatArrayOf(r[3], r[4], r[5])    // the page's "up", in model coordinates
        val polys = m.faces.map { fc -> fc.map { m.v[it] } }
        if (level >= 0.999f) return polys
        var lo = Float.MAX_VALUE; var hi = -Float.MAX_VALUE
        for (p in m.v) { val h = dot(up, p); lo = min(lo, h); hi = max(hi, h) }
        val total = volume(polys)
        if (total <= 0f) return emptyList()
        var a = lo; var b = hi
        repeat(40) {
            val mid = (a + b) / 2
            if (volume(cut(polys, up, mid)) / total < level) a = mid else b = mid
        }
        val out = cut(polys, up, (a + b) / 2)
        capLast = out.isNotEmpty()
        return out
    }

    /** Clip each face to dot(up, p) ≤ h and close the cut with a cap polygon (appended last). */
    private fun cut(polys: List<List<FloatArray>>, up: FloatArray, h: Float): List<List<FloatArray>> {
        val out = ArrayList<List<FloatArray>>()
        val capPts = ArrayList<FloatArray>()
        for (poly in polys) {
            val res = ArrayList<FloatArray>()
            for (k in poly.indices) {
                val p = poly[k]; val q = poly[(k + 1) % poly.size]
                val dp = dot(up, p) - h; val dq = dot(up, q) - h
                if (dp <= 0f) res.add(p)
                if ((dp < 0f && dq > 0f) || (dp > 0f && dq < 0f)) {
                    val t = dp / (dp - dq)
                    val x = floatArrayOf(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t)
                    res.add(x); capPts.add(x)
                } else if (dp == 0f) capPts.add(p)
            }
            if (res.size >= 3) out.add(res)
        }
        if (capPts.size >= 3) {
            val c = FloatArray(3); for (p in capPts) for (i in 0..2) c[i] += p[i] / capPts.size
            // Basis (e1, e2) in the plane with e1 × e2 = up, so CCW in it faces up (outward).
            val e1 = if (abs(up[0]) < 0.9f) cross(up, floatArrayOf(1f, 0f, 0f)) else cross(up, floatArrayOf(0f, 1f, 0f))
            norm(e1)
            val e2 = cross(up, e1)
            val sorted = capPts.sortedBy { p -> val d = sub(p, c); atan2(dot(d, e2), dot(d, e1)) }
            val uniq = ArrayList<FloatArray>()
            for (p in sorted) if (uniq.isEmpty() || dist(uniq.last(), p) > 1e-5f) uniq.add(p)
            if (uniq.size >= 3 && dist(uniq.first(), uniq.last()) <= 1e-5f) uniq.removeAt(uniq.size - 1)
            if (uniq.size >= 3) out.add(uniq)
        }
        return out
    }

    /** Volume of a closed polyhedron given as outward CCW polygons. */
    private fun volume(polys: List<List<FloatArray>>): Float {
        var v = 0f
        for (poly in polys) for (k in 1 until poly.size - 1) v += dot(poly[0], cross(poly[k], poly[k + 1]))
        return v / 6f
    }

    /** The colorable region under page point ([x], [y]) on the side facing the viewer, or −1. */
    fun regionAt(cx: Float, cy: Float, x: Float, y: Float): Int {
        val m = fillMesh(params); val reg = regionIndex(m); val pr = project(m.v, cx, cy)
        var best = -1; var bestZ = -Float.MAX_VALUE
        for ((f, fc) in m.faces.withIndex()) {
            if (!facing(pr.x, pr.y, fc)) continue
            var inside = false; var j = fc.size - 1
            for (i in fc.indices) {
                val ax = pr.x[fc[i]]; val ay = pr.y[fc[i]]; val bx = pr.x[fc[j]]; val by = pr.y[fc[j]]
                if ((ay > y) != (by > y) && x < (bx - ax) * (y - ay) / ((by - ay) + 1e-9f) + ax) inside = !inside
                j = i
            }
            if (inside) { val z = fc.sumOf { pr.z[it].toDouble() }.toFloat() / fc.size; if (z > bestZ) { bestZ = z; best = reg[f] } }
        }
        return best
    }

    /** The front-facing polygons of [region] (for highlighting a picked face). */
    fun regionPolys(cx: Float, cy: Float, region: Int): List<List<PointF>> {
        val m = fillMesh(params); val reg = regionIndex(m); val pr = project(m.v, cx, cy)
        return m.faces.withIndex().filter { (f, fc) -> reg[f] == region && facing(pr.x, pr.y, fc) }.map { (_, fc) -> fc.map { PointF(pr.x[it], pr.y[it]) } }
    }

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

    /** A convex polyhedron: vertices, outward CCW faces, each edge with its two faces, and each face's
     *  smoothing group (−1 = a flat face of its own; faces sharing a group ≥ 0 form one curved surface). */
    class Mesh(val v: List<FloatArray>, val faces: List<IntArray>, val edges: List<Edge>, val group: IntArray = IntArray(faces.size) { -1 })

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
                SolidKind.TRAPEZOID -> {
                    // Trapezoid cross-section (bottom 2 wide, top 2·top wide) extruded front to back.
                    val t = p.top.coerceIn(0.05f, 1f); val d = p.depth
                    val f0 = v.size
                    for (z in floatArrayOf(d, -d)) {
                        v.add(floatArrayOf(-1f, -hh, z)); v.add(floatArrayOf(1f, -hh, z)); v.add(floatArrayOf(t, hh, z)); v.add(floatArrayOf(-t, hh, z))
                    }
                    face(-1, f0, f0 + 1, f0 + 2, f0 + 3); face(-1, f0 + 4, f0 + 5, f0 + 6, f0 + 7)
                    for (k in 0 until 4) { val k2 = (k + 1) % 4; face(-1, f0 + k, f0 + k2, f0 + 4 + k2, f0 + 4 + k) }
                }
            }
            orient(v, faces)
            return Mesh(v, faces, edgesOf(faces, group), group.toIntArray())
        }

        /** The mesh fills and water are computed on (a sphere gets a fine lat-long mesh). */
        @Synchronized
        fun fillMesh(p: SolidParams): Mesh = if (p.kind != SolidKind.SPHERE) mesh(p) else cache.getOrPut("fill/" + p.key()) { sphereMesh(p) }

        private fun sphereMesh(p: SolidParams): Mesh {
            val v = ArrayList<FloatArray>(); val faces = ArrayList<IntArray>()
            val lat = 16; val lon = 32
            v.add(floatArrayOf(0f, p.height, 0f))
            for (i in 1 until lat) {
                val th = PI * i / lat
                for (j in 0 until lon) {
                    val ph = 2 * PI * j / lon
                    v.add(floatArrayOf((sin(th) * cos(ph)).toFloat(), (cos(th) * p.height).toFloat(), (sin(th) * sin(ph) * p.depth).toFloat()))
                }
            }
            v.add(floatArrayOf(0f, -p.height, 0f))
            val south = v.size - 1
            fun at(i: Int, j: Int) = 1 + (i - 1) * lon + (j % lon)
            for (j in 0 until lon) faces.add(intArrayOf(0, at(1, j), at(1, j + 1)))
            for (i in 1 until lat - 1) for (j in 0 until lon) faces.add(intArrayOf(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)))
            for (j in 0 until lon) faces.add(intArrayOf(south, at(lat - 1, j + 1), at(lat - 1, j)))
            orient(v, faces)
            return Mesh(v, faces, emptyList(), IntArray(faces.size) { 0 })
        }

        /** Face → colorable region: flat faces one each, a smoothing group as one, numbered in face order. */
        fun regionIndex(m: Mesh): IntArray {
            val out = IntArray(m.faces.size); val byGroup = HashMap<Int, Int>(); var next = 0
            for (f in m.faces.indices) {
                val g = m.group.getOrElse(f) { -1 }
                out[f] = if (g < 0) next++ else byGroup.getOrPut(g) { next++ }
            }
            return out
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
        private fun dist(a: FloatArray, b: FloatArray) = sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]))
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
