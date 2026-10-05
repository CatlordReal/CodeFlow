use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::atomic::{AtomicBool, Ordering}, time::Duration};

const BASE: &str = "http://127.0.0.1:11434";
const MODELS: [&str; 3] = ["qwen3.5:4b", "qwen2.5:0.5b", "qwen2.5:3b"];
static BUSY: AtomicBool = AtomicBool::new(false);
struct BusyGuard;
impl Drop for BusyGuard { fn drop(&mut self) { BUSY.store(false, Ordering::Release); } }
fn lock() -> Result<BusyGuard, String> {
    BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| BusyGuard).map_err(|_| "Local AI is busy. Wait for the current request.".into())
}
fn client(seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(seconds))
        .build().map_err(|e| e.to_string())
}
fn validate_model(model: &str) -> Result<(), String> {
    if MODELS.contains(&model) { Ok(()) } else { Err("Choose a supported local Qwen model.".into()) }
}
fn connection_error(error: reqwest::Error) -> String {
    if error.is_connect() { "Start Ollama on this computer, then retry. CodeFlow connects only to 127.0.0.1:11434.".into() }
    else if error.is_timeout() { "Local AI timed out. Try the smaller model or a shorter function.".into() }
    else { format!("Local AI request failed: {error}") }
}
async fn read_json(mut response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(connection_error)? {
        if bytes.len() + chunk.len() > 256 * 1024 { return Err("Local AI response is too large.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Local AI returned invalid JSON.")?;
    if !status.is_success() || value.get("error").is_some() {
        return Err(value["error"].as_str().unwrap_or("Local AI request failed.").chars().take(300).collect());
    }
    Ok(value)
}

#[tauri::command]
pub async fn ai_models() -> Result<Vec<String>, String> {
    let response = client(10)?.get(format!("{BASE}/api/tags")).send().await.map_err(connection_error)?;
    let value = read_json(response).await?;
    Ok(value["models"].as_array().into_iter().flatten()
        .filter_map(|m| m["name"].as_str()).filter(|name| MODELS.contains(name)).map(str::to_owned).collect())
}

#[tauri::command]
pub async fn ai_download(model: String) -> Result<(), String> {
    validate_model(&model)?;
    let _busy = lock()?;
    let response = client(900)?.post(format!("{BASE}/api/pull"))
        .json(&json!({"model": model, "stream": false})).send().await.map_err(connection_error)?;
    let value = read_json(response).await?;
    if value["status"].as_str() != Some("success") { return Err("Model download did not complete. Retry to resume.".into()); }
    Ok(())
}

#[derive(Deserialize, Serialize)]
pub struct CaptionInput { id: String, code: String, kind: String }

#[tauri::command]
pub async fn ai_captions(model: String, nodes: Vec<CaptionInput>) -> Result<BTreeMap<String, String>, String> {
    validate_model(&model)?;
    if nodes.is_empty() || nodes.len() > 80 || nodes.iter().any(|n| n.id.is_empty() || n.id.len() > 100 || n.code.len() > 3000 || !matches!(n.kind.as_str(), "process" | "io" | "decision" | "loop" | "switch" | "return" | "throw"))
        || nodes.iter().map(|n| n.code.len()).sum::<usize>() > 24_000 {
        return Err("Use a function with at most 80 steps and 24 KB of code for local AI.".into());
    }
    let _busy = lock()?;
    let http = client(180)?;
    // Refuse cloud-backed Ollama models before any source is submitted.
    let details = read_json(http.post(format!("{BASE}/api/show")).json(&json!({"model": model}))
        .send().await.map_err(connection_error)?).await?;
    if details.get("remote_host").is_some() || details.get("remote_model").is_some()
        || details["details"]["parameter_size"].as_str().unwrap_or("").is_empty() {
        return Err("This model is not verified as locally installed. Download a local Qwen model.".into());
    }
    let started = std::time::Instant::now();
    let mut captions = BTreeMap::new();
    // Isolate each block: tiny models otherwise mix operations from adjacent steps.
    for node in &nodes {
        if started.elapsed() > Duration::from_secs(180) {
            return Err("Caption generation took too long. Try a smaller function.".into());
        }
        let remaining = Duration::from_secs(180).saturating_sub(started.elapsed());
        let mut body = json!({
            "model": model, "stream": false, "keep_alive": "2m",
            "format": {"type":"object", "properties":{"caption":{"type":"string"}},"required":["caption"],"additionalProperties":false},
            "options": {"temperature":0,"num_ctx":4096,"num_predict":160},
            "messages": [
                {"role":"system","content":r#"Write a plain English flowchart label for this C++ snippet. Summarize its purpose in 4-12 words. Never copy code syntax. Return JSON with a caption string. Examples: `total += value;` => {"caption":"Add value to the total"}; `queue.push(p); seen[p] = true;` => {"caption":"Queue the point and mark it as seen"}; `x >= 0 && x < width` => {"caption":"Is x within the horizontal bounds?"}."#},
                {"role":"user","content": node.code}
            ]
        });
        if model.starts_with("qwen3.5:") { body["think"] = json!(false); }
        let response = http.post(format!("{BASE}/api/chat")).timeout(remaining).json(&body).send().await.map_err(connection_error)?;
        let value = read_json(response).await?;
        let answer: Value = serde_json::from_str(value["message"]["content"].as_str().unwrap_or(""))
            .map_err(|_| "AI returned invalid captions. Original chart is unchanged.")?;
        captions.insert(node.id.clone(), answer["caption"].as_str().unwrap_or("").to_owned());
    }
    validate_captions(&serde_json::to_string(&captions).map_err(|e| e.to_string())?, &nodes)
}

fn validate_captions(content: &str, nodes: &[CaptionInput]) -> Result<BTreeMap<String, String>, String> {
    let captions: BTreeMap<String, String> = serde_json::from_str(content).map_err(|_| "AI returned invalid captions. Original chart is unchanged.")?;
    if captions.len() != nodes.len() || nodes.iter().any(|n| !captions.contains_key(&n.id))
        || captions.values().any(|s| s.trim().is_empty() || s.chars().count() > 180 || s.chars().any(char::is_control)) {
        return Err("AI returned incomplete or oversized captions. Original chart is unchanged.".into());
    }
    Ok(captions.into_iter().map(|(k,v)| (k,v.trim().to_owned())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captions_must_match_known_steps() {
        let nodes = vec![CaptionInput{id:"n1".into(),code:"x++;".into(),kind:"process".into()}];
        assert_eq!(validate_captions(r#"{"n1":"Increase x by one"}"#, &nodes).unwrap()["n1"], "Increase x by one");
        assert!(validate_captions(r#"{"other":"Skip step"}"#, &nodes).is_err());
        assert!(validate_captions(r#"{"n1":""}"#, &nodes).is_err());
        assert!(validate_model("qwen:cloud").is_err());
    }
}
