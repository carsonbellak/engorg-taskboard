package com.engorg.inkpad

import android.content.Context
import android.graphics.Color

/**
 * App colors mirrored from the PWA's currently-selected theme. MainActivity resolves the live
 * CSS variables (--accent/--bg/--bg-card/--bg-elevated/--text) when the user opens Ink and saves
 * them here; the native notebook + ink UI read them so it matches whatever theme is selected.
 */
object AppTheme {
    private const val PREF = "engorg_theme"

    var accent = Color.rgb(0x81, 0x8C, 0xF8)
    var bg = Color.rgb(0xE9, 0xEA, 0xEC)        // backdrop behind the page
    var surface = Color.WHITE                    // toolbars / cards
    var elevated = Color.rgb(0xEE, 0xF0, 0xF4)   // inactive pill fill
    var text = Color.rgb(0x3A, 0x41, 0x4E)
    var dark = false

    /** Text/icon color that reads on the accent (active pills). */
    fun onAccent(): Int = if (luminance(accent) > 0.6) Color.rgb(0x1A, 0x1D, 0x24) else Color.WHITE

    fun load(ctx: Context) {
        val p = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        accent = p.getInt("accent", accent)
        bg = p.getInt("bg", bg)
        surface = p.getInt("surface", surface)
        elevated = p.getInt("elevated", elevated)
        text = p.getInt("text", text)
        dark = p.getBoolean("dark", dark)
    }

    /** [json] is what WebView.evaluateJavascript returns (a JSON-encoded string). */
    fun saveFromJson(ctx: Context, json: String?) {
        if (json.isNullOrBlank()) return
        try {
            val inner = (org.json.JSONTokener(json).nextValue() as? String) ?: json
            val o = org.json.JSONObject(inner)
            val e = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit()
            parseCss(o.optString("accent"))?.let { e.putInt("accent", it) }
            parseCss(o.optString("bg"))?.let { e.putInt("bg", it) }
            parseCss(o.optString("surface"))?.let { e.putInt("surface", it) }
            parseCss(o.optString("elevated"))?.let { e.putInt("elevated", it) }
            parseCss(o.optString("text"))?.let { e.putInt("text", it) }
            e.putBoolean("dark", o.optBoolean("dark", false))
            e.apply()
        } catch (_: Exception) { }
    }

    private fun luminance(c: Int): Double =
        (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) / 255.0

    /** Parse "#rrggbb", "rgb(r,g,b)" or "rgba(r,g,b,a)". */
    private fun parseCss(c: String?): Int? {
        if (c.isNullOrBlank()) return null
        val s = c.trim()
        return try {
            if (s.startsWith("#")) Color.parseColor(s)
            else {
                val nums = Regex("[0-9.]+").findAll(s).map { it.value }.toList()
                if (nums.size >= 3) {
                    val r = nums[0].toFloat().toInt().coerceIn(0, 255)
                    val g = nums[1].toFloat().toInt().coerceIn(0, 255)
                    val b = nums[2].toFloat().toInt().coerceIn(0, 255)
                    val a = (if (nums.size >= 4) (nums[3].toFloat() * 255).toInt() else 255).coerceIn(0, 255)
                    Color.argb(a, r, g, b)
                } else null
            }
        } catch (_: Exception) { null }
    }
}
