package com.engorg.inkpad

import android.graphics.PointF
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/** One line in the grapher's expression list. */
class GraphRow(
    var text: String = "",
    var color: Int,
    var hidden: Boolean = false,
    var sMin: Double = -10.0,
    var sMax: Double = 10.0,
    var tMin: String = "0",
    var tMax: String = "2pi",
)

enum class RowKind { EMPTY, ERROR, VALUE, SLIDER, CONST, FUNC, PLOT, POINT }

/** What a row turned out to be, for its info line / slider / range controls. */
class RowStatus(
    val kind: RowKind,
    val info: String = "",
    val error: Boolean = false,
    val sliderName: String? = null,
    val value: Double = Double.NaN,
    val rangeVar: String? = null,   // "t" (parametric) or "θ" (polar) when the row has a domain
    val missing: String? = null,    // an undefined variable the window can offer to add as a slider
)

/** Something drawable produced by a row. */
sealed class PlotItem(val row: Int, val color: Int) {
    /** y = g(x) (or x = g(y) when [alongY]); [shade] +1 shades above/right, −1 below/left. */
    class Explicit(row: Int, color: Int, val g: Compiled, val alongY: Boolean, val dashed: Boolean, val shade: Int) : PlotItem(row, color)
    class Param(row: Int, color: Int, val fx: Compiled, val fy: Compiled, val t0: Double, val t1: Double) : PlotItem(row, color)
    class Polar(row: Int, color: Int, val r: Compiled, val t0: Double, val t1: Double, val degrees: Boolean) : PlotItem(row, color)
    class Point(row: Int, color: Int, val x: Double, val y: Double) : PlotItem(row, color)
    /** Constraints F_k(x, y) <sense_k> 0 (sense 0 = equation, ±1 strict, ±2 inclusive). */
    class Implicit(row: Int, color: Int, val fs: List<Compiled>, val senses: IntArray, val degrees: Boolean) : PlotItem(row, color)
}

class GraphModel(val statuses: List<RowStatus>, val items: List<PlotItem>, val degrees: Boolean) {

