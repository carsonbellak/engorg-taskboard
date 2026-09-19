package com.engorg.inkpad

import android.graphics.Color
import android.graphics.Matrix
import android.graphics.PointF
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.ViewTreeObserver
import android.widget.Button
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
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
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Native handwriting surface. Fixed 8.5x11 pages stacked vertically (scroll through them),
 * zoom/pan, pen / highlighter / eraser, lasso select + move/resize/delete, insertable shapes
 * with draggable vertices, undo/redo, per-notebook auto-save.
 *
 * Coordinate model (the important part): the ink library draws the WET stroke in plain screen
 * coordinates (identity transforms). On finish we convert its points to PAGE-LOCAL coordinates
 * ourselves with a matrix we fully control, and store them per page. Rendering always maps
 * page-local -> screen with the same transform, so ink stays glued to its page under pan/zoom.
 */
class InkActivity : ComponentActivity() {

    private lateinit var inProgressView: InProgressStrokesView
    private lateinit var finishedView: FinishedStrokesView
    private lateinit var eraserOverlay: EraserOverlay
    private lateinit var predictor: MotionEventPredictor
    private lateinit var scaleDetector: ScaleGestureDetector
    private lateinit var colorButton: Button
    private val toolButtons = HashMap<Tool, Button>()

    private enum class Mode { NONE, DRAW, ERASE, PAN, SELECT }
    private enum class Tool { PEN, HIGHLIGHTER, ERASER, SELECT }

    private var mode = Mode.NONE
    private var tool = Tool.PEN
    private var activePointerId = -1
    private var strokeId: InProgressStrokeId? = null
    private var currentHighlighter = false
    private var dirtyErase = false
    private var undoPushedThisGesture = false

    private var brushColor = Color.rgb(0x16, 0x1A, 0x22)
    private var brushSize = 6f
    private val eraserRadius = 26f // page units

    // view transform: screen = world*scale + (tx,ty)
    private var scale = 1f
    private var tx = 0f
    private var ty = 0f
    private var lastPanX = 0f
    private var lastPanY = 0f
    private var lastFocusX = 0f
    private var lastFocusY = 0f
    private var fitVertical = false

    // selection state (edit tool)
    private var selPage = -1
    private val selRecs = ArrayList<FinishedStrokesView.Rec>()
    private var selBox: RectF? = null
    private enum class Grab { NONE, MOVE, RESIZE, VERTEX, DELETE, LASSO }
    private var grab = Grab.NONE
    private var grabCorner = 0
    private var grabVertex = 0
    private var dragStartLocal = PointF()
    private var dragStartBox = RectF()
    private var dragStartRecs = ArrayList<FinishedStrokesView.Rec>()
    private val lassoScreen = ArrayList<PointF>()

    // undo / redo (snapshots of every page's rec list; page count is constant across these ops)
    private val undoStack = ArrayList<List<List<FinishedStrokesView.Rec>>>()
    private val redoStack = ArrayList<List<List<FinishedStrokesView.Rec>>>()

    private lateinit var store: NotebookStore
    private lateinit var notebook: NotebookStore.Notebook

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
        finishedView.accent = AppTheme.accent
        inProgressView = InProgressStrokesView(this)
        eraserOverlay = EraserOverlay(this)

        inProgressView.addFinishedStrokesListener(object : InProgressStrokesFinishedListener {
            override fun onStrokesFinished(strokes: Map<InProgressStrokeId, Stroke>) {
                for ((_, stroke) in strokes) commitWetStroke(stroke)
                inProgressView.removeFinishedStrokes(strokes.keys)
                saveCurrentPage()
            }
        })

