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
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app auto-update for the sideloaded APK. There's no Play Store, so we pull new builds from the
 * project's GitHub Releases and hand them to Android's package installer.
 *
 * Every `release.js` ship pushes a `vX.Y.Z` tag, and CI (release-installer.yml → the `android` job)
 * attaches that version's `EngOrg-Ink-vX.Y.Z.apk` to the matching GitHub Release. Old version
 * releases are pruned, so the newest `vX.Y.Z` release always carries the current APK.
 *
 * Detection is a plain semantic-version compare: the tag of the newest published `vX.Y.Z` release
 * vs. this build's baked [BuildConfig.VERSION_NAME] (CI stamps that with the release version — see
 * app/build.gradle.kts `appVersionName`). If the release is a higher version, there's a real update
 * to offer. This replaces the old approach of comparing the rolling "latest" APK's upload timestamp
 * to the device install time, which silently broke whenever "latest" drifted from the tagged release
 * that users actually install.
 */
object InkUpdater {
    private const val PREF = "engorg_update"
    private const val RELEASES_API = "https://api.github.com/repos/carsonbellak/engorg-taskboard/releases?per_page=30"
    private const val CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000   // check at most this often

    private data class Release(val version: String, val apkUrl: String, val sizeBytes: Long)

    /**
     * Throttled background check. On a newer published version, prompts on the UI thread.
     * [force] ignores the interval and the "Later" suppression (for a manual "check for updates").
     */
    fun checkInBackground(activity: Activity, force: Boolean = false) {
        val prefs = activity.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong("lastCheck", 0L) < CHECK_INTERVAL_MS) return
        Thread {
            try {
                val rel = fetchNewestRelease() ?: return@Thread
                prefs.edit().putLong("lastCheck", now).apply()
                if (!isNewer(rel.version)) return@Thread                          // already on this version (or newer)
                if (!force && rel.version == prefs.getString("skipVersion", "")) return@Thread  // user said "Later" for this one
                if (activity.isFinishing || activity.isDestroyed) return@Thread
                activity.runOnUiThread { if (!activity.isFinishing) promptUpdate(activity, rel) }
            } catch (_: Exception) { /* offline / rate-limited — try again next interval */ }
        }.start()
    }

    /**
     * Manual "check for updates" — always hits the network (ignores the interval + the "Later"
     * suppression) and gives visible feedback: prompts on a newer build, otherwise confirms the
     * user is current. Wire this to a button so the auto-updater is verifiable and can be pulled
     * on demand (the native counterpart to the desktop's Settings → About "Check for updates").
     */
    fun checkNow(activity: Activity) {
        Toast.makeText(activity, "Checking for updates…", Toast.LENGTH_SHORT).show()
        Thread {
            val rel = try { fetchNewestRelease() } catch (_: Exception) { null }
            if (activity.isFinishing || activity.isDestroyed) return@Thread
            activity.runOnUiThread {
                if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                when {
                    rel == null ->
                        Toast.makeText(activity, "Couldn't check for updates — check your connection.", Toast.LENGTH_LONG).show()
                    isNewer(rel.version) -> {
                        // A forced check should re-offer even a build the user previously tapped "Later" on.
                        activity.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().remove("skipVersion").apply()
                        promptUpdate(activity, rel)
                    }
                    else ->
                        Toast.makeText(activity, "You're on the latest version (${BuildConfig.VERSION_NAME}).", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    /** The newest published `vX.Y.Z` release that has an EngOrg-Ink APK attached, or null. */
    private fun fetchNewestRelease(): Release? {
        val conn = (URL(RELEASES_API).openConnection() as HttpURLConnection).apply {
            connectTimeout = 12_000; readTimeout = 12_000
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "EngOrg-Ink")
        }
        try {
            if (conn.responseCode != 200) return null
            val arr = JSONArray(conn.inputStream.bufferedReader().use { it.readText() })
            var best: Release? = null
            var bestVer: IntArray? = null
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (o.optBoolean("draft") || o.optBoolean("prerelease")) continue
                val tag = o.optString("tag_name")
                if (!Regex("^v?\\d+\\.\\d+\\.\\d+$").matches(tag)) continue        // only version tags (skip "latest"/"build-deps")
                val ver = parseSemver(tag) ?: continue
                val assets = o.optJSONArray("assets") ?: continue
                var apkUrl = ""; var size = 0L
                for (j in 0 until assets.length()) {
                    val a = assets.getJSONObject(j)
                    val name = a.optString("name")
                    if (name.startsWith("EngOrg-Ink") && name.endsWith(".apk")) {
                        apkUrl = a.optString("browser_download_url"); size = a.optLong("size", 0L); break
                    }
                }
                if (apkUrl.isBlank()) continue
                if (bestVer == null || compareSemver(ver, bestVer) > 0) {
                    bestVer = ver; best = Release(tag.removePrefix("v"), apkUrl, size)
                }
            }
            return best
        } finally { conn.disconnect() }
    }

    /** True if [candidate] (e.g. "1.3.34") is a higher semver than this installed build. */
    private fun isNewer(candidate: String): Boolean {
        val c = parseSemver(candidate) ?: return false
        // Unknown installed version (e.g. a local dev build with a non-release name) → don't nag.
        val installed = parseSemver(BuildConfig.VERSION_NAME) ?: return false
        return compareSemver(c, installed) > 0
    }

    private fun parseSemver(s: String?): IntArray? {
        if (s.isNullOrBlank()) return null
        val m = Regex("(\\d+)\\.(\\d+)\\.(\\d+)").find(s) ?: return null
        return intArrayOf(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
    }

    private fun compareSemver(a: IntArray, b: IntArray): Int {
        for (i in 0 until 3) if (a[i] != b[i]) return a[i] - b[i]
        return 0
    }

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
        val sizeMb = if (rel.sizeBytes > 0) String.format(java.util.Locale.US, " (%.1f MB)", rel.sizeBytes / 1_048_576.0) else ""
        box.addView(TextView(activity).apply {
            text = "EngInk ${rel.version} is ready to install$sizeMb."
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

        val later = textButton("Later", accent = false) { prefs.edit().putString("skipVersion", rel.version).apply(); dialog.dismiss() }
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
                val out = File(dir, "EngOrg-Ink.apk")
                val conn = (URL(rel.apkUrl).openConnection() as HttpURLConnection).apply {
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
