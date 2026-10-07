use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const RECOVERY_NAME: &str = "current-project-recovery.json";
const RECOVERY_PREVIOUS_NAME: &str = "current-project-recovery.previous.json";
const RECOVERY_LIMIT: usize = 33 * 1024 * 1024;
const PROJECT_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Default)]
struct RecoveryWriteState {
    generation: u64,
    backup_created: bool,
}

#[derive(Default)]
pub struct DocumentState {
    targets: Mutex<HashMap<String, PathBuf>>,
    recent_lock: Mutex<()>,
    recovery: Mutex<RecoveryWriteState>,
}
impl DocumentState {
    fn remember(&self, path: PathBuf) -> Result<String, String> {
        let mut targets = self
            .targets
            .lock()
            .map_err(|_| "Project state is unavailable.")?;
        if let Some((token, _)) = targets.iter().find(|(_, p)| **p == path) {
            return Ok(token.clone());
        }
        if targets.len() >= 128 {
            return Err(
                "Too many project targets. Restart CodeFlow after saving your work.".into(),
            );
        }
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| "Could not create a project target.")?;
        let token = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        targets.insert(token.clone(), path);
        Ok(token)
    }
    fn target(&self, token: &str) -> Result<PathBuf, String> {
        self.targets
            .lock()
            .map_err(|_| "Project state is unavailable.")?
            .get(token)
            .cloned()
            .ok_or_else(|| "Unknown project target. Use Save as to choose a file.".into())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    name: String,
    contents: String,
    project_token: Option<String>,
    warning: Option<String>,
    dirty: Option<bool>,
    source_dirty: Option<bool>,
    project_dirty: Option<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProject {
    saved: bool,
    project_token: Option<String>,
    name: Option<String>,
    warning: Option<String>,
    dirty: Option<bool>,
    source_dirty: Option<bool>,
    project_dirty: Option<bool>,
}
#[derive(Serialize)]
pub struct RecentProject {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RecoveryEnvelope {
    contents: String,
    target: Option<PathBuf>,
    #[serde(default = "default_true")]
    dirty: bool,
    source_dirty: Option<bool>,
    project_dirty: Option<bool>,
}

fn default_true() -> bool {
    true
}

fn text_units(value: &str) -> usize {
    value.encode_utf16().count()
}

fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && text_units(value) <= 160
        && !value.chars().any(|character| character <= '\u{1f}')
        && !matches!(value, "__proto__" | "constructor" | "prototype")
}

fn object<'a>(
    value: &'a serde_json::Value,
    message: &str,
) -> Result<&'a serde_json::Map<String, serde_json::Value>, String> {
    value.as_object().ok_or_else(|| message.to_owned())
}

fn validate_records(value: &serde_json::Value, captions: bool) -> Result<(), String> {
    let records = object(value, "Invalid project edits.")?;
    for (function_key, set) in records {
        if !valid_key(function_key) {
            return Err("Invalid function key.".into());
        }
        for (node_key, item) in object(set, "Invalid function edits.")? {
            if !valid_key(node_key) {
                return Err("Invalid node key.".into());
            }
            if captions {
                if item.as_str().is_none_or(|text| text_units(text) > 500) {
                    return Err("Invalid saved caption.".into());
                }
                continue;
            }
            for (field, label) in object(item, "Invalid node edit.")? {
                match field.as_str() {
                    "flagged" if label.is_boolean() => {}
                    "code" | "natural" | "annotation"
                        if label.as_str().is_some_and(|text| text_units(text) <= 2000) => {}
                    _ => return Err("Invalid node text.".into()),
                }
            }
        }
    }
    Ok(())
}

fn optional_bool(
    project: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<bool, String> {
    match project.get(key) {
        None => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "Invalid project view options.".into()),
    }
}

fn integer_between(value: &serde_json::Value, minimum: f64, maximum: f64) -> bool {
    value.as_f64().is_some_and(|number| {
        number.is_finite() && number.fract() == 0.0 && number >= minimum && number <= maximum
    })
}

