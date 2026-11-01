package com.engorg.inkpad

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.LauncherApps
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.annotation.RequiresApi
import androidx.core.widget.addTextChangedListener

/**
 * EngOrg as the Android home screen: the same PWA shell as [MainActivity], opened on the calendar,
 * plus the one thing a launcher needs that the PWA can't do, a drawer of the installed apps.
 *
 * The drawer is native so the way out of this screen still works when the page doesn't load.
 * Set or undo this from the PWA's Settings → About (see [HomeBridge]).
 */
class HomeActivity : MainActivity() {

    private class App(val label: String, val icon: Drawable, val component: ComponentName? = null, val shortcut: ShortcutInfo? = null) {
        val key = component?.flattenToString() ?: "${shortcut?.`package`}/${shortcut?.id}"
        // Top of the drawer: added shortcuts, then Chrome, then everything else A–Z.
        val rank = if (shortcut != null) 0 else if (component?.packageName == CHROME) 1 else 2
    }

    private val launcherApps by lazy { getSystemService(LauncherApps::class.java) }

    private lateinit var handle: ImageButton
    private lateinit var drawer: LinearLayout
    private lateinit var search: EditText
    private lateinit var close: ImageButton

    private var apps = emptyList<App>()
    private var shown = emptyList<App>()
    private val adapter = AppAdapter()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppTheme.load(this)
        addContentView(buildHandle(), FrameLayout.LayoutParams(dp(30), dp(68), Gravity.END or Gravity.CENTER_VERTICAL))
        addContentView(buildDrawer(), FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        applyTheme()
        loadApps()

        // Registered after MainActivity's, so it wins: there's nothing behind a home screen to go back to.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (drawer.visibility == View.VISIBLE) closeDrawer() else if (web.canGoBack()) web.goBack()
            }
        })
    }

    /** The Home button while this is already running. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        closeDrawer()
        if (onPwa) showCalendar() else web.loadUrl(PWA_URL)
    }

    override fun onPwaLoaded() = showCalendar()

    private fun showCalendar() = web.evaluateJavascript(CALENDAR_JS, null)

    // This task must stay just this screen: anything it opens (Ink, links) gets its own task,
    // otherwise pressing Home would close it. Pickers and sign-in go through startActivityForResult.
    override fun startActivity(intent: Intent, options: Bundle?) {
        super.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), options)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildHandle() = ImageButton(this).apply {
        handle = this
        setImageBitmap(Icons.bitmap(Icons.GRID, dp(18)))
        scaleType = ImageView.ScaleType.CENTER
        contentDescription = "All apps"
        stateListAnimator = null; minimumWidth = 0
        setPadding(0, 0, 0, 0)
        setOnClickListener { openDrawer() }
    }

    private fun buildDrawer(): View {
        search = EditText(this).apply {
            hint = "Search apps"; textSize = 16f; isSingleLine = true
            setPadding(dp(14), dp(10), dp(14), dp(10))
            addTextChangedListener { filter() }
        }
        close = ImageButton(this).apply {
            setImageBitmap(Icons.bitmap(Icons.CLOSE, dp(22)))
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "Close"
            stateListAnimator = null; minimumWidth = 0
            val pd = dp(8); setPadding(pd, pd, pd, pd)
            setOnClickListener { closeDrawer() }
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(8))
            addView(search, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(close, LinearLayout.LayoutParams(dp(42), dp(42)).apply { leftMargin = dp(10) })
        }
        val grid = GridView(this).apply {
            numColumns = GridView.AUTO_FIT; columnWidth = dp(92)
            stretchMode = GridView.STRETCH_COLUMN_WIDTH
            verticalSpacing = dp(6); clipToPadding = false
            setPadding(dp(12), dp(6), dp(12), dp(24))
            adapter = this@HomeActivity.adapter
            setOnItemClickListener { _, _, i, _ -> launch(shown[i]) }
            // Without the stock launcher, this is the quick way to an app's uninstall/settings page.
            setOnItemLongClickListener { _, _, i, _ -> if (shown[i].shortcut != null) removeShortcut(shown[i]) else appInfo(shown[i]); true }
        }
        drawer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; visibility = View.GONE
            isClickable = true // keep touches off the page behind
            addView(bar)
            addView(grid, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        }
        SystemBars.padTopForStatusBar(bar)
        SystemBars.padBottomForNavBar(grid)
        return drawer
    }

    private fun applyTheme() {
        val edge = dp(14).toFloat()
        handle.background = GradientDrawable().apply {
            cornerRadii = floatArrayOf(edge, edge, 0f, 0f, 0f, 0f, edge, edge)
            setColor(Color.argb(0xD0, Color.red(AppTheme.elevated), Color.green(AppTheme.elevated), Color.blue(AppTheme.elevated)))
        }
        handle.setColorFilter(AppTheme.text)
        drawer.setBackgroundColor(AppTheme.bg)
        search.setTextColor(AppTheme.text)
        search.setHintTextColor(Color.argb(0x99, Color.red(AppTheme.text), Color.green(AppTheme.text), Color.blue(AppTheme.text)))
        search.background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated) }
        close.background = GradientDrawable().apply { cornerRadius = dp(18).toFloat(); setColor(AppTheme.elevated) }
        close.setColorFilter(AppTheme.text)
        adapter.notifyDataSetChanged()
    }

    private fun openDrawer() {
        drawer.visibility = View.VISIBLE
        loadApps() // catches anything installed since last time
        // Shown first and restyled after: the drawer must open even if the page is dead.
        web.evaluateJavascript(THEME_JS) { theme ->
            AppTheme.saveFromJson(this, theme)
            AppTheme.load(this)
            applyTheme()
        }
    }

    private fun closeDrawer() {
        if (drawer.visibility != View.VISIBLE) return
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(search.windowToken, 0)
        drawer.visibility = View.GONE
        search.setText("")
    }

    /** Off the UI thread: loading every icon takes a moment. Own package left out, this is it. */
    private fun loadApps() = Thread {
        val pm = packageManager
        val installed = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .filter { it.activityInfo.packageName != packageName }
            .map { App(it.loadLabel(pm).toString(), it.loadIcon(pm), component = ComponentName(it.activityInfo.packageName, it.activityInfo.name)) }
        val list = (pinnedShortcuts() + installed).sortedWith(compareBy({ it.rank }, { it.label.lowercase() }))
        runOnUiThread {
            // An unchanged list keeps the drawer's scroll position.
            if (!isDestroyed && list.map { it.key } != apps.map { it.key }) { apps = list; filter() }
        }
    }.start()

    /** What's been added with "Add to Home screen". Android only shares these with the current home app. */
    private fun pinnedShortcuts(): List<App> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !launcherApps.hasShortcutHostPermission()) return emptyList()
        val query = LauncherApps.ShortcutQuery().setQueryFlags(LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED)
        return try {
            launcherApps.getShortcuts(query, Process.myUserHandle()).orEmpty().map {
                val icon = launcherApps.getShortcutIconDrawable(it, resources.displayMetrics.densityDpi) ?: packageManager.defaultActivityIcon
                App((it.shortLabel ?: it.longLabel ?: "Shortcut").toString(), icon, shortcut = it)
            }
        } catch (e: IllegalStateException) { // the device is still locked
            emptyList()
        }
    }

    private fun filter() {
        val q = search.text.toString().trim()
        shown = if (q.isEmpty()) apps else apps.filter { it.label.contains(q, ignoreCase = true) }
        adapter.notifyDataSetChanged()
    }

    private fun launch(app: App) {
        try {
            if (app.shortcut != null) launcherApps.startShortcut(app.shortcut, null, null)
            else startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(app.component).addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
            closeDrawer()
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "${app.label} isn't available.", Toast.LENGTH_SHORT).show()
            loadApps()
        } catch (e: SecurityException) {
            Toast.makeText(this, "${app.label} can't be opened.", Toast.LENGTH_SHORT).show()
        } catch (e: IllegalStateException) { // a shortcut while the device is still locked
            Toast.makeText(this, "${app.label} can't be opened.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun appInfo(app: App) {
        val pkg = app.component?.packageName ?: return
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null)))
    }

    /** Unpinning replaces the app's whole pinned list, so the others are passed back in. */
    private fun removeShortcut(app: App) {
        val target = app.shortcut ?: return
        AlertDialog.Builder(this)
            .setTitle("Remove ${app.label}?")
            .setPositiveButton("Remove") { _, _ ->
                val keep = apps.mapNotNull { it.shortcut }.filter { it.`package` == target.`package` && it.id != target.id }.map { it.id }
                try {
                    launcherApps.pinShortcuts(target.`package`, keep, Process.myUserHandle())
                } catch (e: IllegalStateException) {
                    Toast.makeText(this, "${app.label} can't be removed right now.", Toast.LENGTH_SHORT).show()
                }
                loadApps()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private inner class AppAdapter : BaseAdapter() {
        override fun getCount() = shown.size
        override fun getItem(i: Int) = shown[i]
        override fun getItemId(i: Int) = i.toLong()

        override fun getView(i: Int, convert: View?, parent: ViewGroup): View {
            val cell = convert as? LinearLayout ?: appCell()
            (cell.getChildAt(0) as ImageView).setImageDrawable(shown[i].icon)
            (cell.getChildAt(1) as TextView).apply { text = shown[i].label; setTextColor(AppTheme.text) }
            return cell
        }

        private fun appCell() = LinearLayout(this@HomeActivity).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(4), dp(10), dp(4), dp(8))
            addView(ImageView(this@HomeActivity), LinearLayout.LayoutParams(dp(52), dp(52)))
            addView(TextView(this@HomeActivity).apply {
                textSize = 12f; gravity = Gravity.CENTER; maxLines = 2; ellipsize = TextUtils.TruncateAt.END
                setTypeface(null, Typeface.NORMAL); setPadding(0, dp(6), 0, 0)
            })
        }
    }

    private companion object {
        // Taps the PWA's own Calendar tab, which also works when the hotbar has it hidden or under More.
        const val CALENDAR_JS = "document.querySelector('.nav-item[data-navid=\"calendar\"]')?.click()"
        const val CHROME = "com.android.chrome"
    }
}

