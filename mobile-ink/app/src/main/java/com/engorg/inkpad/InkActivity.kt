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
    private var smoothing = 0.1f    // 0 = off, 1 = max; the slider spans a deliberately gentle range
    private var eraserSize = 13f    // eraser radius in page units; tap the eraser again to change it
    private var pendingShape: ShapeType? = null
    private var pendingSolid: SolidParams? = null   // the solid an armed SOLID becomes
    private var pendingShapeDashed = false   // arm shapes with a dashed outline (e.g. system boundaries)
    private var pendingShapeHashed = true    // tick marks on the axes shapes
    private var tableRows = 3
    private var tableCols = 3
    private var tableBorder = true

    private lateinit var colorButton: Button
    private var shapeButton: ImageButton? = null
    private var tableButton: ImageButton? = null
    private var brushButton: ImageButton? = null
    private var pageLabel: TextView? = null
    private var mirrorButton: ImageButton? = null
    private val toolButtons = HashMap<Tool, ImageButton>()
    private var graphButton: ImageButton? = null
    private var claudeButton: ImageButton? = null
    private var claude: ClaudePanel? = null
    private var calcButton: ImageButton? = null
    private var calc: CalculatorWindow? = null
    private lateinit var rootFrame: FrameLayout

    // Brush width in page units. The size slider maps GEOMETRICALLY across [minBrush, maxBrush] so
    // equal slider travel is an equal ratio change — fine steps where handwriting lives, thick end
    // still reachable. minBrush goes to a true hairline so a ~1px line is easy to dial in.
    private val minBrush = 0.8f
    private val maxBrush = 40f
    private val brushSteps = 100
    private fun brushForProgress(p: Int): Float = minBrush * (maxBrush / minBrush).pow(p / brushSteps.toFloat())
    private fun progressForBrush(w: Float): Int =
        (brushSteps * (ln(w / minBrush) / ln(maxBrush / minBrush))).roundToInt().coerceIn(0, brushSteps)

    // Eraser radius in page units, same geometric slider mapping as the brush.
    private val minEraser = 3f
    private val maxEraser = 80f
    private fun eraserForProgress(p: Int): Float = minEraser * (maxEraser / minEraser).pow(p / brushSteps.toFloat())
    private fun progressForEraser(r: Float): Int =
        (brushSteps * (ln(r / minEraser) / ln(maxEraser / minEraser))).roundToInt().coerceIn(0, brushSteps)

    private val accent get() = AppTheme.accent
    private val light get() = AppTheme.elevated
    private val onSurface get() = AppTheme.text

    private val palette = intArrayOf(
        Color.rgb(0x16, 0x1A, 0x22), Color.rgb(0x45, 0x4B, 0x55), Color.rgb(0x8A, 0x92, 0x9E), Color.rgb(0xEC, 0xEC, 0xEC), Color.WHITE,
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0xAC, 0xC1), Color.rgb(0x00, 0x89, 0x7B), Color.rgb(0x2E, 0x7D, 0x32),
        Color.rgb(0x7C, 0xB3, 0x42), Color.rgb(0xF9, 0xA8, 0x25), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0x6D, 0x4C, 0x41), Color.rgb(0xB7, 0x1C, 0x1C),
        Color.rgb(0xDC, 0x26, 0x50), Color.rgb(0xE9, 0x1E, 0x63), Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0xFF, 0xEB, 0x3B),
    )
    // Colors picked from the wheel, newest first (fills the palette's custom row beside the wheel button).
    private val customColors = ArrayList<Int>()
    private val MAX_CUSTOM_COLORS = 4

    // Supplies the shared pen/tool to each pane and receives focus/page/shape callbacks from them.
    private val hostImpl = object : PageCanvas.Host {
        override val tool get() = this@InkActivity.tool
        override val brushColor get() = this@InkActivity.brushColor
        override val brushSize get() = this@InkActivity.brushSize
        override val brush get() = this@InkActivity.brush
        override val smoothing get() = this@InkActivity.smoothing
        override val eraserSize get() = this@InkActivity.eraserSize
        override val pendingShape get() = this@InkActivity.pendingShape
        override val pendingShapeDashed get() = this@InkActivity.pendingShapeDashed
        override val pendingShapeHashed get() = this@InkActivity.pendingShapeHashed
        override val pendingTableRows get() = tableRows
        override val pendingTableCols get() = tableCols
        override val pendingTableBorder get() = tableBorder
        override val pendingSolid get() = this@InkActivity.pendingSolid
        override fun editSolid(params: SolidParams, fill: SolidFill, view: FloatArray, onApply: (SolidParams, SolidFill) -> Unit) =
            showSolidBuilder(params, "Apply", fill, view) { p, f -> onApply(p, f ?: fill) }
        override fun editFill(color: Int, onApply: (Int) -> Unit) = showFillDialog(color, onApply)
        override fun onPaneFocused(pane: PageCanvas) { setFocused(pane) }
        override fun onPageChanged(pane: PageCanvas) { if (pane === focused) updatePageLabel() }
        override fun onShapeCommitted() { clearPendingShape(); this@InkActivity.tool = Tool.SELECT; updateTools() }
        override fun pickColor(pane: PageCanvas, x: Float, y: Float, onPick: (Int) -> Unit) {
            val loc = IntArray(2); pane.getLocationInWindow(loc)
            val w = dp(270)
            val px = (loc[0] + x - w / 2f).toInt().coerceIn(0, (window.decorView.width - w).coerceAtLeast(0))
            colorPopup(onPick).showAtLocation(pane, Gravity.NO_GRAVITY, px, (loc[1] + y).toInt())
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppTheme.load(this)
        SystemBars.setup(this, lightBackground = !AppTheme.dark)

        // Restore the last-used pen so the stroke weight + color + brush you settled on stick between sessions.
        val ip = getSharedPreferences(INK_PREFS, MODE_PRIVATE)
        brushSize = ip.getFloat("brushSize", brushSize).coerceIn(minBrush, maxBrush)
        brushColor = ip.getInt("brushColor", brushColor)
        try {
            val arr = org.json.JSONArray(ip.getString("customColors", "[]"))
            for (i in 0 until minOf(arr.length(), MAX_CUSTOM_COLORS)) customColors.add(arr.getInt(i))
        } catch (_: Exception) { }
        smoothing = ip.getFloat("smoothing", smoothing).coerceIn(0f, 1f)
        eraserSize = ip.getFloat("eraserSize", eraserSize).coerceIn(minEraser, maxEraser)
        // Every session starts on the plain Pen brush (the brush menu still switches it per session).
        brush = Brush.PEN
        pendingShapeDashed = ip.getBoolean("shapeDashed", false)
        pendingShapeHashed = ip.getBoolean("shapeHashed", true)
        tableRows = ip.getInt("tableRows", 3).coerceIn(1, 20)
        tableCols = ip.getInt("tableCols", 3).coerceIn(1, 20)
        tableBorder = ip.getBoolean("tableBorder", true)

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
        rootFrame = root
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
        claude?.dispose()
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

    private fun shapePreview(type: ShapeType, px: Int, dashed: Boolean = false, configure: (ShapeSpec) -> Unit = {}): Bitmap =
        specPreview(ShapeSpec.make(type, px / 2f, px / 2f, px * 0.30f).also(configure), px, dashed)

    private fun solidPreview(params: SolidParams, px: Int, dashed: Boolean = false, fill: Float = 0.36f): Bitmap =
        specPreview(ShapeSpec.solidIn(params, px * (0.5f - fill), px * (0.5f - fill), px * (0.5f + fill), px * (0.5f + fill)), px, dashed)

    private fun specPreview(spec: ShapeSpec, px: Int, dashed: Boolean): Bitmap {
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        val paint = android.graphics.Paint().apply {
            isAntiAlias = true; style = android.graphics.Paint.Style.STROKE; color = Color.WHITE
            strokeWidth = px * 0.055f; strokeJoin = android.graphics.Paint.Join.ROUND
            if (dashed) {
                strokeCap = android.graphics.Paint.Cap.BUTT
                pathEffect = android.graphics.DashPathEffect(floatArrayOf(px * 0.11f, px * 0.08f), 0f)
            } else strokeCap = android.graphics.Paint.Cap.ROUND
        }
        // A solid's hidden edges preview dashed even when the outline is solid, as they'll draw.
        val hiddenPaint = android.graphics.Paint(paint).apply {
            strokeCap = android.graphics.Paint.Cap.BUTT
            pathEffect = android.graphics.DashPathEffect(floatArrayOf(px * 0.08f, px * 0.06f), 0f)
        }
        for (part in spec.parts()) c.drawPath(FinishedStrokesView.buildStraightPath(part.pts), if (part.hidden) hiddenPaint else paint)
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
            // Tapping the already-active eraser opens its size picker.
            if (t == Tool.ERASER && tool == Tool.ERASER && pendingShape == null) { showEraserSizePopup(it); return@iconBtn }
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
            addView(iconBtn(Icons.TABLE) { showTableMenu(it) }.also { tableButton = it })
            addView(iconBtn(Icons.GRAPH) { spawnGraph() }.also { graphButton = it })
            addView(iconBtn(Icons.CALC) { toggleCalculator() }.also { calcButton = it })
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
            addView(iconBtn(Icons.SUBMIT) { showSubmitDialog() })
            // ✨: Ask in Claude (tap = this page, long-press = all pages). The API-key panel is kept
            // behind AskInClaude.USE_API_PANEL while the Claude-app route is on trial.
            addView(iconBtn(Icons.SPARKLE) { if (AskInClaude.USE_API_PANEL) toggleClaude() else askInClaude(all = false) }.apply {
                if (!AskInClaude.USE_API_PANEL) setOnLongClickListener { askInClaude(all = true); true }
            }.also { claudeButton = it })
        }
        return HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            clipChildren = false; clipToPadding = false
            setPadding(dp(14), dp(6), dp(14), dp(14))  // room so the toolbar's drop shadow isn't clipped
            addView(bar)
        }
    }

    /** Open / close the floating graphing calculator (functions left, graph right). */
    /** The graph button: drop a graphing window onto the focused page, open and ready to type. */
    private fun spawnGraph() {
        val pane = focused ?: return
        clearPendingShape(); tool = Tool.SELECT
        panes.forEach { it.onToolChanged() }
        updateTools()
        pane.spawnGraph()
    }

    /** Open / close the floating calculator. */
    private fun toggleCalculator() {
        val c = calc ?: CalculatorWindow(this, rootFrame).also { calc = it; it.onClosed = { updateCalcButton() } }
        c.toggle()
        updateCalcButton()
    }

    private fun updateCalcButton() {
        val b = calcButton ?: return
        val on = calc?.isOpen == true
        b.background = pill(if (on) accent else light)
        b.setColorFilter(if (on) AppTheme.onAccent() else onSurface)
    }

    /** Send the focused pane's page (or all inked pages) to the Claude app, beside EngInk. */
    private fun askInClaude(all: Boolean) {
        val pane = focused ?: return
        AskInClaude.open(this, pane, all)
    }

    /** Open / close the Claude feedback panel (scans the focused pane's page). */
    private fun toggleClaude() {
        val c = claude ?: ClaudePanel(this, rootFrame) { focused }.also { claude = it; it.onClosed = { updateClaudeButton() } }
        c.toggle()
        updateClaudeButton()
    }

    private fun updateClaudeButton() {
        val b = claudeButton ?: return
        val on = claude?.isOpen == true
        b.background = pill(if (on) accent else light)
        b.setColorFilter(if (on) AppTheme.onAccent() else onSurface)
    }

    /** Drop an exported graph onto the focused pane's page, selected so it can be dragged into place. */
    private fun addGraphToPage(ink: List<GraphInk>, w: Float, h: Float) {
        val pane = focused ?: return
        clearPendingShape(); tool = Tool.SELECT
        panes.forEach { it.onToolChanged() }
        updateTools()
        pane.insertGraph(ink, w, h)
        Toast.makeText(this, "Graph added — drag it into place", Toast.LENGTH_SHORT).show()
    }

    private fun showShapeMenu(anchor: View) {
        val types = listOf(
            ShapeType.LINE, ShapeType.ARROW, ShapeType.RECT, ShapeType.ELLIPSE, ShapeType.TRIANGLE, ShapeType.TRAPEZOID,
            ShapeType.AXES2D_1Q, ShapeType.AXES2D_2Q, ShapeType.AXES2D, ShapeType.AXES3D, ShapeType.AXES3D_8,
        )
        val solids = listOf(SolidParams.box(), SolidParams.cylinder(), SolidParams.cone(), SolidParams.sphere(), SolidParams.pyramid(), SolidParams.trapezoid())
        val solidButtons = ArrayList<Pair<SolidParams, ImageButton>>()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x30, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        val grid = GridLayout(this).apply { columnCount = 5 }
        val popup = PopupWindow(col, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(10).toFloat() }

        // "Dashed" toggle — flips the armed-shape style and re-renders every preview so the grid shows
        // exactly what you'll draw. Lets you lay down dashed outlines (system boundaries, hidden edges…).
        val shapeButtons = HashMap<ShapeType, ImageButton>()
        val dashIcon = ImageView(this).apply { layoutParams = LinearLayout.LayoutParams(dp(30), dp(14)) }
        val dashLabel = TextView(this).apply { text = "Dashed"; textSize = 12f; setPadding(dp(8), 0, 0, 0) }
        val dashToggle = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; stateListAnimator = null
            setPadding(dp(10), dp(7), dp(10), dp(7))
            addView(dashIcon); addView(dashLabel)
        }
        // "Hashed axes" checkbox: tick (scale) marks on the axes shapes.
        val hashBox = android.widget.CheckBox(this).apply {
            text = "Hashed axes"; textSize = 12f; setTextColor(onSurface)
            buttonTintList = ColorStateList.valueOf(accent)
            isChecked = pendingShapeHashed
        }
        fun refreshDash() {
            val on = pendingShapeDashed
            val fg = if (on) AppTheme.onAccent() else onSurface
            dashToggle.background = pill(if (on) accent else light)
            dashIcon.setImageBitmap(dashLineIcon(dp(30), dp(14), fg, on))
            dashLabel.setTextColor(fg)
            for ((t, b) in shapeButtons) { b.setImageBitmap(shapePreview(t, dp(30), on) { it.hashed = pendingShapeHashed }); b.setColorFilter(onSurface) }
            for ((p, b) in solidButtons) { b.setImageBitmap(solidPreview(p, dp(30), on)); b.setColorFilter(onSurface) }
        }
        dashToggle.setOnClickListener { pendingShapeDashed = !pendingShapeDashed; saveBrushPref(); refreshDash() }
        hashBox.setOnCheckedChangeListener { _, checked -> pendingShapeHashed = checked; saveBrushPref(); refreshDash() }
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { setMargins(dp(4), dp(4), dp(4), dp(6)) }
            addView(dashToggle, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(hashBox, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = dp(10) })
        })

        fun tile(onClick: () -> Unit) = ImageButton(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            background = pill(light); stateListAnimator = null
            val pd = dp(8); setPadding(pd, pd, pd, pd)
            layoutParams = GridLayout.LayoutParams().apply { width = dp(54); height = dp(50); setMargins(dp(4), dp(4), dp(4), dp(4)) }
            setOnClickListener { popup.dismiss(); onClick() }
        }
        for (type in types) grid.addView(tile { armShape(type) }.also { shapeButtons[type] = it })
        col.addView(grid)
        // 3D solids — their own row, so they read as a family (hidden edges preview dashed). Select
        // one after drawing it to turn it in 3D with the globe knob.
        col.addView(TextView(this).apply {
            text = "3D solids"; textSize = 12f
            setTextColor(Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            setPadding(dp(8), dp(8), 0, dp(2))
        })
        val solidGrid = GridLayout(this).apply { columnCount = 5 }
        for (p in solids) solidGrid.addView(tile { armSolid(p) }.also { solidButtons.add(p to it) })
        col.addView(solidGrid)
        // Anything else: pick the family, the n-fold symmetry and the proportions.
        col.addView(TextView(this).apply {
            text = "＋  Custom solid…"; textSize = 13f; setTextColor(onSurface); gravity = Gravity.CENTER
            background = pill(light); stateListAnimator = null
            setPadding(dp(12), dp(10), dp(12), dp(10))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { setMargins(dp(4), dp(4), dp(4), dp(2)) }
            setOnClickListener { popup.dismiss(); showSolidBuilder(lastCustomSolid(), "Draw it") { p, _ -> saveCustomSolid(p); armSolid(p) } }
        })
        refreshDash()
        popup.showAsDropDown(anchor, 0, dp(6))
    }

    /** A short horizontal line (dashed or solid) for the shape menu's Dashed toggle. */
    private fun dashLineIcon(w: Int, h: Int, tint: Int, dashed: Boolean): Bitmap {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        val paint = android.graphics.Paint().apply {
            isAntiAlias = true; style = android.graphics.Paint.Style.STROKE; color = tint
            strokeWidth = h * 0.22f; strokeCap = if (dashed) android.graphics.Paint.Cap.BUTT else android.graphics.Paint.Cap.ROUND
            if (dashed) pathEffect = android.graphics.DashPathEffect(floatArrayOf(w * 0.17f, w * 0.12f), 0f)
        }
        c.drawLine(w * 0.08f, h / 2f, w * 0.92f, h / 2f, paint)
        return bmp
    }

    /** Arm a shape so the next stroke you draw becomes it (fitted to your stroke) instead of spawning. */
    private fun armShape(type: ShapeType) {
        clearPendingShape()
        pendingShape = type
        tool = Tool.PEN; panes.forEach { it.onToolChanged() }; updateTools()
        val btn = if (type == ShapeType.TABLE) tableButton else shapeButton
        btn?.background = pill(accent); btn?.setColorFilter(AppTheme.onAccent())
        val prefix = if (pendingShapeDashed && type != ShapeType.TABLE) "dashed " else ""
        val msg = if (type == ShapeType.TABLE) "Drag out the table (or tap to drop one)" else "Draw a $prefix${shapeLabel(type)}"
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
    /** Arm a 3D solid: the next stroke you draw sets where it goes and how big it is. */
    private fun armSolid(params: SolidParams) { pendingSolid = params.copy(); armShape(ShapeType.SOLID) }

    private fun lastCustomSolid(): SolidParams =
        getSharedPreferences(INK_PREFS, MODE_PRIVATE).getString("solidCustom", null)
            ?.let { runCatching { SolidParams.fromJson(org.json.JSONObject(it)) }.getOrNull() }
            ?: SolidParams(SolidKind.PRISM, 6, height = 1f)

    private fun saveCustomSolid(p: SolidParams) {
        getSharedPreferences(INK_PREFS, MODE_PRIVATE).edit().putString("solidCustom", p.toJson().toString()).apply()
    }

    /**
     * The 3D solid builder: family, n-fold symmetry (sides, or faces for the regular solids), round
     * base, and proportions, with a live preview and its face/edge/vertex count. [onDone] gets the result.
     */
    private fun showSolidBuilder(initial: SolidParams, doneLabel: String, initialFill: SolidFill? = null, view: FloatArray? = null,
                                 onDone: (SolidParams, SolidFill?) -> Unit) {
        val p = initial.copy()
        val fill = initialFill?.copy()
        val picked = HashSet<Int>()
        val muted = Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val pad = dp(20)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, dp(16))
        }
        val dialog = Dialog(this).apply {
            setContentView(android.widget.ScrollView(this@InkActivity).apply { addView(col) }, ViewGroup.LayoutParams(dp(360), WRAP_CONTENT))
            window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }
        col.addView(TextView(this).apply { text = "3D solid"; setTextColor(AppTheme.text); textSize = 17f; setTypeface(null, android.graphics.Typeface.BOLD) })
        val preview = ImageView(this).apply { setColorFilter(onSurface) }
        // Editing a solid on the page: a live picture you can turn and tap faces on, with its colors and water.
        lateinit var refreshFill: () -> Unit
        val live = fill?.let { f -> SolidPreviewView(this, p, f, view ?: Solid.defaultView(), picked) { r -> if (!picked.remove(r)) picked.add(r); refreshFill() } }
        if (live != null) {
            col.addView(live, LinearLayout.LayoutParams(dp(230), dp(210)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(6) })
            col.addView(TextView(this).apply {
                text = "Drag to turn it · tap faces to pick them"; textSize = 11.5f; gravity = Gravity.CENTER
                setTextColor(muted)
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        } else col.addView(preview, LinearLayout.LayoutParams(dp(150), dp(150)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(6) })
        val readout = TextView(this).apply { textSize = 13f; setTextColor(AppTheme.text); gravity = Gravity.CENTER }
        col.addView(readout, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(6) })

        fun heading(t: String) = TextView(this).apply {
            text = t; textSize = 11f; setTextColor(muted); setTypeface(null, android.graphics.Typeface.BOLD); letterSpacing = 0.04f
            setPadding(0, dp(10), 0, dp(4))
        }
        fun chip(label: String, onClick: () -> Unit) = TextView(this).apply {
            text = label; textSize = 13f; gravity = Gravity.CENTER; stateListAnimator = null
            setPadding(dp(12), dp(7), dp(12), dp(7))
            layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = dp(6) }
            setOnClickListener { onClick() }
        }
        fun styleChip(v: TextView, on: Boolean) { v.background = pill(if (on) accent else light); v.setTextColor(if (on) AppTheme.onAccent() else onSurface) }
        fun chipRow(views: List<View>) = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(LinearLayout(this@InkActivity).apply { orientation = LinearLayout.HORIZONTAL; views.forEach { addView(it) } })
        }

        lateinit var refresh: () -> Unit

        // Family
        col.addView(heading("SHAPE"))
        val kindChips = SolidKind.values().map { k ->
            k to chip(k.label) {
                if (p.kind == k) return@chip
                p.kind = k
                p.height = when (k) { SolidKind.FRUSTUM -> 0.8f; SolidKind.ANTIPRISM, SolidKind.TRAPEZOID -> 0.6f; SolidKind.PRISM -> if (p.sides == 4 && !p.round) SolidParams.CUBE_H else 1f; else -> 1f }
                if (k == SolidKind.TRAPEZOID) { p.top = 0.55f; p.depth = 0.6f }
                if (k == SolidKind.PLATONIC && p.sides !in SolidParams.PLATONIC_FACES) p.sides = 6
                if (k != SolidKind.PLATONIC) p.sides = p.sides.coerceIn(3, 24)
                refresh()
            }
        }
        col.addView(chipRow(kindChips.map { it.second }))

        // Symmetry: sides (n-fold) + round, or the regular solids' face count.
        val symHeading = heading("SIDES  (n-FOLD SYMMETRY)")
        col.addView(symHeading)
        val sidesValue = TextView(this).apply { textSize = 16f; setTextColor(AppTheme.text); gravity = Gravity.CENTER; minWidth = dp(44) }
        val roundChip = chip("Round") { p.round = !p.round; refresh() }
        val sidesRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            addView(chip("−") { p.round = false; p.sides = (p.sides - 1).coerceAtLeast(3); refresh() }.also { styleChip(it, false) })
            addView(sidesValue)
            addView(chip("+") { p.round = false; p.sides = (p.sides + 1).coerceAtMost(24); refresh() }.also { styleChip(it, false) })
            addView(View(this@InkActivity), LinearLayout.LayoutParams(0, 1, 1f))
            addView(roundChip)
        }
        col.addView(sidesRow)
        val faceChips = SolidParams.PLATONIC_FACES.map { f -> f to chip("$f") { p.sides = f; refresh() } }
        val facesRow = chipRow(faceChips.map { it.second })
        col.addView(facesRow)

        // Proportions
        fun slider(title: String, min: Float, max: Float, get: () -> Float, set: (Float) -> Unit, fmt: (Float) -> String): Pair<View, () -> Unit> {
            val label = heading(title)
            val value = TextView(this).apply { textSize = 12f; setTextColor(muted) }
            val seek = SeekBar(this).apply {
                this.max = ((max - min) * 100f).roundToInt()
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(sb: SeekBar?, pr: Int, fromUser: Boolean) { if (fromUser) { set(min + pr / 100f); refresh() } }
                    override fun onStartTrackingTouch(sb: SeekBar?) {}
                    override fun onStopTrackingTouch(sb: SeekBar?) {}
                })
            }
            val box = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                addView(LinearLayout(this@InkActivity).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM
                    addView(label, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)); addView(value)
                })
                addView(seek)
            }
            return box to { seek.progress = ((get() - min) * 100f).roundToInt(); value.text = fmt(get()) }
        }
        val (heightBox, heightSync) = slider("HEIGHT", 0.1f, 3f, { p.height }, { p.height = it }) { "%.2f × width".format(it) }
        val (depthBox, depthSync) = slider("DEPTH  (FRONT TO BACK)", 0.2f, 3f, { p.depth }, { p.depth = it }) { "%.2f ×".format(it) }
        val (topBox, topSync) = slider("TOP SIZE", 0.05f, 0.95f, { p.top }, { p.top = it }) { "${(it * 100).roundToInt()}% of base" }
        col.addView(heightBox); col.addView(depthBox); col.addView(topBox)

        // Fill + water (only when editing a solid that's on the page).
        if (fill != null && live != null) {
            col.addView(heading("FILL"))
            val fillHint = TextView(this).apply { textSize = 12f; setTextColor(muted) }
            col.addView(fillHint)
            var opacity = (fill.faces.values.firstOrNull { it != 0 } ?: fill.all).let { if (it == 0) 0.6f else Color.alpha(it) / 255f }
            fun withA(c: Int) = Color.argb((opacity * 255).roundToInt().coerceIn(0, 255), Color.red(c), Color.green(c), Color.blue(c))
            fun paint(c: Int?) {
                val v = c?.let { withA(it) } ?: 0
                if (picked.isEmpty()) { fill.all = v; fill.faces.clear() } else picked.forEach { fill.faces[it] = v }
                live.invalidate()
            }
            val swatches = listOf(
                Color.rgb(0x16, 0x1A, 0x22), Color.rgb(0x8A, 0x92, 0x9E), Color.rgb(0xEC, 0xEC, 0xEC), Color.rgb(0x29, 0x47, 0xC9),
                Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0xAC, 0xC1), Color.rgb(0x2E, 0x7D, 0x32), Color.rgb(0x7C, 0xB3, 0x42),
                Color.rgb(0xF9, 0xA8, 0x25), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0xB7, 0x1C, 0x1C), Color.rgb(0xE9, 0x1E, 0x63), Color.rgb(0x8E, 0x24, 0xAA),
            )
            val swatchRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            swatchRow.addView(TextView(this).apply {
                text = "None"; textSize = 12f; gravity = Gravity.CENTER; setTextColor(onSurface)
                background = pill(light); setPadding(dp(10), dp(6), dp(10), dp(6))
                layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = dp(6) }
                setOnClickListener { paint(null) }
            })
            for (c in swatches) swatchRow.addView(View(this).apply {
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(c); setStroke(dp(1), Color.argb(0x40, 0x80, 0x80, 0x80)) }
                layoutParams = LinearLayout.LayoutParams(dp(28), dp(28)).apply { rightMargin = dp(6) }
                setOnClickListener { paint(c) }
            })
            col.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(swatchRow); setPadding(0, dp(6), 0, dp(2)) })
            // Opacity: also re-tints whatever is picked (or every face) as you slide.
            val opLabel = heading("OPACITY")
            val opValue = TextView(this).apply { textSize = 12f; setTextColor(muted) }
            col.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM
                addView(opLabel, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)); addView(opValue)
            })
            col.addView(SeekBar(this).apply {
                max = 100; progress = (opacity * 100).roundToInt()
                opValue.text = "$progress%"
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(sb: SeekBar?, pr: Int, fromUser: Boolean) {
                        if (!fromUser) return
                        opacity = pr / 100f; opValue.text = "$pr%"
                        if (picked.isEmpty()) {
                            if (fill.all != 0) fill.all = withA(fill.all)
                            for (k in fill.faces.keys.toList()) fill.faces[k]?.let { if (it != 0) fill.faces[k] = withA(it) }
                        } else picked.forEach { r -> val cur = fill.colorOf(r); if (cur != 0) fill.faces[r] = withA(cur) }
                        live.invalidate()
                    }
                    override fun onStartTrackingTouch(sb: SeekBar?) {}
                    override fun onStopTrackingTouch(sb: SeekBar?) {}
                })
            })
            val pickRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            pickRow.addView(chip("Pick all faces") { picked.clear(); for (i in 0 until Solid(p).regionCount()) picked.add(i); refreshFill() }.also { styleChip(it, false) })
            pickRow.addView(chip("Clear picks") { picked.clear(); refreshFill() }.also { styleChip(it, false) })
            col.addView(pickRow, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) })

            // Water: how full the solid is; the surface stays level with the page as the solid turns.
            val wLabel = heading("WATER")
            val wValue = TextView(this).apply { textSize = 12f; setTextColor(muted) }
            col.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM
                addView(wLabel, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)); addView(wValue)
            })
            col.addView(SeekBar(this).apply {
                max = 100; progress = (fill.water * 100).roundToInt()
                wValue.text = if (progress == 0) "Empty" else "$progress% full"
                setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(sb: SeekBar?, pr: Int, fromUser: Boolean) {
                        if (!fromUser) return
                        fill.water = pr / 100f; wValue.text = if (pr == 0) "Empty" else "$pr% full"; live.invalidate()
                    }
                    override fun onStartTrackingTouch(sb: SeekBar?) {}
                    override fun onStopTrackingTouch(sb: SeekBar?) {}
                })
            })
            refreshFill = {
                fillHint.text = if (picked.isEmpty()) "No faces picked: a color fills every face." else "${picked.size} face${if (picked.size == 1) "" else "s"} picked: a color fills just those."
                live.invalidate()
            }
            refreshFill()
        } else refreshFill = {}

        // Actions
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) }
            addView(chip("Cancel") { dialog.dismiss() }.also { styleChip(it, false) })
            addView(chip(doneLabel) { dialog.dismiss(); onDone(p.copy(), fill) }.also { styleChip(it, true) })
        })

        var lastKey = p.key()
        refresh = {
            for ((k, v) in kindChips) styleChip(v, p.kind == k)
            val platonic = p.kind == SolidKind.PLATONIC
            val sphere = p.kind == SolidKind.SPHERE || p.kind == SolidKind.TRAPEZOID   // no sides to choose
            symHeading.visibility = if (sphere) View.GONE else View.VISIBLE
            symHeading.text = if (platonic) "FACES  (REGULAR SOLIDS)" else "SIDES  (n-FOLD SYMMETRY)"
            sidesRow.visibility = if (platonic || sphere) View.GONE else View.VISIBLE
            facesRow.visibility = if (platonic) View.VISIBLE else View.GONE
            for ((f, v) in faceChips) styleChip(v, p.n == f)
            sidesValue.text = if (p.isRound) "∞" else "${p.sides}"
            roundChip.visibility = if (p.kind.roundable) View.VISIBLE else View.GONE
            styleChip(roundChip, p.isRound)
            topBox.visibility = if (p.kind == SolidKind.FRUSTUM || p.kind == SolidKind.TRAPEZOID) View.VISIBLE else View.GONE
            heightSync(); depthSync(); topSync()
            val counts = p.counts()
            readout.text = p.label.replaceFirstChar { it.uppercase() } +
                (counts?.let { (f, e, v) -> "\n$f faces · $e edges · $v vertices" } ?: "\ncurved surface")
            preview.setImageBitmap(solidPreview(p, dp(150), fill = 0.42f))
            // A different shape has different faces: per-face colors and picks no longer line up.
            if (p.key() != lastKey) { lastKey = p.key(); fill?.faces?.clear(); picked.clear(); refreshFill() }
            live?.params = p; live?.invalidate()
        }
        refresh()
        dialog.show()
    }

    /** Fill color + opacity for a closed 2D shape ([current] = its fill, 0 = none). */
    private fun showFillDialog(current: Int, onApply: (Int) -> Unit) {
        val pad = dp(20)
        val muted = Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, dp(16))
        }
        val dialog = Dialog(this).apply {
            setContentView(col, ViewGroup.LayoutParams(dp(340), WRAP_CONTENT))
            window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }
        col.addView(TextView(this).apply { text = "Fill"; setTextColor(AppTheme.text); textSize = 17f; setTypeface(null, android.graphics.Typeface.BOLD) })
        var color = if (current != 0) Color.rgb(Color.red(current), Color.green(current), Color.blue(current)) else 0
        var opacity = if (current != 0) Color.alpha(current) / 255f else 0.5f
        val sample = View(this)
        fun result() = if (color == 0) 0 else Color.argb((opacity * 255).roundToInt().coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))
        fun paintSample() {
            sample.background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat(); setColor(result()); setStroke(dp(2), AppTheme.text)
            }
        }
        col.addView(sample, LinearLayout.LayoutParams(MATCH_PARENT, dp(44)).apply { topMargin = dp(12) })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        row.addView(TextView(this).apply {
            text = "None"; textSize = 12f; setTextColor(onSurface); background = pill(light); setPadding(dp(10), dp(6), dp(10), dp(6))
            layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = dp(6) }
            setOnClickListener { color = 0; paintSample() }
        })
        for (c in palette.toList() + customColors) row.addView(View(this).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(c); setStroke(dp(1), Color.argb(0x40, 0x80, 0x80, 0x80)) }
            layoutParams = LinearLayout.LayoutParams(dp(28), dp(28)).apply { rightMargin = dp(6) }
            setOnClickListener { color = c; paintSample() }
        })
        col.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(row); setPadding(0, dp(12), 0, 0) })
        val opValue = TextView(this).apply { textSize = 12f; setTextColor(muted); text = "${(opacity * 100).roundToInt()}%" }
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(12), 0, dp(2))
            addView(TextView(this@InkActivity).apply { text = "OPACITY"; textSize = 11f; setTextColor(muted); setTypeface(null, android.graphics.Typeface.BOLD) }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(opValue)
        })
        col.addView(SeekBar(this).apply {
            max = 100; progress = (opacity * 100).roundToInt()
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, pr: Int, fromUser: Boolean) { if (fromUser) { opacity = pr / 100f; opValue.text = "$pr%"; paintSample() } }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) {}
            })
        })
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) }
            addView(iconBtn(Icons.CLOSE) { dialog.dismiss() })
            addView(View(this@InkActivity), LinearLayout.LayoutParams(dp(8), 1))
            addView(iconBtn(Icons.CHECK, active = true) { dialog.dismiss(); onApply(result()) })
        })
        paintSample()
        dialog.show()
    }

    private fun clearPendingShape() {
        if (pendingShape == null) return
        pendingShape = null
        for (b in listOf(shapeButton, tableButton)) { b?.background = pill(light); b?.setColorFilter(onSurface) }
    }

    private fun shapeLabel(t: ShapeType) = when (t) {
        ShapeType.LINE -> "line"; ShapeType.ARROW -> "arrow"; ShapeType.RECT -> "rectangle"
        ShapeType.ELLIPSE -> "ellipse"; ShapeType.TRIANGLE -> "triangle"; ShapeType.TRAPEZOID -> "trapezoid"
        ShapeType.AXES2D_1Q -> "1-quadrant axis"; ShapeType.AXES2D_2Q -> "2-quadrant axis"; ShapeType.AXES2D -> "4-quadrant axis"
        ShapeType.AXES3D -> "3D axis"; ShapeType.AXES3D_8 -> "8-octant 3D axis"; ShapeType.TABLE -> "table"
        ShapeType.SOLID -> pendingSolid?.label ?: "solid"
        ShapeType.BOX -> "box"; ShapeType.CYLINDER -> "cylinder"; ShapeType.CONE -> "cone"
        ShapeType.SPHERE -> "sphere"; ShapeType.PYRAMID -> "pyramid"; ShapeType.GRAPH -> "graph"
    }

    /**
     * Table tool: pick rows x columns, then a bordered or borderless grid; the next drag (or tap)
     * places it. Select a table afterwards to add/remove rows and columns or toggle its border.
     */
    private fun showTableMenu(anchor: View) {
        val muted = Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x30, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        val popup = PopupWindow(col, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(10).toFloat() }
        val tiles = ArrayList<Pair<Boolean, ImageView>>()
        fun refreshPreviews() {
            for ((b, iv) in tiles) iv.setImageBitmap(shapePreview(ShapeType.TABLE, dp(56)) { it.rows = tableRows; it.cols = tableCols; it.border = b })
        }
        fun stepper(label: String, isRows: Boolean): View {
            fun get() = if (isRows) tableRows else tableCols
            val value = TextView(this).apply { text = get().toString(); textSize = 15f; setTextColor(onSurface); gravity = Gravity.CENTER; minWidth = dp(30) }
            fun step(glyph: String, d: Int) = TextView(this).apply {
                text = glyph; textSize = 18f; setTextColor(onSurface); gravity = Gravity.CENTER
                background = pill(light); layoutParams = LinearLayout.LayoutParams(dp(38), dp(34))
                setOnClickListener {
                    val n = (get() + d).coerceIn(1, 20)
                    if (isRows) tableRows = n else tableCols = n
                    value.text = n.toString(); saveBrushPref(); refreshPreviews()
                }
            }
            return LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(4), 0, dp(4))
                addView(TextView(this@InkActivity).apply { text = label; textSize = 13f; setTextColor(muted) }, LinearLayout.LayoutParams(dp(72), WRAP_CONTENT))
                addView(step("\u2212", -1)); addView(value); addView(step("+", 1))
            }
        }
        col.addView(stepper("Rows", true))
        col.addView(stepper("Columns", false))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(6), 0, 0) }
        for ((b, name) in listOf(true to "Bordered", false to "No border")) {
            val on = b == tableBorder
            val iv = ImageView(this).apply {
                layoutParams = LinearLayout.LayoutParams(dp(56), dp(56))
                setColorFilter(if (on) AppTheme.onAccent() else onSurface)
            }
            tiles.add(b to iv)
            row.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
                background = pill(if (on) accent else light); stateListAnimator = null
                setPadding(dp(8), dp(6), dp(8), dp(6))
                layoutParams = LinearLayout.LayoutParams(dp(92), WRAP_CONTENT).apply { setMargins(dp(4), 0, dp(4), 0) }
                addView(iv)
                addView(TextView(this@InkActivity).apply {
                    text = name; textSize = 11f; gravity = Gravity.CENTER
                    setTextColor(if (on) AppTheme.onAccent() else onSurface)
                })
                setOnClickListener {
                    // A borderless 1x1 table would have no lines at all.
                    if (!b && tableRows + tableCols < 3) { Toast.makeText(this@InkActivity, "Add a row or column first", Toast.LENGTH_SHORT).show(); return@setOnClickListener }
                    tableBorder = b; saveBrushPref(); popup.dismiss(); armShape(ShapeType.TABLE)
                }
            })
        }
        col.addView(row)
        refreshPreviews()
        popup.showAsDropDown(anchor, 0, dp(6))
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

    /** Eraser size: one-tap presets plus a fine slider, with a ring previewing its on-screen reach. */
    private fun showEraserSizePopup(anchor: View) {
        val pad = dp(16)
        val muted = Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val previewH = dp(96)
        val preview = object : View(this) {
            private val ring = android.graphics.Paint().apply {
                isAntiAlias = true; style = android.graphics.Paint.Style.STROKE; strokeWidth = dp(2).toFloat(); color = muted
            }
            private val fill = android.graphics.Paint().apply {
                isAntiAlias = true; style = android.graphics.Paint.Style.FILL; color = Color.argb(0x22, 0x80, 0x80, 0x80)
            }
            override fun onDraw(c: android.graphics.Canvas) {
                // Same size it will be on the page at the current zoom (capped to the preview box).
                val r = (eraserSize * (focused?.scale ?: 1f)).coerceIn(dp(2).toFloat(), height / 2f - dp(2))
                c.drawCircle(width / 2f, height / 2f, r, fill)
                c.drawCircle(width / 2f, height / 2f, r, ring)
            }
        }.apply { layoutParams = LinearLayout.LayoutParams(dp(240), previewH) }

        val sizeLabel = TextView(this).apply { text = "%.0f".format(eraserSize); textSize = 12f; setTextColor(muted); gravity = Gravity.CENTER }
        val seek = SeekBar(this).apply {
            max = brushSteps; progress = progressForEraser(eraserSize)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                    if (!fromUser) return
                    eraserSize = eraserForProgress(p); sizeLabel.text = "%.0f".format(eraserSize); preview.invalidate()
                }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) { saveBrushPref() }
            })
        }

        val popup = PopupWindow(LinearLayout(this), WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(10).toFloat() }
        val presets = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        for ((i, r) in listOf(6f, 13f, 24f, 44f).withIndex()) {
            presets.addView(View(this).apply {
                val d = dp(10 + i * 6)
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT); setStroke(dp(2), onSurface) }
                layoutParams = LinearLayout.LayoutParams(d, d).apply { setMargins(dp(10), 0, dp(10), 0) }
                setOnClickListener {
                    eraserSize = r; seek.progress = progressForEraser(r); sizeLabel.text = "%.0f".format(r)
                    saveBrushPref(); popup.dismiss()
                }
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
            addView(TextView(this@InkActivity).apply {
                text = "ERASER SIZE"; textSize = 11f; setTextColor(muted)
                setTypeface(null, android.graphics.Typeface.BOLD); letterSpacing = 0.04f
            }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(10) })
            addView(presets, LinearLayout.LayoutParams(MATCH_PARENT, dp(44)).apply { topMargin = dp(4) })
            addView(seek, LinearLayout.LayoutParams(dp(240), WRAP_CONTENT).apply { topMargin = dp(2) })
            addView(sizeLabel, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        popup.contentView = col
        popup.showAsDropDown(anchor, 0, dp(6))
    }

    private fun smoothingText(): String = when {
        smoothing < 0.03f -> "Off"
        smoothing < 0.35f -> "Light · ${(smoothing * 100).roundToInt()}%"
        smoothing < 0.7f -> "Medium · ${(smoothing * 100).roundToInt()}%"
        else -> "Strong · ${(smoothing * 100).roundToInt()}%"
    }

    private fun showColorPicker(anchor: View, onPick: (Int) -> Unit) = colorPopup(onPick).showAsDropDown(anchor, 0, dp(6))

    /**
     * The palette grid as a popup (shown under the color button, or at a selection's menu). Under the
     * grid: a color-wheel button + your most recent custom colors. The wheel swaps in place of the
     * grid (same popup, same spot) so picking a custom color never moves you off the pen.
     */
    private fun colorPopup(onPick: (Int) -> Unit): PopupWindow {
        val pad = dp(10)
        val muted = Color.argb(0xB0, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat(); setColor(AppTheme.surface)
                setStroke(dp(1), Color.argb(0x30, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
            }
            setPadding(pad, pad, pad, pad)
        }
        val popup = PopupWindow(col, WRAP_CONTENT, WRAP_CONTENT, true).apply { elevation = dp(8).toFloat() }
        val sz = dp(42); val m = dp(4)
        fun swatch(c: Int) = View(this).apply {
            background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(c); setStroke(dp(1), Color.argb(0x33, 0x80, 0x80, 0x80)) }
            setOnClickListener { onPick(c); popup.dismiss() }
        }

        val grid = GridLayout(this).apply { columnCount = 5 }
        for (c in palette) grid.addView(swatch(c).apply {
            layoutParams = GridLayout.LayoutParams().apply { width = sz; height = sz; setMargins(m, m, m, m) }
        })

        // Custom row: wheel button, then the recent custom colors (newest first), aligned to the grid.
        val wheelBtn = View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL; gradientType = GradientDrawable.SWEEP_GRADIENT
                colors = intArrayOf(Color.RED, Color.MAGENTA, Color.BLUE, Color.CYAN, Color.GREEN, Color.YELLOW, Color.RED)
                setStroke(dp(2), AppTheme.surface)
            }
            contentDescription = "Custom color"
            layoutParams = LinearLayout.LayoutParams(sz, sz).apply { setMargins(m, m, m, m) }
        }
        val customRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(wheelBtn)
            for (c in customColors) addView(swatch(c).apply {
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(c); setStroke(dp(1), Color.argb(0x33, 0x80, 0x80, 0x80)) }
                layoutParams = LinearLayout.LayoutParams(sz, sz).apply { setMargins(m, m, m, m) }
            })
        }
        val paletteView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(grid)
            addView(View(this@InkActivity).apply { setBackgroundColor(Color.argb(0x22, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))) },
                LinearLayout.LayoutParams(MATCH_PARENT, dp(1)).apply { setMargins(m, dp(4), m, dp(4)) })
            addView(customRow)
        }

        // ---- wheel panel (hidden until the wheel button is tapped) ----
        var showWheel: (Boolean) -> Unit = {}
        // Start on the current pen's hue; a near-black pen would leave the whole wheel dark, so open at full brightness then.
        val wheel = ColorWheelView(this).apply { setColor(brushColor); if (value < 0.3f) value = 1f }
        val previewBg = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(wheel.color); setStroke(dp(1), Color.argb(0x40, 0x80, 0x80, 0x80)) }
        val hexLabel = TextView(this).apply { textSize = 13f; setTextColor(onSurface); typeface = android.graphics.Typeface.MONOSPACE }
        fun hex(c: Int) = "#%06X".format(c and 0xFFFFFF)
        hexLabel.text = hex(wheel.color)
        fun refresh(c: Int) { previewBg.setColor(c); hexLabel.text = hex(c) }
        wheel.onChange = { refresh(it) }
        val valueSeek = SeekBar(this).apply {
            max = 100; progress = (wheel.value * 100f).roundToInt()
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) { wheel.value = p / 100f; refresh(wheel.color) }
                override fun onStartTrackingTouch(sb: SeekBar?) {}
                override fun onStopTrackingTouch(sb: SeekBar?) {}
            })
        }
        val wheelPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; visibility = View.GONE
            addView(wheel, LinearLayout.LayoutParams(dp(200), dp(200)).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(TextView(this@InkActivity).apply {
                text = "BRIGHTNESS"; textSize = 11f; setTextColor(muted)
                setTypeface(null, android.graphics.Typeface.BOLD); letterSpacing = 0.04f
            }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = dp(6); leftMargin = m })
            addView(valueSeek, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(LinearLayout(this@InkActivity).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(6), 0, 0)
                addView(ImageButton(this@InkActivity).apply {
                    setImageBitmap(Icons.bitmap(Icons.BACK, dp(16))); setColorFilter(onSurface)
                    background = pill(light); contentDescription = "Back to palette"
                    setOnClickListener { showWheel(false) }
                }, LinearLayout.LayoutParams(dp(36), dp(36)))
                addView(View(this@InkActivity).apply { background = previewBg }, LinearLayout.LayoutParams(dp(30), dp(30)).apply { leftMargin = dp(10) })
                addView(hexLabel, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { leftMargin = dp(8) })
                addView(TextView(this@InkActivity).apply {
                    text = "Use"; textSize = 14f; setTextColor(AppTheme.onAccent()); gravity = Gravity.CENTER
                    setTypeface(null, android.graphics.Typeface.BOLD)
                    background = pill(accent); setPadding(dp(18), 0, dp(18), 0)
                    setOnClickListener { val c = wheel.color; rememberCustomColor(c); onPick(c); popup.dismiss() }
                }, LinearLayout.LayoutParams(WRAP_CONTENT, dp(36)))
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        showWheel = { on ->
            paletteView.visibility = if (on) View.GONE else View.VISIBLE
            wheelPanel.visibility = if (on) View.VISIBLE else View.GONE
            col.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
            popup.update(col.measuredWidth, col.measuredHeight)
        }
        wheelBtn.setOnClickListener { showWheel(true) }

        col.addView(paletteView)
        col.addView(wheelPanel, LinearLayout.LayoutParams(paletteWidth(sz, m), WRAP_CONTENT))
        return popup
    }

    /** Width of the 5-column palette grid, so the wheel panel takes the same footprint. */
    private fun paletteWidth(sz: Int, m: Int) = 5 * (sz + 2 * m)

    /** Push a wheel-picked color to the front of the recents (deduped, capped to fit the custom row). */
    private fun rememberCustomColor(c: Int) {
        customColors.remove(c); customColors.add(0, c)
        while (customColors.size > MAX_CUSTOM_COLORS) customColors.removeAt(customColors.size - 1)
        getSharedPreferences(INK_PREFS, MODE_PRIVATE).edit()
            .putString("customColors", org.json.JSONArray(customColors).toString()).apply()
        InkSettings.markChanged(this)
    }

    private fun saveBrushPref() {
        getSharedPreferences(INK_PREFS, MODE_PRIVATE).edit()
            .putFloat("brushSize", brushSize).putInt("brushColor", brushColor)
            .putFloat("smoothing", smoothing).putFloat("eraserSize", eraserSize).putString("brush", brush.name)
            .putBoolean("shapeDashed", pendingShapeDashed).putBoolean("shapeHashed", pendingShapeHashed)
            .putInt("tableRows", tableRows).putInt("tableCols", tableCols).putBoolean("tableBorder", tableBorder).apply()
        InkSettings.markChanged(this)
    }

    // ---------- attach & submit to an assignment ----------
    /**
     * Pick one of your open assignments (read from your EngOrg account) and hand this notebook to it:
     * Gradescope ones are uploaded by EngOrg on your PC (which then marks it done, and opens
     * Gradescope's page matching when the assignment needs it); anything else, or any failure, saves
     * the PDF to Downloads and opens the assignment page.
     */
    private fun showSubmitDialog() {
        val pane = focused ?: return
        val acct = CloudAuth.account(this)
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
            addView(ImageView(this@InkActivity).apply { setImageBitmap(Icons.bitmap(Icons.SUBMIT, dp(22))); setColorFilter(AppTheme.accent); layoutParams = LinearLayout.LayoutParams(dp(22), dp(22)).apply { rightMargin = dp(10) } })
            addView(TextView(this@InkActivity).apply { text = "Attach & submit"; setTextColor(AppTheme.text); textSize = 17f; setTypeface(null, android.graphics.Typeface.BOLD) })
        })
        col.addView(android.widget.ScrollView(this).apply { addView(body) }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) })
        val dialog = Dialog(this).apply {
            setContentView(col, ViewGroup.LayoutParams(dp(380), WRAP_CONTENT))
            window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }
        fun note(t: String, color: Int = muted) = TextView(this).apply { text = t; setTextColor(color); textSize = 13f; setLineSpacing(0f, 1.2f); setPadding(0, dp(4), 0, dp(4)) }
        fun button(label: String, primary: Boolean, onClick: () -> Unit) = TextView(this).apply {
            text = label; textSize = 14f; gravity = Gravity.CENTER; setTypeface(null, android.graphics.Typeface.BOLD); stateListAnimator = null
            background = pill(if (primary) accent else light); setTextColor(if (primary) AppTheme.onAccent() else onSurface)
            setPadding(dp(14), dp(11), dp(14), dp(11))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) }
            setOnClickListener { onClick() }
        }
        fun dueText(d: String): String {
            if (d.isBlank()) return "no due date"
            return try {
                // java.time needs Android 8; SimpleDateFormat works back to minSdk 24.
                val date = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).parse(d.take(10)) ?: return "due $d"
                fun dayNo(t: Long) = (t + java.util.TimeZone.getDefault().getOffset(t)) / 86_400_000L
                val days = dayNo(date.time) - dayNo(System.currentTimeMillis())
                val day = when (days) { 0L -> "today"; 1L -> "tomorrow"; -1L -> "yesterday"; else -> java.text.SimpleDateFormat("EEE MMM d", java.util.Locale.getDefault()).format(date) }
                "due $day" + (if (d.length > 11) " " + d.substring(11, minOf(16, d.length)) else "")
            } catch (_: Exception) { "due $d" }
        }
        if (acct == null) {
            body.addView(note("EngInk needs your EngOrg sign-in for this. Open Ink from the EngOrg app while you're signed in, then try again.", AppTheme.text))
            body.addView(button("Close", false) { dialog.dismiss() })
            dialog.show(); return
        }
        val fs = FirestoreRest(acct)
        val ui = android.os.Handler(android.os.Looper.getMainLooper())

        fun showResult(a: AssignmentSubmit.Assignment, o: AssignmentSubmit.Outcome) {
            body.removeAllViews()
            when (o) {
                is AssignmentSubmit.Outcome.Submitted -> {
                    body.addView(note(if (o.matchPages) "Uploaded to Gradescope and marked done." else "Submitted to Gradescope and marked done.", AppTheme.text).apply { textSize = 15f; setTypeface(null, android.graphics.Typeface.BOLD) })
                    if (o.matchPages) body.addView(note("Gradescope needs you to match pages to questions. It's open on your PC. You can also do it here."))
                    o.url?.let { u -> body.addView(button(if (o.matchPages) "Match pages on the tablet" else "Open in Gradescope", false) { try { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(u))) } catch (_: Exception) { } }) }
                }
                is AssignmentSubmit.Outcome.Fallback -> {
                    body.addView(note("Not submitted automatically", AppTheme.text).apply { textSize = 15f; setTypeface(null, android.graphics.Typeface.BOLD) })
                    body.addView(note(o.why))
                    body.addView(note(
                        (o.saved?.let { "The PDF is saved to $it. " } ?: "") +
                        (if (a.url != null) "The assignment page is open, so upload it there." else "This note has no assignment link, so upload it yourself.")))
                    body.addView(button("Mark it done in EngOrg", false) {
                        Thread { val ok = try { AssignmentSubmit.requestDone(fs, a); true } catch (_: Exception) { false }
                            ui.post { Toast.makeText(this, if (ok) "Marked done (EngOrg updates it next time it's open)" else "Couldn't reach your EngOrg account", Toast.LENGTH_SHORT).show() } }.start()
                    })
                }
            }
            body.addView(button("Done", true) { dialog.dismiss() })
        }

        fun confirm(a: AssignmentSubmit.Assignment) {
            body.removeAllViews()
            body.addView(TextView(this).apply { text = a.title; setTextColor(AppTheme.text); textSize = 16f; setTypeface(null, android.graphics.Typeface.BOLD) })
            body.addView(note(listOf(a.sourceLabel, a.course, dueText(a.due)).filter { it.isNotBlank() }.joinToString(" · ")))
            var onlyPage = false
            val scope = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(0, dp(8), 0, 0) }
            lateinit var paint: () -> Unit
            fun chip(label: String, sel: () -> Boolean, set: () -> Unit) = TextView(this).apply {
                text = label; textSize = 13f; gravity = Gravity.CENTER; stateListAnimator = null
                setPadding(dp(12), dp(7), dp(12), dp(7))
                layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = dp(6) }
                tag = sel; setOnClickListener { set(); paint() }
            }
            val c1 = chip("Whole notebook (${pane.pageCount()} pages)", { !onlyPage }) { onlyPage = false }
            val c2 = chip("Just page ${pane.currentPage() + 1}", { onlyPage }) { onlyPage = true }
            paint = { for (c in listOf(c1, c2)) { @Suppress("UNCHECKED_CAST") val on = (c.tag as () -> Boolean)(); c.background = pill(if (on) accent else light); c.setTextColor(if (on) AppTheme.onAccent() else onSurface) } }
            scope.addView(c1); scope.addView(c2); paint()
            body.addView(scope)
            body.addView(note(if (a.viaGradescope)
                "EngOrg on your PC uploads it to Gradescope and marks it done. If the assignment needs pages matched to questions, Gradescope opens so you can do that. Keep EngOrg open and signed in on the PC."
            else "${a.sourceLabel} can't be submitted automatically, so this saves the PDF to Downloads and opens the assignment for you to upload."))
            val status = note("")
            body.addView(button(if (a.viaGradescope) "Submit" else "Save PDF & open assignment", true) {
                body.removeAllViews()
                body.addView(TextView(this).apply { text = a.title; setTextColor(AppTheme.text); textSize = 16f; setTypeface(null, android.graphics.Typeface.BOLD) })
                body.addView(status); status.text = "Making the PDF…"
                dialog.setCancelable(false)
                val pdf = pane.exportPdf(cacheDir, if (onlyPage) pane.currentPage() else null)
                if (pdf == null) { status.text = "Couldn't build the PDF."; dialog.setCancelable(true); return@button }
                Thread {
                    val o = AssignmentSubmit.submit(this, fs, a, pdf) { msg -> ui.post { status.text = msg } }
                    ui.post { dialog.setCancelable(true); showResult(a, o) }
                }.start()
            })
            body.addView(button("Back", false) { showList() })
        }

        showListFn = {
            body.removeAllViews()
            body.addView(note("Loading your assignments…"))
            Thread {
                val res = try { Result.success(AssignmentSubmit.load(fs)) } catch (e: Exception) { Result.failure(e) }
                ui.post {
                    if (!dialog.isShowing) return@post
                    body.removeAllViews()
                    val list = res.getOrNull()
                    if (list == null) { body.addView(note(res.exceptionOrNull()?.message ?: "Couldn't load your assignments.", AppTheme.text)); return@post }
                    if (list.isEmpty()) { body.addView(note("No open assignments in EngOrg.")); return@post }
                    body.addView(note("Which assignment is this notebook for?"))
                    for (a in list.take(60)) body.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated) }
                        setPadding(dp(12), dp(9), dp(12), dp(9))
                        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) }
                        addView(TextView(this@InkActivity).apply { text = a.title; setTextColor(AppTheme.text); textSize = 14.5f; setTypeface(null, android.graphics.Typeface.BOLD); maxLines = 2 })
                        addView(TextView(this@InkActivity).apply {
                            text = listOf(a.sourceLabel + (if (a.viaGradescope) " · auto-submit" else ""), a.course, dueText(a.due)).filter { it.isNotBlank() }.joinToString(" · ")
                            setTextColor(muted); textSize = 12f
                        })
                        setOnClickListener { confirm(a) }
                    })
                }
            }.start()
        }
        showList()
        dialog.show()
    }
    private var showListFn: () -> Unit = {}
    private fun showList() = showListFn()

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
        for (acc in accounts) col.addView(accountTile(acc, acc.email == saved) { EmailPrefs.setSavedEmail(this, acc.email); InkSettings.markChanged(this); dialog.dismiss(); onPick(acc.email) })
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(14), dp(6), dp(6))
            addView(ImageView(this@InkActivity).apply { setImageBitmap(Icons.bitmap(Icons.ADD, dp(22))); setColorFilter(AppTheme.accent); layoutParams = LinearLayout.LayoutParams(dp(22), dp(22)) })
            setOnClickListener { dialog.dismiss(); promptEmail { e -> EmailPrefs.setSavedEmail(this@InkActivity, e); InkSettings.markChanged(this@InkActivity); onPick(e) } }
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
                // Over the internet: works on any network (no address, no code).
                body.addView(pillRow {
                    addView(ImageView(this@InkActivity).apply { setImageBitmap(Icons.bitmap(Icons.CAST, dp(20))); setColorFilter(AppTheme.accent); layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(12) } })
                    val sub = TextView(this@InkActivity).apply { text = "Works on any Wi-Fi. Your PC just needs EngOrg open and signed in."; setTextColor(muted); textSize = 12f }
                    addView(LinearLayout(this@InkActivity).apply {
                        orientation = LinearLayout.VERTICAL
                        addView(TextView(this@InkActivity).apply { text = "Mirror over the internet"; setTextColor(AppTheme.text); textSize = 15f; setTypeface(null, android.graphics.Typeface.BOLD) })
                        addView(sub)
                    })
                    setOnClickListener {
                        sub.text = "Connecting…"
                        MirrorManager.connectInternet(this@InkActivity) { ok, msg -> if (ok) render() else sub.text = msg }
                    }
                })
                body.addView(TextView(this).apply { text = "On the same Wi-Fi"; setTextColor(muted); textSize = 12f; setTypeface(null, android.graphics.Typeface.BOLD); setPadding(0, dp(16), 0, dp(2)) })
                val status = TextView(this).apply { text = "Searching for computers on your Wi-Fi…"; setTextColor(muted); textSize = 13f }
                body.addView(status)
                val listWrap = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
                body.addView(listWrap, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

                fun connectTo(host: String, port: Int, code: String) {
                    status.text = "Connecting to $host…"
                    MirrorManager.connect(host, port, code) { ok, msg -> if (ok) render() else status.text = "$msg. If your Wi-Fi blocks devices from reaching each other, use Mirror over the internet above." }
                }

                MirrorManager.discover { peers ->
                    if (!dialog.isShowing) return@discover
                    status.text = if (peers.isEmpty()) "No computers found on this Wi-Fi. Many apartment and campus networks block devices from seeing each other. If so, use Mirror over the internet above." else "Tap your computer:"
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

                body.addView(TextView(this).apply {
                    text = "Or type it in. On your PC, open EngOrg → Engineering → EngInk to see its address (This PC) and the 6-digit pairing code."
                    setTextColor(muted); textSize = 12f; setPadding(0, dp(16), 0, dp(2))
                })
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
