package com.engorg.inkpad

import android.content.Context
import android.util.Base64
import android.webkit.JavascriptInterface
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Exposed to the PWA as window.AndroidFiles: saves a file to Downloads. A WebView has neither
 * navigator.share nor downloads of its own, so without this a blob "download" silently does nothing.
 *
 * The bridge only carries strings, so the bytes come as base64 chunks: begin() → append()… → finish().
 * They collect in a cache file, so a failed save leaves nothing half-written in Downloads.
 * [allowed] is checked on every call because links can take the WebView to other sites.
 */
class FileSaveBridge(private val ctx: Context, private val allowed: () -> Boolean) {

    private val saves = ConcurrentHashMap<String, File>()

    /** Starts a save; returns its id, or "" if refused. */
    @JavascriptInterface
    fun begin(): String {
        if (!allowed()) return ""
        return try {
            val dir = File(ctx.cacheDir, "share_saves").apply { mkdirs() }
            val id = UUID.randomUUID().toString()
            saves[id] = File.createTempFile("save", null, dir)
            id
        } catch (_: Exception) { "" }
    }

    /** Adds one chunk; false if it couldn't be written. */
    @JavascriptInterface
    fun append(id: String, base64: String): Boolean {
        val file = saves[id] ?: return false
        if (!allowed()) return false
        return try { file.appendBytes(Base64.decode(base64, Base64.DEFAULT)); true } catch (_: Exception) { false }
    }

    /** Moves the finished file to Downloads; returns where it went, or "" on failure. */
    @JavascriptInterface
    fun finish(id: String, name: String, mime: String): String {
        val file = saves.remove(id) ?: return ""
        try {
            if (!allowed()) return ""
            val safeName = File(name).name.ifBlank { "file" }
            return AssignmentSubmit.saveToDownloads(ctx, file, safeName, mime.ifBlank { "application/octet-stream" }, null) ?: ""
        } catch (_: Exception) {
            return ""
        } finally {
            file.delete()
        }
    }

    @JavascriptInterface
    fun abort(id: String) { saves.remove(id)?.delete() }
}
