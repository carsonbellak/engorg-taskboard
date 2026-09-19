package com.engorg.inkpad

import android.app.AlertDialog
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity

/** Notebook browser: tap a folder to open it, tap a notebook to write. Entry point from the PWA's Ink tab. */
class LibraryActivity : ComponentActivity() {

    private lateinit var store: NotebookStore
    private lateinit var content: LinearLayout
    private lateinit var titleView: TextView
    private lateinit var backButton: Button
    private var currentFolder: String? = null

    private val covers = intArrayOf(
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0x89, 0x7B),
        Color.rgb(0x2E, 0x7D, 0x32), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0xDC, 0x26, 0x50),
        Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0x45, 0x4B, 0x55),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppTheme.load(this)
        store = NotebookStore(filesDir)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(AppTheme.bg)
        }
        root.addView(buildBar())
        val scroll = ScrollView(this)
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(48))
        }
        scroll.addView(content)
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (currentFolder != null) { currentFolder = null; rebuild() }
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
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
    private fun pillBg(color: Int) = GradientDrawable().apply { cornerRadius = dp(20).toFloat(); setColor(color) }

    private fun btn(t: String, accent: Boolean, f: () -> Unit) = Button(this).apply {
        text = t; isAllCaps = false; textSize = 13f
        setTextColor(if (accent) AppTheme.onAccent() else AppTheme.text)
        background = pillBg(if (accent) AppTheme.accent else AppTheme.elevated)
        stateListAnimator = null
        setPadding(dp(14), dp(4), dp(14), dp(4))
        setOnClickListener { f() }
    }

    private fun buildBar(): View {
        backButton = btn("‹ App", false) {
            if (currentFolder != null) { currentFolder = null; rebuild() } else finish()
        }
        titleView = TextView(this).apply {
            text = "  Notebooks"; textSize = 18f; setTypeface(null, Typeface.BOLD)
            setTextColor(AppTheme.text)
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(AppTheme.surface)
            setPadding(dp(8), dp(6), dp(8), dp(6))
            addView(backButton)
            addView(titleView)
            addView(btn("+ Folder", false) { createFolderDialog() })
            addView(btn("+ Notebook", true) { createNotebookDialog(currentFolder) })
        }
    }

    private fun rebuild() {
        content.removeAllViews()
        val inFolder = currentFolder
        if (inFolder == null) {
            backButton.text = "‹ App"
            titleView.text = "  Notebooks"
            if (store.folders.isNotEmpty()) content.addView(sectionLabel("Folders"))
            if (store.folders.isNotEmpty()) content.addView(folderGrid(store.folders))
            val top = store.notebooksIn(null)
            if (top.isNotEmpty()) {
                content.addView(sectionLabel("Notebooks"))
                content.addView(notebookGrid(top))
            }
            if (store.folders.isEmpty() && top.isEmpty())
                content.addView(hint("No notebooks yet — tap “+ Notebook” to start."))
        } else {
            val fo = store.folders.first { it.id == inFolder }
            backButton.text = "‹ Back"
            titleView.text = "  📁 ${fo.name}"
            val nbs = store.notebooksIn(inFolder)
            if (nbs.isEmpty()) content.addView(hint("Empty folder — tap “+ Notebook” to add one."))
            else content.addView(notebookGrid(nbs))
        }
    }

    private fun sectionLabel(t: String) = TextView(this).apply {
        text = t; textSize = 13f; setTypeface(null, Typeface.BOLD)
        setTextColor(muted()); setPadding(dp(4), dp(14), dp(4), dp(6))
    }

    private fun hint(t: String) = TextView(this).apply {
        text = t; setTextColor(muted()); textSize = 14f; setPadding(dp(4), dp(18), dp(4), dp(10))
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
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
            addView(TextView(this@LibraryActivity).apply { text = "📁"; textSize = 30f })
            addView(TextView(this@LibraryActivity).apply {
                text = fo.name; setTextColor(AppTheme.text); textSize = 15f; setTypeface(null, Typeface.BOLD)
                setPadding(0, dp(6), 0, 0); maxLines = 1
            })
            addView(TextView(this@LibraryActivity).apply {
                text = "$count notebook${if (count == 1) "" else "s"}"; setTextColor(muted()); textSize = 11f
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
            text = nb.title
            setTextColor(Color.WHITE); textSize = 15f; setTypeface(null, Typeface.BOLD)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { gravity = Gravity.BOTTOM }
        })
        card.addView(TextView(this).apply {
            text = "${nb.pageIds.size} pg"
            setTextColor(Color.argb(0xCC, 255, 255, 255)); textSize = 11f
            setPadding(dp(12), dp(10), dp(12), dp(10))
            layoutParams = FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.TOP or Gravity.END }
        })
        return card
    }

    private fun openNotebook(nb: NotebookStore.Notebook) {
        startActivity(Intent(this, InkActivity::class.java).putExtra(InkActivity.EXTRA_NOTEBOOK_ID, nb.id))
    }

    // ---- themed text prompt (replaces the ugly stock input box) ----
    private fun themedPrompt(title: String, initial: String, hintText: String, positive: String, onOk: (String) -> Unit) {
        val pad = dp(22)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, dp(16))
        }
        box.addView(TextView(this).apply {
            text = title; textSize = 18f; setTypeface(null, Typeface.BOLD); setTextColor(AppTheme.text)
        })
        val input = EditText(this).apply {
            setText(initial); setSelection(text.length)
            hint = hintText; setHintTextColor(muted()); setTextColor(AppTheme.text); textSize = 16f
            background = GradientDrawable().apply {
                cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated)
                setStroke(dp(1), Color.argb(0x33, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text)))
            }
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        box.addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) })

        val dialog = Dialog(this).apply {
            setContentView(box, ViewGroup.LayoutParams(dp(320), WRAP_CONTENT))
            window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }
        box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(18) }
            addView(btn("Cancel", false) { dialog.dismiss() })
            addView(View(this@LibraryActivity), LinearLayout.LayoutParams(dp(8), 1))
            addView(btn(positive, true) {
                val v = input.text.toString()
                dialog.dismiss(); onOk(v)
            })
        })
        dialog.show()
    }

    // ---- dialogs ----
    private val pageColors = intArrayOf(
        Color.WHITE, Color.rgb(0xFB, 0xF7, 0xEC), Color.rgb(0xF3, 0xF4, 0xF6),
        Color.rgb(0xEA, 0xF3, 0xEC), Color.rgb(0x22, 0x27, 0x31), Color.rgb(0x0F, 0x11, 0x16),
    )
    private val paperOptions = listOf("Plain" to "PLAIN", "Grid" to "GRID", "Ruled" to "RULED", "Dots" to "DOTS")

    private fun createNotebookDialog(folderId: String?) {
        var cover = covers.random()
        var paper = "GRID"
        var pageColor = Color.WHITE
        val pad = dp(22)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(pad, pad, pad, dp(16))
        }
        box.addView(TextView(this).apply { text = "New notebook"; textSize = 18f; setTypeface(null, Typeface.BOLD); setTextColor(AppTheme.text) })
        val input = EditText(this).apply {
            hint = "Notebook title"; setHintTextColor(muted()); setTextColor(AppTheme.text); textSize = 16f
            background = GradientDrawable().apply {
                cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated)
                setStroke(dp(1), Color.argb(0x33, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text)))
            }
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        box.addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) })
        box.addView(fieldLabel("Cover"))
        box.addView(colorChipRow(covers, cover) { cover = it })
        box.addView(fieldLabel("Paper"))
        box.addView(paperChipRow(paper) { paper = it })
        box.addView(fieldLabel("Page color"))
        box.addView(colorChipRow(pageColors, pageColor) { pageColor = it })

        val dialog = Dialog(this).apply {
            setContentView(ScrollView(this@LibraryActivity).apply { addView(box) }, ViewGroup.LayoutParams(dp(340), WRAP_CONTENT))
            window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }
        box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(20) }
            addView(btn("Cancel", false) { dialog.dismiss() })
            addView(View(this@LibraryActivity), LinearLayout.LayoutParams(dp(8), 1))
            addView(btn("Create", true) {
                val title = input.text.toString().ifBlank { "Untitled" }
                dialog.dismiss()
                val nb = store.createNotebook(title, folderId, cover, paper, pageColor)
                rebuild(); openNotebook(nb)
            })
        })
        dialog.show()
    }

    private fun fieldLabel(t: String) = TextView(this).apply {
        text = t; textSize = 13f; setTypeface(null, Typeface.BOLD); setTextColor(muted())
        setPadding(dp(2), dp(16), dp(2), dp(8))
    }

    private fun colorChipRow(colors: IntArray, initial: Int, onSelect: (Int) -> Unit): View {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val views = ArrayList<Pair<View, Int>>()
        fun swatch(c: Int, sel: Boolean) = GradientDrawable().apply {
            shape = GradientDrawable.OVAL; setColor(c)
            setStroke(dp(if (sel) 3 else 1), if (sel) AppTheme.accent else Color.argb(0x40, 0x80, 0x80, 0x80))
        }
        fun refresh(sel: Int) { for ((v, c) in views) v.background = swatch(c, c == sel) }
        for (c in colors) {
            val v = View(this).apply {
                layoutParams = LinearLayout.LayoutParams(dp(38), dp(38)).apply { rightMargin = dp(8) }
                setOnClickListener { onSelect(c); refresh(c) }
            }
            views.add(v to c); row.addView(v)
        }
        refresh(initial)
        return HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(row) }
    }

    private fun paperChipRow(initial: String, onSelect: (String) -> Unit): View {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val views = ArrayList<Pair<TextView, String>>()
        fun refresh(sel: String) {
            for ((v, value) in views) {
                val on = value == sel
                v.background = GradientDrawable().apply { cornerRadius = dp(16).toFloat(); setColor(if (on) AppTheme.accent else AppTheme.elevated) }
                v.setTextColor(if (on) AppTheme.onAccent() else AppTheme.text)
            }
        }
        for ((label, value) in paperOptions) {
            val v = TextView(this).apply {
                text = label; textSize = 14f; setPadding(dp(16), dp(8), dp(16), dp(8))
                layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = dp(8) }
                setOnClickListener { onSelect(value); refresh(value) }
            }
            views.add(v to value); row.addView(v)
        }
        refresh(initial)
        return row
    }

    private fun createFolderDialog() {
        themedPrompt("New folder", "", "Folder name", "Create") { raw ->
            store.createFolder(raw.ifBlank { "Folder" }); rebuild()
        }
    }

    private fun notebookMenu(nb: NotebookStore.Notebook) {
        AlertDialog.Builder(this)
            .setTitle(nb.title)
            .setItems(arrayOf("Rename", "Cover color", "Move to folder", "Delete")) { _, which ->
                when (which) {
                    0 -> themedPrompt("Rename", nb.title, "Notebook title", "Save") { nb.title = it.ifBlank { nb.title }; store.save(); rebuild() }
                    1 -> coverColorDialog(nb)
                    2 -> moveDialog(nb)
                    3 -> confirmDelete(nb.title) { store.deleteNotebook(nb); rebuild() }
                }
            }.show()
    }

    private fun folderMenu(fo: NotebookStore.Folder) {
        AlertDialog.Builder(this)
            .setTitle(fo.name)
            .setItems(arrayOf("Open", "Add notebook here", "Rename", "Delete folder")) { _, which ->
                when (which) {
                    0 -> { currentFolder = fo.id; rebuild() }
                    1 -> createNotebookDialog(fo.id)
                    2 -> themedPrompt("Rename folder", fo.name, "Folder name", "Save") { fo.name = it.ifBlank { fo.name }; store.save(); rebuild() }
                    3 -> confirmDelete(fo.name) { if (currentFolder == fo.id) currentFolder = null; store.deleteFolder(fo); rebuild() }
                }
            }.show()
    }

    private fun coverColorDialog(nb: NotebookStore.Notebook) {
        AlertDialog.Builder(this).setTitle("Cover color")
            .setItems(covers.map { "●" }.toTypedArray()) { _, i -> nb.coverColor = covers[i]; store.save(); rebuild() }
            .show()
    }

    private fun moveDialog(nb: NotebookStore.Notebook) {
        val labels = ArrayList<String>().apply { add("Top level"); store.folders.forEach { add(it.name) } }
        AlertDialog.Builder(this).setTitle("Move to")
            .setItems(labels.toTypedArray()) { _, i ->
                nb.folderId = if (i == 0) null else store.folders[i - 1].id
                store.save(); rebuild()
            }.show()
    }

    private fun confirmDelete(name: String, onYes: () -> Unit) {
        AlertDialog.Builder(this).setTitle("Delete “$name”?")
            .setMessage("This can't be undone.")
            .setPositiveButton("Delete") { _, _ -> onYes() }
            .setNegativeButton("Cancel", null).show()
    }
}
