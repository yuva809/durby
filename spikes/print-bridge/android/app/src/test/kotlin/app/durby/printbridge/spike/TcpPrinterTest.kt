package app.durby.printbridge.spike

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** The TCP printer against an in-process fake printer on loopback. */
class TcpPrinterTest {
    private val fake = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
    private val port get() = fake.localPort

    @After
    fun close() = fake.close()

    /** Accepts one connection and records everything until the client closes. */
    private fun recordOne(): CompletableFuture<ByteArray> = CompletableFuture.supplyAsync {
        fake.accept().use { s -> ByteArrayOutputStream().also { s.getInputStream().copyTo(it) }.toByteArray() }
    }

    @Test
    fun `sends all bytes and reports sent`() {
        val received = recordOne()
        val job = EscPos.rasterJob(576, 300, ByteArray(72 * 300) { 0x55 }, cutter = true)
        val result = TcpPrinter("127.0.0.1", port).send(job)
        assertTrue(result.toString(), result.ok)
        assertArrayEquals(job, received.get(5, TimeUnit.SECONDS))
    }

    @Test
    fun `a closed port is unreachable, fast`() {
        val closedPort = port
        fake.close()
        val result = TcpPrinter("127.0.0.1", closedPort).send(EscPos.INIT)
        assertFalse(result.ok)
        assertEquals("bridge.printer_unreachable", result.code)
        assertTrue(result.millis < 2_000)
    }

    @Test
    fun `a host that never answers times out after the connect timeout`() {
        // TEST-NET-1 (RFC 5737): not routed, so the SYN goes unanswered (or fails at once offline).
        val result = TcpPrinter("192.0.2.1", 9100, connectTimeoutMs = 300).send(EscPos.INIT)
        assertFalse(result.ok)
        assertTrue(result.code, result.code in setOf("bridge.printer_timeout", "bridge.printer_unreachable"))
        assertTrue(result.millis < 2_000)
    }

    @Test
    fun `a printer that stops reading is cut off by the write timeout`() {
        // Accept but never read: the socket buffers fill and write blocks until the watchdog closes it.
        val accepted = CompletableFuture.supplyAsync { fake.accept() }
        val result = TcpPrinter("127.0.0.1", port, writeTimeoutMs = 500).send(ByteArray(64 * 1024 * 1024))
        accepted.get(5, TimeUnit.SECONDS).close()
        assertFalse(result.ok)
        assertEquals("bridge.printer_closed_connection", result.code)
        assertTrue(result.millis < 5_000)
    }

    @Test
    fun `status parses DLE EOT answers`() {
        CompletableFuture.runAsync {
            fake.accept().use { s ->
                val inp = s.getInputStream()
                val out = s.getOutputStream()
                repeat(3) {
                    val q = ByteArray(3).also { inp.read(it) }
                    out.write(if (q[2].toInt() == 4) 0x72 else 0x12) // paper out
                    out.flush()
                }
            }
        }
        val status = TcpPrinter("127.0.0.1", port).status()
        assertTrue(status.answered)
        assertEquals("paper out", status.summary())
    }

    @Test
    fun `a printer that ignores status queries is reachable but unanswered`() {
        CompletableFuture.runAsync { fake.accept().use { Thread.sleep(1_500) } }
        val status = TcpPrinter("127.0.0.1", port, statusTimeoutMs = 200).status()
        assertTrue(status.reachable)
        assertFalse(status.answered)
    }
}
