package com.engorg.inkpad

import android.content.Context
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.PointF
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.graphics.pdf.PdfDocument
import android.util.Log
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewTreeObserver
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** The active tool. Shared across every open pane via [PageCanvas.Host]. */
enum class Tool { PEN, HIGHLIGHTER, ERASER, SELECT }

/** Ink style for the pen tool. PEN = solid round; FOUNTAIN = speed-varied calligraphy nib;
 *  MARKER = broad flat opaque; PENCIL = grainy graphite. (Highlighter is its own tool.) */
enum class Brush { PEN, FOUNTAIN, MARKER, PENCIL }

/**
 * One notebook's editing surface: the FinishedStrokesView + wet/eraser overlays + touch handler +
 * this notebook's viewport (scale/tx/ty), selection, undo-redo and page persistence — everything that
 * used to live directly on InkActivity, extracted so several notebooks can sit side by side.
 *
 * Drawing stays 100% plain Canvas (see FinishedStrokesView) — no native ink renderer. Tool + brush
 * state are NOT stored here; the pane reads them from its [Host] at draw time so every pane always
 * paints with the single shared toolbar's current pen.
 */
class PageCanvas(context: Context, private val store: NotebookStore, private val host: Host) : FrameLayout(context) {

    /** Shared tool/brush state + focus/UI callbacks, supplied by the hosting activity. */
    interface Host {
        val tool: Tool
        val brushColor: Int
        val brushSize: Float
        val brush: Brush
        val smoothing: Float   // 0f (off) .. 1f (max lag/leash)
        val pendingShape: ShapeType?
        fun onPaneFocused(pane: PageCanvas)
        fun onPageChanged(pane: PageCanvas)
        fun onShapeCommitted()
    }

    /**
     * Optional live-mirror sink (Phase 3 desktop companion). Null = no mirroring, so all calls are
     * guarded and cost nothing when a pane isn't being mirrored.
     */
    interface MirrorSink {
        fun paneOpened(pane: PageCanvas)
        fun pageEdited(pane: PageCanvas, index: Int)
        fun wetStroke(pane: PageCanvas, page: Int, pts: List<PointF>, color: Int, widthPx: Float, hl: Boolean)
        fun wetCleared(pane: PageCanvas)
        fun transformed(pane: PageCanvas)
    }
    var mirror: MirrorSink? = null

    val finishedView = FinishedStrokesView(context).apply {
        backdrop = AppTheme.bg; accent = AppTheme.accent; textColor = AppTheme.text
    }
    private val wetOverlay = WetOverlay(context)
    private val eraserOverlay = EraserOverlay(context)
    private val scaleDetector: ScaleGestureDetector

    private enum class Mode { NONE, DRAW, ERASE, PAN, SELECT }
    private var mode = Mode.NONE
    private var activePointerId = -1
    private var currentHighlighter = false
    private var dirtyErase = false
    private var undoPushedThisGesture = false
    private var addArmed = false

    private val eraserRadius = 13f

    private class Sample(val x: Float, val y: Float)
    private val samples = ArrayList<Sample>()
    private var currentBrush = Brush.PEN

    // Stroke stabilizer ("pulled string"): the raw pen position is the ball; the committed line's
    // head chases it, staying [leashPx] behind, so the line lags and smooths. leash grows with the
    // smoothing setting. At leash ~0 we fall back to a light low-pass that only shaves hand jitter.
    private var smInit = false
    private var headX = 0f   // committed line head (last emitted sample), screen space
    private var headY = 0f
    private var ballX = 0f   // raw pen position, screen space
    private var ballY = 0f
    private fun leashPx(): Float = host.smoothing.coerceIn(0f, 1f) * 40f * resources.displayMetrics.density

    var scale = 1f; private set
    var tx = 0f; private set
    var ty = 0f; private set
    private var lastPanX = 0f
    private var lastPanY = 0f
    private var lastFocusX = 0f
    private var lastFocusY = 0f
    private var fitVertical = false

