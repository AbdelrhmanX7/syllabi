package studio.syllabi.app

import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognition
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModel
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognitionModelIdentifier
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizer
import com.google.mlkit.vision.digitalink.recognition.DigitalInkRecognizerOptions
import com.google.mlkit.vision.digitalink.recognition.Ink
import com.google.mlkit.vision.digitalink.recognition.RecognitionContext
import com.google.mlkit.vision.digitalink.recognition.WritingArea
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// On-device handwriting recognition (Google ML Kit Digital Ink) — the native half of
// lib/ink/nativeRecognizer.ts, installed as `window.StudyInkNative`.
//
// Every call returns at once; the work runs on a small background pool and its outcome reaches the
// page as a `study-ink-native` CustomEvent: {requestId, type: 'progress'|'result'|'error', ...}.
//
//   isAvailable(): Boolean                     the bridge exists (ML Kit is linked into this APK)
//   ensureModels(requestId, langsJson)         langsJson = ["en"]; downloads what is missing
//       progress {lang, done, total, fraction}  after each language is in place
//       result   {models: {en: true}}
//   recognize(requestId, requestJson)          requestJson = {strokes:[[x,y,t, x,y,t, …], …],
//                                              langs:["en"], preContext?, writingArea?:{width,height},
//                                              maxResults?}
//       result   {results: [{lang, candidates:[{text, score?}], ms}], errors: {lang: message}, ms}
//   modelStatus(requestId, langsJson)          result {models: {en: true|false}} (no download)
//
// Models are fetched once (~20 MB per language, per Google's docs) and then work offline. Recognizers
// are cached per language for the life of the activity. Nothing here trusts the caller: language tags
// are resolved through ML Kit's own registry and the stroke payload is size-capped.
class InkRecognizer {
  private var webView: WebView? = null
  private val pool: ExecutorService = Executors.newFixedThreadPool(2) { r -> Thread(r, "study-ink").apply { isDaemon = true } }
  private val recognizers = ConcurrentHashMap<String, DigitalInkRecognizer>()
  private val downloaded = ConcurrentHashMap.newKeySet<String>()
  private val modelManager: RemoteModelManager by lazy { RemoteModelManager.getInstance() }

