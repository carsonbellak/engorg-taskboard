package com.engorg.inkpad

import kotlin.math.E
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.acosh
import kotlin.math.asin
import kotlin.math.asinh
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.atanh
import kotlin.math.cbrt
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.cosh
import kotlin.math.exp
import kotlin.math.expm1
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.ln1p
import kotlin.math.log10
import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sign
import kotlin.math.sin
import kotlin.math.sinh
import kotlin.math.sqrt
import kotlin.math.tan
import kotlin.math.tanh
import kotlin.math.truncate

/**
 * The grapher's math engine: a Desmos-style expression language parsed into an [Ex] tree and
 * compiled to plain closures ([Fx]) that evaluate against a slot frame (a DoubleArray holding the
 * plot variables x, y, t, theta, r plus any bound variables of sums / integrals / limits).
 *
 * Syntax highlights: implicit multiplication (2x, 3sin x, (x+1)(x-1), xy), ^ powers, ! factorial,
 * |x| absolute value, {cond: a, b} piecewise and {x>0} domain restrictions, a<x<b chains,
 * f(x)= user functions with f'(x) derivatives, d/dx(...), sin^2 x, sin^-1 x, log_2 x, unicode
 * (π θ √ ≤ ≥ ² ³ ∞ × ÷ −). Everything evaluates over the reals; undefined results are NaN.
 *
 * Compiled closures are immutable apart from the frame they're given, so one compiled expression
 * can be evaluated from a background thread as long as each thread uses its own frame.
 */
class MathError(message: String) : Exception(message)

typealias Fx = (DoubleArray) -> Double

/** Expression tree produced by the parser. */
sealed class Ex {
    class Num(val v: Double) : Ex()
    class Var(val name: String) : Ex()
    class Neg(val a: Ex) : Ex()
    class Bin(val op: String, val a: Ex, val b: Ex) : Ex()
    class Chain(val items: List<Ex>, val ops: List<String>) : Ex()
    class Call(val name: String, val args: List<Ex>, val primes: Int = 0) : Ex()
    class Tuple(val items: List<Ex>) : Ex()
    class Piece(val cases: List<Pair<Ex, Ex?>>, val otherwise: Ex?) : Ex()
    class Deriv(val v: String, val a: Ex) : Ex()
}

/** A user function: `name(params) = body`. Compiled lazily (with cycle detection) on first call. */
class UserFn(val name: String, val params: List<String>, val body: Ex) {
    internal var code: Fx? = null
    internal var slots = 0
    internal var busy = false
}

/** Everything an expression can reference besides its own variables. */
class MathEnv(val degrees: Boolean) {
    val consts = HashMap<String, Double>()
    val fns = HashMap<String, UserFn>()
}

class Compiled(val f: Fx, val nSlots: Int) {
    fun frame() = DoubleArray(nSlots.coerceAtLeast(1))
}

object MathEngine {
    /** Plot variables, always slots 0..4 of a top-level frame. */
    val PLOT_VARS = listOf("x", "y", "t", "theta", "r")
    const val SX = 0; const val SY = 1; const val ST = 2; const val STHETA = 3; const val SR = 4
    /** The 3D grapher's variables: the 2D ones (same slots) plus z and the surface parameters u, v. */
    val PLOT_VARS_3D = PLOT_VARS + listOf("z", "u", "v")
    const val SZ = 5; const val SU = 6; const val SV = 7

    const val EULER_GAMMA = 0.5772156649015329
    val CONSTANTS: Map<String, Double> = mapOf(
        "pi" to PI, "e" to E, "tau" to 2 * PI, "phi" to (1 + sqrt(5.0)) / 2,
        "inf" to Double.POSITIVE_INFINITY, "infinity" to Double.POSITIVE_INFINITY, "egamma" to EULER_GAMMA,
    )
    private val CMP = setOf("<", "<=", ">", ">=", "==", "!=")
    val BINDERS = setOf("sum", "prod", "int", "integral", "int2", "int3", "deriv", "diff", "lim", "limit", "if")

    // ---------------------------------------------------------------- function table
    private class Fn(
        val min: Int, val max: Int, val trigIn: Boolean, val trigOut: Boolean,
        val one: ((Double) -> Double)?, val two: ((Double, Double) -> Double)?, val many: (DoubleArray) -> Double,
    )
    private val FNS = HashMap<String, Fn>()
    private val ALIAS = HashMap<String, String>()

    private fun f1(name: String, trigIn: Boolean = false, trigOut: Boolean = false, g: (Double) -> Double) {
        FNS[name] = Fn(1, 1, trigIn, trigOut, g, null) { g(it[0]) }
    }
    private fun f2(name: String, g: (Double, Double) -> Double) {
        FNS[name] = Fn(2, 2, false, false, null, g) { g(it[0], it[1]) }
    }
    private fun fv(name: String, min: Int, max: Int, trigOut: Boolean = false, g: (DoubleArray) -> Double) {
        FNS[name] = Fn(min, max, false, trigOut, null, null, g)
    }
    private fun alias(target: String, vararg names: String) { for (n in names) ALIAS[n] = target }

