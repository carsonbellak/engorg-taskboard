package com.engorg.inkpad

import android.graphics.Color
import android.graphics.Matrix
import android.graphics.PointF
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.FrameLayout
import android.widget.GridLayout
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

/**
 * Native low-latency handwriting surface. Pen writes; highlighter is a translucent brush;
 * finger pans; the S Pen button / eraser tool erases whole strokes (with a reach circle).
 * Paper style, page color and brush color are adjustable, and the page auto-saves locally.
 */
class InkActivity : ComponentActivity() {

    private lateinit var inProgressView: InProgressStrokesView
    private lateinit var finishedView: FinishedStrokesView
    private lateinit var eraserOverlay: EraserOverlay
    private lateinit var predictor: MotionEventPredictor
    private lateinit var colorButton: Button

    private lateinit var store: NotebookStore
    private lateinit var notebook: NotebookStore.Notebook
    private var currentPageId: String = ""
    private var pageLabel: Button? = null

    private enum class Mode { NONE, DRAW, ERASE, PAN }
    private enum class Tool { PEN, HIGHLIGHTER, ERASER }

    private var mode = Mode.NONE
    private var tool = Tool.PEN
    private var activePointerId = -1
    private var strokeId: InProgressStrokeId? = null
    private var currentStrokeHighlighter = false
    private var dirtyErase = false

    private var brushColor = Color.rgb(0x16, 0x1A, 0x22)
    private var brushSize = 6f
    private val eraserRadius = 28f

    private var panX = 0f
    private var panY = 0f
    private var lastPanX = 0f
    private var lastPanY = 0f