/**
 * Where "Add to Home screen" lands (Chrome's, for one) while EngOrg is the home app. Android refuses
 * those requests if the home app has no such screen. The user already chose to add it, so nothing is asked.
 */
@RequiresApi(Build.VERSION_CODES.O)
class PinShortcutActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val request = getSystemService(LauncherApps::class.java).getPinItemRequest(intent)
        if (request?.requestType == LauncherApps.PinItemRequest.REQUEST_TYPE_SHORTCUT && request.isValid && request.accept()) {
            Toast.makeText(this, "Added to your apps.", Toast.LENGTH_SHORT).show()
        }
        finish()
    }
}

/** Exposed to the PWA as window.AndroidHome, for its Settings. [allowed] as in [FileSaveBridge]. */
class HomeBridge(private val act: Activity, private val allowed: () -> Boolean) {
    @JavascriptInterface
    fun isDefault() = allowed() && HomeScreen.isDefault(act)

    @JavascriptInterface
    fun openSettings() {
        if (allowed()) act.runOnUiThread { HomeScreen.openSettings(act) }
    }
}

/** Whether EngOrg is Android's home app, and the system screen that changes it (either way). */
object HomeScreen {
    fun isDefault(ctx: Context): Boolean {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        return ctx.packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName == ctx.packageName
    }

    fun openSettings(ctx: Context) {
        try {
            ctx.startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
        } catch (e: ActivityNotFoundException) {
            try {
                ctx.startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(ctx, "Set the home app in Android Settings → Apps.", Toast.LENGTH_LONG).show()
            }
        }
    }
}