    init {
        // ---- elementary
        f1("sqrt") { sqrt(it) }; f1("cbrt") { cbrt(it) }
        fv("root", 2, 2) { Special.nthRoot(it[0], it[1]) }; alias("root", "nthroot")
        f1("exp") { exp(it) }; f1("expm1") { expm1(it) }; f1("log1p") { ln1p(it) }
        f1("ln") { ln(it) }; f1("log10") { log10(it) }; f1("log2") { log2(it) }
        fv("log", 1, 2) { if (it.size == 1) log10(it[0]) else ln(it[0]) / ln(it[1]) }
        f2("logb") { b, x -> ln(x) / ln(b) }
        f1("abs") { abs(it) }; f1("sign") { if (it.isNaN()) it else sign(it) }; alias("sign", "sgn", "signum")
        f1("floor") { floor(it) }; f1("ceil") { ceil(it) }; alias("ceil", "ceiling")
        f1("trunc") { truncate(it) }; f1("frac") { it - floor(it) }; alias("frac", "sawtooth")
        fv("round", 1, 2) { if (it.size == 1) Math.rint(it[0]) else { val p = 10.0.pow(Math.rint(it[1])); Math.rint(it[0] * p) / p } }
        fv("max", 1, 64) { a -> a.fold(Double.NEGATIVE_INFINITY) { m, v -> if (v.isNaN() || m.isNaN()) Double.NaN else max(m, v) } }
        fv("min", 1, 64) { a -> a.fold(Double.POSITIVE_INFINITY) { m, v -> if (v.isNaN() || m.isNaN()) Double.NaN else min(m, v) } }
        fv("clamp", 3, 3) { min(max(it[0], it[1]), it[2]) }
        f2("mod") { a, b -> Special.mod(a, b) }
        f2("rem") { a, b -> a % b }
        fv("hypot", 1, 64) { a -> sqrt(a.sumOf { it * it }) }
        f1("deg") { it * 180 / PI }; f1("rad") { it * PI / 180 }

        // ---- trigonometric (input in the current angle mode) and inverses (output in it)
        f1("sin", trigIn = true) { sin(it) }; f1("cos", trigIn = true) { cos(it) }; f1("tan", trigIn = true) { tan(it) }
        f1("sec", trigIn = true) { 1 / cos(it) }; f1("csc", trigIn = true) { 1 / sin(it) }; f1("cot", trigIn = true) { cos(it) / sin(it) }
        f1("asin", trigOut = true) { asin(it) }; f1("acos", trigOut = true) { acos(it) }
        fv("atan", 1, 2, trigOut = true) { if (it.size == 1) atan(it[0]) else atan2(it[0], it[1]) }
        fv("atan2", 2, 2, trigOut = true) { atan2(it[0], it[1]) }
        f1("asec", trigOut = true) { acos(1 / it) }; f1("acsc", trigOut = true) { asin(1 / it) }
        f1("acot", trigOut = true) { if (it == 0.0) PI / 2 else atan(1 / it) }
        alias("asin", "arcsin"); alias("acos", "arccos"); alias("atan", "arctan"); alias("asec", "arcsec")
        alias("acsc", "arccsc"); alias("acot", "arccot"); alias("csc", "cosec")
        // ∬ / ∭ — sugar for nested int(…), desugared by the parser.
        alias("int2", "iint", "dblint", "doubleint"); alias("int3", "iiint", "tripleint")

        // ---- hyperbolic and inverses
        f1("sinh") { sinh(it) }; f1("cosh") { cosh(it) }; f1("tanh") { tanh(it) }
        f1("sech") { 1 / cosh(it) }; f1("csch") { 1 / sinh(it) }; f1("coth") { 1 / tanh(it) }
        f1("asinh") { asinh(it) }; f1("acosh") { acosh(it) }; f1("atanh") { atanh(it) }
        f1("asech") { acosh(1 / it) }; f1("acsch") { asinh(1 / it) }; f1("acoth") { atanh(1 / it) }
        for (h in listOf("sinh", "cosh", "tanh", "sech", "csch", "coth")) alias("a$h", "ar$h", "arc$h")

        // ---- signal / engineering helpers
        f1("sinc") { if (it == 0.0) 1.0 else sin(it) / it }
        f1("step") { when { it.isNaN() -> it; it < 0 -> 0.0; it > 0 -> 1.0; else -> 0.5 } }; alias("step", "heaviside")
        f1("rect") { val a = abs(it); when { a < 0.5 -> 1.0; a == 0.5 -> 0.5; a.isNaN() -> a; else -> 0.0 } }
        f1("tri") { max(1 - abs(it), 0.0) }
        f1("sigmoid") { 1 / (1 + exp(-it)) }; alias("sigmoid", "logistic")
        f1("relu") { max(it, 0.0) }

        // ---- special functions
        f1("factorial") { Special.gamma(it + 1) }; alias("factorial", "fact")
        f1("gamma") { Special.gamma(it) }
        f1("lgamma") { Special.lgamma(it) }; alias("lgamma", "lngamma", "loggamma")
        f1("digamma") { Special.digamma(it) }; alias("digamma", "psi")
        f2("beta") { a, b -> Special.beta(a, b) }
        f1("erf") { Special.erf(it) }; f1("erfc") { Special.erfc(it) }; f1("erfinv") { Special.erfinv(it) }
        f1("zeta") { Special.zeta(it) }
        fv("lambertw", 1, 2) { Special.lambertW(it[0], if (it.size > 1) Math.rint(it[1]).toInt() else 0) }; alias("lambertw", "productlog")
        f1("si") { Special.si(it) }; f1("ci") { Special.ci(it) }; f1("ei") { Special.ei(it) }; f1("li") { Special.li(it) }
        f1("fresnels") { Special.fresnelS(it) }; f1("fresnelc") { Special.fresnelC(it) }
        f1("ellipk") { Special.ellipK(it) }; f1("ellipe") { Special.ellipE(it) }
        f2("besselj") { n, x -> Special.besselJ(n, x) }; f2("bessely") { n, x -> Special.besselY(n, x) }
        f2("besseli") { n, x -> Special.besselI(n, x) }; f2("besselk") { n, x -> Special.besselK(n, x) }
        f1("airyai") { Special.airyAi(it) }; f1("airybi") { Special.airyBi(it) }; alias("airyai", "ai"); alias("airybi", "bi")
        f2("gammainc") { a, x -> Special.gammaP(a, x) }; f2("gammaincc") { a, x -> Special.gammaQ(a, x) }
        fv("betainc", 3, 3) { Special.betaI(it[0], it[1], it[2]) }

        // ---- combinatorics / number theory
        f2("ncr") { n, k -> Special.nCr(n, k) }; alias("ncr", "choose", "binom", "binomial")
        f2("npr") { n, k -> Special.nCr(n, k) * Special.gamma(k + 1) }; alias("npr", "perm")
        fv("gcd", 1, 64) { a -> a.fold(0.0) { g, v -> Special.gcd(g, v) } }
        fv("lcm", 1, 64) { a -> a.fold(1.0) { l, v -> Special.lcm(l, v) } }
        f1("isprime") { Special.isPrime(it) }

        // ---- statistics / probability
        fv("mean", 1, 64) { it.average() }
        fv("median", 1, 64) { a -> val s = a.sorted(); if (s.size % 2 == 1) s[s.size / 2] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2 }
        fv("total", 1, 64) { it.sum() }
        fv("var", 2, 64) { Special.variance(it, true) }; fv("varp", 1, 64) { Special.variance(it, false) }
        fv("stdev", 2, 64) { sqrt(Special.variance(it, true)) }; fv("stdevp", 1, 64) { sqrt(Special.variance(it, false)) }
        alias("stdev", "stddev", "std"); alias("varp", "variance")
        fv("normalpdf", 1, 3) { val m = it.getOrElse(1) { 0.0 }; val s = it.getOrElse(2) { 1.0 }; val z = (it[0] - m) / s; exp(-z * z / 2) / (s * sqrt(2 * PI)) }
        fv("normalcdf", 1, 3) { val m = it.getOrElse(1) { 0.0 }; val s = it.getOrElse(2) { 1.0 }; 0.5 * Special.erfc(-(it[0] - m) / (s * sqrt(2.0))) }
        fv("invnorm", 1, 3) { val m = it.getOrElse(1) { 0.0 }; val s = it.getOrElse(2) { 1.0 }; m + s * sqrt(2.0) * Special.erfinv(2 * it[0] - 1) }
        alias("normalpdf", "normpdf"); alias("normalcdf", "normcdf")
        f2("tpdf") { x, v -> exp(Special.lgamma((v + 1) / 2) - Special.lgamma(v / 2)) / sqrt(v * PI) * (1 + x * x / v).pow(-(v + 1) / 2) }
        f2("tcdf") { x, v -> val p = 0.5 * Special.betaI(v / (v + x * x), v / 2, 0.5); if (x > 0) 1 - p else p }
        f2("chisqpdf") { x, k -> if (x < 0) 0.0 else exp((k / 2 - 1) * ln(x) - x / 2 - (k / 2) * ln(2.0) - Special.lgamma(k / 2)) }
        f2("chisqcdf") { x, k -> if (x <= 0) 0.0 else Special.gammaP(k / 2, x / 2) }
        fv("binompdf", 3, 3) { Special.binomPdf(it[0], it[1], it[2]) }
        fv("binomcdf", 3, 3) { a -> var s = 0.0; var k = 0.0; val top = floor(a[0]); while (k <= top) { s += Special.binomPdf(k, a[1], a[2]); k += 1 }; min(s, 1.0) }
        f2("poissonpdf") { k, l -> if (k < 0 || k != floor(k)) 0.0 else exp(k * ln(l) - l - Special.lgamma(k + 1)) }
        f2("poissoncdf") { k, l -> if (k < 0) 0.0 else Special.gammaQ(floor(k) + 1, l) }
        f2("exppdf") { x, l -> if (x < 0) 0.0 else l * exp(-l * x) }; f2("expcdf") { x, l -> if (x < 0) 0.0 else 1 - exp(-l * x) }
    }

    fun canonical(name: String): String { val l = name.lowercase(); return ALIAS[l] ?: l }
    fun isBuiltinFn(name: String): Boolean { val c = canonical(name); return FNS.containsKey(c) || c in BINDERS }
    fun isReserved(name: String) = name in PLOT_VARS || CONSTANTS.containsKey(name) || isBuiltinFn(name)

    // ---------------------------------------------------------------- lexer
    enum class T { NUM, ID, OP, END }
    class Tok(val t: T, val s: String, val v: Double = 0.0)

    private val DERIV_RE = Regex("""(?<![A-Za-z0-9_])d\s*/\s*d(theta|[A-Za-z])(?![A-Za-z0-9_])""")

    fun normalize(src: String): String {
        var s = if (src.indexOf('\\') >= 0) Latex.toPlain(src) else src
        val reps = arrayOf(
            "×" to "*", "·" to "*", "⋅" to "*", "÷" to "/", "−" to "-", "–" to "-", "≤" to "<=", "≥" to ">=", "≠" to "!=",
            "²" to "^2", "³" to "^3", "√" to "sqrt", "∛" to "cbrt", "π" to "pi", "θ" to "theta", "τ" to "tau",
            "φ" to "phi", "∞" to "inf", "∑" to "sum", "Σ" to "sum", "∏" to "prod", "∭" to "int3", "∬" to "int2", "∫" to "int", "**" to "^", "Γ" to "gamma",
        )
        for ((a, b) in reps) s = s.replace(a, b)
        return DERIV_RE.replace(s) { m -> "ddx_" + m.groupValues[1] + " " }
    }

