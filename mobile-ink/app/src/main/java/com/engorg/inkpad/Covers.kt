package com.engorg.inkpad

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.LinearGradient
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.Drawable
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/**
 * Notebook cover catalog. Every cover is a small palette + a [Pattern] that [CoverDrawable] draws
 * procedurally, so covers stay crisp at any size (library card or picker thumbnail) and add nothing
 * to the APK. A notebook stores the cover's [Cover.id] as `coverStyle` and its [Cover.base] as
 * `coverColor` (still used for the little color dots in lists, and as the fallback for notebooks
 * made before the catalog existed — see [resolve]).
 */
object Covers {

    enum class Pattern {
        SOLID, LINEN, STRIPES, DIAGONAL, PINSTRIPE, POLKA, GRAPH, BLUEPRINT, CIRCUIT, TOPO,
        CHEVRON, WAVES, RINGS, TRIANGLES, HONEYCOMB, HERRINGBONE, BAND, MARBLE, TERRAZZO, STARS,
        SUNBURST, MOUNTAINS, PLAID, CHECK, CORNERS, GRADIENT, SPLIT, STRAP, CONFETTI,
    }

    data class Cover(
        val id: String,
        val name: String,
        val pattern: Pattern,
        val base: Int,
        val accent: Int,
        val third: Int = accent,
    ) {
        /** The color the title sits on (bottom of the card) — decides light vs dark title text. */
        val titleBg: Int get() = when (pattern) {
            Pattern.MOUNTAINS -> shade(accent, -0.35f)
            Pattern.SPLIT -> accent
            Pattern.GRADIENT -> mix(base, accent, 0.6f)
            else -> base
        }
        /** True when the cover is pale enough that the title/chrome should be dark ink, not white. */
        val isLight: Boolean get() = luminance(titleBg) > 0.6f
    }

    private fun hex(h: Int) = Color.rgb((h shr 16) and 0xFF, (h shr 8) and 0xFF, h and 0xFF)
    private fun c(id: String, name: String, p: Pattern, base: Int, accent: Int, third: Int = accent) =
        Cover(id, name, p, hex(base), hex(accent), hex(third))

