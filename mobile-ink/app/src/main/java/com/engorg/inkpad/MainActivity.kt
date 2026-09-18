package com.engorg.inkpad

import android.graphics.Color
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
 * Minimal native ink proof-of-concept.
 *
 * The whole point is to FEEL the latency: [InProgressStrokesView] renders the stroke you're
 * currently drawing on a front-buffered (low-latency) layer, and [MotionPredictor] feeds it a
 * predicted lead so the ink keeps up with a fast pen. This is the native equivalent of what
 * makes iPad + Apple Pencil feel instant — and what a web canvas on Android cannot do.
 *
 * Layer order (bottom → top): finished strokes, in-progress (low-latency), transparent touch
 * catcher, toolbar.
 */
class MainActivity : ComponentActivity() {

    private lateinit var inProgressView: InProgressStrokesView
    private lateinit var finishedView: FinishedStrokesView
    private lateinit var predictor: MotionEventPredictor

    private var pointerId: Int? = null
    private var strokeId: InProgressStrokeId? = null

    private var brushColor: Int = Color.rgb(0x16, 0x1A, 0x22) // near-black ink
    private var brushSize: Float = 6f

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        finishedView = FinishedStrokesView(this)
        inProgressView = InProgressStrokesView(this)

        // Move finished strokes off the low-latency layer as soon as they complete.
        inProgressView.addFinishedStrokesListener(object : InProgressStrokesFinishedListener {
            override fun onStrokesFinished(strokes: Map<InProgressStrokeId, Stroke>) {
                finishedView.addStrokes(strokes.values)
                inProgressView.removeFinishedStrokes(strokes.keys)
            }
        })

        // Transparent view on top that catches stylus input and drives the ink pipeline.
        val touchCatcher = object : View(this) {
            override fun onTouchEvent(event: MotionEvent): Boolean = handleTouch(event, this)
        }
        // Prediction is bound to the view that receives the touches.
        predictor = MotionEventPredictor.newInstance(touchCatcher)

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(0xFD, 0xFD, 0xFB)) // paper
            addView(finishedView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(inProgressView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(touchCatcher, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(buildToolbar(), FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
                gravity = Gravity.TOP or Gravity.START
                topMargin = 24; leftMargin = 24
            })
        }
        setContentView(root)
    }

    private fun currentBrush(): Brush =
        Brush.createWithColorIntArgb(
            family = StockBrushes.pressurePen(),
            colorIntArgb = brushColor,
            size = brushSize,
            epsilon = 0.1f,
        )

    private fun handleTouch(event: MotionEvent, host: View): Boolean {
        predictor.record(event)
        val predicted: MotionEvent? = predictor.predict()
        try {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    // Ask the framework to stop batching input for the lowest possible latency.
                    host.requestUnbufferedDispatch(event)
                    val pid = event.getPointerId(event.actionIndex)
                    pointerId = pid
                    strokeId = inProgressView.startStroke(event, pid, currentBrush())
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val pid = pointerId ?: return false
                    val sid = strokeId ?: return false
                    inProgressView.addToStroke(event, pid, sid, predicted)
                    return true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val pid = pointerId ?: return false
                    val sid = strokeId ?: return false
                    inProgressView.finishStroke(event, pid, sid)
                    pointerId = null
                    strokeId = null
                    return true
                }
            }
        } finally {
            predicted?.recycle()
        }
        return false
    }

    // ---- minimal toolbar: colors, thickness, clear ----
    private fun buildToolbar(): View {
        fun chip(label: String, onClick: () -> Unit) = Button(this).apply {
            text = label
            setOnClickListener { onClick() }
            minWidth = 0; minimumWidth = 0
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.argb(0xEE, 0xFF, 0xFF, 0xFF))
            setPadding(12, 8, 12, 8)
            addView(chip("Ink") { brushColor = Color.rgb(0x16, 0x1A, 0x22) })
            addView(chip("Blue") { brushColor = Color.rgb(0x29, 0x47, 0xC9) })
            addView(chip("Red") { brushColor = Color.rgb(0xDC, 0x26, 0x50) })
            addView(chip("−") { brushSize = (brushSize - 2f).coerceAtLeast(2f) })
            addView(chip("+") { brushSize = (brushSize + 2f).coerceAtMost(28f) })
            addView(chip("Clear") { finishedView.clearAll() })
        }
    }
}
