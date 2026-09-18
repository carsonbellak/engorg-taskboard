package com.engorg.inkpad

import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

/**
 * The app is a thin native shell around the existing PWA:
 *
 *  • Everything (notes, calendar, projects, …) is the deployed PWA loaded in this WebView —
 *    no duplicated codebase, always in sync with what's shipped to Firebase Hosting.
 *  • The one thing the native app adds is handwriting: when the PWA navigates to the ink page
 *    we intercept it and open the native [InkActivity] (front-buffered low-latency ink) instead.
 *
 * Note: Google sign-in is blocked by Google inside raw WebViews, so sign in with email/password.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url
                    val last = u.lastPathSegment ?: ""
                    // The PWA's "Ink" tab navigates to /ink.html — hand that off to native ink.
                    if (last == "ink.html" || u.path?.trimEnd('/')?.endsWith("/ink") == true) {
                        startActivity(Intent(this@MainActivity, InkActivity::class.java))
                        return true
                    }
                    return false // let the WebView load everything else (the PWA)
                }
            }
        }

        setContentView(web)
        web.loadUrl(PWA_URL)

        // Back navigates the PWA's own history before leaving the app.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val PWA_URL = "https://assistant-taskboard.web.app"
    }
}