    private var selPage = -1
    private val selRecs = ArrayList<FinishedStrokesView.Rec>()
    private var selBox: RectF? = null
    private enum class Grab { NONE, MOVE, RESIZE, VERTEX, LASSO }
    private var grab = Grab.NONE
    private var grabCorner = 0
    private var grabVertex = 0
    private val dragStartLocal = PointF()
    private val dragStartBox = RectF()
    private var dragStartRecs = ArrayList<FinishedStrokesView.Rec>()
    private val lassoScreen = ArrayList<PointF>()

    private val undoStack = ArrayList<List<List<FinishedStrokesView.Rec>>>()
    private val redoStack = ArrayList<List<List<FinishedStrokesView.Rec>>>()

    lateinit var notebook: NotebookStore.Notebook
        private set

    init {
        scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
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

        val touch = object : View(context) {
            override fun onTouchEvent(event: MotionEvent): Boolean = handleTouch(event)
            override fun onHoverEvent(event: MotionEvent): Boolean {
                if (host.tool == Tool.ERASER) {
                    when (event.actionMasked) {
                        MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE -> eraserOverlay.show(event.x, event.y, eraserRadius * scale)
                        MotionEvent.ACTION_HOVER_EXIT -> eraserOverlay.hide()
                    }
                    return true
                }
                return false
            }
        }

        addView(finishedView, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        addView(wetOverlay, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        addView(eraserOverlay, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        addView(touch, LayoutParams(MATCH_PARENT, MATCH_PARENT))
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ---------- open / focus ----------
    /** Point this pane at a notebook (null = the first/quick-notes notebook) and fit it to view. */
    fun open(notebookId: String?) {
        if (::notebook.isInitialized) syncLastPage()   // remember where the outgoing notebook was
        notebook = (notebookId?.let { store.notebook(it) }) ?: store.notebooks.firstOrNull()
            ?: store.createNotebook("Quick notes", null, AppTheme.accent)
        if (notebook.pageIds.isEmpty()) store.addPage(notebook)
        finishedView.paperStyle = runCatching { FinishedStrokesView.PaperStyle.valueOf(notebook.paper) }.getOrDefault(FinishedStrokesView.PaperStyle.GRID)
        finishedView.pageColor = notebook.pageColor
        loadAllPages()
        undoStack.clear(); redoStack.clear()
        clearSelection()
        // Reopen on the page this notebook was last left on (so a split view restores both pages).
        val target = notebook.lastPage
        if (finishedView.width > 0) { fitVertical = false; fitPage(); goToPage(target) }
        else finishedView.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                if (finishedView.width > 0) {
                    finishedView.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    fitVertical = false; fitPage(); goToPage(target)
                }
            }
        })
        mirror?.paneOpened(this)
    }

    /** Jump the viewport so page [p]'s top aligns near the top of the pane. */
    private fun goToPage(p: Int) {
        val target = p.coerceIn(0, finishedView.pages.size - 1)
        ty = dp(16).toFloat() - scale * finishedView.pageTop(target)
        clampTransform(); applyTransform()
    }

    /** Snapshot the current page onto the notebook so it persists (saved by the store / on pause). */
    fun syncLastPage() { if (::notebook.isInitialized && finishedView.height > 0) notebook.lastPage = currentPage() }

    /** The notebook currently shown in this pane (for session persistence). */
    fun notebookId(): String? = if (::notebook.isInitialized) notebook.id else null

    /** Ring the pane with an accent border when it's the focused (toolbar-targeted) pane. */
    fun setFocusedVisual(on: Boolean) {
        foreground = if (on) GradientDrawable().apply { setStroke(dp(2), AppTheme.accent); setColor(Color.TRANSPARENT) } else null
    }

    /** React to a shared-toolbar tool change (clear selection unless the SELECT tool is now active). */
    fun onToolChanged() {
        if (host.tool != Tool.SELECT) clearSelection()
        if (host.tool != Tool.ERASER) eraserOverlay.hide()
    }

    fun currentPage(): Int {
        val vh = finishedView.height.toFloat().coerceAtLeast(1f)
        val docYCenter = (vh / 2f - ty) / scale
        val unit = FinishedStrokesView.PAGE_H + FinishedStrokesView.GAP
        return floor(docYCenter / unit).toInt().coerceIn(0, finishedView.pages.size - 1)
    }
    fun pageCount(): Int = finishedView.pages.size

    // ---------- transform ----------
    private fun applyTransform() {
        if (::notebook.isInitialized && finishedView.height > 0) notebook.lastPage = currentPage()
        finishedView.setTransform(scale, tx, ty); host.onPageChanged(this); mirror?.transformed(this)
    }

    private fun clampTransform() {
        val vw = finishedView.width.toFloat(); val vh = finishedView.height.toFloat()
        if (vw <= 0f) return
        val pad = dp(28).toFloat()
        val docW = FinishedStrokesView.PAGE_W * scale
        val docH = finishedView.contentHeight() * scale
        tx = if (docW <= vw) (vw - docW) / 2f else tx.coerceIn(vw - docW - pad, pad)
        ty = if (docH <= vh) (vh - docH) / 2f else ty.coerceIn(vh - docH - pad, pad)
    }

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
    fun toggleFit() { fitVertical = !fitVertical; fitPage() }

    /** Re-center + fit this notebook to the pane's current size (after the pane is added/resized). */
    fun refit() { finishedView.post { fitVertical = false; fitPage() } }

    fun zoomBy(factor: Float) {
        val fx = finishedView.width / 2f; val fy = finishedView.height / 2f
        val ns = (scale * factor).coerceIn(0.2f, 6f)
        tx = fx - (fx - tx) * (ns / scale)
        ty = fy - (fy - ty) * (ns / scale)
        scale = ns
        clampTransform(); applyTransform()
    }

    fun scrollPage(delta: Int) {
        val target = (currentPage() + delta).coerceIn(0, finishedView.pages.size - 1)
        ty = dp(16).toFloat() - scale * finishedView.pageTop(target)
        clampTransform(); applyTransform()
    }

    private data class Hit(val page: Int, val x: Float, val y: Float, val onPage: Boolean)
    private fun hitTest(sx: Float, sy: Float): Hit {
        val docX = (sx - tx) / scale
        val docY = (sy - ty) / scale
        val unit = FinishedStrokesView.PAGE_H + FinishedStrokesView.GAP
        val p = floor(docY / unit).toInt().coerceIn(0, finishedView.pages.size - 1)
        val localY = docY - finishedView.pageTop(p)
        val onPage = docX in 0f..FinishedStrokesView.PAGE_W && localY in 0f..FinishedStrokesView.PAGE_H
        return Hit(p, docX, localY, onPage)
    }
    private fun screenX(x: Float) = tx + scale * x
    private fun screenY(page: Int, y: Float) = ty + scale * (finishedView.pageTop(page) + y)

    private fun pageUnitSize(hl: Boolean) = if (hl) host.brushSize * 3.2f else host.brushSize

    private fun freehandRec(points: List<PointF>, color: Int, width: Float, hl: Boolean, brush: Brush): FinishedStrokesView.Rec =
        FinishedStrokesView.Rec(listOf(FinishedStrokesView.buildPath(points)), points, color, width, hl, null, brush)

    private fun buildShapeRec(spec: ShapeSpec, color: Int, width: Float, hl: Boolean): FinishedStrokesView.Rec {
        val polys = spec.polylines()
        val paths = polys.map { FinishedStrokesView.buildStraightPath(it) }
        val pts = ArrayList<PointF>(); polys.forEach { pts.addAll(it) }
        return FinishedStrokesView.Rec(paths, pts, color, width, hl, spec)
    }

    /** Convert the captured screen samples to page-local points on the page the stroke started on. */
    private fun samplesToPage(): Pair<Int, ArrayList<PointF>>? {
        if (samples.isEmpty()) return null
        val start = hitTest(samples.first().x, samples.first().y)
        if (!start.onPage) return null
        val page = start.page
        val pts = ArrayList<PointF>(samples.size)
        for (s in samples) {
            val docX = (s.x - tx) / scale
            val docY = (s.y - ty) / scale
            pts.add(PointF(docX.coerceIn(0f, FinishedStrokesView.PAGE_W), (docY - finishedView.pageTop(page)).coerceIn(0f, FinishedStrokesView.PAGE_H)))
        }
        return page to pts
    }

    private fun commitSamples() {
        // With a leash, the head trails the pen — snap the final point to where the pen lifted so
        // the stroke ends exactly under the nib instead of short of it.
        if (leashPx() > 0.75f && smInit && (samples.isEmpty() || samples.last().x != ballX || samples.last().y != ballY))
            samples.add(Sample(ballX, ballY))
        val (page, pts) = samplesToPage() ?: return
        finishedView.pages[page].recs.add(freehandRec(pts, host.brushColor, pageUnitSize(currentHighlighter), currentHighlighter, currentBrush))
        finishedView.invalidate()
        savePage(page)
        mirror?.pageEdited(this, page)
    }

    /** Turn the just-drawn stroke into the armed shape, fitted to what you drew, then select it. */
    private fun commitPendingShape() {
        val type = host.pendingShape ?: return
        val (page, pts) = samplesToPage() ?: return
        if (pts.size < 2) return
        var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE; var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
        for (p in pts) { minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y) }
        if (hypot(maxX - minX, maxY - minY) < 14f) return // too small — likely a tap, ignore
        val a = pts.first(); val b = pts.last()
        val verts = when (type) {
            ShapeType.LINE, ShapeType.ARROW -> arrayListOf(PointF(a.x, a.y), PointF(b.x, b.y))
            ShapeType.RECT, ShapeType.ELLIPSE -> arrayListOf(PointF(minX, minY), PointF(maxX, maxY))
            ShapeType.TRIANGLE -> arrayListOf(PointF((minX + maxX) / 2f, minY), PointF(maxX, maxY), PointF(minX, maxY))
            ShapeType.AXES2D, ShapeType.AXES3D -> arrayListOf(PointF(a.x, a.y), PointF(b.x, b.y))
        }
        val rec = buildShapeRec(ShapeSpec(type, verts), host.brushColor, host.brushSize, false)
        finishedView.pages[page].recs.add(rec)
        host.onShapeCommitted()
        selPage = page; selRecs.clear(); selRecs.add(rec); selBox = recBounds(selRecs)
        refreshSelectionOverlay(); finishedView.invalidate(); savePage(page)
        mirror?.pageEdited(this, page)
    }

