package com.engorg.inkpad

import android.graphics.Color
import android.graphics.Matrix
import android.graphics.PointF
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.ViewTreeObserver
import android.widget.Button
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.PopupWindow
import androidx.activity.ComponentActivity
import androidx.input.motionprediction.MotionEventPredictor
import androidx.ink.authoring.InProgressStrokeId
import androidx.ink.authoring.InProgressStrokesFinishedListener
import androidx.ink.authoring.InProgressStrokesView
import androidx.ink.brush.Brush
import androidx.ink.brush.InputToolType
import androidx.ink.brush.StockBrushes
import androidx.ink.strokes.MutableStrokeInputBatch
import androidx.ink.strokes.Stroke
import androidx.ink.strokes.StrokeInput
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.hypot

/** Native handwriting surface: fixed 8.5x11 page, zoom/pan, pen/highlighter/eraser, auto-save. */
class InkActivity : ComponentActivity() {

    private lateinit var inProgressView: InProgressStrokesView
    private lateinit var finishedView: FinishedStrokesView
    private lateinit var eraserOverlay: EraserOverlay
    private lateinit var predictor: MotionEventPredictor
    private lateinit var scaleDetector: ScaleGestureDetector
    private lateinit var colorButton: Button
    private val toolButtons = HashMap<Tool, Button>()
    private var shapeButton: Button? = null

    private enum class Mode { NONE, DRAW, ERASE, PAN }
    private enum class Tool { PEN, HIGHLIGHTER, ERASER }

    private var mode = Mode.NONE
    private var tool = Tool.PEN
    private var activePointerId = -1
    private var strokeId: InProgressStrokeId? = null
    private var currentStrokeHighlighter = false
    private var dirtyErase = false
    private var geometrizeOn = false

    private var brushColor = Color.rgb(0x16, 0x1A, 0x22)
    private var brushSize = 6f
    private val eraserRadius = 22f // world units

    // view transform: screen = world*scale + (tx,ty)
    private var scale = 1f
    private var tx = 0f
    private var ty = 0f
    private var lastPanX = 0f
    private var lastPanY = 0f
    private var lastFocusX = 0f
    private var lastFocusY = 0f

    // hold-to-geometrize (opt-in)
    private val currentPoints = ArrayList<PointF>()
    private val holdHandler = Handler(Looper.getMainLooper())
    private var holdRunnable: Runnable? = null
    private val holdPoint = PointF()
    private var geometrized = false

    private lateinit var store: NotebookStore
    private lateinit var notebook: NotebookStore.Notebook
    private var currentPageId: String = ""
    private var pageLabel: Button? = null

    private val accent get() = AppTheme.accent
    private val light get() = AppTheme.elevated
    private val onSurface get() = AppTheme.text