fn validate_chart_fields(
    project: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    if !matches!(
        project.get("mode").and_then(serde_json::Value::as_str),
        Some("code" | "natural")
    ) {
        return Err("Invalid chart mode.".into());
    }
    validate_records(project.get("edits").ok_or("Invalid project edits.")?, false)?;
    validate_records(
        project.get("captions").ok_or("Invalid project captions.")?,
        true,
    )?;

    optional_bool(project, "expandLoops")?;
    optional_bool(project, "includeComments")?;
    match project.get("loopDepth") {
        None => {}
        Some(serde_json::Value::Null) => {}
        Some(value) if integer_between(value, 0.0, 100.0) => {}
        _ => return Err("Invalid loop depth.".into()),
    }

    if let Some(value) = project.get("loopOverrides") {
        for (function_key, overrides) in object(value, "Invalid loop overrides.")? {
            if !valid_key(function_key) {
                return Err("Invalid loop overrides.".into());
            }
            for (loop_key, expanded) in object(overrides, "Invalid loop overrides.")? {
                if !valid_key(loop_key) || !expanded.is_boolean() {
                    return Err("Invalid loop override.".into());
                }
            }
        }
    }

    optional_bool(project, "showHiddenBoxes")?;
    if let Some(value) = project.get("hiddenBoxes") {
        for (function_key, ids) in object(value, "Invalid hidden-box options.")? {
            let ids = ids.as_array().ok_or("Invalid hidden boxes.")?;
            if !valid_key(function_key)
                || ids.len() > 10_000
                || ids
                    .iter()
                    .any(|id| id.as_str().is_none_or(|id| !valid_key(id)))
            {
                return Err("Invalid hidden boxes.".into());
            }
        }
    }

    if let Some(value) = project.get("functionPositions") {
        for (function_key, position) in object(value, "Invalid function positions.")? {
            let position = object(position, "Invalid function position.")?;
            let valid_coordinate = |key: &str| {
                position
                    .get(key)
                    .and_then(serde_json::Value::as_f64)
                    .is_some_and(|coordinate| {
                        coordinate.is_finite() && coordinate.abs() <= 10_000_000.0
                    })
            };
            if !valid_key(function_key) || !valid_coordinate("x") || !valid_coordinate("y") {
                return Err("Invalid function position.".into());
            }
        }
    }
    Ok(())
}

fn safe_integer(value: &serde_json::Value) -> Option<u64> {
    value.as_f64().and_then(|number| {
        (number.is_finite()
            && number.fract() == 0.0
            && (1.0..=9_007_199_254_740_991.0).contains(&number))
        .then_some(number as u64)
    })
}

fn revision_number(id: &str) -> Option<u64> {
    let digits = id.strip_prefix("revision-")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(digits.parse().unwrap_or(u64::MAX))
}

fn validate_history(value: &serde_json::Value) -> Result<(), String> {
    let history = object(value, "Invalid chart history.")?;
    let revisions = history
        .get("revisions")
        .and_then(serde_json::Value::as_array)
        .filter(|revisions| !revisions.is_empty() && revisions.len() <= 500)
        .ok_or("Invalid chart history.")?;
    let next = history
        .get("next")
        .and_then(safe_integer)
        .ok_or("Invalid chart history.")?;
    let mut ids = std::collections::HashSet::new();
    let mut largest = 0;
    for revision in revisions {
        let revision = object(revision, "Invalid chart revision.")?;
        let id = revision
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| valid_key(id) && !ids.contains(*id))
            .ok_or("Invalid chart revision.")?;
        match revision.get("parent") {
            Some(serde_json::Value::Null) => {}
            Some(parent) if parent.as_str().is_some_and(|parent| ids.contains(parent)) => {}
            _ => return Err("Invalid chart revision.".into()),
        }
        if revision
            .get("name")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|name| text_units(name) > 120)
        {
            return Err("Invalid chart revision.".into());
        }
        validate_chart_fields(object(
            revision
                .get("state")
                .ok_or("Invalid chart revision state.")?,
            "Invalid chart revision state.",
        )?)?;
        largest = largest.max(revision_number(id).unwrap_or(0));
        ids.insert(id.to_owned());
    }
    if history
        .get("active")
        .and_then(serde_json::Value::as_str)
        .is_none_or(|active| !ids.contains(active))
        || next <= largest
    {
        return Err("Invalid active chart revision.".into());
    }
    Ok(())
}

