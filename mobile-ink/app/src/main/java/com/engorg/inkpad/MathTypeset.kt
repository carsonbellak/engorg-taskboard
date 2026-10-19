package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Typesets the grapher's expressions the way LaTeX would print them: built-up fractions, raised
 * exponents, radicals, |abs| bars, ∫ / Σ / Π with their limits, lim, piecewise braces, binomials,
 * Greek letters, italic variables and upright function names. It works straight from the parsed
 * [Ex] tree (so what you see is exactly what the engine understood) and draws with Canvas paths +
 * serif text — no WebView, no fonts to bundle, crisp at any size (the page cards reuse it).
 */
object MathTypeset {

    // ------------------------------------------------------------------ boxes
    /** A laid-out piece of math: [w] wide, [asc] above and [desc] below its baseline. */
    abstract class Box {
        var w = 0f; var asc = 0f; var desc = 0f
        abstract fun draw(c: Canvas, x: Float, y: Float, ink: Ink)
    }

    /** Paints shared while drawing one formula (color is set per draw). */
    class Ink(var color: Int) {
        val text = Paint(Paint.ANTI_ALIAS_FLAG)
        val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        fun prep() { text.color = color; line.color = color; fill.color = color }
    }

    private val SERIF = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
    private val SERIF_IT = Typeface.create(Typeface.SERIF, Typeface.ITALIC)
    private val measure = Paint(Paint.ANTI_ALIAS_FLAG)

