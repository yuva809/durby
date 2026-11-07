package tech.durby.pos.engine

import android.content.Intent
import android.view.View

/**
 * The browser engine behind the app (ADR 0032 §14). Today the system WebView; GeckoView can replace it behind
 * this interface if the device check fails on a customer's device, without touching the screens or the printing.
 */
interface WebEngine {
    val view: View

    fun load(url: String)

    fun reload()

    fun canGoBack(): Boolean

    fun goBack()

    /** Kitchen tickets, slips and QR cards: the page as it is now, through Android's print screen. */
    fun openPrintScreen(jobName: String)

    /** The result of a file chooser the engine asked [Host.chooseFiles] to start. */
    fun onFilesChosen(resultCode: Int, data: Intent?)

    fun onPause()

    fun destroy()

    /** What the engine needs from the activity. */
    interface Host {
        /** A message from the page's print object; [reply] goes back to that page only. */
        fun onPrintMessage(message: String, reply: (String) -> Unit)

        /** A link outside the allow-list: open it in the browser. */
        fun openExternally(url: String)

        /** Durby's page could not load (offline, DNS, TLS). */
        fun onLoadFailed(description: String)

        fun onPageLoaded()

        fun chooseFiles(intent: Intent)
    }
}