    val ALL: List<Cover> = listOf(
        // Classic leather — the original nine colors keep their exact values so old notebooks map onto them.
        c("classic-cobalt", "Cobalt", Pattern.SOLID, 0x2947C9, 0x1B2F8A),
        c("classic-azure", "Azure", Pattern.SOLID, 0x1E88E5, 0x125A9C),
        c("classic-teal", "Teal", Pattern.SOLID, 0x00897B, 0x005A50),
        c("classic-forest", "Forest", Pattern.SOLID, 0x2E7D32, 0x1B4D1E),
        c("classic-orange", "Tangerine", Pattern.SOLID, 0xF57C00, 0xA65400),
        c("classic-crimson", "Crimson", Pattern.SOLID, 0xDC2650, 0x931835),
        c("classic-purple", "Orchid", Pattern.SOLID, 0x8E24AA, 0x5E1871),
        c("classic-violet", "Violet", Pattern.SOLID, 0x5E35B1, 0x3E2376),
        c("classic-graphite", "Graphite", Pattern.SOLID, 0x454B55, 0x2C3037),
        c("classic-midnight", "Midnight", Pattern.SOLID, 0x23262E, 0x15171C),
        c("classic-oxblood", "Oxblood", Pattern.SOLID, 0x7B1E2B, 0x4E121B),
        c("classic-kraft", "Kraft", Pattern.SOLID, 0xB48A5A, 0x8A673F),
        // Cloth-bound
        c("linen-navy", "Navy Linen", Pattern.LINEN, 0x1F3A5F, 0x0F2240),
        c("linen-sage", "Sage Linen", Pattern.LINEN, 0x6F8F73, 0x4D6A51),
        c("linen-rose", "Rose Linen", Pattern.LINEN, 0xC2707C, 0x8E4C57),
        c("linen-sand", "Sand Linen", Pattern.LINEN, 0xDCC8A4, 0xB59F78),
        c("linen-slate", "Slate Linen", Pattern.LINEN, 0x4A5568, 0x2F3746),
        // Stripes
        c("stripe-breton", "Breton", Pattern.STRIPES, 0xF4EFE4, 0x1E3A5F),
        c("stripe-mint", "Mint Stripe", Pattern.STRIPES, 0x2BA58B, 0x7FD8C2),
        c("diag-candy", "Candy Stripe", Pattern.DIAGONAL, 0xE53950, 0xF7DCE0),
        c("diag-hazard", "Hazard Tape", Pattern.DIAGONAL, 0xF2B705, 0x24262B),
        c("diag-dusk", "Dusk Stripe", Pattern.DIAGONAL, 0x3B2F63, 0x54458A),
        c("pin-charcoal", "Charcoal Pinstripe", Pattern.PINSTRIPE, 0x2D3036, 0x7A818C),
        c("pin-navy", "Navy Pinstripe", Pattern.PINSTRIPE, 0x1B2A4A, 0x5B7FB8),
        c("herring-tweed", "Tweed", Pattern.HERRINGBONE, 0x6B5A48, 0xA8957C),
        c("herring-steel", "Steel Weave", Pattern.HERRINGBONE, 0x3C4654, 0x6E7C90),
        // Dots & checks
        c("polka-cherry", "Cherry Polka", Pattern.POLKA, 0xB71C1C, 0xF6D5D5),
        c("polka-sky", "Sky Polka", Pattern.POLKA, 0x2F6FB3, 0xBFDBF7),
        c("polka-mustard", "Mustard Polka", Pattern.POLKA, 0xD49A1E, 0x5A3E0A),
        c("plaid-tartan", "Tartan", Pattern.PLAID, 0x9E1B22, 0x123B2A, 0xE9C46A),
        c("plaid-flannel", "Flannel", Pattern.PLAID, 0x2F5233, 0x16261A, 0xC7B07A),
        c("plaid-highland", "Highland", Pattern.PLAID, 0x1F3B63, 0x0D1E36, 0x6FA86A),
        c("check-buffalo", "Buffalo Check", Pattern.CHECK, 0xB3202A, 0x1A1A1E),
        c("check-gingham", "Gingham", Pattern.CHECK, 0x4E7FC2, 0x1E3D6B),
        // Engineering
        c("graph-green", "Engineer's Pad", Pattern.GRAPH, 0x2F5D50, 0x9CCFB6),
        c("graph-amber", "Amber Grid", Pattern.GRAPH, 0x3A2F25, 0xE0A458),
        c("blueprint", "Blueprint", Pattern.BLUEPRINT, 0x1A4D8F, 0xCFE2FF),
        c("blueprint-night", "Night Draft", Pattern.BLUEPRINT, 0x1D2433, 0x8FB8E8),
        c("circuit-fr4", "Circuit Board", Pattern.CIRCUIT, 0x0F5132, 0xD4A537),
        c("circuit-osh", "Purple PCB", Pattern.CIRCUIT, 0x4B2C7A, 0xE0B84D),
        c("circuit-blue", "Blue PCB", Pattern.CIRCUIT, 0x163E73, 0xC9D3DE),
        c("topo-earth", "Topo Earth", Pattern.TOPO, 0x5B4A32, 0xD3BE8E),
        c("topo-ocean", "Topo Ocean", Pattern.TOPO, 0x0E4C5A, 0x7FC6CF),
        c("honey", "Honeycomb", Pattern.HONEYCOMB, 0xC98A16, 0xF4C55B),
        c("hex-steel", "Hex Steel", Pattern.HONEYCOMB, 0x37424F, 0x6D7F94),
        // Geometric
        c("chevron-coral", "Coral Chevron", Pattern.CHEVRON, 0xE8604F, 0xFFD9D1),
        c("chevron-slate", "Slate Chevron", Pattern.CHEVRON, 0x3F4B5B, 0x8796AA),
        c("tri-teal", "Teal Mosaic", Pattern.TRIANGLES, 0x146C70, 0x1F9AA0, 0x0B4648),
        c("tri-sunset", "Sunset Mosaic", Pattern.TRIANGLES, 0xC2410C, 0xF59E0B, 0x9F1239),
        c("tri-mono", "Mono Mosaic", Pattern.TRIANGLES, 0x3A3F47, 0x5A616C, 0x272B31),
        c("rings-ocean", "Ripple", Pattern.RINGS, 0x1565A8, 0x4FA3E0, 0x0D4677),
        c("rings-retro", "Retro Rings", Pattern.RINGS, 0xD9622B, 0xF2A541, 0x8C2F16),
        c("waves-ocean", "Ocean Waves", Pattern.WAVES, 0x0B6E99, 0x7FD1F0, 0x3FA4CF),
        c("waves-sunset", "Sunset Waves", Pattern.WAVES, 0xB4415B, 0xF6A38B, 0xE07A6C),
        c("split-ocean", "Colorblock Sea", Pattern.SPLIT, 0x2D9CDB, 0x1B4F8C, 0xF2F2F2),
        c("split-citrus", "Colorblock Citrus", Pattern.SPLIT, 0xF2C94C, 0xD9562B, 0xFFF8E1),
        // Speckles
        c("marble-composition", "Composition", Pattern.MARBLE, 0x26272B, 0xE9E9E9),
        c("marble-ink", "Ink Marble", Pattern.MARBLE, 0x1E3F7A, 0xB9CCF2),
        c("marble-rose", "Rose Marble", Pattern.MARBLE, 0x8A3B52, 0xF3C6D2),
        c("terrazzo-cream", "Terrazzo", Pattern.TERRAZZO, 0xEDE6DA, 0xD9653B, 0x2F6E73),
        c("terrazzo-night", "Night Terrazzo", Pattern.TERRAZZO, 0x2A2E36, 0xE9B44C, 0x6FB3B8),
        c("confetti-party", "Confetti", Pattern.CONFETTI, 0x3D2C8D, 0xFFC857, 0x4FD1C5),
        c("confetti-sprinkles", "Sprinkles", Pattern.CONFETTI, 0xF7D9E3, 0xE5487F, 0x3A86FF),
        // Scenes
        c("stars-night", "Night Sky", Pattern.STARS, 0x151B3D, 0xFFF3C4),
        c("stars-galaxy", "Galaxy", Pattern.STARS, 0x3A1C5C, 0xF8D9FF),
        c("sun-retro", "Retro Sun", Pattern.SUNBURST, 0xE8692E, 0xF59E4C, 0xFFD166),
        c("sun-teal", "Teal Burst", Pattern.SUNBURST, 0x0F766E, 0x14A098, 0xFDE68A),
        c("mtn-alpine", "Alpine", Pattern.MOUNTAINS, 0x8CC4E8, 0x3D6A8C, 0xFFF4C2),
        c("mtn-dusk", "Dusk Peaks", Pattern.MOUNTAINS, 0xF0A07A, 0x5B3A6E, 0xFFE0A3),
        c("mtn-forest", "Pine Ridge", Pattern.MOUNTAINS, 0xC9DCC3, 0x2F5A3A, 0xF6F1D3),
        // Gradients
        c("grad-aurora", "Aurora", Pattern.GRADIENT, 0x0F766E, 0x6D28D9, 0x1E3A8A),
        c("grad-peach", "Peach", Pattern.GRADIENT, 0xF97362, 0xDB2777, 0x7C2D92),
        c("grad-lagoon", "Lagoon", Pattern.GRADIENT, 0x0EA5E9, 0x0D9488, 0x14532D),
        c("grad-ember", "Ember", Pattern.GRADIENT, 0xF59E0B, 0xDC2626, 0x7F1D1D),
        // Bound books
        c("band-field", "Field Book", Pattern.BAND, 0xA67B4E, 0x2A2A2E, 0xE8D9B5),
        c("band-navy", "Navy Band", Pattern.BAND, 0x1E3A5F, 0xEDE3CB, 0xC9A227),
        c("band-sage", "Sage Band", Pattern.BAND, 0x56735C, 0xF0E8D6, 0x2E3F31),
        c("corners-ledger", "Ledger", Pattern.CORNERS, 0x24513F, 0x6B4226, 0xC9A227),
        c("corners-library", "Library", Pattern.CORNERS, 0x6E1F2A, 0x2C1A12, 0xC9A227),
        c("strap-black", "Moleskin", Pattern.STRAP, 0x25272C, 0x101114),
        c("strap-tan", "Saddle", Pattern.STRAP, 0xA0673A, 0x4A2C17),
        c("strap-red", "Scarlet Strap", Pattern.STRAP, 0xB3262F, 0x2A1215),
    )

