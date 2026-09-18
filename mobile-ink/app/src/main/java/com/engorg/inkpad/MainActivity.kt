package com.engorg.inkpad

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import org.json.JSONObject

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
    private lateinit var googleClient: GoogleSignInClient
    private lateinit var signInLauncher: ActivityResultLauncher<Intent>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Native Google Sign-In: request an ID token for the Firebase "web client", then
        // hand that credential to the WebView's Firebase session. Google blocks its OAuth
        // inside WebViews, so we sign in through the system account picker and bridge it in.
        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(BuildConfig.WEB_CLIENT_ID)
            .requestEmail()
            .build()
        googleClient = GoogleSignIn.getClient(this, gso)
        signInLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            try {
                val account = GoogleSignIn.getSignedInAccountFromIntent(result.data)
                    .getResult(ApiException::class.java)
                val idToken = account?.idToken
                if (idToken.isNullOrEmpty()) {
                    Toast.makeText(this, "No ID token from Google — check the Web client ID.", Toast.LENGTH_LONG).show()
                } else {
                    // Pass the Google credential into the PWA's Firebase (signInWithCredential).
                    web.evaluateJavascript(
                        "window.__nativeGoogleCredential && window.__nativeGoogleCredential(${JSONObject.quote(idToken)})",
                        null,
                    )
                }
            } catch (e: ApiException) {
                Toast.makeText(this, "Google sign-in failed (code ${e.statusCode}).", Toast.LENGTH_LONG).show()
            }
        }

        // Allow chrome://inspect debugging, and surface web errors on screen (below).
        WebView.setWebContentsDebuggingEnabled(true)

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

            // Exposed to the PWA as window.AndroidAuth so the web Google button can start
            // the native sign-in flow.
            addJavascriptInterface(AuthBridge(), "AndroidAuth")

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url
                    val last = u.lastPathSegment ?: ""
                    // The PWA's "Ink" tab navigates to /ink.html — hand that off to native ink.
                    if (last == "ink.html" || u.path?.trimEnd('/')?.endsWith("/ink") == true) {
                        startActivity(Intent(this@MainActivity, LibraryActivity::class.java))
                        return true
                    }
                    return false // let the WebView load everything else (the PWA)
                }

                override fun onPageFinished(view: WebView, url: String) {
                    // Install an on-screen catcher so any JS error / rejection is visible
                    // (a blank screen otherwise hides the real cause).
                    view.evaluateJavascript(ERR_JS, null)
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.e("EngOrgWeb", "${m.messageLevel()} ${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                    return true
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

    /** Bridge exposed to the PWA (window.AndroidAuth) to trigger native Google sign-in. */
    inner class AuthBridge {
        @JavascriptInterface
        fun signInWithGoogle() {
            runOnUiThread {
                // Sign out first so the account picker always appears (pick/switch account).
                googleClient.signOut().addOnCompleteListener {
                    signInLauncher.launch(googleClient.signInIntent)
                }
            }
        }
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val PWA_URL = "https://assistant-taskboard.web.app"

        // Shows a dismissable red banner with any JS error / unhandled rejection /
        // console.error, so a blank screen reveals its cause instead of staying white.
        private const val ERR_JS = """
(function(){
  if(window.__eg)return; window.__eg=1;
  function show(t,m){try{var b=document.getElementById('__egerr');
    if(!b){b=document.createElement('div');b.id='__egerr';
      b.style.cssText='position:fixed;left:0;right:0;top:0;z-index:2147483647;background:rgba(176,0,32,.97);color:#fff;font:11px/1.4 monospace;padding:8px;white-space:pre-wrap;max-height:60%;overflow:auto';
      (document.body||document.documentElement).appendChild(b);b.onclick=function(){b.remove();};}
    b.textContent+=('['+t+'] '+m+'\n');}catch(e){}}
  window.addEventListener('error',function(e){show('ERR',(e.message||'')+' @'+(e.filename||'')+':'+(e.lineno||''));},true);
  window.addEventListener('unhandledrejection',function(e){var r=e.reason;show('REJECT',(r&&(r.stack||r.message))||String(r));});
  var ce=console.error;console.error=function(){try{show('console.error',Array.prototype.map.call(arguments,function(a){return (a&&a.stack)||String(a);}).join(' '));}catch(_){}ce.apply(console,arguments);};
}());
"""
    }
}
