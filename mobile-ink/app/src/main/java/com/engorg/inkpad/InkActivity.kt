package com.engorg.inkpad

import android.graphics.Color
import android.graphics.Matrix
import android.graphics.PointF
import android.os.Bundle
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
import androidx.ink.brush.StockBrushes
import androidx.ink.strokes.Stroke

/**
 * Native low-latency handwriting surface.
 *  • Pen writes (front-buffered androidx.ink + prediction); highlighter is a translucent brush.
 *  • Finger drags the page (pan). S Pen button, an eraser-tip pen, or the Eraser tool erases
 *    whole strokes — with a circle showing the eraser's reach.
 *  • Paper style (plain/grid/ruled/dots), page color and brush color are all adjustable.
 */
class InkActivity : ComponentActivity() {

    private lateinit var inProgressView: InProgressStrokesView
    private lateinit var finishedView: FinishedStrokesView
    private lateinit var eraserOverlay: EraserOverlay
    private lateinit var predictor: MotionEventPredictor
    private lateinit var colorButton: Button

    private enum class Mode { NONE, DRAW, ERASE, PAN }
    private enum class Tool { PEN, HIGHLIGHTER, ERASER }

    private var mode = Mode.NONE
    private var tool = Tool.PEN
    private var activePointerId = -1
    private var strokeId: InProgressStrokeId? = null

    private var brushColor = Color.rgb(0x16, 0x1A, 0x22)
    private var brushSize = 6f
    private val eraserRadius = 28f

    private var panX = 0f
    private var panY = 0f
    private var lastPanX = 0f
    private var lastPanY = 0f

    private val pointsByStroke = HashMap<InProgressStrokeId, MutableList<PointF>>()

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
                for ((id, stroke) in strokes) {
                    val pts = pointsByStroke.remove(id) ?: mutableListOf()
                    finishedView.addStroke(stroke, pts)
                }
                inProgressView.removeFinishedStrokes(strokes.keys)
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
    }

    private fun brush(): Brush {
        val r = Color.red(brushColor); val g = Color.green(brushColor); val b = Color.blue(brushColor)
        return if (tool == Tool.HIGHLIGHTER) {
            Brush.createWithColorIntArgb(
                family = StockBrushes.highlighter(),
                colorIntArgb = Color.argb(0x66, r, g, b),
                size = brushSize * 3.2f,
                epsilon = 0.1f,
            )
        } else {
            Brush.createWithColorIntArgb(
                family = StockBrushes.pressurePen(),
                colorIntArgb = Color.argb(0xFF, r, g, b),
                size = brushSize,
                epsilon = 0.1f,
            )
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

    private fun worldPoint(event: MotionEvent, idx: Int) =
        PointF(event.getX(idx) - panX, event.getY(idx) - panY)

    private fun eraseAt(sx: Float, sy: Float) {
        eraserOverlay.show(sx, sy, eraserRadius)
        finishedView.eraseNear(sx - panX, sy - panY, eraserRadius)
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
                        val meToWorld = Matrix().apply { setTranslate(-panX, -panY) }
                        val id = inProgressView.startStroke(event, activePointerId, brush(), meToWorld, Matrix())
                        strokeId = id
                        pointsByStroke[id] = mutableListOf(worldPoint(event, idx))
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
                        pointsByStroke[sid]?.let { list ->
                            for (h in 0 until event.historySize) {
                                list.add(PointF(event.getHistoricalX(idx, h) - panX, event.getHistoricalY(idx, h) - panY))
                            }
                            list.add(worldPoint(event, idx))
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
                        if (event.actionMasked == MotionEvent.ACTION_CANCEL) {
                            inProgressView.cancelStroke(sid, event)
                            pointsByStroke.remove(sid)
                        } else {
                            inProgressView.finishStroke(event, activePointerId, sid)
                        }
                    }
                }
                eraserOverlay.hide()
                strokeId = null; mode = Mode.NONE; activePointerId = -1
                return true
            }
        }
        return false
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
            addView(chip("Paper") { cyclePaper() })
            addView(chip("Page") { showColorPicker(it) { c -> finishedView.pageColor = c } })
            addView(chip("Clear") { finishedView.clearAll() })
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
}