    private val byId = ALL.associateBy { it.id }

    val DEFAULT: Cover = ALL.first()

    /** The cover a notebook should show: its saved style, else the classic solid matching its color. */
    fun resolve(id: String?, color: Int): Cover =
        id?.let { byId[it] }
            ?: ALL.firstOrNull { it.pattern == Pattern.SOLID && it.base == color }
            ?: Cover("custom", "Custom", Pattern.SOLID, color, shade(color, -0.3f))

    // ---- color helpers ----
    /** Shift a color toward white (f>0) or black (f<0) by fraction |f|. */
    fun shade(c: Int, f: Float): Int = if (f >= 0)
        Color.rgb(
            (Color.red(c) + (255 - Color.red(c)) * f).toInt(),
            (Color.green(c) + (255 - Color.green(c)) * f).toInt(),
            (Color.blue(c) + (255 - Color.blue(c)) * f).toInt(),
        ) else Color.rgb(
            (Color.red(c) * (1 + f)).toInt(),
            (Color.green(c) * (1 + f)).toInt(),
            (Color.blue(c) * (1 + f)).toInt(),
        )

    fun mix(a: Int, b: Int, t: Float): Int = Color.rgb(
        (Color.red(a) + (Color.red(b) - Color.red(a)) * t).toInt(),
        (Color.green(a) + (Color.green(b) - Color.green(a)) * t).toInt(),
        (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t).toInt(),
    )

    fun luminance(c: Int): Float = (0.299f * Color.red(c) + 0.587f * Color.green(c) + 0.114f * Color.blue(c)) / 255f