    fun lex(src: String): MutableList<Tok> {
        val s = src
        val out = ArrayList<Tok>()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c.isWhitespace()) { i++; continue }
            if (c.isDigit() || (c == '.' && i + 1 < s.length && s[i + 1].isDigit())) {
                val st = i
                while (i < s.length && s[i].isDigit()) i++
                if (i < s.length && s[i] == '.') { i++; while (i < s.length && s[i].isDigit()) i++ }
                if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                    var j = i + 1
                    if (j < s.length && (s[j] == '+' || s[j] == '-')) j++
                    if (j < s.length && s[j].isDigit()) { i = j; while (i < s.length && s[i].isDigit()) i++ }
                }
                val txt = s.substring(st, i)
                out.add(Tok(T.NUM, txt, txt.toDoubleOrNull() ?: throw MathError("Bad number '$txt'")))
                continue
            }
            if (c.isLetter() || c == '_') {
                val st = i
                while (i < s.length && (s[i].isLetterOrDigit() || s[i] == '_')) i++
                out.add(Tok(T.ID, s.substring(st, i)))
                continue
            }
            val two = if (i + 1 < s.length) s.substring(i, i + 2) else ""
            if (two == "<=" || two == ">=" || two == "==" || two == "!=") { out.add(Tok(T.OP, two)); i += 2; continue }
            if ("+-*/^!()[]{},|=<>:'%;".indexOf(c) >= 0) {
                // [ ] are accepted as plain grouping brackets.
                val op = when (c) { '[' -> "("; ']' -> ")"; ';' -> ","; else -> c.toString() }
                out.add(Tok(T.OP, op)); i++; continue
            }
            throw MathError("Unexpected '$c'")
        }
        out.add(Tok(T.END, ""))
        return out
    }

    // ---------------------------------------------------------------- parser
    class Statement(val lhs: Ex, val rhs: Ex?)

    /**
     * Parse one line. [userFns] / [userNames] are the names other lines define, so `f(x)` is a call
     * (not f·x) and multi-letter names survive implicit-multiplication splitting.
     */
    fun parseStatement(src: String, userFns: Set<String>, userNames: Set<String>): Statement {
        val p = Parser(lex(normalize(src)), userFns, userNames)
        return p.statement()
    }

    fun parseExpr(src: String, userFns: Set<String> = emptySet(), userNames: Set<String> = emptySet()): Ex {
        val st = parseStatement(src, userFns, userNames)
        if (st.rhs != null) throw MathError("Unexpected '='")
        return st.lhs
    }

    private class Parser(val toks: MutableList<Tok>, val userFns: Set<String>, val userNames: Set<String>) {
        var p = 0
        var absDepth = 0

        fun peek() = toks[p]
        fun next() = toks[p++]
        fun isOp(s: String) = toks[p].t == T.OP && toks[p].s == s
        fun expect(s: String) {
            if (!isOp(s)) throw MathError(if (peek().t == T.END) "Missing '$s'" else "Expected '$s' but found '${peek().s}'")
            p++
        }
        fun isFn(name: String) = name in userFns || isBuiltinFn(name) || name.startsWith("ddx_") || (name.startsWith("log_") && name.length > 4)
        fun isKnown(name: String) = name in PLOT_VARS || name in userNames || CONSTANTS.containsKey(name)

        fun statement(): Statement {
            val l = expr()
            var r: Ex? = null
            if (isOp("=")) { p++; r = expr() }
            if (peek().t != T.END) throw MathError("Unexpected '${peek().s}'")
            return Statement(l, r)
        }

        fun expr(): Ex {
            val first = sum()
            if (!(peek().t == T.OP && peek().s in CMP)) return first
            val items = arrayListOf(first); val ops = ArrayList<String>()
            while (peek().t == T.OP && peek().s in CMP) { ops.add(next().s); items.add(sum()) }
            return if (ops.size == 1) Ex.Bin(ops[0], items[0], items[1]) else Ex.Chain(items, ops)
        }

        fun sum(): Ex {
            var a = term()
            while (isOp("+") || isOp("-")) { val o = next().s; a = Ex.Bin(o, a, term()) }
            return a
        }

        fun term(): Ex {
            var a = unary()
            while (true) {
                a = when {
                    isOp("*") || isOp("/") || isOp("%") -> { val o = next().s; Ex.Bin(o, a, unary()) }
                    peek().t == T.ID && peek().s == "mod" -> { p++; Ex.Call("mod", listOf(a, unary())) }
                    startsPrimary() -> Ex.Bin("*", a, power())   // implicit multiplication
                    else -> return a
                }
            }
        }

        fun unary(): Ex = when {
            isOp("-") -> { p++; Ex.Neg(unary()) }
            isOp("+") -> { p++; unary() }
            else -> power()
        }

        fun power(): Ex {
            val base = postfix()
            if (isOp("^")) { p++; return Ex.Bin("^", base, unary()) }
            return base
        }

        fun postfix(): Ex {
            var a = primary()
            while (isOp("!")) { p++; a = Ex.Call("factorial", listOf(a)) }
            return a
        }

        fun startsPrimary(): Boolean {
            val t = peek()
            return when (t.t) {
                T.NUM -> true
                T.ID -> t.s != "mod"
                T.OP -> t.s == "(" || t.s == "{" || (t.s == "|" && absDepth == 0)
                T.END -> false
            }
        }

        fun primary(): Ex {
            val t = peek()
            return when {
                t.t == T.NUM -> { p++; Ex.Num(t.v) }
                t.t == T.OP && t.s == "(" -> {
                    p++
                    val items = arrayListOf(expr())
                    while (isOp(",")) { p++; items.add(expr()) }
                    expect(")")
                    if (items.size == 1) items[0] else Ex.Tuple(items)
                }
                t.t == T.OP && t.s == "|" -> {
                    p++; absDepth++
                    val a = expr()
                    absDepth--
                    expect("|")
                    Ex.Call("abs", listOf(a))
                }
                t.t == T.OP && t.s == "{" -> piecewise()
                t.t == T.ID -> identifier()
                t.t == T.END -> throw MathError("Incomplete expression")
                else -> throw MathError("Unexpected '${t.s}'")
            }
        }

        fun isComparison(e: Ex) = (e is Ex.Bin && e.op in CMP) || e is Ex.Chain

        fun piecewise(): Ex {
            p++ // {
            if (isOp("}")) { p++; return Ex.Num(Double.NaN) }
            val cases = ArrayList<Pair<Ex, Ex?>>()
            var otherwise: Ex? = null
            while (true) {
                val c = expr()
                if (isOp(":")) { p++; cases.add(c to expr()) }
                else if (cases.isEmpty() && !isOp(",") && !isComparison(c)) { expect("}"); return c }  // plain {grouping}
                else if (isComparison(c)) cases.add(c to null)
                else { otherwise = c }
                if (isOp(",")) { p++; if (otherwise != null) throw MathError("The 'otherwise' value must come last"); continue }
                expect("}")
                break
            }
            return Ex.Piece(cases, otherwise)
        }

        /** Arguments of a function: a parenthesised list, or a bare implicit product (sin 2x). */
        fun fnArgs(): List<Ex> {
            if (isOp("(")) {
                p++
                val args = ArrayList<Ex>()
                if (!isOp(")")) { args.add(expr()); while (isOp(",")) { p++; args.add(expr()) } }
                expect(")")
                return args
            }
            if (isOp("-")) { p++; return listOf(Ex.Neg(bareArg())) }
            if (!startsPrimary()) throw MathError(if (peek().t == T.END) "Missing function argument" else "Unexpected '${peek().s}'")
            return listOf(bareArg())
        }

        fun bareArg(): Ex {
            var a = power()
            while (startsPrimary() && !(peek().t == T.ID && isFn(peek().s))) a = Ex.Bin("*", a, power())
            return a
        }

        private val INVERSE = mapOf(
            "sin" to "asin", "cos" to "acos", "tan" to "atan", "sec" to "asec", "csc" to "acsc", "cot" to "acot",
            "sinh" to "asinh", "cosh" to "acosh", "tanh" to "atanh", "sech" to "asech", "csch" to "acsch", "coth" to "acoth",
        )

        fun identifier(): Ex {
            val name = next().s
            if (name.startsWith("ddx_")) {
                val v = name.substring(4)
                val a = if (isOp("(")) primary() else bareArg()
                return Ex.Deriv(v, a)
            }
            if (name.startsWith("log_") && name.length > 4) {
                val bs = name.substring(4)
                val base = bs.toDoubleOrNull()?.let { Ex.Num(it) } ?: Ex.Var(bs)
                val args = fnArgs()
                if (args.size != 1) throw MathError("log_b takes one argument")
                return Ex.Call("logb", listOf(base, args[0]))
            }
            val canon = canonical(name)
            if ((canon == "int2" || canon == "int3") && name !in userFns) return multiIntegral(canon == "int3")
            var primes = 0
            while (isOp("'")) { p++; primes++ }
            if (isFn(name)) {
                // sin^2 x  →  (sin x)^2 ;  sin^-1 x  →  asin x
                if (isOp("^") && name !in userFns) {
                    p++
                    val e = if (isOp("-")) { p++; Ex.Neg(postfix()) } else postfix()
                    val inv = INVERSE[canonical(name)]
                    if (inv != null && e is Ex.Neg && e.a is Ex.Num && (e.a as Ex.Num).v == 1.0) return Ex.Call(inv, fnArgs())
                    return Ex.Bin("^", Ex.Call(name, fnArgs()), e)
                }
                return Ex.Call(name, fnArgs(), primes)
            }
            if (primes > 0) throw MathError("' (derivative) only works on a defined function like f'(x)")
            if (isKnown(name)) return Ex.Var(name)
            // Unknown run of letters: split into known names (xy → x·y, pix → pi·x, sinx → sin x, x2 → x·2).
            val parts = split(name)
            if (parts != null) {
                toks.removeAt(p - 1)
                toks.addAll(p - 1, parts)
                p -= 1
                return primary()
            }
            return Ex.Var(name)
        }

        /**
         * int2(f, y, c, d, x, a, b) = ∫ₐᵇ∫꜀ᵈ f dy dx and int3(f, z, …, y, …, x, a, b) = ∭ f dz dy dx: the
         * variables are listed innermost first, in the order the differentials are written. Each inner
         * bound may use the outer variables. Desugared to nested int(…) so everything downstream
         * (compile, free variables, typesetting, the 3D region view) just sees ordinary integrals.
         */
        fun multiIntegral(triple: Boolean): Ex {
            val args = fnArgs()
            val n = if (triple) 3 else 2
            if (args.size != 1 + 3 * n) throw MathError(if (triple) "int3(f, z, z₀, z₁, y, y₀, y₁, x, a, b)" else "int2(f, y, y₀, y₁, x, a, b)")
            var body = args[0]
            for (k in 0 until n) {
                val v = args[1 + 3 * k] as? Ex.Var ?: throw MathError("Each integration variable must be a single name")
                body = Ex.Call("int", listOf(body, v, args[2 + 3 * k], args[3 + 3 * k]))
            }
            return body
        }

        fun split(name: String): List<Tok>? {
            if (name.contains('_')) return null
            val out = ArrayList<Tok>()
            var i = 0
            while (i < name.length) {
                if (name[i].isDigit()) {
                    var j = i; while (j < name.length && name[j].isDigit()) j++
                    val t = name.substring(i, j); out.add(Tok(T.NUM, t, t.toDouble())); i = j; continue
                }
                var best = 1
                var j = name.length
                while (j >= i + 2) {
                    val sub = name.substring(i, j)
                    if (isFn(sub) || isKnown(sub)) { best = j - i; break }
                    j--
                }
                out.add(Tok(T.ID, name.substring(i, i + best))); i += best
            }
            return if (out.size > 1) out else null
        }
    }

    // ---------------------------------------------------------------- analysis helpers
    /** Does [e] reference variable [name] freely? */
    fun mentions(e: Ex, name: String): Boolean = freeVars(e).contains(name)

    /** Free variable names of [e] (excluding names bound by sum/int/lim/deriv). */
    fun freeVars(e: Ex, out: MutableSet<String> = HashSet(), bound: Set<String> = emptySet()): MutableSet<String> {
        when (e) {
            is Ex.Num -> {}
            is Ex.Var -> if (e.name !in bound) out.add(e.name)
            is Ex.Neg -> freeVars(e.a, out, bound)
            is Ex.Bin -> { freeVars(e.a, out, bound); freeVars(e.b, out, bound) }
            is Ex.Chain -> e.items.forEach { freeVars(it, out, bound) }
            is Ex.Tuple -> e.items.forEach { freeVars(it, out, bound) }
            is Ex.Piece -> { e.cases.forEach { freeVars(it.first, out, bound); it.second?.let { v -> freeVars(v, out, bound) } }; e.otherwise?.let { freeVars(it, out, bound) } }
            is Ex.Deriv -> { if (e.v !in bound) out.add(e.v); freeVars(e.a, out, bound) }
            is Ex.Call -> {
                val c = canonical(e.name)
                val bv = (e.args.getOrNull(1) as? Ex.Var)?.name
                when {
                    (c == "sum" || c == "prod" || c == "lim" || c == "limit") && bv != null -> {
                        freeVars(e.args[0], out, bound + bv); e.args.drop(2).forEach { freeVars(it, out, bound) }
                    }
                    (c == "int" || c == "integral") && e.args.size == 4 && bv != null -> {
                        freeVars(e.args[0], out, bound + bv); e.args.drop(2).forEach { freeVars(it, out, bound) }
                    }
                    (c == "int" || c == "integral") && e.args.size == 3 -> {
                        val v = intVar(e.args[0]); freeVars(e.args[0], out, bound + v); e.args.drop(1).forEach { freeVars(it, out, bound) }
                    }
                    (c == "deriv" || c == "diff") && e.args.size == 3 && bv != null -> {
                        freeVars(e.args[0], out, bound + bv); freeVars(e.args[2], out, bound)
                    }
                    (c == "deriv" || c == "diff") && bv != null -> { if (bv !in bound) out.add(bv); freeVars(e.args[0], out, bound) }
                    else -> e.args.forEach { freeVars(it, out, bound) }
                }
            }
        }
        return out
    }

    /** 3-argument int(expr, a, b) integrates over t when the integrand uses t, else over x. */
    private fun intVar(integrand: Ex) = if (freeVars(integrand).contains("t")) "t" else "x"

    // ---------------------------------------------------------------- compiler
    private const val D2R = PI / 180
    private const val R2D = 180 / PI

    fun compile(e: Ex, env: MathEnv, vars: List<String> = PLOT_VARS): Compiled {
        val c = Compiler(env, vars)
        val f = c.c(e)
        return Compiled(f, c.n)
    }

    /** Evaluate a constant expression (no variables). */
    fun evalConst(e: Ex, env: MathEnv): Double { val c = compile(e, env, emptyList()); return c.f(c.frame()) }

    private fun fx(b: Fx): Fx = b

    /** Does [e] contain an integral (so integrating it makes a multiple integral)? */
    private fun hasIntegral(e: Ex): Boolean = when (e) {
        is Ex.Call -> canonical(e.name).let { it == "int" || it == "integral" } || e.args.any { hasIntegral(it) }
        is Ex.Neg -> hasIntegral(e.a)
        is Ex.Bin -> hasIntegral(e.a) || hasIntegral(e.b)
        is Ex.Chain -> e.items.any { hasIntegral(it) }
        is Ex.Tuple -> e.items.any { hasIntegral(it) }
        is Ex.Piece -> e.cases.any { hasIntegral(it.first) || it.second?.let { v -> hasIntegral(v) } == true } || e.otherwise?.let { hasIntegral(it) } == true
        is Ex.Deriv -> hasIntegral(e.a)
        else -> false
    }

    private class Compiler(val env: MathEnv, vars: List<String>) {
        val slots = HashMap<String, Int>()
        var n = 0
        var intDepth = 0   // how many int(…) bodies we're inside (inner integrals get a cheaper rule)
        init { for (v in vars) slots[v] = n++ }

        fun <R> bind(name: String, body: (Int) -> R): R {
            val prev = slots[name]
            val s = n++
            slots[name] = s
            try { return body(s) } finally { if (prev == null) slots.remove(name) else slots[name] = prev }
        }

        fun c(e: Ex): Fx = when (e) {
            is Ex.Num -> { val v = e.v; fx { v } }
            is Ex.Var -> {
                val s = slots[e.name]
                if (s != null) fx { f -> f[s] }
                else {
                    val v = env.consts[e.name] ?: CONSTANTS[e.name]
                        ?: throw MathError(if (isBuiltinFn(e.name)) "'${e.name}' needs an argument" else "'${e.name}' isn't defined")
                    fx { v }
                }
            }
            is Ex.Neg -> { val a = c(e.a); fx { f -> -a(f) } }
            is Ex.Bin -> bin(e)
            is Ex.Chain -> {
                val fs = e.items.map { c(it) }; val ops = e.ops
                fx { f ->
                    var ok = true
                    var prev = fs[0](f)
                    for (i in ops.indices) { val cur = fs[i + 1](f); if (!cmp(ops[i], prev, cur)) { ok = false; break }; prev = cur }
                    if (ok) 1.0 else 0.0
                }
            }
            is Ex.Piece -> {
                val cs = e.cases.map { c(it.first) to it.second?.let { v -> c(v) } }
                val other = e.otherwise?.let { c(it) }
                fx { f ->
                    var r = Double.NaN
                    var hit = false
                    for ((cond, v) in cs) {
                        val cv = cond(f)
                        if (cv != 0.0 && !cv.isNaN()) { r = if (v != null) v(f) else 1.0; hit = true; break }
                    }
                    if (hit) r else other?.invoke(f) ?: Double.NaN
                }
            }
            is Ex.Tuple -> throw MathError("A point (a, b) can't be used inside an expression")
            is Ex.Deriv -> {
                val s = slots[e.v] ?: throw MathError("d/d${e.v}: '${e.v}' isn't a variable here")
                val g = c(e.a)
                fx { f -> val x0 = f[s]; val r = Calc.d1({ xv -> f[s] = xv; g(f) }, x0); f[s] = x0; r }
            }
            is Ex.Call -> call(e)
        }

        fun cmp(op: String, a: Double, b: Double) = when (op) {
            "<" -> a < b; "<=" -> a <= b; ">" -> a > b; ">=" -> a >= b
            "==" -> a == b || abs(a - b) <= 1e-12 * max(abs(a), abs(b)); else -> !(a == b)
        }

        fun bin(e: Ex.Bin): Fx {
            val a = c(e.a); val b = c(e.b)
            return when (e.op) {
                "+" -> fx { f -> a(f) + b(f) }
                "-" -> fx { f -> a(f) - b(f) }
                "*" -> fx { f -> a(f) * b(f) }
                "/" -> fx { f -> a(f) / b(f) }
                "^" -> fx { f -> Special.powR(a(f), b(f)) }
                "%" -> fx { f -> Special.mod(a(f), b(f)) }
                else -> { val op = e.op; fx { f -> if (cmp(op, a(f), b(f))) 1.0 else 0.0 } }
            }
        }

        fun ensureCompiled(fn: UserFn) {
            if (fn.code != null) return
            if (fn.busy) throw MathError("${fn.name} is defined in terms of itself")
            fn.busy = true
            try {
                val comp = Compiler(env, fn.params)
                val code = comp.c(fn.body)
                fn.slots = comp.n
                fn.code = code
            } finally { fn.busy = false }
        }

        fun call(e: Ex.Call): Fx {
            env.fns[e.name]?.let { return userCall(it, e) }
            val name = canonical(e.name)
            if (e.primes > 0) throw MathError("' only works on functions you define, like f'(x)")
            val args = e.args
            when (name) {
                "sum", "prod" -> {
                    if (args.size != 4) throw MathError("$name(expression, n, from, to)")
                    val v = (args[1] as? Ex.Var)?.name ?: throw MathError("$name: the 2nd argument must be the index variable")
                    val lo = c(args[2]); val hi = c(args[3]); val isSum = name == "sum"
                    return bind(v) { s -> val body = c(args[0]); fx { f -> Calc.series(f, s, body, lo(f), hi(f), isSum) } }
                }
                "int", "integral" -> {
                    if (args.size != 3 && args.size != 4) throw MathError("int(expression, x, from, to)")
                    val v: String; val a: Ex; val b: Ex
                    if (args.size == 4) {
                        v = (args[1] as? Ex.Var)?.name ?: throw MathError("int: the 2nd argument must be the variable")
                        a = args[2]; b = args[3]
                    } else { v = intVar(args[0]); a = args[1]; b = args[2] }
                    val lo = c(a); val hi = c(b)
                    // Every level of a double / triple integral runs once per sample of the levels around
                    // it, so those levels use the bounded-cost rule (Calc.integrateNested) instead of the
                    // fully adaptive one: a ball's volume takes ~0.1 s instead of ~20 s.
                    val nested = intDepth > 0 || hasIntegral(args[0])
                    return bind(v) { s ->
                        intDepth++
                        val body = try { c(args[0]) } finally { intDepth-- }
                        if (nested) fx { f -> val sv = f[s]; val r = Calc.integrateNested({ xv -> f[s] = xv; body(f) }, lo(f), hi(f)); f[s] = sv; r }
                        else fx { f -> val sv = f[s]; val r = Calc.integrate({ xv -> f[s] = xv; body(f) }, lo(f), hi(f)); f[s] = sv; r }
                    }
                }
                "deriv", "diff" -> {
                    if (args.size != 2 && args.size != 3) throw MathError("deriv(expression, x) or deriv(expression, x, at)")
                    val v = (args[1] as? Ex.Var)?.name ?: throw MathError("deriv: the 2nd argument must be the variable")
                    if (args.size == 2) return c(Ex.Deriv(v, args[0]))
                    val at = c(args[2])
                    return bind(v) { s ->
                        val body = c(args[0])
                        fx { f -> val sv = f[s]; val r = Calc.d1({ xv -> f[s] = xv; body(f) }, at(f)); f[s] = sv; r }
                    }
                }
                "lim", "limit" -> {
                    if (args.size != 3) throw MathError("lim(expression, x, approaching)")
                    val v = (args[1] as? Ex.Var)?.name ?: throw MathError("lim: the 2nd argument must be the variable")
                    val at = c(args[2])
                    return bind(v) { s ->
                        val body = c(args[0])
                        fx { f -> val sv = f[s]; val r = Calc.limit({ xv -> f[s] = xv; body(f) }, at(f)); f[s] = sv; r }
                    }
                }
                "if" -> {
                    if (args.size != 2 && args.size != 3) throw MathError("if(condition, then, else)")
                    val cond = c(args[0]); val a = c(args[1]); val b = if (args.size == 3) c(args[2]) else null
                    return fx { f -> val cv = cond(f); if (cv != 0.0 && !cv.isNaN()) a(f) else b?.invoke(f) ?: Double.NaN }
                }
            }
            val fn = FNS[name] ?: throw MathError("Unknown function '${e.name}'")
            val n = args.size
            if (n < fn.min || n > fn.max) {
                val want = if (fn.min == fn.max) "${fn.min}" else if (fn.max >= 64) "${fn.min}+" else "${fn.min}–${fn.max}"
                throw MathError("${e.name} takes $want argument${if (fn.max == 1) "" else "s"}")
            }
            val cargs = args.map { c(it) }.toMutableList()
            if (fn.trigIn && env.degrees) { val a0 = cargs[0]; cargs[0] = fx { f -> a0(f) * D2R } }
            val one = fn.one; val two = fn.two; val many = fn.many
            val core: Fx = when {
                n == 1 && one != null -> { val a = cargs[0]; fx { f -> one(a(f)) } }
                n == 2 && two != null -> { val a = cargs[0]; val b = cargs[1]; fx { f -> two(a(f), b(f)) } }
                else -> fx { f -> val v = DoubleArray(n); for (i in 0 until n) v[i] = cargs[i](f); many(v) }
            }
            return if (fn.trigOut && env.degrees) fx { f -> core(f) * R2D } else core
        }

        fun userCall(fn: UserFn, e: Ex.Call): Fx {
            ensureCompiled(fn)
            if (e.args.size != fn.params.size)
                throw MathError("${fn.name} takes ${fn.params.size} argument${if (fn.params.size == 1) "" else "s"}")
            val args = e.args.map { c(it) }
            val body = fn.code!!
            val ns = fn.slots.coerceAtLeast(1)
            if (e.primes == 0) return fx { f -> val fr = DoubleArray(ns); for (i in args.indices) fr[i] = args[i](f); body(fr) }
            if (fn.params.isEmpty()) return fx { 0.0 }
            val k = e.primes
            return fx { f ->
                val fr = DoubleArray(ns); for (i in args.indices) fr[i] = args[i](f)
                Calc.dn({ xv -> fr[0] = xv; body(fr) }, fr[0], k)
            }
        }
    }

    // ---------------------------------------------------------------- formatting
    fun fmt(v: Double, sig: Int = 10): String {
        if (v.isNaN()) return "undefined"
        if (v.isInfinite()) return if (v > 0) "∞" else "−∞"
        if (v == 0.0) return "0"
        val a = abs(v)
        val s = if (a >= 1e10 || a < 1e-6) {
            val str = "%.${(sig - 4).coerceAtLeast(2)}e".format(v)
            val (m, ex) = str.split('e', 'E').let { it[0] to it[1].toInt() }
            m.trimEnd('0').trimEnd('.') + "×10^" + ex
        } else java.math.BigDecimal(v).round(java.math.MathContext(sig)).stripTrailingZeros().toPlainString()
        return s.replace("-", "−")
    }
}

