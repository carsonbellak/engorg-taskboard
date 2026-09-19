package com.engorg.inkpad

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipFile
import kotlin.math.min

/**
 * Imports a Noteshelf export .zip into the notebook library as EDITABLE ink.
 *
 * Structure: `<export>/<name>.shelf/<class>.group/<notebook>.nsa`. Each `.nsa` is itself a zip
 * wrapping a `<title>.ns3_a/` bundle: `Document.plist` (ordered pages), `Annotations/<page-uuid>`
 * (a SQLite DB of strokes), and `Templates/*.ns_pdf` (page backgrounds). See the `noteshelf-format`
 * memory for the decoded byte layout.
 *
 * Ink: one row per stroke in the `annotation` table; `stroke_segments_v3` is packed 16-byte records
 * (float32 x, float32 y, …). Points are uniformly contain-fit into NoteOrg's 8.5x11 page so nothing
 * is squished. Backgrounds are rendered best-effort — a failure there never fails the ink import.
 *
 * Runs on a background thread; [onProgress]/[onDone] are delivered on the main thread.
 */
object NoteshelfImport {

    private val PAGE_W = FinishedStrokesView.PAGE_W
    private val PAGE_H = FinishedStrokesView.PAGE_H
    private const val BG_SCALE = 2 // background render supersampling

    private val covers = intArrayOf(
        Color.rgb(0x29, 0x47, 0xC9), Color.rgb(0x1E, 0x88, 0xE5), Color.rgb(0x00, 0x89, 0x7B),
        Color.rgb(0x2E, 0x7D, 0x32), Color.rgb(0xF5, 0x7C, 0x00), Color.rgb(0xDC, 0x26, 0x50),
        Color.rgb(0x8E, 0x24, 0xAA), Color.rgb(0x5E, 0x35, 0xB1), Color.rgb(0x45, 0x4B, 0x55),
    )

    fun import(
        context: Context,
        zipUri: Uri,
        store: NotebookStore,
        onProgress: (String) -> Unit,
        onDone: (Int, String?) -> Unit,
    ) {
        val main = Handler(Looper.getMainLooper())
        fun progress(s: String) = main.post { onProgress(s) }
        Thread {
            var imported = 0
            var error: String? = null
            val work = File(context.cacheDir, "ns_import").apply { mkdirs() }
            val localZip = File(work, "export.zip")
            try {
                context.contentResolver.openInputStream(zipUri)?.use { input ->
                    localZip.outputStream().use { input.copyTo(it) }
                } ?: throw IllegalStateException("Can't open the file.")

                ZipFile(localZip).use { outer ->
                    val nsaEntries = outer.entries().toList().filter { !it.isDirectory && it.name.endsWith(".nsa") }
                    if (nsaEntries.isEmpty()) throw IllegalStateException("No Noteshelf notebooks (.nsa) found in that zip.")
                    val folderIds = HashMap<String, String>() // folder name -> id
                    var i = 0
                    for (entry in nsaEntries) {
                        i++
                        val title = entry.name.substringAfterLast('/').removeSuffix(".nsa").ifBlank { "Notebook" }
                        progress("Importing $i of ${nsaEntries.size}: $title")
                        try {
                            val folderName = folderNameFor(entry.name)
                            val folderId = folderName?.let { name ->
                                folderIds.getOrPut(name) {
                                    (store.folders.firstOrNull { it.name == name }?.id) ?: store.createFolder(name).id
                                }
                            }
                            val nsaTmp = File(work, "nb.nsa")
                            outer.getInputStream(entry).use { ins -> nsaTmp.outputStream().use { ins.copyTo(it) } }
                            if (importNotebook(nsaTmp, work, store, title, folderId)) imported++
                            nsaTmp.delete()
                        } catch (_: Exception) { /* skip this notebook, keep going */ }
                    }
                    store.save()
                }
            } catch (e: Exception) {
                error = e.message ?: "Import failed."
            } finally {
                runCatching { work.deleteRecursively() }
            }
            val count = imported
            val err = error
            main.post { onDone(count, err) }
        }.start()
    }

