package tech.durby.pos

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import tech.durby.pos.check.DeviceCheck
import tech.durby.pos.check.DeviceFacts
import tech.durby.pos.engine.SystemWebViewEngine
import tech.durby.pos.engine.WebEngine
import tech.durby.pos.print.PrintService
import tech.durby.pos.print.PrinterScanner
import java.util.concurrent.Executors

/**
 * The whole app (ADR 0032 §14): check the device, then Durby full screen. Screens of its own only when the device
 * can't run Durby or Durby can't be reached; both in German and English, because they show before any sign-in.
 */
class MainActivity : Activity(), WebEngine.Host {
    private val main = Handler(Looper.getMainLooper())
    private val printing = Executors.newSingleThreadExecutor()
    private val printService = PrintService(BuildConfig.VERSION_NAME, scanner = { PrinterScanner().scan() })
    private var engine: WebEngine? = null

    /** The WebView version this process started with; after a Play Store update it differs (see [onResume]). */
    private var startedWithWebView: String? = null

    /** True while the device check screen is shown: coming back to the app checks again by itself. */
    private var checking = false

    /** Set when the app goes to the background (the Play Store opened); the next resume checks again. */
    private var away = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        start()
    }

    private fun start() {
        val facts = readFacts()
        if (startedWithWebView == null) startedWithWebView = facts.webViewVersion
        val problems = DeviceCheck.problems(facts)
        checking = problems.isNotEmpty()
        // Device facts only (no user data): what support needs from `adb logcat -s DurbyApp`.
        Log.i(TAG, "device check: ${facts.webViewPackage} ${facts.webViewVersion} -> ${problems.ifEmpty { "OK" }}")
        if (problems.isNotEmpty()) {
            val store = playStore()
            val update = if (store && DeviceCheck.fixableByUpdate(problems)) DeviceCheck.updatePackage(facts.webViewPackage) else null
            showDeviceCheck(DeviceCheck.report(facts, problems), update)
            return
        }
        val e = engine ?: SystemWebViewEngine(this, this).also { engine = it }
        (e.view.parent as? LinearLayout)?.removeView(e.view)
        setContentView(e.view)
        e.load(Servers.START_URL)
    }

    private fun readFacts(): DeviceFacts {
        val webView = runCatching { WebViewCompat.getCurrentWebViewPackage(this) }.getOrNull()
        // Reading the features needs a working WebView; a broken provider counts as "not supported".
        val printLink = webView != null && runCatching { SystemWebViewEngine.printLinkSupported() }.getOrDefault(false)
        val startScript = webView != null && runCatching { SystemWebViewEngine.startScriptSupported() }.getOrDefault(false)
        val chrome = runCatching { packageManager.getPackageInfo("com.android.chrome", 0).versionName }.getOrNull()
        return DeviceFacts(
            model = "${Build.MANUFACTURER} ${Build.MODEL}",
            android = Build.VERSION.RELEASE,
            sdk = Build.VERSION.SDK_INT,
            webViewPackage = webView?.packageName,
            webViewVersion = webView?.versionName,
            chromeVersion = chrome,
            appVersion = BuildConfig.VERSION_NAME,
            printLink = printLink,
            startScript = startScript,
        )
    }

    // --- Print object -----------------------------------------------------------------------------------------

    override fun onPrintMessage(message: String, reply: (String) -> Unit) {
        val type = runCatching { JSONObject(message).optString("type") }.getOrNull()
        if (type == "printScreen") {
            engine?.openPrintScreen(getString(R.string.app_name))
            return
        }
        // Network and printer work never runs on the main thread; answers go back on it.
        printing.execute {
            val answer = printService.handle(message)
            main.post { reply(answer) }
        }
    }

    override fun openExternally(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            // No browser: nothing to open it with; the page stays where it is.
        }
    }

    override fun onLoadFailed(description: String) = showOffline(description)

    override fun onPageLoaded() {}

    override fun chooseFiles(intent: Intent) {
        try {
            startActivityForResult(intent, PICK_FILES)
        } catch (_: ActivityNotFoundException) {
            engine?.onFilesChosen(RESULT_CANCELED, null)
        }
    }

    @Deprecated("Activity result API needs AndroidX activity; this app keeps to the platform.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == PICK_FILES) engine?.onFilesChosen(resultCode, data)
        else super.onActivityResult(requestCode, resultCode, data)
    }

    @Deprecated("Back is handled for the web page's history first.")
    override fun onBackPressed() {
        val e = engine
        if (e != null && e.view.parent != null && e.canGoBack()) e.goBack() else super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        if (!checking || !away) return
        away = false
        val now = runCatching { WebViewCompat.getCurrentWebViewPackage(this)?.versionName }.getOrNull()
        if (now != startedWithWebView) {
            // The WebView was updated while we were away. This process may still hold the old one, so start afresh.
            restartApp()
        } else {
            start()
        }
    }

    private fun restartApp() {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return start()
        startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        Runtime.getRuntime().exit(0)
    }

    /** The Play Store is installed, enabled and can open an app page. */
    private fun playStore(): Boolean {
        val enabled = runCatching { packageManager.getApplicationInfo(PLAY_STORE, 0).enabled }.getOrDefault(false)
        return enabled && marketIntent(DeviceCheck.GOOGLE_WEBVIEW).resolveActivity(packageManager) != null
    }

    private fun marketIntent(pkg: String) =
        Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg")).setPackage(PLAY_STORE)

    override fun onPause() {
        super.onPause()
        away = true
        engine?.onPause()
    }

    override fun onDestroy() {
        engine?.destroy()
        printing.shutdownNow()
        super.onDestroy()
    }

    // --- Own screens --------------------------------------------------------------------------------------------

    /**
     * One screen with everything needed from a photo: what to do (de, en) and the facts. With the Play Store, a large
     * "Update now" first; coming back from the store checks again by itself ([onResume]).
     */
    private fun showDeviceCheck(report: String, updatePackage: String?) {
        val update = updatePackage?.let { pkg ->
            getString(R.string.update_now) to {
                try {
                    startActivity(marketIntent(pkg))
                } catch (_: ActivityNotFoundException) {
                    start()
                }
            }
        }
        screen(
            title = getString(R.string.check_title_de) + "\n" + getString(R.string.check_title_en),
            body = if (update != null) {
                getString(R.string.update_body_de) + "\n\n" + getString(R.string.update_body_en)
            } else {
                getString(R.string.check_body_de) + "\n\n" + getString(R.string.check_body_en)
            },
            details = report,
            button = getString(R.string.check_again),
            accent = Color.rgb(0xB0, 0x00, 0x20),
            primary = update,
        ) { start() }
    }

    private fun showOffline(description: String) {
        screen(
            title = getString(R.string.offline_title_de) + "\n" + getString(R.string.offline_title_en),
            body = getString(R.string.offline_body_de) + "\n\n" + getString(R.string.offline_body_en),
            details = description,
            button = getString(R.string.try_again),
            accent = Color.DKGRAY,
        ) { start() }
    }

    private fun screen(
        title: String,
        body: String,
        details: String,
        button: String,
        accent: Int,
        primary: Pair<String, () -> Unit>? = null,
        onButton: () -> Unit,
    ) {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.WHITE)
        }
        column.addView(TextView(this).apply {
            text = title
            textSize = 24f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
            setBackgroundColor(accent)
            setPadding(pad, pad, pad, pad)
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        column.addView(TextView(this).apply {
            text = body
            textSize = 18f
            setTextColor(Color.BLACK)
            setPadding(0, pad, 0, pad)
        })
        primary?.let { (label, action) ->
            column.addView(Button(this).apply {
                text = label
                textSize = 24f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.rgb(0x1A, 0x73, 0xE8))
                setPadding(pad * 2, pad, pad * 2, pad)
                setOnClickListener { action() }
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = pad })
        }
        column.addView(TextView(this).apply {
            text = details
            textSize = 16f
            typeface = Typeface.MONOSPACE
            setTextColor(Color.BLACK)
            setTextIsSelectable(true)
        })
        column.addView(Button(this).apply {
            text = button
            textSize = 18f
            setOnClickListener { onButton() }
        }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
            topMargin = pad
            gravity = Gravity.START
        })
        engine?.view?.let { (it.parent as? android.view.ViewGroup)?.removeView(it) }
        setContentView(ScrollView(this).apply { addView(column) })
        column.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    companion object {
        private const val PICK_FILES = 1
        private const val TAG = "DurbyApp"
        private const val PLAY_STORE = "com.android.vending"
    }
}