    fun withAlpha(c: Int, a: Int): Int = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))
}

/**
 * Draws a [Covers.Cover]: base shading, the pattern, then a bound "spine" down the left edge.
 * Patterns are laid out in a 100-unit-wide space scaled to the bounds, so a picker thumbnail is a
 * faithful miniature of the library card. Seeded randomness keeps speckle patterns stable.
 * Pair with `clipToOutline = true` on the host view for the rounded corners.
 */
class CoverDrawable(private val cover: Covers.Cover, private val radiusPx: Float, private val drawSpine: Boolean = true) : Drawable() {

    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()

    override fun getOutline(outline: Outline) {
        outline.setRoundRect(bounds, radiusPx)
    }

    override fun draw(canvas: Canvas) {
        val b = bounds
        if (b.width() <= 0 || b.height() <= 0) return
        val k = b.width() / 100f
        val h = b.height() / k
        canvas.save()
        canvas.clipRect(b)
        canvas.translate(b.left.toFloat(), b.top.toFloat())
        canvas.scale(k, k)
        val rnd = Random(cover.id.hashCode())

        drawBase(canvas, h)
        drawPattern(canvas, h, rnd)
        grain(canvas, h, rnd)
        if (drawSpine) {
            // Binding: a darkened strip with a thin highlight seam, laid over the pattern.
            fill(Color.argb(0x48, 0, 0, 0)); canvas.drawRect(0f, 0f, 4.7f, h, p)
            fill(Color.argb(0x26, 255, 255, 255)); canvas.drawRect(4.7f, 0f, 5.4f, h, p)
        }
        canvas.restore()
    }

    // ---- paint helpers ----
    private fun fill(color: Int, alpha: Int = Color.alpha(color)) {
        p.shader = null; p.style = Paint.Style.FILL; p.color = Covers.withAlpha(color, alpha)
    }
    private fun stroke(color: Int, width: Float, alpha: Int = Color.alpha(color)) {
        p.shader = null; p.style = Paint.Style.STROKE; p.strokeWidth = width; p.color = Covers.withAlpha(color, alpha)
        p.strokeCap = Paint.Cap.ROUND; p.strokeJoin = Paint.Join.ROUND
    }

    private fun drawBase(c: Canvas, h: Float) {
        val base = cover.base
        p.style = Paint.Style.FILL
        p.shader = if (cover.pattern == Covers.Pattern.GRADIENT)
            LinearGradient(0f, 0f, 100f, h, intArrayOf(cover.base, cover.accent, cover.third), null, Shader.TileMode.CLAMP)
        else
            LinearGradient(0f, 0f, 0f, h, intArrayOf(Covers.shade(base, 0.12f), base, Covers.shade(base, -0.14f)), null, Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, 100f, h, p)
        p.shader = null
    }

    /** Faint leather/paper grain so even flat covers have a little tooth. */
    private fun grain(c: Canvas, h: Float, rnd: Random) {
        val n = (h * 2.2f).toInt()
        for (i in 0 until n) {
            fill(if (rnd.nextBoolean()) Color.WHITE else Color.BLACK, 0x0E)
            c.drawCircle(rnd.nextFloat() * 100f, rnd.nextFloat() * h, 0.25f + rnd.nextFloat() * 0.45f, p)
        }
    }