/** Numerical calculus used by the compiled closures. */
object Calc {
    /** First derivative: 5-point central difference with a step scaled to |x|. */
    fun d1(g: (Double) -> Double, x: Double, h0: Double = 1e-3): Double {
        if (x.isNaN() || x.isInfinite()) return Double.NaN
        val h = h0 * max(1.0, abs(x))
        return (g(x - 2 * h) - 8 * g(x - h) + 8 * g(x + h) - g(x + 2 * h)) / (12 * h)
    }

    /** n-th derivative by nesting [d1], widening the outer steps so roundoff doesn't swamp it. */
    fun dn(g: (Double) -> Double, x: Double, n: Int): Double = when {
        n <= 0 -> g(x)
        n == 1 -> d1(g, x)
        else -> d1({ xv -> dn(g, xv, n - 1) }, x, 1e-3 * 2.5.pow(n - 1))
    }

    private val GLX = doubleArrayOf(0.1488743389816312, 0.4333953941292472, 0.6794095682990244, 0.8650633666889845, 0.9739065285171717)
    private val GLW = doubleArrayOf(0.2955242247147529, 0.2692667193099963, 0.2190863625159820, 0.1494513491505806, 0.0666713443086881)

    private fun gl10(f: (Double) -> Double, a: Double, b: Double): Double {
        val m = (a + b) / 2; val h = (b - a) / 2
        var s = 0.0
        for (i in 0 until 5) { val dx = h * GLX[i]; s += GLW[i] * (f(m + dx) + f(m - dx)) }
        return s * h
    }

