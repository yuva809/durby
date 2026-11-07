package tech.durby.pos.check

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCheckTest {
    private val sunmi = DeviceFacts(
        model = "SUNMI T2s Lite",
        android = "9",
        sdk = 28,
        webViewPackage = "com.android.webview",
        webViewVersion = "125.0.6422.186",
        chromeVersion = "125.0.6422.186",
        appVersion = "1.0.0",
        printLink = true,
        startScript = true,
    )

    @Test
    fun aCurrentWebViewWithBothFeaturesGoesStraightToDurby() {
        assertEquals(emptyList<Problem>(), DeviceCheck.problems(sunmi))
        assertEquals(emptyList<Problem>(), DeviceCheck.problems(sunmi.copy(webViewVersion = "111.0.5563.116")))
    }

    @Test
    fun theStockAndroid9WebViewIsTooOld() {
        // Measured on the Android 9 emulator in A0: WebView 66, no message listener.
        val stock = sunmi.copy(webViewVersion = "66.0.3359.158", printLink = false, startScript = false)
        assertEquals(
            listOf(Problem.WEBVIEW_TOO_OLD, Problem.NO_PRINT_LINK, Problem.NO_START_SCRIPT),
            DeviceCheck.problems(stock),
        )
        assertEquals(listOf(Problem.WEBVIEW_TOO_OLD), DeviceCheck.problems(sunmi.copy(webViewVersion = "110.0.1")))
    }

    @Test
    fun anUnreadableWebViewIsAProblemNotACrash() {
        assertEquals(listOf(Problem.WEBVIEW_UNKNOWN), DeviceCheck.problems(sunmi.copy(webViewVersion = "dev")))
        assertEquals(listOf(Problem.WEBVIEW_UNKNOWN), DeviceCheck.problems(sunmi.copy(webViewPackage = null)))
    }

    @Test
    fun theReportNamesEverythingNeededFromOnePhoto() {
        val text = DeviceCheck.report(sunmi.copy(webViewVersion = "66.0"), listOf(Problem.WEBVIEW_TOO_OLD))
        listOf("SUNMI T2s Lite", "API 28", "com.android.webview 66.0", "needs 111+", "Chrome:   125", "1.0.0", "WEBVIEW_TOO_OLD")
            .forEach { assertTrue(it, text.contains(it)) }
    }

    @Test
    fun theUpdateOpensThePackageThatProvidesTheWebView() {
        assertEquals("com.google.android.webview", DeviceCheck.updatePackage("com.google.android.webview"))
        assertEquals("com.android.chrome", DeviceCheck.updatePackage("com.android.chrome"))
        // The plain AOSP WebView isn't in the Play Store; Google's is the one to install.
        assertEquals("com.google.android.webview", DeviceCheck.updatePackage("com.android.webview"))
        assertEquals("com.google.android.webview", DeviceCheck.updatePackage(null))
    }
}
