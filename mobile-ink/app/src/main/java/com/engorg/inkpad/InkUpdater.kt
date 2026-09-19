package com.engorg.inkpad

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * In-app auto-update for the sideloaded APK. There's no Play Store, so we pull new builds from the
 * project's rolling "latest" GitHub Release (where CI attaches [ASSET]) and hand them to Android's
 * package installer.
 *
 * Version detection sidesteps the fact that the APK's baked versionName never changes: we compare
 * the release ASSET's server-side `updated_at` (when CI last rebuilt & uploaded the APK) against
 * this device's [android.content.pm.PackageInfo.lastUpdateTime] (when the running app was installed).
 * If the published APK is newer than what's installed, there's a new build to offer — and once the
 * user installs it, lastUpdateTime moves past the asset, so the prompt goes away on its own.
 */
object InkUpdater {
    private const val PREF = "engorg_update"
    private const val API = "https://api.github.com/repos/carsonbellak/engorg-taskboard/releases/tags/latest"
    private const val ASSET = "EngOrg-Ink.apk"
    private const val CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000   // check at most this often
    private const val GRACE_MS = 90_000L                         // asset must beat our install time by this margin

    private data class Release(val url: String, val updatedAtMs: Long, val sizeBytes: Long)

    /**
     * Throttled background check. On a newer published build, prompts on the UI thread.
     * [force] ignores the interval and the "Later" suppression (for a manual "check for updates").
     */
    fun checkInBackground(activity: Activity, force: Boolean = false) {
        val prefs = activity.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong("lastCheck", 0L) < CHECK_INTERVAL_MS) return
        Thread {
            try {
                val rel = fetchLatest() ?: return@Thread
                prefs.edit().putLong("lastCheck", now).apply()
                val installedAt = installedAt(activity)
                if (rel.updatedAtMs <= installedAt + GRACE_MS) return@Thread            // already on this build (or newer)
                if (!force && rel.updatedAtMs <= prefs.getLong("skipUntil", 0L)) return@Thread  // user said "Later" for this build
                if (activity.isFinishing || activity.isDestroyed) return@Thread
                activity.runOnUiThread { if (!activity.isFinishing) promptUpdate(activity, rel) }
            } catch (_: Exception) { /* offline / rate-limited — try again next interval */ }
        }.start()
    }

    private fun installedAt(activity: Activity): Long = try {
        activity.packageManager.getPackageInfo(activity.packageName, 0).lastUpdateTime
    } catch (_: Exception) { 0L }

    private fun fetchLatest(): Release? {
        val conn = (URL(API).openConnection() as HttpURLConnection).apply {
            connectTimeout = 12_000; readTimeout = 12_000
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "EngOrg-Ink")
        }
        try {
            if (conn.responseCode != 200) return null
            val o = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val assets = o.optJSONArray("assets") ?: return null
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.optString("name") == ASSET) {
                    val url = a.optString("browser_download_url")
                    if (url.isBlank()) return null
                    return Release(url, parseIso(a.optString("updated_at")), a.optLong("size", 0L))
                }
            }
            return null
        } finally { conn.disconnect() }
    }

    private fun parseIso(s: String): Long = try {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(s)?.time ?: 0L
    } catch (_: Exception) { 0L }

    // ---------- UI ----------
    private fun promptUpdate(activity: Activity, rel: Release) {
        AppTheme.load(activity)  // match the user's saved theme colors
        val d = activity.resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()
        val prefs = activity.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val muted = Color.argb(0xC0, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text))

        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply { cornerRadius = dp(22).toFloat(); setColor(AppTheme.surface) }
            setPadding(dp(22), dp(22), dp(22), dp(16))
        }
        box.addView(TextView(activity).apply {
            text = "Update available"; setTextColor(AppTheme.text); textSize = 18f; setTypeface(null, Typeface.BOLD)
        })
        val sizeMb = if (rel.sizeBytes > 0) String.format(Locale.US, " (%.1f MB)", rel.sizeBytes / 1_048_576.0) else ""
        box.addView(TextView(activity).apply {
            text = "A newer build of EngOrg is ready to install$sizeMb."
            setTextColor(muted); textSize = 14f; setPadding(0, dp(8), 0, 0)
        })

        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; isIndeterminate = false }
        val pct = TextView(activity).apply { setTextColor(muted); textSize = 12f; setPadding(0, dp(6), 0, 0) }
        val progress = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; visibility = View.GONE; setPadding(0, dp(16), 0, 0)
            addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)); addView(pct)
        }
        box.addView(progress)

        val dialog = Dialog(activity).apply {
            setContentView(box, ViewGroup.LayoutParams(dp(330), WRAP_CONTENT))
            window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        }

        fun textButton(label: String, accent: Boolean, onClick: () -> Unit) = TextView(activity).apply {
            text = label; textSize = 14f; setTypeface(null, Typeface.BOLD); gravity = Gravity.CENTER
            setTextColor(if (accent) AppTheme.onAccent() else AppTheme.text)
            background = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(if (accent) AppTheme.accent else AppTheme.elevated) }
            setPadding(dp(22), dp(10), dp(22), dp(10)); isClickable = true
            setOnClickListener { onClick() }
        }

        val later = textButton("Later", accent = false) { prefs.edit().putLong("skipUntil", rel.updatedAtMs).apply(); dialog.dismiss() }
        lateinit var update: TextView
        update = textButton("Update", accent = true) {
            later.isEnabled = false; update.isEnabled = false; update.alpha = 0.5f
            progress.visibility = View.VISIBLE; pct.text = "Downloading…"
            download(activity, rel, onProgress = { p -> bar.progress = p; pct.text = "Downloading… $p%" }) { apk ->
                if (apk == null) {
                    Toast.makeText(activity, "Download failed — check your connection.", Toast.LENGTH_LONG).show()
                    later.isEnabled = true; update.isEnabled = true; update.alpha = 1f
                    progress.visibility = View.GONE
                } else {
                    dialog.dismiss(); install(activity, apk)
                }
            }
        }
        box.addView(LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(18) }
            addView(later)
            addView(update, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = dp(10) })
        })
        dialog.show()
    }

    private fun download(activity: Activity, rel: Release, onProgress: (Int) -> Unit, onDone: (File?) -> Unit) {
        Thread {
            try {
                val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val out = File(dir, ASSET)
                val conn = (URL(rel.url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000; readTimeout = 30_000; instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "EngOrg-Ink")
                }
                conn.connect()
                val total = (if (rel.sizeBytes > 0) rel.sizeBytes else conn.contentLengthLong).coerceAtLeast(1L)
                conn.inputStream.use { input ->
                    out.outputStream().use { fos ->
                        val buf = ByteArray(64 * 1024); var read = 0L; var n: Int; var lastPct = -1
                        while (input.read(buf).also { n = it } >= 0) {
                            fos.write(buf, 0, n); read += n
                            val p = ((read * 100) / total).toInt().coerceIn(0, 100)
                            if (p != lastPct) { lastPct = p; activity.runOnUiThread { onProgress(p) } }
                        }
                    }
                }
                conn.disconnect()
                activity.runOnUiThread { onDone(if (out.length() > 0) out else null) }
            } catch (_: Exception) { activity.runOnUiThread { onDone(null) } }
        }.start()
    }

    private fun install(activity: Activity, apk: File) {
        // Android 8+ needs per-app permission to install packages; bounce the user to that setting.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(activity, "Allow installs from EngOrg, then tap Update again.", Toast.LENGTH_LONG).show()
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                )
            } catch (_: Exception) {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES))
            }
            return
        }
        try {
            val uri = FileProvider.getUriForFile(activity, "com.engorg.inkpad.fileprovider", apk)
            activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        } catch (_: Exception) {
            Toast.makeText(activity, "Couldn't open the installer.", Toast.LENGTH_LONG).show()
        }
    }
}
