package com.engorg.inkpad

import android.graphics.PointF
import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * EngInk live mirror — tablet (client) side. Streams the focused notebook's strokes to a desktop that
 * is running the EngInk mirror server (a LAN WebSocket). Discovery is a small UDP broadcast: we ask
 * "who's there?" and desktops reply with their host/port/pairing-code. View-only on the desktop, so
 * this is one-way (tablet -> PC).
 *
 * A singleton so it survives navigating between the library and a notebook: reconnecting isn't needed
 * just because you opened a different notebook — [bind] repoints the stream at the newly focused pane.
 */
object MirrorManager : PageCanvas.MirrorSink {

    const val WS_PORT = 8770
    const val UDP_PORT = 8771

    data class Peer(val name: String, val host: String, val port: Int, val code: String)

    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()

    private var ws: WebSocket? = null
    private var cloud: CloudMirror? = null
    /** True while mirroring through the EngOrg account instead of the Wi-Fi. */
    val viaInternet get() = cloud != null
    private var bound: PageCanvas? = null
    private var pairCode = ""
    @Volatile var connected = false; private set
    var peerLabel = ""; private set

    /** (connected, message) — set by the UI to reflect connection state on a button/dialog. */
    var onState: ((Boolean, String) -> Unit)? = null

    private var lastWet = 0L
    private var lastView = 0L

    // Serializing pages and strokes happens here, never on the UI thread (it used to make writing lag).
    private val out = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val pendingPages = java.util.concurrent.ConcurrentHashMap<Int, List<FinishedStrokesView.Rec>>()
    private fun bg(task: () -> Unit) { try { out.execute { try { task() } catch (_: Exception) {} } } catch (_: Exception) {} }

    // In-progress stroke points waiting for the next 16 ms flush.
    private val wetBuf = ArrayList<PointF>()
    private var wetReset = false
    private var wetMeta: JSONObject? = null
    private val wetFlush = Runnable { flushWet() }

    // ---- binding ----
    /** Point the mirror at the currently focused pane (null when leaving the editor). */
    fun bind(pane: PageCanvas?) {
        if (bound === pane) { if (connected && pane != null) reflect(pane); return }
        bound?.mirror = null
        bound = pane
        pane?.mirror = this
        if (connected && pane != null) reflect(pane)
    }

