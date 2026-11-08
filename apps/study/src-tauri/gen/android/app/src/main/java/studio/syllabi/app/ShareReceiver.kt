package studio.syllabi.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

// Android share target — the native half of features/inbox/lib/share.ts.
//
// Gallery, Files, a screenshot or a Quick Share (AirDrop-from-iPhone) arrival can be shared into
// Study as ACTION_SEND / ACTION_SEND_MULTIPLE (image/* or application/pdf; see AndroidManifest.xml).
// The content:// grant only lasts as long as the receiving activity, so every stream is COPIED into
// <cache>/shared/ on a background thread right away — on a cold start (the share launched the app,
// before the WebView exists) as on a warm one (onNewIntent). The page then:
//   - `window.StudyShare.pending()` → JSON [{id, name, mime, bytes, receivedAt}] — called on mount,
//     which covers the cold start (the copy may finish before or after the page loads);
//   - listens for the `study-share` CustomEvent ({count}) fired after each copy — the warm case;
//   - `read(id)` → the file as base64, one at a time and only when it is used;
//   - `remove(id)` once it has gone to the inbox / a board / the bank.
// Nothing here trusts the caller: ids are this class's own UUIDs, checked by pattern before any file
// access, and only files under <cache>/shared/ are ever read or deleted.
class ShareReceiver(private val activity: Activity) {
  private var webView: WebView? = null
  private val lock = Any()

  fun attach(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "StudyShare")
  }

  fun detach() {
    webView = null
  }

  /** onCreate (cold start) and onNewIntent (warm): copy any shared streams in the background. */
  fun handle(intent: Intent?) {
    val uris = sharedUris(intent ?: return)
    if (uris.isEmpty()) return
    val type = intent.type
    // Consumed: a configuration change or a re-delivered intent must not import the same files twice.
    intent.action = Intent.ACTION_MAIN
    Thread({ copyAll(uris, type) }, "study-share").start()
  }

  private fun sharedUris(intent: Intent): List<Uri> {
    val uris = when (intent.action) {
      Intent.ACTION_SEND -> listOfNotNull(streamExtra(intent))
      Intent.ACTION_SEND_MULTIPLE -> streamListExtra(intent)
      else -> emptyList()
    }
    // A text-only share (a link) carries no stream; ignore it rather than failing.
    return uris.take(MAX_FILES)
  }

  @Suppress("DEPRECATION")
  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
    }

  @Suppress("DEPRECATION")
  private fun streamListExtra(intent: Intent): List<Uri> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
    } else {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
    }

  private fun copyAll(uris: List<Uri>, intentType: String?) {
    var copied = 0
    for (uri in uris) {
      try {
        if (copyOne(uri, intentType)) copied += 1
      } catch (error: Exception) {
        Log.w("Study", "share: could not copy $uri", error)
      }
    }
    if (copied > 0) emit(JSONObject().put("count", copied))
  }

  private fun copyOne(uri: Uri, intentType: String?): Boolean {
    val resolver = activity.contentResolver
    val mime = (resolver.getType(uri) ?: intentType ?: "").lowercase()
    if (!(mime.startsWith("image/") || mime == PDF_MIME)) return false

    var name = "shared"
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0)
    }

    val id = UUID.randomUUID().toString()
    val dir = sharedDir()
    val data = File(dir, "$id.bin")
    var bytes = 0L
    resolver.openInputStream(uri)?.use { input ->
      data.outputStream().use { output ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          bytes += read
          if (bytes > MAX_BYTES) {
            output.close()
            data.delete()
            Log.w("Study", "share: $name is over ${MAX_BYTES / 1_048_576} MB, skipped")
            return false
          }
          output.write(buffer, 0, read)
        }
      }
    } ?: return false

    val meta = JSONObject()
      .put("id", id)
      .put("name", name)
      .put("mime", mime)
      .put("bytes", bytes)
      .put("receivedAt", System.currentTimeMillis())
    synchronized(lock) { File(dir, "$id.json").writeText(meta.toString()) }
    return true
  }

  private fun sharedDir(): File = File(activity.cacheDir, SHARED_DIR).apply { mkdirs() }

  private fun dataFile(id: String): File? =
    if (ID_PATTERN.matches(id)) File(sharedDir(), "$id.bin").takeIf { it.isFile } else null

  inner class Bridge {
    @JavascriptInterface
    fun pending(): String {
      val list = JSONArray()
      synchronized(lock) {
        sharedDir().listFiles { file -> file.name.endsWith(".json") }
          ?.sortedBy { it.lastModified() }
          ?.forEach { meta ->
            try {
              val item = JSONObject(meta.readText())
              if (dataFile(item.optString("id")) != null) list.put(item) else meta.delete()
            } catch (error: Exception) {
              meta.delete()
            }
          }
      }
      return list.toString()
    }

    @JavascriptInterface
    fun read(id: String): String {
      val file = dataFile(id) ?: return ""
      return Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun remove(id: String): Boolean {
      if (!ID_PATTERN.matches(id)) return false
      synchronized(lock) {
        File(sharedDir(), "$id.json").delete()
        return File(sharedDir(), "$id.bin").delete()
      }
    }
  }

  // JSONObject.toString() is valid JS object-literal source, so it is safe to splice.
  private fun emit(detail: JSONObject) {
    val view = webView ?: return
    val script = "window.dispatchEvent(new CustomEvent('study-share',{detail:$detail}))"
    view.post { view.evaluateJavascript(script, null) }
  }

  private companion object {
    const val SHARED_DIR = "shared"
    const val PDF_MIME = "application/pdf"
    const val MAX_FILES = 20
    // A phone photo is a few MB; a lecture PDF can be tens. Base64 through the bridge costs ~1.33×.
    const val MAX_BYTES = 40L * 1_048_576
    val ID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
  }
}
