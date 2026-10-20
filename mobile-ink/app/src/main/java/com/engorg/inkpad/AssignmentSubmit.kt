package com.engorg.inkpad

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Minimal Firestore REST client for the signed-in EngOrg account (documents under users/{uid}/data). */
class FirestoreRest(private val acct: CloudAuth.Account) {
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS).build()
    private val JSON = "application/json".toMediaType()
    private var idToken: String? = null
    private var expiry = 0L
    private val base get() = "https://firestore.googleapis.com/v1/projects/${acct.projectId}/databases/(default)/documents/users/${acct.uid}/data"

    private fun token(): String {
        val now = System.currentTimeMillis()
        idToken?.let { if (now < expiry - 60_000) return it }
        val req = Request.Builder().url("https://securetoken.googleapis.com/v1/token?key=${acct.apiKey}")
            .post("grant_type=refresh_token&refresh_token=${java.net.URLEncoder.encode(acct.refreshToken, "UTF-8")}".toRequestBody("application/x-www-form-urlencoded".toMediaType()))
            .build()
        http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IllegalStateException("Your EngOrg sign-in has expired. Open the EngOrg app (signed in), then open Ink again.")
            val o = JSONObject(r.body?.string().orEmpty())
            idToken = o.getString("id_token"); expiry = now + o.optLong("expires_in", 3600) * 1000
            return idToken!!
        }
    }

    /** The raw document (name, fields, updateTime) at [path] under users/{uid}/data, or null if missing. */
    fun get(path: String): JSONObject? {
        val req = Request.Builder().url("$base/$path").header("Authorization", "Bearer ${token()}").get().build()
        http.newCall(req).execute().use { r ->
            if (r.code == 404) return null
            if (!r.isSuccessful) throw IllegalStateException("Couldn't read your EngOrg data (HTTP ${r.code})")
            return JSONObject(r.body?.string().orEmpty())
        }
    }

    /** Write [fields] (Firestore Value objects). [mask] limits it to those fields; [ifUpdateTime] = only if unchanged since. */
    fun patch(path: String, fields: JSONObject, mask: List<String>? = null, ifUpdateTime: String? = null): Boolean {
        val q = StringBuilder()
        mask?.forEach { q.append(if (q.isEmpty()) "?" else "&").append("updateMask.fieldPaths=").append(it) }
        ifUpdateTime?.let { q.append(if (q.isEmpty()) "?" else "&").append("currentDocument.updateTime=").append(java.net.URLEncoder.encode(it, "UTF-8")) }
        val req = Request.Builder().url("$base/$path$q").header("Authorization", "Bearer ${token()}")
            .patch(JSONObject().put("fields", fields).toString().toRequestBody(JSON)).build()
        http.newCall(req).execute().use { r ->
            if (r.code == 400 || r.code == 409 || r.code == 412) return false   // precondition failed
            if (!r.isSuccessful) throw IllegalStateException("Couldn't save to your EngOrg account (HTTP ${r.code})")
            return true
        }
    }

    companion object {
        fun s(v: String) = JSONObject().put("stringValue", v)
        fun i(v: Long) = JSONObject().put("integerValue", v.toString())

        /** A Firestore REST Value → plain JSON (String, Long, Double, Boolean, JSONObject, JSONArray, null). */
        fun decode(v: JSONObject?): Any? {
            if (v == null) return null
            return when {
                v.has("stringValue") -> v.getString("stringValue")
                v.has("integerValue") -> v.getString("integerValue").toLongOrNull()
                v.has("doubleValue") -> v.getDouble("doubleValue")
                v.has("booleanValue") -> v.getBoolean("booleanValue")
                v.has("timestampValue") -> v.getString("timestampValue")
                v.has("mapValue") -> JSONObject().also { o -> v.getJSONObject("mapValue").optJSONObject("fields")?.let { f -> for (k in f.keys()) o.put(k, decode(f.getJSONObject(k)) ?: JSONObject.NULL) } }
                v.has("arrayValue") -> JSONArray().also { a -> v.getJSONObject("arrayValue").optJSONArray("values")?.let { vs -> for (k in 0 until vs.length()) a.put(decode(vs.getJSONObject(k)) ?: JSONObject.NULL) } }
                else -> null
            }
        }
    }
}

