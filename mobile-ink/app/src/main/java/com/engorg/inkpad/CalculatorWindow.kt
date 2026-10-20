package com.engorg.inkpad

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max

/**
 * A scientific calculator that floats over the notebook. Input is the same Desmos-style math field
 * as the grapher (fractions, roots, ∫ and Σ build as you type), driven by an on-screen keypad so the
 * system keyboard stays out of the way (the ⌨ key brings it up for letters). The answer shows live as
 * you type, with an exact fraction when there is one; = adds the line to the history, where a tap
 * reuses an answer. `ans` is the last answer. Everything [MathEngine] knows works: trig in DEG or RAD,
 * logs, n!, nCr, integrals, sums, limits, derivatives at a point…
 *
 * Drag the header to move it. Position, angle mode and history persist ("engink_calc").
 */
@SuppressLint("ClickableViewAccessibility", "SetTextI18n")
class CalculatorWindow(private val act: Activity, private val host: FrameLayout) {
    private val prefs = act.getSharedPreferences("engink_calc", Context.MODE_PRIVATE)
    private val dens = act.resources.displayMetrics.density
    private fun dp(v: Int) = (v * dens).toInt()
    private fun dpf(v: Float) = v * dens
    private fun alpha(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))

    private class Entry(val expr: String, val result: String, val value: Double)
    private val history = ArrayList<Entry>()
    private var degrees = false
    private var ans = 0.0

    private lateinit var frame: LinearLayout
    private lateinit var field: MathField
    private lateinit var live: TextView
    private lateinit var historyCol: LinearLayout
    private lateinit var historyScroll: ScrollView
    private lateinit var angleBtn: TextView
    private var built = false
    private var more: PopupWindow? = null

    val isOpen get() = built && frame.parent != null
    var onClosed: (() -> Unit)? = null

    fun toggle() { if (isOpen) close() else open() }

    fun open() {
        if (!built) build()
        if (frame.parent == null) {
            val w = dp(340)
            val hw = host.width.takeIf { it > 0 } ?: act.resources.displayMetrics.widthPixels
            val x = prefs.getInt("x", hw - w - dp(14)).coerceIn(0, max(0, hw - dp(120)))
            val y = prefs.getInt("y", dp(84)).coerceAtLeast(0)
            host.addView(frame, FrameLayout.LayoutParams(w, WRAP_CONTENT).apply { gravity = Gravity.TOP or Gravity.START; leftMargin = x; topMargin = y })
        }
        frame.bringToFront()
        field.post { field.requestFocus() }
    }

    fun close() {
        if (!built) return
        more?.dismiss()
        (act.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(frame.windowToken, 0)
        save()
        host.removeView(frame)
        onClosed?.invoke()
    }

    // ================================================================= build
    private fun build() {
        built = true
        load()
        frame = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dpf(18f); setColor(AppTheme.surface); setStroke(dp(1), alpha(AppTheme.text, 0x30)) }
            elevation = dpf(16f); clipToOutline = true
            isClickable = true   // never let touches fall through to the page
        }
        frame.addView(buildHeader(), LinearLayout.LayoutParams(MATCH_PARENT, dp(44)))

        historyCol = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(4), dp(12), dp(4)) }
        historyScroll = ScrollView(act).apply { addView(historyCol); isVerticalScrollBarEnabled = false }
        frame.addView(historyScroll, LinearLayout.LayoutParams(MATCH_PARENT, dp(150)))

        field = MathField(act).apply {
            size = dpf(24f); color = AppTheme.text; softKeyboard = false
            onChange = { updateLive() }
            onEnter = { commit() }
        }
        frame.addView(HorizontalScrollView(act).apply {
            isHorizontalScrollBarEnabled = false; isFillViewport = true
            background = GradientDrawable().apply { cornerRadius = dpf(10f); setColor(AppTheme.elevated) }
            addView(field, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { setMargins(dp(10), dp(4), dp(10), 0) })
        live = TextView(act).apply {
            textSize = 15f; gravity = Gravity.END; setTextColor(alpha(AppTheme.text, 0xA0))
            setPadding(dp(14), dp(4), dp(14), dp(2)); maxLines = 2
        }
        frame.addView(live, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        frame.addView(buildKeypad(), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { setMargins(dp(8), dp(4), dp(8), dp(10)) })
        renderHistory()
        updateLive()
    }

    private fun chip(label: String, onClick: (TextView) -> Unit) = TextView(act).apply {
        text = label; textSize = 12.5f; setTypeface(null, Typeface.BOLD); gravity = Gravity.CENTER
        setTextColor(AppTheme.text)
        background = GradientDrawable().apply { cornerRadius = dpf(14f); setColor(AppTheme.elevated) }
        setPadding(dp(10), dp(4), dp(10), dp(4))
        layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, dp(28)).apply { leftMargin = dp(6) }
        setOnClickListener { onClick(this) }
    }

    private fun buildHeader(): View {
        val h = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(6), dp(8), dp(4))
        }
        h.addView(ImageView(act).apply {
            setImageBitmap(Icons.bitmap(Icons.CALC, dp(18))); setColorFilter(AppTheme.accent)
            layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(8) }
        })
        h.addView(TextView(act).apply { text = "Calculator"; textSize = 15f; setTypeface(null, Typeface.BOLD); setTextColor(AppTheme.text) },
            LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        angleBtn = chip(if (degrees) "DEG" else "RAD") { degrees = !degrees; it.text = if (degrees) "DEG" else "RAD"; updateLive(); save() }
        h.addView(angleBtn)
        h.addView(chip("Clear") { history.clear(); renderHistory(); save() })
        h.addView(ImageButton(act).apply {
            setImageBitmap(Icons.bitmap(Icons.CLOSE, dp(16))); setColorFilter(AppTheme.text)
            background = GradientDrawable().apply { cornerRadius = dpf(14f); setColor(AppTheme.elevated) }
            scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
            val p = dp(6); setPadding(p, p, p, p)
            layoutParams = LinearLayout.LayoutParams(dp(32), dp(28)).apply { leftMargin = dp(6) }
            setOnClickListener { close() }
        })
        // Drag the header to move the calculator (kept on screen).
        var rx = 0f; var ry = 0f; var l0 = 0; var t0 = 0
        h.setOnTouchListener { _, e ->
            val lp = frame.layoutParams as FrameLayout.LayoutParams
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { rx = e.rawX; ry = e.rawY; l0 = lp.leftMargin; t0 = lp.topMargin; frame.bringToFront() }
                MotionEvent.ACTION_MOVE -> {
                    lp.leftMargin = (l0 + (e.rawX - rx)).toInt().coerceIn(-(frame.width - dp(120)), host.width - dp(120))
                    lp.topMargin = (t0 + (e.rawY - ry)).toInt().coerceIn(0, (host.height - dp(60)).coerceAtLeast(0))
                    frame.layoutParams = lp
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> save()
            }
            true
        }
        return h
    }

    // ================================================================= keypad
    private enum class K { FN, NUM, OP, ACT, EQ }

    private fun buildKeypad(): View {
        val grid = GridLayout(act).apply { columnCount = 6 }
        fun key(label: String, kind: K, span: Int = 1, onClick: () -> Unit) {
            val bg = when (kind) {
                K.NUM -> AppTheme.elevated
                K.EQ -> AppTheme.accent
                K.OP -> alpha(AppTheme.accent, 0x30)
                else -> alpha(AppTheme.text, 0x10)
            }
            grid.addView(TextView(act).apply {
                text = label; gravity = Gravity.CENTER; maxLines = 1
                textSize = if (kind == K.NUM) 19f else if (label.length > 3) 13f else 16f
                setTypeface(if (kind == K.FN) Typeface.SERIF else Typeface.DEFAULT, if (kind == K.EQ || kind == K.OP) Typeface.BOLD else Typeface.NORMAL)
                setTextColor(if (kind == K.EQ) AppTheme.onAccent() else AppTheme.text)
                background = GradientDrawable().apply { cornerRadius = dpf(10f); setColor(bg) }
                layoutParams = GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED), GridLayout.spec(GridLayout.UNDEFINED, span, 1f)).apply {
                    width = 0; height = dp(46); setMargins(dp(3), dp(3), dp(3), dp(3))
                }
                setOnClickListener { if (!field.isFocused) field.requestFocus(); onClick() }
            })
        }
        fun t(tpl: String) { field.insertTemplate(tpl) }
        fun ty(c: Char) { field.type(c) }

        key("sin", K.FN) { t("sin(§)") }; key("cos", K.FN) { t("cos(§)") }; key("tan", K.FN) { t("tan(§)") }
        key("ln", K.FN) { t("ln(§)") }; key("log", K.FN) { t("log(§)") }; key("√", K.FN) { t("sqrt(§)") }

        key("π", K.FN) { ty('π') }; key("e", K.FN) { ty('e') }; key("xʸ", K.FN) { ty('^') }
        key("x²", K.FN) { t("^2") }; key("(", K.FN) { ty('(') }; key(")", K.FN) { ty(')') }

        key("7", K.NUM) { ty('7') }; key("8", K.NUM) { ty('8') }; key("9", K.NUM) { ty('9') }
        key("÷", K.OP) { ty('/') }; key("⌫", K.ACT) { field.backspace() }; key("AC", K.ACT) { field.clear() }

        key("4", K.NUM) { ty('4') }; key("5", K.NUM) { ty('5') }; key("6", K.NUM) { ty('6') }
        key("×", K.OP) { ty('*') }; key("◀", K.ACT) { field.moveLeft() }; key("▶", K.ACT) { field.moveRight() }

        key("1", K.NUM) { ty('1') }; key("2", K.NUM) { ty('2') }; key("3", K.NUM) { ty('3') }
        key("−", K.OP) { ty('-') }; key("ƒ more", K.ACT) { showMore(grid) }; key("⌨", K.ACT) { toggleKeyboard() }

        key("0", K.NUM) { ty('0') }; key(".", K.NUM) { ty('.') }; key("ans", K.FN) { "ans".forEach { field.type(it) } }
        key("+", K.OP) { ty('+') }; key("=", K.EQ, span = 2) { commit() }
        return grid
    }

    private fun toggleKeyboard() {
        val imm = act.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
        field.softKeyboard = !field.softKeyboard
        imm.restartInput(field)
        if (field.softKeyboard) { field.requestFocus(); imm.showSoftInput(field, 0) } else imm.hideSoftInputFromWindow(field.windowToken, 0)
    }

    /** More functions: inverse trig, hyperbolic, |x|, n!, nCr, ∫, Σ, d/dx… */
    private fun showMore(anchor: View) {
        more?.let { if (it.isShowing) { it.dismiss(); return } }
        val items = listOf(
            "sin⁻¹" to "asin(§)", "cos⁻¹" to "acos(§)", "tan⁻¹" to "atan(§)", "sinh" to "sinh(§)", "cosh" to "cosh(§)", "tanh" to "tanh(§)",
            "|x|" to "abs(§)", "n!" to "!", "nCr" to "nCr(§, )", "nPr" to "nPr(§, )", "eˣ" to "e^", "10ˣ" to "10^",
            "∛" to "cbrt(§)", "ⁿ√" to "root(§, 3)", "log₂" to "log_2(§)", "logᵦ" to "log(§, 3)", "mod" to "mod(§, )", "%" to "/100",
            "∫ₐᵇ" to "int(§, x, 0, 1)", "Σ" to "sum(§, n, 1, 10)", "Π" to "prod(§, n, 1, 10)", "d/dx at" to "deriv(§, x, 1)", "lim" to "lim(§, x, 0)", "Γ" to "gamma(§)",
            "floor" to "floor(§)", "ceil" to "ceil(§)", "round" to "round(§)", "gcd" to "gcd(§, )", "lcm" to "lcm(§, )",
        )
        val grid = GridLayout(act).apply {
            columnCount = 4; setPadding(dp(8), dp(8), dp(8), dp(8))
            background = GradientDrawable().apply { cornerRadius = dpf(14f); setColor(AppTheme.surface); setStroke(dp(1), alpha(AppTheme.text, 0x30)) }
        }
        val pop = PopupWindow(grid, WRAP_CONTENT, WRAP_CONTENT, false).apply {
            elevation = dpf(14f); isOutsideTouchable = true; setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }
        for ((label, tpl) in items) grid.addView(TextView(act).apply {
            text = label; textSize = 14f; gravity = Gravity.CENTER; maxLines = 1; setTextColor(AppTheme.text)
            background = GradientDrawable().apply { cornerRadius = dpf(9f); setColor(AppTheme.elevated) }
            layoutParams = GridLayout.LayoutParams().apply { width = dp(72); height = dp(40); setMargins(dp(3), dp(3), dp(3), dp(3)) }
            setOnClickListener { if (!field.isFocused) field.requestFocus(); if (tpl == "/100") { field.type('/'); "100".forEach { field.type(it) }; field.moveRight() } else field.insertTemplate(tpl) }
        })
        more = pop
        val loc = IntArray(2); frame.getLocationInWindow(loc)
        pop.showAtLocation(frame, Gravity.TOP or Gravity.START, loc[0] + dp(8), loc[1] + dp(150))
    }

    // ================================================================= evaluate
    private class Result(val value: Double?, val error: String?)

    private fun evaluate(text: String): Result {
        if (text.isBlank()) return Result(null, null)
        return try {
            val env = MathEnv(degrees).apply { consts["ans"] = ans }
            val st = MathEngine.parseStatement(text, emptySet(), setOf("ans"))
            if (st.rhs != null) throw MathError("Use = to calculate")
            Result(MathEngine.evalConst(st.lhs, env), null)
        } catch (e: MathError) {
            Result(null, (e.message ?: "Invalid").let { if (it.contains("isn't defined")) "$it — the calculator works with numbers" else it })
        } catch (_: StackOverflowError) { Result(null, "Too deeply nested") } catch (_: Exception) { Result(null, "Can't calculate this") }
    }

    private fun updateLive() {
        val r = evaluate(field.text())
        live.setTextColor(if (r.error != null) Color.rgb(0xD3, 0x2F, 0x2F) else alpha(AppTheme.text, 0xA0))
        live.text = when {
            r.value != null -> "= " + show(r.value)
            r.error != null && !field.isEmpty() -> r.error
            else -> ""
        }
    }

    /** A value for display: up to 12 significant digits, plus its exact fraction when it has a small one. */
    private fun show(v: Double): String {
        val s = MathEngine.fmt(v, 12)
        val f = fraction(v)
        return if (f != null) "$s  =  $f" else s
    }

    private fun commit() {
        val text = field.text()
        val r = evaluate(text)
        if (r.value == null) { if (r.error != null) Toast.makeText(act, r.error, Toast.LENGTH_SHORT).show(); return }
        ans = r.value
        history.add(Entry(text, show(r.value), r.value))
        while (history.size > 60) history.removeAt(0)
        field.clear()
        renderHistory(); updateLive(); save()
    }

    private fun renderHistory() {
        historyCol.removeAllViews()
        if (history.isEmpty()) historyCol.addView(TextView(act).apply {
            text = "Answers appear here. Tap one to use it again."; textSize = 12.5f
            setTextColor(alpha(AppTheme.text, 0x80)); gravity = Gravity.CENTER; setPadding(0, dp(40), 0, 0)
        })
        for (e in history) {
            val st = try { MathEngine.parseStatement(e.expr, emptySet(), setOf("ans")) } catch (_: Exception) { null }
            historyCol.addView(LinearLayout(act).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.END
                setPadding(dp(4), dp(6), dp(4), dp(6))
                addView(MathView(act).apply { size = dpf(15f); color = alpha(AppTheme.text, 0xB0); set(st, e.expr) },
                    LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.END })
                addView(TextView(act).apply {
                    text = "= ${e.result}"; textSize = 17f; setTypeface(null, Typeface.BOLD); setTextColor(AppTheme.text); gravity = Gravity.END
                })
                // Tap: put the answer into the input. Long-press: copy it.
                setOnClickListener {
                    if (!field.isFocused) field.requestFocus()
                    field.insertTemplate(MathEngine.fmt(e.value, 12).replace("−", "-").let { if (it.contains("×10^")) it.replace("×10^", "*10^") else it })
                }
                setOnLongClickListener {
                    (act.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.setPrimaryClip(ClipData.newPlainText("result", MathEngine.fmt(e.value, 12).replace("−", "-")))
                    Toast.makeText(act, "Copied", Toast.LENGTH_SHORT).show(); true
                }
            })
            historyCol.addView(View(act).apply { setBackgroundColor(alpha(AppTheme.text, 0x12)) }, LinearLayout.LayoutParams(MATCH_PARENT, dp(1)))
        }
        historyScroll.post { historyScroll.fullScroll(View.FOCUS_DOWN) }
    }

    // ================================================================= persistence
    private fun load() {
        degrees = prefs.getBoolean("deg", false)
        ans = prefs.getString("ansS", null)?.toDoubleOrNull() ?: 0.0
        history.clear()
        try {
            val arr = JSONArray(prefs.getString("hist", "[]"))
            for (i in 0 until arr.length()) { val o = arr.getJSONObject(i); history.add(Entry(o.getString("e"), o.getString("r"), o.getDouble("v"))) }
        } catch (_: Exception) { }
    }

    private fun save() {
        if (!built) return
        val arr = JSONArray(); for (e in history) arr.put(JSONObject().put("e", e.expr).put("r", e.result).put("v", e.value))
        val ed = prefs.edit().putBoolean("deg", degrees).putString("ansS", ans.toString()).putString("hist", arr.toString())
        if (frame.parent != null) { val lp = frame.layoutParams as FrameLayout.LayoutParams; ed.putInt("x", lp.leftMargin).putInt("y", lp.topMargin) }
        ed.apply()
    }

    companion object {
        /** The exact fraction p/q (|q| ≤ 10 000) equal to [v] to ~1e-12, as text, or null (integers and irrationals). */
        fun fraction(v: Double): String? {
            if (!v.isFinite() || v == floor(v) || abs(v) > 1e9) return null
            // Continued fraction convergents.
            var x = abs(v); var h0 = 0L; var h1 = 1L; var k0 = 1L; var k1 = 0L
            repeat(30) {
                val a = floor(x).toLong()
                val h2 = a * h1 + h0; val k2 = a * k1 + k0
                if (k2 > 10_000) return null
                h0 = h1; h1 = h2; k0 = k1; k1 = k2
                if (abs(abs(v) - h1.toDouble() / k1) <= 1e-12 * max(1.0, abs(v))) {
                    return (if (v < 0) "−" else "") + "$h1/$k1"
                }
                val frac = x - a
                if (frac < 1e-15) return null
                x = 1 / frac
            }
            return null
        }
    }
}