    companion object {
        private const val ID = "[A-Za-z][A-Za-z0-9_]*"
        private val FN_RE = Regex("""^\s*($ID)\s*\(\s*($ID(?:\s*,\s*$ID)*)?\s*\)\s*=(?!=)""")
        private val CONST_RE = Regex("""^\s*($ID)\s*=(?!=)""")

        private class Def(val row: Int, val name: String, val rhs: Ex)

        fun build(rows: List<GraphRow>, degrees: Boolean): GraphModel {
            val env = MathEnv(degrees)
            val norm = rows.map { MathEngine.normalize(it.text) }
            val userFns = HashSet<String>()
            val userNames = HashSet<String>()
            for (s in norm) {
                FN_RE.find(s)?.let { m -> val n = m.groupValues[1]; if (!MathEngine.isReserved(n)) userFns.add(n) }
            }
            for (s in norm) {
                if (FN_RE.find(s) != null) continue
                CONST_RE.find(s)?.let { m -> val n = m.groupValues[1]; if (!MathEngine.isReserved(n) && n !in userFns) userNames.add(n) }
            }

            val statuses = arrayOfNulls<RowStatus>(rows.size)
            val parsed = arrayOfNulls<MathEngine.Statement>(rows.size)
            for (i in rows.indices) {
                if (rows[i].text.isBlank()) { statuses[i] = RowStatus(RowKind.EMPTY); continue }
                try { parsed[i] = MathEngine.parseStatement(rows[i].text, userFns, userNames) }
                catch (e: MathError) { statuses[i] = RowStatus(RowKind.ERROR, e.message ?: "Invalid", true) }
                catch (e: Exception) { statuses[i] = RowStatus(RowKind.ERROR, "Invalid expression", true) }
            }

            // ---- definitions: functions first, then constants (resolved in dependency order)
            val fnRows = HashMap<Int, UserFn>()
            val consts = ArrayList<Def>()
            for (i in rows.indices) {
                val st = parsed[i] ?: continue
                val l = st.lhs; val r = st.rhs ?: continue
                if (l is Ex.Call && l.name in userFns && l.primes == 0 && l.args.all { it is Ex.Var }) {
                    if (env.fns.containsKey(l.name)) { statuses[i] = RowStatus(RowKind.ERROR, "'${l.name}' is defined more than once", true); continue }
                    val fn = UserFn(l.name, l.args.map { (it as Ex.Var).name }, r)
                    env.fns[l.name] = fn; fnRows[i] = fn
                } else if (l is Ex.Var && l.name in userNames) {
                    if (consts.any { it.name == l.name }) { statuses[i] = RowStatus(RowKind.ERROR, "'${l.name}' is defined more than once", true); continue }
                    consts.add(Def(i, l.name, r))
                }
            }
            val constVals = HashMap<Int, Double>()
            val pending = ArrayList(consts)
            var progress = true
            while (progress && pending.isNotEmpty()) {
                progress = false
                val it = pending.iterator()
                while (it.hasNext()) {
                    val d = it.next()
                    try {
                        val v = MathEngine.evalConst(d.rhs, env)
                        env.consts[d.name] = v; constVals[d.row] = v
                        it.remove(); progress = true
                    } catch (_: MathError) { } catch (_: StackOverflowError) { }
                }
            }
            for (d in pending) {
                val msg = try { MathEngine.evalConst(d.rhs, env); "Invalid" } catch (e: MathError) { e.message ?: "Invalid" }
                val circular = pending.any { p -> msg.contains("'${p.name}'") }
                val plotVar = MathEngine.PLOT_VARS.firstOrNull { msg.contains("'$it'") }
                statuses[d.row] = RowStatus(RowKind.ERROR, when {
                    circular -> "Circular definition"
                    plotVar != null -> "'${d.name}' can't depend on ${if (plotVar == "theta") "θ" else plotVar}"
                    else -> msg
                }, true)
            }

            // ---- everything else: classify and compile what to draw
            val items = ArrayList<PlotItem>()
            for (i in rows.indices) {
                if (statuses[i] != null) continue
                val st = parsed[i] ?: continue
                val row = rows[i]
                try {
                    val fn = fnRows[i]
                    val def = consts.firstOrNull { it.row == i }
                    statuses[i] = when {
                        fn != null -> {
                            // Validate the body; a one-variable f(x) also plots like Desmos.
                            val extra = fn.params.filter { it !in MathEngine.PLOT_VARS }
                            MathEngine.compile(Ex.Call(fn.name, fn.params.map { Ex.Var(it) }), env, MathEngine.PLOT_VARS + extra)
                            if (fn.params == listOf("x") && !row.hidden)
                                items.add(PlotItem.Explicit(i, row.color, MathEngine.compile(Ex.Call(fn.name, listOf(Ex.Var("x"))), env), false, false, 0))
                            RowStatus(RowKind.FUNC)
                        }
                        def != null -> {
                            val v = constVals[i] ?: Double.NaN
                            if (isLiteral(def.rhs)) RowStatus(RowKind.SLIDER, "", sliderName = def.name, value = v)
                            else RowStatus(RowKind.CONST, "= " + MathEngine.fmt(v), value = v)
                        }
                        else -> classify(i, row, st, env, items, degrees, userFns, userNames)
                    }
                } catch (e: MathError) {
                    statuses[i] = errorStatus(e.message ?: "Invalid", st, env)
                } catch (e: StackOverflowError) {
                    statuses[i] = RowStatus(RowKind.ERROR, "Too deeply nested", true)
                } catch (e: Exception) {
                    statuses[i] = RowStatus(RowKind.ERROR, "Couldn't evaluate this", true)
                }
            }
            items.removeAll { rows[it.row].hidden }
            return GraphModel(statuses.map { it ?: RowStatus(RowKind.EMPTY) }, items, degrees)
        }

        private fun errorStatus(msg: String, st: MathEngine.Statement, env: MathEnv): RowStatus {
            val m = Regex("'([A-Za-z][A-Za-z0-9_]*)' isn't defined").find(msg)
            val name = m?.groupValues?.get(1)
            val missing = name?.takeIf { it !in MathEngine.PLOT_VARS && !MathEngine.isReserved(it) && !env.consts.containsKey(it) }
            return RowStatus(RowKind.ERROR, msg, true, missing = missing)
        }

        private fun isLiteral(e: Ex): Boolean = e is Ex.Num || (e is Ex.Neg && e.a is Ex.Num)
        private fun isVar(e: Ex, n: String) = e is Ex.Var && e.name == n
        private fun isCmp(e: Ex) = (e is Ex.Bin && e.op in setOf("<", "<=", ">", ">=")) || e is Ex.Chain

        private fun free(e: Ex, env: MathEnv): Set<String> =
            MathEngine.freeVars(e).filter { !env.consts.containsKey(it) && !MathEngine.CONSTANTS.containsKey(it) }.toSet()

        /** Throw a helpful error if [e] uses any variable outside [allowed]. */
        private fun requireVars(e: Ex, env: MathEnv, allowed: Set<String>) {
            val bad = free(e, env) - allowed
            val v = bad.firstOrNull() ?: return
            if (v in MathEngine.PLOT_VARS) {
                val shown = if (v == "theta") "θ" else v
                throw MathError("'$shown' can't be used here")
            }
            throw MathError("'$v' isn't defined")
        }

        private fun sense(op: String) = when (op) { ">" -> 1; ">=" -> 2; "<" -> -1; "<=" -> -2; else -> throw MathError("Use = for equations") }

        private fun classify(
            i: Int, row: GraphRow, st: MathEngine.Statement, env: MathEnv, items: MutableList<PlotItem>,
            degrees: Boolean, userFns: Set<String>, userNames: Set<String>,
        ): RowStatus {
            val l = st.lhs; val r = st.rhs
            val c = row.color
            fun explicit(e: Ex, alongY: Boolean, dashed: Boolean, shade: Int): RowStatus {
                requireVars(e, env, setOf(if (alongY) "y" else "x"))
                items.add(PlotItem.Explicit(i, c, MathEngine.compile(e, env), alongY, dashed, shade))
                return RowStatus(RowKind.PLOT)
            }
            fun implicit(fs: List<Ex>, senses: IntArray): RowStatus {
                for (f in fs) requireVars(f, env, setOf("x", "y", "r", "theta"))
                items.add(PlotItem.Implicit(i, c, fs.map { MathEngine.compile(it, env) }, senses, degrees))
                return RowStatus(RowKind.PLOT)
            }
            fun range(): Pair<Double, Double> {
                fun one(s: String, label: String): Double {
                    val v = try { MathEngine.evalConst(MathEngine.parseExpr(s, userFns, userNames), env) } catch (e: MathError) { throw MathError("Range $label: ${e.message}") }
                    if (!v.isFinite()) throw MathError("Range $label must be a finite number")
                    return v
                }
                val a = one(row.tMin, "start"); val b = one(row.tMax, "end")
                if (a == b) throw MathError("The range is empty")
                return a to b
            }

            if (r == null) {
                if (isCmp(l)) {
                    if (l is Ex.Bin) {
                        val L = l.a; val R = l.b; val s = sense(l.op)
                        val strict = abs(s) == 1
                        if (isVar(L, "y") && "y" !in free(R, env)) return explicit(R, false, strict, if (s > 0) 1 else -1)
                        if (isVar(R, "y") && "y" !in free(L, env)) return explicit(L, false, strict, if (s > 0) -1 else 1)
                        if (isVar(L, "x") && "x" !in free(R, env) && free(R, env).all { it == "y" }) return explicit(R, true, strict, if (s > 0) 1 else -1)
                        if (isVar(R, "x") && "x" !in free(L, env) && free(L, env).all { it == "y" }) return explicit(L, true, strict, if (s > 0) -1 else 1)
                        return implicit(listOf(Ex.Bin("-", L, R)), intArrayOf(s))
                    }
                    val ch = l as Ex.Chain
                    val fs = ArrayList<Ex>(); val ss = IntArray(ch.ops.size)
                    for (k in ch.ops.indices) { fs.add(Ex.Bin("-", ch.items[k], ch.items[k + 1])); ss[k] = sense(ch.ops[k]) }
                    return implicit(fs, ss)
                }
                if (l is Ex.Tuple) {
                    if (l.items.size != 2) throw MathError("Only 2D points (x, y) can be graphed")
                    val fv = free(l, env)
                    if (fv.isEmpty()) {
                        val x = MathEngine.evalConst(l.items[0], env); val y = MathEngine.evalConst(l.items[1], env)
                        if (!row.hidden) items.add(PlotItem.Point(i, c, x, y))
                        return RowStatus(RowKind.POINT, "(" + MathEngine.fmt(x, 6) + ", " + MathEngine.fmt(y, 6) + ")")
                    }
                    requireVars(l, env, setOf("t"))
                    val (a, b) = range()
                    items.add(PlotItem.Param(i, c, MathEngine.compile(l.items[0], env), MathEngine.compile(l.items[1], env), a, b))
                    return RowStatus(RowKind.PLOT, rangeVar = "t")
                }
                val fv = free(l, env)
                if (fv.isEmpty()) {
                    val v = MathEngine.evalConst(l, env)
                    return RowStatus(RowKind.VALUE, "= " + MathEngine.fmt(v), value = v)
                }
                if (fv == setOf("x")) return explicit(l, false, false, 0)
                requireVars(l, env, setOf("x", "y", "r", "theta", "t"))
                throw MathError(if ("y" in fv) "Add “= …” to graph an equation" else "Try y = …, r = … or (x(t), y(t))")
            }

            // ---- equations
            val fl = free(l, env); val fr = free(r, env)
            if (isVar(l, "y") && "y" !in fr) return explicit(r, false, false, 0)
            if (isVar(r, "y") && "y" !in fl) return explicit(l, false, false, 0)
            if (isVar(l, "x") && fr.all { it == "y" }) return explicit(r, true, false, 0)
            if (isVar(r, "x") && fl.all { it == "y" }) return explicit(l, true, false, 0)
            if ((isVar(l, "r") && fr.all { it == "theta" }) || (isVar(r, "r") && fl.all { it == "theta" })) {
                val e = if (isVar(l, "r")) r else l
                val (a, b) = range()
                items.add(PlotItem.Polar(i, c, MathEngine.compile(e, env), a, b, degrees))
                return RowStatus(RowKind.PLOT, rangeVar = "θ")
            }
            val all = fl + fr
            if (all.isEmpty()) {
                val a = MathEngine.evalConst(l, env); val b = MathEngine.evalConst(r, env)
                return RowStatus(RowKind.VALUE, if (abs(a - b) <= 1e-12 * max(1.0, abs(a))) "true" else "false")
            }
            return implicit(listOf(Ex.Bin("-", l, r)), intArrayOf(0))
        }
    }
}

