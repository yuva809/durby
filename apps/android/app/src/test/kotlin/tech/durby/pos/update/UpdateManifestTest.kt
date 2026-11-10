package tech.durby.pos.update

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateManifestTest {
    private val sha = "a".repeat(64)
    private fun json(vararg pairs: Pair<String, Any>) = JSONObject(mapOf(*pairs)).toString()
    private val ok = arrayOf("versionCode" to 3, "versionName" to "1.1.1", "apk" to "durby-1.1.1.apk", "sha256" to sha)

    @Test
    fun readsTheManifestAndBuildsTheApkAddressOnTheSameServer() {
        val m = UpdateManifest.parse(json(*ok))!!
        assertEquals(UpdateManifest(3, "1.1.1", "durby-1.1.1.apk", sha), m)
        assertEquals("https://staging.durby.tech/downloads/android/durby-1.1.1.apk", m.apkUrl("https://staging.durby.tech"))
        assertEquals("https://staging.durby.tech/downloads/android/latest.json", UpdateManifest.manifestUrl("https://staging.durby.tech"))
    }

    @Test
    fun anythingOddMeansNoUpdate() {
        val bad = listOf(
            json(*ok, "url" to "https://evil.test/x.apk"),
            json(*ok.filter { it.first != "sha256" }.toTypedArray()),
            json(*ok.map { if (it.first == "apk") "apk" to "../durby-1.1.1.apk" else it }.toTypedArray()),
            json(*ok.map { if (it.first == "apk") "apk" to "https://evil.test/durby-1.1.1.apk" else it }.toTypedArray()),
            json(*ok.map { if (it.first == "sha256") "sha256" to "A".repeat(64) else it }.toTypedArray()),
            json(*ok.map { if (it.first == "versionCode") "versionCode" to "3" else it }.toTypedArray()),
            json(*ok.map { if (it.first == "versionCode") "versionCode" to 0 else it }.toTypedArray()),
            json(*ok.map { if (it.first == "versionName") "versionName" to "1.1" else it }.toTypedArray()),
            "not json",
        )
        bad.forEach { assertNull(it, UpdateManifest.parse(it)) }
    }
}
