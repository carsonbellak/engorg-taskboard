package com.engorg.inkpad

import android.app.Dialog
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.FileProvider
import java.io.File
import java.net.URL
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Multi-pane handwriting shell. Hosts 1–4 [PageCanvas] editing surfaces side by side (each a full
 * notebook viewport — same or different notebooks) with draggable dividers, and drives them all from
 * one shared floating toolbar. Tool/brush state lives here and is read by whichever pane you touch;
 * toolbar buttons (undo, zoom, add page, email…) act on the currently focused pane.
 *
 * All drawing stays in plain Canvas inside PageCanvas — no native ink renderer.
 */
class InkActivity : ComponentActivity() {

    private lateinit var store: NotebookStore
    private lateinit var panesRow: LinearLayout
    private val panes = ArrayList<PageCanvas>()
    private val paneChips = HashMap<PageCanvas, View>()
    private val paneTitles = HashMap<PageCanvas, TextView>()
    private var focused: PageCanvas? = null

    // Shared pen/tool state, read live by every pane through [hostImpl].
    private var tool = Tool.PEN
    private var brushColor = Color.rgb(0x16, 0x1A, 0x22)
    private var brushSize = 2f
    private var brush = Brush.PEN
    private var smoothing = 0.3f    // 0 = off, 1 = max; the slider spans a deliberately gentle range
    private var pendingShape: ShapeType? = null

    private lateinit var colorButton: Button
    private var shapeButton: ImageButton? = null
    private var brushButton: ImageButton? = null
    private var pageLabel: TextView? = null
    private var mirrorButton: ImageButton? = null
    private val toolButtons = HashMap<Tool, ImageButton>()

    // Brush width in page units. The size slider maps GEOMETRICALLY across [minBrush, maxBrush] so
    // equal slider travel is an equal ratio change — fine steps where handwriting lives, thick end
    // still reachable. minBrush goes to a true hairline so a ~1px line is easy to dial in.
    private val minBrush = 0.8f
    private val maxBrush = 40f
    private val brushSteps = 100
    private fun brushForProgress(p: Int): Float = minBrush * (maxBrush / minBrush).pow(p / brushSteps.toFloat())
    private fun progressForBrush(w: Float): Int =
        (brushSteps * (ln(w / minBrush) / ln(maxBrush / minBrush))).roundToInt().coerceIn(0, brushSteps)

    private val accent get() = AppTheme.accent
    private val light get() = AppTheme.elevated
    private val onSurface get() = AppTheme.text

