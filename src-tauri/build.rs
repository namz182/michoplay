fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "michoplay-media",
            tauri_build::InlinedPlugin::new(),
        ),
    )
    .expect("failed to build Tauri application");
}
