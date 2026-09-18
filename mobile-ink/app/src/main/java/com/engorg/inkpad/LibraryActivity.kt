package com.engorg.inkpad

import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity

/** Notebook browser: folders + cover tiles. Entry point from the PWA's Ink tab. */
class LibraryActivity : ComponentActivity() {

    private lateinit var store: NotebookStore
    private lateinit var content: LinearLayout

    private val covers = intArrayOf(
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0x89, 0x7B),
        Color.rgb(0x2E, 0x7D, 0x32), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0xDC, 0x26, 0x50),
        Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0x45, 0x4B, 0x55),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = NotebookStore(filesDir)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(0xF3, 0xF4, 0xF6))
        }
        root.addView(buildBar())
        val scroll = ScrollView(this)
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(48))
        }
        scroll.addView(content)
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        store.reload()
        rebuild()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildBar(): View {
        fun btn(t: String, f: () -> Unit) = Button(this).apply { text = t; setOnClickListener { f() } }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.WHITE)
            setPadding(dp(8), dp(6), dp(8), dp(6))
            addView(btn("‹ App") { finish() })
            addView(TextView(this@LibraryActivity).apply {
                text = "  Notebooks"; textSize = 18f; setTypeface(null, Typeface.BOLD)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(btn("+ Folder") { createFolderDialog() })
            addView(btn("+ Notebook") { createNotebookDialog(null) })
        }
    }

    private fun rebuild() {
        content.removeAllViews()
        val top = store.notebooksIn(null)
        if (top.isNotEmpty()) content.addView(gridOf(top))
        for (fo in store.folders) {
            content.addView(folderHeader(fo))
            val nbs = store.notebooksIn(fo.id)
            if (nbs.isEmpty()) content.addView(hint("  (empty)")) else content.addView(gridOf(nbs))
        }
        if (store.notebooks.isEmpty() && store.folders.isEmpty()) {
            content.addView(hint("No notebooks yet — tap “+ Notebook” to start."))
        }
    }

    private fun hint(t: String) = TextView(this).apply {
        text = t; setTextColor(Color.rgb(0x8A, 0x92, 0x9E)); textSize = 14f
        setPadding(dp(4), dp(10), dp(4), dp(10))
    }

    private fun folderHeader(fo: NotebookStore.Folder) = TextView(this).apply {
        text = "📁 ${fo.name}"; textSize = 15f; setTypeface(null, Typeface.BOLD)
        setPadding(dp(4), dp(18), dp(4), dp(6))
        setOnLongClickListener { folderMenu(fo); true }
    }

    private fun gridOf(nbs: List<NotebookStore.Notebook>): View {
        val cols = 3
        return GridLayout(this).apply {
            columnCount = cols
            for (nb in nbs) addView(tile(nb))
        }
    }

    private fun tile(nb: NotebookStore.Notebook): View {
        val w = dp(150); val h = dp(186); val m = dp(6)
        val card = FrameLayout(this).apply {
            layoutParams = GridLayout.LayoutParams().apply { width = w; height = h; setMargins(m, m, m, m) }
            background = GradientDrawable().apply {
                cornerRadius = dp(12).toFloat(); setColor(nb.coverColor)
            }
            setOnClickListener { openNotebook(nb) }
            setOnLongClickListener { notebookMenu(nb); true }
        }
        card.addView(TextView(this).apply {
            text = nb.title
            setTextColor(Color.WHITE); textSize = 15f; setTypeface(null, Typeface.BOLD)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.BOTTOM }
        })
        card.addView(TextView(this).apply {
            text = "${nb.pageIds.size} pg"
            setTextColor(Color.argb(0xCC, 255, 255, 255)); textSize = 11f
            setPadding(dp(12), dp(10), dp(12), dp(10))
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.TOP or Gravity.END }
        })
        return card
    }

    private fun openNotebook(nb: NotebookStore.Notebook) {
        startActivity(Intent(this, InkActivity::class.java).putExtra(InkActivity.EXTRA_NOTEBOOK_ID, nb.id))
    }

    // ---- dialogs ----
    private fun createNotebookDialog(folderId: String?) {
        val input = EditText(this).apply { hint = "Notebook title" }
        AlertDialog.Builder(this)
            .setTitle("New notebook")
            .setView(input)
            .setPositiveButton("Create") { _, _ ->
                val title = input.text.toString().ifBlank { "Untitled" }
                val nb = store.createNotebook(title, folderId, covers.random())
                rebuild()
                openNotebook(nb)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun createFolderDialog() {
        val input = EditText(this).apply { hint = "Folder name" }
        AlertDialog.Builder(this)
            .setTitle("New folder")
            .setView(input)
            .setPositiveButton("Create") { _, _ ->
                store.createFolder(input.text.toString().ifBlank { "Folder" }); rebuild()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun notebookMenu(nb: NotebookStore.Notebook) {
        AlertDialog.Builder(this)
            .setTitle(nb.title)
            .setItems(arrayOf("Rename", "Cover color", "Move to folder", "Delete")) { _, which ->
                when (which) {
                    0 -> renameNotebook(nb)
                    1 -> coverColorDialog(nb)
                    2 -> moveDialog(nb)
                    3 -> confirmDelete(nb.title) { store.deleteNotebook(nb); rebuild() }
                }
            }.show()
    }

    private fun folderMenu(fo: NotebookStore.Folder) {
        AlertDialog.Builder(this)
            .setTitle(fo.name)
            .setItems(arrayOf("Add notebook here", "Rename", "Delete folder")) { _, which ->
                when (which) {
                    0 -> createNotebookDialog(fo.id)
                    1 -> {
                        val input = EditText(this).apply { setText(fo.name) }
                        AlertDialog.Builder(this).setTitle("Rename folder").setView(input)
                            .setPositiveButton("Save") { _, _ -> fo.name = input.text.toString().ifBlank { fo.name }; store.save(); rebuild() }
                            .setNegativeButton("Cancel", null).show()
                    }
                    2 -> confirmDelete(fo.name) { store.deleteFolder(fo); rebuild() }
                }
            }.show()
    }

    private fun renameNotebook(nb: NotebookStore.Notebook) {
        val input = EditText(this).apply { setText(nb.title) }
        AlertDialog.Builder(this).setTitle("Rename").setView(input)
            .setPositiveButton("Save") { _, _ -> nb.title = input.text.toString().ifBlank { nb.title }; store.save(); rebuild() }
            .setNegativeButton("Cancel", null).show()
    }

    private fun coverColorDialog(nb: NotebookStore.Notebook) {
        val names = covers.map { "●" }.toTypedArray()
        AlertDialog.Builder(this).setTitle("Cover color")
            .setItems(names) { _, i -> nb.coverColor = covers[i]; store.save(); rebuild() }
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
