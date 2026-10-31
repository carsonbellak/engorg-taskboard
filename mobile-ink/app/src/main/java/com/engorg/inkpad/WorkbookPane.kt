package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A split-view pane showing a saved workbook. It takes no ink and never becomes the toolbar's
 * focused pane, so tapping an answer leaves the pen on the notebook beside it. [WorkbookNet] keeps
 * the page offline-capable and off the network; no JS bridge is ever added to this WebView.
 */
@SuppressLint("SetJavaScriptEnabled")
class WorkbookPane(context: Context) : LinearLayout(context) {
    lateinit var workbook: Workbooks.Workbook
        private set

    /** Holds the title chip. Padded down so the floating toolbar doesn't cover the page's own header. */
    val header = FrameLayout(context).apply {
        setBackgroundColor(AppTheme.surface)
        setPadding(dp(10), dp(62), dp(10), dp(6))
    }
    @Volatile private var net: WorkbookNet? = null
    private var web: WebView = makeWeb()

    init {
        orientation = VERTICAL
        setBackgroundColor(AppTheme.bg)
        addView(header, LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        addView(web, LayoutParams(MATCH_PARENT, 0, 1f))
        SystemBars.padTopForStatusBar(header)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun makeWeb() = WebView(context).apply {
        WorkbookNet.lockDown(this)
        settings.apply { setSupportZoom(true); builtInZoomControls = true; displayZoomControls = false }
        setBackgroundColor(AppTheme.bg)
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = net?.serve(request)

            // Links out of the workbook belong in the browser; this pane only shows the saved page.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == net?.host) return false
                if (request.hasGesture() && url.scheme in setOf("http", "https"))
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                // Twice, because typesetting grows the page after it loads.
                val y = workbook.lastScroll
                if (y > 0) for (delay in longArrayOf(500, 2000)) view.postDelayed({ view.scrollTo(0, y) }, delay)
            }

            // A crashed page must not take the handwriting beside it down with it.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                post { replaceWeb() }
                return true
            }
        }
    }

    private fun replaceWeb() {
        removeView(web); web.destroy()
        web = makeWeb()
        addView(web, LayoutParams(MATCH_PARENT, 0, 1f))
        net?.let { web.loadUrl(it.pageUrl) }
    }

    fun open(w: Workbooks.Workbook) {
        if (::workbook.isInitialized) saveScroll()
        workbook = w
        // Assigned before loading: the first request needs it, on another thread.
        val n = WorkbookNet(w)
        net = n
        web.loadUrl(n.pageUrl)
    }

    fun saveScroll() { if (::workbook.isInitialized && web.scrollY > 0) workbook.lastScroll = web.scrollY }
    fun pause() { saveScroll(); web.onPause() }
    fun resume() = web.onResume()
    fun dispose() { removeView(web); web.destroy() }
}

/**
 * Loads a just-imported workbook once in a throwaway WebView so everything it pulls from a CDN is
 * in the offline cache before the user is ever offline. [onDone] gets how many files couldn't be
 * saved; a workbook opened online later fills any gap on its own.
 */
object WorkbookCapture {
    private const val QUIET_MS = 2000L
    private const val MAX_MS = 30_000L

    @SuppressLint("SetJavaScriptEnabled")
    fun run(activity: ComponentActivity, w: Workbooks.Workbook, onDone: (Int) -> Unit) {
        val net = WorkbookNet(w)
        val finished = AtomicBoolean(false)
        val web = WebView(activity)
        val started = System.currentTimeMillis()
        var pageLoaded = false

        fun finish() {
            if (!finished.compareAndSet(false, true)) return
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
            val base = net.mathJaxBase
            if (base == null) { onDone(net.failed.get()); return }
            Thread {
                WorkbookNet.saveMathJaxExtensions(base)
                activity.runOnUiThread { onDone(net.failed.get()) }
            }.start()
        }

        fun poll() {
            if (finished.get()) return
            val quiet = net.inFlight.get() == 0 && System.currentTimeMillis() - net.lastActivity > QUIET_MS
            if ((pageLoaded && quiet) || System.currentTimeMillis() - started > MAX_MS || activity.isDestroyed) finish()
            else web.postDelayed({ poll() }, 300)
        }

        WorkbookNet.lockDown(web)
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse = net.serve(request)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun onPageFinished(view: WebView, url: String) { pageLoaded = true }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean { finish(); return true }
        }
        // Attached and full-size, though invisible: a detached WebView skips the layout that
        // triggers web font downloads.
        web.alpha = 0f
        activity.addContentView(web, ViewGroup.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        web.loadUrl(net.pageUrl)
        web.postDelayed({ poll() }, 300)
    }
}