fn validate_recovery_project(contents: &str) -> Result<(), String> {
    if contents.len() > PROJECT_LIMIT {
        return Err("Recovery project is too large.".into());
    }
    let project: serde_json::Value =
        serde_json::from_str(contents).map_err(|_| "Recovery project is invalid.".to_string())?;
    let project = object(&project, "Recovery project is invalid.")?;
    if project.get("format").and_then(serde_json::Value::as_str) != Some("codeflow")
        || project.get("version") != Some(&serde_json::Value::from(1))
        || project
            .get("source")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|source| source.len() > 2 * 1024 * 1024)
        || project
            .get("fileName")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|name| {
                name.trim().is_empty()
                    || text_units(name) > 240
                    || name.chars().any(|character| character <= '\u{1f}')
            })
    {
        return Err("Recovery project is invalid.".into());
    }
    let source = project
        .get("source")
        .and_then(serde_json::Value::as_str)
        .unwrap();
    if project
        .get("labelSource")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(source)
        .len()
        > 2 * 1024 * 1024
        || project
            .get("labelSource")
            .is_some_and(|value| !value.is_string())
    {
        return Err("Invalid label source.".into());
    }
    validate_chart_fields(project)?;
    if let Some(history) = project.get("history") {
        validate_history(history)?;
    }
    Ok(())
}

fn validate_recovery_target(target: Option<&Path>) -> Result<(), String> {
    if let Some(target) = target {
        if !target.is_absolute()
            || !target
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("codeflow"))
        {
            return Err("Recovery target is invalid.".into());
        }
    }
    Ok(())
}

