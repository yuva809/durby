package app.durby.printbridge.spike

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

data class PrinterConfig(
    val host: String,
    val port: Int,
    val dots: Int,
    val cutter: Boolean,
    /** Raster as ESC * stripes instead of GS v 0 (printers without GS v 0). */
    val escStar: Boolean = false,
) {
    val configured get() = host.isNotBlank()
}

/**
 * Spike HTTP/1.1 server on 127.0.0.1 only (never the LAN). Answers CORS and Private Network Access
 * preflights for ANY origin and logs it: the spike's job is to see what Chrome sends. The real bridge
 * allows only paired origins with a token (docs/modules/print-bridge.md §3).
 */
class LocalServer(
    private val port: Int,
    private val config: () -> PrinterConfig,
    private val asset: (String) -> ByteArray?,
    private val log: (String) -> Unit,
) {
    private var server: ServerSocket? = null
    private val pool = Executors.newFixedThreadPool(4)
    private val printLock = Any()
    private val jobs = ConcurrentHashMap<String, JSONObject>()

    fun start() {
        if (server != null) return
        val s = ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"))
        server = s
        Thread({
            log("listening on 127.0.0.1:$port")
            while (!s.isClosed) {
                val client = try { s.accept() } catch (_: Exception) { break }
                pool.execute { handle(client) }
            }
        }, "bridge-accept").apply { isDaemon = true; start() }
    }

    fun stop() {
        runCatching { server?.close() }
        server = null
    }

    private class Request(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray)

    private fun handle(socket: Socket) = socket.use {
        socket.soTimeout = 15_000
        val inp = BufferedInputStream(socket.getInputStream())
        val out = socket.getOutputStream()
        val req = try { read(inp) } catch (e: Exception) {
            respond(out, null, 400, json("code" to "bridge.bad_request", "message" to e.message)); return
        } ?: return
        val origin = req.headers["origin"]
        if (req.method == "OPTIONS") {
            log("preflight ${req.path} origin=$origin pna=${req.headers["access-control-request-private-network"]} " +
                "headers=${req.headers["access-control-request-headers"]}")
            respond(out, origin, 204, null)
            return
        }
        log("${req.method} ${req.path} origin=$origin ua=${req.headers["user-agent"]?.take(120)}")
        try {
            route(req, out, origin)
        } catch (e: Exception) {
            log("error: $e")
            respond(out, origin, 500, json("code" to "bridge.internal", "message" to e.toString()))
        }
    }

    private fun route(req: Request, out: OutputStream, origin: String?) {
        val cfg = config()
        when ("${req.method} ${req.path.substringBefore('?')}") {
            "GET /", "GET /index.html" -> respondAsset(out, origin, "index.html", "text/html; charset=utf-8")
            "GET /spike.js" -> respondAsset(out, origin, "spike.js", "text/javascript; charset=utf-8")
            "GET /health" -> respond(out, origin, 200, json(
                "ok" to true, "spike" to true, "version" to "0.0.1-spike",
                "printer" to JSONObject().put("configured", cfg.configured).put("host", cfg.host)
                    .put("port", cfg.port).put("dots", cfg.dots).put("cutter", cfg.cutter).put("escStar", cfg.escStar),
            ))
            "GET /status" -> {
                if (!cfg.configured) return respond(out, origin, 409, notConfigured())
                val st = TcpPrinter(cfg.host, cfg.port).status()
                log("status: ${st.summary()}")
                respond(out, origin, 200, json("state" to st.summary(), "reachable" to st.reachable, "answered" to st.answered))
            }
            "POST /print/test" -> print(out, origin, null, cfg) { TestReceipt.bytes(it, origin) }
            "POST /print/ruler" -> print(out, origin, null, cfg) {
                val (h, bits) = EscPos.ruler(it.dots)
                EscPos.rasterJob(it.dots, h, bits, it.cutter, it.escStar)
            }
            "POST /print/raster" -> {
                val body = JSONObject(String(req.body, Charsets.UTF_8))
                val width = body.getInt("width")
                val height = body.getInt("height")
                val bits = Base64.getDecoder().decode(body.getString("data"))
                val jobId = body.optString("jobId").ifBlank { null }
                print(out, origin, jobId, cfg) { EscPos.rasterJob(width, height, bits, it.cutter, it.escStar) }
            }
            else -> respond(out, origin, 404, json("code" to "bridge.not_found", "message" to req.path))
        }
    }

    /** Serial: one job on the printer at a time. Same jobId again returns the first result unprinted. */
    private fun print(out: OutputStream, origin: String?, jobId: String?, cfg: PrinterConfig, build: (PrinterConfig) -> ByteArray) {
        if (!cfg.configured) return respond(out, origin, 409, notConfigured())
        if (jobId != null) jobs[jobId]?.let {
            log("duplicate job $jobId: not printed again")
            return respond(out, origin, 200, JSONObject(it.toString()).put("duplicate", true))
        }
        val bytes = build(cfg)
        val result = synchronized(printLock) {
            if (jobId != null) jobs[jobId]?.let { return@synchronized null }
            TcpPrinter(cfg.host, cfg.port).send(bytes)
        } ?: return respond(out, origin, 200, JSONObject(jobs[jobId]!!.toString()).put("duplicate", true))
        log("print ${bytes.size} B → ${result.code} in ${result.millis} ms ${result.detail ?: ""}")
        val body = json("jobId" to jobId, "state" to if (result.ok) "sent" else "failed", "code" to result.code,
            "bytes" to bytes.size, "millis" to result.millis, "detail" to result.detail)
        if (jobId != null) jobs[jobId] = body
        respond(out, origin, if (result.ok) 200 else 502, body)
    }

    private fun notConfigured() = json("code" to "bridge.not_configured", "message" to "Set the printer IP in the app")

    private fun json(vararg pairs: Pair<String, Any?>) = JSONObject().apply { pairs.forEach { (k, v) -> put(k, v ?: JSONObject.NULL) } }

    private fun respondAsset(out: OutputStream, origin: String?, name: String, type: String) {
        val bytes = asset(name) ?: return respond(out, origin, 404, json("code" to "bridge.not_found"))
        write(out, origin, 200, type, bytes)
    }

    private fun respond(out: OutputStream, origin: String?, status: Int, body: JSONObject?) =
        write(out, origin, status, "application/json", body?.toString()?.toByteArray() ?: ByteArray(0))

    private fun write(out: OutputStream, origin: String?, status: Int, type: String, body: ByteArray) {
        val reason = mapOf(200 to "OK", 204 to "No Content", 400 to "Bad Request", 404 to "Not Found",
            409 to "Conflict", 413 to "Payload Too Large", 500 to "Internal Server Error", 502 to "Bad Gateway")[status] ?: "Status"
        val head = StringBuilder("HTTP/1.1 $status $reason\r\n")
        if (origin != null) {
            head.append("Access-Control-Allow-Origin: $origin\r\n")
            head.append("Vary: Origin\r\n")
            head.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
            head.append("Access-Control-Allow-Headers: Content-Type, Authorization, Idempotency-Key\r\n")
            head.append("Access-Control-Allow-Private-Network: true\r\n")
            head.append("Access-Control-Max-Age: 600\r\n")
        }
        head.append("Cache-Control: no-store\r\n")
        if (status != 204) head.append("Content-Type: $type\r\nContent-Length: ${body.size}\r\n")
        head.append("Connection: close\r\n\r\n")
        out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
        if (status != 204) out.write(body)
        out.flush()
    }

    private fun read(inp: InputStream): Request? {
        val headerBytes = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            val b = inp.read()
            if (b < 0) return null
            headerBytes.write(b)
            last4 = (last4 shl 8) or b
            if (last4 == 0x0D0A0D0A) break
            require(headerBytes.size() < 16_384) { "headers too large" }
        }
        val lines = headerBytes.toString(Charsets.ISO_8859_1.name()).split("\r\n").filter { it.isNotEmpty() }
        val (method, path) = lines.first().split(" ").let { it[0] to it[1] }
        val headers = lines.drop(1).mapNotNull { l ->
            val i = l.indexOf(':')
            if (i > 0) l.substring(0, i).trim().lowercase() to l.substring(i + 1).trim() else null
        }.toMap()
        val length = headers["content-length"]?.toInt() ?: 0
        require(length <= MAX_BODY) { "body too large" }
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = inp.read(body, read, length - read)
            require(n >= 0) { "body truncated" }
            read += n
        }
        return Request(method, path, headers, body)
    }

    companion object {
        const val MAX_BODY = 2 * 1024 * 1024
    }
}
