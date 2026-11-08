fn main() {
    // Every `#[tauri::command]` is listed here so tauri-build emits its `allow-<command>` permission
    // (granted in capabilities/*.json); an unlisted command fails the build with "Permission … not found".
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["shell_info", "update_feed", "youtube_captions"])),
    )
    .expect("failed to run tauri build script")
}