// ============================================================================ geometry

class Viewport(val x0: Double, val x1: Double, val y0: Double, val y1: Double, val pxW: Int, val pxH: Int) {
    val ppu get() = pxW / (x1 - x0)
    fun contains(o: Viewport) = o.x0 >= x0 && o.x1 <= x1 && o.y0 >= y0 && o.y1 <= y1
}

class Curve(val row: Int, val color: Int, val dashed: Boolean, val lines: List<DoubleArray>, val item: PlotItem?)
class Fill(val row: Int, val color: Int, val polys: List<DoubleArray>, val rects: DoubleArray?)
class Dot(val row: Int, val color: Int, val x: Double, val y: Double)
class Poi(val x: Double, val y: Double)

class Scene(
    val region: Viewport, val viewPpu: Double, val curves: List<Curve>, val fills: List<Fill>,
    val dots: List<Dot>, val pois: List<Poi>, val poiRow: Int,
)

/** One stroke of an exported graph, in the export box's coordinates (y down). */
class GraphInk(val pts: List<PointF>, val color: Int, val width: Float, val kind: Int) {
    companion object {
        const val FREE = 0; const val LINE = 1; const val DOT = 2; const val RECT = 3
        /** Color sentinel: "use the page's contrasting ink" (axes, ticks, labels). */
        const val AXIS = 0
    }
}