    private class TextB(val s: String, val size: Float, val italic: Boolean) : Box() {
        init {
            measure.typeface = if (italic) SERIF_IT else SERIF; measure.textSize = size
            w = measure.measureText(s) + if (italic) size * 0.04f else 0f
            asc = size * 0.72f; desc = size * 0.22f
        }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            ink.text.typeface = if (italic) SERIF_IT else SERIF; ink.text.textSize = size
            c.drawText(s, x, y, ink.text)
        }
    }

    private class Space(width: Float) : Box() { init { w = width } ; override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {} }

    private class HBox(val items: List<Box>) : Box() {
        init { for (b in items) { w += b.w; asc = max(asc, b.asc); desc = max(desc, b.desc) } }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) { var px = x; for (b in items) { b.draw(c, px, y, ink); px += b.w } }
    }

    /** Rows stacked and centered (binomials, piecewise rows, Σ limits). */
    private class VStack(val rows: List<Box>, val gap: Float, val axis: Float, val leftAlign: Boolean = false) : Box() {
        val total: Float
        init {
            w = rows.maxOf { it.w }
            total = rows.sumOf { (it.asc + it.desc).toDouble() }.toFloat() + gap * (rows.size - 1)
            asc = total / 2 + axis; desc = total / 2 - axis
        }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            var top = y - asc
            for (r in rows) {
                val rx = if (leftAlign) x else x + (w - r.w) / 2
                r.draw(c, rx, top + r.asc, ink); top += r.asc + r.desc + gap
            }
        }
    }

    private class Frac(val num: Box, val den: Box, val size: Float) : Box() {
        val thick = max(1f, size * 0.055f); val gap = size * 0.14f; val axis = size * 0.27f; val pad = size * 0.12f
        init {
            w = max(num.w, den.w) + 2 * pad
            asc = axis + thick / 2 + gap + num.asc + num.desc
            desc = den.asc + den.desc + gap + thick / 2 - axis
        }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            val ly = y - axis
            ink.line.strokeWidth = thick; ink.line.strokeCap = Paint.Cap.BUTT
            c.drawLine(x + pad * 0.4f, ly, x + w - pad * 0.4f, ly, ink.line)
            ink.line.strokeCap = Paint.Cap.ROUND
            num.draw(c, x + (w - num.w) / 2, ly - thick / 2 - gap - num.desc, ink)
            den.draw(c, x + (w - den.w) / 2, ly + thick / 2 + gap + den.asc, ink)
        }
    }

    private class Scripts(val base: Box, val sup: Box?, val sub: Box?, val size: Float) : Box() {
        val supUp: Float; val subDown: Float
        init {
            supUp = if (sup != null) max(base.asc * 0.62f, size * 0.42f).let { if (sub != null) max(it, sub.asc + size * 0.2f) else it } else 0f
            subDown = if (sub != null) max(base.desc + size * 0.06f, size * 0.24f) else 0f
            w = base.w + max(sup?.w ?: 0f, sub?.w ?: 0f) + size * 0.05f
            asc = max(base.asc, if (sup != null) supUp + sup.asc else 0f)
            desc = max(base.desc, if (sub != null) subDown + sub.desc else 0f)
        }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            base.draw(c, x, y, ink)
            sup?.draw(c, x + base.w + size * 0.03f, y - supUp, ink)
            sub?.draw(c, x + base.w + size * 0.01f, y + subDown, ink)
        }
    }

    private class Sqrt(val rad: Box, val index: Box?, val size: Float) : Box() {
        val thick = max(1f, size * 0.055f); val pad = size * 0.12f
        val hook: Float; val lead: Float
        init {
            hook = size * 0.5f + (rad.asc + rad.desc) * 0.06f
            lead = if (index != null) max(0f, index.w - hook * 0.45f) else 0f
            w = lead + hook + rad.w + size * 0.12f
            asc = rad.asc + pad + thick
            desc = rad.desc + size * 0.04f
            if (index != null) asc = max(asc, (asc + desc) * 0.45f + index.asc + index.desc)
        }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            val top = y - rad.asc - pad - thick / 2; val bot = y + rad.desc
            val x0 = x + lead
            val p = Path()
            p.moveTo(x0, y - (rad.asc + rad.desc) * 0.32f)
            p.lineTo(x0 + hook * 0.22f, y - (rad.asc + rad.desc) * 0.4f)
            p.lineTo(x0 + hook * 0.5f, bot)
            p.lineTo(x0 + hook, top)
            p.lineTo(x + w - size * 0.04f, top)
            ink.line.strokeWidth = thick
            c.drawPath(p, ink.line)
            rad.draw(c, x0 + hook + size * 0.06f, y, ink)
            index?.draw(c, x, y - (rad.asc + rad.desc) * 0.42f - index.desc, ink)
        }
    }

    /** Content wrapped in stretchy delimiters drawn as paths: ( ) [ ] | | ⌊ ⌋ ⌈ ⌉ { and . (none). */
    private class Delim(val inner: Box, val left: Char, val right: Char, val size: Float) : Box() {
        val a: Float; val d: Float; val dw: Float
        init {
            a = max(inner.asc + size * 0.06f, size * 0.74f); d = max(inner.desc + size * 0.06f, size * 0.24f)
            dw = size * 0.3f + (a + d - size) * 0.06f
            w = (if (left != '.') dw else 0f) + inner.w + (if (right != '.') dw else 0f)
            asc = a; desc = d
        }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            ink.line.strokeWidth = max(1f, size * 0.06f)
            var px = x
            if (left != '.') { drawDelim(c, left, px, y - a, dw, a + d, false, ink); px += dw }
            inner.draw(c, px, y, ink); px += inner.w
            if (right != '.') drawDelim(c, right, px, y - a, dw, a + d, true, ink)
        }
    }

    private fun drawDelim(c: Canvas, ch: Char, x: Float, top: Float, w: Float, h: Float, right: Boolean, ink: Ink) {
        val bot = top + h
        // Draw the left-hand version, mirrored for the closing side.
        fun X(f: Float) = if (right) x + w * (1 - f) else x + w * f
        val p = Path()
        when (ch) {
            '(', ')' -> { p.moveTo(X(0.78f), top); p.cubicTo(X(0.12f), top + h * 0.2f, X(0.12f), bot - h * 0.2f, X(0.78f), bot) }
            '[', ']' -> { p.moveTo(X(0.8f), top); p.lineTo(X(0.32f), top); p.lineTo(X(0.32f), bot); p.lineTo(X(0.8f), bot) }
            '|' -> { p.moveTo(X(0.5f), top); p.lineTo(X(0.5f), bot) }
            '⌊', '⌋' -> { p.moveTo(X(0.32f), top); p.lineTo(X(0.32f), bot); p.lineTo(X(0.8f), bot) }
            '⌈', '⌉' -> { p.moveTo(X(0.8f), top); p.lineTo(X(0.32f), top); p.lineTo(X(0.32f), bot) }
            '{', '}' -> {
                val m = (top + bot) / 2
                p.moveTo(X(0.85f), top)
                p.cubicTo(X(0.45f), top, X(0.5f), top + h * 0.05f, X(0.5f), top + h * 0.2f)
                p.lineTo(X(0.5f), m - h * 0.1f)
                p.cubicTo(X(0.5f), m - h * 0.02f, X(0.35f), m, X(0.12f), m)
                p.cubicTo(X(0.35f), m, X(0.5f), m + h * 0.02f, X(0.5f), m + h * 0.1f)
                p.lineTo(X(0.5f), bot - h * 0.2f)
                p.cubicTo(X(0.5f), bot - h * 0.05f, X(0.45f), bot, X(0.85f), bot)
            }
        }
        c.drawPath(p, ink.line)
    }

    /** Σ, Π (limits above and below) or ∫ (limits as scripts), drawn as paths. */
    private class BigOp(val kind: Char, val under: Box?, val over: Box?, val size: Float) : Box() {
        val symW: Float; val symA: Float; val symD: Float
        init {
            if (kind == '∫') {
                symW = size * 0.62f; symA = size * 1.02f; symD = size * 0.42f
                val sup = over?.w ?: 0f; val sub = under?.w ?: 0f
                w = symW + max(sup, sub) + size * 0.12f
                asc = max(symA, if (over != null) symA * 0.78f + over.asc else 0f)
                desc = max(symD, if (under != null) symD * 0.7f + under.desc + under.asc * 0.4f else 0f)
            } else {
                symW = size * 0.95f; symA = size * 0.86f; symD = size * 0.3f
                val gap = size * 0.12f
                w = max(symW, max(under?.w ?: 0f, over?.w ?: 0f)) + size * 0.12f
                asc = symA + (if (over != null) gap + over.asc + over.desc else 0f)
                desc = symD + (if (under != null) gap + under.asc + under.desc else 0f)
            }
        }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            val p = Path()
            if (kind == '∫') {
                val top = y - symA; val bot = y + symD
                val l = x + size * 0.05f; val r = x + symW - size * 0.05f
                p.moveTo(r, top + size * 0.12f)
                p.cubicTo(r - size * 0.06f, top - size * 0.02f, r - size * 0.2f, top - size * 0.02f, (l + r) / 2 + size * 0.03f, top + size * 0.25f)
                p.lineTo((l + r) / 2 - size * 0.03f, bot - size * 0.25f)
                p.cubicTo(l + size * 0.2f, bot + size * 0.02f, l + size * 0.06f, bot + size * 0.02f, l, bot - size * 0.12f)
                ink.line.strokeWidth = size * 0.075f
                c.drawPath(p, ink.line)
                over?.draw(c, x + symW + size * 0.02f, y - symA * 0.78f, ink)
                under?.draw(c, x + symW - size * 0.12f, y + symD * 0.7f + (under.asc * 0.4f), ink)
                return
            }
            val cx = x + w / 2
            val top = y - symA; val bot = y + symD
            val l = cx - symW / 2; val r = cx + symW / 2
            if (kind == 'Σ') {
                p.moveTo(r, top + size * 0.14f); p.lineTo(r, top); p.lineTo(l, top); p.lineTo(cx - size * 0.02f, (top + bot) / 2)
                p.lineTo(l, bot); p.lineTo(r, bot); p.lineTo(r, bot - size * 0.14f)
            } else {
                p.moveTo(l - size * 0.04f, top); p.lineTo(r + size * 0.04f, top)
                p.moveTo(l + size * 0.14f, top); p.lineTo(l + size * 0.14f, bot)
                p.moveTo(r - size * 0.14f, top); p.lineTo(r - size * 0.14f, bot)
            }
            ink.line.strokeWidth = size * 0.07f
            c.drawPath(p, ink.line)
            val gap = size * 0.12f
            over?.draw(c, cx - over.w / 2, top - gap - over.desc, ink)
            under?.draw(c, cx - under.w / 2, bot + gap + under.asc, ink)
        }
    }

    /** "lim" with "x→a" set underneath. */
    private class Under(val head: Box, val below: Box, val size: Float) : Box() {
        init { w = max(head.w, below.w); asc = head.asc; desc = head.desc + size * 0.1f + below.asc + below.desc }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            head.draw(c, x + (w - head.w) / 2, y, ink)
            below.draw(c, x + (w - below.w) / 2, y + head.desc + size * 0.1f + below.asc, ink)
        }
    }

    /** An evaluation bar: content|_{sub}. */
    private class EvalBar(val inner: Box, val sub: Box, val size: Float) : Box() {
        init { w = inner.w + size * 0.2f + sub.w; asc = inner.asc + size * 0.05f; desc = max(inner.desc + size * 0.05f, inner.desc * 0.5f + sub.asc + sub.desc) }
        override fun draw(c: Canvas, x: Float, y: Float, ink: Ink) {
            inner.draw(c, x, y, ink)
            val bx = x + inner.w + size * 0.08f
            ink.line.strokeWidth = max(1f, size * 0.055f)
            c.drawLine(bx, y - asc, bx, y + desc, ink.line)
            sub.draw(c, bx + size * 0.1f, y + desc - sub.desc, ink)
        }
    }

    // ------------------------------------------------------------------ Ex → boxes
    private const val P_CMP = 0; private const val P_SUM = 1; private const val P_PROD = 2; private const val P_NEG = 3
    private const val P_POW = 4; private const val P_ATOM = 5

    private val GREEK = mapOf(
        "alpha" to "α", "beta" to "β", "gamma" to "γ", "delta" to "δ", "epsilon" to "ε", "varepsilon" to "ε", "zeta" to "ζ",
        "eta" to "η", "theta" to "θ", "iota" to "ι", "kappa" to "κ", "lambda" to "λ", "mu" to "μ", "nu" to "ν", "xi" to "ξ",
        "pi" to "π", "rho" to "ρ", "sigma" to "σ", "tau" to "τ", "upsilon" to "υ", "phi" to "φ", "varphi" to "φ", "chi" to "χ",
        "psi" to "ψ", "omega" to "ω", "egamma" to "γ",
        "Gamma" to "Γ", "Delta" to "Δ", "Theta" to "Θ", "Lambda" to "Λ", "Xi" to "Ξ", "Pi" to "Π", "Sigma" to "Σ",
        "Phi" to "Φ", "Psi" to "Ψ", "Omega" to "Ω",
    )
    private val TRIG = setOf("sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh", "sech", "csch", "coth")
    private val INVERSE_OF = mapOf(
        "asin" to "sin", "acos" to "cos", "atan" to "tan", "asec" to "sec", "acsc" to "csc", "acot" to "cot",
        "asinh" to "sinh", "acosh" to "cosh", "atanh" to "tanh", "asech" to "sech", "acsch" to "csch", "acoth" to "coth",
    )
    private val SPECIAL_NAMES = mapOf(
        "gamma" to "Γ", "digamma" to "ψ", "zeta" to "ζ", "lgamma" to "ln Γ", "lambertw" to "W", "ellipk" to "K", "ellipe" to "E",
        "fresnels" to "S", "fresnelc" to "C", "airyai" to "Ai", "airybi" to "Bi", "si" to "Si", "ci" to "Ci", "ei" to "Ei", "li" to "li",
    )

    private class Ctx(val size: Float, val fracDepth: Int = 0) {
        fun script() = Ctx(max(size * 0.7f, 7f), fracDepth)
        fun inFrac() = Ctx(if (fracDepth >= 1) max(size * 0.85f, 7f) else size, fracDepth + 1)
    }

    private fun txt(s: String, ctx: Ctx, italic: Boolean = false): Box = TextB(s, ctx.size, italic)
    private fun op(s: String, ctx: Ctx, wide: Boolean = true): Box =
        if (wide) HBox(listOf(Space(ctx.size * 0.22f), txt(s, ctx), Space(ctx.size * 0.22f))) else txt(s, ctx)
    private fun row(vararg b: Box) = HBox(b.toList())

    private fun prec(e: Ex): Int = when (e) {
        is Ex.Num -> if (e.v < 0) P_NEG else P_ATOM
        is Ex.Var, is Ex.Tuple, is Ex.Piece -> P_ATOM
        is Ex.Neg -> P_NEG
        is Ex.Bin -> when (e.op) { "+", "-" -> P_SUM; "*", "/", "%" -> P_PROD; "^" -> P_POW; else -> P_CMP }
        is Ex.Chain -> P_CMP
        is Ex.Deriv -> P_PROD
        is Ex.Call -> when (MathEngine.canonical(e.name)) {
            "int", "integral", "sum", "prod", "lim", "limit", "deriv", "diff" -> P_PROD
            "mod" -> P_PROD
            else -> P_ATOM
        }
    }

    private fun paren(b: Box, ctx: Ctx) = Delim(b, '(', ')', ctx.size)
    private fun boxP(e: Ex, ctx: Ctx, minPrec: Int): Box { val b = box(e, ctx); return if (prec(e) < minPrec) paren(b, ctx) else b }

    private fun num(v: Double, ctx: Ctx): Box {
        if (v.isNaN()) return txt("undefined", ctx)
        if (v.isInfinite()) return txt(if (v > 0) "∞" else "−∞", ctx)
        val a = abs(v)
        if (a != 0.0 && (a >= 1e15 || a < 1e-6)) {
            val ex = floor(Math.log10(a)).toInt(); val m = v / Math.pow(10.0, ex.toDouble())
            val ms = java.math.BigDecimal(m).round(java.math.MathContext(8)).stripTrailingZeros().toPlainString().replace("-", "−")
            return row(txt("$ms×10", ctx), Scripts(Space(0f), txt(ex.toString().replace("-", "−"), ctx.script()), null, ctx.size))
        }
        val s = if (v == floor(v) && a < 1e15) v.toLong().toString() else java.math.BigDecimal(v.toString()).stripTrailingZeros().toPlainString()
        return txt(s.replace("-", "−"), ctx)
    }

    /** A variable name: Greek letters, ∞, subscripts after "_" (v_0 → v₀), italic otherwise. */
    private fun name(n: String, ctx: Ctx, italic: Boolean = true): Box {
        if (n == "inf" || n == "infinity") return txt("∞", ctx)
        val us = n.indexOf('_')
        if (us > 0 && us < n.length - 1) return Scripts(name(n.substring(0, us), ctx, italic), null, name(n.substring(us + 1), ctx.script(), italic), ctx.size)
        GREEK[n]?.let { g -> return txt(g, ctx, italic && g.first().isLowerCase()) }
        return txt(n, ctx, italic)
    }

    private fun fnName(n: String, ctx: Ctx): Box = txt(n, ctx)

    /** f(args) with an upright (built-in) or italic (user) name, optional superscript on the name. */
    private fun call(head: Box, args: List<Ex>, ctx: Ctx, bareOk: Boolean): Box {
        if (bareOk && args.size == 1 && (args[0] is Ex.Var || (args[0] is Ex.Num && (args[0] as Ex.Num).v >= 0)))
            return row(head, Space(ctx.size * 0.16f), box(args[0], ctx))
        return row(head, paren(list(args, ctx), ctx))
    }

    private fun list(items: List<Ex>, ctx: Ctx): Box {
        val out = ArrayList<Box>()
        items.forEachIndexed { i, a -> if (i > 0) { out.add(txt(",", ctx)); out.add(Space(ctx.size * 0.2f)) }; out.add(box(a, ctx)) }
        return HBox(out)
    }

    private fun cmpSym(op: String) = when (op) { "<=" -> "≤"; ">=" -> "≥"; "!=" -> "≠"; "==" -> "="; else -> op }

    private fun box(e: Ex, ctx: Ctx): Box = when (e) {
        is Ex.Num -> num(e.v, ctx)
        is Ex.Var -> name(e.name, ctx)
        is Ex.Neg -> row(txt("−", ctx), boxP(e.a, ctx, P_PROD))
        is Ex.Tuple -> paren(list(e.items, ctx), ctx)
        is Ex.Chain -> {
            val out = ArrayList<Box>()
            e.items.forEachIndexed { i, it -> if (i > 0) out.add(op(cmpSym(e.ops[i - 1]), ctx)); out.add(box(it, ctx)) }
            HBox(out)
        }
        is Ex.Piece -> piece(e, ctx)
        is Ex.Deriv -> row(Frac(txt("d", ctx), row(txt("d", ctx), name(e.v, ctx)), ctx.size), Space(ctx.size * 0.08f), boxP(e.a, ctx, P_ATOM))
        is Ex.Bin -> bin(e, ctx)
        is Ex.Call -> callBox(e, ctx)
    }

    private fun bin(e: Ex.Bin, ctx: Ctx): Box = when (e.op) {
        "+" -> row(boxP(e.a, ctx, P_SUM), op("+", ctx), boxP(e.b, ctx, if (e.b is Ex.Neg) P_ATOM else P_SUM))
        "-" -> row(boxP(e.a, ctx, P_SUM), op("−", ctx), boxP(e.b, ctx, P_PROD))
        "*" -> {
            val l = boxP(e.a, ctx, P_PROD); val r = boxP(e.b, ctx, if (e.b is Ex.Neg) P_ATOM else P_PROD)
            // Juxtapose like handwriting (2x, xy, 3 sin x) unless a number would run into the left factor.
            val rightNum = leading(e.b) is Ex.Num
            val sep: Box = when {
                rightNum -> op("·", ctx)
                leading(e.b) is Ex.Call && prec(leading(e.b)) == P_ATOM && !isUserCall(leading(e.b)) -> Space(ctx.size * 0.14f)
                else -> Space(ctx.size * 0.05f)
            }
            row(l, sep, r)
        }
        "/" -> { val f = ctx.inFrac(); Frac(box(e.a, f), box(e.b, f), ctx.size) }
        "%" -> row(boxP(e.a, ctx, P_PROD), op("mod", ctx), boxP(e.b, ctx, P_POW))
        "^" -> power(e, ctx)
        else -> row(box(e.a, ctx), op(cmpSym(e.op), ctx), box(e.b, ctx))
    }

    private fun leading(e: Ex): Ex = when (e) {
        is Ex.Bin -> if (e.op == "*" || e.op == "^") leading(e.a) else e
        else -> e
    }
    private fun isUserCall(e: Ex) = e is Ex.Call && !MathEngine.isBuiltinFn(e.name)

    private fun power(e: Ex.Bin, ctx: Ctx): Box {
        val b = e.a
        // (sin x)^2 prints as sin²x, the way it's written by hand.
        if (b is Ex.Call && MathEngine.canonical(b.name) in TRIG && b.primes == 0) {
            val head = Scripts(fnName(MathEngine.canonical(b.name), ctx), box(e.b, ctx.script()), null, ctx.size)
            return call(head, b.args, ctx, bareOk = true)
        }
        // A fraction, root or call base keeps its own grouping; anything looser gets parentheses.
        val base = when {
            b is Ex.Bin && b.op == "/" -> paren(box(b, ctx), ctx)
            else -> boxP(b, ctx, P_ATOM)
        }
        return Scripts(base, box(e.b, ctx.script()), null, ctx.size)
    }

    private fun callBox(e: Ex.Call, ctx: Ctx): Box {
        val c = MathEngine.canonical(e.name)
        val a = e.args
        if (!MathEngine.isBuiltinFn(e.name) || e.primes > 0) {
            val head = if (e.primes > 0) row(name(e.name, ctx), txt("′".repeat(e.primes), ctx)) else name(e.name, ctx)
            return row(head, paren(list(a, ctx), ctx))
        }
        INVERSE_OF[c]?.let { base -> return call(Scripts(fnName(base, ctx), txt("−1", ctx.script()), null, ctx.size), a, ctx, bareOk = true) }
        return when (c) {
            in TRIG, "ln" -> call(fnName(c, ctx), a, ctx, bareOk = true)
            "sqrt" -> if (a.size == 1) Sqrt(box(a[0], ctx), null, ctx.size) else generic(c, a, ctx)
            "cbrt" -> if (a.size == 1) Sqrt(box(a[0], ctx), txt("3", ctx.script().script()), ctx.size) else generic(c, a, ctx)
            "root" -> if (a.size == 2) Sqrt(box(a[0], ctx), box(a[1], ctx.script().script()), ctx.size) else generic(c, a, ctx)
            "abs" -> if (a.size == 1) Delim(box(a[0], ctx), '|', '|', ctx.size) else generic(c, a, ctx)
            "floor" -> if (a.size == 1) Delim(box(a[0], ctx), '⌊', '⌋', ctx.size) else generic(c, a, ctx)
            "ceil" -> if (a.size == 1) Delim(box(a[0], ctx), '⌈', '⌉', ctx.size) else generic(c, a, ctx)
            "exp" -> if (a.size == 1) Scripts(txt("e", ctx, true), box(a[0], ctx.script()), null, ctx.size) else generic(c, a, ctx)
            "log10" -> call(Scripts(fnName("log", ctx), null, txt("10", ctx.script()), ctx.size), a, ctx, bareOk = true)
            "log2" -> call(Scripts(fnName("log", ctx), null, txt("2", ctx.script()), ctx.size), a, ctx, bareOk = true)
            "log" -> if (a.size == 2) call(Scripts(fnName("log", ctx), null, box(a[1], ctx.script()), ctx.size), a.take(1), ctx, bareOk = true)
                     else call(fnName("log", ctx), a, ctx, bareOk = true)
            "logb" -> if (a.size == 2) call(Scripts(fnName("log", ctx), null, box(a[0], ctx.script()), ctx.size), a.drop(1), ctx, bareOk = true) else generic(c, a, ctx)
            "factorial" -> if (a.size == 1) row(boxP(a[0], ctx, P_ATOM), txt("!", ctx)) else generic(c, a, ctx)
            "ncr" -> if (a.size == 2) Delim(VStack(listOf(box(a[0], ctx.script()), box(a[1], ctx.script())), ctx.size * 0.12f, ctx.size * 0.27f), '(', ')', ctx.size)
                     else generic(c, a, ctx)
            "mod" -> if (a.size == 2) row(boxP(a[0], ctx, P_PROD), op("mod", ctx), boxP(a[1], ctx, P_POW)) else generic(c, a, ctx)
            "besselj", "bessely", "besseli", "besselk" -> if (a.size == 2) {
                val letter = when (c) { "besselj" -> "J"; "bessely" -> "Y"; "besseli" -> "I"; else -> "K" }
                row(Scripts(txt(letter, ctx, true), null, box(a[0], ctx.script()), ctx.size), paren(box(a[1], ctx), ctx))
            } else generic(c, a, ctx)
            "int", "integral" -> integral(e, ctx)
            "sum", "prod" -> if (a.size == 4) {
                val under = row(box(a[1], ctx.script()), txt("=", ctx.script()), box(a[2], ctx.script()))
                row(BigOp(if (c == "sum") 'Σ' else 'Π', under, box(a[3], ctx.script()), ctx.size), Space(ctx.size * 0.1f), boxP(a[0], ctx, P_PROD))
            } else generic(c, a, ctx)
            "lim", "limit" -> if (a.size == 3) {
                val under = row(box(a[1], ctx.script()), txt("→", ctx.script()), box(a[2], ctx.script()))
                row(Under(fnName("lim", ctx), under, ctx.size), Space(ctx.size * 0.18f), boxP(a[0], ctx, P_PROD))
            } else generic(c, a, ctx)
            "deriv", "diff" -> if (a.size >= 2 && a[1] is Ex.Var) {
                val d = row(Frac(txt("d", ctx), row(txt("d", ctx), box(a[1], ctx)), ctx.size), Space(ctx.size * 0.08f), boxP(a[0], ctx, P_ATOM))
                if (a.size == 3) EvalBar(d, row(box(a[1], ctx.script()), txt("=", ctx.script()), box(a[2], ctx.script())), ctx.size) else d
            } else generic(c, a, ctx)
            "if" -> if (a.size >= 2) piece(Ex.Piece(listOf(a[0] to a[1]), a.getOrNull(2)), ctx) else generic(c, a, ctx)
            else -> SPECIAL_NAMES[c]?.let { call(txt(it, ctx), a, ctx, bareOk = false) } ?: generic(c, a, ctx)
        }
    }

    private fun generic(name: String, args: List<Ex>, ctx: Ctx) = call(fnName(name, ctx), args, ctx, bareOk = false)

    /** ∫ₐᵇ f dx; nested integrals collect as ∫∫∫ f dz dy dx (innermost differential first). */
    private fun integral(e: Ex.Call, ctx: Ctx): Box {
        val signs = ArrayList<Box>(); val diffs = ArrayList<Box>()
        var cur: Ex = e
        while (cur is Ex.Call && MathEngine.canonical(cur.name).let { it == "int" || it == "integral" } && (cur.args.size == 4 || cur.args.size == 3)) {
            val a = cur.args
            val v: Ex; val lo: Ex; val hi: Ex
            if (a.size == 4) { v = a[1]; lo = a[2]; hi = a[3] } else { v = Ex.Var(if (MathEngine.mentions(a[0], "t")) "t" else "x"); lo = a[1]; hi = a[2] }
            signs.add(BigOp('∫', box(lo, ctx.script()), box(hi, ctx.script()), ctx.size))
            diffs.add(0, row(Space(ctx.size * 0.16f), txt("d", ctx), box(v, ctx)))
            cur = a[0]
        }
        val out = ArrayList<Box>()
        out.addAll(signs); out.add(Space(ctx.size * 0.06f)); out.add(boxP(cur, ctx, P_PROD)); out.addAll(diffs)
        return HBox(out)
    }

    private fun piece(e: Ex.Piece, ctx: Ctx): Box {
        // {x > 0} on its own is a domain restriction: show it as braces around the condition.
        if (e.otherwise == null && e.cases.all { it.second == null })
            return Delim(list(e.cases.map { it.first }, ctx), '{', '}', ctx.size)
        val rows = ArrayList<Box>()
        for ((cond, v) in e.cases) rows.add(row(if (v != null) box(v, ctx) else txt("1", ctx), Space(ctx.size * 0.6f), txt("if", ctx), Space(ctx.size * 0.3f), box(cond, ctx)))
        e.otherwise?.let { rows.add(row(box(it, ctx), Space(ctx.size * 0.6f), txt("otherwise", ctx))) }
        return Delim(VStack(rows, ctx.size * 0.22f, ctx.size * 0.27f, leftAlign = true), '{', '.', ctx.size)
    }

    // ------------------------------------------------------------------ public API
    /** Lay out a parsed line (lhs or lhs = rhs) at font [size] px. */
    fun layout(st: MathEngine.Statement, size: Float): Box {
        val ctx = Ctx(size)
        return if (st.rhs == null) box(st.lhs, ctx) else row(box(st.lhs, ctx), op("=", ctx), box(st.rhs, ctx))
    }

    /** Draw [b] with its left edge at [x] and baseline at [y]. */
    fun draw(c: Canvas, b: Box, x: Float, y: Float, color: Int) {
        val ink = Ink(color); ink.prep(); b.draw(c, x, y, ink)
    }

    /** Lay out and draw a line of math scaled to fit inside [r] (left-aligned, vertically centered). */
    fun drawFitted(c: Canvas, st: MathEngine.Statement, r: RectF, size: Float, color: Int) {
        val b = layout(st, size)
        val k = min(1f, min(r.width() / max(1f, b.w), r.height() / max(1f, b.asc + b.desc)))
        c.save()
        c.translate(r.left, r.centerY() + (b.asc - b.desc) * k / 2)
        c.scale(k, k)
        draw(c, b, 0f, 0f, color)
        c.restore()
    }
}

