package com.engorg.inkpad

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.LeadingMarginSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * "Ask Claude" side panel docked on the right of the notebook. It snapshots the focused pane's page
 * (or every written page of the notebook), sends the images to Claude with the chosen mode (check my
 * work / hint / explain / review notes) and streams the feedback into a chat. Follow-up questions
 * continue the same conversation, and "Re-scan" appends a fresh image after you've fixed something.
 *
 * Uses the user's own Anthropic API key ([ClaudeAuth]); the first open shows the key setup instead.
 */
@SuppressLint("SetTextI18n")
class ClaudePanel(
    private val act: Activity,
    private val host: FrameLayout,
    private val focusedPane: () -> PageCanvas?,
) {
    private enum class Mode(val label: String, val instruction: String) {
        CHECK("Check my work",
            "Check my work. Verify it step by step and tell me whether it's right. If something is wrong, point to the first mistake (say where it is on the page), explain why it's wrong, and show the correct step."),
        HINT("Hint",
            "I'm stuck or unsure. Give me a hint for the next step without solving it for me. If I've already made a mistake, nudge me toward finding it myself."),
        EXPLAIN("Explain",
            "Explain the concepts and reasoning on this page so I understand them better. Clear up anything that looks confused."),
        REVIEW("Review notes",
            "Review these notes. Tell me what's missing, unclear or incorrect, and what would make them more useful to study from."),
    }

    private val dens = act.resources.displayMetrics.density
    private fun dp(v: Int) = (v * dens).toInt()
    private val main = Handler(Looper.getMainLooper())
    private val onSurface get() = AppTheme.text
    private val muted get() = Color.argb(0xA8, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))

    private var mode = Mode.CHECK
    private var wholeNotebook = false
    private val chat = ClaudeApi.ClaudeChat(SYSTEM_PROMPT)
    private var chatNotebookId: String? = null

    private val frame = LinearLayout(act).apply {
        orientation = LinearLayout.VERTICAL
        background = GradientDrawable().apply {
            cornerRadius = dp(20).toFloat(); setColor(AppTheme.surface)
            setStroke(dp(1), Color.argb(0x2A, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface)))
        }
        elevation = dp(14).toFloat()
        clipToOutline = true
        isClickable = true   // swallow touches so they never fall through to the page underneath
    }
    private val body = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
    private var built = false

    val isOpen: Boolean get() = frame.parent != null
    var onClosed: (() -> Unit)? = null

    fun toggle() { if (isOpen) close() else open() }

    fun open() {
        if (!built) build()
        if (frame.parent == null) {
            val w = minOf(dp(410), (act.resources.displayMetrics.widthPixels * 0.5f).toInt())
            host.addView(frame, FrameLayout.LayoutParams(w, MATCH_PARENT).apply {
                gravity = Gravity.END or Gravity.TOP; rightMargin = dp(10); bottomMargin = dp(10)
            })
            SystemBars.marginTopBelowStatusBar(frame, dp(76))   // clear of the floating toolbar
        }
        render()
    }

    fun close() {
        hideKeyboard()
        host.removeView(frame)
        onClosed?.invoke()
    }

    fun dispose() { chat.cancel() }

    // ---------- chrome ----------
    private fun build() {
        built = true
        frame.addView(LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(10), dp(8), dp(8))
            addView(ImageView(act).apply {
                setImageBitmap(Icons.bitmap(Icons.SPARKLE, dp(20))); setColorFilter(AppTheme.accent)
                layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply { rightMargin = dp(8) }
            })
            addView(TextView(act).apply { text = "Claude"; textSize = 16f; setTextColor(onSurface); setTypeface(null, Typeface.BOLD) },
                LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(smallBtn(Icons.ADD) { newChat() })
            addView(smallBtn(Icons.KEY) { showSetup(changing = true) })
            addView(smallBtn(Icons.CLOSE) { close() })
        })
        frame.addView(body, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    }

    private fun smallBtn(path: String, onClick: () -> Unit) = ImageButton(act).apply {
        setImageBitmap(Icons.bitmap(path, dp(18))); setColorFilter(onSurface)
        background = pill(AppTheme.elevated); scaleType = ImageView.ScaleType.FIT_CENTER; stateListAnimator = null
        val pd = dp(6); setPadding(pd, pd, pd, pd)
        layoutParams = LinearLayout.LayoutParams(dp(32), dp(32)).apply { leftMargin = dp(6) }
        setOnClickListener { onClick() }
    }

    private fun pill(color: Int, radius: Int = 16): Drawable {
        val ripple = Color.argb(0x3A, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))
        val bg = GradientDrawable().apply { cornerRadius = dp(radius).toFloat(); setColor(color) }
        val mask = GradientDrawable().apply { cornerRadius = dp(radius).toFloat(); setColor(Color.WHITE) }
        return RippleDrawable(ColorStateList.valueOf(ripple), bg, mask)
    }

    private fun chip(label: String, on: Boolean, onClick: () -> Unit) = TextView(act).apply {
        text = label; textSize = 13f; gravity = Gravity.CENTER; stateListAnimator = null
        background = pill(if (on) AppTheme.accent else AppTheme.elevated)
        setTextColor(if (on) AppTheme.onAccent() else onSurface)
        setPadding(dp(12), dp(7), dp(12), dp(7))
        layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = dp(6) }
        setOnClickListener { onClick() }
    }

    private fun chipRow(views: List<View>) = HorizontalScrollView(act).apply {
        isHorizontalScrollBarEnabled = false
        addView(LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; views.forEach { addView(it) } })
    }

    private fun input(hintText: String) = EditText(act).apply {
        hint = hintText; textSize = 14f
        setTextColor(onSurface); setHintTextColor(muted)
        background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(AppTheme.elevated) }
        setPadding(dp(12), dp(10), dp(12), dp(10))
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        maxLines = 4
    }

    private fun primaryButton(label: String, onClick: () -> Unit) = TextView(act).apply {
        text = label; textSize = 15f; gravity = Gravity.CENTER; setTypeface(null, Typeface.BOLD); stateListAnimator = null
        background = pill(AppTheme.accent, 14); setTextColor(AppTheme.onAccent())
        setPadding(dp(14), dp(12), dp(14), dp(12))
        setOnClickListener { onClick() }
    }

    private fun hideKeyboard() {
        (act.getSystemService(Activity.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(frame.windowToken, 0)
    }

    // ---------- views ----------
    private fun render() {
        if (!ClaudeAuth.connected(act)) { showSetup(changing = false); return }
        // A conversation is about one notebook; switching the focused notebook starts fresh.
        val nbId = focusedPane()?.notebookId()
        if (!chat.isEmpty && !chat.busy && nbId != chatNotebookId) resetChat()
        showChat()
    }

    private fun newChat() { resetChat(); if (ClaudeAuth.connected(act)) showChat() }

    private fun resetChat() {
        chat.cancel()
        streamingEntry = null; streamingView = null
        while (chat.history.length() > 0) chat.history.remove(chat.history.length() - 1)
        transcript.clear()
        chatNotebookId = null
    }

    /** API key + model setup (first run, or the key button to change / disconnect). */
    private fun showSetup(changing: Boolean) {
        body.removeAllViews()
        val col = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(4), dp(16), dp(16)) }
        body.addView(ScrollView(act).apply { addView(col) }, LinearLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        col.addView(TextView(act).apply {
            text = "Claude reads your handwriting and gives feedback on your work. It uses your own Anthropic API key, which stays encrypted on this tablet."
            textSize = 14f; setTextColor(onSurface); setLineSpacing(0f, 1.15f)
        })
        val connected = ClaudeAuth.connected(act)
        fun heading(t: String) = TextView(act).apply {
            text = t; textSize = 11f; setTextColor(muted); setTypeface(null, Typeface.BOLD); letterSpacing = 0.05f
            setPadding(0, dp(14), 0, dp(6))
        }
        col.addView(heading("ANTHROPIC API KEY"))
        if (connected) col.addView(TextView(act).apply {
            text = "✓ Your key is saved. To replace it, paste a new one below."; textSize = 13f; setTextColor(onSurface)
        }) else {
            // Spell out where the key comes from and where it goes.
            col.addView(TextView(act).apply {
                text = "1.  Tap “Get a key” below. It opens the Anthropic Console.\n2.  Sign in, then tap Create Key and copy it (it starts with sk-ant-).\n3.  Come back here, paste it in the box below and tap Connect."
                textSize = 13f; setTextColor(onSurface); setLineSpacing(0f, 1.25f)
            })
        }
        col.addView(TextView(act).apply {
            text = "Get a key  ↗"; textSize = 13.5f; setTextColor(AppTheme.accent); setTypeface(null, Typeface.BOLD)
            setPadding(dp(2), dp(10), 0, dp(2))
            setOnClickListener { runCatching { act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://console.anthropic.com/settings/keys"))) } }
        })
        col.addView(TextView(act).apply { text = "Paste your API key here:"; textSize = 13f; setTextColor(onSurface); setTypeface(null, Typeface.BOLD); setPadding(dp(2), dp(10), 0, 0) })
        val keyInput = input(if (connected) "Paste a new key to replace it" else "sk-ant-…").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; maxLines = 1
        }
        col.addView(keyInput, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) })

        col.addView(TextView(act).apply {
            text = "MODEL"; textSize = 11f; setTextColor(muted); setTypeface(null, Typeface.BOLD); letterSpacing = 0.05f
            setPadding(0, dp(12), 0, dp(6))
        })
        val modelCol = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        col.addView(modelCol)
        fun renderModels() {
            modelCol.removeAllViews()
            val cur = ClaudeAuth.model(act).id
            for (m in ClaudeAuth.MODELS) modelCol.addView(chip(m.label, m.id == cur) { ClaudeAuth.setModel(act, m.id); renderModels() }.apply {
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(6) }
            })
        }
        renderModels()

        col.addView(heading("EFFORT"))
        col.addView(TextView(act).apply {
            text = "How long Claude thinks before answering. Higher is more careful but slower and uses more of your API credit."
            textSize = 12.5f; setTextColor(muted); setPadding(0, 0, 0, dp(6))
        })
        col.addView(effortPicker(full = true))

        val status = TextView(act).apply { textSize = 13f; setTextColor(muted); setPadding(0, dp(8), 0, 0) }
        col.addView(status)
        col.addView(primaryButton(if (connected) "Save" else "Connect") {
            val key = keyInput.text.toString().trim()
            if (key.isEmpty()) { if (connected) { hideKeyboard(); render() } else status.text = "Paste your API key first."; return@primaryButton }
            status.text = "Checking the key…"
            ClaudeApi.validateKey(key) { err ->
                if (err != null) { status.text = err; return@validateKey }
                try { ClaudeAuth.saveKey(act, key) } catch (_: Exception) { status.text = "Couldn't store the key securely on this device."; return@validateKey }
                hideKeyboard(); render()
            }
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) })
        if (changing && connected) col.addView(TextView(act).apply {
            text = "Disconnect"; textSize = 13.5f; gravity = Gravity.CENTER; setTextColor(Color.rgb(0xE5, 0x3E, 0x3E))
            setPadding(0, dp(14), 0, dp(4))
            setOnClickListener { resetChat(); ClaudeAuth.disconnect(act); showSetup(changing = false) }
        })
    }

    /** Effort chips; [full] adds each level's description under the selected one. */
    private fun effortPicker(full: Boolean): View {
        val wrap = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        lateinit var draw: () -> Unit
        draw = {
            wrap.removeAllViews()
            val cur = ClaudeAuth.effort(act)
            wrap.addView(chipRow(ClaudeAuth.EFFORTS.map { e -> chip(e.label, e.id == cur.id) { ClaudeAuth.setEffort(act, e.id); draw() } }))
            if (full) wrap.addView(TextView(act).apply { text = cur.hint; textSize = 12f; setTextColor(muted); setPadding(dp(2), dp(4), 0, 0) })
        }
        draw()
        return wrap
    }

    // Transcript entries survive re-renders (closing and reopening the panel keeps the conversation).
    private class Entry(val fromUser: Boolean, var text: String, var error: Boolean = false)
    private val transcript = ArrayList<Entry>()
    private lateinit var transcriptCol: LinearLayout
    private lateinit var scroller: ScrollView
    private var streamingEntry: Entry? = null   // the reply being streamed right now
    private var streamingView: TextView? = null
    private var statusRow: View? = null

    private fun showChat() {
        body.removeAllViews()
        transcriptCol = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(2), dp(14), dp(10)) }
        scroller = ScrollView(act).apply { addView(transcriptCol); isFillViewport = true }
        body.addView(scroller, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        if (transcript.isEmpty()) transcriptCol.addView(TextView(act).apply {
            text = "Pick what you want, then scan. Claude sees the page exactly as written."
            textSize = 13.5f; setTextColor(muted); setPadding(dp(2), dp(6), dp(2), dp(6))
        })
        for (e in transcript) addEntryView(e).also { if (e === streamingEntry) streamingView = it }
        if (chat.busy) showStatus(if (streamingEntry == null) "Reading your page…" else null)

        val composer = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(12))
            background = GradientDrawable().apply { setColor(AppTheme.surface) }
        }
        body.addView(View(act).apply { setBackgroundColor(Color.argb(0x1E, Color.red(onSurface), Color.green(onSurface), Color.blue(onSurface))) },
            LinearLayout.LayoutParams(MATCH_PARENT, dp(1)))
        body.addView(composer, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        if (chat.isEmpty && !chat.busy) buildStartComposer(composer) else buildFollowUpComposer(composer)
        scrollToEnd()
    }

    /** First turn: mode + scope chips, an optional note, and the Scan button. */
    private fun buildStartComposer(c: LinearLayout) {
        lateinit var rebuild: () -> Unit
        val chips = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        c.addView(chips)
        rebuild = {
            chips.removeAllViews()
            chips.addView(chipRow(Mode.values().map { m -> chip(m.label, m == mode) { mode = m; rebuild() } }))
            chips.addView(chipRow(listOf(
                chip("This page", !wholeNotebook) { wholeNotebook = false; rebuild() },
                chip("Whole notebook", wholeNotebook) { wholeNotebook = true; rebuild() },
            )).apply { setPadding(0, dp(6), 0, 0) })
        }
        rebuild()
        c.addView(LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(8), 0, 0)
            addView(TextView(act).apply { text = "Effort"; textSize = 12f; setTextColor(muted); setPadding(dp(2), 0, dp(8), 0) })
            addView(effortPicker(full = false), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        })
        val note = input("Anything specific? (optional)")
        c.addView(note, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) })
        c.addView(primaryButton("Scan") {
            hideKeyboard()
            startScan(note.text.toString().trim())
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) })
    }

    /** Later turns: a follow-up question box, plus re-scanning the page after edits. */
    private fun buildFollowUpComposer(c: LinearLayout) {
        val q = input("Ask a follow-up…")
        val send = smallBtn(if (chat.busy) Icons.CLOSE else Icons.SEND) {
            if (chat.busy) { chat.cancel(); onStopped(); return@smallBtn }
            val t = q.text.toString().trim()
            if (t.isEmpty()) return@smallBtn
            hideKeyboard()
            sendTurn(JSONArray().put(textBlock(t)), t)
        }.apply { layoutParams = LinearLayout.LayoutParams(dp(40), dp(40)).apply { leftMargin = dp(8) } }
        c.addView(LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            addView(q, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(send)
        })
        c.addView(chipRow(listOf(
            chip("Re-scan page", false) { if (!chat.busy) rescan(q.text.toString().trim()) },
            chip("New check", false) { newChat() },
        )).apply { setPadding(0, dp(8), 0, 0) })
    }

    // ---------- turns ----------
    private fun textBlock(t: String) = JSONObject().put("type", "text").put("text", t)

    private fun startScan(note: String) {
        val pane = focusedPane() ?: return
        val snaps = snapshot(pane, wholeNotebook) ?: return
        chatNotebookId = pane.notebookId()
        val where = if (wholeNotebook) "the notebook \"${pane.notebook.title}\" (${snaps.size} written page${if (snaps.size == 1) "" else "s"}, in order)"
                    else "page ${pane.currentPage() + 1} of the notebook \"${pane.notebook.title}\""
        val prompt = buildString {
            append("This is ").append(where).append(". ").append(mode.instruction)
            if (note.isNotEmpty()) append("\n\nAlso: ").append(note)
        }
        val content = JSONArray()
        snaps.forEach { (pageNo, b64) ->
            if (snaps.size > 1) content.put(textBlock("Page $pageNo:"))
            content.put(imageBlock(b64))
        }
        content.put(textBlock(prompt))
        val label = "${mode.label} · " + (if (wholeNotebook) "whole notebook" else "page ${pane.currentPage() + 1}") +
            (if (note.isNotEmpty()) "\n$note" else "")
        sendTurn(content, label)
    }

    private fun rescan(note: String) {
        val pane = focusedPane() ?: return
        val snaps = snapshot(pane, false) ?: return
        val content = JSONArray().put(imageBlock(snaps[0].second))
            .put(textBlock("Here's page ${snaps[0].first} as it is now. Take another look." + if (note.isNotEmpty()) " $note" else ""))
        sendTurn(content, "Re-scanned page ${snaps[0].first}" + if (note.isNotEmpty()) "\n$note" else "")
    }

    private fun imageBlock(b64: String) = JSONObject().put("type", "image").put("source",
        JSONObject().put("type", "base64").put("media_type", "image/png").put("data", b64))

    private fun sendTurn(content: JSONArray, label: String) {
        val key = ClaudeAuth.apiKey(act) ?: run { showSetup(changing = false); return }
        if (chat.busy) return
        transcript.add(Entry(true, label))
        val reply = Entry(false, "")
        streamingEntry = null; streamingView = null
        chat.send(key, ClaudeAuth.model(act), ClaudeAuth.effort(act).id, content,
            onText = { t ->
                if (!chat.busy) return@send   // a late chunk from a reply that was just stopped
                reply.text = t
                if (streamingEntry == null) {
                    hideStatus()
                    transcript.add(reply)
                    streamingEntry = reply
                    streamingView = addEntryView(reply)
                    showStatus(null)
                } else streamingView?.text = markdown(t)
                scrollToEndIfNear()
            },
            onDone = { r ->
                if (!transcript.contains(reply)) transcript.add(reply)
                when {
                    r.error != null -> { reply.text = r.error; reply.error = true }
                    r.stopReason == "refusal" -> { reply.text = "Claude declined to answer this one. Try rephrasing, or ask about a different part of the page."; reply.error = true }
                    else -> {
                        reply.text = r.text.ifBlank { "(No reply text.)" }
                        if (r.stopReason == "max_tokens") reply.text += "\n\n_(Reply was cut short.)_"
                    }
                }
                streamingEntry = null; streamingView = null
                // A failed first turn never joined the history, so offer the Scan options again.
                showChat()
            })
        showChat()   // busy now, so this draws the user's bubble and the stop button
        showStatus("Reading your page…")
    }

    /** A stopped turn never joins the conversation, so take its question and partial reply off screen too. */
    private fun onStopped() {
        streamingEntry?.let { transcript.remove(it) }
        streamingEntry = null; streamingView = null
        if (transcript.lastOrNull()?.fromUser == true) transcript.removeAt(transcript.size - 1)
        showChat()
    }

    // ---------- page snapshot ----------
    /**
     * Render the current page (or every page with ink on it, capped at [MAX_PAGES]) to base64 PNGs, with
     * 1-based page numbers. The long edge stays at or under ~1568px, the size Claude reads at full
     * detail, so small handwriting stays legible without paying for pixels it would downscale anyway.
     */
    private fun snapshot(pane: PageCanvas, all: Boolean): List<Pair<Int, String>>? {
        val pages = pane.finishedView.pages
        val idx = if (all) pages.indices.filter { pages[it].recs.isNotEmpty() }.take(MAX_PAGES)
                  else listOf(pane.currentPage()).filter { it in pages.indices }
        if (idx.isEmpty()) { toastInPanel(if (all) "This notebook is empty." else "Nothing on this page yet."); return null }
        if (!all && pages[idx[0]].recs.isEmpty()) { toastInPanel("Nothing on this page yet."); return null }
        val s = (if (all && idx.size > 4) 1200f else 1568f) / FinishedStrokesView.PAGE_H
        val w = (FinishedStrokesView.PAGE_W * s).toInt(); val h = (FinishedStrokesView.PAGE_H * s).toInt()
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val out = ArrayList<Pair<Int, String>>()
        try {
            val canvas = Canvas(bmp)
            for (i in idx) {
                bmp.eraseColor(Color.WHITE)
                pane.finishedView.renderPageInto(canvas, i, s)
                val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
                out.add(i + 1 to Base64.encodeToString(bytes, Base64.NO_WRAP))
            }
        } finally { bmp.recycle() }
        return out
    }

    private fun toastInPanel(msg: String) = android.widget.Toast.makeText(act, msg, android.widget.Toast.LENGTH_SHORT).show()

    // ---------- transcript rendering ----------
    private fun addEntryView(e: Entry): TextView {
        val tv = TextView(act).apply {
            textSize = if (e.fromUser) 13.5f else 14.5f
            setLineSpacing(0f, 1.18f)
            setTextIsSelectable(!e.fromUser)
        }
        if (e.fromUser) {
            tv.text = e.text
            tv.setTextColor(AppTheme.onAccent())
            tv.background = GradientDrawable().apply { cornerRadius = dp(14).toFloat(); setColor(AppTheme.accent) }
            tv.setPadding(dp(12), dp(8), dp(12), dp(8))
            transcriptCol.addView(tv, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
                gravity = Gravity.END; topMargin = dp(10); leftMargin = dp(40)
            })
        } else {
            tv.text = markdown(e.text)
            tv.setTextColor(if (e.error) Color.rgb(0xE5, 0x3E, 0x3E) else onSurface)
            tv.setPadding(dp(2), dp(4), dp(2), dp(4))
            transcriptCol.addView(tv, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(10) })
        }
        return tv
    }

    /** A spinner + label while waiting; [label] null = just the spinner (reply is streaming). */
    private fun showStatus(label: String?) {
        hideStatus()
        val row = LinearLayout(act).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), dp(10), 0, dp(4))
            addView(ProgressBar(act).apply { isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(AppTheme.accent) },
                LinearLayout.LayoutParams(dp(18), dp(18)))
            if (label != null) addView(TextView(act).apply { text = label; textSize = 13f; setTextColor(muted); setPadding(dp(8), 0, 0, 0) })
        }
        statusRow = row
        transcriptCol.addView(row)
        scrollToEnd()
    }
    private fun hideStatus() { statusRow?.let { transcriptCol.removeView(it) }; statusRow = null }

    private fun scrollToEnd() = scroller.post { scroller.fullScroll(View.FOCUS_DOWN) }
    private fun scrollToEndIfNear() {
        val child = scroller.getChildAt(0) ?: return
        if (child.bottom - (scroller.scrollY + scroller.height) < dp(160)) scrollToEnd()
    }

    /**
     * Minimal Markdown → spans for the narrow panel: # headings, - / * bullets, **bold**, *italic*,
     * `code`. The system prompt asks Claude to stay inside this subset (and to write math in Unicode).
     */
    private fun markdown(src: String): CharSequence {
        val out = SpannableStringBuilder()
        val lines = src.replace("\r", "").split("\n")
        for ((li, raw) in lines.withIndex()) {
            var line = raw
            val start = out.length
            var heading = false
            var indent = 0
            val h = Regex("^#{1,6}\\s+").find(line)
            if (h != null) { heading = true; line = line.substring(h.range.last + 1) }
            else {
                val b = Regex("^(\\s*)[-*•]\\s+").find(line)
                if (b != null) { indent = 1 + b.groupValues[1].length / 2; line = "•  " + line.substring(b.range.last + 1) }
                else if (Regex("^\\s*\\d+[.)]\\s+").containsMatchIn(line)) indent = 1
            }
            appendInline(out, line)
            if (heading) {
                out.setSpan(StyleSpan(Typeface.BOLD), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                out.setSpan(RelativeSizeSpan(1.1f), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            if (li < lines.size - 1) out.append("\n")
            if (indent > 0) out.setSpan(LeadingMarginSpan.Standard(dp(6) * indent, dp(6) * indent + dp(12)), start, out.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
        }
        return out
    }

    private fun appendInline(out: SpannableStringBuilder, s: String) {
        val re = Regex("\\*\\*(.+?)\\*\\*|`([^`]+)`|(?<![\\w*])[*_]([^*_\\s][^*_]*?)[*_](?![\\w*])")
        var last = 0
        for (m in re.findAll(s)) {
            out.append(s, last, m.range.first)
            val st = out.length
            when {
                m.groups[1] != null -> { out.append(m.groupValues[1]); out.setSpan(StyleSpan(Typeface.BOLD), st, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                m.groups[2] != null -> { out.append(m.groupValues[2]); out.setSpan(TypefaceSpan("monospace"), st, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                else -> { out.append(m.groupValues[3]); out.setSpan(StyleSpan(Typeface.ITALIC), st, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            }
            last = m.range.last + 1
        }
        out.append(s, last, s.length)
    }

    companion object {
        private const val MAX_PAGES = 20

        private val SYSTEM_PROMPT = """
            You are a tutor inside EngInk, a handwriting notebook app on the student's tablet. You'll see images of their handwritten pages: usually engineering, math or science work, sometimes notes. Read the handwriting carefully, including diagrams, units and signs.

            Be specific and honest. When work is wrong, say exactly where (for example "the third line, where you distribute the −2") and why. When it's right, say so plainly and briefly say how you checked. If part of the page is illegible or ambiguous, say what you can't read instead of guessing. Lead with the verdict, then the detail.

            Your reply appears in a narrow side panel that only renders simple Markdown: short paragraphs, "-" bullets, numbered steps, **bold**, and "#" headings. Don't use tables or LaTeX. Write math inline with plain text and Unicode symbols (x², √, ∫, π, θ, Δ, ≤, ≈, →, v₀).
        """.trimIndent()
    }
}
