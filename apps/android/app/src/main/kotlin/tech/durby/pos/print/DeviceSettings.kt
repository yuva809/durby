package tech.durby.pos.print

import android.content.Context
import org.json.JSONException
import org.json.JSONObject

/**
 * This device's settings (ADR 0033 §5, §13; `nativeDeviceSettingsSchema` in packages/shared/src/native-print.ts),
 * kept in the app's own storage because the web never uses browser storage. Ids are only remembered here: the page
 * checks them against the location's printers every time.
 */
data class DeviceSettings(
    /** "This device prints": runs print jobs, and keeps the screen on while Durby is in front. */
    val prints: Boolean = true,
    /** The location this device prints for; null: the page's own choice (the floor shown last). */
    val tillLocationId: String? = null,
    /** The default receipt printer per location (location id → printer id). */
    val receiptPrinters: Map<String, String> = emptyMap(),
) {
    fun toJson(): JSONObject = JSONObject()
        .put("prints", prints)
        .put("tillLocationId", tillLocationId ?: JSONObject.NULL)
        .put("receiptPrinters", JSONObject(receiptPrinters))

    companion object {
        const val MAX_RECEIPT_PRINTERS = 50
        private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        private val KEYS = setOf("prints", "tillLocationId", "receiptPrinters")

        /** The settings in [json] exactly as the shared schema allows them, else null (nothing is stored). */
        fun parse(json: JSONObject): DeviceSettings? {
            if (json.keys().asSequence().any { it !in KEYS }) return null
            val prints = json.opt("prints") as? Boolean ?: return null
            val till = when (val v = json.opt("tillLocationId")) {
                JSONObject.NULL -> null
                is String -> v.takeIf { UUID.matches(it) } ?: return null
                else -> return null
            }
            val printers = json.opt("receiptPrinters") as? JSONObject ?: return null
            val map = mutableMapOf<String, String>()
            for (key in printers.keys()) {
                val value = printers.opt(key) as? String ?: return null
                if (!UUID.matches(key) || !UUID.matches(value)) return null
                map[key] = value
            }
            if (map.size > MAX_RECEIPT_PRINTERS) return null
            return DeviceSettings(prints, till, map)
        }
    }
}

/** Where [DeviceSettings] live; in memory for tests. */
interface DeviceSettingsStore {
    fun load(): DeviceSettings
    fun save(settings: DeviceSettings)
}

class InMemoryDeviceSettings(private var current: DeviceSettings = DeviceSettings()) : DeviceSettingsStore {
    override fun load() = current
    override fun save(settings: DeviceSettings) {
        current = settings
    }
}

/** The app's private preferences. A stored value that no longer reads gives the defaults. */
class PrefsDeviceSettings(context: Context) : DeviceSettingsStore {
    private val prefs = context.getSharedPreferences("device", Context.MODE_PRIVATE)

    override fun load(): DeviceSettings {
        val raw = prefs.getString(KEY, null) ?: return DeviceSettings()
        return try {
            DeviceSettings.parse(JSONObject(raw)) ?: DeviceSettings()
        } catch (_: JSONException) {
            DeviceSettings()
        }
    }

    override fun save(settings: DeviceSettings) {
        // commit, not apply: the answer says "stored", and a till may be switched off right after.
        prefs.edit().putString(KEY, settings.toJson().toString()).commit()
    }

    private companion object {
        const val KEY = "settings"
    }
}