fn read_recovery_bytes(path: &Path) -> Result<(RecoveryEnvelope, Vec<u8>), String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take((RECOVERY_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > RECOVERY_LIMIT {
        return Err("Recovery file is too large.".into());
    }
    let envelope: RecoveryEnvelope =
        serde_json::from_slice(&bytes).map_err(|_| "Recovery file is invalid.".to_string())?;
    validate_recovery_project(&envelope.contents)?;
    validate_recovery_target(envelope.target.as_deref())?;
    Ok((envelope, bytes))
}

fn quarantine_recovery(path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or("Invalid recovery path.")?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for attempt in 0..1000 {
        let quarantine = parent.join(format!(
            "current-project-recovery.corrupt-{timestamp}-{}-{attempt}.json",
            std::process::id()
        ));
        if quarantine.exists() {
            continue;
        }
        return std::fs::rename(path, &quarantine)
            .map(|()| quarantine)
            .map_err(|error| error.to_string());
    }
    Err("Could not create a unique recovery quarantine path.".into())
}

fn quarantine_error(path: &Path, error: String) -> String {
    match quarantine_recovery(path) {
        Ok(quarantine) => format!(
            "{error} Preserved as {}.",
            quarantine
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("a quarantined recovery")
        ),
        Err(quarantine_error) => {
            format!("{error} The invalid recovery could not be quarantined: {quarantine_error}")
        }
    }
}

fn preserve_existing_recovery(path: &Path, previous: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    match read_recovery_bytes(path) {
        Ok((_, bytes)) => super::persist_document(previous, &bytes),
        Err(error) => quarantine_recovery(path).map(|_| ()).map_err(|quarantine| {
            format!("{error} The invalid recovery could not be quarantined: {quarantine}")
        }),
    }
}

fn persist_recovery(
    path: &Path,
    previous: &Path,
    state: &mut RecoveryWriteState,
    generation: u64,
    bytes: &[u8],
) -> Result<bool, String> {
    if generation <= state.generation {
        return Ok(false);
    }
    if !state.backup_created {
        preserve_existing_recovery(path, previous)?;
        state.backup_created = true;
    }
    super::persist_document(path, bytes)?;
    state.generation = generation;
    Ok(true)
}
fn recent_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recent-projects.json"))
}
fn load_recent(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let path = recent_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 64 * 1024 {
        return Err("Recent-project list is too large.".into());
    }
    let paths: Vec<PathBuf> =
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|_| "Recent-project list is invalid.")?;
    Ok(paths
        .into_iter()
        .filter(|p| {
            p.is_absolute()
                && p.extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("codeflow"))
        })
        .take(20)
        .collect())
}
fn add_recent(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let state = app.state::<DocumentState>();
    let _guard = state
        .recent_lock
        .lock()
        .map_err(|_| "Recent-project list is unavailable.")?;
    let mut paths = load_recent(app)?;
    paths.retain(|p| p != path);
    paths.insert(0, path.to_owned());
    paths.truncate(20);
    let target = recent_path(app)?;
    std::fs::create_dir_all(target.parent().ok_or("Invalid recent-project path.")?)
        .map_err(|e| e.to_string())?;
    super::persist_document(
        &target,
        &serde_json::to_vec(&paths).map_err(|e| e.to_string())?,
    )
}
fn read_document(app: &tauri::AppHandle, path: PathBuf) -> Result<OpenedDocument, String> {
    let project = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("codeflow"));
    let limit = if project {
        16 * 1024 * 1024
    } else {
        2 * 1024 * 1024
    };
    use std::io::Read;
    let file = std::fs::File::open(&path)
        .map_err(|_| "Could not open this document. It may have moved or been deleted.")?;
    let mut contents = String::new();
    file.take((limit + 1) as u64)
        .read_to_string(&mut contents)
        .map_err(|_| "Document is not valid UTF-8 text.")?;
    if contents.len() > limit {
        return Err("Document exceeds the supported size.".into());
    }
    if project {
        let value: serde_json::Value =
            serde_json::from_str(&contents).map_err(|_| "Invalid CodeFlow project.")?;
        if value["format"] != "codeflow" || value["version"] != 1 {
            return Err("Invalid CodeFlow project.".into());
        }
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document")
        .to_owned();
    let project_token = if project {
        Some(app.state::<DocumentState>().remember(path.clone())?)
    } else {
        None
    };
    let warning = if project {
        add_recent(app, &path)
            .err()
            .map(|_| "Project opened, but recent projects could not be updated.".into())
    } else {
        None
    };
    Ok(OpenedDocument {
        name,
        contents,
        project_token,
        warning,
        dirty: None,
        source_dirty: None,
        project_dirty: None,
    })
}
#[tauri::command]
pub async fn open_document(app: tauri::AppHandle) -> Result<Option<OpenedDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter(
                "CodeFlow or C++",
                &["codeflow", "cpp", "cc", "cxx", "h", "hpp", "hxx"],
            )
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        read_document(&app, path).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_recent(&app)?
            .into_iter()
            .map(|path| {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Project")
                    .to_owned();
                let id = app.state::<DocumentState>().remember(path)?;
                Ok(RecentProject { id, name })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn open_recent_project(
    app: tauri::AppHandle,
    id: String,
) -> Result<OpenedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app.state::<DocumentState>().target(&id)?;
        read_document(&app, path)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_project_document(
    app: tauri::AppHandle,
    name: String,
    contents: String,
    project_token: Option<String>,
) -> Result<SavedProject, String> {
    if contents.len() > 16 * 1024 * 1024 {
        return Err("Project is larger than 16 MB.".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(&contents).map_err(|_| "Invalid CodeFlow project.")?;
    if value["format"] != "codeflow" || value["version"] != 1 {
        return Err("Invalid CodeFlow project.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DocumentState>();
        let path = if let Some(token) = project_token {
            state.target(&token)?
        } else {
            let name = Path::new(&name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("project.codeflow");
            let Some(file) = app
                .dialog()
                .file()
                .set_file_name(name)
                .add_filter("CodeFlow project", &["codeflow"])
                .blocking_save_file()
            else {
                return Ok(SavedProject {
                    saved: false,
                    project_token: None,
                    name: None,
                    warning: None,
                    dirty: None,
                    source_dirty: None,
                    project_dirty: None,
                });
            };
            file.into_path().map_err(|e| e.to_string())?
        };
        super::persist_document(&path, contents.as_bytes())?;
        let token = state.remember(path.clone())?;
        let warning = add_recent(&app, &path)
            .err()
            .map(|_| "Project saved, but recent projects could not be updated.".into());
        Ok(SavedProject {
            saved: true,
            project_token: Some(token),
            name: path.file_name().and_then(|n| n.to_str()).map(str::to_owned),
            warning,
            dirty: None,
            source_dirty: None,
            project_dirty: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_targets_require_native_authority() {
        let state = DocumentState::default();
        assert!(state.target("/tmp/arbitrary.codeflow").is_err());
        let path = PathBuf::from("chosen.codeflow");
        let token = state.remember(path.clone()).unwrap();
        assert_eq!(state.target(&token).unwrap(), path);
        assert_eq!(state.remember(path).unwrap(), token);
    }
    #[test]
    fn atomic_save_replaces_existing_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("example.codeflow");
        super::super::persist_document(&path, b"first").unwrap();
        super::super::persist_document(&path, b"second").unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"second");
    }

    fn recovery(contents: &str, dirty: bool, source_dirty: bool, project_dirty: bool) -> Vec<u8> {
        serde_json::to_vec(&RecoveryEnvelope {
            contents: contents.to_owned(),
            target: None,
            dirty,
            source_dirty: Some(source_dirty),
            project_dirty: Some(project_dirty),
        })
        .unwrap()
    }

    fn project(source: &str) -> String {
        serde_json::json!({
            "format":"codeflow",
            "version":1,
            "source":source,
            "fileName":"test.cpp",
            "mode":"natural",
            "edits":{},
            "captions":{},
            "expandLoops":false,
            "includeComments":false,
            "loopDepth":0,
            "loopOverrides":{},
            "hiddenBoxes":{},
            "showHiddenBoxes":false,
            "functionPositions":{}
        })
        .to_string()
    }

    #[test]
    fn recovery_generation_keeps_newest_write_and_first_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(RECOVERY_NAME);
        let previous = directory.path().join(RECOVERY_PREVIOUS_NAME);
        let original = recovery(&project("original"), true, true, false);
        super::super::persist_document(&path, &original).unwrap();

        let mut state = RecoveryWriteState::default();
        let newest = recovery(&project("newest"), true, false, true);
        assert!(persist_recovery(&path, &previous, &mut state, 2, &newest).unwrap());
        assert!(!persist_recovery(
            &path,
            &previous,
            &mut state,
            1,
            &recovery(&project("stale"), false, false, false)
        )
        .unwrap());
        assert!(persist_recovery(
            &path,
            &previous,
            &mut state,
            3,
            &recovery(&project("latest"), true, false, true)
        )
        .unwrap());

        let (current, _) = read_recovery_bytes(&path).unwrap();
        assert!(current.contents.contains("latest"));
        assert_eq!(
            (current.dirty, current.source_dirty, current.project_dirty),
            (true, Some(false), Some(true))
        );
        assert_eq!(std::fs::read(previous).unwrap(), original);
        assert_eq!(state.generation, 3);
    }

    #[test]
    fn malformed_recovery_is_quarantined_before_error() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(RECOVERY_NAME);
        let malformed = br#"{"contents":"{\"format\":\"codeflow\",\"version\":1}","target":"relative.codeflow","dirty":true}"#;
        std::fs::write(&path, malformed).unwrap();
        let error = read_recovery_bytes(&path).unwrap_err();
        let reported = quarantine_error(&path, error);
        assert!(reported.contains("Preserved as current-project-recovery.corrupt-"));
        assert!(!path.exists());
        let quarantined = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|entry| {
                entry
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".corrupt-")
            })
            .unwrap();
        assert_eq!(std::fs::read(quarantined).unwrap(), malformed);
    }

    #[test]
    fn overwrite_quarantines_corrupt_recovery_instead_of_losing_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(RECOVERY_NAME);
        let previous = directory.path().join(RECOVERY_PREVIOUS_NAME);
        let malformed = b"not recovery json";
        std::fs::write(&path, malformed).unwrap();
        let replacement = recovery(&project("replacement"), false, false, false);

        let mut state = RecoveryWriteState::default();
        assert!(persist_recovery(&path, &previous, &mut state, 1, &replacement).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), replacement);
        assert!(!previous.exists());
        let quarantined = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|entry| {
                entry
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".corrupt-")
            })
            .unwrap();
        assert_eq!(std::fs::read(quarantined).unwrap(), malformed);
    }

    #[test]
    fn structurally_invalid_inner_project_is_quarantined() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(RECOVERY_NAME);
        let malformed_project = r#"{"format":"codeflow","version":1,"source":"int main(){}"}"#;
        let wrapper = serde_json::to_vec(&serde_json::json!({
            "contents":malformed_project,
            "target":null,
            "dirty":true
        }))
        .unwrap();
        std::fs::write(&path, &wrapper).unwrap();

        let error = read_recovery_bytes(&path).unwrap_err();
        assert!(error.contains("Recovery project is invalid"));
        let reported = quarantine_error(&path, error);
        assert!(reported.contains("Preserved as current-project-recovery.corrupt-"));
        assert!(!path.exists());
        assert!(std::fs::read_dir(directory.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".corrupt-")
        }));
    }

    #[test]
    fn recovery_project_validates_label_source_and_nested_history() {
        let mut value: serde_json::Value = serde_json::from_str(&project("source")).unwrap();
        value["labelSource"] = serde_json::Value::String("x".repeat(2 * 1024 * 1024));
        assert!(validate_recovery_project(&value.to_string()).is_ok());
        value["labelSource"] = serde_json::Value::String("x".repeat(2 * 1024 * 1024 + 1));
        assert!(validate_recovery_project(&value.to_string()).is_err());

        let mut value: serde_json::Value = serde_json::from_str(&project("source")).unwrap();
        value["history"] = serde_json::json!({
            "active":"revision-1",
            "next":2,
            "revisions":[{
                "id":"revision-1",
                "parent":"missing",
                "name":"Invalid parent",
                "state":{
                    "mode":"natural","edits":{},"captions":{},"loopDepth":0,
                    "loopOverrides":{},"hiddenBoxes":{},"showHiddenBoxes":false,
                    "functionPositions":{}
                }
            }]
        });
        assert!(validate_recovery_project(&value.to_string()).is_err());
    }
}

