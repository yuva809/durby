package tech.durby.pos.print

import org.json.JSONException
import org.json.JSONObject
import java.util.Base64

/** A message from the page (protocol version 1, packages/shared/src/native-print.ts). Anything odd is Invalid. */
sealed interface PrintRequest {
    data object Info : PrintRequest

    /** [bits]: 1 bit per dot, row-major, rows padded to whole bytes, MSB = leftmost dot, 1 = black. */
    class Print(val jobId: String, val width: Int, val height: Int, val bits: ByteArray) : PrintRequest

    data object Invalid : PrintRequest

    companion object {
        const val PROTOCOL = 1
        const val MAX_IMAGE_BYTES = 2 * 1024 * 1024
        private const val MAX_BASE64_LENGTH = (MAX_IMAGE_BYTES + 2) / 3 * 4
        private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        fun parse(message: String): PrintRequest = try {
            val json = JSONObject(message)
            if (json.optInt("version", -1) != PROTOCOL) {
                Invalid
            } else {
                when (json.optString("type")) {
                    "info" -> Info
                    // A `printer` from the page is ignored in version 1: the device's printer is used.
                    "print" -> print(json)
                    else -> Invalid
                }
            }
        } catch (_: JSONException) {
            Invalid
        }

        /** The job id of a print message, even an invalid one, so its answer reaches the right tap. */
        fun jobIdOf(message: String): String? = try {
            JSONObject(message).optString("jobId").takeIf { UUID.matches(it) }
        } catch (_: JSONException) {
            null
        }

        private fun print(json: JSONObject): PrintRequest {
            val jobId = json.optString("jobId")
            val image = json.optJSONObject("image") ?: return Invalid
            val width = image.optInt("width", -1)
            val height = image.optInt("height", -1)
            val data = image.optString("data")
            if (!UUID.matches(jobId) || width !in 8..2040 || height !in 1..20_000) return Invalid
            if (data.length > MAX_BASE64_LENGTH) return Invalid
            val bits = try {
                Base64.getDecoder().decode(data)
            } catch (_: IllegalArgumentException) {
                return Invalid
            }
            if (bits.size != (width + 7) / 8 * height || bits.size > MAX_IMAGE_BYTES) return Invalid
            return Print(jobId, width, height, bits)
        }
    }
}