  fun attach(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "StudyInkNative")
  }

  fun detach() {
    webView = null
    pool.shutdownNow()
    for (recognizer in recognizers.values) {
      try {
        recognizer.close()
      } catch (ignored: Exception) {
      }
    }
    recognizers.clear()
  }

  inner class Bridge {
    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun ensureModels(requestId: String, langsJson: String): Boolean = submit(requestId) { ensure(requestId, parseLangs(langsJson)) }

    @JavascriptInterface
    fun modelStatus(requestId: String, langsJson: String): Boolean = submit(requestId) { status(requestId, parseLangs(langsJson)) }

    @JavascriptInterface
    fun recognize(requestId: String, requestJson: String): Boolean {
      if (requestJson.length > MAX_REQUEST_CHARS) {
        emitError(requestId, "too-large", "ink request exceeds $MAX_REQUEST_CHARS characters")
        return false
      }
      return submit(requestId) { recognizeNow(requestId, JSONObject(requestJson)) }
    }
  }

  private fun submit(requestId: String, work: () -> Unit): Boolean {
    if (!ID_PATTERN.matches(requestId)) return false
    return try {
      pool.execute {
        try {
          work()
        } catch (error: Exception) {
          Log.w("Study", "ink request $requestId failed", error)
          emitError(requestId, "failed", error.message ?: error.javaClass.simpleName)
        }
      }
      true
    } catch (error: Exception) {
      false
    }
  }

  private fun parseLangs(json: String): List<String> {
    val array = JSONArray(json)
    val langs = ArrayList<String>(array.length())
    for (i in 0 until minOf(array.length(), MAX_LANGS)) {
      val tag = array.optString(i, "").trim()
      if (tag.isNotEmpty() && !langs.contains(tag)) langs.add(tag)
    }
    return langs
  }

  private fun model(lang: String): DigitalInkRecognitionModel {
    val identifier = DigitalInkRecognitionModelIdentifier.fromLanguageTag(lang)
      ?: throw IllegalArgumentException("no ink model for '$lang'")
    return DigitalInkRecognitionModel.builder(identifier).build()
  }

  private fun isDownloaded(lang: String, model: DigitalInkRecognitionModel): Boolean {
    if (downloaded.contains(lang)) return true
    val present = Tasks.await(modelManager.isModelDownloaded(model), CHECK_TIMEOUT_S, TimeUnit.SECONDS) == true
    if (present) downloaded.add(lang)
    return present
  }

  private fun status(requestId: String, langs: List<String>) {
    val models = JSONObject()
    for (lang in langs) {
      models.put(lang, try { isDownloaded(lang, model(lang)) } catch (ignored: Exception) { false })
    }
    emit(JSONObject().put("requestId", requestId).put("type", "result").put("models", models))
  }

  private fun ensure(requestId: String, langs: List<String>) {
    if (langs.isEmpty()) {
      emitError(requestId, "bad-request", "no languages")
      return
    }
    val models = JSONObject()
    var done = 0
    for (lang in langs) {
      val model = try {
        model(lang)
      } catch (error: Exception) {
        emitError(requestId, "unsupported-lang", "no ink model for '$lang'")
        return
      }
      if (!isDownloaded(lang, model)) {
        try {
          // No byte progress from ML Kit: progress is per language.
          Tasks.await(modelManager.download(model, DownloadConditions.Builder().build()), DOWNLOAD_TIMEOUT_S, TimeUnit.SECONDS)
          downloaded.add(lang)
        } catch (error: Exception) {
          Log.w("Study", "ink model $lang download failed", error)
          emitError(requestId, "download-failed", "model '$lang': ${error.cause?.message ?: error.message ?: "download failed"}")
          return
        }
      }
      models.put(lang, true)
      done += 1
      emit(
        JSONObject().put("requestId", requestId).put("type", "progress").put("lang", lang)
          .put("done", done).put("total", langs.size).put("fraction", done.toDouble() / langs.size),
      )
    }
    emit(JSONObject().put("requestId", requestId).put("type", "result").put("models", models))
  }

  private fun recognizerFor(lang: String, model: DigitalInkRecognitionModel, maxResults: Int): DigitalInkRecognizer {
    val key = "$lang#$maxResults"
    return recognizers.getOrPut(key) {
      DigitalInkRecognition.getClient(
        DigitalInkRecognizerOptions.builder(model).setMaxResultCount(maxResults).build(),
      )
    }
  }

  private fun buildInk(strokes: JSONArray): Ink {
    val ink = Ink.builder()
    var points = 0
    for (s in 0 until strokes.length()) {
      val flat = strokes.optJSONArray(s) ?: continue
      val stroke = Ink.Stroke.builder()
      var added = 0
      var i = 0
      while (i + 2 < flat.length()) {
        val x = flat.optDouble(i).toFloat()
        val y = flat.optDouble(i + 1).toFloat()
        val t = flat.optDouble(i + 2)
        if (!x.isNaN() && !y.isNaN()) {
          stroke.addPoint(if (t.isNaN()) Ink.Point.create(x, y) else Ink.Point.create(x, y, t.toLong()))
          added += 1
        }
        i += 3
      }
      points += added
      if (points > MAX_POINTS) throw IllegalArgumentException("too many points")
      if (added > 0) ink.addStroke(stroke.build())
    }
    return ink.build()
  }

  private fun recognizeNow(requestId: String, request: JSONObject) {
    val started = SystemClock.elapsedRealtime()
    val strokes = request.optJSONArray("strokes")
    val langsArray = request.optJSONArray("langs")
    if (strokes == null || strokes.length() == 0 || langsArray == null) {
      emitError(requestId, "bad-request", "strokes and langs are required")
      return
    }
    val langs = parseLangs(langsArray.toString())
    val maxResults = request.optInt("maxResults", DEFAULT_MAX_RESULTS).coerceIn(1, 10)
    val ink = buildInk(strokes)

    val context = RecognitionContext.builder()
    context.setPreContext(request.optString("preContext", "").takeLast(PRE_CONTEXT_CHARS))
    request.optJSONObject("writingArea")?.let { area ->
      val width = area.optDouble("width").toFloat()
      val height = area.optDouble("height").toFloat()
      if (width > 0f && height > 0f) context.setWritingArea(WritingArea(width, height))
    }
    val recognitionContext = context.build()

    // Start every language first (ML Kit runs them on its own executor), then collect.
    val pending = ArrayList<Pair<String, com.google.android.gms.tasks.Task<com.google.mlkit.vision.digitalink.common.RecognitionResult>>>()
    val errors = JSONObject()
    for (lang in langs) {
      try {
        val model = model(lang)
        if (!isDownloaded(lang, model)) {
          errors.put(lang, "model-missing")
          continue
        }
        pending.add(lang to recognizerFor(lang, model, maxResults).recognize(ink, recognitionContext))
      } catch (error: Exception) {
        errors.put(lang, error.message ?: "failed")
      }
    }

    val results = JSONArray()
    for ((lang, task) in pending) {
      try {
        val result = Tasks.await(task, RECOGNIZE_TIMEOUT_S, TimeUnit.SECONDS)
        val candidates = JSONArray()
        for (candidate in result.candidates) {
          val entry = JSONObject().put("text", candidate.text)
          candidate.score?.let { score -> if (!score.isNaN()) entry.put("score", score.toDouble()) }
          candidates.put(entry)
        }
        results.put(JSONObject().put("lang", lang).put("candidates", candidates).put("ms", SystemClock.elapsedRealtime() - started))
      } catch (error: Exception) {
        errors.put(lang, error.cause?.message ?: error.message ?: "failed")
      }
    }

    if (results.length() == 0) {
      val missing = langs.all { errors.optString(it) == "model-missing" }
      emit(
        JSONObject().put("requestId", requestId).put("type", "error")
          .put("code", if (missing) "model-missing" else "failed")
          .put("message", errors.toString()).put("errors", errors),
      )
      return
    }
    emit(
      JSONObject().put("requestId", requestId).put("type", "result").put("results", results)
        .put("errors", errors).put("ms", SystemClock.elapsedRealtime() - started),
    )
  }

  private fun emitError(requestId: String, code: String, message: String) {
    emit(JSONObject().put("requestId", requestId).put("type", "error").put("code", code).put("message", message))
  }

  // JSONObject.toString() is valid JS object-literal source (strings are escaped), so it is safe to splice.
  private fun emit(detail: JSONObject) {
    val view = webView ?: return
    val script = "window.dispatchEvent(new CustomEvent('study-ink-native',{detail:$detail}))"
    view.post { view.evaluateJavascript(script, null) }
  }

  private companion object {
    val ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,64}$")
    const val MAX_LANGS = 4
    const val MAX_REQUEST_CHARS = 2_000_000
    const val MAX_POINTS = 50_000
    const val PRE_CONTEXT_CHARS = 20
    const val DEFAULT_MAX_RESULTS = 5
    const val CHECK_TIMEOUT_S = 10L
    const val DOWNLOAD_TIMEOUT_S = 300L
    const val RECOGNIZE_TIMEOUT_S = 10L
  }
}
