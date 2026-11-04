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

    /** A full job: init, the image, then cut (or just feed past the tear bar when there is no cutter). */
    fun rasterJob(widthDots: Int, heightDots: Int, bits: ByteArray, cutter: Boolean): ByteArray =
        concat(INIT, raster(widthDots, heightDots, bits), if (cutter) cut(3) else feed(4))

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
