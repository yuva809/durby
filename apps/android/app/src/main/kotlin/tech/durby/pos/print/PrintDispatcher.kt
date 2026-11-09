package tech.durby.pos.print

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Runs the page's messages off the main thread (ADR 0033, version 1.1): one thread reads each message, then it runs
 * in its lane ([PrintService.laneOf]): one per printer, so a slow kitchen printer never holds up the bar, while one
 * printer's jobs stay in order. Find printer and the small messages have lanes of their own.
 */
class PrintDispatcher(
    private val service: PrintService,
    private val newLane: () -> ExecutorService = { Executors.newSingleThreadExecutor() },
) {
    private val reader = newLane()
    private val lanes = HashMap<String, ExecutorService>()

    /** Answers [message] through [reply], on a background thread. */
    fun submit(message: String, reply: (String) -> Unit) {
        reader.execute {
            val request = PrintRequest.parse(message)
            lane(PrintService.laneOf(request)).execute { reply(service.handle(request, message)) }
        }
    }

    @Synchronized
    private fun lane(key: String): ExecutorService {
        lanes[key]?.let { return it }
        // A location has a handful of printers; past that, the rest share one lane rather than open more threads.
        val chosen = if (lanes.size < MAX_LANES) key else OVERFLOW
        return lanes.getOrPut(chosen) { newLane() }
    }

    @Synchronized
    fun shutdown() {
        reader.shutdownNow()
        lanes.values.forEach { it.shutdownNow() }
    }

    private companion object {
        const val MAX_LANES = 16
        const val OVERFLOW = "overflow"
    }
}
