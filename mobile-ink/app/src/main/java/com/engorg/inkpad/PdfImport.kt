package com.engorg.inkpad

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import kotlin.math.min

/**
 * Imports a PDF as a new notebook you can write on: one notebook page per PDF page, each PDF page
 * rendered (contain-fit, centered, like [NoteshelfImport]) into that page's baked background image
 * ([NotebookStore.pageBgFile]) with no ink yet. The PDF itself isn't kept.
 *
 * Runs on a background thread; [onProgress]/[onDone] are delivered on the main thread.
 */
object PdfImport {

    private val PAGE_W = FinishedStrokesView.PAGE_W
    private val PAGE_H = FinishedStrokesView.PAGE_H
    /** Background pixels per page unit: 2x keeps small print sharp when zoomed in. */
    private const val RES = 2f

    /** True if [uri] starts with the PDF magic bytes (the picker's MIME type isn't reliable). */
    fun isPdf(context: Context, uri: Uri): Boolean = try {
        context.contentResolver.openInputStream(uri)?.use { ins ->
            val head = ByteArray(5)
            ins.read(head) == 5 && String(head, Charsets.US_ASCII) == "%PDF-"
        } ?: false
    } catch (_: Exception) { false }

    fun importPdf(
        context: Context,
        uri: Uri,
        store: NotebookStore,
        folderId: String?,
        onProgress: (String) -> Unit,
        onDone: (NotebookStore.Notebook?, String?) -> Unit,
    ) {
        val main = Handler(Looper.getMainLooper())
        fun progress(s: String) = main.post { onProgress(s) }
        Thread {
            var result: NotebookStore.Notebook? = null
            var error: String? = null
            val work = File(context.cacheDir, "pdf_import").apply { mkdirs() }
            val local = File(work, "import.pdf")
            try {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    local.outputStream().use { input.copyTo(it) }
                } ?: throw IllegalStateException("Can't open the file.")
                val title = displayName(context, uri)?.replace(Regex("(?i)\\.pdf$"), "")?.trim()?.ifBlank { null } ?: "PDF"

                val pfd = ParcelFileDescriptor.open(local, ParcelFileDescriptor.MODE_READ_ONLY)
                val renderer = try { PdfRenderer(pfd) } catch (_: SecurityException) {
                    pfd.close(); throw IllegalStateException("That PDF is password-protected.")
                }
                try {
                    val count = renderer.pageCount
                    if (count == 0) throw IllegalStateException("That PDF has no pages.")
                    val cover = Covers.ALL[(title.hashCode() and Int.MAX_VALUE) % Covers.ALL.size]
                    val nb = store.createNotebook(title, folderId, cover.base, "PLAIN", Color.WHITE, cover.id)
                    nb.pageIds.clear()
                    // One reusable bitmap for every page; each is written out before the next renders.
                    val bmp = Bitmap.createBitmap((PAGE_W * RES).toInt(), (PAGE_H * RES).toInt(), Bitmap.Config.ARGB_8888)
                    try {
                        for (i in 0 until count) {
                            progress("Rendering page ${i + 1} of $count")
                            val pageId = store.addPage(nb)
                            try {
                                val page = renderer.openPage(i)
                                try {
                                    bmp.eraseColor(Color.WHITE)
                                    val s = min(bmp.width / page.width.toFloat(), bmp.height / page.height.toFloat())
                                    val m = Matrix().apply {
                                        setScale(s, s)
                                        postTranslate((bmp.width - page.width * s) / 2f, (bmp.height - page.height * s) / 2f)
                                    }
                                    page.render(bmp, null, m, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                } finally { page.close() }
                                store.pageBgFile(pageId).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                            } catch (_: Exception) { /* keep the page (blank) so numbering matches the PDF */ }
                        }
                    } finally { bmp.recycle() }
                    store.save()
                    result = nb
                } finally { renderer.close() }
            } catch (e: Exception) {
                error = e.message ?: "Import failed."
            } finally {
                runCatching { work.deleteRecursively() }
            }
            val nb = result
            val err = error
            main.post { onDone(nb, err) }
        }.start()
    }

    private fun displayName(context: Context, uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) { null }
}
