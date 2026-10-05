use tauri_plugin_updater::UpdaterExt;

#[test]
#[ignore = "requires the public GitHub release endpoint"]
fn updater_plugin_reaches_and_parses_public_endpoint() {
    tauri::async_runtime::block_on(async {
        let app = tauri::test::mock_builder()
            .plugin(
                tauri_plugin_updater::Builder::new()
                    .target("windows-x86_64-nsis")
                    .default_version_comparator(|_, _| false)
                    .build(),
            )
            .build(tauri::generate_context!())
            .expect("test app should build");
        let update = app
            .updater()
            .expect("updater should initialize")
            .check()
            .await
            .expect("updater should reach and parse the release endpoint");

        assert!(update.is_none());
    });
}
