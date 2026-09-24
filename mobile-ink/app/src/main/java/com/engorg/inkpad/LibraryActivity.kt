package com.engorg.inkpad

import android.app.Dialog
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts

/** Notebook browser: tap a folder to open it, tap a notebook to write. Icon-only chrome. */
class LibraryActivity : ComponentActivity() {

    private lateinit var store: NotebookStore
    private lateinit var content: LinearLayout
    private lateinit var titleView: TextView
    private lateinit var backButton: ImageButton
    private var currentFolder: String? = null
    private lateinit var importPicker: ActivityResultLauncher<Array<String>>

    private val covers = intArrayOf(
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0x89, 0x7B),
        Color.rgb(0x2E, 0x7D, 0x32), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0xDC, 0x26, 0x50),
        Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0x45, 0x4B, 0x55),
    )
    private val pageColors = intArrayOf(
        Color.WHITE,
        Color.rgb(0xFB, 0xF7, 0xEC), // warm ivory
        Color.rgb(0xFC, 0xF6, 0xD8), // soft cream-yellow
        Color.rgb(0xFA, 0xEF, 0xC0), // butter
        Color.rgb(0xF7, 0xE9, 0x8E), // legal pad
        Color.rgb(0xF1, 0xDE, 0x6E), // deeper yellow
        Color.rgb(0xF3, 0xF4, 0xF6), // cool gray
        Color.rgb(0xEA, 0xF3, 0xEC), // mint
        Color.rgb(0x22, 0x27, 0x31), // slate (dark)
        Color.rgb(0x0F, 0x11, 0x16), // near-black
    )
    private val paperOptions = listOf("PLAIN", "GRID", "RULED", "DOTS")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppTheme.load(this)
        SystemBars.setup(this, lightBackground = !AppTheme.dark)
        store = NotebookStore(filesDir)
        importPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) runImport(uri) }

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(AppTheme.bg); clipChildren = false }
        val bar = buildBar()
        root.addView(bar)
        val scroll = ScrollView(this).apply { clipToPadding = false; isVerticalScrollBarEnabled = false }
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; clipChildren = false; clipToPadding = false
            setPadding(dp(16), dp(12), dp(16), dp(48))
        }
        scroll.addView(content)
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)
        // Edge-to-edge on Android 15: keep the top bar below the status bar and the last row of
        // cards above the nav bar.
        SystemBars.padTopForStatusBar(bar)
        SystemBars.padBottomForNavBar(content)

        // Also surface a newer sideloaded build here (throttled) — not only at the WebView shell's
        // cold start — so a long-running session still notices updates when you open the library.
        InkUpdater.checkInBackground(this)

        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!goUp()) { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        store.reload()
        if (currentFolder != null && store.folders.none { it.id == currentFolder }) currentFolder = null
        rebuild()
    }

    // This activity handles orientation itself (configChanges), so it won't recreate on rotate —
    // rebuild so the grid re-flows to the new width (landscape gets more columns).
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        rebuild()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    /** Columns that fit the current width (each tile is ~150dp + 12dp margins). Landscape → more. */
    private fun gridColumns(): Int {
        val avail = resources.displayMetrics.widthPixels - dp(32) // content h-padding (16 each side)
        return (avail / dp(162)).coerceIn(2, 8)
    }
    private fun muted() = Color.argb(0x99, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text))
    private fun pillBg(color: Int) = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(color) }

    /** A rounded pill with a Material touch ripple, for tappable chrome. */
    private fun pill(color: Int): Drawable {
        val ripple = Color.argb(0x3A, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text))
        val mask = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(Color.WHITE) }
        return RippleDrawable(ColorStateList.valueOf(ripple), pillBg(color), mask)
    }

    /** Touch-ripple foreground (leaves the view's own background intact), clipped to a rounded rect. */
    private fun rippleFg(radiusDp: Int, tint: Int): Drawable {
        val mask = GradientDrawable().apply { cornerRadius = dp(radiusDp).toFloat(); setColor(Color.WHITE) }
        return RippleDrawable(ColorStateList.valueOf(tint), null, mask)
    }

    /** Shift a color toward white (f>0) or black (f<0) by fraction |f|, for cover depth. */
    private fun shade(c: Int, f: Float): Int = if (f >= 0)
        Color.rgb(
            (Color.red(c) + (255 - Color.red(c)) * f).toInt(),
            (Color.green(c) + (255 - Color.green(c)) * f).toInt(),
            (Color.blue(c) + (255 - Color.blue(c)) * f).toInt(),
        ) else Color.rgb(
            (Color.red(c) * (1 + f)).toInt(),
            (Color.green(c) * (1 + f)).toInt(),
            (Color.blue(c) * (1 + f)).toInt(),
        )

    private fun iconBtn(pathData: String, accent: Boolean = false, sizeDp: Int = 42, onClick: () -> Unit) = ImageButton(this).apply {
        setImageBitmap(Icons.bitmap(pathData, dp(22)))
        scaleType = ImageView.ScaleType.FIT_CENTER
        background = pill(if (accent) AppTheme.accent else AppTheme.elevated)
        setColorFilter(if (accent) AppTheme.onAccent() else AppTheme.text)
        stateListAnimator = null; minimumWidth = 0
        val pd = dp(8); setPadding(pd, pd, pd, pd)
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(36))
        setOnClickListener { onClick() }
    }

    private fun iconView(pathData: String, sizeDp: Int, color: Int) = ImageView(this).apply {
        setImageBitmap(Icons.bitmap(pathData, dp(sizeDp))); setColorFilter(color)
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    }

    private fun buildBar(): View {
        backButton = iconBtn(Icons.BACK) { if (!goUp()) finish() }
        // Also a drop target: drag an item onto Back to move it OUT to the parent folder.
        backButton.setOnDragListener(dropUpListener(backButton))
        titleView = TextView(this).apply {
            text = ""; textSize = 17f; setTypeface(null, Typeface.BOLD); setTextColor(AppTheme.text)
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(AppTheme.surface); setPadding(dp(10), dp(8), dp(10), dp(8))
            elevation = dp(4).toFloat()  // hairline separation from the scrolling grid
            addView(backButton); addView(titleView)
            addView(iconBtn(Icons.MORE) { aboutSheet() }.apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(6) })
            addView(iconBtn(Icons.DOWNLOAD) { importPicker.launch(arrayOf("*/*")) }.apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(6) })
            addView(iconBtn(Icons.FOLDER_ADD) { createFolderDialog() }.apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(6) })
            addView(iconBtn(Icons.ADD, accent = true) { createNotebookDialog(currentFolder) })
        }
    }

    private fun rebuild() {
        content.removeAllViews()
        val inFolder = currentFolder
        titleView.text = if (inFolder == null) "Notebooks" else (store.folders.find { it.id == inFolder }?.name ?: "Notebooks")
        // At the top level, offer to reopen the last multi-notebook split exactly as it was left.
        if (inFolder == null) {
            val session = InkSettings.lastSession(this).filter { store.notebook(it) != null }
            if (session.size >= 2) content.addView(resumeSplitCard(session))
        }
        val subFolders = store.foldersIn(inFolder)
        val nbs = store.notebooksIn(inFolder)
        if (subFolders.isNotEmpty()) content.addView(folderGrid(subFolders))
        if (nbs.isNotEmpty()) content.addView(notebookGrid(nbs))
        if (subFolders.isEmpty() && nbs.isEmpty()) content.addView(emptyState())
    }

    /** Navigate to the parent of the current folder. Returns false if already at the top. */
    private fun goUp(): Boolean {
        val cur = currentFolder ?: return false
        currentFolder = store.folders.find { it.id == cur }?.parentId
        rebuild(); return true
    }

    private fun emptyState() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(0, dp(60), 0, 0)
        addView(iconView(Icons.BOOK, 48, muted()))
    }

    private fun folderGrid(folders: List<NotebookStore.Folder>): View = GridLayout(this).apply {
        columnCount = gridColumns(); clipChildren = false; clipToPadding = false
        for (fo in folders) addView(folderTile(fo))
    }

    private fun notebookGrid(nbs: List<NotebookStore.Notebook>): View = GridLayout(this).apply {
        columnCount = gridColumns(); clipChildren = false; clipToPadding = false
        for (nb in nbs) addView(notebookTile(nb))
    }

    // ---- drag & drop reorg (hold a tile to drag it into a folder, or onto Back to move it out) ----
    private fun startItemDrag(view: View, token: String) {
        val clip = android.content.ClipData.newPlainText("engorg-item", token)
        val shadow = View.DragShadowBuilder(view)
        view.startDragAndDrop(clip, shadow, token, 0)
    }

    private fun draggedToken(e: android.view.DragEvent): String? =
        (e.localState as? String) ?: e.clipDescription?.label?.toString()

    /** Move the dragged notebook/folder to [targetFolder] (null = that container's top level). */
    private fun applyDrop(token: String?, targetFolder: String?): Boolean {
        if (token == null) return false
        val parts = token.split(":", limit = 2)
        if (parts.size != 2) return false
        return when (parts[0]) {
            "nb" -> {
                val nb = store.notebook(parts[1]) ?: return false
                if (nb.folderId == targetFolder) return false
                store.moveNotebook(nb, targetFolder); true
            }
            "fo" -> {
                val fo = store.folders.find { it.id == parts[1] } ?: return false
                if (fo.parentId == targetFolder) return false
                val ok = store.moveFolder(fo, targetFolder)
                if (!ok) Toast.makeText(this, "Can't move a folder inside itself", Toast.LENGTH_SHORT).show()
                ok
            }
            else -> false
        }
    }

    /** Drop listener for a folder card — moves the dragged item INTO that folder. */
    private fun folderDropListener(fo: NotebookStore.Folder, card: View): View.OnDragListener {
        val baseElev = dp(3).toFloat()
        return View.OnDragListener { _, e ->
            when (e.action) {
                android.view.DragEvent.ACTION_DRAG_STARTED -> draggedToken(e) != "fo:${fo.id}" // not onto itself
                android.view.DragEvent.ACTION_DRAG_ENTERED -> { card.alpha = 0.7f; card.elevation = baseElev + dp(6); true }
                android.view.DragEvent.ACTION_DRAG_EXITED -> { card.alpha = 1f; card.elevation = baseElev; true }
                android.view.DragEvent.ACTION_DRAG_ENDED -> { card.alpha = 1f; card.elevation = baseElev; true }
                android.view.DragEvent.ACTION_DROP -> {
                    card.alpha = 1f; card.elevation = baseElev
                    val moved = applyDrop(draggedToken(e), fo.id)
                    if (moved) rebuild()
                    moved
                }
                else -> true
            }
        }
    }

    /** Drop listener for the Back button — moves the dragged item OUT to the parent folder. */
    private fun dropUpListener(view: View): View.OnDragListener = View.OnDragListener { _, e ->
        when (e.action) {
            android.view.DragEvent.ACTION_DRAG_STARTED -> currentFolder != null // only meaningful inside a folder
            android.view.DragEvent.ACTION_DRAG_ENTERED -> { view.alpha = 0.6f; true }
            android.view.DragEvent.ACTION_DRAG_EXITED -> { view.alpha = 1f; true }
            android.view.DragEvent.ACTION_DRAG_ENDED -> { view.alpha = 1f; true }
            android.view.DragEvent.ACTION_DROP -> {
                view.alpha = 1f
                val parent = store.folders.find { it.id == currentFolder }?.parentId
                val moved = applyDrop(draggedToken(e), parent)
                if (moved) rebuild()
                moved
            }
            else -> true
        }
    }

    private fun menuDot(tint: Int, onClick: () -> Unit) = ImageButton(this).apply {
        setImageBitmap(Icons.bitmap(Icons.MORE, dp(18))); setColorFilter(tint)
        background = null; scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
        val pd = dp(6); setPadding(pd, pd, pd, pd)
        setOnClickListener { onClick() }
    }

    private fun folderTile(fo: NotebookStore.Folder): View {
        val w = dp(150); val h = dp(120); val m = dp(6)
        val count = store.notebooksIn(fo.id).size
        val card = FrameLayout(this).apply {
            layoutParams = GridLayout.LayoutParams().apply { width = w; height = h; setMargins(m, m, m, m) }
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat(); setColor(AppTheme.elevated)
                setStroke(dp(1), Color.argb(0x33, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text)))
            }
            clipToOutline = true
            elevation = dp(3).toFloat()
            foreground = rippleFg(14, Color.argb(0x28, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text)))
            setOnClickListener { currentFolder = fo.id; rebuild() }
            setOnLongClickListener { startItemDrag(this, "fo:${fo.id}"); true }
        }
        card.setOnDragListener(folderDropListener(fo, card))
        val subCount = store.foldersIn(fo.id).size
        card.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
            addView(iconView(Icons.FOLDER, 30, AppTheme.text))
            addView(TextView(this@LibraryActivity).apply { text = fo.name; setTextColor(AppTheme.text); textSize = 15f; setTypeface(null, Typeface.BOLD); setPadding(0, dp(6), 0, 0); maxLines = 1 })
            addView(LinearLayout(this@LibraryActivity).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                addView(ImageView(this@LibraryActivity).apply { setImageBitmap(Icons.bitmap(Icons.BOOK, dp(13))); setColorFilter(muted()); layoutParams = LinearLayout.LayoutParams(dp(13), dp(13)) })
                addView(TextView(this@LibraryActivity).apply { text = "  $count"; setTextColor(muted()); textSize = 12f })
                if (subCount > 0) {
                    addView(ImageView(this@LibraryActivity).apply { setImageBitmap(Icons.bitmap(Icons.FOLDER, dp(12))); setColorFilter(muted()); layoutParams = LinearLayout.LayoutParams(dp(12), dp(12)).apply { leftMargin = dp(8) } })
                    addView(TextView(this@LibraryActivity).apply { text = "  $subCount"; setTextColor(muted()); textSize = 12f })
                }
            })
        })
        card.addView(menuDot(AppTheme.text) { folderMenu(fo) }, FrameLayout.LayoutParams(dp(30), dp(30)).apply { gravity = Gravity.TOP or Gravity.END; setMargins(0, dp(4), dp(4), 0) })
        return card
    }

    private fun notebookTile(nb: NotebookStore.Notebook): View {
        val w = dp(150); val h = dp(186); val m = dp(6); val radius = dp(14)
        val card = FrameLayout(this).apply {
            layoutParams = GridLayout.LayoutParams().apply { width = w; height = h; setMargins(m, m, m, m) }
            // A book-like cover: subtle top-to-bottom shading for depth instead of a flat fill.
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(shade(nb.coverColor, 0.14f), nb.coverColor, shade(nb.coverColor, -0.12f)),
            ).apply { cornerRadius = radius.toFloat() }
            clipToOutline = true
            elevation = dp(5).toFloat()
            foreground = rippleFg(14, Color.argb(0x40, 255, 255, 255))
            setOnClickListener { openNotebook(nb) }
            setOnLongClickListener { startItemDrag(this, "nb:${nb.id}"); true }
        }
        // Darker "spine" down the left edge (its square right side is clipped to the rounded card).
        card.addView(View(this).apply {
            background = GradientDrawable().apply { setColor(shade(nb.coverColor, -0.26f)) }
            layoutParams = FrameLayout.LayoutParams(dp(7), MATCH_PARENT)
        })
        card.addView(View(this).apply {
            background = GradientDrawable().apply { setColor(Color.argb(0x22, 255, 255, 255)) }
            layoutParams = FrameLayout.LayoutParams(dp(1), MATCH_PARENT).apply { leftMargin = dp(7) }
        })
        card.addView(TextView(this).apply {
            text = nb.title; setTextColor(Color.WHITE); textSize = 15f; setTypeface(null, Typeface.BOLD)
            setShadowLayer(dp(3).toFloat(), 0f, dp(1).toFloat(), Color.argb(0x70, 0, 0, 0))
            setPadding(dp(14), dp(12), dp(12), dp(14))
            layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { gravity = Gravity.BOTTOM }
        })
        card.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(11), dp(10), dp(10))
            layoutParams = FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.TOP or Gravity.START }
            addView(ImageView(this@LibraryActivity).apply { setImageBitmap(Icons.bitmap(Icons.PAGE, dp(13))); setColorFilter(Color.argb(0xCC, 255, 255, 255)); layoutParams = LinearLayout.LayoutParams(dp(13), dp(13)) })
            addView(TextView(this@LibraryActivity).apply { text = "  ${nb.pageIds.size}"; setTextColor(Color.argb(0xCC, 255, 255, 255)); textSize = 11f })
        })
        card.addView(menuDot(Color.argb(0xE0, 255, 255, 255)) { notebookMenu(nb) }, FrameLayout.LayoutParams(dp(30), dp(30)).apply { gravity = Gravity.TOP or Gravity.END; setMargins(0, dp(4), dp(4), 0) })
        return card
    }

    private fun openNotebook(nb: NotebookStore.Notebook) {
        startActivity(Intent(this, InkActivity::class.java).putExtra(InkActivity.EXTRA_NOTEBOOK_ID, nb.id))
    }

    /** A banner that relaunches the last split-view session (2–4 notebooks) as it was left. */
    private fun resumeSplitCard(ids: List<String>): View {
        val names = ids.mapNotNull { store.notebook(it)?.title }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat(); setColor(AppTheme.elevated)
                setStroke(dp(1), Color.argb(0x55, Color.red(AppTheme.accent), Color.green(AppTheme.accent), Color.blue(AppTheme.accent)))
            }
            foreground = rippleFg(14, Color.argb(0x28, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text)))
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(12) }
            setOnClickListener {
                startActivity(Intent(this@LibraryActivity, InkActivity::class.java)
                    .putStringArrayListExtra(InkActivity.EXTRA_NOTEBOOK_IDS, ArrayList(ids)))
            }
        }
        row.addView(iconView(Icons.SPLIT, 22, AppTheme.accent).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(12) })
        row.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
            addView(TextView(this@LibraryActivity).apply { text = "Resume split view"; setTextColor(AppTheme.text); textSize = 15f; setTypeface(null, Typeface.BOLD) })
            addView(TextView(this@LibraryActivity).apply {
                text = names.joinToString("  ·  "); setTextColor(muted()); textSize = 12f
                maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            })
        })
        row.addView(ImageButton(this).apply {
            setImageBitmap(Icons.bitmap(Icons.CLOSE, dp(16))); setColorFilter(muted())
            background = pill(AppTheme.elevated); scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
            val pd = dp(5); setPadding(pd, pd, pd, pd)
            layoutParams = LinearLayout.LayoutParams(dp(28), dp(28)).apply { leftMargin = dp(8) }
            setOnClickListener { InkSettings.saveLastSession(this@LibraryActivity, emptyList()); rebuild() }
        })
        return row
    }

    // ---- Noteshelf import ----
    private fun runImport(uri: Uri) {
        val pad = dp(24)
        val status = TextView(this).apply {
            text = "Reading export…"; setTextColor(AppTheme.text); textSize = 14f
            gravity = Gravity.CENTER; setPadding(0, dp(16), 0, 0)
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, pad)
            addView(ProgressBar(this@LibraryActivity))
            addView(status)
        }
        val dialog = Dialog(this).apply {
            setContentView(box, ViewGroup.LayoutParams(dp(300), WRAP_CONTENT))
            window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setCancelable(false)
        }
        dialog.show()
        NoteshelfImport.importZip(
            this, uri, store,
            onProgress = { s -> status.text = s },
            onDone = { count, err ->
                if (!isFinishing && !isDestroyed) {
                    dialog.dismiss()
                    rebuild()
                    val msg = err?.let { "Import failed: $it" }
                        ?: "Imported $count notebook${if (count == 1) "" else "s"}."
                    Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                }
            },
        )
    }

    // ---- reusable dialog shell ----
    private fun sheet(build: (LinearLayout, Dialog) -> Unit) {
        val pad = dp(22)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, dp(16))
        }
        val dialog = Dialog(this).apply {
            setContentView(ScrollView(this@LibraryActivity).apply { addView(box) }, ViewGroup.LayoutParams(dp(340), WRAP_CONTENT))
            window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }
        build(box, dialog)
        dialog.show()
    }

    private fun themedInput(initial: String) = EditText(this).apply {
        setText(initial); setSelection(text.length)
        setTextColor(AppTheme.text); textSize = 16f
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated)
            setStroke(dp(1), Color.argb(0x33, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text)))
        }
        setPadding(dp(14), dp(12), dp(14), dp(12))
    }

    private fun actionRow(box: LinearLayout, dialog: Dialog, onOk: () -> Unit) {
        box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(20) }
            addView(iconBtn(Icons.CLOSE) { dialog.dismiss() })
            addView(View(this@LibraryActivity), LinearLayout.LayoutParams(dp(8), 1))
            addView(iconBtn(Icons.CHECK, accent = true) { dialog.dismiss(); onOk() })
        })
    }

    // ---- create / rename ----
    private fun createNotebookDialog(folderId: String?) {
        // Start from the defaults saved on the user's profile (synced across devices) so the dialog
        // reuses your last choice instead of resetting each time.
        var cover = InkSettings.nbCover(this); var paper = InkSettings.nbPaper(this); var pageColor = InkSettings.nbPageColor(this)
        sheet { box, dialog ->
            box.addView(iconView(Icons.BOOK, 26, AppTheme.text))
            val input = themedInput("")
            box.addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) })
            box.addView(fieldRow(Icons.PALETTE, colorChipRow(covers, cover) { cover = it }))
            box.addView(fieldRow(Icons.GRID, paperChipRow(paper) { paper = it }))
            box.addView(fieldRow(Icons.DROPLET, colorChipRow(pageColors, pageColor) { pageColor = it }))
            actionRow(box, dialog) {
                InkSettings.setNotebookDefaults(this, paper, cover, pageColor)  // remember + sync the choice
                val nb = store.createNotebook(input.text.toString().ifBlank { "Untitled" }, folderId, cover, paper, pageColor)
                rebuild(); openNotebook(nb)
            }
        }
    }

    private fun fieldRow(iconPath: String, control: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) }
        addView(iconView(iconPath, 20, muted()).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(10) })
        addView(control)
    }

    private fun renameDialog(initial: String, onOk: (String) -> Unit) = sheet { box, dialog ->
        box.addView(iconView(Icons.PEN, 24, AppTheme.text))
        val input = themedInput(initial)
        box.addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) })
        actionRow(box, dialog) { onOk(input.text.toString()) }
    }

    /** App/version sheet with a manual "Check for updates" — native counterpart to the desktop's
     *  Settings → About, and a way to verify the auto-updater on demand. */
    private fun aboutSheet() = sheet { box, dialog ->
        box.addView(LinearLayout(this).apply { gravity = Gravity.CENTER; addView(iconView(Icons.BOOK, 34, AppTheme.text)) })
        box.addView(TextView(this).apply {
            text = "EngInk"; setTextColor(AppTheme.text); textSize = 18f; setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER; setPadding(0, dp(10), 0, 0)
        })
        box.addView(TextView(this).apply {
            text = "Version ${BuildConfig.VERSION_NAME}"; setTextColor(muted()); textSize = 13f
            gravity = Gravity.CENTER; setPadding(0, dp(4), 0, 0)
        })
        box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = pillBg(AppTheme.accent); foreground = rippleFg(18, Color.argb(0x40, 255, 255, 255))
            setPadding(dp(16), dp(11), dp(16), dp(11))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(20) }
            addView(iconView(Icons.DOWNLOAD, 20, AppTheme.onAccent()).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(12) })
            addView(TextView(this@LibraryActivity).apply {
                text = "Check for updates"; setTextColor(AppTheme.onAccent()); textSize = 15f; setTypeface(null, Typeface.BOLD)
            })
            setOnClickListener { dialog.dismiss(); InkUpdater.checkNow(this@LibraryActivity) }
        })
    }

    private fun createFolderDialog() = sheet { box, dialog ->
        box.addView(iconView(Icons.FOLDER_ADD, 24, AppTheme.text))
        val input = themedInput("")
        box.addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) })
        actionRow(box, dialog) { store.createFolder(input.text.toString().ifBlank { "Folder" }, currentFolder); rebuild() }
    }

    // ---- icon menus ----
    private fun iconMenu(items: List<Pair<String, () -> Unit>>) = sheet { box, dialog ->
        box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
            for ((path, action) in items) addView(iconBtn(path) { dialog.dismiss(); action() }.apply {
                (layoutParams as LinearLayout.LayoutParams).apply { width = dp(52); rightMargin = dp(6) }
            })
        })
    }

    private fun notebookMenu(nb: NotebookStore.Notebook) = iconMenu(listOf<Pair<String, () -> Unit>>(
        Icons.SPLIT to { splitPickDialog(nb) },
        Icons.PEN to { renameDialog(nb.title) { nb.title = it.ifBlank { nb.title }; store.save(); rebuild() } },
        Icons.PALETTE to { coverColorDialog(nb) },
        Icons.FOLDER to { moveDialog(nb) },
        Icons.TRASH to { confirmDelete { store.deleteNotebook(nb); rebuild() } },
    ))

    /** Pick 1–3 more notebooks to open beside [primary] as split panes (up to 4 total). */
    private fun splitPickDialog(primary: NotebookStore.Notebook) = sheet { box, dialog ->
        box.addView(iconView(Icons.SPLIT, 24, AppTheme.text))
        box.addView(TextView(this).apply {
            text = "Open side by side (up to 4)"; setTextColor(muted()); textSize = 13f
            setPadding(0, dp(6), 0, dp(2))
        })
        val selected = linkedSetOf(primary.id)
        val ordered = listOf(primary) + store.notebooks.filter { it.id != primary.id }
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        for (rowNb in ordered) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(10), dp(14), dp(10))
                layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) }
                addView(View(this@LibraryActivity).apply {
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(rowNb.coverColor) }
                    layoutParams = LinearLayout.LayoutParams(dp(16), dp(16)).apply { rightMargin = dp(12) }
                })
                addView(TextView(this@LibraryActivity).apply { text = rowNb.title; setTextColor(AppTheme.text); textSize = 15f; maxLines = 1 })
            }
            fun paint() { row.background = pillBg(if (selected.contains(rowNb.id)) AppTheme.accent else AppTheme.elevated) }
            row.setOnClickListener {
                if (rowNb.id != primary.id) {
                    if (selected.contains(rowNb.id)) selected.remove(rowNb.id)
                    else if (selected.size < 4) selected.add(rowNb.id)
                    else Toast.makeText(this, "Up to 4 notebooks.", Toast.LENGTH_SHORT).show()
                    paint()
                }
            }
            paint()
            list.addView(row)
        }
        box.addView(list, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) })
        actionRow(box, dialog) {
            startActivity(Intent(this, InkActivity::class.java).putStringArrayListExtra(InkActivity.EXTRA_NOTEBOOK_IDS, ArrayList(selected)))
        }
    }

    private fun folderMenu(fo: NotebookStore.Folder) = iconMenu(listOf<Pair<String, () -> Unit>>(
        Icons.FOLDER to { currentFolder = fo.id; rebuild() },
        Icons.ADD to { createNotebookDialog(fo.id) },
        Icons.PEN to { renameDialog(fo.name) { fo.name = it.ifBlank { fo.name }; store.save(); rebuild() } },
        Icons.TRASH to { confirmDelete { if (currentFolder == fo.id) currentFolder = null; store.deleteFolder(fo); rebuild() } },
    ))

    private fun coverColorDialog(nb: NotebookStore.Notebook) = sheet { box, dialog ->
        box.addView(iconView(Icons.PALETTE, 24, AppTheme.text))
        box.addView(colorChipRow(covers, nb.coverColor) { nb.coverColor = it; store.save(); rebuild(); dialog.dismiss() }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) })
    }

    private fun moveDialog(nb: NotebookStore.Notebook) = sheet { box, dialog ->
        box.addView(iconView(Icons.FOLDER, 24, AppTheme.text))
        fun row(iconPath: String, label: String, action: () -> Unit) = box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            background = pillBg(AppTheme.elevated); setPadding(dp(12), dp(10), dp(14), dp(10))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) }
            addView(iconView(iconPath, 20, AppTheme.text).apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(12) })
            addView(TextView(this@LibraryActivity).apply { text = label; setTextColor(AppTheme.text); textSize = 15f })
            setOnClickListener { action(); dialog.dismiss() }
        })
        row(Icons.HOME, if (store.folders.isEmpty()) "—" else "") { nb.folderId = null; store.save(); rebuild() }
        for (fo in store.folders) row(Icons.FOLDER, fo.name) { nb.folderId = fo.id; store.save(); rebuild() }
    }

    private fun confirmDelete(onYes: () -> Unit) = sheet { box, dialog ->
        box.addView(LinearLayout(this).apply { gravity = Gravity.CENTER; addView(iconView(Icons.TRASH, 40, Color.rgb(0xE5, 0x3E, 0x3E))) })
        actionRow(box, dialog) { onYes() }
    }

    // ---- chips ----
    private fun colorChipRow(colors: IntArray, initial: Int, onSelect: (Int) -> Unit): View {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val views = ArrayList<Pair<View, Int>>()
        fun swatch(c: Int, sel: Boolean) = GradientDrawable().apply {
            shape = GradientDrawable.OVAL; setColor(c)
            setStroke(dp(if (sel) 3 else 1), if (sel) AppTheme.accent else Color.argb(0x40, 0x80, 0x80, 0x80))
        }
        fun refresh(sel: Int) { for ((v, c) in views) v.background = swatch(c, c == sel) }
        for (c in colors) {
            val v = View(this).apply { layoutParams = LinearLayout.LayoutParams(dp(38), dp(38)).apply { rightMargin = dp(8) }; setOnClickListener { onSelect(c); refresh(c) } }
            views.add(v to c); row.addView(v)
        }
        refresh(initial)
        return HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(row) }
    }

    private fun paperChipRow(initial: String, onSelect: (String) -> Unit): View {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val views = ArrayList<Pair<ImageButton, String>>()
        fun refresh(sel: String) { for ((v, value) in views) { val on = value == sel; v.background = pill(if (on) AppTheme.accent else AppTheme.elevated); v.setColorFilter(if (on) AppTheme.onAccent() else AppTheme.text) } }
        for (value in paperOptions) {
            val v = ImageButton(this).apply {
                setImageBitmap(paperPreview(value, dp(26))); scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
                val pd = dp(8); setPadding(pd, pd, pd, pd)
                layoutParams = LinearLayout.LayoutParams(dp(46), dp(42)).apply { rightMargin = dp(8) }
                setOnClickListener { onSelect(value); refresh(value) }
            }
            views.add(v to value); row.addView(v)
        }
        refresh(initial)
        return row
    }

    private fun paperPreview(kind: String, px: Int): Bitmap {
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val border = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = px * 0.06f; color = Color.WHITE }
        c.drawRect(px * 0.1f, px * 0.1f, px * 0.9f, px * 0.9f, border)
        val ln = Paint().apply { isAntiAlias = true; strokeWidth = px * 0.045f; color = Color.WHITE }
        val fill = Paint().apply { isAntiAlias = true; color = Color.WHITE }
        when (kind) {
            "GRID" -> { var g = 0.3f; while (g < 0.9f) { c.drawLine(px * g, px * 0.1f, px * g, px * 0.9f, ln); c.drawLine(px * 0.1f, px * g, px * 0.9f, px * g, ln); g += 0.2f } }
            "RULED" -> { var g = 0.3f; while (g < 0.9f) { c.drawLine(px * 0.15f, px * g, px * 0.85f, px * g, ln); g += 0.2f } }
            "DOTS" -> { var y = 0.3f; while (y < 0.9f) { var x = 0.3f; while (x < 0.9f) { c.drawCircle(px * x, px * y, px * 0.055f, fill); x += 0.2f }; y += 0.2f } }
        }
        return bmp
    }
}
