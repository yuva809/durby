package tech.durby.pos.print

import org.json.JSONArray
import org.json.JSONObject

/**
 * Answers the page's messages (protocol version 1). The same job id never prints twice once it was sent, while a
 * failed one may be retried with its id (docs/modules/android-app.md → Duplicates). The printer comes with each job
 * (the location's, from Durby) and is checked against the address rules here, every time. Jobs for different
 * printers may run at the same time ([PrintDispatcher]); one printer's jobs come one after another.
 */
class PrintService internal constructor(
    private val appVersion: String,
    private val scanner: () -> PrinterScanner.Result,
    private val settings: DeviceSettingsStore = InMemoryDeviceSettings(),
    private val onSettingsChanged: (DeviceSettings) -> Unit = {},
    private val allowLoopbackForTests: Boolean = false,
) {
    constructor(
        appVersion: String,
        scanner: () -> PrinterScanner.Result,
        settings: DeviceSettingsStore,
        onSettingsChanged: (DeviceSettings) -> Unit,
    ) : this(appVersion, scanner, settings, onSettingsChanged, false)

    /** Job ids already sent, newest last; the oldest are forgotten past [REMEMBERED_JOBS]. Guarded by itself. */
    private val sent = object : LinkedHashMap<String, Unit>(16, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?) = size > REMEMBERED_JOBS
    }

    fun handle(message: String): String = handle(PrintRequest.parse(message), message)

    /** [request] parsed from [message]; [message] only names the job of an invalid print. */
    fun handle(request: PrintRequest, message: String): String = when (request) {
        PrintRequest.Info -> JSONObject()
            .put("type", "info")
            .put("appVersion", appVersion)
            .put("protocol", PrintRequest.PROTOCOL)
            .put("features", JSONArray(FEATURES))
            .toString()

        PrintRequest.Discover -> discover()

        PrintRequest.GetSettings -> settingsAnswer(settings.load(), refused = false)

        is PrintRequest.SetSettings -> synchronized(settings) {
            settings.save(request.settings)
            onSettingsChanged(request.settings)
            settingsAnswer(request.settings, refused = false)
        }

        PrintRequest.SettingsRefused -> settingsAnswer(settings.load(), refused = true)

        PrintRequest.Invalid -> answer(PrintRequest.jobIdOf(message), TcpPrinter.Sent("print.payload_invalid", nothingPrinted = true))

        is PrintRequest.Print -> answer(request.jobId, print(request))
    }

    private fun print(request: PrintRequest.Print): TcpPrinter.Sent {
        if (synchronized(sent) { request.jobId in sent }) return TcpPrinter.Sent("print.sent", nothingPrinted = false)
        val config = request.printer
        val problem = config.problem()
        val loopbackTest = allowLoopbackForTests && config.host == "127.0.0.1"
        if (problem != null && !(loopbackTest && problem == "print.host_not_allowed")) {
            return TcpPrinter.Sent(problem, nothingPrinted = true)
        }
        if (request.width > config.widthDots) return TcpPrinter.Sent("print.payload_invalid", nothingPrinted = true)

        val job = EscPos.rasterJob(
            request.width,
            request.height,
            request.bits,
            cutter = config.cutter,
            escStar = config.imageMode == ImageMode.ESC_STAR,
        )
        val result = TcpPrinter(AddressRules.octets(config.host)!!, config.port).print(job)
        if (result.code == "print.sent") synchronized(sent) { sent[request.jobId] = Unit }
        return result
    }

    private fun discover(): String {
        val result = scanner()
        val printers = JSONArray()
        result.printers.forEach {
            printers.put(JSONObject().put("host", it.host).put("port", it.port).put("status", it.status))
        }
        return JSONObject()
            .put("type", "discover")
            .put("subnet", result.subnet ?: JSONObject.NULL)
            .put("printers", printers)
            .toString()
    }

    private fun settingsAnswer(current: DeviceSettings, refused: Boolean): String = JSONObject()
        .put("type", "deviceSettings")
        .put("settings", current.toJson())
        .apply { if (refused) put("refused", true) }
        .toString()

    private fun answer(jobId: String?, result: TcpPrinter.Sent): String = JSONObject()
        .put("type", "print")
        .put("jobId", jobId ?: JSONObject.NULL)
        .put("state", if (result.code == "print.sent") "sent" else "failed")
        .put("code", result.code)
        .apply { if (result.code != "print.sent" && result.nothingPrinted) put("nothingPrinted", true) }
        .toString()

    companion object {
        const val REMEMBERED_JOBS = 500

        /** `NATIVE_APP_FEATURES` in packages/shared/src/native-print.ts. */
        val FEATURES = listOf("parallel", "deviceSettings", "nothingPrinted")

        /** The lane a request runs in: one per printer address, so printers print at the same time. */
        fun laneOf(request: PrintRequest): String = when (request) {
            is PrintRequest.Print -> "printer ${request.printer.host}:${request.printer.port}"
            PrintRequest.Discover -> "discover"
            else -> "control"
        }
    }
}
