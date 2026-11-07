package tech.durby.pos.print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue

class PrinterScannerTest {
    private fun ip(vararg o: Int) = ByteArray(4) { o[it].toByte() }

    @Test
    fun scansTheOwnSlash24WithoutItselfTheNetworkOrBroadcast() {
        val hosts = PrinterScanner.candidates(ip(192, 168, 64, 37))!!
        assertEquals(253, hosts.size)
        assertEquals("192.168.64.1", hosts.first())
        assertEquals("192.168.64.254", hosts.last())
        assert("192.168.64.37" !in hosts && "192.168.64.0" !in hosts && "192.168.64.255" !in hosts)
    }

    @Test
    fun neverScansAPublicOrSpecialNetwork() {
        assertNull(PrinterScanner.candidates(ip(8, 8, 8, 8)))
        assertNull(PrinterScanner.candidates(ip(100, 64, 0, 5)))
        assertNull(PrinterScanner.candidates(ip(169, 254, 3, 4)))
        val r = PrinterScanner(ownAddress = { ip(8, 8, 8, 8) }, probe = { _, _ -> error("must not probe") }).scan()
        assertEquals(PrinterScanner.Result(null, emptyList()), r)
        assertEquals(PrinterScanner.Result(null, emptyList()), PrinterScanner(ownAddress = { null }).scan())
    }

    @Test
    fun reportsEachAnsweringAddressWithItsStatusInOrder() {
        val tried = ConcurrentLinkedQueue<String>()
        val r = PrinterScanner(
            ownAddress = { ip(10, 0, 0, 5) },
            probe = { host, port ->
                tried += "$host:$port"
                when ("$host:$port") {
                    "10.0.0.20:9100" -> PrinterStatus.parse(0x12, 0x12, 0x12)
                    "10.0.0.3:9100" -> PrinterStatus.parse(0x1A, 0x32, 0x72)
                    "10.0.0.3:9101" -> PrinterStatus(reachable = true, answered = false)
                    else -> null
                }
            },
        ).scan()
        assertEquals("10.0.0.0/24", r.subnet)
        assertEquals(
            listOf(
                PrinterScanner.Found("10.0.0.3", 9100, "paper_out"),
                PrinterScanner.Found("10.0.0.3", 9101, "no_status"),
                PrinterScanner.Found("10.0.0.20", 9100, "online"),
            ),
            r.printers,
        )
        assertEquals(253 * 3, tried.size)
        assert(tried.all { it.substringBefore(':').let(AddressRules::isAllowedHost) })
    }
}