    // ---------- touch ----------
    private fun classify(event: MotionEvent, idx: Int): Mode {
        val type = event.getToolType(idx)
        val eraserBtn = (event.buttonState and (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_STYLUS_SECONDARY)) != 0
        return when {
            type == MotionEvent.TOOL_TYPE_FINGER -> if (host.tool == Tool.SELECT) Mode.SELECT else Mode.PAN
            type == MotionEvent.TOOL_TYPE_ERASER -> Mode.ERASE
            eraserBtn -> Mode.ERASE
            host.tool == Tool.ERASER -> Mode.ERASE
            host.tool == Tool.SELECT -> Mode.SELECT
            else -> Mode.DRAW
        }
    }

    private fun captureSamples(event: MotionEvent, idx: Int) {
        val hist = event.historySize
        for (h in 0 until hist) addSmoothed(event.getHistoricalX(idx, h), event.getHistoricalY(idx, h))
        addSmoothed(event.getX(idx), event.getY(idx))
    }

    private fun addSmoothed(rx: Float, ry: Float) {
        ballX = rx; ballY = ry
        if (!smInit) { headX = rx; headY = ry; smInit = true; samples.add(Sample(rx, ry)); return }
        val leash = leashPx()
        if (leash <= 0.75f) {
            // Smoothing off: light low-pass to shave hand jitter, still under the pen.
            headX += 0.6f * (rx - headX); headY += 0.6f * (ry - headY)
            samples.add(Sample(headX, headY)); return
        }
        // Pull the head toward the ball, stopping [leash] short of it.
        val dx = ballX - headX; val dy = ballY - headY
        val dist = hypot(dx, dy)
        if (dist > leash) {
            val t = (dist - leash) / dist
            headX += dx * t; headY += dy * t
            samples.add(Sample(headX, headY))
        }
    }