/**
 * A single typeset line of math (see [MathTypeset]). Shows [fallback] as plain text when the line
 * doesn't parse, so a half-typed expression never vanishes.
 */
@SuppressLint("ViewConstructor")
class MathView(context: Context) : View(context) {
    private var box: MathTypeset.Box? = null
    private var fallback = ""
    var color = Color.BLACK
        set(v) { field = v; invalidate() }
    var size = 40f
        set(v) { field = v; relayout() }
    private var st: MathEngine.Statement? = null
    private val pad get() = size * 0.25f
    private val plain = Paint(Paint.ANTI_ALIAS_FLAG)

    fun set(statement: MathEngine.Statement?, fallbackText: String) {
        st = statement; fallback = fallbackText
        relayout()
    }

    private fun relayout() {
        box = st?.let { runCatching { MathTypeset.layout(it, size) }.getOrNull() }
        requestLayout(); invalidate()
    }

    override fun onMeasure(wSpec: Int, hSpec: Int) {
        val b = box
        val w: Float; val h: Float
        if (b != null) { w = b.w + 2 * pad; h = max(b.asc + b.desc, size * 1.0f) + 2 * pad }
        else { plain.textSize = size * 0.9f; w = plain.measureText(fallback) + 2 * pad; h = size * 1.2f + 2 * pad }
        setMeasuredDimension(resolveSize(w.toInt() + 1, wSpec), resolveSize(h.toInt() + 1, hSpec))
    }

