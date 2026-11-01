package com.engorg.inkpad

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.inputmethod.InputMethodManager
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
import androidx.core.widget.addTextChangedListener

/**
 * EngOrg as the Android home screen: the same PWA shell as [MainActivity], opened on the calendar,
 * plus the one thing a launcher needs that the PWA can't do, a drawer of the installed apps.
 *
 * The drawer is native so the way out of this screen still works when the page doesn't load.
 * Set or undo this from the EngInk library's ⋯ sheet (see [HomeScreen]).
 */
class HomeActivity : MainActivity() {

    private class App(val label: String, val component: ComponentName, val icon: Drawable)

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
            setOnItemLongClickListener { _, _, i, _ -> appInfo(shown[i]); true }
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
        val list = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .filter { it.activityInfo.packageName != packageName }
            .map { App(it.loadLabel(pm).toString(), ComponentName(it.activityInfo.packageName, it.activityInfo.name), it.loadIcon(pm)) }
            .sortedBy { it.label.lowercase() }
        runOnUiThread {
            // An unchanged list keeps the drawer's scroll position.
            if (!isDestroyed && list.map { it.component } != apps.map { it.component }) { apps = list; filter() }
        }
    }.start()

    private fun filter() {
        val q = search.text.toString().trim()
        shown = if (q.isEmpty()) apps else apps.filter { it.label.contains(q, ignoreCase = true) }
        adapter.notifyDataSetChanged()
    }

    private fun launch(app: App) {
        try {
            startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(app.component).addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
            closeDrawer()
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "${app.label} isn't available.", Toast.LENGTH_SHORT).show()
            loadApps()
        } catch (e: SecurityException) {
            Toast.makeText(this, "${app.label} can't be opened.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun appInfo(app: App) {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", app.component.packageName, null)))
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
