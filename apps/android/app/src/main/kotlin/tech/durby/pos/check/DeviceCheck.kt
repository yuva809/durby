package tech.durby.pos.check

/** What the app reads about the device on every start (ADR 0032 §14). Pure, so the decision is tested on the JVM. */
data class DeviceFacts(
    val model: String,
    val android: String,
    val sdk: Int,
    val webViewPackage: String?,
    val webViewVersion: String?,
    val chromeVersion: String?,
    val appVersion: String,
    val printLink: Boolean,
    val startScript: Boolean,
)

enum class Problem {
    /** No system WebView, or its version can't be read. */
    WEBVIEW_UNKNOWN,

    /** Older than [DeviceCheck.MIN_WEBVIEW_MAJOR]: Durby's pages don't render. */
    WEBVIEW_TOO_OLD,

    /** No origin-restricted message listener: bills can't reach the printer. */
    NO_PRINT_LINK,

    /** No document-start scripts: kitchen tickets and slips can't open the print screen. */
    NO_START_SCRIPT,
}

object DeviceCheck {
    /** Next.js 16 and Tailwind v4 need Chrome 111 or newer (ADR 0032); measured on emulators in A0. */
    const val MIN_WEBVIEW_MAJOR = 111

    /** "125.0.6422.186" → 125; null when it can't be read. */
    fun majorVersion(version: String?): Int? = version?.substringBefore('.')?.trim()?.toIntOrNull()

    fun problems(facts: DeviceFacts): List<Problem> = buildList {
        val major = majorVersion(facts.webViewVersion)
        when {
            facts.webViewPackage == null || major == null -> add(Problem.WEBVIEW_UNKNOWN)
            major < MIN_WEBVIEW_MAJOR -> add(Problem.WEBVIEW_TOO_OLD)
        }
        if (!facts.printLink) add(Problem.NO_PRINT_LINK)
        if (!facts.startScript) add(Problem.NO_START_SCRIPT)
    }

    /** The lines for the photo: plain facts, the same in every language. */
    fun report(facts: DeviceFacts, problems: List<Problem>): String = buildString {
        appendLine("Device:   ${facts.model}")
        appendLine("Android:  ${facts.android} (API ${facts.sdk})")
        appendLine("WebView:  ${facts.webViewPackage ?: "-"} ${facts.webViewVersion ?: "-"} (needs $MIN_WEBVIEW_MAJOR+)")
        appendLine("Chrome:   ${facts.chromeVersion ?: "not installed"}")
        appendLine("App:      ${facts.appVersion}")
        append("Result:   ${if (problems.isEmpty()) "OK" else problems.joinToString(", ")}")
    }
}
