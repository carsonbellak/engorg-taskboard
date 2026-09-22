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
    private var bound: PageCanvas? = null
    private var pairCode = ""
    @Volatile var connected = false; private set
    var peerLabel = ""; private set

    /** (connected, message) — set by the UI to reflect connection state on a button/dialog. */
    var onState: ((Boolean, String) -> Unit)? = null

    private var lastWet = 0L
    private var lastView = 0L

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
        ws = null; connected = false
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
    private fun send(o: JSONObject) { try { ws?.send(o.toString()) } catch (_: Exception) {} }

    private fun ptsJson(pts: List<PointF>): JSONArray {
        val a = JSONArray()
        for (p in pts) a.put(JSONArray().put(p.x.toDouble()).put(p.y.toDouble()))
        return a
    }

    private fun openJson(pane: PageCanvas): JSONObject = JSONObject()
        .put("t", "open").put("id", pane.notebook.id).put("title", pane.notebook.title)
        .put("paper", pane.finishedView.paperStyle.name).put("pageColor", pane.finishedView.pageColor)
        .put("pageCount", pane.finishedView.pages.size)

    private fun pageJson(pane: PageCanvas, index: Int): JSONObject {
        val recs = JSONArray()
        val list = pane.finishedView.pages.getOrNull(index)?.recs ?: arrayListOf()
        for (rec in list) {
            val o = JSONObject().put("c", rec.color).put("w", rec.widthPx.toDouble()).put("h", rec.highlighter)
            val segs = JSONArray()
            val shape = rec.shape
            if (shape != null) { o.put("k", "s"); for (poly in shape.polylines()) segs.put(ptsJson(poly)) }
            else { o.put("k", "f"); segs.put(ptsJson(rec.points)) }
            o.put("segs", segs)
            recs.put(o)
        }
        return JSONObject().put("t", "page").put("index", index).put("recs", recs)
    }

    private fun sendView(pane: PageCanvas) {
        send(JSONObject().put("t", "view").put("scale", pane.scale.toDouble())
            .put("tx", pane.tx.toDouble()).put("ty", pane.ty.toDouble()).put("page", pane.currentPage()))
    }

    /** Push the whole current notebook (meta + every page + viewport) — on connect or focus change. */
    private fun reflect(pane: PageCanvas) {
        send(openJson(pane))
        for (i in pane.finishedView.pages.indices) send(pageJson(pane, i))
        sendView(pane)
    }

    // ---- PageCanvas.MirrorSink ----
    override fun paneOpened(pane: PageCanvas) { if (connected && pane === bound) reflect(pane) }
    override fun pageEdited(pane: PageCanvas, index: Int) { if (connected && pane === bound) send(pageJson(pane, index)) }
    override fun wetStroke(pane: PageCanvas, page: Int, pts: List<PointF>, color: Int, widthPx: Float, hl: Boolean) {
        if (!connected || pane !== bound) return
        val now = System.currentTimeMillis()
        if (now - lastWet < 16) return
        lastWet = now
        send(JSONObject().put("t", "wet").put("page", page).put("pts", ptsJson(pts)).put("c", color).put("w", widthPx.toDouble()).put("h", hl))
    }
    override fun wetCleared(pane: PageCanvas) { if (connected && pane === bound) send(JSONObject().put("t", "wetClear")) }
    override fun transformed(pane: PageCanvas) {
        if (!connected || pane !== bound) return
        val now = System.currentTimeMillis()
        if (now - lastView < 40) return
        lastView = now
        sendView(pane)
    }
}
