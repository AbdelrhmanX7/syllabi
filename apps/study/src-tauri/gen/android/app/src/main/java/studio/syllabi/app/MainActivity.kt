package studio.syllabi.app

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  // Re-hides the bars after they came back without a swipe (see installInsetsGuard).
  private val reHideBars = Runnable { if (hasWindowFocus()) enterImmersiveMode() }

  // In-app update (download, verify, system installer) — `window.StudyUpdater` in the page.
  private val updater = AppUpdater(this)

  // Android share target (Gallery / Files / Quick Share → Study) — `window.StudyShare` in the page.
  private val shareReceiver = ShareReceiver(this)

  // On-device handwriting recognition (ML Kit Digital Ink) — `window.StudyInkNative` in the page.
  private val inkRecognizer = InkRecognizer()

  // Board exports (PDF / PNG / document) into Downloads — `window.StudyFiles` in the page.
  private val fileExporter = FileExporter(this)

  // A reminder tapped while the app was closed: the notification plugin fires its tap event before the
  // page listens (and carries no payload), so the page asks which reminder it was once it loads and
  // looks up its page — `window.StudyNotifyLaunch.take()` → the notification id, or "".
  @Volatile private var notificationTap: Int? = null

  private fun rememberNotificationTap(intent: Intent?) {
    val id = intent?.getIntExtra("NotificationId", Int.MIN_VALUE) ?: Int.MIN_VALUE
    if (id != Int.MIN_VALUE) notificationTap = id
  }

  private inner class NotifyLaunchBridge {
    @JavascriptInterface
    fun take(): String {
      val id = notificationTap ?: return ""
      notificationTap = null
      return id.toString()
    }
  }

  // Pen-button fallback (the board engine's learned S Pen buttons). Samsung's S Pen /
  // Huawei's M-Pen button may never reach the page as a PointerEvent `buttons` bit — the vendor
  // WebView can drop it, or the system keeps it for Air Command — so the activity watches the raw
  // MotionEvent button state + tool type and stylus key events and forwards only their EDGES to JS
  // as a `wb-native-pen` CustomEvent. Nothing is consumed (every override returns super's result),
  // and a plain stylus move with an unchanged button state costs one int compare: no per-move bridge.
  private var boardWebView: WebView? = null
  private var stylusButtonState = 0
  private var stylusToolType = MotionEvent.TOOL_TYPE_UNKNOWN
  // Whether the stylus is ON the glass: set by the touch stream (DOWN … UP/CANCEL), cleared by hover.
  // Sent with every edge so the page can tell a button pressed in the air from one pressed while
  // writing (ACTION_BUTTON_PRESS during contact vs a buttonState change on HOVER_MOVE).
  private var stylusInContact = false
  // Samsung WebView (SM-X910): a stylus put down with its button ALREADY held never reaches the page
  // as a contact — no pointerdown, no touch, no ink — and its buttonState does not change at the
  // down, so no edge was sent either. While such a contact lasts the activity forwards it itself:
  // DOWN and UP as edges, MOVE coalesced to one sample per frame (the only per-move bridge, and only
  // for this case). The page drives the eraser from it.
  private var stylusButtonDrag = false
  private var dragMoveScheduled = false
  // Every sample of the frame, not just the last: Android batches the moves between frames into ONE
  // ACTION_MOVE (getHistoricalX/Y), and one bridge call per frame carries all of them — so a fast stroke
  // erases continuously instead of in straight hops between frame points. Flat x0,y0,x1,y1,… in px
  // relative to the WebView; capped so a stalled frame cannot grow it without bound.
  private val dragMoveSamples = FloatArray(MAX_DRAG_SAMPLES * 2)
  private var dragMoveSampleCount = 0
  private var dragMoveLast: MotionEvent? = null
  private var dragMoveIndex = 0
  private val webViewOffset = IntArray(2)
  private val flushDragMove = Runnable {
    dragMoveScheduled = false
    flushPendingDragMove()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    configureFullscreenWindow()
    enterImmersiveMode()
    installInsetsGuard()
    // Cold start by a share: the streams are copied now, the page picks them up when it loads.
    shareReceiver.handle(intent)
    rememberNotificationTap(intent)
  }

  // Warm start (singleTask): a share while Study is open arrives here; the page hears `study-share`.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    shareReceiver.handle(intent)
    rememberNotificationTap(intent)
  }

  // The system restores the bars after any dialog, share sheet, MediaProjection consent prompt or
  // app switch, so immersive mode is re-asserted on every return to the foreground — both hooks,
  // because onResume fires before the window regains focus and the insets controller only sticks
  // on the focused window.
  override fun onResume() {
    super.onResume()
    enterImmersiveMode()
    updater.onResume()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) enterImmersiveMode()
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> stylusInContact = true
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> stylusInContact = false
    }
    observeStylus(ev)
    observeStylusButtonContact(ev)
    return super.dispatchTouchEvent(ev)
  }

  private fun observeStylusButtonContact(ev: MotionEvent) {
    var index = -1
    for (i in 0 until ev.pointerCount) {
      val tool = ev.getToolType(i)
      if (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER) {
        index = i
        break
      }
    }
    if (index < 0) return

    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> if (ev.buttonState != 0) {
        stylusButtonDrag = true
        dragMoveSampleCount = 0
        refreshWebViewOffset()
        emitNativePen(contactDetail("down", ev, index))
      }
      MotionEvent.ACTION_MOVE -> if (stylusButtonDrag) {
        for (h in 0 until ev.historySize) {
          addDragSample(ev.getHistoricalX(index, h), ev.getHistoricalY(index, h))
        }
        addDragSample(ev.getX(index), ev.getY(index))
        // Kept for the flush's pressure/buttonState: a copy, since the framework recycles `ev`.
        dragMoveLast?.recycle()
        dragMoveLast = MotionEvent.obtain(ev)
        dragMoveIndex = index
        val webView = boardWebView
        if (!dragMoveScheduled && webView != null) {
          dragMoveScheduled = true
          webView.postOnAnimation(flushDragMove)
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (stylusButtonDrag) {
        stylusButtonDrag = false
        flushPendingDragMove()
        emitNativePen(contactDetail(if (ev.actionMasked == MotionEvent.ACTION_UP) "up" else "cancel", ev, index))
      }
    }
  }

  private fun addDragSample(x: Float, y: Float) {
    if (dragMoveSampleCount >= MAX_DRAG_SAMPLES) {
      // Drop the oldest half rather than the newest: the eraser must end where the pen is.
      val keep = MAX_DRAG_SAMPLES / 2
      System.arraycopy(dragMoveSamples, (dragMoveSampleCount - keep) * 2, dragMoveSamples, 0, keep * 2)
      dragMoveSampleCount = keep
    }
    dragMoveSamples[dragMoveSampleCount * 2] = x - webViewOffset[0]
    dragMoveSamples[dragMoveSampleCount * 2 + 1] = y - webViewOffset[1]
    dragMoveSampleCount += 1
  }

  private fun flushPendingDragMove() {
    val last = dragMoveLast
    if (dragMoveSampleCount > 0 && last != null) {
      val pts = StringBuilder(dragMoveSampleCount * 16)
      for (i in 0 until dragMoveSampleCount * 2) {
        if (i > 0) pts.append(',')
        pts.append(dragMoveSamples[i])
      }
      val n = dragMoveSampleCount - 1
      emitNativePen(
        "{kind:'contact',type:'move',x:${dragMoveSamples[n * 2]},y:${dragMoveSamples[n * 2 + 1]}," +
          "pts:[$pts],pressure:${last.getPressure(dragMoveIndex.coerceAtMost(last.pointerCount - 1))}," +
          "buttonState:${last.buttonState}}",
      )
    }
    dragMoveSampleCount = 0
    dragMoveLast?.recycle()
    dragMoveLast = null
  }

  // MotionEvents reaching the activity are in WINDOW coordinates; the page's are relative to the WebView,
  // which sits inside android.R.id.content — padded by any visible system bar / cutout (installInsetsGuard).
  // Measured at each forwarded contact's DOWN (cheap, and the layout cannot move mid-stroke).
  private fun refreshWebViewOffset() {
    val webView = boardWebView
    if (webView == null) {
      webViewOffset[0] = 0
      webViewOffset[1] = 0
      return
    }
    webView.getLocationInWindow(webViewOffset)
  }

  private fun contactDetail(type: String, ev: MotionEvent, index: Int): String {
    val x = ev.getX(index) - webViewOffset[0]
    val y = ev.getY(index) - webViewOffset[1]
    return "{kind:'contact',type:'$type',x:$x,y:$y,pts:[$x,$y]," +
      "pressure:${ev.getPressure(index)},buttonState:${ev.buttonState}}"
  }

  // Hover (pen near the glass, tip up) and ACTION_BUTTON_PRESS/RELEASE arrive here, not as touches.
  override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE, MotionEvent.ACTION_HOVER_EXIT ->
        stylusInContact = false
    }
    observeStylus(ev)
    return super.dispatchGenericMotionEvent(ev)
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP) {
      val stylusSource = (event.source and InputDevice.SOURCE_STYLUS) == InputDevice.SOURCE_STYLUS
      emitNativePen(
        "{kind:'key',type:'${if (event.action == KeyEvent.ACTION_DOWN) "down" else "up"}'," +
          "keyCode:${event.keyCode},keyName:'${KeyEvent.keyCodeToString(event.keyCode)}'," +
          "repeat:${event.repeatCount},stylusSource:$stylusSource}",
      )
    }
    return super.dispatchKeyEvent(event)
  }

  private fun observeStylus(ev: MotionEvent) {
    var toolType = MotionEvent.TOOL_TYPE_UNKNOWN
    for (index in 0 until ev.pointerCount) {
      val tool = ev.getToolType(index)
      if (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER) {
        toolType = tool
        break
      }
    }
    if (toolType == MotionEvent.TOOL_TYPE_UNKNOWN) return

    val buttonState = ev.buttonState
    if (buttonState == stylusButtonState && toolType == stylusToolType) return

    val prevButtonState = stylusButtonState
    val prevToolType = stylusToolType
    stylusButtonState = buttonState
    stylusToolType = toolType
    refreshWebViewOffset()
    emitNativePen(
      "{kind:'motion',action:'${MotionEvent.actionToString(ev.actionMasked)}'," +
        "buttonState:$buttonState,prevButtonState:$prevButtonState," +
        "toolType:$toolType,prevToolType:$prevToolType,actionButton:${ev.actionButton}," +
        "contact:$stylusInContact,x:${ev.x - webViewOffset[0]},y:${ev.y - webViewOffset[1]}}",
    )
  }

  // The detail literal is built only from numbers and framework constant names (no user text), so
  // it is safe to splice into the script.
  private fun emitNativePen(detail: String) {
    val webView = boardWebView ?: return
    val script = "window.dispatchEvent(new CustomEvent('wb-native-pen',{detail:$detail}))"
    webView.post { webView.evaluateJavascript(script, null) }
  }

  override fun onDestroy() {
    boardWebView = null
    updater.detach()
    shareReceiver.detach()
    inkRecognizer.detach()
    window.decorView.removeCallbacks(reHideBars)
    super.onDestroy()
  }

  // Wry installs the WebView as the content view AFTER onCreate (from the Rust side), which is
  // when the window's content is finally in place: a hide() issued before that was observed not
  // to stick on a Samsung tablet (status bar + taskbar stayed, covering the page controls). So
  // the bars are hidden again here, synchronously and once more after the first layout pass.
  //
  // Cache: the frontend is bundled INSIDE the APK (tauri embeds `out/` in the Rust library and
  // serves it from the app's own origin), yet after an in-place update a tablet kept running the
  // previous build's JavaScript: the WebView's HTTP cache outlives the APK that filled it, and a
  // cached response for the same URL wins over the new bundle. Caching local assets buys nothing —
  // the bytes are already on disk — so the cache is bypassed outright, and the first launch of a
  // new versionCode wipes whatever the previous build left behind. IndexedDB (the notebooks)
  // is not the cache and is untouched.
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    boardWebView = webView
    // Before wry's first loadUrl, so the interface exists on the first page.
    updater.attach(webView)
    shareReceiver.attach(webView)
    inkRecognizer.attach(webView)
    fileExporter.attach(webView)
    webView.addJavascriptInterface(NotifyLaunchBridge(), "StudyNotifyLaunch")
    webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
    if (isFirstLaunchOfThisBuild()) {
      webView.clearCache(true)
      Log.i("Study", "new build: WebView cache cleared")
    }
    enterImmersiveMode()
    webView.post { enterImmersiveMode() }
  }

  private fun isFirstLaunchOfThisBuild(): Boolean {
    val current = try {
      PackageInfoCompat.getLongVersionCode(packageManager.getPackageInfo(packageName, 0))
    } catch (error: Exception) {
      -1L
    }
    val prefs = getSharedPreferences("study", Context.MODE_PRIVATE)
    if (prefs.getLong("last_version_code", Long.MIN_VALUE) == current) return false
    prefs.edit().putLong("last_version_code", current).apply()
    return true
  }

  // The board is the whole screen: a study session runs for an hour at a time, so the status bar, the
  // navigation bar / Samsung taskbar and the screen timeout are all in the way. The in-app
  // fullscreen toggle is a desktop window command and does nothing here, so the activity owns it.
  private fun configureFullscreenWindow() {
    // Keep the screen on while the app is foregrounded — long stretches of writing look idle to
    // the OS between strokes. The flag is window-scoped and lifts itself when the app is backgrounded.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    // Draw into the camera cutout on the short edges instead of letterboxing the board beside it.
    // The web content keeps itself clear of the notch through `viewport-fit=cover` +
    // `env(safe-area-inset-*)` (set in pages/_app.tsx), and installInsetsGuard pads it anyway.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val attributes = window.attributes
      attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      window.attributes = attributes
    }
  }

  // Immersive-sticky: both system bars hidden (the Samsung taskbar is part of the navigation bar
  // and goes with it), a swipe from an edge shows them transiently and they slide away again on
  // their own. Unlike the legacy SYSTEM_UI_FLAG path this survives API 30+ where those flags are
  // deprecated and ignored.
  private fun enterImmersiveMode() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    WindowInsetsControllerCompat(window, window.decorView).apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
  }

  // Belt and braces, on the view that holds the WebView (android.R.id.content):
  // 1. Whatever system bar or cutout is VISIBLE right now — swiped in and held, left behind by a
  //    dialog, or a device that refuses to hide its taskbar — is applied as padding, so the page
  //    never sits under it and every control (the bottom-left page nav, the top-left toolbar)
  //    stays tappable. Transient swipe-in bars do not change the window insets, so they never
  //    cause a relayout; hidden bars report zero.
  // 2. A bar that is still visible after a grace period came back without the user asking
  //    (consent prompt, share sheet, app switch) and is hidden again.
  private fun installInsetsGuard() {
    val content = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      // Edge-to-edge windows are never resized for the soft keyboard (adjustResize is a no-op once
      // decorFitsSystemWindows is false), so the keyboard covered the focused field — the tutor and
      // AI composers sit at the bottom. Its inset is padding too: the WebView shrinks above it and
      // Chrome scrolls the focused field into view.
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      if (insets.isVisible(WindowInsetsCompat.Type.statusBars()) || insets.isVisible(WindowInsetsCompat.Type.navigationBars())) {
        window.decorView.removeCallbacks(reHideBars)
        window.decorView.postDelayed(reHideBars, REHIDE_DELAY_MS)
      }
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }

  private companion object {
    // Long enough for a transient swipe-in to have faded on its own; short enough that a bar
    // left behind by a dialog is gone before you reach for a control under it.
    const val REHIDE_DELAY_MS = 2500L
    // Samples carried by one forwarded MOVE frame at most (a 240 Hz pen gives ~4 per 60 Hz frame).
    const val MAX_DRAG_SAMPLES = 64
  }
}
