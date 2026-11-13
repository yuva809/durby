package tech.durby.pos

import android.net.Uri

/**
 * Where the app goes (ADR 0032 §4, §14). The start URL is fixed in the build: app.durby.tech since ADR 0039 (older
 * builds start at staging.durby.tech, which now redirects there). The print object and the print-screen script exist
 * only for these origins, and every other link opens in the browser.
 */
object Servers {
    val ORIGINS = Origins(BuildConfig.DEV_ORIGIN)

    val START_URL: String get() = ORIGINS.startUrl

    val ALLOWED_ORIGINS: Set<String> get() = ORIGINS.allowed

    /** "https://app.durby.tech" for any URL there; scheme, host and port must match an allowed origin exactly. */
    fun originOf(uri: Uri): String? {
        if (uri.host.isNullOrEmpty() || uri.userInfo != null) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "${uri.scheme}://${uri.host}$port"
    }

    fun isAllowed(uri: Uri): Boolean = originOf(uri) in ALLOWED_ORIGINS
}

/** Pure, so the release allow-list is tested on the JVM. [devOrigin] is empty in release builds. */
class Origins(devOrigin: String) {
    private val dev = devOrigin.takeIf { it.isNotEmpty() }

    val allowed: Set<String> = PRODUCTION + listOfNotNull(dev)

    val startUrl: String = (dev ?: APP) + "/"

    companion object {
        /** Production's main domain (ADR 0039). */
        const val APP = "https://app.durby.tech"

        /** The former domain: it redirects to [APP], and older builds still start there. */
        const val STAGING = "https://staging.durby.tech"
        val PRODUCTION: Set<String> = setOf(APP, STAGING)
    }
}
