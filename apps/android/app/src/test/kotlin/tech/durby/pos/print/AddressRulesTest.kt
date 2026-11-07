package tech.durby.pos.print

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** The same table as packages/shared/src/native-print.test.ts: the web and the app must agree. */
class AddressRulesTest {
    private val fixture = JSONObject(File(System.getProperty("durby.addressFixture")!!).readText())

    private fun strings(path: String, key: String) =
        fixture.getJSONObject(path).getJSONArray(key).let { a -> (0 until a.length()).map { a.getString(it) } }

    private fun ints(path: String, key: String) =
        fixture.getJSONObject(path).getJSONArray(key).let { a -> (0 until a.length()).map { a.getInt(it) } }

    @Test
    fun acceptsPrivateIpv4Literals() {
        val accepted = strings("hosts", "accepted")
        assertEquals(accepted, accepted.filter { AddressRules.isAllowedHost(it) })
    }

    @Test
    fun refusesEverythingElse() {
        val refused = strings("hosts", "refused")
        assertEquals(emptyList<String>(), refused.filter { AddressRules.isAllowedHost(it) })
    }

    @Test
    fun acceptsOnlyPrinterPorts() {
        assertEquals(ints("ports", "accepted"), ints("ports", "accepted").filter { AddressRules.isAllowedPort(it) })
        assertEquals(emptyList<Int>(), ints("ports", "refused").filter { AddressRules.isAllowedPort(it) })
    }

    @Test
    fun printerConfigNamesTheBrokenRule() {
        val ok = PrinterConfig("192.168.64.20", 9100, 384, cutter = true, imageMode = ImageMode.GS_V0)
        assertEquals(null, ok.problem())
        assertEquals("print.host_not_allowed", ok.copy(host = "printer.local").problem())
        assertEquals("print.port_not_allowed", ok.copy(port = 80).problem())
        assertEquals("print.payload_invalid", ok.copy(widthDots = 380).problem())
    }
}