    private fun folderNameFor(entryName: String): String? {
        val parts = entryName.split('/')
        parts.lastOrNull { it.endsWith(".group") }?.let { return it.removeSuffix(".group") }
        parts.lastOrNull { it.endsWith(".shelf") }?.let { return it.removeSuffix(".shelf") }
        return null
    }

    /** @return true if at least one page was imported. */
    private fun importNotebook(nsa: File, work: File, store: NotebookStore, title: String, folderId: String?): Boolean {
        ZipFile(nsa).use { inner ->
            val docEntry = inner.entries().toList().firstOrNull { it.name.endsWith("/Document.plist") || it.name == "Document.plist" }
                ?: return false
            val bundle = docEntry.name.removeSuffix("Document.plist").trimEnd('/') // "<title>.ns3_a"
            val doc = inner.getInputStream(docEntry).use { PlistLite.parseDict(it) }
            @Suppress("UNCHECKED_CAST")
            val pages = (doc["pages"] as? List<Any?>)?.mapNotNull { it as? Map<String, Any?> } ?: return false

            val cover = covers[(title.hashCode() and Int.MAX_VALUE) % covers.size]
            var pageColor = Color.WHITE
            var pageColorSet = false
            val nb = store.createNotebook(title, folderId, cover, "PLAIN", pageColor)
            nb.pageIds.clear()

            for (pg in pages) {
                if (pg["isCover"] == true) continue
                val uuid = (pg["uuid"] as? String) ?: continue
                val (nsW, nsH) = pageSize(pg["pdfKitPageRect"] as? String)
                val bgColor = hexColor(pg["pageBGColor"] as? String) ?: Color.WHITE
                if (!pageColorSet) { pageColor = bgColor; pageColorSet = true }

                val s = min(PAGE_W / nsW, PAGE_H / nsH)
                val ox = (PAGE_W - nsW * s) / 2f
                val oy = (PAGE_H - nsH * s) / 2f

                val annEntry = inner.getEntry("$bundle/Annotations/$uuid") ?: continue
                val strokes = try {
                    val dbTmp = File(work, "ann.db")
                    inner.getInputStream(annEntry).use { ins -> dbTmp.outputStream().use { ins.copyTo(it) } }
                    val arr = decodeStrokes(dbTmp, s, ox, oy)
                    dbTmp.delete()
                    arr
                } catch (_: Exception) { JSONArray() }

                val pageId = store.addPage(nb) // appends a fresh id in order and returns it
                try {
                    store.pageFile(pageId).writeText(JSONObject().put("strokes", strokes).toString())
                } catch (_: Exception) {}

                // Best-effort background: render the page's associated PDF behind the ink.
                try {
                    val pdfName = pg["associatedPDFFileName"] as? String
                    val pdfIdx = ((pg["associatedPDFKitPageIndex"] as? Long)?.toInt() ?: 1) - 1
                    if (!pdfName.isNullOrBlank()) {
                        val pdfEntry = inner.getEntry("$bundle/Templates/$pdfName")
                        if (pdfEntry != null) {
                            val pdfTmp = File(work, "bg.pdf")
                            inner.getInputStream(pdfEntry).use { ins -> pdfTmp.outputStream().use { ins.copyTo(it) } }
                            renderBackground(pdfTmp, pdfIdx.coerceAtLeast(0), nsW, nsH, s, ox, oy, bgColor, store.pageBgFile(pageId))
                            pdfTmp.delete()
                        }
                    }
                } catch (_: Exception) { store.pageBgFile(pageId).delete() }
            }

            if (nb.pageIds.isEmpty()) { store.deleteNotebook(nb); return false }
            nb.pageColor = pageColor
            return true
        }
    }

