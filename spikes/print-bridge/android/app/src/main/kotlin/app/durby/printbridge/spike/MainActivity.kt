package app.durby.printbridge.spike

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread

/** Spike settings screen: printer IP/port/width/cutter, test buttons and the live log. No AndroidX. */
class MainActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var log: TextView
    private val refresh = object : Runnable {
        override fun run() {
            log.text = SpikeLog.lines.joinToString("\n")
            ui.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val cfg = Prefs.load(this)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }

        fun label(res: Int) = root.addView(TextView(this).apply { setText(res) })
        fun field(value: String, type: Int) = EditText(this).apply {
            setText(value); inputType = type; isSingleLine = true
        }.also { root.addView(it, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)) }

        label(R.string.printer_host)
        val host = field(cfg.host, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        label(R.string.printer_port)
        val port = field(cfg.port.toString(), InputType.TYPE_CLASS_NUMBER)
        label(R.string.printer_dots)
        val dots = field(cfg.dots.toString(), InputType.TYPE_CLASS_NUMBER)
        val cutter = CheckBox(this).apply { setText(R.string.printer_cutter); isChecked = cfg.cutter }
        root.addView(cutter)
        val escStar = CheckBox(this).apply { setText(R.string.printer_esc_star); isChecked = cfg.escStar }
        root.addView(escStar)

        fun current() = PrinterConfig(
            host.text.toString().trim(),
            port.text.toString().toIntOrNull() ?: 9100,
            (dots.text.toString().toIntOrNull() ?: 576).coerceIn(8, 2040),
            cutter.isChecked,
            escStar.isChecked,
        )
        fun button(res: Int, action: () -> Unit) = root.addView(Button(this).apply {
            setText(res); setOnClickListener { action() }
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        fun onPrinter(work: (PrinterConfig) -> String) {
            val c = current()
            Prefs.save(this, c)
            if (!c.configured) return SpikeLog.add("set the printer IP first")
            thread { SpikeLog.add(work(c)) }
        }

        button(R.string.save_and_start) {
            Prefs.save(this, current())
            BridgeService.start(this)
            SpikeLog.add("saved ${current()}")
        }
        button(R.string.test_connection) { onPrinter { "test connection: " + TcpPrinter(it.host, it.port).status().summary() } }
        button(R.string.test_print) {
            onPrinter { "test print: " + TcpPrinter(it.host, it.port).send(TestReceipt.bytes(it, null)) }
        }
        button(R.string.test_raster) {
            onPrinter {
                val (h, bits) = EscPos.ruler(it.dots)
                "ruler (${if (it.escStar) "ESC *" else "GS v 0"}): " +
                    TcpPrinter(it.host, it.port).send(EscPos.rasterJob(it.dots, h, bits, it.cutter, it.escStar))
            }
        }
        // Always ESC *, whatever the checkbox says: the retry when the GS v 0 ruler doesn't print.
        button(R.string.test_raster_esc_star) {
            onPrinter {
                val (h, bits) = EscPos.ruler(it.dots)
                "ruler (ESC *): " + TcpPrinter(it.host, it.port).send(EscPos.rasterJob(it.dots, h, bits, it.cutter, escStar = true))
            }
        }
        button(R.string.kick_drawer_pin2) {
            onPrinter { "drawer pin 2: " + TcpPrinter(it.host, it.port).send(EscPos.kickDrawer(pin5 = false)) }
        }
        button(R.string.kick_drawer_pin5) {
            onPrinter { "drawer pin 5: " + TcpPrinter(it.host, it.port).send(EscPos.kickDrawer(pin5 = true)) }
        }

        label(R.string.log_title)
        log = TextView(this).apply { setTextIsSelectable(true); typeface = android.graphics.Typeface.MONOSPACE; textSize = 12f }
        root.addView(log)
        setContentView(ScrollView(this).apply { addView(root) })

        BridgeService.start(this)
    }

    override fun onResume() {
        super.onResume()
        ui.post(refresh)
    }

    override fun onPause() {
        ui.removeCallbacks(refresh)
        super.onPause()
    }
}