    private val palette = intArrayOf(
        Color.rgb(0x16, 0x1A, 0x22), Color.rgb(0x45, 0x4B, 0x55), Color.rgb(0x8A, 0x92, 0x9E), Color.rgb(0xEC, 0xEC, 0xEC), Color.WHITE,
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0xAC, 0xC1), Color.rgb(0x00, 0x89, 0x7B), Color.rgb(0x2E, 0x7D, 0x32),
        Color.rgb(0x7C, 0xB3, 0x42), Color.rgb(0xF9, 0xA8, 0x25), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0x6D, 0x4C, 0x41), Color.rgb(0xB7, 0x1C, 0x1C),
        Color.rgb(0xDC, 0x26, 0x50), Color.rgb(0xE9, 0x1E, 0x63), Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0xFF, 0xEB, 0x3B),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppTheme.load(this)

        finishedView = FinishedStrokesView(this)
        finishedView.backdrop = AppTheme.bg
        inProgressView = InProgressStrokesView(this)
        eraserOverlay = EraserOverlay(this)

        inProgressView.addFinishedStrokesListener(object : InProgressStrokesFinishedListener {
            override fun onStrokesFinished(strokes: Map<InProgressStrokeId, Stroke>) {
                for ((_, stroke) in strokes) {
                    finishedView.addStroke(stroke, worldPointsOf(stroke), currentStrokeHighlighter)
                }
                inProgressView.removeFinishedStrokes(strokes.keys)
                save()
            }
        })

        scaleDetector = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: ScaleGestureDetector): Boolean { lastFocusX = d.focusX; lastFocusY = d.focusY; return true }
            override fun onScale(d: ScaleGestureDetector): Boolean {
                tx += d.focusX - lastFocusX; ty += d.focusY - lastFocusY
                lastFocusX = d.focusX; lastFocusY = d.focusY
                val ns = (scale * d.scaleFactor).coerceIn(0.15f, 8f)
                tx = d.focusX - (d.focusX - tx) * (ns / scale)
                ty = d.focusY - (d.focusY - ty) * (ns / scale)
                scale = ns
                applyTransform()
                return true
            }
        })

        val touch = object : View(this) {
            override fun onTouchEvent(event: MotionEvent): Boolean = handleTouch(event, this)
        }
        predictor = MotionEventPredictor.newInstance(touch)

        val root = FrameLayout(this).apply {
            setBackgroundColor(AppTheme.bg)
            addView(finishedView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(inProgressView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(eraserOverlay, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(touch, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(buildToolbar(), FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                gravity = Gravity.TOP; topMargin = dp(12); leftMargin = dp(12); rightMargin = dp(12)
            })
        }
        setContentView(root)

        store = NotebookStore(filesDir)
        val nbId = intent.getStringExtra(EXTRA_NOTEBOOK_ID)
        notebook = (nbId?.let { store.notebook(it) })
            ?: store.notebooks.firstOrNull()
            ?: store.createNotebook("Quick notes", null, accent)
        currentPageId = notebook.pageIds.firstOrNull() ?: store.addPage(notebook)
        load()
        updatePageLabel()
        updateTools()

        finishedView.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                if (finishedView.width > 0) {
                    finishedView.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    fitPage()
                }
            }
        })
    }

    // ---- transform ----
    private fun applyTransform() { finishedView.setTransform(scale, tx, ty) }
    private fun buildW2S() = Matrix().apply { setScale(scale, scale); postTranslate(tx, ty) }
    private fun screenToWorld(sx: Float, sy: Float) = PointF((sx - tx) / scale, (sy - ty) / scale)

    private fun fitPage() {
        val vw = finishedView.width.toFloat(); val vh = finishedView.height.toFloat()
        if (vw <= 0f) return
        scale = minOf(vw / FinishedStrokesView.PAGE_W, vh / FinishedStrokesView.PAGE_H) * 0.94f
        tx = (vw - FinishedStrokesView.PAGE_W * scale) / 2f
        ty = maxOf(dp(4).toFloat(), (vh - FinishedStrokesView.PAGE_H * scale) / 2f)
        applyTransform()
    }

    private fun zoomBy(factor: Float) {
        val fx = finishedView.width / 2f; val fy = finishedView.height / 2f
        val ns = (scale * factor).coerceIn(0.15f, 8f)
        tx = fx - (fx - tx) * (ns / scale)
        ty = fy - (fy - ty) * (ns / scale)
        scale = ns
        applyTransform()
    }

    private fun brush(): Brush {
        val r = Color.red(brushColor); val g = Color.green(brushColor); val b = Color.blue(brushColor)
        return if (tool == Tool.HIGHLIGHTER) {
            Brush.createWithColorIntArgb(StockBrushes.highlighter(), Color.argb(0x66, r, g, b), brushSize * 3.2f, 0.1f)
        } else {
            Brush.createWithColorIntArgb(StockBrushes.pressurePen(), Color.argb(0xFF, r, g, b), brushSize, 0.1f)
        }
    }

    private fun classify(event: MotionEvent, idx: Int): Mode {
        val type = event.getToolType(idx)
        val eraserBtn = (event.buttonState and
            (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_STYLUS_SECONDARY)) != 0
        return when {
            type == MotionEvent.TOOL_TYPE_FINGER -> Mode.PAN
            type == MotionEvent.TOOL_TYPE_ERASER -> Mode.ERASE
            eraserBtn -> Mode.ERASE
            tool == Tool.ERASER -> Mode.ERASE
            else -> Mode.DRAW
        }
    }

    private fun eraseAt(sx: Float, sy: Float) {
        eraserOverlay.show(sx, sy, eraserRadius * scale)
        val w = screenToWorld(sx, sy)
        if (finishedView.eraseNear(w.x, w.y, eraserRadius)) dirtyErase = true
    }

    private fun worldPointsOf(stroke: Stroke): List<PointF> {
        val batch = stroke.inputs
        val out = ArrayList<PointF>(batch.size)
        val si = StrokeInput()
        for (i in 0 until batch.size) { batch.populate(i, si); out.add(PointF(si.x, si.y)) }
        return out
    }

    private fun handleTouch(event: MotionEvent, host: View): Boolean {
        predictor.record(event)
        // fingers drive pinch/pan; a stylus never pinches
        val primaryType = event.getToolType(0)
        if (primaryType == MotionEvent.TOOL_TYPE_FINGER) scaleDetector.onTouchEvent(event)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val idx = event.actionIndex
                activePointerId = event.getPointerId(idx)
                mode = classify(event, idx)
                when (mode) {
                    Mode.DRAW -> {
                        host.requestUnbufferedDispatch(event)
                        currentStrokeHighlighter = tool == Tool.HIGHLIGHTER
                        geometrized = false
                        currentPoints.clear()
                        currentPoints.add(PointF(event.getX(idx), event.getY(idx)))
                        holdPoint.set(event.getX(idx), event.getY(idx))
                        val s2w = Matrix(); buildW2S().invert(s2w)
                        strokeId = inProgressView.startStroke(event, activePointerId, brush(), s2w, Matrix())
                        if (geometrizeOn) scheduleHold()
                    }
                    Mode.PAN -> { lastPanX = event.getX(idx); lastPanY = event.getY(idx) }
                    Mode.ERASE -> eraseAt(event.getX(idx), event.getY(idx))
                    else -> {}
                }
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                if (scaleDetector.isInProgress) return true
                val idx = event.findPointerIndex(activePointerId)
                if (idx < 0) return true
                when (mode) {
                    Mode.DRAW -> {
                        if (geometrized) return true
                        val sid = strokeId ?: return true
                        val predicted = predictor.predict()
                        try { inProgressView.addToStroke(event, activePointerId, sid, predicted) }
                        finally { predicted?.recycle() }
                        val x = event.getX(idx); val y = event.getY(idx)
                        currentPoints.add(PointF(x, y))
                        if (geometrizeOn && hypot(x - holdPoint.x, y - holdPoint.y) > 6f) { holdPoint.set(x, y); scheduleHold() }
                    }
                    Mode.PAN -> {
                        val x = event.getX(idx); val y = event.getY(idx)
                        tx += x - lastPanX; ty += y - lastPanY
                        lastPanX = x; lastPanY = y
                        applyTransform()
                    }
                    Mode.ERASE -> eraseAt(event.getX(idx), event.getY(idx))
                    else -> {}
                }
                return true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (mode == Mode.DRAW) {
                    cancelHold()
                    val sid = strokeId
                    if (sid != null && !geometrized) {
                        if (event.actionMasked == MotionEvent.ACTION_CANCEL) inProgressView.cancelStroke(sid, event)
                        else inProgressView.finishStroke(event, activePointerId, sid)
                    }
                }
                if (mode == Mode.ERASE && dirtyErase) { dirtyErase = false; save() }
                eraserOverlay.hide()
                strokeId = null; mode = Mode.NONE; activePointerId = -1
                return true
            }
        }
        return false
    }

    // ---- hold-to-geometrize (opt-in) ----
    private fun scheduleHold() {
        cancelHold()
        val r = Runnable { tryGeometrize() }
        holdRunnable = r
        holdHandler.postDelayed(r, 550)
    }
    private fun cancelHold() { holdRunnable?.let { holdHandler.removeCallbacks(it) }; holdRunnable = null }

    private fun tryGeometrize() {
        if (mode != Mode.DRAW || geometrized) return
        val sid = strokeId ?: return
        val worldPts = currentPoints.map { screenToWorld(it.x, it.y) }
        val shape = ShapeRecognizer.recognize(worldPts) ?: return
        val stroke = buildStrokeFromPoints(shape, brush()) ?: return
        inProgressView.cancelStroke(sid, null)
        finishedView.addStroke(stroke, shape, currentStrokeHighlighter)
        geometrized = true
        save()
    }

    private fun buildStrokeFromPoints(pts: List<PointF>, br: Brush): Stroke? {
        val batch = MutableStrokeInputBatch()
        var t = 0L
        for (p in pts) {
            try { batch.add(InputToolType.STYLUS, p.x, p.y, t, pressure = 0.5f); t += 6 } catch (_: Exception) { }
        }
        return if (batch.size >= 2) runCatching { Stroke(br, batch) }.getOrNull() else null
    }

    // ---- persistence (per notebook page) ----
    private fun pageFile() = store.pageFile(currentPageId)
    private fun currentIndex() = notebook.pageIds.indexOf(currentPageId).coerceAtLeast(0)
    private fun updatePageLabel() { pageLabel?.text = "${currentIndex() + 1}/${notebook.pageIds.size}" }

    private fun switchPage(delta: Int) {
        val target = currentIndex() + delta
        if (target < 0 || target >= notebook.pageIds.size) return
        save()
        currentPageId = notebook.pageIds[target]
        finishedView.clearAll()
        load()
        fitPage()
        updatePageLabel()
    }

    private fun addPage() {
        save()
        currentPageId = store.addPage(notebook)
        finishedView.clearAll()
        load()
        fitPage()
        updatePageLabel()
    }

    private fun save() {
        try {
            val arr = JSONArray()
            for (rec in finishedView.snapshot()) {
                val br = rec.stroke.brush
                val o = JSONObject().put("c", br.colorIntArgb).put("s", br.size.toDouble()).put("h", rec.highlighter)
                val ia = JSONArray()
                val batch = rec.stroke.inputs
                val si = StrokeInput()
                for (i in 0 until batch.size) {
                    batch.populate(i, si)
                    val pr = if (si.pressure.isFinite() && si.pressure in 0f..1f) si.pressure.toDouble() else -1.0
                    ia.put(JSONArray().put(si.x.toDouble()).put(si.y.toDouble()).put(si.elapsedTimeMillis).put(pr))
                }
                o.put("i", ia); arr.put(o)
            }
            val doc = JSONObject().put("paper", finishedView.paperStyle.name).put("page", finishedView.pageColor).put("strokes", arr)
            pageFile().writeText(doc.toString())
        } catch (e: Exception) { Log.e("Ink", "save failed", e) }
    }

    private fun load() {
        try {
            val f = pageFile()
            if (!f.exists()) return
            val doc = JSONObject(f.readText())
            finishedView.paperStyle = runCatching { FinishedStrokesView.PaperStyle.valueOf(doc.optString("paper", "GRID")) }
                .getOrDefault(FinishedStrokesView.PaperStyle.GRID)
            finishedView.pageColor = doc.optInt("page", finishedView.pageColor)
            val arr = doc.optJSONArray("strokes") ?: return
            val recs = ArrayList<FinishedStrokesView.Rec>(arr.length())
            for (k in 0 until arr.length()) {
                val o = arr.getJSONObject(k)
                val color = o.getInt("c"); val size = o.getDouble("s").toFloat(); val hl = o.optBoolean("h", false)
                val fam = if (hl) StockBrushes.highlighter() else StockBrushes.pressurePen()
                val brush = Brush.createWithColorIntArgb(fam, color, size, 0.1f)
                val ia = o.getJSONArray("i")
                val batch = MutableStrokeInputBatch()
                val pts = ArrayList<PointF>(ia.length())
                for (j in 0 until ia.length()) {
                    val p = ia.getJSONArray(j)
                    val x = p.getDouble(0).toFloat(); val y = p.getDouble(1).toFloat(); val t = p.getLong(2)
                    val prRaw = p.getDouble(3)
                    val pr = if (prRaw < 0) StrokeInput.NO_PRESSURE else prRaw.toFloat()
                    try { batch.add(InputToolType.STYLUS, x, y, t, pressure = pr); pts.add(PointF(x, y)) } catch (_: Exception) { }
                }
                if (batch.size >= 1) runCatching { recs.add(FinishedStrokesView.Rec(Stroke(brush, batch), pts, hl)) }
            }
            finishedView.setAll(recs)
        } catch (e: Exception) { Log.e("Ink", "load failed", e) }
    }

    // ---- styled toolbar ----
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun pillBg(color: Int) = GradientDrawable().apply { cornerRadius = dp(20).toFloat(); setColor(color) }

    private fun pill(label: String, onClick: (Button) -> Unit): Button = Button(this).apply {
        text = label; isAllCaps = false; textSize = 13f
        setTextColor(onSurface)
        background = pillBg(light)
        stateListAnimator = null
        minWidth = 0; minimumWidth = 0
        setPadding(dp(14), dp(4), dp(14), dp(4))
        setOnClickListener { onClick(this) }
    }

    private fun updateTools() {
        for ((t, btn) in toolButtons) {
            val active = t == tool
            btn.background = pillBg(if (active) accent else light)
            btn.setTextColor(if (active) AppTheme.onAccent() else onSurface)
        }
        shapeButton?.let {
            it.background = pillBg(if (geometrizeOn) accent else light)
            it.setTextColor(if (geometrizeOn) AppTheme.onAccent() else onSurface)
        }
    }

    private fun buildToolbar(): View {
        fun sep() = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(1), dp(26)).apply { setMargins(dp(6), 0, dp(6), 0) }
            setBackgroundColor(Color.argb(0x22, 0, 0, 0))
        }
        fun toolPill(label: String, t: Tool) = pill(label) { tool = t; updateTools() }.also { toolButtons[t] = it }

        colorButton = pill("  ") { showColorPicker(it) { c -> brushColor = c; colorButton.background = pillBg(c) } }
            .apply { background = pillBg(brushColor); minWidth = dp(40) }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(26).toFloat(); setColor(AppTheme.surface) }
            elevation = dp(6).toFloat()
            setPadding(dp(10), dp(8), dp(10), dp(8))
            addView(pill("‹ App") { finish() })
            addView(sep())
            addView(toolPill("Pen", Tool.PEN))
            addView(toolPill("Marker", Tool.HIGHLIGHTER))
            addView(toolPill("Eraser", Tool.ERASER))
            shapeButton = pill("Shape") { geometrizeOn = !geometrizeOn; updateTools() }.also { addView(it) }
            addView(sep())
            addView(colorButton)
            addView(pill("–") { brushSize = (brushSize - 2f).coerceAtLeast(2f) })
            addView(pill("+") { brushSize = (brushSize + 2f).coerceAtMost(36f) })
            addView(sep())
            addView(pill("Paper") { cyclePaper(); save() })
            addView(pill("Page") { showColorPicker(it) { c -> finishedView.pageColor = c; save() } })
            addView(sep())
            addView(pill("－") { zoomBy(0.8f) })
            addView(pill("＋") { zoomBy(1.25f) })
            addView(pill("Fit") { fitPage() })
            addView(sep())
            addView(pill("‹") { switchPage(-1) })
            pageLabel = pill("1/1") { }.also { addView(it) }
            addView(pill("›") { switchPage(1) })
            addView(pill("+Pg") { addPage() })
            addView(pill("Clear") { finishedView.clearAll(); save() })
        }
        return HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(bar)
        }
    }

    private fun cyclePaper() {
        finishedView.paperStyle = when (finishedView.paperStyle) {
            FinishedStrokesView.PaperStyle.PLAIN -> FinishedStrokesView.PaperStyle.GRID
            FinishedStrokesView.PaperStyle.GRID -> FinishedStrokesView.PaperStyle.RULED
            FinishedStrokesView.PaperStyle.RULED -> FinishedStrokesView.PaperStyle.DOTS
            FinishedStrokesView.PaperStyle.DOTS -> FinishedStrokesView.PaperStyle.PLAIN
        }
    }

    private fun showColorPicker(anchor: View, onPick: (Int) -> Unit) {
        val pad = dp(10)
        val grid = GridLayout(this).apply {
            columnCount = 5
            background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(Color.WHITE) }
            setPadding(pad, pad, pad, pad)
        }
        val popup = PopupWindow(grid, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(8).toFloat() }
        val sz = dp(42); val m = dp(4)
        for (c in palette) {
            grid.addView(View(this).apply {
                background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(c) }
                layoutParams = GridLayout.LayoutParams().apply { width = sz; height = sz; setMargins(m, m, m, m) }
                setOnClickListener { onPick(c); popup.dismiss() }
            })
        }
        popup.showAsDropDown(anchor, 0, dp(6))
    }

    companion object {
        const val EXTRA_NOTEBOOK_ID = "notebookId"
    }
}
