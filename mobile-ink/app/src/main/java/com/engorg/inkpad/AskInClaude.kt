package com.engorg.inkpad

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

/**
 * "Ask in Claude": hand the focused page (or every inked page) to the official Claude Android app as
 * image attachments, opened beside EngInk in split-screen where the tablet supports it. The chat runs on
 * the user's own Claude subscription, so no API key or credits are involved. The reply stays in the
 * Claude app; nothing comes back into EngInk.
 *
 * Trial replacement for the API-key [ClaudePanel], which is kept but switched off by [USE_API_PANEL].
 */
object AskInClaude {
    /** Flip to true to bring back the in-app API-key feedback panel on the ✨ button. */
    const val USE_API_PANEL = false

    private const val CLAUDE_PACKAGE = "com.anthropic.claude"
    private const val AUTHORITY = "com.engorg.inkpad.fileprovider"
    private const val MAX_PAGES = 20

    fun open(act: Activity, pane: PageCanvas, all: Boolean) {
        val files = renderPages(act, pane, all) ?: return
        val uris = files.map { FileProvider.getUriForFile(act, AUTHORITY, it) }
        val intent = shareIntent(uris)
        // Prefer the Claude app beside EngInk; fall back to the share sheet if it isn't installed.
        try {
            act.startActivity(Intent(intent).setPackage(CLAUDE_PACKAGE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(act, "Claude app not found — pick where to send the page.", Toast.LENGTH_SHORT).show()
            act.startActivity(Intent.createChooser(intent, "Ask about this page"))
        }
    }

    private fun shareIntent(uris: List<Uri>): Intent {
        val intent = if (uris.size == 1) Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
                     else Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
        // ClipData carries the read grant for every attachment, not just the first.
        val clip = ClipData.newRawUri("page", uris[0]).also { c -> uris.drop(1).forEach { c.addItem(ClipData.Item(it)) } }
        return intent.apply {
            type = "image/png"
            clipData = clip
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /**
     * Render the current page (or every page with ink on it, capped at [MAX_PAGES]) to PNG files in the
     * cache, numbered by page. Same sizing as [ClaudePanel]'s snapshot: long edge ≤ ~1568px, the size
     * Claude reads at full detail.
     */
    private fun renderPages(act: Activity, pane: PageCanvas, all: Boolean): List<File>? {
        val pages = pane.finishedView.pages
        val idx = if (all) pages.indices.filter { !pages[it].isBlank() }.take(MAX_PAGES)
                  else listOf(pane.currentPage()).filter { it in pages.indices && !pages[it].isBlank() }
        if (idx.isEmpty()) {
            Toast.makeText(act, if (all) "This notebook is empty." else "Nothing on this page yet.", Toast.LENGTH_SHORT).show()
            return null
        }
        val dir = File(act.cacheDir, "claude_share").apply { deleteRecursively(); mkdirs() }
        val s = (if (all && idx.size > 4) 1200f else 1568f) / FinishedStrokesView.PAGE_H
        val w = (FinishedStrokesView.PAGE_W * s).toInt(); val h = (FinishedStrokesView.PAGE_H * s).toInt()
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val safeTitle = pane.notebook.title.replace(Regex("[^A-Za-z0-9 _-]"), "").trim().ifEmpty { "Notebook" }
        val out = ArrayList<File>()
        try {
            val canvas = Canvas(bmp)
            for (i in idx) {
                bmp.eraseColor(Color.WHITE)
                pane.finishedView.renderPageInto(canvas, i, s)
                val f = File(dir, "$safeTitle - page ${i + 1}.png")
                FileOutputStream(f).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                out.add(f)
            }
        } finally { bmp.recycle() }
        return out
    }
}
