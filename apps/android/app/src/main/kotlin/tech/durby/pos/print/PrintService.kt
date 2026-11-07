package tech.durby.pos.print

import org.json.JSONObject

/**
 * Answers the page's messages (protocol version 1). One job at a time; the same job id never prints twice once it
 * was sent, while a failed one may be retried with its id (docs/modules/android-app.md → Duplicates).
 */
class PrintService internal constructor(
    private val appVersion: String,
    private val printer: () -> PrinterConfig?,
    private val allowLoopbackForTests: Boolean,
) {
    constructor(appVersion: String, printer: () -> PrinterConfig?) : this(appVersion, printer, false)

    /** Job ids already sent, newest last; the oldest are forgotten past [REMEMBERED_JOBS]. */
    private val sent = object : LinkedHashMap<String, Unit>(16, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?) = size > REMEMBERED_JOBS
    }

    @Synchronized
    fun handle(message: String): String = when (val request = PrintRequest.parse(message)) {
        PrintRequest.Info -> JSONObject()
            .put("type", "info")
            .put("appVersion", appVersion)
            .put("protocol", PrintRequest.PROTOCOL)
            .put("printer", printer()?.let { JSONObject().put("widthDots", it.widthDots) } ?: JSONObject.NULL)
            .toString()

        PrintRequest.Invalid -> answer(PrintRequest.jobIdOf(message), "print.payload_invalid")

        is PrintRequest.Print -> answer(request.jobId, print(request))
    }

    private fun print(request: PrintRequest.Print): String {
        if (request.jobId in sent) return "print.sent"
        val config = printer() ?: return "print.no_printer"
        val problem = config.problem()
        val loopbackTest = allowLoopbackForTests && config.host == "127.0.0.1"
        if (problem != null && !(loopbackTest && problem == "print.host_not_allowed")) return problem
        if (request.width > config.widthDots) return "print.payload_invalid"

        val job = EscPos.rasterJob(
            request.width,
            request.height,
            request.bits,
            cutter = config.cutter,
            escStar = config.imageMode == ImageMode.ESC_STAR,
        )
        val code = TcpPrinter(AddressRules.octets(config.host)!!, config.port).print(job)
        if (code == "print.sent") sent[request.jobId] = Unit
        return code
    }

    private fun answer(jobId: String?, code: String): String = JSONObject()
        .put("type", "print")
        .put("jobId", jobId ?: JSONObject.NULL)
        .put("state", if (code == "print.sent") "sent" else "failed")
        .put("code", code)
        .toString()

    companion object {
        const val REMEMBERED_JOBS = 500
    }
}
