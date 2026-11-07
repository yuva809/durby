package tech.durby.pos.print

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

class PrintServiceTest {
    private val job = "0195f2a4-7c1e-7d3a-9b2c-4e5f6a7b8c9d"

    /** A port-9100 printer on localhost: records each connection's bytes, answers DLE EOT with [status]. */
    private class FakePrinter(val status: (Int) -> Int?) : AutoCloseable {
        val server = ServerSocket(0)
        val jobs = CopyOnWriteArrayList<ByteArray>()

        init {
            thread(isDaemon = true) {
                while (!server.isClosed) {
                    val s = runCatching { server.accept() }.getOrNull() ?: break
                    thread(isDaemon = true) {
                        s.use { socket ->
                            val inp = socket.getInputStream()
                            val out = ByteArrayOutputStream()
                            while (true) {
                                val b = inp.read()
                                if (b < 0) break
                                out.write(b)
                                val bytes = out.toByteArray()
                                val n = bytes.size
                                if (n >= 3 && bytes[n - 3] == 0x10.toByte() && bytes[n - 2] == 0x04.toByte()) {
                                    status(bytes[n - 1].toInt())?.let { socket.getOutputStream().apply { write(it); flush() } }
                                }
                            }
                            jobs.add(out.toByteArray())
                        }
                    }
                }
            }
        }

        override fun close() = server.close()
    }

    private val printers = mutableListOf<FakePrinter>()

    @After
    fun closeAll() = printers.forEach { it.close() }

    private fun printer(status: (Int) -> Int? = { 0x12 }) = FakePrinter(status).also { printers += it }

    /** The fake listens on 127.0.0.1, which the address rules refuse; tests let loopback through explicitly. */
    private fun service(config: PrinterConfig?) =
        PrintService(appVersion = "1.0.0", printer = { config }, allowLoopbackForTests = true)

    private fun config(port: Int) = PrinterConfig("127.0.0.1", port, 384, cutter = true, imageMode = ImageMode.GS_V0)

    private fun print(height: Int = 10, id: String = job) = JSONObject()
        .put("version", 1).put("type", "print").put("jobId", id)
        .put("image", JSONObject().put("width", 384).put("height", height)
            .put("data", Base64.getEncoder().encodeToString(ByteArray(48 * height) { 0x0F }))).toString()

    private fun answer(json: String) = JSONObject(json)

    private fun waitFor(p: FakePrinter, count: Int) {
        val until = System.currentTimeMillis() + 3_000
        while (p.jobs.size < count && System.currentTimeMillis() < until) Thread.sleep(10)
    }

    @Test
    fun sendsTheImageAsOneEscPosJob() {
        val p = printer()
        val a = answer(service(config(p.server.localPort)).handle(print()))
        assertEquals("sent", a.getString("state"))
        assertEquals("print.sent", a.getString("code"))
        assertEquals(job, a.getString("jobId"))
        waitFor(p, 1)
        val expected = EscPos.rasterJob(384, 10, ByteArray(480) { 0x0F }, cutter = true)
        // The job starts with the status queries, then exactly the raster job.
        val sent = p.jobs.single()
        assertArrayEquals(expected, sent.copyOfRange(sent.size - expected.size, sent.size))
    }

    @Test
    fun theSameJobIdNeverPrintsTwice() {
        val p = printer()
        val s = service(config(p.server.localPort))
        assertEquals("print.sent", answer(s.handle(print())).getString("code"))
        assertEquals("print.sent", answer(s.handle(print())).getString("code"))
        waitFor(p, 1)
        Thread.sleep(200)
        assertEquals(1, p.jobs.size)
    }

    @Test
    fun aFailedJobCanBeRetriedWithTheSameId() {
        val dead = ServerSocket(0).apply { close() }.localPort
        var target = config(dead)
        val s = PrintService("1.0.0", printer = { target }, allowLoopbackForTests = true)
        assertEquals("print.printer_unreachable", answer(s.handle(print())).getString("code"))

        val p = printer()
        target = config(p.server.localPort)
        assertEquals("print.sent", answer(s.handle(print())).getString("code"))
    }

    @Test
    fun paperOutAndCoverOpenStopTheJobBeforeAnythingIsPrinted() {
        val paperOut = printer { n -> mapOf(1 to 0x1A, 2 to 0x32, 4 to 0x72)[n] }
        assertEquals("print.paper_out", answer(service(config(paperOut.server.localPort)).handle(print())).getString("code"))
        val coverOpen = printer { n -> mapOf(1 to 0x1A, 2 to 0x16, 4 to 0x12)[n] }
        assertEquals("print.cover_open", answer(service(config(coverOpen.server.localPort)).handle(print())).getString("code"))
        waitFor(paperOut, 1)
        waitFor(coverOpen, 1)
        // Only the status queries reached them.
        listOf(paperOut, coverOpen).forEach { p -> assertEquals(0, p.jobs.single().count { it == 0x1D.toByte() }) }
    }

    @Test
    fun aPrinterThatNeverAnswersStatusStillPrints() {
        val silent = printer { null }
        assertEquals("print.sent", answer(service(config(silent.server.localPort)).handle(print())).getString("code"))
    }

    @Test
    fun refusesWithoutAPrinterOrWithAForbiddenAddress() {
        assertEquals("print.no_printer", answer(service(null).handle(print())).getString("code"))
        val strict = PrintService("1.0.0", printer = { config(9100).copy(host = "8.8.8.8") })
        assertEquals("print.host_not_allowed", answer(strict.handle(print())).getString("code"))
        val loopback = PrintService("1.0.0", printer = { config(9100) })
        assertEquals("print.host_not_allowed", answer(loopback.handle(print())).getString("code"))
    }

    @Test
    fun answersInvalidRequests() {
        val a = answer(service(config(9100)).handle("""{"version":1,"type":"print","jobId":"$job","image":{}}"""))
        assertEquals("failed", a.getString("state"))
        assertEquals("print.payload_invalid", a.getString("code"))
        assertEquals(job, a.getString("jobId"))
    }

    @Test
    fun infoTellsTheWebTheWidthToRenderAt() {
        val a = answer(service(config(9100)).handle("""{"version":1,"type":"info"}"""))
        assertEquals("1.0.0", a.getString("appVersion"))
        assertEquals(1, a.getInt("protocol"))
        assertEquals(384, a.getJSONObject("printer").getInt("widthDots"))
        assertEquals(JSONObject.NULL, answer(service(null).handle("""{"version":1,"type":"info"}""")).get("printer"))
    }
}
