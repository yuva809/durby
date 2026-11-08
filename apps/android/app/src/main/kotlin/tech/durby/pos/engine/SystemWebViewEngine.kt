package tech.durby.pos.engine

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.print.PrintManager
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import tech.durby.pos.BuildConfig
import tech.durby.pos.Servers

/** The device's system WebView (Android System WebView or Chrome), checked by DeviceCheck before it is used. */
@SuppressLint("SetJavaScriptEnabled")
class SystemWebViewEngine(context: Context, private val host: WebEngine.Host) : WebEngine {
    private val web = WebView(context)
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val main = Handler(Looper.getMainLooper())

    /**
     * The WebView keeps new cookies in memory and wrote them to disk only on onPause: an app killed without a pause
     * (power cut, crash, Android freeing memory) lost the sign-in, and the refresh token rotates, so a stale one on disk
     * would not sign in either. Writing every few seconds and after each page load keeps the disk current; a write
     * with nothing changed costs nothing.
     */
    private val flushing = object : Runnable {
        override fun run() {
            flushCookies()
            main.postDelayed(this, COOKIE_FLUSH_MS)
        }
    }

    override val view: View get() = web

    init {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        // Sign-in survives restarts: the refresh cookie is kept and written to disk (see [flushCookies]).
        CookieManager.getInstance().setAcceptCookie(true)
        main.postDelayed(flushing, COOKIE_FLUSH_MS)

        val origins = Servers.ALLOWED_ORIGINS
        // The print object exists only on allow-listed pages (ADR 0032 §8); frames from anywhere else never see it.
        WebViewCompat.addWebMessageListener(web, PRINT_OBJECT, origins) {
                _: WebView, message: WebMessageCompat, _: Uri, isMainFrame: Boolean, reply: JavaScriptReplyProxy ->
            val text = message.data
            if (isMainFrame && text != null) host.onPrintMessage(text) { answer -> reply.postMessage(answer) }
        }
        // window.print() does nothing in a WebView (ADR 0032 §10): send it to the app, which opens the print screen.
        WebViewCompat.addDocumentStartJavaScript(web, PRINT_SCREEN_SCRIPT, origins)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (Servers.isAllowed(request.url)) return false
                host.openExternally(request.url.toString())
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                // A redirect off the allow-list (not a link the user tapped) is stopped too.
                if (!Servers.isAllowed(Uri.parse(url))) {
                    view.stopLoading()
                    host.openExternally(url)
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                flushCookies()
                host.onPageLoaded()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) host.onLoadFailed("${error.errorCode} ${error.description}")
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                host.chooseFiles(params.createIntent())
                return true
            }
        }
    }

    override fun load(url: String) = web.loadUrl(url)

    override fun reload() = web.reload()

    override fun canGoBack() = web.canGoBack()

    override fun goBack() = web.goBack()

    override fun openPrintScreen(jobName: String) {
        val printManager = web.context.getSystemService(Context.PRINT_SERVICE) as PrintManager
        printManager.print(jobName, web.createPrintDocumentAdapter(jobName), null)
    }

    override fun onFilesChosen(resultCode: Int, data: Intent?) {
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        fileCallback = null
    }

    override fun onPause() = flushCookies()

    override fun destroy() {
        main.removeCallbacks(flushing)
        flushCookies()
        web.destroy()
    }

    private fun flushCookies() = CookieManager.getInstance().flush()

    companion object {
        const val PRINT_OBJECT = "durbyPrint"

        /** How often cookies are written to disk while the app runs. */
        const val COOKIE_FLUSH_MS = 10_000L

        fun printLinkSupported() = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

        fun startScriptSupported() = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

        private const val PRINT_SCREEN_SCRIPT = """
            (function () {
              window.print = function () {
                if (window.$PRINT_OBJECT) $PRINT_OBJECT.postMessage('{"version":1,"type":"printScreen"}');
              };
            })();
        """
    }
}