    private fun updateWet() {
        val wPx = pageUnitSize(currentHighlighter) * scale
        wetOverlay.setStroke(samples.map { PointF(it.x, it.y) }, host.brushColor, wPx, currentHighlighter, currentBrush)
        val showBall = leashPx() > 1f && samples.isNotEmpty()
        wetOverlay.setBall(ballX, ballY, headX, headY, (wPx / 2f).coerceAtLeast(dp(7).toFloat()), showBall)
        mirror?.let { m ->
            val conv = samplesToPage() ?: return@let
            m.wetStroke(this, conv.first, conv.second, host.brushColor, pageUnitSize(currentHighlighter), currentHighlighter)
        }
    }

    private fun handleTouch(event: MotionEvent): Boolean {
        if (event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER) scaleDetector.onTouchEvent(event)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                host.onPaneFocused(this)
                val idx = event.actionIndex
                activePointerId = event.getPointerId(idx)
                undoPushedThisGesture = false
                if (finishedView.addPageRectScreen()?.contains(event.getX(idx), event.getY(idx)) == true) {
                    addArmed = true; mode = Mode.NONE; lastPanX = event.getX(idx); lastPanY = event.getY(idx); return true
                }
                mode = classify(event, idx)
                when (mode) {
                    Mode.DRAW -> beginDraw(event, idx)
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
                if (addArmed) { if (hypot(event.getX(idx) - lastPanX, event.getY(idx) - lastPanY) > dp(12)) addArmed = false; return true }
                when (mode) {
                    Mode.DRAW -> { captureSamples(event, idx); updateWet() }
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
                if (addArmed) { addArmed = false; if (!cancel) addPage() }
                else when (mode) {
                    Mode.DRAW -> { if (!cancel) { if (host.pendingShape != null) commitPendingShape() else commitSamples() }; wetOverlay.clear(); samples.clear(); mirror?.wetCleared(this) }
                    Mode.ERASE -> if (dirtyErase) { dirtyErase = false; savePage(currentPage()) }
                    Mode.SELECT -> endSelect()
                    else -> {}
                }
                if (host.tool != Tool.ERASER) eraserOverlay.hide()
                mode = Mode.NONE; activePointerId = -1
                return true
            }
        }
        return false
    }

