package com.engorg.inkpad

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.WebSettings
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
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
 * "Attach & submit to assignment": the notebook as a PDF, submitted from the tablet itself.
 *
 * Gradescope assignments are uploaded straight from here ([Gradescope]), signed in through the
 * in-app browser once (its cookies are the login). Everything else (Variate, Brightspace) opens the
 * assignment in the in-app browser, whose upload button is handed the PDF. Marking the note done is
 * a request EngOrg on the PC applies next time it's open.
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
        /** Gradescope took it ([url] = where it landed); [matchPages] = it wants pages assigned to questions. */
        class Submitted(val matchPages: Boolean, val url: String) : Outcome()
        /** The tablet isn't signed in to Gradescope (or the sign-in expired). */
        object NeedsLogin : Outcome()
        /** Not submitted, because [why]. */
        class Failed(val why: String) : Outcome()
    }

    /** Upload [pdf] to Gradescope assignment [a]. Blocking (call off the UI thread). */
    fun submit(ctx: Context, a: Assignment, pdf: File): Outcome {
        if (!a.viaGradescope) return Outcome.Failed("${a.sourceLabel} assignments can’t be submitted automatically.")
        return try { Gradescope.submitPdf(ctx, a.gsCourseId!!, a.gsAssignmentId!!, pdf) }
        catch (e: Exception) { Outcome.Failed(e.message ?: "Couldn’t reach Gradescope.") }
    }

    /** Copy the PDF to Downloads/EngInk; returns where, or null. */
    fun saveToDownloads(ctx: Context, pdf: File): String? {
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

/**
 * Gradescope from the tablet. There's no API, so this does what a browser does: open the assignment's
 * /submissions/new page, read its upload form (PDF homework and file-upload assignments name the file
 * field differently) and post the PDF with that page's CSRF token. Gradescope's redirect says how it
 * went: …/submissions/<id>/select_pages = uploaded, pages still to match; …/submissions/<id> =
 * submitted; anything else = rejected. The login is the in-app browser's: requests share the WebView
 * cookie store, so signing in there once (LOGIN_URL) signs this in too.
 */
object Gradescope {
    const val BASE = "https://www.gradescope.com"
    const val LOGIN_URL = "$BASE/login"

    private val jar = object : CookieJar {
        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val raw = CookieManager.getInstance().getCookie(url.toString()) ?: return emptyList()
            return raw.split(";").mapNotNull { Cookie.parse(url, it.trim()) }
        }
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            val cm = CookieManager.getInstance()
            for (c in cookies) cm.setCookie(url.toString(), c.toString())
            cm.flush()
        }
    }
    private val http by lazy {
        OkHttpClient.Builder().cookieJar(jar).connectTimeout(20, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).build()
    }

    /** Is [url] a page you only see once signed in (where Gradescope lands after its login)? */
    fun isSignedInUrl(url: String): Boolean {
        val u = url.toHttpUrlOrNull() ?: return false
        return u.host.endsWith("gradescope.com") && (u.encodedPath.startsWith("/account") || u.encodedPath.startsWith("/courses"))
    }
    private fun isLoginUrl(u: HttpUrl) = u.encodedPath.startsWith("/login")

    private fun htmlDecode(s: String) = s.replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'", true)
        .replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&").replace("&nbsp;", " ")
    private fun authToken(html: String) = (Regex("""name="authenticity_token"\s+value="([^"]+)"""").find(html)
        ?: Regex("""name="csrf-token"\s+content="([^"]+)"""").find(html))?.groupValues?.get(1)?.let(::htmlDecode)

    fun submitPdf(ctx: Context, courseId: String, assignmentId: String, pdf: File): AssignmentSubmit.Outcome {
        if (!courseId.all(Char::isDigit) || !assignmentId.all(Char::isDigit)) return AssignmentSubmit.Outcome.Failed("This assignment has no Gradescope link.")
        if (pdf.length() > 45L * 1024 * 1024) return AssignmentSubmit.Outcome.Failed("The PDF is too large for Gradescope.")
        val ua = try { WebSettings.getDefaultUserAgent(ctx) } catch (_: Exception) { "Mozilla/5.0 (Linux; Android) EngInk" }
        val newUrl = "$BASE/courses/$courseId/assignments/$assignmentId/submissions/new"
        val html = http.newCall(Request.Builder().url(newUrl).header("User-Agent", ua).header("Accept", "text/html,application/xhtml+xml").get().build()).execute().use { r ->
            if (isLoginUrl(r.request.url)) return AssignmentSubmit.Outcome.NeedsLogin
            if (!r.isSuccessful) return AssignmentSubmit.Outcome.Failed("Gradescope didn’t open the assignment (HTTP ${r.code}).")
            r.body?.string().orEmpty()
        }
        val token = authToken(html) ?: return AssignmentSubmit.Outcome.Failed("Couldn’t open the assignment on Gradescope (it may be closed).")

        // The upload form's file field and hidden inputs (fallback: what PDF homework uses). Hidden
        // inputs come from that form only: page-wide ones belong to other forms (a Rails `_method`
        // override among them would turn the upload into a PATCH/DELETE).
        val formBody = Regex("""<form[^>]*action="[^"]*/assignments/\d+/submissions"[^>]*>([\s\S]*?)</form>""", RegexOption.IGNORE_CASE).find(html)?.groupValues?.get(1)
        val scope = formBody ?: html
        val fileField = (Regex("""<input[^>]*type="file"[^>]*name="([^"]+)"""", RegexOption.IGNORE_CASE).find(scope)
            ?: Regex("""<input[^>]*name="([^"]+)"[^>]*type="file"""", RegexOption.IGNORE_CASE).find(scope))?.groupValues?.get(1)?.let(::htmlDecode)
            ?: if (html.contains("submission[files][]")) "submission[files][]" else "submission[pdf_attachment]"
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("utf8", "✓").addFormDataPart("authenticity_token", token)
        var hasMethod = false
        for (m in Regex("""<input[^>]*type="hidden"[^>]*>""", RegexOption.IGNORE_CASE).findAll(formBody.orEmpty())) {
            val n = Regex("""name="([^"]+)"""").find(m.value)?.groupValues?.get(1)?.let(::htmlDecode) ?: continue
            if (n == "authenticity_token" || n == "utf8" || n == "_method") continue
            if (n == "submission[method]") hasMethod = true
            form.addFormDataPart(n, htmlDecode(Regex("""value="([^"]*)"""").find(m.value)?.groupValues?.get(1).orEmpty()))
        }
        if (!hasMethod) form.addFormDataPart("submission[method]", "upload")
        val name = pdf.name.replace(Regex("""[^\w .()-]"""), "").trim().ifBlank { "notebook" }.replace(Regex("""(\.pdf)?$""", RegexOption.IGNORE_CASE), ".pdf")
        form.addFormDataPart(fileField, name, pdf.asRequestBody("application/pdf".toMediaType()))
        val before = currentSubmissionId(ua, courseId, assignmentId)

        // Posted the way Gradescope's own (AJAX) upload form does: the PDF form answers JSON
        // ({ url: …/select_pages }), the file-upload form redirects. Either shape counts.
        val post = Request.Builder().url("$BASE/courses/$courseId/assignments/$assignmentId/submissions")
            .header("User-Agent", ua).header("Accept", "application/json, text/javascript, text/html;q=0.9, */*;q=0.5")
            .header("X-Requested-With", "XMLHttpRequest").header("X-CSRF-Token", token)
            .header("Referer", newUrl).header("Origin", BASE).post(form.build()).build()
        val subRe = Regex("""/submissions/\d+""")
        http.newCall(post).execute().use { r ->
            val final = r.request.url
            if (isLoginUrl(final)) return AssignmentSubmit.Outcome.NeedsLogin
            val body = r.body?.string().orEmpty()
            var landed: String? = final.toString().takeIf { subRe.containsMatchIn(final.encodedPath) }
            var detail = ""
            if (landed == null) {
                val j = try { JSONObject(body) } catch (_: Exception) { null }
                val u = j?.let { o -> listOf("url", "redirect_url", "location", "redirect").map { o.optString(it) }.firstOrNull { subRe.containsMatchIn(it) } }
                val hit = u ?: Regex("""["'(]((?:https://www\.gradescope\.com)?/courses/\d+/assignments/\d+/submissions/\d+[^"')\s]*)""").find(body)?.groupValues?.get(1)
                if (hit != null) landed = "$BASE/".toHttpUrlOrNull()?.resolve(htmlDecode(hit))?.toString()
                detail = j?.let { o -> o.optString("error").ifBlank { o.optString("message") }.ifBlank { o.optJSONArray("errors")?.join(", ")?.replace("\"", "").orEmpty() } }.orEmpty()
            }
            // Last check: the assignment now opens on a newer submission than before the upload.
            if (landed == null) {
                val after = currentSubmissionId(ua, courseId, assignmentId)
                if (after != null && after != before) landed = "$BASE/courses/$courseId/assignments/$assignmentId/submissions/$after"
            }
            if (landed == null) return AssignmentSubmit.Outcome.Failed(
                if (detail.isNotBlank()) "Gradescope: ${htmlDecode(detail.replace(Regex("<[^>]*>"), ""))}"
                else "Gradescope didn’t accept the upload (HTTP ${r.code}; the assignment may be closed or not take PDFs).")
            return AssignmentSubmit.Outcome.Submitted(landed.contains("select_pages"), landed)
        }
    }

    /** The latest submission id for an assignment (opening a submitted one lands on it), or null. */
    private fun currentSubmissionId(ua: String, courseId: String, assignmentId: String): String? = try {
        http.newCall(Request.Builder().url("$BASE/courses/$courseId/assignments/$assignmentId").header("User-Agent", ua).get().build()).execute().use { r ->
            Regex("""/submissions/(\d+)""").find(r.request.url.encodedPath)?.groupValues?.get(1)
        }
    } catch (_: Exception) { null }
}
