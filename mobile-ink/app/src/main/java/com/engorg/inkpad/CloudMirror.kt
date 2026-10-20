package com.engorg.inkpad

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPOutputStream

/**
 * The signed-in EngOrg account, as the native app needs it to talk to Firestore directly. Captured
 * from the PWA's Firebase session (MainActivity reads it when Ink opens) and kept in app-private
 * storage, the same protection the WebView gives that session itself.
 */
object CloudAuth {
    private const val PREF = "engorg_cloud"
    data class Account(val uid: String, val refreshToken: String, val apiKey: String, val projectId: String)

    /** [json] is what WebView.evaluateJavascript returns: a JSON-encoded string holding the object. */
    fun saveFromJs(ctx: Context, json: String?) {
        if (json.isNullOrBlank() || json == "null") return
        try {
            val inner = (org.json.JSONTokener(json).nextValue() as? String) ?: json
            val o = JSONObject(inner)
            if (o.optString("uid").isBlank() || o.optString("rt").isBlank()) return
            ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putString("acct", inner).apply()
        } catch (_: Exception) { }
    }

    fun account(ctx: Context): Account? = try {
        val o = JSONObject(ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString("acct", null) ?: return null)
        Account(o.getString("uid"), o.getString("rt"), o.getString("key"), o.getString("pid"))
    } catch (_: Exception) { null }
}

/**
 * Mirroring through Firestore, for networks where the tablet can't reach the PC directly (apartment
 * and campus Wi-Fi usually block device-to-device traffic). It speaks the same messages as the LAN
 * socket ([send]); the desktop's EngInk mirror listens to users/{uid}/data/inkMirror and turns them back
 * into the same live view. Committed strokes and the page you're on go up shortly after the pen
 * lifts; in-progress strokes stay local (too chatty for the cloud).
 *
 * Writes go through the Firestore REST API with an ID token minted from the account's refresh token,
 * on one background thread, coalescing bursts so only the newest version of each page is sent.
 */
class CloudMirror(private val ctx: Context, private val acct: CloudAuth.Account) {
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val JSON = "application/json".toMediaType()
    val session: String = UUID.randomUUID().toString().take(12)
    private val device = Build.MODEL ?: "Tablet"

    private var idToken: String? = null
    private var tokenExpiry = 0L

    // Newest state waiting to go up.
    @Volatile private var notebook: String? = null
    @Volatile private var view: String? = null
    private val pages = java.util.concurrent.ConcurrentHashMap<Int, String>()
    @Volatile private var metaDirty = false
    @Volatile private var stopped = false
    private var flushQueued = false
    private val heartbeat = object : Runnable { override fun run() { if (stopped) return; metaDirty = true; schedule(0); main.postDelayed(this, 45_000) } }

    private val docs get() = "https://firestore.googleapis.com/v1/projects/${acct.projectId}/databases/(default)/documents/users/${acct.uid}/data/inkMirror"

    /** Check the account works (mints a token) and announce the session. [done] gets null or an error. */
    fun start(done: (String?) -> Unit) {
        io.execute {
            val err = try { token(); writeMeta(active = true); null } catch (e: Exception) { e.message ?: "Couldn't reach your EngOrg account" }
            main.post {
                if (err == null) main.postDelayed(heartbeat, 45_000)
                done(err)
            }
        }
    }

    fun stop() {
        stopped = true
        main.removeCallbacks(heartbeat)
        io.execute { try { writeMeta(active = false) } catch (_: Exception) { } }
        io.shutdown()
    }

    /** Take one LAN-protocol message (open / page / view; wet strokes are skipped). */
    fun send(o: JSONObject) {
        if (stopped) return
        when (o.optString("t")) {
            "open" -> { notebook = JSONObject(o.toString()).apply { remove("t") }.toString(); pages.clear(); metaDirty = true; schedule(150) }
            "page" -> { pages[o.optInt("index")] = o.optJSONArray("recs")?.toString() ?: "[]"; schedule(350) }
            "view" -> { view = JSONObject(o.toString()).apply { remove("t") }.toString(); metaDirty = true; schedule(900) }
        }
    }

    private fun schedule(delayMs: Long) = main.post {
        if (flushQueued || stopped) return@post
        flushQueued = true
        main.postDelayed({ flushQueued = false; io.execute { flush() } }, delayMs)
    }

    private fun flush() {
        if (stopped) return
        try {
            if (metaDirty) { metaDirty = false; writeMeta(active = true) }
            for (k in pages.keys.toList()) { val recs = pages.remove(k) ?: continue; writePage(k, recs) }
        } catch (e: Exception) {
            android.util.Log.w("EngInk", "cloud mirror write failed", e)
        }
    }

    // ---------------------------------------------------------------- REST
    private fun token(): String {
        val now = System.currentTimeMillis()
        idToken?.let { if (now < tokenExpiry - 60_000) return it }
        val req = Request.Builder().url("https://securetoken.googleapis.com/v1/token?key=${acct.apiKey}")
            .post("grant_type=refresh_token&refresh_token=${java.net.URLEncoder.encode(acct.refreshToken, "UTF-8")}".toRequestBody("application/x-www-form-urlencoded".toMediaType()))
            .build()
        http.newCall(req).execute().use { r ->
            val body = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw IllegalStateException("Your EngOrg sign-in has expired. Open the EngOrg app, make sure you're signed in, then open Ink again.")
            val o = JSONObject(body)
            idToken = o.getString("id_token")
            tokenExpiry = now + o.optLong("expires_in", 3600) * 1000
            return idToken!!
        }
    }

    private fun patch(url: String, fields: JSONObject) {
        val req = Request.Builder().url(url).header("Authorization", "Bearer ${token()}")
            .patch(JSONObject().put("fields", fields).toString().toRequestBody(JSON)).build()
        http.newCall(req).execute().use { r -> if (!r.isSuccessful) throw IllegalStateException("Mirror upload failed (HTTP ${r.code})") }
    }

    private fun s(v: String) = JSONObject().put("stringValue", v)
    private fun i(v: Long) = JSONObject().put("integerValue", v.toString())
    private fun b(v: Boolean) = JSONObject().put("booleanValue", v)

    private fun writeMeta(active: Boolean) {
        val f = JSONObject().put("active", b(active)).put("session", s(session)).put("device", s(device))
            .put("updatedAt", i(System.currentTimeMillis()))
        notebook?.let { f.put("notebook", s(it)) }
        view?.let { f.put("view", s(it)) }
        patch(docs, f)
    }

    private fun writePage(index: Int, recs: String) {
        val bos = ByteArrayOutputStream()
        GZIPOutputStream(bos).use { it.write(recs.toByteArray(Charsets.UTF_8)) }
        val z = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
        if (z.length > 1_000_000) return   // past Firestore's 1 MB document limit: skip rather than fail the rest
        patch("$docs/pages/p$index", JSONObject().put("session", s(session)).put("index", i(index.toLong())).put("z", s(z)).put("updatedAt", i(System.currentTimeMillis())))
    }
}