    override fun onDraw(c: Canvas) {
        val b = box
        if (b != null) {
            val hgt = b.asc + b.desc
            val y = (height - hgt) / 2f + b.asc
            MathTypeset.draw(c, b, pad, y, color)
        } else {
            plain.color = color; plain.textSize = size * 0.9f
            c.drawText(fallback, pad, height / 2f + plain.textSize * 0.35f, plain)
        }
    }
}

/**
 * Pasted LaTeX → the grapher's plain syntax: \frac{a}{b}, \sqrt[n]{x}, \cdot, \times, \left( \right),
 * Greek letters, \sin…, x_{1}, ^{…}, \le \ge \ne, \infty, \int_a^b … dx, \sum_{n=1}^{N} ….
 * Anything it doesn't know passes through as a word, so the parser's own errors still explain it.
 */
object Latex {
    private val WORDS = mapOf(
        "cdot" to "*", "times" to "*", "div" to "/", "le" to "<=", "leq" to "<=", "ge" to ">=", "geq" to ">=",
        "ne" to "!=", "neq" to "!=", "infty" to "inf", "lt" to "<", "gt" to ">",
        "left" to "", "right" to "", "displaystyle" to "", "limits" to "", "," to " ", ";" to " ", ":" to " ", "!" to "",
        "quad" to " ", "qquad" to " ", " " to " ", "{" to "{", "}" to "}", "|" to "|",
        "arcsin" to "asin", "arccos" to "acos", "arctan" to "atan",
    )

