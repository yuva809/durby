package tech.durby.pos.print

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * A raw TCP (port 9100) ESC/POS printer. One connection per job, closed afterwards, so the restaurant's other till
 * can use the same printer in between. Asks for status first: paper out or cover open stops the job before
 * anything prints; a printer that doesn't answer status (many don't) still gets the job.
 */
class TcpPrinter(
    private val address: ByteArray,
    private val port: Int,
    private val connectTimeoutMs: Int = 3_000,
    private val writeTimeoutMs: Long = 10_000,
    private val statusTimeoutMs: Int = 500,
) {
    /** Sends [job]; returns an answer code (`print.*`). */
    fun print(job: ByteArray): String {
        val socket = Socket()
        try {
            try {
                socket.connect(InetSocketAddress(InetAddress.getByAddress(address), port), connectTimeoutMs)
            } catch (_: SocketTimeoutException) {
                return "print.printer_timeout"
            } catch (_: IOException) {
                return "print.printer_unreachable"
            }

            val status = try {
                status(socket)
            } catch (_: IOException) {
                return "print.printer_disconnected"
            }
            if (status?.coverOpen == true) return "print.cover_open"
            if (status?.paperOut == true) return "print.paper_out"

            // A socket read timeout doesn't bound writes: a watchdog closes the socket if writing stalls.
            val stalled = java.util.concurrent.atomic.AtomicBoolean(false)
            val watchdog = Thread {
                try {
                    Thread.sleep(writeTimeoutMs)
                    stalled.set(true)
                    socket.close()
                } catch (_: InterruptedException) {
                }
            }.apply { isDaemon = true; start() }
            return try {
                socket.getOutputStream().apply {
                    write(job)
                    flush()
                }
                "print.sent"
            } catch (_: IOException) {
                if (stalled.get()) "print.printer_timeout" else "print.printer_disconnected"
            } finally {
                watchdog.interrupt()
            }
        } finally {
            runCatching { socket.close() }
        }
    }

    /** Connects and asks for status only: null when nothing answers on the port, else what the printer said. */
    fun query(): PrinterStatus? {
        val socket = Socket()
        return try {
            socket.connect(InetSocketAddress(InetAddress.getByAddress(address), port), connectTimeoutMs)
            status(socket) ?: PrinterStatus(reachable = true, answered = false)
        } catch (_: IOException) {
            null
        } finally {
            runCatching { socket.close() }
        }
    }

    /** DLE EOT 1, 2, 4. Null when the printer doesn't answer the first one. */
    private fun status(socket: Socket): PrinterStatus? {
        socket.soTimeout = statusTimeoutMs
        val out = socket.getOutputStream()
        val inp = socket.getInputStream()
        fun ask(n: Int): Int? {
            out.write(EscPos.statusQuery(n))
            out.flush()
            return try {
                inp.read().takeIf { it >= 0 }
            } catch (_: SocketTimeoutException) {
                null
            }
        }
        val printer = ask(1) ?: return null
        return PrinterStatus.parse(printer, ask(2), ask(4))
    }
}
