package com.engorg.inkpad

import android.app.Dialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
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
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity

/** Notebook browser: tap a folder to open it, tap a notebook to write. Icon-only chrome. */
class LibraryActivity : ComponentActivity() {

    private lateinit var store: NotebookStore
    private lateinit var content: LinearLayout
    private lateinit var titleView: TextView
    private lateinit var backButton: ImageButton
    private var currentFolder: String? = null

    private val covers = intArrayOf(
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0x89, 0x7B),
        Color.rgb(0x2E, 0x7D, 0x32), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0xDC, 0x26, 0x50),
        Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0x45, 0x4B, 0x55),
    )
    private val pageColors = intArrayOf(
        Color.WHITE, Color.rgb(0xFB, 0xF7, 0xEC), Color.rgb(0xF3, 0xF4, 0xF6),
        Color.rgb(0xEA, 0xF3, 0xEC), Color.rgb(0x22, 0x27, 0x31), Color.rgb(0x0F, 0x11, 0x16),
    )
    private val paperOptions = listOf("PLAIN", "GRID", "RULED", "DOTS")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppTheme.load(this)
        store = NotebookStore(filesDir)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(AppTheme.bg) }
        root.addView(buildBar())
        val scroll = ScrollView(this)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(12), dp(16), dp(48)) }
        scroll.addView(content)
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (currentFolder != null) { currentFolder = null; rebuild() } else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        store.reload()
        if (currentFolder != null && store.folders.none { it.id == currentFolder }) currentFolder = null
        rebuild()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun muted() = Color.argb(0x99, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text))
    private fun pillBg(color: Int) = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(color) }

    private fun iconBtn(pathData: String, accent: Boolean = false, sizeDp: Int = 42, onClick: () -> Unit) = ImageButton(this).apply {
        setImageBitmap(Icons.bitmap(pathData, dp(22)))
        scaleType = ImageView.ScaleType.FIT_CENTER
        background = pillBg(if (accent) AppTheme.accent else AppTheme.elevated)
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
        backButton = iconBtn(Icons.BACK) { if (currentFolder != null) { currentFolder = null; rebuild() } else finish() }
        titleView = TextView(this).apply {
            text = ""; textSize = 17f; setTypeface(null, Typeface.BOLD); setTextColor(AppTheme.text)
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(AppTheme.surface); setPadding(dp(8), dp(6), dp(8), dp(6))
            addView(backButton); addView(titleView)
            addView(iconBtn(Icons.FOLDER_ADD) { createFolderDialog() }.apply { (layoutParams as LinearLayout.LayoutParams).rightMargin = dp(6) })
            addView(iconBtn(Icons.ADD, accent = true) { createNotebookDialog(currentFolder) })
        }
    }

    private fun rebuild() {
        content.removeAllViews()
        val inFolder = currentFolder
        if (inFolder == null) {
            titleView.text = ""
            if (store.folders.isNotEmpty()) content.addView(folderGrid(store.folders))
            val top = store.notebooksIn(null)
            if (top.isNotEmpty()) content.addView(notebookGrid(top))
            if (store.folders.isEmpty() && top.isEmpty()) content.addView(emptyState())
        } else {
            val fo = store.folders.first { it.id == inFolder }
            titleView.text = fo.name
            val nbs = store.notebooksIn(inFolder)
            if (nbs.isEmpty()) content.addView(emptyState()) else content.addView(notebookGrid(nbs))
        }
    }

    private fun emptyState() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(0, dp(60), 0, 0)
        addView(iconView(Icons.BOOK, 48, muted()))
    }

    private fun folderGrid(folders: List<NotebookStore.Folder>): View = GridLayout(this).apply {
        columnCount = 3
        for (fo in folders) addView(folderTile(fo))
    }

    private fun notebookGrid(nbs: List<NotebookStore.Notebook>): View = GridLayout(this).apply {
        columnCount = 3
        for (nb in nbs) addView(notebookTile(nb))
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
            setOnClickListener { currentFolder = fo.id; rebuild() }
            setOnLongClickListener { folderMenu(fo); true }
        }
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
            })
        })
        return card
    }

    private fun notebookTile(nb: NotebookStore.Notebook): View {
        val w = dp(150); val h = dp(186); val m = dp(6)
        val card = FrameLayout(this).apply {
            layoutParams = GridLayout.LayoutParams().apply { width = w; height = h; setMargins(m, m, m, m) }
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(nb.coverColor) }
            setOnClickListener { openNotebook(nb) }
            setOnLongClickListener { notebookMenu(nb); true }
        }
        card.addView(TextView(this).apply {
            text = nb.title; setTextColor(Color.WHITE); textSize = 15f; setTypeface(null, Typeface.BOLD)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { gravity = Gravity.BOTTOM }
        })
        card.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(10), dp(10), dp(10))
            layoutParams = FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.TOP or Gravity.END }
            addView(ImageView(this@LibraryActivity).apply { setImageBitmap(Icons.bitmap(Icons.PAGE, dp(13))); setColorFilter(Color.argb(0xCC, 255, 255, 255)); layoutParams = LinearLayout.LayoutParams(dp(13), dp(13)) })
            addView(TextView(this@LibraryActivity).apply { text = "  ${nb.pageIds.size}"; setTextColor(Color.argb(0xCC, 255, 255, 255)); textSize = 11f })
        })
        return card
    }

    private fun openNotebook(nb: NotebookStore.Notebook) {
        startActivity(Intent(this, InkActivity::class.java).putExtra(InkActivity.EXTRA_NOTEBOOK_ID, nb.id))
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
        var cover = covers.random(); var paper = "GRID"; var pageColor = Color.WHITE
        sheet { box, dialog ->
            box.addView(iconView(Icons.BOOK, 26, AppTheme.text))
            val input = themedInput("")
            box.addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) })
            box.addView(fieldRow(Icons.PALETTE, colorChipRow(covers, cover) { cover = it }))
            box.addView(fieldRow(Icons.GRID, paperChipRow(paper) { paper = it }))
            box.addView(fieldRow(Icons.DROPLET, colorChipRow(pageColors, pageColor) { pageColor = it }))
            actionRow(box, dialog) {
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

    private fun createFolderDialog() = sheet { box, dialog ->
        box.addView(iconView(Icons.FOLDER_ADD, 24, AppTheme.text))
        val input = themedInput("")
        box.addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) })
        actionRow(box, dialog) { store.createFolder(input.text.toString().ifBlank { "Folder" }); rebuild() }
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
        Icons.PEN to { renameDialog(nb.title) { nb.title = it.ifBlank { nb.title }; store.save(); rebuild() } },
        Icons.PALETTE to { coverColorDialog(nb) },
        Icons.FOLDER to { moveDialog(nb) },
        Icons.TRASH to { confirmDelete { store.deleteNotebook(nb); rebuild() } },
    ))

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
        fun refresh(sel: String) { for ((v, value) in views) { val on = value == sel; v.background = pillBg(if (on) AppTheme.accent else AppTheme.elevated); v.setColorFilter(if (on) AppTheme.onAccent() else AppTheme.text) } }
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

    private fun paperPreview(style: String, px: Int): Bitmap {
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val border = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE; strokeWidth = px * 0.06f; color = Color.WHITE }
        c.drawRect(px * 0.1f, px * 0.1f, px * 0.9f, px * 0.9f, border)
        val ln = Paint().apply { isAntiAlias = true; strokeWidth = px * 0.045f; color = Color.WHITE }
        val fill = Paint().apply { isAntiAlias = true; color = Color.WHITE }
        when (style) {
            "GRID" -> { var g = 0.3f; while (g < 0.9f) { c.drawLine(px * g, px * 0.1f, px * g, px * 0.9f, ln); c.drawLine(px * 0.1f, px * g, px * 0.9f, px * g, ln); g += 0.2f } }
            "RULED" -> { var g = 0.3f; while (g < 0.9f) { c.drawLine(px * 0.15f, px * g, px * 0.85f, px * g, ln); g += 0.2f } }
            "DOTS" -> { var y = 0.3f; while (y < 0.9f) { var x = 0.3f; while (x < 0.9f) { c.drawCircle(px * x, px * y, px * 0.03f, fill); x += 0.2f }; y += 0.2f } }
        }
        return bmp
    }
}
