package tech.durby.pos.print

import org.json.JSONException
import org.json.JSONObject
import java.util.Base64

/** A message from the page (protocol version 1, packages/shared/src/native-print.ts). Anything odd is Invalid. */
sealed interface PrintRequest {
    data object Info : PrintRequest

    data object Discover : PrintRequest

    /** Reads this device's settings (version 1.1). */
    data object GetSettings : PrintRequest

    /** Stores this device's settings, already checked against the shared schema (version 1.1). */
    class SetSettings(val settings: DeviceSettings) : PrintRequest

    /** Asks whether a newer app version is on the server (version 1.1, `update` feature). */
    data object CheckUpdate : PrintRequest

    /** Downloads, checks and hands the newer version to Android's installer, which asks the user (version 1.1). */
    data object InstallUpdate : PrintRequest

    /** A settings write the shared schema doesn't allow: nothing is stored, the stored settings are answered. */
    data object SettingsRefused : PrintRequest

    /**
     * [bits]: 1 bit per dot, row-major, rows padded to whole bytes, MSB = leftmost dot, 1 = black. [printer] is the
     * location's printer as the page sent it: not yet checked against the address rules ([PrinterConfig.problem]).
     */
    class Print(
        val jobId: String,
        val width: Int,
        val height: Int,
        val bits: ByteArray,
        val printer: PrinterConfig,
    ) : PrintRequest

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
                    "discover" -> Discover
                    "print" -> print(json)
                    "deviceSettings" -> if (json.length() == 2) GetSettings else Invalid
                    "setDeviceSettings" -> setSettings(json)
                    "update" -> if (json.length() == 2) CheckUpdate else Invalid
                    "installUpdate" -> if (json.length() == 2) InstallUpdate else Invalid
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
            val printer = printer(json.optJSONObject("printer") ?: return Invalid) ?: return Invalid
            return Print(jobId, width, height, bits, printer)
        }

        private fun setSettings(json: JSONObject): PrintRequest {
            if (json.length() != 3) return SettingsRefused
            val settings = DeviceSettings.parse(json.optJSONObject("settings") ?: return SettingsRefused)
            return settings?.let { SetSettings(it) } ?: SettingsRefused
        }

        /** The printer's fields with their types; the address rules are checked by the service, with their own codes. */
        private fun printer(json: JSONObject): PrinterConfig? {
            val host = json.opt("host") as? String ?: return null
            val port = json.opt("port") as? Int ?: return null
            val widthDots = json.opt("widthDots") as? Int ?: return null
            val cutter = json.opt("cutter") as? Boolean ?: return null
            val mode = ImageMode.of(json.opt("imageMode") as? String ?: return null) ?: return null
            return PrinterConfig(host, port, widthDots, cutter, mode)
        }
    }
}
