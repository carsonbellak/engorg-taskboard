package com.engorg.inkpad

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
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
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow

/**
 * The grapher as a window that lives on a notebook page. It sits exactly over its graph card,
 * moves and zooms with the page, and edits that card in place: Desmos-style math input on the left
 * (fractions, exponents, roots and ∫ / Σ with tappable bounds build as you type), the 2D or 3D graph
 * on the right. A toolbar floats just above it; drag that to move the graph on the page, the corner
 * grip to resize it. When you tap away it turns back into the card, which draws the same way.
 *
 * Layout is done at [K] pixels per page unit, then the whole window is scaled by pageScale / K, so it
 * keeps its proportions on the page at any zoom.
 */
@SuppressLint("ClickableViewAccessibility", "SetTextI18n", "ViewConstructor")
class GraphPane(
    private val act: Activity,
    private val host: FrameLayout,
    private val cb: Callbacks,
) {
    interface Callbacks {
        /** The card's box on screen (host coordinates), or null if it's gone. */
        fun screenRect(): RectF?
        fun pageScale(): Float
        /** Save the edited card onto the page (called as you edit, debounced). */
        fun commit(card: GraphCard)
        /** Move the card by page units ([done] at the end of the drag). */
        fun moveBy(dx: Float, dy: Float, done: Boolean)
        /** Resize the card to [w]×[h] page units. */
        fun resizeTo(w: Float, h: Float, done: Boolean)
        /** Drop the current graph onto the page as ink strokes. */
        fun insertInk(ink: List<GraphInk>, w: Float, h: Float)
        fun closed()
    }

    private val dens = act.resources.displayMetrics.density
    private val K = dens   // layout pixels per page unit
    private fun dp(v: Int) = (v * dens).toInt()
    private fun dpf(v: Float) = v * dens
    private fun alpha(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))

    private var bg = Color.WHITE
    private var ink = Color.BLACK

    private val colors: IntArray get() = intArrayOf(
        Color.rgb(0xC7, 0x44, 0x40), Color.rgb(0x2D, 0x70, 0xB3), Color.rgb(0x38, 0x8C, 0x46), Color.rgb(0x60, 0x42, 0xA6),
        Color.rgb(0xFA, 0x7E, 0x19), ink, Color.rgb(0x00, 0x96, 0x88), Color.rgb(0xD8, 0x1B, 0x60),
    )

    private val rows = ArrayList<GraphRow>()
    private val views = ArrayList<RowView>()
    private var dim3 = false
    private var degrees = false
    private var lastField: MathField? = null
    private var suppress = false
    private var palette: PopupWindow? = null
    private var boxW = 600f; private var boxH = 320f   // card size in page units

    private val root = FrameLayout(act)
    private val headerH = dp(40)
    private lateinit var header: LinearLayout
    private lateinit var body: LinearLayout
    private lateinit var leftPanel: LinearLayout
    private lateinit var list: LinearLayout
    private lateinit var graph: GraphView
    private lateinit var graph3: Graph3DView
    private lateinit var modeBtn: TextView
    private lateinit var angleBtn: TextView

    private val handler = Handler(Looper.getMainLooper())
    private val rebuildTask = Runnable { rebuild() }
    private val commitTask = Runnable { commitNow() }

    val isOpen get() = root.parent != null

    // ================================================================= open / place / close
    fun open(card: GraphCard, w: Float, h: Float, dark: Boolean) {
        val (b, i) = GraphCardRenderer.cardColors(dark)
        bg = b; ink = i
        boxW = w; boxH = h
        dim3 = card.dim3; degrees = card.degrees
        rows.clear(); rows.addAll(GraphCard.copyRows(card.rows))
        build()
        graph.setView(card.cx, card.cy, card.units)
        graph3.setView(card.yaw, card.pitch, card.range)
        applyMode()
        reloadRows()
        host.addView(root, FrameLayout.LayoutParams(sizeW(), sizeH()))
        reposition()
        // A brand-new graph opens ready to type.
        if (rows.size == 1 && rows[0].text.isBlank()) root.post { views.firstOrNull()?.field?.edit() }
    }

    private fun sizeW() = (boxW * K).toInt()
    private fun sizeH() = (boxH * K).toInt() + headerH

    /** Follow the card on screen (call whenever the page pans or zooms, or the card moves). */
    fun reposition() {
        val r = cb.screenRect() ?: run { close(); return }
        val s = cb.pageScale() / K
        root.pivotX = 0f; root.pivotY = 0f
        root.scaleX = s; root.scaleY = s
        root.translationX = r.left
        root.translationY = r.top - headerH * s
        val lp = root.layoutParams as? FrameLayout.LayoutParams ?: return
        val w = (r.width() / cb.pageScale() * K).toInt(); val h = (r.height() / cb.pageScale() * K).toInt() + headerH
        if (lp.width != w || lp.height != h) { boxW = r.width() / cb.pageScale(); boxH = r.height() / cb.pageScale(); lp.width = w; lp.height = h; root.layoutParams = lp; layoutBody() }
    }

    fun close() {
        if (!isOpen) return
        palette?.dismiss()
        commitNow()
        (act.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(root.windowToken, 0)
        graph.dispose(); graph3.dispose()
        host.removeView(root)
        cb.closed()
    }

    /** Save now (also runs on close and before the page saves). */
    fun commitNow() {
        handler.removeCallbacks(commitTask)
        if (!::graph.isInitialized) return
        cb.commit(currentCard())
    }

    private fun scheduleCommit() { handler.removeCallbacks(commitTask); handler.postDelayed(commitTask, 500) }

    private fun currentCard() = GraphCard(
        dim3, GraphCard.copyRows(rows), degrees,
        graph.cx, graph.cy, if (graph.ppu > 0) graph.unitsAcross() else 20.0, graph3.yaw, graph3.pitch, graph3.range, true,
    )

    // ================================================================= build
    private fun build() {
        root.removeAllViews()
        root.isClickable = true   // touches on the window never reach the page underneath
        root.clipChildren = false

        val col = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        header = buildHeader()
        col.addView(header, LinearLayout.LayoutParams(MATCH_PARENT, headerH))

        body = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL
            background = GradientDrawable().apply { setColor(bg); setStroke(dp(1), alpha(AppTheme.accent, 0xC0)) }
            clipToOutline = true
        }
        leftPanel = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(blend(bg, ink, 0.03f)) }
        list = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        leftPanel.addView(ScrollView(act).apply { isFillViewport = true; addView(list) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        leftPanel.addView(TextView(act).apply {
            text = "+  Add expression"; textSize = 13f; setTextColor(AppTheme.accent); setTypeface(null, Typeface.BOLD)
            setPadding(dp(12), dp(8), dp(12), dp(10))
            setOnClickListener { addRow(rows.size, "", focus = true) }
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        body.addView(leftPanel, LinearLayout.LayoutParams(0, MATCH_PARENT))
        body.addView(View(act).apply { setBackgroundColor(alpha(ink, 0x22)) }, LinearLayout.LayoutParams(dp(1), MATCH_PARENT))
        graph = GraphView(act).apply { bgOverride = bg; inkOverride = ink }
        graph3 = Graph3DView(act).apply { bgOverride = bg; inkOverride = ink }
        val plots = FrameLayout(act).apply {
            addView(graph, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(graph3, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(buildGrip(), FrameLayout.LayoutParams(dp(26), dp(26), Gravity.BOTTOM or Gravity.END))
        }
        body.addView(plots, LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
        col.addView(body, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        root.addView(col, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        graph.onViewChanged = { scheduleCommit() }
        graph3.onViewChanged = { scheduleCommit() }
        layoutBody()
    }

    /** The expression list takes the same share of the width as on the drawn card. */
    private fun layoutBody() {
        if (!::leftPanel.isInitialized) return
        val lw = (GraphCardRenderer.legendWidth(boxW) * K).toInt()
        leftPanel.layoutParams = (leftPanel.layoutParams as LinearLayout.LayoutParams).apply { width = lw }
    }

    private fun blend(a: Int, b: Int, t: Float) = Color.rgb(
        (Color.red(a) + (Color.red(b) - Color.red(a)) * t).toInt(), (Color.green(a) + (Color.green(b) - Color.green(a)) * t).toInt(), (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t).toInt())

    private fun chip(label: String, filled: Boolean = false, onClick: (TextView) -> Unit) = TextView(act).apply {
        text = label; textSize = 12.5f; setTypeface(null, Typeface.BOLD); gravity = Gravity.CENTER
        setTextColor(if (filled) AppTheme.onAccent() else AppTheme.text)
        background = GradientDrawable().apply { cornerRadius = dpf(14f); setColor(if (filled) AppTheme.accent else AppTheme.elevated) }
        setPadding(dp(10), dp(4), dp(10), dp(4))
        layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, dp(28)).apply { leftMargin = dp(5) }
        setOnClickListener { onClick(this) }
    }

    private fun iconChip(path: String, filled: Boolean = false, onClick: (View) -> Unit) = ImageButton(act).apply {
        setImageBitmap(Icons.bitmap(path, dp(17))); setColorFilter(if (filled) AppTheme.onAccent() else AppTheme.text)
        background = GradientDrawable().apply { cornerRadius = dpf(14f); setColor(if (filled) AppTheme.accent else AppTheme.elevated) }
        scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
        val p = dp(5); setPadding(p, p, p, p)
        layoutParams = LinearLayout.LayoutParams(dp(34), dp(28)).apply { leftMargin = dp(5) }
        setOnClickListener { onClick(this) }
    }

    private fun buildHeader(): LinearLayout {
        val h = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(4), dp(6), dp(6))
        }
        val bar = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { cornerRadius = dpf(16f); setColor(AppTheme.surface); setStroke(dp(1), alpha(AppTheme.text, 0x30)) }
            elevation = dpf(6f)
            setPadding(dp(8), dp(2), dp(4), dp(2))
        }
        bar.addView(ImageView(act).apply {
            setImageBitmap(Icons.bitmap(Icons.GRAPH, dp(16))); setColorFilter(AppTheme.accent)
            layoutParams = LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(2) }
        })
        bar.addView(chip("ƒ(x)") { showPalette(it) })
        modeBtn = chip("2D") { switchMode() }; bar.addView(modeBtn)
        angleBtn = chip(if (degrees) "DEG" else "RAD") { toggleAngle() }; bar.addView(angleBtn)
        bar.addView(iconChip(Icons.HOME) { if (dim3) graph3.home() else graph.home(); scheduleCommit() })
        bar.addView(chip("Add to page") { insertInk() })
        bar.addView(iconChip(Icons.CHECK, filled = true) { close() })
        h.addView(bar, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        h.addView(View(act), LinearLayout.LayoutParams(0, 1, 1f))

        // Drag the toolbar to move the graph on the page.
        var rx = 0f; var ry = 0f; var moved = false
        val drag = View.OnTouchListener { _, e ->
            val s = cb.pageScale()
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { rx = e.rawX; ry = e.rawY; moved = false }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - rx; val dy = e.rawY - ry
                    if (moved || kotlin.math.hypot(dx, dy) > dp(4)) {
                        moved = true
                        cb.moveBy(dx / s, dy / s, false); rx = e.rawX; ry = e.rawY
                        reposition()
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (moved) cb.moveBy(0f, 0f, true)
            }
            true
        }
        h.setOnTouchListener(drag)
        bar.setOnTouchListener(drag)
        return h
    }

    /** Bottom-right grip: drag to resize the graph on the page. */
    private fun buildGrip(): View {
        val v = object : View(act) {
            val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeWidth = dpf(1.6f); strokeCap = Paint.Cap.ROUND; color = alpha(ink, 0x80) }
            override fun onDraw(c: Canvas) {
                val r = width - dpf(5f); val b = height - dpf(5f)
                for (k in 1..3) { val o = dpf(5f) * k; c.drawLine(r - o, b, r, b - o, p) }
            }
        }
        var rx = 0f; var ry = 0f; var w0 = 0f; var h0 = 0f
        v.setOnTouchListener { _, e ->
            val s = cb.pageScale()
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { rx = e.rawX; ry = e.rawY; w0 = boxW; h0 = boxH; v.parent?.requestDisallowInterceptTouchEvent(true) }
                MotionEvent.ACTION_MOVE -> { cb.resizeTo((w0 + (e.rawX - rx) / s).coerceAtLeast(260f), (h0 + (e.rawY - ry) / s).coerceAtLeast(160f), false); reposition() }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { cb.resizeTo(boxW, boxH, true); scheduleCommit() }
            }
            true
        }
        return v
    }

    private fun applyMode() {
        graph.visibility = if (dim3) View.GONE else View.VISIBLE
        graph3.visibility = if (dim3) View.VISIBLE else View.GONE
        modeBtn.text = if (dim3) "3D" else "2D"
        modeBtn.setTextColor(if (dim3) AppTheme.onAccent() else AppTheme.text)
        (modeBtn.background as? GradientDrawable)?.setColor(if (dim3) AppTheme.accent else AppTheme.elevated)
        angleBtn.text = if (degrees) "DEG" else "RAD"
    }

    private fun switchMode() {
        palette?.dismiss()
        dim3 = !dim3
        applyMode()
        rebuild(); scheduleCommit()
    }

    // ================================================================= rows
    private fun reloadRows() {
        lastField = null
        list.removeAllViews(); views.clear()
        if (rows.isEmpty()) rows.add(GraphRow("", nextColor()))
        val m = GraphModel.build(rows, degrees, dim3)
        for ((i, r) in rows.withIndex()) list.addView(RowView(r, m.parsed.getOrNull(i)).also { views.add(it) }.box)
        rebuild()
    }

    private inner class RowView(val row: GraphRow, parsed: MathEngine.Statement?) {
        val box = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(6), dp(4), dp(4), dp(4)) }
        val dot = View(act)
        val field = MathField(act)
        val info = TextView(act)
        val slider = LinearLayout(act)
        val seek = SeekBar(act)
        val sMin = smallEdit(); val sMax = smallEdit()
        val range = LinearLayout(act)
        val tMin = smallEdit(); val tMax = smallEdit()
        val rangeLabel = TextView(act)
        val uv = LinearLayout(act)
        val uMin = smallEdit(); val uMax = smallEdit(); val vMin = smallEdit(); val vMax = smallEdit()
        var status: RowStatus? = null

        init {
            val top = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            paintDot()
            dot.setOnClickListener { row.hidden = !row.hidden; paintDot(); rebuild(); scheduleCommit() }
            dot.setOnLongClickListener { showColors(dot) { c -> row.color = c; paintDot(); rebuild(); scheduleCommit() }; true }
            top.addView(dot, LinearLayout.LayoutParams(dp(16), dp(16)).apply { rightMargin = dp(6); leftMargin = dp(2) })

            field.size = dpf(15f); field.color = ink
            field.hint = if (rows.indexOf(row) > 0) "" else if (dim3) "z = x² − y²" else "y = x²"
            field.setText(row.text, parsed)
            field.onChange = { t -> if (!suppress) { row.text = t; scheduleRebuild(); scheduleCommit() } }
            field.onEnter = { addRow(rows.indexOf(row) + 1, "", focus = true) }
            field.onFocus = { has -> if (has) { lastField = field; graph.focusRow = rows.indexOf(row) } }
            val scroll = HorizontalScrollView(act).apply {
                isHorizontalScrollBarEnabled = false; isFillViewport = true
                background = GradientDrawable().apply { cornerRadius = dpf(7f); setColor(blend(bg, ink, 0.06f)) }
                addView(field, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
            }
            top.addView(scroll, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            top.addView(ImageButton(act).apply {
                setImageBitmap(Icons.bitmap(Icons.CLOSE, dp(14))); setColorFilter(alpha(ink, 0x99))
                background = null; scaleType = ImageView.ScaleType.FIT_CENTER
                val p = dp(5); setPadding(p, p, p, p)
                setOnClickListener { removeRow(this@RowView) }
            }, LinearLayout.LayoutParams(dp(26), dp(26)).apply { leftMargin = dp(2) })
            box.addView(top)

            info.apply { textSize = 11.5f; setPadding(dp(24), dp(2), dp(4), 0); visibility = View.GONE }
            box.addView(info)

            slider.apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(18), dp(2), 0, 0); visibility = View.GONE }
            sMin.setText(MathEngine.fmt(row.sMin, 6).replace("−", "-")); sMax.setText(MathEngine.fmt(row.sMax, 6).replace("−", "-"))
            seek.max = 1000
            seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) { if (fromUser) slide(p) }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) { scheduleCommit() }
            })
            sMin.addTextChangedListener(watch { if (!suppress) { num(sMin.text.toString())?.let { row.sMin = it }; num(sMax.text.toString())?.let { row.sMax = it }; syncSeek(); scheduleCommit() } })
            sMax.addTextChangedListener(watch { if (!suppress) { num(sMin.text.toString())?.let { row.sMin = it }; num(sMax.text.toString())?.let { row.sMax = it }; syncSeek(); scheduleCommit() } })
            slider.addView(sMin, LinearLayout.LayoutParams(dp(48), WRAP_CONTENT))
            slider.addView(seek, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            slider.addView(sMax, LinearLayout.LayoutParams(dp(48), WRAP_CONTENT))
            box.addView(slider)

            range.apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(24), dp(3), 0, 0); visibility = View.GONE }
            tMin.setText(row.tMin); tMax.setText(row.tMax)
            val rw = watch { if (!suppress) { row.tMin = tMin.text.toString(); row.tMax = tMax.text.toString(); scheduleRebuild(); scheduleCommit() } }
            tMin.addTextChangedListener(rw); tMax.addTextChangedListener(rw)
            rangeLabel.apply { textSize = 12f; setTextColor(alpha(ink, 0xB0)); setPadding(dp(6), 0, dp(6), 0) }
            range.addView(tMin, LinearLayout.LayoutParams(dp(56), WRAP_CONTENT)); range.addView(rangeLabel); range.addView(tMax, LinearLayout.LayoutParams(dp(56), WRAP_CONTENT))
            box.addView(range)

            uv.apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(3), 0, 0); visibility = View.GONE }
            uMin.setText(row.uMin); uMax.setText(row.uMax); vMin.setText(row.vMin); vMax.setText(row.vMax)
            val uw = watch { if (!suppress) { row.uMin = uMin.text.toString(); row.uMax = uMax.text.toString(); row.vMin = vMin.text.toString(); row.vMax = vMax.text.toString(); scheduleRebuild(); scheduleCommit() } }
            for ((lo, hi, name) in listOf(Triple(uMin, uMax, "u"), Triple(vMin, vMax, "v"))) {
                lo.addTextChangedListener(uw); hi.addTextChangedListener(uw)
                uv.addView(LinearLayout(act).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(2), 0, dp(2))
                    addView(lo, LinearLayout.LayoutParams(dp(56), WRAP_CONTENT))
                    addView(TextView(act).apply { text = "≤ $name ≤"; textSize = 12f; setTextColor(alpha(ink, 0xB0)); setPadding(dp(6), 0, dp(6), 0) })
                    addView(hi, LinearLayout.LayoutParams(dp(56), WRAP_CONTENT))
                })
            }
            box.addView(uv)
            box.addView(View(act).apply { setBackgroundColor(alpha(ink, 0x12)) }, LinearLayout.LayoutParams(MATCH_PARENT, dp(1)).apply { topMargin = dp(4) })
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
            field.setText(txt)
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
            info.setTextColor(if (s.error) Color.rgb(0xD3, 0x2F, 0x2F) else alpha(ink, 0xB8))
            info.visibility = if (msg.isEmpty() || (s.error && row.text.isBlank())) View.GONE else View.VISIBLE
            info.setOnClickListener(if (s.missing != null) View.OnClickListener { addRow(rows.indexOf(row), "${s.missing} = 1", focus = false) } else null)
            slider.visibility = if (s.kind == RowKind.SLIDER) View.VISIBLE else View.GONE
            if (s.kind == RowKind.SLIDER) {
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
            uv.visibility = if (s.uvRange) View.VISIBLE else View.GONE
        }
    }

    private fun watch(f: () -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun afterTextChanged(s: Editable?) { f() }
    }

    private fun smallEdit() = EditText(act).apply {
        textSize = 12f; setTextColor(ink); gravity = Gravity.CENTER
        isSingleLine = true
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
        background = GradientDrawable().apply { cornerRadius = dpf(6f); setColor(blend(bg, ink, 0.07f)) }
        setPadding(dp(3), dp(3), dp(3), dp(3))
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
        val rv = RowView(r, null)
        views.add(i, rv)
        list.addView(rv.box, i)
        if (focus) rv.field.post { rv.field.edit() }
        rebuild(); scheduleCommit()
    }

    private fun removeRow(rv: RowView) {
        if (rows.size <= 1) { rv.field.clear(); return }
        val i = views.indexOf(rv)
        if (i < 0) return
        rows.removeAt(i); views.removeAt(i); list.removeView(rv.box)
        if (lastField === rv.field) lastField = null
        graph.focusRow = -1
        rebuild(); scheduleCommit()
    }

    private fun scheduleRebuild() { handler.removeCallbacks(rebuildTask); handler.postDelayed(rebuildTask, 160) }

    private fun rebuild() {
        handler.removeCallbacks(rebuildTask)
        val m = GraphModel.build(rows, degrees, dim3)
        for (i in views.indices) views[i].apply(m.statuses.getOrElse(i) { RowStatus(RowKind.EMPTY) })
        if (dim3) graph3.setModel(m)
        else {
            graph.focusRow = lastField?.let { f -> views.indexOfFirst { it.field === f } } ?: -1
            graph.setModel(m)
        }
    }

    private fun toggleAngle() {
        degrees = !degrees
        angleBtn.text = if (degrees) "DEG" else "RAD"
        suppress = true
        for (rv in views) {
            if (degrees && rv.row.tMax.replace(" ", "") == "2pi") { rv.row.tMax = "360"; rv.tMax.setText("360") }
            else if (!degrees && rv.row.tMax.trim() == "360") { rv.row.tMax = "2pi"; rv.tMax.setText("2pi") }
        }
        suppress = false
        rebuild(); scheduleCommit()
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
                "√" to "sqrt(§)", "∛" to "cbrt(§)", "ⁿ√" to "root(§, 3)", "|x|" to "abs(§)", "( )" to "(§)", "a/b" to "/",
                "×" to "*", "n!" to "!", "=" to "=", "<" to "<", ">" to ">", "≤" to "≤", "≥" to "≥", "∞" to "inf",
                "{ : }" to "{§: , }", "(x, y)" to "(§, )", "mod" to "mod(§, )", "d/dx" to "d/dx(§)",
            ),
            "Calculus" to listOf(
                "∫ₐᵇ" to "int(§, x, 0, 1)", "∬" to "int2(§, y, 0, 1, x, 0, 1)", "∭" to "int3(§, z, 0, 1, y, 0, 1, x, 0, 1)",
                "∫₀ˣ" to "int(§, t, 0, x)", "∫ −∞..∞" to "int(§, x, -inf, inf)",
                "d/dx" to "d/dx(§)", "f'(x)" to "f'(x)", "f''(x)" to "f''(x)", "deriv" to "deriv(§, x)", "f' at a" to "deriv(§, x, 1)",
                "Σ" to "sum(§, n, 1, 10)", "Σ ∞" to "sum(§, n, 1, inf)", "Π" to "prod(§, n, 1, 10)", "lim" to "lim(§, x, 0)",
                "lim ∞" to "lim(§, x, inf)",
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
            "3D" to listOf(
                "z =" to "z = §", "x" to "x", "y" to "y", "z" to "z", "u" to "u", "v" to "v", "t" to "t", "r" to "r",
                "(x, y, z)" to "(§, , )", "curve" to "(cos(t), sin(t), §t/4)", "surface" to "(§cos(u)sin(v), sin(u)sin(v), cos(v))",
                "sphere" to "x^2 + y^2 + z^2 = §9", "cone" to "z = §sqrt(x^2 + y^2)", "paraboloid" to "z = §x^2 + y^2",
                "saddle" to "z = §x^2 − y^2", "cylinder" to "x^2 + y^2 = §4",
                "∬" to "int2(§, y, 0, 1, x, 0, 1)", "∭" to "int3(§, z, 0, 1, y, 0, 1, x, 0, 1)",
                "∭ ball" to "int3(§1, z, −sqrt(4 − x^2 − y^2), sqrt(4 − x^2 − y^2), y, −sqrt(4 − x^2), sqrt(4 − x^2), x, −2, 2)",
                "∭ tetra" to "int3(§1, z, 0, 1 − x − y, y, 0, 1 − x, x, 0, 1)",
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
        pop.showAsDropDown(anchor, 0, dp(6))
    }

    private fun insertText(tpl: String) {
        val f = lastField ?: views.lastOrNull()?.field ?: return
        if (!f.isFocused) f.edit()
        f.insertTemplate(tpl)
    }

    // ================================================================= add to page (ink)
    private fun insertInk() {
        val r = if (dim3) graph3.exportInk() else graph.exportInk()
        if (r == null || r.first.size <= 1) { Toast.makeText(act, "Nothing to add yet — type an expression first.", Toast.LENGTH_SHORT).show(); return }
        cb.insertInk(r.first, r.second, r.third)
    }
}
