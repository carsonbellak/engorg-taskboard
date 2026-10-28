package com.engorg.inkpad

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.Html
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/** "T_H" → T with a subscript H, as in the textbook (analysis panel + value sheet). */
internal fun analysisRich(s: String): CharSequence {
    val esc = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return Html.fromHtml(esc.replace(Regex("_([A-Za-z0-9]+)"), "<sub><small>$1</small></sub>"), Html.FROM_HTML_MODE_LEGACY)
}

/**
 * The value sheet for one analysed symbol: a card over the notebook listing its fields (from
 * ink-analysis.js `comps[i].fields`) as tappable value boxes, with an on-screen keypad docked at the
 * bottom so numbers never need the system keyboard. Per field (see the analysis contract §3):
 * `options` → chips; `keypad: 'si'` → digits + SI-prefix keys (p n µ m k M G); `'num'` → digits only;
 * `units` → unit-suffix buttons (the first is the implied default); `'text'` (or no unit) → a normal
 * text box with the system keyboard. Stored values are the typed strings ("4.7k", "8 MPa", "85 %").
 *
 * Owned by [AnalysisEditor]; it only edits strings — saving, selecting and deleting are callbacks.
 */
@SuppressLint("SetTextI18n")
class ValueSheet(private val act: Activity, private val host: FrameLayout) {
    private val dens = act.resources.displayMetrics.density
    private fun dp(v: Int) = (v * dens).toInt()
    private val onSurface get() = AppTheme.text
    private val muted get() = tint(onSurface, 0xA8)
    private fun tint(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))

    /** One field's editing state. Keypad fields keep the number, SI prefix and unit suffix apart. */
    private class Entry(val f: JSONObject, val raw: String) {
        val key: String = f.optString("key")
        val unit: String = f.optString("unit")
        val options: JSONArray? = f.optJSONArray("options")
        val units: List<String> = f.optJSONArray("units")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotEmpty() } } ?: emptyList()
        val mode: String = when {
            options != null -> "opt"
            else -> when (val k = f.optString("keypad")) {
                "si", "num", "text" -> k
                // No hint from the script: electrical units get the prefix keys, other units plain digits.
                else -> if (unit.isEmpty()) "text" else if (unit in SI_UNITS) "si" else "num"
            }
        }
        val keypad: Boolean get() = mode == "si" || mode == "num"
        /** The unit an empty suffix means (shown greyed after the number). */
        val defaultUnit: String = units.firstOrNull() ?: unit.takeIf { u -> u.none { it.isDigit() } }.orEmpty()
        var num = ""; var prefix = ""; var suffix = ""
        var text = raw              // chosen option / typed text
        var dirty = false           // untouched values are saved back verbatim
        var edit: EditText? = null
        var box: TextView? = null
        var row: View? = null

        init { if (keypad) parse(raw) }

        private fun parse(s: String) {
            val m = NUM_RE.matchEntire(s.trim()) ?: run { suffix = s.trim(); return }
            num = m.groupValues[1]
            var r = m.groupValues[2]
            if (mode == "si" && r.isNotEmpty()) {
                if (r.length >= 3 && r.substring(0, 3).equals("meg", ignoreCase = true)) { prefix = "M"; r = r.substring(3) }
                else if (units.none { it.equals(r, ignoreCase = true) } && r[0] in PREFIX_CHARS) { prefix = normPrefix(r[0]); r = r.substring(1) }
            }
            suffix = r.trim()
            if (defaultUnit.isNotEmpty() && suffix.equals(defaultUnit, ignoreCase = true)) suffix = ""
        }

        /** What gets stored ("" = cleared, so the script falls back to its default). */
        fun value(): String {
            if (mode == "text") return (edit?.text?.toString() ?: text).trim()
            if (mode == "opt") return if (dirty) text.trim() else raw.trim()   // an untouched default stays implied
            if (!dirty) return raw.trim()
            val n = num.replace(Regex("[eE][-+]?$"), "")
            if (n.none { it.isDigit() }) return ""
            return n + prefix + if (suffix.isNotEmpty()) " $suffix" else ""
        }

        // ---- keypad edits ----
        fun digit(d: Char) {
            if (num.length >= 18) return
            num = if (num == "0") "$d" else if (num == "-0") "-$d" else num + d
        }
        fun dot() {
            if (num.contains('.') || num.contains('e', ignoreCase = true)) return
            num += if (num.none { it.isDigit() }) "0." else "."
        }
        fun exp() { if (num.any { it.isDigit() } && !num.contains('e', ignoreCase = true)) num += "E" }
        fun minus() {
            num = when {
                num.endsWith("E") || num.endsWith("e") -> "$num-"
                num.endsWith("E-") || num.endsWith("e-") -> num.dropLast(1)
                num.startsWith("-") -> num.substring(1)
                else -> "-$num"
            }
        }
        fun back() { when { suffix.isNotEmpty() -> suffix = ""; prefix.isNotEmpty() -> prefix = ""; else -> num = num.dropLast(1) } }
        fun clear() { num = ""; prefix = ""; suffix = "" }
    }

    private var scrim: View? = null
    private var card: LinearLayout? = null
    private var scroll: ScrollView? = null
    private var keypad: LinearLayout? = null
    private var entries: List<Entry> = emptyList()
    private var focus = -1
    private var saveNow: (() -> Unit)? = null
    // The live prefix / unit / Next keys of the keypad on show (repainted after each key).
    private val prefixKeys = ArrayList<Pair<String, TextView>>()
    private val unitKeys = ArrayList<Pair<Int, TextView>>()
    private var nextKey: TextView? = null

    val isOpen: Boolean get() = scrim != null

    /**
     * Show the sheet for [comp] (`{ name, title, fields }`) with the symbol's current [props].
     * [onSave] gets each field key → its new string ("" = cleared); [onSelect] / [onDelete] are the
     * "Select" (dismiss and select the symbol normally) and "Delete" buttons.
     */
    fun show(comp: JSONObject, props: JSONObject?, onSave: (Map<String, String>) -> Unit, onSelect: () -> Unit, onDelete: () -> Unit) {
        close()
        val fields = comp.optJSONArray("fields") ?: JSONArray()
        if (fields.length() == 0) return
        entries = (0 until fields.length()).map { k ->
            val f = fields.getJSONObject(k)
            val raw = props?.optString(f.optString("key")).orEmpty()
            Entry(f, raw).also { e -> if (e.mode == "opt") e.text = raw.ifEmpty { f.optString("value") }.ifEmpty { f.optString("ph") } }
        }
        focus = -1

        val c = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(20).toFloat(); setColor(AppTheme.surface) }
            elevation = dp(20).toFloat()
            setPadding(dp(18), dp(16), dp(18), dp(14))
            isClickable = true
            // Holds focus itself so no text box grabs it (and pops the keyboard) on open.
            isFocusable = true; isFocusableInTouchMode = true
        }
        card = c
        c.addView(TextView(act).apply { text = analysisRich(comp.optString("title").ifEmpty { comp.optString("name") }); textSize = 17f; setTypeface(null, Typeface.BOLD); setTextColor(onSurface) })
        if (comp.optString("name").isNotEmpty() && comp.optString("name") != comp.optString("title"))
            c.addView(TextView(act).apply { text = analysisRich(comp.optString("name")); textSize = 12.5f; setTextColor(muted) })

        val form = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(6), 0, dp(8)) }
        entries.forEachIndexed { idx, e -> form.addView(fieldRow(idx, e)) }
        val sc = ScrollView(act).apply { addView(form); isVerticalScrollBarEnabled = false }
        scroll = sc
        c.addView(sc, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        val kp = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE; setPadding(0, dp(4), 0, dp(4)) }
        keypad = kp
        c.addView(kp, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        val save = {
            val out = LinkedHashMap<String, String>()
            for (e in entries) if (e.key.isNotEmpty()) out[e.key] = e.value()
            close()
            onSave(out)
        }
        saveNow = save
        c.addView(LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, 0)
            addView(action("Delete", Color.TRANSPARENT, Color.rgb(0xDC, 0x26, 0x26)) { close(); onDelete() })
            addView(action("Select", AppTheme.elevated, onSurface) { close(); onSelect() })
            addView(View(act), LinearLayout.LayoutParams(0, 1, 1f))
            addView(action("Cancel", AppTheme.elevated, onSurface) { close() })
            addView(action("Save", AppTheme.accent, AppTheme.onAccent(), bold = true) { save() })
        })

        val s = FrameLayout(act).apply {
            setBackgroundColor(Color.argb(0x55, 0, 0, 0))
            isClickable = true
            setOnClickListener { close() }
            val dm = act.resources.displayMetrics
            addView(c, FrameLayout.LayoutParams(minOf(dp(460), (dm.widthPixels * 0.94f).toInt()), WRAP_CONTENT, Gravity.CENTER).apply {
                topMargin = dp(24); bottomMargin = dp(24)
            })
        }
        host.addView(s, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        scrim = s
        c.requestFocus()
        // Start on the first number, so the keypad is ready.
        entries.indexOfFirst { it.keypad }.takeIf { it >= 0 }?.let { setFocus(it) }
    }

    fun close() {
        val s = scrim ?: return
        hideKeyboard(s)
        host.removeView(s)
        scrim = null; card = null; scroll = null; keypad = null; saveNow = null; nextKey = null
        prefixKeys.clear(); unitKeys.clear()
        entries = emptyList(); focus = -1
    }

    private fun hideKeyboard(v: View) {
        (act.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(v.windowToken, 0)
    }

    private fun pill(color: Int, radius: Int = 14): Drawable {
        val ripple = tint(onSurface, 0x3A)
        val bg = GradientDrawable().apply { cornerRadius = dp(radius).toFloat(); setColor(color) }
        val mask = GradientDrawable().apply { cornerRadius = dp(radius).toFloat(); setColor(Color.WHITE) }
        return RippleDrawable(ColorStateList.valueOf(ripple), bg, mask)
    }

    private fun action(label: String, bg: Int, fg: Int, bold: Boolean = false, onClick: () -> Unit) = TextView(act).apply {
        text = label; textSize = 15f; setTextColor(fg); gravity = Gravity.CENTER
        if (bold) setTypeface(null, Typeface.BOLD)
        background = pill(bg, 16); setPadding(dp(14), 0, dp(14), 0); minWidth = dp(56)
        layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, dp(44)).apply { leftMargin = dp(6) }
        setOnClickListener { onClick() }
    }

    // ---------- fields ----------
    private fun fieldRow(idx: Int, e: Entry): View {
        val col = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(8), 0, 0) }
        e.row = col
        val unitHint = if (e.unit.isNotEmpty() && e.mode != "opt") "  (${e.unit})" else ""
        col.addView(TextView(act).apply { text = analysisRich(e.f.optString("label") + unitHint); textSize = 13f; setTextColor(muted); setPadding(dp(2), 0, 0, dp(4)) })
        when (e.mode) {
            "opt" -> {
                val opts = e.options ?: JSONArray()
                val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }
                val chips = ArrayList<TextView>()
                fun paint() { for (ch in chips) { val on = ch.tag == e.text; ch.background = pill(if (on) AppTheme.accent else AppTheme.elevated, 20); ch.setTextColor(if (on) AppTheme.onAccent() else onSurface) } }
                for (o in 0 until opts.length()) {
                    val v = opts.optString(o)
                    chips.add(TextView(act).apply {
                        text = v; tag = v; textSize = 14f; gravity = Gravity.CENTER; setPadding(dp(16), 0, dp(16), 0)
                        layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, dp(42)).apply { rightMargin = dp(6) }
                        setOnClickListener { e.text = v; e.dirty = true; paint() }
                    })
                }
                chips.forEach { row.addView(it) }; paint()
                col.addView(HorizontalScrollView(act).apply { isHorizontalScrollBarEnabled = false; addView(row) })
            }
            "text" -> {
                val et = EditText(act).apply {
                    setText(e.raw); hint = e.f.optString("ph"); textSize = 17f
                    setTextColor(onSurface); setHintTextColor(muted); isSingleLine = true
                    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                    background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated) }
                    setPadding(dp(14), 0, dp(14), 0); minHeight = dp(52)
                    setOnFocusChangeListener { _, has -> if (has) setFocus(idx) }
                }
                e.edit = et
                col.addView(et, LinearLayout.LayoutParams(MATCH_PARENT, dp(52)))
            }
            else -> {
                val box = TextView(act).apply {
                    textSize = 20f; gravity = Gravity.CENTER_VERTICAL; maxLines = 1
                    setPadding(dp(14), 0, dp(14), 0)
                    setOnClickListener { setFocus(idx) }
                }
                e.box = box
                col.addView(box, LinearLayout.LayoutParams(MATCH_PARENT, dp(52)))
                paintBox(e, false)
            }
        }
        e.f.optString("hint").takeIf { it.isNotEmpty() }?.let { h -> col.addView(TextView(act).apply { text = analysisRich(h); textSize = 12f; setTextColor(muted); setPadding(dp(4), dp(3), 0, 0) }) }
        return col
    }

    /** A keypad field's box: the number + prefix, a caret while focused, then the unit (greyed if implied). */
    private fun paintBox(e: Entry, focused: Boolean) {
        val box = e.box ?: return
        box.background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated)
            if (focused) setStroke(dp(2), AppTheme.accent)
        }
        val sb = SpannableStringBuilder()
        fun span(s: String, color: Int) { val st = sb.length; sb.append(s); sb.setSpan(ForegroundColorSpan(color), st, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
        val untouched = !e.dirty && e.num.isEmpty() && e.prefix.isEmpty()
        if (untouched && e.suffix.isNotEmpty()) {
            span(e.raw, onSurface)          // a value the keypad can't take apart: show it as stored
        } else if (e.num.isEmpty() && e.prefix.isEmpty()) {
            if (focused) span("▏", AppTheme.accent)
            val ph = e.f.optString("ph")
            if (ph.isNotEmpty()) span(ph + if (e.defaultUnit.isNotEmpty()) " ${e.defaultUnit}" else "", tint(onSurface, 0x60))
        } else {
            span(e.num.replace('-', '−') + e.prefix, onSurface)
            if (focused) span("▏", AppTheme.accent)
            val u = e.suffix.ifEmpty { e.defaultUnit }
            if (u.isNotEmpty()) span(" $u", if (e.suffix.isEmpty()) muted else onSurface)
        }
        box.text = sb
    }

    private fun setFocus(idx: Int) {
        val e = entries.getOrNull(idx) ?: return
        val prev = entries.getOrNull(focus)
        focus = idx
        prev?.let { paintBox(it, false) }
        val kp = keypad ?: return
        if (e.keypad) {
            // Leaving a text box: put the system keyboard away and take its focus back.
            card?.let { c -> if (entries.any { it.edit?.hasFocus() == true }) { hideKeyboard(c); c.requestFocus() } }
            paintBox(e, true)
            buildKeypad(e)
            kp.visibility = View.VISIBLE
            val row = e.row
            scroll?.let { sc -> sc.post { if (row != null) sc.smoothScrollTo(0, (row.top - dp(8)).coerceAtLeast(0)) } }
        } else {
            kp.visibility = View.GONE
        }
    }

    // ---------- keypad ----------
    private enum class K { NUM, ACT, PICK, NEXT }

    private fun keyBg(kind: K, on: Boolean = false) = when {
        kind == K.NEXT || on -> AppTheme.accent
        kind == K.NUM -> AppTheme.elevated
        kind == K.PICK -> tint(AppTheme.accent, 0x30)
        else -> tint(AppTheme.text, 0x10)
    }

    private fun key(label: String, kind: K, onClick: () -> Unit) = TextView(act).apply {
        text = label; gravity = Gravity.CENTER; maxLines = 1
        textSize = if (kind == K.NUM) 21f else if (label.length > 3) 14f else 17f
        setTypeface(null, if (kind == K.NEXT || kind == K.PICK) Typeface.BOLD else Typeface.NORMAL)
        setTextColor(if (kind == K.NEXT) AppTheme.onAccent() else onSurface)
        background = pill(keyBg(kind), 12)
        setOnClickListener { performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); onClick() }
    }

    /** A row of equal-width pick keys (SI prefixes or unit suffixes). */
    private fun pickRow(keys: List<TextView>): View {
        val row = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }
        for (k in keys) row.addView(k, LinearLayout.LayoutParams(0, dp(44), 1f).apply { setMargins(dp(3), dp(3), dp(3), dp(3)) })
        return row
    }

    private fun buildKeypad(e: Entry) {
        val kp = keypad ?: return
        kp.removeAllViews(); prefixKeys.clear(); unitKeys.clear()
        if (e.units.isNotEmpty()) {
            val keys = e.units.mapIndexed { i, u ->
                key(u, K.PICK) { e.suffix = if (i == 0) "" else u; e.dirty = true; changed(e) }.also { unitKeys.add(i to it) }
            }
            // Many units scroll sideways rather than squeezing below a finger's width.
            if (keys.size <= 6) kp.addView(pickRow(keys))
            else kp.addView(HorizontalScrollView(act).apply {
                isHorizontalScrollBarEnabled = false
                addView(LinearLayout(act).apply {
                    orientation = LinearLayout.HORIZONTAL
                    for (k in keys) addView(k, LinearLayout.LayoutParams(dp(64), dp(44)).apply { setMargins(dp(3), dp(3), dp(3), dp(3)) })
                })
            })
        }
        if (e.mode == "si") {
            kp.addView(pickRow(SI_PREFIXES.map { p ->
                key(p, K.PICK) { e.prefix = if (e.prefix == p) "" else p; e.dirty = true; changed(e) }.also { prefixKeys.add(p to it) }
            }))
        }
        val grid = GridLayout(act).apply { columnCount = 4 }
        fun add(v: TextView) {
            grid.addView(v, GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED), GridLayout.spec(GridLayout.UNDEFINED, 1, 1f)).apply {
                width = 0; height = dp(54); setMargins(dp(3), dp(3), dp(3), dp(3))
            })
        }
        fun tap(op: () -> Unit) { op(); e.dirty = true; changed(e) }
        for (d in "789") add(key("$d", K.NUM) { tap { e.digit(d) } })
        add(key("⌫", K.ACT) { tap { e.back() } })
        for (d in "456") add(key("$d", K.NUM) { tap { e.digit(d) } })
        add(key("C", K.ACT) { tap { e.clear() } })
        for (d in "123") add(key("$d", K.NUM) { tap { e.digit(d) } })
        add(key("−", K.ACT) { tap { e.minus() } })
        add(key(".", K.NUM) { tap { e.dot() } })
        add(key("0", K.NUM) { tap { e.digit('0') } })
        add(key("E", K.ACT) { tap { e.exp() } })
        add(key("Next", K.NEXT) {
            val n = nextKeypadAfter(focus)
            if (n >= 0) setFocus(n) else saveNow?.invoke()
        }.also { nextKey = it })
        kp.addView(grid, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        changed(e)
    }

    private fun nextKeypadAfter(i: Int): Int {
        for (k in i + 1 until entries.size) if (entries[k].keypad) return k
        return -1
    }

    /** Repaint the focused box and the keys that show state (selected prefix / unit, Next vs Save). */
    private fun changed(e: Entry) {
        paintBox(e, true)
        for ((p, v) in prefixKeys) { val on = e.prefix == p; v.background = pill(keyBg(K.PICK, on), 12); v.setTextColor(if (on) AppTheme.onAccent() else onSurface) }
        for ((i, v) in unitKeys) {
            val on = if (e.suffix.isEmpty()) i == 0 else e.units.getOrNull(i)?.equals(e.suffix, ignoreCase = true) == true
            v.background = pill(keyBg(K.PICK, on), 12); v.setTextColor(if (on) AppTheme.onAccent() else onSurface)
        }
        nextKey?.text = if (nextKeypadAfter(focus) >= 0) "Next" else "Save"
    }

    companion object {
        private val SI_PREFIXES = listOf("p", "n", "µ", "m", "k", "M", "G")
        private const val PREFIX_CHARS = "fpnuµμmkKMGT"
        // Units whose values are usually written with SI prefixes (4.7k, 100n, 1m), when a field doesn't say.
        private val SI_UNITS = setOf("Ω", "F", "H", "V", "A", "Hz", "S")
        // A number as typed (sign, digits, point, exponent — possibly unfinished), then the rest.
        private val NUM_RE = Regex("""\s*([-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]*)?(?:(?<=[0-9.])[eE][-+]?[0-9]*)?)\s*(.*?)\s*""")

        private fun normPrefix(c: Char): String = when (c) { 'u', 'μ' -> "µ"; 'K' -> "k"; else -> c.toString() }
    }
}
