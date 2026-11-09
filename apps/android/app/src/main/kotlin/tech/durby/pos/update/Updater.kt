package tech.durby.pos.update

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** What the page's `update` and `installUpdate` messages need; a fake in tests. */
interface AppUpdates {
    /** The newer version on the server, or null (none, or the check failed). */
    fun check(): UpdateManifest?

    /** `installing` (Android asks the user), `needs_permission` (the user allows installing from Durby first) or an `update.*` code. */
    fun install(): String
}

/**
 * The in-app updater (ADR 0033 §14): never installs by itself. It reads `latest.json` from the app's own server only,
 * downloads the APK named there from the same folder, checks its SHA-256 and that it is signed with this app's own key
 * and is this app at that version, then hands it to Android's installer, which asks the user to confirm.
 */
class Updater(
    private val activity: Activity,
    private val origin: String,
    private val currentVersionCode: Int,
) : AppUpdates {
    override fun check(): UpdateManifest? = fetchManifest()?.takeIf { it.versionCode > currentVersionCode }

    override fun install(): String {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            // Once per device: Android's "Install unknown apps" screen for Durby; then Update now again.
            activity.runOnUiThread {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                )
            }
            return "needs_permission"
        }
        val release = check() ?: return "update.none"
        val apk = File(File(activity.cacheDir, "updates").apply { mkdirs() }, release.apk)
        try {
            download(release.apkUrl(origin), apk, MAX_APK_BYTES)
            if (sha256(apk) != release.sha256) return fail(apk, "update.checksum")
            val archive = archiveInfo(apk) ?: return fail(apk, "update.invalid")
            if (archive.packageName != activity.packageName || versionCodeOf(archive) != release.versionCode.toLong()) {
                return fail(apk, "update.invalid")
            }
            if (!sameSigner(archive)) return fail(apk, "update.signature")
            commit(apk)
            return "installing"
        } catch (e: IOException) {
            Log.w(TAG, "update download failed: ${e.javaClass.simpleName}")
            return fail(apk, "update.download")
        }
    }

    private fun fail(apk: File, code: String): String {
        apk.delete()
        return code
    }

    private fun fetchManifest(): UpdateManifest? = try {
        val text = ByteArrayOutputStreamLimited(UpdateManifest.MAX_MANIFEST_BYTES).use { out ->
            open(UpdateManifest.manifestUrl(origin)).use { it.copyTo(out) }
            out.toString()
        }
        UpdateManifest.parse(text)
    } catch (_: IOException) {
        null
    }

    private fun open(url: String): InputStream {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.setRequestProperty("Cache-Control", "no-cache")
        if (connection.responseCode != 200) {
            connection.disconnect()
            throw IOException("HTTP ${connection.responseCode}")
        }
        return connection.inputStream
    }

    private fun download(url: String, target: File, limit: Long) {
        target.delete()
        open(url).use { input ->
            target.outputStream().use { out ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    total += n
                    if (total > limit) throw IOException("too large")
                    out.write(buffer, 0, n)
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun archiveInfo(apk: File): PackageInfo? = activity.packageManager.getPackageArchiveInfo(
        apk.path,
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES,
    )

    @Suppress("DEPRECATION")
    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    /** The APK is signed by exactly the certificates this installed app is signed by. */
    private fun sameSigner(archive: PackageInfo): Boolean {
        val installed = activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        val mine = installed.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
        val theirs = archive.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
        return mine != null && mine.isNotEmpty() && mine == theirs
    }

    /** Hands the APK to Android's installer; Android shows its own confirmation ([StatusReceiver]). */
    private fun commit(apk: File) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            .apply { setAppPackageName(activity.packageName) }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("durby.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val status = Intent(ACTION_STATUS).setPackage(activity.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(activity, id, status, flags).intentSender)
        }
        apk.delete()
    }

    /** Opens Android's confirmation when the installer asks for it; logs the outcome. */
    class StatusReceiver(private val activity: Activity) : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                    activity.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                else -> Log.i(TAG, "update install status $status")
            }
        }

        fun register() {
            val filter = IntentFilter(ACTION_STATUS)
            if (Build.VERSION.SDK_INT >= 33) {
                activity.registerReceiver(this, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                activity.registerReceiver(this, filter)
            }
        }
    }

    companion object {
        private const val TAG = "DurbyApp"
        private const val ACTION_STATUS = "tech.durby.pos.UPDATE_STATUS"
        const val MAX_APK_BYTES = 50L * 1024 * 1024

        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    digest.update(buffer, 0, n)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

/** A byte buffer that refuses to grow past [limit] (a manifest is a few hundred bytes). */
private class ByteArrayOutputStreamLimited(private val limit: Int) : java.io.ByteArrayOutputStream() {
    override fun write(b: ByteArray, off: Int, len: Int) {
        if (size() + len > limit) throw IOException("too large")
        super.write(b, off, len)
    }

    override fun write(b: Int) {
        if (size() + 1 > limit) throw IOException("too large")
        super.write(b)
    }

    override fun toString(): String = toString(Charsets.UTF_8.name())
}