    private val palette = intArrayOf(
        Color.rgb(0x16, 0x1A, 0x22), Color.rgb(0x45, 0x4B, 0x55), Color.rgb(0x8A, 0x92, 0x9E), Color.rgb(0xEC, 0xEC, 0xEC), Color.WHITE,
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0xAC, 0xC1), Color.rgb(0x00, 0x89, 0x7B), Color.rgb(0x2E, 0x7D, 0x32),
        Color.rgb(0x7C, 0xB3, 0x42), Color.rgb(0xF9, 0xA8, 0x25), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0x6D, 0x4C, 0x41), Color.rgb(0xB7, 0x1C, 0x1C),
        Color.rgb(0xDC, 0x26, 0x50), Color.rgb(0xE9, 0x1E, 0x63), Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0xFF, 0xEB, 0x3B),
    )

    // Supplies the shared pen/tool to each pane and receives focus/page/shape callbacks from them.
    private val hostImpl = object : PageCanvas.Host {
        override val tool get() = this@InkActivity.tool
        override val brushColor get() = this@InkActivity.brushColor
        override val brushSize get() = this@InkActivity.brushSize
        override val brush get() = this@InkActivity.brush
        override val smoothing get() = this@InkActivity.smoothing
        override val pendingShape get() = this@InkActivity.pendingShape
        override fun onPaneFocused(pane: PageCanvas) { setFocused(pane) }
        override fun onPageChanged(pane: PageCanvas) { if (pane === focused) updatePageLabel() }
        override fun onShapeCommitted() { clearPendingShape(); this@InkActivity.tool = Tool.SELECT; updateTools() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppTheme.load(this)
        SystemBars.setup(this, lightBackground = !AppTheme.dark)

        // Restore the last-used pen so the stroke weight + color + brush you settled on stick between sessions.
        val ip = getSharedPreferences(INK_PREFS, MODE_PRIVATE)
        brushSize = ip.getFloat("brushSize", brushSize).coerceIn(minBrush, maxBrush)
        brushColor = ip.getInt("brushColor", brushColor)
        smoothing = ip.getFloat("smoothing", smoothing).coerceIn(0f, 1f)
        brush = runCatching { Brush.valueOf(ip.getString("brush", "PEN") ?: "PEN") }.getOrDefault(Brush.PEN)

        store = NotebookStore(filesDir)

        // Accept a list of notebook ids (split view) or a single id (classic open), else the default.
        val ids: List<String?> = intent.getStringArrayListExtra(EXTRA_NOTEBOOK_IDS)
            ?: intent.getStringExtra(EXTRA_NOTEBOOK_ID)?.let { listOf(it) }
            ?: listOf(null)
        val n = ids.size.coerceIn(1, 4)

        panesRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for (i in 0 until n) panes.add(makePane(ids.getOrNull(i)))

        val toolbar = buildToolbar()
        val root = FrameLayout(this).apply {
            setBackgroundColor(AppTheme.bg)
            addView(panesRow, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(toolbar, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
                gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; topMargin = dp(10)
            })
        }
        setContentView(root)
        // Keep the floating toolbar clear of the status bar (clock / battery / notifications).
        SystemBars.marginTopBelowStatusBar(toolbar, dp(10))

        rebuildPanesRow()
        panes.firstOrNull()?.let { setFocused(it) }
        updateTools()

        // Reflect the mirror's connection state on the cast button (survives library <-> notebook).
        MirrorManager.onState = { on, _ -> runOnUiThread { updateMirrorButton(on) } }
        updateMirrorButton(MirrorManager.connected)
    }

    override fun onPause() {
        super.onPause()
        if (!::store.isInitialized) return
        // Remember where each pane was left (page + the split composition) so reopening restores it.
        panes.forEach { it.syncLastPage() }
        panes.forEach { it.flushSaves() }   // ensure queued background page writes are durable before we background
        store.save()
        InkSettings.saveLastSession(this, panes.mapNotNull { it.notebookId() })
    }

    override fun onDestroy() {
        MirrorManager.onState = null
        MirrorManager.bind(null)   // keep the socket alive but stop feeding a destroyed pane
        panes.forEach { it.dispose() }   // flush + stop each pane's background writer
        super.onDestroy()
    }

    private fun updateMirrorButton(on: Boolean) {
        val b = mirrorButton ?: return
        b.background = pill(if (on) accent else light)
        b.setColorFilter(if (on) AppTheme.onAccent() else onSurface)
    }

    // ---------- panes / focus ----------
    private fun setFocused(pane: PageCanvas) {
        focused = pane
        val multi = panes.size > 1
        panes.forEach { it.setFocusedVisual(multi && it === pane) }
        MirrorManager.bind(pane)   // stream the focused pane if a desktop mirror is connected
        updatePageLabel()
    }

    // ---------- dynamic split panes (add/close/swap from within a notebook) ----------
    private fun makePane(id: String?): PageCanvas {
        val pane = PageCanvas(this, store, hostImpl)
        // Open (which sets pane.notebook) BEFORE building the chip — the chip reads
        // pane.notebook.title, and notebook is a lateinit, so building it first crashes
        // the whole notebook open with UninitializedPropertyAccessException.
        pane.open(id)
        val chip = buildPaneChip(pane)
        pane.addView(chip, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
            gravity = Gravity.TOP or Gravity.START; leftMargin = dp(10); topMargin = dp(72)
        })
        // The floating toolbar owns the top strip (it sits just below the status bar). Drop the
        // pane's title/close chip beneath it so it no longer lines up with — and on inner panes
        // tucks under — the hotbar; there's ample canvas room lower down. Under edge-to-edge this
        // also folds in the real status-bar inset so the chip never hides behind the clock.
        SystemBars.marginTopBelowStatusBar(chip, dp(72))
        paneChips[pane] = chip
        return pane
    }

    /** Re-tile the row from the current [panes] list (equal widths) with dividers between. */
    private fun rebuildPanesRow() {
        panesRow.removeAllViews()
        for (i in panes.indices) {
            panesRow.addView(panes[i], LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
            if (i < panes.size - 1) panesRow.addView(makeDivider(panesRow), LinearLayout.LayoutParams(dp(6), MATCH_PARENT))
        }
        refreshChrome()
        panes.forEach { it.refit() }
    }

    private fun addPane(id: String?) {
        if (panes.size >= 4) { Toast.makeText(this, "Up to 4 notebooks side by side.", Toast.LENGTH_SHORT).show(); return }
        val pane = makePane(id)
        panes.add(pane)
        rebuildPanesRow()
        setFocused(pane)
    }

    private fun removePane(pane: PageCanvas) {
        if (panes.size <= 1) return
        panes.remove(pane); paneChips.remove(pane); paneTitles.remove(pane)
        pane.dispose()   // flush + stop the closed pane's background writer
        rebuildPanesRow()
        setFocused(if (focused === pane) panes.first() else (focused ?: panes.first()))
    }

    /** Show pane title chips only in split mode; keep their titles fresh after a swap. */
    private fun refreshChrome() {
        val multi = panes.size > 1
        for (p in panes) {
            paneChips[p]?.visibility = if (multi) View.VISIBLE else View.GONE
            if (::panesRow.isInitialized) paneTitles[p]?.text = p.notebook.title
        }
    }

    private fun buildPaneChip(pane: PageCanvas): View {
        val muted = Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            visibility = View.GONE
            background = GradientDrawable().apply {
                cornerRadius = dp(15).toFloat()
                setColor(Color.argb(0xF0, Color.red(AppTheme.surface), Color.green(AppTheme.surface), Color.blue(AppTheme.surface)))
                setStroke(dp(1), Color.argb(0x2A, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            elevation = dp(6).toFloat(); setPadding(dp(11), dp(5), dp(5), dp(5))
        }
        val title = TextView(this).apply {
            text = pane.notebook.title; setTextColor(onSurface); textSize = 12.5f
            maxLines = 1; maxWidth = dp(150); ellipsize = android.text.TextUtils.TruncateAt.END
            setOnClickListener { notebookPickerPopup(this, pane) { id -> pane.open(id); refreshChrome(); setFocused(pane) } }
        }
        paneTitles[pane] = title
        row.addView(title)
        row.addView(ImageButton(this).apply {
            setImageBitmap(Icons.bitmap(Icons.CLOSE, dp(15))); setColorFilter(muted)
            background = pill(light); scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
            val pd = dp(4); setPadding(pd, pd, pd, pd)
            layoutParams = LinearLayout.LayoutParams(dp(26), dp(26)).apply { leftMargin = dp(6) }
            setOnClickListener { removePane(pane) }
        })
        return row
    }

    private fun showAddPane(anchor: View) {
        if (panes.size >= 4) { Toast.makeText(this, "Up to 4 notebooks side by side.", Toast.LENGTH_SHORT).show(); return }
        notebookPickerPopup(anchor, null) { id -> addPane(id) }
    }

    /**
     * A folder-navigable dropdown of notebooks. Sub-folders are browsable (drill in / step back up);
     * within a folder, notebooks are listed **most-recently-edited first** (with a recency chip) so
     * the one you're after is usually right at the top. Reused for add-pane + swap.
     */
    private fun notebookPickerPopup(anchor: View, current: PageCanvas?, onPick: (String) -> Unit) {
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(8), dp(8), dp(8), dp(8)) }
        val container = android.widget.ScrollView(this).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x30, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            addView(list)
        }
        val popup = PopupWindow(container, dp(264), dp(420), true).apply { elevation = dp(12).toFloat() }
        val curId = current?.notebook?.id
        // Start where the swapped notebook lives (its folder) so its siblings are right there; the
        // add-pane case (no current notebook) starts at the top level.
        var browseFolder: String? = current?.notebook?.folderId

        lateinit var rebuild: () -> Unit
        rebuild = {
            list.removeAllViews()
            // Step-up row when we're inside a folder (shows the folder we're in; tap to leave it).
            browseFolder?.let { id -> store.folders.find { it.id == id } }?.let { folder ->
                list.addView(upPickRow(folder.name) { browseFolder = folder.parentId; rebuild() })
            }
            // Sub-folders (A→Z), then notebooks (most-recently-edited first).
            for (fo in store.foldersIn(browseFolder).sortedBy { it.name.lowercase() })
                list.addView(folderPickRow(fo) { browseFolder = fo.id; rebuild() })
            for ((nb, mod) in store.notebooksIn(browseFolder).map { it to store.lastModified(it) }.sortedByDescending { it.second })
                list.addView(pickRow(nb, mod, nb.id == curId) { popup.dismiss(); onPick(nb.id) })
            popup.height = (dp(50) * list.childCount + dp(16)).coerceIn(dp(60), dp(420))
            if (popup.isShowing) popup.update(dp(264), popup.height)
        }
        rebuild()
        popup.showAsDropDown(anchor, 0, dp(6))
    }

    /** "Leave this folder" row (back chevron + the current folder's name). */
    private fun upPickRow(folderName: String, onClick: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(AppTheme.elevated) }
            setPadding(dp(8), dp(9), dp(12), dp(9))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) }
            addView(ImageView(this@InkActivity).apply {
                setImageBitmap(Icons.bitmap(Icons.BACK, dp(16))); setColorFilter(onSurface)
                layoutParams = LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(8) }
            })
            addView(TextView(this@InkActivity).apply {
                text = folderName; textSize = 14f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(AppTheme.text); setTypeface(null, android.graphics.Typeface.BOLD)
            })
            setOnClickListener { onClick() }
        }

    /** A folder row (folder icon + name + child count + chevron); tap to drill in. */
    private fun folderPickRow(fo: NotebookStore.Folder, onClick: () -> Unit): View =
        LinearLayout(this).apply {
            val muted = Color.argb(0xA0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(AppTheme.elevated) }
            setPadding(dp(10), dp(9), dp(12), dp(9))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) }
            addView(ImageView(this@InkActivity).apply {
                setImageBitmap(Icons.bitmap(Icons.FOLDER, dp(16))); setColorFilter(AppTheme.accent)
                layoutParams = LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(10) }
            })
            addView(TextView(this@InkActivity).apply {
                text = fo.name; textSize = 14f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(AppTheme.text)
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(TextView(this@InkActivity).apply {
                text = (store.foldersIn(fo.id).size + store.notebooksIn(fo.id).size).toString()
                textSize = 12f; setTextColor(muted)
            })
            addView(ImageView(this@InkActivity).apply {
                setImageBitmap(Icons.bitmap(Icons.NEXT, dp(14))); setColorFilter(muted)
                layoutParams = LinearLayout.LayoutParams(dp(16), dp(16)).apply { leftMargin = dp(6) }
            })
            setOnClickListener { onClick() }
        }

    /** Compact relative age ("now", "5m", "3h", "2d", "4w") for the recency chip. */
    private fun relTime(ts: Long): String {
        val d = System.currentTimeMillis() - ts
        return when {
            d < 60_000L -> "now"
            d < 3_600_000L -> "${d / 60_000L}m"
            d < 86_400_000L -> "${d / 3_600_000L}h"
            d < 604_800_000L -> "${d / 86_400_000L}d"
            else -> "${d / 604_800_000L}w"
        }
    }

    private fun pickRow(nb: NotebookStore.Notebook, modifiedTs: Long, selected: Boolean, onClick: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(10).toFloat(); setColor(if (selected) AppTheme.accent else AppTheme.elevated) }
            setPadding(dp(10), dp(9), dp(12), dp(9))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) }
            addView(View(this@InkActivity).apply {
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(nb.coverColor) }
                layoutParams = LinearLayout.LayoutParams(dp(14), dp(14)).apply { rightMargin = dp(10) }
            })
            addView(TextView(this@InkActivity).apply {
                text = nb.title; textSize = 14f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(if (selected) AppTheme.onAccent() else AppTheme.text)
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(TextView(this@InkActivity).apply {
                text = relTime(modifiedTs); textSize = 11.5f; setPadding(dp(8), 0, 0, 0)
                setTextColor(if (selected) AppTheme.onAccent() else Color.argb(0xA0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            })
            setOnClickListener { onClick() }
        }

    private fun updatePageLabel() {
        val f = focused ?: return
        pageLabel?.text = "${f.currentPage() + 1} / ${f.pageCount()}"
    }

    /** A thin bar between two panes; drag it to re-balance their widths (weights). */
    private fun makeDivider(row: LinearLayout): View {
        val d = View(this).apply { setBackgroundColor(Color.argb(0x33, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))) }
        var downX = 0f; var leftW0 = 1f; var rightW0 = 1f
        d.setOnTouchListener { v, e ->
            val idx = row.indexOfChild(v)
            val left = row.getChildAt(idx - 1); val right = row.getChildAt(idx + 1)
            if (left == null || right == null) return@setOnTouchListener false
            val lp = left.layoutParams as LinearLayout.LayoutParams
            val rp = right.layoutParams as LinearLayout.LayoutParams
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; leftW0 = lp.weight; rightW0 = rp.weight; true }
                MotionEvent.ACTION_MOVE -> {
                    val total = (left.width + right.width).toFloat()
                    if (total > 1f) {
                        val sum = leftW0 + rightW0
                        val deltaW = sum * ((e.rawX - downX) / total)
                        val nl = (leftW0 + deltaW).coerceIn(sum * 0.15f, sum * 0.85f)
                        lp.weight = nl; rp.weight = sum - nl
                        row.requestLayout()
                    }
                    true
                }
                else -> false
            }
        }
        return d
    }

    // ---------- toolbar ----------
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun pillBg(color: Int) = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(color) }

    private fun pill(color: Int): Drawable {
        val ripple = Color.argb(0x3A, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val mask = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(Color.WHITE) }
        return RippleDrawable(ColorStateList.valueOf(ripple), pillBg(color), mask)
    }

    private fun iconBtn(pathData: String, active: Boolean = false, onClick: (ImageButton) -> Unit): ImageButton = ImageButton(this).apply {
        setImageBitmap(Icons.bitmap(pathData, dp(22)))
        scaleType = ImageView.ScaleType.FIT_CENTER
        background = pill(if (active) accent else light)
        setColorFilter(if (active) AppTheme.onAccent() else onSurface)
        stateListAnimator = null; minimumWidth = 0
        val pd = dp(7); setPadding(pd, pd, pd, pd)
        layoutParams = LinearLayout.LayoutParams(dp(42), dp(34))
        setOnClickListener { onClick(this) }
    }

    private fun shapePreview(type: ShapeType, px: Int): Bitmap {
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        val spec = ShapeSpec.make(type, px / 2f, px / 2f, px * 0.30f)
        val paint = android.graphics.Paint().apply {
            isAntiAlias = true; style = android.graphics.Paint.Style.STROKE; color = Color.WHITE
            strokeWidth = px * 0.055f; strokeCap = android.graphics.Paint.Cap.ROUND; strokeJoin = android.graphics.Paint.Join.ROUND
        }
        for (poly in spec.polylines()) c.drawPath(FinishedStrokesView.buildStraightPath(poly), paint)
        return bmp
    }

    private fun updateTools() {
        for ((t, btn) in toolButtons) {
            val active = t == tool
            btn.background = pill(if (active) accent else light)
            btn.setColorFilter(if (active) AppTheme.onAccent() else onSurface)
        }
        updateBrushButton()
    }

    /** Highlight the brush button while the pen tool (which uses the brush) is active. */
    private fun updateBrushButton() {
        val b = brushButton ?: return
        val active = tool == Tool.PEN && pendingShape == null
        b.background = pill(if (active) accent else light)
        b.setColorFilter(if (active) AppTheme.onAccent() else onSurface)
    }

    private fun brushLabel(b: Brush) = when (b) {
        Brush.PEN -> "Pen"; Brush.FOUNTAIN -> "Fountain"; Brush.MARKER -> "Marker"; Brush.PENCIL -> "Pencil"
    }

    /** A short squiggle rendered with [b] so each brush's character is visible in the picker. */
    private fun brushPreview(b: Brush, w: Int, h: Int, tint: Int): Bitmap {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        val pts = ArrayList<android.graphics.PointF>()
        val n = 26
        for (i in 0..n) {
            val t = i / n.toFloat()
            val x = w * 0.12f + t * w * 0.76f
            val y = h / 2f + Math.sin(t * Math.PI * 2.0).toFloat() * h * 0.24f
            pts.add(android.graphics.PointF(x, y))
        }
        val paint = android.graphics.Paint().apply {
            isAntiAlias = true; style = android.graphics.Paint.Style.STROKE
            strokeCap = android.graphics.Paint.Cap.ROUND; strokeJoin = android.graphics.Paint.Join.ROUND
        }
        FinishedStrokesView.drawInk(c, pts, null, tint, dp(3).toFloat(), b, false, paint)
        return bmp
    }

    private fun showBrushMenu(anchor: View) {
        val brushes = listOf(Brush.PEN, Brush.FOUNTAIN, Brush.MARKER, Brush.PENCIL)
        val grid = GridLayout(this).apply {
            columnCount = 4
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x30, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        val popup = PopupWindow(grid, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(10).toFloat() }
        for (bt in brushes) {
            val on = bt == brush
            val fg = if (on) AppTheme.onAccent() else onSurface
            grid.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
                background = pill(if (on) accent else light); stateListAnimator = null
                setPadding(dp(6), dp(8), dp(6), dp(6))
                layoutParams = GridLayout.LayoutParams().apply { width = dp(66); height = dp(66); setMargins(dp(4), dp(4), dp(4), dp(4)) }
                addView(ImageView(this@InkActivity).apply {
                    setImageBitmap(brushPreview(bt, dp(46), dp(26), fg))
                    layoutParams = LinearLayout.LayoutParams(dp(46), dp(26))
                })
                addView(TextView(this@InkActivity).apply {
                    text = brushLabel(bt); textSize = 10.5f; setTextColor(fg); gravity = Gravity.CENTER; setPadding(0, dp(3), 0, 0)
                })
                setOnClickListener { popup.dismiss(); selectBrush(bt) }
            })
        }
        popup.showAsDropDown(anchor, 0, dp(6))
    }

    private fun selectBrush(b: Brush) {
        brush = b
        clearPendingShape()
        tool = Tool.PEN
        panes.forEach { it.onToolChanged() }
        updateTools()
        saveBrushPref()
        Toast.makeText(this, brushLabel(b), Toast.LENGTH_SHORT).show()
    }

    private fun buildToolbar(): View {
        fun sep() = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(1), dp(22)).apply { setMargins(dp(5), 0, dp(5), 0) }
            setBackgroundColor(Color.argb(0x22, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
        }
        fun iconTool(path: String, t: Tool) = iconBtn(path) {
            clearPendingShape(); tool = t; panes.forEach { it.onToolChanged() }; updateTools()
        }.also { toolButtons[t] = it }

        colorButton = Button(this).apply {
            background = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(brushColor); setStroke(dp(1), Color.argb(0x40, 0x80, 0x80, 0x80)) }
            stateListAnimator = null; minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0
            layoutParams = LinearLayout.LayoutParams(dp(34), dp(30))
            setOnClickListener { showColorPicker(it) { c -> brushColor = c; (background as GradientDrawable).setColor(c); saveBrushPref() } }
        }

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(27).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x2A, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            elevation = dp(12).toFloat(); setPadding(dp(9), dp(6), dp(9), dp(6))
            addView(iconBtn(Icons.BACK) { finish() })
            addView(sep())
            addView(iconBtn(Icons.UNDO) { focused?.undo() }); addView(iconBtn(Icons.REDO) { focused?.redo() })
            addView(sep())
            addView(iconTool(Icons.PEN, Tool.PEN))
            addView(iconBtn(Icons.BRUSH) { showBrushMenu(it) }.also { brushButton = it })
            addView(iconTool(Icons.MARKER, Tool.HIGHLIGHTER))
            addView(iconTool(Icons.ERASER, Tool.ERASER)); addView(iconTool(Icons.LASSO, Tool.SELECT))
            addView(iconBtn(Icons.SHAPES) { showShapeMenu(it) }.also { shapeButton = it })
            addView(sep())
            addView(colorButton)
            addView(iconBtn(Icons.SIZE) { showSizePopup(it) })
            addView(sep())
            addView(iconBtn(Icons.ZOOM_OUT) { focused?.zoomBy(0.8f) }); addView(iconBtn(Icons.ZOOM_IN) { focused?.zoomBy(1.25f) }); addView(iconBtn(Icons.FIT) { focused?.toggleFit() })
            addView(sep())
            addView(iconBtn(Icons.PREV) { focused?.scrollPage(-1); updatePageLabel() })
            pageLabel = TextView(this@InkActivity).apply { text = "1 / 1"; textSize = 13f; setTextColor(onSurface); setPadding(dp(6), 0, dp(6), 0) }.also { addView(it) }
            addView(iconBtn(Icons.NEXT) { focused?.scrollPage(1); updatePageLabel() })
            addView(iconBtn(Icons.ADD) { focused?.addPage(); updatePageLabel() })
            addView(sep())
            addView(iconBtn(Icons.SPLIT) { showAddPane(it) })
            addView(iconBtn(Icons.CAST) { showMirrorDialog() }.also { mirrorButton = it })
            addView(iconBtn(Icons.EMAIL) { emailNotebook() }.apply { setOnLongClickListener { emailNotebook(repick = true); true } })
        }
        return HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            clipChildren = false; clipToPadding = false
            setPadding(dp(14), dp(6), dp(14), dp(14))  // room so the toolbar's drop shadow isn't clipped
            addView(bar)
        }
    }

    private fun showShapeMenu(anchor: View) {
        val types = listOf(ShapeType.LINE, ShapeType.ARROW, ShapeType.RECT, ShapeType.ELLIPSE, ShapeType.TRIANGLE, ShapeType.AXES2D, ShapeType.AXES3D)
        val grid = GridLayout(this).apply {
            columnCount = 4
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x30, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        val popup = PopupWindow(grid, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(10).toFloat() }
        for (type in types) grid.addView(ImageButton(this).apply {
            setImageBitmap(shapePreview(type, dp(30))); setColorFilter(onSurface); scaleType = ImageView.ScaleType.FIT_CENTER
            background = pill(light); stateListAnimator = null
            val pd = dp(8); setPadding(pd, pd, pd, pd)
            layoutParams = GridLayout.LayoutParams().apply { width = dp(54); height = dp(50); setMargins(dp(4), dp(4), dp(4), dp(4)) }
            setOnClickListener { popup.dismiss(); armShape(type) }
        })
        popup.showAsDropDown(anchor, 0, dp(6))
    }

    /** Arm a shape so the next stroke you draw becomes it (fitted to your stroke) instead of spawning. */
    private fun armShape(type: ShapeType) {
        pendingShape = type
        tool = Tool.PEN; panes.forEach { it.onToolChanged() }; updateTools()
        shapeButton?.background = pill(accent); shapeButton?.setColorFilter(AppTheme.onAccent())
        val name = type.name.lowercase().replaceFirstChar { it.uppercase() }
        Toast.makeText(this, "Draw a $name", Toast.LENGTH_SHORT).show()
    }
    private fun clearPendingShape() {
        if (pendingShape == null) return
        pendingShape = null
        shapeButton?.background = pill(light); shapeButton?.setColorFilter(onSurface)
    }

    private fun showSizePopup(anchor: View) {
        val pad = dp(16)
        val muted = Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val preview = object : View(this) {
            private val pv = android.graphics.Paint().apply {
                isAntiAlias = true; style = android.graphics.Paint.Style.STROKE
                strokeCap = android.graphics.Paint.Cap.ROUND; strokeJoin = android.graphics.Paint.Join.ROUND
            }
            override fun onDraw(c: android.graphics.Canvas) {
                val pts = ArrayList<android.graphics.PointF>()
                val n = 40
                for (i in 0..n) {
                    val t = i / n.toFloat()
                    val x = dp(16) + t * (width - dp(32))
                    val y = height / 2f + Math.sin(t * Math.PI * 2.0).toFloat() * height * 0.26f
                    pts.add(android.graphics.PointF(x, y.toFloat()))
                }
                FinishedStrokesView.drawInk(c, pts, null, brushColor, brushSize, brush, tool == Tool.HIGHLIGHTER, pv)
            }
        }.apply { layoutParams = LinearLayout.LayoutParams(dp(230), dp(56)) }

        fun sectionLabel(text: String) = TextView(this).apply {
            this.text = text; textSize = 11f; setTextColor(muted)
            setTypeface(null, android.graphics.Typeface.BOLD); letterSpacing = 0.04f
        }

        val sizeLabel = TextView(this).apply { text = "%.1f".format(brushSize); textSize = 12f; setTextColor(muted); gravity = Gravity.CENTER }
        val seek = SeekBar(this).apply {
            max = brushSteps; progress = progressForBrush(brushSize)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                    brushSize = brushForProgress(p); sizeLabel.text = "%.1f".format(brushSize); preview.invalidate()
                }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) { saveBrushPref() }
            })
        }

        val smLabel = TextView(this).apply { text = smoothingText(); textSize = 12f; setTextColor(muted); gravity = Gravity.CENTER }
        val smSeek = SeekBar(this).apply {
            max = 100; progress = (smoothing * 100f).roundToInt().coerceIn(0, 100)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                    smoothing = p / 100f; smLabel.text = smoothingText()
                }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) { saveBrushPref() }
            })
        }

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x30, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            setPadding(pad, pad, pad, pad)
            addView(preview)
            addView(sectionLabel("SIZE"), LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(10) })
            addView(seek, LinearLayout.LayoutParams(dp(240), WRAP_CONTENT).apply { topMargin = dp(2) })
            addView(sizeLabel, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(sectionLabel("SMOOTHING"), LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(12) })
            addView(smSeek, LinearLayout.LayoutParams(dp(240), WRAP_CONTENT).apply { topMargin = dp(2) })
            addView(smLabel, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        PopupWindow(col, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(10).toFloat() }.showAsDropDown(anchor, 0, dp(6))
    }

    private fun smoothingText(): String = when {
        smoothing < 0.03f -> "Off"
        smoothing < 0.35f -> "Light · ${(smoothing * 100).roundToInt()}%"
        smoothing < 0.7f -> "Medium · ${(smoothing * 100).roundToInt()}%"
        else -> "Strong · ${(smoothing * 100).roundToInt()}%"
    }

    private fun showColorPicker(anchor: View, onPick: (Int) -> Unit) {
        val pad = dp(10)
        val grid = GridLayout(this).apply {
            columnCount = 5
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x30, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            setPadding(pad, pad, pad, pad)
        }
        val popup = PopupWindow(grid, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(8).toFloat() }
        val sz = dp(42); val m = dp(4)
        for (c in palette) grid.addView(View(this).apply {
            background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(c); setStroke(dp(1), Color.argb(0x33, 0x80, 0x80, 0x80)) }
            layoutParams = GridLayout.LayoutParams().apply { width = sz; height = sz; setMargins(m, m, m, m) }
            setOnClickListener { onPick(c); popup.dismiss() }
        })
        popup.showAsDropDown(anchor, 0, dp(6))
    }

    private fun saveBrushPref() {
        getSharedPreferences(INK_PREFS, MODE_PRIVATE).edit()
            .putFloat("brushSize", brushSize).putInt("brushColor", brushColor)
            .putFloat("smoothing", smoothing).putString("brush", brush.name).apply()
    }

    // ---------- PDF export + email ----------
    private fun emailNotebook(repick: Boolean = false) {
        val pane = focused ?: return
        val file = pane.exportPdf(cacheDir)
        if (file == null) { Toast.makeText(this, "Couldn't build the PDF.", Toast.LENGTH_SHORT).show(); return }
        val title = pane.notebook.title
        val saved = EmailPrefs.savedEmail(this)
        if (saved == null || repick) showEmailPicker { email -> sendPdf(file, email, title) } else sendPdf(file, saved, title)
    }

    private fun sendPdf(file: File, email: String, title: String) {
        try {
            val uri = FileProvider.getUriForFile(this, "com.engorg.inkpad.fileprovider", file)
            val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = "application/pdf"
                putExtra(android.content.Intent.EXTRA_EMAIL, arrayOf(email))
                putExtra(android.content.Intent.EXTRA_SUBJECT, title)
                putExtra(android.content.Intent.EXTRA_TEXT, "Notebook \"$title\" exported from EngInk.")
                putExtra(android.content.Intent.EXTRA_STREAM, uri)
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(android.content.Intent.createChooser(intent, "Email notebook"))
        } catch (e: Exception) { Toast.makeText(this, "No email app available.", Toast.LENGTH_SHORT).show() }
    }

    private fun showEmailPicker(onPick: (String) -> Unit) {
        val accounts = EmailPrefs.accounts(this)
        val pad = dp(20)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, dp(14))
        }
        col.addView(ImageView(this).apply { setImageBitmap(Icons.bitmap(Icons.EMAIL, dp(26))); setColorFilter(AppTheme.text); layoutParams = LinearLayout.LayoutParams(dp(26), dp(26)) })
        val dialog = Dialog(this).apply {
            setContentView(col, ViewGroup.LayoutParams(dp(330), WRAP_CONTENT))
            window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }
        val saved = EmailPrefs.savedEmail(this)
        for (acc in accounts) col.addView(accountTile(acc, acc.email == saved) { EmailPrefs.setSavedEmail(this, acc.email); dialog.dismiss(); onPick(acc.email) })
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(14), dp(6), dp(6))
            addView(ImageView(this@InkActivity).apply { setImageBitmap(Icons.bitmap(Icons.ADD, dp(22))); setColorFilter(AppTheme.accent); layoutParams = LinearLayout.LayoutParams(dp(22), dp(22)) })
            setOnClickListener { dialog.dismiss(); promptEmail { e -> EmailPrefs.setSavedEmail(this@InkActivity, e); onPick(e) } }
        })
        dialog.show()
    }

    private fun accountTile(acc: EmailPrefs.Account, selected: Boolean, onClick: () -> Unit): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(if (selected) AppTheme.accent else AppTheme.elevated) }
            setPadding(dp(12), dp(10), dp(14), dp(10))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) }
            setOnClickListener { onClick() }
        }
        val avatar = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(40))
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(avatarColor(acc.email)) }
            clipToOutline = true
        }
        setInitial(avatar, acc); loadAvatar(avatar, acc.photo); row.addView(avatar)
        row.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0)
            val fg = if (selected) AppTheme.onAccent() else AppTheme.text
            if (acc.name.isNotBlank()) addView(TextView(this@InkActivity).apply { text = acc.name; setTextColor(fg); textSize = 15f; setTypeface(null, android.graphics.Typeface.BOLD) })
            addView(TextView(this@InkActivity).apply {
                text = acc.email; textSize = 13f
                setTextColor(if (selected) AppTheme.onAccent() else Color.argb(0xB0, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text)))
            })
        })
        return row
    }

    private fun avatarColor(seed: String): Int {
        val h = (seed.hashCode() and 0xFFFFFF)
        return Color.rgb(0x40 + (h and 0x7F), 0x50 + ((h shr 8) and 0x7F), 0x60 + ((h shr 16) and 0x7F))
    }
    private fun setInitial(iv: ImageView, acc: EmailPrefs.Account) {
        val letter = (acc.name.ifBlank { acc.email }).trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        val bmp = Bitmap.createBitmap(dp(40), dp(40), Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp); c.drawColor(avatarColor(acc.email))
        val p = android.graphics.Paint().apply { isAntiAlias = true; color = Color.WHITE; textAlign = android.graphics.Paint.Align.CENTER; textSize = dp(20).toFloat(); typeface = android.graphics.Typeface.DEFAULT_BOLD }
        c.drawText(letter, dp(20).toFloat(), dp(20).toFloat() + p.textSize / 3f, p); iv.setImageBitmap(bmp)
    }
    private fun loadAvatar(iv: ImageView, url: String) {
        if (url.isBlank()) return
        Thread {
            try { val bmp = URL(url).openStream().use { BitmapFactory.decodeStream(it) }; if (bmp != null) runOnUiThread { iv.setImageBitmap(bmp) } } catch (_: Exception) { }
        }.start()
    }

    private fun promptEmail(onOk: (String) -> Unit) {
        val pad = dp(22)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, dp(16))
        }
        box.addView(ImageView(this).apply { setImageBitmap(Icons.bitmap(Icons.EMAIL, dp(26))); setColorFilter(AppTheme.text); layoutParams = LinearLayout.LayoutParams(dp(26), dp(26)) })
        val input = android.widget.EditText(this).apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            setTextColor(AppTheme.text)
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated) }
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        box.addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) })
        val dialog = Dialog(this).apply {
            setContentView(box, ViewGroup.LayoutParams(dp(320), WRAP_CONTENT))
            window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }
        box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(18) }
            addView(iconBtn(Icons.CLOSE) { dialog.dismiss() })
            addView(View(this@InkActivity), LinearLayout.LayoutParams(dp(8), 1))
            addView(iconBtn(Icons.CHECK, active = true) { val v = input.text.toString().trim(); if (v.contains("@")) { dialog.dismiss(); onOk(v) } })
        })
        dialog.show()
    }

    // ---------- mirror to a desktop (LAN, view-only reflection) ----------
    private fun mirrorInput(hintText: String) = android.widget.EditText(this).apply {
        hint = hintText
        setTextColor(AppTheme.text); setHintTextColor(Color.argb(0x80, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
        textSize = 15f; maxLines = 1
        background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated) }
        setPadding(dp(14), dp(12), dp(14), dp(12))
    }

    private fun showMirrorDialog() {
        val muted = Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val pad = dp(20)
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, dp(16))
        }
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            addView(ImageView(this@InkActivity).apply { setImageBitmap(Icons.bitmap(Icons.CAST, dp(24))); setColorFilter(AppTheme.text); layoutParams = LinearLayout.LayoutParams(dp(24), dp(24)).apply { rightMargin = dp(10) } })
            addView(TextView(this@InkActivity).apply { text = "Mirror to a computer"; setTextColor(AppTheme.text); textSize = 17f; setTypeface(null, android.graphics.Typeface.BOLD) })
        })
        col.addView(body, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) })
        val dialog = Dialog(this).apply {
            setContentView(android.widget.ScrollView(this@InkActivity).apply { addView(col) }, ViewGroup.LayoutParams(dp(340), WRAP_CONTENT))
            window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }

        fun pillRow(build: LinearLayout.() -> Unit) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(AppTheme.elevated) }
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) }
            build()
        }

        lateinit var render: () -> Unit
        render = {
            body.removeAllViews()
            if (MirrorManager.connected) {
                body.addView(TextView(this).apply { text = "Mirroring to ${MirrorManager.peerLabel}"; setTextColor(AppTheme.text); textSize = 15f })
                body.addView(pillRow {
                    addView(ImageView(this@InkActivity).apply { setImageBitmap(Icons.bitmap(Icons.CLOSE, dp(20))); setColorFilter(Color.rgb(0xE5, 0x3E, 0x3E)); layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(12) } })
                    addView(TextView(this@InkActivity).apply { text = "Disconnect"; setTextColor(AppTheme.text); textSize = 15f })
                    setOnClickListener { MirrorManager.disconnect(); render() }
                })
            } else {
                val status = TextView(this).apply { text = "Searching for computers on your Wi-Fi…"; setTextColor(muted); textSize = 13f }
                body.addView(status)
                val listWrap = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                body.addView(listWrap, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

                fun connectTo(host: String, port: Int, code: String) {
                    status.text = "Connecting to $host…"
                    MirrorManager.connect(host, port, code) { ok, msg -> if (ok) render() else status.text = msg }
                }

                MirrorManager.discover { peers ->
                    if (!dialog.isShowing) return@discover
                    status.text = if (peers.isEmpty()) "No computers found. Enter the address shown in EngInk on your PC." else "Tap your computer:"
                    listWrap.removeAllViews()
                    for (p in peers) listWrap.addView(pillRow {
                        addView(ImageView(this@InkActivity).apply { setImageBitmap(Icons.bitmap(Icons.CAST, dp(20))); setColorFilter(AppTheme.text); layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(12) } })
                        addView(LinearLayout(this@InkActivity).apply {
                            orientation = LinearLayout.VERTICAL
                            addView(TextView(this@InkActivity).apply { text = p.name; setTextColor(AppTheme.text); textSize = 15f; setTypeface(null, android.graphics.Typeface.BOLD) })
                            addView(TextView(this@InkActivity).apply { text = "${p.host}:${p.port}"; setTextColor(muted); textSize = 12f })
                        })
                        setOnClickListener { connectTo(p.host, p.port, p.code) }
                    })
                }

                body.addView(TextView(this).apply { text = "Or enter it manually"; setTextColor(muted); textSize = 12f; setPadding(0, dp(16), 0, dp(2)) })
                val hostInput = mirrorInput("IP address (e.g. 192.168.0.10)")
                val codeInput = mirrorInput("6-digit code").apply { inputType = android.text.InputType.TYPE_CLASS_NUMBER }
                body.addView(hostInput, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) })
                body.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                    layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) }
                    addView(codeInput, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                    addView(iconBtn(Icons.CHECK, active = true) {
                        val raw = hostInput.text.toString().trim()
                        if (raw.isNotEmpty()) {
                            val host = raw.substringBefore(":")
                            val port = raw.substringAfter(":", "").toIntOrNull() ?: MirrorManager.WS_PORT
                            connectTo(host, port, codeInput.text.toString().trim())
                        }
                    }.apply { (layoutParams as LinearLayout.LayoutParams).leftMargin = dp(8) })
                })
            }
        }
        render()
        dialog.show()
    }

    companion object {
        const val EXTRA_NOTEBOOK_ID = "notebookId"
        const val EXTRA_NOTEBOOK_IDS = "notebookIds"
        private const val INK_PREFS = "ink_prefs"
    }
}