    fun toPlain(src: String): String = Conv(src).run(src.length)

    private class Conv(val s: String) {
        var i = 0
        val sb = StringBuilder()

        fun skipSpace() { while (i < s.length && s[i] == ' ') i++ }

        /** A {group} (converted) or a single token. */
        fun group(): String {
            skipSpace()
            if (i >= s.length) return ""
            if (s[i] == '{') {
                val end = match(i)
                val inner = Conv(s.substring(i + 1, end)).run(end - i - 1)
                i = end + 1
                return inner
            }
            if (s[i] == '\\') {
                val save = sb.length
                command()
                val out = sb.substring(save); sb.setLength(save)
                return out
            }
            return s[i++].toString()
        }

        fun match(open: Int): Int {
            var depth = 0
            for (k in open until s.length) {
                if (s[k] == '{' && (k == 0 || s[k - 1] != '\\')) depth++
                else if (s[k] == '}' && (k == 0 || s[k - 1] != '\\')) { depth--; if (depth == 0) return k }
            }
            return s.length - 1
        }

        /** Optional _{lo} and ^{hi} after a big operator, in either order. */
        fun limits(): Pair<String?, String?> {
            var lo: String? = null; var hi: String? = null
            repeat(2) {
                skipSpace()
                if (i < s.length && s[i] == '_') { i++; lo = group() }
                else if (i < s.length && s[i] == '^') { i++; hi = group() }
            }
            return lo to hi
        }