/** Turns a [GraphModel] into drawable geometry for one view region. Runs off the UI thread. */
object GraphCompute {
    private class Poly {
        var a = DoubleArray(256); var n = 0
        fun add(x: Double, y: Double) { if (n + 2 > a.size) a = a.copyOf(a.size * 2); a[n++] = x; a[n++] = y }
        fun arr() = a.copyOf(n)
    }

    fun compute(model: GraphModel, view: Viewport, focusRow: Int, stale: () -> Boolean): Scene? {
        // Compute a margin around the view so small pans don't reveal gaps before the next pass.
        val mx = (view.x1 - view.x0) * 0.3; val my = (view.y1 - view.y0) * 0.3
        val region = Viewport(view.x0 - mx, view.x1 + mx, view.y0 - my, view.y1 + my, (view.pxW * 1.6).toInt(), (view.pxH * 1.6).toInt())
        val curves = ArrayList<Curve>(); val fills = ArrayList<Fill>(); val dots = ArrayList<Dot>()
        val span = view.y1 - view.y0
        val nx = (view.pxW * 1.6 * 1.25).toInt().coerceIn(200, 4000)
        val explicitYs = HashMap<PlotItem.Explicit, DoubleArray>()

        for (item in model.items) {
            if (stale()) return null
            when (item) {
                is PlotItem.Explicit -> {
                    val fr = item.g.frame()
                    val slot = if (item.alongY) MathEngine.SY else MathEngine.SX
                    val g: (Double) -> Double = { v -> fr[slot] = v; item.g.f(fr) }
                    val a = if (item.alongY) region.y0 else region.x0
                    val b = if (item.alongY) region.y1 else region.x1
                    val tol = (if (item.alongY) region.x1 - region.x0 else span) * 0.01
                    val lines = ArrayList<DoubleArray>()
                    val ys = if (item.alongY) sampleExplicit(g, a, b, nx, tol, region.x0, region.x1, lines)
                              else sampleExplicit(g, a, b, nx, tol, region.y0, region.y1, lines)
                    if (!item.alongY) explicitYs[item] = ys
                    val oriented = if (item.alongY) lines.map { swapXY(it) } else lines
                    curves.add(Curve(item.row, item.color, item.dashed, oriented, item))
                    if (item.shade != 0) fills.add(Fill(item.row, item.color, oriented.map { shadePoly(it, item, region) }, null))
                }
                is PlotItem.Param -> {
                    val fx = item.fx.frame(); val fy = item.fy.frame()
                    curves.add(Curve(item.row, item.color, false, sampleParam({ t -> fx[MathEngine.ST] = t; item.fx.f(fx) }, { t -> fy[MathEngine.ST] = t; item.fy.f(fy) }, item.t0, item.t1, span), item))
                }
                is PlotItem.Polar -> {
                    val fr = item.r.frame()
                    val k = if (item.degrees) PI / 180 else 1.0
                    val rr: (Double) -> Double = { t -> fr[MathEngine.STHETA] = t; item.r.f(fr) }
                    curves.add(Curve(item.row, item.color, false, sampleParam({ t -> rr(t) * cos(t * k) }, { t -> rr(t) * sin(t * k) }, item.t0, item.t1, span), item))
                }
                is PlotItem.Point -> if (item.x.isFinite() && item.y.isFinite()) dots.add(Dot(item.row, item.color, item.x, item.y))
                is PlotItem.Implicit -> implicit(item, region, view, stale, curves, fills) ?: return null
            }
        }
        if (stale()) return null

        // Points of interest for the focused row: roots, extrema, y-intercept, intersections.
        val pois = ArrayList<Poi>()
        val focus = model.items.firstOrNull { it.row == focusRow && it is PlotItem.Explicit && !it.alongY } as PlotItem.Explicit?
        if (focus != null) {
            val ys = explicitYs[focus]
            if (ys != null) findPois(focus, ys, region, span, explicitYs, pois)
        }
        return Scene(region, view.ppu, curves, fills, dots, pois, focusRow)
    }