    private class Flag { var hit = false }

    private fun adapt(f: (Double) -> Double, a: Double, b: Double, whole: Double, tol: Double, depth: Int, flag: Flag): Double {
        val m = (a + b) / 2
        val l = gl10(f, a, m); val r = gl10(f, m, b)
        val sum = l + r
        if (abs(sum - whole) <= tol || !sum.isFinite()) return sum
        if (depth <= 0) { flag.hit = true; return sum }
        return adapt(f, a, m, l, tol / 2, depth - 1, flag) + adapt(f, m, b, r, tol / 2, depth - 1, flag)
    }

    /**
     * Tanh-sinh (double-exponential) quadrature on a finite [a, b]: copes with integrable endpoint
     * singularities (1/sqrt(x), ln x) that defeat Gauss-Legendre. Returns NaN unless it converges.
     */
    private fun tanhSinh(f: (Double) -> Double, a: Double, b: Double, maxLevel: Int = 8, tMax: Double = 6.5, tol: Double = 1e-11): Double {
        val c = (a + b) / 2; val h = (b - a) / 2
        fun pair(t: Double): Double {
            val u = PI / 2 * sinh(t)
            val ch = cosh(u)
            val w = PI / 2 * cosh(t) / (ch * ch)
            val d = h * 2 / (exp(2 * u) + 1)          // distance from each endpoint, without cancellation
            if (d == 0.0 || w < 1e-300 || !w.isFinite()) return 0.0
            val fl = f(a + d); val fr = f(b - d)
            // Right at the ends, rounding can step just outside a √ bound (NaN) where the weight is
            // already negligible; only a NaN that carries real weight means the integral is undefined.
            if ((fl.isNaN() || fr.isNaN()) && w > 1e-12) return Double.NaN
            return w * ((if (fl.isFinite()) fl else 0.0) + (if (fr.isFinite()) fr else 0.0))
        }
        val f0 = f(c)
        if (f0.isNaN()) return Double.NaN
        var sum = PI / 2 * (if (f0.isFinite()) f0 else 0.0)
        var step = 1.0
        var t = step
        while (t < tMax) { val p = pair(t); if (p.isNaN()) return p; sum += p; t += step }
        var est = h * step * sum
        for (level in 1..maxLevel) {
            step /= 2
            t = step
            while (t < tMax) { val p = pair(t); if (p.isNaN()) return p; sum += p; t += 2 * step }
            val next = h * step * sum
            if (level >= 3 && abs(next - est) <= tol * max(1.0, abs(next))) return next
            est = next
        }
        return Double.NaN
    }

    /**
     * One level of a double / triple integral, at a bounded cost. A smooth integrand passes the quick
     * Gauss-Legendre check (30 evaluations); anything else — typically a √ bound's vertical tangent at
     * an end — goes to a short tanh-sinh run (≤ ~130 evaluations), which handles endpoint singularities
     * well. Accurate to ~1e-9 relative, so even a ball's volume nests three levels in a fraction of a second.
     */
    fun integrateNested(g: (Double) -> Double, a: Double, b: Double): Double {
        if (a.isNaN() || b.isNaN()) return Double.NaN
        if (a == b) return 0.0
        if (a > b) return -integrateNested(g, b, a)
        val h: (Double) -> Double; val lo: Double; val hi: Double
        when {
            a.isInfinite() && b.isInfinite() -> { h = { u -> val c = cos(u); g(tan(u)) / (c * c) }; lo = -PI / 2; hi = PI / 2 }
            b.isInfinite() -> { h = { u -> val d = 1 - u; g(a + u / d) / (d * d) }; lo = 0.0; hi = 1.0 }
            a.isInfinite() -> { h = { u -> val d = 1 - u; g(b - u / d) / (d * d) }; lo = 0.0; hi = 1.0 }
            else -> { h = g; lo = a; hi = b }
        }
        val m = (lo + hi) / 2
        val whole = gl10(h, lo, hi); val halves = gl10(h, lo, m) + gl10(h, m, hi)
        if (abs(halves - whole) <= 1e-10 * max(1.0, abs(halves))) return halves
        val de = tanhSinh(h, lo, hi, maxLevel = 4, tMax = 4.0, tol = 1e-9)
        if (de.isFinite()) return de
        // Neither settled (an interior kink or jump): a short adaptive pass is still bounded.
        val flag = Flag()
        return adapt(h, lo, m, gl10(h, lo, m), 1e-8 * max(1.0, abs(halves)), 4, flag) + adapt(h, m, hi, gl10(h, m, hi), 1e-8 * max(1.0, abs(halves)), 4, flag)
    }

