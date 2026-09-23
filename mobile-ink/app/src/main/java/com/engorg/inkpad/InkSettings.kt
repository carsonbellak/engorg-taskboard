package com.engorg.inkpad

import android.content.Context
import android.graphics.Color
import org.json.JSONObject
import org.json.JSONTokener

/**
 * The native ink app's user preferences that sync to the user's profile (Firebase) so they're the
 * same on every Android device. Bridged through the PWA WebView — see [MainActivity]: the native
 * side reads `window.__readInkSettings()` when it opens Ink and pushes changes back via
 * `window.__saveInkSettings(json)` when it returns, and the PWA persists the blob to
 * `users/{uid}/data/inkSettings`.
 *
 * Theme colors and email accounts are NOT here — they already come from the PWA on each open.
 *
 * The values still live in their existing per-feature prefs (pen in `ink_prefs`, chosen email in
 * `engorg_email`) so the rest of the app keeps reading them unchanged; this object just gathers
 * them into / out of one JSON blob for syncing, and owns the new-notebook defaults.
 */
object InkSettings {
    private const val PREF = "engorg_ink_settings"   // new-notebook defaults
    private const val INK_PREFS = "ink_prefs"        // pen size/color (shared with InkActivity)

    val DEFAULT_COVER = Color.rgb(0x29, 0x47, 0xC9)

    // ---- new-notebook defaults (remembered so the create dialog reuses your last choice) ----
    private fun nb(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
    fun nbPaper(ctx: Context): String = nb(ctx).getString("nbPaper", "GRID") ?: "GRID"
    fun nbCover(ctx: Context): Int = nb(ctx).getInt("nbCover", DEFAULT_COVER)
    fun nbPageColor(ctx: Context): Int = nb(ctx).getInt("nbPageColor", Color.WHITE)
    fun setNotebookDefaults(ctx: Context, paper: String, cover: Int, pageColor: Int) {
        nb(ctx).edit().putString("nbPaper", paper).putInt("nbCover", cover).putInt("nbPageColor", pageColor).apply()
    }

    // ---- aggregate for syncing ----
    /** Gather every synced pref into one JSON string (what the native side hands the PWA). */
    fun toJson(ctx: Context): String {
        val ink = ctx.getSharedPreferences(INK_PREFS, Context.MODE_PRIVATE)
        val o = JSONObject()
        try {
            if (ink.contains("brushSize")) o.put("brushSize", ink.getFloat("brushSize", 2f).toDouble())
            if (ink.contains("brushColor")) o.put("brushColor", ink.getInt("brushColor", 0))
            EmailPrefs.savedEmail(ctx)?.let { o.put("savedEmail", it) }
            o.put("nbPaper", nbPaper(ctx))
            o.put("nbCover", nbCover(ctx))
            o.put("nbPageColor", nbPageColor(ctx))
        } catch (_: Exception) { }
        return o.toString()
    }

    /**
     * Apply a synced JSON blob (from the profile, via the WebView bridge) into the on-device prefs.
     * [json] is what `WebView.evaluateJavascript` returns — a JSON-encoded string holding the blob.
     */
    fun applyJson(ctx: Context, json: String?) {
        if (json.isNullOrBlank() || json == "null") return
        try {
            val inner = (JSONTokener(json).nextValue() as? String) ?: json
            if (inner.isBlank() || inner == "null" || inner == "{}") return
            val o = JSONObject(inner)
            val inkE = ctx.getSharedPreferences(INK_PREFS, Context.MODE_PRIVATE).edit()
            if (o.has("brushSize")) inkE.putFloat("brushSize", o.getDouble("brushSize").toFloat())
            if (o.has("brushColor")) inkE.putInt("brushColor", o.getInt("brushColor"))
            inkE.apply()
            if (o.has("savedEmail")) o.optString("savedEmail").takeIf { it.isNotBlank() }?.let { EmailPrefs.setSavedEmail(ctx, it) }
            val nbE = nb(ctx).edit()
            if (o.has("nbPaper")) nbE.putString("nbPaper", o.optString("nbPaper", "GRID"))
            if (o.has("nbCover")) nbE.putInt("nbCover", o.getInt("nbCover"))
            if (o.has("nbPageColor")) nbE.putInt("nbPageColor", o.getInt("nbPageColor"))
            nbE.apply()
        } catch (_: Exception) { }
    }
}
