package tech.durby.pos.print

import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Find printer (ADR 0032 §14): the device's own /24, if it is private, on ports 9100–9102. Short connect timeouts,
 * a few dozen at a time, so a full scan takes a few seconds. Only addresses the rules accept are ever tried.
 */
class PrinterScanner(
    private val ownAddress: () -> ByteArray? = ::privateIpv4,
    private val probe: (host: String, port: Int) -> PrinterStatus? = { host, port ->
        TcpPrinter(AddressRules.octets(host)!!, port, connectTimeoutMs = CONNECT_TIMEOUT_MS).query()
    },
    private val parallelism: Int = 32,
) {
    data class Found(val host: String, val port: Int, val status: String)

    data class Result(val subnet: String?, val printers: List<Found>)

    fun scan(): Result {
        val own = ownAddress() ?: return Result(null, emptyList())
        val hosts = candidates(own) ?: return Result(null, emptyList())
        val o = own.map { it.toInt() and 0xFF }
        val subnet = "${o[0]}.${o[1]}.${o[2]}.0/24"
        val pool = Executors.newFixedThreadPool(parallelism)
        try {
            val tasks = hosts.flatMap { host ->
                AddressRules.PORTS.map { port ->
                    Callable { probe(host, port)?.let { Found(host, port, statusOf(it)) } }
                }
            }
            val found = pool.invokeAll(tasks, SCAN_LIMIT_SECONDS, TimeUnit.SECONDS)
                .mapNotNull { f -> runCatching { f.get() }.getOrNull() }
            return Result(subnet, found.sortedWith(compareBy({ lastOctet(it.host) }, { it.port })))
        } finally {
            pool.shutdownNow()
        }
    }

    companion object {
        const val CONNECT_TIMEOUT_MS = 300
        const val SCAN_LIMIT_SECONDS = 15L

        /** Every other address of [own]'s /24 (no network, broadcast or own address); null if [own] is not private. */
        fun candidates(own: ByteArray): List<String>? {
            val o = own.map { it.toInt() and 0xFF }
            val self = o.joinToString(".")
            if (!AddressRules.isAllowedHost(self)) return null
            return (1..254).filter { it != o[3] }.map { "${o[0]}.${o[1]}.${o[2]}.$it" }
        }

        fun statusOf(status: PrinterStatus): String = when {
            !status.answered -> "no_status"
            status.coverOpen -> "cover_open"
            status.paperOut -> "paper_out"
            else -> "online"
        }

        private fun lastOctet(host: String) = host.substringAfterLast('.').toInt()

        /** The first private IPv4 address of an interface that is up (Wi-Fi or Ethernet). */
        fun privateIpv4(): ByteArray? = runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .map { it.address }
                .firstOrNull { AddressRules.isAllowedHost(it.joinToString(".") { b -> (b.toInt() and 0xFF).toString() }) }
        }.getOrNull()
    }
}