        fun command() {
            i++ // backslash
            val st = i
            if (i < s.length && s[i].isLetter()) { while (i < s.length && s[i].isLetter()) i++ } else i++
            val cmd = s.substring(st, i)
            when (cmd) {
                "frac", "dfrac", "tfrac" -> { val a = group(); val b = group(); sb.append("(($a)/($b))") }
                "sqrt" -> {
                    skipSpace()
                    var n: String? = null
                    if (i < s.length && s[i] == '[') { val e = s.indexOf(']', i).let { if (it < 0) s.length - 1 else it }; n = Conv(s.substring(i + 1, e)).run(e - i - 1); i = e + 1 }
                    val a = group()
                    sb.append(if (n != null) "root($a, $n)" else "sqrt($a)")
                }
                "operatorname", "mathrm", "mathit", "mathbf", "text", "textrm" -> sb.append(' ').append(group()).append(' ')
                "int", "iint", "iiint" -> integral()
                "sum", "prod" -> {
                    val (lo, hi) = limits()
                    val eq = lo?.indexOf('=') ?: -1
                    val body = Conv(s.substring(i)).run(s.length - i); i = s.length
                    if (lo != null && hi != null && eq > 0) sb.append("$cmd($body, ${lo.substring(0, eq).trim()}, ${lo.substring(eq + 1)}, $hi)")
                    else sb.append(" $cmd $body")
                }
                else -> {
                    val w = WORDS[cmd]
                    if (w != null) {
                        // "\left." is an invisible delimiter.
                        if (cmd == "left" || cmd == "right") { if (i < s.length && s[i] == '.') i++ }
                        sb.append(w)
                    } else sb.append(' ').append(cmd).append(' ')
                }
            }
        }

