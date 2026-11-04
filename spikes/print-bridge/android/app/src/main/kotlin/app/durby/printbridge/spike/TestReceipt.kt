package app.durby.printbridge.spike

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The bridge's own test receipt: ESC/POS text, ASCII only, so it works on any ESC/POS printer. */
object TestReceipt {
    fun bytes(cfg: PrinterConfig, origin: String?, now: Date = Date()): ByteArray {
        val cols = if (cfg.dots <= 384) 32 else 48
        val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(now)
        return EscPos.concat(
            EscPos.INIT,
            EscPos.align(1), EscPos.bold(true), EscPos.line("PRINT BRIDGE TEST"), EscPos.bold(false),
            EscPos.line("-".repeat(cols)),
            EscPos.align(0),
            EscPos.line("Printer: ${cfg.host}:${cfg.port}"),
            EscPos.line("Width:   ${cfg.dots} dots, $cols columns"),
            EscPos.line("Cutter:  ${if (cfg.cutter) "yes" else "no"}"),
            EscPos.line("From:    ${origin ?: "bridge app"}"),
            EscPos.line("Time:    $time"),
            EscPos.line("-".repeat(cols)),
            EscPos.line("0123456789".repeat(cols / 10 + 1).take(cols)),
            EscPos.feed(1),
            if (cfg.cutter) EscPos.cut(3) else EscPos.feed(4),
        )
    }
}