#[tauri::command]
pub async fn save_recovery(
    app: tauri::AppHandle,
    contents: String,
    project_token: Option<String>,
    dirty: bool,
    source_dirty: bool,
    project_dirty: bool,
    generation: u64,
) -> Result<(), String> {
    if contents.len() > PROJECT_LIMIT {
        return Err(
            "Project recovery is larger than 16 MB. Save your project before updating.".into(),
        );
    }
    validate_recovery_project(&contents).map_err(|_| "Invalid recovery project.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DocumentState>();
        let mut recovery = state
            .recovery
            .lock()
            .map_err(|_| "Recovery state is unavailable.")?;
        if generation <= recovery.generation {
            return Ok(());
        }
        let target = project_token
            .map(|token| state.target(&token))
            .transpose()?;
        validate_recovery_target(target.as_deref())?;
        let envelope = RecoveryEnvelope {
            contents,
            target,
            dirty: dirty || source_dirty || project_dirty,
            source_dirty: Some(source_dirty),
            project_dirty: Some(project_dirty),
        };
        let bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let path = directory.join(RECOVERY_NAME);
        let previous = directory.join(RECOVERY_PREVIOUS_NAME);
        std::fs::create_dir_all(path.parent().ok_or("Invalid recovery path.")?)
            .map_err(|e| e.to_string())?;
        persist_recovery(&path, &previous, &mut recovery, generation, &bytes).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn read_recovery(app: tauri::AppHandle) -> Result<Option<OpenedDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join(RECOVERY_NAME);
        if !path.exists() {
            return Ok(None);
        }
        let (envelope, _) =
            read_recovery_bytes(&path).map_err(|error| quarantine_error(&path, error))?;
        let project_token = envelope
            .target
            .map(|target| app.state::<DocumentState>().remember(target))
            .transpose()?;
        Ok(Some(OpenedDocument {
            name: "Recovered.codeflow".into(),
            contents: envelope.contents,
            project_token,
            warning: None,
            dirty: Some(envelope.dirty),
            source_dirty: envelope.source_dirty,
            project_dirty: envelope.project_dirty,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