    private fun beginDraw(event: MotionEvent, idx: Int) {
        val h = hitTest(event.getX(idx), event.getY(idx))
        if (!h.onPage) { mode = Mode.NONE; return }
        clearSelection()
        pushUndo()
        currentHighlighter = host.tool == Tool.HIGHLIGHTER
        currentBrush = if (currentHighlighter) Brush.PEN else host.brush
        samples.clear(); smInit = false; captureSamples(event, idx); updateWet()
    }

    private fun eraseAt(sx: Float, sy: Float) {
        eraserOverlay.show(sx, sy, eraserRadius * scale)
        val h = hitTest(sx, sy)
        if (!dirtyErase) pushUndo()
        if (finishedView.eraseNear(h.page, h.x, h.y, eraserRadius)) { dirtyErase = true; mirror?.pageEdited(this, h.page) }
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
            val dcx = screenX(box.right) + 20f; val dcy = screenY(selPage, box.top) - 20f
            if (hypot(sx - dcx, sy - dcy) <= 26f) { deleteSelection(); return }
            if (selRecs.size == 1 && selRecs[0].shape != null) {
                val hs = selRecs[0].shape!!.handles
                for (i in hs.indices) if (hypot(sx - screenX(hs[i].x), sy - screenY(selPage, hs[i].y)) <= 30f) {
                    grab = Grab.VERTEX; grabVertex = i; pushUndo(); dragStartRecs = ArrayList(selRecs); return
                }
            }
            val corners = arrayOf(floatArrayOf(box.left, box.top), floatArrayOf(box.right, box.top), floatArrayOf(box.right, box.bottom), floatArrayOf(box.left, box.bottom))
            for (i in corners.indices) if (hypot(sx - screenX(corners[i][0]), sy - screenY(selPage, corners[i][1])) <= 30f) {
                grab = Grab.RESIZE; grabCorner = i; pushUndo()
                dragStartBox.set(box); dragStartRecs = ArrayList(selRecs)
                val h = hitTest(sx, sy); dragStartLocal.set(h.x, h.y); return
            }
            val h = hitTest(sx, sy)
            if (h.page == selPage && box.contains(h.x, h.y)) {
                grab = Grab.MOVE; pushUndo(); dragStartBox.set(box); dragStartRecs = ArrayList(selRecs); dragStartLocal.set(h.x, h.y); return
            }
        }
        clearSelection()
        grab = Grab.LASSO
        lassoScreen.clear(); lassoScreen.add(PointF(sx, sy)); finishedView.setLasso(lassoScreen)
    }

    private fun moveSelect(sx: Float, sy: Float) {
        when (grab) {
            Grab.LASSO -> { lassoScreen.add(PointF(sx, sy)); finishedView.setLasso(lassoScreen) }
            Grab.MOVE -> {
                val h = hitTest(sx, sy)
                applyMatrixToSelection(Matrix().apply { setTranslate(h.x - dragStartLocal.x, h.y - dragStartLocal.y) }); refreshSelectionOverlay()
            }
            Grab.RESIZE -> {
                val h = hitTest(sx, sy); val b = dragStartBox
                val ax = if (grabCorner == 0 || grabCorner == 3) b.right else b.left
                val ay = if (grabCorner == 0 || grabCorner == 1) b.bottom else b.top
                val startX = if (grabCorner == 0 || grabCorner == 3) b.left else b.right
                val startY = if (grabCorner == 0 || grabCorner == 1) b.top else b.bottom
                var sxf = if (abs(startX - ax) > 1f) (h.x - ax) / (startX - ax) else 1f
                var syf = if (abs(startY - ay) > 1f) (h.y - ay) / (startY - ay) else 1f
                sxf = sxf.coerceIn(0.05f, 20f); syf = syf.coerceIn(0.05f, 20f)
                applyMatrixToSelection(Matrix().apply { setTranslate(ax, ay); preScale(sxf, syf); preTranslate(-ax, -ay) }); refreshSelectionOverlay()
            }
            Grab.VERTEX -> {
                val h = hitTest(sx, sy); val base = dragStartRecs[0]; val spec = base.shape!!.clone()
                spec.verts[grabVertex].set(h.x.coerceIn(0f, FinishedStrokesView.PAGE_W), h.y.coerceIn(0f, FinishedStrokesView.PAGE_H))
                val newRec = buildShapeRec(spec, base.color, base.widthPx, base.highlighter)
                replaceRec(base, newRec); selRecs[0] = newRec; dragStartRecs[0] = newRec
                selBox = recBounds(selRecs); refreshSelectionOverlay()
            }
            else -> {}
        }
    }

    private fun endSelect() {
        when (grab) {
            Grab.LASSO -> finishLasso()
            Grab.MOVE, Grab.RESIZE, Grab.VERTEX -> { selBox = recBounds(selRecs); refreshSelectionOverlay(); if (selPage >= 0) { savePage(selPage); mirror?.pageEdited(this, selPage) } }
            else -> {}
        }
        grab = Grab.NONE
    }

    private fun finishLasso() {
        finishedView.setLasso(null)
        if (lassoScreen.size < 3) { tapSelectAt(lassoScreen.firstOrNull()); return }
        val page = hitTest(lassoScreen[0].x, lassoScreen[0].y).page
        val poly = ArrayList(lassoScreen.map { toLocalOn(it.x, it.y, page) })
        poly.add(PointF(poly[0].x, poly[0].y))   // close the loop so the ray-cast is watertight
        selRecs.clear()
        for (rec in finishedView.pages[page].recs) if (recInLasso(rec, poly)) selRecs.add(rec)
        if (selRecs.isEmpty()) { clearSelection(); return }
        selPage = page; selBox = recBounds(selRecs); refreshSelectionOverlay()
    }

    /**
     * A stroke is caught if it's fully enclosed, or ≥40% of its points are inside, or its centroid
     * is inside. The old rule ("more than half the points inside") routinely failed to grab long
     * handwriting strokes unless you drew a very generous loop — which is why the lasso felt broken.
     */
    private fun recInLasso(rec: FinishedStrokesView.Rec, poly: List<PointF>): Boolean {
        if (rec.points.isEmpty()) return false
        var inside = 0; var cx = 0f; var cy = 0f
        for (p in rec.points) { if (pointInPoly(p, poly)) inside++; cx += p.x; cy += p.y }
        val n = rec.points.size
        if (inside == n) return true
        if (inside.toFloat() / n >= 0.4f) return true
        return pointInPoly(PointF(cx / n, cy / n), poly)
    }

    /** A tap (not a drag) with the select tool grabs the single nearest stroke under the finger. */
    private fun tapSelectAt(pt: PointF?) {
        if (pt == null) { clearSelection(); return }
        val h = hitTest(pt.x, pt.y)
        if (!h.onPage) { clearSelection(); return }
        var best: FinishedStrokesView.Rec? = null; var bestD = 18f
        for (rec in finishedView.pages[h.page].recs) for (p in rec.points) {
            val d = hypot(p.x - h.x, p.y - h.y); if (d < bestD) { bestD = d; best = rec }
        }
        val picked = best ?: run { clearSelection(); return }
        selRecs.clear(); selRecs.add(picked); selPage = h.page; selBox = recBounds(selRecs); refreshSelectionOverlay()
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
        val f = FloatArray(2)
        for (k in dragStartRecs.indices) {
            val base = dragStartRecs[k]
            val newRec = if (base.shape != null) {
                val spec = base.shape.clone()
                for (v in spec.verts) { f[0] = v.x; f[1] = v.y; m.mapPoints(f); v.set(f[0], f[1]) }
                buildShapeRec(spec, base.color, base.widthPx, base.highlighter)
            } else {
                val np = base.points.map { f[0] = it.x; f[1] = it.y; m.mapPoints(f); PointF(f[0], f[1]) }
                freehandRec(np, base.color, base.widthPx, base.highlighter, base.brush)
            }
            replaceRec(selRecs[k], newRec); selRecs[k] = newRec
        }
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
        val page = selPage
        finishedView.pages[page].recs.removeAll(selRecs.toSet())
        clearSelection(); finishedView.invalidate(); savePage(page)
        mirror?.pageEdited(this, page)
    }

    // ---------- undo / redo ----------
    private fun snapshot(): List<List<FinishedStrokesView.Rec>> = finishedView.pages.map { ArrayList(it.recs) }
    private fun pushUndo() {
        if (undoPushedThisGesture) return
        undoStack.add(snapshot()); if (undoStack.size > 60) undoStack.removeAt(0); redoStack.clear(); undoPushedThisGesture = true
    }
    private fun restore(snap: List<List<FinishedStrokesView.Rec>>) {
        val pages = finishedView.pages
        for (i in pages.indices) { pages[i].recs.clear(); if (i < snap.size) pages[i].recs.addAll(snap[i]) }
        clearSelection(); finishedView.invalidate(); saveAllPages()
        mirror?.paneOpened(this)
    }
    fun undo() { if (undoStack.isEmpty()) return; redoStack.add(snapshot()); restore(undoStack.removeAt(undoStack.size - 1)) }
    fun redo() { if (redoStack.isEmpty()) return; undoStack.add(snapshot()); restore(redoStack.removeAt(redoStack.size - 1)) }

    // ---------- persistence ----------
    private fun saveMeta() { notebook.paper = finishedView.paperStyle.name; notebook.pageColor = finishedView.pageColor; store.save() }

    private fun savePage(index: Int) {
        if (index < 0 || index >= notebook.pageIds.size) return
        try {
            val arr = JSONArray()
            for (rec in finishedView.pages[index].recs) {
                val o = JSONObject().put("c", rec.color).put("w", rec.widthPx.toDouble()).put("h", rec.highlighter)
                if (rec.shape != null) {
                    o.put("k", "s").put("t", rec.shape.type.name)
                    val va = JSONArray(); for (v in rec.shape.verts) va.put(JSONArray().put(v.x.toDouble()).put(v.y.toDouble()))
                    o.put("v", va)
                } else {
                    o.put("k", "f")
                    if (rec.brush != Brush.PEN) o.put("b", rec.brush.name)
                    val pa = JSONArray(); for (p in rec.points) pa.put(JSONArray().put(p.x.toDouble()).put(p.y.toDouble()))
                    o.put("p", pa)
                }
                arr.put(o)
            }
            store.pageFile(notebook.pageIds[index]).writeText(JSONObject().put("strokes", arr).toString())
        } catch (e: Exception) { Log.e("Ink", "save page failed", e) }
        saveMeta()
    }

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
            val arr = JSONObject(f.readText()).optJSONArray("strokes") ?: return page
            for (k in 0 until arr.length()) {
                val o = arr.getJSONObject(k)
                val color = o.getInt("c")
                val width = if (o.has("w")) o.getDouble("w").toFloat() else o.optDouble("s", 6.0).toFloat()
                val hl = o.optBoolean("h", false)
                if (o.optString("k", "f") == "s") {
                    val type = runCatching { ShapeType.valueOf(o.getString("t")) }.getOrNull() ?: continue
                    val va = o.getJSONArray("v"); val verts = ArrayList<PointF>()
                    for (j in 0 until va.length()) { val p = va.getJSONArray(j); verts.add(PointF(p.getDouble(0).toFloat(), p.getDouble(1).toFloat())) }
                    if (verts.isNotEmpty()) page.recs.add(buildShapeRec(ShapeSpec(type, verts), color, width, hl))
                } else {
                    val pa = o.optJSONArray("p") ?: o.optJSONArray("i") // "i" = legacy [x,y,t,pr]
                    val pts = ArrayList<PointF>()
                    if (pa != null) for (j in 0 until pa.length()) { val p = pa.getJSONArray(j); pts.add(PointF(p.getDouble(0).toFloat(), p.getDouble(1).toFloat())) }
                    val brush = runCatching { Brush.valueOf(o.optString("b", "PEN")) }.getOrDefault(Brush.PEN)
                    if (pts.isNotEmpty()) page.recs.add(freehandRec(pts, color, width, hl, brush))
                }
            }
        } catch (e: Exception) { Log.e("Ink", "load page failed", e) }
        return page
    }

    fun addPage() {
        saveAllPages()
        store.addPage(notebook)
        undoStack.clear(); redoStack.clear()
        loadAllPages()
        finishedView.post {
            val last = finishedView.pages.size - 1
            ty = dp(16).toFloat() - scale * finishedView.pageTop(last)
            clampTransform(); applyTransform()
        }
        mirror?.paneOpened(this)
    }

    // ---------- PDF export ----------
    /** Render this notebook to a PDF in [cacheDir] and return the file (null on failure). */
    fun exportPdf(cacheDir: File): File? {
        saveAllPages()
        val doc = PdfDocument()
        val s = 0.75f
        val w = (FinishedStrokesView.PAGE_W * s).toInt(); val h = (FinishedStrokesView.PAGE_H * s).toInt()
        try {
            for (i in finishedView.pages.indices) {
                val info = PdfDocument.PageInfo.Builder(w, h, i + 1).create()
                val pg = doc.startPage(info)
                finishedView.renderPageInto(pg.canvas, i, s)
                doc.finishPage(pg)
            }
            val safe = notebook.title.replace(Regex("[^A-Za-z0-9 _-]"), "").trim().ifBlank { "Notebook" }
            val f = File(cacheDir, "$safe.pdf")
            FileOutputStream(f).use { doc.writeTo(it) }
            return f
        } catch (e: Exception) { Log.e("Ink", "pdf export failed", e); return null }
        finally { doc.close() }
    }
}
