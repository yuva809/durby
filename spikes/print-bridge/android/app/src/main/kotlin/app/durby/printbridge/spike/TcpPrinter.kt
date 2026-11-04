package app.durby.printbridge.spike

import java.io.IOException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/** Result of one job: whether all bytes were written and flushed, how long it took, and why not. */
data class SendResult(val ok: Boolean, val code: String, val millis: Long, val detail: String? = null)

/**
 * A raw TCP (port 9100) ESC/POS printer. One connection per job, closed afterwards, so DISH POS can use the
 * same printer in between. Pure JVM sockets: tested against a fake printer.
 */
class TcpPrinter(
    private val host: String,
    private val port: Int,
    private val connectTimeoutMs: Int = 3_000,
    private val writeTimeoutMs: Int = 10_000,
    private val statusTimeoutMs: Int = 500,
) {
    fun send(bytes: ByteArray): SendResult {
        val start = System.currentTimeMillis()
        fun took() = System.currentTimeMillis() - start
        val socket = Socket()
        return try {
            socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
            // SO_TIMEOUT only bounds reads; a stalled write is bounded by a watchdog closing the socket.
            val watchdog = Thread {
                try {
                    Thread.sleep(writeTimeoutMs.toLong())
                    socket.close()
                } catch (_: InterruptedException) {
                }
            }.apply { isDaemon = true; start() }
            try {
                socket.getOutputStream().apply {
                    write(bytes)
                    flush()
                }
            } finally {
                watchdog.interrupt()
            }
            SendResult(true, "sent", took())
        } catch (e: SocketTimeoutException) {
            SendResult(false, "bridge.printer_timeout", took(), e.message)
        } catch (e: ConnectException) {
            SendResult(false, "bridge.printer_unreachable", took(), e.message)
        } catch (e: IOException) {
            val code = if (socket.isConnected) "bridge.printer_closed_connection" else "bridge.printer_unreachable"
            SendResult(false, code, took(), e.message)
        } finally {
            runCatching { socket.close() }
        }
    }

    /** Connects and asks DLE EOT 1, 2, 4. Many printers answer; some network ones don't, which is not an error. */
    fun status(): PrinterStatus {
        val socket = Socket()
        return try {
            socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
            socket.soTimeout = statusTimeoutMs
            val out = socket.getOutputStream()
            val inp = socket.getInputStream()
            fun ask(n: Int): Int? = try {
                out.write(EscPos.statusQuery(n))
                out.flush()
                inp.read().takeIf { it >= 0 }
            } catch (_: SocketTimeoutException) {
                null
            }
            val printer = ask(1) ?: return PrinterStatus(reachable = true, answered = false)
            PrinterStatus.parse(printer, ask(2), ask(4))
        } catch (e: IOException) {
            PrinterStatus(reachable = false, answered = false, error = e.javaClass.simpleName + ": " + e.message)
        } finally {
            runCatching { socket.close() }
        }
    }
}
