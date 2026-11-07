package tech.durby.pos.print

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class PrintRequestTest {
    private val job = "0195f2a4-7c1e-7d3a-9b2c-4e5f6a7b8c9d"

    private fun image(width: Int, height: Int, bytes: Int = (width + 7) / 8 * height) =
        JSONObject().put("width", width).put("height", height)
            .put("data", Base64.getEncoder().encodeToString(ByteArray(bytes)))

    private fun print(patch: (JSONObject) -> Unit = {}) =
        JSONObject().put("version", 1).put("type", "print").put("jobId", job).put("image", image(384, 10))
            .also(patch).toString()

    @Test
    fun readsAPrintRequest() {
        val r = PrintRequest.parse(print()) as PrintRequest.Print
        assertEquals(job, r.jobId)
        assertEquals(384, r.width)
        assertEquals(10, r.height)
        assertEquals(480, r.bits.size)
    }

    @Test
    fun readsInfo() {
        assertTrue(PrintRequest.parse("""{"version":1,"type":"info"}""") is PrintRequest.Info)
    }

    @Test
    fun ignoresAPrinterFromThePageInVersion1() {
        val r = PrintRequest.parse(print { it.put("printer", JSONObject().put("host", "8.8.8.8").put("port", 80)) })
        assertTrue(r is PrintRequest.Print)
    }

    @Test
    fun refusesBadRequests() {
        val bad = listOf(
            "not json",
            """{"version":2,"type":"info"}""",
            """{"version":1,"type":"raw"}""",
            print { it.put("jobId", "job-1") },
            print { it.put("image", image(384, 10, 479)) },
            print { it.put("image", image(384, 10).put("data", "%%%")) },
            print { it.put("image", image(4096, 10)) },
            print { it.put("image", image(384, 50_000)) }, // over 2 MB
        )
        bad.forEach { assertEquals(it, PrintRequest.Invalid, PrintRequest.parse(it)) }
    }

    @Test
    fun knowsTheJobIdOfABadPrintSoTheWebCanMatchTheAnswer() {
        assertEquals(job, PrintRequest.jobIdOf(print { it.put("image", image(384, 10, 1)) }))
    }
}
