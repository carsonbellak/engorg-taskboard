package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.text.InputType
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Desmos-style math input: you type and it builds the math as you go. "/" makes a fraction (the
 * term before the cursor becomes the numerator), "^" an exponent, "_" a subscript, "(" and "|" a
 * pair of stretchy brackets, and typing sqrt, int, sum or prod makes a √, ∫, Σ or Π whose slots
 * (radicand, lower / upper bound, body, variable) you tap to fill in. Space moves to the next slot.
 *
 * The structure is the source of truth while editing; [text] serializes it to the grapher's plain
 * syntax (what [MathEngine] parses and what rows store), and [setText] rebuilds it from that syntax.
 */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class MathField(context: Context) : View(context) {

    // ================================================================== model
    abstract class Node { var parent: Block? = null; open val blocks: List<Block> get() = emptyList() }
    class Block { var owner: Node? = null; val nodes = ArrayList<Node>() }
    class Ch(val c: Char) : Node()
    class Frac(val num: Block, val den: Block) : Node() { override val blocks get() = listOf(num, den) }
    class Pow(val exp: Block) : Node() { override val blocks get() = listOf(exp) }
    class Sub(val sub: Block) : Node() { override val blocks get() = listOf(sub) }
    class Root(val rad: Block, val idx: Block?) : Node() { override val blocks get() = listOfNotNull(idx, rad) }
    class Paren(val inner: Block, val kind: Char) : Node() { override val blocks get() = listOf(inner) }
    /** ∫ (blocks: lower, upper, body, variable) or Σ / Π (variable, lower, upper, body). */
    class BigOp(val kind: Char, val lo: Block, val hi: Block, val body: Block, val v: Block) : Node() {
        override val blocks get() = if (kind == '∫') listOf(lo, hi, body, v) else listOf(v, lo, hi, body)
    }

    private fun <T : Node> own(n: T): T { n.blocks.forEach { it.owner = n }; return n }
    private fun block(vararg cs: Char) = Block().also { b -> cs.forEach { c -> b.nodes.add(Ch(c).also { it.parent = b }) } }

    private var root = Block()
    private var cb = root          // cursor block
    private var ci = 0             // cursor index within it

    var size = 40f
        set(v) { field = v; relayout() }
    var color = Color.BLACK
        set(v) { field = v; invalidate() }
    var hint = ""
    var onChange: ((String) -> Unit)? = null
    var onEnter: (() -> Unit)? = null
    var onFocus: ((Boolean) -> Unit)? = null

    init {
        isFocusable = true; isFocusableInTouchMode = true
    }

    // ================================================================== text <-> structure
    /** The grapher's plain syntax for what's in the field. */
    fun text(): String = ser(root)

    private fun ser(b: Block): String {
        val sb = StringBuilder()
        var k = 0
        while (k < b.nodes.size) {
            val n = b.nodes[k]
            when (n) {
                is Ch -> sb.append(when (n.c) { '−' -> '-'; '·', '×' -> '*'; else -> n.c })
                is Frac -> {
                    // d/dx stays in the engine's derivative syntax.
                    val num = ser(n.num); val den = ser(n.den)
                    if (num == "d" && den.length >= 2 && den[0] == 'd') sb.append(" d/").append(den).append(' ')
                    else sb.append("((").append(num).append(")/(").append(den).append("))")
                }
                is Pow -> sb.append("^(").append(ser(n.exp)).append(')')
                is Sub -> sb.append('_').append(ser(n.sub).filter { it.isLetterOrDigit() })
                is Root -> if (n.idx == null) sb.append("sqrt(").append(ser(n.rad)).append(')') else sb.append("root(").append(ser(n.rad)).append(',').append(ser(n.idx)).append(')')
                is Paren -> when (n.kind) { '|' -> sb.append("abs(").append(ser(n.inner)).append(')'); else -> sb.append('(').append(ser(n.inner)).append(')') }
                is BigOp -> {
                    val name = when (n.kind) { '∫' -> "int"; 'Σ' -> "sum"; else -> "prod" }
                    sb.append(name).append("((").append(ser(n.body)).append("),").append(ser(n.v).ifBlank { if (n.kind == '∫') "x" else "n" })
                        .append(",(").append(ser(n.lo)).append("),(").append(ser(n.hi)).append("))")
                }
            }
            k++
        }
        return sb.toString()
    }

    /** Rebuild the structure from plain syntax ([parsed] = its parse, when the caller has one). */
    fun setText(src: String, parsed: MathEngine.Statement? = null) {
        root = Block()
        val st = parsed ?: try { MathEngine.parseStatement(src, emptySet(), emptySet()) } catch (_: Exception) { null }
        if (st != null && src.isNotBlank()) {
            try { stmtInto(st, root) } catch (_: Exception) { root = Block(); typeLiterally(src, root) }
        } else typeLiterally(src, root)
        cb = root; ci = root.nodes.size
        relayout()
    }

    /** Fallback for text that doesn't parse: replay it as keystrokes so brackets still pair up. */
    private fun typeLiterally(src: String, into: Block) {
        cb = into; ci = into.nodes.size
        for (ch in src) type(ch, notify = false, auto = false)
    }

    private fun stmtInto(st: MathEngine.Statement, b: Block) {
        emit(st.lhs, b, 0)
        if (st.rhs != null) { add(b, Ch('=')); emit(st.rhs, b, 0) }
    }

    private fun add(b: Block, n: Node) { n.parent = b; b.nodes.add(n) }
    private fun chars(b: Block, s: String) { for (c in s) add(b, Ch(c)) }

    // precedence (as in MathTypeset)
    private fun prec(e: Ex): Int = when (e) {
        is Ex.Num -> if (e.v < 0) 3 else 5
        is Ex.Var, is Ex.Tuple, is Ex.Piece -> 5
        is Ex.Neg -> 3
        is Ex.Bin -> when (e.op) { "+", "-" -> 1; "*", "/", "%" -> 2; "^" -> 4; else -> 0 }
        is Ex.Chain -> 0
        is Ex.Deriv -> 2
        is Ex.Call -> when (MathEngine.canonical(e.name)) { "int", "integral", "sum", "prod", "lim", "limit", "deriv", "diff", "mod" -> 2; else -> 5 }
    }

    private var marker: Pair<Block, Int>? = null
    private val CURSOR = "zzcur"

    private fun emit(e: Ex, b: Block, minPrec: Int) {
        if (prec(e) < minPrec) {
            val p = own(Paren(Block(), '(')); add(b, p); emit(e, p.inner, 0); return
        }
        when (e) {
            is Ex.Num -> {
                val v = e.v
                chars(b, if (v.isInfinite()) "∞" else if (v == floor(v) && abs(v) < 1e15) v.toLong().toString() else java.math.BigDecimal(v.toString()).stripTrailingZeros().toPlainString())
            }
            is Ex.Var -> name(e.name, b)
            is Ex.Neg -> { add(b, Ch('−')); emit(e.a, b, 2) }
            is Ex.Tuple -> { val p = own(Paren(Block(), '(')); add(b, p); e.items.forEachIndexed { i, it -> if (i > 0) add(p.inner, Ch(',')); emit(it, p.inner, 0) } }
            is Ex.Chain -> e.items.forEachIndexed { i, it -> if (i > 0) add(b, Ch(cmp(e.ops[i - 1]))); emit(it, b, 1) }
            is Ex.Piece -> {
                add(b, Ch('{'))
                e.cases.forEachIndexed { i, (cond, v) -> if (i > 0) add(b, Ch(',')); emit(cond, b, 0); if (v != null) { add(b, Ch(':')); emit(v, b, 0) } }
                e.otherwise?.let { add(b, Ch(',')); emit(it, b, 0) }
                add(b, Ch('}'))
            }
            is Ex.Deriv -> { derivHead(e.v, b); val p = own(Paren(Block(), '(')); add(b, p); emit(e.a, p.inner, 0) }
            is Ex.Bin -> when (e.op) {
                "+" -> { emit(e.a, b, 1); add(b, Ch('+')); emit(e.b, b, if (e.b is Ex.Neg) 5 else 1) }
                "-" -> { emit(e.a, b, 1); add(b, Ch('−')); emit(e.b, b, 2) }
                "*" -> {
                    val a0 = e.a
                    if (a0 is Ex.Var && a0.name == CURSOR) { name(CURSOR, b); emit(e.b, b, 2); return }   // "§9": cursor, then 9
                    emit(e.a, b, 2)
                    val lead = leading(e.b)
                    if (lead is Ex.Num || e.b is Ex.Neg) add(b, Ch('·'))
                    emit(e.b, b, if (e.b is Ex.Neg) 5 else 2)
                }
                "/" -> { val f = own(Frac(Block(), Block())); add(b, f); emit(e.a, f.num, 0); emit(e.b, f.den, 0) }
                "%" -> { emit(e.a, b, 2); chars(b, "mod"); emit(e.b, b, 4) }
                "^" -> {
                    val base = e.a
                    if (base is Ex.Bin && base.op == "/") { val p = own(Paren(Block(), '(')); add(b, p); emit(base, p.inner, 0) } else emit(base, b, 5)
                    val pw = own(Pow(Block())); add(b, pw); emit(e.b, pw.exp, 0)
                }
                else -> { emit(e.a, b, 1); add(b, Ch(cmp(e.op))); emit(e.b, b, 1) }
            }
            is Ex.Call -> call(e, b)
        }
    }

    private fun leading(e: Ex): Ex = if (e is Ex.Bin && (e.op == "*" || e.op == "^")) leading(e.a) else e
    private fun cmp(op: String) = when (op) { "<=" -> '≤'; ">=" -> '≥'; "!=" -> '≠'; "==" -> '='; "<" -> '<'; ">" -> '>'; else -> '=' }

    private fun name(n: String, b: Block) {
        if (n == CURSOR) { marker = b to b.nodes.size; return }
        when (n) {
            "theta" -> { add(b, Ch('θ')); return }; "pi" -> { add(b, Ch('π')); return }; "tau" -> { add(b, Ch('τ')); return }
            "phi" -> { add(b, Ch('φ')); return }; "inf", "infinity" -> { add(b, Ch('∞')); return }
        }
        val us = n.indexOf('_')
        if (us > 0 && us < n.length - 1) { chars(b, n.substring(0, us)); val s = own(Sub(Block())); add(b, s); chars(s.sub, n.substring(us + 1)); return }
        chars(b, n)
    }

    private fun derivHead(v: String, b: Block) {
        val f = own(Frac(block('d'), Block())); add(b, f); add(f.den, Ch('d')); name(v, f.den)
    }

    private fun call(e: Ex.Call, b: Block) {
        val c = MathEngine.canonical(e.name); val a = e.args
        fun paren(args: List<Ex>) { val p = own(Paren(Block(), '(')); add(b, p); args.forEachIndexed { i, it -> if (i > 0) add(p.inner, Ch(',')); emit(it, p.inner, 0) } }
        if (MathEngine.isBuiltinFn(e.name) && e.primes == 0) when {
            c == "sqrt" && a.size == 1 -> { val r = own(Root(Block(), null)); add(b, r); emit(a[0], r.rad, 0); return }
            c == "cbrt" && a.size == 1 -> { val r = own(Root(Block(), block('3'))); add(b, r); emit(a[0], r.rad, 0); return }
            c == "root" && a.size == 2 -> { val r = own(Root(Block(), Block())); add(b, r); emit(a[0], r.rad, 0); emit(a[1], r.idx!!, 0); return }
            c == "abs" && a.size == 1 -> { val p = own(Paren(Block(), '|')); add(b, p); emit(a[0], p.inner, 0); return }
            (c == "int" || c == "integral") && (a.size == 4 || a.size == 3) -> {
                val op = own(BigOp('∫', Block(), Block(), Block(), Block())); add(b, op)
                if (a.size == 4) { emit(a[2], op.lo, 0); emit(a[3], op.hi, 0); emit(a[1], op.v, 0) }
                else { emit(a[1], op.lo, 0); emit(a[2], op.hi, 0); name(if (MathEngine.mentions(a[0], "t")) "t" else "x", op.v) }
                emit(a[0], op.body, 0); return
            }
            (c == "sum" || c == "prod") && a.size == 4 -> {
                val op = own(BigOp(if (c == "sum") 'Σ' else 'Π', Block(), Block(), Block(), Block())); add(b, op)
                emit(a[1], op.v, 0); emit(a[2], op.lo, 0); emit(a[3], op.hi, 0); emit(a[0], op.body, 0); return
            }
            c == "exp" && a.size == 1 -> { add(b, Ch('e')); val pw = own(Pow(Block())); add(b, pw); emit(a[0], pw.exp, 0); return }
            c == "factorial" && a.size == 1 -> { emit(a[0], b, 5); add(b, Ch('!')); return }
            c == "logb" && a.size == 2 -> { chars(b, "log"); val s = own(Sub(Block())); add(b, s); emit(a[0], s.sub, 0); paren(a.drop(1)); return }
            c == "log10" && a.size == 1 -> { chars(b, "log"); val s = own(Sub(block('1', '0'))); add(b, s); paren(a); return }
            c == "log2" && a.size == 1 -> { chars(b, "log"); val s = own(Sub(block('2'))); add(b, s); paren(a); return }
            (c == "deriv" || c == "diff") && a.size == 2 && a[1] is Ex.Var -> { derivHead((a[1] as Ex.Var).name, b); paren(a.take(1)); return }
        }
        chars(b, e.name); repeat(e.primes) { add(b, Ch('\'')) }
        paren(a)
    }

    // ================================================================== editing
    private fun insert(n: Node) { n.parent = cb; cb.nodes.add(ci, n); ci++ }

    private fun enter(b: Block, atEnd: Boolean = false) { cb = b; ci = if (atEnd) b.nodes.size else 0 }

    /** Put the cursor right after [n] in its parent block. */
    private fun exitAfter(n: Node) { val p = n.parent ?: return; cb = p; ci = p.nodes.indexOf(n) + 1 }
    private fun exitBefore(n: Node) { val p = n.parent ?: return; cb = p; ci = p.nodes.indexOf(n) }

    private val OPS = setOf('+', '−', '=', '<', '>', '≤', '≥', '≠', ',', ':', '·')
    private var swallowParen = false

    /** One keystroke. */
    fun type(ch: Char, notify: Boolean = true, auto: Boolean = true) {
        val c = when (ch) { '-' -> '−'; '*' -> '·'; else -> ch }
        val swallow = swallowParen; swallowParen = false
        when {
            c == '/' -> makeFrac()
            c == '^' -> { val p = own(Pow(Block())); insert(p); enter(p.exp) }
            c == '_' -> { val s = own(Sub(Block())); insert(s); enter(s.sub) }
            c == '(' || c == '[' -> if (!swallow) { val p = own(Paren(Block(), '(')); insert(p); enter(p.inner) }
            c == ')' || c == ']' -> closeParen()
            c == '|' -> {
                val o = cb.owner
                if (o is Paren && o.kind == '|' && ci == cb.nodes.size) exitAfter(o)
                else { val p = own(Paren(Block(), '|')); insert(p); enter(p.inner) }
            }
            c == ' ' -> nextSlot()
            c == '\n' -> { onEnter?.invoke(); return }
            c.isLetterOrDigit() || c in OPS || c in ".!'{}%π∞θτφ" -> { insert(Ch(c)); if (auto && c.isLetter()) autoCommand() }
            else -> return
        }
        changed(notify)
    }

    /** Typed names that become structures or symbols (longest first). */
    private val COMMANDS = listOf("nthroot", "theta", "sqrt", "prod", "int", "sum", "tau", "phi", "inf", "pi")

    private fun autoCommand() {
        val sb = StringBuilder()
        var k = ci - 1
        while (k >= 0) { val n = cb.nodes[k]; if (n is Ch && n.c.isLetter()) { sb.insert(0, n.c); k-- } else break }
        val run = sb.toString()
        val cmd = COMMANDS.firstOrNull { run.endsWith(it) } ?: return
        repeat(cmd.length) { cb.nodes.removeAt(ci - 1); ci-- }
        when (cmd) {
            "sqrt" -> { val r = own(Root(Block(), null)); insert(r); enter(r.rad); swallowParen = true }
            "nthroot" -> { val r = own(Root(Block(), Block())); insert(r); enter(r.idx!!); swallowParen = true }
            "int" -> { val op = own(BigOp('∫', Block(), Block(), Block(), block('x'))); op.v.nodes.forEach { it.parent = op.v }; insert(op); enter(op.lo) }
            "sum", "prod" -> { val op = own(BigOp(if (cmd == "sum") 'Σ' else 'Π', Block(), Block(), Block(), block('n'))); op.v.nodes.forEach { it.parent = op.v }; insert(op); enter(op.lo) }
            "theta" -> insert(Ch('θ')); "pi" -> insert(Ch('π')); "tau" -> insert(Ch('τ')); "phi" -> insert(Ch('φ')); "inf" -> insert(Ch('∞'))
        }
    }

    /** "/" — the term before the cursor becomes the numerator (empty if there is none). */
    private fun makeFrac() {
        var k = ci
        while (k > 0) {
            val n = cb.nodes[k - 1]
            if (n is Ch && (n.c in OPS)) break
            k--
        }
        val f = own(Frac(Block(), Block()))
        val taken = ArrayList(cb.nodes.subList(k, ci))
        repeat(taken.size) { cb.nodes.removeAt(k) }
        ci = k
        for (n in taken) { n.parent = f.num; f.num.nodes.add(n) }
        insert(f)
        enter(if (taken.isEmpty()) f.num else f.den)
    }

    private fun closeParen() {
        var b: Block? = cb
        while (b != null) {
            val o = b.owner ?: break
            if (o is Paren && o.kind == '(') { exitAfter(o); return }
            b = o.parent
        }
        cb.owner?.let { exitAfter(it) }
    }

    /** Space / → : the next slot of the structure the cursor is in, else out past it. */
    private fun nextSlot() {
        val o = cb.owner ?: return
        val bs = o.blocks
        val i = bs.indexOf(cb)
        if (i >= 0 && i < bs.size - 1) enter(bs[i + 1]) else exitAfter(o)
    }

    fun backspace(notify: Boolean = true) {
        if (ci > 0) {
            val n = cb.nodes[ci - 1]
            if (n is Ch || n.blocks.all { it.nodes.isEmpty() }) { cb.nodes.removeAt(ci - 1); ci-- }
            else enter(n.blocks.last(), atEnd = true)   // step into it, like Desmos
        } else {
            val o = cb.owner ?: return
            if (o.blocks.all { it.nodes.isEmpty() }) { val p = o.parent!!; val i = p.nodes.indexOf(o); p.nodes.removeAt(i); cb = p; ci = i }
            else exitBefore(o)
        }
        changed(notify)
    }

    fun moveLeft() {
        if (ci > 0) { val n = cb.nodes[ci - 1]; if (n is Ch) ci-- else enter(n.blocks.last(), atEnd = true) }
        else { val o = cb.owner ?: return; val bs = o.blocks; val i = bs.indexOf(cb); if (i > 0) enter(bs[i - 1], atEnd = true) else exitBefore(o) }
        changed(false)
    }

    fun moveRight() {
        if (ci < cb.nodes.size) { val n = cb.nodes[ci]; if (n is Ch) ci++ else enter(n.blocks.first()) }
        else nextSlot()
        changed(false)
    }

    /**
     * Insert a palette template in the plain syntax, with "§" marking where the cursor lands
     * ("sqrt(§)", "int(§, x, 0, 1)", "^2"…). Parsed into structure when it parses; otherwise typed.
     */
    fun insertTemplate(tpl: String) {
        val t = tpl.trim().ifEmpty { tpl }
        if (t == "(§)") { type('('); changed(true); return }
        if (t.startsWith("^") || t == "/" || t == "!" || t.length == 1) {
            for (ch in t) if (ch != '§') type(ch, notify = false)
            if (t.startsWith("^") && t.length > 1 && !t.contains('§')) cb.owner?.let { if (it is Pow) exitAfter(it) }
            changed(true); return
        }
        val st = try { MathEngine.parseStatement(t.replace("§", "$CURSOR "), emptySet(), setOf(CURSOR)) } catch (_: Exception) { null }
        if (st != null) {
            marker = null
            val tmp = Block()
            stmtInto(st, tmp)
            val m = marker
            val at = ci
            for ((k, n) in tmp.nodes.withIndex()) { n.parent = cb; cb.nodes.add(at + k, n) }
            ci = at + tmp.nodes.size
            if (m != null) { if (m.first === tmp) { ci = at + m.second } else { cb = m.first; ci = m.second } }
            marker = null
        } else {
            var mk: Pair<Block, Int>? = null
            for (ch in t) if (ch == '§') mk = cb to ci else if (ch != ' ') type(ch, notify = false)
            mk?.let { cb = it.first; ci = it.second.coerceAtMost(it.first.nodes.size) }
        }
        changed(true)
    }

    fun clear() { root = Block(); cb = root; ci = 0; changed(true) }
    fun isEmpty() = root.nodes.isEmpty()

    private fun changed(notify: Boolean) {
        relayout()
        blinkOn = true
        if (notify) onChange?.invoke(text())
    }

    // ================================================================== layout
    private val SERIF = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
    private val SERIF_IT = Typeface.create(Typeface.SERIF, Typeface.ITALIC)
    private val tp = Paint(Paint.ANTI_ALIAS_FLAG)
    private val lp = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val holeP = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    /** A laid-out block: its items, the x of each gap between nodes, and (after placement) where it sits. */
    private inner class BBox(val block: Block, val size: Float) {
        val items = ArrayList<NBox>()
        val gaps = FloatArray(block.nodes.size + 1)
        var w = 0f; var asc = 0f; var desc = 0f
        var ax = 0f; var ay = 0f
        val empty = block.nodes.isEmpty()

        init {
            curSizeStack.add(size)
            try { lay() } finally { curSizeStack.removeAt(curSizeStack.size - 1) }
        }

        private fun lay() {
            if (empty) { w = size * 0.6f; asc = size * 0.72f; desc = size * 0.2f; gaps[0] = if (block === root) 0f else w / 2 }
            else {
                val upright = uprightFlags(block)
                var pen = 0f
                var prev: NBox? = null
                for ((k, n) in block.nodes.withIndex()) {
                    gaps[k] = pen
                    val nb = build(n, k, upright, prev)
                    nb.x = pen
                    when (n) {
                        is Pow -> nb.shift = -max((prev?.asc ?: size * 0.7f) * 0.55f, size * 0.4f)
                        is Sub -> nb.shift = max((prev?.desc ?: 0f) + size * 0.05f, size * 0.22f)
                    }
                    items.add(nb)
                    pen += nb.w
                    asc = max(asc, nb.asc - nb.shift); desc = max(desc, nb.desc + nb.shift)
                    if (n !is Pow && n !is Sub) prev = nb
                }
                gaps[block.nodes.size] = pen
                w = pen
                asc = max(asc, size * 0.72f); desc = max(desc, size * 0.2f)
            }
        }
    }

    private abstract inner class NBox {
        var w = 0f; var asc = 0f; var desc = 0f; var x = 0f; var shift = 0f
        open val kids: List<Pair<BBox, FloatArray>> get() = emptyList()   // child block + (dx, dy) of its baseline
        abstract fun draw(c: Canvas, ox: Float, oy: Float)
    }

    private inner class TextNB(val s: String, val sz: Float, val italic: Boolean, val padL: Float, val padR: Float) : NBox() {
        init {
            tp.typeface = if (italic) SERIF_IT else SERIF; tp.textSize = sz
            w = padL + tp.measureText(s) + padR + (if (italic) sz * 0.03f else 0f)
            asc = sz * 0.72f; desc = sz * 0.22f
        }
        override fun draw(c: Canvas, ox: Float, oy: Float) {
            tp.typeface = if (italic) SERIF_IT else SERIF; tp.textSize = sz; tp.color = color
            c.drawText(s, ox + padL, oy, tp)
        }
    }

    private inner class FracNB(n: Frac, sz: Float) : NBox() {
        val inner = sz * (if (depthOf(n) >= 1) 0.86f else 0.95f)
        val num = BBox(n.num, inner); val den = BBox(n.den, inner)
        val thick = max(1f, sz * 0.055f); val gap = sz * 0.12f; val axis = sz * 0.27f; val pad = sz * 0.1f
        init {
            w = max(num.w, den.w) + 2 * pad
            asc = axis + thick / 2 + gap + num.asc + num.desc
            desc = den.asc + den.desc + gap + thick / 2 - axis
        }
        override val kids get() = listOf(
            num to floatArrayOf((w - num.w) / 2, -(axis + thick / 2 + gap + num.desc)),
            den to floatArrayOf((w - den.w) / 2, -axis + thick / 2 + gap + den.asc),
        )
        override fun draw(c: Canvas, ox: Float, oy: Float) {
            lp.color = color; lp.strokeWidth = thick; lp.strokeCap = Paint.Cap.BUTT
            c.drawLine(ox + pad * 0.4f, oy - axis, ox + w - pad * 0.4f, oy - axis, lp)
            lp.strokeCap = Paint.Cap.ROUND
        }
    }

    private inner class ScriptNB(b: Block, val sz: Float) : NBox() {
        val box = BBox(b, max(sz * 0.7f, 8f))
        init { w = box.w + sz * 0.05f; asc = box.asc; desc = box.desc }
        override val kids get() = listOf(box to floatArrayOf(sz * 0.02f, 0f))
        override fun draw(c: Canvas, ox: Float, oy: Float) {}
    }

    private inner class RootNB(n: Root, val sz: Float) : NBox() {
        val rad = BBox(n.rad, sz); val idx = n.idx?.let { BBox(it, max(sz * 0.5f, 7f)) }
        val thick = max(1f, sz * 0.055f); val pad = sz * 0.12f
        val hook = sz * 0.5f + (rad.asc + rad.desc) * 0.06f
        val lead = if (idx != null) max(0f, idx.w - hook * 0.45f) else 0f
        init {
            w = lead + hook + rad.w + sz * 0.12f
            asc = rad.asc + pad + thick; desc = rad.desc + sz * 0.04f
            if (idx != null) asc = max(asc, (rad.asc + rad.desc) * 0.42f + idx.asc + idx.desc)
        }
        override val kids get() = listOfNotNull(rad to floatArrayOf(lead + hook + sz * 0.06f, 0f),
            idx?.let { it to floatArrayOf(0f, -(rad.asc + rad.desc) * 0.42f - it.desc) })
        override fun draw(c: Canvas, ox: Float, oy: Float) {
            val top = oy - rad.asc - pad - thick / 2; val bot = oy + rad.desc
            val x0 = ox + lead; val h = rad.asc + rad.desc
            val p = Path()
            p.moveTo(x0, oy - h * 0.32f); p.lineTo(x0 + hook * 0.22f, oy - h * 0.4f); p.lineTo(x0 + hook * 0.5f, bot)
            p.lineTo(x0 + hook, top); p.lineTo(ox + w - sz * 0.04f, top)
            lp.color = color; lp.strokeWidth = thick; c.drawPath(p, lp)
        }
    }

    private inner class ParenNB(n: Paren, val sz: Float) : NBox() {
        val inner = BBox(n.inner, sz); val kind = n.kind
        val a = max(inner.asc + sz * 0.06f, sz * 0.74f); val d = max(inner.desc + sz * 0.06f, sz * 0.24f)
        val dw = sz * 0.3f + (a + d - sz) * 0.06f
        init { w = dw * 2 + inner.w; asc = a; desc = d }
        override val kids get() = listOf(inner to floatArrayOf(dw, 0f))
        override fun draw(c: Canvas, ox: Float, oy: Float) {
            lp.color = color; lp.strokeWidth = max(1f, sz * 0.06f)
            delim(c, ox, oy - a, dw, a + d, false); delim(c, ox + dw + inner.w, oy - a, dw, a + d, true)
        }
        private fun delim(c: Canvas, x: Float, top: Float, w: Float, h: Float, right: Boolean) {
            fun X(f: Float) = if (right) x + w * (1 - f) else x + w * f
            val p = Path()
            if (kind == '|') { p.moveTo(X(0.5f), top); p.lineTo(X(0.5f), top + h) }
            else { p.moveTo(X(0.78f), top); p.cubicTo(X(0.12f), top + h * 0.2f, X(0.12f), top + h * 0.8f, X(0.78f), top + h) }
            c.drawPath(p, lp)
        }
    }

    private inner class BigOpNB(val n: BigOp, val sz: Float) : NBox() {
        val ssz = max(sz * 0.7f, 8f)
        val lo = BBox(n.lo, ssz); val hi = BBox(n.hi, ssz); val body = BBox(n.body, sz); val v = BBox(n.v, if (n.kind == '∫') sz else ssz)
        val symW: Float; val symA: Float; val symD: Float
        val bodyX: Float; val dX: Float; val dW: Float
        val eqW: Float
        init {
            tp.typeface = SERIF_IT; tp.textSize = sz; dW = tp.measureText("d")
            tp.typeface = SERIF; tp.textSize = ssz; eqW = tp.measureText("=")
            if (n.kind == '∫') {
                symW = sz * 0.62f; symA = max(sz * 1.02f, body.asc + sz * 0.2f); symD = max(sz * 0.42f, body.desc + sz * 0.15f)
                bodyX = symW + max(lo.w + sz * -0.1f, hi.w) + sz * 0.18f
                dX = bodyX + body.w + sz * 0.16f
                w = dX + dW + v.w + sz * 0.06f
                asc = max(symA, symA * 0.82f + hi.asc + hi.desc * 0.2f); desc = max(symD, symD * 0.75f + lo.desc + lo.asc * 0.5f)
            } else {
                symW = sz * 0.95f; symA = sz * 0.86f; symD = sz * 0.3f
                val under = v.w + eqW + lo.w
                val colW = max(symW, max(under, hi.w))
                bodyX = colW + sz * 0.14f; dX = 0f
                w = bodyX + body.w
                val gap = sz * 0.1f
                asc = max(body.asc, symA + gap + hi.asc + hi.desc); desc = max(body.desc, symD + gap + max(lo.asc, v.asc) + max(lo.desc, v.desc))
            }
        }
        private val colW get() = bodyX - sz * 0.14f
        override val kids: List<Pair<BBox, FloatArray>> get() = if (n.kind == '∫') listOf(
            hi to floatArrayOf(symW + sz * 0.02f, -symA * 0.82f),
            lo to floatArrayOf(symW - sz * 0.1f, symD * 0.75f + lo.asc * 0.5f),
            body to floatArrayOf(bodyX, 0f),
            v to floatArrayOf(dX + dW, 0f),
        ) else {
            val gap = sz * 0.1f
            val under = v.w + eqW + lo.w
            val ux = (colW - under) / 2
            val uy = symD + gap + max(lo.asc, v.asc)
            listOf(
                hi to floatArrayOf((colW - hi.w) / 2, -symA - gap - hi.desc),
                v to floatArrayOf(ux, uy),
                lo to floatArrayOf(ux + v.w + eqW, uy),
                body to floatArrayOf(bodyX, 0f),
            )
        }
        override fun draw(c: Canvas, ox: Float, oy: Float) {
            lp.color = color
            val p = Path()
            if (n.kind == '∫') {
                val top = oy - symA; val bot = oy + symD
                val l = ox + sz * 0.05f; val r = ox + symW - sz * 0.05f
                p.moveTo(r, top + sz * 0.12f)
                p.cubicTo(r - sz * 0.06f, top - sz * 0.02f, r - sz * 0.2f, top - sz * 0.02f, (l + r) / 2 + sz * 0.03f, top + sz * 0.25f)
                p.lineTo((l + r) / 2 - sz * 0.03f, bot - sz * 0.25f)
                p.cubicTo(l + sz * 0.2f, bot + sz * 0.02f, l + sz * 0.06f, bot + sz * 0.02f, l, bot - sz * 0.12f)
                lp.strokeWidth = sz * 0.075f; c.drawPath(p, lp)
                tp.typeface = SERIF_IT; tp.textSize = sz; tp.color = color
                c.drawText("d", ox + dX, oy, tp)
            } else {
                val cx = ox + colW / 2; val top = oy - symA; val bot = oy + symD
                val l = cx - symW / 2; val r = cx + symW / 2
                if (n.kind == 'Σ') {
                    p.moveTo(r, top + sz * 0.14f); p.lineTo(r, top); p.lineTo(l, top); p.lineTo(cx - sz * 0.02f, (top + bot) / 2)
                    p.lineTo(l, bot); p.lineTo(r, bot); p.lineTo(r, bot - sz * 0.14f)
                } else {
                    p.moveTo(l - sz * 0.04f, top); p.lineTo(r + sz * 0.04f, top)
                    p.moveTo(l + sz * 0.14f, top); p.lineTo(l + sz * 0.14f, bot); p.moveTo(r - sz * 0.14f, top); p.lineTo(r - sz * 0.14f, bot)
                }
                lp.strokeWidth = sz * 0.07f; c.drawPath(p, lp)
                val gap = sz * 0.1f
                val under = v.w + eqW + lo.w
                val ux = ox + (colW - under) / 2
                tp.typeface = SERIF; tp.textSize = ssz; tp.color = color
                c.drawText("=", ux + v.w, oy + symD + gap + max(lo.asc, v.asc), tp)
            }
        }
    }

    private fun depthOf(n: Node): Int {
        var d = 0; var b = n.parent
        while (b != null) { val o = b.owner ?: break; if (o is Frac) d++; b = o.parent }
        return d
    }

    /** Which letters print upright: those spelling a built-in function name (sin, ln, log…). */
    private fun uprightFlags(b: Block): BooleanArray {
        val out = BooleanArray(b.nodes.size)
        var k = 0
        while (k < b.nodes.size) {
            val n = b.nodes[k]
            if (n !is Ch || !n.c.isLetter() || n.c.code > 0x7F) { k++; continue }
            var e = k
            while (e < b.nodes.size && (b.nodes[e] as? Ch)?.c?.let { it.isLetter() && it.code <= 0x7F } == true) e++
            val run = (k until e).map { (b.nodes[it] as Ch).c }.joinToString("")
            var i = 0
            while (i < run.length) {
                var best = 0
                for (j in run.length downTo i + 2) if (MathEngine.isBuiltinFn(run.substring(i, j)) || run.substring(i, j) == "mod") { best = j - i; break }
                if (best > 0) { for (q in i until i + best) out[k + q] = true; i += best } else i++
            }
            k = e
        }
        return out
    }

    private fun build(n: Node, k: Int, upright: BooleanArray, prev: NBox?): NBox {
        val sz = curSize
        return when (n) {
            is Ch -> {
                val c = n.c
                val parent = n.parent!!
                val prevCh = (if (k > 0) parent.nodes[k - 1] else null) as? Ch
                val unary = c == '−' && (k == 0 || (prevCh != null && (prevCh.c in OPS || prevCh.c == '(')))
                val s = c.toString()
                when {
                    c in "+−=<>≤≥≠:" && !unary -> TextNB(s, sz, false, sz * 0.2f, sz * 0.2f)
                    c == '·' -> TextNB(s, sz, false, sz * 0.1f, sz * 0.1f)
                    c == ',' -> TextNB(s, sz, false, 0f, sz * 0.18f)
                    c.isLetter() && upright[k] -> {
                        val next = parent.nodes.getOrNull(k + 1)
                        val endOfName = !(next is Ch && upright[k + 1])
                        TextNB(s, sz, false, 0f, if (endOfName) sz * 0.12f else 0f)
                    }
                    c.isLetter() && c != 'π' && c != '∞' -> TextNB(s, sz, true, 0f, 0f)
                    else -> TextNB(s, sz, false, 0f, 0f)
                }
            }
            is Frac -> FracNB(n, sz)
            is Pow -> ScriptNB(n.exp, sz)
            is Sub -> ScriptNB(n.sub, sz)
            is Root -> RootNB(n, sz)
            is Paren -> ParenNB(n, sz)
            is BigOp -> BigOpNB(n, sz)
            else -> TextNB("?", sz, false, 0f, 0f)
        }
    }

    // BBox children are built with their own size; NBox builders read the size of the block being laid out.
    private var curSizeStack = ArrayList<Float>()
    private val curSize get() = curSizeStack.lastOrNull() ?: size

    private var top: BBox? = null
    private val boxes = ArrayList<BBox>()
    private val boxOf = java.util.IdentityHashMap<Block, BBox>()

    private fun relayout() { top = null; requestLayout(); invalidate() }

    private fun layoutNow(): BBox {
        top?.let { return it }
        val b = BBox(root, size)
        top = b
        return b
    }

    private fun place(b: BBox, ax: Float, ay: Float) {
        b.ax = ax; b.ay = ay
        boxes.add(b); boxOf[b.block] = b
        for (it in b.items) for ((kid, off) in it.kids) place(kid, ax + it.x + off[0], ay + it.shift + off[1])
    }

    // ================================================================== measure / draw
    private val pad get() = size * 0.3f

    override fun onMeasure(wSpec: Int, hSpec: Int) {
        val b = layoutNow()
        val w = b.w + 2 * pad + size * 0.3f
        val h = max(b.asc + b.desc, size * 1.05f) + 2 * pad
        setMeasuredDimension(resolveSize(w.toInt() + 1, wSpec), resolveSize(h.toInt() + 1, hSpec))
    }

    private var blinkOn = true
    private val blink = object : Runnable { override fun run() { blinkOn = !blinkOn; invalidate(); postDelayed(this, 530) } }

    override fun onDraw(c: Canvas) {
        val b = layoutNow()
        boxes.clear(); boxOf.clear()
        val y = (height - (b.asc + b.desc)) / 2f + b.asc
        place(b, pad, y)
        if (root.nodes.isEmpty() && hint.isNotEmpty() && !isFocused) {
            tp.typeface = SERIF; tp.textSize = size * 0.8f; tp.color = Color.argb(0x70, Color.red(color), Color.green(color), Color.blue(color))
            c.drawText(hint, pad, y, tp)
            return
        }
        drawBox(c, b)
        if (isFocused && blinkOn) {
            val cbx = boxOf[cb] ?: return
            val x = cbx.ax + cbx.gaps[ci.coerceIn(0, cbx.gaps.size - 1)]
            lp.color = color; lp.strokeWidth = max(1.5f, size * 0.06f); lp.strokeCap = Paint.Cap.BUTT
            c.drawLine(x, cbx.ay - cbx.asc, x, cbx.ay + cbx.desc, lp)
            lp.strokeCap = Paint.Cap.ROUND
        }
    }

    private fun drawBox(c: Canvas, b: BBox) {
        if (b.empty && b.block !== root) {
            // An empty slot: a faint box to tap into (like Desmos).
            holeP.color = Color.argb(0x66, Color.red(color), Color.green(color), Color.blue(color))
            holeP.strokeWidth = max(1f, b.size * 0.045f)
            holeP.pathEffect = DashPathEffect(floatArrayOf(b.size * 0.08f, b.size * 0.06f), 0f)
            c.drawRect(RectF(b.ax + b.size * 0.06f, b.ay - b.asc + b.size * 0.08f, b.ax + b.w - b.size * 0.06f, b.ay + b.desc), holeP)
            return
        }
        for (it in b.items) {
            it.draw(c, b.ax + it.x, b.ay + it.shift)
            for ((kid, _) in it.kids) drawBox(c, kid)
        }
    }

    // ================================================================== touch / keyboard
    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (e.actionMasked == MotionEvent.ACTION_UP) {
            if (!isFocused) requestFocus()
            placeCursor(e.x, e.y)
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(this, 0)
        }
        return true
    }

    /** Put the cursor in the innermost slot under ([x], [y]), at the nearest gap. */
    private fun placeCursor(x: Float, y: Float) {
        if (boxes.isEmpty()) { cb = root; ci = root.nodes.size; invalidate(); return }
        val slack = size * 0.12f
        var best: BBox? = null; var bestArea = Float.MAX_VALUE
        for (b in boxes) {
            if (x >= b.ax - slack && x <= b.ax + b.w + slack && y >= b.ay - b.asc - slack && y <= b.ay + b.desc + slack) {
                val area = (b.w + 1) * (b.asc + b.desc + 1)
                if (area < bestArea) { bestArea = area; best = b }
            }
        }
        val b = best ?: boxOf[root] ?: return
        var k = 0; var bd = Float.MAX_VALUE
        for (i in b.gaps.indices) { val d = abs(b.ax + b.gaps[i] - x); if (d < bd) { bd = d; k = i } }
        cb = b.block; ci = if (b.empty) 0 else k
        blinkOn = true; invalidate()
        scrollToCursor()
    }

    private fun scrollToCursor() = post {
        val cbx = boxOf[cb] ?: return@post
        val x = (cbx.ax + cbx.gaps[ci.coerceIn(0, cbx.gaps.size - 1)]).toInt()
        requestRectangleOnScreen(Rect(x - (size * 1.5f).toInt(), 0, x + (size * 1.5f).toInt(), height))
    }

    override fun onFocusChanged(gain: Boolean, direction: Int, previous: Rect?) {
        super.onFocusChanged(gain, direction, previous)
        removeCallbacks(blink)
        if (gain) { blinkOn = true; postDelayed(blink, 530) }
        invalidate()
        onFocus?.invoke(gain)
    }

    override fun onCheckIsTextEditor() = true

    private var composing = ""

    override fun onCreateInputConnection(out: EditorInfo): InputConnection {
        out.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        out.imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
        return object : BaseInputConnection(this, false) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                repeat(composing.length) { backspace(false) }; composing = ""
                text?.forEach { type(it, notify = false) }
                changed(true); scrollToCursor()
                return true
            }
            override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
                repeat(composing.length) { backspace(false) }
                composing = text?.toString() ?: ""
                composing.forEach { type(it, notify = false, auto = false) }
                changed(true)
                return true
            }
            override fun finishComposingText(): Boolean {
                if (composing.isNotEmpty()) { val s = composing; repeat(s.length) { backspace(false) }; composing = ""; s.forEach { type(it, notify = false) }; changed(true) }
                return true
            }
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                repeat(max(1, beforeLength)) { backspace(false) }; changed(true); return true
            }
            override fun performEditorAction(actionCode: Int): Boolean { onEnter?.invoke(); return true }
            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) onKeyDown(event.keyCode, event)
                return true
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DEL -> { composing = ""; backspace(); return true }
            KeyEvent.KEYCODE_DPAD_LEFT -> { moveLeft(); return true }
            KeyEvent.KEYCODE_DPAD_RIGHT -> { moveRight(); return true }
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { onEnter?.invoke(); return true }
            KeyEvent.KEYCODE_DPAD_UP -> { val o = cb.owner; if (o is Frac && cb === o.den) enter(o.num, true); changed(false); return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> { val o = cb.owner; if (o is Frac && cb === o.num) enter(o.den, true); changed(false); return true }
        }
        val u = event.unicodeChar
        if (u != 0) { type(u.toChar()); scrollToCursor(); return true }
        return super.onKeyDown(keyCode, event)
    }

    /** Move the cursor to the end (used when a row gets focus programmatically). */
    fun cursorToEnd() { cb = root; ci = root.nodes.size; invalidate() }

    /** Focus the field and show the keyboard. */
    fun edit() {
        requestFocus()
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(this, 0)
    }
}
