package com.engorg.inkpad

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * A Desmos-style graphing calculator that floats over the notebook: expressions on the left,
 * the graph on the right. Drag the header to move it, any edge or corner to resize it, and the
 * bar between the list and the graph to re-balance them. "Add to page" drops the visible graph
 * onto the focused page as ink (selected, so it can be dragged straight into place).
 *
 * Rows, view, angle mode and window geometry persist in SharedPreferences ("engink_graph").
 */
@SuppressLint("ClickableViewAccessibility", "SetTextI18n")
class GrapherWindow(
    private val act: Activity,
    private val host: FrameLayout,
    private val onInsert: (List<GraphInk>, Float, Float) -> Unit,
) {
    private val prefs = act.getSharedPreferences("engink_graph", Context.MODE_PRIVATE)
    private val dens = act.resources.displayMetrics.density
    private fun dp(v: Int) = (v * dens).toInt()
    private fun dpf(v: Float) = v * dens
    private fun alpha(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))

    private val colors: IntArray get() = intArrayOf(
        Color.rgb(0xC7, 0x44, 0x40), Color.rgb(0x2D, 0x70, 0xB3), Color.rgb(0x38, 0x8C, 0x46), Color.rgb(0x60, 0x42, 0xA6),
        Color.rgb(0xFA, 0x7E, 0x19), if (AppTheme.dark) Color.rgb(0xE5, 0xE7, 0xEB) else Color.rgb(0x1F, 0x29, 0x37),
        Color.rgb(0x00, 0x96, 0x88), Color.rgb(0xD8, 0x1B, 0x60),
    )

    private val rows = ArrayList<GraphRow>()
    private val views = ArrayList<RowView>()
    private var degrees = false
    private var leftW = 0
    private var maximized = false
    private var restore: IntArray? = null
    private var lastEdit: EditText? = null
    private var suppress = false
    private var built = false
    private var palette: PopupWindow? = null

    private lateinit var frame: ResizableFrame
    private lateinit var graph: GraphView
    private lateinit var list: LinearLayout
    private lateinit var leftPanel: LinearLayout
    private lateinit var angleBtn: TextView

    private val handler = Handler(Looper.getMainLooper())
    private val rebuildTask = Runnable { rebuild() }
    private val saveTask = Runnable { save() }

    val isOpen: Boolean get() = built && frame.parent != null
    var onClosed: (() -> Unit)? = null

    fun toggle() { if (isOpen) close() else open() }

    fun open() {
        if (!built) build()
        if (frame.parent == null) {
            val r = loadRect()
            host.addView(frame, FrameLayout.LayoutParams(r[2], r[3]).apply { gravity = Gravity.TOP or Gravity.START; leftMargin = r[0]; topMargin = r[1] })
        }
        frame.bringToFront()
        rebuild()
    }

    fun close() {
        if (!built) return
        palette?.dismiss()
        save()
        (act.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(frame.windowToken, 0)
        host.removeView(frame)
        onClosed?.invoke()
    }

    fun dispose() { if (built) { save(); graph.dispose() } }

    // ================================================================= build
    private fun build() {
        built = true
        load()
        frame = ResizableFrame()
        frame.background = GradientDrawable().apply {
            cornerRadius = dpf(16f); setColor(AppTheme.surface)
            setStroke(dp(1), alpha(AppTheme.text, 0x30))
        }
        frame.elevation = dpf(18f)
        frame.clipToOutline = true
        frame.isClickable = true

        val col = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        col.addView(buildHeader(), LinearLayout.LayoutParams(MATCH_PARENT, dp(46)))
        col.addView(View(act).apply { setBackgroundColor(alpha(AppTheme.text, 0x1E)) }, LinearLayout.LayoutParams(MATCH_PARENT, dp(1)))

        val body = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }
        leftPanel = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(AppTheme.surface) }
        list = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(act).apply { isFillViewport = true; addView(list) }
        leftPanel.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        leftPanel.addView(TextView(act).apply {
            text = "+  Add expression"; textSize = 14f; setTextColor(AppTheme.accent); setTypeface(null, Typeface.BOLD)
            setPadding(dp(14), dp(10), dp(14), dp(18))
            setOnClickListener { addRow(rows.size, "", focus = true) }
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        body.addView(leftPanel, LinearLayout.LayoutParams(leftW, MATCH_PARENT))
        body.addView(buildSplitter(body), LinearLayout.LayoutParams(dp(7), MATCH_PARENT))
        graph = GraphView(act)
        body.addView(graph, LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
        col.addView(body, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        frame.addView(col, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        val v = prefs.getString("view", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (v != null) graph.setView(v.optDouble("cx", 0.0), v.optDouble("cy", 0.0), v.optDouble("units", 20.0))
        graph.onViewChanged = { handler.removeCallbacks(saveTask); handler.postDelayed(saveTask, 600) }

        for (r in rows) list.addView(RowView(r).also { views.add(it) }.box)
        if (rows.isEmpty()) addRow(0, "", focus = false)
    }

    private fun chip(label: String, filled: Boolean = false, onClick: (TextView) -> Unit) = TextView(act).apply {
        text = label; textSize = 13f; setTypeface(null, Typeface.BOLD); gravity = Gravity.CENTER
        setTextColor(if (filled) AppTheme.onAccent() else AppTheme.text)
        background = GradientDrawable().apply { cornerRadius = dpf(15f); setColor(if (filled) AppTheme.accent else AppTheme.elevated) }
        setPadding(dp(11), dp(6), dp(11), dp(6))
        layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, dp(30)).apply { leftMargin = dp(6) }
        setOnClickListener { onClick(this) }
    }

    private fun iconChip(path: String, onClick: (View) -> Unit) = ImageButton(act).apply {
        setImageBitmap(Icons.bitmap(path, dp(18))); setColorFilter(AppTheme.text)
        background = GradientDrawable().apply { cornerRadius = dpf(15f); setColor(AppTheme.elevated) }
        scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
        val p = dp(6); setPadding(p, p, p, p)
        layoutParams = LinearLayout.LayoutParams(dp(36), dp(30)).apply { leftMargin = dp(6) }
        setOnClickListener { onClick(this) }
    }

    private fun buildHeader(): View {
        val header = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(6), dp(10), dp(6))
        }
        header.addView(ImageView(act).apply {
            setImageBitmap(Icons.bitmap(Icons.GRAPH, dp(18))); setColorFilter(AppTheme.accent)
            layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(8) }
        })
        header.addView(TextView(act).apply {
            text = "Graph"; textSize = 15f; setTypeface(null, Typeface.BOLD); setTextColor(AppTheme.text)
            maxLines = 1
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        val tools = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        tools.addView(chip("ƒ(x)") { showPalette(it) })
        angleBtn = chip(if (degrees) "DEG" else "RAD") { toggleAngle() }
        tools.addView(angleBtn)
        tools.addView(iconChip(Icons.HOME) { graph.home() })
        tools.addView(chip("Add to page", filled = true) { insert() })
        tools.addView(iconChip(Icons.FIT) { toggleMax() })
        tools.addView(iconChip(Icons.CLOSE) { close() })
        header.addView(HorizontalScrollView(act).apply { isHorizontalScrollBarEnabled = false; addView(tools) },
            LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))

        // Drag the header to move the window (kept partly on screen).
        var rx = 0f; var ry = 0f; var l0 = 0; var t0 = 0
        header.setOnTouchListener { _, e ->
            val lp = frame.layoutParams as FrameLayout.LayoutParams
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { rx = e.rawX; ry = e.rawY; l0 = lp.leftMargin; t0 = lp.topMargin; frame.bringToFront() }
                MotionEvent.ACTION_MOVE -> {
                    val w = frame.width
                    lp.leftMargin = (l0 + (e.rawX - rx)).toInt().coerceIn(-(w - dp(140)), host.width - dp(140))
                    lp.topMargin = (t0 + (e.rawY - ry)).toInt().coerceIn(0, (host.height - dp(56)).coerceAtLeast(0))
                    frame.layoutParams = lp
                    maximized = false
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> save()
            }
            true
        }
        return header
    }

    private fun buildSplitter(body: LinearLayout): View {
        val v = object : View(act) {
            val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = alpha(AppTheme.text, 0x55) }
            override fun onDraw(c: Canvas) {
                c.drawColor(alpha(AppTheme.text, 0x12))
                val cxp = width / 2f; val cyp = height / 2f
                for (k in -1..1) c.drawCircle(cxp, cyp + k * dpf(7f), dpf(1.6f), p)
            }
        }
        var rx = 0f; var w0 = 0
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { rx = e.rawX; w0 = leftPanel.width; v.parent?.requestDisallowInterceptTouchEvent(true) }
                MotionEvent.ACTION_MOVE -> {
                    val maxW = (body.width - dp(150)).coerceAtLeast(dp(170))
                    leftW = (w0 + (e.rawX - rx)).toInt().coerceIn(dp(170), maxW)
                    leftPanel.layoutParams = (leftPanel.layoutParams as LinearLayout.LayoutParams).apply { width = leftW }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> save()
            }
            true
        }
        return v
    }

    // ================================================================= window frame (resizable from any edge)
    private inner class ResizableFrame : FrameLayout(act) {
        private val L = 1; private val T = 2; private val R = 4; private val B = 8
        private val grab = dp(14); private val grabTop = dp(5); private val corner = dp(28)
        private var edges = 0
        private var rx = 0f; private var ry = 0f
        private var l0 = 0; private var t0 = 0; private var w0 = 0; private var h0 = 0
        private val grip = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeWidth = dpf(1.6f); strokeCap = Paint.Cap.ROUND; color = alpha(AppTheme.text, 0x70) }

        init { setWillNotDraw(false) }

        private fun edgesAt(x: Float, y: Float): Int {
            if (x > width - corner && y > height - corner) return R or B
            if (x < corner && y > height - corner) return L or B
            var e = 0
            if (x < grab) e = e or L
            if (x > width - grab) e = e or R
            if (y < grabTop) e = e or T
            if (y > height - grab) e = e or B
            return e
        }

        private fun begin(e: MotionEvent) {
            rx = e.rawX; ry = e.rawY
            val lp = layoutParams as FrameLayout.LayoutParams
            l0 = lp.leftMargin; t0 = lp.topMargin; w0 = width; h0 = height
            bringToFront()
        }

        override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
            if (e.actionMasked == MotionEvent.ACTION_DOWN) {
                edges = edgesAt(e.x, e.y)
                if (edges != 0) { begin(e); return true }
            }
            return false
        }

        override fun onTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { edges = edgesAt(e.x, e.y); if (edges != 0) begin(e) }
                MotionEvent.ACTION_MOVE -> if (edges != 0) resize(e.rawX - rx, e.rawY - ry)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (edges != 0) { edges = 0; save() }
            }
            return true   // never let touches fall through to the page underneath
        }

        private fun resize(dx: Float, dy: Float) {
            val lp = layoutParams as FrameLayout.LayoutParams
            val pw = host.width; val ph = host.height
            val minW = min(dp(400), pw); val minH = min(dp(250), ph)
            var l = l0; var t = t0; var w = w0; var h = h0
            if (edges and R != 0) w = (w0 + dx).toInt().coerceIn(minW, max(minW, pw - l0))
            if (edges and B != 0) h = (h0 + dy).toInt().coerceIn(minH, max(minH, ph - t0))
            if (edges and L != 0) { val nl = (l0 + dx).toInt().coerceIn(min(0, l0), l0 + w0 - minW); w = w0 + (l0 - nl); l = nl }
            if (edges and T != 0) { val nt = (t0 + dy).toInt().coerceIn(0, t0 + h0 - minH); h = h0 + (t0 - nt); t = nt }
            lp.leftMargin = l; lp.topMargin = t; lp.width = w; lp.height = h
            layoutParams = lp
            maximized = false
        }

        override fun dispatchDraw(c: Canvas) {
            super.dispatchDraw(c)
            // Corner grip (bottom-right) so it's obvious the window resizes.
            val r = width - dpf(6f); val b = height - dpf(6f)
            for (k in 1..3) { val o = dpf(4.5f) * k; c.drawLine(r - o, b, r, b - o, grip) }
        }
    }

    private fun toggleMax() {
        val lp = frame.layoutParams as FrameLayout.LayoutParams
        if (!maximized) {
            restore = intArrayOf(lp.leftMargin, lp.topMargin, frame.width, frame.height)
            val m = dp(10); val top = dp(30)
            lp.leftMargin = m; lp.topMargin = top; lp.width = host.width - 2 * m; lp.height = host.height - top - m
            maximized = true
        } else {
            val r = restore ?: return
            lp.leftMargin = r[0]; lp.topMargin = r[1]; lp.width = r[2]; lp.height = r[3]
            maximized = false
        }
        frame.layoutParams = lp
        save()
    }

    // ================================================================= rows
    private inner class RowView(val row: GraphRow) {
        val box = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(8), dp(6), dp(6), dp(6)) }
        val dot = View(act)
        val edit = EditText(act)
        val info = TextView(act)
        val slider = LinearLayout(act)
        val seek = SeekBar(act)
        val sMin = smallEdit(); val sMax = smallEdit()
        val range = LinearLayout(act)
        val tMin = smallEdit(); val tMax = smallEdit()
        val rangeLabel = TextView(act)
        var status: RowStatus? = null

        init {
            val top = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            paintDot()
            dot.setOnClickListener { row.hidden = !row.hidden; paintDot(); rebuild() }
            dot.setOnLongClickListener { showColors(dot) { c -> row.color = c; paintDot(); rebuild() }; true }
            top.addView(dot, LinearLayout.LayoutParams(dp(22), dp(22)).apply { rightMargin = dp(8); leftMargin = dp(2) })

            edit.apply {
                setText(row.text)
                textSize = 16f; setTextColor(AppTheme.text); setHintTextColor(alpha(AppTheme.text, 0x70))
                hint = if (rows.indexOf(row) <= 0) "y = x², x²+y²=9, r = 2cos3θ…" else "Expression"
                isSingleLine = true
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                imeOptions = EditorInfo.IME_ACTION_NEXT or EditorInfo.IME_FLAG_NO_EXTRACT_UI
                background = GradientDrawable().apply { cornerRadius = dpf(8f); setColor(AppTheme.elevated) }
                setPadding(dp(10), dp(8), dp(10), dp(8))
                setOnEditorActionListener { _, id, ev ->
                    if (id == EditorInfo.IME_ACTION_NEXT || id == EditorInfo.IME_ACTION_DONE ||
                        (ev != null && ev.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) {
                        addRow(rows.indexOf(row) + 1, "", focus = true); true
                    } else false
                }
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun afterTextChanged(s: Editable?) { if (suppress) return; row.text = s?.toString() ?: ""; scheduleRebuild() }
                })
                setOnFocusChangeListener { _, has -> if (has) { lastEdit = this; graph.focusRow = rows.indexOf(row) } }
            }
            top.addView(edit, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            top.addView(ImageButton(act).apply {
                setImageBitmap(Icons.bitmap(Icons.CLOSE, dp(16))); setColorFilter(alpha(AppTheme.text, 0x99))
                background = null; scaleType = ImageView.ScaleType.FIT_CENTER
                val p = dp(6); setPadding(p, p, p, p)
                setOnClickListener { removeRow(this@RowView) }
            }, LinearLayout.LayoutParams(dp(32), dp(32)).apply { leftMargin = dp(2) })
            box.addView(top)

            info.apply { textSize = 12.5f; setPadding(dp(32), dp(3), dp(4), 0); visibility = View.GONE }
            box.addView(info)

            // slider: [min] ——o—— [max]
            slider.apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(26), dp(2), 0, 0); visibility = View.GONE }
            sMin.setText(MathEngine.fmt(row.sMin, 6).replace("−", "-")); sMax.setText(MathEngine.fmt(row.sMax, 6).replace("−", "-"))
            seek.max = 1000
            seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) { if (fromUser) slide(p) }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) { save() }
            })
            val boundWatch = object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    if (suppress) return
                    num(sMin.text.toString())?.let { row.sMin = it }
                    num(sMax.text.toString())?.let { row.sMax = it }
                    syncSeek(); save()
                }
            }
            sMin.addTextChangedListener(boundWatch); sMax.addTextChangedListener(boundWatch)
            slider.addView(sMin, LinearLayout.LayoutParams(dp(54), WRAP_CONTENT))
            slider.addView(seek, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            slider.addView(sMax, LinearLayout.LayoutParams(dp(54), WRAP_CONTENT))
            box.addView(slider)

            // parametric / polar domain: [start] ≤ t ≤ [end]
            range.apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(32), dp(4), 0, 0); visibility = View.GONE }
            tMin.setText(row.tMin); tMax.setText(row.tMax)
            val rangeWatch = object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: Editable?) { if (suppress) return; row.tMin = tMin.text.toString(); row.tMax = tMax.text.toString(); scheduleRebuild() }
            }
            tMin.addTextChangedListener(rangeWatch); tMax.addTextChangedListener(rangeWatch)
            rangeLabel.apply { textSize = 13f; setTextColor(alpha(AppTheme.text, 0xB0)); setPadding(dp(8), 0, dp(8), 0) }
            range.addView(tMin, LinearLayout.LayoutParams(dp(64), WRAP_CONTENT))
            range.addView(rangeLabel)
            range.addView(tMax, LinearLayout.LayoutParams(dp(64), WRAP_CONTENT))
            box.addView(range)

            box.addView(View(act).apply { setBackgroundColor(alpha(AppTheme.text, 0x14)) },
                LinearLayout.LayoutParams(MATCH_PARENT, dp(1)).apply { topMargin = dp(6) })
        }

        fun paintDot() {
            dot.background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                if (row.hidden) { setColor(Color.TRANSPARENT); setStroke(dp(2), row.color) } else setColor(row.color)
            }
        }

        fun syncSeek() {
            val v = status?.value ?: return
            val span = row.sMax - row.sMin
            if (span > 0 && v.isFinite()) seek.progress = (((v - row.sMin) / span) * 1000).toInt().coerceIn(0, 1000)
        }

        fun slide(p: Int) {
            val name = status?.sliderName ?: return
            val span = row.sMax - row.sMin
            if (span <= 0) return
            var v = row.sMin + span * p / 1000.0
            val q = 10.0.pow(floor(log10(span / 1000.0)))
            v = Math.rint(v / q) * q
            val txt = "$name = " + MathEngine.fmt(v, 8).replace("−", "-")
            suppress = true
            edit.setText(txt); edit.setSelection(txt.length)
            suppress = false
            row.text = txt
            rebuild()
        }

        fun apply(s: RowStatus) {
            status = s
            val msg = when {
                s.error && s.missing != null -> "⚠ ${s.info}  ·  tap to add a slider for ${s.missing}"
                s.error -> "⚠ ${s.info}"
                else -> s.info
            }
            info.text = msg
            info.setTextColor(if (s.error) Color.rgb(0xD3, 0x2F, 0x2F) else alpha(AppTheme.text, 0xB8))
            info.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
            info.setOnClickListener(if (s.missing != null) View.OnClickListener { addRow(rows.indexOf(row), "${s.missing} = 1", focus = false) } else null)
            slider.visibility = if (s.kind == RowKind.SLIDER) View.VISIBLE else View.GONE
            if (s.kind == RowKind.SLIDER) {
                // Grow the slider's bounds to include a typed value.
                val v = s.value
                if (v.isFinite() && (v < row.sMin || v > row.sMax)) {
                    if (v < row.sMin) row.sMin = floor(v)
                    if (v > row.sMax) row.sMax = kotlin.math.ceil(v)
                    suppress = true
                    sMin.setText(MathEngine.fmt(row.sMin, 6).replace("−", "-")); sMax.setText(MathEngine.fmt(row.sMax, 6).replace("−", "-"))
                    suppress = false
                }
                syncSeek()
            }
            range.visibility = if (s.rangeVar != null) View.VISIBLE else View.GONE
            if (s.rangeVar != null) rangeLabel.text = "≤ ${s.rangeVar} ≤"
        }
    }

    private fun smallEdit() = EditText(act).apply {
        textSize = 13f; setTextColor(AppTheme.text); gravity = Gravity.CENTER
        isSingleLine = true
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
        background = GradientDrawable().apply { cornerRadius = dpf(6f); setColor(AppTheme.elevated) }
        setPadding(dp(4), dp(4), dp(4), dp(4))
    }

    private fun num(s: String): Double? = try {
        MathEngine.evalConst(MathEngine.parseExpr(s), MathEnv(degrees)).takeIf { it.isFinite() }
    } catch (_: Exception) { null }

    private fun nextColor(): Int {
        val cs = colors
        val used = rows.map { it.color }
        return cs.firstOrNull { it !in used } ?: cs[rows.size % cs.size]
    }

    private fun addRow(index: Int, text: String, focus: Boolean) {
        val r = GraphRow(text, nextColor())
        if (degrees) r.tMax = "360"
        val i = index.coerceIn(0, rows.size)
        rows.add(i, r)
        val rv = RowView(r)
        views.add(i, rv)
        list.addView(rv.box, i)
        if (focus) {
            rv.edit.requestFocus()
            (act.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.showSoftInput(rv.edit, InputMethodManager.SHOW_IMPLICIT)
        }
        rebuild()
    }

    private fun removeRow(rv: RowView) {
        if (rows.size <= 1) { rv.edit.setText(""); return }
        val i = views.indexOf(rv)
        if (i < 0) return
        rows.removeAt(i); views.removeAt(i); list.removeView(rv.box)
        if (lastEdit === rv.edit) lastEdit = null
        graph.focusRow = -1
        rebuild()
    }

    private fun scheduleRebuild() { handler.removeCallbacks(rebuildTask); handler.postDelayed(rebuildTask, 160) }

    private fun rebuild() {
        handler.removeCallbacks(rebuildTask)
        if (!built) return
        val m = GraphModel.build(rows, degrees)
        for (i in views.indices) views[i].apply(m.statuses.getOrElse(i) { RowStatus(RowKind.EMPTY) })
        graph.focusRow = lastEdit?.let { e -> views.indexOfFirst { it.edit === e } } ?: -1
        graph.setModel(m)
        handler.removeCallbacks(saveTask); handler.postDelayed(saveTask, 400)
    }

    private fun toggleAngle() {
        degrees = !degrees
        angleBtn.text = if (degrees) "DEG" else "RAD"
        // Default polar/parametric domains follow the unit (2π ↔ 360).
        suppress = true
        for (rv in views) {
            if (degrees && rv.row.tMax.replace(" ", "") == "2pi") { rv.row.tMax = "360"; rv.tMax.setText("360") }
            else if (!degrees && rv.row.tMax.trim() == "360") { rv.row.tMax = "2pi"; rv.tMax.setText("2pi") }
        }
        suppress = false
        rebuild()
    }

    private fun showColors(anchor: View, onPick: (Int) -> Unit) {
        val rowv = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(dp(8), dp(8), dp(8), dp(8))
            background = GradientDrawable().apply { cornerRadius = dpf(14f); setColor(AppTheme.surface); setStroke(dp(1), alpha(AppTheme.text, 0x30)) }
        }
        val pop = PopupWindow(rowv, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dpf(12f) }
        for (c in colors) rowv.addView(View(act).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(c) }
            layoutParams = LinearLayout.LayoutParams(dp(28), dp(28)).apply { setMargins(dp(4), 0, dp(4), 0) }
            setOnClickListener { pop.dismiss(); onPick(c) }
        })
        pop.showAsDropDown(anchor, 0, dp(4))
    }

    // ================================================================= function palette
    private fun fns(vararg names: String) = names.map { it to "$it(§)" }

    private val catalog: List<Pair<String, List<Pair<String, String>>>> by lazy {
        listOf(
            "Basic" to listOf(
                "x" to "x", "y" to "y", "π" to "π", "e" to "e", "θ" to "θ", "t" to "t", "x²" to "^2", "xʸ" to "^",
                "√" to "sqrt(§)", "∛" to "cbrt(§)", "ⁿ√" to "root(§, 3)", "|x|" to "abs(§)", "( )" to "(§)", "÷" to "/",
                "×" to "*", "n!" to "!", "=" to " = ", "<" to " < ", ">" to " > ", "≤" to " ≤ ", "≥" to " ≥ ", "∞" to "inf",
                "{ : }" to "{§: , }", "(x, y)" to "(§, )", "mod" to "mod(§, )", "d/dx" to "d/dx(§)",
            ),
            "Trig" to fns("sin", "cos", "tan", "sec", "csc", "cot") + listOf(
                "sin⁻¹" to "asin(§)", "cos⁻¹" to "acos(§)", "tan⁻¹" to "atan(§)", "sec⁻¹" to "asec(§)", "csc⁻¹" to "acsc(§)",
                "cot⁻¹" to "acot(§)", "atan2" to "atan2(§, )", "deg" to "deg(§)", "rad" to "rad(§)",
            ),
            "Hyperbolic" to fns("sinh", "cosh", "tanh", "sech", "csch", "coth") + listOf(
                "sinh⁻¹" to "asinh(§)", "cosh⁻¹" to "acosh(§)", "tanh⁻¹" to "atanh(§)", "sech⁻¹" to "asech(§)",
                "csch⁻¹" to "acsch(§)", "coth⁻¹" to "acoth(§)",
            ),
            "Exp/Log" to listOf(
                "eˣ" to "e^", "exp" to "exp(§)", "ln" to "ln(§)", "log₁₀" to "log(§)", "log₂" to "log_2(§)", "logᵦ" to "log(§, 3)",
                "expm1" to "expm1(§)", "log1p" to "log1p(§)", "10ˣ" to "10^", "2ˣ" to "2^",
            ),
            "Calculus" to listOf(
                "d/dx" to "d/dx(§)", "f'(x)" to "f'(x)", "f''(x)" to "f''(x)", "deriv" to "deriv(§, x)", "f' at a" to "deriv(§, x, 1)",
                "∫ₐᵇ" to "int(§, x, 0, 1)", "∫₀ˣ" to "int(§, t, 0, x)", "∫ −∞..∞" to "int(§, x, -inf, inf)",
                "Σ" to "sum(§, n, 1, 10)", "Σ ∞" to "sum(§, n, 1, inf)", "Π" to "prod(§, n, 1, 10)", "lim" to "lim(§, x, 0)",
                "lim ∞" to "lim(§, x, inf)",
            ),
            "Special" to listOf(
                "Γ" to "gamma(§)", "lnΓ" to "lgamma(§)", "ψ" to "digamma(§)", "B(a,b)" to "beta(§, )", "erf" to "erf(§)",
                "erfc" to "erfc(§)", "erf⁻¹" to "erfinv(§)", "ζ" to "zeta(§)", "W" to "lambertw(§)", "Si" to "Si(§)",
                "Ci" to "Ci(§)", "Ei" to "Ei(§)", "li" to "li(§)", "S(x)" to "fresnels(§)", "C(x)" to "fresnelc(§)",
                "K(m)" to "ellipk(§)", "E(m)" to "ellipe(§)", "Jₙ" to "besselj(0, §)", "Yₙ" to "bessely(0, §)",
                "Iₙ" to "besseli(0, §)", "Kₙ" to "besselk(0, §)", "Ai" to "airyai(§)", "Bi" to "airybi(§)",
                "P(a,x)" to "gammainc(2, §)", "Iₓ(a,b)" to "betainc(§, 2, 3)", "sinc" to "sinc(§)", "step" to "step(§)",
                "rect" to "rect(§)", "tri" to "tri(§)", "sigmoid" to "sigmoid(§)",
            ),
            "Stats" to listOf(
                "mean" to "mean(§, )", "median" to "median(§, )", "stdev" to "stdev(§, )", "var" to "var(§, )",
                "nCr" to "nCr(§, )", "nPr" to "nPr(§, )", "n!" to "factorial(§)", "normpdf" to "normalpdf(§)",
                "normcdf" to "normalcdf(§)", "invnorm" to "invnorm(§)", "tpdf" to "tpdf(§, 5)", "tcdf" to "tcdf(§, 5)",
                "χ²pdf" to "chisqpdf(§, 3)", "χ²cdf" to "chisqcdf(§, 3)", "binompdf" to "binompdf(§, 10, 0.5)",
                "binomcdf" to "binomcdf(§, 10, 0.5)", "poisspdf" to "poissonpdf(§, 3)", "poisscdf" to "poissoncdf(§, 3)",
                "exppdf" to "exppdf(§, 1)", "expcdf" to "expcdf(§, 1)",
            ),
            "Misc" to fns("floor", "ceil", "round", "trunc", "frac", "sign") + listOf(
                "min" to "min(§, )", "max" to "max(§, )", "clamp" to "clamp(§, 0, 1)", "hypot" to "hypot(§, )",
                "gcd" to "gcd(§, )", "lcm" to "lcm(§, )", "isprime" to "isprime(§)", "if" to "if(§, , )", "relu" to "relu(§)",
            ),
        )
    }

    private fun showPalette(anchor: View) {
        palette?.let { if (it.isShowing) { it.dismiss(); return } }
        val content = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(8), dp(8), dp(8), dp(8))
            background = GradientDrawable().apply { cornerRadius = dpf(14f); setColor(AppTheme.surface); setStroke(dp(1), alpha(AppTheme.text, 0x30)) }
        }
        val tabs = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL }
        val grid = GridLayout(act).apply { columnCount = 4 }
        val tabViews = ArrayList<TextView>()
        fun showTab(k: Int) {
            tabViews.forEachIndexed { i, tv ->
                val on = i == k
                tv.setTextColor(if (on) AppTheme.onAccent() else AppTheme.text)
                (tv.background as GradientDrawable).setColor(if (on) AppTheme.accent else AppTheme.elevated)
            }
            grid.removeAllViews()
            for ((label, tpl) in catalog[k].second) grid.addView(TextView(act).apply {
                text = label; textSize = 13.5f; gravity = Gravity.CENTER; maxLines = 1; setTextColor(AppTheme.text)
                background = GradientDrawable().apply { cornerRadius = dpf(9f); setColor(AppTheme.elevated) }
                layoutParams = GridLayout.LayoutParams().apply { width = dp(80); height = dp(38); setMargins(dp(3), dp(3), dp(3), dp(3)) }
                setOnClickListener { insertText(tpl) }
            })
        }
        catalog.forEachIndexed { i, (name, _) ->
            val tv = TextView(act).apply {
                text = name; textSize = 12.5f; setTypeface(null, Typeface.BOLD)
                background = GradientDrawable().apply { cornerRadius = dpf(13f); setColor(AppTheme.elevated) }
                setPadding(dp(10), dp(5), dp(10), dp(5))
                layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = dp(5) }
                setOnClickListener { showTab(i) }
            }
            tabViews.add(tv); tabs.addView(tv)
        }
        content.addView(HorizontalScrollView(act).apply { isHorizontalScrollBarEnabled = false; addView(tabs) })
        content.addView(ScrollView(act).apply { addView(grid) }, LinearLayout.LayoutParams(WRAP_CONTENT, dp(214)).apply { topMargin = dp(8) })
        showTab(0)
        // Not focusable, so the expression keeps the keyboard and the cursor while you tap functions.
        val pop = PopupWindow(content, dp(370), WRAP_CONTENT, false).apply {
            elevation = dpf(14f); isOutsideTouchable = true; setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }
        palette = pop
        pop.showAsDropDown(anchor, -dp(150), dp(6))
    }

    private fun insertText(tpl: String) {
        val e = lastEdit ?: views.lastOrNull()?.edit ?: return
        if (!e.hasFocus()) e.requestFocus()
        val cur = tpl.indexOf('§').let { if (it < 0) tpl.replace("§", "").length else it }
        val txt = tpl.replace("§", "")
        val a = max(0, min(e.selectionStart, e.selectionEnd)); val b = max(0, max(e.selectionStart, e.selectionEnd))
        e.text.replace(a, b, txt)
        e.setSelection((a + cur).coerceIn(0, e.text.length))
    }

    // ================================================================= add to page
    private fun insert() {
        val r = graph.exportInk()
        if (r == null || r.first.size <= 1) { Toast.makeText(act, "Nothing to add yet — type an expression first.", Toast.LENGTH_SHORT).show(); return }
        onInsert(r.first, r.second, r.third)
    }

    // ================================================================= persistence
    private fun load() {
        degrees = prefs.getBoolean("deg", false)
        rows.clear()
        try {
            val arr = JSONArray(prefs.getString("rows", "[]"))
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                rows.add(GraphRow(
                    o.optString("t", ""), o.optInt("c", colors[i % colors.size]), o.optBoolean("h", false),
                    o.optDouble("smin", -10.0), o.optDouble("smax", 10.0), o.optString("tmin", "0"), o.optString("tmax", "2pi"),
                ))
            }
        } catch (_: Exception) { }
        val hw = host.width.coerceAtLeast(dp(600))
        leftW = prefs.getInt("split", 0).takeIf { it > 0 } ?: (hw * 0.62f * 0.36f).toInt().coerceIn(dp(220), dp(380))
    }

    private fun loadRect(): IntArray {
        val pw = host.width.takeIf { it > 0 } ?: act.resources.displayMetrics.widthPixels
        val ph = host.height.takeIf { it > 0 } ?: act.resources.displayMetrics.heightPixels
        val minW = min(dp(400), pw); val minH = min(dp(250), ph)
        var w = prefs.getInt("w", 0); var h = prefs.getInt("h", 0)
        if (w <= 0 || h <= 0) { w = (pw * 0.64f).toInt(); h = (ph * 0.56f).toInt() }
        w = w.coerceIn(minW, pw); h = h.coerceIn(minH, ph)
        var x = prefs.getInt("x", Int.MIN_VALUE); var y = prefs.getInt("y", Int.MIN_VALUE)
        if (x == Int.MIN_VALUE) { x = (pw - w) / 2; y = dp(92) }
        x = x.coerceIn(-(w - dp(140)), pw - dp(140)); y = y.coerceIn(0, (ph - dp(56)).coerceAtLeast(0))
        return intArrayOf(x, y, w, h)
    }

    private fun save() {
        if (!built) return
        handler.removeCallbacks(saveTask)
        val arr = JSONArray()
        for (r in rows) arr.put(JSONObject().put("t", r.text).put("c", r.color).put("h", r.hidden)
            .put("smin", r.sMin).put("smax", r.sMax).put("tmin", r.tMin).put("tmax", r.tMax))
        val e = prefs.edit().putString("rows", arr.toString()).putBoolean("deg", degrees).putInt("split", leftW)
        if (graph.ppu > 0) e.putString("view", JSONObject().put("cx", graph.cx).put("cy", graph.cy).put("units", graph.unitsAcross()).toString())
        if (frame.parent != null && !maximized) {
            val lp = frame.layoutParams as FrameLayout.LayoutParams
            e.putInt("x", lp.leftMargin).putInt("y", lp.topMargin).putInt("w", frame.width.takeIf { it > 0 } ?: lp.width).putInt("h", frame.height.takeIf { it > 0 } ?: lp.height)
        }
        e.apply()
    }
}
