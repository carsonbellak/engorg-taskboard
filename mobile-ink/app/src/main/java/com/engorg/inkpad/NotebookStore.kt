package com.engorg.inkpad

import android.graphics.Color
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Local-first notebook library: folders, notebooks (each with a cover + ordered pages), and
 * per-page ink files. Metadata in filesDir/library.json; each page in filesDir/pages/page_<id>.json.
 */
class NotebookStore(private val dir: File) {

    data class Folder(val id: String, var name: String, var parentId: String? = null)
    data class Notebook(
        val id: String,
        var title: String,
        var folderId: String?,
        var coverColor: Int,
        val created: Long,
        val pageIds: MutableList<String>,
        var paper: String = "GRID",
        var pageColor: Int = Color.WHITE,
        var lastPage: Int = 0,   // page this notebook was last viewed on (restored on reopen)
    )

    val folders = ArrayList<Folder>()
    val notebooks = ArrayList<Notebook>()

    private fun libFile() = File(dir, "library.json")
    private fun pagesDir() = File(dir, "pages").apply { mkdirs() }
    fun pageFile(pageId: String) = File(pagesDir(), "page_$pageId.json")
    /** Optional baked background image for a page (e.g. an imported Noteshelf page). */
    fun pageBgFile(pageId: String) = File(pagesDir(), "page_$pageId.bg.png")

    init { load() }

    fun reload() = load()

    private fun load() {
        folders.clear(); notebooks.clear()
        try {
            val f = libFile()
            if (!f.exists()) return
            val doc = JSONObject(f.readText())
            doc.optJSONArray("folders")?.let { fa ->
                for (i in 0 until fa.length()) {
                    val o = fa.getJSONObject(i)
                    val pid = if (o.has("parentId") && !o.isNull("parentId")) o.getString("parentId") else null
                    folders.add(Folder(o.getString("id"), o.getString("name"), pid))
                }
            }
            doc.optJSONArray("notebooks")?.let { na ->
                for (i in 0 until na.length()) {
                    val o = na.getJSONObject(i)
                    val pages = ArrayList<String>()
                    o.optJSONArray("pages")?.let { pa -> for (j in 0 until pa.length()) pages.add(pa.getString(j)) }
                    val fid = if (o.isNull("folderId")) null else o.getString("folderId")
                    notebooks.add(
                        Notebook(
                            o.getString("id"),
                            o.optString("title", "Untitled"),
                            fid,
                            o.optInt("cover", Color.rgb(0x29, 0x47, 0xC9)),
                            o.optLong("created", 0L),
                            pages,
                            o.optString("paper", "GRID"),
                            o.optInt("pageColor", Color.WHITE),
                            o.optInt("lastPage", 0),
                        )
                    )
                }
            }
        } catch (_: Exception) { }
    }

    fun save() {
        try {
            val fa = JSONArray()
            for (fo in folders) fa.put(JSONObject().put("id", fo.id).put("name", fo.name).put("parentId", fo.parentId ?: JSONObject.NULL))
            val na = JSONArray()
            for (nb in notebooks) {
                val pa = JSONArray(); nb.pageIds.forEach { pa.put(it) }
                na.put(
                    JSONObject()
                        .put("id", nb.id)
                        .put("title", nb.title)
                        .put("folderId", nb.folderId ?: JSONObject.NULL)
                        .put("cover", nb.coverColor)
                        .put("created", nb.created)
                        .put("pages", pa)
                        .put("paper", nb.paper)
                        .put("pageColor", nb.pageColor)
                        .put("lastPage", nb.lastPage)
                )
            }
            libFile().writeText(JSONObject().put("folders", fa).put("notebooks", na).toString())
        } catch (_: Exception) { }
    }

    private fun id() = UUID.randomUUID().toString().replace("-", "").take(12)

    fun createFolder(name: String, parentId: String? = null): Folder = Folder(id(), name, parentId).also { folders.add(it); save() }

    /** Sub-folders directly under [parentId] (null = top level). */
    fun foldersIn(parentId: String?): List<Folder> = folders.filter { it.parentId == parentId }

    /** True if [folderId] is [maybeAncestor] or nested anywhere beneath it (guards against cycles). */
    fun isSelfOrDescendant(folderId: String, maybeAncestor: String): Boolean {
        if (folderId == maybeAncestor) return true
        var cur = folders.find { it.id == folderId }?.parentId
        var guard = 0
        while (cur != null && guard++ < 512) {
            if (cur == maybeAncestor) return true
            cur = folders.find { it.id == cur }?.parentId
        }
        return false
    }

    /** Move a notebook into a folder (null = top level). */
    fun moveNotebook(nb: Notebook, folderId: String?) { nb.folderId = folderId; save() }

    /** Move a folder under a new parent (null = top level), unless that would create a cycle. */
    fun moveFolder(fo: Folder, parentId: String?): Boolean {
        if (parentId != null && isSelfOrDescendant(parentId, fo.id)) return false
        fo.parentId = parentId; save(); return true
    }

    fun createNotebook(
        title: String,
        folderId: String?,
        cover: Int,
        paper: String = "GRID",
        pageColor: Int = Color.WHITE,
    ): Notebook =
        Notebook(id(), title, folderId, cover, System.currentTimeMillis(), arrayListOf(id()), paper, pageColor).also {
            notebooks.add(it); save()
        }

    fun addPage(nb: Notebook): String = id().also { nb.pageIds.add(it); save() }

    fun deleteNotebook(nb: Notebook) {
        nb.pageIds.forEach { pageFile(it).delete(); pageBgFile(it).delete() }
        notebooks.remove(nb); save()
    }

    fun deleteFolder(fo: Folder) {
        // Reparent this folder's contents one level up (to its parent) rather than dumping to root.
        notebooks.filter { it.folderId == fo.id }.forEach { it.folderId = fo.parentId }
        folders.filter { it.parentId == fo.id }.forEach { it.parentId = fo.parentId }
        folders.remove(fo); save()
    }

    fun notebook(id: String): Notebook? = notebooks.find { it.id == id }

    /** Notebooks in a folder (null = top level), newest first. */
    fun notebooksIn(folderId: String?): List<Notebook> =
        notebooks.filter { it.folderId == folderId }.sortedByDescending { it.created }
}
