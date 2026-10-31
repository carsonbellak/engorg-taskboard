package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * "Add workbook to EngInk" in the Android share sheet. Takes a shared .html file, or a claude.ai
 * artifact link.
 *
 * claude.ai renders an artifact inside an iframe on `<uuid>.frame.claudeusercontent.com`, so a link
 * has to be opened in a real WebView (the shell needs JS and passes a bot check) and the iframe's
 * page collected as it loads. The WebView stays on screen because a private artifact needs a
 * sign-in, and Google sign-in doesn't work in a WebView, so a link-shared artifact is the sure path.
 */
class WorkbookShareActivity : ComponentActivity() {

    private lateinit var status: TextView
    private lateinit var body: LinearLayout
    private var web: WebView? = null
    private val main = Handler(Looper.getMainLooper())
    private val seen = HashSet<String>()
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private var page: String? = null    // the largest frame document so far: the artifact, not a warm-up frame
    private var saving = false
    private var sharedLink = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppTheme.load(this)
        SystemBars.setup(this, lightBackground = !AppTheme.dark)
        Workbooks.init(this)
        buildUi()

        val file = sharedFile()
        val link = intent.getStringExtra(Intent.EXTRA_TEXT)?.let { LINK.find(it)?.value }?.trimEnd('.', ',', ')', ']', '"', '\'')
        when {
            file != null -> importFile(file)
            link != null && isClaudeLink(link) -> openLink(link)
            else -> {
                Toast.makeText(this, "EngInk can save .html files and Claude artifact links.", Toast.LENGTH_LONG).show()
                finish()
            }
        }
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        web?.destroy()
        web = null
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildUi() {
        status = TextView(this).apply { text = "Saving workbook…"; setTextColor(AppTheme.text); textSize = 14f }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(AppTheme.surface); setPadding(dp(16), dp(10), dp(12), dp(10))
            addView(ProgressBar(this@WorkbookShareActivity), LinearLayout.LayoutParams(dp(22), dp(22)).apply { rightMargin = dp(12) })
            addView(status, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(TextView(this@WorkbookShareActivity).apply {
                text = "Close"; textSize = 14f; setTypeface(null, Typeface.BOLD); setTextColor(AppTheme.text)
                setPadding(dp(14), dp(8), dp(6), dp(8))
                setOnClickListener { finish() }
            })
        }
        body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(AppTheme.bg)
            addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        setContentView(body)
        SystemBars.padTopForStatusBar(bar)
    }

    private fun sharedFile(): Uri? {
        val uri = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
        return uri?.takeIf { Workbooks.isHtml(this, it) }
    }

    private fun isClaudeLink(link: String): Boolean {
        val host = Uri.parse(link).host ?: return false
        return host == "claude.ai" || host.endsWith(".claude.ai")
    }

    private fun importFile(uri: Uri) {
        Thread {
            val w = Workbooks.importFile(this, uri, null)
            runOnUiThread {
                if (w == null) {
                    Toast.makeText(this, "Couldn't read that file.", Toast.LENGTH_LONG).show()
                    finish()
                } else capture(w)
            }
        }.start()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openLink(link: String) {
        sharedLink = link
        val view = WebView(this)
        web = view
        CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(view, true) }
        view.settings.apply { javaScriptEnabled = true; domStorageEnabled = true }
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (isFrameDocument(request)) collect(request)
                return null   // the WebView still loads it: a signed frame URL may not survive being taken over
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
                request.url.scheme != "https"
        }
        body.addView(view, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        view.loadUrl(link)
        main.postDelayed({
            if (page == null && !saving) status.text = "Can't read this page yet. Sign in here if it asks. Otherwise set the artifact to \"anyone with the link\", or share its .html file."
        }, GIVE_UP_MS)
    }

    private fun isFrameDocument(r: WebResourceRequest): Boolean {
        if (r.isForMainFrame || r.method != "GET") return false
        val host = r.url.host ?: return false
        return host.endsWith(".claudeusercontent.com") && r.requestHeaders["Accept"]?.contains("text/html") != false
    }

    /** Fetch a frame's document a second time beside the WebView, with the same session. */
    private fun collect(r: WebResourceRequest) {
        val url = r.url.toString()
        synchronized(seen) { if (!seen.add(url)) return }
        val agent = r.requestHeaders["User-Agent"]
        val cookies = CookieManager.getInstance().getCookie(url)
        Thread {
            try {
                val req = Request.Builder().url(url).header("Accept", "text/html")
                agent?.let { req.header("User-Agent", it) }
                cookies?.let { req.header("Cookie", it) }
                http.newCall(req.build()).execute().use { res ->
                    val type = res.header("Content-Type").orEmpty()
                    if (res.isSuccessful && type.contains("text/html")) res.body?.string()?.let { html -> main.post { onDocument(html) } }
                }
            } catch (_: Exception) { }
        }.start()
    }

    private fun onDocument(html: String) {
        // claude.ai also loads an empty warm-up frame, even on a signed-out sign-in page.
        if (saving || html.length < MIN_PAGE_CHARS || html.length <= (page?.length ?: 0)) return
        page = html
        main.removeCallbacksAndMessages(SETTLE)
        // More frames can still arrive; settle before picking the biggest.
        main.postAtTime({ save() }, SETTLE, android.os.SystemClock.uptimeMillis() + SETTLE_MS)
    }

    private fun save() {
        val html = page ?: return
        saving = true
        web?.let { body.removeView(it); it.stopLoading() }
        CookieManager.getInstance().flush()
        capture(Workbooks.saveFromLink(sharedLink, html.toByteArray(), Workbooks.titleOf(html, "Workbook")))
    }

    private fun capture(w: Workbooks.Workbook) {
        status.text = "Saving “${w.title}” for offline…"
        WorkbookCapture.run(this, w) { failed ->
            if (isDestroyed) return@run   // closed mid-save: it's in the library, don't pop it open
            if (failed > 0) Toast.makeText(this, "Open it once while online to finish saving it for offline.", Toast.LENGTH_LONG).show()
            val ids = Workbooks.openIds(this, w, NotebookStore(filesDir))
            startActivities(arrayOf(
                Intent(this, LibraryActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                Intent(this, InkActivity::class.java).putStringArrayListExtra(InkActivity.EXTRA_NOTEBOOK_IDS, ids),
            ))
            finish()
        }
    }

    private companion object {
        val LINK = Regex("https://\\S+")
        val SETTLE = Any()
        const val MIN_PAGE_CHARS = 1024
        const val SETTLE_MS = 2500L
        const val GIVE_UP_MS = 30_000L
    }
}