        /** \int_a^b body dx  →  int(body, x, a, b) (the differential closes the body). */
        fun integral() {
            val (lo, hi) = limits()
            val rest = s.substring(i)
            val m = Regex("""(\\[,;!]|\s)*\bd([a-zA-Z])\b""").findAll(rest).lastOrNull()
            if (m == null || lo == null || hi == null) { sb.append(" int "); return }
            val body = Conv(rest.substring(0, m.range.first)).run(m.range.first)
            sb.append("int($body, ${m.groupValues[2]}, $lo, $hi)")
            i += m.range.last + 1
        }

        fun run(end: Int): String {
            while (i < end && i < s.length) {
                val c = s[i]
                when {
                    c == '\\' -> command()
                    c == '{' -> { sb.append('('); i++ }
                    c == '}' -> { sb.append(')'); i++ }
                    c == '_' -> {
                        // A subscript joins the name before it (\theta_{0} → theta_0), so drop the gap.
                        while (sb.isNotEmpty() && sb.last() == ' ') sb.setLength(sb.length - 1)
                        i++
                        if (i < s.length && s[i] == '{') sb.append('_').append(group().filter { it.isLetterOrDigit() })
                        else sb.append('_')
                    }
                    else -> { sb.append(c); i++ }
                }
            }
            return sb.toString()
        }
    }
}