/**
 * "Attach & submit to assignment": the notebook as a PDF, handed to the right place.
 *
 * Gradescope assignments go to EngOrg on the PC (which holds the Gradescope login): the PDF is
 * written in chunks to users/{uid}/data/inkSubmit/requests/{id}/chunks and a pending request beside
 * it; the PC claims it, uploads, marks the note done and reports back. If the PC doesn't claim it in
 * time the request is cancelled first (only if still unclaimed, so it can't be submitted twice) and
 * we fall back. Everything else (Variate, Brightspace, unlinked notes) and every failure: the PDF goes
 * to Downloads and the assignment page opens so it can be uploaded by hand.
 */
object AssignmentSubmit {
    class Assignment(
        val id: String, val title: String, val due: String, val source: String, val course: String,
        val gsCourseId: String?, val gsAssignmentId: String?, val url: String?,
    ) {
        val viaGradescope get() = !gsCourseId.isNullOrBlank() && !gsAssignmentId.isNullOrBlank()
        val sourceLabel get() = when (source) { "gradescope" -> "Gradescope"; "variate" -> "Variate"; "brightspace" -> "Brightspace"; else -> "Assignment" }
    }

    /** Open assignments (not done), soonest due first. Runs network I/O: call off the UI thread. */
    fun load(fs: FirestoreRest): List<Assignment> {
        val tasks = (fs.get("tasks")?.optJSONObject("fields")?.optJSONObject("tasks")?.let { FirestoreRest.decode(it) } as? JSONArray) ?: JSONArray()
        val projects = (fs.get("projects")?.optJSONObject("fields")?.optJSONObject("projects")?.let { FirestoreRest.decode(it) } as? JSONArray) ?: JSONArray()
        val names = HashMap<String, String>()
        for (k in 0 until projects.length()) projects.optJSONObject(k)?.let { p -> names[p.optString("id")] = p.optString("courseShort").ifBlank { p.optString("name") } }
        val out = ArrayList<Assignment>()
        for (k in 0 until tasks.length()) {
            val t = tasks.optJSONObject(k) ?: continue
            if (t.optBoolean("completed", false) || t.optString("status") == "done") continue
            val source = t.optString("source")
            val isAssignment = t.optString("category") == "assignment" || source in setOf("gradescope", "variate", "brightspace")
            if (!isAssignment) continue
            val links = t.optJSONArray("links")
            var url: String? = null
            if (links != null) for (j in 0 until links.length()) { val u = links.optJSONObject(j)?.optString("url").orEmpty(); if (u.startsWith("http")) { url = u; break } }
            out.add(Assignment(
                t.optString("id"), t.optString("title").ifBlank { "Untitled" }, t.optString("dueDate"), source,
                names[t.optString("projectId")].orEmpty(),
                t.optString("gradescopeCourseId").takeIf { it.isNotBlank() && it != "null" },
                t.optString("gradescopeAssignmentId").takeIf { it.isNotBlank() && it != "null" }, url,
            ))
        }
        return out.sortedWith(compareBy({ it.due.isBlank() }, { it.due }))
    }

    sealed class Outcome {
        /** Uploaded by the PC; [matchPages] = Gradescope wants pages assigned (opened on the PC). */
        class Submitted(val matchPages: Boolean, val url: String?) : Outcome()
        /** Not submitted: [why], with the PDF saved to Downloads ([saved] = where) and the assignment opened. */
        class Fallback(val why: String, val saved: String?) : Outcome()
    }

