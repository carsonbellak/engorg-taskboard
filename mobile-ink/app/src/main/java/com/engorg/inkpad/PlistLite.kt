package com.engorg.inkpad

import android.util.Xml
import org.xmlpull.v1.XmlPullParser
import java.io.InputStream

/**
 * Tiny Apple XML-plist reader — just enough to walk Noteshelf's `Document.plist`.
 * Returns nested structures: LinkedHashMap<String,Any?> for <dict>, ArrayList<Any?> for <array>,
 * String / Long / Double / Boolean for scalars. Robust to the empty <array>/<true/> nesting the
 * page dicts contain (their `tags` arrays), which naive substring parsing would trip on.
 */
object PlistLite {

    @Suppress("UNCHECKED_CAST")
    fun parseDict(input: InputStream): Map<String, Any?> = (parse(input) as? Map<String, Any?>) ?: emptyMap()

    fun parse(input: InputStream): Any? {
        val p = Xml.newPullParser()
        p.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
        p.setInput(input, null)
        var evt = p.eventType
        while (evt != XmlPullParser.END_DOCUMENT) {
            if (evt == XmlPullParser.START_TAG && p.name == "plist") {
                // Advance to the plist's single child element and read it.
                var e = p.next()
                while (e != XmlPullParser.START_TAG && e != XmlPullParser.END_DOCUMENT) e = p.next()
                return if (e == XmlPullParser.START_TAG) readElement(p) else null
            }
            evt = p.next()
        }
        return null
    }

    /** Precondition: parser is on a START_TAG. Postcondition: parser is on that element's END_TAG. */
    private fun readElement(p: XmlPullParser): Any? = when (p.name) {
        "dict" -> {
            val map = LinkedHashMap<String, Any?>()
            while (true) {
                var e = p.next()
                while (e != XmlPullParser.START_TAG && e != XmlPullParser.END_TAG && e != XmlPullParser.END_DOCUMENT) e = p.next()
                if (e != XmlPullParser.START_TAG) break // </dict>
                val key = readText(p) // consumes </key>
                var e2 = p.next()
                while (e2 != XmlPullParser.START_TAG && e2 != XmlPullParser.END_DOCUMENT) e2 = p.next()
                if (e2 != XmlPullParser.START_TAG) break
                map[key] = readElement(p)
            }
            map
        }
        "array" -> {
            val list = ArrayList<Any?>()
            while (true) {
                var e = p.next()
                while (e != XmlPullParser.START_TAG && e != XmlPullParser.END_TAG && e != XmlPullParser.END_DOCUMENT) e = p.next()
                if (e != XmlPullParser.START_TAG) break // </array>
                list.add(readElement(p))
            }
            list
        }
        "true" -> { skipToEndTag(p); true }
        "false" -> { skipToEndTag(p); false }
        "integer" -> readText(p).trim().toLongOrNull() ?: 0L
        "real" -> readText(p).trim().toDoubleOrNull() ?: 0.0
        "string" -> readText(p)
        else -> readText(p) // data / date / unknown → raw text
    }

    /** Reads text content of the current element and consumes through its END_TAG. */
    private fun readText(p: XmlPullParser): String {
        val sb = StringBuilder()
        while (true) {
            when (p.next()) {
                XmlPullParser.TEXT -> sb.append(p.text)
                XmlPullParser.END_TAG, XmlPullParser.END_DOCUMENT -> return sb.toString()
                else -> { /* ignore */ }
            }
        }
    }

    private fun skipToEndTag(p: XmlPullParser) {
        while (true) {
            val e = p.next()
            if (e == XmlPullParser.END_TAG || e == XmlPullParser.END_DOCUMENT) return
        }
    }
}
