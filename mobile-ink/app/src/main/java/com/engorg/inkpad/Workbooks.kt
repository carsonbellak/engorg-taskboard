package com.engorg.inkpad

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.text.Html
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Library of offline study workbooks: self-contained HTML pages (Claude artifacts) read beside a
 * notebook in split view. Metadata in filesDir/workbooks/index.json; each page in
 * filesDir/workbooks/<id>.html. Device-local, like the notebooks themselves.
 *
 * One process-wide instance, unlike [NotebookStore]: the share sheet can add a workbook while
 * InkActivity sits paused, and a stale per-activity copy would drop it on its next save.
 */
object Workbooks {
    data class Workbook(
        val id: String,
        var title: String,
        var folderId: String?,
        val created: Long,
        var notesId: String? = null,   // the notebook it was last read beside (reopens as that pair)
        var lastScroll: Int = 0,
        var source: String? = null,    // the artifact link it came from: importing that again refreshes it
    )

    /** Marks a workbook in InkActivity's pane id lists, which otherwise hold notebook ids. */
    const val PANE_PREFIX = "wb:"
    private const val MAX_HTML_BYTES = 32L * 1024 * 1024

    private var root: File? = null
    private val items = ArrayList<Workbook>()

    fun init(ctx: Context) = synchronized(this) {
        if (root != null) return@synchronized
        root = File(ctx.filesDir, "workbooks").apply { mkdirs() }
        load()
    }

    private fun indexFile() = File(root, "index.json")
    fun htmlFile(id: String) = File(root, "$id.html")
    fun cdnDir() = File(root, "cdn").apply { mkdirs() }