    private val palette = intArrayOf(
        Color.rgb(0x16, 0x1A, 0x22), Color.rgb(0x45, 0x4B, 0x55), Color.rgb(0x8A, 0x92, 0x9E), Color.rgb(0xEC, 0xEC, 0xEC), Color.WHITE,
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0xAC, 0xC1), Color.rgb(0x00, 0x89, 0x7B), Color.rgb(0x2E, 0x7D, 0x32),
        Color.rgb(0x7C, 0xB3, 0x42), Color.rgb(0xF9, 0xA8, 0x25), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0x6D, 0x4C, 0x41), Color.rgb(0xB7, 0x1C, 0x1C),
        Color.rgb(0xDC, 0x26, 0x50), Color.rgb(0xE9, 0x1E, 0x63), Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0xFF, 0xEB, 0x3B),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        finishedView = FinishedStrokesView(this)
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

        val touch = object : View(this) {
            override fun onTouchEvent(event: MotionEvent): Boolean = handleTouch(event, this)
        }
        predictor = MotionEventPredictor.newInstance(touch)

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(0xE9, 0xEA, 0xEC))
            addView(finishedView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(inProgressView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(eraserOverlay, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(touch, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(buildToolbar(), FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
                gravity = Gravity.TOP or Gravity.START; topMargin = 20; leftMargin = 20
            })
        }
        setContentView(root)

        store = NotebookStore(filesDir)
        val nbId = intent.getStringExtra(EXTRA_NOTEBOOK_ID)
        notebook = (nbId?.let { store.notebook(it) })
            ?: store.notebooks.firstOrNull()
            ?: store.createNotebook("Quick notes", null, Color.rgb(0x29, 0x47, 0xC9))
        currentPageId = notebook.pageIds.firstOrNull() ?: store.addPage(notebook)
        load()
        updatePageLabel()
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
        eraserOverlay.show(sx, sy, eraserRadius)
        if (finishedView.eraseNear(sx - panX, sy - panY, eraserRadius)) dirtyErase = true
    }

    /** The stroke's own inputs are in world coordinates — reuse them for eraser hit-testing. */
    private fun worldPointsOf(stroke: Stroke): List<PointF> {
        val batch = stroke.inputs
        val out = ArrayList<PointF>(batch.size)
        val si = StrokeInput()
        for (i in 0 until batch.size) { batch.populate(i, si); out.add(PointF(si.x, si.y)) }
        return out
    }

    private fun handleTouch(event: MotionEvent, host: View): Boolean {
        predictor.record(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val idx = event.actionIndex
                activePointerId = event.getPointerId(idx)
                mode = classify(event, idx)
                when (mode) {
                    Mode.DRAW -> {
                        host.requestUnbufferedDispatch(event)
                        currentStrokeHighlighter = tool == Tool.HIGHLIGHTER
                        val meToWorld = Matrix().apply { setTranslate(-panX, -panY) }
                        strokeId = inProgressView.startStroke(event, activePointerId, brush(), meToWorld, Matrix())
                    }
                    Mode.PAN -> { lastPanX = event.getX(idx); lastPanY = event.getY(idx) }
                    Mode.ERASE -> eraseAt(event.getX(idx), event.getY(idx))
                    else -> {}
                }
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                val idx = event.findPointerIndex(activePointerId)
                if (idx < 0) return true
                when (mode) {
                    Mode.DRAW -> {
                        val sid = strokeId ?: return true
                        val predicted = predictor.predict()
                        try {
                            inProgressView.addToStroke(event, activePointerId, sid, predicted)
                        } finally {
                            predicted?.recycle()
                        }
                    }
                    Mode.PAN -> {
                        val x = event.getX(idx); val y = event.getY(idx)
                        panX += x - lastPanX; panY += y - lastPanY
                        lastPanX = x; lastPanY = y
                        finishedView.setPan(panX, panY)
                    }
                    Mode.ERASE -> eraseAt(event.getX(idx), event.getY(idx))
                    else -> {}
                }
                return true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (mode == Mode.DRAW) {
                    val sid = strokeId
                    if (sid != null) {
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

    // ---- persistence (per notebook page) ----
    private fun pageFile() = store.pageFile(currentPageId)

    private fun currentIndex() = notebook.pageIds.indexOf(currentPageId).coerceAtLeast(0)

    private fun updatePageLabel() { pageLabel?.text = "${currentIndex() + 1}/${notebook.pageIds.size}" }

    private fun switchPage(delta: Int) {
        val target = currentIndex() + delta
        if (target < 0 || target >= notebook.pageIds.size) return
        save()
        currentPageId = notebook.pageIds[target]
        panX = 0f; panY = 0f; finishedView.setPan(0f, 0f)
        finishedView.clearAll()
        load()
        updatePageLabel()
    }

    private fun addPage() {
        save()
        currentPageId = store.addPage(notebook)
        panX = 0f; panY = 0f; finishedView.setPan(0f, 0f)
        finishedView.clearAll()
        load() // no file yet -> blank page, keeps current paper style
        updatePageLabel()
    }

    private fun save() {
        try {
            val arr = JSONArray()
            for (rec in finishedView.snapshot()) {
                val br = rec.stroke.brush
                val o = JSONObject()
                    .put("c", br.colorIntArgb)
                    .put("s", br.size.toDouble())
                    .put("h", rec.highlighter)
                val ia = JSONArray()
                val batch = rec.stroke.inputs
                val si = StrokeInput()
                for (i in 0 until batch.size) {
                    batch.populate(i, si)
                    val pr = if (si.pressure.isFinite() && si.pressure in 0f..1f) si.pressure.toDouble() else -1.0
                    ia.put(JSONArray().put(si.x.toDouble()).put(si.y.toDouble()).put(si.elapsedTimeMillis).put(pr))
                }
                o.put("i", ia)
                arr.put(o)
            }
            val doc = JSONObject()
                .put("paper", finishedView.paperStyle.name)
                .put("page", finishedView.pageColor)
                .put("strokes", arr)
            pageFile().writeText(doc.toString())
        } catch (e: Exception) {
            Log.e("Ink", "save failed", e)
        }
    }

    private fun load() {
        try {
            val f = pageFile()
            if (!f.exists()) return
            val doc = JSONObject(f.readText())
            finishedView.paperStyle = runCatching {
                FinishedStrokesView.PaperStyle.valueOf(doc.optString("paper", "GRID"))
            }.getOrDefault(FinishedStrokesView.PaperStyle.GRID)
            finishedView.pageColor = doc.optInt("page", finishedView.pageColor)
            val arr = doc.optJSONArray("strokes") ?: return
            val recs = ArrayList<FinishedStrokesView.Rec>(arr.length())
            for (k in 0 until arr.length()) {
                val o = arr.getJSONObject(k)
                val color = o.getInt("c")
                val size = o.getDouble("s").toFloat()
                val hl = o.optBoolean("h", false)
                val fam = if (hl) StockBrushes.highlighter() else StockBrushes.pressurePen()
                val brush = Brush.createWithColorIntArgb(fam, color, size, 0.1f)
                val ia = o.getJSONArray("i")
                val batch = MutableStrokeInputBatch()
                val pts = ArrayList<PointF>(ia.length())
                for (j in 0 until ia.length()) {
                    val p = ia.getJSONArray(j)
                    val x = p.getDouble(0).toFloat()
                    val y = p.getDouble(1).toFloat()
                    val t = p.getLong(2)
                    val prRaw = p.getDouble(3)
                    val pr = if (prRaw < 0) StrokeInput.NO_PRESSURE else prRaw.toFloat()
                    try {
                        batch.add(InputToolType.STYLUS, x, y, t, pressure = pr)
                        pts.add(PointF(x, y))
                    } catch (_: Exception) { /* skip an invalid point */ }
                }
                if (batch.size >= 1) {
                    try { recs.add(FinishedStrokesView.Rec(Stroke(brush, batch), pts, hl)) }
                    catch (e: Exception) { Log.e("Ink", "rebuild stroke", e) }
                }
            }
            finishedView.setAll(recs)
        } catch (e: Exception) {
            Log.e("Ink", "load failed", e)
        }
    }

    // ---- toolbar ----
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildToolbar(): View {
        fun chip(label: String, onClick: (Button) -> Unit) = Button(this).apply {
            text = label; minWidth = 0; minimumWidth = 0
            setOnClickListener { onClick(this) }
        }
        fun sep() = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(1), dp(28)).apply { setMargins(dp(6), 0, dp(6), 0) }
            setBackgroundColor(Color.argb(0x30, 0, 0, 0))
        }
        colorButton = chip("  ") { showColorPicker(it) { c -> brushColor = c; colorButton.setBackgroundColor(c) } }
            .apply { setBackgroundColor(brushColor); minWidth = dp(44) }

        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.argb(0xEE, 0xFF, 0xFF, 0xFF))
            setPadding(dp(6), dp(4), dp(6), dp(4))
            addView(chip("‹ App") { finish() })
            addView(sep())
            addView(chip("Pen") { tool = Tool.PEN })
            addView(chip("HL") { tool = Tool.HIGHLIGHTER })
            addView(chip("Erase") { tool = Tool.ERASER })
            addView(sep())
            addView(colorButton)
            addView(chip("−") { brushSize = (brushSize - 2f).coerceAtLeast(2f) })
            addView(chip("+") { brushSize = (brushSize + 2f).coerceAtMost(36f) })
            addView(sep())
            addView(chip("Paper") { cyclePaper(); save() })
            addView(chip("Page") { showColorPicker(it) { c -> finishedView.pageColor = c; save() } })
            addView(chip("Clear") { finishedView.clearAll(); save() })
            addView(sep())
            addView(chip("‹") { switchPage(-1) })
            pageLabel = chip("1/1") { }.also { addView(it) }
            addView(chip("›") { switchPage(1) })
            addView(chip("+Pg") { addPage() })
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
        val pad = dp(8)
        val grid = GridLayout(this).apply {
            columnCount = 5
            setBackgroundColor(Color.WHITE)
            setPadding(pad, pad, pad, pad)
        }
        val popup = PopupWindow(grid, WRAP_CONTENT, WRAP_CONTENT, true)
        val sz = dp(42); val m = dp(4)
        for (c in palette) {
            grid.addView(View(this).apply {
                setBackgroundColor(c)
                layoutParams = GridLayout.LayoutParams().apply { width = sz; height = sz; setMargins(m, m, m, m) }
                setOnClickListener { onPick(c); popup.dismiss() }
            })
        }
        popup.showAsDropDown(anchor)
    }

    companion object {
        const val EXTRA_NOTEBOOK_ID = "notebookId"
    }
}