    /**
     * Submit [pdf] to [a]. Blocking (call off the UI thread); [progress] gets short status lines.
     * Never submits twice: a request the PC hasn't claimed is cancelled before falling back.
     */
    fun submit(ctx: Context, fs: FirestoreRest, a: Assignment, pdf: File, progress: (String) -> Unit): Outcome {
        if (!a.viaGradescope) return fallback(ctx, a, pdf, "${a.sourceLabel} assignments can’t be submitted automatically.")
        val id = UUID.randomUUID().toString().replace("-", "").take(20)
        val path = "inkSubmit/requests/$id"
        try {
            progress("Sending the PDF to EngOrg on your PC…")
            val b64 = Base64.encodeToString(pdf.readBytes(), Base64.NO_WRAP)
            val parts = b64.chunked(700_000)
            parts.forEachIndexed { k, d -> fs.patch("$path/chunks/c$k", JSONObject().put("i", FirestoreRest.i(k.toLong())).put("d", FirestoreRest.s(d))) }
            fs.patch(path, JSONObject()
                .put("type", FirestoreRest.s("submit")).put("status", FirestoreRest.s("pending"))
                .put("taskId", FirestoreRest.s(a.id)).put("title", FirestoreRest.s(a.title))
                .put("courseId", FirestoreRest.s(a.gsCourseId!!)).put("assignmentId", FirestoreRest.s(a.gsAssignmentId!!))
                .put("filename", FirestoreRest.s(pdf.name)).put("chunks", FirestoreRest.i(parts.size.toLong()))
                .put("createdAt", FirestoreRest.i(System.currentTimeMillis())).put("device", FirestoreRest.s(Build.MODEL ?: "Tablet")))
        } catch (e: Exception) {
            return fallback(ctx, a, pdf, e.message ?: "Couldn’t reach your EngOrg account.")
        }

        progress("Waiting for your PC to upload it…")
        val start = System.currentTimeMillis()
        var claimed = false
        while (true) {
            Thread.sleep(2000)
            val doc = try { fs.get(path) } catch (_: Exception) { null } ?: continue
            val f = doc.optJSONObject("fields")
            val status = FirestoreRest.decode(f?.optJSONObject("status")) as? String ?: "pending"
            when (status) {
                "uploading" -> if (!claimed) { claimed = true; progress("Uploading to Gradescope…") }
                "submitted" -> return Outcome.Submitted(FirestoreRest.decode(f?.optJSONObject("needsMatching")) == true, FirestoreRest.decode(f?.optJSONObject("openUrl")) as? String)
                "failed" -> return fallback(ctx, a, pdf, (FirestoreRest.decode(f?.optJSONObject("message")) as? String) ?: "Gradescope didn’t accept it.")
                "expired", "cancelled" -> return fallback(ctx, a, pdf, "Your PC didn’t pick it up in time.")
            }
            val waited = System.currentTimeMillis() - start
            if (!claimed && waited > 60_000) {
                // Cancel only if still unclaimed, so the PC can't submit it after we fall back.
                val cancelled = try { fs.patch(path, JSONObject().put("status", FirestoreRest.s("cancelled")), listOf("status"), doc.optString("updateTime")) } catch (_: Exception) { false }
                if (cancelled) return fallback(ctx, a, pdf, "Your PC didn’t answer. Is EngOrg open and signed in there?")
            }
            if (waited > 5 * 60_000) return fallback(ctx, a, pdf, "Gradescope is taking too long. Check the assignment page.")
        }
    }

    /** Save the PDF to Downloads/EngInk and open the assignment so it can be uploaded by hand. */
    fun fallback(ctx: Context, a: Assignment, pdf: File, why: String): Outcome {
        val saved = try { saveToDownloads(ctx, pdf) } catch (_: Exception) { null }
        a.url?.let { u -> try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { } }
        return Outcome.Fallback(why, saved)
    }

    private fun saveToDownloads(ctx: Context, pdf: File): String? {
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, pdf.name)
                put(MediaStore.Downloads.MIME_TYPE, "application/pdf")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/EngInk")
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
            ctx.contentResolver.openOutputStream(uri)?.use { out -> pdf.inputStream().use { it.copyTo(out) } }
            return "Downloads/EngInk/${pdf.name}"
        }
        val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return null
        val dest = File(dir, pdf.name); pdf.copyTo(dest, overwrite = true)
        return dest.absolutePath
    }

    /** Ask the PC to mark [a] done (processed whenever EngOrg is next open). */
    fun requestDone(fs: FirestoreRest, a: Assignment) {
        val id = UUID.randomUUID().toString().replace("-", "").take(20)
        fs.patch("inkSubmit/requests/$id", JSONObject().put("type", FirestoreRest.s("done")).put("status", FirestoreRest.s("pending"))
            .put("taskId", FirestoreRest.s(a.id)).put("title", FirestoreRest.s(a.title)).put("createdAt", FirestoreRest.i(System.currentTimeMillis())))
    }
}
