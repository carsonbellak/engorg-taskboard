package com.engorg.inkpad

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The user's own Anthropic API key + model choice for EngInk's Claude feedback. Same model as the
 * desktop app's Claude link: each device holds its own key, never synced. Here it's encrypted with an
 * AES-GCM key that lives in the Android Keystore. If that key is gone (a restored backup or a wiped
 * keystore), [apiKey] returns null and the user just pastes the key again.
 */
object ClaudeAuth {
    private const val PREF = "engorg_claude"
    private const val ALIAS = "engink_claude_api_key"

    data class Model(val id: String, val label: String, val fallbacks: Boolean)
    val MODELS = listOf(
        Model("claude-opus-5-5", "Opus 5.5 · most thorough", true),
        Model("claude-sonnet-5-5", "Sonnet 5.5 · faster", true),
        Model("claude-haiku-5-5", "Haiku 5.5 · fastest", false),
    )

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun model(ctx: Context): Model {
        val id = prefs(ctx).getString("model", null)
        return MODELS.firstOrNull { it.id == id } ?: MODELS[0]
    }
    fun setModel(ctx: Context, id: String) { prefs(ctx).edit().putString("model", id).apply() }

    /** How hard Claude thinks before answering (the API's output_config.effort). */
    data class Effort(val id: String, val label: String, val hint: String)
    val EFFORTS = listOf(
        Effort("low", "Low", "Quickest, for simple checks"),
        Effort("medium", "Medium", "Balanced"),
        Effort("high", "High", "Careful step-by-step checking"),
        Effort("xhigh", "Extra high", "Slower, for tricky problems"),
        Effort("max", "Max", "Slowest and most thorough"),
    )
    fun effort(ctx: Context): Effort {
        val id = prefs(ctx).getString("effort", null)
        return EFFORTS.firstOrNull { it.id == id } ?: EFFORTS[2]
    }
    fun setEffort(ctx: Context, id: String) { prefs(ctx).edit().putString("effort", id).apply() }

    fun connected(ctx: Context): Boolean = apiKey(ctx) != null

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return gen.generateKey()
    }

    fun saveKey(ctx: Context, key: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, secretKey())
        val enc = c.doFinal(key.toByteArray(Charsets.UTF_8))
        val blob = Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP)
        prefs(ctx).edit().putString("keyEnc", blob).apply()
    }

    fun apiKey(ctx: Context): String? {
        val blob = prefs(ctx).getString("keyEnc", null) ?: return null
        return try {
            val (iv, enc) = blob.split(":").let { Base64.decode(it[0], Base64.NO_WRAP) to Base64.decode(it[1], Base64.NO_WRAP) }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            String(c.doFinal(enc), Charsets.UTF_8)
        } catch (_: Exception) { null }
    }

    fun disconnect(ctx: Context) { prefs(ctx).edit().remove("keyEnc").apply() }
}

/**
 * Raw-HTTP Anthropic Messages API client over OkHttp, which the app already ships for the mirror.
 * The desktop's ipc/claude.js uses plain fetch the same way. One [ClaudeChat] holds one feedback
 * conversation. The history is append-only and each assistant turn's content blocks go back exactly
 * as received (thinking blocks + signatures too), so follow-up questions keep Claude's reasoning about
 * the page. Callbacks run on the main thread.
 */
object ClaudeApi {
    private const val BASE = "https://api.anthropic.com"
    private const val VERSION = "2023-06-01"
    private val JSON_TYPE = "application/json".toMediaType()
    private val main = Handler(Looper.getMainLooper())

    // Generous read timeout: a thorough check can think for a while before the first text arrives
    // (the stream sends pings meanwhile, but a slow network shouldn't cut it off).
    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .build()

    private fun request(path: String, key: String): Request.Builder =
        Request.Builder().url(BASE + path)
            .header("x-api-key", key)
            .header("anthropic-version", VERSION)

