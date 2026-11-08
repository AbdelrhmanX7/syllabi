package studio.syllabi.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/** The installer reads the downloaded APK through this provider (res/xml/update_paths.xml). A
 *  subclass so its manifest entry can never collide with a library's own androidx FileProvider. */
class UpdateFileProvider : FileProvider()

// In-app update for the sideloaded APK — the native half of lib/platform/app-update.ts.
//
// The page reads the release feed (via the Rust `update_feed` command), decides an update is due and
// calls `window.StudyUpdater.start(url, sha256, versionCode)`. This class downloads the APK into the
// app cache, checks its sha256 against the feed, checks the archive really is this package at a
// higher versionCode, and opens the system installer on a FileProvider content:// URI. Android
// refuses an update signed by another key, and an update in place keeps the app's data.
// If "Install unknown apps" is off for Study, the system settings page for it opens first and the
// install continues from onResume.
//
// Progress reaches the page as `study-update` CustomEvents ({state, received, total, message}).
// The interface is visible to every frame of the WebView, so nothing here trusts the caller: the URL
// must be on the release bucket, and the installer's own same-signature rule is the final gate.
class AppUpdater(private val activity: Activity) {
  private var webView: WebView? = null
  private val busy = AtomicBoolean(false)
  private var pendingApk: File? = null
  private var awaitingPermission = false

  fun attach(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "StudyUpdater")
  }

  fun detach() {
    webView = null
  }

  /** Back from the unknown-sources settings page (or any other app): continue a parked install. */
  fun onResume() {
    emit(JSONObject().put("state", "resume"))
    if (!awaitingPermission) return
    awaitingPermission = false
    val apk = pendingApk ?: return
    if (canInstall()) {
      launchInstaller(apk)
    } else {
      pendingApk = null
      busy.set(false)
      emitError("Study is not allowed to install updates. Allow \"Install unknown apps\" for Study and try again.")
    }
  }

  inner class Bridge {
    @JavascriptInterface
    fun versionCode(): Long = installedVersionCode()

    @JavascriptInterface
    fun start(url: String, sha256: String, versionCode: String): Boolean {
      val expectedCode = versionCode.toLongOrNull() ?: return false
      if (!url.startsWith(RELEASES_PREFIX) || !url.endsWith(".apk") || url.contains("..")) return false
      if (!SHA256_PATTERN.matches(sha256)) return false
      if (expectedCode <= installedVersionCode()) return false
      if (!busy.compareAndSet(false, true)) return true
      Thread({ download(url, sha256.lowercase(), expectedCode) }, "study-update").start()
      return true
    }
  }

  private fun installedVersionCode(): Long = try {
    PackageInfoCompat.getLongVersionCode(activity.packageManager.getPackageInfo(activity.packageName, 0))
  } catch (error: Exception) {
    -1L
  }

  private fun canInstall(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

  private fun download(url: String, sha256: String, expectedCode: Long) {
    try {
      val dir = File(activity.cacheDir, UPDATE_DIR).apply { mkdirs() }
      dir.listFiles()?.forEach { it.delete() }
      val apk = File(dir, "study-$expectedCode.apk")

      val connection = URL(url).openConnection() as HttpURLConnection
      connection.connectTimeout = 20_000
      connection.readTimeout = 30_000
      connection.setRequestProperty("Cache-Control", "no-cache")
      val digest = MessageDigest.getInstance("SHA-256")
      try {
        if (connection.responseCode !in 200..299) throw IOException("Download failed (HTTP ${connection.responseCode})")
        val total = connection.contentLengthLong
        var received = 0L
        var lastEmit = 0L
        connection.inputStream.use { input ->
          apk.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              output.write(buffer, 0, read)
              digest.update(buffer, 0, read)
              received += read
              val now = SystemClock.elapsedRealtime()
              if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                lastEmit = now
                emit(JSONObject().put("state", "downloading").put("received", received).put("total", total))
              }
            }
          }
        }
        emit(JSONObject().put("state", "downloading").put("received", received).put("total", total))
      } finally {
        connection.disconnect()
      }

      emit(JSONObject().put("state", "verifying"))
      val actual = digest.digest().joinToString("") { "%02x".format(it) }
      if (actual != sha256) {
        apk.delete()
        throw IOException("The download is corrupted (checksum mismatch). Try again.")
      }
      val archive = activity.packageManager.getPackageArchiveInfo(apk.path, 0)
        ?: throw IOException("The downloaded file is not an installable app.")
      if (archive.packageName != activity.packageName) throw IOException("The download is not Study (${archive.packageName}).")
      val archiveCode = PackageInfoCompat.getLongVersionCode(archive)
      if (archiveCode <= installedVersionCode()) throw IOException("The download is not newer than this build.")

      activity.runOnUiThread { installOrAskPermission(apk) }
    } catch (error: Exception) {
      Log.w("Study", "update failed", error)
      busy.set(false)
      emitError(error.message ?: "The update failed.")
    }
  }

  private fun installOrAskPermission(apk: File) {
    if (canInstall()) {
      launchInstaller(apk)
      return
    }
    pendingApk = apk
    awaitingPermission = true
    emit(JSONObject().put("state", "permission"))
    try {
      activity.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
      )
    } catch (error: Exception) {
      awaitingPermission = false
      pendingApk = null
      busy.set(false)
      emitError("Open Settings → Apps → Study → Install unknown apps, allow it, then try again.")
    }
  }

  private fun launchInstaller(apk: File) {
    pendingApk = null
    try {
      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apk)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, APK_MIME)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
      emit(JSONObject().put("state", "installing"))
    } catch (error: Exception) {
      Log.w("Study", "installer launch failed", error)
      emitError("The system installer could not be opened.")
    } finally {
      busy.set(false)
    }
  }

  private fun emitError(message: String) {
    emit(JSONObject().put("state", "error").put("message", message))
  }

  // JSONObject.toString() is valid JS object-literal source (strings are escaped), so it is safe to splice.
  private fun emit(detail: JSONObject) {
    val view = webView ?: return
    val script = "window.dispatchEvent(new CustomEvent('study-update',{detail:$detail}))"
    view.post { view.evaluateJavascript(script, null) }
  }

  private companion object {
    const val RELEASES_PREFIX = "https://syllabi-studio.s3.eu-central-003.backblazeb2.com/study/"
    const val UPDATE_DIR = "updates"
    const val APK_MIME = "application/vnd.android.package-archive"
    const val PROGRESS_INTERVAL_MS = 200L
    val SHA256_PATTERN = Regex("^[0-9a-fA-F]{64}$")
  }
}