    // ---- connect / disconnect ----
    fun connect(host: String, port: Int, code: String, onResult: (Boolean, String) -> Unit) {
        disconnect()
        pairCode = code
        peerLabel = host
        val req = Request.Builder().url("ws://$host:$port").build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    connected = true
                    webSocket.send(JSONObject().put("t", "hello").put("code", pairCode)
                        .put("device", Build.MODEL ?: "Tablet").put("version", "").toString())
                    bound?.let { reflect(it) }
                    onState?.invoke(true, "Mirroring to $peerLabel")
                    onResult(true, "Connected")
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val t = runCatching { JSONObject(text).optString("t") }.getOrNull()
                if (t == "reject") main.post { disconnect(); onState?.invoke(false, "Rejected — check the code"); onResult(false, "Wrong code") }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post {
                    val wasConnected = connected
                    connected = false; ws = null
                    onState?.invoke(false, "Disconnected")
                    if (!wasConnected) onResult(false, t.message ?: "Couldn't connect")
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { connected = false; ws = null; onState?.invoke(false, "Disconnected") }
            }
        })
    }

    fun disconnect() {
        try { ws?.close(1000, null) } catch (_: Exception) {}
        ws = null
        cloud?.stop(); cloud = null
        connected = false
    }

    /**
     * Mirror through the signed-in EngOrg account (Firestore) — works on any network, including Wi-Fi
     * that blocks devices from reaching each other. The desktop picks it up as long as EngOrg is
     * running and signed in to the same account.
     */
    fun connectInternet(ctx: android.content.Context, onResult: (Boolean, String) -> Unit) {
        disconnect()
        val acct = CloudAuth.account(ctx) ?: run {
            onResult(false, "Not signed in. Open EngInk from the EngOrg app while you're signed in, then try again."); return
        }
        val c = CloudMirror(ctx.applicationContext, acct)
        cloud = c
        c.start { err ->
            if (cloud !== c) return@start
            if (err != null) { cloud = null; c.stop(); onResult(false, err); return@start }
            connected = true
            peerLabel = "your PC (over the internet)"
            bound?.let { reflect(it) }
            onState?.invoke(true, "Mirroring over the internet")
            onResult(true, "Connected")
        }
    }

    // ---- discovery (UDP broadcast) ----
    fun discover(onResult: (List<Peer>) -> Unit) {
        thread {
            val peers = LinkedHashMap<String, Peer>()
            try {
                DatagramSocket().use { sock ->
                    sock.broadcast = true
                    sock.soTimeout = 250
                    val probe = "{\"engink\":\"discover\"}".toByteArray()
                    for (addr in broadcastAddresses()) {
                        try { sock.send(DatagramPacket(probe, probe.size, addr, UDP_PORT)) } catch (_: Exception) {}
                    }
                    val buf = ByteArray(2048)
                    val deadline = System.currentTimeMillis() + 1500
                    while (System.currentTimeMillis() < deadline) {
                        val pkt = DatagramPacket(buf, buf.size)
                        try { sock.receive(pkt) } catch (_: SocketTimeoutException) { continue } catch (_: Exception) { break }
                        try {
                            val o = JSONObject(String(pkt.data, 0, pkt.length))
                            if (o.optString("engink") == "here") {
                                val host = pkt.address.hostAddress ?: continue
                                peers[host] = Peer(o.optString("name", host), host, o.optInt("port", WS_PORT), o.optString("code"))
                            }
                        } catch (_: Exception) {}
                    }
                }
            } catch (_: Exception) {}
            main.post { onResult(peers.values.toList()) }
        }
    }

    private fun broadcastAddresses(): List<InetAddress> {
        val out = ArrayList<InetAddress>()
        try {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                for (ia in nif.interfaceAddresses) ia.broadcast?.let { out.add(it) }
            }
        } catch (_: Exception) {}
        try { out.add(InetAddress.getByName("255.255.255.255")) } catch (_: Exception) {}
        return out
    }

    // ---- serialization ----
    private fun send(o: JSONObject) {
        cloud?.let { it.send(o); return }
        try { ws?.send(o.toString()) } catch (_: Exception) {}
    }

    private fun ptsJson(pts: List<PointF>): JSONArray {
        val a = JSONArray()
        for (p in pts) a.put(JSONArray().put(p.x.toDouble()).put(p.y.toDouble()))
        return a
    }

    private fun openJson(pane: PageCanvas): JSONObject = JSONObject()
        .put("t", "open").put("id", pane.notebook.id).put("title", pane.notebook.title)
        .put("paper", pane.finishedView.paperStyle.name).put("pageColor", pane.finishedView.pageColor)
        .put("pageCount", pane.finishedView.pages.size)

    /** Snapshot a page's recs (cheap; recs are immutable) and serialize + send it in the background, newest wins. */
    private fun queuePage(pane: PageCanvas, index: Int) {
        val snap = ArrayList(pane.finishedView.pages.getOrNull(index)?.recs ?: return)
        pendingPages[index] = snap
        bg { val recs = pendingPages.remove(index) ?: return@bg; send(pageJson(recs, index)) }
    }

    private fun pageJson(list: List<FinishedStrokesView.Rec>, index: Int): JSONObject {
        val recs = JSONArray()
        for (rec in list) {
            val o = JSONObject().put("c", rec.color).put("w", rec.widthPx.toDouble()).put("h", rec.highlighter)
            val segs = JSONArray()
            val shape = rec.shape
            if (shape != null && shape.type == ShapeType.GRAPH && shape.graph != null) {
                // The desktop has no grapher: send the card as colored strokes (frame, axes, curves).
                val a = shape.verts[0]; val b = shape.verts[1]
                val box = android.graphics.RectF(minOf(a.x, b.x), minOf(a.y, b.y), maxOf(a.x, b.x), maxOf(a.y, b.y))
                for ((color, pts) in GraphCardRenderer.strokes(shape.graph!!, box))
                    recs.put(JSONObject().put("c", color).put("w", 1.6).put("h", false).put("k", "s").put("segs", JSONArray().put(ptsJson(pts))))
                continue
            }
            if (shape != null) {
                o.put("k", "s"); if (shape.dashed) o.put("d", true)
                val parts = shape.parts()
                for (part in parts) if (!part.hidden) segs.put(ptsJson(part.pts))
                // A 3D solid's hidden edges go out as a second, dashed shape so the desktop draws them dashed too.
                val hidden = parts.filter { it.hidden }
                if (hidden.isNotEmpty()) {
                    val h = JSONObject().put("c", rec.color).put("w", rec.widthPx.toDouble()).put("h", rec.highlighter).put("k", "s").put("d", true)
                    recs.put(h.put("segs", JSONArray().apply { for (part in hidden) put(ptsJson(part.pts)) }))
                }
            }
            else { o.put("k", "f"); segs.put(ptsJson(rec.points)) }
            o.put("segs", segs)
            recs.put(o)
        }
        return JSONObject().put("t", "page").put("index", index).put("recs", recs)
    }

    private fun sendView(pane: PageCanvas) {
        val o = JSONObject().put("t", "view").put("scale", pane.scale.toDouble())
            .put("tx", pane.tx.toDouble()).put("ty", pane.ty.toDouble()).put("page", pane.currentPage())
        bg { send(o) }
    }

    /** Push the whole current notebook (meta + every page + viewport) — on connect or focus change. */
    private fun reflect(pane: PageCanvas) {
        val open = openJson(pane)
        bg { send(open) }
        for (i in pane.finishedView.pages.indices) queuePage(pane, i)
        sendView(pane)
    }

    private fun flushWet() {
        val meta = wetMeta ?: return
        if (wetBuf.isEmpty() && !wetReset) return
        val pts = ArrayList(wetBuf); wetBuf.clear()
        val reset = wetReset; wetReset = false
        lastWet = System.currentTimeMillis()
        bg { send(JSONObject(meta.toString()).put("t", "wetAdd").put("reset", reset).put("pts", ptsJson(pts))) }
    }

    // ---- PageCanvas.MirrorSink ----
    override fun paneOpened(pane: PageCanvas) { if (connected && pane === bound) reflect(pane) }
    override fun pageEdited(pane: PageCanvas, index: Int) { if (connected && pane === bound) queuePage(pane, index) }
    override fun wetStroke(pane: PageCanvas, page: Int, pts: List<PointF>, reset: Boolean, color: Int, widthPx: Float, hl: Boolean) {
        if (!connected || pane !== bound || cloud != null) return   // live strokes are LAN-only
        if (reset) { wetBuf.clear(); wetReset = true }
        wetBuf.addAll(pts)
        wetMeta = JSONObject().put("page", page).put("c", color).put("w", widthPx.toDouble()).put("h", hl)
        // At most one small update every 16 ms, carrying just the new points.
        main.removeCallbacks(wetFlush)
        val wait = 16 - (System.currentTimeMillis() - lastWet)
        if (wait <= 0) flushWet() else main.postDelayed(wetFlush, wait)
    }
    override fun wetCleared(pane: PageCanvas) {
        main.removeCallbacks(wetFlush); wetBuf.clear(); wetReset = false; wetMeta = null
        if (connected && pane === bound) bg { send(JSONObject().put("t", "wetClear")) }
    }
    override fun transformed(pane: PageCanvas) {
        if (!connected || pane !== bound) return
        val now = System.currentTimeMillis()
        if (now - lastView < 40) return
        lastView = now
        sendView(pane)
    }
}