    private fun load() {
        items.clear()
        try {
            val f = indexFile()
            if (!f.exists()) return
            val arr = JSONArray(f.readText())
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                items.add(Workbook(
                    o.getString("id"),
                    o.optString("title", "Workbook"),
                    if (o.isNull("folderId")) null else o.optString("folderId").ifBlank { null },
                    o.optLong("created", 0L),
                    if (o.isNull("notesId")) null else o.optString("notesId").ifBlank { null },
                    o.optInt("lastScroll", 0),
                    if (o.isNull("source")) null else o.optString("source").ifBlank { null },
                ))
            }
        } catch (_: Exception) { }
    }

    fun save() = synchronized(this) {
        try {
            val arr = JSONArray()
            for (w in items) arr.put(JSONObject()
                .put("id", w.id).put("title", w.title).put("folderId", w.folderId ?: JSONObject.NULL)
                .put("created", w.created).put("notesId", w.notesId ?: JSONObject.NULL).put("lastScroll", w.lastScroll)
                .put("source", w.source ?: JSONObject.NULL))
            indexFile().writeText(arr.toString())
        } catch (_: Exception) { }
    }

    fun get(id: String): Workbook? = synchronized(this) { items.find { it.id == id } }

    /** The workbook behind a pane id, or null if [paneId] is a notebook (or the workbook is gone). */
    fun fromPaneId(paneId: String?): Workbook? =
        paneId?.takeIf { it.startsWith(PANE_PREFIX) }?.let { get(it.removePrefix(PANE_PREFIX)) }

    fun paneId(w: Workbook) = PANE_PREFIX + w.id

    /** Workbooks in a folder (null = top level), newest first. */
    fun inFolder(folderId: String?): List<Workbook> = synchronized(this) {
        items.filter { it.folderId == folderId }.sortedByDescending { it.created }
    }

    fun all(): List<Workbook> = synchronized(this) { items.sortedByDescending { it.created } }

    fun add(title: String, folderId: String?, html: ByteArray, source: String? = null): Workbook {
        val w = Workbook(UUID.randomUUID().toString().replace("-", "").take(12), title, folderId, System.currentTimeMillis(), source = source)
        htmlFile(w.id).writeBytes(html)
        synchronized(this) { items.add(w) }
        save()
        return w
    }

    /** Save a page fetched from [link]: a fresh copy of that workbook if it's already here, so its
     *  id, name and quiz progress carry over, otherwise a new one. */
    fun saveFromLink(link: String, html: ByteArray, title: String): Workbook {
        val source = Uri.parse(link).buildUpon().clearQuery().fragment(null).build().toString()
        val existing = synchronized(this) { items.find { it.source == source } } ?: return add(title, null, html, source)
        htmlFile(existing.id).writeBytes(html)
        return existing
    }

    fun delete(w: Workbook) {
        htmlFile(w.id).delete()
        synchronized(this) { items.remove(w) }
        save()
    }

    /** Deleting a folder moves its workbooks up a level, matching [NotebookStore.deleteFolder]. */
    fun reparent(fromFolder: String, toFolder: String?) {
        synchronized(this) { items.filter { it.folderId == fromFolder }.forEach { it.folderId = toFolder } }
        save()
    }

    /** The panes that open [w]: the workbook beside its paired or most recently used notebook. */
    fun openIds(ctx: Context, w: Workbook, store: NotebookStore): ArrayList<String> {
        val notes = w.notesId?.takeIf { store.notebook(it) != null }
            ?: InkSettings.lastSession(ctx).firstOrNull { store.notebook(it) != null }
            ?: store.notebooks.maxByOrNull { store.lastModified(it) }?.id
        return arrayListOf(paneId(w)).apply { notes?.let { add(it) } }
    }

    /** True if [uri] names or starts like an HTML page (a picker's MIME type isn't reliable). */
    fun isHtml(ctx: Context, uri: Uri): Boolean {
        if (ctx.contentResolver.getType(uri) == "text/html") return true
        if (displayName(ctx, uri)?.lowercase()?.let { it.endsWith(".html") || it.endsWith(".htm") } == true) return true
        return try {
            ctx.contentResolver.openInputStream(uri)?.use { ins ->
                val head = ByteArray(512)
                val n = ins.read(head)
                n > 0 && String(head, 0, n, Charsets.UTF_8).trimStart('﻿', ' ', '\n', '\r', '\t').lowercase()
                    .let { it.startsWith("<!doctype html") || it.startsWith("<html") }
            } ?: false
        } catch (_: Exception) { false }
    }

    /** Copy an HTML file in as a new workbook. Blocking; returns null if it can't be read. */
    fun importFile(ctx: Context, uri: Uri, folderId: String?): Workbook? = try {
        val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        if (bytes == null || bytes.isEmpty() || bytes.size > MAX_HTML_BYTES) null else {
            val fallback = displayName(ctx, uri)?.replace(Regex("(?i)\\.html?$"), "")?.trim()?.ifBlank { null } ?: "Workbook"
            add(titleOf(String(bytes, Charsets.UTF_8), fallback), folderId, bytes)
        }
    } catch (_: Exception) { null }

    /** True for a claude.ai link to a published artifact (not just any page on the site). */
    fun isArtifactLink(url: Uri): Boolean {
        val host = url.host ?: return false
        return url.scheme == "https" && (host == "claude.ai" || host.endsWith(".claude.ai")) &&
            url.pathSegments.any { it == "artifact" || it == "artifacts" }
    }

    fun titleOf(html: String, fallback: String): String =
        Regex("<title[^>]*>([^<]*)</title>", RegexOption.IGNORE_CASE).find(html)?.groupValues?.get(1)
            ?.let { Html.fromHtml(it, Html.FROM_HTML_MODE_LEGACY).toString().trim() }?.ifBlank { null } ?: fallback

    private fun displayName(ctx: Context, uri: Uri): String? = try {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) { null }
}

/**
 * Everything a workbook's WebView loads goes through [serve]. The page lives at its own fake https
 * origin (so `localStorage` quiz progress works and stays per-workbook), libraries from the CDNs
 * artifacts may use are cached on first load and replayed offline, and anything else gets a 404:
 * a page can't reach the network except to fetch those static files.
 */
class WorkbookNet(private val workbook: Workbooks.Workbook) {
    val host = "${workbook.id}.workbook.engink.invalid"
    val pageUrl = "https://$host/index.html"

    // Read by the offline capture to tell when the page has stopped loading.
    val inFlight = AtomicInteger(0)
    val failed = AtomicInteger(0)
    @Volatile var lastActivity = System.currentTimeMillis()
    /** The MathJax root the page loaded, so its optional extensions can be saved too. */
    @Volatile var mathJaxBase: String? = null

    fun serve(request: WebResourceRequest): WebResourceResponse {
        val url = request.url
        if (url.host == host) return if (url.path == "/index.html") page() else missing()
        if (request.method != "GET" || url.scheme != "https" || url.host !in CDN_HOSTS) return missing()
        val full = url.toString()
        MATHJAX_ROOT.find(full)?.let { mathJaxBase = it.value }
        inFlight.incrementAndGet()
        lastActivity = System.currentTimeMillis()
        try {
            val hit = cached(full) ?: if (store(full, request.requestHeaders)) cached(full) else null
            if (hit == null) failed.incrementAndGet()
            return hit ?: missing()
        } catch (_: Exception) {
            // Thrown here it would crash the whole app, handwriting included.
            failed.incrementAndGet()
            return missing()
        } finally {
            lastActivity = System.currentTimeMillis()
            inFlight.decrementAndGet()
        }
    }

