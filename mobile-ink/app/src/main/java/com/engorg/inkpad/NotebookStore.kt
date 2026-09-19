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

    data class Folder(val id: String, var name: String)
    data class Notebook(
        val id: String,
        var title: String,
        var folderId: String?,
        var coverColor: Int,
        val created: Long,
        val pageIds: MutableList<String>,
        var paper: String = "GRID",
        var pageColor: Int = Color.WHITE,
    )

    val folders = ArrayList<Folder>()
    val notebooks = ArrayList<Notebook>()

    private fun libFile() = File(dir, "library.json")
    private fun pagesDir() = File(dir, "pages").apply { mkdirs() }
    fun pageFile(pageId: String) = File(pagesDir(), "page_$pageId.json")

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
                    folders.add(Folder(o.getString("id"), o.getString("name")))
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
                        )
                    )
                }
            }
        } catch (_: Exception) { }
    }

    fun save() {
        try {
            val fa = JSONArray()
            for (fo in folders) fa.put(JSONObject().put("id", fo.id).put("name", fo.name))
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
                )
            }
            libFile().writeText(JSONObject().put("folders", fa).put("notebooks", na).toString())
        } catch (_: Exception) { }
    }

    private fun id() = UUID.randomUUID().toString().replace("-", "").take(12)

    fun createFolder(name: String): Folder = Folder(id(), name).also { folders.add(it); save() }

    fun createNotebook(title: String, folderId: String?, cover: Int): Notebook =
        Notebook(id(), title, folderId, cover, System.currentTimeMillis(), arrayListOf(id())).also {
            notebooks.add(it); save()
        }

    fun addPage(nb: Notebook): String = id().also { nb.pageIds.add(it); save() }

    fun deleteNotebook(nb: Notebook) {
        nb.pageIds.forEach { pageFile(it).delete() }
        notebooks.remove(nb); save()
    }

    fun deleteFolder(fo: Folder) {
        notebooks.filter { it.folderId == fo.id }.forEach { it.folderId = null }
        folders.remove(fo); save()
    }

    fun notebook(id: String): Notebook? = notebooks.find { it.id == id }

    /** Notebooks in a folder (null = top level), newest first. */
    fun notebooksIn(folderId: String?): List<Notebook> =
        notebooks.filter { it.folderId == folderId }.sortedByDescending { it.created }
}