    private fun drawPattern(c: Canvas, h: Float, rnd: Random) {
        val a = cover.accent; val t = cover.third; val base = cover.base
        when (cover.pattern) {
            Covers.Pattern.SOLID -> {
                // A soft debossed frame, like a stamped leather cover.
                stroke(Color.BLACK, 0.6f, 0x24); c.drawRoundRect(RectF(10f, 6f, 94f, h - 6f), 2f, 2f, p)
                stroke(Color.WHITE, 0.4f, 0x18); c.drawRoundRect(RectF(10.6f, 6.6f, 94.6f, h - 5.4f), 2f, 2f, p)
            }
            Covers.Pattern.LINEN -> {
                var y = 0f
                while (y < h) { stroke(if ((y * 10).toInt() % 2 == 0) Color.WHITE else Color.BLACK, 0.32f, 0x16); c.drawLine(0f, y, 100f, y, p); y += 1.1f }
                var x = 0f
                while (x < 100f) { stroke(if ((x * 10).toInt() % 2 == 0) Color.BLACK else Color.WHITE, 0.32f, 0x12); c.drawLine(x, 0f, x, h, p); x += 1.1f }
            }
            Covers.Pattern.STRIPES -> {
                fill(a); var y = 3f
                while (y < h) { c.drawRect(0f, y, 100f, y + 4.5f, p); y += 11f }
            }
            Covers.Pattern.DIAGONAL -> {
                c.save(); c.rotate(-35f, 50f, h / 2f)
                fill(a); var x = -h
                while (x < 100f + h) { c.drawRect(x, -h, x + 7f, h * 2f, p); x += 15f }
                c.restore()
            }
            Covers.Pattern.PINSTRIPE -> {
                stroke(a, 0.45f, 0xB0); var x = 3f
                while (x < 100f) { c.drawLine(x, 0f, x, h, p); x += 5.5f }
            }
            Covers.Pattern.HERRINGBONE -> {
                stroke(a, 0.9f, 0x80); var col = 0
                var x = 0f
                while (x < 100f) {
                    c.save(); c.clipRect(x, 0f, x + 8f, h)
                    var y = -10f
                    while (y < h + 10f) {
                        if (col % 2 == 0) c.drawLine(x, y, x + 8f, y + 6f, p) else c.drawLine(x, y + 6f, x + 8f, y, p)
                        y += 2.6f
                    }
                    c.restore(); x += 8f; col++
                }
            }
            Covers.Pattern.POLKA -> {
                fill(a); var row = 0; var y = 4f
                while (y < h + 6f) {
                    var x = if (row % 2 == 0) 4f else 10f
                    while (x < 106f) { c.drawCircle(x, y, 2.6f, p); x += 12f }
                    y += 10f; row++
                }
            }
            Covers.Pattern.PLAID -> {
                fill(a, 0x70); var v = 0f
                while (v < 110f) { c.drawRect(v, 0f, v + 12f, h, p); v += 28f }
                v = 0f
                while (v < h + 10f) { c.drawRect(0f, v, 100f, v + 12f, p); v += 28f }
                stroke(t, 1.1f, 0xC0); v = 19f
                while (v < 110f) { c.drawLine(v, 0f, v, h, p); v += 28f }
                v = 19f
                while (v < h + 10f) { c.drawLine(0f, v, 100f, v, p); v += 28f }
                stroke(Color.BLACK, 0.3f, 0x22); v = 0f
                while (v < 100f + h) { c.drawLine(v, 0f, v - h, h, p); v += 1.6f } // twill
            }
            Covers.Pattern.CHECK -> {
                fill(a, 0x78); var v = 0f
                while (v < 110f) { c.drawRect(v, 0f, v + 11f, h, p); v += 22f }
                v = 0f
                while (v < h + 10f) { c.drawRect(0f, v, 100f, v + 11f, p); v += 22f }
            }
            Covers.Pattern.GRAPH -> grid(c, h, a)
            Covers.Pattern.BLUEPRINT -> {
                grid(c, h, a)
                val top = h * 0.36f
                stroke(a, 0.8f, 0xE0)
                c.drawCircle(60f, top, 15f, p); c.drawCircle(60f, top, 6f, p)
                for (i in 0 until 6) { val ang = i * PI / 3; c.drawCircle(60f + (10.5f * cos(ang)).toFloat(), top + (10.5f * sin(ang)).toFloat(), 1.4f, p) }
                stroke(a, 0.4f, 0xB0)
                c.drawLine(40f, top, 80f, top, p); c.drawLine(60f, top - 20f, 60f, top + 20f, p)
                // Dimension line with ticks above the part.
                c.drawLine(45f, top - 21f, 75f, top - 21f, p)
                c.drawLine(45f, top - 23f, 45f, top - 17f, p); c.drawLine(75f, top - 23f, 75f, top - 17f, p)
                stroke(a, 0.8f, 0xE0)
                c.drawRect(14f, top + 22f, 40f, top + 34f, p)
                c.drawLine(14f, top + 28f, 40f, top + 28f, p)
            }
            Covers.Pattern.CIRCUIT -> {
                val traceW = 1.1f
                for (i in 0 until 10) {
                    var x = -2f; var y = 4f + rnd.nextFloat() * (h - 8f)
                    path.reset(); path.moveTo(x, y)
                    val segs = 2 + rnd.nextInt(3)
                    for (s in 0 until segs) {
                        x += 8f + rnd.nextFloat() * 18f; path.lineTo(x, y)
                        val d = (if (rnd.nextBoolean()) 1 else -1) * (4f + rnd.nextFloat() * 8f)
                        x += kotlin.math.abs(d); y = (y + d).coerceIn(3f, h - 3f); path.lineTo(x, y)
                    }
                    x += 6f; path.lineTo(x, y)
                    stroke(a, traceW, 0xD0); c.drawPath(path, p)
                    fill(a, 0xE0); c.drawCircle(x, y, 2.1f, p)
                    fill(base); c.drawCircle(x, y, 0.8f, p)
                }
                // An IC package with pins.
                val l = 56f; val tp = h * 0.18f
                for (i in 0 until 5) { stroke(a, 0.9f, 0xE0); val px = l + 3f + i * 5f; c.drawLine(px, tp - 3f, px, tp + 21f, p) }
                fill(Color.rgb(0x1C, 0x1E, 0x22)); c.drawRoundRect(RectF(l, tp, l + 26f, tp + 18f), 1.2f, 1.2f, p)
                fill(Color.WHITE, 0x40); c.drawCircle(l + 3f, tp + 3f, 1f, p)
                // Scattered vias.
                for (i in 0 until 14) {
                    val vx = rnd.nextFloat() * 100f; val vy = rnd.nextFloat() * h
                    fill(a, 0xB0); c.drawCircle(vx, vy, 1.1f, p); fill(base); c.drawCircle(vx, vy, 0.45f, p)
                }
            }
            Covers.Pattern.TOPO -> {
                val cx = 68f; val cy = h * 0.3f
                val ph1 = rnd.nextFloat() * 6f; val ph2 = rnd.nextFloat() * 6f
                var r = 5f; var ring = 0
                while (r < 130f) {
                    path.reset()
                    for (deg in 0..360 step 8) {
                        val th = deg * PI / 180
                        val rr = r * (1f + 0.16f * sin(3 * th + ph1).toFloat() + 0.07f * sin(5 * th + ph2).toFloat())
                        val px = cx + (rr * cos(th)).toFloat(); val py = cy + (rr * sin(th)).toFloat() * 0.9f
                        if (deg == 0) path.moveTo(px, py) else path.lineTo(px, py)
                    }
                    path.close()
                    stroke(a, if (ring % 5 == 4) 0.9f else 0.45f, if (ring % 5 == 4) 0xC0 else 0x80)
                    c.drawPath(path, p)
                    r += 5.5f; ring++
                }
            }
            Covers.Pattern.HONEYCOMB -> {
                val r = 7f; val w = r * 1.732f
                stroke(a, 0.9f, 0xB0); var row = 0; var y = 0f
                while (y < h + r) {
                    var x = if (row % 2 == 0) 0f else w / 2f
                    while (x < 100f + w) { hex(c, x, y, r); x += w }
                    y += r * 1.5f; row++
                }
            }
            Covers.Pattern.CHEVRON -> {
                stroke(a, 3.2f); p.strokeJoin = Paint.Join.MITER; p.strokeCap = Paint.Cap.BUTT
                var y = 2f
                while (y < h + 10f) {
                    path.reset(); path.moveTo(-6f, y + 5f)
                    var x = -6f; var up = true
                    while (x < 110f) { x += 6f; path.lineTo(x, if (up) y else y + 5f); up = !up }
                    c.drawPath(path, p); y += 11f
                }
            }
            Covers.Pattern.WAVES -> {
                var y = 4f; var row = 0
                while (y < h + 6f) {
                    path.reset()
                    var x = 0f; path.moveTo(0f, y)
                    while (x <= 100f) { path.lineTo(x, y + 2.4f * sin(x / 20f * 2 * PI + row).toFloat()); x += 1.5f }
                    stroke(if (row % 2 == 0) a else t, 1.5f, 0xC8); c.drawPath(path, p)
                    y += 8f; row++
                }
            }
            Covers.Pattern.RINGS -> {
                var r = 6f; var i = 0
                while (r < 170f) { stroke(if (i % 2 == 0) a else t, 2.4f, 0xB0); c.drawCircle(100f, h, r, p); r += 7f; i++ }
            }
            Covers.Pattern.TRIANGLES -> {
                val s = 20f; val cols = listOf(base, a, t, Covers.shade(base, 0.18f), Covers.shade(a, -0.15f))
                var y = 0f
                while (y < h) {
                    var x = 0f
                    while (x < 100f) {
                        val diag = rnd.nextBoolean()
                        fill(cols[rnd.nextInt(cols.size)])
                        path.reset()
                        if (diag) { path.moveTo(x, y); path.lineTo(x + s, y); path.lineTo(x, y + s) } else { path.moveTo(x, y); path.lineTo(x + s, y); path.lineTo(x + s, y + s) }
                        path.close(); c.drawPath(path, p)
                        fill(cols[rnd.nextInt(cols.size)])
                        path.reset()
                        if (diag) { path.moveTo(x + s, y); path.lineTo(x + s, y + s); path.lineTo(x, y + s) } else { path.moveTo(x, y); path.lineTo(x + s, y + s); path.lineTo(x, y + s) }
                        path.close(); c.drawPath(path, p)
                        x += s
                    }
                    y += s
                }
                stroke(Color.WHITE, 0.3f, 0x22)
                var g = 0f; while (g < 100f) { c.drawLine(g, 0f, g, h, p); g += s }
                g = 0f; while (g < h) { c.drawLine(0f, g, 100f, g, p); g += s }
            }
            Covers.Pattern.SPLIT -> {
                path.reset(); path.moveTo(0f, h * 0.62f); path.lineTo(100f, h * 0.36f); path.lineTo(100f, h); path.lineTo(0f, h); path.close()
                fill(a); c.drawPath(path, p)
                stroke(t, 1.4f, 0xE0); c.drawLine(0f, h * 0.62f - 2.2f, 100f, h * 0.36f - 2.2f, p)
            }
            Covers.Pattern.MARBLE -> {
                for (i in 0 until (h * 2.4f).toInt()) {
                    fill(a, 0xB0 + rnd.nextInt(0x50))
                    blob(c, rnd.nextFloat() * 100f, rnd.nextFloat() * h, 0.5f + rnd.nextFloat() * rnd.nextFloat() * 3.2f, rnd)
                }
            }
            Covers.Pattern.TERRAZZO -> {
                val cols = listOf(a, t, Covers.shade(base, -0.25f), Covers.shade(a, 0.35f))
                for (i in 0 until (h * 0.6f).toInt()) {
                    fill(cols[rnd.nextInt(cols.size)])
                    blob(c, rnd.nextFloat() * 100f, rnd.nextFloat() * h, 1.4f + rnd.nextFloat() * 3.2f, rnd)
                }
            }
            Covers.Pattern.CONFETTI -> {
                val cols = listOf(a, t, Color.WHITE)
                for (i in 0 until (h * 0.55f).toInt()) {
                    val x = rnd.nextFloat() * 100f; val y = rnd.nextFloat() * h
                    if (rnd.nextInt(3) == 0) { fill(cols[rnd.nextInt(cols.size)], 0xE0); c.drawCircle(x, y, 0.9f + rnd.nextFloat(), p) }
                    else {
                        val ang = rnd.nextFloat() * PI.toFloat(); val len = 2f + rnd.nextFloat() * 2.5f
                        stroke(cols[rnd.nextInt(cols.size)], 1.3f, 0xE0)
                        c.drawLine(x, y, x + len * cos(ang), y + len * sin(ang), p)
                    }
                }
            }
            Covers.Pattern.STARS -> {
                for (i in 0 until (h * 1.1f).toInt()) {
                    fill(a, 0x50 + rnd.nextInt(0xAF)); c.drawCircle(rnd.nextFloat() * 100f, rnd.nextFloat() * h, 0.2f + rnd.nextFloat() * 0.55f, p)
                }
                fill(a)
                for (i in 0 until 5) sparkle(c, 10f + rnd.nextFloat() * 80f, 6f + rnd.nextFloat() * (h * 0.6f), 1.8f + rnd.nextFloat() * 1.6f)
                // Crescent moon.
                val moon = Path().apply { addCircle(74f, 22f, 9f, Path.Direction.CW) }
                val bite = Path().apply { addCircle(78.5f, 18.5f, 8f, Path.Direction.CW) }
                moon.op(bite, Path.Op.DIFFERENCE)
                fill(a, 0xF0); c.drawPath(moon, p)
            }
            Covers.Pattern.SUNBURST -> {
                val cx = 50f; val cy = h * 0.42f
                fill(a, 0x90)
                for (i in 0 until 24 step 2) {
                    val a0 = i * 2 * PI / 24; val a1 = (i + 1) * 2 * PI / 24
                    path.reset(); path.moveTo(cx, cy)
                    path.lineTo(cx + (200 * cos(a0)).toFloat(), cy + (200 * sin(a0)).toFloat())
                    path.lineTo(cx + (200 * cos(a1)).toFloat(), cy + (200 * sin(a1)).toFloat())
                    path.close(); c.drawPath(path, p)
                }
                fill(t); c.drawCircle(cx, cy, 13f, p)
                fill(Color.WHITE, 0x30); c.drawCircle(cx, cy, 17f, p)
            }
            Covers.Pattern.MOUNTAINS -> {
                fill(t); c.drawCircle(70f, h * 0.22f, 8f, p)
                fill(t, 0x40); c.drawCircle(70f, h * 0.22f, 12f, p)
                ridge(c, h, h * 0.48f, 14f, Covers.shade(a, 0.35f), rnd)
                ridge(c, h, h * 0.6f, 12f, a, rnd)
                ridge(c, h, h * 0.74f, 9f, Covers.shade(a, -0.35f), rnd)
            }
            Covers.Pattern.GRADIENT -> {
                fill(Color.WHITE, 0x16); c.drawCircle(20f, h * 0.2f, 34f, p)
                fill(Color.WHITE, 0x10); c.drawCircle(85f, h * 0.65f, 26f, p)
            }
            Covers.Pattern.BAND -> {
                val top = h * 0.16f; val bot = h * 0.34f
                fill(a); c.drawRect(0f, top, 100f, bot, p)
                stroke(t, 0.8f); c.drawLine(0f, top - 1.6f, 100f, top - 1.6f, p); c.drawLine(0f, bot + 1.6f, 100f, bot + 1.6f, p)
                // A blank label on the band, like a field book.
                fill(t, 0xE0); c.drawRoundRect(RectF(20f, top + 3f, 88f, bot - 3f), 1.4f, 1.4f, p)
                stroke(a, 0.35f, 0x60); c.drawLine(25f, (top + bot) / 2f + 1.5f, 83f, (top + bot) / 2f + 1.5f, p)
            }
            Covers.Pattern.CORNERS -> {
                stroke(t, 0.5f, 0x70); c.drawRect(11f, 7f, 93f, h - 7f, p)
                stroke(t, 0.3f, 0x50); c.drawRect(13f, 9f, 91f, h - 9f, p)
                fill(a)
                path.reset(); path.moveTo(76f, 0f); path.lineTo(100f, 0f); path.lineTo(100f, 24f); path.close(); c.drawPath(path, p)
                path.reset(); path.moveTo(76f, h); path.lineTo(100f, h); path.lineTo(100f, h - 24f); path.close(); c.drawPath(path, p)
                stroke(Color.WHITE, 0.5f, 0x30); c.drawLine(76f, 0f, 100f, 24f, p); c.drawLine(76f, h, 100f, h - 24f, p)
            }
            Covers.Pattern.STRAP -> {
                fill(Color.BLACK, 0x40); c.drawRect(84.6f, 0f, 86f, h, p)
                fill(a); c.drawRect(86f, 0f, 91.5f, h, p)
                stroke(Color.WHITE, 0.25f, 0x1C); var y = 0f
                while (y < h) { c.drawLine(86f, y, 91.5f, y, p); y += 0.9f }
                fill(Color.WHITE, 0x18); c.drawRect(86f, 0f, 86.8f, h, p)
            }
        }
    }