    /** The saved page, told the app's theme through the `data-theme` hook artifacts honor. */
    private fun page(): WebResourceResponse {
        val theme = if (AppTheme.dark) "dark" else "light"
        val tag = "<script>document.documentElement.setAttribute('data-theme','$theme')</script>"
        val html = try { Workbooks.htmlFile(workbook.id).readText() } catch (_: Exception) { return missing() }
        val head = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html)
        val out = if (head != null) html.replaceRange(head.range.last + 1, head.range.last + 1, tag) else html
        // WebSockets skip shouldInterceptRequest, so CSP is what shuts them out.
        val headers = mapOf("Content-Security-Policy" to "connect-src https: data: blob:; form-action 'none'", "Cache-Control" to "no-store")
        return WebResourceResponse("text/html", "utf-8", 200, "OK", headers, ByteArrayInputStream(out.toByteArray()))
    }

    private fun missing() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun cached(url: String): WebResourceResponse? {
        val (body, meta) = cacheFiles(url)
        if (!body.exists() || !meta.exists()) return null
        return try {
            val parts = meta.readText().split(";").map { it.trim() }
            val charset = parts.drop(1).firstOrNull { it.startsWith("charset=", true) }?.substringAfter("=")?.trim('"')
            // Fonts and module scripts are fetched CORS-mode from the page's fake origin.
            val headers = mapOf("Access-Control-Allow-Origin" to "*")
            WebResourceResponse(parts[0].ifBlank { "application/octet-stream" }, charset, 200, "OK", headers, body.inputStream())
        } catch (_: Exception) { null }
    }

    companion object {
        // The CDNs Claude artifacts are allowed to load from.
        private val CDN_HOSTS = setOf(
            "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "cdn.tailwindcss.com",
            "code.jquery.com", "fonts.googleapis.com", "fonts.gstatic.com",
        )
        private val MATHJAX_ROOT = Regex("^https://cdn\\.jsdelivr\\.net/npm/mathjax@[^/]+/es5/")
        // Autoloaded the first time a formula uses them, which can be long after the first load
        // (an answer revealed later, offline), so they're saved up front.
        private val MATHJAX_EXTENSIONS = listOf(
            "action", "amscd", "bbox", "boldsymbol", "braket", "cancel", "cases", "color", "colorv2", "empheq",
            "enclose", "extpfeil", "gensymb", "html", "mathtools", "mhchem", "noerrors", "physics", "setoptions",
            "textcomp", "textmacros", "unicode", "upgreek", "verb",
        )
        private const val MAX_ASSET_BYTES = 32L * 1024 * 1024
        private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

        private fun cacheFiles(url: String): Pair<File, File> {
            val hash = MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }
            val dir = Workbooks.cdnDir()
            return File(dir, "$hash.bin") to File(dir, "$hash.type")
        }

        /** Save one CDN file. The cache is shared, so each workbook doesn't keep its own MathJax. */
        private fun store(url: String, headers: Map<String, String>?): Boolean {
            val (body, meta) = cacheFiles(url)
            val tmp = File(body.path + "." + Thread.currentThread().id + ".tmp")
            try {
                val req = Request.Builder().url(url)
                // Google Fonts picks its CSS by User-Agent; pass the WebView's so it offers woff2.
                headers?.get("User-Agent")?.let { req.header("User-Agent", it) }
                http.newCall(req.build()).execute().use { res ->
                    val src = res.body
                    if (!res.isSuccessful || src == null || src.contentLength() > MAX_ASSET_BYTES) return false
                    tmp.outputStream().use { src.byteStream().copyTo(it) }
                    meta.writeText(res.header("Content-Type") ?: "application/octet-stream")
                    return tmp.renameTo(body)
                }
            } catch (_: Exception) {
                return false
            } finally {
                tmp.delete()
            }
        }

        /** Best-effort: a miss only matters if a formula needs that extension while offline. */
        fun saveMathJaxExtensions(base: String) {
            for (name in MATHJAX_EXTENSIONS) {
                val url = "${base}input/tex/extensions/$name.js"
                if (!cacheFiles(url).first.exists()) store(url, null)
            }
        }

        /** Lock a WebView down to viewing one saved page: no file access, no popups. */
        fun lockDown(web: WebView) {
            web.settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true
                allowFileAccess = false; allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false)
                setGeolocationEnabled(false)
                cacheMode = WebSettings.LOAD_NO_CACHE
            }
        }
    }
}
