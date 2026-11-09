package tech.durby.pos.update

import org.json.JSONException
import org.json.JSONObject

/**
 * `/downloads/android/latest.json` on the app's own server (ADR 0033 §14): the newest version, the APK's file name
 * next to it and its SHA-256. Read strictly: anything odd means "no update", never a download from elsewhere.
 */
data class UpdateManifest(
    val versionCode: Int,
    val versionName: String,
    val apk: String,
    val sha256: String,
) {
    /** The APK's address: always on [origin], in the same folder as the manifest. */
    fun apkUrl(origin: String): String = "$origin$PATH$apk"

    companion object {
        const val PATH = "/downloads/android/"
        const val MANIFEST = "latest.json"
        const val MAX_MANIFEST_BYTES = 4 * 1024
        private val KEYS = setOf("versionCode", "versionName", "apk", "sha256")
        private val VERSION_NAME = Regex("^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$")
        private val APK = Regex("^durby-[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.apk$")
        private val SHA256 = Regex("^[0-9a-f]{64}$")

        fun manifestUrl(origin: String) = "$origin$PATH$MANIFEST"

        fun parse(text: String): UpdateManifest? = try {
            val json = JSONObject(text)
            val code = json.opt("versionCode") as? Int
            val name = json.opt("versionName") as? String
            val apk = json.opt("apk") as? String
            val sha = json.opt("sha256") as? String
            when {
                json.keys().asSequence().any { it !in KEYS } -> null
                code == null || code < 1 -> null
                name == null || !VERSION_NAME.matches(name) -> null
                apk == null || !APK.matches(apk) -> null
                sha == null || !SHA256.matches(sha) -> null
                else -> UpdateManifest(code, name, apk, sha)
            }
        } catch (_: JSONException) {
            null
        }
    }
}