    /** Adaptive Gauss-Legendre quadrature (tanh-sinh fallback); infinite limits via a change of variables. */
    fun integrate(g: (Double) -> Double, a: Double, b: Double, panels: Int = 8, depth: Int = 9, tol: Double = 1e-11): Double {
        if (a.isNaN() || b.isNaN()) return Double.NaN
        if (a == b) return 0.0
        if (a > b) return -integrate(g, b, a, panels, depth, tol)
        val h: (Double) -> Double; val lo: Double; val hi: Double
        when {
            a.isInfinite() && b.isInfinite() -> { h = { u -> val c = cos(u); g(tan(u)) / (c * c) }; lo = -PI / 2; hi = PI / 2 }
            b.isInfinite() -> { h = { u -> val d = 1 - u; g(a + u / d) / (d * d) }; lo = 0.0; hi = 1.0 }
            a.isInfinite() -> { h = { u -> val d = 1 - u; g(b - u / d) / (d * d) }; lo = 0.0; hi = 1.0 }
            else -> { h = g; lo = a; hi = b }
        }
        var total = 0.0
        val w = (hi - lo) / panels
        val flag = Flag()
        for (i in 0 until panels) {
            val x0 = lo + i * w; val x1 = if (i == panels - 1) hi else x0 + w
            val whole = gl10(h, x0, x1)
            total += adapt(h, x0, x1, whole, tol * max(1.0, abs(whole)), depth, flag)
        }
        if (flag.hit && total.isFinite()) {
            val de = tanhSinh(h, lo, hi)
            if (de.isFinite()) return de
        }
        return total
    }

    private fun aitken(s0: Double, s1: Double, s2: Double): Double {
        val d1 = s1 - s0; val d2 = s2 - s1
        val den = d2 - d1
        return if (den == 0.0) s2 else s2 - d2 * d2 / den
    }

    /** Sum / product of body over the integer index in slot [s]; an infinite upper bound runs until it converges. */
    fun series(f: DoubleArray, s: Int, body: Fx, lo: Double, hi: Double, isSum: Boolean): Double {
        if (lo.isNaN() || hi.isNaN() || lo.isInfinite()) return Double.NaN
        if (hi.isInfinite() && hi < 0) return if (isSum) 0.0 else 1.0
        val saved = f[s]
        var acc = if (isSum) 0.0 else 1.0
        var k = Math.rint(lo)
        if (hi.isInfinite()) {
            // Run until the terms stop mattering; slowly converging tails (sum 1/n^2, alternating
            // series) are extrapolated from partial sums at N = 2^10 .. 2^16 with Aitken's delta-squared.
            val marks = DoubleArray(7)
            var quiet = 0
            var count = 0
            var result = Double.NaN
            var done = false
            while (count < 65_536) {
                f[s] = k
                val t = body(f)
                val prev = acc
                if (isSum) acc += t else acc *= t
                if (acc.isNaN()) { done = true; break }
                if (acc.isInfinite()) { result = acc; done = true; break }
                quiet = if (acc == prev || abs(acc - prev) <= 1e-16 * abs(acc)) quiet + 1 else 0
                if (quiet >= 25) { result = acc; done = true; break }
                k += 1; count++
                val lg = Integer.numberOfTrailingZeros(count)
                if (count == (1 shl lg) && lg in 10..16) marks[lg - 10] = acc
            }
            if (!done) {
                val a1 = aitken(marks[4], marks[5], marks[6])
                val a0 = aitken(marks[3], marks[4], marks[5])
                val d1 = marks[5] - marks[4]; val d2 = marks[6] - marks[5]
                result = when {
                    // differences not shrinking: diverges (e.g. the harmonic series)
                    d1 != 0.0 && d2 / d1 > 0.9 && abs(d2) > 1e-9 * max(1.0, abs(marks[6])) -> sign(d2) * Double.POSITIVE_INFINITY
                    a1.isFinite() && abs(a1 - a0) <= 1e-6 * max(1.0, abs(a1)) -> a1
                    else -> Double.NaN
                }
            }
            f[s] = saved
            return result
        }
        val end = Math.rint(hi)
        var count = 0
        while (k <= end && count < 1_000_000) {
            f[s] = k
            val t = body(f)
            if (isSum) acc += t else acc *= t
            k += 1; count++
        }
        f[s] = saved
        return acc
    }

    /** Numeric two-sided limit (Richardson-extrapolated), or the limit at ±∞. */
    fun limit(g: (Double) -> Double, a: Double): Double {
        if (a.isNaN()) return Double.NaN
        if (a.isInfinite()) {
            var prev = Double.NaN
            var x = 10.0 * sign(a)
            for (k in 0 until 14) {
                val v = g(x)
                if (v.isFinite() && prev.isFinite() && abs(v - prev) <= 1e-8 * max(1.0, abs(v))) return v
                if (abs(v) > 1e15 && prev.isFinite() && abs(prev) > 1e7 && sign(v) == sign(prev)) return sign(v) * Double.POSITIVE_INFINITY
                prev = v; x *= 10
            }
            return Double.NaN
        }
        fun side(sg: Double): Double {
            val s = max(1.0, abs(a))
            var prev = Double.NaN
            var h = 1e-2
            var last = Double.NaN
            for (k in 0 until 8) {
                val v1 = g(a + sg * h * s); val v2 = g(a + sg * h * s / 2)
                if (v2.isInfinite() || abs(v2) > 1e14) return sign(v2) * Double.POSITIVE_INFINITY
                val est = 2 * v2 - v1
                if (est.isFinite() && prev.isFinite() && abs(est - prev) <= 1e-9 * max(1.0, abs(est))) return est
                prev = est; last = est; h /= 10
            }
            return last
        }
        val l = side(-1.0); val r = side(1.0)
        if (l.isInfinite() && r.isInfinite()) return if (l == r) l else Double.NaN
        if (!l.isFinite() || !r.isFinite()) return if (l.isNaN() && r.isFinite()) r else if (r.isNaN() && l.isFinite()) l else Double.NaN
        if (abs(l - r) > 1e-5 * max(1.0, abs(l))) return Double.NaN
        val v = (l + r) / 2
        // Snap to a clean value when the extrapolation lands within roundoff of one.
        val sn = java.math.BigDecimal(v).round(java.math.MathContext(11)).toDouble()
        return sn
    }
}

/** Real-valued special functions. */
object Special {
    private const val FPMIN = 1e-300

    fun mod(a: Double, b: Double): Double = a - b * floor(a / b)

    /** Real power: a negative base with an odd-denominator rational exponent stays real (x^(1/3)). */
    fun powR(a: Double, b: Double): Double {
        if (a >= 0 || b.isNaN() || a.isNaN() || b == floor(b) || b.isInfinite()) return a.pow(b)
        for (q in 3..63 step 2) {
            val pp = b * q
            val r = Math.rint(pp)
            if (abs(pp - r) < 1e-9) {
                val mag = (-a).pow(b)
                return if (abs(r.toLong()) % 2L == 0L) mag else -mag
            }
        }
        return Double.NaN
    }

    fun nthRoot(x: Double, n: Double): Double {
        if (n == 0.0) return Double.NaN
        if (x < 0 && n == floor(n) && abs(n.toLong()) % 2L == 1L) return -((-x).pow(1 / n))
        return x.pow(1 / n)
    }

    private val LG = doubleArrayOf(
        0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
        12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    )

    fun gamma(x: Double): Double {
        if (x.isNaN()) return x
        if (x == floor(x) && x <= 0) return Double.NaN
        if (x < 0.5) return PI / (sin(PI * x) * gamma(1 - x))
        if (x > 171.7) return Double.POSITIVE_INFINITY
        if (x == floor(x) && x <= 30) { var r = 1.0; var k = 2.0; while (k < x) { r *= k; k += 1 }; return r }
        val xx = x - 1
        var a = LG[0]
        val t = xx + 7.5
        for (i in 1..8) a += LG[i] / (xx + i)
        val p = t.pow((xx + 0.5) / 2)
        return sqrt(2 * PI) * p * (p * exp(-t)) * a
    }

    /** ln|Γ(x)|. */
    fun lgamma(x: Double): Double {
        if (x.isNaN()) return x
        if (x == floor(x) && x <= 0) return Double.POSITIVE_INFINITY
        if (x < 0.5) return ln(PI / abs(sin(PI * x))) - lgamma(1 - x)
        val xx = x - 1
        var a = LG[0]
        val t = xx + 7.5
        for (i in 1..8) a += LG[i] / (xx + i)
        return 0.5 * ln(2 * PI) + (xx + 0.5) * ln(t) - t + ln(a)
    }

    fun digamma(x0: Double): Double {
        var x = x0
        if (x.isNaN() || (x <= 0 && x == floor(x))) return Double.NaN
        if (x < 0) return digamma(1 - x) - PI / tan(PI * x)
        var r = 0.0
        while (x < 10) { r -= 1 / x; x += 1 }
        val f = 1 / (x * x)
        return r + ln(x) - 0.5 / x - f * (1.0 / 12 - f * (1.0 / 120 - f * (1.0 / 252 - f * (1.0 / 240 - f / 132))))
    }

    fun beta(a: Double, b: Double): Double =
        if (a > 0 && b > 0) exp(lgamma(a) + lgamma(b) - lgamma(a + b)) else gamma(a) * gamma(b) / gamma(a + b)

    fun erf(x: Double): Double {
        if (x.isNaN()) return x
        val ax = abs(x)
        if (ax < 2.5) {
            var sum = x; var term = x; val x2 = x * x; var n = 0
            while (n < 200) {
                n++
                term *= -x2 / n
                val add = term / (2 * n + 1)
                sum += add
                if (abs(add) < 1e-17 * abs(sum)) break
            }
            return 2 / sqrt(PI) * sum
        }
        return sign(x) * (1 - erfcPos(ax))
    }

    fun erfc(x: Double): Double = if (x.isNaN()) x else if (x < 2.5) 1 - erf(x) else erfcPos(x)

    private fun erfcPos(x: Double): Double {
        var f = x
        for (n in 60 downTo 1) f = x + (n / 2.0) / f
        return exp(-x * x) / sqrt(PI) / f
    }

