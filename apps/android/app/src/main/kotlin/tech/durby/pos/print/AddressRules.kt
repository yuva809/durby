package tech.durby.pos.print

/**
 * Where the app may send print jobs (ADR 0032 §7): a dotted-decimal IPv4 literal in 10.0.0.0/8, 172.16.0.0/12 or
 * 192.168.0.0/16, on ports 9100–9102. The same table as packages/shared/src/native-print.ts. Names are never
 * resolved; the socket is opened on the parsed octets, so no spelling can reach the internet or the device itself.
 */
object AddressRules {
    val PORTS = 9100..9102

    private val octet = Regex("^(0|[1-9][0-9]{0,2})$")

    /** The four octets of a dotted-decimal literal, or null for anything else. */
    fun octets(host: String): ByteArray? {
        val parts = host.split('.')
        if (parts.size != 4 || !parts.all { octet.matches(it) }) return null
        val values = parts.map { it.toInt() }
        if (values.any { it > 255 }) return null
        return ByteArray(4) { values[it].toByte() }
    }

    fun isAllowedHost(host: String): Boolean {
        val o = octets(host)?.map { it.toInt() and 0xFF } ?: return false
        return o[0] == 10 || (o[0] == 172 && o[1] in 16..31) || (o[0] == 192 && o[1] == 168)
    }

    fun isAllowedPort(port: Int): Boolean = port in PORTS
}

enum class ImageMode(val key: String) {
    GS_V0("gsV0"),
    ESC_STAR("escStar");

    companion object {
        fun of(key: String): ImageMode? = entries.firstOrNull { it.key == key }
    }
}

/** The bill printer. Version 1 keeps it on the device settings screen; 1.1 gets it from the location's settings. */
data class PrinterConfig(
    val host: String,
    val port: Int,
    val widthDots: Int,
    val cutter: Boolean,
    val imageMode: ImageMode,
) {
    /** The answer code for the first rule this breaks, or null. */
    fun problem(): String? = when {
        !AddressRules.isAllowedHost(host) -> "print.host_not_allowed"
        !AddressRules.isAllowedPort(port) -> "print.port_not_allowed"
        widthDots !in 8..2040 || widthDots % 8 != 0 -> "print.payload_invalid"
        else -> null
    }
}