        scaleDetector = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: ScaleGestureDetector): Boolean { lastFocusX = d.focusX; lastFocusY = d.focusY; return true }
            override fun onScale(d: ScaleGestureDetector): Boolean {
                tx += d.focusX - lastFocusX; ty += d.focusY - lastFocusY
                lastFocusX = d.focusX; lastFocusY = d.focusY
                val ns = (scale * d.scaleFactor).coerceIn(0.2f, 6f)
                tx = d.focusX - (d.focusX - tx) * (ns / scale)
                ty = d.focusY - (d.focusY - ty) * (ns / scale)
                scale = ns
                clampTransform(); applyTransform()
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
        if (notebook.pageIds.isEmpty()) store.addPage(notebook)
        finishedView.paperStyle = runCatching { FinishedStrokesView.PaperStyle.valueOf(notebook.paper) }
            .getOrDefault(FinishedStrokesView.PaperStyle.GRID)
        finishedView.pageColor = notebook.pageColor
        loadAllPages()
        updateTools()

        finishedView.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                if (finishedView.width > 0) {
                    finishedView.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    fitVertical = false; fitPage()
                }
            }
        })
    }

    // ---------- transform ----------
    private fun applyTransform() { finishedView.setTransform(scale, tx, ty) }

    private fun clampTransform() {
        val vw = finishedView.width.toFloat(); val vh = finishedView.height.toFloat()
        if (vw <= 0f) return
        val pad = dp(28).toFloat()
        val docW = FinishedStrokesView.PAGE_W * scale
        val docH = finishedView.docHeight() * scale
        tx = if (docW <= vw) (vw - docW) / 2f else tx.coerceIn(vw - docW - pad, pad)
        ty = if (docH <= vh) (vh - docH) / 2f else ty.coerceIn(vh - docH - pad, pad)
    }

    private fun currentPage(): Int {
        val vh = finishedView.height.toFloat().coerceAtLeast(1f)
        val docYCenter = (vh / 2f - ty) / scale
        val unit = FinishedStrokesView.PAGE_H + FinishedStrokesView.GAP
        return floor(docYCenter / unit).toInt().coerceIn(0, finishedView.pages.size - 1)
    }

    /** Fit toggles: first press fits page WIDTH, second press fits page HEIGHT. */
    private fun fitPage() {
        val vw = finishedView.width.toFloat(); val vh = finishedView.height.toFloat()
        if (vw <= 0f) return
        val cur = currentPage().coerceAtLeast(0)
        if (!fitVertical) {
            scale = (vw / FinishedStrokesView.PAGE_W) * 0.98f
            tx = (vw - FinishedStrokesView.PAGE_W * scale) / 2f
            ty = dp(16).toFloat() - scale * finishedView.pageTop(cur)
        } else {
            scale = (vh / FinishedStrokesView.PAGE_H) * 0.98f
            tx = (vw - FinishedStrokesView.PAGE_W * scale) / 2f
            ty = (vh - FinishedStrokesView.PAGE_H * scale) / 2f - scale * finishedView.pageTop(cur)
        }
        applyTransform()
    }

    private fun zoomBy(factor: Float) {
        val fx = finishedView.width / 2f; val fy = finishedView.height / 2f
        val ns = (scale * factor).coerceIn(0.2f, 6f)
        tx = fx - (fx - tx) * (ns / scale)
        ty = fy - (fy - ty) * (ns / scale)
        scale = ns
        clampTransform(); applyTransform()
    }

    // screen -> (page, page-local x/y). localY may be outside [0,PAGE_H] when in a gap.
    private data class Hit(val page: Int, val x: Float, val y: Float, val onPage: Boolean)
    private fun hitTest(sx: Float, sy: Float): Hit {
        val docX = (sx - tx) / scale
        val docY = (sy - ty) / scale
        val unit = FinishedStrokesView.PAGE_H + FinishedStrokesView.GAP
        var p = floor(docY / unit).toInt()
        p = p.coerceIn(0, finishedView.pages.size - 1)
        val localY = docY - finishedView.pageTop(p)
        val onPage = docX in 0f..FinishedStrokesView.PAGE_W && localY in 0f..FinishedStrokesView.PAGE_H
        return Hit(p, docX, localY, onPage)
    }
    private fun screenX(x: Float) = tx + scale * x
    private fun screenY(page: Int, y: Float) = ty + scale * (finishedView.pageTop(page) + y)

    // ---------- brushes ----------
    private fun makeBrush(color: Int, sizePx: Float, hl: Boolean): Brush {
        val r = Color.red(color); val g = Color.green(color); val b = Color.blue(color)
        return if (hl) Brush.createWithColorIntArgb(StockBrushes.highlighter(), Color.argb(0x66, r, g, b), sizePx, 0.1f)
        else Brush.createWithColorIntArgb(StockBrushes.pressurePen(), Color.argb(0xFF, r, g, b), sizePx, 0.1f)
    }
    private fun pageUnitSize(hl: Boolean) = if (hl) brushSize * 3.2f else brushSize
    private fun wetBrush(): Brush = makeBrush(brushColor, pageUnitSize(tool == Tool.HIGHLIGHTER) * scale, tool == Tool.HIGHLIGHTER)

    private fun buildStroke(points: List<PointF>, brush: Brush): Stroke? {
        val batch = MutableStrokeInputBatch()
        var t = 0L
        for (p in points) { runCatching { batch.add(InputToolType.STYLUS, p.x, p.y, t, pressure = 0.5f) }; t += 6 }
        return if (batch.size >= 2) runCatching { Stroke(brush, batch) }.getOrNull() else null
    }

    private fun buildShapeRec(spec: ShapeSpec, color: Int, sizePx: Float, hl: Boolean): FinishedStrokesView.Rec {
        val brush = makeBrush(color, sizePx, hl)
        val polys = spec.polylines()
        val strokes = polys.mapNotNull { buildStroke(it, brush) }
        val pts = ArrayList<PointF>(); polys.forEach { pts.addAll(it) }
        return FinishedStrokesView.Rec(strokes, pts, hl, spec, color, sizePx)
    }

    // ---------- committing wet ink ----------
    private fun commitWetStroke(wet: Stroke) {
        val batch = wet.inputs
        if (batch.size < 1) return
        val si = StrokeInput()
        batch.populate(0, si)
        val start = hitTest(si.x, si.y)
        if (!start.onPage) return // don't keep ink drawn off the page
        val page = start.page
        val out = MutableStrokeInputBatch()
        val pts = ArrayList<PointF>(batch.size)
        for (i in 0 until batch.size) {
            batch.populate(i, si)
            val docX = (si.x - tx) / scale
            val docY = (si.y - ty) / scale
            val lx = docX.coerceIn(0f, FinishedStrokesView.PAGE_W)
            val ly = (docY - finishedView.pageTop(page)).coerceIn(0f, FinishedStrokesView.PAGE_H)
            val pr = if (si.pressure.isFinite() && si.pressure in 0f..1f) si.pressure else StrokeInput.NO_PRESSURE
            runCatching { out.add(InputToolType.STYLUS, lx, ly, si.elapsedTimeMillis, pressure = pr) }
            pts.add(PointF(lx, ly))
        }
        if (out.size < 1) return
        val hl = currentHighlighter
        val brush = makeBrush(brushColor, pageUnitSize(hl), hl)
        val stroke = runCatching { Stroke(brush, out) }.getOrNull() ?: return
        finishedView.pages[page].recs.add(
            FinishedStrokesView.Rec(listOf(stroke), pts, hl, null, brushColor, pageUnitSize(hl))
        )
        finishedView.invalidate()
    }

    // ---------- touch ----------
    private fun classify(event: MotionEvent, idx: Int): Mode {
        val type = event.getToolType(idx)
        val eraserBtn = (event.buttonState and (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_STYLUS_SECONDARY)) != 0
        return when {
            type == MotionEvent.TOOL_TYPE_FINGER -> Mode.PAN
            type == MotionEvent.TOOL_TYPE_ERASER -> Mode.ERASE
            eraserBtn -> Mode.ERASE
            tool == Tool.ERASER -> Mode.ERASE
            tool == Tool.SELECT -> Mode.SELECT
            else -> Mode.DRAW
        }
    }

    private fun handleTouch(event: MotionEvent, host: View): Boolean {
        predictor.record(event)
        if (event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER) scaleDetector.onTouchEvent(event)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val idx = event.actionIndex
                activePointerId = event.getPointerId(idx)
                mode = classify(event, idx)
                undoPushedThisGesture = false
                when (mode) {
                    Mode.DRAW -> beginDraw(event, idx, host)
                    Mode.PAN -> { lastPanX = event.getX(idx); lastPanY = event.getY(idx) }
                    Mode.ERASE -> eraseAt(event.getX(idx), event.getY(idx))
                    Mode.SELECT -> beginSelect(event.getX(idx), event.getY(idx))
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
                        val sid = strokeId ?: return true
                        val predicted = predictor.predict()
                        try { inProgressView.addToStroke(event, activePointerId, sid, predicted) } finally { predicted?.recycle() }
                    }
                    Mode.PAN -> {
                        val x = event.getX(idx); val y = event.getY(idx)
                        tx += x - lastPanX; ty += y - lastPanY
                        lastPanX = x; lastPanY = y
                        clampTransform(); applyTransform()
                    }
                    Mode.ERASE -> eraseAt(event.getX(idx), event.getY(idx))
                    Mode.SELECT -> moveSelect(event.getX(idx), event.getY(idx))
                    else -> {}
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val cancel = event.actionMasked == MotionEvent.ACTION_CANCEL
                when (mode) {
                    Mode.DRAW -> {
                        val sid = strokeId
                        if (sid != null) {
                            if (cancel) inProgressView.cancelStroke(sid, event)
                            else inProgressView.finishStroke(event, activePointerId, sid)
                        }
                    }
                    Mode.ERASE -> if (dirtyErase) { dirtyErase = false; saveCurrentPage() }
                    Mode.SELECT -> endSelect()
                    else -> {}
                }
                eraserOverlay.hide()
                strokeId = null; mode = Mode.NONE; activePointerId = -1
                return true
            }
        }
        return false
    }

    private fun beginDraw(event: MotionEvent, idx: Int, host: View) {
        val h = hitTest(event.getX(idx), event.getY(idx))
        if (!h.onPage) { mode = Mode.NONE; return } // can't start writing off the page
        clearSelection()
        pushUndo()
        host.requestUnbufferedDispatch(event)
        currentHighlighter = tool == Tool.HIGHLIGHTER
        strokeId = inProgressView.startStroke(event, activePointerId, wetBrush(), Matrix(), Matrix())
    }

    private fun eraseAt(sx: Float, sy: Float) {
        eraserOverlay.show(sx, sy, eraserRadius * scale)
        val h = hitTest(sx, sy)
        if (!dirtyErase) pushUndo()
        if (finishedView.eraseNear(h.page, h.x, h.y, eraserRadius)) dirtyErase = true
    }

    // ---------- selection / editing ----------
    private fun clearSelection() {
        selRecs.clear(); selPage = -1; selBox = null; grab = Grab.NONE
        finishedView.clearSelection(); finishedView.setLasso(null)
    }

    private fun recBounds(recs: List<FinishedStrokesView.Rec>): RectF? {
        if (recs.isEmpty()) return null
        var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE; var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
        for (r in recs) for (p in r.points) { minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y) }
        if (minX > maxX) return null
        return RectF(minX, minY, maxX, maxY)
    }

    private fun refreshSelectionOverlay() {
        val box = selBox
        if (box == null || selRecs.isEmpty()) { finishedView.clearSelection(); return }
        val handles = if (selRecs.size == 1 && selRecs[0].shape != null) selRecs[0].shape!!.handles else null
        finishedView.setSelection(selPage, box, handles)
    }

    private fun beginSelect(sx: Float, sy: Float) {
        val box = selBox
        if (box != null && selRecs.isNotEmpty()) {
            // delete handle?
            val dcx = screenX(box.right) + 20f; val dcy = screenY(selPage, box.top) - 20f
            if (hypot(sx - dcx, sy - dcy) <= 26f) { deleteSelection(); return }
            // vertex handle (single shape)?
            if (selRecs.size == 1 && selRecs[0].shape != null) {
                val hs = selRecs[0].shape!!.handles
                for (i in hs.indices) {
                    if (hypot(sx - screenX(hs[i].x), sy - screenY(selPage, hs[i].y)) <= 30f) {
                        grab = Grab.VERTEX; grabVertex = i; pushUndo()
                        dragStartRecs = ArrayList(selRecs)
                        return
                    }
                }
            }
            // corner resize handle?
            val corners = arrayOf(
                floatArrayOf(box.left, box.top), floatArrayOf(box.right, box.top),
                floatArrayOf(box.right, box.bottom), floatArrayOf(box.left, box.bottom)
            )
            for (i in corners.indices) {
                if (hypot(sx - screenX(corners[i][0]), sy - screenY(selPage, corners[i][1])) <= 30f) {
                    grab = Grab.RESIZE; grabCorner = i; pushUndo()
                    dragStartBox = RectF(box); dragStartRecs = ArrayList(selRecs)
                    val h = hitTest(sx, sy); dragStartLocal.set(h.x, h.y)
                    return
                }
            }
            // inside box -> move
            val h = hitTest(sx, sy)
            if (h.page == selPage && box.contains(h.x, h.y)) {
                grab = Grab.MOVE; pushUndo()
                dragStartBox = RectF(box); dragStartRecs = ArrayList(selRecs); dragStartLocal.set(h.x, h.y)
                return
            }
        }
        // start a fresh lasso
        clearSelection()
        grab = Grab.LASSO
        lassoScreen.clear(); lassoScreen.add(PointF(sx, sy))
        finishedView.setLasso(lassoScreen)
    }

    private fun moveSelect(sx: Float, sy: Float) {
        when (grab) {
            Grab.LASSO -> { lassoScreen.add(PointF(sx, sy)); finishedView.setLasso(lassoScreen) }
            Grab.MOVE -> {
                val h = hitTest(sx, sy)
                val dx = h.x - dragStartLocal.x; val dy = h.y - dragStartLocal.y
                val m = Matrix().apply { setTranslate(dx, dy) }
                applyMatrixToSelection(m); refreshSelectionOverlay()
            }
            Grab.RESIZE -> {
                val h = hitTest(sx, sy)
                val b = dragStartBox
                val ax = if (grabCorner == 0 || grabCorner == 3) b.right else b.left
                val ay = if (grabCorner == 0 || grabCorner == 1) b.bottom else b.top
                val startX = if (grabCorner == 0 || grabCorner == 3) b.left else b.right
                val startY = if (grabCorner == 0 || grabCorner == 1) b.top else b.bottom
                var sxf = if (abs(startX - ax) > 1f) (h.x - ax) / (startX - ax) else 1f
                var syf = if (abs(startY - ay) > 1f) (h.y - ay) / (startY - ay) else 1f
                sxf = sxf.coerceIn(0.05f, 20f); syf = syf.coerceIn(0.05f, 20f)
                val m = Matrix().apply { setTranslate(ax, ay); preScale(sxf, syf); preTranslate(-ax, -ay) }
                applyMatrixToSelection(m); refreshSelectionOverlay()
            }
            Grab.VERTEX -> {
                val h = hitTest(sx, sy)
                val base = dragStartRecs[0]
                val spec = base.shape!!.clone()
                spec.verts[grabVertex].set(
                    h.x.coerceIn(0f, FinishedStrokesView.PAGE_W),
                    h.y.coerceIn(0f, FinishedStrokesView.PAGE_H)
                )
                val newRec = buildShapeRec(spec, base.colorArgb, base.sizePx, base.highlighter)
                replaceRec(base, newRec)
                selRecs[0] = newRec; dragStartRecs[0] = newRec // keep editing same object
                selBox = recBounds(selRecs)
                refreshSelectionOverlay()
            }
            else -> {}
        }
    }

    private fun endSelect() {
        when (grab) {
            Grab.LASSO -> finishLasso()
            Grab.MOVE, Grab.RESIZE, Grab.VERTEX -> { selBox = recBounds(selRecs); refreshSelectionOverlay(); saveCurrentPage() }
            else -> {}
        }
        grab = Grab.NONE
    }

    private fun finishLasso() {
        finishedView.setLasso(null)
        if (lassoScreen.size < 3) { clearSelection(); return }
        val page = hitTest(lassoScreen[0].x, lassoScreen[0].y).page
        // Project the lasso into the start page's local space.
        val localPoly = lassoScreen.map { toLocalOn(it.x, it.y, page) }
        selRecs.clear()
        for (rec in finishedView.pages[page].recs) {
            val inside = rec.points.count { pointInPoly(it, localPoly) }
            if (inside >= max(1, rec.points.size / 2)) selRecs.add(rec)
        }
        if (selRecs.isEmpty()) { clearSelection(); return }
        selPage = page; selBox = recBounds(selRecs)
        refreshSelectionOverlay()
    }

    private fun toLocalOn(sx: Float, sy: Float, page: Int): PointF {
        val docX = (sx - tx) / scale; val docY = (sy - ty) / scale
        return PointF(docX, docY - finishedView.pageTop(page))
    }
    private fun pointInPoly(p: PointF, poly: List<PointF>): Boolean {
        var inside = false; var j = poly.size - 1
        for (i in poly.indices) {
            val a = poly[i]; val b = poly[j]
            if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / ((b.y - a.y) + 1e-6f) + a.x) inside = !inside
            j = i
        }
        return inside
    }

    private fun applyMatrixToSelection(m: Matrix) {
        val pts = FloatArray(2)
        for (k in dragStartRecs.indices) {
            val base = dragStartRecs[k]
            val newRec = if (base.shape != null) {
                val spec = base.shape.clone()
                for (v in spec.verts) { pts[0] = v.x; pts[1] = v.y; m.mapPoints(pts); v.set(pts[0], pts[1]) }
                buildShapeRec(spec, base.colorArgb, base.sizePx, base.highlighter)
            } else {
                transformFreehand(base, m)
            }
            replaceRec(selRecs[k], newRec)
            selRecs[k] = newRec
        }
    }

    private fun transformFreehand(base: FinishedStrokesView.Rec, m: Matrix): FinishedStrokesView.Rec {
        val src = base.strokes.firstOrNull() ?: return base
        val inBatch = src.inputs
        val out = MutableStrokeInputBatch()
        val si = StrokeInput()
        val pts = ArrayList<PointF>(inBatch.size)
        val f = FloatArray(2)
        for (i in 0 until inBatch.size) {
            inBatch.populate(i, si)
            f[0] = si.x; f[1] = si.y; m.mapPoints(f)
            val pr = if (si.pressure.isFinite() && si.pressure in 0f..1f) si.pressure else StrokeInput.NO_PRESSURE
            runCatching { out.add(InputToolType.STYLUS, f[0], f[1], si.elapsedTimeMillis, pressure = pr) }
            pts.add(PointF(f[0], f[1]))
        }
        val stroke = runCatching { Stroke(base.strokes[0].brush, out) }.getOrNull() ?: return base
        return FinishedStrokesView.Rec(listOf(stroke), pts, base.highlighter, null, base.colorArgb, base.sizePx)
    }

    private fun replaceRec(old: FinishedStrokesView.Rec, new: FinishedStrokesView.Rec) {
        if (selPage < 0) return
        val recs = finishedView.pages[selPage].recs
        val i = recs.indexOf(old)
        if (i >= 0) recs[i] = new else recs.add(new)
        finishedView.invalidate()
    }

    private fun deleteSelection() {
        if (selRecs.isEmpty() || selPage < 0) return
        pushUndo()
        finishedView.pages[selPage].recs.removeAll(selRecs.toSet())
        clearSelection(); finishedView.invalidate(); saveCurrentPage()
    }

    private fun insertShape(type: ShapeType) {
        val page = currentPage()
        undoPushedThisGesture = false // button action, not a touch gesture
        pushUndo()
        val spec = ShapeSpec.make(type, FinishedStrokesView.PAGE_W / 2f, FinishedStrokesView.PAGE_H / 3f, 160f)
        val rec = buildShapeRec(spec, brushColor, brushSize, false)
        finishedView.pages[page].recs.add(rec)
        // auto-select so the user can move/resize/edit its vertices immediately
        tool = Tool.SELECT; updateTools()
        selPage = page; selRecs.clear(); selRecs.add(rec); selBox = recBounds(selRecs)
        refreshSelectionOverlay(); finishedView.invalidate(); saveCurrentPage()
    }

    // ---------- undo / redo ----------
    private fun snapshot(): List<List<FinishedStrokesView.Rec>> =
        finishedView.pages.map { ArrayList(it.recs) }

    private fun pushUndo() {
        if (undoPushedThisGesture) return
        undoStack.add(snapshot())
        if (undoStack.size > 60) undoStack.removeAt(0)
        redoStack.clear()
        undoPushedThisGesture = true
    }

    private fun restore(snap: List<List<FinishedStrokesView.Rec>>) {
        val pages = finishedView.pages
        for (i in pages.indices) {
            pages[i].recs.clear()
            if (i < snap.size) pages[i].recs.addAll(snap[i])
        }
        clearSelection(); finishedView.invalidate(); saveAllPages()
    }

    private fun undo() {
        if (undoStack.isEmpty()) return
        redoStack.add(snapshot())
        restore(undoStack.removeAt(undoStack.size - 1))
    }
    private fun redo() {
        if (redoStack.isEmpty()) return
        undoStack.add(snapshot())
        restore(redoStack.removeAt(redoStack.size - 1))
    }

    // ---------- persistence ----------
    private fun saveMeta() {
        notebook.paper = finishedView.paperStyle.name
        notebook.pageColor = finishedView.pageColor
        store.save()
    }

    private fun savePage(index: Int) {
        if (index < 0 || index >= notebook.pageIds.size) return
        try {
            val arr = JSONArray()
            for (rec in finishedView.pages[index].recs) {
                val o = JSONObject().put("c", rec.colorArgb).put("s", rec.sizePx.toDouble()).put("h", rec.highlighter)
                if (rec.shape != null) {
                    o.put("k", "s").put("t", rec.shape.type.name)
                    val va = JSONArray(); for (v in rec.shape.verts) va.put(JSONArray().put(v.x.toDouble()).put(v.y.toDouble()))
                    o.put("v", va)
                } else {
                    o.put("k", "f")
                    val ia = JSONArray()
                    val batch = rec.strokes.firstOrNull()?.inputs
                    if (batch != null) {
                        val si = StrokeInput()
                        for (i in 0 until batch.size) {
                            batch.populate(i, si)
                            val pr = if (si.pressure.isFinite() && si.pressure in 0f..1f) si.pressure.toDouble() else -1.0
                            ia.put(JSONArray().put(si.x.toDouble()).put(si.y.toDouble()).put(si.elapsedTimeMillis).put(pr))
                        }
                    }
                    o.put("i", ia)
                }
                arr.put(o)
            }
            val doc = JSONObject().put("strokes", arr)
            store.pageFile(notebook.pageIds[index]).writeText(doc.toString())
        } catch (e: Exception) { Log.e("Ink", "save page failed", e) }
        saveMeta()
    }

    private fun saveCurrentPage() = savePage(currentPage())
    private fun saveAllPages() { for (i in notebook.pageIds.indices) savePage(i) }

    private fun loadAllPages() {
        val pages = ArrayList<FinishedStrokesView.Page>()
        for (pid in notebook.pageIds) pages.add(loadPage(pid))
        if (pages.isEmpty()) pages.add(FinishedStrokesView.Page())
        finishedView.pages = pages
    }

    private fun loadPage(pageId: String): FinishedStrokesView.Page {
        val page = FinishedStrokesView.Page()
        try {
            val f = store.pageFile(pageId)
            if (!f.exists()) return page
            val doc = JSONObject(f.readText())
            val arr = doc.optJSONArray("strokes") ?: return page
            for (k in 0 until arr.length()) {
                val o = arr.getJSONObject(k)
                val color = o.getInt("c"); val size = o.getDouble("s").toFloat(); val hl = o.optBoolean("h", false)
                val kind = o.optString("k", "f")
                if (kind == "s") {
                    val type = runCatching { ShapeType.valueOf(o.getString("t")) }.getOrNull() ?: continue
                    val va = o.getJSONArray("v")
                    val verts = ArrayList<PointF>()
                    for (j in 0 until va.length()) { val p = va.getJSONArray(j); verts.add(PointF(p.getDouble(0).toFloat(), p.getDouble(1).toFloat())) }
                    if (verts.isNotEmpty()) page.recs.add(buildShapeRec(ShapeSpec(type, verts), color, size, hl))
                } else {
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
                        runCatching { batch.add(InputToolType.STYLUS, x, y, t, pressure = pr); pts.add(PointF(x, y)) }
                    }
                    if (batch.size >= 1) runCatching { page.recs.add(FinishedStrokesView.Rec(listOf(Stroke(brush, batch)), pts, hl, null, color, size)) }
                }
            }
        } catch (e: Exception) { Log.e("Ink", "load page failed", e) }
        return page
    }

    private fun addPage() {
        saveAllPages()
        store.addPage(notebook)
        undoStack.clear(); redoStack.clear() // page structure changed
        loadAllPages()
        // scroll to the new last page
        finishedView.post {
            val last = finishedView.pages.size - 1
            ty = dp(16).toFloat() - scale * finishedView.pageTop(last)
            clampTransform(); applyTransform()
        }
    }

    // ---------- toolbar ----------
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun pillBg(color: Int) = GradientDrawable().apply { cornerRadius = dp(20).toFloat(); setColor(color) }

    private fun pill(label: String, onClick: (Button) -> Unit): Button = Button(this).apply {
        text = label; isAllCaps = false; textSize = 13f
        setTextColor(onSurface)
        background = pillBg(light)
        stateListAnimator = null
        minWidth = 0; minimumWidth = 0
        setPadding(dp(13), dp(4), dp(13), dp(4))
        setOnClickListener { onClick(this) }
    }

    private fun updateTools() {
        for ((t, btn) in toolButtons) {
            val active = t == tool
            btn.background = pillBg(if (active) accent else light)
            btn.setTextColor(if (active) AppTheme.onAccent() else onSurface)
        }
    }

    private fun buildToolbar(): View {
        fun sep() = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(1), dp(26)).apply { setMargins(dp(6), 0, dp(6), 0) }
            setBackgroundColor(Color.argb(0x22, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
        }
        fun toolPill(label: String, t: Tool) = pill(label) {
            tool = t; if (t != Tool.SELECT) clearSelection(); updateTools()
        }.also { toolButtons[t] = it }

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
            addView(pill("↶") { undo() })
            addView(pill("↷") { redo() })
            addView(sep())
            addView(toolPill("Pen", Tool.PEN))
            addView(toolPill("Marker", Tool.HIGHLIGHTER))
            addView(toolPill("Eraser", Tool.ERASER))
            addView(toolPill("Lasso", Tool.SELECT))
            addView(pill("Shapes ▾") { showShapeMenu(it) })
            addView(sep())
            addView(colorButton)
            addView(pill("–") { brushSize = (brushSize - 2f).coerceAtLeast(2f) })
            addView(pill("+") { brushSize = (brushSize + 2f).coerceAtMost(40f) })
            addView(sep())
            addView(pill("Paper") { cyclePaper(); saveMeta() })
            addView(pill("Page") { showColorPicker(it) { c -> finishedView.pageColor = c; saveMeta() } })
            addView(sep())
            addView(pill("－") { zoomBy(0.8f) })
            addView(pill("＋") { zoomBy(1.25f) })
            addView(pill("Fit") { fitVertical = !fitVertical; fitPage() })
            addView(sep())
            addView(pill("+ Page") { addPage() })
        }
        return HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(bar) }
    }

    private fun cyclePaper() {
        finishedView.paperStyle = when (finishedView.paperStyle) {
            FinishedStrokesView.PaperStyle.PLAIN -> FinishedStrokesView.PaperStyle.GRID
            FinishedStrokesView.PaperStyle.GRID -> FinishedStrokesView.PaperStyle.RULED
            FinishedStrokesView.PaperStyle.RULED -> FinishedStrokesView.PaperStyle.DOTS
            FinishedStrokesView.PaperStyle.DOTS -> FinishedStrokesView.PaperStyle.PLAIN
        }
    }

    private fun showShapeMenu(anchor: View) {
        val items = listOf(
            "Line" to ShapeType.LINE, "Arrow" to ShapeType.ARROW, "Rectangle" to ShapeType.RECT,
            "Circle / Ellipse" to ShapeType.ELLIPSE, "Triangle" to ShapeType.TRIANGLE,
            "2D axes (x–y)" to ShapeType.AXES2D, "3D axes (x–y–z)" to ShapeType.AXES3D,
        )
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(AppTheme.surface) }
            setPadding(dp(6), dp(6), dp(6), dp(6))
        }
        val popup = PopupWindow(col, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(10).toFloat() }
        for ((label, type) in items) {
            col.addView(TextView(this).apply {
                text = label; textSize = 15f; setTextColor(onSurface)
                setPadding(dp(16), dp(12), dp(28), dp(12))
                background = pillBg(Color.TRANSPARENT)
                setOnClickListener { popup.dismiss(); insertShape(type) }
            })
        }
        popup.showAsDropDown(anchor, 0, dp(6))
    }

    private fun showColorPicker(anchor: View, onPick: (Int) -> Unit) {
        val pad = dp(10)
        val grid = GridLayout(this).apply {
            columnCount = 5
            background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, pad)
        }
        val popup = PopupWindow(grid, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(8).toFloat() }
        val sz = dp(42); val m = dp(4)
        for (c in palette) {
            grid.addView(View(this).apply {
                background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(c); setStroke(dp(1), Color.argb(0x33, 0x80, 0x80, 0x80)) }
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
