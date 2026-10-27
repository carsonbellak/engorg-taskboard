package com.engorg.inkpad

import android.graphics.PointF
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * INLINE symbols sit on a wire between two terminals (the shape's two verts): the body keeps its
 * standard size and the leads stretch, so dragging a terminal re-wires without distorting it.
 * BOX symbols fill the box between their two verts (like a rectangle) and turn with the rotate knob.
 */
enum class SymKind { INLINE, BOX }

/** Picker tabs, grouped by the Purdue BSME course that uses them. */
enum class SymGroup(val label: String, val courses: String) {
    ECE("Circuits", "ECE 20001 · ME 365"),
    THERMO("Thermo", "ME 200 · ME 300 · ME 309"),
    MECH("Mechanics", "ME 270 · ME 274 · ME 323"),
    SYSTEMS("Systems", "ME 365 · ME 375"),
}

/**
 * A class symbol. [w]×[h] is its standard size in page units (for INLINE, [w] is the body's length
 * along the wire). [anchor] is the local point a tap lands on and that snaps to the dot grid — a
 * terminal or a support's pin — so wires and beams meet it on the dots.
 */
enum class Sym(val label: String, val group: SymGroup, val kind: SymKind, val w: Float, val h: Float, val ax: Float = 0f, val ay: Float = 0f) {
    // Circuits
    RESISTOR("Resistor", SymGroup.ECE, SymKind.INLINE, 44f, 16f),
    RESISTOR_BOX("Resistor (box)", SymGroup.ECE, SymKind.INLINE, 44f, 16f),
    CAPACITOR("Capacitor", SymGroup.ECE, SymKind.INLINE, 8f, 28f),
    CAP_POLAR("Polarized cap", SymGroup.ECE, SymKind.INLINE, 10f, 28f),
    INDUCTOR("Inductor", SymGroup.ECE, SymKind.INLINE, 44f, 12f),
    VSOURCE("Voltage source", SymGroup.ECE, SymKind.INLINE, 36f, 36f),
    ISOURCE("Current source", SymGroup.ECE, SymKind.INLINE, 36f, 36f),
    VSOURCE_AC("AC source", SymGroup.ECE, SymKind.INLINE, 36f, 36f),
    VSOURCE_DEP("Dependent V", SymGroup.ECE, SymKind.INLINE, 40f, 40f),
    ISOURCE_DEP("Dependent I", SymGroup.ECE, SymKind.INLINE, 40f, 40f),
    BATTERY("Battery", SymGroup.ECE, SymKind.INLINE, 16f, 28f),
    DIODE("Diode", SymGroup.ECE, SymKind.INLINE, 24f, 22f),
    LED("LED", SymGroup.ECE, SymKind.INLINE, 24f, 22f),
    SWITCH("Switch", SymGroup.ECE, SymKind.INLINE, 36f, 16f),
    AMMETER("Ammeter", SymGroup.ECE, SymKind.INLINE, 32f, 32f),
    VOLTMETER("Voltmeter", SymGroup.ECE, SymKind.INLINE, 32f, 32f),
    GROUND("Ground", SymGroup.ECE, SymKind.BOX, 28f, 24f, 0f, -12f),
    OPAMP("Op-amp", SymGroup.ECE, SymKind.BOX, 96f, 88f, -48f, -32f),
    NODE("Node", SymGroup.ECE, SymKind.BOX, 8f, 8f),

    // Thermo
    COMPRESSOR("Compressor", SymGroup.THERMO, SymKind.BOX, 64f, 56f),
    TURBINE("Turbine", SymGroup.THERMO, SymKind.BOX, 64f, 56f),
    PUMP("Pump", SymGroup.THERMO, SymKind.BOX, 48f, 48f),
    HEAT_EXCHANGER("Heat exchanger", SymGroup.THERMO, SymKind.BOX, 80f, 40f),
    VALVE("Throttle valve", SymGroup.THERMO, SymKind.INLINE, 28f, 20f),
    NOZZLE("Nozzle", SymGroup.THERMO, SymKind.BOX, 64f, 48f),
    DIFFUSER("Diffuser", SymGroup.THERMO, SymKind.BOX, 64f, 48f),
    PISTON("Piston-cylinder", SymGroup.THERMO, SymKind.BOX, 56f, 72f),
    HEAT_ENGINE("Heat engine", SymGroup.THERMO, SymKind.BOX, 96f, 128f),
    REFRIGERATOR("Refrigerator / HP", SymGroup.THERMO, SymKind.BOX, 96f, 128f),

    // Mechanics
    PIN_SUPPORT("Pin support", SymGroup.MECH, SymKind.BOX, 40f, 36f, 0f, -14f),
    ROLLER_SUPPORT("Roller support", SymGroup.MECH, SymKind.BOX, 40f, 36f, 0f, -14f),
    FIXED_SUPPORT("Fixed wall", SymGroup.MECH, SymKind.BOX, 16f, 64f, 8f, 0f),
    GROUND_SURFACE("Ground", SymGroup.MECH, SymKind.BOX, 96f, 12f, 0f, -6f),
    SPRING("Spring", SymGroup.MECH, SymKind.INLINE, 56f, 20f),
    DAMPER("Damper", SymGroup.MECH, SymKind.INLINE, 40f, 24f),
    CART("Mass on wheels", SymGroup.MECH, SymKind.BOX, 64f, 56f),
    PULLEY("Pulley", SymGroup.MECH, SymKind.BOX, 48f, 48f),
    MOMENT_CCW("Moment ↺", SymGroup.MECH, SymKind.BOX, 48f, 48f),
    MOMENT_CW("Moment ↻", SymGroup.MECH, SymKind.BOX, 48f, 48f),

    // Systems
    BLOCK("Block", SymGroup.SYSTEMS, SymKind.BOX, 96f, 40f, -48f, 0f),
    SUMMER("Summing junction", SymGroup.SYSTEMS, SymKind.BOX, 32f, 32f),
    GAIN("Gain", SymGroup.SYSTEMS, SymKind.BOX, 64f, 40f, -32f, 0f);

    companion object {
        fun inGroup(g: SymGroup) = values().filter { it.group == g }
    }
}

/** Geometry for [Sym]s, in the same Part polylines every other shape renders, erases and mirrors with. */
object Symbols {
    /** The dot/grid paper's spacing (FinishedStrokesView.drawPaper). */
    const val GRID = 32f
    /** A tap-placed INLINE symbol spans three grid squares, terminal to terminal. */
    const val SPAN = 96f

    fun snap(v: Float) = Math.round(v / GRID) * GRID

    /** Upright marks (signs, meter letters) that stay readable however the symbol is turned. */
    private enum class Glyph { PLUS, MINUS, A, V, SINE }

    private class Builder(val map: (Float, Float) -> PointF, val glyphScale: Float, val glyphRot: Float) {
        val out = ArrayList<ShapeSpec.Part>()

        /** Polyline through local (x,y) pairs, subdivided so taps, the lasso and the eraser find it. */
        fun path(vararg xy: Float, closed: Boolean = false, fine: Boolean = false) {
            val pts = ArrayList<PointF>()
            val n = xy.size / 2
            val last = if (closed) n else n - 1
            for (i in 0 until last) {
                val x0 = xy[2 * i]; val y0 = xy[2 * i + 1]
                val j = (i + 1) % n; val x1 = xy[2 * j]; val y1 = xy[2 * j + 1]
                val steps = (hypot(x1 - x0, y1 - y0) / 3f).toInt().coerceIn(1, 60)
                for (s in 0 until steps) { val t = s.toFloat() / steps; pts.add(map(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) }
            }
            pts.add(if (closed) map(xy[0], xy[1]) else map(xy[2 * (n - 1)], xy[2 * (n - 1) + 1]))
            out.add(ShapeSpec.Part(pts, fine))
        }

        fun line(x0: Float, y0: Float, x1: Float, y1: Float, fine: Boolean = false) = path(x0, y0, x1, y1, fine = fine)

        /** Arc from [a0] to [a1] degrees (screen angles, y down); a full turn when they're 360 apart. */
        fun arc(cx: Float, cy: Float, rx: Float, ry: Float, a0: Float, a1: Float, fine: Boolean = false): PointF {
            val n = (abs(a1 - a0) / 7.5f).toInt().coerceAtLeast(4)
            val pts = (0..n).map {
                val a = Math.toRadians((a0 + (a1 - a0) * it / n).toDouble())
                map(cx + rx * cos(a).toFloat(), cy + ry * sin(a).toFloat())
            }
            out.add(ShapeSpec.Part(pts, fine))
            val e = Math.toRadians(a1.toDouble())
            return PointF(cx + rx * cos(e).toFloat(), cy + ry * sin(e).toFloat())
        }

        fun circle(cx: Float, cy: Float, r: Float) { arc(cx, cy, r, r, 0f, 360f) }

        /** A V head at (tx,ty) pointing along (dx,dy). */
        fun head(tx: Float, ty: Float, dx: Float, dy: Float, len: Float = 7f) {
            val l = hypot(dx, dy).coerceAtLeast(1e-3f); val ux = dx / l; val uy = dy / l
            val c = cos(0.45f); val s = sin(0.45f)
            val lx = -(ux * c - uy * s) * len; val ly = -(ux * s + uy * c) * len
            val rx = -(ux * c + uy * s) * len; val ry = -(-ux * s + uy * c) * len
            path(tx + lx, ty + ly, tx, ty, tx + rx, ty + ry)
        }

        fun arrow(x0: Float, y0: Float, x1: Float, y1: Float, len: Float = 7f) { line(x0, y0, x1, y1); head(x1, y1, x1 - x0, y1 - y0, len) }

        /** A small solid-looking dot: concentric rings (they mirror to the desktop as plain strokes). */
        fun dot(cx: Float, cy: Float, r: Float) { var rr = r; while (rr > 0.4f) { circle(cx, cy, rr); rr -= 1.1f } }

        /** [g] centered on local ([cx],[cy]), [size] half-height, drawn upright on the page. */
        fun glyph(g: Glyph, cx: Float, cy: Float, size: Float) {
            val p = map(cx, cy)
            val k = size * glyphScale
            val a = Math.toRadians(glyphRot.toDouble()); val c = cos(a).toFloat(); val s = sin(a).toFloat()
            fun gp(x: Float, y: Float) = PointF(p.x + (x * c - y * s) * k, p.y + (x * s + y * c) * k)
            fun stroke(vararg xy: Float) { out.add(ShapeSpec.Part((0 until xy.size / 2).map { gp(xy[2 * it], xy[2 * it + 1]) })) }
            when (g) {
                Glyph.PLUS -> { stroke(-1f, 0f, 1f, 0f); stroke(0f, -1f, 0f, 1f) }
                Glyph.MINUS -> stroke(-1f, 0f, 1f, 0f)
                Glyph.A -> { stroke(-0.75f, 1f, 0f, -1f, 0.75f, 1f); stroke(-0.42f, 0.2f, 0.42f, 0.2f) }
                Glyph.V -> stroke(-0.75f, -1f, 0f, 1f, 0.75f, -1f)
                Glyph.SINE -> stroke(*FloatArray(34) { i -> val t = -1f + (i / 2) / 8f; if (i % 2 == 0) t else -0.55f * sin(Math.PI.toFloat() * t) })
            }
        }
    }

    /**
     * The parts of [sym] placed by [verts]. INLINE: terminals verts[0]→verts[1], body at [k]× its
     * standard size (shrunk to fit a short span). BOX: fills the box verts[0]–verts[1]. [rot] is the
     * shape's rotation, so the upright glyphs can be counter-turned.
     */
    fun parts(sym: Sym, verts: List<PointF>, k: Float, rot: Float): List<ShapeSpec.Part> {
        val a = verts[0]; val b = verts[1]
        return if (sym.kind == SymKind.INLINE) {
            val len = hypot(b.x - a.x, b.y - a.y)
            val ux = if (len > 1e-3f) (b.x - a.x) / len else 1f
            val uy = if (len > 1e-3f) (b.y - a.y) / len else 0f
            val kk = min(k, len / sym.w).coerceAtLeast(0.05f)
            val mx = (a.x + b.x) / 2f; val my = (a.y + b.y) / 2f
            val bl = Builder({ x, y -> PointF(mx + (ux * x - uy * y) * kk, my + (uy * x + ux * y) * kk) }, kk, 0f)
            // Leads from each terminal to the body.
            val half = sym.w / 2f * kk
            if (len / 2f - half > 0.5f) {
                bl.out.add(ShapeSpec.Part(seg(a, PointF(mx - ux * half, my - uy * half))))
                bl.out.add(ShapeSpec.Part(seg(PointF(mx + ux * half, my + uy * half), b)))
            }
            draw(sym, bl)
            bl.out
        } else {
            val l = min(a.x, b.x); val r = max(a.x, b.x); val t = min(a.y, b.y); val bt = max(a.y, b.y)
            val sx = (r - l) / sym.w; val sy = (bt - t) / sym.h
            val cx = (l + r) / 2f; val cy = (t + bt) / 2f
            val bl = Builder({ x, y -> PointF(cx + x * sx, cy + y * sy) }, min(sx, sy), -rot)
            draw(sym, bl)
            bl.out
        }
    }

    private fun seg(a: PointF, b: PointF): List<PointF> {
        val n = (hypot(b.x - a.x, b.y - a.y) / 6f).toInt().coerceIn(1, 200)
        return (0..n).map { val t = it.toFloat() / n; PointF(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) }
    }

    /** Local coords: INLINE runs along +x (−w/2 at the first terminal's side), y is the wire's normal; BOX is centered. */
    private fun draw(sym: Sym, g: Builder) {
        when (sym) {
            Sym.RESISTOR -> g.path(-22f, 0f, -18.33f, -7f, -11f, 7f, -3.67f, -7f, 3.67f, 7f, 11f, -7f, 18.33f, 7f, 22f, 0f)
            Sym.RESISTOR_BOX -> g.path(-22f, -8f, 22f, -8f, 22f, 8f, -22f, 8f, closed = true)
            Sym.CAPACITOR -> { g.line(-4f, -14f, -4f, 14f); g.line(4f, -14f, 4f, 14f) }
            Sym.CAP_POLAR -> {
                g.line(-5f, -13f, -5f, 13f)
                g.arc(25f, 0f, 20f, 20f, 140f, 220f)
                g.glyph(Glyph.PLUS, -11f, -12f, 3f)
            }
            Sym.INDUCTOR -> {
                val pts = ArrayList<Float>()
                for (c in 0 until 4) {
                    val cx = -16.5f + c * 11f
                    for (i in 0..12) { val t = Math.PI + Math.PI * i / 12; pts.add(cx + 5.5f * cos(t).toFloat()); pts.add(5.5f * sin(t).toFloat()) }
                }
                g.path(*pts.toFloatArray())
            }
            // Sources: + (or the arrow) points toward the second terminal — the end you drag to.
            Sym.VSOURCE -> { g.circle(0f, 0f, 18f); g.glyph(Glyph.PLUS, 8.5f, 0f, 4f); g.glyph(Glyph.MINUS, -8.5f, 0f, 4f) }
            Sym.ISOURCE -> { g.circle(0f, 0f, 18f); g.arrow(-10f, 0f, 10f, 0f, 6f) }
            Sym.VSOURCE_AC -> { g.circle(0f, 0f, 18f); g.glyph(Glyph.SINE, 0f, 0f, 9f) }
            Sym.VSOURCE_DEP -> { g.path(-20f, 0f, 0f, -20f, 20f, 0f, 0f, 20f, closed = true); g.glyph(Glyph.PLUS, 9f, 0f, 3.5f); g.glyph(Glyph.MINUS, -9f, 0f, 3.5f) }
            Sym.ISOURCE_DEP -> { g.path(-20f, 0f, 0f, -20f, 20f, 0f, 0f, 20f, closed = true); g.arrow(-10f, 0f, 10f, 0f, 6f) }
            Sym.BATTERY -> {
                g.line(-8f, -7f, -8f, 7f); g.line(-2.7f, -14f, -2.7f, 14f)
                g.line(2.7f, -7f, 2.7f, 7f); g.line(8f, -14f, 8f, 14f)
                g.glyph(Glyph.PLUS, 13f, -13f, 3f)
            }
            Sym.DIODE, Sym.LED -> {
                g.path(-12f, -11f, -12f, 11f, 12f, 0f, closed = true)
                g.line(12f, -11f, 12f, 11f)
                if (sym == Sym.LED) { g.arrow(0f, -13f, 7f, -22f, 4f); g.arrow(6f, -11f, 13f, -20f, 4f) }
            }
            Sym.SWITCH -> { g.circle(-15f, 0f, 3f); g.circle(15f, 0f, 3f); g.line(-12.5f, -1.5f, 13f, -14f) }
            Sym.AMMETER -> { g.circle(0f, 0f, 16f); g.glyph(Glyph.A, 0f, 0f, 8f) }
            Sym.VOLTMETER -> { g.circle(0f, 0f, 16f); g.glyph(Glyph.V, 0f, 0f, 8f) }
            Sym.GROUND -> { g.line(0f, -12f, 0f, 0f); g.line(-14f, 0f, 14f, 0f); g.line(-9f, 6f, 9f, 6f); g.line(-4f, 12f, 4f, 12f) }
            Sym.OPAMP -> {
                g.path(-36f, -44f, 36f, 0f, -36f, 44f, closed = true)
                g.line(-48f, -32f, -36f, -32f); g.line(-48f, 32f, -36f, 32f); g.line(36f, 0f, 48f, 0f)
                g.glyph(Glyph.MINUS, -26f, -32f, 4.5f); g.glyph(Glyph.PLUS, -26f, 32f, 4.5f)
            }
            Sym.NODE -> g.dot(0f, 0f, 3.6f)

            // Flow runs left → right: a compressor narrows, a turbine widens; the stub is the shaft (Ẇ).
            Sym.COMPRESSOR -> { g.path(-32f, -28f, 16f, -14f, 16f, 14f, -32f, 28f, closed = true); g.line(16f, 0f, 32f, 0f) }
            Sym.TURBINE -> { g.path(-16f, -14f, 32f, -28f, 32f, 28f, -16f, 14f, closed = true); g.line(-32f, 0f, -16f, 0f) }
            Sym.PUMP -> { g.circle(0f, 4f, 20f); g.line(0f, -16f, 24f, -16f); g.line(-24f, 4f, -20f, 4f) }
            Sym.HEAT_EXCHANGER -> {
                g.path(-32f, -20f, 32f, -20f, 32f, 20f, -32f, 20f, closed = true)
                g.path(-40f, 0f, -32f, 0f, -24f, -12f, -12f, 12f, 0f, -12f, 12f, 12f, 24f, -12f, 32f, 0f, 40f, 0f)
            }
            Sym.VALVE -> g.path(-14f, -10f, -14f, 10f, 14f, -10f, 14f, 10f, closed = true)
            Sym.NOZZLE -> { g.line(-32f, -24f, 32f, -10f); g.line(-32f, 24f, 32f, 10f) }
            Sym.DIFFUSER -> { g.line(-32f, -10f, 32f, -24f); g.line(-32f, 10f, 32f, 24f) }
            Sym.PISTON -> {
                g.path(-24f, -36f, -24f, 36f, 24f, 36f, 24f, -36f)
                g.path(-24f, -12f, 24f, -12f, 24f, -2f, -24f, -2f, closed = true)
                g.line(0f, -12f, 0f, -36f)
            }
            // Second-law reservoir diagrams: T_H on top, T_L below, the cycle in the middle.
            Sym.HEAT_ENGINE, Sym.REFRIGERATOR -> {
                g.path(-40f, -64f, 40f, -64f, 40f, -44f, -40f, -44f, closed = true)
                g.path(-40f, 44f, 40f, 44f, 40f, 64f, -40f, 64f, closed = true)
                g.circle(0f, 0f, 20f)
                if (sym == Sym.HEAT_ENGINE) { g.arrow(0f, -44f, 0f, -21f); g.arrow(0f, 21f, 0f, 44f); g.arrow(21f, 0f, 48f, 0f) }
                else { g.arrow(0f, 44f, 0f, 21f); g.arrow(0f, -21f, 0f, -44f); g.arrow(48f, 0f, 21f, 0f) }
            }

            Sym.PIN_SUPPORT, Sym.ROLLER_SUPPORT -> {
                g.circle(0f, -14f, 4f)
                if (sym == Sym.PIN_SUPPORT) g.path(0f, -10f, 14f, 10f, -14f, 10f, closed = true)
                else { g.path(0f, -10f, 12f, 3f, -12f, 3f, closed = true); g.circle(-7f, 6.5f, 3.5f); g.circle(7f, 6.5f, 3.5f) }
                g.line(-20f, 10f, 20f, 10f)
                var x = -16f; while (x <= 20f) { g.line(x, 10f, x - 6f, 18f, fine = true); x += 6f }
            }
            Sym.FIXED_SUPPORT -> {
                g.line(8f, -32f, 8f, 32f)
                var y = -30f; while (y <= 30f) { g.line(8f, y, -2f, y + 10f, fine = true); y += 7.5f }
            }
            Sym.GROUND_SURFACE -> {
                g.line(-48f, -6f, 48f, -6f)
                var x = -44f; while (x <= 48f) { g.line(x, -6f, x - 8f, 6f, fine = true); x += 8f }
            }
            Sym.SPRING -> {
                val pts = arrayListOf(-28f, 0f, -22f, 0f)
                for (i in 0 until 8) { pts.add(-22f + 44f * (i + 0.5f) / 8f); pts.add(if (i % 2 == 0) -9f else 9f) }
                pts.addAll(listOf(22f, 0f, 28f, 0f))
                g.path(*pts.toFloatArray())
            }
            Sym.DAMPER -> {
                g.line(-20f, 0f, -2f, 0f); g.line(-2f, -8f, -2f, 8f)
                g.path(-10f, -12f, 16f, -12f, 16f, 12f, -10f, 12f)
                g.line(16f, 0f, 20f, 0f)
            }
            Sym.CART -> { g.path(-28f, -28f, 28f, -28f, 28f, 12f, -28f, 12f, closed = true); g.circle(-14f, 20f, 8f); g.circle(14f, 20f, 8f) }
            Sym.PULLEY -> { g.circle(0f, 0f, 20f); g.circle(0f, 0f, 3f) }
            // Screen angles run clockwise (y is down), so ↺ sweeps backwards.
            Sym.MOMENT_CCW -> { val e = g.arc(0f, 0f, 18f, 18f, 60f, -210f); val t = Math.toRadians(-210.0); g.head(e.x, e.y, sin(t).toFloat(), -cos(t).toFloat()) }
            Sym.MOMENT_CW -> { val e = g.arc(0f, 0f, 18f, 18f, 120f, 390f); val t = Math.toRadians(390.0); g.head(e.x, e.y, -sin(t).toFloat(), cos(t).toFloat()) }

            Sym.BLOCK -> { g.path(-24f, -20f, 24f, -20f, 24f, 20f, -24f, 20f, closed = true); g.arrow(-48f, 0f, -24f, 0f); g.arrow(24f, 0f, 48f, 0f) }
            Sym.SUMMER -> { g.circle(0f, 0f, 14f); g.line(-9.9f, -9.9f, 9.9f, 9.9f); g.line(-9.9f, 9.9f, 9.9f, -9.9f) }
            Sym.GAIN -> { g.path(-20f, -20f, 20f, 0f, -20f, 20f, closed = true); g.line(-32f, 0f, -20f, 0f); g.line(20f, 0f, 32f, 0f) }
        }
    }
}