    private fun grid(c: Canvas, h: Float, color: Int) {
        var i = 0; var v = 0f
        while (v < 100f) { stroke(color, if (i % 5 == 0) 0.5f else 0.22f, if (i % 5 == 0) 0x90 else 0x48); c.drawLine(v, 0f, v, h, p); v += 4f; i++ }
        i = 0; v = 0f
        while (v < h) { stroke(color, if (i % 5 == 0) 0.5f else 0.22f, if (i % 5 == 0) 0x90 else 0x48); c.drawLine(0f, v, 100f, v, p); v += 4f; i++ }
    }

    private fun hex(c: Canvas, cx: Float, cy: Float, r: Float) {
        path.reset()
        for (i in 0..5) {
            val ang = PI / 6 + i * PI / 3
            val x = cx + (r * cos(ang)).toFloat(); val y = cy + (r * sin(ang)).toFloat()
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close(); c.drawPath(path, p)
    }

    /** An irregular polygon chip (marble speckle / terrazzo stone). */
    private fun blob(c: Canvas, cx: Float, cy: Float, r: Float, rnd: Random) {
        val n = 4 + rnd.nextInt(3); val rot = rnd.nextFloat() * 6.28f
        path.reset()
        for (i in 0 until n) {
            val ang = rot + i * 2 * PI / n
            val rr = r * (0.6f + rnd.nextFloat() * 0.6f)
            val x = cx + (rr * cos(ang)).toFloat(); val y = cy + (rr * sin(ang)).toFloat()
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close(); c.drawPath(path, p)
    }

    private fun sparkle(c: Canvas, x: Float, y: Float, r: Float) {
        path.reset()
        path.moveTo(x, y - r); path.lineTo(x + r * 0.22f, y - r * 0.22f); path.lineTo(x + r, y); path.lineTo(x + r * 0.22f, y + r * 0.22f)
        path.lineTo(x, y + r); path.lineTo(x - r * 0.22f, y + r * 0.22f); path.lineTo(x - r, y); path.lineTo(x - r * 0.22f, y - r * 0.22f)
        path.close(); c.drawPath(path, p)
    }

    /** A jagged mountain range whose peaks sit around [baseY], filled down to the bottom edge. */
    private fun ridge(c: Canvas, h: Float, baseY: Float, amp: Float, color: Int, rnd: Random) {
        path.reset(); path.moveTo(0f, h); path.lineTo(0f, baseY + rnd.nextFloat() * amp)
        var x = 0f; var up = true
        while (x < 100f) {
            x += 9f + rnd.nextFloat() * 12f
            path.lineTo(x, if (up) baseY - rnd.nextFloat() * amp else baseY + rnd.nextFloat() * amp * 0.5f)
            up = !up
        }
        path.lineTo(100f, h); path.close()
        fill(color); c.drawPath(path, p)
    }

    override fun setAlpha(alpha: Int) { p.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { p.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
