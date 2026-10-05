mod analyzer;
mod ai;
use std::io::Write;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn inspect_cpp(source: String) -> Result<Vec<analyzer::FunctionInfo>, String> {
    validate_source(&source)?;
    tauri::async_runtime::spawn_blocking(move || analyzer::inspect(source))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn analyze_cpp(
    source: String,
    function_id: String,
    include_comments: bool,
) -> Result<analyzer::FlowGraph, String> {
    validate_source(&source)?;
    tauri::async_runtime::spawn_blocking(move || analyzer::analyze(source, function_id, include_comments))
        .await
        .map_err(|error| error.to_string())?
}

fn validate_source(source: &str) -> Result<(), String> {
    if source.len() > 2 * 1024 * 1024 {
        return Err("Open a C++ source file smaller than 2 MB.".into());
    }
    Ok(())
}

#[tauri::command]
async fn save_document(
    app: tauri::AppHandle,
    name: String,
    contents: String,
    extension: String,
) -> Result<bool, String> {
    if !matches!(extension.as_str(), "cpp" | "svg" | "codeflow") || contents.len() > 16 * 1024 * 1024 {
        return Err("Unsupported document type or document larger than 16 MB.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let file_name = std::path::Path::new(&name)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document");
        let Some(file) = app.dialog().file()
            .set_file_name(file_name)
            .add_filter("Document", &[&extension])
            .blocking_save_file() else { return Ok(false); };
        let path = file.into_path().map_err(|error| error.to_string())?;
        let parent = path.parent().ok_or("Invalid save path")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        temporary.write_all(contents.as_bytes()).map_err(|error| error.to_string())?;
        temporary.as_file().sync_all().map_err(|error| error.to_string())?;
        temporary.persist(path).map_err(|error| error.to_string())?;
        Ok(true)
    }).await.map_err(|error| error.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![inspect_cpp, analyze_cpp, save_document, ai::ai_models, ai::ai_download, ai::ai_captions])
        .run(tauri::generate_context!())
        .expect("error while running CodeFlow");
}
