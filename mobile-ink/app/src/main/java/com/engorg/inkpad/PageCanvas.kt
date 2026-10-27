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
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import android.view.HapticFeedbackConstants
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

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
        val eraserSize: Float  // eraser reach (radius), page units
        val pendingShape: ShapeType?
        val pendingShapeDashed: Boolean   // draw the armed shape with a dashed outline
        val pendingShapeHashed: Boolean   // tick marks on the armed axes shape
        val pendingTableRows: Int
        val pendingTableCols: Int
        val pendingTableBorder: Boolean
        val pendingSolid: SolidParams?   // what an armed SOLID will be
        val pendingSymbol: Sym?   // what an armed SYMBOL will be (stays armed: each tap drops another)
        fun onPaneFocused(pane: PageCanvas)
        fun onPageChanged(pane: PageCanvas)
        fun onShapeCommitted()
        /** Show the palette near pane-local ([x],[y]) and report the picked color. */
        fun pickColor(pane: PageCanvas, x: Float, y: Float, onPick: (Int) -> Unit)
        /** Open the 3D solid builder on [params] (with its paint and current view) and report the edited shape. */
        fun editSolid(params: SolidParams, fill: SolidFill, view: FloatArray, onApply: (SolidParams, SolidFill) -> Unit)
        /** Pick a fill color (with opacity) for a 2D shape; 0 = no fill. */
        fun editFill(color: Int, onApply: (Int) -> Unit)
    }

    /**
     * Optional live-mirror sink (Phase 3 desktop companion). Null = no mirroring, so all calls are
     * guarded and cost nothing when a pane isn't being mirrored.
     */
    interface MirrorSink {
        fun paneOpened(pane: PageCanvas)
        fun pageEdited(pane: PageCanvas, index: Int)
        /** The in-progress stroke grew by [pts] (page-local); [reset] = these replace what was sent (new / straightened stroke). */
        fun wetStroke(pane: PageCanvas, page: Int, pts: List<PointF>, reset: Boolean, color: Int, widthPx: Float, hl: Boolean)
        fun wetCleared(pane: PageCanvas)
        fun transformed(pane: PageCanvas)
    }
    var mirror: MirrorSink? = null

    val finishedView = FinishedStrokesView(context).apply {
        backdrop = AppTheme.bg; accent = AppTheme.accent; textColor = AppTheme.text; menuBg = AppTheme.elevated
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

    private val eraserRadius get() = host.eraserSize

    private class Sample(val x: Float, val y: Float)
    private val samples = ArrayList<Sample>()
    private var currentBrush = Brush.PEN

    // Draw-and-hold: finish a stroke, keep the pen still for a beat, and it snaps to a straight line
    // from where it started (then follows the pen as a rubber band, snapping level/plumb near 0°/90°).
    private var straightened = false
    private val holdAnchor = PointF()
    private val holdToStraight = Runnable { straightenStroke() }
    private val holdMs = 600L

    // Stroke stabilizer ("pulled string"): the raw pen position is the ball; the committed line's
    // head chases it, staying [leashPx] behind, so the line lags and smooths. leash grows with the
    // smoothing setting. At leash ~0 we fall back to a light low-pass that only shaves hand jitter.
    private var smInit = false
    private var headX = 0f   // committed line head (last emitted sample), screen space
    private var headY = 0f
    private var ballX = 0f   // raw pen position, screen space
    private var ballY = 0f
    // Gentle stabilizer: the whole slider spans a small leash. The user's sweet spot sat at ~3–10%
    // of the previous (4–6× stronger) scale, so this keeps that feel across the middle of the range.
    private fun leashPx(): Float = host.smoothing.coerceIn(0f, 1f) * 7f * resources.displayMetrics.density

    // Minimum on-screen spacing between captured stroke points. Stylus/touch panels report at
    // 120–360 Hz, so a slow, deliberate stroke otherwise piles up hundreds of near-coincident
    // points — and the wet stroke is rebuilt from ALL of them every single frame (they also bloat
    // the saved path, undo snapshots and every later redraw). That makes even a nearly-empty page
    // feel sluggish. Points closer than this add no visible detail, so we drop them on capture.
    private val minSampleStepPx get() = 0.75f * resources.displayMetrics.density

    /** Append a captured point only when it has moved a visible amount from the previous one. */
    private fun pushSample(x: Float, y: Float) {
        val last = samples.lastOrNull()
        if (last == null || hypot(x - last.x, y - last.y) >= minSampleStepPx) samples.add(Sample(x, y))
    }

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
    private enum class Grab { NONE, MOVE, RESIZE, VERTEX, LASSO, ROTATE, ORBIT }
    private var grab = Grab.NONE
    private val orbitStart = PointF()        // screen point an ORBIT drag began at
    private var moveStartPage = -1          // page the selection was on when the drag began
    private var rotCx = 0f; private var rotCy = 0f   // rotation center (page-local on selPage)
    private var rotStartAngle = 0f
    private var lastSelX = 0f; private var lastSelY = 0f   // latest select-drag point (for edge auto-scroll)
    private var autoScrolling = false
    // Long-press with the select tool (hold still ~1 s) pops the Cut/Copy/Paste menu right there.
    private val lpDown = PointF()
    private val longPress = Runnable { onSelectLongPress() }
    private var grabCorner = 0
    private var grabVertex = 0
    private val dragStartLocal = PointF()
    private val dragStartBox = RectF()
    private var dragStartRecs = ArrayList<FinishedStrokesView.Rec>()
    private val lassoScreen = ArrayList<PointF>()
    // What was selected before a lasso began — restored if that "lasso" turns out to be the first
    // finger of a pinch, so zooming never drops the selection.
    private var preLassoPage = -1
    private val preLassoRecs = ArrayList<FinishedStrokesView.Rec>()
    private var preLassoHadUi = false
    // The selection as it was when a move/resize/vertex drag began (for reverting on a pinch).
    private var gestureStartRecs = ArrayList<FinishedStrokesView.Rec>()

    private val undoStack = ArrayList<List<List<FinishedStrokesView.Rec>>>()
    private val redoStack = ArrayList<List<List<FinishedStrokesView.Rec>>>()

    lateinit var notebook: NotebookStore.Notebook
        private set

    companion object {
        /** In-app ink clipboard (page-local recs), shared by every pane so you can copy in one
         *  notebook and paste into the split-view one. Recs are immutable, so sharing is safe. */
        private val clipboard = ArrayList<FinishedStrokesView.Rec>()
    }

    init {
        scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: ScaleGestureDetector): Boolean { lastFocusX = d.focusX; lastFocusY = d.focusY; return true }
            override fun onScale(d: ScaleGestureDetector): Boolean {
                tx += d.focusX - lastFocusX; ty += d.focusY - lastFocusY
                lastFocusX = d.focusX; lastFocusY = d.focusY
                val ns = (scale * d.scaleFactor).coerceIn(0.2f, 12f)
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
        closeGraph()
        if (::notebook.isInitialized) { syncLastPage(); flushSaves() }   // persist the outgoing notebook before switching
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
        graphPane?.reposition()
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
        val ns = (scale * factor).coerceIn(0.2f, 12f)
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
        FinishedStrokesView.Rec(listOf(FinishedStrokesView.buildInkGeometry(points, width, brush, hl)), points, color, width, hl, null, brush)

    private fun buildShapeRec(spec: ShapeSpec, color: Int, width: Float, hl: Boolean): FinishedStrokesView.Rec {
        val parts = spec.parts()
        val paths = parts.filter { !it.fine && !it.hidden }.map { FinishedStrokesView.buildStraightPath(it.pts) }
        val fine = parts.filter { it.fine }.map { FinishedStrokesView.buildStraightPath(it.pts) }
        val hidden = parts.filter { it.hidden }.map { FinishedStrokesView.buildStraightPath(it.pts) }
        val pts = ArrayList<PointF>(); parts.forEach { pts.addAll(it.pts) }
        val fills = spec.fills().map { f ->
            val path = android.graphics.Path()
            for (poly in f.polys) if (poly.size >= 3) {
                path.moveTo(poly[0].x, poly[0].y); for (k in 1 until poly.size) path.lineTo(poly[k].x, poly[k].y); path.close()
            }
            FinishedStrokesView.FillPath(path, f.color, f.edge)
        }
        return FinishedStrokesView.Rec(paths, pts, color, width, hl, spec, Brush.PEN, fine, hidden, fills)
    }

    /** [base] rebuilt in [color] (geometry reused — recs are immutable). */
    private fun recolored(base: FinishedStrokesView.Rec, color: Int): FinishedStrokesView.Rec =
        FinishedStrokesView.Rec(base.paths, base.points, color, base.widthPx, base.highlighter, base.shape, base.brush, base.fine, base.hidden, base.fills)

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
        if (!straightened && leashPx() > 0.75f && smInit && (samples.isEmpty() || samples.last().x != ballX || samples.last().y != ballY))
            samples.add(Sample(ballX, ballY))
        val (page, pts) = samplesToPage() ?: return
        finishedView.pages[page].recs.add(freehandRec(pts, host.brushColor, pageUnitSize(currentHighlighter), currentHighlighter, currentBrush))
        finishedView.invalidate()
        savePage(page)
        mirror?.pageEdited(this, page)
    }

    /** Snap a page point to the nearest paper dot/grid crossing (none on plain paper). */
    private fun gridSnap(p: PointF): PointF =
        if (finishedView.paperStyle == FinishedStrokesView.PaperStyle.PLAIN) p else PointF(Symbols.snap(p.x), Symbols.snap(p.y))

    /**
     * Drop the armed symbol at its standard size, so every resistor/source on the page matches. A tap
     * places it there (an inline one horizontal); a drag lays an inline one along the stroke — ends on
     * the grid, near-square angles squared up — or fits a box one inside what you drew. The symbol stays
     * armed for the next tap; nothing is selected (switch to the lasso to move or turn one).
     */
    private fun commitSymbol(page: Int, pts: List<PointF>) {
        val sym = host.pendingSymbol ?: return
        var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE; var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
        for (p in pts) { minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y) }
        val tap = hypot(maxX - minX, maxY - minY) < 14f
        val a = pts.first(); val b = pts.last()
        val spec = if (sym.kind == SymKind.INLINE) {
            val std = ShapeSpec.symbolAt(sym, a.x, a.y)
            val span = std.verts[1].x - std.verts[0].x
            if (tap) {
                val s = gridSnap(std.verts[0])
                std.verts[0].set(s.x, s.y); std.verts[1].set(s.x + span, s.y); std
            } else {
                val p0 = gridSnap(a); val p1 = gridSnap(b)
                var dx = p1.x - p0.x; var dy = p1.y - p0.y
                val ang = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble()))
                val off = abs(ang - Math.round(ang / 90.0) * 90.0)
                if (off < 15.0) { if (abs(dx) > abs(dy)) dy = 0f else dx = 0f }
                var len = hypot(dx, dy)
                if (len < 1f) { dx = 1f; dy = 0f; len = 1f }
                // Too short a drag still gets room for the whole body, rounded up to whole grid squares.
                val need = (sym.w + 16f)
                val l = if (len >= need) len else Math.ceil((need / Symbols.GRID).toDouble()).toFloat() * Symbols.GRID
                std.verts[0].set(p0.x, p0.y); std.verts[1].set(p0.x + dx / len * l, p0.y + dy / len * l); std
            }
        } else {
            val k = if (tap) 1f else min((maxX - minX) / sym.w, (maxY - minY) / sym.h).coerceIn(0.25f, 12f)
            if (tap) {
                // The anchor (a terminal or a support's pin) lands on the dot nearest the tap.
                val s = gridSnap(PointF(a.x, a.y))
                ShapeSpec.symbolAt(sym, s.x - sym.ax, s.y - sym.ay)
            } else ShapeSpec.symbolAt(sym, (minX + maxX) / 2f, (minY + maxY) / 2f, k)
        }
        // Keep it on the page.
        var l = Float.MAX_VALUE; var t = Float.MAX_VALUE; var r = -Float.MAX_VALUE; var bt = -Float.MAX_VALUE
        for (v in spec.verts) { l = min(l, v.x); t = min(t, v.y); r = max(r, v.x); bt = max(bt, v.y) }
        val ox = if (l < 0f) -l else if (r > FinishedStrokesView.PAGE_W) FinishedStrokesView.PAGE_W - r else 0f
        val oy = if (t < 0f) -t else if (bt > FinishedStrokesView.PAGE_H) FinishedStrokesView.PAGE_H - bt else 0f
        if (ox != 0f || oy != 0f) for (v in spec.verts) v.offset(ox, oy)
        finishedView.pages[page].recs.add(buildShapeRec(spec, host.brushColor, host.brushSize, false))
        finishedView.invalidate(); savePage(page)
        mirror?.pageEdited(this, page)
    }

    /** Turn the just-drawn stroke into the armed shape, fitted to what you drew, then select it. */
    private fun commitPendingShape() {
        val type = host.pendingShape ?: return
        val (page, pts) = samplesToPage() ?: return
        if (pts.isEmpty()) return
        if (type == ShapeType.SYMBOL) { commitSymbol(page, pts); return }
        var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE; var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
        for (p in pts) { minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y) }
        if (hypot(maxX - minX, maxY - minY) < 14f) {
            // A tap. A table drops in at a default cell size there; any other shape needs a drag.
            if (type != ShapeType.TABLE) return
            val w = host.pendingTableCols * 110f; val h = host.pendingTableRows * 44f
            val l = (pts[0].x - w / 2f).coerceIn(0f, max(0f, FinishedStrokesView.PAGE_W - w))
            val t = (pts[0].y - h / 2f).coerceIn(0f, max(0f, FinishedStrokesView.PAGE_H - h))
            minX = l; minY = t; maxX = l + w; maxY = t + h
        }
        val a = pts.first(); val b = pts.last()
        val verts = when (type) {
            ShapeType.LINE, ShapeType.ARROW -> arrayListOf(PointF(a.x, a.y), PointF(b.x, b.y))
            ShapeType.RECT, ShapeType.ELLIPSE, ShapeType.TABLE -> arrayListOf(PointF(minX, minY), PointF(maxX, maxY))
            ShapeType.TRIANGLE -> arrayListOf(PointF((minX + maxX) / 2f, minY), PointF(maxX, maxY), PointF(minX, maxY))
            ShapeType.TRAPEZOID -> { val w = maxX - minX; arrayListOf(PointF(minX, maxY), PointF(maxX, maxY), PointF(maxX - w * 0.2f, minY), PointF(minX + w * 0.2f, minY)) }
            ShapeType.AXES2D, ShapeType.AXES3D, ShapeType.AXES3D_8 -> arrayListOf(PointF(a.x, a.y), PointF(b.x, b.y))
            // Partial-quadrant axes fit the box you drew: origin bottom-left (1Q) or mid-left (2Q).
            ShapeType.AXES2D_1Q -> arrayListOf(PointF(minX, maxY), PointF(maxX, minY))
            ShapeType.AXES2D_2Q -> arrayListOf(PointF(minX, (minY + maxY) / 2f), PointF(maxX, minY))
            ShapeType.SOLID, ShapeType.BOX, ShapeType.CYLINDER, ShapeType.CONE, ShapeType.SPHERE, ShapeType.PYRAMID,
            ShapeType.GRAPH, ShapeType.SYMBOL -> arrayListOf(PointF(minX, minY), PointF(maxX, maxY))
        }
        // A solid fills the box you drew, in its default three-quarter view.
        val spec = (if (type == ShapeType.SOLID) ShapeSpec.solidIn(host.pendingSolid ?: SolidParams.box(), minX, minY, maxX, maxY)
            else ShapeSpec(type, verts)).apply {
            dashed = host.pendingShapeDashed
            hashed = host.pendingShapeHashed
            if (type == ShapeType.TABLE) { rows = host.pendingTableRows; cols = host.pendingTableCols; border = host.pendingTableBorder }
        }
        val rec = buildShapeRec(spec, host.brushColor, host.brushSize, false)
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
            pushSample(headX, headY); return
        }
        // Pull the head toward the ball, stopping [leash] short of it.
        val dx = ballX - headX; val dy = ballY - headY
        val dist = hypot(dx, dy)
        if (dist > leash) {
            val t = (dist - leash) / dist
            headX += dx * t; headY += dy * t
            pushSample(headX, headY)
        }
    }

    private fun updateWet() {
        val wPx = pageUnitSize(currentHighlighter) * scale
        wetOverlay.setStroke(samples.map { PointF(it.x, it.y) }, host.brushColor, wPx, currentHighlighter, currentBrush)
        val showBall = leashPx() > 1f && samples.isNotEmpty() && !straightened
        wetOverlay.setBall(ballX, ballY, headX, headY, (wPx / 2f).coerceAtLeast(dp(7).toFloat()), showBall)
        mirror?.let { m ->
            // Only the samples added since the last send (converting the whole stroke on every move
            // made writing slow down as strokes grew). A shorter list means it was replaced: resend all.
            if (samples.isEmpty()) return@let
            val reset = samples.size < mirrorSent || straightened != mirrorStraight
            val from = if (reset) 0 else mirrorSent
            if (from >= samples.size) return@let
            val start = hitTest(samples.first().x, samples.first().y)
            if (!start.onPage) return@let
            val top = finishedView.pageTop(start.page)
            val pts = ArrayList<PointF>(samples.size - from)
            for (k in from until samples.size) {
                val s = samples[k]
                pts.add(PointF(((s.x - tx) / scale).coerceIn(0f, FinishedStrokesView.PAGE_W), ((s.y - ty) / scale - top).coerceIn(0f, FinishedStrokesView.PAGE_H)))
            }
            mirrorSent = samples.size; mirrorStraight = straightened
            m.wetStroke(this, start.page, pts, reset || from == 0, host.brushColor, pageUnitSize(currentHighlighter), currentHighlighter)
        }
    }
    private var mirrorSent = 0          // samples of the current stroke already handed to the mirror
    private var mirrorStraight = false

    /** Pen held still after a stroke: replace it with a straight line from its first point. */
    private fun straightenStroke() {
        if (mode != Mode.DRAW || straightened || host.pendingShape != null || samples.isEmpty()) return
        val s0 = samples.first()
        if (hypot(ballX - s0.x, ballY - s0.y) < dp(24)) return   // a dot / tiny tick — leave it be
        straightened = true
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        setStraightTo(ballX, ballY)
    }

    /** Rebuild the wet stroke as a straight line from its start to ([ex],[ey]), snapping level/plumb. */
    private fun setStraightTo(ex: Float, ey: Float) {
        val s0 = samples.firstOrNull() ?: return
        var x = ex; var y = ey
        val ang = Math.toDegrees(atan2(abs(y - s0.y).toDouble(), abs(x - s0.x).toDouble()))
        if (ang < 7.0) y = s0.y else if (ang > 83.0) x = s0.x
        val n = (hypot(x - s0.x, y - s0.y) / dp(4)).toInt().coerceIn(2, 400)
        samples.clear()
        for (i in 0..n) { val t = i / n.toFloat(); samples.add(Sample(s0.x + (x - s0.x) * t, s0.y + (y - s0.y) * t)) }
        ballX = x; ballY = y; headX = x; headY = y
        updateWet()
    }

    private fun handleTouch(event: MotionEvent): Boolean {
        if (event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER) scaleDetector.onTouchEvent(event)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                host.onPaneFocused(this)
                val idx = event.actionIndex
                activePointerId = event.getPointerId(idx)
                undoPushedThisGesture = false
                // Touching the page outside an open graph window puts it away (a finger tap does only that).
                if (graphPane != null) {
                    closeGraph()
                    if (event.getToolType(idx) == MotionEvent.TOOL_TYPE_FINGER) { mode = Mode.NONE; tapDown = null; return true }
                }
                // A graph card's Edit button (bottom left) opens it, whatever tool is in hand.
                run {
                    val h = hitTest(event.getX(idx), event.getY(idx))
                    if (!h.onPage) return@run
                    val g = finishedView.pages[h.page].recs.lastOrNull { r ->
                        r.shape?.type == ShapeType.GRAPH && graphBox(r)?.let { GraphCardRenderer.editButtonRect(it).contains(h.x, h.y) } == true
                    } ?: return@run
                    mode = Mode.NONE; activePointerId = -1; tapDown = null
                    openGraph(g, h.page)
                    return true
                }
                tapDown = if (event.getToolType(idx) == MotionEvent.TOOL_TYPE_FINGER) PointF(event.getX(idx), event.getY(idx)) else null
                tapDownAt = event.eventTime
                // The floating Cut/Copy/Paste menu wins over every tool (a shape just drawn with the
                // pen is selected too, so its menu must work without switching to the lasso).
                finishedView.menuActionAt(event.getX(idx), event.getY(idx))?.let { a ->
                    mode = Mode.NONE; runMenuAction(a, event.getX(idx), event.getY(idx)); return true
                }
                if (finishedView.addPageRectScreen()?.contains(event.getX(idx), event.getY(idx)) == true) {
                    addArmed = true; mode = Mode.NONE; lastPanX = event.getX(idx); lastPanY = event.getY(idx); return true
                }
                mode = classify(event, idx)
                when (mode) {
                    Mode.DRAW -> beginDraw(event, idx)
                    Mode.PAN -> { lastPanX = event.getX(idx); lastPanY = event.getY(idx) }
                    Mode.ERASE -> eraseAt(event.getX(idx), event.getY(idx))
                    Mode.SELECT -> {
                        beginSelect(event.getX(idx), event.getY(idx))
                        if (grab == Grab.LASSO || grab == Grab.MOVE) {
                            lpDown.set(event.getX(idx), event.getY(idx)); postDelayed(longPress, 1000L)
                        }
                    }
                    else -> {}
                }
                return true
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                removeCallbacks(longPress)
                // A second finger means pinch/pan. Undo whatever the first finger started (a lasso,
                // or nudging the selection) so zooming keeps the selection exactly as it was.
                addArmed = false
                // Finger + finger only — a palm landing mid stylus-lasso must not cancel it.
                val first = event.findPointerIndex(activePointerId)
                if (mode == Mode.SELECT && first >= 0 && event.getToolType(first) == MotionEvent.TOOL_TYPE_FINGER &&
                    event.getToolType(event.actionIndex) == MotionEvent.TOOL_TYPE_FINGER) {
                    abortSelectGesture(); mode = Mode.PAN
                }
                // Pan from where the fingers are now (the anchor may be stale from a select gesture).
                if (mode == Mode.PAN) panFocus(event).let { lastPanX = it.x; lastPanY = it.y }
                return true
            }
            MotionEvent.ACTION_POINTER_UP -> {
                // Keep panning with whichever finger is still down, from where it is now (no jump).
                if (mode != Mode.PAN) return true   // never hand a stylus stroke/lasso over to a palm
                val up = event.actionIndex
                if (event.getPointerId(up) == activePointerId) activePointerId = event.getPointerId(if (up == 0) 1 else 0)
                panFocus(event, up).let { lastPanX = it.x; lastPanY = it.y }
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (scaleDetector.isInProgress) {
                    // The pinch pans on its own; keep the anchor current so panning resumes without a jump.
                    if (mode == Mode.PAN) panFocus(event).let { lastPanX = it.x; lastPanY = it.y }
                    return true
                }
                val idx = event.findPointerIndex(activePointerId)
                if (idx < 0) return true
                if (addArmed) { if (hypot(event.getX(idx) - lastPanX, event.getY(idx) - lastPanY) > dp(12)) addArmed = false; return true }
                when (mode) {
                    Mode.DRAW -> {
                        if (straightened) setStraightTo(event.getX(idx), event.getY(idx))
                        else {
                            captureSamples(event, idx); updateWet()
                            // Re-arm the hold timer whenever the pen actually travels.
                            if (hypot(ballX - holdAnchor.x, ballY - holdAnchor.y) > dp(5)) {
                                holdAnchor.set(ballX, ballY)
                                removeCallbacks(holdToStraight); postDelayed(holdToStraight, holdMs)
                            }
                        }
                    }
                    Mode.PAN -> {
                        val f = panFocus(event); val x = f.x; val y = f.y
                        tx += x - lastPanX; ty += y - lastPanY
                        lastPanX = x; lastPanY = y
                        clampTransform(); applyTransform()
                    }
                    Mode.ERASE -> eraseAt(event.getX(idx), event.getY(idx))
                    Mode.SELECT -> {
                        // A finger waits a beat before it moves the selection or draws a lasso: a second
                        // finger landing then makes it a pan, with nothing to snap back.
                        if (event.getToolType(idx) == MotionEvent.TOOL_TYPE_FINGER && event.eventTime - tapDownAt < 120) return true
                        if (hypot(event.getX(idx) - lpDown.x, event.getY(idx) - lpDown.y) > dp(10)) removeCallbacks(longPress)
                        moveSelect(event.getX(idx), event.getY(idx))
                    }
                    else -> {}
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val cancel = event.actionMasked == MotionEvent.ACTION_CANCEL
                removeCallbacks(longPress); removeCallbacks(holdToStraight)
                // A quick finger tap (no drag) on a graph opens it in place.
                val td = tapDown; tapDown = null
                if (!cancel && td != null && mode == Mode.PAN && event.eventTime - tapDownAt < 350 &&
                    hypot(event.x - td.x, event.y - td.y) < dp(10)) {
                    val h = hitTest(td.x, td.y)
                    val g = if (h.onPage) finishedView.pages[h.page].recs.lastOrNull { it.shape?.type == ShapeType.GRAPH && recBounds(listOf(it))?.contains(h.x, h.y) == true } else null
                    if (g != null) { mode = Mode.NONE; activePointerId = -1; openGraph(g, h.page); return true }
                }
                if (addArmed) { addArmed = false; if (!cancel) addPage() }
                else when (mode) {
                    Mode.DRAW -> { if (!cancel) { if (host.pendingShape != null) commitPendingShape() else commitSamples() }; straightened = false; wetOverlay.clear(); samples.clear(); mirrorSent = 0; mirror?.wetCleared(this) }
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

    /** The center of the fingers on the glass (the pan anchor), leaving out pointer [skip] (one lifting). */
    private fun panFocus(event: MotionEvent, skip: Int = -1): PointF {
        var x = 0f; var y = 0f; var n = 0
        for (k in 0 until event.pointerCount) {
            if (k == skip || event.getToolType(k) != MotionEvent.TOOL_TYPE_FINGER) continue
            x += event.getX(k); y += event.getY(k); n++
        }
        if (n == 0) { val k = event.findPointerIndex(activePointerId).coerceAtLeast(0); return PointF(event.getX(k), event.getY(k)) }
        return PointF(x / n, y / n)
    }

    private fun beginDraw(event: MotionEvent, idx: Int) {
        val h = hitTest(event.getX(idx), event.getY(idx))
        if (!h.onPage) { mode = Mode.NONE; return }
        clearSelection()
        pushUndo()
        currentHighlighter = host.tool == Tool.HIGHLIGHTER
        currentBrush = if (currentHighlighter) Brush.PEN else host.brush
        straightened = false; holdAnchor.set(event.getX(idx), event.getY(idx))
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

    /** The lone selected table, if that's what's selected (enables the row/column menu). */
    private fun selectedTable(): FinishedStrokesView.Rec? =
        selRecs.singleOrNull()?.takeIf { it.shape?.type == ShapeType.TABLE }

    /** The lone selected closed 2D shape (enables Fill). */
    private fun selectedFillable(): FinishedStrokesView.Rec? =
        selRecs.singleOrNull()?.takeIf { r -> r.shape?.let { it.type.fillable && it.solid == null } == true }

    /** The lone selected graph card (enables Edit graph). */
    private fun selectedGraph(): FinishedStrokesView.Rec? =
        selRecs.singleOrNull()?.takeIf { r -> r.shape?.let { it.type == ShapeType.GRAPH && it.graph != null } == true }

    /** The lone selected 3D solid, if that's what's selected (enables the orbit knob + view menu). */
    private fun selectedSolid(): FinishedStrokesView.Rec? =
        selRecs.singleOrNull()?.takeIf { it.shape?.solid != null }

    private fun refreshSelectionOverlay() {
        val box = selBox
        if (box == null || selRecs.isEmpty()) { finishedView.clearSelection(); return }
        val handles = if (selRecs.size == 1 && selRecs[0].shape != null) selRecs[0].shape!!.handles else null
        val menu = ArrayList<FinishedStrokesView.MenuAction>()
        menu.add(FinishedStrokesView.MenuAction.CUT); menu.add(FinishedStrokesView.MenuAction.COPY)
        if (clipboard.isNotEmpty()) menu.add(FinishedStrokesView.MenuAction.PASTE)
        menu.add(FinishedStrokesView.MenuAction.DUPLICATE); menu.add(FinishedStrokesView.MenuAction.COLOR)
        menu.add(FinishedStrokesView.MenuAction.DELETE)
        val tableMenu = if (selectedTable() != null) listOf(
            FinishedStrokesView.MenuAction.ROW_ADD, FinishedStrokesView.MenuAction.ROW_DEL,
            FinishedStrokesView.MenuAction.COL_ADD, FinishedStrokesView.MenuAction.COL_DEL,
            FinishedStrokesView.MenuAction.BORDER,
        ) else if (selectedSolid() != null) listOf(
            FinishedStrokesView.MenuAction.VIEW_ISO, FinishedStrokesView.MenuAction.VIEW_FRONT,
            FinishedStrokesView.MenuAction.VIEW_TOP, FinishedStrokesView.MenuAction.VIEW_SIDE,
            FinishedStrokesView.MenuAction.SOLID_EDIT,
        ) else if (selectedGraph() != null) listOf(
            FinishedStrokesView.MenuAction.GRAPH_EDIT,
        ) else if (selectedFillable() != null) listOf(
            FinishedStrokesView.MenuAction.FILL,
        ) else emptyList()
        finishedView.setSelection(selPage, box, handles, menu, tableMenu, orbit = selectedSolid() != null)
    }

    /** Snapshot the selection so a move/resize/rotate/vertex drag can build from (and revert to) it. */
    private fun startGrab(g: Grab) {
        grab = g; pushUndo()
        dragStartBox.set(selBox!!); dragStartRecs = ArrayList(selRecs); gestureStartRecs = ArrayList(selRecs)
        moveStartPage = selPage
    }

    private fun beginSelect(sx: Float, sy: Float) {
        val rect = finishedView.selectionScreenRect()
        if (rect != null && selRecs.isNotEmpty()) {
            // Touch targets are in dp so they stay finger-sized on a high-density tablet.
            val handleR = dp(22).toFloat()
            finishedView.rotateHandleScreen()?.let { k ->
                if (hypot(sx - k.x, sy - k.y) <= handleR) {
                    startGrab(Grab.ROTATE)
                    rotCx = dragStartBox.centerX(); rotCy = dragStartBox.centerY()
                    val h = toLocalOn(sx, sy, selPage)
                    rotStartAngle = atan2(h.y - rotCy, h.x - rotCx)
                    return
                }
            }
            finishedView.orbitHandleScreen()?.let { k ->
                if (hypot(sx - k.x, sy - k.y) <= handleR) { startGrab(Grab.ORBIT); orbitStart.set(sx, sy); return }
            }
            if (selRecs.size == 1 && selRecs[0].shape != null) {
                val hs = selRecs[0].shape!!.handles
                for (i in hs.indices) if (hypot(sx - screenX(hs[i].x), sy - screenY(selPage, hs[i].y)) <= handleR) {
                    startGrab(Grab.VERTEX); grabVertex = i; return
                }
            }
            val corners = arrayOf(floatArrayOf(rect.left, rect.top), floatArrayOf(rect.right, rect.top), floatArrayOf(rect.right, rect.bottom), floatArrayOf(rect.left, rect.bottom))
            var bestCorner = -1; var bestD = handleR
            for (i in corners.indices) { val d = hypot(sx - corners[i][0], sy - corners[i][1]); if (d <= bestD) { bestD = d; bestCorner = i } }
            if (bestCorner >= 0) {
                startGrab(Grab.RESIZE); grabCorner = bestCorner
                val h = toLocalOn(sx, sy, selPage); dragStartLocal.set(h.x, h.y); return
            }
            // Anywhere in (or just around) the drawn box grabs the selection to move it.
            val slop = dp(20).toFloat()
            if (sx >= rect.left - slop && sx <= rect.right + slop && sy >= rect.top - slop && sy <= rect.bottom + slop) {
                startGrab(Grab.MOVE); lastSelX = sx; lastSelY = sy
                val h = toLocalOn(sx, sy, selPage); dragStartLocal.set(h.x, h.y); return
            }
        }
        preLassoPage = selPage; preLassoRecs.clear(); preLassoRecs.addAll(selRecs)
        preLassoHadUi = selRecs.isNotEmpty() || finishedView.pasteMenuShowing()
        clearSelection()
        grab = Grab.LASSO
        lassoScreen.clear(); lassoScreen.add(PointF(sx, sy)); finishedView.setLasso(lassoScreen)
    }

    /** A second finger landed: undo what the first finger started and put the selection back. */
    private fun abortSelectGesture() {
        when (grab) {
            Grab.LASSO -> {
                lassoScreen.clear(); finishedView.setLasso(null)
                if (preLassoRecs.isNotEmpty() && preLassoPage >= 0) {
                    selPage = preLassoPage; selRecs.clear(); selRecs.addAll(preLassoRecs)
                    selBox = recBounds(selRecs); refreshSelectionOverlay()
                }
            }
            Grab.MOVE, Grab.RESIZE, Grab.VERTEX, Grab.ROTATE, Grab.ORBIT -> revertGrab()
            else -> {}
        }
        grab = Grab.NONE
    }

    /** Put the selection back exactly as it was when the current drag began (and drop its undo step). */
    private fun revertGrab() {
        if (moveStartPage >= 0 && selPage != moveStartPage) transferSelection(moveStartPage)
        for (k in selRecs.indices) if (k < gestureStartRecs.size) { replaceRec(selRecs[k], gestureStartRecs[k]); selRecs[k] = gestureStartRecs[k] }
        selBox = recBounds(selRecs); refreshSelectionOverlay()
        if (undoPushedThisGesture && undoStack.isNotEmpty()) { undoStack.removeAt(undoStack.size - 1); undoPushedThisGesture = false }
    }

    private fun moveSelect(sx: Float, sy: Float) {
        when (grab) {
            Grab.LASSO -> { lassoScreen.add(PointF(sx, sy)); finishedView.setLasso(lassoScreen) }
            Grab.MOVE -> {
                lastSelX = sx; lastSelY = sy
                val h = toLocalOn(sx, sy, selPage)
                val dx = h.x - dragStartLocal.x; val dy = h.y - dragStartLocal.y
                applyMatrixToSelection(Matrix().apply { setTranslate(dx, dy) })
                selBox = RectF(dragStartBox).apply { offset(dx, dy) }
                // Carried past a page edge: hand the selection to the page its center is now over.
                val unit = FinishedStrokesView.PAGE_H + FinishedStrokesView.GAP
                val target = floor((finishedView.pageTop(selPage) + selBox!!.centerY()) / unit).toInt().coerceIn(0, finishedView.pages.size - 1)
                if (target != selPage) transferSelection(target)
                refreshSelectionOverlay()
                if (!autoScrolling && edgeScrollSpeed() != 0f) { autoScrolling = true; postOnAnimation(autoScroll) }
            }
            Grab.RESIZE -> {
                val h = toLocalOn(sx, sy, selPage); val b = dragStartBox
                val ax = if (grabCorner == 0 || grabCorner == 3) b.right else b.left
                val ay = if (grabCorner == 0 || grabCorner == 1) b.bottom else b.top
                // Scale relative to where the finger started (not the exact box corner) — the drawn
                // handle sits a little outside the strokes, so this avoids a jump on the first move.
                var sxf = if (abs(dragStartLocal.x - ax) > 1f) (h.x - ax) / (dragStartLocal.x - ax) else 1f
                var syf = if (abs(dragStartLocal.y - ay) > 1f) (h.y - ay) / (dragStartLocal.y - ay) else 1f
                sxf = sxf.coerceIn(0.05f, 20f); syf = syf.coerceIn(0.05f, 20f)
                applyMatrixToSelection(Matrix().apply { setTranslate(ax, ay); preScale(sxf, syf); preTranslate(-ax, -ay) }); refreshSelectionOverlay()
            }
            Grab.VERTEX -> {
                val h = toLocalOn(sx, sy, selPage); val base = dragStartRecs[0]; val spec = base.shape!!.clone()
                var hp = PointF(h.x.coerceIn(0f, FinishedStrokesView.PAGE_W), h.y.coerceIn(0f, FinishedStrokesView.PAGE_H))
                // A symbol's terminal clicks onto a nearby dot, so wires meet it cleanly.
                if (spec.type == ShapeType.SYMBOL) gridSnap(hp).let { if (hypot(it.x - hp.x, it.y - hp.y) < 8f) hp = it }
                spec.setHandle(grabVertex, hp.x, hp.y)
                val newRec = buildShapeRec(spec, base.color, base.widthPx, base.highlighter)
                replaceRec(base, newRec); selRecs[0] = newRec; dragStartRecs[0] = newRec
                selBox = recBounds(selRecs); refreshSelectionOverlay()
            }
            Grab.ROTATE -> {
                val h = toLocalOn(sx, sy, selPage)
                var deg = Math.toDegrees((atan2(h.y - rotCy, h.x - rotCx) - rotStartAngle).toDouble()).toFloat()
                // Gentle detents at every 45° so square-ups (90°, 180°…) are easy to hit.
                val snap = Math.round(deg / 45f) * 45f
                if (abs(deg - snap) < 4f) deg = snap
                applyRotationToSelection(deg)
                selBox = recBounds(selRecs); refreshSelectionOverlay()
            }
            Grab.ORBIT -> {
                // Trackball feel: drag sideways to spin it about the vertical, up/down to tip it.
                // ~180 dp of drag is a quarter turn.
                val perDp = 0.5f / resources.displayMetrics.density
                val base = dragStartRecs[0]; val spec = base.shape!!.clone()
                spec.solid!!.orbit(base.shape.solid!!.r, (sx - orbitStart.x) * perDp, (sy - orbitStart.y) * perDp)
                val newRec = buildShapeRec(spec, base.color, base.widthPx, base.highlighter)
                replaceRec(selRecs[0], newRec); selRecs[0] = newRec
                selBox = recBounds(selRecs); refreshSelectionOverlay()
            }
            else -> {}
        }
    }

    /** Scroll speed (px/frame) while a dragged selection is held near the pane's top/bottom edge. */
    private fun edgeScrollSpeed(): Float {
        if (grab != Grab.MOVE) return 0f
        val top = dp(100).toFloat(); val bottom = dp(64).toFloat(); val maxV = dp(16).toFloat()
        return when {
            lastSelY < top -> maxV * ((top - lastSelY) / top).coerceIn(0f, 1f)
            lastSelY > height - bottom -> -maxV * ((lastSelY - (height - bottom)) / bottom).coerceIn(0f, 1f)
            else -> 0f
        }
    }

    /** Keeps scrolling while the selection is held at an edge, so it can be carried to any page. */
    private val autoScroll = object : Runnable {
        override fun run() {
            val v = edgeScrollSpeed()
            if (v == 0f) { autoScrolling = false; return }
            val before = ty
            ty += v; clampTransform(); applyTransform()
            if (ty != before) moveSelect(lastSelX, lastSelY)   // keep the selection under the pen
            postOnAnimation(this)
        }
    }

    /** Move the selection (mid-drag) from its page onto page [to], keeping it where it is on screen. */
    private fun transferSelection(to: Int) {
        val from = selPage
        if (from < 0 || to == from) return
        val dy = finishedView.pageTop(from) - finishedView.pageTop(to)
        finishedView.pages[from].recs.removeAll(selRecs.toSet())
        val moved = selRecs.map { translatedCopy(it, 0f, dy) }
        finishedView.pages[to].recs.addAll(moved)
        selRecs.clear(); selRecs.addAll(moved)
        dragStartRecs = ArrayList(dragStartRecs.map { translatedCopy(it, 0f, dy) })
        dragStartBox.offset(0f, dy); dragStartLocal.offset(0f, dy); selBox?.offset(0f, dy)
        selPage = to
        finishedView.invalidate()
    }

    private fun endSelect() {
        when (grab) {
            Grab.LASSO -> finishLasso()
            Grab.MOVE, Grab.RESIZE, Grab.VERTEX, Grab.ROTATE, Grab.ORBIT -> {
                selBox = recBounds(selRecs); refreshSelectionOverlay()
                if (selPage >= 0) { savePage(selPage); mirror?.pageEdited(this, selPage) }
                if (moveStartPage >= 0 && moveStartPage != selPage) { savePage(moveStartPage); mirror?.pageEdited(this, moveStartPage) }
            }
            else -> {}
        }
        grab = Grab.NONE; moveStartPage = -1
    }

    /**
     * Held the select tool still for a second: pop the Cut/Copy/Paste menu right there. On ink it
     * selects the stroke under the tip; on empty paper it offers Paste; inside the current selection
     * it just cancels the (motionless) drag and leaves the selection's menu up.
     */
    private fun onSelectLongPress() {
        if (mode != Mode.SELECT) return
        when (grab) {
            Grab.MOVE -> { revertGrab(); grab = Grab.NONE; moveStartPage = -1 }
            Grab.LASSO -> {
                lassoScreen.clear(); finishedView.setLasso(null); grab = Grab.NONE
                val h = hitTest(lpDown.x, lpDown.y)
                if (!h.onPage) return
                val picked = nearestRecAt(h)
                if (picked != null) { selRecs.clear(); selRecs.add(picked); selPage = h.page; selBox = recBounds(selRecs); refreshSelectionOverlay() }
                else if (clipboard.isNotEmpty()) finishedView.showPasteMenu(h.page, h.x, h.y)
                else { Toast.makeText(context, "Nothing to paste", Toast.LENGTH_SHORT).show(); return }
            }
            else -> return
        }
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
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
     * A table needs most of itself enclosed: its centroid sits mid-grid, so lassoing writing in a
     * middle cell would otherwise drag the whole table along.
     */
    private fun recInLasso(rec: FinishedStrokesView.Rec, poly: List<PointF>): Boolean {
        if (rec.points.isEmpty()) return false
        var inside = 0; var cx = 0f; var cy = 0f
        for (p in rec.points) { if (pointInPoly(p, poly)) inside++; cx += p.x; cy += p.y }
        val n = rec.points.size
        if (rec.shape?.type == ShapeType.TABLE || rec.shape?.type == ShapeType.GRAPH) return inside.toFloat() / n >= 0.75f
        if (inside == n) return true
        if (inside.toFloat() / n >= 0.4f) return true
        return pointInPoly(PointF(cx / n, cy / n), poly)
    }

    /** The stroke nearest [h] within ~22dp on screen (never tighter than 18 page units), or null. */
    private fun nearestRecAt(h: Hit): FinishedStrokesView.Rec? {
        var best: FinishedStrokesView.Rec? = null; var bestD = max(18f, dp(22) / scale)
        for (rec in finishedView.pages[h.page].recs) for (p in rec.points) {
            val d = hypot(p.x - h.x, p.y - h.y); if (d < bestD) { bestD = d; best = rec }
        }
        if (best != null) return best
        // Nothing near the finger: a tap anywhere inside a graph card picks the card (topmost first).
        return finishedView.pages[h.page].recs.lastOrNull { rec ->
            rec.shape?.type == ShapeType.GRAPH && recBounds(listOf(rec))?.contains(h.x, h.y) == true
        }
    }

    /**
     * A tap (not a drag) with the select tool grabs the single nearest stroke under the finger.
     * Tapping empty paper first dismisses whatever was showing; a tap on empty paper with nothing
     * showing offers a Paste pill there when the clipboard has ink.
     */
    private fun tapSelectAt(pt: PointF?) {
        if (pt == null) { clearSelection(); return }
        val h = hitTest(pt.x, pt.y)
        if (!h.onPage) { clearSelection(); return }
        val picked = nearestRecAt(h) ?: run {
            clearSelection()
            if (!preLassoHadUi && clipboard.isNotEmpty()) finishedView.showPasteMenu(h.page, h.x, h.y)
            return
        }
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
                if (spec.rot != 0f) { f[0] = spec.pivot.x; f[1] = spec.pivot.y; m.mapPoints(f); spec.pivot.set(f[0], f[1]) }
                if (spec.solid != null) {
                    val mv = FloatArray(9); m.getValues(mv)
                    spec.scaleSolid(sqrt(abs(mv[Matrix.MSCALE_X] * mv[Matrix.MSCALE_Y] - mv[Matrix.MSKEW_X] * mv[Matrix.MSKEW_Y])))
                }
                if (spec.symbol?.kind == SymKind.INLINE) {
                    val mv = FloatArray(9); m.getValues(mv)
                    spec.scaleSymbol(sqrt(abs(mv[Matrix.MSCALE_X] * mv[Matrix.MSCALE_Y] - mv[Matrix.MSKEW_X] * mv[Matrix.MSKEW_Y])))
                }
                buildShapeRec(spec, base.color, base.widthPx, base.highlighter)
            } else {
                val np = base.points.map { f[0] = it.x; f[1] = it.y; m.mapPoints(f); PointF(f[0], f[1]) }
                freehandRec(np, base.color, base.widthPx, base.highlighter, base.brush)
            }
            replaceRec(selRecs[k], newRec); selRecs[k] = newRec
        }
    }

    /** Rotate the drag-start selection by [deg] about the rotation center (shapes keep exact geometry). */
    private fun applyRotationToSelection(deg: Float) {
        val m = Matrix().apply { setRotate(deg, rotCx, rotCy) }
        val f = FloatArray(2)
        for (k in dragStartRecs.indices) {
            val base = dragStartRecs[k]
            val newRec = if (base.shape != null) {
                val spec = base.shape.clone(); spec.rotateBy(deg, rotCx, rotCy)
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

    private fun runMenuAction(a: FinishedStrokesView.MenuAction, x: Float, y: Float) {
        when (a) {
            FinishedStrokesView.MenuAction.CUT -> { copySelection("Cut"); deleteSelection() }
            FinishedStrokesView.MenuAction.COPY -> { copySelection("Copied"); refreshSelectionOverlay() }   // menu now offers Paste
            FinishedStrokesView.MenuAction.PASTE -> {
                val box = selBox
                if (box != null && selPage >= 0) pasteAt(selPage, box.centerX() + 24f, box.centerY() + 24f)   // beside the selection
                else finishedView.pasteMenuAnchor()?.let { (p, pt) -> pasteAt(p, pt.x, pt.y) }
            }
            FinishedStrokesView.MenuAction.DUPLICATE -> duplicateSelection()
            FinishedStrokesView.MenuAction.COLOR -> host.pickColor(this, x, y + dp(26)) { c -> recolorSelection(c) }
            FinishedStrokesView.MenuAction.DELETE -> deleteSelection()
            FinishedStrokesView.MenuAction.ROW_ADD, FinishedStrokesView.MenuAction.ROW_DEL,
            FinishedStrokesView.MenuAction.COL_ADD, FinishedStrokesView.MenuAction.COL_DEL,
            FinishedStrokesView.MenuAction.BORDER -> editTable(a)
            FinishedStrokesView.MenuAction.VIEW_ISO -> editSolid { it.solid!!.setView(Solid.isoView()) }
            FinishedStrokesView.MenuAction.VIEW_FRONT -> editSolid { it.solid!!.setView(Solid.frontView()) }
            FinishedStrokesView.MenuAction.VIEW_TOP -> editSolid { it.solid!!.setView(Solid.topView()) }
            FinishedStrokesView.MenuAction.VIEW_SIDE -> editSolid { it.solid!!.setView(Solid.sideView()) }
            FinishedStrokesView.MenuAction.GRAPH_EDIT -> {
                val rec = selectedGraph() ?: return
                val page = selPage
                clearSelection()
                openGraph(rec, page)
            }
            FinishedStrokesView.MenuAction.SOLID_EDIT -> {
                val rec = selectedSolid() ?: return
                val sol = rec.shape!!.solid!!
                host.editSolid(sol.params.copy(), sol.fill.copy(), sol.r.copyOf()) { p, f ->
                    if (selectedSolid() === rec) editSolid { s -> p.copyInto(s.solid!!.params); s.solid!!.fill = f }
                }
            }
            FinishedStrokesView.MenuAction.FILL -> {
                val rec = selectedFillable() ?: return
                host.editFill(rec.shape!!.fillColor) { c ->
                    if (selectedFillable() !== rec) return@editFill
                    val spec = rec.shape!!.clone(); spec.fillColor = c
                    undoPushedThisGesture = false; pushUndo()
                    val n = buildShapeRec(spec, rec.color, rec.widthPx, rec.highlighter)
                    replaceRec(rec, n); selRecs[0] = n
                    selBox = recBounds(selRecs); refreshSelectionOverlay(); savePage(selPage)
                    mirror?.pageEdited(this, selPage)
                }
            }
        }
    }

    /** Change the lone selected graph card in place (as one undo step). */
    private fun editGraphCard(change: (ShapeSpec) -> Unit) {
        val rec = selectedGraph() ?: return
        val spec = rec.shape!!.clone(); change(spec)
        undoPushedThisGesture = false; pushUndo()
        val n = buildShapeRec(spec, rec.color, rec.widthPx, rec.highlighter)
        replaceRec(rec, n); selRecs[0] = n
        selBox = recBounds(selRecs); refreshSelectionOverlay(); savePage(selPage)
        mirror?.pageEdited(this, selPage)
    }

    /**
     * Drop a live graph card ([w]×[h] page units) onto the page in view, centered on what's visible
     * (shrunk to fit the page if needed). It lands selected so it can be moved or resized right away.
     */
    fun insertGraphCard(card: GraphCard, w: Float, h: Float) {
        if (finishedView.pages.isEmpty()) return
        val page = currentPage()
        val pw = FinishedStrokesView.PAGE_W; val ph = FinishedStrokesView.PAGE_H
        val k = min(1f, min(pw * 0.92f / w, ph * 0.92f / h))
        val bw = w * k; val bh = h * k
        val vw = finishedView.width.toFloat(); val vh = finishedView.height.toFloat()
        val cx = ((vw / 2f - tx) / scale).coerceIn(bw / 2f, pw - bw / 2f)
        val cy = ((vh / 2f - ty) / scale - finishedView.pageTop(page)).coerceIn(bh / 2f, ph - bh / 2f)
        val spec = ShapeSpec(ShapeType.GRAPH, arrayListOf(PointF(cx - bw / 2f, cy - bh / 2f), PointF(cx + bw / 2f, cy + bh / 2f)))
        spec.graph = card
        undoPushedThisGesture = false; pushUndo()
        placeAndSelect(page, listOf(buildShapeRec(spec, Color.GRAY, 1f, false)))
    }

    // ---------- graphs that live on the page ----------
    private var graphPane: GraphPane? = null
    private var graphRec: FinishedStrokesView.Rec? = null
    private var graphPage = -1
    private var graphUndoPushed = false
    private var deleteRec: FinishedStrokesView.Rec? = null   // the graph a pane was showing when it closed
    private var deletePage = -1
    private var tapDown: PointF? = null
    private var tapDownAt = 0L

    /**
     * The graph button: a new graph on the page in view, open and ready to type. It's sized to what's
     * on screen (at most 600×330 page units), so zoomed in it still fits with room around it.
     */
    fun spawnGraph() {
        if (finishedView.pages.isEmpty()) return
        closeGraph(); clearSelection()
        val page = currentPage()
        val pw = FinishedStrokesView.PAGE_W; val ph = FinishedStrokesView.PAGE_H
        val vw = finishedView.width.toFloat(); val vh = finishedView.height.toFloat()
        val k = min(1f, min(vw / scale * 0.8f / 600f, vh / scale * 0.5f / 330f))
        val w = 600f * k; val h = 330f * k
        val headerU = dp(48) / scale   // the graph window's toolbar sits above the card
        val cx = ((vw / 2f - tx) / scale).coerceIn(w / 2f, pw - w / 2f)
        val cy = ((vh / 2f - ty) / scale - finishedView.pageTop(page)).coerceIn(min(h / 2f + headerU, ph - h / 2f), ph - h / 2f)
        val spec = ShapeSpec(ShapeType.GRAPH, arrayListOf(PointF(cx - w / 2f, cy - h / 2f), PointF(cx + w / 2f, cy + h / 2f)))
        spec.graph = GraphCard(false, listOf(GraphRow("", Color.rgb(0xC7, 0x44, 0x40))), false, 0.0, 0.0, 20.0,
            Graph3DView.DEFAULT_YAW, Graph3DView.DEFAULT_PITCH, Graph3DView.DEFAULT_RANGE, true)
        undoPushedThisGesture = false; pushUndo()
        val rec = buildShapeRec(spec, Color.GRAY, 1f, false)
        finishedView.pages[page].recs.add(rec)
        finishedView.invalidate(); savePage(page)
        mirror?.pageEdited(this, page)
        graphUndoPushed = true
        openGraph(rec, page)
    }

    private fun graphBox(rec: FinishedStrokesView.Rec): RectF? {
        val s = rec.shape ?: return null
        val a = s.verts[0]; val b = s.verts[1]
        return RectF(min(a.x, b.x), min(a.y, b.y), max(a.x, b.x), max(a.y, b.y))
    }

    /** Open a page graph for editing right where it is. */
    private fun openGraph(rec: FinishedStrokesView.Rec, page: Int) {
        val card = rec.shape?.graph ?: return
        val box = graphBox(rec) ?: return
        closeGraph()
        graphRec = rec; graphPage = page
        val act = context as? android.app.Activity ?: return
        val pc = finishedView.pageColor
        val dark = (0.299 * Color.red(pc) + 0.587 * Color.green(pc) + 0.114 * Color.blue(pc)) / 255.0 < 0.5
        val pane = GraphPane(act, this, object : GraphPane.Callbacks {
            override fun screenRect(): RectF? {
                val r = graphRec ?: return null
                val b = graphBox(r) ?: return null
                val top = finishedView.pageTop(graphPage)
                return RectF(tx + scale * b.left, ty + scale * (top + b.top), tx + scale * b.right, ty + scale * (top + b.bottom))
            }
            override fun pageScale() = scale
            override fun commit(card: GraphCard) = replaceGraph { it.graph = card }
            override fun moveBy(dx: Float, dy: Float, done: Boolean) {
                if (dx != 0f || dy != 0f) replaceGraph(save = false) { s ->
                    val b = graphBox(graphRec!!)!!
                    val ddx = dx.coerceIn(-b.left, FinishedStrokesView.PAGE_W - b.right)
                    val ddy = dy.coerceIn(-b.top, FinishedStrokesView.PAGE_H - b.bottom)
                    s.verts.forEach { v -> v.offset(ddx, ddy) }; s.pivot.offset(ddx, ddy)
                }
                if (done) { savePage(graphPage); mirror?.pageEdited(this@PageCanvas, graphPage) }
            }
            override fun resizeTo(w: Float, h: Float, done: Boolean) {
                replaceGraph(save = done) { s ->
                    val a = s.verts[0]; val b = s.verts[1]
                    val l = min(a.x, b.x); val t = min(a.y, b.y)
                    a.set(l, t); b.set(min(l + w, FinishedStrokesView.PAGE_W), min(t + h, FinishedStrokesView.PAGE_H))
                }
            }
            override fun resizeFromTopLeft(w: Float, h: Float, done: Boolean) {
                replaceGraph(save = done) { s ->
                    val a = s.verts[0]; val b = s.verts[1]
                    val r = max(a.x, b.x); val bt = max(a.y, b.y)
                    a.set(max(0f, r - w), max(0f, bt - h)); b.set(r, bt)
                }
            }
            override fun insertInk(ink: List<GraphInk>, w: Float, h: Float) = insertGraph(ink, w, h)
            override fun closed() { deleteRec = graphRec; deletePage = graphPage; graphPane = null; graphRec = null; graphPage = -1; graphUndoPushed = false; finishedView.invalidate() }
            override fun delete() {
                // closed() already ran, so remove the rec the pane was editing (one undo step).
                val page = deletePage; val r = deleteRec ?: return
                if (page < 0 || page >= finishedView.pages.size) return
                undoPushedThisGesture = false; pushUndo()
                finishedView.pages[page].recs.remove(r)
                finishedView.invalidate(); savePage(page)
                mirror?.pageEdited(this@PageCanvas, page)
                Toast.makeText(context, "Graph deleted — Undo brings it back", Toast.LENGTH_SHORT).show()
            }
        })
        graphPane = pane
        pane.open(card, box.width(), box.height(), dark)
    }

    /** Put the open graph away (saving it). */
    fun closeGraph() { graphPane?.close() }

    /** Rebuild the open graph's rec with a change to its shape (one undo step per editing session). */
    private fun replaceGraph(save: Boolean = true, change: (ShapeSpec) -> Unit) {
        val rec = graphRec ?: return
        val page = graphPage
        if (page < 0 || page >= finishedView.pages.size) return
        val recs = finishedView.pages[page].recs
        val i = recs.indexOf(rec)
        if (i < 0) return
        if (!graphUndoPushed) { undoPushedThisGesture = false; pushUndo(); graphUndoPushed = true }
        val spec = rec.shape!!.clone(); change(spec)
        val n = buildShapeRec(spec, rec.color, rec.widthPx, rec.highlighter)
        recs[i] = n; graphRec = n
        finishedView.invalidate()
        if (save) { savePage(page); mirror?.pageEdited(this, page) }
    }

    /** Change the lone selected solid in place (as one undo step), keeping its center. */
    private fun editSolid(change: (ShapeSpec) -> Unit) {
        val rec = selectedSolid() ?: return
        val spec = rec.shape!!.clone(); change(spec)
        undoPushedThisGesture = false; pushUndo()   // a menu tap is its own gesture
        val n = buildShapeRec(spec, rec.color, rec.widthPx, rec.highlighter)
        replaceRec(rec, n); selRecs[0] = n
        selBox = recBounds(selRecs); refreshSelectionOverlay(); savePage(selPage)
        mirror?.pageEdited(this, selPage)
    }

    /** Repaint every selected stroke/shape in [color] (keeps it selected). */
    private fun recolorSelection(color: Int) {
        if (selRecs.isEmpty() || selPage < 0) return
        undoPushedThisGesture = false; pushUndo()   // the palette tap is its own gesture
        for (k in selRecs.indices) { val n = recolored(selRecs[k], color); replaceRec(selRecs[k], n); selRecs[k] = n }
        refreshSelectionOverlay(); savePage(selPage)
        mirror?.pageEdited(this, selPage)
    }

    /**
     * Grow/shrink the selected table by one row (at the bottom) or column (at the right), keeping
     * the cell size so ink already written in the cells stays lined up — or toggle its outer border.
     */
    private fun editTable(a: FinishedStrokesView.MenuAction) {
        val rec = selectedTable() ?: return
        val spec = rec.shape!!.clone()
        val v0 = spec.verts[0]; val v1 = spec.verts[1]
        val bottom = if (v0.y >= v1.y) v0 else v1
        val right = if (v0.x >= v1.x) v0 else v1
        val cellH = abs(v1.y - v0.y) / spec.rows
        val cellW = abs(v1.x - v0.x) / spec.cols
        // A borderless table needs at least one inner line, or there'd be nothing to see or grab.
        fun visible(r: Int, c: Int, b: Boolean) = b || r + c >= 3
        when (a) {
            FinishedStrokesView.MenuAction.ROW_ADD -> { if (spec.rows >= 40) return; spec.rows++; bottom.y += cellH }
            FinishedStrokesView.MenuAction.ROW_DEL -> { if (spec.rows <= 1 || !visible(spec.rows - 1, spec.cols, spec.border)) return; spec.rows--; bottom.y -= cellH }
            FinishedStrokesView.MenuAction.COL_ADD -> { if (spec.cols >= 40) return; spec.cols++; right.x += cellW }
            FinishedStrokesView.MenuAction.COL_DEL -> { if (spec.cols <= 1 || !visible(spec.rows, spec.cols - 1, spec.border)) return; spec.cols--; right.x -= cellW }
            FinishedStrokesView.MenuAction.BORDER -> {
                if (!visible(spec.rows, spec.cols, !spec.border)) { Toast.makeText(context, "Add a row or column first", Toast.LENGTH_SHORT).show(); return }
                spec.border = !spec.border
            }
            else -> return
        }
        pushUndo()
        val n = buildShapeRec(spec, rec.color, rec.widthPx, rec.highlighter)
        replaceRec(rec, n); selRecs[0] = n
        selBox = recBounds(selRecs); refreshSelectionOverlay(); savePage(selPage)
        mirror?.pageEdited(this, selPage)
    }

    private fun copySelection(verb: String) {
        if (selRecs.isEmpty()) return
        clipboard.clear(); clipboard.addAll(selRecs)
        val n = selRecs.size
        Toast.makeText(context, if (n == 1) verb else "$verb $n items", Toast.LENGTH_SHORT).show()
    }

    /** Clone of [base] shifted by ([dx],[dy]) page units. */
    private fun translatedCopy(base: FinishedStrokesView.Rec, dx: Float, dy: Float): FinishedStrokesView.Rec =
        if (base.shape != null) {
            val spec = base.shape.clone()
            for (v in spec.verts) v.set(v.x + dx, v.y + dy)
            spec.pivot.offset(dx, dy)
            buildShapeRec(spec, base.color, base.widthPx, base.highlighter)
        } else {
            freehandRec(base.points.map { PointF(it.x + dx, it.y + dy) }, base.color, base.widthPx, base.highlighter, base.brush)
        }

    /** Add [copies] to [page] and make them the selection so they can be dragged straight away. */
    private fun placeAndSelect(page: Int, copies: List<FinishedStrokesView.Rec>) {
        finishedView.pages[page].recs.addAll(copies)
        finishedView.clearSelection()
        selPage = page; selRecs.clear(); selRecs.addAll(copies)
        selBox = recBounds(selRecs); refreshSelectionOverlay()
        finishedView.invalidate(); savePage(page)
        mirror?.pageEdited(this, page)
    }

    /**
     * Drop a graph exported by the grapher ([GraphInk] strokes in a [w]×[h] box, y down) onto the
     * page in view, centered on what's visible, as ordinary ink + line/ellipse/rect shapes. It
     * lands selected (undoable as one step) so it can be dragged or resized straight away.
     */
    fun insertGraph(items: List<GraphInk>, w: Float, h: Float) {
        if (finishedView.pages.isEmpty() || items.isEmpty()) return
        val page = currentPage()
        val pw = FinishedStrokesView.PAGE_W; val ph = FinishedStrokesView.PAGE_H
        // Shrink to fit the page if needed.
        val k = min(1f, min(pw * 0.92f / w, ph * 0.92f / h))
        val bw = w * k; val bh = h * k
        val vw = finishedView.width.toFloat(); val vh = finishedView.height.toFloat()
        val cx = ((vw / 2f - tx) / scale).coerceIn(bw / 2f, pw - bw / 2f)
        val cy = ((vh / 2f - ty) / scale - finishedView.pageTop(page)).coerceIn(bh / 2f, ph - bh / 2f)
        val ox = cx - bw / 2f; val oy = cy - bh / 2f
        val pc = finishedView.pageColor
        val lum = (0.299 * Color.red(pc) + 0.587 * Color.green(pc) + 0.114 * Color.blue(pc)) / 255.0
        val axis = if (lum < 0.5) Color.rgb(0xE5, 0xE7, 0xEB) else Color.rgb(0x2B, 0x30, 0x3A)
        fun map(p: PointF) = PointF(ox + p.x * k, oy + p.y * k)
        val recs = ArrayList<FinishedStrokesView.Rec>()
        for (it in items) {
            if (it.pts.isEmpty()) continue
            val color = if (it.color == GraphInk.AXIS) axis else it.color
            val width = it.width * k.coerceAtLeast(0.6f)
            when (it.kind) {
                GraphInk.FREE -> recs.add(freehandRec(it.pts.map(::map), color, width, false, Brush.PEN))
                GraphInk.LINE, GraphInk.RECT, GraphInk.DOT -> {
                    if (it.pts.size < 2) continue
                    val type = when (it.kind) { GraphInk.LINE -> ShapeType.LINE; GraphInk.RECT -> ShapeType.RECT; else -> ShapeType.ELLIPSE }
                    val spec = ShapeSpec(type, arrayListOf(map(it.pts[0]), map(it.pts[1])))
                    recs.add(buildShapeRec(spec, color, width, false))
                }
            }
        }
        if (recs.isEmpty()) return
        undoPushedThisGesture = false; pushUndo()
        placeAndSelect(page, recs)
    }

    /** Paste the clipboard centered on page-local ([cx],[cy]), nudged so it stays on the page. */
    private fun pasteAt(page: Int, cx: Float, cy: Float) {
        val b = recBounds(clipboard) ?: return
        if (page < 0 || page >= finishedView.pages.size) return
        pushUndo()
        fun fit(want: Float, lo: Float, hi: Float) = if (lo > hi) lo else want.coerceIn(lo, hi)
        val dx = fit(cx - b.centerX(), -b.left, FinishedStrokesView.PAGE_W - b.right)
        val dy = fit(cy - b.centerY(), -b.top, FinishedStrokesView.PAGE_H - b.bottom)
        placeAndSelect(page, clipboard.map { translatedCopy(it, dx, dy) })
    }

    private fun deleteSelection() {
        if (selRecs.isEmpty() || selPage < 0) return
        if (graphRec != null && selRecs.contains(graphRec)) closeGraph()
        pushUndo()
        val page = selPage
        finishedView.pages[page].recs.removeAll(selRecs.toSet())
        clearSelection(); finishedView.invalidate(); savePage(page)
        mirror?.pageEdited(this, page)
    }

    /**
     * Copy the current selection: clone each selected rec, nudge the copies down-right by a small
     * offset (flipped away from an edge so they stay on-page), append them to the page, then select
     * the copies so they can be dragged straight away.
     */
    private fun duplicateSelection() {
        val box = selBox ?: return
        if (selRecs.isEmpty() || selPage < 0) return
        pushUndo()
        val off = 24f
        val dx = if (box.right + off <= FinishedStrokesView.PAGE_W) off else -off
        val dy = if (box.bottom + off <= FinishedStrokesView.PAGE_H) off else -off
        placeAndSelect(selPage, selRecs.map { translatedCopy(it, dx, dy) })
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
    fun undo() { closeGraph(); if (undoStack.isEmpty()) return; redoStack.add(snapshot()); restore(undoStack.removeAt(undoStack.size - 1)) }
    fun redo() { closeGraph(); if (redoStack.isEmpty()) return; undoStack.add(snapshot()); restore(redoStack.removeAt(redoStack.size - 1)) }

    // ---------- persistence ----------
    // Page writes happen OFF the UI thread and coalesce. Serializing a whole page to JSON and
    // writing it to disk on every pen-up used to block the UI thread, so each stroke appeared a
    // beat late and quick consecutive strokes queued their delays up. Now a stroke just snapshots
    // its page (cheap, on the UI thread) and hands it to a single background writer; a burst of
    // strokes collapses into one write of the newest content (see the pending map below).
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val pendingPages = ConcurrentHashMap<String, List<FinishedStrokesView.Rec>>()

    private fun saveMeta() { notebook.paper = finishedView.paperStyle.name; notebook.pageColor = finishedView.pageColor; store.save() }

    /** Serialize a page's recs to the on-disk JSON string. Pure — safe to run on the writer thread. */
    private fun serializeRecs(recs: List<FinishedStrokesView.Rec>): String {
        val arr = JSONArray()
        for (rec in recs) {
            val o = JSONObject().put("c", rec.color).put("w", rec.widthPx.toDouble()).put("h", rec.highlighter)
            if (rec.shape != null) {
                o.put("k", "s").put("t", rec.shape.type.name)
                if (rec.shape.dashed) o.put("d", true)
                if (!rec.shape.hashed) o.put("nh", true)
                if (rec.shape.type == ShapeType.TABLE) o.put("tr", rec.shape.rows).put("tc", rec.shape.cols).put("tb", rec.shape.border)
                if (rec.shape.rot != 0f) o.put("r", rec.shape.rot.toDouble()).put("pv", JSONArray().put(rec.shape.pivot.x.toDouble()).put(rec.shape.pivot.y.toDouble()))
                rec.shape.solid?.let { o.put("sd", it.params.toJson()).put("sr", Solid.rToJson(it.r)).put("sz", it.size.toDouble()) }
                rec.shape.graph?.let { o.put("g", it.toJson()) }
                if (rec.shape.fillColor != 0) o.put("fc", rec.shape.fillColor)
                rec.shape.symbol?.let { o.put("sy", it.name); if (rec.shape.symScale != 1f) o.put("ss", rec.shape.symScale.toDouble()) }
                rec.shape.solid?.fill?.takeIf { !it.isEmpty }?.let { o.put("sf", it.toJson()) }
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
        return JSONObject().put("strokes", arr).toString()
    }

    /** Queue a page write on the background writer, coalescing bursts to the newest snapshot. */
    private fun savePage(index: Int) {
        if (index < 0 || index >= notebook.pageIds.size) return
        val pageId = notebook.pageIds[index]
        // Snapshot the rec list on the UI thread (a reference copy — recs are immutable once made),
        // so the writer thread never reads a list that a later stroke is mutating.
        pendingPages[pageId] = ArrayList(finishedView.pages[index].recs)   // newest snapshot wins
        if (ioExecutor.isShutdown) return
        try {
            ioExecutor.execute {
                val recs = pendingPages.remove(pageId) ?: return@execute    // a newer save already handled it
                try { store.pageFile(pageId).writeText(serializeRecs(recs)) }
                catch (e: Exception) { Log.e("Ink", "save page failed", e) }
            }
        } catch (_: Exception) { }   // executor shutting down mid-save — flushSaves() will catch it
    }

    /** Block until every queued page write has hit disk (durability points: reload, pause, close). */
    fun flushSaves() {
        graphPane?.commitNow()
        if (ioExecutor.isShutdown) return
        val latch = CountDownLatch(1)
        try { ioExecutor.execute { latch.countDown() } } catch (_: Exception) { return }
        try { latch.await(3, TimeUnit.SECONDS) } catch (_: InterruptedException) {}
    }

    /** Flush pending writes then stop the writer (call when the pane/activity goes away). */
    fun dispose() { closeGraph(); flushSaves(); ioExecutor.shutdown() }

    private fun saveAllPages() {
        for (i in notebook.pageIds.indices) savePage(i)
        saveMeta()
        flushSaves()   // structural checkpoint (add page / undo / export): make the batch durable now
    }

    private fun loadAllPages() {
        val pages = ArrayList<FinishedStrokesView.Page>()
        for (pid in notebook.pageIds) pages.add(loadPage(pid))
        if (pages.isEmpty()) pages.add(FinishedStrokesView.Page())
        finishedView.pages = pages
    }

    private fun loadPage(pageId: String): FinishedStrokesView.Page {
        val page = FinishedStrokesView.Page(bgFile = store.pageBgFile(pageId).takeIf { it.exists() })
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
                    val dashed = o.optBoolean("d", false)
                    val va = o.getJSONArray("v"); val verts = ArrayList<PointF>()
                    for (j in 0 until va.length()) { val p = va.getJSONArray(j); verts.add(PointF(p.getDouble(0).toFloat(), p.getDouble(1).toFloat())) }
                    if (verts.size < type.vertCount) continue
                    // v1.5.5 fixed-angle solids come back as turnable SOLIDs covering the same spot.
                    val spec = (ShapeSpec.legacySolid(type, verts) ?: ShapeSpec(type, verts)).apply {
                        this.dashed = dashed
                        if (type == ShapeType.SOLID) o.optJSONObject("sd")?.let { sd ->
                            solid = Solid(SolidParams.fromJson(sd), Solid.rFromJson(o.optJSONArray("sr")), o.optDouble("sz", 50.0).toFloat().coerceIn(2f, 4000f), SolidFill.fromJson(o.optJSONObject("sf")))
                        }
                        hashed = !o.optBoolean("nh", false)
                        rows = o.optInt("tr", 3).coerceIn(1, 40); cols = o.optInt("tc", 3).coerceIn(1, 40); border = o.optBoolean("tb", true)
                        rot = o.optDouble("r", 0.0).toFloat()
                        o.optJSONArray("pv")?.let { pivot.set(it.getDouble(0).toFloat(), it.getDouble(1).toFloat()) }
                        if (type == ShapeType.GRAPH) graph = GraphCard.fromJson(o.optJSONObject("g"))
                        fillColor = o.optInt("fc", 0)
                        if (type == ShapeType.SYMBOL) {
                            symbol = runCatching { Sym.valueOf(o.optString("sy")) }.getOrNull()
                            symScale = o.optDouble("ss", 1.0).toFloat().coerceIn(0.2f, 20f)
                        }
                    }
                    if (spec.type == ShapeType.SOLID && spec.solid == null) continue
                    if (spec.type == ShapeType.GRAPH && spec.graph == null) continue
                    if (spec.type == ShapeType.SYMBOL && spec.symbol == null) continue
                    page.recs.add(buildShapeRec(spec, color, width, hl))
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
    fun exportPdf(cacheDir: File, only: Int? = null): File? {
        saveAllPages()
        val doc = PdfDocument()
        val s = 0.75f
        val w = (FinishedStrokesView.PAGE_W * s).toInt(); val h = (FinishedStrokesView.PAGE_H * s).toInt()
        try {
            val which = if (only != null && only in finishedView.pages.indices) listOf(only) else finishedView.pages.indices.toList()
            for ((n, i) in which.withIndex()) {
                val info = PdfDocument.PageInfo.Builder(w, h, n + 1).create()
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
