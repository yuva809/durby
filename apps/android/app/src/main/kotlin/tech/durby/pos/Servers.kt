package tech.durby.pos

import android.net.Uri

/**
 * Where the app goes (ADR 0032 §4, §14). Version 1 starts at staging, fixed in the build; the print object and the
 * print-screen script exist only for these origins, and every other link opens in the browser.
 */
object Servers {
    const val START_URL = "https://staging.durby.tech/"

    val ALLOWED_ORIGINS: Set<String> = setOf("https://staging.durby.tech", "https://app.durby.tech")

    /** "https://staging.durby.tech" for any URL there; exact scheme and host, default port only. */
    fun originOf(uri: Uri): String? {
        if (uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.port != -1 || uri.userInfo != null) return null
        return "https://${uri.host}"
    }

    fun isAllowed(uri: Uri): Boolean = originOf(uri) in ALLOWED_ORIGINS
}
