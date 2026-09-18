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
import android.widget.LinearLayout
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
 *
 *  • Pen (stylus) writes — front-buffered androidx.ink + motion prediction.
 *  • Finger drags the page (pan) instead of writing.
 *  • S Pen side button (or an eraser-tip pen) erases whole strokes under the tip.
 */
class InkActivity : ComponentActivity() {

    private lateinit var inProgressView: InProgressStrokesView
    private lateinit var finishedView: FinishedStrokesView
    private lateinit var predictor: MotionEventPredictor

    private enum class Mode { NONE, DRAW, ERASE, PAN }
    private var mode = Mode.NONE
    private var activePointerId = -1
    private var strokeId: InProgressStrokeId? = null

    private var brushColor = Color.rgb(0x16, 0x1A, 0x22)
    private var brushSize = 6f
    private val eraserRadius = 26f

    // Page pan (world = screen - pan). Pan can't change mid pen-stroke (pen vs finger).
    private var panX = 0f
    private var panY = 0f
    private var lastPanX = 0f
    private var lastPanY = 0f

    // World-space input points per in-progress stroke, kept for eraser hit-testing.
    private val pointsByStroke = HashMap<InProgressStrokeId, MutableList<PointF>>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        finishedView = FinishedStrokesView(this)
        inProgressView = InProgressStrokesView(this)

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
            setBackgroundColor(Color.rgb(0xFD, 0xFD, 0xFB))
            addView(finishedView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(inProgressView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(touch, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(buildToolbar(), FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
                gravity = Gravity.TOP or Gravity.START; topMargin = 24; leftMargin = 24
            })
        }
        setContentView(root)
    }

    private fun brush() = Brush.createWithColorIntArgb(
        family = StockBrushes.pressurePen(),
        colorIntArgb = brushColor,
        size = brushSize,
        epsilon = 0.1f,
    )

    private fun classify(event: MotionEvent, idx: Int): Mode {
        val tool = event.getToolType(idx)
        val eraserBtn = (event.buttonState and
            (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_STYLUS_SECONDARY)) != 0
        return when {
            tool == MotionEvent.TOOL_TYPE_ERASER -> Mode.ERASE
            tool == MotionEvent.TOOL_TYPE_STYLUS && eraserBtn -> Mode.ERASE
            tool == MotionEvent.TOOL_TYPE_STYLUS -> Mode.DRAW
            tool == MotionEvent.TOOL_TYPE_MOUSE -> Mode.DRAW
            tool == MotionEvent.TOOL_TYPE_FINGER -> Mode.PAN
            else -> Mode.PAN
        }
    }

    private fun worldPoint(event: MotionEvent, idx: Int) =
        PointF(event.getX(idx) - panX, event.getY(idx) - panY)

    private fun eraseAt(sx: Float, sy: Float) {
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
                strokeId = null; mode = Mode.NONE; activePointerId = -1
                return true
            }
        }
        return false
    }

    // ---- minimal toolbar ----
    private fun buildToolbar(): View {
        fun chip(label: String, onClick: () -> Unit) = Button(this).apply {
            text = label; setOnClickListener { onClick() }; minWidth = 0; minimumWidth = 0
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.argb(0xEE, 0xFF, 0xFF, 0xFF))
            setPadding(12, 8, 12, 8)
            addView(chip("‹ App") { finish() })
            addView(chip("Ink") { brushColor = Color.rgb(0x16, 0x1A, 0x22) })
            addView(chip("Blue") { brushColor = Color.rgb(0x29, 0x47, 0xC9) })
            addView(chip("Red") { brushColor = Color.rgb(0xDC, 0x26, 0x50) })
            addView(chip("−") { brushSize = (brushSize - 2f).coerceAtLeast(2f) })
            addView(chip("+") { brushSize = (brushSize + 2f).coerceAtMost(28f) })
            addView(chip("Clear") { finishedView.clearAll() })
        }
    }
}