    /** Decode all ink strokes from one page's SQLite annotation DB into NoteOrg page JSON. */
    private fun decodeStrokes(db: File, s: Float, ox: Float, oy: Float): JSONArray {
        val arr = JSONArray()
        val con = SQLiteDatabase.openDatabase(db.path, null, SQLiteDatabase.OPEN_READONLY)
        try {
            val cur = con.rawQuery(
                "SELECT strokeColor,strokeWidth,annotationType,txMatrix,stroke_segments_v3 FROM annotation",
                null,
            )
            cur.use { c ->
                while (c.moveToNext()) {
                    if (c.getInt(2) != 0) continue // only freehand ink strokes
                    val blob = c.getBlob(4) ?: continue
                    if (blob.size < 16) continue
                    val m = parseMatrix(c.getString(3))
                    val rgb = c.getInt(0) and 0xFFFFFF
                    val width = (c.getDouble(1).toFloat() * s).coerceAtLeast(0.3f)
                    val bb = ByteBuffer.wrap(blob).order(ByteOrder.LITTLE_ENDIAN)
                    val n = blob.size / 16
                    val pts = JSONArray()
                    for (k in 0 until n) {
                        val x = bb.getFloat(k * 16)
                        val y = bb.getFloat(k * 16 + 4)
                        val mx = m[0] * x + m[2] * y + m[4]
                        val my = m[1] * x + m[3] * y + m[5]
                        pts.put(JSONArray().put((ox + mx * s).toDouble()).put((oy + my * s).toDouble()))
                    }
                    if (pts.length() == 0) continue
                    arr.put(
                        JSONObject()
                            .put("c", 0xFF000000.toInt() or rgb)
                            .put("w", width.toDouble())
                            .put("h", false)
                            .put("k", "f")
                            .put("p", pts),
                    )
                }
            }
        } finally { con.close() }
        return arr
    }

    private fun renderBackground(
        pdf: File, pageIndex: Int, nsW: Float, nsH: Float, s: Float, ox: Float, oy: Float, bgColor: Int, out: File,
    ) {
        val pfd = ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY)
        val renderer = PdfRenderer(pfd)
        try {
            val idx = pageIndex.coerceIn(0, renderer.pageCount - 1)
            val page = renderer.openPage(idx)
            try {
                val bw = (PAGE_W * BG_SCALE).toInt()
                val bh = (PAGE_H * BG_SCALE).toInt()
                val bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bmp)
                canvas.drawColor(bgColor)
                // Map the PDF page onto the same contain-fit rect the strokes use, then supersample.
                val destW = nsW * s * BG_SCALE
                val destH = nsH * s * BG_SCALE
                val mtx = Matrix().apply {
                    setScale(destW / page.width, destH / page.height)
                    postTranslate(ox * BG_SCALE, oy * BG_SCALE)
                }
                page.render(bmp, null, mtx, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                FileOutputStream(out).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bmp.recycle()
            } finally { page.close() }
        } finally { renderer.close(); pfd.close() }
    }

    /** "{{0.0, 0.0}}, {1440.0, 2304.0}}" -> width,height (falls back to letter aspect). */
    private fun pageSize(rect: String?): Pair<Float, Float> {
        if (rect == null) return PAGE_W to PAGE_H
        val nums = Regex("[0-9]+(?:\\.[0-9]+)?").findAll(rect).map { it.value.toFloat() }.toList()
        val w = nums.getOrNull(2)?.takeIf { it > 1f } ?: PAGE_W
        val h = nums.getOrNull(3)?.takeIf { it > 1f } ?: PAGE_H
        return w to h
    }

    private fun parseMatrix(s: String?): FloatArray {
        val id = floatArrayOf(1f, 0f, 0f, 1f, 0f, 0f)
        if (s.isNullOrBlank()) return id
        val nums = Regex("-?[0-9]+(?:\\.[0-9]+)?(?:[eE]-?[0-9]+)?").findAll(s).map { it.value.toFloat() }.toList()
        return if (nums.size >= 6) floatArrayOf(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]) else id
    }

    private fun hexColor(hex: String?): Int? {
        if (hex.isNullOrBlank()) return null
        return try { Color.parseColor(if (hex.startsWith("#")) hex else "#$hex") } catch (_: Exception) { null }
    }
}
