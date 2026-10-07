mod analyzer;
mod ai;
mod documents;
mod wallpaper;
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
async fn function_references(source: String) -> Result<Vec<analyzer::FunctionReference>, String> {
    validate_source(&source)?;
    tauri::async_runtime::spawn_blocking(move || analyzer::function_references(source))
        .await.map_err(|error| error.to_string())
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

fn decode_png(contents: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    const PREFIX: &str = "data:image/png;base64,";
    let encoded = contents.strip_prefix(PREFIX).ok_or("Invalid PNG data URL.")?;
    if encoded.len() > ((16 * 1024 * 1024 + 2) / 3) * 4 + 4 || encoded.len() % 4 != 0 {
        return Err("PNG is invalid or larger than 16 MB.".into());
    }
    let output = base64::engine::general_purpose::STANDARD.decode(encoded)
        .map_err(|_| "Invalid PNG data URL.".to_string())?;
    if output.len() > 16 * 1024 * 1024 || !output.ends_with(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 174, 66, 96, 130]) {
        return Err("PNG is invalid or larger than 16 MB.".into());
    }
    let decoder = png::Decoder::new(std::io::Cursor::new(&output));
    let mut reader = decoder.read_info().map_err(|_| "Invalid PNG data.".to_string())?;
    let info = reader.info();
    if info.width > 16_384 || info.height > 16_384 || u64::from(info.width) * u64::from(info.height) > 32_000_000 {
        return Err("PNG exceeds the 32 megapixel image limit.".into());
    }
    let buffer_size = reader.output_buffer_size().ok_or("PNG output is too large.")?;
    let mut pixels = vec![0; buffer_size];
    reader.next_frame(&mut pixels).map_err(|_| "Invalid PNG data.".to_string())?;
    Ok(output)
}

#[tauri::command]
async fn save_document(
    app: tauri::AppHandle,
    name: String,
    contents: String,
    extension: String,
) -> Result<bool, String> {
    if !matches!(extension.as_str(), "cpp" | "svg" | "png" | "codeflow") || extension != "png" && contents.len() > 16 * 1024 * 1024 {
        return Err("Unsupported document type or document larger than 16 MB.".into());
    }
    let bytes = if extension == "png" { decode_png(&contents)? } else { contents.into_bytes() };
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
        persist_document(&path, &bytes)?;
        Ok(true)
    }).await.map_err(|error| error.to_string())?
}

pub(crate) fn persist_document(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let parent=path.parent().ok_or("Invalid save path")?;
    let mut temporary=tempfile::NamedTempFile::new_in(parent).map_err(|e|e.to_string())?;
    temporary.write_all(bytes).map_err(|e|e.to_string())?;
    temporary.as_file().sync_all().map_err(|e|e.to_string())?;
    temporary.persist(path).map_err(|e|e.to_string())?;Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(documents::DocumentState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![inspect_cpp, function_references, analyze_cpp, save_document, ai::ai_models, ai::ai_download, ai::ai_captions, wallpaper::wallpaper_theme, documents::open_document, documents::recent_projects, documents::open_recent_project, documents::save_project_document, documents::save_recovery, documents::read_recovery])
        .run(tauri::generate_context!())
        .expect("error while running CodeFlow");
}

#[cfg(test)]
mod export_tests {
    use super::decode_png;
    use base64::Engine as _;

    #[test]
    fn png_decoder_requires_data_url_and_signature() {
        let png = decode_png("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert!(decode_png("iVBORw0KGgo=").is_err());
        assert!(decode_png("data:image/png;base64,AAAAAAAAAAA=").is_err());
        assert!(decode_png("data:image/png;base64,iV=O").is_err());
        assert!(decode_png("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYIJ=").is_err());
        assert!(decode_png("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB").is_err());
        assert!(decode_png("data:image/png;base64,iVBORw0KGgoAAAANSUhEUv////9JSERS").is_err());
        assert!(decode_png("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42Y=").is_err());
        let mut trailing = png.clone();
        trailing.push(0);
        let trailing = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(trailing));
        assert!(decode_png(&trailing).is_err());
        let mut malformed_length = png.clone();
        malformed_length[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        let malformed_length = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(malformed_length));
        assert!(decode_png(&malformed_length).is_err());
        let oversized = format!("data:image/png;base64,{}", "A".repeat(22_369_628));
        assert!(decode_png(&oversized).is_err());
    }
}
