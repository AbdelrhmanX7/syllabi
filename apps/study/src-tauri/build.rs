fn main() {
    // Android 15+ devices may use 16 KB memory pages, and Google Play rejects apps (targetSdk 35+) whose
    // native libraries are aligned for 4 KB pages only. NDK 27's linker still defaults to 4 KB, so the
    // app library is linked with 16 KB alignment (it loads fine on 4 KB devices too). Set here rather
    // than in RUSTFLAGS, which the tauri CLI sets itself for Android builds.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }

    // Every `#[tauri::command]` is listed here so tauri-build emits its `allow-<command>` permission
    // (granted in capabilities/*.json); an unlisted command fails the build with "Permission … not found".
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["shell_info", "update_feed", "youtube_captions"])),
    )
    .expect("failed to run tauri build script")
}
