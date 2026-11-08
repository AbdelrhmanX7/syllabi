package studio.syllabi.app

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

// Board exports (PDF / PNG / .kawb.json) — the native half of lib/platform/file-export.ts.
//
// The WebView ignores `<a download>` (there is no DownloadListener, and blob: URLs never leave the
// page), so every export used to vanish without a word. The page streams the file here instead:
//   - `begin(name, mime)` → an id; `append(id, base64)` per chunk (a whole PDF as one bridge string
//     would be tens of MB); `finish(id)` → true once the file is in Downloads (API 29+, MediaStore —
//     no storage permission), or handed to the share sheet on older Android.
// Nothing here trusts the caller: ids are this class's own UUIDs, staging files live only under
// <cache>/exports/, and the name is reduced to a plain file name.
class FileExporter(private val activity: Activity) {
  private val lock = Any()
  private val pending = HashMap<String, Pending>()

  private class Pending(val name: String, val mime: String, val file: File)

  fun attach(webView: WebView) {
    webView.addJavascriptInterface(Bridge(), "StudyFiles")
  }

  inner class Bridge {
    @JavascriptInterface
    fun begin(name: String, mime: String): String {
      val id = UUID.randomUUID().toString()
      val dir = File(activity.cacheDir, "exports").apply { mkdirs() }
      val file = File(dir, id)
      file.delete()
      synchronized(lock) { pending[id] = Pending(safeName(name), mime.ifBlank { "application/octet-stream" }, file) }
      return id
    }

    @JavascriptInterface
    fun append(id: String, base64: String): Boolean {
      val entry = synchronized(lock) { pending[id] } ?: return false
      return try {
        FileOutputStream(entry.file, true).use { it.write(Base64.decode(base64, Base64.DEFAULT)) }
        true
      } catch (error: Exception) {
        Log.w("Study", "export append failed", error)
        false
      }
    }

    @JavascriptInterface
    fun finish(id: String): Boolean {
      val entry = synchronized(lock) { pending.remove(id) } ?: return false
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          saveToDownloads(entry)
          entry.file.delete()
          toast("Saved to Downloads: ${entry.name}")
        } else {
          shareFile(entry)
        }
        true
      } catch (error: Exception) {
        Log.w("Study", "export failed", error)
        entry.file.delete()
        toast("Export failed")
        false
      }
    }
  }

  private fun saveToDownloads(entry: Pending) {
    val resolver = activity.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, entry.name)
      put(MediaStore.MediaColumns.MIME_TYPE, entry.mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("MediaStore refused the file")
    try {
      resolver.openOutputStream(uri)?.use { out -> entry.file.inputStream().use { it.copyTo(out) } }
        ?: throw IllegalStateException("no output stream")
      values.clear()
      values.put(MediaStore.MediaColumns.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
  }

  // Android 9 and older: no MediaStore Downloads without a storage permission, so the share sheet
  // («Save to Files», Drive, …) takes the file. The staged copy stays in the cache for the receiver.
  private fun shareFile(entry: Pending) {
    val named = File(entry.file.parentFile, "${UUID.randomUUID()}-${entry.name}")
    if (!entry.file.renameTo(named)) throw IllegalStateException("rename failed")
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", named)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = entry.mime
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.runOnUiThread { activity.startActivity(Intent.createChooser(send, entry.name)) }
  }

  private fun toast(text: String) {
    activity.runOnUiThread { Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }
  }

  private fun safeName(name: String): String {
    val cleaned = name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\u0000-\\u001f:*?\"<>|]"), "_").trim()
    return cleaned.ifBlank { "export" }.take(120)
  }
}