    private fun swapXY(a: DoubleArray): DoubleArray { val o = DoubleArray(a.size); var i = 0; while (i < a.size) { o[i] = a[i + 1]; o[i + 1] = a[i]; i += 2 }; return o }

    private fun shadePoly(line: DoubleArray, item: PlotItem.Explicit, r: Viewport): DoubleArray {
        val n = line.size / 2
        val out = DoubleArray(line.size + 4)
        val ySpan = r.y1 - r.y0; val xSpan = r.x1 - r.x0
        for (k in 0 until n) {
            out[2 * k] = line[2 * k].coerceIn(r.x0 - xSpan, r.x1 + xSpan)
            out[2 * k + 1] = line[2 * k + 1].coerceIn(r.y0 - ySpan, r.y1 + ySpan)
        }
        if (!item.alongY) {
            val edge = if (item.shade > 0) r.y1 + ySpan else r.y0 - ySpan
            out[2 * n] = line[2 * n - 2]; out[2 * n + 1] = edge
            out[2 * n + 2] = line[0]; out[2 * n + 3] = edge
        } else {
            val edge = if (item.shade > 0) r.x1 + xSpan else r.x0 - xSpan
            out[2 * n] = edge; out[2 * n + 1] = line[2 * n - 1]
            out[2 * n + 2] = edge; out[2 * n + 3] = line[1]
        }
        return out
    }

    // ---------------------------------------------------------------- explicit curves
    /** Sample g on [a, b]; returns the raw samples (for POIs) and appends polylines to [out]. */
    private fun sampleExplicit(g: (Double) -> Double, a: Double, b: Double, n: Int, tol: Double, vLo: Double, vHi: Double, out: MutableList<DoubleArray>): DoubleArray {
        val ys = DoubleArray(n + 1)
        val step = (b - a) / n
        for (i in 0..n) ys[i] = g(a + step * i)
        var cur: Poly? = null
        fun flush() { val c = cur; if (c != null && c.n >= 4) out.add(c.arr()); cur = null }
        for (i in 0..n) {
            val x = a + step * i; val y = ys[i]
            if (!y.isFinite()) {
                val c = cur
                if (c != null && i > 0) { val e = edge(g, x - step, x); if (e != null) c.add(e.first, e.second) }
                flush(); continue
            }
            if (cur == null) {
                val c = Poly()
                if (i > 0) { val e = edge(g, x, x - step); if (e != null) c.add(e.first, e.second) }
                c.add(x, y); cur = c; continue
            }
            val c = cur!!
            val x0 = x - step; val y0 = ys[i - 1]
            val offscreen = (y0 > vHi && y > vHi) || (y0 < vLo && y < vLo)
            if (abs(y - y0) > tol && !offscreen) {
                val jump = jump(g, x0, y0, x, y, tol)
                if (jump != null) {
                    c.add(jump[0], jump[1]); flush()
                    val nc = Poly(); nc.add(jump[2], jump[3]); nc.add(x, y); cur = nc
                } else {
                    for (k in 1..24) { val xs = x0 + step * k / 25; val v = g(xs); if (v.isFinite()) c.add(xs, v) }
                    c.add(x, y)
                }
            } else c.add(x, y)
        }
        flush()
        return ys
    }

    /** Last finite point between a finite sample [xf] and a non-finite one [xn] (domain edge). */
    private fun edge(g: (Double) -> Double, xf: Double, xn: Double): Pair<Double, Double>? {
        var a = xf; var b = xn; var ya = g(a)
        if (!ya.isFinite()) return null
        repeat(40) { val m = (a + b) / 2; val ym = g(m); if (ym.isFinite()) { a = m; ya = ym } else b = m }
        return a to ya
    }