    fun erfinv(y: Double): Double {
        if (y.isNaN() || y < -1 || y > 1) return Double.NaN
        if (y == 1.0) return Double.POSITIVE_INFINITY
        if (y == -1.0) return Double.NEGATIVE_INFINITY
        var w = -ln((1 - y) * (1 + y))
        var x: Double
        if (w < 5) {
            w -= 2.5
            var p = 2.81022636e-08
            p = 3.43273939e-07 + p * w; p = -3.5233877e-06 + p * w; p = -4.39150654e-06 + p * w; p = 0.00021858087 + p * w
            p = -0.00125372503 + p * w; p = -0.00417768164 + p * w; p = 0.246640727 + p * w; p = 1.50140941 + p * w
            x = p * y
        } else {
            w = sqrt(w) - 3
            var p = -0.000200214257
            p = 0.000100950558 + p * w; p = 0.00134934322 + p * w; p = -0.00367342844 + p * w; p = 0.00573950773 + p * w
            p = -0.0076224613 + p * w; p = 0.00943887047 + p * w; p = 1.00167406 + p * w; p = 2.83297682 + p * w
            x = p * y
        }
        repeat(3) { val err = erf(x) - y; val d = 2 / sqrt(PI) * exp(-x * x); if (d > 0) x -= err / d }
        return x
    }

    fun zeta(s: Double): Double {
        if (s.isNaN() || s == 1.0) return Double.NaN
        if (s == 0.0) return -0.5
        if (s < 0.5) {
            if (s < 0 && s == floor(s) && abs(s.toLong()) % 2L == 0L) return 0.0
            return 2.0.pow(s) * PI.pow(s - 1) * sin(PI * s / 2) * gamma(1 - s) * zeta(1 - s)
        }
        if (s > 60) return 1 + 2.0.pow(-s)
        // Borwein's accelerated alternating series for η(s), then ζ = η / (1 − 2^(1−s)).
        val n = 40
        val d = DoubleArray(n + 1)
        var term = 1.0
        var acc = term
        d[0] = n * acc
        for (i in 0 until n) {
            term *= (n + i).toDouble() * 4 * (n - i) / ((2.0 * i + 1) * (2.0 * i + 2))
            acc += term
            d[i + 1] = n * acc
        }
        var sum = 0.0
        for (k in 0 until n) {
            val sgn = if (k % 2 == 0) 1.0 else -1.0
            sum += sgn * (d[k] - d[n]) / (k + 1.0).pow(s)
        }
        return -sum / (d[n] * (1 - 2.0.pow(1 - s)))
    }

    /** Lambert W: branch 0 (principal) or −1. */
    fun lambertW(x: Double, branch: Int = 0): Double {
        val lim = -1 / E
        if (x.isNaN() || x < lim - 1e-15) return Double.NaN
        if (abs(x - lim) <= 1e-15) return -1.0
        if (branch == -1 && x >= 0) return Double.NaN
        if (branch != 0 && branch != -1) return Double.NaN
        if (x == 0.0 && branch == 0) return 0.0
        if (x.isInfinite()) return if (branch == 0 && x > 0) x else Double.NaN
        var w = if (branch == 0) {
            when {
                x < -0.25 -> { val p = sqrt(2 * (E * x + 1)); -1 + p - p * p / 3 + 11.0 / 72 * p * p * p }
                x < 3 -> ln(1 + x) * 0.8
                else -> { val l1 = ln(x); l1 - ln(l1) }
            }
        } else {
            if (x < -0.25) { val p = -sqrt(2 * (E * x + 1)); -1 + p - p * p / 3 + 11.0 / 72 * p * p * p }
            else { val l1 = ln(-x); l1 - ln(-l1) }
        }
        for (i in 0 until 60) {
            val ew = exp(w)
            val f = w * ew - x
            val wp1 = w + 1
            val den = ew * wp1 - (w + 2) * f / (2 * wp1)
            if (den == 0.0 || !den.isFinite()) break
            val w1 = w - f / den
            if (abs(w1 - w) <= 1e-15 * (1 + abs(w1))) { w = w1; break }
            w = w1
        }
        return w
    }

    // ---- sine / cosine / exponential / logarithmic integrals
    /** Si and Ci together (Numerical Recipes cisi): series for x <= 2, complex continued fraction above. */
    private fun cisi(x: Double): DoubleArray {
        val t = abs(x)
        if (t == 0.0) return doubleArrayOf(Double.NEGATIVE_INFINITY, 0.0)
        if (t > 2) {
            // Lentz on the continued fraction for E1(i t), in hand-rolled complex arithmetic.
            var br = 1.0; val bi = t
            var cr = 1 / FPMIN; var cim = 0.0
            val den0 = br * br + bi * bi
            var dr = br / den0; var di = -bi / den0
            var hr = dr; var hi = di
            for (i in 2..200) {
                val a = -((i - 1).toDouble() * (i - 1))
                br += 2
                val xr = a * dr + br; val xi = a * di + bi          // d = 1 / (a d + b)
                val den = xr * xr + xi * xi
                dr = xr / den; di = -xi / den
                val cden = cr * cr + cim * cim                     // c = b + a / c
                val nr = br + a * cr / cden; val ni = bi - a * cim / cden
                cr = nr; cim = ni
                val delr = cr * dr - cim * di; val deli = cr * di + cim * dr
                val tr = hr * delr - hi * deli; val ti = hr * deli + hi * delr
                hr = tr; hi = ti
                if (abs(delr - 1) + abs(deli) < 1e-16) break
            }
            val c = cos(t); val sn = sin(t)                         // h *= (cos t - i sin t)
            val fr = c * hr + sn * hi; val fi = c * hi - sn * hr
            val siV = PI / 2 + fi
            return doubleArrayOf(-fr, if (x < 0) -siV else siV)
        }
        var sumC = 0.0; var sumS = 0.0
        var term = 1.0; var odd = true; var sgn = 1.0
        var k = 1
        while (k < 100) {
            term *= t / k
            val add = term / k
            if (odd) sumS += sgn * add else { sgn = -sgn; sumC += sgn * add }
            if (add < 1e-17 * max(abs(sumS), abs(sumC)).coerceAtLeast(1e-300)) break
            odd = !odd; k++
        }
        return doubleArrayOf(MathEngine.EULER_GAMMA + ln(t) + sumC, if (x < 0) -sumS else sumS)
    }

    fun si(x: Double): Double = if (x.isNaN()) x else if (x.isInfinite()) sign(x) * PI / 2 else cisi(x)[1]

    fun ci(x: Double): Double = if (x.isNaN() || x < 0) Double.NaN else if (x.isInfinite()) 0.0 else cisi(x)[0]

    fun ei(x: Double): Double {
        if (x.isNaN()) return x
        if (x == 0.0) return Double.NEGATIVE_INFINITY
        if (x < 0) return -e1(-x)
        if (x < 40) {
            var sum = 0.0; var t = 1.0; var k = 1
            while (k < 500) {
                t *= x / k
                val add = t / k
                sum += add
                if (add < 1e-17 * sum) break
                k++
            }
            return MathEngine.EULER_GAMMA + ln(x) + sum
        }
        var sum = 1.0; var t = 1.0; var k = 1
        while (k < 60) { val nt = t * k / x; if (nt > t) break; t = nt; sum += t; k++ }
        return exp(x) / x * sum
    }

    private fun e1(x: Double): Double {
        if (x <= 1) {
            var sum = 0.0; var t = 1.0; var k = 1
            while (k < 200) {
                t *= -x / k
                val add = t / k
                sum += add
                if (abs(add) < 1e-17 * max(1.0, abs(sum))) break
                k++
            }
            return -MathEngine.EULER_GAMMA - ln(x) - sum
        }
        var b = x + 1; var c = 1 / FPMIN; var d = 1 / b; var h = d
        for (i in 1..300) {
            val an = -(i.toDouble() * i)
            b += 2
            d = 1 / (an * d + b)
            c = b + an / c
            val del = c * d
            h *= del
            if (abs(del - 1) < 1e-16) break
        }
        return h * exp(-x)
    }

    fun li(x: Double): Double = if (x.isNaN() || x < 0) Double.NaN else if (x == 0.0) 0.0 else if (x == 1.0) Double.NEGATIVE_INFINITY else ei(ln(x))

    fun fresnelS(x: Double): Double = if (!x.isFinite()) (if (x.isNaN()) x else sign(x) * 0.5) else
        Calc.integrate({ t -> sin(PI * t * t / 2) }, 0.0, x, panels = 8 + (abs(x) * abs(x) / 2).toInt().coerceAtMost(400))
    fun fresnelC(x: Double): Double = if (!x.isFinite()) (if (x.isNaN()) x else sign(x) * 0.5) else
        Calc.integrate({ t -> cos(PI * t * t / 2) }, 0.0, x, panels = 8 + (abs(x) * abs(x) / 2).toInt().coerceAtMost(400))

    /** Complete elliptic integral of the first kind, parameter m = k². */
    fun ellipK(m: Double): Double {
        if (m.isNaN() || m > 1) return Double.NaN
        if (m == 1.0) return Double.POSITIVE_INFINITY
        var a = 1.0; var b = sqrt(1 - m)
        repeat(60) { val an = (a + b) / 2; b = sqrt(a * b); a = an; if (abs(a - b) < 1e-16 * a) return PI / (2 * a) }
        return PI / (2 * a)
    }

    /** Complete elliptic integral of the second kind, parameter m = k². */
    fun ellipE(m: Double): Double {
        if (m.isNaN() || m > 1) return Double.NaN
        if (m == 1.0) return 1.0
        var a = 1.0; var b = sqrt(1 - m)
        var sum = m / 2; var pow2 = 0.5
        for (i in 0 until 60) {
            val c = (a - b) / 2
            val an = (a + b) / 2; b = sqrt(a * b); a = an
            pow2 *= 2
            sum += pow2 * c * c
            if (abs(c) < 1e-17) break
        }
        return PI / (2 * a) * (1 - sum)
    }