    /** Check a key with a GET /v1/models (no tokens spent). [done] gets null on success, else a message. */
    fun validateKey(key: String, done: (String?) -> Unit) {
        http.newCall(request("/v1/models", key).get().build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { main.post { done("Couldn't reach Anthropic — check your connection.") } }
            override fun onResponse(call: Call, response: Response) {
                val body = response.use { it.body?.string() }
                val err = if (response.isSuccessful) null else friendlyError(response.code, body)
                main.post { done(err) }
            }
        })
    }

    fun friendlyError(code: Int, body: String?): String {
        val msg = try { JSONObject(body ?: "").optJSONObject("error")?.optString("message").orEmpty() } catch (_: Exception) { "" }
        return when {
            msg.contains("workspace", true) -> "This looks like an Organization-scoped key. Create a key with the \"Default workspace\" scope instead."
            code == 401 -> "Anthropic rejected that API key${if (msg.isNotBlank()) " (“$msg”)" else ""}. Check it was copied in full, or that it hasn't been deleted or disabled in the Console."
            code == 403 -> "This API key isn't allowed to use that model."
            code == 429 -> "Rate limited — wait a moment and try again."
            code == 529 || code >= 500 -> "Claude is overloaded right now — try again in a minute."
            msg.isNotBlank() -> msg
            else -> "Request failed (HTTP $code)."
        }
    }

    class Result(val text: String, val stopReason: String?, val error: String?)

    class ClaudeChat(private val system: String) {
        val history = JSONArray()
        val isEmpty get() = history.length() == 0
        private var call: Call? = null
        val busy get() = call != null

        fun cancel() { call?.cancel(); call = null }

        /**
         * Send [userContent] (a JSON array of content blocks) as the next user turn and stream the reply.
         * [onText] gets the full reply text so far, as it grows. The turn joins [history] only once a
         * reply arrives, so a failed send leaves the conversation as it was.
         */
        fun send(key: String, model: ClaudeAuth.Model, effort: String, userContent: JSONArray, onText: (String) -> Unit, onDone: (Result) -> Unit) {
            val userMsg = JSONObject().put("role", "user").put("content", userContent)
            val msgs = JSONArray()
            for (i in 0 until history.length()) msgs.put(history.get(i))
            msgs.put(userMsg)
            val body = JSONObject()
                .put("model", model.id)
                .put("max_tokens", 32000)
                .put("stream", true)
                .put("system", system)
                .put("output_config", JSONObject().put("effort", effort))
                .put("messages", msgs)
            val req = request("/v1/messages", key).header("content-type", "application/json")
            // Server-side fallback: if a safety classifier declines, the API re-runs the request on
            // Anthropic's recommended fallback model instead of returning a refusal. Not offered on Haiku.
            if (model.fallbacks) {
                body.put("fallbacks", "default")
                req.header("anthropic-beta", "server-side-fallback-2026-07-01")
            }
            val c = http.newCall(req.post(body.toString().toRequestBody(JSON_TYPE)).build())
            call = c
            pendingDone = onDone
            c.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    finish(call, Result("", null, if (call.isCanceled()) null else "Couldn't reach Anthropic — check your connection."))
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use { resp ->
                        if (!resp.isSuccessful) { finish(call, Result("", null, friendlyError(resp.code, resp.body?.string()))); return }
                        try {
                            val r = readStream(resp, onText)
                            if (r.error == null && r.stopReason != "refusal") {
                                main.post {
                                    history.put(userMsg)
                                    history.put(JSONObject().put("role", "assistant").put("content", r.blocks))
                                }
                            }
                            finish(call, Result(r.text, r.stopReason, r.error))
                        } catch (e: Exception) {
                            finish(call, Result("", null, if (call.isCanceled()) null else "The reply was cut off — try again."))
                        }
                    }
                }
            })
        }

        // Runs on the main thread after any history update, with [busy] already false.
        private fun finish(c: Call, r: Result) = main.post { if (call === c) { call = null; pendingDone(r) } }
        private var pendingDone: (Result) -> Unit = {}

        private class Streamed(val text: String, val blocks: JSONArray, val stopReason: String?, val error: String?)

        /** Parse the SSE stream, rebuilding each content block so it can be echoed back verbatim. */
        private fun readStream(resp: Response, onText: (String) -> Unit): Streamed {
            val src = resp.body!!.source()
            val blocks = java.util.TreeMap<Int, JSONObject>()
            val text = HashMap<Int, StringBuilder>()
            val thinking = HashMap<Int, StringBuilder>()
            val sig = HashMap<Int, StringBuilder>()
            var stop: String? = null
            var error: String? = null
            var lastPush = 0L
            fun visibleText() = blocks.keys.mapNotNull { text[it] }.joinToString("") { it }
            while (true) {
                val line = src.readUtf8Line() ?: break
                if (!line.startsWith("data:")) continue
                val ev = try { JSONObject(line.substring(5).trim()) } catch (_: Exception) { continue }
                when (ev.optString("type")) {
                    "content_block_start" -> {
                        val i = ev.optInt("index")
                        val b = JSONObject(ev.getJSONObject("content_block").toString())
                        blocks[i] = b
                        when (b.optString("type")) {
                            "text" -> text[i] = StringBuilder(b.optString("text"))
                            "thinking" -> { thinking[i] = StringBuilder(b.optString("thinking")); sig[i] = StringBuilder(b.optString("signature")) }
                        }
                    }
                    "content_block_delta" -> {
                        val i = ev.optInt("index")
                        val d = ev.getJSONObject("delta")
                        when (d.optString("type")) {
                            "text_delta" -> {
                                text.getOrPut(i) { StringBuilder() }.append(d.optString("text"))
                                val now = System.currentTimeMillis()
                                if (now - lastPush > 60) { lastPush = now; val t = visibleText(); main.post { onText(t) } }
                            }
                            "thinking_delta" -> thinking.getOrPut(i) { StringBuilder() }.append(d.optString("thinking"))
                            "signature_delta" -> sig.getOrPut(i) { StringBuilder() }.append(d.optString("signature"))
                        }
                    }
                    "message_delta" -> ev.optJSONObject("delta")?.optString("stop_reason")?.takeIf { it.isNotBlank() && it != "null" }?.let { stop = it }
                    "error" -> error = ev.optJSONObject("error")?.let { e ->
                        if (e.optString("type") == "overloaded_error") "Claude is overloaded right now — try again in a minute." else e.optString("message", "Claude returned an error.")
                    } ?: "Claude returned an error."
                }
            }
            val out = JSONArray()
            for ((i, b) in blocks) {
                when (b.optString("type")) {
                    "text" -> { val t = text[i]?.toString().orEmpty(); if (t.isEmpty()) continue; b.put("text", t) }
                    "thinking" -> { b.put("thinking", thinking[i]?.toString().orEmpty()); b.put("signature", sig[i]?.toString().orEmpty()) }
                }
                out.put(b)
            }
            if (error == null && stop == null) error = "The reply was cut off — try again."
            return Streamed(visibleText(), out, stop, error)
        }
    }
}