    /** Bisect a big jump: a real discontinuity returns [xa, ya, xb, yb] either side of it; steep-but-continuous returns null. */
    private fun jump(g: (Double) -> Double, x0: Double, y0: Double, x1: Double, y1: Double, tol: Double): DoubleArray? {
        var xa = x0; var ya = y0; var xb = x1; var yb = y1
        repeat(44) {
            val xm = (xa + xb) / 2; val ym = g(xm)
            if (!ym.isFinite()) return doubleArrayOf(xa, ya, xb, yb)
            if (abs(ym - ya) > abs(yb - ym)) { xb = xm; yb = ym } else { xa = xm; ya = ym }
        }
        return if (abs(yb - ya) > tol * 0.05) doubleArrayOf(xa, ya, xb, yb) else null
    }

    // ---------------------------------------------------------------- parametric / polar
    private fun sampleParam(fx: (Double) -> Double, fy: (Double) -> Double, t0: Double, t1: Double, span: Double): List<DoubleArray> {
        val n = 2400
        val out = ArrayList<DoubleArray>()
        var cur: Poly? = null
        fun flush() { val c = cur; if (c != null && c.n >= 4) out.add(c.arr()); cur = null }
        var px = Double.NaN; var py = Double.NaN; var pt = t0
        val tol = span * 0.06
        for (i in 0..n) {
            val t = t0 + (t1 - t0) * i / n
            val x = fx(t); val y = fy(t)
            if (!x.isFinite() || !y.isFinite()) { flush(); px = Double.NaN; continue }
            val c = cur
            if (c == null) { val nc = Poly(); nc.add(x, y); cur = nc }
            else if (hypot(x - px, y - py) > tol) {
                // bisect: discontinuity or just fast?
                var ta = pt; var tb = t; var xa = px; var ya = py; var xb = x; var yb = y; var broken = false
                for (k in 0 until 30) {
                    val tm = (ta + tb) / 2; val xm = fx(tm); val ym = fy(tm)
                    if (!xm.isFinite() || !ym.isFinite()) { broken = true; break }
                    if (hypot(xm - xa, ym - ya) > hypot(xb - xm, yb - ym)) { tb = tm; xb = xm; yb = ym } else { ta = tm; xa = xm; ya = ym }
                }
                if (broken || hypot(xb - xa, yb - ya) > span * 1e-3) { c.add(xa, ya); flush(); val nc = Poly(); nc.add(xb, yb); nc.add(x, y); cur = nc }
                else {
                    for (k in 1..24) { val ts = pt + (t - pt) * k / 25; val xs = fx(ts); val ysv = fy(ts); if (xs.isFinite() && ysv.isFinite()) c.add(xs, ysv) }
                    c.add(x, y)
                }
            } else c.add(x, y)
            px = x; py = y; pt = t
        }
        flush()
        return out
    }

