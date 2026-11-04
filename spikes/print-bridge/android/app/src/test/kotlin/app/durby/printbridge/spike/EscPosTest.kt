package app.durby.printbridge.spike

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EscPosTest {
    private fun hex(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }

    @Test
    fun `raster is one GS v 0 band with width in bytes and height in rows`() {
        val bits = ByteArray(2 * 3) { 0xFF.toByte() } // 16 dots wide, 3 rows
        assertArrayEquals(
            hex(0x1D, 0x76, 0x30, 0x00, 2, 0, 3, 0) + bits,
            EscPos.raster(16, 3, bits),
        )
    }

    @Test
    fun `a width that is not a multiple of 8 rounds up to whole bytes`() {
        assertEquals(72, EscPos.bytesPerRow(576))
        assertEquals(48, EscPos.bytesPerRow(384))
        assertEquals(2, EscPos.bytesPerRow(9))
    }

    @Test
    fun `tall images are split into bands`() {
        val bits = ByteArray(72 * 600)
        val out = EscPos.raster(576, 600, bits, bandRows = 256)
        assertEquals(3 * 8 + bits.size, out.size)
        // Bands: 256, 256, 88 rows.
        assertArrayEquals(hex(0x1D, 0x76, 0x30, 0x00, 72, 0, 0, 1), out.copyOfRange(0, 8))
        val third = 2 * (8 + 72 * 256)
        assertArrayEquals(hex(0x1D, 0x76, 0x30, 0x00, 72, 0, 88, 0), out.copyOfRange(third, third + 8))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a body of the wrong size is refused`() {
        EscPos.raster(576, 10, ByteArray(10))
    }

    @Test
    fun `a job cuts with a cutter and only feeds without one`() {
        val bits = ByteArray(1)
        val withCutter = EscPos.rasterJob(8, 1, bits, cutter = true)
        val without = EscPos.rasterJob(8, 1, bits, cutter = false)
        assertArrayEquals(hex(0x1B, 0x40), withCutter.copyOfRange(0, 2))
        assertArrayEquals(hex(0x1D, 0x56, 66, 3), withCutter.copyOfRange(withCutter.size - 4, withCutter.size))
        assertArrayEquals(hex(0x1B, 0x64, 4), without.copyOfRange(without.size - 3, without.size))
    }

    @Test
    fun `ESC star sends 24-dot stripes column by column, top dot first`() {
        // 8 dots wide, 25 rows: only the top-left dot and the dot at (7, 24) are black.
        val bits = ByteArray(25)
        bits[0] = 0x80.toByte()
        bits[24] = 0x01
        val out = EscPos.escStar(8, 25, bits)
        val stripe = 5 + 8 * 3 + 1
        assertEquals(3 + 2 * stripe + 2, out.size)
        assertArrayEquals(hex(0x1B, 0x33, 24), out.copyOfRange(0, 3))
        assertArrayEquals(hex(0x1B, 0x2A, 33, 8, 0), out.copyOfRange(3, 8))
        assertArrayEquals(hex(0x80, 0, 0), out.copyOfRange(8, 11)) // column 0, rows 0..23
        assertTrue(out.copyOfRange(11, 8 + 24).all { it == 0.toByte() })
        assertEquals(0x0A.toByte(), out[8 + 24])
        val second = 3 + stripe
        assertArrayEquals(hex(0x1B, 0x2A, 33, 8, 0), out.copyOfRange(second, second + 5))
        assertArrayEquals(hex(0x80, 0, 0), out.copyOfRange(second + 5 + 7 * 3, second + 5 + 8 * 3)) // column 7, row 24
        assertArrayEquals(hex(0x1B, 0x32), out.copyOfRange(out.size - 2, out.size))
    }

    @Test
    fun `width above 255 dots goes into nL nH`() {
        val out = EscPos.escStar(576, 24, ByteArray(72 * 24))
        assertArrayEquals(hex(0x1B, 0x2A, 33, 0x40, 0x02), out.copyOfRange(3, 8))
    }

    @Test
    fun `a raster job can use ESC star`() {
        val job = EscPos.rasterJob(8, 1, ByteArray(1), cutter = true, escStar = true)
        assertArrayEquals(hex(0x1B, 0x40, 0x1B, 0x33, 24, 0x1B, 0x2A), job.copyOfRange(0, 7))
    }

    @Test
    fun `drawer kick on pin 2 and pin 5`() {
        assertArrayEquals(hex(0x1B, 0x70, 0, 25, 250), EscPos.kickDrawer())
        assertArrayEquals(hex(0x1B, 0x70, 1, 25, 250), EscPos.kickDrawer(pin5 = true))
    }

    @Test
    fun `text is ASCII with a line feed, anything else becomes a question mark`() {
        assertArrayEquals("Gr??e 5?\n".toByteArray(), EscPos.line("Grüße 5€").let { it })
    }

    @Test
    fun `the ruler is full width and marks both edges`() {
        val (h, bits) = EscPos.ruler(576)
        assertEquals(96, h)
        assertEquals(72 * 96, bits.size)
        assertTrue(bits.copyOfRange(0, 72).all { it == 0xFF.toByte() })
        val row40 = 40 * 72
        assertEquals(0x80.toByte(), (bits[row40].toInt() and 0x80).toByte())
        assertEquals(0x01, bits[row40 + 71].toInt() and 0x01)
    }

    @Test
    fun `status bytes`() {
        assertEquals("online", PrinterStatus.parse(0x12, 0x12, 0x12).summary())
        assertEquals("paper out", PrinterStatus.parse(0x12, 0x12, 0x72).summary())
        assertEquals("cover open", PrinterStatus.parse(0x1A, 0x16, 0x12).summary())
        assertFalse(PrinterStatus.parse(0x12, null, null).paperOut)
    }

    @Test
    fun `test receipt starts with init and ends with a cut`() {
        val bytes = TestReceipt.bytes(PrinterConfig("10.0.0.5", 9100, 576, cutter = true), "https://staging.example")
        assertArrayEquals(hex(0x1B, 0x40), bytes.copyOfRange(0, 2))
        assertArrayEquals(hex(0x1D, 0x56, 66, 3), bytes.copyOfRange(bytes.size - 4, bytes.size))
        assertTrue(String(bytes, Charsets.US_ASCII).contains("10.0.0.5:9100"))
        assertTrue(String(bytes, Charsets.US_ASCII).contains("Version ${BuildConfig.VERSION_NAME} (spike)"))
        assertEquals("0.0.3", BuildConfig.VERSION_NAME)
    }
}
