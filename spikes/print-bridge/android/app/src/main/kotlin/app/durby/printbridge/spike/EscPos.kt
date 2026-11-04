package app.durby.printbridge.spike

import java.io.ByteArrayOutputStream

/**
 * The ESC/POS subset the bridge needs (docs/modules/print-bridge.md §4). Pure Kotlin, no Android, so the
 * bytes are unit-tested on the JVM.
 */
object EscPos {
    private const val ESC: Byte = 0x1B
    private const val GS: Byte = 0x1D
    private const val DLE: Byte = 0x10
    private const val EOT: Byte = 0x04
    private const val LF: Byte = 0x0A

    /** ESC @: reset to defaults (clears bold, alignment, line spacing left by DISH POS or earlier jobs). */
    val INIT = byteArrayOf(ESC, 0x40)

    /** ESC d n: print and feed n lines. */
    fun feed(lines: Int): ByteArray = byteArrayOf(ESC, 0x64, lines.coerceIn(0, 255).toByte())

    /** GS V 66 n: feed n motion units, then partial cut. */
    fun cut(feed: Int = 3): ByteArray = byteArrayOf(GS, 0x56, 66, feed.coerceIn(0, 255).toByte())

    /** ESC a n: 0 left, 1 center, 2 right. */
    fun align(n: Int): ByteArray = byteArrayOf(ESC, 0x61, n.coerceIn(0, 2).toByte())

    /** ESC E n: bold on/off. */
    fun bold(on: Boolean): ByteArray = byteArrayOf(ESC, 0x45, if (on) 1 else 0)

    /** A line of text; non-ASCII becomes '?' (the test receipt only; Durby content goes as raster). */
    fun line(text: String): ByteArray {
        val out = ByteArray(text.length + 1)
        text.forEachIndexed { i, c -> out[i] = if (c.code in 0x20..0x7E) c.code.toByte() else '?'.code.toByte() }
        out[text.length] = LF
        return out
    }

    /** DLE EOT n: real-time status. 1 printer, 2 offline cause (cover), 4 paper sensor. */
    fun statusQuery(n: Int): ByteArray = byteArrayOf(DLE, EOT, n.toByte())

    fun bytesPerRow(widthDots: Int): Int = (widthDots + 7) / 8

    /**
     * GS v 0 0 raster bit image in bands of at most [bandRows] rows (cheap printers overflow their buffer on
     * one huge image). [bits] is row-major, [bytesPerRow] bytes per row, most significant bit = leftmost dot,
     * 1 = black.
     */
    fun raster(widthDots: Int, heightDots: Int, bits: ByteArray, bandRows: Int = 256): ByteArray {
        require(widthDots in 1..2040) { "width $widthDots" }
        require(heightDots >= 1) { "height $heightDots" }
        require(bandRows in 1..2047) { "bandRows $bandRows" }
        val rowBytes = bytesPerRow(widthDots)
        require(bits.size == rowBytes * heightDots) { "expected ${rowBytes * heightDots} bytes, got ${bits.size}" }
        val out = ByteArrayOutputStream(bits.size + (heightDots / bandRows + 1) * 8)
        var row = 0
        while (row < heightDots) {
            val rows = minOf(bandRows, heightDots - row)
            out.write(byteArrayOf(GS, 0x76, 0x30, 0x00))
            out.write(rowBytes and 0xFF)
            out.write(rowBytes shr 8 and 0xFF)
            out.write(rows and 0xFF)
            out.write(rows shr 8 and 0xFF)
            out.write(bits, row * rowBytes, rows * rowBytes)
            row += rows
        }
        return out.toByteArray()
    }