    // ---- Bessel functions (integral representations; exponentially convergent trapezoid for integer order)
    private fun isInt(v: Double) = v == floor(v) && abs(v) < 1e6

    /** Upper cutoff T where the integrand e^(−x·φ(t) + |ν|t) has decayed past e^-60. */
    private fun cutoff(x: Double, nu: Double, phi: (Double) -> Double): Double {
        var t = 1.0
        while (t < 60 && x * phi(t) - abs(nu) * t < 60) t *= 1.5
        return t
    }

    fun besselJ(nu: Double, x: Double): Double {
        if (nu.isNaN() || x.isNaN()) return Double.NaN
        if (isInt(nu)) {
            val n = nu
            val N = (abs(x) + abs(n)).toInt().coerceAtMost(40_000) + 64
            var s = 0.0
            for (k in 0 until N) { val tk = 2 * PI * k / N; s += cos(n * tk - x * sin(tk)) }
            return s / N
        }
        if (x < 0) return Double.NaN
        if (x == 0.0) return if (nu > 0) 0.0 else Double.NaN
        val p = cutoff(x, nu) { sinh(it) }
        val a = Calc.integrate({ th -> cos(nu * th - x * sin(th)) }, 0.0, PI, panels = 8 + (x / 2).toInt().coerceAtMost(400)) / PI
        val b = sin(nu * PI) / PI * Calc.integrate({ t -> exp(-x * sinh(t) - nu * t) }, 0.0, p)
        return a - b
    }

    fun besselY(nu: Double, x: Double): Double {
        if (nu.isNaN() || x.isNaN() || x <= 0) return if (x == 0.0) Double.NEGATIVE_INFINITY else Double.NaN
        val p = cutoff(x, nu) { sinh(it) }
        val a = Calc.integrate({ th -> sin(x * sin(th) - nu * th) }, 0.0, PI, panels = 8 + (x / 2).toInt().coerceAtMost(400)) / PI
        val cn = cos(nu * PI)
        val b = Calc.integrate({ t -> (exp(nu * t) + exp(-nu * t) * cn) * exp(-x * sinh(t)) }, 0.0, p) / PI
        return a - b
    }

    fun besselI(nu: Double, x: Double): Double {
        if (nu.isNaN() || x.isNaN()) return Double.NaN
        if (isInt(nu)) {
            val N = (abs(x) + abs(nu)).toInt().coerceAtMost(40_000) + 64
            var s = 0.0
            for (k in 0 until N) { val tk = 2 * PI * k / N; s += exp(x * cos(tk)) * cos(nu * tk) }
            return s / N
        }
        if (x < 0) return Double.NaN
        if (x == 0.0) return if (nu > 0) 0.0 else Double.NaN
        val a = Calc.integrate({ th -> exp(x * cos(th)) * cos(nu * th) }, 0.0, PI) / PI
        val p = cutoff(x, nu) { cosh(it) }
        val b = sin(nu * PI) / PI * Calc.integrate({ t -> exp(-x * cosh(t) - nu * t) }, 0.0, p)
        return a - b
    }

    fun besselK(nu: Double, x: Double): Double {
        if (nu.isNaN() || x.isNaN() || x < 0) return Double.NaN
        if (x == 0.0) return Double.POSITIVE_INFINITY
        val p = cutoff(x, nu) { cosh(it) }
        return Calc.integrate({ t -> exp(-x * cosh(t)) * cosh(nu * t) }, 0.0, p)
    }

    fun airyAi(x: Double): Double {
        if (x.isNaN()) return x
        if (abs(x) < 1e-8) return 0.3550280538878172 - 0.2588194037928068 * x
        val z = 2.0 / 3 * abs(x).pow(1.5)
        return if (x > 0) sqrt(x / 3) / PI * besselK(1.0 / 3, z)
        else sqrt(-x) / 3 * (besselJ(1.0 / 3, z) + besselJ(-1.0 / 3, z))
    }

    fun airyBi(x: Double): Double {
        if (x.isNaN()) return x
        if (abs(x) < 1e-8) return 0.6149266274460007 + 0.4482883573538264 * x
        val z = 2.0 / 3 * abs(x).pow(1.5)
        return if (x > 0) sqrt(x / 3) * (besselI(-1.0 / 3, z) + besselI(1.0 / 3, z))
        else sqrt(-x / 3) * (besselJ(-1.0 / 3, z) - besselJ(1.0 / 3, z))
    }

    // ---- incomplete gamma / beta (regularized)
    fun gammaP(a: Double, x: Double): Double {
        if (a.isNaN() || x.isNaN() || x < 0 || a <= 0) return Double.NaN
        if (x == 0.0) return 0.0
        if (x.isInfinite()) return 1.0
        val gln = lgamma(a)
        if (x < a + 1) {
            var ap = a; var sum = 1 / a; var del = sum
            for (n in 1..1000) { ap += 1; del *= x / ap; sum += del; if (abs(del) < abs(sum) * 1e-16) break }
            return sum * exp(-x + a * ln(x) - gln)
        }
        return 1 - gammaQcf(a, x, gln)
    }

    fun gammaQ(a: Double, x: Double): Double {
        if (a.isNaN() || x.isNaN() || x < 0 || a <= 0) return Double.NaN
        if (x == 0.0) return 1.0
        if (x.isInfinite()) return 0.0
        return if (x < a + 1) 1 - gammaP(a, x) else gammaQcf(a, x, lgamma(a))
    }

    private fun gammaQcf(a: Double, x: Double, gln: Double): Double {
        var b = x + 1 - a; var c = 1 / FPMIN; var d = 1 / b; var h = d
        for (i in 1..1000) {
            val an = -i * (i - a)
            b += 2
            d = an * d + b; if (abs(d) < FPMIN) d = FPMIN
            c = b + an / c; if (abs(c) < FPMIN) c = FPMIN
            d = 1 / d
            val del = d * c
            h *= del
            if (abs(del - 1) < 1e-16) break
        }
        return exp(-x + a * ln(x) - gln) * h
    }

    fun betaI(x: Double, a: Double, b: Double): Double {
        if (x.isNaN() || a.isNaN() || b.isNaN() || x < 0 || x > 1 || a <= 0 || b <= 0) return Double.NaN
        if (x == 0.0 || x == 1.0) return x
        val bt = exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * ln(x) + b * ln(1 - x))
        return if (x < (a + 1) / (a + b + 2)) bt * betacf(a, b, x) / a else 1 - bt * betacf(b, a, 1 - x) / b
    }

    private fun betacf(a: Double, b: Double, x: Double): Double {
        val qab = a + b; val qap = a + 1; val qam = a - 1
        var c = 1.0
        var d = 1 - qab * x / qap; if (abs(d) < FPMIN) d = FPMIN
        d = 1 / d
        var h = d
        for (m in 1..500) {
            val m2 = 2.0 * m
            var aa = m * (b - m) * x / ((qam + m2) * (a + m2))
            d = 1 + aa * d; if (abs(d) < FPMIN) d = FPMIN
            c = 1 + aa / c; if (abs(c) < FPMIN) c = FPMIN
            d = 1 / d; h *= d * c
            aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
            d = 1 + aa * d; if (abs(d) < FPMIN) d = FPMIN
            c = 1 + aa / c; if (abs(c) < FPMIN) c = FPMIN
            d = 1 / d
            val del = d * c
            h *= del
            if (abs(del - 1) < 1e-15) break
        }
        return h
    }

    // ---- combinatorics / number theory / statistics
    fun nCr(n: Double, k: Double): Double {
        if (n.isNaN() || k.isNaN()) return Double.NaN
        if (n == floor(n) && k == floor(k) && n >= 0) {
            if (k < 0 || k > n) return 0.0
            val kk = min(k, n - k)
            if (kk > 600) return Math.rint(exp(lgamma(n + 1) - lgamma(kk + 1) - lgamma(n - kk + 1)))
            var r = 1.0
            var i = 1.0
            while (i <= kk) { r = r * (n - kk + i) / i; i += 1 }
            return Math.rint(r)
        }
        return gamma(n + 1) / (gamma(k + 1) * gamma(n - k + 1))
    }

    fun gcd(a: Double, b: Double): Double {
        if (a.isNaN() || b.isNaN() || abs(a) > 9e15 || abs(b) > 9e15) return Double.NaN
        var x = abs(Math.rint(a)).toLong(); var y = abs(Math.rint(b)).toLong()
        while (y != 0L) { val t = x % y; x = y; y = t }
        return x.toDouble()
    }

    fun lcm(a: Double, b: Double): Double {
        val g = gcd(a, b)
        if (g.isNaN()) return g
        if (g == 0.0) return 0.0
        return abs(Math.rint(a) / g * Math.rint(b))
    }

    fun isPrime(v: Double): Double {
        if (v.isNaN() || v != floor(v) || v < 2 || v > 1e15) return 0.0
        val n = v.toLong()
        if (n < 4) return 1.0
        if (n % 2L == 0L || n % 3L == 0L) return 0.0
        var i = 5L
        while (i * i <= n) { if (n % i == 0L || n % (i + 2) == 0L) return 0.0; i += 6 }
        return 1.0
    }

    fun variance(a: DoubleArray, sample: Boolean): Double {
        val n = a.size
        if (n == 0 || (sample && n < 2)) return Double.NaN
        val m = a.average()
        var s = 0.0
        for (v in a) s += (v - m) * (v - m)
        return s / (if (sample) n - 1 else n)
    }

    fun binomPdf(k: Double, n: Double, p: Double): Double {
        if (k < 0 || k > n || k != floor(k) || p < 0 || p > 1) return 0.0
        if (p == 0.0) return if (k == 0.0) 1.0 else 0.0
        if (p == 1.0) return if (k == n) 1.0 else 0.0
        return exp(lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1) + k * ln(p) + (n - k) * ln(1 - p))
    }

}
