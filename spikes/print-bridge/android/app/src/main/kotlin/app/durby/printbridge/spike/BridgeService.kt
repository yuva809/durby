package app.durby.printbridge.spike

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList

const val BRIDGE_PORT = 17890

object Prefs {
    private const val NAME = "printer"

    fun load(ctx: Context): PrinterConfig = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).run {
        PrinterConfig(
            getString("host", "") ?: "", getInt("port", 9100), getInt("dots", 576), getBoolean("cutter", true),
            getBoolean("escStar", false),
        )
    }

    fun save(ctx: Context, cfg: PrinterConfig) = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).edit()
        .putString("host", cfg.host.trim()).putInt("port", cfg.port).putInt("dots", cfg.dots)
        .putBoolean("cutter", cfg.cutter).putBoolean("escStar", cfg.escStar).apply()
}

/** In-memory log the activity shows (spike only; the real app keeps no request contents). */
object SpikeLog {
    val lines = CopyOnWriteArrayList<String>()
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.ROOT)

    fun add(msg: String) {
        lines.add(0, "${fmt.format(Date())} $msg")
        while (lines.size > 200) lines.removeAt(lines.size - 1)
    }
}

/** Foreground service holding the loopback server: Android 8+ stops plain background services. */
class BridgeService : Service() {
    private var server: LocalServer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val cfg = Prefs.load(this)
        val text = getString(R.string.notification_text, BRIDGE_PORT,
            if (cfg.configured) "${cfg.host}:${cfg.port}" else getString(R.string.not_configured))
        val notification = notification(text)
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(1, notification)
        }
        if (server == null) {
            server = LocalServer(
                port = BRIDGE_PORT,
                config = { Prefs.load(this) },
                asset = { name -> runCatching { assets.open(name).use { it.readBytes() } }.getOrNull() },
                log = SpikeLog::add,
            ).also {
                try {
                    it.start()
                } catch (e: Exception) {
                    SpikeLog.add("could not listen on $BRIDGE_PORT: $e")
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        SpikeLog.add("service stopped")
        super.onDestroy()
    }

    private fun notification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel("bridge", getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
        )
        return Notification.Builder(this, "bridge")
            .setSmallIcon(android.R.drawable.ic_menu_send)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .build()
    }

    companion object {
        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, BridgeService::class.java))
        }
    }
}

/** Starts the bridge after the till reboots, without anyone opening the app. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            SpikeLog.add("boot completed: starting bridge")
            BridgeService.start(context)
        }
    }
}