    /**
     * Fallback for printers without GS v 0: ESC * 33 (24-dot double density) bit-image stripes. Each stripe
     * is 24 rows, sent column by column (3 bytes per column, most significant bit = top dot), then a line
     * feed with the line spacing set to exactly 24 dots (ESC 3 24) so stripes join without gaps; ESC 2
     * restores the default spacing. Same [bits] layout as [raster].
     */
    fun escStar(widthDots: Int, heightDots: Int, bits: ByteArray): ByteArray {
        require(widthDots in 1..2040) { "width $widthDots" }
        require(heightDots >= 1) { "height $heightDots" }
        val rowBytes = bytesPerRow(widthDots)
        require(bits.size == rowBytes * heightDots) { "expected ${rowBytes * heightDots} bytes, got ${bits.size}" }
        fun dot(x: Int, y: Int) = y < heightDots && bits[y * rowBytes + x / 8].toInt() and (0x80 ushr (x % 8)) != 0
        val out = ByteArrayOutputStream(bits.size * 3 + heightDots)
        out.write(byteArrayOf(ESC, 0x33, 24))
        var top = 0
        while (top < heightDots) {
            out.write(byteArrayOf(ESC, 0x2A, 33, (widthDots and 0xFF).toByte(), (widthDots shr 8).toByte()))
            for (x in 0 until widthDots) {
                for (k in 0 until 3) {
                    var b = 0
                    for (bit in 0 until 8) if (dot(x, top + k * 8 + bit)) b = b or (0x80 ushr bit)
                    out.write(b)
                }
            }
            out.write(LF.toInt())
            top += 24
        }
        out.write(byteArrayOf(ESC, 0x32))
        return out.toByteArray()
    }

    /** ESC p m t1 t2: drawer kick pulse on connector pin 2 (m=0) or pin 5 (m=1), 50 ms on, 500 ms off. */
    fun kickDrawer(pin5: Boolean = false): ByteArray = byteArrayOf(ESC, 0x70, if (pin5) 1 else 0, 25, 250.toByte())

    /**
     * A full job: init, the image, then cut (or just feed past the tear bar when there is no cutter).
     * [escStar] picks the ESC * fallback instead of GS v 0.
     */
    fun rasterJob(widthDots: Int, heightDots: Int, bits: ByteArray, cutter: Boolean, escStar: Boolean = false): ByteArray =
        concat(
            INIT,
            if (escStar) escStar(widthDots, heightDots, bits) else raster(widthDots, heightDots, bits),
            if (cutter) cut(3) else feed(4),
        )

    /** A width ruler: a full-width bar, then tick marks every 48 dots (6 mm at 203 dpi), to check the dot width. */
    fun ruler(widthDots: Int): Pair<Int, ByteArray> {
        val height = 96
        val rowBytes = bytesPerRow(widthDots)
        val bits = ByteArray(rowBytes * height)
        fun set(x: Int, y: Int) {
            bits[y * rowBytes + x / 8] = (bits[y * rowBytes + x / 8].toInt() or (0x80 ushr (x % 8))).toByte()
        }
        for (y in 0 until 16) for (x in 0 until widthDots) set(x, y)
        for (x in 0 until widthDots step 48) for (y in 16 until height) for (dx in 0 until 2) if (x + dx < widthDots) set(x + dx, y)
        for (y in 16 until height) { set(0, y); set(widthDots - 1, y) }
        return height to bits
    }

    fun concat(vararg parts: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(parts.sumOf { it.size })
        parts.forEach { out.write(it) }
        return out.toByteArray()
    }
}

/** Real-time status bytes (DLE EOT) as far as the printer answered them. */
data class PrinterStatus(
    val reachable: Boolean,
    val answered: Boolean,
    val offline: Boolean = false,
    val coverOpen: Boolean = false,
    val paperOut: Boolean = false,
    val paperNearEnd: Boolean = false,
    val error: String? = null,
) {
    companion object {
        /** n=1 bit 3: offline. n=2 bit 2: cover open. n=4 bits 5+6: paper end, bits 2+3: near end. */
        fun parse(printer: Int, offlineCause: Int?, paper: Int?) = PrinterStatus(
            reachable = true,
            answered = true,
            offline = printer and 0x08 != 0,
            coverOpen = offlineCause != null && offlineCause and 0x04 != 0,
            paperOut = paper != null && paper and 0x60 == 0x60,
            paperNearEnd = paper != null && paper and 0x0C == 0x0C,
        )
    }

    fun summary(): String = when {
        !reachable -> "unreachable ($error)"
        !answered -> "reachable, no answer to status query"
        coverOpen -> "cover open"
        paperOut -> "paper out"
        offline -> "offline"
        paperNearEnd -> "online, paper near end"
        else -> "online"
    }
}
