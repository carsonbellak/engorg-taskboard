package com.engorg.inkpad

import android.content.Context
import org.json.JSONArray
import org.json.JSONTokener

/**
 * Remembers the email accounts connected to the app (bridged from the PWA's Firebase session when
 * Ink is opened) plus the address the user chose to email their notebooks to.
 */
object EmailPrefs {
    private const val PREF = "engorg_email"

    data class Account(val email: String, val name: String, val photo: String)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    /** [json] is what WebView.evaluateJavascript returns: a JSON-encoded string holding a JSON array. */
    fun saveAccounts(ctx: Context, json: String?) {
        if (json.isNullOrBlank() || json == "null") return
        try {
            val inner = (JSONTokener(json).nextValue() as? String) ?: json
            JSONArray(inner) // validate
            prefs(ctx).edit().putString("accounts", inner).apply()
        } catch (_: Exception) { }
    }

    fun accounts(ctx: Context): List<Account> {
        val raw = prefs(ctx).getString("accounts", null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val e = o.optString("email"); if (e.isBlank()) return@mapNotNull null
                Account(e, o.optString("name"), o.optString("photo"))
            }
        } catch (_: Exception) { emptyList() }
    }

    fun savedEmail(ctx: Context): String? = prefs(ctx).getString("saved", null)
    fun setSavedEmail(ctx: Context, email: String) { prefs(ctx).edit().putString("saved", email).apply() }
    fun savedPhoto(ctx: Context): String? {
        val e = savedEmail(ctx) ?: return null
        return accounts(ctx).firstOrNull { it.email == e }?.photo?.ifBlank { null }
    }
}
