package com.engorg.inkpad

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Runs the drawing analysis (assets/analysis/: ink-analysis.js on top of the desktop's
 * circuit-engine.js + thermo-engine.js, copied in at build time) in a headless WebView, so EngInk
 * and the desktop compute identical numbers from one tested source. Nothing leaves the device.
 *
 * [run] takes a page's geometry ([pageJson]) and calls back on the UI thread with the result
 * (analyses / annots / comps — see ink-analysis.js), or null if the engine failed to load.
 */
@SuppressLint("SetJavaScriptEnabled")
class AnalysisHost(context: Context) {
    private val web = WebView(context.applicationContext)
    private var loaded = false
    private val queue = ArrayList<() -> Unit>()

    init {
        web.settings.javaScriptEnabled = true
        web.settings.allowFileAccess = true
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                loaded = true
                queue.forEach { it() }; queue.clear()
            }
        }
        web.loadUrl("file:///android_asset/analysis/index.html")
    }

    fun run(pageJson: String, onResult: (JSONObject?) -> Unit) {
        val call = {
            web.evaluateJavascript("EI.run(${JSONObject.quote(pageJson)})") { raw ->
                // evaluateJavascript hands back the JSON encoding of the returned string.
                val str = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()
                onResult(str?.let { runCatching { JSONObject(it) }.getOrNull() })
            }
        }
        if (loaded) call() else queue.add(call)
    }

    fun dispose() { queue.clear(); runCatching { web.destroy() } }

    companion object {
        private fun pt(p: android.graphics.PointF) = JSONArray().put(p.x.toDouble()).put(p.y.toDouble())

        /**
         * The page as plain geometry for ink-analysis.js: class symbols (inline ones by their two
         * terminals, box ones by their unrotated box + rotation) and wire candidates (line/arrow
         * shapes and non-highlighter freehand strokes — the script keeps only wire-like ink).
         * `i` is each record's index in [recs], used to map results back to symbols.
         */
        fun pageJson(recs: List<FinishedStrokesView.Rec>): String {
            val syms = JSONArray(); val wires = JSONArray()
            recs.forEachIndexed { i, rec ->
                val sp = rec.shape
                if (sp == null) {
                    if (!rec.highlighter && rec.points.size >= 2) {
                        val pa = JSONArray(); rec.points.forEach { pa.put(pt(it)) }
                        wires.put(JSONObject().put("i", i).put("kind", "ink").put("pts", pa))
                    }
                    return@forEachIndexed
                }
                when (sp.type) {
                    ShapeType.SYMBOL -> {
                        val sym = sp.symbol ?: return@forEachIndexed
                        val o = JSONObject().put("i", i).put("sym", sym.name).put("inline", sym.kind == SymKind.INLINE)
                            .put("w", sym.w.toDouble()).put("h", sym.h.toDouble()).put("rot", sp.rot.toDouble())
                            .put("pivot", pt(sp.pivot)).put("props", sp.props ?: JSONObject())
                        if (sym.kind == SymKind.INLINE) {
                            val h = sp.handles
                            if (h.size < 2) return@forEachIndexed
                            val len = hypot(h[1].x - h[0].x, h[1].y - h[0].y)
                            val kk = min(sp.symScale, len / sym.w).coerceAtLeast(0.05f)
                            o.put("terms", JSONArray().put(pt(h[0])).put(pt(h[1]))).put("half", (sym.h * kk / 2f).toDouble())
                        } else {
                            val a = sp.verts[0]; val b = sp.verts[1]
                            o.put("box", JSONArray().put(min(a.x, b.x).toDouble()).put(min(a.y, b.y).toDouble()).put(max(a.x, b.x).toDouble()).put(max(a.y, b.y).toDouble()))
                        }
                        syms.put(o)
                    }
                    ShapeType.LINE, ShapeType.ARROW -> {
                        val h = sp.handles
                        if (h.size >= 2) wires.put(JSONObject().put("i", i).put("kind", if (sp.type == ShapeType.ARROW) "arrow" else "line")
                            .put("pts", JSONArray().put(pt(h[0])).put(pt(h[1]))))
                    }
                    else -> {}
                }
            }
            return JSONObject().put("symbols", syms).put("wires", wires).toString()
        }
    }
}
