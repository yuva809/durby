package tech.durby.pos.print

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceSettingsTest {
    private val location = "0190a000-0000-7000-8000-000000000101"
    private val printer = "0190a000-0000-7000-8000-000000000301"

    @Test
    fun readsWhatItWrites() {
        val settings = DeviceSettings(prints = false, tillLocationId = location, receiptPrinters = mapOf(location to printer))
        assertEquals(settings, DeviceSettings.parse(JSONObject(settings.toJson().toString())))
        assertEquals(DeviceSettings(), DeviceSettings.parse(DeviceSettings().toJson()))
    }

    @Test
    fun refusesWhatTheSharedSchemaRefuses() {
        val ok = DeviceSettings().toJson()
        assertNull(DeviceSettings.parse(JSONObject(ok.toString()).put("extra", 1)))
        assertNull(DeviceSettings.parse(JSONObject(ok.toString()).apply { remove("prints") }))
        assertNull(DeviceSettings.parse(JSONObject(ok.toString()).put("tillLocationId", "x")))
        assertNull(DeviceSettings.parse(JSONObject(ok.toString()).put("receiptPrinters", JSONObject().put(location, 5))))
        val many = JSONObject()
        repeat(51) { many.put("0190a000-0000-7000-8000-${it.toString().padStart(12, '0')}", printer) }
        assertNull(DeviceSettings.parse(JSONObject(ok.toString()).put("receiptPrinters", many)))
    }
}