    // ---------------------------------------------------------------- implicit (marching squares)
    private fun implicit(item: PlotItem.Implicit, region: Viewport, view: Viewport, stale: () -> Boolean, curves: MutableList<Curve>, fills: MutableList<Fill>): Unit? {
        val cell = 6.0
        val cols = ceil(region.pxW / cell).toInt().coerceIn(20, 420)
        val rows = ceil(region.pxH / cell).toInt().coerceIn(20, 420)
        val dx = (region.x1 - region.x0) / cols; val dy = (region.y1 - region.y0) / rows
        val k = item.fs.size
        val frames = item.fs.map { it.frame() }
        val thetaK = if (item.degrees) 180 / PI else 1.0
        fun F(c: Int, x: Double, y: Double): Double {
            val fr = frames[c]
            fr[MathEngine.SX] = x; fr[MathEngine.SY] = y; fr[MathEngine.SR] = hypot(x, y); fr[MathEngine.STHETA] = atan2(y, x).let { if (it < 0) it + 2 * PI else it } * thetaK
            return item.fs[c].f(fr)
        }
        fun ok(c: Int, v: Double) = when (item.senses[c]) { 1 -> v > 0; 2 -> v >= 0; -1 -> v < 0; -2 -> v <= 0; else -> abs(v) < 1e-9 }
        val W = cols + 1
        val grid = Array(k) { DoubleArray(W * (rows + 1)) }
        for (j in 0..rows) {
            if (stale()) return null
            val y = region.y0 + dy * j
            for (i in 0..cols) { val x = region.x0 + dx * i; for (c in 0 until k) grid[c][j * W + i] = F(c, x, y) }
        }

        // Shading for inequalities: fill cells whose center satisfies every constraint (runs merged per row).
        if (item.senses.any { it != 0 }) {
            val rects = ArrayList<Double>()
            for (j in 0 until rows) {
                if (stale()) return null
                val yc = region.y0 + dy * (j + 0.5)
                var runStart = -1
                for (i in 0..cols) {
                    val inside = i < cols && (0 until k).all { c -> ok(c, F(c, region.x0 + dx * (i + 0.5), yc)) }
                    if (inside && runStart < 0) runStart = i
                    if (!inside && runStart >= 0) {
                        rects.add(region.x0 + dx * runStart); rects.add(region.y0 + dy * j); rects.add(region.x0 + dx * i); rects.add(region.y0 + dy * (j + 1))
                        runStart = -1
                    }
                }
            }
            fills.add(Fill(item.row, item.color, emptyList(), rects.toDoubleArray()))
        }

        // Boundary / equation contours, one constraint at a time.
        val dashed = item.senses.all { abs(it) == 1 }
        val lines = ArrayList<DoubleArray>()
        for (c in 0 until k) {
            if (stale()) return null
            val g = grid[c]
            val cache = HashMap<Int, DoubleArray>()
            fun edgePt(id: Int): DoubleArray = cache.getOrPut(id) {
                val node = id shr 1
                val i = node % W; val j = node / W
                val horiz = (id and 1) == 0
                val ax = region.x0 + dx * i; val ay = region.y0 + dy * j
                val bx = if (horiz) ax + dx else ax; val by = if (horiz) ay else ay + dy
                var va = g[node]; var vb = if (horiz) g[node + 1] else g[node + W]
                var ta = 0.0; var tb = 1.0
                var t = va / (va - vb)
                // A few Illinois (regula falsi) steps along the edge for a smoother curve.
                var side = 0
                for (it in 0 until 5) {
                    val v = F(c, ax + (bx - ax) * t, ay + (by - ay) * t)
                    if (!v.isFinite() || v == 0.0) break
                    if ((v > 0) == (va > 0)) { ta = t; va = v; if (side == -1) vb /= 2; side = -1 } else { tb = t; vb = v; if (side == 1) va /= 2; side = 1 }
                    t = ta + (tb - ta) * (va / (va - vb))
                    if (!t.isFinite()) { t = (ta + tb) / 2 }
                }
                doubleArrayOf(ax + (bx - ax) * t, ay + (by - ay) * t)
            }
            val segA = ArrayList<Int>(); val segB = ArrayList<Int>()
            for (j in 0 until rows) {
                for (i in 0 until cols) {
                    val n0 = j * W + i
                    val bl = g[n0]; val br = g[n0 + 1]; val tl = g[n0 + W]; val tr = g[n0 + W + 1]
                    if (!bl.isFinite() || !br.isFinite() || !tl.isFinite() || !tr.isFinite()) continue
                    val sbl = bl > 0; val sbr = br > 0; val stl = tl > 0; val str = tr > 0
                    if (sbl == sbr && sbr == str && str == stl) continue
                    val eB = n0 * 2; val eT = (n0 + W) * 2; val eL = n0 * 2 + 1; val eR = (n0 + 1) * 2 + 1
                    val cross = ArrayList<Int>(4)
                    if (sbl != sbr) cross.add(eB); if (sbr != str) cross.add(eR); if (str != stl) cross.add(eT); if (stl != sbl) cross.add(eL)
                    val pairs: List<Pair<Int, Int>> = if (cross.size == 2) listOf(cross[0] to cross[1]) else {
                        val center = F(c, region.x0 + dx * (i + 0.5), region.y0 + dy * (j + 0.5))
                        if ((center > 0) == sbl) listOf(eB to eR, eT to eL) else listOf(eB to eL, eR to eT)
                    }
                    val maxC = max(max(abs(bl), abs(br)), max(abs(tl), abs(tr)))
                    for ((p, q) in pairs) {
                        val a = edgePt(p); val b = edgePt(q)
                        val fm = F(c, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                        if (!fm.isFinite() || abs(fm) > maxC) continue   // a pole, not a zero crossing
                        if (k > 1) {
                            val mxp = (a[0] + b[0]) / 2; val myp = (a[1] + b[1]) / 2
                            if (!(0 until k).all { o -> o == c || ok(o, F(o, mxp, myp)) }) continue
                        }
                        segA.add(p); segB.add(q)
                    }
                }
            }
            chain(segA, segB, ::edgePt, lines)
        }
        curves.add(Curve(item.row, item.color, dashed && item.senses.isNotEmpty() && item.senses[0] != 0, lines, item))
        return Unit
    }

    /** Join marching-squares segments (keyed by shared edge ids) into polylines. */
    private fun chain(a: List<Int>, b: List<Int>, pt: (Int) -> DoubleArray, out: MutableList<DoubleArray>) {
        val n = a.size
        if (n == 0) return
        val adj = HashMap<Int, MutableList<Int>>()
        for (s in 0 until n) { adj.getOrPut(a[s]) { ArrayList(2) }.add(s); adj.getOrPut(b[s]) { ArrayList(2) }.add(s) }
        val used = BooleanArray(n)
        fun other(s: Int, e: Int) = if (a[s] == e) b[s] else a[s]
        fun walk(startEdge: Int, from: Int, into: ArrayList<Int>) {
            var e = startEdge; var s = from
            while (true) {
                val nexts = adj[e] ?: break
                val nx = nexts.firstOrNull { !used[it] && it != s } ?: break
                used[nx] = true
                e = other(nx, e); into.add(e); s = nx
            }
        }
        for (s in 0 until n) {
            if (used[s]) continue
            used[s] = true
            val fwd = ArrayList<Int>(); fwd.add(b[s]); walk(b[s], s, fwd)
            val back = ArrayList<Int>(); walk(a[s], s, back)
            val ids = ArrayList<Int>(back.size + fwd.size + 1)
            for (k in back.indices.reversed()) ids.add(back[k])
            ids.add(a[s]); ids.addAll(fwd)
            val arr = DoubleArray(ids.size * 2)
            for (k in ids.indices) { val p = pt(ids[k]); arr[2 * k] = p[0]; arr[2 * k + 1] = p[1] }
            out.add(arr)
        }
    }

    // ---------------------------------------------------------------- points of interest
    private fun findPois(f: PlotItem.Explicit, ys: DoubleArray, r: Viewport, span: Double, all: Map<PlotItem.Explicit, DoubleArray>, out: MutableList<Poi>) {
        val n = ys.size - 1
        val step = (r.x1 - r.x0) / n
        val fr = f.g.frame()
        val g: (Double) -> Double = { v -> fr[MathEngine.SX] = v; f.g.f(fr) }
        val tol = span * 0.01
        fun bisect(h: (Double) -> Double, a0: Double, b0: Double): Double {
            var a = a0; var b = b0; var ha = h(a)
            repeat(60) { val m = (a + b) / 2; val hm = h(m); if (hm == 0.0) return m; if ((hm > 0) == (ha > 0)) { a = m; ha = hm } else b = m }
            return (a + b) / 2
        }
        // roots
        for (i in 1..n) {
            val y0 = ys[i - 1]; val y1 = ys[i]
            if (!y0.isFinite() || !y1.isFinite() || abs(y1 - y0) > tol) continue
            if (y1 == 0.0) { out.add(Poi(r.x0 + step * i, 0.0)); continue }
            if (y0 != 0.0 && (y0 > 0) != (y1 > 0)) out.add(Poi(bisect(g, r.x0 + step * (i - 1), r.x0 + step * i), 0.0))
        }
        // extrema (slope sign change), refined with golden-section search
        for (i in 2..n) {
            val a = ys[i - 2]; val b = ys[i - 1]; val c = ys[i]
            if (!a.isFinite() || !b.isFinite() || !c.isFinite()) continue
            val d1 = b - a; val d2 = c - b
            if (abs(d1) > tol || abs(d2) > tol) continue
            if (d1 == 0.0 || d2 == 0.0 || (d1 > 0) == (d2 > 0)) continue
            val isMax = d1 > 0
            var lo = r.x0 + step * (i - 2); var hi = r.x0 + step * i
            val gr = (sqrt(5.0) - 1) / 2
            repeat(60) {
                val m1 = hi - gr * (hi - lo); val m2 = lo + gr * (hi - lo)
                val f1 = g(m1); val f2 = g(m2)
                if ((f1 > f2) == isMax) hi = m2 else lo = m1
            }
            val xm = (lo + hi) / 2; val ym = g(xm)
            if (ym.isFinite()) out.add(Poi(xm, ym))
        }
        // y-intercept
        if (r.x0 < 0 && r.x1 > 0) { val y0 = g(0.0); if (y0.isFinite()) out.add(Poi(0.0, y0)) }
        // intersections with the other explicit curves
        for ((o, oys) in all) {
            if (o === f || oys.size != ys.size) continue
            val ofr = o.g.frame()
            val h: (Double) -> Double = { v -> ofr[MathEngine.SX] = v; g(v) - o.g.f(ofr) }
            for (i in 1..n) {
                val h0 = ys[i - 1] - oys[i - 1]; val h1 = ys[i] - oys[i]
                if (!h0.isFinite() || !h1.isFinite() || abs(h1 - h0) > tol) continue
                if (h0 == 0.0 || (h0 > 0) == (h1 > 0)) continue
                val xi = bisect(h, r.x0 + step * (i - 1), r.x0 + step * i)
                val yi = g(xi)
                if (yi.isFinite()) out.add(Poi(xi, yi))
            }
        }
        // Drop duplicates (a root that is also an extremum / the y-intercept, …).
        val eps = span * 1e-6
        val uniq = ArrayList<Poi>()
        for (p in out) if (uniq.none { abs(it.x - p.x) <= eps && abs(it.y - p.y) <= eps }) uniq.add(p)
        out.clear(); out.addAll(uniq)
        if (out.size > 150) out.clear()   // wildly oscillating (sin(1/x)…): dots would be noise
        // Snap near-zero noise for clean labels.
        for (k in out.indices) {
            val p = out[k]
            val sx = if (abs(p.x) < 1e-10 * max(1.0, span)) 0.0 else p.x
            val sy = if (abs(p.y) < 1e-10 * max(1.0, span)) 0.0 else p.y
            if (sx != p.x || sy != p.y) out[k] = Poi(sx, sy)
        }
    }
}
