//! Study — the native shell around the static Next.js export.
//!
//! Everything the app does happens in the WebView (IndexedDB notes, fetch to the backend,
//! getUserMedia for lecture audio — wry's WebChromeClient requests RECORD_AUDIO at runtime). The
//! Rust side hosts the window plus the one thing only the device can do: fetch YouTube captions
//! (`youtube_captions.rs` — YouTube blocks the backend's IP). The S Pen button bridge lives in
//! `gen/android/.../MainActivity.kt` and reaches the page as a `wb-native-pen` CustomEvent; the
//! in-app updater's download + install half is `gen/android/.../AppUpdater.kt`.

mod youtube_captions;

use serde::Serialize;

#[derive(Serialize)]
struct ShellInfo {
    version: &'static str,
    platform: &'static str,
}

/// Build identity for the Settings screen (`invoke('shell_info')`).
#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo {
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

/// The published release feed (scripts/publish-android.mjs). Read here, not in the WebView: the
/// bucket sends no CORS headers. Baked at compile time: scripts/android-release.mjs sets
/// STUDY_UPDATE_FEED_URL from STUDY_FEED_PREFIX (public CI builds poll `study/public/latest.json`),
/// unset = the default feed.
const UPDATE_FEED_URL: &str = match option_env!("STUDY_UPDATE_FEED_URL") {
    Some(url) => url,
    None => "https://syllabi-studio.s3.eu-central-003.backblazeb2.com/study/latest.json",
};

/// `invoke('update_feed')` → the feed JSON as published; the page validates it (lib/platform/update-check.ts).
#[tauri::command]
async fn update_feed() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let bust = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();

        ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .get(UPDATE_FEED_URL)
            .query("t", &bust.to_string())
            .set("Cache-Control", "no-cache")
            .call()
            .map_err(|error| format!("update feed: {error}"))?
            .into_json::<serde_json::Value>()
            .map_err(|error| format!("update feed: {error}"))
    })
    .await
    .map_err(|error| format!("update feed task: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Sign-in links (emailed magic/verify/reset links, the Google return) and the system browser
        // for Google sign-in. Both are driven from the page; see features/auth/components/DeepLinkRouter.tsx.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![shell_info, update_feed, youtube_captions::youtube_captions])
        .run(tauri::generate_context!())
        .expect("error while running Study");
}
